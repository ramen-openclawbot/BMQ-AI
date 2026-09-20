// Owner-only HTTP shell for the VNAgent data-assets admin (admin.banhmique.vn;
// alias admin.vnagent.ai).
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
  isRecord,
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
import {
  SUPPORTED_TOPICS,
  DEFAULT_GENERATION_MODEL,
  GENERATION_IDEMPOTENCY,
  GENERATION_PROMPT_VERSION,
  estimateWorstCaseCostUsd,
  generationFingerprint,
  generationInputTokenBound,
  generationItemProvenance,
  generationOutputTokenBound,
  isDeterministicGenerationFailure,
  validateGenerationRequest,
  type GenerationRequest,
} from "./generation.ts";
import type { GenerationPricing } from "./generation-pricing.ts";
import { providerDiagnosticOf, type GenerationClient, type GenerationOutcome } from "./generation-client.ts";

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

export type GenerationJob = Record<string, unknown>;

export interface GenerationStartInput {
  request: Record<string, unknown>;
  idempotencyKey: string;
  requestFingerprint: string;
  model: string;
  promptVersion: string;
  seedIds: string[];
  budgetUsd: number;
  worstCaseCostUsd: number;
}

export interface GenerationFinishInput {
  jobId: string;
  expectedVersion: number;
  status: "completed" | "failed" | "budget_exceeded";
  summary: Record<string, unknown>;
  actualCostUsd: number | null;
  errorCode: string | null;
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
  generationStart(input: GenerationStartInput, signal: AbortSignal): Promise<{ job: GenerationJob; resumed: boolean; abandoned: boolean }>;
  generationFinish(input: GenerationFinishInput, signal: AbortSignal): Promise<GenerationJob>;
  generationGet(jobId: string | null, idempotencyKey: string | null, signal: AbortSignal): Promise<{ job: GenerationJob | null; jobs: GenerationJob[]; abandoned?: boolean }>;
}

export interface DataAdminConfig {
  enabled: () => boolean;
  authenticate: (request: Request, signal: AbortSignal) => Promise<DataAdminIdentity>;
  now: () => Date;
  audit: (event: Record<string, unknown>) => void;
  /** Whether the analytics capture pipeline is switched on (honest status). */
  captureEnabled?: () => boolean;
  /** Server-side generator; absent means generation is disabled (fail closed). */
  generate?: GenerationClient;
  /**
   * Verified per-1k prices plus their provenance for the fixed token bound.
   * Returning null means the cost cannot be bounded, so no paid call may be made.
   */
  generationPricing?: () => GenerationPricing | null;
  generationModel?: () => string;
}

const origins = new Set([
  "https://admin.banhmique.vn",
  "https://ai.banhmique.vn",
  "https://admin.vnagent.ai",
  "http://localhost:5173",
  "http://localhost:8080",
  "http://localhost:3000",
]);

