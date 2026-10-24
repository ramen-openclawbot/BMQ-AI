// Offline tests for the scan-food-cert handler.
// Indra, DeepSeek, storage and the checklist are injected fakes: no network,
// no paid request and no real BMQ data.  The handler is exercised over a real
// Request/Response.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INDRA_SUPPORTS_PDF,
  ScanFoodCertError,
  addValidityYearsMinusOneDay,
  certMimeFromPath,
  createScanFoodCertHandler,
  hasAnyFoodCertValue,
  matchFoodCertHolder,
  normalizePartyName,
  parseFoodCertAnswer,
  parseScanFoodCertInput,
  parseValidityYears,
  type ScanFoodCertDeps,
} from "./handler.ts";
import { IndraOcrError, type IndraOcrConfig, type IndraOcrResult } from "../_shared/indra-ocr.ts";
import { DeepSeekJsonError, type CallDeepSeekJsonOptions } from "../_shared/deepseek-json.ts";

const FILE_PATH = "certs/abc/giay-attp.pdf";

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

function request(body: unknown): Request {
  return new Request("https://example.test/functions/v1/scan-food-cert", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://ai.banhmique.vn" },
    body: JSON.stringify(body),
  });
}

const ANSWER = {
  cert_type: "attp_facility",
  holder_name: "CÔNG TY TNHH BÁNH MÌ ABC",
  cert_no: "ATTP-123",
  issuer: "Chi cục An toàn vệ sinh thực phẩm",
  issued_on: "01/01/2024",
  expires_on: "31/12/2026",
  validity_years: null,
  product_name: "Bánh mì",
  evidence: {
    holder: "CÔNG TY TNHH BÁNH MÌ ABC",
    cert_no: "Số: ATTP-123",
    expires: "có hiệu lực đến 31/12/2026",
  },
};

interface FakeState {
  indraCalls: number;
  fileCalls: number;
  deepSeekCalls: CallDeepSeekJsonOptions[];
  gateCalls: number;
  audit: Record<string, unknown>[];
}

function newState(): FakeState {
  return { indraCalls: 0, fileCalls: 0, deepSeekCalls: [], gateCalls: 0, audit: [] };
}

function fakeDeps(
  overrides: Partial<ScanFoodCertDeps> = {},
  state: FakeState = newState(),
): { deps: ScanFoodCertDeps; state: FakeState } {
  const deps: ScanFoodCertDeps = {
    authenticate: async () => ({ userId: "user-1" }),
    checkGate: async () => {
      state.gateCalls += 1;
      return true;
    },
    loadFileFromPath: async () => {
      state.fileCalls += 1;
      return { base64: "aGVsbG8=", mimeType: "application/pdf" };
    },
    indraConfig: () => INDRA_CONFIG,
    callIndraOcr: async () => {
      state.indraCalls += 1;
      return indraResult("CÔNG TY TNHH BÁNH MÌ ABC\nSố: ATTP-123\nCó hiệu lực đến 31/12/2026");
    },
    callDeepSeekJson: async (options) => {
      state.deepSeekCalls.push(options);
      return { ...ANSWER };
    },
    loadParties: async () => ({
      manufacturers: [{ id: "m1", name: "Công ty TNHH Bánh Mì ABC" }],
      suppliers: [{ id: "s1", name: "Công ty CP Bánh Mì ABC" }],
    }),
    loadSuggestedItems: async (match) => match.kind === "manufacturer" ? ["item-1", "item-2"] : ["item-3"],
    audit: (event) => { state.audit.push(event); },
    ...overrides,
  };
  return { deps, state };
}

test("Indra success reads the certificate and matches its manufacturer", async () => {
  const { deps, state } = fakeDeps();
  const handler = createScanFoodCertHandler(deps);

  const response = await handler(request({ file_path: FILE_PATH }));
  const body = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.cert_type, "attp_facility");
  assert.equal(body.cert_no, "ATTP-123");
  assert.equal(body.issued_on, "2024-01-01");
  assert.equal(body.expires_on, "2026-12-31");
  assert.equal(body.expires_computed, false);
  assert.equal(body.ocr_engine, "indra");
  assert.equal(body.ocr_fallback_reason, null);
  assert.equal(body.holder_name, "CÔNG TY TNHH BÁNH MÌ ABC");

  const match = body.match as Record<string, unknown>;
  assert.equal(match.kind, "manufacturer");
  assert.equal(match.id, "m1");
  assert.equal(match.score, 1);
  assert.deepEqual(body.suggested_item_ids, ["item-1", "item-2"]);

  assert.equal(state.gateCalls, 1);
  assert.equal(state.fileCalls, 1);
  assert.equal(state.indraCalls, 1);
  assert.equal(state.deepSeekCalls.length, 1);
  assert.equal(state.deepSeekCalls[0].images, undefined);
  assert.match(String(state.deepSeekCalls[0].userText), /ATTP-123/);
  assert.equal(state.audit.length, 1);
  assert.equal(state.audit[0].engine, "indra");
});

