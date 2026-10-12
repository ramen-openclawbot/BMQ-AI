#!/usr/bin/env python3
"""Static contract checks for the cash payment-method lock work.

These checks never connect to a database or Supabase and never run the trigger.
They guard that migration ``*_lock_cash_pr_payment_method.sql``:
  * defines a SECURITY DEFINER trigger function with a pinned search_path that
    rejects dropping ``payment_method`` away from ``cash`` when the phiếu belongs
    to the new Chi tiền mặt flow (a public.cash_pr_idempotency row for old.id or
    old.cash_settlement_status is not null), raising
    ``'cash_pr_method_locked: <request_number>'`` with errcode P0001;
  * attaches a BEFORE UPDATE OF payment_method trigger on public.payment_requests
    after dropping any same-named trigger;
  * revokes the trigger function from public/anon/authenticated;
  * never rewrites the approval RPCs approved through the flow;
  * never writes existing business rows.
It also checks that the rollback-only smoke test inlines the migration
byte-for-byte and covers every required step.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
TESTS = ROOT / "supabase" / "tests"

SMOKE = TESTS / "lock_cash_pr_payment_method_prod_smoke.sql"

FUNCTION_NAME = "function public.guard_cash_pr_payment_method("
ERROR_PREFIX = "cash_pr_method_locked: "


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
    candidates = sorted(MIGRATIONS.glob("*_lock_cash_pr_payment_method.sql"))
    assert_true(len(candidates) == 1, "there must be exactly one cash-pr lock migration")
    migration_path = candidates[0]
    assert_true(
        re.fullmatch(r"\d{14}_lock_cash_pr_payment_method\.sql", migration_path.name) is not None,
        "migration file must keep a timestamped name",
    )

    migration = read(migration_path)
    smoke = read(SMOKE)
    lower = migration.lower()

    # --- 1. trigger function -------------------------------------------------
    assert_true(FUNCTION_NAME in lower, "migration must define guard_cash_pr_payment_method")
    body = function_body(lower)
    assert_true("security definer" in body, "the trigger function must be SECURITY DEFINER")
    assert_true(
        "set search_path = public, pg_temp" in body,
        "the trigger function must pin search_path = public, pg_temp",
    )
    assert_true(
        "old.payment_method::text = 'cash'" in body,
        "the guard must require the old payment method to be cash",
    )
    assert_true(
        "new.payment_method::text is distinct from 'cash'" in body,
        "the guard must require the new payment method to differ from cash",
    )
    assert_true(
        "public.cash_pr_idempotency" in body,
        "the guard must read the cash_pr_idempotency marker table",
    )
    assert_true(
        "cpi.payment_request_id = old.id" in body,
        "the idempotency marker must be matched by payment_request_id = old.id",
    )
    assert_true(
        "old.cash_settlement_status is not null" in body,
        "the guard must also treat a non-null cash_settlement_status as locked",
    )
    assert_true(
        f"raise exception '{ERROR_PREFIX}%'" in body,
        "the guard must raise 'cash_pr_method_locked: %'",
    )
    assert_true(
        "old.request_number" in body,
        "the raise must report old.request_number",
    )
    assert_true(
        "using errcode = 'p0001'" in body,
        "the guard must raise errcode P0001",
    )

    # --- 2. trigger ----------------------------------------------------------
    assert_true(
        "drop trigger if exists trg_guard_cash_pr_payment_method on public.payment_requests" in lower,
        "migration must drop any same-named trigger before creating it",
    )
    assert_true(
        "create trigger trg_guard_cash_pr_payment_method" in lower,
        "migration must create trg_guard_cash_pr_payment_method",
    )
    assert_true(
        "before update of payment_method on public.payment_requests" in lower,
        "the trigger must be BEFORE UPDATE OF payment_method on payment_requests",
    )
    assert_true("for each row" in lower, "the trigger must run FOR EACH ROW")
    assert_true(
        "execute function public.guard_cash_pr_payment_method()" in lower,
        "the trigger must execute the guard function",
    )

    # --- 3. revoke from every client role -----------------------------------
    assert_true(
        "revoke all on function public.guard_cash_pr_payment_method() from public, anon, authenticated"
        in lower,
        "the trigger function must be revoked from public, anon and authenticated",
    )

    # --- 4. never rewrite the approval RPCs ---------------------------------
    for forbidden in (
        "create or replace function public.approve_payment_request_with_material_controller(",
        "create or replace function public.approve_payment_requests_with_unc(",
    ):
        assert_true(forbidden not in lower, f"migration must not redefine {forbidden}")

    # --- 5. never mutate existing business rows -----------------------------
    for forbidden in (
        "update public.payment_requests",
        "delete from public.payment_requests",
        "insert into public.payment_requests",
        "update public.cash_pr_idempotency",
        "delete from public.cash_pr_idempotency",
        "insert into public.cash_pr_idempotency",
    ):
        assert_true(forbidden not in lower, f"migration must not write {forbidden}")

    # --- 6. smoke inlines the migration and covers every step ---------------
    assert_true(smoke.startswith("--"), "smoke must start with a comment header")
    assert_true("\nbegin;" in smoke, "smoke must open one transaction")
    assert_true("\ncommit;" not in smoke.lower(), "smoke must not commit")
    assert_true("\nrollback;" not in smoke.lower(), "smoke must not roll back explicitly")
    assert_true(
        migration.strip() in smoke,
        "smoke must inline the migration byte-for-byte (regenerate it when the migration changes)",
    )
    assert_true("SMOKE_RESULT PASS" in smoke, "smoke must raise SMOKE_RESULT PASS")
    assert_true("SMOKE_RESULT FAIL" in smoke, "smoke must raise SMOKE_RESULT FAIL on a bad step")
    for step in ("(a)", "(b)", "(c)", "(d)", "(e)"):
        assert_true(step in smoke, f"smoke must cover the {step[1]} step")
    for marker in ("a_", "b_", "c_", "d_", "e_"):
        assert_true(marker in smoke, f"smoke must mark the {marker[0]} step result")
    assert_true("request.jwt.claims" in smoke, "smoke must set the owner's request.jwt.claims")
    assert_true(
        "approve_payment_request_with_material_controller(v_idem_id, 'bank_transfer', v_owner)" in smoke,
        "smoke must exercise the canonical approval RPC with bank_transfer",
    )
    assert_true(ERROR_PREFIX in smoke, "smoke must assert the cash_pr_method_locked message")
    assert_true(
        "join public.cash_pr_idempotency" in smoke,
        "smoke must select a real phiếu that has a cash_pr_idempotency row",
    )

    print("PASS: lock cash pr payment method contracts hold")


if __name__ == "__main__":
    main()
