// Node tests for the Tân Tạo pate recipe / production data layer.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  packUsage,
  parseTanTaoPateProductionResult,
  parseTanTaoPateRecipe,
  recipeProgress,
  usageForBatches,
  type TanTaoPateLine,
  type TanTaoPateRecipe,
} from "./tan-tao-pate.ts";

function line(overrides: Partial<TanTaoPateLine> = {}): TanTaoPateLine {
  return {
    id: "line-1",
    line_kind: "ingredient",
    sort_order: 1,
    label: "Nạc heo",
    kitchen_inventory_item_id: "item-nac",
    item_code: "NVL-001",
    item_name: "Nạc đùi heo",
    item_unit: "g",
    sku_code: null,
    grams_per_batch: 4000,
    pate_grams_per_pack: null,
    pack_item_id: null,
    pack_item_code: null,
    pack_item_name: null,
    pack_item_unit: null,
    label_item_id: null,
    label_item_code: null,
    label_item_name: null,
    label_item_unit: null,
    status: "answered",
    answered_by: "owner-1",
    answered_at: "2026-11-01T08:00:00+00:00",
    ...overrides,
  };
}

function recipe(overrides: Partial<TanTaoPateRecipe> = {}): TanTaoPateRecipe {
  return {
    id: "recipe-1",
    code: "pate-heo",
    name: "Pate heo Tân Tạo",
    batch_output_kg: null,
    batch_set: false,
    status: "draft",
    updated_by: "owner-1",
    updated_at: "2026-11-01T08:00:00+00:00",
    line_count: 3,
    open_count: 2,
    answered_count: 1,
    not_used_count: 0,
    lines: [
      line(),
      line({ id: "line-2", label: "Mỡ", kitchen_inventory_item_id: "item-mo", status: "open" }),
      line({ id: "line-3", label: "Muối", kitchen_inventory_item_id: null, status: "not_used" }),
    ],
    can_answer: true,
    ...overrides,
  };
}

test("parseTanTaoPateRecipe reads the RPC shape and line items", () => {
  const raw = {
    ...recipe(),
    lines: [
      line(),
      line({
        id: "pack-500",
        line_kind: "pack",
        label: "Hộp pate 500g",
        kitchen_inventory_item_id: null,
        sku_code: "PATE-500G",
        grams_per_batch: null,
        pate_grams_per_pack: 500,
        pack_item_id: "item-hop-500",
        pack_item_name: "Hộp pate 500gr",
        pack_item_unit: "hộp",
        label_item_id: "item-nhan-500",
        label_item_name: "Nhãn pate 500g",
        label_item_unit: "tờ",
      }),
    ],
  };

  const parsed = parseTanTaoPateRecipe(raw);
  assert.equal(parsed.code, "pate-heo");
  assert.equal(parsed.status, "draft");
  assert.equal(parsed.lines.length, 2);
  assert.equal(parsed.lines[0].grams_per_batch, 4000);
  assert.equal(parsed.lines[1].line_kind, "pack");
  assert.equal(parsed.lines[1].pate_grams_per_pack, 500);
  assert.equal(parsed.lines[1].pack_item_name, "Hộp pate 500gr");
  assert.equal(parsed.can_answer, true);
});

test("parseTanTaoPateRecipe derives counts and batch_set when omitted", () => {
  const parsed = parseTanTaoPateRecipe({
    ...recipe(),
    batch_output_kg: 10,
    batch_set: undefined,
    line_count: undefined,
    open_count: undefined,
    answered_count: undefined,
    not_used_count: undefined,
  });

  assert.equal(parsed.batch_set, true);
  assert.equal(parsed.line_count, 3);
  assert.equal(parsed.open_count, 1);
  assert.equal(parsed.answered_count, 1);
  assert.equal(parsed.not_used_count, 1);
});

test("parseTanTaoPateRecipe rejects malformed status / lines", () => {
  assert.throws(() => parseTanTaoPateRecipe({ ...recipe(), status: "paused" }), TypeError);
  assert.throws(
    () => parseTanTaoPateRecipe({ ...recipe(), lines: [{ ...line(), line_kind: "other" }] }),
    TypeError,
  );
  assert.throws(() => parseTanTaoPateRecipe(null), TypeError);
});

