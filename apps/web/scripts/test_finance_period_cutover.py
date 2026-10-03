#!/usr/bin/env python3
"""Static contract tests for the CEO finance month-cutover layer.

These checks are static and never touch Supabase. They guard the server-owned
contract: owner-only security-definer RPCs, evidence collected without closing,
idempotent month close with preview-hash recheck, month revert guards, and the
no-delete / daily_reconciliations-untouched safety rule. The Edge contract checks
that mode=evidence_only reuses evidence collection but never closes a day.
"""
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20261003120000_finance_period_cutover.sql"
EDGE_FN = ROOT / "supabase/functions/finance-auto-close-day/index.ts"


def read(path: Path) -> str:
    assert path.exists(), f"Missing file: {path}"
    return path.read_text(encoding="utf-8")


def compact(text: str) -> str:
    return re.sub(r"\s+", " ", text)


def compact_lower(text: str) -> str:
    return compact(text).lower()


def function_body(sql: str, name: str) -> str:
    match = re.search(
        r"create\s+or\s+replace\s+function\s+public\." + re.escape(name) +
        r"\b.*?\$\$(.*?)\$\$",
        sql,
        flags=re.IGNORECASE | re.DOTALL,
    )
    assert match, f"Missing {name} function body"
    return match.group(1)


def edge_function_body(source: str, name: str) -> str:
    match = re.search(
        r"async function " + re.escape(name) + r"\([\s\S]*?\n\}",
        source,
    )
    assert match, f"Missing {name} edge function body"
    return match.group(0)


def test_tables_columns_and_closed_month_partial_unique_index():
    sql = compact_lower(read(MIGRATION))

    assert "create table if not exists public.finance_cutover_day_evidence" in sql
    for column in (
        "closing_date date primary key",
        "unc_evidence_total numeric",
        "unc_file_count int",
        "qtm_spent_total numeric",
        "qtm_file_count int",
        "low_confidence_count int",
        "blockers jsonb",
        "scanned_at timestamptz",
        "scanned_by uuid",
    ):
        assert column in sql, column

    assert "create table if not exists public.finance_period_cutovers" in sql
    for column in (
        "period_month date",
        "from_date date",
        "to_date date",
        "day_count integer",
        "unc_declared_total numeric",
        "unc_evidence_total numeric",
        "unc_variance numeric",
        "qtm_opening_balance numeric",
        "qtm_topup_total numeric",
        "qtm_spent_total numeric",
        "qtm_closing_computed numeric",
        "qtm_closing_counted numeric",
        "qtm_count_variance numeric",
        "days_missing_evidence jsonb",
        "preview_hash text",
        "note text",
        "status text",
        "created_by uuid",
        "created_at timestamptz",
        "reverted_by uuid",
        "reverted_at timestamptz",
        "revert_note text",
    ):
        assert column in sql, column

    assert "check (status in ('closed', 'reverted'))" in sql
    assert "create unique index if not exists uq_finance_period_cutovers_closed_month" in sql
    assert "on public.finance_period_cutovers (period_month)" in sql
    assert "where status = 'closed'" in sql


def test_rls_enabled_owner_select_only_and_no_table_writes():
    sql = compact_lower(read(MIGRATION))

    for table in ("finance_cutover_day_evidence", "finance_period_cutovers"):
        assert f"alter table public.{table} enable row level security" in sql
        assert f"revoke all on public.{table} from public, anon, authenticated" in sql
        assert f"grant select on public.{table} to authenticated" in sql
        assert f"grant all on public.{table} to service_role" in sql
        assert f"create policy {table}_owner_select" in sql

    assert "for select" in sql
    assert "public.has_role(auth.uid(), 'owner')" in sql

    # No direct write policies: every create policy is a select-only policy.
    policies = re.findall(r"create policy\s+(.*?);", sql, flags=re.DOTALL)
    assert len(policies) == 2, policies
    for policy in policies:
        assert "for select" in policy
        for forbidden in ("for insert", "for update", "for delete", "for all"):
            assert forbidden not in policy, forbidden


