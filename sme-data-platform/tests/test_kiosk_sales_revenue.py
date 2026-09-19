"""Owner-only offline tests for the derived kiosk sales revenue contract.

Synthetic snapshots only: no production storage, network, credentials or writes.
The August price evidence is the reviewed trust source carried into September.
"""
from datetime import date
from decimal import Decimal
import json
import pytest
from sme_platform.bmq_semantic import METRICS, VERSION, catalog
from sme_platform.bmq_kiosk_pricing import PRICES, PRICED_END, PRICED_START
from sme_platform.config import Settings
from sme_platform.query import QueryEngine
from sme_platform.supabase_sync import TENANT, publish
from sme_platform.warehouse import Warehouse
from test_bmq_semantic import snapshot


LOCATIONS = [
    {'id': 'loc-bv', 'location_code': 'HCM001-BV', 'location_name': '91 Bùi Viện', 'active': False},
    {'id': 'loc-pvc', 'location_code': 'HCM002-PVC', 'location_name': '213 Phạm Văn Chí', 'active': False},
    {'id': 'loc-bvd', 'location_code': 'HCM003-BVĐ', 'location_name': '323 Bến Vân Đồn', 'active': False},
    {'id': 'loc-bhn', 'location_code': 'HCM004-BHN', 'location_name': '276 Bùi Hữu Nghĩa', 'active': True},
    {'id': 'loc-tn', 'location_code': 'HCM005-TN', 'location_name': '230 Thống Nhất', 'active': True},
    {'id': 'loc-test', 'location_code': 'TEST-KIOSK', 'location_name': 'Điểm bán TEST', 'active': True},
]


def report(row_id, location_id, date='2026-09-15', status='submitted'):
    return {'id': row_id, 'location_id': location_id, 'report_date': date, 'status': status}


def channel(row_id, report_id, code, quantity, amount_vnd='0'):
    return {'id': row_id, 'report_id': report_id, 'channel_code': code, 'quantity': quantity, 'amount_vnd': amount_vnd}


def make(tmp_path, reports, channels, locations=None, offset=0):
    w = Warehouse(Settings(tmp_path / 'data', test_mode=True))
    w.initialize()
    publish(w, snapshot({'kiosk_report_locations': locations if locations is not None else LOCATIONS,
                         'kiosk_daily_reports': reports,
                         'kiosk_daily_report_channel_rows': channels}, offset))
    return w, QueryEngine(w)


def t9(tmp_path, offset=0):
    """Reviewed September snapshot: delivery channels carry quantity but amount_vnd is zero."""
    reports = [report('r-bv', 'loc-bv'), report('r-bhn', 'loc-bhn'), report('r-bvd', 'loc-bvd'), report('r-tn', 'loc-tn')]
    channels = [channel('c1', 'r-bv', 'khach_le', 659, 9226000),
                channel('c2', 'r-bhn', 'grabfood', 1563, 0),
                channel('c3', 'r-bvd', 'shopeefood', 1574, 0),
                channel('c4', 'r-tn', 'befood', 11, 0)]
    return make(tmp_path, reports, channels, offset=offset)


def run(engine, metric='kiosk_sales_revenue', start='2026-09-15', end='2026-09-15', **extra):
    return engine.execute({'metric': metric, 'time_range': {'start': start, 'end': end}, **extra}, TENANT, 'owner:test')


def by_channel(result):
    return {row['channel']: row for row in result['rows']}


def total(result, key='kiosk_sales_revenue'):
    return sum((row[key] for row in result['rows']), Decimal(0))


def test_t9_channel_breakdown_total_and_inactive_location(tmp_path):
    _, e = t9(tmp_path)
    r = run(e, dimensions=['channel'])
    rows = by_channel(r)
    assert rows['khach_le']['kiosk_sales_revenue'] == Decimal('9226000')
    assert rows['khach_le']['quantity'] == Decimal('659')
    assert rows['khach_le']['unit_price_vnd'] == 14000
    assert rows['grabfood']['kiosk_sales_revenue'] == Decimal('21882000')
    assert rows['grabfood']['quantity'] == Decimal('1563')
    assert rows['shopeefood']['kiosk_sales_revenue'] == Decimal('22036000')
    assert rows['befood']['kiosk_sales_revenue'] == Decimal('132000')
    assert rows['befood']['unit_price_vnd'] == 12000
    assert total(r) == Decimal('53276000')
    # Inactive real location HCM001-BV still contributes: the walk-in row came from it.
    located = {(row['location'], row['channel']): row for row in run(e, dimensions=['location', 'channel'])['rows']}
    assert located[('HCM001-BV', 'khach_le')]['kiosk_sales_revenue'] == Decimal('9226000')


