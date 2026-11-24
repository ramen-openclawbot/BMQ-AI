"""Read-only Agent SDK tool for a month's accrual P&L and payroll cost.

The tool calls the same Supabase RPC as the Finance screen
(``finance_pnl_accrual``), so payroll is the ``C6_PAYROLL`` cost accrued from
``payroll_bn_payslips`` and non-cancelled ``salary_payouts`` by pay period, not
by payment date.  It never selects employee-level data: payroll groups come from
the RPC's group/family reference, never from a payee ``counterparty``, and only
aggregate totals plus safe section summaries are returned.
"""

from __future__ import annotations

import logging
import re
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any
from zoneinfo import ZoneInfo

from claude_agent_sdk import SdkMcpTool

from .config import Settings
from .supabase import SupabaseError
from .warehouse_tools import (
    _compact_json,
    _error,
    _ok,
    _safe_tool,
    _ToolInputError,
)

_LOG = logging.getLogger(__name__)

FINANCE_PNL_TOOL_NAME = "bmq_finance_pnl"
MONTH_PATTERN = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
MIN_MONTH_YEAR = 2024
PAYROLL_LINE_CODE = "C6_PAYROLL"
PAYROLL_ESTIMATE_FLAG = "payroll_last_month_estimate"
VN_TIMEZONE = ZoneInfo("Asia/Ho_Chi_Minh")

# The RPC is the Finance screen's aggregate P&L.  Only these known aggregate
# keys are forwarded, so a future RPC field can never leak a more detailed row
# (employee, payslip or counterparty identity) into the model prompt.
TOTAL_KEYS = (
    "revenue",
    "cogs",
    "gross_profit",
    "gross_margin",
    "selling",
    "operating",
    "unclassified",
    "ebitda",
    "ebitda_margin",
    "estimate_total",
    "estimate_lines",
    "capex",
    "line_count",
    "depreciation",
    "ebit",
    "interest",
    "other_below_ebitda",
    "ebt",
    "cit",
    "cit_is_estimate",
    "net_profit",
    "net_margin",
)
SECTION_LINE_KEYS = ("line_code", "label", "amount", "is_estimate")

FINANCE_PNL_TOOL_DESCRIPTION = (
    "Tra chi phí lương và báo cáo lãi lỗ (P&L) dồn tích của một tháng. Dùng "
    "cho câu hỏi về lương, chi phí lương, lãi lỗ/P&L hoặc tổng chi phí vận "
    "hành của tháng; lương ghi nhận theo kỳ lương của tháng, không theo ngày "
    "chi. month có dạng YYYY-MM; bỏ trống thì lấy tháng hiện tại. Nếu tháng "
    "ở tương lai, nói rõ tháng đó chưa xảy ra. Kết quả chỉ có tổng lương theo "
    "nhóm/kỳ và tổng P&L, không có lương từng nhân viên."
)

FINANCE_PNL_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "month": {
            "type": "string",
            "description": "Tháng cần tra, dạng YYYY-MM; bỏ trống để lấy tháng hiện tại",
            "pattern": MONTH_PATTERN.pattern,
        }
    },
    "additionalProperties": False,
}

_FINANCE_ERROR = (
    "chưa tra được chi phí lương tháng này, anh thử lại sau hoặc xem tab "
    "Bảng lương của kỳ đang chọn"
)


class _FinanceDataError(Exception):
    """A payroll line cannot be trusted; never report a partial total."""


def _current_month() -> str:
    return datetime.now(VN_TIMEZONE).strftime("%Y-%m")


def _month_args(args: Any) -> tuple[int, int]:
    if not isinstance(args, dict):
        raise _ToolInputError("câu hỏi chưa đúng cú pháp: tham số không hợp lệ")
    unknown = set(args) - {"month"}
    if unknown:
        raise _ToolInputError(
            "câu hỏi chưa đúng cú pháp: trường không được hỗ trợ: "
            + ", ".join(sorted(unknown))
        )
    raw = args.get("month")
    if raw is None:
        raw = _current_month()
    if not isinstance(raw, str) or not MONTH_PATTERN.fullmatch(raw):
        raise _ToolInputError(
            "câu hỏi chưa đúng cú pháp: month phải có dạng YYYY-MM"
        )
    year, month_number = int(raw[:4]), int(raw[5:])
    latest_year = datetime.now(VN_TIMEZONE).year + 1
    if not MIN_MONTH_YEAR <= year <= latest_year:
        raise _ToolInputError(
            "câu hỏi chưa đúng cú pháp: month phải trong khoảng "
            f"{MIN_MONTH_YEAR} đến {latest_year}"
        )
    return year, month_number


def _decimal_amount(value: Any) -> Decimal | None:
    if isinstance(value, bool) or value is None:
        return None
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None
    if not amount.is_finite():
        return None
    return amount


def _total_number(total: Decimal) -> int | float:
    """Keep an exact sum: an integral total stays an int, never rounded."""

    if total == total.to_integral_value():
        return int(total)
    return float(total)


