"""BMQ operational contracts over the atomically published Supabase snapshot.

No reclassification as canonical sales/revenue. Fixed SQL, owner only, no PII.
"""
from datetime import datetime, timezone
import copy
import json
import threading

from .supabase_sync import TENANT

VERSION = 'bmq-operational-v2'
from . import bmq_business
METRICS = {
    'dealer_order_count': {
        'label': 'Dealer order count', 'label_vi': 'Số đơn đại lý', 'unit': 'count',
        'description': 'Non-test submitted dealer orders, by submitted_at in Vietnam time; not purchase orders or completed sales.',
        'description_vi': 'Đơn đại lý đã gửi, loại đơn test, theo ngày gửi giờ Việt Nam; không phải PO hay số đơn đã giao.',
        'source': 'Supabase.dealer_orders', 'dimensions': ['date'],
    },
    'dealer_order_value': {
        'label': 'Dealer ordered value', 'label_vi': 'Giá trị đơn đặt đại lý', 'unit': 'VND',
        'description': 'SUM total_amount_vnd of non-test submitted orders, by Vietnam submission date; not revenue, collections or receivables.',
        'description_vi': 'Tổng total_amount_vnd của đơn đã gửi, loại test, theo ngày gửi; không phải doanh thu, tiền thu hay công nợ.',
        'source': 'Supabase.dealer_orders', 'dimensions': ['date'],
    },
    'kiosk_report_count': {
        'label': 'Submitted kiosk reports', 'label_vi': 'Số báo cáo điểm bán đã gửi', 'unit': 'count',
        'description': 'Count submitted kiosk_daily_reports by report_date; not customer orders or staff attendance.',
        'description_vi': 'Đếm báo cáo điểm bán trạng thái submitted theo report_date; không phải đơn khách hay chấm công.',
        'source': 'Supabase.kiosk_daily_reports', 'dimensions': ['date', 'location'],
    },
    'kiosk_reported_amount': {
        'label': 'Kiosk reported channel amount', 'label_vi': 'Số tiền theo kênh báo cáo điểm bán', 'unit': 'VND',
        'description': 'SUM channel_rows.amount_vnd joined once to submitted reports by report_date; reported amount, not controlled revenue or cash collected. Never add to the revenue ledger.',
        'description_vi': 'Tổng amount_vnd theo kênh của báo cáo đã gửi theo report_date; không phải doanh thu kiểm soát hay tiền mặt thực thu. Không cộng thêm vào sổ doanh thu.',
        'source': 'Supabase.kiosk_daily_reports + kiosk_daily_report_channel_rows', 'dimensions': ['date', 'location'],
    },
}


METRICS.update(bmq_business.METRICS)

def catalog():
    return {'version': VERSION, 'metrics': copy.deepcopy(METRICS),
            'customer_lookup': 'effective_prices: current dealer catalog prices using exact customer active override then default selling_price; unavailable remains null, not a checkout quote; prices: explicit current active customer-specific prices only (not effective checkout prices, tax terms or historical quotes); orders: submitted non-test order headers for exact customer owning the order, not downstream delivery points. Resolve exact customer code/name; ambiguous names require clarification. npp_receivable: named NPP period gross approved ledger minus current active child management fees, matching NppDebtManagement; no opening/collections/overdue/settlement or historical fee reconstruction. order_details: historical lines for an exact ordering customer, optional exact product and detail_filters route/date_basis(submitted or delivery)/status(submitted,cancelled,all); matching-line totals, not revenue or whole-order totals. No product filter except prices/effective_prices/order_details.',
            'dimensions': {d:d for spec in METRICS.values() for d in spec['dimensions']},
            'policy': 'Only defined business metrics; never add distinct ledgers together. No customer/staff PII. Contract file metadata does not provide terms.'}


