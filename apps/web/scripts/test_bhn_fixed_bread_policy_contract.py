from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "supabase/functions/_shared/daily-bread-order.ts"
WORKER = ROOT / "supabase/functions/dealer-warehouse-notify/index.ts"
REPORT_SAVE = ROOT / "supabase/functions/report-daily-save/index.ts"
MIGRATION = ROOT / "supabase/migrations/20260918093000_bhn_fixed_bread_inbound_policy.sql"
DYNAMIC_MIGRATION = ROOT / "supabase/migrations/20260927103000_bhn_dynamic_bread_order_policy.sql"


def read(path: Path) -> str:
    assert path.exists(), f"Missing expected file: {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def test_fixed_policy_is_data_driven_and_audited_in_service_only_sql() -> None:
    sql = read(MIGRATION)
    for marker in [
        "create table if not exists public.kiosk_bread_fixed_inbound_policies",
        "create table if not exists public.kiosk_bread_order_note_proposals",
        "create table if not exists public.kiosk_bread_order_note_proposal_audit_logs",
        "8b353493-c3cb-436e-80f7-a9a1d1a57cd3",
        "HCM004-BHN",
        "BMQ-001",
        "fixed-daily-inbound-bhn-bmq-001-v1",
        "effective_from_service_date",
        "2026-09-19",
        "effective_from_cutoff_date",
        "2026-09-18",
        "quantity numeric(12,3) not null check (quantity > 0)",
        "policy_snapshot jsonb not null default '{}'::jsonb",
        "proposal_status text not null default 'pending_operator_confirmation'",
        "requires_confirmation boolean not null default true",
        "auth.role() is distinct from 'service_role'",
        "grant execute on function public.get_active_kiosk_bread_fixed_inbound_policies",
        "grant execute on function public.upsert_kiosk_bread_order_note_proposal",
        "to service_role",
    ]:
        assert marker in sql
    assert "to anon" not in sql


def test_helper_policy_is_generic_and_default_seed_is_separate_from_formula() -> None:
    source = read(HELPER)
    for marker in [
        "FixedVehicleBreadInboundPolicy",
        "DEFAULT_FIXED_VEHICLE_BREAD_INBOUND_POLICIES",
        "fixed-daily-inbound-bhn-bmq-001-v1",
        "fixed_daily_inbound_policy",
        "fixedInboundPolicy",
        "resolveFixedVehicleBreadInboundPolicy",
        "fixedInboundPolicies: FixedVehicleBreadInboundPolicy[]",
    ]:
        assert marker in source
    formula_section = source.split("const selectSmartPateBatchQuantity", 1)[1].split("export function forecastVehicleBread", 1)[0]
    assert "HCM004-BHN" not in formula_section
    assert "8b353493-c3cb-436e-80f7-a9a1d1a57cd3" not in formula_section


def test_worker_reads_fixed_policies_once_and_uses_same_forecast_for_supplier_and_warehouse() -> None:
    source = read(WORKER)
    for marker in [
        'supabase.rpc("get_active_kiosk_bread_fixed_inbound_policies"',
        "fixedInboundPolicies",
        "forecastVehicleBread([...vehicleLocations.values()], orderDate, fixedInboundPolicies, dynamicOrderPolicies)",
        "fixed_policy_count",
        "readFixedInboundPolicies",
    ]:
        assert marker in source
    assert source.count("get_active_kiosk_bread_fixed_inbound_policies") == 1
    assert "enqueueDailyBreadOrder(supabase, now, fixedInboundPolicies, dynamicOrderPolicies)" in source
    assert "enqueueWarehouseKioskBreadDispatch(supabase, now, fixedInboundPolicies, dynamicOrderPolicies)" in source
    assert "fixedInboundPolicy: forecast.fixedInboundPolicy" in source
    assert '"fixed_daily_inbound_not_stock_subtracted"' in source


def test_report_save_extracts_note_proposal_but_does_not_override_policy_or_revenue() -> None:
    source = read(REPORT_SAVE)
    for marker in [
        "extractKioskBreadOrderNoteProposal",
        "save_kiosk_daily_report_with_bread_proposal_atomic",
        "pending_operator_confirmation",
        "notesForBreadOrderProposal",
        "report_notes",
        "inventory_banh_mi_que_notes",
        "channel_notes",
    ]:
        assert marker in source
    assert "received_quantity =" not in source
    assert "fixedInboundPolicy" not in source
    assert source.index("const noteCandidates") < source.index('supabase.rpc(\n      "save_kiosk_daily_report_with_bread_proposal_atomic"')


