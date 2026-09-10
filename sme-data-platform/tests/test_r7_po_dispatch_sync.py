"""PO approval, production and confirmation evidence must not mint revenue."""
import copy
import json
import pytest
from sme_platform.supabase_sync import FIELDS, publish
from test_r2_audit_sync import snapshot, put, warehouse
from test_r4_warehouse_sync import read

TABLES = {'customer_po_inbox','sales_po_documents','revenue_drafts','production_shifts',
          'production_shift_items','production_location_sku_settings','warehouse_dispatch_items',
          'po_dispatch_revenue_confirmations','po_dispatch_revenue_confirmation_lines'}


def test_po_scope_excludes_email_staff_and_nested_payloads():
    assert TABLES <= FIELDS.keys()
    forbidden = {'gmail_message_id','gmail_thread_id','from_email','from_name','email_subject',
                 'body_preview','attachment_names','raw_payload','production_items','items',
                 'assigned_to','created_by','updated_by','reviewed_by','approved_by',
                 'confirmed_by','notes','shortage_note'}
    for t in TABLES:
        assert not set(FIELDS[t].split()) & forbidden


def test_po_draft_confirmation_do_not_create_ledger_or_dispatch(warehouse):
    value = snapshot()
    put(value,'customer_po_inbox',id='po',match_status='matched',posted_to_revenue=True,
        parsed_total_amount='100.123456789',total_amount=None)
    put(value,'sales_po_documents',id='doc',inbox_row_id='po',status='approved',total_amount=None)
    put(value,'revenue_drafts',id='draft',sales_po_doc_id='doc',status='approved',total_amount=None)
    for ident,status in [('draft','draft'),('cancel','cancelled'),('confirmed','confirmed')]:
        put(value,'po_dispatch_revenue_confirmations',id=ident,customer_po_inbox_id='po',
            warehouse_dispatch_id=None,status=status,amount_status='needs_sku_allocation',
            temporary_revenue_amount_vat_included='100.123456789',
            confirmed_revenue_amount_vat_included=None)
    put(value,'po_dispatch_revenue_confirmation_lines',id='line',confirmation_id='confirmed',
        sku='BMQ-001',source_line_key='source:1',ordered_qty='10',dispatched_qty=0,
        confirmed_revenue_amount_vat_included=None,unit_price_vat_included=None)
    report=publish(warehouse,value)
    for t in ['revenue_ledger_lines','warehouse_dispatches']:
        assert report['tables'][t]['records']==0
    assert read(warehouse,report,'customer_po_inbox')[0]['total_amount'] is None
    assert read(warehouse,report,'customer_po_inbox')[0]['parsed_total_amount']=='100.123456789'
    assert {r['status'] for r in read(warehouse,report,'po_dispatch_revenue_confirmations')}=={'draft','cancelled','confirmed'}
    assert read(warehouse,report,'po_dispatch_revenue_confirmation_lines')[0]['unit_price_vat_included'] is None
    again=copy.deepcopy(value);again['observed_at']=snapshot(1)['observed_at']
    repeat=publish(warehouse,again)
    assert all(t['inserted']+t['updated']+t['absent']==0 for t in repeat['tables'].values())


def test_shift_actual_and_dispatch_keep_grain_and_missing_mapping(warehouse):
    value=snapshot()
    put(value,'production_location_sku_settings',id='setting',location_code='Q7',sku_id='sku',is_enabled=False)
    put(value,'production_shifts',id='shift',production_order_id='order',status='scheduled',completed_at=None)
    put(value,'production_shift_items',id='item',production_shift_id='shift',production_order_item_id='order-line',
        sku_id=None,planned_qty='1.23456789',actual_qty=0,unit='KG')
    put(value,'warehouse_dispatch_items',id='dispatch-line',dispatch_id='dispatch',sku_id=None,batch_id=None,
        quantity='1234.56789',unit='g')
    report=publish(warehouse,value)
    assert read(warehouse,report,'production_shift_items')[0]['actual_qty']==0
    assert read(warehouse,report,'production_shifts')[0]['completed_at'] is None
    assert read(warehouse,report,'warehouse_dispatch_items')[0]['unit']=='g'
    assert read(warehouse,report,'warehouse_dispatch_items')[0]['batch_id'] is None
    assert report['tables']['inventory_movements']['records']==0


@pytest.mark.parametrize('fault',['duplicate','truncated','extra'])
def test_bad_po_snapshot_preserves_publication(warehouse,fault):
    value=snapshot();put(value,'customer_po_inbox',id='po',total_amount=None)
    report=publish(warehouse,value)
    bad=copy.deepcopy(value);bad['observed_at']=snapshot(1)['observed_at']
    table=next(t for t in bad['tables'] if t['name']=='customer_po_inbox')
    if fault=='duplicate':table['records']*=2;table['count']=2
    elif fault=='truncated':table['records']=[]
    else:
        row=json.loads(table['records'][0]);row['body_preview']='excluded'
        table['records']=[json.dumps(row)]
    with pytest.raises(ValueError):publish(warehouse,bad)
    with warehouse.connect(read_only=True) as con:
        assert con.execute('SELECT count(*) FROM meta_supabase_sync_runs').fetchone()[0]==1
    assert read(warehouse,report,'customer_po_inbox')[0]['total_amount'] is None
