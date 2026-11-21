// Owner 2026-11-24 — holiday 24/11:
//   * official employees keep exactly one paid holiday (R9) plus the worked
//     day credited by the short-shift rule: 3h → 0, 4h → 0,5, 8h → 1;
//   * part-time hours read from the machine double the holiday hours when
//     `holidayWorkDouble` is on; manual figures and adjustments still win.
//
// The official scenarios use the same normal days in every case, so only the
// holiday credit differs between shifts.

import assert from "node:assert/strict";
import test from "node:test";

import { aggregateAttendance, computePayroll } from "./engine.ts";
import { rational, rationalFromNumber } from "./money.ts";
import { resolveRulesConfig } from "./rules-config.ts";
import type {
  AttendanceRow,
  PayrollAdjustment,
  PayrollEmployee,
  PayrollEmployeeLine,
  PayrollPeriod,
} from "./types.ts";

const NORMAL_DATES = ["2026-11-02", "2026-11-03", "2026-11-04"];
const HOLIDAY = "2026-11-24";

const PERIOD: PayrollPeriod = {
  code: "T11.2026",
  name: "Kỳ lương tháng 11/2026 — Bếp BN",
  dateFrom: "2026-11-01",
  dateTo: "2026-11-30",
  standardDaysByGroup: { "Bếp bánh": 26 },
  defaultStandardDays: 26,
  holidays: [HOLIDAY],
  rules: resolveRulesConfig(),
  status: "draft",
};

const OFFICIAL: PayrollEmployee = {
  code: "E1",
  name: "Chính thức",
  group: "Bếp bánh",
  employmentType: "official",
  monthlySalary: 7_800_000,
  hourlyRate: null,
  allowance: null,
  overtimeRate: null,
  startDate: "2025-01-01",
  endDate: null,
  terminated: false,
};

const PART_TIME: PayrollEmployee = {
  ...OFFICIAL,
  code: "PT1",
  name: "Part-time",
  employmentType: "part_time",
  monthlySalary: null,
  hourlyRate: 50_000,
};

function rowAt(date: string, checkIn: string | null, checkOut: string | null): AttendanceRow {
  return { employeeCode: "E1", employeeName: "Test", date, checkIn, checkOut, department: null };
}

function normalRows(): AttendanceRow[] {
  return NORMAL_DATES.map((date) => rowAt(date, "08:00:00", "16:00:00"));
}

function officialLine(holidayRow: AttendanceRow | null): PayrollEmployeeLine {
  const rows = holidayRow ? [...normalRows(), holidayRow] : normalRows();
  return computePayroll({
    period: PERIOD,
    employees: [OFFICIAL],
    rows,
  }).employees[0];
}

function partTimeLine(options: {
  holidayWorkDouble?: boolean;
  measures?: { partTimeHours: { value: number; source: "manual" | "attendance" } };
  adjustments?: PayrollAdjustment[];
  rows?: AttendanceRow[];
} = {}): PayrollEmployeeLine {
  const rules = resolveRulesConfig(
    options.holidayWorkDouble === undefined
      ? undefined
      : { holidayWorkDouble: options.holidayWorkDouble },
  );
  const rows = (options.rows ?? [
    rowAt("2026-11-02", "08:00:00", "16:00:00"),
    rowAt(HOLIDAY, "08:00:00", "16:00:00"),
  ]).map((row) => ({ ...row, employeeCode: "PT1" }));
  return computePayroll({
    period: { ...PERIOD, rules },
    employees: [{ ...PART_TIME }],
    rows,
    measures: options.measures ? { PT1: options.measures } : undefined,
    adjustments: options.adjustments,
  }).employees[0];
}

// ---------------------------------------------------------------------------
// Official employees: one paid holiday + the short-shift worked credit
// ---------------------------------------------------------------------------

