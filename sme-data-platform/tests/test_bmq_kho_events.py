"""Behavioral tests for the fixed-rule kitchen event log.

Synthetic raw snapshots only: no network, credentials, model or real business
data. Each flag has a positive and a negative case; stock transfers are counted
once even when their two ledger rows are present.
"""
from datetime import date

import pytest
from fastapi.testclient import TestClient

from sme_platform.api import Principal, create_app
from sme_platform.bmq_kho_events import (EVENT_TYPES, FLAG_CODES, FLAG_DEFINITIONS,
                                         LABEL_VERSION, catalog, execute, validate_request)
from sme_platform.config import Settings
from sme_platform.query import QueryEngine
from sme_platform.supabase_sync import TENANT, publish
from sme_platform.warehouse import Warehouse
from test_bmq_semantic import snapshot

ACTOR = '11111111-1111-1111-1111-111111111111'
NOON = '2026-10-10T12:00:00+07:00'
LATE = '2026-10-10T23:30:00+07:00'


def movement(ident, item, when, movement_type='receipt', quantity='10',
             source='manual_adjustment', source_ref_key=None, actor=ACTOR, unit='kg'):
    return {'id': ident, 'kitchen_inventory_item_id': item,
            'movement_date': when[:10], 'movement_type': movement_type,
            'quantity': quantity, 'unit': unit, 'source': source,
            'source_ref_id': None, 'source_ref_key': source_ref_key,
            'created_by': actor, 'created_at': when}


def q7_movement(ident, item, when, movement_type='adjustment', quantity='10',
                source='manual_adjustment', source_ref_key=None, actor=ACTOR):
    return {'id': ident, 'kitchen_inventory_item_id': item,
            'movement_date': when[:10], 'movement_type': movement_type,
            'quantity': quantity, 'unit': 'kg', 'source': source,
            'source_ref_id': None, 'source_ref_key': source_ref_key,
            'created_by': actor, 'created_at': when}


def transfer(ident, item, when, source='manual', quantity='10'):
    return {'id': ident, 'transfer_number': 'CK-20261010-' + ident.upper()[:6],
            'from_location': 'tan_tao', 'to_location': 'q7',
            'kitchen_inventory_item_id': item, 'quantity': quantity, 'unit': 'kg',
            'transfer_date': when[:10], 'source': source,
            'goods_receipt_item_id': None, 'created_by': ACTOR, 'created_at': when}


def audit(ident, item, when, action='renamed', actor=ACTOR):
    return {'id': ident, 'occurred_at': when, 'actor_id': actor, 'action': action,
            'item_id': item, 'item_name': 'Món A', 'source': 'app'}


def unit_event(ident, item, when, action='add_unit', unit='kg', actor=ACTOR):
    return {'id': ident, 'action': action, 'unit': unit, 'item_id': item,
            'actor': actor, 'created_at': when}


@pytest.fixture
def state(tmp_path):
    warehouse = Warehouse(Settings(tmp_path / 'data', test_mode=True))
    warehouse.initialize()
    return warehouse, QueryEngine(warehouse)


def load(state, rows):
    publish(state[0], snapshot(rows))
    return state[1]


def kho(state, **request):
    request.setdefault('from_date', '2026-10-01')
    request.setdefault('to_date', '2026-10-31')
    return execute(state[1], request, TENANT, 'owner:fixture')


def by_source(result):
    return {row['source_id']: row for row in result['rows']}


def test_every_event_type_maps_from_movement_source_and_action(state):
    rows = {
        'tan_tao_material_movements': [
            movement('tt-receipt', 'item-tt', NOON, movement_type='receipt'),
            movement('tt-count', 'item-tt', NOON, movement_type='adjustment', quantity='2',
                     source='manual_adjustment', source_ref_key='tt-material-count:1'),
            movement('tt-opening', 'item-tt', NOON, movement_type='opening'),
        ],
        'q7_inventory_movements': [
            q7_movement('q7-prod', 'item-q7', NOON, movement_type='production_usage'),
            q7_movement('q7-adjust', 'item-q7', NOON, movement_type='adjustment'),
            q7_movement('q7-count', 'item-q7', NOON, movement_type='adjustment',
                        source_ref_key='q7-stock-count:1'),
        ],
        'stock_transfers': [transfer('transfer', 'item-transfer', NOON)],
        'kho_audit_log': [
            audit('audit-renamed', 'item-catalog', NOON, action='renamed'),
            audit('audit-unit', 'item-catalog', NOON, action='unit_changed'),
        ],
        'stock_unit_events': [unit_event('unit-add', 'item-unit', NOON)],
    }
    load(state, rows)
    found = {row['source_id']: row['event_type'] for row in kho(state)['rows']}
    assert found == {
        'tt-receipt': 'nhap_kho',
        'tt-count': 'kiem_ke',
        'tt-opening': 'ton_dau_ky',
        'q7-prod': 'dung_san_xuat',
        'q7-adjust': 'dieu_chinh',
        'q7-count': 'kiem_ke',
        'transfer': 'chuyen_kho',
        'audit-renamed': 'sua_danh_muc',
        'audit-unit': 'don_vi',
        'unit-add': 'don_vi',
    }
    assert set(EVENT_TYPES) == set(found.values())