def test_three_rpcs_are_owner_only_security_definer_with_authenticated_execute():
    source = read(MIGRATION)
    sql = compact_lower(source)

    for signature in (
        "create or replace function public.finance_cutover_preview(p_month date)",
        "create or replace function public.finance_cutover_close_month(",
        "create or replace function public.finance_cutover_revert(",
    ):
        assert signature in source, signature

    assert sql.count("security definer") >= 3
    assert sql.count("set search_path = public, pg_temp") >= 3

    for name in (
        "finance_cutover_preview",
        "finance_cutover_close_month",
        "finance_cutover_revert",
    ):
        assert "public.has_role(auth.uid(), 'owner')" in compact_lower(
            function_body(source, name)
        ), name

    for signature in (
        "finance_cutover_preview(date)",
        "finance_cutover_close_month(date, text, numeric, text)",
        "finance_cutover_revert(uuid, text)",
    ):
        assert f"revoke all on function public.{signature} from public, anon" in sql
        assert f"grant execute on function public.{signature} to authenticated" in sql


def test_preview_is_read_only_and_builds_canonical_hash():
    source = read(MIGRATION)
    body = compact_lower(function_body(source, "finance_cutover_preview"))

    assert "update " not in body
    assert "insert into" not in body
    assert "delete from" not in body

    assert "date_trunc('month', p_month)::date" in body
    assert "finance_cutover_day_evidence" in body
    assert "close_approval_locked" in body
    assert "unc_declared_total" in body
    assert "unc_evidence_total" in body
    assert "unc_variance := v_unc_declared_total - v_unc_evidence_total" in body
    assert "qtm_topup_total" in body
    assert "qtm_spent_total" in body
    assert "qtm_closing_computed := v_qtm_opening + v_qtm_topup_total - v_qtm_spent_total" in body
    assert "days_missing_evidence" in body
    assert "prior_unclosed_before_month" in body
    assert "evidence_scanned" in body
    assert "preview_hash" in body
    assert "md5(v_payload::text)" in body
    # The opening chains from the latest locked day before the month.
    assert "qtm_closing_balance" in body
    assert "order by d.closing_date desc" in body


def test_close_is_idempotent_rechecks_hash_and_carries_qtm_forward():
    source = read(MIGRATION)
    body = compact_lower(function_body(source, "finance_cutover_close_month"))

    assert "pg_advisory_xact_lock(hashtext('finance_period_cutover'))" in body
    assert "'already_closed', true" in body
    assert "status = 'closed'" in body
    assert "prior_month_unclosed" in body
    assert "preview_changed" in body
    assert "note_required" in body
    assert "public.finance_cutover_preview(v_month_start)" in body
    assert "v_preview->>'preview_hash' is distinct from p_expected_hash" in body

    assert "insert into public.finance_period_cutovers" in body
    assert "qtm_closing_counted" in body
    assert "qtm_count_variance" in body
    assert "close_approval_locked', true" in body
    assert "close_decision', 'cutover_month'" in body
    assert "cutover_id', v_cutover_id" in body
    assert "qtm_opening_balance', v_running" in body
    assert "qtm_spent_from_folder', v_spent" in body
    assert "'cutover_prev', jsonb_build_object(" in body
    assert "qtm_closing_balance', v_closing" in body
    assert "v_closing := v_running + v_topup - v_spent" in body
    assert "if v_day.closing_date = v_last_date and p_qtm_counted is not null then" in body
    assert "cutover_month_close" in body
    assert "finance_auto_close_audit_log" in body
    # The cutover walks unlocked declared days in date order with a row lock.
    assert "order by d.closing_date asc" in body
    assert "for update of d" in body
    assert "update public.ceo_daily_closing_declarations" in body

    # Never routes through the per-day close RPC and never touches reconciliation.
    assert "finance_auto_close_day" not in body
    assert "daily_reconciliations" not in body


