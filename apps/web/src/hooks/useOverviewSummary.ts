import { useQuery } from "@tanstack/react-query";

import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { useLowStockItems } from "@/hooks/useInventory";
import {
  countProductionByStatus,
  countSubmittedLocations,
  metric,
  previousPeriod,
  summarizeRevenueByChannel,
  vietnamDayKey,
  type OverviewMetric,
  type ProductionStatusSummary,
  type RevenueChannelSummary,
} from "@/lib/overview/overview-summary";
import { fetchAllRevenueLines } from "@/lib/revenue-ledger";
import { getVietnamDayUtcRange } from "@/lib/vietnam-time";

const HREF = {
  revenue: "/finance-control/revenue",
  pendingApprovals: "/payment-requests",
  lowStock: "/low-stock",
  salesPo: "/sales-po-inbox",
  kioskReports: "/finance-control/revenue/points",
  production: "/production/planning/q7",
} as const;

const NO_PERMISSION = "no_permission";

/** 14-day series for the channel chart plus month-to-date totals for the revenue card. */
export type RevenueOverview = RevenueChannelSummary & { monthToDate: RevenueChannelSummary };

export type OverviewSummary = {
  revenue14d: OverviewMetric<RevenueOverview>;
  pendingApprovalsToday: OverviewMetric<number>;
  lowStock: OverviewMetric<number>;
  salesPoNewToday: OverviewMetric<number>;
  kioskReportsToday: OverviewMetric<number>;
  productionToday: OverviewMetric<ProductionStatusSummary>;
  isLoading: boolean;
};

type KioskReviewRow = { location_id?: unknown; submitted_at?: unknown };

/**
 * Hook chỉ-đọc tổng hợp 6 chỉ số cho trang Tổng quan.
 *
 * Mỗi chỉ số là một OverviewMetric độc lập: lỗi luôn trả status "error"
 * (value null), không bao giờ bị hạ thành 0. Khi người dùng không có quyền
 * module tương ứng, chỉ số trả "unavailable" kèm note "no_permission".
 */
