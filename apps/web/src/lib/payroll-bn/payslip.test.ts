import assert from "node:assert/strict";
import test from "node:test";

import { computePayroll } from "./engine.ts";
import { buildPayrollExportRows } from "./export.ts";
import { buildPayrollNotes } from "./notes.ts";
import { buildPayslips, toPublishPayload } from "./payslip.ts";
import { PAYROLL_EXPORT_HEADER } from "./export.ts";
import { T08_FIXTURE, T08_GROUP_TOTALS } from "./payroll-bn-t08.fixture.ts";
import { T09_FIXTURE, T09_GROUP_TOTALS } from "./payroll-bn-t09.fixture.ts";
import type { PayrollBnFixture } from "./fixture-helpers.ts";
import type { IssueReview } from "./issue-review.ts";
import type { AdjustmentField } from "./types.ts";

const ADJUSTMENT_LABELS: Record<AdjustmentField, string> = {
  work_days: "NC thực tế",
  paid_work_days: "NC tính lương",
  part_time_hours: "Giờ part-time",
  overtime_hours: "Giờ tăng ca",
  exclude_overtime: "Không tính tăng ca",
  exclude_holiday: "Không tính ngày lễ",
  net_pay: "Thực nhận",
};

function notesFor(fixture: PayrollBnFixture): Map<string, string[]> {
  const notes = new Map<string, string[]>();
  for (const item of fixture.adjustments) {
    notes.set(item.employeeCode, [...(notes.get(item.employeeCode) ?? []), item.reason]);
  }
  return notes;
}

function compute(fixture: PayrollBnFixture) {
  return computePayroll({
    period: fixture.period,
    employees: fixture.employees,
    measures: fixture.measures,
    adjustments: fixture.adjustments,
  });
}

function exportRows(fixture: PayrollBnFixture) {
  return buildPayrollExportRows(fixture.period, compute(fixture), notesFor(fixture));
}

function buildFor(fixture: PayrollBnFixture) {
  const result = compute(fixture);
  return buildPayslips(fixture.period, fixture.employees, result, notesFor(fixture));
}

test("T09 payslips sum to the engine net total and match the export rows", () => {
  const payslips = buildFor(T09_FIXTURE);
  assert.equal(payslips.length, T09_FIXTURE.employees.length);

  const sum = payslips.reduce((total, payslip) => total + payslip.net_pay, 0);
  assert.equal(sum, T09_GROUP_TOTALS.totalNet);

  const rows = exportRows(T09_FIXTURE);
  for (const payslip of payslips) {
    const row = rows.find((item) => item[0] === payslip.employee_code);
    assert.ok(row, `missing export row for ${payslip.employee_code}`);
    assert.equal(payslip.net_pay, row![14], `net pay mismatch for ${payslip.employee_code}`);
    assert.equal(payslip.employee_name, row![1]);
  }
});

test("T08 payslips sum to the engine net total and match the export rows", () => {
  const payslips = buildFor(T08_FIXTURE);
  const sum = payslips.reduce((total, payslip) => total + payslip.net_pay, 0);
  assert.equal(sum, T08_GROUP_TOTALS.totalNet);

  const rows = exportRows(T08_FIXTURE);
  for (const payslip of payslips) {
    const row = rows.find((item) => item[0] === payslip.employee_code);
    assert.ok(row, `missing export row for ${payslip.employee_code}`);
    assert.equal(payslip.net_pay, row![14], `net pay mismatch for ${payslip.employee_code}`);
  }
});

test("payslips never contain NaN or Infinity", () => {
  for (const fixture of [T08_FIXTURE, T09_FIXTURE]) {
    for (const payslip of buildFor(fixture)) {
      assert.ok(Number.isFinite(payslip.net_pay), `net pay for ${payslip.employee_code}`);
      for (const item of payslip.lines) {
        assert.ok(Number.isFinite(item.value), `${item.key} for ${payslip.employee_code}`);
      }
    }
  }
});

test("part-time lines appear only for part-time employees", () => {
  const payslips = buildFor(T09_FIXTURE);
  for (const payslip of payslips) {
    const employee = T09_FIXTURE.employees.find((item) => item.code === payslip.employee_code)!;
    const keys = payslip.lines.map((item) => item.key);
    assert.deepEqual(keys.slice(0, 4), ["standard_days", "actual_work_days", "holiday_pay_days", "work_days"]);
    // No mission bonus in these fixtures → no mission_bonus line at all.
    assert.deepEqual(keys.at(-1), "gross_pay");
    assert.ok(!keys.includes("mission_bonus"));
    if (employee.employmentType === "part_time") {
      assert.ok(keys.includes("part_time_hours"));
      assert.ok(keys.includes("part_time_pay"));
    } else {
      assert.ok(!keys.includes("part_time_hours"));
      assert.ok(!keys.includes("part_time_pay"));
    }
  }
});

test("lines carry the exact portal labels and units", () => {
  const payslip = buildFor(T09_FIXTURE)[0];
  const expected = [
    ["standard_days", "Ngày công chuẩn", "day"],
    ["actual_work_days", "Ngày công thực tế", "day"],
    ["holiday_pay_days", "Ngày lễ hưởng lương", "day"],
    ["work_days", "Ngày công tính lương", "day"],
    ["overtime_hours", "Giờ tăng ca", "hour"],
    ["day_pay", "Lương ngày công", "vnd"],
    ["overtime_pay", "Lương tăng ca", "vnd"],
    ["allowance", "Phụ cấp", "vnd"],
    ["gross_pay", "Tổng thu nhập", "vnd"],
  ];
  assert.deepEqual(
    payslip.lines.map((item) => [item.key, item.label, item.unit]),
    expected,
  );
  // The header index matches what the tests above rely on.
  assert.equal(PAYROLL_EXPORT_HEADER[14], "Thực nhận");
});

test("toPublishPayload round-trips the payslips", () => {
  const payslips = buildFor(T09_FIXTURE);
  assert.deepEqual(toPublishPayload(payslips), payslips);
});

test("excluded missing check-out reaches the payslip note without changing pay", () => {
  const result = compute(T09_FIXTURE);
  const reviews: IssueReview[] = [
    {
      employeeCode: "BN03",
      workDate: "2026-09-03",
      issueCode: "missing_check_out",
      decision: "excluded",
      note: "Đã đối chiếu với quản lý",
    },
  ];
  const notes = buildPayrollNotes(result.employees, T09_FIXTURE.adjustments, ADJUSTMENT_LABELS, reviews);
  const payslips = buildPayslips(T09_FIXTURE.period, T09_FIXTURE.employees, result, notes);
  const an = payslips.find((payslip) => payslip.employee_code === "BN03")!;

  assert.match(
    an.note ?? "",
    /Ngày công không được tính do không chấm công giờ ra: 03\/09\. Vui lòng liên hệ cấp quản lý để giải trình\. Nếu được duyệt, ngày lương sẽ được chuyển bù vào tháng sau\./,
  );
  assert.equal(payslips.reduce((total, payslip) => total + payslip.net_pay, 0), T09_GROUP_TOTALS.totalNet);
  // Adding a note changes no amount and no payslip line.
  assert.deepEqual(
    payslips.map(({ note: _note, ...rest }) => rest),
    buildPayslips(T09_FIXTURE.period, T09_FIXTURE.employees, result).map(({ note: _note, ...rest }) => rest),
  );
});
