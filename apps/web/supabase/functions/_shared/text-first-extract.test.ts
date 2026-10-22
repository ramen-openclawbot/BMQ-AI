// Offline tests for the text-first scan pipeline.
//
// Both engines are exercised through an injected fetcher and env getter: no
// network, no real key/token and no global Deno environment access.
import { test } from "node:test";
import assert from "node:assert/strict";

import { AiOpenAIError } from "./openai-errors.ts";
import {
  buildOcrTextUserContent,
  callDeepSeekTool,
  OCR_TEXT_MARKER,
  OCR_TEXT_MAX_CHARS,
  OCR_TEXT_SYSTEM_SUFFIX,
  runTextFirst,
  TextFirstError,
} from "./text-first-extract.ts";
import type { IndraOcrResult } from "./indra-ocr.ts";

const TOKEN = "indra-test-token-abcdefghijklmnopqrstuvwxyz-0123456789";

const env = (extra: Record<string, string | undefined> = {}) => (name: string) =>
  ({
    DEEPSEEK_API_KEY: "ds-test-key",
    DEEPSEEK_SCAN_MODEL: "deepseek-flash",
    SCAN_OCR_ENGINE: "indra",
    INDRA_OCR_URL: "https://bmq-ocr.vnagent.ai",
    INDRA_OCR_TOKEN: TOKEN,
    ...extra,
  })[name];

const ocrPage = (overrides: Record<string, unknown> = {}) => ({
  rotation: 270,
  skew: 0,
  source: "ocr",
  text: "CÔNG TY TNHH BÁNH MÌ\nSố tiền: 1.250.000\nNgày 22/10/2026",
  markdown: "| Nội dung | Số tiền |\n| --- | --- |\n| Bánh mì | 1.250.000 |",
  line_count: 3,
  mean_conf: 0.91,
  lines: [
    { box: [0, 0, 10, 10], text: "CÔNG TY TNHH BÁNH MÌ", conf: 0.91 },
    { box: [0, 20, 10, 30], text: "Số tiền: 1.250.000", conf: 0.9 },
    { box: [0, 40, 10, 50], text: "Ngày 22/10/2026", conf: 0.92 },
  ],
  width: 100,
  height: 200,
  timings: { ocr_ms: 4 },
  ...overrides,
});

const ocrOk = (pages = [ocrPage()]) =>
  Response.json({ engine: "indra-ocr", version: "1.0.0", ms: 7, pages });

const toolOk = (args: Record<string, unknown>, name = "extract_x") =>
  Response.json({
    choices: [{
      message: {
        tool_calls: [{ function: { name, arguments: JSON.stringify(args) } }],
      },
    }],
  });

type Handler = (url: string, init?: RequestInit) => Promise<Response>;

function routed(handler: Handler) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  const ocrCalls = () => calls.filter((call) => call.url.includes("/v1/ocr"));
  const modelCalls = () => calls.filter((call) => !call.url.includes("/v1/ocr"));
  return { fetcher, calls, ocrCalls, modelCalls };
}

const ocrResult = (overrides: Partial<IndraOcrResult> = {}): IndraOcrResult => ({
  text: "CÔNG TY TNHH BÁNH MÌ\nSố tiền: 1.250.000\nNgày 22/10/2026",
  markdown: "| Nội dung | Số tiền |\n| --- | --- |\n| Bánh mì | 1.250.000 |",
  rotation: 270,
  lineCount: 3,
  meanConf: 0.91,
  ms: 7,
  pages: [],
  ...overrides,
});

test("callDeepSeekTool posts the forced tool with thinking off, temperature 0 and max_tokens", async () => {
  const { fetcher, modelCalls } = routed(async () => toolOk({ amount: 1000 }));
  const tool = {
    name: "extract_x",
    description: "extract",
    parameters: { type: "object", properties: { amount: { type: "number" } } },
  };
  const result = await callDeepSeekTool({
    system: "system prompt",
    userContent: "user content",
    tool,
    maxTokens: 1000,
    env: env(),
    fetcher,
  });

  assert.deepEqual(result, { amount: 1000 });
  assert.equal(modelCalls().length, 1);
  const call = modelCalls()[0];
  assert.equal(call.url, "https://api.deepseek.com/chat/completions");
  assert.equal(call.init?.redirect, "error");
  const headers = call.init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer ds-test-key");
  const body = JSON.parse(String(call.init?.body));
  assert.equal(body.model, "deepseek-flash");
  assert.equal(body.temperature, 0);
  assert.equal(body.max_tokens, 1000);
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.deepEqual(body.tool_choice, { type: "function", function: { name: "extract_x" } });
  assert.equal(body.tools[0].function.name, "extract_x");
  assert.equal(body.messages[0].content, "system prompt");
  assert.equal(body.messages[1].content, "user content");
});

