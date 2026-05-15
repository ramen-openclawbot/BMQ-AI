import { type KeyboardEvent, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, CalendarDays, CheckCircle2, Loader2, Settings, Users } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { useLanguage } from "@/contexts/LanguageContext";

const vnd = (v: number) =>
  new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(v || 0);

const numberFmt = (v: number) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 }).format(v || 0);

const compactVnd = (v: number) => {
  const abs = Math.abs(v || 0);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1_000_000_000) return `${sign}${numberFmt(abs / 1_000_000_000)} tỷ ₫`;
  if (abs >= 1_000_000) return `${sign}${numberFmt(abs / 1_000_000)} tr ₫`;
  return vnd(v);
};

const MOM_PREVIOUS_COLOR = "#F2C15C";
const MOM_CURRENT_COLOR = "#34D399";
const FORECAST_REMAINDER_COLOR = "#F59E0B";

const vietnamToday = () => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) => parts.find((part) => part.type === type)?.value || "01";
  return { year: Number(get("year")), month: Number(get("month")), day: Number(get("day")) };
};

const monthNow = () => {
  const d = vietnamToday();
  return `${d.year}-${String(d.month).padStart(2, "0")}`;
};

type RevenueLine = {
  id: string;
  period: string;
  revenue_date: string;
  channel: string;
  source_tab: string | null;
  customer_id: string | null;
  parent_customer_id: string | null;
  customer_name: string;
  quantity: number | null;
  gross_revenue: number | null;
  source_type: string;
  approval_status: string;
  audit_status: string;
  confidence_status: string;
  review_status: string;
  reconciliation_status: string;
  raw_payload: unknown;
};

type RevenueQuery = PromiseLike<{ data: RevenueLine[] | null; error: { message?: string } | null }> & {
  eq: (column: string, value: string) => RevenueQuery;
  in: (column: string, values: string[]) => RevenueQuery;
  order: (column: string, options: { ascending: boolean }) => RevenueQuery;
  range: (from: number, to: number) => RevenueQuery;
};

