import { useQuery } from "@tanstack/react-query";
import { endOfMonth, format, startOfMonth } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";

type CostClassificationCategorySummaryRow = Tables<"cost_classification_category_summary">;
type CostClassificationMonthlySummaryRow = Tables<"cost_classification_monthly_summary">;
type CostClassificationReviewDetailRow = Tables<"cost_classification_line_details">;

export interface CostClassificationCategorySummary {
  category_code: string;
  category_label: string;
  cost_group: string;
  product_line: string;
  allocation_rule: string;
  review_status: string;
  line_count: number;
  total_amount: number;
  first_source_date: string | null;
  last_source_date: string | null;
}

export interface CostClassificationMonthlySummary {
  month: string;
  category_code: string;
  category_label: string;
  cost_group: string;
  product_line: string;
  allocation_rule: string;
  review_status: string;
  line_count: number;
  total_amount: number;
}

export interface CostClassificationReviewRow {
  classification_id: string;
  source_type: string;
  source_line_id: string;
  payment_request_id: string | null;
  invoice_id: string | null;
  source_number: string | null;
  source_date: string | null;
  supplier_name: string | null;
  product_name: string;
  product_code: string | null;
  unit: string | null;
  quantity: number;
  unit_price: number;
  line_amount: number;
  category_code: string;
  category_label: string;
  cost_group: string;
  product_line: string;
  allocation_rule: string;
  confidence: number;
  classification_source: string;
  review_status: string;
}

function normalizeCategorySummary(row: CostClassificationCategorySummaryRow): CostClassificationCategorySummary {
  return {
    category_code: row.category_code || "UNMAPPED_REVIEW",
    category_label: row.category_label || row.category_code || "Chưa phân loại / cần review",
    cost_group: row.cost_group || "unmapped",
    product_line: row.product_line || "general",
    allocation_rule: row.allocation_rule || "none",
    review_status: row.review_status || "needs_review",
    line_count: Number(row.line_count || 0),
    total_amount: Number(row.total_amount || 0),
    first_source_date: row.first_source_date,
    last_source_date: row.last_source_date,
  };
}

function normalizeMonthlySummary(row: CostClassificationMonthlySummaryRow): CostClassificationMonthlySummary {
  return {
    month: row.month || "",
    category_code: row.category_code || "UNMAPPED_REVIEW",
    category_label: row.category_label || row.category_code || "Chưa phân loại / cần review",
    cost_group: row.cost_group || "unmapped",
    product_line: row.product_line || "general",
    allocation_rule: row.allocation_rule || "none",
    review_status: row.review_status || "needs_review",
    line_count: Number(row.line_count || 0),
    total_amount: Number(row.total_amount || 0),
  };
}

function normalizeReviewRow(row: CostClassificationReviewDetailRow): CostClassificationReviewRow {
  return {
    classification_id: row.classification_id || row.source_line_id || "",
    source_type: row.source_type || "payment_request_item",
    source_line_id: row.source_line_id || "",
    payment_request_id: row.payment_request_id,
    invoice_id: row.invoice_id,
    source_number: row.source_number,
    source_date: row.source_date,
    supplier_name: row.supplier_name,
    product_name: row.product_name || "-",
    product_code: row.product_code,
    unit: row.unit,
    quantity: Number(row.quantity || 0),
    unit_price: Number(row.unit_price || 0),
    line_amount: Number(row.line_amount || 0),
    category_code: row.category_code || "UNMAPPED_REVIEW",
    category_label: row.category_label || row.category_code || "Chưa phân loại / cần review",
    cost_group: row.cost_group || "unmapped",
    product_line: row.product_line || "general",
    allocation_rule: row.allocation_rule || "none",
    confidence: Number(row.confidence || 0),
    classification_source: row.classification_source || "fallback",
    review_status: row.review_status || "needs_review",
  };
}

const COST_CLASSIFICATION_STALE_MS = 5 * 60_000;

export function useCostClassificationCategorySummary(enabled = true) {
  return useQuery({
    queryKey: ["cost-classification-category-summary"],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cost_classification_category_summary")
        .select("*")
        .order("category_code", { ascending: true });

      if (error) throw error;
      return (data || []).map(normalizeCategorySummary);
    },
    staleTime: COST_CLASSIFICATION_STALE_MS,
  });
}

export function useCostClassificationMonthlySummary(month: Date, enabled = true) {
  const monthStart = format(startOfMonth(month), "yyyy-MM-dd");
  const monthEnd = format(endOfMonth(month), "yyyy-MM-dd");

  return useQuery({
    queryKey: ["cost-classification-monthly-summary", monthStart],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cost_classification_monthly_summary")
        .select("*")
        .gte("month", monthStart)
        .lte("month", monthEnd)
        .order("month", { ascending: true })
        .order("category_code", { ascending: true });

      if (error) throw error;
      return (data || []).map(normalizeMonthlySummary);
    },
    staleTime: COST_CLASSIFICATION_STALE_MS,
  });
}

export function useCostClassificationReviewQueue(month: Date, enabled = true) {
  const monthStart = format(startOfMonth(month), "yyyy-MM-dd");
  const monthEnd = format(endOfMonth(month), "yyyy-MM-dd");

  return useQuery({
    queryKey: ["cost-classification-review-queue", monthStart],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cost_classification_line_details")
        .select("*")
        .gte("source_date", monthStart)
        .lte("source_date", monthEnd)
        .or("review_status.eq.needs_review,category_code.eq.UNMAPPED_REVIEW,confidence.lt.0.7")
        .order("line_amount", { ascending: false })
        .limit(50);

      if (error) throw error;
      return (data || []).map(normalizeReviewRow);
    },
    staleTime: COST_CLASSIFICATION_STALE_MS,
  });
}

export function useCostClassificationDashboard(month: Date, enabled = true) {
  const categorySummary = useCostClassificationCategorySummary(enabled);
  const monthlySummary = useCostClassificationMonthlySummary(month, enabled);
  const reviewQueue = useCostClassificationReviewQueue(month, enabled);

  return {
    categorySummary,
    monthlySummary,
    reviewQueue,
    isLoading: categorySummary.isLoading || monthlySummary.isLoading || reviewQueue.isLoading,
    isFetching: categorySummary.isFetching || monthlySummary.isFetching || reviewQueue.isFetching,
    error: categorySummary.error || monthlySummary.error || reviewQueue.error,
  };
}
