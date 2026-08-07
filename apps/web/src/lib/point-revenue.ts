export type PointRevenueReviewStatus = "unreviewed" | "in_review" | "reviewed";

export type PointRevenueChannel = {
  channel_code: string;
  channel_name: string;
  quantity: number;
  source_amount_vnd: number;
  effective_amount_vnd: number;
  corrected: boolean;
};

export type PointRevenueIssue = {
  code: "amount_unit_suspect";
  channel_code: string;
  message: string;
};

export type PointRevenueReport = {
  report_id: string;
  report_date: string;
  location_id: string;
  location_name: string;
  staff_name: string;
  submitted_at: string | null;
  review_status: PointRevenueReviewStatus;
  reviewed_at: string | null;
  reviewed_by_name: string | null;
  review_note: string | null;
  channels: PointRevenueChannel[];
};

const finiteNumber = (value: unknown) => {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

export function summarizePointRevenue(channels: PointRevenueChannel[]) {
  const totals = channels.reduce(
    (sum, channel) => ({
      total_quantity: sum.total_quantity + finiteNumber(channel.quantity),
      source_total_vnd: sum.source_total_vnd + finiteNumber(channel.source_amount_vnd),
      effective_total_vnd: sum.effective_total_vnd + finiteNumber(channel.effective_amount_vnd),
      corrected_channel_count: sum.corrected_channel_count + (channel.corrected ? 1 : 0),
    }),
    {
      total_quantity: 0,
      source_total_vnd: 0,
      effective_total_vnd: 0,
      corrected_channel_count: 0,
    },
  );

  return {
    ...totals,
    correction_delta_vnd: totals.effective_total_vnd - totals.source_total_vnd,
  };
}

export function detectPointRevenueIssues(channels: PointRevenueChannel[]): PointRevenueIssue[] {
  return channels.flatMap((channel) => {
    const amount = finiteNumber(channel.source_amount_vnd);
    if (amount > 0 && amount < 1000) {
      return [{
        code: "amount_unit_suspect" as const,
        channel_code: channel.channel_code,
        message: "Số tiền nguồn dưới 1.000 ₫ — cần kiểm tra đơn vị nhập.",
      }];
    }
    return [];
  });
}

export function parsePointRevenueRows(rows: unknown[]): PointRevenueReport[] {
  return (rows as Record<string, unknown>[]).map((row) => ({
    report_id: String(row.report_id ?? ""),
    report_date: String(row.report_date ?? ""),
    location_id: String(row.location_id ?? ""),
    location_name: String(row.location_name ?? ""),
    staff_name: String(row.staff_name ?? ""),
    submitted_at: row.submitted_at ? String(row.submitted_at) : null,
    review_status: (["in_review", "reviewed"].includes(String(row.review_status))
      ? String(row.review_status)
      : "unreviewed") as PointRevenueReviewStatus,
    reviewed_at: row.reviewed_at ? String(row.reviewed_at) : null,
    reviewed_by_name: row.reviewed_by_name ? String(row.reviewed_by_name) : null,
    review_note: row.review_note ? String(row.review_note) : null,
    channels: (Array.isArray(row.channels) ? row.channels : []).map((raw) => {
      const channel = raw as Record<string, unknown>;
      return {
        channel_code: String(channel.channel_code ?? ""),
        channel_name: String(channel.channel_name ?? channel.channel_name_snapshot ?? ""),
        quantity: finiteNumber(channel.quantity),
        source_amount_vnd: finiteNumber(channel.source_amount_vnd),
        effective_amount_vnd: finiteNumber(channel.effective_amount_vnd),
        corrected: Boolean(channel.corrected),
      };
    }),
  }));
}
