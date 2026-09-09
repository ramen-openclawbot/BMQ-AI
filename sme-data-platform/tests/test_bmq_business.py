from datetime import datetime, timedelta, timezone
from decimal import Decimal
import json
import pytest
from sme_platform.config import Settings
from sme_platform.warehouse import Warehouse
from sme_platform.query import QueryEngine
from sme_platform.supabase_sync import TENANT,publish
from test_bmq_semantic import snapshot

@pytest.fixture
def state(tmp_path):
    w=Warehouse(Settings(tmp_path/'data',test_mode=True));w.initialize()
    rows={
      'revenue_source_documents':[{'id':'d1','status':'controlled'},{'id':'d2','status':'trusted'},{'id':'d3','status':'draft'}],
      'revenue_ledger_lines':[
        {'id':'l1','source_document_id':'d1','approval_status':'approved','gross_revenue':'100.15','revenue_date':'2026-09-09','channel':'direct'},
        {'id':'l2','source_document_id':'d2','approval_status':'approved','gross_revenue':'-20.10','revenue_date':'2026-09-09','channel':'direct'},
        {'id':'l3','source_document_id':'d3','approval_status':'approved','gross_revenue':999,'revenue_date':'2026-09-09'},
        {'id':'l4','source_document_id':'d1','approval_status':'pending','gross_revenue':999,'revenue_date':'2026-09-09'}],
      'payment_requests':[
        {'id':'p1','payment_status':'partial','total_amount':100,'payment_method':'cash'},
        {'id':'p2','payment_status':'unpaid','total_amount':50,'payment_method':'bank'},
        {'id':'p3','payment_status':'paid','total_amount':999,'payment_method':'bank'}],
      'payment_allocations':[
        {'id':'a1','payment_request_id':'p1','amount':'20.10'},
        {'id':'a2','payment_request_id':'p1','amount':'30.15'},
        {'id':'a3','payment_request_id':'p2','amount':70}],
      'inventory_items':[
        {'id':'i1','quantity':0,'min_stock':None,'category':'food'},
        {'id':'i2','quantity':5,'min_stock':5,'category':'food'},
        {'id':'i3','quantity':8,'min_stock':1,'category':'drink'}],
      'purchase_orders':[{'id':'po1','order_date':'2026-09-09','status':'draft'},{'id':'po2','order_date':'2026-09-09','status':'received'}],
      'production_orders':[{'id':'pr1','created_at':'2026-09-08T17:00:00Z','status':'planned','location_code':'Q7'},{'id':'pr2','created_at':'2026-09-08T16:59:59Z','status':'draft'}],
      'goods_receipts':[{'id':'g1','receipt_date':'2026-09-09','status':'received'}],
      'mini_crm_customers':[{'id':'c1','is_active':True,'customer_group':'dealer'},{'id':'c2','is_active':False}],
      'product_skus':[{'id':'s1','category':'food'}],
      'mini_crm_customer_contracts':[{'id':'ct1','customer_id':'c1','is_active':True,'file_name':'not instructions.pdf'},{'id':'ct2','is_active':False}],
    }
    publish(w,snapshot(rows));return w,QueryEngine(w),rows


def q(state,metric,**kw):
    return state[1].execute({'metric':metric,'time_range':{'start':'2026-09-09','end':'2026-09-09'},**kw},TENANT,'owner:fixture')


def current(state,metric,**kw):
    return state[1].execute({'metric':metric,'time_range':'today',**kw},TENANT,'owner:fixture')


def test_revenue_preserves_approved_controlled_join_and_signed_adjustment(state):
    r=q(state,'controlled_revenue',dimensions=['channel'])
    assert r['rows']==[{'channel':'direct','currency':'VND','controlled_revenue':Decimal('80.05')}]
    assert r['snapshot_id'] and r['semantic_version']=='bmq-business-v2'
    assert 'not net' in r['definition'].lower()


def test_supplier_allocations_aggregated_once_and_clamped_per_request(state):
    assert current(state,'supplier_debt')['rows'][0]['supplier_debt']==Decimal('49.75')
    rows=current(state,'supplier_debt',dimensions=['payment_method'])['rows']
    assert {r['payment_method']:r['supplier_debt'] for r in rows}=={'cash':Decimal('49.75'),'bank':0}


def test_purchase_inventory_and_production_definitions(state):
    assert q(state,'purchase_order_count')['rows'][0]['purchase_order_count']==2
    assert current(state,'low_stock_count')['rows'][0]['low_stock_count']==2
    assert q(state,'production_order_count',dimensions=['location'])['rows'][0]['location']=='Q7'
    assert q(state,'production_order_count')['rows'][0]['production_order_count']==1
    assert q(state,'goods_receipt_count')['rows'][0]['goods_receipt_count']==1
    assert q(state,'warehouse_dispatch_count')['rows'][0]['warehouse_dispatch_count']==0


@pytest.mark.parametrize('metric',['low_stock_count','supplier_debt','active_customer_count','product_sku_count','active_contract_file_count'])
def test_no_historical_snapshot_invention(state,metric):
    with pytest.raises(ValueError,match='snapshot'):
        state[1].execute({'metric':metric,'time_range':'yesterday'},TENANT)


def test_catalog_counts_are_not_contract_contents_or_contact_disclosure(state):
    for metric in ['active_customer_count','product_sku_count','active_contract_file_count']:
        result=current(state,metric)
        assert result['rows'][0][metric]==1
        assert 'file_name' not in str(result) and 'customer_id' not in str(result)
    assert 'NOT indexed' in current(state,'active_contract_file_count')['definition']


def test_republication_changes_status_and_allocation_without_stale_cache(state):
    w,_,rows=state
    rows['revenue_source_documents'][0]['status']='draft'
    rows['payment_allocations']=rows['payment_allocations'][1:]
    publish(w,snapshot(rows,1))
    assert q(state,'controlled_revenue')['rows'][0]['controlled_revenue']==Decimal('-20.10')
    assert current(state,'supplier_debt')['rows'][0]['supplier_debt']==Decimal('69.85')


def test_missing_document_reference_is_not_silently_zero(state):
    w,_,rows=state;rows['revenue_source_documents']=[];publish(w,snapshot(rows,1))
    with pytest.raises(RuntimeError,match='references'):q(state,'controlled_revenue')


def test_missing_table_in_old_manifest_cannot_be_reported_as_zero(state):
    w,_,_=state
    with w.lock(),w.connect() as con:
        manifest=json.loads(con.execute('select manifest from meta_supabase_sync_runs').fetchone()[0]);del manifest['tables']['payment_allocations']
        con.execute('update meta_supabase_sync_runs set manifest=?',[json.dumps(manifest)])
    with pytest.raises(RuntimeError,match='not synchronized'):current(state,'supplier_debt')


def test_snapshot_stale_and_unauthorized_denied(state):
    w,e,_=state
    with pytest.raises(PermissionError):e.execute({'metric':'supplier_debt'},TENANT,'staff')
    with pytest.raises(PermissionError):e.execute({'metric':'supplier_debt'},'another-tenant','owner')
    with w.lock(),w.connect() as con:con.execute("update meta_supabase_sync_runs set observed_at=now()-interval '31 minutes'")
    with pytest.raises(RuntimeError,match='stale'):current(state,'supplier_debt')


@pytest.mark.parametrize('kw',[{'dimensions':['payment_method']},{'dimensions':['date','date']},{'sql':'select *'},{'limit':True},{'limit':501},{'filters':{'customer_id':'other'}}])
def test_business_closed_grammar(state,kw):
    with pytest.raises(ValueError):q(state,'controlled_revenue',**kw)
