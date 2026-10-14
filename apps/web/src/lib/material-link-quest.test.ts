// Node tests for the two-warehouse Material Master link quest helpers.
import assert from "node:assert/strict";
import test from "node:test";

import {
  bulkableRows,
  deckOrder,
  factorPrefill,
  itemFactorPrefill,
  parseMaterialLinkPendingFactors,
  parseMaterialLinkReview,
  type MaterialLinkReviewItem,
} from "./material-link-quest.ts";

const validReview = {
  items: [
    {
      item_id: "11111111-1111-1111-1111-111111111111",
      item_code: "NVL-001",
      name: "Bột mì 888",
      unit: "g",
      exact_material: {
        id: "22222222-2222-2222-2222-222222222222",
        material_code: "NVL-BOT-MI",
        canonical_name: "Bột mì",
        default_unit: "g",
        skus: ["Bánh mì"],
      },
      material_unit: "g",
      unit_status: "same",
      auto_factor: null,
      factor_suggestion: null,
      candidates: [
        {
          id: "22222222-2222-2222-2222-222222222222",
          material_code: "NVL-BOT-MI",
          canonical_name: "Bột mì",
          default_unit: "g",
          unit_status: "same",
          score: 1,
          skus: ["Bánh mì"],
        },
      ],
      last_buy: { supplier_name: "Đại Phát", date: "2026-10-20" },
      last_purchase_line: {
        doc_kind: "gr",
        doc_number: "GRN-000585",
        date: "2026-10-18",
        supplier_name: "Đại Phát",
        raw_name: "Bột mì 888 (bao 25kg)",
        quantity: 25,
        unit: "bao",
        unit_price: 480000,
      },
      receipt_photo_count: 2,
    },
    {
      item_id: "33333333-3333-3333-3333-333333333333",
      item_code: null,
      name: "Đường cát",
      unit: "kg",
      exact_material: null,
      material_unit: null,
      unit_status: null,
      auto_factor: null,
      factor_suggestion: null,
      candidates: [],
      last_buy: null,
      last_purchase_line: null,
      receipt_photo_count: 0,
    },
  ],
  counts: { total: 2, exact: 1, auto: 0, needs_factor: 0, none: 1, linked_total: 5, skipped: 3, pending_factor: 4 },
};

test("parseMaterialLinkReview reads the two-warehouse payload", () => {
  const review = parseMaterialLinkReview(validReview);
  assert.equal(review.items.length, 2);
  assert.equal(review.items[0].exact_material?.material_code, "NVL-BOT-MI");
  assert.equal(review.items[0].exact_material?.unit_status, "same");
  assert.equal(review.items[0].exact_material?.score, 1);
  assert.deepEqual(review.items[0].exact_material?.skus, ["Bánh mì"]);
  assert.deepEqual(review.items[0].last_buy, { supplier_name: "Đại Phát", date: "2026-10-20" });
  assert.deepEqual(review.items[0].last_purchase_line, {
    doc_kind: "gr",
    doc_number: "GRN-000585",
    date: "2026-10-18",
    supplier_name: "Đại Phát",
    raw_name: "Bột mì 888 (bao 25kg)",
    quantity: 25,
    unit: "bao",
    unit_price: 480000,
  });
  assert.equal(review.items[0].receipt_photo_count, 2);
  assert.equal(review.items[1].exact_material, null);
  assert.equal(review.items[1].last_buy, null);
  assert.equal(review.items[1].last_purchase_line, null);
  assert.deepEqual(review.counts, {
    total: 2,
    exact: 1,
    auto: 0,
    needs_factor: 0,
    none: 1,
    linked_total: 5,
    skipped: 3,
    pending_factor: 4,
  });
});

