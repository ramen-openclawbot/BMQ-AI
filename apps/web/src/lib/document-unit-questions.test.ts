// Node tests for the 2026-10-20 document-unit question data layer.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  candidateLabel,
  normalizeDocumentUnit,
  parseDocumentUnitQuestion,
  parseDocumentUnitQuestions,
  validateAnswer,
  type DocumentUnitQuestion,
} from "./document-unit-questions.ts";

function question(overrides: Partial<DocumentUnitQuestion> = {}): DocumentUnitQuestion {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    batch: "2026-10-20",
    material_id: "22222222-2222-2222-2222-222222222222",
    doc_unit: "Hộp",
    doc_unit_normalized: "hộp",
    default_unit: "cái",
    line_count: 3,
    candidates: [
      {
        factor: 100,
        source: "game_alias_factor",
        alias_id: "33333333-3333-3333-3333-333333333333",
        sources: ["game_alias_factor"],
      },
    ],
    sample_lines: [
      {
        table: "purchase_order_items",
        line_id: "44444444-4444-4444-4444-444444444444",
        document_number: "PO-0001",
        document_date: "2026-10-18",
        product_name: "Găng tay",
        qty: 2,
        unit: "Hộp",
        unit_price: 120000,
        supplier_name: "NCC A",
        image_path: "purchase-orders/po-1.jpg",
      },
    ],
    status: "open",
    action: null,
    factor: null,
    actual_unit: null,
    reason: null,
    answered_by: null,
    answered_at: null,
    created_at: "2026-10-20T01:00:00+00:00",
    material: {
      id: "22222222-2222-2222-2222-222222222222",
      material_code: "NVL-001",
      canonical_name: "Găng tay",
      default_unit: "cái",
    },
    replay: false,
    ...overrides,
  };
}

test("normalizeDocumentUnit mirrors the SQL mapping table", () => {
  const cases: Array<[string | null | undefined, string]> = [
    ["  KG  ", "kg"],
    ["(kg)", "kg"],
    [" ( kg ) ", "kg"],
    ["Ky", "kg"],
    ["Ký", "kg"],
    ["kilogram", "kg"],
    ["b bao", "bao"],
    ["Hop", "hộp"],
    ["Hôp", "hộp"],
    ["Hộp", "hộp"],
    ["Hộp (pack)", "hộp"],
    ["hộp(pack)", "hộp"],
    ["Thùng (pack)", "thùng"],
    ["  Gói  10g ", "gói 10g"],
    [null, ""],
    [undefined, ""],
  ];

  for (const [input, expected] of cases) {
    assert.equal(normalizeDocumentUnit(input), expected, `normalize(${String(input)})`);
  }
});

test("candidateLabel formats a game factor and a game + standard chain", () => {
  assert.equal(
    candidateLabel({ factor: 100, source: "game_alias_factor", sources: ["game_alias_factor"] }),
    "100 (từ game)",
  );
  assert.equal(
    candidateLabel({
      factor: 0.04,
      source: "game_alias_factor",
      sources: ["game_alias_factor", "standard_auto"],
    }),
    "0,04 (game + đổi chuẩn)",
  );
  assert.equal(
    candidateLabel({ factor: 0.2, source: "standard_auto", sources: ["standard_auto"] }),
    "0,2 (đổi chuẩn)",
  );
  assert.equal(
    candidateLabel({ factor: 180, source: "approved_conversion", sources: ["approved_conversion"] }),
    "180 (quy đổi đã duyệt)",
  );
});

test("validateAnswer returns short Vietnamese errors", () => {
  assert.equal(validateAnswer("factor", 100), null);
  assert.equal(validateAnswer("factor", 0), "Hệ số phải lớn hơn 0");
  assert.equal(validateAnswer("factor", null), "Hệ số phải lớn hơn 0");
  assert.equal(validateAnswer("misread", null, ""), "Cần nhập đơn vị thực tế");
  assert.equal(validateAnswer("misread", 0, "kg"), "Hệ số phải lớn hơn 0");
  assert.equal(validateAnswer("misread", null, "kg"), null);
  assert.equal(validateAnswer("skip"), null);
  assert.equal(validateAnswer("other"), "Thao tác không hợp lệ");
});

test("parseDocumentUnitQuestion keeps a valid row and its replay flag", () => {
  const parsed = parseDocumentUnitQuestion({ ...question(), replay: true });
  assert.equal(parsed.id, question().id);
  assert.equal(parsed.candidates[0].factor, 100);
  assert.equal(parsed.sample_lines[0].image_path, "purchase-orders/po-1.jpg");
  assert.equal(parsed.replay, true);
});

test("parseDocumentUnitQuestions tolerates null, wrappers and broken rows", () => {
  assert.deepEqual(parseDocumentUnitQuestions(null), []);
  assert.deepEqual(parseDocumentUnitQuestions("not json"), []);
  assert.deepEqual(parseDocumentUnitQuestions({ questions: "no" }), []);

  const parsed = parseDocumentUnitQuestions({
    questions: [
      question(),
      { id: "broken" },
      question({ id: "55555555-5555-5555-5555-555555555555", status: "answered", action: "factor", factor: 2 }),
    ],
  });

  assert.equal(parsed.length, 2);
  assert.equal(parsed[1].status, "answered");
  assert.equal(parsed[1].action, "factor");
  assert.equal(parsed[1].factor, 2);
});

test("parseDocumentUnitQuestions drops invalid candidates but keeps the row", () => {
  const parsed = parseDocumentUnitQuestions([
    question({
      candidates: [
        { factor: 0, source: "game_alias_factor", alias_id: null, sources: [] },
        { factor: 6, source: "game_alias_factor", alias_id: null, sources: ["game_alias_factor"] },
      ],
    }),
  ]);

  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].candidates.length, 1);
  assert.equal(parsed[0].candidates[0].factor, 6);
});
