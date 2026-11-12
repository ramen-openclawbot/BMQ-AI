#!/usr/bin/env python3
"""Static contracts for the payroll_bn live attendance board + ranking."""
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATION = ROOT / "supabase/migrations/20261112150000_payroll_bn_attendance_board.sql"
TS_MODULE = ROOT / "src/lib/payroll-bn/attendance-board.ts"
TS_TEST = ROOT / "src/lib/payroll-bn/attendance-board.test.ts"
HOOK = ROOT / "src/hooks/usePayrollBnAttendanceBoard.ts"
SMOKE = ROOT / "scripts/smoke_payroll_bn_attendance_board.sql"


def read(path: Path) -> str:
    assert path.exists(), f"Missing expected file: {path.relative_to(ROOT)}"
    return path.read_text(encoding="utf-8")


def sql() -> str:
    return read(MIGRATION).lower()


def no_comments(text: str) -> str:
    return "\n".join(line.split("--", 1)[0] for line in text.splitlines())


def function_sql(text: str, name: str) -> str:
    start = text.index(f"create or replace function public.{name}(")
    end = text.index("\n$$;", start)
    return text[start:end]


def assert_contains(text: str, needle: str, label: str) -> None:
    assert needle in text, f"Missing {label}: {needle!r}"


def assert_order(text: str, needles: list[tuple[str, str]]) -> None:
    positions = []
    for needle, label in needles:
        assert needle in text, f"Missing {label}: {needle!r}"
        positions.append(text.index(needle))
    assert positions == sorted(positions), f"Wrong order for {[label for _, label in needles]}"


def test_migration_is_read_only() -> None:
    body = no_comments(sql())
    for needle in [
        "insert into",
        "update public.",
        "delete from",
        "create table",
        "create trigger",
        "truncate",
        "alter table",
    ]:
        assert needle not in body, f"Migration must not contain {needle!r}"
    assert "cron" not in body, "Migration must not install cron"
    assert "table public." not in body, "Migration must not add a table"


def test_helper_precedence_and_shape() -> None:
    s = sql()
    helper = function_sql(s, "payroll_bn_shift_start_for")
    for needle, label in [
        ("returns jsonb", "jsonb result"),
        ("stable", "stable"),
        ("security definer", "security definer"),
        ("set search_path = public", "search path"),
        ("'start_time'", "start_time key"),
        ("'source'", "source key"),
        ("'scheduled_off'", "scheduled_off key"),
        ("'on_leave'", "on_leave key"),
        ("'closed'", "closed key"),
        ("'schedule'", "schedule source"),
        ("'manual'", "manual source"),
        ("'mission'", "mission source"),
        ("status = 'published'", "published week gate"),
        ("payroll_bn_shift_entries", "registered entry"),
        ("payroll_bn_shift_types", "shift catalogue"),
        ("v_scheduled_off := true", "null-shift entry is a day off"),
        ("r.kind = 'leave'", "leave request"),
        ("r.state = 'approved'", "approved leave"),
        ("closed_dates", "closed dates"),
        ("p_date = any", "closed date membership"),
        ("payroll_bn_employee_shifts", "manual shift start"),
        ("payroll_mission_offers", "mission offer"),
        ("payroll_mission_campaigns", "mission campaign"),
        ("c.status = 'active'", "active campaign"),
        ("p_date between c.starts_on and c.ends_on", "campaign window"),
        ("value->>'kind' = 'punctual'", "punctual item"),
        ("v_mission_default time := time '07:00'", "mission fallback source"),
        ("v_cutoff_text ~", "cutoff format validation"),
    ]:
        assert_contains(helper, needle, label)

    assert_order(
        helper,
        [
            ("status = 'published'", "published schedule first"),
            ("p_date = any", "closed flag"),
            ("v_scheduled_off := true", "day off from schedule"),
            ("r.kind = 'leave'", "leave flag"),
            ("payroll_bn_employee_shifts", "manual second"),
            ("from public.payroll_mission_offers o", "mission last"),
        ],
    )


