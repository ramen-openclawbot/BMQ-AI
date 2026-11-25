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
  /** Giao hàng — total delivery units per employee for the period. */
  deliveryUnits?: Record<string, number>;
  /** Giao hàng — total delivery extras (VND) per employee for the period. */
  deliveryExtras?: Record<string, number>;
}

export interface AttendanceAggregate {
  dates: string[];
  nonHolidayDates: string[];
  holidayDates: string[];
  workedSeconds: bigint;
  /** 2026-11-24 — portion of `workedSeconds` on period holidays, after the same deductions. */
  holidayWorkedSeconds: bigint;
  /** Seconds above the standard day, used for reconciliation (Q3). */
  overtimeSeconds: bigint;
  /** 2026-10-09 — exact công credited on non-holiday dates (short shift → 0,5/0). */
  nonHolidayDayCredit: Rational;
  /** 2026-10-09 — exact công credited on holiday dates (short shift → 0,5/0). */
  holidayDayCredit: Rational;
  /** Dates whose short-shift credit is below one full day (0,5 or 0). */
  shortShiftDates: string[];
  /** 2026-10-09 — per-date short-shift credit (0,5 or 0), one entry per affected date. */
  shortShiftDayCredits: Array<{ date: string; credit: 0 | 0.5 }>;
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
  // Q3 — official overtime per day = span − 9h, only when it reaches 15 minutes.
  const overtimeThresholdSeconds = Math.round(rules.officialOvertime.dailyThresholdHours * 3600);
  const overtimeMinimumSeconds = Math.round(rules.officialOvertime.minimumMinutes * 60);
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
  let holidayWorkedSeconds = 0;
  let overtimeSeconds = 0;

  // Owner 2026-10-09 — short shift: a full-span day earns one công, a half-span
  // day 0,5 and a very short day 0. A day with a single punch keeps the old
  // full credit (e.g. a missing check-out). Disabled → every date counts 1.
  const fullDaySeconds = Math.round(rules.shortShift.fullDayMinHours * 3600);
  const halfDaySeconds = Math.round(rules.shortShift.halfDayMinHours * 3600);
  const creditForRow = (row: AttendanceRow): Rational => {
    if (!rules.shortShift.enabled) return rational(1);
    if (!row.checkIn || !row.checkOut) return rational(1);
    const seconds = daySeconds(row);
    if (seconds >= fullDaySeconds) return rational(1);
    if (seconds >= halfDaySeconds) return rational(1, 2);
    return RATIONAL_ZERO;
  };
  const dayCredit = new Map<string, Rational>();
  for (const row of sorted) {
    const credit = creditForRow(row);
    const current = dayCredit.get(row.date);
    if (!current || compareRational(credit, current) > 0) dayCredit.set(row.date, credit);
  }

  for (const row of sorted) {
    const seconds = daySeconds(row);
    let effective = seconds;
    // H2 — a day long enough to include the break loses the break hour.
    if (rules.deductHour.enabled && seconds >= thresholdSeconds) {
      effective = Math.max(0, seconds - deductSeconds);
    }
    workedSeconds += effective;
    if (holidaySet.has(row.date)) holidayWorkedSeconds += effective;
    const extra = seconds - overtimeThresholdSeconds;
    if (extra > 0 && extra >= overtimeMinimumSeconds) overtimeSeconds += extra;
  }

  const dates = [...new Set(sorted.map((row) => row.date))].sort();
  let nonHolidayDayCredit = RATIONAL_ZERO;
  let holidayDayCredit = RATIONAL_ZERO;
  const shortShiftDates: string[] = [];
  const shortShiftDayCredits: Array<{ date: string; credit: 0 | 0.5 }> = [];
  for (const date of dates) {
    const credit = dayCredit.get(date) ?? rational(1);
    if (holidaySet.has(date)) {
      holidayDayCredit = addRational(holidayDayCredit, credit);
    } else {
      nonHolidayDayCredit = addRational(nonHolidayDayCredit, credit);
    }
    if (compareRational(credit, rational(1)) < 0) {
      shortShiftDates.push(date);
      shortShiftDayCredits.push({ date, credit: isZeroRational(credit) ? 0 : 0.5 });
    }
  }

