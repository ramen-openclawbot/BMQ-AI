#!/usr/bin/env python3
"""Contract tests for KFM daily print-only material issue SQL.

These tests are intentionally executable with only the Python stdlib.  If a
local disposable PostgreSQL is configured through KFM_SQL_TEST_DATABASE_URL, the
script can be extended to rehearse the migration there; the CI-safe contract
checks below are the required minimum for this local DB slice.
"""

from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
MIGRATION = ROOT / "apps/web/supabase/migrations/20260816143000_kfm_daily_material_issue_print.sql"


def read_sql() -> str:
    raw = MIGRATION.read_text(encoding="utf-8")
    return re.sub(r"--.*", "", raw)


def compact(sql: str) -> str:
    return re.sub(r"\s+", " ", sql.lower()).strip()


def test_migration_creates_purpose_built_print_only_tables_and_no_ledger_writes() -> None:
    sql = read_sql()
    lower = compact(sql)

    for table in (
        "kfm_daily_material_issues",
        "kfm_daily_material_issue_sources",
        "kfm_daily_material_issue_items",
    ):
        assert f"create table if not exists public.{table}" in lower
        assert f"alter table public.{table} enable row level security" in lower
        assert f"grant select on public.{table} to authenticated" in lower
        assert f"grant insert" not in re.sub(
            rf"grant select on public\.{table} to authenticated", "", lower
        ), "authenticated users must not get direct write grants"

    assert "status text not null" in lower
    assert "check (status in ('generated', 'printed', 'superseded'))" in lower
    assert "unique (issue_date, revision)" in lower
    assert "where status <> 'superseded'" in lower, "one current non-superseded slip per date"
    assert "unique (issue_id, production_order_id)" in lower
    assert "canonical_material_id uuid references public.sku_cogs_materials(id)" in lower
    assert "kitchen_inventory_movements" not in lower
    assert "production_material_issue_items" not in lower


def test_rpc_acl_and_rls_are_fail_closed() -> None:
    sql = read_sql()
    lower = compact(sql)

    for fn in (
        "public.upsert_kfm_daily_material_issue(date)",
        "public.mark_kfm_daily_material_issue_printed(uuid)",
    ):
        assert f"revoke all on function {fn} from public" in lower
        assert f"revoke all on function {fn} from anon" in lower
        assert f"revoke all on function {fn} from authenticated" in lower
        assert f"grant execute on function {fn} to authenticated, service_role" in lower

    assert "security definer" in lower
    assert "set search_path = public, pg_temp" in lower
    assert "coalesce(auth.role(), '') = 'service_role'" in lower
    assert "public.has_role(v_actor_id, 'owner'" in lower
    assert "public.has_module_permission(v_actor_id, 'production_q7', 'edit')" in lower
    assert "public.has_module_permission(v_actor_id, 'production', 'edit')" in lower
    assert "for insert to authenticated" not in lower
    assert "for update to authenticated" not in lower
    assert "for delete to authenticated" not in lower


def test_upsert_sources_kfm_orders_by_vn_issue_date_and_authoritative_statuses() -> None:
    lower = compact(read_sql())

    assert "p_issue_date date default ((now() at time zone 'asia/ho_chi_minh')::date)" in lower
    assert "pg_advisory_xact_lock" in lower and "kfm_daily_material_issue" in lower
    assert "production_orders po" in lower
    assert "customer_po_inbox cpi" in lower
    assert "po.status in ('draft', 'planned', 'in_progress')" in lower
    assert "coalesce(po.planned_start_date, poi.delivery_date, cpi.delivery_date) = p_issue_date" in lower
    assert "lower(coalesce(cpi.from_email, '') || ' ' || coalesce(cpi.email_subject, '') || ' ' || coalesce(cpi.from_name, ''))" in lower
    assert "like '%kingfood%'" in lower
    assert "like '%kingfoodmart%'" in lower
    assert "~ '(^|[^a-z0-9])kfm([^a-z0-9]|$)'" in lower
    assert "like '%kfm%'" not in lower, "bare substring KFM matching accepts notkfmvendor/prefixkfm"


