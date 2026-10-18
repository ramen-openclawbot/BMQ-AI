from __future__ import annotations

import json
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx
from merchant_agent import (
    ChangeKind,
    InventoryActionItem,
    ListingFilters,
    MerchantSessionContext,
    PriceUpdateItem,
    PromotionDraft,
    CampaignDraft,
)
from merchant_agent.changes import ChangeNotApplicable

from bmq_merchant.backend import BmqMerchantBackend, _row_to_staged
from bmq_merchant.config import Settings
from bmq_merchant.supabase import SupabaseClient
from tests.conftest import TEST_SUPABASE_URL

BASE = TEST_SUPABASE_URL
SESSION = MerchantSessionContext(
    session_id="session-1", merchant_id="bmq", operator="owner@bmq.vn"
)


def backend(settings: Settings, today: date | None = None) -> BmqMerchantBackend:
    client = SupabaseClient(
        supabase_url=settings.supabase_url,
        service_role_key=settings.service_role_key,
        anon_key=settings.anon_key,
    )
    return BmqMerchantBackend(
        client,
        settings.merchant_config(),
        today_provider=(lambda: today) if today else None,
    )


def _staged_row(body: dict[str, Any], change_id: str) -> dict[str, Any]:
    return {
        **body,
        "id": change_id,
        "created_at": "2026-10-18T03:00:00+00:00",
        "status": body.get("status", "staged"),
    }


@respx.mock
async def test_snapshot_compares_revenue_and_orders(settings: Settings) -> None:
    revenue_route = respx.get(f"{BASE}/rest/v1/revenue_ledger_lines").mock(
        return_value=httpx.Response(
            200,
            json=[
                {"revenue_date": "2026-10-18", "gross_revenue": 100.0, "quantity": 10},
                {"revenue_date": "2026-10-11", "gross_revenue": 80.0, "quantity": 8},
            ],
        )
    )
    orders_route = respx.get(f"{BASE}/rest/v1/dealer_orders").mock(
        return_value=httpx.Response(
            200,
            json=[
                {
                    "order_number": "DO-1",
                    "requested_delivery_date": "2026-10-17",
                    "total_amount_vnd": 50,
                },
                {
                    "order_number": "DO-2",
                    "requested_delivery_date": "2026-10-16",
                    "total_amount_vnd": 60,
                },
                {
                    "order_number": "DO-3",
                    "requested_delivery_date": "2026-10-10",
                    "total_amount_vnd": 70,
                },
            ],
        )
    )

    result = await backend(settings, date(2026, 10, 18)).get_business_snapshot(
        SESSION, "last_7_days"
    )

    assert result.sales == 100
    assert result.orders == 2
    assert result.average_order_value == 50
    assert result.sales_change_pct == 25.0
    assert result.currency == "VND"
    assert revenue_route.called and orders_route.called
    assert revenue_route.calls.last.request.url.params["approval_status"] == "eq.approved"
    assert orders_route.calls.last.request.url.params["is_test"] == "eq.false"


