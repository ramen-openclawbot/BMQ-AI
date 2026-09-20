"""Behavioral tests for the read-only warehouse supplier-payment lane.

Synthetic raw snapshot only: no network, credentials, model or real business data.
Fixtures reproduce the reviewed owner scenario (PAY-000156 / PR-543BBD87, TV Food,
September 2026) plus duplicate, partial, mixed, shared, orphan, stale and
projection-gate cases. The accounting period is `payments.payment_date` only.
"""
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
import json

import pytest
from fastapi.testclient import TestClient
from sme_platform.api import Principal, create_app
from sme_platform import bmq_payment
from sme_platform.bmq_payment import QUESTIONS, VERSION, execute, validate_request
from sme_platform.config import Settings
from sme_platform.query import QueryEngine
from sme_platform.supabase_sync import TENANT, publish
from sme_platform.warehouse import Warehouse
from test_bmq_semantic import snapshot


SUPPLIERS = [
    {'id': 'sup_tv', 'name': 'TV Food', 'short_code': 'TVF'},
    {'id': 'sup_other', 'name': 'Nhà cung cấp Khác', 'short_code': 'NCK'},
]

MATERIALS = [
    {'id': 'mat_bo', 'material_code': 'NVL-BO', 'canonical_name': 'Bơ', 'normalized_name': 'bo', 'active': True},
    {'id': 'mat_peanut', 'material_code': 'NVL-DAU', 'canonical_name': 'Đậu phộng', 'normalized_name': 'dau phong', 'active': True},
]

# The reviewed evidence: request created 2026-08-25, paid_at 2026-09-14, but the
# actual payment happened on 2026-09-10 (payments.payment_date). The item has no
# canonical material identity, so it must never be equated to "bơ".
PAYMENT_REQUESTS = [
    {'id': 'pr1', 'request_number': 'PR-543BBD87', 'supplier_id': 'sup_tv', 'total_amount': '13500000',
     'created_at': '2026-08-25T00:00:00+00:00', 'paid_at': '2026-09-14T00:00:00+00:00'},
    {'id': 'pr2', 'request_number': 'PR-OTHER', 'supplier_id': 'sup_other', 'total_amount': '5000000',
     'created_at': '2026-09-01T00:00:00+00:00', 'paid_at': None},
]

PR_ITEMS = [
    {'id': 'it1', 'payment_request_id': 'pr1', 'product_name': 'BỘ PEERLESS',
     'quantity': 150, 'unit_price': 90000, 'line_total': '13500000', 'canonical_material_id': None},
    {'id': 'it2', 'payment_request_id': 'pr2', 'product_name': 'Bơ',
     'quantity': 1, 'unit_price': 5000000, 'line_total': '5000000', 'canonical_material_id': 'mat_bo'},
]

PAYMENTS = [
    {'id': 'pay1', 'payment_number': 'PAY-000156', 'supplier_id': 'sup_tv',
     'payment_date': '2026-09-10', 'amount': '13500000', 'payment_method': 'bank_transfer',
     'created_at': '2026-09-10T00:00:00+00:00'},
    # payment_date 2026-08-31, but the request was paid_at 2026-09-05: only
    # payment_date may put this payment in August, never the request's paid_at.
    {'id': 'pay2', 'payment_number': 'PAY-000157', 'supplier_id': 'sup_tv',
     'payment_date': '2026-08-31', 'amount': '1000000', 'payment_method': 'cash',
     'created_at': '2026-08-31T00:00:00+00:00'},
    {'id': 'pay3', 'payment_number': 'PAY-000158', 'supplier_id': 'sup_other',
     'payment_date': '2026-09-15', 'amount': '4000000', 'payment_method': 'bank_transfer',
     'created_at': '2026-09-15T00:00:00+00:00'},
]

ALLOCATIONS = [
    {'id': 'a1', 'payment_id': 'pay1', 'payment_request_id': 'pr1', 'amount': '13500000'},
    {'id': 'a2', 'payment_id': 'pay2', 'payment_request_id': 'pr1', 'amount': '1000000'},
    {'id': 'a3', 'payment_id': 'pay3', 'payment_request_id': 'pr2', 'amount': '4000000'},
]


