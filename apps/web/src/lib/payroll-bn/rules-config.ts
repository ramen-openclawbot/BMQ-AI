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
  /** Days whose worked hours are below this threshold lose `deductHours`. */
  thresholdHours: number;
  deductHours: number;
}

export type OfficialOvertimeMode = "reconcile" | "apply";

export interface OfficialOvertimeRule {
  enabled: boolean;
  /** `reconcile` reports overtime without paying it (Q3 review mode). */
  mode: OfficialOvertimeMode;
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
  /** R9 — pay period holidays for employees hired on/before the holiday. */
  holidayPaid: boolean;
  /** Hours in a standard working day, used for overtime threshold. */
  standardHoursPerDay: number;
}

export const DEFAULT_RULES_CONFIG: RulesConfig = {
  attendanceDays: true,
  plusOneDay: { enabled: false, days: 1 },
  deductHour: { enabled: false, thresholdHours: 8, deductHours: 1 },
  officialOvertime: { enabled: false, mode: "reconcile" },
  holidayPaid: true,
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
    holidayPaid: partial.holidayPaid ?? DEFAULT_RULES_CONFIG.holidayPaid,
    standardHoursPerDay: partial.standardHoursPerDay ?? DEFAULT_RULES_CONFIG.standardHoursPerDay,
  };
}

export function cloneRulesConfig(config: RulesConfig): RulesConfig {
  return {
    attendanceDays: config.attendanceDays,
    plusOneDay: { ...config.plusOneDay },
    deductHour: { ...config.deductHour },
    officialOvertime: { ...config.officialOvertime },
    holidayPaid: config.holidayPaid,
    standardHoursPerDay: config.standardHoursPerDay,
  };
}
