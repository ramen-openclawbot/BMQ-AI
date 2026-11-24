from __future__ import annotations

import json
from copy import deepcopy
from datetime import date, datetime
from types import SimpleNamespace
from typing import Any
from zoneinfo import ZoneInfo

import httpx
import pytest
import respx

from bmq_merchant.backend import BmqMerchantBackend
from bmq_merchant.config import Settings
from bmq_merchant.finance_tools import build_finance_tools
from bmq_merchant.supabase import SupabaseClient, SupabaseError

BASE = "https://example.supabase.co"

PAYROLL_LINE = {
    "month": "2026-10",
    "section": "operating",
    "line_code": "C6_PAYROLL",
    "label": "Payroll",
    "counterparty": "Bếp",
    "source": "payroll_period",
    "source_ref": "T10/2026:Bếp",
    "amount": 10_000_000,
    "is_estimate": False,
    "note": "payroll_bn_payslips net_pay for 10/2026",
}
ESTIMATED_PAYROLL_LINE = {
    "month": "2026-10",
    "section": "operating",
    "line_code": "C6_PAYROLL",
    "label": "Payroll",
    "counterparty": "Phục vụ",
    "source": "payroll_period",
    "source_ref": "payroll_last_month:Phục vụ",
    "amount": 5_000_000,
    "is_estimate": True,
    "note": "Missing current-month payroll groups were accrued from the prior month.",
}
OTHER_OPERATING_LINE = {
    "month": "2026-10",
    "section": "operating",
    "line_code": "C2_RENT",
    "label": "Rent",
    "counterparty": "Landlord",
    "amount": 3_000_000,
    "is_estimate": False,
}

PNL: dict[str, Any] = {
    "month": "2026-10",
    "from": "2026-10-01",
    "to": "2026-10-31",
    "currency": "VND",
    "lines": [
        {
            "month": "2026-10",
            "section": "revenue",
            "line_code": "BANH_MI",
            "label": "Revenue — Bánh mì",
            "amount": 100_000_000,
            "is_estimate": False,
        },
        PAYROLL_LINE,
        ESTIMATED_PAYROLL_LINE,
        OTHER_OPERATING_LINE,
    ],
    "sections": {
        "revenue": [
            {
                "line_code": "BANH_MI",
                "label": "Revenue — Bánh mì",
                "amount": 100_000_000,
            }
        ],
        "operating": [
            {"line_code": "C6_PAYROLL", "counterparty": "Bếp", "amount": 10_000_000},
            {"line_code": "C2_RENT", "counterparty": "Landlord", "amount": 3_000_000},
        ],
    },
    "totals": {
        "revenue": 100_000_000,
        "operating": 18_000_000,
        "estimate_total": 5_000_000,
        "net_profit": 82_000_000,
    },
    "inventory": {
        "status": "not_counted",
        "note": "chưa trừ chênh lệch tồn kho",
        "phase": 2,
    },
    "flags": [
        {
            "code": "payroll_last_month_estimate",
            "detail_en": "Missing current-month payroll groups were accrued from the prior month.",
            "amount": 5_000_000,
        },
        {"code": "revenue_missing", "detail_en": "No approved controlled revenue lines."},
    ],
}


class FakeSupabase:
    def __init__(
        self,
        result: Any = None,
        error: Exception | None = None,
    ) -> None:
        self.result = PNL if result is None else result
        self.error = error
        self.calls: list[tuple[str, dict[str, Any] | None]] = []

    async def rpc(
        self, function: str, payload: dict[str, Any] | None = None
    ) -> Any:
        self.calls.append((function, payload))
        if self.error is not None:
            raise self.error
        return self.result


def _tool(settings: Settings, database: FakeSupabase) -> Any:
    session = SimpleNamespace(
        backend=BmqMerchantBackend(database, SimpleNamespace()),
    )
    tools = {
        sdk_tool.name: sdk_tool
        for sdk_tool in build_finance_tools(session, settings)
    }
    return tools["bmq_finance_pnl"]