test("usageForBatches aggregates answered ingredient grams per item", () => {
  const lines = [
    line({ id: "a", kitchen_inventory_item_id: "item-1", grams_per_batch: 100 }),
    line({ id: "b", kitchen_inventory_item_id: "item-1", grams_per_batch: 250 }),
    line({ id: "c", kitchen_inventory_item_id: "item-2", grams_per_batch: 50 }),
    line({ id: "open", status: "open" }),
    line({ id: "skipped", status: "not_used" }),
    line({ id: "zero", grams_per_batch: 0 }),
  ];

  const usage = usageForBatches(lines, 2);
  assert.deepEqual(
    usage.map((row) => ({ id: row.itemId, grams: row.grams, lineIds: row.lineIds })),
    [
      { id: "item-1", grams: 700, lineIds: ["a", "b"] },
      { id: "item-2", grams: 100, lineIds: ["c"] },
    ],
  );
  assert.deepEqual(usageForBatches(lines, 0), []);
  assert.deepEqual(usageForBatches(lines, Number.NaN), []);
});

test("packUsage matches SKU lines, aggregates duplicate packs and computes pate grams", () => {
  const lines = [
    line({
      id: "pack-500",
      line_kind: "pack",
      sku_code: "PATE-500G",
      pate_grams_per_pack: 500,
      pack_item_id: "hop-500",
      label_item_id: "nhan-500",
    }),
    line({
      id: "pack-200",
      line_kind: "pack",
      sku_code: "PATE-200G",
      pate_grams_per_pack: 200,
      pack_item_id: "hop-200",
      label_item_id: "nhan-200",
    }),
    line({ id: "open-pack", line_kind: "pack", sku_code: "PATE-500G", status: "open" }),
  ];

  const usage = packUsage(
    [
      { sku_code: "pate-500g", quantity: 4 },
      { sku_code: "PATE-500G", quantity: 6 },
      { sku_code: "PATE-200G", quantity: 5 },
      { sku_code: "unknown", quantity: 9 },
    ],
    lines,
  );

  assert.deepEqual(
    usage.map((row) => ({
      sku: row.skuCode,
      qty: row.quantity,
      pate: row.pateGrams,
      packItem: row.packItemId,
      labelItem: row.labelItemId,
    })),
    [
      { sku: "PATE-200G", qty: 5, pate: 1000, packItem: "hop-200", labelItem: "nhan-200" },
      { sku: "PATE-500G", qty: 10, pate: 5000, packItem: "hop-500", labelItem: "nhan-500" },
    ],
  );
});

test("recipeProgress counts the batch question and lines", () => {
  const partial = recipeProgress(recipe());
  assert.equal(partial.total, 4);
  assert.equal(partial.answered, 1);
  assert.equal(partial.open, 1);
  assert.equal(partial.notUsed, 1);
  assert.equal(partial.batchSet, false);
  assert.equal(partial.left, 2);
  assert.equal(partial.complete, false);
  assert.equal(partial.pct, 50);

  const complete = recipeProgress({
    ...recipe({
      batch_output_kg: 10,
      batch_set: true,
      status: "complete",
      lines: [
        line(),
        line({ id: "line-2", status: "answered" }),
        line({ id: "line-3", kitchen_inventory_item_id: null, status: "not_used" }),
      ],
    }),
  });
  assert.equal(complete.left, 0);
  assert.equal(complete.complete, true);
  assert.equal(complete.pct, 100);
});

test("parseTanTaoPateProductionResult reads the stored slip result", () => {
  const parsed = parseTanTaoPateProductionResult({
    status: "recorded",
    slip_id: "slip-1",
    recipe_code: "pate-heo",
    production_date: "2026-10-18",
    batches: 2,
    packs: [
      { sku_code: "PATE-500G", quantity: 10 },
      { sku_code: "PATE-200G", quantity: 5 },
    ],
    ingredients: [
      {
        line_id: "line-1",
        item_id: "item-1",
        item_name: "Nạc đùi heo",
        unit: "g",
        grams: 8000,
        quantity: 8000,
      },
    ],
    packaging: [
      {
        line_id: "pack-500",
        kind: "pack",
        item_id: "hop-500",
        item_name: "Hộp pate 500gr",
        unit: "hộp",
        packs: 10,
        quantity: 10,
      },
    ],
    documents: [
      {
        sku_code: "PATE-500G",
        quantity: 10,
        result: { status: "created" },
      },
    ],
    movement_count: 3,
    replay: false,
  });

  assert.equal(parsed.slip_id, "slip-1");
  assert.equal(parsed.ingredients[0].grams, 8000);
  assert.equal(parsed.packaging[0].kind, "pack");
  assert.equal(parsed.documents[0].result.status, "created");
  assert.equal(parsed.movement_count, 3);
  assert.equal(parsed.replay, false);
  assert.throws(() => parseTanTaoPateProductionResult({ status: "recorded" }), TypeError);
});
