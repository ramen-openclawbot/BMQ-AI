// Offline tests for the kho-review-read-line handler.
// Indra, DeepSeek, storage and the database are injected fakes: no network, no
// paid request and no real BMQ data.  The handler is exercised over a real
// Request/Response pair.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KHO_REVIEW_READ_LINE_PROMPT_VERSION,
  KhoReviewReadLineError,
  createKhoReviewReadLineHandler,
  normalizeDocumentUnit,
  parseKhoReviewReadLineInput,
  type KhoReviewLineContext,
  type KhoReviewReadLineDeps,
} from "./handler.ts";
import { IndraOcrError, type IndraOcrConfig, type IndraOcrResult } from "../_shared/indra-ocr.ts";
import type { CallDeepSeekJsonOptions } from "../_shared/deepseek-json.ts";

const RECEIPT_ITEM_ID = "11111111-1111-4111-8111-111111111111";
const IMAGE_PATH = "goods-receipts/grn-435.jpg";

const CONTEXT: KhoReviewLineContext = {
  receipt_item_id: RECEIPT_ITEM_ID,
  product_name: "Bao tay y tế đen size M",
  unit: "kg",
  actual_quantity: 7,
  unit_price: 120000,
  receipt_number: "GRN-000435",
  supplier_name: "NCC A",
  location: "q7",
  image_url: IMAGE_PATH,
  product_photos: [],
  image_paths: [IMAGE_PATH],
  posted: false,
  linked_item_id: null,
};

const INDRA_CONFIG: IndraOcrConfig = {
  engine: "indra",
  url: "https://indra.example.test",
  token: "test-token",
  timeoutMs: 5_000,
};

function indraResult(text: string): IndraOcrResult {
  return {
    text,
    markdown: text,
    rotation: 0,
    lineCount: 4,
    meanConf: 0.92,
    ms: 12,
    pages: [{
      rotation: 0,
      skew: null,
      source: null,
      text,
      markdown: text,
      lineCount: 4,
      meanConf: 0.92,
      lines: [],
      width: 100,
      height: 100,
      timings: null,
    }],
  };
}

const FOUND_ANSWER: Record<string, unknown> = {
  found: true,
  printed_name: "Bao tay y tế đen size M",
  doc_unit: "hộp",
  doc_quantity: 7,
  doc_unit_price: 120000,
  line_total: 840000,
  pack_count: 100,
  pack_unit: "cái",
  evidence_text: "Bao tay y tế đen size M 7 hộp (Hộp 100 cái)",
};

function request(body: unknown): Request {
  return new Request("https://example.test/functions/v1/kho-review-read-line", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://ai.banhmique.vn" },
    body: JSON.stringify(body),
  });
}

interface FakeState {
  indraCalls: number;
  imageCalls: number;
  deepSeekCalls: CallDeepSeekJsonOptions[];
  saved: Record<string, unknown>[];
  audit: Record<string, unknown>[];
}

function fakeDeps(
  overrides: Partial<KhoReviewReadLineDeps> = {},
  state: FakeState = {
    indraCalls: 0,
    imageCalls: 0,
    deepSeekCalls: [],
    saved: [],
    audit: [],
  },
): { deps: KhoReviewReadLineDeps; state: FakeState } {
  const deps: KhoReviewReadLineDeps = {
    authenticate: async () => ({
      userId: "user-1",
      loadContext: async () => CONTEXT,
    }),
    loadImages: async () => {
      state.imageCalls += 1;
      return [{ base64: "aGVsbG8=", mimeType: "image/jpeg" }];
    },
    loadCached: async () => null,
    saveCached: async (row) => { state.saved.push(row); },
    indraConfig: () => INDRA_CONFIG,
    callIndraOcr: async () => {
      state.indraCalls += 1;
      return indraResult("Bao tay y tế đen size M 7 hộp (Hộp 100 cái)");
    },
    callDeepSeekJson: async (options) => {
      state.deepSeekCalls.push(options);
      return FOUND_ANSWER;
    },
    audit: (event) => { state.audit.push(event); },
    ...overrides,
  };
  return { deps, state };
}