def execute(engine, dsl, tenant, permission):
    if dsl.get('metric') in bmq_business.METRICS:
        return bmq_business.execute(engine,dsl,tenant,permission)
    if tenant != TENANT or not (permission == 'owner' or permission.startswith('owner:')):
        raise PermissionError('Owner required')
    if set(dsl) - {'metric', 'time_range', 'dimensions', 'limit'}:
        raise ValueError('Unsupported operational DSL')
    metric = dsl['metric']
    descriptor = METRICS[metric]
    dims = dsl.get('dimensions', [])
    if (not isinstance(dims, list) or any(not isinstance(d, str) for d in dims)
            or len(dims) != len(set(dims)) or any(d not in descriptor['dimensions'] for d in dims)):
        raise ValueError('Incompatible dimensions')
    limit = dsl.get('limit', 20)
    if type(limit) != int or not 1 <= limit <= 500:
        raise ValueError('Invalid limit')
    start, end = engine._period(dsl.get('time_range', 'today'))
    w = engine.warehouse
    # A single read lock covers manifest and result; no stale cached fallback.
    with w.lock(write=False), w.connect(read_only=True) as con:
        exists = con.execute("SELECT count(*) FROM information_schema.tables WHERE table_name='meta_supabase_sync_runs'").fetchone()[0]
        if not exists:
            raise RuntimeError('Supabase snapshot not available')
        latest = con.execute('SELECT run_id,observed_at,manifest FROM meta_supabase_sync_runs ORDER BY observed_at DESC LIMIT 1').fetchone()
        if not latest or json.loads(latest[2]).get('tenant') != tenant:
            raise RuntimeError('Supabase snapshot not available')
        now = datetime.now(timezone.utc)
        age = (now - latest[1]).total_seconds()
        # 15 minute schedule: stop numerical answers after 2 missed intervals.
        if age < -60 or age > 1800:
            raise RuntimeError('Supabase snapshot is stale')
        params = [tenant, start, end, limit + 1]
        common = "WITH src AS (SELECT source_table, source_id, payload::JSON AS p FROM bronze.supabase_current WHERE tenant_id=?)"
        if metric.startswith('dealer_'):
            rows = """, facts AS (SELECT
                CAST(CAST(p->>'submitted_at' AS TIMESTAMPTZ) AT TIME ZONE 'Asia/Ho_Chi_Minh' AS DATE) AS date,
                p->>'currency' AS currency, CAST(p->>'total_amount_vnd' AS DECIMAL(28,5)) AS amount
                FROM src WHERE source_table='dealer_orders' AND (p->>'status')='submitted'
                AND CAST(p->>'is_test' AS BOOLEAN)=false)"""
            expression = 'COUNT(*)' if metric.endswith('count') else 'SUM(amount)'
        else:
            rows = """, reports AS (SELECT source_id, CAST(p->>'report_date' AS DATE) AS date,
                p->>'location_id' AS location FROM src
                WHERE source_table='kiosk_daily_reports' AND (p->>'status')='submitted')"""
            if metric == 'kiosk_report_count':
                rows += ", facts AS (SELECT date,location,'VND' AS currency,1 AS amount FROM reports)"
                expression = 'COUNT(*)'
            else:
                rows += """, facts AS (SELECT r.date,r.location,'VND' AS currency,
                    CAST(c.p->>'amount_vnd' AS DECIMAL(28,5)) AS amount FROM reports r JOIN src c
                    ON c.source_table='kiosk_daily_report_channel_rows' AND (c.p->>'report_id')=r.source_id)"""
                expression = 'SUM(amount)'
        fields = ','.join(dims + ['currency'])
        sql = common + rows + f" SELECT {fields},{expression} AS {metric},COUNT(*) AS _records,COUNT(amount) AS _amounts FROM facts WHERE date BETWEEN ? AND ? GROUP BY ALL ORDER BY {metric} DESC NULLS LAST,{fields} LIMIT ?"
        con.execute('SET enable_external_access=false')
        timer = threading.Timer(w.settings.query_timeout, con.interrupt)
        timer.start()
        try:
            # Missing dates/foreign keys must not silently disappear in filters/joins.
            if metric.startswith('dealer_'):
                invalid = con.execute(common + " SELECT count(*) FROM src WHERE source_table='dealer_orders' AND (p->>'status')='submitted' AND ((p->>'is_test') IS NULL OR ((p->>'is_test')='false' AND ((p->>'submitted_at') IS NULL OR (p->>'currency') IS NULL)))", [tenant]).fetchone()[0]
            else:
                invalid = con.execute(common + " SELECT count(*) FROM src WHERE source_table='kiosk_daily_reports' AND (p->>'status')='submitted' AND ((p->>'report_date') IS NULL OR (p->>'location_id') IS NULL)", [tenant]).fetchone()[0]
                if metric == 'kiosk_reported_amount':
                    invalid += con.execute(common + " SELECT count(*) FROM src c WHERE c.source_table='kiosk_daily_report_channel_rows' AND NOT EXISTS (SELECT 1 FROM src r WHERE r.source_table='kiosk_daily_reports' AND r.source_id=(c.p->>'report_id'))", [tenant]).fetchone()[0]
            if invalid:
                raise RuntimeError('Incomplete source keys or dates')
            cur = con.execute(sql, params)
            names = [c[0] for c in cur.description]
            result = [dict(zip(names, row)) for row in cur.fetchall()]
        finally:
            timer.cancel()
        for row in result:
            if row['currency'] != 'VND' or (descriptor['unit'] == 'VND' and row['_records'] != row['_amounts']):
                raise RuntimeError('Incomplete monetary data')
            row.pop('_records'); row.pop('_amounts')
    return {'metric': metric, 'rows': result[:limit], 'truncated': len(result) > limit,
            'period': {'start': str(start), 'end': str(end)}, 'source': descriptor['source'],
            'definition': descriptor['description'], 'definition_vi': descriptor['description_vi'],
            'unit': descriptor['unit'], 'semantic_version': VERSION, 'cache_hit': False,
            'source_observed_at': latest[1].isoformat(), 'snapshot_id': latest[0], 'read_at': now.isoformat()}
