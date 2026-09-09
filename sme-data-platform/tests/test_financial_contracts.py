"""Independent financial acceptance regressions using synthetic business records only."""
import json
from decimal import Decimal
import pytest
from sme_platform.config import Settings
from sme_platform.warehouse import Warehouse
from sme_platform.query import QueryEngine
from sme_platform.canonical import canonical_id

@pytest.fixture
def wh(tmp_path):
    warehouse = Warehouse(Settings(tmp_path / 'financial-data', test_mode=True))
    warehouse.initialize()
    return warehouse

def ingest(wh, tmp_path, entity, rows, source='pos', tenant='bmq'):
    path = tmp_path / f'{source}-{entity}.json'
    path.write_text(json.dumps(rows), encoding='utf-8')
    return wh.ingest_file(path, tenant, source, entity)

def order(id, amount, **fields):
    return {'id': id, 'currency': 'VND', 'status': 'completed', 'ordered_at': '2026-09-09T08:00:00+07:00', 'net_amount': str(amount), **fields}

def query(wh, metric='revenue', **fields):
    return QueryEngine(wh).execute({'metric': metric, 'time_range': {'start': '2026-09-01', 'end': '2026-09-30'}, **fields}, 'bmq')

def test_signed_refunds_cancelled_orders_and_tombstones_do_not_leak_to_revenue(wh, tmp_path):
    ingest(wh, tmp_path, 'orders', [order('sale', '100.25'), order('adjustment', '-20.10'), order('cancel', 9000, status='cancelled'), order('draft', 9000, status='draft'), order('refunded', 9000, status='refunded'), order('deleted', 9000, is_deleted=True)])
    wh.rebuild_gold()
    engine = QueryEngine(wh)
    dsl = {'metric': 'revenue', 'time_range': {'start': '2026-09-01', 'end': '2026-09-30'}}
    assert engine.execute(dsl, 'bmq')['rows'][0]['revenue'] == Decimal('80.15')
    assert engine.execute(dsl, 'bmq')['cache_hit'] is True
    ingest(wh, tmp_path, 'orders', [{'id': 'sale', 'is_deleted': True}])
    wh.rebuild_gold()
    result = engine.execute(dsl, 'bmq')
    assert result['cache_hit'] is False
    assert result['rows'][0]['revenue'] == Decimal('-20.10')
    wh.rebuild_silver(); wh.rebuild_gold()
    assert query(wh)['rows'][0]['revenue'] == Decimal('-20.10')

def test_customer_distinct_is_recomputed_per_period_location_and_currency(wh, tmp_path):
    ingest(wh, tmp_path, 'customers', [{'id': 'c1'}, {'id': 'c2'}])
    ingest(wh, tmp_path, 'locations', [{'id': 'a'}, {'id': 'b'}])
    ingest(wh, tmp_path, 'orders', [order('one', 10, customer_id='c1', location_id='a'), order('two', 20, customer_id='c1', location_id='b'), order('three', 30, customer_id='c2', location_id='b', ordered_at='2026-09-10T08:00:00+07:00'), order('usd', 5, customer_id='c1', location_id='a', currency='USD')])
    wh.rebuild_gold()
    assert {r['currency']: r['customer_count'] for r in query(wh, 'customer_count')['rows']} == {'USD': 1, 'VND': 2}
    rows = query(wh, 'customer_count', dimensions=['location'])['rows']
    assert {(r['currency'], r['location']): r['customer_count'] for r in rows} == {('USD', canonical_id('bmq', 'pos', 'locations', 'a')): 1, ('VND', canonical_id('bmq', 'pos', 'locations', 'a')): 1, ('VND', canonical_id('bmq', 'pos', 'locations', 'b')): 2}
    assert {r['currency']: r['revenue'] for r in query(wh)['rows']} == {'USD': Decimal(5), 'VND': Decimal(60)}
    assert {r['currency']: r['average_order_value'] for r in query(wh, 'average_order_value')['rows']} == {'USD': 5, 'VND': 20}

def test_source_timezone_and_location_midnight_boundaries(wh, tmp_path):
    ingest(wh, tmp_path, 'locations', [{'id': 'utc', 'timezone': 'UTC'}])
    ingest(wh, tmp_path, 'orders', [order('before', 1, ordered_at='2026-09-08T16:59:59Z'), order('at', 2, ordered_at='2026-09-08T17:00:00Z'), order('naive', 4, ordered_at='2026-09-09T00:00:00'), order('utc-location', 8, ordered_at='2026-09-08T17:00:00Z', location_id='utc')])
    wh.rebuild_gold()
    result = query(wh, dimensions=['date'])
    assert {str(r['date']): r['revenue'] for r in result['rows']} == {'2026-09-08': Decimal(9), '2026-09-09': Decimal(6)}
    wh.rebuild_silver(); wh.rebuild_gold()
    assert query(wh, dimensions=['date'])['rows'] == result['rows']

def test_stale_incremental_update_does_not_resurrect_deleted_order_or_regress_watermark(wh, tmp_path):
    ingest(wh, tmp_path, 'orders', [order('one', 100, updated_at='2026-09-09T00:00:00Z')])
    ingest(wh, tmp_path, 'orders', [{'id': 'one', 'is_deleted': True, 'updated_at': '2026-09-11T00:00:00Z'}])
    ingest(wh, tmp_path, 'orders', [order('one', 999, updated_at='2026-09-10T00:00:00Z')])
    for rebuild in [False, True]:
        if rebuild: wh.rebuild_silver()
        wh.rebuild_gold()
        assert query(wh)['rows'] == []
        with wh.connect(True) as con:
            assert con.execute('SELECT net_amount, is_deleted FROM silver.orders').fetchone() == (Decimal(100), True)
            assert con.execute('SELECT last_source_updated_at FROM meta_sources').fetchone()[0].day == 11

