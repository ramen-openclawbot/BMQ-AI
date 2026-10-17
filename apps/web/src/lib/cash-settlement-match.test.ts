import assert from "node:assert/strict";
import test from "node:test";

import {
  matchCashSettlement,
  splitReceiptAcrossItems,
  type CashSettlementItemInput,
  type CashSettlementReceiptInput,
} from "./cash-settlement-match.ts";

const item = (overrides: Partial<CashSettlementItemInput> = {}): CashSettlementItemInput => ({
  id: overrides.id ?? "item-1",
  label: overrides.label ?? null,
  amount: overrides.amount ?? 0,
  covered: overrides.covered ?? 0,
  ...overrides,
});

const receipt = (overrides: Partial<CashSettlementReceiptInput> = {}): CashSettlementReceiptInput => ({
  id: overrides.id ?? "receipt-1",
  amount: overrides.amount === undefined ? 100_000 : overrides.amount,
  status: overrides.status ?? "uploaded",
  ...overrides,
});

const allocationTotal = (allocations: { amount: number }[]): number =>
  allocations.reduce((sum, allocation) => sum + allocation.amount, 0);

test("PR-303EBE40: one 5.238.000 receipt pays 2.592.000 + 2.646.000", () => {
  const result = matchCashSettlement(
    [
      item({ id: "i1", label: "Khoản 1", amount: 2_592_000 }),
      item({ id: "i2", label: "Khoản 2", amount: 2_646_000 }),
    ],
    [receipt({ id: "r1", amount: 5_238_000 })],
  );

  assert.deepEqual(result.allocations, [
    { receipt_id: "r1", item_id: "i1", amount: 2_592_000 },
    { receipt_id: "r1", item_id: "i2", amount: 2_646_000 },
  ]);
  assert.equal(allocationTotal(result.allocations), 5_238_000);
  assert.ok(result.items.every((entry) => entry.fully_covered));
  assert.equal(result.remaining_total, 0);
  assert.equal(result.receipts[0].state, "matched");
});

test("rule 0 compares the all-items total to whole đồng (lẻ xu)", () => {
  const result = matchCashSettlement(
    [
      item({ id: "i1", amount: 2_592_000.4 }),
      item({ id: "i2", amount: 2_645_999.5 }),
    ],
    [receipt({ id: "r1", amount: 5_238_000 })],
  );

  // 2.592.000,4 + 2.645.999,5 = 5.237.999,9 -> whole đồng 5.238.000.
  assert.deepEqual(result.allocations, [
    { receipt_id: "r1", item_id: "i1", amount: 2_592_000.4 },
    { receipt_id: "r1", item_id: "i2", amount: 2_645_999.5 },
  ]);
  assert.ok(result.items.every((entry) => entry.fully_covered));
  assert.equal(result.remaining_total, 0);
});

test("splitReceiptAcrossItems fills items in order and never exceeds the receipt", () => {
  assert.deepEqual(
    splitReceiptAcrossItems(5_100_000, [
      { id: "i1", remaining: 2_592_000 },
      { id: "i2", remaining: 2_646_000 },
    ]),
    [
      { item_id: "i1", amount: 2_592_000 },
      { item_id: "i2", amount: 2_508_000 },
    ],
  );

  assert.deepEqual(
    splitReceiptAcrossItems(1_000_000, [
      { id: "i1", remaining: 2_592_000 },
      { id: "i2", remaining: 2_646_000 },
    ]),
    [{ item_id: "i1", amount: 1_000_000 }],
  );

  assert.deepEqual(
    splitReceiptAcrossItems(5_238_000, [
      { id: "i1", remaining: 2_592_000 },
      { id: "i2", remaining: 2_646_000 },
    ]),
    [
      { item_id: "i1", amount: 2_592_000 },
      { item_id: "i2", amount: 2_646_000 },
    ],
  );

  assert.deepEqual(splitReceiptAcrossItems(0, [{ id: "i1", remaining: 100_000 }]), []);
});

