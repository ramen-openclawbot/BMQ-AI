import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw, CheckCircle, XCircle, AlertTriangle } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { calcTotalFromRawPayload, extractPoNumberFromSubject } from "@/components/mini-crm/poDraftUtils";

// ── helpers ────────────────────────────────────────────────────────────────────

const vnd = (v: number) =>
  new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(v || 0);

const dateOnly = (v?: string | null) => String(v || "").slice(0, 10);

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

// ── types ─────────────────────────────────────────────────────────────────────

interface CustomerRow {
  id: string;
  customer_name: string;
  customer_group: string;
  product_group: string;
  is_tier1: boolean;
  is_active: boolean;
}

interface SyncResult {
  rowsFound: number;
  rowsProcessed: number;
  draftsCreated: number;
  exceptionsCreated: number;
  skipped: number;
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

  // draft queue state
  const [draftStatusFilter, setDraftStatusFilter] = useState<string>("pending");
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
        .select("id, customer_name, customer_group, product_group, is_tier1, is_active")
        .eq("is_active", true)
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
    () => draftStatusFilter === "all" ? revenueDrafts : revenueDrafts.filter((d: any) => d.status === draftStatusFilter),
    [revenueDrafts, draftStatusFilter]
  );

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
    const { error } = await (supabase as any)
      .from("revenue_drafts")
      .update({ status: "approved", approved_by: user?.id || "manual", approved_at: now, updated_at: now })
      .eq("id", draftId);
    setApprovingId(null);
    if (error) { toast({ title: "Lỗi", description: getReadableError(error), variant: "destructive" }); return; }
    queryClient.invalidateQueries({ queryKey: ["revenue-drafts"] });
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
  };

  const toggleTier1 = async (customerId: string, current: boolean) => {
    const { error } = await (supabase as any)
      .from("mini_crm_customers")
      .update({ is_tier1: !current })
      .eq("id", customerId);
    if (error) { toast({ title: "Lỗi", description: getReadableError(error), variant: "destructive" }); return; }
    queryClient.invalidateQueries({ queryKey: ["mini-crm-customers-tier"] });
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

      <Tabs defaultValue="queue">
        <TabsList>
          <TabsTrigger value="queue">{isVi ? "Hàng đợi doanh thu" : "Revenue queue"}</TabsTrigger>
          <TabsTrigger value="summary">{isVi ? "Tóm tắt" : "Summary"}</TabsTrigger>
          <TabsTrigger value="tier">{isVi ? "Cài đặt Tier" : "Tier settings"}</TabsTrigger>
        </TabsList>

        {/* ── TAB 1: Draft Queue ─────────────────────────────────────────────── */}
        <TabsContent value="queue" className="space-y-4 mt-4">

          {/* Manual Sync Card */}
          <Card>
            <CardHeader>
              <CardTitle>{isVi ? "Đồng bộ thủ công" : "Manual sync"}</CardTitle>
              <CardDescription>
                {isVi
                  ? "Tạo draft doanh thu từ PO inbox trong khoảng ngày đã chọn. Chỉ khách hàng Tier-1 (★) tạo draft — còn lại tạo bản ghi ngoại lệ."
                  : "Generate revenue drafts from PO inbox rows. Tier-1 customers (★) create pending drafts; others create exception records."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
                <div>
                  <Label>{isVi ? "Khách hàng" : "Customer"}</Label>
                  <select
                    className="mt-1 w-full h-10 rounded-md border bg-background px-3 text-sm"
                    value={syncCustomerId}
                    onChange={(e) => setSyncCustomerId(e.target.value)}
                  >
                    <option value="all">{isVi ? "Tất cả khách hàng" : "All customers"}</option>
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

          {/* Summary stats — clickable to filter table */}
          <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
            {(
              [
                { key: "pending",   label: isVi ? "Chờ duyệt" : "Pending",    amtKey: "pendingAmt",  color: "text-blue-600" },
                { key: "approved",  label: isVi ? "Đã duyệt" : "Approved",    amtKey: "approvedAmt", color: "text-green-600" },
                { key: "rejected",  label: isVi ? "Từ chối" : "Rejected",     amtKey: null,          color: "text-red-600" },
                { key: "exception", label: isVi ? "Ngoại lệ" : "Exceptions",  amtKey: null,          color: "text-amber-600" },
              ] as const
            ).map(({ key, label, amtKey, color }) => (
              <Card
                key={key}
                className={`cursor-pointer transition-colors hover:bg-muted/50 ${draftStatusFilter === key ? "ring-2 ring-primary" : ""}`}
                onClick={() => setDraftStatusFilter(key)}
              >
                <CardContent className="p-4">
                  <div className={`text-xs font-medium ${color}`}>{label}</div>
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
                <CardTitle>{isVi ? "Danh sách draft" : "Draft list"}</CardTitle>
                <select
                  className="h-8 rounded-md border bg-background px-2 text-sm"
                  value={draftStatusFilter}
                  onChange={(e) => setDraftStatusFilter(e.target.value)}
                >
                  <option value="all">{isVi ? "Tất cả" : "All"} ({revenueDrafts.length})</option>
                  <option value="pending">{isVi ? "Chờ duyệt" : "Pending"} ({draftStats.pending || 0})</option>
                  <option value="approved">{isVi ? "Đã duyệt" : "Approved"} ({draftStats.approved || 0})</option>
                  <option value="rejected">{isVi ? "Từ chối" : "Rejected"} ({draftStats.rejected || 0})</option>
                  <option value="exception">{isVi ? "Ngoại lệ" : "Exception"} ({draftStats.exception || 0})</option>
                </select>
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
                      <TableHead>{isVi ? "Giao hàng" : "Delivery"}</TableHead>
                      <TableHead>{isVi ? "Nhóm SP" : "Group"}</TableHead>
                      <TableHead>{isVi ? "Kênh" : "Channel"}</TableHead>
                      <TableHead className="text-right">{isVi ? "Doanh thu" : "Amount"}</TableHead>
                      <TableHead>{isVi ? "Trạng thái" : "Status"}</TableHead>
                      <TableHead>{isVi ? "Hành động" : "Action"}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filteredDrafts.map((d: any) => {
                      const cfg = DRAFT_STATUS_CONFIG[d.status] ?? DRAFT_STATUS_CONFIG.pending;
                      const isActing = approvingId === d.id || rejectingId === d.id;
                      return (
                        <TableRow key={d.id}>
                          <TableCell className="font-medium">
                            {d.mini_crm_customers?.customer_name || "—"}
                          </TableCell>
                          <TableCell className="text-xs font-mono">{d.po_number || "—"}</TableCell>
                          <TableCell className="text-xs">{dateOnly(d.po_order_date) || "—"}</TableCell>
                          <TableCell className="text-xs">{dateOnly(d.delivery_date) || "—"}</TableCell>
                          <TableCell className="text-sm">
                            {PRODUCT_GROUP_LABEL[d.product_group] || d.product_group || "—"}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {d.revenue_channel || "—"}
                          </TableCell>
                          <TableCell className="text-right font-medium">
                            {vnd(Number(d.total_amount || 0))}
                          </TableCell>
                          <TableCell>
                            <Badge variant={cfg.variant}>{cfg.label}</Badge>
                            {d.exception_reason && (
                              <div className="text-xs text-muted-foreground mt-0.5 max-w-[160px] truncate" title={d.exception_reason}>
                                {d.exception_reason}
                              </div>
                            )}
                          </TableCell>
                          <TableCell>
                            {d.status === "pending" && (
                              <div className="flex gap-1">
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 w-7 p-0 text-green-700 border-green-300 hover:bg-green-50"
                                  disabled={isActing}
                                  title={isVi ? "Duyệt" : "Approve"}
                                  onClick={() => approveDraft(d.id)}
                                >
                                  {approvingId === d.id
                                    ? <Loader2 className="h-3 w-3 animate-spin" />
                                    : <CheckCircle className="h-3 w-3" />}
                                </Button>
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 w-7 p-0 text-red-700 border-red-300 hover:bg-red-50"
                                  disabled={isActing}
                                  title={isVi ? "Từ chối" : "Reject"}
                                  onClick={() => rejectDraft(d.id)}
                                >
                                  {rejectingId === d.id
                                    ? <Loader2 className="h-3 w-3 animate-spin" />
                                    : <XCircle className="h-3 w-3" />}
                                </Button>
                              </div>
                            )}
                            {d.status === "exception" && (
                              <AlertTriangle className="h-4 w-4 text-amber-500" />
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

        {/* ── TAB 2: Legacy Revenue Summary (preserved) ────────────────────────── */}
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
    </div>
  );
}
