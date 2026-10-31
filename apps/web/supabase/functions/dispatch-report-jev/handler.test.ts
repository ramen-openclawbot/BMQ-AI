// Offline tests for the dispatch-report Jev handler.
//
// The evaluator, OCR, storage and database are fakes: no network, no paid Jev
// request, no real photo and no real BMQ data. The handler is exercised through
// a real Request/Response pair.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DISPATCH_REPORT_JEV_MAX_PHOTOS,
  createDispatchReportJevHandler,
  dispatchReportMismatch,
  parseDispatchReportJevInput,
  type DispatchReportJevDeps,
  type DispatchReportJevMark,
  type DispatchReportJevPhoto,
} from "./handler.ts";
import {
  DISPATCH_REPORT_JEV_PROMPT_VERSION,
  DispatchReportJevError,
  sanitizeDispatchReportJevEvaluation,
  type DispatchReportJevEvaluation,
  type DispatchReportJevEvaluator,
  type DispatchReportJevEvaluatorParams,
} from "./jev.ts";

const PHOTO_A = "11111111-1111-4111-8111-111111111111";
const PHOTO_B = "22222222-2222-4222-8222-222222222222";
const PHOTO_CROSS_DAY = "33333333-3333-4333-8333-333333333333";

const REPORT = {
  date: "2026-11-01",
  pos: [
    { po_number: "PO1000000001", delivered_qty: 100 },
    { po_number: "PO1000000002", delivered_qty: 50 },
  ],
};

function evaluation(
  overrides: Partial<DispatchReportJevEvaluation> = {},
): DispatchReportJevEvaluation {
  return {
    kind: "phieu_xuat_kho",
    po_numbers: ["PO1000000001"],
    quantities: [{ po_number: "PO1000000001", qty: 100 }],
    summary: "Phiếu xuất kho · PO1000000001 · SL 100",
    ...overrides,
  };
}

function request(body: unknown): Request {
  return new Request("https://example.test/functions/v1/dispatch-report-jev", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://ai.banhmique.vn" },
    body: JSON.stringify(body),
  });
}

interface FakeOptions {
  saved?: string[];
  saveError?: unknown;
  photos?: DispatchReportJevPhoto[];
  ocrText?: string | null;
  evaluator?: DispatchReportJevEvaluator | null;
  evaluatorError?: Error;
  promptVersion?: string;
}

function fakeDeps(options: FakeOptions = {}) {
  const marks: DispatchReportJevMark[] = [];
  const calls: DispatchReportJevEvaluatorParams[] = [];
  const saved = options.saved ?? [PHOTO_A];
  const photos = options.photos ?? [{ id: PHOTO_A, storagePath: "2026-11-01/a.jpg" }];
  const deps: DispatchReportJevDeps = {
    authenticate: async () => ({
      userId: "user-1",
      save: async () => {
        if (options.saveError !== undefined) throw options.saveError;
        return saved;
      },
      loadReport: async () => REPORT,
    }),
    loadPhotos: async (ids) => photos.filter((photo) => ids.includes(photo.id)),
    signPhoto: async (storagePath) => `https://storage.example/${storagePath}?token=secret`,
    ocrPhoto: async () => options.ocrText === undefined ? "PHIẾU XUẤT KHO\nPO1000000001 100" : options.ocrText,
    evaluator: () => {
      if (options.evaluator !== undefined) return options.evaluator;
      return async (params) => {
        calls.push(params);
        if (options.evaluatorError) throw options.evaluatorError;
        return evaluation();
      };
    },
    markPhoto: async (mark) => { marks.push(mark); },
    promptVersion: options.promptVersion,
  };
  return { deps, marks, calls };
}

