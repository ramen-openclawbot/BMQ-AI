"""Owner-only customer lookup. Exact identity, explicit price lists, no guessed prices."""
from datetime import datetime, timezone
from decimal import Decimal
import json
import threading
import unicodedata

from .supabase_sync import TENANT

VERSION = 'bmq-customer-v2'


def normalized(value):
    return ' '.join(unicodedata.normalize('NFC', value).casefold().split())


def execute(engine, body, tenant, permission):
    if tenant != TENANT or not (permission == 'owner' or permission.startswith('owner:')):
        raise PermissionError('Owner required')
    if not isinstance(body, dict) or set(body) != {'kind', 'customer', 'product', 'time_range', 'limit'}:
        raise ValueError('Invalid customer lookup')
    kind = body['kind']
    if kind not in {'prices', 'orders', 'npp_receivable'}:
        raise ValueError('Invalid lookup kind')
    for field in ('customer', 'product'):
        if not isinstance(body[field], str) or len(body[field]) > 120 or any(ord(c) < 32 for c in body[field]):
            raise ValueError('Invalid entity')
    if not normalized(body['customer']) or (kind != 'prices' and body['product'].strip()):
        raise ValueError('Customer required; product-scoped orders unsupported')
    limit = body['limit']
    if type(limit) != int or not 1 <= limit <= 20:
        raise ValueError('Invalid limit')
    start, end = engine._period(body['time_range'])
    if kind == 'prices' and (start, end) != engine._period('today'):
        raise ValueError('Price history unavailable')
    needed = {'mini_crm_customers', 'mini_crm_customer_price_list', 'product_skus'} if kind == 'prices' else {'mini_crm_customers', 'dealer_orders'}
    if kind == 'npp_receivable':
        needed = {'mini_crm_customers', 'revenue_ledger_lines'}
    w = engine.warehouse
    with w.lock(write=False), w.connect(read_only=True) as con:
        con.execute('SET enable_external_access=false')
        timer = threading.Timer(w.settings.query_timeout, con.interrupt)
        timer.start()
        try:
            latest = con.execute('SELECT run_id,observed_at,manifest FROM meta_supabase_sync_runs ORDER BY observed_at DESC LIMIT 1').fetchone()
            if not latest:
                raise RuntimeError('Snapshot unavailable')
            manifest = json.loads(latest[2])
            now = datetime.now(timezone.utc)
            if manifest.get('tenant') != tenant or not -60 <= (now-latest[1]).total_seconds() <= 1800:
                raise RuntimeError('Snapshot unavailable or stale')
            # The publication manifest proves even an empty source was synchronized.
            tables = manifest.get('tables', {})
            if not all(t in tables and tables[t].get('reconciled') is True for t in needed):
                raise RuntimeError('Required source unavailable')
            def source(table):
                return [json.loads(row[0], parse_float=Decimal) for row in con.execute('SELECT payload FROM bronze.supabase_current WHERE tenant_id=? AND source_table=? ORDER BY source_id', [tenant, table]).fetchall()]
            customers = source('mini_crm_customers')
            term = normalized(body['customer'])
            matches = [c for c in customers if term in {normalized(str(c.get(k) or '')) for k in ('id', 'customer_code', 'customer_name')}]
            result = {'kind': kind, 'semantic_version': VERSION, 'source': 'Supabase.' + ' + '.join(sorted(needed)),
                      'source_observed_at': latest[1].isoformat(), 'snapshot_id': latest[0], 'rows': [], 'truncated': False,
                      'period': {'start': str(start), 'end': str(end)}}
            public = lambda c: {k: c.get(k) for k in ('id', 'customer_code', 'customer_name', 'is_active')}
            if len(matches) != 1:
                candidates = matches or [c for c in customers if term in normalized(str(c.get('customer_name') or '')) or term in normalized(str(c.get('customer_code') or ''))]
                return {**result, 'status': 'choose_customer' if candidates else 'not_found', 'candidates': [public(c) for c in candidates[:5]], 'truncated': len(candidates) > 5}
            customer = matches[0]
            result['customer'] = public(customer)
            if customer.get('is_active') is not True:
                return {**result, 'status': 'inactive_customer'}
            if kind == 'npp_receivable':
                from .bmq_receivable import calculate
                return calculate(result, customer, customers, source('revenue_ledger_lines'), start, end, limit)
            if kind == 'prices':
                products = {p['id']: p for p in source('product_skus')}
                prices = [p for p in source('mini_crm_customer_price_list') if p.get('customer_id') == customer['id'] and p.get('is_active') is True]
                if len({p.get('sku_id') for p in prices}) != len(prices):
                    raise RuntimeError('Ambiguous active price rows')
                product_term = normalized(body['product'])
                if product_term:
                    selected = [p for p in products.values() if product_term in {normalized(str(p.get(k) or '')) for k in ('id', 'sku_code', 'product_name')}]
                    if len(selected) != 1:
                        return {**result, 'status': 'product_not_unique'}
                    prices = [p for p in prices if p.get('sku_id') == selected[0]['id']]
                for p in prices:
                    sku = products.get(p.get('sku_id'))
                    if not sku or not sku.get('unit') or not sku.get('sku_code') or p.get('currency') != 'VND' or p.get('price_vnd_per_unit') is None:
                        raise RuntimeError('Incomplete price data')
                    amount = Decimal(str(p['price_vnd_per_unit']))
                    if not amount.is_finite() or amount < 0:
                        raise RuntimeError('Invalid price')
                    result['rows'].append({'sku_code': sku['sku_code'], 'product_name': sku['product_name'], 'unit': sku['unit'], 'price': amount, 'currency': 'VND'})
                result['rows'].sort(key=lambda p: p['sku_code'])
            else:
                # Filtering is always by resolved owner customer_id, never route_customer_id.
                for order in source('dealer_orders'):
                    if order.get('customer_id') == customer['id'] and order.get('status') == 'submitted':
                        if order.get('is_test') is None or (order.get('is_test') is False and not order.get('submitted_at')):
                            raise RuntimeError('Incomplete order flags or dates')
                cur = con.execute("""SELECT p->>'order_number' AS order_number,
                    p->>'submitted_at' AS submitted_at,p->>'requested_delivery_date' AS delivery_date,
                    p->>'total_amount_vnd' AS amount,p->>'currency' AS currency
                    FROM (SELECT payload::JSON AS p FROM bronze.supabase_current WHERE tenant_id=? AND source_table='dealer_orders')
                    WHERE (p->>'customer_id')=? AND (p->>'status')='submitted' AND (p->>'is_test')='false'
                    AND CAST(CAST(p->>'submitted_at' AS TIMESTAMPTZ) AT TIME ZONE 'Asia/Ho_Chi_Minh' AS DATE) BETWEEN ? AND ?
                    ORDER BY p->>'submitted_at' DESC,p->>'order_number' LIMIT ?""", [tenant, customer['id'], start, end, limit+1])
                result['rows'] = [dict(zip([c[0] for c in cur.description], row)) for row in cur.fetchall()]
                for row in result['rows']:
                    if not row['order_number'] or row['currency'] != 'VND' or row['amount'] is None or not Decimal(row['amount']).is_finite():
                        raise RuntimeError('Incomplete order data')
            result['truncated'] = len(result['rows']) > limit
            result['rows'] = result['rows'][:limit]
            return {**result, 'status': 'ok'}
        finally:
            timer.cancel()
