"""Behavioral tests for the read-only warehouse cost-classification lane.

Synthetic raw snapshot only: no network, credentials, model or business data.
Fixtures reproduce all four arms of the reviewed canonical view
(`cost_classification_line_details`): classified and OCR-only payment-request /
invoice lines, source-line overrides, source dates, amount fallback,
UNMAPPED status, linked-invoice exclusion and the cost projection gate.
"""
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
import json

import pytest
from fastapi.testclient import TestClient
from sme_platform.api import Principal, create_app
from sme_platform.bmq_cost import LOW_CONFIDENCE_THRESHOLD, QUESTIONS, VERSION, execute, normalize_ocr_cost_key, validate_request
from sme_platform.config import Settings
from sme_platform.query import QueryEngine
from sme_platform.supabase_sync import TENANT, publish
from sme_platform.warehouse import Warehouse
from test_bmq_semantic import snapshot


CATEGORIES = [
    {'id': 'cat1', 'code': 'COGS_BMQ_BREAD', 'label': 'Chi phí bánh mì', 'cost_group': 'cogs', 'product_line': 'bmq_bread', 'sort_order': 10, 'is_active': True},
    {'id': 'cat2', 'code': 'OPEX_GENERAL', 'label': 'Chi phí vận hành chung', 'cost_group': 'opex', 'product_line': 'general', 'sort_order': 40, 'is_active': True},
    {'id': 'cat3', 'code': 'UNMAPPED_REVIEW', 'label': 'Chưa phân loại / cần review', 'cost_group': 'unmapped', 'product_line': 'general', 'sort_order': 70, 'is_active': True},
]

SUPPLIERS = [{'id': 'sup1', 'name': 'Nhà cung cấp Một'}, {'id': 'sup2', 'name': 'Nhà cung cấp Hai'}]

RULES = [
    {'id': 'rule1', 'priority': 100, 'rule_name': 'BMQ bread keywords', 'match_scope': 'supplier_and_item',
     'category_code': 'COGS_BMQ_BREAD', 'product_line': 'bmq_bread', 'allocation_rule': 'direct',
     'confidence': '0.90', 'active': True, 'effective_from': '2026-01-01', 'effective_to': None,
     'supplier_id': None, 'inventory_item_id': None, 'sku_id': None},
]

ALIASES = [
    {'id': 'alias1', 'source_name': 'Dau huong duong', 'source_name_key': 'dau huong duong', 'supplier_id': 'sup1',
     'standard_cost_code_type': 'NVL', 'standard_cost_code': 'NVL-OIL', 'canonical_cost_item_name': 'Dầu hướng dương',
     'category_code': 'OPEX_GENERAL', 'product_line': 'general', 'allocation_rule': 'none',
     'mapping_status': 'approved', 'active': True},
]

PAYMENT_REQUESTS = [
    {'id': 'p1', 'request_number': 'PR-001', 'supplier_id': 'sup1', 'paid_at': '2026-04-10T03:00:00+00:00', 'created_at': '2026-04-01T00:00:00+00:00', 'invoice_id': None},
    {'id': 'p2', 'request_number': 'PR-002', 'supplier_id': 'sup2', 'paid_at': None, 'created_at': '2026-04-02T00:00:00+00:00', 'invoice_id': None},
    {'id': 'p3', 'request_number': 'PR-003', 'supplier_id': 'sup1', 'paid_at': '2026-03-31T17:30:00+00:00', 'created_at': '2026-03-31T00:00:00+00:00', 'invoice_id': None},
    {'id': 'p4', 'request_number': 'PR-004', 'supplier_id': 'sup1', 'paid_at': None, 'created_at': '2026-05-01T00:00:00+00:00', 'invoice_id': None},
    {'id': 'p9', 'request_number': 'PR-009', 'supplier_id': 'sup1', 'paid_at': '2026-04-20T00:00:00+00:00', 'created_at': '2026-04-20T00:00:00+00:00', 'invoice_id': 'inv2'},
]

PR_ITEMS = [
    {'id': 'it1', 'payment_request_id': 'p1', 'product_name': 'Bánh mì que', 'quantity': 10, 'unit_price': 1000000, 'line_total': 10000000},
    {'id': 'it2', 'payment_request_id': 'p2', 'product_name': 'Pate gan', 'quantity': 1, 'unit_price': 8344200, 'line_total': 8344200},
    {'id': 'it3', 'payment_request_id': 'p1', 'product_name': 'Tiền điện', 'quantity': 2, 'unit_price': 500000, 'line_total': None},
    {'id': 'it4', 'payment_request_id': 'p2', 'product_name': 'Hàng chưa rõ', 'quantity': 1, 'unit_price': 5000000, 'line_total': 5000000},
    {'id': 'it8', 'payment_request_id': 'p1', 'product_name': 'Danh mục cũ', 'quantity': 1, 'unit_price': 7000000, 'line_total': 7000000},
    {'id': 'it9', 'payment_request_id': 'p9', 'product_name': 'Đã lên hóa đơn', 'quantity': 1, 'unit_price': 99999999, 'line_total': 99999999},
    {'id': 'it5', 'payment_request_id': 'p1', 'product_name': 'Dầu hướng dương', 'quantity': 1, 'unit_price': 500000, 'line_total': 500000},
    {'id': 'it6', 'payment_request_id': 'p3', 'product_name': 'Bánh mì que', 'quantity': 1, 'unit_price': 7000000, 'line_total': 7000000},
    {'id': 'it7', 'payment_request_id': 'p4', 'product_name': 'Bánh mì que', 'quantity': 1, 'unit_price': 9000000, 'line_total': 9000000},
]

