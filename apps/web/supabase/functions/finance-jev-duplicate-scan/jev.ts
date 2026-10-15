// Server-side Jev evaluator for the finance duplicate scan.
//
// The transport reuses the verified Vercel AI Gateway contract already used by
// the chat Jev module: POST https://ai-gateway.vercel.sh/v1/evaluate, model
// typesafe-ai/jev, providerOptions.gateway {zeroDataRetention: true,
// only: ["typesafe-ai"]} and one deadline per call with no retry. This module is
// self-contained (it does not alter the chat module) and holds no database
// client: the caller injects `state`, the evaluator returns the two independent
// judgments and never reads or forwards the caller bearer token.
//
// Contract reference (verified): https://docs.typesafe.ai/api.md and
// https://docs.typesafe.ai/primitives/noul.md.

import {
  DecisionsError,
  decisionsFailureCode,
  evaluateDecisions,
  type DecisionsImage,
  type DecisionsOutcome,
  type DecisionsProvider,
} from "../_shared/decisions-provider.ts";
import { withCorrections } from "../_shared/robot-feedback.ts";

export const JEV_ENDPOINT = "https://ai-gateway.vercel.sh/v1/evaluate";
export const JEV_MODEL = "typesafe-ai/jev";
// Bump whenever the state, the two questions or the criteria below change.
export const JEV_PROMPT_VERSION = "jev-dup-2026-10-10.2-boolean";
// One deadline per call, no retry, hard cap 4000 ms.
export const JEV_TIMEOUT_MS = 4000;
export const JEV_MAX_TIMEOUT_MS = 4000;
export const JEV_BODY_LIMIT = 32_000;
export const JEV_CIRCUIT_THRESHOLD = 3;
export const JEV_CIRCUIT_COOLDOWN_MS = 30_000;

export const JEV_RELATION_OPTIONS = ["same_purchase", "repeat_order", "split_or_partial", "unrelated"] as const;
export type JevRelation = (typeof JEV_RELATION_OPTIONS)[number];

export const JEV_QUESTION_IDS = ["same_purchase", "relation"] as const;

export const SAME_PURCHASE_INSTRUCTIONS =
  "Hai phiếu đề nghị chi `older` và `newer` của cùng nhà cung cấp có phải là đề nghị trả tiền cho CÙNG MỘT lần mua hoặc giao hàng, tức là chi trùng, hay không?";

export const SAME_PURCHASE_CRITERIA = {
  true: "Trùng khi cùng hàng, cùng số lượng, cùng hóa đơn hoặc cùng phiếu nhập, hoặc phiếu sau như bản tạo lại của phiếu trước.",
  false: "KHÔNG trùng khi là đơn đặt lặp lại định kỳ với phiếu nhập hoặc ngày giao khác nhau, hoặc khác hàng hay khác số lượng.",
};

export const RELATION_INSTRUCTIONS =
  "Hai phiếu đề nghị chi `older` và `newer` của cùng nhà cung cấp có quan hệ nào?";

export const RELATION_CRITERIA: Record<JevRelation, string> = {
  same_purchase: "cùng một lần mua bị lập hai phiếu",
  repeat_order: "đặt lại hàng giống nhau cho lần giao khác",
  split_or_partial: "một lần mua tách nhiều phiếu hoặc trả từng phần",
  unrelated: "không liên quan",
};

export function jevQuestions(options: {
  corrections?: readonly string[];
  /** When set, replaces the text same_purchase instruction for the image pass. */
  imageInstructions?: string;
} = {}) {
  const sameInstructions = options.imageInstructions ?? SAME_PURCHASE_INSTRUCTIONS;
  const corrections = options.corrections ?? [];
  return {
    same_purchase: {
      type: "boolean",
      instructions: withCorrections(sameInstructions, corrections),
      criteria: SAME_PURCHASE_CRITERIA,
    },
    relation: {
      type: "choice",
      instructions: withCorrections(RELATION_INSTRUCTIONS, corrections),
      criteria: RELATION_CRITERIA,
    },
  };
}

export type JevUsage = { input: number; output: number };

export interface JevEvaluation {
  p_same: number;
  relation: JevRelation;
  relation_probability: number;
  relation_confidence: number | null;
  usage: JevUsage;
  cost: number | null;
  /** Which provider actually answered ('openai' or the Jev fallback). */
  provider?: DecisionsProvider;
  /** True only when the OpenAI answer was asked with the receipt images. */
  images_used?: boolean;
}