def test_board_rpc_contract() -> None:
    s = sql()
    board = function_sql(s, "get_payroll_bn_attendance_board")
    for needle, label in [
        ("p_date date default null", "optional date"),
        ("stable", "stable"),
        ("security definer", "security definer"),
        ("set search_path = public", "search path"),
        ("public.payroll_bn_attendance_admin_allowed(v_uid)", "manager role check"),
        ("coalesce(p_date, v_today)", "null date means today"),
        ("v_date > v_today", "future date guard"),
        ("payroll_bn_board_future_date", "future date message"),
        ("using errcode = '22023'", "future date SQLSTATE"),
        ("where g.enabled", "enabled gates only"),
        ("public.payroll_bn_shift_employee_name", "employee name helper"),
        ("public.payroll_bn_shift_start_for", "shift start helper"),
        ("pe.group_name", "latest period group"),
        ("order by p.date_from desc, p.created_at desc", "latest period definition"),
        ("public.payroll_bn_attendance_day_overrides", "day override lookup"),
        ("min(ev.server_received_at)", "first accepted in"),
        ("ev.event_kind = 'out'", "accepted out"),
        ("ev.server_received_at >= de.check_in_at", "out after in"),
        ("count(*) filter (where ev.decision = 'rejected')", "rejected count"),
        ("floor(", "floor minutes"),
        ("greatest(", "never negative"),
        ("'on_time'", "on_time status"),
        ("'late'", "late status"),
        ("'absent_overdue'", "absent_overdue status"),
        ("'not_yet'", "not_yet status"),
        ("'no_shift_time'", "no_shift_time status"),
        ("'off'", "off status"),
        ("'override'", "override status"),
        ("late_grace_minutes", "grace from settings"),
        ("'checked_out', s.check_out_at is not null", "checked_out key"),
        ("'rejected_count', s.rejected_count", "rejected_count key"),
        ("'has_override', s.has_override", "has_override key"),
        ("'generated_at', now()", "generated_at"),
        ("'totals'", "totals envelope"),
        ("when 'absent_overdue' then 0", "absent ordering first"),
        ("when 'not_yet' then 1", "not_yet ordering"),
        ("when 'late' then 2", "late ordering"),
        ("when 'on_time' then 3", "on_time ordering"),
        ("when 'no_shift_time' then 4", "no_shift ordering"),
        ("when 'off' then 5", "off ordering"),
        ("s.start_time nulls last", "then shift start"),
        ("s.name,", "then name"),
    ]:
        assert_contains(board, needle, label)

    for total in [
        "employees",
        "checked_in",
        "on_time",
        "late",
        "not_yet",
        "absent_overdue",
        "checked_out",
        "off",
        "no_shift_time",
    ]:
        assert_contains(board, f"'{total}', count(*)", f"total {total}")