@respx.mock
async def test_search_listings_flags_price_image_and_hidden(settings: Settings) -> None:
    respx.get(f"{BASE}/rest/v1/product_skus").mock(
        return_value=httpx.Response(
            200,
            json=[
                {
                    "id": "sku-1",
                    "sku_code": "BMQ-001",
                    "product_name": "Bánh Mì Que Pate",
                    "category": "Thành phẩm",
                    "sku_type": "finished_good",
                    "unit": "que",
                    "cost_values": {"selling_price": 12000},
                    "image_url": "https://img/1.jpg",
                    "hide_from_dealer_portal": False,
                },
                {
                    "id": "sku-2",
                    "sku_code": "BMQ-002",
                    "product_name": "Không giá",
                    "category": "Thành phẩm",
                    "sku_type": "finished_good",
                    "unit": "que",
                    "cost_values": {},
                    "image_url": None,
                    "hide_from_dealer_portal": False,
                },
                {
                    "id": "sku-3",
                    "sku_code": "BMQ-003",
                    "product_name": "Đang ẩn",
                    "category": "Thành phẩm",
                    "sku_type": "finished_good",
                    "unit": "que",
                    "cost_values": {"selling_price": 15000},
                    "image_path": "sku/3.jpg",
                    "hide_from_dealer_portal": True,
                },
                {
                    "id": "raw-1",
                    "sku_code": "RAW-1",
                    "product_name": "Bột mì",
                    "category": "Nguyên liệu",
                    "sku_type": "raw_material",
                },
            ],
        )
    )
    respx.get(f"{BASE}/rest/v1/mini_crm_customer_price_list").mock(
        return_value=httpx.Response(
            200,
            json=[
                {"id": "p-1", "sku_id": "sku-1", "customer_id": "c-1", "is_active": True}
            ],
        )
    )

    listings = await backend(settings).search_listings(
        SESSION, "", filters=ListingFilters(), limit=10
    )
    by_id = {listing.listing_id: listing for listing in listings}

    assert set(by_id) == {"sku-1", "sku-2", "sku-3"}
    assert by_id["sku-1"].price == 12000
    assert by_id["sku-1"].attributes["dealer_override_count"] == "1"
    assert "thiếu giá" in by_id["sku-2"].attributes["issues"]
    assert "thiếu ảnh" in by_id["sku-2"].attributes["issues"]
    assert by_id["sku-3"].status == "paused"
    assert "đang ẩn" in by_id["sku-3"].attributes["issues"]
    assert by_id["sku-2"].content_quality == "poor"


@respx.mock
async def test_order_issues_missing_regular_and_locked(
    settings: Settings,
) -> None:
    today = datetime.now().astimezone().date()
    customers = [
        {
            "id": "cust-regular",
            "customer_name": "Đại lý Thường",
            "is_npp": False,
            "is_active": True,
            "order_locked": False,
        },
        {
            "id": "cust-locked",
            "customer_name": "Đại lý Khóa",
            "is_npp": False,
            "is_active": True,
            "order_locked": True,
        },
        {
            "id": "cust-npp",
            "customer_name": "NPP",
            "is_npp": True,
            "is_active": True,
            "order_locked": False,
        },
    ]
    week_dates = [
        (today - timedelta(days=6)).isoformat(),
        (today - timedelta(days=5)).isoformat(),
        (today - timedelta(days=4)).isoformat(),
        (today - timedelta(days=3)).isoformat(),
    ]

    def orders_handler(request: httpx.Request) -> httpx.Response:
        if request.url.params.get("status") == "in.(submitted,pending)":
            return httpx.Response(
                200,
                json=[
                    {
                        "order_number": "DO-OLD",
                        "customer_id": "cust-regular",
                        "status": "submitted",
                        "submitted_at": (datetime.now(timezone.utc) - timedelta(hours=8)).isoformat(),
                    }
                ],
            )
        return httpx.Response(
            200,
            json=[
                {
                    "customer_id": "cust-regular",
                    "requested_delivery_date": value,
                }
                for value in week_dates
            ],
        )

    respx.get(f"{BASE}/rest/v1/mini_crm_customers").mock(
        return_value=httpx.Response(200, json=customers)
    )
    respx.get(f"{BASE}/rest/v1/dealer_orders").mock(side_effect=orders_handler)

    issues = await backend(settings).get_order_issues(SESSION)
    summaries = [issue.summary for issue in issues]

    # Orders never leave "submitted" in BMQ, so no "unconfirmed" issue is raised.
    assert not any("DO-OLD" in summary for summary in summaries)
    assert any("Đại lý Thường" in summary and "4/7" in summary for summary in summaries)
    assert any("Đại lý Khóa" in summary and "khóa đặt hàng" in summary for summary in summaries)
    assert not any("NPP" in summary and "4/7" in summary for summary in summaries)


