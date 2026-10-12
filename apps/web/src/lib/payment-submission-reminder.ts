// Pure decision helpers for "Trình chi gấp: nhắc lại trên Zalo mỗi 6 tiếng khi
// còn phiếu chưa chi". No Supabase / React imports so the interval, the quiet
// hours and the next-due math stay unit-testable and mirror the SQL decision in
// public.enqueue_payment_submission_reminders.

export const REMINDER_INTERVAL_HOURS = 6;
export const REMINDER_MAX_ROUNDS = 8;
export const QUIET_HOURS = { start: 22, end: 7 } as const;

const HOUR_MS = 60 * 60 * 1000;
// Vietnam has no DST, so shifting the UTC epoch by seven hours makes the local
// hour exact regardless of the host timezone.
const VIETNAM_OFFSET_MS = 7 * HOUR_MS;

export type ReminderReason = "paid" | "max_rounds" | "too_soon" | "quiet_hours" | "due";

export interface ReminderDueInput {
  /** When the submission (and its created notice) was made. */
  createdAt: Date;
  /** When the last reminder was enqueued, or null when there is none yet. */
  lastReminderAt?: Date | null;
  /** Reminders already enqueued for this submission. */
  rounds: number;
  /** Items of the submission whose request is still 'unpaid' or 'partial'. */
  unpaidCount: number;
  /** The instant the scheduler is reasoning about. */
  now: Date;
}

export interface ReminderDueResult {
  due: boolean;
  reason: ReminderReason;
  /** Next instant a reminder may be considered, or null when none will come. */
  nextAt: Date | null;
}

/** Vietnam local hour (0..23) of an instant, independent of the host timezone. */
export function vietnamHour(dateVn: Date): number {
  return new Date(dateVn.getTime() + VIETNAM_OFFSET_MS).getUTCHours();
}

/** True inside the 22:00-06:59 Asia/Ho_Chi_Minh quiet window. */
export function isQuietHour(dateVn: Date): boolean {
  const hour = vietnamHour(dateVn);
  return hour >= QUIET_HOURS.start || hour < QUIET_HOURS.end;
}

/** The next 07:00 Vietnam time at or after `dateVn` (only meaningful in quiet hours). */
function nextQuietEnd(dateVn: Date): Date {
  const shifted = new Date(dateVn.getTime() + VIETNAM_OFFSET_MS);
  const hour = shifted.getUTCHours();
  shifted.setUTCHours(QUIET_HOURS.end, 0, 0, 0);
  if (hour >= QUIET_HOURS.end) {
    shifted.setUTCDate(shifted.getUTCDate() + 1);
  }
  return new Date(shifted.getTime() - VIETNAM_OFFSET_MS);
}

/**
 * Decide whether a submission deserves a reminder now. Mirrors
 * public.enqueue_payment_submission_reminders:
 *   - no unpaid/partial item left  -> 'paid';
 *   - 8 rounds already enqueued    -> 'max_rounds';
 *   - under 6h since the created notice / last reminder -> 'too_soon' (nextAt);
 *   - inside quiet hours           -> 'quiet_hours' (nextAt = next 07:00 VN);
 *   - otherwise                    -> 'due'.
 */
export function nextReminderDue(input: ReminderDueInput): ReminderDueResult {
  const rounds = Number.isFinite(input.rounds) ? Math.max(0, Math.trunc(input.rounds)) : 0;
  const unpaidCount = Number.isFinite(input.unpaidCount) ? input.unpaidCount : 0;

  if (unpaidCount <= 0) {
    return { due: false, reason: "paid", nextAt: null };
  }
  if (rounds >= REMINDER_MAX_ROUNDS) {
    return { due: false, reason: "max_rounds", nextAt: null };
  }

  const base = input.lastReminderAt ?? input.createdAt;
  const dueAt = new Date(base.getTime() + REMINDER_INTERVAL_HOURS * HOUR_MS);

  if (input.now.getTime() < dueAt.getTime()) {
    return { due: false, reason: "too_soon", nextAt: dueAt };
  }
  if (isQuietHour(input.now)) {
    return { due: false, reason: "quiet_hours", nextAt: nextQuietEnd(input.now) };
  }
  return { due: true, reason: "due", nextAt: null };
}
