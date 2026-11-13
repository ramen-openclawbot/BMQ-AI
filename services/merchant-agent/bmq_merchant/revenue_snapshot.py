"""Deterministic revenue snapshot for the merchant chat dashboard.

The module is pure Python: it only depends on the standard library and on the
duck-typed ``db`` object passed to :func:`build_revenue_snapshot` (the existing
``SupabaseClient`` exposes ``async select(table, params)``).  It never imports
FastAPI or the Agent SDK, so it can be unit-tested without a running server.

Definition of "controlled revenue" matches the dashboard card:
``revenue_ledger_lines`` rows with ``approval_status = approved`` whose source
document is ``controlled`` or ``trusted``.
"""

from __future__ import annotations

import logging
import string
import unicodedata
from datetime import date, datetime, time, timedelta, timezone
from typing import Any, Mapping, Sequence
from zoneinfo import ZoneInfo

logger = logging.getLogger(__name__)

VN_TZ = ZoneInfo("Asia/Ho_Chi_Minh")

SNAPSHOT_COMMANDS = {
    "snapshot doanh thu",
    "chup nhanh doanh thu",
    "revenue snapshot",
}

CHANNEL_GROUPS = ("dealer", "b2b", "retail", "bakery", "other")
CHANNEL_GROUP_LABELS = {
    "dealer": "Đại lý",
    "b2b": "B2B / Siêu thị",
    "retail": "Xe bán lẻ",
    "bakery": "Bánh ngọt",
    "other": "Khác",
}
CHANNEL_GROUP_LABELS_EN = {
    "dealer": "Dealer",
    "b2b": "B2B / Supermarket",
    "retail": "Retail kiosk",
    "bakery": "Bakery",
    "other": "Other",
}
DEALER_CHANNELS = frozenset(
    {
        "franchise",
        "dai ly",
        "bread business wholesale channel",
        "npp",
    }
)
DELIVERY_CHANNEL_MARKERS = ("grab", "shopee", "befood", "baemin", "gojek")

CAVEAT = "Số đã kiểm soát theo sổ doanh thu, chưa phải số kiểm toán."
CAVEAT_EN = "Controlled figures from the revenue ledger, not audited numbers."
SNAPSHOT_COMPONENT = "revenue_snapshot"
SNAPSHOT_VERSION = 1
MAX_SOURCE_ROWS = 20_000
MAX_MISSING_LOCATIONS = 20

# Flag thresholds.  Kept as module constants so they can be tuned and tested.
CHANNEL_DROP_MIN_PREVIOUS = 5_000_000
CHANNEL_DROP_PCT = -30.0
CHANNEL_DROP_HIGH_PCT = -50.0
CHANNEL_SPIKE_PCT = 50.0
CHANNEL_SPIKE_MIN_CURRENT = 5_000_000
CHANNEL_SILENT_MIN_DAYS = 2
KIOSK_DROP_MIN_PREVIOUS = 2_000_000
KIOSK_DROP_PCT = -30.0
DEALER_ZERO_MIN_PREVIOUS_DAILY_AVG = 1.0
AUTO_JOB_STUCK_HOURS = 2

_SEVERITY_ORDER = {"high": 0, "medium": 1, "info": 2}
_SECTION_LABELS = {
    "revenue": "doanh thu",
    "kiosk": "báo cáo điểm bán",
    "dealer_orders": "đơn đại lý",
    "auto_job": "nhật ký job 23:59",
}
_SECTION_LABELS_EN = {
    "revenue": "revenue",
    "kiosk": "outlet reports",
    "dealer_orders": "dealer orders",
    "auto_job": "23:59 job log",
}
_EDGE_PUNCTUATION = string.punctuation + "…“”‘’–—"


class _TooManyRows(RuntimeError):
    """A source returned more rows than the snapshot is allowed to scan."""


# -- text / channel helpers ---------------------------------------------------


def _strip_accents(value: Any) -> str:
    text = unicodedata.normalize("NFD", str(value or ""))
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    return text.replace("đ", "d").replace("Đ", "D")


def _normalize(value: Any) -> str:
    return _strip_accents(value).casefold()


def _is_english(language: str | None) -> bool:
    return language == "en"


def _dynamic_text(value: Any, language: str | None) -> str:
    """Keep proper names as-is in Vietnamese, transliterate them in English."""

    text = str(value or "")
    return _strip_accents(text) if _is_english(language) else text


def is_snapshot_command(message: str) -> bool:
    """True only for the exact snapshot phrases (after light normalization)."""

    if not isinstance(message, str):
        return False
    text = _normalize(message).strip()
    text = text.strip(_EDGE_PUNCTUATION).strip()
    text = " ".join(text.split())
    text = text.strip(_EDGE_PUNCTUATION).strip()
    return text in SNAPSHOT_COMMANDS


def channel_group(channel: Any) -> str:
    """Port of apps/web/src/lib/overview/overview-summary.ts channelGroup."""

    if not channel:
        return "other"
    value = _normalize(channel).strip()
    if not value:
        return "other"

    if value in DEALER_CHANNELS:
        return "dealer"
    if value == "b2b bmq" or "sieu thi" in value or "b2b" in value:
        return "b2b"
    if value == "retail kiosk" or "kiosk" in value or "ban le" in value:
        return "retail"
    if "banh ngot" in value or "bakery" in value:
        return "bakery"
    return "other"


def channel_label(group: str, language: str = "vi") -> str:
    labels = CHANNEL_GROUP_LABELS_EN if _is_english(language) else CHANNEL_GROUP_LABELS
    return labels.get(group, labels["other"])


# -- period helpers -----------------------------------------------------------


def _month_end(year: int, month: int) -> date:
    if month == 12:
        return date(year, 12, 31)
    return date(year, month + 1, 1) - timedelta(days=1)


def _previous_month(year: int, month: int) -> tuple[int, int]:
    return (year - 1, 12) if month == 1 else (year, month - 1)


