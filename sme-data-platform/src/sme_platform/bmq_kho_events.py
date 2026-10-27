"""Read-only canonical kitchen event log over the raw Supabase snapshot.

The five sources mirror ``public.kho_get_audit_log()``
(apps/web/supabase/migrations/20261103070000_kho_audit_log.sql):

- ``tan_tao_material_movements`` (Tân Tạo ledger)
- ``q7_inventory_movements`` (Q7 ledger)
- ``stock_transfers`` (one row per transfer; the ledger transfer_out /
  transfer_in rows produced by the same transfer are excluded so a transfer is
  never counted twice)
- ``kho_audit_log`` (item catalog audit)
- ``stock_unit_events`` (unit catalog audit)

Each event carries a fixed Vietnamese label (``event_type``), rule flags and
``label_version='kho-rules-v1'``. Labels and flags are computed only from the
source scalars; no model, arbitrary SQL, writes or profile lookup is used.

Fixed rules:

- ``nhap_kho``: receipt movement.
- ``dung_san_xuat``: production_usage movement.
- ``chuyen_kho``: a stock transfer (or a transfer ledger row not produced by a
  stock transfer).
- ``kiem_ke``: an adjustment whose source_ref_key is a Tân Tạo/Q7 stock-count
  key.
- ``ton_dau_ky``: opening movement.
- ``dieu_chinh``: every other movement adjustment.
- ``sua_danh_muc``: every item catalog audit action except ``unit_changed``.
- ``don_vi``: ``stock_unit_events`` and catalog ``unit_changed``.

Flags are counted per event over the requested date range:

- ``dieu_chinh_lon``: an adjustment whose absolute quantity is greater than 3x
  the median absolute quantity of the same item in the preceding 90 days, with
  at least five reference events.
- ``sua_don_vi_sau_phat_sinh``: a unit event on an item that already had a
  warehouse transaction before it.
- ``chuyen_kho_thu_cong``: a stock transfer whose source is not
  ``auto_goods_receipt``.
- ``ngoai_gio``: occurred from 23:00 to before 05:00 Asia/Ho_Chi_Minh.
- ``thieu_nguoi_lam``: no actor UUID on the event.
"""
from __future__ import annotations

from bisect import bisect_left, insort
from collections import defaultdict, deque
from datetime import date, datetime, time, timedelta, timezone
from statistics import median
from zoneinfo import ZoneInfo
import json
import re
import threading

from .supabase_sync import TENANT, VERSION as SYNC_VERSION

VERSION = 'bmq-kho-events-v1'
LABEL_VERSION = 'kho-rules-v1'
STALE_SECONDS = 1800
DEFAULT_LIMIT = 200
MAX_LIMIT = 1000
MAX_RANGE_DAYS = 92
ADJUSTMENT_WINDOW_DAYS = 90
ADJUSTMENT_MEDIAN_MULTIPLE = 3
ADJUSTMENT_MIN_REFERENCES = 5
REFERENCE_PATTERN = re.compile(r'^[A-Za-z0-9][A-Za-z0-9-]{0,63}$')
TIMEZONE = ZoneInfo('Asia/Ho_Chi_Minh')

EVENT_TYPES = ('nhap_kho', 'dung_san_xuat', 'chuyen_kho', 'kiem_ke',
               'ton_dau_ky', 'dieu_chinh', 'sua_danh_muc', 'don_vi')
EVENT_TYPE_LABELS = {
    'nhap_kho': 'Nhập kho',
    'dung_san_xuat': 'Dùng sản xuất',
    'chuyen_kho': 'Chuyển kho',
    'kiem_ke': 'Kiểm kê',
    'ton_dau_ky': 'Tồn đầu kỳ',
    'dieu_chinh': 'Điều chỉnh',
    'sua_danh_muc': 'Sửa danh mục',
    'don_vi': 'Đơn vị',
}

