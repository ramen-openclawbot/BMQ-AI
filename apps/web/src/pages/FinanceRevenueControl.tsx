import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Eye, Loader2, RefreshCw, Save } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { supabase } from "@/integrations/supabase/client";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";

const vnd = (v: number) =>
  new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(v || 0);

const dateTime = (v?: string | null) => {
  if (!v) return "—";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString("vi-VN");
};

const getReadableError = (error: unknown): string => {
  if (!error) return "Không rõ nguyên nhân";
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "object") {
    const record = error as Record<string, unknown>;
    const parts = [record.message, record.details, record.hint].filter((part): part is string => typeof part === "string" && part.length > 0);
    if (parts.length) return parts.join(" | ");
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "Không rõ nguyên nhân";
  }
};

type ScheduleScopeMode = "all_root_customers" | "single_customer" | "tier1_only";

interface CustomerRow {
  id: string;
  customer_name: string;
}

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

interface SnapshotRow {
  id: string;
  snapshot_date: string;
  total_drafts_count: number;
  pending_drafts_count: number;
  exception_drafts_count: number;
  cumulative_total_amount: number;
  cumulative_pending_amount: number;
  created_at: string;
}

interface RevenueDraftRow {
  id: string;
  status: string | null;
  total_amount: number | null;
}

type QueryResult<T> = PromiseLike<{ data: T | null; error: { message?: string; details?: string; hint?: string } | null }>;
type QueryBuilder<T> = QueryResult<T[]> & {
  select: (columns: string) => QueryBuilder<T>;
  eq: (column: string, value: string | boolean | null) => QueryBuilder<T>;
  is: (column: string, value: null) => QueryBuilder<T>;
  order: (column: string, options: { ascending: boolean }) => QueryBuilder<T>;
  limit: (count: number) => QueryBuilder<T>;
  maybeSingle: () => QueryResult<T>;
  upsert: (payload: Record<string, unknown>, options?: { onConflict?: string }) => QueryResult<T[]>;
};

type DbClient = {
  from: <T>(table: string) => QueryBuilder<T>;
};

const db = supabase as unknown as DbClient;

const parseSchedulerResponse = (rawText: string): Record<string, unknown> => {
  if (!rawText) return {};
  try {
    const parsed = JSON.parse(rawText);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { raw: rawText };
  } catch {
    return { raw: rawText };
  }
};

const getNumber = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);

