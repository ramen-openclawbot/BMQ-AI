// Shared Jev client for every BMQ Jev feature.
//
// A converted client hands this module the exact AI Gateway /v1/evaluate request
// body it always built. The adapter always sends that body straight to the Jev
// Gateway and returns its answer unchanged; there is no second provider, no
// request translation, no image forwarding and no fallback switch.
//
// Safety contract:
//   * no caller bearer token, database client, prompt text or raw record is read;
//   * parent cancellation is propagated and never converted into a provider error;
//   * every call carries one deadline and no retry;
//   * the gateway key is used only in the Authorization header and never logged.

export type DecisionsProvider = "typesafe";

export const DECISIONS_BODY_LIMIT = 32_000;
export const DECISIONS_DEFAULT_TIMEOUT_MS = 4_000;

export type DecisionsEnvGetter = (name: string) => string | undefined;

/**
 * One inline image from a caller. Kept for option-shape compatibility only: the
 * Jev Gateway request is always text-only, so this adapter never forwards images.
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
  /** Accepted for caller compatibility and deliberately ignored. */
  images?: DecisionsImage[];
  /** Accepted for caller compatibility; no provider switch is read. */
  env?: DecisionsEnvGetter;
  maxBodyBytes?: number;
}

export interface DecisionsOutcome {
  status: number;
  body: unknown;
  provider: DecisionsProvider;
  /** Always false: the Jev Gateway request never carries images. */
  images_used: boolean;
}

/** Transport failure while talking to the Jev Gateway (never a key). */
export class DecisionsError extends Error {
  constructor(public readonly code: string, public readonly status: number, public readonly detail: string | null = null) {
    super(code);
    this.name = "DecisionsError";
  }
}

export type DecisionsFailureCode = "jev_timeout" | "jev_invalid_response" | "jev_unavailable";

/** Map a transport failure to the stable Jev error code every BMQ client reports. */
export function decisionsFailureCode(error: unknown): DecisionsFailureCode {
  if (error instanceof DecisionsError) {
    if (error.code === "timeout") return "jev_timeout";
    if (error.code === "invalid_response") return "jev_invalid_response";
  }
  return "jev_unavailable";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
// Entry point
// ---------------------------------------------------------------------------

/** Evaluate one Gateway request body with exactly one Jev Gateway call. */
export async function evaluateDecisions(
  gatewayBody: unknown,
  opts: EvaluateDecisionsOptions,
): Promise<DecisionsOutcome> {
  if (!isRecord(gatewayBody)) throw new DecisionsError("invalid_response", 502, "gateway body must be an object");
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
    return { status: response.status, body: detail, provider: "typesafe", images_used: false };
  }
  const parsed = await readBoundedJson(response, combined, opts.signal, deadline, opts.maxBodyBytes ?? DECISIONS_BODY_LIMIT);
  return { status: response.status, body: parsed, provider: "typesafe", images_used: false };
}
