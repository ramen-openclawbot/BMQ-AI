/**
 * Text-first scan pipeline shared by:
 *   - bank-slip-ocr.ts (bank / UNC / cash / salary slips: finance-extract-slip-amount,
 *     payment-unc-approve, payment-cash-settle, salary-payout)
 *   - scan-purchase-order
 *   - scan-invoice (cash receipt + invoice modes)
 *   - scan-bank-slip
 *   - match-delivery-note
 *   - suggest-stock-item-name
 *
 * scan-product-label is intentionally NOT on this layer: it needs the image
 * itself (barcode box / label visual QA), not just recognized text.
 *
 * With SCAN_OCR_ENGINE unset (or anything other than exactly "indra") the
 * imageAttempt runs alone and the DeepSeek image request stays byte-for-byte
 * today's request. Quota errors are always rethrown without an image retry.
 */
import { getScanAiConfig } from "./ai-vision-provider.ts";
import { AiOpenAIError, classifyOpenAIError, getAiErrorInfo } from "./openai-errors.ts";
import {
  callIndraOcr,
  IndraOcrError,
  readIndraOcrConfig,
  type IndraOcrEnvGetter,
  type IndraOcrResult,
} from "./indra-ocr.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const DEEPSEEK_TOOL_DEFAULT_TIMEOUT_MS = 30_000;
export const OCR_TEXT_MAX_CHARS = 40_000;
export const OCR_TEXT_MARKER = "<<<OCR>>>";

export interface DeepSeekToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface CallDeepSeekToolOptions {
  system: string;
  userContent: string;
  tool: DeepSeekToolDefinition;
  maxTokens?: number;
  timeoutMs?: number;
  fetcher?: typeof fetch;
  env?: IndraOcrEnvGetter;
}

/** The model answered without a usable forced tool call. */
export class TextFirstError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "TextFirstError";
    this.code = code;
  }
}

interface ToolCallPayload {
  choices?: Array<{
    message?: {
      tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
    };
  }>;
}

function readEnvValue(
  read: IndraOcrEnvGetter | undefined,
  name: string,
  fallback: string | undefined,
): string {
  return String((read ? read(name) : fallback) ?? "").trim();
}

/**
 * Same DeepSeek endpoint/key/model/extraBody as the image scans, but the user
 * content is plain OCR text and the answer must be one forced tool call.
 * Retries once after 400 ms on 429/5xx, like the provider HTTP path.
 */
