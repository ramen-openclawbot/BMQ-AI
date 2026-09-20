// Server-side synthetic-question generator over the DeepSeek official
// OpenAI-compatible chat-completions API.
//
// It follows the reviewed direct-provider conventions already used by the other
// server clients: direct HTTPS to the documented host, no SDK, `redirect: "error"`,
// a fixed endpoint/model, a bounded body and a bounded deadline. Only the
// dedicated server-side `DEEPSEEK_API_KEY` is used; the caller bearer token and
// the Jev/Vercel Gateway key are never read, forwarded or used as a fallback.
//
// DeepSeek returns no dollar cost, so the call cost is computed from the usage
// tokens it reports (cache-miss input + cache-hit input + output) at the reviewed
// prices. Unknown usage stays null, never a fabricated 0.
//
// The model output is strictly validated against the request before it is
// returned, so a malformed, short, duplicated or fabricated batch is refused
// instead of being partially accepted.

import { DataAdminError } from "./data-assets.ts";
import {
  GENERATION_BODY_LIMIT,
  GENERATION_MAX_TIMEOUT_MS,
  GENERATION_TIMEOUT_MS,
  serializeGenerationRequest,
  usageCostUpperBoundUsd,
  validateGenerationOutput,
  type GeneratedQuestion,
  type GenerationPrices,
  type GenerationRequest,
} from "./generation.ts";

// Official DeepSeek base URL is https://api.deepseek.com (OpenAI format); the
// chat-completions path is documented as POST /chat/completions.
export const GENERATION_ENDPOINT = "https://api.deepseek.com/chat/completions";

// A provider error body is read at most this far. Only status/code/param survive;
// the raw provider message (which can echo prompt content) is never surfaced,
// stored or logged.
export const GENERATION_ERROR_BODY_LIMIT = 16_384;
// A syntax pattern is not a value allowlist: unknown strings could contain secrets.
const PROVIDER_CODES = new Set([
  "invalid_request_error", "authentication_error", "authentication_fails",
  "invalid_api_key", "permission_denied", "insufficient_quota",
  "insufficient_balance_error", "rate_limit_error", "rate_limit_exceeded",
  "unsupported_parameter", "unsupported_value", "invalid_parameter_error",
  "invalid_json_schema", "model_not_found", "server_error", "internal_server_error",
  "service_unavailable", "context_length_exceeded",
]);
const PROVIDER_PARAMS = new Set([
  "model", "messages", "max_tokens", "max_completion_tokens", "temperature",
  "response_format", "response_format.type", "thinking", "thinking.type",
  "reasoning_effort", "stream", "stream_options",
]);

/** Sanitized, allowlisted provider diagnostic: never the raw error message. */
export interface GenerationProviderDiagnostic {
  /** Upstream HTTP status. */
  status: number;
  /** Allowlisted provider error code/type, else null. */
  code: string | null;
  /** Allowlisted offending parameter name, else null. */
  param: string | null;
}

/** A definitively failed provider call carrying only an allowlisted diagnostic. */
export class GenerationProviderError extends DataAdminError {
  readonly diagnostic: GenerationProviderDiagnostic;

  constructor(code: string, status: number, diagnostic: GenerationProviderDiagnostic) {
    super(code, status);
    this.name = "GenerationProviderError";
    this.diagnostic = diagnostic;
  }
}

export function providerDiagnosticOf(error: unknown): GenerationProviderDiagnostic | null {
  return error instanceof GenerationProviderError ? error.diagnostic : null;
}

function safeProviderToken(value: unknown, allowed: ReadonlySet<string>): string | null {
  return typeof value === "string" && allowed.has(value) ? value : null;
}

/**
 * Extract ONLY the allowlisted status/code/parameter from a provider error body.
 * OpenAI-shaped (`{ error: { code|type, param } }`) and flat bodies are both
 * accepted; anything else (including the human message) is dropped.
 */