def test_atomic_report_wrapper_uses_exact_live_save_signature_and_reconciles_every_save() -> None:
    sql = read(MIGRATION)
    signature = "save_kiosk_daily_report_atomic(\n    p_location_id,\n    p_staff_id,\n    p_report_date,\n    p_status,\n    p_notes,\n    p_staff_name_snapshot,\n    p_staff_phone_normalized_snapshot,\n    p_location_code_snapshot,\n    p_location_name_snapshot,\n    p_location_address_snapshot,\n    p_inventory_rows,\n    p_channel_rows\n  )"
    assert "create or replace function public.save_kiosk_daily_report_with_bread_proposal_atomic" in sql
    assert signature in sql
    assert "proposal_status = 'pending_operator_confirmation'" in sql
    assert "proposal_status = 'superseded'" in sql
    assert "proposal_status = 'confirmed'" in sql
    assert "confirmed_proposal_conflict" in sql
    assert "not exists" in sql
    assert "revoke all on function public.save_kiosk_daily_report_with_bread_proposal_atomic" in sql
    assert "grant execute on function public.save_kiosk_daily_report_with_bread_proposal_atomic" in sql


def test_late_correction_reuses_matching_frozen_policy_snapshot_with_closure_precedence() -> None:
    sql = read(MIGRATION)
    function_sql = sql.split(
        "create or replace function public.queue_late_kiosk_bread_order_corrections", 1
    )[1]
    for marker in [
        "v_old_warehouse_location jsonb",
        "v_frozen_fixed_policy jsonb",
        "v_supplier_quantity_semantics text",
        "v_warehouse_quantity_semantics text",
        "fixed_policy_snapshot_mismatch",
        "fixed_policy_quantity_invalid",
        "when nullif(v_old_location->>'closureReason', '') is not null then 0",
        "when v_frozen_fixed_policy is not null then v_frozen_fixed_quantity",
        "'fixedInboundPolicy', v_frozen_fixed_policy",
        "'quantitySemantics', v_supplier_quantity_semantics",
    ]:
        assert marker in function_sql
    assert "kiosk_bread_fixed_inbound_policies" not in function_sql
    assert function_sql.count("'fixedInboundPolicy', v_frozen_fixed_policy") == 2
    assert function_sql.count("'quantitySemantics', v_supplier_quantity_semantics") == 2


def test_dynamic_bhn_policy_is_scoped_idempotent_and_service_role_only() -> None:
    sql = read(DYNAMIC_MIGRATION)
    for marker in [
        "create table if not exists public.kiosk_bread_dynamic_order_policies",
        "dynamic-daily-order-bhn-bmq-001-v1",
        "8b353493-c3cb-436e-80f7-a9a1d1a57cd3",
        "HCM004-BHN",
        "BMQ-001",
        "demand_multiplier numeric(8,4) not null check (demand_multiplier > 0)",
        "batch_size integer not null check (batch_size > 0)",
        "effective_from_cutoff_date",
        "2026-09-27",
        "effective_from_service_date",
        "2026-09-28",
        "unique (location_id, sku_code, effective_from_service_date)",
        "get_active_kiosk_bread_dynamic_order_policies",
        "partition by policy.location_id, policy.sku_code",
        "order by policy.effective_from_service_date desc, policy.created_at desc",
        "order by ranked.location_code, ranked.effective_from_service_date desc",
        "auth.role() is distinct from 'service_role'",
        "revoke all on function public.get_active_kiosk_bread_dynamic_order_policies(date) from anon",
        "grant execute on function public.get_active_kiosk_bread_dynamic_order_policies(date) to service_role",
    ]:
        assert marker in sql


def test_dynamic_bhn_prealert_outbox_contract_is_private_idempotent_and_warehouse_only() -> None:
    sql = read(DYNAMIC_MIGRATION)
    worker = read(WORKER)
    for marker in [
        "'bhn_bread_report_prealert'",
        "upsert_bhn_bread_report_prealert",
        "on conflict (digest_date, channel, notification_type)",
        "'BMQ - Kho Tân Tạo'",
        "status as of 23:30",
        "Ngày báo cáo: 2026-09-27",
        "Ngày giao kế tiếp: 2026-09-28",
        "grant execute on function public.upsert_bhn_bread_report_prealert(date, date, text, jsonb) to service_role",
    ]:
        assert marker in sql, f"missing prealert SQL marker: {marker}"
    assert "'BMQ - HKD Tuyết Anh'" not in sql.split("upsert_bhn_bread_report_prealert", 1)[1].split("create or replace function", 1)[0]
    for marker in [
        "isBhnBreadPrealertTime(now)",
        "enqueueBhnBreadReportPrealert(supabase, now, dynamicOrderPolicies)",
        'supabase.rpc("upsert_bhn_bread_report_prealert"',
        "bhn_bread_report_prealert",
    ]:
        assert marker in worker, f"missing prealert worker marker: {marker}"


