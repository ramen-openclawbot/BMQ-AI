from __future__ import annotations

import copy
from typing import Any

import httpx
import pytest
from merchant_agent import MerchantSessionContext
from merchant_agent.changes import ChangeNotApplicable

from bmq_merchant.backend import BmqMerchantBackend
from bmq_merchant.config import Settings
from bmq_merchant.supabase import SupabaseClient, SupabaseError

SESSION = MerchantSessionContext(
    session_id="session-bank-slip", merchant_id="bmq", operator="owner@bmq.vn"
)
OWNER_ID = "11111111-1111-4111-8111-111111111111"
OWNER_TOKEN = "owner-jwt-not-real"
SHA = "a" * 64


class FakeResponse:
    def __init__(self, data: dict[str, Any]) -> None:
        self._data = data

    def json(self) -> dict[str, Any]:
        return copy.deepcopy(self._data)


def _matches(row: dict[str, Any], key: str, value: str) -> bool:
    if value.startswith("eq."):
        return str(row.get(key)).lower() == value[3:].lower()
    if value.startswith("neq."):
        return str(row.get(key)) != value[4:]
    if value.startswith("in.(") and value.endswith(")"):
        allowed = {item.strip() for item in value[4:-1].split(",") if item.strip()}
        return str(row.get(key)) in allowed
    if value == "not.is.null":
        return row.get(key) is not None
    return True


# Real columns of public.merchant_staged_changes (20261102180000_merchant_agent.sql).
STAGED_CHANGE_COLUMNS = frozenset({
    "id", "kind", "summary", "payload", "before", "status", "operator",
    "session_id", "created_at", "decided_at", "decided_by", "applied_at", "error",
})


