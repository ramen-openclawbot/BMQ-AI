import assert from "node:assert/strict";
import test from "node:test";

import {
  applyCartProposal,
  applyRouteProposal,
  type DealerCartProposal,
  type DealerRouteProposal,
  type DealerRouteProposalLine,
  summarizeProposal,
  summarizeRouteProposal,
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

const routeProposal: DealerRouteProposal = {
  mode: "merge",
  kind: "routes",
  lines: [
    {
      route_id: "route-1",
      route_name: "Điểm bán Một",
      product_id: "pate",
      sku_code: "BMQ-001",
      product_name: "Bánh Mì Que Pate",
      unit: "que",
      unit_price: 5500,
      quantity: 10,
      exchange_quantity: 1,
      makeup_quantity: 2,
      note: "mới",
    },
    {
      route_id: "route-2",
      route_name: "Điểm bán Hai",
      product_id: "pate",
      sku_code: "BMQ-001",
      product_name: "Bánh Mì Que Pate",
      unit: "que",
      unit_price: 5500,
      quantity: 20,
      exchange_quantity: 0,
      makeup_quantity: 0,
    },
  ],
};

test("applyRouteProposal merge sums quantity per route + product and rounds up", () => {
  const current: DealerRouteProposalLine[] = [
    {
      route_id: "route-1",
      product_id: "pate",
      quantity: 10,
      exchange_quantity: 1,
      makeup_quantity: 2,
      note: "cũ",
      unit_price: 5500,
    },
  ];
  const next = applyRouteProposal(current, {
    ...routeProposal,
    lines: [{ ...routeProposal.lines[0], quantity: 5 }],
  }, "merge");

  assert.equal(next.length, 1);
  assert.equal(next[0].quantity, 20);
  assert.equal(next[0].exchange_quantity, 2);
  assert.equal(next[0].makeup_quantity, 4);
  assert.equal(next[0].note, "mới");
});

test("applyRouteProposal replace keeps only proposal lines", () => {
  const current: DealerRouteProposalLine[] = [
    { route_id: "route-old", product_id: "pate", quantity: 90, exchange_quantity: 0, makeup_quantity: 0 },
  ];
  const next = applyRouteProposal(current, routeProposal, "replace");
  assert.deepEqual(next.map((line) => line.route_id), ["route-1", "route-2"]);
  assert.equal(next[0].quantity, 10);
});

test("applyRouteProposal keeps the existing note unless the proposal note is non-empty", () => {
  const current: DealerRouteProposalLine[] = [
    { route_id: "route-1", product_id: "pate", quantity: 10, exchange_quantity: 0, makeup_quantity: 0, note: "cũ" },
  ];
  const emptyNote = applyRouteProposal(current, {
    mode: "merge",
    kind: "routes",
    lines: [{ ...routeProposal.lines[0], note: "   " }],
  }, "merge");
  assert.equal(emptyNote[0].note, "cũ");

  const newNote = applyRouteProposal(current, routeProposal, "merge");
  assert.equal(newNote[0].note, "mới");
});

test("applyRouteProposal drops lines whose physical quantity is zero", () => {
  const next = applyRouteProposal([], {
    mode: "replace",
    kind: "routes",
    lines: [
      { route_id: "route-1", product_id: "pate", quantity: 0, exchange_quantity: 0, makeup_quantity: 0 },
      { route_id: "route-2", product_id: "pate", quantity: 10, exchange_quantity: 0, makeup_quantity: 0 },
    ],
  }, "replace");
  assert.equal(next.length, 1);
  assert.equal(next[0].route_id, "route-2");
});

test("summarizeRouteProposal returns value, physical quantity and line count", () => {
  assert.deepEqual(summarizeRouteProposal(routeProposal.lines), {
    total_amount_vnd: 10 * 5500 + 20 * 5500,
    physical_quantity: 10 + 1 + 2 + 20,
    line_count: 2,
  });
});
