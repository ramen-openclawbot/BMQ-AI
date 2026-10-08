import assert from "node:assert/strict";
import test from "node:test";

import {
  mapAdjustmentRow,
  mapAttendanceRow,
  mapEmployeeRow,
  mapPeriodRow,
  normalizePeriodStatus,
  toAdjustmentInsertRow,
  toAttendancePayloadRow,
  toEmployeeUpsertRow,
  toPeriodInsertRow,
} from "./db-mapping.ts";
import type {
  PayrollBnAdjustmentRow,
  PayrollBnAttendanceRow,
  PayrollBnEmployeeRow,
  PayrollBnPeriodInput,
  PayrollBnPeriodRow,
} from "./db-mapping.ts";
import type { AttendanceRow, PayrollEmployee } from "./types.ts";

function periodRow(overrides: Partial<PayrollBnPeriodRow> = {}): PayrollBnPeriodRow {
  return {
    id: "period-1",
    period_code: "T08.2026",
    period_name: "Tháng 8/2026",
    date_from: "2026-08-01",
    date_to: "2026-08-31",
    default_standard_days: "26.00",
    standard_days_by_group: { "Văn phòng": "22", "Bếp bánh": 27, "Kho BN": 27.0 },
    holidays: ["2026-08-15"],
    rules_config: { holidayPaid: false, plusOneDay: { enabled: true, days: 2 } },
    status: "locked",
    ...overrides,
  };
}

function employeeRow(overrides: Partial<PayrollBnEmployeeRow> = {}): PayrollBnEmployeeRow {
  return {
    id: "employee-1",
    period_id: "period-1",
    employee_code: "E01",
    employee_name: "Nguyễn Văn A",
    group_name: "Bếp bánh",
    employment_type: "official",
    monthly_salary: "10000000.00",
    hourly_rate: null,
    overtime_rate: 30000,
    allowance: 500000,
    standard_days_override: "26.50",
    start_date: "2025-01-01",
    end_date: null,
    ...overrides,
  };
}

function attendanceRow(overrides: Partial<PayrollBnAttendanceRow> = {}): PayrollBnAttendanceRow {
  return {
    id: "row-1",
    import_id: "import-1",
    period_id: "period-1",
    employee_code: "E01",
    employee_name: "Nguyễn Văn A",
    work_date: "2026-08-03",
    check_in: "08:00:00",
    check_out: "17:30:00",
    department: "Bếp bánh",
    ...overrides,
  };
}

function adjustmentRow(overrides: Partial<PayrollBnAdjustmentRow> = {}): PayrollBnAdjustmentRow {
  return {
    id: "adjustment-1",
    period_id: "period-1",
    employee_code: "E01",
    field: "work_days",
    old_value: 25,
    new_value: 26.5,
    reason: "Chốt lương",
    actor: "12345678-90ab-cdef-1234-567890abcdef",
    created_at: "2026-09-01T03:04:05.000Z",
    ...overrides,
  };
}

test("mapPeriodRow reads the period parameters and merges rules over defaults", () => {
  const period = mapPeriodRow(periodRow());

  assert.equal(period.code, "T08.2026");
  assert.equal(period.name, "Tháng 8/2026");
  assert.equal(period.dateFrom, "2026-08-01");
  assert.equal(period.dateTo, "2026-08-31");
  assert.equal(period.defaultStandardDays, 26);
  assert.deepEqual(period.standardDaysByGroup, { "Văn phòng": 22, "Bếp bánh": 27, "Kho BN": 27 });
  assert.deepEqual(period.holidays, ["2026-08-15"]);
  assert.equal(period.status, "locked");
  // partial config keeps safe defaults for everything not provided
  assert.equal(period.rules.holidayPaid, false);
  assert.equal(period.rules.plusOneDay.enabled, true);
  assert.equal(period.rules.plusOneDay.days, 2);
  assert.equal(period.rules.attendanceDays, true);
  assert.equal(period.rules.deductHour.enabled, false);
});

test("mapPeriodRow tolerates missing jsonb/numeric columns", () => {
  const period = mapPeriodRow(
    periodRow({
      default_standard_days: null,
      standard_days_by_group: null,
      holidays: null,
      rules_config: null,
      status: "something-else",
    }),
  );

  assert.equal(period.defaultStandardDays, 26);
  assert.deepEqual(period.standardDaysByGroup, {});
  assert.deepEqual(period.holidays, []);
  assert.equal(period.status, "draft");
  assert.equal(period.rules.attendanceDays, true);
});

test("normalizePeriodStatus only treats locked as locked", () => {
  assert.equal(normalizePeriodStatus("locked"), "locked");
  assert.equal(normalizePeriodStatus("draft"), "draft");
  assert.equal(normalizePeriodStatus(null), "draft");
});

test("mapEmployeeRow maps money as DB numbers and flags a terminated employee", () => {
  const active = mapEmployeeRow(employeeRow(), "2026-08-01");
  assert.equal(active.code, "E01");
  assert.equal(active.name, "Nguyễn Văn A");
  assert.equal(active.group, "Bếp bánh");
  assert.equal(active.employmentType, "official");
  assert.equal(active.monthlySalary, 10000000);
  assert.equal(active.hourlyRate, null);
  assert.equal(active.overtimeRate, 30000);
  assert.equal(active.allowance, 500000);
  assert.equal(active.standardDaysOverride, 26.5);
  assert.equal(active.startDate, "2025-01-01");
  assert.equal(active.endDate, null);
  assert.equal(active.terminated, false);

  // end_date strictly before the period start means they already left
  const terminated = mapEmployeeRow(employeeRow({ end_date: "2026-07-31" }), "2026-08-01");
  assert.equal(terminated.terminated, true);

  // last working day is the first day of the period: still in the period
  const lastDay = mapEmployeeRow(employeeRow({ end_date: "2026-08-01" }), "2026-08-01");
  assert.equal(lastDay.terminated, false);
});

