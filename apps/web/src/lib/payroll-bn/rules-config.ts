// Rule switches for the Bếp BN payroll engine.
//
// H1 (số ngày có chấm công) is the core attendance count. The optional rules
// added on top of it (+1 công Q1, trừ giờ theo ngưỡng H2/Q2, tăng ca nhân viên
// chính thức Q3) default to OFF: nothing becomes a hard payroll criterion until
// it is explicitly confirmed in the period configuration.

export interface PlusOneDayRule {
  enabled: boolean;
  days: number;
}

export interface DeductHourRule {
  enabled: boolean;
  /** Part-time days whose check-in→check-out span reaches this many hours lose `deductHours` (lunch). */
  thresholdHours: number;
  deductHours: number;
}

export interface ShortShiftRule {
  enabled: boolean;
  /** A day-span reaching this many hours counts one full công. */
  fullDayMinHours: number;
  /** A day-span reaching this many hours (but below full) counts half a công. */
  halfDayMinHours: number;
}

export type OfficialOvertimeMode = "reconcile" | "apply";

export interface OfficialOvertimeRule {
  enabled: boolean;
  /** `reconcile` reports overtime without paying it (Q3 review mode). */
  mode: OfficialOvertimeMode;
  /** Overtime of a day = check-in→check-out span minus these hours (8h work + 1h lunch). */
  dailyThresholdHours: number;
  /** A day's remainder counts as overtime only from this many minutes. */
  minimumMinutes: number;
}

export interface RulesConfig {
  /** H1 — count attendance days. */
  attendanceDays: boolean;
  /** Q1 — add extra công when attendance exists. */
  plusOneDay: PlusOneDayRule;
  /** H2 / Q2 — deduct hours under an adjustable threshold. */
  deductHour: DeductHourRule;
  /** Q3 — overtime policy for official (full-time) employees. */
  officialOvertime: OfficialOvertimeRule;
  /** 2026-10-09 — short shift: < full day counts half, < half day counts 0. */
  shortShift: ShortShiftRule;
  /** R9 — pay period holidays for employees hired on/before the holiday. */
  holidayPaid: boolean;
  /** Working on a paid holiday counts that day twice: the paid holiday plus the worked day. */
  holidayWorkDouble: boolean;
  /** 2026-10-09 — an employee who left during the period gets no holiday/overtime pay. */
  leftInPeriodNoExtras: boolean;
  /** Hours in a standard working day, used for overtime threshold. */
  standardHoursPerDay: number;
}

// Q2/Q3 confirmed by the owner/HR on 2026-10-08: a part-time 8h shift loses the
// 1h lunch; official overtime = daily span − 9h, counted from 15 minutes.
// 2026-10-09: short shift (<8h half, <4h zero) and "chốt lương" (left during
// the period → no holiday pay, no overtime pay) are on by default.
export const DEFAULT_RULES_CONFIG: RulesConfig = {
  attendanceDays: true,
  plusOneDay: { enabled: false, days: 1 },
  deductHour: { enabled: true, thresholdHours: 8, deductHours: 1 },
  officialOvertime: { enabled: true, mode: "apply", dailyThresholdHours: 9, minimumMinutes: 15 },
  shortShift: { enabled: true, fullDayMinHours: 8, halfDayMinHours: 4 },
  holidayPaid: true,
  holidayWorkDouble: true,
  leftInPeriodNoExtras: true,
  standardHoursPerDay: 8,
};

/** Merge a partial period config on top of the safe defaults. */
export function resolveRulesConfig(partial?: Partial<RulesConfig> | null): RulesConfig {
  if (!partial) return cloneRulesConfig(DEFAULT_RULES_CONFIG);
  return {
    attendanceDays: partial.attendanceDays ?? DEFAULT_RULES_CONFIG.attendanceDays,
    plusOneDay: {
      ...DEFAULT_RULES_CONFIG.plusOneDay,
      ...(partial.plusOneDay ?? {}),
    },
    deductHour: {
      ...DEFAULT_RULES_CONFIG.deductHour,
      ...(partial.deductHour ?? {}),
    },
    officialOvertime: {
      ...DEFAULT_RULES_CONFIG.officialOvertime,
      ...(partial.officialOvertime ?? {}),
    },
    shortShift: {
      ...DEFAULT_RULES_CONFIG.shortShift,
      ...(partial.shortShift ?? {}),
    },
    holidayPaid: partial.holidayPaid ?? DEFAULT_RULES_CONFIG.holidayPaid,
    holidayWorkDouble: partial.holidayWorkDouble ?? DEFAULT_RULES_CONFIG.holidayWorkDouble,
    leftInPeriodNoExtras: partial.leftInPeriodNoExtras ?? DEFAULT_RULES_CONFIG.leftInPeriodNoExtras,
    standardHoursPerDay: partial.standardHoursPerDay ?? DEFAULT_RULES_CONFIG.standardHoursPerDay,
  };
}

export function cloneRulesConfig(config: RulesConfig): RulesConfig {
  return {
    attendanceDays: config.attendanceDays,
    plusOneDay: { ...config.plusOneDay },
    deductHour: { ...config.deductHour },
    officialOvertime: { ...config.officialOvertime },
    shortShift: { ...config.shortShift },
    holidayPaid: config.holidayPaid,
    holidayWorkDouble: config.holidayWorkDouble,
    leftInPeriodNoExtras: config.leftInPeriodNoExtras,
    standardHoursPerDay: config.standardHoursPerDay,
  };
}
