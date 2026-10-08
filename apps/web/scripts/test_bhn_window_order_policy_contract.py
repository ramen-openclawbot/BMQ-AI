"""Contract test for the BHN BMQ-001 window mean + 1.5*std order policy.

Asserts the migration schema, the v2 policy row, the service-role-only policy
RPC, the late-correction function window handling, and the helper/worker wiring.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20261010120000_bhn_window_mean_std_order_policy.sql"
HELPER = ROOT / "supabase/functions/_shared/daily-bread-order.ts"
WORKER = ROOT / "supabase/functions/dealer-warehouse-notify/index.ts"

WINDOW_SEMANTICS = "bhn_window7_mean_plus_1p5_std_minus_saleable_closing_round20"


def read(path: Path) -> str:
    assert path.exists(), f"Missing expected file: {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def normalize(text: str) -> str:
    return re.sub(r"\s+", " ", text)


def correction_sql() -> str:
    sql = read(MIGRATION)
    assert "create or replace function public.queue_late_kiosk_bread_order_corrections" in sql
    return normalize(sql.split(
        "create or replace function public.queue_late_kiosk_bread_order_corrections", 1
    )[1])


def policy_reader_sql() -> str:
    sql = read(MIGRATION)
    assert "create function public.get_active_kiosk_bread_dynamic_order_policies" in sql
    return normalize(sql.split(
        "create function public.get_active_kiosk_bread_dynamic_order_policies", 1
    )[1].split("revoke all on function public.get_active_kiosk_bread_dynamic_order_policies", 1)[0])


def test_migration_adds_window_policy_columns_and_checks() -> None:
    sql = normalize(read(MIGRATION))
    for marker in [
        "add column if not exists formula_method text not null default 'exact_day_multiplier'",
        "check (formula_method in ('exact_day_multiplier', 'window_mean_plus_k_std'))",
        "add column if not exists window_size integer not null default 7",
        "check (window_size > 0)",
        "add column if not exists std_multiplier numeric(8,4) not null default 0",
        "check (std_multiplier >= 0)",
        "add column if not exists min_reports integer not null default 3",
        "check (min_reports > 0)",
    ]:
        assert marker in sql, f"missing column/check marker: {marker}"


def test_migration_inserts_v2_window_row_and_keeps_v1() -> None:
    sql = normalize(read(MIGRATION))
    for marker in [
        "'dynamic-daily-order-bhn-bmq-001-v2', '8b353493-c3cb-436e-80f7-a9a1d1a57cd3', "
        "'HCM004-BHN', 'BMQ-001', 'window_mean_plus_k_std', 7, 1.5, 3, 1.2, 20, "
        "date '2026-10-09', date '2026-10-10', true",
        "'policy_type', 'dynamic_window_mean_std'",
        "'formula_method', 'window_mean_plus_k_std'",
        "'window_size', 7",
        "'std_multiplier', 1.5",
        "'min_reports', 3",
        "'fallback_formula', 'ceil_to_batch(max(0, demand_multiplier * sold_quantity - saleable_closing_quantity))'",
        "'exact_cutoff_report_required', true",
        "'bread_inventory_row_required', true",
        "Bùi Hữu Nghĩa đặt bánh theo trung bình 7 ngày + 1,5 dao động",
    ]:
        assert marker in sql, f"missing v2 row marker: {marker}"
    assert "dynamic-daily-order-bhn-bmq-001-v1" not in sql
    assert "on conflict (location_id, sku_code, effective_from_service_date) do update" in sql


def test_policy_reader_rpc_returns_new_columns_and_stays_service_role_only() -> None:
    sql = normalize(read(MIGRATION))
    rpc = policy_reader_sql()
    assert "drop function if exists public.get_active_kiosk_bread_dynamic_order_policies(date);" in sql
    for marker in [
        "formula_method text, window_size integer, std_multiplier numeric, min_reports integer",
        "policy.formula_method, policy.window_size, policy.std_multiplier, policy.min_reports",
        "ranked.formula_method, ranked.window_size, ranked.std_multiplier, ranked.min_reports",
        "auth.role() is distinct from 'service_role'",
    ]:
        assert marker in rpc, f"missing policy reader marker: {marker}"
    assert "grant execute on function public.get_active_kiosk_bread_dynamic_order_policies(date) to service_role" in sql
    for role in ("public", "anon", "authenticated"):
        assert (
            "revoke all on function public.get_active_kiosk_bread_dynamic_order_policies(date) "
            f"from {role}" in sql
        )
    assert "grant execute on function public.get_active_kiosk_bread_dynamic_order_policies(date) to anon" not in sql
    assert "grant execute on function public.get_active_kiosk_bread_dynamic_order_policies(date) to authenticated" not in sql


def test_late_correction_recomputes_window_snapshot_with_fallback() -> None:
    function_sql = correction_sql()
    for marker in [
        "v_dynamic_formula_method text",
        "v_dynamic_window_size numeric",
        "v_dynamic_std_multiplier numeric",
        "v_dynamic_min_reports integer",
        "v_dynamic_window_count integer := 0",
        "v_dynamic_window_mean numeric",
        "v_dynamic_window_std numeric",
        "coalesce( nullif(v_frozen_dynamic_policy->>'formulaMethod', ''), 'exact_day_multiplier' )",
        "coalesce((v_frozen_dynamic_policy->>'windowSize')::numeric, 7)",
        "coalesce((v_frozen_dynamic_policy->>'stdMultiplier')::numeric, 0)",
        "coalesce((v_frozen_dynamic_policy->>'minReports')::integer, 3)",
        "v_dynamic_formula_method not in ('exact_day_multiplier', 'window_mean_plus_k_std')",
        f"'{WINDOW_SEMANTICS}'",
        "count(*) filter (where report_rank <= v_dynamic_window_size)",
        "avg(sold_quantity) filter (where report_rank <= v_dynamic_window_size)",
        "stddev_pop(sold_quantity) filter (where report_rank <= v_dynamic_window_size)",
        "v_dynamic_formula_method = 'window_mean_plus_k_std' and v_dynamic_window_count >= v_dynamic_min_reports",
        "coalesce(v_dynamic_window_mean, 0) + v_dynamic_std_multiplier * coalesce(v_dynamic_window_std, 0)",
        "v_dynamic_protected_demand := round(v_dynamic_sold_quantity * v_dynamic_multiplier, 3)",
        "'dynamic_window_mean_std_round_up_to_batch'",
        "'windowMean', round(coalesce(v_dynamic_window_mean, 0), 3)",
        "'windowStd', round(coalesce(v_dynamic_window_std, 0), 3)",
        "'windowReportCount', v_dynamic_window_count",
        "'bhn_exact_date_120pct_sold_minus_saleable_closing_round20'",
        "grant execute on function public.queue_late_kiosk_bread_order_corrections(uuid, uuid) to service_role",
    ]:
        assert marker in function_sql, f"missing window correction marker: {marker}"
    # The correction must replay the frozen snapshot, never discover the live policy row.
    assert "kiosk_bread_dynamic_order_policies" not in function_sql


def test_helper_and_worker_consume_window_policy() -> None:
    helper = read(HELPER)
    for marker in [
        "DynamicVehicleBreadOrderPolicy",
        "formulaMethod",
        "windowSize",
        "stdMultiplier",
        "minReports",
        "window_mean_plus_k_std",
        "dynamic-daily-order-bhn-bmq-001-v2",
        '"2026-10-10"',
        '"2026-10-09"',
        "windowMean",
        "windowStd",
        "windowReportCount",
        "dynamic_window_insufficient_reports",
        "dynamic_window_mean_std_round_up_to_batch",
    ]:
        assert marker in helper, f"missing helper window marker: {marker}"

    worker = read(WORKER)
    for marker in [
        "formula_method",
        "window_size",
        "std_multiplier",
        "min_reports",
        f'"{WINDOW_SEMANTICS}"',
        "dynamic_window_policy",
    ]:
        assert marker in worker, f"missing worker window marker: {marker}"


if __name__ == "__main__":
    test_migration_adds_window_policy_columns_and_checks()
    test_migration_inserts_v2_window_row_and_keeps_v1()
    test_policy_reader_rpc_returns_new_columns_and_stays_service_role_only()
    test_late_correction_recomputes_window_snapshot_with_fallback()
    test_helper_and_worker_consume_window_policy()
    print("test_bhn_window_order_policy_contract: OK")
