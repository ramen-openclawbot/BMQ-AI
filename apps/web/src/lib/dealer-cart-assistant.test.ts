import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCartProposal,
  type DealerCartProposal,
  summarizeProposal,
} from "./dealer-cart-assistant.ts";

const proposal: DealerCartProposal = {
  mode: "merge",
  lines: [
    {
      product_id: "pate",
      sku_code: "BMQ-001",
      product_name: "Bánh Mì Que Pate",
      unit: "que",
      unit_price: 5500,
      quantity: 10,
    },
    {
      product_id: "dark-rye",
      sku_code: "BMD-2026",
      product_name: "Bánh Mì Dark Rye",
      unit: "cái",
      unit_price: 12000,
      quantity: 20,
    },
  ],
};

test("merge adds the proposed quantity and rounds the sum up to 10", () => {
  const next = applyCartProposal({ pate: 5, other: 30 }, proposal, "merge");
  assert.deepEqual(next, { pate: 20, other: 30, "dark-rye": 20 });
});

test("merge never mutates the current quantities object", () => {
  const current = { pate: 10 };
  applyCartProposal(current, proposal, "merge");
  assert.deepEqual(current, { pate: 10 });
});

test("replace keeps only proposal products and discards the old cart", () => {
  const next = applyCartProposal({ pate: 90, other: 30 }, proposal, "replace");
  assert.deepEqual(next, { pate: 10, "dark-rye": 20 });
});

test("replace rounds a non-step quantity up", () => {
  const next = applyCartProposal({}, {
    mode: "replace",
    lines: [{ product_id: "pate", quantity: 7, unit_price: 5500 }],
  }, "replace");
  assert.deepEqual(next, { pate: 10 });
});

test("ignores invalid proposal lines", () => {
  const next = applyCartProposal({ pate: 10 }, {
    mode: "merge",
    lines: [
      { product_id: "", quantity: 10 },
      { product_id: "pate", quantity: -10 },
      { product_id: "pate", quantity: "abc" as unknown as number },
    ],
  }, "merge");
  assert.deepEqual(next, { pate: 10 });
});

test("summarizeProposal returns total value and line count", () => {
  assert.deepEqual(summarizeProposal(proposal), {
    total_amount_vnd: 10 * 5500 + 20 * 12000,
    line_count: 2,
  });
  assert.deepEqual(summarizeProposal(null), { total_amount_vnd: 0, line_count: 0 });
});
