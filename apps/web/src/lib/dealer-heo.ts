/**
 * Heo Đất Tết — shared browser types and money/overage helpers.
 *
 * The Edge Function owns the authoritative calculation; this module mirrors
 * the same preview formula and formats the values for the dealer UI. No page is
 * wired to it in this step.
 */

export const HEO_CAMPAIGN_CODE = "heo-tet-2026";

export type DealerHeoPrize = {
  label: string;
};

export type DealerHeoCampaign = {
  title: string;
  starts_on: string;
  ends_on: string;
  break_on: string | null;
  rate: number;
  spin_enabled_for_me: boolean;
  prizes: DealerHeoPrize[];
};

export type DealerHeoRecentSpin = {
  amount_vnd: number;
  bread_qty: number;
  prize_kind: string;
  is_jackpot: boolean;
  created_at: string;
  order_id: string;
};

export type DealerHeoSummary = {
  extra_que: number;
  from_extra_vnd: number;
  from_spins_vnd: number;
  bread_qty: number;
  total_vnd: number;
  spin_count: number;
  days_to_break: number;
  recent_spins: DealerHeoRecentSpin[];
};

export type DealerHeoStatusResponse =
  | { success: true; active: false }
  | {
    success: true;
    active: true;
    campaign: DealerHeoCampaign;
    baseline_avg_per_day: number;
    summary: DealerHeoSummary;
  };

export type DealerHeoPreview = {
  extra_que: number;
  extra_vnd: number;
  spin_eligible: boolean;
};

export type DealerHeoPreviewResponse = {
  success: true;
  preview: DealerHeoPreview;
};

export type DealerHeoSpin = {
  id: string;
  campaign_id: string;
  customer_id: string;
  order_id: string;
  is_test: boolean;
  prize_key: string;
  prize_kind: string;
  amount_vnd: number;
  bread_qty: number;
  is_jackpot: boolean;
  iso_week: string;
  created_at: string;
};

export type DealerHeoSpinResponse = {
  success: true;
  spin: DealerHeoSpin;
  summary: DealerHeoSummary;
};

export type DealerHeoErrorResponse = {
  success: false;
  error: string;
  code?: string;
};

export type PreviewOrderExtraInput = {
  baselineAvgPerDay: number | string | null | undefined;
  existingDayQuantity: number | string | null | undefined;
  orderQuantity: number | string | null | undefined;
  ratePerExtraQue: number | string | null | undefined;
};

export type PreviewOrderExtra = DealerHeoPreview;

/** Format a VND amount as Vietnamese grouped text, e.g. 5000 -> "5.000đ". */
export function formatHeoVnd(value: number | string | null | undefined): string {
  const amount = Math.round(toNumber(value));
  const sign = amount < 0 ? "-" : "";
  const digits = String(Math.abs(amount)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${sign}${digits}đ`;
}

/**
 * Price only the newly crossed part of a delivery day. If the day is already
 * above the baseline, the whole order is extra; otherwise only the part that
 * crosses the baseline counts. The spin threshold compares the order quantity,
 * not the day total, with the baseline (at least 1 que when baseline is 0).
 */
export function previewOrderExtra(input: PreviewOrderExtraInput): PreviewOrderExtra {
  const baseline = Math.max(0, toNumber(input.baselineAvgPerDay));
  const existing = Math.max(0, toNumber(input.existingDayQuantity));
  const orderQuantity = Math.max(0, toNumber(input.orderQuantity));
  const rate = Math.max(0, toNumber(input.ratePerExtraQue));

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

function toNumber(value: number | string | null | undefined): number {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
