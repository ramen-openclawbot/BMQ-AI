"""Read-only BMQ supplier-settlement answers over the raw Supabase snapshot.

Answers one reviewed question — "how much did we actually pay supplier X in month
M, and how much of it was for item I?" — from ``payments`` and the allocations
that bind each payment to a ``payment_request``.

Hard rules (matching the approved acceptance criteria):

- The accounting period is **``payments.payment_date`` only**. A payment request's
  ``created_at``/``paid_at``/invoice date never selects or moves a payment into a
  month, because a request can be created in August and settled in September.
- ``payment_date`` is a calendar ``date`` column: no timezone conversion is applied.
  A payment with a missing or unparsable ``payment_date`` has unknown membership and
  fails closed; a payment with a valid date clearly outside the requested month is
  ignored and never poisons that month.
- A payment is counted **once**. A payment tagged with the resolved supplier is
  counted at its full amount; a multi-supplier payment (``supplier_id`` null) is
  counted only through its allocation to this supplier's requests. The whole shared
  payment is never duplicated into this supplier's total. When a supplier total is
  asserted, every null-supplier in-month payment must have its full amount covered by
  allocations to known request suppliers, so no slice of unknown-supplier money is
  hidden from (or silently added to) the scoped total.
- The supplier-level total is **distinct** from any item-level amount. An item
  amount is published only when every allocation in scope belongs to a request whose
  items all resolve to the queried material (or exact product name). Partial
  allocations do not get scaled; mixed-item requests and rows without a canonical
  material id make the item amount explicitly *unavailable*, never zero and never a
  proportional guess.
- A request's ``total_amount`` bounds how much of a payment may be attributed to it.
  A missing or non-finite request total cannot prove that bound and fails closed
  rather than silently removing the capacity check.
- Unknown/orphan/mismatched rows fail closed (``RuntimeError``) instead of being
  silently dropped. Owner only, fixed parameterized reads, no writes, no SQL text
  from the caller, no PII.
"""
from __future__ import annotations

import calendar
from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
import json
import re
import threading
import unicodedata

from .supabase_sync import PAYMENT_PROJECTION_FIELDS, TENANT, VERSION as SYNC_VERSION

VERSION = 'bmq-supplier-payment-v1'
STALE_SECONDS = 1800
MAX_LIMIT = 50
DEFAULT_LIMIT = 20
MAX_TERM = 120
MAX_CANDIDATES = 5
MAX_UNRESOLVED_ITEMS = 10
REQUIRED_TABLES = (
    'payments', 'payment_allocations', 'payment_requests',
    'payment_request_items', 'suppliers', 'sku_cogs_materials',
)
SOURCE = ('Supabase.payments + payment_allocations + payment_requests '
          '+ payment_request_items + suppliers + sku_cogs_materials')

QUESTIONS = {
    'supplier_payments': {
        'label': 'Actual supplier payments in one month',
        'label_vi': 'Thanh toán thực tế cho một nhà cung cấp trong tháng',
        'required': ('month',),
        'optional': ('supplier', 'item', 'limit'),
        'description': (
            'Exact factory supplier payments whose payments.payment_date falls inside the requested '
            'Vietnam calendar month, optionally narrowed to one exactly-resolved supplier and one item. '
            'The supplier total counts each payment once (a multi-supplier payment only through its '
            'allocation to this supplier). Any item amount is published only when every allocation in '
            'scope belongs to a request whose items all resolve to that item; mixed, partial or '
            'unresolved-canonical allocations make the item amount explicitly unavailable rather than a '
            'proportional or full-payment guess. Not an audited statement, not supplier debt, and not '
            'a customer receipt.'),
    },
}