def test_conflicting_identity_evidence_rolls_back_and_explicit_mapping_survives_rebuild(wh, tmp_path):
    ingest(wh, tmp_path, 'customers', [{'id': 'a', 'email': 'a@example.invalid', 'phone': '111'}, {'id': 'b', 'email': 'b@example.invalid', 'phone': '222'}])
    with pytest.raises(ValueError, match='Conflicting identity'):
        ingest(wh, tmp_path, 'customers', [{'id': 'mixed', 'email': 'a@example.invalid', 'phone': '222'}], source='crm')
    target = canonical_id('bmq', 'pos', 'customers', 'a')
    wh.map_identity('bmq', 'customers', 'crm', 'crm-a', target)
    ingest(wh, tmp_path, 'customers', [{'id': 'crm-a', 'full_name': 'Reviewed customer'}], source='crm')
    ingest(wh, tmp_path, 'orders', [order('crm-order', 50, customer_id='crm-a')], source='crm')
    wh.rebuild_silver(); wh.rebuild_gold()
    with wh.connect(True) as con:
        assert con.execute('SELECT count(*) FROM silver.customers').fetchone()[0] == 2
        assert con.execute('SELECT customer_id FROM silver.orders').fetchone()[0] == target
    with pytest.raises(ValueError, match='reassigned'):
        wh.map_identity('bmq', 'customers', 'crm', 'crm-a', canonical_id('bmq', 'pos', 'customers', 'b'))

def test_top_product_semantics_do_not_fan_out_order_totals_or_include_excluded_lines(wh, tmp_path):
    ingest(wh, tmp_path, 'products', [{'id': 'p1'}, {'id': 'p2'}])
    ingest(wh, tmp_path, 'orders', [order('sale', 100), order('excluded', 1000, status='cancelled')])
    ingest(wh, tmp_path, 'order_items', [{'id': 'i1', 'order_id': 'sale', 'product_id': 'p1', 'quantity': 2, 'net_amount': 70}, {'id': 'i2', 'order_id': 'sale', 'product_id': 'p2', 'quantity': 1, 'net_amount': 30}, {'id': 'i3', 'order_id': 'excluded', 'product_id': 'p2', 'quantity': 100, 'net_amount': 1000}, {'id': 'deleted', 'order_id': 'sale', 'product_id': 'p2', 'quantity': 100, 'net_amount': 1000, 'is_deleted': True}])
    wh.rebuild_gold()
    top = QueryEngine(wh).get_top_products('bmq')['rows']
    assert [(r['product_id'], r['revenue'], r['units_sold']) for r in top] == [(canonical_id('bmq', 'pos', 'products', 'p1'), Decimal(70), Decimal(2)), (canonical_id('bmq', 'pos', 'products', 'p2'), Decimal(30), Decimal(1))]
    assert query(wh)['rows'][0]['revenue'] == Decimal(100)
    assert query(wh, 'order_count')['rows'][0]['order_count'] == 1

def test_invalid_location_timezone_is_rejected_before_it_can_block_gold_rebuild(wh, tmp_path):
    with pytest.raises(ValueError):
        ingest(wh, tmp_path, 'locations', [{'id': 'bad-zone', 'timezone': 'Mars/Olympus'}])
    ingest(wh, tmp_path, 'orders', [order('valid', 5)])
    wh.rebuild_gold()
    assert query(wh)['rows'][0]['revenue'] == Decimal(5)


def test_top_products_aggregate_multiple_days_without_comparing_currencies(wh, tmp_path):
    ingest(wh, tmp_path, 'products', [{'id': 'p1'}, {'id': 'p2'}])
    ingest(wh, tmp_path, 'orders', [order('day1', 50), order('day2', 70, ordered_at='2026-09-10T08:00:00+07:00'), order('usd', 2, currency='USD')])
    ingest(wh, tmp_path, 'order_items', [{'id': 'i1', 'order_id': 'day1', 'product_id': 'p1', 'quantity': 1, 'net_amount': 50}, {'id': 'i2', 'order_id': 'day2', 'product_id': 'p1', 'quantity': 2, 'net_amount': 70}, {'id': 'i3', 'order_id': 'usd', 'product_id': 'p2', 'quantity': 1, 'net_amount': 2}])
    wh.rebuild_gold()
    result = QueryEngine(wh).get_top_products('bmq')['rows']
    assert len(result) == 2
    assert {r['currency']: r['revenue'] for r in result} == {'VND': Decimal(120), 'USD': Decimal(2)}
    assert next(r for r in result if r['currency'] == 'VND')['units_sold'] == Decimal(3)

def test_existing_customer_update_cannot_silently_adopt_another_identity(wh, tmp_path):
    ingest(wh, tmp_path, 'customers', [{'id': 'a', 'email': 'a@example.invalid', 'phone': '111'}, {'id': 'b', 'email': 'b@example.invalid', 'phone': '222'}])
    with pytest.raises(ValueError, match='identity conflicts'):
        ingest(wh, tmp_path, 'customers', [{'id': 'a', 'email': 'b@example.invalid', 'phone': '111'}])
    wh.rebuild_silver()
    with wh.connect(True) as con:
        assert con.execute('SELECT email FROM silver.customers WHERE source_record_id=?', ['a']).fetchone()[0] == 'a@example.invalid'
        assert con.execute('SELECT COUNT(*) FROM silver.customers').fetchone()[0] == 2