def test_stock_transfer_is_one_row_and_its_two_ledger_rows_are_skipped(state):
    rows = {
        'tan_tao_material_movements': [
            movement('tt-transfer', 'item-transfer', NOON, movement_type='transfer_out',
                     source='stock_transfer', source_ref_key='transfer:1')],
        'q7_inventory_movements': [
            q7_movement('q7-transfer', 'item-transfer', NOON, movement_type='transfer_in',
                        source='stock_transfer', source_ref_key='transfer:1')],
        'stock_transfers': [transfer('transfer', 'item-transfer', NOON)],
    }
    load(state, rows)
    result = kho(state, event_type='chuyen_kho')
    assert result['match_count'] == 1
    assert [row['source_table'] for row in result['rows']] == ['stock_transfers']
    assert result['rows'][0]['document_ref'] == 'CK-20261010-TRANSF'


@pytest.mark.parametrize('quantity,expected', [('100', True), ('20', False)])
def test_flag_dieu_chinh_lon_positive_and_negative(state, quantity, expected):
    rows = {'tan_tao_material_movements':
            [movement('ref%d' % day, 'item-adjust', '2026-09-0%dT12:00:00+07:00' % day,
                      quantity='10') for day in range(1, 6)],
            'q7_inventory_movements':
            [q7_movement('adjust', 'item-adjust', NOON, quantity=quantity)]}
    load(state, rows)
    row = by_source(kho(state, item_id='item-adjust'))['adjust']
    assert ('dieu_chinh_lon' in row['flags']) is expected


@pytest.mark.parametrize('kind', ['unit_event', 'audit_unit'])
@pytest.mark.parametrize('prior,expected', [(True, True), (False, False)])
def test_flag_sua_don_vi_sau_phat_sinh_positive_and_negative(state, kind, prior, expected):
    rows = {'stock_unit_events': [], 'kho_audit_log': []}
    if prior:
        rows['tan_tao_material_movements'] = [
            movement('prior', 'item-unit', '2026-09-01T12:00:00+07:00')]
    if kind == 'unit_event':
        rows['stock_unit_events'].append(unit_event('unit', 'item-unit', NOON))
    else:
        rows['kho_audit_log'].append(audit('unit', 'item-unit', NOON, action='unit_changed'))
    load(state, rows)
    row = by_source(kho(state, item_id='item-unit'))['unit']
    assert ('sua_don_vi_sau_phat_sinh' in row['flags']) is expected


@pytest.mark.parametrize('source,expected', [('manual', True), ('auto_goods_receipt', False)])
def test_flag_chuyen_kho_thu_cong_positive_and_negative(state, source, expected):
    load(state, {'stock_transfers': [transfer('transfer', 'item-transfer', NOON, source=source)]})
    row = kho(state, event_type='chuyen_kho')['rows'][0]
    assert ('chuyen_kho_thu_cong' in row['flags']) is expected


@pytest.mark.parametrize('when,expected', [(LATE, True), (NOON, False)])
def test_flag_ngoai_gio_positive_and_negative(state, when, expected):
    load(state, {'tan_tao_material_movements': [movement('night', 'item-night', when)]})
    row = kho(state, item_id='item-night')['rows'][0]
    assert ('ngoai_gio' in row['flags']) is expected


@pytest.mark.parametrize('actor,expected', [(None, True), (ACTOR, False)])
def test_flag_thieu_nguoi_lam_positive_and_negative(state, actor, expected):
    load(state, {'tan_tao_material_movements': [movement('actor', 'item-actor', NOON, actor=actor)]})
    row = kho(state, item_id='item-actor')['rows'][0]
    assert ('thieu_nguoi_lam' in row['flags']) is expected