def snapshot_periods(today: date) -> dict[str, dict[str, date]]:
    """Current month-to-date and the same day span of the previous month.

    The previous window is capped at the last day of that month, so 31/03
    compares against 01/02..28/02 and 15/01 against 01/12..15/12.
    """

    if isinstance(today, datetime):
        today = today.date()
    current_start = today.replace(day=1)
    prev_year, prev_month = _previous_month(today.year, today.month)
    previous_start = date(prev_year, prev_month, 1)
    previous_end = date(
        prev_year,
        prev_month,
        min(today.day, _month_end(prev_year, prev_month).day),
    )
    return {
        "current": {"start": current_start, "end": today},
        "previous": {"start": previous_start, "end": previous_end},
    }


def _parse_date(value: Any) -> date | None:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str) and value.strip():
        try:
            return date.fromisoformat(value.strip()[:10])
        except ValueError:
            return None
    return None


def _parse_instant(value: Any) -> datetime | None:
    """Parse a timestamp and return it in Vietnam time."""

    if isinstance(value, datetime):
        instant = value
    elif isinstance(value, date):
        instant = datetime.combine(value, time.min, tzinfo=VN_TZ)
    elif isinstance(value, str) and value.strip():
        text = value.strip().replace("Z", "+00:00")
        try:
            instant = datetime.fromisoformat(text)
        except ValueError:
            parsed_date = _parse_date(text)
            if parsed_date is None:
                return None
            instant = datetime.combine(parsed_date, time.min, tzinfo=VN_TZ)
    else:
        return None
    if instant.tzinfo is None:
        instant = instant.replace(tzinfo=timezone.utc)
    return instant.astimezone(VN_TZ)


def _days_inclusive(start: date, end: date) -> int:
    return max(0, (end - start).days + 1)