def rows():
    return {
        'suppliers': SUPPLIERS, 'sku_cogs_materials': MATERIALS,
        'payment_requests': PAYMENT_REQUESTS, 'payment_request_items': PR_ITEMS,
        'payments': PAYMENTS, 'payment_allocations': ALLOCATIONS,
    }


def _warehouse(tmp_path, table_rows):
    warehouse = Warehouse(Settings(tmp_path / 'data', test_mode=True))
    warehouse.initialize()
    publish(warehouse, snapshot(table_rows))
    return warehouse, QueryEngine(warehouse)


@pytest.fixture
def state(tmp_path):
    return _warehouse(tmp_path, rows())


def payment(state, **request):
    return execute(state[1], request, TENANT, 'owner:fixture')


def test_literal_tv_food_september_uses_payment_date_and_counts_once(state):
    result = payment(state, question='supplier_payments', month='2026-09', supplier='TV food')
    assert result['semantic_version'] == VERSION
    assert result['snapshot_id'] and result['source_observed_at']
    assert result['supplier_status'] == 'resolved'
    assert result['supplier']['name'] == 'TV Food'
    assert result['month'] == '2026-09'
    assert result['payment_date_basis'] == 'payments.payment_date'
    assert result['total_amount'] == Decimal('13500000')
    assert result['direct_total'] == Decimal('13500000')
    assert result['payment_count'] == 1
    assert [p['payment_number'] for p in result['payments']] == ['PAY-000156']
    assert result['payments'][0]['payment_date'] == '2026-09-10'
    assert result['payments'][0]['amount'] == Decimal('13500000')
    assert result['payments'][0]['attributed_amount'] == Decimal('13500000')


def test_period_is_payment_date_not_request_created_or_paid_at(state):
    august = payment(state, question='supplier_payments', month='2026-08', supplier='TV Food')
    september = payment(state, question='supplier_payments', month='2026-09', supplier='TV Food')
    # pay2 has payment_date 2026-08-31 while the request paid_at is 2026-09-05.
    assert august['total_amount'] == Decimal('1000000')
    assert [p['payment_number'] for p in august['payments']] == ['PAY-000157']
    assert september['total_amount'] == Decimal('13500000')
    assert 'PAY-000157' not in {p['payment_number'] for p in september['payments']}
    # The request created 2026-08-25 must not drag its September payment into August.
    assert 'PAY-000156' not in {p['payment_number'] for p in august['payments']}


def test_unresolved_canonical_item_is_unavailable_not_bơ_and_not_zero(state):
    result = payment(state, question='supplier_payments', month='2026-09', supplier='TV Food', item='bơ')
    # The supplier total is exact and stays distinct from any item amount.
    assert result['total_amount'] == Decimal('13500000')
    assert result['item_status'] == 'unavailable'
    assert result['item_amount'] is None
    assert result['unresolved_item_count'] == 1
    assert 'BỘ PEERLESS' in result['candidate_items']
    # The item term resolved to the "Bơ" material, but the payment's only row has no
    # canonical material id, so no product-specific amount may be claimed.
    assert result['item']['material']['material_code'] == 'NVL-BO'
    assert result['item_amount'] != Decimal('0')


def test_exact_product_item_attributes_only_its_single_item_request(state):
    result = payment(state, question='supplier_payments', month='2026-09', supplier='TV Food', item='BỘ PEERLESS')
    assert result['item_status'] == 'exact'
    assert result['item_amount'] == Decimal('13500000')
    assert result['total_amount'] == Decimal('13500000')


def test_item_not_found_is_honest_while_supplier_total_is_shown(state):
    result = payment(state, question='supplier_payments', month='2026-09', supplier='TV Food', item='đường cát')
    assert result['item_status'] == 'not_found'
    assert result['item_amount'] is None
    assert result['total_amount'] == Decimal('13500000')


