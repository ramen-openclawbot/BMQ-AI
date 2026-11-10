import assert from "node:assert/strict";
import test from "node:test";

import {
  carrySuggestion,
  coverage,
  cutoffForDate,
  mapShiftRequestError,
  normalizeShiftRequest,
  SHIFT_ERROR_CLOSED,
  SHIFT_ERROR_DAY_OFF_REQUIRED,
  SHIFT_ERROR_INCOMPLETE_WEEK,
  SHIFT_ERROR_INVALID_SHIFT,
  SHIFT_REQUEST_ERROR_INVALID_KIND,
  SHIFT_REQUEST_ERROR_PAST_DATE,
  SHIFT_REQUEST_ERROR_REASON_REQUIRED,
  shiftDeadline,
  shiftOpensAt,
  validateRegistration,
  validateShiftRequestInput,
  weekStart,
} from "./payroll-shifts.ts";
import type {
  PayrollShiftEntry,
  PayrollShiftQuota,
  PayrollShiftRegistrationInput,
  PayrollShiftType,
} from "./payroll-shifts.ts";

const WEEK = "2026-11-09";
const D0 = "2026-11-09";
const D1 = "2026-11-10";
const D2 = "2026-11-11";
const D3 = "2026-11-12";
const D4 = "2026-11-13";
const D5 = "2026-11-14";
const D6 = "2026-11-15";

// Friday 2026-11-06 12:00 Vietnam: after Tuesday opening, before Saturday deadline.
const ON_TIME = "2026-11-06T12:00:00+07:00";

const SHIFT_TYPES: PayrollShiftType[] = [
  { code: "sang", label: "Sáng", start_time: "07:00", sort: 1, active: true },
  { code: "chieu", label: "Chiều", start_time: "13:00", sort: 2, active: true },
  { code: "ngung", label: "Ngừng", start_time: "09:00", sort: 3, active: false },
];

const WIDE_QUOTAS: PayrollShiftQuota[] = [
  { shift_code: "sang", iso_dow: null, needed: 99 },
  { shift_code: "chieu", iso_dow: null, needed: 99 },
];

function weekEntries(
  overrides: Record<string, string | null> = {},
): PayrollShiftRegistrationInput[] {
  const dates = [D0, D1, D2, D3, D4, D5, D6];
  return dates.map((date, index) => ({
    work_date: date,
    shift_code: overrides[date] !== undefined
      ? overrides[date]
      : index === 6
        ? null
        : "sang",
  }));
}

function context(overrides: Record<string, unknown> = {}) {
  return {
    week_start: WEEK,
    shift_types: SHIFT_TYPES,
    quotas: WIDE_QUOTAS,
    settings: { min_off_days_per_week: 1 },
    now: ON_TIME,
    ...overrides,
  };
}

test("a complete week before the deadline registers normally", () => {
  const result = validateRegistration(weekEntries(), context());
  assert.equal(result.ok, true);
  assert.equal(result.error, null);
  assert.equal(result.entries.length, 7);
  assert.equal(result.entries.filter((entry) => entry.state === "waitlist").length, 0);
});

test("submitting after the deadline is rejected", () => {
  const result = validateRegistration(weekEntries(), context({
    now: "2026-11-07T12:00:01+07:00",
  }));
  assert.equal(result.ok, false);
  assert.equal(result.error, SHIFT_ERROR_CLOSED);
});

test("submitting before the opening instant is rejected", () => {
  const result = validateRegistration(weekEntries(), context({
    now: "2026-11-02T23:59:00+07:00",
  }));
  assert.equal(result.ok, false);
  assert.equal(result.error, SHIFT_ERROR_CLOSED);
});

test("a missing day makes the week incomplete", () => {
  const entries = weekEntries().slice(0, 6);
  const result = validateRegistration(entries, context());
  assert.equal(result.ok, false);
  assert.equal(result.error, SHIFT_ERROR_INCOMPLETE_WEEK);
});

test("a duplicate day makes the week incomplete", () => {
  const entries = weekEntries();
  entries[1] = { work_date: D0, shift_code: "sang" };
  const result = validateRegistration(entries, context());
  assert.equal(result.ok, false);
  assert.equal(result.error, SHIFT_ERROR_INCOMPLETE_WEEK);
});

