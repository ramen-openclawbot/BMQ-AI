/**
 * Client-side contract for the OpenAI quota signal emitted by the scan edge
 * functions. When the image-reading AI runs out of quota the server answers
 * HTTP 503 with `{ success: false, code: "ai_quota_exhausted", error: <vi> }`;
 * the shared caller surfaces one persistent toast telling the operator that
 * manual entry still works.
 */
import { toast } from "sonner";

export const AI_QUOTA_CODE = "ai_quota_exhausted";
export const AI_QUOTA_MESSAGE =
  "Dịch vụ đọc ảnh AI đã hết hạn mức. Báo quản trị nạp thêm — vẫn có thể nhập tay.";

const QUOTA_TOKENS = [AI_QUOTA_CODE, "insufficient_quota", "billing_hard_limit", "exceeded your current quota"];

const stringHasQuotaToken = (value: string): boolean => {
  const lower = value.toLowerCase();
  return QUOTA_TOKENS.some((token) => lower.includes(token));
};

const nestedHasQuotaToken = (value: unknown, depth: number): boolean => {
  if (depth > 3) return false;
  if (typeof value === "string") return stringHasQuotaToken(value);
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return ["code", "error", "detail", "message", "error_description"].some((key) =>
    nestedHasQuotaToken(record[key], depth + 1)
  );
};

/**
 * True when a value (a string, an edge error body, or a thrown Error with a
 * `code` / `detail` / `message` field) signals OpenAI quota exhaustion.
 */
export function isAiQuotaError(value: unknown): boolean {
  if (typeof value === "string") return stringHasQuotaToken(value);
  if (!value || typeof value !== "object") return false;
  return ["code", "error", "detail", "message"].some((key) =>
    nestedHasQuotaToken((value as Record<string, unknown>)[key], 1)
  );
}

/** Single persistent quota toast: fixed id, top-center, closable, never auto-hides. */
export function notifyAiQuotaExhausted(): void {
  toast.error(AI_QUOTA_MESSAGE, {
    id: "ai-quota",
    duration: Infinity,
    closeButton: true,
    position: "top-center",
  });
}
