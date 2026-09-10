"""Q7/kitchen transport keeps missing counts, signs and planned vs actual grain."""
import copy
import json

import pytest

from sme_platform.supabase_sync import FIELDS, publish
from test_r2_audit_sync import snapshot, put, warehouse
from test_r4_warehouse_sync import read

TABLES = {'kitchen_inventory_items', 'kitchen_inventory_movements',
          'kitchen_inventory_monthly_closings', 'q7_inventory_openings',
          'q7_inventory_movements', 'q7_material_issue_material_mappings',
          'kfm_daily_material_issues', 'kfm_daily_material_issue_items',
          'kfm_daily_material_issue_sources'}


def test_no_actor_free_text_or_import_payload():
    assert TABLES <= FIELDS.keys()
    for table in TABLES:
        assert not set(FIELDS[table].split()) & {
            'created_by', 'updated_by', 'closed_by', 'printed_by', 'approved_by',
            'audit_actor', 'audit_note', 'note', 'notes', 'raw_payload', 'source_hash',
            'trusted_source_row_id', 'trusted_source_batch_id'}


def test_q7_positive_usage_separate_from_kitchen_and_missing_opening(warehouse):
    value = snapshot()
    put(value, 'kitchen_inventory_items', id='item', unit='KG', active=True)
    put(value, 'q7_inventory_openings', id='opening', kitchen_inventory_item_id='item',
        effective_date='2026-09-01', opening_qty=None, physical_count_qty=0, unit='KG')
    for key, kind, quantity in [('receipt', 'receipt', '1.123456789'),
                                 ('use', 'production_usage', '2.123456789'),
                                 ('adjust', 'adjustment', '-0.01')]:
        put(value, 'q7_inventory_movements', id=key, kitchen_inventory_item_id='item',
            movement_type=kind, quantity=quantity, unit='KG', source_issue_id='prod-not-kfm')
    put(value, 'kitchen_inventory_movements', id='kitchen', item_id='item',
        quantity=4, unit='kg', movement_type='usage', location_code=None)
    report = publish(warehouse, value)
    opening = read(warehouse, report, 'q7_inventory_openings')[0]
    assert opening['opening_qty'] is None and opening['physical_count_qty'] == 0
    assert {r['id']: r['quantity'] for r in read(warehouse, report, 'q7_inventory_movements')} == {
        'receipt': '1.123456789', 'use': '2.123456789', 'adjust': '-0.01'}
    kitchen = read(warehouse, report, 'kitchen_inventory_movements')[0]
    assert kitchen['quantity'] == 4 and kitchen['unit'] == 'kg' and kitchen['location_code'] is None


def test_plan_revision_conversion_and_close_are_not_actual_stock(warehouse):
    value = snapshot()
    put(value, 'q7_material_issue_material_mappings', id='mapping',
        source_unit='g', kitchen_unit='KG', conversion_factor='0.00100001', approval_status='pending')
    put(value, 'kitchen_inventory_monthly_closings', id='close', item_id='item',
        opening_qty=None, system_ending_qty='-2.1', counted_ending_qty=None,
        variance_qty=None, status='draft')
    put(value, 'kfm_daily_material_issues', id='plan1', status='superseded', revision=1)
    put(value, 'kfm_daily_material_issues', id='plan2', status='printed', revision=2)
    put(value, 'kfm_daily_material_issue_items', id='line', issue_id='plan2', required_qty='100.1', unit='g')
    put(value, 'kfm_daily_material_issue_sources', id='source', issue_id='plan2', production_order_id='po')
    one = publish(warehouse, value)
    assert one['tables']['q7_inventory_movements']['records'] == 0
    assert read(warehouse, one, 'kitchen_inventory_monthly_closings')[0]['counted_ending_qty'] is None
    assert read(warehouse, one, 'q7_material_issue_material_mappings')[0]['approval_status'] == 'pending'
    assert {r['revision'] for r in read(warehouse, one, 'kfm_daily_material_issues')} == {1, 2}
    again = copy.deepcopy(value); again['observed_at'] = snapshot(1)['observed_at']
    repeat = publish(warehouse, again)
    assert all(t['inserted'] + t['updated'] + t['absent'] == 0 for t in repeat['tables'].values())
    assert read(warehouse, repeat, 'q7_material_issue_material_mappings')[0]['conversion_factor'] == '0.00100001'


@pytest.mark.parametrize('fault', ['duplicate', 'truncated', 'extra'])
def test_failed_q7_snapshot_preserves_last_publication(warehouse, fault):
    first = snapshot()
    put(first, 'q7_inventory_openings', id='opening', opening_qty=None)
    report = publish(warehouse, first)
    bad = copy.deepcopy(first); bad['observed_at'] = snapshot(1)['observed_at']
    table = next(t for t in bad['tables'] if t['name'] == 'q7_inventory_openings')
    if fault == 'duplicate':
        table['records'] *= 2; table['count'] = 2
    elif fault == 'truncated':
        table['records'] = []
    else:
        row = json.loads(table['records'][0]); row['audit_note'] = 'exclude'
        table['records'] = [json.dumps(row)]
    with pytest.raises(ValueError):
        publish(warehouse, bad)
    with warehouse.connect(read_only=True) as con:
        assert con.execute('SELECT count(*) FROM meta_supabase_sync_runs').fetchone()[0] == 1
    assert read(warehouse, report, 'q7_inventory_openings')[0]['opening_qty'] is None
