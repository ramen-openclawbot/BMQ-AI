// Minimal, side-effect-free BMQ analytics interaction capture.
//
// This module turns one analytics-chat exchange into a bounded row for the
// separate `vnagent_interactions` dataset. It is deliberately NOT part of the
// planner/router and never touches business ledgers or financial results.
//
// Guarantees encoded here:
//   * every distinct real event keeps its own identity; only a retry of the same
//     capture attempt may reuse a request id (the caller supplies it);
//   * obvious secrets (bearer tokens, API keys, JWTs, password-like values) are
//     redacted from every stored string, including nested metadata;
//   * conversation history text is never stored; provider bodies are not stored;
//   * unknown usage numbers stay null — they are never fabricated as 0;
//   * page input filters are kept separate from the filters that actually ran;
//   * Jev telemetry is mapped from the REAL JevTelemetry fields in jev.ts
//     (metric/period/support probabilities, versions, cost, usage, timings,
//     counts) and never invents route/optionIds/probabilities keys;
//   * a capture failure can never change the business reply (the caller wraps
//     this in try/catch and audits the failure instead of claiming success).

export const CAPTURE_TENANT = "bmq" as const;
export const RETENTION_DAYS = 180;
export const QUESTION_MAX = 4000;
export const ANSWER_MAX = 2000;
export const CONTEXT_TEXT_MAX = 300;
export const FILTER_KEYS_MAX = 20;
export const NESTED_DEPTH_MAX = 3;

export type ResponseStatus = "success" | "abstained" | "error" | "unknown";

export interface CaptureIdentity {
  userId: string;
}

export interface CaptureProvenance {
  lane?: unknown;
  model?: unknown;
  queries?: unknown;
  modelCalls?: unknown;
  usage?: unknown;
  elapsedMs?: unknown;
  cacheHits?: unknown;
  semanticVersion?: unknown;
  citations?: unknown;
  evidence?: unknown;
  jev?: unknown;
}

export interface CaptureEvent {
  /** Caller-provided per-event identity. A retry of the same attempt reuses it. */
  requestId: string;
  identity: CaptureIdentity;
  /** Parsed analytics request body (page, filters, conversationId, question). */
  body: unknown;
  /** Presented server result (success/abstain paths). Never trusted blindly. */
  presented?: unknown;
  status: ResponseStatus;
  responseCode?: string | null;
  now?: Date;
  /** Optional bounded capture deadline, independent of the business deadline. */
  signal?: AbortSignal;
}

export interface InteractionRow {
  tenant: typeof CAPTURE_TENANT;
  request_id: string;
  actor_id: string;
  conversation_id: string | null;
  source_route: string | null;
  source_label: string | null;
  question_text: string;
  /** Bounded, redacted original answer for reviewer reference (never Gold truth). */
  answer_text: string | null;
  redaction_applied: boolean;
  context_summary: Record<string, unknown>;
  understood_intent: Record<string, unknown>;
  /** Filters the screen sent; context only, not what actually ran. */
  page_filters: Record<string, string>;
  /** Filters the analytics lane actually executed (metric/period/dimensions). */
  executed_filters: Record<string, unknown>;
  tool: string | null;
  provenance: Record<string, unknown>;
  response_status: ResponseStatus;
  response_code: string | null;
  known_usage: Record<string, unknown>;
  unknown_usage: Record<string, unknown>;
  model_route: string | null;
  capture_status: "captured" | "redacted" | "partial";
  retention_expires_at: string;
}

export interface JevRow {
  tenant: typeof CAPTURE_TENANT;
  request_id: string;
  model: string | null;
  prompt_version: string | null;
  registry_version: string | null;
  attempted: boolean;
  decided: boolean;
  screen: string | null;
  circuit: string | null;
  metric: string | null;
  metric_probability: number | null;
  period: string | null;
  period_probability: number | null;
  support: string | null;
  support_probability: number | null;
  threshold: number | null;
  fallback: string | null;
  cost: number | null;
  /** Real JevUsage {input, output}; unknown stays null, never 0. */
  token_counts: { input: number | null; output: number | null };
  /** Real JevTimings object. */
  stage_timings: Record<string, unknown>;
  /** Real JevCounts object. */
  counts: Record<string, unknown>;
  decision: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read the bounded provenance object from a presented result, if any. */
function provenanceOf(event: CaptureEvent): CaptureProvenance {
  const presented = isRecord(event.presented) ? event.presented : {};
  return isRecord(presented.provenance) ? presented.provenance as CaptureProvenance : {};
}

const SECRET_PATTERNS: [RegExp, string][] = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]"],
  [/\bsk-[A-Za-z0-9_-]{10,}\b/g, "[redacted-key]"],
  [/\bAIza[0-9A-Za-z_-]{20,}\b/g, "[redacted-key]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[redacted-token]"],
  [/\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)\s*[:=]\s*\S+/gi, "[redacted-credential]"],
];