def test_reported_amount_metric_stays_intact_and_separate(tmp_path):
    _, e = t9(tmp_path)
    reported = run(e, metric='kiosk_reported_amount')
    assert total(reported, 'kiosk_reported_amount') == Decimal('9226000')  # the old bug value: delivery amount_vnd is zero
    derived = run(e)
    assert total(derived) == Decimal('53276000')
    assert reported['metric'] == 'kiosk_reported_amount'


def test_delivery_quantity_with_zero_amount_is_included(tmp_path):
    _, e = make(tmp_path, [report('r', 'loc-tn')], [channel('c1', 'r', 'grabfood', 10, 0), channel('c2', 'r', 'khach_le', 5, 99999999)])
    rows = by_channel(run(e, dimensions=['channel']))
    assert rows['grabfood']['kiosk_sales_revenue'] == Decimal('140000')
    # amount_vnd is never used: derived revenue is quantity x trusted price, not 99,999,999.
    assert rows['khach_le']['kiosk_sales_revenue'] == Decimal('70000')
    assert total(run(e)) == Decimal('210000')


def test_no_double_count_when_report_has_multiple_channels(tmp_path):
    _, e = make(tmp_path, [report('r', 'loc-tn')],
                [channel('c1', 'r', 'khach_le', 2, 100), channel('c2', 'r', 'grabfood', 3, 100), channel('c3', 'r', 'shopeefood', 4, 100)])
    r = run(e, dimensions=['channel'])
    assert total(r) == Decimal('126000')
    assert len(r['rows']) == 3


def test_september_only_effective_window_fails_closed(tmp_path):
    _, e = t9(tmp_path)
    with pytest.raises(ValueError, match='September 2026'):
        run(e, start='2026-08-01', end='2026-08-31')
    with pytest.raises(ValueError, match='September 2026'):
        run(e, start='2026-08-31', end='2026-09-01')
    with pytest.raises(ValueError, match='September 2026'):
        run(e, start='2026-09-30', end='2026-10-01')
    assert PRICED_START.isoformat() == '2026-09-01' and PRICED_END.isoformat() == '2026-09-30'


def test_future_and_other_month_never_extrapolated(tmp_path):
    _, e = t9(tmp_path)
    assert total(run(e, start='2026-09-01', end='2026-09-30', dimensions=['channel'])) == Decimal('53276000')
    for start, end in [('2026-07-01', '2026-07-31'), ('2026-10-01', '2026-10-31'), ('2026-12-01', '2026-12-31')]:
        with pytest.raises(ValueError):
            run(e, start=start, end=end)


def test_missing_report_reference_fails_closed(tmp_path):
    _, e = make(tmp_path, [report('r', 'loc-tn')], [channel('c1', 'missing', 'khach_le', 1, 0)])
    with pytest.raises(RuntimeError, match='missing report references'):
        run(e)


def test_missing_location_reference_fails_closed(tmp_path):
    _, e = make(tmp_path, [report('r', 'missing', date='2026-09-15')], [])
    with pytest.raises(RuntimeError, match='missing report locations'):
        run(e)


def test_missing_report_date_fails_closed(tmp_path):
    _, e = make(tmp_path, [{'id': 'r', 'location_id': 'loc-tn', 'report_date': None, 'status': 'submitted'}], [])
    with pytest.raises(RuntimeError, match='bad report keys'):
        run(e)


@pytest.mark.parametrize('quantity', [-1, '-0.5'])
def test_negative_quantity_fails_closed(tmp_path, quantity):
    _, e = make(tmp_path, [report('r', 'loc-tn')], [channel('c1', 'r', 'khach_le', quantity, 0)])
    with pytest.raises(RuntimeError, match='invalid quantities'):
        run(e)


@pytest.mark.parametrize('quantity', ['NaN', 'Infinity', 'abc', None])
def test_nonfinite_or_missing_quantity_fails_closed(tmp_path, quantity):
    _, e = make(tmp_path, [report('r', 'loc-tn')], [channel('c1', 'r', 'khach_le', quantity, 0)])
    with pytest.raises(RuntimeError, match='invalid quantities'):
        run(e)


