"""Finance transport must preserve unresolved facts without certifying settlement."""
import copy
import json
from decimal import Decimal

import pytest

from sme_platform.supabase_sync import FIELDS, publish, query_sql
from test_r2_audit_sync import snapshot, put, warehouse

FINANCE = {'payments', 'invoices', 'invoice_items', 'payment_request_items',
           'customer_debt_period_adjustments', 'ceo_daily_closing_declarations',
           'daily_reconciliations', 'finance_daily_close_runs',
           'finance_payment_auto_approval_matches'}


def set_total(value, name, total):
    next(t for t in value['tables'] if t['name'] == name)['total'] = total


def test_finance_allowlist_excludes_sensitive_unstructured_fields():
    assert FINANCE <= FIELDS.keys()
    for name in FINANCE:
        assert not set(FIELDS[name].split()) & {
            'notes', 'bank_account', 'bank_account_number', 'bank_reference',
            'extraction_meta', 'raw_payload', 'image_url', 'file_url', 'created_by',
            'approved_by', 'evidence_payload', 'error_message', 'metadata'}
    assert 'REPEATABLE READ READ ONLY' in query_sql()


def test_missing_then_explicit_zero_adjustment_are_distinct(warehouse):
    first = snapshot()
    report = publish(warehouse, first)
    assert report['tables']['customer_debt_period_adjustments']['records'] == 0
    assert (warehouse.root / report['tables']['customer_debt_period_adjustments']['raw_path']).read_bytes() == b''
    second = snapshot(1)
    put(second, 'customer_debt_period_adjustments', id='a1', customer_id='c1',
        period_from='2026-09-01', period_to='2026-09-30', opening_balance_vnd=0,
        amount_collected_vnd=None, payment_due_date=None)
    published = publish(warehouse, second)
    row = json.loads((warehouse.root / published['tables']['customer_debt_period_adjustments']['raw_path']).read_text())
    assert row['opening_balance_vnd'] == 0
    assert row['amount_collected_vnd'] is None
    assert row['period_to'] == '2026-09-30'
    assert row['payment_due_date'] is None
    assert 'closing_balance' not in row


def test_legacy_gap_future_date_and_close_attempt_remain_evidence(warehouse):
    first = snapshot()
    put(first, 'payments', id='p1', payment_number='PAY-LEGACY-PR-000001',
        supplier_id='s1', payment_date='2099-10-08', amount='0.1000000001')
    set_total(first, 'payments', '0.1000000001')
    put(first, 'payment_allocations', id='alloc1', payment_id='p1', payment_request_id='r1', amount='49.5775720001')
    set_total(first, 'payment_allocations', '49.5775720001')
    put(first, 'finance_daily_close_runs', id='run1', mode='shadow', status='blocked', approved_count=0)
    put(first, 'finance_payment_auto_approval_matches', id='m1', run_id='run1', payment_request_id='r1', match_status='matched')
    report = publish(warehouse, first)
    raw = warehouse.root / report['tables']['payments']['raw_path']
    row = json.loads(raw.read_text(), parse_float=Decimal)
    assert Decimal(row['amount']) == Decimal('0.1000000001')
    assert row['payment_date'] == '2099-10-08'
    assert report['tables']['payments']['records'] == 1
    with warehouse.connect(read_only=True) as con:
        assert con.execute('SELECT count(*) FROM silver.payments').fetchone()[0] == 0
    replay = copy.deepcopy(first)
    replay['observed_at'] = snapshot(1)['observed_at']
    again = publish(warehouse, replay)
    assert all(t['inserted'] + t['updated'] + t['absent'] == 0 for t in again['tables'].values())
    assert raw.is_file()


@pytest.mark.parametrize('fault', ['total', 'missing', 'extra'])
def test_finance_transport_fault_retains_previous_publication(warehouse, fault):
    first = snapshot()
    publish(warehouse, first)
    bad = snapshot(1)
    put(bad, 'payments', id='p1', amount='12.30')
    set_total(bad, 'payments', '12.30')
    table = next(t for t in bad['tables'] if t['name'] == 'payments')
    if fault == 'total':
        table['total'] = '12.31'
    elif fault == 'missing':
        bad['tables'].remove(table)
    else:
        row = json.loads(table['records'][0]); row['bank_reference'] = 'excluded'
        table['records'][0] = json.dumps(row)
    with pytest.raises(ValueError):
        publish(warehouse, bad)
    with warehouse.connect(read_only=True) as con:
        assert con.execute('SELECT count(*) FROM meta_supabase_sync_runs').fetchone()[0] == 1
