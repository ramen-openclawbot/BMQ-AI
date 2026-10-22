// Offline tests for the Indra OCR client.
//
// Every request uses an injected fetcher and env getter: no network, no real
// token and no global Deno environment access.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  callIndraOcr,
  IndraOcrError,
  readIndraOcrConfig,
  rotationToTextTopEdge,
  type IndraOcrConfig,
} from "./indra-ocr.ts";

const TOKEN = "indra-test-token-abcdefghijklmnopqrstuvwxyz-0123456789";

const env = (extra: Record<string, string | undefined> = {}) => (name: string) =>
  ({
    SCAN_OCR_ENGINE: "indra",
    INDRA_OCR_URL: "https://bmq-ocr.vnagent.ai",
    INDRA_OCR_TOKEN: TOKEN,
    ...extra,
  })[name];

const config = (overrides: Partial<IndraOcrConfig> = {}): IndraOcrConfig => ({
  engine: "indra",
  url: "https://bmq-ocr.vnagent.ai",
  token: TOKEN,
  timeoutMs: 5000,
  ...overrides,
});

const page = (overrides: Record<string, unknown> = {}) => ({
  rotation: 90,
  skew: 0.2,
  source: "ocr",
  text: "CÔNG TY TNHH BÁNH MÌ\nSố tiền: 1.250.000\nNgày 22/10/2026",
  markdown: "| Nội dung | Số tiền |\n| --- | --- |\n| Bánh mì | 1.250.000 |",
  line_count: 3,
  mean_conf: 0.92,
  lines: [
    { box: [10, 20, 300, 60], text: "CÔNG TY TNHH BÁNH MÌ", conf: 0.95 },
    { box: [10, 80, 300, 120], text: "Số tiền: 1.250.000", conf: 0.92 },
  ],
  width: 1200,
  height: 1600,
  timings: { detect_ms: 12 },
  ...overrides,
});

const okResponse = (pages: unknown[], ms = 55) =>
  Response.json({ engine: "indra-ocr", version: "1.0.0", ms, pages });

function makeFetcher(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { fetcher, calls };
}

test("config enables indra only on an exact trimmed/lowercased match", () => {
  assert.equal(readIndraOcrConfig(env({ SCAN_OCR_ENGINE: "  InDrA  " })).engine, "indra");
  for (const value of [undefined, "", "indrax", "deepseek", " indra x ", "1"]) {
    assert.equal(readIndraOcrConfig(env({ SCAN_OCR_ENGINE: value })).engine, "deepseek");
  }
});

test("config normalizes url/token and clamps the timeout", () => {
  const parsed = readIndraOcrConfig(env({
    INDRA_OCR_URL: "https://bmq-ocr.vnagent.ai///",
    INDRA_OCR_TOKEN: `  ${TOKEN}  `,
    INDRA_OCR_TIMEOUT_MS: "1",
  }));
  assert.equal(parsed.url, "https://bmq-ocr.vnagent.ai");
  assert.equal(parsed.token, TOKEN);
  assert.equal(parsed.timeoutMs, 2000);

  assert.equal(readIndraOcrConfig(env({ INDRA_OCR_TIMEOUT_MS: "99999" })).timeoutMs, 30000);
  assert.equal(readIndraOcrConfig(env({ INDRA_OCR_TIMEOUT_MS: "abc" })).timeoutMs, 12000);
  assert.equal(readIndraOcrConfig(env({ INDRA_OCR_TIMEOUT_MS: "" })).timeoutMs, 12000);
});

test("config accepts plain http only for localhost", () => {
  assert.equal(readIndraOcrConfig(env({ INDRA_OCR_URL: "http://127.0.0.1:8792" })).url, "http://127.0.0.1:8792");
  assert.equal(readIndraOcrConfig(env({ INDRA_OCR_URL: "http://localhost:8792" })).url, "http://localhost:8792");
  assert.equal(readIndraOcrConfig(env({ INDRA_OCR_URL: "http://bmq-ocr.vnagent.ai" })).url, "");
  assert.equal(readIndraOcrConfig(env({ INDRA_OCR_URL: "ftp://bmq-ocr.vnagent.ai" })).url, "");
});