def test_duplicate_location_and_date_report_fails_closed(tmp_path):
    _, e = make(tmp_path, [report('r1', 'loc-tn'), report('r2', 'loc-tn')],
                [channel('c1', 'r1', 'khach_le', 1, 0)])
    with pytest.raises(RuntimeError, match='duplicate location'):
        run(e)


def test_duplicate_report_and_channel_fails_closed(tmp_path):
    _, e = make(tmp_path, [report('r', 'loc-tn')],
                [channel('c1', 'r', 'khach_le', 1, 0), channel('c2', 'r', 'khach_le', 2, 0)])
    with pytest.raises(RuntimeError, match='duplicate report'):
        run(e)


def test_two_reports_same_location_different_dates_do_not_fanout(tmp_path):
    _, e = make(tmp_path, [report('r1', 'loc-tn', date='2026-09-10'), report('r2', 'loc-tn', date='2026-09-11')],
                [channel('c1', 'r1', 'khach_le', 1, 0), channel('c2', 'r2', 'khach_le', 2, 0)])
    r = run(e, start='2026-09-01', end='2026-09-30', dimensions=['date'])
    rows = {row['date']: row for row in r['rows']}
    assert rows[date(2026, 9, 10)]['kiosk_sales_revenue'] == Decimal('14000')
    assert rows[date(2026, 9, 11)]['kiosk_sales_revenue'] == Decimal('28000')


def test_unknown_channel_nonzero_fails_closed(tmp_path):
    _, e = make(tmp_path, [report('r', 'loc-tn')], [channel('c1', 'r', 'hotline', 1, 0)])
    with pytest.raises(RuntimeError, match='unknown channels'):
        run(e)
    _, e2 = make(tmp_path / 'two', [report('r', 'loc-tn')], [channel('c1', 'r', 'mystery', 2, 0)])
    with pytest.raises(RuntimeError, match='unknown channels'):
        run(e2)


def test_unknown_channel_zero_contributes_zero(tmp_path):
    _, e = make(tmp_path, [report('r', 'loc-tn')],
                [channel('c1', 'r', 'khach_le', 1, 0), channel('c2', 'r', 'hotline', 0, 0)])
    r = run(e, dimensions=['channel'])
    rows = by_channel(r)
    assert rows['hotline']['kiosk_sales_revenue'] == Decimal('0')
    assert rows['hotline']['quantity'] == Decimal('0')
    assert rows['hotline']['unit_price_vnd'] is None
    assert total(r) == Decimal('14000')


def test_befood_without_evidence_fails_closed(tmp_path):
    # HCM001-BV and HCM004-BHN have no befood evidence.
    _, e = make(tmp_path, [report('r', 'loc-bv')], [channel('c1', 'r', 'befood', 5, 0)])
    with pytest.raises(RuntimeError, match='evidenced price'):
        run(e)
    _, e2 = make(tmp_path / 'two', [report('r', 'loc-bhn')], [channel('c1', 'r', 'befood', 5, 0)])
    with pytest.raises(RuntimeError, match='evidenced price'):
        run(e2)


def test_befood_zero_without_evidence_is_allowed(tmp_path):
    _, e = make(tmp_path, [report('r', 'loc-bv')],
                [channel('c1', 'r', 'khach_le', 1, 0), channel('c2', 'r', 'befood', 0, 0)])
    assert total(run(e)) == Decimal('14000')


def test_draft_report_channel_rows_are_excluded(tmp_path):
    _, e = make(tmp_path, [report('r1', 'loc-tn', status='submitted'), report('r2', 'loc-tn', date='2026-09-16', status='draft')],
                [channel('c1', 'r1', 'khach_le', 1, 0), channel('c2', 'r2', 'grabfood', 99, 0)])
    assert total(run(e, start='2026-09-01', end='2026-09-30')) == Decimal('14000')


def test_test_kiosk_is_excluded_even_with_nonzero_quantity(tmp_path):
    _, e = make(tmp_path, [report('r1', 'loc-tn'), report('r2', 'loc-test')],
                [channel('c1', 'r1', 'khach_le', 1, 0), channel('c2', 'r2', 'khach_le', 100, 0)])
    assert total(run(e)) == Decimal('14000')


