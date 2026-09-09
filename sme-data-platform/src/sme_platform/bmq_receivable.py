"""Read-only parity with NppDebtManagement.summaries, not a collections ledger.

Fees use the CURRENT active child mapping, once per selected period (including
zero-sale children), exactly as the app. This is not historical fee reconstruction.
"""
from decimal import Decimal
import re
import unicodedata


def name_key(value):
    value = unicodedata.normalize('NFD', str(value or '').lower())
    value = ''.join(c for c in value if not unicodedata.combining(c)).replace('đ', 'd')
    return re.sub('[^a-z0-9]+', ' ', value).strip()


def money(value):
    if value is None:
        return Decimal(0)  # Same null-as-zero convention as the existing screen.
    amount = Decimal(str(value))
    if not amount.is_finite():
        raise RuntimeError('Invalid financial amount')
    return amount


def calculate(result, customer, customers, lines, start, end, limit):
    if customer.get('is_npp') is not True:
        return {**result, 'status': 'not_npp'}
    if sum(name_key(c.get('customer_name')) == name_key(customer.get('customer_name')) for c in customers) != 1:
        raise RuntimeError('Ambiguous NPP names')
    children = [c for c in customers if c.get('supplied_by_npp_customer_id') == customer['id'] and c.get('is_active') is not False]
    by_id = {c['id']: c for c in children}
    by_name = {}
    for c in children:
        key = name_key(c.get('customer_name'))
        if not key or key in by_name:
            raise RuntimeError('Ambiguous NPP child names')
        by_name[key] = c
    def group(c):
        return {'customer_code': c.get('customer_code') or c.get('id') or '', 'customer_name': c.get('customer_name') or '',
                'gross': Decimal(0), 'management_fee': money(c.get('npp_management_fee_vnd')),
                'line_count': 0, 'currency': 'VND'}
    groups = {c['id']: group(c) for c in children}
    for line in lines:
        if line.get('approval_status') != 'approved':
            continue
        # Older snapshots without projected routing cannot silently return a total.
        if 'route_customer_id' not in line or 'route_customer_name' not in line:
            raise RuntimeError('Routing projection unavailable; synchronize first')
        day = line.get('revenue_date')
        if not isinstance(day, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', day):
            raise RuntimeError('Invalid revenue date')
        if not str(start) <= day <= str(end):
            continue
        child = by_id.get(str(line.get('route_customer_id') or '').strip()) or by_id.get(line.get('customer_id')) or by_name.get(name_key(line.get('route_customer_name')))
        belongs = line.get('parent_customer_id') == customer['id'] or line.get('customer_id') == customer['id'] or child is not None or name_key(line.get('customer_name')) == name_key(customer.get('customer_name'))
        if not belongs:
            continue
        key = child['id'] if child else 'unmapped'
        if key not in groups:
            groups[key] = group({'customer_code': 'unmapped', 'customer_name': 'Unmapped'})
        groups[key]['gross'] += money(line.get('gross_revenue'))
        groups[key]['line_count'] += 1
    rows = list(groups.values())
    for row in rows:
        row['period_payable'] = row['gross'] - row['management_fee']
    rows.sort(key=lambda row: (-row['gross'], row['customer_code']))
    totals = {field: sum((row[field] for row in rows), Decimal(0)) for field in ('gross', 'management_fee', 'period_payable')}
    totals['line_count'] = sum(row['line_count'] for row in rows)
    totals['currency'] = 'VND'
    return {**result, 'status': 'ok', 'rows': rows[:limit], 'totals': totals,
            'truncated': len(rows) > limit, 'group_count': len(rows),
            'definition': 'npp_debt_screen_period_v1',
            'unmapped_line_count': groups.get('unmapped', {}).get('line_count', 0)}
