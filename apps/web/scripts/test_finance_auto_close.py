#!/usr/bin/env python3
"""Static contract tests for the finance daily auto-close database layer."""
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20260731090000_finance_auto_approval_close.sql"
CHAIN_PATCH = ROOT / "supabase/migrations/20260731104500_finance_auto_close_full_prior_chain.sql"
FINAL_PATCH = ROOT / "supabase/migrations/20260731130000_finance_auto_close_unc_qtm_only.sql"
SHADOW_RECHECK = ROOT / "supabase/migrations/20260731131000_finance_auto_close_recheck_first_10_shadow.sql"
ENFORCED_BATCH = ROOT / "supabase/migrations/20260731132000_finance_auto_close_first_10_unc_qtm.sql"
CARRY_FORWARD_PATCH = ROOT / "supabase/migrations/20260731133000_finance_auto_close_qtm_carry_forward.sql"


def read_migration() -> str:
    assert MIGRATION.exists(), f"Missing migration: {MIGRATION}"
    return MIGRATION.read_text(encoding="utf-8")


def compact(sql: str) -> str:
    return re.sub(r"\s+", " ", sql.lower())


def function_body(sql: str) -> str:
    match = re.search(
        r"create\s+or\s+replace\s+function\s+public\.finance_auto_close_day\b.*?\$\$(.*?)\$\$",
        sql,
        flags=re.IGNORECASE | re.DOTALL,
    )
    assert match, "Missing finance_auto_close_day RPC body"
    return match.group(1)


def assert_ordered(haystack: str, needles: list[str]) -> None:
    cursor = -1
    for needle in needles:
        next_pos = haystack.find(needle, cursor + 1)
        assert next_pos > cursor, f"Expected {needle!r} after position {cursor}"
        cursor = next_pos


def test_tables_audit_columns_rls_and_idempotency_contracts():
    sql = read_migration()
    lower = compact(sql)

    assert "create table if not exists public.finance_daily_close_runs" in lower
    assert "create table if not exists public.finance_payment_auto_approval_matches" in lower
    for column in (
        "created_at timestamptz not null default now()",
        "created_by text not null default 'system_finance_cron'",
        "updated_at timestamptz not null default now()",
        "updated_by text not null default 'system_finance_cron'",
    ):
        assert column in lower

    assert "references public.finance_daily_close_runs(id) on delete cascade" in lower
    assert "references public.payment_requests(id) on delete set null" in lower
    assert "create unique index if not exists uq_finance_daily_close_runs_active_final" in lower
    assert "on public.finance_daily_close_runs(closing_date, mode)" in lower
    assert "where status in ('running', 'succeeded')" in lower
    assert "alter table public.drive_file_index" not in lower

    for table in (
        "finance_daily_close_runs",
        "finance_payment_auto_approval_matches",
    ):
        assert f"alter table public.{table} enable row level security" in lower
        assert f"grant select on public.{table} to authenticated" in lower
        assert f"grant select, insert, update, delete on public.{table} to service_role" in lower

    assert "has_role((select auth.uid()), 'owner'::public.app_role)" in lower
    assert "has_module_permission((select auth.uid()), 'payment_requests', 'view')" in lower
    assert "using (false)" not in lower


def test_app_settings_defaults_use_actual_key_value_schema_idempotently():
    sql = read_migration()
    lower = compact(sql)

    assert "insert into public.app_settings (key, value, updated_at)" in lower
    for key, value in (
        ("finance_auto_approve_enabled", "false"),
        ("finance_auto_close_enabled", "false"),
        ("finance_auto_close_mode", "shadow"),
        ("finance_auto_close_time_vn", "00:10"),
    ):
        assert f"'{key}', '{value}'" in lower
    assert "on conflict (key) do nothing" in lower
    assert "config_key" not in lower
    assert "setting_key" not in lower


def test_rpc_security_grants_locking_and_top_level_validation():
    sql = read_migration()
    lower = compact(sql)
    body = compact(function_body(sql))

    assert "create or replace function public.finance_auto_close_day(" in lower
    assert "p_closing_date date" in lower
    assert "p_mode text" in lower
    assert "p_snapshot jsonb" in lower
    assert "p_actor text default 'system_finance_cron'" in lower
    assert "returns jsonb" in lower
    assert "security definer" in lower
    assert "set search_path = public, pg_temp" in lower
    assert "revoke all on function public.finance_auto_close_day(date, text, jsonb, text) from public" in lower
    assert "revoke all on function public.finance_auto_close_day(date, text, jsonb, text) from anon, authenticated" in lower
    assert "grant execute on function public.finance_auto_close_day(date, text, jsonb, text) to service_role" in lower

    assert "pg_advisory_xact_lock" in body
    assert "hashtext('finance_auto_close_day')" in body
    assert "p_closing_date - date '2000-01-01'" in body
    assert "v_mode not in ('shadow', 'enforced')" in body
    assert "(now() at time zone 'asia/ho_chi_minh')::date" in body
    assert "p_closing_date >" in body

    assert "driveconnectivity" in body
    assert "uncevidence" in body
    assert "qtmevidence" in body
    assert "declaredunc" in body
    assert "qtmopening" in body
    assert "qtmspent" in body
    assert "qtmclosing" in body
    assert "lowconfidencethreshold" in body
    assert "blockers" in body


