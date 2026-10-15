// Server-side Jev evaluator for the Q7 stock catalog cleanup.
//
// The transport copies the verified Vercel AI Gateway contract already used by
// finance-jev-duplicate-scan/jev.ts: POST
// https://ai-gateway.vercel.sh/v1/evaluate, model typesafe-ai/jev,
// providerOptions.gateway {zeroDataRetention: true, only: ["typesafe-ai"]} and
// one deadline per call with no retry. This module is self-contained (it does not
// import across functions) and holds no database client: the caller injects the
// state and the mode, and the evaluator never reads or forwards the caller bearer
// token.
//
// Contract reference (verified): https://docs.typesafe.ai/api.md and
// https://docs.typesafe.ai/primitives/noul.md plus choice.md.

import {
  DecisionsError,
  decisionsFailureCode,
  evaluateDecisions,
  type DecisionsOutcome,
  type DecisionsProvider,
} from "../_shared/decisions-provider.ts";

export const JEV_ENDPOINT = "https://ai-gateway.vercel.sh/v1/evaluate";
export const JEV_MODEL = "typesafe-ai/jev";
// Bump whenever the state, the questions or the criteria below change.
export const JEV_PROMPT_VERSION = "jev-stock-catalog-2026-10-15.1";
// One deadline per call, no retry, hard cap 4000 ms.
export const JEV_TIMEOUT_MS = 4000;
export const JEV_MAX_TIMEOUT_MS = 4000;
export const JEV_BODY_LIMIT = 32_000;
export const JEV_CIRCUIT_THRESHOLD = 3;
export const JEV_CIRCUIT_COOLDOWN_MS = 30_000;

export const STOCK_ITEM_CLASS_OPTIONS = [
  "raw_material",
  "packaging_supply",
  "finished_goods",
  "non_stock",
] as const;
export type StockItemClass = (typeof STOCK_ITEM_CLASS_OPTIONS)[number];

export type JevMode = "same_item" | "item_class";

export const SAME_ITEM_INSTRUCTIONS =
  "Hai mặt hàng kho bếp `a` và `b` có phải cùng một nguyên vật liệu, chỉ khác cách ghi hoặc đơn vị, không?";
export const SAME_ITEM_CRITERIA = {
  true: "Cùng nguyên vật liệu khi chúng chỉ khác cách viết tên, viết tắt, dấu tiếng Việt, mã nhà cung cấp hoặc đơn vị đo (kg với g, l với ml), và khi quy đổi đơn vị thì cùng một thứ dùng thay thế nhau trong bếp.",
  false: "KHÁC khi là hai nguyên vật liệu khác nhau dù tên gần giống, ví dụ Bột mì 888 và Bột mì 999 là KHÁC; hộp 500ml và hộp 1 lít là KHÁC; nước mắm và nước tương là KHÁC.",
};

export const ITEM_CLASS_INSTRUCTIONS =
  "Mặt hàng kho bếp `item` thuộc nhóm nào dưới đây?";
export const ITEM_CLASS_CRITERIA: Record<StockItemClass, string> = {
  raw_material: "Nguyên liệu chế biến trực tiếp: bột mì, bơ, chà bông, thịt, rau, gia vị, dầu ăn.",
  packaging_supply: "Bao bì hoặc vật tư tiêu hao: hộp, túi, găng tay, sticker, màng bọc, khay.",
  finished_goods: "Thành phẩm bán hoặc thành phẩm nhập về: bánh mì, pate thành phẩm, nước ngọt.",
  non_stock: "Không phải hàng tồn kho: nước lau sàn, giấy vệ sinh, dịch vụ, chi phí vận chuyển.",
};

export function jevQuestions(mode: JevMode) {
  if (mode === "same_item") {
    return {
      same_item: {
        type: "boolean",
        instructions: SAME_ITEM_INSTRUCTIONS,
        criteria: SAME_ITEM_CRITERIA,
      },
    };
  }
  return {
    item_class: {
      type: "choice",
      instructions: ITEM_CLASS_INSTRUCTIONS,
      criteria: ITEM_CLASS_CRITERIA,
    },
  };
}

export type JevUsage = { input: number; output: number };

export interface JevEvaluation {
  mode: JevMode;
  p_same: number | null;
  item_class: StockItemClass | null;
  class_probability: number | null;
  class_confidence: number | null;
  usage: JevUsage;
  cost: number | null;
  /** Which provider actually answered ('openai' or the Jev fallback). */
  provider?: DecisionsProvider;
}

export interface JevEvaluatorParams {
  mode: JevMode;
  state: unknown;
  signal: AbortSignal;
  /** Absolute epoch-ms budget for the whole scan request, if any. */
  deadlineAt?: number;
}

export type JevEvaluator = (params: JevEvaluatorParams) => Promise<JevEvaluation>;

export interface JevCircuit {
  canAttempt: () => boolean;
  isOpen: () => boolean;
  recordSuccess: () => void;
  recordFailure: () => void;
  reset: () => void;
}