def test_inactive_real_location_is_not_excluded(tmp_path):
    # HCM002-PVC and HCM003-BVĐ are inactive=false in the source but still sell.
    _, e = make(tmp_path, [report('r1', 'loc-pvc'), report('r2', 'loc-bvd')],
                [channel('c1', 'r1', 'grabfood', 1, 0), channel('c2', 'r2', 'shopeefood', 1, 0)])
    assert total(run(e)) == Decimal('28000')


def test_price_is_specific_to_location_and_channel(tmp_path):
    _, e = make(tmp_path, [report('r1', 'loc-tn'), report('r2', 'loc-bvd')],
                [channel('c1', 'r1', 'befood', 10, 0), channel('c2', 'r2', 'befood', 10, 0)])
    r = run(e, dimensions=['location', 'channel'])
    rows = {(row['location'], row['channel']): row for row in r['rows']}
    assert rows[('HCM005-TN', 'befood')]['unit_price_vnd'] == 12000
    assert rows[('HCM005-TN', 'befood')]['kiosk_sales_revenue'] == Decimal('120000')
    assert rows[('HCM003-BVĐ', 'befood')]['unit_price_vnd'] == 14000
    assert rows[('HCM003-BVĐ', 'befood')]['kiosk_sales_revenue'] == Decimal('140000')


def test_dimensions_expose_quantity_and_unit_price(tmp_path):
    _, e = t9(tmp_path)
    r = run(e, dimensions=['location', 'channel'])
    for row in r['rows']:
        assert 'quantity' in row and 'unit_price_vnd' in row and row['unit_price_vnd'] in {12000, 14000}
    with pytest.raises(ValueError, match='dimensions'):
        run(e, dimensions=['status'])
    with pytest.raises(ValueError, match='dimensions'):
        run(e, dimensions=['channel', 'channel'])


def test_result_definition_and_trusted_price_provenance(tmp_path):
    _, e = t9(tmp_path)
    r = run(e, dimensions=['channel'])
    assert 'quantity' in r['definition'] and 'September 2026' in r['definition']
    assert 'amount_vnd' in r['definition'] and 'not' in r['definition'].lower()
    pricing = r['pricing']
    assert pricing['evidence']['sha256'] == 'eef2f83ddc40f10e666ca47ba532d3b582efe5403a77132b034b17d3f2e759ee'
    assert pricing['evidence']['source'] == 'DTHU T08.26.xls'
    assert pricing['evidence']['sheet'] == 'CHI TIET DTHU'
    assert pricing['effective_start'] == '2026-09-01' and pricing['effective_end'] == '2026-09-30'
    assert len(pricing['prices']) == len(PRICES) == 18
    assert pricing['prices'][0]['location_code'].startswith('HCM')
    assert r['price_basis'] == pricing['policy']
    assert r['snapshot_id'] and r['source_observed_at']


def test_catalog_has_metric_channel_dimension_and_label(tmp_path):
    spec = METRICS['kiosk_sales_revenue']
    assert spec['unit'] == 'VND' and 'channel' in spec['dimensions'] and 'location' in spec['dimensions']
    assert 'doanh thu' in spec['description_vi'].lower()
    assert 'derived' in spec['label'].lower() or 'suy ra' in spec['label_vi'].lower()
    published = catalog()['metrics']['kiosk_sales_revenue']
    assert published['dimensions'] == ['date', 'location', 'channel']
    assert 'channel' in catalog()['dimensions']


def test_owner_identity_required(tmp_path):
    _, e = t9(tmp_path)
    for tenant, permission in [('other', 'owner'), (TENANT, 'staff'), (TENANT, 'viewer')]:
        with pytest.raises(PermissionError):
            e.execute({'metric': 'kiosk_sales_revenue', 'time_range': {'start': '2026-09-15', 'end': '2026-09-15'}}, tenant, permission)


def test_closed_dsl_for_new_metric(tmp_path):
    _, e = t9(tmp_path)
    for extra in [{'filters': []}, {'sql': 'drop table x'}, {'limit': 501}, {'comparison': 'previous_month'}]:
        with pytest.raises(ValueError):
            run(e, **extra)


def test_missing_snapshot_fails(tmp_path):
    w = Warehouse(Settings(tmp_path / 'empty', test_mode=True))
    w.initialize()
    with pytest.raises(RuntimeError):
        run(QueryEngine(w))


