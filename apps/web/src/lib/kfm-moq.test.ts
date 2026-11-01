import assert from "node:assert/strict";
import test from "node:test";

import {
  kfmMoqPieces,
  kfmPiecesPerUnit,
  kfmShortPacks,
  parseKfmProductionPreflight,
} from "./kfm-moq.ts";

test("box products count their pieces", () => {
  assert.equal(kfmPiecesPerUnit("BÁNH CUA PHÔ MAI"), 3);
  assert.equal(kfmPiecesPerUnit("BÁNH CROFFLE 160G (40G x 4 CÁI)"), 4);
  assert.equal(kfmPiecesPerUnit("BÁNH CROISSANT 160G (40G x 4 CÁI)"), 4);
  assert.equal(kfmPiecesPerUnit("BÁNH CROISSANT 50G"), 1);
  assert.equal(kfmPiecesPerUnit("Bánh Mì Chà Bông"), 1);
});

test("15/10 KFM POs add up to 1718 pieces", () => {
  const po002 = [
    { product_name: "BÁNH CROISSANT 50G", qty: 120 },
    { product_name: "Bánh Mì Chà Bông", qty: 158 },
    { product_name: "BÁNH MÌ CHÀ BÔNG CAY", qty: 177 },
    { product_name: "BÁNH CUA PHÔ MAI", qty: 190 },
    { product_name: "BÁNH CROISSANT 160G (40G x 4 CÁI)", qty: 104 },
    { product_name: "BÁNH CROFFLE 160G (40G x 4 CÁI)", qty: 62 },
  ];
  const po001 = [
    { product_name: "BÁNH CROFFLE 160G (40G x 4 CÁI)", qty: 2 },
    { product_name: "BÁNH CROISSANT 160G (40G x 4 CÁI)", qty: 3 },
    { product_name: "BÁNH CUA PHÔ MAI", qty: 2 },
    { product_name: "BÁNH MÌ CHÀ BÔNG CAY", qty: 3 },
  ];
  assert.equal(kfmMoqPieces(po002), 1689);
  assert.equal(kfmMoqPieces([...po002, ...po001]), 1718);
});

test("preflight parser accepts string numerics from PostgREST", () => {
  const parsed = parseKfmProductionPreflight({
    is_kfm: "true",
    delivery_date: "2030-01-05",
    min_packs: "600",
    new_packs: "100",
    existing: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        production_number: "SX-20300105-002",
        po_number: "PO1001234567",
        packs: "600",
        cancellable: "true",
      },
    ],
    other_packs: "600",
    total_packs: "700",
    below_min: "false",
  });

  assert.deepEqual(parsed, {
    isKfm: true,
    deliveryDate: "2030-01-05",
    minPacks: 600,
    newPacks: 100,
    existing: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        productionNumber: "SX-20300105-002",
        poNumber: "PO1001234567",
        packs: 600,
        cancellable: true,
      },
    ],
    otherPacks: 600,
    totalPacks: 700,
    belowMin: false,
  });
});

test("preflight parser tolerates missing fields", () => {
  assert.deepEqual(parseKfmProductionPreflight({}), {
    isKfm: false,
    deliveryDate: null,
    minPacks: 600,
    newPacks: 0,
    existing: [],
    otherPacks: 0,
    totalPacks: 0,
    belowMin: false,
  });
  assert.deepEqual(parseKfmProductionPreflight(null).existing, []);
});

test("preflight parser derives total and below_min when omitted", () => {
  const parsed = parseKfmProductionPreflight({
    isKfm: true,
    newPacks: "570",
    existing: "not-an-array",
  });
  assert.equal(parsed.totalPacks, 570);
  assert.equal(parsed.belowMin, true);
  assert.equal(parsed.minPacks, 600);
  assert.deepEqual(parsed.existing, []);
});

test("kfmShortPacks counts the missing packs", () => {
  assert.equal(kfmShortPacks(570), 30);
  assert.equal(kfmShortPacks(570.5), 29.5);
  assert.equal(kfmShortPacks(600), 0);
  assert.equal(kfmShortPacks(900), 0);
  assert.equal(kfmShortPacks(0), 600);
  assert.equal(kfmShortPacks(450, 400), 0);
});
