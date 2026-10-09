import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildPairState,
  canonicalJson,
  stateHash,
  vietnamDate,
  STATE_DESCRIPTION_LIMIT,
  STATE_ITEM_LIMIT,
  type RequestStateInput,
  type StateItem,
} from "./state.ts";

function detail(overrides: Partial<RequestStateInput> & { id: string }): RequestStateInput {
  return {
    request_number: `PR-${overrides.id}`,
    created_at: "2026-10-01T00:00:00.000Z",
    total_amount: 1_000_000,
    title: "Phiếu chi",
    description: "Mô tả",
    po_number: "PO-1",
    goods_receipt_number: "GR-1",
    receipt_date: "2026-09-30",
    invoice_number: "INV-1",
    items: [],
    ...overrides,
  };
}

const item = (index: number): StateItem => ({
  product_name: `Sản phẩm ${index}`,
  quantity: index,
  unit: "kg",
  unit_price: 1000,
  line_total: 1000 * index,
});

test("formats a created date in Vietnam time (UTC+7)", () => {
  assert.equal(vietnamDate("2026-10-10T16:59:00.000Z"), "2026-10-10");
  assert.equal(vietnamDate("2026-10-10T17:00:00.000Z"), "2026-10-11");
  assert.equal(vietnamDate("2026-10-10T23:30:00.000Z"), "2026-10-11");
  assert.equal(vietnamDate("not-a-date"), "");
});

test("builds named state fields, truncates the description and caps items", () => {
  const state = buildPairState({
    supplier_name: "NCC A",
    older: detail({
      id: "a",
      description: "x".repeat(STATE_DESCRIPTION_LIMIT + 50),
      items: Array.from({ length: STATE_ITEM_LIMIT + 5 }, (_, index) => item(index)),
    }),
    newer: detail({ id: "b" }),
  });
  assert.equal(state.supplier_name, "NCC A");
  assert.equal(state.older.request_number, "PR-a");
  assert.equal(state.older.created_date, "2026-10-01");
  assert.equal(state.older.description?.length, STATE_DESCRIPTION_LIMIT);
  assert.equal(state.older.items.length, STATE_ITEM_LIMIT);
  assert.deepEqual(Object.keys(state.older), [
    "request_number",
    "created_date",
    "total_amount",
    "title",
    "description",
    "po_number",
    "goods_receipt_number",
    "receipt_date",
    "invoice_number",
    "items",
  ]);
  assert.deepEqual(Object.keys(state.older.items[0]), [
    "product_name",
    "quantity",
    "unit",
    "unit_price",
    "line_total",
  ]);
});

test("state never carries account, image, creator or email fields", () => {
  const state = buildPairState({
    supplier_name: "NCC A",
    older: detail({ id: "a" }),
    newer: detail({ id: "b" }),
  });
  const serialized = JSON.stringify(state).toLowerCase();
  for (const forbidden of ["bank", "account", "image", "created_by", "email", "phone", "@"]) {
    assert.equal(serialized.includes(forbidden), false, `state must not contain ${forbidden}`);
  }
});

test("canonicalJson sorts keys so the same state hashes the same", async () => {
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}');
  const state = buildPairState({
    supplier_name: "NCC A",
    older: detail({ id: "a" }),
    newer: detail({ id: "b" }),
  });
  const first = await stateHash(state);
  const second = await stateHash(state);
  assert.equal(first, second);
  assert.match(first, /^[0-9a-f]{64}$/);
});

test("a changed amount produces a different state hash", async () => {
  const older = detail({ id: "a" });
  const newer = detail({ id: "b" });
  const before = await stateHash(buildPairState({ supplier_name: "NCC A", older, newer }));
  const after = await stateHash(
    buildPairState({ supplier_name: "NCC A", older, newer: { ...newer, total_amount: 2_000_000 } }),
  );
  assert.notEqual(before, after);
});
