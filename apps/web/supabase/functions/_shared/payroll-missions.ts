// Pure logic for monthly missions + surprise gifts (payroll_bn).
//
// No Deno-only imports and no DOM globals: `node --test` runs this file
// directly. The rules mirror 20261110090000_payroll_missions.sql:
//   * campaign items are configuration, validated here and in SQL;
//   * provisional progress comes only from accepted attendance events;
//   * the review is final and its amounts always come from the campaign items;
//   * a quarterly ticket needs at least one earned item and a draw_ticket item.

export type MissionItemKind =
  | "attendance_regular"
  | "punctual"
  | "draw_ticket"
  | "manual";

export const MISSION_ITEM_KINDS: readonly MissionItemKind[] = [
  "attendance_regular",
  "punctual",
  "draw_ticket",
  "manual",
];

export type MissionOfferStatus = "pending" | "accepted" | "declined";
export type MissionDecision = "accept" | "decline";

export interface MissionCampaignItem {
  key: string;
  label: string;
  detail?: string | null;
  kind: MissionItemKind;
  amount_vnd: number;
  params?: Record<string, unknown> | null;
}

export interface MissionCampaignDefinition {
  starts_on: string;
  ends_on: string;
  items: MissionCampaignItem[];
  draw?: Record<string, unknown> | null;
}

export interface MissionOfferState {
  status: MissionOfferStatus;
  shift_start?: string | null;
  offered_at?: string | null;
  responded_at?: string | null;
}

export interface MissionAttendanceEvent {
  eventKind?: "in" | "out";
  event_kind?: "in" | "out";
  decision: "accepted" | "rejected";
  workDate?: string;
  work_date?: string;
  serverReceivedAt?: string;
  server_received_at?: string;
}

export interface MissionProgressDetail {
  days_with_in: number;
  days_complete: number;
  days_missing_out: number;
  on_time_days: number;
  min_days: number;
  grace_minutes: number;
  cutoff: string;
  window_from: string;
  window_to: string;
}

export interface MissionProgressItem {
  key: string;
  kind: MissionItemKind;
  met: boolean;
  detail: MissionProgressDetail;
}

export interface MissionEarnedAmount {
  key: string;
  amount_vnd: number;
}

export interface MissionItemValidation {
  ok: boolean;
  error: string | null;
}

export interface MissionResponseResult {
  ok: boolean;
  status: MissionOfferStatus;
  respondedAt: string | null;
  changed: boolean;
  error: string | null;
}

export interface MissionReviewInput {
  items: readonly MissionCampaignItem[];
  earnedKeys: readonly string[];
  disqualified: boolean;
  employeeLeftBeforeDraw?: boolean;
}

export interface MissionTicketEligibility {
  /** A row must exist (it may still be voided). */
  issue: boolean;
  voidReason: string | null;
}

export interface MissionEarnedResult {
  earned: MissionEarnedAmount[];
  unknownKeys: string[];
}

export interface MissionReviewResult {
  ok: boolean;
  error: string | null;
  earned: MissionEarnedAmount[];
  ticket: MissionTicketEligibility;
}

export interface MissionProgressWindow {
  from: string;
  to: string;
  empty: boolean;
}

const DEFAULT_CUTOFF = "07:00";

export function isMissionItemKind(value: unknown): value is MissionItemKind {
  return typeof value === "string" && (MISSION_ITEM_KINDS as readonly string[]).includes(value);
}

/**
 * Validate the campaign item shape. This mirrors payroll_mission_validate_items:
 * an array of objects, unique non-blank keys, known kinds, non-negative numeric
 * amounts and an optional object params.
 */
export function validateMissionItems(items: unknown): MissionItemValidation {
  if (!Array.isArray(items)) {
    return { ok: false, error: "items_must_be_array" };
  }

  const keys = new Set<string>();
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index] as Record<string, unknown> | null;
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      return { ok: false, error: `item_${index + 1}_must_be_object` };
    }

    const key = typeof item.key === "string" ? item.key.trim() : "";
    if (key === "") return { ok: false, error: `item_${index + 1}_key_required` };
    if (keys.has(key)) return { ok: false, error: `item_duplicate_key:${key}` };
    keys.add(key);

    const label = typeof item.label === "string" ? item.label.trim() : "";
    if (label === "") return { ok: false, error: `item_${index + 1}_label_required` };

    if (!isMissionItemKind(item.kind)) {
      return { ok: false, error: `item_${index + 1}_invalid_kind` };
    }

    const amount = item.amount_vnd;
    if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) {
      return { ok: false, error: `item_${index + 1}_invalid_amount` };
    }

    if (
      item.params !== undefined &&
      item.params !== null &&
      (typeof item.params !== "object" || Array.isArray(item.params))
    ) {
      return { ok: false, error: `item_${index + 1}_params_must_be_object` };
    }
  }

  return { ok: true, error: null };
}