test("parseMaterialLinkReview tolerates missing arrays and counts", () => {
  const empty = parseMaterialLinkReview(null);
  assert.deepEqual(empty.items, []);
  assert.deepEqual(empty.counts, {
    total: 0,
    exact: 0,
    auto: 0,
    needs_factor: 0,
    none: 0,
    linked_total: 0,
    skipped: 0,
    pending_factor: 0,
  });

  const sparse = parseMaterialLinkReview({
    items: [
      {
        item_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        name: "Muối",
        unit: "g",
      },
    ],
  });
  assert.equal(sparse.items.length, 1);
  assert.equal(sparse.items[0].item_code, null);
  assert.deepEqual(sparse.items[0].candidates, []);
  assert.deepEqual(sparse.items[0].exact_material, null);
  assert.equal(sparse.items[0].receipt_photo_count, 0);
  assert.equal(sparse.items[0].last_buy, null);
  assert.equal(sparse.items[0].last_purchase_line, null);
  assert.equal(sparse.counts.total, 0);
  assert.equal(sparse.counts.pending_factor, 0);

  assert.throws(() => parseMaterialLinkReview({ items: [{ item_id: 42 }] }), TypeError);
});

test("parseMaterialLinkReview fills the exact material unit from the item", () => {
  const review = parseMaterialLinkReview({
    items: [
      {
        item_id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        item_code: "NVL-009",
        name: "Trứng gà 60gr",
        unit: "quả",
        exact_material: {
          id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
          material_code: "NVL-TRUNG",
          canonical_name: "Trứng gà",
          default_unit: "g",
          skus: [],
        },
        material_unit: "g",
        unit_status: "needs_factor",
        auto_factor: null,
        factor_suggestion: 60,
        candidates: [],
        last_buy: null,
        receipt_photo_count: 0,
      },
    ],
    counts: { total: 1, exact: 1, auto: 0, needs_factor: 1, none: 0, linked_total: 0, skipped: 0 },
  });
  assert.equal(review.items[0].exact_material?.unit_status, "needs_factor");
  assert.equal(review.items[0].exact_material?.score, 1);
  assert.equal(review.items[0].material_unit, "g");
});

function item(
  name: string,
  itemId: string,
  opts: { exact?: boolean; candidates?: number } = {},
): MaterialLinkReviewItem {
  const base: MaterialLinkReviewItem = {
    item_id: itemId,
    item_code: null,
    name,
    unit: "g",
    exact_material: null,
    material_unit: null,
    unit_status: null,
    auto_factor: null,
    candidates: [],
    last_buy: null,
    last_purchase_line: null,
    receipt_photo_count: 0,
  };
  if (opts.exact) {
    base.exact_material = {
      id: `mat-${itemId}`,
      material_code: "NVL-X",
      canonical_name: name,
      default_unit: "g",
      unit_status: "same",
      score: 1,
      skus: [],
    };
    base.material_unit = "g";
    base.unit_status = "same";
  }
  if (opts.candidates) {
    base.candidates = Array.from({ length: opts.candidates }, (_, index) => ({
      id: `cand-${itemId}-${index}`,
      material_code: `NVL-${index}`,
      canonical_name: `Ứng viên ${index}`,
      default_unit: "g",
      unit_status: "auto" as const,
      score: 0.7,
      skus: [],
    }));
  }
  return base;
}

test("deckOrder groups exact, candidates, none and defers to the end", () => {
  const c = item("Cà rốt", "c", { candidates: 1 });
  const a = item("Anh đào", "a", { exact: true });
  const b = item("Bơ", "b");
  const d = item("Dưa hấu", "d", { exact: true });
  const ordered = deckOrder([b, c, a, d], []);
  assert.deepEqual(
    ordered.map((row) => row.name),
    ["Anh đào", "Dưa hấu", "Cà rốt", "Bơ"],
  );

  const deferred = deckOrder([b, c, a, d], ["b", "a"]);
  assert.deepEqual(
    deferred.map((row) => row.name),
    ["Dưa hấu", "Cà rốt", "Bơ", "Anh đào"],
  );
});

test("bulkableRows keeps only exact same/auto rows", () => {
  const same = item("Bột mì", "m", { exact: true });
  const needsFactor = item("Trứng", "t", { exact: true });
  needsFactor.unit_status = "needs_factor";
  const none = item("Muối", "n");
  const withCandidate = item("Tiêu", "p", { candidates: 1 });
  assert.deepEqual(
    bulkableRows([same, needsFactor, none, withCandidate]).map((row) => row.item_id),
    ["m"],
  );
});

