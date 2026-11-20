/**
 * Pure dealer report builder.
 *
 * The Edge Function only loads rows and resolves the session; every number in
 * the response is computed here so the report contract can be tested without a
 * database. Delivery dates use `requested_delivery_date` and fall back to the
 * Vietnam (UTC+7) calendar date of `submitted_at`.
 */

export const VIETNAM_UTC_OFFSET_MS = 7 * 60 * 60 * 1000;
export const DEALER_REPORT_NO_ROUTE = "(không ghi)";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAY_WINDOW_DAYS = 56;

export type DealerReportRow = {
  order_number: string | null;
  status: string | null;
  requested_delivery_date: string | null;
  submitted_at: string | null;
  route_customer_name: string | null;
  quantity: number | string | null;
  exchange_quantity: number | string | null;
  makeup_quantity: number | string | null;
  line_total_vnd: number | string | null;
};

export type BuildDealerReportInput = {
  rows: DealerReportRow[];
  isNpp: boolean;
  month: string;
  today: string | Date;
};

type ReportLine = {
  orderNumber: string;
  deliveryDate: string;
  routeName: string;
  quantity: number;
  exchangeQuantity: number;
  makeupQuantity: number;
  amountVnd: number;
};

type OrderTotals = {
  orderNumber: string;
  deliveryDate: string;
  quantity: number;
  exchangeQuantity: number;
  makeupQuantity: number;
  amountVnd: number;
};

