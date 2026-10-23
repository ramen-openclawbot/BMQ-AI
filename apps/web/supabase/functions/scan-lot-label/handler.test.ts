// Offline tests for the scan-lot-label handler.
// Indra, DeepSeek and storage are injected fakes: no network, no paid request
// and no real BMQ data.  The handler is exercised over a real Request/Response.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCAN_LOT_LABEL_PROMPT_VERSION,
  ScanLotLabelError,
  addMonthsIso,
  createScanLotLabelHandler,
  hasAnyLotLabelValue,
  imageMimeFromPath,
  mergeLotLabelFields,
  normalizeLotDate,
  parseLotLabelAnswer,
  parseLotLabelText,
  parseScanImagePath,
  parseScanLotLabelInput,
  relativeExpiryFromText,
  type ScanLotLabelDeps,
} from "./handler.ts";
import { IndraOcrError, type IndraOcrConfig, type IndraOcrResult } from "../_shared/indra-ocr.ts";
import { DeepSeekJsonError, type CallDeepSeekJsonOptions } from "../_shared/deepseek-json.ts";

const IMAGE_PATH = "warehouse-photos/labels/lot-435.jpg";

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

const ALL_NULL = {
  manufacture_date: null,
  expiry_date: null,
  lot: null,
  manufacturer: null,
  product_name: null,
  evidence_text: null,
};

function request(body: unknown): Request {
  return new Request("https://example.test/functions/v1/scan-lot-label", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://ai.banhmique.vn" },
    body: JSON.stringify(body),
  });
}

interface FakeState {
  indraCalls: number;
  imageCalls: number;
  deepSeekCalls: CallDeepSeekJsonOptions[];
  audit: Record<string, unknown>[];
}

function newState(): FakeState {
  return { indraCalls: 0, imageCalls: 0, deepSeekCalls: [], audit: [] };
}

function fakeDeps(
  overrides: Partial<ScanLotLabelDeps> = {},
  state: FakeState = newState(),
): { deps: ScanLotLabelDeps; state: FakeState } {
  const deps: ScanLotLabelDeps = {
    authenticate: async () => ({ userId: "user-1" }),
    loadImageFromPath: async () => {
      state.imageCalls += 1;
      return { base64: "aGVsbG8=", mimeType: "image/jpeg" };
    },
    indraConfig: () => INDRA_CONFIG,
    callIndraOcr: async () => {
      state.indraCalls += 1;
      return indraResult([
        "NHÀ SẢN XUẤT: CÔNG TY BÁNH MÌ ABC",
        "TÊN SẢN PHẨM: Bột bánh mì",
        "NSX: 01/01/2026",
        "HSD: 31.12.26",
        "LOT: L260101A",
      ].join("\n"));
    },
    callDeepSeekJson: async (options) => {
      state.deepSeekCalls.push(options);
      return { ...ALL_NULL };
    },
    audit: (event) => { state.audit.push(event); },
    ...overrides,
  };
  return { deps, state };
}

test("the Indra path reads NSX/HSD/lot/manufacturer, then DeepSeek text fills the gaps", async () => {
  const { deps, state } = fakeDeps();
  const handler = createScanLotLabelHandler(deps);

  const response = await handler(request({ image_path: IMAGE_PATH }));
  const body = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.manufacture_date, "2026-01-01");
  assert.equal(body.expiry_date, "2026-12-31");
  assert.equal(body.lot, "L260101A");
  assert.equal(body.manufacturer, "CÔNG TY BÁNH MÌ ABC");
  assert.equal(body.product_name, "Bột bánh mì");
  assert.equal(body.ocr_engine, "indra");
  assert.equal(body.ocr_fallback_reason, null);

  assert.equal(state.imageCalls, 1);
  assert.equal(state.indraCalls, 1);
  assert.equal(state.deepSeekCalls.length, 1);
  assert.equal(state.deepSeekCalls[0].images, undefined);
  assert.match(String(state.deepSeekCalls[0].userText), /NSX: 01\/01\/2026/);
  assert.equal(state.audit.length, 1);
  assert.equal(state.audit[0].engine, "indra");
});

test("Indra down falls back to the DeepSeek image path with the reason", async () => {
  const state = newState();
  const { deps } = fakeDeps({
    callIndraOcr: async () => {
      state.indraCalls += 1;
      throw new IndraOcrError("timeout");
    },
    callDeepSeekJson: async (options) => {
      state.deepSeekCalls.push(options);
      return {
        manufacture_date: "2026-02-01",
        expiry_date: "2026-08-01",
        lot: "LOT-XYZ",
        manufacturer: "Nhà máy B",
        product_name: "Sữa tươi",
        evidence_text: "NSX 01/02/2026 HSD 01/08/2026",
      };
    },
  }, state);
  const handler = createScanLotLabelHandler(deps);

  const response = await handler(request({ image_path: IMAGE_PATH }));
  const body = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(body.ocr_engine, "deepseek");
  assert.equal(body.ocr_fallback_reason, "timeout");
  assert.equal(body.manufacture_date, "2026-02-01");
  assert.equal(body.expiry_date, "2026-08-01");
  assert.equal(body.lot, "LOT-XYZ");
  assert.equal(state.indraCalls, 1);
  assert.equal(state.deepSeekCalls.length, 1);
  assert.equal(state.deepSeekCalls[0].images?.length, 1);
});

