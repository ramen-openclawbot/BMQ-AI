import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleAlert, Eye, Loader2, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { supabase } from "@/integrations/supabase/client";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";

const vnd = (v: number) =>
  new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(v || 0);

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

const getNumber = (value: unknown) => (Number.isFinite(Number(value)) ? Number(value) : 0);

const getVietnamDate = (deltaDays = 0) => {
  const now = new Date();
  now.setUTCDate(now.getUTCDate() + deltaDays);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const map = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
};

const diffDaysInclusive = (from: string, to: string) => {
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  const toMs = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return Number.NaN;
  return Math.floor((toMs - fromMs) / 86_400_000) + 1;
};

interface ScheduleRow {
  id: string;
  run_hour_local: string;
  timezone: string;
  is_enabled: boolean;
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
  order: (column: string, options: { ascending: boolean }) => QueryBuilder<T>;
  limit: (count: number) => QueryBuilder<T>;
  maybeSingle: () => QueryResult<T>;
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

export default function FinanceRevenueControl() {
  const { language } = useLanguage();
  const isVi = language === "vi";
  const { isOwner } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [manualDateFrom, setManualDateFrom] = useState(() => getVietnamDate(-6));
  const [manualDateTo, setManualDateTo] = useState(() => getVietnamDate());
  const [automationRunning, setAutomationRunning] = useState(false);
  const [automationRunMessage, setAutomationRunMessage] = useState<string | null>(null);

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
        .select("id, run_hour_local, timezone, is_enabled")
        .eq("config_key", "default")
        .maybeSingle();
      if (error) throw error;
      return data || null;
    },
  });

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

  const scheduleSummary = automationSchedule
    ? `${automationSchedule.run_hour_local || "23:59"} ${automationSchedule.timezone || "Asia/Ho_Chi_Minh"}`
    : "23:59 Asia/Ho_Chi_Minh";
  const pendingReview = draftStats.pending + draftStats.exception;
  const canRunAutomation = isOwner;
  const selectedRangeDays = diffDaysInclusive(manualDateFrom, manualDateTo);

  const validateManualRange = () => {
    if (!canRunAutomation) {
      toast({
        title: isVi ? "Không có quyền chạy automation" : "No permission to run automation",
        description: isVi ? "Chỉ owner được parse thủ công theo khoảng ngày." : "Only owners can manually parse a date range.",
        variant: "destructive",
      });
      return false;
    }

    if (!manualDateFrom || !manualDateTo) {
      toast({
        title: isVi ? "Thiếu khoảng ngày" : "Missing date range",
        description: isVi ? "Vui lòng chọn cả ngày bắt đầu và ngày kết thúc." : "Please choose both a start date and an end date.",
        variant: "destructive",
      });
      return false;
    }

    const days = diffDaysInclusive(manualDateFrom, manualDateTo);
    if (!Number.isFinite(days) || days < 1) {
      toast({
        title: isVi ? "Khoảng ngày không hợp lệ" : "Invalid date range",
        description: isVi ? "Ngày bắt đầu phải nhỏ hơn hoặc bằng ngày kết thúc." : "Start date must be before or equal to end date.",
        variant: "destructive",
      });
      return false;
    }

    if (days > 31) {
      toast({
        title: isVi ? "Khoảng ngày quá dài" : "Date range too large",
        description: isVi ? "Vui lòng parse tối đa 31 ngày mỗi lần để tránh quá tải inbox." : "Please parse at most 31 days at a time to avoid overloading the inbox.",
        variant: "destructive",
      });
      return false;
    }

    return true;
  };

  const runManualRangeParse = async () => {
    if (!validateManualRange()) return;

    setAutomationRunMessage(null);
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
        body: JSON.stringify({
          mode: "manual_range",
          ignoreDisabled: true,
          dateFrom: manualDateFrom,
          dateTo: manualDateTo,
        }),
      });

      const rawText = await response.text();
      const result = parseSchedulerResponse(rawText);
      if (!response.ok) throw new Error(String(result.error || result.message || result.raw || rawText || "Automation run failed"));

      const stats = result.result && typeof result.result === "object" ? result.result as Record<string, unknown> : {};
      const rangeText = `${String(stats.dateFrom || manualDateFrom)} → ${String(stats.dateTo || manualDateTo)}`;
      const message = `${rangeText}: ${getNumber(stats.rowsFound)} PO • ${getNumber(stats.draftsCreated)} draft • ${getNumber(stats.exceptionsCreated)} ngoại lệ • ${getNumber(stats.skippedRows)} bỏ qua`;
      setAutomationRunMessage(message);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["po-sync-jobs-recent"] }),
        queryClient.invalidateQueries({ queryKey: ["po-sync-snapshots"] }),
        queryClient.invalidateQueries({ queryKey: ["po-sync-schedule-foundation"] }),
        queryClient.invalidateQueries({ queryKey: ["revenue-drafts"] }),
      ]);
      toast({
        title: isVi ? "Đã parse khoảng ngày" : "Date range parsed",
        description: isVi
          ? `${getNumber(stats.draftsCreated)} draft • ${getNumber(stats.exceptionsCreated)} ngoại lệ • ${getNumber(stats.skippedRows)} bỏ qua`
          : `${getNumber(stats.draftsCreated)} drafts • ${getNumber(stats.exceptionsCreated)} exceptions • ${getNumber(stats.skippedRows)} skipped`,
      });
    } catch (error) {
      toast({ title: isVi ? "Lỗi parse khoảng ngày" : "Date range parse failed", description: getReadableError(error), variant: "destructive" });
    } finally {
      setAutomationRunning(false);
    }
  };

  return (
    <div className="space-y-5">
      <div className="rounded-2xl border border-amber-200/15 bg-gradient-to-br from-stone-950 via-stone-900 to-amber-950/25 p-4 text-stone-100 shadow-sm md:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-2">
            <Badge className="border border-amber-300/35 bg-amber-400/10 text-amber-100">
              Auto-parse daily • {scheduleLoading ? "Loading..." : scheduleSummary}
            </Badge>
            <h1 className="font-display text-2xl font-semibold tracking-tight text-amber-50 md:text-4xl">
              Daily Auto-Parse Operations
            </h1>
            <p className="max-w-3xl text-sm leading-6 text-stone-300/80">
              Trung tâm parse PO/email thành draft và ngoại lệ theo khoảng ngày. Staff kiểm tra/sửa ở Daily Review, không có bước duyệt bắt buộc tại đây.
            </p>
          </div>
          <Button variant="outline" className="border-amber-300/35 bg-amber-400/[0.08] text-amber-100 hover:bg-amber-400/[0.14]" onClick={() => window.location.assign("/finance-control/revenue/daily-review")}>
            <Eye className="mr-2 h-4 w-4" />Open daily review
          </Button>
        </div>
      </div>

      {!canRunAutomation ? (
        <Card className="border-amber-300/30 bg-amber-50/70">
          <CardContent className="flex items-start gap-3 p-4 text-sm text-amber-900">
            <CircleAlert className="mt-0.5 h-4 w-4" />
            {isVi ? "Chỉ owner được parse thủ công theo khoảng ngày. Staff có thể kiểm tra và sửa doanh thu đã parse trong Daily Review." : "Manual date-range parsing is owner-only. Staff can review and edit parsed revenue in Daily Review."}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {[
          { label: "Selected range", value: `${manualDateFrom} → ${manualDateTo}`, helper: Number.isFinite(selectedRangeDays) && selectedRangeDays > 0 ? `${selectedRangeDays} day(s)` : "Invalid range" },
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

      <Card>
        <CardHeader>
          <CardTitle>Manual parse theo ngày</CardTitle>
          <CardDescription>
            Owner chọn khoảng ngày để parse PO/email thành draft hoặc ngoại lệ cho Daily Review. Không ghi nhận doanh thu final; tối đa 31 ngày/lần.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <label htmlFor="manual-date-from" className="text-sm font-medium text-muted-foreground">Từ ngày</label>
              <Input
                id="manual-date-from"
                type="date"
                value={manualDateFrom}
                onChange={(event) => setManualDateFrom(event.target.value)}
                disabled={!canRunAutomation || automationRunning}
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="manual-date-to" className="text-sm font-medium text-muted-foreground">Đến ngày</label>
              <Input
                id="manual-date-to"
                type="date"
                value={manualDateTo}
                onChange={(event) => setManualDateTo(event.target.value)}
                disabled={!canRunAutomation || automationRunning}
              />
            </div>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs leading-5 text-muted-foreground">
              Kết quả parse chỉ là evidence/draft để staff review-by-exception trong Daily Review.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button variant="outline" className="w-full sm:w-auto" onClick={() => window.location.assign("/finance-control/revenue/daily-review")}>
                <Eye className="mr-2 h-4 w-4" />Daily Review
              </Button>
              <Button
                className="w-full border border-amber-300/60 bg-amber-400 text-stone-950 hover:bg-amber-300 disabled:opacity-60 sm:w-auto"
                disabled={!canRunAutomation || automationRunning}
                onClick={() => void runManualRangeParse()}
                title={canRunAutomation ? "Owner-only manual date range parse" : "Owner-only"}
              >
                {automationRunning ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                {isVi ? "Parse khoảng ngày" : "Parse date range"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
