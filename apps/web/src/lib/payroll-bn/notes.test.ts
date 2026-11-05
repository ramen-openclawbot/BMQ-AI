// Ghi chú tests (2026-10-09).
//
// One shared builder feeds the draft table, the Excel/PDF export and the
// published payslips. It must reproduce the old adjustment text, add the
// short-shift dates with their credit and the chốt-lương reason, and never
// change any computed amount.
//
// The real T09 rows live in payroll-bn-t09-real.fixture.ts and must not change.

import assert from "node:assert/strict";
import test from "node:test";

import { computePayroll } from "./engine.ts";
import { buildPayrollNotes } from "./notes.ts";
import { buildPayrollExportRows } from "./export.ts";
import { buildPayslips } from "./payslip.ts";
import { rationalToNumber } from "./money.ts";
import { resolveRulesConfig } from "./rules-config.ts";
import { applyIssueReviews, type IssueReview } from "./issue-review.ts";
import {
  T09_REAL_EMPLOYEES,
  T09_REAL_ROWS,
} from "./payroll-bn-t09-real.fixture.ts";
import type {
  AdjustmentField,
  AttendanceRow,
  PayrollAdjustment,
  PayrollEmployee,
  PayrollPeriod,
} from "./types.ts";

const REAL_PERIOD: PayrollPeriod = {
  code: "T09.2026",
  name: "Kỳ lương tháng 09/2026 — Bếp BN (real rows)",
  dateFrom: "2026-09-01",
  dateTo: "2026-09-30",
  standardDaysByGroup: { "Bếp bánh": 26, "Kho BN": 26, "Văn phòng": 22 },
  defaultStandardDays: 26,
  holidays: ["2026-09-01", "2026-09-02"],
  rules: resolveRulesConfig(),
  status: "draft",
};

const LABELS: Record<AdjustmentField, string> = {
  work_days: "NC thực tế",
  paid_work_days: "NC tính lương",
  part_time_hours: "Giờ part-time",
  overtime_hours: "Giờ tăng ca",
  exclude_overtime: "Không tính tăng ca",
  exclude_holiday: "Không tính ngày lễ",
  net_pay: "Thực nhận",
};

function realLines(adjustments: PayrollAdjustment[] = []) {
  return computePayroll({
    period: REAL_PERIOD,
    employees: T09_REAL_EMPLOYEES,
    rows: T09_REAL_ROWS,
    adjustments,
  }).employees;
}

function review(
  overrides: Partial<IssueReview> &
    Pick<IssueReview, "employeeCode" | "workDate" | "issueCode" | "decision">,
): IssueReview {
  return { note: "Đã đối chiếu với quản lý", ...overrides };
}

function missingCheckOutNote(dates: string): string {
  return `Ngày công không được tính do không chấm công giờ ra: ${dates}. Vui lòng liên hệ cấp quản lý để giải trình. Nếu được duyệt, ngày lương sẽ được chuyển bù vào tháng sau.`;
}

test("real T09: An gets only the short-shift note, Trang only the chốt-lương note", () => {
  const lines = realLines();
  const notes = buildPayrollNotes(lines, [], LABELS);
  const an = lines.find((line) => line.employeeCode === "00025")!;
  const trang = lines.find((line) => line.employeeCode === "00011")!;

  assert.deepEqual(an.shortShiftDays, [{ date: "2026-09-02", credit: 0.5 }]);
  assert.deepEqual(notes.get("00025"), ["Ca ngắn: 02/09 (0,5 công)"]);

  assert.deepEqual(trang.shortShiftDays, []);
  assert.deepEqual(notes.get("00011"), ["Nghỉ việc trong kỳ: không tính ngày lễ, tăng ca"]);

  // Employees with no note are absent from the map.
  assert.equal(notes.size, 2);
});

test("an adjustment keeps its text and comes before the short-shift note", () => {
  const adjustments: PayrollAdjustment[] = [
    {
      employeeCode: "00025",
      field: "overtime_hours",
      value: 3,
      reason: "Theo bảng",
      actor: "owner@fixture",
      at: "2026-09-30T17:00:00+07:00",
    },
  ];
  const lines = realLines(adjustments);
  const notes = buildPayrollNotes(lines, adjustments, LABELS);
  assert.deepEqual(notes.get("00025"), ["Giờ tăng ca: Theo bảng", "Ca ngắn: 02/09 (0,5 công)"]);
});