test("factorPrefill reads package size from the item name", () => {
  assert.equal(factorPrefill("Bột mì 25kg", "g", "g"), 25000);
  assert.equal(factorPrefill("Sữa tươi 1L", "g", "g"), 1000);
  assert.equal(factorPrefill("Trứng gà 60gr", "g", "g"), 60);
  assert.equal(factorPrefill("Sữa tươi", "g", "g"), null);
  assert.equal(factorPrefill("Sữa tươi", "g", "lít"), 1000);
  assert.equal(factorPrefill("Bột mì 25kg", "bao", "g"), null);
});

test("itemFactorPrefill reads the size from the item then the material name", () => {
  // The owner's case: a 20L bottle read from the material name → 20000 g/bình.
  assert.equal(
    itemFactorPrefill("Nước uống Vĩnh Hảo", "bình", "Nước Vihawa 20L Bình Vòi", "g"),
    20000,
  );
  assert.equal(
    itemFactorPrefill("Bột mì 888 Cam", "bao", "Bột mì 888 Cam (25kg)", "g"),
    25000,
  );
  assert.equal(itemFactorPrefill("Bột mì 888 Cam", "bao", "Bột mì 888 Cam", "kg"), null);
  // Size in the item name wins over a size in the material name.
  assert.equal(
    itemFactorPrefill("Nước mắm 500ml", "chai", "Nước mắm 1L", "ml"),
    500,
  );
  assert.equal(itemFactorPrefill("Nước suối 1L", "bình", "Nước suối", "g"), 1000);
  assert.equal(itemFactorPrefill("Nước suối 1L", "bình", "Nước suối", "lít"), 1);
  assert.equal(itemFactorPrefill("Nước suối 25kg", "bao", "Nước suối", "kg"), 25);
  // Material counted in a count unit → no factor to prefill.
  assert.equal(itemFactorPrefill("Nước suối 20L", "bình", "Nước Vihawa", "bình"), null);
  assert.equal(itemFactorPrefill("Nước suối", "bình", "Nước suối", "g"), null);
});

test("parseMaterialLinkPendingFactors reads the pending RPC payload", () => {
  const rows = parseMaterialLinkPendingFactors({
    items: [
      {
        item_id: "11111111-1111-1111-1111-111111111111",
        name: "Nước uống Vĩnh Hảo",
        unit: "bình",
        material_id: "22222222-2222-2222-2222-222222222222",
        material_code: "NVL-NUOC-VINH-HAO",
        canonical_name: "Nước uống Vĩnh Hảo",
        material_unit: "g",
        last_purchase_line: {
          doc_kind: "po",
          doc_number: "PO-000842",
          date: "2026-10-14",
          supplier_name: null,
          raw_name: "NƯỚC VĨNH HẢO 20L",
          quantity: 10,
          unit: "bình",
          unit_price: null,
        },
      },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].material_unit, "g");
  assert.equal(rows[0].last_purchase_line?.doc_kind, "po");
  assert.equal(rows[0].last_purchase_line?.doc_number, "PO-000842");
  assert.equal(rows[0].last_purchase_line?.unit_price, null);
  assert.equal(rows[0].last_purchase_line?.quantity, 10);

  // A bare array is tolerated and missing data degrades safely.
  assert.equal(parseMaterialLinkPendingFactors([]).length, 0);
  assert.equal(parseMaterialLinkPendingFactors(null).length, 0);
  const bare = parseMaterialLinkPendingFactors([
    {
      item_id: "33333333-3333-3333-3333-333333333333",
      name: "Đường",
      unit: "bao",
      material_id: "44444444-4444-4444-4444-444444444444",
      material_code: "NVL-DUONG",
      canonical_name: "Đường cát",
      material_unit: "kg",
    },
  ]);
  assert.equal(bare[0].last_purchase_line, null);
});

test("parseMaterialLinkReview tolerates a malformed last_purchase_line", () => {
  assert.throws(
    () =>
      parseMaterialLinkReview({
        items: [
          {
            item_id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            name: "Muối",
            unit: "g",
            last_purchase_line: { doc_kind: "xx" },
          },
        ],
      }),
    TypeError,
  );
});