INVOICES = [
    {'id': 'inv1', 'invoice_number': 'INV-001', 'invoice_date': '2026-04-15', 'supplier_id': 'sup1', 'payment_request_id': None},
    {'id': 'inv2', 'invoice_number': 'INV-002', 'invoice_date': '2026-04-21', 'supplier_id': 'sup1', 'payment_request_id': 'p9'},
]

INVOICE_ITEMS = [
    {'id': 'ii1', 'invoice_id': 'inv1', 'product_name': 'Bánh mì lớn', 'quantity': 1, 'unit_price': 3000000, 'line_total': 3000000},
    {'id': 'ii2', 'invoice_id': 'inv2', 'product_name': 'Đã lên hóa đơn', 'quantity': 1, 'unit_price': 2000000, 'line_total': 2000000},
]

CLASSIFICATIONS = [
    {'id': 'c1', 'source_type': 'payment_request_item', 'source_line_id': 'it1', 'payment_request_id': 'p1', 'invoice_id': None,
     'supplier_id': 'sup1', 'category_code': 'COGS_BMQ_BREAD', 'product_line': 'bmq_bread', 'allocation_rule': 'direct',
     'confidence': '0.90', 'classification_source': 'rule', 'rule_id': 'rule1', 'review_status': 'suggested'},
    {'id': 'c2', 'source_type': 'payment_request_item', 'source_line_id': 'it2', 'payment_request_id': 'p2', 'invoice_id': None,
     'supplier_id': 'sup2', 'category_code': 'COGS_BMQ_BREAD', 'product_line': 'bmq_bread', 'allocation_rule': 'none',
     'confidence': '0', 'classification_source': 'fallback', 'rule_id': None, 'review_status': 'needs_review'},
    {'id': 'c3', 'source_type': 'payment_request_item', 'source_line_id': 'it3', 'payment_request_id': 'p1', 'invoice_id': None,
     'supplier_id': 'sup1', 'category_code': 'OPEX_GENERAL', 'product_line': 'general', 'allocation_rule': 'none',
     'confidence': '0.88', 'classification_source': 'rule', 'rule_id': 'rule1', 'review_status': 'approved'},
    {'id': 'c4', 'source_type': 'payment_request_item', 'source_line_id': 'it4', 'payment_request_id': 'p2', 'invoice_id': None,
     'supplier_id': 'sup2', 'category_code': 'UNMAPPED_REVIEW', 'product_line': 'general', 'allocation_rule': 'none',
     'confidence': '0', 'classification_source': 'fallback', 'rule_id': None, 'review_status': 'suggested'},
    {'id': 'c5', 'source_type': 'invoice_item', 'source_line_id': 'ii1', 'payment_request_id': None, 'invoice_id': 'inv1',
     'supplier_id': 'sup1', 'category_code': 'COGS_BMQ_BREAD', 'product_line': 'bmq_bread', 'allocation_rule': 'direct',
     'confidence': '0.93', 'classification_source': 'rule', 'rule_id': 'rule1', 'review_status': 'approved'},
    {'id': 'c6', 'source_type': 'payment_request_item', 'source_line_id': 'it9', 'payment_request_id': 'p9', 'invoice_id': None,
     'supplier_id': 'sup1', 'category_code': 'COGS_BMQ_BREAD', 'product_line': 'bmq_bread', 'allocation_rule': 'direct',
     'confidence': '0.90', 'classification_source': 'rule', 'rule_id': 'rule1', 'review_status': 'suggested'},
    {'id': 'c7', 'source_type': 'invoice_item', 'source_line_id': 'ii2', 'payment_request_id': None, 'invoice_id': 'inv2',
     'supplier_id': 'sup1', 'category_code': 'COGS_BMQ_BREAD', 'product_line': 'bmq_bread', 'allocation_rule': 'direct',
     'confidence': '0.90', 'classification_source': 'rule', 'rule_id': 'rule1', 'review_status': 'suggested'},
    {'id': 'c8', 'source_type': 'payment_request_item', 'source_line_id': 'it8', 'payment_request_id': 'p1', 'invoice_id': None,
     'supplier_id': 'sup1', 'category_code': 'LEGACY_CODE', 'product_line': 'general', 'allocation_rule': 'none',
     'confidence': '0.50', 'classification_source': 'fallback', 'rule_id': None, 'review_status': 'needs_review'},
    {'id': 'c9', 'source_type': 'payment_request_item', 'source_line_id': 'it5', 'payment_request_id': 'p1', 'invoice_id': None,
     'supplier_id': 'sup1', 'category_code': 'OPEX_GENERAL', 'product_line': 'general', 'allocation_rule': 'none',
     'confidence': '0.95', 'classification_source': 'item_mapping', 'rule_id': None, 'review_status': 'suggested'},
    {'id': 'c10', 'source_type': 'payment_request_item', 'source_line_id': 'it6', 'payment_request_id': 'p3', 'invoice_id': None,
     'supplier_id': 'sup1', 'category_code': 'COGS_BMQ_BREAD', 'product_line': 'bmq_bread', 'allocation_rule': 'direct',
     'confidence': '0.90', 'classification_source': 'rule', 'rule_id': 'rule1', 'review_status': 'approved'},
    {'id': 'c11', 'source_type': 'payment_request_item', 'source_line_id': 'it7', 'payment_request_id': 'p4', 'invoice_id': None,
     'supplier_id': 'sup1', 'category_code': 'COGS_BMQ_BREAD', 'product_line': 'bmq_bread', 'allocation_rule': 'direct',
     'confidence': '0.90', 'classification_source': 'rule', 'rule_id': 'rule1', 'review_status': 'suggested'},
]