test("the Indra path reads 7 hộp with pack 100 cái and flags the kg mismatch", async () => {
  const { deps, state } = fakeDeps();
  const handler = createKhoReviewReadLineHandler(deps);

  const response = await handler(request({ receipt_item_id: RECEIPT_ITEM_ID }));
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;

  assert.equal(body.ok, true);
  assert.equal(body.found, true);
  assert.equal(body.doc_unit, "hộp");
  assert.equal(body.doc_quantity, 7);
  assert.equal(body.doc_unit_price, 120000);
  assert.equal(body.pack_count, 100);
  assert.equal(body.pack_unit, "cái");
  assert.equal(body.unit_mismatch, true);
  assert.equal(body.ocr_engine, "indra");
  assert.equal(body.ocr_fallback_reason, null);
  assert.equal(body.cached, false);

  assert.equal(state.indraCalls, 1);
  assert.equal(state.imageCalls, 1);
  assert.equal(state.deepSeekCalls.length, 1);
  assert.equal(state.deepSeekCalls[0].images, undefined);
  assert.equal(state.saved.length, 1);
  assert.equal(state.saved[0].ocrEngine, "indra");
  assert.equal(state.saved[0].promptVersion, KHO_REVIEW_READ_LINE_PROMPT_VERSION);
  assert.equal(state.audit.length, 1);
  assert.deepEqual(Object.keys(state.audit[0]).sort(), [
    "engine",
    "fallback_reason",
    "fn",
    "ocr_ms",
    "total_ms",
  ]);
});

test("Indra down falls back to the DeepSeek image path with the reason", async () => {
  const state: FakeState = {
    indraCalls: 0,
    imageCalls: 0,
    deepSeekCalls: [],
    saved: [],
    audit: [],
  };
  const { deps } = fakeDeps({
    callIndraOcr: async () => {
      state.indraCalls += 1;
      throw new IndraOcrError("timeout");
    },
    callDeepSeekJson: async (options) => {
      state.deepSeekCalls.push(options);
      return FOUND_ANSWER;
    },
  }, state);
  const handler = createKhoReviewReadLineHandler(deps);

  const response = await handler(request({ receipt_item_id: RECEIPT_ITEM_ID }));
  const body = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(body.ocr_engine, "deepseek");
  assert.equal(body.ocr_fallback_reason, "timeout");
  assert.equal(body.found, true);
  assert.equal(body.doc_unit, "hộp");
  assert.equal(state.indraCalls, 1);
  assert.equal(state.deepSeekCalls.length, 1);
  assert.equal(state.deepSeekCalls[0].images?.length, 1);
});

test("a row that is not on the document returns found false", async () => {
  const { deps, state } = fakeDeps({
    callDeepSeekJson: async (options) => {
      state.deepSeekCalls.push(options);
      return {
        found: false,
        printed_name: null,
        doc_unit: null,
        doc_quantity: null,
        doc_unit_price: null,
        line_total: null,
        pack_count: null,
        pack_unit: null,
        evidence_text: null,
      };
    },
  });
  const handler = createKhoReviewReadLineHandler(deps);

  const response = await handler(request({ receipt_item_id: RECEIPT_ITEM_ID }));
  const body = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.found, false);
  assert.equal(body.doc_unit, null);
  assert.equal(body.doc_quantity, null);
  assert.equal(body.unit_mismatch, false);
  // Indra text missed the row, so the image path looked too before answering.
  assert.equal(body.ocr_engine, "deepseek");
  assert.equal(body.ocr_fallback_reason, "indra_not_found");
  assert.equal(state.deepSeekCalls.length, 2);
  assert.equal(state.deepSeekCalls[1].images?.length, 1);
});