test("mapEmployeeRow defaults a missing group and an unknown employment type", () => {
  const employee = mapEmployeeRow(
    employeeRow({ group_name: null, employment_type: "unknown" }),
    "2026-08-01",
  );
  assert.equal(employee.group, "Bếp bánh");
  assert.equal(employee.employmentType, "official");
});

test("mapAttendanceRow keeps the normalised times and falls back to an empty name", () => {
  const row = mapAttendanceRow(attendanceRow());
  assert.deepEqual(row, {
    employeeCode: "E01",
    employeeName: "Nguyễn Văn A",
    date: "2026-08-03",
    checkIn: "08:00:00",
    checkOut: "17:30:00",
    department: "Bếp bánh",
  });

  const empty = mapAttendanceRow(
    attendanceRow({ employee_name: null, check_in: null, check_out: "", department: null }),
  );
  assert.equal(empty.employeeName, "");
  assert.equal(empty.checkIn, null);
  assert.equal(empty.checkOut, null);
  assert.equal(empty.department, null);
});

test("mapAdjustmentRow shortens the actor id and maps both values", () => {
  const adjustment = mapAdjustmentRow(adjustmentRow());
  assert.equal(adjustment.employeeCode, "E01");
  assert.equal(adjustment.field, "work_days");
  assert.equal(adjustment.value, 26.5);
  assert.equal(adjustment.oldValue, 25);
  assert.equal(adjustment.reason, "Chốt lương");
  assert.equal(adjustment.actor, "12345678");
  assert.equal(adjustment.at, "2026-09-01T03:04:05.000Z");

  const valueless = mapAdjustmentRow(
    adjustmentRow({ field: "exclude_holiday", new_value: null, old_value: null, actor: null }),
  );
  assert.equal(valueless.field, "exclude_holiday");
  assert.equal(valueless.value, null);
  assert.equal(valueless.oldValue, null);
  assert.equal(valueless.actor, "");
});

test("mapAdjustmentRow rejects an unknown adjustment field", () => {
  assert.throws(() => mapAdjustmentRow(adjustmentRow({ field: "made_up" })), /không hợp lệ/);
});

test("toPeriodInsertRow builds the insert payload for createPeriod", () => {
  const input: PayrollBnPeriodInput = {
    code: "T10.2026",
    name: "Tháng 10/2026",
    dateFrom: "2026-10-01",
    dateTo: "2026-10-31",
    standardDaysByGroup: { "Văn phòng": 22, "Bếp bánh": 27, "Kho BN": 27 },
    holidays: ["2026-10-01"],
  };

  assert.deepEqual(toPeriodInsertRow(input), {
    period_code: "T10.2026",
    period_name: "Tháng 10/2026",
    date_from: "2026-10-01",
    date_to: "2026-10-31",
    standard_days_by_group: { "Văn phòng": 22, "Bếp bánh": 27, "Kho BN": 27 },
    holidays: ["2026-10-01"],
  });
});

test("toEmployeeUpsertRow maps a catalogue row and never writes daily_rate", () => {
  const employee: PayrollEmployee = {
    code: "E01",
    name: "Nguyễn Văn A",
    group: "Bếp bánh",
    employmentType: "official",
    monthlySalary: 10000000,
    hourlyRate: null,
    overtimeRate: 30000,
    allowance: 500000,
    standardDaysOverride: 26.5,
    startDate: "2025-01-01",
    endDate: null,
  };

  const row = toEmployeeUpsertRow("period-1", employee);
  assert.deepEqual(row, {
    period_id: "period-1",
    employee_code: "E01",
    employee_name: "Nguyễn Văn A",
    group_name: "Bếp bánh",
    employment_type: "official",
    monthly_salary: 10000000,
    hourly_rate: null,
    overtime_rate: 30000,
    allowance: 500000,
    standard_days_override: 26.5,
    start_date: "2025-01-01",
    end_date: null,
  });
  assert.equal("daily_rate" in row, false);
});

test("toAttendancePayloadRow and toAdjustmentInsertRow build write payloads", () => {
  const attendance: AttendanceRow = {
    employeeCode: "E01",
    employeeName: "",
    date: "2026-08-03",
    checkIn: "08:00:00",
    checkOut: null,
    department: null,
  };
  assert.deepEqual(toAttendancePayloadRow(attendance), {
    employee_code: "E01",
    employee_name: null,
    work_date: "2026-08-03",
    check_in: "08:00:00",
    check_out: null,
    department: null,
  });

  assert.deepEqual(
    toAdjustmentInsertRow("period-1", {
      employeeCode: "E01",
      field: "exclude_overtime",
      value: null,
      reason: "Chốt lương",
    }),
    {
      period_id: "period-1",
      employee_code: "E01",
      field: "exclude_overtime",
      new_value: null,
      reason: "Chốt lương",
    },
  );
});

test("toAdjustmentInsertRow keeps the previous value for the audit log", () => {
  assert.deepEqual(
    toAdjustmentInsertRow("period-1", {
      employeeCode: "E01",
      field: "work_days",
      value: 24.5,
      oldValue: 25,
      reason: "Điều chỉnh tay",
    }),
    {
      period_id: "period-1",
      employee_code: "E01",
      field: "work_days",
      old_value: 25,
      new_value: 24.5,
      reason: "Điều chỉnh tay",
    },
  );
});
