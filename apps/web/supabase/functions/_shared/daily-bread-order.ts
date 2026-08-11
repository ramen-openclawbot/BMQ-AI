export type VehicleBreadReport = {
  reportDate: string;
  soldQuantity: number;
  closingQuantity: number;
};

export type VehicleBreadLocation = {
  locationId: string;
  locationCode: string;
  reports: VehicleBreadReport[];
};

export type VehicleBreadForecastLocation = {
  locationId: string;
  locationCode: string;
  reportCount: number;
  latestReportDate: string | null;
  peakSoldQuantity: number;
  latestClosingQuantity: number;
  recommendedQuantity: number;
};

export type VietjetInboxEvidence = {
  inboxId: string;
  receivedAt: string;
  productionItems: unknown;
};

export type DailyBreadOrderMessageInput = {
  orderDate: string;
  dealerOrderedQuantity: number;
  dealerExtraQuantity: number;
  vehicleQuantity: number;
  vietjetQuantity: number;
};

const FORMULA_VERSION = "peak-7d-plus-10pct-minus-closing-round10-v1";
const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;

const quantity = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const signedQuantity = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

const roundUpToBatch = (value: number, batchSize = 10): number => {
  if (!(value > 0)) return 0;
  return Math.ceil(value / batchSize) * batchSize;
};

const formatQuantity = (value: number): string => {
  const safe = quantity(value);
  return Number.isInteger(safe) ? String(safe) : safe.toFixed(3).replace(/\.?0+$/, "");
};

export function forecastVehicleBread(locations: VehicleBreadLocation[]): {
  totalQuantity: number;
  formulaVersion: string;
  locations: VehicleBreadForecastLocation[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const forecasts = locations.map((location) => {
    const reports = [...location.reports]
      .filter((report) => /^\d{4}-\d{2}-\d{2}$/.test(report.reportDate))
      .sort((left, right) => right.reportDate.localeCompare(left.reportDate))
      .slice(0, 7);

    if (reports.length === 0) {
      warnings.push(`${location.locationCode}:no_submitted_bread_report`);
      return {
        locationId: location.locationId,
        locationCode: location.locationCode,
        reportCount: 0,
        latestReportDate: null,
        peakSoldQuantity: 0,
        latestClosingQuantity: 0,
        recommendedQuantity: 0,
      };
    }

    const peakSoldQuantity = Math.max(...reports.map((report) => quantity(report.soldQuantity)));
    const latestClosingQuantity = signedQuantity(reports[0].closingQuantity);
    const protectedDemand = Math.round(peakSoldQuantity * 1.1 * 1_000) / 1_000;
    const recommendedQuantity = roundUpToBatch(Math.max(0, protectedDemand - latestClosingQuantity));

    return {
      locationId: location.locationId,
      locationCode: location.locationCode,
      reportCount: reports.length,
      latestReportDate: reports[0].reportDate,
      peakSoldQuantity,
      latestClosingQuantity,
      recommendedQuantity,
    };
  });

  return {
    totalQuantity: forecasts.reduce((sum, row) => sum + row.recommendedQuantity, 0),
    formulaVersion: FORMULA_VERSION,
    locations: forecasts,
    warnings,
  };
}

export function selectLatestVietjetQuantity(
  rows: VietjetInboxEvidence[],
  targetDate: string,
): { quantity: number; inboxId: string | null; receivedAt: string | null } {
  let selected: { quantity: number; inboxId: string; receivedAt: string } | null = null;

  for (const row of rows) {
    const items = Array.isArray(row.productionItems) ? row.productionItems : [];
    for (const rawItem of items) {
      if (!rawItem || typeof rawItem !== "object") continue;
      const item = rawItem as Record<string, unknown>;
      const serviceDate = String(item.service_date || item.date || "");
      const productCode = String(item.product_code || item.sku_code || item.sku || "");
      if (serviceDate !== targetDate || productCode !== "40000294") continue;
      const itemQuantity = quantity(item.qty ?? item.ordered_qty ?? item.revenue_qty);
      if (!(itemQuantity > 0)) continue;
      if (!selected || row.receivedAt >= selected.receivedAt) {
        selected = { quantity: itemQuantity, inboxId: row.inboxId, receivedAt: row.receivedAt };
      }
    }
  }

  return selected || { quantity: 0, inboxId: null, receivedAt: null };
}

export function buildDailyBreadOrderMessage(input: DailyBreadOrderMessageInput): string {
  const match = input.orderDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error("invalid_daily_bread_order_date");
  const [, year, month, day] = match;
  const dealerOrdered = quantity(input.dealerOrderedQuantity);
  const dealerExtra = quantity(input.dealerExtraQuantity);
  const vehicle = quantity(input.vehicleQuantity);
  const vietjet = quantity(input.vietjetQuantity);
  const dealerLine = dealerExtra > 0
    ? `ĐL: ${formatQuantity(dealerOrdered)}+ ${formatQuantity(dealerExtra)}`
    : `ĐL: ${formatQuantity(dealerOrdered)}`;

  return [
    `Đặt bánh ngày ${Number(day)}/${Number(month)}/${year}`,
    dealerLine,
    `Xe: ${formatQuantity(vehicle)}`,
    `Tổng BMQ: ${formatQuantity(dealerOrdered + dealerExtra + vehicle)}`,
    `Viet Jet: ${formatQuantity(vietjet)}`,
  ].join("\n");
}

export function nextVietnamDateKey(now: Date): string | null {
  if (!Number.isFinite(now.getTime())) return null;
  const vietnamNow = new Date(now.getTime() + VIETNAM_OFFSET_MS);
  const nextDate = new Date(Date.UTC(
    vietnamNow.getUTCFullYear(),
    vietnamNow.getUTCMonth(),
    vietnamNow.getUTCDate() + 1,
  ));
  return nextDate.toISOString().slice(0, 10);
}
