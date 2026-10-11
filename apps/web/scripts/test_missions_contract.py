#!/usr/bin/env python3
"""Static contract checks for the missions / badges / levels migration.

These checks never connect to a database or Supabase. They guard that migration
20261024100000_missions.sql:
  * creates every new table with RLS enabled and explicit grants (authenticated
    may read, only service_role may write directly);
  * marks the badge awards append-only with a trigger that rejects update / delete;
  * defines mission_evaluate and the client RPCs as SECURITY DEFINER with a pinned
    search_path and a revoke from public / anon;
  * shares the unknown-unit query between list_unknown_purchase_units and the
    mission check, and excludes ignored variants;
  * seeds the 3 owner missions from live data with no hard-coded UUID;
  * never redefines the existing merge / rename functions or the unit guard.
It also checks the rollback-only smoke test inlines the migration.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
SCRIPTS = ROOT / "scripts"

MIGRATION = MIGRATIONS / "20261024100000_missions.sql"
SMOKE = SCRIPTS / "smoke_missions.sql"

TABLES = (
    "mission_badges",
    "mission_levels",
    "missions",
    "mission_badge_awards",
    "mission_requests",
    "stock_item_distinct_pairs",
    "stock_unit_ignored_variants",
)

FUNCTIONS = (
    "mission_badge_awards_append_only()",
    "stock_unknown_purchase_unit_rows(integer)",
    "mission_level_for(integer)",
    "mission_evaluate(uuid)",
    "get_my_missions(uuid)",
    "complete_mission(uuid, uuid)",
    "update_stock_material_alias_factor(uuid, numeric, uuid)",
    "mark_stock_items_distinct(uuid, uuid, uuid)",
    "resolve_unknown_purchase_unit(text, text, text, uuid)",
)

UUID_RE = re.compile(
    r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
)


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
    assert_true(MIGRATION.exists(), f"missing migration {MIGRATION.name}")
    assert_true(
        MIGRATION.name == "20261024100000_missions.sql",
        "migration file must keep its timestamped name",
    )
    migration = read(MIGRATION)
    lower = migration.lower()

    # --- 1. tables: create + RLS + explicit grants --------------------------
    for table in TABLES:
        assert_true(
            f"create table if not exists public.{table}" in lower,
            f"migration must create public.{table}",
        )
        assert_true(
            f"alter table public.{table} enable row level security" in lower,
            f"public.{table} must enable RLS",
        )
        assert_true(
            f"grant select on table public.{table} to authenticated, service_role" in lower,
            f"public.{table} must grant select to authenticated, service_role",
        )
        assert_true(
            f"grant insert, update, delete on table public.{table} to service_role" in lower,
            f"public.{table} must grant writes only to service_role",
        )
        assert_true(
            f"revoke all on table public.{table} from public, anon, authenticated" in lower,
            f"public.{table} must revoke default client access",
        )

    # --- 2. functions: security definer + pinned search_path + revoke anon -
    for signature in FUNCTIONS:
        marker = f"function public.{signature.split('(')[0]}("
        assert_true(marker in lower, f"migration must define {signature}")
        body = body_after(lower, marker)
        assert_true("security definer" in body, f"{signature} must be SECURITY DEFINER")
        assert_true(
            "set search_path = public, pg_temp" in body,
            f"{signature} must pin search_path = public, pg_temp",
        )
        assert_true(
            f"revoke all on function public.{signature} from public, anon" in lower,
            f"{signature} must revoke execute from public / anon",
        )

    # mission_evaluate is internal: clients must never get execute.
    assert_true(
        "revoke all on function public.mission_evaluate(uuid) from public, anon, authenticated"
        in lower,
        "mission_evaluate must be revoked from authenticated too",
    )
    assert_true(
        "grant execute on function public.mission_evaluate(uuid) to authenticated" not in lower,
        "mission_evaluate must not be granted to clients",
    )

    # --- 3. append-only badge awards ---------------------------------------
    assert_true(
        "create or replace function public.mission_badge_awards_append_only()" in lower,
        "migration must define the append-only trigger function",
    )
    awards_trigger = lower[
        lower.index("create trigger mission_badge_awards_append_only") :
    ]
    assert_true(
        "before update or delete on public.mission_badge_awards" in awards_trigger,
        "the badge awards trigger must fire before update or delete",
    )
    assert_true(
        "mission_badge_awards_append_only" in lower
        and "raise exception 'mission_badge_awards_append_only'" in lower,
        "the awards trigger function must raise its own error",
    )

    # --- 4. shared unknown-unit query + ignored variants -------------------- 
    assert_true(
        "function public.stock_unknown_purchase_unit_rows(" in lower,
        "migration must define the shared unknown-unit helper",
    )
    helper = body_after(lower, "function public.stock_unknown_purchase_unit_rows(")
    assert_true(
        "public.stock_unknown_purchase_unit_rows(p_days)" in lower,
        "list_unknown_purchase_units must delegate to the shared helper",
    )
    assert_true(
        "from public.stock_unknown_purchase_unit_rows(p_days)" in lower,
        "list_unknown_purchase_units must read the shared helper",
    )
    assert_true(
        "public.stock_unit_ignored_variants" in helper
        and "not exists" in helper
        and "lower(btrim(i.unit))" in helper,
        "the helper must exclude ignored variants by lower(btrim(unit))",
    )
    assert_true(
        "list_unknown_purchase_units" in lower and "forbidden" in lower,
        "list_unknown_purchase_units must keep its admin gate",
    )

    # --- 5. mission_evaluate rules -----------------------------------------
    evaluate = body_after(lower, "function public.mission_evaluate(")
    for token in (
        "stock_alias_factor_fixed",
        "stock_duplicate_resolved",
        "stock_unknown_units_cleared",
        "'done'",
        "'total'",
        "'left'",
        "'detail'",
    ):
        assert_true(token in evaluate, f"mission_evaluate must handle {token}")
    assert_true(
        "conversion_factor is distinct from v_bad_factor" in evaluate
        and "kitchen_inventory_item_id is distinct from v_bad_item" in evaluate,
        "the alias rule must compare factor and target item",
    )
    assert_true(
        "stock_item_distinct_pairs" in evaluate,
        "the duplicate rule must read stock_item_distinct_pairs",
    )

    # --- 6. client RPC contracts -------------------------------------------
    get_mine = body_after(lower, "function public.get_my_missions(")
    for token in ("missions", "badges", "by_code", "level", "next_level", "recent_awards"):
        assert_true(token in get_mine, f"get_my_missions must return {token}")
    assert_true(
        "public.material_alias_can_admin" in get_mine,
        "get_my_missions must allow an admin to read another user",
    )
    assert_true(
        "public.mission_evaluate(m.id)" in get_mine,
        "get_my_missions must attach the evaluation progress",
    )

    complete = body_after(lower, "function public.complete_mission(")
    for token in (
        "for update",
        "'forbidden'",
        "'mission_not_done'",
        "mission_badge_awards",
        "mission_requests",
        "level_before",
        "level_after",
        "leveled_up",
    ):
        assert_true(token in complete, f"complete_mission must use {token}")

    factor = body_after(lower, "function public.update_stock_material_alias_factor(")
    assert_true(
        "'invalid_factor'" in factor
        and "p_factor <= 0" in factor
        and "p_factor::text in ('nan', 'infinity', '-infinity')" in factor,
        "update_stock_material_alias_factor must reject a non-finite / non-positive factor",
    )
    assert_true(
        "insert into public.material_alias_events" in factor,
        "update_stock_material_alias_factor must write the audit event",
    )

    distinct = body_after(lower, "function public.mark_stock_items_distinct(")
    assert_true(
        "stock_item_distinct_pairs" in distinct
        and "'items_must_differ'" in distinct
        and "least(p_item_a, p_item_b)" in distinct,
        "mark_stock_items_distinct must store the ordered pair and reject the same item",
    )

    resolve = body_after(lower, "function public.resolve_unknown_purchase_unit(")
    for token in ("'map'", "'not_stock'", "'invalid_action'", "'unknown_unit_code'", "stock_unit_aliases"):
        assert_true(token in resolve, f"resolve_unknown_purchase_unit must use {token}")
    assert_true(
        "public.stock_units" in resolve,
        "resolve_unknown_purchase_unit must validate p_code against stock_units",
    )

    # --- 7. seed: data lookups, no hard-coded UUID --------------------------
    seed_start = lower.index("$seed_missions$")
    seed_end = lower.index("$seed_missions$;", seed_start)
    seed = lower[seed_start:seed_end]
    assert_true("from public.user_roles" in seed, "the seed must read public.user_roles")
    assert_true("role::text = 'owner'" in seed, "the seed must pick the owner role")
    assert_true(
        "on conflict (code) do nothing" in seed,
        "the seed must be idempotent with ON CONFLICT (code) DO NOTHING",
    )
    assert_true("raise notice" in seed, "the seed must skip missing data with RAISE NOTICE")
    assert_true(
        "wh-fix-alias-factors" in seed
        and "wh-croissant-duplicate" in seed
        and "wh-unknown-units" in seed,
        "the seed must define the 3 warehouse mission codes",
    )
    assert_true(
        UUID_RE.search(seed) is None,
        "the seed must not hard-code any UUID",
    )

    # --- 8. never redefine the shared merge / rename / unit guard -----------
    assert_true(
        "create or replace function public.apply_stock_item_merge" not in lower,
        "migration must not redefine apply_stock_item_merge",
    )
    assert_true(
        "create or replace function public.rename_stock_item" not in lower,
        "migration must not redefine rename_stock_item",
    )
    assert_true(
        "kitchen_inventory_items_unit_guard" not in lower,
        "migration must not redefine the catalog unit guard",
    )

    # --- 9. no manual push instruction -------------------------------------
    forbidden_push = "supabase" + " db push"
    assert_true(forbidden_push not in lower, "migration must not tell anyone to run db push")

    # --- 10. smoke test ------------------------------------------------------
    assert_true(SMOKE.exists(), f"missing smoke test {SMOKE.name}")
    smoke = read(SMOKE)
    smoke_lower = smoke.lower()
    assert_true(smoke.startswith("--"), "smoke must start with a comment header")
    assert_true("\nbegin;" in smoke, "smoke must open one transaction")
    assert_true("rollback;" not in smoke_lower, "smoke must roll back via the final RAISE")
    assert_true("commit;" not in smoke_lower, "smoke must not commit")
    assert_true(
        forbidden_push not in smoke_lower,
        "smoke must not tell anyone to run db push",
    )
    assert_true(
        migration.strip() in smoke,
        "smoke must inline the migration byte-for-byte (regenerate it when the migration changes)",
    )
    assert_true("SMOKE_RESULT PASS" in smoke, "smoke must raise SMOKE_RESULT PASS")
    assert_true("SMOKE_RESULT FAIL" in smoke, "smoke must raise SMOKE_RESULT FAIL on a bad step")
    for step in (
        "missions_seeded",
        "mission1_total",
        "mission2_total",
        "mission3_total",
        "level_start",
        "next_level",
        "mission_not_done",
        "factor_fixed",
        "rename_savepoint",
        "distinct_pair",
        "unknown_units",
        "ignored_excluded",
        "leveled_up",
        "idempotent_award",
        "awards_append_only",
        "forbidden_read",
        "forbidden_complete",
        "forbidden_admin",
    ):
        assert_true(step in smoke, f"smoke must cover the {step} step")
    assert_true(
        "from public.user_roles" in smoke and "role::text = 'owner'" in smoke,
        "smoke must take the owner from public.user_roles",
    )
    assert_true(
        "request.jwt.claims" in smoke,
        "smoke must impersonate the real owner / employee through auth claims",
    )

    print("PASS: missions data-layer contracts hold")


if __name__ == "__main__":
    main()
