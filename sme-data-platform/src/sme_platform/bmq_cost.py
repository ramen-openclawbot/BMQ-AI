"""Read-only BMQ cost-classification answers over the raw Supabase snapshot.

Mirrors the reviewed canonical view
``public.cost_classification_line_details``
(apps/web/supabase/migrations/20260527162000_cost_classification_canonical_reporting.sql)
for all four view arms, not just classified rows:

- arm 1: classified ``payment_request_item`` lines; arms 2: classified
  ``invoice_item`` lines.
- arm 3: OCR-only ``payment_request_item`` lines with canonical cost metadata
  and no classification row; arm 4: OCR-only ``invoice_item`` lines without a
  classification row.
- source line metadata overrides the classification: ``category_code`` is
  ``coalesce(line.cost_category_code, clc.category_code)``, ``product_name`` is
  ``coalesce(canonical_cost_item_name, raw_product_name, product_name)``,
  ``product_code`` is ``coalesce(confirmed_standard_cost_code,
  suggested_standard_cost_code, product_code)``, ``allocation_rule``/``product_line``/
  ``classification_source`` follow the same override, and
  ``review_status`` is forced to ``needs_review`` when the line routing says so
  or the effective category is ``UNMAPPED_REVIEW``.
- ``source_date`` is ``coalesce(paid_at, created_at, invoice_date)`` (invoice
  first for invoice rows) cast from the UTC source timestamp, never the
  classification ``created_at``.
- ``line_amount`` is ``coalesce(line_total, quantity * unit_price, 0)``.
- A payment request already linked to an invoice (``invoice_id is not null``)
  or flagged ``invoice_created`` is excluded, so the payment request line and
  its later invoice line are never counted together.
- An OCR-only line is included only when it carries cost metadata and no
  classification row exists, so classified and OCR-only arms never double
  count. Category labels/groups come only from ``cost_categories`` (INNER JOIN),
  exactly like the view.

The numeric lane additionally requires a snapshot manifest that declares the
canonical cost projection columns (:data:`COST_PROJECTION_FIELDS`); an older or
incomplete snapshot fails closed instead of serving a subtly different total.
Fixed SQL only; owner only; no writes; no arbitrary SQL; no PII.
"""
from __future__ import annotations

from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation
import json
import re
import threading
import unicodedata

from .supabase_sync import COST_PROJECTION_FIELDS, TENANT, VERSION as SYNC_VERSION

VERSION = 'bmq-cost-classification-v2'
LOW_CONFIDENCE_THRESHOLD = Decimal('0.7')
MAX_LIMIT = 50
DEFAULT_LIMIT = 20
TOP_PENDING_LIMIT = 10
STALE_SECONDS = 1800
CATEGORY_PATTERN = re.compile(r'^[A-Z][A-Z0-9_]{0,49}$')
REFERENCE_PATTERN = re.compile(r'^[A-Za-z0-9-]{1,64}$')
STATUSES = ('needs_review', 'suggested', 'approved', 'rejected')
REQUIRED_TABLES = (
    'cost_categories', 'cost_classification_rules', 'cost_item_alias_mappings',
    'cost_line_classifications', 'payment_request_items', 'payment_requests',
    'invoice_items', 'invoices', 'suppliers',
)
SOURCE = ('Supabase.cost_classification_line_details (classified payment request/invoice '
          '+ OCR-only payment request/invoice arms)')

# Canonical taxonomy used by the reviewed Finance Control classification screen.
# The deterministic chat lane accepts these codes and their Vietnamese labels;
# keywords are matched after diacritic folding in the browser lane.
CANONICAL_CATEGORIES = (
    {'code': 'COGS_BMQ_BREAD', 'label_vi': 'Chi phí bánh mì que / bánh mì lớn'},
    {'code': 'COGS_SWEET_KITCHEN', 'label_vi': 'Chi phí bếp bánh ngọt'},
    {'code': 'PACKAGING_SALES', 'label_vi': 'Bao bì / tem nhãn / vật tư bán hàng'},
    {'code': 'OPEX_GENERAL', 'label_vi': 'Chi phí vận hành chung'},
    {'code': 'KITCHEN_SUPPLY_REPAIR', 'label_vi': 'Kho bếp / CCDC / vệ sinh / sửa chữa'},
    {'code': 'CAPEX_ASSET_PROJECT', 'label_vi': 'Tài sản / máy móc / thi công'},
    {'code': 'UNMAPPED_REVIEW', 'label_vi': 'Chưa phân loại / cần review'},
)

