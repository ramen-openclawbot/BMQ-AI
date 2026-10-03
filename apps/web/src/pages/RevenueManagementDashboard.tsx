import { type KeyboardEvent, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  CalendarDays,
  CheckCircle2,
  Loader2,
  Settings,
  Users,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { supabase } from "@/integrations/supabase/client";
import { fetchAllRevenueLines, type RevenueLine } from "@/lib/revenue-ledger";
import { channelGroup } from "@/lib/overview/overview-summary";
import { CHANNEL_META, CHANNEL_ORDER } from "@/components/overview/RevenueChannelChart";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChartContainer } from "@/components/ui/chart";
import { useLanguage } from "@/contexts/LanguageContext";
import { cn } from "@/lib/utils";
import "@/styles/bmq-revenue.css";

const vnd = (v: number) =>
  new Intl.NumberFormat("vi-VN", {
    style: "currency",
    currency: "VND",
    maximumFractionDigits: 0,
  }).format(v || 0);

const numberFmt = (v: number) =>
  new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 }).format(v || 0);

const compactVnd = (v: number) => {
  const abs = Math.abs(v || 0);
  const sign = v < 0 ? "-" : "";
  if (abs >= 1_000_000_000)
    return `${sign}${numberFmt(abs / 1_000_000_000)} tỷ ₫`;
  if (abs >= 1_000_000) return `${sign}${numberFmt(abs / 1_000_000)} tr ₫`;
  return vnd(v);
};

const formatDate = (value: string | null | undefined) => {
  if (!value) return "—";
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
};

const periodLabel = (value: string) => {
  const [year, month] = value.split("-");
  return `Tháng ${month}/${year}`;
};

// Demo 3 palette: previous month in soft grey, current month in ink, forecast remainder in pale blue.
const MOM_PREVIOUS_COLOR = "#D3D3D0";
const MOM_CURRENT_COLOR = "#272727";
const FORECAST_REMAINDER_COLOR = "#9CC6EF";
const TREND_GRID_COLOR = "rgba(62,119,129,0.16)";

const vietnamToday = () => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: string) =>
    parts.find((part) => part.type === type)?.value || "01";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
  };
};

const monthNow = () => {
  const d = vietnamToday();
  return `${d.year}-${String(d.month).padStart(2, "0")}`;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

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

const recentPeriods = (period: string, count: number) => {
  const periods: string[] = [];
  let cursor = period;
  for (let index = 0; index < count; index += 1) {
    periods.unshift(cursor);
    cursor = previousMonth(cursor);
  }
  return periods;
};

const shortPeriodLabel = (value: string) => {
  const [year, month] = value.split("-");
  return `T${Number(month)}/${year.slice(2)}`;
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
  const status = String(
    raw.revenue_amount_status || raw.dispatch_confirmation_status || "",
  );
  if (
    status === "confirmed_dispatch_amount" ||
    status === "month_end_audit_adjusted" ||
    status === "confirmed" ||
    status === "revised"
  )
    return "confirmed";
  if (status === "needs_sku_allocation") return "needsAllocation";
  return "temporary";
};

const lineWeekday = (date: string) => {
  const d = new Date(`${date}T00:00:00+07:00`);
  return Number.isFinite(d.getTime()) ? d.getDay() : 0;
};

const extractRawText = (rawPayload: unknown, keys: string[]) => {
  const raw = asRecord(rawPayload);
  const records = [
    raw,
    asRecord(raw.product),
    asRecord(raw.sku),
    asRecord(raw.item),
    asRecord(raw.line_item),
  ];

  for (const record of records) {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value.trim();
      if (typeof value === "number" && Number.isFinite(value))
        return String(value);
    }
  }

  return "";
};

const productSkuKey = (row: RevenueLine) => {
  const keys = [
    "product",
    "product_name",
    "product_code",
    "product_group",
    "sku",
    "sku_id",
    "sku_code",
    "sku_name",
  ];
  const rawValue = extractRawText(row.raw_payload, keys);
  if (rawValue) return rawValue.toLocaleUpperCase("vi-VN");

  const rowRecord = row as unknown as Record<string, unknown>;
  for (const key of keys) {
    const value = rowRecord[key];
    if (typeof value === "string" && value.trim())
      return value.trim().toLocaleUpperCase("vi-VN");
    if (typeof value === "number" && Number.isFinite(value))
      return String(value);
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

const clamp = (value: number, min: number, max: number) =>
  Math.min(Math.max(value, min), max);

const dateForPeriodDay = (period: string, day: number) =>
  `${period}-${String(day).padStart(2, "0")}`;

const sumRevenue = (rows: RevenueLine[]) =>
  rows.reduce((sum, r) => sum + lineRevenue(r), 0);

const maxRevenueDay = (rows: RevenueLine[], fallbackPeriod: string) => {
  const latest = rows.reduce(
    (max, r) => Math.max(max, dayOfMonth(r.revenue_date)),
    0,
  );
  if (latest > 0) return latest;
  return fallbackPeriod === monthNow()
    ? vietnamToday().day
    : daysInPeriod(fallbackPeriod);
};

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
    valueTone: "text-primary",
    iconShell: "border-primary/20 bg-primary/10 text-primary",
    cardTone: "from-card/90 via-card/75 to-accent/20",
  },
  {
    key: "qty",
    label: "Sản lượng",
    helper: "Quantity from ledger",
    detailLabel: "Chạm để xem chi tiết",
    params: { scope: "controlled_ledger", focus: "quantity" },
    icon: CalendarDays,
    valueTone: "text-secondary-foreground",
    iconShell: "border-secondary/70 bg-secondary/45 text-secondary-foreground",
    cardTone: "from-card/90 via-card/75 to-secondary/25",
  },
  {
    key: "customers",
    label: "Customer/NPP",
    helper: "Roll-up groups",
    detailLabel: "Chạm để xem chi tiết",
    params: { scope: "controlled_ledger", focus: "customers" },
    icon: Users,
    valueTone: "text-foreground",
    iconShell: "border-border/70 bg-muted/70 text-muted-foreground",
    cardTone: "from-card/90 via-card/75 to-muted/40",
  },
] as const;

