"""Read-only Agent SDK tools over the local BMQ warehouse owner API.

The tools mirror the warehouse's own closed request grammars.  They never build
SQL, never write, and forward the current session owner token at call time.
Results are compact JSON (or a short Vietnamese summary for images) so a tool
result cannot flood the model context.
"""

from __future__ import annotations

import json
import logging
import math
import re
import unicodedata
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Awaitable, Callable

from claude_agent_sdk import SdkMcpTool, tool

from .config import Settings
from .warehouse import WarehouseClient, WarehouseError

logger = logging.getLogger(__name__)

MAX_COMPACT_CHARS = 6000
MAX_IMAGES = 8

EXAMPLE_SELECTION_RULE = "largest_line_amount_then_source_date_then_classification_id"
COST_DISCLAIMER = (
    "Toàn bộ dòng chi phí theo view phân loại chuẩn (dòng đã phân loại + dòng "
    "OCR-only có metadata chi phí), không phải báo cáo đã kiểm toán."
)

REVIEW_STATUSES = ("needs_review", "suggested", "approved", "rejected")
CATEGORY_PATTERN = re.compile(r"^[A-Z][A-Z0-9_]{0,49}$")
REFERENCE_PATTERN = re.compile(r"^[A-Za-z0-9-]{1,64}$")
MONTH_PATTERN = re.compile(r"^\d{4}-\d{2}$")
DAY_PATTERN = re.compile(r"^\d{4}-\d{2}-\d{2}$")
HEX64_PATTERN = re.compile(r"^[0-9a-f]{64}$")
CONTROL_PATTERN = re.compile(r"[\x00-\x1f\x7f-\x9f]")
MARKUP_PATTERN = re.compile(r"[\\`*_{}\[\]()<>#!|]")
TIME_RANGE_PATTERN = re.compile(
    r"^(today|yesterday|this_week|previous_week|this_month|previous_month|"
    r"\d{4}-\d{2}-\d{2}/\d{4}-\d{2}-\d{2})$"
)

# Mirrored from sme-data-platform/src/sme_platform/bmq_cost.py QUESTIONS.
# Keep this in sync with the warehouse contract; the handler validates against it
# before making any HTTP call.
COST_QUESTIONS: dict[str, dict[str, tuple[str, ...]]] = {
    "month_totals": {
        "required": ("month",),
        "optional": ("category_code", "review_status", "limit"),
    },
    "pending_summary": {"required": ("month",), "optional": ("category_code",)},
    "top_pending_lines": {
        "required": ("month",),
        "optional": ("category_code", "limit"),
    },
    "example_line": {
        "required": ("month",),
        "optional": ("category_code", "review_status", "limit"),
    },
    "category_comparison": {
        "required": ("month", "month_b"),
        "optional": ("category_code", "review_status", "limit"),
    },
    "unmapped_low_confidence": {"required": ("month",), "optional": ("limit",)},
    "line_explanation": {"required": ("line_ref",), "optional": ()},
    "sync_freshness": {"required": (), "optional": ()},
}
COST_FIELDS = frozenset(
    {"question", "month", "month_b", "category_code", "review_status", "line_ref", "limit"}
)

# Mirrored from sme-data-platform/src/sme_platform/bmq_payment.py QUESTIONS.
PAYMENT_QUESTIONS: dict[str, dict[str, tuple[str, ...]]] = {
    "supplier_payments": {
        "required": ("month",),
        "optional": ("supplier", "item", "limit"),
    }
}

# Mirrored from sme-data-platform/src/sme_platform/bmq_customer.py and
# bmq_business.py / bmq_semantic.py METRICS.
CUSTOMER_KINDS = (
    "prices",
    "effective_prices",
    "orders",
    "npp_receivable",
    "order_details",
)
CUSTOMER_BASE_KEYS = frozenset({"kind", "customer", "product", "time_range", "limit"})
METRIC_DIMENSIONS: dict[str, tuple[str, ...]] = {
    "controlled_revenue": ("date", "channel"),
    "purchase_order_count": ("date", "status"),
    "low_stock_count": ("category",),
    "supplier_debt": ("payment_method",),
}
UNC_MIMES = frozenset({"image/png", "image/jpeg", "image/gif", "image/webp"})

_VERBOSE_KEYS = frozenset(
    {
        "definition",
        "definition_vi",
        "policy",
        "abstains",
        "accepted_qualifiers",
        "canonical_categories",
        "rule_metadata_note",
        "freshness",
        "pricing",
        "price_basis",
        "currency_policy",
        "cache_hit",
        "read_at",
    }
)


class _ToolInputError(ValueError):
    """Invalid tool arguments; the message is safe to return to the model."""


def _error(message: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": str(message)}], "is_error": True}


def _ok(text: str) -> dict[str, Any]:
    return {"content": [{"type": "text", "text": text}]}


def _safe_tool(
    name: str,
    description: str,
    input_schema: dict[str, Any],
) -> Callable[[Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]], SdkMcpTool[Any]]:
    """Wrap a handler so no validation, HTTP or SDK exception escapes."""

    def decorator(
        handler: Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]
    ) -> SdkMcpTool[Any]:
        @tool(name, description, input_schema)
        async def run(args: dict[str, Any]) -> dict[str, Any]:
            try:
                return await handler(args)
            except _ToolInputError as exc:
                return _error(str(exc))
            except WarehouseError as exc:
                return _error(str(exc))
            except Exception:
                logger.exception("Lỗi không mong đợi trong công cụ kho dữ liệu %s", name)
                return _error("chưa xử lý được yêu cầu tra cứu")

        return run

    return decorator


