// Attendance adapter tests — payroll rows + anomalies.ts flags → mission rows.
//
// The T09 fixture already carries the machine columns and the four review flags,
// so this test rebuilds the adapter input from it and proves the mission
// judgments (T-DUNGGIO / T-CHAMDU) are unchanged. It also covers the
// "HC day without Trễ → needs_review" guard.

import assert from "node:assert/strict";
import test from "node:test";

import type { Anomaly, AnomalyCode } from "../payroll-bn/anomalies.ts";
import type { AttendanceRow } from "../payroll-bn/types.ts";
import { toMissionAttendanceRows } from "./attendance-adapter.ts";
import { evaluateMission } from "./evaluator.ts";
import {
  MISSIONS_T09_ROWS,
} from "./missions-t09.fixture.ts";
import { buildMissionTemplate } from "./templates.ts";
import type { MissionAttendanceFlag } from "./types.ts";

const MAPPED_FLAGS: MissionAttendanceFlag[] = [
  "missing_check_in",
  "missing_check_out",
  "no_machine_data",
  "duplicate_time",
];

function toPayrollRows(): AttendanceRow[] {
  return MISSIONS_T09_ROWS.map((row) => ({
    employeeCode: row.employeeCode,
    employeeName: row.employeeName,
    date: row.date,
    checkIn: row.checkIn,
    checkOut: row.checkOut,
    department: null,
    shift: row.shift,
    lateMinutes: row.lateMinutes,
    earlyMinutes: row.earlyMinutes,
  }));
}

function toAnomalies(): Anomaly[] {
  const anomalies: Anomaly[] = [];
  for (const row of MISSIONS_T09_ROWS) {
    for (const flag of row.flags) {
      if (!MAPPED_FLAGS.includes(flag)) continue;
      anomalies.push({
        code: flag as AnomalyCode,
        severity: "warning",
        employeeCode: row.employeeCode,
        employeeName: row.employeeName,
        date: row.date,
        detail: flag,
      });
    }
  }
  return anomalies;
}

test("adapter carries Ca/Trễ and maps the four anomaly flags, adding none", () => {
  const adapted = toMissionAttendanceRows(toPayrollRows(), toAnomalies());
  assert.equal(adapted.length, MISSIONS_T09_ROWS.length);

  for (const source of MISSIONS_T09_ROWS) {
    const actual = adapted.find(
      (row) => row.employeeCode === source.employeeCode && row.date === source.date,
    );
    assert.ok(actual, `missing ${source.employeeCode} ${source.date}`);
    assert.equal(actual!.shift, source.shift);
    assert.equal(actual!.lateMinutes, source.lateMinutes);
    assert.equal(actual!.earlyMinutes, source.earlyMinutes);
    assert.deepEqual(actual!.flags, source.flags);
    for (const flag of actual!.flags) {
      assert.ok(MAPPED_FLAGS.includes(flag), `unexpected flag ${flag}`);
    }
  }
});

test("T-DUNGGIO và T-CHAMDU giống test hiện có trên fixture T09", () => {
  const adapted = toMissionAttendanceRows(toPayrollRows(), toAnomalies());
  const rowsFor = (code: string) => adapted.filter((row) => row.employeeCode === code);

  const dungGio0 = buildMissionTemplate("T-DUNGGIO", { params: { dung_sai_phut: 0 } });
  const dungGio1 = buildMissionTemplate("T-DUNGGIO", { params: { dung_sai_phut: 1 } });
  assert.equal(evaluateMission({ template: dungGio0, attendance: rowsFor("00030") }).status, "achieved");
  assert.equal(evaluateMission({ template: dungGio0, attendance: rowsFor("00033") }).status, "achieved");
  assert.equal(evaluateMission({ template: dungGio0, attendance: rowsFor("00005") }).status, "not_achieved");
  assert.equal(evaluateMission({ template: dungGio1, attendance: rowsFor("00005") }).status, "achieved");
  const ngoc = evaluateMission({ template: dungGio0, attendance: rowsFor("00002") });
  assert.equal(ngoc.status, "not_achieved");
  assert.equal(ngoc.reason, "7 ngày trễ");

  const chamDu = buildMissionTemplate("T-CHAMDU", {});
  const huy = evaluateMission({ template: chamDu, attendance: rowsFor("00034") });
  assert.equal(huy.status, "not_achieved");
  assert.deepEqual((huy.evidence as { missing_punch_dates: string[] }).missing_punch_dates, [
    "2026-09-03",
  ]);
  const hong = evaluateMission({ template: chamDu, attendance: rowsFor("00006") });
  assert.equal(hong.status, "needs_review");
  assert.deepEqual((hong.evidence as { abnormal_dates: string[] }).abnormal_dates, ["2026-09-30"]);
  assert.equal(evaluateMission({ template: chamDu, attendance: rowsFor("00030") }).status, "achieved");
});

test("dòng ca HC thiếu lateMinutes → needs_review", () => {
  const rows: AttendanceRow[] = [
    {
      employeeCode: "E1",
      employeeName: "Test",
      date: "2026-09-03",
      checkIn: "08:05:00",
      checkOut: "17:30:00",
      department: null,
      shift: "HC",
      lateMinutes: null,
      earlyMinutes: null,
    },
  ];
  const adapted = toMissionAttendanceRows(rows, []);
  const template = buildMissionTemplate("T-DUNGGIO", { params: { dung_sai_phut: 0 } });
  const result = evaluateMission({ template, attendance: adapted });
  assert.equal(result.status, "needs_review");
  assert.equal(result.reason, "Ngày ca HC thiếu số liệu Trễ");
});
