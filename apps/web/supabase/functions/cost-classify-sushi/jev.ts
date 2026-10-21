// Server-side Sushi evaluator for cost classification.
//
// Self-contained on purpose: it does not import across function folders and
// holds no database client. The transport copies the verified AI Gateway
// contract used by stock-routing-jev: POST
// https://ai-gateway.vercel.sh/v1/evaluate, model typesafe-ai/jev,
// providerOptions.gateway {zeroDataRetention: true, only: ["typesafe-ai"]} and
// one deadline per call with no retry.
//
// One choice question per expense line:
//   cost_category: the line belongs to one ACTIVE cost_categories code. The
//                  caller never offers UNMAPPED_REVIEW; a low probability is
//                  written back as UNMAPPED_REVIEW with the top choice noted.
//
// Contract reference (verified): https://docs.typesafe.ai/api.md and
// https://docs.typesafe.ai/primitives/choice.md.

import {
  DecisionsError,
  decisionsFailureCode,
  evaluateDecisions,
  type DecisionsOutcome,
  type DecisionsProvider,
} from "../_shared/decisions-provider.ts";

export const JEV_ENDPOINT = "https://ai-gateway.vercel.sh/v1/evaluate";
export const JEV_MODEL = "typesafe-ai/jev";
// Bump whenever the state, the question or the criteria below change.
export const SUSHI_COST_PROMPT_VERSION = "sushi-cost-classify-2026-10-20.2";
export const JEV_TIMEOUT_MS = 4000;
export const JEV_MAX_TIMEOUT_MS = 4000;
export const JEV_BODY_LIMIT = 32_000;
export const JEV_CIRCUIT_THRESHOLD = 3;
export const JEV_CIRCUIT_COOLDOWN_MS = 30_000;

export const COST_QUESTION_KEY = "cost_category";
export const PRODUCT_LINE_QUESTION_KEY = "product_line";
export const PRODUCT_LINE_THRESHOLD = 0.8;

export type ProductLineCode = "bmq_bread" | "sweet_kitchen" | "shared";

export const PRODUCT_LINE_OPTIONS: readonly { code: ProductLineCode; label: string }[] = [
  {
    code: "bmq_bread",
    label: "Bánh mì que / bánh mì lớn và pate, chà bông dùng cho bánh mì",
  },
  {
    code: "sweet_kitchen",
    label: "Bếp bánh ngọt Q7: bơ, bột, phô mai, trứng cho bánh ngọt",
  },
  {
    code: "shared",
    label: "Dùng chung hoặc không rõ: thuê kho, điện, gas, giao hàng, văn phòng",
  },
];

const PRODUCT_LINE_CODES = PRODUCT_LINE_OPTIONS.map((option) => option.code);

export interface CostCategoryOption {
  code: string;
  label: string;
}

export interface CostClassificationCandidate {
  source_type: string;
  source_line_id: string;
  supplier_id?: string | null;
  supplier_name?: string | null;
  product_name: string;
  product_code?: string | null;
  unit?: string | null;
  quantity?: number | null;
  unit_price?: number | null;
  line_amount?: number | null;
  document_date?: string | null;
  note?: string | null;
  subject_key?: string | null;
}

export interface CostFeedbackRow {
  id?: string;
  kind?: string;
  subject_key: string;
  robot_choice: string | null;
  human_choice: string | null;
  robot_probability?: number | null;
  note?: string | null;
  created_at?: string | null;
}

/** State sent to Jev for the `cost_category` question. */
export interface CostClassificationState {
  line: {
    supplier: string;
    product_name: string;
    product_code: string | null;
    unit: string | null;
    quantity: number;
    unit_price: number;
    amount: number;
    note: string | null;
  };
  corrections: string[];
}

export const COST_INSTRUCTIONS =
  "Khoản chi `line` (nhà cung cấp, tên hàng, mã hàng, đơn vị, số lượng, " +
  "đơn giá, thành tiền, ghi chú) thuộc danh mục chi phí nào?";

export const PRODUCT_LINE_INSTRUCTIONS =
  "Khoản chi `line` phục vụ dòng sản phẩm nào? Chọn shared khi dùng chung " +
  "hoặc không rõ.";

export function costCriteria(options: readonly CostCategoryOption[]): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const option of options) {
    criteria[option.code] = option.label;
  }
  return criteria;
}

export function allowedOptions(options: readonly CostCategoryOption[]): string[] {
  return options.map((option) => option.code);
}

export function productLineCriteria(): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const option of PRODUCT_LINE_OPTIONS) {
    criteria[option.code] = option.label;
  }
  return criteria;
}