const REQUEST_BODY_LIMIT = 120_000;
const REQUEST_BUDGET_MS = 20_000;
// Generation performs one bounded paid model call plus up to 50 idempotent asset
// inserts, so it gets its own longer (still bounded) budget. Every other action
// keeps the tight 20s budget.
const GENERATE_BUDGET_MS = 90_000;
const RATE_LIMIT_PER_MINUTE = 60;
const ACTIONS = ["overview", "timeseries", "assets", "asset", "contribute", "transition", "jev", "export", "generate", "generate_status"] as const;
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
  generation_disabled: "Tính năng tạo câu hỏi tổng hợp chưa được bật.",
  generation_cost_unbounded: "Chưa cấu hình được giá model nên không thể chặn chi phí; hệ thống không gọi model trả phí.",
  generation_budget_exceeded: "Ngân sách không đủ cho lô này theo mức chi phí tối đa. Anh tăng ngân sách hoặc giảm số câu.",
  generation_busy: "Đang có một lô tạo câu hỏi chạy. Anh đợi lô đó xong rồi chạy tiếp.",
  generation_invalid_request: "Yêu cầu tạo câu hỏi không hợp lệ.",
  generation_invalid_topic: "Chủ đề không nằm trong định nghĩa nghiệp vụ được hỗ trợ.",
  generation_invalid_count: "Số câu phải từ 20 đến 50.",
  generation_invalid_language: "Ngôn ngữ câu hỏi không hợp lệ.",
  generation_invalid_budget: "Ngân sách không hợp lệ.",
  generation_invalid_style_mix: "Tỷ lệ kiểu câu hỏi không hợp lệ (tổng phải bằng số câu).",
  generation_invalid_seeds: "Câu hỏi mẫu không hợp lệ hoặc không thuộc chủ đề đã chọn.",
  generation_invalid_idempotency_key: "Khóa chống trùng không hợp lệ.",
  generation_idempotency_conflict: "Khóa chống trùng này đã gắn với một lô khác nội dung. Anh chạy lô mới với khóa mới nhé.",
  generation_input_too_large: "Yêu cầu tạo câu hỏi vượt giới hạn đầu vào an toàn nên hệ thống không gọi model.",
  generation_invalid_output: "Model trả về bộ câu hỏi không đúng hợp đồng nên cả lô bị từ chối; không có câu nào được lưu.",
  generation_duplicate_output: "Model trả về câu hỏi trùng nhau nên cả lô bị từ chối; không có câu nào được lưu.",
  generation_timeout: "Lượt tạo câu hỏi vượt thời gian cho phép. Anh đọc lại trạng thái job trước khi chạy lại.",
  generation_unavailable: "Chưa gọi được model tạo câu hỏi. Anh đọc lại trạng thái job trước khi chạy lại.",
  generation_unconfigured: "Tầng tạo câu hỏi chưa được cấu hình khóa model.",
  generation_http_error: "Model tạo câu hỏi trả lỗi. Anh đọc lại trạng thái job trước khi chạy lại.",
  generation_rate_limited: "Model tạo câu hỏi đang giới hạn lượt gọi. Anh thử lại sau.",
  generation_paid_credits_required: "Model tạo câu hỏi cần credit trả phí trên Gateway cho tài khoản này. Anh nạp credit rồi chạy lại.",
  generation_invalid_response: "Phản hồi model không hợp lệ nên cả lô bị từ chối.",
  generation_job_not_found: "Không tìm thấy job tạo câu hỏi này.",
  generation_job_finished: "Job này đã kết thúc; không ghi đè kết quả.",
  generation_version_conflict: "Job đã thay đổi ở nơi khác. Anh đọc lại trạng thái.",
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
  generation_disabled: "Synthetic question generation is not enabled.",
  generation_cost_unbounded: "The model price is not configured, so the cost cannot be bounded; no paid model call was made.",
  generation_budget_exceeded: "The budget does not cover this batch at the worst-case cost. Raise the budget or lower the count.",
  generation_busy: "A generation batch is already running. Wait for it to finish, then start another.",
  generation_invalid_request: "Invalid generation request.",
  generation_invalid_topic: "The topic is not one of the supported business definitions.",
  generation_invalid_count: "The question count must be between 20 and 50.",
  generation_invalid_language: "Invalid question language.",
  generation_invalid_budget: "Invalid budget.",
  generation_invalid_style_mix: "Invalid style mix (the counts must add up to the question count).",
  generation_invalid_seeds: "The selected seeds are invalid or do not belong to the chosen topic.",
  generation_invalid_idempotency_key: "Invalid idempotency key.",
  generation_idempotency_conflict: "This retry key is already bound to a different batch contract. Start a new run with a new key.",
  generation_input_too_large: "The generation request exceeds the safe input bound, so no model call was made.",
  generation_invalid_output: "The model returned a batch that violates the contract, so the whole batch was rejected; nothing was stored.",
  generation_duplicate_output: "The model returned duplicate questions, so the whole batch was rejected; nothing was stored.",
  generation_timeout: "The generation call timed out. Read the job status before running it again.",
  generation_unavailable: "The generation model could not be reached. Read the job status before running it again.",
  generation_unconfigured: "The generation model key is not configured.",
  generation_http_error: "The generation model returned an error. Read the job status before running it again.",
  generation_rate_limited: "The generation model is rate limited. Please retry later.",
  generation_paid_credits_required: "The generation model needs paid Gateway credits on this account. Top up the credits, then run again.",
  generation_invalid_response: "The model response was invalid, so the whole batch was rejected.",
  generation_job_not_found: "This generation job was not found.",
  generation_job_finished: "This generation job already finished; its result was not overwritten.",
  generation_version_conflict: "The job changed elsewhere. Read the current status.",
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

/**
 * Run one bounded generation batch through the durable job record.
 *
 * Order guarantees:
 *   * the cost is bounded and checked BEFORE any paid call (fail closed);
 *   * the job row is created before the call and finished after it, so an
 *     uncertain outcome is recovered by reading the job, never by resubmitting;
 *   * a resumed/abandoned job never spends again;
 *   * every accepted item is inserted as Raw synthetic/llm_generated, and the
 *     job row is only marked completed after all inserts succeed.
 */