@respx.mock
async def test_pricing_context_has_catalog_price_and_overrides(settings: Settings) -> None:
    def prices_handler(request: httpx.Request) -> httpx.Response:
        if request.url.params.get("id"):
            return httpx.Response(200, json=[])
        return httpx.Response(
            200,
            json=[
                {
                    "id": "price-1",
                    "customer_id": "cust-1",
                    "sku_id": "sku-1",
                    "price_vnd_per_unit": 11000,
                    "updated_at": "2026-10-01T00:00:00+00:00",
                }
            ],
        )

    respx.get(f"{BASE}/rest/v1/mini_crm_customer_price_list").mock(
        side_effect=prices_handler
    )
    respx.get(f"{BASE}/rest/v1/product_skus").mock(
        return_value=httpx.Response(
            200,
            json=[
                {
                    "id": "sku-1",
                    "sku_code": "BMQ-001",
                    "product_name": "Bánh Mì Que Pate",
                    "category": "Thành phẩm",
                    "sku_type": "finished_good",
                    "unit": "que",
                    "cost_values": {"selling_price": 12000},
                    "hide_from_dealer_portal": False,
                }
            ],
        )
    )

    context = await backend(settings).get_pricing_context(SESSION, "sku-1")

    assert context is not None
    assert context.current_price == 12000
    assert context.currency == "VND"
    assert len(context.variants) == 1
    assert context.variants[0].listing_id == "price-1"
    assert context.variants[0].current_price == 11000


def _sku_row(sku_id: str = "sku-1") -> dict[str, Any]:
    return {
        "id": sku_id,
        "sku_code": "BMQ-001",
        "product_name": "Bánh Mì Que Pate",
        "category": "Thành phẩm",
        "sku_type": "finished_good",
        "unit": "que",
        "cost_values": {"selling_price": 12000},
        "notes": "SKU bán",
        "image_url": "https://img/1.jpg",
        "hide_from_dealer_portal": False,
    }


@respx.mock
async def test_every_stage_writes_one_staged_change_with_before(
    settings: Settings,
) -> None:
    insert_bodies: list[dict[str, Any]] = []
    counter = {"value": 0}

    def sku_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[_sku_row()])

    def price_handler(request: httpx.Request) -> httpx.Response:
        if request.url.params.get("id"):
            if request.url.params["id"] == "eq.price-1":
                return httpx.Response(
                    200,
                    json=[
                        {
                            "id": "price-1",
                            "customer_id": "cust-1",
                            "sku_id": "sku-1",
                            "price_vnd_per_unit": 11000,
                            "is_active": True,
                            "updated_at": "2026-10-01T00:00:00+00:00",
                        }
                    ],
                )
            return httpx.Response(200, json=[])
        return httpx.Response(
            200,
            json=[
                {
                    "id": "price-1",
                    "customer_id": "cust-1",
                    "sku_id": "sku-1",
                    "price_vnd_per_unit": 11000,
                    "is_active": True,
                    "updated_at": "2026-10-01T00:00:00+00:00",
                }
            ],
        )

    def insert_handler(request: httpx.Request) -> httpx.Response:
        counter["value"] += 1
        body = json.loads(request.content)
        insert_bodies.append(body)
        return httpx.Response(
            201,
            json=[_staged_row(body, f"change-{counter['value']}")],
        )

    respx.get(f"{BASE}/rest/v1/product_skus").mock(side_effect=sku_handler)
    respx.get(f"{BASE}/rest/v1/mini_crm_customer_price_list").mock(
        side_effect=price_handler
    )
    post_route = respx.post(f"{BASE}/rest/v1/merchant_staged_changes").mock(
        side_effect=insert_handler
    )
    subject = backend(settings)

    listing_change = await subject.stage_listing_update(
        SESSION, "sku-1", {"title": "Tên mới"}
    )
    price_change = await subject.stage_price_update(
        SESSION, [PriceUpdateItem(listing_id="price-1", new_price=13000)]
    )
    inventory_change = await subject.stage_inventory_action(
        SESSION, [InventoryActionItem(listing_id="sku-1", action="restock", quantity=10)]
    )
    promotion_change = await subject.stage_promotion(
        SESSION,
        PromotionDraft(
            name="Khuyến mãi cuối tuần",
            listing_ids=["sku-1"],
            discount_pct=10,
            starts="2026-10-18",
            ends="2026-10-20",
        ),
    )
    campaign_change = await subject.stage_campaign(
        SESSION,
        CampaignDraft(
            name="Chiến dịch đại lý",
            objective="Tăng đơn",
            budget=1000000,
            starts="2026-10-18",
            ends="2026-10-25",
        ),
    )

    assert [
        listing_change.kind,
        price_change.kind,
        inventory_change.kind,
        promotion_change.kind,
        campaign_change.kind,
    ] == [
        ChangeKind.LISTING_UPDATE,
        ChangeKind.PRICE_UPDATE,
        ChangeKind.INVENTORY_ACTION,
        ChangeKind.PROMOTION,
        ChangeKind.CAMPAIGN,
    ]
    assert post_route.call_count == 5
    assert [body["kind"] for body in insert_bodies] == [
        "listing",
        "price",
        "inventory",
        "promotion",
        "campaign",
    ]
    assert all(body["status"] == "staged" for body in insert_bodies)
    assert all(body["operator"] == "owner@bmq.vn" for body in insert_bodies)
    assert all(body["session_id"] == "session-1" for body in insert_bodies)
    assert insert_bodies[0]["before"]["title"] == "Bánh Mì Que Pate"
    assert insert_bodies[1]["payload"][0]["customer_id"] == "cust-1"
    assert insert_bodies[1]["payload"][0]["price_vnd_per_unit"] == 13000
    assert insert_bodies[3]["payload"]["severity"] == "warning"
    assert insert_bodies[4]["payload"]["severity"] == "info"


