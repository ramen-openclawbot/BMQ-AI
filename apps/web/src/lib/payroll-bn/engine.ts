// Bếp BN payroll engine (R1–R9).
//
// Every amount is an exact BigInt fraction until the final net-pay rounding
// (R5). The engine is pure: it takes a period, an employee catalogue, parsed
// attendance rows, per-employee measures and explicit adjustments, and returns
// payroll lines plus group/total rows. It never logs or returns raw money to a
// logger.
//
// Two input modes coexist:
//   (a) direct  — the payroll sheet gives actual work days / part-time hours /
//                 overtime hours (`source: "manual"`), used for T08/T09.
//   (b) attendance — quantities are derived from the parsed rows (H1/H2), used
//                 for reconciliation. Attendance overtime is reported, not paid
//                 (Q3) unless the period explicitly enables apply mode.

import {
  addRational,
  compareRational,
  divRational,
  isZeroRational,
  mulRational,
  rational,
  rationalFromNumber,
  RATIONAL_ZERO,
  roundVndToThousand,
  subRational,
  sumRational,
  toRational,
  type Rational,
} from "./money.ts";
import { resolveRulesConfig, type RulesConfig } from "./rules-config.ts";
import type {
  AttendanceRow,
  MeasureSource,
  PayrollAdjustment,
  PayrollEmployee,
  PayrollEmployeeLine,
  PayrollEmployeeMeasures,
  PayrollGroup,
  PayrollGroupLine,
  PayrollLine,
  PayrollLineBase,
  PayrollPeriod,
  PayrollResult,
  PayrollTotalLine,
  SourcedQuantity,
} from "./types.ts";

export interface PayrollComputationInput {
  period: PayrollPeriod;
  employees: readonly PayrollEmployee[];
  /** Parsed attendance rows (mode b / reconciliation). */
  rows?: readonly AttendanceRow[];
  /** Direct per-employee figures from the payroll sheet (mode a). */
  measures?: Record<string, PayrollEmployeeMeasures>;
  adjustments?: readonly PayrollAdjustment[];
}

export interface AttendanceAggregate {
  dates: string[];
  nonHolidayDates: string[];
  holidayDates: string[];
  workedSeconds: bigint;
  /** Seconds above the standard day, used for reconciliation (Q3). */
  overtimeSeconds: bigint;
}

function timeToSeconds(value: string | null): number | null {
  if (!value) return null;
  const match = value.match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function daySeconds(row: AttendanceRow): number {
  const checkIn = timeToSeconds(row.checkIn);
  const checkOut = timeToSeconds(row.checkOut);
  if (checkIn === null || checkOut === null) return 0;
  let diff = checkOut - checkIn;
  if (diff < 0) diff += 86400; // overnight shift
  return diff;
}

function uniqueDates(rows: readonly AttendanceRow[], holidaySet: Set<string>, holiday: boolean): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    if (holidaySet.has(row.date) !== holiday) continue;
    seen.add(row.date);
  }
  return [...seen].sort();
}

/** Aggregate one employee's rows exactly (integer seconds, no float hours). */
export function aggregateAttendance(
  rows: readonly AttendanceRow[],
  period: PayrollPeriod,
): AttendanceAggregate {
  const rules = resolveRulesConfig(period.rules);
  const holidaySet = new Set(period.holidays);
  const standardSeconds = Math.round(rules.standardHoursPerDay * 3600);
  const thresholdSeconds = rules.deductHour.enabled
    ? Math.round(rules.deductHour.thresholdHours * 3600)
    : 0;
  const deductSeconds = rules.deductHour.enabled
    ? Math.round(rules.deductHour.deductHours * 3600)
    : 0;

  // H1 counts days with at least one check. The machine export has a row for
  // every day of the month; a row without any time is a day off.
  const sorted = rows
    .filter((row) => Boolean(row.checkIn) || Boolean(row.checkOut))
    .sort((a, b) => a.date.localeCompare(b.date));
  let workedSeconds = 0;
  let overtimeSeconds = 0;

  for (const row of sorted) {
    const seconds = daySeconds(row);
    let effective = seconds;
    // H2 — a day long enough to include the break loses the break hour.
    if (rules.deductHour.enabled && seconds >= thresholdSeconds) {
      effective = Math.max(0, seconds - deductSeconds);
    }
    workedSeconds += effective;
    overtimeSeconds += Math.max(0, effective - standardSeconds);
  }

  return {
    dates: [...new Set(sorted.map((row) => row.date))].sort(),
    nonHolidayDates: uniqueDates(sorted, holidaySet, false),
    holidayDates: uniqueDates(sorted, holidaySet, true),
    workedSeconds: BigInt(workedSeconds),
    overtimeSeconds: BigInt(overtimeSeconds),
  };
}

