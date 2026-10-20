"""BMQ's implementation of the reference ``MerchantBackend``.

Reads come from Supabase tables/views.  Writes are limited to staging a row in
``merchant_staged_changes``; applying a staged change calls one of the two
service-role RPCs that own the live write.  No other table is written here.
"""

from __future__ import annotations

import json
import logging
import math
import re
import unicodedata
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, InvalidOperation
from typing import Any, Iterable, Literal
from zoneinfo import ZoneInfo

from merchant_agent import (
    ActorKind,
    AlertCounts,
    AnalysisTable,
    BusinessSnapshot,
    Campaign,
    CampaignDraft,
    ChangeItem,
    ChangeKind,
    ChangeStatus,
    DataLimitation,
    InventoryActionItem,
    InventoryAlert,
    Listing,
    ListingDetails,
    ListingFilters,
    MerchantBackend,
    MerchantSessionContext,
    MetricPoint,
    MetricSeries,
    OrderIssue,
    PriceUpdateItem,
    PricingContext,
    PromotionDraft,
    StagedChange,
    check_analysis_sql,
)
from merchant_agent.changes import ChangeNotApplicable, check_guardrails
from pydantic import BaseModel, Field, field_validator

from .revenue_snapshot import build_revenue_snapshot
from .supabase import SupabaseClient

VN_TZ = ZoneInfo("Asia/Ho_Chi_Minh")
_LOG = logging.getLogger("bmq_merchant.backend")
_CHANGE_KIND_BY_DB_KIND = {
    "listing": ChangeKind.LISTING_UPDATE,
    "price": ChangeKind.PRICE_UPDATE,
    "inventory": ChangeKind.INVENTORY_ACTION,
    "promotion": ChangeKind.PROMOTION,
    "campaign": ChangeKind.CAMPAIGN,
}


class BmqStagedChange(StagedChange):
    """A StagedChange that can also expose the host's ``approved``/``failed`` states."""

    status: Any = ChangeStatus.STAGED


class ListingUpdatePayload(BaseModel):
    listing_id: str
    fields: dict[str, Any] = Field(min_length=1)

    @field_validator("fields")
    @classmethod
    def _bounded_fields(cls, value: dict[str, Any]) -> dict[str, Any]:
        if len(value) > 30:
            raise ValueError("quá nhiều trường cần cập nhật")
        return value


class PricePayloadItem(BaseModel):
    customer_id: str | None = None
    sku_id: str
    price_vnd_per_unit: float = Field(gt=0)


class AnnouncementPayload(BaseModel):
    title: str = Field(min_length=1, max_length=120)
    body: str = Field(min_length=1, max_length=1000)
    severity: Literal["info", "success", "warning", "critical"] = "info"
    starts_at: str | None = None
    ends_at: str | None = None


@dataclass(frozen=True, slots=True)
class _PeriodWindow:
    label: str
    compare_label: str
    current_start: date
    current_end: date
    previous_start: date
    previous_end: date


def _today_vn() -> date:
    return datetime.now(VN_TZ).date()


def _month_end(year: int, month: int) -> date:
    if month == 12:
        return date(year, 12, 31)
    return date(year, month + 1, 1) - timedelta(days=1)


def _previous_month(year: int, month: int) -> tuple[int, int]:
    return (year - 1, 12) if month == 1 else (year, month - 1)


def _period_window(period: str | None, today: date | None = None) -> _PeriodWindow:
    today = today or _today_vn()
    _LOG.info("merchant period requested: %r", period)
    raw = (period or "last_7_days").strip().casefold()
    key = raw.replace("-", "_").replace(" ", "_")

    if key in {"mtd", "month_to_date", "this_month", "thang_nay"}:
        start = today.replace(day=1)
        prev_year, prev_month = _previous_month(today.year, today.month)
        prev_start = date(prev_year, prev_month, 1)
        prev_end = date(
            prev_year,
            prev_month,
            min(today.day, _month_end(prev_year, prev_month).day),
        )
        return _PeriodWindow("MTD", "tháng trước", start, today, prev_start, prev_end)

    if key in {"last_month", "thang_truoc"}:
        prev_year, prev_month = _previous_month(today.year, today.month)
        start = date(prev_year, prev_month, 1)
        end = _month_end(prev_year, prev_month)
        before_year, before_month = _previous_month(prev_year, prev_month)
        return _PeriodWindow(
            f"{prev_year}-{prev_month:02d}",
            f"{before_year}-{before_month:02d}",
            start,
            end,
            date(before_year, before_month, 1),
            _month_end(before_year, before_month),
        )

    if key in {"today", "hom_nay"}:
        yesterday = today - timedelta(days=1)
        return _PeriodWindow("hôm nay", "hôm qua", today, today, yesterday, yesterday)

    if key in {"yesterday", "hom_qua"}:
        target = today - timedelta(days=1)
        before = target - timedelta(days=1)
        return _PeriodWindow("hôm qua", "hôm trước", target, target, before, before)

    if len(raw) == 7 and raw[4] == "-" and raw[:4].isdigit() and raw[5:].isdigit():
        year, month = int(raw[:4]), int(raw[5:])
        start = date(year, month, 1)
        end = _month_end(year, month)
        prev_year, prev_month = _previous_month(year, month)
        return _PeriodWindow(
            f"{year}-{month:02d}",
            f"{prev_year}-{prev_month:02d}",
            start,
            end,
            date(prev_year, prev_month, 1),
            _month_end(prev_year, prev_month),
        )

    range_separator = next((sep for sep in (":", "..", "/") if sep in raw), None)
    if range_separator:
        left, _, right = raw.partition(range_separator)
        left, right = left.strip(), right.strip()
        try:
            start, end = date.fromisoformat(left), date.fromisoformat(right)
        except ValueError:
            start = end = None  # type: ignore[assignment]
        if start and end and start <= end:
            span = (end - start).days + 1
            prev_end = start - timedelta(days=1)
            prev_start = prev_end - timedelta(days=span - 1)
            return _PeriodWindow(
                f"{start.isoformat()}..{end.isoformat()}",
                "kỳ trước",
                start,
                end,
                prev_start,
                prev_end,
            )

    days_match = re.fullmatch(r"last_(\d{1,3})_days?", key)
    if days_match and 1 <= int(days_match.group(1)) <= 366:
        span = int(days_match.group(1))
        start = today - timedelta(days=span - 1)
        previous_end = start - timedelta(days=1)
        previous_start = previous_end - timedelta(days=span - 1)
        return _PeriodWindow(
            f"{span} ngày gần nhất",
            f"{span} ngày trước đó",
            start,
            today,
            previous_start,
            previous_end,
        )

    # Default and every "last 7 days"/"last week" spelling.
    start = today - timedelta(days=6)
    previous_end = start - timedelta(days=1)
    previous_start = previous_end - timedelta(days=6)
    return _PeriodWindow(
        "7 ngày gần nhất",
        "7 ngày trước đó",
        start,
        today,
        previous_start,
        previous_end,
    )