@respx.mock
async def test_apply_refuses_unapproved_change(settings: Settings) -> None:
    respx.get(f"{BASE}/rest/v1/merchant_staged_changes").mock(
        return_value=httpx.Response(
            200, json=[_staged_row({"kind": "price", "status": "staged"}, "change-1")]
        )
    )

    with pytest.raises(ChangeNotApplicable, match="chưa được chủ"):
        await backend(settings).apply_change(SESSION, "change-1")


@respx.mock
async def test_apply_calls_price_rpc(settings: Settings) -> None:
    row = _staged_row({"kind": "price", "status": "approved"}, "change-1")
    applied = {**row, "status": "applied", "applied_at": "2026-10-18T04:00:00+00:00"}
    respx.get(f"{BASE}/rest/v1/merchant_staged_changes").mock(
        return_value=httpx.Response(200, json=[row])
    )
    rpc_route = respx.post(
        f"{BASE}/rest/v1/rpc/merchant_apply_price_change"
    ).mock(return_value=httpx.Response(200, json=applied))

    result = await backend(settings).apply_change(SESSION, "change-1")

    assert rpc_route.called
    assert json.loads(rpc_route.calls.last.request.content) == {"p_change_id": "change-1"}
    assert result.status == "applied"


@respx.mock
async def test_apply_calls_announcement_rpc_for_promotion(settings: Settings) -> None:
    row = _staged_row({"kind": "promotion", "status": "approved"}, "change-2")
    applied = {**row, "status": "applied", "applied_at": "2026-10-18T04:00:00+00:00"}
    respx.get(f"{BASE}/rest/v1/merchant_staged_changes").mock(
        return_value=httpx.Response(200, json=[row])
    )
    rpc_route = respx.post(
        f"{BASE}/rest/v1/rpc/merchant_apply_announcement"
    ).mock(return_value=httpx.Response(200, json=applied))

    result = await backend(settings).apply_change(SESSION, "change-2")

    assert rpc_route.called
    assert result.status == "applied"


@respx.mock
async def test_apply_marks_listing_failed_with_gd1_message(settings: Settings) -> None:
    row = _staged_row({"kind": "listing", "status": "approved"}, "change-3")
    failed = {**row, "status": "failed", "error": "Thay đổi listing chưa hỗ trợ áp ở GĐ1"}
    respx.get(f"{BASE}/rest/v1/merchant_staged_changes").mock(
        return_value=httpx.Response(200, json=[row])
    )
    patch_route = respx.patch(f"{BASE}/rest/v1/merchant_staged_changes").mock(
        return_value=httpx.Response(200, json=[failed])
    )

    with pytest.raises(ChangeNotApplicable, match="chưa hỗ trợ áp ở GĐ1"):
        await backend(settings).apply_change(SESSION, "change-3")

    body = json.loads(patch_route.calls.last.request.content)
    assert body["status"] == "failed"
    assert "chưa hỗ trợ áp ở GĐ1" in body["error"]


