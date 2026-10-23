// Server-side Jev evaluator for choosing an expense template for an invoice.
//
// The transport reuses the verified Vercel AI Gateway contract already used by
// cost-classify-sushi/jev.ts: POST https://ai-gateway.vercel.sh/v1/evaluate,
// model typesafe-ai/jev, providerOptions.gateway {zeroDataRetention: true,
// only: ["typesafe-ai"]} and one deadline per call with no retry.
//
// The provider answers one choice question keyed `template_id`; the caller
// offers only the active, non-goods templates of the invoice's supplier plus
// the `none` option. The evaluator returns the documented shape
// {template_id: string|null, confidence: number, reason: string}; the handler
// applies it only when the id is in the offered list and confidence >= 0.8.

import {
  DecisionsError,
  decisionsFailureCode,
  evaluateDecisions,
  type DecisionsProvider,
} from "../_shared/decisions-provider.ts";

export const JEV_ENDPOINT = "https://ai-gateway.vercel.sh/v1/evaluate";
export const JEV_MODEL = "typesafe-ai/jev";
// Bump whenever the state, the question or the criteria below change.
export const INVOICE_JEV_PROMPT_VERSION = "invoice-ingest-2026-10-23.1";
export const JEV_TIMEOUT_MS = 4000;
export const JEV_MAX_TIMEOUT_MS = 4000;
export const JEV_BODY_LIMIT = 32_000;
export const JEV_QUESTION_KEY = "template_id";
export const JEV_NONE_OPTION = "none";

export interface InvoiceJevEvaluation {
  template_id: string | null;
  confidence: number;
  reason: string;
}

export interface InvoiceJevEvaluatorParams {
  state: unknown;
  allowedTemplateIds: readonly string[];
  signal: AbortSignal;
  deadlineAt?: number;
}

export type InvoiceJevEvaluator = (
  params: InvoiceJevEvaluatorParams,
) => Promise<InvoiceJevEvaluation | null>;

export class InvoiceJevError extends Error {
  readonly code: string;
  readonly status: number;
  readonly detail: string | null;