export function costQuestion(options: readonly CostCategoryOption[]) {
  return {
    [COST_QUESTION_KEY]: {
      type: "choice" as const,
      instructions: COST_INSTRUCTIONS,
      criteria: costCriteria(options),
    },
    [PRODUCT_LINE_QUESTION_KEY]: {
      type: "choice" as const,
      instructions: PRODUCT_LINE_INSTRUCTIONS,
      criteria: productLineCriteria(),
    },
  };
}

export function formatCostCorrection(row: CostFeedbackRow): string {
  const robot = row.robot_choice ?? "";
  const human = row.human_choice ?? "";
  return `Người duyệt đã sửa trước đây: ${robot} → ${human} (Sushi đã chọn ${robot})`;
}

export function buildCostState(
  candidate: CostClassificationCandidate,
  corrections: readonly string[] = [],
): CostClassificationState {
  return {
    line: {
      supplier: candidate.supplier_name ?? "",
      product_name: candidate.product_name ?? "",
      product_code: candidate.product_code ?? null,
      unit: candidate.unit ?? null,
      quantity: numeric(candidate.quantity),
      unit_price: numeric(candidate.unit_price),
      amount: numeric(candidate.line_amount),
      note: candidate.note ?? null,
    },
    corrections: corrections.filter((line) => typeof line === "string" && line.trim() !== "").slice(0, 5),
  };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export type JevUsage = { input: number; output: number };

export interface CostEvaluation {
  category_code: string;
  probability: number;
  product_line: ProductLineCode;
  product_line_probability: number;
  confidence: number | null;
  usage: JevUsage;
  cost: number | null;
  /** Which provider actually answered (always the Jev Gateway). */
  provider?: DecisionsProvider;
}

export interface CostEvaluatorParams {
  state: CostClassificationState;
  options: readonly CostCategoryOption[];
  signal: AbortSignal;
  deadlineAt?: number;
}

/** `null` means "the provider answered but not with a usable option". */
export type CostEvaluator = (params: CostEvaluatorParams) => Promise<CostEvaluation | null>;

export interface JevCircuit {
  canAttempt: () => boolean;
  isOpen: () => boolean;
  recordSuccess: () => void;
  recordFailure: () => void;
  reset: () => void;
}

export class JevError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: string | null;

  constructor(code: string, status: number, detail: string | null = null) {
    super(code);
    this.name = "JevError";
    this.code = code;
    this.status = status;
    this.detail = detail;
  }
}