  return {
    dates,
    nonHolidayDates: uniqueDates(sorted, holidaySet, false),
    holidayDates: uniqueDates(sorted, holidaySet, true),
    workedSeconds: BigInt(workedSeconds),
    holidayWorkedSeconds: BigInt(holidayWorkedSeconds),
    overtimeSeconds: BigInt(overtimeSeconds),
    nonHolidayDayCredit,
    holidayDayCredit,
    shortShiftDates,
    shortShiftDayCredits,
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

/** Giao hàng rows use the delivery formula instead of R1–R9. */
function isDelivery(employee: PayrollEmployee): boolean {
  return employee.employmentType === "delivery" || employee.group === "Giao hàng";
}

/** Number of calendar days covered by an inclusive ISO period. */
function calendarDays(period: PayrollPeriod): number {
  const from = Date.parse(`${period.dateFrom}T00:00:00.000Z`);
  const to = Date.parse(`${period.dateTo}T00:00:00.000Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return 0;
  return Math.round((to - from) / 86_400_000) + 1;
}

/**
 * Giao hàng — employed calendar days inside the period. A driver who joins or
 * leaves mid-month has the fixed monthly salary prorated over these days.
 */
function employedCalendarDays(
  period: PayrollPeriod,
  employee: PayrollEmployee,
): { days: number; total: number } {
  const total = calendarDays(period);
  if (total === 0) return { days: 0, total: 0 };
  const periodFrom = Date.parse(`${period.dateFrom}T00:00:00.000Z`);
  const periodTo = Date.parse(`${period.dateTo}T00:00:00.000Z`);
  const start = employee.startDate
    ? Date.parse(`${employee.startDate}T00:00:00.000Z`)
    : periodFrom;
  const end = employee.endDate
    ? Date.parse(`${employee.endDate}T00:00:00.000Z`)
    : periodTo;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { days: total, total };
  const from = Math.max(periodFrom, start);
  const to = Math.min(periodTo, end);
  if (to < from) return { days: 0, total };
  return { days: Math.round((to - from) / 86_400_000) + 1, total };
}

/**
 * Owner 2026-10-09 — "chốt lương": a non-terminated employee who stopped during
 * the period (`dateFrom <= endDate < dateTo`) gets neither holiday pay nor
 * overtime pay. An end date on/after the period end is a full-period employee.
 */
function leftDuringPeriod(period: PayrollPeriod, employee: PayrollEmployee): boolean {
  if (employee.terminated) return false;
  const end = employee.endDate ?? null;
  if (!end) return false;
  return period.dateFrom <= end && end < period.dateTo;
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
    missionBonus: RATIONAL_ZERO,
    deliveryUnits: RATIONAL_ZERO,
    deliveryUnitRate: RATIONAL_ZERO,
    fixedPay: RATIONAL_ZERO,
    deliveryUnitPay: RATIONAL_ZERO,
    deliveryExtras: RATIONAL_ZERO,
    grossPay: RATIONAL_ZERO,
    netPay: RATIONAL_ZERO,
    netPayRounded: 0n,
    flags: [],
    shortShiftDays: [],
  };
}

function buildEmployeeLine(
  period: PayrollPeriod,
  employee: PayrollEmployee,
  aggregate: AttendanceAggregate,
  measures: PayrollEmployeeMeasures | undefined,
  adjustments: readonly PayrollAdjustment[],
  deliveryUnitsTotal: number,
  deliveryExtrasTotal: number,
): PayrollEmployeeLine {
  const rules = period.rules;
  const base = zeroLineFields();
  const flags: string[] = [];
  const hasAttendance = aggregate.dates.length > 0;
  if (
    !isDelivery(employee) &&
    ((Number.isFinite(deliveryUnitsTotal) ? deliveryUnitsTotal : 0) !== 0 ||
      (Number.isFinite(deliveryExtrasTotal) ? deliveryExtrasTotal : 0) !== 0)
  ) {
    flags.push("delivery_input_ignored");
  }
  // Owner 2026-10-09 — "chốt lương" only bites when the rule is enabled.
  const leftInPeriodNoExtras = rules.leftInPeriodNoExtras && leftDuringPeriod(period, employee);

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

  // Giao hàng — skip R1–R9 entirely. Pay = fixed monthly salary + delivery
  // units × delivery_unit_base / number of calendar days in the month + extras.
  // Nothing here depends on attendance, holidays, overtime or standard days.
  if (isDelivery(employee)) {
    flags.push("delivery");
    const monthlySalary = employee.monthlySalary !== null && employee.monthlySalary !== undefined
      ? rationalFromNumber(employee.monthlySalary)
      : RATIONAL_ZERO;
    const employment = employedCalendarDays(period, employee);
    // A driver who starts after (or left before) this period is not paid here at
    // all: owner 2026-11-25 keeps T11 drivers on manual "Lương lẻ" and starts app
    // payroll from T12 by setting start_date. No units, extras or fixed pay.
    if (employment.total > 0 && employment.days === 0) {
      flags.push("not_in_period");
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
    const fixedPay = employment.total > 0
      ? divRational(mulRational(monthlySalary, rational(employment.days)), rational(employment.total))
      : RATIONAL_ZERO;
    if (employment.days < employment.total) flags.push("delivery_prorated");

    const deliveryUnits = rationalFromNumber(
      Number.isFinite(deliveryUnitsTotal) ? deliveryUnitsTotal : 0,
    );
    const deliveryUnitRate = employee.deliveryUnitBase !== null &&
        employee.deliveryUnitBase !== undefined
      ? rationalFromNumber(employee.deliveryUnitBase)
      : RATIONAL_ZERO;
    const days = calendarDays(period);
    const deliveryUnitPay = days > 0
      ? divRational(mulRational(deliveryUnits, deliveryUnitRate), rational(days))
      : RATIONAL_ZERO;
    const deliveryExtras = rationalFromNumber(
      Number.isFinite(deliveryExtrasTotal) ? deliveryExtrasTotal : 0,
    );
    // A driver is still an employee: the fixed allowance and a confirmed mission
    // reward are paid on top of the delivery formula, never silently dropped.
    const allowance = employee.allowance !== null && employee.allowance !== undefined
      ? rationalFromNumber(employee.allowance)
      : RATIONAL_ZERO;
    const missionBonus = adjustmentToRational(employee.missionBonus);
    const grossPay = addRational(
      addRational(
        addRational(fixedPay, deliveryUnitPay),
        addRational(deliveryExtras, allowance),
      ),
      missionBonus,
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
      allowance,
      missionBonus,
      deliveryUnits,
      deliveryUnitRate,
      fixedPay,
      deliveryUnitPay,
      deliveryExtras,
      grossPay,
      netPay,
      netPayRounded: roundVndToThousand(netPay),
      flags,
      shortShiftDays: [],
    };
  }

  // --- NC thực tế -------------------------------------------------------
  const actualResolved = resolveQuantity(measures?.actualWorkDays, hasAttendance, () => {
    // Owner 2026-10-08: working on a paid holiday counts double — the worked
    // day here, plus the paid holiday added by R9.
    // Owner 2026-10-09: the worked day uses the short-shift credit, not the raw
    // date count (with shortShift off the credits equal today's date counts).
    const worked = addRational(
      aggregate.nonHolidayDayCredit,
      rules.holidayWorkDouble ? aggregate.holidayDayCredit : RATIONAL_ZERO,
    );
    if (aggregate.shortShiftDates.length > 0) flags.push("short_shift");
    let days = rules.attendanceDays ? worked : RATIONAL_ZERO;
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
  // Owner 2026-10-09 — "chốt lương": left during the period → no holiday pay.
  if (leftInPeriodNoExtras) {
    holidayPayDays = RATIONAL_ZERO;
    flags.push("left_in_period");
  }

  // R8 — part-time is paid on the hour column; its day column stays empty.
  const partTime = isPartTime(employee);
  if (partTime) {
    actualWorkDays = RATIONAL_ZERO;
    holidayPayDays = RATIONAL_ZERO;
    flags.push("part_time_hours");
  }

  // Owner 2026-10-09 — expose the per-date short-shift credits only when NC
  // thực tế really comes from attendance (not a manual sheet figure, an office
  // default or a part-time row). Purely informational: no amount changes.
  const shortShiftDays: PayrollEmployeeLine["shortShiftDays"] =
    actualResolved.source === "attendance" && !officeDefault && !partTime
      ? aggregate.shortShiftDayCredits
      : [];

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
  // Owner 2026-11-24 — when holiday work counts double, the hours read from the
  // machine are normal-day hours + 2 × holiday hours (the holiday hours use the
  // same deductions as `workedSeconds`). Manual figures and part_time_hours
  // adjustments keep overriding the derived value.
  const partTimeResolved = resolveQuantity(measures?.partTimeHours, hasAttendance, () =>
    rational(
      rules.holidayWorkDouble
        ? aggregate.workedSeconds + aggregate.holidayWorkedSeconds
        : aggregate.workedSeconds,
      3600n,
    ),
  );
  let partTimeHours = partTimeResolved.value;
  const partTimeAdjustment = findAdjustment(adjustments, employee.code, "part_time_hours");
  if (partTimeAdjustment) {
    partTimeHours = adjustmentToRational(partTimeAdjustment.value);
    flags.push("part_time_hours_adjusted");
  }
  if (!partTime) partTimeHours = RATIONAL_ZERO;
  if (
    partTime &&
    rules.holidayWorkDouble &&
    aggregate.holidayWorkedSeconds > 0n &&
    partTimeResolved.source === "attendance" &&
    !partTimeAdjustment
  ) {
    flags.push("holiday_hours_double");
  }

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
  // R4 — part-time is paid by the hour only, never a separate overtime.
  if (isPartTime(employee) && overtimeResolved.source === "attendance") overtimeHours = RATIONAL_ZERO;
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
  const excludeOvertimeAdjustment = Boolean(findAdjustment(adjustments, employee.code, "exclude_overtime"));
  // Owner 2026-10-09 — left during the period → overtime is not paid, but it is
  // still reconciled exactly like an exclude_overtime adjustment.
  const excludeOvertime = excludeOvertimeAdjustment || leftInPeriodNoExtras;
  const applyOvertime = !excludeOvertime && !officialNeedsApply;
  const overtimeAppliedHours = applyOvertime ? overtimeHours : RATIONAL_ZERO;
  // R3 — `overtimePay` is the amount actually paid (the payslip "tiền TC"
  // column). Overtime that is excluded or only reconciled is kept separately in
  // `overtimePayReconciled`, so it never inflates the group/total OT pay.
  const overtimePay = applyOvertime ? overtimePayComputed : RATIONAL_ZERO;
  const overtimePayReconciled = subRational(overtimePayComputed, overtimePay);
  if (!applyOvertime && !isZeroRational(overtimePayComputed)) {
    if (excludeOvertimeAdjustment) flags.push("overtime_excluded");
    else if (!leftInPeriodNoExtras) flags.push("overtime_reconcile_only");
  }

  // --- phụ cấp + gross/net ---------------------------------------------
  const allowance =
    employee.allowance !== null && employee.allowance !== undefined
      ? rationalFromNumber(employee.allowance)
      : RATIONAL_ZERO;

  // Nhiệm vụ thưởng bất ngờ — configurable, never part of R1–R9. A missing/null
  // reward contributes 0; the amount is added before the final R5 rounding.
  const missionBonus = adjustmentToRational(employee.missionBonus);

  const grossPay = addRational(
    addRational(addRational(dayPay, partTimePay), overtimePay),
    addRational(allowance, missionBonus),
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
    missionBonus,
    deliveryUnits: RATIONAL_ZERO,
    deliveryUnitRate: RATIONAL_ZERO,
    fixedPay: RATIONAL_ZERO,
    deliveryUnitPay: RATIONAL_ZERO,
    deliveryExtras: RATIONAL_ZERO,
    grossPay,
    netPay,
    netPayRounded: roundVndToThousand(netPay),
    flags,
    shortShiftDays,
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
  "missionBonus",
  "deliveryUnits",
  "deliveryUnitRate",
  "fixedPay",
  "deliveryUnitPay",
  "deliveryExtras",
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
  const deliveryUnits = input.deliveryUnits ?? {};
  const deliveryExtras = input.deliveryExtras ?? {};
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
    const delivery = isDelivery(employee);
    if (!delivery && rows.length === 0 && !employeeMeasures && !employee.terminated) {
      warnings.push(`employee_without_attendance:${employee.code}`);
    }

    // Period data attaches the totals to the employee row, so every existing
    // computePayroll call site gets delivery pay without passing extra maps.
    const units = deliveryUnits[employee.code] ?? employee.deliveryUnits ?? 0;
    const extras = deliveryExtras[employee.code] ?? employee.deliveryExtras ?? 0;

    if (!delivery && (units !== 0 || extras !== 0)) {
      warnings.push(`delivery_input_without_delivery:${employee.code}`);
    }
    if (delivery) {
      if (
        employee.deliveryUnitBase === null ||
        employee.deliveryUnitBase === undefined
      ) {
        warnings.push(`delivery_unit_base_missing:${employee.code}`);
      }
      if (employee.monthlySalary === null || employee.monthlySalary === undefined) {
        warnings.push(`delivery_salary_missing:${employee.code}`);
      }
      const seen = new Set<string>();
      for (const item of adjustments) {
        if (item.employeeCode !== employee.code || item.field === "net_pay") continue;
        const key = `delivery_adjustment_ignored:${employee.code}:${item.field}`;
        if (seen.has(key)) continue;
        seen.add(key);
        warnings.push(key);
      }
    }

    return buildEmployeeLine(
      period,
      employee,
      aggregateAttendance(rows, period),
      employeeMeasures,
      adjustments,
      units,
      extras,
    );
  });

  const catalog = new Set(input.employees.map((employee) => employee.code));
  for (const code of rowsByEmployee.keys()) {
    if (!catalog.has(code)) warnings.push(`attendance_without_employee:${code}`);
  }
  for (const code of new Set([
    ...Object.keys(deliveryUnits),
    ...Object.keys(deliveryExtras),
  ])) {
    if (catalog.has(code)) continue;
    const units = deliveryUnits[code] ?? 0;
    const extras = deliveryExtras[code] ?? 0;
    if (units !== 0 || extras !== 0) {
      warnings.push(`delivery_units_without_employee:${code}`);
    }
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
