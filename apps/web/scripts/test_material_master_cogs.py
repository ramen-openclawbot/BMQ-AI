#!/usr/bin/env python3
"""Task7 canonical NVL COGS controller contract tests.

Static contracts intentionally inspect executable SQL and changed Edge/UI paths.
They reject comment-only smoke templates and browser-only enforcement.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20260817183000_task7_cogs_material_controller.sql"
SMOKE = ROOT / "scripts/material_master/cogs_material_rollback_smoke.sql"
EDGE_SCAN = ROOT / "supabase/functions/scan-sku-cost-sheet/index.ts"
SHARED_CONTROLLER = ROOT / "supabase/functions/_shared/material-controller.ts"
SKU_PAGE = ROOT / "src/pages/SkuCostsManagement.tsx"


def read(path: Path) -> str:
    assert path.exists(), f"Missing required file: {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def uncommented(text: str) -> str:
    text = re.sub(r"/\*[\s\S]*?\*/", "", text)
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("--"))


def assert_contains(text: str, needle: str, label: str) -> None:
    assert needle in text, f"Missing {label}: {needle}"


def assert_regex(text: str, pattern: str, label: str) -> None:
    assert re.search(pattern, text, re.I | re.S), f"Missing {label}: {pattern}"


def assert_no_cogs_history_dml(sql: str) -> None:
    body = uncommented(sql).lower()
    protected = ["sku_cogs_versions", "sku_cogs_version_formulations"]
    for table in protected:
        for verb in ["delete from", "truncate"]:
            assert not re.search(rf"\b{verb}\s+(?:public\.)?{table}\b", body), f"Task7 must never {verb} historical {table}"
    # Closing the current version inside the save controller is allowed; migration-time backfill/rewrite is not.
    assert "chuyển bơ imperial" not in body and "baseline công thức" not in body, "Task7 migration must not rewrite historical COGS baselines"


def main() -> None:
    sql = read(MIGRATION)
    smoke = read(SMOKE)
    smoke_exec = uncommented(smoke)
    edge = read(EDGE_SCAN)
    shared = read(SHARED_CONTROLLER)
    page = read(SKU_PAGE)

    assert_no_cogs_history_dml(sql)

    assert_regex(sql, r"\('sku_cogs',\s*'enforced'\)", "COGS enforcement config is fail-closed")
    assert_regex(sql, r"add column if not exists material_resolution_status", "sku_formulations resolution status column")
    assert_regex(sql, r"add column if not exists material_resolution_request_id", "sku_formulations resolution request column")
    assert_regex(sql, r"add column if not exists canonical_material_snapshot", "immutable version formulation canonical snapshot column")
    assert_regex(sql, r"create or replace function public\.apply_sku_cogs_material_resolution\s*\(", "COGS line resolver/apply RPC")
    assert_regex(sql, r"create or replace function public\.assert_sku_cogs_materials_ready\s*\(", "COGS readiness RPC")
    assert_regex(sql, r"create or replace function public\.save_sku_cogs\s*\(", "server-side save_sku_cogs replacement")
    assert_regex(sql, r"public\.resolve_canonical_material\([^;]*'sku_cogs'[^;]*array\['unit','standard_cost'\]", "exact resolver with unit+standard_cost capabilities")
    assert_regex(sql, r"public\.request_material_resolution\([^;]*'sku_cogs'[^;]*'sku_formulations'", "unknown/ambiguous idempotent request")
    assert_regex(sql, r"material_resolution_required|sku_cogs_material_blocked_before_publish", "unresolved lines block save/publish")
    assert_regex(sql, r"unit_unmapped|missing_standard_cost", "incompatible unit/missing price blockers")
    assert_regex(sql, r"zero cost standard cost requires explicit approval|zero_cost_standard_cost_approved", "zero-cost explicit server policy")
    assert_regex(sql, r"normalized_base_unit_price|material_unit_conversions", "unit conversion before cost")
    assert_regex(sql, r"jsonb_build_object\([^;]*canonical_material_name[^;]*canonical_material_code[^;]*canonical_default_unit[^;]*standard_unit_price", "published immutable canonical snapshots")
    assert_regex(sql, r"set_config\('material_master\.sku_cogs_save'", "controlled GUC for formulation mutation")
    assert_regex(sql, r"before\s+insert\s+or\s+update(?:\s+of[^\n]+)?\s+or\s+delete", "guard covers direct insert/update/delete formulation bypasses")
    assert_regex(sql, r"apply_sku_cogs_material_resolution[\s\S]*has_role\([^;]*(?:owner|staff|warehouse)", "apply RPC enforces COGS edit permission")
    assert_contains(
        sql,
        "revoke all on function public.apply_sku_cogs_material_resolution(uuid, text, text, text, date, boolean, text) from public, anon, authenticated, service_role",
        "line apply RPC is internal-only so browser calls cannot mutate formulations outside versioned save",
    )
    assert not re.search(r"grant\s+execute\s+on\s+function\s+public\.apply_sku_cogs_material_resolution\([^)]*\)\s+to\s+authenticated", sql, re.I | re.S), "apply RPC must not be executable by authenticated browser callers"
    assert_contains(sql, "direct sku cogs material mutation is not allowed", "direct authenticated bypass denial trigger")
    assert_regex(
        sql,
        r"create\s+trigger\s+trg_guard_product_sku_cogs_mutation[\s\S]*before\s+update\s+of[\s\S]*sku_code[\s\S]*product_name[\s\S]*unit[\s\S]*category[\s\S]*base_unit[\s\S]*cost_values[\s\S]*cost_widgets[\s\S]*cost_template[\s\S]*finished_output_qty[\s\S]*finished_output_unit[\s\S]*on\s+public\.product_skus",
        "DB guard blocks direct inline product_skus COGS edits",
    )
    assert_regex(sql, r"create\s+trigger\s+trg_guard_product_sku_cogs_delete[\s\S]*before\s+delete\s+on\s+public\.product_skus", "DB guard preserves products with published COGS history")
    assert_contains(sql, "direct product sku cogs mutation is not allowed", "product_skus inline COGS bypass denial")
    assert_contains(sql, "old.sku_type::text", "product SKU guard compares enum safely at runtime")
    assert_contains(sql, "revoke all on function public.assert_sku_cogs_materials_ready(jsonb, date, boolean) from public, anon, authenticated, service_role", "readiness RPC is internal-only")
    assert_contains(sql, "revoke all on function public.sku_cogs_material_price_snapshot(uuid, text, date) from public, anon, authenticated, service_role", "price snapshot helper is internal-only")
    assert_contains(sql, "revoke all on function public.save_sku_cogs(uuid, jsonb, jsonb, date, text) from public, anon, service_role", "service role cannot spoof save actor attribution")
    assert_regex(sql, r"grant execute on function public\.save_sku_cogs\([^)]*\) to authenticated", "browser can only save through controller")
    assert not re.search(r"grant\s+execute\s+on\s+function\s+public\.save_sku_cogs\([^)]*\)\s+to[^;]*service_role", sql, re.I | re.S), "save RPC must not grant service_role actor-spoof path"

    assert_contains(shared, '"sku_cogs"', "shared controller accepts sku_cogs source type")
    assert_contains(shared, '"sku_formulations"', "shared controller accepts sku_formulations source table")
    assert_contains(shared, 'input.source_type === "sku_cogs" ? ["unit", "standard_cost"]', "COGS required capabilities in shared controller")
    assert_contains(shared, 'input.source_line_id || input.source_type === "sku_cogs"', "scan COGS unresolved rows create idempotent requests before a draft line exists")
    assert_contains(shared, 'p_effective_date', "shared controller forwards effective date")

    assert_contains(edge, "resolveCanonicalMaterialForLine", "scan Edge reuses shared material controller")
    assert_contains(edge, 'source_type: "sku_cogs"', "scan Edge resolves as sku_cogs")
    assert_contains(edge, 'source_table: "sku_formulations"', "scan Edge request source table")
    assert_contains(edge, "material_resolution_request_id", "scan Edge returns request id")
    assert_contains(edge, "material_resolution_status", "scan Edge returns resolution status")
    assert_contains(edge, "canonical_default_unit", "scan Edge returns canonical unit")
    assert "SKU_COGS_MATERIAL_NOT_FOUND" not in edge, "scan must request resolution instead of static unknown-only failure"
    assert "materialIdByName" not in edge, "scan must not browser/Edge-only local-map resolve canonical materials"

    assert_contains(page, "material_resolution_status", "UI tracks resolution status")
    assert_contains(page, "material_resolution_request_id", "UI tracks request id")
    assert_contains(page, "canonical_default_unit", "UI tracks canonical unit snapshots")
    assert_contains(page, "blockedCogsMaterialRows", "UI blocks unresolved rows before save")
    assert_contains(page, "zeroCostApproval", "UI requires explicit zero cost approval")
    assert_contains(page, "save_sku_cogs", "UI still saves through server controller")
    assert_contains(page, "material_resolution_request_id", "UI sends request metadata to save controller")
    assert '.from("sku_formulations").delete()' not in page and ".from('sku_formulations').delete()" not in page, "UI cannot directly delete canonical formulations"
    assert '.from("product_skus").delete()' not in page and ".from('product_skus').delete()" not in page, "UI cannot delete published COGS history"
    assert not re.search(r"\.from\([\"']product_skus[\"']\)\.update\(", page), "inline cost edits cannot bypass versioned save_sku_cogs"

    for marker in [
        "BEGIN;",
        "ROLLBACK;",
        "exact_alias_unit_price_snapshot",
        "ambiguous_missing_request_idempotent",
        "incompatible_unit_blocked",
        "zero_cost_requires_policy_approval",
        "publish_snapshot_immutability_idempotency",
        "protected_149_linked_formulations_unchanged",
        "direct_authenticated_bypass_denial",
        "service_role_actor_spoof_denial",
        "post_rollback_absence",
    ]:
        assert_contains(smoke_exec, marker, f"executable runtime smoke marker {marker}")
    for executable_probe in [
        "apply_sku_cogs_material_resolution",
        "assert_sku_cogs_materials_ready",
        "save_sku_cogs",
        "resolve_canonical_material",
        "request_material_resolution",
        "update public.sku_formulations set canonical_material_id",
        "update public.product_skus set cost_values",
        "delete from public.product_skus",
        "raise exception 'direct authenticated cogs bypass unexpectedly succeeded'",
        "raise exception 'direct product sku cogs bypass unexpectedly succeeded'",
        "raise exception 'published product sku delete unexpectedly succeeded'",
    ]:
        assert_contains(smoke_exec, executable_probe, f"runtime executable probe {executable_probe}")

    print("Task7 COGS material controller contracts passed")


if __name__ == "__main__":
    main()