export function useOverviewSummary(): OverviewSummary {
  const { canAccessModule } = useAuth();

  const canViewRevenue = canAccessModule("finance_revenue");
  const canViewPayments = canAccessModule("payment_requests");
  const canViewLowStock = canAccessModule("low_stock");
  const canViewSalesPo = canAccessModule("sales_po_inbox");
  const canViewProduction = canAccessModule("production_q7");

  const today = vietnamDayKey(new Date());
  const period = today.slice(0, 7);
  const previous = previousPeriod(period);
  const { startIso: startOfTodayUtc, endIso: endOfTodayUtc } = getVietnamDayUtcRange();

  const revenueQuery = useQuery({
    queryKey: ["overview-revenue-14d", today],
    enabled: canViewRevenue,
    queryFn: async () => {
      const [currentLines, previousLines] = await Promise.all([
        fetchAllRevenueLines(period, true),
        fetchAllRevenueLines(previous, true),
      ]);
      const lines = [...currentLines, ...previousLines];
      // The card counts 01/MM through today; the chart keeps its 14-day window.
      const monthToDate = summarizeRevenueByChannel(currentLines, today, Number(today.slice(8, 10)));
      const summary: RevenueOverview = { ...summarizeRevenueByChannel(lines, today, 14), monthToDate };
      return { lines, summary };
    },
  });

  // Same filter as usePaymentStats' pending badge, but a failed read stays an
  // error here: usePaymentStats turns failures into 0.
  const pendingQuery = useQuery({
    queryKey: ["overview-pending-approvals-today", today],
    enabled: canViewPayments,
    queryFn: async () => {
      const { count, error } = await supabase
        .from("payment_requests")
        .select("*", { count: "exact", head: true })
        .eq("status", "pending")
        .gte("created_at", startOfTodayUtc)
        .lt("created_at", endOfTodayUtc);
      if (error) throw error;
      return count ?? 0;
    },
  });

  // Shared hook (rules of hooks); the metric only reads it with permission.
  const lowStockQuery = useLowStockItems();

  const salesPoQuery = useQuery({
    queryKey: ["overview-sales-po-today", today],
    enabled: canViewSalesPo,
    queryFn: async () => {
      const { count, error } = await (supabase as any)
        .from("customer_po_inbox")
        .select("id", { count: "exact", head: true })
        .eq("match_status", "pending_approval")
        .gte("created_at", startOfTodayUtc);
      if (error) throw error;
      return (count as number | null) ?? 0;
    },
  });

  const kioskQuery = useQuery({
    queryKey: ["overview-kiosk-reports-today", today],
    enabled: canViewRevenue,
    queryFn: async () => {
      const { data, error } = await supabase.rpc(
        "get_kiosk_point_revenue_reviews" as never,
        {
          p_start_date: today,
          p_end_date: today,
          p_location_id: null,
          p_review_status: null,
        } as never,
      );
      if (error) throw error;
      const rows = ((data ?? []) as unknown[]).map((row) => {
        const record = (row ?? {}) as KioskReviewRow;
        return {
          location_id:
            typeof record.location_id === "string" ? record.location_id : null,
          submitted_at:
            typeof record.submitted_at === "string" ? record.submitted_at : null,
        };
      });
      return countSubmittedLocations(rows);
    },
  });

  const productionQuery = useQuery({
    queryKey: ["overview-production-today", today],
    enabled: canViewProduction,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("production_orders")
        .select("id,status")
        .eq("planned_start_date", today);
      if (error) throw error;
      const rows = ((data ?? []) as unknown[]).map((row) => ({
        status: String((row as { status?: unknown })?.status ?? ""),
      }));
      return countProductionByStatus(rows);
    },
  });

  const revenueMetric: OverviewMetric<RevenueOverview> = canViewRevenue
    ? metric({
        error: revenueQuery.error,
        value: revenueQuery.data?.summary ?? null,
        isEmpty:
          revenueQuery.data !== undefined &&
          revenueQuery.data.summary.total === 0 &&
          revenueQuery.data.lines.length === 0,
        asOf: today,
        href: HREF.revenue,
      })
    : metric({
        unavailable: NO_PERMISSION,
        asOf: today,
        href: HREF.revenue,
      });

  const pendingMetric: OverviewMetric<number> = canViewPayments
    ? metric({
        error: pendingQuery.error,
        value: pendingQuery.data ?? null,
        asOf: today,
        href: HREF.pendingApprovals,
      })
    : metric({
        unavailable: NO_PERMISSION,
        asOf: today,
        href: HREF.pendingApprovals,
      });

  const lowStockMetric: OverviewMetric<number> = canViewLowStock
    ? metric({
        error: lowStockQuery.isError ? lowStockQuery.error : undefined,
        value: lowStockQuery.data?.length ?? null,
        asOf: today,
        href: HREF.lowStock,
      })
    : metric({
        unavailable: NO_PERMISSION,
        asOf: today,
        href: HREF.lowStock,
      });

  const salesPoMetric: OverviewMetric<number> = canViewSalesPo
    ? metric({
        error: salesPoQuery.error,
        value: salesPoQuery.data ?? null,
        asOf: today,
        href: HREF.salesPo,
      })
    : metric({
        unavailable: NO_PERMISSION,
        asOf: today,
        href: HREF.salesPo,
      });

  const kioskMetric: OverviewMetric<number> = canViewRevenue
    ? metric({
        error: kioskQuery.error,
        value: kioskQuery.data ?? null,
        asOf: today,
        href: HREF.kioskReports,
      })
    : metric({
        unavailable: NO_PERMISSION,
        asOf: today,
        href: HREF.kioskReports,
      });

  const productionMetric: OverviewMetric<ProductionStatusSummary> =
    canViewProduction
      ? metric({
          error: productionQuery.error,
          value: productionQuery.data ?? null,
          asOf: today,
          href: HREF.production,
        })
      : metric({
          unavailable: NO_PERMISSION,
          asOf: today,
          href: HREF.production,
        });

  const isLoading =
    revenueQuery.isLoading ||
    pendingQuery.isLoading ||
    lowStockQuery.isLoading ||
    salesPoQuery.isLoading ||
    kioskQuery.isLoading ||
    productionQuery.isLoading;

  return {
    revenue14d: revenueMetric,
    pendingApprovalsToday: pendingMetric,
    lowStock: lowStockMetric,
    salesPoNewToday: salesPoMetric,
    kioskReportsToday: kioskMetric,
    productionToday: productionMetric,
    isLoading,
  };
}