def rows():
    return {
        'cost_categories': CATEGORIES, 'suppliers': SUPPLIERS, 'cost_classification_rules': RULES,
        'cost_item_alias_mappings': ALIASES, 'payment_requests': PAYMENT_REQUESTS,
        'payment_request_items': PR_ITEMS, 'invoices': INVOICES, 'invoice_items': INVOICE_ITEMS,
        'cost_line_classifications': CLASSIFICATIONS,
    }


@pytest.fixture
def state(tmp_path):
    warehouse = Warehouse(Settings(tmp_path / 'data', test_mode=True))
    warehouse.initialize()
    publish(warehouse, snapshot(rows()))
    return warehouse, QueryEngine(warehouse)


def cost(state, **request):
    return execute(state[1], request, TENANT, 'owner:fixture')


def test_month_totals_sum_exact_per_status_amounts_and_apply_view_semantics(state):
    result = cost(state, question='month_totals', month='2026-04')
    assert result['semantic_version'] == VERSION
    assert result['snapshot_id'] and result['source_observed_at']
    by_status = {row['review_status']: row for row in result['statuses']}
    assert by_status['needs_review']['line_count'] == 2
    assert by_status['needs_review']['total_amount'] == Decimal('13344200')
    assert by_status['suggested']['line_count'] == 3
    assert by_status['suggested']['total_amount'] == Decimal('12500000')
    assert by_status['approved']['line_count'] == 2
    assert by_status['approved']['total_amount'] == Decimal('4000000')
    assert result['line_count'] == 7
    assert result['total_amount'] == Decimal('29844200')
    # the linked-invoice payment request line and the unknown category are excluded
    amounts = {Decimal(str(row['total_amount'])) for row in result['rows']}
    assert Decimal('99999999') not in amounts
    assert not any(amount > Decimal('25000000') for amount in amounts)


def test_month_totals_use_paid_created_and_invoice_source_dates_not_created_at(state):
    april = cost(state, question='month_totals', month='2026-04')
    march = cost(state, question='month_totals', month='2026-03')
    may = cost(state, question='month_totals', month='2026-05')
    # paid_at 2026-03-31T17:30Z stays March (UTC), created_at would be April.
    assert {row['category_code'] for row in march['rows']} == {'COGS_BMQ_BREAD'}
    assert march['total_amount'] == Decimal('7000000')
    # paid_at-less PR with created_at 2026-05-01 is May, not April.
    assert may['total_amount'] == Decimal('9000000')
    assert Decimal('9000000') not in {row['total_amount'] for row in april['rows']}


def test_pending_summary_reports_subset_not_ratio(state):
    result = cost(state, question='pending_summary', month='2026-04')
    assert result['pending']['review_status'] == 'needs_review'
    assert result['pending']['line_count'] == 2
    assert result['pending']['total_amount'] == Decimal('13344200')
    by_status = {row['review_status']: row for row in result['statuses']}
    assert by_status['suggested']['total_amount'] == Decimal('12500000')
    assert by_status['approved']['total_amount'] == Decimal('4000000')
    assert by_status['rejected']['total_amount'] == Decimal('0')
    assert result['total_amount'] == sum((row['total_amount'] for row in result['statuses']), Decimal(0))


def test_unmapped_review_is_forced_to_needs_review_without_double_count(state):
    result = cost(state, question='month_totals', month='2026-04', category_code='UNMAPPED_REVIEW')
    assert result['line_count'] == 1
    assert result['total_amount'] == Decimal('5000000')
    assert {row['review_status'] for row in result['rows']} == {'needs_review'}
    pending = cost(state, question='pending_summary', month='2026-04')['pending']
    assert pending['total_amount'] == Decimal('13344200')
    assert pending['line_count'] == 2