export function buildDealerReport({ rows, isNpp, month, today }: BuildDealerReportInput) {
  if (!isValidReportMonth(month)) throw new Error("invalid_report_month");

  const todayKey = normalizeToday(today);
  const currentMonth = todayKey.slice(0, 7);
  const startDate = monthStartKey(month);
  const daysElapsed = month === currentMonth
    ? daysBetween(startDate, todayKey) + 1
    : daysInMonth(month);
  const endDate = month === currentMonth ? todayKey : monthEndKey(month);

  const lines = rows
    .filter((row) => String(row.status ?? "").toLowerCase() !== "cancelled")
    .map(toReportLine)
    .filter((line): line is ReportLine => line !== null);

  const allDaily = new Map<string, number>();
  lines.forEach((line) => {
    allDaily.set(line.deliveryDate, (allDaily.get(line.deliveryDate) ?? 0) + line.quantity);
  });

  const orders = new Map<string, OrderTotals>();
  lines.forEach((line) => {
    const current = orders.get(line.orderNumber);
    if (current) {
      current.quantity += line.quantity;
      current.exchangeQuantity += line.exchangeQuantity;
      current.makeupQuantity += line.makeupQuantity;
      current.amountVnd += line.amountVnd;
      return;
    }
    orders.set(line.orderNumber, {
      orderNumber: line.orderNumber,
      deliveryDate: line.deliveryDate,
      quantity: line.quantity,
      exchangeQuantity: line.exchangeQuantity,
      makeupQuantity: line.makeupQuantity,
      amountVnd: line.amountVnd,
    });
  });

  const periodOrders = [...orders.values()].filter((order) =>
    inDateRange(order.deliveryDate, startDate, endDate)
  );
  const summary = summarize(periodOrders);

  const previousMonth = addMonths(month, -1);
  const previousStart = monthStartKey(previousMonth);
  const previousDays = daysInMonth(previousMonth);
  const previousSamePeriodEnd = addDays(previousStart, Math.min(daysElapsed, previousDays) - 1);
  const previousSamePeriodQuantity = sumQuantity(lines, previousStart, previousSamePeriodEnd);
  const previousFullQuantity = sumQuantity(lines, previousStart, monthEndKey(previousMonth));
  const previousAvgPerDay = previousDays > 0 ? previousFullQuantity / previousDays : 0;

  const daily: { date: string; quantity: number }[] = [];
  for (let cursor = dateKeyToUtcMs(startDate); cursor <= dateKeyToUtcMs(endDate); cursor += DAY_MS) {
    const date = utcMsToDateKey(cursor);
    daily.push({ date, quantity: allDaily.get(date) ?? 0 });
  }

  const weekdayTotals = new Array<number>(7).fill(0);
  const weekdayDays = new Array<number>(7).fill(0);
  const weekdayWindowStart = dateKeyToUtcMs(endDate) - (WEEKDAY_WINDOW_DAYS - 1) * DAY_MS;
  for (let cursor = weekdayWindowStart; cursor <= dateKeyToUtcMs(endDate); cursor += DAY_MS) {
    const date = utcMsToDateKey(cursor);
    if (!allDaily.has(date)) continue;
    const index = (new Date(cursor).getUTCDay() + 6) % 7;
    weekdayTotals[index] += allDaily.get(date) ?? 0;
    weekdayDays[index] += 1;
  }
  const weekday = weekdayTotals.map((total, index) =>
    weekdayDays[index] > 0 ? total / weekdayDays[index] : 0
  );

  const recentOrders = periodOrders
    .slice()
    .sort(compareOrdersNewestFirst)
    .slice(0, 5)
    .map((order) => ({
      order_number: order.orderNumber,
      delivery_date: order.deliveryDate,
      quantity: order.quantity,
      extra_quantity: order.exchangeQuantity + order.makeupQuantity,
      amount_vnd: order.amountVnd,
    }));

  const months = [-2, -1, 0].map((offset) => {
    const targetMonth = addMonths(month, offset);
    const targetStart = monthStartKey(targetMonth);
    const isCurrent = targetMonth === currentMonth;
    const targetEnd = isCurrent ? todayKey : monthEndKey(targetMonth);
    const targetDays = isCurrent ? daysBetween(targetStart, todayKey) + 1 : daysInMonth(targetMonth);
    const targetOrders = [...orders.values()].filter((order) =>
      inDateRange(order.deliveryDate, targetStart, targetEnd)
    );
    const quantity = targetOrders.reduce((sum, order) => sum + order.quantity, 0);
    return {
      month: targetMonth,
      order_count: targetOrders.length,
      quantity,
      avg_per_day: targetDays > 0 ? quantity / targetDays : 0,
      amount_vnd: targetOrders.reduce((sum, order) => sum + order.amountVnd, 0),
    };
  });

  let points: {
    name: string;
    quantity: number;
    avg_per_day: number;
    prev_avg_per_day: number;
    change_pct: number | null;
  }[] | null = null;

  if (isNpp) {
    const currentByRoute = new Map<string, number>();
    const previousByRoute = new Map<string, number>();
    const previousEnd = monthEndKey(previousMonth);

    lines.forEach((line) => {
      if (inDateRange(line.deliveryDate, startDate, endDate)) {
        currentByRoute.set(line.routeName, (currentByRoute.get(line.routeName) ?? 0) + line.quantity);
      }
      if (inDateRange(line.deliveryDate, previousStart, previousEnd)) {
        previousByRoute.set(line.routeName, (previousByRoute.get(line.routeName) ?? 0) + line.quantity);
      }
    });

    points = [...currentByRoute.entries()]
      .map(([name, quantity]) => {
        const avgPerDay = daysElapsed > 0 ? quantity / daysElapsed : 0;
        const previousQuantity = previousByRoute.get(name) ?? 0;
        const previousRouteAvg = previousDays > 0 ? previousQuantity / previousDays : 0;
        return {
          name,
          quantity,
          avg_per_day: avgPerDay,
          prev_avg_per_day: previousRouteAvg,
          change_pct: percentageChange(avgPerDay, previousRouteAvg),
        };
      })
      .sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name));
  }

  return {
    period: {
      month,
      start_date: startDate,
      end_date: endDate,
      days_elapsed: daysElapsed,
    },
    summary: {
      order_count: summary.orderCount,
      quantity: summary.quantity,
      amount_vnd: summary.amountVnd,
      exchange_quantity: summary.exchangeQuantity,
      makeup_quantity: summary.makeupQuantity,
      delivery_days: summary.deliveryDays,
      avg_per_day: daysElapsed > 0 ? summary.quantity / daysElapsed : 0,
    },
    comparison: {
      prev_same_period_quantity: previousSamePeriodQuantity,
      same_period_change_pct: percentageChange(summary.quantity, previousSamePeriodQuantity),
      prev_avg_per_day: previousAvgPerDay,
      avg_change_pct: percentageChange(
        daysElapsed > 0 ? summary.quantity / daysElapsed : 0,
        previousAvgPerDay,
      ),
    },
    daily,
    weekday,
    recent_orders: recentOrders,
    months,
    points,
  };
}

export function isValidReportMonth(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = value.trim().match(/^(\d{4})-(\d{2})$/);
  if (!match) return false;
  const month = Number(match[2]);
  return month >= 1 && month <= 12;
}

export function isReportMonthAllowed(month: string, today: string): boolean {
  const currentMonth = normalizeToday(today).slice(0, 7);
  return month <= currentMonth && month >= addMonths(currentMonth, -24);
}

export function vietnamDateKey(value: Date = new Date()): string {
  return utcMsToDateKey(value.getTime() + VIETNAM_UTC_OFFSET_MS);
}

export function vietnamDayStartIso(dateKey: string): string {
  return new Date(dateKeyToUtcMs(dateKey) - VIETNAM_UTC_OFFSET_MS).toISOString();
}

