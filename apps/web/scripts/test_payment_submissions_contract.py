#!/usr/bin/env python3
"""Static contract checks for the "Trình chi gấp" payment-submission backend.

These checks never connect to a database or Supabase. They guard the migration
security/atomicity rules, the optional cash UNC method, the finance Zalo event
wiring and that the earlier migrations are untouched.
"""
from __future__ import annotations

import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
FUNCTIONS = ROOT / "supabase" / "functions"
LIB = ROOT / "src" / "lib"
HOOKS = ROOT / "src" / "hooks"

MIGRATION = MIGRATIONS / "20261007090000_payment_submissions.sql"
ALLOCATIONS_MIGRATION = MIGRATIONS / "20261006140000_payment_unc_allocations.sql"
UNC_MIGRATION = MIGRATIONS / "20261006120000_payment_unc_zalo_flow.sql"
APPROVE_RPC = FUNCTIONS / "payment-unc-approve" / "index.ts"
ZALO_WORKER = FUNCTIONS / "finance-zalo-notify" / "index.ts"
ZALO_SHARED = FUNCTIONS / "_shared" / "finance-zalo-notification.ts"
ZALO_SHARED_TEST = FUNCTIONS / "_shared" / "finance-zalo-notification.test.ts"
HOOK = HOOKS / "usePaymentSubmissions.ts"
UNC_HOOK = HOOKS / "usePaymentUncApproval.ts"
SUBMISSION_LIB = LIB / "payment-submission.ts"
SUBMISSION_LIB_TEST = LIB / "payment-submission.test.ts"

EARLIER_MIGRATIONS = [
    "20261006120000_payment_unc_zalo_flow.sql",
    "20261006130000_finance_zalo_notify_schedule.sql",
    "20261006140000_payment_unc_allocations.sql",
    "20261006150000_payment_request_unc_evidence_read.sql",
    "20261006160000_payment_request_requires_receipt.sql",
    "20261006183500_kiosk_dat_note_auto_order.sql",
]


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def git_head_content(relative_path: str) -> str | None:
    try:
        result = subprocess.run(
            ["git", "show", f"HEAD:{relative_path}"],
            cwd=str(ROOT),
            capture_output=True,
            text=True,
            check=True,
        )
        return result.stdout
    except Exception:
        return None


