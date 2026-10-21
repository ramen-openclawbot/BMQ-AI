import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AlertTriangle, ArrowLeft, ArrowUp, Check, ExternalLink, Loader2, RotateCcw, Sparkles, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { VnagentMark } from "@/components/agent/GlobalAgentChatWidget";
import { CostBusinessCard } from "@/components/agent/CostBusinessCard";
import { UncImageGallery } from "@/components/agent/UncImageGallery";
import { RevenueSnapshotCard } from "@/components/agent/RevenueSnapshotCard";
import { costLineBlockSchema, uncImageSchema } from "@/lib/bmqAnalytics";
import {
  MerchantAgentError,
  approveMerchantChange,
  discardMerchantChange,
  formatMerchantChangeValue,
  formatMerchantValue,
  merchantChangeKindLabel,
  merchantChangeStatusLabel,
  merchantMetricLabel,
  parseDocLink,
  sendMerchantMessage,
  type DocLinkPayload,
  type MerchantChange,
  type MerchantUiBlock,
} from "@/lib/merchantAgent";
import { merchantPageContext, merchantPageGuide } from "@/lib/merchantPageGuide";

// The owner's back-office chat: Anthropic's merchant agent (Claude Haiku via the owner's
// Claude Code login) answering from BMQ data. It replaced the Sushi analytics chat on
// 18/10 at the owner's request; nothing it proposes is applied until he taps Duyệt.

type ChatMessage =
  | { id: string; role: "user"; text: string }
  | { id: string; role: "agent"; text: string; ui: MerchantUiBlock[] }
  | { id: string; role: "error"; text: string };

// The conversation survives closing the sheet (the widget stays mounted across routes) and,
// through sessionStorage, a page reload in the same tab. The server keeps its own context
// for 30 idle minutes under the same session_id.
const STORE_PREFIX = "bmq-merchant-chat:";
const STORE_MAX_MESSAGES = 60;

type StoredChat = { messages: ChatMessage[]; sessionId: string | null; changes: Record<string, MerchantChange>; openedDoc: DocLinkPayload | null };

function loadChat(userId: string | undefined): StoredChat | null {
  if (!userId || typeof window === "undefined") return null;
  try {
    const raw = window.sessionStorage.getItem(STORE_PREFIX + userId);
    const parsed = raw ? JSON.parse(raw) as Partial<StoredChat> : null;
    if (!parsed || !Array.isArray(parsed.messages)) return null;
    return { messages: parsed.messages, sessionId: typeof parsed.sessionId === "string" ? parsed.sessionId : null, changes: parsed.changes && typeof parsed.changes === "object" ? parsed.changes : {}, openedDoc: parseDocLink(parsed.openedDoc) };
  } catch {
    return null;
  }
}

function saveChat(userId: string | undefined, chat: StoredChat) {
  if (!userId || typeof window === "undefined") return;
  try {
    if (!chat.messages.length) window.sessionStorage.removeItem(STORE_PREFIX + userId);
    else window.sessionStorage.setItem(STORE_PREFIX + userId, JSON.stringify({ ...chat, messages: chat.messages.slice(-STORE_MAX_MESSAGES) }));
  } catch {
    // Storage full or blocked: the in-memory conversation still works.
  }
}

const DOC_KIND_LABEL: Record<DocLinkPayload["kind"], string> = { pr: "PR", po: "PO", gr: "Phiếu nhập" };

const STARTERS = [
  "Snapshot doanh thu",
  "Tổng quan 7 ngày qua",
  "Doanh thu tháng này theo kênh",
  "Hôm nay đơn đại lý có vấn đề gì?",
  "SKU nào thiếu giá hoặc thiếu ảnh?",
];

const newId = () => crypto.randomUUID();

async function currentToken(fallback?: string | null): Promise<string> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token || fallback;
  if (!token) throw new MerchantAgentError("Phiên đăng nhập đã hết hạn. Anh tải lại trang giúp em.", 401);
  return token;
}

