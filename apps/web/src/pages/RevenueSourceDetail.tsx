import { useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, CheckCircle2, Database, FileSpreadsheet, Filter, Loader2, PencilLine, Plus, Search, Truck, TriangleAlert } from "lucide-react";
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
  evidence_note: string;
  evidence_url: string;
  audit_note: string;
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
  in: (column: string, values: string[]) => RevenueQuery;
  or: (filters: string) => RevenueQuery;
  order: (column: string, options: { ascending: boolean }) => RevenueQuery;
  range: (from: number, to: number) => RevenueQuery;
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

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const toNumber = (value: string) => {
  const normalized = value.replace(/,/g, "").trim();
  if (!normalized) return 0;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) throw new Error("Invalid number");
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
  evidence_note: "",
  evidence_url: "",
  audit_note: "",
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

async function fetchAllRevenueSourceLines(period: string, channel: string, review: string, sourceDocumentId: string, revenueDate: string, scope: string) {
  const pageSize = 1000;
  const rows: RevenueLine[] = [];
  const isControlledLedgerScope = scope === "controlled_ledger";

  for (let from = 0; ; from += pageSize) {
    let query = db
      .from("revenue_ledger_lines")
      .select("id,source_document_id,source_row_number,period,revenue_date,channel,source_tab,branch,invoice_no,customer_id,parent_customer_id,customer_name,product_name,item_note,quantity,unit_price,gross_revenue,source_type,approval_status,audit_status,confidence_status,review_status,reconciliation_status,raw_payload,source_document:revenue_source_documents!inner(status)")
      .eq("period", period)
      .order("revenue_date", { ascending: true })
      .order("source_row_number", { ascending: true })
      .range(from, from + pageSize - 1);

    if (sourceDocumentId) query = query.eq("source_document_id", sourceDocumentId);
    if (revenueDate) query = query.eq("revenue_date", revenueDate);
    if (isControlledLedgerScope) {
      query = query.in("source_document.status", ["controlled", "trusted"]).eq("approval_status", "approved");
    } else if (sourceDocumentId || revenueDate) {
      query = query
        .eq("source_document.status", "controlled")
        .eq("source_document.source_type", "po_email_parse")
        .eq("source_document.summary->>monthly_parse_kind", "auto_daily_post");
    } else {
      query = query.eq("source_document.status", "trusted");
    }
    if (channel) query = query.eq("channel", channel);
    if (review === "review_queue") query = query.or("review_status.eq.needs_manual_review,audit_status.eq.needs_review");
    else if (review) query = query.eq("review_status", review);

    const { data, error } = await query;
    if (error) throw error;
    const batch = (data || []) as RevenueLine[];
    rows.push(...batch);
    if (batch.length < pageSize) return rows;
  }
}

function statusBadge(status: string) {
  const labels: Record<string, string> = {
    approved: "Đã kiểm soát",
    trusted: "Đã kiểm soát",
    tied: "Khớp đối soát",
    matched: "Khớp",
    matched_po: "Khớp PO",
    needs_review: "Cần kiểm tra",
    needs_manual_review: "Cần kiểm tra",
    po_delta: "Lệch PO",
    csv_only: "Chỉ có nguồn đối soát",
  };
  if (["approved", "trusted", "tied", "matched", "matched_po"].includes(status)) return <Badge variant="secondary">{labels[status] || status}</Badge>;
  if (["needs_review", "needs_manual_review", "po_delta", "csv_only"].includes(status)) return <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-700">{labels[status] || status}</Badge>;
  if (["rejected", "low_confidence"].includes(status)) return <Badge variant="destructive">{status}</Badge>;
  return <Badge variant="outline">{status}</Badge>;
}

