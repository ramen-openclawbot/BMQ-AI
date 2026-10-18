from __future__ import annotations

import json
import re
from types import SimpleNamespace
from typing import Any

import httpx
import pytest
import respx

from bmq_merchant.config import Settings
from bmq_merchant.warehouse_tools import (
    EXAMPLE_SELECTION_RULE,
    build_warehouse_tools,
    cost_block,
)

BASE = "https://warehouse.test"
TOKEN = "owner-jwt-token"


def _settings() -> Settings:
    return Settings(
        service_role_key="service-role-test-key-not-real",
        warehouse_url=BASE,
    )


def _session(token: str = TOKEN) -> SimpleNamespace:
    return SimpleNamespace(owner_token=token, pending_ui=[])


def _tools(session: Any) -> dict[str, Any]:
    return {
        sdk_tool.name: sdk_tool
        for sdk_tool in build_warehouse_tools(session, _settings())
    }


def _picked_line() -> dict[str, Any]:
    return {
        "classification_id": "c2",
        "month": "2026-09-01",
        "category_code": "COGS_BMQ_BREAD",
        "category_label": "Chi phí bánh mì",
        "review_status": "needs_review",
        "supplier_name": "NCC Hai",
        "source_number": "PR-002",
        "source_date": "2026-09-12",
        "product_name": "Pate gan",
        "line_amount": "8344200",
        "classification_source": "fallback",
        "confidence": "0",
        "rule_id": None,
    }


def _source_fields() -> dict[str, Any]:
    return {
        "source": "Supabase.cost_classification_line_details",
        "source_observed_at": "2026-09-16T21:37:45Z",
        "snapshot_id": "snapshot-1",
        "semantic_version": "bmq-cost-classification-v2",
    }


def _example_result() -> dict[str, Any]:
    picked = _picked_line()
    return {
        **_source_fields(),
        "question": "example_line",
        "month": "2026-09",
        "category_code": None,
        "review_status": "needs_review",
        "match_count": 2,
        "rows": [picked],
        "limit": 1,
        "truncated": True,
        "selection_rule": EXAMPLE_SELECTION_RULE,
        "line": picked,
        "evidence": {
            "rule": {
                "rule_name": "BMQ bread keywords",
                "match_scope": "supplier_and_item",
                "priority": "100",
                "confidence": "0.90",
                "effective_from": "2026-01-01",
                "effective_to": None,
            },
            "alias_mapping": None,
            "alias_status": None,
        },
    }


@respx.mock
async def test_cost_validation_rejects_before_http() -> None:
    session = _session()
    tools = _tools(session)
    route = respx.post(f"{BASE}/v1/cost").mock(
        return_value=httpx.Response(200, json={})
    )

    unknown = await tools["bmq_cost"].handler(
        {"question": "invented", "month": "2026-09"}
    )
    extra = await tools["bmq_cost"].handler(
        {"question": "month_totals", "month": "2026-09", "supplier": "NCC"}
    )
    wrong_qualifier = await tools["bmq_cost"].handler(
        {"question": "month_totals", "line_ref": "c2"}
    )

    assert unknown["is_error"] is True
    assert extra["is_error"] is True
    assert wrong_qualifier["is_error"] is True
    assert route.call_count == 0


@respx.mock
async def test_cost_success_is_compact_and_drops_none() -> None:
    session = _session()
    tools = _tools(session)
    route = respx.post(f"{BASE}/v1/cost").mock(
        return_value=httpx.Response(
            200,
            json={
                "question": "month_totals",
                "month": "2026-09",
                "rows": [],
                "total_amount": "0",
            },
        )
    )

    result = await tools["bmq_cost"].handler(
        {
            "question": "month_totals",
            "month": "2026-09",
            "month_b": None,
            "category_code": None,
        }
    )

    assert result.get("is_error") is not True
    text = result["content"][0]["text"]
    assert json.loads(text)["total_amount"] == "0"
    assert ", " not in text
    assert json.loads(route.calls[0].request.content) == {
        "question": "month_totals",
        "month": "2026-09",
    }