def test_ambiguous_item_clarifies_without_inventing_an_item_amount(tmp_path):
    table_rows = rows()
    table_rows['sku_cogs_materials'] = MATERIALS + [
        {'id': 'mat_bo2', 'material_code': 'NVL-BO-2', 'canonical_name': 'Bơ', 'normalized_name': 'bo 2', 'active': True}]
    warehouse, engine = _warehouse(tmp_path, table_rows)
    result = execute(engine, {'question': 'supplier_payments', 'month': '2026-09', 'supplier': 'TV Food',
                              'item': 'Bơ'}, TENANT, 'owner:fixture')
    assert result['item_status'] == 'ambiguous'
    assert result['item_amount'] is None
    assert result['total_amount'] == Decimal('13500000')


def test_ambiguous_supplier_clarifies_and_does_not_broaden(tmp_path):
    table_rows = rows()
    table_rows['suppliers'] = SUPPLIERS + [{'id': 'sup_tv2', 'name': 'TV Food Miền Nam', 'short_code': 'TVF2'}]
    warehouse, engine = _warehouse(tmp_path, table_rows)
    result = execute(engine, {'question': 'supplier_payments', 'month': '2026-09', 'supplier': 'TV Food'},
                     TENANT, 'owner:fixture')
    # A unique name-prefix fallback would be fine, but "TV Food" is an exact match to
    # one supplier while another name carries it as a prefix, so this stays exact.
    assert result['supplier_status'] == 'resolved'
    assert result['supplier']['name'] == 'TV Food'
    # A genuinely ambiguous prefix term must clarify, never return a total.
    ambiguous = execute(engine, {'question': 'supplier_payments', 'month': '2026-09', 'supplier': 'TV'},
                        TENANT, 'owner:fixture')
    assert ambiguous['supplier_status'] == 'ambiguous'
    assert ambiguous.get('total_amount') is None
    assert len(ambiguous['supplier_candidates']) == 2


def test_supplier_not_found_clarifies_and_does_not_fall_back_to_all_suppliers(state):
    result = payment(state, question='supplier_payments', month='2026-09', supplier='Nhà cung cấp Không Tồn Tại')
    assert result['supplier_status'] == 'not_found'
    assert result['supplier'] is None
    assert result.get('total_amount') is None
    assert 'payments' not in result


def test_sql_metacharacters_in_supplier_or_item_are_inert(state):
    result = payment(state, question='supplier_payments', month='2026-09',
                     supplier="TV Food'; DROP TABLE payments;--")
    assert result['supplier_status'] == 'not_found'
    # The snapshot table still exists and answers normally afterwards.
    assert payment(state, question='supplier_payments', month='2026-09', supplier='TV Food')['total_amount'] == Decimal('13500000')


def test_multi_supplier_payment_is_allocated_not_duplicated(tmp_path):
    table_rows = rows()
    table_rows['payment_requests'] = [
        {**PAYMENT_REQUESTS[0], 'total_amount': '20000000'}, PAYMENT_REQUESTS[1],
        {'id': 'pr3', 'request_number': 'PR-THIRD', 'supplier_id': 'sup_tv', 'total_amount': '5000000',
         'created_at': '2026-09-02T00:00:00+00:00', 'paid_at': None}]
    table_rows['payment_request_items'] = PR_ITEMS + [
        {'id': 'it3', 'payment_request_id': 'pr3', 'product_name': 'Đậu phộng',
         'line_total': '5000000', 'canonical_material_id': 'mat_peanut'}]
    table_rows['payments'] = PAYMENTS + [
        {'id': 'pay4', 'payment_number': 'PAY-000159', 'supplier_id': None,
         'payment_date': '2026-09-20', 'amount': '8000000', 'payment_method': 'bank_transfer'}]
    table_rows['payment_allocations'] = ALLOCATIONS + [
        {'id': 'a4', 'payment_id': 'pay4', 'payment_request_id': 'pr1', 'amount': '3000000'},
        {'id': 'a5', 'payment_id': 'pay4', 'payment_request_id': 'pr3', 'amount': '5000000'}]
    warehouse, engine = _warehouse(tmp_path, table_rows)
    result = execute(engine, {'question': 'supplier_payments', 'month': '2026-09', 'supplier': 'TV Food'},
                     TENANT, 'owner:fixture')
    # 13.5m direct + 3m + 5m allocated from the shared 8m payment: the whole 8m is
    # never attributed to TV Food.
    assert result['total_amount'] == Decimal('21500000')
    assert result['direct_total'] == Decimal('13500000')
    assert result['shared_allocated_total'] == Decimal('8000000')
    shared = [p for p in result['payments'] if p['shared']]
    assert len(shared) == 1 and shared[0]['amount'] == Decimal('8000000')
    assert shared[0]['attributed_amount'] == Decimal('8000000')


