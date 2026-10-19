"""Read-only Agent SDK tool for purchase-order detail in owner chat.

The tool reads straight from Supabase through ``BmqMerchantBackend``; it never
writes and never builds PostgREST embeds.  Shared validation/serialization
helpers come from ``warehouse_tools`` so the model sees the same compact result
contract as the other direct warehouse tools.
"""

from __future__ import annotations

import re
from datetime import date
from typing import Any

from claude_agent_sdk import SdkMcpTool

from .backend import _today_vn
from .config import Settings
from .warehouse_tools import (
    MAX_COMPACT_CHARS,
    _compact_json,
    _day_value,
    _error,
    _json_text,
    _limit_value,
    _ok,
    _safe_tool,
    _ToolInputError,
)

PURCHASE_ORDER_TOOL_NAME = "bmq_purchase_orders"
PURCHASE_ORDER_TOOL_DESCRIPTION = (
    "Xem chi tiết/danh sách đơn mua hàng (PO) theo ngày hoặc khoảng ngày, có "
    "thể lọc theo tên nhà cung cấp hoặc trạng thái. Trả về mã PO, ngày đặt, "
    "ngày dự kiến, nhà cung cấp, trạng thái, tổng tiền, VAT, ghi chú và các "
    "dòng hàng. Dùng date (YYYY-MM-DD hoặc DD/MM) hoặc date_from/date_to; "
    "khoảng tối đa 31 ngày. limit 1..50, mặc định 30."
)

# Mirrors Database["public"]["Enums"]["purchase_order_status"] in
# apps/web/src/integrations/supabase/types.ts.
PURCHASE_ORDER_STATUSES = (
    "draft",
    "sent",
    "in_transit",
    "completed",
    "cancelled",
)
MISSING_SUPPLIER = "Chưa gán nhà cung cấp"
_DDMM_PATTERN = re.compile(r"^(\d{2})/(\d{2})$")

PURCHASE_ORDER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "date": {
            "type": ["string", "null"],
            "description": "Một ngày, dạng YYYY-MM-DD hoặc DD/MM",
        },
        "date_from": {
            "type": ["string", "null"],
            "description": "Ngày bắt đầu (bao gồm), YYYY-MM-DD hoặc DD/MM",
        },
        "date_to": {
            "type": ["string", "null"],
            "description": "Ngày kết thúc (bao gồm), YYYY-MM-DD hoặc DD/MM",
        },
        "supplier": {
            "type": ["string", "null"],
            "description": "Tên nhà cung cấp cần lọc (không phân biệt hoa thường/dấu)",
        },
        "status": {
            "type": ["string", "null"],
            "enum": [*PURCHASE_ORDER_STATUSES, None],
        },
        "limit": {
            "type": ["integer", "null"],
            "minimum": 1,
            "maximum": 50,
        },
    },
    "additionalProperties": False,
}


def _purchase_order_day(value: Any, field: str, today: date) -> date:
    if isinstance(value, str):
        text = value.strip()
        match = _DDMM_PATTERN.fullmatch(text)
        if match:
            day, month = int(match.group(1)), int(match.group(2))
            try:
                return date(today.year, month, day)
            except ValueError:
                raise _ToolInputError(
                    f"câu hỏi chưa đúng cú pháp: {field} không hợp lệ"
                ) from None
        return _day_value(text, field)
    return _day_value(value, field)