def catalog():
    return {'version': VERSION, 'source': SOURCE,
            'questions': [{'id': qid, **{k: v for k, v in spec.items() if k != 'description'}}
                          for qid, spec in QUESTIONS.items()],
            'accepted_qualifiers': {
                'month': 'exactly one YYYY-MM, not in the future',
                'supplier': 'exact normalized supplier name, short code or id; a partial/ambiguous name clarifies',
                'item': 'exact normalized canonical material code/name or exact request product name; unmatched is stated, never guessed',
                'limit': '1..50 payments in the returned list',
            },
            'abstains': ('day/week/quarter periods, other currencies, payment method/status/account filters, '
                         'multiple suppliers or items, and any unparsable qualifier abstain instead of widening '
                         'to an all-supplier total'),
            'policy': ('payments.payment_date is the sole period basis. One payment counted once. Supplier total '
                       'is never presented as an item amount. Unknown/orphan/mismatched rows fail closed. Owner '
                       'only; fixed parameterized reads; no arbitrary SQL; no writes; no contact PII.')}


def _norm(value):
    """Diacritic-folded, case-folded, whitespace-collapsed comparison key."""
    text = str(value if value is not None else '').replace('đ', 'd').replace('Đ', 'D')
    text = unicodedata.normalize('NFD', text)
    text = ''.join(ch for ch in text if not unicodedata.combining(ch))
    return ' '.join(text.casefold().split())


def _month(value, field='month'):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}', value):
        raise ValueError('Invalid %s: expected YYYY-MM' % field)
    year, month = int(value[:4]), int(value[5:])
    if not 2000 <= year <= 2100 or not 1 <= month <= 12:
        raise ValueError('Invalid %s' % field)
    return date(year, month, 1)


def _limit(value):
    if value is None:
        return DEFAULT_LIMIT
    if type(value) is not int or not 1 <= value <= MAX_LIMIT:
        raise ValueError('Invalid limit')
    return value


def _term(value, field):
    if value is None or value == '':
        return None
    if not isinstance(value, str) or len(value) > MAX_TERM or any(ord(c) < 32 for c in value):
        raise ValueError('Invalid %s' % field)
    if not value.strip():
        return None
    return value.strip()


def validate_request(request):
    """Closed request grammar; unknown fields and identity are rejected."""
    if not isinstance(request, dict):
        raise ValueError('Invalid payment request')
    if set(request) - {'question', 'month', 'supplier', 'item', 'limit'}:
        raise ValueError('Unsupported payment request field')
    if request.get('question') != 'supplier_payments':
        raise ValueError('Unknown payment question')
    return {'question': 'supplier_payments',
            'month': _month(request.get('month')),
            'supplier': _term(request.get('supplier'), 'supplier'),
            'item': _term(request.get('item'), 'item'),
            'limit': _limit(request.get('limit'))}


def _amount(value, field='amount'):
    if value is None or isinstance(value, bool):
        raise RuntimeError('Invalid or missing %s' % field)
    try:
        parsed = Decimal(str(value))
    except (InvalidOperation, ValueError):
        raise RuntimeError('Invalid %s' % field) from None
    if not parsed.is_finite():
        raise RuntimeError('Invalid %s' % field)
    return parsed


def _date(value):
    if isinstance(value, date):
        return value
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value[:10]):
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def _source(con, tenant, table):
    """Fixed projection read for one whitelisted source table (no caller SQL)."""
    rows = con.execute(
        'SELECT payload FROM bronze.supabase_current WHERE tenant_id=? AND source_table=? ORDER BY source_id',
        [tenant, table]).fetchall()
    return [json.loads(row[0], parse_float=Decimal) for row in rows]


def _index(rows, label):
    """Non-empty unique identity per row; a duplicate id must never erase a row."""
    index = {}
    for row in rows:
        key = row.get('id')
        if not isinstance(key, str) or not key:
            raise RuntimeError('Source has an invalid %s id' % label)
        if key in index:
            raise RuntimeError('Source has a duplicate %s id' % label)
        index[key] = row
    return index


def _public_supplier(supplier):
    return {key: supplier.get(key) for key in ('id', 'name', 'short_code')}


