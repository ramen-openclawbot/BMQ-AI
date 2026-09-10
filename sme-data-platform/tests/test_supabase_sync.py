import copy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path

import pytest
from sme_platform.config import Settings
from sme_platform.warehouse import Warehouse
from sme_platform.supabase_sync import FIELDS, KEYS, TOTALS, TENANT, extract, publish, query_sql, validate, parse_source_response


def snapshot(offset=0):
    tables = []
    for name, fields in FIELDS.items():
        row = dict.fromkeys(fields.split())
        row[KEYS[name]] = name + '-1'
        if name in TOTALS:
            row[TOTALS[name]] = 12
        tables.append({'name': name, 'count': 1, 'total': '12' if name in TOTALS else None,
                       'records': [json.dumps(row)]})
    return {'database': 'postgres', 'observed_at': (datetime.now(timezone.utc) + timedelta(seconds=offset)).isoformat(), 'tables': tables}


@pytest.fixture
def warehouse(tmp_path):
    w = Warehouse(Settings(tmp_path / 'data', test_mode=True))
    w.initialize()
    return w


def test_readonly_fixed_projection():
    sql = query_sql()
    assert 'REPEATABLE READ READ ONLY' in sql and 'statement_timeout' in sql
    assert 'LIMIT 50001' in sql
    assert 'auth.' not in sql and 'session_id' not in sql and 'token' not in sql
    assert 'customer_snapshot' not in sql and 'staff_phone' not in sql
    assert 'is_test' in sql and 'status' in sql


def test_replay_update_removal_and_raw_preservation(warehouse):
    first = snapshot()
    one = publish(warehouse, first)
    assert sum(t['inserted'] for t in one['tables'].values()) == len(FIELDS)
    second = copy.deepcopy(first)
    second['observed_at'] = snapshot(1)['observed_at']
    two = publish(warehouse, second)
    assert sum(t['inserted'] + t['updated'] + t['absent'] for t in two['tables'].values()) == 0
    assert one['tables']['dealer_orders']['raw_path'] == two['tables']['dealer_orders']['raw_path']
    third = copy.deepcopy(second)
    third['observed_at'] = snapshot(2)['observed_at']
    for t in third['tables']:
        if t['name'] == 'dealer_orders':
            row = json.loads(t['records'][0]); row['status'] = 'cancelled'; row['is_test'] = True
            t['records'] = [json.dumps(row)]
        if t['name'] == 'dealer_order_items':
            t.update(records=[], count=0, total='0')
    three = publish(warehouse, third)
    assert three['tables']['dealer_orders']['updated'] == 1
    assert three['tables']['dealer_order_items']['absent'] == 1
    with warehouse.lock(write=False), warehouse.connect(read_only=True) as con:
        assert con.execute('select count(*) from silver.orders').fetchone()[0] == 0
        assert con.execute("select count(*) from bronze.supabase_changes where operation='absent_in_source_snapshot'").fetchone()[0] == 1
    assert (warehouse.root / one['tables']['dealer_orders']['raw_path']).exists()


@pytest.mark.parametrize('fault', ['truncated', 'duplicate', 'total', 'extra_field', 'missing_table', 'duplicate_table'])
def test_bad_snapshot_cannot_replace_publication(warehouse, fault):
    good = snapshot(); publish(warehouse, good)
    bad = snapshot(1)
    table = next(t for t in bad['tables'] if t['name'] == 'dealer_orders')
    if fault == 'truncated': table['count'] = 2
    if fault == 'duplicate': table['records'] *= 2; table['count'] = 2; table['total'] = '24'
    if fault == 'total': table['total'] = '99'
    if fault == 'extra_field':
        row = json.loads(table['records'][0]); row['unexpected'] = 'reject'; table['records'] = [json.dumps(row)]
    if fault == 'missing_table': bad['tables'].pop()
    if fault == 'duplicate_table': bad['tables'][-1] = bad['tables'][0]
    with pytest.raises(ValueError): publish(warehouse, bad)
    with warehouse.lock(write=False), warehouse.connect(read_only=True) as con:
        assert con.execute('select count(*) from meta_supabase_sync_runs').fetchone()[0] == 1
        assert con.execute('select count(*) from bronze.supabase_current').fetchone()[0] == len(FIELDS)


def test_stale_snapshot_rejected(warehouse):
    value = snapshot(); publish(warehouse, value)
    with pytest.raises(ValueError): publish(warehouse, value)


def test_decimal_lexeme_preserved(warehouse):
    value = snapshot()
    table = next(t for t in value['tables'] if t['name'] == 'dealer_orders')
    table['records'][0] = table['records'][0].replace('"total_amount_vnd": 12', '"total_amount_vnd": 1234567890123456.12345')
    table['total'] = '1234567890123456.12345'
    result = publish(warehouse, value)
    raw = (warehouse.root / result['tables']['dealer_orders']['raw_path']).read_text()
    assert '1234567890123456.12345' in raw


def test_linked_project_guard(tmp_path):
    with pytest.raises(RuntimeError): extract('/bin/false', tmp_path, tmp_path)


@pytest.mark.parametrize('wrapped', [False, True])
def test_cli_response_forms(wrapped):
    value = snapshot()
    envelope = {'rows': [value]} if wrapped else [value]
    assert parse_source_response(envelope) == value
    # Neither CLI form bypasses source completeness/reconciliation checks.
    value['tables'][0]['count'] += 1
    with pytest.raises(ValueError): parse_source_response(envelope)