@respx.mock
async def test_execute_analysis_query_returns_table(settings: Settings) -> None:
    rpc_route = respx.post(
        f"{BASE}/rest/v1/rpc/merchant_analysis_query"
    ).mock(
        return_value=httpx.Response(
            200,
            json=[{"channel": "Đại lý", "sales": 100}, {"channel": "Kiosk", "sales": 50}],
        )
    )

    table = await backend(settings).execute_analysis_query(
        SESSION, "select channel, sum(gross_revenue) as sales from revenue_lines_v group by channel"
    )

    assert table is not None
    assert table.columns == ["channel", "sales"]
    assert table.row_count == 2
    assert rpc_route.called


@respx.mock
async def test_query_metrics_returns_daily_sales_points(settings: Settings) -> None:
    respx.get(f"{BASE}/rest/v1/revenue_ledger_lines").mock(
        return_value=httpx.Response(
            200,
            json=[
                {"revenue_date": "2026-10-17", "channel": "Đại lý", "gross_revenue": 100},
                {"revenue_date": "2026-10-17", "channel": "Kiosk", "gross_revenue": 50},
                {"revenue_date": "2026-10-18", "channel": "Đại lý", "gross_revenue": 70},
            ],
        )
    )

    series = await backend(settings, date(2026, 10, 18)).query_metrics(
        SESSION, "sales", "last_7_days", "day", "channel:Đại lý"
    )

    assert series.metric == "sales"
    assert series.unit == "VND"
    assert [(point.date, point.value) for point in series.points] == [
        ("2026-10-17", 100),
        ("2026-10-18", 70),
    ]


@respx.mock
async def test_discard_change_marks_discarded(settings: Settings) -> None:
    row = _staged_row({"kind": "price", "status": "staged"}, "change-9")
    discarded = {**row, "status": "discarded"}
    respx.get(f"{BASE}/rest/v1/merchant_staged_changes").mock(
        return_value=httpx.Response(200, json=[row])
    )
    patch_route = respx.patch(f"{BASE}/rest/v1/merchant_staged_changes").mock(
        return_value=httpx.Response(200, json=[discarded])
    )

    result = await backend(settings).discard_change(SESSION, "change-9")

    assert result.status == "discarded"
    assert patch_route.called
    assert json.loads(patch_route.calls.last.request.content)["status"] == "discarded"


@respx.mock
async def test_query_metrics_orders_uses_requested_delivery_date(settings: Settings) -> None:
    respx.get(f"{BASE}/rest/v1/dealer_orders").mock(
        return_value=httpx.Response(
            200,
            json=[
                {
                    "order_number": "DO-1",
                    "requested_delivery_date": "2026-10-17",
                },
                {
                    "order_number": "DO-2",
                    "requested_delivery_date": "2026-10-17",
                },
                {
                    "order_number": "DO-3",
                    "requested_delivery_date": "2026-10-18",
                },
            ],
        )
    )

    series = await backend(settings, date(2026, 10, 18)).query_metrics(
        SESSION, "orders", "last_7_days"
    )

    assert series.unit == "đơn"
    assert [(point.date, point.value) for point in series.points] == [
        ("2026-10-17", 2),
        ("2026-10-18", 1),
    ]


def _guard_setup(
    settings: Settings,
) -> tuple[BmqMerchantBackend, dict[str, Any], Any, Any]:
    insert: dict[str, Any] = {}

    def sku_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json=[_sku_row()])

    def insert_handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        insert["body"] = body
        return httpx.Response(201, json=[_staged_row(body, "change-guard-1")])

    def patch_handler(request: httpx.Request) -> httpx.Response:
        values = json.loads(request.content)
        return httpx.Response(
            200,
            json=[_staged_row({**insert["body"], **values}, "change-guard-1")],
        )

    respx.get(f"{BASE}/rest/v1/product_skus").mock(side_effect=sku_handler)
    respx.get(f"{BASE}/rest/v1/mini_crm_customer_price_list").mock(
        return_value=httpx.Response(200, json=[])
    )
    respx.post(f"{BASE}/rest/v1/merchant_staged_changes").mock(
        side_effect=insert_handler
    )
    guard_route = respx.post(f"{BASE}/functions/v1/merchant-draft-guard")
    patch_route = respx.patch(f"{BASE}/rest/v1/merchant_staged_changes").mock(
        side_effect=patch_handler
    )
    return backend(settings), insert, guard_route, patch_route