def _is_true(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in {"true", "1"}
    return bool(value)


def _safe_totals(raw: Any) -> dict[str, Any]:
    if not isinstance(raw, dict):
        return {}
    return {key: raw[key] for key in TOTAL_KEYS if key in raw}


def _payroll_group_name(line: dict[str, Any]) -> str:
    """Return the RPC's group/family label, never the line counterparty.

    ``finance_pnl_accrual`` encodes the payroll group in ``source_ref``:
    ``<period_code>:<group_name>`` for payroll_bn_payslips groups and a
    ``payout_family:``/``prior_*`` prefix for salary-payout families.  Only that
    controlled reference is read, so a payee name in ``counterparty`` can never
    reach the model.
    """

    # Only lines the RPC builds itself from payroll periods carry a controlled
    # group reference.  A manual adjustment's source_ref/label is free text an
    # operator typed, so it is never forwarded as a group name.
    if line.get("source") != "payroll_period":
        return "Điều chỉnh thủ công" if line.get("source") == "manual_adjustment" else "Lương"
    source_ref = line.get("source_ref")
    if not isinstance(source_ref, str):
        return "Lương"
    ref = source_ref.strip()
    if not ref:
        return "Lương"
    if ref.startswith("payout_family:"):
        return "Chi lương theo kỳ"
    if ref.startswith(("prior_payout:", "prior:")):
        return "Ước tính kỳ trước"
    if ref.startswith("payroll_last_month:"):
        group = ref.split(":", 1)[1].strip()
        if not group or group == "total":
            return "Ước tính kỳ trước"
        return f"Ước tính kỳ trước · {group}"
    if ":" in ref:
        group = ref.split(":", 1)[1].strip()
        if group:
            return group
    return "Lương"


def _safe_sections(raw: Any) -> dict[str, list[dict[str, Any]]]:
    """Keep aggregate P&L lines only; never forward counterparty or notes.

    C6_PAYROLL is deliberately excluded: payroll is returned once under
    ``payroll`` so the model cannot add the same cost twice.
    """

    if not isinstance(raw, dict):
        return {}
    sections: dict[str, list[dict[str, Any]]] = {}
    for section, raw_lines in raw.items():
        if not isinstance(section, str) or not isinstance(raw_lines, list):
            continue
        sections[section] = [
            {key: line[key] for key in SECTION_LINE_KEYS if key in line}
            for line in raw_lines
            if isinstance(line, dict)
            and line.get("line_code") != PAYROLL_LINE_CODE
        ]
    return sections


def _finance_result(
    pnl: dict[str, Any],
    month: str,
    *,
    is_future_month: bool,
) -> dict[str, Any]:
    raw_lines = pnl.get("lines")
    if not isinstance(raw_lines, list) or not isinstance(pnl.get("totals"), dict):
        # A malformed result must not turn into a confident "0 payroll".
        raise _FinanceDataError("malformed P&L result")
    lines = raw_lines
    payroll_lines: list[dict[str, Any]] = []
    payroll_total = Decimal(0)
    has_payroll_estimate = False
    for line in lines:
        if not isinstance(line, dict) or line.get("line_code") != PAYROLL_LINE_CODE:
            continue
        amount = line.get("amount")
        parsed_amount = _decimal_amount(amount)
        if parsed_amount is None:
            raise _FinanceDataError("invalid payroll amount")
        payroll_total += parsed_amount
        raw_estimate = line.get("is_estimate")
        # A missing marker is unknown, so it is reported as an estimate rather
        # than silently presenting the number as final.
        is_estimate = True if raw_estimate is None else _is_true(raw_estimate)
        has_payroll_estimate = has_payroll_estimate or is_estimate
        payroll_lines.append(
            {
                "name": _payroll_group_name(line),
                "amount": amount,
                "is_estimate": is_estimate,
            }
        )

    raw_flags = pnl.get("flags")
    flags = [
        {"code": flag.get("code"), "detail_en": flag.get("detail_en")}
        for flag in (raw_flags if isinstance(raw_flags, list) else [])
        if isinstance(flag, dict)
    ]
    if any(flag.get("code") == PAYROLL_ESTIMATE_FLAG for flag in flags):
        has_payroll_estimate = True

    inventory = pnl.get("inventory")
    return {
        "month": str(pnl.get("month") or month),
        "currency": str(pnl.get("currency") or "VND"),
        "totals": _safe_totals(pnl.get("totals")),
        "sections": _safe_sections(pnl.get("sections")),
        "payroll": {
            "total": _total_number(payroll_total),
            "lines": payroll_lines,
        },
        "has_payroll_estimate": has_payroll_estimate,
        "is_future_month": is_future_month,
        "flags": flags,
        "inventory_note": (
            inventory.get("note") if isinstance(inventory, dict) else None
        ),
    }


def build_finance_tools(
    chat_session: Any,
    settings: Settings,
) -> list[SdkMcpTool[Any]]:
    """Build the read-only finance P&L tool for one chat session."""

    del settings  # Kept for the shared tool-factory signature.

    @_safe_tool(
        FINANCE_PNL_TOOL_NAME,
        FINANCE_PNL_TOOL_DESCRIPTION,
        FINANCE_PNL_SCHEMA,
    )
    async def finance_pnl_tool(args: dict[str, Any]) -> dict[str, Any]:
        year, month_number = _month_args(args)
        now = datetime.now(VN_TIMEZONE)
        is_future_month = (year, month_number) > (now.year, now.month)
        month = f"{year:04d}-{month_number:02d}"
        try:
            pnl = await chat_session.backend.finance_pnl(
                date(year, month_number, 1)
            )
            if not isinstance(pnl, dict):
                return _error(_FINANCE_ERROR)
            result = _finance_result(
                pnl,
                month,
                is_future_month=is_future_month,
            )
        except (SupabaseError, _FinanceDataError):
            return _error(_FINANCE_ERROR)
        except Exception:
            # Network timeouts, malformed JSON and SDK failures all get the
            # same safe fallback instead of a generic "tra cứu" message.
            _LOG.exception("Lỗi không mong đợi khi đọc báo cáo lãi lỗ")
            return _error(_FINANCE_ERROR)
        return _ok(_compact_json(result))

    return [finance_pnl_tool]