FLAG_DEFINITIONS = (
    {'code': 'dieu_chinh_lon',
     'description_vi': 'Điều chỉnh có trị tuyệt đối lớn hơn 3 lần trung vị trị tuyệt đối số lượng '
                       'của cùng món trong 90 ngày, với ít nhất 5 dòng tham chiếu.',
     'label_version': LABEL_VERSION, 'window_days': ADJUSTMENT_WINDOW_DAYS,
     'multiple': ADJUSTMENT_MEDIAN_MULTIPLE, 'min_reference_rows': ADJUSTMENT_MIN_REFERENCES},
    {'code': 'sua_don_vi_sau_phat_sinh',
     'description_vi': 'Sự kiện đơn vị hoặc sửa danh mục đổi đơn vị trên món đã có giao dịch kho trước đó.',
     'label_version': LABEL_VERSION},
    {'code': 'chuyen_kho_thu_cong',
     'description_vi': 'Phiếu chuyển kho có nguồn khác auto_goods_receipt.',
     'label_version': LABEL_VERSION},
    {'code': 'ngoai_gio',
     'description_vi': 'Sự kiện xảy ra từ 23:00 đến trước 05:00 giờ Asia/Ho_Chi_Minh.',
     'label_version': LABEL_VERSION},
    {'code': 'thieu_nguoi_lam',
     'description_vi': 'Sự kiện không có mã người làm.',
     'label_version': LABEL_VERSION},
)
FLAG_CODES = tuple(flag['code'] for flag in FLAG_DEFINITIONS)

REQUIRED_TABLES = ('tan_tao_material_movements', 'q7_inventory_movements',
                   'stock_transfers', 'kho_audit_log', 'stock_unit_events')
KHO_PROJECTION_FIELDS = {
    'tan_tao_material_movements': ('id', 'kitchen_inventory_item_id', 'movement_date', 'movement_type',
                                   'quantity', 'unit', 'source', 'source_ref_id', 'source_ref_key',
                                   'created_by', 'created_at'),
    'q7_inventory_movements': ('id', 'kitchen_inventory_item_id', 'movement_date', 'movement_type',
                               'quantity', 'unit', 'source', 'source_ref_id', 'source_ref_key', 'created_by',
                               'created_at'),
    'stock_transfers': ('id', 'transfer_number', 'from_location', 'to_location', 'kitchen_inventory_item_id',
                        'quantity', 'unit', 'transfer_date', 'source', 'goods_receipt_item_id',
                        'created_by', 'created_at'),
    'kho_audit_log': ('id', 'occurred_at', 'actor_id', 'action', 'item_id', 'item_name', 'source'),
    'stock_unit_events': ('id', 'action', 'unit', 'item_id', 'actor', 'created_at'),
}
SOURCE = 'Supabase.kho_get_audit_log (Tân Tạo + Q7 ledgers, stock_transfers, kho_audit_log, stock_unit_events)'


def catalog():
    return {'version': VERSION, 'label_version': LABEL_VERSION, 'source': SOURCE,
            'event_types': [{'code': code, 'label_vi': EVENT_TYPE_LABELS[code]} for code in EVENT_TYPES],
            'flags': [dict(flag) for flag in FLAG_DEFINITIONS],
            'accepted_filters': {
                'from_date': 'required YYYY-MM-DD, inclusive Asia/Ho_Chi_Minh date',
                'to_date': 'required YYYY-MM-DD, inclusive; from_date..to_date at most 92 days',
                'kho': 'tan_tao or q7',
                'event_type': 'one fixed event_type code',
                'flag': 'one fixed flag code',
                'item_id': 'exact kitchen item UUID',
                'limit': '1..1000, default 200',
            },
            'policy': ('Owner only; fixed read-only SQL over bronze.supabase_current. One row per stock transfer, '
                       'no double counting of its ledger transfer_out/transfer_in rows. Labels and flags are fixed '
                       'rules, never a model. Actor UUIDs are returned without profiles/names; notes, changes and '
                       'details JSON are never read.')}


def _date(value, field):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}-\d{2}', value):
        raise ValueError('Invalid %s: expected YYYY-MM-DD' % field)
    try:
        parsed = date.fromisoformat(value)
    except ValueError:
        raise ValueError('Invalid %s' % field) from None
    if not 2000 <= parsed.year <= 2100:
        raise ValueError('Invalid %s' % field)
    return parsed


def _limit(value):
    if value is None:
        return DEFAULT_LIMIT
    if type(value) is not int or not 1 <= value <= MAX_LIMIT:
        raise ValueError('Invalid limit')
    return value