def test_worker_reads_dynamic_policy_and_keeps_supplier_warehouse_quantity_semantics_aligned() -> None:
    source = read(WORKER)
    helper = read(HELPER)
    for marker in [
        'supabase.rpc("get_active_kiosk_bread_dynamic_order_policies"',
        "dynamicOrderPolicies",
        "forecastVehicleBread([...vehicleLocations.values()], orderDate, fixedInboundPolicies, dynamicOrderPolicies)",
        "dynamic_policy_count",
        '"bhn_exact_date_120pct_sold_minus_saleable_closing_round20"',
        "validCurrentVehicleReportIds",
    ]:
        assert marker in source, f"missing dynamic worker marker: {marker}"
    for marker in [
        "DynamicVehicleBreadOrderPolicy",
        "DEFAULT_DYNAMIC_VEHICLE_BREAD_ORDER_POLICIES",
        "dynamic-daily-order-bhn-bmq-001-v1",
        "dynamic_exact_report_round_up_to_batch",
        "dynamic_exact_report_missing",
        "dynamic_exact_bread_row_missing",
    ]:
        assert marker in helper, f"missing dynamic helper marker: {marker}"


def test_dynamic_bhn_correction_preserves_mam_non_supplier_demand_without_changing_other_corrections() -> None:
    sql = read(DYNAMIC_MIGRATION).split(
        "create or replace function public.queue_late_kiosk_bread_order_corrections", 1
    )[1]
    assert "v_mam_non_ordered" in sql
    assert "case when v_frozen_dynamic_policy is not null" in sql
    assert "#>> '{mam_non,ordered_quantity}'" in sql
    assert "v_dealer_ordered + v_new_vehicle + v_mam_non_ordered" in sql
    assert "'• Mầm non May: '" in sql


def test_dynamic_bhn_late_correction_replays_frozen_snapshots_and_owner_approval_path_only() -> None:
    sql = read(DYNAMIC_MIGRATION)
    function_sql = sql.split(
        "create or replace function public.queue_late_kiosk_bread_order_corrections", 1
    )[1]
    for marker in [
        "v_frozen_dynamic_policy jsonb",
        "v_warehouse_dynamic_policy jsonb",
        "policy_snapshot_mismatch",
        "dynamic_policy_snapshot_invalid",
        "v_dynamic_sold_quantity := coalesce(v_bread.sold_quantity, 0)",
        "v_dynamic_saleable_closing_quantity := coalesce(v_bread.closing_quantity, 0)",
        "v_dynamic_protected_demand := round(v_dynamic_sold_quantity * v_dynamic_multiplier, 3)",
        "v_dynamic_net_demand := greatest(0, v_dynamic_protected_demand - v_dynamic_saleable_closing_quantity)",
        "ceiling(v_dynamic_net_demand / v_dynamic_batch_size) * v_dynamic_batch_size",
        "'dynamicInboundPolicy', v_frozen_dynamic_policy",
        "'quantitySemantics', v_supplier_quantity_semantics",
        "'bhn_exact_date_120pct_sold_minus_saleable_closing_round20'",
        "'approval_status', 'pending_owner_review'",
        "'approved_by_owner', false",
        "'warehouse_totals'",
        "'supplier_totals'",
        "grant execute on function public.queue_late_kiosk_bread_order_corrections(uuid, uuid) to service_role",
    ]:
        assert marker in function_sql, f"missing dynamic correction marker: {marker}"
    assert "kiosk_bread_dynamic_order_policies" not in function_sql
    assert "set status = 'sent'" not in function_sql.lower()
    assert "update public.dealer_order_notifications" not in function_sql.lower()


def test_dynamic_vehicle_history_allows_missing_bread_row_for_bhn_only() -> None:
    sql = read(DYNAMIC_MIGRATION)
    function_sql = sql.split("create function public.get_daily_bread_vehicle_history", 1)[1].split(
        "revoke all on function public.get_daily_bread_vehicle_history", 1
    )[0]
    for marker in [
        "with active_locations as",
        "left join ranked",
        "inventory.report_id is not null",
        "location.location_code = 'HCM004-BHN'",
        "bread_row_present boolean",
    ]:
        assert marker in function_sql
