import assert from "node:assert/strict";
import test from "node:test";
import { isSkuDiscontinued } from "./sku-discontinue";

test("a SKU without discontinued_at is active", () => {
  assert.equal(isSkuDiscontinued({ discontinued_at: null }), false);
});

test("a SKU with an undefined discontinued_at is active", () => {
  assert.equal(isSkuDiscontinued({}), false);
});

test("a SKU with a discontinued_at timestamp is discontinued", () => {
  assert.equal(isSkuDiscontinued({ discontinued_at: "2026-11-02T03:04:05.000Z" }), true);
});
