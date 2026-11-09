#!/usr/bin/env python3
"""Static contracts for Bếp BN employee shift starts + the punctual cutoff."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20261110150000_payroll_bn_employee_shifts.sql"
CONTACTS = ROOT / "supabase/migrations/20261009090000_payroll_bn_payslips.sql"
CONTACTS_EDITORS = ROOT / "supabase/migrations/20261009120000_payroll_bn_contacts_payroll_editors.sql"
SHARED = ROOT / "supabase/functions/_shared/payroll-missions.ts"
SHARED_TEST = ROOT / "supabase/functions/_shared/payroll-missions.test.ts"
DB_CLIENT = ROOT / "src/lib/payroll-bn/db-client.ts"
DB_TEST = ROOT / "src/lib/payroll-bn/db-client.test.ts"
TYPES = ROOT / "src/components/payroll/bep-bn/types.ts"
HOOK = ROOT / "src/hooks/useBepBnData.ts"
SMOKE = ROOT / "scripts/smoke_payroll_bn_employee_shifts.sql"

POLICY_OPS = ("select", "insert", "update", "delete")


def read(path: Path) -> str:
    assert path.exists(), f"Missing expected file: {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def sql() -> str:
    return read(MIGRATION).lower()


def assert_contains(text: str, needle: str, label: str) -> None:
    assert needle in text, f"Missing {label}: {needle!r}"


def policy_block(text: str, name: str) -> str:
    start = text.index(f"create policy {name}")
    end = text.index(";", start)
    return text[start:end]


def progress_function(text: str) -> str:
    start = text.index("create or replace function public.payroll_mission_progress")
    end = text.index("\n$$;", start)
    return text[start:end]


def test_shift_table_columns_and_updated_at_trigger() -> None:
    s = sql()
    for needle, label in [
        ("create table if not exists public.payroll_bn_employee_shifts", "shift table"),
        ("employee_code text primary key check (length(btrim(employee_code)) > 0)", "non-blank employee code"),
        ("shift_start time not null", "mandatory shift start"),
        ("updated_at timestamptz not null default now()", "updated timestamp"),
        (
            "updated_by uuid default auth.uid() references auth.users(id) on delete set null",
            "updated_by audit column",
        ),
        ("before update on public.payroll_bn_employee_shifts", "updated_at trigger timing"),
        ("execute function public.handle_updated_at()", "shared updated_at trigger function"),
        ("alter table public.payroll_bn_employee_shifts enable row level security", "RLS enabled"),
    ]:
        assert_contains(s, needle, label)


def test_policies_mirror_employee_contacts() -> None:
    s = sql()
    contacts = read(CONTACTS_EDITORS).lower()

    for op in POLICY_OPS:
        new_block = policy_block(s, f"payroll_bn_employee_shifts_{op}")
        old_block = policy_block(contacts, f"payroll_bn_employee_contacts_{op}")
        # The predicate after the policy name must be byte-identical: same
        # owner-or-payroll.edit authorization for every operation.
        assert new_block[new_block.index("\n"):] == old_block[old_block.index("\n"):], (
            f"{op} policy must mirror payroll_bn_employee_contacts"
        )
        assert f"for {op} to authenticated" in new_block, f"{op} must target authenticated"

    assert "service_role" not in "\n".join(
        policy_block(s, f"payroll_bn_employee_shifts_{op}") for op in POLICY_OPS
    ), "service_role must not be named as a policy target"

    # The original contacts table is still the source of this pattern.
    base = read(CONTACTS).lower()
    for op in POLICY_OPS:
        assert f"create policy payroll_bn_employee_contacts_{op}" in base, f"base {op} policy"


def test_shift_table_grants_keep_anon_out() -> None:
    s = sql()
    for needle, label in [
        (
            "revoke all on public.payroll_bn_employee_shifts from public, anon, authenticated;",
            "browser revoke",
        ),
        (
            "grant select, insert, update, delete on public.payroll_bn_employee_shifts to authenticated;",
            "authenticated grants",
        ),
        ("grant all on public.payroll_bn_employee_shifts to service_role;", "service_role grant"),
    ]:
        assert_contains(s, needle, label)
    assert "to anon" not in s, "anon must receive no grant"
    assert "grant select on public.payroll_bn_employee_shifts to anon" not in s


def test_progress_replacement_keeps_signature_and_grants() -> None:
    s = sql()
    body = progress_function(s)
    for needle, label in [
        ("create or replace function public.payroll_mission_progress(p_offer_id uuid)", "signature"),
        ("returns jsonb", "return type"),
        ("language plpgsql", "language"),
        ("stable", "volatility"),
        ("security definer", "security definer"),
        ("set search_path = public", "search_path"),
        ("from public.payroll_mission_offers", "offer lookup"),
        ("from public.payroll_mission_campaigns", "campaign lookup"),
        ("v_offer.status = 'accepted'", "accepted-date window"),
        ("greatest(", "window start"),
        ("least(v_campaign.ends_on, v_today)", "window end today"),
        ("e.decision = 'accepted'", "accepted events only"),
        ("e.event_kind = 'in'", "in events"),
        ("days_with_in", "in-day count"),
        ("days_complete", "complete-day count"),
        ("days_missing_out", "missing-out count"),
        ("on_time_days", "on-time count"),
        ("make_interval(mins => v_grace_minutes)", "grace minutes"),
        ("v_days_with_in >= v_min_days and v_days_missing_out = 0", "regular rule"),
        ("v_days_with_in >= 1 and v_on_time = v_days_with_in", "punctual rule"),
        ("'met', v_met", "met flag"),
        ("'cutoff', to_char(v_cutoff, 'hh24:mi')", "cutoff detail"),
    ]:
        assert_contains(body, needle, label)

    for needle, label in [
        (
            "revoke all on function public.payroll_mission_progress(uuid)\n"
            "  from public, anon, authenticated;",
            "function revoke",
        ),
        (
            "grant execute on function public.payroll_mission_progress(uuid)\n"
            "  to service_role;",
            "function grant",
        ),
    ]:
        assert_contains(s, needle, label)
    assert "grant execute on function public.payroll_mission_progress(uuid)\n  to authenticated;" not in s


def test_progress_cutoff_precedence() -> None:
    body = progress_function(sql())
    ordered = [
        body.index("if v_offer.shift_start is not null"),
        body.index("from public.payroll_bn_employee_shifts"),
        body.index("coalesce(v_params->>'cutoff'"),
        body.index("time '07:00'"),
    ]
    assert ordered == sorted(ordered), (
        "cutoff order must be offer.shift_start -> employee shift -> params.cutoff -> 07:00"
    )
    assert "s.employee_code = v_offer.employee_code" in body, "lookup by employee code"
    assert "select s.shift_start" in body and "into v_cutoff" in body, "employee shift read"
    assert "^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$" in body, "params cutoff validation"


def test_db_client_and_data_source_expose_shifts() -> None:
    client = read(DB_CLIENT)
    for needle, label in [
        ("export interface BepBnEmployeeShift", "shift type"),
        ("export interface BepBnEmployeeShiftInput", "shift input type"),
        ("export function normalizeShiftStart", "HH:MM validator"),
        ("/^([01][0-9]|2[0-3]):[0-5][0-9]$/", "strict HH:MM regex"),
        ("export async function listEmployeeShifts", "list function"),
        ("export async function upsertEmployeeShift", "upsert function"),
        ("export async function deleteEmployeeShift", "delete function"),
        ('from("payroll_bn_employee_shifts")', "shift table"),
        ('select("employee_code, shift_start")', "list columns"),
        ("shiftStart: String(row.shift_start ?? \"\").slice(0, 5)", "list maps to HH:MM"),
        ("{ employee_code: employeeCode, shift_start: shiftStart }", "upsert payload"),
        ('{ onConflict: "employee_code" }', "upsert conflict key"),
    ]:
        assert_contains(client, needle, label)

    types = read(TYPES)
    for needle, label in [
        ("BepBnEmployeeShift", "exported shift type"),
        ("shifts: BepBnEmployeeShift[]", "source shift array"),
        ("upsertShift: (input: { employeeCode: string; shiftStart: string }) => Promise<void>", "source upsert"),
        ("deleteShift: (employeeCode: string) => Promise<void>", "source delete"),
    ]:
        assert_contains(types, needle, label)

    hook = read(HOOK)
    for needle, label in [
        ("listEmployeeShifts", "hook lists shifts"),
        ("upsertEmployeeShift", "hook upserts shifts"),
        ("deleteEmployeeShift", "hook deletes shifts"),
        ("employee-shifts", "shift query key"),
        ("invalidateShifts", "shift cache invalidation"),
        ("shifts: shiftsQuery.data ?? []", "source array"),
        ("upsertShift: (input) => upsertShiftMutation.mutateAsync(input)", "source upsert wiring"),
        ("deleteShift: (employeeCode) => deleteShiftMutation.mutateAsync(employeeCode)", "source delete wiring"),
    ]:
        assert_contains(hook, needle, label)

    tests = read(DB_TEST)
    for needle, label in [
        ("listEmployeeShifts maps rows to HH:MM", "list test"),
        ("normalizeShiftStart accepts HH:MM", "validation test"),
        ('"7h"', "rejects 7h"),
        ('"25:00"', "rejects 25:00"),
        ("upsertEmployeeShift validates and upserts", "upsert test"),
        ("deleteEmployeeShift deletes the shift", "delete test"),
        ("{ employee_code: \"E01\", shift_start: \"08:00\" }", "upsert payload test"),
    ]:
        assert_contains(tests, needle, label)


def test_shared_pure_logic_uses_employee_shift() -> None:
    shared = read(SHARED)
    for needle, label in [
        ("employeeShiftStart?: string | null", "optional cutoff input"),
        ("const employeeCutoff = timeTextToMinutes(employeeShiftStart)", "employee cutoff parse"),
        ("offerCutoff ?? employeeCutoff ?? itemCutoff", "precedence in pure logic"),
        ("missionCutoff(item, offer, employeeShiftStart)", "progress passes employee shift"),
    ]:
        assert_contains(shared, needle, label)

    tests = read(SHARED_TEST)
    for needle, label in [
        ("punctual uses the employee shift between the offer override and item cutoff", "employee shift test"),
        ('"2026-11-04", "in", "07:45"', "late event fixture"),
        ("withShiftPunctual.detail.cutoff, \"08:00\"", "employee cutoff assertion"),
        ("withOfferPunctual.detail.cutoff, \"07:30\"", "offer override assertion"),
        ("withOfferPunctual.met, false", "offer wins assertion"),
    ]:
        assert_contains(tests, needle, label)


def test_rollback_smoke_covers_cutoff_precedence() -> None:
    smoke = read(SMOKE)
    lowered = smoke.lower()
    for needle, label in [
        ("begin;", "transaction"),
        ("do $$", "single DO block"),
        ("set_config('request.jwt.claims', '{\"role\":\"service_role\"}', true)", "service-role claims"),
        ("rollback;", "rollback-only"),
        ("insert into public.payroll_mission_campaigns", "campaign fixture"),
        ("'punctual'", "punctual item"),
        ("'cutoff', '07:00'", "item cutoff 07:00"),
        ("insert into public.payroll_mission_offers", "accepted offer fixture"),
        ("'accepted'", "accepted offer status"),
        ("'07:45'", "late check-in"),
        ("insert into public.payroll_bn_employee_shifts", "employee shift fixture"),
        ("time '08:00'", "employee shift 08:00"),
        ("time '07:30'", "offer override 07:30"),
        ("punctual_met_without_employee_shift", "without-shift assertion"),
        ("employee_shift_not_applied", "with-shift assertion"),
        ("offer_shift_start_not_applied", "offer-wins assertion"),
        ("public.payroll_mission_progress", "progress RPC call"),
    ]:
        assert_contains(lowered, needle, label)

    assert smoke.count("do $$") == 1, "smoke must be one DO block"
    assert "\\set" not in smoke and "\\gset" not in smoke, "smoke must be pure SQL"
    assert "commit;" not in lowered, "smoke must never commit"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS {name}")
