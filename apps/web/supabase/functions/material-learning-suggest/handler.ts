// Owner-only HTTP shell for the read-only Material Master learning suggestion.
// It authenticates the caller, enforces a body/time budget and a small per-user
// rate limit, then delegates the deterministic + bounded Jev work to
// material-suggest.ts. There is no write path and the caller bearer token is
// never forwarded to the model provider.

import {
  MaterialSuggestError,
  suggestMaterialResolution,
  type MaterialEvaluator,
  type MaterialSuggestDataSource,
  type MaterialSuggestionResult,
} from "./material-suggest.ts";

export interface MaterialSuggestIdentity {
  userId: string;
  dataSource: MaterialSuggestDataSource;
}

export interface MaterialSuggestConfig {
  enabled: () => boolean;
  evaluator: () => MaterialEvaluator | null;
  authenticate: (request: Request, signal: AbortSignal) => Promise<MaterialSuggestIdentity>;
  audit: (event: Record<string, unknown>) => void;
}

const origins = new Set(["https://ai.banhmique.vn", "http://localhost:5173", "http://localhost:8080", "http://localhost:3000"]);
const REQUEST_BODY_LIMIT = 4096;
const REQUEST_BUDGET_MS = 15000;
const RATE_LIMIT_PER_MINUTE = 20;

const messages: Record<string, string> = {
  disabled: "Tính năng gợi ý NVL chưa được bật cho BMQ AI. Anh vẫn có thể chọn NVL thủ công.",
  unauthorized: "Phiên đăng nhập đã hết hạn. Anh đăng nhập lại nhé.",
  forbidden: "Tính năng gợi ý NVL chỉ dành cho chủ doanh nghiệp.",
  invalid_content_type: "Yêu cầu gợi ý NVL phải là JSON.",
  invalid_json: "Nội dung yêu cầu gợi ý NVL không hợp lệ.",
  invalid_request: "Yêu cầu gợi ý NVL không hợp lệ.",
  body_limit: "Yêu cầu gợi ý NVL quá lớn.",
  invalid_request_id: "Thiếu hoặc sai dòng cần xác nhận.",
  request_not_found: "Không tìm thấy dòng cần xác nhận này.",
  request_not_pending: "Dòng này đã được xác nhận hoặc từ chối trước đó; không lấy gợi ý lại.",
  source_changed: "Dòng nguồn đã thay đổi so với yêu cầu xác nhận; cần rà soát lại trước khi gợi ý.",
  source_incomplete_coverage: "Chưa đọc đủ nguồn dữ liệu nên không thể xác nhận độ phủ. Anh chọn NVL thủ công.",
  candidate_catalog_truncated: "Danh mục NVL vượt giới hạn an toàn nên chưa thể gợi ý đầy đủ. Anh chọn NVL thủ công.",
  rate_limited: "Anh gửi nhiều yêu cầu liên tiếp. Vui lòng thử lại sau một phút.",
  busy: "Đang xử lý yêu cầu trước. Anh đợi một chút nhé.",
  timeout: "Gợi ý NVL vượt thời gian cho phép. Anh thử lại hoặc chọn NVL thủ công.",
};

async function readBody(req: Request, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!req.headers.get("content-type")?.includes("application/json")) throw new MaterialSuggestError("invalid_content_type", 415);
  if (!req.body) throw new MaterialSuggestError("invalid_request", 400);
  const reader = req.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > REQUEST_BODY_LIMIT) { await reader.cancel(); throw new MaterialSuggestError("body_limit", 413); }
      chunks.push(value);
    }
    signal.throwIfAborted();
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new MaterialSuggestError("invalid_json", 400);
  }
}

export function createMaterialLearningSuggestHandler(config: MaterialSuggestConfig) {
  const active = new Set<string>();
  const rate = new Map<string, { until: number; count: number }>();

  return async (req: Request): Promise<Response> => {
    const origin = req.headers.get("origin");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Vary": "Origin",
      "Access-Control-Allow-Headers": "authorization,apikey,content-type,x-client-info,x-supabase-client-platform,x-supabase-client-platform-version,x-supabase-client-runtime,x-supabase-client-runtime-version",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    };
    if (origin && origins.has(origin)) headers["Access-Control-Allow-Origin"] = origin;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
    if (origin && !origins.has(origin)) return json({ error: "Origin không được phép.", code: "origin_forbidden" }, 403);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (req.method !== "POST") return json({ error: "Method not allowed", code: "method_not_allowed" }, 405);

    const deadlineAt = Date.now() + REQUEST_BUDGET_MS;
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(REQUEST_BUDGET_MS)]);
    let ownerKey: string | null = null;
    try {
      const identity = await config.authenticate(req, signal);
      signal.throwIfAborted();
      if (!config.enabled()) throw new MaterialSuggestError("disabled", 503);
      const key = identity.userId;
      const raw = await readBody(req, signal);
      if (Object.keys(raw).some((field) => field !== "request_id")) throw new MaterialSuggestError("invalid_request", 400);
      if (typeof raw.request_id !== "string") throw new MaterialSuggestError("invalid_request_id", 400);

      if (active.has(key)) throw new MaterialSuggestError("busy", 429);
      const now = Date.now();
      for (const [id, value] of rate) if (value.until <= now) rate.delete(id);
      const quota = rate.get(key) ?? { until: now + 60000, count: 0 };
      if (++quota.count > RATE_LIMIT_PER_MINUTE || (!rate.has(key) && rate.size >= 256)) throw new MaterialSuggestError("rate_limited", 429);
      rate.set(key, quota);
      active.add(key);
      ownerKey = key;

      const result: MaterialSuggestionResult = await suggestMaterialResolution(
        identity.dataSource,
        config.evaluator(),
        raw.request_id,
        signal,
        { deadlineAt },
      );
      signal.throwIfAborted();
      config.audit({
        event: "material_learning_suggest",
        requestId: result.request_id,
        userId: identity.userId,
        outcome: result.outcome,
        matchedBy: result.matched_by,
        usedJev: result.used_jev,
      });
      return json(result);
    } catch (error) {
      const code = signal.aborted ? "timeout" : error instanceof MaterialSuggestError ? error.code : "candidate_suggest_failed";
      const status = signal.aborted ? 504 : error instanceof MaterialSuggestError ? error.status : 503;
      config.audit({ event: "material_learning_suggest_error", code, status });
      return json({ error: messages[code] ?? "Chưa thể lấy gợi ý NVL. Anh chọn NVL thủ công.", code }, status);
    } finally {
      if (ownerKey) active.delete(ownerKey);
    }
  };
}