def test_shared_payment_is_split_and_not_duplicated_across_suppliers(tmp_path):
    table_rows = rows()
    table_rows['payment_requests'] = [
        {**PAYMENT_REQUESTS[0], 'total_amount': '20000000'}, PAYMENT_REQUESTS[1],
        {'id': 'pr3', 'request_number': 'PR-THIRD', 'supplier_id': 'sup_other', 'total_amount': '5000000',
         'created_at': '2026-09-02T00:00:00+00:00', 'paid_at': None}]
    table_rows['payment_request_items'] = PR_ITEMS + [
        {'id': 'it3', 'payment_request_id': 'pr3', 'product_name': 'Đậu phộng',
         'line_total': '5000000', 'canonical_material_id': 'mat_peanut'}]
    table_rows['payments'] = PAYMENTS + [
        {'id': 'pay4', 'payment_number': 'PAY-000160', 'supplier_id': None,
         'payment_date': '2026-09-20', 'amount': '8000000', 'payment_method': 'bank_transfer'}]
    table_rows['payment_allocations'] = ALLOCATIONS + [
        {'id': 'a4', 'payment_id': 'pay4', 'payment_request_id': 'pr1', 'amount': '3000000'},
        {'id': 'a5', 'payment_id': 'pay4', 'payment_request_id': 'pr3', 'amount': '5000000'}]
    warehouse, engine = _warehouse(tmp_path, table_rows)
    tv = execute(engine, {'question': 'supplier_payments', 'month': '2026-09', 'supplier': 'TV Food'}, TENANT, 'owner:fixture')
    # Only the 3m allocation touches TV Food requests; the 5m belongs to a different
    # supplier, so the shared 8m payment is not duplicated.
    assert tv['shared_allocated_total'] == Decimal('3000000')
    assert tv['total_amount'] == Decimal('16500000')


def test_mixed_item_request_makes_item_amount_unavailable(tmp_path):
    table_rows = rows()
    table_rows['payment_request_items'] = [
        {'id': 'mix1', 'payment_request_id': 'pr1', 'product_name': 'Bơ', 'line_total': '4000000',
         'canonical_material_id': 'mat_bo'},
        {'id': 'mix2', 'payment_request_id': 'pr1', 'product_name': 'Đậu phộng', 'line_total': '6000000',
         'canonical_material_id': 'mat_peanut'},
    ]
    warehouse, engine = _warehouse(tmp_path, table_rows)
    result = execute(engine, {'question': 'supplier_payments', 'month': '2026-09', 'supplier': 'TV Food', 'item': 'Bơ'},
                     TENANT, 'owner:fixture')
    assert result['item_status'] == 'unavailable'
    assert result['item_amount'] is None
    assert result['mixed_allocation_count'] == 1


def test_partial_allocation_on_single_item_request_is_exact_not_scaled(state):
    # pay2 allocates 1m to the single-item PEERLESS request. The item amount is the
    # allocation actually paid, never a proportion of the request total.
    result = payment(state, question='supplier_payments', month='2026-08', supplier='TV Food', item='BỘ PEERLESS')
    assert result['item_status'] == 'exact'
    assert result['item_amount'] == Decimal('1000000')


def test_product_name_with_a_material_link_is_an_identity_conflict_not_zero(tmp_path):
    # The item term resolves to a bare product name, but the payment's row carries a
    # canonical material link with that name. The two identities cannot be equated, so
    # the item amount is unavailable, not an exact zero.
    table_rows = rows()
    table_rows['payment_request_items'] = [
        {'id': 'conflict', 'payment_request_id': 'pr1', 'product_name': 'BỘ PEERLESS',
         'line_total': '13500000', 'canonical_material_id': 'mat_bo'}]
    warehouse, engine = _warehouse(tmp_path, table_rows)
    result = execute(engine, {'question': 'supplier_payments', 'month': '2026-09', 'supplier': 'TV Food',
                              'item': 'BỘ PEERLESS'}, TENANT, 'owner:fixture')
    assert result['item']['mode'] == 'product'
    assert result['item_status'] == 'unavailable'
    assert result['item_amount'] is None


