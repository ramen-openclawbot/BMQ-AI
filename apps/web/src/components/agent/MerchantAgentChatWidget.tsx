import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { AlertTriangle, ArrowLeft, ArrowUp, Check, ChevronDown, ExternalLink, Eye, ImagePlus, Loader2, RotateCcw, X } from "lucide-react";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useAuth } from "@/contexts/AuthContext";
import { supabase } from "@/integrations/supabase/client";
import { cn } from "@/lib/utils";
import { CostBusinessCard } from "@/components/agent/CostBusinessCard";
import { UncImageGallery } from "@/components/agent/UncImageGallery";
import { RevenueSnapshotCard } from "@/components/agent/RevenueSnapshotCard";
import { BankSlipCard, parseBankSlipPayload } from "@/components/agent/BankSlipCard";
import { costLineBlockSchema, uncImageSchema } from "@/lib/bmqAnalytics";
import { CHAT_IMAGE_MAX_SOURCE_BYTES, formatMegabytes, prepareChatImage, type PreparedChatImage } from "@/lib/chatImageUpload";
import {
  MERCHANT_ATTACHMENT_MAX_BYTES,
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
import "@/styles/bmq-agent-chat.css";

// The owner's back-office chat: Anthropic's merchant agent (Claude Haiku via the owner's
// Claude Code login) answering from BMQ data. It replaced the Sushi analytics chat on
// 18/10 at the owner's request; nothing it proposes is applied until he taps Duyệt.
// Look (owner 30/10): the BMQ app theme with the pink BMQ badge (bmq-agent-chat.css).

type ChatMessage =
  // attachmentPreview is the prepared image as a data: URL; it lives in memory only.
  | { id: string; role: "user"; text: string; attachmentName?: string; attachmentPreview?: string }
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
    // Image bytes stay out of sessionStorage (quota); after a reload the bubble shows the name.
    const messages = chat.messages.slice(-STORE_MAX_MESSAGES).map((message) => (message.role === "user" && message.attachmentPreview ? { ...message, attachmentPreview: undefined } : message));
    if (!chat.messages.length) window.sessionStorage.removeItem(STORE_PREFIX + userId);
    else window.sessionStorage.setItem(STORE_PREFIX + userId, JSON.stringify({ ...chat, messages }));
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

const BMQ_LOGO = "/assets/brand/bmq-logo-96.png";
const BMQ_LOGO_SET = "/assets/brand/bmq-logo-96.png 1x, /assets/brand/bmq-logo-192.png 2x";

const newId = () => crypto.randomUUID();

// A bank slip sent without words still needs a message line in the conversation.
const SLIP_DEFAULT_MESSAGE = "Duyệt chi theo bankslip";

// One image waits in the composer (the service reads one bank slip per message). It shows at
// once from an object URL while the 2048px copy is prepared, as chat.vnagent.ai does.
type PendingImage = {
  id: string;
  name: string;
  sourceBytes: number;
  previewUrl: string;
  prepared: Promise<PreparedChatImage>;
  ready: PreparedChatImage | null;
};

type SendStage = { label: string; fraction: number | null };

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
    <div className="ac-card" data-merchant-ui="metrics">
      {payload.title || payload.period ? (
        <div className="ac-card-head">
          {payload.title ? <span className="ac-card-title">{String(payload.title)}</span> : null}
          {payload.period ? <span className="ac-meta ac-num">{String(payload.period)}</span> : null}
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
            <div key={`${String(metric.metric)}-${index}`} className={cn("ac-well min-w-0", points.length > 1 && "col-span-2")}>
              <div className="ac-label truncate">
                {merchantMetricLabel(String(metric.metric || ""))}
                {series?.segment ? ` · ${series.segment.replace(/^channel:/, "")}` : ""}
              </div>
              <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2">
                <span className="ac-value-sm">{formatMerchantValue(value, unit)}</span>
                {change !== null ? (
                  <span className={cn("ac-delta text-[13px]", change > 0 ? "ac-pos" : change < 0 ? "ac-neg" : "")}>
                    {change >= 0 ? "+" : ""}{change.toLocaleString("vi-VN", { maximumFractionDigits: 1 })}%
                  </span>
                ) : null}
              </div>
              {points.length > 1 ? (
                <div className="ac-spark" aria-hidden="true">
                  {points.slice(-31).map((point) => (
                    <span key={point.date} title={`${point.date}: ${formatMerchantValue(point.value, unit)}`} style={{ height: `${Math.max(6, (Number(point.value) / max) * 100)}%` }} />
                  ))}
                </div>
              ) : null}
              {metric.note ? <div className="ac-meta mt-1.5">{String(metric.note)}</div> : null}
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
    <div className="ac-card" data-merchant-ui="digest">
      {payload.title ? <div className="ac-card-head"><span className="ac-card-title">{String(payload.title)}</span></div> : null}
      <ul className="ac-rows">
        {items.map((item, index) => (
          <li key={`${String(item.ref_id || "")}-${index}`}>
            <span className={cn("ac-mark", item.kind === "order_issue" ? "is-red" : item.kind === "pending_change" ? "is-pink" : "")} />
            <span className="min-w-0">
              <span className="ac-strong block leading-5">{String(item.headline || "")}</span>
              {item.why_it_matters ? <span className="ac-meta block">{String(item.why_it_matters)}</span> : null}
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
    <div className="ac-card" data-merchant-ui="sushi">
      {answer ? <div className="whitespace-pre-wrap break-words text-[14px] leading-6">{answer}</div> : null}
      {cost.success ? (
        <div className="mt-2.5">
          <CostBusinessCard block={cost.data} language="vi" followUpEnabled={false} followUpDisabledReason="Anh hỏi tiếp ngay trong ô chat." onFollowUp={() => undefined} />
        </div>
      ) : null}
      {images.length ? <UncImageGallery images={images} language="vi" ownerId={ownerId} /> : null}
      {details ? (
        <details className="ac-details ac-divide mt-2.5">
          <summary>Xem chi tiết<ChevronDown aria-hidden="true" /></summary>
          <div className="ac-meta max-h-64 overflow-auto whitespace-pre-wrap break-words pb-1">{details}</div>
        </details>
      ) : null}
      {citations.length ? (
        <div className="ac-meta ac-divide mt-2 pt-2">
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
  const pill = change.status === "applied" ? "is-pos" : change.status === "failed" ? "is-neg" : change.status === "discarded" ? "" : "is-pink";
  return (
    <div className="ac-card" data-merchant-change={change.change_id} data-merchant-change-status={change.status}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="ac-card-title break-words leading-5">{headline || change.summary || "Bản nháp thay đổi"}</div>
          <div className="ac-meta mt-0.5">{merchantChangeKindLabel(change.kind)}</div>
        </div>
        <span className={cn("ac-pill", pill)}>{merchantChangeStatusLabel(change.status)}</span>
      </div>
      {items.length ? (
        <ul className="ac-divide mt-2.5 space-y-1.5 pt-2.5">
          {items.slice(0, 8).map((item, index) => (
            <li key={index} className="text-[13px] leading-5">
              <span className="ac-strong">{item.target}{item.field && item.field !== "name" ? ` · ${item.field}` : ""}</span>
              <span className="block break-words text-[var(--ac-ink-2)]">
                {item.before !== undefined ? <><span className="text-[var(--ac-dim)] line-through">{formatMerchantChangeValue(item.before)}</span>{" → "}</> : null}
                <span className="text-[var(--ac-ink)]">{formatMerchantChangeValue(item.after)}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {note && open ? <div className="ac-meta mt-2">{note}</div> : null}
      {open && change.guardrail_notes?.length ? (
        <ul className="mt-2.5 space-y-1.5" data-merchant-change-warnings>
          {change.guardrail_notes.map((warning) => (
            <li key={warning} className="ac-notice"><AlertTriangle aria-hidden="true" />{warning}</li>
          ))}
        </ul>
      ) : null}
      {change.status === "failed" && change.error ? <div className="ac-fail" role="alert">{change.error}</div> : null}
      {open ? (
        <div className="ac-actions">
          <button type="button" className="ac-btn ac-btn-primary" disabled={busy} onClick={onApprove} data-merchant-change-action="approve">
            {busy ? <Loader2 className="animate-spin" /> : <Check />} Duyệt
          </button>
          <button type="button" className="ac-btn ac-btn-ghost" disabled={busy} onClick={onDiscard} data-merchant-change-action="discard">
            Bỏ
          </button>
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
  const [pendingImage, setPendingImage] = useState<PendingImage | null>(null);
  const [imageError, setImageError] = useState<string | null>(null);
  const [sendStage, setSendStage] = useState<SendStage | null>(null);
  const [viewer, setViewer] = useState<{ src: string; name: string } | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const pendingRef = useRef<PendingImage | null>(null);

  // The object URL of the waiting image is released whenever it is replaced, sent or removed.
  const replacePending = useCallback((next: PendingImage | null) => {
    const previous = pendingRef.current;
    if (previous && previous.previewUrl !== next?.previewUrl) URL.revokeObjectURL(previous.previewUrl);
    pendingRef.current = next;
    setPendingImage(next);
  }, []);
  useEffect(() => () => {
    if (pendingRef.current) URL.revokeObjectURL(pendingRef.current.previewUrl);
  }, []);

  // A different signed-in account never sees the previous conversation; the same account
  // gets its conversation back after a reload in this tab.
  useEffect(() => {
    const stored = loadChat(user?.id);
    setMessages(stored?.messages || []);
    setSessionId(stored?.sessionId || null);
    setChanges(stored?.changes || {});
    setDraft("");
    replacePending(null);
    setImageError(null);
    setOpenedDoc(stored?.openedDoc || null);
    setRestoredFor(user?.id || null);
  }, [user?.id, replacePending]);

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
    // Chrome counts a wrapped placeholder in scrollHeight, so an empty box stays one line.
    if (!draft) {
      node.style.height = "24px";
      node.style.overflowY = "hidden";
      return;
    }
    node.style.height = "0px";
    node.style.height = `${Math.min(Math.max(24, node.scrollHeight), 144)}px`;
    node.style.overflowY = node.scrollHeight > 144 ? "auto" : "hidden";
  }, [draft, open, pendingImage]);

  useEffect(() => {
    if (!open) return;
    const frame = window.requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: "end" }));
    return () => window.cancelAnimationFrame(frame);
  }, [messages, responding, open]);

  const pickImage = useCallback((file: File | undefined) => {
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (!file) return;
    setImageError(null);
    if (!file.type.startsWith("image/")) {
      setImageError("Anh chọn một ảnh bankslip (JPG, PNG hoặc WebP).");
      return;
    }
    if (file.size > CHAT_IMAGE_MAX_SOURCE_BYTES) {
      setImageError(`${file.name || "Ảnh"} lớn hơn 10 MB. Anh chụp màn hình rồi gửi lại nhé.`);
      return;
    }
    const id = newId();
    const prepared = prepareChatImage(file).then((image) => {
      if (image.bytes > MERCHANT_ATTACHMENT_MAX_BYTES) throw new Error("Ảnh vẫn lớn hơn 6 MB sau khi thu nhỏ. Anh chụp màn hình bankslip rồi gửi lại nhé.");
      return image;
    });
    const item: PendingImage = { id, name: file.name || "bankslip.jpg", sourceBytes: file.size, previewUrl: URL.createObjectURL(file), prepared, ready: null };
    replacePending(item);
    prepared.then(
      (image) => {
        if (pendingRef.current?.id !== id) return;
        const next = { ...pendingRef.current, ready: image };
        pendingRef.current = next;
        setPendingImage(next);
      },
      (error: unknown) => {
        if (pendingRef.current?.id !== id) return;
        replacePending(null);
        setImageError(error instanceof Error ? error.message : "Không đọc được ảnh này.");
      },
    );
  }, [replacePending]);

  const send = useCallback(async (raw?: string) => {
    // Starters and suggestions send text only; the composer also sends the waiting image.
    const image = raw === undefined ? pendingImage : null;
    const message = (raw ?? draft).trim() || (image ? SLIP_DEFAULT_MESSAGE : "");
    if (!message || responding) return;
    setImageError(null);
    let prepared: PreparedChatImage | null = null;
    if (image) {
      setResponding(true);
      if (!image.ready) setSendStage({ label: "Đang tối ưu ảnh…", fraction: null });
      try {
        prepared = image.ready ?? await image.prepared;
      } catch (error) {
        setSendStage(null);
        setResponding(false);
        replacePending(null);
        setImageError(error instanceof Error ? error.message : "Không đọc được ảnh này.");
        return;
      }
      setSendStage({ label: "Đang tải lên", fraction: 0 });
      replacePending(null);
    }
    setDraft("");
    setMessages((current) => [...current, {
      id: newId(),
      role: "user",
      text: message,
      ...(image && prepared ? { attachmentName: image.name, attachmentPreview: prepared.dataUrl } : {}),
    }]);
    setResponding(true);
    try {
      const token = await currentToken(session?.access_token);
      const result = await sendMerchantMessage(token, {
        message,
        sessionId,
        page: merchantPageContext(location.pathname),
        ...(prepared ? {
          attachments: [{ kind: "image" as const, mime_type: prepared.mimeType, data_base64: prepared.base64 }],
          onUploadProgress: (fraction: number) => setSendStage(fraction >= 1 ? { label: "VNAgent đang đọc bankslip…", fraction: null } : { label: "Đang tải lên", fraction }),
        } : {}),
      });
      setSessionId(result.session_id || sessionId);
      setMessages((current) => [...current, { id: newId(), role: "agent", text: result.text || "", ui: result.ui || [] }]);
      setChanges((current) => {
        const next = { ...current };
        for (const block of result.ui || []) {
          const change = block.component === "change_preview" ? block.payload.change as MerchantChange | undefined : undefined;
          if (change?.change_id) next[change.change_id] = { ...change, ...(next[change.change_id]?.status && next[change.change_id].status !== "staged" ? { status: next[change.change_id].status } : {}) };
          if (block.component === "bank_slip_payment") {
            const slip = parseBankSlipPayload(block.payload);
            if (slip.changeId && (!next[slip.changeId] || next[slip.changeId].status === "staged")) {
              next[slip.changeId] = { ...next[slip.changeId], change_id: slip.changeId, kind: "bank_slip_payment", status: slip.status };
            }
          }
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
      setSendStage(null);
      setResponding(false);
    }
  }, [draft, pendingImage, responding, session?.access_token, sessionId, location.pathname, replacePending]);

  const decide = useCallback(async (changeId: string, decision: "approve" | "discard", categoryCode?: string) => {
    setBusyChange(changeId);
    try {
      const token = await currentToken(session?.access_token);
      const updated = decision === "approve" ? await approveMerchantChange(token, changeId, { categoryCode }) : await discardMerchantChange(token, changeId);
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
    replacePending(null);
    setImageError(null);
    setOpenedDoc(null);
  };

  if (!enabled) return null;

  const path = location.pathname;
  const lastAgentId = [...messages].reverse().find((message) => message.role === "agent")?.id;
  // Starters follow the page the owner is on; pages without their own set keep the general ones.
  const pageGuide = merchantPageGuide(path);
  const pageStarters = pageGuide?.suggestions?.length ? pageGuide.suggestions : null;
  const starters = pageStarters || STARTERS;
  const canSend = (Boolean(draft.trim()) || Boolean(pendingImage)) && !responding;
  const pendingBytes = pendingImage ? (pendingImage.ready?.bytes ?? pendingImage.sourceBytes) : 0;

  return (
    <>
      <button
        type="button"
        data-merchant-agent-launcher="v1"
        // One size on every page (owner 22/10). Pages with a pinned bottom bar or button move it
        // clear in bmq-shell.css ("chat launcher"), not by shrinking or hiding it here.
        className="d3-agent-launcher ac-launcher fixed bottom-[calc(1.5rem+env(safe-area-inset-bottom))] right-6 z-50"
        onClick={backToChat}
        aria-label="Mở VNAgent"
      >
        {!open ? <span aria-hidden="true" className="ac-launcher-halo animate-vnagent-halo motion-reduce:animate-none" /> : null}
        <img src={BMQ_LOGO} srcSet={BMQ_LOGO_SET} alt="" width={50} height={50} />
      </button>

      {openedDoc && !open && location.pathname === openedDoc.path.split("?")[0] ? (
        // A compact tab on the left edge: phiếu dialogs keep their sticky header (title, close)
        // at the top and their action bar at the bottom on mobile. z-[60] sits above the dialog
        // and pointer-events-auto keeps it clickable while a modal sets pointer-events: none.
        <button
          type="button"
          className="ac-backpill pointer-events-auto fixed left-0 top-[42%] z-[60]"
          onClick={backToChat}
          aria-label={`Quay lại chat VNAgent (đang xem ${openedDoc.code})`}
          data-merchant-back-to-chat
        >
          <span className="ac-backpill-arrow"><ArrowLeft /></span>
          <span>Chat</span>
          <span className="ac-backpill-code hidden sm:inline">{openedDoc.code}</span>
        </button>
      ) : null}

      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          lang="vi"
          data-merchant-agent-chat="claude-merchant-v1"
          className="ac-sheet w-full [&>button]:hidden sm:w-[440px] sm:max-w-[440px]"
          onEscapeKeyDown={(event) => {
            if (!viewer) return;
            event.preventDefault();
            setViewer(null);
          }}
        >
          <header className="ac-head">
            <img className="ac-logo" src={BMQ_LOGO} srcSet={BMQ_LOGO_SET} alt="BMQ" width={52} height={52} data-merchant-agent-logo />
            <div className="ac-head-copy">
              <SheetTitle className="ac-title">VNAgent</SheetTitle>
              <div className="ac-status">
                <span className={cn("ac-dot", responding && "is-busy")} />
                <span>{responding ? "Đang trả lời" : "Sẵn sàng"} · Trợ lý AI của BMQ</span>
              </div>
            </div>
            <button type="button" className="ac-key" onClick={reset} aria-label="Tạo cuộc trò chuyện mới" data-merchant-agent-reset><RotateCcw /></button>
            <button type="button" className="ac-key" onClick={() => setOpen(false)} aria-label="Đóng VNAgent"><X /></button>
          </header>

          <div className="ac-scroll">
            {messages.length === 0 ? (
              <>
                <div className="ac-intro">
                  <img src={BMQ_LOGO} srcSet={BMQ_LOGO_SET} alt="" width={40} height={40} />
                  <div className="ac-bubble ac-bubble-agent">
                    Xin chào{name ? `, ${name}` : ""}. VNAgent xem được doanh thu, đơn đại lý, công nợ, chi phí, SKU và giá riêng, và đọc ảnh bankslip để lên duyệt chi. Mọi thay đổi VNAgent soạn chỉ là bản nháp — anh bấm <b className="font-semibold">Duyệt</b> mới áp.
                  </div>
                </div>
                <div className="ac-panel" data-merchant-starters={pageStarters ? pageGuide?.prefix : "general"}>
                  <div className="ac-panel-label">
                    {pageStarters && pageGuide ? <>Gợi ý · <b>{pageGuide.label}</b></> : "Gợi ý nhanh"}
                  </div>
                  <div className="ac-chips">
                    {starters.map((starter) => (
                      <button key={starter} type="button" className="ac-chip" onClick={() => void send(starter)} disabled={responding} data-merchant-starter>{starter}</button>
                    ))}
                  </div>
                </div>
              </>
            ) : null}

            {messages.map((message) => {
              if (message.role === "user") {
                return (
                  <div key={message.id} className="flex max-w-[86%] flex-col items-end self-end" data-merchant-message="user">
                    {message.attachmentPreview ? (
                      <button
                        type="button"
                        className="ac-sent-image"
                        onClick={() => setViewer({ src: message.attachmentPreview!, name: message.attachmentName || "Bankslip" })}
                        aria-label={`Xem ảnh ${message.attachmentName || "bankslip"}`}
                        data-merchant-message-attachment="image"
                      >
                        <img src={message.attachmentPreview} alt={message.attachmentName || "Bankslip"} />
                      </button>
                    ) : null}
                    <div className="ac-bubble ac-bubble-user max-w-full">
                      {message.attachmentName && !message.attachmentPreview ? (
                        <span className="ac-sent-chip" data-merchant-message-attachment="name">
                          <ImagePlus className="h-3.5 w-3.5 shrink-0" /><span className="min-w-0 truncate">{message.attachmentName}</span>
                        </span>
                      ) : null}
                      {message.text}
                    </div>
                  </div>
                );
              }
              if (message.role === "error") {
                return <div key={message.id} role="alert" className="ac-error" data-merchant-message="error">{message.text}</div>;
              }
              const chips = message.ui.find((block) => block.component === "suggestions");
              const suggestionList = Array.isArray(chips?.payload.suggestions) ? (chips!.payload.suggestions as unknown[]).map(String).slice(0, 4) : [];
              const docLinks = message.ui
                .filter((block) => block.component === "doc_link")
                .map((block) => parseDocLink(block.payload))
                .filter((doc, index, all): doc is DocLinkPayload => doc !== null && all.findIndex((other) => other?.path === doc.path) === index)
                .slice(0, 10);
              return (
                <div key={message.id} className="ac-agent-turn" data-merchant-message="agent">
                  {message.text ? <div className="ac-bubble ac-bubble-agent">{message.text}</div> : null}
                  {message.ui.map((block, index) => {
                    if (block.component === "metrics") return <MetricsBlock key={index} payload={block.payload} />;
                    if (block.component === "digest") return <DigestBlock key={index} payload={block.payload} />;
                    if (block.component === "revenue_snapshot") return <RevenueSnapshotCard key={index} payload={block.payload} />;
                    if (block.component === "sushi_answer") return <SushiBlock key={index} payload={block.payload} ownerId={user?.id || ""} />;
                    if (block.component === "bank_slip_payment") {
                      const slip = parseBankSlipPayload(block.payload);
                      return (
                        <BankSlipCard
                          key={index}
                          data={slip}
                          state={slip.changeId ? changes[slip.changeId] : undefined}
                          busy={busyChange === slip.changeId}
                          onApprove={(categoryCode) => void decide(slip.changeId, "approve", categoryCode)}
                          onDiscard={() => void decide(slip.changeId, "discard")}
                          onOpenDoc={openDoc}
                        />
                      );
                    }
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
                          className="ac-doc"
                          onClick={() => openDoc(doc)}
                          aria-label={`Mở phiếu ${doc.code}`}
                          data-merchant-doc-link={doc.kind}
                        >
                          <span className="ac-doc-kind">{DOC_KIND_LABEL[doc.kind]}</span>
                          <span className="ac-doc-title">{doc.title || doc.code}</span>
                          <span className="ac-doc-open">Mở phiếu<ExternalLink aria-hidden="true" /></span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                  {suggestionList.length && message.id === lastAgentId && !responding ? (
                    <div className="ac-chips mt-2.5">
                      {suggestionList.map((suggestion) => (
                        <button key={suggestion} type="button" className="ac-chip" onClick={() => void send(suggestion)} data-merchant-suggestion>{suggestion}</button>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })}

            {responding ? (
              <div className="ac-thinking" data-merchant-responding>
                <span className="ac-thinking-dots" aria-hidden="true"><i /><i /><i /></span>
                VNAgent đang xử lý…
              </div>
            ) : null}
            <div ref={endRef} />
          </div>

          <div className="ac-composer">
            {sendStage ? (
              <div className="ac-pending" data-merchant-upload-progress>
                <div className="ac-progress-label">
                  <span className="flex items-center gap-1.5"><Loader2 className="h-3.5 w-3.5 animate-spin" />{sendStage.label}</span>
                  {sendStage.fraction !== null ? <span className="ac-num">{Math.round(sendStage.fraction * 100)}%</span> : null}
                </div>
                <div className="ac-progress-bar" aria-hidden="true">
                  <span style={{ width: `${sendStage.fraction === null ? 100 : Math.max(4, sendStage.fraction * 100)}%`, opacity: sendStage.fraction === null ? 0.35 : 1 }} />
                </div>
              </div>
            ) : null}
            {pendingImage && !sendStage ? (
              <div className="ac-pending" data-merchant-pending-image>
                <div className="ac-pending-head">
                  <span><b>1 ảnh</b> · <span className="ac-num">{formatMegabytes(pendingBytes)}</span></span>
                  <span>{pendingImage.ready ? "Sẵn sàng gửi" : "Đang tối ưu…"}</span>
                </div>
                <div className="ac-pending-body">
                  <div className="ac-tile">
                    <img src={pendingImage.previewUrl} alt={pendingImage.name} data-merchant-pending-thumb />
                    {!pendingImage.ready ? <span className="ac-tile-busy" aria-hidden="true"><Loader2 className="animate-spin" /></span> : null}
                    <button type="button" className="ac-tile-view" onClick={() => setViewer({ src: pendingImage.previewUrl, name: pendingImage.name })} aria-label={`Xem ảnh ${pendingImage.name}`} data-merchant-view-image>
                      <Eye aria-hidden="true" />Xem
                    </button>
                    <button type="button" className="ac-tile-x" onClick={() => replacePending(null)} aria-label="Bỏ ảnh bankslip" data-merchant-remove-image><X /></button>
                  </div>
                  <p className="ac-pending-note m-0">VNAgent đọc bankslip và soạn thẻ duyệt chi. Chưa ghi gì cho tới khi anh bấm Duyệt.</p>
                </div>
              </div>
            ) : null}
            {imageError && !pendingImage ? (
              <div role="alert" className="ac-pending-error" data-merchant-image-error><AlertTriangle aria-hidden="true" />{imageError}</div>
            ) : null}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/*"
              className="hidden"
              onChange={(event) => pickImage(event.target.files?.[0])}
              data-merchant-image-input
            />
            <div className="ac-input-row">
              <button type="button" className="ac-round ac-attach" onClick={() => fileInputRef.current?.click()} disabled={responding} aria-label="Gửi ảnh bankslip" title="Gửi ảnh bankslip để duyệt chi" data-merchant-attach-image>
                <ImagePlus />
              </button>
              <div className="ac-input">
                <textarea
                  ref={composerRef}
                  rows={1}
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  aria-label="Tin nhắn cho VNAgent"
                  placeholder={pendingImage ? "Thêm ghi chú…" : "Nhắn cho VNAgent…"}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                  disabled={responding}
                />
              </div>
              <button type="button" className="ac-round ac-send" onClick={() => void send()} disabled={!canSend} aria-label="Gửi tin nhắn" data-merchant-send>
                {responding ? <Loader2 className="animate-spin" /> : <ArrowUp strokeWidth={2.2} />}
              </button>
            </div>
          </div>

          {viewer ? (
            <div className="ac-viewer" role="dialog" aria-modal="true" aria-label={`Ảnh ${viewer.name}`} data-merchant-image-viewer onClick={() => setViewer(null)}>
              <div className="ac-viewer-bar" onClick={(event) => event.stopPropagation()}>
                <span>{viewer.name}</span>
                <button type="button" className="ac-key" onClick={() => setViewer(null)} aria-label="Đóng ảnh" data-merchant-viewer-close><X /></button>
              </div>
              <div className="ac-viewer-img">
                <img src={viewer.src} alt={viewer.name} onClick={(event) => event.stopPropagation()} />
              </div>
            </div>
          ) : null}
        </SheetContent>
      </Sheet>
    </>
  );
}