def test_partial_sub_range_returns_only_that_day(tmp_path):
    _, e = t9(tmp_path)
    assert total(run(e, start='2026-09-15', end='2026-09-15', dimensions=['channel'])) == Decimal('53276000')
    # No rows for a September day with no reports, and that is not treated as zero.
    assert run(e, start='2026-09-20', end='2026-09-20')['rows'] == []


# --- Period scoping regressions (coordinator review) ---------------------------------
# A valid September answer must not be poisoned by old August rows, by September rows
# outside the requested subrange, or by malformed draft/TEST rows. Unresolvable
# references and null dates still fail closed globally.


def test_old_august_hotline_and_unknown_rows_do_not_contaminate_september(tmp_path):
    reports = [report('r-sep', 'loc-tn', date='2026-09-15'),
               report('r-aug', 'loc-bv', date='2026-08-15')]
    channels = [channel('c-sep', 'r-sep', 'khach_le', 2, 28000),
                channel('c-aug-hotline', 'r-aug', 'hotline', 5, 70000),
                channel('c-aug-unknown', 'r-aug', 'mystery', 3, 0)]
    _, e = make(tmp_path, reports, channels)
    r = run(e, start='2026-09-01', end='2026-09-30')
    assert r['total'] == Decimal('28000')
    assert by_channel(run(e, start='2026-09-01', end='2026-09-30', dimensions=['channel']))['khach_le']['kiosk_sales_revenue'] == Decimal('28000')
    # The historical August report still raises its own window guard, never a false September total.
    with pytest.raises(ValueError, match='September 2026'):
        run(e, start='2026-08-01', end='2026-08-31')


def test_september_rows_outside_requested_subrange_do_not_contaminate(tmp_path):
    reports = [report('r-ok', 'loc-tn', date='2026-09-15'),
               report('r-late', 'loc-bhn', date='2026-09-20')]
    channels = [channel('c-ok', 'r-ok', 'khach_le', 1, 14000),
                channel('c-late', 'r-late', 'hotline', 5, 0)]
    _, e = make(tmp_path, reports, channels)
    # Narrow subrange excludes the later hotline/unknown row entirely.
    assert run(e, start='2026-09-15', end='2026-09-15')['total'] == Decimal('14000')
    # Whole September includes it, so the unknown channel fails closed as designed.
    with pytest.raises(RuntimeError, match='unknown channels'):
        run(e, start='2026-09-01', end='2026-09-30')


def test_august_report_without_channels_does_not_trip_period_check(tmp_path):
    reports = [report('r-ok', 'loc-tn', date='2026-09-15'),
               report('r-aug-empty', 'loc-bhn', date='2026-08-20')]
    channels = [channel('c-ok', 'r-ok', 'khach_le', 1, 14000)]
    _, e = make(tmp_path, reports, channels)
    r = run(e, start='2026-09-01', end='2026-09-30')
    assert r['total'] == Decimal('14000')


def test_malformed_draft_and_test_rows_are_excluded(tmp_path):
    reports = [report('r-ok', 'loc-tn', date='2026-09-15'),
               report('r-draft', 'loc-bv', date='2026-09-16', status='draft'),
               report('r-test', 'loc-test', date='2026-09-17')]
    channels = [channel('c-ok', 'r-ok', 'khach_le', 1, 14000),
                channel('c-draft-unknown', 'r-draft', 'mystery', 7, 0),
                channel('c-draft-null', 'r-draft', 'hotline', None, 0),
                channel('c-test-unknown', 'r-test', 'mystery', 9, 0)]
    _, e = make(tmp_path, reports, channels)
    r = run(e, start='2026-09-01', end='2026-09-30')
    assert r['total'] == Decimal('14000')
    assert r['total_quantity'] == Decimal('1')


def test_eligible_submitted_report_without_channel_rows_fails_closed(tmp_path):
    _, e = make(tmp_path, [report('r-ok', 'loc-tn'), report('r-empty', 'loc-bhn')],
                [channel('c-ok', 'r-ok', 'khach_le', 1, 14000)])
    with pytest.raises(RuntimeError, match='without channel rows'):
        run(e)
    # A TEST report with no channel rows is synthetic and must not trip the real check.
    _, e2 = make(tmp_path / 'two', [report('r-ok', 'loc-tn'), report('r-test', 'loc-test')],
                 [channel('c-ok', 'r-ok', 'khach_le', 1, 14000)])
    assert run(e2)['total'] == Decimal('14000')