function dispatchRevenueBadge(raw: Record<string, unknown>) {
  const status = String(raw.revenue_amount_status || raw.dispatch_confirmation_status || "");
  if (status === "confirmed_dispatch_amount" || status === "month_end_audit_adjusted" || raw.dispatch_confirmation_status === "confirmed" || raw.dispatch_confirmation_status === "revised") {
    return <Badge variant="secondary">Đã xác nhận số xuất</Badge>;
  }
  if (status === "needs_sku_allocation" || raw.dispatch_confirmation_status === "needs_sku_allocation") {
    return <Badge variant="outline" className="border-amber-300 bg-amber-50 text-amber-700">Cần chọn SKU thiếu</Badge>;
  }
  if (status === "temporary_po_amount" || raw.dispatch_confirmation_status === "missing") {
    return <Badge variant="outline">Doanh thu tạm từ PO</Badge>;
  }
  return null;
}

function dispatchTraceText(raw: Record<string, unknown>) {
  const trace = asRecord(raw.dispatch_trace);
  if (!Object.keys(trace).length) return null;
  return [
    `PO: ${String(trace.ordered_qty ?? "—")}`,
    `Đạt: ${String(trace.produced_qty ?? "—")}`,
    `Lỗi/thiếu: ${String(trace.defect_qty ?? "—")}`,
    `Xuất: ${String(trace.dispatched_qty ?? "—")}`,
    `Tính tiền: ${String(trace.billable_qty ?? "—")}`,
  ].join(" · ");
}

function getInboxRowId(raw: Record<string, unknown>) {
  return String(raw.inbox_row_id || raw.customer_po_inbox_id || raw.po_inbox_id || "");
}

function shouldShowDispatchShortageAction(raw: Record<string, unknown>) {
  const inboxRowId = getInboxRowId(raw);
  const amountStatus = String(raw.revenue_amount_status || "");
  const confirmationStatus = String(raw.dispatch_confirmation_status || "");
  return Boolean(inboxRowId)
    && !["confirmed_dispatch_amount", "month_end_audit_adjusted"].includes(amountStatus)
    && !["confirmed", "revised"].includes(confirmationStatus);
}