def test_empty_month_reports_no_payments_without_claiming_zero(state):
    result = payment(state, question='supplier_payments', month='2026-01', supplier='TV Food')
    assert result['total_amount'] == Decimal('0')
    assert result['payments'] == []
    assert result['payment_count'] == 0


def test_all_supplier_month_total_is_available_without_a_supplier(state):
    result = payment(state, question='supplier_payments', month='2026-09')
    assert result['supplier_status'] == 'not_requested'
    assert result['total_amount'] == Decimal('17500000')
    assert result['payment_count'] == 2


def test_allocation_to_a_missing_request_fails_closed(tmp_path):
    table_rows = rows()
    table_rows['payment_allocations'] = ALLOCATIONS + [
        {'id': 'orphan', 'payment_id': 'pay1', 'payment_request_id': 'missing-request', 'amount': '1'}]
    warehouse, engine = _warehouse(tmp_path, table_rows)
    with pytest.raises(RuntimeError, match='allocation to a missing request'):
        execute(engine, {'question': 'supplier_payments', 'month': '2026-09', 'supplier': 'TV Food'}, TENANT, 'owner:fixture')


def test_unrelated_out_of_scope_orphan_does_not_break_the_month(tmp_path):
    table_rows = rows()
    # A dangling allocation whose payment is not in the requested month cannot change
    # this month's total or item attribution, so it must not poison the answer.
    table_rows['payment_allocations'] = ALLOCATIONS + [
        {'id': 'stray', 'payment_id': 'missing-payment', 'payment_request_id': 'pr1', 'amount': '1'}]
    warehouse, engine = _warehouse(tmp_path, table_rows)
    result = execute(engine, {'question': 'supplier_payments', 'month': '2026-09', 'supplier': 'TV Food'},
                     TENANT, 'owner:fixture')
    assert result['total_amount'] == Decimal('13500000')


def test_non_positive_or_excess_allocation_fails_closed(tmp_path):
    for bad, label in [('-1', 'non-positive'), ('99999999', 'exceed the payment')]:
        table_rows = rows()
        table_rows['payment_allocations'] = [dict(ALLOCATIONS[0], amount=bad)]
        warehouse, engine = _warehouse(tmp_path, table_rows)
        with pytest.raises(RuntimeError, match=label):
            execute(engine, {'question': 'supplier_payments', 'month': '2026-09', 'supplier': 'TV Food'}, TENANT, 'owner:fixture')


@pytest.mark.parametrize('bad_date', [None, '', 'not-a-date', '2026-13-40'])
def test_uncertain_payment_date_fails_closed_instead_of_zero(tmp_path, bad_date):
    # An undated/unparsable payment has unknown membership: it could belong to the
    # requested month, so it must never be silently skipped into a plausible zero.
    table_rows = rows()
    table_rows['payments'] = [dict(PAYMENTS[0], payment_date=bad_date)] + PAYMENTS[1:]
    warehouse, engine = _warehouse(tmp_path, table_rows)
    with pytest.raises(RuntimeError, match='payment date'):
        execute(engine, {'question': 'supplier_payments', 'month': '2026-09', 'supplier': 'TV Food'},
                TENANT, 'owner:fixture')


def test_valid_dated_out_of_period_row_with_bad_data_does_not_poison_the_month(tmp_path):
    # A valid date clearly outside the period means the row cannot change this month's
    # total or item attribution, so its bad amount/allocation must not poison the answer.
    table_rows = rows()
    table_rows['payments'] = PAYMENTS + [
        {'id': 'pay_hist', 'payment_number': 'PAY-HIST', 'supplier_id': 'sup_other',
         'payment_date': '2019-01-15', 'amount': '-1', 'payment_method': 'cash'}]
    table_rows['payment_allocations'] = ALLOCATIONS + [
        {'id': 'a_hist', 'payment_id': 'pay_hist', 'payment_request_id': 'pr2', 'amount': '-2'}]
    warehouse, engine = _warehouse(tmp_path, table_rows)
    result = execute(engine, {'question': 'supplier_payments', 'month': '2026-09', 'supplier': 'TV Food'},
                     TENANT, 'owner:fixture')
    assert result['total_amount'] == Decimal('13500000')