def _payload(result: dict[str, Any]) -> dict[str, Any]:
    assert result.get("is_error") is not True, result
    return json.loads(result["content"][0]["text"])


async def test_finance_tool_calls_rpc_for_the_month_and_keeps_only_payroll_lines(
    settings: Settings,
) -> None:
    database = FakeSupabase()
    tool = _tool(settings, database)

    result = _payload(await tool.handler({"month": "2026-10"}))

    assert database.calls == [
        ("finance_pnl_accrual", {"p_month": "2026-10-01"})
    ]
    assert set(result) == {
        "month",
        "currency",
        "totals",
        "sections",
        "payroll",
        "has_payroll_estimate",
        "is_future_month",
        "flags",
        "inventory_note",
    }
    assert "lines" not in result
    assert result["month"] == "2026-10"
    assert result["currency"] == "VND"
    assert result["is_future_month"] is False
    assert result["totals"] == PNL["totals"]
    assert result["sections"] == {
        "revenue": [
            {
                "line_code": "BANH_MI",
                "label": "Revenue — Bánh mì",
                "amount": 100_000_000,
            }
        ],
        "operating": [
            {"line_code": "C2_RENT", "amount": 3_000_000},
        ],
    }
    # Payroll is returned once under payroll.*, never repeated in sections.
    assert all(
        line["line_code"] != "C6_PAYROLL"
        for lines in result["sections"].values()
        for line in lines
    )
    # Counterparties and free-text notes never leave the tool for P&L lines.
    assert "Bếp" not in json.dumps(result["sections"], ensure_ascii=False)
    assert "Landlord" not in json.dumps(result["sections"], ensure_ascii=False)
    assert result["inventory_note"] == "chưa trừ chênh lệch tồn kho"
    assert result["flags"] == [
        {
            "code": "payroll_last_month_estimate",
            "detail_en": PNL["flags"][0]["detail_en"],
        },
        {
            "code": "revenue_missing",
            "detail_en": "No approved controlled revenue lines.",
        },
    ]

    # Only C6_PAYROLL lines are summed; rent and revenue never enter the total.
    assert result["payroll"]["total"] == 15_000_000
    assert [line["name"] for line in result["payroll"]["lines"]] == [
        "Bếp",
        "Ước tính kỳ trước · Phục vụ",
    ]
    assert [line["amount"] for line in result["payroll"]["lines"]] == [
        10_000_000,
        5_000_000,
    ]
    assert [line["is_estimate"] for line in result["payroll"]["lines"]] == [
        False,
        True,
    ]
    assert result["has_payroll_estimate"] is True

    # Each payroll line is a group summary, never an employee-level record.
    for line in result["payroll"]["lines"]:
        assert set(line) == {"name", "amount", "is_estimate"}
    serialized = json.dumps(result, ensure_ascii=False).casefold()
    assert "employee" not in serialized
    assert "payslip_id" not in serialized
    assert "nhân viên" not in serialized
    assert "payroll_bn_payslips net_pay" not in serialized


async def test_finance_tool_drops_unexpected_detailed_rpc_fields(
    settings: Settings,
) -> None:
    pnl = deepcopy(PNL)
    pnl["totals"] = {**PNL["totals"], "employee_pay": 5_000_000}
    pnl["sections"] = {
        "operating": [
            {
                "line_code": "C6_PAYROLL",
                "amount": 10_000_000,
                "counterparty": "Nguyễn Văn A",
                "employee_id": "employee-1",
                "note": "Lương của Nguyễn Văn A",
            }
        ]
    }
    pnl["lines"] = [
        {
            **PAYROLL_LINE,
            "counterparty": "Nguyễn Văn A",
            "note": "Lương của Nguyễn Văn A",
            "employee_id": "employee-1",
        }
    ]
    tool = _tool(settings, FakeSupabase(result=pnl))

    result = _payload(await tool.handler({"month": "2026-10"}))

    assert "employee_pay" not in result["totals"]
    assert result["sections"] == {"operating": []}
    assert [line["name"] for line in result["payroll"]["lines"]] == ["Bếp"]
    serialized = json.dumps(result, ensure_ascii=False)
    assert "Nguyễn Văn A" not in serialized
    assert "employee_id" not in serialized
    assert "Lương của" not in serialized
    assert result["payroll"]["total"] == 10_000_000


