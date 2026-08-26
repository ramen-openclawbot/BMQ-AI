export const VNAGENT_PROTOCOL_VERSION = 1 as const;
export const DEFAULT_VNAGENT_API_URL = "https://api.vnagent.ai";
export const DEFAULT_VNAGENT_AGENT_ID = "legal";

const SENSITIVE_KEY = /(?:authorization|cookie|password|passwd|secret|token|api[_-]?key|credential|session)/i;
const SAFE_IDENTIFIER_KEYS = new Set([
  "customerId",
  "goodsReceiptId",
  "invoiceId",
  "paymentRequestId",
  "purchaseOrderId",
  "sourceDocumentId",
  "supplierId",
]);
const SAFE_FILTER_KEYS = new Set([
  "channel",
  "page",
  "period",
  "revenue_date",
  "sort",
  "source",
  "status",
  "tab",
  "view",
]);

export type RouteContext = {
  key: string;
  label: string;
  suggestions: string[];
};

export type CurrentPageContext = {
  pathname: string;
  searchParams: Record<string, string>;
  route: { key: string; label: string };
  documentIdentifiers: Record<string, string>;
  filters: Record<string, string>;
};

export type UniversalFrame = {
  v?: number;
  type: string;
  id?: string;
  seq?: number;
  sessionId?: string;
  agentId?: string;
  messageId?: string;
  delta?: string;
  tool?: string;
  rawTool?: string;
  code?: string;
  message?: string;
  content?: { text?: string | null; [key: string]: unknown };
  [key: string]: unknown;
};

export type ToolStatus = "running" | "done" | "error";

export type ChatTimelineItem =
  | { kind: "message"; id: string; role: "user" | "agent" | "system"; text: string }
  | { kind: "tool"; id: string; name: string; status: ToolStatus; details: unknown };

export function resolveVnagentApiUrl(value?: string): string {
  const candidate = String(value || "").trim() || DEFAULT_VNAGENT_API_URL;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
      return DEFAULT_VNAGENT_API_URL;
    }
    return url.toString().replace(/\/$/, "");
  } catch {
    return DEFAULT_VNAGENT_API_URL;
  }
}

export function resolveVnagentAgentId(value?: string): string {
  const candidate = String(value || "").trim();
  return /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(candidate) ? candidate : DEFAULT_VNAGENT_AGENT_ID;
}

function cleanContextValue(value: string): string | null {
  const cleaned = value.trim().slice(0, 120);
  if (!cleaned || /[\r\n\0]/.test(cleaned)) return null;
  return cleaned;
}

export function buildCurrentPageContext(
  pathname: string,
  search: string,
  route: Pick<RouteContext, "key" | "label">,
): CurrentPageContext {
  const searchParams: Record<string, string> = {};
  const documentIdentifiers: Record<string, string> = {};
  const filters: Record<string, string> = {};
  const params = new URLSearchParams(search);

  params.forEach((rawValue, rawKey) => {
    if (SENSITIVE_KEY.test(rawKey)) return;
    const value = cleanContextValue(rawValue);
    if (!value) return;
    if (SAFE_IDENTIFIER_KEYS.has(rawKey) && /^[a-zA-Z0-9._:-]{1,120}$/.test(value)) {
      searchParams[rawKey] = value;
      documentIdentifiers[rawKey] = value;
      return;
    }
    if (SAFE_FILTER_KEYS.has(rawKey)) {
      searchParams[rawKey] = value;
      filters[rawKey] = value;
    }
  });

  return {
    pathname: pathname.startsWith("/") ? pathname.slice(0, 300) : "/",
    searchParams,
    route: { key: route.key, label: route.label },
    documentIdentifiers,
    filters,
  };
}

function sanitizeString(value: string): string {
  const limited = value.length > 500 ? `${value.slice(0, 500)}…` : value;
  return limited
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted-jwt]")
    .replace(/\b(token|secret|password|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/https?:\/\/[^\s]+/gi, (rawUrl) => {
      try {
        const url = new URL(rawUrl);
        return `${url.origin}${url.pathname}`;
      } catch {
        return "[redacted-url]";
      }
    });
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > 4) return "[truncated]";
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => sanitizeValue(entry, depth + 1));
  if (typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 30)) {
      output[key] = SENSITIVE_KEY.test(key) ? "[redacted]" : sanitizeValue(entry, depth + 1);
    }
    return output;
  }
  return String(value);
}