QUESTIONS = {
    'month_totals': {
        'label': 'Monthly cost totals by category and review status',
        'label_vi': 'Tổng chi phí theo nhóm và trạng thái duyệt trong tháng',
        'required': ('month',), 'optional': ('category_code', 'review_status', 'limit'),
        'description': ('Exact SUM(line_amount) and line counts per category, product line and review_status for one '
                        'month, matching cost_classification_monthly_summary over all four canonical view arms. '
                        'All review statuses are included unless review_status is supplied; needs_review money is a '
                        'subset of the all-status total, never a separate ledger.'),
    },
    'pending_summary': {
        'label': 'Pending review count and amount',
        'label_vi': 'Số dòng và số tiền đang chờ review',
        'required': ('month',), 'optional': ('category_code',),
        'description': ('Exact needs_review count and SUM(line_amount), with suggested/approved/rejected reported separately. '
                        'A status is never estimated from category totals.'),
    },
    'top_pending_lines': {
        'label': 'Largest pending review lines with supplier and document',
        'label_vi': 'Các dòng chờ review lớn nhất kèm nhà cung cấp và chứng từ',
        'required': ('month',), 'optional': ('category_code', 'limit'),
        'description': ('Needs_review lines ordered by exact line_amount, with supplier name, source document number and source date.'),
    },
    'example_line': {
        'label': 'Deterministic example cost line for a scope',
        'label_vi': 'Một dòng chi phí ví dụ theo phạm vi',
        'required': ('month',), 'optional': ('category_code', 'review_status', 'limit'),
        'selection_rule': 'largest_line_amount_then_source_date_then_classification_id',
        'description': ('One real line from the canonical view for the requested month/category/status scope, chosen '
                        'deterministically by exact line_amount DESC NULLS LAST, then source_date DESC NULLS LAST, then '
                        'classification_id ASC. The rule is disclosed in the answer. Evidence for the chosen line is '
                        'fetched separately by exact classification id (line_explanation) and never invented.'),
    },
    'category_comparison': {
        'label': 'Category comparison between two months',
        'label_vi': 'So sánh nhóm chi phí giữa hai tháng',
        'required': ('month', 'month_b'), 'optional': ('category_code', 'review_status', 'limit'),
        'description': ('Exact per-category line count and SUM(line_amount) for two distinct months, with the raw difference. '
                        'All review statuses are included unless review_status is supplied; the comparison is not a causal statement.'),
    },
    'unmapped_low_confidence': {
        'label': 'Unmapped and low-confidence lines',
        'label_vi': 'Dòng chưa phân loại và độ tin cậy thấp',
        'required': ('month',), 'optional': ('limit',),
        'description': ('UNMAPPED_REVIEW lines plus non-UNMAPPED lines with confidence below %.1f, counted once each. '
                        'This is a review aid, not a finance adjustment.' % LOW_CONFIDENCE_THRESHOLD),
    },
    'line_explanation': {
        'label': 'Stored classification evidence for one line',
        'label_vi': 'Bằng chứng phân loại đã lưu cho một dòng',
        'required': ('line_ref',), 'optional': (),
        'description': ('The stored classification row for one exact classification id or source line id, plus the linked '
                        'cost_classification_rules row and alias mapping row. This is stored link metadata from the current '
                        'snapshot, not proof that the current rule caused the historical classification; missing evidence is '
                        'stated as missing, never invented.'),
    },
    'sync_freshness': {
        'label': 'Cost classification sync freshness',
        'label_vi': 'Độ mới của lần đồng bộ phân loại chi phí',
        'required': (), 'optional': (),
        'description': ('Latest atomic snapshot watermark, canonical cost projection completeness and reconciled row counts '
                        'for the cost classification tables. No business values and no write.'),
    },
}


def catalog():
    return {'version': VERSION, 'source': SOURCE, 'low_confidence_threshold': str(LOW_CONFIDENCE_THRESHOLD),
            'questions': [{'id': qid, **{k: v for k, v in spec.items() if k != 'description'}} for qid, spec in QUESTIONS.items()],
            'canonical_categories': list(CANONICAL_CATEGORIES),
            'accepted_qualifiers': {
                'month': 'exactly one YYYY-MM; category_comparison needs two distinct months',
                'category_code': 'exact cost_categories.code or its canonical Vietnamese label (see canonical_categories)',
                'review_status': 'one of needs_review/suggested/approved/rejected; supported by month_totals and category_comparison only',
                'line_ref': 'exact classification id or source line id for line_explanation',
                'limit': '1..50 for top_pending_lines/unmapped_low_confidence/month_totals',
            },
            'abstains': ('staff, department, bank, route, project, arbitrary day/date, foreign currency and '
                         'supplier filters are not supported and abstain instead of widening the answer'),
            'policy': ('Full canonical cost_classification_line_details parity across the classified and OCR-only arms, '
                       'exact per-status sums, paid/created/invoice source dates, source-line override of the '
                       'classification category/name/source, UNMAPPED_REVIEW forced to needs_review, and invoice-linked '
                       'payment requests excluded. Owner only; no arbitrary SQL, no writes, no supplier contact data.')}


def normalize_ocr_cost_key(value):
    # Mirror of _shared/ocr-cost-classifier.ts normalizeOcrCostKey, used only to
    # look up stored alias mapping evidence; never to invent a match.
    text = str(value or '').replace('đ', 'd').replace('Đ', 'D')
    text = unicodedata.normalize('NFD', text)
    text = ''.join(ch for ch in text if not unicodedata.combining(ch))
    text = text.lower()
    text = re.sub(r'[^a-z0-9\s]', ' ', text)
    return re.sub(r'\s+', ' ', text).strip()


def _month(value, field='month'):
    if not isinstance(value, str) or not re.fullmatch(r'\d{4}-\d{2}', value):
        raise ValueError('Invalid %s: expected YYYY-MM' % field)
    year, month = int(value[:4]), int(value[5:])
    if not 2000 <= year <= 2100 or not 1 <= month <= 12:
        raise ValueError('Invalid %s' % field)
    return date(year, month, 1)


def _limit(value, default):
    if value is None:
        return default
    if type(value) is not int or not 1 <= value <= MAX_LIMIT:
        raise ValueError('Invalid limit')
    return value


