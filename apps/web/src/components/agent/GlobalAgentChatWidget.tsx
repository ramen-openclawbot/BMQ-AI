import { UncImageGallery } from './UncImageGallery';
import { CostBusinessCard } from './CostBusinessCard';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowUp, Loader2, RotateCcw, Sparkles, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useLanguage } from "@/contexts/LanguageContext";
import { chatText } from "@/lib/bmqChatLocale";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";
import { buildAnalyticsRequest, isBoundCostFollowUp, parseAnalyticsResponse, readAnalyticsError, type AnalyticsMessage } from "@/lib/bmqAnalytics";
import {
  appendUniqueFrame,
  buildCurrentPageContext,
  createUserMessageFrame,
  resolveVnagentAgentId,
  resolveVnagentApiUrl,
  timelineFromFrames,
  type ChatTimelineItem,
  type RouteContext,
  type UniversalFrame,
  VNAGENT_PROTOCOL_VERSION,
} from "@/lib/vnagentProtocol";

const ANALYTICS_ENABLED = import.meta.env.VITE_BMQ_ANALYTICS_ENABLED === "true";
const CHAT_CONTEXT_ENABLED = import.meta.env.VITE_BMQ_CHAT_CONTEXT_ENABLED === "true";

const API_URL = resolveVnagentApiUrl(import.meta.env.VITE_VNAGENT_API_URL);
const AGENT_ID = resolveVnagentAgentId(import.meta.env.VITE_VNAGENT_AGENT_ID);
const DEVICE_KEY = "bmq:vnagent:device-id";

const moduleConfig: Array<{ test: (pathname: string) => boolean; context: RouteContext }> = [
  { test: (path) => path === "/mini-crm", context: { key: "crm", label: "CRM", suggestions: ["Tóm tắt khách hàng cần chú ý", "Checklist setup customer", "Tóm tắt module này"] } },
  { test: (path) => path === "/sales-po-inbox", context: { key: "sales_po", label: "Sales PO Inbox", suggestions: ["Tóm tắt PO đang chờ xử lý", "Checklist review delta trước khi post", "Giải thích auto-post an toàn"] } },
  { test: () => true, context: { key: "general", label: "Dashboard", suggestions: ["Tóm tắt màn hình hiện tại", "Đề xuất 3 việc nên làm tiếp", "Tạo checklist vận hành hôm nay"] } },
];

function getRouteContext(pathname: string): RouteContext {
  if (pathname === "/") return { key: "home", label: "Dashboard", suggestions: ["Tóm tắt màn hình hiện tại", "Đề xuất 3 việc nên làm tiếp", "Tạo checklist vận hành hôm nay"] };
  if (pathname.startsWith("/inventory")) return { key: "inventory", label: "Tồn kho", suggestions: ["Kiểm tra mặt hàng sắp hết", "Tóm tắt tồn kho theo nhóm", "Đề xuất nhập hàng hôm nay"] };
  if (pathname.startsWith("/suppliers")) return { key: "suppliers", label: "Nhà cung cấp", suggestions: ["Tìm NCC theo từ khóa", "Checklist đánh giá NCC", "Tóm tắt NCC đang hoạt động"] };
  if (pathname.startsWith("/invoices")) return { key: "invoices", label: "Hóa đơn", suggestions: ["Tìm hóa đơn cần chú ý", "Kiểm tra ảnh hóa đơn/UNC bị thiếu file", "Đề xuất xử lý lỗi invoice"] };
  if (pathname.startsWith("/payment-requests")) return { key: "payment_requests", label: "Đề nghị chi", suggestions: ["Tìm đề nghị chi theo NCC", "Tìm đề nghị chi theo NVL", "Tóm tắt đề nghị chi cần xử lý"] };
  if (pathname.startsWith("/goods-receipts")) return { key: "goods_receipts", label: "Phiếu nhập", suggestions: ["Tóm tắt phiếu nhập hôm nay", "Kiểm tra phiếu lệch số lượng", "Checklist đối soát nhập kho"] };
  if (pathname.startsWith("/purchase-orders")) return { key: "purchase_orders", label: "PO", suggestions: ["Tìm PO chờ xử lý", "Checklist tạo PO", "Đối soát PO với đề nghị chi"] };
  if (pathname.startsWith("/low-stock")) return { key: "low_stock", label: "Sắp hết hàng", suggestions: ["Liệt kê item dưới ngưỡng", "Đề xuất ưu tiên nhập", "Tạo checklist bổ sung tồn"] };
  if (pathname.startsWith("/settings")) return { key: "settings", label: "Cài đặt", suggestions: ["Kiểm tra cấu hình tích hợp", "Checklist cấu hình hệ thống", "Tóm tắt thay đổi gần đây"] };
  if (pathname.startsWith("/sku-costs")) return { key: "sku_costs", label: "SKU Costs", suggestions: ["Checklist cập nhật cost", "Tóm tắt cost anomalies", "Đề xuất kiểm tra tuần này"] };
  if (pathname.startsWith("/kho")) return { key: "warehouse", label: "Kho", suggestions: ["Checklist nhập kho", "Gợi ý kiểm tra tồn", "Tóm tắt thao tác theo ca"] };
  if (pathname === "/finance-control/cost") return { key: "finance_cost", label: "Finance / Cost", suggestions: ["Checklist cost", "KPI cost", "Cảnh báo bất thường"] };
  if (pathname.startsWith("/finance-control/revenue/sources")) return { key: "finance_revenue_sources", label: "Chi tiết nguồn doanh thu", suggestions: ["Dòng nào cần kiểm tra", "So sánh nguồn đối soát và PO", "Gợi ý kiểm tra"] };
  if (pathname === "/finance-control/revenue/daily-review") return { key: "finance_revenue_review", label: "Daily Revenue Review", suggestions: ["Draft cần kiểm tra", "Ngoại lệ hôm nay", "Cách sửa doanh thu"] };
  if (pathname === "/finance-control/revenue/setup") return { key: "finance_revenue_setup", label: "Auto-parse operations", suggestions: ["Job gần nhất", "Snapshot hôm nay", "Lịch chạy 23:59"] };
  if (pathname.startsWith("/finance-control/revenue")) return { key: "finance_revenue", label: "Quản lý doanh thu", suggestions: ["Doanh thu tháng này", "Dòng cần kiểm tra", "Top customer"] };
  return moduleConfig.find((entry) => entry.test(pathname))!.context;
}

