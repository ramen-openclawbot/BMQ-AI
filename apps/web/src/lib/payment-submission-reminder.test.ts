import assert from "node:assert/strict";
import test from "node:test";

import {
  QUIET_HOURS,
  REMINDER_INTERVAL_HOURS,
  REMINDER_MAX_ROUNDS,
  isQuietHour,
  nextReminderDue,
  vietnamHour,
  type ReminderDueResult,
} from "./payment-submission-reminder.ts";

const at = (iso: string): Date => new Date(iso);

const assertResult = (result: ReminderDueResult, expected: Partial<ReminderDueResult>): void => {
  assert.equal(result.due, expected.due, `due (${result.reason})`);
  assert.equal(result.reason, expected.reason);
  if ("nextAt" in expected) {
    assert.equal(result.nextAt?.getTime() ?? null, expected.nextAt?.getTime() ?? null);
  }
};

test("exposes the shared constants", () => {
  assert.equal(REMINDER_INTERVAL_HOURS, 6);
  assert.equal(REMINDER_MAX_ROUNDS, 8);
  assert.deepEqual(QUIET_HOURS, { start: 22, end: 7 });
});

test("computes the Vietnam hour regardless of host timezone", () => {
  // 00:00Z is 07:00 in Vietnam.
  assert.equal(vietnamHour(at("2026-10-07T00:00:00.000Z")), 7);
  assert.equal(vietnamHour(at("2026-10-07T15:00:00.000Z")), 22);
  assert.equal(vietnamHour(at("2026-10-07T23:59:00.000Z")), 6);
});

test("marks quiet hours 22:00-06:59 VN and opens again at 07:00", () => {
  assert.equal(isQuietHour(at("2026-10-07T15:00:00.000Z")), true); // 22:00 VN
  assert.equal(isQuietHour(at("2026-10-07T23:59:00.000Z")), true); // 06:59 VN
  assert.equal(isQuietHour(at("2026-10-08T00:00:00.000Z")), false); // 07:00 VN
  assert.equal(isQuietHour(at("2026-10-07T09:00:00.000Z")), false); // 16:00 VN
});

test("is due exactly 6 hours after creation", () => {
  const createdAt = at("2026-10-07T00:00:00.000Z"); // 07:00 VN

  assertResult(
    nextReminderDue({ createdAt, rounds: 0, unpaidCount: 1, now: at("2026-10-07T05:59:00.000Z") }),
    { due: false, reason: "too_soon", nextAt: at("2026-10-07T06:00:00.000Z") },
  );
  assertResult(
    nextReminderDue({ createdAt, rounds: 0, unpaidCount: 1, now: at("2026-10-07T06:00:00.000Z") }),
    { due: true, reason: "due", nextAt: null },
  );
});

test("counts 6 hours from the last reminder, not from creation", () => {
  const createdAt = at("2026-10-07T00:00:00.000Z"); // 07:00 VN
  const lastReminderAt = at("2026-10-07T08:00:00.000Z"); // 15:00 VN

  // Creation + 6h (06:00Z) already passed, but the last reminder + 6h (14:00Z) has not.
  assertResult(
    nextReminderDue({
      createdAt,
      lastReminderAt,
      rounds: 1,
      unpaidCount: 2,
      now: at("2026-10-07T13:59:00.000Z"),
    }),
    { due: false, reason: "too_soon", nextAt: at("2026-10-07T14:00:00.000Z") },
  );
  assertResult(
    nextReminderDue({
      createdAt,
      lastReminderAt,
      rounds: 1,
      unpaidCount: 2,
      now: at("2026-10-07T14:00:00.000Z"),
    }),
    { due: true, reason: "due", nextAt: null },
  );
});

test("stops after 8 rounds", () => {
  const createdAt = at("2026-10-01T00:00:00.000Z");
  const now = at("2026-10-07T00:00:00.000Z");

  assertResult(
    nextReminderDue({ createdAt, rounds: 7, unpaidCount: 1, now }),
    { due: true, reason: "due", nextAt: null },
  );
  assertResult(
    nextReminderDue({ createdAt, rounds: 8, unpaidCount: 1, now }),
    { due: false, reason: "max_rounds", nextAt: null },
  );
});

test("stops when no unpaid item remains", () => {
  assertResult(
    nextReminderDue({
      createdAt: at("2026-10-01T00:00:00.000Z"),
      rounds: 0,
      unpaidCount: 0,
      now: at("2026-10-07T00:00:00.000Z"),
    }),
    { due: false, reason: "paid", nextAt: null },
  );
});

test("skips quiet hours 22:00-06:59 VN and is due again at 07:00", () => {
  const createdAt = at("2026-10-07T00:00:00.000Z"); // 07:00 VN -> due 13:00 VN

  // 22:00 VN: due since 13:00 but quiet -> next run after 07:00 the next day.
  assertResult(
    nextReminderDue({ createdAt, rounds: 0, unpaidCount: 1, now: at("2026-10-07T15:00:00.000Z") }),
    { due: false, reason: "quiet_hours", nextAt: at("2026-10-08T00:00:00.000Z") },
  );
  // 06:59 VN: same next 07:00 Vietnam morning.
  assertResult(
    nextReminderDue({ createdAt, rounds: 0, unpaidCount: 1, now: at("2026-10-07T23:59:00.000Z") }),
    { due: false, reason: "quiet_hours", nextAt: at("2026-10-08T00:00:00.000Z") },
  );
  // 07:00 VN: quiet hours are over -> send.
  assertResult(
    nextReminderDue({ createdAt, rounds: 0, unpaidCount: 1, now: at("2026-10-08T00:00:00.000Z") }),
    { due: true, reason: "due", nextAt: null },
  );
});

test("a reminder that comes due inside quiet hours waits for the morning instead of making a round", () => {
  // Created at 20:00 VN, so it is first due at 02:00 VN (quiet).
  const createdAt = at("2026-10-07T13:00:00.000Z");
  assertResult(
    nextReminderDue({ createdAt, rounds: 0, unpaidCount: 1, now: at("2026-10-07T19:00:00.000Z") }),
    { due: false, reason: "quiet_hours", nextAt: at("2026-10-08T00:00:00.000Z") },
  );
  assertResult(
    nextReminderDue({ createdAt, rounds: 0, unpaidCount: 1, now: at("2026-10-08T00:00:00.000Z") }),
    { due: true, reason: "due", nextAt: null },
  );
});