test("a synthetic 3h shift is reported as 0 công", () => {
  const employee: PayrollEmployee = {
    code: "E1",
    name: "Test",
    group: "Bếp bánh",
    employmentType: "official",
    monthlySalary: 7_800_000,
    hourlyRate: null,
    allowance: null,
    overtimeRate: null,
    standardDaysOverride: null,
    startDate: null,
    endDate: null,
    terminated: false,
  };
  const rows: AttendanceRow[] = [
    {
      employeeCode: "E1",
      employeeName: "Test",
      date: "2026-09-03",
      checkIn: "08:00:00",
      checkOut: "11:00:00",
      department: null,
    },
  ];
  const lines = computePayroll({ period: REAL_PERIOD, employees: [employee], rows }).employees;

  assert.deepEqual(lines[0].shortShiftDays, [{ date: "2026-09-03", credit: 0 }]);
  assert.deepEqual(buildPayrollNotes(lines, [], LABELS).get("E1"), ["Ca ngắn: 03/09 (0 công)"]);
});

test("a manual actualWorkDays measure keeps shortShiftDays empty", () => {
  const lines = computePayroll({
    period: REAL_PERIOD,
    employees: T09_REAL_EMPLOYEES,
    rows: T09_REAL_ROWS,
    measures: { "00025": { actualWorkDays: { value: 24, source: "manual" } } },
  }).employees;
  const an = lines.find((line) => line.employeeCode === "00025")!;

  assert.deepEqual(an.shortShiftDays, []);
  assert.equal(buildPayrollNotes(lines, [], LABELS).get("00025"), undefined);
});


test("internal T09 reconciliation reference is hidden without changing audit or amounts", () => {
  const adjustments: PayrollAdjustment[] = ["00025", "00011", "00024"].map((employeeCode) => ({
    employeeCode, field: "overtime_hours", value: 3,
    reason: "Theo bảng lương DIEU CHINH T09", actor: "owner@fixture", at: "2026-09-30T17:00:00+07:00",
  }));
  const before = structuredClone(adjustments);
  const result = computePayroll({ period: REAL_PERIOD, employees: T09_REAL_EMPLOYEES, rows: T09_REAL_ROWS, adjustments });
  const resultBefore = structuredClone(result);
  const notes = buildPayrollNotes(result.employees, adjustments, LABELS);
  assert.deepEqual(notes.get("00025"), ["Ca ngắn: 02/09 (0,5 công)"]);
  assert.deepEqual(notes.get("00011"), ["Nghỉ việc trong kỳ: không tính ngày lễ, tăng ca"]);
  assert.equal(notes.has("00024"), false);
  const withoutNotes = buildPayrollExportRows(REAL_PERIOD, result, new Map());
  const withNotes = buildPayrollExportRows(REAL_PERIOD, result, notes);
  assert.deepEqual(withNotes.map((row) => row.slice(0, 14)), withoutNotes.map((row) => row.slice(0, 14)));
  assert.equal(JSON.stringify(withNotes).includes("DIEU CHINH"), false);
  const payslips = buildPayslips(REAL_PERIOD, T09_REAL_EMPLOYEES, result, notes);
  assert.equal(JSON.stringify(payslips).includes("DIEU CHINH"), false);
  assert.deepEqual(payslips.map(({ note, ...rest }) => rest), buildPayslips(REAL_PERIOD, T09_REAL_EMPLOYEES, result).map(({ note, ...rest }) => rest));
  assert.deepEqual(adjustments, before);
  assert.deepEqual(result, resultBefore);
});

test("meaningful overtime reasons and other adjustment fields remain visible", () => {
  const adjustments: PayrollAdjustment[] = [
    { employeeCode: "00025", field: "overtime_hours", value: 3, reason: "Bổ sung 30 phút tăng ca ngày 05/09", actor: "owner@fixture", at: "2026-09-30" },
    { employeeCode: "00025", field: "net_pay", value: 1000, reason: "Theo bảng lương DIEU CHINH T09", actor: "owner@fixture", at: "2026-09-30" },
  ];
  assert.deepEqual(buildPayrollNotes(realLines(), adjustments, LABELS).get("00025"), [
    "Giờ tăng ca: Bổ sung 30 phút tăng ca ngày 05/09",
    "Thực nhận: Theo bảng lương DIEU CHINH T09",
    "Ca ngắn: 02/09 (0,5 công)",
  ]);
});

