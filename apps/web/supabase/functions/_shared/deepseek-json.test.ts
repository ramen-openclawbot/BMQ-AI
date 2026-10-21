// Offline tests for the shared DeepSeek structured-JSON helper.
//
// Every request uses an injected fetcher and an injected env getter: no network,
// no paid call and no global Deno environment access.
import { test } from "node:test";
import assert from "node:assert/strict";

import { callDeepSeekJson, DeepSeekJsonError, type DeepSeekEnvGetter, type DeepSeekUsage } from "./deepseek-json.ts";
import { AiOpenAIError } from "./openai-errors.ts";

const env = (extra: Record<string, string | undefined> = {}): DeepSeekEnvGetter =>
  (name) => (name === "DEEPSEEK_API_KEY" ? "ds-test-key" : extra[name]);

const deepSeekAnswer = (content: string, usage: Record<string, unknown> = {}) =>
  Response.json({
    choices: [{ message: { content } }],
    usage: { prompt_tokens: 20, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 3 }, ...usage },
  });

function makeFetcher(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fetcher, calls };
}

test("posts a DeepSeek json_object request with the default model, temperature 0 and image data URLs", async () => {
  const { fetcher, calls } = makeFetcher(async () => deepSeekAnswer('{"ok":true}'));
  let reported: DeepSeekUsage | undefined;
  const result = await callDeepSeekJson({
    system: "Reply with one JSON object matching this JSON Schema: {\"type\":\"object\"}",
    userText: "extract this slip",
    images: [{ base64: "AAA111", mimeType: "image/jpeg" }],
    env: env(),
    fetcher,
    onUsage: (usage) => { reported = usage; },
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.deepseek.com/chat/completions");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(calls[0].init?.redirect, "error");
  assert.equal((calls[0].init?.headers as Record<string, string>).Authorization, "Bearer ds-test-key");

  const body = JSON.parse(String(calls[0].init?.body)) as {
    model: string;
    temperature: number;
    response_format: { type: string };
    messages: { role: string; content: unknown }[];
  };
  assert.equal(body.model, "deepseek-flash");
  assert.equal(body.temperature, 0);
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(body.messages[0].role, "system");
  assert.match(String(body.messages[0].content), /JSON Schema/);
  const user = body.messages[1];
  assert.equal(user.role, "user");
  assert.deepEqual(user.content, [
    { type: "text", text: "extract this slip" },
    { type: "image_url", image_url: { url: "data:image/jpeg;base64,AAA111" } },
  ]);
  assert.deepEqual(reported, { input: 20, output: 5, cached: 3 });
});

test("a missing image mime type falls back to image/jpeg and text-only content is a string", async () => {
  const { fetcher, calls } = makeFetcher(async () => deepSeekAnswer('{"ok":true}'));
  await callDeepSeekJson({ system: "json", userText: "text only", env: env(), fetcher });
  const body = JSON.parse(String(calls[0].init?.body));
  assert.equal(typeof body.messages[1].content, "string");

  const images = makeFetcher(async () => deepSeekAnswer('{"ok":true}'));
  await callDeepSeekJson({ system: "json", userText: "with image", images: [{ base64: "BBB" }], env: env(), fetcher: images.fetcher });
  const imageBody = JSON.parse(String(images.calls[0].init?.body));
  assert.equal(imageBody.messages[1].content[1].image_url.url, "data:image/jpeg;base64,BBB");
});

test("DEEPSEEK_SCAN_MODEL and an explicit model override the default", async () => {
  const fromEnv = makeFetcher(async () => deepSeekAnswer('{"ok":true}'));
  await callDeepSeekJson({ system: "json", userText: "x", env: env({ DEEPSEEK_SCAN_MODEL: "deepseek-env-model" }), fetcher: fromEnv.fetcher });
  assert.equal(JSON.parse(String(fromEnv.calls[0].init?.body)).model, "deepseek-env-model");

  const explicit = makeFetcher(async () => deepSeekAnswer('{"ok":true}'));
  await callDeepSeekJson({ system: "json", userText: "x", model: "deepseek-explicit", env: env(), fetcher: explicit.fetcher });
  assert.equal(JSON.parse(String(explicit.calls[0].init?.body)).model, "deepseek-explicit");
});

test("a fenced ```json answer is parsed", async () => {
  const { fetcher } = makeFetcher(async () => deepSeekAnswer('```json\n{"lane":"semantic","queries":[]}\n```'));
  const result = await callDeepSeekJson({ system: "json", userText: "x", env: env(), fetcher });
  assert.deepEqual(result, { lane: "semantic", queries: [] });
});

test("invalid JSON is a model_invalid_json error, never a silent answer", async () => {
  const invalid = makeFetcher(async () => deepSeekAnswer("not json"));
  await assert.rejects(
    () => callDeepSeekJson({ system: "json", userText: "x", env: env(), fetcher: invalid.fetcher }),
    (error: unknown) => error instanceof DeepSeekJsonError && error.code === "model_invalid_json",
  );

  const nonObject = makeFetcher(async () => deepSeekAnswer("[1,2]"));
  await assert.rejects(
    () => callDeepSeekJson({ system: "json", userText: "x", env: env(), fetcher: nonObject.fetcher }),
    (error: unknown) => error instanceof DeepSeekJsonError && error.code === "model_invalid_json",
  );

  const missingContent = makeFetcher(async () => Response.json({ choices: [{ message: {} }] }));
  await assert.rejects(
    () => callDeepSeekJson({ system: "json", userText: "x", env: env(), fetcher: missingContent.fetcher }),
    (error: unknown) => error instanceof DeepSeekJsonError,
  );
});

test("HTTP 402 and 429 keep the classified quota/rate-limit contract", async () => {
  for (const [status, expectedCode] of [[402, "ai_quota_exhausted"], [429, "ai_rate_limited"]] as const) {
    const { fetcher } = makeFetcher(async () => new Response("provider says no", { status }));
    await assert.rejects(
      () => callDeepSeekJson({ system: "json", userText: "x", env: env(), fetcher }),
      (error: unknown) => error instanceof AiOpenAIError && error.code === expectedCode,
    );
  }
});

test("a missing key throws the same configuration error style as the scans", async () => {
  const { fetcher, calls } = makeFetcher(async () => deepSeekAnswer('{"ok":true}'));
  await assert.rejects(
    () => callDeepSeekJson({ system: "json", userText: "x", env: () => undefined, fetcher }),
    /Thiếu cấu hình AI key \(DEEPSEEK_API_KEY\)/,
  );
  assert.equal(calls.length, 0);
});