class FakeDB:
    def __init__(
        self,
        *,
        requests: list[dict[str, Any]] | None = None,
        allocations: list[dict[str, Any]] | None = None,
        evidence: list[dict[str, Any]] | None = None,
        suppliers: list[dict[str, Any]] | None = None,
        classifications: list[dict[str, Any]] | None = None,
        categories: list[dict[str, Any]] | None = None,
        drafts: list[dict[str, Any]] | None = None,
        staged: list[dict[str, Any]] | None = None,
    ) -> None:
        self.tables: dict[str, list[dict[str, Any]]] = {
            "payment_requests": copy.deepcopy(requests or []),
            "payment_allocations": copy.deepcopy(allocations or []),
            "payment_unc_evidence": copy.deepcopy(evidence or []),
            "suppliers": copy.deepcopy(suppliers or []),
            "cost_line_classifications": copy.deepcopy(classifications or []),
            "cost_categories": copy.deepcopy(categories or []),
            "payment_unc_ocr_drafts": copy.deepcopy(drafts or []),
            "payment_request_items": [],
        }
        self.staged: list[dict[str, Any]] = copy.deepcopy(staged or [])
        self.inserted: list[dict[str, Any]] = []
        self.calls: list[tuple[str, str, Any]] = []
        self.extract_response: dict[str, Any] | None = None
        self.suggest_response: dict[str, Any] | None = None
        self.confirm_errors: list[Exception] = []

    # -- PostgREST-like reads ------------------------------------------------
    async def select(
        self, table: str, params: dict[str, str] | None = None
    ) -> list[dict[str, Any]]:
        params = dict(params or {})
        source = self.staged if table == "merchant_staged_changes" else self.tables.get(table, [])
        rows = copy.deepcopy(source)
        for key, value in params.items():
            if key in {"select", "order", "limit", "offset"}:
                continue
            rows = [row for row in rows if _matches(row, key, value)]
        order = params.get("order")
        if order:
            for part in reversed([item.strip() for item in order.split(",") if item.strip()]):
                field, _, direction = part.partition(".")
                rows.sort(
                    key=lambda row: str(row.get(field) or ""),
                    reverse=direction == "desc",
                )
        limit = params.get("limit")
        if limit:
            rows = rows[: int(limit)]
        return rows

    async def select_one(
        self, table: str, params: dict[str, str] | None = None
    ) -> dict[str, Any] | None:
        rows = await self.select(table, {**(params or {}), "limit": "1"})
        return rows[0] if rows else None

    # -- staged-change writes -------------------------------------------------
    async def insert_staged_change(self, values: dict[str, Any]) -> dict[str, Any]:
        row = {
            **copy.deepcopy(values),
            "id": f"change-{len(self.inserted) + 1}",
            "created_at": "2026-10-20T03:00:00+00:00",
            "decided_by": None,
            "applied_at": None,
            "error": None,
        }
        self.inserted.append(row)
        self.staged.append(copy.deepcopy(row))
        return copy.deepcopy(row)

    async def update_staged_change(
        self,
        change_id: str,
        values: dict[str, Any],
        *,
        only_statuses: list[str] | None = None,
    ) -> dict[str, Any] | None:
        # PostgREST rejects a PATCH naming a column the table does not have.
        unknown = set(values) - STAGED_CHANGE_COLUMNS
        if unknown:
            raise SupabaseError(
                f"Supabase 400: unknown column {sorted(unknown)}",
                status_code=400,
                code="PGRST204",
            )
        for row in self.staged:
            if str(row.get("id")) != change_id:
                continue
            if only_statuses and str(row.get("status")) not in only_statuses:
                return None
            row.update(copy.deepcopy(values))
            return copy.deepcopy(row)
        return None

    # -- RPC ------------------------------------------------------------------
    async def rpc(self, function: str, payload: dict[str, Any] | None = None) -> Any:
        payload = dict(payload or {})
        self.calls.append(("rpc", function, payload))
        change = self._change(str(payload.get("p_change_id") or ""))
        if function == "merchant_prepare_bank_slip_request":
            values = change["payload"]
            prior = values.get("prepared_request_id")
            if prior:
                request = self._request(str(prior))
                return {
                    "request_id": prior,
                    "request_number": request.get("request_number"),
                    "created": False,
                }
            target = values["target"]
            if target["mode"] == "pay_existing":
                request = self._request(str(target["request_id"]))
                values["prepared_request_id"] = request["id"]
                return {
                    "request_id": request["id"],
                    "request_number": request["request_number"],
                    "created": False,
                }
            request_id = "req-created"
            request_number = "PR-ABCD1234"
            self.tables["payment_requests"].append(
                {
                    "id": request_id,
                    "request_number": request_number,
                    "title": target["title"],
                    "supplier_id": values["supplier"]["id"],
                    "total_amount": target["amount"],
                    "status": "pending",
                    "payment_status": "unpaid",
                    "paid_at": None,
                    "created_at": "2026-10-15T05:00:00+00:00",
                }
            )
            self.tables["payment_request_items"].append(
                {
                    "id": "item-created",
                    "payment_request_id": request_id,
                    "product_name": target["line_name"],
                    "quantity": 1,
                    "unit_price": target["amount"],
                    "line_total": target["amount"],
                }
            )
            values["prepared_request_id"] = request_id
            return {
                "request_id": request_id,
                "request_number": request_number,
                "created": True,
            }
        if function == "merchant_finalize_bank_slip_payment":
            change["status"] = "applied"
            change["applied_at"] = "2026-10-20T04:00:00+00:00"
            change["error"] = None
            prepared = change["payload"].get("prepared_request_id") or change["payload"][
                "target"
            ].get("request_id")
            request = self._request(str(prepared))
            return {
                "change_id": change["id"],
                "status": "applied",
                "classification": "applied",
                "request_id": request["id"],
                "request_number": request["request_number"],
            }
        raise AssertionError(f"unexpected RPC {function}")

    # -- Edge calls -----------------------------------------------------------
    async def call_edge_function_as_owner(
        self,
        name: str,
        payload: dict[str, Any],
        owner_token: str,
        *,
        timeout: float = 30.0,
    ) -> FakeResponse:
        self.calls.append(("edge", name, {**payload, "_owner_token": owner_token}))
        if name == "payment-unc-approve" and payload.get("mode") == "extract":
            return FakeResponse(
                self.extract_response
                or {
                    "success": True,
                    "file_sha256": SHA,
                    "storage_path": "payment-unc/2026/10/slip.jpg",
                    "ocr": {
                        "amount": 20_000_000,
                        "reference": "FT-2026-001",
                        "transfer_date": "2026-10-15",
                        "beneficiary_name": "LAI DINH TUAN",
                        "transfer_content": "THUE KHO BINH TAN T10",
                        "confidence": 0.96,
                    },
                }
            )
        if name == "payment-unc-approve" and payload.get("mode") == "confirm":
            if self.confirm_errors:
                raise self.confirm_errors.pop(0)
            request = self._request(str(payload["request_ids"][0]))
            request["status"] = "approved"
            request["payment_status"] = "paid"
            request["paid_at"] = "2026-10-15T05:00:00+00:00"
            return FakeResponse({"success": True, "mode": "confirm", "result": {}})
        if name == "cost-classify-sushi":
            return FakeResponse(
                self.suggest_response
                or {
                    "category_code": "C1_WAREHOUSE_RENT",
                    "label": "Thuê kho, bếp",
                    "probability": 0.91,
                    "product_line": "shared",
                }
            )
        raise AssertionError(f"unexpected edge call {name}")

    # -- test helpers ---------------------------------------------------------
    def _change(self, change_id: str) -> dict[str, Any]:
        for row in self.staged:
            if str(row.get("id")) == change_id:
                return row
        raise AssertionError(f"change {change_id} not found")

    def _request(self, request_id: str) -> dict[str, Any]:
        for row in self.tables["payment_requests"]:
            if str(row.get("id")) == request_id:
                return row
        raise AssertionError(f"request {request_id} not found")


