"""R11 kho event log: four new scalar-only raw projections."""
import json

from sme_platform.supabase_sync import FIELDS, VERSION, publish, query_sql
from test_r2_audit_sync import put, snapshot, warehouse
from test_r4_warehouse_sync import read

TABLES = {'tan_tao_material_movements', 'stock_transfers',
          'kho_audit_log', 'stock_unit_events'}

EXPECTED = {
    'tan_tao_material_movements': ['id', 'kitchen_inventory_item_id', 'movement_date',
                                   'movement_type', 'quantity', 'unit', 'source',
                                   'source_ref_id', 'source_ref_key', 'created_by', 'created_at'],
    'stock_transfers': ['id', 'transfer_number', 'from_location', 'to_location',
                        'kitchen_inventory_item_id', 'quantity', 'unit', 'transfer_date',
                        'source', 'goods_receipt_item_id', 'created_by', 'created_at'],
    'kho_audit_log': ['id', 'occurred_at', 'actor_id', 'action', 'item_id', 'item_name', 'source'],
    'stock_unit_events': ['id', 'action', 'unit', 'item_id', 'actor', 'created_at'],
}

ACTOR = '11111111-1111-1111-1111-111111111111'
ITEM = '22222222-2222-2222-2222-222222222222'


def test_r11_projection_is_scalar_uuid_only_and_raw_v16():
    assert VERSION == 'bmq-supabase-raw-v16'
    assert TABLES <= FIELDS.keys()
    for table, fields in EXPECTED.items():
        assert FIELDS[table].split() == fields
    # Free text, JSON change/detail payloads and profile names stay out; an item
    # display name is the only allowed "name" scalar.
    forbidden = {'note', 'changes', 'details', 'email', 'phone', 'name', 'profiles'}
    for table in TABLES:
        assert not set(FIELDS[table].split()) & forbidden
    sql = query_sql()
    for table in TABLES:
        assert table in sql
    for column in ('"note"', '"changes"', '"details"', 'profiles'):
        assert column not in sql


def test_r11_publish_preserves_scalar_rows_and_actor_without_profile(warehouse):
    value = snapshot()
    put(value, 'tan_tao_material_movements', id='tt1',
        kitchen_inventory_item_id=ITEM, movement_date='2026-10-20',
        movement_type='receipt', quantity='1.234567', unit='kg',
        source='goods_receipt', source_ref_id=None,
        source_ref_key='receipt:gr-1', created_by=ACTOR,
        created_at='2026-10-20T03:00:00+00:00')
    put(value, 'stock_transfers', id='st1', transfer_number='CK-20261020-ABC123',
        from_location='tan_tao', to_location='q7', kitchen_inventory_item_id=ITEM,
        quantity='2.5', unit='kg', transfer_date='2026-10-20', source='manual',
        goods_receipt_item_id=None, created_by=ACTOR,
        created_at='2026-10-20T04:00:00+00:00')
    put(value, 'kho_audit_log', id='a1', occurred_at='2026-10-20T05:00:00+00:00',
        actor_id=ACTOR, action='unit_changed', item_id=ITEM,
        item_name='Món A', source='app')
    put(value, 'stock_unit_events', id='u1', action='add_unit', unit='kg',
        item_id=ITEM, actor=ACTOR, created_at='2026-10-20T06:00:00+00:00')

    report = publish(warehouse, value)
    for table in TABLES:
        assert report['tables'][table]['records'] == 1
    movement = read(warehouse, report, 'tan_tao_material_movements')[0]
    assert movement['created_by'] == ACTOR
    assert movement['quantity'] == '1.234567'
    assert movement['source_ref_key'] == 'receipt:gr-1'
    transfer = read(warehouse, report, 'stock_transfers')[0]
    assert transfer['created_by'] == ACTOR
    assert transfer['transfer_number'] == 'CK-20261020-ABC123'
    audit = read(warehouse, report, 'kho_audit_log')[0]
    assert audit['actor_id'] == ACTOR
    assert audit['item_name'] == 'Món A'
    assert set(audit) == set(EXPECTED['kho_audit_log'])
    unit = read(warehouse, report, 'stock_unit_events')[0]
    assert unit['actor'] == ACTOR
    assert set(unit) == set(EXPECTED['stock_unit_events'])