test("official holiday 24/11: a day off is one paid holiday and no worked credit", () => {
  const line = officialLine(null);
  assert.deepEqual(line.actualWorkDays, rational(3));
  assert.deepEqual(line.holidayPayDays, rational(1));
  assert.deepEqual(line.workDays, rational(4));
  assert.equal(line.flags.includes("holiday_hours_double"), false);
});

test("official holiday 24/11: 3h works adds no credit (holiday total 1)", () => {
  const line = officialLine(rowAt(HOLIDAY, "08:00:00", "11:00:00"));
  assert.deepEqual(line.actualWorkDays, rational(3));
  assert.deepEqual(line.holidayPayDays, rational(1));
  assert.deepEqual(line.workDays, rational(4));
});

test("official holiday 24/11: 4h works counts 0,5 + the holiday = 1,5", () => {
  const line = officialLine(rowAt(HOLIDAY, "08:00:00", "12:00:00"));
  assert.deepEqual(line.actualWorkDays, rational(7, 2));
  assert.deepEqual(line.holidayPayDays, rational(1));
  assert.deepEqual(line.workDays, rational(9, 2));
  assert.ok(line.flags.includes("short_shift"));
});

test("official holiday 24/11: 8h works counts 1 + the holiday = 2", () => {
  const line = officialLine(rowAt(HOLIDAY, "08:00:00", "16:00:00"));
  assert.deepEqual(line.actualWorkDays, rational(4));
  assert.deepEqual(line.holidayPayDays, rational(1));
  assert.deepEqual(line.workDays, rational(5));
});

// ---------------------------------------------------------------------------
// Part-time: holiday hours count double from attendance only
// ---------------------------------------------------------------------------

test("part-time holiday 24/11: holiday hours double after the lunch deduction", () => {
  const rows = [
    rowAt("2026-11-02", "08:00:00", "16:00:00"), // 8h − 1h lunch = 7h
    rowAt(HOLIDAY, "08:00:00", "16:00:00"), // 8h − 1h lunch = 7h
  ];
  const aggregate = aggregateAttendance(rows, PERIOD);
  assert.equal(aggregate.workedSeconds, 50_400n); // 14h total
  assert.equal(aggregate.holidayWorkedSeconds, 25_200n); // 7h of it on the holiday

  const line = partTimeLine();
  // 7h normal + 2 × 7h holiday = 21h.
  assert.deepEqual(line.partTimeHours, rational(21));
  assert.deepEqual(line.partTimePay, rationalFromNumber(1_050_000));
  assert.deepEqual(line.workDays, rational(0));
  assert.ok(line.flags.includes("holiday_hours_double"));
});

test("part-time holiday 24/11: holidayWorkDouble off keeps the plain attendance hours", () => {
  const line = partTimeLine({ holidayWorkDouble: false });
  assert.deepEqual(line.partTimeHours, rational(14));
  assert.deepEqual(line.partTimePay, rationalFromNumber(700_000));
  assert.equal(line.flags.includes("holiday_hours_double"), false);
});

test("part-time holiday 24/11: a manual part_time_hours figure is not doubled", () => {
  const manual = partTimeLine({
    measures: { partTimeHours: { value: 10, source: "manual" } },
  });
  assert.deepEqual(manual.partTimeHours, rational(10));
  assert.equal(manual.flags.includes("holiday_hours_double"), false);

  const adjusted = partTimeLine({
    adjustments: [
      {
        employeeCode: "PT1",
        field: "part_time_hours",
        value: 12,
        reason: "Điều chỉnh giờ",
        actor: "test",
        at: "2026-11-24T01:00:00.000Z",
      },
    ],
  });
  assert.deepEqual(adjusted.partTimeHours, rational(12));
  assert.deepEqual(adjusted.partTimePay, rationalFromNumber(600_000));
  assert.ok(adjusted.flags.includes("part_time_hours_adjusted"));
  assert.equal(adjusted.flags.includes("holiday_hours_double"), false);
});