const db = supabase as unknown as {
  from: (table: string) => { select: (columns: string) => RevenueQuery };
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const normalizedCustomerName = (value: string) =>
  value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleUpperCase("vi-VN");

type CustomerRollup = { key: string; name: string };

const previousMonth = (period: string) => {
  const [year, month] = period.split("-").map(Number);
  const d = new Date(year, month - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

const daysInPeriod = (period: string) => {
  const [year, month] = period.split("-").map(Number);
  return new Date(year, month, 0).getDate();
};

const dayOfMonth = (date: string) => {
  const n = Number(date.slice(8, 10));
  return Number.isFinite(n) ? n : 0;
};

const safeNumber = (value: unknown) => {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
};

const lineRevenue = (row: RevenueLine) => safeNumber(row.gross_revenue);

const lineDateDay = (row: RevenueLine) => dayOfMonth(row.revenue_date);

const dispatchAmountBucket = (row: RevenueLine) => {
  const raw = asRecord(row.raw_payload);
  const status = String(raw.revenue_amount_status || raw.dispatch_confirmation_status || "");
  if (status === "confirmed_dispatch_amount" || status === "month_end_audit_adjusted" || status === "confirmed" || status === "revised") return "confirmed";
  if (status === "needs_sku_allocation") return "needsAllocation";
  return "temporary";
};

const lineWeekday = (date: string) => {
  const d = new Date(`${date}T00:00:00+07:00`);
  return Number.isFinite(d.getTime()) ? d.getDay() : 0;
};

const extractRawText = (rawPayload: unknown, keys: string[]) => {
  const raw = asRecord(rawPayload);
  const records = [raw, asRecord(raw.product), asRecord(raw.sku), asRecord(raw.item), asRecord(raw.line_item)];

  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number" && Number.isFinite(value)) return String(value);
    }
  }

  return "";
};

const productSkuKey = (row: RevenueLine) => {
  const keys = ["product", "product_name", "product_code", "product_group", "sku", "sku_id", "sku_code", "sku_name"];
  const rawValue = extractRawText(row.raw_payload, keys);
  if (rawValue) return rawValue.toLocaleUpperCase("vi-VN");

  const rowRecord = row as unknown as Record<string, unknown>;
  for (const key of keys) {
    const value = rowRecord[key];
    if (typeof value === "string" && value.trim()) return value.trim().toLocaleUpperCase("vi-VN");
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }

  return row.source_tab ? `SOURCE:${row.source_tab}` : "unknown";
};

const timingBucket = (day: number, periodDays: number) => {
  if (day <= Math.ceil(periodDays / 3)) return "early";
  if (day <= Math.ceil((periodDays * 2) / 3)) return "mid";
  return "late";
};

const timingBucketLabel: Record<string, string> = {
  early: "đầu tháng",
  mid: "giữa tháng",
  late: "cuối tháng",
};

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const dateForPeriodDay = (period: string, day: number) => `${period}-${String(day).padStart(2, "0")}`;

const sumRevenue = (rows: RevenueLine[]) => rows.reduce((sum, r) => sum + lineRevenue(r), 0);

const maxRevenueDay = (rows: RevenueLine[], fallbackPeriod: string) => {
  const latest = rows.reduce((max, r) => Math.max(max, dayOfMonth(r.revenue_date)), 0);
  if (latest > 0) return latest;
  return fallbackPeriod === monthNow() ? vietnamToday().day : daysInPeriod(fallbackPeriod);
};

async function fetchAllRevenueLines(period: string, controlledOnly: boolean) {
  const pageSize = 1000;
  const rows: RevenueLine[] = [];

  for (let from = 0; ; from += pageSize) {
    let q = db
      .from("revenue_ledger_lines")
      .select("id,period,revenue_date,channel,source_tab,customer_id,parent_customer_id,customer_name,quantity,gross_revenue,source_type,approval_status,audit_status,confidence_status,review_status,reconciliation_status,raw_payload,source_document:revenue_source_documents!inner(status)")
      .eq("period", period)
      .order("revenue_date", { ascending: true })
      .range(from, from + pageSize - 1);

    if (controlledOnly) q = q.eq("approval_status", "approved").in("source_document.status", ["controlled", "trusted"]);

    const { data, error } = await q;
    if (error) throw error;
    const batch = (data || []) as RevenueLine[];
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
  }
}

const channelLabel: Record<string, string> = {
  "Bread business wholesale channel": "Bánh mì wholesale",
  "Bakery business": "Bánh ngọt",
  Franchise: "Nhượng quyền / đại lý",
  "Retail kiosk": "Xe bán lẻ",
  "ĐẠI LÝ": "Đại lý",
  "BÁNH NGỌT": "Bánh ngọt",
  "B2B BMQ": "B2B BMQ",
  "Retail Kiosk": "Retail kiosk",
};

const sourceTypeLabel: Record<string, string> = {
  csv_audit: "Nguồn đối soát",
  manual_invoice: "Invoice",
  po_parse: "PO parse",
  email_parse: "Email parse",
  po_email_parse: "PO/email đã duyệt",
  csv_import: "CSV",
  csv: "CSV",
  email: "Email",
  parsed_po: "Parsed PO",
  po: "PO",
  manual: "Manual",
};

const metricCards = [
  {
    key: "approved",
    label: "Đã vào ledger",
    helper: "Dòng đã kiểm soát",
    detailLabel: "Chạm để xem chi tiết",
    params: { scope: "controlled_ledger" },
    icon: CheckCircle2,
    valueTone: "text-emerald-200",
    iconShell: "border-emerald-300/25 bg-emerald-400/[0.08] text-emerald-200",
    cardTone: "from-stone-900/95 via-stone-950 to-stone-900/70",
  },
  {
    key: "qty",
    label: "Sản lượng",
    helper: "Quantity from ledger",
    detailLabel: "Chạm để xem chi tiết",
    params: { scope: "controlled_ledger", focus: "quantity" },
    icon: CalendarDays,
    valueTone: "text-amber-100/80",
    iconShell: "border-amber-300/20 bg-amber-400/[0.08] text-amber-300/70",
    cardTone: "from-stone-900/95 via-stone-950 to-stone-900/70",
  },
  {
    key: "customers",
    label: "Customer/NPP",
    helper: "Roll-up groups",
    detailLabel: "Chạm để xem chi tiết",
    params: { scope: "controlled_ledger", focus: "customers" },
    icon: Users,
    valueTone: "text-stone-100",
    iconShell: "border-stone-500/30 bg-stone-400/[0.08] text-stone-300",
    cardTone: "from-stone-900/95 via-stone-950 to-stone-900/70",
  },
] as const;

const CHANNEL_COLORS = ["#FCD34D", "#FBBF24", "#6EE7B7", "#FCA5A5", "#D6D3D1"] as const;

const getChannelColor = (key: string, fallbackIndex: number) => {
  const knownIndex = Object.keys(channelLabel).indexOf(key);
  return CHANNEL_COLORS[(knownIndex >= 0 ? knownIndex : fallbackIndex) % CHANNEL_COLORS.length];
};

export default function RevenueManagementDashboard() {
  const { language } = useLanguage();
  const isVi = language === "vi";
  const navigate = useNavigate();
  const initialPeriod = new URLSearchParams(window.location.search).get("period") || monthNow();
  const [period, setPeriod] = useState(initialPeriod);
  const prevPeriod = previousMonth(period);
  const forecastBasePeriod = previousMonth(prevPeriod);
  const isSelectedCurrentMonth = period === monthNow();

  const { data: lines = [], isLoading, error } = useQuery<RevenueLine[]>({
    queryKey: ["revenue-ledger-lines", period],
    queryFn: async () => {
      return fetchAllRevenueLines(period, true);
    },
    refetchOnWindowFocus: true,
    refetchInterval: isSelectedCurrentMonth ? 5 * 60 * 1000 : false,
  });

  const { data: previousLines = [] } = useQuery<RevenueLine[]>({
    queryKey: ["revenue-ledger-lines", prevPeriod],
    queryFn: async () => fetchAllRevenueLines(prevPeriod, true),
    refetchOnWindowFocus: true,
  });

  const { data: forecastBaseLines = [] } = useQuery<RevenueLine[]>({
    queryKey: ["revenue-ledger-lines", forecastBasePeriod],
    queryFn: async () => fetchAllRevenueLines(forecastBasePeriod, true),
    refetchOnWindowFocus: true,
  });

  const stats = useMemo(() => {
    const total = lines.reduce((sum, r) => sum + Number(r.gross_revenue || 0), 0);
    const qty = lines.reduce((sum, r) => sum + Number(r.quantity || 0), 0);
    const approved = lines.filter((r) => r.approval_status === "approved").reduce((sum, r) => sum + Number(r.gross_revenue || 0), 0);
    const customers = new Set(lines.map((r) => r.parent_customer_id || r.customer_id || r.customer_name)).size;
    const dispatchTemporary = lines.filter((r) => dispatchAmountBucket(r) === "temporary").length;
    const dispatchConfirmed = lines.filter((r) => dispatchAmountBucket(r) === "confirmed").length;
    const dispatchNeedsAllocation = lines.filter((r) => dispatchAmountBucket(r) === "needsAllocation").length;
    return { total, qty, approved, customers, rows: lines.length, dispatchTemporary, dispatchConfirmed, dispatchNeedsAllocation };
  }, [lines]);

  const byDay = useMemo(() => {
    const map = new Map<string, { date: string; revenue: number }>();
    for (const row of lines) {
      const key = row.revenue_date;
      const cur = map.get(key) || { date: key.slice(5), revenue: 0 };
      cur.revenue += Number(row.gross_revenue || 0);
      map.set(key, cur);
    }
    return Array.from(map.values());
  }, [lines]);

  const byChannel = useMemo(() => {
    const map = new Map<string, { key: string; label: string; revenue: number; qty: number; rows: number }>();
    for (const row of lines) {
      const key = row.channel || "unknown";
      const cur = map.get(key) || { key, label: channelLabel[key] || key, revenue: 0, qty: 0, rows: 0 };
      cur.revenue += Number(row.gross_revenue || 0);
      cur.qty += Number(row.quantity || 0);
      cur.rows += 1;
      map.set(key, cur);
    }
    return Array.from(map.values()).sort((a, b) => b.revenue - a.revenue);
  }, [lines]);

  const mom = useMemo(() => {
    const previousTotal = sumRevenue(previousLines);
    const delta = stats.total - previousTotal;
    const pct = previousTotal > 0 ? (delta / previousTotal) * 100 : null;
    return {
      previousTotal,
      delta,
      pct,
    };
  }, [previousLines, stats.total]);

  const forecast = useMemo(() => {
    const periodDays = daysInPeriod(period);
    const cutoffDay = Math.min(maxRevenueDay(lines, period), periodDays);
    const remainingDays = Math.max(periodDays - cutoffDay, 0);
    const actualControlled = stats.total;
    const currentProductTotals = new Map<string, number>();
    const currentChannelTotals = new Map<string, number>();
    const currentCustomerTotals = new Map<string, number>();
    const currentDailyTotals = new Map<number, number>();

    for (const row of lines) {
      const revenue = lineRevenue(row);
      const productKey = productSkuKey(row);
      const channelKey = row.channel || "unknown";
      const customerKey = row.parent_customer_id || row.customer_id || row.customer_name || "unknown";
      const day = lineDateDay(row);

      currentProductTotals.set(productKey, (currentProductTotals.get(productKey) || 0) + revenue);
      currentChannelTotals.set(channelKey, (currentChannelTotals.get(channelKey) || 0) + revenue);
      currentCustomerTotals.set(customerKey, (currentCustomerTotals.get(customerKey) || 0) + revenue);
      if (day > 0) currentDailyTotals.set(day, (currentDailyTotals.get(day) || 0) + revenue);
    }

    const productKnownRevenue = Array.from(currentProductTotals.entries())
      .filter(([key]) => key !== "unknown" && !key.startsWith("SOURCE:"))
      .reduce((sum, [, revenue]) => sum + revenue, 0);
    const productMixCoverage = actualControlled > 0 ? productKnownRevenue / actualControlled : 0;
    const topChannel = Array.from(currentChannelTotals.entries()).sort((a, b) => b[1] - a[1])[0] || ["unknown", 0];
    const topCustomer = Array.from(currentCustomerTotals.entries()).sort((a, b) => b[1] - a[1])[0] || ["unknown", 0];
    const topChannelShare = actualControlled > 0 ? topChannel[1] / actualControlled : 0;
    const topCustomerShare = actualControlled > 0 ? topCustomer[1] / actualControlled : 0;
    const mtdDailyAverage = cutoffDay > 0 ? actualControlled / cutoffDay : 0;
    const recentDays = Array.from(currentDailyTotals.entries())
      .filter(([, revenue]) => revenue > 0)
      .sort((a, b) => b[0] - a[0])
      .slice(0, 7);
    const recentDailyAverage = recentDays.length > 0 ? recentDays.reduce((sum, [, revenue]) => sum + revenue, 0) / recentDays.length : mtdDailyAverage;

    const allBaselines = [
      { period: forecastBasePeriod, lines: forecastBaseLines },
      { period: prevPeriod, lines: previousLines },
    ].map((baseline) => {
      const total = sumRevenue(baseline.lines);
      const baselineDays = daysInPeriod(baseline.period);
      const dailyAverage = total > 0 ? total / baselineDays : 0;
      const productTotals = new Map<string, number>();
      const channelTotals = new Map<string, number>();
      const weekdayTotals = new Map<number, number>();
      const timingTotals = new Map<string, number>();

      for (const row of baseline.lines) {
        const revenue = lineRevenue(row);
        productTotals.set(productSkuKey(row), (productTotals.get(productSkuKey(row)) || 0) + revenue);
        channelTotals.set(row.channel || "unknown", (channelTotals.get(row.channel || "unknown") || 0) + revenue);
        weekdayTotals.set(lineWeekday(row.revenue_date), (weekdayTotals.get(lineWeekday(row.revenue_date)) || 0) + revenue);
        timingTotals.set(timingBucket(lineDateDay(row), baselineDays), (timingTotals.get(timingBucket(lineDateDay(row), baselineDays)) || 0) + revenue);
      }

      const baselineDailyAnchor = dailyAverage;
      const channelLiftFromComparableShares = actualControlled > 0 && total > 0
        ? Array.from(currentChannelTotals.entries()).reduce((sum, [key, revenue]) => {
          const currentShare = revenue / actualControlled;
          const baselineShare = (channelTotals.get(key) || 0) / total;
          const shareLift = key !== "unknown" && baselineShare > 0 ? currentShare / baselineShare : 1;
          return sum + currentShare * shareLift;
        }, 0)
        : 1;
      const channelMixFactor = actualControlled > 0 && total > 0
        ? clamp(channelLiftFromComparableShares || 1, 0.9, 1.1)
        : 1;
      const productLiftFromKnownProducts = actualControlled > 0 && total > 0 && productMixCoverage >= 0.25
        ? Array.from(currentProductTotals.entries()).reduce((sum, [key, revenue]) => {
          const currentShare = revenue / actualControlled;
          const baselineShare = (productTotals.get(key) || 0) / total;
          const hasKnownProduct = key !== "unknown" && !key.startsWith("SOURCE:");
          const shareLift = hasKnownProduct && baselineShare > 0 ? currentShare / baselineShare : 1;
          return sum + currentShare * shareLift;
        }, 0)
        : 1;
      const productMixFactor = productMixCoverage >= 0.25
        ? clamp(productLiftFromKnownProducts || 1, 0.9, 1.1)
        : 1;
      const baselineComparableFloor = dailyAverage * 0.9;
      const comparableDaily = clamp(
        baselineDailyAnchor * channelMixFactor * productMixFactor,
        baselineComparableFloor,
        dailyAverage * 1.15,
      );
      const elapsedTimingShare = total > 0
        ? Array.from(timingTotals.entries())
          .filter(([bucket]) => bucket === "early" || (cutoffDay > periodDays / 3 && bucket === "mid") || (cutoffDay > (periodDays * 2) / 3 && bucket === "late"))
          .reduce((sum, [, revenue]) => sum + revenue, 0) / total
        : 0;
      const projected = actualControlled + comparableDaily * remainingDays;
      return {
        ...baseline,
        total,
        baselineDays,
        dailyAverage,
        comparableDaily,
        elapsedTimingShare,
        weekdayTotals,
        projected,
      };
    });
    const baselines = allBaselines.filter((baseline) => baseline.total > 0);

    const baselineAverage = baselines.length > 0 ? baselines.reduce((sum, baseline) => sum + baseline.total, 0) / baselines.length : 0;
    const baselineDailyAverage = baselines.length > 0 ? baselines.reduce((sum, baseline) => sum + baseline.comparableDaily, 0) / baselines.length : mtdDailyAverage;
    const weekdayRevenue = new Map<number, number>();
    for (const baseline of baselines) {
      for (const [weekday, revenue] of baseline.weekdayTotals) weekdayRevenue.set(weekday, (weekdayRevenue.get(weekday) || 0) + revenue);
    }
    const weekdayCounts = new Map<number, number>();
    for (const baseline of baselines) {
      for (let day = 1; day <= baseline.baselineDays; day += 1) {
        const weekday = lineWeekday(dateForPeriodDay(baseline.period, day));
        weekdayCounts.set(weekday, (weekdayCounts.get(weekday) || 0) + 1);
      }
    }
    const totalBaselineDays = Array.from(weekdayCounts.values()).reduce((sum, count) => sum + count, 0);
    const overallWeekdayAverage = totalBaselineDays > 0 && baselines.length > 0
      ? baselines.reduce((sum, baseline) => sum + baseline.total, 0) / totalBaselineDays
      : baselineDailyAverage;
    const weekdayFactors = new Map<number, number>();
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const weekdayAverage = (weekdayRevenue.get(weekday) || 0) / Math.max(weekdayCounts.get(weekday) || 1, 1);
      weekdayFactors.set(weekday, overallWeekdayAverage > 0 ? clamp(weekdayAverage / overallWeekdayAverage, 0.6, 1.45) : 1);
    }
    const remainingWeekdayFactor = remainingDays > 0
      ? Array.from({ length: remainingDays }, (_, index) => weekdayFactors.get(lineWeekday(dateForPeriodDay(period, cutoffDay + index + 1))) || 1).reduce((sum, factor) => sum + factor, 0) / remainingDays
      : 1;
    const baselineElapsedShare = baselines.length > 0 ? baselines.reduce((sum, baseline) => sum + baseline.elapsedTimingShare, 0) / baselines.length : cutoffDay / Math.max(periodDays, 1);
    const currentMonthShare = baselineAverage > 0 ? actualControlled / baselineAverage : baselineElapsedShare;
    const timingFactor = baselineElapsedShare > 0 ? clamp(currentMonthShare / baselineElapsedShare, 0.85, 1.15) : 1;
    const trendFactor = mtdDailyAverage > 0 ? clamp(recentDailyAverage / mtdDailyAverage, 0.75, 1.25) : 1;
    const blendedDailyRate = Math.max(
      0,
      (baselineDailyAverage * 0.55 + recentDailyAverage * 0.35 + mtdDailyAverage * 0.1) * remainingWeekdayFactor * timingFactor * (0.85 + trendFactor * 0.15),
    );
    const scenarioValues = baselines.map((baseline) => actualControlled + baseline.comparableDaily * remainingWeekdayFactor * timingFactor * remainingDays).filter((value) => value > 0);
    const unclampedTotal = actualControlled + blendedDailyRate * remainingDays;
    const lowScenario = Math.min(...(scenarioValues.length ? scenarioValues : [unclampedTotal]));
    const highScenario = Math.max(...(scenarioValues.length ? scenarioValues : [unclampedTotal]));
    const low = Math.max(actualControlled, Math.min(unclampedTotal, lowScenario * 0.92));
    const high = Math.max(unclampedTotal, highScenario * 1.08, actualControlled);
    const total = Math.max(actualControlled, clamp(unclampedTotal, low, high));
    const remainder = Math.max(total - actualControlled, 0);
    const volatility = baselineAverage > 0 && baselines.length > 1
      ? Math.abs(baselines[0].total - baselines[1].total) / baselineAverage
      : 0;
    const confidenceScore = 100
      - (baselines.length < 2 ? 24 : 0)
      - (lines.length < 20 ? 14 : 0)
      - (productMixCoverage < 0.25 ? 12 : 0)
      - (topCustomerShare > 0.35 ? 16 : 0)
      - (topChannelShare > 0.6 ? 12 : 0)
      - (volatility > 0.25 ? 12 : 0);
    const confidenceLabel = confidenceScore >= 72 ? "Cao" : confidenceScore >= 48 ? "Trung bình" : "Thấp";
    const confidenceTone = confidenceLabel === "Cao"
      ? "border-emerald-300/35 bg-emerald-400/10 text-emerald-100"
      : confidenceLabel === "Trung bình"
        ? "border-amber-300/35 bg-amber-400/10 text-amber-100"
        : "border-rose-300/35 bg-rose-400/10 text-rose-100";
    const drivers = [
      productMixCoverage >= 0.25
        ? `Mix sản phẩm/SKU: ${numberFmt(productMixCoverage * 100)}% doanh thu có mã sản phẩm/SKU để so với baseline.`
        : `Mix sản phẩm/SKU: dữ liệu product/SKU còn mỏng (${numberFmt(productMixCoverage * 100)}%), forecast fallback về historical baseline + điều chỉnh channel/source có biên.`,
      `Mix kênh: kênh lớn nhất ${channelLabel[topChannel[0]] || topChannel[0]} chiếm ${numberFmt(topChannelShare * 100)}% doanh thu đã kiểm soát.`,
      remainingWeekdayFactor >= 1.05
        ? `Lịch ngày còn lại nghiêng về ngày cao điểm, hệ số weekday/peak khoảng ${numberFmt(remainingWeekdayFactor)}x.`
        : remainingWeekdayFactor <= 0.95
          ? `Lịch ngày còn lại nghiêng về ngày thấp điểm/downtime, hệ số weekday khoảng ${numberFmt(remainingWeekdayFactor)}x.`
          : `Lịch ngày còn lại gần trung tính theo mẫu weekday/peak/downtime (${numberFmt(remainingWeekdayFactor)}x).`,
      `Nhịp ${timingBucketLabel[timingBucket(cutoffDay, periodDays)]}: tiến độ hiện tại đạt ${numberFmt(currentMonthShare * 100)}% so với baseline tháng, hệ số timing ${numberFmt(timingFactor)}x.`,
      `Run-rate gần đây: ${compactVnd(recentDailyAverage)}/ngày so với MTD ${compactVnd(mtdDailyAverage)}/ngày, trend ${numberFmt(trendFactor)}x.`,
      topCustomerShare > 0.35 || topChannelShare > 0.6
        ? `Rủi ro tập trung: customer/kênh lớn đang cao (${numberFmt(topCustomerShare * 100)}% customer, ${numberFmt(topChannelShare * 100)}% kênh).`
        : `Rủi ro tập trung: customer/kênh ở mức kiểm soát (${numberFmt(topCustomerShare * 100)}% customer lớn nhất).`,
    ];

    return {
      cutoffDay,
      periodDays,
      actualControlled,
      total,
      low,
      high,
      remainder,
      baselineAverage,
      blendedDailyRate,
      productMixCoverage,
      confidenceLabel,
      confidenceTone,
      drivers,
      baselines,
      chart: [
        ...allBaselines.map((baseline) => ({
          month: baseline.period,
          baselineRevenue: baseline.total,
          controlledRevenue: 0,
          forecastRemaining: 0,
          kind: "baseline" as const,
        })),
        {
          month: period,
          baselineRevenue: 0,
          controlledRevenue: actualControlled,
          forecastRemaining: remainder,
          kind: "forecast" as const,
        },
      ],
    };
  }, [forecastBaseLines, forecastBasePeriod, lines, period, prevPeriod, previousLines, stats.total]);

  const byCustomer = useMemo(() => {
    const historicalParentByCustomerName = new Map<string, CustomerRollup>();

    for (const row of previousLines) {
      const raw = asRecord(row.raw_payload);
      const parentName = String(raw.parent_customer_name || "").trim();
      if (row.parent_customer_id || parentName) {
        historicalParentByCustomerName.set(normalizedCustomerName(row.customer_name), {
          key: row.parent_customer_id || parentName,
          name: parentName || row.customer_name || "Chưa rõ khách hàng",
        });
      }
    }

    const resolveRollup = (row: RevenueLine): CustomerRollup => {
      const raw = asRecord(row.raw_payload);
      const parentName = String(raw.parent_customer_name || "").trim();
      if (row.parent_customer_id || parentName) {
        return {
          key: row.parent_customer_id || parentName,
          name: parentName || row.customer_name || "Chưa rõ khách hàng",
        };
      }

      const historicalParent = historicalParentByCustomerName.get(normalizedCustomerName(row.customer_name));
      if (historicalParent) return historicalParent;

      return {
        key: row.customer_id || row.customer_name,
        name: row.customer_name || "Chưa rõ khách hàng",
      };
    };

    const previousMap = new Map<string, { revenue: number; name: string }>();
    for (const row of previousLines) {
      const rollup = resolveRollup(row);
      const cur = previousMap.get(rollup.key) || { revenue: 0, name: rollup.name };
      cur.revenue += Number(row.gross_revenue || 0);
      previousMap.set(rollup.key, cur);
    }

    const map = new Map<string, { key: string; name: string; revenue: number; previousRevenue: number; qty: number; rows: number; review: number; sourceTypes: Set<string> }>();
    for (const [key, prev] of previousMap) {
      map.set(key, { key, name: prev.name, revenue: 0, previousRevenue: prev.revenue, qty: 0, rows: 0, review: 0, sourceTypes: new Set<string>() });
    }

    for (const row of lines) {
      const rollup = resolveRollup(row);
      const cur = map.get(rollup.key) || { key: rollup.key, name: rollup.name, revenue: 0, previousRevenue: previousMap.get(rollup.key)?.revenue || 0, qty: 0, rows: 0, review: 0, sourceTypes: new Set<string>() };
      cur.name = rollup.name || cur.name;
      cur.revenue += Number(row.gross_revenue || 0);
      cur.qty += Number(row.quantity || 0);
      cur.rows += 1;
      if (row.review_status === "needs_manual_review" || row.audit_status === "needs_review") cur.review += Number(row.gross_revenue || 0);
      cur.sourceTypes.add(row.source_type);
      map.set(rollup.key, cur);
    }
    return Array.from(map.values())
      .map((row) => ({
        ...row,
        delta: row.revenue - row.previousRevenue,
        pct: row.previousRevenue > 0 ? ((row.revenue - row.previousRevenue) / row.previousRevenue) * 100 : null,
      }))
      .sort((a, b) => {
        if (b.revenue !== a.revenue) return b.revenue - a.revenue;
        if (b.qty !== a.qty) return b.qty - a.qty;
        return Math.abs(b.delta) - Math.abs(a.delta);
      });
  }, [lines, previousLines]);

  const openSources = (params: Readonly<Record<string, string>>) => {
    const sp = new URLSearchParams({ period, ...params });
    navigate(`/finance-control/revenue/sources?${sp.toString()}`);
  };

  const handleCardKeyDown = (event: KeyboardEvent<HTMLDivElement>, params: Readonly<Record<string, string>>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openSources(params);
  };

  return (
    <div className="relative space-y-6 rounded-lg border border-amber-200/10 bg-stone-950/40 p-4 ring-1 ring-stone-200/5 md:p-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-3">
          <h1 className="font-display text-3xl font-semibold tracking-tight text-amber-50 md:text-4xl">
            {isVi ? "Quản lý doanh thu" : "Revenue Management"}
          </h1>
          <p className="max-w-3xl text-sm leading-6 text-stone-300/80 md:text-base">
            {isVi
              ? "Dashboard production theo tháng, ngày, kênh và customer. Số chính lấy từ revenue ledger đã kiểm soát; PO/email parse là nguồn vận hành để kiểm tra và sửa khi sai."
              : "Production dashboard by month, day, channel, and customer. The main numbers come from the controlled revenue ledger; parsed PO/email rows remain operational evidence for review and edits."}
          </p>
        </div>
        <div aria-label="Xem doanh thu theo tháng" className="flex flex-wrap items-center gap-2 rounded-md border border-amber-200/10 bg-gradient-to-br from-stone-900/80 to-stone-950/60 p-2 ring-1 ring-stone-200/5">
          <Input type="month" value={period} onChange={(e) => setPeriod(e.target.value || monthNow())} className="w-[160px] border-stone-600/70 bg-stone-950/50 text-stone-100 hover:border-amber-300/40 focus-visible:ring-amber-300/30" />
          <Button className="border border-stone-600/60 bg-transparent text-stone-200 hover:border-amber-300/40 hover:bg-amber-400/[0.07] hover:text-amber-100" variant="outline" onClick={() => navigate("/finance-control/revenue/setup")}>
            <Settings className="mr-2 h-4 w-4" />Thiết lập Parse
          </Button>
        </div>
      </div>

      {error ? (
        <Card className="border border-rose-300/40 bg-stone-950/80 ring-1 ring-rose-200/10">
          <CardContent className="flex items-center gap-3 bg-rose-400/[0.08] p-4 text-sm text-rose-200">
            <AlertTriangle className="h-5 w-5" />Không đọc được revenue ledger. Kiểm tra migration/database quyền truy cập.
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {metricCards.map((card) => {
          const Icon = card.icon;
          const value = card.key === "approved"
            ? vnd(stats.approved)
            : card.key === "qty"
              ? numberFmt(stats.qty)
              : String(stats.customers);
          const helper = card.key === "approved" ? `${stats.rows} ${card.helper}` : card.helper;

          return (
            <Card
              key={card.key}
              role="button"
              tabIndex={0}
              aria-label={`${card.label}: ${card.detailLabel}`}
              onClick={() => openSources(card.params)}
              onKeyDown={(event) => handleCardKeyDown(event, card.params)}
              className={`cursor-pointer overflow-hidden rounded-xl border border-amber-100/10 bg-gradient-to-br ${card.cardTone} ring-1 ring-stone-200/5 transition duration-150 hover:border-amber-200/35 hover:shadow-[0_0_24px_rgba(245,158,11,0.16)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300/45 active:scale-[0.99]`}
            >
              <CardContent className="p-4 pr-5">
                <div className="flex min-w-0 items-start justify-between gap-4">
                  <div className="min-w-0 flex-1 space-y-2 pr-1">
                    <div className="text-[11px] uppercase tracking-[0.18em] text-stone-300/80">{card.label}</div>
                    <div
                      className={`mt-2 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[clamp(1rem,3.8vw,1.35rem)] font-semibold leading-tight tabular-nums tracking-[-0.02em] sm:text-[clamp(1rem,2.4vw,1.35rem)] md:text-[clamp(0.95rem,1.7vw,1.25rem)] xl:text-[clamp(0.82rem,0.98vw,1.05rem)] 2xl:text-[clamp(0.98rem,0.9vw,1.18rem)] ${card.valueTone}`}
                      title={value}
                    >
                      {isLoading ? <span className="inline-block h-6 w-24 animate-pulse rounded bg-stone-700/70 align-middle" /> : value}
                    </div>
                    <div className="mt-1 truncate text-xs text-stone-300/70" title={helper}>{helper}</div>
                    <div className="text-[11px] font-medium text-amber-200/80">{card.detailLabel}</div>
                  </div>
                  <div className={`flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg border ${card.iconShell}`}>
                    <Icon className="h-5 w-5" />
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <Card className="border border-amber-100/10 bg-stone-950/45 ring-1 ring-stone-200/5">
        <CardContent className="flex flex-wrap items-center gap-2 p-3 text-xs text-stone-300">
          <span className="font-medium text-stone-200">Trạng thái số xuất:</span>
          <Badge variant="outline" className="border-amber-200/20 text-amber-100">Doanh thu tạm từ PO: {stats.dispatchTemporary}</Badge>
          <Badge variant="outline" className="border-emerald-300/25 text-emerald-100">Đã xác nhận xuất thực tế: {stats.dispatchConfirmed}</Badge>
          <Badge variant="outline" className="border-rose-300/25 text-rose-100">Cần phân bổ SKU thiếu: {stats.dispatchNeedsAllocation}</Badge>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
        <Card className="overflow-hidden border border-amber-100/10 bg-gradient-to-br from-stone-900/95 via-stone-950 to-amber-950/15 ring-1 ring-stone-200/5">
          <CardHeader className="border-b border-amber-100/10 bg-stone-900/30">
            <CardTitle className="text-amber-50">Dự báo vận hành doanh thu tháng hiện tại</CardTitle>
            <CardDescription className="text-stone-300/75">
              Dự báo vận hành từ Doanh thu đã kiểm soát hiện tại, đối chiếu baseline {forecastBasePeriod} và {prevPeriod}; không phải trusted/final hay số audit cuối tháng.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 p-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="min-w-0 rounded-lg border border-emerald-200/15 bg-emerald-400/[0.06] p-3">
                <div className="text-xs uppercase tracking-[0.14em] text-stone-400">Doanh thu đã kiểm soát</div>
                <div className="mt-2 whitespace-nowrap text-[clamp(1rem,1.35vw,1.35rem)] font-semibold leading-tight tabular-nums text-emerald-100" title={vnd(forecast.actualControlled)}>{compactVnd(forecast.actualControlled)}</div>
                <div className="text-xs text-stone-400">Tới ngày {forecast.cutoffDay}/{forecast.periodDays}</div>
              </div>
              <div className="min-w-0 rounded-lg border border-amber-100/10 bg-stone-950/45 p-3">
                <div className="text-xs uppercase tracking-[0.14em] text-stone-400">Dự báo vận hành</div>
                <div className="mt-2 whitespace-nowrap text-[clamp(1rem,1.35vw,1.35rem)] font-semibold leading-tight tabular-nums text-amber-100" title={vnd(forecast.total)}>{compactVnd(forecast.total)}</div>
                <div className="text-xs text-stone-400">Range {compactVnd(forecast.low)}–{compactVnd(forecast.high)}</div>
              </div>
              <div className="min-w-0 rounded-lg border border-amber-100/10 bg-stone-950/45 p-3">
                <div className="text-xs uppercase tracking-[0.14em] text-stone-400">MoM vs {prevPeriod}</div>
                <div className={`mt-2 whitespace-nowrap text-[clamp(1rem,1.35vw,1.35rem)] font-semibold leading-tight tabular-nums ${mom.delta >= 0 ? "text-emerald-100" : "text-rose-100"}`} title={vnd(mom.delta)}>
                  {compactVnd(mom.delta)}
                </div>
                <div className="text-xs text-stone-400">{mom.pct === null ? "N/A" : `${mom.pct >= 0 ? "+" : ""}${numberFmt(mom.pct)}%`} · baseline avg {compactVnd(forecast.baselineAverage)}</div>
              </div>
            </div>

            <div className="rounded-lg border border-amber-100/10 bg-stone-950/45 p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <div className="text-xs uppercase tracking-[0.14em] text-stone-400">Giải thích dự báo V2</div>
                  <div className="text-xs text-stone-400">Công thức: blend historical baseline có bounded channel/source adjustment + run-rate gần đây + lịch ngày còn lại; không phải số audit cuối tháng.</div>
                </div>
                <Badge className={`w-fit border ${forecast.confidenceTone}`} variant="outline">Độ tin cậy: {forecast.confidenceLabel}</Badge>
              </div>
              <ul className="mt-3 grid gap-2 text-xs leading-5 text-stone-300/85 lg:grid-cols-2">
                {forecast.drivers.map((driver) => (
                  <li key={driver} className="flex gap-2">
                    <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-300/80" />
                    <span>{driver}</span>
                  </li>
                ))}
              </ul>
            </div>
          </CardContent>
        </Card>

        <Card className="overflow-hidden border border-amber-100/10 bg-gradient-to-br from-stone-900/95 via-stone-950 to-amber-950/15 ring-1 ring-stone-200/5">
          <CardHeader className="border-b border-amber-100/10 bg-stone-900/30 pb-3">
            <CardTitle className="text-amber-50">Dự báo lồng doanh thu parse hiện tại</CardTitle>
            <CardDescription className="text-stone-300/75">
              Cột {period} là dự báo vận hành tổng; phần xanh nằm trong cột là Doanh thu đã kiểm soát hiện tại, phần vàng là doanh thu còn dự báo.
            </CardDescription>
          </CardHeader>
          <CardContent className="h-[260px] p-4">
            <ChartContainer
              config={{
                baselineRevenue: { label: "Baseline T3/T4", color: MOM_PREVIOUS_COLOR },
                controlledRevenue: { label: "Doanh thu đã kiểm soát", color: MOM_CURRENT_COLOR },
                forecastRemaining: { label: "Dự báo vận hành còn lại", color: FORECAST_REMAINDER_COLOR },
              }}
              className="h-full"
            >
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={forecast.chart} margin={{ top: 8, right: 18, bottom: 18, left: 8 }}>
                  <CartesianGrid stroke="rgba(245,158,11,0.14)" vertical={false} />
                  <XAxis dataKey="month" tickLine={false} axisLine={false} fontSize={12} tick={{ fill: "rgba(245,245,244,0.74)" }} />
                  <YAxis tickFormatter={(v) => `${Math.round(Number(v) / 1_000_000)}tr`} tickLine={false} axisLine={false} width={48} tick={{ fill: "rgba(245,245,244,0.74)" }} />
                  <Tooltip
                    cursor={{ fill: "rgba(251,191,36,0.08)" }}
                    contentStyle={{ background: "#1c1917", border: "1px solid rgba(251,191,36,0.28)", borderRadius: "6px", color: "#fef3c7" }}
                    formatter={(value, name) => [vnd(Number(value)), name === "baselineRevenue" ? "Baseline lịch sử" : name === "controlledRevenue" ? "Doanh thu đã kiểm soát" : "Dự báo vận hành còn lại"]}
                    labelStyle={{ color: "#fef3c7", fontWeight: 600 }}
                  />
                  <Legend wrapperStyle={{ color: "rgba(245,245,244,0.74)", fontSize: 12 }} />
                  <Bar dataKey="baselineRevenue" fill="var(--color-baselineRevenue)" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="controlledRevenue" stackId="forecast" fill="var(--color-controlledRevenue)" radius={[0, 0, 0, 0]} />
                  <Bar dataKey="forecastRemaining" stackId="forecast" fill="var(--color-forecastRemaining)" fillOpacity={0.82} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </ChartContainer>
          </CardContent>
        </Card>
      </div>

      {isLoading ? (
        <div className="flex min-h-[240px] items-center justify-center rounded-md border border-amber-200/10 bg-gradient-to-br from-stone-900/75 to-stone-950/60 ring-1 ring-stone-200/5"><Loader2 className="h-8 w-8 animate-spin text-amber-300" /></div>
      ) : (
        <Tabs defaultValue="overview" className="space-y-4">
          <TabsList className="inline-flex gap-6 border-b border-stone-700/50 bg-transparent p-0">
            <TabsTrigger value="overview" className="rounded-none border-b-2 border-transparent bg-transparent px-1 pb-2 text-sm text-stone-300 data-[state=active]:border-amber-300 data-[state=active]:bg-transparent data-[state=active]:text-amber-100">Tổng quan</TabsTrigger>
            <TabsTrigger value="customers" className="rounded-none border-b-2 border-transparent bg-transparent px-1 pb-2 text-sm text-stone-300 data-[state=active]:border-amber-300 data-[state=active]:bg-transparent data-[state=active]:text-amber-100">Theo customer</TabsTrigger>
            <TabsTrigger value="channels" className="rounded-none border-b-2 border-transparent bg-transparent px-1 pb-2 text-sm text-stone-300 data-[state=active]:border-amber-300 data-[state=active]:bg-transparent data-[state=active]:text-amber-100">Theo kênh</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="grid gap-4">
            <Card className="overflow-hidden border border-amber-100/10 bg-gradient-to-br from-stone-900/90 via-stone-950/75 to-amber-950/20 ring-1 ring-stone-200/5">
              <CardHeader className="border-b border-amber-100/10 bg-stone-900/30">
                <CardTitle className="text-amber-50">Doanh thu theo ngày</CardTitle>
                <CardDescription className="text-stone-300/75">Click bảng customer/kênh để mở chi tiết source/audit.</CardDescription>
              </CardHeader>
              <CardContent className="h-[360px] pt-6">
                {byDay.length === 0 ? (
                  <div className="flex h-full items-center justify-center rounded-md border border-amber-100/10 bg-stone-950/40 text-sm text-stone-300/75">
                    Chưa có dữ liệu doanh thu cho kỳ này.
                  </div>
                ) : (
                  <div className="h-full overflow-x-auto pb-2 [-webkit-overflow-scrolling:touch]">
                    <div className="h-full min-w-[720px]">
                      <ChartContainer config={{ revenue: { label: "Doanh thu", color: "#F2C15C" } }} className="h-full">
                        <ResponsiveContainer width="100%" height="100%">
                          <BarChart data={byDay} margin={{ top: 8, right: 18, bottom: 18, left: 8 }}>
                            <CartesianGrid stroke="rgba(245,158,11,0.14)" vertical={false} />
                            <XAxis dataKey="date" tickLine={false} axisLine={false} fontSize={12} tick={{ fill: "rgba(245,245,244,0.74)" }} />
                            <YAxis tickFormatter={(v) => `${Math.round(Number(v) / 1_000_000)}tr`} tickLine={false} axisLine={false} width={48} tick={{ fill: "rgba(245,245,244,0.74)" }} />
                            <ChartTooltip content={<ChartTooltipContent formatter={(value) => vnd(Number(value))} className="border-amber-300/30 bg-stone-900 text-amber-50 shadow-xl" />} />
                            <Legend
                              wrapperStyle={{ color: "rgba(245,245,244,0.74)", fontSize: 12 }}
                              formatter={() => "Doanh thu"}
                            />
                            <Bar dataKey="revenue" fill="var(--color-revenue)" radius={[2, 2, 0, 0]} />
                          </BarChart>
                        </ResponsiveContainer>
                      </ChartContainer>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="customers">
            <Card className="overflow-hidden border border-amber-100/10 bg-gradient-to-br from-stone-900/90 via-stone-950/75 to-amber-950/15 ring-1 ring-stone-200/5">
              <CardHeader className="border-b border-amber-100/10 bg-stone-900/30">
                <CardTitle className="text-amber-50">Doanh thu theo customer / NPP</CardTitle>
                <CardDescription className="text-stone-300/75">Click “Chi tiết” để xem source lines, PO trace và trạng thái audit. Sắp xếp theo doanh thu hiện tại từ cao xuống thấp; khách chỉ có kỳ trước sẽ nằm cuối bảng.</CardDescription>
              </CardHeader>
              <CardContent className="overflow-x-auto pt-4">
                <Table>
                  <TableHeader><TableRow className="border-b border-stone-700/50"><TableHead className="text-[11px] uppercase tracking-[0.16em] text-stone-400">Customer / NPP</TableHead><TableHead className="text-right text-[11px] uppercase tracking-[0.16em] text-stone-400">Qty</TableHead><TableHead className="text-right text-[11px] uppercase tracking-[0.16em] text-stone-400">Revenue</TableHead><TableHead className="text-right text-[11px] uppercase tracking-[0.16em] text-stone-400">MoM</TableHead><TableHead className="text-right text-[11px] uppercase tracking-[0.16em] text-stone-400">Cần kiểm tra</TableHead><TableHead className="text-[11px] uppercase tracking-[0.16em] text-stone-400">Source</TableHead><TableHead className="text-right text-[11px] uppercase tracking-[0.16em] text-stone-400">Action</TableHead></TableRow></TableHeader>
                  <TableBody>
                    {byCustomer.map((row) => (
                      <TableRow key={row.key} className="border-b border-stone-800/60 hover:bg-amber-400/[0.08]">
                        <TableCell className="font-medium text-stone-100">{row.name}<div className="text-xs text-stone-400/70">{row.rows} lines</div></TableCell>
                        <TableCell className="text-right tabular-nums text-stone-100">{numberFmt(row.qty)}</TableCell>
                        <TableCell className="text-right font-semibold tabular-nums text-amber-100">{vnd(row.revenue)}</TableCell>
                        <TableCell className={`text-right tabular-nums ${row.delta >= 0 ? "text-emerald-100" : "text-rose-100"}`}>
                          <div className="font-medium">{vnd(row.delta)}</div>
                          <div className="text-xs text-stone-400">{row.pct === null ? "N/A" : `${row.pct >= 0 ? "+" : ""}${numberFmt(row.pct)}%`}</div>
                        </TableCell>
                        <TableCell className="text-right">{row.review > 0 ? <Badge className="border border-rose-300/40 bg-rose-400/10 text-rose-100" variant="outline">{vnd(row.review)}</Badge> : <span className="text-stone-500">—</span>}</TableCell>
                        <TableCell>{row.sourceTypes.size > 0 ? Array.from(row.sourceTypes).map((s) => <Badge key={s} className="mr-1 border border-amber-300/25 bg-amber-400/[0.07] text-amber-100" variant="secondary">{sourceTypeLabel[s] || s}</Badge>) : <Badge className="border border-stone-500/50 bg-stone-800/70 text-stone-200" variant="secondary">Kỳ trước</Badge>}</TableCell>
                        <TableCell className="text-right"><Button className="border border-stone-600/60 bg-transparent text-stone-200 hover:border-amber-300/40 hover:bg-amber-400/[0.07] hover:text-amber-100" size="sm" variant="outline" onClick={() => openSources({ customer_key: row.key })}>Chi tiết</Button></TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="channels">
            <Card className="overflow-hidden border border-amber-100/10 bg-gradient-to-br from-stone-900/90 via-stone-950/75 to-amber-950/15 ring-1 ring-stone-200/5">
              <CardHeader className="border-b border-amber-100/10 bg-stone-900/30"><CardTitle className="text-amber-50">Doanh thu theo kênh</CardTitle><CardDescription className="text-stone-300/75">Circle chart theo tỷ trọng revenue của từng kênh trong ledger đã kiểm soát.</CardDescription></CardHeader>
              <CardContent className="pt-4">
                {byChannel.length === 0 ? (
                  <div className="flex min-h-[260px] items-center justify-center rounded-md border border-amber-100/10 bg-stone-950/40 text-sm text-stone-300/75">
                    Chưa có dữ liệu kênh cho kỳ này.
                  </div>
                ) : (
                  <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
                    <div className="shrink-0 lg:w-72">
                      <ResponsiveContainer width="100%" height={260}>
                        <PieChart>
                          <Pie
                            data={byChannel}
                            dataKey="revenue"
                            nameKey="label"
                            cx="50%"
                            cy="50%"
                            innerRadius={68}
                            outerRadius={108}
                            paddingAngle={2}
                            strokeWidth={0}
                          >
                            {byChannel.map((row, index) => (
                              <Cell key={row.key} fill={getChannelColor(row.key, index)} />
                            ))}
                          </Pie>
                          <Tooltip
                            contentStyle={{
                              background: "#1c1917",
                              border: "1px solid rgba(251,191,36,0.28)",
                              borderRadius: "6px",
                              boxShadow: "0 12px 30px rgba(0,0,0,0.35)",
                              color: "#fef3c7",
                              fontSize: "12px",
                            }}
                            formatter={(value) => [vnd(Number(value)), "Revenue"]}
                            itemStyle={{ color: "#fef3c7", fontWeight: 600 }}
                            labelStyle={{ color: "#fef3c7", fontWeight: 600 }}
                          />
                        </PieChart>
                      </ResponsiveContainer>
                    </div>

                    <div className="min-w-0 flex-1 divide-y divide-stone-800/60">
                      {byChannel.map((row, index) => {
                        const pct = stats.total > 0 ? ((row.revenue / stats.total) * 100).toFixed(1) : "0.0";
                        const color = getChannelColor(row.key, index);

                        return (
                          <div key={row.key} className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center">
                            <div className="flex min-w-0 flex-1 items-center gap-3">
                              <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-sm font-medium text-stone-100">{row.label}</div>
                                <div className="truncate text-xs text-stone-400/70">{row.key}</div>
                                <div className="text-xs text-stone-400/70">{row.rows} rows · {numberFmt(row.qty)} qty</div>
                              </div>
                            </div>
                            <div className="flex shrink-0 items-center justify-between gap-3 sm:justify-end">
                              <div className="text-right">
                                <div className="text-sm font-semibold tabular-nums text-amber-100">{vnd(row.revenue)}</div>
                                <div className="text-xs text-stone-400">{pct}%</div>
                              </div>
                              <Button className="border border-stone-600/60 bg-transparent text-stone-200 hover:border-amber-300/40 hover:bg-amber-400/[0.07] hover:text-amber-100" size="sm" variant="outline" onClick={() => openSources({ channel: row.key })}>Chi tiết</Button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
