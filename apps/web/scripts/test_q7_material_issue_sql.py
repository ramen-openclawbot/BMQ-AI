#!/usr/bin/env python3
"""Contract tests for immutable per-production-order Q7 material issue workflow.

Task 2 is schema/ACL foundation only.  These stdlib tests intentionally read the
migration SQL rather than relying on app code so they can run before any live DB
apply.  Optional linked/live rollback probes are kept outside this script.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
MIGRATION = ROOT / "apps/web/supabase/migrations/20260816181000_q7_signed_material_issue_workflow.sql"

PROTECTED_TABLES = (
    "production_material_issues",
    "production_material_issue_checks",
    "production_material_issue_events",
    "q7_material_issue_material_mappings",
)


def read_sql() -> str:
    return MIGRATION.read_text(encoding="utf-8")


def strip_comments(sql: str) -> str:
    return re.sub(r"--.*", "", sql)


def compact(sql: str) -> str:
    return re.sub(r"\s+", " ", strip_comments(sql).lower()).strip()


def assert_contains_all(sql: str, snippets: tuple[str, ...]) -> None:
    for snippet in snippets:
        assert snippet in sql, f"missing SQL contract snippet: {snippet}"


def test_issue_table_is_revisioned_q7_workflow_without_destructive_history_rewrite() -> None:
    lower = compact(read_sql())

    assert_contains_all(
        lower,
        (
            "alter table public.production_material_issues add column if not exists location_code text",
            "alter table public.production_material_issues add column if not exists revision integer not null default 1",
            "check (revision > 0)",
            "alter table public.production_material_issues add column if not exists source_hash text",
            "alter table public.production_material_issues add column if not exists immutable_token uuid not null default gen_random_uuid()",
            "unique (production_order_id, revision)",
            "where status not in ('superseded', 'cancelled')",
            "alter table public.production_material_issues drop constraint if exists production_material_issues_production_order_id_key",
        ),
    )

    for status in (
        "draft",
        "generated",
        "pdf_ready",
        "signed_uploaded",
        "checking",
        "ready_to_confirm",
        "needs_review",
        "posted",
        "superseded",
        "cancelled",
    ):
        assert f"'{status}'" in lower

    assert "delete from public.production_material_issues" not in lower
    assert "truncate public.production_material_issues" not in lower
    assert "update public.production_material_issues set location_code" not in lower


def test_q7_workflow_statuses_require_q7_location_and_snapshot_hash() -> None:
    lower = compact(read_sql())

    assert "production_material_issues_q7_workflow_location_check" in lower
    assert "status not in ('generated', 'pdf_ready', 'signed_uploaded', 'checking', 'ready_to_confirm', 'needs_review', 'superseded') or location_code = 'q7'" in lower
    assert "production_material_issues_source_hash_check" in lower
    assert "source_hash is null or source_hash ~ '^[a-f0-9]{64}$'" in lower
    assert "status not in ('generated', 'pdf_ready', 'signed_uploaded', 'checking', 'ready_to_confirm', 'needs_review', 'superseded') or source_hash is not null" in lower
    assert "production_material_issues_immutable_token_key" in lower
    assert "on public.production_material_issues(immutable_token)" in lower


def test_issue_workflow_metadata_columns_and_indexes_are_present() -> None:
    lower = compact(read_sql())

    for column in (
        "pdf_path text",
        "pdf_sha256 text",
        "signed_file_path text",
        "signed_file_sha256 text",
        "signed_uploaded_by uuid references auth.users(id) on delete set null",
        "signed_uploaded_at timestamptz",
        "check_status text",
        "check_metadata jsonb not null default '{}'::jsonb",
        "checked_at timestamptz",
        "confirmed_by uuid references auth.users(id) on delete set null",
        "confirmed_at timestamptz",
        "posted_at timestamptz",
    ):
        assert f"alter table public.production_material_issues add column if not exists {column}" in lower

    assert "idx_production_material_issues_location_status_date" in lower
    assert "on public.production_material_issues(location_code, status, issue_date)" in lower


def test_checks_table_is_one_time_immutable_per_signed_file_hash() -> None:
    lower = compact(read_sql())

    assert "create table if not exists public.production_material_issue_checks" in lower
    assert "issue_id uuid not null references public.production_material_issues(id) on delete restrict" in lower
    assert "signed_file_sha256 text not null" in lower
    assert "attempt_no integer not null default 1 check (attempt_no = 1)" in lower
    assert "status text not null check (status in ('checking', 'passed', 'failed', 'failed_transient', 'error', 'needs_review'))" in lower
    assert "result jsonb not null default '{}'::jsonb" in lower
    assert "model text" in lower
    assert "model_version text" in lower
    assert "checked_by uuid references auth.users(id) on delete set null" in lower
    assert "checked_at timestamptz not null default now()" in lower
    assert "unique (issue_id, signed_file_sha256)" in lower
    assert "idx_production_material_issue_checks_issue" in lower
    assert "production_material_issue_checks_immutable_except_finalization" in lower
    assert "before update or delete on public.production_material_issue_checks" in lower
    assert "old.status = 'checking'" in lower
    assert "new.status in ('passed', 'failed', 'failed_transient', 'error', 'needs_review')" in lower
    assert "old.issue_id is not distinct from new.issue_id" in lower
    assert "old.signed_file_sha256 is not distinct from new.signed_file_sha256" in lower
    assert "old.attempt_no is not distinct from new.attempt_no" in lower
    assert "old.created_at is not distinct from new.created_at" in lower
    assert "raise exception 'production_material_issue_checks are append/finalize-only'" in lower


def test_events_table_is_append_only_audit_with_status_transition_metadata() -> None:
    lower = compact(read_sql())

    assert "create table if not exists public.production_material_issue_events" in lower
    assert "issue_id uuid not null references public.production_material_issues(id) on delete restrict" in lower
    assert "event_type text not null" in lower
    assert "from_status text" in lower
    assert "to_status text" in lower
    assert "actor uuid references auth.users(id) on delete set null" in lower
    assert "metadata jsonb not null default '{}'::jsonb" in lower
    assert "created_at timestamptz not null default now()" in lower
    assert "idx_production_material_issue_events_issue" in lower
    assert "production_material_issue_events_immutable" in lower
    assert "before update or delete on public.production_material_issue_events" in lower
    assert "raise exception 'production_material_issue_events are append-only'" in lower


def test_approved_mapping_foundation_fails_closed_and_requires_finite_positive_conversion() -> None:
    lower = compact(read_sql())

    assert "create table if not exists public.q7_material_issue_material_mappings" in lower
    assert "canonical_material_id uuid not null references public.sku_cogs_materials(id) on delete restrict" in lower
    assert "source_unit text not null" in lower
    assert "kitchen_inventory_item_id uuid not null references public.kitchen_inventory_items(id) on delete restrict" in lower
    assert "kitchen_unit text not null" in lower
    assert "conversion_factor numeric(18, 8) not null" in lower
    assert "conversion_factor > 0" in lower
    assert "conversion_factor::text not in ('nan', 'infinity', '-infinity')" in lower
    assert "approval_status text not null default 'pending'" in lower
    assert "check (approval_status in ('pending', 'approved', 'rejected'))" in lower
    assert "approved_by uuid references auth.users(id) on delete set null" in lower
    assert "approved_at timestamptz" in lower
    assert "unique (canonical_material_id, source_unit)" in lower
    assert "q7_material_issue_material_mappings_approved_ready_check" in lower
    assert "approval_status <> 'approved' or (approved_by is not null and approved_at is not null)" in lower
    assert "idx_q7_material_issue_material_mappings_canonical" in lower
    assert "idx_q7_material_issue_material_mappings_kitchen_item" in lower
    assert "insert into public.q7_material_issue_material_mappings" not in lower


def test_kitchen_movements_location_is_nullable_and_not_backfilled_or_written() -> None:
    lower = compact(read_sql())

    assert "alter table public.kitchen_inventory_movements add column if not exists location_code text" in lower
    assert "alter table public.kitchen_inventory_movements alter column location_code set not null" not in lower
    assert "update public.kitchen_inventory_movements" not in lower
    assert "insert into public.kitchen_inventory_movements" not in lower
    assert "delete from public.kitchen_inventory_movements" not in lower
    assert "truncate public.kitchen_inventory_movements" not in lower


def test_rls_acl_fail_closed_for_browser_roles_with_select_only() -> None:
    lower = compact(read_sql())

    for table in PROTECTED_TABLES:
        assert f"alter table public.{table} enable row level security" in lower
        assert f"revoke all on public.{table} from public, anon, authenticated" in lower
        assert f"grant select on public.{table} to authenticated" in lower
        assert f"grant insert on public.{table} to authenticated" not in lower
        assert f"grant update on public.{table} to authenticated" not in lower
        assert f"grant delete on public.{table} to authenticated" not in lower

    assert "alter default privileges" not in lower
    assert "production_q7', 'view'" in lower
    assert "warehouse', 'view'" in lower
    assert "kitchen_inventory', 'view'" in lower
    assert "q7_material_inventory', 'view'" in lower
    assert "has_role((select auth.uid()), 'owner'" in lower
    assert "for insert to authenticated" not in lower
    assert "for update to authenticated" not in lower
    assert "for delete to authenticated" not in lower


def test_task1_legacy_rpc_revokes_are_preserved_and_no_posting_rpc_is_created() -> None:
    lower = compact(read_sql())

    legacy_signature = "public.create_production_material_issue(uuid, date)"
    for role in ("public", "anon", "authenticated"):
        assert f"revoke all on function {legacy_signature} from {role}" in lower
        assert f"revoke execute on function {legacy_signature} from {role}" in lower
        assert f"grant execute on function {legacy_signature} to {role}" not in lower

    assert f"grant execute on function {legacy_signature} to service_role" in lower
    assert "create or replace function public.confirm" not in lower
    assert "create or replace function public.post" not in lower
    assert "kitchen_inventory_movements(" not in lower


if __name__ == "__main__":
    tests = [name for name in globals() if name.startswith("test_")]
    failures: list[str] = []
    for name in tests:
        try:
            globals()[name]()
            print(f"PASS {name}")
        except Exception as exc:  # noqa: BLE001 - tiny stdlib runner
            failures.append(f"FAIL {name}: {exc}")
            print(failures[-1])
    if failures:
        raise SystemExit(1)