function getOrCreateDeviceId(): string {
  const stored = localStorage.getItem(DEVICE_KEY);
  if (stored) return stored;
  const created = crypto.randomUUID();
  localStorage.setItem(DEVICE_KEY, created);
  return created;
}

function extractVnagentToken(payload: unknown): string | null {
  if (typeof payload === "string" && payload.trim()) return payload.trim();
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  for (const key of ["token", "access_token", "accessToken"]) {
    if (typeof record[key] === "string" && record[key]) return String(record[key]);
  }
  return null;
}

function storageKey(userId: string, suffix: "session" | "last-seq"): string {
  return `bmq:vnagent:${userId}:${suffix}`;
}

type VnagentSessionSummary = {
  id: string;
  agentId: string;
  title: string;
  createdAt: string;
};

function formatSessionTime(createdAt: string, language: "en" | "vi"): string {
  const created = new Date(createdAt);
  if (Number.isNaN(created.getTime())) return "";
  return created.toLocaleString(language === "en" ? "en-US" : "vi-VN", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

type RevenueSummary = {
  lineCount?: number;
  rowCount?: number;
  grossRevenue?: number;
  grossTotal?: number;
  quantity?: number;
  channels?: Array<{ channel: string; rows?: number; rowCount?: number; grossRevenue?: number; gross_revenue?: number }>;
};

type RevenueDailyReport = {
  sourceDocumentId: string;
  revenueDate: string;
  period: string;
  summary: RevenueSummary;
};

type RevenueDailyCompare = {
  runId: string;
  revenueDate: string;
  existingReport: RevenueDailyReport | null;
  requiresCancellationConfirmation?: boolean;
  comparison: {
    totals: { delta: { grossRevenue: number; lineCount: number } };
    channels: Array<{
      channel: string;
      current: { grossRevenue: number; rows: number };
      preview: { grossRevenue: number; rows: number };
      delta: { grossRevenue: number; rows: number; quantity: number };
    }>;
  };
};

async function invokeRevenueDailyAction(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke("revenue-monthly-parse-preview", { body });
  if (error) throw new Error(error.message || "Không tải được báo cáo doanh thu daily.");
  return (data || {}) as Record<string, unknown>;
}

function formatVnd(value: number) {
  return `${Number(value || 0).toLocaleString("vi-VN")}đ`;
}

function summaryNumber(summary: RevenueSummary, ...keys: Array<keyof RevenueSummary>) {
  for (const key of keys) {
    const value = Number(summary[key] || 0);
    if (Number.isFinite(value) && value !== 0) return value;
  }
  return 0;
}

function RevenueDailyChatCard({ setOpen }: { setOpen: (open: boolean) => void }) {
  const navigate = useNavigate();
  const { isOwner } = useAuth();
  const [dailyReport, setDailyReport] = useState<RevenueDailyReport | null>(null);
  const [dailyReportLoaded, setDailyReportLoaded] = useState(false);
  const [dailyReportError, setDailyReportError] = useState<string | null>(null);
  const [dailyCompare, setDailyCompare] = useState<RevenueDailyCompare | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isPosting, setIsPosting] = useState(false);

  const loadDailyReport = useCallback(async () => {
    setIsLoading(true);
    setDailyReportError(null);
    try {
      const result = await invokeRevenueDailyAction({ action: "latest_auto_daily_report" });
      setDailyReport((result.report || null) as RevenueDailyReport | null);
      setDailyReportLoaded(true);
    } catch (error) {
      setDailyReportError(error instanceof Error ? error.message : "Không tải được báo cáo daily.");
      setDailyReportLoaded(true);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadDailyReport();
  }, [loadDailyReport]);

  const openDailyLedgerDetail = () => {
    if (!dailyReport) return;
    const params = new URLSearchParams({
      period: dailyReport.period || dailyReport.revenueDate.slice(0, 7),
      sourceDocumentId: dailyReport.sourceDocumentId,
      revenue_date: dailyReport.revenueDate,
    });
    setOpen(false);
    navigate(`/finance-control/revenue/sources?${params.toString()}`);
  };

  const runDailyCompare = async () => {
    setIsLoading(true);
    setDailyReportError(null);
    try {
      const result = await invokeRevenueDailyAction({
        action: "preview_daily_compare",
        ...(dailyReport?.revenueDate ? { revenueDate: dailyReport.revenueDate } : {}),
      });
      setDailyCompare({
        runId: String(result.runId || ""),
        revenueDate: String(result.revenueDate || ""),
        existingReport: (result.existingReport || null) as RevenueDailyReport | null,
        requiresCancellationConfirmation: result.requiresCancellationConfirmation === true,
        comparison: result.comparison as RevenueDailyCompare["comparison"],
      });
    } catch (error) {
      setDailyReportError(error instanceof Error ? error.message : "Không chạy được preview daily.");
    } finally {
      setIsLoading(false);
    }
  };

  const confirmDailyCompare = async () => {
    if (!dailyCompare?.runId) return;
    setIsPosting(true);
    setDailyReportError(null);
    try {
      await invokeRevenueDailyAction({
        action: "confirm_daily_overwrite",
        runId: dailyCompare.runId,
        ...(dailyCompare.requiresCancellationConfirmation ? { confirmCancelReplacement: true } : {}),
      });
      setDailyCompare(null);
      await loadDailyReport();
    } catch (error) {
      setDailyReportError(error instanceof Error ? error.message : "Không ghi được daily revenue.");
    } finally {
      setIsPosting(false);
    }
  };

  const cancelDailyCompare = async () => {
    const runId = dailyCompare?.runId;
    setDailyCompare(null);
    if (runId) await invokeRevenueDailyAction({ action: "cancel_daily_preview", runId }).catch(() => undefined);
  };

  return (
    <div className="space-y-3 rounded-2xl border border-[#21252e] bg-[#0b0d11] p-3 text-[#f5f6f7]">
      <div className="flex items-start justify-between gap-3">
        <div><div className="text-xs text-[#8a8f98]">Auto daily cron report</div><div className="font-semibold">Doanh thu tạm kiểm soát</div></div>
        {isLoading ? <Loader2 className="mt-1 h-4 w-4 animate-spin text-[#8a8f98]" /> : null}
      </div>
      {dailyReportError ? <div className="text-xs text-red-300">{dailyReportError}</div> : null}
      {dailyReportLoaded && dailyReport ? (
        <>
          <div className="space-y-2 rounded-xl border border-[#21252e] bg-black p-3">
            <div className="flex justify-between gap-2"><span className="text-[#8a8f98]">Ngày doanh thu</span><b>{dailyReport.revenueDate}</b></div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-lg bg-[#11141a] p-2"><div className="text-[#8a8f98]">Gross</div><b>{formatVnd(summaryNumber(dailyReport.summary, "grossRevenue", "grossTotal"))}</b></div>
              <div className="rounded-lg bg-[#11141a] p-2"><div className="text-[#8a8f98]">Dòng / SL</div><b>{summaryNumber(dailyReport.summary, "lineCount", "rowCount")} / {summaryNumber(dailyReport.summary, "quantity")}</b></div>
            </div>
            <div className="text-xs text-amber-300">Số này là tạm kiểm soát, chưa phải trusted/month-end audited source.</div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" variant="outline" onClick={openDailyLedgerDetail}>Ledger chi tiết</Button>
            {isOwner ? (
              <Button type="button" size="sm" onClick={() => void runDailyCompare()} disabled={isLoading || isPosting}>Chạy parse daily</Button>
            ) : <div className="text-xs text-[#8a8f98]">Chỉ owner mới được chạy lại parse daily</div>}
          </div>
        </>
      ) : null}
      {dailyReportLoaded && !dailyReport && !isLoading ? (
        <div className="space-y-2 text-xs text-[#8a8f98]">
          <div>Chưa tìm thấy auto daily cron source đang active.</div>
          {isOwner ? (
            <Button type="button" size="sm" onClick={() => void runDailyCompare()}>Chạy parse daily</Button>
          ) : <div>Chỉ owner mới được chạy lại parse daily</div>}
        </div>
      ) : null}
      {dailyCompare?.comparison ? (
        <div className="space-y-2 rounded-xl border border-[#21252e] bg-black p-3">
          <div className="font-medium">{dailyCompare.existingReport ? "So sánh daily revenue hiện tại" : "Chưa có daily revenue cho ngày này"}</div>
          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className="rounded-lg bg-[#11141a] p-2">Gross delta<br /><b>{formatVnd(dailyCompare.comparison.totals.delta.grossRevenue)}</b></div>
            <div className="rounded-lg bg-[#11141a] p-2">Dòng delta<br /><b>{dailyCompare.comparison.totals.delta.lineCount}</b></div>
          </div>
          <div className="max-h-40 space-y-1 overflow-auto">
            {dailyCompare.comparison.channels.map((channel) => (
              <div key={channel.channel} className="rounded-lg border border-[#21252e] px-2 py-1 text-xs">
                <b>{channel.channel}</b><div className="text-[#8a8f98]">Gross {formatVnd(channel.current.grossRevenue)} → {formatVnd(channel.preview.grossRevenue)}</div>
              </div>
            ))}
          </div>
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={() => void confirmDailyCompare()} disabled={isPosting}>{dailyCompare.existingReport ? "Confirm overwrite" : "Confirm ghi ledger"}</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => void cancelDailyCompare()} disabled={isPosting}>Hủy</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

// chat.vnagent.ai mark (favicon-vnagent-v2): lime "V" over a red bar. It sits on an
// ink surface supplied by its container, so it never shows square corners in a circle.
function VnagentMark({ className = "h-full w-full" }: { className?: string } = {}) {
  return (
    <svg className={className} viewBox="0 0 32 32" role="img" aria-label="Logo VNAgent" data-vnagent-mark="ink-lime-v2">
      <path d="M6.5 7.5h5.6L16 19.4l3.9-11.9h5.6L19 24h-6Z" className="fill-vn-lime" />
      <rect x="9" y="25.5" width="14" height="2.5" className="fill-vn-red" />
    </svg>
  );
}

export function GlobalAgentChatWidget() {
  const { language } = useLanguage();
  const text = useCallback((value: string) => chatText(value, language), [language]);
  const location = useLocation();
  const { authzLoaded, isOwner, session, user, profile } = useAuth();
  const greetingName = user && profile?.user_id === user.id ? profile.full_name?.trim() : "";
  const greeting = `${language === "en" ? "Hello" : "Xin chào"}${greetingName ? `, ${greetingName}` : ""}.`;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [analyticsMessages, setAnalyticsMessages] = useState<AnalyticsMessage[]>([]);
  const analyticsRequestRef = useRef<AbortController | null>(null);
  const analyticsIdentityRef = useRef<string | null>(null);
  // The current analytics conversation id: the server binds the signed cost
  // context to it, so a new/reset/account-switch conversation cannot replay state.
  const analyticsConversationRef = useRef<string>("");
  const [frames, setFrames] = useState<UniversalFrame[]>([]);
  const [streamedText, setStreamedText] = useState("");
  const [vnagentToken, setVnagentToken] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [recentSessions, setRecentSessions] = useState<VnagentSessionSummary[]>([]);
  const [sessionChoiceRequired, setSessionChoiceRequired] = useState(false);
  const [selectingSessionId, setSelectingSessionId] = useState<string | null>(null);
  const [connection, setConnection] = useState<"idle" | "authenticating" | "connecting" | "connected" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isResponding, setIsResponding] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const lastSeqRef = useRef(0);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const composerObserverRef = useRef<ResizeObserver | null>(null);
  const resizeComposer = useCallback(() => {
    const node = composerRef.current;
    if (!node) return;
    const lineHeight = 24;
    const viewportHeight = window.visualViewport?.height ?? window.innerHeight;
    const maxHeight = Math.max(lineHeight * 2, Math.floor(Math.min(240, viewportHeight * 0.3) / lineHeight) * lineHeight);
    node.style.height = "0px";
    node.style.height = `${Math.min(Math.max(lineHeight, node.scrollHeight), maxHeight)}px`;
    node.style.overflowY = node.scrollHeight > maxHeight ? "auto" : "hidden";
  }, []);
  const attachComposer = useCallback((node: HTMLTextAreaElement | null) => {
    composerObserverRef.current?.disconnect();
    composerRef.current = node;
    if (!node) return;
    resizeComposer();
    let width = node.clientWidth;
    composerObserverRef.current = new ResizeObserver(() => {
      if (node.clientWidth === width) return;
      width = node.clientWidth;
      resizeComposer();
    });
    composerObserverRef.current.observe(node);
  }, [resizeComposer]);
  useLayoutEffect(() => { resizeComposer(); }, [draft, resizeComposer]);
  useEffect(() => {
    window.addEventListener("resize", resizeComposer);
    window.visualViewport?.addEventListener("resize", resizeComposer);
    return () => {
      window.removeEventListener("resize", resizeComposer);
      window.visualViewport?.removeEventListener("resize", resizeComposer);
    };
  }, [resizeComposer]);
  const endRef = useRef<HTMLDivElement | null>(null);
  const enabled = authzLoaded && isOwner && Boolean(session?.access_token && user?.id);
  const routeContext = useMemo(() => {
    const context = getRouteContext(location.pathname);
    return { ...context, label: chatText(context.label, language) };
  }, [location.pathname, language]);
  const timeline = useMemo<ChatTimelineItem[]>(() => ANALYTICS_ENABLED
    ? analyticsMessages.map((item) => ({ kind: "message", id: item.id, role: item.role === "assistant" ? "agent" : "user", text: item.text }))
    : timelineFromFrames(frames), [analyticsMessages, frames]);
  const suggestions = ANALYTICS_ENABLED
    ? ["Doanh thu hôm nay", "Số PO hôm nay", "Hàng sắp hết", "Công nợ NCC hiện tại"]
    : routeContext.suggestions;
  const localizedSuggestions = suggestions.map(text);
  const chatReady = ANALYTICS_ENABLED ? enabled : connection === "connected";
  // Isolate temporary analytics from shared adapter history and account changes.
  useLayoutEffect(() => {
    if (!ANALYTICS_ENABLED) return;
    analyticsIdentityRef.current = enabled ? user?.id ?? null : null;
    if (enabled) analyticsConversationRef.current = crypto.randomUUID();
    analyticsRequestRef.current?.abort();
    analyticsRequestRef.current = null;
    setAnalyticsMessages([]);
    setDraft("");
    setErrorMessage(null);
    setIsResponding(false);
    return () => {
      analyticsIdentityRef.current = null;
      analyticsRequestRef.current?.abort();
      analyticsRequestRef.current = null;
    };
  }, [enabled, user?.id]);
  const visibleTimeline = useMemo(() => timeline.filter((item) => item.kind !== "tool"), [timeline]);
  // Only the newest assistant turn can resolve a "this line" follow-up server-side
  // (the signed context is read from the immediately preceding assistant message),
  // so an older card's follow-up is disabled instead of silently hitting a newer row.
  const lastAssistantId = useMemo(() => {
    for (let index = analyticsMessages.length - 1; index >= 0; index -= 1) {
      if (analyticsMessages[index].role === "assistant") return analyticsMessages[index].id;
    }
    return null;
  }, [analyticsMessages]);
  const costFollowUpQuestion = language === "en" ? "Why is this line classified this way?" : "Vì sao dòng này?";
  const showQuickActions = !sessionChoiceRequired && !sessionId && visibleTimeline.length === 0 && !streamedText && !isResponding;
  const isRevenueMobileContext = location.pathname.startsWith("/finance-control/revenue");
  const isSkuCostsMobileContext = location.pathname.startsWith("/sku-costs");
  const isPurchaseOrdersMobileContext = location.pathname.startsWith("/purchase-orders");
  const isProductionProductsMobileContext = location.pathname.startsWith("/production/products");
  const isPaymentRequestsMobileContext = location.pathname.startsWith("/payment-requests");
  const shouldLiftMobileChatButton = isRevenueMobileContext || isSkuCostsMobileContext || isPurchaseOrdersMobileContext || isProductionProductsMobileContext;

  const rememberFrame = useCallback((frame: UniversalFrame) => {
    if (typeof frame.seq === "number" && user?.id) {
      lastSeqRef.current = Math.max(lastSeqRef.current, frame.seq);
      localStorage.setItem(storageKey(user.id, "last-seq"), String(lastSeqRef.current));
    }
    setFrames((current) => appendUniqueFrame(current, frame));
  }, [user?.id]);

  useEffect(() => {
    if (ANALYTICS_ENABLED || !enabled || !session?.access_token || !user?.id) {
      setVnagentToken(null);
      sessionIdRef.current = null;
      setSessionId(null);
      setRecentSessions([]);
      setSessionChoiceRequired(false);
      setFrames([]);
      setConnection("idle");
      return;
    }

    const controller = new AbortController();
    const bootstrap = async () => {
      setConnection("authenticating");
      setErrorMessage(null);
      try {
        const authResponse = await fetch(`${API_URL}/v1/auth/bmq`, {
          method: "POST",
          headers: { Authorization: `Bearer ${session.access_token}` },
          signal: controller.signal,
        });
        if (!authResponse.ok) throw new Error(authResponse.status === 401 || authResponse.status === 403 ? "Tài khoản chưa được VNAgent xác nhận quyền owner." : "Không xác thực được với VNAgent.");
        const token = extractVnagentToken(await authResponse.json());
        if (!token) throw new Error("VNAgent không trả về phiên truy cập hợp lệ.");

        const agentsResponse = await fetch(`${API_URL}/v1/agents`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!agentsResponse.ok) throw new Error("Không tải được agent được cấp quyền.");
        const agents = await agentsResponse.json() as Array<{ id?: string }>;
        if (!agents.some((agent) => agent.id === AGENT_ID)) throw new Error(`Agent ${AGENT_ID} chưa được cấp quyền cho BMQ.`);

        const sessionsResponse = await fetch(`${API_URL}/v1/sessions`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        });
        if (!sessionsResponse.ok) throw new Error("Không tải được danh sách cuộc trò chuyện VNAgent.");
        const sessions = await sessionsResponse.json() as VnagentSessionSummary[];
        const latestSessions = sessions
          .filter((candidate) => candidate.agentId === AGENT_ID)
          .sort((left, right) => new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime())
          .slice(0, 3);
        setRecentSessions(latestSessions);
        setSessionChoiceRequired(latestSessions.length > 0);
        setFrames([]);
        sessionIdRef.current = null;
        setSessionId(null);
        lastSeqRef.current = 0;
        setVnagentToken(token);
        setConnection("connecting");
      } catch (error) {
        if (controller.signal.aborted) return;
        setConnection("error");
        setErrorMessage(error instanceof Error ? error.message : "Không kết nối được VNAgent.");
      }
    };
    void bootstrap();
    return () => controller.abort();
  }, [enabled, session?.access_token, user?.id]);

  const continueSession = useCallback(async (selectedSessionId: string) => {
    if (!vnagentToken || !user?.id || selectingSessionId) return;
    setSelectingSessionId(selectedSessionId);
    setErrorMessage(null);
    try {
      const historyResponse = await fetch(`${API_URL}/v1/sessions/${encodeURIComponent(selectedSessionId)}/messages`, {
        headers: { Authorization: `Bearer ${vnagentToken}` },
      });
      if (!historyResponse.ok) throw new Error(historyResponse.status === 404 ? "Cuộc trò chuyện này không còn tồn tại." : "Không tải được lịch sử VNAgent.");
      const history = await historyResponse.json() as UniversalFrame[];
      const latestSeq = history.reduce((max, frame) => typeof frame.seq === "number" ? Math.max(max, frame.seq) : max, 0);
      setFrames(history);
      setStreamedText("");
      setIsResponding(false);
      lastSeqRef.current = latestSeq;
      sessionIdRef.current = selectedSessionId;
      setSessionId(selectedSessionId);
      localStorage.setItem(storageKey(user.id, "session"), selectedSessionId);
      localStorage.setItem(storageKey(user.id, "last-seq"), String(latestSeq));
      setSessionChoiceRequired(false);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Không tiếp tục được cuộc trò chuyện.");
    } finally {
      setSelectingSessionId(null);
    }
  }, [selectingSessionId, user?.id, vnagentToken]);

  const startNewConversation = useCallback(() => {
    if (!user?.id) return;
    sessionIdRef.current = null;
    lastSeqRef.current = 0;
    setSessionId(null);
    setFrames([]);
    setStreamedText("");
    setIsResponding(false);
    setErrorMessage(null);
    localStorage.removeItem(storageKey(user.id, "session"));
    localStorage.removeItem(storageKey(user.id, "last-seq"));
    setSessionChoiceRequired(false);
  }, [user?.id]);

  // Analytics conversations are temporary; this drops the timeline and the
  // bounded cost context with it, and aborts any in-flight reply.
  const resetAnalyticsConversation = useCallback(() => {
    analyticsRequestRef.current?.abort();
    analyticsRequestRef.current = null;
    // A new conversation id guarantees the discarded signed state can never be
    // replayed into the fresh conversation.
    analyticsConversationRef.current = crypto.randomUUID();
    setAnalyticsMessages([]);
    setDraft("");
    setErrorMessage(null);
    setIsResponding(false);
  }, []);

  useEffect(() => {
    if (ANALYTICS_ENABLED || !vnagentToken || !enabled) return;
    let stopped = false;
    let reconnectTimer: number | undefined;

    const connect = () => {
      if (stopped) return;
      setConnection("connecting");
      const socket = new WebSocket(`${API_URL.replace(/^http/, "ws")}/v1/ws`);
      wsRef.current = socket;
      socket.onopen = () => {
        const resumeSessionId = sessionIdRef.current;
        socket.send(JSON.stringify({
          v: VNAGENT_PROTOCOL_VERSION,
          type: "hello",
          deviceId: getOrCreateDeviceId(),
          token: vnagentToken,
          surface: "web",
          ...(resumeSessionId ? { resume: { sessionId: resumeSessionId, lastSeq: lastSeqRef.current } } : {}),
          caps: { display: "full", input: ["text"], supportsMarkdown: true, maxReplyChars: 6000 },
        }));
      };
      socket.onmessage = (event) => {
        let frame: UniversalFrame;
        try {
          frame = JSON.parse(String(event.data)) as UniversalFrame;
        } catch {
          return;
        }
        if (frame.type === "hello_ack") {
          setConnection("connected");
          setErrorMessage(null);
          return;
        }
        const activeSessionId = sessionIdRef.current;
        if (frame.sessionId && activeSessionId && frame.sessionId !== activeSessionId) return;
        if (frame.type === "agent_typing") {
          setIsResponding(true);
          return;
        }
        if (frame.type === "agent_token") {
          setIsResponding(true);
          setStreamedText((current) => current + String(frame.delta || ""));
          return;
        }
        if (["user_message_saved", "agent_tool", "agent_message_done", "error"].includes(frame.type)) {
          rememberFrame(frame);
        }
        if (frame.type === "agent_message_done" || frame.type === "error") {
          setStreamedText("");
          setIsResponding(false);
        }
      };
      socket.onerror = () => socket.close();
      socket.onclose = () => {
        if (wsRef.current === socket) wsRef.current = null;
        if (stopped) return;
        setConnection("connecting");
        reconnectTimer = window.setTimeout(connect, 1500);
      };
    };
    connect();
    return () => {
      stopped = true;
      if (reconnectTimer) window.clearTimeout(reconnectTimer);
      const socket = wsRef.current;
      wsRef.current = null;
      socket?.close();
    };
  }, [enabled, rememberFrame, vnagentToken]);

  useEffect(() => {
    const openAgentChat = () => {
      if (enabled) setOpen(true);
    };
    window.addEventListener("bmq:open-agent-chat", openAgentChat);
    return () => window.removeEventListener("bmq:open-agent-chat", openAgentChat);
  }, [enabled]);

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ block: "end" });
  }, [frames, analyticsMessages, open, streamedText, isResponding]);

  const ensureSession = useCallback(async (title: string): Promise<string> => {
    if (sessionIdRef.current) return sessionIdRef.current;
    if (!vnagentToken || !user?.id) throw new Error("VNAgent chưa sẵn sàng.");
    const response = await fetch(`${API_URL}/v1/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${vnagentToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ agentId: AGENT_ID, title: title.slice(0, 100) || "BMQ — VNAgent" }),
    });
    if (!response.ok) throw new Error("Không tạo được phiên VNAgent.");
    const created = await response.json() as { id?: string };
    if (!created.id) throw new Error("VNAgent không trả về mã phiên.");
    localStorage.setItem(storageKey(user.id, "session"), created.id);
    localStorage.setItem(storageKey(user.id, "last-seq"), "0");
    lastSeqRef.current = 0;
    sessionIdRef.current = created.id;
    setSessionId(created.id);
    return created.id;
  }, [user?.id, vnagentToken]);

  const sendMessage = useCallback(async (text?: string) => {
    const content = String(text ?? draft).trim();
    if (ANALYTICS_ENABLED) {
      if (!content || !enabled || !user?.id || analyticsRequestRef.current) return;
      if (content.length > 2000) {
        setErrorMessage("Câu hỏi tối đa 2.000 ký tự. Anh rút gọn rồi gửi lại nhé.");
        return;
      }
      const controller = new AbortController();
      const requestUser = user.id;
      analyticsRequestRef.current = controller;
      const active = () => !controller.signal.aborted && analyticsRequestRef.current === controller && analyticsIdentityRef.current === requestUser;
      const id = crypto.randomUUID();
      const currentPage = buildCurrentPageContext(location.pathname, location.search, routeContext);
      const body = buildAnalyticsRequest(content, location.pathname, routeContext.label, analyticsMessages, currentPage.searchParams, language, CHAT_CONTEXT_ENABLED ? analyticsConversationRef.current : undefined);
      setAnalyticsMessages((current) => [...current, { id, role: "user", text: content }]);
      setDraft("");
      setErrorMessage(null);
      setIsResponding(true);
      const timeout = window.setTimeout(() => {
        if (!active()) return;
        controller.abort();
        analyticsRequestRef.current = null;
        setAnalyticsMessages((current) => current.filter((item) => item.id !== id));
        setDraft(content);
        setErrorMessage("BMQ phản hồi quá lâu. Nội dung đã được giữ lại để anh gửi lại.");
        setIsResponding(false);
      }, 45000);
      try {
        // SDK supplies current Supabase auth; analytics never uses adapter credentials.
        const { data, error } = await supabase.functions.invoke("bmq-analytics", { body, headers: { "Accept-Language": language }, signal: controller.signal });
        if (!active()) return;
        if (error) throw new Error(await readAnalyticsError(error, language));
        const result = parseAnalyticsResponse(data, language);
        setAnalyticsMessages((current) => [...current, { id: result.requestId, role: "assistant", text: result.answer, images: result.provenance.images, details: result.provenance.details, fx: result.provenance.fx, citations: result.provenance.citations, customerSelection: result.provenance.customerSelection, costContext: CHAT_CONTEXT_ENABLED ? result.provenance.costContext : undefined, costBlock: result.provenance.costBlock }]);
      } catch (error) {
        if (!active()) return;
        setAnalyticsMessages((current) => current.filter((item) => item.id !== id));
        setDraft(content);
        setErrorMessage(error instanceof Error ? error.message : "Không gửi được câu hỏi tới BMQ.");
      } finally {
        window.clearTimeout(timeout);
        if (active()) {
          analyticsRequestRef.current = null;
          setIsResponding(false);
        }
      }
      return;
    }
    const initialSocket = wsRef.current;
    if (!content || sessionChoiceRequired || connection !== "connected" || !initialSocket || initialSocket.readyState !== WebSocket.OPEN || isResponding) return;
    setDraft("");
    setErrorMessage(null);
    try {
      const activeSessionId = await ensureSession(content);
      const id = crypto.randomUUID();
      const currentPage = buildCurrentPageContext(location.pathname, location.search, routeContext);
      const outgoing = createUserMessageFrame({ id, sessionId: activeSessionId, agentId: AGENT_ID, text: content, currentPage });
      rememberFrame({ ...outgoing, type: "user_message_saved", synthetic: true });
      const socket = wsRef.current;
      if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Kết nối VNAgent vừa bị gián đoạn. Vui lòng gửi lại.");
      setIsResponding(true);
      socket.send(JSON.stringify(outgoing));
    } catch (error) {
      setIsResponding(false);
      setErrorMessage(error instanceof Error ? error.message : "Không gửi được tin nhắn.");
    }
  }, [language, analyticsMessages, enabled, user?.id, connection, draft, ensureSession, isResponding, location.pathname, location.search, rememberFrame, routeContext, sessionChoiceRequired]);

  if (!enabled) return null;

  return (
    <>
      <Button
        type="button"
        size="icon"
        data-vnagent-launcher="logo-motion-v2"
        data-vnagent-logo-background="ink-v2"
        className={cn(
          "fixed z-50 rounded-full border border-vn-paper/[.18] bg-vn-ink shadow-[0_10px_28px_rgba(12,12,18,0.35)] transition-colors hover:border-vn-lime hover:bg-vn-ink focus-visible:ring-2 focus-visible:ring-vn-lime focus-visible:ring-offset-2 [&_svg]:!h-full [&_svg]:!w-full",
          shouldLiftMobileChatButton
            ? "bottom-[calc(5rem+env(safe-area-inset-bottom))] right-3 h-11 w-11 sm:bottom-[calc(1.5rem+env(safe-area-inset-bottom))] sm:right-6 sm:h-14 sm:w-14"
            : "right-6 bottom-[calc(1.5rem+env(safe-area-inset-bottom))] h-14 w-14",
          isPaymentRequestsMobileContext && "hidden lg:inline-flex",
        )}
        onClick={() => setOpen(true)}
        aria-label={text("Mở VNAgent")}
      >
        <span
          aria-hidden="true"
          className={cn(
            "pointer-events-none absolute inset-0 -z-10 rounded-full ring-2 ring-vn-lime/50",
            !open && "animate-vnagent-halo motion-reduce:animate-none",
          )}
        />
        <span
          className={cn(
            "grid h-[72%] w-[72%] place-items-center",
            !open && "animate-vnagent-throb motion-reduce:animate-none",
          )}
        >
          <VnagentMark className="h-full w-full" />
        </span>
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          data-bmq-analytics={ANALYTICS_ENABLED ? "hybrid-v1" : undefined}
          data-vnagent-branding="owner-chat-v1"
          data-vnagent-locale="app-language-v1"
          lang={language}
          data-vnagent-ui="chat-v2-clean"
          data-vnagent-theme="vn-2026-10"
          side="right"
          className="flex w-full flex-col gap-0 overflow-hidden border-l border-vn-paper/10 bg-vn-ink p-0 font-vnDisp text-vn-paper shadow-[0_20px_50px_rgba(0,0,0,0.5)] [&>button]:hidden sm:w-[440px] sm:max-w-[440px]"
        >
          <header className="relative flex shrink-0 items-center gap-3 border-b border-vn-paper/10 bg-vn-ink/90 px-4 pb-3 pt-[max(0.875rem,env(safe-area-inset-top))] backdrop-blur-md">
            <div className="flex min-w-0 flex-1 items-center gap-2.5" aria-label={text("VNAgent — Trợ lý AI của BMQ")}>
              <div className="min-w-0">
                <SheetTitle data-vnagent-wordmark="vn-agent-v2" className="text-[19px] font-black leading-none tracking-[-0.02em] text-vn-paper [font-stretch:125%]">VN<span className="text-vn-red">AGENT</span></SheetTitle>
                <div data-vnagent-status-line className="mt-2 flex min-w-0 items-center gap-1.5 whitespace-nowrap font-vnMono text-[9.5px] uppercase tracking-[0.14em] text-vn-paper/50">
                  <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", chatReady ? "bg-vn-online shadow-[0_0_0_3px_rgba(61,220,132,0.18)]" : connection === "error" ? "bg-vn-red" : "animate-pulse bg-vn-lime")} />
                  <span className="min-w-0 truncate">{text(chatReady ? (ANALYTICS_ENABLED ? "Sẵn sàng" : "Đã kết nối") : connection === "error" ? "Mất kết nối" : "Đang kết nối")} · {text("Trợ lý AI của BMQ")}</span>
                </div>
              </div>
            </div>
            {ANALYTICS_ENABLED ? (
              <button
                type="button"
                data-bmq-conversation-reset="analytics-v1"
                className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-vn-paper/[.18] bg-vn-card text-vn-paper/70 transition hover:border-vn-lime hover:text-vn-paper"
                onClick={resetAnalyticsConversation}
                aria-label={text("Tạo cuộc trò chuyện mới")}
              ><RotateCcw className="h-[18px] w-[18px]" /></button>
            ) : null}
            <button type="button" className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-vn-paper/[.18] bg-vn-card text-vn-paper/70 transition hover:border-vn-lime hover:text-vn-paper" onClick={() => setOpen(false)} aria-label={text("Đóng VNAgent")}><X className="h-5 w-5" /></button>
          </header>

          <div className="flex flex-1 flex-col gap-4 overflow-auto bg-vn-ink px-4 py-5 text-[15px] leading-[1.62]">
            {ANALYTICS_ENABLED && <p className="text-center font-vnMono text-[10px] uppercase tracking-[0.1em] text-vn-paper/45">{text("Trò chuyện tạm thời · Xóa khi tải lại trang hoặc đăng xuất")}</p>}
            {sessionChoiceRequired ? (
              <div data-vnagent-session-picker="recent-3" className="space-y-3 rounded-2xl border border-vn-paper/[.18] bg-vn-card p-4">
                <div>
                  <div className="font-bold text-vn-paper">{text("Tiếp tục cuộc trò chuyện")}</div>
                  <div className="mt-1 text-xs text-vn-paper/60">{text("Chọn một trong 3 cuộc trò chuyện gần nhất hoặc bắt đầu cuộc trò chuyện mới.")}</div>
                </div>
                <div className="space-y-2">
                  {recentSessions.map((recentSession) => (
                    <button
                      key={recentSession.id}
                      type="button"
                      className="flex w-full items-center justify-between gap-3 rounded-xl border border-vn-paper/10 bg-vn-card2 px-3 py-3 text-left transition hover:border-vn-lime disabled:opacity-60"
                      onClick={() => void continueSession(recentSession.id)}
                      disabled={Boolean(selectingSessionId)}
                    >
                      <span className="min-w-0">
                        <span className="block truncate text-sm font-semibold text-vn-paper">{recentSession.title || text("Cuộc trò chuyện mới")}</span>
                        <span className="mt-0.5 block font-vnMono text-[10px] tracking-[0.06em] text-vn-paper/50">{formatSessionTime(recentSession.createdAt, language)}</span>
                      </span>
                      <span className="shrink-0 text-xs font-bold text-vn-lime">{text(selectingSessionId === recentSession.id ? "Đang tải…" : "Tiếp tục")}</span>
                    </button>
                  ))}
                </div>
                <Button type="button" variant="outline" className="w-full rounded-xl border-vn-lime/35 bg-vn-lime/[.06] font-bold text-vn-lime hover:bg-vn-lime/[.12] hover:text-vn-lime" onClick={startNewConversation} disabled={Boolean(selectingSessionId)}>{text("Tạo cuộc trò chuyện mới")}</Button>
              </div>
            ) : visibleTimeline.length === 0 && !streamedText && (
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-[10px] border border-vn-cobalt-l/30 bg-vn-cobalt-l/10 text-vn-lime"><Sparkles className="h-4 w-4" /></span>
                <div data-chat-greeting="profile-v1" className="max-w-[88%] rounded-2xl rounded-tl-[5px] border border-vn-paper/10 bg-vn-card px-4 py-3 text-vn-paper">{greeting} {language === "en" ? "You are viewing " : "VNAgent đã nhận diện màn hình hiện tại là "}<b>{routeContext.label}</b>{language === "en" ? ". How can VNAgent help?" : ". Bạn cần VNAgent hỗ trợ việc gì?"}</div>
              </div>
            )}
            {!ANALYTICS_ENABLED && isRevenueMobileContext ? <RevenueDailyChatCard setOpen={setOpen} /> : null}
            {visibleTimeline.map((item) => {
              const analyticsMessage = ANALYTICS_ENABLED ? analyticsMessages.find((message) => message.id === item.id) : undefined;
              const costBlock = item.role === "agent" ? analyticsMessage?.costBlock : undefined;
              const followUpBound = Boolean(costBlock?.followUp)
                && item.id === lastAssistantId
                && isBoundCostFollowUp(analyticsMessage?.costContext, { userId: user?.id, conversationId: analyticsConversationRef.current, classificationId: costBlock?.line.classificationId });
              const followUpEnabled = followUpBound && !isResponding;
              const followUpDisabledReason = isResponding ? undefined
                : !costBlock?.followUp ? (language === "en" ? "This line has no reusable reference." : "Dòng này không có mã tham chiếu để hỏi tiếp.")
                : item.id !== lastAssistantId ? (language === "en" ? "Only the newest line in this conversation can be asked about." : "Chỉ dòng mới nhất trong cuộc trò chuyện mới hỏi tiếp được.")
                : (language === "en" ? "The signed context expired or no longer matches this conversation. Ask for a new example line." : "Ngữ cảnh đã hết hạn hoặc không còn khớp cuộc trò chuyện này. Anh yêu cầu một dòng ví dụ mới nhé.");
              return (
              <div key={item.id} className={cn(
                "break-words",
                costBlock ? "w-full max-w-[92%] self-start"
                  : item.role === "user" ? "max-w-[82%] whitespace-pre-wrap self-end rounded-2xl rounded-br-[5px] bg-vn-cobalt px-4 py-3 text-white shadow-[0_8px_24px_rgba(42,47,240,0.25)] motion-reduce:shadow-none"
                  : item.role === "system" ? "whitespace-pre-wrap self-center rounded-xl border border-vn-red/40 bg-vn-red/10 px-3 py-2 text-xs text-vn-paper/90"
                  : "max-w-[92%] whitespace-pre-wrap self-start rounded-2xl rounded-tl-[5px] border border-vn-paper/10 bg-vn-card px-4 py-3 text-vn-paper",
              )}>
                {item.role === "system" ? <span className="sr-only">{text("Hệ thống: ")}</span> : null}
                {costBlock ? (
                  <CostBusinessCard
                    block={costBlock}
                    language={language}
                    followUpEnabled={followUpEnabled}
                    followUpDisabledReason={followUpDisabledReason}
                    onFollowUp={() => { if (followUpEnabled) void sendMessage(costFollowUpQuestion); }}
                  />
                ) : item.text}
                {ANALYTICS_ENABLED && item.role === "agent" && user?.id ? <UncImageGallery key={`${user.id}:${item.id}`} ownerId={user.id} language={language} images={analyticsMessage?.images} /> : null}
                {ANALYTICS_ENABLED && item.role === "agent" && analyticsMessage?.details ? (
                  <details className="mt-3 border-t border-vn-paper/10 pt-2 text-xs text-vn-paper/80" data-bmq-answer-details="business-money-v1">
                    <summary className="cursor-pointer font-semibold text-vn-lime">{language === "en" ? "View details" : "Xem chi tiết"}</summary>
                    <div className="mt-2 whitespace-pre-wrap break-words">{analyticsMessage.details}</div>
                    {analyticsMessage.fx ? <a className="mt-2 block underline" href="https://www.exchangerate-api.com" target="_blank" rel="noopener noreferrer">Rates by ExchangeRate-API</a> : null}
                  </details>
                ) : null}
                {ANALYTICS_ENABLED && item.role === "agent" && analyticsMessage?.citations?.length ? (
                  <details className="mt-3 border-t border-vn-paper/10 pt-2 text-xs text-vn-paper/80" data-bmq-knowledge-citations="v1">
                    <summary className="cursor-pointer font-semibold text-vn-lime">{language === "en" ? "Sources" : "Nguồn tham khảo"}</summary>
                    <ul className="mt-2 space-y-2">
                      {analyticsMessage.citations.map((citation, index) => <li key={citation.id}><span className="font-medium">[{index + 1}] {citation.title}</span><br />{citation.source} · {language === "en" ? "Updated" : "Cập nhật"}: {new Date(citation.updated_at).toLocaleString(language === "en" ? "en-US" : "vi-VN")}</li>)}
                    </ul>
                  </details>
                ) : null}
              </div>
              );
            })}
            {streamedText && (
              <div className="max-w-[92%] self-start rounded-2xl rounded-tl-[5px] border border-vn-paper/10 bg-vn-card px-4 py-3 text-vn-paper">
                <div className="whitespace-pre-wrap break-words">{streamedText}</div>
              </div>
            )}
            {isResponding && !streamedText && (
              <div className="flex max-w-[88%] items-center gap-2.5 font-vnMono text-[10.5px] uppercase tracking-[0.12em] text-vn-paper/60"><span className="grid h-8 w-8 place-items-center rounded-[10px] border border-vn-cobalt-l/30 bg-vn-cobalt-l/10 text-vn-lime"><Loader2 className="h-4 w-4 animate-spin" /></span>{text("VNAgent đang xử lý…")}</div>
            )}
            {errorMessage && <div role="alert" className="rounded-xl border border-vn-red/40 bg-vn-red/10 p-3 text-xs leading-relaxed text-vn-paper/90">{text(errorMessage)}</div>}
            {showQuickActions && (
              <div className="rounded-2xl border border-vn-paper/10 bg-vn-card p-3.5">
                <div className="mb-2.5 font-vnMono text-[10px] uppercase tracking-[0.14em] text-vn-paper/45">{text("Gợi ý nhanh")}</div>
                <div className="flex flex-wrap gap-2">
                  {localizedSuggestions.map((suggestion) => <button key={suggestion} type="button" className="min-h-[36px] rounded-[11px] border border-vn-paper/[.18] bg-vn-card2 px-3 py-2 text-left text-xs font-bold text-vn-lime transition hover:-translate-y-px hover:border-vn-lime disabled:opacity-50 disabled:hover:translate-y-0 disabled:hover:border-vn-paper/[.18]" onClick={() => void sendMessage(suggestion)} disabled={!chatReady || isResponding}>{suggestion}</button>)}
                </div>
              </div>
            )}
            <div ref={endRef} />
          </div>

          <div className="shrink-0 border-t border-vn-paper/10 bg-vn-ink px-3.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
            <div className="flex items-end gap-2">
              <div className="relative min-w-0 flex-1 overflow-clip rounded-[18px] border border-vn-paper/[.18] bg-vn-card shadow-[0_10px_30px_rgba(0,0,0,0.35)] py-3 transition focus-within:border-vn-lime">
                <Textarea
                  ref={attachComposer}
                  data-vnagent-composer="autogrow-v1"
                  aria-label={text("Tin nhắn cho VNAgent trong BMQ AI")}
                  value={draft}
                  rows={1}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder={text("Hỏi bất cứ điều gì")}
                  className="min-h-0 resize-none rounded-none border-0 bg-transparent px-4 py-0 font-vnDisp text-base leading-6 text-vn-paper shadow-none outline-none ring-0 placeholder:text-vn-paper/40 focus-visible:ring-0 focus-visible:ring-offset-0 disabled:opacity-60"
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      void sendMessage();
                    }
                  }}
                  disabled={sessionChoiceRequired || !chatReady || isResponding}
                />
              </div>
              <button type="button" data-vnagent-send="lime-v2" className="grid h-12 w-12 shrink-0 place-items-center rounded-xl border-0 bg-vn-lime text-vn-ink transition hover:brightness-105 active:scale-[0.97] disabled:cursor-not-allowed disabled:bg-vn-card2 disabled:text-vn-paper/30" onClick={() => void sendMessage()} disabled={!draft.trim() || sessionChoiceRequired || !chatReady || isResponding} aria-label={text("Gửi tin nhắn")}>
                {isResponding ? <Loader2 className="h-[18px] w-[18px] animate-spin" /> : <ArrowUp className="h-[18px] w-[18px] stroke-[2.2]" />}
              </button>
            </div>
            <div className="mt-1.5 pr-[56px] text-right font-vnMono text-[10px] tracking-[0.06em] text-vn-paper/40">{draft.trim() ? draft.trim().split(/\s+/).length : 0} / 300</div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
