from __future__ import annotations

import json
from datetime import date
from types import SimpleNamespace
from typing import Any

import pytest

from bmq_merchant import purchase_order_tools
from bmq_merchant.backend import BmqMerchantBackend
from bmq_merchant.config import Settings
from bmq_merchant.purchase_order_tools import build_purchase_order_tools
from bmq_merchant.warehouse_tools import MAX_COMPACT_CHARS


def _ids(value: str | None) -> set[str]:
    if not value or not value.startswith("in.(") or not value.endswith(")"):
        return set()
    inside = value[4:-1]
    return {part for part in inside.split(",") if part}


class FakeSupabase:
    def __init__(
        self,
        orders: list[dict[str, Any]],
        suppliers: list[dict[str, Any]] | None = None,
        items: list[dict[str, Any]] | None = None,
    ) -> None:
        self.orders = orders
        self.suppliers = suppliers or []
        self.items = items or []
        self.calls: list[tuple[str, dict[str, str]]] = []

    async def select(
        self, table: str, params: dict[str, str] | None = None
    ) -> list[dict[str, Any]]:
        query = dict(params or {})
        self.calls.append((table, query))
        if table == "purchase_orders":
            rows = self.orders
            status = query.get("status")
            if status and status.startswith("eq."):
                expected = status[3:]
                rows = [row for row in rows if row.get("status") == expected]
            return [dict(row) for row in rows]
        if table == "suppliers":
            wanted = _ids(query.get("id"))
            return [
                dict(row)
                for row in self.suppliers
                if str(row.get("id")) in wanted
            ]
        if table == "purchase_order_items":
            wanted = _ids(query.get("purchase_order_id"))
            return [
                dict(row)
                for row in self.items
                if str(row.get("purchase_order_id")) in wanted
            ]
        raise AssertionError(f"unexpected table {table}")


def _po(
    po_number: str,
    *,
    order_date: str = "2026-10-18",
    status: str = "draft",
    supplier_id: str | None = "sup-1",
    total_amount: float | None = 100.0,
    vat_amount: float | None = 10.0,
    notes: str | None = "Ghi chú",
    po_id: str | None = None,
) -> dict[str, Any]:
    return {
        "id": po_id or f"id-{po_number}",
        "po_number": po_number,
        "order_date": order_date,
        "expected_date": "2026-10-20",
        "status": status,
        "total_amount": total_amount,
        "vat_amount": vat_amount,
        "notes": notes,
        "supplier_id": supplier_id,
    }


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
        for sdk_tool in build_purchase_order_tools(session, settings)
    }
    return tools["bmq_purchase_orders"], session


def _payload(result: dict[str, Any]) -> tuple[str, dict[str, Any]]:
    assert result.get("is_error") is not True, result
    summary, separator, raw = result["content"][0]["text"].partition("\n")
    assert separator == "\n"
    return summary, json.loads(raw)


async def test_single_date_reads_po_supplier_and_items(settings: Settings) -> None:
    database = FakeSupabase(
        orders=[_po("PO-001")],
        suppliers=[{"id": "sup-1", "name": "Nhà cung cấp Một"}],
        items=[
            {
                "purchase_order_id": "id-PO-001",
                "product_name": "Bột mì",
                "quantity": 2,
                "unit": "kg",
                "unit_price": 50,
                "line_total": 100,
            }
        ],
    )
    tool, _ = _tool(settings, database)

    summary, payload = _payload(
        await tool.handler({"date": "2026-10-18"})
    )

    assert payload["count"] == 1
    assert payload["pos_omitted"] == 0
    assert payload["lines_omitted"] == 0
    purchase_order = payload["purchase_orders"][0]
    assert purchase_order["po_number"] == "PO-001"
    assert purchase_order["supplier_name"] == "Nhà cung cấp Một"
    assert purchase_order["items"] == [
        {
            "product_name": "Bột mì",
            "quantity": 2,
            "unit": "kg",
            "unit_price": 50,
            "line_total": 100,
        }
    ]
    assert "Có 1 đơn mua hàng" in summary
    assert "Nhà cung cấp Một: 1" in summary

    by_table = {table: params for table, params in database.calls}
    assert by_table["purchase_orders"]["and"] == (
        "(order_date.gte.2026-10-18,order_date.lte.2026-10-18)"
    )
    assert by_table["purchase_orders"]["order"] == (
        "order_date.asc,po_number.asc"
    )
    assert "suppliers(" not in by_table["purchase_orders"]["select"]
    assert "purchase_order_items(" not in by_table["purchase_orders"]["select"]
    assert by_table["suppliers"]["id"] == "in.(sup-1)"
    assert by_table["purchase_order_items"]["purchase_order_id"] == (
        "in.(id-PO-001)"
    )