def test_null_supplier_unallocated_payment_fails_closed_for_a_scoped_supplier(tmp_path):
    table_rows = rows()
    table_rows['payments'] = [dict(PAYMENTS[0], supplier_id=None), PAYMENTS[1], PAYMENTS[2]]
    table_rows['payment_allocations'] = [a for a in ALLOCATIONS if a['payment_id'] != 'pay1']
    warehouse, engine = _warehouse(tmp_path, table_rows)
    with pytest.raises(RuntimeError, match='cover the payment amount'):
        execute(engine, {'question': 'supplier_payments', 'month': '2026-09', 'supplier': 'TV Food'},
                TENANT, 'owner:fixture')


def test_null_supplier_partial_allocation_fails_closed_for_a_scoped_supplier(tmp_path):
    # A null-supplier payment is only tied to a supplier through its allocations. Leaving
    # part of it unattributed would hide money of unknown supplier from the scoped total.
    table_rows = rows()
    table_rows['payments'] = [dict(PAYMENTS[0], supplier_id=None), PAYMENTS[1], PAYMENTS[2]]
    table_rows['payment_allocations'] = [dict(ALLOCATIONS[0], amount='5000000'), ALLOCATIONS[1], ALLOCATIONS[2]]
    warehouse, engine = _warehouse(tmp_path, table_rows)
    with pytest.raises(RuntimeError, match='cover the payment amount'):
        execute(engine, {'question': 'supplier_payments', 'month': '2026-09', 'supplier': 'TV Food'},
                TENANT, 'owner:fixture')


def test_null_supplier_allocation_to_unknown_supplier_request_fails_closed(tmp_path):
    table_rows = rows()
    table_rows['payments'] = [dict(PAYMENTS[0], supplier_id=None), PAYMENTS[1], PAYMENTS[2]]
    table_rows['payment_requests'] = [dict(PAYMENT_REQUESTS[0], supplier_id=None), PAYMENT_REQUESTS[1]]
    warehouse, engine = _warehouse(tmp_path, table_rows)
    with pytest.raises(RuntimeError, match='unknown request supplier'):
        execute(engine, {'question': 'supplier_payments', 'month': '2026-09', 'supplier': 'TV Food'},
                TENANT, 'owner:fixture')


@pytest.mark.parametrize('bad_total', [None, '', 'NaN', 'Infinity', '-Infinity'])
def test_missing_or_non_finite_request_total_fails_closed(monkeypatch, bad_total):
    # The request total bounds how much of a payment may be attributed to the request; a
    # missing or non-finite total cannot prove that capacity, so it must not be silently
    # ignored (which would let an over-allocation inflate a supplier or item amount).
    # The raw source is stubbed because NaN/Infinity cannot pass the publish-time
    # reconciliation gate that real snapshots already enforce.
    table_rows = rows()
    table_rows['payment_requests'] = [dict(PAYMENT_REQUESTS[0], total_amount=bad_total), PAYMENT_REQUESTS[1]]
    monkeypatch.setattr(bmq_payment, '_source', lambda con, tenant, table: table_rows[table])
    request = validate_request({'question': 'supplier_payments', 'month': '2026-09', 'supplier': 'TV Food'})
    with pytest.raises(RuntimeError, match='request total'):
        bmq_payment._answer(None, request, None, datetime.now(timezone.utc))


def test_tv_food_actual_source_stays_separate_from_the_unproven_item(state):
    # Acceptance evidence: the September TV Food actual 13,500,000 is proven by
    # payments.payment_date. The 'bơ' item amount remains unavailable because the only
    # linked line (BỘ PEERLESS) carries no canonical material identity. The proven actual
    # is never relabelled as the unproven item.
    result = payment(state, question='supplier_payments', month='2026-09', supplier='TV Food', item='bơ')
    assert result['payment_date_basis'] == 'payments.payment_date'
    assert result['total_amount'] == Decimal('13500000')
    assert result['direct_total'] == Decimal('13500000')
    assert result['item_status'] == 'unavailable'
    assert result['item_amount'] is None
    assert result['item_amount'] != result['total_amount']
    assert 'BỘ PEERLESS' in result['candidate_items']