export function sanitizeProviderDiagnostic(status: number, body: unknown): GenerationProviderDiagnostic {
  const root = isRecord(body) ? body : {};
  const error = isRecord(root.error) ? root.error : root;
  const code = safeProviderToken(error.code, PROVIDER_CODES) ?? safeProviderToken(error.type, PROVIDER_CODES);
  const param = safeProviderToken(error.param, PROVIDER_PARAMS);
  return { status: Number.isInteger(status) ? status : 0, code, param };
}

export const PROVIDER_FAILURE_CLASSIFICATIONS = ["insufficient_balance"] as const;
export type ProviderFailureClassification = (typeof PROVIDER_FAILURE_CLASSIFICATIONS)[number];

/**
 * Map a documented DeepSeek failure to a fixed code. Classification is by HTTP
 * STATUS only (DeepSeek's documented "402 – Insufficient Balance" rejection), never
 * by scanning the provider message tokens: a message scan could admit an
 * attacker-controlled or secret-like value as a "classification", and the raw
 * message is never returned, stored or logged anyway.
 */
export function classifyProviderFailure(status: number, _body?: unknown): ProviderFailureClassification | null {
  if (status !== 402) return null;
  return "insufficient_balance";
}

/** Read an error body without ever throwing; a missing/huge/non-JSON/aborted body yields null. */
async function readBoundedErrorJson(response: Response, limit: number, signal: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  let onAbort: (() => void) | undefined;
  // Respect the caller's combined request/deadline signal, so a stalled error body
  // can never outlive the bounded call.
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException("provider error body aborted", "AbortError"));
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    while (true) {
      const read = reader.read();
      read.catch(() => undefined);
      const part = await Promise.race([read, aborted]);
      if (part.done) break;
      size += part.value.length;
      if (size > limit) { void reader.cancel().catch(() => undefined); return null; }
      chunks.push(part.value);
    }
  } catch {
    void reader.cancel().catch(() => undefined);
    return null;
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch { /* outstanding read handled by cancel() */ }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
}

export interface GenerationOutcome {
  items: GeneratedQuestion[];
  /** Provider token usage; null means the provider did not report it (never 0). */
  usage: { input: number | null; output: number | null };
  /**
   * DeepSeek reports no dollar cost, so the ACTUAL billed cost is always unknown
   * here and stays null. It is never derived/fabricated from tokens.
   */
  cost: number | null;
  /**
   * Conservative peak-rate UPPER BOUND on the reported usage (not the billed cost).
   * Kept separate from `cost`; null when usage or prices are unknown.
   */
  usageCostUpperBoundUsd: number | null;
  model: string;
}

export type GenerationClient = (request: GenerationRequest, signal: AbortSignal) => Promise<GenerationOutcome>;

export interface GenerationClientConfig {
  apiKey: string;
  model: string;
  /** Reviewed prices used to price reported usage; null keeps the cost honestly unknown. */
  prices?: GenerationPrices | null;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNonNegative(value: unknown): number | null {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function readBoundedBody(response: Response, combined: AbortSignal, parent: AbortSignal, deadline: AbortSignal): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new DataAdminError("generation_invalid_response", 502);
  const cancel = () => { try { void reader.cancel().catch(() => undefined); } catch { /* already released */ } };
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException("generation request aborted", "AbortError"));
    if (combined.aborted) onAbort();
    else combined.addEventListener("abort", onAbort, { once: true });
  });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const read = reader.read();
      read.catch(() => undefined);
      const part = await Promise.race([read, aborted]);
      if (part.done) break;
      size += part.value.length;
      if (size > GENERATION_BODY_LIMIT) { cancel(); throw new DataAdminError("generation_invalid_response", 502); }
      chunks.push(part.value);
    }
  } catch (error) {
    cancel();
    if (parent.aborted) throw error;
    if (deadline.aborted) throw new DataAdminError("generation_timeout", 504);
    if (error instanceof DataAdminError) throw error;
    throw new DataAdminError("generation_unavailable", 503);
  } finally {
    if (onAbort) combined.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch { /* outstanding read handled by cancel() */ }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new DataAdminError("generation_invalid_response", 502); }
}

