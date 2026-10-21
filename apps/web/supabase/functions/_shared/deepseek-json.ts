/**
 * Shared DeepSeek chat-completions helper for structured JSON answers.
 *
 * Endpoint, key name and default model come from getScanAiConfig("deepseek"), the
 * same configuration every image-scan function already uses. DeepSeek JSON Output
 * only guarantees syntactically valid JSON, not a schema, so callers describe their
 * JSON schema in the system prompt and validate the parsed object themselves.
 *
 * A provider HTTP failure is classified by the provider-neutral
 * classifyOpenAIError (401/402/429/insufficient_quota) and thrown as AiOpenAIError
 * so existing aiErrorJson/quota handling keeps working. Invalid JSON or a
 * non-object answer throws DeepSeekJsonError("model_invalid_json").
 */
import { getScanAiConfig } from "./ai-vision-provider.ts";
import { AiOpenAIError, classifyOpenAIError } from "./openai-errors.ts";

export type DeepSeekEnvGetter = (name: string) => string | undefined;

export interface DeepSeekImage {
  base64: string;
  /** Defaults to image/jpeg. */
  mimeType?: string;
}

export interface DeepSeekUsage {
  input: number;
  output: number;
  cached: number;
}

export interface CallDeepSeekJsonOptions {
  system: string;
  userText: string;
  images?: DeepSeekImage[];
  model?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetcher?: typeof fetch;
  /** Injectable environment reader so node tests never touch global Deno state. */
  env?: DeepSeekEnvGetter;
  /** Reported provider token usage, when the caller keeps token accounting. */
  onUsage?: (usage: DeepSeekUsage) => void;
}

/** The model answered with something that was not one JSON object. */
export class DeepSeekJsonError extends Error {
  readonly code = "model_invalid_json" as const;

  constructor() {
    super("model_invalid_json");
    this.name = "DeepSeekJsonError";
  }
}

export const DEEPSEEK_JSON_DEFAULT_TIMEOUT_MS = 45_000;

/** Remove one wrapping ```json ... ``` fence; plain JSON is returned unchanged. */
export function stripJsonFences(value: string): string {
  const text = value.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text);
  return match ? match[1].trim() : text;
}

function finiteCount(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

export async function callDeepSeekJson(options: CallDeepSeekJsonOptions): Promise<Record<string, unknown>> {
  const config = getScanAiConfig("deepseek");
  const read = options.env;
  const apiKey = String((read ? read(config.keyName) : config.apiKey) ?? "").trim();
  if (!apiKey) throw new Error(`Thiếu cấu hình AI key (${config.keyName})`);
  const model = String(options.model || (read ? read("DEEPSEEK_SCAN_MODEL") : "") || config.model).trim();

  const images = options.images ?? [];
  const userContent = images.length
    ? [
      { type: "text", text: options.userText },
      ...images.map((image) => ({
        type: "image_url",
        image_url: { url: `data:${image.mimeType || "image/jpeg"};base64,${image.base64}` },
      })),
    ]
    : options.userText;

  const deadline = AbortSignal.timeout(Math.max(1, options.timeoutMs ?? DEEPSEEK_JSON_DEFAULT_TIMEOUT_MS));
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const fetcher = options.fetcher ?? fetch;

  const response = await fetcher(config.endpoint, {
    method: "POST",
    redirect: "error",
    signal,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      ...config.extraBody,
      messages: [
        { role: "system", content: options.system },
        { role: "user", content: userContent },
      ],
      response_format: { type: "json_object" },
      temperature: 0,
    }),
  });

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "");
    throw new AiOpenAIError(classifyOpenAIError(response.status, bodyText));
  }

  let payload: {
    choices?: { message?: { content?: unknown } }[];
    usage?: Record<string, unknown>;
  };
  try {
    payload = await response.json() as typeof payload;
  } catch {
    throw new DeepSeekJsonError();
  }

  const content = payload?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new DeepSeekJsonError();

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFences(content));
  } catch {
    throw new DeepSeekJsonError();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new DeepSeekJsonError();

  if (options.onUsage) {
    const usage = payload.usage ?? {};
    const details = (usage.prompt_tokens_details ?? usage.input_tokens_details) as Record<string, unknown> | undefined;
    options.onUsage({
      input: finiteCount(usage.prompt_tokens ?? usage.input_tokens),
      output: finiteCount(usage.completion_tokens ?? usage.output_tokens),
      cached: finiteCount(details?.cached_tokens),
    });
  }

  return parsed as Record<string, unknown>;
}