def validate_request(request):
    """Closed request grammar; dates are mandatory and the range is bounded."""
    if not isinstance(request, dict):
        raise ValueError('Invalid kho event request')
    allowed = {'from_date', 'to_date', 'kho', 'event_type', 'flag', 'item_id', 'limit'}
    if set(request) - allowed:
        raise ValueError('Unsupported kho event request field')
    for key in ('from_date', 'to_date'):
        if request.get(key) in (None, ''):
            raise ValueError('Missing %s' % key)
    from_date = _date(request['from_date'], 'from_date')
    to_date = _date(request['to_date'], 'to_date')
    if to_date < from_date:
        raise ValueError('to_date must not be before from_date')
    if (to_date - from_date).days + 1 > MAX_RANGE_DAYS:
        raise ValueError('Date range must be at most 92 days')
    normalized = {'from_date': from_date, 'to_date': to_date}
    if request.get('kho') not in (None, ''):
        if request['kho'] not in ('tan_tao', 'q7'):
            raise ValueError('Invalid kho')
        normalized['kho'] = request['kho']
    if request.get('event_type') not in (None, ''):
        if request['event_type'] not in EVENT_TYPES:
            raise ValueError('Invalid event_type')
        normalized['event_type'] = request['event_type']
    if request.get('flag') not in (None, ''):
        if request['flag'] not in FLAG_CODES:
            raise ValueError('Invalid flag')
        normalized['flag'] = request['flag']
    if request.get('item_id') not in (None, ''):
        item_id = request['item_id']
        if not isinstance(item_id, str) or not REFERENCE_PATTERN.fullmatch(item_id):
            raise ValueError('Invalid item_id')
        normalized['item_id'] = item_id
    normalized['limit'] = _limit(request.get('limit'))
    return normalized


def _run(con, sql, params, warehouse):
    con.execute('SET enable_external_access=false')
    timer = threading.Timer(warehouse.settings.query_timeout, con.interrupt)
    timer.start()
    try:
        cursor = con.execute(sql, params)
        names = [column[0] for column in cursor.description]
        return [dict(zip(names, row)) for row in cursor.fetchall()]
    finally:
        timer.cancel()


