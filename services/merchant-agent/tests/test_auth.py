from __future__ import annotations

import httpx
import pytest
import respx
from fastapi import HTTPException

from bmq_merchant.auth import clear_owner_cache, verify_owner
from bmq_merchant.config import Settings
from tests.conftest import TEST_SUPABASE_URL

BASE = TEST_SUPABASE_URL
USER_ID = "11111111-1111-4111-8111-111111111111"


def _settings(settings: Settings) -> Settings:
    return settings


@respx.mock
async def test_missing_token_is_401(settings: Settings) -> None:
    clear_owner_cache()
    with pytest.raises(HTTPException) as raised:
        await verify_owner(None, config=_settings(settings))
    assert raised.value.status_code == 401


@respx.mock
async def test_invalid_token_is_401(settings: Settings) -> None:
    clear_owner_cache()
    respx.get(f"{BASE}/auth/v1/user").mock(
        return_value=httpx.Response(401, json={"message": "invalid jwt"})
    )
    with pytest.raises(HTTPException) as raised:
        await verify_owner("Bearer bad-token", config=settings)
    assert raised.value.status_code == 401


@respx.mock
async def test_non_owner_is_403(settings: Settings) -> None:
    clear_owner_cache()
    respx.get(f"{BASE}/auth/v1/user").mock(
        return_value=httpx.Response(
            200, json={"id": USER_ID, "email": "staff@bmq.vn"}
        )
    )
    respx.post(f"{BASE}/rest/v1/rpc/has_role").mock(
        return_value=httpx.Response(200, json=False)
    )
    with pytest.raises(HTTPException) as raised:
        await verify_owner("Bearer staff-token", config=settings)
    assert raised.value.status_code == 403


@respx.mock
async def test_owner_passes_and_positive_cache_is_used(settings: Settings) -> None:
    clear_owner_cache()
    user_route = respx.get(f"{BASE}/auth/v1/user").mock(
        return_value=httpx.Response(
            200, json={"id": USER_ID, "email": "owner@bmq.vn"}
        )
    )
    role_route = respx.post(f"{BASE}/rest/v1/rpc/has_role").mock(
        return_value=httpx.Response(200, json=True)
    )

    first = await verify_owner("Bearer owner-token", config=settings)
    second = await verify_owner("Bearer owner-token", config=settings)

    assert first.user_id == USER_ID
    assert first.email == "owner@bmq.vn"
    assert second == first
    assert user_route.call_count == 1
    assert role_route.call_count == 1
    payload = role_route.calls.last.request
    assert payload.url.path.endswith("/rpc/has_role")
    assert b'"owner"' in payload.content
