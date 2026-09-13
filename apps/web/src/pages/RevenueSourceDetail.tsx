import { formatText } from "@/i18n/format";
import { revenueSourceDetail } from "@/i18n/revenueSourceDetail";
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Database, FileSpreadsheet, Filter, Loader2, PencilLine, Plus, Search } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";

const vnd = (v: number) => new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(v || 0);
const numberFmt = (v: number) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 }).format(v || 0);
const CONTROLLED_APRIL_PERIOD = "2026-04";
const REVENUE_ROWS_PAGE_SIZE = 20;
const MANUAL_REVENUE_CHANNELS = ["ĐẠI LÝ", "BÁNH NGỌT", "B2B BMQ", "Retail Kiosk"] as const;

type RevenueLine = {
  id: string;
  source_document_id: string;
  source_row_number: number;
  period: string;
  revenue_date: string;
  channel: string;
  source_tab: string | null;
  branch: string | null;
  invoice_no: string | null;
  customer_id: string | null;
  parent_customer_id: string | null;
  customer_name: string;
  product_name: string | null;
  item_note: string | null;
  quantity: number | null;
  unit_price: number | null;
  gross_revenue: number | null;
  source_type: string;
  approval_status: string;
  audit_status: string;
  confidence_status: string;
  review_status: string;
  reconciliation_status: string;
  raw_payload: unknown;
};

type RevenueEditForm = {
  revenue_date: string;
  invoice_no: string;
  customer_name: string;
  product_name: string;
  item_note: string;
  quantity: string;
  unit_price: string;
  gross_revenue: string;
  audit_note: string;
};

type RevenueUpdatePayload = {
  revenue_date: string;
  invoice_no: string | null;
  customer_name: string;
  product_name: string | null;
  item_note: string | null;
  quantity: number;
  unit_price: number;
  gross_revenue: number;
  approval_status: string;
  audit_status: "adjusted";
  confidence_status: "manual_review";
  review_status: "resolved";
  reconciliation_status: "manual_override";
  raw_payload: Record<string, unknown>;
};

type ManualRevenueForm = {
  revenue_date: string;
  channel: string;
  customer_name: string;
  product_name: string;
  item_note: string;
  quantity: string;
  unit_price: string;
  gross_revenue: string;
};

type ManualRevenuePayload = {
  period: string;
  revenue_date: string;
  channel: string;
  customer_name: string;
  product_name: string | null;
  item_note: string | null;
  quantity: number;
  unit_price: number;
  gross_revenue: number;
  manual_entry_type: "missing_po_email";
  reason_code: "staff_forgot_po_email";
  evidence_note: string;
  evidence_url: string | null;
};

type DailyRevenueSheetExportResponse = {
  success?: boolean;
  revenueDate?: string;
  folderName?: string;
  folderId?: string;
  fileId?: string;
  fileName?: string;
  webViewLink?: string;
  rowCount?: number;
  grossRevenue?: number;
  error?: string;
};

type RevenueQuery = PromiseLike<{ data: RevenueLine[] | null; error: { message?: string } | null }> & {
  eq: (column: string, value: string) => RevenueQuery;
  gte: (column: string, value: string) => RevenueQuery;
  lte: (column: string, value: string) => RevenueQuery;
  in: (column: string, values: string[]) => RevenueQuery;
  or: (filters: string) => RevenueQuery;
  order: (column: string, options: { ascending: boolean }) => RevenueQuery;
  range: (from: number, to: number) => RevenueQuery;
};

type RevenueChannelRow = { channel: string | null };
type RevenueChannelQuery = PromiseLike<{ data: RevenueChannelRow[] | null; error: { message?: string } | null }> & {
  eq: (column: string, value: string) => RevenueChannelQuery;
  gte: (column: string, value: string) => RevenueChannelQuery;
  lte: (column: string, value: string) => RevenueChannelQuery;
  in: (column: string, values: string[]) => RevenueChannelQuery;
  or: (filters: string) => RevenueChannelQuery;
  order: (column: string, options: { ascending: boolean }) => RevenueChannelQuery;
  range: (from: number, to: number) => RevenueChannelQuery;
};

type CustomerOption = { id: string; customer_name: string | null; customer_group: string | null; product_group: string | null };
type CustomerOptionQuery = PromiseLike<{ data: CustomerOption[] | null; error: { message?: string } | null }> & {
  eq: (column: string, value: boolean) => CustomerOptionQuery;
  order: (column: string, options: { ascending: boolean }) => CustomerOptionQuery;
  range: (from: number, to: number) => CustomerOptionQuery;
};

const db = supabase as unknown as {
  from: (table: string) => {
    select: (columns: string) => RevenueQuery;
  };
  rpc: {
    (
      fn: "edit_revenue_ledger_line",
      args: { _ledger_line_id: string; _patch: RevenueUpdatePayload; _note: string | null }
    ): PromiseLike<{ data: RevenueLine | null; error: { message?: string } | null }>;
    (
      fn: "add_manual_revenue_ledger_line",
      args: { _payload: ManualRevenuePayload; _note: string | null }
    ): PromiseLike<{ data: RevenueLine | null; error: { message?: string } | null }>;
  };
};

const crmDb = supabase as unknown as {
  from: (table: "mini_crm_customers") => {
    select: (columns: string) => CustomerOptionQuery;
  };
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const toNumber = (value: string, copy: typeof revenueSourceDetail.vi) => {
  const normalized = value.replace(/,/g, "").trim();
  if (!normalized) return 0;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) throw new Error(copy.invalidNumber);
  return parsed;
};

const buildEditForm = (row: RevenueLine): RevenueEditForm => ({
  revenue_date: row.revenue_date || "",
  invoice_no: row.invoice_no || "",
  customer_name: row.customer_name || "",
  product_name: row.product_name || "",
  item_note: row.item_note || "",
  quantity: String(row.quantity ?? 0),
  unit_price: String(row.unit_price ?? 0),
  gross_revenue: String(row.gross_revenue ?? 0),
  audit_note: "",
});