export async function callDeepSeekTool(options: CallDeepSeekToolOptions): Promise<Record<string, unknown>> {
  const config = getScanAiConfig();
  const apiKey = readEnvValue(options.env, config.keyName, config.apiKey);
  if (!apiKey) throw new Error(`Thiếu cấu hình AI key (${config.keyName})`);
  const model = readEnvValue(options.env, "DEEPSEEK_SCAN_MODEL", config.model) || config.model;

  const timeoutMs = Math.max(1, options.timeoutMs ?? DEEPSEEK_TOOL_DEFAULT_TIMEOUT_MS);
  const fetcher = options.fetcher ?? fetch;

  const body: Record<string, unknown> = {
    model,
    ...config.extraBody,
    messages: [
      { role: "system", content: options.system },
      { role: "user", content: options.userContent },
    ],
    tools: [{ type: "function", function: options.tool }],
    tool_choice: { type: "function", function: { name: options.tool.name } },
    temperature: 0,
  };
  if (typeof options.maxTokens === "number" && Number.isFinite(options.maxTokens)) {
    body.max_tokens = options.maxTokens;
  }

  let response: Response | null = null;
  let lastStatus = 0;
  let lastBody = "";

  for (let attempt = 1; attempt <= 2; attempt++) {
    response = await fetcher(config.endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (response.ok) break;

    lastStatus = response.status;
    lastBody = await response.text().catch(() => "");
    if ((lastStatus === 429 || lastStatus >= 500) && attempt < 2) {
      await sleep(400);
      continue;
    }
    throw new AiOpenAIError(classifyOpenAIError(lastStatus, lastBody));
  }

  if (!response?.ok) throw new AiOpenAIError(classifyOpenAIError(lastStatus, lastBody));

  let payload: ToolCallPayload;
  try {
    payload = await response.json() as ToolCallPayload;
  } catch {
    throw new TextFirstError("model_invalid_tool");
  }

  const toolCall = payload?.choices?.[0]?.message?.tool_calls?.[0];
  if (!toolCall || toolCall.function?.name !== options.tool.name) {
    throw new TextFirstError("model_invalid_tool");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(toolCall.function.arguments || "{}");
  } catch {
    throw new TextFirstError("model_invalid_tool");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TextFirstError("model_invalid_tool");
  }
  return parsed as Record<string, unknown>;
}

/**
 * Appended to today's system prompt when the model only receives OCR text.
 * Vietnamese: the model gets no image; the document was read by OCR and sits
 * after the <<<OCR>>> marker (markdown, tables as HTML, reading order kept);
 * use only text and numbers from that section, copy printed numbers exactly
 * without recomputing, ignore phone and app interface text (clock, battery,
 * buttons), leave missing fields null.
 */
export const OCR_TEXT_SYSTEM_SUFFIX = `

Bạn KHÔNG nhận được ảnh. Chứng từ đã được OCR đọc thành chữ và nằm sau dấu <<<OCR>>> trong tin nhắn người dùng (định dạng markdown, bảng có thể ở dạng HTML, giữ nguyên thứ tự đọc).
- Chỉ dùng chữ và số có trong phần sau <<<OCR>>>; không tự thêm dữ liệu không thấy ở đó.
- Chép nguyên văn các con số đã in (đúng dấu chấm/phẩy và đủ chữ số); KHÔNG tự tính lại, KHÔNG làm tròn, KHÔNG đổi thứ tự chữ số.
- Bỏ qua chữ thuộc giao diện điện thoại/ứng dụng (giờ, pin, nút bấm, thanh trạng thái) và số điện thoại.
- Trường nào không có trong phần OCR thì để null.`;

export interface OcrTextSource {
  text?: string;
  markdown?: string;
}

/**(userPrompt + newline + <<<OCR>>> + markdown-or-text), capped at 40.000 chars. */
export function buildOcrTextUserContent(userPrompt: string, ocr: OcrTextSource): string {
  const body = ocr.markdown && ocr.markdown.trim() ? ocr.markdown : (ocr.text ?? "");
  const combined = `${userPrompt}\n${OCR_TEXT_MARKER}${body}`;
  return combined.length > OCR_TEXT_MAX_CHARS ? combined.slice(0, OCR_TEXT_MAX_CHARS) : combined;
}

export interface TextFirstImage {
  base64?: string;
  bytes?: Uint8Array;
  mimeType?: string;
}

export type TextFirstEngine = "indra_text" | "deepseek_image";

export interface RunTextFirstOptions<T> {
  /** Short function name used in the single JSON log line. */
  label: string;
  images: TextFirstImage[];
  textAttempt: (ocr: IndraOcrResult) => Promise<T>;
  validate: (result: T) => string | null;
  imageAttempt: () => Promise<T>;
  chooseOnDoubleFailure?: (textResult: T, imageResult: T) => "text" | "image";
  env?: IndraOcrEnvGetter;
  fetcher?: typeof fetch;
  /** Benchmark-only: force one engine without any HTTP request field. */
  engineOverride?: "indra" | "deepseek";
}

export interface TextFirstOutcome<T> {
  result: T;
  engine: TextFirstEngine;
  fallbackReason: string | null;
}

function mergeOcrResults(results: IndraOcrResult[]): IndraOcrResult {
  if (results.length === 0) throw new IndraOcrError("bad_response");
  if (results.length === 1) return results[0];

  const pages = results.flatMap((result) => result.pages);
  const text = results
    .map((result, index) => `--- Ảnh ${index + 1} ---\n${result.text}`)
    .join("\n\n");
  const markdown = results
    .map((result, index) => `--- Ảnh ${index + 1} ---\n${result.markdown}`)
    .join("\n\n");
  const lineCount = results.reduce((sum, result) => sum + result.lineCount, 0);
  const weighted = results.reduce(
    (acc, result) => {
      if (result.meanConf === null) return acc;
      const weight = result.lineCount > 0 ? result.lineCount : 1;
      return { sum: acc.sum + result.meanConf * weight, weight: acc.weight + weight };
    },
    { sum: 0, weight: 0 },
  );

  return {
    text,
    markdown,
    rotation: results[0].rotation,
    lineCount,
    meanConf: weighted.weight > 0 ? weighted.sum / weighted.weight : null,
    ms: results.reduce((sum, result) => sum + result.ms, 0),
    pages,
  };
}

function errorReason(error: unknown): string {
  if (error instanceof IndraOcrError) return error.code;
  const info = getAiErrorInfo(error);
  if (info?.kind === "quota") return "quota";
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string" && code.trim()) return code;
  const name = (error as { name?: unknown } | null)?.name;
  return typeof name === "string" && name.trim() ? name : "error";
}

function isQuotaError(error: unknown): boolean {
  return error instanceof AiOpenAIError
    ? error.info.kind === "quota"
    : getAiErrorInfo(error)?.kind === "quota";
}

/**
 * OCR first, DeepSeek text second, today's DeepSeek image request as fallback.
 * Always returns exactly one result and logs one JSON line per scan.
 */
export async function runTextFirst<T>(options: RunTextFirstOptions<T>): Promise<TextFirstOutcome<T>> {
  const started = Date.now();
  const envConfig = readIndraOcrConfig(options.env);
  const engine = options.engineOverride ?? envConfig.engine;
  // The override must reach callIndraOcr too, or it refuses with "disabled".
  const config = { ...envConfig, engine };

  const log = (chosenEngine: TextFirstEngine, fallbackReason: string | null, ocrMs: number) => {
    // Only metadata: never document text, markdown, headers or secrets.
    console.log(JSON.stringify({
      scan: options.label,
      engine: chosenEngine,
      fallback_reason: fallbackReason,
      ocr_ms: ocrMs,
      total_ms: Date.now() - started,
    }));
  };

  const runImageOnly = async (fallbackReason: string | null): Promise<TextFirstOutcome<T>> => {
    const result = await options.imageAttempt();
    log("deepseek_image", fallbackReason, 0);
    return { result, engine: "deepseek_image", fallbackReason };
  };

  if (engine !== "indra") {
    return await runImageOnly(null);
  }

  const ocrStarted = Date.now();
  let ocr: IndraOcrResult;
  try {
    const results: IndraOcrResult[] = [];
    for (const image of options.images) {
      results.push(await callIndraOcr({
        base64: image.base64,
        bytes: image.bytes,
        mimeType: image.mimeType || "image/jpeg",
        config,
        fetcher: options.fetcher,
      }));
    }
    ocr = mergeOcrResults(results);
  } catch (error) {
    return await runImageOnly(errorReason(error));
  }
  const ocrMs = Date.now() - ocrStarted;

  let textResult: T;
  try {
    textResult = await options.textAttempt(ocr);
  } catch (error) {
    // Quota is a hard stop: no image retry, exactly like today.
    if (isQuotaError(error)) throw error;
    return await runImageOnly(`text_model_${errorReason(error)}`);
  }

  const validationReason = options.validate(textResult);
  if (validationReason === null) {
    log("indra_text", null, ocrMs);
    return { result: textResult, engine: "indra_text", fallbackReason: null };
  }

  const imageResult = await options.imageAttempt();
  if (options.validate(imageResult) === null) {
    log("deepseek_image", validationReason, ocrMs);
    return { result: imageResult, engine: "deepseek_image", fallbackReason: validationReason };
  }

  const chosen = options.chooseOnDoubleFailure?.(textResult, imageResult) ?? "image";
  const chosenEngine: TextFirstEngine = chosen === "text" ? "indra_text" : "deepseek_image";
  log(chosenEngine, validationReason, ocrMs);
  return {
    result: chosen === "text" ? textResult : imageResult,
    engine: chosenEngine,
    fallbackReason: validationReason,
  };
}
