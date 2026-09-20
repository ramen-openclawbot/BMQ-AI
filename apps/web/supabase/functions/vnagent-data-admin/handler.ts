// Owner-only HTTP shell for the VNAgent data-assets admin (future admin.vnagent.ai).
//
// It authenticates the caller, verifies the owner role server-side, enforces a
// body/time budget and a small per-user rate limit, then delegates to a store
// that runs under the caller's row level security. No service-role client is
// used for reads or writes here.

import {
  DataAdminError,
  TIMESERIES_DAYS,
  assetFiltersWire,
  dedupeKey,
  exportFiltersWire,
  exportQuery,
  renderAssetsMarkdown,
  summarizeOverview,
  summarizeTimeseries,
  validateAssetFilters,
  validateContribution,
  validateExportFilters,
  validateTransition,
  type AssetFilterInput,
  type ContributionInput,
  type DataAsset,
  type ExportFilterInput,
  type ExportQuery,
} from "./data-assets.ts";

export interface DataAdminIdentity {
  userId: string;
  role: string;
  /** Caller-scoped store; bound to this request's bearer token so concurrent requests never share identity. */
  store: DataAdminStore;
}

export interface AssetListResult {
  rows: DataAsset[];
  total: number | null;
}

export interface InsertResult {
  status: "created" | "duplicate";
  asset: DataAsset;
}

export interface DataAdminStore {
  metrics(today: string, signal: AbortSignal): Promise<unknown>;
  timeseries(days: number, signal: AbortSignal): Promise<unknown>;
  listAssets(filters: AssetFilterInput, signal: AbortSignal): Promise<AssetListResult>;
  listExportAssets(filters: ExportQuery, signal: AbortSignal): Promise<AssetListResult>;
  getAsset(id: string, signal: AbortSignal): Promise<DataAsset | null>;
  createAsset(input: ContributionInput, key: string, signal: AbortSignal): Promise<InsertResult>;
  transitionAsset(input: ReturnType<typeof validateTransition>, signal: AbortSignal): Promise<DataAsset>;
  listJev(limit: number, signal: AbortSignal): Promise<unknown[]>;
}

export interface DataAdminConfig {
  enabled: () => boolean;
  authenticate: (request: Request, signal: AbortSignal) => Promise<DataAdminIdentity>;
  now: () => Date;
  audit: (event: Record<string, unknown>) => void;
  /** Whether the analytics capture pipeline is switched on (honest status). */
  captureEnabled?: () => boolean;
}

const origins = new Set([
  "https://ai.banhmique.vn",
  "https://admin.vnagent.ai",
  "http://localhost:5173",
  "http://localhost:8080",
  "http://localhost:3000",
]);

const REQUEST_BODY_LIMIT = 120_000;
const REQUEST_BUDGET_MS = 20_000;
const RATE_LIMIT_PER_MINUTE = 60;
const ACTIONS = ["overview", "timeseries", "assets", "asset", "contribute", "transition", "jev", "export"] as const;
type Action = (typeof ACTIONS)[number];