/** Today in Vietnam (YYYY-MM-DD), without relying on the host timezone. */
export function vietnamDate(input: Date | string | number = new Date()): string {
  const date = input instanceof Date ? input : new Date(input);
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

/** Minutes since local midnight in Vietnam, for punctual comparisons. */
export function vietnamMinutesOfDay(input: Date | string | number): number | null {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Ho_Chi_Minh",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return hour * 60 + minute;
}

function timeTextToMinutes(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = value.trim().match(/^([01][0-9]|2[0-3]):([0-5][0-9])(?::[0-5][0-9])?$/);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function minutesToText(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function numericParam(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.trunc(value);
  if (typeof value === "string" && /^[0-9]+$/.test(value.trim())) return Number(value.trim());
  return fallback;
}

export interface MissionCutoff {
  /** HH:MM text used in the progress detail. */
  cutoff: string;
  cutoffMinutes: number;
  graceMinutes: number;
}

/**
 * Punctual cutoff: per-employee offer.shift_start wins, otherwise the item
 * params.cutoff (default 07:00). grace_minutes comes from item params (0).
 */
export function missionCutoff(
  item: MissionCampaignItem,
  offer: MissionOfferState,
): MissionCutoff {
  const params = (item.params ?? {}) as Record<string, unknown>;
  const offerCutoff = timeTextToMinutes(offer.shift_start);
  const itemCutoff = timeTextToMinutes(params.cutoff);
  const cutoffMinutes = offerCutoff ?? itemCutoff ?? timeTextToMinutes(DEFAULT_CUTOFF)!;
  return {
    cutoff: minutesToText(cutoffMinutes),
    cutoffMinutes,
    graceMinutes: numericParam(params.grace_minutes, 0),
  };
}

/**
 * Provisional window: max(campaign.starts_on, accepted date) .. min(ends_on,
 * today in Vietnam). Before acceptance the start stays at the campaign start.
 */
export function missionProgressWindow(
  campaign: MissionCampaignDefinition,
  offer: MissionOfferState,
  today: string = vietnamDate(),
): MissionProgressWindow {
  const acceptedDate = offer.status === "accepted" && offer.responded_at
    ? vietnamDate(offer.responded_at)
    : "";
  const from = acceptedDate && acceptedDate > campaign.starts_on
    ? acceptedDate
    : campaign.starts_on;
  const to = campaign.ends_on < today ? campaign.ends_on : today;
  return { from, to, empty: from > to };
}

function eventDate(event: MissionAttendanceEvent): string {
  const explicit = event.workDate ?? event.work_date;
  if (typeof explicit === "string" && /^\d{4}-\d{2}-\d{2}$/.test(explicit)) return explicit;
  const instant = event.serverReceivedAt ?? event.server_received_at;
  return instant ? vietnamDate(instant) : "";
}

function eventInstant(event: MissionAttendanceEvent): string {
  return event.serverReceivedAt ?? event.server_received_at ?? "";
}

function eventKind(event: MissionAttendanceEvent): "in" | "out" {
  return (event.eventKind ?? event.event_kind) === "out" ? "out" : "in";
}

interface AttendanceDay {
  firstInMinutes: number | null;
  hasOut: boolean;
  firstInAt: string;
}

/**
 * Evaluate every campaign item from accepted attendance events. Provisional
 * only: the manager review is final and may disqualify the offer.
 */
export function evaluateMissionProgress(
  campaign: MissionCampaignDefinition,
  offer: MissionOfferState,
  events: readonly MissionAttendanceEvent[],
  today: string = vietnamDate(),
): MissionProgressItem[] {
  const window = missionProgressWindow(campaign, offer, today);
  const days = new Map<string, AttendanceDay>();

  if (!window.empty) {
    for (const event of events) {
      if (event.decision !== "accepted") continue;
      const date = eventDate(event);
      if (date < window.from || date > window.to) continue;

      const kind = eventKind(event);
      const instant = eventInstant(event);
      const minutes = instant ? vietnamMinutesOfDay(instant) : null;
      const current = days.get(date) ?? { firstInMinutes: null, hasOut: false, firstInAt: "" };

      if (kind === "in") {
        const isEarlier = current.firstInAt === "" || (instant !== "" && instant < current.firstInAt);
        if (current.firstInMinutes === null || isEarlier) {
          current.firstInMinutes = minutes;
          current.firstInAt = instant;
        }
      } else {
        current.hasOut = true;
      }
      days.set(date, current);
    }
  }

  const dayList = [...days.values()];
  const daysWithIn = dayList.filter((day) => day.firstInMinutes !== null).length;
  const daysComplete = dayList.filter((day) => day.firstInMinutes !== null && day.hasOut).length;
  const daysMissingOut = dayList.filter((day) => day.firstInMinutes !== null && !day.hasOut).length;

  return campaign.items.map((item) => {
    const cutoff = missionCutoff(item, offer);
    const onTimeDays = dayList.filter((day) =>
      day.firstInMinutes !== null
      && day.firstInMinutes <= cutoff.cutoffMinutes + cutoff.graceMinutes
    ).length;
    const params = (item.params ?? {}) as Record<string, unknown>;
    const minDays = numericParam(params.min_days, 1);

    let met = false;
    if (item.kind === "attendance_regular") {
      met = daysWithIn >= minDays && daysMissingOut === 0;
    } else if (item.kind === "punctual") {
      met = daysWithIn >= 1 && onTimeDays === daysWithIn;
    }

    return {
      key: item.key,
      kind: item.kind,
      met,
      detail: {
        days_with_in: daysWithIn,
        days_complete: daysComplete,
        days_missing_out: daysMissingOut,
        on_time_days: onTimeDays,
        min_days: minDays,
        grace_minutes: cutoff.graceMinutes,
        cutoff: cutoff.cutoff,
        window_from: window.from,
        window_to: window.to,
      },
    };
  });
}

/** Accept or decline exactly once. Repeating the same decision is idempotent. */
export function respondToMissionOffer(
  offer: MissionOfferState,
  decision: MissionDecision,
  now: string = new Date().toISOString(),
): MissionResponseResult {
  if (decision !== "accept" && decision !== "decline") {
    return {
      ok: false,
      status: offer.status,
      respondedAt: offer.responded_at ?? null,
      changed: false,
      error: "invalid_decision",
    };
  }

  const desired: MissionOfferStatus = decision === "accept" ? "accepted" : "declined";

  if (offer.status === desired) {
    return {
      ok: true,
      status: offer.status,
      respondedAt: offer.responded_at ?? null,
      changed: false,
      error: null,
    };
  }

  if (offer.status !== "pending") {
    return {
      ok: false,
      status: offer.status,
      respondedAt: offer.responded_at ?? null,
      changed: false,
      error: "already_responded",
    };
  }

  return {
    ok: true,
    status: desired,
    respondedAt: now,
    changed: true,
    error: null,
  };
}

/**
 * Review amount derivation. Only item keys are accepted from the caller; the
 * amount always comes from the campaign item. Unknown keys are reported and
 * must never be turned into money.
 */
export function missionEarnedAmounts(
  items: readonly MissionCampaignItem[],
  earnedKeys: readonly string[],
): MissionEarnedResult {
  const byKey = new Map<string, MissionCampaignItem>();
  for (const item of items) byKey.set(item.key, item);

  const requested = new Set<string>();
  const unknownKeys: string[] = [];
  for (const raw of earnedKeys) {
    const key = typeof raw === "string" ? raw.trim() : "";
    if (key === "" || requested.has(key)) continue;
    requested.add(key);
    if (!byKey.has(key)) unknownKeys.push(key);
  }

  const earned: MissionEarnedAmount[] = [];
  for (const key of [...requested].sort()) {
    const item = byKey.get(key);
    if (item) earned.push({ key: item.key, amount_vnd: item.amount_vnd });
  }

  return { earned, unknownKeys: unknownKeys.sort() };
}

/**
 * A quarterly ticket is issued only when the review earned at least one item
 * and the campaign actually declares a draw_ticket item. An employee who left
 * before the draw date keeps the row but it is void.
 */
export function missionTicketEligibility(
  items: readonly MissionCampaignItem[],
  earned: readonly MissionEarnedAmount[],
  employeeLeftBeforeDraw = false,
): MissionTicketEligibility {
  if (earned.length === 0) {
    return { issue: false, voidReason: "no_earned_items" };
  }
  if (!items.some((item) => item.kind === "draw_ticket")) {
    return { issue: false, voidReason: "no_draw_item" };
  }
  return {
    issue: true,
    voidReason: employeeLeftBeforeDraw ? "employee_left_before_draw" : null,
  };
}

/** Final review: amounts from campaign items, disqualified always earns zero. */
export function evaluateMissionReview(input: MissionReviewInput): MissionReviewResult {
  const disqualified = input.disqualified === true;

  if (disqualified) {
    return {
      ok: true,
      error: null,
      earned: [],
      ticket: { issue: false, voidReason: "disqualified" },
    };
  }

  const { earned, unknownKeys } = missionEarnedAmounts(input.items, input.earnedKeys);
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      error: `unknown_item:${unknownKeys.join(",")}`,
      earned: [],
      ticket: { issue: false, voidReason: "invalid_review" },
    };
  }

  return {
    ok: true,
    error: null,
    earned,
    ticket: missionTicketEligibility(
      input.items,
      earned,
      input.employeeLeftBeforeDraw === true,
    ),
  };
}
