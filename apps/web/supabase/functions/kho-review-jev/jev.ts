// Server-side Jev evaluator for the kho review tab.
//
// One evaluation call answers one pair:
//   * a boolean `same_item` question — is this receipt line the same purchased
//     good as this kho item / recipe material?
//   * for a recipe material, one `suggested_class` choice question
//     (raw_material | packaging_supply).
//
// The transport reuses the verified Vercel AI Gateway contract already used by
// stock-alias-jev / material-jev: POST
// https://ai-gateway.vercel.sh/v1/evaluate, model typesafe-ai/jev,
// providerOptions.gateway {zeroDataRetention: true, only: ["typesafe-ai"]} and
// one deadline per call with no retry. It holds no database client and never
// links or creates anything.

import {
  DecisionsError,
  decisionsFailureCode,
  evaluateDecisions,
  type DecisionsOutcome,
  type DecisionsProvider,
} from "../_shared/decisions-provider.ts";
import {
  JEV_BODY_LIMIT,
  JEV_CIRCUIT_COOLDOWN_MS,
  JEV_CIRCUIT_THRESHOLD,
  JEV_ENDPOINT,
  JEV_MAX_TIMEOUT_MS,
  JEV_MODEL,
  createJevCircuit,
  type JevCircuit,
} from "../bmq-analytics/jev.ts";

export const KHO_REVIEW_JEV_PROMPT_VERSION = "jev-kho-review-2026-11-01.1";
export const KHO_REVIEW_JEV_MODEL = JEV_MODEL;
export const KHO_REVIEW_JEV_TIMEOUT_MS = 4000;
export const KHO_REVIEW_JEV_BODY_LIMIT = JEV_BODY_LIMIT;
export const KHO_REVIEW_JEV_MAX_CONCURRENCY = 4;
export const KHO_REVIEW_JEV_SAME_THRESHOLD = 0.8;
export const KHO_REVIEW_JEV_DIFFERENT_THRESHOLD = 0.2;

export type KhoReviewJevTargetKind = "item" | "material";
export type KhoReviewJevVerdict = "same_item" | "different" | "unsure";
export type KhoReviewJevClass = "raw_material" | "packaging_supply";

export const KHO_REVIEW_JEV_CLASS_OPTIONS: readonly KhoReviewJevClass[] = [
  "raw_material",
  "packaging_supply",
];

export const SAME_ITEM_INSTRUCTIONS =
  "Dòng phiếu nhập `line` có phải cùng một món hàng đã mua với món đích `target` (món kho hoặc nguyên liệu công thức) không?";
export const SAME_ITEM_CRITERIA = {
  true: "Cùng một món khi tên, đơn vị và nhà cung cấp cho thấy chúng là cùng một thứ dùng thay thế nhau trong bếp/kho; tên viết tắt, sai dấu, khác ngôn ngữ hoặc khác đơn vị đo nhưng quy đổi được vẫn là cùng món.",
  false: "KHÁC khi là hai món khác nhau dù tên gần giống (ví dụ bột mì 888 và bột mì 999, hộp 500ml và hộp 1 lít, nước mắm và nước tương), hoặc dòng phiếu là phí/dịch vụ không nhập kho.",
};

export const SUGGESTED_CLASS_INSTRUCTIONS =
  "Món đích `target` thuộc nhóm nào dưới đây?";
export const SUGGESTED_CLASS_CRITERIA: Record<KhoReviewJevClass, string> = {
  raw_material: "Nguyên liệu chế biến trực tiếp: bột, bơ, thịt, rau, gia vị, dầu ăn.",
  packaging_supply: "Bao bì hoặc vật tư tiêu hao: hộp, túi, găng tay, sticker, màng bọc, khay.",
};

export interface KhoReviewJevState {
  target: {
    kind: KhoReviewJevTargetKind;
    name: string;
    unit?: string | null;
    item_code?: string | null;
    item_class?: string | null;
    location?: string | null;
    recipe_unit?: string | null;
    sku_codes?: string[];
  };
  line: {
    name: string;
    unit: string | null;
    supplier: string | null;
    receipt_date: string | null;
    location: string | null;
  };
}

export function khoReviewJevQuestions(kind: KhoReviewJevTargetKind) {
  const questions: Record<string, unknown> = {
    same_item: {
      type: "boolean",
      instructions: SAME_ITEM_INSTRUCTIONS,
      criteria: SAME_ITEM_CRITERIA,
    },
  };
  if (kind === "material") {
    questions.suggested_class = {
      type: "choice",
      instructions: SUGGESTED_CLASS_INSTRUCTIONS,
      criteria: SUGGESTED_CLASS_CRITERIA,
    };
  }
  return questions;
}