const SENSITIVE_KEY = /^(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|credential|bearer|cookie|session)$/i;

/** Remove obvious credentials from free text. Returns whether anything changed. */
export function redactSecrets(value: unknown): { text: string; redacted: boolean } {
  const source = typeof value === "string" ? value : "";
  let text = source.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  let redacted = false;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      redacted = true;
      text = text.replace(pattern, replacement);
    }
    pattern.lastIndex = 0;
  }
  return { text: text.slice(0, QUESTION_MAX), redacted };
}

function boundedText(value: unknown, max = CONTEXT_TEXT_MAX): string | null {
  if (typeof value !== "string") return null;
  const text = redactSecrets(value).text;
  return text ? text.slice(0, max) : null;
}

/**
 * Sanitize every string in a nested value (not only the question): redact
 * secrets, strip control characters, bound depth, key count, array length and
 * string length so nested metadata cannot smuggle credentials or huge payloads.
 */
export function sanitizeNested(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string") return boundedText(value, CONTEXT_TEXT_MAX);
  if (depth >= NESTED_DEPTH_MAX) return null;
  if (Array.isArray(value)) return value.slice(0, FILTER_KEYS_MAX).map((item) => sanitizeNested(item, depth + 1));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, 24)) {
      const safeKey = boundedText(key, 60);
      if (!safeKey) continue;
      // A secret-looking key is redacted even when its value is an opaque string
      // that would not match a token pattern on its own.
      out[safeKey] = SENSITIVE_KEY.test(safeKey) ? "[redacted]" : sanitizeNested(item, depth + 1);
    }
    return out;
  }
  return null;
}

function sanitizedObject(value: unknown): Record<string, unknown> {
  const sanitized = sanitizeNested(value);
  return isRecord(sanitized) ? sanitized : {};
}

function boundedFilters(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value).slice(0, FILTER_KEYS_MAX)) {
    const safeKey = boundedText(key, 60);
    if (!safeKey) continue;
    const safeValue = SENSITIVE_KEY.test(safeKey) ? "[redacted]" : boundedText(item, 120);
    if (safeValue) out[safeKey] = safeValue;
  }
  return out;
}

