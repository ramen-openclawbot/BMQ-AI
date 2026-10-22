// Offline tests for the text-first bank-slip OCR layer.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  callOpenAiVision,
  SLIP_EXTRACTION_SYSTEM_PROMPT,
  slipUserPrompt,
} from "./bank-slip-ocr.ts";
import { AiOpenAIError } from "./openai-errors.ts";

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

const ocrOk = () => Response.json({
  engine: "indra-ocr",
  version: "1.0.0",
  ms: 8,
  pages: [{
    rotation: 0,
    skew: 0,
    source: "ocr",
    text: "Số tiền: 1.250.000\nBằng chữ: một triệu hai trăm năm mươi nghìn đồng\nNgày 22/10/2026",
    markdown: "Số tiền: 1.250.000\nBằng chữ: một triệu hai trăm năm mươi nghìn đồng\nNgày 22/10/2026",
    line_count: 3,
    mean_conf: 0.93,
    lines: [
      { box: [0, 0, 10, 10], text: "Số tiền: 1.250.000", conf: 0.95 },
      { box: [0, 20, 10, 30], text: "Bằng chữ", conf: 0.9 },
      { box: [0, 40, 10, 50], text: "Ngày 22/10/2026", conf: 0.94 },
    ],
    width: 100,
    height: 200,
    timings: {},
  }],
});

const slipAnswer = (amount: string, words: string | null = null) =>
  Response.json({
    choices: [{
      message: {
        tool_calls: [{
          function: {
            name: "extract_slip_amount",
            arguments: JSON.stringify({
              amount,
              amount_in_words: words,
              confidence: 0.9,
              transfer_date: "2026-10-22",
              reference: "FT123",
            }),
          },
        }],
      },
    }],
  });

function makeFetcher(handler: (url: string) => Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url);
  }) as typeof fetch;
  const ocrCalls = () => calls.filter((call) => call.url.includes("/v1/ocr"));
  const modelCalls = () => calls.filter((call) => !call.url.includes("/v1/ocr"));
  return { fetcher, calls, ocrCalls, modelCalls };
}

test("indra text path returns the normalized slip and marks indra_text", async () => {
  const { fetcher, ocrCalls, modelCalls } = makeFetcher(async (url) =>
    url.includes("/v1/ocr") ? ocrOk() : slipAnswer("1.250.000", "một triệu hai trăm năm mươi nghìn đồng")
  );

  const result = await callOpenAiVision("AAAA", "image/jpeg", "transfer", { env: env(), fetcher });

  assert.equal(result.amount, 1_250_000);
  assert.equal(result.ocr_engine, "indra_text");
  assert.equal(result.ocr_fallback_reason, null);
  assert.equal(ocrCalls().length, 1);
  assert.equal(modelCalls().length, 1);

  const body = JSON.parse(String(modelCalls()[0].init?.body));
  assert.equal(typeof body.messages[1].content, "string");
  assert.match(body.messages[1].content, /<<<OCR>>>/);
  assert.match(body.messages[1].content, /Số tiền: 1.250.000/);
  assert.equal(body.messages[0].content.endsWith("<<<OCR>>>"), false);
  assert.match(body.messages[0].content, /KHÔNG nhận được ảnh/);
});

test("an Indra failure falls back to today's unchanged image request", async () => {
  const { fetcher, modelCalls } = makeFetcher(async (url) =>
    url.includes("/v1/ocr") ? new Response("{}", { status: 500 }) : slipAnswer("1.250.000")
  );

  const result = await callOpenAiVision("AAAA", "image/jpeg", "transfer", { env: env(), fetcher });

  assert.equal(result.amount, 1_250_000);
  assert.equal(result.ocr_engine, "deepseek_image");
  assert.equal(result.ocr_fallback_reason, "http_500");
  assert.equal(modelCalls().length, 1);

  const body = JSON.parse(String(modelCalls()[0].init?.body));
  assert.equal(body.model, "deepseek-flash");
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.max_tokens, 1000);
  assert.deepEqual(body.tool_choice, { type: "function", function: { name: "extract_slip_amount" } });
  assert.equal(body.messages[0].content, SLIP_EXTRACTION_SYSTEM_PROMPT);
  assert.equal(body.messages[1].content[1].text, slipUserPrompt("transfer"));
  assert.equal(body.messages[1].content[0].type, "image_url");
  assert.equal(body.messages[1].content[0].image_url.url, "data:image/jpeg;base64,AAAA");
  assert.equal(body.messages[1].content[0].image_url.detail, "high");
  assert.equal(body.tools[0].type, "function");
  assert.equal(body.tools[0].function.name, "extract_slip_amount");
  assert.deepEqual(
    body.tools[0].function.parameters.required,
    ["amount", "amount_in_words", "confidence"],
  );
});

test("digits corrected from words fail validation and fall back to the image", async () => {
  let modelAttempt = 0;
  const { fetcher, modelCalls } = makeFetcher(async (url) => {
    if (url.includes("/v1/ocr")) return ocrOk();
    modelAttempt++;
    return modelAttempt === 1
      ? slipAnswer("3.000.000", "ba mươi triệu đồng")
      : slipAnswer("30.000.000", "ba mươi triệu đồng");
  });

  const result = await callOpenAiVision("AAAA", "image/jpeg", "transfer", { env: env(), fetcher });

  assert.equal(result.amount, 30_000_000);
  assert.equal(result.ocr_engine, "deepseek_image");
  assert.equal(result.ocr_fallback_reason, "slip_amount_check");
  assert.equal(modelCalls().length, 2);
  const secondBody = JSON.parse(String(modelCalls()[1].init?.body));
  assert.equal(secondBody.messages[1].content[0].type, "image_url");
});

test("a quota error from the text model is rethrown without an image retry", async () => {
  const { fetcher, modelCalls } = makeFetcher(async (url) =>
    url.includes("/v1/ocr")
      ? ocrOk()
      : new Response(JSON.stringify({ error: { message: "insufficient_quota" } }), { status: 402 })
  );

  await assert.rejects(
    () => callOpenAiVision("AAAA", "image/jpeg", "transfer", { env: env(), fetcher }),
    (error: unknown) => error instanceof AiOpenAIError && error.info.kind === "quota",
  );
  assert.equal(modelCalls().length, 1);
});

test("unset SCAN_OCR_ENGINE keeps the image path with no OCR request", async () => {
  const { fetcher, ocrCalls } = makeFetcher(async () => slipAnswer("1.250.000"));
  const result = await callOpenAiVision("AAAA", "image/jpeg", undefined, {
    env: env({ SCAN_OCR_ENGINE: undefined }),
    fetcher,
  });
  assert.equal(result.amount, 1_250_000);
  assert.equal(result.ocr_engine, "deepseek_image");
  assert.equal(result.ocr_fallback_reason, null);
  assert.equal(ocrCalls().length, 0);
});
