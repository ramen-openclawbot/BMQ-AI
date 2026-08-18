#!/usr/bin/env python3
"""Task10 audited per-source enforcement-mode controller contracts.

Strict TDD RED contracts for the additive SQL-only controller and rollback-only
linked smoke. These tests inspect executable SQL, not comments.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20260818160000_task10_material_master_enforcement_mode_controller.sql"
SMOKE = ROOT / "scripts/material_master/enforcement_rollout_rollback_smoke.sql"
PROTECTED = (
    "sku_cogs_materials",
    "sku_cogs_material_aliases",
    "material_scoped_aliases",
    "material_resolution_requests",
    "sku_formulations",
    "sku_cogs_versions",
    "sku_cogs_version_formulations",
    "kitchen_inventory_items",
    "q7_material_issue_material_mappings",
    "q7_inventory_movements",
    "q7_inventory_openings",
    "q7_inventory_opening_audit_logs",
    "kitchen_inventory_movements",
)
ALLOWED_SOURCES = (
    "sku_cogs",
    "scan_sku_cost_sheet",
    "purchase_order",
    "goods_receipt",
    "payment_request",
    "invoice",
    "create_invoice_from_pr",
    "match_delivery_note",
    "kitchen_inventory",
)


def read(path: Path) -> str:
    assert path.exists(), f"Missing required Task10 file: {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def uncommented(text: str) -> str:
    text = re.sub(r"/\*[\s\S]*?\*/", "", text)
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("--"))


def function_body(sql: str, name: str) -> str:
    low = uncommented(sql).lower()
    m = re.search(
        rf"create\s+or\s+replace\s+function\s+public\.{re.escape(name)}\s*\([\s\S]*?\)[\s\S]*?as\s+(\$[a-z_][a-z_0-9]*\$|\$\$)(?P<body>[\s\S]*?)\1\s*;",
        low,
    )
    assert m, f"Missing function body for {name}"
    return m.group("body")


def assert_no_protected_dml(sql: str) -> None:
    body = uncommented(sql).lower()
    for table in PROTECTED:
        ref = rf"(?:public\.)?{re.escape(table)}"
        for pat in (
            rf"\binsert\s+into\s+{ref}\b",
            rf"\bupdate\s+{ref}\b",
            rf"\bdelete\s+from\s+{ref}\b",
            rf"\btruncate\s+(?:table\s+)?{ref}\b",
        ):
            assert not re.search(pat, body), f"Task10 migration must not write protected table {table}"


def test_task10_migration_adds_only_audited_enforcement_mode_rpc_no_seed_or_history_dml():
    sql = read(MIGRATION)
    low = uncommented(sql).lower()
    assert_no_protected_dml(sql)
    assert re.search(r"create\s+or\s+replace\s+function\s+public\.set_material_master_enforcement_mode\s*\([\s\S]*?p_source_type\s+text[\s\S]*?p_expected_mode\s+text[\s\S]*?p_new_mode\s+text[\s\S]*?p_reason\s+text[\s\S]*?p_readiness_snapshot\s+jsonb", low)
    assert "security definer" in low
    assert "set search_path = public, pg_temp" in low
    assert "grant execute on function public.set_material_master_enforcement_mode(text, text, text, text, jsonb) to authenticated" in low
    assert re.search(r"revoke\s+all\s+on\s+function\s+public\.set_material_master_enforcement_mode\(text, text, text, text, jsonb\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated\s*,\s*service_role", low)
    assert not re.search(r"grant\s+execute\s+on\s+function\s+public\.set_material_master_enforcement_mode\([^)]*\)\s+to[^;]*service_role", low)
    assert "insert into public.material_master_enforcement_config" not in low
    assert "on conflict (source_type) do update" not in low
    assert "update public.material_master_enforcement_config" in low


def test_task10_rpc_enforces_auth_edit_permission_sources_expected_mode_transitions_and_snapshot_gate():
    body = function_body(read(MIGRATION), "set_material_master_enforcement_mode")
    for source in ALLOWED_SOURCES:
        assert f"'{source}'" in body, f"missing canonical allowlist source {source}"
    assert "'q7'" not in re.sub(r"raise exception[^;]+;", "", body), "q7 must not be a canonical source; use kitchen_inventory"
    assert "source type is not allowed" in body
    assert "v_actor uuid := auth.uid()" in body
    assert "v_actor is null" in body
    assert "material_master_jwt_role() = 'service_role'" in body
    assert "has_role(v_actor, 'owner')" in body and "has_module_permission(v_actor, 'material_master', 'edit')" in body
    assert "reason required" in body
    assert "for update" in body, "source config row must be locked FOR UPDATE"
    assert "pg_catalog.pg_advisory_xact_lock" in body and "material_master_enforcement_mode:" in body
    assert "v_old_mode is distinct from v_expected_mode" in body
    for transition in (
        "v_old_mode = 'shadow' and v_new_mode = 'enforced'",
        "v_old_mode = 'enforced' and v_new_mode = 'shadow'",
        "v_old_mode = 'disabled' and v_new_mode = 'shadow'",
        "v_old_mode in ('shadow','enforced') and v_new_mode = 'disabled'",
    ):
        assert transition in body
    assert "unsupported enforcement mode transition" in body
    assert "get_material_master_rollout_dashboard()" in body
    assert "ready_for_enforcement is not true" in body
    assert "queue_pending_count <> 0" in body
    assert "jsonb_array_length(coalesce(v_dashboard.blockers" in body
    assert "caller rollout snapshot is stale" in body
    assert "queue_blocked_count <> 0" in body
    assert "fixed exact-approved controller mode cannot be changed" in body
    assert "v_source_type in ('sku_cogs','scan_sku_cost_sheet','kitchen_inventory')" in body
    assert "reason_code" in body and "emergency_disable" in body
    assert "source_type" in body and "mode" in body and "ready_for_enforcement" in body


def test_task10_rpc_audits_actual_server_snapshot_with_safe_allowlist_and_returns_safe_payload():
    body = function_body(read(MIGRATION), "set_material_master_enforcement_mode")
    assert "material_master_safe_payload" in body
    for key in ("source_type", "mode", "ready_for_enforcement", "queue_pending_count", "blockers", "reason_code", "requested_by"):
        assert f"'{key}'" in body
    assert "raw_payload" not in body and "service_role_key" not in body
    assert "material_master_audit_append" in body
    assert "set_material_master_enforcement_mode" in body
    assert "v_server_snapshot" in body
    assert "v_old_snapshot" in body and "v_new_snapshot" in body
    assert "jsonb_build_object('source_type', v_source_type, 'mode', v_old_mode" in body
    assert "jsonb_build_object('source_type', v_source_type, 'mode', v_new_mode" in body
    assert "updated_by = v_actor" in body and "updated_at = now()" in body
    assert "return jsonb_build_object" in body


def test_task10_rollback_smoke_is_linked_executable_rollback_only_and_covers_runtime_matrix():
    smoke = read(SMOKE)
    exec_sql = uncommented(smoke).lower()
    migration = read(MIGRATION).lower()
    for marker in (
        "begin;",
        "rollback;",
        "task10_enforcement_rollout_rollback_smoke",
        "synthetic readiness fixtures",
        "blocked_shadow_to_enforced",
        "passing_shadow_to_enforced",
        "stale_snapshot_rejected",
        "rollback_enforced_to_shadow",
        "emergency_disable_from_shadow",
        "unknown_source_rejected",
        "q7_source_rejected",
        "unauthorized_user_rejected",
        "service_role_actor_spoof_rejected",
        "audit_snapshot_safe_payload",
        "protected_table_counts_unchanged",
        "post_rollback_zero_residue",
    ):
        assert marker in exec_sql, f"missing executable smoke marker {marker}"
    assert "set_material_master_enforcement_mode(" in exec_sql
    assert "get_material_master_rollout_dashboard()" in exec_sql
    assert "insert into public.material_resolution_requests" in exec_sql
    assert "insert into public.kitchen_inventory_items" in exec_sql
    assert "insert into public.q7_material_issue_material_mappings" in exec_sql
    assert "'q7'" in exec_sql and "'unknown'" in exec_sql
    assert "raise exception 'protected table counts changed" in exec_sql
    assert "select 'post_rollback_zero_residue'" in exec_sql
    assert "create or replace function public.set_material_master_enforcement_mode" in exec_sql
    assert migration.strip() in smoke.lower(), "rollback smoke must embed the reviewed Task10 migration SQL"


if __name__ == "__main__":
    raise SystemExit("Run with pytest")
