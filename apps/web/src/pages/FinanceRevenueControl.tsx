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

const getDailyParseWindow = () => {
  const current = getVietnamDateParts();
  const period = `${current.year}-${String(current.month).padStart(2, "0")}`;
  const revenueDateFrom = current.date;
  const revenueDateTo = current.date;
  const poReceivedFrom = shiftLocalDate(current.date, -1);
  const poReceivedTo = shiftLocalDate(current.date, -1);
  return { period, revenueDateFrom, revenueDateTo, poReceivedFrom, poReceivedTo, hasRevenueWindow: true };
};

const formatDate = (value: string | null | undefined) => {
  if (!value) return "—";
  const [year, month, day] = value.split("-");
  return `${day}/${month}/${year}`;
};

const formatDateTime = (value: string | null | undefined) => {
  if (!value) return "—";
  return new Date(value).toLocaleString("vi-VN", { timeZone: TIME_ZONE, hour12: false });
};

const statusLabel = (status: string | null | undefined) => {
  if (status === "success") return "Thành công";
  if (status === "failed") return "Lỗi";
  if (status === "started") return "Đang chạy";
  return status || "—";
};

interface ScheduleRow {
  id: string;
  run_hour_local: string;
  timezone: string;
  is_enabled: boolean;
}

interface AutoDailyParseLogRow {
  id: string;
  revenue_date: string;
  period: string;
  scheduled_for_vn: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  run_id: string | null;
  source_document_id: string | null;
  po_received_from: string | null;
  po_received_to: string | null;
  row_count: number | null;
  gross_total: number | null;
  review_flagged_line_count: number | null;
  error_message: string | null;
  metadata: Record<string, unknown> | null;
  updated_at: string | null;
}

interface MonthlyPreviewChannel {
  channel: string;
  rows: number;
  grossRevenue: number;
  quantity: number;
  reviewFlaggedRows?: number;
}

interface MonthlyPreviewSummary {
  period: string;
  revenueDateFrom: string;
  revenueDateTo: string;
  poReceivedFrom: string;
  poReceivedTo: string;
  rows: number;
  postedRows?: number;
  ledgerRows?: number;
  grossRevenue: number;
  dashboardGrossRevenue?: number;
  quantity: number;
  customers: number;
  needsReview: number;
  reviewFlaggedRows?: number;
  approvalSemantics?: string;
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

interface ParseProgressChannel {
  channel: string;
  mails: number;
  lines: number;
}

interface ParseProgressState {
  stage: string;
  message: string;
  currentChannel: string;
  currentDate: string | null;
  fetched: number;
  synced: number;
  totalFetched: number;
  totalSynced: number;
  totalParsedMails: number;
  totalParsedLines: number;
  dayIndex: number;
  totalDays: number;
  channels: ParseProgressChannel[];
}

const emptyParseProgress = (): ParseProgressState => ({
  stage: "idle",
  message: "Chuẩn bị parse PO/email...",
  currentChannel: "Mailbox",
  currentDate: null,
  fetched: 0,
  synced: 0,
  totalFetched: 0,
  totalSynced: 0,
  totalParsedMails: 0,
  totalParsedLines: 0,
  dayIndex: 0,
  totalDays: 0,
  channels: [],
});


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
  const normalized = channel.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[đ]/g, "d");
  if (normalized.includes("dai ly") || normalized.includes("agency") || normalized.includes("franchise")) return "Đại lý";
  if (normalized.includes("banh ngot") || normalized.includes("banhngot") || normalized.includes("bakery") || normalized.includes("king") || normalized.includes("kfm") || normalized.includes("coop")) return "Bánh ngọt";
  if (normalized.includes("b2b") || normalized.includes("vietjet") || normalized.includes("vjc")) return "B2B BMQ";
  if (normalized.includes("retail") || normalized.includes("kiosk") || normalized.includes("xesg")) return "Retail kiosk";
  return channel || "Other";
};