const messagesVi: Record<string, string> = {
  disabled: "Trang quản trị dữ liệu VNAgent chưa được bật.",
  unauthorized: "Phiên đăng nhập đã hết hạn. Anh đăng nhập lại nhé.",
  forbidden: "Trang quản trị dữ liệu chỉ dành cho chủ doanh nghiệp.",
  invalid_content_type: "Yêu cầu phải là JSON.",
  invalid_json: "Nội dung yêu cầu không hợp lệ.",
  invalid_request: "Yêu cầu không hợp lệ.",
  invalid_action: "Thao tác không được hỗ trợ.",
  body_limit: "Yêu cầu quá lớn.",
  rate_limited: "Anh gửi nhiều yêu cầu liên tiếp. Vui lòng thử lại sau một phút.",
  busy: "Đang xử lý yêu cầu trước. Anh đợi một chút nhé.",
  timeout: "Yêu cầu vượt thời gian cho phép. Anh thử lại nhé.",
  question_required: "Vui lòng nhập câu hỏi.",
  question_too_long: "Câu hỏi vượt quá 4000 ký tự.",
  invalid_source_kind: "Loại nguồn không hợp lệ.",
  invalid_source_designation: "Chưa chọn nguồn là thủ công hay do LLM tạo.",
  invalid_expected_intent: "Ý định mong đợi không hợp lệ.",
  invalid_expected_filters: "Bộ lọc mong đợi không hợp lệ (tối đa 12 khóa).",
  invalid_snapshot_at: "Mốc thời gian snapshot không hợp lệ.",
  invalid_asset_id: "Mã tài sản dữ liệu không hợp lệ.",
  invalid_expected_version: "Thiếu phiên bản để chống ghi đè đồng thời.",
  invalid_stage: "Giai đoạn dữ liệu không hợp lệ.",
  invalid_reason: "Lý do không hợp lệ.",
  invalid_evaluation_status: "Trạng thái đánh giá không hợp lệ.",
  invalid_limit: "Giới hạn dòng không hợp lệ.",
  invalid_offset: "Vị trí bắt đầu không hợp lệ.",
  invalid_search: "Từ khóa tìm kiếm không hợp lệ.",
  invalid_from: "Ngày bắt đầu không hợp lệ.",
  invalid_to: "Ngày kết thúc không hợp lệ.",
  invalid_range: "Khoảng ngày không hợp lệ.",
  export_too_large: "Bản xuất vượt giới hạn dung lượng. Anh giảm số dòng hoặc thu hẹp bộ lọc rồi thử lại.",
  invalid_days: "Khoảng thời gian biểu đồ không hợp lệ (chỉ 7, 30 hoặc 90 ngày).",
  gold_verification_required: "Gold cần phần xác minh đầy đủ.",
  gold_intent_required: "Gold cần ý định đã xác minh.",
  gold_conditions_required: "Gold cần điều kiện đã xác minh.",
  gold_evidence_required: "Gold cần ít nhất một bằng chứng.",
  asset_not_found: "Không tìm thấy tài sản dữ liệu này.",
  version_conflict: "Bản ghi đã thay đổi ở nơi khác. Anh tải lại rồi thao tác lại nhé.",
  invalid_transition: "Chuyển giai đoạn không hợp lệ: chỉ chuyển một bước raw → curated → gold.",
  demotion_reason_required: "Hạ giai đoạn cần ghi rõ lý do.",
  metrics_unavailable: "Chưa đọc được số liệu bộ dữ liệu.",
  store_unavailable: "Chưa truy cập được bộ dữ liệu. Anh thử lại nhé.",
  data_unavailable: "Chưa đọc được dữ liệu. Anh thử lại nhé.",
};

const messagesEn: Record<string, string> = {
  disabled: "The VNAgent data admin is not enabled.",
  unauthorized: "Your session has expired. Please sign in again.",
  forbidden: "The data admin is available to business owners only.",
  invalid_content_type: "Requests must be JSON.",
  invalid_json: "The request body is not valid JSON.",
  invalid_request: "Invalid request.",
  invalid_action: "Unsupported action.",
  body_limit: "The request body is too large.",
  rate_limited: "Too many requests. Please retry in a minute.",
  busy: "Your previous request is still processing. Please wait.",
  timeout: "The request timed out. Please retry.",
  question_required: "Enter a question.",
  question_too_long: "The question exceeds 4000 characters.",
  invalid_source_kind: "Invalid source kind.",
  invalid_source_designation: "Choose whether the source is manual or LLM-generated.",
  invalid_expected_intent: "Invalid expected intent.",
  invalid_expected_filters: "Invalid expected filters (12 keys max).",
  invalid_snapshot_at: "Invalid snapshot time.",
  invalid_asset_id: "Invalid dataset asset id.",
  invalid_expected_version: "Missing the version used for concurrency control.",
  invalid_stage: "Invalid dataset stage.",
  invalid_reason: "Invalid reason.",
  invalid_evaluation_status: "Invalid evaluation status.",
  invalid_limit: "Invalid row limit.",
  invalid_offset: "Invalid offset.",
  invalid_search: "Invalid search term.",
  invalid_from: "Invalid start date.",
  invalid_to: "Invalid end date.",
  invalid_range: "Invalid date range.",
  export_too_large: "The export exceeds the size limit. Reduce the row limit or narrow the filters and retry.",
  invalid_days: "Invalid chart range (only 7, 30 or 90 days).",
  gold_verification_required: "Gold requires the full verification payload.",
  gold_intent_required: "Gold requires a verified intent.",
  gold_conditions_required: "Gold requires verified conditions.",
  gold_evidence_required: "Gold requires at least one piece of evidence.",
  asset_not_found: "This dataset asset was not found.",
  version_conflict: "This record changed elsewhere. Reload and try again.",
  invalid_transition: "Invalid stage transition: move one step raw → curated → gold.",
  demotion_reason_required: "A demotion requires a reason.",
  metrics_unavailable: "Dataset metrics are unavailable.",
  store_unavailable: "The dataset store is unavailable. Please retry.",
  data_unavailable: "Data is unavailable. Please retry.",
};