def test_gate_blockers_cover_evidence_confidence_amounts_qtm_and_snapshot_blockers():
    body = compact(function_body(read_migration()))

    assert "v_prior_unclosed_declaration public.ceo_daily_closing_declarations%rowtype" in body
    assert "into v_prior_unclosed_declaration" in body
    assert "where closing_date < p_closing_date and coalesce(extraction_meta->>'close_approval_locked', 'false') <> 'true'" in body
    assert "order by closing_date asc" in body

    for blocker in (
        "drive_connectivity",
        "missing_unc_evidence",
        "missing_qtm_evidence",
        "low_confidence",
        "unc_amount_mismatch",
        "qtm_chain_mismatch",
        "qtm_negative_balance",
        "snapshot_blockers",
        "prior_unclosed_day",
        "qtm_opening_chain_mismatch",
        "duplicate_declaration",
    ):
        assert blocker in body

    assert "jsonb_array_length(v_unc_evidence) = 0" in body
    assert "jsonb_array_length(v_qtm_evidence) = 0" in body
    assert "select coalesce(min(confidence), 1)" in body
    assert "is distinct from v_declared_unc" in body
    assert "v_qtm_opening + v_qtm_topup - v_qtm_spent" in body
    assert "v_qtm_closing < 0" in body
    assert "jsonb_array_length(v_snapshot_blockers) > 0" in body
    assert "snapshot_declaration_mismatch" in body
    assert "qtm_evidence_sum_mismatch" in body
    assert "duplicate_evidence_file" in body
    assert "select coalesce(min(confidence), 1)" in body
    assert "select coalesce(sum(amount), 0)" in body
    assert "where evidence_source = 'qtm'" in body


def test_evidence_contract_is_drive_unc_qtm_only():
    body = compact(function_body(read_migration()))

    assert "create temporary table tmp_finance_auto_close_evidence" in body
    assert "evidence_source text not null" in body
    assert "file_id text" in body
    assert "amount numeric not null" in body
    assert "confidence numeric not null" in body
    assert "from jsonb_array_elements(v_unc_evidence)" in body
    assert "from jsonb_array_elements(v_qtm_evidence)" in body

    for forbidden in (
        "payment_requests",
        "payment_request",
        "goods_receipts",
        "goods_receipt",
        "purchase_order",
        "finance_payment_auto_approval_matches",
    ):
        assert forbidden not in body


def test_shadow_enforced_idempotency_and_forbidden_mutations():
    sql = read_migration()
    lower = compact(sql)
    body = compact(function_body(sql))

    assert "select * into v_existing_run from public.finance_daily_close_runs" in body
    assert "status = 'succeeded'" in body
    assert "'existing', true" in body
    assert "insert into public.finance_daily_close_runs" in body
    assert "'shadow'" in body
    assert "'enforced'" in body

    assert "finance_auto_close_enabled" in body
    assert "finance_auto_approve_enabled" not in body
    assert "setting_disabled" in body
    assert "update public.payment_requests" not in body
    assert "public.goods_receipts" not in body
    assert "public.finance_payment_auto_approval_matches" not in body

    assert "payment_status" not in body
    assert "paid_at" not in body
    assert "insert into public.payments" not in body
    assert "update public.payments" not in body
    assert "insert into public.payment_allocations" not in body
    assert "update public.payment_allocations" not in body
    assert "record_payment_allocations" not in body


def test_successful_enforced_close_locks_declaration_with_append_only_audit_metadata():
    body = compact(function_body(read_migration()))

    assert "update public.ceo_daily_closing_declarations" in body
    assert "close_approval_locked" in body
    assert "close_decision" in body
    assert "close_actor" in body
    assert "close_time" in body
    assert "close_run_id" in body
    assert "finance_auto_close_audit_log" in body
    assert "coalesce(v_declaration.extraction_meta, '{}'::jsonb)" in body
    assert "|| jsonb_build_object(" in body
    assert "jsonb_set(" in body
    assert "unc_evidence_sum" in body
    assert "qtm_evidence_sum" in body
    assert "closeddeclarationid" in body
    assert "where id = v_declaration.id" in body


