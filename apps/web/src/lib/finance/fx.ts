import type { FinanceFxMonth } from "./types";

type RawFxMonth = {
  month?: unknown;
  vnd_per_usd?: unknown;
  days?: unknown;
  source?: unknown;
};

const MONTH_KEY_PATTERN = /^\d{4}-\d{2}$/;

const finiteNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** Parse the finance_fx_monthly JSON array into the UI-facing camelCase shape. */
export function parseFxMonthly(json: unknown): FinanceFxMonth[] {
  if (!Array.isArray(json)) return [];

  const months: FinanceFxMonth[] = [];
  for (const item of json) {
    if (!item || typeof item !== "object") continue;

    const row = item as RawFxMonth;
    if (typeof row.month !== "string" || !MONTH_KEY_PATTERN.test(row.month)) continue;

    const rate = finiteNumber(row.vnd_per_usd);
    const days = finiteNumber(row.days);

    months.push({
      month: row.month,
      vndPerUsd: rate !== null && rate > 0 ? rate : null,
      days: days === null ? 0 : Math.max(0, Math.trunc(days)),
      source: typeof row.source === "string" && row.source ? row.source : null,
    });
  }

  return months;
}

/** Convert a VND amount to USD, rounded to cents. Returns null without a rate. */
export function vndToUsd(
  vnd: number | null | undefined,
  rate: number | null | undefined,
): number | null {
  if (vnd === null || vnd === undefined || rate === null || rate === undefined) return null;
  if (!Number.isFinite(vnd) || !Number.isFinite(rate) || rate <= 0) return null;
  return Math.round((vnd / rate) * 100) / 100;
}

function withThousands(value: number): string {
  return Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Compact USD display: $812, $31.2K, $1.24M (negative: -$31.2K). Null when there is no amount. */
export function formatUsd(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;

  const abs = Math.abs(value);
  if (abs < 1000) {
    const rounded = Math.round(abs);
    return rounded === 0 ? "$0" : `${value < 0 ? "-" : ""}$${rounded}`;
  }

  const sign = value < 0 ? "-" : "";
  if (abs < 1_000_000) return `${sign}$${(abs / 1000).toFixed(1)}K`;
  return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
}

/** "+$1.2K" / "−$1.2K"; zero stays unsigned. */
export function signedUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const text = formatUsd(Math.abs(value)) ?? "—";
  if (text === "$0") return text;
  return `${value > 0 ? "+" : "−"}${text}`;
}

/**
 * Month -> VND per USD. A month without a stored rate yet (e.g. the 1st before
 * the morning sync) borrows the nearest earlier month, else the nearest later one.
 */
export function rateByMonth(months: FinanceFxMonth[]): Record<string, number | null> {
  const sorted = [...months].sort((a, b) => a.month.localeCompare(b.month));
  const out: Record<string, number | null> = {};
  sorted.forEach((row, index) => {
    if (row.vndPerUsd !== null) {
      out[row.month] = row.vndPerUsd;
      return;
    }
    const earlier = sorted.slice(0, index).reverse().find((r) => r.vndPerUsd !== null);
    const later = sorted.slice(index + 1).find((r) => r.vndPerUsd !== null);
    out[row.month] = earlier?.vndPerUsd ?? later?.vndPerUsd ?? null;
  });
  return out;
}

/** Display the Vietcombank transfer rate: "1 USD = 25,650 VND". */
export function formatUsdRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate) || rate <= 0) {
    return "1 USD = — VND";
  }
  return `1 USD = ${withThousands(rate)} VND`;
}