test("a cached read for the same image set skips OCR and DeepSeek", async () => {
  const { deps, state } = fakeDeps({
    loadCached: async (key) => {
      assert.equal(key.receiptItemId, RECEIPT_ITEM_ID);
      assert.equal(key.promptVersion, KHO_REVIEW_READ_LINE_PROMPT_VERSION);
      assert.equal(key.imagesSha.length, 64);
      return {
        result: { ...FOUND_ANSWER, ocr_fallback_reason: null },
        ocr_engine: "indra",
      };
    },
    loadImages: async () => {
      state.imageCalls += 1;
      throw new Error("loadImages must not run on a cache hit");
    },
    callIndraOcr: async () => {
      state.indraCalls += 1;
      throw new Error("Indra must not run on a cache hit");
    },
    callDeepSeekJson: async (options) => {
      state.deepSeekCalls.push(options);
      throw new Error("DeepSeek must not run on a cache hit");
    },
  });
  const handler = createKhoReviewReadLineHandler(deps);

  const response = await handler(request({ receipt_item_id: RECEIPT_ITEM_ID }));
  const body = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(body.cached, true);
  assert.equal(body.ocr_engine, "indra");
  assert.equal(body.found, true);
  assert.equal(body.unit_mismatch, true);
  assert.equal(state.indraCalls, 0);
  assert.equal(state.imageCalls, 0);
  assert.equal(state.deepSeekCalls.length, 0);
});

test("a forbidden caller gets code forbidden and no context read", async () => {
  const { deps, state } = fakeDeps({
    authenticate: async () => {
      throw new KhoReviewReadLineError("forbidden", 403);
    },
    callIndraOcr: async () => {
      state.indraCalls += 1;
      throw new Error("must not run");
    },
  });
  const handler = createKhoReviewReadLineHandler(deps);

  const response = await handler(request({ receipt_item_id: RECEIPT_ITEM_ID }));
  const body = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 403);
  assert.equal(body.ok, false);
  assert.equal(body.code, "forbidden");
  assert.equal(state.indraCalls, 0);
});

test("invalid DeepSeek JSON is rejected as ocr_failed", async () => {
  const { deps } = fakeDeps({
    indraConfig: () => ({ ...INDRA_CONFIG, engine: "deepseek" }),
    callDeepSeekJson: async () => ({
      found: true,
      printed_name: "Bao tay y tế đen size M",
      doc_unit: "hộp",
      doc_quantity: 0,
      doc_unit_price: 120000,
      line_total: 0,
      pack_count: 100,
      pack_unit: "cái",
      evidence_text: "so 0 is not a printed quantity",
    }),
  });
  const handler = createKhoReviewReadLineHandler(deps);

  const response = await handler(request({ receipt_item_id: RECEIPT_ITEM_ID }));
  const body = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 502);
  assert.equal(body.ok, false);
  assert.equal(body.code, "ocr_failed");
});

test("a line without an image returns no_image before any OCR", async () => {
  const { deps, state } = fakeDeps({
    authenticate: async () => ({
      userId: "user-1",
      loadContext: async () => ({ ...CONTEXT, image_url: null, product_photos: [], image_paths: [] }),
    }),
    callIndraOcr: async () => {
      state.indraCalls += 1;
      throw new Error("must not run");
    },
  });
  const handler = createKhoReviewReadLineHandler(deps);

  const response = await handler(request({ receipt_item_id: RECEIPT_ITEM_ID }));
  const body = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 422);
  assert.equal(body.code, "no_image");
  assert.equal(state.indraCalls, 0);
});

test("input parsing and unit normalization mirror the database rules", () => {
  assert.deepEqual(
    parseKhoReviewReadLineInput({ receipt_item_id: ` ${RECEIPT_ITEM_ID} ` }),
    { receiptItemId: RECEIPT_ITEM_ID },
  );
  assert.throws(() => parseKhoReviewReadLineInput({ receipt_item_id: "nope" }));
  assert.throws(() => parseKhoReviewReadLineInput({ receipt_item_id: RECEIPT_ITEM_ID, extra: 1 }));

  assert.equal(normalizeDocumentUnit("(KG)"), "kg");
  assert.equal(normalizeDocumentUnit("Hộp (pack)"), "hộp");
  assert.equal(normalizeDocumentUnit("Ký"), "kg");
  assert.equal(normalizeDocumentUnit("B bao"), "bao");
  assert.equal(normalizeDocumentUnit("  "), null);
});
