#!/usr/bin/env python3
"""Static contract checks for 20261101410000_q7_bom_match_and_posting.sql.

These checks never connect to a database. They guard:
  * the cutover guard uses <= (issue_date = cutover is never posted);
  * the append-only decision log has RLS + select-only client grants;
  * resolve is owner-only, replay-safe and never deletes a mapping;
  * catch-up regenerates through generate_q7_production_material_issue and
    posts through post_material_issue_usage;
  * the daily cron job is declared with the requested name and time;
  * mission_evaluate keeps every older rule and adds the BOM rule;
  * the owner mission is seeded, and the rollback smoke stays rollback-only.
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
SCRIPTS = ROOT / "scripts"

MIGRATION = MIGRATIONS / "20261101410000_q7_bom_match_and_posting.sql"
SMOKE = SCRIPTS / "smoke_q7_bom_match.sql"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def body_after(text: str, marker: str) -> str:
    start = text.index(marker)
    end = text.index("$$;", start)
    return text[start:end]


def main() -> None:
    assert_true(MIGRATION.exists(), f"missing migration {MIGRATION.name}")

    migration = read(MIGRATION)
    lower = migration.lower()

    # --- 1. cutover guard ---------------------------------------------------
    post = body_after(lower, "function public.post_material_issue_usage(")
    assert_true(
        "v_issue.issue_date <= v_cutover" in post,
        "post_material_issue_usage must treat issue_date = cutover as before_cutover",
    )
    assert_true(
        "v_cutover is null" in post,
        "post_material_issue_usage must return before_cutover when cutover is null",
    )
    assert_true(
        "'before_cutover'" in post,
        "post_material_issue_usage must return before_cutover",
    )
    assert_true(
        "q7_bom_line_decisions" in post and "not_tracked" in post,
        "posting must skip active not_tracked / bom_error decisions",
    )
    assert_true(
        "non_stock" in post,
        "posting must skip non_stock kitchen items",
    )
    assert_true(
        "'skipped_count'" in post,
        "posting must report the skipped line count",
    )

    # --- 2. decision log ----------------------------------------------------
    assert_true(
        "create table if not exists public.q7_bom_line_decisions" in lower,
        "decision log table missing",
    )
    for action in ("remap", "not_tracked", "bom_error"):
        assert_true(action in lower, f"decision action {action} missing")
    assert_true(
        "request_id uuid not null unique" in lower,
        "decision request_id must be not null unique",
    )
    assert_true(
        "where active = true" in lower,
        "decision log needs a partial unique index on active rows",
    )
    assert_true(
        "alter table public.q7_bom_line_decisions enable row level security" in lower,
        "decision log must enable RLS",
    )
    assert_true(
        "create policy q7_bom_line_decisions_select" in lower,
        "decision log needs a select policy",
    )
    assert_true(
        "public.q7_material_inventory_can_view" in lower,
        "decision log select must use the Q7 view gate",
    )
    assert_true(
        "revoke all on table public.q7_bom_line_decisions from public, anon, authenticated"
        in lower,
        "decision log must revoke default client access",
    )
    assert_true(
        "grant select on table public.q7_bom_line_decisions to authenticated" in lower,
        "decision log must grant select to authenticated",
    )
    assert_true(
        "grant all on table public.q7_bom_line_decisions to service_role" in lower,
        "decision log must grant all to service_role",
    )

    # --- 3. review ----------------------------------------------------------
    review = body_after(lower, "function public.q7_bom_mismatch_review_internal(")
    assert_true("pi.issue_date > v_cutover" in review, "review must scope issue_date > cutover")
    assert_true(
        "pi.status not in ('cancelled', 'needs_review')" in review,
        "review must skip cancelled / needs_review issues",
    )
    assert_true(
        "q7_bom_line_decisions" in review,
        "review must join active decisions",
    )
    assert_true(
        "q7_material_name_similarity" in review,
        "review candidates must rank by the material-name similarity helper",
    )
    assert_true(
        "limit 5" in review,
        "review must cap candidates at 5",
    )
    assert_true(
        "'has_count_since_cutover'" in review
        and "'current_balance'" in review
        and "'planned_by_issue_date'" in review,
        "review must return count / balance / per-date fields",
    )
    assert_true(
        "create or replace function public.get_q7_bom_mismatch_review()" in lower,
        "public review wrapper missing",
    )
    wrapper = body_after(lower, "function public.get_q7_bom_mismatch_review()")
    assert_true("security definer" in wrapper, "review must be SECURITY DEFINER")
    assert_true(
        "set search_path = public, pg_temp" in wrapper,
        "review must pin search_path",
    )
    assert_true(
        "public.has_role(v_actor, 'owner')" in wrapper
        or "public.has_role(v_actor, 'owner')" in lower,
        "review must gate on owner",
    )
    assert_true(
        "revoke all on function public.get_q7_bom_mismatch_review() from public, anon"
        in lower,
        "review must revoke public / anon",
    )

    # --- 4. resolve ---------------------------------------------------------
    resolve = body_after(lower, "function public.resolve_q7_bom_line(")
    assert_true("security definer" in resolve, "resolve must be SECURITY DEFINER")
    assert_true(
        "set search_path = public, pg_temp" in resolve,
        "resolve must pin search_path",
    )
    assert_true(
        "public.has_role(v_actor, 'owner')" in resolve,
        "resolve must be owner-only",
    )
    assert_true("42501" in resolve, "resolve must raise 42501 for non-owners")
    assert_true(
        "where d.request_id = p_request_id" in resolve or "where d.request_id = p_request_id" in lower,
        "resolve must replay on request_id",
    )
    assert_true("'replay', true" in resolve, "resolve replay must return replay=true")
    assert_true(
        "update public.q7_material_issue_material_mappings" in resolve,
        "resolve remap must update the approved mapping",
    )
    assert_true(
        "conversion_factor = p_factor" in resolve,
        "resolve remap must store the conversion factor",
    )
    assert_true(
        "delete from public.q7_material_issue_material_mappings" not in lower,
        "mappings must never be deleted",
    )
    assert_true(
        "set active = false" in resolve,
        "resolve must deactivate the previous active decision",
    )

    # --- 5. catch-up --------------------------------------------------------
    catchup = body_after(lower, "function public.post_pending_q7_material_issues(")
    assert_true(
        "security definer" in catchup and "set search_path = public, pg_temp" in catchup,
        "catch-up must be SECURITY DEFINER with a pinned search_path",
    )
    assert_true(
        "public.generate_q7_production_material_issue(" in catchup,
        "catch-up must regenerate stale issues through the generator",
    )
    assert_true(
        "public.post_material_issue_usage(" in catchup,
        "catch-up must post through post_material_issue_usage",
    )
    for action in ("posted", "already_posted", "regenerated", "skipped_open_mismatch"):
        assert_true(action in catchup, f"catch-up action {action} missing")
    assert_true(
        "p_dry_run" in catchup,
        "catch-up must support p_dry_run",
    )
    assert_true(
        "revoke all on function public.post_pending_q7_material_issues(boolean)" in lower,
        "catch-up must revoke public access",
    )

    # --- 6. cron ------------------------------------------------------------
    assert_true(
        "q7-post-pending-material-issues" in lower,
        "cron job name missing",
    )
    assert_true("'40 22 * * *'" in lower, "cron must run daily at 22:40 UTC")
    assert_true("cron.unschedule" in lower, "cron must unschedule before scheduling")
    assert_true("cron.schedule" in lower, "cron must schedule the job")

    # --- 7. mission ---------------------------------------------------------
    for rule in (
        "'stock_alias_factor_fixed'",
        "'stock_duplicate_resolved'",
        "'stock_unknown_units_cleared'",
        "'material_links_done'",
        "'stock_count_questions_done'",
        "'q7_bom_mismatch_resolved'",
    ):
        assert_true(rule in lower, f"mission rule {rule} missing from the constraint")
    evaluate = body_after(lower, "function public.mission_evaluate(")
    assert_true(
        "v_mission.check_rule = 'q7_bom_mismatch_resolved'" in evaluate,
        "mission_evaluate must handle q7_bom_mismatch_resolved",
    )
    assert_true(
        "'kind', 'bom_mismatch'" in evaluate,
        "mission detail must carry kind=bom_mismatch",
    )
    assert_true(
        "public.get_q7_bom_mismatch_review()" in evaluate,
        "mission must evaluate the live review",
    )
    assert_true(
        "wh-q7-bom-match-20261017" in lower,
        "owner mission code missing",
    )
    assert_true(
        "Trỏ từng nguyên liệu công thức vào đúng món kho đã kiểm kê để trừ NVL từ 17/10"
        in migration,
        "owner mission description missing",
    )
    assert_true("on conflict (code) do nothing" in lower, "mission seed must be idempotent")

    # --- 8. smoke: rollback-only and explicit pass marker --------------------
    assert_true(SMOKE.exists(), f"missing smoke {SMOKE.name}")
    smoke = read(SMOKE)
    smoke_lower = smoke.lower()
    assert_true("begin;" in smoke_lower, "smoke must open a transaction")
    assert_true("rollback;" in smoke_lower, "smoke must roll back")
    assert_true(
        "request.jwt.claims" in smoke_lower,
        "smoke must impersonate the owner through request.jwt.claims",
    )
    assert_true(
        "SMOKE_RESULT PASS" in smoke,
        "smoke must raise SMOKE_RESULT PASS",
    )
    for marker in (
        "post_material_issue_usage",
        "get_q7_bom_mismatch_review",
        "resolve_q7_bom_line",
        "post_pending_q7_material_issues",
        "Q7-8EBB689B5977C1D6DF8A",
        "Q7-259831B6C7785A330111",
    ):
        assert_true(marker in smoke, f"smoke must exercise {marker}")

    print("q7 bom match contract: PASS")


if __name__ == "__main__":
    main()