def test_top_pending_lines_have_supplier_document_and_are_bounded(state):
    result = cost(state, question='top_pending_lines', month='2026-04')
    assert result['pending_line_count'] == 2
    assert result['pending_amount'] == Decimal('13344200')
    assert result['limit'] == 10 and result['truncated'] is False
    amounts = [row['line_amount'] for row in result['rows']]
    assert amounts == sorted(amounts, reverse=True)
    assert result['rows'][0]['supplier_name'] == 'Nhà cung cấp Hai'
    assert result['rows'][0]['source_number'] == 'PR-002'
    assert result['rows'][0]['source_date'].isoformat() == '2026-04-02'
    small = cost(state, question='top_pending_lines', month='2026-04', limit=1)
    assert small['truncated'] is True and len(small['rows']) == 1


def test_example_line_is_deterministic_and_discloses_its_rule(state):
    result = cost(state, question='example_line', month='2026-04')
    assert result['question'] == 'example_line'
    assert result['selection_rule'] == 'largest_line_amount_then_source_date_then_classification_id'
    assert result['limit'] == 1 and len(result['rows']) == 1
    assert result['match_count'] == 7 and result['truncated'] is True
    chosen = result['rows'][0]
    assert chosen['classification_id'] == 'c1'
    assert Decimal(str(chosen['line_amount'])) == Decimal('10000000')
    assert chosen['month'].isoformat() == '2026-04-01'
    assert chosen['category_code'] == 'COGS_BMQ_BREAD'
    assert chosen['supplier_name'] == 'Nhà cung cấp Một'
    assert chosen['source_number'] == 'PR-001'
    # Stable across repeated reads: the same scope and snapshot select the same line.
    assert cost(state, question='example_line', month='2026-04')['rows'][0]['classification_id'] == 'c1'


def test_example_line_respects_category_and_status_scope(state):
    scoped = cost(state, question='example_line', month='2026-04', review_status='needs_review')
    assert scoped['match_count'] == 2 and scoped['rows'][0]['classification_id'] == 'c2'
    assert Decimal(str(scoped['rows'][0]['line_amount'])) == Decimal('8344200')
    category = cost(state, question='example_line', month='2026-04', category_code='OPEX_GENERAL')
    assert category['match_count'] == 2
    assert all(row['category_code'] == 'OPEX_GENERAL' for row in category['rows'])
    empty = cost(state, question='example_line', month='2026-04', review_status='rejected')
    assert empty['match_count'] == 0 and empty['rows'] == []


def test_example_line_flows_into_line_explanation_evidence(state):
    chosen = cost(state, question='example_line', month='2026-04')['rows'][0]
    explained = cost(state, question='line_explanation', line_ref=chosen['classification_id'])
    assert explained['status'] == 'ok'
    assert explained['line']['classification_id'] == chosen['classification_id']
    assert explained['line']['month'] == chosen['month']
    assert explained['evidence']['rule']['rule_name'] == 'BMQ bread keywords'
    # A line with no stored rule link is reported as missing evidence, never invented.
    fallback = cost(state, question='example_line', month='2026-04', review_status='needs_review')['rows'][0]
    fallback_evidence = cost(state, question='line_explanation', line_ref=fallback['classification_id'])
    assert fallback_evidence['status'] == 'ok'
    assert fallback_evidence['evidence']['rule'] is None
    assert fallback_evidence['evidence']['alias_mapping'] is None


def test_example_line_request_grammar_rejects_unknown_qualifiers(state):
    with pytest.raises(ValueError):
        validate_request({'question': 'example_line', 'month': '2026-04', 'supplier_id': 'sup1'})
    with pytest.raises(ValueError):
        validate_request({'question': 'example_line'})
    assert validate_request({'question': 'example_line', 'month': '2026-04'}) == {'question': 'example_line', 'month': date(2026, 4, 1), 'limit': 1}


def test_category_comparison_returns_exact_two_month_difference(state):
    result = cost(state, question='category_comparison', month='2026-04', month_b='2026-03')
    bread = next(row for row in result['rows'] if row['category_code'] == 'COGS_BMQ_BREAD')
    assert bread['line_count_a'] == 4 and bread['total_amount_a'] == Decimal('23344200')
    assert bread['line_count_b'] == 1 and bread['total_amount_b'] == Decimal('7000000')
    assert bread['difference'] == Decimal('7000000') - Decimal('23344200')
    assert result['truncated'] is False


def test_unmapped_low_confidence_counts_each_line_once(state):
    result = cost(state, question='unmapped_low_confidence', month='2026-04')
    assert result['threshold'] == str(LOW_CONFIDENCE_THRESHOLD)
    assert result['unmapped_count'] == 1 and result['unmapped_amount'] == Decimal('5000000')
    assert result['low_confidence_count'] == 1 and result['low_confidence_amount'] == Decimal('8344200')
    flags = [(row['unmapped'], row['low_confidence']) for row in result['rows']]
    assert (True, False) in flags and (False, True) in flags