def _json_text(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), default=str)


def _strip_verbose(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: _strip_verbose(item)
            for key, item in value.items()
            if key not in _VERBOSE_KEYS
        }
    if isinstance(value, list):
        return [_strip_verbose(item) for item in value]
    if isinstance(value, str) and len(value) > 1000:
        return value[:1000] + "…"
    return value


def _trim_largest_list(value: Any) -> bool:
    """Halve the largest list in place; return whether anything changed."""

    largest: list[Any] | None = None
    largest_size = 0

    def walk(node: Any) -> None:
        nonlocal largest, largest_size
        if isinstance(node, dict):
            for item in node.values():
                walk(item)
        elif isinstance(node, list):
            if len(node) > largest_size:
                largest = node
                largest_size = len(node)
            for item in node:
                walk(item)

    walk(value)
    if largest is None or largest_size <= 1:
        return False
    del largest[max(1, largest_size // 2) :]
    return True


def _compact_json(value: Any, limit: int = MAX_COMPACT_CHARS) -> str:
    """Serialize compactly, keeping a valid JSON object within the model budget."""

    text = _json_text(value)
    if len(text) <= limit:
        return text

    lean = _strip_verbose(value)
    text = _json_text(lean)
    if len(text) <= limit:
        return text

    if isinstance(lean, dict):
        lean["truncated_for_model"] = True
    while len(text) > limit and _trim_largest_list(lean):
        text = _json_text(lean)
    if len(text) <= limit:
        return text

    # Last resort: keep valid JSON and expose only the head of the payload.
    note = "Kết quả quá dài, chỉ hiển thị phần đầu."
    low, high = 0, len(text)
    best = _json_text({"truncated_for_model": True, "note": note, "preview": ""})
    while low <= high:
        middle = (low + high) // 2
        candidate = _json_text(
            {"truncated_for_model": True, "note": note, "preview": text[:middle]}
        )
        if len(candidate) <= limit:
            best = candidate
            low = middle + 1
        else:
            high = middle - 1
    return best


def _token(chat_session: Any) -> str:
    value = getattr(chat_session, "owner_token", "")
    return value if isinstance(value, str) else ""


def _append_ui(chat_session: Any, block: dict[str, Any]) -> None:
    pending = getattr(chat_session, "pending_ui", None)
    if isinstance(pending, list):
        pending.append(block)


def _month_value(value: Any, field: str = "month") -> str:
    if not isinstance(value, str) or not MONTH_PATTERN.fullmatch(value):
        raise _ToolInputError(
            f"câu hỏi chưa đúng cú pháp: {field} phải có dạng YYYY-MM"
        )
    try:
        year, month_number = int(value[:4]), int(value[5:])
        if not 2000 <= year <= 2100:
            raise ValueError
        date(year, month_number, 1)
    except (ValueError, TypeError):
        raise _ToolInputError(
            f"câu hỏi chưa đúng cú pháp: {field} không hợp lệ"
        ) from None
    return value


def _day_value(value: Any, field: str) -> date:
    if not isinstance(value, str) or not DAY_PATTERN.fullmatch(value):
        raise _ToolInputError(
            f"câu hỏi chưa đúng cú pháp: {field} phải có dạng YYYY-MM-DD"
        )
    try:
        return date.fromisoformat(value)
    except ValueError:
        raise _ToolInputError(
            f"câu hỏi chưa đúng cú pháp: {field} không hợp lệ"
        ) from None


def _limit_value(value: Any, minimum: int, maximum: int, field: str = "limit") -> int:
    if type(value) is not int or not minimum <= value <= maximum:
        raise _ToolInputError(
            f"câu hỏi chưa đúng cú pháp: {field} phải trong khoảng {minimum}..{maximum}"
        )
    return value


def _drop_none(values: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in values.items() if value is not None}


def _validate_cost(args: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(args, dict):
        raise _ToolInputError("câu hỏi chưa đúng cú pháp: tham số không hợp lệ")
    unknown = set(args) - COST_FIELDS
    if unknown:
        raise _ToolInputError(
            "câu hỏi chưa đúng cú pháp: trường không được hỗ trợ: "
            + ", ".join(sorted(unknown))
        )
    provided = _drop_none(args)
    question = provided.get("question")
    if not isinstance(question, str) or question not in COST_QUESTIONS:
        raise _ToolInputError("câu hỏi chưa đúng cú pháp: câu hỏi chi phí không hợp lệ")
    spec = COST_QUESTIONS[question]
    allowed = {"question", *spec["required"], *spec["optional"]}
    extra = set(provided) - allowed
    if extra:
        raise _ToolInputError(
            "câu hỏi chưa đúng cú pháp: trường không được hỗ trợ cho câu hỏi này: "
            + ", ".join(sorted(extra))
        )

    request: dict[str, Any] = {"question": question}
    for key in spec["required"]:
        value = provided.get(key)
        if value is None or value == "":
            raise _ToolInputError(f"câu hỏi chưa đúng cú pháp: thiếu {key}")
        request[key] = value
    for key in spec["optional"]:
        if key in provided:
            request[key] = provided[key]

    if "month" in request:
        request["month"] = _month_value(request["month"], "month")
    if "month_b" in request:
        request["month_b"] = _month_value(request["month_b"], "month_b")
        if request["month_b"] == request["month"]:
            raise _ToolInputError(
                "câu hỏi chưa đúng cú pháp: hai tháng so sánh phải khác nhau"
            )
    if "line_ref" in request:
        value = request["line_ref"]
        if not isinstance(value, str) or not REFERENCE_PATTERN.fullmatch(value):
            raise _ToolInputError(
                "câu hỏi chưa đúng cú pháp: line_ref không hợp lệ"
            )
    if "category_code" in request:
        value = request["category_code"]
        if value == "":
            request.pop("category_code")
        elif not isinstance(value, str) or not CATEGORY_PATTERN.fullmatch(value):
            raise _ToolInputError(
                "câu hỏi chưa đúng cú pháp: category_code không hợp lệ"
            )
    if "review_status" in request:
        value = request["review_status"]
        if value == "":
            request.pop("review_status")
        elif not isinstance(value, str) or value not in REVIEW_STATUSES:
            raise _ToolInputError(
                "câu hỏi chưa đúng cú pháp: review_status không hợp lệ"
            )
    if "limit" in request:
        request["limit"] = _limit_value(request["limit"], 1, 50)
    return request


def _validate_payment(args: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(args, dict):
        raise _ToolInputError("câu hỏi chưa đúng cú pháp: tham số không hợp lệ")
    unknown = set(args) - {"question", "month", "supplier", "item", "limit"}
    if unknown:
        raise _ToolInputError(
            "câu hỏi chưa đúng cú pháp: trường không được hỗ trợ: "
            + ", ".join(sorted(unknown))
        )
    provided = _drop_none(args)
    question = provided.get("question")
    if not isinstance(question, str) or question not in PAYMENT_QUESTIONS:
        raise _ToolInputError(
            "câu hỏi chưa đúng cú pháp: câu hỏi thanh toán không hợp lệ"
        )
    spec = PAYMENT_QUESTIONS["supplier_payments"]
    allowed = {"question", *spec["required"], *spec["optional"]}
    extra = set(provided) - allowed
    if extra:
        raise _ToolInputError(
            "câu hỏi chưa đúng cú pháp: trường không được hỗ trợ cho câu hỏi này: "
            + ", ".join(sorted(extra))
        )
    month = provided.get("month")
    if month is None or month == "":
        raise _ToolInputError("câu hỏi chưa đúng cú pháp: thiếu month")
    request: dict[str, Any] = {
        "question": "supplier_payments",
        "month": _month_value(month, "month"),
    }
    for key in ("supplier", "item"):
        value = provided.get(key)
        if value in (None, ""):
            continue
        if (
            not isinstance(value, str)
            or len(value) > 120
            or any(ord(character) < 32 for character in value)
        ):
            raise _ToolInputError(f"câu hỏi chưa đúng cú pháp: {key} không hợp lệ")
        value = value.strip()
        if value:
            request[key] = value
    if "limit" in provided:
        request["limit"] = _limit_value(provided["limit"], 1, 50)
    return request


def _normalized_customer(value: str) -> str:
    return " ".join(unicodedata.normalize("NFC", value).casefold().split())


def _validate_customer(args: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(args, dict):
        raise _ToolInputError("câu hỏi chưa đúng cú pháp: tham số không hợp lệ")
    allowed = CUSTOMER_BASE_KEYS | {"detail_filters"}
    unknown = set(args) - allowed
    if unknown:
        raise _ToolInputError(
            "câu hỏi chưa đúng cú pháp: trường không được hỗ trợ: "
            + ", ".join(sorted(unknown))
        )
    missing = CUSTOMER_BASE_KEYS - set(args)
    if missing:
        raise _ToolInputError(
            "câu hỏi chưa đúng cú pháp: thiếu "
            + ", ".join(sorted(missing))
        )
    kind = args.get("kind")
    if kind not in CUSTOMER_KINDS:
        raise _ToolInputError("câu hỏi chưa đúng cú pháp: kind không hợp lệ")
    customer = args.get("customer")
    product = args.get("product")
    for field in ("customer", "product"):
        value = args.get(field)
        if (
            not isinstance(value, str)
            or len(value) > 120
            or any(ord(character) < 32 for character in value)
        ):
            raise _ToolInputError(f"câu hỏi chưa đúng cú pháp: {field} không hợp lệ")
    if not _normalized_customer(customer):
        raise _ToolInputError("câu hỏi chưa đúng cú pháp: thiếu customer")
    price_kind = kind in {"prices", "effective_prices"}
    if not price_kind and kind != "order_details" and product.strip():
        raise _ToolInputError(
            "câu hỏi chưa đúng cú pháp: chỉ tra theo sản phẩm cho prices, "
            "effective_prices hoặc order_details"
        )
    limit = _limit_value(args.get("limit"), 1, 20)
    time_range = args.get("time_range")
    if not isinstance(time_range, str) or not TIME_RANGE_PATTERN.fullmatch(time_range):
        raise _ToolInputError(
            "câu hỏi chưa đúng cú pháp: time_range không hợp lệ"
        )
    if price_kind and time_range != "today":
        raise _ToolInputError(
            "câu hỏi chưa đúng cú pháp: không tra được lịch sử giá"
        )
    body: dict[str, Any] = {
        "kind": kind,
        "customer": customer,
        "product": product,
        "time_range": time_range,
        "limit": limit,
    }
    if "/" in time_range:
        start, end = time_range.split("/", 1)
        start_day = _day_value(start, "time_range")
        end_day = _day_value(end, "time_range")
        if end_day < start_day or (end_day - start_day).days > 730:
            raise _ToolInputError(
                "câu hỏi chưa đúng cú pháp: khoảng thời gian phải trong 0..730 ngày"
            )
        body["time_range"] = {"start": start, "end": end}
    detail_filters = args.get("detail_filters")
    if detail_filters is not None:
        if kind != "order_details":
            raise _ToolInputError(
                "câu hỏi chưa đúng cú pháp: detail_filters chỉ dùng cho order_details"
            )
        if not isinstance(detail_filters, dict):
            raise _ToolInputError(
                "câu hỏi chưa đúng cú pháp: detail_filters không hợp lệ"
            )
        unknown_filters = set(detail_filters) - {"date_basis", "status", "route"}
        if unknown_filters:
            raise _ToolInputError(
                "câu hỏi chưa đúng cú pháp: detail_filters có trường không hỗ trợ"
            )
        filters: dict[str, Any] = {}
        if "date_basis" in detail_filters:
            date_basis = detail_filters["date_basis"]
            if not isinstance(date_basis, str) or date_basis not in {
                "submitted",
                "delivery",
            }:
                raise _ToolInputError(
                    "câu hỏi chưa đúng cú pháp: date_basis không hợp lệ"
                )
            filters["date_basis"] = date_basis
        if "status" in detail_filters:
            status = detail_filters["status"]
            if not isinstance(status, str) or status not in {
                "submitted",
                "cancelled",
                "all",
            }:
                raise _ToolInputError(
                    "câu hỏi chưa đúng cú pháp: status không hợp lệ"
                )
            filters["status"] = status
        if "route" in detail_filters:
            route = detail_filters["route"]
            if (
                not isinstance(route, str)
                or len(route) > 120
                or any(ord(character) < 32 for character in route)
            ):
                raise _ToolInputError(
                    "câu hỏi chưa đúng cú pháp: route không hợp lệ"
                )
            filters["route"] = route
        body["detail_filters"] = filters
    return body


def _validate_metric(
    args: dict[str, Any]
) -> tuple[dict[str, Any], str, str | None]:
    if not isinstance(args, dict):
        raise _ToolInputError("câu hỏi chưa đúng cú pháp: tham số không hợp lệ")
    unknown = set(args) - {"metric", "dimension", "start", "end", "limit", "sort"}
    if unknown:
        raise _ToolInputError(
            "câu hỏi chưa đúng cú pháp: trường không được hỗ trợ: "
            + ", ".join(sorted(unknown))
        )
    metric = args.get("metric")
    if not isinstance(metric, str) or metric not in METRIC_DIMENSIONS:
        label = metric if isinstance(metric, str) and metric else "này"
        raise _ToolInputError(f"chỉ số {label} chưa hỗ trợ")
    dimension = args.get("dimension")
    if dimension in (None, ""):
        dimension = None
    elif not isinstance(dimension, str) or dimension not in METRIC_DIMENSIONS[metric]:
        raise _ToolInputError(
            f"chiều dữ liệu {dimension} chưa hỗ trợ cho chỉ số {metric}"
        )
    start = _day_value(args.get("start"), "start")
    end = _day_value(args.get("end"), "end")
    if end < start:
        raise _ToolInputError(
            "câu hỏi chưa đúng cú pháp: end phải sau hoặc bằng start"
        )
    if (end - start).days > 730:
        raise _ToolInputError(
            "câu hỏi chưa đúng cú pháp: khoảng thời gian phải trong 0..730 ngày"
        )
    dsl: dict[str, Any] = {
        "metric": metric,
        "time_range": {"start": start.isoformat(), "end": end.isoformat()},
        "dimensions": [dimension] if dimension else [],
    }
    limit = args.get("limit")
    if limit is not None:
        dsl["limit"] = _limit_value(limit, 1, 500)
    sort = args.get("sort")
    if sort in (None, ""):
        sort = None
    elif not isinstance(sort, str) or sort not in {"asc", "desc"}:
        raise _ToolInputError("câu hỏi chưa đúng cú pháp: sort không hợp lệ")
    return dsl, metric, sort


def _sort_metric_rows(result: Any, metric: str, sort: str) -> None:
    if not isinstance(result, dict):
        return
    rows = result.get("rows")
    if not isinstance(rows, list):
        return

    def key(row: Any) -> tuple[int, float]:
        if not isinstance(row, dict):
            return (1, 0.0)
        try:
            value = float(row.get(metric))
        except (TypeError, ValueError):
            return (1, 0.0)
        if not math.isfinite(value):
            return (1, 0.0)
        return (0, -value if sort == "desc" else value)

    rows.sort(key=key)


def _validate_unc(args: dict[str, Any]) -> tuple[dict[str, Any], str | None, str | None]:
    if not isinstance(args, dict):
        raise _ToolInputError("câu hỏi chưa đúng cú pháp: tham số không hợp lệ")
    unknown = set(args) - {"date", "month", "limit"}
    if unknown:
        raise _ToolInputError(
            "câu hỏi chưa đúng cú pháp: trường không được hỗ trợ: "
            + ", ".join(sorted(unknown))
        )
    raw_date = args.get("date")
    raw_month = args.get("month")
    has_date = raw_date not in (None, "")
    has_month = raw_month not in (None, "")
    if has_date == has_month:
        raise _ToolInputError(
            "câu hỏi chưa đúng cú pháp: chọn đúng một trong date hoặc month"
        )
    limit = 8 if args.get("limit") is None else args.get("limit")
    limit = _limit_value(limit, 1, MAX_IMAGES)
    if has_date:
        day = _day_value(raw_date, "date")
        if not 2000 <= day.year <= 2100:
            raise _ToolInputError(
                "câu hỏi chưa đúng cú pháp: date ngoài khoảng hỗ trợ"
            )
        return {"date": day.isoformat(), "limit": limit}, day.isoformat(), None
    month = _month_value(raw_month, "month")
    return {"month": month, "limit": limit}, None, month


def _map_images(
    body: Any,
    requested_date: str | None,
    requested_month: str | None,
    limit: int,
) -> list[dict[str, Any]]:
    if not isinstance(body, dict) or not isinstance(body.get("images"), list):
        raise WarehouseError("kho dữ liệu tạm không phản hồi")
    images: list[dict[str, Any]] = []
    for item in body["images"]:
        if len(images) >= min(limit, MAX_IMAGES):
            break
        if not isinstance(item, dict):
            continue
        identifier = item.get("id")
        declaration = item.get("declaration_id")
        day = item.get("date")
        if (
            not isinstance(identifier, str)
            or not HEX64_PATTERN.fullmatch(identifier)
            or not isinstance(declaration, str)
            or not isinstance(day, str)
            or not DAY_PATTERN.fullmatch(day)
        ):
            continue
        try:
            date.fromisoformat(day)
        except ValueError:
            continue
        if requested_date is not None and day != requested_date:
            continue
        if requested_month is not None and not day.startswith(requested_month + "-"):
            continue
        kind = item.get("kind")
        if kind is not None and kind != "UNC":
            continue
        if item.get("payment_status") != "submitted_unverified":
            continue
        mime_type = item.get("mime_type")
        if mime_type is not None and (
            not isinstance(mime_type, str) or mime_type not in UNC_MIMES
        ):
            continue
        images.append(
            {
                "id": identifier,
                "date": day,
                "declarationId": declaration,
                "paymentStatus": "submitted_unverified",
            }
        )
    return images


def _unc_summary(
    images: list[dict[str, Any]],
    requested_date: str | None,
    requested_month: str | None,
) -> str:
    period = requested_date or requested_month or ""
    if not images:
        return (
            f"Chưa có ảnh UNC phù hợp cho {period}. "
            "Không đồng nghĩa không có thanh toán."
        )
    dates = sorted({image["date"] for image in images})
    declarations: list[str] = []
    for image in images:
        declaration = image["declarationId"][:120]
        if declaration and declaration not in declarations:
            declarations.append(declaration)
    text = f"Có {len(images)} ảnh UNC cho {period}. Ngày: {', '.join(dates)}."
    if declarations:
        text += f" Mã chứng từ: {', '.join(declarations[:MAX_IMAGES])}."
    text += " Ảnh đã nộp, chưa xác nhận thanh toán."
    return text


# ---------------------------------------------------------------------------
# Cost-card projection, ported from apps/web/supabase/functions/bmq-analytics/
# cost.ts costBlock()/buildCostBlock()/lineEvidenceNotes().  The block is derived
# only from the warehouse line result; an invalid shape yields None instead of an
# invented card.
# ---------------------------------------------------------------------------


def _clean(value: Any, maximum: int = 200) -> str:
    if (
        not isinstance(value, str)
        or len(value) > maximum
        or CONTROL_PATTERN.search(value)
    ):
        raise ValueError("invalid text")
    return MARKUP_PATTERN.sub(" ", value).strip()


def _identifier(value: Any, maximum: int = 64) -> str:
    if (
        not isinstance(value, str)
        or len(value) > maximum
        or CONTROL_PATTERN.search(value)
        or not value.strip()
    ):
        raise ValueError("invalid identifier")
    return value.strip()


def _optional_identifier(value: Any, maximum: int = 64) -> str | None:
    if value is None or value == "":
        return None
    return _identifier(value, maximum)


def _optional_text(value: Any, maximum: int = 200) -> str | None:
    if value is None or value == "":
        return None
    return _clean(value, maximum)


def _amount(value: Any) -> int | float:
    if isinstance(value, bool) or not isinstance(
        value, (str, int, float, Decimal)
    ):
        raise ValueError("invalid amount")
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        raise ValueError("invalid amount") from None
    if not math.isfinite(parsed):
        raise ValueError("invalid amount")
    # Match JSON.stringify(Number) for integral amounts while keeping fractional
    # amounts as numbers.
    return int(parsed) if parsed.is_integer() else parsed


def _count(value: Any) -> int:
    if type(value) is not int or value < 0:
        raise ValueError("invalid count")
    return value


def _valid_timestamp(value: Any) -> bool:
    if not isinstance(value, str):
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return True


def _block_month(value: Any, fallback: Any) -> str | None:
    for candidate in (value, fallback):
        if isinstance(candidate, str) and MONTH_PATTERN.fullmatch(candidate[:7]):
            return candidate[:7]
    return None


def _dash(value: Any) -> str:
    return "-" if value is None else str(value)


def _line_evidence_notes(evidence: Any) -> list[str]:
    if not isinstance(evidence, dict):
        evidence = {}
    notes: list[str] = []
    rule = evidence.get("rule")
    if rule is not None:
        if not isinstance(rule, dict):
            raise ValueError("invalid rule evidence")
        note = (
            f"Rule đã lưu: {_clean(rule.get('rule_name'), 200)} · "
            f"{_clean(rule.get('match_scope'), 60)} · "
            f"ưu tiên {_clean(_dash(rule.get('priority')), 20)} · "
            f"độ tin cậy {_clean(_dash(rule.get('confidence')), 20)}"
        )
        effective_from = rule.get("effective_from")
        if effective_from is not None and effective_from != "":
            from_text = _clean(str(effective_from), 10)
            effective_to = rule.get("effective_to")
            to_text = (
                _clean(str(effective_to), 10)
                if effective_to is not None and effective_to != ""
                else ""
            )
            note += f" · {from_text} → {to_text or 'không giới hạn'}"
        notes.append(note)
        notes.append(
            "Đây là metadata hiện tại của liên kết rule đã lưu; không phải bằng "
            "chứng rule hiện tại đã tạo ra kết quả phân loại lịch sử."
        )
    else:
        notes.append(
            "Không có rule nào được gắn với phân loại này (nguồn lưu không phải "
            "rule khớp); lý do lịch sử không có sẵn và hệ thống không tự suy diễn."
        )
    alias = evidence.get("alias_mapping")
    if alias is not None:
        if not isinstance(alias, dict):
            raise ValueError("invalid alias evidence")
        notes.append(
            f"Ánh xạ alias: {_clean(alias.get('source_name'), 200)} → "
            f"{_clean(alias.get('standard_cost_code'), 60)} · "
            f"{_clean(alias.get('canonical_cost_item_name'), 200)}"
        )
    else:
        alias_status = evidence.get("alias_status")
        if alias_status and alias_status != "no_mapping_match":
            notes.append(
                f"Bằng chứng ánh xạ alias: {_clean(alias_status, 60)}"
            )
    return notes


def _build_cost_block(result: Any, kind: str) -> dict[str, Any] | None:
    if kind not in {"example_line", "line_explanation"}:
        return None
    if not isinstance(result, dict) or result.get("question") != kind:
        return None
    source = result.get("source")
    observed_at = result.get("source_observed_at")
    snapshot_id = result.get("snapshot_id")
    semantic_version = result.get("semantic_version")
    if (
        not isinstance(source, str)
        or not source
        or not _valid_timestamp(observed_at)
        or not isinstance(snapshot_id, str)
        or not isinstance(semantic_version, str)
        or len(_json_text(result)) > 40000
    ):
        return None

    if kind == "example_line":
        if result.get("selection_rule") != EXAMPLE_SELECTION_RULE:
            return None
        rows = result.get("rows")
        if not isinstance(rows, list) or len(rows) > 1:
            return None
        if not rows:
            return None
        picked = rows[0]
        if not isinstance(picked, dict):
            return None
        match_count = _count(result.get("match_count"))
        selected = result.get("line")
        if selected is not None:
            if not isinstance(selected, dict) or str(
                selected.get("classification_id")
            ) != str(picked.get("classification_id")):
                return None
            line = selected
            stored = True
            evidence = result.get("evidence") or {}
            notes = _line_evidence_notes(evidence)
        else:
            line = picked
            stored = False
            evidence = {}
            notes = [
                "Chưa lấy được bằng chứng phân loại đã lưu cho dòng này; hệ thống "
                "không tự suy diễn lý do."
            ]
        mode = "example"
        selection_rule: str | None = EXAMPLE_SELECTION_RULE
        match_count_value: int | None = match_count
        truncated = result.get("truncated") is True
        month = _block_month(result.get("month"), line.get("month"))
    else:
        if result.get("status") != "ok":
            return None
        line = result.get("line")
        if not isinstance(line, dict):
            return None
        stored = True
        evidence = result.get("evidence") or {}
        notes = _line_evidence_notes(evidence)
        mode = "explanation"
        selection_rule = None
        match_count_value = None
        truncated = False
        month = _block_month(line.get("month"), result.get("month"))

    classification_id = _identifier(line.get("classification_id"), 64)
    rule = evidence.get("rule") if isinstance(evidence, dict) else None
    alias = evidence.get("alias_mapping") if isinstance(evidence, dict) else None
    alias_status = evidence.get("alias_status") if isinstance(evidence, dict) else None

    rule_block: dict[str, Any] | None = None
    if rule is not None:
        if not isinstance(rule, dict):
            raise ValueError("invalid rule evidence")
        rule_block = {
            "name": _clean(rule.get("rule_name"), 200),
            "scope": _identifier(rule.get("match_scope"), 60),
            "priority": _identifier(_dash(rule.get("priority")), 20),
            "confidence": _identifier(_dash(rule.get("confidence")), 20),
            "effectiveFrom": (
                _optional_text(str(rule.get("effective_from")), 10)
                if rule.get("effective_from") is not None
                else None
            ),
            "effectiveTo": (
                _optional_text(str(rule.get("effective_to")), 10)
                if rule.get("effective_to") is not None
                else None
            ),
        }
    alias_block: dict[str, Any] | None = None
    if alias is not None:
        if not isinstance(alias, dict):
            raise ValueError("invalid alias evidence")
        alias_block = {
            "sourceName": _clean(alias.get("source_name"), 200),
            "standardCode": _identifier(alias.get("standard_cost_code"), 60),
            "canonicalName": _clean(alias.get("canonical_cost_item_name"), 200),
        }

    source_date = line.get("source_date")
    confidence = line.get("confidence")
    return {
        "v": 1,
        "kind": "cost_line",
        "mode": mode,
        "month": month,
        "line": {
            "classificationId": classification_id,
            "sourceNumber": _optional_identifier(line.get("source_number"), 120),
            "sourceDate": (
                _optional_text(str(source_date), 10)
                if source_date is not None
                else None
            ),
            "supplierName": _optional_text(line.get("supplier_name"), 200),
            "productName": _clean(line.get("product_name"), 200),
            "amount": _amount(line.get("line_amount")),
            "categoryLabel": _optional_text(line.get("category_label"), 200),
            "categoryCode": _optional_identifier(line.get("category_code"), 60),
            "reviewStatus": _optional_identifier(line.get("review_status"), 40),
            "confidence": (
                _optional_identifier(str(confidence), 20)
                if confidence is not None
                else None
            ),
            "classificationSource": _optional_identifier(
                line.get("classification_source"), 60
            ),
        },
        "evidence": {
            "stored": stored,
            "rule": rule_block,
            "alias": alias_block,
            "aliasStatus": _optional_identifier(alias_status, 60),
        },
        "notes": notes,
        "source": {
            "name": _clean(source, 300),
            "observedAt": _clean(observed_at, 40),
            "snapshotId": _identifier(snapshot_id, 200),
            "semanticVersion": _identifier(semantic_version, 40),
            "selectionRule": selection_rule,
            "matchCount": match_count_value,
            "truncated": truncated,
            "disclaimer": COST_DISCLAIMER,
        },
        "followUp": (
            "line_explanation"
            if REFERENCE_PATTERN.fullmatch(classification_id)
            else None
        ),
    }


def cost_block(result: Any, kind: str, language: str = "vi") -> dict[str, Any] | None:
    """Project a single verified cost line into the chat renderer's card shape."""

    del language  # The BMQ agent answers in Vietnamese only.
    try:
        return _build_cost_block(result, kind)
    except Exception:
        # An optional presentation must never fail the already-truthful tool text.
        return None


# ---------------------------------------------------------------------------
# Tool descriptions and schemas.
# ---------------------------------------------------------------------------

COST_DESCRIPTION = (
    "Tra phân loại chi phí BMQ trực tiếp từ kho dữ liệu. Dùng khi hỏi tổng chi phí "
    "theo tháng/nhóm/trạng thái, dòng chờ duyệt, so sánh hai tháng, dòng chưa phân "
    "loại, hoặc giải thích một dòng chi phí ('vì sao dòng này'). Câu hỏi hợp lệ: "
    "month_totals (bắt buộc month), pending_summary (month), top_pending_lines "
    "(month), example_line (month), category_comparison (month, month_b), "
    "unmapped_low_confidence (month), line_explanation (bắt buộc line_ref), "
    "sync_freshness (không bắt buộc). Tùy chọn theo câu hỏi: category_code, "
    "review_status, limit; month dạng YYYY-MM."
)

PAYMENT_DESCRIPTION = (
    "Tra thanh toán thực tế đã trả cho nhà cung cấp trong một tháng. Dùng khi hỏi "
    "đã thanh toán/đã trả cho nhà cung cấp bao nhiêu, có thể lọc supplier hoặc "
    "item. question bắt buộc 'supplier_payments'; month bắt buộc dạng YYYY-MM; "
    "tùy chọn supplier, item, limit (1..50)."
)

CUSTOMER_DESCRIPTION = (
    "Tra thông tin của một khách hàng/đại lý theo mã hoặc tên chính xác. kind: "
    "prices, effective_prices, orders, npp_receivable, order_details. Bắt buộc "
    "customer, product (để trống nếu không lọc sản phẩm; chỉ prices, "
    "effective_prices hoặc order_details mới nhận product), time_range (today, "
    "yesterday, this_week, previous_week, this_month, previous_month hoặc "
    "YYYY-MM-DD/YYYY-MM-DD), limit (1..20). detail_filters chỉ cho order_details: "
    "route, date_basis (submitted/delivery), status (submitted/cancelled/all)."
)

METRIC_DESCRIPTION = (
    "Tra chỉ số vận hành BMQ: controlled_revenue (doanh thu kiểm soát; dimension "
    "date/channel), purchase_order_count (số đơn mua hàng; date/status), "
    "low_stock_count (số mặt hàng tồn thấp hiện tại; category), supplier_debt "
    "(công nợ phải trả nhà cung cấp hiện tại; payment_method). Bắt buộc metric, "
    "start, end dạng YYYY-MM-DD. Tùy chọn dimension, limit (1..500), sort "
    "(asc/desc). low_stock_count và supplier_debt chỉ trả snapshot hiện tại, nên "
    "start và end phải là hôm nay."
)

UNC_DESCRIPTION = (
    "Tìm ảnh UNC đã nộp theo đúng một ngày hoặc một tháng. Dùng khi hỏi ảnh ủy "
    "nhiệm chi, ảnh chuyển khoản hoặc bằng chứng UNC. Chọn đúng một trong date "
    "(YYYY-MM-DD) hoặc month (YYYY-MM); limit tùy chọn 1..8. Ảnh chỉ là bằng "
    "chứng đã nộp, chưa xác nhận thanh toán."
)

COST_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "question": {"type": "string", "enum": list(COST_QUESTIONS)},
        "month": {"type": ["string", "null"], "description": "YYYY-MM"},
        "month_b": {"type": ["string", "null"], "description": "YYYY-MM"},
        "category_code": {"type": ["string", "null"]},
        "review_status": {
            "type": ["string", "null"],
            "enum": [*REVIEW_STATUSES, None],
        },
        "limit": {"type": ["integer", "null"], "minimum": 1, "maximum": 50},
        "line_ref": {"type": ["string", "null"]},
    },
    "required": ["question"],
    "additionalProperties": False,
}

PAYMENT_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "question": {"type": "string", "enum": list(PAYMENT_QUESTIONS)},
        "month": {"type": "string", "description": "YYYY-MM"},
        "supplier": {"type": ["string", "null"]},
        "item": {"type": ["string", "null"]},
        "limit": {"type": ["integer", "null"], "minimum": 1, "maximum": 50},
    },
    "required": ["question", "month"],
    "additionalProperties": False,
}

CUSTOMER_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "kind": {"type": "string", "enum": list(CUSTOMER_KINDS)},
        "customer": {"type": "string"},
        "product": {"type": "string"},
        "time_range": {"type": "string"},
        "limit": {"type": "integer", "minimum": 1, "maximum": 20},
        "detail_filters": {
            "type": ["object", "null"],
            "properties": {
                "route": {"type": "string"},
                "date_basis": {
                    "type": "string",
                    "enum": ["submitted", "delivery"],
                },
                "status": {
                    "type": "string",
                    "enum": ["submitted", "cancelled", "all"],
                },
            },
            "additionalProperties": False,
        },
    },
    "required": ["kind", "customer", "product", "time_range", "limit"],
    "additionalProperties": False,
}

