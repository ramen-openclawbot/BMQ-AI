import assert from "node:assert/strict";
import test from "node:test";

import {
  attendanceStatusLabel,
  attendanceStatusTone,
  formatMinutes,
  mapAttendanceBoard,
  mapPunctualityRanking,
} from "./attendance-board.ts";

test("maps a snake_case board payload to camelCase without losing totals", () => {
  const board = mapAttendanceBoard({
    date: "2026-11-12",
    generated_at: "2026-11-12T08:15:00+07:00",
    late_grace_minutes: 5,
    employees: [
      {
        employee_code: "BN01",
        name: "Bếp Một",
        group_name: "Bếp bánh",
        shift_start: "08:00",
        shift_source: "schedule",
        scheduled_off: false,
        on_leave: false,
        closed: false,
        check_in_at: "2026-11-12T08:15:00+07:00",
        check_out_at: null,
        minutes_late: 15,
        status: "late",
        checked_out: false,
        rejected_count: 1,
        has_override: false,
      },
    ],
    totals: {
      employees: 1,
      checked_in: 1,
      on_time: 0,
      late: 1,
      not_yet: 0,
      absent_overdue: 0,
      checked_out: 0,
      off: 0,
      no_shift_time: 0,
    },
  });

  assert.equal(board.date, "2026-11-12");
  assert.equal(board.lateGraceMinutes, 5);
  assert.equal(board.employees[0].employeeCode, "BN01");
  assert.equal(board.employees[0].groupName, "Bếp bánh");
  assert.equal(board.employees[0].shiftSource, "schedule");
  assert.equal(board.employees[0].minutesLate, 15);
  assert.equal(board.employees[0].rejectedCount, 1);
  assert.equal(board.totals.late, 1);
  assert.equal(board.totals.checkedIn, 1);
});

test("tolerates missing fields and derives totals when the server omits them", () => {
  const board = mapAttendanceBoard({
    employees: [
      { status: "on_time", check_out_at: "2026-11-12T17:00:00+07:00" },
      { status: "off" },
    ],
  });

  assert.equal(board.date, "");
  assert.equal(board.generatedAt, "");
  assert.equal(board.lateGraceMinutes, 0);
  assert.equal(board.employees[0].employeeCode, "");
  assert.equal(board.employees[0].checkedOut, true);
  assert.equal(board.employees[1].shiftSource, null);
  assert.equal(board.totals.employees, 2);
  assert.equal(board.totals.onTime, 1);
  assert.equal(board.totals.off, 1);
  assert.equal(board.totals.checkedOut, 1);
});

test("every status has the required Vietnamese label", () => {
  assert.equal(attendanceStatusLabel("on_time"), "Đúng giờ");
  assert.equal(attendanceStatusLabel("late", 12), "Trễ 12 phút");
  assert.equal(attendanceStatusLabel("late", 0), "Trễ 0 phút");
  assert.equal(attendanceStatusLabel("not_yet"), "Chưa đến");
  assert.equal(attendanceStatusLabel("absent_overdue"), "Quá giờ chưa chấm");
  assert.equal(attendanceStatusLabel("no_shift_time"), "Chưa có giờ ca");
  assert.equal(attendanceStatusLabel("off"), "Nghỉ");
  assert.equal(attendanceStatusLabel("override"), "Đã duyệt công");
});

test("tone helper only returns data and covers the vocabulary", () => {
  assert.equal(attendanceStatusTone("on_time"), "success");
  assert.equal(attendanceStatusTone("late"), "warning");
  assert.equal(attendanceStatusTone("absent_overdue"), "danger");
  assert.equal(attendanceStatusTone("off"), "neutral");
  assert.equal(attendanceStatusTone("no_shift_time"), "muted");
});

test("formats minutes, floors and never returns a negative display", () => {
  assert.equal(formatMinutes(0), "0 phút");
  assert.equal(formatMinutes(15), "15 phút");
  assert.equal(formatMinutes(15.9), "15 phút");
  assert.equal(formatMinutes(-4), "0 phút");
  assert.equal(formatMinutes(null), "—");
  assert.equal(formatMinutes(undefined), "—");
  assert.equal(formatMinutes(Number.NaN), "—");
});

test("maps a punctuality ranking payload and keeps null rates", () => {
  const ranking = mapPunctualityRanking({
    from: "2026-11-02",
    to: "2026-11-08",
    late_grace_minutes: 5,
    employees: [
      {
        rank: 1,
        employee_code: "BN01",
        name: "Bếp Một",
        group_name: null,
        worked_days: 4,
        on_time_days: 3,
        late_days: 1,
        late_minutes_total: 10,
        no_shift_time_days: 0,
        absent_days: 1,
        best_streak: 2,
        current_streak: 1,
        on_time_rate: 0.75,
      },
      {
        rank: 2,
        employee_code: "BN02",
        name: "Bếp Hai",
        on_time_rate: null,
      },
    ],
  });

  assert.equal(ranking.from, "2026-11-02");
  assert.equal(ranking.to, "2026-11-08");
  assert.equal(ranking.lateGraceMinutes, 5);
  assert.equal(ranking.employees[0].onTimeRate, 0.75);
  assert.equal(ranking.employees[0].lateMinutesTotal, 10);
  assert.equal(ranking.employees[0].bestStreak, 2);
  assert.equal(ranking.employees[1].onTimeRate, null);
  assert.equal(ranking.employees[1].workedDays, 0);
});