def test_totals_by_event_type_and_flag_are_computed_before_limit(state):
    rows = {'tan_tao_material_movements': [
                movement('night', 'item-night', LATE, actor=None)],
            'stock_transfers': [transfer('transfer', 'item-transfer', NOON)]}
    load(state, rows)
    result = kho(state, limit=1)
    assert result['match_count'] == 2 and result['truncated'] is True
    assert len(result['rows']) == 1
    assert result['totals']['event_count'] == 2
    by_type = {row['event_type']: row['event_count'] for row in result['totals']['by_event_type']}
    assert by_type['nhap_kho'] == 1 and by_type['chuyen_kho'] == 1
    by_flag = {row['flag']: row['event_count'] for row in result['totals']['by_flag']}
    assert by_flag['thieu_nguoi_lam'] == 1
    assert by_flag['ngoai_gio'] == 1
    assert by_flag['chuyen_kho_thu_cong'] == 1
    filtered = kho(state, flag='thieu_nguoi_lam')
    assert filtered['match_count'] == 1
    assert {row['source_id'] for row in filtered['rows']} == {'night'}


def test_filters_and_closed_parameter_validation(state):
    load(state, {'tan_tao_material_movements': [movement('one', 'item-one', NOON)],
                 'stock_transfers': [transfer('two', 'item-two', NOON)]})
    assert kho(state, event_type='nhap_kho')['match_count'] == 1
    assert kho(state, kho='q7')['match_count'] == 0
    assert kho(state, item_id='item-one')['match_count'] == 1
    with pytest.raises(ValueError):
        validate_request({'to_date': '2026-10-31'})
    with pytest.raises(ValueError):
        validate_request({'from_date': '2026-10-01'})
    with pytest.raises(ValueError):
        validate_request({'from_date': '2026-01-01', 'to_date': '2026-04-03'})
    assert validate_request({'from_date': '2026-01-01', 'to_date': '2026-04-02'})['limit'] == 200
    for limit in (0, 1001, True, '10'):
        with pytest.raises(ValueError):
            validate_request({'from_date': '2026-10-01', 'to_date': '2026-10-31', 'limit': limit})
    with pytest.raises(ValueError):
        validate_request({'from_date': '2026-10-02', 'to_date': '2026-10-01'})
    with pytest.raises(ValueError):
        validate_request({'from_date': '2026-10-01', 'to_date': '2026-10-31', 'event_type': 'other'})
    with pytest.raises(ValueError):
        validate_request({'from_date': '2026-10-01', 'to_date': '2026-10-31', 'flag': 'other'})
    with pytest.raises(ValueError):
        validate_request({'from_date': '2026-10-01', 'to_date': '2026-10-31', 'kho': 'other'})
    with pytest.raises(ValueError):
        validate_request({'from_date': '2026-10-01', 'to_date': '2026-10-31', 'unknown': 1})


def test_tenant_isolation_and_owner_only_api(state):
    warehouse, _ = state
    load(state, {'tan_tao_material_movements': [movement('one', 'item-one', NOON)]})
    request = {'from_date': '2026-10-01', 'to_date': '2026-10-31'}
    with pytest.raises(PermissionError):
        execute(state[1], request, 'other.supabase.co', 'owner:fixture')
    with pytest.raises(PermissionError):
        execute(state[1], request, TENANT, 'dealer')
    foreign = TestClient(create_app(warehouse, authenticator=lambda: Principal('other.supabase.co', 'u')))
    assert foreign.post('/v1/kho/events', json=request).status_code == 403
    owner = TestClient(create_app(warehouse, authenticator=lambda: Principal(TENANT, 'fixture-owner')))
    response = owner.post('/v1/kho/events', json=request)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body['label_version'] == LABEL_VERSION
    assert body['rows'][0]['source_id'] == 'one'
    assert body['semantic_version'] and body['sync_version']


def test_catalog_discloses_fixed_labels_and_flags():
    value = catalog()
    assert value['label_version'] == LABEL_VERSION == 'kho-rules-v1'
    assert {item['code'] for item in value['event_types']} == set(EVENT_TYPES)
    assert {item['code'] for item in value['flags']} == set(FLAG_CODES)
    for flag in FLAG_DEFINITIONS:
        assert flag['label_version'] == 'kho-rules-v1'
        assert flag['description_vi']
    assert validate_request({'from_date': '2026-10-01', 'to_date': '2026-10-31'})['from_date'] == date(2026, 10, 1)


@pytest.mark.parametrize('actor,expected', [(None, True), (ACTOR, False)])
def test_q7_actor_is_synced_and_drives_thieu_nguoi_lam(state, actor, expected):
    load(state, {'q7_inventory_movements': [q7_movement('q7', 'item-q7', NOON, actor=actor)]})
    row = kho(state, item_id='item-q7')['rows'][0]
    assert row['actor_id'] == actor
    assert ('thieu_nguoi_lam' in row['flags']) is expected