async def test_finance_tool_uses_a_generic_label_for_payout_families(
    settings: Settings,
) -> None:
    pnl = deepcopy(PNL)
    pnl["lines"] = [
        {
            **PAYROLL_LINE,
            "counterparty": "Nguyễn Văn A",
            "source_ref": "payout_family:nguyen van a",
        }
    ]
    tool = _tool(settings, FakeSupabase(result=pnl))

    result = _payload(await tool.handler({"month": "2026-10"}))

    assert [line["name"] for line in result["payroll"]["lines"]] == [
        "Chi lương theo kỳ"
    ]
    assert "Nguyễn Văn A" not in json.dumps(result, ensure_ascii=False)


async def test_finance_tool_defaults_to_the_current_vn_month(
    settings: Settings,
) -> None:
    database = FakeSupabase()
    tool = _tool(settings, database)

    result = _payload(await tool.handler({}))

    expected = datetime.now(ZoneInfo("Asia/Ho_Chi_Minh")).strftime("%Y-%m-01")
    assert database.calls == [("finance_pnl_accrual", {"p_month": expected})]
    assert result["month"] == PNL["month"]


async def test_finance_tool_marks_a_future_month(settings: Settings) -> None:
    database = FakeSupabase()
    tool = _tool(settings, database)
    next_year = datetime.now(ZoneInfo("Asia/Ho_Chi_Minh")).year + 1

    result = _payload(await tool.handler({"month": f"{next_year}-01"}))

    assert result["is_future_month"] is True
    assert database.calls == [
        ("finance_pnl_accrual", {"p_month": f"{next_year}-01-01"})
    ]


@pytest.mark.parametrize(
    "month",
    [
        "",
        "2026-1",
        "2026-13",
        "2026-00",
        "2023-12",
        "2026-10-01",
        "10-2026",
        "abc",
    ],
)
async def test_finance_tool_rejects_an_invalid_month(
    settings: Settings, month: Any
) -> None:
    database = FakeSupabase()
    tool = _tool(settings, database)

    result = await tool.handler({"month": month})

    assert result["is_error"] is True
    assert "chưa đúng cú pháp" in result["content"][0]["text"]
    assert database.calls == []


async def test_finance_tool_rejects_a_year_far_outside_the_range(
    settings: Settings,
) -> None:
    database = FakeSupabase()
    tool = _tool(settings, database)
    next_year = datetime.now(ZoneInfo("Asia/Ho_Chi_Minh")).year + 2

    result = await tool.handler({"month": f"{next_year}-01"})

    assert result["is_error"] is True
    assert database.calls == []


async def test_finance_tool_rejects_unknown_fields(settings: Settings) -> None:
    database = FakeSupabase()
    tool = _tool(settings, database)

    result = await tool.handler({"month": "2026-10", "employee": "A"})

    assert result["is_error"] is True
    assert "employee" in result["content"][0]["text"]
    assert database.calls == []


async def test_finance_tool_turns_a_supabase_error_into_a_short_safe_message(
    settings: Settings,
) -> None:
    database = FakeSupabase(
        error=SupabaseError(
            "Supabase 500: permission denied for table payroll_bn_payslips"
        )
    )
    tool = _tool(settings, database)

    result = await tool.handler({"month": "2026-10"})

    assert result["is_error"] is True
    text = result["content"][0]["text"]
    assert "chưa tra được chi phí lương tháng này" in text
    assert "Bảng lương" in text
    assert "Supabase" not in text
    assert "permission denied" not in text
    assert "payroll_bn_payslips" not in text