@pytest.mark.parametrize('envelope', [None, 'text', {}, [], [None],
                                      [{'type': 'text', 'text': 'not a snapshot'}],
                                      {'rows': [{}, {}]}, {'rows': 'invalid'}])
def test_bad_cli_response_rejected(envelope):
    with pytest.raises(ValueError): parse_source_response(envelope)


def test_storage_missing_never_falls_back(tmp_path):
    w = Warehouse(Settings(tmp_path))
    with pytest.raises(RuntimeError): publish(w, snapshot())
    assert not (tmp_path / 'raw').exists()


def test_mid_publication_failure_rolls_back_all_tables(warehouse, tmp_path):
    from sme_platform.supabase_sync import VERSION
    good = snapshot(); publish(warehouse, good)
    bad = snapshot(2)
    first = bad['tables'][0]
    row = json.loads(first['records'][0]); row['customer_name'] = 'Updated'; first['records'] = [json.dumps(row)]
    # Interfere with a later raw path after the first table has been processed.
    later = warehouse.root / 'raw' / TENANT / 'supabase' / VERSION / 'suppliers'
    for child in later.iterdir(): child.unlink()
    later.rmdir(); later.symlink_to(tmp_path, target_is_directory=True)
    with pytest.raises(ValueError): publish(warehouse, bad)
    with warehouse.lock(write=False), warehouse.connect(read_only=True) as con:
        assert con.execute('select count(*) from meta_supabase_sync_runs').fetchone()[0] == 1
        saved = con.execute("select payload from bronze.supabase_current where source_table='mini_crm_customers'").fetchone()[0]
        assert json.loads(saved)['customer_name'] is None


def test_realistic_ledger_volume_with_512mb_limit(warehouse):
    value = snapshot()
    table = next(t for t in value['tables'] if t['name'] == 'revenue_ledger_lines')
    row = json.loads(table['records'][0])
    table['records'] = [json.dumps({**row, 'id': 'ledger-' + str(i)}) for i in range(10000)]
    table['count'] = 10000; table['total'] = '120000'
    result = publish(warehouse, value)
    assert result['tables']['revenue_ledger_lines']['records'] == 10000


def set_row(value, name, **fields):
    table = next(t for t in value['tables'] if t['name'] == name)
    row = json.loads(table['records'][0]); row.update(fields)
    table['records'][0] = json.dumps(row, ensure_ascii=False)


@pytest.mark.parametrize('price', [None, 6500, '6500.12500', 0, -1])
def test_r2a_price_no_fallback(warehouse, price):
    value = snapshot(); set_row(value, 'product_skus', selling_price=price, unit_price=999)
    result = publish(warehouse, value)
    raw = (warehouse.root / result['tables']['product_skus']['raw_path']).read_text()
    assert json.loads(raw)['selling_price'] == price


@pytest.mark.parametrize('price', ['', 'invalid', 'NaN', 'Infinity', True, {}, []])
def test_r2a_invalid_price_retains_publication(warehouse, price):
    result = publish(warehouse, snapshot())
    bad = snapshot(1); set_row(bad, 'product_skus', selling_price=price)
    with pytest.raises(ValueError, match='selling price'): publish(warehouse, bad)
    assert json.loads((warehouse.root / 'logs/supabase-sync-latest.json').read_text())['run_id'] == result['run_id']


@pytest.mark.parametrize('name', [None, '', 'Đại lý A'])
def test_r2a_route_scalar(name):
    value = snapshot(); set_row(value, 'dealer_order_items', route_customer_name=name)
    validate(value)


@pytest.mark.parametrize('name', [False, 12, [], {}])
def test_r2a_invalid_route(name):
    value = snapshot(); set_row(value, 'dealer_order_items', route_customer_name=name)
    with pytest.raises(ValueError, match='route name'): validate(value)


def test_r2a_precision_replay_and_route_history(warehouse):
    value = snapshot()
    table = next(t for t in value['tables'] if t['name'] == 'product_skus')
    table['records'][0] = table['records'][0].replace('"selling_price": null', '"selling_price": 1234567890123456.12345')
    set_row(value, 'dealer_order_items', route_customer_name='Đại lý A', route_customer_id='route-a')
    first = publish(warehouse, value)
    assert '1234567890123456.12345' in (warehouse.root / first['tables']['product_skus']['raw_path']).read_text()
    repeated = copy.deepcopy(value); repeated['observed_at'] = snapshot(1)['observed_at']
    again = publish(warehouse, repeated)
    assert sum(t['updated'] + t['inserted'] + t['absent'] for t in again['tables'].values()) == 0
    changed = copy.deepcopy(value); changed['observed_at'] = snapshot(2)['observed_at']
    set_row(changed, 'dealer_order_items', route_customer_name='Tên snapshot sửa')
    last = publish(warehouse, changed)
    assert last['tables']['dealer_order_items']['updated'] == 1
    assert last['tables']['product_skus']['updated'] == 0
    assert 'Đại lý A' in (warehouse.root / first['tables']['dealer_order_items']['raw_path']).read_text()


def test_r2a_projection_contract():
    from sme_platform.supabase_sync import VERSION
    assert VERSION == 'bmq-supabase-raw-v10'
    sql = query_sql()
    assert "cost_values->'selling_price' AS selling_price" in sql
    assert '"cost_values"' not in sql and 'route_note' not in sql
    assert '"route_customer_name"' in sql and 'customer_snapshot' not in sql
