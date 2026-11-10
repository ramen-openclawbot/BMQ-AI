// Pure logic for weekly Bếp bánh shift registration (payroll_bn).
//
// No Deno-only imports and no DOM globals: `node --test` runs this file
// directly. The rules mirror 20261110180000_payroll_bn_shift_schedule.sql:
//   * shift types, needed headcount, deadline and limits are data;
//   * one shift or a day off per non-closed day of the target week;
//   * a full shift / a day off above the daily limit is saved as waitlist;
//   * a carried suggestion is only the previous week's entry moved +7 days;
//   * the punctual cutoff for a date is the registered shift start, otherwise
//     the caller's fallback (offer shift start -> employee shift -> params).

export type PayrollShiftState = "registered" | "waitlist";
export type PayrollShiftSource = "employee" | "manager" | "carried";

export interface PayrollShiftSettings {
  eligible_groups: string[];
  open_iso_dow: number;
  deadline_iso_dow: number;
  deadline_time: string;
  max_off_per_day: number;
  min_staff_per_day: number;
  min_off_days_per_week: number;
}

export const DEFAULT_PAYROLL_SHIFT_SETTINGS: PayrollShiftSettings = {
  eligible_groups: ["Bếp bánh"],
  open_iso_dow: 2,
  deadline_iso_dow: 6,
  deadline_time: "12:00",
  max_off_per_day: 2,
  min_staff_per_day: 5,
  min_off_days_per_week: 1,
};

export interface PayrollShiftType {
  code: string;
  label?: string;
  start_time: string;
  end_time?: string | null;
  sort?: number;
  active?: boolean;
}

export interface PayrollShiftQuota {
  shift_code: string;
  iso_dow?: number | null;
  needed: number;
  quota_group?: string | null;
}

export interface PayrollShiftEntry {
  work_date: string;
  shift_code: string | null;
  state?: PayrollShiftState;
  source?: PayrollShiftSource;
  employee_code?: string | null;
}

export interface PayrollShiftRegistrationInput {
  work_date: string;
  shift_code: string | null;
}

export interface PayrollShiftRegistrationContext {
  week_start: string;
  shift_types: readonly PayrollShiftType[];
  quotas: readonly PayrollShiftQuota[];
  settings?: Partial<PayrollShiftSettings>;
  existing_entries?: readonly PayrollShiftEntry[];
  closed_dates?: readonly string[];
  employee_code?: string | null;
  status?: "open" | "published";
  eligible?: boolean;
  now?: Date | string | number;
}

export interface PayrollShiftRegistrationChoice {
  work_date: string;
  shift_code: string | null;
  state: PayrollShiftState;
}

export interface PayrollShiftRegistrationResult {
  ok: boolean;
  error: string | null;
  entries: PayrollShiftRegistrationChoice[];
}

export interface PayrollShiftCoverageShift {
  work_date: string;
  shift_code: string;
  registered: number;
  needed: number;
  quota_group: string | null;
  full: boolean;
  need_more: boolean;
}

export interface PayrollShiftCoverageGroup {
  work_date: string;
  quota_group: string;
  registered: number;
  needed: number;
  full: boolean;
}

export interface PayrollShiftCoverage {
  dates: string[];
  shifts: PayrollShiftCoverageShift[];
  quota_groups: PayrollShiftCoverageGroup[];
  total_staff: Record<string, number>;
  off_count: Record<string, number>;
}

export const SHIFT_ERROR_CLOSED = "shift_registration_closed";
export const SHIFT_ERROR_NOT_ELIGIBLE = "shift_not_eligible";
export const SHIFT_ERROR_INVALID_SHIFT = "shift_invalid_shift";
export const SHIFT_ERROR_INCOMPLETE_WEEK = "shift_incomplete_week";
export const SHIFT_ERROR_DAY_OFF_REQUIRED = "shift_day_off_required";
export const SHIFT_ERROR_EMPLOYEE_REQUIRED = "shift_employee_required";
export const SHIFT_ERROR_INVALID_ENTRY = "shift_invalid_entry";

