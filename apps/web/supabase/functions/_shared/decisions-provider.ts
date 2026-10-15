// Shared provider adapter for every BMQ Jev client.
//
// A converted client hands this module the exact AI Gateway /v1/evaluate request
// body it always built. The adapter decides from the server environment whether
// that request is served by the OpenAI Decisions API (default) or by the existing
// TypeSafe Jev Gateway call, and it falls back to the exact original Gateway call
// on any OpenAI failure.
//
// Safety contract:
//   * the adapter only reads keys through an injectable env getter and never logs,
//     echoes or persists a key (the OpenAI key is used in one Authorization header);
//   * no caller bearer token, database client, prompt text or raw record is read;
//   * parent cancellation is never converted into a fallback;
//   * every provider call carries one deadline and no retry.
//
// Request translation (Gateway -> Decisions):
//   state (string or JSON)                              -> input
//   {type:"boolean", instructions, criteria}            -> {type:"predicate", name, instructions + criteria}
//   {type:"choice", instructions, criteria}             -> {type:"choice", name, instructions, choices}
//
// Response translation (Decisions -> Gateway shape the existing validators accept):
//   predicate -> {type:"boolean", probability, confidence?}
//   choice    -> {type:"choice", choice, probabilities: {option: p}, confidence?}
//   and body.model is restored to the original JEV_MODEL plus a `usage` block.

export type DecisionsProvider = "openai" | "typesafe" | "fallback";

export const OPENAI_DECISIONS_ENDPOINT = "https://api.openai.com/v1/decisions";
export const OPENAI_DECISIONS_DEFAULT_MODEL = "gpt-6-luna";
export const DECISIONS_BODY_LIMIT = 32_000;
export const DECISIONS_DEFAULT_TIMEOUT_MS = 4_000;

export type DecisionsEnvGetter = (name: string) => string | undefined;

/**
 * One inline image for the OpenAI Decisions path. Only base64 payloads are
 * supported: hosted URLs are never fetched by the provider adapter.
 */
export interface DecisionsImage {
  mime: string;
  base64: string;
}

export interface EvaluateDecisionsOptions {
  fetcher: typeof fetch;
  gatewayUrl: string;
  gatewayKey: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Optional inline images; only the OpenAI path forwards them. */
  images?: DecisionsImage[];
  /** Injectable environment reader so node tests never touch global Deno state. */
  env?: DecisionsEnvGetter;
  maxBodyBytes?: number;
}

export interface DecisionsOutcome {
  status: number;
  body: unknown;
  provider: DecisionsProvider;
  /** True only when the OpenAI answer that was used was asked with images. */
  images_used: boolean;
  /** Short failure code when the OpenAI attempt failed and Jev was used instead. */
  openaiError?: string;
}

/** Transport failure while talking to the selected provider (never a key). */
export class DecisionsError extends Error {
  constructor(public readonly code: string, public readonly status: number, public readonly detail: string | null = null) {
    super(code);
    this.name = "DecisionsError";
  }
}

export type DecisionsFailureCode = "jev_timeout" | "jev_invalid_response" | "jev_unavailable";

/**
 * Map a transport failure from the selected provider to the stable Jev error
 * code every BMQ client already reports. OpenAI-specific codes never reach here:
 * `evaluateDecisions` converts every OpenAI failure into a Jev fallback.
 */
export function decisionsFailureCode(error: unknown): DecisionsFailureCode {
  if (error instanceof DecisionsError) {
    if (error.code === "timeout") return "jev_timeout";
    if (error.code === "invalid_response") return "jev_invalid_response";
  }
  return "jev_unavailable";
}