test("an inline base64 image skips storage and uses the DeepSeek image path", async () => {
  const state = newState();
  const { deps } = fakeDeps({
    indraConfig: () => ({ ...INDRA_CONFIG, engine: "deepseek" }),
    loadImageFromPath: async () => {
      state.imageCalls += 1;
      throw new Error("storage must not run for inline base64");
    },
    callDeepSeekJson: async (options) => {
      state.deepSeekCalls.push(options);
      return { ...ALL_NULL, lot: "INLINE-1" };
    },
  }, state);
  const handler = createScanLotLabelHandler(deps);

  const response = await handler(request({ image_base64: "aGVsbG8=", mime_type: "image/png" }));
  const body = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(body.lot, "INLINE-1");
  assert.equal(state.imageCalls, 0);
  assert.equal(state.deepSeekCalls.length, 1);
  assert.equal(state.deepSeekCalls[0].images?.[0].mimeType, "image/png");
});

test("missing fields stay null and never invent a date", async () => {
  const state = newState();
  const { deps } = fakeDeps({
    indraConfig: () => ({ ...INDRA_CONFIG, engine: "deepseek" }),
    callDeepSeekJson: async (options) => {
      state.deepSeekCalls.push(options);
      return { ...ALL_NULL };
    },
  }, state);
  const handler = createScanLotLabelHandler(deps);

  const response = await handler(request({ image_path: IMAGE_PATH }));
  const body = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.manufacture_date, null);
  assert.equal(body.expiry_date, null);
  assert.equal(body.lot, null);
  assert.equal(body.manufacturer, null);
  assert.equal(body.product_name, null);
});

test("a label with no readable lot falls back once to the image path and still returns nulls", async () => {
  const state = newState();
  const { deps } = fakeDeps({
    callIndraOcr: async () => {
      state.indraCalls += 1;
      return indraResult("Bao bì trắng");
    },
    callDeepSeekJson: async (options) => {
      state.deepSeekCalls.push(options);
      return { ...ALL_NULL };
    },
  }, state);
  const handler = createScanLotLabelHandler(deps);

  const response = await handler(request({ image_path: IMAGE_PATH }));
  const body = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(body.ocr_engine, "deepseek");
  assert.equal(body.ocr_fallback_reason, "indra_empty");
  assert.equal(body.manufacture_date, null);
  assert.equal(state.deepSeekCalls.length, 2);
  assert.equal(state.deepSeekCalls[0].images, undefined);
  assert.equal(state.deepSeekCalls[1].images?.length, 1);
});

test("bad model JSON is rejected as ocr_failed", async () => {
  const { deps } = fakeDeps({
    indraConfig: () => ({ ...INDRA_CONFIG, engine: "deepseek" }),
    callDeepSeekJson: async () => {
      throw new DeepSeekJsonError();
    },
  });
  const handler = createScanLotLabelHandler(deps);

  const response = await handler(request({ image_path: IMAGE_PATH }));
  const body = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 502);
  assert.equal(body.ok, false);
  assert.equal(body.code, "ocr_failed");
});

test("a missing storage object returns no_image before any OCR", async () => {
  const { deps, state } = fakeDeps({
    loadImageFromPath: async () => {
      state.imageCalls += 1;
      return null;
    },
    callIndraOcr: async () => {
      state.indraCalls += 1;
      throw new Error("must not run");
    },
  });
  const handler = createScanLotLabelHandler(deps);

  const response = await handler(request({ image_path: "warehouse-photos/missing.jpg" }));
  const body = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 422);
  assert.equal(body.code, "no_image");
  assert.equal(state.indraCalls, 0);
});

test("authenticate failure returns unauthorized", async () => {
  const { deps } = fakeDeps({
    authenticate: async () => {
      throw new ScanLotLabelError("unauthorized", 401);
    },
  });
  const handler = createScanLotLabelHandler(deps);

  const response = await handler(request({ image_path: IMAGE_PATH }));
  const body = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 401);
  assert.equal(body.code, "unauthorized");
});

test("Vietnamese and English date formats normalize; impossible dates are null", () => {
  assert.equal(normalizeLotDate("2026-01-31"), "2026-01-31");
  assert.equal(normalizeLotDate("31/01/2026"), "2026-01-31");
  assert.equal(normalizeLotDate("31.01.26"), "2026-01-31");
  assert.equal(normalizeLotDate("31-01-2026"), "2026-01-31");
  assert.equal(normalizeLotDate("2026-01-31T07:30:00Z"), "2026-01-31");
  assert.equal(normalizeLotDate("31/02/2026"), null);
  assert.equal(normalizeLotDate(""), null);
  assert.equal(normalizeLotDate(null), null);
});