const DEFAULT_CUTOFF = "07:00";
const DAY_MS = 86_400_000;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

function isValidTime(value: unknown): value is string {
  return typeof value === "string"
    && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(value.trim());
}

function normalizeTime(value: unknown, fallback: string): string {
  return isValidTime(value) ? value.trim() : fallback;
}

function timeTextToMinutes(value: unknown): number | null {
  if (!isValidTime(value)) return null;
  const [hour, minute] = value.trim().split(":").map(Number);
  return hour * 60 + minute;
}

function minutesToText(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${pad2(hour)}:${pad2(minute)}`;
}

interface Ymd {
  year: number;
  month: number;
  day: number;
}

function parseYmd(value: string): Ymd | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year
    || date.getUTCMonth() !== month - 1
    || date.getUTCDate() !== day
  ) return null;
  return { year, month, day };
}

function ymdFromUtc(date: Date): string {
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())}`;
}

function addDays(value: string, days: number): string {
  const parsed = parseYmd(value);
  if (!parsed) return "";
  return ymdFromUtc(new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day + days)));
}

function isoDow(value: string): number {
  const parsed = parseYmd(value);
  if (!parsed) return 0;
  const jsDow = new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day)).getUTCDay();
  return jsDow === 0 ? 7 : jsDow;
}

/** Vietnam calendar date (YYYY-MM-DD) for an instant, without host timezone. */
export function vietnamYmd(input: Date | string | number = new Date()): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const year = get("year");
  const month = get("month");
  const day = get("day");
  return year && month && day ? `${year}-${month}-${day}` : "";
}

/** Monday of the Vietnam-local week that contains `input`. */
export function weekStart(input: Date | string | number = new Date()): string {
  let date: string;
  if (typeof input === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input)) {
    date = input;
  } else {
    date = vietnamYmd(input);
  }
  if (!parseYmd(date)) return "";
  return addDays(date, -(isoDow(date) - 1));
}

/** Vietnam instant for a local date + HH:MM (Asia/Ho_Chi_Minh is UTC+7). */
function vietnamInstant(date: string, time: string): Date {
  const parsed = parseYmd(date);
  const minutes = timeTextToMinutes(time) ?? 0;
  if (!parsed) return new Date(Number.NaN);
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return new Date(Date.UTC(parsed.year, parsed.month - 1, parsed.day, hour - 7, minute));
}

export function resolveShiftSettings(
  settings: Partial<PayrollShiftSettings> = {},
): PayrollShiftSettings {
  const merged = { ...DEFAULT_PAYROLL_SHIFT_SETTINGS, ...settings };
  const closedDow = (value: unknown, fallback: number): number => {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isInteger(parsed) && parsed >= 1 && parsed <= 7 ? parsed : fallback;
  };
  const nonNegative = (value: unknown, fallback: number): number => {
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
  };
  return {
    eligible_groups: Array.isArray(merged.eligible_groups)
      ? merged.eligible_groups.filter((group): group is string => typeof group === "string")
      : DEFAULT_PAYROLL_SHIFT_SETTINGS.eligible_groups,
    open_iso_dow: closedDow(merged.open_iso_dow, DEFAULT_PAYROLL_SHIFT_SETTINGS.open_iso_dow),
    deadline_iso_dow: closedDow(
      merged.deadline_iso_dow,
      DEFAULT_PAYROLL_SHIFT_SETTINGS.deadline_iso_dow,
    ),
    deadline_time: normalizeTime(
      merged.deadline_time,
      DEFAULT_PAYROLL_SHIFT_SETTINGS.deadline_time,
    ),
    max_off_per_day: nonNegative(
      merged.max_off_per_day,
      DEFAULT_PAYROLL_SHIFT_SETTINGS.max_off_per_day,
    ),
    min_staff_per_day: nonNegative(
      merged.min_staff_per_day,
      DEFAULT_PAYROLL_SHIFT_SETTINGS.min_staff_per_day,
    ),
    min_off_days_per_week: nonNegative(
      merged.min_off_days_per_week,
      DEFAULT_PAYROLL_SHIFT_SETTINGS.min_off_days_per_week,
    ),
  };
}