def main() -> None:
    migration = read(MIGRATION)
    allocations_migration = read(ALLOCATIONS_MIGRATION)
    unc_migration = read(UNC_MIGRATION)
    approve_rpc = read(APPROVE_RPC)
    worker = read(ZALO_WORKER)
    zalo_shared = read(ZALO_SHARED)
    zalo_shared_test = read(ZALO_SHARED_TEST)
    hook = read(HOOK)
    unc_hook = read(UNC_HOOK)
    submission_lib = read(SUBMISSION_LIB)
    submission_lib_test = read(SUBMISSION_LIB_TEST)

    # --- Migration: additive submission tables + indexes ---------------------
    assert_true(
        "create table if not exists public.payment_submissions (" in migration,
        "migration must add public.payment_submissions",
    )
    assert_true(
        "create table if not exists public.payment_submission_items (" in migration,
        "migration must add public.payment_submission_items",
    )
    for column in ("submission_number text not null", "note text", "total_amount numeric not null", "created_by uuid", "created_at timestamptz"):
        assert_true(column in migration, f"payment_submissions must define {column}")
    assert_true(
        "constraint payment_submissions_number_key unique (submission_number)" in migration,
        "submission_number must be unique",
    )
    assert_true(
        "submission_number ~ '^TC-[0-9]{6}-[0-9]+$'" in migration,
        "submission_number must follow TC-YYMMDD-NN",
    )
    assert_true(
        "remaining_at_submit numeric not null" in migration
        and "position integer not null" in migration,
        "payment_submission_items must snapshot remaining + position",
    )
    assert_true(
        "unique (submission_id, payment_request_id)" in migration,
        "payment_submission_items must be unique per submission + request",
    )
    assert_true(
        "create index if not exists idx_payment_submission_items_request" in migration
        and "on public.payment_submission_items (payment_request_id)" in migration,
        "payment_submission_items(payment_request_id) index must exist",
    )
    assert_true(
        "create index if not exists idx_payment_submissions_created_at" in migration
        and "on public.payment_submissions (created_at desc)" in migration,
        "payment_submissions(created_at desc) index must exist",
    )

    # --- Migration: RLS (owner/view read, no client writes) -------------------
    for table in ("public.payment_submissions", "public.payment_submission_items"):
        assert_true(
            f"alter table {table} enable row level security" in migration,
            f"{table} must enable RLS",
        )
        assert_true(
            f"revoke all on {table} from public, anon, authenticated" in migration,
            f"{table} must not be directly writable by clients",
        )
        assert_true(
            f"grant select on {table} to authenticated" in migration,
            f"{table} must grant select to authenticated only",
        )
    assert_true(
        "payment_submissions_view_select" in migration
        and "payment_submission_items_view_select" in migration,
        "both tables need a select policy",
    )
    assert_true(
        "public.has_module_permission(auth.uid(), 'payment_requests', 'view')" in migration,
        "read policies must allow owner or payment_requests view",
    )
    assert_true(
        "for insert" not in migration
        and "for delete" not in migration
        and "for update on public.payment_submission" not in migration,
        "no client write policies may be added",
    )
    assert_true(
        "grant insert" not in migration
        and "grant update" not in migration
        and "grant delete" not in migration,
        "no client write grants may be added",
    )

    # --- Migration: create_payment_submission --------------------------------
    assert_true(
        "create or replace function public.create_payment_submission(" in migration
        and "p_request_ids uuid[]" in migration
        and "p_note text" in migration
        and "p_idempotency_key text" in migration,
        "create_payment_submission must exist with the exact signature",
    )
    assert_true(
        "security definer" in migration and "set search_path = public, pg_temp" in migration,
        "submission RPCs must be security definer and pin search_path",
    )
    assert_true(
        "public.has_module_permission(v_actor, 'payment_requests', 'edit')" in migration,
        "create must allow payment_requests edit",
    )
    assert_true(
        "public.has_module_permission(v_uid, 'payment_requests', 'view')" in migration,
        "get must allow payment_requests view",
    )
    for code in (
        "insufficient_privilege",
        "not_owner",
        "request_ids_required",
        "too_many_requests",
        "request_not_found",
        "not_payable",
        "idempotency_key_required",
    ):
        assert_true(f"'{code}'" in migration, f"create_payment_submission must raise {code}")
    assert_true("errcode = '42501'" in migration, "permission errors must use 42501")
    assert_true(
        "array_length(p_request_ids, 1) > 50" in migration,
        "create must cap the request list at 50",
    )
    assert_true(
        "v_pr.status::text not in ('pending', 'approved')" in migration
        and "v_pr.payment_status::text not in ('unpaid', 'partial')" in migration
        and "v_remaining <= 0" in migration,
        "create must reject rejected/paid/fully-allocated requests",
    )
    assert_true(
        "to_char((now() at time zone 'Asia/Ho_Chi_Minh'), 'YYMMDD')" in migration
        and "v_number := 'TC-' || v_day || '-' || lpad(v_seq::text, 2, '0')" in migration,
        "submission_number must be generated from the Vietnam date + per-day sequence",
    )
    assert_true(
        "pg_advisory_xact_lock(hashtext('payment_submission_number:' || v_day))" in migration,
        "the per-day sequence must run under an advisory lock",
    )
    assert_true(
        "public.payment_submission_idempotency" in migration
        and "on conflict (idempotency_key) do nothing" in migration,
        "create must be idempotent by key",
    )
    assert_true(
        "values ('payment_submission_created', v_submission_id, 'finance', v_message, 'pending')" in migration
        and "on conflict (event_type, entity_id) do nothing" in migration,
        "create must enqueue one finance Zalo notice idempotently",
    )
    assert_true(
        "'📋 TRÌNH CHI GẤP ' || v_number" in migration
        and "v_item_count::text || ' phiếu · Tổng ' || public.finance_format_vnd(v_total)" in migration,
        "message body must have the header + total lines",
    )
    assert_true(
        "'• %s – %s: %s'" in migration
        and "'… và '" in migration
        and "https://ai.banhmique.vn/payment-requests/submissions/" in migration,
        "message body must have request lines, overflow and the deep link",
    )
    assert_true(
        "revoke all on function public.create_payment_submission(uuid[], text, text) from public, anon" in migration
        and "grant execute on function public.create_payment_submission(uuid[], text, text) to authenticated, service_role" in migration,
        "create must revoke public/anon and grant authenticated/service_role",
    )

    # --- Migration: get_payment_submission -----------------------------------
    assert_true(
        "create or replace function public.get_payment_submission(p_id uuid)" in migration,
        "get_payment_submission must exist",
    )
    for field in (
        "'submission_number'",
        "'note'",
        "'total_amount'",
        "'created_by'",
        "'created_at'",
        "'request_number'",
        "'title'",
        "'supplier_name'",
        "'allocated_amount'",
        "'remaining_amount'",
        "'status'",
        "'payment_status'",
        "'requires_receipt'",
    ):
        assert_true(field in migration, f"get_payment_submission must return {field}")
    assert_true(
        "revoke all on function public.get_payment_submission(uuid) from public, anon" in migration
        and "grant execute on function public.get_payment_submission(uuid) to authenticated, service_role" in migration,
        "get must revoke public/anon and grant authenticated/service_role",
    )

    # --- Migration: extended finance Zalo event check ------------------------
    assert_true(
        "drop constraint if exists finance_zalo_notifications_event_type_check" in migration
        and "add constraint finance_zalo_notifications_event_type_check" in migration
        and "'payment_submission_created'" in migration,
        "the event_type check must be re-added with payment_submission_created",
    )

    # --- Migration: approve RPC keeps signature + optional cash method -------
    assert_true(
        migration.count("create or replace function public.approve_payment_requests_with_unc(") == 1,
        "the submission migration must declare the UNC RPC exactly once (no overload)",
    )
    assert_true(
        "p_request_ids uuid[]" in migration
        and "p_evidence jsonb" in migration
        and "p_idempotency_key text" in migration,
        "approve RPC must keep the exact (uuid[], jsonb, text) signature",
    )
    assert_true(
        "v_method text := coalesce(nullif(v_evidence->>'payment_method', ''), 'bank_transfer')" in migration,
        "approve RPC must default the payment method to bank_transfer",
    )
    assert_true(
        "if v_method not in ('bank_transfer', 'cash') then" in migration
        and "'invalid_payment_method'" in migration,
        "approve RPC must reject any other payment method",
    )
    assert_true(
        "v_method::public.payment_method_type" in migration,
        "the payments row must use the requested cash/bank method",
    )
    assert_true(
        "public.approve_payment_request_with_material_controller(" in migration
        and "v_method," in migration,
        "the material-controller approval must use the requested method",
    )
    for guard in (
        "'self_approval_not_allowed'",
        "for update of pr",
        "payment_unc_idempotency",
        "'amount_mismatch'",
        "'supplier_mismatch'",
        "'file_reused'",
        "'reference_reused'",
    ):
        assert_true(guard in migration, f"approve RPC must keep the guard {guard}")
    assert_true(
        "public.approve_payment_request_with_material_controller(" in migration,
        "approve RPC must keep reusing the material-controller approval",
    )
    assert_true(
        "v_pr.status::text not in ('pending', 'approved')" in migration
        and "v_pr.payment_status::text not in ('unpaid', 'partial')" in migration
        and "'allocation_exceeds_remaining'" in migration,
        "approve RPC must keep the allocations branch",
    )
    assert_true(
        "revoke all on function public.approve_payment_requests_with_unc(uuid[], jsonb, text) from public, anon" in migration
        and "grant execute on function public.approve_payment_requests_with_unc(uuid[], jsonb, text) to authenticated, service_role" in migration,
        "approve RPC must keep the revoke/grant pair",
    )

    # --- Migration: no cron, no other redefinitions --------------------------
    assert_true(
        "cron.schedule" not in migration
        and "cron.unschedule" not in migration
        and "pg_cron" not in migration,
        "the submission migration must not schedule any pg_cron job",
    )
    assert_true(
        "create or replace function public.record_payment_allocations" not in migration
        and "create or replace function public.approve_payment_request_with_material_controller" not in migration
        and "create or replace function public.finalize_goods_receipt" not in migration
        and "create or replace function public.reject_payment_request" not in migration
        and "create or replace function public.record_unc_without_request" not in migration,
        "the submission migration must not redefine neighbouring functions",
    )

    # --- Earlier migrations untouched (best effort via git HEAD) -------------
    for filename in EARLIER_MIGRATIONS:
        head = git_head_content(f"apps/web/supabase/migrations/{filename}")
        if head is None:
            continue
        on_disk = read(MIGRATIONS / filename)
        assert_true(
            head == on_disk,
            f"earlier migration {filename} must not be edited",
        )
    assert_true(
        "invalid_payment_method" not in allocations_migration
        and "'bank_transfer'::public.payment_method_type" in allocations_migration,
        "the allocations migration must stay as originally applied",
    )
    assert_true(
        "assert_procurement_materials_ready" in unc_migration,
        "the original UNC flow must keep the procurement material readiness guard",
    )

    # --- Edge: payment-unc-approve cash method + slip_type -------------------
    assert_true(
        "invalid_payment_method" in approve_rpc,
        "approve edge must expose invalid_payment_method",
    )
    assert_true(
        "body.payment_method" in approve_rpc
        and 'paymentMethod !== "bank_transfer"' in approve_rpc
        and 'paymentMethod !== "cash"' in approve_rpc,
        "confirm mode must accept only bank_transfer/cash",
    )
    assert_true(
        "payment_method: paymentMethod" in approve_rpc,
        "confirm mode must forward the payment method to the RPC",
    )
    assert_true(
        "slip_type" in approve_rpc and "callOpenAiVision(imageBase64, mimeType, slipType)" in approve_rpc,
        "extract mode must pass slip_type through to the OCR",
    )

    # --- Edge: shared formatter + worker -------------------------------------
    assert_true(
        '"payment_submission_created"' in zalo_shared
        and "formatPaymentSubmissionMessage" in zalo_shared
        and "PAYMENT_SUBMISSIONS_DEEP_LINK" in zalo_shared
        and "payment-requests/submissions" in zalo_shared,
        "shared formatter must include the submission event + deep link",
    )
    assert_true(
        "formatPaymentSubmissionMessage" in zalo_shared_test
        and "payment_submission_created" in zalo_shared_test,
        "the formatter test must cover the submission event",
    )
    assert_true(
        "payment_submission_created" in worker,
        "the finance Zalo worker must recognise the submission event",
    )
    assert_true(
        "payment_request_created" in worker
        and "payment_request_paid" in worker
        and "goods_receipt_short" in worker,
        "the worker must not break the existing events",
    )

    # --- Frontend hooks + pure helpers ---------------------------------------
    assert_true(
        "export function useUnpaidPaymentRequestsPage(" in hook
        and "export function useCreatePaymentSubmission(" in hook
        and "export function usePaymentSubmission(" in hook,
        "usePaymentSubmissions must export the three hooks",
    )
    assert_true(
        'count: "exact"' in hook and ".range(range.from, range.to)" in hook,
        "the unpaid page hook must use server-side range + exact count",
    )
    assert_true(
        "days = 90" in hook and "days?: number | null" in hook and "vietnamDateCutoff(days)" in hook,
        "the unpaid page hook must support the Vietnam 90-day cutoff / all time",
    )
    assert_true(
        '"create_payment_submission"' in hook and '"get_payment_submission"' in hook,
        "the hooks must call the new RPCs",
    )
    assert_true(
        '"bank_transfer" | "cash"' in unc_hook
        and "payment_method: payload.payment_method" in unc_hook,
        "usePaymentUncApproval must forward the optional payment method",
    )
    assert_true(
        "paymentSubmissionPageToRange" in submission_lib
        and "vietnamDateCutoff" in submission_lib
        and "formatPaymentSubmissionPreview" in submission_lib,
        "payment-submission lib must expose page math, cutoff and preview",
    )
    assert_true(
        "paymentSubmissionPageToRange" in submission_lib_test
        and "vietnamDateCutoff" in submission_lib_test
        and "formatPaymentSubmissionPreview" in submission_lib_test,
        "payment-submission tests must cover the pure helpers",
    )

    print("PASS: payment submissions (Trình chi gấp) backend contracts hold")


if __name__ == "__main__":
    main()