def _date_value(value: Any) -> date | None:
    if isinstance(value, date) and not isinstance(value, datetime):
        return value
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, str) and value:
        try:
            return date.fromisoformat(value[:10])
        except ValueError:
            return None
    return None


def _number(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def _integer(value: Any, default: int = 0) -> int:
    try:
        return int(float(value))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return default


def _jsonable(value: Any) -> Any:
    return json.loads(json.dumps(value, ensure_ascii=False, default=str))


def _normalized(value: Any) -> str:
    text = str(value or "").casefold()
    text = unicodedata.normalize("NFD", text)
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    return text.replace("đ", "d")


def _is_finished_sku(sku: dict[str, Any]) -> bool:
    sku_type = str(sku.get("sku_type") or "").strip()
    if sku_type:
        return sku_type == "finished_good"
    category = _normalized(sku.get("category"))
    return "thanh pham" in category or "finished" in category


def _selling_price(sku: dict[str, Any]) -> float:
    cost_values = sku.get("cost_values")
    if not isinstance(cost_values, dict):
        return 0.0
    return max(0.0, _number(cost_values.get("selling_price")))


def _has_image(sku: dict[str, Any]) -> bool:
    return bool(str(sku.get("image_url") or "").strip() or str(sku.get("image_path") or "").strip())


def _strip_leading_sql_comments(sql: str) -> str:
    text = sql.strip()
    while text:
        if text.startswith("--"):
            _, separator, rest = text.partition("\n")
            text = rest.strip() if separator else ""
        elif text.startswith("/*"):
            end = text.find("*/")
            if end < 0:
                return text
            text = text[end + 2 :].strip()
        else:
            break
    return text


def _pct_change(current: float, previous: float) -> float | None:
    if previous <= 0:
        return None
    return round((current - previous) / previous * 100, 1)


# kind -> (table, code column, selected columns) for the chat document link.
_DOCUMENT_SPECS = {
    "pr": (
        "payment_requests",
        "request_number",
        "id,request_number,title,total_amount",
    ),
    "po": ("purchase_orders", "po_number", "id,po_number,total_amount"),
    "gr": (
        "goods_receipts",
        "receipt_number",
        "id,receipt_number,receipt_date",
    ),
}


def _escape_like(value: str) -> str:
    """Make a code literal inside a PostgREST ``ilike`` pattern."""

    return value.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _document_amount(value: Any) -> str:
    try:
        amount = float(value)
    except (TypeError, ValueError):
        return ""
    if not math.isfinite(amount):
        return ""
    return f"{amount:,.0f} đ"


def _document_title(kind: str, row: dict[str, Any], code: str) -> str:
    parts: list[str] = []
    if kind == "pr":
        parts.append(str(row.get("title") or "").strip() or code)
        amount = _document_amount(row.get("total_amount"))
        if amount:
            parts.append(amount)
    elif kind == "po":
        parts.append(str(row.get("po_number") or "").strip() or code)
        amount = _document_amount(row.get("total_amount"))
        if amount:
            parts.append(amount)
    else:
        parts.append(str(row.get("receipt_number") or "").strip() or code)
        receipt_date = str(row.get("receipt_date") or "").strip()
        if receipt_date:
            parts.append(receipt_date)
    return " · ".join(parts)[:200]


def _row_change_kind(row: dict[str, Any]) -> ChangeKind:
    try:
        return _CHANGE_KIND_BY_DB_KIND[str(row.get("kind"))]
    except KeyError as exc:
        raise ChangeNotApplicable(f"Loại thay đổi không hợp lệ: {row.get('kind')}") from exc


def _row_to_staged(
    row: dict[str, Any], items: list[ChangeItem] | None = None
) -> BmqStagedChange:
    created_at = row.get("created_at")
    if isinstance(created_at, str):
        try:
            created_at = datetime.fromisoformat(created_at.replace("Z", "+00:00"))
        except ValueError:
            created_at = datetime.now(timezone.utc)
    elif not isinstance(created_at, datetime):
        created_at = datetime.now(timezone.utc)

    applied_at = row.get("applied_at")
    if isinstance(applied_at, str):
        try:
            applied_at = datetime.fromisoformat(applied_at.replace("Z", "+00:00"))
        except ValueError:
            applied_at = None

    status_value = str(row.get("status") or "staged")
    try:
        status: Any = ChangeStatus(status_value)
    except ValueError:
        status = status_value
    raw_notes = row.get("guard_notes")
    guardrail_notes = (
        [note.strip() for note in raw_notes if isinstance(note, str) and note.strip()]
        if isinstance(raw_notes, list)
        else []
    )
    return BmqStagedChange(
        change_id=str(row["id"]),
        kind=_row_change_kind(row),
        status=status,
        summary=str(row.get("summary") or "")[:200],
        items=list(items or []),
        created_at=created_at,
        created_by=str(row.get("operator") or "unknown"),
        applied_at=applied_at,
        applied_by=str(row.get("operator")) if row.get("applied_at") else None,
        guardrail_notes=guardrail_notes,
    )


class BmqMerchantBackend(MerchantBackend):
    def __init__(
        self,
        supabase: SupabaseClient,
        config: Any,
        today_provider: Any | None = None,
    ) -> None:
        self._db = supabase
        self.config = config
        self._today_provider = today_provider or _today_vn

    # -- shared reads ---------------------------------------------------------

    async def _revenue_rows(
        self,
        start: date,
        end: date,
        extra: dict[str, str] | None = None,
    ) -> list[dict[str, Any]]:
        params = {
            "select": (
                "revenue_date,channel,customer_name,product_name,quantity,"
                "gross_revenue,customer_payable"
            ),
            "approval_status": "eq.approved",
            "and": f"(revenue_date.gte.{start.isoformat()},revenue_date.lte.{end.isoformat()})",
        }
        params.update(extra or {})
        return await self._db.select("revenue_ledger_lines", params)

    async def _dealer_order_rows(
        self,
        start: date,
        end: date,
        extra: dict[str, str] | None = None,
    ) -> list[dict[str, Any]]:
        params = {
            "select": (
                "order_number,customer_id,status,requested_delivery_date,"
                "submitted_at,total_amount_vnd"
            ),
            "is_test": "eq.false",
            "status": "neq.cancelled",
            "and": (
                "("
                f"requested_delivery_date.gte.{start.isoformat()},"
                f"requested_delivery_date.lte.{end.isoformat()}"
                ")"
            ),
        }
        params.update(extra or {})
        return await self._db.select("dealer_orders", params)

    async def purchase_orders(
        self,
        start: date,
        end: date,
        *,
        supplier: str | None = None,
        status: str | None = None,
        limit: int = 30,
    ) -> dict[str, Any]:
        """List purchase orders in an inclusive VN date range.

        The ``purchase_order_count`` metric (bmq-analytics data.ts and
        sme_platform/bmq_business.py) counts purchase_orders by ``order_date``.
        This read deliberately uses the same column so counts and detail lists
        always agree.

        Names and line items are fetched in explicit ``id=in.(...)`` batches
        instead of PostgREST embeds: the live schema has several relationships
        into purchase_orders, so an embed is ambiguous at runtime.
        """

        params: dict[str, str] = {
            "select": (
                "id,po_number,order_date,expected_date,status,total_amount,"
                "vat_amount,notes,supplier_id"
            ),
            "and": (
                "("
                f"order_date.gte.{start.isoformat()},"
                f"order_date.lte.{end.isoformat()}"
                ")"
            ),
            "order": "order_date.asc,po_number.asc",
        }
        if status:
            params["status"] = f"eq.{status}"
        rows = await self._db.select("purchase_orders", params)
        rows.sort(
            key=lambda row: (
                str(row.get("order_date") or ""),
                str(row.get("po_number") or ""),
            )
        )

        supplier_ids = list(
            dict.fromkeys(
                str(row.get("supplier_id"))
                for row in rows
                if row.get("supplier_id") not in (None, "")
            )
        )
        supplier_names: dict[str, str] = {}
        for offset in range(0, len(supplier_ids), 100):
            batch = supplier_ids[offset : offset + 100]
            suppliers = await self._db.select(
                "suppliers",
                {
                    "select": "id,name",
                    "id": f"in.({','.join(batch)})",
                },
            )
            for supplier_row in suppliers:
                supplier_id = str(supplier_row.get("id") or "")
                if supplier_id:
                    supplier_names[supplier_id] = str(
                        supplier_row.get("name") or ""
                    ).strip() or "Chưa gán nhà cung cấp"

        labeled: list[tuple[dict[str, Any], str]] = []
        for row in rows:
            supplier_id = str(row.get("supplier_id") or "")
            label = supplier_names.get(supplier_id, "Chưa gán nhà cung cấp")
            labeled.append((row, label))

        needle = _normalized(supplier) if supplier else ""
        if needle:
            labeled = [
                (row, label)
                for row, label in labeled
                if label != "Chưa gán nhà cung cấp"
                and needle in _normalized(label)
            ]

        supplier_counts: dict[str, int] = {}
        for _, label in labeled:
            supplier_counts[label] = supplier_counts.get(label, 0) + 1

        total_amount = Decimal("0")
        for row, _ in labeled:
            value = row.get("total_amount")
            if value is None:
                continue
            try:
                total_amount += Decimal(str(value))
            except (InvalidOperation, TypeError, ValueError):
                continue
        total_value: int | float = (
            int(total_amount)
            if total_amount == total_amount.to_integral_value()
            else float(total_amount)
        )

        selected = labeled[:limit]
        selected_ids = [
            str(row.get("id"))
            for row, _ in selected
            if row.get("id") not in (None, "")
        ]
        items_by_po: dict[str, list[dict[str, Any]]] = {}
        for offset in range(0, len(selected_ids), 100):
            batch = selected_ids[offset : offset + 100]
            items = await self._db.select(
                "purchase_order_items",
                {
                    "select": (
                        "product_name,quantity,unit,unit_price,line_total,"
                        "purchase_order_id"
                    ),
                    "purchase_order_id": f"in.({','.join(batch)})",
                },
            )
            for item in items:
                purchase_order_id = str(
                    item.get("purchase_order_id") or ""
                )
                if not purchase_order_id:
                    continue
                items_by_po.setdefault(purchase_order_id, []).append(
                    {
                        "product_name": item.get("product_name"),
                        "quantity": item.get("quantity"),
                        "unit": item.get("unit"),
                        "unit_price": item.get("unit_price"),
                        "line_total": item.get("line_total"),
                    }
                )

        purchase_orders = [
            {
                "id": row.get("id"),
                "po_number": row.get("po_number"),
                "order_date": row.get("order_date"),
                "expected_date": row.get("expected_date"),
                "supplier_name": label,
                "status": row.get("status"),
                "total_amount": row.get("total_amount"),
                "vat_amount": row.get("vat_amount"),
                "notes": row.get("notes"),
                "items": items_by_po.get(str(row.get("id") or ""), []),
            }
            for row, label in selected
        ]
        return {
            "count": len(labeled),
            "total_amount": total_value,
            "supplier_counts": supplier_counts,
            "pos_omitted": max(0, len(labeled) - len(purchase_orders)),
            "purchase_orders": purchase_orders,
        }

    async def document_link(
        self, kind: str, code: str
    ) -> dict[str, Any] | None:
        """Resolve an exact PR/PO/GR code to the row's UUID and a short title.

        The code comparison is case-insensitive but literal: ``%`` and ``_`` are
        escaped so a code can never act as a LIKE wildcard.
        """

        try:
            table, column, select = _DOCUMENT_SPECS[kind]
        except KeyError:
            raise ValueError("kind không hợp lệ") from None
        rows = await self._db.select(
            table,
            {
                "select": select,
                column: f"ilike.{_escape_like(str(code))}",
                "limit": "1",
            },
        )
        if not rows:
            return None
        row = rows[0]
        stored_code = str(row.get(column) or "")
        if stored_code.casefold() != str(code).casefold():
            return None
        identifier = str(row.get("id") or "")
        if not identifier:
            return None
        return {
            "id": identifier,
            "kind": kind,
            "code": stored_code,
            "title": _document_title(kind, row, stored_code),
        }

    # -- revenue snapshot -----------------------------------------------------

    async def revenue_snapshot(self, today: date | None = None) -> dict[str, Any]:
        """Snapshot doanh thu theo kênh, dùng chung engine với tool MCP."""

        return await build_revenue_snapshot(
            self._db, today or self._today_provider()
        )

    # -- performance ----------------------------------------------------------

    async def get_business_snapshot(
        self, session: MerchantSessionContext, period: str | None = None
    ) -> BusinessSnapshot:
        window = _period_window(period, self._today_provider())
        revenue_rows = await self._revenue_rows(window.previous_start, window.current_end)
        order_rows = await self._dealer_order_rows(window.previous_start, window.current_end)

        current_revenue = [
            row
            for row in revenue_rows
            if (parsed := _date_value(row.get("revenue_date")))
            and window.current_start <= parsed <= window.current_end
        ]
        previous_revenue = [
            row
            for row in revenue_rows
            if (parsed := _date_value(row.get("revenue_date")))
            and window.previous_start <= parsed <= window.previous_end
        ]
        current_orders = [
            row
            for row in order_rows
            if (parsed := _date_value(row.get("requested_delivery_date")))
            and window.current_start <= parsed <= window.current_end
        ]
        previous_orders = [
            row
            for row in order_rows
            if (parsed := _date_value(row.get("requested_delivery_date")))
            and window.previous_start <= parsed <= window.previous_end
        ]

        current_sales = sum(_number(row.get("gross_revenue")) for row in current_revenue)
        previous_sales = sum(_number(row.get("gross_revenue")) for row in previous_revenue)
        if not current_revenue and current_orders:
            current_sales = sum(_number(row.get("total_amount_vnd")) for row in current_orders)
        if not previous_revenue and previous_orders:
            previous_sales = sum(_number(row.get("total_amount_vnd")) for row in previous_orders)

        order_count = len(current_orders)
        previous_order_count = len(previous_orders)
        return BusinessSnapshot(
            period=window.label,
            compare_to=window.compare_label,
            sales=round(current_sales, 2),
            orders=order_count,
            traffic=None,
            conversion_rate=None,
            average_order_value=round(current_sales / order_count, 2) if order_count else None,
            sales_change_pct=_pct_change(current_sales, previous_sales),
            orders_change_pct=_pct_change(float(order_count), float(previous_order_count)),
            traffic_change_pct=None,
            conversion_change_pct=None,
            currency="VND",
            alerts=AlertCounts(),
            note="Doanh thu: revenue_ledger_lines đã duyệt; đơn: dealer_orders.",
        )

    async def query_metrics(
        self,
        session: MerchantSessionContext,
        metric: str,
        period: str | None = None,
        granularity: str = "day",
        segment: str | None = None,
    ) -> MetricSeries:
        window = _period_window(period, self._today_provider())
        metric_key = _normalized(metric)
        granularity_value = granularity if granularity in {"day", "week", "month"} else "day"
        extra = self._segment_filter(segment)

        if metric_key in {"orders", "order_count", "don_hang"}:
            # Dealer orders have no channel/product columns; customer filtering is
            # applied below after reading the rows.
            rows = await self._dealer_order_rows(
                window.current_start, window.current_end
            )
            buckets: dict[str, float] = {}
            for row in rows:
                if not self._matches_segment(row, segment, order_metric=True):
                    continue
                parsed = _date_value(row.get("requested_delivery_date"))
                if parsed is None:
                    continue
                key = self._bucket_key(parsed, granularity_value)
                buckets[key] = buckets.get(key, 0.0) + 1.0
            unit = "đơn"
        else:
            rows = await self._revenue_rows(
                window.current_start, window.current_end, extra
            )
            buckets = {}
            for row in rows:
                if not self._matches_segment(row, segment):
                    continue
                parsed = _date_value(row.get("revenue_date"))
                if parsed is None:
                    continue
                key = self._bucket_key(parsed, granularity_value)
                if metric_key in {"quantity", "units", "so_luong"}:
                    buckets[key] = buckets.get(key, 0.0) + _number(row.get("quantity"))
                else:
                    buckets[key] = buckets.get(key, 0.0) + _number(row.get("gross_revenue"))
            unit = "đơn vị" if metric_key in {"quantity", "units", "so_luong"} else "VND"

        points = [
            MetricPoint(date=key, value=round(value, 2))
            for key, value in sorted(buckets.items())
        ]
        note = None if points else "Chưa có dữ liệu phù hợp trong kỳ này."
        return MetricSeries(
            metric=metric,
            unit=unit,
            granularity=granularity_value,  # type: ignore[arg-type]
            period=window.label,
            segment=segment,
            points=points,
            note=note,
        )

    @staticmethod
    def _bucket_key(value: date, granularity: str) -> str:
        if granularity == "month":
            return f"{value.year}-{value.month:02d}"
        if granularity == "week":
            iso = value.isocalendar()
            return f"{iso.year}-W{iso.week:02d}"
        return value.isoformat()

    @staticmethod
    def _matches_segment(
        row: dict[str, Any], segment: str | None, *, order_metric: bool = False
    ) -> bool:
        if not segment:
            return True
        dimension, separator, value = segment.partition(":")
        target = _normalized(value if separator else segment)
        if not separator:
            keys = ("customer_id",) if order_metric else (
                "channel",
                "customer_name",
                "product_name",
            )
            return any(_normalized(row.get(key)) == target for key in keys)
        key = dimension.strip().casefold()
        if order_metric:
            if key in {"customer", "customer_name", "khach"}:
                return _normalized(row.get("customer_id")) == target
            return True
        if key in {"channel", "kenh"}:
            return _normalized(row.get("channel")) == target
        if key in {"customer", "customer_name", "khach"}:
            return _normalized(row.get("customer_name")) == target
        if key in {"product", "product_name", "san_pham"}:
            return _normalized(row.get("product_name")) == target
        return True

    @staticmethod
    def _segment_filter(segment: str | None) -> dict[str, str]:
        if not segment:
            return {}
        dimension, separator, value = segment.partition(":")
        if not separator:
            return {
                "or": (
                    f"(channel.eq.{value or segment},"
                    f"customer_name.eq.{value or segment},"
                    f"product_name.eq.{value or segment})"
                )
            }
        key = dimension.strip().casefold()
        if key in {"channel", "kenh"}:
            return {"channel": f"eq.{value}"}
        if key in {"customer", "customer_name", "khach"}:
            return {"customer_name": f"eq.{value}"}
        if key in {"product", "product_name", "san_pham"}:
            return {"product_name": f"eq.{value}"}
        return {}

    async def get_campaign_performance(
        self, session: MerchantSessionContext, campaign_id: str | None = None
    ) -> list[Campaign]:
        return []

    # -- catalog --------------------------------------------------------------

    async def _load_skus(self) -> list[dict[str, Any]]:
        rows = await self._db.select(
            "product_skus",
            {
                "select": (
                    "id,sku_code,product_name,category,sku_type,unit,unit_price,"
                    "cost_values,notes,image_url,image_path,image_updated_at,"
                    "updated_at,hide_from_dealer_portal"
                ),
                "order": "sku_code.asc",
            },
        )
        return [row for row in rows if _is_finished_sku(row)]

    async def _load_active_prices(
        self, *, sku_id: str | None = None
    ) -> list[dict[str, Any]]:
        params = {
            "select": "id,customer_id,sku_id,price_vnd_per_unit,is_active,updated_at",
            "is_active": "eq.true",
        }
        if sku_id:
            params["sku_id"] = f"eq.{sku_id}"
        return await self._db.select("mini_crm_customer_price_list", params)

    @staticmethod
    def _override_counts(rows: Iterable[dict[str, Any]]) -> dict[str, int]:
        counts: dict[str, int] = {}
        for row in rows:
            sku_id = str(row.get("sku_id") or "")
            if sku_id:
                counts[sku_id] = counts.get(sku_id, 0) + 1
        return counts

    def _listing_from_sku(self, sku: dict[str, Any], override_count: int) -> Listing:
        sku_id = str(sku.get("id"))
        price = _selling_price(sku)
        hidden = bool(sku.get("hide_from_dealer_portal"))
        image = _has_image(sku)
        issues: list[str] = []
        if price <= 0:
            issues.append("thiếu giá")
        if not image:
            issues.append("thiếu ảnh")
        if hidden:
            issues.append("đang ẩn")

        content_quality: Literal["good", "needs_work", "poor"]
        if price <= 0:
            content_quality = "poor"
        elif issues:
            content_quality = "needs_work"
        else:
            content_quality = "good"

        return Listing(
            listing_id=sku_id,
            title=str(sku.get("product_name") or sku.get("sku_code") or sku_id),
            status="paused" if hidden else "active",
            price=price,
            currency="VND",
            stock=0,
            category=str(sku.get("category")) if sku.get("category") else None,
            content_quality=content_quality,
            attributes={
                "sku_code": str(sku.get("sku_code") or ""),
                "unit": str(sku.get("unit") or ""),
                "dealer_override_count": str(override_count),
                "has_price": "true" if price > 0 else "false",
                "has_image": "true" if image else "false",
                "hidden": "true" if hidden else "false",
                "issues": ", ".join(issues),
            },
            image_url=str(sku.get("image_url")) if sku.get("image_url") else None,
            short_description=str(sku.get("notes")) if sku.get("notes") else None,
        )

    async def search_listings(
        self,
        session: MerchantSessionContext,
        query: str,
        filters: ListingFilters | None = None,
        limit: int = 8,
    ) -> list[Listing]:
        skus = await self._load_skus()
        overrides = await self._load_active_prices()
        counts = self._override_counts(overrides)
        needle = _normalized(query)
        listings: list[Listing] = []
        for sku in skus:
            haystack = _normalized(
                " ".join(
                    str(sku.get(key) or "")
                    for key in ("sku_code", "product_name", "category", "notes")
                )
            )
            if needle and needle not in haystack:
                continue
            listing = self._listing_from_sku(sku, counts.get(str(sku.get("id")), 0))
            if filters is not None:
                if filters.status and listing.status != filters.status:
                    continue
                if filters.category and _normalized(listing.category) != _normalized(
                    filters.category
                ):
                    continue
                if filters.max_stock is not None and listing.stock > filters.max_stock:
                    continue
                if (
                    filters.content_quality
                    and listing.content_quality != filters.content_quality
                ):
                    continue
            listings.append(listing)

        if filters is not None:
            if filters.sort == "price_asc":
                listings.sort(key=lambda item: item.price)
            elif filters.sort == "price_desc":
                listings.sort(key=lambda item: item.price, reverse=True)
            elif filters.sort == "stock_asc":
                listings.sort(key=lambda item: item.stock)
            else:
                listings.sort(key=lambda item: item.title)
        else:
            listings.sort(key=lambda item: item.title)
        return listings[: max(1, min(int(limit), 25))]

    async def get_listing(
        self, session: MerchantSessionContext, listing_id: str
    ) -> ListingDetails | None:
        sku = await self._db.select_one(
            "product_skus",
            {
                "select": (
                    "id,sku_code,product_name,category,sku_type,unit,unit_price,"
                    "cost_values,notes,image_url,image_path,image_updated_at,"
                    "updated_at,hide_from_dealer_portal"
                ),
                "id": f"eq.{listing_id}",
            },
        )
        if (
            sku is None
            or str(sku.get("id")) != listing_id
            or not _is_finished_sku(sku)
        ):
            return None
        overrides = await self._load_active_prices(sku_id=listing_id)
        base = self._listing_from_sku(sku, len(overrides))
        issues = [
            item.strip()
            for item in base.attributes.get("issues", "").split(",")
            if item.strip()
        ]
        return ListingDetails(
            **base.model_dump(),
            long_description=str(sku.get("notes")) if sku.get("notes") else None,
            review_snippets=[],
            sales_last_30d=None,
            return_rate_pct=None,
            missing_attributes=issues,
            variants=[],
        )

    # -- inventory and order health ------------------------------------------

    async def get_inventory_alerts(
        self, session: MerchantSessionContext
    ) -> list[InventoryAlert]:
        """Return no alerts in GĐ1.

        BMQ has no reliable, unified finished-goods stock view yet.  The dealer
        order portal and the Tân Tạo ledger only cover parts of the business, and
        deriving low-stock/slow-mover alerts from either would produce a false
        zero.  Inventory read tools are intentionally deferred to a later phase.
        """

        return []

    async def get_order_issues(
        self, session: MerchantSessionContext
    ) -> list[OrderIssue]:
        now = datetime.now(VN_TZ)
        today = now.date()
        week_start = today - timedelta(days=6)

        customers = await self._db.select(
            "mini_crm_customers",
            {
                "select": "id,customer_name,is_npp,is_active,order_locked",
            },
        )
        customer_by_id = {str(row.get("id")): row for row in customers}

        week_orders = await self._db.select(
            "dealer_orders",
            {
                "select": "customer_id,requested_delivery_date",
                "is_test": "eq.false",
                "status": "neq.cancelled",
                "and": (
                    "("
                    f"requested_delivery_date.gte.{week_start.isoformat()},"
                    f"requested_delivery_date.lte.{today.isoformat()}"
                    ")"
                ),
            },
        )

        issues: list[OrderIssue] = []
        # BMQ dealer orders stay "submitted" for their whole life (no confirm
        # status exists), so "unconfirmed after N hours" would flag every order.
        dates_by_customer: dict[str, set[date]] = {}
        for order in week_orders:
            customer_id = str(order.get("customer_id") or "")
            parsed = _date_value(order.get("requested_delivery_date"))
            if customer_id and parsed:
                dates_by_customer.setdefault(customer_id, set()).add(parsed)

        for customer_id, dates in dates_by_customer.items():
            customer = customer_by_id.get(customer_id)
            if customer is None:
                continue
            if not customer.get("is_active") or customer.get("is_npp"):
                continue
            if customer.get("order_locked"):
                continue
            if len(dates) < 4 or today in dates:
                continue
            issues.append(
                OrderIssue(
                    issue_id=f"missing-{customer_id}",
                    order_id=customer_id,
                    kind="delayed",
                    summary=(
                        f"Đại lý {customer.get('customer_name')} đã đặt hàng "
                        f"{len(dates)}/7 ngày nhưng chưa có đơn giao hôm nay."
                    ),
                )
            )

        for customer in customers:
            if not customer.get("order_locked"):
                continue
            customer_id = str(customer.get("id"))
            issues.append(
                OrderIssue(
                    issue_id=f"locked-{customer_id}",
                    order_id=customer_id,
                    kind="delayed",
                    summary=f"Đại lý {customer.get('customer_name')} đang bị khóa đặt hàng.",
                )
            )

        return issues

    async def get_pricing_context(
        self, session: MerchantSessionContext, listing_id: str
    ) -> PricingContext | None:
        price_row = await self._db.select_one(
            "mini_crm_customer_price_list",
            {
                "select": "id,customer_id,sku_id,price_vnd_per_unit,is_active,updated_at",
                "id": f"eq.{listing_id}",
                "is_active": "eq.true",
            },
        )
        if price_row is not None and str(price_row.get("id")) == listing_id:
            return PricingContext(
                listing_id=listing_id,
                current_price=_number(price_row.get("price_vnd_per_unit")),
                currency="VND",
                max_price_delta_pct=self.config.max_price_delta_pct,
                max_promotion_discount_pct=self.config.max_promotion_discount_pct,
                last_changed=str(price_row.get("updated_at"))
                if price_row.get("updated_at")
                else None,
                option_values={
                    "customer_id": str(price_row.get("customer_id") or ""),
                    "sku_id": str(price_row.get("sku_id") or ""),
                },
            )

        sku = await self._db.select_one(
            "product_skus",
            {
                "select": (
                    "id,sku_code,product_name,category,sku_type,unit,unit_price,"
                    "cost_values,notes,image_url,image_path,image_updated_at,"
                    "updated_at,hide_from_dealer_portal"
                ),
                "id": f"eq.{listing_id}",
            },
        )
        if (
            sku is None
            or str(sku.get("id")) != listing_id
            or not _is_finished_sku(sku)
        ):
            return None
        overrides = await self._load_active_prices(sku_id=listing_id)
        variants = [
            PricingContext(
                listing_id=str(row.get("id")),
                current_price=_number(row.get("price_vnd_per_unit")),
                currency="VND",
                max_price_delta_pct=self.config.max_price_delta_pct,
                max_promotion_discount_pct=self.config.max_promotion_discount_pct,
                last_changed=str(row.get("updated_at")) if row.get("updated_at") else None,
                option_values={
                    "customer_id": str(row.get("customer_id") or ""),
                    "dealer": str(row.get("customer_id") or ""),
                },
            )
            for row in overrides
        ]
        return PricingContext(
            listing_id=str(sku.get("id")),
            current_price=_selling_price(sku),
            currency="VND",
            max_price_delta_pct=self.config.max_price_delta_pct,
            max_promotion_discount_pct=self.config.max_promotion_discount_pct,
            last_changed=str(sku.get("updated_at")) if sku.get("updated_at") else None,
            option_values={"sku_code": str(sku.get("sku_code") or "")},
            variants=variants,
        )

    # -- staging --------------------------------------------------------------

    async def _insert_change(
        self,
        *,
        db_kind: str,
        summary: str,
        payload: Any,
        before: Any,
        session: MerchantSessionContext,
        items: list[ChangeItem] | None = None,
    ) -> BmqStagedChange:
        row = await self._db.insert_staged_change(
            {
                "kind": db_kind,
                "summary": summary[:200],
                "payload": _jsonable(payload),
                "before": _jsonable(before),
                "status": "staged",
                "operator": session.operator,
                "session_id": session.session_id,
            }
        )
        change = _row_to_staged(row, items)
        return await self.guard_change(row, change)

    async def _guard_catalog(self) -> list[dict[str, Any]]:
        skus = await self._load_skus()
        return [
            {
                "sku_code": str(sku.get("sku_code") or ""),
                "product_name": str(sku.get("product_name") or ""),
                "selling_price": _selling_price(sku),
            }
            for sku in skus[:80]
        ]

    async def guard_change(
        self,
        row: dict[str, Any],
        change: BmqStagedChange | None = None,
    ) -> BmqStagedChange:
        """Ask merchant-draft-guard for Vietnamese warnings and persist them.

        A guard failure never blocks staging: the row keeps no guard notes and only
        ``guard_provider`` records that the guard was unavailable.
        """

        change = change or _row_to_staged(row)
        change_id = str(row.get("id") or change.change_id)
        try:
            catalog = await self._guard_catalog()
            response = await self._db.call_edge_function(
                "merchant-draft-guard",
                {
                    "kind": str(row.get("kind") or ""),
                    "summary": str(row.get("summary") or ""),
                    "payload": row.get("payload"),
                    "before": row.get("before"),
                    "catalog": catalog,
                },
                timeout=15.0,
            )
            data = response.json()
            raw_notes = data.get("notes") if isinstance(data, dict) else None
            provider = data.get("provider") if isinstance(data, dict) else None
            if (
                not isinstance(raw_notes, list)
                or not isinstance(provider, str)
                or not provider.strip()
            ):
                raise ValueError("invalid guard response")
            notes = [
                note.strip()
                for note in raw_notes
                if isinstance(note, str) and note.strip()
            ]
            provider = provider.strip()[:64]
        except Exception as exc:  # guard is advisory and must never block staging
            _LOG.warning(
                "merchant draft guard failed (%s); change %s stays staged",
                type(exc).__name__,
                change_id,
            )
            try:
                updated = await self._db.update_staged_change(
                    change_id,
                    {"guard_provider": "unavailable"},
                )
            except Exception as update_exc:
                _LOG.warning(
                    "merchant draft guard status update failed (%s)",
                    type(update_exc).__name__,
                )
                return change
            return _row_to_staged(updated, change.items) if updated else change

        try:
            updated = await self._db.update_staged_change(
                change_id,
                {"guard_notes": notes, "guard_provider": provider},
            )
        except Exception as exc:
            _LOG.warning(
                "merchant draft guard notes update failed (%s); change %s stays staged",
                type(exc).__name__,
                change_id,
            )
            return change
        if updated is None:
            return change
        guarded = _row_to_staged(updated, change.items)
        combined = list(change.guardrail_notes)
        for note in [*notes, *guarded.guardrail_notes]:
            if note not in combined:
                combined.append(note)
        return guarded.model_copy(update={"guardrail_notes": combined})

    @staticmethod
    def _guardrail_items(kind: ChangeKind, items: list[ChangeItem], config: Any) -> None:
        violations = check_guardrails(kind, items, config)
        if violations:
            raise ValueError("; ".join(violations))

    async def stage_listing_update(
        self,
        session: MerchantSessionContext,
        listing_id: str,
        fields: dict[str, Any],
        note: str | None = None,
    ) -> StagedChange:
        payload = ListingUpdatePayload(listing_id=listing_id, fields=fields)
        listing = await self.get_listing(session, listing_id)
        if listing is None:
            raise ChangeNotApplicable(f"Không tìm thấy SKU {listing_id}")
        field_map = {
            "title": listing.title,
            "short_description": listing.short_description,
            "long_description": listing.long_description,
            "category": listing.category,
            "image_url": listing.image_url,
            "status": listing.status,
        }
        before = {
            key: field_map.get(key)
            for key in payload.fields
            if key in field_map
        }
        items = [
            ChangeItem(target=listing_id, field=key, before=before.get(key), after=value)
            for key, value in payload.fields.items()
        ]
        self._guardrail_items(ChangeKind.LISTING_UPDATE, items, self.config)
        summary = note or f"Cập nhật thông tin {listing.title}"
        return await self._insert_change(
            db_kind="listing",
            summary=summary,
            payload=payload.model_dump(),
            before=before,
            session=session,
            items=items,
        )

    async def _price_targets(self, listing_id: str) -> list[tuple[str | None, str]]:
        sku = await self._db.select_one(
            "product_skus",
            {"select": "id", "id": f"eq.{listing_id}"},
        )
        if sku is not None and str(sku.get("id")) == listing_id:
            overrides = await self._load_active_prices(sku_id=listing_id)
            if overrides:
                return [
                    (str(row.get("customer_id") or ""), listing_id) for row in overrides
                ]
            return [(None, listing_id)]

        price_row = await self._db.select_one(
            "mini_crm_customer_price_list",
            {
                "select": "id,customer_id,sku_id,is_active",
                "id": f"eq.{listing_id}",
                "is_active": "eq.true",
            },
        )
        if price_row is not None and str(price_row.get("id")) == listing_id:
            return [
                (
                    str(price_row.get("customer_id") or ""),
                    str(price_row.get("sku_id") or ""),
                )
            ]
        raise ChangeNotApplicable(f"Không tìm thấy SKU hoặc giá đại lý {listing_id}")

    async def stage_price_update(
        self,
        session: MerchantSessionContext,
        items: list[PriceUpdateItem],
        note: str | None = None,
    ) -> StagedChange:
        payload_items: list[PricePayloadItem] = []
        before: list[dict[str, Any]] = []
        change_items: list[ChangeItem] = []
        for item in items:
            context = await self.get_pricing_context(session, item.listing_id)
            if context is None:
                raise ChangeNotApplicable(f"Không tìm thấy giá hiện tại cho {item.listing_id}")
            before.append(context.model_dump(mode="json"))
            customer_id = context.option_values.get("customer_id")
            sku_id = context.option_values.get("sku_id")
            if customer_id and sku_id:
                targets = [(customer_id, sku_id)]
            else:
                targets = await self._price_targets(item.listing_id)
            for customer_id, sku_id in targets:
                payload_items.append(
                    PricePayloadItem(
                        customer_id=customer_id,
                        sku_id=sku_id,
                        price_vnd_per_unit=item.new_price,
                    )
                )
            target = item.listing_id if len(targets) == 1 else item.listing_id
            change_items.append(
                ChangeItem(
                    target=target,
                    field="price",
                    before=context.current_price,
                    after=item.new_price,
                )
            )
        if not payload_items:
            raise ChangeNotApplicable("Không có giá nào cần cập nhật")
        self._guardrail_items(ChangeKind.PRICE_UPDATE, change_items, self.config)
        summary = note or f"Cập nhật giá cho {len(change_items)} SKU"
        return await self._insert_change(
            db_kind="price",
            summary=summary,
            payload=[item.model_dump() for item in payload_items],
            before=before,
            session=session,
            items=change_items,
        )

    async def stage_inventory_action(
        self,
        session: MerchantSessionContext,
        items: list[InventoryActionItem],
        note: str | None = None,
    ) -> StagedChange:
        if not items:
            raise ChangeNotApplicable("Không có thao tác tồn kho nào")
        before: list[dict[str, Any]] = []
        change_items: list[ChangeItem] = []
        for item in items:
            listing = await self.get_listing(session, item.listing_id)
            if listing is None:
                raise ChangeNotApplicable(f"Không tìm thấy SKU {item.listing_id}")
            before.append(
                {
                    "listing_id": listing.listing_id,
                    "stock": listing.stock,
                    "status": listing.status,
                }
            )
            change_items.append(
                ChangeItem(
                    target=item.listing_id,
                    field=item.action,
                    before=listing.stock,
                    after=item.quantity if item.quantity is not None else listing.stock,
                )
            )
        self._guardrail_items(ChangeKind.INVENTORY_ACTION, change_items, self.config)
        summary = note or f"Thao tác tồn kho cho {len(items)} SKU"
        return await self._insert_change(
            db_kind="inventory",
            summary=summary,
            payload=[item.model_dump() for item in items],
            before=before,
            session=session,
            items=change_items,
        )

    async def stage_promotion(
        self, session: MerchantSessionContext, promotion: PromotionDraft
    ) -> StagedChange:
        before: list[dict[str, Any]] = []
        change_items: list[ChangeItem] = []
        for listing_id in promotion.listing_ids:
            listing = await self.get_listing(session, listing_id)
            if listing is None:
                raise ChangeNotApplicable(f"Không tìm thấy SKU {listing_id}")
            before.append(
                {
                    "listing_id": listing.listing_id,
                    "price": listing.price,
                    "currency": "VND",
                }
            )
            change_items.append(
                ChangeItem(
                    target=listing_id,
                    field="promotion_price",
                    before=listing.price,
                    after=round(listing.price * (1 - promotion.discount_pct / 100), 2),
                )
            )
        self._guardrail_items(ChangeKind.PROMOTION, change_items, self.config)
        body = (
            f"Khuyến mãi {promotion.discount_pct:g}% cho "
            f"{len(promotion.listing_ids)} SKU. Từ {promotion.starts} đến {promotion.ends}."
        )[:1000]
        payload = AnnouncementPayload(
            title=promotion.name,
            body=body,
            severity="warning",
            starts_at=promotion.starts,
            ends_at=promotion.ends,
        )
        return await self._insert_change(
            db_kind="promotion",
            summary=f"Khuyến mãi {promotion.name}",
            payload=payload.model_dump(exclude_none=True),
            before=before,
            session=session,
            items=change_items,
        )

    async def stage_campaign(
        self, session: MerchantSessionContext, campaign: CampaignDraft
    ) -> StagedChange:
        details = [
            part
            for part in (
                campaign.objective,
                f"Đối tượng: {campaign.audience}" if campaign.audience else None,
                campaign.copy_text,
            )
            if part
        ]
        body = (" ".join(details) or f"Chiến dịch {campaign.name}")[:1000]
        payload = AnnouncementPayload(
            title=campaign.name,
            body=body,
            severity="info",
            starts_at=campaign.starts,
            ends_at=campaign.ends,
        )
        before: list[dict[str, Any]] = []
        items: list[ChangeItem] = [
            ChangeItem(
                target=campaign.campaign_id or campaign.name,
                field="budget" if campaign.budget is not None else "name",
                before=None,
                after=campaign.budget if campaign.budget is not None else campaign.name,
            )
        ]
        self._guardrail_items(ChangeKind.CAMPAIGN, items, self.config)
        return await self._insert_change(
            db_kind="campaign",
            summary=f"Chiến dịch {campaign.name}",
            payload=payload.model_dump(exclude_none=True),
            before=before,
            session=session,
            items=items,
        )

    # -- change queue ---------------------------------------------------------

    async def get_pending_changes(
        self, session: MerchantSessionContext
    ) -> list[StagedChange]:
        rows = await self._db.select(
            "merchant_staged_changes",
            {
                "select": "*",
                "status": "in.(staged,approved)",
                "order": "created_at.desc",
            },
        )
        return [_row_to_staged(row) for row in rows]

    async def _fetch_change(self, change_id: str) -> dict[str, Any] | None:
        return await self._db.select_one(
            "merchant_staged_changes",
            {"select": "*", "id": f"eq.{change_id}"},
        )

    async def approve_change(self, change_id: str, decided_by: str) -> StagedChange:
        row = await self._fetch_change(change_id)
        if row is None:
            raise ChangeNotApplicable("Không tìm thấy thay đổi cần duyệt")
        if row.get("status") == "applied":
            return _row_to_staged(row)
        if row.get("status") not in {"staged", "approved"}:
            raise ChangeNotApplicable("Chỉ có thể duyệt thay đổi đang chờ")
        updated = await self._db.update_staged_change(
            change_id,
            {
                "status": "approved",
                "decided_by": decided_by,
                "decided_at": datetime.now(timezone.utc).isoformat(),
            },
            only_statuses=["staged", "approved"],
        )
        if updated is None:
            raise ChangeNotApplicable("Thay đổi đã được xử lý ở nơi khác")
        return _row_to_staged(updated)

    async def apply_change(
        self, session: MerchantSessionContext, change_id: str
    ) -> StagedChange:
        row = await self._fetch_change(change_id)
        if row is None:
            raise ChangeNotApplicable("Không tìm thấy thay đổi cần áp dụng")
        status = str(row.get("status") or "")
        if status == "applied":
            return _row_to_staged(row)
        if status != "approved":
            raise ChangeNotApplicable("Thay đổi chưa được chủ cửa hàng duyệt")

        db_kind = str(row.get("kind") or "")
        if db_kind in {"listing", "inventory"}:
            message = f"Thay đổi {db_kind} chưa hỗ trợ áp ở GĐ1"
            await self._db.update_staged_change(
                change_id,
                {"status": "failed", "error": message},
                only_statuses=["approved"],
            )
            raise ChangeNotApplicable(message)

        if db_kind == "price":
            result = await self._db.rpc(
                "merchant_apply_price_change", {"p_change_id": change_id}
            )
        elif db_kind in {"promotion", "campaign"}:
            result = await self._db.rpc(
                "merchant_apply_announcement", {"p_change_id": change_id}
            )
        else:
            raise ChangeNotApplicable(f"Loại thay đổi {db_kind} không được hỗ trợ")

        applied_row = self._rpc_row(result)
        if applied_row is None:
            applied_row = await self._fetch_change(change_id)
        if applied_row is None:
            raise ChangeNotApplicable("Không đọc lại được thay đổi sau khi áp dụng")
        return _row_to_staged(applied_row)

    async def discard_change(
        self,
        session: MerchantSessionContext,
        change_id: str,
        actor_kind: ActorKind = ActorKind.OPERATOR,
    ) -> StagedChange:
        row = await self._fetch_change(change_id)
        if row is None:
            raise ChangeNotApplicable("Không tìm thấy thay đổi cần hủy")
        status = str(row.get("status") or "")
        if status == "discarded":
            return _row_to_staged(row)
        if status not in {"staged", "approved"}:
            raise ChangeNotApplicable("Chỉ có thể hủy thay đổi đang chờ")
        updated = await self._db.update_staged_change(
            change_id,
            {"status": "discarded"},
            only_statuses=["staged", "approved"],
        )
        if updated is None:
            raise ChangeNotApplicable("Thay đổi đã được xử lý ở nơi khác")
        return _row_to_staged(updated)

    @staticmethod
    def _rpc_row(result: Any) -> dict[str, Any] | None:
        if isinstance(result, dict):
            return result
        if isinstance(result, list):
            for item in result:
                if isinstance(item, dict):
                    return item
        return None

    # -- analysis -------------------------------------------------------------

    async def execute_analysis_query(
        self, session: MerchantSessionContext, sql: str
    ) -> AnalysisTable | None:
        refusal = check_analysis_sql(_strip_leading_sql_comments(sql))
        if refusal:
            raise ChangeNotApplicable(f"Truy vấn không hợp lệ: {refusal}")
        result = await self._db.rpc(
            "merchant_analysis_query",
            {"p_sql": sql, "p_max_rows": min(self.config.max_analysis_rows, 1000)},
        )
        if isinstance(result, dict) and "rows" in result:
            result = result["rows"]
        if not isinstance(result, list):
            return AnalysisTable(columns=[], rows=[], row_count=0)
        rows: list[list[Any]] = []
        columns: list[str] = []
        for row in result:
            if isinstance(row, dict):
                if not columns:
                    columns = list(row.keys())
                rows.append([row.get(column) for column in columns])
            elif isinstance(row, list):
                rows.append(row)
        if not columns and rows:
            columns = [f"c{index + 1}" for index in range(len(rows[0]))]
        return AnalysisTable(
            columns=columns,
            rows=rows,
            row_count=len(rows),
            truncated=False,
        )

    async def get_analysis_schema(
        self, session: MerchantSessionContext
    ) -> str | None:
        return (
            "Schema merchant_analysis (chỉ đọc, dữ liệu BMQ đã loại đơn test/hủy):\n"
            "dealer_orders_v(order_number, customer_id, customer_name, is_npp, status, "
            "requested_delivery_date, submitted_at, total_amount_vnd)\n"
            "dealer_order_lines_v(order_number, requested_delivery_date, customer_name, "
            "route_customer_name, sku_code, product_name, quantity, exchange_quantity, "
            "makeup_quantity, line_total_vnd)\n"
            "revenue_lines_v(revenue_date, channel, customer_name, product_name, quantity, "
            "gross_revenue, customer_payable)\n"
            "skus_v(id, sku_code, product_name, category, unit, selling_price, hidden, has_image)\n"
            "dealer_prices_v(id, customer_id, customer_name, sku_id, sku_code, "
            "price_vnd_per_unit, updated_at)\n"
            "Tiền tệ VND; ngày theo Asia/Ho_Chi_Minh. Chỉ dùng SELECT/WITH."
        )

    async def get_merchant_context(
        self, session: MerchantSessionContext
    ) -> dict[str, Any] | None:
        # Real channel values let the model segment revenue with "channel:<value>".
        revenue_channels: list[str] = []
        try:
            rows = await self._db.rpc(
                "merchant_analysis_query",
                {
                    "p_sql": (
                        "select channel, count(*) as lines from revenue_lines_v "
                        "where revenue_date >= current_date - 90 and channel is not null "
                        "group by channel order by lines desc"
                    ),
                    "p_max_rows": 30,
                },
            )
            revenue_channels = [str(row.get("channel")) for row in rows or [] if row.get("channel")]
        except Exception:  # context is best effort; the agent still works without it
            revenue_channels = []
        return {
            "brand_name": "Bánh Mì Que BMQ",
            "business": "Chuỗi bánh mì que và đại lý/NPP tại Việt Nam.",
            "currency": "VND",
            "timezone": "Asia/Ho_Chi_Minh",
            "channels": revenue_channels or ["đại lý/NPP", "kiosk", "cửa hàng"],
            "revenue_segment_hint": "Lọc doanh thu theo kênh bằng segment 'channel:<tên kênh đúng như trong channels>'.",
            "limitations": [
                DataLimitation(
                    source="inventory",
                    note="GĐ1 chưa có cảnh báo tồn kho đáng tin cậy.",
                ).model_dump(),
                DataLimitation(
                    source="campaigns",
                    note="GĐ1 chưa đọc được hiệu quả chiến dịch.",
                ).model_dump(),
            ],
        }


def _parse_datetime(value: Any) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if isinstance(value, str) and value:
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    return None
