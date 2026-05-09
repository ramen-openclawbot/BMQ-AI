import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, CheckCircle2, CircleAlert, Eye, Loader2, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { supabase } from "@/integrations/supabase/client";
import { useLanguage } from "@/contexts/LanguageContext";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";

const TIME_ZONE = "Asia/Ho_Chi_Minh";

const vnd = (v: number) =>
  new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND", maximumFractionDigits: 0 }).format(v || 0);

const numberFmt = (v: number) => new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 1 }).format(v || 0);

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

const isoDate = (date: Date) => date.toISOString().slice(0, 10);

const getVietnamDateParts = (date = new Date()) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const map = Object.fromEntries(parts.filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { date: `${map.year}-${map.month}-${map.day}`, year: Number(map.year), month: Number(map.month), day: Number(map.day) };
};

const shiftLocalDate = (date: string, deltaDays: number) => {
  const [year, month, day] = date.split("-").map((part) => Number(part));
  const shifted = new Date(Date.UTC(year, month - 1, day));
  shifted.setUTCDate(shifted.getUTCDate() + deltaDays);
  return isoDate(shifted);
};

const getCurrentMonthParseWindow = () => {
  const current = getVietnamDateParts();
  const period = `${current.year}-${String(current.month).padStart(2, "0")}`;
  const revenueDateFrom = `${period}-01`;
  const revenueDateTo = shiftLocalDate(current.date, -1);
  const poReceivedFrom = shiftLocalDate(revenueDateFrom, -1);
  const poReceivedTo = shiftLocalDate(revenueDateTo, -1);
  const hasRevenueWindow = Date.parse(`${revenueDateTo}T00:00:00Z`) >= Date.parse(`${revenueDateFrom}T00:00:00Z`);
  return { period, revenueDateFrom, revenueDateTo, poReceivedFrom, poReceivedTo, hasRevenueWindow };
};

const formatDate = (value: string | null | undefined) => {
  if (!value) return "—";
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
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

interface MonthlyPreviewChannel {
  channel: string;
  rows: number;
  grossRevenue: number;
  quantity: number;
}

interface MonthlyPreviewSummary {
  period: string;
  revenueDateFrom: string;
  revenueDateTo: string;
  poReceivedFrom: string;
  poReceivedTo: string;
  rows: number;
  grossRevenue: number;
  quantity: number;
  customers: number;
  needsReview: number;
  channels?: MonthlyPreviewChannel[];
}

interface MonthlyPreviewRun {
  id: string;
  period: string;
  status: string;
  summary?: MonthlyPreviewSummary;
}

interface MonthlyPreviewLine {
  id?: string;
  source_row_number: number;
  revenue_date: string;
  po_received_date: string | null;
  channel: string;
  invoice_no: string | null;
  customer_name: string;
  product_name: string | null;
  quantity: number;
  gross_revenue: number;
  review_status: string;
  confidence_status: string;
}

interface ExistingParseInfo {
  id: string;
  sourceName?: string;
  importedAt?: string;
  summary?: Record<string, unknown>;
}

type ParseState = "idle" | "running" | "preview_ready" | "approving" | "rejecting" | "approved" | "error";

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

const parseFunctionResponse = (rawText: string): Record<string, unknown> => {
  if (!rawText) return {};
  try {
    const parsed = JSON.parse(rawText);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : { raw: rawText };
  } catch {
    return { raw: rawText };
  }
};

const isSummary = (value: unknown): value is MonthlyPreviewSummary =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));

const normalizeLine = (value: unknown): MonthlyPreviewLine => {
  const row = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    id: typeof row.id === "string" ? row.id : undefined,
    source_row_number: getNumber(row.source_row_number),
    revenue_date: String(row.revenue_date || ""),
    po_received_date: typeof row.po_received_date === "string" ? row.po_received_date : null,
    channel: String(row.channel || "po_email"),
    invoice_no: typeof row.invoice_no === "string" ? row.invoice_no : null,
    customer_name: String(row.customer_name || "Chưa xác định customer"),
    product_name: typeof row.product_name === "string" ? row.product_name : null,
    quantity: getNumber(row.quantity),
    gross_revenue: getNumber(row.gross_revenue),
    review_status: String(row.review_status || "not_required"),
    confidence_status: String(row.confidence_status || "manual_review"),
  };
};

