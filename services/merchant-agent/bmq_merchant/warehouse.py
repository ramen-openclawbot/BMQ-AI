"""Read-only client for the local BMQ warehouse owner API.

Every call forwards the current owner's Supabase access token.  The warehouse
authenticates that token itself (Supabase owner check) and scopes the read to the
owner's tenant; this client never adds a service-role credential or a write
operation.
"""

from __future__ import annotations

import json
from typing import Any

import httpx

DEFAULT_TIMEOUT_SECONDS = 20.0

SIGNED_OUT_MESSAGE = "phiên đăng nhập hết hạn hoặc không đủ quyền"
INVALID_QUESTION_MESSAGE = "câu hỏi chưa đúng cú pháp"
UNAVAILABLE_MESSAGE = "kho dữ liệu tạm không phản hồi"

# Closed set of owner routes this process may call.  Keeping it here means a
# caller cannot turn the client into a generic warehouse proxy.
_ROUTE_METHODS = {
    "/v1/semantic": "GET",
    "/v1/query": "POST",
    "/v1/cost": "POST",
    "/v1/payment": "POST",
    "/v1/customer": "POST",
    "/v1/finance-media/search": "POST",
}


class WarehouseError(RuntimeError):
    """A short, user-facing warehouse failure (never carries credentials)."""


def _detail_text(response: httpx.Response) -> str:
    """Extract a bounded, display-safe detail from a warehouse error body."""

    try:
        body = response.json()
    except ValueError:
        return "yêu cầu không hợp lệ"
    detail: Any = None
    if isinstance(body, dict):
        # FastAPI HTTPException uses "detail"; the warehouse's own ValueError
        # handler uses "message" (with an "error" code).
        detail = body.get("detail")
        if detail is None:
            detail = body.get("message")
        if detail is None:
            detail = body.get("error")
    if isinstance(detail, list):
        parts: list[str] = []
        for item in detail[:3]:
            if isinstance(item, dict):
                message = item.get("msg")
                if isinstance(message, str) and message.strip():
                    parts.append(message.strip())
            elif isinstance(item, str) and item.strip():
                parts.append(item.strip())
        detail = "; ".join(parts)
    elif isinstance(detail, dict):
        detail = json.dumps(detail, ensure_ascii=False, default=str)
    if not isinstance(detail, str) or not detail.strip():
        detail = "yêu cầu không hợp lệ"
    # Collapse whitespace and cap the text so an upstream traceback or SQL
    # fragment can never become a large prompt payload.
    return " ".join(detail.split())[:200]


class WarehouseClient:
    """Bounded async client for the warehouse's owner-authenticated routes."""

    def __init__(self, base_url: str, timeout: float = DEFAULT_TIMEOUT_SECONDS) -> None:
        self.base_url = (base_url or "").strip().rstrip("/")
        self.timeout = timeout

    async def _request(self, path: str, token: str, body: Any = None) -> Any:
        method = _ROUTE_METHODS.get(path)
        if method is None:
            raise WarehouseError("thao tác kho dữ liệu chưa được hỗ trợ")
        if not token:
            raise WarehouseError(SIGNED_OUT_MESSAGE)

        headers = {
            "Authorization": f"Bearer {token}",
            "Accept": "application/json",
        }
        if method == "POST":
            headers["Content-Type"] = "application/json"

        try:
            async with httpx.AsyncClient(
                timeout=self.timeout, follow_redirects=False
            ) as client:
                if method == "GET":
                    response = await client.get(
                        self.base_url + path, headers=headers
                    )
                else:
                    response = await client.post(
                        self.base_url + path, headers=headers, json=body
                    )
        except httpx.HTTPError as exc:
            raise WarehouseError(UNAVAILABLE_MESSAGE) from exc

        if response.status_code in (401, 403):
            raise WarehouseError(SIGNED_OUT_MESSAGE)
        if 400 <= response.status_code < 500:
            raise WarehouseError(
                f"{INVALID_QUESTION_MESSAGE}: {_detail_text(response)}"
            )
        if not 200 <= response.status_code < 300:
            # Redirects are deliberately not followed.  Any other non-2xx is a
            # transport-level failure from the caller's point of view.
            raise WarehouseError(UNAVAILABLE_MESSAGE)
        try:
            return response.json()
        except ValueError as exc:
            raise WarehouseError(UNAVAILABLE_MESSAGE) from exc

    async def get_semantic(self, token: str) -> Any:
        return await self._request("/v1/semantic", token)

    async def query(self, token: str, dsl: dict[str, Any]) -> Any:
        return await self._request("/v1/query", token, dsl)

    async def cost(self, token: str, request: dict[str, Any]) -> Any:
        return await self._request("/v1/cost", token, request)

    async def payment(self, token: str, request: dict[str, Any]) -> Any:
        return await self._request("/v1/payment", token, request)

    async def customer(self, token: str, request: dict[str, Any]) -> Any:
        return await self._request("/v1/customer", token, request)

    async def finance_media_search(self, token: str, body: dict[str, Any]) -> Any:
        return await self._request("/v1/finance-media/search", token, body)