export function sanitizeToolDetails(frame: UniversalFrame): unknown {
  const { v: _v, type: _type, seq: _seq, sessionId: _sessionId, agentId: _agentId, ...details } = frame;
  return sanitizeValue(details, 0);
}

function frameKey(frame: UniversalFrame, index: number): string {
  return String(frame.id || `${frame.type}-${frame.seq ?? index}`);
}

export function appendUniqueFrame(frames: UniversalFrame[], next: UniversalFrame): UniversalFrame[] {
  if (next.type === "agent_tool" && next.id) {
    const priorToolIndex = frames.findIndex((frame) =>
      frame.type === "agent_tool" && frame.id === next.id && frame.sessionId === next.sessionId,
    );
    if (priorToolIndex >= 0) {
      const copy = [...frames];
      copy[priorToolIndex] = next;
      return copy;
    }
  }

  const duplicate = frames.some((frame) =>
    (next.id && frame.id === next.id) ||
    (typeof next.seq === "number" && next.sessionId && frame.sessionId === next.sessionId && frame.seq === next.seq),
  );
  if (duplicate) return frames;

  if (next.type === "user_message_saved") {
    const syntheticIndex = frames.findIndex((frame) =>
      frame.type === "user_message_saved" &&
      frame.synthetic === true &&
      frame.content?.text === next.content?.text,
    );
    if (syntheticIndex >= 0) {
      const copy = [...frames];
      copy[syntheticIndex] = next;
      return copy;
    }
  }
  return [...frames, next];
}

export function timelineFromFrames(frames: UniversalFrame[]): ChatTimelineItem[] {
  const timeline: ChatTimelineItem[] = [];
  const toolIndexes = new Map<string, number>();

  frames.forEach((frame, index) => {
    const key = frameKey(frame, index);
    if (frame.type === "user_message_saved") {
      const text = String(frame.content?.text || "").trim();
      if (text && !text.startsWith("[SESSION_RESET_MEMORY_HANDOFF]")) {
        timeline.push({ kind: "message", id: key, role: "user", text });
      }
      return;
    }
    if (frame.type === "agent_tool") {
      const rawName = String(frame.name || frame.tool || frame.rawTool || "tool");
      if (/^(?:functions\.|tools\.)?message(?:\.send)?$/i.test(rawName)) return;
      const toolKey = `${String(frame.sessionId || "session")}:${String(frame.id || rawName)}`;
      const status = frame.status === "done" || frame.status === "error" ? frame.status : "running";
      const nextItem: ChatTimelineItem = {
        kind: "tool",
        id: toolKey,
        name: rawName,
        status,
        details: sanitizeToolDetails(frame),
      };
      const existingIndex = toolIndexes.get(toolKey);
      if (existingIndex === undefined) {
        toolIndexes.set(toolKey, timeline.length);
        timeline.push(nextItem);
      } else {
        timeline[existingIndex] = nextItem;
      }
      return;
    }
    if (frame.type === "agent_message_done") {
      const text = String(frame.content?.text || "").trim();
      if (text) timeline.push({ kind: "message", id: key, role: "agent", text });
      return;
    }
    if (frame.type === "error" && frame.code !== "duplicate") {
      const safeCode = String(frame.code || "request_failed").replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 60);
      timeline.push({
        kind: "message",
        id: key,
        role: "system",
        text: `VNAgent gặp lỗi khi xử lý yêu cầu (${safeCode}).`,
      });
    }
  });

  return timeline;
}

export function createUserMessageFrame(args: {
  id: string;
  sessionId: string;
  agentId: string;
  text: string;
  currentPage: CurrentPageContext;
}): UniversalFrame {
  return {
    v: VNAGENT_PROTOCOL_VERSION,
    type: "user_message",
    id: args.id,
    sessionId: args.sessionId,
    agentId: args.agentId,
    content: { text: args.text },
    context: {
      source: "bmq-web",
      currentPage: args.currentPage,
    },
    ts: new Date().toISOString(),
  };
}
