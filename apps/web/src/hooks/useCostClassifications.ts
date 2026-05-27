import { useQuery } from "@tanstack/react-query";
import { endOfMonth, format, startOfMonth } from "date-fns";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";

type CostClassificationCategorySummaryRow = Tables<"cost_classification_category_summary">;
type CostClassificationMonthlySummaryRow = Tables<"cost_classification_monthly_summary">;
type CostClassificationReviewDetailRow = Tables<"cost_classification_line_details">;
type CostCategoryRow = Tables<"cost_categories">;

export interface CostCategoryOption {
  code: string;
  label: string;
  cost_group: string;
  product_line: string;
  sort_order: number;
}

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
  supplier_id: string | null;
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
  raw_product_name?: string | null;
  suggested_standard_cost_code?: string | null;
  confirmed_standard_cost_code?: string | null;
  standard_cost_code_type?: string | null;
  canonical_cost_item_name?: string | null;
  canonical_cost_item_source?: string | null;
  cost_review_routing?: string | null;
  unit_conversion_note?: string | null;
  matched_finished_skus?: string[] | null;
  ocr_classification_json?: unknown;
}

export interface CostClassificationDetailFilter {
  month: string;
  category_code: string;
}

function normalizeCategoryOption(row: CostCategoryRow): CostCategoryOption {
  return {
    code: row.code,
    label: row.label || row.code,
    cost_group: row.cost_group || "unmapped",
    product_line: row.product_line || "general",
    sort_order: Number(row.sort_order || 0),
  };
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
    supplier_id: row.supplier_id,
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
    raw_product_name: null,
    suggested_standard_cost_code: null,
    confirmed_standard_cost_code: null,
    standard_cost_code_type: null,
    canonical_cost_item_name: null,
    canonical_cost_item_source: null,
    cost_review_routing: row.review_status || "needs_review",
    unit_conversion_note: null,
    matched_finished_skus: null,
    ocr_classification_json: null,
  };
}

const COST_CLASSIFICATION_STALE_MS = 5 * 60_000;
type ReviewSourceType = "payment_request_item" | "invoice_item";
type JsonRecord = Record<string, unknown>;

const asRecord = (value: unknown): JsonRecord => (
  value && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {}
);

const asNullableString = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text ? text : null;
};

const asNumber = (value: unknown): number => {
  const numberValue = Number(value || 0);
  return Number.isFinite(numberValue) ? numberValue : 0;
};

const asStringArray = (value: unknown): string[] | null => (
  Array.isArray(value) ? value.map((item) => String(item)).filter(Boolean) : null
);

const reviewRowKey = (row: CostClassificationReviewRow) => `${row.source_type}:${row.source_line_id || row.classification_id}`;

