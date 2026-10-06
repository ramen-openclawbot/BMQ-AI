#!/usr/bin/env python3
"""Static contract checks for the server side of "Phiếu chi không nhập kho".

These checks never connect to a database or Supabase. They guard that the
additive migration only adds the requires_receipt columns + toggle RPC, keeps
the write/approval/allocation functions untouched, schedules no cron, and that
the shared helper/hook/types stay aligned with the migration.
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
LIB = ROOT / "src" / "lib"
HOOKS = ROOT / "src" / "hooks"
TYPES = ROOT / "src" / "integrations" / "supabase" / "types.ts"

MIGRATION = MIGRATIONS / "20261006160000_payment_request_requires_receipt.sql"
HELPER = LIB / "payment-request-receipt.ts"
HELPER_TEST = LIB / "payment-request-receipt.test.ts"
HOOK = HOOKS / "usePaymentRequests.ts"

RPC_SIGNATURE = "public.set_payment_request_requires_receipt(uuid, boolean, text)"

# Existing functions that must never be redefined by this slice.
PROTECTED_FUNCTIONS = (
    "approve_payment_requests_with_unc",
    "approve_payment_request_with_material_controller",
    "record_payment_allocations",
    "reject_payment_request",
    "finalize_goods_receipt",
)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    migration = read(MIGRATION)
    helper = read(HELPER)
    helper_test = read(HELPER_TEST)
    hook = read(HOOK)
    types = read(TYPES)

    # --- Migration: additive columns with default true -----------------------
    assert_true(
        "alter table public.payment_requests" in migration
        and "add column if not exists requires_receipt boolean not null default true" in migration,
        "migration must add requires_receipt boolean not null default true",
    )
    for column in (
        "add column if not exists no_receipt_reason text",
        "add column if not exists no_receipt_set_by uuid",
        "add column if not exists no_receipt_set_at timestamptz",
    ):
        assert_true(column in migration, f"migration must add {column}")
    assert_true(
        migration.index("requires_receipt boolean not null default true") < migration.index("add column if not exists no_receipt_reason"),
        "requires_receipt column must be declared with its default",
    )

    # --- Migration: reason check constraint ---------------------------------
    assert_true(
        "requires_receipt = true or length(btrim(no_receipt_reason)) >= 3" in migration,
        "migration must enforce the min-3-char reason check",
    )
    assert_true(
        "no_receipt_reason is not null" in migration,
        "migration must also reject a null reason for no-receipt rows",
    )

    # --- Migration: SECURITY DEFINER RPC shape ------------------------------
    assert_true(
        "create or replace function public.set_payment_request_requires_receipt(" in migration,
        "migration must declare the toggle RPC",
    )
    for arg in ("p_request_id uuid", "p_requires_receipt boolean", "p_reason text"):
        assert_true(arg in migration, f"RPC must take {arg}")
    assert_true("security definer" in migration, "RPC must be security definer")
    assert_true(
        "set search_path = public, pg_temp" in migration,
        "RPC must pin search_path to public, pg_temp",
    )
    assert_true("for update" in migration, "RPC must lock the payment request FOR UPDATE")

    # --- Migration: permission + fail-closed error codes ---------------------
    assert_true(
        "public.has_role(v_actor, 'owner')" in migration
        and "public.has_module_permission(v_actor, 'payment_requests', 'edit')" in migration,
        "RPC must allow owner or payment_requests edit permission",
    )
    assert_true(
        "public.material_master_jwt_role()" in migration and "'service_role'" in migration,
        "RPC must allow trusted service_role automation",
    )
    assert_true(
        "'insufficient_privilege'" in migration and "errcode = '42501'" in migration,
        "RPC must fail closed with insufficient_privilege (42501)",
    )
    for code in ("request_not_found", "invalid_status", "receipt_linked", "reason_required"):
        assert_true(code in migration, f"RPC must raise {code}")

    # --- Migration: receipt_linked guard ------------------------------------
    assert_true(
        "v_pr.goods_receipt_id is not null or v_pr.purchase_order_id is not null" in migration,
        "RPC must refuse no-receipt when a goods receipt or PO is linked",
    )
    assert_true(
        "if not v_requires then" in migration,
        "receipt_linked must only apply when switching to no-receipt",
    )
    assert_true(
        "length(v_reason) < 3" in migration,
        "RPC must require a >= 3 char reason when switching to no-receipt",
    )

    # --- Migration: revoke/grant + audit append ------------------------------
    assert_true(
        f"revoke all on function {RPC_SIGNATURE} from public, anon;" in migration,
        "RPC must revoke execute from public/anon",
    )
    assert_true(
        f"grant execute on function {RPC_SIGNATURE} to authenticated, service_role;" in migration,
        "RPC must grant execute to authenticated/service_role",
    )
    assert_true(
        "insert into public.audit_logs (actor_id, action, target_id, metadata)" in migration,
        "RPC must use the existing audit_logs insert shape",
    )
    for column in ("no_receipt_set_by = v_actor", "no_receipt_set_at = now()"):
        assert_true(column in migration, f"RPC must record {column}")

    # --- Migration: no touches to money / approval / rejection ---------------
    for function in PROTECTED_FUNCTIONS:
        assert_true(
            f"create or replace function public.{function}" not in migration,
            f"migration must not redefine {function}",
        )
    for forbidden in (
        "update public.payments",
        "insert into public.payments",
        "delete from public.payments",
        "update public.payment_allocations",
        "insert into public.payment_allocations",
        "delete from public.payment_allocations",
        "update public.payment_request_items",
        "insert into public.payment_request_items",
    ):
        assert_true(forbidden not in migration, f"migration must not touch {forbidden}")
    assert_true(
        "cron.schedule" not in migration
        and "cron.unschedule" not in migration
        and "pg_cron" not in migration,
        "migration must not schedule any pg_cron job",
    )

    # --- Shared helper -------------------------------------------------------
    assert_true(
        "export function isReceiptRequired(" in helper
        and "request?.requires_receipt !== false" in helper,
        "helper must default to true when requires_receipt is missing",
    )
    assert_true(
        "export function paymentRequestCompletion(" in helper
        and "needsDelivery" in helper
        and "needsInvoice" in helper
        and "complete" in helper,
        "helper must expose paymentRequestCompletion {needsDelivery, needsInvoice, complete}",
    )
    assert_true(
        "return { needsDelivery: false, needsInvoice: false, complete: paid }" in helper,
        "no-receipt requests must never need delivery/invoice and complete when paid",
    )
    assert_true(
        "paymentRequestReceiptErrorCode" in helper,
        "helper must map toggle RPC errors to stable codes",
    )
    assert_true(
        "paymentRequestCompletion" in helper_test and "isReceiptRequired" in helper_test,
        "helper tests must cover isReceiptRequired + paymentRequestCompletion",
    )
    for case in ("legacy", "no-receipt", "goods requests paid without invoice"):
        assert_true(case in helper_test, f"helper tests must cover {case}")

    # --- Mutation hook + generated types ------------------------------------
    assert_true(
        'rpc("set_payment_request_requires_receipt"' in hook,
        "hook must call the toggle RPC",
    )
    assert_true(
        "export function useSetPaymentRequestRequiresReceipt" in hook,
        "hook must expose useSetPaymentRequestRequiresReceipt",
    )
    assert_true(
        'invalidateQueries({ queryKey: ["payment-requests"] })' in hook
        and 'invalidateQueries({ queryKey: ["payment-request"] })' in hook,
        "hook must invalidate payment-requests / payment-request queries",
    )
    assert_true(
        "paymentRequestReceiptErrorCode" in hook,
        "hook must map RPC errors to codes",
    )
    for field in (
        "requires_receipt: boolean",
        "no_receipt_reason: string | null",
        "no_receipt_set_at: string | null",
        "no_receipt_set_by: string | null",
    ):
        assert_true(field in types, f"types.ts must expose {field}")
    assert_true(
        "set_payment_request_requires_receipt: {" in types
        and "p_request_id: string" in types
        and "p_requires_receipt: boolean" in types
        and "p_reason: string | null" in types,
        "types.ts must expose the toggle RPC signature",
    )

    print("PASS: payment request requires_receipt server contracts hold")


if __name__ == "__main__":
    main()
