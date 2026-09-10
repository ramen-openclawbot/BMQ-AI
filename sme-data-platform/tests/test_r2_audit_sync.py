"""Audit source replication must not infer order/payment business states."""
import copy
from datetime import datetime, timedelta, timezone
import json

import pytest

from sme_platform.config import Settings
from sme_platform.warehouse import Warehouse
from sme_platform.supabase_sync import FIELDS, TOTALS, VERSION, publish, query_sql

CANCEL = 'dealer_order_cancellation_events'
CONFIRM = 'dealer_customer_order_confirmations'


def snapshot(offset=0):
    return {'database': 'postgres',
            'observed_at': (datetime.now(timezone.utc) + timedelta(seconds=offset)).isoformat(),
            'tables': [{'name': name, 'records': [], 'count': 0,
                        'total': '0' if name in TOTALS else None} for name in FIELDS]}


def put(value, name, **fields):
    table = next(t for t in value['tables'] if t['name'] == name)
    row = dict.fromkeys(FIELDS[name].split())
    row.update(fields)
    table['records'].append(json.dumps(row))
    table['count'] += 1


@pytest.fixture
def warehouse(tmp_path):
    result = Warehouse(Settings(tmp_path / 'data', test_mode=True))
    result.initialize()
    return result


def test_audit_exact_projection_and_v4_fields_preserved():
    assert VERSION == 'bmq-supabase-raw-v8'
    assert FIELDS[CANCEL].split() == ['id', 'order_id', 'customer_id', 'source', 'previous_status', 'created_at']
    assert FIELDS[CONFIRM].split() == ['id', 'order_id', 'channel', 'status', 'sent_at', 'created_at', 'updated_at']
    sql = query_sql()
    for forbidden in ['contact_id', 'session_id', 'provider_response', 'last_error', 'metadata', 'template_key']:
        assert forbidden not in sql
    assert "cost_values->'selling_price' AS selling_price" in sql
    assert '"route_customer_name"' in sql
    assert 'REPEATABLE READ READ ONLY' in sql


def test_missing_cancel_event_and_sent_confirmation_do_not_rewrite_order(warehouse):
    value = snapshot()
    put(value, 'dealer_orders', id='o1', status='cancelled', is_test=False, total_amount_vnd=0)
    put(value, CONFIRM, id='c1', order_id='o1', channel='zalo_zbs', status='sent', sent_at='2026-09-09T12:00:00Z')
    report = publish(warehouse, value)
    assert report['tables'][CANCEL]['records'] == 0
    with warehouse.connect(read_only=True) as con:
        order = json.loads(con.execute("SELECT payload FROM bronze.supabase_current WHERE source_table='dealer_orders'").fetchone()[0])
        assert order['status'] == 'cancelled'
        assert 'paid' not in order and 'approved' not in order
        assert con.execute('SELECT count(*) FROM silver.orders').fetchone()[0] == 0
    saved = warehouse.root / report['tables'][CONFIRM]['raw_path']
    assert json.loads(saved.read_text())['status'] == 'sent'


def test_audit_replay_update_and_cascade_absence_preserve_raw(warehouse):
    first = snapshot()
    put(first, CANCEL, id='e1', order_id='o1', customer_id='cust1', source='dealer_portal', previous_status='submitted')
    put(first, CONFIRM, id='c1', order_id='o1', channel='zalo_zbs', status='pending')
    one = publish(warehouse, first)
    repeated = copy.deepcopy(first)
    repeated['observed_at'] = snapshot(1)['observed_at']
    two = publish(warehouse, repeated)
    assert all(t['inserted'] + t['updated'] + t['absent'] == 0 for t in two['tables'].values())
    changed = copy.deepcopy(first)
    changed['observed_at'] = snapshot(2)['observed_at']
    table = next(t for t in changed['tables'] if t['name'] == CONFIRM)
    row = json.loads(table['records'][0]); row['status'] = 'sent'
    table['records'] = [json.dumps(row)]
    assert publish(warehouse, changed)['tables'][CONFIRM]['updated'] == 1
    # A later complete scan can observe a cascaded outbox deletion. This is an
    # absence observation, not evidence of cancellation at a known time.
    removed = copy.deepcopy(changed)
    removed['observed_at'] = snapshot(3)['observed_at']
    next(t for t in removed['tables'] if t['name'] == CONFIRM).update(records=[], count=0)
    assert publish(warehouse, removed)['tables'][CONFIRM]['absent'] == 1
    assert json.loads((warehouse.root / one['tables'][CONFIRM]['raw_path']).read_text())['status'] == 'pending'
    with warehouse.connect(read_only=True) as con:
        assert con.execute("SELECT count(*) FROM bronze.supabase_current WHERE source_table=?", [CANCEL]).fetchone()[0] == 1


@pytest.mark.parametrize('fault', ['missing_table', 'truncated', 'extra_contact'])
def test_bad_audit_snapshot_cannot_publish_or_delete(warehouse, fault):
    first = snapshot()
    put(first, CONFIRM, id='c1', order_id='o1', status='pending')
    publish(warehouse, first)
    bad = copy.deepcopy(first)
    bad['observed_at'] = snapshot(1)['observed_at']
    table = next(t for t in bad['tables'] if t['name'] == CONFIRM)
    if fault == 'missing_table':
        bad['tables'].remove(table)
    elif fault == 'truncated':
        table['records'] = []
    else:
        row = json.loads(table['records'][0]); row['contact_id'] = 'not-allowed'
        table['records'] = [json.dumps(row)]
    with pytest.raises(ValueError):
        publish(warehouse, bad)
    with warehouse.connect(read_only=True) as con:
        assert con.execute('SELECT count(*) FROM meta_supabase_sync_runs').fetchone()[0] == 1
        assert con.execute("SELECT count(*) FROM bronze.supabase_current WHERE source_table=?", [CONFIRM]).fetchone()[0] == 1