test("callDeepSeekTool retries once after a 500 and succeeds", async () => {
  let attempt = 0;
  const { fetcher, modelCalls } = routed(async () => {
    attempt++;
    return attempt === 1 ? new Response("upstream", { status: 500 }) : toolOk({ ok: true });
  });
  const result = await callDeepSeekTool({
    system: "s",
    userContent: "u",
    tool: { name: "extract_x", description: "d", parameters: { type: "object" } },
    env: env(),
    fetcher,
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(modelCalls().length, 2);
});

test("missing or unparseable tool calls throw TextFirstError(model_invalid_tool)", async () => {
  const missing = routed(async () => Response.json({ choices: [{ message: { content: "no tool" } }] }));
  await assert.rejects(
    () => callDeepSeekTool({
      system: "s",
      userContent: "u",
      tool: { name: "extract_x", description: "d", parameters: { type: "object" } },
      env: env(),
      fetcher: missing.fetcher,
    }),
    (error: unknown) => error instanceof TextFirstError && error.code === "model_invalid_tool",
  );

  const brokenArgs = routed(async () => Response.json({
    choices: [{ message: { tool_calls: [{ function: { name: "extract_x", arguments: "{not json" } }] } }],
  }));
  await assert.rejects(
    () => callDeepSeekTool({
      system: "s",
      userContent: "u",
      tool: { name: "extract_x", description: "d", parameters: { type: "object" } },
      env: env(),
      fetcher: brokenArgs.fetcher,
    }),
    (error: unknown) => error instanceof TextFirstError && error.code === "model_invalid_tool",
  );
});

test("buildOcrTextUserContent uses markdown, then text, and truncates to 40000 chars", () => {
  const withMarkdown = buildOcrTextUserContent("prompt", { text: "plain", markdown: "markdown" });
  assert.equal(withMarkdown, `prompt\n${OCR_TEXT_MARKER}markdown`);
  const withText = buildOcrTextUserContent("prompt", { text: "plain", markdown: "   " });
  assert.equal(withText, `prompt\n${OCR_TEXT_MARKER}plain`);

  const long = buildOcrTextUserContent("prompt", { markdown: "x".repeat(OCR_TEXT_MAX_CHARS + 500) });
  assert.equal(long.length, OCR_TEXT_MAX_CHARS);
  assert.ok(OCR_TEXT_SYSTEM_SUFFIX.includes("<<<OCR>>>"));
});

test("without indra the image attempt runs alone and no OCR/model request is made", async () => {
  const { fetcher, calls } = routed(async () => {
    throw new Error("no HTTP request expected");
  });
  let textCalled = false;
  const outcome = await runTextFirst({
    label: "unit",
    images: [{ base64: "AAAA", mimeType: "image/jpeg" }],
    textAttempt: async () => {
      textCalled = true;
      return "text";
    },
    validate: () => null,
    imageAttempt: async () => "image",
    env: env({ SCAN_OCR_ENGINE: undefined }),
    fetcher,
  });
  assert.equal(outcome.result, "image");
  assert.equal(outcome.engine, "deepseek_image");
  assert.equal(outcome.fallbackReason, null);
  assert.equal(calls.length, 0);
  assert.equal(textCalled, false);
});

test("indra text success returns indra_text and logs one safe JSON line", async () => {
  const { fetcher } = routed(async () => ocrOk());
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  try {
    const outcome = await runTextFirst({
      label: "unit",
      images: [{ base64: "AAAA", mimeType: "image/jpeg" }],
      textAttempt: async (ocr) => ocr.markdown,
      validate: () => null,
      imageAttempt: async () => "image",
      env: env(),
      fetcher,
    });
    assert.equal(outcome.engine, "indra_text");
    assert.equal(outcome.fallbackReason, null);
    assert.match(String(outcome.result), /Bánh mì/);
  } finally {
    console.log = original;
  }

  assert.equal(logs.length, 1);
  const line = JSON.parse(logs[0]);
  assert.deepEqual(Object.keys(line).sort(), ["engine", "fallback_reason", "ocr_ms", "scan", "total_ms"]);
  assert.equal(line.scan, "unit");
  assert.equal(line.engine, "indra_text");
  assert.equal(line.fallback_reason, null);
  assert.equal(logs[0].includes("Bánh mì"), false);
  assert.equal(logs[0].includes(TOKEN), false);
});

test("an Indra HTTP error falls back to the image with its code", async () => {
  let imageCalls = 0;
  const { fetcher } = routed(async (url) => {
    if (url.includes("/v1/ocr")) return new Response("{}", { status: 503 });
    return new Response("unexpected", { status: 500 });
  });
  const outcome = await runTextFirst({
    label: "unit",
    images: [{ base64: "AAAA" }],
    textAttempt: async () => "text",
    validate: () => null,
    imageAttempt: async () => {
      imageCalls++;
      return "image";
    },
    env: env(),
    fetcher,
  });
  assert.equal(outcome.result, "image");
  assert.equal(outcome.engine, "deepseek_image");
  assert.equal(outcome.fallbackReason, "http_503");
  assert.equal(imageCalls, 1);
});

test("quota from the text model is rethrown without an image retry", async () => {
  const { fetcher, modelCalls } = routed(async (url) => {
    if (url.includes("/v1/ocr")) return ocrOk();
    return new Response(JSON.stringify({ error: { message: "insufficient_quota" } }), { status: 402 });
  });
  let imageCalls = 0;
  await assert.rejects(
    () => runTextFirst({
      label: "unit",
      images: [{ base64: "AAAA" }],
      textAttempt: () => callDeepSeekTool({
        system: "s",
        userContent: "u",
        tool: { name: "extract_x", description: "d", parameters: { type: "object" } },
        env: env(),
        fetcher,
      }),
      validate: () => null,
      imageAttempt: async () => {
        imageCalls++;
        return "image";
      },
      env: env(),
      fetcher,
    }),
    (error: unknown) => error instanceof AiOpenAIError && error.info.kind === "quota",
  );
  assert.equal(modelCalls().length, 1);
  assert.equal(imageCalls, 0);
});

test("other text-model errors fall back as text_model_<code>", async () => {
  const { fetcher } = routed(async (url) => {
    if (url.includes("/v1/ocr")) return ocrOk();
    return new Response("upstream", { status: 500 });
  });
  const outcome = await runTextFirst({
    label: "unit",
    images: [{ base64: "AAAA" }],
    textAttempt: () => callDeepSeekTool({
      system: "s",
      userContent: "u",
      tool: { name: "extract_x", description: "d", parameters: { type: "object" } },
      env: env(),
      fetcher,
    }),
    validate: () => null,
    imageAttempt: async () => "image",
    env: env(),
    fetcher,
  });
  assert.equal(outcome.result, "image");
  assert.equal(outcome.engine, "deepseek_image");
  assert.equal(outcome.fallbackReason, "text_model_ai_upstream_error");
});

test("a failed validation uses the image result and reports the validation reason", async () => {
  const { fetcher } = routed(async () => ocrOk());
  const outcome = await runTextFirst({
    label: "unit",
    images: [{ base64: "AAAA" }],
    textAttempt: async () => ({ ok: false }),
    validate: (result) => (result.ok ? null : "bad_data"),
    imageAttempt: async () => ({ ok: true }),
    env: env(),
    fetcher,
  });
  assert.deepEqual(outcome.result, { ok: true });
  assert.equal(outcome.engine, "deepseek_image");
  assert.equal(outcome.fallbackReason, "bad_data");
});

test("double failure keeps the image by default and can keep text on request", async () => {
  const defaultOutcome = await runTextFirst({
    label: "unit",
    images: [{ base64: "AAAA" }],
    textAttempt: async () => "text",
    validate: () => "bad_data",
    imageAttempt: async () => "image",
    env: env(),
    fetcher: routed(async () => ocrOk()).fetcher,
  });
  assert.equal(defaultOutcome.result, "image");
  assert.equal(defaultOutcome.engine, "deepseek_image");

  const textOutcome = await runTextFirst({
    label: "unit",
    images: [{ base64: "AAAA" }],
    textAttempt: async () => "text",
    validate: () => "bad_data",
    imageAttempt: async () => "image",
    chooseOnDoubleFailure: () => "text",
    env: env(),
    fetcher: routed(async () => ocrOk()).fetcher,
  });
  assert.equal(textOutcome.result, "text");
  assert.equal(textOutcome.engine, "indra_text");
  assert.equal(textOutcome.fallbackReason, "bad_data");
});

test("engineOverride forces image mode for the benchmark", async () => {
  const outcome = await runTextFirst({
    label: "unit",
    images: [{ base64: "AAAA" }],
    textAttempt: async () => "text",
    validate: () => null,
    imageAttempt: async () => "image",
    env: env(),
    fetcher: routed(async () => ocrOk()).fetcher,
    engineOverride: "deepseek",
  });
  assert.equal(outcome.result, "image");
  assert.equal(outcome.engine, "deepseek_image");
  assert.equal(outcome.fallbackReason, null);
});

test("multiple images are OCR'd in order and joined with Ảnh headers", async () => {
  const { fetcher, ocrCalls } = routed(async () => ocrOk());
  let received = "";
  await runTextFirst({
    label: "unit",
    images: [{ base64: "AAAA" }, { base64: "BBBB" }],
    textAttempt: async (ocr) => {
      received = ocr.text;
      return "text";
    },
    validate: () => null,
    imageAttempt: async () => "image",
    env: env(),
    fetcher,
  });
  assert.equal(ocrCalls().length, 2);
  assert.match(received, /--- Ảnh 1 ---/);
  assert.match(received, /--- Ảnh 2 ---/);
});