  constructor(code: string, status: number, detail: string | null = null) {
    super(code);
    this.name = "InvoiceJevError";
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

function formatPercent(probability: number): string {
  return `${(probability * 100).toFixed(1)}%`;
}

/** Read label/cadence hints from the candidate state; unknowns fall back to the id. */
function templateLabels(state: unknown): Map<string, string> {
  const labels = new Map<string, string>();
  if (!isRecord(state) || !Array.isArray(state.templates)) return labels;
  for (const row of state.templates) {
    if (!isRecord(row) || typeof row.id !== "string") continue;
    const label = typeof row.label === "string" ? row.label.trim() : "";
    const cadence = typeof row.cadence === "string" ? row.cadence.trim() : "";
    const median = typeof row.amount_median === "number" && Number.isFinite(row.amount_median)
      ? row.amount_median
      : null;
    const hint = [
      label || row.id,
      cadence ? `định kỳ ${cadence}` : "",
      median !== null ? `thường ~${median}` : "",
    ].filter((part) => part !== "").join(", ");
    labels.set(row.id, hint);
  }
  return labels;
}

export function templateCriteria(
  allowedTemplateIds: readonly string[],
  labels: Map<string, string> = new Map(),
): Record<string, string> {
  const criteria: Record<string, string> = {};
  for (const id of allowedTemplateIds) {
    criteria[id] = labels.get(id) ?? id;
  }
  criteria[JEV_NONE_OPTION] = "Không có khuôn nào phù hợp với hóa đơn này";
  return criteria;
}

export function buildInvoiceJevQuestion(
  allowedTemplateIds: readonly string[],
  state: unknown,
) {
  const labels = templateLabels(state);
  return {
    [JEV_QUESTION_KEY]: {
      type: "choice" as const,
      instructions:
        "Hóa đơn `invoice` (bên bán, số hóa đơn, ngày, tổng tiền, các dòng hàng) " +
        "thuộc khuôn khoản chi nào của cùng nhà cung cấp? Chọn `none` nếu không khuôn nào phù hợp.",
      criteria: templateCriteria(allowedTemplateIds, labels),
    },
  };
}

/**
 * Validate the one `template_id` choice. A malformed transport envelope is a
 * provider failure; an unknown id is refused so the caller never applies a
 * template that was not offered.
 */
export function validateInvoiceJevAnswer(
  allowedTemplateIds: readonly string[],
  body: unknown,
): InvoiceJevEvaluation {
  if (!isRecord(body) || body.model !== JEV_MODEL) {
    throw new InvoiceJevError("jev_invalid_response", 502);
  }
  if (!isRecord(body.answers) || !Object.hasOwn(body.answers, JEV_QUESTION_KEY)) {
    throw new InvoiceJevError("jev_invalid_response", 502);
  }
  const answer = body.answers[JEV_QUESTION_KEY];
  if (!isRecord(answer) || answer.type !== "choice") {
    throw new InvoiceJevError("jev_invalid_response", 502);
  }
  if (typeof answer.choice !== "string") {
    throw new InvoiceJevError("jev_invalid_response", 502);
  }
  const choice = answer.choice;
  if (choice !== JEV_NONE_OPTION && !allowedTemplateIds.includes(choice)) {
    throw new InvoiceJevError("jev_invalid_response", 502);
  }
  if (!isRecord(answer.probabilities) || !Object.hasOwn(answer.probabilities, choice)) {
    throw new InvoiceJevError("jev_invalid_response", 502);
  }
  const probability = answer.probabilities[choice];
  if (!finiteUnit(probability)) {
    throw new InvoiceJevError("jev_invalid_response", 502);
  }

  const explicitReason = typeof answer.reason === "string" && answer.reason.trim() !== ""
    ? answer.reason.trim()
    : null;
  return {
    template_id: choice === JEV_NONE_OPTION ? null : choice,
    confidence: probability,
    reason: explicitReason ?? (
      choice === JEV_NONE_OPTION
        ? `Jev không chọn khuôn nào (${formatPercent(probability)})`
        : `Jev chọn ${choice} (${formatPercent(probability)})`
    ),
  };
}

export interface InvoiceJevConfig {
  apiKey: string;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

export function createInvoiceJevEvaluator(
  config: InvoiceJevConfig,
): InvoiceJevEvaluator {
  const apiKey = config.apiKey ?? "";
  if (!apiKey) throw new InvoiceJevError("jev_unconfigured", 503);
  const fetcher = config.fetcher ?? fetch;
  const configuredTimeout = Math.max(
    1,
    Math.min(config.timeoutMs ?? JEV_TIMEOUT_MS, JEV_MAX_TIMEOUT_MS),
  );

  return async ({ state, allowedTemplateIds, signal, deadlineAt }) => {
    signal.throwIfAborted();
    const allowed = allowedTemplateIds.filter((id) => typeof id === "string" && id !== "");
    if (allowed.length < 1) return null;

    const remaining = deadlineAt === undefined ? Infinity : deadlineAt - Date.now();
    if (remaining <= 0) throw new InvoiceJevError("jev_deadline_exceeded", 504);
    const budget = Math.max(1, Math.min(configuredTimeout, remaining));

    const requestBody = {
      model: JEV_MODEL,
      state,
      questions: buildInvoiceJevQuestion(allowed, state),
      providerOptions: { gateway: { zeroDataRetention: true, only: ["typesafe-ai"] } },
    };

    let outcome: { status: number; body: unknown; provider: DecisionsProvider };
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
      const code = decisionsFailureCode(error);
      throw new InvoiceJevError(
        code,
        code === "jev_timeout" ? 504 : code === "jev_invalid_response" ? 502 : 503,
        error instanceof DecisionsError ? error.detail : null,
      );
    }

    if (outcome.status < 200 || outcome.status >= 300) {
      const detail = outcome.body == null
        ? `HTTP ${outcome.status}`
        : `HTTP ${outcome.status}: ${String(outcome.body).replace(/\s+/g, " ").slice(0, 300)}`;
      throw new InvoiceJevError(
        outcome.status === 429 ? "jev_rate_limited" : "jev_http_error",
        outcome.status === 429 ? 429 : 502,
        detail,
      );
    }

    const evaluation = validateInvoiceJevAnswer(allowed, outcome.body);
    return evaluation;
  };
}