export default function RevenueSourceDetail() {
  const { language } = useLanguage();
  const { canAccessModule, canEditModule } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const isVi = language === "vi";
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
  const isControlledLedgerScope = scope === "controlled_ledger";
  const isQuantityFocus = focus === "quantity";
  const isCustomersFocus = focus === "customers";
  const dashboardUrl = `/finance-control/revenue?${new URLSearchParams({ period }).toString()}`;
  const focusLabel = isQuantityFocus ? "Sản lượng" : isCustomersFocus ? "Customer/NPP" : focus;
  const reviewLabel = review === "review_queue" ? "Cần kiểm tra" : review;
  const [q, setQ] = useState("");
  const [editingLine, setEditingLine] = useState<RevenueLine | null>(null);
  const [editForm, setEditForm] = useState<RevenueEditForm | null>(null);
  const [manualDialogOpen, setManualDialogOpen] = useState(params.get("openAdd") === "1");
  const [manualForm, setManualForm] = useState<ManualRevenueForm>(() => buildManualRevenueForm(period, channel, revenueDate));
  const [saving, setSaving] = useState(false);
  const [exportingSheet, setExportingSheet] = useState(false);
  const [sheetExportResult, setSheetExportResult] = useState<DailyRevenueSheetExportResponse | null>(null);
  const [sheetExportMessage, setSheetExportMessage] = useState<string | null>(null);

  const { data: lines = [], isLoading, error, refetch } = useQuery<RevenueLine[]>({
    queryKey: ["revenue-source-detail", period, channel, customerKey, review, scope, focus, sourceDocumentId, revenueDate],
    queryFn: async () => {
      return fetchAllRevenueSourceLines(period, channel, review, sourceDocumentId, revenueDate, scope);
    },
  });

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

  const channelOptions = useMemo(() => Array.from(new Set(lines.map((line) => line.channel).filter(Boolean))).sort(), [lines]);

  const manualNumbers = useMemo(() => {
    const quantity = (() => { try { return toNumber(manualForm.quantity); } catch { return NaN; } })();
    const unitPrice = (() => { try { return toNumber(manualForm.unit_price); } catch { return NaN; } })();
    const grossRevenue = (() => { try { return toNumber(manualForm.gross_revenue); } catch { return NaN; } })();
    return { quantity, unitPrice, grossRevenue };
  }, [manualForm.gross_revenue, manualForm.quantity, manualForm.unit_price]);

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
    setParams(next);
  };

  const clearLedgerFilters = () => {
    const next = new URLSearchParams(params);
    next.delete("channel");
    next.delete("revenue_date");
    next.delete("review");
    setParams(next);
    setQ("");
  };

  const sourceLinesDescription = isQuantityFocus
    ? "Search product/customer/source. Ưu tiên xem chi tiết Qty, product và source lines."
    : isCustomersFocus
      ? "Search customer/NPP/source. Đang xem ledger theo customer/NPP để lọc nhóm khách trong bảng."
      : "Search invoice/customer/product/review flag. Staff sửa dòng sai tại đây; mỗi lần lưu sẽ ghi audit log.";
  const searchPlaceholder = isQuantityFocus
    ? "Search product/customer/source..."
    : isCustomersFocus
      ? "Search customer/NPP/source..."
      : "Search source lines…";

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

  const openDispatchConfirmation = (row: RevenueLine) => {
    const raw = asRecord(row.raw_payload);
    const dispatchPoId = getInboxRowId(raw);
    if (!dispatchPoId) {
      toast({ title: "Chưa có PO gốc để xác nhận giao thiếu", variant: "destructive" });
      return;
    }
    const next = new URLSearchParams({
      dispatchPoId,
      revenueDate: row.revenue_date,
      sourceLineId: row.id,
      reason: "short_delivery",
    });
    navigate(`/warehouse/dispatch?${next.toString()}`);
  };

  const exportDailyRevenueSheet = async () => {
    if (!revenueDate) {
      toast({ title: "Chọn một ngày doanh thu trước khi export", variant: "destructive" });
      return;
    }
    if (!canAccessModule("finance_revenue")) {
      toast({ title: "Không có quyền export doanh thu", description: "Tài khoản cần quyền xem hoặc sửa finance_revenue.", variant: "destructive" });
      return;
    }

    setSheetExportResult(null);
    setSheetExportMessage("Đang tạo thư mục ngày và Google Sheet trên Drive...");
    setExportingSheet(true);
    toast({ title: "Đang export Google Sheet", description: "App đang tạo thư mục dd/mm/yyyy và file Sheet trên Drive." });

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 90000);
    try {
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
      if (sessionError) throw sessionError;
      const accessToken = sessionData.session?.access_token;
      if (!accessToken) throw new Error("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại rồi export.");

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
        throw new Error(raw || "Function trả về response không đọc được.");
      }
      if (!response.ok || !result.success || !result.webViewLink) {
        throw new Error(result.error || `Export failed HTTP ${response.status}`);
      }
      setSheetExportResult(result);
      setSheetExportMessage(`Đã tạo ${result.fileName || "Google Sheet"} trong thư mục ${result.folderName || revenueDate}.`);
      toast({
        title: "Đã export Google Sheet doanh thu ngày",
        description: `${result.folderName || revenueDate} · ${result.rowCount || 0} dòng · ${vnd(Number(result.grossRevenue || 0))}`,
      });
      window.open(result.webViewLink, "_blank", "noopener,noreferrer");
    } catch (err) {
      const message = err instanceof DOMException && err.name === "AbortError"
        ? "Export quá 90 giây chưa phản hồi. Kiểm tra quyền Drive/Google token rồi thử lại."
        : err instanceof Error ? err.message : String(err);
      setSheetExportMessage(`Export Google Sheet thất bại: ${message}`);
      toast({ title: "Export Google Sheet thất bại", description: message, variant: "destructive" });
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
      if (key === "quantity" || key === "unit_price") {
        try {
          const quantity = key === "quantity" ? toNumber(value) : toNumber(next.quantity);
          const unitPrice = key === "unit_price" ? toNumber(value) : toNumber(next.unit_price);
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
      toast({ title: "Không có quyền thêm doanh thu", variant: "destructive" });
      return;
    }
    const customerName = manualForm.customer_name.trim();
    const evidenceNote = manualForm.evidence_note.trim();
    const note = manualForm.audit_note.trim();
    if (!manualForm.revenue_date || !manualForm.channel || !customerName) {
      toast({ title: "Thiếu ngày, kênh hoặc khách hàng", variant: "destructive" });
      return;
    }
    if (evidenceNote.length < 10 || note.length < 10) {
      toast({ title: "Thiếu lý do/evidence", description: "Vui lòng nhập evidence và audit note tối thiểu 10 ký tự.", variant: "destructive" });
      return;
    }

    setSaving(true);
    try {
      const quantity = toNumber(manualForm.quantity);
      const unitPrice = toNumber(manualForm.unit_price);
      const grossRevenue = toNumber(manualForm.gross_revenue);
      if (quantity <= 0 || unitPrice < 0 || grossRevenue <= 0) throw new Error("Số lượng/doanh thu phải lớn hơn 0");
      const payload: ManualRevenuePayload = {
        period: manualForm.revenue_date.slice(0, 7),
        revenue_date: manualForm.revenue_date,
        channel: manualForm.channel,
        customer_name: customerName,
        product_name: manualForm.product_name.trim() || null,
        item_note: manualForm.item_note.trim() || null,
        quantity,
        unit_price: unitPrice,
        gross_revenue: grossRevenue,
        manual_entry_type: "missing_po_email",
        reason_code: "staff_forgot_po_email",
        evidence_note: evidenceNote,
        evidence_url: manualForm.evidence_url.trim() || null,
      };
      const { error: addError } = await db.rpc("add_manual_revenue_ledger_line", {
        _payload: payload,
        _note: note,
      });
      if (addError) throw addError;
      toast({ title: "Đã thêm dòng doanh thu thủ công và ghi audit log." });
      setManualDialogOpen(false);
      setManualForm(buildManualRevenueForm(period, channel, revenueDate));
      await refetch();
      await queryClient.invalidateQueries({ queryKey: ["revenue-source-detail"] });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Không thêm được dòng doanh thu";
      toast({ title: "Không thêm được dòng doanh thu", description: message, variant: "destructive" });
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
      toast({ title: "Không có quyền sửa doanh thu", variant: "destructive" });
      return;
    }

    const customerName = editForm.customer_name.trim();
    const revenueDate = editForm.revenue_date.trim();
    if (!customerName || !revenueDate) {
      toast({ title: "Thiếu ngày doanh thu hoặc tên khách", variant: "destructive" });
      return;
    }

    setSaving(true);
    try {
      const quantity = toNumber(editForm.quantity);
      const unitPrice = toNumber(editForm.unit_price);
      const grossRevenue = toNumber(editForm.gross_revenue);
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

      toast({ title: "Đã lưu chỉnh sửa và ghi log" });
      setEditingLine(null);
      setEditForm(null);
      await refetch();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Không lưu được chỉnh sửa";
      toast({ title: "Không lưu được chỉnh sửa", description: message, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="space-y-2">
          <Button variant="ghost" className="-ml-2" onClick={() => navigate(dashboardUrl)}>
            <ArrowLeft className="mr-2 h-4 w-4" />Quay lại dashboard
          </Button>
          <div className="flex flex-wrap gap-2">
            <Badge variant="secondary" className="gap-1"><Database className="h-3 w-3" />Source detail</Badge>
            {isControlledLedgerScope ? <Badge variant="outline">Controlled ledger</Badge> : null}
            {focusLabel ? <Badge variant="outline">{focusLabel}</Badge> : null}
            {reviewLabel ? <Badge variant="outline">{reviewLabel}</Badge> : null}
            {channel ? <Badge variant="outline">{channel}</Badge> : null}
            {sourceDocumentId ? <Badge variant="outline">Auto daily source</Badge> : null}
            {revenueDate ? <Badge variant="outline">{revenueDate}</Badge> : null}
          </div>
          <h1 className="text-3xl font-display font-bold">{isVi ? "Chi tiết nguồn doanh thu" : "Revenue source detail"}</h1>
          <p className="max-w-3xl text-muted-foreground">
            {isVi
              ? "Trace từng dòng ledger về nguồn đối soát/PO/email. Dòng parse từ PO là evidence vận hành; số dashboard lấy từ ledger đã kiểm soát."
              : "Trace each ledger line back to source evidence, PO, and email. Parsed PO rows are operational evidence; dashboard numbers come from the controlled ledger."}
          </p>
          {isControlledLedgerScope ? (
            <p className="max-w-3xl text-sm text-muted-foreground">
              Controlled ledger: Số vận hành đã kiểm soát, chưa phải final audit.
            </p>
          ) : null}
          {isCustomersFocus ? (
            <p className="max-w-3xl text-sm text-muted-foreground">
              Đang xem toàn bộ ledger theo kỳ; dùng search/bảng để lọc customer hoặc NPP cần kiểm tra.
            </p>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {revenueDate ? (
            <Button
              variant="outline"
              onClick={exportDailyRevenueSheet}
              disabled={exportingSheet}
              title="Export doanh thu ngày ra Google Sheet trong Drive theo thư mục dd/mm/yyyy"
            >
              {exportingSheet ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <FileSpreadsheet className="mr-2 h-4 w-4" />}
              Export Google Sheet
            </Button>
          ) : null}
          <Button variant="outline" onClick={openManualAdd} disabled={!canEdit} title={canEdit ? "Thêm dòng doanh thu thiếu PO/email" : "Cần quyền finance_revenue để thêm dòng doanh thu"}>
            <Plus className="mr-2 h-4 w-4" />+ Thêm dòng doanh thu
          </Button>
          <Button variant={review ? "default" : "outline"} onClick={() => updateParam("review", review ? "" : "review_queue")}>
            <Filter className="mr-2 h-4 w-4" />Cần audit
          </Button>
        </div>
      </div>

      {sheetExportMessage ? (
        <Card className={sheetExportResult?.webViewLink ? "border-emerald-400/30 bg-emerald-950/30" : sheetExportMessage.startsWith("Export Google Sheet thất bại") ? "border-destructive/40 bg-destructive/5" : "border-amber-400/30 bg-amber-950/25"}>
          <CardContent className="flex flex-col gap-2 p-4 text-sm md:flex-row md:items-center md:justify-between">
            <div className="flex items-start gap-2">
              {exportingSheet ? <Loader2 className="mt-0.5 h-4 w-4 animate-spin" /> : <FileSpreadsheet className="mt-0.5 h-4 w-4" />}
              <div>
                <div className="font-medium">Trạng thái export Google Sheet</div>
                <div className="text-muted-foreground">{sheetExportMessage}</div>
              </div>
            </div>
            {sheetExportResult?.webViewLink ? (
              <Button variant="outline" size="sm" onClick={() => window.open(sheetExportResult.webViewLink, "_blank", "noopener,noreferrer")}>
                Mở Google Sheet
              </Button>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-3 md:grid-cols-4">
        <Card><CardContent className="p-4"><div className="text-sm text-muted-foreground">Rows</div><div className="mt-1 text-2xl font-bold">{stats.rows}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-sm text-muted-foreground">{isQuantityFocus ? "Qty từ ledger" : "Qty"}</div><div className="mt-1 text-2xl font-bold">{numberFmt(stats.qty)}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-sm text-muted-foreground">Revenue</div><div className="mt-1 text-2xl font-bold">{vnd(stats.revenue)}</div></CardContent></Card>
        <Card><CardContent className="p-4"><div className="text-sm text-muted-foreground">Need review</div><div className="mt-1 text-2xl font-bold">{stats.review}</div></CardContent></Card>
      </div>

      {error ? <Card className="border-destructive/40 bg-destructive/5"><CardContent className="p-4 text-sm text-destructive">Không đọc được revenue ledger.</CardContent></Card> : null}

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <CardTitle>Ledger source lines</CardTitle>
              <CardDescription>{sourceLinesDescription}</CardDescription>
            </div>
            <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-6">
              <div className="space-y-1">
                <Label htmlFor="ledger-period-filter" className="text-xs text-muted-foreground">Tháng</Label>
                <Input
                  id="ledger-period-filter"
                  type="month"
                  value={period}
                  onChange={(e) => updateMonthFilter(e.target.value)}
                  title="Lọc ledger theo tháng/kỳ doanh thu"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ledger-date-filter" className="text-xs text-muted-foreground">Ngày</Label>
                <Input
                  id="ledger-date-filter"
                  type="date"
                  value={revenueDate}
                  onChange={(e) => updateParam("revenue_date", e.target.value)}
                  title="Lọc ledger theo ngày doanh thu"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="ledger-channel-filter" className="text-xs text-muted-foreground">Kênh bán hàng</Label>
                <select
                  id="ledger-channel-filter"
                  value={channel}
                  onChange={(e) => updateParam("channel", e.target.value)}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                  title="Lọc ledger theo kênh bán hàng"
                >
                  <option value="">Tất cả kênh</option>
                  {Array.from(new Set([channel, ...channelOptions].filter(Boolean))).map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </div>
              <div className="space-y-1 xl:col-span-2">
                <Label htmlFor="ledger-search-filter" className="text-xs text-muted-foreground">Tìm kiếm</Label>
                <div className="relative">
                  <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
                  <Input id="ledger-search-filter" value={q} onChange={(e) => setQ(e.target.value)} placeholder={searchPlaceholder} className="pl-9" />
                </div>
              </div>
              <div className="flex items-end">
                <Button variant="ghost" className="w-full" onClick={clearLedgerFilters}>Xóa lọc</Button>
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground">Đang tải…</div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>Customer / source</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead className="text-right">Qty</TableHead>
                    <TableHead className="text-right">Revenue</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Audit note</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filtered.map((row) => {
                    const raw = asRecord(row.raw_payload);
                    const po = asRecord(raw.po_reconciliation);
                    return (
                      <TableRow key={row.id}>
                        <TableCell className="whitespace-nowrap">{row.revenue_date}<div className="text-xs text-muted-foreground">#{row.source_row_number}</div></TableCell>
                        <TableCell className="min-w-[260px]">
                          <div className="font-medium">{String(raw.parent_customer_name || row.customer_name)}</div>
                          <div className="text-xs text-muted-foreground">{row.customer_name}</div>
                          <div className="text-xs text-muted-foreground">{row.source_tab || row.source_type} · {row.invoice_no || "no invoice"}</div>
                        </TableCell>
                        <TableCell className="min-w-[220px]">{row.product_name || "—"}<div className="text-xs text-muted-foreground">{row.item_note || row.branch || ""}</div></TableCell>
                        <TableCell className="text-right">{numberFmt(Number(row.quantity || 0))}</TableCell>
                        <TableCell className="text-right font-semibold">{vnd(Number(row.gross_revenue || 0))}</TableCell>
                        <TableCell className="space-y-1">
                          <div>{statusBadge(row.approval_status)}</div>
                          <div>{statusBadge(row.reconciliation_status)}</div>
                          <div>{dispatchRevenueBadge(raw)}</div>
                        </TableCell>
                        <TableCell className="min-w-[260px] text-sm">
                          {row.review_status === "needs_manual_review" || row.audit_status === "needs_review" ? (
                            <div className="flex gap-2 text-amber-700"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /><span>{String(po.review_flag || row.audit_status || "needs_manual_review")}</span></div>
                          ) : (
                            <div className="flex gap-2 text-emerald-700"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /><span>{row.confidence_status}</span></div>
                          )}
                          {po.po_qty != null ? <div className="mt-1 text-xs text-muted-foreground">PO qty: {String(po.po_qty)}; delta: {String(po.delta_qty)}</div> : null}
                          {dispatchTraceText(raw) ? <div className="mt-1 text-xs text-muted-foreground">{dispatchTraceText(raw)}</div> : null}
                          {raw.revenue_amount_basis ? <div className="mt-1 text-xs text-muted-foreground">Basis: {String(raw.revenue_amount_basis)}</div> : null}
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            {shouldShowDispatchShortageAction(raw) ? (
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={!canEdit}
                                title={canEdit ? "PO đặt nhưng thực tế giao không đủ: xác nhận số giao/billable theo phiếu xuất" : "Cần quyền finance_revenue để xác nhận số xuất thực tế"}
                                onClick={() => openDispatchConfirmation(row)}
                              >
                                <Truck className="mr-2 h-3.5 w-3.5" />Xác nhận số xuất
                              </Button>
                            ) : null}
                            <Button
                              variant="outline"
                              size="sm"
                              disabled={!canEdit}
                              title={canEdit ? "Sửa dòng và ghi audit log" : "Cần quyền finance_revenue để sửa dòng doanh thu"}
                              onClick={() => openEdit(row)}
                            >
                              <PencilLine className="mr-2 h-3.5 w-3.5" />Edit
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={manualDialogOpen} onOpenChange={(open) => { if (!open) closeManualAdd(); else setManualDialogOpen(true); }}>
        <DialogContent className="max-h-[92vh] max-w-4xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Thêm dòng doanh thu thủ công</DialogTitle>
            <DialogDescription>
              Dòng này sẽ vào Doanh thu đã kiểm soát và được ghi audit log. Không thay thế audit cuối tháng.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2">
            <div className="rounded-lg border border-amber-300/40 bg-amber-50 p-3 text-sm text-amber-800">
              <div className="font-medium">Loại bổ sung: Thiếu PO/email</div>
              <div>Áp dụng khi staff quên gửi mail đặt bánh cho đại lý làm PO parse thiếu so với thực tế vận hành.</div>
            </div>
            <div className="grid gap-3 md:grid-cols-3">
              <div className="space-y-2">
                <Label htmlFor="manual-revenue-date">Ngày doanh thu</Label>
                <Input id="manual-revenue-date" type="date" value={manualForm.revenue_date} onChange={(e) => updateManualField("revenue_date", e.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="manual-channel">Kênh</Label>
                <Input id="manual-channel" list="manual-channel-options" value={manualForm.channel} onChange={(e) => updateManualField("channel", e.target.value)} placeholder="VD: ĐẠI LÝ" />
                <datalist id="manual-channel-options">
                  {channelOptions.map((option) => <option key={option} value={option} />)}
                </datalist>
              </div>
              <div className="space-y-2">
                <Label htmlFor="manual-type">Loại dòng</Label>
                <Input id="manual-type" value="Thiếu PO/email" disabled />
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="manual-customer">Khách hàng/Đại lý</Label>
                <Input id="manual-customer" value={manualForm.customer_name} onChange={(e) => updateManualField("customer_name", e.target.value)} placeholder="Tên đại lý cần tính công nợ" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="manual-product">Sản phẩm</Label>
                <Input id="manual-product" value={manualForm.product_name} onChange={(e) => updateManualField("product_name", e.target.value)} placeholder="Bánh mì que" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="manual-qty">Số lượng thực tế</Label>
                <Input id="manual-qty" inputMode="decimal" value={manualForm.quantity} onChange={(e) => updateManualField("quantity", e.target.value)} placeholder="0" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="manual-price">Đơn giá</Label>
                <Input id="manual-price" inputMode="decimal" value={manualForm.unit_price} onChange={(e) => updateManualField("unit_price", e.target.value)} placeholder="6500" />
              </div>
              <div className="space-y-2">
                <Label htmlFor="manual-gross">Doanh thu</Label>
                <Input id="manual-gross" inputMode="decimal" value={manualForm.gross_revenue} onChange={(e) => updateManualField("gross_revenue", e.target.value)} placeholder="Tự tính từ SL × đơn giá" />
              </div>
              <div className="space-y-2 md:col-span-3">
                <Label htmlFor="manual-item-note">Ghi chú mặt hàng</Label>
                <Input id="manual-item-note" value={manualForm.item_note} onChange={(e) => updateManualField("item_note", e.target.value)} placeholder="VD: Bổ sung công nợ vì thiếu email PO" />
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="manual-evidence">Nguồn xác nhận / evidence</Label>
                <Textarea id="manual-evidence" value={manualForm.evidence_note} onChange={(e) => updateManualField("evidence_note", e.target.value)} placeholder="VD: Quản lý vận hành xác nhận đại lý có nhận thêm 100 bánh ngày này..." />
              </div>
              <div className="space-y-2">
                <Label htmlFor="manual-audit-note">Lý do / audit note</Label>
                <Textarea id="manual-audit-note" value={manualForm.audit_note} onChange={(e) => updateManualField("audit_note", e.target.value)} placeholder="VD: Thiếu PO/email do staff quên gửi mail, bổ sung theo xác nhận vận hành." />
              </div>
              <div className="space-y-2 md:col-span-2">
                <Label htmlFor="manual-evidence-url">Link ảnh/tài liệu nếu có</Label>
                <Input id="manual-evidence-url" value={manualForm.evidence_url} onChange={(e) => updateManualField("evidence_url", e.target.value)} placeholder="https://..." />
              </div>
            </div>
            {duplicateWarnings.length ? (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800">
                <div className="font-medium">Có {duplicateWarnings.length} dòng tương tự trong ngày này. Vui lòng kiểm tra để tránh cộng trùng công nợ.</div>
                <div className="mt-2 space-y-1">
                  {duplicateWarnings.map((line) => (
                    <div key={line.id}>• {line.customer_name} · {line.product_name || "—"} · {numberFmt(Number(line.quantity || 0))} · {vnd(Number(line.gross_revenue || 0))}</div>
                  ))}
                </div>
              </div>
            ) : null}
            <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
              Sau khi lưu: source_type = manual_entry, approval_status = approved, audit_status = adjusted, confidence_status = manual_review, review_status = resolved, reconciliation_status = manual_override.
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={closeManualAdd} disabled={saving}>Huỷ</Button>
            <Button onClick={saveManualAdd} disabled={saving || !canEdit}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Plus className="mr-2 h-4 w-4" />}
              Thêm vào Doanh thu đã kiểm soát
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!editingLine} onOpenChange={(open) => { if (!open) closeEdit(); }}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Chỉnh dòng doanh thu</DialogTitle>
            <DialogDescription>
              Staff sửa khi phát hiện dòng sai. Khi lưu, hệ thống cập nhật ledger và ghi audit log.
            </DialogDescription>
          </DialogHeader>
          {editForm ? (
            <div className="grid gap-4 py-2">
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="revenue-date">Ngày doanh thu</Label>
                  <Input id="revenue-date" type="date" value={editForm.revenue_date} onChange={(e) => updateEditField("revenue_date", e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="invoice-no">Invoice no</Label>
                  <Input id="invoice-no" value={editForm.invoice_no} onChange={(e) => updateEditField("invoice_no", e.target.value)} />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="customer-name">Khách hàng</Label>
                  <Input id="customer-name" value={editForm.customer_name} onChange={(e) => updateEditField("customer_name", e.target.value)} />
                </div>
                <div className="space-y-2 md:col-span-2">
                  <Label htmlFor="product-name">Sản phẩm</Label>
                  <Input id="product-name" value={editForm.product_name} onChange={(e) => updateEditField("product_name", e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="quantity">Số lượng</Label>
                  <Input id="quantity" inputMode="decimal" value={editForm.quantity} onChange={(e) => updateEditField("quantity", e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="unit-price">Đơn giá</Label>
                  <Input id="unit-price" inputMode="decimal" value={editForm.unit_price} onChange={(e) => updateEditField("unit_price", e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="gross-revenue">Doanh thu</Label>
                  <Input id="gross-revenue" inputMode="decimal" value={editForm.gross_revenue} onChange={(e) => updateEditField("gross_revenue", e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="item-note">Ghi chú dòng</Label>
                  <Input id="item-note" value={editForm.item_note} onChange={(e) => updateEditField("item_note", e.target.value)} />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="audit-note">Lý do sửa / audit note</Label>
                <Textarea id="audit-note" value={editForm.audit_note} onChange={(e) => updateEditField("audit_note", e.target.value)} placeholder="VD: Sửa số lượng theo nguồn đối soát / PO…" />
              </div>
              <div className="rounded-md border bg-muted/40 p-3 text-xs text-muted-foreground">
                Sau khi lưu: audit_status = adjusted, review_status = resolved, confidence_status = manual_review, reconciliation_status = manual_override. Approval status được giữ nguyên, không có bước approve riêng.
              </div>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={closeEdit} disabled={saving}>Huỷ</Button>
            <Button onClick={saveEdit} disabled={saving || !canEdit}>
              {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Lưu & ghi log
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