/** Deadline instant of the week that opens `weekStartInput` (day in prior week). */
export function shiftDeadline(
  weekStartInput: Date | string | number,
  settings: Partial<PayrollShiftSettings> = {},
): Date {
  const resolved = resolveShiftSettings(settings);
  const week = weekStart(weekStartInput);
  const day = addDays(week, -7 + (resolved.deadline_iso_dow - 1));
  return vietnamInstant(day, resolved.deadline_time);
}

/** Opening instant of the week that opens `weekStartInput` (day in prior week). */
export function shiftOpensAt(
  weekStartInput: Date | string | number,
  settings: Partial<PayrollShiftSettings> = {},
): Date {
  const resolved = resolveShiftSettings(settings);
  const week = weekStart(weekStartInput);
  const day = addDays(week, -7 + (resolved.open_iso_dow - 1));
  return vietnamInstant(day, "00:00");
}

function quotaForShift(
  quotas: readonly PayrollShiftQuota[],
  shiftCode: string,
  dow: number,
): PayrollShiftQuota | null {
  let best: PayrollShiftQuota | null = null;
  for (const quota of quotas) {
    if (quota.shift_code !== shiftCode) continue;
    if (quota.iso_dow !== null && quota.iso_dow !== undefined && quota.iso_dow !== dow) continue;
    if (best === null || (best.iso_dow === null || best.iso_dow === undefined)) best = quota;
  }
  return best;
}

function registeredEntries(entries: readonly PayrollShiftEntry[]): PayrollShiftEntry[] {
  return entries.filter((entry) => (entry.state ?? "registered") !== "waitlist");
}

function countShift(
  entries: readonly PayrollShiftEntry[],
  workDate: string,
  shiftCodes: readonly string[],
): number {
  return registeredEntries(entries).filter((entry) =>
    entry.work_date === workDate
    && entry.shift_code !== null
    && shiftCodes.includes(entry.shift_code)
  ).length;
}

function countOff(entries: readonly PayrollShiftEntry[], workDate: string): number {
  return registeredEntries(entries).filter((entry) =>
    entry.work_date === workDate && entry.shift_code === null
  ).length;
}

/** Active shift types by code, sorted by sort then code. */
export function activeShiftTypes(
  types: readonly PayrollShiftType[],
): PayrollShiftType[] {
  return types
    .filter((type) => type.active !== false && typeof type.code === "string" && type.code !== "")
    .sort((left, right) => (left.sort ?? 0) - (right.sort ?? 0) || left.code.localeCompare(right.code));
}

/**
 * Coverage per work date and shift, including shared quota groups. Only
 * registered (never waitlist) entries count.
 */
