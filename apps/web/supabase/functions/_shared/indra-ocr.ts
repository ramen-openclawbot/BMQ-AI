/**
 * Client for the owner's local Indra OCR service.
 *
 * The service is only used when the secret SCAN_OCR_ENGINE is exactly "indra"
 * (trimmed/lowercased). Every other value keeps today's DeepSeek image path.
 * The service URL must be https; http is accepted only for 127.0.0.1/localhost
 * so a developer can run it locally without TLS.
 *
 * Errors never include the bearer token or OCR text in their message.
 */

export type ScanOcrEngine = "indra" | "deepseek";

export type IndraOcrEnvGetter = (name: string) => string | undefined;

export interface IndraOcrConfig {
  engine: ScanOcrEngine;
  /** Normalized base URL without a trailing slash; empty when not configured/invalid. */
  url: string;
  token: string;
  timeoutMs: number;
}

export const INDRA_OCR_DEFAULT_TIMEOUT_MS = 12_000;
export const INDRA_OCR_MIN_TIMEOUT_MS = 2_000;
export const INDRA_OCR_MAX_TIMEOUT_MS = 30_000;

export const INDRA_OCR_QUALITY_MIN_LINES = 3;
export const INDRA_OCR_QUALITY_MIN_CHARS = 20;
export const INDRA_OCR_QUALITY_MIN_CONF = 0.5;

/** Same safe env pattern as ai-vision-provider.ts (deno test has no env access). */
function readDenoEnv(name: string): string | undefined {
  try {
    return Deno.env.get(name);
  } catch {
    return undefined;
  }
}

function normalizedUrl(raw: string): string {
  const value = String(raw ?? "").trim().replace(/\/+$/, "");
  if (!value) return "";
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return "";
  }
  const isHttps = parsed.protocol === "https:";
  const isLocalHttp = parsed.protocol === "http:"
    && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
  if (!isHttps && !isLocalHttp) return "";
  return value;
}

/** Parse SCAN_OCR_ENGINE / INDRA_OCR_URL / INDRA_OCR_TOKEN / INDRA_OCR_TIMEOUT_MS. */
export function readIndraOcrConfig(env?: IndraOcrEnvGetter): IndraOcrConfig {
  const read = env ?? readDenoEnv;

  const rawEngine = String(read("SCAN_OCR_ENGINE") ?? "").trim().toLowerCase();
  const engine: ScanOcrEngine = rawEngine === "indra" ? "indra" : "deepseek";

  const url = normalizedUrl(String(read("INDRA_OCR_URL") ?? ""));
  const token = String(read("INDRA_OCR_TOKEN") ?? "").trim();

  const rawTimeout = Number(String(read("INDRA_OCR_TIMEOUT_MS") ?? "").trim());
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0
    ? Math.min(INDRA_OCR_MAX_TIMEOUT_MS, Math.max(INDRA_OCR_MIN_TIMEOUT_MS, Math.round(rawTimeout)))
    : INDRA_OCR_DEFAULT_TIMEOUT_MS;

  return { engine, url, token, timeoutMs };
}

export type IndraOcrErrorCode =
  | "disabled"
  | "not_configured"
  | "timeout"
  | `http_${number}`
  | "bad_response"
  | "empty_text"
  | "low_quality";

export class IndraOcrError extends Error {
  readonly code: IndraOcrErrorCode;

  constructor(code: IndraOcrErrorCode) {
    // The code alone is safe: no token, headers or document text.
    super(code);
    this.name = "IndraOcrError";
    this.code = code;
  }
}

export interface IndraOcrLine {
  box: number[] | null;
  text: string;
  conf: number | null;
}

export interface IndraOcrPage {
  rotation: number | null;
  skew: number | null;
  source: string | null;
  text: string;
  markdown: string;
  lineCount: number;
  meanConf: number | null;
  lines: IndraOcrLine[];
  width: number | null;
  height: number | null;
  timings: unknown;
}

export interface IndraOcrResult {
  text: string;
  markdown: string;
  rotation: number | null;
  lineCount: number;
  meanConf: number | null;
  ms: number;
  pages: IndraOcrPage[];
}

