"""Bank-slip intake and approval helpers for the BMQ merchant agent.

The only live write this module performs before the owner approves is inserting
one row in ``merchant_staged_changes``.  Approval goes through the existing
payment-unc-approve confirm path (owner token, never the service key), so the
payment, allocations and UNC evidence are written by the established RPC.

Pure matching helpers are kept at the top so they can be tested without a
database or network.
"""

from __future__ import annotations

import logging
import re
import unicodedata
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any
from zoneinfo import ZoneInfo

from merchant_agent.changes import ChangeNotApplicable

from .supabase import SupabaseError

VN_TZ = ZoneInfo("Asia/Ho_Chi_Minh")
_LOG = logging.getLogger("bmq_merchant.bank_slip")

EXCLUDED_CATEGORY_CODES = frozenset({"OPEX_GENERAL", "UNMAPPED_REVIEW"})
LOW_CONFIDENCE = 0.8

# Ported verbatim from apps/web/src/lib/payment-unc-bulk-match.ts (do not edit
# that file); longest prefix first.
COMPANY_PREFIXES = sorted(
    [
        "cong ty tnhh mtv",
        "cong ty tnhh",
        "cong ty co phan",
        "cong ty cp",
        "cong ty",
        "cty tnhh",
        "cty",
        "tnhh mtv",
        "tnhh",
        "ctcp",
        "co phan",
        "doanh nghiep",
        "tap doan",
        "cp",
        "dn",
    ],
    key=len,
    reverse=True,
)


class BankSlipError(RuntimeError):
    """A bank-slip edge call failed with a known code."""

    def __init__(self, code: str, message: str, status: int = 502) -> None:
        super().__init__(message)
        self.code = code
        self.status = status


# ---------------------------------------------------------------------------
# Pure matching helpers
# ---------------------------------------------------------------------------

def fold_unc_text(value: Any) -> str:
    text = unicodedata.normalize("NFD", str(value or ""))
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    text = text.replace("đ", "d").replace("Đ", "D").lower()
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def normalize_company_name(value: Any) -> str:
    text = fold_unc_text(value)
    changed = True
    while changed and text:
        changed = False
        for prefix in COMPANY_PREFIXES:
            if text == prefix:
                text = ""
                changed = True
                break
            if text.startswith(prefix + " "):
                text = text[len(prefix) + 1 :].strip()
                changed = True
                break
    return text


def names_match(left: Any, right: Any) -> bool:
    a = normalize_company_name(left)
    b = normalize_company_name(right)
    if not a or not b:
        return False
    if a == b:
        return True
    return len(a) >= 4 and len(b) >= 4 and (a in b or b in a)


def normalize_unc_reference(value: Any) -> str:
    """Same normalization as public.normalize_unc_reference."""

    text = re.sub(r"[^a-zA-Z0-9]", "", str(value or "").strip()).upper()
    return text


def normalize_account(value: Any) -> str:
    return normalize_unc_reference(value)


def amounts_equal(left: Any, right: Any) -> bool:
    try:
        return round(float(left)) == round(float(right))
    except (TypeError, ValueError):
        return False