function adjustmentToRational(value: number | string | bigint | null | undefined): Rational {
  if (value === null || value === undefined || value === "") return RATIONAL_ZERO;
  if (typeof value === "string") {
    const cleaned = value.trim().replace(/\s/g, "").replace(/\./g, "").replace(/,/g, ".");
    const parsed = Number(cleaned);
    if (!Number.isFinite(parsed)) return RATIONAL_ZERO;
    return rationalFromNumber(parsed);
  }
  return toRational(value);
}

function resolveStandardDays(period: PayrollPeriod, employee: PayrollEmployee): Rational {
  if (employee.standardDaysOverride !== null && employee.standardDaysOverride !== undefined) {
    return rationalFromNumber(employee.standardDaysOverride);
  }
  const groupDays = period.standardDaysByGroup?.[employee.group];
  if (groupDays !== null && groupDays !== undefined) return rationalFromNumber(groupDays);
  return rationalFromNumber(period.defaultStandardDays);
}

function findAdjustment(
  adjustments: readonly PayrollAdjustment[],
  employeeCode: string,
  field: PayrollAdjustment["field"],
): PayrollAdjustment | undefined {
  // Later rows win (the DB keeps an append-only log).
  let found: PayrollAdjustment | undefined;
  for (const item of adjustments) {
    if (item.employeeCode === employeeCode && item.field === field) found = item;
  }
  return found;
}

/**
 * Resolve one sourced quantity. Direct sheet figures (`manual`) win; a value
 * marked `attendance` is derived from the parsed rows when they exist.
 */
function resolveQuantity(
  measure: SourcedQuantity | undefined,
  hasAttendance: boolean,
  derived: () => Rational,
): { value: Rational; source: MeasureSource } {
  if (measure && !(measure.source === "attendance" && hasAttendance)) {
    return { value: rationalFromNumber(measure.value), source: measure.source };
  }
  return { value: derived(), source: "attendance" };
}

/**
 * R9 — holidays the employee was already working for (start_date ≤ holiday and
 * the employee has not left). Attendance on the holiday is irrelevant.
 */
function countEligibleHolidays(period: PayrollPeriod, employee: PayrollEmployee): number {
  if (employee.terminated) return 0;
  const start = employee.startDate ?? null;
  const end = employee.endDate ?? null;
  let count = 0;
  for (const holiday of period.holidays) {
    if (start && start > holiday) continue;
    if (end && end < holiday) continue;
    count += 1;
  }
  return count;
}

function isPartTime(employee: PayrollEmployee): boolean {
  return employee.employmentType === "part_time";
}

function zeroLineFields(): Omit<PayrollEmployeeLine, "kind" | "employeeCode" | "employeeName" | "group" | "employmentType"> {
  return {
    standardDays: RATIONAL_ZERO,
    actualWorkDays: RATIONAL_ZERO,
    holidayPayDays: RATIONAL_ZERO,
    workDays: RATIONAL_ZERO,
    partTimeHours: RATIONAL_ZERO,
    overtimeHours: RATIONAL_ZERO,
    overtimeAppliedHours: RATIONAL_ZERO,
    dayPay: RATIONAL_ZERO,
    partTimePay: RATIONAL_ZERO,
    overtimePay: RATIONAL_ZERO,
    overtimePayReconciled: RATIONAL_ZERO,
    allowance: RATIONAL_ZERO,
    grossPay: RATIONAL_ZERO,
    netPay: RATIONAL_ZERO,
    netPayRounded: 0n,
    flags: [],
  };
}