def test_ranking_rpc_contract() -> None:
    s = sql()
    ranking = function_sql(s, "get_payroll_bn_punctuality_ranking")
    for needle, label in [
        ("p_from date", "from argument"),
        ("p_to date", "to argument"),
        ("stable", "stable"),
        ("security definer", "security definer"),
        ("set search_path = public", "search path"),
        ("public.payroll_bn_attendance_admin_allowed(v_uid)", "manager role check"),
        ("v_to := least(p_to, v_today)", "p_to clamp to today"),
        ("v_from > v_to", "reversed range guard"),
        ("(v_to - v_from) > 91", "92-day inclusive limit"),
        ("payroll_bn_board_range_invalid", "range error message"),
        ("using errcode = '22023'", "range SQLSTATE"),
        ("where g.enabled", "same enabled-gate employee set"),
        ("public.payroll_bn_shift_start_for", "shift start helper"),
        ("public.payroll_bn_attendance_day_overrides", "override lookup"),
        ("'worked_days'", "worked_days key"),
        ("'on_time_days'", "on_time_days key"),
        ("'late_days'", "late_days key"),
        ("'late_minutes_total'", "late minutes key"),
        ("'no_shift_time_days'", "no shift key"),
        ("'absent_days'", "absent key"),
        ("'best_streak'", "best streak key"),
        ("'current_streak'", "current streak key"),
        ("'on_time_rate'", "rate key"),
        ("'rank'", "rank key"),
        ("count(*) filter (where m.worked)", "worked count"),
        ("m.streak_kind = 'on_time'", "on-time streak marker"),
        ("m.streak_kind <> 'skip'", "off days do not break streak"),
        ("rank() over (", "tie rank"),
        ("sc.on_time_days desc", "rank by on_time_days"),
        ("sc.on_time_rate desc nulls last", "rank by rate"),
        ("sc.late_minutes_total asc", "rank by late minutes"),
        ("'from', v_from", "from envelope"),
        ("'to', v_to", "to envelope"),
        ("'late_grace_minutes', v_grace", "grace envelope"),
    ]:
        assert_contains(ranking, needle, label)


def test_grants_are_manager_only() -> None:
    s = sql()
    for name, signature in [
        ("payroll_bn_shift_start_for", "text, date"),
        ("get_payroll_bn_attendance_board", "date"),
        ("get_payroll_bn_punctuality_ranking", "date, date"),
    ]:
        assert_contains(
            s,
            f"revoke all on function public.{name}({signature})\n  from public, anon, authenticated",
            f"{name} revoke",
        )

    assert_contains(
        s,
        "grant execute on function public.payroll_bn_shift_start_for(text, date)\n  to service_role",
        "helper service_role grant",
    )
    for name, signature in [
        ("get_payroll_bn_attendance_board", "date"),
        ("get_payroll_bn_punctuality_ranking", "date, date"),
    ]:
        assert_contains(
            s,
            f"grant execute on function public.{name}({signature})\n  to authenticated, service_role",
            f"{name} manager grant",
        )

    # The helper must not be callable by browser roles.
    assert "grant execute on function public.payroll_bn_shift_start_for(text, date)\n  to authenticated" not in s
    assert "to anon" not in s


def test_ts_mirror_and_status_labels() -> None:
    module = read(TS_MODULE)
    for needle, label in [
        ("export type AttendanceBoardStatus", "board status type"),
        ("export interface AttendanceBoardEmployee", "employee type"),
        ("export interface AttendanceBoardTotals", "totals type"),
        ("export interface AttendanceBoard", "board type"),
        ("export interface PunctualityRankingEmployee", "ranking employee type"),
        ("export interface PunctualityRanking", "ranking type"),
        ("export function mapAttendanceBoard(", "board mapper"),
        ("export function mapPunctualityRanking(", "ranking mapper"),
        ("export function attendanceStatusLabel(", "status label"),
        ("export function attendanceStatusTone(", "status tone"),
        ("export function formatMinutes(", "minutes formatter"),
        ("Đúng giờ", "on-time label"),
        ("Trễ ", "late label"),
        ("Chưa đến", "not-yet label"),
        ("Quá giờ chưa chấm", "absent label"),
        ("Chưa có giờ ca", "no-shift label"),
        ("Nghỉ", "off label"),
        ("Đã duyệt công", "override label"),
    ]:
        assert_contains(module, needle, label)

    assert "tsx" not in module.lower()
    assert "react" not in module.lower()