def test_revert_guards_and_resets_cutover_days_without_deleting():
    source = read(MIGRATION)
    body = compact_lower(function_body(source, "finance_cutover_revert"))

    assert "pg_advisory_xact_lock(hashtext('finance_period_cutover'))" in body
    assert "note_required" in body
    assert "later_cutover_exists" in body
    assert "later_day_closed" in body
    assert "c.period_month > v_cutover.period_month" in body
    assert "d.closing_date > v_cutover.to_date" in body
    assert "close_decision', '') <> 'cutover_month'" in body

    # Revert restores the exact pre-cutover values saved in cutover_prev.
    assert "- 'cutover_id'" in body
    assert "- 'cutover_prev'" in body
    assert "- 'close_approval_locked'" in body
    assert "- 'qtm_opening_balance'" in body
    assert "- 'qtm_spent_from_folder'" in body
    assert "- 'qtm_closing_balance'" in body
    assert "jsonb_strip_nulls(coalesce(v_day.meta->'cutover_prev', '{}'::jsonb))" in body
    assert "cutover_month_revert" in body
    assert "status = 'reverted'" in body
    assert "reverted_by = v_actor" in body
    assert "reverted_at = now()" in body
    assert "revert_note = v_note" in body
    assert "delete from" not in body


def test_migration_never_deletes_and_leaves_daily_reconciliations_untouched():
    sql = read(MIGRATION)
    lower = compact_lower(sql)

    assert not re.search(r"\bdelete\s+from\b", lower), "Migration must not delete data"
    assert not re.search(r"\btruncate\b", lower), "Migration must not truncate data"
    assert "update public.daily_reconciliations" not in lower
    assert "insert into public.daily_reconciliations" not in lower
    assert "delete from public.daily_reconciliations" not in lower


def test_edge_evidence_only_reuses_evidence_but_never_closes_a_day():
    source = read(EDGE_FN)

    assert 'type AutoCloseMode = "shadow" | "enforced" | "evidence_only"' in source
    assert 'mode === "evidence_only"' in source
    assert "async function handleEvidenceOnly(" in source
    assert 'from("finance_cutover_day_evidence")' in source
    assert ".upsert(" in source
    assert 'onConflict: "closing_date"' in source
    assert "buildSnapshot(" in source
    assert "stopped: false" in source

    handler = edge_function_body(source, "handleEvidenceOnly")
    assert '.rpc("finance_auto_close_day"' not in handler, (
        "evidence_only must never call finance_auto_close_day"
    )
    # It must not stop at a blocked day: no early break in the per-date loop.
    assert "break;" not in handler

    # Existing shadow/enforced orchestration is still present and unchanged.
    assert 'mode !== "shadow" && mode !== "enforced"' in source
    assert 'const { serviceRoleKey, cronSecret } = await authenticate(req)' in source
    assert "for (const closingDate of targetDates)" in source
    assert ".rpc(\"finance_auto_close_day\"" in source
    assert "if (hasBlockers)" in source
    assert "stopped = true" in source


def test_edge_auth_gate_is_reused_for_evidence_only():
    source = read(EDGE_FN)
    lower = compact_lower(source)

    assert "async function authenticate(req: Request)" in source
    assert "SUPABASE_SERVICE_ROLE_KEY" in source
    assert "FINANCE_AUTO_CLOSE_CRON_SECRET" in source
    assert "serviceRoleKey && bearer === serviceRoleKey" in source
    assert "/auth/v1/admin/users?page=1&per_page=1" in source
    assert "dates must be provided in evidence_only mode" in source
    assert "new Set(dates)" in source or "new Set(body.dates" in source
    assert "limit < 1 || limit > 10" in source
    # Owner app calls are verified (signed JWT + owner role), not just decoded.
    assert "async function authenticateEvidenceCaller(req: Request)" in source
    assert "admin.auth.getUser(bearer)" in source
    assert 'admin.rpc("has_role"' in source
    assert '_role: "owner"' in source
    assert "decodeJwtSubject" not in source
    assert "scanned_by: scannedBy" in source
    assert 'if (peekBody.mode === "evidence_only") return await serveEvidenceOnly(req);' in source


if __name__ == "__main__":
    import pytest

    raise SystemExit(pytest.main([__file__, "-q"]))