def _events_sql():
    return """
WITH src AS (
  SELECT source_table, source_id, payload::JSON AS p
  FROM bronze.supabase_current WHERE tenant_id = ?
),
unified AS (
  SELECT
    TRY_CAST(p->>'created_at' AS TIMESTAMPTZ) AS occurred_at,
    'tan_tao'::VARCHAR AS kho,
    CASE
      WHEN (p->>'movement_type') = 'receipt' THEN 'nhap_kho'
      WHEN (p->>'movement_type') = 'production_usage' THEN 'dung_san_xuat'
      WHEN (p->>'movement_type') = 'opening' THEN 'ton_dau_ky'
      WHEN (p->>'movement_type') = 'adjustment'
        AND coalesce(p->>'source_ref_key', '') LIKE 'tt-material-count:%' THEN 'kiem_ke'
      WHEN (p->>'movement_type') IN ('transfer_out', 'transfer_in') THEN 'chuyen_kho'
      ELSE 'dieu_chinh'
    END::VARCHAR AS event_type,
    p->>'kitchen_inventory_item_id' AS item_id,
    TRY_CAST(p->>'quantity' AS DECIMAL(28,6)) AS quantity,
    p->>'unit' AS unit,
    p->>'created_by' AS actor_id,
    'tan_tao_material_movements'::VARCHAR AS source_table,
    p->>'id' AS source_id,
    coalesce(nullif(p->>'source_ref_key', ''), nullif(p->>'source_ref_id', '')) AS document_ref,
    p->>'source' AS raw_source
  FROM src
  WHERE source_table = 'tan_tao_material_movements'
    AND NOT ((p->>'movement_type') = 'transfer_out' AND (p->>'source') = 'stock_transfer')
  UNION ALL
  SELECT
    TRY_CAST(p->>'created_at' AS TIMESTAMPTZ),
    'q7'::VARCHAR,
    CASE
      WHEN (p->>'movement_type') = 'receipt' THEN 'nhap_kho'
      WHEN (p->>'movement_type') = 'production_usage' THEN 'dung_san_xuat'
      WHEN (p->>'movement_type') = 'opening' THEN 'ton_dau_ky'
      WHEN (p->>'movement_type') = 'adjustment'
        AND coalesce(p->>'source_ref_key', '') LIKE 'q7-stock-count:%' THEN 'kiem_ke'
      WHEN (p->>'movement_type') IN ('transfer_out', 'transfer_in') THEN 'chuyen_kho'
      ELSE 'dieu_chinh'
    END::VARCHAR,
    p->>'kitchen_inventory_item_id',
    TRY_CAST(p->>'quantity' AS DECIMAL(28,6)),
    p->>'unit',
    p->>'created_by',
    'q7_inventory_movements'::VARCHAR,
    p->>'id',
    coalesce(nullif(p->>'source_ref_key', ''), nullif(p->>'source_ref_id', '')),
    p->>'source'
  FROM src
  WHERE source_table = 'q7_inventory_movements'
    AND NOT ((p->>'movement_type') = 'transfer_in' AND (p->>'source') = 'stock_transfer')
  UNION ALL
  SELECT
    TRY_CAST(p->>'created_at' AS TIMESTAMPTZ),
    CAST(NULL AS VARCHAR),
    'chuyen_kho'::VARCHAR,
    p->>'kitchen_inventory_item_id',
    TRY_CAST(p->>'quantity' AS DECIMAL(28,6)),
    p->>'unit',
    p->>'created_by',
    'stock_transfers'::VARCHAR,
    p->>'id',
    p->>'transfer_number',
    p->>'source'
  FROM src WHERE source_table = 'stock_transfers'
  UNION ALL
  SELECT
    TRY_CAST(p->>'occurred_at' AS TIMESTAMPTZ),
    CAST(NULL AS VARCHAR),
    CASE WHEN (p->>'action') = 'unit_changed' THEN 'don_vi' ELSE 'sua_danh_muc' END::VARCHAR,
    p->>'item_id',
    CAST(NULL AS DECIMAL(28,6)),
    CAST(NULL AS VARCHAR),
    p->>'actor_id',
    'kho_audit_log'::VARCHAR,
    p->>'id',
    CAST(NULL AS VARCHAR),
    p->>'source'
  FROM src WHERE source_table = 'kho_audit_log'
  UNION ALL
  SELECT
    TRY_CAST(p->>'created_at' AS TIMESTAMPTZ),
    CAST(NULL AS VARCHAR),
    'don_vi'::VARCHAR,
    p->>'item_id',
    CAST(NULL AS DECIMAL(28,6)),
    p->>'unit',
    p->>'actor',
    'stock_unit_events'::VARCHAR,
    p->>'id',
    CAST(NULL AS VARCHAR),
    CAST(NULL AS VARCHAR)
  FROM src WHERE source_table = 'stock_unit_events'
)
SELECT occurred_at, kho, event_type, item_id, quantity, unit, actor_id,
       source_table, source_id, document_ref, raw_source
FROM unified
WHERE occurred_at IS NOT NULL AND occurred_at >= ? AND occurred_at < ?
ORDER BY occurred_at, source_table, source_id
"""


def _first_seen_sql():
    return """
WITH src AS (
  SELECT payload::JSON AS p
  FROM bronze.supabase_current
  WHERE tenant_id = ?
    AND source_table IN ('tan_tao_material_movements', 'q7_inventory_movements', 'stock_transfers')
)
SELECT p->>'kitchen_inventory_item_id' AS item_id,
       MIN(TRY_CAST(p->>'created_at' AS TIMESTAMPTZ)) AS first_at
FROM src
WHERE (p->>'kitchen_inventory_item_id') IS NOT NULL
GROUP BY 1
"""


def _local(value):
    if value.tzinfo is None:
        value = value.replace(tzinfo=timezone.utc)
    return value.astimezone(TIMEZONE)


def _flag_dieu_chinh_lon(events):
    """Flag each adjustment against the same item's prior 90-day quantity window."""
    grouped = defaultdict(list)
    for event in events:
        if event['item_id']:
            grouped[event['item_id']].append(event)
    for group in grouped.values():
        group.sort(key=lambda event: (event['occurred_at'], event['source_table'], event['source_id']))
        window = deque()
        values = []
        for event in group:
            quantity = event['quantity']
            if quantity is None:
                continue
            cutoff = event['occurred_at'] - timedelta(days=ADJUSTMENT_WINDOW_DAYS)
            while window and window[0][0] < cutoff:
                _, old = window.popleft()
                values.pop(bisect_left(values, old))
            if event['event_type'] == 'dieu_chinh' and len(values) >= ADJUSTMENT_MIN_REFERENCES:
                reference = median(values)
                if abs(quantity) > ADJUSTMENT_MEDIAN_MULTIPLE * reference:
                    event['flags'].add('dieu_chinh_lon')
            absolute = abs(quantity)
            insort(values, absolute)
            window.append((event['occurred_at'], absolute))


