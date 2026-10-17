#!/usr/bin/env python3
"""Static contracts for the 20261101390000 relink / Q7-supplies migration.

These checks never connect to a database or Supabase. They guard that:
  * public.material_relinks is audit-only: RLS, SELECT for authenticated, writes
    only through service_role;
  * public.relink_item_material is owner-only, SECURITY DEFINER, locks the item,
    refuses items with Q7 movements, uses an idempotent request id, passes the
    canonical-link guard through material_master.link_request_id, and never
    deletes canonical aliases / items / Q7 movements;
  * public.resolve_q7_canonical_inventory_item keeps every old failure string
    and adds the material_link_skips 'not_material' branch with null mapping /
    canonical and factor 1;
  * the rollback smoke covers the owner relink, non-owner denial, Q7-movement
    refusal and the skip / no-skip stock-count paths.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
SCRIPTS = ROOT / "scripts"

MIGRATION = MIGRATIONS / "20261101390000_relink_material_and_q7_supplies.sql"
SMOKE = SCRIPTS / "smoke_relink_q7_supplies.sql"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def canon(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def strip_comments(sql: str) -> str:
    sql = re.sub(r"--.*", "", sql)
    sql = re.sub(r"/\*.*?\*/", "", sql, flags=re.S)
    return sql


def extract_function(sql: str, name: str, start_at: int = 0) -> str:
    marker = f"create or replace function public.{name}("
    start = sql.lower().index(marker, start_at)
    match = re.search(r"\bas\s+(\$[A-Za-z_]*\$)", sql[start:], re.IGNORECASE)
    assert_true(match is not None, f"no AS dollar-quote after {marker}")
    tag = match.group(1)
    end = sql.index(tag + ";", start + match.end())
    return sql[start : end + len(tag) + 1]


def main() -> None:
    assert_true(MIGRATION.exists(), f"missing migration {MIGRATION.name}")
    assert_true(
        MIGRATION.name == "20261101390000_relink_material_and_q7_supplies.sql",
        "migration must keep its timestamped name",
    )
    assert_true(SMOKE.exists(), f"missing rollback smoke {SMOKE.name}")

    migration = read(MIGRATION)
    lower = migration.lower()
    compact = canon(strip_comments(migration)).lower()

    # --- 1. audit table: RLS + SELECT-only client access ---------------------
    assert_true(
        "create table if not exists public.material_relinks" in lower,
        "migration must create public.material_relinks",
    )
    table_def = lower[
        lower.index("create table if not exists public.material_relinks") :
        lower.index("alter table public.material_relinks enable row level security")
    ]
    for fragment in (
        "id uuid primary key default gen_random_uuid()",
        "item_id uuid not null references public.kitchen_inventory_items(id)",
        "old_material_id uuid",
        "new_material_id uuid not null",
        "old_request_id uuid",
        "new_request_id uuid not null",
        "reason text not null",
        "request_id uuid not null unique",
        "created_by uuid not null",
        "created_at timestamptz not null default now()",
    ):
        assert_true(fragment in canon(table_def), f"material_relinks missing: {fragment}")

    assert_true(
        "alter table public.material_relinks enable row level security" in lower,
        "material_relinks must enable RLS",
    )
    assert_true(
        "drop policy if exists material_relinks_select on public.material_relinks" in lower,
        "material_relinks policy must be replaceable",
    )
    policy = compact[
        compact.index("create policy material_relinks_select on public.material_relinks") :
        compact.index("revoke all on table public.material_relinks")
    ]
    assert_true("for select to authenticated" in policy, "material_relinks policy must be SELECT-only")
    assert_true("public.has_role(auth.uid(), 'owner')" in policy, "material_relinks must allow owner")
    assert_true("public.can_edit_material_master()" in policy, "material_relinks must allow material editors")
    assert_true(
        "revoke all on table public.material_relinks from public, anon, authenticated" in lower,
        "material_relinks must revoke default access",
    )
    assert_true(
        "grant select on table public.material_relinks to authenticated" in lower,
        "material_relinks must grant SELECT to authenticated",
    )
    assert_true(
        "grant all on table public.material_relinks to service_role" in lower,
        "material_relinks must grant writes only to service_role",
    )
    assert_true(
        "grant insert on table public.material_relinks to authenticated" not in lower,
        "authenticated must not write material_relinks directly",
    )

    # --- 2. relink RPC ------------------------------------------------------
    relink = extract_function(migration, "relink_item_material")
    relink_lower = relink.lower()
    for fragment in (
        "security definer",
        "set search_path = public, pg_temp",
        "if not public.has_role(v_actor, 'owner')",
        "raise exception 'insufficient_privilege' using errcode = '42501'",
        "for update",
        "raise exception 'item_not_linked'",
        "raise exception 'item_has_q7_movements' using errcode = '23514'",
        "raise exception 'same_material' using errcode = '23514'",
        "from public.material_relinks",
        "where request_id = p_request_id",
        "'replay', true",
        "material_master.link_request_id",
        "public.create_canonical_material(",
        "public.material_master_normalize(v_item.name)",
        "from public.q7_inventory_movements",
        "update public.sku_cogs_material_aliases",
        "update public.material_scoped_aliases",
        "update public.q7_material_issue_material_mappings",
        "insert into public.material_relinks",
    ):
        assert_true(canon(fragment) in canon(relink_lower), f"relink RPC missing: {fragment}")

    assert_true(
        relink_lower.count("material_master.link_request_id") >= 2,
        "relink RPC must set and reset material_master.link_request_id",
    )
    assert_true(
        "perform set_config('material_master.link_request_id', v_new_request_id::text, true)" in relink_lower,
        "relink RPC must set the guard GUC to the terminal request id",
    )
    assert_true(
        "perform set_config('material_master.link_request_id', '', true)" in relink_lower,
        "relink RPC must reset the guard GUC",
    )
    assert_true(
        "set active = false" in relink_lower,
        "aliases must be deactivated (active=false), never deleted",
    )
    assert_true(
        "set approval_status = 'rejected'" in relink_lower,
        "stale Q7 mappings must be marked rejected",
    )

    # The function is the only writer; never delete identities/history.
    for table in (
        "sku_cogs_material_aliases",
        "material_scoped_aliases",
        "kitchen_inventory_items",
        "q7_inventory_movements",
    ):
        assert_true(
            not re.search(rf"\bdelete\s+from\s+(?:public\.)?{re.escape(table)}\b", compact),
            f"migration must never delete from {table}",
        )
    assert_true(
        "delete from public.material_relinks" not in compact,
        "relink audit rows must not be deleted",
    )

    # --- 3. resolver: unchanged failures + the 'not_material' branch --------
    resolver = extract_function(migration, "resolve_q7_canonical_inventory_item")
    resolver_lower = resolver.lower()
    for fragment in (
        "q7_canonical_link_required",
        "q7_mapping_required",
        "q7_mapping_identity_mismatch",
        "unit_mismatch",
        "from public.material_link_skips s",
        "s.reason = 'not_material'",
        "v_item.canonical_material_id is null",
        "null::uuid",
        "null::text",
        "1::numeric",
    ):
        assert_true(canon(fragment) in canon(resolver_lower), f"resolver missing: {fragment}")

    branch_at = resolver_lower.index("from public.material_link_skips s")
    required_at = resolver_lower.index("q7_canonical_link_required")
    assert_true(branch_at < required_at, "not_material branch must be before q7_canonical_link_required")
    assert_true(
        resolver_lower.count("1::numeric") >= 1,
        "not_material resolver row must use conversion_factor 1",
    )

    # --- 4. rollback smoke ---------------------------------------------------
    smoke = read(SMOKE)
    smoke_lower = smoke.lower()
    for fragment in (
        "begin;",
        "rollback;",
        "request.jwt.claims",
        "nvl-025",
        "insufficient_privilege",
        "q7-b9503866f1bee04ec5f8",
        "item_has_q7_movements",
        "create_stock_material_item",
        "skip_item_material_link",
        "record_q7_stock_count",
        "q7_canonical_link_required",
        "smoke_result pass",
    ):
        assert_true(fragment in smoke_lower, f"rollback smoke missing: {fragment}")

    print("OK: relink / Q7 supplies contracts")


if __name__ == "__main__":
    main()
