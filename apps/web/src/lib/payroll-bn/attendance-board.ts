// Read-only data mirror for the live Bếp BN attendance board.
//
// The database RPCs return snake_case jsonb. These mappers normalise it to a
// camelCase view model for the Maestro, tolerating missing keys so an older
// payload or a partial response cannot crash the screen. No JSX, no layout and
// no business recomputation beyond display formatting.

export const ATTENDANCE_BOARD_STATUSES = [
  "on_time",
  "late",
  "absent_overdue",
  "not_yet",
  "no_shift_time",
  "off",
  "override",
] as const;

export type AttendanceBoardStatus = (typeof ATTENDANCE_BOARD_STATUSES)[number];

export type AttendanceShiftSource = "schedule" | "manual" | "mission" | null;

export const ATTENDANCE_STATUS_TONES = [
  "success",
  "warning",
  "danger",
  "info",
  "neutral",
  "muted",
] as const;

export type AttendanceStatusTone = (typeof ATTENDANCE_STATUS_TONES)[number];

export interface AttendanceBoardEmployee {
  employeeCode: string;
  name: string;
  groupName: string | null;
  shiftStart: string | null;
  shiftSource: AttendanceShiftSource;
  scheduledOff: boolean;
  onLeave: boolean;
  closed: boolean;
  checkInAt: string | null;
  checkOutAt: string | null;
  minutesLate: number | null;
  status: AttendanceBoardStatus;
  checkedOut: boolean;
  rejectedCount: number;
  hasOverride: boolean;
}

export interface AttendanceBoardTotals {
  employees: number;
  checkedIn: number;
  onTime: number;
  late: number;
  notYet: number;
  absentOverdue: number;
  checkedOut: number;
  off: number;
  noShiftTime: number;
}

export interface AttendanceBoard {
  date: string;
  generatedAt: string;
  lateGraceMinutes: number;
  employees: AttendanceBoardEmployee[];
  totals: AttendanceBoardTotals;
}

export interface PunctualityRankingEmployee {
  rank: number;
  employeeCode: string;
  name: string;
  groupName: string | null;
  workedDays: number;
  onTimeDays: number;
  lateDays: number;
  lateMinutesTotal: number;
  noShiftTimeDays: number;
  absentDays: number;
  bestStreak: number;
  currentStreak: number;
  onTimeRate: number | null;
}

export interface PunctualityRanking {
  from: string;
  to: string;
  lateGraceMinutes: number;
  employees: PunctualityRankingEmployee[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : value;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asInteger(value: unknown, fallback = 0): number {
  const parsed = asNumber(value);
  return parsed === null ? fallback : Math.trunc(parsed);
}

function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === "1" || value === "true") return true;
  if (value === 0 || value === "0" || value === "false") return false;
  return fallback;
}

function asStatus(value: unknown): AttendanceBoardStatus {
  if (typeof value === "string" && (ATTENDANCE_BOARD_STATUSES as readonly string[]).includes(value)) {
    return value as AttendanceBoardStatus;
  }
  return "no_shift_time";
}

function asShiftSource(value: unknown): AttendanceShiftSource {
  return value === "schedule" || value === "manual" || value === "mission" ? value : null;
}

export function mapAttendanceBoardEmployee(value: unknown): AttendanceBoardEmployee {
  const raw = asRecord(value);
  const checkInAt = asString(raw.check_in_at);
  const checkOutAt = asString(raw.check_out_at);

  return {
    employeeCode: asString(raw.employee_code) ?? "",
    name: asString(raw.name) ?? asString(raw.employee_name) ?? "",
    groupName: asString(raw.group_name),
    shiftStart: asString(raw.shift_start),
    shiftSource: asShiftSource(raw.shift_source),
    scheduledOff: asBoolean(raw.scheduled_off),
    onLeave: asBoolean(raw.on_leave),
    closed: asBoolean(raw.closed),
    checkInAt,
    checkOutAt,
    minutesLate: asNumber(raw.minutes_late),
    status: asStatus(raw.status),
    checkedOut: asBoolean(raw.checked_out, checkOutAt !== null),
    rejectedCount: asInteger(raw.rejected_count),
    hasOverride: asBoolean(raw.has_override),
  };
}

