// Server-side synthetic-question generator over the Vercel AI Gateway.
//
// It follows the reviewed Gateway conventions already used by the Jev client:
// direct HTTPS, no SDK, `redirect: "error"`, a fixed endpoint/model, per-request
// `providerOptions.gateway.zeroDataRetention: true` (preserve ZDR), a bounded body
// and a bounded deadline. Only the dedicated server-side `AI_GATEWAY_API_KEY` is
// used; the caller bearer token is never read or forwarded.
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
  validateGenerationOutput,
  type GeneratedQuestion,
  type GenerationRequest,
} from "./generation.ts";

export const GENERATION_ENDPOINT = "https://ai-gateway.vercel.sh/v1/chat/completions";

// A provider error body is read at most this far. Only status/code/param survive;
// the raw provider message (which can echo prompt content) is never surfaced,
// stored or logged.
export const GENERATION_ERROR_BODY_LIMIT = 16_384;
// A syntax pattern is not a value allowlist: unknown strings could contain secrets.
const PROVIDER_CODES = new Set([
  "invalid_request_error", "authentication_error", "invalid_api_key",
  "permission_denied", "insufficient_quota", "rate_limit_error", "rate_limit_exceeded",
  "unsupported_parameter", "unsupported_value", "invalid_json_schema", "model_not_found",
  "server_error", "internal_server_error", "service_unavailable", "context_length_exceeded",
]);
const PROVIDER_PARAMS = new Set([
  "model", "messages", "max_tokens", "max_completion_tokens", "temperature",
  "response_format", "response_format.json_schema", "response_format.json_schema.schema",
  "stream", "providerOptions", "providerOptions.gateway.zeroDataRetention",
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

/**
 * Fixed, reviewed provider sentences mapped to non-sensitive codes. Matching is
 * an EXACT normalized sentence, deliberately NOT a loose token/regex scan: a
 * regex over message words could admit a secret-like or attacker-controlled value
 * as a "classification". The raw message itself is never returned or stored.
 */
const PROVIDER_PAID_CREDITS_SENTENCE = "free tier users do not have access to this model.";
export const PROVIDER_FAILURE_CLASSIFICATIONS = ["paid_credits_required"] as const;
export type ProviderFailureClassification = (typeof PROVIDER_FAILURE_CLASSIFICATIONS)[number];

function normalizedProviderMessage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.replace(/\s+/g, " ").trim().toLowerCase();
  return text.length > 0 && text.length <= 512 ? text : null;
}

/** Map a known provider failure to a fixed code; unknown failures return null (generic). */
export function classifyProviderFailure(status: number, body: unknown): ProviderFailureClassification | null {
  if (status !== 403) return null;
  const root = isRecord(body) ? body : {};
  const error = isRecord(root.error) ? root.error : root;
  const message = normalizedProviderMessage(error.message);
  if (message && message.includes(PROVIDER_PAID_CREDITS_SENTENCE)) return "paid_credits_required";
  return null;
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
  /** Gateway-reported cost in USD when supplied, else null (never fabricated 0). */
  cost: number | null;
  model: string;
}

export type GenerationClient = (request: GenerationRequest, signal: AbortSignal) => Promise<GenerationOutcome>;

export interface GenerationClientConfig {
  apiKey: string;
  model: string;
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

/** Gateway-reported cost (providerMetadata.gateway.cost or usage.cost). */
export function generationGatewayCost(body: unknown): number | null {
  if (!isRecord(body)) return null;
  const metadata = isRecord(body.providerMetadata) ? body.providerMetadata : null;
  const gateway = metadata && isRecord(metadata.gateway) ? metadata.gateway : null;
  const fromGateway = gateway ? finiteNonNegative(gateway.cost) : null;
  if (fromGateway !== null) return fromGateway;
  const usage = isRecord(body.usage) ? body.usage : null;
  return usage ? finiteNonNegative(usage.cost) : null;
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

/** One bounded Gateway call; the caller decides the budget before invoking it. */
export function createGenerationClient(config: GenerationClientConfig): GenerationClient {
  const apiKey = config.apiKey ?? "";
  if (!apiKey) throw new DataAdminError("generation_unconfigured", 503);
  if (!config.model) throw new DataAdminError("generation_unconfigured", 503);
  const fetcher = config.fetcher ?? fetch;
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
      // and keep ONLY the allowlisted diagnostic plus a fixed classification. The raw
      // provider message is discarded so no prompt/token/key can leak into the durable
      // job record, the audit log or the HTTP response.
      const providerStatus = response.status;
      const errorBody = await readBoundedErrorJson(response, GENERATION_ERROR_BODY_LIMIT, combined);
      const diagnostic = sanitizeProviderDiagnostic(providerStatus, errorBody);
      const classification = classifyProviderFailure(providerStatus, errorBody);
      const errorCode = classification === "paid_credits_required"
        ? "generation_paid_credits_required"
        : providerStatus === 429 ? "generation_rate_limited" : "generation_http_error";
      throw new GenerationProviderError(errorCode, providerStatus === 429 ? 503 : 502, diagnostic);
    }
    const parsed = await readBoundedBody(response, combined, signal, deadline);
    if (!isRecord(parsed)) throw new DataAdminError("generation_invalid_response", 502);
    const choices = parsed.choices;
    const content = Array.isArray(choices) && isRecord(choices[0]) && isRecord(choices[0].message) ? choices[0].message.content : null;
    if (typeof content !== "string" || content.length > GENERATION_BODY_LIMIT) throw new DataAdminError("generation_invalid_response", 502);
    let decoded: unknown;
    try { decoded = JSON.parse(content); } catch { throw new DataAdminError("generation_invalid_response", 502); }
    const items = validateGenerationOutput(decoded, request);
    const usage = isRecord(parsed.usage) ? parsed.usage : {};
    return {
      items,
      usage: { input: finiteNonNegative(usage.prompt_tokens), output: finiteNonNegative(usage.completion_tokens) },
      cost: generationGatewayCost(parsed),
      model: config.model,
    };
  };
}