export class JevError extends Error {
  constructor(public readonly code: string, public readonly status: number, public readonly detail: string | null = null) {
    super(code);
    this.name = "JevError";
  }
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

/** Strict validation for the single boolean same_item question. */
function validateSameItemResponse(body: Record<string, unknown>): number {
  if (!isRecord(body.answers)) throw new JevError("jev_invalid_response", 502);
  const answers = body.answers;
  if (Object.keys(answers).length !== 1 || !Object.hasOwn(answers, "same_item")) {
    throw new JevError("jev_invalid_response", 502);
  }
  const yesNo = answers.same_item;
  if (!isRecord(yesNo) || yesNo.type !== "boolean") throw new JevError("jev_invalid_response", 502);
  for (const key of Object.keys(yesNo)) {
    if (key !== "type" && key !== "probability" && key !== "confidence") throw new JevError("jev_invalid_response", 502);
  }
  if (Object.hasOwn(yesNo, "confidence") && !finiteUnit(yesNo.confidence)) throw new JevError("jev_invalid_response", 502);
  if (!finiteUnit(yesNo.probability)) throw new JevError("jev_invalid_response", 502);
  return yesNo.probability as number;
}

/** Strict validation for the single item_class choice question. */
function validateItemClassResponse(body: Record<string, unknown>): {
  itemClass: StockItemClass;
  probability: number;
  confidence: number | null;
} {
  if (!isRecord(body.answers)) throw new JevError("jev_invalid_response", 502);
  const answers = body.answers;
  if (Object.keys(answers).length !== 1 || !Object.hasOwn(answers, "item_class")) {
    throw new JevError("jev_invalid_response", 502);
  }
  const choice = answers.item_class;
  if (!isRecord(choice) || choice.type !== "choice") throw new JevError("jev_invalid_response", 502);
  for (const key of Object.keys(choice)) {
    if (key !== "type" && key !== "choice" && key !== "probabilities" && key !== "confidence") {
      throw new JevError("jev_invalid_response", 502);
    }
  }
  if (Object.hasOwn(choice, "confidence") && !finiteUnit(choice.confidence)) throw new JevError("jev_invalid_response", 502);
  if (typeof choice.choice !== "string" || !STOCK_ITEM_CLASS_OPTIONS.includes(choice.choice as StockItemClass)) {
    throw new JevError("jev_invalid_response", 502);
  }
  if (!isRecord(choice.probabilities)) throw new JevError("jev_invalid_response", 502);
  const probabilities = choice.probabilities;
  if (
    Object.keys(probabilities).length !== STOCK_ITEM_CLASS_OPTIONS.length
    || STOCK_ITEM_CLASS_OPTIONS.some((option) => !Object.hasOwn(probabilities, option))
  ) {
    throw new JevError("jev_invalid_response", 502);
  }
  let sum = 0;
  for (const option of STOCK_ITEM_CLASS_OPTIONS) {
    if (!finiteUnit(probabilities[option])) throw new JevError("jev_invalid_response", 502);
    sum += probabilities[option] as number;
  }
  const itemClass = choice.choice as StockItemClass;
  const chosenProbability = probabilities[itemClass] as number;
  if (STOCK_ITEM_CLASS_OPTIONS.some((option) => option !== itemClass && (probabilities[option] as number) >= chosenProbability)) {
    throw new JevError("jev_invalid_response", 502);
  }
  if (Math.abs(sum - 1) > 0.02) throw new JevError("jev_invalid_response", 502);
  return {
    itemClass,
    probability: chosenProbability,
    confidence: Object.hasOwn(choice, "confidence") ? (choice.confidence as number) : null,
  };
}

/**
 * Strict validation of the documented Gateway response for the requested mode.
 * Unknown model, wrong answer type, missing/extra question, unknown/extra option,
 * non-finite or out-of-range probabilities, a tied/non-top choice and a
 * non-normalised distribution are all refused.
 */
export function validateJevResponse(mode: JevMode, body: unknown): JevEvaluation {
  if (!isRecord(body) || body.model !== JEV_MODEL) throw new JevError("jev_invalid_response", 502);
  const usage = validateUsage(body);
  const cost = gatewayCost(body.providerMetadata);

  if (mode === "same_item") {
    return {
      mode,
      p_same: validateSameItemResponse(body),
      item_class: null,
      class_probability: null,
      class_confidence: null,
      usage,
      cost,
    };
  }
  const result = validateItemClassResponse(body);
  return {
    mode,
    p_same: null,
    item_class: result.itemClass,
    class_probability: result.probability,
    class_confidence: result.confidence,
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

export function createJevEvaluator(config: JevConfig): JevEvaluator {
  const apiKey = config.apiKey ?? "";
  if (!apiKey) throw new JevError("jev_unconfigured", 503);
  const fetcher = config.fetcher ?? fetch;
  const circuit = config.circuit ?? createJevCircuit();
  const configuredTimeout = Math.max(1, Math.min(config.timeoutMs ?? JEV_TIMEOUT_MS, JEV_MAX_TIMEOUT_MS));

  return async ({ mode, state, signal, deadlineAt }): Promise<JevEvaluation> => {
    signal.throwIfAborted();
    if (!circuit.canAttempt()) throw new JevError("jev_circuit_open", 503);
    const remaining = deadlineAt === undefined ? Infinity : deadlineAt - Date.now();
    if (remaining <= 0) throw new JevError("jev_deadline_exceeded", 504);
    const budget = Math.max(1, Math.min(configuredTimeout, remaining));
    const requestBody = {
      model: JEV_MODEL,
      state,
      questions: jevQuestions(mode),
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
      // Keep the provider status and a short, single-line error message for diagnosis.
      // The provider error body never carries our key; it is bounded to 300 characters.
      const detail = outcome.body == null
        ? `HTTP ${outcome.status}`
        : `HTTP ${outcome.status}: ${String(outcome.body).replace(/\s+/g, " ").slice(0, 300)}`;
      if (outcome.status === 429) throw new JevError("jev_rate_limited", 429, detail);
      throw new JevError("jev_http_error", 502, detail);
    }
    let evaluation: JevEvaluation;
    try {
      evaluation = { ...validateJevResponse(mode, outcome.body), provider: outcome.provider };
    } catch (error) {
      circuit.recordFailure();
      throw error;
    }
    circuit.recordSuccess();
    return evaluation;
  };
}