/** Bounded, actor/tenant-bound context. No history text, no headers, no raw rows. */
export function minimizeContext(body: unknown): Record<string, unknown> {
  const record = isRecord(body) ? body : {};
  const page = isRecord(record.page) ? record.page : {};
  const filters = boundedFilters(page.filters);
  const history = Array.isArray(record.history) ? record.history : [];
  return {
    route: boundedText(page.route, 200),
    label: boundedText(page.label, 100),
    filterKeys: Object.keys(filters),
    historyCount: history.length,
    language: record.language === "en" ? "en" : record.language === "vi" ? "vi" : null,
  };
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Executed filters come from the reviewed provenance, not from the page input. */
function executedFilters(provenance: CaptureProvenance | undefined): Record<string, unknown> {
  const queriesRaw = provenance?.queries;
  const queries = Array.isArray(queriesRaw) ? queriesRaw : [];
  const metrics: string[] = [];
  const periods: string[] = [];
  const dimensions: string[] = [];
  for (const query of queries.slice(0, 8)) {
    if (!isRecord(query)) continue;
    const metric = boundedText(query.metric, 80);
    if (metric && !metrics.includes(metric)) metrics.push(metric);
    const period = boundedText(query.time_range, 60);
    if (period && !periods.includes(period)) periods.push(period);
    if (Array.isArray(query.dimensions)) {
      for (const dimension of query.dimensions.slice(0, 8)) {
        const safe = boundedText(dimension, 60);
        if (safe && !dimensions.includes(safe)) dimensions.push(safe);
      }
    }
  }
  return { metrics, periods, dimensions, queryCount: queries.length };
}

function answerText(event: CaptureEvent): string | null {
  const presented = isRecord(event.presented) ? event.presented : {};
  const answer = typeof presented.answer === "string" ? presented.answer : null;
  if (!answer) return null;
  const redacted = redactSecrets(answer).text;
  return redacted ? redacted.slice(0, ANSWER_MAX) : null;
}

function usageTokens(provenance: CaptureProvenance | undefined): Record<string, number | null> | null {
  if (!isRecord(provenance?.usage)) return null;
  const usage = provenance!.usage as Record<string, unknown>;
  return { input: finiteOrNull(usage.input), output: finiteOrNull(usage.output) };
}

export async function buildInteractionRecord(event: CaptureEvent): Promise<InteractionRow> {
  const body = isRecord(event.body) ? event.body : {};
  const provenance = provenanceOf(event);
  const laneRaw = provenance?.lane;
  const lane = typeof laneRaw === "string" && ["abstain", "fast", "agentic"].includes(laneRaw) ? laneRaw : null;
  const executed = executedFilters(provenance);
  const metrics = Array.isArray(executed.metrics) ? executed.metrics as string[] : [];
  const question = redactSecrets(body.question);
  const questionText = question.text || "(empty question)";
  const filters = boundedFilters((isRecord(body.page) ? body.page : {}).filters);
  const conversationId = boundedText(body.conversationId, 64);
  const now = event.now ?? new Date();
  const errorPath = event.status === "error" || event.status === "unknown";
  // Reuse only the caller-provided attempt identity; never hash semantics, so
  // repeated genuine errors stay distinct events.
  const requestId = event.requestId && event.requestId.trim() ? event.requestId.trim() : `err-${crypto.randomUUID()}`;

  const knownUsage: Record<string, unknown> = {
    answered: event.status === "success",
    lane,
    queryCount: metrics.length,
    modelCalls: finiteOrNull(provenance?.modelCalls),
    tokens: usageTokens(provenance),
    elapsedMs: finiteOrNull(provenance?.elapsedMs),
    cacheHits: finiteOrNull(provenance?.cacheHits),
  };
  const unknownUsage: Record<string, unknown> = {
    abstained: lane === "abstain" || event.status === "abstained",
    errored: event.status === "error",
    unresolved: event.status !== "success",
    reason: event.responseCode ?? null,
  };

  return {
    tenant: CAPTURE_TENANT,
    request_id: requestId,
    actor_id: event.identity.userId,
    conversation_id: conversationId,
    source_route: boundedText((isRecord(body.page) ? body.page : {}).route, 200),
    source_label: boundedText((isRecord(body.page) ? body.page : {}).label, 100),
    question_text: questionText,
    answer_text: answerText(event),
    redaction_applied: question.redacted,
    context_summary: minimizeContext(event.body),
    understood_intent: {
      lane,
      metrics,
      queryCount: metrics.length,
      semanticVersion: boundedText(provenance?.semanticVersion, 60),
    },
    page_filters: filters,
    executed_filters: executed,
    tool: metrics.length ? metrics.join("+") : null,
    provenance: sanitizedObject({
      semanticVersion: boundedText(provenance?.semanticVersion, 60),
      citations: provenance?.citations ?? null,
      evidence: provenance?.evidence ?? null,
      queryCount: metrics.length,
      metrics,
      executedFilters: executed,
      elapsedMs: finiteOrNull(provenance?.elapsedMs),
      cacheHits: finiteOrNull(provenance?.cacheHits),
      modelCalls: finiteOrNull(provenance?.modelCalls),
    }),
    response_status: event.status,
    response_code: boundedText(event.responseCode, 80),
    known_usage: knownUsage,
    unknown_usage: unknownUsage,
    model_route: boundedText(provenance?.model, 80) ?? lane,
    capture_status: errorPath ? "partial" : question.redacted ? "redacted" : "captured",
    retention_expires_at: new Date(now.getTime() + RETENTION_DAYS * 86_400_000).toISOString(),
  };
}

/** Extract REAL JevTelemetry when the reviewed lane provided it. Never stores prompts or keys. */
export function buildJevRow(event: CaptureEvent): JevRow | null {
  const jev = provenanceOf(event).jev;
  if (!isRecord(jev)) return null;
  const usage = isRecord(jev.usage) ? jev.usage : {};
  const timings = isRecord(jev.timings) ? jev.timings : {};
  const counts = isRecord(jev.counts) ? jev.counts : {};
  return {
    tenant: CAPTURE_TENANT,
    request_id: event.requestId,
    model: boundedText(jev.model, 80),
    prompt_version: boundedText(jev.promptVersion, 60),
    registry_version: boundedText(jev.registryVersion, 60),
    attempted: jev.attempted === true,
    decided: jev.decided === true,
    screen: boundedText(jev.screen, 120),
    circuit: boundedText(jev.circuit, 120),
    metric: boundedText(jev.metric, 80),
    metric_probability: finiteOrNull(jev.metricProbability),
    period: boundedText(jev.period, 80),
    period_probability: finiteOrNull(jev.periodProbability),
    support: boundedText(jev.support, 80),
    support_probability: finiteOrNull(jev.supportProbability),
    threshold: finiteOrNull(jev.threshold),
    fallback: boundedText(jev.fallback, 120),
    cost: finiteOrNull(jev.cost),
    token_counts: { input: finiteOrNull(usage.input), output: finiteOrNull(usage.output) },
    stage_timings: sanitizedObject(timings),
    counts: sanitizedObject(counts),
    decision: boundedText(jev.metric, 80) ?? "jev",
  };
}