def test_non_finite_amount_is_rejected():
    from sme_platform.bmq_payment import _amount
    for bad in ('NaN', 'Infinity', '-Infinity', None):
        with pytest.raises(RuntimeError):
            _amount(bad)


def test_allocation_beyond_request_capacity_fails_closed(tmp_path):
    table_rows = rows()
    table_rows['payment_requests'] = [dict(PAYMENT_REQUESTS[0], total_amount='1000'), PAYMENT_REQUESTS[1]]
    warehouse, engine = _warehouse(tmp_path, table_rows)
    with pytest.raises(RuntimeError, match='exceed the request total'):
        execute(engine, {'question': 'supplier_payments', 'month': '2026-09', 'supplier': 'TV Food'}, TENANT, 'owner:fixture')


def test_supplier_suffix_is_not_silently_resolved(state):
    result = payment(state, question='supplier_payments', month='2026-09', supplier='TV Food Không Tồn Tại')
    assert result['supplier_status'] != 'resolved'
    assert 'total_amount' not in result


def test_supplier_payment_without_allocation_fails_closed(tmp_path):
    table_rows = rows()
    table_rows['payment_allocations'] = [a for a in ALLOCATIONS if a['id'] != 'a1']
    warehouse, engine = _warehouse(tmp_path, table_rows)
    with pytest.raises(RuntimeError, match='no allocation'):
        execute(engine, {'question': 'supplier_payments', 'month': '2026-09', 'supplier': 'TV Food'}, TENANT, 'owner:fixture')


def test_duplicate_payment_number_fails_closed(tmp_path):
    table_rows = rows()
    table_rows['payments'] = PAYMENTS + [
        {'id': 'paydup', 'payment_number': 'PAY-000156', 'supplier_id': 'sup_tv',
         'payment_date': '2026-09-11', 'amount': '1', 'payment_method': 'cash'}]
    table_rows['payment_allocations'] = ALLOCATIONS + [
        {'id': 'adup', 'payment_id': 'paydup', 'payment_request_id': 'pr1', 'amount': '1'}]
    warehouse, engine = _warehouse(tmp_path, table_rows)
    with pytest.raises(RuntimeError, match='duplicate payment number'):
        execute(engine, {'question': 'supplier_payments', 'month': '2026-09', 'supplier': 'TV Food'}, TENANT, 'owner:fixture')


def test_duplicate_allocation_identity_fails_closed(tmp_path):
    table_rows = rows()
    table_rows['payment_allocations'] = ALLOCATIONS + [
        {'id': 'aduplicate', 'payment_id': 'pay1', 'payment_request_id': 'pr1', 'amount': '1'}]
    warehouse, engine = _warehouse(tmp_path, table_rows)
    with pytest.raises(RuntimeError, match='duplicate payment allocation'):
        execute(engine, {'question': 'supplier_payments', 'month': '2026-09', 'supplier': 'TV Food'}, TENANT, 'owner:fixture')


def test_payment_allocated_to_another_supplier_fails_closed(tmp_path):
    table_rows = rows()
    # pay1 is tagged TV Food but one of its allocations belongs to another supplier's
    # request: the tagged total cannot be trusted, so the answer fails closed.
    table_rows['payment_allocations'] = ALLOCATIONS + [
        {'id': 'amismatch', 'payment_id': 'pay1', 'payment_request_id': 'pr2', 'amount': '1'}]
    warehouse, engine = _warehouse(tmp_path, table_rows)
    with pytest.raises(RuntimeError, match='supplier mismatch'):
        execute(engine, {'question': 'supplier_payments', 'month': '2026-09', 'supplier': 'TV Food'}, TENANT, 'owner:fixture')


def test_missing_reconciled_table_fails_closed(state):
    warehouse, engine = state
    with warehouse.lock(), warehouse.connect() as con:
        manifest = json.loads(con.execute('select manifest from meta_supabase_sync_runs').fetchone()[0])
        del manifest['tables']['payment_allocations']
        con.execute('update meta_supabase_sync_runs set manifest=?', [json.dumps(manifest)])
    with pytest.raises(RuntimeError, match='not synchronized'):
        execute(engine, {'question': 'supplier_payments', 'month': '2026-09', 'supplier': 'TV Food'}, TENANT, 'owner:fixture')


