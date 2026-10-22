// Offline tests for the scan-invoice text-first extraction layer.
import { test } from "node:test";
import assert from "node:assert/strict";

import { AiOpenAIError } from "../_shared/openai-errors.ts";
import {
  buildInvoicePrompts,
  extractCashReceipt,
  extractInvoicePage,
  INVOICE_TOOL,
} from "./extract.ts";

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

const ocrOk = (pages = 1) => Response.json({
  engine: "indra-ocr",
  version: "1.0.0",
  ms: 5,
  pages: Array.from({ length: pages }, () => ({
    rotation: 0,
    text: "PHIẾU CHI TIỀN MẶT\nTổng tiền: 81.000\nNgày 22/10/2026",
    markdown: "| Nội dung | Số tiền |\n| --- | --- |\n| Nước | 81.000 |",
    line_count: 3,
    mean_conf: 0.9,
    lines: [
      { box: [0, 0, 10, 10], text: "PHIẾU CHI TIỀN MẶT", conf: 0.9 },
      { box: [0, 20, 10, 30], text: "Tổng tiền: 81.000", conf: 0.9 },
      { box: [0, 40, 10, 50], text: "Ngày 22/10/2026", conf: 0.9 },
    ],
    width: 100,
    height: 200,
    timings: {},
  })),
});

const toolAnswer = (name: string, data: Record<string, unknown>) => Response.json({
  choices: [{ message: { tool_calls: [{ function: { name, arguments: JSON.stringify(data) } }] } }],
});

const prompts = {
  supplierList: [{ id: "s1", name: "NCC Bánh Mì" }],
  templates: [{
    supplier_name_key: "ncc banh mi",
    template_json: { preferred_supplier_name: "NCC Bánh Mì", aliases: ["Bánh Mì"], header_hint: "NCC" },
  }],
  aliases: [{ supplier_id: "s1", alias_text: "Bánh Mì SG" }],
};

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

test("buildInvoicePrompts keeps the supplier list, learned templates and aliases", () => {
  const built = buildInvoicePrompts(prompts);
  assert.match(built.systemPrompt, /Known supplier master data/);
  assert.match(built.systemPrompt, /- NCC Bánh Mì/);
  assert.match(built.systemPrompt, /Learned supplier templates/);
  assert.match(built.systemPrompt, /key=ncc banh mi/);
  assert.match(built.systemPrompt, /Known aliases/);
  assert.match(built.systemPrompt, /Bánh Mì SG => NCC Bánh Mì/);
  assert.equal(built.userPrompt, "Please extract all invoice data from this image.");
  assert.equal(INVOICE_TOOL.name, "extract_invoice_data");
});

test("cash receipt indra text path returns the normalized receipt", async () => {
  const routed = makeFetcher(async (url) =>
    url.includes("/v1/ocr")
      ? ocrOk()
      : toolAnswer("extract_cash_receipt", { total_amount: 81000, payee_name: "Quán Nước", description: "Nước 19L" })
  );
  const result = await extractCashReceipt({ imageBase64: "AAAA", mimeType: "image/jpeg", env: env(), fetcher: routed.fetcher });
  assert.equal(result.engine, "indra_text");
  assert.equal(result.fallbackReason, null);
  assert.equal(result.data?.total_amount, 81000);
  assert.equal(routed.ocrCalls().length, 1);
  assert.equal(routed.modelCalls().length, 1);
  const body = JSON.parse(String(routed.modelCalls()[0].init?.body));
  assert.equal(body.tools[0].function.name, "extract_cash_receipt");
  assert.match(body.messages[1].content, /<<<OCR>>>/);
});

test("cash receipt falls back to today's unchanged image request", async () => {
  const routed = makeFetcher(async (url) =>
    url.includes("/v1/ocr")
      ? new Response("{}", { status: 500 })
      : toolAnswer("extract_cash_receipt", { total_amount: 81000 })
  );
  const result = await extractCashReceipt({ imageBase64: "AAAA", mimeType: "image/jpeg", env: env(), fetcher: routed.fetcher });
  assert.equal(result.engine, "deepseek_image");
  assert.equal(result.fallbackReason, "http_500");
  assert.equal(result.data?.total_amount, 81000);

  const body = JSON.parse(String(routed.modelCalls()[0].init?.body));
  assert.equal(body.messages[0].content.includes("chứng từ chi tiền mặt"), true);
  assert.equal(body.messages[1].content[0].image_url.url, "data:image/jpeg;base64,AAAA");
  assert.equal(body.messages[1].content[1].text, "Đọc số tiền thực trả, người nhận tiền và nội dung ngắn gọn từ chứng từ chi tiền mặt này.");
  assert.deepEqual(body.tool_choice, { type: "function", function: { name: "extract_cash_receipt" } });
});