def validate_request(request):
    """Closed request grammar; unknown fields, qualifiers and identity are rejected."""
    if not isinstance(request, dict):
        raise ValueError('Invalid cost request')
    if set(request) - {'question', 'month', 'month_b', 'category_code', 'review_status', 'line_ref', 'limit'}:
        raise ValueError('Unsupported cost request field')
    question = request.get('question')
    if question not in QUESTIONS:
        raise ValueError('Unknown cost question')
    spec = QUESTIONS[question]
    required, optional = spec['required'], spec['optional']
    if set(request) - {'question', *required, *optional}:
        raise ValueError('Unsupported qualifier for this question')
    for key in required:
        if key not in request or request[key] in (None, ''):
            raise ValueError('Missing %s' % key)
    normalized = {'question': question}
    if 'month' in required:
        normalized['month'] = _month(request['month'])
    if 'month_b' in required:
        normalized['month_b'] = _month(request['month_b'], 'month_b')
        if normalized['month_b'] == normalized['month']:
            raise ValueError('Comparison months must differ')
    if 'line_ref' in required:
        line_ref = request['line_ref']
        if not isinstance(line_ref, str) or not REFERENCE_PATTERN.fullmatch(line_ref):
            raise ValueError('Invalid line_ref')
        normalized['line_ref'] = line_ref
    if 'category_code' in optional and request.get('category_code') not in (None, ''):
        if not isinstance(request['category_code'], str) or not CATEGORY_PATTERN.fullmatch(request['category_code']):
            raise ValueError('Invalid category_code')
        normalized['category_code'] = request['category_code']
    if 'review_status' in optional and request.get('review_status') not in (None, ''):
        if request['review_status'] not in STATUSES:
            raise ValueError('Invalid review_status')
        normalized['review_status'] = request['review_status']
    if 'limit' in optional:
        if question == 'example_line':
            default_limit = 1
        elif question == 'top_pending_lines':
            default_limit = TOP_PENDING_LIMIT
        else:
            default_limit = DEFAULT_LIMIT
        normalized['limit'] = _limit(request.get('limit'), default_limit)
    return normalized


def _ts_date(column):
    return "CAST(TRY_CAST(%s AS TIMESTAMPTZ) AT TIME ZONE 'UTC' AS DATE)" % column


def _date_value(column):
    return "TRY_CAST(%s AS DATE)" % column


def _line_amount(alias):
    return ("COALESCE(TRY_CAST({a}.line_total AS DECIMAL(28,6)), "
            "TRY_CAST({a}.quantity AS DECIMAL(28,6)) * TRY_CAST({a}.unit_price AS DECIMAL(28,6)), 0)").format(a=alias)


def _classified_status(alias):
    return ("CASE WHEN {a}.cost_review_routing = 'needs_review' "
            "OR COALESCE({a}.cost_category_code, clc.category_code) = 'UNMAPPED_REVIEW' THEN 'needs_review' "
            "WHEN clc.review_status = 'approved' THEN 'approved' ELSE clc.review_status END").format(a=alias)


def _ocr_status(alias):
    return ("CASE WHEN {a}.cost_review_routing = 'needs_review' "
            "OR COALESCE({a}.cost_category_code, 'UNMAPPED_REVIEW') = 'UNMAPPED_REVIEW' THEN 'needs_review' "
            "ELSE 'approved' END").format(a=alias)


