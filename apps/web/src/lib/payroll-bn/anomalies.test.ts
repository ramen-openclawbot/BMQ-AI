import assert from "node:assert/strict";
import test from "node:test";

import { detectAnomalies, summarizeAnomalies } from "./anomalies.ts";
import { resolveRulesConfig } from "./rules-config.ts";
import type { AttendanceRow, PayrollEmployee, PayrollPeriod } from "./types.ts";

const period: PayrollPeriod = {
  code: "T08.2026",
  name: "test",
  dateFrom: "2026-08-01",
  dateTo: "2026-08-31",
  standardDaysByGroup: { "Bếp bánh": 26 },
  defaultStandardDays: 26,
  holidays: ["2026-08-15"],
  rules: resolveRulesConfig(),
  status: "draft",
};

function employee(code: string): PayrollEmployee {
  return { code, name: `NV ${code}`, group: "Bếp bánh", employmentType: "official", monthlySalary: 10_400_000 };
}

const employees = [employee("E1"), employee("E2"), employee("E3"), employee("E4")];

function row(
  overrides: Partial<AttendanceRow> & { employeeCode: string; date: string },
): AttendanceRow {
  return {
    employeeName: `NV ${overrides.employeeCode}`,
    checkIn: "08:00:00",
    checkOut: "17:00:00",
    department: null,
    ...overrides,
  };
}

const rows: AttendanceRow[] = [
  row({ employeeCode: "E1", date: "2026-08-01" }),
  row({ employeeCode: "E2", date: "2026-08-01" }),
  row({ employeeCode: "E1", date: "2026-08-02", checkOut: null }),
  row({ employeeCode: "E3", date: "2026-08-03", checkIn: null }),
  row({ employeeCode: "E1", date: "2026-08-04", checkIn: null, checkOut: null }),
  row({ employeeCode: "E1", date: "2026-08-15" }),
  row({ employeeCode: "E9", date: "2026-08-05" }),
];

test("flags missing check-out and check-in; a row without any time is a day off", () => {
  const anomalies = detectAnomalies({ period, employees, rows });
  const codes = anomalies.map((item) => `${item.code}:${item.employeeCode}:${item.date ?? ""}`);
  assert.ok(codes.includes("missing_check_out:E1:2026-08-02"));
  assert.ok(codes.includes("missing_check_in:E3:2026-08-03"));
  assert.equal(codes.some((code) => code.endsWith(":E1:2026-08-04")), false);
});

test("a blank row on a holiday is not holiday attendance", () => {
  const anomalies = detectAnomalies({
    period,
    employees,
    rows: [row({ employeeCode: "E2", date: "2026-08-15", checkIn: null, checkOut: null })],
  });
  assert.equal(anomalies.some((item) => item.code === "holiday_attendance"), false);
});

test("flags two employees sharing the same in/out slot", () => {
  const anomalies = detectAnomalies({ period, employees, rows });
  const duplicates = anomalies.filter((item) => item.code === "duplicate_time");
  assert.equal(duplicates.length, 2);
  assert.deepEqual(duplicates[0].relatedEmployeeCodes, ["E1", "E2"]);
  assert.equal(duplicates.every((item) => item.severity === "error"), true);
});

test("flags unknown employee codes and catalog codes without attendance", () => {
  const anomalies = detectAnomalies({ period, employees, rows });
  const unknown = anomalies.filter((item) => item.code === "unknown_employee");
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].employeeCode, "E9");

  const missing = anomalies.filter((item) => item.code === "missing_attendance");
  // E3 does have a row (with a missing check-in), so only E4 is truly absent.
  assert.deepEqual(missing.map((item) => item.employeeCode), ["E4"]);
});

test("flags attendance on a period holiday", () => {
  const anomalies = detectAnomalies({ period, employees, rows });
  const holiday = anomalies.filter((item) => item.code === "holiday_attendance");
  assert.equal(holiday.length, 1);
  assert.equal(holiday[0].date, "2026-08-15");
});

test("detectAnomalies never mutates the parsed rows", () => {
  const before = JSON.stringify(rows);
  detectAnomalies({ period, employees, rows });
  assert.equal(JSON.stringify(rows), before);
});

test("summarizes anomalies by code", () => {
  const summary = summarizeAnomalies(detectAnomalies({ period, employees, rows }));
  assert.equal(summary.duplicate_time, 2);
  assert.equal(summary.missing_check_out, 1);
  assert.equal(summary.missing_check_in, 1);
  assert.equal(summary.no_machine_data, 0);
  assert.equal(summary.unknown_employee, 1);
  assert.equal(summary.missing_attendance, 1);
  assert.equal(summary.holiday_attendance, 1);
});