test("saves with the caller JWT and stores a correct kind, PO and quantity", async () => {
  const { deps, marks, calls } = fakeDeps({ promptVersion: "test-prompt-version" });
  const response = await createDispatchReportJevHandler(deps)(request({
    date: "2026-11-01",
    photo_ids: [PHOTO_A],
  }));

  assert.equal(response.status, 200);
  const body = await response.json() as {
    saved: string[];
    results: { id: string; status: string; kind: string; mismatch: boolean | null }[];
  };
  assert.deepEqual(body.saved, [PHOTO_A]);
  assert.deepEqual(body.results, [{
    id: PHOTO_A,
    status: "done",
    kind: "phieu_xuat_kho",
    mismatch: false,
  }]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].date, "2026-11-01");
  assert.match(calls[0].ocrText, /PO1000000001/);
  assert.equal(marks.length, 1);
  assert.equal(marks[0].status, "done");
  assert.equal(marks[0].kind, "phieu_xuat_kho");
  assert.equal(marks[0].mismatch, false);
  assert.equal(marks[0].promptVersion, "test-prompt-version");
  assert.equal(marks[0].error, null);
  const serialized = JSON.stringify(body);
  assert.ok(!serialized.includes("secret"));
  assert.ok(!serialized.includes("AI_GATEWAY"));
});

test("flags a quantity that differs from delivered_qty and a PO absent from the day", async () => {
  const { deps, marks } = fakeDeps({
    evaluator: async () => evaluation({
      po_numbers: ["PO1000000001", "PO1009999999"],
      quantities: [
        { po_number: "PO1000000001", qty: 90 },
        { po_number: "PO1009999999", qty: 10 },
      ],
    }),
  });
  const response = await createDispatchReportJevHandler(deps)(request({
    date: "2026-11-01",
    photo_ids: [PHOTO_A],
  }));

  assert.equal(response.status, 200);
  const body = await response.json() as {
    results: { status: string; kind: string; mismatch: boolean | null }[];
  };
  assert.equal(body.results[0].status, "done");
  assert.equal(body.results[0].mismatch, true);
  assert.equal(marks[0].mismatch, true);
  assert.deepEqual(marks[0].poNumbers, ["PO1000000001", "PO1009999999"]);
  assert.deepEqual(marks[0].quantities, [
    { po_number: "PO1000000001", qty: 90 },
    { po_number: "PO1009999999", qty: 10 },
  ]);
});

test("one Jev failure stores failed for that photo and does not block the other", async () => {
  const photos = [
    { id: PHOTO_A, storagePath: "2026-11-01/a.jpg" },
    { id: PHOTO_B, storagePath: "2026-11-01/b.jpg" },
  ];
  const { deps, marks } = fakeDeps({
    saved: [PHOTO_A, PHOTO_B],
    photos,
    evaluator: async (params) => {
      if (params.ocrText.includes("FAIL")) throw new DispatchReportJevError("jev_http_error", 502);
      return evaluation();
    },
  });
  const base = deps.ocrPhoto;
  deps.ocrPhoto = async (url, signal) => {
    assert.match(url, /storage\.example/);
    return url.includes("b.jpg") ? "FAIL" : base(url, signal);
  };

  const response = await createDispatchReportJevHandler(deps)(request({
    date: "2026-11-01",
    photo_ids: [PHOTO_A, PHOTO_B],
  }));

  assert.equal(response.status, 200);
  const body = await response.json() as {
    results: { id: string; status: string; kind: string | null; mismatch: boolean | null }[];
  };
  assert.deepEqual(body.results, [
    { id: PHOTO_A, status: "done", kind: "phieu_xuat_kho", mismatch: false },
    { id: PHOTO_B, status: "failed", kind: null, mismatch: null },
  ]);
  const failed = marks.find((mark) => mark.id === PHOTO_B);
  assert.equal(failed?.status, "failed");
  assert.equal(failed?.error, "jev_http_error");
});