test("excluded missing check-out days add one note per employee with dates in ascending order", () => {
  const reviews: IssueReview[] = [
    review({ employeeCode: "00025", workDate: "2026-09-05", issueCode: "missing_check_out", decision: "excluded" }),
    review({ employeeCode: "00025", workDate: "2026-09-03", issueCode: "missing_check_out", decision: "excluded" }),
    review({ employeeCode: "00011", workDate: "2026-09-04", issueCode: "missing_check_out", decision: "excluded" }),
  ];
  const notes = buildPayrollNotes(realLines(), [], LABELS, reviews);

  // One merged note, after the short-shift note and before the left-in-period note.
  assert.deepEqual(notes.get("00025"), [
    "Ca ngắn: 02/09 (0,5 công)",
    missingCheckOutNote("03/09, 05/09"),
  ]);
  assert.deepEqual(notes.get("00011"), [
    missingCheckOutNote("04/09"),
    "Nghỉ việc trong kỳ: không tính ngày lễ, tăng ca",
  ]);
});

test("accepted missing check-out and other excluded issue codes add no note", () => {
  const reviews: IssueReview[] = [
    review({ employeeCode: "00025", workDate: "2026-09-03", issueCode: "missing_check_out", decision: "accepted" }),
    review({ employeeCode: "00025", workDate: "2026-09-04", issueCode: "missing_check_in", decision: "excluded" }),
    review({ employeeCode: "00011", workDate: "2026-09-05", issueCode: "holiday_attendance", decision: "excluded" }),
  ];
  const lines = realLines();

  assert.deepEqual(
    buildPayrollNotes(lines, [], LABELS, reviews),
    buildPayrollNotes(lines, [], LABELS),
  );
});

test("no issue reviews keeps every existing note unchanged", () => {
  const adjustments: PayrollAdjustment[] = [
    { employeeCode: "00025", field: "overtime_hours", value: 3, reason: "Bổ sung tăng ca", actor: "owner@fixture", at: "2026-09-30" },
  ];
  const lines = realLines(adjustments);
  const withEmptyReviews = buildPayrollNotes(lines, adjustments, LABELS, []);
  const withoutArgument = buildPayrollNotes(lines, adjustments, LABELS);

  assert.deepEqual(withEmptyReviews, withoutArgument);
  assert.deepEqual(withEmptyReviews.get("00025"), [
    "Giờ tăng ca: Bổ sung tăng ca",
    "Ca ngắn: 02/09 (0,5 công)",
  ]);
  assert.deepEqual(withEmptyReviews.get("00011"), ["Nghỉ việc trong kỳ: không tính ngày lễ, tăng ca"]);
});

test("an employee whose attendance was fully excluded still keeps the missing check-out note", () => {
  const reviews: IssueReview[] = [
    review({ employeeCode: "E-ONLY", workDate: "2026-09-07", issueCode: "missing_check_out", decision: "excluded" }),
  ];

  assert.deepEqual(buildPayrollNotes([], [], LABELS, reviews).get("E-ONLY"), [missingCheckOutNote("07/09")]);
});

test("real attendance: excluding a missing check-out day lowers công and pay and writes the note to the export row", () => {
  const missingDay: AttendanceRow = {
    employeeCode: "00025",
    employeeName: "VinhAn",
    date: "2026-09-14",
    checkIn: "08:00:00",
    checkOut: null,
    department: null,
  };
  // Replace the fixture's empty 14/09 row with a real check-in-only punch.
  const rows = [
    ...T09_REAL_ROWS.filter(
      (row) => !(row.employeeCode === missingDay.employeeCode && row.date === missingDay.date),
    ),
    missingDay,
  ];
  const reviews: IssueReview[] = [
    review({ employeeCode: "00025", workDate: missingDay.date, issueCode: "missing_check_out", decision: "excluded" }),
  ];

  const before = computePayroll({ period: REAL_PERIOD, employees: T09_REAL_EMPLOYEES, rows });
  const after = computePayroll({
    period: REAL_PERIOD,
    employees: T09_REAL_EMPLOYEES,
    rows: applyIssueReviews(rows, reviews),
  });
  const beforeAn = before.employees.find((line) => line.employeeCode === "00025")!;
  const afterAn = after.employees.find((line) => line.employeeCode === "00025")!;

  assert.equal(rationalToNumber(beforeAn.actualWorkDays) - rationalToNumber(afterAn.actualWorkDays), 1);
  assert.ok(rationalToNumber(afterAn.dayPay) < rationalToNumber(beforeAn.dayPay));
  assert.ok(afterAn.netPayRounded < beforeAn.netPayRounded);

  const afterNotes = buildPayrollNotes(after.employees, [], LABELS, reviews);
  const afterRow = buildPayrollExportRows(REAL_PERIOD, after, afterNotes).find((row) => row[0] === "00025")!;
  assert.match(String(afterRow[15]), /Ngày công không được tính do không chấm công giờ ra: 14\/09\./);
  assert.match(String(afterRow[15]), /Vui lòng liên hệ cấp quản lý để giải trình\./);

  const beforeRow = buildPayrollExportRows(
    REAL_PERIOD,
    before,
    buildPayrollNotes(before.employees, [], LABELS),
  ).find((row) => row[0] === "00025")!;
  assert.equal(String(beforeRow[15]).includes("không chấm công giờ ra"), false);
});

