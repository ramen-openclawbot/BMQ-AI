#!/usr/bin/env python3
"""Static contract checks for the Giai đoạn 1 UNC + finance Zalo OA backend.

These checks never connect to a database or Supabase. They guard the migration
security/atomicity rules, the fail-closed Zalo worker, and that the existing
approve/finalize functions are not redefined.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
FUNCTIONS = ROOT / "supabase" / "functions"
LIB = ROOT / "src" / "lib"

MIGRATION = MIGRATIONS / "20261006120000_payment_unc_zalo_flow.sql"
ALLOCATIONS_MIGRATION = MIGRATIONS / "20261006140000_payment_unc_allocations.sql"
APPROVE_RPC = FUNCTIONS / "payment-unc-approve" / "index.ts"
ZALO_WORKER = FUNCTIONS / "finance-zalo-notify" / "index.ts"
ZALO_SHARED = FUNCTIONS / "_shared" / "finance-zalo-notification.ts"
OCR_SHARED = FUNCTIONS / "_shared" / "bank-slip-ocr.ts"
EXTRACT_FN = FUNCTIONS / "finance-extract-slip-amount" / "index.ts"
MATCHING = LIB / "payment-unc-matching.ts"
HOOK = ROOT / "src" / "hooks" / "usePaymentUncApproval.ts"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    migration = read(MIGRATION)
    allocations_migration = read(ALLOCATIONS_MIGRATION)
    approve_rpc = read(APPROVE_RPC)
    worker = read(ZALO_WORKER)
    zalo_shared = read(ZALO_SHARED)
    ocr_shared = read(OCR_SHARED)
    extract_fn = read(EXTRACT_FN)
    matching = read(MATCHING)
    hook = read(HOOK)

    # --- Migration: additive evidence table + owner-only RLS -----------------
    for table in (
        "public.payment_unc_evidence",
        "public.payment_unc_ocr_drafts",
        "public.payment_unc_idempotency",
        "public.finance_zalo_notifications",
        "public.finance_zalo_notification_config",
    ):
        assert_true(f"create table if not exists {table}" in migration, f"migration must add {table}")
    assert_true("file_sha256 text not null" in migration, "evidence stores the file hash")
    assert_true(
        "create unique index if not exists uq_payment_unc_evidence_file_sha256" in migration,
        "file_sha256 must be unique",
    )
    assert_true(
        "create unique index if not exists uq_payment_unc_evidence_reference" in migration
        and "public.normalize_unc_reference(ocr_reference)" in migration,
        "normalized reference must have a unique partial index",
    )
    assert_true("enable row level security" in migration, "new tables must enable RLS")
    assert_true(
        "revoke all on public.payment_unc_evidence from public, anon, authenticated" in migration,
        "evidence must not be directly writable by clients",
    )
    assert_true(
        "payment_unc_evidence_owner_select" in migration
        and "using (public.has_role(auth.uid(), 'owner'))" in migration,
        "evidence select must be owner-only",
    )

    # --- Migration: owner-only atomic approval RPC ---------------------------
    assert_true(
        "create or replace function public.approve_payment_requests_with_unc(" in migration,
        "UNC approval RPC must exist",
    )
    assert_true(
        "p_idempotency_key text" in migration and "payment_unc_idempotency" in migration,
        "approval RPC must support an idempotency key",
    )
    assert_true(
        "for update of pr" in migration,
        "approval RPC must lock the payment requests FOR UPDATE",
    )
    assert_true("'amount_mismatch'" in migration, "approval RPC must guard exact amount")
    assert_true(
        migration.count("'evidence_not_extracted'") >= 2
        and "'amount_required'" in migration,
        "standalone UNC must also read OCR fields from the server draft",
    )
    assert_true(
        "suppressed: request no longer pending" in migration
        and "suppressed: not paid through UNC approval" in migration
        and "interval '2 minutes'" in migration,
        "claim must suppress stale new-request and non-UNC paid notices",
    )
    assert_true(
        'mode === "record"' in approve_rpc and "record_unc_without_request" in approve_rpc,
        "approve edge must expose record mode for UNC without a request",
    )
    assert_true(
        "'evidence_not_extracted'" in migration
        and "from public.payment_unc_ocr_drafts d" in migration
        and "v_amount := v_draft_amount;" in migration,
        "approval RPC must take OCR fields from the server-side draft, not the caller",
    )
    assert_true("'supplier_mismatch'" in migration, "approval RPC must guard same supplier")
    assert_true("'reference_reused'" in migration, "approval RPC must reject reused references")
    assert_true("'file_reused'" in migration, "approval RPC must reject reused file hashes")
    assert_true("'not_pending'" in migration, "approval RPC must require pending requests")
    assert_true(
        "public.approve_payment_request_with_material_controller(" in migration,
        "UNC RPC must reuse the existing material-controller approval path",
    )
    assert_true(
        "assert_procurement_materials_ready" in migration,
        "UNC RPC must reference the procurement material readiness guard",
    )
    assert_true(
        "revoke all on function public.approve_payment_requests_with_unc(uuid[], jsonb, text) from public, anon" in migration,
        "UNC RPC must revoke execute from public/anon",
    )
    assert_true(
        "grant execute on function public.approve_payment_requests_with_unc(uuid[], jsonb, text) to authenticated" in migration,
        "UNC RPC must grant execute to authenticated",
    )
    assert_true(
        "if not (v_is_service or public.has_role(v_actor, 'owner'))" in migration,
        "UNC RPC must be owner-only (no module edit fallback)",
    )
    assert_true(
        "has_module_permission" not in migration,
        "UNC approval must not accept module edit permission",
    )
    assert_true(
        "'self_approval_not_allowed'" in migration and "v_owner_count > 1" in migration,
        "UNC RPC must block self-approval unless the caller is the only owner",
    )
    assert_true(
        "coalesce(v_category, 'khac')" in migration,
        "approved evidence must still be categorised",
    )

    # --- Migration: daily evidence total + standalone evidence ---------------
    assert_true(
        "create or replace function public.finance_unc_total_from_evidence(p_date date)" in migration,
        "daily UNC total RPC must exist",
    )
    assert_true(
        "(e.created_at at time zone 'Asia/Ho_Chi_Minh')::date" in migration,
        "daily UNC total must resolve Asia/Ho_Chi_Minh dates",
    )
    assert_true(
        "create or replace function public.record_unc_without_request(" in migration,
        "standalone UNC evidence RPC must exist",
    )
    assert_true(
        "'luong', 'thue', 'thue_nha', 'khac'" in migration,
        "standalone categories must be luong/thue/thue_nha/khac",
    )

    # --- Migration: default-off outbox + triggers ----------------------------
    assert_true(
        "finance_zalo_notifications_enabled boolean not null default false" in migration,
        "finance Zalo flag must default false",
    )
    assert_true(
        "unique (event_type, entity_id)" in migration,
        "outbox must be unique per event + entity",
    )
    assert_true(
        "for update skip locked" in migration,
        "outbox claim must use FOR UPDATE SKIP LOCKED",
    )
    assert_true(
        "on conflict (event_type, entity_id) do nothing" in migration,
        "outbox enqueue must be idempotent",
    )
    assert_true(
        migration.count("exception when others then") >= 3,
        "each enqueue trigger must swallow + log exceptions",
    )
    assert_true(
        migration.count("raise warning 'finance_zalo") >= 3,
        "each enqueue trigger must log a warning without raising",
    )
    assert_true(
        "after insert on public.payment_requests" in migration
        and "after update of status, payment_status on public.payment_requests" in migration
        and "after update of status on public.goods_receipts" in migration,
        "expected outbox triggers must exist",
    )
    assert_true(
        "cron.schedule" not in migration
        and "cron.unschedule" not in migration
        and "create extension if not exists pg_cron" not in migration,
        "stage 1 must not schedule any pg_cron job",
    )

    # Existing approval/finalize functions must not be redefined here.
    assert_true(
        "create or replace function public.approve_payment_request_with_material_controller" not in migration,
        "must not redefine the existing material-controller approval",
    )
    assert_true(
        "create or replace function public.finalize_goods_receipt" not in migration,
        "must not redefine finalize_goods_receipt",
    )
    assert_true(
        "create or replace function public.record_payment_allocations" not in migration,
        "must not redefine record_payment_allocations",
    )

    # --- Migration 20261006140000: optional per-request allocations ----------
    # Same signature (no overload) and the legacy no-allocations behaviour kept.
    assert_true(
        allocations_migration.count("create or replace function public.approve_payment_requests_with_unc(") == 1,
        "allocations migration must declare the UNC RPC exactly once (no overload)",
    )
    assert_true(
        "create or replace function public.approve_payment_requests_with_unc(" in allocations_migration
        and "p_request_ids uuid[]" in allocations_migration
        and "p_evidence jsonb" in allocations_migration
        and "p_idempotency_key text" in allocations_migration,
        "allocations migration must keep the exact (uuid[], jsonb, text) signature",
    )
    assert_true(
        "revoke all on function public.approve_payment_requests_with_unc(uuid[], jsonb, text) from public, anon" in allocations_migration
        and "grant execute on function public.approve_payment_requests_with_unc(uuid[], jsonb, text) to authenticated, service_role" in allocations_migration,
        "allocations migration must keep the revoke/grant pair",
    )
    assert_true(
        "if not (v_is_service or public.has_role(v_actor, 'owner'))" in allocations_migration
        and "'self_approval_not_allowed'" in allocations_migration
        and "for update of pr" in allocations_migration
        and "payment_unc_idempotency" in allocations_migration,
        "allocations migration must keep owner-only, self-approval, FOR UPDATE and idempotency guards",
    )
    assert_true(
        "from public.payment_unc_ocr_drafts d" in allocations_migration
        and "if not v_manual_override then" in allocations_migration
        and "v_amount := v_draft_amount;" in allocations_migration,
        "allocations migration must keep reading OCR fields from the server draft",
    )
    assert_true(
        "'file_reused'" in allocations_migration
        and "'reference_reused'" in allocations_migration
        and "insert into public.payment_unc_evidence" in allocations_migration,
        "allocations migration must keep file/reference uniqueness and the evidence insert",
    )

    # Allocations branch + guards.
    assert_true(
        "v_evidence->'allocations'" in allocations_migration
        and "v_has_alloc" in allocations_migration,
        "RPC must read the optional allocations array",
    )
    assert_true(
        "v_pr.status::text not in ('pending', 'approved')" in allocations_migration
        and "v_pr.payment_status::text not in ('unpaid', 'partial')" in allocations_migration,
        "allocations branch must allow pending or approved unpaid/partial requests",
    )
    assert_true(
        "if v_pr.status::text = 'pending' then" in allocations_migration,
        "already-approved requests must not be re-approved",
    )
    assert_true(
        "'invalid_allocation'" in allocations_migration
        and "duplicate_payment_request_id" in allocations_migration
        and "request_ids_mismatch" in allocations_migration,
        "RPC must raise invalid_allocation for bad/duplicate/mismatched allocations",
    )
    assert_true(
        "'allocation_exceeds_remaining'" in allocations_migration,
        "RPC must reject an allocation above the request remaining amount",
    )
    assert_true(
        "'amount_mismatch'" in allocations_migration
        and "v_amount <> v_payment_total" in allocations_migration,
        "RPC must require the allocation sum to match the evidence amount",
    )
    assert_true(
        "'allocations', v_allocations" in allocations_migration,
        "RPC result must include the allocations array",
    )
    assert_true(
        "public.approve_payment_request_with_material_controller(" in allocations_migration,
        "allocations branch must approve pending requests through the material controller",
    )

    # Must not redefine neighbours or schedule cron.
    assert_true(
        "create or replace function public.record_payment_allocations" not in allocations_migration,
        "allocations migration must not redefine record_payment_allocations",
    )
    assert_true(
        "create or replace function public.approve_payment_request_with_material_controller" not in allocations_migration
        and "create or replace function public.finalize_goods_receipt" not in allocations_migration,
        "allocations migration must not redefine the controller/finalize functions",
    )
    assert_true(
        "cron.schedule" not in allocations_migration
        and "cron.unschedule" not in allocations_migration
        and "pg_cron" not in allocations_migration,
        "allocations migration must not schedule any pg_cron job",
    )

    # --- Edge: fail-closed finance Zalo worker -------------------------------
    assert_true(
        "finance_zalo_notifications_enabled" in worker,
        "worker must read the finance Zalo flag",
    )
    assert_true(
        "finance_zalo_notifications_disabled" in worker and "skipped: true" in worker,
        "worker must return skipped when the flag is off",
    )
    assert_true(
        "ZALO_GMF_FINANCE_GROUP_ID" in worker and "zalo_gmf_finance_group_not_configured" in worker,
        "worker must fail closed when the finance group id is missing",
    )
    assert_true(
        "claim_finance_zalo_notifications" in worker,
        "worker must claim through the outbox RPC",
    )
    assert_true(
        "sendZaloGmfText" in worker and "refreshZaloOaAccessToken" in worker,
        "worker must reuse the dealer Zalo send/refresh exports",
    )
    assert_true(
        "needs_review" in worker,
        "uncertain Zalo outcomes must be marked needs_review and never auto-resent",
    )
    assert_true(
        "cron.schedule" not in worker,
        "worker must not install a cron schedule",
    )

    # --- Edge: payment-unc-approve ------------------------------------------
    assert_true("mode === \"extract\"" in approve_rpc, "approve edge must support extract mode")
    assert_true("mode === \"confirm\"" in approve_rpc, "approve edge must support confirm mode")
    assert_true(
        "bank-slip-ocr" in approve_rpc,
        "approve edge must reuse the shared bank-slip OCR module",
    )
    assert_true(
        "approve_payment_requests_with_unc" in approve_rpc,
        "approve edge must call the atomic UNC RPC",
    )
    assert_true(
        "payment_unc_ocr_drafts" in approve_rpc,
        "confirm mode must re-read the server-stored OCR draft",
    )
    assert_true(
        "Never trust a client-supplied amount" in approve_rpc,
        "confirm mode must not trust a client amount without a reasoned override",
    )
    for code in ("amount_mismatch", "supplier_mismatch", "reference_reused", "file_reused", "not_owner", "not_pending"):
        assert_true(code in approve_rpc, f"approve edge must surface structured error {code}")
    assert_true(
        "normalizeAllocations" in approve_rpc
        and "body.allocations" in approve_rpc
        and "MAX_UNC_ALLOCATIONS" in approve_rpc,
        "confirm mode must validate optional body.allocations server-side",
    )
    assert_true(
        "request_ids_mismatch" in approve_rpc
        and "invalid_allocation" in approve_rpc
        and "allocation_exceeds_remaining" in approve_rpc,
        "approve edge must require allocation ids == request ids and map the new error codes",
    )

    # --- Shared modules + frontend helpers ----------------------------------
    for marker in (
        "payment_request_created",
        "payment_request_paid",
        "goods_receipt_received",
        "goods_receipt_short",
        "payment-requests",
        "goods-receipts",
        "?id=",
    ):
        assert_true(marker in zalo_shared, f"finance Zalo formatter must cover {marker}")
    assert_true(
        "parseVietnameseAmountWords" in ocr_shared and "callOpenAiVision" in ocr_shared,
        "shared OCR module must expose the parse + OCR helpers",
    )
    assert_true(
        "callOpenAiVision" in extract_fn and "provider: \"openai\"" in extract_fn,
        "finance-extract-slip-amount must keep using the shared OCR pipeline",
    )
    assert_true(
        "normalizeUncReference" in matching and "evaluatePaymentUncMatch" in matching,
        "matching helper must expose normalized reference + evaluation",
    )
    assert_true(
        "evaluatePaymentUncMatch" in hook and "payment-unc-approve" in hook,
        "hook must call the edge function and reuse the matching helper",
    )
    assert_true(
        "evaluateUncAllocations" in matching,
        "matching helper must expose allocation evaluation",
    )
    assert_true(
        "evaluateUncAllocations" in hook and "allocations" in hook,
        "hook must run the allocation helper and forward allocations",
    )

    print("PASS: UNC approval + finance Zalo OA backend contracts hold")


if __name__ == "__main__":
    main()