@pytest.mark.parametrize('code', ['', None])
def test_blank_channel_identity_fails_closed_even_with_zero_quantity(tmp_path, code):
    _, e = make(tmp_path, [report('r', 'loc-tn')],
                [channel('c1', 'r', 'khach_le', 1, 0), channel('c2', 'r', code, 0, 0)])
    with pytest.raises(RuntimeError, match='blank channel codes'):
        run(e)


def test_zero_quantity_unpriced_channel_with_nonzero_amount_fails_closed(tmp_path):
    # A reported amount that cannot be tied to any evidenced price is an unknown
    # monetary source; it must not be silently dropped from a "complete" total.
    _, e = make(tmp_path, [report('r', 'loc-tn')],
                [channel('c1', 'r', 'khach_le', 1, 14000), channel('c2', 'r', 'hotline', 0, 5000)])
    with pytest.raises(RuntimeError, match='zero-quantity unpriced reported amount'):
        run(e)
    _, e2 = make(tmp_path / 'two', [report('r', 'loc-bv')], [channel('c1', 'r', 'befood', 0, 5000)])
    with pytest.raises(RuntimeError, match='zero-quantity unpriced reported amount'):
        run(e2)
    # The same zero-quantity/unpriced row with a zero amount is a legitimate non-sale.
    _, e3 = make(tmp_path / 'three', [report('r', 'loc-bv')],
                 [channel('c1', 'r', 'khach_le', 1, 14000), channel('c2', 'r', 'befood', 0, 0)])
    assert run(e3)['total'] == Decimal('14000')


def test_exact_total_is_independent_of_display_limit(tmp_path):
    reports = [report(f'r{i}', 'loc-tn', date=f'2026-09-{i:02d}') for i in range(1, 26)]
    channels = [channel(f'c{i}', f'r{i}', 'khach_le', 1, 14000) for i in range(1, 26)]
    _, e = make(tmp_path, reports, channels)
    r = run(e, start='2026-09-01', end='2026-09-30', dimensions=['date', 'channel'], limit=20)
    assert len(r['rows']) == 20 and r['truncated'] is True
    assert r['total'] == Decimal('350000')          # 25 x 14,000 across the whole period
    assert r['total_quantity'] == Decimal('25')
    assert r['total_currency'] == 'VND'
    assert total(r) < r['total']                    # the displayed rows are a partial sum only


def test_mixed_price_channel_group_is_not_given_a_fabricated_price(tmp_path):
    # befood is 12,000 at HCM002-PVC and 14,000 at HCM003-BVĐ: a channel-only group has
    # two real prices, so no single unit price may be reported for it.
    reports = [report('r-pvc', 'loc-pvc'), report('r-bvd', 'loc-bvd')]
    channels = [channel('c-pvc', 'r-pvc', 'befood', 10, 0), channel('c-bvd', 'r-bvd', 'befood', 10, 0)]
    _, e = make(tmp_path, reports, channels)
    r = run(e, dimensions=['channel'])
    row = by_channel(r)['befood']
    assert row['unit_price_vnd'] is None
    assert row['quantity'] == Decimal('20')
    assert row['kiosk_sales_revenue'] == Decimal('260000')
    assert r['total'] == Decimal('260000')
    # Per-location detail still exposes each real price honestly.
    located = {(row['location'], row['channel']): row for row in run(e, dimensions=['location', 'channel'])['rows']}
    assert located[('HCM002-PVC', 'befood')]['unit_price_vnd'] == 12000
    assert located[('HCM003-BVĐ', 'befood')]['unit_price_vnd'] == 14000


def test_semantic_version_bumped_and_provenance_has_no_local_paths(tmp_path):
    assert VERSION == 'bmq-operational-v3'
    _, e = t9(tmp_path)
    pricing = run(e, dimensions=['channel'])['pricing']
    evidence = pricing['evidence']
    assert 'derived_evidence' not in evidence and 'trust_source' not in evidence
    assert 'generated/' not in json.dumps(pricing)
    assert evidence['source'] == 'DTHU T08.26.xls'
    assert all('generated/' not in p['location_code'] for p in pricing['prices'])