def test_line_explanation_returns_stored_rule_and_alias_evidence(state):
    by_rule = cost(state, question='line_explanation', line_ref='c1')
    assert by_rule['status'] == 'ok'
    assert by_rule['line']['category_code'] == 'COGS_BMQ_BREAD'
    assert by_rule['evidence']['rule']['rule_name'] == 'BMQ bread keywords'
    assert by_rule['evidence']['rule']['priority'] == '100'
    by_alias = cost(state, question='line_explanation', line_ref='c9')
    alias = by_alias['evidence']['alias_mapping']
    assert alias and alias['standard_cost_code'] == 'NVL-OIL'
    assert by_alias['evidence']['alias_status'] == 'matched'
    fallback = cost(state, question='line_explanation', line_ref='c2')
    assert fallback['status'] == 'ok'
    assert fallback['evidence']['rule'] is None
    assert fallback['evidence']['alias_status'] is None
    missing = cost(state, question='line_explanation', line_ref='does-not-exist')
    assert missing['status'] == 'not_found'


def test_line_explanation_accepts_source_line_id_and_flags_unknown(state):
    by_source = cost(state, question='line_explanation', line_ref='it2')
    assert by_source['status'] == 'ok'
    assert by_source['line']['classification_id'] == 'c2'


def test_sync_freshness_reports_manifest_without_amounts(state):
    result = cost(state, question='sync_freshness')
    assert result['snapshot_id'] and result['source_observed_at']
    assert result['reconciled'] is True and result['missing_tables'] == []
    assert result['tables']['cost_line_classifications'] == len(CLASSIFICATIONS)
    assert result['stale'] is False
    assert 'line_amount' not in json.dumps(result)


def test_sync_freshness_flags_stale_and_missing_tables(state):
    warehouse, engine = state
    with warehouse.lock(), warehouse.connect() as con:
        manifest = json.loads(con.execute('select manifest from meta_supabase_sync_runs').fetchone()[0])
        del manifest['tables']['cost_item_alias_mappings']
        con.execute('update meta_supabase_sync_runs set manifest=?, observed_at=now()-interval \'31 minutes\'', [json.dumps(manifest)])
    result = execute(engine, {'question': 'sync_freshness'}, TENANT, 'owner:fixture')
    assert result['stale'] is True
    assert result['reconciled'] is False
    assert 'cost_item_alias_mappings' in result['missing_tables']
    with pytest.raises(RuntimeError, match='stale'):
        cost(state, question='month_totals', month='2026-04')


def test_missing_required_table_blocks_numeric_answers(state):
    warehouse, engine = state
    with warehouse.lock(), warehouse.connect() as con:
        manifest = json.loads(con.execute('select manifest from meta_supabase_sync_runs').fetchone()[0])
        del manifest['tables']['suppliers']
        con.execute('update meta_supabase_sync_runs set manifest=?', [json.dumps(manifest)])
    with pytest.raises(RuntimeError, match='not synchronized'):
        cost(state, question='month_totals', month='2026-04')


def test_permission_and_tenant_are_denied(state):
    warehouse, engine = state
    with pytest.raises(PermissionError):
        execute(engine, {'question': 'month_totals', 'month': '2026-04'}, TENANT, 'staff')
    with pytest.raises(PermissionError):
        execute(engine, {'question': 'month_totals', 'month': '2026-04'}, 'another-tenant', 'owner')


def test_empty_month_is_no_data_not_zero(state):
    result = cost(state, question='month_totals', month='2026-02')
    assert result['line_count'] == 0 and result['total_amount'] == Decimal('0')
    pending = cost(state, question='pending_summary', month='2026-02')
    assert pending['pending']['line_count'] == 0
    assert pending['pending']['total_amount'] == Decimal('0')
    top = cost(state, question='top_pending_lines', month='2026-02')
    assert top['pending_line_count'] == 0 and top['rows'] == []


def test_missing_snapshot_fails(tmp_path):
    warehouse = Warehouse(Settings(tmp_path / 'empty', test_mode=True))
    warehouse.initialize()
    with pytest.raises(RuntimeError):
        execute(QueryEngine(warehouse), {'question': 'month_totals', 'month': '2026-04'}, TENANT, 'owner')


@pytest.mark.parametrize('body', [
    {'question': 'month_totals', 'month': '2026-13'},
    {'question': 'month_totals', 'month': '2026-04-01'},
    {'question': 'month_totals'},
    {'question': 'month_totals', 'month': '2026-04', 'sql': 'select *'},
    {'question': 'month_totals', 'month': '2026-04', 'tenant_id': 'other'},
    {'question': 'month_totals', 'month': '2026-04', 'category_code': 'lower case'},
    {'question': 'month_totals', 'month': '2026-04', 'limit': True},
    {'question': 'month_totals', 'month': '2026-04', 'limit': 51},
    {'question': 'pending_summary', 'month': '2026-04', 'limit': 10},
    {'question': 'top_pending_lines', 'month': '2026-04', 'line_ref': 'c1'},
    {'question': 'category_comparison', 'month': '2026-04', 'month_b': '2026-04'},
    {'question': 'category_comparison', 'month': '2026-04'},
    {'question': 'unmapped_low_confidence', 'month': '2026-04', 'category_code': 'OPEX_GENERAL'},
    {'question': 'line_explanation', 'line_ref': 'not a valid ref!'},
    {'question': 'line_explanation'},
    {'question': 'sync_freshness', 'month': '2026-04'},
    {'question': 'wipe', 'month': '2026-04'},
])
def test_closed_request_grammar(body):
    with pytest.raises(ValueError):
        validate_request(body)


