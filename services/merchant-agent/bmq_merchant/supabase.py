"""Small async PostgREST/RPC client for BMQ's Supabase project.

Only the operations this service needs are exposed.  The generic write surface is
private so the backend cannot accidentally update another table: staged changes
are the only table writes, and the three allowed RPCs are the only function calls.
"""

from __future__ import annotations

from typing import Any, Iterable, Mapping

import httpx

STAGED_CHANGES_TABLE = "merchant_staged_changes"
ALLOWED_RPCS = frozenset(
    {
        "has_role",
        "merchant_analysis_query",
        "merchant_apply_price_change",
        "merchant_apply_announcement",
        "merchant_prepare_bank_slip_request",
        "merchant_finalize_bank_slip_payment",
    }
)



# Supabase answers at most 1000 rows per request (PostgREST max-rows).
SELECT_PAGE_SIZE = 1000
SELECT_MAX_ROWS = 100_000

class SupabaseError(RuntimeError):
    """A typed PostgREST error that never carries credentials."""

    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        code: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code


class SupabaseClient:
    def __init__(
        self,
        supabase_url: str,
        service_role_key: str,
        anon_key: str = "",
        *,
        timeout: float = 10.0,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._base = supabase_url.rstrip("/")
        self._service_key = service_role_key
        self._anon_key = anon_key or service_role_key
        self._timeout = timeout
        self._transport = transport

    async def _request(
        self,
        method: str,
        url: str,
        *,
        headers: Mapping[str, str] | None = None,
        params: Mapping[str, str] | None = None,
        json: Any = None,
        timeout: float | None = None,
        service_auth: bool = True,
    ) -> httpx.Response:
        request_headers = (
            {
                "apikey": self._service_key,
                "Authorization": f"Bearer {self._service_key}",
                "Accept": "application/json",
            }
            if service_auth
            else {"Accept": "application/json"}
        )
        if headers:
            request_headers.update(headers)
        try:
            async with httpx.AsyncClient(
                timeout=httpx.Timeout(
                    self._timeout if timeout is None else timeout
                ),
                transport=self._transport,
            ) as client:
                response = await client.request(
                    method,
                    url,
                    headers=request_headers,
                    params=params,
                    json=json,
                )
        except httpx.HTTPError as exc:
            raise SupabaseError(
                "Không kết nối được Supabase", status_code=None
            ) from exc
        if response.status_code >= 400:
            raise self._error_from_response(response)
        return response

    @staticmethod
    def _error_from_response(response: httpx.Response) -> SupabaseError:
        detail = ""
        code: str | None = None
        try:
            body = response.json()
        except ValueError:
            body = None
        if isinstance(body, dict):
            code_value = body.get("code")
            code = str(code_value) if code_value else None
            detail = str(
                body.get("message") or body.get("detail") or body.get("error") or ""
            ).strip()
        if not detail:
            detail = response.reason_phrase or "Lỗi Supabase"
        return SupabaseError(
            f"Supabase {response.status_code}: {detail}",
            status_code=response.status_code,
            code=code,
        )

    def _rest_url(self, path: str) -> str:
        return f"{self._base}/rest/v1/{path.lstrip('/')}"

    async def select(
        self, table: str, params: Mapping[str, str] | None = None
    ) -> list[dict[str, Any]]:
        """All matching rows. Supabase caps a response at 1000 rows, so a read without
        an explicit limit pages with offset/limit until a short page comes back."""
        query = dict(params or {})
        if "limit" in query:
            return await self._select_page(table, query)
        # A stable order keeps offset pages from skipping or repeating rows.
        query.setdefault("order", "id.asc")
        rows: list[dict[str, Any]] = []
        offset = 0
        while True:
            page = await self._select_page(
                table, {**query, "limit": str(SELECT_PAGE_SIZE), "offset": str(offset)}
            )
            rows.extend(page)
            if len(page) < SELECT_PAGE_SIZE or len(rows) >= SELECT_MAX_ROWS:
                return rows[:SELECT_MAX_ROWS]
            offset += SELECT_PAGE_SIZE

    async def _select_page(
        self, table: str, params: Mapping[str, str]
    ) -> list[dict[str, Any]]:
        response = await self._request(
            "GET",
            self._rest_url(table),
            params=dict(params),
        )
        data = response.json()
        if data is None:
            return []
        if not isinstance(data, list):
            raise SupabaseError("PostgREST trả về dữ liệu không phải danh sách")
        return [row for row in data if isinstance(row, dict)]

    async def select_one(
        self, table: str, params: Mapping[str, str] | None = None
    ) -> dict[str, Any] | None:
        rows = await self.select(table, {**dict(params or {}), "limit": "1"})
        return rows[0] if rows else None

    async def insert_staged_change(self, values: dict[str, Any]) -> dict[str, Any]:
        response = await self._request(
            "POST",
            self._rest_url(STAGED_CHANGES_TABLE),
            headers={"Prefer": "return=representation"},
            json=values,
        )
        row = self._first_row(response)
        if row is None:
            raise SupabaseError("Không lưu được thay đổi đã đề xuất")
        return row

    async def update_staged_change(
        self,
        change_id: str,
        values: dict[str, Any],
        *,
        only_statuses: Iterable[str] | None = None,
    ) -> dict[str, Any] | None:
        params: dict[str, str] = {"id": f"eq.{change_id}"}
        statuses = list(only_statuses or [])
        if statuses:
            params["status"] = f"in.({','.join(statuses)})"
        response = await self._request(
            "PATCH",
            self._rest_url(STAGED_CHANGES_TABLE),
            headers={"Prefer": "return=representation"},
            params=params,
            json=values,
        )
        return self._first_row(response)

    async def call_edge_function(
        self,
        name: str,
        payload: dict[str, Any],
        *,
        timeout: float = 15.0,
    ) -> httpx.Response:
        """Call a service-role Edge Function with the service key.

        Used only by the bounded draft guard; the key is never logged or returned.
        """

        return await self._request(
            "POST",
            f"{self._base}/functions/v1/{name.lstrip('/')}",
            headers={"Content-Type": "application/json"},
            json=payload,
            timeout=timeout,
        )

    async def call_edge_function_as_owner(
        self,
        name: str,
        payload: dict[str, Any],
        owner_token: str,
        *,
        timeout: float = 30.0,
    ) -> httpx.Response:
        """Call an Edge Function with the owner's JWT, never the service key.

        Used by the bank-slip flow: payment-unc-approve and cost-classify-sushi
        authenticate the owner themselves, so forwarding the service key would
        bypass that contract and leak the most privileged credential.
        """

        token = str(owner_token or "").strip()
        if not token:
            raise SupabaseError("Thiếu phiên đăng nhập của chủ cửa hàng")
        headers: dict[str, str] = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        }
        # The anon key is the public gateway key. It is optional for functions
        # configured without a gateway apikey and must never fall back to the
        # service role key on this path.
        if self._anon_key and self._anon_key != self._service_key:
            headers["apikey"] = self._anon_key
        response = await self._request(
            "POST",
            f"{self._base}/functions/v1/{name.lstrip('/')}",
            headers=headers,
            json=payload,
            timeout=timeout,
            service_auth=False,
        )
        return response

    async def rpc(self, function: str, payload: dict[str, Any] | None = None) -> Any:
        if function not in ALLOWED_RPCS:
            raise SupabaseError(f"RPC không được phép: {function}")
        response = await self._request(
            "POST",
            self._rest_url(f"rpc/{function}"),
            json=payload or {},
        )
        if not response.content:
            return None
        return response.json()

    async def auth_user(self, access_token: str) -> dict[str, Any]:
        """Resolve a Supabase access token to its auth user."""

        response = await self._request(
            "GET",
            f"{self._base}/auth/v1/user",
            headers={
                "apikey": self._anon_key,
                "Authorization": f"Bearer {access_token}",
            },
        )
        data = response.json()
        if not isinstance(data, dict) or not data.get("id"):
            raise SupabaseError("Supabase Auth trả về người dùng không hợp lệ")
        return data

    @staticmethod
    def _first_row(response: httpx.Response) -> dict[str, Any] | None:
        if not response.content:
            return None
        data = response.json()
        if isinstance(data, dict):
            return data
        if isinstance(data, list) and data and isinstance(data[0], dict):
            return data[0]
        return None