test("owner example: 252k water, 400k glass, 130k shipping, 320k fuel", () => {
  const result = matchCashSettlement(
    [
      item({ id: "water", label: "Nước", amount: 252_000 }),
      item({ id: "glass", label: "Ly", amount: 400_000 }),
      item({ id: "shipping", label: "Vận chuyển", amount: 130_000 }),
      item({ id: "fuel", label: "Xăng", amount: 320_000 }),
    ],
    [
      receipt({ id: "r-252", amount: 252_000 }),
      receipt({ id: "r-400", amount: 400_000 }),
      receipt({ id: "r-81", amount: 81_000 }),
      receipt({ id: "r-49", amount: 49_000 }),
      receipt({ id: "r-320", amount: 320_000 }),
    ],
  );

  assert.ok(result.items.every((entry) => entry.fully_covered));
  assert.equal(result.remaining_total, 0);
  assert.equal(result.covered_total, 1_102_000);

  const shipping = result.allocations.filter((allocation) => allocation.item_id === "shipping");
  assert.deepEqual(shipping.map((allocation) => allocation.receipt_id).sort(), ["r-49", "r-81"]);
  assert.equal(allocationTotal(shipping), 130_000);
  assert.equal(result.receipts.every((entry) => entry.state === "matched"), true);
});

test("leaves an item unmatched when no receipt or subset equals its amount", () => {
  const result = matchCashSettlement(
    [item({ id: "i1", amount: 500_000 })],
    [receipt({ id: "r1", amount: 300_000 })],
  );

  assert.equal(result.allocations.length, 0);
  assert.equal(result.items[0].covered, 0);
  assert.equal(result.items[0].remaining, 500_000);
  assert.equal(result.items[0].fully_covered, false);
  assert.equal(result.receipts[0].state, "unmatched");
});

test("reports a receipt without a readable amount as no_amount", () => {
  const result = matchCashSettlement(
    [item({ id: "i1", amount: 100_000 })],
    [receipt({ id: "r1", amount: null })],
  );

  assert.equal(result.allocations.length, 0);
  assert.equal(result.receipts[0].state, "no_amount");
  assert.equal(result.receipts[0].matched, false);
  assert.equal(result.items[0].remaining, 100_000);
});

test("does not auto-match a duplicate equal amount shared by two items", () => {
  const result = matchCashSettlement(
    [item({ id: "a", amount: 100_000 }), item({ id: "b", amount: 100_000 })],
    [receipt({ id: "r1", amount: 100_000 })],
  );

  assert.equal(result.allocations.length, 0);
  assert.equal(result.items[0].remaining, 100_000);
  assert.equal(result.items[1].remaining, 100_000);
  assert.equal(result.receipts[0].state, "unmatched");
});

test("leaves a partial cover unmatched and keeps the item remaining", () => {
  const result = matchCashSettlement(
    [item({ id: "i1", amount: 1_000_000 })],
    [receipt({ id: "r1", amount: 600_000 })],
  );

  assert.equal(result.allocations.length, 0);
  assert.equal(result.items[0].covered, 0);
  assert.equal(result.items[0].remaining, 1_000_000);
  assert.equal(result.receipts[0].state, "unmatched");
});

test("matches the remaining amount of a partially covered item", () => {
  const result = matchCashSettlement(
    [item({ id: "i1", amount: 1_000_000, covered: 400_000 })],
    [receipt({ id: "r1", amount: 600_000 })],
  );

  assert.equal(result.allocations.length, 1);
  assert.deepEqual(result.allocations[0], { receipt_id: "r1", item_id: "i1", amount: 600_000 });
  assert.equal(result.items[0].covered, 1_000_000);
  assert.equal(result.items[0].remaining, 0);
  assert.equal(result.items[0].fully_covered, true);
});

test("never over-allocates a receipt across two items", () => {
  const result = matchCashSettlement(
    [item({ id: "a", amount: 150_000 }), item({ id: "b", amount: 150_000 })],
    [receipt({ id: "r1", amount: 300_000 })],
  );

  // Rule 0 now splits r1 across the two items: 150k + 150k = 300k, never over.
  assert.equal(result.allocations.length, 2);
  assert.equal(allocationTotal(result.allocations), 300_000);
  assert.ok(result.allocations.every((allocation) => allocation.amount === 150_000));
  assert.ok(result.items.every((entry) => entry.fully_covered));
});

test("combines two receipts for one item when the subset is unique", () => {
  const result = matchCashSettlement(
    [item({ id: "shipping", amount: 130_000 })],
    [receipt({ id: "r1", amount: 81_000 }), receipt({ id: "r2", amount: 49_000 })],
  );

  assert.equal(result.allocations.length, 2);
  assert.equal(allocationTotal(result.allocations), 130_000);
  assert.equal(result.items[0].fully_covered, true);
});

test("ignores discarded receipts", () => {
  const result = matchCashSettlement(
    [item({ id: "i1", amount: 100_000 })],
    [receipt({ id: "r1", amount: 100_000, status: "discarded" })],
  );

  assert.equal(result.allocations.length, 0);
  assert.equal(result.receipts[0].state, "unmatched");
  assert.equal(result.items[0].remaining, 100_000);
});
