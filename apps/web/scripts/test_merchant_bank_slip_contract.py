#!/usr/bin/env python3
"""Static contract checks for the merchant bank-slip payment migration.

The checks are text-only: they never connect to Supabase and never apply the
migration. They guard the security and write-boundary promises of:

  * extending merchant_staged_changes with kind 'bank_slip_payment',
  * merchant_prepare_bank_slip_request(uuid),
  * merchant_finalize_bank_slip_payment(uuid, text).
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = (
    ROOT
    / "supabase"
    / "migrations"
    / "20261103450000_merchant_bank_slip_payment.sql"
)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def function_block(sql: str, signature: str) -> str:
    marker = f"create or replace function {signature}"
    start = sql.lower().index(marker)
    end = sql.index("$$;", start) + len("$$;")
    return sql[start:end]


def main() -> None:
    sql = read(MIGRATION)
    lowered = sql.lower()

    prepare = function_block(
        sql, "public.merchant_prepare_bank_slip_request(\n  p_change_id uuid\n)"
    )
    finalize = function_block(
        sql,
        "public.merchant_finalize_bank_slip_payment(\n  p_change_id uuid,\n  p_category_code text\n)",
    )

    # --- Kind is added without dropping the existing kinds -------------------
    assert_true(
        "merchant_staged_changes_kind_check" in sql,
        "migration must recreate merchant_staged_changes_kind_check",
    )
    for kind in ("listing", "price", "inventory", "promotion", "campaign", "bank_slip_payment"):
        assert_true(
            f"'{kind}'" in sql,
            f"kind check must keep/add {kind}",
        )

    # --- Both functions are SECURITY DEFINER with a pinned search_path --------
    for name, block in (
        ("merchant_prepare_bank_slip_request", prepare),
        ("merchant_finalize_bank_slip_payment", finalize),
    ):
        low = block.lower()
        assert_true("security definer" in low, f"{name} must be security definer")
        assert_true(
            "set search_path = public, pg_temp" in low,
            f"{name} must pin search_path",
        )
        assert_true("for update" in low, f"{name} must lock the change row FOR UPDATE")

    # --- Service-role-only grants -------------------------------------------
    for signature in (
        "public.merchant_prepare_bank_slip_request(uuid)",
        "public.merchant_finalize_bank_slip_payment(uuid, text)",
    ):
        assert_true(
            f"revoke all on function {signature}" in lowered,
            f"revoke all on {signature}",
        )
        assert_true(
            f"grant execute on function {signature}" in lowered,
            f"grant execute on {signature}",
        )
    assert_true(lowered.count("to service_role;") >= 2, "both functions grant service_role")
    for forbidden in ("grant execute on function public.merchant_prepare_bank_slip_request(uuid)\n  to anon",
                      "grant execute on function public.merchant_finalize_bank_slip_payment(uuid, text)\n  to anon",
                      "grant execute on function public.merchant_prepare_bank_slip_request(uuid)\n  to authenticated",
                      "grant execute on function public.merchant_finalize_bank_slip_payment(uuid, text)\n  to authenticated"):
        assert_true(forbidden not in lowered, f"function must not be granted to {forbidden}")

    # --- Prepare is idempotent through payload.prepared_request_id ----------
    assert_true(
        "v_payload ->> 'prepared_request_id'" in prepare,
        "prepare must read payload.prepared_request_id",
    )
    assert_true(
        "'created', false" in prepare,
        "prepare must return the prior request on replay",
    )
    assert_true(
        "jsonb_set(" in prepare and "'{prepared_request_id}'" in prepare,
        "prepare must write prepared_request_id back into the payload",
    )
    assert_true(
        "for update" in prepare.lower(),
        "prepare must lock the change row",
    )

    # --- create_new request shape and transfer-month date -------------------
    assert_true(
        "false" in prepare
        and "Chi phí định kỳ, duyệt từ bankslip trong chat" in prepare,
        "create_new must save requires_receipt false with the no-receipt reason",
    )
    assert_true(
        "payment_method" in prepare and "'bank_transfer'" in prepare,
        "create_new must use bank_transfer",
    )
    assert_true(
        "at time zone 'Asia/Ho_Chi_Minh'" in prepare
        and "v_transfer_date" in prepare,
        "create_new must date the request in the slip transfer month",
    )
    assert_true(
        "payment_request_items" in prepare and "line_total" in prepare,
        "create_new must insert one payment_request_items line",
    )
    assert_true(
        "requires_receipt" in prepare and "no_receipt_set_by" in prepare,
        "create_new must set the no-receipt set_by/set_at fields",
    )

    # --- pay_existing re-verification ---------------------------------------
    for fragment in ("not_pending", "supplier_mismatch", "amount_mismatch"):
        assert_true(fragment in prepare, f"pay_existing must raise {fragment}")

    # --- Finalize approves the category and audits the write ----------------
    low_finalize = finalize.lower()
    assert_true(
        "review_status = 'approved'" in low_finalize
        or "'approved',\n        v_change.decided_by" in low_finalize,
        "finalize must write review_status approved",
    )
    assert_true(
        "reviewed_by = v_change.decided_by" in low_finalize,
        "finalize must set reviewed_by = decided_by",
    )
    assert_true(
        "classification_source = 'manual_override'" in low_finalize,
        "finalize must use manual_override",
    )
    assert_true(
        "confidence = 1" in low_finalize,
        "finalize must set confidence 1",
    )
    assert_true(
        "insert into public.cost_classification_audit_logs" in low_finalize,
        "finalize must write a cost_classification_audit_logs row",
    )
    assert_true(
        "skipped_multi_line" in finalize,
        "multi-line requests must skip classification",
    )
    assert_true(
        "status = 'applied'" in low_finalize and "applied_at = now()" in low_finalize,
        "finalize must mark the change applied",
    )
    assert_true(
        "'already_applied'" in finalize,
        "finalize must be idempotent when already applied",
    )

    # --- Neither function writes the payment/evidence tables ----------------
    for name, block in (
        ("prepare", prepare),
        ("finalize", finalize),
    ):
        low = block.lower()
        for table in ("public.payments", "public.payment_unc_evidence"):
            assert_true(
                f"insert into {table}" not in low,
                f"{name} must not insert into {table}",
            )

    print("PASS merchant bank slip payment contract")


if __name__ == "__main__":
    main()
