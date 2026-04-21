import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw, CheckCircle, XCircle, AlertTriangle, Eye, TrendingUp, CircleAlert, Factory } from "lucide-react";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, XAxis, YAxis } from "recharts";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ChartContainer, ChartTooltip, ChartTooltipContent } from "@/components/ui/chart";
import { Switch } from "@/components/ui/switch";
import { supabase } from "@/integrations/supabase/client";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { calcTotalFromRawPayload, extractPoNumberFromSubject } from "@/components/mini-crm/poDraftUtils";

// ── helpers ────────────────────────────────────────────────────────────────────

const vnd = (v: number) =>
  new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(v || 0);

const dateOnly = (v?: string | null) => String(v || "").slice(0, 10);

const dateTime = (v?: string | null) => {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString("vi-VN");
};

const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const normalizeChannel = (ch?: string | null) => {
  const k = String(ch || "").trim();
  return k === "wholesale_kfm" ? "cake_kingfoodmart" : k;
};

const inferProductGroupFromRow = (row: any): string => {
  const pg = String(row?.mini_crm_customers?.product_group || "").trim();
  if (pg === "banhngot") return "banhngot";
  const ch = normalizeChannel(row?.revenue_channel);
  if (ch.startsWith("cake_") || ch === "wholesale_kfm") return "banhngot";
  return "banhmi";
};

const calcAmountFromRow = (row: any): number => {
  const posted = Number(row?.raw_payload?.revenue_post?.total || row?.raw_payload?.revenue_post?.amount || 0);
  if (posted > 0) return posted;
  const direct = Number(row?.total_amount || row?.subtotal_amount || 0);
  if (direct > 0) return direct;
  return calcTotalFromRawPayload(row?.raw_payload || {});
};

const getReadableError = (e: any): string => {
  if (!e) return "Không rõ nguyên nhân";
  const parts = [e?.message, e?.details, e?.hint].filter(Boolean);
  if (parts.length) return parts.join(" | ");
  try { return JSON.stringify(e); } catch { return "Không rõ nguyên nhân"; }
};

const DRAFT_STATUS_CONFIG: Record<string, { label: string; variant: "default" | "secondary" | "destructive" | "outline" }> = {
  pending:   { label: "Chờ duyệt", variant: "default" },
  approved:  { label: "Đã duyệt",  variant: "secondary" },
  rejected:  { label: "Từ chối",   variant: "destructive" },
  exception: { label: "Ngoại lệ",  variant: "outline" },
};

const PRODUCT_GROUP_LABEL: Record<string, string> = { banhmi: "Bánh mì", banhngot: "Bánh ngọt" };
const chartConfig = {
  banhmi: { label: "Bánh mì", color: "hsl(var(--chart-1))" },
  banhngot: { label: "Bánh ngọt", color: "hsl(var(--chart-2))" },
} as const;

// ── types ─────────────────────────────────────────────────────────────────────

interface CustomerRow {
  id: string;
  customer_name: string;
  customer_group: string;
  product_group: string;
  is_tier1: boolean;
  is_active: boolean;
  is_npp: boolean;
  supplied_by_npp_customer_id: string | null;
}

interface SyncResult {
  rowsFound: number;
  rowsProcessed: number;
  draftsCreated: number;
  exceptionsCreated: number;
  skipped: number;
}

type ScheduleScopeMode = "all_root_customers" | "single_customer" | "tier1_only";

interface ScheduleRow {
  id: string;
  config_key?: string;
  customer_id: string | null;
  is_enabled: boolean;
  scope_mode: ScheduleScopeMode;
  schedule_mode: "daily";
  run_hour_local: string;
  timezone: string;
  lookback_days: number;
  notes: string | null;
  last_job_id: string | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
  mini_crm_customers?: { customer_name?: string | null } | null;
}

interface SyncJobRow {
  id: string;
  customer_id: string | null;
  status: "pending" | "running" | "done" | "failed";
  date_from: string;
  date_to: string;
  inbox_rows_found: number;
  inbox_rows_processed: number;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
  mini_crm_customers?: { customer_name?: string | null } | null;
}

// ── component ──────────────────────────────────────────────────────────────────