export function monthStartKey(month: string): string {
  return `${month}-01`;
}

export function monthEndKey(month: string): string {
  return `${month}-${String(daysInMonth(month)).padStart(2, "0")}`;
}

export function addMonths(month: string, offset: number): string {
  const [year, monthNumber] = month.split("-").map(Number);
  const absolute = year * 12 + (monthNumber - 1) + offset;
  const nextYear = Math.floor(absolute / 12);
  const nextMonth = (absolute % 12 + 12) % 12;
  return `${nextYear}-${String(nextMonth + 1).padStart(2, "0")}`;
}

export function addDays(dateKey: string, offset: number): string {
  return utcMsToDateKey(dateKeyToUtcMs(dateKey) + offset * DAY_MS);
}

function toReportLine(row: DealerReportRow): ReportLine | null {
  if (String(row.status ?? "").toLowerCase() === "cancelled") return null;

  const deliveryDate = dateKeyFromValue(row.requested_delivery_date) ??
    deliveryDateFromSubmittedAt(row.submitted_at);
  if (!deliveryDate) return null;

  return {
    orderNumber: String(row.order_number ?? ""),
    deliveryDate,
    routeName: normalizeRouteName(row.route_customer_name),
    quantity: numberValue(row.quantity),
    exchangeQuantity: numberValue(row.exchange_quantity),
    makeupQuantity: numberValue(row.makeup_quantity),
    amountVnd: numberValue(row.line_total_vnd),
  };
}

function summarize(orders: OrderTotals[]) {
  return {
    orderCount: orders.length,
    quantity: orders.reduce((sum, order) => sum + order.quantity, 0),
    amountVnd: orders.reduce((sum, order) => sum + order.amountVnd, 0),
    exchangeQuantity: orders.reduce((sum, order) => sum + order.exchangeQuantity, 0),
    makeupQuantity: orders.reduce((sum, order) => sum + order.makeupQuantity, 0),
    deliveryDays: new Set(orders.map((order) => order.deliveryDate)).size,
  };
}

function sumQuantity(lines: ReportLine[], startDate: string, endDate: string): number {
  return lines.reduce(
    (sum, line) => inDateRange(line.deliveryDate, startDate, endDate) ? sum + line.quantity : sum,
    0,
  );
}

function percentageChange(current: number, previous: number): number | null {
  return previous === 0 ? null : (current - previous) / previous;
}

function compareOrdersNewestFirst(a: OrderTotals, b: OrderTotals): number {
  if (a.deliveryDate !== b.deliveryDate) return a.deliveryDate < b.deliveryDate ? 1 : -1;
  if (a.orderNumber === b.orderNumber) return 0;
  return a.orderNumber < b.orderNumber ? 1 : -1;
}

function normalizeRouteName(value: string | null): string {
  return String(value ?? "").trim() || DEALER_REPORT_NO_ROUTE;
}

function numberValue(value: number | string | null | undefined): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeToday(value: string | Date): string {
  if (value instanceof Date) return vietnamDateKey(value);
  return dateKeyFromValue(value) ?? vietnamDateKey();
}

function deliveryDateFromSubmittedAt(value: string | null): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return dateKeyFromValue(raw);

  const normalized = /(?:z|[+-]\d{2}:?\d{2})$/i.test(raw)
    ? raw
    : `${raw.replace(" ", "T")}Z`;
  const parsed = Date.parse(normalized);
  if (!Number.isNaN(parsed)) return utcMsToDateKey(parsed + VIETNAM_UTC_OFFSET_MS);

  return dateKeyFromValue(raw);
}

function dateKeyFromValue(value: string | null): string | null {
  const raw = String(value ?? "").trim();
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  const key = `${match[1]}-${match[2]}-${match[3]}`;
  return isRealDateKey(key) ? key : null;
}

function isRealDateKey(key: string): boolean {
  const [year, month, day] = key.split("-").map(Number);
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year &&
    probe.getUTCMonth() === month - 1 &&
    probe.getUTCDate() === day;
}

function daysInMonth(month: string): number {
  const [year, monthNumber] = month.split("-").map(Number);
  return new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
}

function daysBetween(startDate: string, endDate: string): number {
  return Math.floor((dateKeyToUtcMs(endDate) - dateKeyToUtcMs(startDate)) / DAY_MS);
}

function inDateRange(date: string, startDate: string, endDate: string): boolean {
  return date >= startDate && date <= endDate;
}

function dateKeyToUtcMs(dateKey: string): number {
  const [year, month, day] = dateKey.split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

function utcMsToDateKey(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
