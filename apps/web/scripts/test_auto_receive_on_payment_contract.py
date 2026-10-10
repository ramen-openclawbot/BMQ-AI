#!/usr/bin/env python3
"""Static contract checks for the auto-receive-on-payment work.

These checks never connect to a database or Supabase and never run the backfill.
They guard that migration 20261012160000_auto_receive_on_payment.sql:
  * wraps the finalize call in an EXCEPTION block and always resets bmq.auto_receive;
  * redefines enqueue_finance_zalo_goods_receipt with the 'suppressed' branch;
  * fires the new trigger only when payment_status transitions to 'paid' and wraps
    its whole body in an EXCEPTION so it can never break the payment transaction;
  * adds owner-only SECURITY DEFINER RPCs with a pinned search_path and explicit
    revoke/grant;
  * creates the new tables with explicit grants;
  * never rewrites payment_allocations / payments, finalize_goods_receipt or
    auto_issue_goods_receipt.
It also checks that the rollback-only smoke test inlines the migration byte-for-byte
and covers every required step.
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
TESTS = ROOT / "supabase" / "tests"

MIGRATION = MIGRATIONS / "20261012160000_auto_receive_on_payment.sql"
SMOKE = TESTS / "auto_receive_on_payment_prod_smoke.sql"

AUTO_RECEIVE = "function public.auto_receive_goods_receipt("
ENQUEUE = "function public.enqueue_finance_zalo_goods_receipt("
TRIGGER_FN = "function public.auto_receive_on_payment("
SET_SETTING = "function public.set_finance_setting("
BACKFILL = "function public.backfill_auto_receive_paid("


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def body_after(text: str, marker: str) -> str:
    """Return the SQL from marker to the end of that function ($;$)."""
    start = text.index(marker)
    end = text.index("$$;", start)
    return text[start:end]


def main() -> None:
    migration = read(MIGRATION)
    smoke = read(SMOKE)
    lower = migration.lower()

    # --- migration exists and keeps its timestamped name --------------------
    assert_true(
        MIGRATION.name == "20261012160000_auto_receive_on_payment.sql",
        "migration file must keep its timestamped name",
    )

    # --- 1. auto_receive_goods_receipt: EXCEPTION wraps finalize, bmq flag ---
    assert_true(AUTO_RECEIVE in lower, "migration must define auto_receive_goods_receipt")
    auto_body = body_after(lower, AUTO_RECEIVE)
    assert_true("security definer" in auto_body, "auto_receive must be SECURITY DEFINER")
    assert_true(
        "set search_path = public, pg_temp" in auto_body,
        "auto_receive must pin search_path = public, pg_temp",
    )
    assert_true(
        "perform public.finalize_goods_receipt(p_receipt_id, p_actor)" in auto_body,
        "auto_receive must call finalize_goods_receipt with the actor",
    )
    finalize_pos = auto_body.index("perform public.finalize_goods_receipt(p_receipt_id, p_actor)")
    exception_pos = auto_body.index("exception when others")
    assert_true(
        finalize_pos < exception_pos,
        "the finalize call must be inside BEGIN ... EXCEPTION WHEN others",
    )
    assert_true(
        "left(sqlerrm, 300)" in auto_body,
        "the failed branch must record left(sqlerrm, 300)",
    )
    assert_true(
        "set_config('bmq.auto_receive', 'on', true)" in auto_body
        and "set_config('bmq.auto_receive', 'off', true)" in auto_body,
        "auto_receive must set bmq.auto_receive on during finalize and off afterwards",
    )
    assert_true(
        "if v_status is null" in auto_body or "v_status is null" in auto_body,
        "auto_receive must skip a missing already-received receipt",
    )
    assert_true(
        "v_status = 'received'" in auto_body
        and "v_finalized_at is not null" in auto_body
        and "v_payable_status is distinct from 'not_generated'" in auto_body
        and "not v_has_ordered" in auto_body,
        "auto_receive must skip received / finalized / non-not_generated / no-ordered-line receipts",
    )
    assert_true(
        "grant execute on function public.auto_receive_goods_receipt(uuid, uuid, uuid, text) to service_role"
        in lower,
        "auto_receive must grant execute to service_role only",
    )
    assert_true(
        "grant execute on function public.auto_receive_goods_receipt(uuid, uuid, uuid, text) to authenticated"
        not in lower,
        "auto_receive must never grant execute to authenticated",
    )

    # --- 2. enqueue Zalo keeps its logic and adds the suppressed branch ------
    assert_true(ENQUEUE in lower, "migration must redefine enqueue_finance_zalo_goods_receipt")
    enqueue_body = body_after(lower, ENQUEUE)
    assert_true(
        "case when current_setting('bmq.auto_receive', true) = 'on' then 'suppressed' else 'pending' end"
        in enqueue_body,
        "the Zalo enqueue must use 'suppressed' only while bmq.auto_receive is on",
    )
    assert_true(
        "on conflict (event_type, entity_id) do nothing" in enqueue_body,
        "the Zalo enqueue must keep its conflict guard",
    )
    assert_true(
        "build_finance_zalo_goods_receipt_message" in enqueue_body,
        "the Zalo enqueue must keep its message builder",
    )

    # --- 3. payment trigger only on the paid transition + outer EXCEPTION ---
    assert_true(
        "create trigger trg_auto_receive_on_payment" in lower,
        "migration must create trg_auto_receive_on_payment",
    )
    assert_true(
        "after update of payment_status on public.payment_requests" in lower,
        "the trigger must be AFTER UPDATE OF payment_status on payment_requests",
    )
    trigger_pos = lower.index(TRIGGER_FN)
    trigger_body = lower[trigger_pos:]
    assert_true(
        "new.payment_status::text = 'paid'" in trigger_body,
        "the trigger must require new.payment_status = 'paid'",
    )
    assert_true(
        "old.payment_status::text is distinct from 'paid'" in trigger_body,
        "the trigger must require old.payment_status distinct from 'paid'",
    )
    assert_true(
        "new.status::text <> 'rejected'" in trigger_body,
        "the trigger must skip rejected phiếu",
    )
    assert_true(
        "coalesce(auth.uid(), new.approved_by)" in trigger_body,
        "the trigger actor must be coalesce(auth.uid(), new.approved_by)",
    )
    assert_true(
        "exception when others" in trigger_body and "raise warning" in trigger_body,
        "the whole trigger body must be wrapped in EXCEPTION ... RAISE WARNING",
    )
    assert_true(
        "gr.purchase_order_id = new.purchase_order_id" in trigger_body
        and "gr.status::text <> 'received'" in trigger_body,
        "a null goods_receipt_id must fall back to the PO's not-received receipts",
    )

    # --- 4. owner-only SECURITY DEFINER RPCs with pinned search_path --------
    for marker, signature in (
        (SET_SETTING, "set_finance_setting(text, jsonb)"),
        (BACKFILL, "backfill_auto_receive_paid(boolean)"),
    ):
        assert_true(marker in lower, f"migration must define {marker}")
        rpc = body_after(lower, marker)
        assert_true("security definer" in rpc, f"{signature} must be SECURITY DEFINER")
        assert_true(
            "set search_path = public, pg_temp" in rpc,
            f"{signature} must pin search_path = public, pg_temp",
        )
        assert_true(
            "public.has_role(v_actor, 'owner')" in rpc,
            f"{signature} must check the owner role",
        )
        assert_true(
            "material_master_jwt_role()" in rpc,
            f"{signature} must allow the service_role JWT",
        )
        assert_true(
            f"revoke all on function public.{signature} from public, anon" in lower,
            f"{signature} must revoke default execute from public/anon",
        )
        assert_true(
            f"grant execute on function public.{signature} to authenticated" in lower,
            f"{signature} must grant execute to authenticated (self-checked owner)",
        )

    # --- 5. explicit grants for the new tables ------------------------------
    assert_true(
        "grant select on public.finance_settings to authenticated" in lower,
        "finance_settings must be explicitly selectable by authenticated",
    )
    assert_true(
        "grant select on public.goods_receipt_auto_receive_log to authenticated" in lower,
        "goods_receipt_auto_receive_log must be explicitly selectable by authenticated",
    )
    assert_true(
        "revoke all on public.finance_settings from public, anon, authenticated" in lower,
        "finance_settings writes must be revoked from clients",
    )
    assert_true(
        "revoke all on public.goods_receipt_auto_receive_log from public, anon, authenticated" in lower,
        "the auto-receive log writes must be revoked from clients",
    )
    assert_true(
        "enable row level security" in lower
        and lower.count("enable row level security") >= 2,
        "both new tables must enable row level security",
    )
    assert_true(
        "has_module_permission((select auth.uid()), 'payment_requests', 'view')" in lower,
        "the auto-receive log must be readable by payment_requests viewers",
    )

    # --- 6. never touch money/payment tables or the finalize/auto-issue flow -
    for forbidden in (
        "update public.payment_allocations",
        "delete from public.payment_allocations",
        "insert into public.payment_allocations",
        "update public.payments",
        "delete from public.payments",
        "insert into public.payments",
    ):
        assert_true(forbidden not in lower, f"migration must not write {forbidden}")
    assert_true(
        "create or replace function public.finalize_goods_receipt(" not in lower,
        "migration must not redefine finalize_goods_receipt",
    )
    assert_true(
        "create or replace function public.auto_issue_goods_receipt(" not in lower,
        "migration must not redefine auto_issue_goods_receipt",
    )

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
    for step in (
        "a_dry_run",
        "b_no_received",
        "b_zalo_suppressed",
        "c_skipped",
        "d_trigger_on",
        "d_trigger_off",
        "e_zalo_pending",
    ):
        assert_true(step in smoke, f"smoke must cover the {step} step")
    assert_true(
        "backfill_auto_receive_paid(true)" in smoke,
        "smoke must exercise the backfill dry run",
    )
    assert_true(
        "auto_receive_goods_receipt(gr_id, v_pr_id, v_owner, 'backfill')" in smoke
        or "auto_receive_goods_receipt(v_gr_id, v_pr_id, v_owner, 'backfill')" in smoke,
        "smoke must run the backfill with source 'backfill'",
    )
    assert_true(
        "limit 10" in smoke,
        "smoke's real backfill must be capped at 10 receipts",
    )

    print("PASS: auto receive on payment contracts hold")


if __name__ == "__main__":
    main()