async def test_dd_mm_uses_current_vn_year(
    settings: Settings, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(
        purchase_order_tools, "_today_vn", lambda: date(2026, 10, 20)
    )
    database = FakeSupabase(orders=[_po("PO-002")])
    tool, _ = _tool(settings, database)

    _, payload = _payload(await tool.handler({"date": "18/10"}))

    assert payload["date_from"] == "2026-10-18"
    assert payload["date_to"] == "2026-10-18"
    params = database.calls[0][1]
    assert params["and"] == (
        "(order_date.gte.2026-10-18,order_date.lte.2026-10-18)"
    )


async def test_range_longer_than_31_days_is_rejected(
    settings: Settings,
) -> None:
    database = FakeSupabase(orders=[])
    tool, _ = _tool(settings, database)

    result = await tool.handler(
        {"date_from": "2026-09-01", "date_to": "2026-10-02"}
    )

    assert result["is_error"] is True
    assert "31 ngày" in result["content"][0]["text"]
    assert database.calls == []


async def test_supplier_filter_ignores_case_and_diacritics(
    settings: Settings,
) -> None:
    database = FakeSupabase(
        orders=[
            _po("PO-003", supplier_id="sup-1"),
            _po("PO-004", supplier_id="sup-2"),
        ],
        suppliers=[
            {"id": "sup-1", "name": "Công Ty TNHH Bánh Mì Sài Gòn"},
            {"id": "sup-2", "name": "Nhà Cung Cấp Khác"},
        ],
    )
    tool, _ = _tool(settings, database)

    _, payload = _payload(
        await tool.handler(
            {"date": "2026-10-18", "supplier": "banh mi sai gon"}
        )
    )

    assert payload["count"] == 1
    assert [
        purchase_order["po_number"]
        for purchase_order in payload["purchase_orders"]
    ] == ["PO-003"]
    assert payload["supplier_counts"] == {
        "Công Ty TNHH Bánh Mì Sài Gòn": 1
    }


async def test_status_filter_is_forwarded(settings: Settings) -> None:
    database = FakeSupabase(
        orders=[
            _po("PO-005", status="completed"),
            _po("PO-006", status="draft"),
        ]
    )
    tool, _ = _tool(settings, database)

    _, payload = _payload(
        await tool.handler({"date": "2026-10-18", "status": "completed"})
    )

    assert payload["count"] == 1
    assert payload["purchase_orders"][0]["po_number"] == "PO-005"
    assert database.calls[0][1]["status"] == "eq.completed"


async def test_po_without_items_has_empty_items(settings: Settings) -> None:
    database = FakeSupabase(
        orders=[_po("PO-007")],
        suppliers=[{"id": "sup-1", "name": "Nhà cung cấp Một"}],
        items=[],
    )
    tool, _ = _tool(settings, database)

    _, payload = _payload(await tool.handler({"date": "2026-10-18"}))

    assert payload["purchase_orders"][0]["items"] == []


async def test_null_total_stays_null(settings: Settings) -> None:
    database = FakeSupabase(
        orders=[_po("PO-008", total_amount=None, vat_amount=None)],
        suppliers=[{"id": "sup-1", "name": "Nhà cung cấp Một"}],
    )
    tool, _ = _tool(settings, database)

    _, payload = _payload(await tool.handler({"date": "2026-10-18"}))

    purchase_order = payload["purchase_orders"][0]
    assert purchase_order["total_amount"] is None
    assert purchase_order["vat_amount"] is None


async def test_trimming_keeps_all_pos_and_reports_lines_omitted(
    settings: Settings,
) -> None:
    orders = [_po(f"PO-{index:03d}") for index in range(1, 7)]
    items = [
        {
            "purchase_order_id": f"id-PO-{index:03d}",
            "product_name": "Sản phẩm " + "rất dài " * 20,
            "quantity": 1,
            "unit": "thùng",
            "unit_price": 1000,
            "line_total": 1000,
        }
        for index in range(1, 7)
        for _ in range(60)
    ]
    database = FakeSupabase(
        orders=orders,
        suppliers=[{"id": "sup-1", "name": "Nhà cung cấp Một"}],
        items=items,
    )
    tool, _ = _tool(settings, database)

    result = await tool.handler({"date": "2026-10-18"})
    assert result.get("is_error") is not True
    summary, separator, raw = result["content"][0]["text"].partition("\n")
    assert separator == "\n"
    payload = json.loads(raw)

    assert len(payload["purchase_orders"]) == 6
    assert payload["pos_omitted"] == 0
    assert payload["lines_omitted"] > 0
    assert len(raw) <= MAX_COMPACT_CHARS
    assert {po["po_number"] for po in payload["purchase_orders"]} == {
        f"PO-{index:03d}" for index in range(1, 7)
    }
    assert "đơn không hiển thị" not in summary
    assert "Có 6 đơn mua hàng" in summary


async def test_limit_reports_pos_omitted(settings: Settings) -> None:
    database = FakeSupabase(
        orders=[_po("PO-009"), _po("PO-010"), _po("PO-011")],
        suppliers=[{"id": "sup-1", "name": "Nhà cung cấp Một"}],
    )
    tool, _ = _tool(settings, database)

    summary, payload = _payload(
        await tool.handler({"date": "2026-10-18", "limit": 2})
    )

    assert payload["count"] == 3
    assert len(payload["purchase_orders"]) == 2
    assert payload["pos_omitted"] == 1
    assert "1 đơn không hiển thị" in summary


async def test_doc_link_blocks_are_appended_for_at_most_ten_pos(
    settings: Settings,
) -> None:
    orders = [
        _po(f"PO-{index:03d}", po_id=f"id-{index:03d}")
        for index in range(1, 13)
    ]
    database = FakeSupabase(
        orders=orders,
        suppliers=[{"id": "sup-1", "name": "Nhà cung cấp Một"}],
    )
    tool, session = _tool(settings, database)

    await tool.handler({"date": "2026-10-18", "limit": 12})

    blocks = [
        block
        for block in session.pending_ui
        if block.get("component") == "doc_link"
    ]
    assert len(blocks) == 10
    assert all(block["version"] == 1 for block in blocks)
    payloads = [block["payload"] for block in blocks]
    assert all(payload["kind"] == "po" for payload in payloads)
    assert [payload["code"] for payload in payloads] == [
        f"PO-{index:03d}" for index in range(1, 11)
    ]
    assert payloads[0]["id"] == "id-001"
    assert payloads[0]["path"] == "/purchase-orders?id=id-001"
    assert "PO-001" in payloads[0]["title"]
    assert "100 VND" in payloads[0]["title"]
