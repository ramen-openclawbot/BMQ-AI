#!/usr/bin/env python3
"""Static contract checks for the PO overpay guard + reconciliation flags.

These checks never connect to a database or Supabase. They guard that the
additive migration only adds the allowance table / two guard triggers / the
partial unique index / the review table / the read-only flag view, that the
existing business data is never rewritten, that the smoke test really applies
the migration inline and covers every required case, and that the edge function
maps the three new blocking error codes.
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
TESTS = ROOT / "supabase" / "tests"
FUNCTIONS = ROOT / "supabase" / "functions"
LIB = ROOT / "src" / "lib"
HOOKS = ROOT / "src" / "hooks"
TYPES = ROOT / "src" / "integrations" / "supabase" / "types.ts"

MIGRATION = MIGRATIONS / "20261011130000_finance_overpay_guard_and_flags.sql"
SMOKE = TESTS / "finance_overpay_guard_prod_smoke.sql"
APPROVE_RPC = FUNCTIONS / "payment-unc-approve" / "index.ts"
FLAGS_LIB = LIB / "finance-reconciliation-flags.ts"
FLAGS_TEST = LIB / "finance-reconciliation-flags.test.ts"
FLAGS_HOOK = HOOKS / "useFinanceReconciliationFlags.ts"

LABELS = (
    "po_overpaid",
    "po_over_requested",
    "pr_twin_created",
    "paid_without_bank_evidence",
    "paid_without_receipt",
    "receipt_confirmed_delivery_pending",
    "invoice_zero_amount",
)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    migration = read(MIGRATION)
    smoke = read(SMOKE)
    approve = read(APPROVE_RPC)
    flags_lib = read(FLAGS_LIB)
    flags_test = read(FLAGS_TEST)
    flags_hook = read(FLAGS_HOOK)
    types = read(TYPES)
    lower = migration.lower()

    # --- migration exists and is the expected timestamp ---------------------
    assert_true(
        MIGRATION.name == "20261011130000_finance_overpay_guard_and_flags.sql",
        "migration file must keep its timestamped name",
    )

    # --- 1. CEO allowance table --------------------------------------------
    assert_true(
        "create table if not exists public.purchase_order_overpay_allowances" in lower,
        "migration must create public.purchase_order_overpay_allowances",
    )
    assert_true(
        "extra_amount > 0" in lower,
        "allowance extra_amount must be constrained positive",
    )
    assert_true(
        "length(btrim(reason)) >= 5" in lower,
        "allowance reason must be at least 5 trimmed characters",
    )
    assert_true(
        "references public.purchase_orders(id)" in lower,
        "allowance must reference purchase_orders(id)",
    )
    assert_true(
        "default auth.uid()" in lower,
        "allowance created_by must default to auth.uid()",
    )

    # --- 2. owner-only SECURITY DEFINER RPC + explicit grants --------------
    assert_true(
        "function public.allow_purchase_order_overpay(" in lower,
        "migration must define allow_purchase_order_overpay",
    )
    assert_true("security definer" in lower, "new RPCs must be SECURITY DEFINER")
    assert_true(
        "set search_path = public" in lower,
        "new functions must set search_path = public",
    )
    assert_true(
        "has_role(v_actor, 'owner')" in lower,
        "allow_purchase_order_overpay must be owner-only",
    )
    assert_true(
        "revoke all on function public.allow_purchase_order_overpay" in lower,
        "allow RPC must revoke default execute",
    )
    assert_true(
        "grant execute on function public.allow_purchase_order_overpay" in lower,
        "allow RPC must grant execute explicitly",
    )
    assert_true(
        "grant select on public.purchase_order_overpay_allowances to authenticated" in lower,
        "allowance table must be selectable by authenticated",
    )
    assert_true(
        "revoke all on public.purchase_order_overpay_allowances from public, anon, authenticated"
        in lower,
        "allowance table must revoke direct client writes",
    )

    # --- 3. payment_allocations guard --------------------------------------
    marker = "create trigger trg_guard_payment_allocation_po_total"
    assert_true(marker in lower, "migration must create the allocation guard trigger")
    start = lower.index(marker)
    trigger_stmt = lower[start:lower.index(";", start)]
    assert_true(
        "before insert or update of amount, payment_request_id" in trigger_stmt,
        "allocation guard must be BEFORE INSERT OR UPDATE OF amount, payment_request_id",
    )
    assert_true(
        "delete" not in trigger_stmt,
        "allocation guard must not run on DELETE",
    )
    assert_true(
        "where po.id = v_po_id\n  for update" in lower or "for update" in lower,
        "allocation guard must lock the purchase order FOR UPDATE",
    )
    assert_true("'po_overpaid'" in migration, "allocation guard must raise po_overpaid")
    assert_true(
        "round(v_candidate)" in lower and "round(coalesce(v_po_total" in lower,
        "allocation guard must compare rounded amounts",
    )
    assert_true(
        "tg_op = 'delete'" in lower,
        "allocation guard function must defensively skip DELETE",
    )

    # --- 4. payment_requests over-request guard ----------------------------
    assert_true(
        "create trigger trg_guard_payment_request_po_total" in lower,
        "migration must create the payment request guard trigger",
    )
    assert_true(
        "before insert or update of purchase_order_id, total_amount, status" in lower,
        "payment request guard must watch insert or the three columns",
    )
    assert_true("'po_over_requested'" in migration, "request guard must raise po_over_requested")
    assert_true(
        "old.status::text = 'rejected'" in lower and "new.status::text <> 'rejected'" in lower,
        "request guard must only re-check a rejected -> open reopen",
    )
    assert_true(
        "if new.status::text = 'rejected' or v_po_id is null then" in lower,
        "request guard must skip rejected rows and PO-less rows",
    )

    # --- 5. one open request per goods receipt -----------------------------
    assert_true(
        "create unique index if not exists uq_payment_requests_goods_receipt_open" in lower,
        "migration must create the partial unique goods receipt index",
    )
    assert_true(
        "where goods_receipt_id is not null and status <> 'rejected'" in lower,
        "goods receipt index must be partial on non-rejected rows",
    )
    assert_true(
        "raise exception 'goods_receipt_already_requested'" in lower,
        "migration must pre-check duplicate goods receipts",
    )

    # --- 6. review table + RPC ---------------------------------------------
    assert_true(
        "create table if not exists public.finance_reconciliation_reviews" in lower,
        "migration must create finance_reconciliation_reviews",
    )
    assert_true(
        "check (status in ('checked', 'false_alarm', 'needs_action'))" in lower,
        "review status must be constrained to the three CEO states",
    )
    assert_true(
        "function public.review_finance_reconciliation_flag(" in lower,
        "migration must define review_finance_reconciliation_flag",
    )
    assert_true(
        "on conflict (flag_key) do update" in lower,
        "review RPC must upsert by flag_key",
    )
    assert_true(
        "grant select on public.finance_reconciliation_reviews to authenticated" in lower,
        "review table must be selectable by authenticated",
    )
    assert_true(
        "grant execute on function public.review_finance_reconciliation_flag" in lower,
        "review RPC must grant execute explicitly",
    )

    # --- 7. read-only flag view --------------------------------------------
    assert_true(
        "create view public.finance_reconciliation_flags" in lower,
        "migration must create finance_reconciliation_flags",
    )
    assert_true(
        "security_invoker = true" in lower,
        "flag view must be security_invoker",
    )
    assert_true(
        "grant select on public.finance_reconciliation_flags to authenticated" in lower,
        "flag view must be selectable by authenticated",
    )
    for label in LABELS:
        assert_true(
            f"'{label}'" in migration,
            f"flag view must emit the {label} label",
        )
    for column in (
        "flag_key",
        "priority",
        "category",
        "entity_type",
        "entity_id",
        "entity_ref",
        "supplier_id",
        "supplier_name",
        "group_key",
        "amount",
        "evidence",
        "detected_at",
        "review_status",
        "review_note",
    ):
        assert_true(column in lower, f"flag view must expose the {column} column")

    # --- 8. existing business data is never rewritten ----------------------
    for forbidden in (
        "update public.payment_requests",
        "update public.payment_allocations",
        "update public.payments",
        "update public.purchase_orders",
        "update public.goods_receipts",
        "update public.invoices",
        "delete from public.payment_requests",
        "delete from public.payment_allocations",
        "delete from public.payments",
        "delete from public.purchase_orders",
        "delete from public.goods_receipts",
        "delete from public.invoices",
    ):
        assert_true(
            forbidden not in lower,
            f"migration must not mutate existing business data ({forbidden})",
        )
    assert_true(
        "finance_zalo_notifications" not in migration,
        "migration must not enqueue a new notification",
    )
    assert_true("cron.schedule" not in migration, "migration must not schedule cron")
    assert_true("pg_cron" not in migration, "migration must not use pg_cron")

    # --- 9. smoke applies the migration inline and covers every case -------
    assert_true(smoke.startswith("--"), "smoke must start with a comment header")
    assert_true("\nbegin;" in smoke, "smoke must open one transaction")
    assert_true(
        "create table if not exists public.purchase_order_overpay_allowances" in smoke,
        "smoke must inline the migration",
    )
    assert_true(
        "create trigger trg_guard_payment_allocation_po_total" in smoke,
        "smoke must inline the allocation guard",
    )
    assert_true(
        migration.strip() in smoke,
        "smoke must inline the migration byte-for-byte (regenerate it when the migration changes)",
    )
    assert_true("SMOKE_RESULT PASS" in smoke, "smoke must raise SMOKE_RESULT PASS")
    assert_true("SMOKE_RESULT FAIL" in smoke, "smoke must raise SMOKE_RESULT FAIL on a bad step")
    for step in (
        "a_exact_po_pay",
        "b_po_overpaid",
        "c_po_over_requested",
        "d_goods_receipt_already_requested",
        "e_allow_pass",
        "e_allow_block",
        "f_reject_over_limit",
        "g_po_overpaid_PO000340",
        "g_pr_twin_created",
    ):
        assert_true(step in smoke, f"smoke must cover the {step} step")
    assert_true(
        "PO-000340" in smoke and "PO-000144" in smoke and "PO-000197" in smoke,
        "smoke must assert the real PO-000340 / twin labels",
    )
    assert_true(
        "public.allow_purchase_order_overpay(v_po, 50000, 'SMOKE CEO allowance')" in smoke,
        "smoke must exercise the allowance RPC",
    )

    # --- 10. edge maps the three blocking codes ----------------------------
    for code in ("po_overpaid", "po_over_requested", "goods_receipt_already_requested"):
        assert_true(code in approve, f"payment-unc-approve must expose {code}")
    assert_true(
        "uq_payment_requests_goods_receipt_open" in approve,
        "payment-unc-approve must map the partial unique index violation",
    )
    assert_true(
        'po_overpaid: { status: 409, code: "po_overpaid" }' in approve,
        "po_overpaid must map to HTTP 409",
    )
    assert_true(
        'po_over_requested: { status: 409, code: "po_over_requested" }' in approve,
        "po_over_requested must map to HTTP 409",
    )
    assert_true(
        'goods_receipt_already_requested: { status: 409, code: "goods_receipt_already_requested" }'
        in approve,
        "goods_receipt_already_requested must map to HTTP 409",
    )

    # --- 11. pure lib + tests + hook + generated types ---------------------
    for vietnamese in (
        "Chi vượt PO",
        "Đề nghị vượt PO",
        "Phiếu tạo trùng",
        "Chi không có UNC",
        "Chi chưa nhập kho",
        "Đã nhập kho, phiếu ghi chưa giao",
        "Hóa đơn 0 đ",
    ):
        assert_true(vietnamese in flags_lib, f"lib must name the label '{vietnamese}'")
    assert_true(
        "export function sortFlags" in flags_lib and "export function groupFlags" in flags_lib,
        "lib must export sortFlags and groupFlags",
    )
    assert_true(
        "FINANCE_RECONCILIATION_ERROR_MESSAGES" in flags_lib,
        "lib must export the Vietnamese error message map",
    )
    assert_true(
        flags_test.count("test(") >= 8,
        "the lib test must cover at least 8 cases",
    )
    assert_true(
        "export function useFinanceReconciliationFlags" in flags_hook
        and "export function useReviewFinanceFlag" in flags_hook
        and "export function useAllowPurchaseOrderOverpay" in flags_hook,
        "hook must export the three named hooks",
    )
    assert_true(
        'from("finance_reconciliation_flags")' in flags_hook,
        "hook must read the flag view",
    )
    assert_true(
        "invalidateQueries" in flags_hook,
        "hook must invalidate the flag query after a review / allowance",
    )
    for entry in (
        "finance_reconciliation_reviews:",
        "purchase_order_overpay_allowances:",
        "finance_reconciliation_flags:",
        "allow_purchase_order_overpay:",
        "review_finance_reconciliation_flag:",
    ):
        assert_true(entry in types, f"types.ts must declare {entry}")

    print("PASS: finance overpay guard + reconciliation flags contracts hold")


if __name__ == "__main__":
    main()