def test_stale_snapshot_fails_closed(state):
    warehouse, engine = state
    with warehouse.lock(), warehouse.connect() as con:
        con.execute("update meta_supabase_sync_runs set observed_at=now()-interval '31 minutes'")
    with pytest.raises(RuntimeError, match='stale'):
        execute(engine, {'question': 'supplier_payments', 'month': '2026-09', 'supplier': 'TV Food'}, TENANT, 'owner:fixture')


def test_projection_gate_refuses_snapshot_without_canonical_material_id(state):
    warehouse, engine = state
    with warehouse.lock(), warehouse.connect() as con:
        manifest = json.loads(con.execute('select manifest from meta_supabase_sync_runs').fetchone()[0])
        manifest['tables']['payment_request_items'].pop('fields')
        con.execute('update meta_supabase_sync_runs set manifest=?', [json.dumps(manifest)])
    with pytest.raises(RuntimeError, match='projection is incomplete'):
        execute(engine, {'question': 'supplier_payments', 'month': '2026-09', 'supplier': 'TV Food'}, TENANT, 'owner:fixture')


def test_projection_gate_refuses_older_sync_version(state):
    warehouse, engine = state
    with warehouse.lock(), warehouse.connect() as con:
        manifest = json.loads(con.execute('select manifest from meta_supabase_sync_runs').fetchone()[0])
        manifest['version'] = 'bmq-supabase-raw-v13'
        con.execute('update meta_supabase_sync_runs set manifest=?', [json.dumps(manifest)])
    with pytest.raises(RuntimeError, match='projection is incomplete'):
        execute(engine, {'question': 'supplier_payments', 'month': '2026-09', 'supplier': 'TV Food'}, TENANT, 'owner:fixture')


def test_request_grammar_rejects_unknown_fields_and_bad_limits(state):
    with pytest.raises(ValueError):
        validate_request({'question': 'supplier_payments', 'month': '09/2026'})
    with pytest.raises(ValueError):
        validate_request({'question': 'supplier_payments', 'month': '2026-09', 'tenant': 'other'})
    with pytest.raises(ValueError):
        validate_request({'question': 'supplier_payments', 'month': '2026-09', 'sql': 'select 1'})
    with pytest.raises(ValueError):
        validate_request({'question': 'supplier_payments', 'month': '2026-09', 'limit': 51})
    with pytest.raises(ValueError):
        validate_request({'question': 'wipe'})
    assert validate_request({'question': 'supplier_payments', 'month': '2026-09'}) == {
        'question': 'supplier_payments', 'month': date(2026, 9, 1), 'supplier': None, 'item': None, 'limit': 20}


def test_non_owner_is_forbidden(state):
    with pytest.raises(PermissionError):
        execute(state[1], {'question': 'supplier_payments', 'month': '2026-09'}, TENANT, 'viewer:fixture')


def test_api_payment_endpoint_is_owner_scoped_and_catalog_present(state):
    warehouse, _ = state
    client = TestClient(create_app(warehouse, authenticator=lambda: Principal(TENANT, 'fixture-owner')))
    response = client.post('/v1/payment', json={'question': 'supplier_payments', 'month': '2026-09', 'supplier': 'TV Food'})
    assert response.status_code == 200, response.text
    body = response.json()
    assert Decimal(body['total_amount']) == Decimal('13500000')
    assert body['semantic_version'] == VERSION
    assert 'payload' not in response.text and 'payment_number' in response.text
    catalog = client.get('/v1/semantic').json()
    assert catalog['payment_lookup']['version'] == VERSION
    assert {item['id'] for item in catalog['payment_lookup']['questions']} == set(QUESTIONS)
    forbidden = TestClient(create_app(warehouse, authenticator=lambda: Principal(TENANT, 'viewer', 'viewer:rls:v1')))
    assert forbidden.post('/v1/payment', json={'question': 'supplier_payments', 'month': '2026-09'}).status_code == 403