@respx.mock
async def test_payment_validates_and_calls_warehouse() -> None:
    session = _session()
    tools = _tools(session)
    route = respx.post(f"{BASE}/v1/payment").mock(
        return_value=httpx.Response(
            200,
            json={"question": "supplier_payments", "month": "2026-09", "rows": []},
        )
    )

    invalid = await tools["bmq_payment"].handler(
        {"question": "invented", "month": "2026-09"}
    )
    extra = await tools["bmq_payment"].handler(
        {"question": "supplier_payments", "month": "2026-09", "bogus": 1}
    )
    assert invalid["is_error"] is True
    assert extra["is_error"] is True
    assert route.call_count == 0

    result = await tools["bmq_payment"].handler(
        {
            "question": "supplier_payments",
            "month": "2026-09",
            "supplier": None,
            "item": "",
        }
    )
    assert json.loads(result["content"][0]["text"])["question"] == "supplier_payments"
    assert json.loads(route.calls[0].request.content) == {
        "question": "supplier_payments",
        "month": "2026-09",
    }


@respx.mock
async def test_customer_enforces_keys_and_converts_date_range() -> None:
    session = _session()
    tools = _tools(session)
    route = respx.post(f"{BASE}/v1/customer").mock(
        return_value=httpx.Response(
            200, json={"kind": "orders", "status": "ok", "rows": []}
        )
    )

    missing = await tools["bmq_customer"].handler(
        {
            "kind": "orders",
            "customer": "KH01",
            "time_range": "this_month",
            "limit": 5,
        }
    )
    extra = await tools["bmq_customer"].handler(
        {
            "kind": "orders",
            "customer": "KH01",
            "product": "",
            "time_range": "this_month",
            "limit": 5,
            "supplier": "NCC",
        }
    )
    scoped_product = await tools["bmq_customer"].handler(
        {
            "kind": "orders",
            "customer": "KH01",
            "product": "Pate",
            "time_range": "this_month",
            "limit": 5,
        }
    )
    assert missing["is_error"] is True
    assert extra["is_error"] is True
    assert scoped_product["is_error"] is True
    assert route.call_count == 0

    result = await tools["bmq_customer"].handler(
        {
            "kind": "orders",
            "customer": "KH01",
            "product": "",
            "time_range": "2026-09-01/2026-09-30",
            "limit": 5,
        }
    )
    assert result.get("is_error") is not True
    assert json.loads(route.calls[0].request.content) == {
        "kind": "orders",
        "customer": "KH01",
        "product": "",
        "time_range": {"start": "2026-09-01", "end": "2026-09-30"},
        "limit": 5,
    }


@respx.mock
async def test_customer_order_details_accepts_bounded_detail_filters() -> None:
    session = _session()
    tools = _tools(session)
    route = respx.post(f"{BASE}/v1/customer").mock(
        return_value=httpx.Response(
            200, json={"kind": "order_details", "status": "ok", "rows": []}
        )
    )

    result = await tools["bmq_customer"].handler(
        {
            "kind": "order_details",
            "customer": "KH01",
            "product": "Pate",
            "time_range": "this_month",
            "limit": 10,
            "detail_filters": {
                "route": "TUYEN-1",
                "date_basis": "submitted",
                "status": "all",
            },
        }
    )

    assert result.get("is_error") is not True
    body = json.loads(route.calls[0].request.content)
    assert body["detail_filters"] == {
        "route": "TUYEN-1",
        "date_basis": "submitted",
        "status": "all",
    }