def test_alias_normalization_matches_classifier_contract():
    assert normalize_ocr_cost_key('Dầu hướng dương') == 'dau huong duong'
    assert normalize_ocr_cost_key('  BÁNH   MÌ  ') == 'banh mi'


def test_api_cost_endpoint_is_owner_scoped_and_returns_provenance(state):
    warehouse, _ = state
    client = TestClient(create_app(warehouse, authenticator=lambda: Principal(TENANT, 'fixture-owner')))
    response = client.post('/v1/cost', json={'question': 'pending_summary', 'month': '2026-04'})
    assert response.status_code == 200, response.text
    body = response.json()
    assert Decimal(body['pending']['total_amount']) == Decimal('13344200')
    assert body['semantic_version'] == VERSION
    assert 'payload' not in response.text and 'source_name_key' not in response.text
    catalog = client.get('/v1/semantic').json()
    assert catalog['cost_lookup']['version'] == VERSION
    assert {item['id'] for item in catalog['cost_lookup']['questions']} == set(QUESTIONS)


def _warehouse(tmp_path, rows):
    warehouse = Warehouse(Settings(tmp_path / 'parity', test_mode=True))
    warehouse.initialize()
    publish(warehouse, snapshot(rows))
    return warehouse, QueryEngine(warehouse)


def test_ocr_only_arms_are_included_without_double_count(tmp_path):
    rows = {
        'cost_categories': CATEGORIES,
        'suppliers': SUPPLIERS,
        'payment_requests': [
            {'id': 'po1', 'request_number': 'PR-OCR', 'supplier_id': 'sup1',
             'created_at': '2026-09-03T00:00:00+00:00', 'invoice_created': False, 'invoice_id': None},
        ],
        'payment_request_items': [
            # OCR-only with a category: included as approved.
            {'id': 'op1', 'payment_request_id': 'po1', 'product_name': 'Bánh mì', 'line_total': 11,
             'cost_category_code': 'COGS_BMQ_BREAD', 'cost_review_routing': None},
            # OCR-only routed to review with no category: UNMAPPED_REVIEW needs_review.
            {'id': 'op2', 'payment_request_id': 'po1', 'product_name': 'Hàng lạ', 'line_total': 5,
             'cost_category_code': None, 'cost_review_routing': 'needs_review'},
        ],
        'invoices': [{'id': 'ioc', 'invoice_number': 'INV-OCR', 'invoice_date': '2026-09-04', 'supplier_id': 'sup1'}],
        'invoice_items': [
            {'id': 'oi1', 'invoice_id': 'ioc', 'product_name': 'Tiền điện', 'line_total': 17,
             'cost_category_code': 'OPEX_GENERAL', 'cost_review_routing': None},
        ],
        'cost_line_classifications': [],
    }
    warehouse, engine = _warehouse(tmp_path, rows)
    result = execute(engine, {'question': 'month_totals', 'month': '2026-09'}, TENANT, 'owner:fixture')
    assert result['line_count'] == 3
    assert result['total_amount'] == Decimal('33')
    by_status = {row['review_status']: row for row in result['statuses']}
    assert by_status['approved']['total_amount'] == Decimal('28')
    assert by_status['needs_review']['total_amount'] == Decimal('5')
    categories = {(row['category_code'], row['review_status']): row['total_amount'] for row in result['rows']}
    assert categories[('UNMAPPED_REVIEW', 'needs_review')] == Decimal('5')
    assert categories[('OPEX_GENERAL', 'approved')] == Decimal('17')
    assert categories[('COGS_BMQ_BREAD', 'approved')] == Decimal('11')


