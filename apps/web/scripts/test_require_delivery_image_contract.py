#!/usr/bin/env python3
"""Static contract checks for the delivery-image-before-approval work.

These checks never connect to a database or Supabase and never run the trigger.
They guard that migration
20261012170000_require_delivery_image_before_approval.sql:
  * inserts the require_delivery_image_before_approval switch as true, idempotently;
  * defines a SECURITY DEFINER trigger function with a pinned search_path that
    only blocks the pending -> approved transition for a phiếu chi linked to a
    PO goods receipt when both gr.image_url and po.image_url are empty, raising
    'pr_requires_delivery_image: <receipt_number>' with errcode P0001;
  * attaches a BEFORE UPDATE OF status trigger on public.payment_requests;
  * revokes the trigger function from public/anon/authenticated;
  * never rewrites the approval RPCs, finalize_goods_receipt or
    auto_receive_goods_receipt.
It also checks that the rollback-only smoke test inlines the migration
byte-for-byte and covers every required step.
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
TESTS = ROOT / "supabase" / "tests"

MIGRATION = MIGRATIONS / "20261012170000_require_delivery_image_before_approval.sql"
SMOKE = TESTS / "require_delivery_image_prod_smoke.sql"

FUNCTION_NAME = "function public.guard_payment_request_delivery_image("
SWITCH_KEY = "require_delivery_image_before_approval"
ERROR_PREFIX = "pr_requires_delivery_image: "


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def function_body(text: str) -> str:
    """SQL from the trigger function definition to the end of its $$ body."""
    start = text.index(FUNCTION_NAME)
    end = text.index("$$;", start)
    return text[start:end]


def main() -> None:
    migration = read(MIGRATION)
    smoke = read(SMOKE)
    lower = migration.lower()

    # --- migration exists and keeps its timestamped name --------------------
    assert_true(
        MIGRATION.name == "20261012170000_require_delivery_image_before_approval.sql",
        "migration file must keep its timestamped name",
    )

    # --- 1. switch row, default true, idempotent ----------------------------
    assert_true(
        "insert into public.finance_settings" in lower,
        "migration must insert the new finance_settings switch",
    )
    assert_true(
        f"'{SWITCH_KEY}'" in lower,
        "the switch key must be require_delivery_image_before_approval",
    )
    assert_true(
        "'true'::jsonb" in lower,
        "the switch must default to true",
    )
    assert_true(
        "on conflict (key) do nothing" in lower,
        "the switch insert must be idempotent",
    )

    # --- 2. trigger function -------------------------------------------------
    assert_true(FUNCTION_NAME in lower, "migration must define the trigger function")
    body = function_body(lower)
    assert_true("security definer" in body, "the trigger function must be SECURITY DEFINER")
    assert_true(
        "set search_path = public, pg_temp" in body,
        "the trigger function must pin search_path = public, pg_temp",
    )
    assert_true(
        "new.status::text = 'approved'" in body,
        "the guard must require the new status to be approved",
    )
    assert_true(
        "old.status::text is distinct from 'approved'" in body,
        "the guard must skip a status that is already approved",
    )
    assert_true(
        "new.goods_receipt_id is not null" in body,
        "the guard must require a linked goods receipt",
    )
    assert_true(
        SWITCH_KEY in body,
        "the guard must read the require_delivery_image_before_approval switch",
    )
    assert_true(
        "coalesce(nullif(gr.image_url, ''), nullif(po.image_url, ''))" in body,
        "the guard must fall back from gr.image_url to po.image_url",
    )
    assert_true(
        "raise exception 'pr_requires_delivery_image: %'" in body,
        "the guard must raise 'pr_requires_delivery_image: %'",
    )
    assert_true(
        "using errcode = 'p0001'" in body,
        "the guard must raise errcode P0001",
    )
    assert_true(
        "gr.receipt_number" in body,
        "the raise must report the goods receipt number",
    )

    # --- 3. trigger ----------------------------------------------------------
    assert_true(
        "create trigger trg_guard_payment_request_delivery_image" in lower,
        "migration must create trg_guard_payment_request_delivery_image",
    )
    assert_true(
        "before update of status on public.payment_requests" in lower,
        "the trigger must be BEFORE UPDATE OF status on payment_requests",
    )
    assert_true(
        "for each row" in lower,
        "the trigger must run FOR EACH ROW",
    )
    assert_true(
        "execute function public.guard_payment_request_delivery_image()" in lower,
        "the trigger must execute the guard function",
    )

    # --- 4. revoke from every client role -----------------------------------
    assert_true(
        "revoke all on function public.guard_payment_request_delivery_image() from public, anon, authenticated"
        in lower,
        "the trigger function must be revoked from public, anon and authenticated",
    )

    # --- 5. never rewrite the approval / receive functions ------------------
    for forbidden in (
        "create or replace function public.approve_payment_request_with_material_controller(",
        "create or replace function public.approve_payment_requests_with_unc(",
        "create or replace function public.finalize_goods_receipt(",
        "create or replace function public.auto_receive_goods_receipt(",
    ):
        assert_true(forbidden not in lower, f"migration must not redefine {forbidden}")

    # --- 6. never mutate existing business rows -----------------------------
    for forbidden in (
        "update public.payment_requests",
        "delete from public.payment_requests",
        "insert into public.payment_requests",
        "update public.goods_receipts",
        "delete from public.goods_receipts",
        "update public.purchase_orders",
        "delete from public.purchase_orders",
    ):
        assert_true(forbidden not in lower, f"migration must not write {forbidden}")

    # --- 7. smoke inlines the migration and covers every step ---------------
    assert_true(smoke.startswith("--"), "smoke must start with a comment header")
    assert_true("\nbegin;" in smoke, "smoke must open one transaction")
    assert_true("\nrollback;" not in smoke.lower(), "smoke must roll back via the final RAISE")
    assert_true("\ncommit;" not in smoke.lower(), "smoke must not commit")
    assert_true(
        migration.strip() in smoke,
        "smoke must inline the migration byte-for-byte (regenerate it when the migration changes)",
    )
    assert_true("SMOKE_RESULT PASS" in smoke, "smoke must raise SMOKE_RESULT PASS")
    assert_true("SMOKE_RESULT FAIL" in smoke, "smoke must raise SMOKE_RESULT FAIL on a bad step")
    for step in ("a_", "b_", "c_", "d_", "e_"):
        assert_true(step in smoke, f"smoke must cover the {step} step")
    assert_true(
        "approve_payment_request_with_material_controller(v_missing_id, 'bank_transfer', v_owner)" in smoke,
        "smoke must exercise the canonical approval RPC",
    )
    assert_true(
        "update public.finance_settings" in smoke and "'false'::jsonb" in smoke,
        "smoke must turn the switch off and approve again",
    )

    print("PASS: require delivery image before approval contracts hold")


if __name__ == "__main__":
    main()