@respx.mock
async def test_metric_unsupported_is_an_error_without_http() -> None:
    session = _session()
    tools = _tools(session)
    route = respx.post(f"{BASE}/v1/query").mock(
        return_value=httpx.Response(200, json={"rows": []})
    )

    unsupported = await tools["bmq_metric"].handler(
        {
            "metric": "revenue",
            "start": "2026-09-01",
            "end": "2026-09-30",
        }
    )
    bad_dimension = await tools["bmq_metric"].handler(
        {
            "metric": "supplier_debt",
            "dimension": "channel",
            "start": "2026-09-01",
            "end": "2026-09-30",
        }
    )
    extra = await tools["bmq_metric"].handler(
        {
            "metric": "supplier_debt",
            "start": "2026-09-01",
            "end": "2026-09-30",
            "bogus": 1,
        }
    )

    assert unsupported["is_error"] is True
    assert "chưa hỗ trợ" in unsupported["content"][0]["text"]
    assert bad_dimension["is_error"] is True
    assert "chưa hỗ trợ" in bad_dimension["content"][0]["text"]
    assert extra["is_error"] is True
    assert route.call_count == 0


@respx.mock
async def test_metric_calls_query_and_sorts_returned_rows() -> None:
    session = _session()
    tools = _tools(session)
    route = respx.post(f"{BASE}/v1/query").mock(
        return_value=httpx.Response(
            200,
            json={
                "metric": "controlled_revenue",
                "rows": [
                    {"channel": "B", "controlled_revenue": 20},
                    {"channel": "A", "controlled_revenue": 10},
                ],
            },
        )
    )

    result = await tools["bmq_metric"].handler(
        {
            "metric": "controlled_revenue",
            "dimension": "channel",
            "start": "2026-09-01",
            "end": "2026-09-30",
            "limit": 10,
            "sort": "asc",
        }
    )

    assert result.get("is_error") is not True
    rows = json.loads(result["content"][0]["text"])["rows"]
    assert [row["channel"] for row in rows] == ["A", "B"]
    assert json.loads(route.calls[0].request.content) == {
        "metric": "controlled_revenue",
        "time_range": {"start": "2026-09-01", "end": "2026-09-30"},
        "dimensions": ["channel"],
        "limit": 10,
    }


@respx.mock
async def test_unc_images_filters_ids_and_appends_image_block() -> None:
    session = _session()
    tools = _tools(session)
    valid = [
        {
            "id": f"{index:064x}",
            "declaration_id": f"UNC-{index}",
            "date": "2026-09-12",
            "kind": "UNC",
            "mime_type": "image/png",
            "bytes": 10,
            "payment_status": "submitted_unverified",
        }
        for index in range(10)
    ]
    invalid = [
        {
            "id": "../not-a-hash",
            "declaration_id": "BAD-1",
            "date": "2026-09-12",
            "kind": "UNC",
            "mime_type": "image/png",
            "bytes": 10,
            "payment_status": "submitted_unverified",
        },
        {
            "id": "A" * 64,
            "declaration_id": "BAD-2",
            "date": "2026-09-12",
            "kind": "UNC",
            "mime_type": "image/png",
            "bytes": 10,
            "payment_status": "submitted_unverified",
        },
        {
            "id": f"{99:064x}",
            "declaration_id": "BAD-3",
            "date": "2026-09-13",
            "kind": "UNC",
            "mime_type": "image/png",
            "bytes": 10,
            "payment_status": "submitted_unverified",
        },
        {
            "id": f"{98:064x}",
            "declaration_id": "BAD-4",
            "date": "2026-09-12",
            "kind": "PO",
            "mime_type": "image/png",
            "bytes": 10,
            "payment_status": "submitted_unverified",
        },
        {
            "id": f"{97:064x}",
            "declaration_id": "BAD-5",
            "date": "2026-09-12",
            "kind": "UNC",
            "mime_type": "image/png",
            "bytes": 10,
            "payment_status": "paid",
        },
        {
            "id": f"{96:064x}",
            "declaration_id": "BAD-6",
            "date": "2026-09-12",
            "kind": "UNC",
            "mime_type": "application/pdf",
            "bytes": 10,
            "payment_status": "submitted_unverified",
        },
    ]
    route = respx.post(f"{BASE}/v1/finance-media/search").mock(
        return_value=httpx.Response(
            200,
            json={
                "images": valid + invalid,
                "total": 16,
                "truncated": True,
                "selected_date": "2026-09-12",
            },
        )
    )

    result = await tools["bmq_unc_images"].handler(
        {"date": "2026-09-12", "limit": 8}
    )

    assert result.get("is_error") is not True
    block = session.pending_ui[-1]
    assert block["component"] == "sushi_answer"
    assert block["payload"]["answer"] == ""
    images = block["payload"]["images"]
    assert len(images) == 8
    assert all(re.fullmatch(r"[0-9a-f]{64}", image["id"]) for image in images)
    assert all(
        set(image) == {"id", "date", "declarationId", "paymentStatus"}
        for image in images
    )
    assert all(image["paymentStatus"] == "submitted_unverified" for image in images)
    text = result["content"][0]["text"]
    assert "8" in text
    assert "2026-09-12" in text
    assert "UNC-0" in text
    assert json.loads(route.calls[0].request.content) == {
        "date": "2026-09-12",
        "limit": 8,
    }