def _number(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def _pct_change(current: float, previous: float) -> float | None:
    if previous <= 0:
        return None
    return round((current - previous) / previous * 100, 1)


def _money(value: Any, language: str = "vi") -> str:
    amount = _number(value)
    if _is_english(language):
        if abs(amount) >= 1_000_000:
            return f"{amount / 1_000_000:.1f}M VND"
        if abs(amount) >= 1_000:
            return f"{int(round(amount)):,} VND"
        return f"{int(round(amount))} VND"
    if abs(amount) >= 1_000_000:
        text = f"{amount / 1_000_000:.1f}".replace(".", ",")
        return f"{text} tr"
    if abs(amount) >= 1_000:
        return f"{int(round(amount)):,}".replace(",", ".") + " đ"
    return f"{int(round(amount))} đ"


def _pct_value(value: Any, language: str = "vi") -> str:
    text = f"{_number(value):.1f}%"
    return text if _is_english(language) else text.replace(".", ",")


def _pct_text(value: Any, language: str = "vi") -> str:
    text = f"{_number(value):+.1f}%"
    return text if _is_english(language) else text.replace(".", ",")


def _dmy(value: Any) -> str:
    parsed = _parse_date(value)
    if parsed is None:
        return "—"
    return f"{parsed.day}/{parsed.month}"


def _iso_periods(periods: Mapping[str, Mapping[str, date]]) -> dict[str, dict[str, str]]:
    return {
        key: {
            "start": window["start"].isoformat(),
            "end": window["end"].isoformat(),
        }
        for key, window in periods.items()
    }


def _short_error(exc: BaseException) -> str:
    text = str(exc).strip() or type(exc).__name__
    return text[:160]


def _error_message(value: Any, language: str = "vi") -> str:
    text = str(value)
    if not _is_english(language):
        return text
    known = {
        "quá nhiều dòng": "too many rows",
        "không đọc được dữ liệu": "could not read data",
        "dữ liệu trả về không phải danh sách": "the returned data is not a list",
    }
    if text in known:
        return known[text]
    return text if text.isascii() else "could not read data"


# -- section readers ----------------------------------------------------------


async def _read_rows(
    db: Any,
    table: str,
    params: Mapping[str, str],
    sources: list[str],
) -> list[dict[str, Any]]:
    if table not in sources:
        sources.append(table)
    rows = await db.select(table, params)
    if rows is None:
        return []
    if not isinstance(rows, list):
        raise ValueError("dữ liệu trả về không phải danh sách")
    if len(rows) > MAX_SOURCE_ROWS:
        raise _TooManyRows("quá nhiều dòng")
    return [row for row in rows if isinstance(row, dict)]


def _revenue_params(periods: Mapping[str, Mapping[str, date]]) -> dict[str, str]:
    current = periods["current"]
    previous = periods["previous"]
    return {
        "select": (
            "id,revenue_date,channel,gross_revenue,"
            "source_document:revenue_source_documents!inner(status)"
        ),
        "approval_status": "eq.approved",
        "source_document.status": "in.(controlled,trusted)",
        "and": (
            f"(revenue_date.gte.{previous['start'].isoformat()},"
            f"revenue_date.lte.{current['end'].isoformat()})"
        ),
    }


def _kiosk_location_params() -> dict[str, str]:
    return {
        "select": "id,location_code,location_name",
        "active": "eq.true",
    }


def _kiosk_report_params(periods: Mapping[str, Mapping[str, date]]) -> dict[str, str]:
    current = periods["current"]
    previous = periods["previous"]
    return {
        "select": (
            "id,location_id,report_date,status,submitted_at,"
            "channel_rows:kiosk_daily_report_channel_rows("
            "channel_code,channel_name_snapshot,amount_vnd)"
        ),
        "status": "eq.submitted",
        "and": (
            f"(report_date.gte.{previous['start'].isoformat()},"
            f"report_date.lte.{current['end'].isoformat()})"
        ),
    }


def _dealer_order_params(periods: Mapping[str, Mapping[str, date]]) -> dict[str, str]:
    current = periods["current"]
    previous = periods["previous"]
    return {
        "select": "id,order_number,status,submitted_at,total_amount_vnd",
        "is_test": "eq.false",
        "status": "neq.cancelled",
        "and": (
            f"(submitted_at.gte.{previous['start'].isoformat()}T00:00:00+07:00,"
            f"submitted_at.lte.{current['end'].isoformat()}T23:59:59+07:00)"
        ),
    }


def _auto_job_params(today: date) -> dict[str, str]:
    return {
        "select": "revenue_date,status,row_count,gross_total,error_message,finished_at",
        "and": (
            f"(revenue_date.gte.{(today - timedelta(days=7)).isoformat()},"
            f"revenue_date.lte.{(today - timedelta(days=1)).isoformat()})"
        ),
        "order": "revenue_date.desc",
    }


# -- section builders ---------------------------------------------------------


def _build_revenue(
    rows: Sequence[Mapping[str, Any]],
    periods: Mapping[str, Mapping[str, date]],
    language: str = "vi",
) -> dict[str, Any]:
    current = periods["current"]
    previous = periods["previous"]
    current_days = _days_inclusive(current["start"], current["end"])
    previous_days = _days_inclusive(previous["start"], previous["end"])

    groups: dict[str, dict[str, Any]] = {
        group: {
            "current": 0.0,
            "previous": 0.0,
            "current_dates": set(),
            "previous_dates": set(),
        }
        for group in CHANNEL_GROUPS
    }
    raw_channels: dict[str, dict[str, Any]] = {}
    total_current = 0.0
    total_previous = 0.0

    for row in rows:
        revenue_date = _parse_date(row.get("revenue_date"))
        if revenue_date is None:
            continue
        in_current = current["start"] <= revenue_date <= current["end"]
        in_previous = previous["start"] <= revenue_date <= previous["end"]
        if not (in_current or in_previous):
            continue

        amount = _number(row.get("gross_revenue"))
        channel = str(row.get("channel") or "").strip()
        group = channel_group(channel)
        bucket = groups[group]
        raw_name = channel or ("Unnamed" if _is_english(language) else "Không tên")
        raw_bucket = raw_channels.setdefault(
            raw_name, {"channel": raw_name, "current": 0.0, "previous": 0.0}
        )

        if in_current:
            bucket["current"] += amount
            raw_bucket["current"] += amount
            total_current += amount
            if amount > 0:
                bucket["current_dates"].add(revenue_date)
        if in_previous:
            bucket["previous"] += amount
            raw_bucket["previous"] += amount
            total_previous += amount
            if amount > 0:
                bucket["previous_dates"].add(revenue_date)

    group_rows: list[dict[str, Any]] = []
    for group in CHANNEL_GROUPS:
        bucket = groups[group]
        current_total = round(bucket["current"], 2)
        previous_total = round(bucket["previous"], 2)
        if current_total <= 0 and previous_total <= 0:
            continue

        current_dates: set[date] = bucket["current_dates"]
        last_day = max(current_dates).isoformat() if current_dates else None
        silent_days = 0
        day = current["end"]
        while day >= current["start"] and day not in current_dates:
            silent_days += 1
            day -= timedelta(days=1)

        group_rows.append(
            {
                "group": group,
                "label": channel_label(group, language),
                "current": current_total,
                "previous": previous_total,
                "delta_pct": _pct_change(current_total, previous_total),
                "daily_avg_current": (
                    round(current_total / current_days, 2) if current_days else 0.0
                ),
                "daily_avg_previous": (
                    round(previous_total / previous_days, 2)
                    if previous_days
                    else 0.0
                ),
                "last_day_with_revenue": last_day,
                "silent_days": silent_days,
                "previous_active_days": len(bucket["previous_dates"]),
            }
        )

    channels_raw = [
        {
            "channel": bucket["channel"],
            "current": round(bucket["current"], 2),
            "previous": round(bucket["previous"], 2),
        }
        for bucket in raw_channels.values()
        if bucket["current"] or bucket["previous"]
    ]
    channels_raw.sort(key=lambda item: (-item["current"], item["channel"]))

    return {
        "groups": group_rows,
        "total": {
            "current": round(total_current, 2),
            "previous": round(total_previous, 2),
            "delta_pct": _pct_change(total_current, total_previous),
            "daily_avg_current": (
                round(total_current / current_days, 2) if current_days else 0.0
            ),
            "daily_avg_previous": (
                round(total_previous / previous_days, 2) if previous_days else 0.0
            ),
        },
        "channels_raw": channels_raw,
        "days_current": current_days,
        "days_previous": previous_days,
    }


def _is_test_location(location: Mapping[str, Any]) -> bool:
    text = _normalize(
        f"{location.get('location_code') or ''} {location.get('location_name') or ''}"
    )
    return "test" in text


def _build_kiosk(
    locations: Sequence[Mapping[str, Any]],
    reports: Sequence[Mapping[str, Any]],
    periods: Mapping[str, Mapping[str, date]],
) -> dict[str, Any]:
    current = periods["current"]
    previous = periods["previous"]
    yesterday = current["end"] - timedelta(days=1)
    today = current["end"]

    active_locations: list[dict[str, Any]] = []
    for location in locations:
        if location.get("active") is False:
            continue
        if _is_test_location(location):
            # Live data keeps an active "TEST-KIOSK" row; it never reports and
            # would raise kiosk_missing_reports every single day.
            continue
        active_locations.append(dict(location))
    active_ids = {str(location.get("id")) for location in active_locations}

    submitted_dates: dict[str, set[date]] = {}
    channels: dict[str, dict[str, Any]] = {}
    for report in reports:
        report_date = _parse_date(report.get("report_date"))
        if report_date is None:
            continue
        in_current = current["start"] <= report_date <= current["end"]
        in_previous = previous["start"] <= report_date <= previous["end"]
        if not (in_current or in_previous):
            continue

        location_id = str(report.get("location_id"))
        if location_id in active_ids:
            submitted_dates.setdefault(location_id, set()).add(report_date)

        channel_rows = report.get("channel_rows")
        if not isinstance(channel_rows, list):
            continue
        for channel_row in channel_rows:
            if not isinstance(channel_row, Mapping):
                continue
            code = str(channel_row.get("channel_code") or "").strip() or "khac"
            label = (
                str(channel_row.get("channel_name_snapshot") or "").strip() or code
            )
            amount = _number(channel_row.get("amount_vnd"))
            bucket = channels.setdefault(
                code,
                {
                    "channel_code": code,
                    "channel_name": label,
                    "current": 0.0,
                    "previous": 0.0,
                    "_label_date": report_date,
                },
            )
            if report_date >= bucket["_label_date"] and label:
                bucket["channel_name"] = label
                bucket["_label_date"] = report_date
            if in_current:
                bucket["current"] += amount
            if in_previous:
                bucket["previous"] += amount

    channel_rows = [
        {
            "channel_code": bucket["channel_code"],
            "channel_name": bucket["channel_name"],
            "current": round(bucket["current"], 2),
            "previous": round(bucket["previous"], 2),
            "delta_pct": _pct_change(bucket["current"], bucket["previous"]),
        }
        for bucket in channels.values()
        if bucket["current"] or bucket["previous"]
    ]
    channel_rows.sort(key=lambda item: (-item["current"], item["channel_code"]))

    def _reported(location_id: str, target: date) -> bool:
        return target in submitted_dates.get(location_id, set())

    missing_yesterday = [
        {
            "location_code": str(location.get("location_code") or ""),
            "location_name": str(location.get("location_name") or ""),
        }
        for location in active_locations
        if not _reported(str(location.get("id")), yesterday)
    ]
    missing_yesterday.sort(key=lambda item: item["location_code"])
    missing_yesterday = missing_yesterday[:MAX_MISSING_LOCATIONS]

    reported_yesterday = sum(
        1
        for location in active_locations
        if _reported(str(location.get("id")), yesterday)
    )
    reported_today = sum(
        1
        for location in active_locations
        if _reported(str(location.get("id")), today)
    )

    return {
        "channels": channel_rows,
        "reported_yesterday": reported_yesterday,
        "missing_yesterday": missing_yesterday,
        "reported_today": reported_today,
        "active_count": len(active_locations),
    }


def _build_dealer_orders(
    rows: Sequence[Mapping[str, Any]],
    periods: Mapping[str, Mapping[str, date]],
    today: date,
) -> dict[str, Any]:
    current = periods["current"]
    previous = periods["previous"]
    current_days = _days_inclusive(current["start"], current["end"])
    previous_days = _days_inclusive(previous["start"], previous["end"])
    last_two_days = {today - timedelta(days=1), today}

    count_current = 0
    count_previous = 0
    amount_current = 0.0
    amount_previous = 0.0
    orders_last_2_days = 0

    for row in rows:
        instant = _parse_instant(row.get("submitted_at"))
        if instant is None:
            continue
        order_date = instant.date()
        in_current = current["start"] <= order_date <= current["end"]
        in_previous = previous["start"] <= order_date <= previous["end"]
        if not (in_current or in_previous):
            continue
        amount = _number(row.get("total_amount_vnd"))
        if in_current:
            count_current += 1
            amount_current += amount
            if order_date in last_two_days:
                orders_last_2_days += 1
        if in_previous:
            count_previous += 1
            amount_previous += amount

    return {
        "count_current": count_current,
        "count_previous": count_previous,
        "amount_current": round(amount_current, 2),
        "amount_previous": round(amount_previous, 2),
        "delta_pct": _pct_change(amount_current, amount_previous),
        "orders_last_2_days": orders_last_2_days,
        "previous_daily_avg": (
            round(count_previous / previous_days, 2) if previous_days else 0.0
        ),
        "days_current": current_days,
        "days_previous": previous_days,
    }


def _started_at(row: Mapping[str, Any], revenue_date: date | None) -> datetime | None:
    for key in ("started_at", "created_at", "finished_at"):
        value = row.get(key)
        if value:
            parsed = _parse_instant(value)
            if parsed is not None:
                return parsed
    if revenue_date is not None:
        return datetime.combine(revenue_date, time(23, 59), tzinfo=VN_TZ)
    return None


def _build_auto_job(
    rows: Sequence[Mapping[str, Any]],
    today: date,
    now: datetime | None = None,
) -> dict[str, Any]:
    now = now or datetime.now(VN_TZ)
    failed: dict[str, dict[str, str]] = {}
    stuck: set[str] = set()
    success_dates: set[date] = set()
    seen_dates: set[date] = set()

    for row in rows:
        revenue_date = _parse_date(row.get("revenue_date"))
        if revenue_date is None:
            continue
        seen_dates.add(revenue_date)
        status = str(row.get("status") or "").strip().casefold()
        if status in {"success", "succeeded", "completed", "done"}:
            success_dates.add(revenue_date)
        elif status == "failed":
            error_text = str(row.get("error_message") or "").strip()
            if len(error_text) > 160:
                error_text = error_text[:159] + "…"
            failed[revenue_date.isoformat()] = {
                "date": revenue_date.isoformat(),
                "error_message": error_text,
            }
        elif status == "started":
            started = _started_at(row, revenue_date)
            if started is not None and now - started >= timedelta(
                hours=AUTO_JOB_STUCK_HOURS
            ):
                stuck.add(revenue_date.isoformat())

    window_days = [today - timedelta(days=offset) for offset in range(7, 0, -1)]
    missing = [
        day.isoformat() for day in window_days if day not in seen_dates
    ]

    return {
        "last_success_date": (
            max(success_dates).isoformat() if success_dates else None
        ),
        "failed_dates": [failed[key] for key in sorted(failed, reverse=True)],
        "missing_dates": sorted(missing, reverse=True),
        "stuck_dates": sorted(stuck, reverse=True),
    }


# -- flags --------------------------------------------------------------------


def _flag(
    code: str,
    severity: str,
    title: str,
    detail: str,
    action: str,
) -> dict[str, str]:
    return {
        "code": code,
        "severity": severity,
        "title": title,
        "detail": detail,
        "action": action,
    }


def _section_period_days(
    payload_sections: Mapping[str, Any], key: str, today: date
) -> int:
    periods = payload_sections.get("periods")
    if isinstance(periods, Mapping):
        window = periods.get(key)
        if isinstance(window, Mapping):
            start = _parse_date(window.get("start"))
            end = _parse_date(window.get("end"))
            if start and end and start <= end:
                return _days_inclusive(start, end)
    fallback = snapshot_periods(today)
    window = fallback.get(key) or fallback["current"]
    return _days_inclusive(window["start"], window["end"])


def _entry_date(entry: Any) -> str | None:
    if isinstance(entry, str):
        return entry
    if isinstance(entry, Mapping):
        value = entry.get("date") or entry.get("revenue_date")
        return str(value) if value else None
    return None


def _has_delivery_marker(channel: Mapping[str, Any]) -> bool:
    text = _normalize(
        f"{channel.get('channel_code') or ''} {channel.get('channel_name') or ''}"
    )
    return any(marker in text for marker in DELIVERY_CHANNEL_MARKERS)


def evaluate_flags(
    payload_sections: Mapping[str, Any],
    today: date,
    language: str = "vi",
) -> list[dict[str, str]]:
    """Evaluate every anomaly rule against the payload sections.

    ``payload_sections`` may be the full snapshot payload (including
    ``periods``) or just the four data sections.  The result is ordered with
    ``high`` first, then ``medium``, then ``info``.
    """

    if isinstance(today, datetime):
        today = today.date()
    english = _is_english(language)
    flags: list[dict[str, str]] = []

    revenue = payload_sections.get("revenue")
    if isinstance(revenue, Mapping) and revenue.get("status") != "error":
        previous_days = _section_period_days(payload_sections, "previous", today)
        groups = revenue.get("groups")
        if isinstance(groups, list):
            for group in groups:
                if not isinstance(group, Mapping):
                    continue
                label = _dynamic_text(
                    group.get("label")
                    or channel_label(str(group.get("group") or "other"), language),
                    language,
                )
                current = _number(group.get("current"))
                previous = _number(group.get("previous"))
                delta = group.get("delta_pct")
                if delta is None:
                    continue
                delta_value = _number(delta)

                if (
                    previous >= CHANNEL_DROP_MIN_PREVIOUS
                    and delta_value <= CHANNEL_DROP_PCT
                ):
                    severity = (
                        "high"
                        if delta_value <= CHANNEL_DROP_HIGH_PCT
                        else "medium"
                    )
                    flags.append(
                        _flag(
                            "channel_drop",
                            severity,
                            (
                                f"Channel {label} is down "
                                f"{_pct_value(abs(delta_value), language)}"
                                if english
                                else f"Kênh {label} giảm "
                                f"{_pct_value(abs(delta_value), language)}"
                            ),
                            (
                                f"Revenue this period {_money(current, language)}, "
                                f"same period {_money(previous, language)} "
                                f"({_pct_text(delta_value, language)})."
                                if english
                                else (
                                    f"Doanh thu kỳ này {_money(current, language)}, "
                                    f"cùng kỳ {_money(previous, language)} "
                                    f"({_pct_text(delta_value, language)})."
                                )
                            ),
                            (
                                (
                                    f"Check channel {label}: whether the app/sales "
                                    "channel was interrupted, and whether the "
                                    "revenue ledger is fully entered"
                                )
                                if english
                                else (
                                    f"Kiểm tra kênh {label}: app/kênh bán có gián "
                                    "đoạn không, đối chiếu sổ doanh thu đã nhập "
                                    "đủ chưa"
                                )
                            ),
                        )
                    )

                if (
                    delta_value >= CHANNEL_SPIKE_PCT
                    and current >= CHANNEL_SPIKE_MIN_CURRENT
                ):
                    flags.append(
                        _flag(
                            "channel_spike",
                            "medium",
                            (
                                f"Channel {label} is up "
                                f"{_pct_value(delta_value, language)}"
                                if english
                                else f"Kênh {label} tăng "
                                f"{_pct_value(delta_value, language)}"
                            ),
                            (
                                f"Revenue this period {_money(current, language)}, "
                                f"same period {_money(previous, language)} "
                                f"({_pct_text(delta_value, language)})."
                                if english
                                else (
                                    f"Doanh thu kỳ này {_money(current, language)}, "
                                    f"cùng kỳ {_money(previous, language)} "
                                    f"({_pct_text(delta_value, language)})."
                                )
                            ),
                            (
                                f"Verify duplicate entries or unusual orders in "
                                f"channel {label}"
                                if english
                                else (
                                    "Xác minh số nhập trùng hoặc đơn bất thường ở "
                                    f"kênh {label}"
                                )
                            ),
                        )
                    )

                silent_days = int(_number(group.get("silent_days")))
                active_days = int(_number(group.get("previous_active_days")))
                if (
                    silent_days >= CHANNEL_SILENT_MIN_DAYS
                    and previous_days > 0
                    and active_days >= previous_days / 2
                ):
                    flags.append(
                        _flag(
                            "channel_silent",
                            "high",
                            (
                                f"Channel {label} has had no data for "
                                f"{silent_days} days"
                                if english
                                else f"Kênh {label} không có số {silent_days} ngày"
                            ),
                            (
                                f"The channel had data on {active_days}/"
                                f"{previous_days} days last month but is "
                                "currently silent."
                                if english
                                else (
                                    f"Kênh có số {active_days}/{previous_days} ngày "
                                    "của tháng trước nhưng đang im lặng."
                                )
                            ),
                            (
                                f"Channel {label} has no data for 2 days in a row: "
                                "check the app/operating channel or the ledger "
                                "import job"
                                if english
                                else (
                                    f"Kênh {label} không có số 2 ngày liền: kiểm tra "
                                    "app/kênh vận hành hoặc job nhập sổ"
                                )
                            ),
                        )
                    )

    kiosk = payload_sections.get("kiosk")
    if isinstance(kiosk, Mapping) and kiosk.get("status") != "error":
        missing = kiosk.get("missing_yesterday")
        if isinstance(missing, list) and missing:
            active_count = int(_number(kiosk.get("active_count")))
            if active_count <= 0:
                active_count = int(_number(kiosk.get("reported_yesterday"))) + len(
                    missing
                )
            severity = (
                "high"
                if active_count > 0 and len(missing) * 2 >= active_count
                else "medium"
            )
            names = ", ".join(
                _dynamic_text(
                    item.get("location_name") or item.get("location_code") or "",
                    language,
                )
                for item in missing
                if isinstance(item, Mapping)
            )
            flags.append(
                _flag(
                    "kiosk_missing_reports",
                    severity,
                    (
                        f"{len(missing)} "
                        f"{'outlet has' if len(missing) == 1 else 'outlets have'}"
                        " not submitted yesterday's report"
                        if english
                        else f"{len(missing)} điểm bán chưa nộp báo cáo hôm qua"
                    ),
                    (
                        f"Outlets missing: {names}."
                        if english
                        else f"Điểm chưa nộp: {names}."
                    ),
                    (
                        f"Remind outlets that have not submitted the report for "
                        f"{_dmy(today - timedelta(days=1))}: {names}"
                        if english
                        else (
                            "Nhắc các điểm chưa nộp báo cáo ngày "
                            f"{_dmy(today - timedelta(days=1))}: {names}"
                        )
                    ),
                )
            )

        channels = kiosk.get("channels")
        if isinstance(channels, list):
            for channel in channels:
                if not isinstance(channel, Mapping):
                    continue
                if not _has_delivery_marker(channel):
                    continue
                delta = channel.get("delta_pct")
                if delta is None:
                    continue
                delta_value = _number(delta)
                previous = _number(channel.get("previous"))
                if (
                    previous >= KIOSK_DROP_MIN_PREVIOUS
                    and delta_value <= KIOSK_DROP_PCT
                ):
                    label = _dynamic_text(
                        channel.get("channel_name")
                        or channel.get("channel_code")
                        or ("delivery" if english else "giao hàng"),
                        language,
                    )
                    flags.append(
                        _flag(
                            "kiosk_channel_drop",
                            "medium",
                            (
                                f"Channel {label} at outlets is down "
                                f"{_pct_value(abs(delta_value), language)}"
                                if english
                                else f"Kênh {label} tại điểm bán giảm "
                                f"{_pct_value(abs(delta_value), language)}"
                            ),
                            (
                                f"This period {_money(channel.get('current'), language)}, "
                                f"same period {_money(previous, language)} "
                                f"({_pct_text(delta_value, language)})."
                                if english
                                else (
                                    f"Kỳ này {_money(channel.get('current'), language)}, "
                                    f"cùng kỳ {_money(previous, language)} "
                                    f"({_pct_text(delta_value, language)})."
                                )
                            ),
                            (
                                f"Check the {label} app at outlets (stall closed, "
                                "app error, out of stock)"
                                if english
                                else (
                                    f"Kiểm tra app {label} tại điểm bán (đóng gian "
                                    "hàng, lỗi app, hết hàng)"
                                )
                            ),
                        )
                    )

    auto_job = payload_sections.get("auto_job")
    if isinstance(auto_job, Mapping) and auto_job.get("status") != "error":
        failed = auto_job.get("failed_dates") or []
        stuck = auto_job.get("stuck_dates") or []
        failed_dates = [
            date_value
            for date_value in (_entry_date(entry) for entry in failed)
            if date_value
        ]
        stuck_dates = [
            date_value
            for date_value in (_entry_date(entry) for entry in stuck)
            if date_value
        ]
        if failed_dates or stuck_dates:
            first_date = (failed_dates + stuck_dates)[0]
            problems: list[str] = []
            if failed_dates:
                problems.append(
                    f"{len(failed_dates)} failed days"
                    if english
                    else f"lỗi {len(failed_dates)} ngày"
                )
            if stuck_dates:
                problems.append(
                    f"{len(stuck_dates)} stuck days"
                    if english
                    else f"treo {len(stuck_dates)} ngày"
                )
            flags.append(
                _flag(
                    "auto_job_failed",
                    "high",
                    (
                        "Job 23:59 failed or is stuck"
                        if english
                        else "Job 23:59 lỗi hoặc bị treo"
                    ),
                    (
                        f"The automated log has {', '.join(problems)}."
                        if english
                        else f"Nhật ký tự động có {', '.join(problems)}."
                    ),
                    (
                        f"Open Revenue > 23:59 automated log, rerun "
                        f"{_dmy(first_date)}"
                        if english
                        else (
                            "Mở Doanh thu > nhật ký tự động 23:59, chạy lại ngày "
                            f"{_dmy(first_date)}"
                        )
                    ),
                )
            )

        missing = auto_job.get("missing_dates") or []
        missing_dates = [
            date_value
            for date_value in (_entry_date(entry) for entry in missing)
            if date_value
        ]
        if missing_dates:
            flags.append(
                _flag(
                    "auto_job_missing",
                    "medium",
                    (
                        "Job 23:59 is missing days"
                        if english
                        else "Job 23:59 thiếu ngày"
                    ),
                    (
                        f"There is no log row for {len(missing_dates)} days."
                        if english
                        else f"Không có dòng nhật ký cho {len(missing_dates)} ngày."
                    ),
                    (
                        f"Job 23:59 did not run on {_dmy(missing_dates[0])}: "
                        "check the automated schedule"
                        if english
                        else (
                            "Job 23:59 không chạy ngày "
                            f"{_dmy(missing_dates[0])}: kiểm tra lịch tự động"
                        )
                    ),
                )
            )

    dealer_orders = payload_sections.get("dealer_orders")
    if isinstance(dealer_orders, Mapping) and dealer_orders.get("status") != "error":
        orders_last_2_days = int(_number(dealer_orders.get("orders_last_2_days")))
        previous_daily_avg = _number(dealer_orders.get("previous_daily_avg"))
        if (
            orders_last_2_days == 0
            and previous_daily_avg >= DEALER_ZERO_MIN_PREVIOUS_DAILY_AVG
        ):
            avg_text = str(round(previous_daily_avg, 1))
            if not english:
                avg_text = avg_text.replace(".", ",")
            flags.append(
                _flag(
                    "dealer_orders_zero",
                    "high",
                    (
                        "Dealer orders dropped to zero for 2 days"
                        if english
                        else "Đơn đại lý về 0 trong 2 ngày"
                    ),
                    (
                        "No dealer orders for 2 days; last month averaged "
                        f"{avg_text} orders/day."
                        if english
                        else (
                            "Không có đơn đại lý trong 2 ngày; tháng trước trung "
                            f"bình {avg_text} đơn/ngày."
                        )
                    ),
                    (
                        "Dealer Zalo orders dropped to zero for 2 days: check "
                        "the dathang ordering portal and Zalo OA"
                        if english
                        else (
                            "Đơn Zalo đại lý về 0 trong 2 ngày: kiểm tra cổng đặt "
                            "hàng dathang và Zalo OA"
                        )
                    ),
                )
            )

    section_labels = _SECTION_LABELS_EN if english else _SECTION_LABELS
    for section, label in section_labels.items():
        value = payload_sections.get(section)
        if isinstance(value, Mapping) and value.get("status") == "error":
            message = _error_message(
                value.get("message")
                or ("could not read data" if english else "không đọc được dữ liệu"),
                language,
            )
            flags.append(
                _flag(
                    "data_source_error",
                    "info",
                    (
                        f"Could not read {label} data"
                        if english
                        else f"Không đọc được dữ liệu {label}"
                    ),
                    message,
                    (
                        "Try again later; if it repeats, report it to engineering"
                        if english
                        else "Thử lại sau; nếu lặp lại, báo kỹ thuật"
                    ),
                )
            )

    if not flags:
        title = (
            "No anomalies detected under the current rules"
            if english
            else "Không phát hiện bất thường theo quy tắc hiện có"
        )
        flags.append(
            _flag(
                "no_anomaly",
                "info",
                title,
                (
                    "No anomalies detected under the current rules."
                    if english
                    else "Không phát hiện bất thường theo quy tắc hiện có."
                ),
                (
                    "Keep tracking revenue daily."
                    if english
                    else "Tiếp tục theo dõi doanh thu hằng ngày."
                ),
            )
        )

    flags.sort(key=lambda flag: _SEVERITY_ORDER.get(flag["severity"], 3))
    return flags


# -- public builder -----------------------------------------------------------


async def build_revenue_snapshot(
    db: Any,
    today: date,
    language: str = "vi",
) -> dict[str, Any]:
    """Build the snapshot text and UI block from live Supabase reads.

    ``db`` only needs ``async select(table, params)``.  Every source is read in
    its own try/except so one failing table cannot zero out the others.
    """

    if isinstance(today, datetime):
        today = today.date()
    periods = snapshot_periods(today)
    sources: list[str] = []

    async def revenue_section() -> dict[str, Any]:
        rows = await _read_rows(
            db,
            "revenue_ledger_lines",
            _revenue_params(periods),
            sources,
        )
        return _build_revenue(rows, periods, language)

    async def kiosk_section() -> dict[str, Any]:
        locations = await _read_rows(
            db,
            "kiosk_report_locations",
            _kiosk_location_params(),
            sources,
        )
        reports = await _read_rows(
            db,
            "kiosk_daily_reports",
            _kiosk_report_params(periods),
            sources,
        )
        return _build_kiosk(locations, reports, periods)

    async def dealer_section() -> dict[str, Any]:
        rows = await _read_rows(
            db,
            "dealer_orders",
            _dealer_order_params(periods),
            sources,
        )
        return _build_dealer_orders(rows, periods, today)

    async def auto_job_section() -> dict[str, Any]:
        rows = await _read_rows(
            db,
            "revenue_auto_daily_parse_logs",
            _auto_job_params(today),
            sources,
        )
        return _build_auto_job(rows, today)

    async def run_section(builder: Any) -> dict[str, Any]:
        try:
            return await builder()
        except _TooManyRows:
            return {
                "status": "error",
                "message": (
                    "too many rows" if _is_english(language) else "quá nhiều dòng"
                ),
            }
        except Exception as exc:  # one source must never break the snapshot
            logger.warning("Không đọc được nguồn snapshot doanh thu", exc_info=True)
            return {
                "status": "error",
                "message": _error_message(_short_error(exc), language),
            }

    sections = {
        "revenue": await run_section(revenue_section),
        "kiosk": await run_section(kiosk_section),
        "dealer_orders": await run_section(dealer_section),
        "auto_job": await run_section(auto_job_section),
    }

    payload: dict[str, Any] = {
        "version": SNAPSHOT_VERSION,
        "generated_at": datetime.now(VN_TZ).isoformat(timespec="seconds"),
        "periods": _iso_periods(periods),
        **sections,
        "flags": [],
        "sources": sources,
        "caveat": CAVEAT_EN if _is_english(language) else CAVEAT,
    }
    payload["flags"] = evaluate_flags(payload, today, language)

    return {
        "text": render_snapshot_text(payload, language),
        "block": {"component": SNAPSHOT_COMPONENT, "payload": payload},
    }


# -- rendering ----------------------------------------------------------------


def _render_kiosk_line(
    kiosk: Mapping[str, Any] | None, language: str = "vi"
) -> str:
    if not isinstance(kiosk, Mapping) or kiosk.get("status") == "error":
        return (
            "Outlets: could not read data"
            if _is_english(language)
            else "Điểm bán: không đọc được dữ liệu"
        )
    reported = int(_number(kiosk.get("reported_yesterday")))
    active = int(_number(kiosk.get("active_count")))
    if _is_english(language):
        return f"Outlets that submitted yesterday's report: {reported}/{active}"
    return f"Điểm bán nộp báo cáo hôm qua: {reported}/{active}"


def _render_dealer_line(
    dealer: Mapping[str, Any] | None, language: str = "vi"
) -> str:
    if not isinstance(dealer, Mapping) or dealer.get("status") == "error":
        return (
            "Dealer orders (2 days): could not read data"
            if _is_english(language)
            else "Đơn đại lý 2 ngày: không đọc được dữ liệu"
        )
    orders = int(_number(dealer.get("orders_last_2_days")))
    if _is_english(language):
        return f"Dealer orders (2 days): {orders} orders"
    return f"Đơn đại lý 2 ngày: {orders} đơn"


def _render_auto_job_line(
    auto_job: Mapping[str, Any] | None, language: str = "vi"
) -> str:
    english = _is_english(language)
    if not isinstance(auto_job, Mapping) or auto_job.get("status") == "error":
        return (
            "Job 23:59: could not read the log"
            if english
            else "Job 23:59: không đọc được nhật ký"
        )
    last_success = _parse_date(auto_job.get("last_success_date"))
    if last_success is None:
        line = (
            "Job 23:59: no successful run yet"
            if english
            else "Job 23:59: chưa có lần thành công"
        )
    else:
        line = (
            f"Job 23:59: last success {_dmy(last_success)}"
            if english
            else f"Job 23:59: thành công gần nhất {_dmy(last_success)}"
        )
    failed = len(auto_job.get("failed_dates") or [])
    missing = len(auto_job.get("missing_dates") or [])
    stuck = len(auto_job.get("stuck_dates") or [])
    problems = []
    if failed:
        problems.append(f"failed {failed}" if english else f"lỗi {failed}")
    if missing:
        problems.append(f"missing {missing}" if english else f"thiếu {missing}")
    if stuck:
        problems.append(f"stuck {stuck}" if english else f"treo {stuck}")
    if problems:
        line += "; " + ", ".join(problems)
    return line


def render_snapshot_text(
    payload: Mapping[str, Any], language: str = "vi"
) -> str:
    """Render a compact summary in the UI language (Vietnamese by default)."""

    english = _is_english(language)
    periods = payload.get("periods")
    end_date: date | None = None
    if isinstance(periods, Mapping):
        current = periods.get("current")
        if isinstance(current, Mapping):
            end_date = _parse_date(current.get("end"))
    end_date = end_date or datetime.now(VN_TZ).date()

    revenue = payload.get("revenue")
    total: Mapping[str, Any] = {}
    groups: list[Any] = []
    if isinstance(revenue, Mapping) and revenue.get("status") != "error":
        total_value = revenue.get("total")
        if isinstance(total_value, Mapping):
            total = total_value
        groups_value = revenue.get("groups")
        if isinstance(groups_value, list):
            groups = groups_value

    lines = [
        (
            f"Revenue snapshot {_dmy(end_date)} — month to date vs. the same "
            "period last month"
            if english
            else (
                f"Snapshot doanh thu {_dmy(end_date)} — từ đầu tháng so với "
                "cùng kỳ tháng trước"
            )
        )
    ]

    if isinstance(revenue, Mapping) and revenue.get("status") == "error":
        lines.append(
            "Total revenue: could not read data"
            if english
            else "Tổng doanh thu: không đọc được dữ liệu"
        )
    else:
        total_line = (
            f"Total revenue: {_money(total.get('current'), language)}"
            if english
            else f"Tổng doanh thu: {_money(total.get('current'), language)}"
        )
        delta = total.get("delta_pct")
        if delta is None:
            total_line += (
                " (no same-period data to compare)"
                if english
                else " (chưa có cùng kỳ để so sánh)"
            )
        else:
            total_line += (
                f" ({_pct_text(delta, language)} vs. same period)"
                if english
                else f" ({_pct_text(delta, language)} so với cùng kỳ)"
            )
        lines.append(total_line)

    for group in groups:
        if not isinstance(group, Mapping):
            continue
        label = _dynamic_text(
            group.get("label") or channel_label("other", language), language
        )
        delta = group.get("delta_pct")
        suffix = "" if delta is None else f" ({_pct_text(delta, language)})"
        lines.append(
            f"• {label}: {_money(group.get('current'), language)}{suffix}"
        )

    lines.append(_render_kiosk_line(payload.get("kiosk"), language))
    lines.append(_render_dealer_line(payload.get("dealer_orders"), language))
    lines.append(_render_auto_job_line(payload.get("auto_job"), language))

    flags = payload.get("flags")
    flags_list = [flag for flag in flags if isinstance(flag, Mapping)] if isinstance(
        flags, list
    ) else []
    lines.append(
        f"Anomalies ({len(flags_list)}):"
        if english
        else f"Bất thường ({len(flags_list)}):"
    )
    for flag in flags_list:
        title = str(flag.get("title") or "").strip()
        action = str(flag.get("action") or "").strip()
        if english:
            title = _strip_accents(title)
            action = _strip_accents(action)
        if title and action:
            lines.append(f"• {title} → {action}")
        elif title:
            lines.append(f"• {title}")

    caveat = str(payload.get("caveat") or "")
    if english:
        if not caveat or caveat == CAVEAT:
            caveat = CAVEAT_EN
        else:
            caveat = _strip_accents(caveat)
    else:
        caveat = caveat or CAVEAT
    lines.append(caveat)
    return "\n".join(lines)
