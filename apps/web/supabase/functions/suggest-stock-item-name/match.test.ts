import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSuggestion,
  MAX_LINE_SCORE,
  MIN_LINE_SCORE,
  pickInvoiceLine,
  type InvoiceLine,
} from "./match.ts";

// Real Mega Market invoice lines used for the required cases.
const GIAM_LINE: InvoiceLine = {
  product_name: "GIẤM TINH LUYỆN MINH CHÂU 4% 1L",
  quantity: 1,
  unit: "chai",
  unit_price: 18333,
};
const TOI_LINE: InvoiceLine = {
  product_name: "TỎI BÔNG SEN",
  quantity: 2,
  unit: "cái",
  unit_price: 45000,
};
const OT_LINE: InvoiceLine = {
  product_name: "ỚT SỪNG",
  quantity: 1,
  unit: "hộp",
  unit_price: 35000,
};

test("pickInvoiceLine chooses the giấm line from real Mega Market invoice lines", () => {
  const picked = pickInvoiceLine(
    { name: "Giấm tinh luyện", quantity: 1, unit: "chai", unit_price: 18333 },
    [GIAM_LINE, TOI_LINE, OT_LINE],
  );

  assert.ok(picked);
  assert.equal(picked.line.product_name, "GIẤM TINH LUYỆN MINH CHÂU 4% 1L");
  assert.equal(picked.score, MAX_LINE_SCORE);
});

test("pickInvoiceLine matches 'Ơt sừng' to 'ỚT SỪNG' through the unit price", () => {
  const picked = pickInvoiceLine(
    { name: "Ơt sừng", quantity: 1, unit: "hộp", unit_price: 35000 },
    [
      { product_name: "ỚT SỪNG", quantity: 2, unit: "hộp", unit_price: 35000 },
      { product_name: "ỚT SỪNG", quantity: 1, unit: "hộp", unit_price: 35000 },
      { product_name: "TỎI BÔNG SEN", quantity: 1, unit: "cái", unit_price: 45000 },
    ],
  );

  assert.ok(picked);
  assert.equal(picked.line.product_name, "ỚT SỪNG");
  assert.equal(picked.line.quantity, 1);
  assert.equal(picked.score, MAX_LINE_SCORE);
});

test("pickInvoiceLine keeps a candidate whose price and quantity match even when not every name word matches", () => {
  const picked = pickInvoiceLine(
    { name: "Đường cát", quantity: 1, unit: "kg", unit_price: 25000 },
    [{ product_name: "ĐƯỜNG TRẮNG TINH LUYỆN", quantity: 1, unit: "kg", unit_price: 25000 }],
  );

  assert.ok(picked);
  assert.equal(picked.line.product_name, "ĐƯỜNG TRẮNG TINH LUYỆN");
  assert.equal(picked.score, 3 + 2 + (1 / 2) * 2);
});

test("pickInvoiceLine accepts a unit price within one percent of the target", () => {
  const picked = pickInvoiceLine(
    { name: "Giấm tinh luyện", quantity: 1, unit: "chai", unit_price: 18333 },
    [{ product_name: "GIẤM TINH LUYỆN MINH CHÂU 4% 1L", quantity: 1, unit: "chai", unit_price: 18400 }],
  );

  assert.ok(picked);
  assert.equal(picked.score, MAX_LINE_SCORE);
});

test("pickInvoiceLine returns null when two lines tie at the top score", () => {
  const picked = pickInvoiceLine(
    { name: "ỚT SỪNG", quantity: 1, unit: "hộp", unit_price: 35000 },
    [
      { product_name: "ỚT SỪNG", quantity: 1, unit: "hộp", unit_price: 35000 },
      { product_name: "ỚT SỪNG", quantity: 1, unit: "hộp", unit_price: 35000 },
    ],
  );

  assert.equal(picked, null);
});

test("pickInvoiceLine returns null when no line reaches the minimum score", () => {
  const picked = pickInvoiceLine(
    { name: "Giấm tinh luyện", quantity: 5, unit: "chai", unit_price: 18333 },
    [TOI_LINE],
  );

  assert.equal(picked, null);
});

test("pickInvoiceLine returns null for an empty line list", () => {
  assert.equal(
    pickInvoiceLine(
      { name: "Giấm tinh luyện", quantity: 1, unit: "chai", unit_price: 18333 },
      [],
    ),
    null,
  );
});

test("pickInvoiceLine ignores blank product names", () => {
  const picked = pickInvoiceLine(
    { name: "Giấm tinh luyện", quantity: 1, unit: "chai", unit_price: 18333 },
    [{ product_name: "   ", quantity: 1, unit: "chai", unit_price: 18333 }],
  );

  assert.equal(picked, null);
});

test("buildSuggestion trims and collapses the printed name, keeping its unit", () => {
  assert.deepEqual(
    buildSuggestion({ product_name: "  GIẤM   TINH LUYỆN MINH CHÂU 4% 1L \n", unit: " chai " }),
    { full_name: "GIẤM TINH LUYỆN MINH CHÂU 4% 1L", unit: "chai" },
  );

  assert.deepEqual(
    buildSuggestion({ product_name: "TỎI BÔNG SEN", unit: null }),
    { full_name: "TỎI BÔNG SEN", unit: null },
  );

  assert.deepEqual(
    buildSuggestion({ product_name: "TỎI BÔNG SEN", unit: "  " }),
    { full_name: "TỎI BÔNG SEN", unit: null },
  );
});

test("score constants describe the full agreement case", () => {
  assert.equal(MIN_LINE_SCORE, 3);
  assert.equal(MAX_LINE_SCORE, 7);
});

test("the real Mega Market giấm line: abbreviated name, gross price + discount, expanded standard name", () => {
  const line: InvoiceLine = {
    product_name: "GIAM T.LUYEN MINH CHAU 4% 1L",
    standard_name: "Giấm tinh luyện Minh Châu 4% 1L",
    quantity: 1,
    unit: "chai nhựa",
    unit_price: 19860,
    net_amount: 18333,
  };
  const picked = pickInvoiceLine(
    { name: "Giấm tinh luyện", quantity: 1, unit: "chai", unit_price: 18333 },
    [
      { product_name: "GAN HEO", quantity: 10.144, unit: "kg", unit_price: 116393, net_amount: 947143 },
      line,
      { product_name: "TOI BONG SEN T. HANG (500G)", quantity: 2, unit: "cái", unit_price: 44191, net_amount: 71238 },
    ],
  );
  assert.ok(picked);
  assert.equal(picked.line.product_name, "GIAM T.LUYEN MINH CHAU 4% 1L");
  assert.equal(picked.score, MAX_LINE_SCORE);
  assert.deepEqual(buildSuggestion(picked.line), { full_name: "Giấm tinh luyện Minh Châu 4% 1L", unit: "chai nhựa" });
});

test("without the expanded name an abbreviated line still matches on net price + quantity", () => {
  const picked = pickInvoiceLine(
    { name: "Giấm tinh luyện", quantity: 1, unit: "chai", unit_price: 18333 },
    [{ product_name: "GIAM T.LUYEN MINH CHAU 4% 1L", quantity: 1, unit: "chai", unit_price: 19860, net_amount: 18333 }],
  );
  assert.ok(picked);
});
