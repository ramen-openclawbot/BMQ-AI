import { LunarDate } from "npm:vietnamese-lunar-calendar@0.0.6";

export type VehicleBreadReport = {
  reportId?: string | null;
  reportDate: string;
  reportUpdatedAt?: string | null;
  soldQuantity: number;
  closingQuantity: number;
  breadRowPresent?: boolean;
  noteOrderQuantity?: number | null;
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
  protectedDemandQuantity: number;
  netDemandQuantity: number;
  lowerBatchQuantity: number;
  upperBatchQuantity: number;
  recommendedQuantity: number;
  windowMean?: number;
  windowStd?: number;
  windowReportCount?: number;
  roundingDecision:
    | "no_submitted_report"
    | "lunar_day_30_monthly_off"
    | "staff_note_order_override"
    | "fixed_daily_inbound_policy"
    | "dynamic_exact_report_missing"
    | "dynamic_exact_bread_row_missing"
    | "dynamic_exact_no_new_order_needed"
    | "dynamic_exact_report_round_up_to_batch"
    | "dynamic_window_mean_std_round_up_to_batch"
    | "no_new_order_needed"
    | "exact_20_stick_batch"
    | "round_up_to_prevent_peak_stockout"
    | "round_up_to_preserve_low_stock_safety"
    | "round_down_existing_stock_buffer";
  latestReportSource: { reportId: string | null; reportUpdatedAt: string | null; breadRowPresent?: boolean } | null;
  closureReason: "lunar_day_30_monthly_off" | null;
  staffNoteOrderOverride?: { reportId: string | null; quantity: number } | null;
  fixedInboundPolicy?: Omit<FixedVehicleBreadInboundPolicy, "locationId" | "locationCode">;
  dynamicInboundPolicy?: Omit<DynamicVehicleBreadOrderPolicy, "locationId" | "locationCode">;
};

export type FixedVehicleBreadInboundPolicy = {
  policyCode: string;
  locationId: string;
  locationCode: string;
  skuCode: "BMQ-001" | string;
  quantity: number;
  effectiveFromServiceDate: string;
  effectiveFromCutoffDate: string;
};

export type DynamicVehicleBreadOrderPolicy = {
  policyCode: string;
  locationId: string;
  locationCode: string;
  skuCode: "BMQ-001" | string;
  demandMultiplier: number;
  batchSize: number;
  formulaMethod?: "exact_day_multiplier" | "window_mean_plus_k_std";
  windowSize?: number;
  stdMultiplier?: number;
  minReports?: number;
  effectiveFromServiceDate: string;
  effectiveFromCutoffDate: string;
};

export type KioskBreadOrderNoteProposal = {
  quantity: number;
  rawText: string;
  evidenceText: string;
  parserRule: "explicit-dat-quantity-v2";
  confidence: "explicit";
  requiresConfirmation: false;
};

export type VietjetInboxEvidence = {
  inboxId: string;
  receivedAt: string;
  productionItems: unknown;
};

export type DailyBreadOrderMessageInput = {
  orderDate: string;
  dealerOrderedQuantity: number;
  dealerExchangeQuantity?: number;
  dealerMakeupQuantity?: number;
  vehicleQuantity: number;
  vehicleExchangeQuantity?: number;
  vehicleMakeupQuantity?: number;
  mamNonOrderedQuantity?: number;
  vietjetQuantity: number;
};

export type MamNonMayEmailOrder = {
  customerName: "Mầm non May";
  serviceDate: string;
  orderedQuantity: number;
  revenueQuantity: number;
  supplierQuantity: number;
  warehouseSurplusQuantity: number;
};

export type WarehouseKioskBreadDispatchLocation = {
  locationCode: string;
  locationName: string;
  orderQuantity: number;
  shortageQuantity: number;
  returnsQuantity: number;
  wasteQuantity: number;
  staffNoteOrderOverride?: { reportId: string | null; quantity: number } | null;
};

export type WarehouseKioskBreadDispatchInput = {
  orderDate: string;
  locations: WarehouseKioskBreadDispatchLocation[];
};