@respx.mock
async def test_stage_posts_guard_with_service_key_and_keeps_notes(
    settings: Settings,
) -> None:
    subject, insert, guard_route, patch_route = _guard_setup(settings)
    guard_route.mock(
        return_value=httpx.Response(
            200,
            json={
                "notes": [
                    "Có thể nhắc món không có trong danh mục.",
                    "Thời gian/điều kiện chưa rõ.",
                ],
                "provider": "openai",
            },
        )
    )

    change = await subject.stage_listing_update(
        SESSION, "sku-1", {"title": "Tên mới"}
    )

    guard_request = guard_route.calls.last.request
    assert str(guard_request.url) == f"{BASE}/functions/v1/merchant-draft-guard"
    assert guard_request.headers["Authorization"] == (
        f"Bearer {settings.service_role_key}"
    )
    assert guard_request.headers["apikey"] == settings.service_role_key
    guard_body = json.loads(guard_request.content)
    assert guard_body["kind"] == "listing"
    assert guard_body["summary"] == "Cập nhật thông tin Bánh Mì Que Pate"
    assert guard_body["payload"] == {"listing_id": "sku-1", "fields": {"title": "Tên mới"}}
    assert guard_body["before"] == {"title": "Bánh Mì Que Pate"}
    assert guard_body["catalog"] == [
        {
            "sku_code": "BMQ-001",
            "product_name": "Bánh Mì Que Pate",
            "selling_price": 12000.0,
        }
    ]

    patch_body = json.loads(patch_route.calls.last.request.content)
    assert patch_body == {
        "guard_notes": [
            "Có thể nhắc món không có trong danh mục.",
            "Thời gian/điều kiện chưa rõ.",
        ],
        "guard_provider": "openai",
    }
    assert patch_route.calls.last.request.url.params.get("status") is None
    assert change.guardrail_notes == [
        "Có thể nhắc món không có trong danh mục.",
        "Thời gian/điều kiện chưa rõ.",
    ]


@respx.mock
async def test_guard_500_still_returns_the_staged_change_without_notes(
    settings: Settings,
) -> None:
    subject, _, guard_route, patch_route = _guard_setup(settings)
    guard_route.mock(return_value=httpx.Response(500, json={"error": "boom"}))

    change = await subject.stage_listing_update(
        SESSION, "sku-1", {"title": "Tên mới"}
    )

    assert change.status == "staged"
    assert change.guardrail_notes == []
    patch_body = json.loads(patch_route.calls.last.request.content)
    assert patch_body == {"guard_provider": "unavailable"}


@respx.mock
async def test_guard_timeout_still_returns_the_staged_change_without_notes(
    settings: Settings,
) -> None:
    subject, _, guard_route, patch_route = _guard_setup(settings)

    def timeout_handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("slow", request=request)

    guard_route.mock(side_effect=timeout_handler)

    change = await subject.stage_listing_update(
        SESSION, "sku-1", {"title": "Tên mới"}
    )

    assert change.status == "staged"
    assert change.guardrail_notes == []
    patch_body = json.loads(patch_route.calls.last.request.content)
    assert patch_body == {"guard_provider": "unavailable"}


@respx.mock
async def test_row_to_staged_maps_guard_notes(settings: Settings) -> None:
    row = _staged_row(
        {
            "kind": "price",
            "guard_notes": ["Có thể nhắc món không có trong danh mục.", "  "],
        },
        "change-guard-notes",
    )

    change = _row_to_staged(row)

    assert change.guardrail_notes == [
        "Có thể nhắc món không có trong danh mục."
    ]