function defaultEnv(name: string): string | undefined {
  const deno = (globalThis as {
    Deno?: { env?: { get?: (key: string) => string | undefined } };
  }).Deno;
  try {
    return deno?.env?.get?.(name);
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteUnit(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

// ---------------------------------------------------------------------------
// Request translation
// ---------------------------------------------------------------------------

function questionsOf(gatewayBody: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const questions = gatewayBody.questions;
  if (!isRecord(questions)) return {};
  const result: Record<string, Record<string, unknown>> = {};
  for (const [name, question] of Object.entries(questions)) {
    if (isRecord(question)) result[name] = question;
  }
  return result;
}

/** Render one Gateway criteria record (option -> description) as readable lines. */
function renderCriteria(criteria: unknown): string {
  if (typeof criteria === "string") return criteria;
  if (!isRecord(criteria)) return "";
  return Object.entries(criteria).map(([key, value]) => `- ${key}: ${String(value)}`).join("\n");
}

function predicateInstructions(instructions: unknown, criteria: unknown): string {
  const base = typeof instructions === "string" ? instructions : "";
  const rendered = renderCriteria(criteria);
  return rendered ? `${base}\n\nCriteria:\n${rendered}` : base;
}

/** Gateway request body -> OpenAI Decisions request body. */
export function translateDecisionsRequest(
  gatewayBody: Record<string, unknown>,
  model = OPENAI_DECISIONS_DEFAULT_MODEL,
  images: readonly DecisionsImage[] = [],
) {
  const state = gatewayBody.state;
  let input: string;
  if (typeof state === "string") {
    input = state;
  } else {
    const serialized = JSON.stringify(state);
    input = serialized === undefined ? "null" : serialized;
  }
  const questions: unknown[] = [];
  for (const [name, question] of Object.entries(questionsOf(gatewayBody))) {
    if (question.type === "boolean") {
      questions.push({ type: "predicate", name, instructions: predicateInstructions(question.instructions, question.criteria) });
    } else if (question.type === "choice") {
      const criteria = isRecord(question.criteria) ? question.criteria : {};
      questions.push({
        type: "choice",
        name,
        instructions: typeof question.instructions === "string" ? question.instructions : "",
        choices: Object.entries(criteria).map(([value, description]) => ({ value, description: String(description) })),
      });
    } else {
      throw new DecisionsError("openai_unsupported_question", 502, name);
    }
  }
  // With images, the Decisions input becomes a single user message carrying the
  // text plus one inline base64 data URL per image. Hosted URLs are not accepted.
  const multimodal = images.length > 0;
  const requestInput = multimodal
    ? [{
      role: "user",
      content: [
        { type: "input_text", text: input },
        ...images.map((image) => ({
          type: "input_image",
          image_url: `data:${image.mime};base64,${image.base64}`,
        })),
      ],
    }]
    : input;
  return { model, input: requestInput, questions };
}

// ---------------------------------------------------------------------------
// Response translation
// ---------------------------------------------------------------------------

function normalizedUsage(openaiBody: Record<string, unknown>): { inputTokens: number; outputTokens: number } {
  const usage = isRecord(openaiBody.usage) ? openaiBody.usage : {};
  return {
    inputTokens: finiteNonNegative(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens),
    outputTokens: finiteNonNegative(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens),
  };
}

function readQuantities(answer: Record<string, unknown>, offered: readonly string[]): { probabilities: Record<string, number>; seen: Set<string> } {
  const probabilities: Record<string, number> = {};
  for (const option of offered) probabilities[option] = 0;
  const seen = new Set<string>();
  const raw = answer.probabilities;
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!isRecord(entry) || typeof entry.value !== "string" || !offered.includes(entry.value)) continue;
      if (!finiteUnit(entry.probability)) throw new DecisionsError("openai_invalid_response", 502);
      probabilities[entry.value] = entry.probability;
      seen.add(entry.value);
    }
    return { probabilities, seen };
  }
  if (isRecord(raw)) {
    for (const [value, probability] of Object.entries(raw)) {
      if (!offered.includes(value)) continue;
      if (!finiteUnit(probability)) throw new DecisionsError("openai_invalid_response", 502);
      probabilities[value] = probability;
      seen.add(value);
    }
    return { probabilities, seen };
  }
  throw new DecisionsError("openai_invalid_response", 502);
}

/**
 * OpenAI Decisions response -> the exact body shape the existing client
 * validators accept. Any refusal, missing answer, out-of-list choice or
 * distribution that would fail those strict validators is reported as an OpenAI
 * failure so the caller can fall back to Jev.
 */
