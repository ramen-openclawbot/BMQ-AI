/**
 * Pure Heo Đất Tết calculation layer.
 *
 * The Edge Function only loads rows; all money and day math lives here so the
 * UI contract can be tested without a database. Only the part of a day's bread
 * que that exceeds the November baseline earns extra money, and a day below the
 * baseline is never negative.
 */

export const HEO_CAMPAIGN_CODE = "heo-tet-2026";
export const HEO_NOV_BASELINE_START = "2026-11-01";
export const HEO_NOV_BASELINE_END = "2026-11-30";
export const HEO_NOV_BASELINE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const VIETNAM_UTC_OFFSET_MS = 7 * 60 * 60 * 1000;

export type HeoDailyQuantity = {
  date: string;
  quantity: number | string | null | undefined;
};

export type HeoSpinInput = {
  amount_vnd: number | string | null | undefined;
  bread_qty: number | string | null | undefined;
  prize_kind: string | null | undefined;
  is_jackpot: boolean | null | undefined;
  created_at: string;
  order_id: string;
};

export type HeoRecentSpin = {
  amount_vnd: number;
  bread_qty: number;
  prize_kind: string;
  is_jackpot: boolean;
  created_at: string;
  order_id: string;
};

export type HeoSummary = {
  extra_que: number;
  from_extra_vnd: number;
  from_spins_vnd: number;
  bread_qty: number;
  total_vnd: number;
  spin_count: number;
  days_to_break: number;
  recent_spins: HeoRecentSpin[];
};

export type ComputeHeoSummaryInput = {
  baselineAvgPerDay: number | string | null | undefined;
  dailyQuantities: HeoDailyQuantity[];
  spins: HeoSpinInput[];
  ratePerExtraQue: number | string | null | undefined;
  windowStart: string;
  windowEnd: string;
  breakOn: string;
  today: string | Date;
};

export type PreviewOrderExtraInput = {
  baselineAvgPerDay: number | string | null | undefined;
  existingDayQuantity: number | string | null | undefined;
  orderQuantity: number | string | null | undefined;
  ratePerExtraQue: number | string | null | undefined;
};

export type PreviewOrderExtra = {
  extra_que: number;
  extra_vnd: number;
  spin_eligible: boolean;
};

export function computeHeoSummary(input: ComputeHeoSummaryInput): HeoSummary {
  const baseline = Math.max(0, toNumber(input.baselineAvgPerDay));
  const rate = Math.max(0, toNumber(input.ratePerExtraQue));
  const windowStart = dateKey(input.windowStart);
  const windowEnd = dateKey(input.windowEnd);

  const dailyTotals = new Map<string, number>();
  input.dailyQuantities.forEach((row) => {
    const key = dateKey(row.date);
    if (!key) return;
    if (windowStart && key < windowStart) return;
    if (windowEnd && key > windowEnd) return;
    dailyTotals.set(key, (dailyTotals.get(key) ?? 0) + toNumber(row.quantity));
  });

  let extraQue = 0;
  dailyTotals.forEach((quantity) => {
    extraQue += Math.max(0, quantity - baseline);
  });

  const fromExtraVnd = Math.round(extraQue * rate);
  const fromSpinsVnd = input.spins.reduce((sum, spin) => sum + toNumber(spin.amount_vnd), 0);
  const breadQty = input.spins.reduce((sum, spin) => sum + toNumber(spin.bread_qty), 0);
  const todayKey = dateKey(input.today) ?? dateKey(new Date()) ?? "";
  const breakOnKey = dateKey(input.breakOn);

  return {
    extra_que: extraQue,
    from_extra_vnd: fromExtraVnd,
    from_spins_vnd: fromSpinsVnd,
    bread_qty: breadQty,
    total_vnd: fromExtraVnd + fromSpinsVnd,
    spin_count: input.spins.length,
    days_to_break: breakOnKey && todayKey ? Math.max(0, daysBetween(todayKey, breakOnKey)) : 0,
    recent_spins: recentSpins(input.spins),
  };
}

export function previewOrderExtra(input: PreviewOrderExtraInput): PreviewOrderExtra {
  const baseline = Math.max(0, toNumber(input.baselineAvgPerDay));
  const existing = Math.max(0, toNumber(input.existingDayQuantity));
  const orderQuantity = Math.max(0, toNumber(input.orderQuantity));
  const rate = Math.max(0, toNumber(input.ratePerExtraQue));

  // Only the new overage counts: if the day was already above the baseline,
  // the whole order is extra; otherwise only the part crossing the baseline.
  const overageBefore = Math.max(0, existing - baseline);
  const overageAfter = Math.max(0, existing + orderQuantity - baseline);
  const extraQue = Math.max(0, overageAfter - overageBefore);
  const requiredQuantity = baseline > 0 ? baseline : 1;

  return {
    extra_que: extraQue,
    extra_vnd: Math.round(extraQue * rate),
    spin_eligible: orderQuantity >= requiredQuantity,
  };
}

function recentSpins(spins: HeoSpinInput[]): HeoRecentSpin[] {
  return spins
    .slice()
    .sort((a, b) => {
      const timeDiff = timestamp(b.created_at) - timestamp(a.created_at);
      if (timeDiff !== 0) return timeDiff;
      return String(b.order_id).localeCompare(String(a.order_id));
    })
    .slice(0, 5)
    .map((spin) => ({
      amount_vnd: toNumber(spin.amount_vnd),
      bread_qty: toNumber(spin.bread_qty),
      prize_kind: String(spin.prize_kind ?? "none"),
      is_jackpot: spin.is_jackpot === true,
      created_at: String(spin.created_at ?? ""),
      order_id: String(spin.order_id ?? ""),
    }));
}

export function dateKey(value: string | Date | null | undefined): string | null {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    return new Date(value.getTime() + VIETNAM_UTC_OFFSET_MS).toISOString().slice(0, 10);
  }
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function daysBetween(fromKey: string, toKey: string): number {
  const from = dateKeyToUtcMs(fromKey);
  const to = dateKeyToUtcMs(toKey);
  if (from === null || to === null) return 0;
  return Math.round((to - from) / DAY_MS);
}

function dateKeyToUtcMs(key: string): number | null {
  const match = key.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const value = Date.UTC(year, month - 1, day);
  const check = new Date(value);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day
  ) {
    return null;
  }
  return value;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toNumber(value: number | string | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
