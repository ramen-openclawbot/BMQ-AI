import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ArrowUp, Loader2, MessageCircle, Sparkles, X } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useAuth } from "@/contexts/AuthContext";
import { cn } from "@/lib/utils";
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

function VnagentMark() {
  return (
    <svg className="h-9 w-11 shrink-0" viewBox="0 0 104 84" role="img" aria-label="Logo VNAgent">
      <defs>
        <linearGradient id="bmq-vnagent-violet-a" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#aa6fff" /><stop offset="1" stopColor="#6845ee" /></linearGradient>
        <linearGradient id="bmq-vnagent-violet-b" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#9e5dff" /><stop offset="1" stopColor="#5b3adc" /></linearGradient>
        <mask id="bmq-vnagent-interlock"><rect width="104" height="84" fill="white" /><path d="M51 51 61 68 66 59 57 44Z" fill="black" /></mask>
      </defs>
      <path d="M2 2H30L76 80H48Z" fill="url(#bmq-vnagent-violet-a)" />
      <path d="M39 2H88L98 18 65 75 52 53 77 18H50Z" fill="url(#bmq-vnagent-violet-b)" mask="url(#bmq-vnagent-interlock)" />
    </svg>
  );
}

export function GlobalAgentChatWidget() {
  const location = useLocation();
  const { authzLoaded, isOwner, session, user } = useAuth();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [frames, setFrames] = useState<UniversalFrame[]>([]);
  const [streamedText, setStreamedText] = useState("");
  const [vnagentToken, setVnagentToken] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [connection, setConnection] = useState<"idle" | "authenticating" | "connecting" | "connected" | "error">("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isResponding, setIsResponding] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const lastSeqRef = useRef(0);
  const endRef = useRef<HTMLDivElement | null>(null);
  const enabled = authzLoaded && isOwner && Boolean(session?.access_token && user?.id);
  const routeContext = useMemo(() => getRouteContext(location.pathname), [location.pathname]);
  const timeline = useMemo(() => timelineFromFrames(frames), [frames]);
  const visibleTimeline = useMemo(() => timeline.filter((item) => item.kind !== "tool"), [timeline]);
  const showQuickActions = !sessionId && visibleTimeline.length === 0 && !streamedText && !isResponding;
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
    if (!enabled || !session?.access_token || !user?.id) {
      setVnagentToken(null);
      sessionIdRef.current = null;
      setSessionId(null);
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

        const restoredSessionId = localStorage.getItem(storageKey(user.id, "session"));
        lastSeqRef.current = Number(localStorage.getItem(storageKey(user.id, "last-seq")) || 0);
        if (restoredSessionId) {
          const historyResponse = await fetch(`${API_URL}/v1/sessions/${encodeURIComponent(restoredSessionId)}/messages`, {
            headers: { Authorization: `Bearer ${token}` },
            signal: controller.signal,
          });
          if (historyResponse.ok) {
            const history = await historyResponse.json() as UniversalFrame[];
            setFrames(history);
            const latestSeq = history.reduce((max, frame) => typeof frame.seq === "number" ? Math.max(max, frame.seq) : max, lastSeqRef.current);
            lastSeqRef.current = latestSeq;
            localStorage.setItem(storageKey(user.id, "last-seq"), String(latestSeq));
            sessionIdRef.current = restoredSessionId;
            setSessionId(restoredSessionId);
          } else if (historyResponse.status === 404) {
            localStorage.removeItem(storageKey(user.id, "session"));
            localStorage.removeItem(storageKey(user.id, "last-seq"));
            setFrames([]);
            sessionIdRef.current = null;
            setSessionId(null);
            lastSeqRef.current = 0;
          } else {
            throw new Error("Không khôi phục được lịch sử VNAgent.");
          }
        } else {
          setFrames([]);
          sessionIdRef.current = null;
          setSessionId(null);
          lastSeqRef.current = 0;
        }
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

  useEffect(() => {
    if (!vnagentToken || !enabled) return;
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
  }, [frames, open, streamedText]);

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
    const initialSocket = wsRef.current;
    if (!content || connection !== "connected" || !initialSocket || initialSocket.readyState !== WebSocket.OPEN || isResponding) return;
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
  }, [connection, draft, ensureSession, isResponding, location.pathname, location.search, rememberFrame, routeContext]);

  if (!enabled) return null;

  return (
    <>
      <Button
        type="button"
        size="icon"
        className={cn(
          "fixed z-50 rounded-full shadow-lg bg-primary text-primary-foreground hover:bg-primary/90",
          shouldLiftMobileChatButton
            ? "bottom-[calc(5rem+env(safe-area-inset-bottom))] right-3 h-11 w-11 sm:bottom-[calc(1.5rem+env(safe-area-inset-bottom))] sm:right-6 sm:h-14 sm:w-14"
            : "right-6 bottom-[calc(1.5rem+env(safe-area-inset-bottom))] h-14 w-14",
          isPaymentRequestsMobileContext && "hidden lg:inline-flex",
        )}
        onClick={() => setOpen(true)}
        aria-label="Mở VNAgent"
      >
        <MessageCircle className="h-6 w-6" />
      </Button>

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          data-vnagent-branding="owner-chat-v1"
          data-vnagent-ui="chat-v2-clean"
          side="right"
          className="flex w-full flex-col gap-0 overflow-hidden border-l border-[#e4e7ec] bg-[#f7f8fa] p-0 text-[#171a21] shadow-2xl [&>button]:hidden sm:w-[440px] sm:max-w-[440px]"
        >
          <header className="relative flex shrink-0 items-center gap-3 border-b border-[#e8eaf0] bg-white px-4 pb-3 pt-[max(0.875rem,env(safe-area-inset-top))]">
            <div className="absolute inset-x-0 top-0 h-0.5 bg-gradient-to-r from-[#6246ea] via-[#8b5cf6] to-[#b66cff]" />
            <div className="flex min-w-0 flex-1 items-center gap-2.5" aria-label="VNAgent — Trợ lý AI của BMQ">
              <div className="grid h-10 w-10 shrink-0 place-items-center rounded-2xl bg-[#f0edff] shadow-[inset_0_0_0_1px_rgba(108,78,238,0.12)]"><VnagentMark /></div>
              <div className="min-w-0">
                <SheetTitle className="text-[17px] font-bold leading-none tracking-[-0.02em] text-[#171a21]">VNAgent</SheetTitle>
                <div className="mt-1.5 flex items-center gap-1.5 whitespace-nowrap text-[11px] text-[#717784]">
                  <span className={cn("h-1.5 w-1.5 rounded-full", connection === "connected" ? "bg-emerald-500 shadow-[0_0_0_3px_rgba(16,185,129,0.12)]" : connection === "error" ? "bg-red-400" : "animate-pulse bg-amber-400")} />
                  <span>{connection === "connected" ? "Đã kết nối" : connection === "error" ? "Mất kết nối" : "Đang kết nối"} · Trợ lý AI của BMQ</span>
                </div>
              </div>
            </div>
            <button type="button" className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-[#687080] transition hover:bg-[#f1f2f5] hover:text-[#171a21]" onClick={() => setOpen(false)} aria-label="Đóng VNAgent"><X className="h-5 w-5" /></button>
          </header>

          <div className="flex flex-1 flex-col gap-4 overflow-auto bg-[#f7f8fa] px-4 py-5 text-[15px] leading-[1.6]">
            {visibleTimeline.length === 0 && !streamedText && (
              <div className="flex items-start gap-2.5">
                <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-[#ebe7ff] text-[#6847e8]"><Sparkles className="h-4 w-4" /></span>
                <div className="max-w-[88%] rounded-2xl rounded-tl-md border border-[#e4e5eb] bg-white px-4 py-3 text-[#252932] shadow-[0_1px_2px_rgba(16,24,40,0.04)]">Dạ thưa anh Tâm, VNAgent đã nhận diện màn hình hiện tại là <b>{routeContext.label}</b>. Anh cần VNAgent hỗ trợ việc gì ạ?</div>
              </div>
            )}
            {isRevenueMobileContext ? <RevenueDailyChatCard setOpen={setOpen} /> : null}
            {visibleTimeline.map((item) => (
              <div key={item.id} className={cn("whitespace-pre-wrap break-words shadow-[0_1px_2px_rgba(16,24,40,0.04)]", item.role === "user" ? "max-w-[82%] self-end rounded-2xl rounded-br-md bg-[#6d4aff] px-4 py-3 text-white" : item.role === "system" ? "self-center rounded-full border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700" : "max-w-[92%] self-start rounded-2xl rounded-tl-md border border-[#e4e5eb] bg-white px-4 py-3 text-[#252932]")}>
                {item.role === "system" ? <span className="sr-only">Hệ thống: </span> : null}
                {item.text}
              </div>
            ))}
            {streamedText && (
              <div className="max-w-[92%] self-start rounded-2xl rounded-tl-md border border-[#e4e5eb] bg-white px-4 py-3 text-[#252932] shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
                <div className="whitespace-pre-wrap break-words">{streamedText}</div>
              </div>
            )}
            {isResponding && !streamedText && (
              <div className="flex max-w-[88%] items-center gap-2.5 text-xs font-medium text-[#777e8b]"><span className="grid h-8 w-8 place-items-center rounded-xl bg-[#ebe7ff] text-[#6847e8]"><Loader2 className="h-4 w-4 animate-spin" /></span>VNAgent đang xử lý…</div>
            )}
            {errorMessage && <div className="rounded-2xl border border-red-200 bg-red-50 p-3 text-xs text-red-700">{errorMessage}</div>}
            {showQuickActions && (
              <div className="rounded-2xl border border-[#e4e5eb] bg-white p-3.5 shadow-[0_1px_2px_rgba(16,24,40,0.04)]">
                <div className="mb-2.5 text-xs font-medium text-[#777e8b]">Gợi ý nhanh</div>
                <div className="flex flex-wrap gap-2">
                  {routeContext.suggestions.map((suggestion) => <button key={suggestion} type="button" className="rounded-full border border-[#ded9fa] bg-[#f7f5ff] px-3 py-2 text-left text-xs font-semibold text-[#5e43c7] transition hover:border-[#8b73ed] hover:bg-[#f1edff] disabled:opacity-50" onClick={() => void sendMessage(suggestion)} disabled={connection !== "connected" || isResponding}>{suggestion}</button>)}
                </div>
              </div>
            )}
            <div ref={endRef} />
          </div>

          <div className="shrink-0 border-t border-[#e8eaf0] bg-white px-3.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
            <div className="flex items-end gap-2">
              <div className="relative min-w-0 flex-1 rounded-[22px] border border-[#dfe2e8] bg-[#f7f8fa] transition focus-within:border-[#8b73ed] focus-within:bg-white focus-within:shadow-[0_0_0_3px_rgba(109,74,255,0.10)]">
                <Textarea
                  value={draft}
                  rows={1}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder="Hỏi bất cứ điều gì"
                  className="max-h-[120px] min-h-[44px] resize-none border-0 bg-transparent px-4 py-2.5 pr-14 text-base leading-[1.45] text-[#252932] shadow-none outline-none ring-0 placeholder:text-[#9a9fab] focus-visible:ring-0 focus-visible:ring-offset-0"
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void sendMessage();
                    }
                  }}
                  disabled={connection !== "connected" || isResponding}
                />
                <span className="pointer-events-none absolute bottom-3 right-3 text-[8px] uppercase tracking-[0.08em] text-[#a0a5af]">{draft.trim() ? draft.trim().split(/\s+/).length : 0} / 300</span>
              </div>
              <button type="button" className="grid h-11 w-11 shrink-0 place-items-center rounded-full border-0 bg-[#6d4aff] text-white shadow-[0_6px_16px_rgba(109,74,255,0.28)] transition hover:bg-[#5f3ee8] active:scale-[0.97] disabled:cursor-not-allowed disabled:bg-[#d7d9df] disabled:shadow-none" onClick={() => void sendMessage()} disabled={!draft.trim() || connection !== "connected" || isResponding} aria-label="Gửi tin nhắn">
                {isResponding ? <Loader2 className="h-[18px] w-[18px] animate-spin" /> : <ArrowUp className="h-[18px] w-[18px] stroke-[2.2]" />}
              </button>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