const buildManualRevenueForm = (period: string, channel: string, revenueDate: string): ManualRevenueForm => ({
  revenue_date: revenueDate || `${period}-01`,
  channel,
  customer_name: "",
  product_name: "Bánh mì que",
  item_note: "",
  quantity: "",
  unit_price: "6500",
  gross_revenue: "",
});

const ledgerSnapshot = (row: RevenueLine) => ({
  revenue_date: row.revenue_date,
  invoice_no: row.invoice_no,
  customer_name: row.customer_name,
  product_name: row.product_name,
  item_note: row.item_note,
  quantity: row.quantity,
  unit_price: row.unit_price,
  gross_revenue: row.gross_revenue,
  approval_status: row.approval_status,
  audit_status: row.audit_status,
  confidence_status: row.confidence_status,
  review_status: row.review_status,
  reconciliation_status: row.reconciliation_status,
  raw_payload: row.raw_payload,
});

const applyRevenueSourceFilters = <T extends RevenueQuery | RevenueChannelQuery>(
  query: T,
  { period, channel, review, sourceDocumentId, revenueDate, dateFrom, dateTo, scope }: {
    period: string;
    channel?: string;
    review: string;
    sourceDocumentId: string;
    revenueDate: string;
    dateFrom: string;
    dateTo: string;
    scope: string;
  }
): T => {
  let next = query.eq("period", period) as T;
  const isControlledLedgerScope = scope === "controlled_ledger";

  if (sourceDocumentId) next = next.eq("source_document_id", sourceDocumentId) as T;
  if (dateFrom || dateTo) {
    if (dateFrom) next = next.gte("revenue_date", dateFrom) as T;
    if (dateTo) next = next.lte("revenue_date", dateTo) as T;
  } else if (revenueDate) {
    next = next.eq("revenue_date", revenueDate) as T;
  }
  if (isControlledLedgerScope) {
    next = next.in("source_document.status", ["controlled", "trusted"]).eq("approval_status", "approved") as T;
  } else if (sourceDocumentId || revenueDate) {
    next = next
      .eq("source_document.status", "controlled")
      .eq("source_document.source_type", "po_email_parse")
      .eq("source_document.summary->>monthly_parse_kind", "auto_daily_post") as T;
  } else {
    next = next.eq("source_document.status", "trusted") as T;
  }
  if (channel) next = next.eq("channel", channel) as T;
  if (review === "review_queue") next = next.or("review_status.eq.needs_manual_review,audit_status.eq.needs_review") as T;
  else if (review) next = next.eq("review_status", review) as T;

  return next;
};

async function fetchAllRevenueSourceLines(period: string, channel: string, review: string, sourceDocumentId: string, revenueDate: string, dateFrom: string, dateTo: string, scope: string) {
  const pageSize = 1000;
  const rows: RevenueLine[] = [];

  for (let from = 0; ; from += pageSize) {
    const baseQuery = db
      .from("revenue_ledger_lines")
      .select("id,source_document_id,source_row_number,period,revenue_date,channel,source_tab,branch,invoice_no,customer_id,parent_customer_id,customer_name,product_name,item_note,quantity,unit_price,gross_revenue,source_type,approval_status,audit_status,confidence_status,review_status,reconciliation_status,raw_payload,source_document:revenue_source_documents!inner(status)")
      .order("revenue_date", { ascending: true })
      .order("source_row_number", { ascending: true })
      .range(from, from + pageSize - 1);
    const query = applyRevenueSourceFilters(baseQuery, { period, channel, review, sourceDocumentId, revenueDate, dateFrom, dateTo, scope });

    const { data, error } = await query;
    if (error) throw error;
    const batch = (data || []) as RevenueLine[];
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
  }
}

async function fetchRevenueSourceChannels(period: string, review: string, sourceDocumentId: string, revenueDate: string, dateFrom: string, dateTo: string, scope: string) {
  const pageSize = 1000;
  const channels = new Set<string>();

  for (let from = 0; ; from += pageSize) {
    const baseQuery = db
      .from("revenue_ledger_lines")
      .select("channel,source_document:revenue_source_documents!inner(status)")
      .order("channel", { ascending: true })
      .range(from, from + pageSize - 1) as unknown as RevenueChannelQuery;
    const query = applyRevenueSourceFilters(baseQuery, { period, review, sourceDocumentId, revenueDate, dateFrom, dateTo, scope });

    const { data, error } = await query;
    if (error) throw error;
    const batch = data || [];
    batch.forEach((row) => {
      if (row.channel) channels.add(row.channel);
    });
    if (batch.length < pageSize) return Array.from(channels).sort();
  }
}