export interface JevEvaluatorParams {
  state: unknown;
  signal: AbortSignal;
  /** Inline goods-receipt images; only the OpenAI path forwards them. */
  images?: DecisionsImage[];
  /** Up to 5 relevant past CEO decisions appended to the question text. */
  corrections?: string[];
  /** Image-pass instruction that replaces the default same_purchase text. */
  imageInstructions?: string;
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

/**
 * Strict validation of the documented Gateway response. Unknown model, wrong
 * answer type, missing/extra question, unknown/extra option, non-finite or
 * out-of-range probabilities, a tied/non-top choice and a non-normalised
 * distribution are all refused. The one documented optional `confidence` field
 * is accepted as a finite [0,1] number and never consumed as the probability.
 */
export function validateJevResponse(body: unknown): JevEvaluation {
  if (!isRecord(body) || body.model !== JEV_MODEL) throw new JevError("jev_invalid_response", 502);
  if (!isRecord(body.answers)) throw new JevError("jev_invalid_response", 502);
  const answers = body.answers;
  if (Object.keys(answers).sort().join(",") !== [...JEV_QUESTION_IDS].sort().join(",")) {
    throw new JevError("jev_invalid_response", 502);
  }

  // AI Gateway /v1/evaluate shape: a yes/no question is `type: "boolean"` and its
  // answer is `{ type: "boolean", probability }` (TypeSafe's raw `noul` shape is only
  // served on the separate /typesafe endpoint). Verified against the Gateway docs
  // after the first live dry run was rejected for sending `noul`.
  const yesNo = answers.same_purchase;
  if (!isRecord(yesNo) || yesNo.type !== "boolean") throw new JevError("jev_invalid_response", 502);
  for (const key of Object.keys(yesNo)) {
    if (key !== "type" && key !== "probability" && key !== "confidence") throw new JevError("jev_invalid_response", 502);
  }
  if (Object.hasOwn(yesNo, "confidence") && !finiteUnit(yesNo.confidence)) throw new JevError("jev_invalid_response", 502);
  if (!finiteUnit(yesNo.probability)) throw new JevError("jev_invalid_response", 502);

  const choice = answers.relation;
  if (!isRecord(choice) || choice.type !== "choice") throw new JevError("jev_invalid_response", 502);
  for (const key of Object.keys(choice)) {
    if (key !== "type" && key !== "choice" && key !== "probabilities" && key !== "confidence") {
      throw new JevError("jev_invalid_response", 502);
    }
  }
  if (Object.hasOwn(choice, "confidence") && !finiteUnit(choice.confidence)) throw new JevError("jev_invalid_response", 502);
  if (typeof choice.choice !== "string" || !JEV_RELATION_OPTIONS.includes(choice.choice as JevRelation)) {
    throw new JevError("jev_invalid_response", 502);
  }
  if (!isRecord(choice.probabilities)) throw new JevError("jev_invalid_response", 502);
  const probabilities = choice.probabilities;
  if (
    Object.keys(probabilities).length !== JEV_RELATION_OPTIONS.length
    || JEV_RELATION_OPTIONS.some((option) => !Object.hasOwn(probabilities, option))
  ) {
    throw new JevError("jev_invalid_response", 502);
  }
  let sum = 0;
  for (const option of JEV_RELATION_OPTIONS) {
    if (!finiteUnit(probabilities[option])) throw new JevError("jev_invalid_response", 502);
    sum += probabilities[option] as number;
  }
  const relation = choice.choice as JevRelation;
  const relationProbability = probabilities[relation] as number;
  if (JEV_RELATION_OPTIONS.some((option) => option !== relation && (probabilities[option] as number) >= relationProbability)) {
    throw new JevError("jev_invalid_response", 502);
  }
  if (Math.abs(sum - 1) > 0.02) throw new JevError("jev_invalid_response", 502);

  if (!isRecord(body.usage)) throw new JevError("jev_invalid_response", 502);
  const input = body.usage.inputTokens;
  const output = body.usage.outputTokens;
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0 || typeof output !== "number" || !Number.isFinite(output) || output < 0) {
    throw new JevError("jev_invalid_response", 502);
  }

  return {
    p_same: yesNo.probability as number,
    relation,
    relation_probability: relationProbability,
    relation_confidence: Object.hasOwn(choice, "confidence") ? (choice.confidence as number) : null,
    usage: { input, output },
    cost: gatewayCost(body.providerMetadata),
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

  return async ({ state, signal, images, corrections, imageInstructions, deadlineAt }): Promise<JevEvaluation> => {
    signal.throwIfAborted();
    if (!circuit.canAttempt()) throw new JevError("jev_circuit_open", 503);
    const remaining = deadlineAt === undefined ? Infinity : deadlineAt - Date.now();
    if (remaining <= 0) throw new JevError("jev_deadline_exceeded", 504);
    const budget = Math.max(1, Math.min(configuredTimeout, remaining));
    const requestBody = {
      model: JEV_MODEL,
      state,
      questions: jevQuestions({ corrections, imageInstructions }),
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
        ...(images && images.length ? { images } : {}),
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
      evaluation = { ...validateJevResponse(outcome.body), provider: outcome.provider, images_used: outcome.images_used };
    } catch (error) {
      circuit.recordFailure();
      throw error;
    }
    circuit.recordSuccess();
    return evaluation;
  };
}
