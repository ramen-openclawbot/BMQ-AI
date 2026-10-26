// Server-side Jev evaluator for the whole payment request stock label.
//
// Self-contained on purpose: it does not import across function folders and
// holds no database client. The transport copies the verified AI Gateway
// contract used by cost-classify-sushi / stock-routing-jev: POST
// https://ai-gateway.vercel.sh/v1/evaluate, model typesafe-ai/jev,
// providerOptions.gateway {zeroDataRetention: true, only: ["typesafe-ai"]} and
// one deadline per call with no retry.
//
// One choice question per payment request:
//   stock_label: the request is either a purchase of goods / raw materials that
//                must enter the warehouse (stock) or a service / rent / utility
//                / repair / fee / tax payment that must not (non_stock).
//
// The validated answer is the JSON shape the handler applies:
//   { class: "stock" | "non_stock", confidence: 0..1, reason: <= 120 chars }
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
export const PAYMENT_STOCK_LABEL_PROMPT_VERSION = "payment-stock-label-2026-10-26.1";
export const JEV_TIMEOUT_MS = 4000;
export const JEV_MAX_TIMEOUT_MS = 4000;
export const JEV_BODY_LIMIT = 32_000;
export const JEV_CIRCUIT_THRESHOLD = 3;
export const JEV_CIRCUIT_COOLDOWN_MS = 30_000;

export const STOCK_LABEL_QUESTION_KEY = "stock_label";
export const STOCK_LABEL_REASON_MAX = 120;

export type StockLabelClass = "stock" | "non_stock";

export const STOCK_LABEL_CRITERIA: Record<StockLabelClass, string> = {
  stock:
    "Mua hàng hóa / nguyên vật liệu cần nhập kho (hàng có tồn kho, thường có đơn mua hàng hoặc phiếu nhập)",
  non_stock:
    "Chi dịch vụ / thuê / điện nước / sửa chữa / phí / thuế (không nhập kho)",
};

export const STOCK_LABEL_INSTRUCTIONS =
  "Phiếu chi `request` là mua hàng hóa / nguyên vật liệu cần nhập kho (stock) " +
  "hay chi dịch vụ / thuê / điện nước / sửa chữa / phí / thuế (non_stock)? " +
  "Dùng `manual_examples` cùng nhà cung cấp làm ví dụ khi có.";

export const STOCK_REASON = "Hàng hóa / nguyên vật liệu cần nhập kho";
export const NON_STOCK_REASON = "Dịch vụ, thuê, điện nước, sửa chữa, phí hoặc thuế — không nhập kho";

export function stockLabelQuestion() {
  return {
    [STOCK_LABEL_QUESTION_KEY]: {
      type: "choice" as const,
      instructions: STOCK_LABEL_INSTRUCTIONS,
      criteria: STOCK_LABEL_CRITERIA,
    },
  };
}

export function reasonForClass(value: StockLabelClass): string {
  const reason = value === "stock" ? STOCK_REASON : NON_STOCK_REASON;
  return reason.slice(0, STOCK_LABEL_REASON_MAX);
}

export function isStockLabelClass(value: unknown): value is StockLabelClass {
  return value === "stock" || value === "non_stock";
}

export interface StockLabelExample {
  title: string;
  description: string | null;
  requires_receipt: boolean;
  item_names: string[];
}

export interface StockLabelCandidate {
  request_id: string;
  supplier_id?: string | null;
  supplier_name?: string | null;
  title?: string | null;
  description?: string | null;
  total_amount?: number | null;
  vat_amount?: number | null;
  item_names?: string[] | null;
  manual_examples?: StockLabelExample[] | null;
}

/** State sent to Jev for the `stock_label` question. */
export interface StockLabelState {
  request: {
    supplier: string;
    title: string;
    description: string | null;
    total_amount: number;
    vat_amount: number;
    items: string[];
  };
  manual_examples: {
    title: string;
    description: string | null;
    requires_receipt: boolean;
    items: string[];
  }[];
}

function numeric(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function text(value: string | null | undefined): string {
  return typeof value === "string" ? value : "";
}

function stringList(value: string[] | null | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim() !== "").slice(0, 30)
    : [];
}