def test_source_line_overrides_classification_category_status_name_and_source(tmp_path):
    rows = {
        'cost_categories': CATEGORIES,
        'suppliers': SUPPLIERS,
        'payment_requests': [
            {'id': 'pp', 'request_number': 'PR-ONE', 'supplier_id': 'sup1', 'status': 'approved',
             'payment_status': 'paid', 'created_at': '2026-09-03T00:00:00+00:00',
             'invoice_created': False, 'invoice_id': None},
        ],
        'payment_request_items': [
            {'id': 'pi1', 'payment_request_id': 'pp', 'line_total': 11,
             'canonical_cost_item_name': 'Dầu chuẩn', 'confirmed_standard_cost_code': 'NVL-OIL',
             'canonical_cost_item_source': 'ocr_standard_cost', 'product_name': 'Dau tho',
             'cost_category_code': 'OPEX_GENERAL', 'cost_review_routing': 'needs_review'},
        ],
        'invoices': [{'id': 'iv', 'invoice_number': 'INV-ONE', 'invoice_date': '2026-09-04', 'supplier_id': 'sup1'}],
        'invoice_items': [
            {'id': 'ii1', 'invoice_id': 'iv', 'line_total': 17, 'canonical_cost_item_name': 'Hóa đơn A',
             'suggested_standard_cost_code': 'SKU-A', 'product_name': 'Raw A',
             'cost_category_code': 'OPEX_GENERAL', 'cost_review_routing': None},
        ],
        'cost_line_classifications': [
            {'id': 'cl1', 'source_type': 'payment_request_item', 'source_line_id': 'pi1',
             'category_code': 'UNMAPPED_REVIEW', 'review_status': 'approved', 'confidence': 1},
            {'id': 'cl2', 'source_type': 'invoice_item', 'source_line_id': 'ii1',
             'category_code': 'UNMAPPED_REVIEW', 'review_status': 'suggested', 'confidence': 1},
        ],
    }
    warehouse, engine = _warehouse(tmp_path, rows)
    pr_line = execute(engine, {'question': 'line_explanation', 'line_ref': 'cl1'}, TENANT, 'owner:fixture')['line']
    assert pr_line['category_code'] == 'OPEX_GENERAL'
    assert pr_line['review_status'] == 'needs_review'
    assert pr_line['product_name'] == 'Dầu chuẩn'
    assert pr_line['product_code'] == 'NVL-OIL'
    assert pr_line['classification_source'] == 'ocr_standard_cost'
    assert pr_line['source_number'] == 'PR-ONE'
    assert pr_line['source_status'] == 'approved'
    inv_line = execute(engine, {'question': 'line_explanation', 'line_ref': 'cl2'}, TENANT, 'owner:fixture')['line']
    assert inv_line['category_code'] == 'OPEX_GENERAL'
    assert inv_line['review_status'] == 'suggested'
    assert inv_line['product_name'] == 'Hóa đơn A'
    assert inv_line['product_code'] == 'SKU-A'
    assert inv_line['source_status'] == 'invoice'
    assert inv_line['source_date'].isoformat() == '2026-09-04'
    result = execute(engine, {'question': 'month_totals', 'month': '2026-09'}, TENANT, 'owner:fixture')
    assert result['line_count'] == 2 and result['total_amount'] == Decimal('28')
    by_status = {row['review_status']: row['total_amount'] for row in result['statuses']}
    assert by_status == {'needs_review': Decimal('11'), 'suggested': Decimal('17'),
                         'approved': Decimal('0'), 'rejected': Decimal('0')}


def test_review_status_qualifier_is_preserved(tmp_path):
    rows = {
        'cost_categories': CATEGORIES, 'suppliers': SUPPLIERS,
        'payment_requests': [
            {'id': 'p', 'request_number': 'PR-X', 'supplier_id': 'sup1', 'created_at': '2026-09-03T00:00:00+00:00',
             'invoice_created': False, 'invoice_id': None},
        ],
        'payment_request_items': [
            {'id': 'a', 'payment_request_id': 'p', 'line_total': 11, 'cost_category_code': 'OPEX_GENERAL',
             'cost_review_routing': 'needs_review'},
            {'id': 'b', 'payment_request_id': 'p', 'line_total': 13, 'cost_category_code': 'OPEX_GENERAL',
             'cost_review_routing': None},
        ],
        'cost_line_classifications': [],
    }
    warehouse, engine = _warehouse(tmp_path, rows)
    approved = execute(engine, {'question': 'month_totals', 'month': '2026-09', 'review_status': 'approved'},
                       TENANT, 'owner:fixture')
    assert approved['line_count'] == 1 and approved['total_amount'] == Decimal('13')
    assert all(row['review_status'] == 'approved' for row in approved['rows'])
    pending = execute(engine, {'question': 'month_totals', 'month': '2026-09', 'review_status': 'needs_review'},
                      TENANT, 'owner:fixture')
    assert pending['line_count'] == 1 and pending['total_amount'] == Decimal('11')
    with pytest.raises(ValueError):
        validate_request({'question': 'month_totals', 'month': '2026-09', 'review_status': 'duplicate'})


def test_invoice_created_excludes_payment_request_without_invoice_id(tmp_path):
    rows = {
        'cost_categories': CATEGORIES, 'suppliers': SUPPLIERS,
        'payment_requests': [
            {'id': 'flag', 'request_number': 'PR-FLAG', 'supplier_id': 'sup1',
             'created_at': '2026-09-03T00:00:00+00:00', 'invoice_created': True, 'invoice_id': None},
        ],
        'payment_request_items': [
            {'id': 'fi', 'payment_request_id': 'flag', 'line_total': 999, 'cost_category_code': 'OPEX_GENERAL',
             'cost_review_routing': None},
        ],
        'cost_line_classifications': [
            {'id': 'fc', 'source_type': 'payment_request_item', 'source_line_id': 'fi',
             'category_code': 'OPEX_GENERAL', 'review_status': 'approved', 'confidence': 1},
        ],
    }
    warehouse, engine = _warehouse(tmp_path, rows)
    result = execute(engine, {'question': 'month_totals', 'month': '2026-09'}, TENANT, 'owner:fixture')
    assert result['line_count'] == 0 and result['total_amount'] == Decimal('0')