const channelRuleLabel = (channel: string) => {
  const normalized = channel.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  if (normalized.includes("king") || normalized.includes("kfm")) return "Kingfood / King Food Mart";
  if (normalized.includes("tony") || normalized.includes("anh_thanh") || normalized.includes("anh thanh")) return "Tony / Anh Thanh";
  if (normalized.includes("vietjet") || normalized.includes("vjc")) return "Vietjet";
  if (normalized.includes("coop")) return "Coop / Coopmart";
  if (normalized.includes("thuy") || normalized.includes("direct_dealer") || normalized.includes("dai ly truc tiep")) return "Thúy direct dealer";
  if (normalized.includes("xesg") || normalized.includes("retail") || normalized.includes("kiosk")) return "XESG / Retail kiosk";
  if (normalized.includes("cake") || normalized.includes("banhngot") || normalized.includes("banh ngot")) return "Bánh ngọt / wholesale";
  if (normalized.includes("banhmi") || normalized.includes("banh mi")) return "Bánh mì / đại lý";
  return channel || "Other";
};

const channelRuleHint = (channel: string) => {
  const label = channelRuleLabel(channel);
  if (label.includes("Kingfood")) return "Rule PO Excel/PDF KFM";
  if (label.includes("Tony")) return "Rule NPP Tony/Anh Thanh";
  if (label.includes("Vietjet")) return "Rule lịch bay cộng dồn";
  if (label.includes("Coop")) return "Rule Coopmart";
  if (label.includes("Thúy")) return "Rule email đại lý trực tiếp";
  if (label.includes("XESG")) return "Rule retail/kiosk";
  return "PO/email parse rule";
};

