#!/usr/bin/env python3
"""Static contract for the SKU COGS standard-cost seed migration.

Reads local source only. It applies no migration, commits nothing and deploys
nothing. Run from apps/web:

    python3 scripts/test_sku_cogs_seed_standard_cost_contract.py
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS_DIR = ROOT / "supabase" / "migrations"
SMOKE = ROOT / "supabase" / "tests" / "sku_cogs_seed_standard_cost_prod_smoke.sql"

FAILURES: list[str] = []


def check(condition: bool, message: str) -> None:
    if condition:
        print(f"ok - {message}")
    else:
        FAILURES.append(message)
        print(f"not ok - {message}")


def main() -> int:
    migrations = sorted(MIGRATIONS_DIR.glob("*_sku_cogs_seed_standard_cost.sql"))
    check(len(migrations) == 1, "exactly one *_sku_cogs_seed_standard_cost.sql migration exists")
    if len(migrations) != 1:
        return 1
    migration_path = migrations[0]
    migration = migration_path.read_text(encoding="utf-8")
    smoke = SMOKE.read_text(encoding="utf-8")
    lowered = migration.lower()

    seed_start = migration.find("create or replace function public.seed_sku_cogs_standard_costs(")
    save_start = migration.find("create or replace function public.save_sku_cogs(")
    check(seed_start >= 0, "seed_sku_cogs_standard_costs is created")
    check(save_start >= 0, "save_sku_cogs is replaced")
    seed_segment = migration[seed_start:save_start] if seed_start >= 0 and save_start > seed_start else ""
    save_segment = migration[save_start:] if save_start >= 0 else ""

    # (1) Seed function shape and privileges.
    check("security definer" in seed_segment.lower(), "seed function is SECURITY DEFINER")
    check(
        re.search(r"set\s+search_path\s*=\s*public\s*,\s*pg_temp", seed_segment, re.IGNORECASE) is not None,
        "seed function pins search_path = public, pg_temp",
    )
    revoke_match = re.search(
        r"revoke all on function public\.seed_sku_cogs_standard_costs\([^;]*\)\s*from ([^;]*);",
        migration,
        re.IGNORECASE,
    )
    check(revoke_match is not None, "seed function is revoked from client roles")
    if revoke_match:
        revoke_roles = revoke_match.group(1).lower()
        check("authenticated" in revoke_roles, "seed function is revoked from authenticated")
        check("anon" in revoke_roles, "seed function is revoked from anon")
        check("public" in revoke_roles, "seed function is revoked from public")

    # (2) Seed only writes approved standard_cost rows, never updates/deletes.
    check("insert into public.material_price_history" in seed_segment.lower(), "seed inserts material_price_history")
    check("'standard_cost'" in seed_segment, "seed writes price_type standard_cost")
    check("purchase_price" not in seed_segment.lower(), "seed never writes purchase_price")
    check(
        "update public.material_price_history" not in lowered,
        "migration never updates material_price_history",
    )
    check(
        "delete from public.material_price_history" not in lowered,
        "migration never deletes material_price_history",
    )

    # (3) save_sku_cogs seeds before the readiness assert and still blocks.
    seed_call = save_segment.find("public.seed_sku_cogs_standard_costs(")
    assert_call = save_segment.find("public.assert_sku_cogs_materials_ready(")
    check(seed_call >= 0, "save_sku_cogs calls the seed helper")
    check(assert_call >= 0, "save_sku_cogs still calls assert_sku_cogs_materials_ready")
    check(
        seed_call >= 0 and assert_call >= 0 and seed_call < assert_call,
        "seed helper is called before assert_sku_cogs_materials_ready",
    )
    check(
        "sku_cogs_material_blocked_before_publish" in save_segment,
        "save_sku_cogs still raises sku_cogs_material_blocked_before_publish",
    )
    if seed_call >= 0:
        call_text = save_segment[seed_call:seed_call + 400]
        check("p_formulations" in call_text, "seed call passes p_formulations")
        check("p_effective_from" in call_text, "seed call passes p_effective_from")
        check("zeroCostApproval" in call_text, "seed call passes zeroCostApproval")
        check("actor_id" in call_text, "seed call passes actor_id")
        check("sku_code" in call_text, "seed call passes sku_code")

    # (4) The existing readiness/resolution helpers are untouched.
    for function_name in (
        "assert_sku_cogs_materials_ready",
        "apply_sku_cogs_material_resolution",
        "link_material_to_sku_cogs",
    ):
        check(
            f"create or replace function public.{function_name}" not in lowered,
            f"migration does not recreate public.{function_name}",
        )

    # (5) Smoke pastes the migration verbatim and only rolls back.
    check(migration in smoke, "smoke test pastes the migration verbatim")
    check("begin;" in smoke.lower(), "smoke test opens a transaction")
    check("commit;" not in smoke.lower(), "smoke test never commits")
    smoke_lower = smoke.lower()
    check("request.jwt.claims" in smoke_lower, "smoke sets request.jwt.claims")
    check("smoke_result pass" in smoke_lower, "smoke raises SMOKE_RESULT PASS")
    check("smoke_result fail" in smoke_lower, "smoke raises SMOKE_RESULT FAIL on failure")

    if FAILURES:
        print(f"\nFAILED: {len(FAILURES)} contract(s)")
        for failure in FAILURES:
            print(f"  - {failure}")
        return 1
    print("\nPASS: sku cogs standard cost seed contract ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