export default function FinanceRevenueControl() {
  const { language } = useLanguage();
  const isVi = language === "vi";
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  // sync form state
  const [syncCustomerId, setSyncCustomerId] = useState<string>("all");
  const [syncDateFrom, setSyncDateFrom] = useState<string>(todayLocal());
  const [syncDateTo, setSyncDateTo] = useState<string>(todayLocal());
  const [syncRunning, setSyncRunning] = useState(false);
  const [syncResult, setSyncResult] = useState<SyncResult | null>(null);
  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleScopeMode, setScheduleScopeMode] = useState<ScheduleScopeMode>("tier1_only");
  const [scheduleCustomerId, setScheduleCustomerId] = useState<string>("all");
  const [scheduleHourLocal, setScheduleHourLocal] = useState<string>("06:00");
  const [scheduleTimezone, setScheduleTimezone] = useState<string>("Asia/Ho_Chi_Minh");
  const [scheduleLookbackDays, setScheduleLookbackDays] = useState<string>("1");
  const [scheduleNotes, setScheduleNotes] = useState<string>("");
  const [scheduleSaving, setScheduleSaving] = useState(false);

  // draft queue state
  const [draftStatusFilter, setDraftStatusFilter] = useState<string>("pending");
  const [draftCustomerFilter, setDraftCustomerFilter] = useState<string>("all");
  const [trendGranularity, setTrendGranularity] = useState<"day" | "month">("day");
  const [selectedDraft, setSelectedDraft] = useState<any | null>(null);
  const [approvingId, setApprovingId] = useState<string | null>(null);
  const [rejectingId, setRejectingId] = useState<string | null>(null);

  // legacy summary state
  const [filterMode, setFilterMode] = useState<"range" | "month">("range");
  const [dateFrom, setDateFrom] = useState<string>(todayLocal());
  const [dateTo, setDateTo] = useState<string>(todayLocal());
  const [selectedMonth, setSelectedMonth] = useState<string>(todayLocal().slice(0, 7));

  // ── queries ────────────────────────────────────────────────────────────────

  const { data: customers = [] } = useQuery<CustomerRow[]>({
    queryKey: ["mini-crm-customers-tier"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("mini_crm_customers")
        .select("id, customer_name, customer_group, product_group, is_tier1, is_active, is_npp, supplied_by_npp_customer_id")
        .eq("is_active", true)
        .is("supplied_by_npp_customer_id", null)
        .order("customer_name", { ascending: true });
      if (error) throw error;
      return (data || []) as CustomerRow[];
    },
  });

  const { data: revenueDrafts = [], isLoading: draftsLoading } = useQuery<any[]>({
    queryKey: ["revenue-drafts"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("revenue_drafts")
        .select("*, mini_crm_customers(customer_name, customer_group, product_group)")
        .order("created_at", { ascending: false })
        .limit(300);
      if (error) throw error;
      return data || [];
    },
  });

  const { data: salesPoDocs = [] } = useQuery<any[]>({
    queryKey: ["sales-po-documents"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("sales_po_documents")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(300);
      if (error) throw error;
      return data || [];
    },
  });

  const { data: inboxEvidenceRows = [] } = useQuery<any[]>({
    queryKey: ["finance-po-inbox-evidence"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("customer_po_inbox")
        .select("id, matched_customer_id, email_subject, from_email, body_preview, received_at, raw_payload, po_number, delivery_date")
        .order("received_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return data || [];
    },
  });

  const { data: linkedProductionOrders = [] } = useQuery<any[]>({
    queryKey: ["linked-production-orders"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("production_orders")
        .select("id, production_number, status, revenue_draft_id")
        .not("revenue_draft_id", "is", null)
        .limit(500);
      if (error) throw error;
      return data || [];
    },
  });

  const { data: postedPoRows = [] } = useQuery<any[]>({
    queryKey: ["finance-posted-po"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("customer_po_inbox")
        .select("id,email_subject,revenue_channel,total_amount,subtotal_amount,vat_amount,delivery_date,received_at,raw_payload,mini_crm_customers(customer_name,customer_group,product_group)")
        .order("received_at", { ascending: false })
        .limit(500);
      if (error) throw error;
      return data || [];
    },
  });

  const { data: automationSchedule, isLoading: scheduleLoading } = useQuery<ScheduleRow | null>({
    queryKey: ["po-sync-schedule-foundation"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("po_sync_schedules")
        .select("*, mini_crm_customers(customer_name)")
        .eq("config_key", "default")
        .maybeSingle();
      if (error) throw error;
      return (data || null) as ScheduleRow | null;
    },
  });

  const { data: recentSyncJobs = [] } = useQuery<SyncJobRow[]>({
    queryKey: ["po-sync-jobs-recent"],
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("po_sync_jobs")
        .select("*, mini_crm_customers(customer_name)")
        .order("created_at", { ascending: false })
        .limit(12);
      if (error) throw error;
      return (data || []) as SyncJobRow[];
    },
  });

  useEffect(() => {
    if (!automationSchedule) return;
    setScheduleEnabled(Boolean(automationSchedule.is_enabled));
    setScheduleScopeMode((automationSchedule.scope_mode || "tier1_only") as ScheduleScopeMode);
    setScheduleCustomerId(automationSchedule.customer_id || "all");
    setScheduleHourLocal(automationSchedule.run_hour_local || "06:00");
    setScheduleTimezone(automationSchedule.timezone || "Asia/Ho_Chi_Minh");
    setScheduleLookbackDays(String(automationSchedule.lookback_days || 1));
    setScheduleNotes(automationSchedule.notes || "");
  }, [automationSchedule]);

  // ── derived ────────────────────────────────────────────────────────────────

  const draftStats = useMemo(() => {
    const counts: Record<string, number> = { pending: 0, approved: 0, rejected: 0, exception: 0 };
    let pendingAmt = 0;
    let approvedAmt = 0;
    for (const d of revenueDrafts) {
      const amt = Number(d.total_amount || 0);
      if (d.status in counts) counts[d.status]++;
      if (d.status === "pending") pendingAmt += amt;
      if (d.status === "approved") approvedAmt += amt;
    }
    return { ...counts, pendingAmt, approvedAmt };
  }, [revenueDrafts]);

  const filteredDrafts = useMemo(
    () => revenueDrafts.filter((d: any) => {
      if (draftStatusFilter !== "all" && d.status !== draftStatusFilter) return false;
      if (draftCustomerFilter !== "all" && d.customer_id !== draftCustomerFilter) return false;
      return true;
    }),
    [revenueDrafts, draftStatusFilter, draftCustomerFilter]
  );

  const exceptionDrafts = useMemo(
    () => revenueDrafts.filter((d: any) => d.status === "exception"),
    [revenueDrafts]
  );

  const approvedDrafts = useMemo(
    () => revenueDrafts.filter((d: any) => d.status === "approved"),
    [revenueDrafts]
  );

  const trendSeries = useMemo(() => {
    const grouped = new Map<string, { date: string; banhmi: number; banhngot: number }>();
    for (const row of approvedDrafts) {
      const rawKey = dateOnly(row.po_order_date || row.delivery_date || row.created_at);
      if (!rawKey) continue;
      const key = trendGranularity === "month" ? rawKey.slice(0, 7) : rawKey;
      const current = grouped.get(key) || { date: key, banhmi: 0, banhngot: 0 };
      const productKey = row.product_group === "banhngot" ? "banhngot" : "banhmi";
      current[productKey] += Number(row.total_amount || 0);
      grouped.set(key, current);
    }
    return Array.from(grouped.values()).sort((a, b) => a.date.localeCompare(b.date));
  }, [approvedDrafts, trendGranularity]);

  const customerBreakdown = useMemo(() => {
    const totals = new Map<string, { customerName: string; total: number }>();
    let grandTotal = 0;
    for (const row of approvedDrafts) {
      const key = row.customer_id || "unknown";
      const amount = Number(row.total_amount || 0);
      grandTotal += amount;
      const current = totals.get(key) || { customerName: row.mini_crm_customers?.customer_name || "Chưa rõ khách hàng", total: 0 };
      current.total += amount;
      totals.set(key, current);
    }
    return Array.from(totals.values())
      .map((row) => ({ ...row, pct: grandTotal > 0 ? (row.total / grandTotal) * 100 : 0 }))
      .sort((a, b) => b.total - a.total);
  }, [approvedDrafts]);

  const automationScopeSummary = useMemo(() => {
    if (scheduleScopeMode === "all_root_customers") {
      return isVi ? "Tất cả NPP / khách hàng gốc" : "All root customers / distributors";
    }
    if (scheduleScopeMode === "single_customer") {
      const customer = customers.find((c) => c.id === scheduleCustomerId);
      return customer?.customer_name || (isVi ? "Chưa chọn khách hàng" : "No customer selected");
    }
    return isVi ? "Chỉ nhóm Tier-1" : "Tier-1 only";
  }, [customers, isVi, scheduleCustomerId, scheduleScopeMode]);

  const latestSyncJob = recentSyncJobs[0] || null;

  const automationStats = useMemo(() => {
    const doneJobs = recentSyncJobs.filter((job) => job.status === "done");
    const runningJobs = recentSyncJobs.filter((job) => job.status === "running").length;
    const failedJobs = recentSyncJobs.filter((job) => job.status === "failed").length;
    const processedRows = recentSyncJobs.reduce((sum, job) => sum + Number(job.inbox_rows_processed || 0), 0);
    return {
      doneJobs: doneJobs.length,
      runningJobs,
      failedJobs,
      processedRows,
    };
  }, [recentSyncJobs]);

  const productionByDraftId = useMemo(
    () => new Map(linkedProductionOrders.map((po: any) => [po.revenue_draft_id as string, po])),
    [linkedProductionOrders]
  );

  const salesDocById = useMemo(() => new Map(salesPoDocs.map((row: any) => [row.id, row])), [salesPoDocs]);
  const inboxById = useMemo(() => new Map(inboxEvidenceRows.map((row: any) => [row.id, row])), [inboxEvidenceRows]);
  const selectedSalesDoc = selectedDraft ? salesDocById.get(selectedDraft.sales_po_doc_id) : null;
  const selectedInboxEvidence = selectedSalesDoc ? inboxById.get(selectedSalesDoc.inbox_row_id) : null;

  // legacy summary derived
  const postedRows = useMemo(
    () => postedPoRows.filter((r: any) => Boolean(r?.raw_payload?.revenue_post?.posted)),
    [postedPoRows]
  );

  const postedRowsFiltered = useMemo(() => postedRows.filter((r: any) => {
    const d =
      dateOnly(r?.raw_payload?.parse_meta?.po_order_date) ||
      dateOnly(r?.raw_payload?.revenue_post?.posted_at) ||
      dateOnly(r.delivery_date);
    if (!d) return false;
    if (filterMode === "month") return d.slice(0, 7) === selectedMonth;
    if (dateFrom && d < dateFrom) return false;
    if (dateTo && d > dateTo) return false;
    return true;
  }), [postedRows, filterMode, selectedMonth, dateFrom, dateTo]);

  const legacyTotals = useMemo(() => {
    let breadTotal = 0;
    let cakeTotal = 0;
    for (const row of postedRowsFiltered) {
      const amt = calcAmountFromRow(row);
      if (inferProductGroupFromRow(row) === "banhngot") cakeTotal += amt;
      else breadTotal += amt;
    }
    return { breadTotal, cakeTotal, grandTotal: breadTotal + cakeTotal };
  }, [postedRowsFiltered]);

  // ── actions ────────────────────────────────────────────────────────────────

  const approveDraft = async (draftId: string) => {
    setApprovingId(draftId);
    const now = new Date().toISOString();

    // Step 1: Mark draft approved
    const { data: approvedData, error: approveError } = await (supabase as any)
      .from("revenue_drafts")
      .update({ status: "approved", approved_by: user?.id || "manual", approved_at: now, updated_at: now })
      .eq("id", draftId)
      .select("id, sales_po_doc_id, customer_id, delivery_date")
      .single();

    if (approveError) {
      setApprovingId(null);
      toast({ title: "Lỗi", description: getReadableError(approveError), variant: "destructive" });
      return;
    }

    // Step 2: Generate or link production order
    type ProdStatus = "created" | "linked" | "error" | "no_doc";
    let prodStatus: ProdStatus = "no_doc";
    let prodNumber = "";

    try {
      if (!approvedData?.sales_po_doc_id) throw new Error("Không có sales_po_doc_id");

      // Fetch sales doc to get inbox_row_id and parsed items
      const { data: salesDoc, error: docErr } = await (supabase as any)
        .from("sales_po_documents")
        .select("id, inbox_row_id, items")
        .eq("id", approvedData.sales_po_doc_id)
        .maybeSingle();

      if (docErr || !salesDoc?.inbox_row_id) throw new Error("Không tìm thấy inbox row từ sales doc");

      const inboxRowId: string = salesDoc.inbox_row_id;

      // Idempotency check: production order already exists for this inbox row?
      const { data: existing } = await (supabase as any)
        .from("production_orders")
        .select("id, production_number, revenue_draft_id, sales_po_doc_id")
        .eq("source_po_inbox_id", inboxRowId)
        .maybeSingle();

      if (existing) {
        // Backfill revenue linkage columns if missing (idempotent)
        const patch: Record<string, string> = {};
        if (!existing.revenue_draft_id) patch.revenue_draft_id = draftId;
        if (!existing.sales_po_doc_id) patch.sales_po_doc_id = approvedData.sales_po_doc_id;
        if (Object.keys(patch).length > 0) {
          await (supabase as any).from("production_orders").update(patch).eq("id", existing.id);
        }
        // Link draft → production order
        await (supabase as any)
          .from("revenue_drafts")
          .update({ production_order_id: existing.id })
          .eq("id", draftId);
        prodStatus = "linked";
        prodNumber = existing.production_number;
      } else {
        // Generate sequential production number via DB function
        const { data: genNum, error: numErr } = await (supabase as any)
          .rpc("generate_production_number", { prefix: "SX" });
        if (numErr) throw numErr;

        const { data: newOrder, error: createErr } = await (supabase as any)
          .from("production_orders")
          .insert({
            production_number: genNum,
            source_po_inbox_id: inboxRowId,
            customer_id: approvedData.customer_id || null,
            status: "draft",
            revenue_draft_id: draftId,
            sales_po_doc_id: approvedData.sales_po_doc_id,
            notes: null,
          })
          .select("id, production_number")
          .single();
        if (createErr) throw createErr;

        // Create production order items from parsed PO items
        const rawItems: any[] = Array.isArray(salesDoc.items) ? salesDoc.items : [];
        if (rawItems.length > 0) {
          const itemRows = rawItems.map((item: any) => ({
            production_order_id: newOrder.id,
            product_name: String(item.product_name || item.name || "Sản phẩm"),
            ordered_qty: Number(item.qty || item.quantity || item.ordered_qty || 0),
            planned_qty: Number(item.qty || item.quantity || item.ordered_qty || 0),
            actual_qty: 0,
            unit: String(item.unit || "kg"),
            delivery_date: approvedData.delivery_date || null,
          }));
          await (supabase as any).from("production_order_items").insert(itemRows);
        }

        // Link draft → production order
        await (supabase as any)
          .from("revenue_drafts")
          .update({ production_order_id: newOrder.id })
          .eq("id", draftId);

        prodStatus = "created";
        prodNumber = newOrder.production_number;
      }
    } catch (err: any) {
      console.error("[Phase4] production order error", err);
      prodStatus = "error";
    }

    setApprovingId(null);
    queryClient.invalidateQueries({ queryKey: ["revenue-drafts"] });
    queryClient.invalidateQueries({ queryKey: ["sales-po-documents"] });
    queryClient.invalidateQueries({ queryKey: ["finance-po-inbox-evidence"] });
    queryClient.invalidateQueries({ queryKey: ["linked-production-orders"] });
    queryClient.invalidateQueries({ queryKey: ["production-orders"] });
    queryClient.invalidateQueries({ queryKey: ["pending-pos"] });

    if (prodStatus === "created") {
      toast({ title: "Đã duyệt — Tạo lệnh SX thành công", description: `Lệnh sản xuất ${prodNumber} đã được tạo tự động.` });
    } else if (prodStatus === "linked") {
      toast({ title: "Đã duyệt — Liên kết lệnh SX hiện có", description: `Đã liên kết với lệnh sản xuất ${prodNumber}.` });
    } else if (prodStatus === "error") {
      toast({ title: "Đã duyệt — Lỗi tạo lệnh SX", description: "Draft đã duyệt nhưng không tạo được lệnh sản xuất. Vui lòng tạo thủ công trên trang Sản xuất.", variant: "destructive" });
    } else {
      toast({ title: "Đã duyệt", description: "Không tìm thấy sales doc để tạo lệnh sản xuất." });
    }
  };

  const rejectDraft = async (draftId: string) => {
    setRejectingId(draftId);
    const now = new Date().toISOString();
    const { error } = await (supabase as any)
      .from("revenue_drafts")
      .update({ status: "rejected", rejected_by: user?.id || "manual", rejected_at: now, updated_at: now })
      .eq("id", draftId);
    setRejectingId(null);
    if (error) { toast({ title: "Lỗi", description: getReadableError(error), variant: "destructive" }); return; }
    queryClient.invalidateQueries({ queryKey: ["revenue-drafts"] });
    queryClient.invalidateQueries({ queryKey: ["sales-po-documents"] });
    queryClient.invalidateQueries({ queryKey: ["finance-po-inbox-evidence"] });
  };

  const toggleTier1 = async (customerId: string, current: boolean) => {
    const { error } = await (supabase as any)
      .from("mini_crm_customers")
      .update({ is_tier1: !current })
      .eq("id", customerId);
    if (error) { toast({ title: "Lỗi", description: getReadableError(error), variant: "destructive" }); return; }
    queryClient.invalidateQueries({ queryKey: ["mini-crm-customers-tier"] });
  };

  const saveAutomationSchedule = async () => {
    if (scheduleScopeMode === "single_customer" && scheduleCustomerId === "all") {
      toast({ title: isVi ? "Thiếu khách hàng" : "Missing customer", description: isVi ? "Vui lòng chọn một NPP / khách hàng gốc cụ thể." : "Please choose a specific root customer / distributor.", variant: "destructive" });
      return;
    }

    const parsedLookback = Number(scheduleLookbackDays || 1);
    if (!Number.isFinite(parsedLookback)) {
      toast({ title: isVi ? "Lookback không hợp lệ" : "Invalid lookback", description: isVi ? "Vui lòng nhập số ngày hợp lệ từ 1 đến 30." : "Please enter a valid lookback day count between 1 and 30.", variant: "destructive" });
      return;
    }

    const lookback = Math.max(1, Math.min(30, parsedLookback));
    setScheduleSaving(true);
    try {
      const payload = {
        config_key: "default",
        customer_id: scheduleScopeMode === "single_customer" ? scheduleCustomerId : null,
        is_enabled: scheduleEnabled,
        scope_mode: scheduleScopeMode,
        schedule_mode: "daily",
        run_hour_local: scheduleHourLocal || "06:00",
        timezone: scheduleTimezone || "Asia/Ho_Chi_Minh",
        lookback_days: lookback,
        notes: scheduleNotes.trim() || null,
        updated_by: user?.id || "manual",
        created_by: automationSchedule ? undefined : (user?.id || "manual"),
        updated_at: new Date().toISOString(),
      };

      const { error } = await (supabase as any)
        .from("po_sync_schedules")
        .upsert(payload, { onConflict: "config_key" });
      if (error) throw error;

      await queryClient.invalidateQueries({ queryKey: ["po-sync-schedule-foundation"] });
      await queryClient.invalidateQueries({ queryKey: ["po-sync-jobs-recent"] });
      toast({
        title: isVi ? "Đã lưu cấu hình automation" : "Automation settings saved",
        description: isVi
          ? "Đã lưu foundation cho Phase 5A. Cron thực tế sẽ nối ở slice tiếp theo."
          : "Phase 5A foundation saved. Actual cron execution will be wired in the next slice.",
      });
    } catch (err) {
      toast({ title: isVi ? "Lỗi lưu cấu hình" : "Failed to save schedule", description: getReadableError(err), variant: "destructive" });
    } finally {
      setScheduleSaving(false);
    }
  };

  const runManualSync = async () => {
    if (!syncDateFrom || !syncDateTo) {
      toast({ title: "Thiếu thông tin", description: "Vui lòng chọn khoảng ngày.", variant: "destructive" });
      return;
    }
    setSyncRunning(true);
    setSyncResult(null);
    try {
      // 1. Create sync job record
      const { data: job, error: jobErr } = await (supabase as any)
        .from("po_sync_jobs")
        .insert({
          customer_id: syncCustomerId === "all" ? null : syncCustomerId,
          date_from: syncDateFrom,
          date_to: syncDateTo,
          status: "running",
          triggered_by: user?.id || "manual",
        })
        .select()
        .single();
      if (jobErr) throw jobErr;

      // 2. Query inbox rows in range
      let q = (supabase as any)
        .from("customer_po_inbox")
        .select("*, mini_crm_customers(id, customer_name, product_group, is_tier1)")
        .gte("received_at", `${syncDateFrom}T00:00:00.000Z`)
        .lte("received_at", `${syncDateTo}T23:59:59.999Z`)
        .order("received_at", { ascending: false })
        .limit(200);
      if (syncCustomerId !== "all") q = q.eq("matched_customer_id", syncCustomerId);
      const { data: inboxRows, error: inboxErr } = await q;
      if (inboxErr) throw inboxErr;
      const rows: any[] = inboxRows || [];

      // 3. Find already-processed inbox rows (idempotency)
      const ids: string[] = rows.map((r: any) => r.id);
      const safeIds = ids.length ? ids : ["00000000-0000-0000-0000-000000000000"];
      const { data: existingDocs } = await (supabase as any)
        .from("sales_po_documents")
        .select("inbox_row_id")
        .in("inbox_row_id", safeIds);
      const existingSet = new Set<string>((existingDocs || []).map((d: any) => d.inbox_row_id as string));

      // 4. Prefetch KB profiles for customers in this batch
      const customerIds = [...new Set<string>(rows.map((r: any) => r.matched_customer_id).filter(Boolean) as string[])];
      const safeCustomerIds = customerIds.length ? customerIds : ["00000000-0000-0000-0000-000000000000"];
      const { data: kbProfiles } = await (supabase as any)
        .from("mini_crm_knowledge_profiles")
        .select("id, customer_id")
        .in("customer_id", safeCustomerIds);
      const kbByCustomer = new Map<string, string>(
        (kbProfiles || []).map((kb: any) => [kb.customer_id as string, kb.id as string])
      );

      // 5. Process each inbox row
      let draftsCreated = 0;
      let exceptionsCreated = 0;
      let skipped = 0;
      let processed = 0;

      for (const row of rows) {
        if (existingSet.has(row.id)) { skipped++; continue; }

        const isTier1 = Boolean(row.mini_crm_customers?.is_tier1);
        const amount = calcAmountFromRow(row);
        const productGroup = String(row.mini_crm_customers?.product_group || inferProductGroupFromRow(row));
        const resolvedCustomerId: string | null = row.matched_customer_id || null;
        const kbProfileId: string | null = resolvedCustomerId ? (kbByCustomer.get(resolvedCustomerId) ?? null) : null;

        try {
          // Create parse run
          const { data: parseRun } = await (supabase as any)
            .from("po_parse_runs")
            .insert({
              sync_job_id: job.id,
              inbox_row_id: row.id,
              customer_id: resolvedCustomerId,
              status: isTier1 ? "ok" : "exception",
              outcome: isTier1 ? "draft_created" : "exception_non_tier1",
              kb_profile_id: kbProfileId,
              parse_source: row.raw_payload?.parse_meta?.source || "auto",
              parsed_item_count: Array.isArray(row.production_items) ? row.production_items.length : 0,
            })
            .select()
            .single();

          // Create canonical sales PO document
          const { data: doc } = await (supabase as any)
            .from("sales_po_documents")
            .insert({
              inbox_row_id: row.id,
              customer_id: resolvedCustomerId,
              sync_job_id: job.id,
              parse_run_id: parseRun?.id || null,
              po_number: row.po_number || extractPoNumberFromSubject(row.email_subject) || null,
              po_order_date: row.raw_payload?.parse_meta?.po_order_date || null,
              delivery_date: row.delivery_date || null,
              subtotal_amount: Number(row.subtotal_amount || row.raw_payload?.parse_meta?.subtotal || 0),
              vat_amount: Number(row.vat_amount ?? row.raw_payload?.parse_meta?.vat_amount ?? 0),
              total_amount: amount,
              revenue_channel: row.revenue_channel || null,
              parse_source: row.raw_payload?.parse_meta?.source || "auto",
              items: row.production_items || row.raw_payload?.parsed_items_preview || [],
              kb_profile_id: kbProfileId,
              status: isTier1 ? "pending_review" : "exception",
              exception_reason: isTier1 ? null : "Khách hàng chưa được phân loại Tier-1",
            })
            .select()
            .single();

          // Create revenue draft
          await (supabase as any)
            .from("revenue_drafts")
            .insert({
              sales_po_doc_id: doc.id,
              customer_id: resolvedCustomerId,
              sync_job_id: job.id,
              po_number: row.po_number || extractPoNumberFromSubject(row.email_subject) || null,
              po_order_date: row.raw_payload?.parse_meta?.po_order_date || null,
              delivery_date: row.delivery_date || null,
              subtotal_amount: Number(row.subtotal_amount || row.raw_payload?.parse_meta?.subtotal || 0),
              vat_amount: Number(row.vat_amount ?? row.raw_payload?.parse_meta?.vat_amount ?? 0),
              total_amount: amount,
              revenue_channel: row.revenue_channel || null,
              product_group: productGroup,
              status: isTier1 ? "pending" : "exception",
              exception_reason: isTier1 ? null : "Khách hàng chưa được phân loại Tier-1",
            });

          if (isTier1) draftsCreated++;
          else exceptionsCreated++;
          processed++;
        } catch (rowErr) {
          console.error("[Phase2 sync] row error", row.id, rowErr);
        }
      }

      // 6. Mark sync job complete
      await (supabase as any)
        .from("po_sync_jobs")
        .update({
          status: "done",
          inbox_rows_found: rows.length,
          inbox_rows_processed: processed,
          completed_at: new Date().toISOString(),
        })
        .eq("id", job.id);

      const result: SyncResult = { rowsFound: rows.length, rowsProcessed: processed, draftsCreated, exceptionsCreated, skipped };
      setSyncResult(result);
      queryClient.invalidateQueries({ queryKey: ["revenue-drafts"] });
    queryClient.invalidateQueries({ queryKey: ["sales-po-documents"] });
    queryClient.invalidateQueries({ queryKey: ["finance-po-inbox-evidence"] });
      toast({
        title: "Đồng bộ hoàn tất",
        description: `${draftsCreated} draft Tier-1 • ${exceptionsCreated} ngoại lệ • ${skipped} đã bỏ qua`,
      });
    } catch (err) {
      toast({ title: "Lỗi đồng bộ", description: getReadableError(err), variant: "destructive" });
      // Best-effort: mark job failed if we have a job id
    } finally {
      setSyncRunning(false);
    }
  };

  // ── render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-display font-bold">
          {isVi ? "Kiểm soát doanh thu" : "Revenue control"}
        </h1>
        <p className="text-muted-foreground">
          {isVi
            ? "Xét duyệt hàng đợi doanh thu và tóm tắt theo nhóm sản phẩm."
            : "Approve the revenue draft queue and view revenue summaries by product group."}
        </p>
      </div>

      <Tabs defaultValue="automation">
        <TabsList>
          <TabsTrigger value="automation">{isVi ? "Automation" : "Automation"}</TabsTrigger>
          <TabsTrigger value="queue">{isVi ? "Hàng đợi draft" : "Draft queue"}</TabsTrigger>
          <TabsTrigger value="exceptions">{isVi ? "Hàng đợi ngoại lệ" : "Exception queue"}</TabsTrigger>
          <TabsTrigger value="analytics">{isVi ? "Dashboard & graph" : "Dashboard & graph"}</TabsTrigger>
          <TabsTrigger value="summary">{isVi ? "Tóm tắt" : "Summary"}</TabsTrigger>
          <TabsTrigger value="tier">{isVi ? "Cài đặt Tier" : "Tier settings"}</TabsTrigger>
        </TabsList>

        <TabsContent value="automation" className="space-y-4 mt-4">
          <div className="grid gap-3 grid-cols-2 xl:grid-cols-4">
            <Card>
              <CardContent className="p-4 space-y-1">
                <div className="text-xs text-muted-foreground">{isVi ? "Automation" : "Automation"}</div>
                <div className="text-xl font-semibold">{scheduleEnabled ? (isVi ? "Đang bật" : "Enabled") : (isVi ? "Đang tắt" : "Disabled")}</div>
                <div className="text-xs text-muted-foreground">{automationScopeSummary}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 space-y-1">
                <div className="text-xs text-muted-foreground">{isVi ? "Lần chạy gần nhất" : "Last run"}</div>
                <div className="text-xl font-semibold">{automationSchedule?.last_run_at ? dateTime(automationSchedule.last_run_at) : "—"}</div>
                <div className="text-xs text-muted-foreground">{latestSyncJob ? `${isVi ? "Job gần nhất" : "Latest job"}: ${latestSyncJob.status}` : (isVi ? "Chưa có job nào" : "No jobs yet")}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 space-y-1">
                <div className="text-xs text-muted-foreground">{isVi ? "Recent jobs" : "Recent jobs"}</div>
                <div className="text-xl font-semibold">{automationStats.doneJobs}</div>
                <div className="text-xs text-muted-foreground">{automationStats.runningJobs} {isVi ? "đang chạy" : "running"} • {automationStats.failedJobs} {isVi ? "thất bại" : "failed"}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4 space-y-1">
                <div className="text-xs text-muted-foreground">{isVi ? "PO đã xử lý gần đây" : "Recently processed PO rows"}</div>
                <div className="text-xl font-semibold">{automationStats.processedRows}</div>
                <div className="text-xs text-muted-foreground">{isVi ? `Lookback ${scheduleLookbackDays || 1} ngày` : `${scheduleLookbackDays || 1}-day lookback`}</div>
              </CardContent>
            </Card>
          </div>

          <div className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
            <Card>
              <CardHeader>
                <CardTitle>{isVi ? "Cấu hình sync tự động" : "Automation sync configuration"}</CardTitle>
                <CardDescription>
                  {isVi
                    ? "Phase 5A chỉ lưu foundation cấu hình + monitoring. Chưa nối cron thật trong slice này."
                    : "Phase 5A stores configuration and monitoring only. Actual cron execution is intentionally deferred."}
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex items-center justify-between rounded-lg border p-4">
                  <div className="space-y-1">
                    <div className="font-medium">{isVi ? "Bật automation" : "Enable automation"}</div>
                    <div className="text-sm text-muted-foreground">{isVi ? "Cho phép hệ thống dùng cấu hình này ở slice cron tiếp theo." : "Allows the next cron slice to use this saved configuration."}</div>
                  </div>
                  <Switch checked={scheduleEnabled} onCheckedChange={setScheduleEnabled} />
                </div>

                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <Label>{isVi ? "Phạm vi chạy" : "Scope"}</Label>
                    <select className="mt-1 w-full h-10 rounded-md border bg-background px-3 text-sm" value={scheduleScopeMode} onChange={(e) => setScheduleScopeMode(e.target.value as ScheduleScopeMode)}>
                      <option value="tier1_only">{isVi ? "Chỉ Tier-1" : "Tier-1 only"}</option>
                      <option value="all_root_customers">{isVi ? "Tất cả NPP / khách hàng gốc" : "All root customers / distributors"}</option>
                      <option value="single_customer">{isVi ? "Một NPP / khách hàng gốc cụ thể" : "Single root customer / distributor"}</option>
                    </select>
                  </div>
                  <div>
                    <Label>{isVi ? "Giờ chạy mỗi ngày" : "Run time"}</Label>
                    <Input type="time" value={scheduleHourLocal} onChange={(e) => setScheduleHourLocal(e.target.value)} />
                  </div>
                </div>

                {scheduleScopeMode === "single_customer" && (
                  <div>
                    <Label>{isVi ? "NPP / Khách hàng gốc" : "Root customer / distributor"}</Label>
                    <select className="mt-1 w-full h-10 rounded-md border bg-background px-3 text-sm" value={scheduleCustomerId} onChange={(e) => setScheduleCustomerId(e.target.value)}>
                      <option value="all">{isVi ? "Chọn một NPP / khách hàng gốc" : "Choose one root customer / distributor"}</option>
                      {customers.map((c) => (
                        <option key={c.id} value={c.id}>{c.customer_name}{c.is_tier1 ? " ★" : ""}</option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="grid gap-4 md:grid-cols-2">
                  <div>
                    <Label>{isVi ? "Timezone" : "Timezone"}</Label>
                    <Input value={scheduleTimezone} onChange={(e) => setScheduleTimezone(e.target.value)} placeholder="Asia/Ho_Chi_Minh" />
                  </div>
                  <div>
                    <Label>{isVi ? "Lookback (ngày)" : "Lookback (days)"}</Label>
                    <Input type="number" min={1} max={30} value={scheduleLookbackDays} onChange={(e) => setScheduleLookbackDays(e.target.value)} />
                  </div>
                </div>

                <div>
                  <Label>{isVi ? "Ghi chú vận hành" : "Ops notes"}</Label>
                  <textarea
                    className="mt-1 min-h-[96px] w-full rounded-md border bg-background px-3 py-2 text-sm"
                    value={scheduleNotes}
                    onChange={(e) => setScheduleNotes(e.target.value)}
                    placeholder={isVi ? "Ví dụ: chạy backlog sáng sớm cho nhóm Tier-1, accountant review lúc 8h." : "Example: early-morning backlog sync for Tier-1 before accounting review."}
                  />
                </div>

                <div className="flex items-center justify-between gap-3 rounded-lg bg-muted/50 p-3 text-sm">
                  <div>
                    <div className="font-medium">{isVi ? "Snapshot hiện tại" : "Current snapshot"}</div>
                    <div className="text-muted-foreground">{automationSchedule?.updated_at ? `${isVi ? "Lưu lần cuối" : "Last saved"}: ${dateTime(automationSchedule.updated_at)}` : (isVi ? "Chưa có cấu hình nào được lưu." : "No saved schedule yet.")}</div>
                  </div>
                  <Button onClick={saveAutomationSchedule} disabled={scheduleSaving || scheduleLoading}>
                    {scheduleSaving
                      ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />{isVi ? "Đang lưu..." : "Saving..."}</>
                      : isVi ? "Lưu foundation" : "Save foundation"}
                  </Button>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{isVi ? "Recent sync jobs" : "Recent sync jobs"}</CardTitle>
                <CardDescription>{isVi ? "Dùng po_sync_jobs hiện có để theo dõi sức khỏe pipeline trước khi nối cron thật." : "Uses existing po_sync_jobs as the monitoring surface before wiring real cron execution."}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {recentSyncJobs.length === 0 ? (
                  <div className="rounded-md border border-dashed p-6 text-sm text-muted-foreground text-center">
                    {isVi ? "Chưa có sync job nào để theo dõi." : "No sync jobs available yet."}
                  </div>
                ) : (
                  recentSyncJobs.map((job) => (
                    <div key={job.id} className="rounded-lg border p-3 space-y-2">
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <div className="font-medium">{job.mini_crm_customers?.customer_name || (isVi ? "Tất cả phạm vi" : "All scope")}</div>
                          <div className="text-xs text-muted-foreground">{dateOnly(job.date_from)} → {dateOnly(job.date_to)}</div>
                        </div>
                        <Badge variant={job.status === "failed" ? "destructive" : job.status === "running" ? "default" : job.status === "done" ? "secondary" : "outline"}>{job.status}</Badge>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
                        <div>{isVi ? "Tìm thấy" : "Found"}: <span className="font-medium text-foreground">{job.inbox_rows_found || 0}</span></div>
                        <div>{isVi ? "Đã xử lý" : "Processed"}: <span className="font-medium text-foreground">{job.inbox_rows_processed || 0}</span></div>
                        <div>{isVi ? "Tạo lúc" : "Created"}: <span className="text-foreground">{dateTime(job.created_at)}</span></div>
                        <div>{isVi ? "Hoàn tất" : "Completed"}: <span className="text-foreground">{dateTime(job.completed_at)}</span></div>
                      </div>
                      {job.error_message && <div className="text-xs text-red-600 break-words">{job.error_message}</div>}
                    </div>
                  ))
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ── TAB 1: Draft Queue ─────────────────────────────────────────────── */}
        <TabsContent value="queue" className="space-y-4 mt-4">

          {/* Manual Sync Card */}
          <Card>
            <CardHeader>
              <CardTitle>{isVi ? "Đồng bộ doanh thu NPP" : "NPP revenue sync"}</CardTitle>
              <CardDescription>
                {isVi
                  ? "Chọn NPP hoặc khách hàng gốc để đồng bộ PO và KB đã chốt. Hệ thống tự tạo draft doanh thu cho nhóm ưu tiên (★); các khách hàng gốc còn lại sẽ vào hàng đợi duyệt thủ công."
                  : "Choose the root customer or distributor to sync finalized PO + KB. Priority customers (★) create revenue drafts automatically; other root customers go to manual review."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
                <div>
                  <Label>{isVi ? "NPP / Khách hàng gốc" : "Root customer / distributor"}</Label>
                  <select
                    className="mt-1 w-full h-10 rounded-md border bg-background px-3 text-sm"
                    value={syncCustomerId}
                    onChange={(e) => setSyncCustomerId(e.target.value)}
                  >
                    <option value="all">{isVi ? "Tất cả NPP / khách hàng gốc" : "All root customers / distributors"}</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.customer_name}{c.is_tier1 ? " ★" : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label>{isVi ? "Từ ngày" : "From"}</Label>
                  <Input type="date" value={syncDateFrom} onChange={(e) => setSyncDateFrom(e.target.value)} />
                </div>
                <div>
                  <Label>{isVi ? "Đến ngày" : "To"}</Label>
                  <Input type="date" value={syncDateTo} onChange={(e) => setSyncDateTo(e.target.value)} />
                </div>
                <div>
                  <Button onClick={runManualSync} disabled={syncRunning} className="w-full">
                    {syncRunning
                      ? <><Loader2 className="mr-2 h-4 w-4 animate-spin" />{isVi ? "Đang chạy..." : "Running..."}</>
                      : <><RefreshCw className="mr-2 h-4 w-4" />{isVi ? "Chạy đồng bộ" : "Run sync"}</>}
                  </Button>
                </div>
              </div>

              {syncResult && (
                <div className="rounded-md bg-muted px-4 py-2 text-sm">
                  {isVi ? "Tìm thấy" : "Found"}{" "}
                  <strong>{syncResult.rowsFound}</strong> PO •{" "}
                  <strong className="text-green-700">{syncResult.draftsCreated}</strong>{" "}
                  {isVi ? "draft Tier-1" : "Tier-1 drafts"} •{" "}
                  <strong className="text-amber-600">{syncResult.exceptionsCreated}</strong>{" "}
                  {isVi ? "ngoại lệ" : "exceptions"} •{" "}
                  <strong>{syncResult.skipped}</strong>{" "}
                  {isVi ? "đã bỏ qua" : "skipped"}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Dashboard cards cho queue */}
          <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
            {(
              [
                { key: "pending", label: isVi ? "Chờ duyệt" : "Pending", amtKey: "pendingAmt", color: "text-blue-600", icon: Loader2 },
                { key: "approved", label: isVi ? "Đã duyệt" : "Approved", amtKey: "approvedAmt", color: "text-green-600", icon: CheckCircle },
                { key: "rejected", label: isVi ? "Từ chối" : "Rejected", amtKey: null, color: "text-red-600", icon: XCircle },
                { key: "exception", label: isVi ? "Ngoại lệ" : "Exceptions", amtKey: null, color: "text-amber-600", icon: CircleAlert },
              ] as const
            ).map(({ key, label, amtKey, color, icon: Icon }) => (
              <Card
                key={key}
                className={`cursor-pointer transition-colors hover:bg-muted/50 ${draftStatusFilter === key ? "ring-2 ring-primary" : ""}`}
                onClick={() => setDraftStatusFilter(key)}
              >
                <CardContent className="p-4 space-y-2">
                  <div className="flex items-center justify-between">
                    <div className={`text-xs font-medium ${color}`}>{label}</div>
                    <Icon className={`h-4 w-4 ${color}`} />
                  </div>
                  <div className="text-2xl font-bold">{draftStats[key] || 0}</div>
                  {amtKey && draftStats[amtKey] > 0 && (
                    <div className="text-xs text-muted-foreground">{vnd(draftStats[amtKey])}</div>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>

          {/* Draft queue table */}
          <Card>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div>
                  <CardTitle>{isVi ? "Danh sách draft doanh thu" : "Revenue drafts"}</CardTitle>
                  <CardDescription>
                    {isVi ? "Ưu tiên xử lý draft pending, dùng bộ lọc customer/status và xem chi tiết provenance trước khi approve." : "Operate pending drafts using status/customer filters and provenance detail before approval."}
                  </CardDescription>
                </div>
                <div className="flex gap-2 flex-wrap">
                  <select
                    className="h-8 rounded-md border bg-background px-2 text-sm"
                    value={draftStatusFilter}
                    onChange={(e) => setDraftStatusFilter(e.target.value)}
                  >
                    <option value="all">{isVi ? "Tất cả trạng thái" : "All statuses"}</option>
                    <option value="pending">{isVi ? "Chờ duyệt" : "Pending"} ({draftStats.pending || 0})</option>
                    <option value="approved">{isVi ? "Đã duyệt" : "Approved"} ({draftStats.approved || 0})</option>
                    <option value="rejected">{isVi ? "Từ chối" : "Rejected"} ({draftStats.rejected || 0})</option>
                    <option value="exception">{isVi ? "Ngoại lệ" : "Exception"} ({draftStats.exception || 0})</option>
                  </select>
                  <select
                    className="h-8 rounded-md border bg-background px-2 text-sm"
                    value={draftCustomerFilter}
                    onChange={(e) => setDraftCustomerFilter(e.target.value)}
                  >
                    <option value="all">{isVi ? "Tất cả khách hàng" : "All customers"}</option>
                    {customers.map((c) => (
                      <option key={c.id} value={c.id}>{c.customer_name}</option>
                    ))}
                  </select>
                </div>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {draftsLoading ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{isVi ? "Khách hàng" : "Customer"}</TableHead>
                      <TableHead>{isVi ? "PO số" : "PO #"}</TableHead>
                      <TableHead>{isVi ? "Ngày PO" : "PO date"}</TableHead>
                      <TableHead>{isVi ? "Nhóm SP" : "Group"}</TableHead>
                      <TableHead>{isVi ? "Kênh" : "Channel"}</TableHead>
                      <TableHead className="text-right">{isVi ? "Doanh thu" : "Amount"}</TableHead>
                      <TableHead>{isVi ? "Trạng thái" : "Status"}</TableHead>
                      <TableHead>{isVi ? "Chi tiết" : "Detail"}</TableHead>
                      <TableHead>{isVi ? "Hành động" : "Action"}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredDrafts.map((d: any) => {
                      const cfg = DRAFT_STATUS_CONFIG[d.status] ?? DRAFT_STATUS_CONFIG.pending;
                      const isActing = approvingId === d.id || rejectingId === d.id;
                      return (
                        <TableRow key={d.id}>
                          <TableCell className="font-medium">{d.mini_crm_customers?.customer_name || "—"}</TableCell>
                          <TableCell className="text-xs font-mono">{d.po_number || "—"}</TableCell>
                          <TableCell className="text-xs">{dateOnly(d.po_order_date) || dateOnly(d.delivery_date) || "—"}</TableCell>
                          <TableCell>{PRODUCT_GROUP_LABEL[d.product_group] || d.product_group || "—"}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{d.revenue_channel || "—"}</TableCell>
                          <TableCell className="text-right font-medium">{vnd(Number(d.total_amount || 0))}</TableCell>
                          <TableCell>
                            <Badge variant={cfg.variant}>{cfg.label}</Badge>
                            {d.exception_reason && <div className="text-xs text-muted-foreground mt-1 max-w-[180px] truncate" title={d.exception_reason}>{d.exception_reason}</div>}
                          </TableCell>
                          <TableCell>
                            <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setSelectedDraft(d)}>
                              <Eye className="h-3.5 w-3.5 mr-1" />{isVi ? "Xem" : "View"}
                            </Button>
                          </TableCell>
                          <TableCell>
                            {d.status === "pending" ? (
                              <div className="flex gap-1">
                                <Button size="sm" variant="outline" className="h-7 w-7 p-0 text-green-700 border-green-300 hover:bg-green-50" disabled={isActing} title={isVi ? "Duyệt → tạo lệnh SX" : "Approve → create production order"} onClick={() => approveDraft(d.id)}>
                                  {approvingId === d.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle className="h-3 w-3" />}
                                </Button>
                                <Button size="sm" variant="outline" className="h-7 w-7 p-0 text-red-700 border-red-300 hover:bg-red-50" disabled={isActing} title={isVi ? "Từ chối" : "Reject"} onClick={() => rejectDraft(d.id)}>
                                  {rejectingId === d.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <XCircle className="h-3 w-3" />}
                                </Button>
                              </div>
                            ) : d.status === "exception" ? (
                              <AlertTriangle className="h-4 w-4 text-amber-500" />
                            ) : d.status === "approved" ? (
                              (() => {
                                const linked = productionByDraftId.get(d.id);
                                if (linked) {
                                  return (
                                    <Badge variant="secondary" className="text-xs font-mono gap-1 whitespace-nowrap">
                                      <Factory className="h-3 w-3" />{linked.production_number}
                                    </Badge>
                                  );
                                }
                                return <span className="text-xs text-muted-foreground">—</span>;
                              })()
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                    {filteredDrafts.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                          {isVi ? "Không có draft nào khớp bộ lọc." : "No drafts match the current filter."}
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── TAB 2: Exception Queue ────────────────────────────────────────────── */}
        <TabsContent value="exceptions" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle>{isVi ? "Hàng đợi ngoại lệ" : "Exception queue"}</CardTitle>
              <CardDescription>
                {isVi ? "Tập trung các draft chưa đủ điều kiện tự động: non-Tier-1, thiếu mapping, hoặc cần soát lại trước khi accounting quyết định." : "Centralized queue for non-Tier-1 and other exception cases requiring manual review."}
              </CardDescription>
            </CardHeader>
            <CardContent className="p-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{isVi ? "Khách hàng" : "Customer"}</TableHead>
                    <TableHead>{isVi ? "PO số" : "PO #"}</TableHead>
                    <TableHead>{isVi ? "Ngày nhận" : "Received"}</TableHead>
                    <TableHead>{isVi ? "Lý do" : "Reason"}</TableHead>
                    <TableHead className="text-right">{isVi ? "Giá trị" : "Amount"}</TableHead>
                    <TableHead>{isVi ? "Chi tiết" : "Detail"}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {exceptionDrafts.map((d: any) => {
                    const doc = salesDocById.get(d.sales_po_doc_id);
                    const inbox = doc ? inboxById.get(doc.inbox_row_id) : null;
                    return (
                      <TableRow key={d.id}>
                        <TableCell className="font-medium">{d.mini_crm_customers?.customer_name || "—"}</TableCell>
                        <TableCell className="text-xs font-mono">{d.po_number || "—"}</TableCell>
                        <TableCell className="text-xs">{dateOnly(inbox?.received_at || d.created_at) || "—"}</TableCell>
                        <TableCell>
                          <div className="max-w-[280px] text-sm">{d.exception_reason || doc?.exception_reason || (isVi ? "Chưa có lý do chi tiết" : "No detailed reason")}</div>
                        </TableCell>
                        <TableCell className="text-right font-medium">{vnd(Number(d.total_amount || 0))}</TableCell>
                        <TableCell>
                          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setSelectedDraft(d)}>
                            <Eye className="h-3.5 w-3.5 mr-1" />{isVi ? "Xem" : "View"}
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {exceptionDrafts.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                        {isVi ? "Chưa có ngoại lệ nào." : "No exception rows yet."}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── TAB 3: Analytics ──────────────────────────────────────────────────── */}
        <TabsContent value="analytics" className="space-y-4 mt-4">
          <div className="grid gap-4 lg:grid-cols-[1.4fr_0.8fr]">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div>
                    <CardTitle>{isVi ? "Xu hướng doanh thu đã duyệt" : "Approved revenue trend"}</CardTitle>
                    <CardDescription>{isVi ? "Theo ngày hoặc theo tháng, tách theo nhóm sản phẩm." : "Daily or monthly approved revenue by product group."}</CardDescription>
                  </div>
                  <select className="h-8 rounded-md border bg-background px-2 text-sm" value={trendGranularity} onChange={(e) => setTrendGranularity(e.target.value as "day" | "month")}>
                    <option value="day">{isVi ? "Theo ngày" : "By day"}</option>
                    <option value="month">{isVi ? "Theo tháng" : "By month"}</option>
                  </select>
                </div>
              </CardHeader>
              <CardContent>
                <ChartContainer config={chartConfig} className="h-[320px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={trendSeries}>
                      <CartesianGrid vertical={false} />
                      <XAxis dataKey="date" tickLine={false} axisLine={false} />
                      <YAxis tickFormatter={(value) => `${Math.round(Number(value) / 1000000)}M`} tickLine={false} axisLine={false} />
                      <ChartTooltip content={<ChartTooltipContent />} />
                      <Legend />
                      <Bar dataKey="banhmi" stackId="approved" fill="var(--color-banhmi)" radius={[4, 4, 0, 0]} />
                      <Bar dataKey="banhngot" stackId="approved" fill="var(--color-banhngot)" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </ChartContainer>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{isVi ? "Top khách hàng đã duyệt" : "Top approved customers"}</CardTitle>
                <CardDescription>{isVi ? "Xếp hạng theo tổng approved revenue hiện có trong queue phase 2/3." : "Ranked by approved revenue from current draft records."}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {customerBreakdown.slice(0, 8).map((row) => (
                  <div key={row.customerName} className="space-y-1">
                    <div className="flex items-center justify-between gap-3 text-sm">
                      <span className="truncate">{row.customerName}</span>
                      <span className="font-medium">{vnd(row.total)}</span>
                    </div>
                    <div className="h-2 rounded-full bg-muted overflow-hidden">
                      <div className="h-full bg-primary" style={{ width: `${Math.min(row.pct, 100)}%` }} />
                    </div>
                    <div className="text-xs text-muted-foreground">{row.pct.toFixed(1)}%</div>
                  </div>
                ))}
                {customerBreakdown.length === 0 && (
                  <div className="text-sm text-muted-foreground py-8 text-center">{isVi ? "Chưa có approved draft để vẽ breakdown." : "No approved drafts yet."}</div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* ── TAB 4: Legacy Revenue Summary (preserved) ────────────────────────── */}
        <TabsContent value="summary" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle>{isVi ? "Bộ lọc thời gian" : "Time filter"}</CardTitle>
              <CardDescription>
                {isVi
                  ? "Lọc PO đã đăng theo ngày đặt hàng."
                  : "Filter posted POs by order date."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3 max-w-xl">
              <div>
                <Label>{isVi ? "Kiểu lọc" : "Filter mode"}</Label>
                <select
                  className="mt-1 w-full h-10 rounded-md border bg-background px-3 text-sm"
                  value={filterMode}
                  onChange={(e) => setFilterMode(e.target.value as "range" | "month")}
                >
                  <option value="range">{isVi ? "Từ ngày đến ngày" : "Date range"}</option>
                  <option value="month">{isVi ? "Theo tháng" : "By month"}</option>
                </select>
              </div>
              {filterMode === "range" ? (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <Label>{isVi ? "Từ ngày" : "From"}</Label>
                    <Input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} />
                  </div>
                  <div>
                    <Label>{isVi ? "Đến ngày" : "To"}</Label>
                    <Input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)} />
                  </div>
                </div>
              ) : (
                <div>
                  <Label>{isVi ? "Tháng" : "Month"}</Label>
                  <Input type="month" value={selectedMonth} onChange={(e) => setSelectedMonth(e.target.value)} />
                </div>
              )}
            </CardContent>
          </Card>

          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardContent className="p-4">
                <div className="text-xs text-muted-foreground">{isVi ? "Tổng doanh thu Bánh mì" : "Total Bread revenue"}</div>
                <div className="text-xl font-semibold">{vnd(legacyTotals.breadTotal)}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="text-xs text-muted-foreground">{isVi ? "Tổng doanh thu Bánh ngọt" : "Total Cake revenue"}</div>
                <div className="text-xl font-semibold">{vnd(legacyTotals.cakeTotal)}</div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <div className="text-xs text-muted-foreground">{isVi ? "Tổng doanh thu toàn bộ" : "Total revenue"}</div>
                <div className="text-xl font-semibold">{vnd(legacyTotals.grandTotal)}</div>
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>{isVi ? "Danh sách PO đã đăng" : "Posted PO list"}</CardTitle>
              <CardDescription>
                {postedRowsFiltered.length} {isVi ? "PO trong bộ lọc" : "POs in filter"} ·{" "}
                {postedRows.length} {isVi ? "tổng cộng" : "total"}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{isVi ? "Tên khách hàng" : "Customer"}</TableHead>
                    <TableHead>{isVi ? "Nhóm" : "Group"}</TableHead>
                    <TableHead>{isVi ? "Nhóm sản phẩm" : "Product group"}</TableHead>
                    <TableHead className="text-right">{isVi ? "Giá trị" : "Amount"}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {postedRowsFiltered.map((row: any) => (
                    <TableRow key={row.id}>
                      <TableCell>{row?.mini_crm_customers?.customer_name || "—"}</TableCell>
                      <TableCell>
                        {row?.mini_crm_customers?.customer_group || normalizeChannel(row.revenue_channel) || "—"}
                      </TableCell>
                      <TableCell>
                        {PRODUCT_GROUP_LABEL[row?.mini_crm_customers?.product_group] || row?.mini_crm_customers?.product_group || "—"}
                      </TableCell>
                      <TableCell className="text-right">{vnd(calcAmountFromRow(row))}</TableCell>
                    </TableRow>
                  ))}
                  {postedRowsFiltered.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center text-muted-foreground py-6">
                        {isVi ? "Chưa có PO nào khớp bộ lọc thời gian." : "No posted PO matches the selected time filter."}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── TAB 3: Tier Settings ──────────────────────────────────────────────── */}
        <TabsContent value="tier" className="space-y-4 mt-4">
          <Card>
            <CardHeader>
              <CardTitle>{isVi ? "Phân loại Tier-1" : "Tier-1 classification"}</CardTitle>
              <CardDescription>
                {isVi
                  ? "Chỉ khách hàng Tier-1 tạo draft doanh thu tự động khi đồng bộ. Các khách hàng khác tạo bản ghi ngoại lệ cần xử lý thủ công."
                  : "Only Tier-1 customers generate revenue drafts automatically during sync. Others produce exception records for manual review."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{isVi ? "Tên khách hàng" : "Customer"}</TableHead>
                    <TableHead>{isVi ? "Nhóm" : "Group"}</TableHead>
                    <TableHead>{isVi ? "Nhóm SP" : "Product"}</TableHead>
                    <TableHead>Tier-1</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {customers.map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-medium">{c.customer_name}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{c.customer_group || "—"}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {PRODUCT_GROUP_LABEL[c.product_group] || c.product_group || "—"}
                      </TableCell>
                      <TableCell>
                        <button
                          type="button"
                          role="switch"
                          aria-checked={c.is_tier1}
                          className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${c.is_tier1 ? "bg-green-500" : "bg-input"}`}
                          onClick={() => toggleTier1(c.id, c.is_tier1)}
                        >
                          <span
                            className={`inline-block h-4 w-4 rounded-full bg-background shadow-sm transition-transform ${c.is_tier1 ? "translate-x-6" : "translate-x-1"}`}
                          />
                        </button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {customers.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center text-muted-foreground py-6">
                        {isVi ? "Không có khách hàng nào." : "No customers found."}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={Boolean(selectedDraft)} onOpenChange={(open) => !open && setSelectedDraft(null)}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{isVi ? "Chi tiết draft / ngoại lệ" : "Draft / exception detail"}</DialogTitle>
          </DialogHeader>
          {selectedDraft && (
            <div className="space-y-4">
              <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{isVi ? "Khách hàng" : "Customer"}</div><div className="font-medium mt-1">{selectedDraft.mini_crm_customers?.customer_name || "—"}</div></CardContent></Card>
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">PO</div><div className="font-mono mt-1">{selectedDraft.po_number || "—"}</div></CardContent></Card>
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{isVi ? "Trạng thái" : "Status"}</div><div className="mt-1"><Badge variant={(DRAFT_STATUS_CONFIG[selectedDraft.status] ?? DRAFT_STATUS_CONFIG.pending).variant}>{(DRAFT_STATUS_CONFIG[selectedDraft.status] ?? DRAFT_STATUS_CONFIG.pending).label}</Badge></div></CardContent></Card>
                <Card><CardContent className="p-4"><div className="text-xs text-muted-foreground">{isVi ? "Doanh thu" : "Amount"}</div><div className="font-semibold mt-1">{vnd(Number(selectedDraft.total_amount || 0))}</div></CardContent></Card>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader><CardTitle className="text-base">{isVi ? "Provenance / hệ thống" : "Provenance / system"}</CardTitle></CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    <div><span className="text-muted-foreground">Draft ID:</span> <span className="font-mono break-all">{selectedDraft.id}</span></div>
                    <div><span className="text-muted-foreground">Sales PO Doc ID:</span> <span className="font-mono break-all">{selectedDraft.sales_po_doc_id || "—"}</span></div>
                    <div><span className="text-muted-foreground">Inbox Row ID:</span> <span className="font-mono break-all">{selectedSalesDoc?.inbox_row_id || "—"}</span></div>
                    <div>
                      <span className="text-muted-foreground">Lệnh SX:</span>{" "}
                      {(() => {
                        const linked = productionByDraftId.get(selectedDraft.id);
                        if (linked) return (
                          <Badge variant="secondary" className="text-xs font-mono gap-1">
                            <Factory className="h-3 w-3" />{linked.production_number}
                          </Badge>
                        );
                        return <span className="font-mono">—</span>;
                      })()}
                    </div>
                    <div><span className="text-muted-foreground">Sync Job ID:</span> <span className="font-mono break-all">{selectedDraft.sync_job_id || "—"}</span></div>
                    <div><span className="text-muted-foreground">KB Profile:</span> <span className="font-mono break-all">{selectedSalesDoc?.kb_profile_id || "—"}</span></div>
                    <div><span className="text-muted-foreground">KB Version:</span> <span className="font-mono break-all">{selectedSalesDoc?.kb_version_id || "—"}</span></div>
                    <div><span className="text-muted-foreground">Parse source:</span> {selectedSalesDoc?.parse_source || "—"}</div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader><CardTitle className="text-base">{isVi ? "Accounting snapshot" : "Accounting snapshot"}</CardTitle></CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    <div className="flex justify-between gap-3"><span className="text-muted-foreground">Subtotal</span><span>{vnd(Number(selectedDraft.subtotal_amount || 0))}</span></div>
                    <div className="flex justify-between gap-3"><span className="text-muted-foreground">VAT</span><span>{vnd(Number(selectedDraft.vat_amount || 0))}</span></div>
                    <div className="flex justify-between gap-3"><span className="text-muted-foreground">Total</span><span className="font-semibold">{vnd(Number(selectedDraft.total_amount || 0))}</span></div>
                    <div className="flex justify-between gap-3"><span className="text-muted-foreground">{isVi ? "Kênh" : "Channel"}</span><span>{selectedDraft.revenue_channel || "—"}</span></div>
                    <div className="flex justify-between gap-3"><span className="text-muted-foreground">{isVi ? "Nhóm SP" : "Product group"}</span><span>{PRODUCT_GROUP_LABEL[selectedDraft.product_group] || selectedDraft.product_group || "—"}</span></div>
                    <div className="flex justify-between gap-3"><span className="text-muted-foreground">{isVi ? "Approved at" : "Approved at"}</span><span>{dateOnly(selectedDraft.approved_at) || "—"}</span></div>
                    <div className="flex justify-between gap-3"><span className="text-muted-foreground">{isVi ? "Rejected at" : "Rejected at"}</span><span>{dateOnly(selectedDraft.rejected_at) || "—"}</span></div>
                  </CardContent>
                </Card>
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <Card>
                  <CardHeader><CardTitle className="text-base">{isVi ? "Inbox evidence" : "Inbox evidence"}</CardTitle></CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    <div><span className="text-muted-foreground">Subject:</span> {selectedInboxEvidence?.email_subject || "—"}</div>
                    <div><span className="text-muted-foreground">From:</span> {selectedInboxEvidence?.from_email || "—"}</div>
                    <div><span className="text-muted-foreground">Received:</span> {selectedInboxEvidence?.received_at || "—"}</div>
                    <div><span className="text-muted-foreground">Preview:</span></div>
                    <div className="rounded-md bg-muted p-3 text-xs whitespace-pre-wrap break-words">{selectedInboxEvidence?.body_preview || selectedInboxEvidence?.raw_payload?.snippet || "—"}</div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader><CardTitle className="text-base">{isVi ? "Parsed PO snapshot / lý do" : "Parsed PO snapshot / reason"}</CardTitle></CardHeader>
                  <CardContent className="space-y-2 text-sm">
                    <div><span className="text-muted-foreground">{isVi ? "Lý do ngoại lệ" : "Exception reason"}:</span> {selectedDraft.exception_reason || selectedSalesDoc?.exception_reason || "—"}</div>
                    <div><span className="text-muted-foreground">Items:</span></div>
                    <pre className="rounded-md bg-muted p-3 text-[11px] leading-relaxed overflow-x-auto">{JSON.stringify(selectedSalesDoc?.items || [], null, 2)}</pre>
                  </CardContent>
                </Card>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