/** Vietnam-local calendar date (Asia/Ho_Chi_Minh), independent of the caller clock. */
export function vnToday(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

async function readBody(req: Request, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (!req.headers.get("content-type")?.includes("application/json")) throw new DataAdminError("invalid_content_type", 415);
  if (!req.body) throw new DataAdminError("invalid_request", 400);
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
      if (size > REQUEST_BODY_LIMIT) { await reader.cancel(); throw new DataAdminError("body_limit", 413); }
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
    throw new DataAdminError("invalid_json", 400);
  }
}

function actionOf(raw: Record<string, unknown>): Action {
  const action = raw.action;
  if (typeof action !== "string" || !(ACTIONS as readonly string[]).includes(action)) throw new DataAdminError("invalid_action", 400);
  return action as Action;
}

// Strip the transport envelope (`action`, `language`) before strict payload
// validation, so the client can always send the display language.
function withoutEnvelope(raw: Record<string, unknown>): Record<string, unknown> {
  const { action: _action, language: _language, ...rest } = raw;
  return rest;
}

function assetFiltersFromPayload(raw: Record<string, unknown>): AssetFilterInput {
  return validateAssetFilters(withoutEnvelope(raw));
}

function exportFiltersFromPayload(raw: Record<string, unknown>): ExportFilterInput {
  return validateExportFilters(withoutEnvelope(raw));
}