const channelRuleHint = (_channel?: string) => "Kênh dashboard";

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
  const [parseProgress, setParseProgress] = useState<ParseProgressState>(() => emptyParseProgress());
  const [selectedAutoDailyLog, setSelectedAutoDailyLog] = useState<AutoDailyParseLogRow | null>(null);

  const parseWindow = useMemo(() => getDailyParseWindow(), []);

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

  const { data: autoDailyLogs = [], isLoading: logsLoading } = useQuery<AutoDailyParseLogRow[]>({
    queryKey: ["revenue-auto-daily-parse-logs"],
    queryFn: async () => {
      const { data, error } = await db
        .from<AutoDailyParseLogRow>("revenue_auto_daily_parse_logs")
        .select("id,revenue_date,period,scheduled_for_vn,status,started_at,finished_at,run_id,source_document_id,po_received_from,po_received_to,row_count,gross_total,review_flagged_line_count,error_message,metadata,updated_at")
        .order("revenue_date", { ascending: false })
        .limit(45);
      if (error) throw error;
      return data || [];
    },
  });

  const scheduleSummary = automationSchedule
    ? `${automationSchedule.run_hour_local || "23:59"} ${automationSchedule.timezone || TIME_ZONE}`
    : `23:59 ${TIME_ZONE}`;
  const canRunAutomation = isOwner;
  const actionBusy = parseState === "running" || parseState === "approving" || parseState === "rejecting";
  const previewLedgerRows = previewSummary?.ledgerRows ?? previewSummary?.postedRows ?? previewSummary?.rows ?? 0;
  const previewDashboardGross = previewSummary?.dashboardGrossRevenue ?? previewSummary?.grossRevenue ?? 0;
  const previewReviewFlags = previewSummary?.reviewFlaggedRows ?? previewSummary?.needsReview ?? 0;

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
      needsReview: previewTruncated ? null : channel.reviewFlaggedRows ?? reviewCounts.get(channel.channel) ?? 0,
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

  const applyParseProgressEvent = (event: Record<string, unknown>) => {
    if (event.type === "done") return;
    setParseProgress((prev) => {
      const next: ParseProgressState = {
        ...prev,
        stage: String(event.stage || prev.stage),
        message: String(event.message || prev.message),
        currentChannel: String(event.channel || prev.currentChannel),
        currentDate: typeof event.date === "string" ? event.date : typeof event.receivedDate === "string" ? event.receivedDate : prev.currentDate,
        fetched: event.fetched !== undefined ? getNumber(event.fetched) : prev.fetched,
        synced: event.synced !== undefined ? getNumber(event.synced) : prev.synced,
        totalFetched: event.totalFetched !== undefined ? getNumber(event.totalFetched) : prev.totalFetched,
        totalSynced: event.totalSynced !== undefined ? getNumber(event.totalSynced) : prev.totalSynced,
        totalParsedMails: event.totalParsedMails !== undefined ? getNumber(event.totalParsedMails) : prev.totalParsedMails,
        totalParsedLines: event.totalParsedLines !== undefined ? getNumber(event.totalParsedLines) : prev.totalParsedLines,
        dayIndex: event.dayIndex !== undefined ? getNumber(event.dayIndex) : prev.dayIndex,
        totalDays: event.totalDays !== undefined ? getNumber(event.totalDays) : prev.totalDays,
      };

      if (event.stage === "parse_channel" && typeof event.channel === "string") {
        const channel = event.channel;
        const existing = new Map(prev.channels.map((item) => [item.channel, item]));
        existing.set(channel, {
          channel,
          mails: getNumber(event.mailCount),
          lines: getNumber(event.lineCount),
        });
        next.channels = Array.from(existing.values()).sort((a, b) => b.mails - a.mails || a.channel.localeCompare(b.channel));
      }

      return next;
    });
  };

  const callMonthlyParseFunctionStream = async (body: Record<string, unknown>) => {
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
      body: JSON.stringify({ ...body, streamProgress: true }),
    });

    const contentType = response.headers.get("content-type") || "";
    if (!response.ok) {
      const rawText = await response.text();
      const result = parseFunctionResponse(rawText);
      throw new Error(String(result.error || result.message || result.raw || rawText || "Monthly parse failed"));
    }

    if (contentType.includes("application/json")) {
      return parseFunctionResponse(await response.text());
    }

    if (!response.body) {
      const fallback = await callMonthlyParseFunction(body);
      return fallback.result;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let finalResult: Record<string, unknown> | null = null;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n");
      buffer = parts.pop() || "";
      for (const part of parts) {
        const line = part.trim();
        if (!line) continue;
        const event = parseFunctionResponse(line);
        if (event.type === "error") throw new Error(String(event.error || event.message || "Monthly parse failed"));
        if (event.type === "done" || event.run || event.summary || Array.isArray(event.lines)) finalResult = event;
        applyParseProgressEvent(event);
      }
    }

    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail) {
      const event = parseFunctionResponse(tail);
      if (event.type === "error") throw new Error(String(event.error || event.message || "Monthly parse failed"));
      if (event.type === "done" || event.run || event.summary || Array.isArray(event.lines)) finalResult = event;
      applyParseProgressEvent(event);
    }

    if (!finalResult) throw new Error("Monthly parse finished without final preview result");
    return finalResult;
  };


  const runDailyPreview = async () => {
    if (!canRunAutomation) {
      toast({
        title: isVi ? "Không có quyền chạy parse" : "No permission to run parse",
        description: isVi ? "Chỉ owner được parse và duyệt kết quả ngày." : "Only owners can parse and approve daily results.",
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
    setParseProgress(emptyParseProgress());

    try {
      setParseProgress((prev) => ({ ...prev, stage: "daily_preview", message: "Đang parse PO/email theo ngày" }));
      const { result } = await callMonthlyParseFunction({ action: "preview_daily_compare", revenueDate: parseWindow.revenueDateFrom });
      const summary = isSummary(result.previewSummary) ? result.previewSummary : isSummary(result.summary) ? result.summary : null;
      const runId = typeof result.runId === "string" ? result.runId : String(result.runId || "");
      setPreviewRun(runId ? { id: runId, period: String(result.period || parseWindow.period), status: "preview_ready", summary: summary || undefined } : null);
      setPreviewSummary(summary);
      setPreviewLines([]);
      setPreviewTruncated(false);
      setParseState("preview_ready");
    } catch (error) {
      setParseState("error");
      toast({ title: isVi ? "Lỗi parse ngày" : "Daily parse failed", description: getReadableError(error), variant: "destructive" });
    }
  };

  const approvePreview = async (overwrite = false) => {
    if (!previewRun?.id) return;
    setParseState("approving");
    try {
      const { response, result } = await callMonthlyParseFunction({ action: "confirm_daily_post", runId: previewRun.id, overwrite });
      if (response.status === 409 || result.requiresOverwriteConfirmation) {
        const existing = Array.isArray(result.existing) ? result.existing as ExistingParseInfo[] : [];
        setOverwritePrompt(existing);
        setParseState("preview_ready");
        return;
      }

      const summary = result.summary && typeof result.summary === "object" ? result.summary as Record<string, unknown> : {};
      const postedRows = getNumber(summary.posted_line_count ?? summary.row_count ?? previewLedgerRows);
      const grossTotal = getNumber(summary.gross_total ?? previewDashboardGross);
      const message = isVi
        ? `${formatDate(parseWindow.revenueDateFrom)}: đã ghi ${numberFmt(postedRows)} dòng / ${vnd(grossTotal)} vào ledger và Doanh thu đã kiểm soát.`
        : `${formatDate(parseWindow.revenueDateFrom)}: posted ${numberFmt(postedRows)} rows / ${vnd(grossTotal)} to the controlled revenue ledger.`;
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
      await callMonthlyParseFunction({ action: "cancel_daily_preview", runId: previewRun.id });
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
        ? "Đã có kết quả parse ngày này"
        : "Kết quả parse theo ngày";

  return (
    <div className="space-y-5" data-stitch-revenue-parse-theme="pantone-2026-light">
      <div className="rounded-2xl border border-border bg-card/70 p-4 text-foreground shadow-card backdrop-blur-xl md:p-6">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-2">
            <Badge className="border border-primary/20 bg-primary/10 text-primary">
              Auto-parse daily • {scheduleLoading ? "Loading..." : scheduleSummary}
            </Badge>
            <h1 className="font-display text-2xl font-semibold tracking-tight text-foreground md:text-4xl">
              Daily Auto-Parse Operations
            </h1>
          </div>
          <Button
            variant="outline"
            className="w-full border-border bg-background/80 text-foreground hover:bg-primary/10 sm:w-auto"
            onClick={() => window.location.assign("/finance-control/revenue") }
          >
            <Eye className="mr-2 h-4 w-4" />Open dashboard
          </Button>
        </div>
      </div>

      {!canRunAutomation ? (
        <Card className="border-primary/20 bg-primary/10">
          <CardContent className="flex items-start gap-3 p-4 text-sm text-primary">
            <CircleAlert className="mt-0.5 h-4 w-4" />
            {isVi ? "Chỉ owner được parse và approve kết quả ngày. Sau approve, staff có thể review/edit doanh thu đã vào ledger." : "Only owners can parse and approve daily results. After approval, staff can review/edit parsed revenue in the ledger."}
          </CardContent>
        </Card>
      ) : null}

      {automationRunMessage ? (
        <Card className="border-primary/20 bg-primary/10">
          <CardContent className="p-4 text-sm text-primary">{automationRunMessage}</CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Parse theo ngày</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-border bg-card/80 p-4 text-foreground shadow-sm">
              <div className="flex items-center gap-2 text-sm font-medium text-primary">
                <CalendarDays className="h-4 w-4" />Ngày doanh thu
              </div>
              <div className="mt-2 text-xl font-semibold text-foreground">
                {formatDate(parseWindow.revenueDateFrom)}
              </div>
            </div>
            <div className="rounded-xl border border-border bg-card/80 p-4 text-foreground shadow-sm">
              <div className="flex items-center gap-2 text-sm font-medium text-primary">
                <ShieldCheck className="h-4 w-4" />PO/email
              </div>
              <div className="mt-2 text-xl font-semibold text-foreground">
                {formatDate(parseWindow.poReceivedFrom)}
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
            <Button variant="outline" className="w-full sm:w-auto" onClick={() => window.location.assign(`/finance-control/revenue?period=${parseWindow.period}`) }>
              <Eye className="mr-2 h-4 w-4" />Ledger / Dashboard
            </Button>
            <Button
              className="w-full btn-gradient text-primary-foreground disabled:opacity-60 sm:w-auto"
              disabled={!canRunAutomation || actionBusy}
              onClick={() => void runDailyPreview()}
              title={canRunAutomation ? "Owner-only daily parse preview" : "Owner-only"}
            >
              {parseState === "running" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <RefreshCw className="mr-2 h-4 w-4" />}
              {isVi ? "Parse ngày & xem preview" : "Parse day & preview"}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle>Log parse tự động hằng ngày</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3 md:hidden">
            {logsLoading ? (
              <div className="rounded-xl border px-3 py-4 text-sm text-muted-foreground">Đang tải log...</div>
            ) : autoDailyLogs.length > 0 ? autoDailyLogs.map((log) => (
              <button
                key={log.id}
                type="button"
                className="w-full rounded-xl border border-border bg-card/80 p-3 text-left shadow-sm transition hover:bg-primary/5"
                onClick={() => setSelectedAutoDailyLog(log)}
              >
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold tabular-nums">{formatDate(log.revenue_date)}</div>
                    <div className="mt-1 text-xs text-muted-foreground">Kết thúc: {formatDateTime(log.finished_at || log.updated_at)}</div>
                  </div>
                  <Badge className={log.status === "success" ? "border border-primary/20 bg-primary/10 text-primary" : log.status === "failed" ? "border border-destructive/20 bg-destructive/10 text-destructive" : "border border-primary/20 bg-primary/10 text-primary"}>
                    {statusLabel(log.status)}
                  </Badge>
                </div>
                <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                  <div className="rounded-lg bg-muted/40 p-2">
                    <div className="text-muted-foreground">Dòng</div>
                    <div className="mt-1 font-medium">{numberFmt(Number(log.row_count || 0))}</div>
                  </div>
                  <div className="rounded-lg bg-muted/40 p-2">
                    <div className="text-muted-foreground">Doanh thu</div>
                    <div className="mt-1 truncate font-medium" title={vnd(Number(log.gross_total || 0))}>{vnd(Number(log.gross_total || 0))}</div>
                  </div>
                </div>
                <div className="mt-3 text-right text-sm font-medium text-primary">Chi tiết</div>
              </button>
            )) : (
              <div className="rounded-xl border px-3 py-4 text-sm text-muted-foreground">Chưa có log parse tự động hằng ngày.</div>
            )}
          </div>

          <div className="hidden overflow-hidden rounded-xl border md:block">
            <div className="grid grid-cols-12 gap-2 border-b bg-muted/40 px-3 py-2 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              <div className="col-span-2">Ngày</div>
              <div className="col-span-2">Trạng thái</div>
              <div className="col-span-2">Kết thúc</div>
              <div className="col-span-2">Dòng</div>
              <div className="col-span-3">Doanh thu</div>
              <div className="col-span-1 text-right">Xem</div>
            </div>
            <div className="divide-y">
              {logsLoading ? (
                <div className="px-3 py-4 text-sm text-muted-foreground">Đang tải log...</div>
              ) : autoDailyLogs.length > 0 ? autoDailyLogs.map((log) => (
                <button
                  key={log.id}
                  type="button"
                  className="grid w-full grid-cols-12 items-center gap-2 px-3 py-3 text-left text-sm transition hover:bg-primary/5"
                  onClick={() => setSelectedAutoDailyLog(log)}
                >
                  <div className="col-span-2 font-medium tabular-nums">{formatDate(log.revenue_date)}</div>
                  <div className="col-span-2">
                    <Badge className={log.status === "success" ? "border border-primary/20 bg-primary/10 text-primary" : log.status === "failed" ? "border border-destructive/20 bg-destructive/10 text-destructive" : "border border-primary/20 bg-primary/10 text-primary"}>
                      {statusLabel(log.status)}
                    </Badge>
                  </div>
                  <div className="col-span-2 truncate text-muted-foreground" title={formatDateTime(log.finished_at || log.updated_at)}>{formatDateTime(log.finished_at || log.updated_at)}</div>
                  <div className="col-span-2 tabular-nums">{numberFmt(Number(log.row_count || 0))}</div>
                  <div className="col-span-3 truncate font-medium" title={vnd(Number(log.gross_total || 0))}>{vnd(Number(log.gross_total || 0))}</div>
                  <div className="col-span-1 text-right text-primary">Chi tiết</div>
                </button>
              )) : (
                <div className="px-3 py-4 text-sm text-muted-foreground">Chưa có log parse tự động hằng ngày.</div>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      <Dialog open={Boolean(selectedAutoDailyLog)} onOpenChange={(open) => !open && setSelectedAutoDailyLog(null)}>
        <DialogContent className="max-h-[88vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Chi tiết log parse</DialogTitle>
            <DialogDescription>
              {selectedAutoDailyLog ? `${formatDate(selectedAutoDailyLog.revenue_date)} • ${statusLabel(selectedAutoDailyLog.status)} • cron ${selectedAutoDailyLog.scheduled_for_vn} VN` : ""}
            </DialogDescription>
          </DialogHeader>
          {selectedAutoDailyLog ? (
            <div className="space-y-4 text-sm">
              <div className="grid gap-3 sm:grid-cols-2">
                {[
                  ["Ngày doanh thu", formatDate(selectedAutoDailyLog.revenue_date)],
                  ["Kỳ", selectedAutoDailyLog.period],
                  ["Bắt đầu", formatDateTime(selectedAutoDailyLog.started_at)],
                  ["Kết thúc", formatDateTime(selectedAutoDailyLog.finished_at)],
                  ["PO/email", `${formatDate(selectedAutoDailyLog.po_received_from)} → ${formatDate(selectedAutoDailyLog.po_received_to)}`],
                  ["Review flag", numberFmt(Number(selectedAutoDailyLog.review_flagged_line_count || 0))],
                  ["run_id", selectedAutoDailyLog.run_id || "—"],
                  ["source_document_id", selectedAutoDailyLog.source_document_id || "—"],
                ].map(([label, value]) => (
                  <div key={label} className="rounded-lg border bg-muted/30 p-3">
                    <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{label}</div>
                    <div className="mt-1 break-all font-medium">{value}</div>
                  </div>
                ))}
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="rounded-lg border bg-muted/30 p-3">
                  <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">Dòng ledger</div>
                  <div className="mt-1 text-lg font-semibold">{numberFmt(Number(selectedAutoDailyLog.row_count || 0))}</div>
                </div>
                <div className="rounded-lg border bg-muted/30 p-3">
                  <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">Gross total</div>
                  <div className="mt-1 text-lg font-semibold">{vnd(Number(selectedAutoDailyLog.gross_total || 0))}</div>
                </div>
              </div>
              {selectedAutoDailyLog.error_message ? (
                <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-destructive">
                  <div className="font-medium">Lỗi</div>
                  <div className="mt-1 whitespace-pre-wrap">{selectedAutoDailyLog.error_message}</div>
                </div>
              ) : null}
              <details className="rounded-lg border p-3">
                <summary className="cursor-pointer font-medium">Metadata</summary>
                <pre className="mt-3 max-h-72 overflow-auto rounded border border-border bg-muted/60 p-3 text-xs text-foreground">{JSON.stringify(selectedAutoDailyLog.metadata || {}, null, 2)}</pre>
              </details>
            </div>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={dialogOpen} onOpenChange={(open) => !actionBusy && setDialogOpen(open)}>
        <DialogContent className="max-h-[88vh] overflow-y-auto border-border bg-card text-foreground sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle className="text-foreground">{dialogTitle}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              Ngày doanh thu {formatDate(parseWindow.revenueDateFrom)} • PO/email {formatDate(parseWindow.poReceivedFrom)}.
            </DialogDescription>
          </DialogHeader>

          {parseState === "running" ? (
            <div className="space-y-5 py-6">
              <div className="flex flex-col items-center gap-3 text-center">
                <div className="flex h-20 w-20 items-center justify-center rounded-full border border-primary/20 bg-primary/10">
                  <Loader2 className="h-10 w-10 animate-spin text-primary" />
                </div>
                <div className="space-y-2">
                  <p className="font-medium text-foreground">{parseProgress.message}</p>
                  <p className="text-sm text-muted-foreground">Đang parse PO/email cho ngày đã chọn. Chưa có dòng nào được lưu vào ledger trước khi approve.</p>
                </div>
              </div>

              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  { label: "Channel hiện tại", value: parseProgress.currentChannel || "Mailbox", helper: parseProgress.currentDate ? formatDate(parseProgress.currentDate) : "Đang chuẩn bị" },
                  { label: "Mail fetched", value: numberFmt(parseProgress.totalFetched), helper: parseProgress.synced ? `${numberFmt(parseProgress.totalSynced)} synced` : "Từ Gmail" },
                  { label: "Mail đã parse", value: numberFmt(parseProgress.totalParsedMails), helper: `${numberFmt(parseProgress.totalParsedLines)} dòng preview` },
                  { label: "Ngày xử lý", value: formatDate(parseWindow.revenueDateFrom), helper: parseProgress.stage },
                ].map((item) => (
                  <div key={item.label} className="rounded-xl border border-border bg-card/80 p-3 shadow-sm">
                    <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">{item.label}</div>
                    <div className="mt-1 truncate text-lg font-semibold text-primary" title={String(item.value)}>{item.value}</div>
                    <div className="mt-1 truncate text-xs text-muted-foreground" title={item.helper}>{item.helper}</div>
                  </div>
                ))}
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between text-xs text-muted-foreground">
                  <span>Tiến độ parse ngày</span>
                  <span>Đang xử lý</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div className="h-full w-1/3 animate-pulse rounded-full bg-primary transition-all" />
                </div>
              </div>

              <div className="rounded-xl border border-border bg-card/80 p-4 shadow-sm">
                <div className="mb-3 flex items-center justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">Mail đang parse theo channel</h3>
                    <p className="text-xs text-muted-foreground">Cập nhật live khi backend map từng mail thành dòng preview.</p>
                  </div>
                  <Badge className="border border-primary/20 bg-primary/10 text-primary">{numberFmt(parseProgress.channels.length)} channel</Badge>
                </div>
                <div className="space-y-2">
                  {parseProgress.channels.length > 0 ? parseProgress.channels.map((channel) => (
                    <div key={channel.channel} className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/70 p-3">
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium text-foreground" title={channel.channel}>{channel.channel}</div>
                        <div className="text-xs text-muted-foreground">{numberFmt(channel.lines)} dòng preview</div>
                      </div>
                      <div className="text-right">
                        <div className="text-lg font-semibold tabular-nums text-primary">{numberFmt(channel.mails)}</div>
                        <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">mail</div>
                      </div>
                    </div>
                  )) : (
                    <div className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-muted-foreground">
                      Đang lấy mail từ Gmail; danh sách channel sẽ xuất hiện khi bắt đầu parse inbox.
                    </div>
                  )}
                </div>
              </div>
            </div>
          ) : null}

          {parseState !== "running" && previewSummary ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                {[
                  { label: "Dòng vào ledger", value: numberFmt(previewLedgerRows), helper: `${numberFmt(previewReviewFlags)} flag để edit/audit sau` },
                  { label: "Doanh thu vào dashboard", value: vnd(previewDashboardGross), helper: "Doanh thu đã kiểm soát" },
                  { label: "Sản lượng", value: numberFmt(previewSummary.quantity), helper: "Từ PO/email" },
                  { label: "Customer", value: numberFmt(previewSummary.customers), helper: "Theo customer/NPP" },
                ].map((item) => (
                  <div key={item.label} className="rounded-xl border border-border bg-card/80 p-3 shadow-sm">
                    <div className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">{item.label}</div>
                    <div className="mt-2 truncate text-lg font-semibold text-primary" title={item.value}>{item.value}</div>
                    <div className="mt-1 text-xs text-muted-foreground">{item.helper}</div>
                  </div>
                ))}
              </div>

              {previewReviewFlags > 0 ? (
                <div className="rounded-xl border border-warning/20 bg-warning/10 p-4 text-sm text-warning">
                  {numberFmt(previewReviewFlags)} dòng có parser flag để edit/audit sau. Các flag này không chặn approve: toàn bộ preview ngày sẽ được ghi vào ledger và dashboard.
                </div>
              ) : null}

              {overwritePrompt ? (
                <div className="rounded-xl border border-warning/20 bg-warning/10 p-4 text-sm text-warning">
                  <div className="font-semibold">Đã có kết quả parse cho kỳ {previewSummary.period}</div>
                  <div className="mt-2 space-y-1 text-warning">
                    {overwritePrompt.map((item) => (
                      <div key={item.id}>• {item.sourceName || item.id} {item.importedAt ? `(${new Date(item.importedAt).toLocaleString("vi-VN")})` : ""}</div>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-warning/80">Replace sẽ supersede bản cũ và ghi bản mới vào ledger; dashboard chỉ tính bản mới, không double-count.</p>
                </div>
              ) : null}

              <div className="space-y-3">
                <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-foreground">Summary theo kênh dashboard</h3>
                    <p className="text-xs text-muted-foreground">Tổng hợp theo đúng kênh đang dùng trên dashboard Quản lý doanh thu.</p>
                  </div>
                  <Badge className="w-fit border border-primary/20 bg-primary/10 text-primary">
                    {numberFmt(channelSummaries.length)} kênh
                  </Badge>
                </div>
                {previewTruncated ? (
                  <div className="rounded-xl border border-warning/20 bg-warning/10 p-3 text-xs text-warning">
                    Hệ thống chỉ trả sample 200 dòng đầu cho preview chi tiết, nên số parser flag chỉ hiển thị ở tổng quan ({numberFmt(previewReviewFlags)} flag) thay vì chia theo từng kênh.
                  </div>
                ) : null}
                <div className="grid gap-3">
                  {channelSummaries.map((channel) => (
                    <div key={channel.channel} className="rounded-xl border border-border bg-card/80 p-4 shadow-sm">
                      <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="truncate font-semibold text-foreground" title={channel.label}>{channel.label}</div>
                            <Badge className="border border-border bg-muted/70 text-muted-foreground">{channel.hint}</Badge>
                          </div>
                          <div className="text-xs text-muted-foreground" title={channel.channel}>Mã kênh ledger: {channel.channel}</div>
                        </div>
                        <div className="grid min-w-full gap-2 text-sm sm:grid-cols-4 lg:min-w-[520px]">
                          <div className="rounded-lg border border-border bg-background/70 p-2">
                            <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Doanh thu</div>
                            <div className="mt-1 font-semibold text-primary">{vnd(channel.grossRevenue)}</div>
                          </div>
                          <div className="rounded-lg border border-border bg-background/70 p-2">
                            <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Sản lượng</div>
                            <div className="mt-1 font-semibold text-foreground">{numberFmt(channel.quantity)}</div>
                          </div>
                          <div className="rounded-lg border border-border bg-background/70 p-2">
                            <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Số dòng</div>
                            <div className="mt-1 font-semibold text-foreground">{numberFmt(channel.rows)}</div>
                          </div>
                          <div className="rounded-lg border border-border bg-background/70 p-2">
                            <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Tỷ trọng</div>
                            <div className="mt-1 font-semibold text-foreground">{numberFmt(channel.percent)}%</div>
                          </div>
                        </div>
                      </div>
                      <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full bg-primary" style={{ width: `${Math.min(100, Math.max(0, channel.percent))}%` }} />
                      </div>
                      {channel.needsReview !== null && channel.needsReview > 0 ? (
                        <Badge className="mt-3 border border-warning/20 bg-warning/10 text-warning">
                          {numberFmt(channel.needsReview)} flag edit/audit sau
                        </Badge>
                      ) : null}
                    </div>
                  ))}
                  {channelSummaries.length === 0 ? <div className="rounded-xl border border-border p-4 text-sm text-muted-foreground">Không có dữ liệu summary theo kênh trong kỳ này.</div> : null}
                </div>
              </div>
            </div>
          ) : null}

          {parseState === "approved" ? (
            <div className="rounded-xl border border-success/20 bg-success/10 p-4 text-sm text-success">
              <CheckCircle2 className="mb-2 h-5 w-5" />Đã ghi kết quả parse ngày vào ledger ở trạng thái Doanh thu đã kiểm soát. Dashboard cập nhật ngay; user có thể review/edit sau.
            </div>
          ) : null}

          <DialogFooter className="gap-2 sm:gap-2">
            {parseState === "approved" ? (
              <Button className="btn-gradient text-primary-foreground" onClick={() => window.location.assign(`/finance-control/revenue?period=${previewSummary?.period || parseWindow.period}`)}>
                Open dashboard
              </Button>
            ) : parseState === "preview_ready" || overwritePrompt ? (
              <>
                {overwritePrompt ? (
                  <Button variant="outline" className="border-border bg-background/80 text-foreground hover:bg-muted" onClick={() => setOverwritePrompt(null)} disabled={actionBusy}>
                    Cancel replace
                  </Button>
                ) : (
                  <Button variant="outline" className="border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/15" onClick={() => void rejectPreview()} disabled={actionBusy}>
                    {parseState === "rejecting" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Trash2 className="mr-2 h-4 w-4" />}Reject
                  </Button>
                )}
                <Button className="btn-gradient text-primary-foreground" onClick={() => void approvePreview(Boolean(overwritePrompt))} disabled={actionBusy || !previewRun?.id || !previewSummary || previewLedgerRows <= 0 || previewDashboardGross <= 0 || !canRunAutomation}>
                  {parseState === "approving" ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <ShieldCheck className="mr-2 h-4 w-4" />}
                  {overwritePrompt ? "Replace bản hiện tại & approve" : previewLedgerRows <= 0 ? "Không có dòng để approve" : "Approve & đưa vào dashboard"}
                </Button>
              </>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