test("text parsing understands NSX/MFG and HSD/EXP/Best before lines", () => {
  assert.equal(parseLotLabelText("NSX: 01/02/2026\nHSD: 01/08/2026").manufacture_date, "2026-02-01");
  assert.equal(parseLotLabelText("MFG 01.02.26\nEXP 01.08.26").expiry_date, "2026-08-01");
  assert.equal(
    parseLotLabelText("Best before 12/12/2026\nBatch: B2601").expiry_date,
    "2026-12-12",
  );
  assert.equal(parseLotLabelText("Batch: B2601").lot, "B2601");
  assert.equal(parseLotLabelText("Bao bì trắng").manufacture_date, null);
});

test("relative shelf-life wording computes expiry from NSX", () => {
  const text = [
    "NSX: 01/01/2026",
    "Hạn sử dụng: 12 tháng kể từ ngày sản xuất",
  ].join("\n");
  assert.equal(parseLotLabelText(text).expiry_date, "2027-01-01");

  assert.equal(
    parseLotLabelText("NSX 31/01/2026\nSử dụng trong 1 tháng").expiry_date,
    "2026-02-28",
  );
  assert.equal(
    parseLotLabelText("MFG 01/01/2026\nUse within 30 days").expiry_date,
    "2026-01-31",
  );
  assert.equal(relativeExpiryFromText("Sử dụng trong 2 năm", "2026-01-01"), "2028-01-01");
  assert.equal(addMonthsIso("2026-01-31", 1), "2026-02-28");
  assert.equal(relativeExpiryFromText("Sử dụng trong 12 tháng", null), null);
});

test("model and text fields merge without guessing", () => {
  const model = parseLotLabelAnswer({
    manufacture_date: "01/02/2026",
    expiry_date: null,
    lot: "M-1",
    manufacturer: null,
    product_name: "Bánh",
    evidence_text: "NSX 01/02/2026",
  });
  const text = parseLotLabelText("NSX: 01/02/2026\nHSD: 01/03/2026\nLOT: T-9");
  const merged = mergeLotLabelFields(model, text);

  assert.equal(merged.manufacture_date, "2026-02-01");
  assert.equal(merged.expiry_date, "2026-03-01");
  assert.equal(merged.lot, "M-1");
  assert.equal(merged.product_name, "Bánh");
  assert.equal(hasAnyLotLabelValue(merged), true);
  assert.equal(hasAnyLotLabelValue(ALL_NULL as never), false);
});

test("input parsing requires exactly one image source", () => {
  assert.deepEqual(parseScanLotLabelInput({ image_path: " warehouse-photos/a.jpg " }), {
    imagePath: "warehouse-photos/a.jpg",
  });
  assert.deepEqual(parseScanLotLabelInput({ image_base64: "aGVsbG8=", mime_type: "image/jpeg" }), {
    imageBase64: "aGVsbG8=",
    mimeType: "image/jpeg",
  });
  assert.throws(() => parseScanLotLabelInput({}));
  assert.throws(() => parseScanLotLabelInput({ image_path: "a", image_base64: "b", mime_type: "image/jpeg" }));
  assert.throws(() => parseScanLotLabelInput({ image_base64: "aGVsbG8=" }));
  assert.throws(() => parseScanLotLabelInput({ image_path: "a", extra: 1 }));
});

test("storage paths resolve only to warehouse-photos or invoices", () => {
  assert.deepEqual(parseScanImagePath("warehouse-photos/labels/a.jpg"), {
    bucket: "warehouse-photos",
    path: "labels/a.jpg",
  });
  assert.deepEqual(parseScanImagePath("invoices/goods-receipts/a.jpg"), {
    bucket: "invoices",
    path: "goods-receipts/a.jpg",
  });
  assert.deepEqual(parseScanImagePath("labels/a.jpg"), {
    bucket: "warehouse-photos",
    path: "labels/a.jpg",
  });
  assert.deepEqual(
    parseScanImagePath("https://x.test/storage/v1/object/sign/invoices/goods-receipts/a.jpg?token=t"),
    { bucket: "invoices", path: "goods-receipts/a.jpg" },
  );
  assert.equal(parseScanImagePath("payment-slips/a.jpg"), null);
  assert.equal(parseScanImagePath("warehouse-photos/../a.jpg"), null);
  assert.equal(parseScanImagePath(""), null);
  assert.equal(imageMimeFromPath("a.PNG"), "image/png");
  assert.equal(imageMimeFromPath("a.jpg"), "image/jpeg");
});

test("the prompt version is stable for cache-free callers", () => {
  assert.equal(SCAN_LOT_LABEL_PROMPT_VERSION, "scan-lot-label-v1");
});