/** Probability >= 0.8 is the same item, <= 0.2 is different, otherwise unsure. */
export function verdictFromProbability(probability: number): KhoReviewJevVerdict {
  if (probability >= KHO_REVIEW_JEV_SAME_THRESHOLD) return "same_item";
  if (probability <= KHO_REVIEW_JEV_DIFFERENT_THRESHOLD) return "different";
  return "unsure";
}

export type JevUsage = { input: number; output: number };

export interface KhoReviewJevEvaluation {
  /** Probability that the receipt line is the same purchased good. */
  p_same: number;
  suggested_class: KhoReviewJevClass | null;
  class_probability: number | null;
  usage: JevUsage;
  cost: number | null;
  /** Which provider actually answered (always the Jev Gateway). */
  provider?: DecisionsProvider;
}

export interface KhoReviewJevEvaluatorParams {
  kind: KhoReviewJevTargetKind;
  state: KhoReviewJevState;
  signal: AbortSignal;
  /** Absolute epoch-ms budget for the whole request, if any. */
  deadlineAt?: number;
}

export type KhoReviewJevEvaluator = (
  params: KhoReviewJevEvaluatorParams,
) => Promise<KhoReviewJevEvaluation>;

export interface KhoReviewJevConfig {
  apiKey: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
  circuit?: JevCircuit;
}

export class KhoReviewJevError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    public readonly detail: string | null = null,
  ) {
    super(code);
    this.name = "KhoReviewJevError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function validateUsage(body: Record<string, unknown>): JevUsage {
  if (!isRecord(body.usage)) throw new KhoReviewJevError("jev_invalid_response", 502);
  const input = body.usage.inputTokens;
  const output = body.usage.outputTokens;
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0) {
    throw new KhoReviewJevError("jev_invalid_response", 502);
  }
  if (typeof output !== "number" || !Number.isFinite(output) || output < 0) {
    throw new KhoReviewJevError("jev_invalid_response", 502);
  }
  return { input, output };
}

