"""Bounded historical order lines. Never reprice, never multiply physical quantity."""
from datetime import datetime, date
from decimal import Decimal, InvalidOperation
from zoneinfo import ZoneInfo


def validate_filters(value):
    if not isinstance(value, dict) or set(value) - {'date_basis', 'status', 'route'}:
        raise ValueError('Invalid detail filters')
    out = {'date_basis': 'submitted', 'status': 'submitted', 'route': '', **value}
    if out['date_basis'] not in ('submitted', 'delivery') or out['status'] not in ('submitted', 'cancelled', 'all'):
        raise ValueError('Invalid detail filters')
    if not isinstance(out['route'], str) or len(out['route']) > 120 or any(ord(c) < 32 for c in out['route']):
        raise ValueError('Invalid route')
    return out


def number(value):
    try:
        n = Decimal(str(value))
    except InvalidOperation as exc:
        raise RuntimeError('Invalid historical line amount or quantity') from exc
    if not n.is_finite() or n < 0:
        raise RuntimeError('Invalid historical line amount or quantity')
    return n


def calculate(result, customer, customers, products, orders, items, product, filters, start, end, limit):
    from .bmq_customer import normalized
    result = {**result, 'filters': filters, 'amount_basis': 'matching_historical_lines_not_order_total', 'currency': 'VND'}
    product_id = None
    if normalized(product):
        matches = [p for p in products if normalized(product) in {normalized(str(p.get(k) or '')) for k in ('id', 'sku_code', 'product_name')}]
        if len(matches) != 1:
            return {**result, 'status': 'product_not_unique'}
        product_id = matches[0]['id']
    route_id = None
    if normalized(filters['route']):
        matches = [c for c in customers if normalized(filters['route']) in {normalized(str(c.get(k) or '')) for k in ('id', 'customer_code', 'customer_name')}]
        if len(matches) != 1:
            return {**result, 'status': 'route_not_unique', 'route_candidates': [{k:c.get(k) for k in ('id','customer_code','customer_name')} for c in matches[:5]]}
        route_id = matches[0]['id']
    scoped = {}
    for order in orders:
        if order.get('customer_id') != customer['id']:
            continue
        if type(order.get('is_test')) is not bool:
            raise RuntimeError('Incomplete order flags')
        if order['is_test']:
            continue
        if order.get('status') not in ('submitted', 'cancelled'):
            raise RuntimeError('Unknown order status')
        if filters['status'] != 'all' and order['status'] != filters['status']:
            continue
        try:
            if filters['date_basis'] == 'delivery':
                day = date.fromisoformat(order['requested_delivery_date'])
            else:
                ts = datetime.fromisoformat(order['submitted_at'].replace('Z', '+00:00'))
                if ts.tzinfo is None:
                    raise ValueError('Timezone required')
                day = ts.astimezone(ZoneInfo('Asia/Ho_Chi_Minh')).date()
        except (ValueError, TypeError, KeyError, AttributeError) as exc:
            raise RuntimeError('Incomplete order date') from exc
        if not start <= day <= end:
            continue
        if order.get('currency') != 'VND' or not order.get('order_number'):
            raise RuntimeError('Invalid order currency or number')
        scoped[order['id']] = order
    if set(scoped) - {line.get('order_id') for line in items}:
        raise RuntimeError('Order detail source incomplete')
    rows, units = [], {}
    matched_orders = set()
    for line in items:
        order = scoped.get(line.get('order_id'))
        if not order or (product_id and line.get('sku_id') != product_id) or (route_id and line.get('route_customer_id') != route_id):
            continue
        if not all(line.get(k) for k in ('id', 'sku_code', 'product_name', 'unit')):
            raise RuntimeError('Incomplete historical line')
        for key in ('sku_code', 'product_name', 'unit', 'route_customer_name'):
            value = line.get(key)
            if value is not None and (not isinstance(value, str) or len(value) > 300 or any(ord(c) < 32 for c in value)):
                raise RuntimeError('Invalid historical line text')
        quantity, price, amount = (number(line.get(k)) for k in ('quantity', 'unit_price_vnd', 'line_total_vnd'))
        if abs(quantity * price - amount) > Decimal('0.01'):
            raise RuntimeError('Historical line amount mismatch')
        quantities = {k: number(line[k]) if line.get(k) is not None else None for k in ('ordered_quantity','exchange_quantity','makeup_quantity','physical_quantity')}
        if all(v is not None for v in quantities.values()):
            if quantities['ordered_quantity'] != quantity or quantities['physical_quantity'] != quantities['ordered_quantity'] + quantities['exchange_quantity'] + quantities['makeup_quantity']:
                raise RuntimeError('Historical quantity mismatch')
        # Snapshot name is intentionally not replaced with today's CRM name.
        rows.append({'line_id': line['id'], 'order_id': order['id'], 'order_number': order['order_number'],
                     'status': order['status'], 'submitted_at': order.get('submitted_at'),
                     'delivery_date': order.get('requested_delivery_date'), 'sku_code': line['sku_code'],
                     'product_name': line['product_name'], 'unit': line['unit'], 'quantity': quantity,
                     **quantities, 'unit_price_vnd': price, 'amount_vnd': amount,
                     'route_customer_id': line.get('route_customer_id'), 'route_customer_name': line.get('route_customer_name'),
                     'price_source': line.get('price_source'), 'currency': 'VND'})
        matched_orders.add(order['id'])
        totals = units.setdefault(line['unit'], {k: Decimal(0) for k in ('quantity', *quantities)})
        totals['quantity'] += quantity
        for k, v in quantities.items():
            totals[k] = None if v is None or totals[k] is None else totals[k] + v
    rows.sort(key=lambda r: (r['submitted_at'] or '', r['order_number'], r['line_id']), reverse=True)
    return {**result, 'status': 'ok', 'rows': rows[:limit], 'truncated': len(rows) > limit,
            'totals': {'matched_order_count': len(matched_orders), 'matched_line_count': len(rows),
                       'amount_vnd': sum((r['amount_vnd'] for r in rows), Decimal(0)),
                       'quantities_by_unit': [{'unit':unit, **values} for unit, values in sorted(units.items())]}}