def _base():
    """Fixed relation mirroring all four arms of cost_classification_line_details."""
    return """
WITH src AS (
  SELECT source_table, source_id, payload::JSON AS p
  FROM bronze.supabase_current WHERE tenant_id = ?
),
cats AS (
  SELECT p->>'code' AS code, p->>'label' AS label, p->>'cost_group' AS cost_group,
         p->>'product_line' AS product_line, p->>'sort_order' AS sort_order
  FROM src WHERE source_table = 'cost_categories'
),
clc AS (
  SELECT p->>'id' AS id, p->>'source_type' AS source_type, p->>'source_line_id' AS source_line_id,
         p->>'payment_request_id' AS payment_request_id, p->>'invoice_id' AS invoice_id,
         p->>'category_code' AS category_code, p->>'supplier_id' AS supplier_id,
         p->>'review_status' AS review_status, p->>'confidence' AS confidence,
         p->>'classification_source' AS classification_source, p->>'rule_id' AS rule_id,
         p->>'allocation_rule' AS allocation_rule, p->>'product_line' AS product_line,
         p->>'revenue_channel' AS revenue_channel, p->>'created_at' AS created_at
  FROM src WHERE source_table = 'cost_line_classifications'
),
pr_items AS (
  SELECT p->>'id' AS id, p->>'payment_request_id' AS payment_request_id,
         p->>'product_name' AS product_name, p->>'raw_product_name' AS raw_product_name,
         p->>'canonical_cost_item_name' AS canonical_cost_item_name, p->>'product_code' AS product_code,
         p->>'confirmed_standard_cost_code' AS confirmed_standard_cost_code,
         p->>'suggested_standard_cost_code' AS suggested_standard_cost_code,
         p->>'canonical_cost_item_source' AS canonical_cost_item_source,
         p->>'unit' AS unit, p->>'quantity' AS quantity, p->>'unit_price' AS unit_price,
         p->>'line_total' AS line_total, p->>'cost_category_code' AS cost_category_code,
         p->>'cost_product_line' AS cost_product_line, p->>'cost_allocation_rule' AS cost_allocation_rule,
         p->>'cost_review_routing' AS cost_review_routing
  FROM src WHERE source_table = 'payment_request_items'
),
prs AS (
  SELECT p->>'id' AS id, p->>'request_number' AS request_number, p->>'supplier_id' AS supplier_id,
         p->>'paid_at' AS paid_at, p->>'created_at' AS created_at, p->>'invoice_id' AS invoice_id,
         p->>'invoice_created' AS invoice_created, p->>'status' AS status,
         p->>'payment_status' AS payment_status
  FROM src WHERE source_table = 'payment_requests'
),
inv_items AS (
  SELECT p->>'id' AS id, p->>'invoice_id' AS invoice_id,
         p->>'product_name' AS product_name, p->>'raw_product_name' AS raw_product_name,
         p->>'canonical_cost_item_name' AS canonical_cost_item_name, p->>'product_code' AS product_code,
         p->>'confirmed_standard_cost_code' AS confirmed_standard_cost_code,
         p->>'suggested_standard_cost_code' AS suggested_standard_cost_code,
         p->>'canonical_cost_item_source' AS canonical_cost_item_source,
         p->>'unit' AS unit, p->>'quantity' AS quantity, p->>'unit_price' AS unit_price,
         p->>'line_total' AS line_total, p->>'cost_category_code' AS cost_category_code,
         p->>'cost_product_line' AS cost_product_line, p->>'cost_allocation_rule' AS cost_allocation_rule,
         p->>'cost_review_routing' AS cost_review_routing
  FROM src WHERE source_table = 'invoice_items'
),
invs AS (
  SELECT p->>'id' AS id, p->>'invoice_number' AS invoice_number, p->>'invoice_date' AS invoice_date,
         p->>'supplier_id' AS supplier_id, p->>'payment_request_id' AS payment_request_id
  FROM src WHERE source_table = 'invoices'
),
sups AS (
  SELECT p->>'id' AS id, p->>'name' AS name FROM src WHERE source_table = 'suppliers'
),
unified AS (
  -- arm 1: classified payment request items
  SELECT clc.id AS classification_id, 'payment_request_item' AS source_type, clc.source_line_id AS source_line_id,
         clc.payment_request_id AS payment_request_id, clc.invoice_id AS invoice_id,
         prs.request_number AS source_number,
         COALESCE(%(pr_paid)s, %(pr_created)s) AS source_date,
         COALESCE(prs.status, 'invoice') AS source_status, prs.payment_status AS payment_status,
         clc.supplier_id AS supplier_id, COALESCE(clc.supplier_id, prs.supplier_id) AS supplier_join_id,
         COALESCE(pri.canonical_cost_item_name, pri.raw_product_name, pri.product_name) AS product_name,
         COALESCE(pri.confirmed_standard_cost_code, pri.suggested_standard_cost_code, pri.product_code) AS product_code,
         pri.unit AS unit, pri.quantity AS quantity, pri.unit_price AS unit_price, %(pr_amount)s AS line_amount,
         COALESCE(pri.cost_category_code, clc.category_code) AS category_code,
         COALESCE(pri.cost_product_line, clc.product_line) AS product_line, clc.revenue_channel AS revenue_channel,
         COALESCE(pri.cost_allocation_rule, clc.allocation_rule) AS allocation_rule,
         clc.confidence AS confidence_raw,
         COALESCE(pri.canonical_cost_item_source, clc.classification_source) AS classification_source,
         clc.rule_id AS rule_id, %(classified_status_pr)s AS review_status
  FROM clc
  JOIN pr_items pri ON clc.source_type = 'payment_request_item' AND clc.source_line_id = pri.id
  LEFT JOIN prs ON pri.payment_request_id = prs.id
  WHERE COALESCE(TRY_CAST(prs.invoice_created AS BOOLEAN), false) = false AND prs.invoice_id IS NULL
  UNION ALL
  -- arm 2: classified invoice items
  SELECT clc.id, 'invoice_item', clc.source_line_id,
         clc.payment_request_id, clc.invoice_id,
         COALESCE(invs.invoice_number, prs.request_number),
         COALESCE(%(inv_date)s, %(pr_paid)s, %(pr_created)s),
         'invoice', prs.payment_status,
         clc.supplier_id, COALESCE(clc.supplier_id, invs.supplier_id, prs.supplier_id),
         COALESCE(ii.canonical_cost_item_name, ii.raw_product_name, ii.product_name),
         COALESCE(ii.confirmed_standard_cost_code, ii.suggested_standard_cost_code, ii.product_code),
         ii.unit, ii.quantity, ii.unit_price, %(inv_amount)s,
         COALESCE(ii.cost_category_code, clc.category_code),
         COALESCE(ii.cost_product_line, clc.product_line), clc.revenue_channel,
         COALESCE(ii.cost_allocation_rule, clc.allocation_rule),
         clc.confidence,
         COALESCE(ii.canonical_cost_item_source, clc.classification_source),
         clc.rule_id, %(classified_status_inv)s
  FROM clc
  JOIN inv_items ii ON clc.source_type = 'invoice_item' AND clc.source_line_id = ii.id
  LEFT JOIN invs ON ii.invoice_id = invs.id
  LEFT JOIN prs ON invs.payment_request_id = prs.id
  UNION ALL
  -- arm 3: OCR-only payment request items without a classification row
  SELECT pri.id, 'payment_request_item', pri.id,
         pri.payment_request_id, NULL,
         prs.request_number,
         COALESCE(%(pr_paid)s, %(pr_created)s),
         prs.status, prs.payment_status,
         prs.supplier_id, prs.supplier_id,
         COALESCE(pri.canonical_cost_item_name, pri.raw_product_name, pri.product_name),
         COALESCE(pri.confirmed_standard_cost_code, pri.suggested_standard_cost_code, pri.product_code),
         pri.unit, pri.quantity, pri.unit_price, %(pr_amount)s,
         COALESCE(pri.cost_category_code, 'UNMAPPED_REVIEW'),
         COALESCE(pri.cost_product_line, 'general'), NULL,
         COALESCE(pri.cost_allocation_rule, 'none'),
         CASE WHEN pri.cost_review_routing = 'needs_review' THEN 0 ELSE 1 END,
         COALESCE(pri.canonical_cost_item_source, 'ocr_standard_cost'),
         NULL, %(ocr_status_pr)s
  FROM pr_items pri
  JOIN prs ON pri.payment_request_id = prs.id
  WHERE (pri.cost_category_code IS NOT NULL OR pri.cost_review_routing = 'needs_review'
         OR pri.confirmed_standard_cost_code IS NOT NULL OR pri.suggested_standard_cost_code IS NOT NULL)
    AND COALESCE(TRY_CAST(prs.invoice_created AS BOOLEAN), false) = false AND prs.invoice_id IS NULL
    AND NOT EXISTS (SELECT 1 FROM clc WHERE clc.source_type = 'payment_request_item' AND clc.source_line_id = pri.id)
  UNION ALL
  -- arm 4: OCR-only invoice items without a classification row
  SELECT ii.id, 'invoice_item', ii.id,
         invs.payment_request_id, ii.invoice_id,
         invs.invoice_number,
         %(inv_date)s,
         'invoice', prs.payment_status,
         COALESCE(invs.supplier_id, prs.supplier_id), COALESCE(invs.supplier_id, prs.supplier_id),
         COALESCE(ii.canonical_cost_item_name, ii.raw_product_name, ii.product_name),
         COALESCE(ii.confirmed_standard_cost_code, ii.suggested_standard_cost_code, ii.product_code),
         ii.unit, ii.quantity, ii.unit_price, %(inv_amount)s,
         COALESCE(ii.cost_category_code, 'UNMAPPED_REVIEW'),
         COALESCE(ii.cost_product_line, 'general'), NULL,
         COALESCE(ii.cost_allocation_rule, 'none'),
         CASE WHEN ii.cost_review_routing = 'needs_review' THEN 0 ELSE 1 END,
         COALESCE(ii.canonical_cost_item_source, 'ocr_standard_cost'),
         NULL, %(ocr_status_inv)s
  FROM inv_items ii
  JOIN invs ON ii.invoice_id = invs.id
  LEFT JOIN prs ON invs.payment_request_id = prs.id
  WHERE (ii.cost_category_code IS NOT NULL OR ii.cost_review_routing = 'needs_review'
         OR ii.confirmed_standard_cost_code IS NOT NULL OR ii.suggested_standard_cost_code IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM clc WHERE clc.source_type = 'invoice_item' AND clc.source_line_id = ii.id)
),
facts AS (
  SELECT u.classification_id, u.source_type, u.source_line_id, u.payment_request_id, u.invoice_id,
         u.source_number, u.source_date, u.source_status, u.payment_status, u.supplier_id, u.product_name,
         u.product_code, u.unit, u.quantity, u.unit_price, u.line_amount, u.category_code, u.product_line,
         u.revenue_channel, u.allocation_rule, u.confidence_raw, u.classification_source, u.rule_id, u.review_status,
         c.label AS category_label, c.cost_group, c.product_line AS category_product_line, s.name AS supplier_name,
         CAST(date_trunc('month', u.source_date) AS DATE) AS month
  FROM unified u
  JOIN cats c ON c.code = u.category_code
  LEFT JOIN sups s ON s.id = u.supplier_join_id
)
""" % {
        'pr_paid': _ts_date('prs.paid_at'),
        'pr_created': _ts_date('prs.created_at'),
        'inv_date': _date_value('invs.invoice_date'),
        'pr_amount': _line_amount('pri'),
        'inv_amount': _line_amount('ii'),
        'classified_status_pr': _classified_status('pri'),
        'classified_status_inv': _classified_status('ii'),
        'ocr_status_pr': _ocr_status('pri'),
        'ocr_status_inv': _ocr_status('ii'),
    }


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