const FORMULA_VERSION = "peak-7d-plus-10pct-minus-closing-smart-round20-lunar-off-v3";
const DYNAMIC_BHN_FORMULA_VERSION = "bhn-exact-date-sold-120pct-minus-saleable-closing-round20-v1";
const VIETNAM_OFFSET_MS = 7 * 60 * 60 * 1000;
const VEHICLE_BREAD_SAFETY_FACTOR = 1.1;
const PATE_BATCH_SIZE = 20;
const LUNAR_DAY_30_OFF_CODES = new Set(["HCM001-BV", "HCM002-PVC"]);
export const DEFAULT_FIXED_VEHICLE_BREAD_INBOUND_POLICIES: FixedVehicleBreadInboundPolicy[] = [{
  policyCode: "fixed-daily-inbound-bhn-bmq-001-v1",
  locationId: "8b353493-c3cb-436e-80f7-a9a1d1a57cd3",
  locationCode: "HCM004-BHN",
  skuCode: "BMQ-001",
  quantity: 160,
  effectiveFromServiceDate: "2026-09-19",
  effectiveFromCutoffDate: "2026-09-18",
}];
export const DEFAULT_DYNAMIC_VEHICLE_BREAD_ORDER_POLICIES: DynamicVehicleBreadOrderPolicy[] = [{
  policyCode: "dynamic-daily-order-bhn-bmq-001-v1",
  locationId: "8b353493-c3cb-436e-80f7-a9a1d1a57cd3",
  locationCode: "HCM004-BHN",
  skuCode: "BMQ-001",
  demandMultiplier: 1.2,
  batchSize: 20,
  formulaMethod: "exact_day_multiplier",
  windowSize: 7,
  stdMultiplier: 0,
  minReports: 3,
  effectiveFromServiceDate: "2026-09-28",
  effectiveFromCutoffDate: "2026-09-27",
}, {
  policyCode: "dynamic-daily-order-bhn-bmq-001-v2",
  locationId: "8b353493-c3cb-436e-80f7-a9a1d1a57cd3",
  locationCode: "HCM004-BHN",
  skuCode: "BMQ-001",
  demandMultiplier: 1.2,
  batchSize: 20,
  formulaMethod: "window_mean_plus_k_std",
  windowSize: 7,
  stdMultiplier: 1.5,
  minReports: 3,
  effectiveFromServiceDate: "2026-10-10",
  effectiveFromCutoffDate: "2026-10-09",
}];

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

const formatSupplierQuantity = (value: number): string => new Intl.NumberFormat("vi-VN", {
  maximumFractionDigits: 3,
}).format(quantity(value));

export const roundBreadOrderMessageQuantity = (value: number): number => roundUpToBatch(quantity(value), 10);
export const roundTotalBmqForPateBatch = (value: number): number => roundUpToBatch(quantity(value), PATE_BATCH_SIZE);

const normalizeMatchText = (value: string): string => String(value || "")
  .normalize("NFD")
  .replace(/[\u0300-\u036f]/g, "")
  .replace(/đ/g, "d")
  .replace(/Đ/g, "D")
  .toLowerCase()
  .replace(/\s+/g, " ")
  .trim();

export const isMamNonMayEmailSubject = (value: string): boolean =>
  /^mam non canada\s*\(\s*cty may\s*\)$/.test(normalizeMatchText(value));

const validDateKey = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value);