export function coverage(
  entries: readonly PayrollShiftEntry[],
  quotas: readonly PayrollShiftQuota[],
  weekStartInput?: string,
): PayrollShiftCoverage {
  const dateSet = new Set<string>();
  for (const entry of entries) {
    if (parseYmd(entry.work_date)) dateSet.add(entry.work_date);
  }
  if (weekStartInput && parseYmd(weekStartInput)) {
    for (let index = 0; index < 7; index += 1) {
      dateSet.add(addDays(weekStartInput, index));
    }
  }
  const dates = [...dateSet].sort();
  const shifts: PayrollShiftCoverageShift[] = [];
  const groups: PayrollShiftCoverageGroup[] = [];
  const totalStaff: Record<string, number> = {};
  const offCount: Record<string, number> = {};

  for (const date of dates) {
    const dow = isoDow(date);
    totalStaff[date] = 0;
    offCount[date] = countOff(entries, date);
    for (const entry of registeredEntries(entries)) {
      if (entry.work_date === date && entry.shift_code !== null) totalStaff[date] += 1;
    }

    const seenGroups = new Set<string>();
    const seenShifts = new Set<string>();
    for (const quota of quotas) {
      if (seenShifts.has(quota.shift_code)) continue;
      const match = quotaForShift(quotas, quota.shift_code, dow);
      if (!match) continue;
      seenShifts.add(quota.shift_code);
      const registered = countShift(entries, date, [quota.shift_code]);
      const needed = Math.max(0, Math.trunc(match.needed ?? 0));
      const group = match.quota_group ?? null;
      shifts.push({
        work_date: date,
        shift_code: quota.shift_code,
        registered,
        needed,
        quota_group: group,
        full: registered >= needed,
        need_more: needed > registered,
      });

      if (group && !seenGroups.has(group)) {
        seenGroups.add(group);
        const groupCodes = [
          ...new Set(
            quotas
              .filter((candidate) => candidate.quota_group === group)
              .map((candidate) => candidate.shift_code),
          ),
        ];
        let groupNeeded = 0;
        for (const code of groupCodes) {
          const groupQuota = quotaForShift(quotas, code, dow);
          if (groupQuota) groupNeeded = Math.max(groupNeeded, Math.trunc(groupQuota.needed ?? 0));
        }
        const groupRegistered = countShift(entries, date, groupCodes);
        groups.push({
          work_date: date,
          quota_group: group,
          registered: groupRegistered,
          needed: groupNeeded,
          full: groupRegistered >= groupNeeded,
        });
      }
    }
  }

  shifts.sort((left, right) =>
    left.work_date.localeCompare(right.work_date) || left.shift_code.localeCompare(right.shift_code)
  );
  groups.sort((left, right) =>
    left.work_date.localeCompare(right.work_date)
    || left.quota_group.localeCompare(right.quota_group)
  );

  return { dates, shifts, quota_groups: groups, total_staff: totalStaff, off_count: offCount };
}

/**
 * Validate and resolve one employee's registration for a week. Returns the same
 * error codes as the SQL RPC. Closed dates are ignored/removed; every remaining
 * date needs exactly one choice.
 */