// Same channel colours as the Tổng quan page, grouped by the shared channel mapping.
const getChannelColor = (key: string, _fallbackIndex: number) => {
  return CHANNEL_META[channelGroup(key)].color;
};

export default function RevenueManagementDashboard() {
  const { language } = useLanguage();
  const isVi = language === "vi";
  const navigate = useNavigate();
  const initialPeriod =
    new URLSearchParams(window.location.search).get("period") || monthNow();
  const [period, setPeriod] = useState(initialPeriod);
  const [showAllCustomers, setShowAllCustomers] = useState(false);
  const prevPeriod = previousMonth(period);
  const forecastBasePeriod = previousMonth(prevPeriod);
  const monthlyPeriods = useMemo(() => recentPeriods(period, 6), [period]);
  const isSelectedCurrentMonth = period === monthNow();

  const {
    data: lines = [],
    isLoading,
    error,
  } = useQuery<RevenueLine[]>({
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

  const { data: monthlyLinesByPeriod = {} } = useQuery<
    Record<string, RevenueLine[]>
  >({
    queryKey: ["revenue-ledger-lines-monthly", monthlyPeriods],
    queryFn: async () => {
      const entries = await Promise.all(
        monthlyPeriods.map(async (monthPeriod) => [
          monthPeriod,
          await fetchAllRevenueLines(monthPeriod, true),
        ] as const),
      );
      return Object.fromEntries(entries);
    },
    refetchOnWindowFocus: true,
    refetchInterval: isSelectedCurrentMonth ? 5 * 60 * 1000 : false,
  });

  const stats = useMemo(() => {
    const total = lines.reduce(
      (sum, r) => sum + Number(r.gross_revenue || 0),
      0,
    );
    const qty = lines.reduce((sum, r) => sum + Number(r.quantity || 0), 0);
    const approved = lines
      .filter((r) => r.approval_status === "approved")
      .reduce((sum, r) => sum + Number(r.gross_revenue || 0), 0);
    const customers = new Set(
      lines.map(
        (r) => r.parent_customer_id || r.customer_id || r.customer_name,
      ),
    ).size;
    const dispatchTemporary = lines.filter(
      (r) => dispatchAmountBucket(r) === "temporary",
    ).length;
    const dispatchConfirmed = lines.filter(
      (r) => dispatchAmountBucket(r) === "confirmed",
    ).length;
    const dispatchNeedsAllocation = lines.filter(
      (r) => dispatchAmountBucket(r) === "needsAllocation",
    ).length;
    return {
      total,
      qty,
      approved,
      customers,
      rows: lines.length,
      dispatchTemporary,
      dispatchConfirmed,
      dispatchNeedsAllocation,
    };
  }, [lines]);

  const byChannel = useMemo(() => {
    const map = new Map<
      string,
      { key: string; label: string; revenue: number; qty: number; rows: number }
    >();
    for (const row of lines) {
      const key = row.channel || "unknown";
      const cur = map.get(key) || {
        key,
        label: channelLabel[key] || key,
        revenue: 0,
        qty: 0,
        rows: 0,
      };
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

  const monthlyRevenueChart = useMemo(() => {
    let previousRevenue = 0;
    return monthlyPeriods.map((monthPeriod) => {
      const revenue = sumRevenue(monthlyLinesByPeriod[monthPeriod] || []);
      const delta = revenue - previousRevenue;
      const pct = previousRevenue > 0 ? (delta / previousRevenue) * 100 : null;
      const isCurrentPeriod = monthPeriod === period;
      const row = {
        period: monthPeriod,
        label: shortPeriodLabel(monthPeriod),
        revenue,
        previousRevenue,
        delta,
        pct,
        fill: isCurrentPeriod ? MOM_CURRENT_COLOR : MOM_PREVIOUS_COLOR,
      };
      previousRevenue = revenue;
      return row;
    });
  }, [monthlyLinesByPeriod, monthlyPeriods, period]);

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
      const customerKey =
        row.parent_customer_id ||
        row.customer_id ||
        row.customer_name ||
        "unknown";
      const day = lineDateDay(row);

      currentProductTotals.set(
        productKey,
        (currentProductTotals.get(productKey) || 0) + revenue,
      );
      currentChannelTotals.set(
        channelKey,
        (currentChannelTotals.get(channelKey) || 0) + revenue,
      );
      currentCustomerTotals.set(
        customerKey,
        (currentCustomerTotals.get(customerKey) || 0) + revenue,
      );
      if (day > 0)
        currentDailyTotals.set(
          day,
          (currentDailyTotals.get(day) || 0) + revenue,
        );
    }

    const productKnownRevenue = Array.from(currentProductTotals.entries())
      .filter(([key]) => key !== "unknown" && !key.startsWith("SOURCE:"))
      .reduce((sum, [, revenue]) => sum + revenue, 0);
    const productMixCoverage =
      actualControlled > 0 ? productKnownRevenue / actualControlled : 0;
    const topChannel = Array.from(currentChannelTotals.entries()).sort(
      (a, b) => b[1] - a[1],
    )[0] || ["unknown", 0];
    const topCustomer = Array.from(currentCustomerTotals.entries()).sort(
      (a, b) => b[1] - a[1],
    )[0] || ["unknown", 0];
    const topChannelShare =
      actualControlled > 0 ? topChannel[1] / actualControlled : 0;
    const topCustomerShare =
      actualControlled > 0 ? topCustomer[1] / actualControlled : 0;
    const mtdDailyAverage = cutoffDay > 0 ? actualControlled / cutoffDay : 0;
    const recentDays = Array.from(currentDailyTotals.entries())
      .filter(([, revenue]) => revenue > 0)
      .sort((a, b) => b[0] - a[0])
      .slice(0, 7);
    const recentDailyAverage =
      recentDays.length > 0
        ? recentDays.reduce((sum, [, revenue]) => sum + revenue, 0) /
          recentDays.length
        : mtdDailyAverage;

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
        productTotals.set(
          productSkuKey(row),
          (productTotals.get(productSkuKey(row)) || 0) + revenue,
        );
        channelTotals.set(
          row.channel || "unknown",
          (channelTotals.get(row.channel || "unknown") || 0) + revenue,
        );
        weekdayTotals.set(
          lineWeekday(row.revenue_date),
          (weekdayTotals.get(lineWeekday(row.revenue_date)) || 0) + revenue,
        );
        timingTotals.set(
          timingBucket(lineDateDay(row), baselineDays),
          (timingTotals.get(timingBucket(lineDateDay(row), baselineDays)) ||
            0) + revenue,
        );
      }

      const baselineDailyAnchor = dailyAverage;
      const channelLiftFromComparableShares =
        actualControlled > 0 && total > 0
          ? Array.from(currentChannelTotals.entries()).reduce(
              (sum, [key, revenue]) => {
                const currentShare = revenue / actualControlled;
                const baselineShare = (channelTotals.get(key) || 0) / total;
                const shareLift =
                  key !== "unknown" && baselineShare > 0
                    ? currentShare / baselineShare
                    : 1;
                return sum + currentShare * shareLift;
              },
              0,
            )
          : 1;
      const channelMixFactor =
        actualControlled > 0 && total > 0
          ? clamp(channelLiftFromComparableShares || 1, 0.9, 1.1)
          : 1;
      const productLiftFromKnownProducts =
        actualControlled > 0 && total > 0 && productMixCoverage >= 0.25
          ? Array.from(currentProductTotals.entries()).reduce(
              (sum, [key, revenue]) => {
                const currentShare = revenue / actualControlled;
                const baselineShare = (productTotals.get(key) || 0) / total;
                const hasKnownProduct =
                  key !== "unknown" && !key.startsWith("SOURCE:");
                const shareLift =
                  hasKnownProduct && baselineShare > 0
                    ? currentShare / baselineShare
                    : 1;
                return sum + currentShare * shareLift;
              },
              0,
            )
          : 1;
      const productMixFactor =
        productMixCoverage >= 0.25
          ? clamp(productLiftFromKnownProducts || 1, 0.9, 1.1)
          : 1;
      const baselineComparableFloor = dailyAverage * 0.9;
      const comparableDaily = clamp(
        baselineDailyAnchor * channelMixFactor * productMixFactor,
        baselineComparableFloor,
        dailyAverage * 1.15,
      );
      const elapsedTimingShare =
        total > 0
          ? Array.from(timingTotals.entries())
              .filter(
                ([bucket]) =>
                  bucket === "early" ||
                  (cutoffDay > periodDays / 3 && bucket === "mid") ||
                  (cutoffDay > (periodDays * 2) / 3 && bucket === "late"),
              )
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

    const baselineAverage =
      baselines.length > 0
        ? baselines.reduce((sum, baseline) => sum + baseline.total, 0) /
          baselines.length
        : 0;
    const baselineDailyAverage =
      baselines.length > 0
        ? baselines.reduce(
            (sum, baseline) => sum + baseline.comparableDaily,
            0,
          ) / baselines.length
        : mtdDailyAverage;
    const weekdayRevenue = new Map<number, number>();
    for (const baseline of baselines) {
      for (const [weekday, revenue] of baseline.weekdayTotals)
        weekdayRevenue.set(
          weekday,
          (weekdayRevenue.get(weekday) || 0) + revenue,
        );
    }
    const weekdayCounts = new Map<number, number>();
    for (const baseline of baselines) {
      for (let day = 1; day <= baseline.baselineDays; day += 1) {
        const weekday = lineWeekday(dateForPeriodDay(baseline.period, day));
        weekdayCounts.set(weekday, (weekdayCounts.get(weekday) || 0) + 1);
      }
    }
    const totalBaselineDays = Array.from(weekdayCounts.values()).reduce(
      (sum, count) => sum + count,
      0,
    );
    const overallWeekdayAverage =
      totalBaselineDays > 0 && baselines.length > 0
        ? baselines.reduce((sum, baseline) => sum + baseline.total, 0) /
          totalBaselineDays
        : baselineDailyAverage;
    const weekdayFactors = new Map<number, number>();
    for (let weekday = 0; weekday < 7; weekday += 1) {
      const weekdayAverage =
        (weekdayRevenue.get(weekday) || 0) /
        Math.max(weekdayCounts.get(weekday) || 1, 1);
      weekdayFactors.set(
        weekday,
        overallWeekdayAverage > 0
          ? clamp(weekdayAverage / overallWeekdayAverage, 0.6, 1.45)
          : 1,
      );
    }
    const remainingWeekdayFactor =
      remainingDays > 0
        ? Array.from(
            { length: remainingDays },
            (_, index) =>
              weekdayFactors.get(
                lineWeekday(dateForPeriodDay(period, cutoffDay + index + 1)),
              ) || 1,
          ).reduce((sum, factor) => sum + factor, 0) / remainingDays
        : 1;
    const baselineElapsedShare =
      baselines.length > 0
        ? baselines.reduce(
            (sum, baseline) => sum + baseline.elapsedTimingShare,
            0,
          ) / baselines.length
        : cutoffDay / Math.max(periodDays, 1);
    const currentMonthShare =
      baselineAverage > 0
        ? actualControlled / baselineAverage
        : baselineElapsedShare;
    const timingFactor =
      baselineElapsedShare > 0
        ? clamp(currentMonthShare / baselineElapsedShare, 0.85, 1.15)
        : 1;
    const trendFactor =
      mtdDailyAverage > 0
        ? clamp(recentDailyAverage / mtdDailyAverage, 0.75, 1.25)
        : 1;
    const blendedDailyRate = Math.max(
      0,
      (baselineDailyAverage * 0.55 +
        recentDailyAverage * 0.35 +
        mtdDailyAverage * 0.1) *
        remainingWeekdayFactor *
        timingFactor *
        (0.85 + trendFactor * 0.15),
    );
    const scenarioValues = baselines
      .map(
        (baseline) =>
          actualControlled +
          baseline.comparableDaily *
            remainingWeekdayFactor *
            timingFactor *
            remainingDays,
      )
      .filter((value) => value > 0);
    const unclampedTotal = actualControlled + blendedDailyRate * remainingDays;
    const lowScenario = Math.min(
      ...(scenarioValues.length ? scenarioValues : [unclampedTotal]),
    );
    const highScenario = Math.max(
      ...(scenarioValues.length ? scenarioValues : [unclampedTotal]),
    );
    const low = Math.max(
      actualControlled,
      Math.min(unclampedTotal, lowScenario * 0.92),
    );
    const high = Math.max(
      unclampedTotal,
      highScenario * 1.08,
      actualControlled,
    );
    const total = Math.max(actualControlled, clamp(unclampedTotal, low, high));
    const remainder = Math.max(total - actualControlled, 0);
    const volatility =
      baselineAverage > 0 && baselines.length > 1
        ? Math.abs(baselines[0].total - baselines[1].total) / baselineAverage
        : 0;
    const confidenceScore =
      100 -
      (baselines.length < 2 ? 24 : 0) -
      (lines.length < 20 ? 14 : 0) -
      (productMixCoverage < 0.25 ? 12 : 0) -
      (topCustomerShare > 0.35 ? 16 : 0) -
      (topChannelShare > 0.6 ? 12 : 0) -
      (volatility > 0.25 ? 12 : 0);
    const confidenceLabel =
      confidenceScore >= 72
        ? "Cao"
        : confidenceScore >= 48
          ? "Trung bình"
          : "Thấp";
    const confidenceTone =
      confidenceLabel === "Cao"
        ? "border-success/30 bg-success/10 text-success"
        : confidenceLabel === "Trung bình"
          ? "border-warning/40 bg-warning/30 text-warning-foreground"
          : "border-destructive/30 bg-destructive/10 text-destructive";
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
  }, [
    forecastBaseLines,
    forecastBasePeriod,
    lines,
    period,
    prevPeriod,
    previousLines,
    stats.total,
  ]);

  const throughDate = dateForPeriodDay(period, forecast.cutoffDay || 1);
  const forecastProgress =
    forecast.total > 0
      ? clamp((forecast.actualControlled / forecast.total) * 100, 0, 100)
      : 0;

  const trendChart = useMemo(() => {
    const daily = new Map<number, number>();
    for (const row of lines) {
      const day = lineDateDay(row);
      if (day > 0) daily.set(day, (daily.get(day) || 0) + lineRevenue(row));
    }

    let cumulative = 0;
    return Array.from({ length: forecast.periodDays }, (_, index) => {
      const day = index + 1;
      cumulative += daily.get(day) || 0;
      const isPastOrCurrent = day <= forecast.cutoffDay;
      const remainingDays = Math.max(
        forecast.periodDays - forecast.cutoffDay,
        1,
      );
      const projected = isPastOrCurrent
        ? cumulative
        : forecast.actualControlled +
          ((forecast.total - forecast.actualControlled) *
            (day - forecast.cutoffDay)) /
            remainingDays;
      return {
        day: String(day).padStart(2, "0"),
        ledger: isPastOrCurrent ? cumulative : null,
        forecast: projected,
        current: day === forecast.cutoffDay ? cumulative : null,
      };
    });
  }, [
    forecast.actualControlled,
    forecast.cutoffDay,
    forecast.periodDays,
    forecast.total,
    lines,
  ]);

  const byCustomer = useMemo(() => {
    const historicalParentByCustomerName = new Map<string, CustomerRollup>();

    for (const row of previousLines) {
      const raw = asRecord(row.raw_payload);
      const parentName = String(raw.parent_customer_name || "").trim();
      if (row.parent_customer_id || parentName) {
        historicalParentByCustomerName.set(
          normalizedCustomerName(row.customer_name),
          {
            key: row.parent_customer_id || parentName,
            name: parentName || row.customer_name || "Chưa rõ khách hàng",
          },
        );
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

      const historicalParent = historicalParentByCustomerName.get(
        normalizedCustomerName(row.customer_name),
      );
      if (historicalParent) return historicalParent;

      return {
        key: row.customer_id || row.customer_name,
        name: row.customer_name || "Chưa rõ khách hàng",
      };
    };

    const previousMap = new Map<string, { revenue: number; name: string }>();
    for (const row of previousLines) {
      const rollup = resolveRollup(row);
      const cur = previousMap.get(rollup.key) || {
        revenue: 0,
        name: rollup.name,
      };
      cur.revenue += Number(row.gross_revenue || 0);
      previousMap.set(rollup.key, cur);
    }

    const map = new Map<
      string,
      {
        key: string;
        name: string;
        revenue: number;
        previousRevenue: number;
        qty: number;
        rows: number;
        sourceTypes: Set<string>;
        daily: number[];
      }
    >();
    const periodDays = daysInPeriod(period);
    for (const [key, prev] of previousMap) {
      map.set(key, {
        key,
        name: prev.name,
        revenue: 0,
        previousRevenue: prev.revenue,
        qty: 0,
        rows: 0,
        sourceTypes: new Set<string>(),
        daily: new Array(periodDays).fill(0),
      });
    }

    for (const row of lines) {
      const rollup = resolveRollup(row);
      const cur = map.get(rollup.key) || {
        key: rollup.key,
        name: rollup.name,
        revenue: 0,
        previousRevenue: previousMap.get(rollup.key)?.revenue || 0,
        qty: 0,
        rows: 0,
        sourceTypes: new Set<string>(),
        daily: new Array(periodDays).fill(0),
      };
      cur.name = rollup.name || cur.name;
      cur.revenue += Number(row.gross_revenue || 0);
      const day = lineDateDay(row);
      if (day > 0 && day <= periodDays) cur.daily[day - 1] += lineRevenue(row);
      cur.qty += Number(row.quantity || 0);
      cur.rows += 1;
      cur.sourceTypes.add(row.source_type);
      map.set(rollup.key, cur);
    }
    return Array.from(map.values())
      .map((row) => ({
        ...row,
        delta: row.revenue - row.previousRevenue,
        pct:
          row.previousRevenue > 0
            ? ((row.revenue - row.previousRevenue) / row.previousRevenue) * 100
            : null,
      }))
      .sort((a, b) => {
        if (b.revenue !== a.revenue) return b.revenue - a.revenue;
        if (b.qty !== a.qty) return b.qty - a.qty;
        return Math.abs(b.delta) - Math.abs(a.delta);
      });
  }, [lines, period, previousLines]);

  const openSources = (params: Readonly<Record<string, string>>) => {
    const sp = new URLSearchParams({ period, ...params });
    navigate(`/finance-control/revenue/sources?${sp.toString()}`);
  };

  const handleCardKeyDown = (
    event: KeyboardEvent<HTMLElement>,
    params: Readonly<Record<string, string>>,
  ) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openSources(params);
  };

  const figure = (value: string) => (isLoading ? "…" : error ? "—" : value);
  const millions = (value: number) =>
    numberFmt(value / 1_000_000);
  const dailyRevenue = Array.from({ length: forecast.periodDays }, (_, index) => {
    const day = index + 1;
    return lines.reduce((sum, row) => (lineDateDay(row) === day ? sum + lineRevenue(row) : sum), 0);
  });
  const dailyMax = Math.max(1, ...dailyRevenue);
  const lastDataDay = dailyRevenue.reduce((last, value, index) => (value > 0 ? index + 1 : last), 0);
  const groupTotals = CHANNEL_ORDER.map((group) => ({
    group,
    revenue: lines.reduce((sum, row) => (channelGroup(row.channel) === group ? sum + lineRevenue(row) : sum), 0),
  }))
    .filter((row) => row.revenue > 0)
    .sort((a, b) => b.revenue - a.revenue);
  const remainingDays = Math.max(forecast.periodDays - forecast.cutoffDay, 0);
  const visibleCustomers = showAllCustomers ? byCustomer : byCustomer.slice(0, 8);
  const RING_C = (r: number) => 2 * Math.PI * r;

  return (
    <div
      data-stitch-revenue-theme="pantone-2026-glass"
      data-bmq-revenue-layout="demo3-v1"
      className="d3-rv min-w-0 text-foreground"
    >
      <header className="d3-rv-head">
        <div className="min-w-0">
          <span className="d3-rv-tag">
            {isVi ? "Bán hàng" : "Sales"} · {periodLabel(period)} · {isVi ? "tính đến" : "through"} {figure(formatDate(throughDate))}
          </span>
          <h1>
            {isVi ? "Doanh thu" : "Revenue"} <b>{isVi ? "theo kênh" : "by channel"}</b>
          </h1>
        </div>
        <div aria-label="Xem doanh thu theo tháng" className="d3-rv-actions">
          <Input
            type="month"
            value={period}
            onChange={(e) => setPeriod(e.target.value || monthNow())}
            aria-label={isVi ? "Tháng" : "Month"}
            className="d3-rv-month"
          />
          <Button variant="outline" className="d3-rv-ghost" onClick={() => navigate("/finance-control/revenue/setup")}>
            <Settings className="mr-2 h-4 w-4" />
            Thiết lập Parse
          </Button>
        </div>
      </header>

      {error ? (
        <div className="d3-rv-alert" role="alert">
          <AlertTriangle className="h-5 w-5 shrink-0" />
          Không đọc được revenue ledger. Kiểm tra migration/database quyền truy cập.
        </div>
      ) : null}

      <div className="d3-rv-g3">
        {/* Hero: controlled ledger with the month's daily bars (demo "Doanh thu 30 ngày"). */}
        <section
          role="button"
          tabIndex={0}
          aria-label="Đã vào ledger: Chạm để xem chi tiết"
          onClick={() => openSources({ scope: "controlled_ledger" })}
          onKeyDown={(event) => handleCardKeyDown(event, { scope: "controlled_ledger" })}
          className="d3-rv-card d3-rv-hero is-click"
          style={{ ["--i" as string]: 1 }}
          data-bmq-revenue-hero
        >
          <span className="d3-rv-glow is-green" aria-hidden="true" />
          <div className="d3-rv-card-h">
            <h2>Đã vào ledger</h2>
            {!isLoading && !error ? (
              <span className={mom.pct === null ? "d3-rv-pill" : mom.delta >= 0 ? "d3-rv-up" : "d3-rv-dn"}>
                {mom.pct === null ? "Tháng trước: N/A" : `${mom.pct >= 0 ? "+" : ""}${numberFmt(mom.pct)}%`}
              </span>
            ) : null}
          </div>
          <div className="d3-rv-big" title={vnd(stats.approved)}>
            {figure(millions(stats.approved))}
            {!isLoading && !error ? <small>triệu</small> : null}
          </div>
          <p className="d3-rv-sub">
            {isLoading || error ? figure("") : `${vnd(stats.approved)} · ${stats.rows} dòng đã kiểm soát · Tạm từ PO`}
          </p>
          <div className="d3-rv-vbars" aria-hidden="true">
            {dailyRevenue.map((value, index) => {
              const day = index + 1;
              const isLast = day === lastDataDay;
              return (
                <i
                  key={day}
                  className={cn(isLast && "is-hi", day > forecast.cutoffDay && "is-future")}
                  style={{ ["--h" as string]: error ? 0 : Math.max(0.03, value / dailyMax), ["--dl" as string]: `${300 + index * 18}ms` }}
                >
                  {isLast && !error ? <b>{millions(value)}</b> : null}
                </i>
              );
            })}
          </div>
          <div className="d3-rv-axis">
            <span>01/{period.slice(5)}</span>
            <span>15/{period.slice(5)}</span>
            <span>{String(forecast.periodDays).padStart(2, "0")}/{period.slice(5)}</span>
          </div>
        </section>

        {/* Channel share as concentric 270° rings (demo "Tỷ trọng kênh"). */}
        <section className="d3-rv-card" style={{ ["--i" as string]: 2 }} data-bmq-revenue-rings>
          <div className="d3-rv-card-h">
            <h2>Tỷ trọng kênh</h2>
            <span className="d3-rv-pill">{figure(`${groupTotals.length} kênh`)}</span>
          </div>
          {isLoading || error || groupTotals.length === 0 ? (
            <div className="d3-rv-empty">
              {isLoading ? "Đang tải…" : error ? "—" : "Chưa có dữ liệu kênh cho kỳ này."}
            </div>
          ) : (
            <div className="d3-rv-rings-wrap">
              <svg className="d3-rv-rings" viewBox="0 0 220 220" aria-hidden="true">
                {groupTotals.map((row, k) => {
                  const r = 92 - k * 18;
                  const c = RING_C(r);
                  const share = stats.total > 0 ? row.revenue / stats.total : 0;
                  return (
                    <g key={row.group} transform="rotate(135 110 110)">
                      <circle className="d3-rv-ring-bg" cx="110" cy="110" r={r} strokeDasharray={`${c * 0.75} ${c}`} />
                      <circle
                        className="d3-rv-ring"
                        cx="110"
                        cy="110"
                        r={r}
                        stroke={CHANNEL_META[row.group].color}
                        strokeDasharray={`${Math.max(c * 0.75 * share, 0.5)} ${c}`}
                        style={{ ["--len" as string]: c, animationDelay: `${400 + k * 160}ms` }}
                      />
                    </g>
                  );
                })}
                <text x="110" y="122" textAnchor="middle" className="d3-rv-ring-n">{groupTotals.length}</text>
                <text x="110" y="140" textAnchor="middle" className="d3-rv-ring-l">kênh</text>
              </svg>
              <ul className="d3-rv-leg">
                {groupTotals.map((row) => (
                  <li key={row.group} style={{ ["--c" as string]: CHANNEL_META[row.group].color }}>
                    <span>{isVi ? CHANNEL_META[row.group].vi : CHANNEL_META[row.group].en}</span>
                    <b>{numberFmt(stats.total > 0 ? (row.revenue / stats.total) * 100 : 0)}%</b>
                    <small>{millions(row.revenue)}tr</small>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {/* Operational forecast + volume / customers tiles. */}
        <section className="d3-rv-card d3-rv-fc" style={{ ["--i" as string]: 3 }} data-bmq-revenue-forecast>
          <span className="d3-rv-glow is-blue" aria-hidden="true" />
          <div className="d3-rv-card-h">
            <h2>Dự báo vận hành</h2>
            {!isLoading && !error ? <span className={cn("d3-rv-conf", `is-${forecast.confidenceLabel === "Cao" ? "high" : forecast.confidenceLabel === "Thấp" ? "low" : "mid"}`)}>Độ tin cậy {forecast.confidenceLabel}</span> : null}
          </div>
          <div className="d3-rv-big is-md" title={vnd(forecast.total)}>
            {figure(millions(forecast.total))}
            {!isLoading && !error ? <small>triệu</small> : null}
          </div>
          <div className="d3-rv-track" aria-hidden="true">
            <i style={{ width: `${error ? 0 : forecastProgress}%` }} />
          </div>
          <p className="d3-rv-sub">
            {isLoading || error
              ? figure("")
              : `${numberFmt(forecastProgress)}% đã kiểm soát · còn ${remainingDays} ngày · khoảng ${millions(forecast.low)}–${millions(forecast.high)}tr`}
          </p>
          <div className="d3-rv-tiles">
            <div
              role="button"
              tabIndex={0}
              aria-label="Sản lượng: Chạm để xem chi tiết"
              onClick={() => openSources({ scope: "controlled_ledger", focus: "quantity" })}
              onKeyDown={(event) => handleCardKeyDown(event, { scope: "controlled_ledger", focus: "quantity" })}
              className="d3-rv-tile is-click"
            >
              <span><CalendarDays className="h-3.5 w-3.5" />Sản lượng</span>
              <strong title={numberFmt(stats.qty)}>{figure(numberFmt(stats.qty))}</strong>
            </div>
            <div
              role="button"
              tabIndex={0}
              aria-label="Customer/NPP: Chạm để xem chi tiết"
              onClick={() => openSources({ scope: "controlled_ledger", focus: "customers" })}
              onKeyDown={(event) => handleCardKeyDown(event, { scope: "controlled_ledger", focus: "customers" })}
              className="d3-rv-tile is-click"
            >
              <span><Users className="h-3.5 w-3.5" />Customer/NPP</span>
              <strong>{figure(String(stats.customers))}</strong>
            </div>
          </div>
          <p className="d3-rv-note">Dự báo vận hành, không phải trusted/final hay số audit cuối tháng.</p>
        </section>
      </div>

      <div className="d3-rv-status" data-bmq-revenue-dispatch-status>
        <span>Trạng thái số xuất:</span>
        <span className="d3-rv-chip is-warn">Doanh thu tạm từ PO: {figure(String(stats.dispatchTemporary))}</span>
        <span className="d3-rv-chip is-ok">Đã xác nhận: {figure(String(stats.dispatchConfirmed))}</span>
        <span className="d3-rv-chip is-bad">Cần SKU: {figure(String(stats.dispatchNeedsAllocation))}</span>
      </div>

      <div className="d3-rv-g2">
        <section className="d3-rv-card" style={{ ["--i" as string]: 4 }}>
          <div className="d3-rv-card-h">
            <h2>Doanh thu theo tháng</h2>
            <span className={mom.pct === null ? "d3-rv-pill" : mom.delta >= 0 ? "d3-rv-up" : "d3-rv-dn"}>
              Tháng trước: {mom.pct === null ? "N/A" : `${mom.pct >= 0 ? "+" : ""}${numberFmt(mom.pct)}%`}
            </span>
            <p>So sánh doanh thu từng tháng trong 6 tháng gần nhất, dùng ledger đã kiểm soát.</p>
          </div>
          <div className="d3-rv-chart">
            <ChartContainer config={{ revenue: { label: "Doanh thu", color: MOM_CURRENT_COLOR } }} className="h-full w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={monthlyRevenueChart} margin={{ top: 12, right: 8, bottom: 4, left: 0 }}>
                  <CartesianGrid stroke={TREND_GRID_COLOR} vertical={false} />
                  <XAxis dataKey="label" tickLine={false} axisLine={false} fontSize={11} tick={{ fill: "hsl(var(--muted-foreground))" }} />
                  <YAxis
                    tickFormatter={(v) => `${Math.round(Number(v) / 1_000_000)}tr`}
                    tickLine={false}
                    axisLine={false}
                    width={44}
                    fontSize={11}
                    tick={{ fill: "hsl(var(--muted-foreground))" }}
                  />
                  <Tooltip
                    cursor={{ fill: "rgba(39,39,39,0.05)" }}
                    contentStyle={{ background: "#fdfdfc", border: 0, borderRadius: "14px", boxShadow: "0 18px 40px -20px rgba(0,0,0,.35)" }}
                    formatter={(value) => [vnd(Number(value)), "Doanh thu"]}
                    labelFormatter={(_, payload) => {
                      const row = payload?.[0]?.payload as (typeof monthlyRevenueChart)[number] | undefined;
                      if (!row) return "Doanh thu theo tháng";
                      const change =
                        row.pct === null
                          ? "chưa có tháng trước"
                          : `${row.delta >= 0 ? "+" : ""}${vnd(row.delta)} (${row.pct >= 0 ? "+" : ""}${numberFmt(row.pct)}%) so với tháng trước`;
                      return `${periodLabel(row.period)} · ${change}`;
                    }}
                    labelStyle={{ color: "#272727", fontWeight: 500 }}
                  />
                  <Bar dataKey="revenue" radius={[6, 6, 2, 2]} maxBarSize={44}>
                    {monthlyRevenueChart.map((row) => (
                      <Cell key={row.period} fill={row.fill} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </ChartContainer>
          </div>
        </section>

        <section className="d3-rv-card" style={{ ["--i" as string]: 5 }}>
          <div className="d3-rv-card-h">
            <h2>Xu hướng doanh thu</h2>
            <span className="d3-rv-pill">{formatDate(throughDate)}</span>
            <p>Ledger thực tế và forecast đến cuối tháng.</p>
          </div>
          <div className="d3-rv-chart">
            <ChartContainer
              config={{
                ledger: { label: "Ledger", color: MOM_CURRENT_COLOR },
                forecast: { label: "Forecast", color: FORECAST_REMAINDER_COLOR },
              }}
              className="h-full w-full"
            >
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trendChart} margin={{ top: 14, right: 8, bottom: 4, left: 0 }}>
                  <defs>
                    <linearGradient id="ledgerTrendFill" x1="0" x2="0" y1="0" y2="1">
                      <stop offset="5%" stopColor={MOM_CURRENT_COLOR} stopOpacity={0.28} />
                      <stop offset="95%" stopColor={MOM_CURRENT_COLOR} stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="forecastTrendFill" x1="0" x2="0" y1="0" y2="1">
                      <stop offset="5%" stopColor={FORECAST_REMAINDER_COLOR} stopOpacity={0.22} />
                      <stop offset="95%" stopColor={FORECAST_REMAINDER_COLOR} stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={TREND_GRID_COLOR} vertical={false} />
                  <XAxis dataKey="day" tickLine={false} axisLine={false} fontSize={11} interval="preserveStartEnd" minTickGap={18} tick={{ fill: "hsl(var(--muted-foreground))" }} />
                  <YAxis
                    tickFormatter={(v) => `${Math.round(Number(v) / 1_000_000)}tr`}
                    tickLine={false}
                    axisLine={false}
                    width={44}
                    fontSize={11}
                    tick={{ fill: "hsl(var(--muted-foreground))" }}
                  />
                  <Tooltip
                    cursor={{ stroke: "rgba(39,39,39,0.3)", strokeDasharray: "4 4" }}
                    contentStyle={{ background: "#fdfdfc", border: 0, borderRadius: "14px", boxShadow: "0 18px 40px -20px rgba(0,0,0,.35)" }}
                    formatter={(value, name) => [vnd(Number(value)), name === "ledger" ? "Ledger" : "Forecast"]}
                    labelFormatter={(label) => `Ngày ${label}/${period.slice(5)}`}
                    labelStyle={{ color: "#272727", fontWeight: 500 }}
                  />
                  <Area type="monotone" dataKey="forecast" stroke={FORECAST_REMAINDER_COLOR} strokeDasharray="5 5" strokeWidth={2} fill="url(#forecastTrendFill)" dot={false} activeDot={{ r: 4 }} />
                  <Area
                    type="monotone"
                    dataKey="ledger"
                    stroke={MOM_CURRENT_COLOR}
                    strokeWidth={2.5}
                    fill="url(#ledgerTrendFill)"
                    connectNulls={false}
                    dot={false}
                    activeDot={{ r: 5, stroke: "#fdfdfc", strokeWidth: 2 }}
                  />
                  <Line
                    type="monotone"
                    dataKey="current"
                    stroke={MOM_CURRENT_COLOR}
                    strokeWidth={0}
                    dot={{ r: 5, fill: "#29bf12", stroke: "#fdfdfc", strokeWidth: 3 }}
                    legendType="none"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </ChartContainer>
          </div>
        </section>
      </div>

      <div className="d3-rv-g2 is-wide-left">
        {/* Customers / NPP as compact rows with a month sparkline (demo "Điểm bán"). */}
        <section className="d3-rv-card" style={{ ["--i" as string]: 6 }} data-bmq-revenue-customers>
          <div className="d3-rv-card-h">
            <h2>Doanh thu theo customer / NPP</h2>
            <span className="d3-rv-pill">{figure(String(byCustomer.length))}</span>
            <p>Sắp xếp theo doanh thu hiện tại; khách chỉ có kỳ trước nằm cuối danh sách. Chạm một dòng để xem source lines, PO trace và audit.</p>
          </div>
          {isLoading ? (
            <div className="d3-rv-empty"><Loader2 className="h-6 w-6 animate-spin" /></div>
          ) : error ? (
            <div className="d3-rv-empty">—</div>
          ) : byCustomer.length === 0 ? (
            <div className="d3-rv-empty">Chưa có dữ liệu doanh thu cho kỳ này.</div>
          ) : (
            <>
              <div className="d3-rv-rows">
                {visibleCustomers.map((row, index) => {
                  let running = 0;
                  const cumulative = row.daily.slice(0, Math.max(forecast.cutoffDay, 1)).map((value) => (running += value));
                  const peak = Math.max(1, ...cumulative);
                  const points = cumulative
                    .map((value, i) => `${cumulative.length <= 1 ? 50 : (i / (cumulative.length - 1)) * 100},${28 - (value / peak) * 24}`)
                    .join(" ");
                  const source = row.sourceTypes.size > 0 ? sourceTypeLabel[Array.from(row.sourceTypes)[0]] || Array.from(row.sourceTypes)[0] : "Kỳ trước";
                  return (
                    <button
                      key={row.key}
                      type="button"
                      className="d3-rv-trow"
                      style={{ ["--dl" as string]: `${200 + Math.min(index, 10) * 60}ms` }}
                      onClick={() => openSources({ customer_key: row.key })}
                      aria-label={`${row.name}: Chi tiết`}
                    >
                      <span className="d3-rv-trow-name">
                        <b>{row.name}</b>
                        <small>{row.rows} lines · {numberFmt(row.qty)} qty</small>
                      </span>
                      <span className="d3-rv-pill is-sm">{source}</span>
                      <svg className="d3-rv-spark" viewBox="0 0 100 30" preserveAspectRatio="none" aria-hidden="true">
                        <polyline points={points} stroke={row.delta >= 0 ? "#29bf12" : "#f4442e"} />
                      </svg>
                      <span className="d3-rv-num" title={vnd(row.revenue)}>{millions(row.revenue)}<small>tr</small></span>
                      <span className={row.pct === null ? "d3-rv-na" : row.delta >= 0 ? "d3-rv-up" : "d3-rv-dn"}>
                        {row.pct === null ? "N/A" : `${row.pct >= 0 ? "+" : ""}${numberFmt(row.pct)}%`}
                      </span>
                    </button>
                  );
                })}
              </div>
              {byCustomer.length > 8 ? (
                <button type="button" className="d3-rv-more" onClick={() => setShowAllCustomers((value) => !value)}>
                  {showAllCustomers ? "Thu gọn" : `Xem tất cả ${byCustomer.length} customer/NPP`}
                </button>
              ) : null}
            </>
          )}
        </section>

        <section className="d3-rv-card" style={{ ["--i" as string]: 7 }} data-bmq-revenue-channels>
          <div className="d3-rv-card-h">
            <h2>Doanh thu theo kênh</h2>
            <p>Tỷ trọng revenue của từng kênh trong ledger đã kiểm soát. Chạm để mở chi tiết.</p>
          </div>
          {isLoading ? (
            <div className="d3-rv-empty"><Loader2 className="h-6 w-6 animate-spin" /></div>
          ) : error ? (
            <div className="d3-rv-empty">—</div>
          ) : byChannel.length === 0 ? (
            <div className="d3-rv-empty">Chưa có dữ liệu kênh cho kỳ này.</div>
          ) : (
            <div className="d3-rv-chlist">
              {byChannel.map((row, index) => {
                const pct = stats.total > 0 ? (row.revenue / stats.total) * 100 : 0;
                return (
                  <button
                    key={row.key}
                    type="button"
                    className="d3-rv-ch"
                    style={{ ["--c" as string]: getChannelColor(row.key, index), ["--w" as string]: `${Math.max(pct, 2)}%` }}
                    onClick={() => openSources({ channel: row.key })}
                    aria-label={`${row.label}: Chi tiết`}
                  >
                    <span className="d3-rv-ch-name">
                      <b>{row.label}</b>
                      <small>{row.rows} rows · {numberFmt(row.qty)} qty</small>
                    </span>
                    <span className="d3-rv-ch-val">
                      <b title={vnd(row.revenue)}>{millions(row.revenue)}<small>tr</small></b>
                      <small>{numberFmt(pct)}%</small>
                    </span>
                    <i aria-hidden="true" />
                  </button>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
