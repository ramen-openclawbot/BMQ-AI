"""Warehouse transport preserves grain and evidence, without deriving stock."""
import copy
import json

import pytest

from sme_platform.supabase_sync import FIELDS, publish
from test_r2_audit_sync import snapshot, put, warehouse

TABLES = {'goods_receipt_items', 'inventory_batches', 'inventory_movements',
          'goods_receipt_auto_issues', 'goods_receipt_auto_issue_items',
          'tan_tao_warehouse_documents', 'tan_tao_warehouse_movements',
          'tan_tao_warehouse_reservations'}


def read(warehouse, report, table):
    return [json.loads(line) for line in
            (warehouse.root / report['tables'][table]['raw_path']).read_text().splitlines()]


def test_warehouse_projection_no_free_text_or_actor():
    assert TABLES <= FIELDS.keys()
    for table in TABLES:
        assert not set(FIELDS[table].split()) & {
            'notes', 'note', 'metadata', 'created_by', 'raw_product_name',
            'reference_label', 'expiry_last_edited_by', 'idempotency_key'}


def test_receipt_auto_issue_pair_and_batch_balance_are_separate(warehouse):
    value = snapshot()
    put(value, 'goods_receipt_items', id='line1', goods_receipt_id='gr1',
        inventory_item_id='inv1', sku_id='s1', unit='kg', quantity='1.2500000001',
        actual_quantity=None, line_status='pending', expiry_date=None)
    put(value, 'inventory_batches', id='batch1', goods_receipt_item_id='line1',
        inventory_item_id='inv1', unit='kg', quantity=0)
    put(value, 'goods_receipt_auto_issues', id='auto1', goods_receipt_id='gr1', status='posted')
    put(value, 'goods_receipt_auto_issue_items', id='ai1', auto_issue_id='auto1',
        goods_receipt_item_id='line1', batch_id='batch1', unit='kg', quantity='1.2500000001')
    for key, amount, kind in [('in', '1.2500000001', 'goods_receipt_in'), ('out', '-1.2500000001', 'production_consume')]:
        put(value, 'inventory_movements', id=key, batch_id='batch1', unit='kg',
            quantity=amount, movement_type=kind, reference_type='goods_receipt_auto_issue', reference_id='ai1')
    put(value, 'inventory_movements', id='other-unit', unit='cái', quantity=7, batch_id=None)
    report = publish(warehouse, value)
    assert {r['id']: r['quantity'] for r in read(warehouse, report, 'inventory_movements')} == {
        'in': '1.2500000001', 'out': '-1.2500000001', 'other-unit': 7}
    assert read(warehouse, report, 'inventory_batches')[0]['quantity'] == 0
    line = read(warehouse, report, 'goods_receipt_items')[0]
    assert line['actual_quantity'] is None and line['quantity'] == '1.2500000001'
    assert read(warehouse, report, 'goods_receipt_auto_issue_items')[0]['batch_id'] == 'batch1'
    assert report['tables']['warehouse_dispatches']['records'] == 0


def test_reservation_lifecycle_not_extra_dispatch_and_replay_is_idempotent(warehouse):
    first = snapshot()
    put(first, 'tan_tao_warehouse_documents', id='d1', location_code='warehouse_tan_tao',
        sku_id='s1', document_type='outbound_order', status='reserved', ordered_quantity=10,
        exchange_quantity=2, makeup_quantity=1, physical_quantity=13)
    put(first, 'tan_tao_warehouse_reservations', id='r1', document_id='d1',
        location_code='warehouse_tan_tao', sku_id='s1', quantity=13, status='active')
    one = publish(warehouse, first)
    assert one['tables']['tan_tao_warehouse_movements']['records'] == 0
    second = copy.deepcopy(first); second['observed_at'] = snapshot(1)['observed_at']
    table = next(t for t in second['tables'] if t['name'] == 'tan_tao_warehouse_reservations')
    row = json.loads(table['records'][0]); row.update(status='dispatched', dispatched_at='2026-09-10T10:00:00Z')
    table['records'] = [json.dumps(row)]
    put(second, 'tan_tao_warehouse_documents', id='d2', source_document_id='d1',
        location_code='warehouse_tan_tao', sku_id='s1', document_type='dispatch', status='posted', physical_quantity=13)
    put(second, 'tan_tao_warehouse_movements', id='m1', document_id='d2',
        location_code='warehouse_tan_tao', sku_id='s1', movement_type='dispatch', quantity=-13)
    two = publish(warehouse, second)
    assert two['tables']['tan_tao_warehouse_reservations']['updated'] == 1
    assert read(warehouse, two, 'tan_tao_warehouse_movements')[0]['quantity'] == -13
    assert read(warehouse, one, 'tan_tao_warehouse_reservations')[0]['status'] == 'active'
    again = copy.deepcopy(second); again['observed_at'] = snapshot(2)['observed_at']
    repeat = publish(warehouse, again)
    assert all(t['inserted'] + t['updated'] + t['absent'] == 0 for t in repeat['tables'].values())


@pytest.mark.parametrize('fault', ['duplicate', 'truncated', 'extra'])
def test_bad_warehouse_extract_keeps_last_good_publication(warehouse, fault):
    first = snapshot()
    put(first, 'inventory_movements', id='m1', unit='kg', quantity='0.01')
    report = publish(warehouse, first)
    bad = copy.deepcopy(first); bad['observed_at'] = snapshot(1)['observed_at']
    table = next(t for t in bad['tables'] if t['name'] == 'inventory_movements')
    if fault == 'duplicate':
        table['records'] *= 2; table['count'] = 2
    elif fault == 'truncated':
        table['records'] = []
    else:
        row = json.loads(table['records'][0]); row['note'] = 'must not copy'
        table['records'] = [json.dumps(row)]
    with pytest.raises(ValueError):
        publish(warehouse, bad)
    with warehouse.connect(read_only=True) as con:
        assert con.execute('SELECT count(*) FROM meta_supabase_sync_runs').fetchone()[0] == 1
    assert read(warehouse, report, 'inventory_movements')[0]['quantity'] == '0.01'