export function validateRegistration(
  entries: readonly PayrollShiftRegistrationInput[],
  context: PayrollShiftRegistrationContext,
): PayrollShiftRegistrationResult {
  const settings = resolveShiftSettings(context.settings);
  const closedDates = new Set(
    (context.closed_dates ?? []).filter((date) => parseYmd(date)),
  );

  if (context.status && context.status !== "open") {
    return { ok: false, error: SHIFT_ERROR_CLOSED, entries: [] };
  }
  const now = context.now === undefined ? new Date() : new Date(context.now);
  if (Number.isNaN(now.getTime())) {
    return { ok: false, error: SHIFT_ERROR_CLOSED, entries: [] };
  }
  if (now.getTime() < shiftOpensAt(context.week_start, settings).getTime()
    || now.getTime() > shiftDeadline(context.week_start, settings).getTime()) {
    return { ok: false, error: SHIFT_ERROR_CLOSED, entries: [] };
  }
  if (context.eligible === false) {
    return { ok: false, error: SHIFT_ERROR_NOT_ELIGIBLE, entries: [] };
  }

  const week = weekStart(context.week_start);
  if (!week) return { ok: false, error: SHIFT_ERROR_INCOMPLETE_WEEK, entries: [] };

  const requiredDates: string[] = [];
  for (let index = 0; index < 7; index += 1) {
    const date = addDays(week, index);
    if (!closedDates.has(date)) requiredDates.push(date);
  }
  const required = new Set(requiredDates);

  const chosen = new Map<string, string | null>();
  let offDays = 0;
  for (const entry of entries) {
    const date = typeof entry.work_date === "string" ? entry.work_date : "";
    if (!required.has(date)) {
      // A closed date (or a date outside the week) is ignored.
      if (closedDates.has(date)) continue;
      return { ok: false, error: SHIFT_ERROR_INCOMPLETE_WEEK, entries: [] };
    }
    if (chosen.has(date)) {
      return { ok: false, error: SHIFT_ERROR_INCOMPLETE_WEEK, entries: [] };
    }
    const shiftCode = entry.shift_code === null || entry.shift_code === undefined
      ? null
      : String(entry.shift_code).trim();
    if (shiftCode !== null && shiftCode !== "") {
      const type = context.shift_types.find((candidate) => candidate.code === shiftCode);
      if (!type || type.active === false) {
        return { ok: false, error: SHIFT_ERROR_INVALID_SHIFT, entries: [] };
      }
      chosen.set(date, shiftCode);
    } else {
      chosen.set(date, null);
      offDays += 1;
    }
  }

  if (chosen.size !== required.size) {
    return { ok: false, error: SHIFT_ERROR_INCOMPLETE_WEEK, entries: [] };
  }
  if (offDays < settings.min_off_days_per_week) {
    return { ok: false, error: SHIFT_ERROR_DAY_OFF_REQUIRED, entries: [] };
  }

  // Count only other employees' registered entries: a resubmission replaces the
  // employee's own rows, so their old choice must not make the shift look full.
  const others = (context.existing_entries ?? []).filter((entry) =>
    !context.employee_code || entry.employee_code !== context.employee_code
  );

  const choices: PayrollShiftRegistrationChoice[] = [];
  for (const date of requiredDates) {
    const shiftCode = chosen.get(date) ?? null;
    const dow = isoDow(date);
    let state: PayrollShiftState = "registered";

    if (shiftCode === null) {
      if (countOff(others, date) >= settings.max_off_per_day) state = "waitlist";
    } else {
      const quota = quotaForShift(context.quotas, shiftCode, dow);
      if (!quota) {
        // No configured quota means no free slot is known: waitlist it.
        state = "waitlist";
      } else {
        const group = quota.quota_group ?? null;
        let registered: number;
        let needed: number;
        if (group) {
          const groupCodes = [
            ...new Set(
              context.quotas
                .filter((candidate) => candidate.quota_group === group)
                .map((candidate) => candidate.shift_code),
            ),
          ];
          registered = countShift(others, date, groupCodes);
          needed = 0;
          for (const code of groupCodes) {
            const groupQuota = quotaForShift(context.quotas, code, dow);
            if (groupQuota) needed = Math.max(needed, Math.trunc(groupQuota.needed ?? 0));
          }
        } else {
          registered = countShift(others, date, [shiftCode]);
          needed = Math.max(0, Math.trunc(quota.needed ?? 0));
        }
        if (registered >= needed) state = "waitlist";
      }
    }

    choices.push({ work_date: date, shift_code: shiftCode, state });
  }

  return { ok: true, error: null, entries: choices };
}

/** Previous week's entries moved +7 days; never stored until publish. */
export function carrySuggestion(
  previousWeekEntries: readonly PayrollShiftEntry[],
): Array<{ work_date: string; shift_code: string | null; state: PayrollShiftState; carried: true }> {
  return previousWeekEntries
    .filter((entry) => parseYmd(entry.work_date))
    .map((entry) => ({
      work_date: addDays(entry.work_date, 7),
      shift_code: entry.shift_code ?? null,
      state: entry.state ?? "registered",
      carried: true as const,
    }))
    .sort((left, right) => left.work_date.localeCompare(right.work_date));
}

/**
 * Punctual cutoff for one work date: the registered shift start when the
 * employee has one for that date, otherwise the caller's fallback (which keeps
 * the existing offer -> employee shift -> params.cutoff -> 07:00 precedence).
 */
export function cutoffForDate(
  workDate: string,
  entries: readonly PayrollShiftEntry[],
  shiftTypes: readonly PayrollShiftType[],
  fallbackCutoff: string | null | undefined = DEFAULT_CUTOFF,
): string {
  const fallback = normalizeTime(fallbackCutoff, DEFAULT_CUTOFF);
  const entry = entries.find((candidate) =>
    candidate.work_date === workDate
    && candidate.shift_code !== null
    && (candidate.state ?? "registered") !== "waitlist"
  );
  if (!entry || entry.shift_code === null) return fallback;
  const type = shiftTypes.find((candidate) => candidate.code === entry.shift_code);
  if (!type || !isValidTime(type.start_time)) return fallback;
  return minutesToText(timeTextToMinutes(type.start_time)!);
}
