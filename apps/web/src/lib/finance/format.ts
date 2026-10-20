import type { FinanceMonthKey } from "./types.ts";

const MONTH_KEY_PATTERN = /^(\d{4})-(\d{2})$/;

function assertMonthKey(value: string): { year: number; month: number } {
  const match = MONTH_KEY_PATTERN.exec(value);
  if (!match) throw new Error(`Invalid finance month key: ${value}`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12) throw new Error(`Invalid finance month key: ${value}`);
  return { year, month };
}

/** Null-safe VND millions with one decimal, e.g. 120500000 -> "120.5M". */
export function formatVndMillions(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  // Small but real amounts (10k–50k VND) keep two decimals instead of reading as zero.
  if (Math.abs(value) >= 10_000 && Math.abs(value) < 50_000) {
    return `${value < 0 ? "-" : ""}${(Math.abs(value) / 1_000_000).toFixed(2)}M`;
  }
  const millions = Math.round((value / 1_000_000) * 10) / 10;
  const normalized = millions === 0 ? 0 : millions;
  return `${normalized.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 })}M`;
}

/** Null-safe ratio as a percentage, e.g. 0.1234 -> "12.3%". */
export function formatPct(value: number | null | undefined, digits = 1): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const pct = value * 100;
  const rounded = Number(pct.toFixed(digits));
  return `${(rounded === 0 ? 0 : rounded).toFixed(digits)}%`;
}

/** "2026-09", "2026-09-14" or a Date -> "2026-09". */
export function toMonthKey(value: string | Date): FinanceMonthKey {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (MONTH_KEY_PATTERN.test(trimmed)) {
      assertMonthKey(trimmed);
      return trimmed;
    }
    const prefix = /^(\d{4})-(\d{2})/.exec(trimmed);
    if (prefix) {
      const key = `${prefix[1]}-${prefix[2]}`;
      assertMonthKey(key);
      return key;
    }
    const parsed = new Date(trimmed);
    if (Number.isNaN(parsed.getTime())) throw new Error(`Invalid finance date: ${value}`);
    return toMonthKey(parsed);
  }
  if (Number.isNaN(value.getTime())) throw new Error("Invalid finance date");
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function isMonthKey(value: string): value is FinanceMonthKey {
  const match = MONTH_KEY_PATTERN.exec(value);
  if (!match) return false;
  const month = Number(match[2]);
  return month >= 1 && month <= 12;
}

/** First calendar day of a month key, as YYYY-MM-DD. */
export function monthStart(month: FinanceMonthKey): string {
  assertMonthKey(month);
  return `${month}-01`;
}

/** Last calendar day of a month key, as YYYY-MM-DD. */
export function monthEnd(month: FinanceMonthKey): string {
  const { year, month: monthNumber } = assertMonthKey(month);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return `${month}-${String(lastDay).padStart(2, "0")}`;
}

/** Add or subtract whole months from a month key. */
export function addMonths(month: FinanceMonthKey, delta: number): FinanceMonthKey {
  const { year, month: monthNumber } = assertMonthKey(month);
  const shifted = new Date(Date.UTC(year, monthNumber - 1 + delta, 1));
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Inclusive month-key range. */
export function monthsBetween(from: FinanceMonthKey, to: FinanceMonthKey): FinanceMonthKey[] {
  assertMonthKey(from);
  assertMonthKey(to);
  if (from > to) return [];
  const months: FinanceMonthKey[] = [];
  let current = from;
  while (current <= to) {
    months.push(current);
    current = addMonths(current, 1);
  }
  return months;
}
