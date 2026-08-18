import { LunarDate } from "npm:vietnamese-lunar-calendar@0.0.6";

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
  closureReason: "lunar_day_30_monthly_off" | null;
};

export type VietjetInboxEvidence = {
  inboxId: string;
  receivedAt: string;
  productionItems: unknown;
};

export type DailyBreadOrderMessageInput = {
  orderDate: string;
  dealerOrderedQuantity: number;
  vehicleQuantity: number;
  vietjetQuantity: number;
};

export type WarehouseKioskBreadDispatchLocation = {
  locationCode: string;
  locationName: string;
  orderQuantity: number;
  shortageQuantity: number;
  returnsQuantity: number;
  wasteQuantity: number;
};

export type WarehouseKioskBreadDispatchInput = {
  orderDate: string;
  locations: WarehouseKioskBreadDispatchLocation[];
};

const FORMULA_VERSION = "peak-7d-plus-10pct-minus-closing-round10-lunar-off-v2";
const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;
const LUNAR_DAY_30_OFF_CODES = new Set(["HCM001-BV", "HCM002-PVC"]);

const lunarDayForVietnamDate = (dateKey: string): number | null => {
  const match = dateKey.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, year, month, day] = match;
  const solarDate = new Date(`${dateKey}T12:00:00+07:00`);
  if (!Number.isFinite(solarDate.getTime())
    || solarDate.getUTCFullYear() !== Number(year)
    || solarDate.getUTCMonth() + 1 !== Number(month)
    || solarDate.getUTCDate() !== Number(day)) return null;
  return new LunarDate(Number(year), Number(month), Number(day)).date;
};

export const isVehicleLocationClosed = (locationCode: string, deliveryDate: string): boolean =>
  LUNAR_DAY_30_OFF_CODES.has(locationCode.trim().toUpperCase()) && lunarDayForVietnamDate(deliveryDate) === 30;

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

export const roundBreadOrderMessageQuantity = (value: number): number => roundUpToBatch(quantity(value), 10);

export function forecastVehicleBread(locations: VehicleBreadLocation[], deliveryDate?: string): {
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
    const closureReason = deliveryDate && isVehicleLocationClosed(location.locationCode, deliveryDate)
      ? "lunar_day_30_monthly_off" as const
      : null;

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
        closureReason,
      };
    }

    const peakSoldQuantity = Math.max(...reports.map((report) => quantity(report.soldQuantity)));
    const latestClosingQuantity = signedQuantity(reports[0].closingQuantity);
    const protectedDemand = Math.round(peakSoldQuantity * 1.1 * 1_000) / 1_000;
    const recommendedQuantity = closureReason
      ? 0
      : roundUpToBatch(Math.max(0, protectedDemand - latestClosingQuantity));

    return {
      locationId: location.locationId,
      locationCode: location.locationCode,
      reportCount: reports.length,
      latestReportDate: reports[0].reportDate,
      peakSoldQuantity,
      latestClosingQuantity,
      recommendedQuantity,
      closureReason,
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
  const vehicle = quantity(input.vehicleQuantity);
  const rawTotalBmq = dealerOrdered + vehicle;
  const roundedTotalBmq = roundBreadOrderMessageQuantity(rawTotalBmq);
  const roundedVietjet = roundBreadOrderMessageQuantity(input.vietjetQuantity);
  const dealerLine = `ĐL: ${formatQuantity(dealerOrdered)}`;

  return [
    `Đặt bánh ngày ${Number(day)}/${Number(month)}/${year}`,
    dealerLine,
    `Xe: ${formatQuantity(vehicle)}`,
    `Tổng BMQ: ${formatQuantity(roundedTotalBmq)}`,
    `Viet Jet: ${formatQuantity(roundedVietjet)}`,
  ].join("\n");
}

const WAREHOUSE_DISPATCH_LOCATION_ORDER = [
  "HCM001-BV",
  "HCM004-BHN",
  "HCM003-BVĐ",
  "HCM002-PVC",
  "HCM005-TN",
];

const warehouseDispatchOrder = (locationCode: string): number => {
  const index = WAREHOUSE_DISPATCH_LOCATION_ORDER.indexOf(locationCode.trim().toUpperCase());
  return index >= 0 ? index : WAREHOUSE_DISPATCH_LOCATION_ORDER.length;
};

const warehousePointName = (value: string, fallback: string): string => {
  const name = value.trim().replace(/^\d+\s+/, "").trim();
  return name || fallback.trim() || "Điểm bán";
};

export function buildWarehouseKioskBreadDispatchMessage(input: WarehouseKioskBreadDispatchInput): string {
  const match = input.orderDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error("invalid_warehouse_kiosk_bread_dispatch_date");
  const [, , month, day] = match;
  const locations = [...input.locations].sort((left, right) => {
    const orderDifference = warehouseDispatchOrder(left.locationCode) - warehouseDispatchOrder(right.locationCode);
    if (orderDifference !== 0) return orderDifference;
    return left.locationCode.localeCompare(right.locationCode, "vi");
  });
  if (locations.length === 0) throw new Error("warehouse_kiosk_bread_dispatch_has_no_locations");

  let totalOrdered = 0;
  let totalMakeup = 0;
  let totalExchange = 0;
  const lines = locations.map((location) => {
    const ordered = quantity(location.orderQuantity);
    const makeup = quantity(location.shortageQuantity);
    const exchange = quantity(location.returnsQuantity) + quantity(location.wasteQuantity);
    totalOrdered += ordered;
    totalMakeup += makeup;
    totalExchange += exchange;
    const extras: string[] = [];
    if (makeup > 0) extras.push(`bù ${formatQuantity(makeup)}`);
    if (exchange > 0) extras.push(`đổi ${formatQuantity(exchange)}`);
    const suffix = extras.length > 0 ? ` | ${extras.join(" | ")}` : "";
    return `${warehousePointName(location.locationName, location.locationCode)}: đặt ${formatQuantity(ordered)} que${suffix}`;
  });
  const totalPhysical = totalOrdered + totalMakeup + totalExchange;

  return [
    `ĐẶT BÁNH ${Number(day)}/${Number(month)}`,
    "",
    ...lines,
    "",
    `Tổng đặt mới: ${formatQuantity(totalOrdered)} que`,
    `Tổng bù: ${formatQuantity(totalMakeup)} que`,
    `Tổng đổi: ${formatQuantity(totalExchange)} que`,
    `KHO CẦN GIAO: ${formatQuantity(totalPhysical)} QUE`,
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