function gatewayCost(metadata: unknown): number | null {
  if (!isRecord(metadata) || !isRecord(metadata.gateway)) return null;
  const raw = metadata.gateway.cost;
  const value = typeof raw === "string" ? Number(raw) : typeof raw === "number" ? raw : Number.NaN;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Strict validation of the single boolean `same_item` answer. */
function validateSameItemAnswer(body: Record<string, unknown>): number {
  if (!isRecord(body.answers)) throw new KhoReviewJevError("jev_invalid_response", 502);
  const answer = body.answers.same_item;
  if (!isRecord(answer) || answer.type !== "boolean") {
    throw new KhoReviewJevError("jev_invalid_response", 502);
  }
  for (const key of Object.keys(answer)) {
    if (key !== "type" && key !== "probability" && key !== "confidence") {
      throw new KhoReviewJevError("jev_invalid_response", 502);
    }
  }
  if (Object.hasOwn(answer, "confidence") && !finiteUnit(answer.confidence)) {
    throw new KhoReviewJevError("jev_invalid_response", 502);
  }
  if (!finiteUnit(answer.probability)) throw new KhoReviewJevError("jev_invalid_response", 502);
  return answer.probability as number;
}

/** Strict validation of the material `suggested_class` choice answer. */
function validateSuggestedClassAnswer(body: Record<string, unknown>): {
  suggestedClass: KhoReviewJevClass;
  probability: number;
} {
  if (!isRecord(body.answers)) throw new KhoReviewJevError("jev_invalid_response", 502);
  const answer = body.answers.suggested_class;
  if (!isRecord(answer) || answer.type !== "choice") {
    throw new KhoReviewJevError("jev_invalid_response", 502);
  }
  for (const key of Object.keys(answer)) {
    if (key !== "type" && key !== "choice" && key !== "probabilities" && key !== "confidence") {
      throw new KhoReviewJevError("jev_invalid_response", 502);
    }
  }
  if (Object.hasOwn(answer, "confidence") && !finiteUnit(answer.confidence)) {
    throw new KhoReviewJevError("jev_invalid_response", 502);
  }
  if (
    typeof answer.choice !== "string"
    || !KHO_REVIEW_JEV_CLASS_OPTIONS.includes(answer.choice as KhoReviewJevClass)
  ) {
    throw new KhoReviewJevError("jev_invalid_response", 502);
  }
  if (!isRecord(answer.probabilities)) throw new KhoReviewJevError("jev_invalid_response", 502);
  const probabilities = answer.probabilities;
  if (
    Object.keys(probabilities).length !== KHO_REVIEW_JEV_CLASS_OPTIONS.length
    || KHO_REVIEW_JEV_CLASS_OPTIONS.some((option) => !Object.hasOwn(probabilities, option))
  ) {
    throw new KhoReviewJevError("jev_invalid_response", 502);
  }
  let sum = 0;
  for (const option of KHO_REVIEW_JEV_CLASS_OPTIONS) {
    if (!finiteUnit(probabilities[option])) throw new KhoReviewJevError("jev_invalid_response", 502);
    sum += probabilities[option] as number;
  }
  const suggestedClass = answer.choice as KhoReviewJevClass;
  const chosenProbability = probabilities[suggestedClass] as number;
  if (
    KHO_REVIEW_JEV_CLASS_OPTIONS.some(
      (option) => option !== suggestedClass && (probabilities[option] as number) >= chosenProbability,
    )
  ) {
    throw new KhoReviewJevError("jev_invalid_response", 502);
  }
  if (Math.abs(sum - 1) > 0.02) throw new KhoReviewJevError("jev_invalid_response", 502);
  return { suggestedClass, probability: chosenProbability };
}

/**
 * Strict validation of one Gateway response. Unknown model, wrong answer type,
 * a missing/extra question, out-of-range probabilities or a non-normalised
 * choice distribution are all refused.
 */
export function validateKhoReviewJevResponse(
  kind: KhoReviewJevTargetKind,
  body: unknown,
): KhoReviewJevEvaluation {
  if (!isRecord(body) || body.model !== JEV_MODEL) {
    throw new KhoReviewJevError("jev_invalid_response", 502);
  }
  const usage = validateUsage(body);
  const cost = gatewayCost(body.providerMetadata);
  if (!isRecord(body.answers)) throw new KhoReviewJevError("jev_invalid_response", 502);
  const expectedKeys = kind === "material" ? ["same_item", "suggested_class"] : ["same_item"];
  if (
    Object.keys(body.answers).length !== expectedKeys.length
    || expectedKeys.some((key) => !Object.hasOwn(body.answers as Record<string, unknown>, key))
  ) {
    throw new KhoReviewJevError("jev_invalid_response", 502);
  }
  const pSame = validateSameItemAnswer(body);
  if (kind === "item") {
    return {
      p_same: pSame,
      suggested_class: null,
      class_probability: null,
      usage,
      cost,
    };
  }
  const result = validateSuggestedClassAnswer(body);
  return {
    p_same: pSame,
    suggested_class: result.suggestedClass,
    class_probability: result.probability,
    usage,
    cost,
  };
}

export function createKhoReviewJevEvaluator(
  config: KhoReviewJevConfig,
): KhoReviewJevEvaluator {
  const apiKey = config.apiKey ?? "";
  if (!apiKey) throw new KhoReviewJevError("jev_unconfigured", 503);
  const fetcher = config.fetcher ?? fetch;
  const circuit = config.circuit ?? createJevCircuit({
    threshold: JEV_CIRCUIT_THRESHOLD,
    cooldownMs: JEV_CIRCUIT_COOLDOWN_MS,
  });
  const configuredTimeout = Math.max(
    1,
    Math.min(config.timeoutMs ?? KHO_REVIEW_JEV_TIMEOUT_MS, JEV_MAX_TIMEOUT_MS),
  );

  return async ({ kind, state, signal, deadlineAt }): Promise<KhoReviewJevEvaluation> => {
    signal.throwIfAborted();
    if (!circuit.canAttempt()) throw new KhoReviewJevError("jev_circuit_open", 503);
    const remaining = deadlineAt === undefined ? Infinity : deadlineAt - Date.now();
    if (remaining <= 0) throw new KhoReviewJevError("jev_deadline_exceeded", 504);
    const budget = Math.max(1, Math.min(configuredTimeout, remaining));
    const requestBody = {
      model: JEV_MODEL,
      state,
      questions: khoReviewJevQuestions(kind),
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
        maxBodyBytes: KHO_REVIEW_JEV_BODY_LIMIT,
      });
    } catch (error) {
      signal.throwIfAborted();
      circuit.recordFailure();
      const code = decisionsFailureCode(error);
      throw new KhoReviewJevError(
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
      if (outcome.status === 429) throw new KhoReviewJevError("jev_rate_limited", 429, detail);
      throw new KhoReviewJevError("jev_http_error", 502, detail);
    }
    let evaluation: KhoReviewJevEvaluation;
    try {
      evaluation = { ...validateKhoReviewJevResponse(kind, outcome.body), provider: outcome.provider };
    } catch (error) {
      circuit.recordFailure();
      throw error;
    }
    circuit.recordSuccess();
    return evaluation;
  };
}