def _resolve_supplier(suppliers, term):
    """Exact normalized match only for automatic resolution; prefixes clarify."""
    key = _norm(term)
    if not key:
        return None, 'not_found', []
    exact = [s for s in suppliers
             if key in {_norm(s.get('id')), _norm(s.get('name')), _norm(s.get('short_code'))}]
    if len(exact) == 1:
        return exact[0], 'resolved', []
    if len(exact) > 1:
        return None, 'ambiguous', exact
    candidates = [s for s in suppliers if _norm(s.get('name')).startswith(key + ' ')]
    if len(candidates) == 1:
        return None, 'not_found', candidates
    if len(candidates) > 1:
        return None, 'ambiguous', candidates
    return None, 'not_found', []


def _resolve_item(materials, items, term):
    """Resolve to one canonical material, else one exact request product name."""
    key = _norm(term)
    matches = [m for m in materials
               if key in {_norm(m.get('material_code')), _norm(m.get('canonical_name')), _norm(m.get('normalized_name'))}]
    if len(matches) == 1 and key:
        return {'mode': 'material', 'material': matches[0], 'product_name': None, 'status': 'resolved', 'candidates': []}
    if len(matches) > 1:
        return {'mode': None, 'material': None, 'product_name': None, 'status': 'ambiguous',
                'candidates': [m.get('canonical_name') or m.get('material_code') for m in matches[:MAX_CANDIDATES]]}
    products = []
    for item in items:
        for name in (item.get('product_name'), item.get('raw_product_name')):
            if name and _norm(name) == key and key:
                products.append(name)
    products = sorted(set(products))
    if len(products) == 1:
        return {'mode': 'product', 'material': None, 'product_name': products[0], 'status': 'resolved', 'candidates': []}
    if len(products) > 1:
        return {'mode': None, 'material': None, 'product_name': None, 'status': 'ambiguous',
                'candidates': products[:MAX_CANDIDATES]}
    return {'mode': None, 'material': None, 'product_name': None, 'status': 'not_found', 'candidates': []}


def _item_material_id(item, material_ids):
    value = item.get('canonical_material_id')
    return value if value and value in material_ids else None


def _item_product_key(item):
    return _norm(item.get('product_name') or item.get('raw_product_name'))


