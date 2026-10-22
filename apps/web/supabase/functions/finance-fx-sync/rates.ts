/**
 * Pure helpers for the Vietcombank USD transfer-rate sync.
 *
 * No Deno or Supabase APIs live here so the same code can be covered by
 * node:test (rates.test.ts) and imported by the Edge Function handler.
 */

export const VIETCOMBANK_RATES_URL = "https://www.vietcombank.com.vn/api/exchangerates";
export const MIN_USD_TRANSFER_VND = 15_000;
export const MAX_USD_TRANSFER_VND = 40_000;
export const MAX_SYNC_DAYS = 400;
export const DEFAULT_SYNC_DAYS = 8;

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const VN_TIME_ZONE = "Asia/Ho_Chi_Minh";

export type FxSyncWindow =
  | { ok: true; dates: string[] }
  | { ok: false; error: string };

/** Vietnam calendar date key (YYYY-MM-DD) for an instant. */
export function vietnamDateKey(instant: Date = new Date()): string {
  if (!(instant instanceof Date) || Number.isNaN(instant.getTime())) return "";

  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: VN_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(instant);

  const part = (type: string) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function isDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_KEY_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Add whole days to a YYYY-MM-DD key without depending on local time. */
export function addDays(dateKey: string, days: number): string {
  if (!isDateKey(dateKey) || !Number.isFinite(days)) return "";
  const parsed = new Date(`${dateKey}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + Math.trunc(days));
  return parsed.toISOString().slice(0, 10);
}

/** Inclusive list of date keys. Returns [] for an invalid or reversed range. */
export function buildDateRange(from: string, to: string): string[] {
  if (!isDateKey(from) || !isDateKey(to) || from > to) return [];

  const dates: string[] = [];
  let current = from;
  while (current <= to) {
    dates.push(current);
    current = addDays(current, 1);
  }
  return dates;
}

/**
 * Resolve the Edge Function body into the dates to fetch.
 *
 * Default: today plus the previous 7 Vietnam dates. An explicit {from,to}
 * backfills the inclusive range, capped at MAX_SYNC_DAYS.
 */
export function resolveSyncWindow(input: unknown, now: Date = new Date()): FxSyncWindow {
  const today = vietnamDateKey(now);
  if (!today) return { ok: false, error: "invalid_clock" };

  const body = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const hasFrom = body.from !== undefined && body.from !== null && body.from !== "";
  const hasTo = body.to !== undefined && body.to !== null && body.to !== "";

  if (!hasFrom && !hasTo) {
    return {
      ok: true,
      dates: buildDateRange(addDays(today, -(DEFAULT_SYNC_DAYS - 1)), today),
    };
  }

  if (!hasFrom || !hasTo) return { ok: false, error: "from_and_to_required" };
  if (!isDateKey(body.from) || !isDateKey(body.to)) return { ok: false, error: "invalid_date" };
  if (body.from > body.to) return { ok: false, error: "invalid_range" };

  const dates = buildDateRange(body.from, body.to);
  if (dates.length === 0) return { ok: false, error: "invalid_range" };
  if (dates.length > MAX_SYNC_DAYS) return { ok: false, error: "range_too_large" };

  return { ok: true, dates };
}

function parseVndRate(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  const normalized = String(raw).replace(/,/g, "").trim();
  if (!normalized) return null;

  const rate = Number(normalized);
  if (!Number.isFinite(rate)) return null;
  if (rate < MIN_USD_TRANSFER_VND || rate > MAX_USD_TRANSFER_VND) return null;

  return Math.round(rate * 100) / 100;
}

/** Extract the USD transfer rate from the Vietcombank exchangerates payload. */
export function parseUsdTransferRate(payload: unknown): number | null {
  const data = (payload as { Data?: unknown } | null | undefined)?.Data;
  if (!Array.isArray(data)) return null;

  const usd = data.find((item) => {
    if (!item || typeof item !== "object") return false;
    return String((item as { currencyCode?: unknown }).currencyCode || "").toUpperCase() === "USD";
  });
  if (!usd) return null;

  return parseVndRate((usd as { transfer?: unknown }).transfer);
}