def test_upsert_uses_canonical_historical_cogs_versions_for_issue_date() -> None:
    lower = compact(read_sql())

    assert "public.sku_cogs_versions" in lower
    assert "public.sku_cogs_version_formulations" in lower
    assert "latest_version.id" in lower
    assert "latest_version.version_no" in lower
    assert "v.effective_from <= p_issue_date" in lower
    assert "v.effective_to is null or p_issue_date <= v.effective_to" in lower
    assert "order by v.effective_from desc, v.version_no desc, v.id::text desc" in lower
    assert "latest_version.product_snapshot" in lower
    assert "finished_output_qty" in lower
    assert "product_snapshot ->> 'finished_output_qty'" in lower
    assert "join public.sku_cogs_version_formulations" in lower
    assert "join public.sku_formulations" not in lower, "daily issue must not fall back to current sku_formulations"
    assert "f.effective_from" not in lower, "formulation rows must be selected by canonical version_id, not current effective_from"


def test_upsert_blocks_before_writes_for_sku_qty_bom_identity_unit_and_output_errors() -> None:
    lower = compact(read_sql())

    required_blockers = [
        "blocked_missing_sources",
        "blocked_missing_finished_skus",
        "blocked_ambiguous_finished_skus",
        "blocked_nonpositive_quantities",
        "blocked_missing_formulations",
        "blocked_invalid_formulations",
        "blocked_missing_material_identity",
        "blocked_missing_units",
        "blocked_nonpositive_required_qty",
    ]
    for marker in required_blockers:
        assert marker in lower

    assert "coalesce(nullif(poi.actual_qty, 0), nullif(poi.planned_qty, 0), nullif(poi.ordered_qty, 0))" in lower
    assert "poi.actual_qty > 0" in lower and "poi.planned_qty > 0" in lower and "poi.ordered_qty > 0" in lower
    assert "case when count(*) = 1 then" in lower, "legacy normalized exact-name SKU fallback must require exactly one match"
    assert "lower(coalesce(ps2.sku_type::text, '')) = 'finished_good'" in lower, (
        "product_skus.sku_type is an enum in live DB; exact-match fallback must cast to text before coalesce/lower"
    )
    assert "lower(coalesce(ps2.sku_type, ''))" not in lower, "unsafe enum/text coalesce must not be used"
    aggregate_blocker_inserts = re.findall(
        r"insert into blockers\(status, details\)\s+select\s+'[^']+',\s+jsonb_agg\(.*?;",
        lower,
        flags=re.S,
    )
    assert aggregate_blocker_inserts, "expected aggregate blocker inserts to be contract-checked"
    for insert_sql in aggregate_blocker_inserts:
        assert "having count(*) > 0" in insert_sql, "empty aggregate blocker inserts must not violate details not-null"

    assert "finished_output_qty > 0" in lower
    assert "/ ol.selected_finished_output_qty" in lower or "/ selected_finished_output_qty" in lower
    assert "dosage_qty > 0" in lower
    assert "not exists (select 1 from blockers)" in lower, "writes must be guarded behind all validations"


def test_upsert_aggregates_leaf_materials_and_computes_deterministic_revision_hash() -> None:
    lower = compact(read_sql())

    assert "create temp table if not exists leaf_formulations" in lower
    assert "child.version_id = f.version_id" in lower
    assert "join leaf_formulations f" in lower
    assert "from leaf_formulations f" in lower
    assert "position(ol.selected_parent_name || ' > ' in f.ingredient_name) = 1" in lower
    assert "replace(f.ingredient_name, ol.selected_parent_name || ' > ', '')" in lower
    assert "group by canonical_material_id" in lower
    assert "coalesce(nullif(material_code, ''), canonical_material_id::text" in lower
    assert "normalized_unit" in lower
    assert "md5(string_agg" in lower
    assert "order by snapshot_key" in lower
    assert "current_issue.status = 'generated'" in lower
    assert "delete from public.kfm_daily_material_issue_items" in lower
    assert "current_issue.status = 'printed' and current_issue.source_hash = v_source_hash" in lower
    assert "set status = 'superseded'" in lower
    assert "v_next_revision := current_issue.revision + 1" in lower
    assert "pxk-nvl-kfm-" in lower