@respx.mock
async def test_unc_images_validates_period_and_limit_before_http() -> None:
    session = _session()
    tools = _tools(session)
    route = respx.post(f"{BASE}/v1/finance-media/search").mock(
        return_value=httpx.Response(200, json={"images": []})
    )

    both = await tools["bmq_unc_images"].handler(
        {"date": "2026-09-12", "month": "2026-09"}
    )
    neither = await tools["bmq_unc_images"].handler({})
    too_many = await tools["bmq_unc_images"].handler(
        {"date": "2026-09-12", "limit": 9}
    )
    bad_day = await tools["bmq_unc_images"].handler({"date": "2026-02-30"})
    extra = await tools["bmq_unc_images"].handler(
        {"date": "2026-09-12", "bogus": 1}
    )

    for result in (both, neither, too_many, bad_day, extra):
        assert result["is_error"] is True
    assert route.call_count == 0


@respx.mock
async def test_warehouse_error_is_returned_as_tool_error() -> None:
    session = _session()
    tools = _tools(session)
    respx.post(f"{BASE}/v1/cost").mock(
        return_value=httpx.Response(401, json={"detail": "unauthorized"})
    )

    result = await tools["bmq_cost"].handler(
        {"question": "month_totals", "month": "2026-09"}
    )

    assert result["is_error"] is True
    assert result["content"][0]["text"] == (
        "phiên đăng nhập hết hạn hoặc không đủ quyền"
    )


def test_cost_block_has_the_renderer_shape() -> None:
    block = cost_block(_example_result(), "example_line")
    assert block is not None
    assert set(block) == {
        "v",
        "kind",
        "mode",
        "month",
        "line",
        "evidence",
        "notes",
        "source",
        "followUp",
    }
    assert block["v"] == 1
    assert block["kind"] == "cost_line"
    assert block["mode"] == "example"
    assert block["month"] == "2026-09"
    assert set(block["line"]) == {
        "classificationId",
        "sourceNumber",
        "sourceDate",
        "supplierName",
        "productName",
        "amount",
        "categoryLabel",
        "categoryCode",
        "reviewStatus",
        "confidence",
        "classificationSource",
    }
    assert block["line"]["classificationId"] == "c2"
    assert block["line"]["amount"] == 8344200
    assert set(block["evidence"]) == {"stored", "rule", "alias", "aliasStatus"}
    assert set(block["evidence"]["rule"]) == {
        "name",
        "scope",
        "priority",
        "confidence",
        "effectiveFrom",
        "effectiveTo",
    }
    assert set(block["source"]) == {
        "name",
        "observedAt",
        "snapshotId",
        "semanticVersion",
        "selectionRule",
        "matchCount",
        "truncated",
        "disclaimer",
    }
    assert block["source"]["selectionRule"] == EXAMPLE_SELECTION_RULE
    assert block["source"]["matchCount"] == 2
    assert block["source"]["truncated"] is True
    assert block["followUp"] == "line_explanation"


def test_cost_block_explanation_mode() -> None:
    result = {
        **_source_fields(),
        "question": "line_explanation",
        "status": "ok",
        "line": _picked_line(),
        "evidence": {"rule": None, "alias_mapping": None, "alias_status": None},
    }

    block = cost_block(result, "line_explanation")

    assert block is not None
    assert block["mode"] == "explanation"
    assert block["source"]["selectionRule"] is None
    assert block["source"]["matchCount"] is None
    assert block["source"]["truncated"] is False
    assert block["followUp"] == "line_explanation"
    assert "lý do lịch sử không có sẵn" in " ".join(block["notes"])


