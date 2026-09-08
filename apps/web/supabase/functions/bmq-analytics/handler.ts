import { AnalyticsError, ResultCache } from "./core.ts";
import { runAnalytics, type Dependencies } from "./service.ts";

type Identity = Pick<Dependencies, "scope" | "query">;
type Config = { enabled: () => boolean; authenticate: (request: Request, signal: AbortSignal) => Promise<Identity>; model: Dependencies["model"]; audit: (event: Record<string, unknown>) => void };
const origins = new Set(["https://ai.banhmique.vn", "http://localhost:5173", "http://localhost:8080", "http://localhost:3000"]);
const errors: Record<string, string> = {
  disabled: "Phân tích dữ liệu chưa được bật cho BMQ AI.", unauthorized: "Phiên đăng nhập đã hết hạn. Anh đăng nhập lại nhé.",
  forbidden: "Chức năng phân tích thử nghiệm chỉ dành cho chủ doanh nghiệp.", busy: "Đang xử lý yêu cầu trước. Anh đợi một chút nhé.",
  model_unconfigured: "Tầng Luna chưa được cấu hình. Các câu hỏi nhanh có sẵn vẫn dùng được.",
  model_unavailable: "Hiện chưa gọi được Luna. VNAgent không chuyển sang model khác.",
  model_rate_limited: "Luna đang giới hạn lượt gọi. Anh thử lại sau nhé.", timeout: "Truy vấn vượt thời gian cho phép. Anh chọn kỳ ngắn hơn nhé.",
  rate_limited: "Anh gửi nhiều yêu cầu liên tiếp. Vui lòng thử lại sau một phút.",
};
async function readBody(req: Request, signal: AbortSignal) {
  if (!req.headers.get("content-type")?.includes("application/json")) throw new AnalyticsError("invalid_content_type", 415);
  if (!req.body) throw new AnalyticsError("invalid_request");
  const reader = req.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read(); if (done) break;
      size += value.length;
      if (size > 24000) { await reader.cancel(); throw new AnalyticsError("body_limit", 413); }
      chunks.push(value);
    }
    signal.throwIfAborted();
  } finally { signal.removeEventListener("abort", cancel); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new AnalyticsError("invalid_json", 400); }
}
export function createHandler(config: Config) {
  const cache = new ResultCache();
  // Per-isolate abuse protection; deploy behind a distributed edge limit before wider rollout.
  const active = new Set<string>(), rate = new Map<string, { until: number; count: number }>();
  return async (req: Request) => {
    const origin = req.headers.get("origin");
    const headers: Record<string, string> = { "Content-Type": "application/json", "Cache-Control": "no-store", "Vary": "Origin", "Access-Control-Allow-Headers": "authorization,apikey,content-type,x-client-info,x-supabase-client-platform,x-supabase-client-platform-version,x-supabase-client-runtime,x-supabase-client-runtime-version", "Access-Control-Allow-Methods": "POST, OPTIONS" };
    if (origin && origins.has(origin)) headers["Access-Control-Allow-Origin"] = origin;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
    if (origin && !origins.has(origin)) return json({ error: "Origin không được phép." }, 403);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(20000)]);
    let ownerKey: string | null = null;
    try {
      const identity = await config.authenticate(req, signal);
      signal.throwIfAborted();
      if (!config.enabled()) throw new AnalyticsError("disabled", 503);
      const key = `${identity.scope.tenant}:${identity.scope.user}`;
      if (active.has(key)) throw new AnalyticsError("busy", 429);
      const now = Date.now();
      for (const [id, value] of rate) if (value.until <= now) rate.delete(id);
      const quota = rate.get(key) ?? { until: now + 60000, count: 0 };
      if (++quota.count > 20 || (!rate.has(key) && rate.size >= 256)) throw new AnalyticsError("rate_limited", 429);
      rate.set(key, quota); active.add(key); ownerKey = key;
      const raw = await readBody(req, signal);
      const result = await runAnalytics(raw, { ...identity, model: config.model, cache }, signal);
      signal.throwIfAborted();
      config.audit({ event: "bmq_analytics", requestId: result.requestId, userId: identity.scope.user, ...result.provenance });
      return json(result);
    } catch (error) {
      const code = signal.aborted ? "timeout" : error instanceof AnalyticsError ? error.code : "data_unavailable";
      const status = signal.aborted ? 504 : error instanceof AnalyticsError ? error.status : 503;
      // Never log bearer, provider response bodies, question text or raw financial records.
      config.audit({ event: "bmq_analytics_error", code, status });
      return json({ error: errors[code] ?? "Chưa thể trả kết quả đáng tin cậy cho yêu cầu này. Anh thử hỏi rõ chỉ số và kỳ dữ liệu nhé.", code }, status);
    } finally { if (ownerKey) active.delete(ownerKey); }
  };
}
