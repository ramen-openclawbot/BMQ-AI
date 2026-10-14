import assert from "node:assert/strict";
import test from "node:test";

import { kfmMoqPieces, kfmPiecesPerUnit } from "./kfm-moq";

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