def _answer(con, request, latest, now):
    month = request['month']
    year, month_number = month.year, month.month
    start, end = month, date(year, month_number, calendar.monthrange(year, month_number)[1])

    suppliers = _index(_source(con, TENANT, 'suppliers'), 'supplier')
    materials = _index(_source(con, TENANT, 'sku_cogs_materials'), 'canonical material')
    material_ids = set(materials)
    requests = _index(_source(con, TENANT, 'payment_requests'), 'payment request')
    items = _index(_source(con, TENANT, 'payment_request_items'), 'payment request item')
    payments = _index(_source(con, TENANT, 'payments'), 'payment')
    allocations = _index(_source(con, TENANT, 'payment_allocations'), 'payment allocation')

    items_by_request = {}
    for item in items.values():
        items_by_request.setdefault(item.get('payment_request_id'), []).append(item)

    alloc_by_payment = {}
    for allocation in allocations.values():
        alloc_by_payment.setdefault(allocation.get('payment_id'), []).append(allocation)

    # Membership validation is scoped to the requested month: a payment with a valid date
    # that is clearly outside the period cannot change this month's total or item
    # attribution and must not poison the answer. A missing or unparsable payment_date is
    # different: its membership is unknown, so it might belong to this month and must fail
    # closed instead of being silently dropped into a plausible zero.
    in_month = []
    for payment in payments.values():
        day = _date(payment.get('payment_date'))
        if day is None:
            raise RuntimeError('Source has a payment with an invalid or missing payment date')
        if start <= day <= end:
            if _amount(payment.get('amount'), 'payment amount') <= 0:
                raise RuntimeError('Source has a non-positive payment amount')
            in_month.append(payment)

    seen_numbers = set()
    for payment in in_month:
        number = payment.get('payment_number')
        if number in seen_numbers:
            raise RuntimeError('Source has a duplicate payment number')
        seen_numbers.add(number)

    # A supplier-tagged payment must prove how it was applied, and every allocation must
    # agree with the tagged supplier, stay within the payment, and reference a real
    # request. A missing request supplier cannot support a verified supplier total. A
    # multi-supplier (null supplier) payment's every allocation must also name a known
    # request supplier, so no slice of it can hide behind an unknown supplier.
    alloc_by_request = {}
    for payment in in_month:
        tagged = payment.get('supplier_id')
        payment_amount = _amount(payment.get('amount'), 'payment amount')
        payment_allocations = alloc_by_payment.get(payment.get('id'), [])
        if tagged and not payment_allocations:
            raise RuntimeError('Supplier payment has no allocation')
        allocated = Decimal(0)
        seen_request_ids = set()
        for allocation in payment_allocations:
            request_id = allocation.get('payment_request_id')
            if request_id in seen_request_ids:
                raise RuntimeError('Source has a duplicate payment allocation')
            seen_request_ids.add(request_id)
            value = _amount(allocation.get('amount'), 'allocation amount')
            if value <= 0:
                raise RuntimeError('Source has a non-positive allocation amount')
            linked_request = requests.get(request_id)
            if linked_request is None:
                raise RuntimeError('Source has an allocation to a missing request')
            if tagged:
                if linked_request.get('supplier_id') != tagged:
                    raise RuntimeError('Payment allocation supplier mismatch')
            elif not linked_request.get('supplier_id'):
                raise RuntimeError('Payment allocation has an unknown request supplier')
            allocated += value
            alloc_by_request[request_id] = alloc_by_request.get(request_id, Decimal(0)) + value
        if allocated > payment_amount:
            raise RuntimeError('Payment allocations exceed the payment amount')

    # A request total is what bounds how much of a payment may be attributed to that
    # request. It must be present and finite; a missing or non-finite total cannot prove
    # an attribution, so it fails closed instead of silently removing the capacity check.
    for request_id, allocated in alloc_by_request.items():
        total = requests[request_id].get('total_amount')
        if total is None or total == '':
            raise RuntimeError('Payment request total is missing')
        total_value = _amount(total, 'payment request total')
        if allocated > total_value:
            raise RuntimeError('Payment allocations exceed the request total')

    result = {'question': 'supplier_payments', 'month': '%04d-%02d' % (year, month_number),
              'currency': 'VND', 'payment_date_basis': 'payments.payment_date', 'limit': request['limit']}

    supplier, supplier_status, supplier_candidates = (None, 'not_requested', [])
    if request['supplier']:
        supplier, supplier_status, supplier_candidates = _resolve_supplier(suppliers.values(), request['supplier'])
    result['supplier'] = _public_supplier(supplier) if supplier else None
    result['supplier_status'] = supplier_status
    result['supplier_candidates'] = [_public_supplier(s) for s in supplier_candidates[:MAX_CANDIDATES]]
    if supplier_status in ('ambiguous', 'not_found'):
        return result

    # In-scope payments: one resolved supplier, else every payment in the month.
    if supplier:
        supplier_id = supplier['id']
        direct = [p for p in in_month if p.get('supplier_id') == supplier_id]
        shared = [p for p in in_month if not p.get('supplier_id')]
        scoped_requests = {r.get('id') for r in requests.values() if r.get('supplier_id') == supplier_id}
        direct_total = sum((_amount(p.get('amount')) for p in direct), Decimal(0))
        entries, shared_total, shared_used = [], Decimal(0), []
        for payment in direct:
            entries.append({'payment_number': payment.get('payment_number'),
                            'payment_date': _date(payment.get('payment_date')).isoformat(),
                            'amount': _amount(payment.get('amount')),
                            'attributed_amount': _amount(payment.get('amount')),
                            'payment_method': payment.get('payment_method'), 'shared': False})
        for payment in shared:
            # A null-supplier payment only belongs to a supplier through its allocations.
            # If those allocations do not cover the whole payment there is unattributed
            # money whose supplier is unknown, so a scoped supplier total would hide it.
            # Fail closed rather than silently dropping that slice.
            coverage = sum((_amount(a.get('amount')) for a in alloc_by_payment.get(payment.get('id'), [])),
                           Decimal(0))
            if coverage != _amount(payment.get('amount')):
                raise RuntimeError('Multi-supplier payment allocation does not cover the payment amount')
            attributed = sum((_amount(a.get('amount')) for a in alloc_by_payment.get(payment.get('id'), [])
                              if a.get('payment_request_id') in scoped_requests), Decimal(0))
            if attributed <= 0:
                continue
            shared_used.append(payment)
            entries.append({'payment_number': payment.get('payment_number'),
                            'payment_date': _date(payment.get('payment_date')).isoformat(),
                            'amount': _amount(payment.get('amount')),
                            'attributed_amount': attributed,
                            'payment_method': payment.get('payment_method'), 'shared': True})
            shared_total += attributed
        total = direct_total + shared_total
        scoped_payments = direct + shared_used
    else:
        direct_total = None
        shared_total = Decimal(0)
        total = sum((_amount(p.get('amount')) for p in in_month), Decimal(0))
        entries = [{'payment_number': p.get('payment_number'),
                    'payment_date': _date(p.get('payment_date')).isoformat(),
                    'amount': _amount(p.get('amount')), 'attributed_amount': _amount(p.get('amount')),
                    'payment_method': p.get('payment_method'), 'shared': False} for p in in_month]
        scoped_requests = None
        scoped_payments = in_month

    result['payment_count'] = len(entries)
    result['total_amount'] = total
    result['direct_total'] = direct_total
    result['shared_allocated_total'] = shared_total
    entries.sort(key=lambda e: (e['payment_date'], e['payment_number'] or ''), reverse=True)
    result['truncated'] = len(entries) > request['limit']
    result['payments'] = entries[:request['limit']]

    # Payment-request items that belong to the in-scope payments.
    scope_request_ids = set()
    for payment in scoped_payments:
        for allocation in alloc_by_payment.get(payment.get('id'), []):
            request_id = allocation.get('payment_request_id')
            if supplier is None or requests[request_id].get('supplier_id') == supplier['id']:
                scope_request_ids.add(request_id)
    scope_items = [item for request_id in scope_request_ids for item in items_by_request.get(request_id, [])]

    unresolved = [item for item in scope_items if _item_material_id(item, material_ids) is None]
    result['unresolved_item_count'] = len(unresolved)
    result['candidate_items'] = sorted({item.get('product_name') or item.get('raw_product_name') or ''
                                        for item in unresolved})[:MAX_UNRESOLVED_ITEMS]

    if not request['item']:
        result['item'] = None
        result['item_status'] = 'not_requested'
        result['item_amount'] = None
        result['mixed_allocation_count'] = 0
        result['unresolved_allocation_count'] = 0
        return result

    resolved = _resolve_item(materials.values(), items.values(), request['item'])
    result['item'] = {'term': request['item'], 'mode': resolved['mode'],
                      'product_name': resolved['product_name'],
                      'material': ({'id': resolved['material'].get('id'),
                                    'material_code': resolved['material'].get('material_code'),
                                    'canonical_name': resolved['material'].get('canonical_name')}
                                   if resolved['material'] else None)}
    result['item_candidates'] = resolved['candidates']
    if resolved['status'] in ('ambiguous', 'not_found'):
        result['item_status'] = resolved['status']
        result['item_amount'] = None
        result['mixed_allocation_count'] = 0
        result['unresolved_allocation_count'] = 0
        return result

    mode = resolved['mode']
    material_id = resolved['material'].get('id') if mode == 'material' else None
    product_key = _norm(resolved['product_name']) if mode == 'product' else None

    attributable, mixed, unresolved_allocations = Decimal(0), 0, 0
    for payment in scoped_payments:
        for allocation in alloc_by_payment.get(payment.get('id'), []):
            request_id = allocation.get('payment_request_id')
            if supplier is not None and requests[request_id].get('supplier_id') != supplier['id']:
                continue
            request_items = items_by_request.get(request_id, [])
            matched = exclusive = False
            others_resolved = unresolved_here = False
            for item in request_items:
                item_material = _item_material_id(item, material_ids)
                item_product = _item_product_key(item)
                if mode == 'material':
                    if item_material == material_id:
                        matched = True
                    elif item_material is not None:
                        others_resolved = True
                    else:
                        unresolved_here = True
                else:
                    # Product-name resolution: a row that already has a canonical
                    # material identity is never equated to a bare product name. A
                    # same-name row with a material link is an identity conflict and
                    # stays unresolved rather than becoming an exact match or zero.
                    if item_material is not None:
                        unresolved_here = unresolved_here or item_product == product_key
                        others_resolved = others_resolved or item_product != product_key
                    elif item_product == product_key:
                        matched = True
                    elif item_product:
                        others_resolved = True
                    else:
                        unresolved_here = True
            if not request_items:
                unresolved_here = True
            exclusive = matched and not others_resolved and not unresolved_here
            if exclusive:
                attributable += _amount(allocation.get('amount'))
            elif unresolved_here:
                unresolved_allocations += 1
            elif matched and others_resolved:
                mixed += 1
    result['mixed_allocation_count'] = mixed
    result['unresolved_allocation_count'] = unresolved_allocations
    # An unresolved or mixed allocation means the item portion cannot be proven, so it
    # is reported as unavailable instead of a proportional or whole-payment guess.
    if mixed or unresolved_allocations or (scoped_payments and any(
            not alloc_by_payment.get(p.get('id')) for p in scoped_payments)):
        result['item_status'] = 'unavailable'
        result['item_amount'] = None
    else:
        result['item_status'] = 'exact'
        result['item_amount'] = attributable
    return result


