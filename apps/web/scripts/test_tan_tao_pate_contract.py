#!/usr/bin/env python3
"""Static contracts for the Tân Tạo pate recipe / production migration.

These checks never connect to a database. They guard that
20261101440000_tan_tao_pate_recipe_production.sql:
  * creates the recipe / line / slip tables with RLS and select-only grants;
  * adds 'production' to the Tân Tạo material source check and
    'production_receipt' to the warehouse document type check;
  * keeps the answer / batch RPCs owner-only and the production RPC gated by
    can_manage_tan_tao_warehouse or owner;
  * refuses an incomplete recipe, a date on/before the Tân Tạo cutover and
    replays a stored request without writing new movements;
  * writes production_usage material rows with a pate-slip source_ref_key and
    posts the packed SKUs through the production_receipt document path;
  * never updates / deletes an existing movement;
  * extends mission_evaluate while keeping every older rule, including
    q7_bom_mismatch_resolved;
  * seeds the recipe and the owner mission;
  * keeps the rollback smoke aligned.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = ROOT / "supabase" / "migrations"
SCRIPTS = ROOT / "scripts"

MIGRATION = MIGRATIONS / "20261101440000_tan_tao_pate_recipe_production.sql"
SMOKE = SCRIPTS / "smoke_tan_tao_pate.sql"

TABLES = (
    "tan_tao_recipes",
    "tan_tao_recipe_lines",
    "tan_tao_production_slips",
)


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def assert_true(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def body_after(text: str, marker: str) -> str:
    """Return SQL from marker to the end of that function ($;$)."""
    start = text.index(marker)
    end = text.index("$$;", start)
    return text[start:end]


def main() -> None:
    assert_true(MIGRATION.exists(), f"missing migration {MIGRATION.name}")
    assert_true(
        MIGRATION.name == "20261101440000_tan_tao_pate_recipe_production.sql",
        "migration file must keep its timestamped name",
    )
    sql = read(MIGRATION)
    lower = sql.lower()

    # --- 1. tables, RLS, select-only grants --------------------------------
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
            f"revoke all on table public.{table} from public, anon, authenticated" in lower,
            f"public.{table} must revoke default client access",
        )
        assert_true(
            f"grant select on table public.{table} to authenticated" in lower,
            f"public.{table} must grant select to authenticated",
        )
        assert_true(
            f"grant all on table public.{table} to service_role" in lower,
            f"public.{table} must grant writes only to service_role",
        )
        assert_true(
            f"create policy {table}_select on public.{table}" in lower,
            f"public.{table} must expose a select policy",
        )

    # --- 2. source / document type constraints -----------------------------
    source = lower[
        lower.index("tan_tao_material_movements_source_check") :
    ]
    source = source[: source.index(");")]
    for token in (
        "'goods_receipt'",
        "'manual_adjustment'",
        "'item_merge'",
        "'item_merge_revert'",
        "'stock_transfer'",
        "'production'",
    ):
        assert_true(token in source, f"material source check must keep {token}")

    doc_type = lower[
        lower.index("tan_tao_warehouse_documents_type_check") :
    ]
    doc_type = doc_type[: doc_type.index(");")]
    for token in (
        "'opening'",
        "'supplier_order'",
        "'receipt'",
        "'outbound_order'",
        "'dispatch'",
        "'stock_count'",
        "'adjustment'",
        "'cancellation'",
        "'production_receipt'",
    ):
        assert_true(token in doc_type, f"document type check must keep {token}")

    assert_true(
        "tan_tao_warehouse_documents_status_check" in lower
        and "'closed'" in lower,
        "migration must re-affirm the current status check including closed",
    )

    # --- 3. owner-only answer / batch RPCs --------------------------------
    answer = body_after(lower, "function public.answer_tan_tao_recipe_line(")
    for token in (
        "p_line_id",
        "p_item_id",
        "p_grams",
        "p_not_used",
        "p_pack_item_id",
        "p_label_item_id",
        "p_pate_grams",
        "p_request_id",
        "has_role(v_actor, 'owner'::public.app_role)",
        "insufficient_privilege",
        "recipe_line_not_found",
        "ingredient_item_required",
        "invalid_grams_per_batch",
        "pack_item_required",
        "invalid_pate_grams_per_pack",
        "answered_by",
        "answered_at",
        "tan_tao_recipe_refresh_status",
    ):
        assert_true(token in answer, f"answer RPC must use {token}")

    batch = body_after(lower, "function public.set_tan_tao_recipe_batch(")
    for token in (
        "p_code",
        "p_batch_output_kg",
        "p_request_id",
        "has_role(v_actor, 'owner'::public.app_role)",
        "invalid_batch_output_kg",
        "tan_tao_recipe_refresh_status",
    ):
        assert_true(token in batch, f"batch RPC must use {token}")

    # --- 4. production RPC gates + write path -----------------------------
    production = body_after(lower, "function public.record_tan_tao_pate_production(")
    for token in (
        "p_date",
        "p_batches",
        "p_packs",
        "p_note",
        "p_request_id",
        "can_manage_tan_tao_warehouse()",
        "has_role(v_actor, 'owner'::public.app_role)",
        "recipe_incomplete",
        "before_cutover",
        "stock_ledger_cutover_date('tan_tao')",
        "request_id",
        "replay",
        "'production_usage'",
        "'production'",
        "'pate-slip:'",
        "grams_per_batch",
        "stock_unit_line_factor('g'",
        "unit_conversion_missing",
        "record_tan_tao_production_receipt",
        "tan_tao_production_slips",
    ):
        assert_true(token in production, f"production RPC must use {token}")

    assert_true(
        "p_date <= v_cutover" in production,
        "production must refuse dates on/before the Tân Tạo cutover",
    )
    assert_true(
        "v_recipe.status <> 'complete'" in production,
        "production must refuse an incomplete recipe",
    )
    assert_true(
        "insert into public.tan_tao_material_movements" in production
        and "on conflict (source, source_ref_key)" in production,
        "production must append production_usage movements idempotently",
    )

    receipt = body_after(lower, "function public.record_tan_tao_production_receipt(")
    for token in (
        "p_sku_code",
        "p_quantity",
        "p_idempotency_key",
        "p_slip_id",
        "'production_receipt'",
        "'posted'",
        "tan_tao_warehouse_documents",
        "tan_tao_warehouse_movements",
        "'receipt'",
        "on conflict (idempotency_key) do nothing",
    ):
        assert_true(token in receipt, f"production receipt path must use {token}")

    # Never rewrite an existing movement.
    assert_true(
        "update public.tan_tao_material_movements" not in lower,
        "migration must not update tan_tao_material_movements",
    )
    assert_true(
        "delete from public.tan_tao_material_movements" not in lower,
        "migration must not delete tan_tao_material_movements",
    )
    assert_true(
        "update public.tan_tao_warehouse_movements" not in lower,
        "migration must not update tan_tao_warehouse_movements",
    )
    assert_true(
        "delete from public.tan_tao_warehouse_movements" not in lower,
        "migration must not delete tan_tao_warehouse_movements",
    )

    # --- 5. mission_evaluate keeps every old branch -----------------------
    evaluate = body_after(lower, "function public.mission_evaluate(")
    for token in (
        "stock_alias_factor_fixed",
        "stock_duplicate_resolved",
        "stock_unknown_units_cleared",
        "material_links_done",
        "stock_count_questions_done",
        "q7_bom_mismatch_resolved",
        "tan_tao_recipe_done",
        "'kind', 'recipe'",
        "'code', v_recipe.code",
        "'open', coalesce(v_recipe_open, 0)",
        "'answered', coalesce(v_recipe_answered, 0)",
        "'not_used', coalesce(v_recipe_not_used, 0)",
        "'batch_set', coalesce(v_recipe.batch_output_kg, 0) > 0",
    ):
        assert_true(token in evaluate, f"mission_evaluate must keep {token}")

    # --- 6. seed recipe / batch question / pack lines ---------------------
    for token in (
        "'pate-heo'",
        "'Pate heo Tân Tạo'",
        "'Nạc heo'",
        "'Nạc đùi%'",
        "'Mỡ'",
        "'Chả lụa'",
        "'NVL-116'",
        "'Da bao'",
        "'NVL-117'",
        "'Muối diêm'",
        "'NVL-101'",
        "'Tiêu'",
        "'NVL-100'",
        "'Muối'",
        "'Đường'",
        "'Q7-1D46C75D6698EB2E9861'",
        "'Bột ngọt'",
        "'Q7-D13CB955CA74D3EAADAC'",
        "'Bột năng'",
        "'Bơ Peerless'",
        "'Q7-B917FD2CB8CAC14CBF22'",
        "'Hộp pate 500g'",
        "'PATE-500G'",
        "'NVL-099'",
        "'NVL-096'",
        "'Hộp pate 200g'",
        "'PATE-200G'",
        "'Hộp pate 200gr%'",
        "'NVL-095'",
        "on conflict (recipe_id, label) do nothing",
        "'wh-tan-tao-pate-recipe'",
        "'tan_tao_recipe_done'",
        "jsonb_build_object('code', 'pate-heo')",
        "on conflict (code) do nothing",
    ):
        assert_true(token in sql, f"seed must contain {token}")

    # No hard-coded owner UUID in either seed.
    uuid_re = re.compile(
        r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}"
    )
    seed_start = lower.index("$seed_tan_tao_pate_recipe$")
    seed_end = lower.index("$seed_tan_tao_pate_recipe$;", seed_start)
    assert_true(
        uuid_re.search(lower[seed_start:seed_end]) is None,
        "recipe seed must not hard-code a UUID",
    )

    # --- 7. rollback smoke -------------------------------------------------
    assert_true(SMOKE.exists(), f"missing smoke test {SMOKE.name}")
    smoke = read(SMOKE)
    smoke_lower = smoke.lower()
    assert_true(smoke.startswith("--"), "smoke must start with a comment header")
    assert_true("\nbegin;" in smoke, "smoke must open one transaction")
    assert_true("rollback;" in smoke_lower, "smoke must roll back")
    assert_true("commit;" not in smoke_lower, "smoke must not commit")
    assert_true("SMOKE_RESULT PASS" in smoke, "smoke must raise SMOKE_RESULT PASS")
    assert_true("SMOKE_RESULT FAIL" in smoke, "smoke must raise SMOKE_RESULT FAIL")
    for token in (
        "request.jwt.claims",
        "role::text = 'owner'",
        "answer_tan_tao_recipe_line",
        "set_tan_tao_recipe_batch",
        "record_tan_tao_pate_production",
        "before_cutover",
        "replay",
        "PATE-500G",
        "PATE-200G",
        "tan_tao_material_movements",
        "tan_tao_warehouse_movements",
    ):
        assert_true(token in smoke, f"smoke must cover {token}")

    print("PASS: tan tao pate recipe / production contracts hold")


if __name__ == "__main__":
    main()
