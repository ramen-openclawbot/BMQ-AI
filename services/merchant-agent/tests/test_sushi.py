from __future__ import annotations

import json

import httpx
import pytest
import respx

from bmq_merchant.config import Settings
from bmq_merchant.sushi import SushiError, ask_sushi

from tests.conftest import TEST_ANON_KEY, TEST_SUPABASE_URL

SUSHI_URL = f"{TEST_SUPABASE_URL}/functions/v1/bmq-analytics"


@respx.mock
async def test_ask_sushi_forwards_owner_token_and_parses_provenance(
    settings: Settings,
) -> None:
    route = respx.post(SUSHI_URL).mock(
        return_value=httpx.Response(
            200,
            json={
                "answer": "Tổng công nợ nhà cung cấp là 10 triệu.",
                "requestId": "req-1",
                "provenance": {
                    "images": [{"url": f"https://img/{index}.jpg"} for index in range(9)],
                    "details": "Chi tiết công nợ theo nhà cung cấp.",
                    "costBlock": {"mode": "example_line", "line": {"id": "c1"}},
                    "citations": [
                        {
                            "id": "cite-1",
                            "title": "Bảng công nợ",
                            "source": "Supabase",
                            "updated_at": "2026-10-18",
                        }
                    ],
                    "lane": "supplier_debt",
                    "model": "gpt-test",
                    "queries": [],
                    "elapsedMs": 120,
                },
            },
        )
    )

    async with httpx.AsyncClient() as http:
        result = await ask_sushi(
            "  Công nợ nhà cung cấp?  ",
            "owner-jwt",
            "conversation-1",
            settings,
            http,
        )

    request = route.calls.last.request
    assert str(request.url) == SUSHI_URL
    assert request.headers["Authorization"] == "Bearer owner-jwt"
    assert request.headers["apikey"] == TEST_ANON_KEY
    assert request.headers["Accept-Language"] == "vi"
    body = json.loads(request.content)
    assert body == {
        "language": "vi",
        "question": "Công nợ nhà cung cấp?",
        "conversationId": "conversation-1",
        "page": {
            "route": "/merchant-agent",
            "label": "Trợ lý quản trị",
            "filters": {},
        },
        "history": [],
    }
    assert result.answer == "Tổng công nợ nhà cung cấp là 10 triệu."
    assert result.details == "Chi tiết công nợ theo nhà cung cấp."
    assert len(result.images) == 8
    assert result.cost_block == {"mode": "example_line", "line": {"id": "c1"}}
    assert result.citations[0]["id"] == "cite-1"
    assert result.lane == "supplier_debt"


@respx.mock
async def test_ask_sushi_truncates_to_2000_characters(settings: Settings) -> None:
    route = respx.post(SUSHI_URL).mock(
        return_value=httpx.Response(200, json={"answer": "ok", "provenance": {}})
    )

    async with httpx.AsyncClient() as http:
        await ask_sushi("x" * 2500, "owner-jwt", "conversation-1", settings, http)

    body = json.loads(route.calls.last.request.content)
    assert len(body["question"]) == 2000


@respx.mock
async def test_ask_sushi_maps_unauthorized_to_session_expired(
    settings: Settings,
) -> None:
    respx.post(SUSHI_URL).mock(return_value=httpx.Response(401, json={}))

    async with httpx.AsyncClient() as http:
        with pytest.raises(SushiError, match="phiên hết hạn"):
            await ask_sushi("Câu hỏi", "expired-jwt", "conversation-1", settings, http)


@respx.mock
async def test_ask_sushi_maps_quota_503_to_ai_quota(settings: Settings) -> None:
    respx.post(SUSHI_URL).mock(
        return_value=httpx.Response(
            503,
            json={"code": "ai_quota_exhausted", "message": "Hết hạn mức"},
        )
    )

    async with httpx.AsyncClient() as http:
        with pytest.raises(SushiError, match="hết hạn mức AI"):
            await ask_sushi("Câu hỏi", "owner-jwt", "conversation-1", settings, http)


@respx.mock
async def test_ask_sushi_maps_other_errors_and_timeouts(settings: Settings) -> None:
    route = respx.post(SUSHI_URL).mock(return_value=httpx.Response(500, json={}))
    async with httpx.AsyncClient() as http:
        with pytest.raises(SushiError, match="Chưa lấy được số liệu này"):
            await ask_sushi("Câu hỏi", "owner-jwt", "conversation-1", settings, http)

    route.mock(side_effect=httpx.ReadTimeout("too slow"))
    async with httpx.AsyncClient() as http:
        with pytest.raises(SushiError, match="Chưa lấy được số liệu này"):
            await ask_sushi("Câu hỏi", "owner-jwt", "conversation-1", settings, http)