def test_leaf_validation_blocks_invalid_leaf_rows_but_not_structural_parents() -> None:
    lower = compact(read_sql())

    assert "insert into leaf_formulations" in lower
    assert "not exists ( select 1 from public.sku_cogs_version_formulations child where child.version_id = f.version_id" in lower
    invalid_sections = re.findall(
        r"insert into blockers\(status, details\)\s+select\s+'blocked_[^']+',\s+jsonb_agg\(.*?;",
        lower,
        flags=re.S,
    )
    invalid_sql = " ".join(section for section in invalid_sections if "formulation" in section or "material" in section or "unit" in section or "required_qty" in section)
    assert "leaf_formulations" in invalid_sql
    assert "join public.sku_cogs_version_formulations f" not in invalid_sql, "validation must not scan structural parent rows"


NONFINITE_NUMERIC_TEXTS = "('nan', 'infinity', '-infinity')"


def test_formulation_numeric_validation_is_fail_closed_for_wastage_and_quantities() -> None:
    lower = compact(read_sql())

    assert "f.wastage_percent >= 0" in lower
    assert f"f.wastage_percent::text not in {NONFINITE_NUMERIC_TEXTS}" in lower
    assert "f.dosage_qty > 0" in lower
    assert f"f.dosage_qty::text not in {NONFINITE_NUMERIC_TEXTS}" in lower
    assert f"selected_finished_output_qty::text not in {NONFINITE_NUMERIC_TEXTS}" in lower
    assert "coalesce(f.wastage_percent, 0)" not in lower, "invalid negative/NaN wastage must not be silently treated as zero"


def test_nonfinite_numeric_filters_and_blockers_are_exact_complements() -> None:
    lower = compact(read_sql())

    assert f"ol.selected_finished_output_qty::text not in {NONFINITE_NUMERIC_TEXTS}" in lower
    assert f"f.dosage_qty::text not in {NONFINITE_NUMERIC_TEXTS}" in lower
    assert f"f.wastage_percent::text not in {NONFINITE_NUMERIC_TEXTS}" in lower

    assert f"ol.selected_finished_output_qty::text in {NONFINITE_NUMERIC_TEXTS}" in lower
    assert f"f.dosage_qty::text in {NONFINITE_NUMERIC_TEXTS}" in lower
    assert f"f.wastage_percent::text in {NONFINITE_NUMERIC_TEXTS}" in lower

    calc_rows_section = re.search(r"insert into calc_rows\(.*?;", lower, flags=re.S)
    assert calc_rows_section, "expected calc_rows insert to be present"
    calc_rows_sql = calc_rows_section.group(0)
    for safe_predicate in (
        f"ol.selected_finished_output_qty::text not in {NONFINITE_NUMERIC_TEXTS}",
        f"f.dosage_qty::text not in {NONFINITE_NUMERIC_TEXTS}",
        f"f.wastage_percent::text not in {NONFINITE_NUMERIC_TEXTS}",
    ):
        assert safe_predicate in calc_rows_sql, "nonfinite numerics must not enter calculations"

    blocker_sections = re.findall(
        r"insert into blockers\(status, details\)\s+select\s+'blocked_invalid_formulations'.*?having count\(\*\) > 0;",
        lower,
        flags=re.S,
    )
    assert blocker_sections, "expected invalid formulation blockers"
    blocker_sql = " ".join(blocker_sections)
    for unsafe_predicate in (
        f"ol.selected_finished_output_qty::text in {NONFINITE_NUMERIC_TEXTS}",
        f"f.dosage_qty::text in {NONFINITE_NUMERIC_TEXTS}",
        f"f.wastage_percent::text in {NONFINITE_NUMERIC_TEXTS}",
    ):
        assert unsafe_predicate in blocker_sql, "nonfinite numerics must generate blocked_invalid_formulations"


def test_mark_printed_is_idempotent_and_generated_only() -> None:
    lower = compact(read_sql())

    assert "create or replace function public.mark_kfm_daily_material_issue_printed" in lower
    assert "for update" in lower
    assert "if target_issue.status = 'printed' then" in lower
    assert "target_issue.status <> 'generated'" in lower
    assert "blocked_invalid_status" in lower
    assert "printed_at = coalesce(printed_at, now())" in lower
    assert "printed_by = coalesce(printed_by, v_actor_id)" in lower


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