/** One bounded DeepSeek call; the caller decides the budget before invoking it. */
export function createGenerationClient(config: GenerationClientConfig): GenerationClient {
  const apiKey = config.apiKey ?? "";
  if (!apiKey) throw new DataAdminError("generation_unconfigured", 503);
  if (!config.model) throw new DataAdminError("generation_unconfigured", 503);
  const fetcher = config.fetcher ?? fetch;
  const prices = config.prices ?? null;
  const timeoutMs = Math.max(1, Math.min(config.timeoutMs ?? GENERATION_TIMEOUT_MS, GENERATION_MAX_TIMEOUT_MS));

  return async (request, signal) => {
    signal.throwIfAborted();
    // The exact body (and therefore the measured input bound) is shared with the
    // handler's cost guard: the payload that is priced is the payload that is sent.
    const body = serializeGenerationRequest(request, config.model);

    const deadline = AbortSignal.timeout(timeoutMs);
    const combined = AbortSignal.any([signal, deadline]);
    let response: Response;
    try {
      response = await fetcher(GENERATION_ENDPOINT, {
        method: "POST",
        redirect: "error",
        signal: combined,
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new DataAdminError(deadline.aborted ? "generation_timeout" : "generation_unavailable", deadline.aborted ? 504 : 503);
    }
    if (!response.ok) {
      // Read the bounded error body (respecting the combined deadline/abort signal)
      // and keep ONLY the allowlisted diagnostic plus a fixed status-based
      // classification. The raw provider message is discarded so no prompt/token/key
      // can leak into the durable job record, the audit log or the HTTP response.
      const providerStatus = response.status;
      const errorBody = await readBoundedErrorJson(response, GENERATION_ERROR_BODY_LIMIT, combined);
      const diagnostic = sanitizeProviderDiagnostic(providerStatus, errorBody);
      const classification = classifyProviderFailure(providerStatus, errorBody);
      const errorCode = classification === "insufficient_balance"
        ? "generation_insufficient_balance"
        : providerStatus === 429 ? "generation_rate_limited" : "generation_http_error";
      throw new GenerationProviderError(errorCode, providerStatus === 429 ? 503 : 502, diagnostic);
    }
    const parsed = await readBoundedBody(response, combined, signal, deadline);
    if (!isRecord(parsed)) throw new DataAdminError("generation_invalid_response", 502);
    const choices = parsed.choices;
    const choice = Array.isArray(choices) && isRecord(choices[0]) ? choices[0] : null;
    const content = choice && isRecord(choice.message) ? choice.message.content : null;
    if (typeof content !== "string" || content.length > GENERATION_BODY_LIMIT) throw new DataAdminError("generation_invalid_response", 502);
    // A truncated JSON body ("length") can never satisfy the exact batch contract,
    // so it fails closed here instead of producing a confusing parse error.
    if (choice?.finish_reason === "length") throw new DataAdminError("generation_invalid_response", 502);
    let decoded: unknown;
    try { decoded = JSON.parse(content); } catch { throw new DataAdminError("generation_invalid_response", 502); }
    const items = validateGenerationOutput(decoded, request);
    const usage = isRecord(parsed.usage) ? parsed.usage : {};
    const input = finiteNonNegative(usage.prompt_tokens);
    const output = finiteNonNegative(usage.completion_tokens);
    const cachedInput = finiteNonNegative(usage.prompt_cache_hit_tokens);
    return {
      items,
      usage: { input, output },
      // DeepSeek returns no dollar cost: the billed cost stays genuinely unknown.
      cost: null,
      usageCostUpperBoundUsd: usageCostUpperBoundUsd({ inputTokens: input, cachedInputTokens: cachedInput, outputTokens: output }, prices),
      model: config.model,
    };
  };
}