async function runGenerationBatch(args: {
  config: DataAdminConfig;
  store: DataAdminStore;
  request: GenerationRequest;
  model: string;
  pricing: GenerationPricing | null;
  signal: AbortSignal;
}): Promise<{ body: Record<string, unknown>; status: number }> {
  const { config, store, request, model, pricing, signal } = args;
  if (!config.generate) throw new DataAdminError("generation_disabled", 503);
  // The ACTUAL serialized request body is measured first: its UTF-8 byte length is
  // a guaranteed upper bound on the input tokens, and a body above the hard
  // ceiling is refused before the price is even computed.
  const inputTokenBound = generationInputTokenBound(request, model);
  const outputTokenBound = generationOutputTokenBound(request.count);
  const worstCaseCostUsd = estimateWorstCaseCostUsd({ inputTokens: inputTokenBound, outputTokens: outputTokenBound }, pricing);
  if (worstCaseCostUsd === null) throw new DataAdminError("generation_cost_unbounded", 503);
  if (worstCaseCostUsd > request.budgetUsd) throw new DataAdminError("generation_budget_exceeded", 400);

  const requestFingerprint = generationFingerprint(request, model);
  const started = await store.generationStart({
    request: {
      topic: request.topicId,
      count: request.count,
      target_language: request.language,
      style_mix: request.styleMix,
      seed_ids: request.seedIds,
    },
    idempotencyKey: request.idempotencyKey,
    requestFingerprint,
    model,
    promptVersion: GENERATION_PROMPT_VERSION,
    seedIds: request.seedIds,
    budgetUsd: request.budgetUsd,
    worstCaseCostUsd,
  }, signal);
  const job = started.job;
  const jobId = typeof job.id === "string" ? job.id : "";
  const version = typeof job.version === "number" ? job.version : Number(job.version);
  const status = typeof job.status === "string" ? job.status : "running";
  const summary = isRecord(job.result_summary) ? job.result_summary : {};
  // A repeated request (same idempotency key) never spends again. An abandoned
  // running job (expired lease) is surfaced for the owner to start a new batch.
  if (started.abandoned) return { body: { status: "abandoned", resumed: true, job, results: summary }, status: 200 };
  if (started.resumed) {
    const resumedStatus = status === "running" ? "in_progress" : status === "failed" ? "failed" : status === "budget_exceeded" ? "budget_exceeded" : "ok";
    return { body: { status: resumedStatus, resumed: true, job, results: summary }, status: 200 };
  }
  if (!jobId || !Number.isInteger(version)) {
    throw new DataAdminError("generation_job_not_found", 503);
  }

  let outcome: GenerationOutcome;
  try {
    outcome = await config.generate(request, signal);
  } catch (error) {
    const errorCode = error instanceof DataAdminError ? error.code : "generation_unavailable";
    // Only the allowlisted provider status/code/parameter is durable here; the raw
    // provider message (prompt/token/key risk) is dropped by the client.
    const diagnostic = providerDiagnosticOf(error);
    const finished = await store.generationFinish({
      jobId,
      expectedVersion: version,
      status: "failed",
      summary: { created: 0, duplicate: 0, rejected: 0, ...(diagnostic ? { diagnostic } : {}) },
      actualCostUsd: null,
      errorCode,
    }, signal);
    // A definitive provider/payload failure is a durable result, not an uncertain
    // one: return the failed job envelope. The allowlisted diagnostic stays on the
    // saved job (result_summary) and the audit event for support; it is not part of
    // the primary flow. Timeouts and transport errors still throw so the UI
    // reconciles by reading the exact key.
    if (isDeterministicGenerationFailure(errorCode)) {
      return {
        body: {
          status: "failed",
          resumed: false,
          job: finished,
          results: { created: 0, duplicate: 0, rejected: 0, total: 0 },
        },
        status: 200,
      };
    }
    throw error;
  }
  // Hard budget enforcement on the reported actual cost. If a provider reports a
  // cost above the owner's cap, nothing is stored and the job fails closed.
  if (outcome.cost !== null && outcome.cost > request.budgetUsd) {
    await store.generationFinish({ jobId, expectedVersion: version, status: "budget_exceeded", summary: { created: 0, duplicate: 0, rejected: 0 }, actualCostUsd: outcome.cost, errorCode: "budget_exceeded" }, signal);
    throw new DataAdminError("generation_budget_exceeded", 400);
  }

  const generatedAt = config.now().toISOString();
  let created = 0;
  let duplicate = 0;
  const assets: DataAsset[] = [];
  try {
    for (const item of outcome.items) {
      const topic = SUPPORTED_TOPICS.find((entry) => entry.id === item.topicId);
      if (!topic) throw new DataAdminError("generation_invalid_output", 502);
      const provenance = generationItemProvenance({
        request, item, model, runId: jobId, generatedAt,
        budgetUsd: request.budgetUsd, worstCaseCostUsd, inputTokenBound,
        topic, pricing: pricing?.provenance ?? null,
      });
      const expectedIntent = {
        topic: item.topicId,
        intent: topic.intent,
        definition: topic.definition,
        expectedResponse: item.expectedResponse,
      };
      const key = await dedupeKey(item.question, "synthetic", expectedIntent, item.expectedFilters);
      const result = await store.createAsset({
        question: item.question,
        sourceKind: "synthetic",
        sourceDesignation: "llm_generated",
        expectedIntent,
        expectedFilters: item.expectedFilters,
        provenance,
        snapshotAt: null,
      }, key, signal);
      if (result.status === "created") created += 1;
      else duplicate += 1;
      assets.push(result.asset);
    }
  } catch (error) {
    // Partial inserts are durable (idempotent dedupe). The job is finished as
    // failed so a retry with the same key reads back instead of spending again.
    await store.generationFinish({ jobId, expectedVersion: version, status: "failed", summary: { created, duplicate, rejected: 0 }, actualCostUsd: outcome.cost, errorCode: error instanceof DataAdminError ? error.code : "store_unavailable" }, signal);
    throw error;
  }

  const results = { created, duplicate, rejected: 0, total: outcome.items.length };
  const finished = await store.generationFinish({ jobId, expectedVersion: version, status: "completed", summary: results, actualCostUsd: outcome.cost, errorCode: null }, signal);
  return {
    body: {
      status: "ok",
      resumed: false,
      job: finished,
      results,
      assets,
      model,
      promptVersion: GENERATION_PROMPT_VERSION,
      inputTokenBound,
      outputTokenBound,
      worstCaseCostUsd,
      actualCostUsd: outcome.cost,
      usage: outcome.usage,
    },
    status: 201,
  };
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

    const setupSignal = AbortSignal.any([req.signal, AbortSignal.timeout(REQUEST_BUDGET_MS)]);
    // Reassigned to a longer, still-bounded budget for the generation action only,
    // after the action is known. Auth/body always use the tight setup budget.
    let signal = setupSignal;
    let ownerKey: string | null = null;
    try {
      const identity = await config.authenticate(req, setupSignal);
      setupSignal.throwIfAborted();
      // Role is re-checked here even though the authenticator already verified it,
      // so a misconfigured authenticator still fails closed.
      if (identity.role !== "owner") throw new DataAdminError("forbidden", 403);
      if (!config.enabled()) throw new DataAdminError("disabled", 503);

      const key = identity.userId;
      const raw = await readBody(req, setupSignal);
      if (raw.language === "en" || raw.language === "vi") english = raw.language === "en";
      const action = actionOf(raw);
      if (action === "generate") signal = AbortSignal.any([req.signal, AbortSignal.timeout(GENERATE_BUDGET_MS)]);

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

      if (action === "generate") {
        const request = validateGenerationRequest(withoutEnvelope(raw));
        const model = config.generationModel?.() ?? DEFAULT_GENERATION_MODEL;
        const pricing = config.generationPricing?.() ?? null;
        const result = await runGenerationBatch({ config, store: identity.store, request, model, pricing, signal });
        const finishedJob = isRecord(result.body.job) ? result.body.job : {};
        const finishedSummary = isRecord(finishedJob.result_summary) ? finishedJob.result_summary : {};
        config.audit({
          event: "vnagent_data_admin_generate",
          userId: identity.userId,
          idempotencyKey: request.idempotencyKey,
          requestFingerprint: generationFingerprint(request, model),
          outcome: result.body.status,
          errorCode: typeof finishedJob.error_code === "string" ? finishedJob.error_code : null,
          // Allowlisted provider status/code/parameter only, read from the saved job;
          // never the raw message.
          diagnostic: isRecord(finishedSummary.diagnostic) ? finishedSummary.diagnostic : null,
          worstCaseCostUsd: result.body.worstCaseCostUsd ?? null,
        });
        return json(result.body, result.status);
      }

      if (action === "generate_status") {
        const { action: _action, job_id: jobId, idempotency_key: idempotencyKey } = raw;
        if (jobId !== undefined && jobId !== null && jobId !== "" && (typeof jobId !== "string" || !/^[0-9a-f-]{36}$/i.test(jobId))) {
          throw new DataAdminError("invalid_asset_id", 400);
        }
        if (idempotencyKey !== undefined && idempotencyKey !== null && idempotencyKey !== ""
          && (typeof idempotencyKey !== "string" || !GENERATION_IDEMPOTENCY.test(idempotencyKey))) {
          throw new DataAdminError("generation_invalid_idempotency_key", 400);
        }
        const result = await identity.store.generationGet(
          typeof jobId === "string" && jobId ? jobId : null,
          typeof idempotencyKey === "string" && idempotencyKey ? idempotencyKey : null,
          signal,
        );
        return json({ status: "ok", ...result });
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
      const diagnostic = providerDiagnosticOf(error);
      config.audit({ event: "vnagent_data_admin_error", code, status, ...(diagnostic ? { diagnostic } : {}) });
      return json({ error: message(code), code }, status);
    } finally {
      if (ownerKey) active.delete(ownerKey);
    }
  };
}