function MetricsBlock({ payload }: { payload: Record<string, unknown> }) {
  const metrics = Array.isArray(payload.metrics) ? payload.metrics as Array<Record<string, unknown>> : [];
  if (!metrics.length) return null;
  return (
    <div className="mt-3 rounded-xl border border-vn-paper/10 bg-vn-card2 p-3" data-merchant-ui="metrics">
      {payload.title || payload.period ? (
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          {payload.title ? <span className="text-xs font-bold text-vn-paper">{String(payload.title)}</span> : null}
          {payload.period ? <span className="font-vnMono text-[10px] uppercase tracking-[0.08em] text-vn-paper/45">{String(payload.period)}</span> : null}
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-2">
        {metrics.map((metric, index) => {
          const series = metric.series as { unit?: string; points?: Array<{ date: string; value: number }>; segment?: string } | undefined;
          const points = series?.points || [];
          const value = series ? points.reduce((sum, point) => sum + (Number(point.value) || 0), 0) : metric.value;
          const unit = series?.unit || (metric.currency ? String(metric.currency) : metric.metric === "sales" ? "VND" : undefined);
          const change = typeof metric.change_pct === "number" ? metric.change_pct : null;
          const max = Math.max(1, ...points.map((point) => Number(point.value) || 0));
          return (
            <div key={`${String(metric.metric)}-${index}`} className={cn("min-w-0 rounded-lg border border-vn-paper/10 bg-vn-ink/60 p-2.5", points.length > 1 && "col-span-2")}>
              <div className="truncate text-[11px] font-semibold text-vn-paper/60">
                {merchantMetricLabel(String(metric.metric || ""))}
                {series?.segment ? ` · ${series.segment.replace(/^channel:/, "")}` : ""}
              </div>
              <div className="mt-0.5 flex items-baseline gap-2">
                <span className="text-lg font-black tabular-nums text-vn-paper">{formatMerchantValue(value, unit)}</span>
                {change !== null ? (
                  <span className={cn("text-xs font-bold tabular-nums", change >= 0 ? "text-vn-online" : "text-vn-red")}>
                    {change >= 0 ? "+" : ""}{change.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%
                  </span>
                ) : null}
              </div>
              {points.length > 1 ? (
                <div className="mt-2 flex h-10 items-end gap-[2px]" aria-hidden="true">
                  {points.slice(-31).map((point) => (
                    <span key={point.date} title={`${point.date}: ${formatMerchantValue(point.value, unit)}`} className="min-w-[3px] flex-1 rounded-t-sm bg-vn-lime/70" style={{ height: `${Math.max(6, (Number(point.value) / max) * 100)}%` }} />
                  ))}
                </div>
              ) : null}
              {metric.note ? <div className="mt-1.5 text-[11px] leading-4 text-vn-paper/55">{String(metric.note)}</div> : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DigestBlock({ payload }: { payload: Record<string, unknown> }) {
  const items = Array.isArray(payload.items) ? payload.items as Array<Record<string, unknown>> : [];
  if (!items.length) return null;
  return (
    <div className="mt-3 rounded-xl border border-vn-paper/10 bg-vn-card2 p-3" data-merchant-ui="digest">
      {payload.title ? <div className="mb-2 text-xs font-bold text-vn-paper">{String(payload.title)}</div> : null}
      <ul className="space-y-2">
        {items.map((item, index) => (
          <li key={`${String(item.ref_id || "")}-${index}`} className="flex gap-2">
            <span className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", item.kind === "order_issue" ? "bg-vn-red" : item.kind === "pending_change" ? "bg-vn-lime" : "bg-vn-paper/40")} />
            <span className="min-w-0">
              <span className="block text-[13px] font-semibold leading-5 text-vn-paper">{String(item.headline || "")}</span>
              {item.why_it_matters ? <span className="block text-[12px] leading-5 text-vn-paper/55">{String(item.why_it_matters)}</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Sushi (bmq-analytics) answers the agent fetched: cost line card, UNC images and
// sources are re-validated with the same schemas the old Sushi chat used.
function SushiBlock({ payload, ownerId }: { payload: Record<string, unknown>; ownerId: string }) {
  const answer = typeof payload.answer === "string" ? payload.answer : "";
  const cost = costLineBlockSchema.safeParse(payload.costBlock);
  const images = Array.isArray(payload.images) ? payload.images.flatMap((image) => {
    const parsed = uncImageSchema.safeParse(image);
    return parsed.success ? [parsed.data] : [];
  }) : [];
  const details = typeof payload.details === "string" ? payload.details : "";
  const citations = Array.isArray(payload.citations) ? payload.citations as Array<Record<string, unknown>> : [];
  if (!answer && !cost.success && !images.length) return null;
  return (
    <div className="mt-3 rounded-xl border border-vn-cobalt-l/30 bg-vn-cobalt-l/[.06] p-3" data-merchant-ui="sushi">
      {answer ? <div className="whitespace-pre-wrap break-words text-[13.5px] leading-6 text-vn-paper">{answer}</div> : null}
      {cost.success ? (
        <div className="mt-2">
          <CostBusinessCard block={cost.data} language="vi" followUpEnabled={false} followUpDisabledReason="Anh hỏi tiếp ngay trong ô chat." onFollowUp={() => undefined} />
        </div>
      ) : null}
      {images.length ? <UncImageGallery images={images} language="vi" ownerId={ownerId} /> : null}
      {details ? (
        <details className="mt-2 border-t border-vn-paper/10 pt-2 text-xs text-vn-paper/80">
          <summary className="cursor-pointer font-semibold text-vn-lime">Xem chi tiết</summary>
          <div className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words">{details}</div>
        </details>
      ) : null}
      {citations.length ? (
        <div className="mt-2 border-t border-vn-paper/10 pt-2 text-[11px] leading-5 text-vn-paper/55">
          Nguồn: {citations.slice(0, 3).map((citation) => String(citation.title || citation.source || "")).filter(Boolean).join(" · ")}
        </div>
      ) : null}
    </div>
  );
}

function ChangeCard({
  change,
  headline,
  note,
  busy,
  onApprove,
  onDiscard,
}: {
  change: MerchantChange;
  headline?: string;
  note?: string;
  busy: boolean;
  onApprove: () => void;
  onDiscard: () => void;
}) {
  const open = change.status === "staged" || change.status === "approved";
  const items = change.items || [];
  return (
    <div className="mt-3 rounded-xl border border-vn-lime/30 bg-vn-lime/[.05] p-3" data-merchant-change={change.change_id} data-merchant-change-status={change.status}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-vnMono text-[10px] uppercase tracking-[0.1em] text-vn-lime">{merchantChangeKindLabel(change.kind)}</div>
          <div className="mt-0.5 break-words text-[13px] font-bold leading-5 text-vn-paper">{headline || change.summary || "Bản nháp thay đổi"}</div>
        </div>
        <span className={cn(
          "shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold",
          change.status === "applied" ? "bg-vn-online/15 text-vn-online"
            : change.status === "failed" ? "bg-vn-red/15 text-vn-red"
            : change.status === "discarded" ? "bg-vn-paper/10 text-vn-paper/50"
            : "bg-vn-lime/15 text-vn-lime",
        )}>{merchantChangeStatusLabel(change.status)}</span>
      </div>
      {items.length ? (
        <ul className="mt-2 space-y-1.5 border-t border-vn-paper/10 pt-2">
          {items.slice(0, 8).map((item, index) => (
            <li key={index} className="text-[12px] leading-5 text-vn-paper/80">
              <span className="font-semibold text-vn-paper">{item.target}{item.field && item.field !== "name" ? ` · ${item.field}` : ""}</span>
              <span className="block break-words">
                {item.before !== undefined ? <><span className="text-vn-paper/45 line-through">{formatMerchantChangeValue(item.before)}</span>{" → "}</> : null}
                <span className="text-vn-paper">{formatMerchantChangeValue(item.after)}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {note && open ? <div className="mt-2 text-[12px] leading-5 text-vn-paper/60">{note}</div> : null}
      {open && change.guardrail_notes?.length ? (
        <ul className="mt-2 space-y-1 rounded-lg border border-amber-400/30 bg-amber-400/10 px-2.5 py-2" data-merchant-change-warnings>
          {change.guardrail_notes.map((warning) => (
            <li key={warning} className="flex gap-1.5 text-[12px] font-semibold leading-5 text-amber-200">
              <AlertTriangle className="mt-[3px] h-3.5 w-3.5 shrink-0" />{warning}
            </li>
          ))}
        </ul>
      ) : null}
      {change.status === "failed" && change.error ? <div className="mt-2 text-[12px] leading-5 text-vn-red">{change.error}</div> : null}
      {open ? (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <Button type="button" className="h-10 rounded-xl bg-vn-lime font-bold text-vn-ink hover:bg-vn-lime hover:brightness-105" disabled={busy} onClick={onApprove} data-merchant-change-action="approve">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Duyệt
          </Button>
          <Button type="button" variant="outline" className="h-10 rounded-xl border-vn-paper/20 bg-transparent font-bold text-vn-paper/80 hover:bg-vn-card hover:text-vn-paper" disabled={busy} onClick={onDiscard} data-merchant-change-action="discard">
            Bỏ
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function MerchantAgentChatWidget() {
  const location = useLocation();
  const navigate = useNavigate();
  const { authzLoaded, isOwner, session, user, profile } = useAuth();
  const enabled = authzLoaded && isOwner && Boolean(session?.access_token && user?.id);
  const name = user && profile?.user_id === user.id ? profile.full_name?.trim() : "";
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [responding, setResponding] = useState(false);
  const [changes, setChanges] = useState<Record<string, MerchantChange>>({});
  const [busyChange, setBusyChange] = useState<string | null>(null);
  // Set when the owner opened a phiếu from the chat; shows a "back to chat" pill.
  const [openedDoc, setOpenedDoc] = useState<DocLinkPayload | null>(null);
  const [restoredFor, setRestoredFor] = useState<string | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);

  // A different signed-in account never sees the previous conversation; the same account
  // gets its conversation back after a reload in this tab.
  useEffect(() => {
    const stored = loadChat(user?.id);
    setMessages(stored?.messages || []);
    setSessionId(stored?.sessionId || null);
    setChanges(stored?.changes || {});
    setDraft("");
    setOpenedDoc(stored?.openedDoc || null);
    setRestoredFor(user?.id || null);
  }, [user?.id]);

  useEffect(() => {
    if (!user?.id || restoredFor !== user.id) return;
    saveChat(user.id, { messages, sessionId, changes, openedDoc });
  }, [user?.id, restoredFor, messages, sessionId, changes, openedDoc]);

  const openDoc = useCallback((doc: DocLinkPayload) => {
    setOpen(false);
    setOpenedDoc(doc);
    navigate(doc.path);
  }, [navigate]);

  // The pill stays while the owner is still on the phiếu's page, so a closed chat can be reopened
  // there even while the phiếu dialog covers the launcher.
  const backToChat = useCallback(() => setOpen(true), []);

  useLayoutEffect(() => {
    const node = composerRef.current;
    if (!node) return;
    node.style.height = "0px";
    node.style.height = `${Math.min(Math.max(24, node.scrollHeight), 144)}px`;
    node.style.overflowY = node.scrollHeight > 144 ? "auto" : "hidden";
  }, [draft, open]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: "end" }));
    return () => window.cancelAnimationFrame(frame);
  }, [messages, responding, open]);

  const send = useCallback(async (raw?: string) => {
    const message = (raw ?? draft).trim();
    if (!message || responding) return;
    setDraft("");
    setMessages((current) => [...current, { id: newId(), role: "user", text: message }]);
    setResponding(true);
    try {
      const token = await currentToken(session?.access_token);
      const result = await sendMerchantMessage(token, { message, sessionId, page: merchantPageContext(location.pathname) });
      setSessionId(result.session_id || sessionId);
      setMessages((current) => [...current, { id: newId(), role: "agent", text: result.text || "", ui: result.ui || [] }]);
      setChanges((current) => {
        const next = { ...current };
        for (const block of result.ui || []) {
          const change = block.component === "change_preview" ? block.payload.change as MerchantChange | undefined : undefined;
          if (change?.change_id) next[change.change_id] = { ...change, ...(next[change.change_id]?.status && next[change.change_id].status !== "staged" ? { status: next[change.change_id].status } : {}) };
        }
        for (const change of result.pending_changes || []) {
          if (!next[change.change_id] || next[change.change_id].status === "staged") next[change.change_id] = { ...next[change.change_id], ...change };
        }
        return next;
      });
    } catch (error) {
      const text = error instanceof Error ? error.message : "Không gọi được VNAgent.";
      setMessages((current) => [...current, { id: newId(), role: "error", text }]);
    } finally {
      setResponding(false);
    }
  }, [draft, responding, session?.access_token, sessionId, location.pathname]);

  const decide = useCallback(async (changeId: string, decision: "approve" | "discard") => {
    setBusyChange(changeId);
    try {
      const token = await currentToken(session?.access_token);
      const updated = decision === "approve" ? await approveMerchantChange(token, changeId) : await discardMerchantChange(token, changeId);
      setChanges((current) => ({ ...current, [changeId]: { ...current[changeId], ...updated } }));
    } catch (error) {
      const text = error instanceof Error ? error.message : "Không xử lý được bản nháp.";
      setChanges((current) => ({ ...current, [changeId]: { ...current[changeId], status: decision === "approve" ? "failed" : current[changeId]?.status || "staged", error: text } }));
    } finally {
      setBusyChange(null);
    }
  }, [session?.access_token]);

  const reset = () => {
    setMessages([]);
    setSessionId(null);
    setChanges({});
    setDraft("");
    setOpenedDoc(null);
  };

  if (!enabled) return null;

  const path = location.pathname;
  const lastAgentId = [...messages].reverse().find((message) => message.role === "agent")?.id;
  // Starters follow the page the owner is on; pages without their own set keep the general ones.
  const pageGuide = merchantPageGuide(path);
  const pageStarters = pageGuide?.suggestions?.length ? pageGuide.suggestions : null;
  const starters = pageStarters || STARTERS;

  return (
    <>
      <Button
        type="button"
        size="icon"
        data-merchant-agent-launcher="v1"
        // One size on every page (owner 22/10). Pages with a pinned bottom bar or button move it
        // clear in bmq-shell.css ("chat launcher"), not by shrinking or hiding it here.
        className="d3-agent-launcher fixed bottom-[calc(1.5rem+env(safe-area-inset-bottom))] right-6 z-50 h-14 w-14 rounded-full border border-vn-paper/[.18] bg-vn-ink shadow-[0_10px_28px_rgba(12,12,18,0.35)] transition-colors hover:border-vn-lime hover:bg-vn-ink focus-visible:ring-2 focus-visible:ring-vn-lime focus-visible:ring-offset-2 [&_svg]:!h-full [&_svg]:!w-full"
        onClick={backToChat}
        aria-label="Mở VNAgent"
      >
        <span aria-hidden="true" className={cn("pointer-events-none absolute inset-0 -z-10 rounded-full ring-2 ring-vn-lime/50", !open && "animate-vnagent-halo motion-reduce:animate-none")} />
        <span className="grid h-[72%] w-[72%] place-items-center"><VnagentMark className="h-full w-full" /></span>
      </Button>

      {openedDoc && !open && location.pathname === openedDoc.path.split("?")[0] ? (
        // A compact tab on the left edge: phiếu dialogs keep their sticky header (title, close)
        // at the top and their action bar at the bottom on mobile. z-[60] sits above the dialog
        // and pointer-events-auto keeps it clickable while a modal sets pointer-events: none.
        <button
          type="button"
          className="pointer-events-auto fixed left-0 top-[42%] z-[60] flex items-center gap-1.5 rounded-r-full border border-l-0 border-vn-lime/60 bg-vn-ink py-1.5 pl-2 pr-3 text-xs font-bold text-vn-paper shadow-[0_10px_28px_rgba(12,12,18,0.45)] transition hover:border-vn-lime active:scale-[0.98] sm:py-2 sm:pl-2.5 sm:pr-4 sm:text-sm"
          onClick={backToChat}
          aria-label={`Quay lại chat VNAgent (đang xem ${openedDoc.code})`}
          data-merchant-back-to-chat
        >
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-vn-lime text-vn-ink"><ArrowLeft className="h-4 w-4 stroke-[2.4]" /></span>
          <span>Chat</span>
          <span className="hidden max-w-[11rem] truncate font-vnMono text-[11px] font-semibold text-vn-paper/60 sm:inline">{openedDoc.code}</span>
        </button>
      ) : null}

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          lang="vi"
          data-merchant-agent-chat="claude-merchant-v1"
          className="flex w-full flex-col gap-0 overflow-hidden border-l border-vn-paper/10 bg-vn-ink p-0 font-vnDisp text-vn-paper shadow-[0_20px_50px_rgba(0,0,0,0.5)] [&>button]:hidden sm:w-[440px] sm:max-w-[440px]"
        >
          <header className="relative flex shrink-0 items-center gap-3 border-b border-vn-paper/10 bg-vn-ink/90 px-4 pb-3 pt-[max(0.875rem,env(safe-area-inset-top))] backdrop-blur-md">
            <div className="min-w-0 flex-1">
              <SheetTitle className="text-[19px] font-black leading-none tracking-[-0.02em] text-vn-paper [font-stretch:125%]">VN<span className="text-vn-red">AGENT</span></SheetTitle>
              <div className="mt-2 flex min-w-0 items-center gap-1.5 whitespace-nowrap font-vnMono text-[9.5px] uppercase tracking-[0.14em] text-vn-paper/50">
                <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", responding ? "animate-pulse bg-vn-lime" : "bg-vn-online shadow-[0_0_0_3px_rgba(61,220,132,0.18)]")} />
                <span className="min-w-0 truncate">{responding ? "Đang trả lời" : "Sẵn sàng"} · Trợ lý AI của BMQ</span>
              </div>
            </div>
            <button type="button" className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-vn-paper/[.18] bg-vn-card text-vn-paper/70 transition hover:border-vn-lime hover:text-vn-paper" onClick={reset} aria-label="Tạo cuộc trò chuyện mới" data-merchant-agent-reset><RotateCcw className="h-[18px] w-[18px]" /></button>
            <button type="button" className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-vn-paper/[.18] bg-vn-card text-vn-paper/70 transition hover:border-vn-lime hover:text-vn-paper" onClick={() => setOpen(false)} aria-label="Đóng VNAgent"><X className="h-5 w-5" /></button>
          </header>

          <div className="flex flex-1 flex-col gap-4 overflow-auto bg-vn-ink px-4 py-5 text-[15px] leading-[1.62]">
            {messages.length === 0 ? (
              <>
                <div className="flex items-start gap-2.5">
                  <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-[10px] border border-vn-cobalt-l/30 bg-vn-cobalt-l/10 text-vn-lime"><Sparkles className="h-4 w-4" /></span>
                  <div className="max-w-[88%] rounded-2xl rounded-tl-[5px] border border-vn-paper/10 bg-vn-card px-4 py-3 text-vn-paper">
                    Xin chào{name ? `, ${name}` : ""}. VNAgent xem được doanh thu, đơn đại lý, công nợ, chi phí, SKU và giá riêng. Mọi thay đổi VNAgent soạn chỉ là bản nháp — anh bấm <b>Duyệt</b> mới áp.
                  </div>
                </div>
                <div className="rounded-2xl border border-vn-paper/10 bg-vn-card p-3.5" data-merchant-starters={pageStarters ? pageGuide?.prefix : "general"}>
                  <div className="mb-2.5 font-vnMono text-[10px] uppercase tracking-[0.14em] text-vn-paper/45">
                    {pageStarters && pageGuide ? <>Gợi ý · <span className="text-vn-paper/70">{pageGuide.label}</span></> : "Gợi ý nhanh"}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {starters.map((starter) => (
                      <button key={starter} type="button" className="min-h-[36px] rounded-[11px] border border-vn-paper/[.18] bg-vn-card2 px-3 py-2 text-left text-xs font-bold text-vn-lime transition hover:-translate-y-px hover:border-vn-lime disabled:opacity-50" onClick={() => void send(starter)} disabled={responding} data-merchant-starter>{starter}</button>
                    ))}
                  </div>
                </div>
              </>
            ) : null}

            {messages.map((message) => {
              if (message.role === "user") {
                return <div key={message.id} className="max-w-[82%] self-end whitespace-pre-wrap break-words rounded-2xl rounded-br-[5px] bg-vn-cobalt px-4 py-3 text-white shadow-[0_8px_24px_rgba(42,47,240,0.25)] motion-reduce:shadow-none" data-merchant-message="user">{message.text}</div>;
              }
              if (message.role === "error") {
                return <div key={message.id} role="alert" className="self-stretch rounded-xl border border-vn-red/40 bg-vn-red/10 p-3 text-xs leading-relaxed text-vn-paper/90" data-merchant-message="error">{message.text}</div>;
              }
              const chips = message.ui.find((block) => block.component === "suggestions");
              const suggestionList = Array.isArray(chips?.payload.suggestions) ? (chips!.payload.suggestions as unknown[]).map(String).slice(0, 4) : [];
              const docLinks = message.ui
                .filter((block) => block.component === "doc_link")
                .map((block) => parseDocLink(block.payload))
                .filter((doc, index, all): doc is DocLinkPayload => doc !== null && all.findIndex((other) => other?.path === doc.path) === index)
                .slice(0, 10);
              return (
                <div key={message.id} className="w-full max-w-[94%] self-start" data-merchant-message="agent">
                  {message.text ? <div className="whitespace-pre-wrap break-words rounded-2xl rounded-tl-[5px] border border-vn-paper/10 bg-vn-card px-4 py-3 text-vn-paper">{message.text}</div> : null}
                  {message.ui.map((block, index) => {
                    if (block.component === "metrics") return <MetricsBlock key={index} payload={block.payload} />;
                    if (block.component === "digest") return <DigestBlock key={index} payload={block.payload} />;
                    if (block.component === "revenue_snapshot") return <RevenueSnapshotCard key={index} payload={block.payload} />;
                    if (block.component === "sushi_answer") return <SushiBlock key={index} payload={block.payload} ownerId={user?.id || ""} />;
                    if (block.component === "change_preview") {
                      const changeId = String(block.payload.change_id || (block.payload.change as MerchantChange | undefined)?.change_id || "");
                      const change = changes[changeId] || (block.payload.change as MerchantChange | undefined);
                      if (!change) return null;
                      return (
                        <ChangeCard
                          key={index}
                          change={change}
                          headline={typeof block.payload.headline === "string" ? block.payload.headline : undefined}
                          note={typeof block.payload.note === "string" ? block.payload.note : undefined}
                          busy={busyChange === changeId}
                          onApprove={() => void decide(changeId, "approve")}
                          onDiscard={() => void decide(changeId, "discard")}
                        />
                      );
                    }
                    return null;
                  })}
                  {docLinks.length ? (
                    <div className="mt-2.5 flex flex-col gap-1.5" data-merchant-doc-links>
                      {docLinks.map((doc) => (
                        <button
                          key={doc.path}
                          type="button"
                          className="flex min-h-[44px] w-full items-center gap-3 rounded-[12px] border border-vn-paper/[.14] bg-vn-card2 px-3 py-2 text-left transition hover:border-vn-lime active:scale-[0.99]"
                          onClick={() => openDoc(doc)}
                          aria-label={`Mở phiếu ${doc.code}`}
                          data-merchant-doc-link={doc.kind}
                        >
                          <span className="shrink-0 rounded-md bg-vn-cobalt/25 px-1.5 py-0.5 font-vnMono text-[10px] font-bold uppercase tracking-[0.08em] text-vn-paper/80">{DOC_KIND_LABEL[doc.kind]}</span>
                          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-vn-paper">{doc.title || doc.code}</span>
                          <span className="flex shrink-0 items-center gap-1 text-xs font-bold text-vn-lime">Mở phiếu<ExternalLink className="h-3.5 w-3.5" /></span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {suggestionList.length && message.id === lastAgentId && !responding ? (
                    <div className="mt-2.5 flex flex-wrap gap-2">
                      {suggestionList.map((suggestion) => (
                        <button key={suggestion} type="button" className="min-h-[34px] rounded-[11px] border border-vn-paper/[.18] bg-vn-card2 px-3 py-1.5 text-left text-xs font-bold text-vn-lime transition hover:border-vn-lime" onClick={() => void send(suggestion)} data-merchant-suggestion>{suggestion}</button>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}

            {responding ? (
              <div className="flex max-w-[88%] items-center gap-2.5 font-vnMono text-[10.5px] uppercase tracking-[0.12em] text-vn-paper/60" data-merchant-responding>
                <span className="grid h-8 w-8 place-items-center rounded-[10px] border border-vn-cobalt-l/30 bg-vn-cobalt-l/10 text-vn-lime"><Loader2 className="h-4 w-4 animate-spin" /></span>
                VNAgent đang xử lý…
              </div>
            ) : null}
            <div ref={endRef} />
          </div>

          <div className="shrink-0 border-t border-vn-paper/10 bg-vn-ink px-3.5 pb-[max(0.75rem,env(safe-area-inset-bottom))] pt-3">
            <div className="flex items-end gap-2">
              <div className="relative min-w-0 flex-1 overflow-clip rounded-[18px] border border-vn-paper/[.18] bg-vn-card py-3 shadow-[0_10px_30px_rgba(0,0,0,0.35)] transition focus-within:border-vn-lime">
                <Textarea
                  ref={composerRef}
                  rows={1}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  aria-label="Tin nhắn cho VNAgent"
                  placeholder="Hỏi về doanh thu, đại lý, SKU, giá…"
                  className="min-h-0 resize-none rounded-none border-0 bg-transparent px-4 py-0 font-vnDisp text-base leading-6 text-vn-paper shadow-none outline-none ring-0 placeholder:text-vn-paper/40 focus-visible:ring-0 focus-visible:ring-offset-0 disabled:opacity-60"
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                  disabled={responding}
                />
              </div>
              <button type="button" className="grid h-12 w-12 shrink-0 place-items-center rounded-xl border-0 bg-vn-lime text-vn-ink transition hover:brightness-105 active:scale-[0.97] disabled:cursor-not-allowed disabled:bg-vn-card2 disabled:text-vn-paper/30" onClick={() => void send()} disabled={!draft.trim() || responding} aria-label="Gửi tin nhắn" data-merchant-send>
                {responding ? <Loader2 className="h-[18px] w-[18px] animate-spin" /> : <ArrowUp className="h-[18px] w-[18px] stroke-[2.2]" />}
              </button>
            </div>
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}
