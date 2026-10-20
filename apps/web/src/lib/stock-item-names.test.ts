// Node tests for the stock-name helpers used by payment requests and POs.
import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStockNameLines,
  displayNameFor,
  parseStockItemNames,
} from "./stock-item-names.ts";

test("buildStockNameLines prefers raw_product_name and drops blank names", () => {
  const lines = buildStockNameLines(
    [
      { id: "line-1", product_name: "Tên đọc trên phiếu", raw_product_name: "T. Ối gói 10g" },
      { id: "line-2", product_name: "Chỉ có product_name", raw_product_name: "   " },
      { id: "line-3", product_name: "   ", raw_product_name: "" },
    ],
    "supplier-1",
    "q7",
  );

  assert.deepEqual(lines, [
    {
      key: "line-1",
      supplier_id: "supplier-1",
      name: "T. Ối gói 10g",
      location: "q7",
    },
    {
      key: "line-2",
      supplier_id: "supplier-1",
      name: "Chỉ có product_name",
      location: "q7",
    },
  ]);
});

test("parseStockItemNames maps valid rows and skips malformed entries", () => {
  const names = parseStockItemNames([
    null,
    "không phải object",
    { key: "missing-id", item_name: "Thiếu item_id" },
    { key: "bad-name", item_id: "item-2", item_name: 123 },
    {
      key: "line-1",
      item_id: "item-1",
      item_name: "T. Ối gói 10g",
      item_code: "NVL-OI-10G",
      unit: "gói",
      location: "q7",
      match: "supplier",
    },
    {
      key: "line-2",
      item_id: "item-2",
      item_name: "Món không mã",
      item_code: null,
      unit: null,
      location: null,
      match: "global",
    },
  ]);

  assert.equal(names.size, 2);
  assert.deepEqual(names.get("line-1"), {
    key: "line-1",
    item_id: "item-1",
    item_name: "T. Ối gói 10g",
    item_code: "NVL-OI-10G",
    unit: "gói",
    location: "q7",
    match: "supplier",
  });
  assert.deepEqual(names.get("line-2"), {
    key: "line-2",
    item_id: "item-2",
    item_name: "Món không mã",
    item_code: null,
    unit: null,
    location: null,
    match: "global",
  });
});

test("parseStockItemNames tolerates non-array payloads", () => {
  assert.equal(parseStockItemNames(null).size, 0);
  assert.equal(parseStockItemNames(undefined).size, 0);
  assert.equal(parseStockItemNames({}).size, 0);
  assert.equal(parseStockItemNames("nope").size, 0);
});

test("displayNameFor uses the stock name and keeps the document name as sourceName", () => {
  const names = parseStockItemNames([
    {
      key: "line-1",
      item_id: "item-1",
      item_name: "T. Ối gói 10g (nhập khẩu)",
      item_code: "NVL-OI-10G",
      unit: "gói",
      location: "q7",
      match: "supplier",
    },
  ]);

  const result = displayNameFor(
    { id: "line-1", product_name: "Tên đọc sai", raw_product_name: "T. Ối gói 10g" },
    names,
  );

  assert.equal(result.name, "T. Ối gói 10g (nhập khẩu)");
  assert.equal(result.sourceName, "T. Ối gói 10g");
  assert.equal(result.stock?.item_id, "item-1");
});

test("displayNameFor hides sourceName when only case or surrounding spaces differ", () => {
  const names = parseStockItemNames([
    {
      key: "line-1",
      item_id: "item-1",
      item_name: "T. Ối Gói 10g",
      item_code: null,
      unit: null,
      location: "q7",
      match: "global",
    },
  ]);

  const result = displayNameFor(
    { id: "line-1", product_name: "T. Ối Gói 10g", raw_product_name: "  t. ối gói 10g  " },
    names,
  );

  assert.equal(result.name, "T. Ối Gói 10g");
  assert.equal(result.sourceName, null);
});

test("displayNameFor keeps product_name when the warehouse has no match", () => {
  const result = displayNameFor(
    { id: "line-1", product_name: "Tên gốc trên phiếu", raw_product_name: "Tên đọc sai" },
    new Map(),
  );

  assert.deepEqual(result, {
    name: "Tên gốc trên phiếu",
    sourceName: null,
    stock: null,
  });
});