def _validate_purchase_order_args(args: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(args, dict):
        raise _ToolInputError("câu hỏi chưa đúng cú pháp: tham số không hợp lệ")
    unknown = set(args) - {
        "date",
        "date_from",
        "date_to",
        "supplier",
        "status",
        "limit",
    }
    if unknown:
        raise _ToolInputError(
            "câu hỏi chưa đúng cú pháp: trường không được hỗ trợ: "
            + ", ".join(sorted(unknown))
        )

    provided = {
        key: value
        for key, value in args.items()
        if value is not None and value != ""
    }
    has_date = "date" in provided
    has_from = "date_from" in provided
    has_to = "date_to" in provided
    if has_date and (has_from or has_to):
        raise _ToolInputError(
            "câu hỏi chưa đúng cú pháp: chỉ dùng date hoặc date_from/date_to"
        )

    today = _today_vn()
    if has_date:
        start = end = _purchase_order_day(provided["date"], "date", today)
    elif has_from and has_to:
        start = _purchase_order_day(provided["date_from"], "date_from", today)
        end = _purchase_order_day(provided["date_to"], "date_to", today)
    elif has_from or has_to:
        raise _ToolInputError(
            "câu hỏi chưa đúng cú pháp: cần cả date_from và date_to"
        )
    else:
        raise _ToolInputError(
            "câu hỏi chưa đúng cú pháp: cần date hoặc date_from/date_to"
        )

    if end < start:
        raise _ToolInputError(
            "câu hỏi chưa đúng cú pháp: date_to phải sau hoặc bằng date_from"
        )
    if (end - start).days > 30:
        raise _ToolInputError(
            "câu hỏi chưa đúng cú pháp: khoảng ngày tối đa 31 ngày"
        )

    supplier: str | None = provided.get("supplier")
    if supplier is not None:
        if (
            not isinstance(supplier, str)
            or len(supplier) > 120
            or any(ord(character) < 32 for character in supplier)
        ):
            raise _ToolInputError(
                "câu hỏi chưa đúng cú pháp: supplier không hợp lệ"
            )
        supplier = supplier.strip() or None

    status: str | None = provided.get("status")
    if status is not None and (
        not isinstance(status, str) or status not in PURCHASE_ORDER_STATUSES
    ):
        raise _ToolInputError("câu hỏi chưa đúng cú pháp: status không hợp lệ")

    limit = 30 if "limit" not in provided else provided["limit"]
    return {
        "start": start,
        "end": end,
        "supplier": supplier,
        "status": status,
        "limit": _limit_value(limit, 1, 50),
    }


def _period_label(start: date, end: date) -> str:
    if start == end:
        return f"ngày {start.strftime('%d/%m/%Y')}"
    return (
        f"khoảng từ {start.strftime('%d/%m/%Y')} "
        f"đến {end.strftime('%d/%m/%Y')}"
    )


def _format_amount(value: Any) -> str:
    try:
        return f"{float(value):,.0f} VND"
    except (TypeError, ValueError):
        return "chưa có"


def _summary(payload: dict[str, Any], start: date, end: date) -> str:
    count = int(payload.get("count") or 0)
    period = _period_label(start, end)
    if count == 0:
        text = f"Không có đơn mua hàng nào trong {period}."
    else:
        text = (
            f"Có {count} đơn mua hàng trong {period}. "
            f"Tổng tiền: {_format_amount(payload.get('total_amount'))}."
        )
        supplier_counts = payload.get("supplier_counts")
        if isinstance(supplier_counts, dict) and supplier_counts:
            parts = [
                f"{name}: {amount}"
                for name, amount in sorted(
                    supplier_counts.items(),
                    key=lambda item: (-int(item[1]), str(item[0])),
                )
            ]
            text += " Theo nhà cung cấp: " + "; ".join(parts) + "."

    omitted = int(payload.get("pos_omitted") or 0)
    if omitted:
        shown = len(payload.get("purchase_orders") or [])
        text += (
            f" Đang hiển thị {shown}/{count} đơn; "
            f"{omitted} đơn không hiển thị do giới hạn."
        )
    return text


def _fit_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Trim line items first so every selected PO stays in the payload."""

    purchase_orders = payload.get("purchase_orders")
    if not isinstance(purchase_orders, list):
        return payload

    removed_lines = 0
    while len(_json_text(payload)) > MAX_COMPACT_CHARS:
        for purchase_order in reversed(purchase_orders):
            items = purchase_order.get("items")
            if isinstance(items, list) and items:
                items.pop()
                removed_lines += 1
                payload["lines_omitted"] = removed_lines
                break
        else:
            break

    if len(_json_text(payload)) > MAX_COMPACT_CHARS:
        shortened_notes = False
        for purchase_order in purchase_orders:
            notes = purchase_order.get("notes")
            if isinstance(notes, str) and len(notes) > 160:
                purchase_order["notes"] = notes[:160] + "…"
                shortened_notes = True
        if shortened_notes:
            payload["notes_truncated"] = True

    # A pathological result can still be too large after every item line and
    # long note is gone.  Drop whole POs only as a last resort, and say so.
    omitted_for_size = 0
    while (
        len(_json_text(payload)) > MAX_COMPACT_CHARS
        and len(purchase_orders) > 1
    ):
        purchase_orders.pop()
        omitted_for_size += 1
        payload["pos_omitted"] = int(payload.get("pos_omitted") or 0) + 1
        payload["pos_omitted_for_size"] = True
    return payload


def build_purchase_order_tools(
    chat_session: Any,
    settings: Settings,
) -> list[SdkMcpTool[Any]]:
    """Build the purchase-order read tool for one chat session."""

    @_safe_tool(
        PURCHASE_ORDER_TOOL_NAME,
        PURCHASE_ORDER_TOOL_DESCRIPTION,
        PURCHASE_ORDER_SCHEMA,
    )
    async def purchase_orders_tool(args: dict[str, Any]) -> dict[str, Any]:
        try:
            request = _validate_purchase_order_args(args)
        except _ToolInputError as exc:
            return _error(str(exc))

        result = await chat_session.backend.purchase_orders(
            request["start"],
            request["end"],
            supplier=request["supplier"],
            status=request["status"],
            limit=request["limit"],
        )
        payload: dict[str, Any] = {
            "date_from": request["start"].isoformat(),
            "date_to": request["end"].isoformat(),
            "count": result.get("count", 0),
            "total_amount": result.get("total_amount", 0),
            "supplier_counts": result.get("supplier_counts", {}),
            "purchase_orders": result.get("purchase_orders", []),
            "pos_omitted": result.get("pos_omitted", 0),
            "lines_omitted": 0,
        }
        payload = _fit_payload(payload)
        summary = _summary(payload, request["start"], request["end"])
        return _ok(f"{summary}\n{_compact_json(payload)}")

    return [purchase_orders_tool]