function buildEmployeeLine(
  period: PayrollPeriod,
  employee: PayrollEmployee,
  aggregate: AttendanceAggregate,
  measures: PayrollEmployeeMeasures | undefined,
  adjustments: readonly PayrollAdjustment[],
): PayrollEmployeeLine {
  const rules = period.rules;
  const base = zeroLineFields();
  const flags: string[] = [];
  const hasAttendance = aggregate.dates.length > 0;

  if (employee.terminated) {
    flags.push("terminated");
    return {
      kind: "employee",
      employeeCode: employee.code,
      employeeName: employee.name,
      group: employee.group,
      employmentType: employee.employmentType,
      ...base,
      flags,
    };
  }

  const standardDays = resolveStandardDays(period, employee);

  // --- NC thực tế -------------------------------------------------------
  const actualResolved = resolveQuantity(measures?.actualWorkDays, hasAttendance, () => {
    let days = rules.attendanceDays ? rational(aggregate.nonHolidayDates.length) : RATIONAL_ZERO;
    if (rules.plusOneDay.enabled && compareRational(days, RATIONAL_ZERO) > 0) {
      days = addRational(days, rationalFromNumber(rules.plusOneDay.days));
      flags.push("plus_one_day");
    }
    return days;
  });
  let actualWorkDays = actualResolved.value;

  // R7 — office staff are not on the attendance machine: without a sheet
  // figure or any attendance they default to the standard days, which already
  // cover the whole month, so no holiday is added on top.
  const officeDefault =
    employee.group === "Văn phòng" && !isPartTime(employee) && !measures?.actualWorkDays && !hasAttendance;
  if (officeDefault) {
    actualWorkDays = standardDays;
    flags.push("office_default_days");
  }

  // --- R9 số ngày lễ được cộng -----------------------------------------
  const eligibleHolidays = countEligibleHolidays(period, employee);
  let holidayPayDays =
    isPartTime(employee) || !rules.holidayPaid ? RATIONAL_ZERO : rational(eligibleHolidays);
  if (!isPartTime(employee) && eligibleHolidays < period.holidays.length) {
    flags.push("holiday_before_start");
  }
  if (findAdjustment(adjustments, employee.code, "exclude_holiday")) {
    holidayPayDays = RATIONAL_ZERO;
    flags.push("holiday_excluded");
  }
  if (officeDefault) holidayPayDays = RATIONAL_ZERO;

  // R8 — part-time is paid on the hour column; its day column stays empty.
  const partTime = isPartTime(employee);
  if (partTime) {
    actualWorkDays = RATIONAL_ZERO;
    holidayPayDays = RATIONAL_ZERO;
    flags.push("part_time_hours");
  }

  // NC tính lương = NC thực tế + ngày lễ (unless explicitly overridden).
  let workDays = partTime ? RATIONAL_ZERO : addRational(actualWorkDays, holidayPayDays);

  const workDaysAdjustment = findAdjustment(adjustments, employee.code, "work_days");
  if (workDaysAdjustment && !partTime) {
    actualWorkDays = adjustmentToRational(workDaysAdjustment.value);
    workDays = addRational(actualWorkDays, holidayPayDays);
    flags.push("work_days_adjusted");
  }
  const paidWorkDaysAdjustment = findAdjustment(adjustments, employee.code, "paid_work_days");
  if (paidWorkDaysAdjustment && !partTime) {
    workDays = adjustmentToRational(paidWorkDaysAdjustment.value);
    flags.push("paid_work_days_adjusted");
  }

  // --- R8 part-time hours ----------------------------------------------
  const partTimeResolved = resolveQuantity(measures?.partTimeHours, hasAttendance, () =>
    rational(aggregate.workedSeconds, 3600n),
  );
  let partTimeHours = partTimeResolved.value;
  const partTimeAdjustment = findAdjustment(adjustments, employee.code, "part_time_hours");
  if (partTimeAdjustment) {
    partTimeHours = adjustmentToRational(partTimeAdjustment.value);
    flags.push("part_time_hours_adjusted");
  }
  if (!partTime) partTimeHours = RATIONAL_ZERO;

  // --- R1 lương ngày công ----------------------------------------------
  const monthlySalary =
    employee.monthlySalary !== null && employee.monthlySalary !== undefined
      ? rationalFromNumber(employee.monthlySalary)
      : RATIONAL_ZERO;
  const dayPay =
    !partTime && !isZeroRational(standardDays)
      ? divRational(mulRational(monthlySalary, workDays), standardDays)
      : RATIONAL_ZERO;

  // --- R4 part-time pay -------------------------------------------------
  const hourlyRate =
    employee.hourlyRate !== null && employee.hourlyRate !== undefined
      ? rationalFromNumber(employee.hourlyRate)
      : RATIONAL_ZERO;
  const partTimePay = partTime ? mulRational(hourlyRate, partTimeHours) : RATIONAL_ZERO;

  // --- R3 tiền TC --------------------------------------------------------
  const overtimeResolved = resolveQuantity(measures?.overtimeHours, hasAttendance, () =>
    rational(aggregate.overtimeSeconds, 3600n),
  );
  let overtimeHours = overtimeResolved.value;
  const overtimeAdjustment = findAdjustment(adjustments, employee.code, "overtime_hours");
  if (overtimeAdjustment) {
    overtimeHours = adjustmentToRational(overtimeAdjustment.value);
    flags.push("overtime_hours_adjusted");
  }
  const overtimeRate =
    employee.overtimeRate !== null && employee.overtimeRate !== undefined
      ? rationalFromNumber(employee.overtimeRate)
      : RATIONAL_ZERO;
  const overtimePayComputed = mulRational(overtimeHours, overtimeRate); // R3: 0 without a rate

  // Overtime entered on the payroll sheet is paid; overtime read from the
  // attendance machine is only reported (Q3) unless explicitly enabled.
  const overtimeFromSheet = overtimeResolved.source === "manual" && !overtimeAdjustment;
  const officialNeedsApply =
    !overtimeFromSheet && !(rules.officialOvertime.enabled && rules.officialOvertime.mode === "apply");
  const excludeOvertime = Boolean(findAdjustment(adjustments, employee.code, "exclude_overtime"));
  const applyOvertime = !excludeOvertime && !officialNeedsApply;
  const overtimeAppliedHours = applyOvertime ? overtimeHours : RATIONAL_ZERO;
  // R3 — `overtimePay` is the amount actually paid (the payslip "tiền TC"
  // column). Overtime that is excluded or only reconciled is kept separately in
  // `overtimePayReconciled`, so it never inflates the group/total OT pay.
  const overtimePay = applyOvertime ? overtimePayComputed : RATIONAL_ZERO;
  const overtimePayReconciled = subRational(overtimePayComputed, overtimePay);
  if (!applyOvertime && !isZeroRational(overtimePayComputed)) {
    flags.push(excludeOvertime ? "overtime_excluded" : "overtime_reconcile_only");
  }

  // --- phụ cấp + gross/net ---------------------------------------------
  const allowance =
    employee.allowance !== null && employee.allowance !== undefined
      ? rationalFromNumber(employee.allowance)
      : RATIONAL_ZERO;

  const grossPay = addRational(
    addRational(addRational(dayPay, partTimePay), overtimePay),
    allowance,
  );

  let netPay = grossPay;
  const netAdjustment = findAdjustment(adjustments, employee.code, "net_pay");
  if (netAdjustment) {
    netPay = adjustmentToRational(netAdjustment.value);
    flags.push("net_pay_adjusted");
  }

  return {
    kind: "employee",
    employeeCode: employee.code,
    employeeName: employee.name,
    group: employee.group,
    employmentType: employee.employmentType,
    standardDays,
    actualWorkDays,
    holidayPayDays,
    workDays,
    partTimeHours,
    overtimeHours,
    overtimeAppliedHours,
    dayPay,
    partTimePay,
    overtimePay,
    overtimePayReconciled,
    allowance,
    grossPay,
    netPay,
    netPayRounded: roundVndToThousand(netPay),
    flags,
  };
}