export function mapAttendanceBoard(payload: unknown): AttendanceBoard {
  const root = asRecord(payload);
  const employees = asArray(root.employees).map(mapAttendanceBoardEmployee);
  const rawTotals = asRecord(root.totals);

  const totals: AttendanceBoardTotals = {
    employees: asInteger(rawTotals.employees, employees.length),
    checkedIn: asInteger(
      rawTotals.checked_in,
      employees.filter((employee) => employee.checkInAt !== null).length,
    ),
    onTime: asInteger(
      rawTotals.on_time,
      employees.filter((employee) => employee.status === "on_time").length,
    ),
    late: asInteger(
      rawTotals.late,
      employees.filter((employee) => employee.status === "late").length,
    ),
    notYet: asInteger(
      rawTotals.not_yet,
      employees.filter((employee) => employee.status === "not_yet").length,
    ),
    absentOverdue: asInteger(
      rawTotals.absent_overdue,
      employees.filter((employee) => employee.status === "absent_overdue").length,
    ),
    checkedOut: asInteger(
      rawTotals.checked_out,
      employees.filter((employee) => employee.checkedOut).length,
    ),
    off: asInteger(
      rawTotals.off,
      employees.filter((employee) => employee.status === "off").length,
    ),
    noShiftTime: asInteger(
      rawTotals.no_shift_time,
      employees.filter((employee) => employee.status === "no_shift_time").length,
    ),
  };

  return {
    date: asString(root.date) ?? "",
    generatedAt: asString(root.generated_at) ?? "",
    lateGraceMinutes: asInteger(root.late_grace_minutes),
    employees,
    totals,
  };
}

export function mapPunctualityRankingEmployee(value: unknown): PunctualityRankingEmployee {
  const raw = asRecord(value);

  return {
    rank: asInteger(raw.rank),
    employeeCode: asString(raw.employee_code) ?? "",
    name: asString(raw.name) ?? asString(raw.employee_name) ?? "",
    groupName: asString(raw.group_name),
    workedDays: asInteger(raw.worked_days),
    onTimeDays: asInteger(raw.on_time_days),
    lateDays: asInteger(raw.late_days),
    lateMinutesTotal: asInteger(raw.late_minutes_total),
    noShiftTimeDays: asInteger(raw.no_shift_time_days),
    absentDays: asInteger(raw.absent_days),
    bestStreak: asInteger(raw.best_streak),
    currentStreak: asInteger(raw.current_streak),
    onTimeRate: asNumber(raw.on_time_rate),
  };
}

export function mapPunctualityRanking(payload: unknown): PunctualityRanking {
  const root = asRecord(payload);

  return {
    from: asString(root.from) ?? "",
    to: asString(root.to) ?? "",
    lateGraceMinutes: asInteger(root.late_grace_minutes),
    employees: asArray(root.employees).map(mapPunctualityRankingEmployee),
  };
}

/** Format a minute count for the board. Missing/invalid values become an em dash. */
export function formatMinutes(minutes: number | null | undefined): string {
  if (typeof minutes !== "number" || !Number.isFinite(minutes)) return "—";
  return `${Math.max(0, Math.floor(minutes))} phút`;
}

export function attendanceStatusLabel(
  status: AttendanceBoardStatus,
  minutesLate?: number | null,
): string {
  switch (status) {
    case "on_time":
      return "Đúng giờ";
    case "late":
      return `Trễ ${formatMinutes(minutesLate ?? 0)}`;
    case "not_yet":
      return "Chưa đến";
    case "absent_overdue":
      return "Quá giờ chưa chấm";
    case "no_shift_time":
      return "Chưa có giờ ca";
    case "off":
      return "Nghỉ";
    case "override":
      return "Đã duyệt công";
    default:
      return "Chưa có giờ ca";
  }
}

export function attendanceStatusTone(status: AttendanceBoardStatus): AttendanceStatusTone {
  switch (status) {
    case "on_time":
      return "success";
    case "late":
      return "warning";
    case "not_yet":
      return "info";
    case "absent_overdue":
      return "danger";
    case "no_shift_time":
      return "muted";
    case "off":
      return "neutral";
    case "override":
      return "info";
    default:
      return "muted";
  }
}

// Short aliases for callers that already import the module directly.
export const statusLabel = attendanceStatusLabel;
export const statusTone = attendanceStatusTone;
