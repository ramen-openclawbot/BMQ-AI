from __future__ import annotations

import re
from types import SimpleNamespace
from typing import Any

from bmq_merchant.backend import BmqMerchantBackend
from bmq_merchant.config import Settings
from bmq_merchant.document_link_tools import build_document_link_tools

PR_ID = "11111111-1111-4111-8111-111111111111"
PO_ID = "22222222-2222-4222-8222-222222222222"
GR_ID = "33333333-3333-4333-8333-333333333333"

ROWS: dict[str, list[dict[str, Any]]] = {
    "payment_requests": [
        {
            "id": PR_ID,
            "request_number": "PR-2026-001",
            "title": "Thanh toán bột mì",
            "total_amount": 1_250_000,
        }
    ],
    "purchase_orders": [
        {
            "id": PO_ID,
            "po_number": "PO-2026-001",
            "total_amount": 500_000,
        }
    ],
    "goods_receipts": [
        {
            "id": GR_ID,
            "receipt_number": "GR-2026-001",
            "receipt_date": "2026-10-18",
        }
    ],
}


def _like_regex(pattern: str) -> re.Pattern[str]:
    """Translate a PostgREST ilike pattern, honouring backslash escapes."""

    parts = ["^"]
    index = 0
    while index < len(pattern):
        character = pattern[index]
        if character == "\\" and index + 1 < len(pattern):
            parts.append(re.escape(pattern[index + 1]))
            index += 2
            continue
        if character == "%":
            parts.append(".*")
        elif character == "_":
            parts.append(".")
        else:
            parts.append(re.escape(character))
        index += 1
    parts.append("$")
    return re.compile("".join(parts), re.IGNORECASE)


class FakeSupabase:
    def __init__(self, rows: dict[str, list[dict[str, Any]]] | None = None) -> None:
        self.rows = rows or ROWS
        self.calls: list[tuple[str, dict[str, str]]] = []

    async def select(
        self, table: str, params: dict[str, str] | None = None
    ) -> list[dict[str, Any]]:
        query = dict(params or {})
        self.calls.append((table, query))
        rows = [dict(row) for row in self.rows.get(table, [])]
        for key, value in query.items():
            if key in {"select", "limit", "order", "offset"}:
                continue
            if value.startswith("ilike."):
                regex = _like_regex(value[len("ilike.") :])
                rows = [
                    row for row in rows if regex.match(str(row.get(key) or ""))
                ]
            elif value.startswith("eq."):
                expected = value[len("eq.") :]
                rows = [
                    row for row in rows if str(row.get(key) or "") == expected
                ]
            else:
                raise AssertionError(f"unexpected filter {key}={value}")
        limit = query.get("limit")
        if limit is not None:
            rows = rows[: int(limit)]
        return rows


def _tool(
    settings: Settings, database: FakeSupabase
) -> tuple[Any, SimpleNamespace]:
    session = SimpleNamespace(
        owner_token="",
        pending_ui=[],
        backend=BmqMerchantBackend(database, SimpleNamespace()),
    )
    tools = {
        sdk_tool.name: sdk_tool
        for sdk_tool in build_document_link_tools(session, settings)
    }
    return tools["bmq_document_link"], session


async def test_document_link_appends_one_block_for_pr_po_and_gr(
    settings: Settings,
) -> None:
    tool, session = _tool(settings, FakeSupabase())

    cases = [
        ("pr", "PR-2026-001", PR_ID, "/payment-requests", "Thanh toán bột mì"),
        ("po", "PO-2026-001", PO_ID, "/purchase-orders", "PO-2026-001"),
        ("gr", "GR-2026-001", GR_ID, "/goods-receipts", "GR-2026-001"),
    ]
    for kind, code, document_id, prefix, title_text in cases:
        result = await tool.handler({"kind": kind, "code": code})

        assert result.get("is_error") is not True, result
        block = session.pending_ui[-1]
        assert block["component"] == "doc_link"
        assert block["version"] == 1
        payload = block["payload"]
        assert payload["kind"] == kind
        assert payload["code"] == code
        assert payload["id"] == document_id
        assert payload["path"] == f"{prefix}?id={document_id}"
        assert title_text in payload["title"]

    assert len(session.pending_ui) == 3
    assert "1,250,000 đ" in session.pending_ui[0]["payload"]["title"]
    assert "500,000 đ" in session.pending_ui[1]["payload"]["title"]
    assert "2026-10-18" in session.pending_ui[2]["payload"]["title"]


async def test_document_link_is_case_insensitive_and_uses_limit_one(
    settings: Settings,
) -> None:
    database = FakeSupabase()
    tool, session = _tool(settings, database)

    result = await tool.handler({"kind": "po", "code": "po-2026-001"})

    assert result.get("is_error") is not True, result
    payload = session.pending_ui[-1]["payload"]
    assert payload["code"] == "PO-2026-001"
    assert database.calls[0][0] == "purchase_orders"
    assert database.calls[0][1]["po_number"] == "ilike.po-2026-001"
    assert database.calls[0][1]["limit"] == "1"


async def test_document_link_not_found_is_a_tool_error(
    settings: Settings,
) -> None:
    tool, session = _tool(settings, FakeSupabase())

    result = await tool.handler({"kind": "po", "code": "PO-404"})

    assert result["is_error"] is True
    assert result["content"][0]["text"] == "không tìm thấy phiếu PO-404"
    assert session.pending_ui == []


async def test_document_link_rejects_invalid_kind_and_code(
    settings: Settings,
) -> None:
    database = FakeSupabase()
    tool, session = _tool(settings, database)

    for args in [
        {"kind": "invoice", "code": "PO-001"},
        {"kind": "po", "code": "PO 001"},
        {"kind": "po", "code": "PO%001"},
        {"kind": "po", "code": "A" * 65},
        {"kind": "po", "code": ""},
    ]:
        result = await tool.handler(args)
        assert result["is_error"] is True, args

    assert database.calls == []
    assert session.pending_ui == []


async def test_document_link_escapes_ilike_wildcards(
    settings: Settings,
) -> None:
    database = FakeSupabase(
        {
            "purchase_orders": [
                {"id": PO_ID, "po_number": "PO-001", "total_amount": 100}
            ]
        }
    )
    tool, session = _tool(settings, database)

    result = await tool.handler({"kind": "po", "code": "PO_001"})

    assert result["is_error"] is True
    assert result["content"][0]["text"] == "không tìm thấy phiếu PO_001"
    # The underscore is escaped, so it cannot match the hyphen in "PO-001".
    assert database.calls[0][1]["po_number"] == "ilike.PO\\_001"
    assert session.pending_ui == []

    backend = BmqMerchantBackend(FakeSupabase({}), SimpleNamespace())
    percent_database = backend._db
    assert await backend.document_link("po", "PO%001") is None
    assert percent_database.calls[0][1]["po_number"] == "ilike.PO\\%001"