test("invoice indra text path uses the supplier prompt and OCR text", async () => {
  const routed = makeFetcher(async (url) =>
    url.includes("/v1/ocr")
      ? ocrOk(2)
      : toolAnswer("extract_invoice_data", {
          invoice_number: "HD-001",
          supplier_name: "NCC Bánh Mì",
          items: [{ product_name: "Bột mì", quantity: 2, unit: "kg", unit_price: 10000 }],
        })
  );
  const result = await extractInvoicePage({
    imageBase64: "AAAA",
    mimeType: "image/jpeg",
    ...prompts,
    env: env(),
    fetcher: routed.fetcher,
  });
  assert.equal(result.engine, "indra_text");
  assert.equal(result.fallbackReason, null);
  assert.equal(result.ocrPageCount, 2);
  assert.equal(result.data.invoice_number, "HD-001");

  const body = JSON.parse(String(routed.modelCalls()[0].init?.body));
  assert.equal(typeof body.messages[1].content, "string");
  assert.match(body.messages[0].content, /Known supplier master data/);
  assert.equal(body.tools[0].function.name, "extract_invoice_data");
});

test("invoice image path stays unchanged when Indra is off", async () => {
  const routed = makeFetcher(async () => toolAnswer("extract_invoice_data", { invoice_number: "HD-001", items: [] }));
  const result = await extractInvoicePage({
    imageBase64: "AAAA",
    ...prompts,
    env: env({ SCAN_OCR_ENGINE: undefined }),
    fetcher: routed.fetcher,
  });
  assert.equal(result.engine, "deepseek_image");
  assert.equal(result.fallbackReason, null);
  assert.equal(routed.ocrCalls().length, 0);

  const body = JSON.parse(String(routed.modelCalls()[0].init?.body));
  assert.equal(body.model, "deepseek-flash");
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.messages[1].content[0].image_url.url, "data:image/jpeg;base64,AAAA");
  assert.equal(body.messages[1].content[1].text, "Please extract all invoice data from this image.");
  assert.deepEqual(body.tool_choice, { type: "function", function: { name: "extract_invoice_data" } });
  assert.deepEqual(body.tools[0].function.parameters.required, ["items"]);
});

test("invoice falls back with no_items, but an invoice_number alone is accepted", async () => {
  let call = 0;
  const routed = makeFetcher(async (url) => {
    if (url.includes("/v1/ocr")) return ocrOk();
    call++;
    return toolAnswer("extract_invoice_data", call === 1 ? { items: [] } : { items: [] });
  });
  const result = await extractInvoicePage({
    imageBase64: "AAAA",
    ...prompts,
    env: env(),
    fetcher: routed.fetcher,
  });
  assert.equal(result.engine, "deepseek_image");
  assert.equal(result.fallbackReason, "no_items");

  const numberOnly = makeFetcher(async (url) =>
    url.includes("/v1/ocr") ? ocrOk() : toolAnswer("extract_invoice_data", { invoice_number: "HD-002", items: [] })
  );
  const accepted = await extractInvoicePage({
    imageBase64: "AAAA",
    ...prompts,
    env: env(),
    fetcher: numberOnly.fetcher,
  });
  assert.equal(accepted.engine, "indra_text");
  assert.equal(accepted.data.invoice_number, "HD-002");
});

test("quota from the invoice text model is rethrown without an image retry", async () => {
  const routed = makeFetcher(async (url) =>
    url.includes("/v1/ocr")
      ? ocrOk()
      : new Response(JSON.stringify({ error: { message: "insufficient_quota" } }), { status: 402 })
  );
  await assert.rejects(
    () => extractInvoicePage({ imageBase64: "AAAA", ...prompts, env: env(), fetcher: routed.fetcher }),
    (error: unknown) => error instanceof AiOpenAIError && error.info.kind === "quota",
  );
  assert.equal(routed.modelCalls().length, 1);
});