const SUMMED_FIELDS: (keyof PayrollLineBase)[] = [
  "standardDays",
  "actualWorkDays",
  "holidayPayDays",
  "workDays",
  "partTimeHours",
  "overtimeHours",
  "overtimeAppliedHours",
  "dayPay",
  "partTimePay",
  "overtimePay",
  "overtimePayReconciled",
  "allowance",
  "grossPay",
  "netPay",
];

function sumLineBases(lines: readonly PayrollEmployeeLine[]): PayrollLineBase {
  const base = {} as PayrollLineBase;
  for (const field of SUMMED_FIELDS) {
    (base as unknown as Record<string, unknown>)[field] = sumRational(lines.map((line) => line[field] as Rational));
  }
  base.netPayRounded = lines.reduce((total, line) => total + line.netPayRounded, 0n);
  base.flags = [];
  return base;
}

function buildGroupLine(group: PayrollGroup, lines: readonly PayrollEmployeeLine[]): PayrollGroupLine {
  return {
    kind: "group",
    employeeCode: null,
    employeeName: null,
    group,
    employeeCount: lines.length,
    ...sumLineBases(lines),
  };
}

function buildTotalLine(lines: readonly PayrollEmployeeLine[]): PayrollTotalLine {
  return {
    kind: "total",
    employeeCode: null,
    employeeName: null,
    group: null,
    employeeCount: lines.length,
    ...sumLineBases(lines),
  };
}