METRIC_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "metric": {"type": "string", "enum": list(METRIC_DIMENSIONS)},
        "dimension": {"type": ["string", "null"]},
        "start": {"type": "string", "description": "YYYY-MM-DD"},
        "end": {"type": "string", "description": "YYYY-MM-DD"},
        "limit": {"type": ["integer", "null"], "minimum": 1, "maximum": 500},
        "sort": {"type": ["string", "null"], "enum": ["asc", "desc", None]},
    },
    "required": ["metric", "start", "end"],
    "additionalProperties": False,
}

UNC_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "date": {"type": ["string", "null"], "description": "YYYY-MM-DD"},
        "month": {"type": ["string", "null"], "description": "YYYY-MM"},
        "limit": {"type": ["integer", "null"], "minimum": 1, "maximum": MAX_IMAGES},
    },
    "additionalProperties": False,
}


def build_warehouse_tools(
    chat_session: Any,
    settings: Settings,
    client: WarehouseClient | None = None,
) -> list[SdkMcpTool[Any]]:
    """Build the direct, read-only warehouse tools for one chat session.

    The owner token is read from ``chat_session`` on every call, so a token
    refreshed by a later request is used without rebuilding the toolset.
    """

    warehouse = client or WarehouseClient(settings.warehouse_url)

    @_safe_tool("bmq_cost", COST_DESCRIPTION, COST_SCHEMA)
    async def cost_tool(args: dict[str, Any]) -> dict[str, Any]:
        request = _validate_cost(args)
        result = await warehouse.cost(_token(chat_session), request)
        if request["question"] in {"example_line", "line_explanation"}:
            block = cost_block(result, request["question"])
            if block is not None:
                _append_ui(
                    chat_session,
                    {
                        "component": "sushi_answer",
                        "payload": {"answer": "", "costBlock": block},
                    },
                )
        return _ok(_compact_json(result))

    @_safe_tool("bmq_payment", PAYMENT_DESCRIPTION, PAYMENT_SCHEMA)
    async def payment_tool(args: dict[str, Any]) -> dict[str, Any]:
        request = _validate_payment(args)
        result = await warehouse.payment(_token(chat_session), request)
        return _ok(_compact_json(result))

    @_safe_tool("bmq_customer", CUSTOMER_DESCRIPTION, CUSTOMER_SCHEMA)
    async def customer_tool(args: dict[str, Any]) -> dict[str, Any]:
        request = _validate_customer(args)
        result = await warehouse.customer(_token(chat_session), request)
        return _ok(_compact_json(result))

    @_safe_tool("bmq_metric", METRIC_DESCRIPTION, METRIC_SCHEMA)
    async def metric_tool(args: dict[str, Any]) -> dict[str, Any]:
        dsl, metric, sort = _validate_metric(args)
        result = await warehouse.query(_token(chat_session), dsl)
        if sort is not None:
            _sort_metric_rows(result, metric, sort)
        return _ok(_compact_json(result))

    @_safe_tool("bmq_unc_images", UNC_DESCRIPTION, UNC_SCHEMA)
    async def unc_tool(args: dict[str, Any]) -> dict[str, Any]:
        body, requested_date, requested_month = _validate_unc(args)
        result = await warehouse.finance_media_search(_token(chat_session), body)
        images = _map_images(
            result, requested_date, requested_month, body["limit"]
        )
        _append_ui(
            chat_session,
            {
                "component": "sushi_answer",
                "payload": {"answer": "", "images": images},
            },
        )
        return _ok(_unc_summary(images, requested_date, requested_month))

    return [cost_tool, payment_tool, customer_tool, metric_tool, unc_tool]