function normalizeOcrReviewRow(row: JsonRecord, sourceType: ReviewSourceType): CostClassificationReviewRow {
  const parentKey = sourceType === "payment_request_item" ? "payment_requests" : "invoices";
  const parent = asRecord(row[parentKey]);
  const supplier = asRecord(parent.suppliers);
  const categoryCode = asNullableString(row.cost_category_code) || "UNMAPPED_REVIEW";
  const sourceDate = asNullableString(parent.invoice_date) || asNullableString(parent.created_at) || asNullableString(row.created_at);
  const sourceNumber = asNullableString(parent.invoice_number) || asNullableString(parent.request_number);
  const sourceId = asNullableString(row.id) || "";

  return {
    classification_id: `ocr-${sourceType}-${sourceId}`,
    source_type: sourceType,
    source_line_id: sourceId,
    payment_request_id: sourceType === "payment_request_item" ? asNullableString(row.payment_request_id) : null,
    invoice_id: sourceType === "invoice_item" ? asNullableString(row.invoice_id) : null,
    source_number: sourceNumber,
    source_date: sourceDate,
    supplier_id: asNullableString(parent.supplier_id),
    supplier_name: asNullableString(supplier.name),
    product_name: asNullableString(row.product_name) || asNullableString(row.raw_product_name) || "-",
    product_code: asNullableString(row.product_code),
    unit: asNullableString(row.unit),
    quantity: asNumber(row.quantity),
    unit_price: asNumber(row.unit_price),
    line_amount: asNumber(row.line_total) || asNumber(row.quantity) * asNumber(row.unit_price),
    category_code: categoryCode,
    category_label: categoryCode === "UNMAPPED_REVIEW" ? "Chưa phân loại / cần review" : categoryCode,
    cost_group: categoryCode === "UNMAPPED_REVIEW" ? "unmapped" : "classified",
    product_line: asNullableString(row.cost_product_line) || "general",
    allocation_rule: asNullableString(row.cost_allocation_rule) || "none",
    confidence: row.cost_review_routing === "needs_review" ? 0 : 1,
    classification_source: asNullableString(row.canonical_cost_item_source) || "ocr_standard_cost",
    review_status: row.cost_review_routing === "needs_review" || categoryCode === "UNMAPPED_REVIEW" ? "needs_review" : "approved",
    raw_product_name: asNullableString(row.raw_product_name),
    suggested_standard_cost_code: asNullableString(row.suggested_standard_cost_code),
    confirmed_standard_cost_code: asNullableString(row.confirmed_standard_cost_code),
    standard_cost_code_type: asNullableString(row.standard_cost_code_type),
    canonical_cost_item_name: asNullableString(row.canonical_cost_item_name),
    canonical_cost_item_source: asNullableString(row.canonical_cost_item_source),
    cost_review_routing: asNullableString(row.cost_review_routing),
    unit_conversion_note: asNullableString(row.unit_conversion_note),
    matched_finished_skus: asStringArray(row.matched_finished_skus),
    ocr_classification_json: row.ocr_classification_json || null,
  };
}

async function fetchOcrReviewRows(monthStart: string, monthEnd: string, categoryCode?: string): Promise<CostClassificationReviewRow[]> {
  const shouldReadReviewQueue = !categoryCode || categoryCode === "UNMAPPED_REVIEW";
  const paymentQuery = supabase
    .from("payment_request_items")
    .select(`
      id,payment_request_id,product_code,product_name,unit,quantity,unit_price,line_total,created_at,
      raw_product_name,suggested_standard_cost_code,confirmed_standard_cost_code,standard_cost_code_type,
      canonical_cost_item_name,canonical_cost_item_source,cost_category_code,cost_product_line,cost_allocation_rule,
      cost_review_routing,unit_conversion_note,matched_finished_skus,ocr_classification_json,
      payment_requests(id,request_number,created_at,supplier_id,suppliers(id,name))
    `)
    .gte("created_at", monthStart)
    .lte("created_at", monthEnd);

  const invoiceQuery = supabase
    .from("invoice_items")
    .select(`
      id,invoice_id,product_code,product_name,unit,quantity,unit_price,line_total,created_at,
      raw_product_name,suggested_standard_cost_code,confirmed_standard_cost_code,standard_cost_code_type,
      canonical_cost_item_name,canonical_cost_item_source,cost_category_code,cost_product_line,cost_allocation_rule,
      cost_review_routing,unit_conversion_note,matched_finished_skus,ocr_classification_json,
      invoices(id,invoice_number,invoice_date,created_at,supplier_id,suppliers(id,name))
    `)
    .gte("created_at", monthStart)
    .lte("created_at", monthEnd);

  const paymentFiltered = shouldReadReviewQueue
    ? paymentQuery.or("cost_review_routing.eq.needs_review,cost_category_code.eq.UNMAPPED_REVIEW")
    : paymentQuery.eq("cost_category_code", categoryCode);
  const invoiceFiltered = shouldReadReviewQueue
    ? invoiceQuery.or("cost_review_routing.eq.needs_review,cost_category_code.eq.UNMAPPED_REVIEW")
    : invoiceQuery.eq("cost_category_code", categoryCode);

  const [paymentResult, invoiceResult] = await Promise.all([paymentFiltered.limit(250), invoiceFiltered.limit(250)]);
  if (paymentResult.error) throw paymentResult.error;
  if (invoiceResult.error) throw invoiceResult.error;

  return [
    ...(paymentResult.data || []).map((row) => normalizeOcrReviewRow(row as JsonRecord, "payment_request_item")),
    ...(invoiceResult.data || []).map((row) => normalizeOcrReviewRow(row as JsonRecord, "invoice_item")),
  ];
}

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
      return (data || [])
        .map(normalizeMonthlySummary)
        .filter((row) => row.month.slice(0, 7) === monthStart.slice(0, 7));
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
      const rows = [
        ...(data || []).map(normalizeReviewRow),
        ...await fetchOcrReviewRows(monthStart, monthEnd),
      ];
      return Array.from(new Map(rows.map((row) => [reviewRowKey(row), row])).values())
        .sort((a, b) => Number(b.line_amount || 0) - Number(a.line_amount || 0))
        .slice(0, 50);
    },
    staleTime: COST_CLASSIFICATION_STALE_MS,
  });
}