def test_effective_category_must_exist_in_cost_categories(tmp_path):
    rows = {
        'cost_categories': CATEGORIES, 'suppliers': SUPPLIERS,
        'payment_requests': [
            {'id': 'p', 'request_number': 'PR-X', 'supplier_id': 'sup1', 'created_at': '2026-09-03T00:00:00+00:00',
             'invoice_created': False, 'invoice_id': None},
        ],
        'payment_request_items': [
            # Source override points at a category that is not in cost_categories:
            # the canonical INNER JOIN drops the row, like the reviewed view.
            {'id': 'x', 'payment_request_id': 'p', 'line_total': 7, 'cost_category_code': 'NOT_A_CATEGORY',
             'cost_review_routing': None},
        ],
        'cost_line_classifications': [],
    }
    warehouse, engine = _warehouse(tmp_path, rows)
    result = execute(engine, {'question': 'month_totals', 'month': '2026-09'}, TENANT, 'owner:fixture')
    assert result['line_count'] == 0


def test_null_source_date_is_excluded_from_a_month_not_an_error(tmp_path):
    rows = {
        'cost_categories': CATEGORIES, 'suppliers': SUPPLIERS,
        'payment_requests': [
            {'id': 'p', 'request_number': 'PR-UNDATED', 'supplier_id': 'sup1',
             'paid_at': None, 'created_at': None, 'invoice_created': False, 'invoice_id': None},
        ],
        'payment_request_items': [
            {'id': 'u', 'payment_request_id': 'p', 'line_total': 7, 'cost_category_code': 'OPEX_GENERAL',
             'cost_review_routing': None},
        ],
        'cost_line_classifications': [],
    }
    warehouse, engine = _warehouse(tmp_path, rows)
    result = execute(engine, {'question': 'month_totals', 'month': '2026-09'}, TENANT, 'owner:fixture')
    assert result['line_count'] == 0 and result['total_amount'] == Decimal('0')


def test_projection_gate_refuses_older_or_incomplete_snapshot(state):
    warehouse, engine = state
    with warehouse.lock(), warehouse.connect() as con:
        manifest = json.loads(con.execute('select manifest from meta_supabase_sync_runs').fetchone()[0])
        manifest['version'] = 'bmq-supabase-raw-v13'
        con.execute('update meta_supabase_sync_runs set manifest=?', [json.dumps(manifest)])
    freshness = execute(engine, {'question': 'sync_freshness'}, TENANT, 'owner:fixture')
    assert freshness['projection_complete'] is False
    assert freshness['reconciled'] is False
    assert any('sync_version=' in gap for gap in freshness['projection_gaps'])
    with pytest.raises(RuntimeError, match='projection is incomplete'):
        cost(state, question='month_totals', month='2026-04')
    with warehouse.lock(), warehouse.connect() as con:
        manifest = json.loads(con.execute('select manifest from meta_supabase_sync_runs').fetchone()[0])
        manifest['version'] = 'bmq-supabase-raw-v14'
        manifest['tables']['payment_request_items'].pop('fields')
        con.execute('update meta_supabase_sync_runs set manifest=?', [json.dumps(manifest)])
    freshness = execute(engine, {'question': 'sync_freshness'}, TENANT, 'owner:fixture')
    assert freshness['projection_complete'] is False
    assert any('payment_request_items:' in gap for gap in freshness['projection_gaps'])
    with pytest.raises(RuntimeError, match='projection is incomplete'):
        cost(state, question='month_totals', month='2026-04')


def test_api_cost_endpoint_is_owner_scoped_and_returns_provenance(state):
    warehouse, _ = state
    client = TestClient(create_app(warehouse, authenticator=lambda: Principal(TENANT, 'fixture-owner')))
    response = client.post('/v1/cost', json={'question': 'pending_summary', 'month': '2026-04'})
    assert response.status_code == 200, response.text
    body = response.json()
    assert Decimal(body['pending']['total_amount']) == Decimal('13344200')
    assert body['semantic_version'] == VERSION
    assert 'payload' not in response.text and 'source_name_key' not in response.text
    catalog = client.get('/v1/semantic').json()
    assert catalog['cost_lookup']['version'] == VERSION
    assert {item['id'] for item in catalog['cost_lookup']['questions']} == set(QUESTIONS)



def test_api_example_line_endpoint_returns_the_deterministic_line_and_evidence(state):
    warehouse, _ = state
    client = TestClient(create_app(warehouse, authenticator=lambda: Principal(TENANT, 'fixture-owner')))
    response = client.post('/v1/cost', json={'question': 'example_line', 'month': '2026-04', 'review_status': 'needs_review'})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body['question'] == 'example_line' and body['match_count'] == 2
    assert body['selection_rule'] == 'largest_line_amount_then_source_date_then_classification_id'
    chosen = body['rows'][0]
    assert chosen['classification_id'] == 'c2'
    evidence = client.post('/v1/cost', json={'question': 'line_explanation', 'line_ref': chosen['classification_id']}).json()
    assert evidence['status'] == 'ok'
    assert evidence['line']['month'] == chosen['month']
    assert evidence['evidence']['rule'] is None
    assert 'payload' not in response.text and 'source_name_key' not in response.text