test("a missing Jev key stores skipped and still returns the saved photo", async () => {
  const { deps, marks } = fakeDeps({ evaluator: null });
  const response = await createDispatchReportJevHandler(deps)(request({
    date: "2026-11-01",
    photo_ids: [PHOTO_A],
  }));

  assert.equal(response.status, 200);
  const body = await response.json() as {
    saved: string[];
    results: { status: string; kind: string | null }[];
  };
  assert.deepEqual(body.saved, [PHOTO_A]);
  assert.equal(body.results[0].status, "skipped");
  assert.equal(body.results[0].kind, null);
  assert.equal(marks[0].status, "skipped");
  assert.equal(marks[0].error, "jev_unconfigured");
});

test("a DB permission error (42501) becomes HTTP 403", async () => {
  const { deps } = fakeDeps({ saveError: { code: "42501", message: "insufficient_privilege" } });
  const response = await createDispatchReportJevHandler(deps)(request({
    date: "2026-11-01",
    photo_ids: [PHOTO_A],
  }));

  assert.equal(response.status, 403);
  const body = await response.json() as { code: string };
  assert.equal(body.code, "forbidden");
});

test("a photo from another day is rejected before any Jev call", async () => {
  const { deps, marks, calls } = fakeDeps({
    saveError: { code: "22023", message: "invalid_photo" },
  });
  const response = await createDispatchReportJevHandler(deps)(request({
    date: "2026-11-01",
    photo_ids: [PHOTO_A, PHOTO_CROSS_DAY],
  }));

  assert.equal(response.status, 400);
  const body = await response.json() as { code: string };
  assert.equal(body.code, "invalid_photo");
  assert.equal(calls.length, 0);
  assert.equal(marks.length, 0);
});

test("input is one date and at most ten unique photo ids", () => {
  assert.deepEqual(parseDispatchReportJevInput({
    date: "2026-11-01",
    photo_ids: [PHOTO_A, PHOTO_A],
  }), { date: "2026-11-01", photoIds: [PHOTO_A] });
  assert.throws(() => parseDispatchReportJevInput({ date: "2026-02-30", photo_ids: [PHOTO_A] }));
  assert.throws(() => parseDispatchReportJevInput({ date: "2026-11-01", photo_ids: [] }));
  assert.throws(() => parseDispatchReportJevInput({ date: "2026-11-01", photo_ids: [PHOTO_A], extra: true }));
  const tooMany = Array.from({ length: DISPATCH_REPORT_JEV_MAX_PHOTOS + 1 }, (_value, index) =>
    `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`);
  assert.throws(() => parseDispatchReportJevInput({ date: "2026-11-01", photo_ids: tooMany }));
});

test("mismatch is false when no PO was read; the sanitizer drops unknown values", () => {
  assert.equal(dispatchReportMismatch({ po_numbers: [], quantities: [] }, new Map()), false);
  const clean = sanitizeDispatchReportJevEvaluation({
    kind: "hoa_don",
    po_numbers: ["PO1000000001", "not-a-po", "PO1000000001"],
    quantities: [
      { po_number: "PO1000000001", qty: "123.5" },
      { po_number: "bad", qty: 1 },
      { po_number: "PO1000000002", qty: Number.NaN },
    ],
    summary: "  Hoá   đơn  ",
    extra: "ignored",
  });
  assert.deepEqual(clean, {
    kind: "hoa_don",
    po_numbers: ["PO1000000001"],
    quantities: [{ po_number: "PO1000000001", qty: 123.5 }],
    summary: "Hoá đơn",
  });
  assert.equal(sanitizeDispatchReportJevEvaluation({ kind: "unknown", po_numbers: [] }), null);
});

test("the prompt version is the dispatch-report version", async () => {
  const { deps, marks } = fakeDeps();
  await createDispatchReportJevHandler(deps)(request({
    date: "2026-11-01",
    photo_ids: [PHOTO_A],
  }));
  assert.equal(marks[0].promptVersion, DISPATCH_REPORT_JEV_PROMPT_VERSION);
});