def test_chain_patch_invalidates_stale_successful_shadow_runs():
    assert CHAIN_PATCH.exists(), f"Missing migration: {CHAIN_PATCH}"
    sql = compact(CHAIN_PATCH.read_text(encoding="utf-8"))
    assert "update public.finance_daily_close_runs" in sql
    assert "set status = 'failed'" in sql
    assert "mode = 'shadow'" in sql
    assert "status = 'succeeded'" in sql
    assert "invalidatedby" in sql
    assert "closing_date < r.closing_date" in sql
    assert "close_approval_locked" in sql


def test_effective_final_function_is_unc_qtm_only_and_never_touches_payment_workflows():
    assert FINAL_PATCH.exists(), f"Missing migration: {FINAL_PATCH}"
    body = compact(function_body(FINAL_PATCH.read_text(encoding="utf-8")))

    for forbidden in (
        "payment_requests",
        "payment_request",
        "goods_receipts",
        "goods_receipt",
        "purchase_order",
        "finance_payment_auto_approval_matches",
        "finance_auto_approve_enabled",
    ):
        assert forbidden not in body

    assert "finance_auto_close_enabled" in body
    assert "update public.ceo_daily_closing_declarations" in body
    assert "unc_amount_mismatch" in body
    assert "qtm_evidence_sum_mismatch" in body
    assert "qtm_chain_mismatch" in body
    assert "qtm_opening_chain_mismatch" in body


def test_effective_final_migration_matches_canonical_function_body():
    assert FINAL_PATCH.exists(), f"Missing migration: {FINAL_PATCH}"
    canonical = compact(function_body(read_migration()))
    effective = compact(function_body(FINAL_PATCH.read_text(encoding="utf-8")))
    assert effective == canonical


def test_operational_batches_are_chronological_unc_qtm_only_and_stop_safely():
    shadow = compact(SHADOW_RECHECK.read_text(encoding="utf-8"))
    enforced = compact(ENFORCED_BATCH.read_text(encoding="utf-8"))

    assert "'shadow'" in shadow
    assert "update public.ceo_daily_closing_declarations" not in shadow
    assert "order by d.closing_date asc" in shadow
    assert "limit 10" in shadow

    assert "finance_auto_close_enabled" in enforced
    assert "'enforced'" in enforced
    assert "order by d.closing_date asc" in enforced
    assert "exit when v_processed >= 10" in enforced
    assert "if coalesce((v_result->>'ok')::boolean, false) is not true then exit" in enforced
    assert "result=no_snapshot stop=true" in enforced
    assert "blocker->>'code' <> 'existing_declaration_reconciliation_mismatch'" in enforced

    for sql in (shadow, enforced):
        for forbidden in (
            "payment_requests",
            "goods_receipts",
            "purchase_order",
            "finance_payment_auto_approval_matches",
        ):
            assert forbidden not in sql


def test_qtm_opening_is_system_carried_from_previous_close_not_user_blocked():
    assert CARRY_FORWARD_PATCH.exists(), f"Missing migration: {CARRY_FORWARD_PATCH}"
    body = compact(function_body(CARRY_FORWARD_PATCH.read_text(encoding="utf-8")))

    assert "v_qtm_opening := v_previous_closing" in body
    assert "v_previous_declaration.qtm_extracted_amount" in body
    assert "v_previous_declaration.cash_fund_topup_amount" in body
    assert "v_qtm_closing := v_qtm_opening + v_qtm_topup - v_qtm_spent" in body
    assert "qtm_opening_chain_mismatch" not in body
    assert "or v_qtm_opening is distinct from v_db_qtm_opening" not in body
    assert "'qtm_opening_source_date', v_previous_declaration.closing_date" in body


def test_enforced_close_persists_next_day_opening_but_shadow_never_mutates():
    assert CARRY_FORWARD_PATCH.exists(), f"Missing migration: {CARRY_FORWARD_PATCH}"
    body = compact(function_body(CARRY_FORWARD_PATCH.read_text(encoding="utf-8")))

    shadow_return = body.index("if v_mode = 'shadow' then")
    next_day_update = body.index("closing_date = p_closing_date + 1")
    assert shadow_return < next_day_update
    assert "coalesce(extraction_meta->>'close_approval_locked', 'false') <> 'true'" in body[next_day_update - 500:]
    assert "'qtm_opening_balance', v_qtm_closing" in body[next_day_update - 1000:next_day_update]
    assert "'qtm_opening_source_date', p_closing_date" in body[next_day_update - 1000:next_day_update]
    assert "select count(*) from public.ceo_daily_closing_declarations next_day" in body