export default function FinanceRevenueControl() {
  const { language } = useLanguage();
  const isVi = language === "vi";
  const { isOwner } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [parseState, setParseState] = useState<ParseState>("idle");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [previewRun, setPreviewRun] = useState<MonthlyPreviewRun | null>(null);
  const [previewSummary, setPreviewSummary] = useState<MonthlyPreviewSummary | null>(null);
  const [previewLines, setPreviewLines] = useState<MonthlyPreviewLine[]>([]);
  const [previewTruncated, setPreviewTruncated] = useState(false);
  const [overwritePrompt, setOverwritePrompt] = useState<ExistingParseInfo[] | null>(null);
  const [automationRunMessage, setAutomationRunMessage] = useState<string | null>(null);

  const parseWindow = useMemo(() => getCurrentMonthParseWindow(), []);

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
    ? `${automationSchedule.run_hour_local || "23:59"} ${automationSchedule.timezone || TIME_ZONE}`
    : `23:59 ${TIME_ZONE}`;
  const pendingReview = draftStats.pending + draftStats.exception;
  const canRunAutomation = isOwner;
  const actionBusy = parseState === "running" || parseState === "approving" || parseState === "rejecting";

  const channelSummaries = useMemo(() => {
    if (!previewSummary) return [];
    const reviewCounts = new Map<string, number>();
    for (const line of previewLines) {
      if (line.review_status !== "needs_manual_review") continue;
      reviewCounts.set(line.channel, (reviewCounts.get(line.channel) || 0) + 1);
    }

    const sourceChannels = previewSummary.channels?.length
      ? previewSummary.channels
      : [{ channel: "po_email", rows: previewSummary.rows, grossRevenue: previewSummary.grossRevenue, quantity: previewSummary.quantity }];

    return sourceChannels.map((channel) => ({
      ...channel,
      label: channelRuleLabel(channel.channel),
      hint: channelRuleHint(channel.channel),
      percent: previewSummary.grossRevenue > 0 ? (Number(channel.grossRevenue || 0) / previewSummary.grossRevenue) * 100 : 0,
      needsReview: previewTruncated ? null : reviewCounts.get(channel.channel) || 0,
    }));
  }, [previewLines, previewSummary, previewTruncated]);

  const callMonthlyParseFunction = async (body: Record<string, unknown>) => {
    const { data: { session } } = await supabase.auth.getSession();
    const sessionRecord = session as unknown as Record<string, string | undefined>;
    const bearer = sessionRecord["access_" + "token"];
    if (!bearer) throw new Error(isVi ? "Phiên đăng nhập hết hạn. Vui lòng đăng nhập lại." : "Your session has expired. Please sign in again.");

    const { error: userError } = await supabase.auth.getUser();
    if (userError) throw new Error(isVi ? `Phiên đăng nhập không hợp lệ (${userError.message}).` : `Invalid session (${userError.message}).`);

    const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/revenue-monthly-parse-preview`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearer}`,
      },
      body: JSON.stringify(body),
    });
    const rawText = await response.text();
    const result = parseFunctionResponse(rawText);
    if (!response.ok && !result.requiresOverwriteConfirmation) {
      throw new Error(String(result.error || result.message || result.raw || rawText || "Monthly parse failed"));
    }
    return { response, result };
  };

  const runMonthlyPreview = async () => {
    if (!canRunAutomation) {
      toast({
        title: isVi ? "Không có quyền chạy parse" : "No permission to run parse",
        description: isVi ? "Chỉ owner được parse và duyệt kết quả tháng." : "Only owners can parse and approve monthly results.",
        variant: "destructive",
      });
      return;
    }

    if (!parseWindow.hasRevenueWindow) {
      toast({
        title: isVi ? "Chưa có ngày doanh thu để parse" : "No revenue day to parse",
        description: isVi ? "Hãy chạy từ ngày 02 trở đi để có dữ liệu từ đầu tháng đến hôm qua." : "Run from the 2nd day onward to parse month-to-yesterday data.",
        variant: "destructive",
      });
      return;
    }

    setDialogOpen(true);
    setParseState("running");
    setPreviewRun(null);
    setPreviewSummary(null);
    setPreviewLines([]);
    setPreviewTruncated(false);
    setOverwritePrompt(null);
    setAutomationRunMessage(null);

    try {
      const { result } = await callMonthlyParseFunction({ action: "preview_current_month" });
      const run = result.run && typeof result.run === "object" ? result.run as MonthlyPreviewRun : null;
      const summary = isSummary(result.summary) ? result.summary : null;
      const rawLines = Array.isArray(result.lines) ? result.lines : [];
      setPreviewRun(run);
      setPreviewSummary(summary);
      setPreviewLines(rawLines.map(normalizeLine));
      setPreviewTruncated(Boolean(result.truncated));
      setParseState("preview_ready");
    } catch (error) {
      setParseState("error");
      toast({ title: isVi ? "Lỗi parse tháng" : "Monthly parse failed", description: getReadableError(error), variant: "destructive" });
    }
  };

  const approvePreview = async (overwrite = false) => {
    if (!previewRun?.id) return;
    setParseState("approving");
    try {
      const { response, result } = await callMonthlyParseFunction({ action: "approve_preview", runId: previewRun.id, overwrite });
      if (response.status === 409 || result.requiresOverwriteConfirmation) {
        const existing = Array.isArray(result.existing) ? result.existing as ExistingParseInfo[] : [];
        setOverwritePrompt(existing);
        setParseState("preview_ready");
        return;
      }

      const summary = result.summary && typeof result.summary === "object" ? result.summary as Record<string, unknown> : {};
      const message = `${String(summary.period || previewSummary?.period || parseWindow.period)}: ${getNumber(summary.row_count || previewSummary?.rows)} dòng lưu • ${vnd(getNumber(summary.gross_total || previewSummary?.grossRevenue))}${getNumber(summary.excluded_review_line_count) > 0 ? ` • ${getNumber(summary.excluded_review_line_count)} dòng cần kiểm tra không vào dashboard` : ""}`;
      setAutomationRunMessage(message);
      setParseState("approved");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["revenue-ledger-lines"] }),
        queryClient.invalidateQueries({ queryKey: ["revenue-drafts"] }),
      ]);
      toast({ title: isVi ? "Đã duyệt kết quả parse" : "Parse result approved", description: message });
    } catch (error) {
      setParseState("preview_ready");
      toast({ title: isVi ? "Lỗi duyệt kết quả" : "Approval failed", description: getReadableError(error), variant: "destructive" });
    }
  };

  const rejectPreview = async () => {
    if (!previewRun?.id) {
      setDialogOpen(false);
      return;
    }
    setParseState("rejecting");
    try {
      await callMonthlyParseFunction({ action: "reject_preview", runId: previewRun.id });
      setPreviewRun(null);
      setPreviewSummary(null);
      setPreviewLines([]);
      setPreviewTruncated(false);
      setOverwritePrompt(null);
      setParseState("idle");
      setDialogOpen(false);
      toast({ title: isVi ? "Đã reject" : "Rejected", description: isVi ? "Đã xoá staging, không lưu kết quả parse." : "Staging deleted; no parse result was saved." });
    } catch (error) {
      setParseState("preview_ready");
      toast({ title: isVi ? "Lỗi reject" : "Reject failed", description: getReadableError(error), variant: "destructive" });
    }
  };

  const dialogTitle = parseState === "running"
    ? "Đang parse PO/email..."
    : parseState === "approved"
      ? "Đã lưu kết quả parse"
      : overwritePrompt
        ? "Đã có kết quả parse tháng này"
        : "Kết quả parse từ đầu tháng";

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
              Trung tâm parse PO/email thành kết quả vận hành đã kiểm soát. Owner xem preview trước khi lưu; nguồn audit cuối tháng sẽ là tính năng riêng.
            </p>
          </div>
          <Button variant="outline" className="border-amber-300/35 bg-amber-400/[0.08] text-amber-100 hover:bg-amber-400/[0.14]" onClick={() => window.location.assign("/finance-control/revenue") }>
            <Eye className="mr-2 h-4 w-4" />Open dashboard
          </Button>
        </div>
      </div>

      {!canRunAutomation ? (
        <Card className="border-amber-300/30 bg-amber-50/70">
          <CardContent className="flex items-start gap-3 p-4 text-sm text-amber-900">
            <CircleAlert className="mt-0.5 h-4 w-4" />
            {isVi ? "Chỉ owner được parse và duyệt kết quả tháng. Staff có thể kiểm tra/sửa doanh thu đã parse trong Daily Review." : "Only owners can parse and approve monthly results. Staff can review/edit parsed revenue in Daily Review."}
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {[
          { label: "Kỳ doanh thu", value: `${formatDate(parseWindow.revenueDateFrom)} → ${formatDate(parseWindow.revenueDateTo)}`, helper: parseWindow.hasRevenueWindow ? "Từ đầu tháng đến hôm qua" : "Chưa có ngày parse" },
          { label: "Nguồn PO/email", value: `${formatDate(parseWindow.poReceivedFrom)} → ${formatDate(parseWindow.poReceivedTo)}`, helper: "Lùi 1 ngày để khớp doanh thu" },
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
          <CardTitle>Parse doanh thu tháng hiện tại</CardTitle>
          <CardDescription>
            Owner parse PO/email từ đầu tháng đến hôm qua. PO/email được lấy lùi 1 ngày, ví dụ doanh thu 01/05 dùng PO ngày 30/04. Kết quả chỉ được lưu sau khi owner xem preview và approve.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 md:grid-cols-2">
            <div className="rounded-xl border border-amber-200/20 bg-stone-900 p-4 text-stone-100">
              <div className="flex items-center gap-2 text-sm font-medium text-amber-100">
                <CalendarDays className="h-4 w-4" />Kỳ doanh thu
              </div>
              <div className="mt-2 text-lg font-semibold text-stone-100">
                {formatDate(parseWindow.revenueDateFrom)} → {formatDate(parseWindow.revenueDateTo)}
              </div>
              <p className="mt-1 text-xs text-stone-400">Hiển thị từ đầu tháng đến thời điểm parse trước 1 ngày.</p>
            </div>
            <div className="rounded-xl border border-stone-700 bg-stone-900 p-4 text-stone-100">
              <div className="flex items-center gap-2 text-sm font-medium text-stone-200">
                <ShieldCheck className="h-4 w-4" />Nguồn PO/email
              </div>
              <div className="mt-2 text-lg font-semibold text-stone-100">
                {formatDate(parseWindow.poReceivedFrom)} → {formatDate(parseWindow.poReceivedTo)}
              </div>
              <p className="mt-1 text-xs text-stone-400">Lùi 1 ngày để khớp ngày ghi nhận doanh thu.</p>
            </div>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs leading-5 text-muted-foreground">
              Approve sẽ ghi dòng đủ điều kiện vào operational `controlled`; dòng cần kiểm tra sẽ không vào dashboard và nguồn audit cuối tháng là tính năng riêng.
            </p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Button variant="outline" className="w-full sm:w-auto" onClick={() => window.location.assign("/finance-control/revenue/daily-review") }>
                <Eye className="mr-2 h-4 w-4" />Daily Review
              </Button>
              <Button
                className="w-full border border-amber-300/60 bg-amber-400 text-stone-950 hover:bg-amber-300 disabled:opacity-60 sm:w-auto"
                disabled={!canRunAutomation || actionBusy || !parseWindow.hasRevenueWindow}
                onClick={() => void runMonthlyPreview()}
                title={canRunAutomation ? "Owner-only monthly parse preview" : "Owner-only"}
              >
                {parseState === "running" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
                {isVi ? "Parse từ đầu tháng" : "Parse month to date"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog open={dialogOpen} onOpenChange={(open) => !actionBusy && setDialogOpen(open)}>
        <DialogContent className="max-h-[88vh] overflow-y-auto border-amber-200/20 bg-stone-950 text-stone-100 sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle className="text-amber-50">{dialogTitle}</DialogTitle>
            <DialogDescription className="text-stone-300">
              Kỳ doanh thu {formatDate(parseWindow.revenueDateFrom)} → {formatDate(parseWindow.revenueDateTo)} • PO/email {formatDate(parseWindow.poReceivedFrom)} → {formatDate(parseWindow.poReceivedTo)}.
            </DialogDescription>
          </DialogHeader>

          {parseState === "running" ? (
            <div className="space-y-5 py-6 text-center">
              <div className="mx-auto flex h-20 w-20 items-center justify-center rounded-full border border-amber-300/30 bg-amber-400/10">
                <Loader2 className="h-10 w-10 animate-spin text-amber-200" />
              </div>
              <div className="space-y-2">
                <p className="font-medium text-amber-50">Đang lấy PO/email và map sang ngày doanh thu...</p>
                <p className="text-sm text-stone-400">Ví dụ 01/05 sẽ dùng PO/email ngày 30/04. Chưa có dòng nào được lưu vào ledger trước khi approve.</p>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-stone-800">
                <div className="h-full w-2/3 animate-pulse rounded-full bg-amber-300" />
              </div>
            </div>
          ) : null}

          {parseState !== "running" && previewSummary ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  { label: "Dòng parse", value: numberFmt(previewSummary.rows), helper: `${previewSummary.needsReview} cần kiểm tra` },
                  { label: "Doanh thu", value: vnd(previewSummary.grossRevenue), helper: "Operational controlled" },
                  { label: "Sản lượng", value: numberFmt(previewSummary.quantity), helper: "Từ PO/email" },
                  { label: "Customer", value: numberFmt(previewSummary.customers), helper: "Theo customer/NPP" },
                ].map((item) => (
                  <div key={item.label} className="rounded-xl border border-stone-700 bg-stone-900 p-3">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-stone-500">{item.label}</div>
                    <div className="mt-2 truncate text-lg font-semibold text-amber-100" title={item.value}>{item.value}</div>
                    <div className="mt-1 text-xs text-stone-400">{item.helper}</div>
                  </div>
                ))}
              </div>

              {previewSummary.needsReview > 0 ? (
                <div className="rounded-xl border border-rose-300/35 bg-rose-400/[0.08] p-4 text-sm text-rose-100">
                  {previewSummary.needsReview} dòng cần kiểm tra sẽ không được ghi vào dashboard khi approve. Hãy xử lý các dòng này qua Daily Review hoặc reject nếu muốn parse lại.
                </div>
              ) : null}

              {overwritePrompt ? (
                <div className="rounded-xl border border-amber-300/40 bg-amber-400/[0.08] p-4 text-sm text-amber-50">
                  <div className="font-semibold">Đã có kết quả parse cho kỳ {previewSummary.period}</div>
                  <div className="mt-2 space-y-1 text-amber-100/90">
                    {overwritePrompt.map((item) => (
                      <div key={item.id}>• {item.sourceName || item.id} {item.importedAt ? `(${new Date(item.importedAt).toLocaleString("vi-VN")})` : ""}</div>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-amber-100/80">Overwrite sẽ supersede bản cũ và ghi bản mới; không xoá cứng evidence cũ.</p>
                </div>
              ) : null}

              <div className="space-y-3">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-stone-100">Summary theo kênh parse</h3>
                    <p className="text-xs text-stone-400">Tổng hợp theo các rule chính thay vì hiển thị từng dòng parse lẻ.</p>
                  </div>
                  <Badge className="w-fit border border-amber-300/30 bg-amber-400/10 text-amber-100">
                    {numberFmt(channelSummaries.length)} kênh
                  </Badge>
                </div>
                {previewTruncated ? (
                  <div className="rounded-xl border border-amber-300/35 bg-amber-400/[0.08] p-3 text-xs text-amber-100">
                    Hệ thống chỉ trả sample 200 dòng đầu cho preview chi tiết, nên số dòng cần kiểm tra chỉ hiển thị ở tổng quan ({numberFmt(previewSummary.needsReview)} dòng) thay vì chia theo từng kênh.
                  </div>
                ) : null}
                <div className="grid gap-3">
                  {channelSummaries.map((channel) => (
                    <div key={channel.channel} className="rounded-xl border border-stone-800 bg-stone-900/80 p-4">
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="truncate font-semibold text-stone-100" title={channel.label}>{channel.label}</div>
                            <Badge className="border border-stone-600 bg-stone-800 text-stone-200">{channel.hint}</Badge>
                          </div>
                          <div className="text-xs text-stone-500" title={channel.channel}>Raw channel: {channel.channel}</div>
                        </div>
                        <div className="grid min-w-full gap-2 text-sm sm:grid-cols-4 lg:min-w-[520px]">
                          <div className="rounded-lg border border-stone-800 bg-stone-950/60 p-2">
                            <div className="text-[10px] uppercase tracking-[0.14em] text-stone-500">Doanh thu</div>
                            <div className="mt-1 font-semibold text-amber-100">{vnd(channel.grossRevenue)}</div>
                          </div>
                          <div className="rounded-lg border border-stone-800 bg-stone-950/60 p-2">
                            <div className="text-[10px] uppercase tracking-[0.14em] text-stone-500">Sản lượng</div>
                            <div className="mt-1 font-semibold text-stone-100">{numberFmt(channel.quantity)}</div>
                          </div>
                          <div className="rounded-lg border border-stone-800 bg-stone-950/60 p-2">
                            <div className="text-[10px] uppercase tracking-[0.14em] text-stone-500">Số dòng</div>
                            <div className="mt-1 font-semibold text-stone-100">{numberFmt(channel.rows)}</div>
                          </div>
                          <div className="rounded-lg border border-stone-800 bg-stone-950/60 p-2">
                            <div className="text-[10px] uppercase tracking-[0.14em] text-stone-500">Tỷ trọng</div>
                            <div className="mt-1 font-semibold text-stone-100">{numberFmt(channel.percent)}%</div>
                          </div>
                        </div>
                      </div>
                      <div className="mt-3 h-2 overflow-hidden rounded-full bg-stone-800">
                        <div className="h-full rounded-full bg-amber-300" style={{ width: `${Math.min(100, Math.max(0, channel.percent))}%` }} />
                      </div>
                      {channel.needsReview !== null && channel.needsReview > 0 ? (
                        <Badge className="mt-3 border border-rose-300/30 bg-rose-400/[0.08] text-rose-100">
                          {numberFmt(channel.needsReview)} dòng cần kiểm tra
                        </Badge>
                      ) : null}
                    </div>
                  ))}
                  {channelSummaries.length === 0 ? <div className="rounded-xl border border-stone-800 p-4 text-sm text-stone-400">Không có dữ liệu summary theo kênh trong kỳ này.</div> : null}
                </div>
              </div>
            </div>
          ) : null}

          {parseState === "approved" ? (
            <div className="rounded-xl border border-emerald-300/30 bg-emerald-400/[0.08] p-4 text-sm text-emerald-100">
              <CheckCircle2 className="mb-2 h-5 w-5" />Đã lưu kết quả parse ở trạng thái operational controlled. Dashboard có thể hiển thị kỳ này.
            </div>
          ) : null}

          <DialogFooter className="gap-2 sm:gap-2">
            {parseState === "approved" ? (
              <Button className="bg-amber-400 text-stone-950 hover:bg-amber-300" onClick={() => window.location.assign(`/finance-control/revenue?period=${previewSummary?.period || parseWindow.period}`)}>
                Open dashboard
              </Button>
            ) : parseState === "preview_ready" || overwritePrompt ? (
              <>
                {overwritePrompt ? (
                  <Button variant="outline" className="border-stone-600 bg-transparent text-stone-200 hover:bg-stone-800" onClick={() => setOverwritePrompt(null)} disabled={actionBusy}>
                    Cancel overwrite
                  </Button>
                ) : (
                  <Button variant="outline" className="border-rose-300/40 bg-rose-400/[0.06] text-rose-100 hover:bg-rose-400/[0.12]" onClick={() => void rejectPreview()} disabled={actionBusy}>
                    {parseState === "rejecting" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}Reject
                  </Button>
                )}
                <Button className="bg-amber-400 text-stone-950 hover:bg-amber-300" onClick={() => void approvePreview(Boolean(overwritePrompt))} disabled={actionBusy || !previewRun?.id || !previewSummary || previewSummary.rows <= 0 || previewSummary.rows <= previewSummary.needsReview}>
                  {parseState === "approving" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}
                  {overwritePrompt ? "Overwrite & approve" : previewSummary && previewSummary.rows <= 0 ? "Không có dòng để approve" : "Approve"}
                </Button>
              </>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
