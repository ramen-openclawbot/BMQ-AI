import copy
from datetime import datetime, timedelta, timezone
import json
from pathlib import Path

import pytest
from sme_platform.config import Settings
from sme_platform.warehouse import Warehouse
from sme_platform.supabase_sync import FIELDS, KEYS, TOTALS, TENANT, extract, publish, query_sql, validate


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