def _categories() -> list[dict[str, Any]]:
    return [
        {"code": "C1_WAREHOUSE_RENT", "label": "Thuê kho, bếp", "is_active": True, "sort_order": 10},
        {"code": "C2_UTILITIES", "label": "Điện nước", "is_active": True, "sort_order": 20},
        {"code": "OPEX_GENERAL", "label": "Chi phí chung", "is_active": True, "sort_order": 30},
    ]


def _suppliers() -> list[dict[str, Any]]:
    return [{"id": "sup-1", "name": "Lại Đình Tuấn (thuê kho Bình Tân)"}]


def _requests() -> list[dict[str, Any]]:
    return [
        {
            "id": "req-pending",
            "request_number": "PR-PENDING1",
            "title": "Thuê kho Bình Tân tháng 10",
            "supplier_id": "sup-1",
            "total_amount": 20_000_000,
            "status": "pending",
            "payment_status": "unpaid",
            "paid_at": None,
            "created_at": "2026-10-01T03:00:00+00:00",
        },
        {
            "id": "req-history",
            "request_number": "PR-HISTORY1",
            "title": "Thuê kho Bình Tân tháng 9",
            "supplier_id": "sup-1",
            "total_amount": 20_000_000,
            "status": "approved",
            "payment_status": "paid",
            "paid_at": "2026-09-10T03:00:00+00:00",
            "created_at": "2026-09-01T03:00:00+00:00",
        },
    ]


def _classifications() -> list[dict[str, Any]]:
    return [
        {
            "payment_request_id": "req-history",
            "category_code": "C1_WAREHOUSE_RENT",
            "review_status": "approved",
            "confidence": 0.9,
            "updated_at": "2026-09-10T04:00:00+00:00",
        },
        {
            "payment_request_id": "req-history",
            "category_code": "C2_UTILITIES",
            "review_status": "suggested",
            "confidence": 0.8,
            "updated_at": "2026-09-10T05:00:00+00:00",
        },
    ]


def _drafts() -> list[dict[str, Any]]:
    return [
        {
            "file_sha256": SHA,
            "storage_path": "payment-unc/2026/10/slip.jpg",
            "ocr_amount": 20_000_000,
            "ocr_reference": "FT-2026-001",
            "ocr_beneficiary_account": "123456789",
            "ocr_confidence": 0.96,
            "transfer_date": "2026-10-15",
        }
    ]


def _db(**overrides: Any) -> FakeDB:
    data: dict[str, Any] = {
        "requests": _requests(),
        "suppliers": _suppliers(),
        "classifications": _classifications(),
        "categories": _categories(),
        "drafts": _drafts(),
    }
    data.update(overrides)
    return FakeDB(**data)


def _backend(db: FakeDB, settings: Settings) -> BmqMerchantBackend:
    return BmqMerchantBackend(db, settings.merchant_config())  # type: ignore[arg-type]