export function translateDecisionsResponse(gatewayBody: Record<string, unknown>, openaiBody: unknown): Record<string, unknown> {
  if (!isRecord(openaiBody)) throw new DecisionsError("openai_invalid_response", 502);
  if (!Array.isArray(openaiBody.answers)) throw new DecisionsError("openai_invalid_response", 502);
  const byName = new Map<string, Record<string, unknown>>();
  for (const raw of openaiBody.answers) {
    if (!isRecord(raw)) throw new DecisionsError("openai_invalid_response", 502);
    if (typeof raw.name === "string") byName.set(raw.name, raw);
  }
  const answers: Record<string, unknown> = {};
  for (const [name, question] of Object.entries(questionsOf(gatewayBody))) {
    const answer = byName.get(name);
    if (!answer) throw new DecisionsError("openai_missing_answer", 502, name);
    if (answer.type === "refusal") throw new DecisionsError("openai_refusal", 502, name);
    if (question.type === "boolean") {
      if (answer.type !== "predicate" || !finiteUnit(answer.probability)) {
        throw new DecisionsError("openai_invalid_response", 502, name);
      }
      const translated: Record<string, unknown> = { type: "boolean", probability: answer.probability };
      if (finiteUnit(answer.confidence)) translated.confidence = answer.confidence;
      answers[name] = translated;
      continue;
    }
    if (answer.type !== "choice") throw new DecisionsError("openai_invalid_response", 502, name);
    const criteria = isRecord(question.criteria) ? question.criteria : {};
    const offered = Object.keys(criteria);
    if (offered.length === 0) throw new DecisionsError("openai_invalid_response", 502, name);
    const choice = answer.choice;
    if (typeof choice !== "string" || !offered.includes(choice)) throw new DecisionsError("openai_choice_out_of_list", 502, name);
    const { probabilities, seen } = readQuantities(answer, offered);
    if (!seen.has(choice)) throw new DecisionsError("openai_missing_answer", 502, name);
    const chosenProbability = probabilities[choice];
    let sum = 0;
    for (const option of offered) sum += probabilities[option];
    if (Math.abs(sum - 1) > 0.02) throw new DecisionsError("openai_invalid_response", 502, name);
    if (offered.some((option) => option !== choice && probabilities[option] >= chosenProbability)) {
      throw new DecisionsError("openai_invalid_response", 502, name);
    }
    const translated: Record<string, unknown> = { type: "choice", choice, probabilities };
    if (finiteUnit(answer.confidence)) translated.confidence = answer.confidence;
    answers[name] = translated;
  }
  return {
    model: typeof gatewayBody.model === "string" ? gatewayBody.model : OPENAI_DECISIONS_DEFAULT_MODEL,
    answers,
    usage: normalizedUsage(openaiBody),
  };
}

// ---------------------------------------------------------------------------
// Bounded response reading (timeout covers a stalled body)
// ---------------------------------------------------------------------------

async function readBoundedJson(
  response: Response,
  combined: AbortSignal,
  parent: AbortSignal | undefined,
  deadline: AbortSignal,
  maxBytes: number,
): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new DecisionsError("invalid_response", 502);
  // Cancellation is cleanup only and is never awaited.
  const cancel = () => { try { void reader.cancel().catch(() => undefined); } catch { /* already released */ } };
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new DOMException("Decisions request aborted", "AbortError"));
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
      if (size > maxBytes) { cancel(); throw new DecisionsError("invalid_response", 502); }
      chunks.push(part.value);
    }
  } catch (error) {
    cancel();
    if (parent?.aborted) throw error;
    if (deadline.aborted) throw new DecisionsError("timeout", 504);
    if (error instanceof DecisionsError) throw error;
    throw new DecisionsError("unavailable", 503);
  } finally {
    if (onAbort) combined.removeEventListener("abort", onAbort);
    try { reader.releaseLock(); } catch { /* outstanding read handled by cancel() */ }
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new DecisionsError("invalid_response", 502);
  }
}