def _status_totals(rows):
    totals = {status: {'review_status': status, 'line_count': 0, 'total_amount': Decimal(0)} for status in STATUSES}
    for row in rows:
        status = row['review_status']
        bucket = totals.setdefault(status, {'review_status': status, 'line_count': 0, 'total_amount': Decimal(0)})
        bucket['line_count'] += int(row['line_count'])
        bucket['total_amount'] += Decimal(str(row['total_amount']))
    return [totals[status] for status in STATUSES] + [totals[status] for status in totals if status not in STATUSES]


def _provenance(latest, now):
    return {'source': SOURCE, 'source_observed_at': latest[1].isoformat(), 'snapshot_id': latest[0],
            'semantic_version': VERSION, 'sync_version': SYNC_VERSION, 'read_at': now.isoformat(), 'cache_hit': False}


def _projection_gaps(manifest):
    """Column-completeness gate: an older/incomplete projection must never serve a cost total."""
    tables = manifest.get('tables', {})
    if manifest.get('version') != SYNC_VERSION:
        return ['sync_version=%s' % (manifest.get('version') or 'unknown')]
    gaps = []
    for table, required in COST_PROJECTION_FIELDS.items():
        declared = set(tables.get(table, {}).get('fields') or [])
        missing = [field for field in required if field not in declared]
        if missing:
            gaps.append('%s:%s' % (table, ','.join(missing)))
    return gaps


