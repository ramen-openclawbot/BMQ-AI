#!/usr/bin/env python3
"""Static contract checks for the "Gắn mã chuẩn" defer-factor migration.

These checks never connect to a database or Supabase. They guard that migration
20261101190000_material_link_defer_factor.sql and the shipped source:

  * create public.material_link_pending_factors with its RLS, one select policy
    and the client/service grants;
  * extend public.q7_link_item_material_internal with p_defer_factor while
    keeping public.link_q7_item_material at exactly 5 parameters and teaching
    public.link_item_material to accept p_defer_factor;
  * add public.set_item_material_factor gated on the Material Master editor and
    raising item_not_linked / invalid_factor;
  * re-rank review candidates by unit_status and drop score < 0.3 unless 'same';
  * attach last_purchase_line to each item and pending_factor to the counts, and
    add public.get_material_link_pending_factors(text);
  * make the hook send p_defer_factor, call set_item_material_factor and read the
    pending-factors RPC.

Everything here is a text assertion; it does not prove runtime behaviour.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
SCRIPTS = ROOT / "scripts"

MIGRATION = MIGRATIONS / "20261101190000_material_link_defer_factor.sql"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def extract_function(text: str, marker: str) -> str:
    """Return the full function definition from marker to its closing dollar tag."""
    start = text.index(marker)
    match = re.search(r"\bas\s+(\$[A-Za-z_]*\$)", text[start:], re.IGNORECASE)
    assert_true(match is not None, f"no AS dollar-quote after {marker}")
    tag = match.group(1)
    end = text.index(tag + ";", start + match.end())
    return text[start:end + len(tag) + 1]


def canon(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def param_names(function_def: str) -> list[str]:
    """Parameter names between the function name and RETURNS."""
    signature = function_def.split("returns", 1)[0]
    return re.findall(r"\bp_[a-z_0-9]+\b", signature)


def main() -> None:
    assert_true(MIGRATION.exists(), f"missing migration {MIGRATION.name}")
    assert_true(
        MIGRATION.name == "20261101190000_material_link_defer_factor.sql",
        "migration file must keep its timestamped name",
    )
    migration = read(MIGRATION)
    lower = migration.lower()

    # --- 1. material_link_pending_factors table + RLS + policy + grants ------
    assert_true(
        "create table if not exists public.material_link_pending_factors" in lower,
        "migration must create public.material_link_pending_factors",
    )
    assert_true(
        "item_id uuid primary key references public.kitchen_inventory_items(id)" in lower,
        "pending factors must key the item and reference kitchen_inventory_items",
    )
    assert_true(
        "material_id uuid not null references public.sku_cogs_materials(id)" in lower,
        "pending factors must reference sku_cogs_materials",
    )
    assert_true(
        "created_by uuid" in lower and "created_at timestamptz not null default now()" in lower,
        "pending factors must carry created_by / created_at",
    )
    assert_true(
        "alter table public.material_link_pending_factors enable row level security" in lower,
        "pending factors must enable RLS",
    )
    assert_true(
        "create policy material_link_pending_factors_select on public.material_link_pending_factors" in lower
        and "for select to authenticated using (true)" in lower,
        "pending factors must have one authenticated select policy",
    )
    assert_true(
        "grant select on table public.material_link_pending_factors to authenticated" in lower,
        "pending factors must grant select to authenticated",
    )
    assert_true(
        "grant all on table public.material_link_pending_factors to service_role" in lower,
        "pending factors must grant all to service_role",
    )

    # --- 2. defer-aware linking ---------------------------------------------
    internal_marker = "create or replace function public.q7_link_item_material_internal("
    internal_def = extract_function(migration, internal_marker)
    assert_true(
        "p_defer_factor boolean default false" in canon(internal_def),
        "q7_link_item_material_internal must take p_defer_factor default false",
    )
    assert_true(
        "material_link_pending_factors" in internal_def,
        "the linking core must write/clear material_link_pending_factors",
    )
    assert_true(
        "factor_pending" in internal_def,
        "the linking core result must carry factor_pending",
    )
    assert_true(
        "material_master.defer_unit" in migration,
        "the defer link must scope the controller unit bypass to a transaction flag",
    )

    internal_drop = "drop function if exists public.q7_link_item_material_internal(uuid, uuid, boolean, uuid, numeric)"
    assert_true(
        internal_drop in migration,
        "the old 5-arg linking core must be dropped before the new signature",
    )

    link_item_marker = "create or replace function public.link_item_material("
    assert_true(link_item_marker in migration, "migration must define public.link_item_material")
    link_item_def = extract_function(migration, link_item_marker)
    assert_true(
        "p_defer_factor boolean default false" in canon(link_item_def),
        "link_item_material must accept p_defer_factor default false",
    )
    assert_true(
        "q7_link_item_material_internal" in link_item_def,
        "link_item_material must call the shared linking core",
    )
    assert_true(
        "drop function if exists public.link_item_material(uuid, uuid, boolean, uuid, numeric)" in migration,
        "the old 5-arg link_item_material must be dropped first",
    )

    q7_marker = "create or replace function public.link_q7_item_material("
    assert_true(q7_marker in migration, "migration must keep public.link_q7_item_material")
    q7_def = extract_function(migration, q7_marker)
    q7_params = [p for p in param_names(q7_def) if p not in ("p_item_id", "p_material_id", "p_create_new", "p_request_id", "p_unit_factor")]
    assert_true(not q7_params, f"link_q7_item_material must have exactly 5 parameters, extra={q7_params}")
    assert_true(
        len(param_names(q7_def)) == 5,
        f"link_q7_item_material must have exactly 5 parameters, got {param_names(q7_def)}",
    )
    assert_true(
        "p_defer_factor" not in q7_def,
        "link_q7_item_material must keep its 5-arg contract",
    )
    assert_true(
        canon(q7_def).count("q7_link_item_material_internal(") == 1
        and ", false )" in canon(q7_def),
        "link_q7_item_material must call the core with false",
    )

    exact_marker = "create or replace function public.link_exact_materials("
    assert_true(exact_marker in migration, "migration must keep public.link_exact_materials")
    exact_def = extract_function(migration, exact_marker)
    assert_true(
        "q7_link_item_material_internal" in exact_def and ", false )" in canon(exact_def),
        "link_exact_materials must pass false to the core",
    )

    # --- 3. set_item_material_factor ----------------------------------------
    set_marker = "create or replace function public.set_item_material_factor("
    assert_true(set_marker in migration, "migration must define public.set_item_material_factor")
    set_def = extract_function(migration, set_marker)
    set_canon = canon(set_def)
    assert_true(
        "can_edit_material_master" in set_def and "'insufficient_privilege'" in set_def
        and "42501" in set_def,
        "set_item_material_factor must gate on can_edit_material_master (42501)",
    )
    assert_true(
        "'item_not_linked'" in set_def and "22023" in set_def,
        "set_item_material_factor must raise item_not_linked (22023)",
    )
    assert_true(
        "'invalid_factor'" in set_def and "22023" in set_def,
        "set_item_material_factor must raise invalid_factor (22023)",
    )
    assert_true(
        "material_unit_conversions" in set_def,
        "set_item_material_factor must write through material_unit_conversions",
    )
    assert_true(
        "material_link_pending_factors" in set_def,
        "set_item_material_factor must upsert/clear the pending row",
    )
    assert_true(
        "security definer" in set_canon and "set search_path = public, extensions, pg_temp" in set_canon,
        "set_item_material_factor must be SECURITY DEFINER with the extensions search path",
    )
    assert_true(
        "grant execute on function public.set_item_material_factor(uuid, numeric) to authenticated, service_role"
        in lower,
        "set_item_material_factor must be granted to authenticated and service_role",
    )
    assert_true(
        "revoke execute on function public.set_item_material_factor(uuid, numeric) from public, anon" in lower,
        "set_item_material_factor must be revoked from public/anon",
    )

    # --- 4. review: ranking, score filter, last purchase line, counts --------
    review_marker = "create or replace function public.material_link_review_items_internal("
    review_def = extract_function(migration, review_marker)
    review_canon = canon(review_def)
    assert_true(
        "can_edit_material_master" not in review_def,
        "the internal review core must stay gate-free for mission_evaluate",
    )
    assert_true(
        "case g.unit_status when 'same' then 0 when 'auto' then 1 else 2 end" in review_canon,
        "review candidates must be ordered by unit_status (same > auto > needs_factor)",
    )
    assert_true(
        "g.unit_status = 'same' or g.score >= 0.3" in review_canon,
        "review must drop candidates with score < 0.3 unless unit_status = 'same'",
    )
    assert_true(
        "material_link_name_words" in review_def,
        "review must pull same-unit materials sharing a meaningful word",
    )
    assert_true(
        "'last_purchase_line'" in review_def and "material_link_last_purchase_line" in review_def,
        "each review item must carry last_purchase_line",
    )
    assert_true(
        "'pending_factor'" in review_def,
        "review counts must include pending_factor",
    )
    assert_true(
        "material_link_pending_factors" in review_def,
        "review pending_factor must count the pending table",
    )
    assert_true(
        "limit 3" in review_canon,
        "review must keep at most 3 candidates",
    )

    # --- 5. get_material_link_pending_factors -------------------------------
    pending_marker = "create or replace function public.get_material_link_pending_factors("
    assert_true(
        pending_marker in migration,
        "migration must define public.get_material_link_pending_factors",
    )
    pending_def = extract_function(migration, pending_marker)
    assert_true(
        "can_edit_material_master" in pending_def,
        "get_material_link_pending_factors must be gated",
    )
    assert_true(
        "'last_purchase_line'" in pending_def and "material_link_last_purchase_line" in pending_def,
        "pending factors must expose last_purchase_line",
    )
    assert_true(
        "grant execute on function public.get_material_link_pending_factors(text) to authenticated, service_role"
        in lower,
        "get_material_link_pending_factors must be granted to authenticated and service_role",
    )

    # The material-link quest front end left with the old warehouse game (owner 21/10/2026); only the backend is guarded here.

    print("PASS: material link defer-factor contracts hold")


if __name__ == "__main__":
    main()