async function fetchManualRevenueCustomers() {
  const pageSize = 1000;
  const customers: CustomerOption[] = [];

  for (let from = 0; ; from += pageSize) {
    const { data, error } = await crmDb
      .from("mini_crm_customers")
      .select("id,customer_name,customer_group,product_group")
      .eq("is_active", true)
      .order("customer_name", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const batch = (data || []).filter((row) => row.customer_name);
    customers.push(...batch);
    if ((data || []).length < pageSize) return customers;
  }
}

function statusBadge(status: string, copy: typeof revenueSourceDetail.vi) {
  const labels: Record<string, string> = {
    pending: copy.pendingStatus,
    draft: copy.draftStatus,
    rejected: copy.rejected,
    low_confidence: copy.lowConfidence,
    approved: copy.controlled,
    trusted: copy.controlled,
    tied: copy.reconciled,
    matched: copy.matched,
    matched_po: copy.matchedPo,
    adjusted: copy.adjusted,
    needs_review: copy.needsReview,
    needs_manual_review: copy.needsReview,
    po_delta: copy.poDelta,
    csv_only: copy.csvOnly,
  };
  if (["approved", "trusted", "tied", "matched", "matched_po", "adjusted"].includes(status)) return <Badge variant="secondary">{labels[status] || status}</Badge>;
  if (["needs_review", "needs_manual_review", "po_delta", "csv_only"].includes(status)) return <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-700">{labels[status] || status}</Badge>;
  if (["rejected", "low_confidence"].includes(status)) return <Badge variant="destructive">{labels[status] || status}</Badge>;
  return <Badge variant="outline">{labels[status] || status}</Badge>;
}

function ledgerDisplayStatus(row: RevenueLine) {
  if (row.audit_status === "adjusted" || row.reconciliation_status === "manual_override") return "adjusted";
  if (row.review_status === "needs_manual_review" || row.audit_status === "needs_review") return "needs_review";
  return row.approval_status;
}

function customerMatchesManualChannel(customer: CustomerOption, channel: string) {
  const customerGroup = String(customer.customer_group || "").toLowerCase();
  const productGroup = String(customer.product_group || "").toLowerCase();
  if (channel === "ĐẠI LÝ") return productGroup === "banhmi" && (customerGroup.includes("agency") || customerGroup.includes("point"));
  if (channel === "BÁNH NGỌT") return productGroup === "banhngot";
  if (channel === "B2B BMQ") return productGroup === "banhmi" && customerGroup === "b2b";
  if (channel === "Retail Kiosk") return customerGroup.includes("retail") || customerGroup.includes("kiosk") || productGroup.includes("retail");
  return true;
}

export default function RevenueSourceDetail() {
  const { language } = useLanguage();
  const copy = revenueSourceDetail[language];
  const { canAccessModule, canEditModule } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const canEdit = canEditModule("finance_revenue");
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const period = params.get("period") || CONTROLLED_APRIL_PERIOD;
  const channel = params.get("channel") || "";
  const customerKey = params.get("customer_key") || "";
  const review = params.get("review") || "";
  const scope = params.get("scope") || "";
  const focus = params.get("focus") || "";
  const sourceDocumentId = params.get("sourceDocumentId") || "";
  const revenueDate = params.get("revenue_date") || "";
  const dateFrom = params.get("date_from") || "";
  const dateTo = params.get("date_to") || "";
  const dateFromInput = dateFrom || revenueDate;
  const dateToInput = dateTo || revenueDate;
  const isControlledLedgerScope = scope === "controlled_ledger";
  const isQuantityFocus = focus === "quantity";
  const isCustomersFocus = focus === "customers";
  const dashboardUrl = `/finance-control/revenue?${new URLSearchParams({ period }).toString()}`;
  const focusLabel = isQuantityFocus ? copy.production : isCustomersFocus ? copy.customers : focus;
  const reviewLabel = review === "review_queue" ? copy.needsReview : review;
  const [q, setQ] = useState("");
  const [editingLine, setEditingLine] = useState<RevenueLine | null>(null);
  const [editForm, setEditForm] = useState<RevenueEditForm | null>(null);
  const [manualDialogOpen, setManualDialogOpen] = useState(params.get("openAdd") === "1");
  const [manualForm, setManualForm] = useState<ManualRevenueForm>(() => buildManualRevenueForm(period, channel, revenueDate));
  const [saving, setSaving] = useState(false);
  const [exportingSheet, setExportingSheet] = useState(false);
  const [sheetExportResult, setSheetExportResult] = useState<DailyRevenueSheetExportResponse | null>(null);
  const [sheetExportUiError, setSheetExportUiError] = useState<{ key: "exportSessionExpired" | "unreadableResponse" | "httpExportFailed" | "exportTimeout"; status?: number } | null>(null);
  const [sheetExportError, setSheetExportError] = useState<string | null>(null);
  const [sheetExportMessage, setSheetExportMessage] = useState<string | null>(null);
  const [ledgerRowsPage, setLedgerRowsPage] = useState(1);

  const { data: lines = [], isLoading, error, refetch } = useQuery<RevenueLine[]>({
    queryKey: ["revenue-source-detail", period, channel, customerKey, review, scope, focus, sourceDocumentId, revenueDate, dateFrom, dateTo],
    queryFn: async () => {
      return fetchAllRevenueSourceLines(period, channel, review, sourceDocumentId, revenueDate, dateFrom, dateTo, scope);
    },
  });

  const { data: channelOptions = [] } = useQuery<string[]>({
    queryKey: ["revenue-source-channels", period, review, scope, focus, sourceDocumentId, revenueDate, dateFrom, dateTo],
    queryFn: async () => {
      return fetchRevenueSourceChannels(period, review, sourceDocumentId, revenueDate, dateFrom, dateTo, scope);
    },
  });

  const { data: customerOptions = [] } = useQuery<CustomerOption[]>({
    queryKey: ["manual-revenue-customers"],
    queryFn: fetchManualRevenueCustomers,
  });

  const manualChannelOptions = useMemo(
    () => Array.from(new Set([channel, ...channelOptions, ...MANUAL_REVENUE_CHANNELS].filter(Boolean))).sort(),
    [channel, channelOptions],
  );

  const filteredCustomerOptions = useMemo(() => {
    if (!manualForm.channel) return [];
    return customerOptions.filter((customer) => customerMatchesManualChannel(customer, manualForm.channel));
  }, [customerOptions, manualForm.channel]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return lines.filter((row) => {
      if (customerKey) {
        const key = row.parent_customer_id || row.customer_id || row.customer_name;
        if (key !== customerKey) return false;
      }
      if (!needle) return true;
      const raw = asRecord(row.raw_payload);
      const po = asRecord(raw.po_reconciliation);
      return [row.customer_name, row.product_name, row.invoice_no, row.branch, raw.parent_customer_name, po.review_flag]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(needle);
    });
  }, [customerKey, lines, q]);

  const stats = useMemo(() => ({
    rows: filtered.length,
    qty: filtered.reduce((s, r) => s + Number(r.quantity || 0), 0),
    revenue: filtered.reduce((s, r) => s + Number(r.gross_revenue || 0), 0),
    review: filtered.filter((r) => r.review_status === "needs_manual_review" || r.audit_status === "needs_review").length,
  }), [filtered]);
  const ledgerRowsTotalPages = Math.max(1, Math.ceil(filtered.length / REVENUE_ROWS_PAGE_SIZE));
  const ledgerRowsPageSafe = Math.min(ledgerRowsPage, ledgerRowsTotalPages);
  const paginatedLedgerRows = filtered.slice(
    (ledgerRowsPageSafe - 1) * REVENUE_ROWS_PAGE_SIZE,
    ledgerRowsPageSafe * REVENUE_ROWS_PAGE_SIZE
  );

  useEffect(() => {
    setLedgerRowsPage(1);
  }, [period, channel, customerKey, review, scope, focus, sourceDocumentId, revenueDate, dateFrom, dateTo, q]);

  useEffect(() => {
    if (ledgerRowsPage > ledgerRowsTotalPages) setLedgerRowsPage(ledgerRowsTotalPages);
  }, [ledgerRowsPage, ledgerRowsTotalPages]);

  const manualNumbers = useMemo(() => {
    const quantity = (() => { try { return toNumber(manualForm.quantity, copy); } catch { return NaN; } })();
    const unitPrice = (() => { try { return toNumber(manualForm.unit_price, copy); } catch { return NaN; } })();
    const grossRevenue = (() => { try { return toNumber(manualForm.gross_revenue, copy); } catch { return NaN; } })();
    return { quantity, unitPrice, grossRevenue };
  }, [manualForm.gross_revenue, manualForm.quantity, manualForm.unit_price, copy]);

  const duplicateWarnings = useMemo(() => {
    const customer = manualForm.customer_name.trim().toLowerCase();
    const product = manualForm.product_name.trim().toLowerCase();
    if (!manualForm.revenue_date || !manualForm.channel || !customer) return [] as RevenueLine[];
    return lines.filter((line) => {
      const sameDate = line.revenue_date === manualForm.revenue_date;
      const sameChannel = line.channel === manualForm.channel;
      const sameCustomer = line.customer_name.trim().toLowerCase() === customer;
      const sameProduct = !product || String(line.product_name || "").trim().toLowerCase() === product;
      const sameAmount = Number.isFinite(manualNumbers.grossRevenue) && Number(line.gross_revenue || 0) === manualNumbers.grossRevenue;
      return sameDate && sameChannel && sameCustomer && sameProduct && sameAmount;
    }).slice(0, 3);
  }, [lines, manualForm.channel, manualForm.customer_name, manualForm.product_name, manualForm.revenue_date, manualNumbers.grossRevenue]);

  const updateParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value); else next.delete(key);
    setParams(next);
  };

  const updateMonthFilter = (value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set("period", value); else next.delete("period");
    const activeDate = next.get("revenue_date") || "";
    if (activeDate && value && !activeDate.startsWith(`${value}-`)) next.delete("revenue_date");
    const activeDateFrom = next.get("date_from") || "";
    const activeDateTo = next.get("date_to") || "";
    if (activeDateFrom && value && !activeDateFrom.startsWith(`${value}-`)) next.delete("date_from");
    if (activeDateTo && value && !activeDateTo.startsWith(`${value}-`)) next.delete("date_to");
    setParams(next);
  };

  const updateDateRangeFilter = (key: "date_from" | "date_to", value: string) => {
    const next = new URLSearchParams(params);
    next.delete("revenue_date");
    if (value) next.set(key, value); else next.delete(key);
    setParams(next);
  };

  const clearLedgerFilters = () => {
    const next = new URLSearchParams(params);
    next.delete("channel");
    next.delete("revenue_date");
    next.delete("date_from");
    next.delete("date_to");
    next.delete("review");
    setParams(next);
    setQ("");
  };

  const sourceLinesDescription = isQuantityFocus
    ? copy.quantitySearchHint
    : isCustomersFocus
      ? copy.customerSearchHint
      : copy.searchHint;
  const searchPlaceholder = isQuantityFocus
    ? copy.productSearch
    : isCustomersFocus
      ? copy.customerSearch
      : copy.sourceSearch;

  const openEdit = (row: RevenueLine) => {
    setEditingLine(row);
    setEditForm(buildEditForm(row));
  };

  const closeEdit = () => {
    if (saving) return;
    setEditingLine(null);
    setEditForm(null);
  };

  const openManualAdd = () => {
    setManualForm(buildManualRevenueForm(period, channel, revenueDate));
    setManualDialogOpen(true);
  };

  const exportDailyRevenueSheet = async () => {
    if (!revenueDate) {
      toast({ title: copy.chooseExportDate, variant: "destructive" });
      return;
    }
    if (!canAccessModule("finance_revenue")) {
      toast({ title: copy.noExportPermission, description: copy.exportPermissionHint, variant: "destructive" });
      return;
    }

    setSheetExportResult(null);
    setSheetExportError(null);
    setSheetExportUiError(null);
    setSheetExportMessage("Đang tạo thư mục ngày và Google Sheet trên Drive...");
    setExportingSheet(true);
    toast({ title: copy.exporting, description: copy.exportingHint });

    let localError: typeof sheetExportUiError = null;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 90000);
    try {
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (sessionError) throw sessionError;
      const accessToken = sessionData.session?.access_token;
      if (!accessToken) {
        localError = { key: "exportSessionExpired" };
        throw new Error(copy.exportSessionExpired);
      }

      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const anonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
      const response = await fetch(`${supabaseUrl}/functions/v1/export-daily-revenue-sheet`, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          apikey: anonKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ revenueDate }),
      });
      const raw = await response.text();
      let result: DailyRevenueSheetExportResponse = {};
      try {
        result = raw ? JSON.parse(raw) : {};
      } catch {
        if (!raw) localError = { key: "unreadableResponse" };
        throw new Error(raw || copy.unreadableResponse);
      }
      if (!response.ok || !result.success || !result.webViewLink) {
        if (!result.error) localError = { key: "httpExportFailed", status: response.status };
        throw new Error(result.error || formatText(copy.httpExportFailed, { status: response.status }));
      }
      setSheetExportResult(result);
      setSheetExportMessage(`Đã tạo ${result.fileName || "Google Sheet"} trong thư mục ${result.folderName || revenueDate}.`);
      toast({
        title: copy.exported,
        description: formatText(copy.sheetRows, { folder: result.folderName || revenueDate, count: result.rowCount || 0, amount: vnd(Number(result.grossRevenue || 0)) }),
      });
      window.open(result.webViewLink, "_blank", "noopener,noreferrer");
    } catch (err) {
      const message = err instanceof DOMException && err.name === "AbortError"
        ? copy.exportTimeout
        : err instanceof Error ? err.message : String(err);
      setSheetExportUiError(err instanceof DOMException && err.name === "AbortError" ? { key: "exportTimeout" } : localError);
      setSheetExportError(message);
      setSheetExportMessage(`Export Google Sheet thất bại: ${message}`);
      toast({ title: copy.exportFailed, description: message, variant: "destructive" });
    } finally {
      window.clearTimeout(timeout);
      setExportingSheet(false);
    }
  };

  const closeManualAdd = () => {
    if (saving) return;
    setManualDialogOpen(false);
  };

  const updateManualField = (key: keyof ManualRevenueForm, value: string) => {
    setManualForm((current) => {
      const next = { ...current, [key]: value };
      if (key === "channel") next.customer_name = "";
      if (key === "quantity" || key === "unit_price") {
        try {
          const quantity = key === "quantity" ? toNumber(value, copy) : toNumber(next.quantity, copy);
          const unitPrice = key === "unit_price" ? toNumber(value, copy) : toNumber(next.unit_price, copy);
          if (Number.isFinite(quantity) && Number.isFinite(unitPrice) && quantity > 0 && unitPrice >= 0) {
            next.gross_revenue = String(quantity * unitPrice);
          }
        } catch {
          // Keep user-entered gross revenue while number is incomplete.
        }
      }
      return next;
    });
  };

  const saveManualAdd = async () => {
    if (!canEdit) {
      toast({ title: copy.noAddPermission, variant: "destructive" });
      return;
    }
    const customerName = manualForm.customer_name.trim();
    if (!manualForm.revenue_date || !manualForm.channel || !customerName) {
      toast({ title: copy.missingFields, variant: "destructive" });
      return;
    }
    if (!manualChannelOptions.includes(manualForm.channel)) {
      toast({ title: copy.selectListedChannel, variant: "destructive" });
      return;
    }
    const selectedCustomer = filteredCustomerOptions.find((customer) => customer.customer_name === customerName);
    if (!selectedCustomer) {
      toast({ title: copy.selectCrmCustomer, variant: "destructive" });
      return;
    }

    setSaving(true);
    try {
      const quantity = toNumber(manualForm.quantity, copy);
      const unitPrice = toNumber(manualForm.unit_price, copy);
      const grossRevenue = toNumber(manualForm.gross_revenue, copy);
      if (quantity <= 0 || unitPrice < 0 || grossRevenue <= 0) throw new Error(copy.positiveAmounts);
      const productName = manualForm.product_name.trim();
      const itemNote = manualForm.item_note.trim();
      const autoNote = [
        "Bổ sung doanh thu thủ công từ vận hành.",
        `Khách: ${customerName}.`,
        productName ? `Sản phẩm: ${productName}.` : null,
        `SL ${quantity}, đơn giá ${unitPrice}, doanh thu ${grossRevenue}.`,
        itemNote ? `Ghi chú: ${itemNote}.` : null,
      ].filter(Boolean).join(" ");
      const payload: ManualRevenuePayload = {
        period: manualForm.revenue_date.slice(0, 7),
        revenue_date: manualForm.revenue_date,
        channel: manualForm.channel,
        customer_name: customerName,
        product_name: productName || null,
        item_note: itemNote || null,
        quantity,
        unit_price: unitPrice,
        gross_revenue: grossRevenue,
        manual_entry_type: "missing_po_email",
        reason_code: "staff_forgot_po_email",
        evidence_note: autoNote,
        evidence_url: null,
      };
      const { error: addError } = await db.rpc("add_manual_revenue_ledger_line", {
        _payload: payload,
        _note: autoNote,
      });
      if (addError) throw addError;
      toast({ title: copy.added });
      setManualDialogOpen(false);
      setManualForm(buildManualRevenueForm(period, channel, revenueDate));
      await refetch();
      await queryClient.invalidateQueries({ queryKey: ["revenue-source-detail"] });
    } catch (err) {
      const message = err instanceof Error ? err.message : copy.addFailed;
      toast({ title: copy.addFailed, description: message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  const updateEditField = (key: keyof RevenueEditForm, value: string) => {
    setEditForm((current) => current ? { ...current, [key]: value } : current);
  };

  const saveEdit = async () => {
    if (!editingLine || !editForm) return;
    if (!canEdit) {
      toast({ title: copy.noEditPermission, variant: "destructive" });
      return;
    }

    const customerName = editForm.customer_name.trim();
    const revenueDate = editForm.revenue_date.trim();
    if (!customerName || !revenueDate) {
      toast({ title: copy.missingEditFields, variant: "destructive" });
      return;
    }

    setSaving(true);
    try {
      const quantity = toNumber(editForm.quantity, copy);
      const unitPrice = toNumber(editForm.unit_price, copy);
      const grossRevenue = toNumber(editForm.gross_revenue, copy);
      const note = editForm.audit_note.trim();
      const { data: authData } = await supabase.auth.getUser();
      const actorId = authData?.user?.id || null;
      const previousRaw = asRecord(editingLine.raw_payload);
      const auditDecision = {
        action: "edit",
        note: note || null,
        edited_at: new Date().toISOString(),
        edited_by: actorId,
        before: ledgerSnapshot(editingLine),
      };
      const payload: RevenueUpdatePayload = {
        revenue_date: revenueDate,
        invoice_no: editForm.invoice_no.trim() || null,
        customer_name: customerName,
        product_name: editForm.product_name.trim() || null,
        item_note: editForm.item_note.trim() || null,
        quantity,
        unit_price: unitPrice,
        gross_revenue: grossRevenue,
        approval_status: editingLine.approval_status,
        audit_status: "adjusted",
        confidence_status: "manual_review",
        review_status: "resolved",
        reconciliation_status: "manual_override",
        raw_payload: {
          ...previousRaw,
          audit_decision: auditDecision,
          audit_decisions: [...(Array.isArray(previousRaw.audit_decisions) ? previousRaw.audit_decisions : []), auditDecision],
        },
      };

      const { error: saveError } = await db.rpc("edit_revenue_ledger_line", {
        _ledger_line_id: editingLine.id,
        _patch: payload,
        _note: note || null,
      });
      if (saveError) throw saveError;

      toast({ title: copy.saved });
      setEditingLine(null);
      setEditForm(null);
      await refetch();
    } catch (err) {
      const message = err instanceof Error ? err.message : copy.saveFailed;
      toast({ title: copy.saveFailed, description: message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6" data-staff-i18n="b-revenue-v1">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-2">
          <Button variant="ghost" className="-ml-2" onClick={() => navigate(dashboardUrl)}>
            <ArrowLeft className="mr-2 h-4 w-4" />{copy.back} </Button>
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary" className="gap-1"><Database className="h-3 w-3" />{copy.sourceDetail}</Badge>
            {isControlledLedgerScope ? <Badge variant="outline">{copy.controlledLedger}</Badge> : null}
            {focusLabel ? <Badge variant="outline">{focusLabel}</Badge> : null}
            {reviewLabel ? <Badge variant="outline">{reviewLabel}</Badge> : null}
            {channel ? <Badge variant="outline">{(copy.channels as Record<string, string>)[channel] || channel}</Badge> : null}
            {sourceDocumentId ? <Badge variant="outline">{copy.autoSource}</Badge> : null}
            {dateFrom || dateTo ? <Badge variant="outline">{dateFrom || "…"} → {dateTo || "…"}</Badge> : revenueDate ? <Badge variant="outline">{revenueDate}</Badge> : null}
          </div>
          <h1 className="text-3xl font-display font-bold">{copy.uiRevenueSourceDetail}</h1>
          <p className="max-w-3xl text-muted-foreground">
            {copy.uiTraceEachLedgerLineBackToSource}
          </p>
          {isControlledLedgerScope ? (
            <p className="max-w-3xl text-sm text-muted-foreground">
              {copy.controlledHint} </p>
          ) : null}
          {isCustomersFocus ? (
            <p className="max-w-3xl text-sm text-muted-foreground">
              {copy.allLedgerHint} </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {revenueDate ? (
            <Button
              variant="outline"
              onClick={exportDailyRevenueSheet}
              disabled={exportingSheet}
              title={copy.exportHint}
            >
              {exportingSheet ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileSpreadsheet className="mr-2 h-4 w-4" />}
              {copy.exportSheet} </Button>
          ) : null}
          <Button variant="outline" onClick={openManualAdd} disabled={!canEdit} title={canEdit ? copy.addTooltip : copy.addPermissionTooltip}>
            <Plus className="mr-2 h-4 w-4" />{copy.addRow} </Button>
          <Button variant={review ? "default" : "outline"} onClick={() => updateParam("review", review ? "" : "review_queue")}>
            <Filter className="mr-2 h-4 w-4" />{copy.needsAudit} </Button>
        </div>
      </div>

      {sheetExportMessage ? (
        <Card className={sheetExportResult?.webViewLink ? "border-emerald-400/30 bg-emerald-950/30" : sheetExportMessage.startsWith("Export Google Sheet thất bại") ? "border-destructive/40 bg-destructive/5" : "border-amber-400/30 bg-amber-950/25"}>
          <CardContent className="flex flex-col gap-2 p-4 text-sm md:flex-row md:items-center md:justify-between">
            <div className="flex items-start gap-2">
              {exportingSheet ? <Loader2 className="mt-0.5 h-4 w-4 animate-spin" /> : <FileSpreadsheet className="mt-0.5 h-4 w-4" />}
              <div>
                <div className="font-medium">{copy.exportStatus}</div>
                <div className="text-muted-foreground">{sheetExportResult?.webViewLink ? formatText(copy.sheetCreated, { file: sheetExportResult.fileName || "Google Sheet", folder: sheetExportResult.folderName || revenueDate }) : sheetExportError !== null ? formatText(copy.sheetFailed, { message: sheetExportUiError ? formatText(copy[sheetExportUiError.key], { status: sheetExportUiError.status ?? "" }) : sheetExportError }) : copy.creatingSheet}</div>
              </div>
            </div>
            {sheetExportResult?.webViewLink ? (
              <Button variant="outline" size="sm" onClick={() => window.open(sheetExportResult.webViewLink, "_blank", "noopener,noreferrer")}>
                {copy.openSheet} </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-3 md:grid-cols-4">
        <Card><CardContent className="p-4"><div className="text-sm text-muted-foreground">{copy.rows}</div><div className="mt-1 text-2xl font-bold">{stats.rows}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-sm text-muted-foreground">{isQuantityFocus ? copy.ledgerQuantity : copy.qty}</div><div className="mt-1 text-2xl font-bold">{numberFmt(stats.qty)}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-sm text-muted-foreground">{copy.revenue}</div><div className="mt-1 text-2xl font-bold">{vnd(stats.revenue)}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-sm text-muted-foreground">{copy.needReview}</div><div className="mt-1 text-2xl font-bold">{stats.review}</div></CardContent></Card>
      </div>

      {error ? <Card className="border-destructive/40 bg-destructive/5"><CardContent className="p-4 text-sm text-destructive">{copy.ledgerError}</CardContent></Card> : null}

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <CardTitle>{copy.sourceLines}</CardTitle>
              <CardDescription>{sourceLinesDescription}</CardDescription>
            </div>
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-7">
              <div className="space-y-1">
                <Label htmlFor="ledger-period-filter" className="text-xs text-muted-foreground">{copy.month}</Label>
                <Input
                  id="ledger-period-filter"
                  type="month"
                  value={period}
                  onChange={(e) => updateMonthFilter(e.target.value)}
                  title={copy.monthFilter}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ledger-date-from-filter" className="text-xs text-muted-foreground">{copy.fromDate}</Label>
                <Input
                  id="ledger-date-from-filter"
                  type="date"
                  value={dateFromInput}
                  onChange={(e) => updateDateRangeFilter("date_from", e.target.value)}
                  title={copy.fromDateFilter}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ledger-date-to-filter" className="text-xs text-muted-foreground">{copy.toDate}</Label>
                <Input
                  id="ledger-date-to-filter"
                  type="date"
                  value={dateToInput}
                  onChange={(e) => updateDateRangeFilter("date_to", e.target.value)}
                  title={copy.toDateFilter}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ledger-channel-filter" className="text-xs text-muted-foreground">{copy.salesChannel}</Label>
                <select
                  id="ledger-channel-filter"
                  value={channel}
                  onChange={(e) => updateParam("channel", e.target.value)}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  title={copy.channelFilter}
                >
                  <option value="">{copy.allChannels}</option>
                  {Array.from(new Set([channel, ...channelOptions].filter(Boolean))).map((option) => (
                    <option key={option} value={option}>{(copy.channels as Record<string, string>)[option] || option}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1 xl:col-span-2">
                <Label htmlFor="ledger-search-filter" className="text-xs text-muted-foreground">{copy.search}</Label>
                <div className="relative">
                  <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input id="ledger-search-filter" value={q} onChange={(e) => setQ(e.target.value)} placeholder={searchPlaceholder} className="pl-9" />
                </div>
              </div>
              <div className="flex items-end">
                <Button variant="ghost" className="w-full" onClick={clearLedgerFilters}>{copy.clearFilters}</Button>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground">{copy.loading}</div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{copy.date}</TableHead>
                    <TableHead>{copy.customerSource}</TableHead>
                    <TableHead>{copy.product}</TableHead>
                    <TableHead className="text-right">{copy.qty}</TableHead>
                    <TableHead className="text-right">{copy.revenue}</TableHead>
                    <TableHead>{copy.status}</TableHead>
                    <TableHead className="text-right">{copy.actions}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {paginatedLedgerRows.map((row) => {
                    const raw = asRecord(row.raw_payload);
                    return (
                      <TableRow key={row.id}>
                        <TableCell className="whitespace-nowrap">{row.revenue_date}<div className="text-xs text-muted-foreground">#{row.source_row_number}</div></TableCell>
                        <TableCell className="min-w-[260px]">
                          <div className="font-medium">{String(raw.parent_customer_name || row.customer_name)}</div>
                          <div className="text-xs text-muted-foreground">{row.customer_name}</div>
                          <div className="text-xs text-muted-foreground">{row.source_tab || row.source_type} · {row.invoice_no || copy.noInvoice}</div>
                        </TableCell>
                        <TableCell className="min-w-[220px]">{row.product_name || "—"}<div className="text-xs text-muted-foreground">{row.item_note || row.branch || ""}</div></TableCell>
                        <TableCell className="text-right">{numberFmt(Number(row.quantity || 0))}</TableCell>
                        <TableCell className="text-right font-semibold">{vnd(Number(row.gross_revenue || 0))}</TableCell>
                        <TableCell>
                          {statusBadge(ledgerDisplayStatus(row), copy)}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={!canEdit}
                              title={canEdit ? copy.editTooltip : copy.editPermissionTooltip}
                              onClick={() => openEdit(row)}
                            >
                              <PencilLine className="mr-2 h-3.5 w-3.5" />{copy.edit} </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              <div className="mt-4 flex flex-col gap-2 text-xs text-muted-foreground md:flex-row md:items-center md:justify-between">
                <span>{copy.pageLimit} {filtered.length} {copy.rowUnit}</span>
                <div className="flex items-center justify-between gap-2 md:justify-end">
                  <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={() => setLedgerRowsPage((page) => Math.max(1, page - 1))} disabled={ledgerRowsPageSafe <= 1}>
                    {copy.previousPage} </Button>
                  <span className="min-w-[104px] text-center font-medium text-foreground">{copy.revenuePage} {ledgerRowsPageSafe}/{ledgerRowsTotalPages}</span>
                  <Button type="button" variant="outline" size="sm" className="h-8 text-xs" onClick={() => setLedgerRowsPage((page) => Math.min(ledgerRowsTotalPages, page + 1))} disabled={ledgerRowsPageSafe >= ledgerRowsTotalPages}>
                    {copy.nextPage} </Button>
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={manualDialogOpen} onOpenChange={(open) => { if (!open) closeManualAdd(); else setManualDialogOpen(true); }}>
        <DialogContent className="max-h-[92vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{copy.manualTitle}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="grid gap-3 md:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="manual-revenue-date">{copy.revenueDate}</Label>
                <Input id="manual-revenue-date" type="date" value={manualForm.revenue_date} onChange={(e) => updateManualField("revenue_date", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="manual-channel">{copy.channel}</Label>
                <select
                  id="manual-channel"
                  value={manualForm.channel}
                  onChange={(e) => updateManualField("channel", e.target.value)}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  <option value="">{copy.chooseChannel}</option>
                  {manualChannelOptions.map((option) => <option key={option} value={option}>{(copy.channels as Record<string, string>)[option] || option}</option>)}
                </select>
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="manual-customer">{copy.customerDealer}</Label>
                <select
                  id="manual-customer"
                  value={manualForm.customer_name}
                  onChange={(e) => updateManualField("customer_name", e.target.value)}
                  disabled={!manualForm.channel}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                >
                  <option value="">{manualForm.channel ? copy.chooseCustomer : copy.chooseChannelFirst}</option>
                  {filteredCustomerOptions.map((customer) => (
                    <option key={customer.id} value={customer.customer_name || ""}>{customer.customer_name}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="manual-product">{copy.productLabel}</Label>
                <Input id="manual-product" value={manualForm.product_name} onChange={(e) => updateManualField("product_name", e.target.value)} placeholder={copy.productPlaceholder} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="manual-qty">{copy.actualQuantity}</Label>
                <Input id="manual-qty" inputMode="decimal" value={manualForm.quantity} onChange={(e) => updateManualField("quantity", e.target.value)} placeholder="0" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="manual-price">{copy.unitPrice}</Label>
                <Input id="manual-price" inputMode="decimal" value={manualForm.unit_price} onChange={(e) => updateManualField("unit_price", e.target.value)} placeholder="6500" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="manual-gross">{copy.revenueLabel}</Label>
                <Input id="manual-gross" inputMode="decimal" value={manualForm.gross_revenue} onChange={(e) => updateManualField("gross_revenue", e.target.value)} placeholder={copy.autoAmount} />
              </div>
              <div className="space-y-2 md:col-span-3">
                <Label htmlFor="manual-item-note">{copy.itemNote}</Label>
                <Input id="manual-item-note" value={manualForm.item_note} onChange={(e) => updateManualField("item_note", e.target.value)} placeholder={copy.itemNotePlaceholder} />
              </div>
            </div>
            {duplicateWarnings.length ? (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
                <div className="font-medium">{copy.thereAre} {duplicateWarnings.length} {copy.similarRows}</div>
                <div className="mt-2 space-y-1">
                  {duplicateWarnings.map((line) => (
                    <div key={line.id}>• {line.customer_name} · {line.product_name || "—"} · {numberFmt(Number(line.quantity || 0))} · {vnd(Number(line.gross_revenue || 0))}</div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeManualAdd} disabled={saving}>{copy.cancel}</Button>
            <Button onClick={saveManualAdd} disabled={saving || !canEdit}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
              {copy.addControlled} </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editingLine} onOpenChange={(open) => { if (!open) closeEdit(); }}>
        <DialogContent className="max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-3xl overflow-y-auto overscroll-contain pb-[calc(1.5rem+env(safe-area-inset-bottom))] [-webkit-overflow-scrolling:touch] sm:max-h-[92vh] sm:w-full">
          <DialogHeader>
            <DialogTitle>{copy.editTitle}</DialogTitle>
            <DialogDescription>
              {copy.editHint} </DialogDescription>
          </DialogHeader>
          {editForm ? (
            <div className="grid gap-4 py-2">
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="revenue-date">{copy.revenueDate}</Label>
                  <Input id="revenue-date" type="date" value={editForm.revenue_date} onChange={(e) => updateEditField("revenue_date", e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="invoice-no">{copy.invoice}</Label>
                  <Input id="invoice-no" value={editForm.invoice_no} onChange={(e) => updateEditField("invoice_no", e.target.value)} />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="customer-name">{copy.customer}</Label>
                  <Input id="customer-name" value={editForm.customer_name} onChange={(e) => updateEditField("customer_name", e.target.value)} />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="product-name">{copy.productLabel}</Label>
                  <Input id="product-name" value={editForm.product_name} onChange={(e) => updateEditField("product_name", e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="quantity">{copy.quantity}</Label>
                  <Input id="quantity" inputMode="decimal" value={editForm.quantity} onChange={(e) => updateEditField("quantity", e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="unit-price">{copy.unitPrice}</Label>
                  <Input id="unit-price" inputMode="decimal" value={editForm.unit_price} onChange={(e) => updateEditField("unit_price", e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="gross-revenue">{copy.revenueLabel}</Label>
                  <Input id="gross-revenue" inputMode="decimal" value={editForm.gross_revenue} onChange={(e) => updateEditField("gross_revenue", e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="item-note">{copy.lineNote}</Label>
                  <Input id="item-note" value={editForm.item_note} onChange={(e) => updateEditField("item_note", e.target.value)} />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="audit-note">{copy.auditReason}</Label>
                <Textarea id="audit-note" value={editForm.audit_note} onChange={(e) => updateEditField("audit_note", e.target.value)} placeholder={copy.auditPlaceholder} />
              </div>
              <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                {copy.auditHint} </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={closeEdit} disabled={saving}>{copy.cancel}</Button>
            <Button onClick={saveEdit} disabled={saving || !canEdit}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {copy.saveLog} </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