async def _intake(backend: BmqMerchantBackend) -> dict[str, Any]:
    return await backend.intake_bank_slip(
        SESSION,
        owner_token=OWNER_TOKEN,
        image_base64="aGVsbG8=",
        mime_type="image/png",
    )


def _payload(result: dict[str, Any]) -> dict[str, Any]:
    return result["ui"][0]["payload"]


def _approve(backend: BmqMerchantBackend, change_id: str, category: str | None = None) -> Any:
    return backend.approve_change(change_id, OWNER_ID, category_code=category)


async def test_existing_pending_request_proposes_pay_existing_with_history_category(
    settings: Settings,
) -> None:
    db = _db()
    backend = _backend(db, settings)

    result = await _intake(backend)

    assert len(db.inserted) == 1, "intake stages exactly one change"
    assert len(db.tables["payment_requests"]) == 2, "intake must not create a request"
    payload = _payload(result)
    assert payload["status"] == "staged"
    assert payload["target"]["mode"] == "pay_existing"
    assert payload["target"]["request_id"] == "req-pending"
    assert payload["target"]["request_number"] == "PR-PENDING1"
    assert payload["target"]["amount"] == 20_000_000
    assert payload["supplier"] == {
        "id": "sup-1",
        "name": "Lại Đình Tuấn (thuê kho Bình Tân)",
    }
    assert payload["category"]["code"] == "C1_WAREHOUSE_RENT"
    assert payload["category"]["label"] == "Thuê kho, bếp"
    assert payload["category"]["source"] == "history"
    assert payload["category"]["evidence"]["request_numbers"] == ["PR-HISTORY1"]
    assert payload["previous"]["request_number"] == "PR-HISTORY1"
    assert payload["categories"][0] == {
        "code": "C1_WAREHOUSE_RENT",
        "label": "Thuê kho, bếp",
    }
    assert not any(
        call[0] == "edge" and call[1] == "cost-classify-sushi" for call in db.calls
    ), "history must win over Jev"


async def test_create_new_path_and_jev_is_used_only_without_history(
    settings: Settings,
) -> None:
    db = _db(
        requests=[
            {
                "id": "req-history",
                "request_number": "PR-HISTORY1",
                "title": "Kỳ trước",
                "supplier_id": "sup-1",
                "total_amount": 16_000_000,
                "status": "approved",
                "payment_status": "paid",
                "paid_at": "2026-09-10T03:00:00+00:00",
                "created_at": "2026-09-01T03:00:00+00:00",
            }
        ],
        classifications=[],
    )
    backend = _backend(db, settings)

    result = await _intake(backend)

    payload = _payload(result)
    assert payload["target"]["mode"] == "create_new"
    assert payload["target"]["title"].endswith("(bankslip 15/10)")
    assert payload["target"]["line_name"] == "THUE KHO BINH TAN T10"
    assert payload["category"]["code"] == "C1_WAREHOUSE_RENT"
    assert payload["category"]["source"] == "jev"
    assert len(db.tables["payment_requests"]) == 1, "intake still writes no request"
    assert any(
        call[0] == "edge" and call[1] == "cost-classify-sushi" for call in db.calls
    )


async def test_duplicate_slip_stages_nothing(settings: Settings) -> None:
    db = _db(
        evidence=[
            {
                "id": "ev-1",
                "payment_id": "pay-1",
                "file_sha256": SHA,
                "ocr_reference": "FT-2026-001",
                "ocr_beneficiary_account": "123456789",
                "transfer_date": "2026-10-15",
                "created_at": "2026-10-15T04:00:00+00:00",
            }
        ],
        allocations=[
            {"payment_id": "pay-1", "payment_request_id": "req-history", "amount": 20_000_000}
        ],
    )
    backend = _backend(db, settings)

    result = await _intake(backend)

    assert db.inserted == []
    ui = result["ui"][0]
    assert ui["component"] == "bank_slip_payment"
    assert ui["payload"]["status"] == "already_recorded"
    assert ui["payload"]["request_number"] == "PR-HISTORY1"
    assert ui["payload"]["doc_link"]["path"] == "/payment-requests?id=req-history"