def _sync_freshness(latest, manifest, age_seconds, now):
    tables = manifest.get('tables', {})
    counts = {}
    missing = []
    for table in REQUIRED_TABLES:
        entry = tables.get(table)
        if not entry or entry.get('reconciled') is not True:
            missing.append(table)
            continue
        counts[table] = int(entry.get('records') or 0)
    gaps = _projection_gaps(manifest)
    return {'question': 'sync_freshness', 'version': VERSION, 'source_table': 'meta_supabase_sync_runs',
            'source': 'warehouse.meta_supabase_sync_runs', 'manifest_version': manifest.get('version'),
            'projection_version': manifest.get('version'), 'projection_complete': not gaps, 'projection_gaps': gaps,
            'snapshot_id': latest[0], 'source_observed_at': latest[1].isoformat(),
            'completed_at': latest[2].isoformat() if latest[2] else None,
            'age_seconds': int(age_seconds), 'stale': age_seconds < -60 or age_seconds > STALE_SECONDS,
            'stale_after_seconds': STALE_SECONDS, 'tables': counts, 'missing_tables': missing,
            'reconciled': not missing and not gaps, 'semantic_version': VERSION, 'read_at': now.isoformat(), 'cache_hit': False}


def execute(engine, request, tenant, permission):
    if tenant != TENANT or not (permission == 'owner' or permission.startswith('owner:')):
        raise PermissionError('Owner required')
    normalized = validate_request(request)
    question = normalized['question']
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
        if question == 'sync_freshness':
            return _sync_freshness(latest, manifest, age, now)
        if age < -60 or age > STALE_SECONDS:
            raise RuntimeError('Supabase snapshot is stale')
        missing = [table for table in REQUIRED_TABLES if not (table in tables and tables[table].get('reconciled') is True)]
        if missing:
            raise RuntimeError('Required source tables not synchronized')
        if _projection_gaps(manifest):
            raise RuntimeError('Supabase snapshot cost projection is incomplete; re-sync required')
        base = _base()
        output = _answer(con, warehouse, question, normalized, latest, now, base)
        output.update(_provenance(latest, now))
        return output


def _filters(request, allowed=('category_code', 'review_status')):
    clause, params = '', []
    if 'category_code' in allowed and request.get('category_code'):
        clause += ' AND f.category_code = ?'
        params.append(request['category_code'])
    if 'review_status' in allowed and request.get('review_status'):
        clause += ' AND f.review_status = ?'
        params.append(request['review_status'])
    return clause, params