@pytest.mark.parametrize(
    "bad_amount",
    [None, True, "1.200.000", "abc", float("nan")],
)
async def test_finance_tool_refuses_a_partial_payroll_total(
    settings: Settings, bad_amount: Any
) -> None:
    pnl = deepcopy(PNL)
    pnl["lines"] = [{**PAYROLL_LINE, "amount": bad_amount}]
    tool = _tool(settings, FakeSupabase(result=pnl))

    result = await tool.handler({"month": "2026-10"})

    assert result["is_error"] is True
    assert "Bảng lương" in result["content"][0]["text"]


async def test_finance_tool_treats_a_missing_estimate_marker_as_estimate(
    settings: Settings,
) -> None:
    pnl = deepcopy(PNL)
    line = dict(PAYROLL_LINE)
    line.pop("is_estimate")
    pnl["lines"] = [line]
    tool = _tool(settings, FakeSupabase(result=pnl))

    result = _payload(await tool.handler({"month": "2026-10"}))

    assert result["has_payroll_estimate"] is True
    assert result["payroll"]["lines"][0]["is_estimate"] is True


async def test_finance_tool_turns_any_backend_exception_into_the_fallback(
    settings: Settings,
) -> None:
    tool = _tool(
        settings,
        FakeSupabase(error=RuntimeError("timeout talking to the database")),
    )

    result = await tool.handler({"month": "2026-10"})

    assert result["is_error"] is True
    text = result["content"][0]["text"]
    assert "Bảng lương" in text
    assert "timeout" not in text
    assert "database" not in text


async def test_finance_tool_turns_a_non_object_rpc_result_into_an_error(
    settings: Settings,
) -> None:
    tool = _tool(settings, FakeSupabase(result=[]))

    result = await tool.handler({"month": "2026-10"})

    assert result["is_error"] is True
    assert "chưa tra được chi phí lương tháng này" in result["content"][0]["text"]


@respx.mock
async def test_backend_finance_pnl_posts_the_first_day_with_the_service_key() -> None:
    route = respx.post(
        f"{BASE}/rest/v1/rpc/finance_pnl_accrual"
    ).mock(return_value=httpx.Response(200, json=PNL))
    client = SupabaseClient(supabase_url=BASE, service_role_key="svc", anon_key="anon")
    backend = BmqMerchantBackend(client, SimpleNamespace())

    result = await backend.finance_pnl(date(2026, 10, 1))

    assert result == PNL
    request = route.calls.last.request
    assert json.loads(request.content) == {"p_month": "2026-10-01"}
    assert request.headers["Authorization"] == "Bearer svc"


async def test_finance_tool_never_names_a_manual_payroll_adjustment(
    settings: Settings,
) -> None:
    pnl = deepcopy(PNL)
    pnl["lines"] = [
        PAYROLL_LINE,
        {
            **PAYROLL_LINE,
            "source": "manual_adjustment",
            "source_ref": "T10/2026:Nguyễn Văn A",
            "label": "Lương Nguyễn Văn A",
            "counterparty": "Nguyễn Văn A",
            "amount": 2_000_000,
        },
    ]
    tool = _tool(settings, FakeSupabase(result=pnl))

    result = _payload(await tool.handler({"month": "2026-10"}))

    assert [line["name"] for line in result["payroll"]["lines"]] == [
        "Bếp",
        "Điều chỉnh thủ công",
    ]
    assert result["payroll"]["total"] == 12_000_000
    assert "Nguyễn Văn A" not in json.dumps(result["payroll"], ensure_ascii=False)


@pytest.mark.parametrize("missing", ["lines", "totals"])
async def test_finance_tool_refuses_a_malformed_result_instead_of_zero(
    settings: Settings, missing: str
) -> None:
    pnl = deepcopy(PNL)
    pnl.pop(missing)
    tool = _tool(settings, FakeSupabase(result=pnl))

    result = await tool.handler({"month": "2026-10"})

    assert result["is_error"] is True
    assert "chưa tra được chi phí lương" in result["content"][0]["text"]