export function buildStockLabelState(candidate: StockLabelCandidate): StockLabelState {
  const examples = Array.isArray(candidate.manual_examples) ? candidate.manual_examples : [];
  return {
    request: {
      supplier: text(candidate.supplier_name),
      title: text(candidate.title),
      description: candidate.description ?? null,
      total_amount: numeric(candidate.total_amount),
      vat_amount: numeric(candidate.vat_amount),
      items: stringList(candidate.item_names),
    },
    manual_examples: examples.slice(0, 5).map((example) => ({
      title: text(example.title),
      description: example.description ?? null,
      requires_receipt: example.requires_receipt === true,
      items: stringList(example.item_names),
    })),
  };
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export type JevUsage = { input: number; output: number };

export interface StockLabelEvaluation {
  class: StockLabelClass;
  confidence: number;
  reason: string;
  usage: JevUsage;
  cost: number | null;
  /** Which provider actually answered (always the Jev Gateway). */
  provider?: DecisionsProvider;
}

export interface StockLabelEvaluatorParams {
  state: StockLabelState;
  signal: AbortSignal;
  deadlineAt?: number;
}

/** `null` means "the provider answered but not with a usable option". */
export type StockLabelEvaluator = (
  params: StockLabelEvaluatorParams,
) => Promise<StockLabelEvaluation | null>;

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
  if (typeof input !== "number" || !Number.isFinite(input) || input < 0) {
    throw new JevError("jev_invalid_response", 502);
  }
  if (typeof output !== "number" || !Number.isFinite(output) || output < 0) {
    throw new JevError("jev_invalid_response", 502);
  }
  return { input, output };
}

function clampReason(value: unknown, fallback: string): string {
  const textValue = typeof value === "string" ? value.trim() : "";
  const reason = textValue !== "" ? textValue : fallback;
  return reason.slice(0, STOCK_LABEL_REASON_MAX);
}

/**
 * Validate the single `stock_label` choice and derive the apply JSON:
 * { class, confidence, reason }. A malformed transport envelope is a provider
 * failure, but an unknown option, a missing answer, a missing probability or a
 * confidence outside 0..1 is "no answer" (`null`) and the caller writes nothing.
 */
export function validateStockLabelAnswer(body: unknown): StockLabelEvaluation | null {
  if (!isRecord(body) || body.model !== JEV_MODEL) throw new JevError("jev_invalid_response", 502);
  const usage = validateUsage(body);
  const cost = gatewayCost(body.providerMetadata);

  if (!isRecord(body.answers)) return null;
  if (!Object.hasOwn(body.answers, STOCK_LABEL_QUESTION_KEY)) return null;
  const answer = body.answers[STOCK_LABEL_QUESTION_KEY];
  if (!isRecord(answer) || answer.type !== "choice") return null;
  if (!isStockLabelClass(answer.choice)) return null;
  if (!isRecord(answer.probabilities)) return null;
  if (!Object.hasOwn(answer.probabilities, answer.choice)) return null;
  const probability = answer.probabilities[answer.choice];
  if (!finiteUnit(probability)) return null;

  // A present but out-of-range confidence is an invalid schema, not a fallback.
  if (Object.hasOwn(answer, "confidence") && answer.confidence !== null && !finiteUnit(answer.confidence)) {
    return null;
  }
  const confidence = finiteUnit(answer.confidence) ? answer.confidence : probability;
  const reason = clampReason(answer.reason, reasonForClass(answer.choice));
  if (reason.length < 3) return null;

  return {
    class: answer.choice,
    confidence,
    reason,
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

export function createJevCircuit(
  options: { threshold?: number; cooldownMs?: number; now?: () => number } = {},
): JevCircuit {
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

export function createStockLabelEvaluator(config: JevConfig): StockLabelEvaluator {
  const apiKey = config.apiKey ?? "";
  if (!apiKey) throw new JevError("jev_unconfigured", 503);
  const fetcher = config.fetcher ?? fetch;
  const circuit = config.circuit ?? createJevCircuit();
  const configuredTimeout = Math.max(1, Math.min(config.timeoutMs ?? JEV_TIMEOUT_MS, JEV_MAX_TIMEOUT_MS));

  return async ({ state, signal, deadlineAt }): Promise<StockLabelEvaluation | null> => {
    signal.throwIfAborted();
    if (!circuit.canAttempt()) throw new JevError("jev_circuit_open", 503);
    const remaining = deadlineAt === undefined ? Infinity : deadlineAt - Date.now();
    if (remaining <= 0) throw new JevError("jev_deadline_exceeded", 504);
    const budget = Math.max(1, Math.min(configuredTimeout, remaining));
    const requestBody = {
      model: JEV_MODEL,
      state,
      questions: stockLabelQuestion(),
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
        maxBodyBytes: JEV_BODY_LIMIT,
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
    let evaluation: StockLabelEvaluation | null;
    try {
      const validated = validateStockLabelAnswer(outcome.body);
      evaluation = validated === null ? null : { ...validated, provider: outcome.provider };
    } catch (error) {
      circuit.recordFailure();
      throw error;
    }
    circuit.recordSuccess();
    return evaluation;
  };
}