def _answer(con, warehouse, question, request, latest, now, base):
    month = request.get('month')
    params = [TENANT]
    if question in ('month_totals', 'pending_summary'):
        filter_sql, filter_params = _filters(request)
        sql = base + """
SELECT f.category_code, f.category_label, f.cost_group, f.product_line, f.allocation_rule, f.review_status,
       COUNT(*)::BIGINT AS line_count, COALESCE(SUM(f.line_amount), 0) AS total_amount
FROM facts f
WHERE f.month = ?""" + filter_sql + """
GROUP BY ALL
ORDER BY f.category_label, f.review_status"""
        rows = _run(con, sql, list(params) + [month] + filter_params, warehouse)
        statuses = _status_totals(rows)
        result = {'question': question, 'month': '%04d-%02d' % (month.year, month.month),
                  'category_code': request.get('category_code'), 'review_status': request.get('review_status'),
                  'rows': rows, 'statuses': statuses,
                  'line_count': sum(int(row['line_count']) for row in rows),
                  'total_amount': sum((Decimal(str(row['total_amount'])) for row in rows), Decimal(0)),
                  'definition': QUESTIONS[question]['description']}
        if question == 'pending_summary':
            result['pending'] = next(status for status in statuses if status['review_status'] == 'needs_review')
        return result

    if question == 'top_pending_lines':
        limit = request.get('limit', TOP_PENDING_LIMIT)
        filter_sql, filter_params = _filters(request, allowed=('category_code',))
        summary_sql = base + """
SELECT COUNT(*)::BIGINT AS pending_line_count, COALESCE(SUM(f.line_amount), 0) AS pending_amount
FROM facts f WHERE f.month = ? AND f.review_status = 'needs_review'""" + filter_sql
        rows_sql = base + """
SELECT f.classification_id, f.source_type, f.source_line_id, f.category_code, f.category_label,
       f.supplier_name, f.source_number, f.source_date, f.source_status, f.payment_status,
       f.product_name, f.product_code, f.unit, f.quantity, f.line_amount,
       TRY_CAST(f.confidence_raw AS DECIMAL(10,6)) AS confidence,
       f.classification_source, f.rule_id, f.review_status
FROM facts f
WHERE f.month = ? AND f.review_status = 'needs_review'""" + filter_sql + """
ORDER BY f.line_amount DESC NULLS LAST, f.source_date DESC NULLS LAST, f.classification_id
LIMIT ?"""
        summary = _run(con, summary_sql, list(params) + [month] + filter_params, warehouse)[0]
        rows = _run(con, rows_sql, list(params) + [month] + filter_params + [limit], warehouse)
        return {'question': question, 'month': '%04d-%02d' % (month.year, month.month),
                'category_code': request.get('category_code'),
                'pending_line_count': int(summary['pending_line_count']),
                'pending_amount': summary['pending_amount'],
                'rows': rows, 'limit': limit,
                'truncated': int(summary['pending_line_count']) > limit,
                'definition': QUESTIONS[question]['description']}

    if question == 'example_line':
        limit = request.get('limit', 1)
        filter_sql, filter_params = _filters(request)
        count_sql = base + """
SELECT COUNT(*)::BIGINT AS match_count
FROM facts f WHERE f.month = ?""" + filter_sql
        rows_sql = base + """
SELECT f.month, f.classification_id, f.source_type, f.source_line_id, f.category_code, f.category_label,
       f.supplier_name, f.source_number, f.source_date, f.source_status, f.payment_status,
       f.product_name, f.product_code, f.unit, f.quantity, f.line_amount,
       TRY_CAST(f.confidence_raw AS DECIMAL(10,6)) AS confidence,
       f.classification_source, f.rule_id, f.review_status
FROM facts f
WHERE f.month = ?""" + filter_sql + """
ORDER BY f.line_amount DESC NULLS LAST, f.source_date DESC NULLS LAST, f.classification_id
LIMIT ?"""
        match = _run(con, count_sql, list(params) + [month] + filter_params, warehouse)[0]
        rows = _run(con, rows_sql, list(params) + [month] + filter_params + [limit], warehouse)
        return {'question': question, 'month': '%04d-%02d' % (month.year, month.month),
                'category_code': request.get('category_code'), 'review_status': request.get('review_status'),
                'match_count': int(match['match_count']), 'rows': rows, 'limit': limit,
                'truncated': int(match['match_count']) > limit,
                'selection_rule': QUESTIONS[question]['selection_rule'],
                'definition': QUESTIONS[question]['description']}

    if question == 'category_comparison':
        month_b = request['month_b']
        limit = request.get('limit', DEFAULT_LIMIT)
        filter_sql, filter_params = _filters(request)
        sql = base + """
SELECT f.category_code, MIN(f.category_label) AS category_label,
       CAST(COUNT(*) FILTER (WHERE f.month = ?) AS BIGINT) AS line_count_a,
       COALESCE(SUM(f.line_amount) FILTER (WHERE f.month = ?), 0) AS total_amount_a,
       CAST(COUNT(*) FILTER (WHERE f.month = ?) AS BIGINT) AS line_count_b,
       COALESCE(SUM(f.line_amount) FILTER (WHERE f.month = ?), 0) AS total_amount_b
FROM facts f
WHERE f.month IN (?, ?)""" + filter_sql + """
GROUP BY f.category_code
ORDER BY f.category_code
LIMIT ?"""
        query_params = list(params) + [month, month, month_b, month_b, month, month_b] + filter_params + [limit]
        rows = _run(con, sql, query_params, warehouse)
        all_rows_sql = base + """
SELECT COUNT(DISTINCT f.category_code)::BIGINT AS category_count FROM facts f
WHERE f.month IN (?, ?)""" + filter_sql
        category_count = int(_run(con, all_rows_sql, list(params) + [month, month_b] + filter_params, warehouse)[0]['category_count'])
        for row in rows:
            row['difference'] = Decimal(str(row['total_amount_b'])) - Decimal(str(row['total_amount_a']))
        return {'question': question,
                'month': '%04d-%02d' % (month.year, month.month),
                'month_b': '%04d-%02d' % (month_b.year, month_b.month),
                'category_code': request.get('category_code'), 'review_status': request.get('review_status'),
                'rows': rows, 'category_count': category_count, 'limit': limit,
                'truncated': category_count > limit,
                'definition': QUESTIONS[question]['description']}

    if question == 'unmapped_low_confidence':
        limit = request.get('limit', DEFAULT_LIMIT)
        threshold = LOW_CONFIDENCE_THRESHOLD
        summary_sql = base + """
SELECT
  CAST(COUNT(*) FILTER (WHERE f.category_code = 'UNMAPPED_REVIEW') AS BIGINT) AS unmapped_count,
  COALESCE(SUM(f.line_amount) FILTER (WHERE f.category_code = 'UNMAPPED_REVIEW'), 0) AS unmapped_amount,
  CAST(COUNT(*) FILTER (WHERE f.category_code <> 'UNMAPPED_REVIEW'
                   AND TRY_CAST(f.confidence_raw AS DECIMAL(10,6)) < ?) AS BIGINT) AS low_confidence_count,
  COALESCE(SUM(f.line_amount) FILTER (WHERE f.category_code <> 'UNMAPPED_REVIEW'
                   AND TRY_CAST(f.confidence_raw AS DECIMAL(10,6)) < ?), 0) AS low_confidence_amount
FROM facts f WHERE f.month = ?"""
        rows_sql = base + """
SELECT f.classification_id, f.source_type, f.source_line_id, f.category_code, f.category_label,
       f.supplier_name, f.source_number, f.source_date, f.source_status, f.payment_status,
       f.product_name, f.product_code, f.unit, f.quantity, f.line_amount,
       TRY_CAST(f.confidence_raw AS DECIMAL(10,6)) AS confidence,
       f.classification_source, f.rule_id, f.review_status,
       (f.category_code = 'UNMAPPED_REVIEW') AS unmapped,
       (f.category_code <> 'UNMAPPED_REVIEW' AND TRY_CAST(f.confidence_raw AS DECIMAL(10,6)) < ?) AS low_confidence
FROM facts f
WHERE f.month = ? AND (f.category_code = 'UNMAPPED_REVIEW'
       OR TRY_CAST(f.confidence_raw AS DECIMAL(10,6)) < ?)
ORDER BY f.line_amount DESC NULLS LAST, f.classification_id
LIMIT ?"""
        summary_params = list(params) + [threshold, threshold, month]
        rows_params = list(params) + [threshold, month, threshold, limit]
        summary = _run(con, summary_sql, summary_params, warehouse)[0]
        rows = _run(con, rows_sql, rows_params, warehouse)
        total_count = int(summary['unmapped_count']) + int(summary['low_confidence_count'])
        return {'question': question, 'month': '%04d-%02d' % (month.year, month.month),
                'threshold': str(threshold), 'unmapped_count': int(summary['unmapped_count']),
                'unmapped_amount': summary['unmapped_amount'],
                'low_confidence_count': int(summary['low_confidence_count']),
                'low_confidence_amount': summary['low_confidence_amount'],
                'rows': rows, 'limit': limit, 'truncated': total_count > limit,
                'definition': QUESTIONS[question]['description']}

    if question == 'line_explanation':
        return _line_explanation(con, warehouse, request, base, params)

    raise ValueError('Unknown cost question')