def _number(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if number == number and number not in (float("inf"), float("-inf")) else None


def _decimal(value: Any) -> Decimal:
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return Decimal("0")


def format_vnd(value: Any) -> str:
    amount = _number(value) or 0
    return f"{amount:,.0f}".replace(",", ".") + " đ"


def today_vn() -> date:
    return datetime.now(VN_TZ).date()


def _date_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    if not text:
        return None
    return text[:10]


def _short_content(value: Any, limit: int = 120) -> str:
    text = " ".join(str(value or "").split())
    return text[:limit].strip()


def _ddmm(value: Any) -> str:
    text = _date_text(value)
    if text:
        parts = text.split("-")
        if len(parts) == 3:
            return f"{parts[2]}/{parts[1]}"
    today = today_vn()
    return f"{today.day:02d}/{today.month:02d}"


def _month_of(value: Any) -> str | None:
    text = _date_text(value)
    return text[:7] if text and len(text) >= 7 else None


# ---------------------------------------------------------------------------
# Small read helpers over the existing service-role client
# ---------------------------------------------------------------------------

async def _select(db: Any, table: str, params: dict[str, str]) -> list[dict[str, Any]]:
    rows = await db.select(table, params)
    return [row for row in rows if isinstance(row, dict)]


def _ids(values: list[Any]) -> list[str]:
    return list(dict.fromkeys(str(v) for v in values if v))


async def _allocations_by_payment(
    db: Any, payment_ids: list[str]
) -> dict[str, list[dict[str, Any]]]:
    grouped: dict[str, list[dict[str, Any]]] = {}
    for chunk in _chunks(payment_ids):
        rows = await _select(
            db,
            "payment_allocations",
            {
                "select": "payment_id,payment_request_id,amount",
                "payment_id": f"in.({','.join(chunk)})",
            },
        )
        for row in rows:
            grouped.setdefault(str(row.get("payment_id") or ""), []).append(row)
    return grouped


async def _requests_by_ids(
    db: Any, request_ids: list[str]
) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for chunk in _chunks(request_ids):
        rows = await _select(
            db,
            "payment_requests",
            {
                "select": (
                    "id,request_number,title,supplier_id,total_amount,status,"
                    "payment_status,paid_at,created_at"
                ),
                "id": f"in.({','.join(chunk)})",
            },
        )
        for row in rows:
            result[str(row.get("id") or "")] = row
    return result


async def _suppliers_by_ids(
    db: Any, supplier_ids: list[str]
) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    for chunk in _chunks(supplier_ids):
        rows = await _select(
            db,
            "suppliers",
            {"select": "id,name", "id": f"in.({','.join(chunk)})"},
        )
        for row in rows:
            result[str(row.get("id") or "")] = row
    return result


def _chunks(values: list[str], size: int = 100) -> list[list[str]]:
    unique = _ids(values)
    return [unique[i : i + size] for i in range(0, len(unique), size)]


async def _requests_for_evidence(
    db: Any, evidence_rows: list[dict[str, Any]]
) -> dict[str, dict[str, Any]]:
    """Map payment id -> first payment request touched by that payment."""

    payment_ids = _ids([row.get("payment_id") for row in evidence_rows])
    if not payment_ids:
        return {}
    allocations = await _allocations_by_payment(db, payment_ids)
    request_ids = _ids(
        [
            allocation.get("payment_request_id")
            for rows in allocations.values()
            for allocation in rows
        ]
    )
    requests = await _requests_by_ids(db, request_ids)
    by_payment: dict[str, dict[str, Any]] = {}
    for payment_id, rows in allocations.items():
        for allocation in rows:
            request = requests.get(str(allocation.get("payment_request_id") or ""))
            if request is not None:
                by_payment[payment_id] = request
                break
    return by_payment


async def _remaining_by_request(
    db: Any, request_ids: list[str]
) -> dict[str, Decimal]:
    if not request_ids:
        return {}
    rows = await _select(
        db,
        "payment_allocations",
        {
            "select": "payment_request_id,amount",
            "payment_request_id": f"in.({','.join(_ids(request_ids))})",
        },
    )
    totals: dict[str, Decimal] = {}
    for row in rows:
        key = str(row.get("payment_request_id") or "")
        totals[key] = totals.get(key, Decimal("0")) + _decimal(row.get("amount"))
    return totals


async def _active_categories(db: Any) -> tuple[list[dict[str, str]], dict[str, str]]:
    rows = await _select(
        db,
        "cost_categories",
        {
            "select": "code,label",
            "is_active": "eq.true",
            "order": "sort_order.asc",
        },
    )
    categories: list[dict[str, str]] = []
    labels: dict[str, str] = {}
    for row in rows:
        code = str(row.get("code") or "").strip()
        label = str(row.get("label") or "").strip()
        if not code or not label:
            continue
        categories.append({"code": code, "label": label})
        labels[code] = label
    return categories, labels


async def _supplier_from_history(
    db: Any,
    evidence_rows: list[dict[str, Any]],
    supplier_names: dict[str, str],
    account: str,
) -> dict[str, Any] | None:
    if not account:
        return None
    matching = [
        row
        for row in evidence_rows
        if row.get("payment_id")
        and normalize_account(row.get("ocr_beneficiary_account")) == account
    ]
    if not matching:
        return None
    by_payment = await _requests_for_evidence(db, matching)
    for evidence in matching:
        request = by_payment.get(str(evidence.get("payment_id") or ""))
        if request is None:
            continue
        supplier_id = str(request.get("supplier_id") or "")
        if supplier_id:
            return {
                "id": supplier_id,
                "name": supplier_names.get(supplier_id, ""),
            }
    return None


async def _supplier_by_name(db: Any, name: str) -> dict[str, Any] | None:
    if not name:
        return None
    rows = await _select(db, "suppliers", {"select": "id,name"})
    for row in rows:
        if names_match(row.get("name"), name):
            return {"id": str(row.get("id") or ""), "name": str(row.get("name") or "")}
    return None


async def _pending_requests(
    db: Any, supplier_id: str
) -> list[dict[str, Any]]:
    rows = await _select(
        db,
        "payment_requests",
        {
            "select": (
                "id,request_number,title,supplier_id,total_amount,status,"
                "payment_status,paid_at,created_at"
            ),
            "supplier_id": f"eq.{supplier_id}",
            "status": "eq.pending",
            "payment_status": "eq.unpaid",
            "order": "created_at.asc",
        },
    )
    remaining = await _remaining_by_request(db, [str(row.get("id") or "") for row in rows])
    for row in rows:
        request_id = str(row.get("id") or "")
        row["remaining"] = _decimal(row.get("total_amount")) - remaining.get(
            request_id, Decimal("0")
        )
    return rows


async def _paid_requests(db: Any, supplier_id: str) -> list[dict[str, Any]]:
    return await _select(
        db,
        "payment_requests",
        {
            "select": (
                "id,request_number,title,supplier_id,total_amount,status,"
                "payment_status,paid_at,created_at"
            ),
            "supplier_id": f"eq.{supplier_id}",
            "payment_status": "eq.paid",
            "order": "paid_at.desc",
        },
    )


async def _last_requests(
    db: Any, supplier_id: str, limit: int = 6
) -> list[dict[str, Any]]:
    return await _select(
        db,
        "payment_requests",
        {
            "select": (
                "id,request_number,title,supplier_id,total_amount,status,"
                "payment_status,paid_at,created_at"
            ),
            "supplier_id": f"eq.{supplier_id}",
            "order": "created_at.desc",
            "limit": str(limit),
        },
    )


async def _classifications_for_requests(
    db: Any, request_ids: list[str]
) -> list[dict[str, Any]]:
    if not request_ids:
        return []
    return await _select(
        db,
        "cost_line_classifications",
        {
            "select": (
                "payment_request_id,category_code,review_status,confidence,"
                "updated_at,classification_source"
            ),
            "payment_request_id": f"in.({','.join(_ids(request_ids))})",
            "order": "updated_at.desc",
        },
    )


async def _history_category(
    db: Any,
    supplier_id: str,
    category_labels: dict[str, str],
) -> dict[str, Any] | None:
    requests = await _last_requests(db, supplier_id, 6)
    request_numbers = {
        str(row.get("id") or ""): str(row.get("request_number") or "")
        for row in requests
    }
    if not request_numbers:
        return None
    rows = await _classifications_for_requests(db, list(request_numbers))
    usable: list[dict[str, Any]] = []
    for row in rows:
        code = str(row.get("category_code") or "")
        status = str(row.get("review_status") or "")
        if (
            not code
            or code in EXCLUDED_CATEGORY_CODES
            or code not in category_labels
            or status not in {"approved", "suggested"}
        ):
            continue
        usable.append(row)
    if not usable:
        return None

    # Approved wins over suggested; within the same preference the most recent
    # request (the order returned by _last_requests) wins, then updated_at.
    order = {request_id: index for index, request_id in enumerate(request_numbers)}
    for preferred in ("approved", "suggested"):
        pool = [row for row in usable if row.get("review_status") == preferred]
        if not pool:
            continue
        pool.sort(
            key=lambda row: (
                order.get(str(row.get("payment_request_id") or ""), 999),
                str(row.get("updated_at") or ""),
            )
        )
        # For the same request, keep the newest classification.
        first_request = str(pool[0].get("payment_request_id") or "")
        same_request = [
            row for row in pool
            if str(row.get("payment_request_id") or "") == first_request
        ]
        same_request.sort(key=lambda row: str(row.get("updated_at") or ""), reverse=True)
        chosen = same_request[0]
        code = str(chosen.get("category_code") or "")
        return {
            "code": code,
            "label": category_labels.get(code, code),
            "source": "history",
            "evidence": {
                "request_numbers": [request_numbers.get(first_request, "")],
            },
        }
    return None


async def _suggest_category(
    db: Any,
    owner_token: str,
    supplier_name: str,
    description: str,
    amount: float | None,
    category_labels: dict[str, str],
) -> dict[str, Any] | None:
    payload: dict[str, Any] = {
        "mode": "suggest",
        "supplier_name": supplier_name,
        "description": description,
    }
    if amount is not None:
        payload["amount"] = amount
    try:
        response = await db.call_edge_function_as_owner(
            "cost-classify-sushi", payload, owner_token, timeout=30.0
        )
        data = response.json()
    except Exception as exc:  # Jev is best effort; the card shows needs_category
        _LOG.warning("Jev suggest failed (%s)", type(exc).__name__)
        return None
    if not isinstance(data, dict):
        return None
    code = str(data.get("category_code") or "").strip()
    if not code or code not in category_labels:
        return None
    return {
        "code": code,
        "label": str(data.get("label") or category_labels.get(code) or code),
        "source": "jev",
        "evidence": {
            "probability": data.get("probability"),
            "product_line": data.get("product_line"),
        },
    }


# ---------------------------------------------------------------------------
# Intake
# ---------------------------------------------------------------------------

def _reply(text: str, ui: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {
        "text": text,
        "ui": ui or [],
        "tool_calls": ["bank_slip_intake"],
    }


def _change_ui(row: dict[str, Any]) -> dict[str, Any]:
    payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
    return {
        "component": "bank_slip_payment",
        "payload": {
            "change_id": str(row.get("id") or ""),
            "status": str(row.get("status") or "staged"),
            **payload,
        },
    }


def _doc_link(request_id: Any, request_number: Any, amount: Any = None) -> dict[str, Any] | None:
    request_id_text = str(request_id or "")
    request_number_text = str(request_number or "")
    if not request_id_text or not request_number_text:
        return None
    title = " · ".join(
        part for part in (request_number_text, format_vnd(amount) if amount is not None else "") if part
    )
    return {
        "kind": "pr",
        "code": request_number_text,
        "id": request_id_text,
        "title": title,
        "path": f"/payment-requests?id={request_id_text}",
    }


async def _evidence_rows(db: Any) -> list[dict[str, Any]]:
    return await _select(
        db,
        "payment_unc_evidence",
        {
            "select": (
                "id,payment_id,file_sha256,ocr_reference,ocr_beneficiary_account,"
                "transfer_date,created_at"
            ),
            "order": "created_at.desc",
        },
    )


async def _duplicate_evidence(
    db: Any,
    evidence_rows: list[dict[str, Any]],
    file_sha256: str,
    reference: Any,
) -> dict[str, Any] | None:
    normalized_reference = normalize_unc_reference(reference)
    match = None
    for row in evidence_rows:
        if file_sha256 and str(row.get("file_sha256") or "") == file_sha256:
            match = row
            break
        if (
            normalized_reference
            and normalize_unc_reference(row.get("ocr_reference")) == normalized_reference
        ):
            match = row
            break
    if match is None:
        return None

    request = None
    if match.get("payment_id"):
        by_payment = await _requests_for_evidence(db, [match])
        request = by_payment.get(str(match.get("payment_id") or ""))
    request_number = str((request or {}).get("request_number") or "")
    request_id = str((request or {}).get("id") or "")
    return {
        "text": (
            f"Bankslip này đã được ghi nhận trước đó"
            + (f" ở phiếu {request_number}." if request_number else ".")
        ),
        "ui": [
            {
                "component": "bank_slip_payment",
                "payload": {
                    "status": "already_recorded",
                    "request_number": request_number or None,
                    "doc_link": _doc_link(
                        request_id,
                        request_number,
                        (request or {}).get("total_amount"),
                    ),
                },
            }
        ],
        "tool_calls": ["bank_slip_intake"],
    }


async def _staged_duplicate(
    db: Any, file_sha256: str
) -> dict[str, Any] | None:
    rows = await _select(
        db,
        "merchant_staged_changes",
        {
            "select": "*",
            "kind": "eq.bank_slip_payment",
            "status": "in.(staged,approved)",
            "order": "created_at.desc",
        },
    )
    for row in rows:
        payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
        slip = payload.get("slip") if isinstance(payload.get("slip"), dict) else {}
        if str(slip.get("file_sha256") or "") != file_sha256:
            continue
        return {
            "text": "Bankslip này đang có một thẻ chờ duyệt.",
            "ui": [_change_ui(row)],
            "tool_calls": ["bank_slip_intake"],
        }
    return None


async def _extract_slip(
    db: Any, owner_token: str, image_base64: str, mime_type: str
) -> dict[str, Any]:
    try:
        response = await db.call_edge_function_as_owner(
            "payment-unc-approve",
            {
                "mode": "extract",
                "image_base64": image_base64,
                "mime_type": mime_type,
                "slip_type": "unc",
            },
            owner_token,
            timeout=45.0,
        )
        data = response.json()
    except SupabaseError as exc:
        raise BankSlipError(
            exc.code or "extract_failed",
            "Không đọc được ảnh bankslip. Anh thử lại với ảnh rõ hơn nhé.",
            exc.status_code or 502,
        ) from exc
    except Exception as exc:
        raise BankSlipError(
            "extract_failed",
            "Không đọc được ảnh bankslip. Anh thử lại với ảnh rõ hơn nhé.",
        ) from exc

    if not isinstance(data, dict) or not data.get("success"):
        raise BankSlipError(
            str((data or {}).get("code") or "extract_failed")
            if isinstance(data, dict)
            else "extract_failed",
            "Không đọc được ảnh bankslip. Anh thử lại với ảnh rõ hơn nhé.",
        )

    ocr = data.get("ocr") if isinstance(data.get("ocr"), dict) else {}
    file_sha256 = str(data.get("file_sha256") or "")
    storage_path = str(data.get("storage_path") or "")

    # Extract predates the bank-slip flow for beneficiary_account. Read the
    # server-side OCR draft (same service client) to fill any missing field;
    # never trust a client-supplied value.
    if file_sha256:
        rows = await _select(
            db,
            "payment_unc_ocr_drafts",
            {
                "select": (
                    "file_sha256,storage_path,ocr_amount,ocr_reference,"
                    "ocr_beneficiary_account,ocr_confidence,transfer_date"
                ),
                "file_sha256": f"eq.{file_sha256}",
                "limit": "1",
            },
        )
        if rows:
            draft = rows[0]
            for key, source in (
                ("amount", "ocr_amount"),
                ("reference", "ocr_reference"),
                ("beneficiary_account", "ocr_beneficiary_account"),
                ("confidence", "ocr_confidence"),
                ("transfer_date", "transfer_date"),
            ):
                if ocr.get(key) in (None, ""):
                    ocr[key] = draft.get(source)
            storage_path = storage_path or str(draft.get("storage_path") or "")

    return {
        "file_sha256": file_sha256,
        "storage_path": storage_path,
        "ocr": {
            "amount": _number(ocr.get("amount")),
            "reference": ocr.get("reference"),
            "transfer_date": _date_text(ocr.get("transfer_date")),
            "beneficiary_account": ocr.get("beneficiary_account"),
            "beneficiary_name": ocr.get("beneficiary_name"),
            "transfer_content": ocr.get("transfer_content"),
            "confidence": _number(ocr.get("confidence")),
        },
    }


async def intake(
    backend: Any,
    session: Any,
    *,
    owner_token: str,
    image_base64: str,
    mime_type: str,
    message: str = "",
) -> dict[str, Any]:
    """Read one bankslip image and stage at most one owner-approval change."""

    db = backend._db
    try:
        extracted = await _extract_slip(db, owner_token, image_base64, mime_type)
    except BankSlipError as exc:
        return _reply(str(exc))

    ocr = extracted["ocr"]
    amount = ocr.get("amount")
    if not amount or amount <= 0:
        return _reply(
            "Chưa đọc được số tiền trên bankslip nên VNAgent chưa tạo thẻ duyệt chi. "
            "Anh gửi lại ảnh rõ hơn hoặc tạo phiếu trong Duyệt chi nhé."
        )

    file_sha256 = extracted["file_sha256"]
    if not file_sha256:
        return _reply(
            "Chưa nhận diện được chứng từ bankslip. Anh gửi lại ảnh hoặc tạo phiếu trong Duyệt chi nhé."
        )

    evidence_rows = await _evidence_rows(db)
    duplicate = await _duplicate_evidence(
        db, evidence_rows, file_sha256, ocr.get("reference")
    )
    if duplicate is not None:
        return duplicate

    staged = await _staged_duplicate(db, file_sha256)
    if staged is not None:
        return staged

    supplier_names: dict[str, str] = {}
    suppliers = await _select(db, "suppliers", {"select": "id,name"})
    for row in suppliers:
        supplier_id = str(row.get("id") or "")
        if supplier_id:
            supplier_names[supplier_id] = str(row.get("name") or "")

    beneficiary_name = str(ocr.get("beneficiary_name") or "").strip()
    supplier = await _supplier_from_history(
        db,
        evidence_rows,
        supplier_names,
        normalize_account(ocr.get("beneficiary_account")),
    )
    if supplier is None:
        supplier = await _supplier_by_name(db, beneficiary_name)
    if supplier is None or not supplier.get("id"):
        return _reply(
            "VNAgent chưa nhận ra người nhận tiền trên bankslip. "
            "Anh tạo phiếu trong Duyệt chi trước, rồi gửi lại bankslip để VNAgent "
            "học nhà cung cấp này nhé."
        )

    supplier_id = str(supplier["id"])
    supplier_name = str(supplier.get("name") or supplier_names.get(supplier_id) or "")
    pending = await _pending_requests(db, supplier_id)
    matches = [row for row in pending if amounts_equal(row.get("remaining"), amount)]
    warnings: list[str] = []

    transfer_month = _month_of(ocr.get("transfer_date"))
    paid = await _paid_requests(db, supplier_id)
    if transfer_month and any(
        _month_of(row.get("paid_at") or row.get("created_at")) == transfer_month
        for row in paid
    ):
        warnings.append("already_paid_in_transfer_month")

    confidence = ocr.get("confidence")
    if confidence is not None and confidence < LOW_CONFIDENCE:
        warnings.append("low_ocr_confidence")
    if not ocr.get("transfer_date"):
        warnings.append("missing_transfer_date")

    content = _short_content(ocr.get("transfer_content"))
    if not content:
        content = _short_content(beneficiary_name) or "Chi phí chuyển khoản"

    previous_request = paid[0] if paid else None
    previous = (
        {
            "request_number": previous_request.get("request_number"),
            "date": _date_text(
                previous_request.get("paid_at") or previous_request.get("created_at")
            ),
            "amount": _number(previous_request.get("total_amount")),
        }
        if previous_request
        else None
    )

    if matches:
        if len(matches) > 1:
            warnings.append("multiple_pending_matches")
        target_request = matches[0]
        target = {
            "mode": "pay_existing",
            "request_id": str(target_request.get("id") or ""),
            "request_number": str(target_request.get("request_number") or ""),
            "title": str(target_request.get("title") or ""),
            "line_name": str(target_request.get("title") or content),
            "amount": float(amount),
        }
        summary = (
            f"Thanh toán phiếu {target['request_number']} cho {supplier_name} "
            f"từ bankslip {format_vnd(amount)}"
        )
    else:
        if pending:
            warnings.append("amount_differs")
        title = f"{content} (bankslip {_ddmm(ocr.get('transfer_date'))})"[:200]
        target = {
            "mode": "create_new",
            "title": title,
            "line_name": content[:200],
            "amount": float(amount),
        }
        summary = f"Tạo phiếu chi {format_vnd(amount)} cho {supplier_name} từ bankslip"

    categories, category_labels = await _active_categories(db)
    category = await _history_category(db, supplier_id, category_labels)
    if category is None:
        category = await _suggest_category(
            db,
            owner_token,
            supplier_name,
            content,
            float(amount),
            category_labels,
        )
    if category is None:
        warnings.append("needs_category")

    payload = {
        "version": 1,
        "slip": {
            **ocr,
            "file_sha256": file_sha256,
            "storage_path": extracted["storage_path"],
        },
        "supplier": {"id": supplier_id, "name": supplier_name},
        "target": target,
        "category": category,
        "previous": previous,
        "warnings": warnings,
        "categories": categories,
    }

    row = await db.insert_staged_change(
        {
            "kind": "bank_slip_payment",
            "summary": summary[:200],
            "payload": payload,
            "before": None,
            "status": "staged",
            "operator": session.operator,
            "session_id": session.session_id,
        }
    )

    if category is None:
        text = (
            f"Đã đọc bankslip {format_vnd(amount)} cho {supplier_name}. "
            "Chưa chọn được loại chi phí, anh chọn trong thẻ duyệt chi nhé."
        )
    else:
        text = (
            f"Đã đọc bankslip {format_vnd(amount)} cho {supplier_name}. "
            f"Đề xuất {summary[0].lower() + summary[1:]}."
        )
    return _reply(text, [_change_ui(row)])


# ---------------------------------------------------------------------------
# Approval / apply
# ---------------------------------------------------------------------------

def _error_message(code: str) -> str:
    messages = {
        "file_reused": "Bankslip này đã được ghi nhận trước đó, không thanh toán lại.",
        "reference_reused": "Mã giao dịch trên bankslip đã được dùng cho một khoản chi khác.",
        "self_approval_not_allowed": (
            "Không thể tự duyệt phiếu do chính anh tạo khi có nhiều chủ cửa hàng."
        ),
        "not_pending": "Phiếu này không còn ở trạng thái chờ thanh toán.",
        "amount_mismatch": "Số tiền trên bankslip không khớp với phiếu chờ thanh toán.",
        "supplier_mismatch": "Nhà cung cấp trên phiếu không khớp với bankslip.",
        "evidence_not_found": "Chưa đọc được chứng từ bankslip, anh gửi lại ảnh nhé.",
        "not_owner": "Phiên đăng nhập không còn quyền chủ cửa hàng.",
        "request_not_found": "Không tìm thấy phiếu cần thanh toán.",
        "invalid_category": "Loại chi phí không còn hiệu lực, anh chọn lại nhé.",
        "request_not_paid": "Phiếu chưa được thanh toán nên chưa thể chốt loại chi phí.",
    }
    return messages.get(code, "Chưa thanh toán được phiếu từ bankslip. Anh thử lại nhé.")


def _change_dict(row: dict[str, Any]) -> dict[str, Any]:
    return {
        "change_id": str(row.get("id") or ""),
        "kind": str(row.get("kind") or ""),
        "status": str(row.get("status") or ""),
        "summary": row.get("summary"),
        "items": [],
        "created_at": row.get("created_at"),
        "created_by": row.get("operator"),
        "applied_at": row.get("applied_at"),
        "error": row.get("error"),
        "payload": row.get("payload") or {},
        "before": row.get("before"),
    }


async def _mark_failed(backend: Any, change_id: str, message: str) -> None:
    try:
        await backend._db.update_staged_change(
            change_id,
            {"status": "failed", "error": message},
        )
    except Exception:
        _LOG.warning("Không ghi được trạng thái failed cho change %s", change_id)


async def _request_payment_status(db: Any, request_id: str) -> dict[str, Any] | None:
    rows = await _select(
        db,
        "payment_requests",
        {
            "select": "id,request_number,status,payment_status,total_amount",
            "id": f"eq.{request_id}",
            "limit": "1",
        },
    )
    return rows[0] if rows else None


async def apply_bank_slip_change(
    backend: Any,
    session: Any,
    change_id: str,
    *,
    category_code: str | None,
    owner_token: str,
) -> dict[str, Any]:
    """prepare -> confirm (owner token) -> finalize, idempotently."""

    db = backend._db
    row = await backend._fetch_change(change_id)
    if row is None:
        raise ChangeNotApplicable("Không tìm thấy thay đổi cần áp dụng")
    if str(row.get("kind") or "") != "bank_slip_payment":
        raise ChangeNotApplicable("Loại thay đổi không phải bankslip")
    if str(row.get("status") or "") == "applied":
        payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
        target = payload.get("target") if isinstance(payload.get("target"), dict) else {}
        request_id = str(payload.get("prepared_request_id") or target.get("request_id") or "")
        request_number = str(target.get("request_number") or "")
        if request_id and not request_number:
            request = await _request_payment_status(db, request_id)
            request_number = str((request or {}).get("request_number") or "")
        result = _change_dict(row)
        result["request_number"] = request_number or None
        result["doc_link"] = _doc_link(
            request_id, request_number, target.get("amount")
        )
        return result
    if str(row.get("status") or "") != "approved":
        raise ChangeNotApplicable("Thay đổi chưa được chủ cửa hàng duyệt")

    payload = row.get("payload") if isinstance(row.get("payload"), dict) else {}
    target = payload.get("target") if isinstance(payload.get("target"), dict) else {}
    slip = payload.get("slip") if isinstance(payload.get("slip"), dict) else {}
    proposal = payload.get("category") if isinstance(payload.get("category"), dict) else {}
    chosen_category = (
        category_code
        or payload.get("approved_category")
        or proposal.get("code")
    )
    if not chosen_category:
        raise ValueError("Anh chọn loại chi phí cho khoản chi này nhé.")

    if not owner_token:
        raise ValueError("Thiếu phiên đăng nhập của chủ cửa hàng.")

    try:
        prepared = await db.rpc(
            "merchant_prepare_bank_slip_request", {"p_change_id": change_id}
        )
    except SupabaseError as exc:
        raise ChangeNotApplicable(_error_message(exc.code or "")) from exc
    prepared_row = backend._rpc_row(prepared)
    if prepared_row is None or not prepared_row.get("request_id"):
        raise ChangeNotApplicable("Chưa chuẩn bị được phiếu thanh toán từ bankslip")

    request_id = str(prepared_row.get("request_id"))
    request_number = str(prepared_row.get("request_number") or "")
    file_sha256 = str(slip.get("file_sha256") or "")
    amount = target.get("amount") or (slip.get("ocr") or {}).get("amount")
    # intake stores the OCR fields flat in payload.slip.
    reference = str(slip.get("reference") or "").strip()
    note = (f"Bankslip {reference} — duyệt từ chatbox" if reference else "Bankslip — duyệt từ chatbox")[:500]

    try:
        await db.call_edge_function_as_owner(
            "payment-unc-approve",
            {
                "mode": "confirm",
                "request_ids": [request_id],
                "file_sha256": file_sha256,
                "amount": amount,
                "idempotency_key": f"unc:{file_sha256}",
                "payment_method": "bank_transfer",
                "note": note,
            },
            owner_token,
            timeout=45.0,
        )
    except SupabaseError as exc:
        if exc.status_code is None:
            # A timeout / connection failure leaves the outcome unknown. Read the
            # request state before deciding whether a retry is safe.
            current = await _request_payment_status(db, request_id)
            if str((current or {}).get("payment_status") or "") != "paid":
                message = (
                    "Chưa rõ kết quả thanh toán từ bankslip. VNAgent đã giữ phiếu chờ; "
                    "anh thử duyệt lại sau ít phút."
                )
                await _mark_failed(backend, change_id, message)
                raise ChangeNotApplicable(message) from exc
        else:
            code = exc.code or ""
            message = _error_message(code)
            await _mark_failed(backend, change_id, message)
            raise ChangeNotApplicable(message) from exc

    try:
        finalized = await db.rpc(
            "merchant_finalize_bank_slip_payment",
            {"p_change_id": change_id, "p_category_code": chosen_category},
        )
    except SupabaseError as exc:
        message = _error_message(exc.code or "")
        await _mark_failed(backend, change_id, message)
        raise ChangeNotApplicable(message) from exc

    applied_row = await backend._fetch_change(change_id)
    if applied_row is None:
        raise ChangeNotApplicable("Không đọc lại được thay đổi sau khi áp dụng")
    result = _change_dict(applied_row)
    finalized_row = backend._rpc_row(finalized) or {}
    result["request_number"] = request_number or finalized_row.get("request_number")
    result["doc_link"] = _doc_link(request_id, result["request_number"], amount)
    result["classification"] = finalized_row.get("classification")
    return result