def test_cost_block_rejects_aggregate_and_non_ok_results() -> None:
    assert cost_block({"question": "month_totals"}, "month_totals") is None
    assert (
        cost_block(
            {**_source_fields(), "question": "line_explanation", "status": "not_found"},
            "line_explanation",
        )
        is None
    )
    assert (
        cost_block(
            {**_example_result(), "rows": [], "match_count": 0},
            "example_line",
        )
        is None
    )


@respx.mock
async def test_cost_tool_appends_example_cost_block() -> None:
    session = _session()
    tools = _tools(session)
    respx.post(f"{BASE}/v1/cost").mock(
        return_value=httpx.Response(200, json=_example_result())
    )

    result = await tools["bmq_cost"].handler(
        {"question": "example_line", "month": "2026-09", "review_status": "needs_review"}
    )

    assert result.get("is_error") is not True
    assert len(session.pending_ui) == 1
    block = session.pending_ui[0]
    assert block["component"] == "sushi_answer"
    assert block["payload"]["answer"] == ""
    assert block["payload"]["costBlock"]["mode"] == "example"
    assert block["payload"]["costBlock"]["v"] == 1
    assert block["payload"]["costBlock"]["kind"] == "cost_line"


@respx.mock
async def test_tools_read_the_current_owner_token_on_every_call() -> None:
    session = _session("owner-token-1")
    tools = _tools(session)
    route = respx.post(f"{BASE}/v1/cost").mock(
        return_value=httpx.Response(
            200, json={"question": "month_totals", "rows": []}
        )
    )

    await tools["bmq_cost"].handler(
        {"question": "month_totals", "month": "2026-09"}
    )
    session.owner_token = "owner-token-2"
    await tools["bmq_cost"].handler(
        {"question": "month_totals", "month": "2026-09"}
    )

    headers = [
        call.request.headers["authorization"] for call in route.calls
    ]
    assert headers == ["Bearer owner-token-1", "Bearer owner-token-2"]


def test_server_registers_all_direct_tools_and_prompt(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from bmq_merchant import server

    captured: dict[str, Any] = {}

    def fake_create_server(
        name: str, version: str = "1.0.0", tools: Any = None
    ) -> Any:
        captured["tools"] = list(tools or [])
        return {"type": "sdk", "name": name}

    monkeypatch.setattr(server, "create_sdk_mcp_server", fake_create_server)
    session = _session()
    options = SimpleNamespace(
        system_prompt="BASE PROMPT",
        mcp_servers={},
        allowed_tools=["mcp__merchant__get_business_snapshot"],
    )

    server._wire_sushi(options, session, _settings())

    names = {sdk_tool.name for sdk_tool in captured["tools"]}
    assert names == {
        "ask_sushi",
        "bmq_cost",
        "bmq_payment",
        "bmq_customer",
        "bmq_metric",
        "bmq_unc_images",
    }
    expected_allowed = {f"mcp__bmq__{name}" for name in names}
    assert expected_allowed <= set(options.allowed_tools)
    assert "mcp__bmq__ask_sushi" in options.system_prompt
    assert "mcp__bmq__bmq_cost" in options.system_prompt
    assert "mcp__bmq__bmq_unc_images" in options.system_prompt
    assert "phương án cuối" in options.system_prompt
    assert "VNAgent" in options.system_prompt
    assert "Sushi" not in options.system_prompt
    assert "không có công cụ trực tiếp" in server.SUSHI_TOOL_DESCRIPTION


def test_server_wiring_falls_back_when_options_are_minimal() -> None:
    from bmq_merchant import server

    # A test double may expose neither mcp_servers nor allowed_tools; wiring must
    # be skipped instead of failing the chat session.
    server._wire_sushi(SimpleNamespace(), _session(), _settings())