function numeric(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function gatewayCost(metadata: unknown): number | null {
  if (!isRecord(metadata) || !isRecord(metadata.gateway)) return null;
  const raw = metadata.gateway.cost;
  const value = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : Number.NaN;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function validateUsage(body: Record<string, unknown>): JevUsage {
  if (!isRecord(body.usage)) throw new JevError("jev_invalid_response", 502);
  const input = body.usage.inputTokens;
  const output = body.usage.outputTokens;
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0) throw new JevError("jev_invalid_response", 502);
  if (typeof output !== "number" || !Number.isFinite(output) || output < 0) throw new JevError("jev_invalid_response", 502);
  return { input, output };
}

/**
 * Validate the single `cost_category` choice. A malformed transport envelope is
 * a provider failure, but an unknown option, a missing answer or a missing
 * probability is "no answer" (`null`) and the caller writes nothing.
 */
export interface ProductLineAnswer {
  product_line: ProductLineCode;
  probability: number;
}

function isProductLineCode(value: string): value is ProductLineCode {
  return (PRODUCT_LINE_CODES as readonly string[]).includes(value);
}

/**
 * The product-line question is advisory: an unknown option, a missing answer
 * or a missing probability means `shared` and never invalidates the category.
 */
export function validateProductLineAnswer(body: unknown): ProductLineAnswer {
  const fallback: ProductLineAnswer = { product_line: "shared", probability: 0 };
  if (!isRecord(body) || !isRecord(body.answers)) return fallback;
  const answer = body.answers[PRODUCT_LINE_QUESTION_KEY];
  if (!isRecord(answer) || answer.type !== "choice") return fallback;
  if (typeof answer.choice !== "string" || !isProductLineCode(answer.choice)) return fallback;
  if (!isRecord(answer.probabilities)) return fallback;
  if (!Object.hasOwn(answer.probabilities, answer.choice)) return fallback;
  const probability = answer.probabilities[answer.choice];
  if (!finiteUnit(probability)) return fallback;
  return { product_line: answer.choice, probability };
}

export function validateCostAnswer(allowed: readonly string[], body: unknown): CostEvaluation | null {
  if (!isRecord(body) || body.model !== JEV_MODEL) throw new JevError("jev_invalid_response", 502);
  const usage = validateUsage(body);
  const cost = gatewayCost(body.providerMetadata);

  if (allowed.length < 2) throw new JevError("jev_invalid_response", 502);
  if (!isRecord(body.answers)) return null;
  if (!Object.hasOwn(body.answers, COST_QUESTION_KEY)) return null;
  const answer = body.answers[COST_QUESTION_KEY];
  if (!isRecord(answer) || answer.type !== "choice") return null;
  if (typeof answer.choice !== "string" || !allowed.includes(answer.choice)) return null;
  if (!isRecord(answer.probabilities)) return null;
  if (!Object.hasOwn(answer.probabilities, answer.choice)) return null;
  const probability = answer.probabilities[answer.choice];
  if (!finiteUnit(probability)) return null;

  const confidence = Object.hasOwn(answer, "confidence") && finiteUnit(answer.confidence)
    ? (answer.confidence as number)
    : null;
  const productLine = validateProductLineAnswer(body);

  return {
    category_code: answer.choice,
    probability,
    product_line: productLine.product_line,
    product_line_probability: productLine.probability,
    confidence,
    usage,
    cost,
  };
}

export interface JevConfig {
  apiKey: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  circuit?: JevCircuit;
}

export function createJevCircuit(options: { threshold?: number; cooldownMs?: number; now?: () => number } = {}): JevCircuit {
  const threshold = options.threshold ?? JEV_CIRCUIT_THRESHOLD;
  const cooldownMs = options.cooldownMs ?? JEV_CIRCUIT_COOLDOWN_MS;
  const now = options.now ?? Date.now;
  let failures = 0, openUntil = 0;
  return {
    canAttempt: () => openUntil <= now(),
    isOpen: () => openUntil > now(),
    recordSuccess: () => { failures = 0; openUntil = 0; },
    recordFailure: () => { failures += 1; if (failures >= threshold) openUntil = now() + cooldownMs; },
    reset: () => { failures = 0; openUntil = 0; },
  };
}

export function createCostEvaluator(config: JevConfig): CostEvaluator {
  const apiKey = config.apiKey ?? "";
  if (!apiKey) throw new JevError("jev_unconfigured", 503);
  const fetcher = config.fetcher ?? fetch;
  const circuit = config.circuit ?? createJevCircuit();
  const configuredTimeout = Math.max(1, Math.min(config.timeoutMs ?? JEV_TIMEOUT_MS, JEV_MAX_TIMEOUT_MS));

  return async ({ state, options, signal, deadlineAt }): Promise<CostEvaluation | null> => {
    signal.throwIfAborted();
    if (!circuit.canAttempt()) throw new JevError("jev_circuit_open", 503);
    const remaining = deadlineAt === undefined ? Infinity : deadlineAt - Date.now();
    if (remaining <= 0) throw new JevError("jev_deadline_exceeded", 504);
    const budget = Math.max(1, Math.min(configuredTimeout, remaining));
    const allowed = allowedOptions(options);
    const requestBody = {
      model: JEV_MODEL,
      state,
      questions: costQuestion(options),
      // Server-side key only; no caller bearer token is sent to the provider.
      providerOptions: { gateway: { zeroDataRetention: true, only: ["typesafe-ai"] } },
    };
    let outcome: DecisionsOutcome;
    try {
      outcome = await evaluateDecisions(requestBody, {
        fetcher,
        gatewayUrl: JEV_ENDPOINT,
        gatewayKey: apiKey,
        timeoutMs: budget,
        signal,
      });
    } catch (error) {
      signal.throwIfAborted();
      circuit.recordFailure();
      const code = decisionsFailureCode(error);
      throw new JevError(
        code,
        code === "jev_timeout" ? 504 : code === "jev_invalid_response" ? 502 : 503,
        error instanceof DecisionsError ? error.detail : null,
      );
    }
    if (outcome.status < 200 || outcome.status >= 300) {
      circuit.recordFailure();
      const detail = outcome.body == null
        ? `HTTP ${outcome.status}`
        : `HTTP ${outcome.status}: ${String(outcome.body).replace(/\s+/g, " ").slice(0, 300)}`;
      if (outcome.status === 429) throw new JevError("jev_rate_limited", 429, detail);
      throw new JevError("jev_http_error", 502, detail);
    }
    let evaluation: CostEvaluation | null;
    try {
      const validated = validateCostAnswer(allowed, outcome.body);
      evaluation = validated === null ? null : { ...validated, provider: outcome.provider };
    } catch (error) {
      circuit.recordFailure();
      throw error;
    }
    circuit.recordSuccess();
    return evaluation;
  };
}