/** Compute the payroll for one Bếp BN period. Pure and deterministic. */
export function computePayroll(input: PayrollComputationInput): PayrollResult {
  const period: PayrollPeriod = {
    ...input.period,
    rules: resolveRulesConfig(input.period.rules),
  };
  const adjustments = input.adjustments ?? [];
  const measures = input.measures ?? {};
  const rowsByEmployee = new Map<string, AttendanceRow[]>();
  for (const row of input.rows ?? []) {
    const list = rowsByEmployee.get(row.employeeCode) ?? [];
    list.push(row);
    rowsByEmployee.set(row.employeeCode, list);
  }

  const warnings: string[] = [];
  const employeeLines = input.employees.map((employee) => {
    const rows = rowsByEmployee.get(employee.code) ?? [];
    const employeeMeasures = measures[employee.code];
    if (rows.length === 0 && !employeeMeasures && !employee.terminated) {
      warnings.push(`employee_without_attendance:${employee.code}`);
    }
    return buildEmployeeLine(period, employee, aggregateAttendance(rows, period), employeeMeasures, adjustments);
  });

  const catalog = new Set(input.employees.map((employee) => employee.code));
  for (const code of rowsByEmployee.keys()) {
    if (!catalog.has(code)) warnings.push(`attendance_without_employee:${code}`);
  }

  const groupNames = Array.from(new Set(employeeLines.map((line) => line.group))).sort() as PayrollGroup[];
  const groupLines = groupNames.map((group) =>
    buildGroupLine(group, employeeLines.filter((line) => line.group === group)),
  );
  const total = buildTotalLine(employeeLines);

  const lines: PayrollLine[] = [...employeeLines, ...groupLines, total];
  return { periodCode: period.code, lines, employees: employeeLines, groups: groupLines, total, warnings };
}

/** R2 — the standard day count the engine uses for an employee. */
export function standardDaysFor(period: PayrollPeriod, employee: PayrollEmployee): Rational {
  return resolveStandardDays(period, employee);
}

/** R7/R8 — whether the employee is paid by the hour. */
export function isPartTimeEmployee(employee: PayrollEmployee): boolean {
  return isPartTime(employee);
}