export default function FinanceRevenueControl() {
  const { language } = useLanguage();
  const isVi = language === "vi";
  const { user, isOwner } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [scheduleEnabled, setScheduleEnabled] = useState(false);
  const [scheduleScopeMode, setScheduleScopeMode] = useState<ScheduleScopeMode>("tier1_only");
  const [scheduleCustomerId, setScheduleCustomerId] = useState<string>("all");
  const [scheduleHourLocal, setScheduleHourLocal] = useState<string>("23:59");
  const [scheduleTimezone, setScheduleTimezone] = useState<string>("Asia/Ho_Chi_Minh");
  const [scheduleLookbackDays, setScheduleLookbackDays] = useState<string>("1");
  const [scheduleNotes, setScheduleNotes] = useState<string>("");
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [automationRunning, setAutomationRunning] = useState(false);
  const [automationRunMessage, setAutomationRunMessage] = useState<string | null>(null);

  const { data: customers = [] } = useQuery<CustomerRow[]>({
    queryKey: ["mini-crm-customers-tier"],
    queryFn: async () => {
      const { data, error } = await db
        .from<CustomerRow>("mini_crm_customers")
        .select("id, customer_name")
        .eq("is_active", true)
        .is("supplied_by_npp_customer_id", null)
        .order("customer_name", { ascending: true });
      if (error) throw error;
      return data || [];
    },
  });

  const { data: revenueDrafts = [] } = useQuery<RevenueDraftRow[]>({
    queryKey: ["revenue-drafts"],
    queryFn: async () => {
      const { data, error } = await db
        .from<RevenueDraftRow>("revenue_drafts")
        .select("id,status,total_amount")
        .order("created_at", { ascending: false })
        .limit(300);
      if (error) throw error;
      return data || [];
    },
  });

  const { data: automationSchedule, isLoading: scheduleLoading } = useQuery<ScheduleRow | null>({
    queryKey: ["po-sync-schedule-foundation"],
    queryFn: async () => {
      const { data, error } = await db
        .from<ScheduleRow>("po_sync_schedules")
        .select("*, mini_crm_customers(customer_name)")
        .eq("config_key", "default")
        .maybeSingle();
      if (error) throw error;
      return data || null;
    },
  });

  const { data: recentSyncJobs = [] } = useQuery<SyncJobRow[]>({
    queryKey: ["po-sync-jobs-recent"],
    queryFn: async () => {
      const { data, error } = await db
        .from<SyncJobRow>("po_sync_jobs")
        .select("*, mini_crm_customers(customer_name)")
        .order("created_at", { ascending: false })
        .limit(12);
      if (error) throw error;
      return data || [];
    },
  });

  const { data: cumulativeSnapshots = [] } = useQuery<SnapshotRow[]>({
    queryKey: ["po-sync-snapshots"],
    queryFn: async () => {
      const { data, error } = await db
        .from<SnapshotRow>("po_sync_snapshots")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(12);
      if (error) throw error;
      return data || [];
    },
  });

  useEffect(() => {
    if (!automationSchedule) return;
    setScheduleEnabled(Boolean(automationSchedule.is_enabled));
    setScheduleScopeMode(automationSchedule.scope_mode || "tier1_only");
    setScheduleCustomerId(automationSchedule.customer_id || "all");
    setScheduleHourLocal(automationSchedule.run_hour_local || "23:59");
    setScheduleTimezone(automationSchedule.timezone || "Asia/Ho_Chi_Minh");
    setScheduleLookbackDays(String(automationSchedule.lookback_days || 1));
    setScheduleNotes(automationSchedule.notes || "");
  }, [automationSchedule]);

  const draftStats = useMemo(() => {
    const counts = { pending: 0, approved: 0, rejected: 0, exception: 0, pendingAmt: 0, approvedAmt: 0 };
    for (const draft of revenueDrafts) {
      const status = draft.status || "";
      const amount = Number(draft.total_amount || 0);
      if (status === "pending") {
        counts.pending += 1;
        counts.pendingAmt += amount;
      } else if (status === "approved") {
        counts.approved += 1;
        counts.approvedAmt += amount;
      } else if (status === "rejected") {
        counts.rejected += 1;
      } else if (status === "exception") {
        counts.exception += 1;
      }
    }
    return counts;
  }, [revenueDrafts]);

  const latestSyncJob = recentSyncJobs[0] || null;
  const scheduleSummary = automationSchedule
    ? `${automationSchedule.run_hour_local || "23:59"} ${automationSchedule.timezone || "Asia/Ho_Chi_Minh"}`
    : "23:59 Asia/Ho_Chi_Minh";
  const pendingReview = draftStats.pending + draftStats.exception;
  const canRunAutomation = isOwner;

  const automationScopeSummary = useMemo(() => {
    if (scheduleScopeMode === "all_root_customers") return isVi ? "Tất cả NPP / khách hàng gốc" : "All root customers / distributors";
    if (scheduleScopeMode === "single_customer") {
      const customer = customers.find((item) => item.id === scheduleCustomerId);
      return customer?.customer_name || (isVi ? "Chưa chọn khách hàng" : "No customer selected");
    }
    return isVi ? "Chỉ nhóm Tier-1" : "Tier-1 only";
  }, [customers, isVi, scheduleCustomerId, scheduleScopeMode]);

  const persistAutomationSchedule = async (showToast = true) => {
    if (scheduleScopeMode === "single_customer" && scheduleCustomerId === "all") {
      toast({ title: isVi ? "Thiếu khách hàng" : "Missing customer", description: isVi ? "Vui lòng chọn một NPP / khách hàng gốc cụ thể." : "Please choose a specific root customer / distributor.", variant: "destructive" });
      return false;
    }

    const parsedLookback = Number(scheduleLookbackDays || 1);
    if (!Number.isFinite(parsedLookback)) {
      toast({ title: isVi ? "Lookback không hợp lệ" : "Invalid lookback", description: isVi ? "Vui lòng nhập số ngày hợp lệ từ 1 đến 30." : "Please enter a valid lookback day count between 1 and 30.", variant: "destructive" });
      return false;
    }

    setScheduleSaving(true);
    try {
      const lookback = Math.max(1, Math.min(30, parsedLookback));
      const payload: Record<string, unknown> = {
        config_key: "default",
        customer_id: scheduleScopeMode === "single_customer" ? scheduleCustomerId : null,
        is_enabled: scheduleEnabled,
        scope_mode: scheduleScopeMode,
        schedule_mode: "daily",
        run_hour_local: scheduleHourLocal || "23:59",
        timezone: scheduleTimezone || "Asia/Ho_Chi_Minh",
        lookback_days: lookback,
        notes: scheduleNotes.trim() || null,
        updated_by: user?.id || "manual",
        updated_at: new Date().toISOString(),
      };
      if (!automationSchedule) payload.created_by = user?.id || "manual";

      const { error } = await db.from<ScheduleRow>("po_sync_schedules").upsert(payload, { onConflict: "config_key" });
      if (error) throw error;

      await queryClient.invalidateQueries({ queryKey: ["po-sync-schedule-foundation"] });
      await queryClient.invalidateQueries({ queryKey: ["po-sync-jobs-recent"] });
      if (showToast) {
        toast({ title: isVi ? "Đã lưu cấu hình automation" : "Automation settings saved" });
      }
      return true;
    } catch (error) {
      toast({ title: isVi ? "Lỗi lưu cấu hình" : "Failed to save schedule", description: getReadableError(error), variant: "destructive" });
      return false;
    } finally {
      setScheduleSaving(false);
    }
  };

  const runAutomationNow = async () => {
    if (!canRunAutomation) {
      toast({
        title: isVi ? "Không có quyền chạy automation" : "No permission to run automation",
        description: isVi ? "Chỉ owner được chạy automation thủ công." : "Only owners can run automation manually.",
        variant: "destructive",
      });
      return;
    }

    setAutomationRunMessage(null);
    const saved = await persistAutomationSchedule(false);
    if (!saved) return;

    setAutomationRunning(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const sessionRecord = session as unknown as Record<string, string | undefined>;
      const bearer = sessionRecord["access_" + "token"];
      if (!bearer) throw new Error(isVi ? "Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại." : "Your session has expired. Please sign in again.");

      const { error: userError } = await supabase.auth.getUser();
      if (userError) throw new Error(isVi ? `Phiên đăng nhập không hợp lệ (${userError.message}).` : `Invalid session (${userError.message}).`);

      const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/po-sync-scheduler-run`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify({ mode: "run_now", ignoreDisabled: true }),
      });

      const rawText = await response.text();
      const result = parseSchedulerResponse(rawText);
      if (!response.ok) throw new Error(String(result.error || result.message || result.raw || rawText || "Automation run failed"));

      const stats = result.result && typeof result.result === "object" ? result.result as Record<string, unknown> : {};
      setAutomationRunMessage(`${getNumber(stats.rowsFound)} PO • ${getNumber(stats.draftsCreated)} draft • ${getNumber(stats.exceptionsCreated)} ngoại lệ • ${getNumber(stats.skippedRows)} bỏ qua`);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["po-sync-jobs-recent"] }),
        queryClient.invalidateQueries({ queryKey: ["po-sync-snapshots"] }),
        queryClient.invalidateQueries({ queryKey: ["po-sync-schedule-foundation"] }),
        queryClient.invalidateQueries({ queryKey: ["revenue-drafts"] }),
      ]);
      toast({
        title: isVi ? "Đã chạy automation" : "Automation run completed",
        description: isVi
          ? `${getNumber(stats.draftsCreated)} draft • ${getNumber(stats.exceptionsCreated)} ngoại lệ • ${getNumber(stats.skippedRows)} bỏ qua`
          : `${getNumber(stats.draftsCreated)} drafts • ${getNumber(stats.exceptionsCreated)} exceptions • ${getNumber(stats.skippedRows)} skipped`,
      });
    } catch (error) {
      toast({ title: isVi ? "Lỗi chạy automation" : "Automation run failed", description: getReadableError(error), variant: "destructive" });
    } finally {
      setAutomationRunning(false);
    }
  };

  const lastJobTone = latestSyncJob?.status === "done"
    ? "border-emerald-300/35 bg-emerald-400/10 text-emerald-100"
    : latestSyncJob?.status === "failed"
      ? "border-rose-300/35 bg-rose-400/10 text-rose-100"
      : "border-amber-300/35 bg-amber-400/10 text-amber-100";

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-amber-200/15 bg-gradient-to-br from-stone-950 via-stone-900 to-amber-950/25 p-4 text-stone-100 shadow-sm md:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-2">
            <Badge className="border border-amber-300/35 bg-amber-400/10 text-amber-100">
              Auto-parse daily • {scheduleSummary}
            </Badge>
            <h1 className="font-display text-2xl font-semibold tracking-tight text-amber-50 md:text-4xl">
              Daily Auto-Parse Operations
            </h1>
            <p className="max-w-3xl text-sm leading-6 text-stone-300/80">
              Trung tâm vận hành `po-gmail-sync` và `po-sync-scheduler-run`: theo dõi job, snapshot, draft và ngoại lệ. Staff kiểm tra/sửa ở Daily Review, không có bước duyệt bắt buộc tại đây.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" className="border-amber-300/35 bg-amber-400/[0.08] text-amber-100 hover:bg-amber-400/[0.14]" onClick={() => window.location.assign("/finance-control/revenue/daily-review")}>
              <Eye className="mr-2 h-4 w-4" />Open daily review
            </Button>
            <Button
              className="border border-amber-300/60 bg-amber-400 text-stone-950 hover:bg-amber-300 disabled:opacity-60"
              disabled={!canRunAutomation || automationRunning}
              onClick={() => void runAutomationNow()}
              title={canRunAutomation ? "Owner-only run now" : "Owner-only"}
            >
              {automationRunning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              {isVi ? "Chạy ngay" : "Run now"}
            </Button>
          </div>
        </div>
      </div>

      {!canRunAutomation ? (
        <Card className="border-amber-300/30 bg-amber-50/70">
          <CardContent className="flex items-start gap-3 p-4 text-sm text-amber-900">
            <CircleAlert className="mt-0.5 h-4 w-4" />
            {isVi ? "Chỉ owner được Chạy ngay thủ công. Staff có thể kiểm tra và sửa doanh thu đã parse trong Daily Review." : "Manual Run now is owner-only. Staff can review and edit parsed revenue in Daily Review."}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        {[
          { label: "Next scheduled run", value: scheduleSummary, helper: scheduleLoading ? "Loading schedule..." : automationSchedule?.is_enabled ? "Enabled" : "Disabled" },
          { label: "Last job result", value: latestSyncJob?.status || "No job yet", helper: latestSyncJob ? dateTime(latestSyncJob.completed_at || latestSyncJob.created_at) : "Waiting for first run" },
          { label: "Drafts created", value: String(revenueDrafts.length), helper: `${draftStats.pending} pending review` },
          { label: "Exceptions", value: String(draftStats.exception), helper: "Need staff check" },
          { label: "Pending staff review", value: String(pendingReview), helper: vnd(draftStats.pendingAmt) },
        ].map((item) => (
          <Card key={item.label} className="border-amber-100/10 bg-gradient-to-br from-stone-900 to-stone-950 text-stone-100 ring-1 ring-stone-200/5">
            <CardContent className="p-4">
              <div className="text-[11px] uppercase tracking-[0.16em] text-stone-400">{item.label}</div>
              <div className="mt-2 truncate text-xl font-semibold tabular-nums text-amber-100" title={item.value}>{item.value}</div>
              <div className="mt-1 truncate text-xs text-stone-400" title={item.helper}>{item.helper}</div>
            </CardContent>
          </Card>
        ))}
      </div>

      {automationRunMessage ? (
        <Card className="border-emerald-300/30 bg-emerald-50">
          <CardContent className="p-4 text-sm text-emerald-900">{automationRunMessage}</CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[1fr_1.2fr]">
        <Card>
          <CardHeader>
            <CardTitle>Schedule</CardTitle>
            <CardDescription>Default daily parser window for Vietnam operations.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex items-center justify-between rounded-lg border p-3">
              <span className="text-muted-foreground">Run time</span>
              <span className="font-medium">{scheduleHourLocal || "23:59"} {scheduleTimezone || "Asia/Ho_Chi_Minh"}</span>
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <span className="text-muted-foreground">Scope</span>
              <span className="font-medium">{automationScopeSummary}</span>
            </div>
            <div className="flex items-center justify-between rounded-lg border p-3">
              <span className="text-muted-foreground">Lookback</span>
              <span className="font-medium">{scheduleLookbackDays || "1"} day(s)</span>
            </div>
            <Button variant="outline" className="w-full" onClick={() => void persistAutomationSchedule(true)} disabled={!isOwner || scheduleSaving}>
              {scheduleSaving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
              Save schedule (owner-only)
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent sync jobs</CardTitle>
            <CardDescription>Latest scheduler results, evidence counts and failures.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {recentSyncJobs.length === 0 ? (
              <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No sync jobs yet.</div>
            ) : recentSyncJobs.slice(0, 6).map((job) => (
              <div key={job.id} className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge className={job.id === latestSyncJob?.id ? lastJobTone : ""} variant="outline">{job.status}</Badge>
                    <span className="truncate text-sm font-medium">{job.mini_crm_customers?.customer_name || "All customers"}</span>
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">{job.date_from} → {job.date_to} • {job.inbox_rows_processed}/{job.inbox_rows_found} rows</div>
                  {job.error_message ? <div className="mt-1 text-xs text-destructive">{job.error_message}</div> : null}
                </div>
                <div className="text-xs text-muted-foreground">{dateTime(job.completed_at || job.created_at)}</div>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Snapshots / evidence</CardTitle>
          <CardDescription>Draft and exception totals created by auto-parse jobs.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead className="text-right">Drafts</TableHead>
                <TableHead className="text-right">Pending</TableHead>
                <TableHead className="text-right">Exceptions</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {cumulativeSnapshots.length === 0 ? (
                <TableRow><TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">No snapshots yet.</TableCell></TableRow>
              ) : cumulativeSnapshots.slice(0, 8).map((row) => (
                <TableRow key={row.id}>
                  <TableCell>{row.snapshot_date}</TableCell>
                  <TableCell className="text-right">{row.total_drafts_count}</TableCell>
                  <TableCell className="text-right">{row.pending_drafts_count}</TableCell>
                  <TableCell className="text-right">{row.exception_drafts_count}</TableCell>
                  <TableCell className="text-right font-medium">{vnd(row.cumulative_total_amount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