def _provenance(latest, now):
    return {'source': SOURCE, 'source_observed_at': latest[1].isoformat(), 'snapshot_id': latest[0],
            'semantic_version': VERSION, 'sync_version': SYNC_VERSION, 'read_at': now.isoformat(), 'cache_hit': False}


def _projection_gaps(manifest):
    """Column-completeness gate: an older/incomplete projection must never answer."""
    tables = manifest.get('tables', {})
    if manifest.get('version') != SYNC_VERSION:
        return ['sync_version=%s' % (manifest.get('version') or 'unknown')]
    gaps = []
    for table, required in PAYMENT_PROJECTION_FIELDS.items():
        declared = set(tables.get(table, {}).get('fields') or [])
        missing = [field for field in required if field not in declared]
        if missing:
            gaps.append('%s:%s' % (table, ','.join(missing)))
    return gaps


def execute(engine, request, tenant, permission):
    if tenant != TENANT or not (permission == 'owner' or permission.startswith('owner:')):
        raise PermissionError('Owner required')
    normalized = validate_request(request)
    warehouse = engine.warehouse
    with warehouse.lock(write=False), warehouse.connect(read_only=True) as con:
        exists = con.execute("SELECT count(*) FROM information_schema.tables WHERE table_name='meta_supabase_sync_runs'").fetchone()[0]
        if not exists:
            raise RuntimeError('Supabase snapshot not available')
        latest = con.execute('SELECT run_id, observed_at, completed_at, manifest FROM meta_supabase_sync_runs ORDER BY observed_at DESC LIMIT 1').fetchone()
        if not latest:
            raise RuntimeError('Supabase snapshot not available')
        manifest = json.loads(latest[3])
        if manifest.get('tenant') != tenant:
            raise RuntimeError('Supabase snapshot not available')
        tables = manifest.get('tables', {})
        now = datetime.now(timezone.utc)
        age = (now - latest[1]).total_seconds()
        if age < -60 or age > STALE_SECONDS:
            raise RuntimeError('Supabase snapshot is stale')
        missing = [table for table in REQUIRED_TABLES if not (table in tables and tables[table].get('reconciled') is True)]
        if missing:
            raise RuntimeError('Required source tables not synchronized')
        if _projection_gaps(manifest):
            raise RuntimeError('Supabase snapshot payment projection is incomplete; re-sync required')
        con.execute('SET enable_external_access=false')
        timer = threading.Timer(warehouse.settings.query_timeout, con.interrupt)
        timer.start()
        try:
            output = _answer(con, normalized, latest, now)
        finally:
            timer.cancel()
        output.update(_provenance(latest, now))
        return output