async def test_duplicate_reference_stages_nothing(settings: Settings) -> None:
    db = _db(
        evidence=[
            {
                "id": "ev-1",
                "payment_id": None,
                "file_sha256": "other-sha",
                "ocr_reference": "FT 2026 001",
                "ocr_beneficiary_account": "123456789",
                "transfer_date": "2026-10-15",
                "created_at": "2026-10-15T04:00:00+00:00",
            }
        ]
    )
    backend = _backend(db, settings)

    result = await _intake(backend)

    assert db.inserted == []
    assert result["ui"][0]["payload"]["status"] == "already_recorded"


async def test_unknown_payee_stages_nothing(settings: Settings) -> None:
    db = _db(suppliers=[{"id": "sup-other", "name": "Nhà cung cấp khác"}], drafts=[])
    backend = _backend(db, settings)

    result = await _intake(backend)

    assert db.inserted == []
    assert result["ui"] == []
    assert "Duyệt chi" in result["text"]


async def test_unreadable_slip_returns_guidance_and_stages_nothing(
    settings: Settings,
) -> None:
    db = _db(drafts=[])
    db.extract_response = {
        "success": True,
        "file_sha256": SHA,
        "storage_path": "payment-unc/2026/10/slip.jpg",
        "ocr": {
            "amount": None,
            "reference": None,
            "transfer_date": None,
            "beneficiary_name": None,
            "transfer_content": None,
            "confidence": None,
        },
    }
    backend = _backend(db, settings)

    result = await _intake(backend)

    assert db.inserted == []
    assert result["ui"] == []
    assert "Chưa đọc được số tiền" in result["text"]
    assert "BMQ Agent" in result["text"]
    assert "VNAgent" not in result["text"]


async def test_extract_failure_returns_guidance_and_stages_nothing(
    settings: Settings,
) -> None:
    db = _db()
    db.extract_response = {"success": False, "code": "ocr_failed"}
    backend = _backend(db, settings)

    result = await _intake(backend)

    assert db.inserted == []
    assert result["ui"] == []
    assert "Không đọc được ảnh bankslip" in result["text"]


async def test_amount_differs_and_already_paid_in_transfer_month_warnings(
    settings: Settings,
) -> None:
    db = _db(
        requests=[
            {
                "id": "req-pending",
                "request_number": "PR-PENDING1",
                "title": "Thuê kho Bình Tân tháng 10",
                "supplier_id": "sup-1",
                "total_amount": 15_000_000,
                "status": "pending",
                "payment_status": "unpaid",
                "paid_at": None,
                "created_at": "2026-10-01T03:00:00+00:00",
            },
            {
                "id": "req-paid-month",
                "request_number": "PR-PAID-MONTH",
                "title": "Điện nước tháng 10",
                "supplier_id": "sup-1",
                "total_amount": 2_000_000,
                "status": "approved",
                "payment_status": "paid",
                "paid_at": "2026-10-05T03:00:00+00:00",
                "created_at": "2026-10-02T03:00:00+00:00",
            },
        ],
        classifications=[],
    )
    backend = _backend(db, settings)

    result = await _intake(backend)

    payload = _payload(result)
    assert payload["target"]["mode"] == "create_new"
    assert "amount_differs" in payload["warnings"]
    assert "already_paid_in_transfer_month" in payload["warnings"]


async def test_approve_order_prepare_confirm_finalize_with_owner_token(
    settings: Settings,
) -> None:
    db = _db()
    backend = _backend(db, settings)
    staged = await _intake(backend)
    change_id = staged["ui"][0]["payload"]["change_id"]

    await _approve(backend, change_id)
    result = await backend.apply_bank_slip_change(
        SESSION, change_id, category_code=None, owner_token=OWNER_TOKEN
    )

    relevant = [
        (kind, name)
        for kind, name, payload in db.calls
        if name in {
            "merchant_prepare_bank_slip_request",
            "payment-unc-approve",
            "merchant_finalize_bank_slip_payment",
        }
        and not (kind == "edge" and payload.get("mode") == "extract")
    ]
    assert relevant == [
        ("rpc", "merchant_prepare_bank_slip_request"),
        ("edge", "payment-unc-approve"),
        ("rpc", "merchant_finalize_bank_slip_payment"),
    ]
    confirm = next(
        call[2]
        for call in db.calls
        if call[0] == "edge" and call[1] == "payment-unc-approve" and call[2].get("mode") == "confirm"
    )
    assert confirm["_owner_token"] == OWNER_TOKEN
    assert confirm["idempotency_key"] == f"unc:{SHA}"
    assert confirm["request_ids"] == ["req-pending"]
    assert confirm["payment_method"] == "bank_transfer"
    assert confirm["note"] == "Bankslip FT-2026-001 — duyệt từ chatbox"
    assert result["status"] == "applied"
    assert result["request_number"] == "PR-PENDING1"
    assert result["doc_link"]["path"] == "/payment-requests?id=req-pending"
    assert db._request("req-pending")["payment_status"] == "paid"
    assert db._request("req-pending")["status"] == "approved"


