#!/usr/bin/env python3
"""Static contract checks for the receipt-status labels + PO-cancel receipts work.

These checks never connect to a database or Supabase and never run the cleanup.
They guard that migration 20261012140000:
  * makes both affected view branches status-aware ('received');
  * keeps the Jev duplicate branch and its rejected-phiếu exclusion verbatim;
  * redefines the PO-cancel trigger with po_cancel_has_payments and
    po_cancel_has_receipt;
  * adds an owner-only SECURITY DEFINER cleanup RPC with a pinned search_path;
  * only deletes placeholder receipts after the emptiness conditions, and never
    rewrites payment_allocations / payments / purchase_orders or invoices beyond
    clearing goods_receipt_id;
that the smoke test inlines the migration byte-for-byte and covers every case,
and that the shared lib names the new label and error code.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
TESTS = ROOT / "supabase" / "tests"
LIB = ROOT / "src" / "lib"

MIGRATION = MIGRATIONS / "20261012140000_receipt_status_labels_and_po_cancel_receipts.sql"
SMOKE = TESTS / "receipt_status_po_cancel_prod_smoke.sql"
FLAGS_LIB = LIB / "finance-reconciliation-flags.ts"
FLAGS_TEST = LIB / "finance-reconciliation-flags.test.ts"

EXPECTED_RECEIPTS = (
    "GRN-000272",
    "GRN-000298",
    "GRN-000376",
    "GRN-000383",
    "GRN-000394",
    "GRN-000418",
    "GRN-000419",
    "GRN-000452",
    "GRN-000453",
    "GRN-000469",
    "GRN-000511",
    "GRN-000513",
)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    migration = read(MIGRATION)
    smoke = read(SMOKE)
    flags_lib = read(FLAGS_LIB)
    flags_test = read(FLAGS_TEST)
    lower = migration.lower()

    # --- migration exists and is the expected timestamp ---------------------
    assert_true(
        MIGRATION.name == "20261012140000_receipt_status_labels_and_po_cancel_receipts.sql",
        "migration file must keep its timestamped name",
    )

    # --- 1. both view branches are status-aware ----------------------------
    assert_true(
        "function public.reject_payment_requests_on_po_cancel()" in lower,
        "migration must redefine the PO-cancel trigger function",
    )
    assert_true(
        "(pr.goods_receipt_id is null or gr.status::text <> 'received')" in migration,
        "paid_without_receipt must accept a linked receipt that is not yet received",
    )
    assert_true(
        "where gr.status::text = 'received'" in migration,
        "receipt_confirmed_delivery_pending must require a received receipt",
    )
    assert_true(
        migration.count("'received'") >= 2,
        "both receipt view branches must check the 'received' status",
    )

    # --- 2. Jev branch unchanged, including the rejected-phiếu exclusion ----
    assert_true(
        "jev_possible_duplicate" in migration,
        "migration must keep the Jev duplicate branch",
    )
    assert_true(
        "and pro.status::text <> 'rejected'" in migration
        and "and prn.status::text <> 'rejected'" in migration,
        "the Jev branch must keep excluding rejected phiếu",
    )
    assert_true(
        "c.review_decision is distinct from 'different_purchase'" in migration,
        "the Jev branch must keep the different_purchase exclusion",
    )

    # --- 3. trigger raises both cancel guard codes --------------------------
    assert_true(
        "'po_cancel_has_receipt: " in migration,
        "trigger must raise the po_cancel_has_receipt code",
    )
    assert_true(
        "'po_cancel_has_payments: " in migration,
        "trigger must keep raising po_cancel_has_payments",
    )
    assert_true(
        "create trigger trg_reject_payment_requests_on_po_cancel" in lower,
        "migration must recreate the PO-cancel trigger",
    )

    # --- 4. cleanup RPC: owner-only, SECURITY DEFINER, pinned search_path ---
    assert_true(
        "function public.cleanup_cancelled_po_placeholder_receipts(" in lower,
        "migration must define cleanup_cancelled_po_placeholder_receipts",
    )
    cleanup_start = lower.index("function public.cleanup_cancelled_po_placeholder_receipts(")
    cleanup_body = lower[cleanup_start:]
    assert_true("security definer" in cleanup_body, "cleanup RPC must be SECURITY DEFINER")
    assert_true(
        "set search_path = public, pg_temp" in cleanup_body,
        "cleanup RPC must pin search_path = public, pg_temp",
    )
    assert_true(
        "has_role(v_actor, 'owner')" in cleanup_body
        and "material_master_jwt_role()" in cleanup_body,
        "cleanup RPC must be owner-only (owner role or service_role)",
    )
    assert_true(
        "revoke all on function public.cleanup_cancelled_po_placeholder_receipts(boolean) from public, anon" in lower,
        "cleanup RPC must revoke default execute",
    )
    assert_true(
        "grant execute on function public.cleanup_cancelled_po_placeholder_receipts(boolean) to authenticated, service_role"
        in lower,
        "cleanup RPC must grant execute explicitly",
    )
    assert_true(
        "if p_dry_run then" in lower
        and "jsonb_build_object('eligible', v_eligible, 'skipped', v_skipped)" in lower
        and "jsonb_build_object('removed', v_eligible, 'skipped', v_skipped)" in lower,
        "cleanup RPC must return eligible/removed + skipped for dry-run and real mode",
    )

    # --- 5. DELETE only after the emptiness conditions ---------------------
    emptiness = lower.index("greatest(0, coalesce(gri.actual_quantity, gri.quantity, 0))")
    first_items_delete = lower.index("delete from public.goods_receipt_items")
    first_receipts_delete = lower.index("delete from public.goods_receipts")
    dry_run = lower.index("if p_dry_run then")
    last_receipts_delete = lower.rindex("delete from public.goods_receipts")
    assert_true(
        first_items_delete > emptiness,
        "goods_receipt_items DELETE must come after the empty-line condition",
    )
    assert_true(
        first_receipts_delete > first_items_delete,
        "goods_receipts DELETE must come after goods_receipt_items DELETE",
    )
    assert_true(
        last_receipts_delete > dry_run,
        "cleanup DELETE must come after the p_dry_run eligibility branch",
    )
    assert_true(
        lower.count("delete from public.goods_receipts") == 2,
        "exactly the trigger and the cleanup RPC may delete goods_receipts",
    )

    # --- 6. no forbidden writes to money / PO tables -----------------------
    for forbidden in (
        "update public.payment_allocations",
        "delete from public.payment_allocations",
        "update public.payments",
        "delete from public.payments",
        "update public.purchase_orders",
        "delete from public.purchase_orders",
        "delete from public.invoices",
    ):
        assert_true(
            forbidden not in lower,
            f"migration must not write {forbidden}",
        )
    for match in re.finditer(r"update public\.invoices\b([^;]*)", lower):
        body = match.group(1)
        assert_true(
            "set goods_receipt_id = null" in body,
            "the only invoices write allowed is clearing goods_receipt_id",
        )
    assert_true(
        lower.count("update public.invoices") == 2,
        "invoices may only be touched to clear goods_receipt_id (trigger + cleanup)",
    )
    assert_true(
        "update public.payment_requests" in lower
        and "set goods_receipt_id = null" in lower,
        "migration must clear payment_requests.goods_receipt_id",
    )
    assert_true(
        "update public.inventory_batches" in lower
        and "set goods_receipt_id = null" in lower,
        "migration must clear the other nullable FK to goods_receipts",
    )

    # --- 7. smoke covers every required case -------------------------------
    assert_true(smoke.startswith("--"), "smoke must start with a comment header")
    assert_true("\nbegin;" in smoke, "smoke must open one transaction")
    assert_true(
        migration.strip() in smoke,
        "smoke must inline the migration byte-for-byte (regenerate it when the migration changes)",
    )
    assert_true("SMOKE_RESULT PASS" in smoke, "smoke must raise SMOKE_RESULT PASS")
    assert_true("SMOKE_RESULT FAIL" in smoke, "smoke must raise SMOKE_RESULT FAIL on a bad step")
    for step in (
        "a_receipt_label_count",
        "a_receipt_label_status",
        "b_cleanup_eligible",
        "c_placeholder_not_removed",
        "c_request_not_rejected",
        "d_po_cancel_has_receipt",
        "e_po_cancel_has_payments",
        "f_label_changed",
    ):
        assert_true(step in smoke, f"smoke must cover the {step} step")
    assert_true("PO-000711" in smoke, "smoke must prefer the live PO-000711 placeholder")
    assert_true("PO-000340" in smoke, "smoke must keep the PO-000340 has_payments case")
    for receipt in EXPECTED_RECEIPTS:
        assert_true(receipt in smoke, f"smoke must list the legacy placeholder {receipt}")
    assert_true(
        "cleanup_cancelled_po_placeholder_receipts(true)" in smoke,
        "smoke must exercise the cleanup dry run",
    )

    # --- 8. shared lib / test naming ---------------------------------------
    assert_true(
        'paid_without_receipt: "Chi khi chưa nhập kho"' in flags_lib,
        "lib must rename paid_without_receipt to 'Chi khi chưa nhập kho'",
    )
    assert_true(
        'receipt_confirmed_delivery_pending: "Đã nhập kho, phiếu ghi chưa giao"' in flags_lib,
        "lib must keep the receipt_confirmed_delivery_pending name",
    )
    assert_true(
        "po_cancel_has_receipt" in flags_lib,
        "lib must map the po_cancel_has_receipt error message",
    )
    assert_true(
        '"Chi khi chưa nhập kho"' in flags_test and "po_cancel_has_receipt" in flags_test,
        "the lib test must cover the renamed label and the new error code",
    )

    print("PASS: receipt status labels + PO cancel receipts contracts hold")


if __name__ == "__main__":
    main()