def _decorate(rows, first_seen):
    events = []
    for row in rows:
        occurred = row['occurred_at']
        event = {
            'occurred_at': occurred,
            'kho': row['kho'],
            'event_type': row['event_type'],
            'item_id': row['item_id'],
            'quantity': row['quantity'],
            'unit': row['unit'],
            'actor_id': row['actor_id'],
            'source_table': row['source_table'],
            'source_id': row['source_id'],
            'document_ref': row['document_ref'],
            'label_version': LABEL_VERSION,
            'flags': set(),
        }
        if not event['actor_id']:
            event['flags'].add('thieu_nguoi_lam')
        local_hour = _local(occurred).hour
        if local_hour >= 23 or local_hour < 5:
            event['flags'].add('ngoai_gio')
        if (event['source_table'] == 'stock_transfers'
                and row['raw_source'] != 'auto_goods_receipt'):
            event['flags'].add('chuyen_kho_thu_cong')
        if event['event_type'] == 'don_vi' and event['item_id']:
            prior = first_seen.get(event['item_id'])
            if prior is not None and prior < occurred:
                event['flags'].add('sua_don_vi_sau_phat_sinh')
        events.append(event)
    _flag_dieu_chinh_lon(events)
    return events


def _totals(events):
    by_type = {code: 0 for code in EVENT_TYPES}
    by_flag = {code: 0 for code in FLAG_CODES}
    for event in events:
        by_type[event['event_type']] = by_type.get(event['event_type'], 0) + 1
        for flag in event['flags']:
            by_flag[flag] = by_flag.get(flag, 0) + 1
    return {'event_count': len(events),
            'by_event_type': [{'event_type': code, 'event_count': by_type[code]} for code in EVENT_TYPES],
            'by_flag': [{'flag': code, 'event_count': by_flag[code]} for code in FLAG_CODES]}


def _provenance(latest, now):
    return {'source': SOURCE, 'source_observed_at': latest[1].isoformat(), 'snapshot_id': latest[0],
            'semantic_version': VERSION, 'label_version': LABEL_VERSION, 'sync_version': SYNC_VERSION,
            'read_at': now.isoformat(), 'cache_hit': False}


def _projection_gaps(manifest):
    tables = manifest.get('tables', {})
    if manifest.get('version') != SYNC_VERSION:
        return ['sync_version=%s' % (manifest.get('version') or 'unknown')]
    gaps = []
    for table, required in KHO_PROJECTION_FIELDS.items():
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
            raise RuntimeError('Supabase snapshot kho event projection is incomplete; re-sync required')
        start = datetime.combine(normalized['from_date'], time.min, tzinfo=TIMEZONE)
        end = datetime.combine(normalized['to_date'] + timedelta(days=1), time.min, tzinfo=TIMEZONE)
        fetch_start = start - timedelta(days=ADJUSTMENT_WINDOW_DAYS)
        rows = _run(con, _events_sql(), [tenant, fetch_start, end], warehouse)
        first_seen = {row['item_id']: row['first_at']
                      for row in _run(con, _first_seen_sql(), [tenant], warehouse)}
        events = _decorate(rows, first_seen)
        filtered = [event for event in events
                    if start <= event['occurred_at'] < end
                    and (not normalized.get('kho') or event['kho'] == normalized['kho'])
                    and (not normalized.get('event_type') or event['event_type'] == normalized['event_type'])
                    and (not normalized.get('flag') or normalized['flag'] in event['flags'])
                    and (not normalized.get('item_id') or event['item_id'] == normalized['item_id'])]
        filtered.sort(key=lambda event: (event['occurred_at'], event['source_table'], event['source_id']), reverse=True)
        totals = _totals(filtered)
        limit = normalized['limit']
        page = filtered[:limit]
        for event in page:
            event['flags'] = [code for code in FLAG_CODES if code in event['flags']]
        return {'from_date': normalized['from_date'].isoformat(), 'to_date': normalized['to_date'].isoformat(),
                'filters': {key: value for key, value in normalized.items() if key not in ('from_date', 'to_date', 'limit')},
                'rows': page, 'match_count': len(filtered), 'limit': limit,
                'truncated': len(filtered) > limit, 'totals': totals,
                **_provenance(latest, now)}