test("accepted and excluded missing check-out days: only the excluded day is noted", () => {
  const acceptedDay: AttendanceRow = {
    employeeCode: "00025",
    employeeName: "VinhAn",
    date: "2026-09-14",
    checkIn: "08:00:00",
    checkOut: null,
    department: null,
  };
  const excludedDay: AttendanceRow = {
    ...acceptedDay,
    date: "2026-09-29",
  };
  const rows = [
    ...T09_REAL_ROWS.filter(
      (row) =>
        !(
          row.employeeCode === acceptedDay.employeeCode &&
          (row.date === acceptedDay.date || row.date === excludedDay.date)
        ),
    ),
    acceptedDay,
    excludedDay,
  ];
  const reviews: IssueReview[] = [
    review({ employeeCode: "00025", workDate: acceptedDay.date, issueCode: "missing_check_out", decision: "accepted" }),
    review({ employeeCode: "00025", workDate: excludedDay.date, issueCode: "missing_check_out", decision: "excluded" }),
  ];
  const filtered = applyIssueReviews(rows, reviews);

  assert.equal(filtered.some((row) => row.employeeCode === "00025" && row.date === acceptedDay.date), true);
  assert.equal(filtered.some((row) => row.employeeCode === "00025" && row.date === excludedDay.date), false);

  const before = computePayroll({ period: REAL_PERIOD, employees: T09_REAL_EMPLOYEES, rows });
  const after = computePayroll({ period: REAL_PERIOD, employees: T09_REAL_EMPLOYEES, rows: filtered });
  const beforeAn = before.employees.find((line) => line.employeeCode === "00025")!;
  const afterAn = after.employees.find((line) => line.employeeCode === "00025")!;
  assert.equal(rationalToNumber(beforeAn.actualWorkDays) - rationalToNumber(afterAn.actualWorkDays), 1);

  const note = buildPayrollNotes(after.employees, [], LABELS, reviews).get("00025")!.join("; ");
  assert.match(note, /29\/09/);
  assert.equal(note.includes("14/09"), false);
});

test("duplicate excluded reviews for the same date add that date only once", () => {
  const duplicate = review({
    employeeCode: "00025",
    workDate: "2026-09-14",
    issueCode: "missing_check_out",
    decision: "excluded",
  });
  const notes = buildPayrollNotes(realLines(), [], LABELS, [duplicate, { ...duplicate }]);

  assert.deepEqual(notes.get("00025"), [
    "Ca ngắn: 02/09 (0,5 công)",
    missingCheckOutNote("14/09"),
  ]);
  assert.equal((notes.get("00025")!.join("; ").match(/14\/09/g) ?? []).length, 1);
});

test("missing check-out dates across 30/09 and 01/10 are sorted chronologically", () => {
  const reviews: IssueReview[] = [
    review({ employeeCode: "00025", workDate: "2026-10-01", issueCode: "missing_check_out", decision: "excluded" }),
    review({ employeeCode: "00025", workDate: "2026-09-14", issueCode: "missing_check_out", decision: "excluded" }),
    review({ employeeCode: "00025", workDate: "2026-09-30", issueCode: "missing_check_out", decision: "excluded" }),
  ];

  assert.deepEqual(buildPayrollNotes(realLines(), [], LABELS, reviews).get("00025"), [
    "Ca ngắn: 02/09 (0,5 công)",
    missingCheckOutNote("14/09, 30/09, 01/10"),
  ]);
});
