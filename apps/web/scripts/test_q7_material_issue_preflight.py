#!/usr/bin/env python3
"""Preflight contracts for Q7 signed material-issue workflow Task 1.

These tests are intentionally stdlib-only so they can run in a minimal agent
shell.  They document the legacy hazard before the new migration: the existing
`create_production_material_issue(uuid,date)` RPC posts kitchen ledger movements
immediately and has no signed-upload / check / confirm guard.  Task 1 only
blocks that legacy RPC for browser roles; it must not rewrite ledger history or
add any kitchen inventory ledger writes.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
LEGACY_MIGRATION = (
    ROOT
    / "apps/web/supabase/migrations/20260527141000_add_material_code_to_production_material_issues.sql"
)
TASK1_MIGRATION = (
    ROOT
    / "apps/web/supabase/migrations/20260816181000_q7_signed_material_issue_workflow.sql"
)
LEGACY_SIGNATURE = "public.create_production_material_issue(uuid, date)"


def strip_comments(sql: str) -> str:
    return re.sub(r"--.*", "", sql)


def compact(sql: str) -> str:
    return re.sub(r"\s+", " ", strip_comments(sql).lower()).strip()


def read_sql(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def legacy_function_sql() -> str:
    sql = compact(read_sql(LEGACY_MIGRATION))
    match = re.search(
        r"create or replace function public\.create_production_material_issue\(.*?\bend;\s*\$\$;",
        sql,
        flags=re.S,
    )
    assert match, "legacy create_production_material_issue(uuid,date) definition must be present"
    return match.group(0)


def test_legacy_rpc_immediately_posts_kitchen_inventory_movements() -> None:
    legacy = legacy_function_sql()

    assert "security definer" in legacy
    assert "insert into public.production_material_issues" in legacy
    assert "insert into public.production_material_issue_items" in legacy
    assert "insert into public.kitchen_inventory_movements" in legacy
    assert "'production_issue'" in legacy
    assert "'posted'" in legacy
    assert "on conflict (source, source_ref_key, movement_type)" in legacy
    assert "movement_count" in legacy


def test_legacy_rpc_has_no_q7_signed_upload_check_confirm_guard() -> None:
    legacy = legacy_function_sql()

    forbidden_guard_markers = (
        "q7",
        "signed",
        "signature",
        "upload",
        "uploaded",
        "confirm_post",
        "confirm/post",
        "one-time check",
        "one_time_check",
        "checked_at",
        "posted_at",
    )
    for marker in forbidden_guard_markers:
        assert marker not in legacy, f"legacy RPC unexpectedly contains guard marker: {marker}"


def test_task1_migration_revokes_legacy_rpc_from_browser_roles() -> None:
    sql = compact(read_sql(TASK1_MIGRATION))

    for role in ("public", "anon", "authenticated"):
        assert f"revoke all on function {LEGACY_SIGNATURE} from {role}" in sql
        assert f"revoke execute on function {LEGACY_SIGNATURE} from {role}" in sql
        assert f"grant execute on function {LEGACY_SIGNATURE} to {role}" not in sql

    assert "grant execute on function public.create_production_material_issue(uuid, date) to service_role" in sql


def test_task1_migration_does_not_write_kitchen_inventory_movements() -> None:
    sql = compact(read_sql(TASK1_MIGRATION))

    forbidden_dml = (
        "insert into public.kitchen_inventory_movements",
        "update public.kitchen_inventory_movements",
        "delete from public.kitchen_inventory_movements",
        "truncate public.kitchen_inventory_movements",
    )
    for statement in forbidden_dml:
        assert statement not in sql


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
