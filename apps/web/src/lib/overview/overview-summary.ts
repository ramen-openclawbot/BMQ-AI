export type MetricStatus = "ok" | "empty" | "error" | "unavailable";

export type OverviewMetric<T> = {
  status: MetricStatus;
  value: T | null;
  asOf: string | null;
  href: string;
  note?: string;
};

export type ChannelGroup = "dealer" | "b2b" | "retail" | "bakery" | "other";

const VN_TIME_ZONE = "Asia/Ho_Chi_Minh";

const vnDayFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: VN_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * Ngày theo múi giờ Việt Nam, định dạng YYYY-MM-DD.
 * Nhận Date hoặc chuỗi ISO; không phụ thuộc timezone của máy chạy.
 */
export function vietnamDayKey(d: Date | string): string {
  const date = typeof d === "string" ? new Date(d) : d;
  return vnDayFormatter.format(date);
}

/** Kỳ trước liền kề của một kỳ 'YYYY-MM'. */
export function previousPeriod(period: string): string {
  const [year, month] = period.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 2, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(
    2,
    "0",
  )}`;
}

const normalizeChannel = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase()
    .trim();

const DEALER_CHANNELS = new Set([
  "franchise",
  "dai ly",
  "bread business wholesale channel",
  "npp",
]);

/**
 * Phân nhóm kênh doanh thu. So khớp không phân biệt hoa thường và bỏ dấu.
 */
export function channelGroup(
  channel: string | null | undefined,
): ChannelGroup {
  if (!channel) return "other";
  const value = normalizeChannel(channel);
  if (!value) return "other";

  if (DEALER_CHANNELS.has(value)) return "dealer";
  if (value === "b2b bmq" || value.includes("sieu thi") || value.includes("b2b"))
    return "b2b";
  if (value === "retail kiosk" || value.includes("kiosk") || value.includes("ban le"))
    return "retail";
  // "BÁNH NGỌT" / "Bakery business" is the second-largest ledger channel; keep it out of "other".
  if (value.includes("banh ngot") || value.includes("bakery")) return "bakery";
  return "other";
}

export type RevenueChannelLine = {
  revenue_date: string;
  channel: string | null;
  gross_revenue: number | null;
};

export type RevenueChannelDay = {
  day: string;
  total: number;
  byGroup: Record<ChannelGroup, number>;
};

export type RevenueChannelSummary = {
  days: RevenueChannelDay[];
  totals: Record<ChannelGroup, number>;
  total: number;
};

const CHANNEL_GROUPS: ChannelGroup[] = ["dealer", "b2b", "retail", "bakery", "other"];

const emptyGroupTotals = (): Record<ChannelGroup, number> => ({
  dealer: 0,
  b2b: 0,
  retail: 0,
  bakery: 0,
  other: 0,
});

const numberOrZero = (value: number | null): number =>
  typeof value === "number" && Number.isFinite(value) ? value : 0;

/**
 * Tổng hợp doanh thu theo ngày và theo nhóm kênh trong `days` ngày kể cả
 * `endDay`. Ngày không có dòng vẫn xuất hiện với giá trị 0; gross_revenue
 * null/không hợp lệ tính là 0.
 */
export function summarizeRevenueByChannel(
  lines: RevenueChannelLine[],
  endDay: string,
  days = 14,
): RevenueChannelSummary {
  const [year, month, day] = endDay.split("-").map(Number);
  const endUtc = Date.UTC(year, month - 1, day);
  const dayList: string[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    dayList.push(new Date(endUtc - offset * 86_400_000).toISOString().slice(0, 10));
  }

  const perDay = new Map<string, { total: number; byGroup: Record<ChannelGroup, number> }>();
  for (const dayKey of dayList) {
    perDay.set(dayKey, { total: 0, byGroup: emptyGroupTotals() });
  }

  const totals = emptyGroupTotals();
  let total = 0;

  for (const line of lines) {
    const bucket = perDay.get(line.revenue_date);
    if (!bucket) continue;
    const amount = numberOrZero(line.gross_revenue);
    const group = channelGroup(line.channel);
    bucket.total += amount;
    bucket.byGroup[group] += amount;
    totals[group] += amount;
    total += amount;
  }

  return {
    days: dayList.map((dayKey) => ({
      day: dayKey,
      total: perDay.get(dayKey)?.total ?? 0,
      byGroup: perDay.get(dayKey)?.byGroup ?? emptyGroupTotals(),
    })),
    totals,
    total,
  };
}

export type SubmittedLocationRow = {
  location_id: string | null;
  submitted_at: string | null;
};

/** Đếm số điểm (location_id) khác nhau đã nộp báo cáo. */
export function countSubmittedLocations(rows: SubmittedLocationRow[]): number {
  const submitted = new Set<string>();
  for (const row of rows) {
    if (row.location_id && row.submitted_at) submitted.add(row.location_id);
  }
  return submitted.size;
}

export type ProductionStatusRow = { status: string };

export type ProductionStatusSummary = {
  total: number;
  byStatus: Record<string, number>;
};

/** Đếm đơn sản xuất theo trạng thái. */
export function countProductionByStatus(
  rows: ProductionStatusRow[],
): ProductionStatusSummary {
  const byStatus: Record<string, number> = {};
  for (const row of rows) {
    const status = row.status || "";
    byStatus[status] = (byStatus[status] || 0) + 1;
  }
  return { total: rows.length, byStatus };
}

/**
 * Chuẩn hoá một chỉ số thành OverviewMetric. Lỗi không bao giờ thành 0:
 * error -> 'error' (value null); unavailable -> 'unavailable' (value null, note);
 * value null/undefined -> 'unavailable'; isEmpty -> 'empty'; còn lại -> 'ok'.
 */
export function metric<T>(input: {
  error?: unknown;
  value?: T | null;
  isEmpty?: boolean;
  unavailable?: string;
  asOf?: string | null;
  href: string;
}): OverviewMetric<T> {
  const asOf = input.asOf ?? null;
  const base = { asOf, href: input.href };

  if (input.error) {
    return { status: "error", value: null, ...base };
  }
  if (input.unavailable) {
    return {
      status: "unavailable",
      value: null,
      note: input.unavailable,
      ...base,
    };
  }
  if (input.value === null || input.value === undefined) {
    return { status: "unavailable", value: null, ...base };
  }
  if (input.isEmpty) {
    return { status: "empty", value: input.value, ...base };
  }
  return { status: "ok", value: input.value, ...base };
}
