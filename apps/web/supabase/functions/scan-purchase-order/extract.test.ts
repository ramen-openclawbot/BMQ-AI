// Offline tests for the scan-purchase-order text-first extraction layer.
import { test } from "node:test";
import assert from "node:assert/strict";

import { AiOpenAIError } from "../_shared/openai-errors.ts";
import {
  buildPurchaseOrderPrompts,
  extractPurchaseOrder,
  PURCHASE_ORDER_TOOL,
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

const ocrOk = () => Response.json({
  engine: "indra-ocr",
  version: "1.0.0",
  ms: 6,
  pages: [{
    rotation: 0,
    text: "ĐƠN ĐẶT HÀNG số 001\nBánh mì (kg) 2 10.000 20.000\nTổng tiền hàng 20.000\nNgày 22/10/2026",
    markdown: "| Tên hàng | SL | Đơn giá | Thành tiền |\n| --- | --- | --- | --- |\n| Bánh mì (kg) | 2 | 10.000 | 20.000 |",
    line_count: 3,
    mean_conf: 0.9,
    lines: [
      { box: [0, 0, 10, 10], text: "ĐƠN ĐẶT HÀNG số 001", conf: 0.9 },
      { box: [0, 20, 10, 30], text: "Bánh mì (kg) 2 10.000 20.000", conf: 0.9 },
      { box: [0, 40, 10, 50], text: "Tổng tiền hàng 20.000", conf: 0.9 },
    ],
    width: 100,
    height: 200,
    timings: {},
  }],
});

const validPo = (overrides: Record<string, unknown> = {}) => ({
  po_number: "001",
  supplier_name: "NCC Bánh Mì",
  subtotal_amount: 20000,
  total_amount: 20000,
  vat_amount: 0,
  items: [{ product_name: "Bánh mì (kg)", quantity: 2, unit_price: 10000, line_total: 20000 }],
  ...overrides,
});

const toolAnswer = (data: Record<string, unknown>) => Response.json({
  choices: [{ message: { tool_calls: [{ function: { name: "extract_purchase_order_data", arguments: JSON.stringify(data) } }] } }],
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

test("buildPurchaseOrderPrompts keeps the supplier VAT instruction in both modes", () => {
  const normal = buildPurchaseOrderPrompts({ supplierVatConfig: { vat_included_in_price: false } });
  assert.match(normal.systemPrompt, /6\. Thuế VAT nếu có/);
  assert.equal(normal.userPrompt, "Vui lòng trích xuất tất cả dữ liệu từ đơn đặt hàng này.");
  assert.doesNotMatch(normal.systemPrompt, /giá đã bao gồm VAT trong đơn giá/);

  const included = buildPurchaseOrderPrompts({ supplierVatConfig: { vat_included_in_price: true } });
  assert.match(included.systemPrompt, /LƯU Ý QUAN TRỌNG: NCC này có giá đã bao gồm VAT/);
  assert.match(included.systemPrompt, /không có dòng VAT riêng/);
  assert.equal(PURCHASE_ORDER_TOOL.name, "extract_purchase_order_data");
});

test("the image path sends today's request byte-for-byte when Indra is off", async () => {
  const { fetcher, modelCalls, ocrCalls } = makeFetcher(async () => toolAnswer(validPo()));
  const result = await extractPurchaseOrder({
    imageBase64: "AAAA",
    mimeType: "image/jpeg",
    env: env({ SCAN_OCR_ENGINE: undefined }),
    fetcher,
  });

  assert.equal(result.engine, "deepseek_image");
  assert.equal(result.fallbackReason, null);
  assert.equal(ocrCalls().length, 0);
  assert.equal(modelCalls().length, 1);

  const body = JSON.parse(String(modelCalls()[0].init?.body));
  assert.equal(body.model, "deepseek-flash");
  assert.deepEqual(body.thinking, { type: "disabled" });
  assert.equal(body.messages[0].content.includes("6. Thuế VAT nếu có"), true);
  assert.equal(body.messages[1].content[0].image_url.url, "data:image/jpeg;base64,AAAA");
  assert.equal(body.messages[1].content[1].text, "Vui lòng trích xuất tất cả dữ liệu từ đơn đặt hàng này.");
  assert.deepEqual(body.tool_choice, { type: "function", function: { name: "extract_purchase_order_data" } });
  assert.equal(body.tools[0].function.name, "extract_purchase_order_data");
  assert.deepEqual(body.tools[0].function.parameters.required, ["items"]);
});

test("the indra text path uses OCR text with the same tool and skips the image", async () => {
  const { fetcher, ocrCalls, modelCalls } = makeFetcher(async (url) =>
    url.includes("/v1/ocr") ? ocrOk() : toolAnswer(validPo())
  );
  const result = await extractPurchaseOrder({ imageBase64: "AAAA", mimeType: "image/jpeg", env: env(), fetcher });

  assert.equal(result.engine, "indra_text");
  assert.equal(result.fallbackReason, null);
  assert.equal(ocrCalls().length, 1);
  assert.equal(modelCalls().length, 1);

  const body = JSON.parse(String(modelCalls()[0].init?.body));
  assert.equal(typeof body.messages[1].content, "string");
  assert.match(body.messages[1].content, /<<<OCR>>>/);
  assert.match(body.messages[0].content, /KHÔNG nhận được ảnh/);
  assert.equal(body.tools[0].function.name, "extract_purchase_order_data");
});

test("no items fall back to the image with reason no_items", async () => {
  // Route the first model call (text) to an empty item list and the second to a valid document.
  let call = 0;
  const routed = makeFetcher(async (url) => {
    if (url.includes("/v1/ocr")) return ocrOk();
    call++;
    return toolAnswer(validPo(call === 1 ? { items: [] } : {}));
  });
  const result = await extractPurchaseOrder({ imageBase64: "AAAA", env: env(), fetcher: routed.fetcher });
  assert.equal(result.engine, "deepseek_image");
  assert.equal(result.fallbackReason, "no_items");
  assert.equal(routed.modelCalls().length, 2);
});

test("a total-check warning falls back to the image result", async () => {
  let call = 0;
  const routed = makeFetcher(async (url) => {
    if (url.includes("/v1/ocr")) return ocrOk();
    call++;
    return call === 1
      ? toolAnswer(validPo({ items: [{ product_name: "Bánh mì (kg)", quantity: 2, unit_price: 10000, line_total: 30000 }] }))
      : toolAnswer(validPo());
  });
  const result = await extractPurchaseOrder({ imageBase64: "AAAA", env: env(), fetcher: routed.fetcher });
  assert.equal(result.engine, "deepseek_image");
  assert.equal(result.fallbackReason, "total_check");
});

test("double failure keeps the result with fewer total-check warnings", async () => {
  let call = 0;
  const routed = makeFetcher(async (url) => {
    if (url.includes("/v1/ocr")) return ocrOk();
    call++;
    return call === 1
      ? toolAnswer(validPo({ items: [{ product_name: "A", quantity: 2, unit_price: 10000, line_total: 30000 }] }))
      : toolAnswer(validPo({
        items: [
          { product_name: "B", quantity: 2, unit_price: 10000, line_total: 30000 },
          { product_name: "C", quantity: 5, unit_price: 10000, line_total: 10000 },
        ],
      }));
  });
  const result = await extractPurchaseOrder({ imageBase64: "AAAA", env: env(), fetcher: routed.fetcher });
  // Text has one warning, image has two: text wins even though the image was also attempted.
  assert.equal(result.engine, "indra_text");
  assert.equal(result.fallbackReason, "total_check");
  assert.equal((result.data.items as unknown[]).length, 1);
});

test("quota from the text model is rethrown without an image retry", async () => {
  const routed = makeFetcher(async (url) =>
    url.includes("/v1/ocr")
      ? ocrOk()
      : new Response(JSON.stringify({ error: { message: "insufficient_quota" } }), { status: 402 })
  );
  await assert.rejects(
    () => extractPurchaseOrder({ imageBase64: "AAAA", env: env(), fetcher: routed.fetcher }),
    (error: unknown) => error instanceof AiOpenAIError && error.info.kind === "quota",
  );
  assert.equal(routed.modelCalls().length, 1);
});
