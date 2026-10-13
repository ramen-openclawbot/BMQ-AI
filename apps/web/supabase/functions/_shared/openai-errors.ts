/**
 * Shared OpenAI error classification for every edge function that reads images
 * through OpenAI (vision chat completions or the responses API).
 *
 * The goal is one explicit, user-actionable signal when the OpenAI account runs
 * out of quota: HTTP 503 with code "ai_quota_exhausted" and a Vietnamese message
 * telling the operator to ask an admin to top up — manual entry still works.
 * Generic 429s become "ai_rate_limited"; everything else is "ai_upstream_error".
 *
 * The internal per-user rate limiter (_shared/rate-limiter.ts) is untouched; it
 * still owns its own status/message and never maps onto these helpers.
 */

export type AiErrorKind = "quota" | "rate_limit" | "other";

export type AiErrorCode = "ai_quota_exhausted" | "ai_rate_limited" | "ai_upstream_error";

export interface AiErrorInfo {
  kind: AiErrorKind;
  code: AiErrorCode;
  httpStatus: 503 | 429 | 502;
  message: string;
}

export const AI_QUOTA_CODE = "ai_quota_exhausted";
export const AI_RATE_LIMIT_CODE = "ai_rate_limited";
export const AI_UPSTREAM_CODE = "ai_upstream_error";

export const AI_QUOTA_MESSAGE =
  "Dịch vụ đọc ảnh AI đã hết hạn mức. Báo quản trị nạp thêm — vẫn có thể nhập tay.";
export const AI_RATE_LIMIT_MESSAGE =
  "Dịch vụ đọc ảnh AI đang quá tải, thử lại sau ít phút.";
export const AI_UPSTREAM_MESSAGE =
  "Dịch vụ đọc ảnh AI tạm thời không khả dụng. Vui lòng thử lại.";

const QUOTA_BODY_PATTERNS = [
  "insufficient_quota",
  "billing_hard_limit",
  "exceeded your current quota",
];

/** Classify an OpenAI HTTP error body into one stable code + Vietnamese message. */
export function classifyOpenAIError(status: number, bodyText: string): AiErrorInfo {
  const lower = String(bodyText || "").toLowerCase();
  const isQuota = QUOTA_BODY_PATTERNS.some((pattern) => lower.includes(pattern));
  if (isQuota) {
    return { kind: "quota", code: AI_QUOTA_CODE, httpStatus: 503, message: AI_QUOTA_MESSAGE };
  }
  if (status === 429) {
    return { kind: "rate_limit", code: AI_RATE_LIMIT_CODE, httpStatus: 429, message: AI_RATE_LIMIT_MESSAGE };
  }
  return { kind: "other", code: AI_UPSTREAM_CODE, httpStatus: 502, message: AI_UPSTREAM_MESSAGE };
}

/** Build the JSON body returned to the client for a classified OpenAI error. */
export function aiErrorJson(info: AiErrorInfo): { success: false; code: AiErrorCode; error: string } {
  return { success: false, code: info.code, error: info.message };
}

/**
 * Error carrying a classified OpenAI failure. Shared OCR helpers throw this so
 * each caller can recognize quota exhaustion without re-reading the body.
 */
export class AiOpenAIError extends Error {
  readonly info: AiErrorInfo;
  readonly code: AiErrorCode;
  readonly httpStatus: number;

  constructor(info: AiErrorInfo) {
    super(info.message);
    this.name = "AiOpenAIError";
    this.info = info;
    this.code = info.code;
    this.httpStatus = info.httpStatus;
  }
}

/** Recover classified OpenAI info from a thrown error or an error-like value. */
export function getAiErrorInfo(error: unknown): AiErrorInfo | null {
  if (error instanceof AiOpenAIError) return error.info;
  if (!error || typeof error !== "object") return null;

  const candidate = (error as { info?: unknown }).info;
  if (candidate && typeof candidate === "object") {
    const info = candidate as Partial<AiErrorInfo>;
    if (info.code === AI_QUOTA_CODE && info.kind === "quota") {
      return { kind: "quota", code: AI_QUOTA_CODE, httpStatus: 503, message: info.message || AI_QUOTA_MESSAGE };
    }
    if (info.code === AI_RATE_LIMIT_CODE && info.kind === "rate_limit") {
      return { kind: "rate_limit", code: AI_RATE_LIMIT_CODE, httpStatus: 429, message: info.message || AI_RATE_LIMIT_MESSAGE };
    }
    if (info.code === AI_UPSTREAM_CODE && info.kind === "other") {
      return { kind: "other", code: AI_UPSTREAM_CODE, httpStatus: 502, message: info.message || AI_UPSTREAM_MESSAGE };
    }
  }

  const code = (error as { code?: unknown }).code;
  if (code === AI_QUOTA_CODE) {
    return { kind: "quota", code: AI_QUOTA_CODE, httpStatus: 503, message: AI_QUOTA_MESSAGE };
  }
  if (code === AI_RATE_LIMIT_CODE) {
    return { kind: "rate_limit", code: AI_RATE_LIMIT_CODE, httpStatus: 429, message: AI_RATE_LIMIT_MESSAGE };
  }
  return null;
}