async def test_confirm_failure_marks_failed_and_retry_reuses_prepared_request(
    settings: Settings,
) -> None:
    db = _db()
    backend = _backend(db, settings)
    staged = await _intake(backend)
    change_id = staged["ui"][0]["payload"]["change_id"]
    await _approve(backend, change_id)

    db.confirm_errors.append(
        SupabaseError("Supabase 409: not_pending", status_code=409, code="not_pending")
    )
    with pytest.raises(ChangeNotApplicable, match="chờ thanh toán"):
        await backend.apply_bank_slip_change(
            SESSION, change_id, category_code=None, owner_token=OWNER_TOKEN
        )

    failed = db._change(change_id)
    assert failed["status"] == "failed"
    assert "chờ thanh toán" in failed["error"]
    prepared_id = failed["payload"]["prepared_request_id"]
    assert prepared_id == "req-pending"
    assert len(db.tables["payment_requests"]) == 2

    # Retry: re-approve the failed change and apply again.
    await _approve(backend, change_id)
    result = await backend.apply_bank_slip_change(
        SESSION, change_id, category_code=None, owner_token=OWNER_TOKEN
    )

    prepare_calls = [
        call for call in db.calls
        if call[0] == "rpc" and call[1] == "merchant_prepare_bank_slip_request"
    ]
    confirm_calls = [
        call for call in db.calls
        if call[0] == "edge" and call[1] == "payment-unc-approve" and call[2].get("mode") == "confirm"
    ]
    assert len(prepare_calls) == 2
    assert len(confirm_calls) == 2
    assert confirm_calls[0][2]["idempotency_key"] == confirm_calls[1][2]["idempotency_key"]
    assert confirm_calls[0][2]["request_ids"] == confirm_calls[1][2]["request_ids"]
    assert result["status"] == "applied"
    assert len(db.tables["payment_requests"]) == 2, "retry must reuse the same request"


async def test_invalid_or_inactive_category_override_is_rejected(
    settings: Settings,
) -> None:
    db = _db()
    backend = _backend(db, settings)
    staged = await _intake(backend)
    change_id = staged["ui"][0]["payload"]["change_id"]

    with pytest.raises(ValueError, match="không còn hiệu lực"):
        await _approve(backend, change_id, "C_UNKNOWN")
    assert db._change(change_id)["status"] == "staged"

    db.tables["cost_categories"].append(
        {"code": "C_INACTIVE", "label": "Đã tắt", "is_active": False, "sort_order": 40}
    )
    with pytest.raises(ValueError, match="không còn hiệu lực"):
        await _approve(backend, change_id, "C_INACTIVE")
    assert db._change(change_id)["status"] == "staged"


async def test_owner_edge_call_never_sends_the_service_key(settings: Settings) -> None:
    captured: dict[str, Any] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["headers"] = dict(request.headers)
        return httpx.Response(200, json={"ok": True})

    client = SupabaseClient(
        supabase_url=settings.supabase_url,
        service_role_key=settings.service_role_key,
        anon_key=settings.anon_key,
        transport=httpx.MockTransport(handler),
    )
    await client.call_edge_function_as_owner("payment-unc-approve", {"x": 1}, OWNER_TOKEN)

    headers = captured["headers"]
    assert headers["authorization"] == f"Bearer {OWNER_TOKEN}"
    assert headers["apikey"] == settings.anon_key
    assert settings.service_role_key not in " ".join(headers.values())