def test_ts_tests_and_hook() -> None:
    test_file = read(TS_TEST)
    for needle, label in [
        ('from "node:test"', "node test runner"),
        ("./attendance-board.ts", "module import"),
        ("mapAttendanceBoard", "board mapper test"),
        ("mapPunctualityRanking", "ranking mapper test"),
        ("attendanceStatusLabel", "label test"),
        ("Đúng giờ", "Vietnamese label test"),
    ]:
        assert_contains(test_file, needle, label)
    assert "Deno" not in test_file
    assert "jsr:" not in test_file

    hook = read(HOOK)
    for needle, label in [
        ('from "@tanstack/react-query"', "react-query"),
        ("export function useAttendanceBoard", "board hook"),
        ("export function usePunctualityRanking", "ranking hook"),
        ("get_payroll_bn_attendance_board", "board RPC"),
        ("get_payroll_bn_punctuality_ranking", "ranking RPC"),
        ('["payroll-bn-attendance-board", date]', "board query key"),
        ('["payroll-bn-punctuality-ranking", from, to]', "ranking query key"),
        ("refetchInterval: isAttendanceBoardToday(date) ? 20_000 : false", "poll today only"),
        ("refetchOnWindowFocus: true", "focus refetch"),
        ("p_date: date", "board date argument"),
        ("p_from: from", "ranking from argument"),
        ("p_to: to", "ranking to argument"),
    ]:
        assert_contains(hook, needle, label)


def test_smoke_covers_runtime_cases() -> None:
    smoke = read(SMOKE)
    lowered = smoke.lower()
    for needle, label in [
        ("begin;", "transactional smoke"),
        ("do $$", "one DO block"),
        ("rollback;", "rollback cleanup"),
        ("task_board_e", "TASK employees"),
        ("attendance_geofence_locations", "site fixture"),
        ("payroll_bn_attendance_gates", "gate fixture"),
        ("payroll_bn_shift_weeks", "published week fixture"),
        ("payroll_bn_shift_entries", "shift entries"),
        ("payroll_bn_employee_shifts", "manual shift start"),
        ("payroll_bn_shift_requests", "approved leave"),
        ("payroll_bn_attendance_day_overrides", "day override"),
        ("payroll_bn_attendance_events", "attendance events"),
        ("'rejected'", "rejected event"),
        ("payroll_mission_offers", "mission offers"),
        ("precedence_schedule_lost", "schedule precedence"),
        ("precedence_manual_lost", "manual precedence"),
        ("precedence_mission_lost", "mission precedence"),
        ("board_on_time_row_wrong", "on_time status"),
        ("board_late_row_wrong", "late status"),
        ("board_not_yet_row_wrong", "not_yet status"),
        ("board_absent_row_wrong", "absent_overdue status"),
        ("board_leave_row_wrong", "leave off status"),
        ("board_scheduled_off_row_wrong", "scheduled off status"),
        ("board_override_row_wrong", "override status"),
        ("board_no_shift_row_wrong", "no_shift_time status"),
        ("board_totals_wrong", "totals"),
        ("board_order_wrong", "row order"),
        ("board_closed_row_wrong", "closed date"),
        ("get_payroll_bn_shift_attendance_flags", "flags agreement"),
        ("board_flags_late_mismatch", "late agreement"),
        ("board_flags_minutes_mismatch", "minutes agreement"),
        ("ranking_e1_wrong", "ranking counts"),
        ("ranking_tie_wrong", "tie rank"),
        ("ranking_tie_count_wrong", "shared rank"),
        ("ranking_off_streak_wrong", "off-day streak"),
        ("ranking_92_day_range_wrong", "92-day allowed range"),
        ("ranking_93_days_not_blocked", "93-day rejection"),
        ("board_future_date_not_blocked", "future date refusal"),
        ("board_non_manager_not_blocked", "non-manager board refusal"),
        ("ranking_non_manager_not_blocked", "non-manager ranking refusal"),
        ("readonly_rpc_changed_rows", "no-write assertion"),
        ("raise notice 'attendance_board_smoke_pass'", "pass notice"),
    ]:
        assert_contains(lowered, needle, label)

    assert "\\set" not in smoke and "\\gset" not in smoke, "smoke must be pure SQL"
    assert lowered.count("do $$") == 1, "smoke must use one DO block"


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
            print(f"PASS {name}")
