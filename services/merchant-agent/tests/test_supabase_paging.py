import httpx
import respx

from bmq_merchant.supabase import SELECT_PAGE_SIZE, SupabaseClient

BASE = "https://example.supabase.co"


@respx.mock
async def test_select_pages_past_the_1000_row_cap() -> None:
    calls: list[dict[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        params = dict(request.url.params)
        calls.append(params)
        offset = int(params["offset"])
        size = SELECT_PAGE_SIZE if offset == 0 else 5
        return httpx.Response(200, json=[{"id": f"r{offset + i}"} for i in range(size)])

    respx.get(f"{BASE}/rest/v1/revenue_ledger_lines").mock(side_effect=handler)
    client = SupabaseClient(supabase_url=BASE, service_role_key="svc", anon_key="anon")
    rows = await client.select("revenue_ledger_lines", {"select": "id"})

    assert len(rows) == SELECT_PAGE_SIZE + 5
    assert [c["offset"] for c in calls] == ["0", str(SELECT_PAGE_SIZE)]
    assert all(c["order"] == "id.asc" and c["limit"] == str(SELECT_PAGE_SIZE) for c in calls)


@respx.mock
async def test_select_with_explicit_limit_is_one_request() -> None:
    route = respx.get(f"{BASE}/rest/v1/product_skus").mock(return_value=httpx.Response(200, json=[{"id": "a"}]))
    client = SupabaseClient(supabase_url=BASE, service_role_key="svc", anon_key="anon")
    assert await client.select("product_skus", {"limit": "1"}) == [{"id": "a"}]
    assert route.call_count == 1