function withDeadline(timeoutMs: number, signal?: AbortSignal) {
  const deadline = AbortSignal.timeout(Math.max(1, timeoutMs));
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  return { deadline, combined };
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

async function callOpenAI(
  gatewayBody: Record<string, unknown>,
  opts: EvaluateDecisionsOptions,
  openaiKey: string,
  model: string,
): Promise<{ body: Record<string, unknown>; imagesUsed: boolean }> {
  const images = opts.images ?? [];
  const request = translateDecisionsRequest(gatewayBody, model, images);
  const { deadline, combined } = withDeadline(opts.timeoutMs ?? DECISIONS_DEFAULT_TIMEOUT_MS, opts.signal);
  let response: Response;
  try {
    response = await opts.fetcher(OPENAI_DECISIONS_ENDPOINT, {
      method: "POST",
      redirect: "error",
      signal: combined,
      headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
  } catch (error) {
    if (opts.signal?.aborted) throw error;
    throw new DecisionsError(deadline.aborted ? "openai_timeout" : "openai_unavailable", deadline.aborted ? 504 : 503);
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw new DecisionsError(`openai_http_${response.status}`, response.status);
  }
  let parsed: unknown;
  try {
    parsed = await readBoundedJson(response, combined, opts.signal, deadline, opts.maxBodyBytes ?? DECISIONS_BODY_LIMIT);
  } catch (error) {
    if (opts.signal?.aborted) throw error;
    if (error instanceof DecisionsError) {
      if (error.code === "timeout") throw new DecisionsError("openai_timeout", 504);
      if (error.code === "invalid_response") throw new DecisionsError("openai_invalid_response", 502);
      throw new DecisionsError("openai_unavailable", 503);
    }
    throw new DecisionsError("openai_invalid_response", 502);
  }
  return { body: translateDecisionsResponse(gatewayBody, parsed), imagesUsed: images.length > 0 };
}

async function callGateway(
  gatewayBody: Record<string, unknown>,
  opts: EvaluateDecisionsOptions,
  provider: DecisionsProvider,
  openaiError: string | undefined,
): Promise<DecisionsOutcome> {
  const { deadline, combined } = withDeadline(opts.timeoutMs ?? DECISIONS_DEFAULT_TIMEOUT_MS, opts.signal);
  let response: Response;
  try {
    response = await opts.fetcher(opts.gatewayUrl, {
      method: "POST",
      redirect: "error",
      signal: combined,
      headers: { Authorization: `Bearer ${opts.gatewayKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(gatewayBody),
    });
  } catch (error) {
    if (opts.signal?.aborted) throw error;
    throw new DecisionsError(deadline.aborted ? "timeout" : "unavailable", deadline.aborted ? 504 : 503);
  }
  if (!response.ok) {
    let detail: string | null = null;
    try {
      detail = (await response.text()).replace(/\s+/g, " ").slice(0, 300);
    } catch {
      detail = null;
    }
    return { status: response.status, body: detail, provider, images_used: false, openaiError };
  }
  const parsed = await readBoundedJson(response, combined, opts.signal, deadline, opts.maxBodyBytes ?? DECISIONS_BODY_LIMIT);
  return { status: response.status, body: parsed, provider, images_used: false, openaiError };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Evaluate one Gateway request body with the OpenAI Decisions API and fall back
 * to the original Jev Gateway call on any OpenAI failure.
 */
export async function evaluateDecisions(
  gatewayBody: unknown,
  opts: EvaluateDecisionsOptions,
): Promise<DecisionsOutcome> {
  if (!isRecord(gatewayBody)) throw new DecisionsError("invalid_response", 502, "gateway body must be an object");
  const env = opts.env ?? defaultEnv;
  const providerMode = String(env("DECISIONS_PROVIDER") ?? "openai").trim().toLowerCase();
  const openaiKey = String(env("OPENAI_API_KEY") ?? "").trim();
  const model = String(env("OPENAI_DECISIONS_MODEL") ?? "").trim() || OPENAI_DECISIONS_DEFAULT_MODEL;

  if (providerMode === "typesafe" || !openaiKey) {
    return await callGateway(gatewayBody, opts, "typesafe", undefined);
  }

  let openaiError: string | undefined;
  try {
    const body = await callOpenAI(gatewayBody, opts, openaiKey, model);
    return { status: 200, body: body.body, provider: "openai", images_used: body.imagesUsed };
  } catch (error) {
    if (opts.signal?.aborted) throw error;
    openaiError = error instanceof DecisionsError ? error.code : "openai_unavailable";
  }
  return await callGateway(gatewayBody, opts, "fallback", openaiError);
}
