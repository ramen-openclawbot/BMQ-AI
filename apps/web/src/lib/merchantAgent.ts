// Client for the BMQ merchant agent (Anthropic commerce-agents on the owner's Mac,
// exposed at bmq-agent.vnagent.ai). The service checks the Supabase JWT and the
// owner role itself; every write it proposes stays staged until the owner approves.

export const MERCHANT_AGENT_URL = (import.meta.env?.VITE_BMQ_MERCHANT_AGENT_URL || "https://bmq-agent.vnagent.ai").replace(/\/$/, "");

const CHAT_TIMEOUT_MS = 120_000;
const ACTION_TIMEOUT_MS = 30_000;

export type MerchantChangeItem = {
  target?: string;
  field?: string;
  before?: unknown;
  after?: unknown;
};

export type MerchantChange = {
  change_id: string;
  kind: string;
  status: string;
  summary?: string;
  items?: MerchantChangeItem[];
  created_at?: string;
  error?: string | null;
  /** Advisory warnings from the Decisions API draft guard. */
  guardrail_notes?: string[];
  /** Bank-slip approvals: the paid payment request and its open link. */
  request_number?: string | null;
  doc_link?: unknown;
  classification?: string | null;
};

/** One image the owner attaches in chat; the service reads it as a bank slip. */
export type MerchantAttachment = {
  kind: "image";
  mime_type: string;
  data_base64: string;
};

export const MERCHANT_ATTACHMENT_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
/** The service refuses images above 6 MB decoded. */
export const MERCHANT_ATTACHMENT_MAX_BYTES = 6 * 1024 * 1024;

export type MerchantUiBlock = {
  component: string;
  payload: Record<string, unknown>;
};

export type DocLinkPayload = {
  kind: "pr" | "po" | "gr";
  code: string;
  id: string;
  title: string;
  path: string;
};

const DOC_LINK_PATHS: Record<DocLinkPayload["kind"], string> = {
  pr: "/payment-requests",
  po: "/purchase-orders",
  gr: "/goods-receipts",
};

const DOC_LINK_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validate a `doc_link` UI payload before the chat renders its open button. */
export function parseDocLink(payload: unknown): DocLinkPayload | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const candidate = payload as Record<string, unknown>;
  const kind = candidate.kind;
  if (kind !== "pr" && kind !== "po" && kind !== "gr") return null;
  const { code, id, title, path } = candidate;
  if (typeof code !== "string" || typeof id !== "string" || typeof title !== "string" || typeof path !== "string") return null;
  if (!DOC_LINK_UUID_RE.test(id)) return null;
  if (!path.startsWith(`${DOC_LINK_PATHS[kind]}?id=`)) return null;
  return { kind, code, id, title, path };
}

export type MerchantChatResponse = {
  session_id: string;
  text: string;
  ui: MerchantUiBlock[];
  tool_calls: string[];
  pending_changes: MerchantChange[];
};

export class MerchantAgentError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function call<T>(path: string, token: string, init: RequestInit, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${MERCHANT_AGENT_URL}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init.headers || {}) },
    });
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok) {
      const detail = body && (typeof body.error === "string" ? body.error : typeof body.detail === "string" ? body.detail : "");
      throw new MerchantAgentError(detail || readableStatus(response.status), response.status);
    }
    return body as T;
  } catch (error) {
    if (error instanceof MerchantAgentError) throw error;
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new MerchantAgentError("BMQ Agent trả lời quá lâu. Anh thử lại giúp BMQ Agent.", 504);
    }
    throw new MerchantAgentError("Không kết nối được BMQ Agent. Anh thử lại sau ít phút.", 0);
  } finally {
    window.clearTimeout(timer);
  }
}

function readableStatus(status: number): string {
  if (status === 401) return "Phiên đăng nhập đã hết hạn. Anh tải lại trang giúp em.";
  if (status === 403) return "Tài khoản này không có quyền dùng BMQ Agent.";
  if (status === 502 || status === 503) return "BMQ Agent đang tạm ngắt kết nối. Anh thử lại sau ít phút.";
  return `BMQ Agent báo lỗi (${status}).`;
}

