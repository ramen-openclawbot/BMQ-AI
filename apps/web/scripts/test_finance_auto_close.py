#!/usr/bin/env python3
"""Static contract tests for the finance daily auto-close database layer."""
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20260731090000_finance_auto_approval_close.sql"
CHAIN_PATCH = ROOT / "supabase/migrations/20260731104500_finance_auto_close_full_prior_chain.sql"
FINAL_PATCH = ROOT / "supabase/migrations/20260731111500_finance_auto_close_already_approved_matches.sql"


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
    assert "duplicate_payment_request_match" in body
    assert "select coalesce(min(confidence), 1)" in body
    assert "select coalesce(sum(amount), 0)" in body
    assert "where evidence_source = 'qtm'" in body


def test_matching_contract_unique_ambiguous_receipt_and_already_approved_paths():
    body = compact(function_body(read_migration()))

    assert_ordered(
        body,
        [
            "paymentrequestid",
            "v_evidence.supplier_id is not null",
            "pr.supplier_id = v_evidence.supplier_id",
            "pr.total_amount = v_evidence.amount",
            "v_match_strategy := 'amount'",
            "pr.total_amount = v_evidence.amount",
        ],
    )
    for blocker in (
        "explicit_payment_request_not_found",
        "explicit_payment_request_amount_mismatch",
        "explicit_payment_request_supplier_mismatch",
        "explicit_payment_request_outside_close_scope",
        "explicit_payment_request_method_mismatch",
        "supplier_amount_no_match",
        "supplier_amount_ambiguous",
        "amount_no_match",
        "amount_ambiguous",
        "unmatched_scoped_payment_request",
        "pending_receipt",
    ):
        assert blocker in body

    assert "pr.status::text in ('pending', 'approved')" in body
    assert "v_match_status := 'already_approved'" in body
    assert (
        "if v_match_status = 'approved' then v_match_status := 'already_approved'; "
        "else v_match_status := 'matched'; end if; "
        "insert into tmp_finance_auto_close_matched_prs(payment_request_id)"
        in body
    )
    assert "already_approved" in body
    assert "pr.status = 'pending'::public.payment_request_status" in body
    assert "purchase_order_id is not null" in body
    assert "public.goods_receipts" in body
    assert "gr.status::text = 'received'" in body
    assert "(pr.goods_receipt_id is not null and gr.id = pr.goods_receipt_id)" in body
    assert "or (pr.goods_receipt_id is null and gr.purchase_order_id = pr.purchase_order_id)" in body
    assert "gr.status::text in ('received', 'confirmed')" not in body
    assert "pr.payment_method::text = case v_evidence.evidence_source when 'unc' then 'bank_transfer' else 'cash' end" in body
    assert "strpos(concat_ws(' ', pr.image_url, pr.description, pr.notes, pr.title), v_evidence.file_id) > 0" in body
    assert "ilike '%' || v_evidence.file_id || '%'" not in body
    assert body.count("v_match_blocker := 'duplicate_payment_request_match'") == 1


def test_shadow_enforced_idempotency_and_forbidden_mutations():
    sql = read_migration()
    lower = compact(sql)
    body = compact(function_body(sql))

    assert "select * into v_existing_run from public.finance_daily_close_runs" in body
    assert "status = 'succeeded'" in body
    assert "'existing', true" in body
    assert "insert into public.finance_daily_close_runs" in body
    assert "insert into public.finance_payment_auto_approval_matches" in body
    assert "'shadow'" in body
    assert "'enforced'" in body

    assert "finance_auto_approve_enabled" in body
    assert "finance_auto_close_enabled" in body
    assert "setting_disabled" in body
    assert "update public.payment_requests" in body
    assert "set status = 'approved'::public.payment_request_status" in body
    assert "approved_at = now()" in body
    assert "approved_by = null" in body
    assert "pr.status = 'pending'::public.payment_request_status" in body

    update_pr_section = body.split("update public.payment_requests", 1)[1].split("returning id", 1)[0]
    assert "payment_status" not in update_pr_section
    assert "paid_at" not in update_pr_section
    assert "insert into public.payments" not in lower
    assert "update public.payments" not in lower
    assert "insert into public.payment_allocations" not in lower
    assert "update public.payment_allocations" not in lower
    assert "record_payment_allocations" not in lower


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
    assert "approved_payment_request_ids" in body
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


def test_effective_final_migration_matches_canonical_function_body():
    assert FINAL_PATCH.exists(), f"Missing migration: {FINAL_PATCH}"
    canonical = compact(function_body(read_migration()))
    effective = compact(function_body(FINAL_PATCH.read_text(encoding="utf-8")))
    assert effective == canonical