export function createDataAdminHandler(config: DataAdminConfig) {
  const active = new Set<string>();
  const rate = new Map<string, { until: number; count: number }>();

  return async (req: Request): Promise<Response> => {
    // The data admin is English-first: with no explicit language signal the
    // messages are English. An explicit Vietnamese Accept-Language (or a
    // `language: "vi"` body field below) still selects the Vietnamese messages.
    let english = !/^vi(?:[-,;]|$)/i.test(req.headers.get("accept-language") ?? "");
    const origin = req.headers.get("origin");
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Vary": "Origin",
      "Access-Control-Allow-Headers": "authorization,apikey,content-type,accept-language,x-client-info,x-supabase-client-platform,x-supabase-client-platform-version,x-supabase-client-runtime,x-supabase-client-runtime-version",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
    };
    if (origin && origins.has(origin)) headers["Access-Control-Allow-Origin"] = origin;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers });
    const message = (code: string) => (english ? messagesEn[code] : messagesVi[code]) ?? (english ? "Request failed." : "Yêu cầu thất bại.");

    if (origin && !origins.has(origin)) return json({ error: message("forbidden"), code: "origin_forbidden" }, 403);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (req.method !== "POST") return json({ error: "Method not allowed", code: "method_not_allowed" }, 405);

    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(REQUEST_BUDGET_MS)]);
    let ownerKey: string | null = null;
    try {
      const identity = await config.authenticate(req, signal);
      signal.throwIfAborted();
      // Role is re-checked here even though the authenticator already verified it,
      // so a misconfigured authenticator still fails closed.
      if (identity.role !== "owner") throw new DataAdminError("forbidden", 403);
      if (!config.enabled()) throw new DataAdminError("disabled", 503);

      const key = identity.userId;
      const raw = await readBody(req, signal);
      if (raw.language === "en" || raw.language === "vi") english = raw.language === "en";
      const action = actionOf(raw);

      if (active.has(key)) throw new DataAdminError("busy", 429);
      const now = Date.now();
      for (const [id, value] of rate) if (value.until <= now) rate.delete(id);
      const quota = rate.get(key) ?? { until: now + 60_000, count: 0 };
      if (++quota.count > RATE_LIMIT_PER_MINUTE || (!rate.has(key) && rate.size >= 256)) throw new DataAdminError("rate_limited", 429);
      rate.set(key, quota);
      active.add(key);
      ownerKey = key;

      config.audit({ event: "vnagent_data_admin", action, userId: identity.userId });

      if (action === "overview") {
        const metrics = await identity.store.metrics(vnToday(config.now()), signal);
        return json({
          status: "ok",
          overview: summarizeOverview(metrics),
          capture: { enabled: config.captureEnabled?.() === true },
        });
      }

      if (action === "timeseries") {
        const daysRaw = raw.days === undefined ? 30 : raw.days;
        if (typeof daysRaw !== "number" || !Number.isInteger(daysRaw) || !(TIMESERIES_DAYS as readonly number[]).includes(daysRaw)) {
          throw new DataAdminError("invalid_days", 400);
        }
        const series = await identity.store.timeseries(daysRaw, signal);
        return json({ status: "ok", timeseries: summarizeTimeseries(series) });
      }

      if (action === "assets") {
        const filters = assetFiltersFromPayload(raw);
        const result = await identity.store.listAssets(filters, signal);
        return json({ status: "ok", assets: result.rows, total: result.total, filters: assetFiltersWire(filters) });
      }

      if (action === "asset") {
        const { action: _action, asset_id: assetId } = raw;
        if (typeof assetId !== "string" || !/^[0-9a-f-]{36}$/i.test(assetId)) throw new DataAdminError("invalid_asset_id", 400);
        const asset = await identity.store.getAsset(assetId, signal);
        if (!asset) throw new DataAdminError("asset_not_found", 404);
        return json({ status: "ok", asset });
      }

      if (action === "contribute") {
        const input = validateContribution(withoutEnvelope(raw));
        // Dedupe over the full expected scope, so the same question with a
        // different expected intent/filter set is a distinct contribution.
        const key = await dedupeKey(input.question, input.sourceKind, input.expectedIntent, input.expectedFilters);
        const result = await identity.store.createAsset(input, key, signal);
        config.audit({ event: "vnagent_data_admin_contribute", userId: identity.userId, status: result.status, assetId: result.asset.id });
        return json({ status: result.status, asset: result.asset, duplicate: result.status === "duplicate" }, result.status === "created" ? 201 : 200);
      }

      if (action === "transition") {
        const input = validateTransition(withoutEnvelope(raw));
        const asset = await identity.store.transitionAsset(input, signal);
        config.audit({ event: "vnagent_data_admin_transition", userId: identity.userId, assetId: asset.id, toStage: input.toStage, version: asset.version });
        return json({ status: "ok", asset });
      }

      if (action === "jev") {
        const rawLimit = raw.limit === undefined ? 50 : raw.limit;
        if (typeof rawLimit !== "number" || !Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > 200) throw new DataAdminError("invalid_limit", 400);
        const events = await identity.store.listJev(rawLimit, signal);
        return json({ status: "ok", events });
      }

      // export
      const filters = exportFiltersFromPayload(raw);
      // All filters (including the date predicates) run in SQL before the LIMIT,
      // so rows and total describe the same scope and truncation is accurate.
      const result = await identity.store.listExportAssets(exportQuery(filters), signal);
      const exported = renderAssetsMarkdown(result.rows, filters, config.now().toISOString(), result.total ?? result.rows.length);
      config.audit({ event: "vnagent_data_admin_export", userId: identity.userId, count: exported.count, total: exported.total, truncated: exported.truncated });
      return json({
        status: "ok",
        markdown: exported.markdown,
        count: exported.count,
        truncated: exported.truncated,
        total: exported.total,
        filters: exportFiltersWire(filters),
      });
    } catch (error) {
      const code = signal.aborted ? "timeout" : error instanceof DataAdminError ? error.code : "store_unavailable";
      const status = signal.aborted ? 504 : error instanceof DataAdminError ? error.status : 503;
      config.audit({ event: "vnagent_data_admin_error", code, status });
      return json({ error: message(code), code }, status);
    } finally {
      if (ownerKey) active.delete(ownerKey);
    }
  };
}