// fetch() cannot report upload progress; a message carrying an image goes through XHR so the
// composer can show "Đang tải lên x%" like chat.vnagent.ai. Same headers, errors and timeout.
function postWithUploadProgress<T>(path: string, token: string, body: string, timeoutMs: number, onUploadProgress: (fraction: number) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `${MERCHANT_AGENT_URL}${path}`);
    request.timeout = timeoutMs;
    request.setRequestHeader("content-type", "application/json");
    request.setRequestHeader("authorization", `Bearer ${token}`);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) onUploadProgress(Math.min(1, event.loaded / event.total));
    };
    request.upload.onload = () => onUploadProgress(1);
    request.onload = () => {
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(request.responseText) as Record<string, unknown>;
      } catch {
        parsed = null;
      }
      if (request.status < 200 || request.status >= 300) {
        const detail = parsed && (typeof parsed.error === "string" ? parsed.error : typeof parsed.detail === "string" ? parsed.detail : "");
        reject(new MerchantAgentError(detail || readableStatus(request.status), request.status));
        return;
      }
      resolve(parsed as T);
    };
    request.ontimeout = () => reject(new MerchantAgentError("BMQ Agent trả lời quá lâu. Anh thử lại giúp BMQ Agent.", 504));
    request.onerror = () => reject(new MerchantAgentError("Không kết nối được BMQ Agent. Anh thử lại sau ít phút.", 0));
    request.send(body);
  });
}

export function sendMerchantMessage(
  token: string,
  input: { message: string; sessionId?: string | null; page?: string; attachments?: MerchantAttachment[]; onUploadProgress?: (fraction: number) => void },
) {
  const body = JSON.stringify({
    message: input.message,
    ...(input.sessionId ? { session_id: input.sessionId } : {}),
    ...(input.page ? { page: input.page } : {}),
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
  });
  if (input.attachments?.length && input.onUploadProgress && typeof XMLHttpRequest !== "undefined") {
    return postWithUploadProgress<MerchantChatResponse>("/v1/chat", token, body, CHAT_TIMEOUT_MS, input.onUploadProgress);
  }
  return call<MerchantChatResponse>("/v1/chat", token, { method: "POST", body }, CHAT_TIMEOUT_MS);
}

// Paying from a bank slip runs OCR checks, the UNC confirm and the cost write in one call.
const BANK_SLIP_APPROVE_TIMEOUT_MS = 90_000;

export function approveMerchantChange(token: string, changeId: string, input?: { categoryCode?: string | null }) {
  const categoryCode = input?.categoryCode?.trim();
  return call<MerchantChange>(
    `/v1/changes/${encodeURIComponent(changeId)}/approve`,
    token,
    { method: "POST", ...(categoryCode ? { body: JSON.stringify({ category_code: categoryCode }) } : {}) },
    categoryCode ? BANK_SLIP_APPROVE_TIMEOUT_MS : ACTION_TIMEOUT_MS,
  );
}

export function discardMerchantChange(token: string, changeId: string) {
  return call<MerchantChange>(`/v1/changes/${encodeURIComponent(changeId)}/discard`, token, { method: "POST" }, ACTION_TIMEOUT_MS);
}

const KIND_LABELS: Record<string, string> = {
  price: "Giá riêng đại lý",
  price_update: "Giá riêng đại lý",
  promotion: "Khuyến mãi (thông báo dathang)",
  campaign: "Thông báo dathang",
  listing: "Danh mục SKU",
  listing_update: "Danh mục SKU",
  inventory: "Kho",
  inventory_action: "Kho",
  bank_slip_payment: "Duyệt chi từ bankslip",
};

export function merchantChangeKindLabel(kind: string): string {
  return KIND_LABELS[kind] || kind;
}

const STATUS_LABELS: Record<string, string> = {
  staged: "Chờ duyệt",
  approved: "Đã duyệt",
  applied: "Đã áp dụng",
  discarded: "Đã bỏ",
  failed: "Không áp được",
};

export function merchantChangeStatusLabel(status: string): string {
  return STATUS_LABELS[status] || status;
}

const METRIC_LABELS: Record<string, string> = {
  sales: "Doanh thu",
  revenue: "Doanh thu",
  orders: "Số đơn",
  order_count: "Số đơn",
  average_order_value: "Giá trị TB/đơn",
  quantity: "Số lượng",
  units: "Số lượng",
};

export function merchantMetricLabel(metric: string): string {
  return METRIC_LABELS[metric.trim().toLowerCase().replace(/\s+/g, "_")] || metric;
}

export function formatMerchantValue(value: unknown, unit?: string | null): string {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return value == null ? "—" : String(value);
  if (unit === "VND" || unit === "vnd") {
    if (Math.abs(numeric) >= 1_000_000) return `${(numeric / 1_000_000).toLocaleString("vi-VN", { maximumFractionDigits: 1 })} triệu`;
    return `${Math.round(numeric).toLocaleString("vi-VN")} đ`;
  }
  return numeric.toLocaleString("vi-VN", { maximumFractionDigits: 1 });
}

export function formatMerchantChangeValue(value: unknown): string {
  if (value == null || value === "") return "—";
  if (typeof value === "number") return value.toLocaleString("vi-VN");
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
