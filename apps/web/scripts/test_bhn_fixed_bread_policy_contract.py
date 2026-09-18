from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / "supabase/functions/_shared/daily-bread-order.ts"
WORKER = ROOT / "supabase/functions/dealer-warehouse-notify/index.ts"
REPORT_SAVE = ROOT / "supabase/functions/report-daily-save/index.ts"
MIGRATION = ROOT / "supabase/migrations/20260918093000_bhn_fixed_bread_inbound_policy.sql"


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
        "forecastVehicleBread([...vehicleLocations.values()], orderDate, fixedInboundPolicies)",
        "fixed_policy_count",
        "readFixedInboundPolicies",
    ]:
        assert marker in source
    assert source.count("get_active_kiosk_bread_fixed_inbound_policies") == 1
    assert "enqueueDailyBreadOrder(supabase, now, fixedInboundPolicies)" in source
    assert "enqueueWarehouseKioskBreadDispatch(supabase, now, fixedInboundPolicies)" in source
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
