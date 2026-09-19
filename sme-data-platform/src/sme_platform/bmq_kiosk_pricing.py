"""Scoped kiosk channel unit prices: August evidence applied to September ONLY.

Evidence chain (private raw is never committed):
  DTHU T08.26.xls, sheet "CHI TIET DTHU" (sha256 below)
  -> generated/bmq-r3-aug-trust-20260911/trust-lines.json
  -> generated/kiosk-revenue/coordinator/trust-price-evidence.json

Each entry is the latest August line for one (location_code, channel_code) at the
five real kiosk locations. September has no independent price evidence, so these
exact August prices are applied to September report dates only. They are never a
blended month average and are never asserted for October or any other month: a
requested period outside 2026-09 fails closed.

location_code is the stable key from public.kiosk_report_locations, never the
display name. Only these four revenue channels are priced; a nonzero quantity for
any other channel (including hotline) or for a location/channel with no evidenced
price fails closed instead of guessing. A zero quantity contributes zero.
"""
from datetime import date

VERSION = 'bmq-kiosk-pricing-v1'

EVIDENCE_SOURCE = 'DTHU T08.26.xls'
EVIDENCE_SHA256 = 'eef2f83ddc40f10e666ca47ba532d3b582efe5403a77132b034b17d3f2e759ee'
EVIDENCE_SHEET = 'CHI TIET DTHU'
EVIDENCE_ROWS = 451
EVIDENCE_MONTH_AMOUNT_VND = 183850000

# September is the only month with an evidenced effective price.
PRICED_START = date(2026, 9, 1)
PRICED_END = date(2026, 9, 30)

# Priced revenue channels. Any other channel code is unpriced.
CHANNELS = ('khach_le', 'grabfood', 'shopeefood', 'befood')
# Explicit synthetic location excluded even though it exists in kiosk_report_locations.
# Inactive real locations are NOT excluded: they still carry August/September sales.
TEST_LOCATION_CODE = 'TEST-KIOSK'

# (location_code, channel_code, unit_price_vnd, latest August evidence date)
PRICES = (
    ('HCM001-BV', 'grabfood', 14000, date(2026, 8, 31)),
    ('HCM001-BV', 'khach_le', 14000, date(2026, 8, 31)),
    ('HCM001-BV', 'shopeefood', 14000, date(2026, 8, 31)),
    ('HCM002-PVC', 'befood', 12000, date(2026, 8, 30)),
    ('HCM002-PVC', 'grabfood', 14000, date(2026, 8, 31)),
    ('HCM002-PVC', 'khach_le', 14000, date(2026, 8, 31)),
    ('HCM002-PVC', 'shopeefood', 14000, date(2026, 8, 31)),
    ('HCM003-BVĐ', 'befood', 14000, date(2026, 8, 26)),
    ('HCM003-BVĐ', 'grabfood', 14000, date(2026, 8, 31)),
    ('HCM003-BVĐ', 'khach_le', 14000, date(2026, 8, 29)),
    ('HCM003-BVĐ', 'shopeefood', 14000, date(2026, 8, 31)),
    ('HCM004-BHN', 'grabfood', 14000, date(2026, 8, 31)),
    ('HCM004-BHN', 'khach_le', 14000, date(2026, 8, 31)),
    ('HCM004-BHN', 'shopeefood', 14000, date(2026, 8, 31)),
    ('HCM005-TN', 'befood', 12000, date(2026, 8, 30)),
    ('HCM005-TN', 'grabfood', 14000, date(2026, 8, 31)),
    ('HCM005-TN', 'khach_le', 14000, date(2026, 8, 31)),
    ('HCM005-TN', 'shopeefood', 14000, date(2026, 8, 31)),
)

# Fixed price relation for the parameterized SQL. Built once from the frozen table.
PRICES_CTE = 'prices(location_code,channel_code,unit_price_vnd) AS (VALUES ' + \
    ','.join('(?,?,?)' for _ in PRICES) + ')'
PRICE_PARAMS = [value for location, channel, price, _ in PRICES for value in (location, channel, price)]

POLICY = ('Latest evidenced August price per (location_code, channel) applied to '
          'September 2026 report dates only. Never a month average and never another '
          'month. A nonzero quantity without an evidenced price fails closed.')


def in_priced_window(start, end):
    return start >= PRICED_START and end <= PRICED_END


def catalog():
    """JSON-able provenance and full price table for the result definition/breakdown.

    Only durable evidence identifiers travel to clients: source workbook, hash,
    sheet, row/amount reconciliation and the per-cell latest evidence dates.
    Local generated artifact paths never appear in the delivered provenance.
    """
    return {
        'metric': 'kiosk_sales_revenue',
        'basis': 'sum(channel_report quantity * trusted channel unit_price_vnd)',
        'effective_start': PRICED_START.isoformat(),
        'effective_end': PRICED_END.isoformat(),
        'policy': POLICY,
        'evidence': {
            'source': EVIDENCE_SOURCE,
            'sha256': EVIDENCE_SHA256,
            'sheet': EVIDENCE_SHEET,
            'kiosk_rows': EVIDENCE_ROWS,
            'month_amount_vnd': str(EVIDENCE_MONTH_AMOUNT_VND),
            'priced_channels': list(CHANNELS),
            'excluded_test_location_code': TEST_LOCATION_CODE,
        },
        'prices': [
            {'location_code': location, 'channel_code': channel,
             'unit_price_vnd': price, 'latest_evidence_date': day.isoformat()}
            for location, channel, price, day in PRICES
        ],
    }