test("callIndraOcr posts raw bytes with the bearer token and returns text", async () => {
  const { fetcher, calls } = makeFetcher(async () => okResponse([page()]));
  const result = await callIndraOcr({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png", config: config(), fetcher });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://bmq-ocr.vnagent.ai/v1/ocr");
  assert.equal(calls[0].init?.method, "POST");
  assert.equal(calls[0].init?.redirect, "error");
  const headers = calls[0].init?.headers as Record<string, string>;
  assert.equal(headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(headers["Content-Type"], "image/png");
  assert.deepEqual([...calls[0].init?.body as Uint8Array], [1, 2, 3]);

  assert.equal(result.rotation, 90);
  assert.equal(result.lineCount, 3);
  assert.equal(result.meanConf, 0.92);
  assert.equal(result.ms, 55);
  assert.equal(result.pages[0].rotation, 90);
  assert.deepEqual(result.pages[0].lines[0].box, [10, 20, 300, 60]);
});

test("base64 input is decoded to raw bytes", async () => {
  const { fetcher, calls } = makeFetcher(async () => okResponse([page()]));
  await callIndraOcr({ base64: "data:image/jpeg;base64,AQID", mimeType: "image/jpeg", config: config(), fetcher });
  assert.deepEqual([...calls[0].init?.body as Uint8Array], [1, 2, 3]);
});

test("multi-page text and markdown are joined with Trang headers", async () => {
  const { fetcher } = makeFetcher(async () => okResponse([
    page({ text: "trang một", markdown: "md một", line_count: 3 }),
    page({ text: "trang hai", markdown: "md hai", line_count: 4 }),
  ]));
  const result = await callIndraOcr({ bytes: new Uint8Array([1]), mimeType: "image/png", config: config(), fetcher });
  assert.match(result.text, /--- Trang 1 ---\ntrang một/);
  assert.match(result.text, /--- Trang 2 ---\ntrang hai/);
  assert.match(result.markdown, /--- Trang 1 ---\nmd một/);
  assert.equal(result.lineCount, 7);
});

test("timeout, http status and bad payload map to IndraOcrError codes", async () => {
  const timeoutFetcher = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
      });
    })) as typeof fetch;
  await assert.rejects(
    () => callIndraOcr({ bytes: new Uint8Array([1]), mimeType: "image/png", config: config({ timeoutMs: 10 }), fetcher: timeoutFetcher }),
    (error: unknown) => error instanceof IndraOcrError && error.code === "timeout",
  );

  const unauthorized = makeFetcher(async () => new Response("{}", { status: 401 }));
  await assert.rejects(
    () => callIndraOcr({ bytes: new Uint8Array([1]), mimeType: "image/png", config: config(), fetcher: unauthorized.fetcher }),
    (error: unknown) => error instanceof IndraOcrError && error.code === "http_401",
  );

  const busy = makeFetcher(async () => new Response("{}", { status: 503 }));
  await assert.rejects(
    () => callIndraOcr({ bytes: new Uint8Array([1]), mimeType: "image/png", config: config(), fetcher: busy.fetcher }),
    (error: unknown) => error instanceof IndraOcrError && error.code === "http_503",
  );

  const broken = makeFetcher(async () => new Response("not json"));
  await assert.rejects(
    () => callIndraOcr({ bytes: new Uint8Array([1]), mimeType: "image/png", config: config(), fetcher: broken.fetcher }),
    (error: unknown) => error instanceof IndraOcrError && error.code === "bad_response",
  );
});

test("empty and low-quality OCR are rejected", async () => {
  const empty = makeFetcher(async () => okResponse([page({ text: "", markdown: "" })]));
  await assert.rejects(
    () => callIndraOcr({ bytes: new Uint8Array([1]), mimeType: "image/png", config: config(), fetcher: empty.fetcher }),
    (error: unknown) => error instanceof IndraOcrError && error.code === "empty_text",
  );

  for (const badPage of [
    page({ line_count: 2 }),
    page({ text: "quá ngắn" }),
    page({ mean_conf: 0.2 }),
  ]) {
    const low = makeFetcher(async () => okResponse([badPage]));
    await assert.rejects(
      () => callIndraOcr({ bytes: new Uint8Array([1]), mimeType: "image/png", config: config(), fetcher: low.fetcher }),
      (error: unknown) => error instanceof IndraOcrError && error.code === "low_quality",
    );
  }
});

test("line count and mean confidence are derived from lines when absent", async () => {
  const { fetcher } = makeFetcher(async () => okResponse([page({
    line_count: undefined,
    mean_conf: undefined,
    lines: [
      { box: [0, 0, 1, 1], text: "a", conf: 0.6 },
      { box: [0, 0, 1, 1], text: "b", conf: 0.8 },
      { box: [0, 0, 1, 1], text: "c", conf: 1 },
      { box: [0, 0, 1, 1], text: "d", conf: 0.8 },
    ],
  })]));
  const result = await callIndraOcr({ bytes: new Uint8Array([1]), mimeType: "image/png", config: config(), fetcher });
  assert.equal(result.lineCount, 4);
  assert.equal(result.meanConf, 0.8);
});

test("rotation maps to the delivery-note top edge and unknown values are null", () => {
  assert.equal(rotationToTextTopEdge(0), "top");
  assert.equal(rotationToTextTopEdge(90), "left");
  assert.equal(rotationToTextTopEdge(180), "bottom");
  assert.equal(rotationToTextTopEdge(270), "right");
  assert.equal(rotationToTextTopEdge(45), null);
  assert.equal(rotationToTextTopEdge(360), null);
});

test("the token never appears in a thrown message", async () => {
  const { fetcher } = makeFetcher(async () => new Response("nope", { status: 403 }));
  await assert.rejects(
    () => callIndraOcr({ bytes: new Uint8Array([1]), mimeType: "image/png", config: config(), fetcher }),
    (error: unknown) => {
      assert.ok(error instanceof IndraOcrError);
      assert.equal(error.code, "http_403");
      assert.equal(String(error.message).includes(TOKEN), false);
      assert.equal(String(error).includes(TOKEN), false);
      return true;
    },
  );
});

test("disabled and not_configured are explicit codes", async () => {
  const { fetcher } = makeFetcher(async () => okResponse([page()]));
  await assert.rejects(
    () => callIndraOcr({ bytes: new Uint8Array([1]), mimeType: "image/png", config: config({ engine: "deepseek" }), fetcher }),
    (error: unknown) => error instanceof IndraOcrError && error.code === "disabled",
  );
  await assert.rejects(
    () => callIndraOcr({ bytes: new Uint8Array([1]), mimeType: "image/png", config: config({ url: "" }), fetcher }),
    (error: unknown) => error instanceof IndraOcrError && error.code === "not_configured",
  );
});