export function useCostCategories(enabled = true) {
  return useQuery({
    queryKey: ["cost-categories"],
    enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("cost_categories")
        .select("*")
        .eq("is_active", true)
        .order("sort_order", { ascending: true })
        .order("code", { ascending: true });

      if (error) throw error;
      return (data || []).map(normalizeCategoryOption);
    },
    staleTime: COST_CLASSIFICATION_STALE_MS,
  });
}

export function useCostClassificationLineDetails(filter: CostClassificationDetailFilter | null, enabled = true) {
  return useQuery({
    queryKey: ["cost-classification-line-details", filter],
    enabled: enabled && Boolean(filter),
    queryFn: async () => {
      if (!filter) return [];
      const monthStart = filter.month.slice(0, 10);
      const [year, month] = monthStart.split("-").map(Number);
      const monthEnd = format(endOfMonth(new Date(year, (month || 1) - 1, 1)), "yyyy-MM-dd");

      const { data, error } = await supabase
        .from("cost_classification_line_details")
        .select("*")
        .gte("source_date", monthStart)
        .lte("source_date", monthEnd)
        .eq("category_code", filter.category_code)
        .order("source_date", { ascending: false })
        .order("line_amount", { ascending: false })
        .limit(500);

      if (error) throw error;
      const rows = [
        ...(data || []).map(normalizeReviewRow),
        ...await fetchOcrReviewRows(monthStart, monthEnd, filter.category_code),
      ];
      return Array.from(new Map(rows.map((row) => [reviewRowKey(row), row])).values())
        .sort((a, b) => {
          const dateCompare = String(b.source_date || "").localeCompare(String(a.source_date || ""));
          return dateCompare || Number(b.line_amount || 0) - Number(a.line_amount || 0);
        })
        .slice(0, 500);
    },
    staleTime: COST_CLASSIFICATION_STALE_MS,
  });
}

export function useCostClassificationDashboard(month: Date, enabled = true) {
  const categorySummary = useCostClassificationCategorySummary(enabled);
  const monthlySummary = useCostClassificationMonthlySummary(month, enabled);
  const reviewQueue = useCostClassificationReviewQueue(month, enabled);
  const categories = useCostCategories(enabled);

  return {
    categorySummary,
    monthlySummary,
    reviewQueue,
    categories,
    isLoading: categorySummary.isLoading || monthlySummary.isLoading || reviewQueue.isLoading || categories.isLoading,
    isFetching: categorySummary.isFetching || monthlySummary.isFetching || reviewQueue.isFetching || categories.isFetching,
    error: categorySummary.error || monthlySummary.error || reviewQueue.error || categories.error,
  };
}