test("a closed date is ignored and does not need an entry", () => {
  const result = validateRegistration(weekEntries(), context({ closed_dates: [D3] }));
  assert.equal(result.ok, true);
  assert.equal(result.entries.length, 6);
  assert.equal(result.entries.some((entry) => entry.work_date === D3), false);
});

test("a week without a day off is rejected", () => {
  const entries = weekEntries({ [D6]: "sang" });
  const result = validateRegistration(entries, context());
  assert.equal(result.ok, false);
  assert.equal(result.error, SHIFT_ERROR_DAY_OFF_REQUIRED);
});

test("an unknown or inactive shift is rejected", () => {
  const unknown = weekEntries({ [D2]: "khong_ton_tai" });
  assert.equal(validateRegistration(unknown, context()).error, SHIFT_ERROR_INVALID_SHIFT);

  const inactive = weekEntries({ [D2]: "ngung" });
  assert.equal(validateRegistration(inactive, context()).error, SHIFT_ERROR_INVALID_SHIFT);
});

test("a full shift is saved as waitlist", () => {
  const quotas: PayrollShiftQuota[] = [
    { shift_code: "sang", iso_dow: null, needed: 1 },
    { shift_code: "chieu", iso_dow: null, needed: 10 },
  ];
  const existing: PayrollShiftEntry[] = [
    { work_date: D2, shift_code: "sang", state: "registered", employee_code: "E_OTHER" },
  ];
  const result = validateRegistration(
    weekEntries({ [D2]: "sang" }),
    context({ quotas, existing_entries: existing }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.entries.find((entry) => entry.work_date === D2)?.state, "waitlist");
});

test("a day off beyond the daily limit is saved as waitlist", () => {
  const existing: PayrollShiftEntry[] = [
    { work_date: D6, shift_code: null, state: "registered", employee_code: "E1" },
    { work_date: D6, shift_code: null, state: "registered", employee_code: "E2" },
  ];
  const result = validateRegistration(
    weekEntries(),
    context({ existing_entries: existing, settings: { max_off_per_day: 2, min_off_days_per_week: 1 } }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.entries.find((entry) => entry.work_date === D6)?.state, "waitlist");
});

test("a quota group shares one needed number across two shifts", () => {
  const quotas: PayrollShiftQuota[] = [
    { shift_code: "sang", iso_dow: null, needed: 4, quota_group: "morning" },
    { shift_code: "chieu", iso_dow: null, needed: 4, quota_group: "morning" },
  ];
  const existing: PayrollShiftEntry[] = [
    { work_date: D2, shift_code: "sang", state: "registered", employee_code: "E1" },
    { work_date: D2, shift_code: "sang", state: "registered", employee_code: "E2" },
    { work_date: D2, shift_code: "chieu", state: "registered", employee_code: "E3" },
    { work_date: D2, shift_code: "chieu", state: "registered", employee_code: "E4" },
  ];
  const groupCoverage = coverage(existing, quotas, WEEK);
  const morning = groupCoverage.quota_groups.find((group) =>
    group.work_date === D2 && group.quota_group === "morning"
  );
  assert.ok(morning);
  assert.equal(morning.registered, 4);
  assert.equal(morning.needed, 4);
  assert.equal(morning.full, true);

  const result = validateRegistration(
    weekEntries({ [D2]: "chieu" }),
    context({ quotas, existing_entries: existing }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.entries.find((entry) => entry.work_date === D2)?.state, "waitlist");
});

test("a carried suggestion is the previous week moved +7 days", () => {
  const suggestion = carrySuggestion([
    { work_date: "2026-11-02", shift_code: "sang", state: "registered" },
    { work_date: "2026-11-03", shift_code: null, state: "registered" },
  ]);
  assert.deepEqual(suggestion, [
    { work_date: D0, shift_code: "sang", state: "registered", carried: true },
    { work_date: D1, shift_code: null, state: "registered", carried: true },
  ]);
});

test("per-date cutoff uses the registered shift and falls back otherwise", () => {
  const entries: PayrollShiftEntry[] = [
    { work_date: D0, shift_code: "sang", state: "registered" },
    { work_date: D1, shift_code: null, state: "registered" },
    { work_date: D2, shift_code: "chieu", state: "waitlist" },
  ];
  assert.equal(cutoffForDate(D0, entries, SHIFT_TYPES, "07:00"), "07:00");
  assert.equal(cutoffForDate(D0, entries, [{ ...SHIFT_TYPES[0], start_time: "08:00" }], "07:00"), "08:00");
  assert.equal(cutoffForDate(D1, entries, SHIFT_TYPES, "07:30"), "07:30");
  assert.equal(cutoffForDate(D2, entries, SHIFT_TYPES, "07:30"), "07:30");
  assert.equal(cutoffForDate(D3, entries, SHIFT_TYPES, null), "07:00");
});

test("Monday/Sunday week boundaries at 23:59 and 00:01 Vietnam time", () => {
  // Sunday 2026-11-08 23:59 Vietnam is still the week starting 2026-11-02.
  assert.equal(weekStart("2026-11-08T23:59:00+07:00"), "2026-11-02");
  assert.equal(weekStart("2026-11-08T16:59:00Z"), "2026-11-02");
  // Monday 2026-11-09 00:01 Vietnam starts the next week.
  assert.equal(weekStart("2026-11-09T00:01:00+07:00"), WEEK);
  assert.equal(weekStart("2026-11-08T17:01:00Z"), WEEK);
  // A plain date is already a calendar date.
  assert.equal(weekStart("2026-11-09"), WEEK);
});

test("deadline and opening instants are in Vietnam time", () => {
  assert.equal(shiftDeadline(WEEK).toISOString(), "2026-11-07T05:00:00.000Z");
  assert.equal(shiftOpensAt(WEEK).toISOString(), "2026-11-02T17:00:00.000Z");
});

// ---------------------------------------------------------------------------
// Phase 2: change / leave request validation and error mapping
// ---------------------------------------------------------------------------

test("request validation accepts a future change and leave", () => {
  const change = validateShiftRequestInput({
    work_date: D1,
    kind: "change",
    to_shift_code: "sang",
    reason: "  Đổi lịch gia đình  ",
  }, D0);
  assert.equal(change.ok, true);
  assert.equal(change.error, null);
  assert.equal(change.kind, "change");
  assert.equal(change.toShiftCode, "sang");
  assert.equal(change.reason, "Đổi lịch gia đình");

  const leave = validateShiftRequestInput({
    work_date: D1,
    kind: "leave",
    to_shift_code: "sang",
    reason: "Việc nhà",
  }, D0);
  assert.equal(leave.ok, true);
  assert.equal(leave.toShiftCode, null);
});

test("request validation rejects past dates, bad kinds, missing change shift and short reasons", () => {
  assert.equal(
    validateShiftRequestInput({ work_date: "2026-11-08", kind: "leave", reason: "Việc nhà" }, D0).error,
    SHIFT_REQUEST_ERROR_PAST_DATE,
  );
  assert.equal(
    validateShiftRequestInput({ work_date: D1, kind: "swap", reason: "Việc nhà" }, D0).error,
    SHIFT_REQUEST_ERROR_INVALID_KIND,
  );
  assert.equal(
    validateShiftRequestInput({ work_date: D1, kind: "change", reason: "Việc nhà" }, D0).error,
    SHIFT_ERROR_INVALID_SHIFT,
  );
  assert.equal(
    validateShiftRequestInput({ work_date: D1, kind: "leave", reason: "ab" }, D0).error,
    SHIFT_REQUEST_ERROR_REASON_REQUIRED,
  );
});

test("request error map returns Vietnamese messages and statuses", () => {
  assert.deepEqual(mapShiftRequestError("shift_request_duplicate"), {
    status: 409,
    code: "shift_request_duplicate",
    message: "Bạn đã có một yêu cầu đang chờ cho ngày này.",
  });
  assert.equal(mapShiftRequestError({ message: "shift_request_stale" }).status, 409);
  assert.equal(mapShiftRequestError("shift_request_past_date").status, 400);
  assert.equal(mapShiftRequestError("shift_not_eligible").status, 403);
  assert.equal(mapShiftRequestError("something_else").code, "payslip_shift_failed");
});

test("request normaliser tolerates missing optional fields", () => {
  assert.equal(normalizeShiftRequest(null), null);
  assert.equal(normalizeShiftRequest({}), null);
  const request = normalizeShiftRequest({
    id: "r1",
    work_date: D1,
    kind: "leave",
    reason: "Việc nhà",
    state: "pending",
  });
  assert.ok(request);
  assert.equal(request.id, "r1");
  assert.equal(request.kind, "leave");
  assert.equal(request.from_shift_code, null);
  assert.equal(request.to_shift_code, null);
  assert.equal(request.decision_note, null);
  assert.equal(request.created_at, null);
});