export interface CallIndraOcrOptions {
  /** Raw base64 (data URL prefix tolerated) or bytes; exactly one is required. */
  base64?: string;
  bytes?: Uint8Array;
  mimeType: string;
  config: IndraOcrConfig;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function toBox(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const numbers = value.slice(0, 4).map((item) => toNumber(item));
  return numbers.length === 4 && numbers.every((item) => item !== null) ? numbers as number[] : null;
}

function normalizePage(raw: Record<string, unknown>): IndraOcrPage {
  const rawLines = Array.isArray(raw.lines) ? raw.lines : [];
  const lines: IndraOcrLine[] = rawLines.map((line) => {
    const item = (line ?? {}) as Record<string, unknown>;
    return {
      box: toBox(item.box),
      text: typeof item.text === "string" ? item.text : String(item.text ?? ""),
      conf: toNumber(item.conf),
    };
  });

  const lineCount = toNumber(raw.line_count) ?? lines.length;
  let meanConf = toNumber(raw.mean_conf);
  if (meanConf === null && lines.length > 0) {
    const values = lines.map((line) => line.conf).filter((value): value is number => value !== null);
    if (values.length > 0) meanConf = values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  return {
    rotation: toNumber(raw.rotation),
    skew: toNumber(raw.skew),
    source: typeof raw.source === "string" ? raw.source : null,
    text: typeof raw.text === "string" ? raw.text : String(raw.text ?? ""),
    markdown: typeof raw.markdown === "string" ? raw.markdown : String(raw.markdown ?? ""),
    lineCount: Math.max(0, Math.round(lineCount)),
    meanConf,
    lines,
    width: toNumber(raw.width),
    height: toNumber(raw.height),
    timings: raw.timings ?? null,
  };
}

function joinPages(pages: IndraOcrPage[], field: "text" | "markdown"): string {
  if (pages.length === 0) return "";
  if (pages.length === 1) return pages[0][field];
  return pages
    .map((page, index) => `--- Trang ${index + 1} ---\n${page[field]}`)
    .join("\n\n");
}

function weightedMeanConf(pages: IndraOcrPage[]): number | null {
  let weighted = 0;
  let weight = 0;
  for (const page of pages) {
    if (page.meanConf === null) continue;
    const pageWeight = page.lineCount > 0 ? page.lineCount : 1;
    weighted += page.meanConf * pageWeight;
    weight += pageWeight;
  }
  return weight > 0 ? weighted / weight : null;
}

function isAbortError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

function decodeBase64(value: string): Uint8Array {
  const raw = value.includes(",") && value.startsWith("data:") ? value.slice(value.indexOf(",") + 1) : value;
  const binary = atob(raw);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

/**
 * POST the raw document to the local Indra service and return joined OCR text.
 * Throws IndraOcrError for every failure mode; messages are codes only.
 */
export async function callIndraOcr(options: CallIndraOcrOptions): Promise<IndraOcrResult> {
  const { config } = options;
  if (config.engine !== "indra") throw new IndraOcrError("disabled");
  if (!config.url || !config.token) throw new IndraOcrError("not_configured");

  const bytes = options.bytes ?? (options.base64 ? decodeBase64(options.base64) : null);
  if (!bytes || bytes.byteLength === 0) throw new IndraOcrError("bad_response");

  const timeout = AbortSignal.timeout(config.timeoutMs);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  const fetcher = options.fetcher ?? fetch;

  const started = Date.now();
  let response: Response;
  try {
    response = await fetcher(`${config.url}/v1/ocr`, {
      method: "POST",
      redirect: "error",
      signal,
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": options.mimeType || "image/jpeg",
      },
      body: bytes as BodyInit,
    });
  } catch (error) {
    throw new IndraOcrError(isAbortError(error) ? "timeout" : "bad_response");
  }

  if (!response.ok) {
    throw new IndraOcrError(`http_${response.status}` as IndraOcrErrorCode);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await response.json() as Record<string, unknown>;
  } catch {
    throw new IndraOcrError("bad_response");
  }

  const rawPages = Array.isArray(payload?.pages) ? payload.pages : null;
  if (!rawPages) throw new IndraOcrError("bad_response");

  const pages = rawPages.map((page) => normalizePage((page ?? {}) as Record<string, unknown>));
  const text = joinPages(pages, "text");
  const markdown = joinPages(pages, "markdown");
  const lineCount = pages.reduce((sum, page) => sum + page.lineCount, 0);
  const meanConf = weightedMeanConf(pages);
  const qualityText = text.trim() ? text : markdown;

  if (!qualityText.trim()) throw new IndraOcrError("empty_text");
  if (
    lineCount < INDRA_OCR_QUALITY_MIN_LINES
    || qualityText.replace(/\s/g, "").length < INDRA_OCR_QUALITY_MIN_CHARS
    || meanConf === null
    || meanConf < INDRA_OCR_QUALITY_MIN_CONF
  ) {
    throw new IndraOcrError("low_quality");
  }

  const reportedMs = toNumber(payload.ms);
  return {
    text,
    markdown,
    rotation: pages[0]?.rotation ?? null,
    lineCount,
    meanConf,
    ms: reportedMs !== null && reportedMs >= 0 ? Math.round(reportedMs) : Date.now() - started,
    pages,
  };
}

/**
 * Indra rotation = clockwise degrees applied to make the page upright.
 * The delivery-note matcher stores the same value as rotation_cw, so this is
 * the inverse of TOP_EDGE_TO_ROTATION_CW in match-delivery-note.
 */
export function rotationToTextTopEdge(rotation: number): "top" | "left" | "bottom" | "right" | null {
  const map: Record<number, "top" | "left" | "bottom" | "right"> = {
    0: "top",
    90: "left",
    180: "bottom",
    270: "right",
  };
  return map[rotation] ?? null;
}
