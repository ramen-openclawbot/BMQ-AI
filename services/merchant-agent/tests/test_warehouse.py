from __future__ import annotations

import json

import httpx
import pytest
import respx

from bmq_merchant.warehouse import WarehouseClient, WarehouseError

BASE = "https://warehouse.test"
TOKEN = "owner-jwt-token"


@pytest.fixture
def client() -> WarehouseClient:
    return WarehouseClient(BASE, timeout=1.0)


@respx.mock
async def test_client_uses_only_owner_routes_and_forwards_bearer(
    client: WarehouseClient,
) -> None:
    semantic = respx.get(f"{BASE}/v1/semantic").mock(
        return_value=httpx.Response(200, json={"version": "1.0"})
    )
    query = respx.post(f"{BASE}/v1/query").mock(
        return_value=httpx.Response(200, json={"rows": []})
    )
    cost = respx.post(f"{BASE}/v1/cost").mock(
        return_value=httpx.Response(200, json={"question": "month_totals"})
    )
    payment = respx.post(f"{BASE}/v1/payment").mock(
        return_value=httpx.Response(200, json={"question": "supplier_payments"})
    )
    customer = respx.post(f"{BASE}/v1/customer").mock(
        return_value=httpx.Response(200, json={"kind": "orders"})
    )
    media = respx.post(f"{BASE}/v1/finance-media/search").mock(
        return_value=httpx.Response(200, json={"images": []})
    )

    assert await client.get_semantic(TOKEN) == {"version": "1.0"}
    assert await client.query(TOKEN, {"metric": "supplier_debt"}) == {"rows": []}
    assert await client.cost(TOKEN, {"question": "month_totals"}) == {
        "question": "month_totals"
    }
    assert await client.payment(TOKEN, {"question": "supplier_payments"}) == {
        "question": "supplier_payments"
    }
    assert await client.customer(TOKEN, {"kind": "orders"}) == {"kind": "orders"}
    assert await client.finance_media_search(TOKEN, {"date": "2026-09-12"}) == {
        "images": []
    }

    for route in (semantic, query, cost, payment, customer, media):
        assert route.called
        assert (
            route.calls[0].request.headers["authorization"] == f"Bearer {TOKEN}"
        )
    assert json.loads(query.calls[0].request.content) == {"metric": "supplier_debt"}


@respx.mock
async def test_redirect_is_not_followed(client: WarehouseClient) -> None:
    first = respx.post(f"{BASE}/v1/query").mock(
        return_value=httpx.Response(
            302, headers={"Location": f"{BASE}/v1/cost"}
        )
    )
    followed = respx.post(f"{BASE}/v1/cost").mock(
        return_value=httpx.Response(200, json={"should": "not happen"})
    )

    with pytest.raises(WarehouseError) as excinfo:
        await client.query(TOKEN, {"metric": "supplier_debt"})

    assert first.call_count == 1
    assert followed.call_count == 0
    assert str(excinfo.value) == "kho dữ liệu tạm không phản hồi"


@pytest.mark.parametrize(
    ("status", "body", "expected"),
    [
        (401, {"detail": "unauthorized"}, "phiên đăng nhập hết hạn hoặc không đủ quyền"),
        (403, {"detail": "forbidden"}, "phiên đăng nhập hết hạn hoặc không đủ quyền"),
        (422, {"detail": "Invalid cost question"}, "câu hỏi chưa đúng cú pháp: Invalid cost question"),
        (500, {"detail": "boom"}, "kho dữ liệu tạm không phản hồi"),
        (503, {"detail": "unavailable"}, "kho dữ liệu tạm không phản hồi"),
    ],
)
@respx.mock
async def test_http_error_mapping(
    client: WarehouseClient, status: int, body: dict[str, str], expected: str
) -> None:
    respx.post(f"{BASE}/v1/cost").mock(
        return_value=httpx.Response(status, json=body)
    )

    with pytest.raises(WarehouseError) as excinfo:
        await client.cost(TOKEN, {"question": "month_totals"})

    assert str(excinfo.value) == expected


@respx.mock
async def test_timeout_and_connection_errors_are_unavailable(
    client: WarehouseClient,
) -> None:
    route = respx.post(f"{BASE}/v1/cost").mock(
        side_effect=httpx.ReadTimeout("timeout")
    )
    with pytest.raises(WarehouseError) as excinfo:
        await client.cost(TOKEN, {"question": "month_totals"})
    assert str(excinfo.value) == "kho dữ liệu tạm không phản hồi"
    assert route.call_count == 1

    route.mock(side_effect=httpx.ConnectError("no connection"))
    with pytest.raises(WarehouseError) as excinfo:
        await client.cost(TOKEN, {"question": "month_totals"})
    assert str(excinfo.value) == "kho dữ liệu tạm không phản hồi"


@respx.mock
async def test_4xx_detail_is_bounded(client: WarehouseClient) -> None:
    respx.post(f"{BASE}/v1/cost").mock(
        return_value=httpx.Response(422, json={"detail": "x" * 500})
    )

    with pytest.raises(WarehouseError) as excinfo:
        await client.cost(TOKEN, {"question": "month_totals"})

    text = str(excinfo.value)
    assert text.startswith("câu hỏi chưa đúng cú pháp: ")
    assert len(text) <= len("câu hỏi chưa đúng cú pháp: ") + 200


async def test_missing_owner_token_never_calls_http(client: WarehouseClient) -> None:
    with pytest.raises(WarehouseError) as excinfo:
        await client.cost("", {"question": "month_totals"})
    assert str(excinfo.value) == "phiên đăng nhập hết hạn hoặc không đủ quyền"
