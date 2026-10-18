"""Supabase JWT + BMQ owner authorization."""

from __future__ import annotations

import hashlib
import time
from dataclasses import dataclass

from fastapi import HTTPException, status

from .config import Settings
from .supabase import SupabaseClient, SupabaseError

OWNER_CACHE_TTL_SECONDS = 60.0
_OWNER_CACHE: dict[str, tuple[float, "Owner"]] = {}


@dataclass(frozen=True, slots=True)
class Owner:
    user_id: str
    email: str | None = None
    full_name: str | None = None

    @property
    def principal(self) -> str:
        return self.email or self.user_id


def _token_key(access_token: str) -> str:
    return hashlib.sha256(access_token.encode("utf-8")).hexdigest()


def clear_owner_cache() -> None:
    _OWNER_CACHE.clear()


def _bearer_token(authorization_header: str | None) -> str:
    if not authorization_header:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Thiếu Authorization Bearer token",
        )
    scheme, _, token = authorization_header.partition(" ")
    if scheme.casefold() != "bearer" or not token.strip():
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authorization phải là Bearer token",
        )
    return token.strip()


async def verify_owner(
    authorization_header: str | None,
    config: Settings | None = None,
    client: SupabaseClient | None = None,
) -> Owner:
    """Return the authenticated BMQ owner or raise 401/403.

    Positive results are cached for 60 seconds keyed by a SHA-256 hash of the
    bearer token, so a burst of chat clicks does not issue one auth request each.
    Negative results are never cached.
    """

    access_token = _bearer_token(authorization_header)
    cache_key = _token_key(access_token)
    cached = _OWNER_CACHE.get(cache_key)
    if cached is not None and cached[0] > time.monotonic():
        return cached[1]

    settings = config or Settings.from_env()
    supabase = client or SupabaseClient(
        supabase_url=settings.supabase_url,
        service_role_key=settings.service_role_key,
        anon_key=settings.auth_api_key,
    )

    try:
        user = await supabase.auth_user(access_token)
    except SupabaseError as exc:
        if exc.status_code in {400, 401, 403}:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Token đăng nhập không hợp lệ hoặc đã hết hạn",
            ) from exc
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Không xác minh được phiên đăng nhập Supabase",
        ) from exc

    user_id = str(user["id"])
    try:
        is_owner = await supabase.rpc(
            "has_role",
            {"_user_id": user_id, "_role": "owner"},
        )
    except SupabaseError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Không kiểm tra được quyền owner BMQ",
        ) from exc

    if is_owner is not True:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Tài khoản không có quyền owner BMQ",
        )

    metadata = user.get("user_metadata")
    full_name = (
        str(metadata.get("full_name")) if isinstance(metadata, dict) and metadata.get("full_name") else None
    )
    owner = Owner(
        user_id=user_id,
        email=str(user["email"]) if user.get("email") else None,
        full_name=full_name,
    )
    _OWNER_CACHE[cache_key] = (time.monotonic() + OWNER_CACHE_TTL_SECONDS, owner)
    return owner