test("Indra down falls back to the DeepSeek file path with the reason", async () => {
  const state = newState();
  const { deps } = fakeDeps({
    callIndraOcr: async () => {
      state.indraCalls += 1;
      throw new IndraOcrError("timeout");
    },
    callDeepSeekJson: async (options) => {
      state.deepSeekCalls.push(options);
      return {
        ...ANSWER,
        cert_type: "coa",
        cert_no: "COA-9",
        issued_on: "2025-02-01",
        expires_on: null,
        validity_years: "03 năm",
      };
    },
  }, state);
  const handler = createScanFoodCertHandler(deps);

  const response = await handler(request({ file_path: FILE_PATH }));
  const body = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(body.ocr_engine, "deepseek");
  assert.equal(body.ocr_fallback_reason, "timeout");
  assert.equal(body.cert_type, "coa");
  assert.equal(body.cert_no, "COA-9");
  assert.equal(body.expires_on, "2028-01-31");
  assert.equal(body.expires_computed, true);
  assert.equal(state.indraCalls, 1);
  assert.equal(state.deepSeekCalls.length, 1);
  assert.equal(state.deepSeekCalls[0].images?.length, 1);
  assert.equal(state.deepSeekCalls[0].images?.[0].mimeType, "application/pdf");
});

test("a PDF goes to Indra because the shared client forwards the mime type", async () => {
  assert.equal(INDRA_SUPPORTS_PDF, true);
  const { deps, state } = fakeDeps();
  const handler = createScanFoodCertHandler(deps);
  const response = await handler(request({ file_path: FILE_PATH }));
  assert.equal(response.status, 200);
  assert.equal(state.indraCalls, 1);
});

test("validity years compute expires_on = issued_on + years - 1 day", () => {
  assert.equal(parseValidityYears("có hiệu lực 03 năm"), 3);
  assert.equal(parseValidityYears("36 tháng"), 3);
  assert.equal(parseValidityYears(5), 5);
  assert.equal(parseValidityYears(""), null);
  assert.equal(addValidityYearsMinusOneDay("2024-03-01", 3), "2027-02-28");
  assert.equal(addValidityYearsMinusOneDay("2024-02-29", 1), "2025-02-28");
  assert.equal(addValidityYearsMinusOneDay("2024-03-01", null), null);

  const fields = parseFoodCertAnswer({
    ...ANSWER,
    expires_on: null,
    issued_on: "01/03/2024",
    validity_years: "có hiệu lực 03 năm",
  });
  assert.equal(fields.expires_on, "2027-02-28");
  assert.equal(fields.expires_computed, true);
  assert.equal(hasAnyFoodCertValue(fields), true);
});

test("holder matching normalizes accents and drops corporate tokens", () => {
  assert.equal(normalizePartyName("Công ty TNHH Bánh Mì ABC"), "banh mi abc");
  assert.equal(normalizePartyName("CÔNG TY CỔ PHẦN VIỆT NAM ABC"), "abc");

  const match = matchFoodCertHolder("Công ty CP Bánh Mì ABC", {
    manufacturers: [{ id: "m1", name: "Công ty TNHH Bánh Mì ABC" }],
    suppliers: [{ id: "s1", name: "Nhà cung cấp khác" }],
  });
  assert.deepEqual(match, {
    kind: "manufacturer",
    id: "m1",
    name: "Công ty TNHH Bánh Mì ABC",
    score: 1,
  });

  assert.equal(matchFoodCertHolder(null, { manufacturers: [], suppliers: [] }), null);
  assert.equal(matchFoodCertHolder("Không liên quan", {
    manufacturers: [{ id: "m1", name: "Công ty Bánh Mì ABC" }],
    suppliers: [],
  }), null);
});

test("a non-image/non-PDF mime is rejected before OCR", async () => {
  assert.throws(
    () => parseScanFoodCertInput({ image_base64: "aGVsbG8=", mime_type: "text/plain" }),
    (error: unknown) => error instanceof ScanFoodCertError && error.code === "invalid_mime",
  );

  const { deps, state } = fakeDeps();
  const handler = createScanFoodCertHandler(deps);
  const response = await handler(request({ image_base64: "aGVsbG8=", mime_type: "text/plain" }));
  const body = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 415);
  assert.equal(body.code, "invalid_mime");
  assert.equal(state.indraCalls, 0);
  assert.equal(state.deepSeekCalls.length, 0);
});

test("a caller without the kho editor gate gets 403", async () => {
  const { deps, state } = fakeDeps({
    checkGate: async () => {
      state.gateCalls += 1;
      return false;
    },
  });
  const handler = createScanFoodCertHandler(deps);

  const response = await handler(request({ file_path: FILE_PATH }));
  const body = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 403);
  assert.equal(body.ok, false);
  assert.equal(body.code, "forbidden");
  assert.equal(state.gateCalls, 1);
  assert.equal(state.indraCalls, 0);
  assert.equal(state.deepSeekCalls.length, 0);
});

test("bad model JSON is rejected as ocr_failed", async () => {
  const { deps } = fakeDeps({
    indraConfig: () => ({ ...INDRA_CONFIG, engine: "deepseek" }),
    callDeepSeekJson: async () => {
      throw new DeepSeekJsonError();
    },
  });
  const handler = createScanFoodCertHandler(deps);

  const response = await handler(request({ file_path: FILE_PATH }));
  const body = await response.json() as Record<string, unknown>;

  assert.equal(response.status, 502);
  assert.equal(body.ok, false);
  assert.equal(body.code, "ocr_failed");
});

test("storage paths map to a supported mime type", () => {
  assert.equal(certMimeFromPath("certs/a/b.pdf"), "application/pdf");
  assert.equal(certMimeFromPath("certs/a/b.PNG"), "image/png");
  assert.equal(certMimeFromPath("certs/a/b.jpg"), "image/jpeg");
});

test("the prompt version is stable for cache-free callers", async () => {
  const { SCAN_FOOD_CERT_PROMPT_VERSION } = await import("./handler.ts");
  assert.equal(SCAN_FOOD_CERT_PROMPT_VERSION, "scan-food-cert-v1");
});