def _line_explanation(con, warehouse, request, base, params):
    line_ref = request['line_ref']
    lookup_sql = base + """
SELECT f.month, f.classification_id, f.source_type, f.source_line_id, f.category_code, f.category_label,
       f.cost_group, f.supplier_id, f.supplier_name, f.source_number, f.source_date, f.source_status,
       f.payment_status, f.product_name, f.product_code, f.unit, f.quantity, f.unit_price, f.line_amount,
       TRY_CAST(f.confidence_raw AS DECIMAL(10,6)) AS confidence, f.classification_source, f.rule_id,
       f.allocation_rule, f.product_line, f.review_status
FROM facts f
WHERE f.classification_id = ? OR f.source_line_id = ?
ORDER BY CASE WHEN f.classification_id = ? THEN 0 ELSE 1 END, f.classification_id
LIMIT 6"""
    lookup_params = list(params) + [line_ref, line_ref, line_ref]
    candidates = _run(con, lookup_sql, lookup_params, warehouse)
    if not candidates:
        return {'question': 'line_explanation', 'status': 'not_found', 'line_ref': line_ref,
                'definition': QUESTIONS['line_explanation']['description']}
    exact = [row for row in candidates if row['classification_id'] == line_ref]
    if not exact:
        source_matches = [row for row in candidates if row['source_line_id'] == line_ref]
        if len(source_matches) > 1:
            return {'question': 'line_explanation', 'status': 'ambiguous', 'line_ref': line_ref,
                    'match_count': len(source_matches),
                    'candidates': [{'classification_id': row['classification_id'], 'source_number': row['source_number'],
                                    'source_date': row['source_date'], 'line_amount': row['line_amount']} for row in source_matches],
                    'definition': QUESTIONS['line_explanation']['description']}
        line = source_matches[0] if source_matches else candidates[0]
    else:
        line = exact[0]
    evidence = {'rule': None, 'alias_mapping': None, 'alias_status': None,
                'rule_metadata_note': ('Current snapshot rule metadata for the stored rule_id; it is not proof that this '
                                       'rule state caused the historical classification.')}
    if line['rule_id']:
        rules = _run(con, base + """
SELECT p->>'id' AS rule_id, p->>'rule_name' AS rule_name, p->>'priority' AS priority,
       p->>'match_scope' AS match_scope, p->>'category_code' AS category_code,
       p->>'allocation_rule' AS allocation_rule, p->>'confidence' AS confidence,
       p->>'active' AS active, p->>'effective_from' AS effective_from, p->>'effective_to' AS effective_to,
       p->>'supplier_id' AS supplier_id,
       p->>'inventory_item_id' AS inventory_item_id, p->>'sku_id' AS sku_id
FROM src WHERE source_table = 'cost_classification_rules' AND source_id = ?""",
                      list(params) + [line['rule_id']], warehouse)
        evidence['rule'] = rules[0] if rules else None
    if line['classification_source'] in ('item_mapping', 'supplier_mapping', 'sku_mapping'):
        evidence['alias_mapping'], evidence['alias_status'] = _alias_evidence(con, warehouse, params, line)
    return {'question': 'line_explanation', 'status': 'ok', 'line_ref': line_ref,
            'line': line, 'evidence': evidence,
            'definition': QUESTIONS['line_explanation']['description']}


def _alias_evidence(con, warehouse, params, line):
    key = normalize_ocr_cost_key(line['product_name'])
    if not key:
        return None, 'no_item_name'
    mappings = _run(con, """
SELECT p->>'id' AS id, p->>'source_name' AS source_name, p->>'source_name_key' AS source_name_key,
       p->>'supplier_id' AS supplier_id, p->>'standard_cost_code_type' AS standard_cost_code_type,
       p->>'standard_cost_code' AS standard_cost_code, p->>'canonical_cost_item_name' AS canonical_cost_item_name,
       p->>'category_code' AS category_code, p->>'mapping_status' AS mapping_status, p->>'active' AS active
FROM (
  SELECT payload::JSON AS p FROM bronze.supabase_current
  WHERE tenant_id = ? AND source_table = 'cost_item_alias_mappings'
) mappings""", list(params), warehouse)
    matches = []
    for mapping in mappings:
        if mapping['active'] != 'true' or mapping['mapping_status'] != 'approved':
            continue
        if not mapping['standard_cost_code_type'] or not mapping['standard_cost_code']:
            continue
        if normalize_ocr_cost_key(mapping['source_name_key']) != key:
            continue
        supplier = mapping['supplier_id']
        if supplier and supplier != line['supplier_id'] and supplier != '00000000-0000-0000-0000-000000000000':
            continue
        matches.append(mapping)
    if not matches:
        return None, 'no_mapping_match'
    best_rank = max(2 if mapping['supplier_id'] == line['supplier_id'] else 1 for mapping in matches)
    top = [mapping for mapping in matches if (2 if mapping['supplier_id'] == line['supplier_id'] else 1) == best_rank]
    codes = {'%s:%s' % (mapping['standard_cost_code_type'], mapping['standard_cost_code']) for mapping in top}
    if len(codes) > 1:
        return None, 'ambiguous_mapping'
    mapping = top[0]
    return {'id': mapping['id'], 'source_name': mapping['source_name'], 'standard_cost_code_type': mapping['standard_cost_code_type'],
            'standard_cost_code': mapping['standard_cost_code'], 'canonical_cost_item_name': mapping['canonical_cost_item_name'],
            'category_code': mapping['category_code'], 'mapping_status': mapping['mapping_status']}, 'matched'
