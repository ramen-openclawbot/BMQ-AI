#!/usr/bin/env python3
"""Static contracts for monthly missions + surprise gifts (payroll_bn)."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20261110090000_payroll_missions.sql"
SHARED = ROOT / "supabase/functions/_shared/payroll-missions.ts"
SHARED_TEST = ROOT / "supabase/functions/_shared/payroll-missions.test.ts"
CORS = ROOT / "supabase/functions/_shared/cors.ts"
CONFIG = ROOT / "supabase/config.toml"
EDGE = ROOT / "supabase/functions/payslip-mission/index.ts"
TYPES = ROOT / "src/lib/payslip-portal/types.ts"
API = ROOT / "src/lib/payslip-portal/mission-api.ts"
API_TEST = ROOT / "src/lib/payslip-portal/mission-api.test.ts"
HOOK = ROOT / "src/hooks/usePayrollMissionsAdmin.ts"
DB_CLIENT = ROOT / "src/lib/payroll-bn/db-client.ts"
DB_TEST = ROOT / "src/lib/payroll-bn/db-client.test.ts"
SMOKE = ROOT / "scripts/smoke_payroll_missions.sql"

TABLES = [
    "payroll_mission_campaigns",
    "payroll_mission_offers",
    "payroll_mission_reviews",
    "payroll_mission_draw_tickets",
    "payroll_mission_events",
]

RPC_SIGNATURES = [
    "upsert_payroll_mission_campaign(jsonb)",
    "set_payroll_mission_campaign_status(uuid, text)",
    "set_payroll_mission_gift(uuid, text, boolean, time)",
    "set_payroll_mission_gift_bulk(uuid, text[], boolean)",
    "list_payroll_missions(uuid)",
    "review_payroll_mission_offer(uuid, text[], boolean, text)",
    "payroll_mission_progress(uuid)",
    "list_payroll_mission_bonus_for_period(uuid)",
]


def read(path: Path) -> str:
    assert path.exists(), f"Missing expected file: {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def sql() -> str:
    return read(MIGRATION).lower()


def assert_contains(text: str, needle: str, label: str) -> None:
    assert needle in text, f"Missing {label}: {needle!r}"


def function_body(text: str, name: str) -> str:
    start = text.index(f"create or replace function public.{name}")
    end = text.index("$sql$;", start) if "$sql$;" in text[start:] else text.index("$$;", start)
    return text[start:end]


def test_tables_columns_and_constraints() -> None:
    s = sql()
    for table in TABLES:
        assert_contains(s, f"create table if not exists public.{table}", f"{table} table")
        assert_contains(s, f"alter table public.{table} enable row level security", f"{table} RLS")
        assert_contains(
            s,
            f"revoke all on table public.{table} from public, anon, authenticated",
            f"{table} browser revoke",
        )
        assert_contains(
            s,
            f"grant all on table public.{table} to service_role",
            f"{table} service_role grant",
        )
        assert f"grant select on table public.{table} to authenticated" not in s

    for needle, label in [
        ("code text not null unique", "campaign code unique"),
        ("title text not null", "campaign title"),
        ("summary text", "campaign summary"),
        ("starts_on date not null", "campaign start"),
        ("ends_on date not null", "campaign end"),
        ("eligible_groups text[] not null default '{}'::text[]", "eligible groups"),
        ("items jsonb not null", "campaign items"),
        ("rules text[] not null default '{}'::text[]", "campaign rules"),
        ("draw jsonb", "campaign draw"),
        ("status text not null default 'draft'", "campaign status"),
        ("check (status in ('draft', 'active', 'closed'))", "campaign status values"),
        ("employee_code text not null", "offer employee"),
        ("gift_enabled boolean not null default true", "gift toggle"),
        ("shift_start time", "per-employee cutoff override"),
        ("unique (campaign_id, employee_code)", "one offer per campaign/employee"),
        ("offer_id uuid not null unique references public.payroll_mission_offers(id) on delete cascade", "review offer fk"),
        ("earned jsonb not null default '[]'::jsonb", "review earned"),
        ("disqualified boolean not null default false", "review disqualified"),
        ("disqualify_reason text", "review reason"),
        ("quarter text not null", "ticket quarter"),
        ("issued_at timestamptz not null default now()", "ticket issued at"),
        ("void_reason text", "ticket void reason"),
        ("unique (campaign_id, employee_code)", "one ticket per campaign/employee"),
        ("create table if not exists public.payroll_mission_events", "audit table"),
        ("reject_payroll_mission_event_mutation", "audit append-only trigger fn"),
        ("payroll_mission_events_are_append_only", "audit append-only error"),
    ]:
        assert_contains(s, needle, label)


def test_item_shape_validation() -> None:
    s = sql()
    body = function_body(s, "payroll_mission_validate_items")
    for needle, label in [
        ("jsonb_typeof(p_items) <> 'array'", "items array"),
        ("v_key = any(v_keys)", "unique keys"),
        ("v_kind not in ('attendance_regular', 'punctual', 'draw_ticket', 'manual')", "known kinds"),
        ("jsonb_typeof(v_item->'amount_vnd') <> 'number'", "numeric amount"),
        ("v_amount < 0", "non-negative amount"),
        ("jsonb_typeof(v_item->'params') <> 'object'", "params object"),
    ]:
        assert_contains(body, needle, label)


def test_owner_and_payroll_edit_authorization() -> None:
    s = sql()
    body = function_body(s, "payroll_mission_admin_allowed")
    assert_contains(body, "coalesce(auth.role(), '') = 'service_role'", "service role bypass")
    assert_contains(body, "public.has_role(p_uid, 'owner')", "owner check")
    assert_contains(body, "public.has_module_permission(p_uid, 'payroll', 'edit')", "payroll edit check")
    for rpc in (
        "upsert_payroll_mission_campaign",
        "set_payroll_mission_campaign_status",
        "set_payroll_mission_gift",
        "set_payroll_mission_gift_bulk",
        "list_payroll_missions",
        "review_payroll_mission_offer",
        "list_payroll_mission_bonus_for_period",
    ):
        body = function_body(s, rpc)
        assert_contains(body, "payroll_mission_admin_allowed(v_uid)", f"{rpc} auth check")


def test_one_active_campaign_per_overlapping_group() -> None:
    s = sql()
    body = function_body(s, "payroll_mission_assert_no_active_overlap")
    for needle, label in [
        ("c.status = 'active'", "active only"),
        ("c.starts_on <= p_ends_on", "window overlap start"),
        ("c.ends_on >= p_starts_on", "window overlap end"),
        ("payroll_mission_groups_overlap", "eligible group overlap"),
        ("payroll_mission_active_campaign_overlap", "overlap error"),
    ]:
        assert_contains(body, needle, label)
    for rpc in ("upsert_payroll_mission_campaign", "set_payroll_mission_campaign_status"):
        assert_contains(function_body(s, rpc), "payroll_mission_assert_no_active_overlap", f"{rpc} overlap check")


def test_gift_toggle_and_bulk() -> None:
    s = sql()
    gift = function_body(s, "set_payroll_mission_gift")
    for needle, label in [
        ("insert into public.payroll_mission_offers", "creates an offer"),
        ("'pending'", "starts pending"),
        ("on conflict (campaign_id, employee_code) do update", "upsert one offer"),
        ("gift_enabled = excluded.gift_enabled", "enables/disables"),
        ("shift_start = coalesce(excluded.shift_start", "keeps cutoff override"),
        ("status = 'pending'", "does not reset responded history"),
    ]:
        assert_contains(gift, needle, label)

    bulk = function_body(s, "set_payroll_mission_gift_bulk")
    assert_contains(bulk, "unnest(p_employee_codes)", "bulk employee list")
    assert_contains(bulk, "perform public.set_payroll_mission_gift(", "bulk delegates to single toggle")


def test_review_amounts_only_from_campaign_items() -> None:
    s = sql()
    body = function_body(s, "review_payroll_mission_offer")
    for needle, label in [
        ("p_earned_keys text[]", "keys-only signature"),
        ("if v_offer.status <> 'accepted'", "only accepted offers"),
        ("from jsonb_array_elements(v_campaign.items) as item", "reads campaign items"),
        ("'amount_vnd', (item->>'amount_vnd')::numeric", "amount from item"),
        ("if v_disqualified then\n    v_earned := '[]'::jsonb;", "disqualified forces empty"),
        ("payroll_mission_unknown_item", "unknown item rejected"),
        ("if not v_disqualified and v_earned_count > 0 and v_has_draw_item", "ticket eligibility"),
        ("v_earned_count = 0 then 'no_earned_items'", "no earned item voids ticket"),
        ("'employee_left_before_draw'", "left employee void"),
        ("'disqualified'", "disqualified voids ticket"),
    ]:
        assert_contains(body, needle, label)
    assert "p_amount" not in body, "review must never accept an amount from the client"
    assert "amount_vnd from p_" not in body, "amount must come from campaign items"


def test_progress_uses_attendance_and_configured_cutoff() -> None:
    s = sql()
    body = function_body(s, "payroll_mission_progress")
    for needle, label in [
        ("security definer", "security definer"),
        ("payroll_bn_attendance_events", "attendance ledger"),
        ("e.decision = 'accepted'", "accepted only"),
        ("e.event_kind = 'in'", "in events"),
        ("v_offer.status = 'accepted'", "accepted date"),
        ("greatest(", "window start"),
        ("least(v_campaign.ends_on, v_today)", "window end today"),
        ("days_with_in", "in days"),
        ("days_complete", "complete days"),
        ("days_missing_out", "missing out days"),
        ("on_time_days", "on-time days"),
        ("v_offer.shift_start", "per-employee cutoff"),
        ("time '07:00'", "default cutoff"),
        ("make_interval(mins => v_grace_minutes)", "grace minutes"),
        ("v_days_with_in >= v_min_days and v_days_missing_out = 0", "regular rule"),
        ("v_days_with_in >= 1 and v_on_time = v_days_with_in", "punctual rule"),
        ("'met', v_met", "met flag"),
        ("'detail'", "detail numbers"),
    ]:
        assert_contains(body, needle, label)


def test_bonus_rpc_and_db_client_link() -> None:
    s = sql()
    body = function_body(s, "list_payroll_mission_bonus_for_period")
    for needle, label in [
        ("r.disqualified is false", "exclude disqualified"),
        ("o.status = 'accepted'", "accepted offers"),
        ("sum((earned_item.value->>'amount_vnd')::numeric)", "sum earned amounts"),
        ("c.starts_on <= v_period.date_to", "period overlap start"),
        ("c.ends_on >= v_period.date_from", "period overlap end"),
        ("group by o.employee_code", "per employee"),
    ]:
        assert_contains(body, needle, label)

    client = read(DB_CLIENT)
    for needle, label in [
        ("list_payroll_mission_bonus_for_period", "db-client calls bonus RPC"),
        ('{ p_period_id: periodId }', "period argument"),
        ('period.status === "locked"', "locked period guard"),
        ("missionBonusByCode", "bonus map"),
        ("missionBonus: bonus", "sets employee.missionBonus"),
    ]:
        assert_contains(client, needle, label)
    assert_contains(read(DB_TEST), "missionBonus", "db-client mission bonus test")
    assert_contains(read(DB_TEST), "locked period", "locked period test")


def test_audit_triggers_cover_every_write() -> None:
    s = sql()
    for needle, label in [
        ("create or replace function public.audit_payroll_mission_change", "audit trigger fn"),
        ("insert into public.payroll_mission_events", "audit insert"),
        ("after insert or update or delete on public.payroll_mission_campaigns", "campaign audit"),
        ("after insert or update or delete on public.payroll_mission_offers", "offer audit"),
        ("after insert or update or delete on public.payroll_mission_reviews", "review audit"),
        ("after insert or update or delete on public.payroll_mission_draw_tickets", "ticket audit"),
    ]:
        assert_contains(s, needle, label)


def test_shared_pure_logic_and_tests() -> None:
    shared = read(SHARED)
    for needle, label in [
        ("validateMissionItems", "item validation"),
        ("evaluateMissionProgress", "progress evaluation"),
        ("missionEarnedAmounts", "earned amounts"),
        ("evaluateMissionReview", "review"),
        ("missionTicketEligibility", "ticket eligibility"),
        ("respondToMissionOffer", "accept/decline once"),
        ("missionProgressWindow", "accepted-date window"),
        ("attendance_regular", "regular kind"),
        ("punctual", "punctual kind"),
        ("draw_ticket", "draw item kind"),
        ("employee_left_before_draw", "left-before-draw void"),
    ]:
        assert_contains(shared, needle, label)

    tests = read(SHARED_TEST)
    for needle, label in [
        ("an offer can be accepted or declined exactly once", "accept/decline test"),
        ("attendance_regular is met only with enough days", "regular test"),
        ("punctual respects cutoff and grace", "punctual test"),
        ("disqualified review gives zero and no ticket", "disqualified test"),
        ("review amounts are taken from campaign items", "amount source test"),
        ("progress window starts at the accepted date", "window test"),
        ("a ticket is issued only with at least one earned item", "ticket test"),
    ]:
        assert_contains(tests, needle, label)


def test_edge_function_auth_scope_and_actions() -> None:
    edge = read(EDGE)
    for needle, label in [
        ("x-payslip-session", "session header"),
        ("x-payslip-device", "device header"),
        ("payroll_bn_payslip_sessions", "session lookup"),
        ("hashPayslipDeviceId", "device binding"),
        ("payroll_mission_offers", "offers table"),
        ("payroll_mission_campaigns", "campaign table"),
        ("payroll_mission_reviews", "review table"),
        ("payroll_mission_draw_tickets", "ticket table"),
        ("payroll_mission_progress", "progress RPC"),
        ("gift_enabled", "gift visibility"),
        ("status", "offer status"),
        ("\"active\"", "active campaign filter"),
        ("action === \"get\"", "get action"),
        ("action !== \"respond\"", "respond action"),
        ("offer_id", "offer id"),
        ("decision", "accept/decline"),
        ("session.employee_code", "employee scoping"),
        ("401", "401 rules"),
        ("session_required", "session required"),
        ("device_mismatch", "device mismatch"),
        ("offer_already_responded", "idempotent/conflict response"),
        ("publicItems(campaign.items)", "items from data"),
        ("publicRules(campaign.rules)", "rules from data"),
    ]:
        assert_contains(edge, needle, label)
    for hardcoded, label in [
        ("Chấm công đều", "no hard-coded mission label"),
        ("Đúng giờ", "no hard-coded punctual label"),
        ("Thưởng nhiệm vụ", "no hard-coded mission amount/label"),
    ]:
        assert hardcoded not in edge, f"{label}: {hardcoded!r} must stay data-driven"
    assert "'chấm công đều'" not in sql(), "migration must not hard-code a mission label"
    assert "'đúng giờ'" not in sql(), "migration must not hard-code a mission label"


def test_config_and_cors_register_payslip_mission() -> None:
    config = read(CONFIG).lower()
    marker = "[functions.payslip-mission]"
    assert marker in config, "missing config section [functions.payslip-mission]"
    section = config.split(marker, 1)[1].split("[functions.", 1)[0]
    assert "verify_jwt = false" in section, "payslip-mission must accept psp_ auth"

    cors = read(CORS)
    assert_contains(cors, "payslip-mission", "CORS registration")
    assert_contains(cors, "PAYSLIP_PORTAL_FUNCTIONS", "payslip portal function set")


def test_client_types_api_and_admin_hook() -> None:
    types = read(TYPES)
    for needle, label in [
        ("export interface PayrollMissionOffer", "offer type"),
        ("export interface PayrollMissionCampaign", "campaign type"),
        ("export interface PayrollMissionProgressItem", "progress type"),
        ("export interface PayrollMissionReview", "review type"),
        ("export interface PayrollMissionTicket", "ticket type"),
        ("getMission()", "get method"),
        ("respondMission(", "respond method"),
    ]:
        assert_contains(types, needle, label)

    api = read(API)
    for needle, label in [
        ("normalizeMissionOffer", "normalizer"),
        ("payslip-mission", "endpoint"),
        ("x-payslip-session", "session header"),
        ("x-payslip-device", "device header"),
        ("action: \"get\"", "get action"),
        ("action: \"respond\"", "respond action"),
        ("status === 401", "401 handling"),
        ("PayslipSessionExpiredError", "session expiry"),
    ]:
        assert_contains(api, needle, label)

    api_test = read(API_TEST)
    for needle, label in [
        ("getMission sends session/device headers", "get test"),
        ("respondMission posts the decision", "respond test"),
        ("a 401 clears the session", "401 test"),
    ]:
        assert_contains(api_test, needle, label)

    hook = read(HOOK)
    for needle, label in [
        ("list_payroll_missions", "list RPC"),
        ("set_payroll_mission_gift\"", "single gift RPC"),
        ("set_payroll_mission_gift_bulk", "bulk gift RPC"),
        ("review_payroll_mission_offer", "review RPC"),
        ("set_payroll_mission_campaign_status", "status RPC"),
        ("invalidateQueries", "cache invalidation"),
        ("payroll-missions", "query key"),
    ]:
        assert_contains(hook, needle, label)


def test_rollback_smoke_covers_required_cases() -> None:
    smoke = read(SMOKE)
    lowered = smoke.lower()
    for needle, label in [
        ("do $$", "single DO block"),
        ("set_config('request.jwt.claims'", "service-role claims"),
        ("rollback", "rollback-only"),
        ("upsert_payroll_mission_campaign", "campaign RPC"),
        ("active_campaign_overlap", "overlap case"),
        ("set_payroll_mission_gift_bulk", "bulk gift case"),
        ("payroll_mission_progress", "progress case"),
        ("days_missing_out", "missing-out case"),
        ("shift_start_override_not_applied", "cutoff override case"),
        ("disqualified", "disqualified case"),
        ("no_earned_items", "no earned item case"),
        ("employee_left_before_draw", "left employee case"),
        ("list_payroll_mission_bonus_for_period", "bonus RPC case"),
        ("list_payroll_missions", "manager list case"),
        ("events_delete_not_blocked", "audit append-only case"),
    ]:
        assert_contains(lowered, needle, label)
    assert "\\set" not in smoke and "\\gset" not in smoke, "smoke must be pure SQL"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS {name}")