const previousDateKey = (dateKey: string): string | null => {
  if (!validDateKey(dateKey)) return null;
  const date = new Date(`${dateKey}T12:00:00+07:00`);
  if (!Number.isFinite(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
};

export const resolveFixedVehicleBreadInboundPolicy = (
  location: Pick<VehicleBreadLocation, "locationId" | "locationCode">,
  deliveryDate: string | undefined,
  fixedInboundPolicies: FixedVehicleBreadInboundPolicy[] = DEFAULT_FIXED_VEHICLE_BREAD_INBOUND_POLICIES,
): FixedVehicleBreadInboundPolicy | null => {
  if (!deliveryDate || !validDateKey(deliveryDate)) return null;
  const locationCode = location.locationCode.trim().toUpperCase();
  const policy = fixedInboundPolicies
    .filter((candidate) =>
      candidate.skuCode === "BMQ-001"
      && quantity(candidate.quantity) > 0
      && validDateKey(candidate.effectiveFromServiceDate)
      && deliveryDate >= candidate.effectiveFromServiceDate
      && (
        candidate.locationId === location.locationId
        || candidate.locationCode.trim().toUpperCase() === locationCode
      )
    )
    .sort((left, right) =>
      right.effectiveFromServiceDate.localeCompare(left.effectiveFromServiceDate)
      || right.policyCode.localeCompare(left.policyCode)
    )[0];
  return policy || null;
};

export const resolveDynamicVehicleBreadOrderPolicy = (
  location: Pick<VehicleBreadLocation, "locationId" | "locationCode">,
  deliveryDate: string | undefined,
  dynamicOrderPolicies: DynamicVehicleBreadOrderPolicy[] = DEFAULT_DYNAMIC_VEHICLE_BREAD_ORDER_POLICIES,
): DynamicVehicleBreadOrderPolicy | null => {
  if (!deliveryDate || !validDateKey(deliveryDate)) return null;
  const locationCode = location.locationCode.trim().toUpperCase();
  const cutoffDate = previousDateKey(deliveryDate);
  const policy = dynamicOrderPolicies
    .filter((candidate) =>
      candidate.skuCode === "BMQ-001"
      && quantity(candidate.demandMultiplier) > 0
      && quantity(candidate.batchSize) > 0
      && validDateKey(candidate.effectiveFromServiceDate)
      && validDateKey(candidate.effectiveFromCutoffDate)
      && deliveryDate >= candidate.effectiveFromServiceDate
      && Boolean(cutoffDate && cutoffDate >= candidate.effectiveFromCutoffDate)
      && (
        candidate.locationId === location.locationId
        || candidate.locationCode.trim().toUpperCase() === locationCode
      )
    )
    .sort((left, right) =>
      right.effectiveFromServiceDate.localeCompare(left.effectiveFromServiceDate)
      || right.policyCode.localeCompare(left.policyCode)
    )[0];
  return policy || null;
};

// Matches one explicit bread-order request such as "DAT 30", "Đặt bánh (mì) 40",
// "Order bánh 50 que". The optional word groups are tolerant of literal
// parentheses because staff notes often write "bánh (mì)".
const KIOSK_DAT_ORDER_NOTE_PATTERN =
  /\b(?:dat|order)\s*\(?\s*(?:banh(?:\s*\(?\s*mi\s*\)?)?(?:\s*\))?)?\s*:?\s*(\d{1,4}(?:[.,]\d+)?)\s*(?:\(?\s*(?:que|cay|banh)(?:\s*\))?)?\b/g;

export function extractKioskBreadOrderNoteProposal(note: string): KioskBreadOrderNoteProposal | null {
  const rawText = String(note || "").trim();
  if (!rawText) return null;
  // "đạt" (reached, e.g. "bán đạt 120") collapses to "dat" once diacritics are
  // stripped, so neutralize it before normalizing; "đặt"/"DAT" stay order words.
  const normalized = normalizeMatchText(rawText.normalize("NFC").replace(/đạt/giu, "reached"));
  if (/(hotline|doanh thu|revenue|tong tien|tien mat|chuyen khoan|bank|zalo|sdt|so dien thoai)/.test(normalized)) {
    return null;
  }
  // A negated request ("chưa đặt 60", "không đặt") is not an order.
  if (/\b(?:chua|khong|ko|k|dung|huy)\s+(?:dat|order)\b/.test(normalized)) return null;
  const matches = [...normalized.matchAll(KIOSK_DAT_ORDER_NOTE_PATTERN)];
  if (matches.length === 0) return null;
  const quantities = new Set(matches.map((match) => {
    const value = Number(match[1].replace(",", "."));
    return Number.isInteger(value) && value > 0 && value <= 1000 ? value : Number.NaN;
  }));
  // Several DAT phrases are allowed only when they all name the same quantity.
  if (quantities.size !== 1 || quantities.has(Number.NaN)) return null;
  const quantityValue = [...quantities][0];
  // A "thiếu 5" style single digit must not invalidate a clear DAT match, but a
  // different 2+ digit number could be the real order quantity and must reject.
  const matchSpans = matches.map((match) => ({
    start: match.index || 0,
    end: (match.index || 0) + match[0].length,
  }));
  for (const token of normalized.matchAll(/\b\d{2,}\b/g)) {
    const start = token.index || 0;
    const end = start + token[0].length;
    const insideDatMatch = matchSpans.some((span) => start >= span.start && end <= span.end);
    if (!insideDatMatch) return null;
  }
  const firstMatch = matches[0];
  return {
    quantity: quantityValue,
    rawText,
    evidenceText: rawText.slice(firstMatch.index || 0, (firstMatch.index || 0) + firstMatch[0].length),
    parserRule: "explicit-dat-quantity-v2",
    confidence: "explicit",
    requiresConfirmation: false,
  };
}

const nextVietnamDateFromTimestamp = (value: string): string | null => {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const vietnamDate = new Date(timestamp + VIETNAM_OFFSET_MS);
  vietnamDate.setUTCDate(vietnamDate.getUTCDate() + 1);
  return vietnamDate.toISOString().slice(0, 10);
};

export function parseMamNonMayEmailOrder(input: {
  sender: string;
  subject: string;
  body: string;
  receivedAt: string;
}): MamNonMayEmailOrder | null {
  const sender = normalizeMatchText(input.sender).replace(/^.*<|>.*$/g, "").trim();
  const subject = normalizeMatchText(input.subject);
  if (sender !== "mi@bmq.vn" || !isMamNonMayEmailSubject(subject)) {
    return null;
  }
  const match = normalizeMatchText(input.body).match(/\bbanh mi pate\s*:?\s*(\d+(?:[.,]\d+)?)\s*(?:que)?\b/);
  const orderedQuantity = Number(String(match?.[1] || "").replace(",", "."));
  const serviceDate = nextVietnamDateFromTimestamp(input.receivedAt);
  if (!serviceDate || !Number.isFinite(orderedQuantity) || orderedQuantity <= 0) return null;
  const supplierQuantity = roundTotalBmqForPateBatch(orderedQuantity);
  return {
    customerName: "Mầm non May",
    serviceDate,
    orderedQuantity,
    revenueQuantity: orderedQuantity,
    supplierQuantity,
    warehouseSurplusQuantity: supplierQuantity - orderedQuantity,
  };
}

const selectSmartPateBatchQuantity = (peakSoldQuantity: number, latestClosingQuantity: number): {
  protectedDemandQuantity: number;
  netDemandQuantity: number;
  lowerBatchQuantity: number;
  upperBatchQuantity: number;
  recommendedQuantity: number;
  roundingDecision: VehicleBreadForecastLocation["roundingDecision"];
} => {
  const protectedDemandQuantity = Math.round(
    peakSoldQuantity * VEHICLE_BREAD_SAFETY_FACTOR * 1_000,
  ) / 1_000;
  const netDemandQuantity = Math.max(0, protectedDemandQuantity - latestClosingQuantity);
  const lowerBatchQuantity = Math.floor(netDemandQuantity / PATE_BATCH_SIZE) * PATE_BATCH_SIZE;
  const upperBatchQuantity = Math.ceil(netDemandQuantity / PATE_BATCH_SIZE) * PATE_BATCH_SIZE;

  if (!(netDemandQuantity > 0)) {
    return {
      protectedDemandQuantity,
      netDemandQuantity,
      lowerBatchQuantity: 0,
      upperBatchQuantity: 0,
      recommendedQuantity: 0,
      roundingDecision: "no_new_order_needed",
    };
  }
  if (lowerBatchQuantity === upperBatchQuantity) {
    return {
      protectedDemandQuantity,
      netDemandQuantity,
      lowerBatchQuantity,
      upperBatchQuantity,
      recommendedQuantity: lowerBatchQuantity,
      roundingDecision: "exact_20_stick_batch",
    };
  }

  const lowerProjectedAvailable = latestClosingQuantity + lowerBatchQuantity;
  if (lowerProjectedAvailable < peakSoldQuantity) {
    return {
      protectedDemandQuantity,
      netDemandQuantity,
      lowerBatchQuantity,
      upperBatchQuantity,
      recommendedQuantity: upperBatchQuantity,
      roundingDecision: "round_up_to_prevent_peak_stockout",
    };
  }

  const safetyTargetClosing = protectedDemandQuantity - peakSoldQuantity;
  if (latestClosingQuantity < safetyTargetClosing) {
    return {
      protectedDemandQuantity,
      netDemandQuantity,
      lowerBatchQuantity,
      upperBatchQuantity,
      recommendedQuantity: upperBatchQuantity,
      roundingDecision: "round_up_to_preserve_low_stock_safety",
    };
  }

  return {
    protectedDemandQuantity,
    netDemandQuantity,
    lowerBatchQuantity,
    upperBatchQuantity,
    recommendedQuantity: lowerBatchQuantity,
    roundingDecision: "round_down_existing_stock_buffer",
  };
};

export function forecastVehicleBread(
  locations: VehicleBreadLocation[],
  deliveryDate?: string,
  fixedInboundPolicies: FixedVehicleBreadInboundPolicy[] = DEFAULT_FIXED_VEHICLE_BREAD_INBOUND_POLICIES,
  dynamicOrderPolicies: DynamicVehicleBreadOrderPolicy[] = DEFAULT_DYNAMIC_VEHICLE_BREAD_ORDER_POLICIES,
): {
  totalQuantity: number;
  formulaVersion: string;
  locations: VehicleBreadForecastLocation[];
  warnings: string[];
} {
  const warnings: string[] = [];
  let usedDynamicPolicy = false;
  const forecasts = locations.map((location) => {
    const reports = [...location.reports]
      .filter((report) => /^\d{4}-\d{2}-\d{2}$/.test(report.reportDate))
      .sort((left, right) => right.reportDate.localeCompare(left.reportDate))
      .slice(0, 7);
    const closureReason = deliveryDate && isVehicleLocationClosed(location.locationCode, deliveryDate)
      ? "lunar_day_30_monthly_off" as const
      : null;
    const peakSoldQuantity = reports.length > 0
      ? Math.max(...reports.map((report) => quantity(report.soldQuantity)))
      : 0;
    const latestClosingQuantity = reports.length > 0 ? signedQuantity(reports[0].closingQuantity) : 0;
    const latestReportSource = reports.length > 0
      ? {
        reportId: reports[0].reportId ?? null,
        reportUpdatedAt: reports[0].reportUpdatedAt ?? null,
        breadRowPresent: reports[0].breadRowPresent !== false,
      }
      : null;

    if (closureReason) {
      return {
        locationId: location.locationId,
        locationCode: location.locationCode,
        reportCount: reports.length,
        latestReportDate: reports[0]?.reportDate ?? null,
        peakSoldQuantity,
        latestClosingQuantity,
        protectedDemandQuantity: 0,
        netDemandQuantity: 0,
        lowerBatchQuantity: 0,
        upperBatchQuantity: 0,
        recommendedQuantity: 0,
        roundingDecision: "lunar_day_30_monthly_off" as const,
        latestReportSource,
        closureReason,
      };
    }

    const cutoffDate = deliveryDate ? previousDateKey(deliveryDate) : null;
    const cutoffReport = cutoffDate ? reports.find((report) => report.reportDate === cutoffDate) : null;
    const noteOrderQuantity = cutoffReport?.noteOrderQuantity == null
      ? null
      : Number(cutoffReport.noteOrderQuantity);
    if (
      cutoffReport
      && noteOrderQuantity !== null
      && Number.isFinite(noteOrderQuantity)
      && noteOrderQuantity > 0
    ) {
      const staffNoteOrderOverride = {
        reportId: cutoffReport.reportId ?? null,
        quantity: noteOrderQuantity,
      };
      return {
        locationId: location.locationId,
        locationCode: location.locationCode,
        reportCount: reports.length,
        latestReportDate: cutoffReport.reportDate,
        peakSoldQuantity,
        latestClosingQuantity,
        protectedDemandQuantity: noteOrderQuantity,
        netDemandQuantity: noteOrderQuantity,
        lowerBatchQuantity: noteOrderQuantity,
        upperBatchQuantity: noteOrderQuantity,
        recommendedQuantity: noteOrderQuantity,
        roundingDecision: "staff_note_order_override" as const,
        latestReportSource: {
          reportId: cutoffReport.reportId ?? null,
          reportUpdatedAt: cutoffReport.reportUpdatedAt ?? null,
          breadRowPresent: cutoffReport.breadRowPresent !== false,
        },
        closureReason,
        staffNoteOrderOverride,
      };
    }

    const dynamicPolicy = resolveDynamicVehicleBreadOrderPolicy(location, deliveryDate, dynamicOrderPolicies);
    if (dynamicPolicy) {
      usedDynamicPolicy = true;
      const exactReport = cutoffDate ? reports.find((report) => report.reportDate === cutoffDate) : null;
      const formulaMethod = dynamicPolicy.formulaMethod === "window_mean_plus_k_std"
        ? "window_mean_plus_k_std" as const
        : "exact_day_multiplier" as const;
      const windowSize = Number.isFinite(Number(dynamicPolicy.windowSize)) && Number(dynamicPolicy.windowSize) > 0
        ? Math.floor(Number(dynamicPolicy.windowSize))
        : 7;
      const stdMultiplier = Number.isFinite(Number(dynamicPolicy.stdMultiplier)) && Number(dynamicPolicy.stdMultiplier) >= 0
        ? Number(dynamicPolicy.stdMultiplier)
        : 0;
      const minReports = Number.isFinite(Number(dynamicPolicy.minReports)) && Number(dynamicPolicy.minReports) > 0
        ? Math.floor(Number(dynamicPolicy.minReports))
        : 3;
      const policySnapshot = {
        policyCode: dynamicPolicy.policyCode,
        skuCode: dynamicPolicy.skuCode,
        formulaMethod,
        windowSize,
        stdMultiplier,
        minReports,
        demandMultiplier: quantity(dynamicPolicy.demandMultiplier),
        batchSize: quantity(dynamicPolicy.batchSize),
        effectiveFromServiceDate: dynamicPolicy.effectiveFromServiceDate,
        effectiveFromCutoffDate: dynamicPolicy.effectiveFromCutoffDate,
      };
      const missingBase = {
        locationId: location.locationId,
        locationCode: location.locationCode,
        reportCount: reports.length,
        latestReportDate: null,
        peakSoldQuantity: 0,
        latestClosingQuantity: 0,
        protectedDemandQuantity: 0,
        netDemandQuantity: 0,
        lowerBatchQuantity: 0,
        upperBatchQuantity: 0,
        recommendedQuantity: 0,
        latestReportSource: null,
        closureReason,
        dynamicInboundPolicy: policySnapshot,
      };
      if (!exactReport) {
        warnings.push(`${location.locationCode}:exact_cutoff_bread_report_missing:${cutoffDate || "unknown"}`);
        return {
          ...missingBase,
          roundingDecision: "dynamic_exact_report_missing" as const,
        };
      }
      if (exactReport.breadRowPresent === false) {
        warnings.push(`${location.locationCode}:exact_cutoff_bread_inventory_row_missing:${cutoffDate || "unknown"}`);
        return {
          ...missingBase,
          latestReportDate: exactReport.reportDate,
          roundingDecision: "dynamic_exact_bread_row_missing" as const,
        };
      }

      const soldQuantity = quantity(exactReport.soldQuantity);
      const saleableClosingQuantity = signedQuantity(exactReport.closingQuantity);
      let protectedDemandQuantity = Math.round(soldQuantity * quantity(dynamicPolicy.demandMultiplier) * 1_000) / 1_000;
      let windowMean: number | undefined;
      let windowStd: number | undefined;
      let windowReportCount: number | undefined;
      let usedWindowMeanStd = false;
      if (formulaMethod === "window_mean_plus_k_std") {
        const windowReports = reports
          .filter((report) => report.reportDate <= exactReport.reportDate)
          .slice(0, windowSize);
        windowReportCount = windowReports.length;
        const soldValues = windowReports.map((report) => quantity(report.soldQuantity));
        const mean = soldValues.length > 0
          ? soldValues.reduce((sum, value) => sum + value, 0) / soldValues.length
          : 0;
        const variance = soldValues.length > 0
          ? soldValues.reduce((sum, value) => sum + (value - mean) ** 2, 0) / soldValues.length
          : 0;
        const std = Math.sqrt(variance);
        windowMean = mean;
        windowStd = std;
        if (windowReportCount >= minReports) {
          usedWindowMeanStd = true;
          protectedDemandQuantity = Math.round((mean + stdMultiplier * std) * 1_000) / 1_000;
        } else {
          warnings.push(`${location.locationCode}:dynamic_window_insufficient_reports:${windowReportCount}`);
        }
      }
      const netDemandQuantity = Math.max(0, protectedDemandQuantity - saleableClosingQuantity);
      const upperBatchQuantity = roundUpToBatch(netDemandQuantity, quantity(dynamicPolicy.batchSize));
      return {
        locationId: location.locationId,
        locationCode: location.locationCode,
        reportCount: reports.length,
        latestReportDate: exactReport.reportDate,
        peakSoldQuantity: soldQuantity,
        latestClosingQuantity: saleableClosingQuantity,
        protectedDemandQuantity,
        netDemandQuantity,
        lowerBatchQuantity: netDemandQuantity > 0
          ? Math.floor(netDemandQuantity / quantity(dynamicPolicy.batchSize)) * quantity(dynamicPolicy.batchSize)
          : 0,
        upperBatchQuantity,
        recommendedQuantity: upperBatchQuantity,
        ...(formulaMethod === "window_mean_plus_k_std" ? { windowMean, windowStd, windowReportCount } : {}),
        roundingDecision: upperBatchQuantity > 0
          ? (usedWindowMeanStd
            ? "dynamic_window_mean_std_round_up_to_batch" as const
            : "dynamic_exact_report_round_up_to_batch" as const)
          : "dynamic_exact_no_new_order_needed" as const,
        latestReportSource: {
          reportId: exactReport.reportId ?? null,
          reportUpdatedAt: exactReport.reportUpdatedAt ?? null,
          breadRowPresent: true,
        },
        closureReason,
        dynamicInboundPolicy: policySnapshot,
      };
    }

    const fixedPolicy = resolveFixedVehicleBreadInboundPolicy(location, deliveryDate, fixedInboundPolicies);
    if (fixedPolicy) {
      return {
        locationId: location.locationId,
        locationCode: location.locationCode,
        reportCount: reports.length,
        latestReportDate: reports[0]?.reportDate ?? null,
        peakSoldQuantity,
        latestClosingQuantity,
        protectedDemandQuantity: quantity(fixedPolicy.quantity),
        netDemandQuantity: quantity(fixedPolicy.quantity),
        lowerBatchQuantity: quantity(fixedPolicy.quantity),
        upperBatchQuantity: quantity(fixedPolicy.quantity),
        recommendedQuantity: quantity(fixedPolicy.quantity),
        roundingDecision: "fixed_daily_inbound_policy" as const,
        latestReportSource,
        closureReason,
        fixedInboundPolicy: {
          policyCode: fixedPolicy.policyCode,
          skuCode: fixedPolicy.skuCode,
          quantity: quantity(fixedPolicy.quantity),
          effectiveFromServiceDate: fixedPolicy.effectiveFromServiceDate,
          effectiveFromCutoffDate: fixedPolicy.effectiveFromCutoffDate,
        },
      };
    }

    if (reports.length === 0) {
      warnings.push(`${location.locationCode}:no_submitted_bread_report`);
      return {
        locationId: location.locationId,
        locationCode: location.locationCode,
        reportCount: 0,
        latestReportDate: null,
        peakSoldQuantity: 0,
        latestClosingQuantity: 0,
        protectedDemandQuantity: 0,
        netDemandQuantity: 0,
        lowerBatchQuantity: 0,
        upperBatchQuantity: 0,
        recommendedQuantity: 0,
        roundingDecision: "no_submitted_report" as const,
        latestReportSource: null,
        closureReason,
      };
    }
    const batchSelection = selectSmartPateBatchQuantity(peakSoldQuantity, latestClosingQuantity);

    return {
      locationId: location.locationId,
      locationCode: location.locationCode,
      reportCount: reports.length,
      latestReportDate: reports[0].reportDate,
      peakSoldQuantity,
      latestClosingQuantity,
      ...batchSelection,
      recommendedQuantity: closureReason ? 0 : batchSelection.recommendedQuantity,
      roundingDecision: closureReason ? "lunar_day_30_monthly_off" as const : batchSelection.roundingDecision,
      latestReportSource: { reportId: reports[0].reportId ?? null, reportUpdatedAt: reports[0].reportUpdatedAt ?? null },
      closureReason,
    };
  });

  return {
    totalQuantity: forecasts.reduce((sum, row) => sum + row.recommendedQuantity, 0),
    formulaVersion: usedDynamicPolicy ? DYNAMIC_BHN_FORMULA_VERSION : FORMULA_VERSION,
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
  const dealerExchange = quantity(input.dealerExchangeQuantity);
  const dealerMakeup = quantity(input.dealerMakeupQuantity);
  const vehicle = quantity(input.vehicleQuantity);
  const vehicleExchange = quantity(input.vehicleExchangeQuantity);
  const vehicleMakeup = quantity(input.vehicleMakeupQuantity);
  const mamNonOrdered = quantity(input.mamNonOrderedQuantity);
  const totalNewOrder = dealerOrdered + vehicle + mamNonOrdered;
  const totalExchange = dealerExchange + vehicleExchange;
  const totalMakeup = dealerMakeup + vehicleMakeup;
  const totalSupplierCredit = totalExchange + totalMakeup;
  const rawTotalBmq = totalNewOrder + totalSupplierCredit;
  const roundedTotalBmq = roundTotalBmqForPateBatch(rawTotalBmq);
  const roundingAdjustment = roundedTotalBmq - rawTotalBmq;
  const supplierBillableQuantity = roundedTotalBmq - totalSupplierCredit;
  const roundedVietjet = roundBreadOrderMessageQuantity(input.vietjetQuantity);

  return [
    "📦 ĐƠN ĐẶT HÀNG BMQ",
    `Ngày giao: ${day}/${month}/${year}`,
    "NCC: BMQ - HKD Tuyết Anh",
    "",
    "━━━━━━━━━━━━━━",
    "1️⃣ BÁNH MÌ QUE BMQ",
    "━━━━━━━━━━━━━━",
    "",
    "ĐẶT MỚI",
    `• Đại lý: ${formatSupplierQuantity(dealerOrdered)} que`,
    `• Điểm bán: ${formatSupplierQuantity(vehicle)} que`,
    ...(mamNonOrdered > 0 ? [`• Mầm non May: ${formatSupplierQuantity(mamNonOrdered)} que`] : []),
    `• Cộng đặt mới: ${formatSupplierQuantity(totalNewOrder)} que`,
    "",
    "ĐỔI / BÙ / TRẢ",
    `• Đổi, trả: ${formatSupplierQuantity(totalExchange)} que`,
    `  └ Đại lý ${formatSupplierQuantity(dealerExchange)} · Điểm bán ${formatSupplierQuantity(vehicleExchange)}`,
    `• Bù: ${formatSupplierQuantity(totalMakeup)} que`,
    `• Tổng khấu trừ: ${formatSupplierQuantity(totalSupplierCredit)} que`,
    "",
    "NCC CẦN GIAO",
    `• Nhu cầu thực tế: ${formatSupplierQuantity(rawTotalBmq)} que`,
    `• Điều chỉnh đủ mẻ: +${formatSupplierQuantity(roundingAdjustment)} que`,
    `• Tổng giao: ${formatSupplierQuantity(roundedTotalBmq)} que`,
    "",
    "GHI NHẬN CÔNG NỢ NCC",
    `• Số lượng giao: ${formatSupplierQuantity(roundedTotalBmq)} que`,
    `• Khấu trừ đổi/bù/trả: −${formatSupplierQuantity(totalSupplierCredit)} que`,
    `• Số lượng tính tiền: ${formatSupplierQuantity(supplierBillableQuantity)} que`,
    "",
    "━━━━━━━━━━━━━━",
    "2️⃣ BÁNH MÌ VIETJET",
    "━━━━━━━━━━━━━━",
    "",
    `• Số lượng đặt: ${formatSupplierQuantity(roundedVietjet)}`,
    `• Số lượng NCC giao: ${formatSupplierQuantity(roundedVietjet)}`,
    `• Ghi nhận công nợ: ${formatSupplierQuantity(roundedVietjet)}`,
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
    if (location.staffNoteOrderOverride) extras.push("theo ghi chú DAT");
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

export type DailyBreadOrderCorrectionInput = DailyBreadOrderMessageInput & {
  affectedLocationName: string;
  affectedDeltaQuantity: number;
};

export type WarehouseKioskBreadDispatchCorrectionInput = WarehouseKioskBreadDispatchInput & {
  affectedLocationName: string;
  previousAffectedQuantity: number;
  correctedAffectedQuantity: number;
};

export function buildDailyBreadOrderCorrectionMessage(input: DailyBreadOrderCorrectionInput): string {
  const replacement = buildDailyBreadOrderMessage(input);
  const delta = signedQuantity(input.affectedDeltaQuantity);
  return [
    "ĐIỀU CHỈNH ĐẶT BÁNH - THAY THẾ TOÀN BỘ",
    `Chênh lệch điểm bị sửa (${input.affectedLocationName}): ${formatQuantity(Math.abs(delta))} que ${delta >= 0 ? "tăng" : "giảm"}`,
    "Tổng đúng sau chỉnh sửa:",
    replacement,
  ].join("\n");
}

export function buildWarehouseKioskBreadDispatchCorrectionMessage(input: WarehouseKioskBreadDispatchCorrectionInput): string {
  const replacement = buildWarehouseKioskBreadDispatchMessage(input);
  const delta = signedQuantity(input.correctedAffectedQuantity) - signedQuantity(input.previousAffectedQuantity);
  return [
    "ĐIỀU CHỈNH GIAO BÁNH KHO - THAY THẾ TOÀN BỘ",
    `Chênh lệch điểm bị sửa (${input.affectedLocationName}): ${formatQuantity(Math.abs(delta))} que ${delta >= 0 ? "tăng" : "giảm"}`,
    "Tổng đúng sau chỉnh sửa:",
    replacement,
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
