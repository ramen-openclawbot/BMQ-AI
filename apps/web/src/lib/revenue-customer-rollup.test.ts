import assert from "node:assert/strict";
import test from "node:test";

import {
  buildHistoricalParentMap,
  previousRevenuePeriod,
  resolveCustomerRollup,
} from "./revenue-customer-rollup.ts";

const noHistory = new Map();

test("a parent that only exists in raw_payload is the customer key (Kingfoodmart)", () => {
  const row = { customer_id: "c1", parent_customer_id: null, customer_name: "Kingfoodmart Q7", raw_payload: { parent_customer_name: "Kingfoodmart" } };
  assert.deepEqual(resolveCustomerRollup(row, noHistory), { key: "Kingfoodmart", name: "Kingfoodmart" });
});

test("parent_customer_id wins over the parent name", () => {
  const row = { parent_customer_id: "p1", customer_name: "Chi nhánh", raw_payload: { parent_customer_name: "Tổng" } };
  assert.deepEqual(resolveCustomerRollup(row, noHistory), { key: "p1", name: "Tổng" });
});

test("without a parent the customer id, then the name, is the key", () => {
  assert.equal(resolveCustomerRollup({ customer_id: "c9", customer_name: "A" }, noHistory).key, "c9");
  assert.equal(resolveCustomerRollup({ customer_name: "A" }, noHistory).key, "A");
});

test("a child outlet takes the parent seen in the previous period", () => {
  const history = buildHistoricalParentMap([
    { customer_name: "Đại lý  Thích   Quảng Đức", parent_customer_id: "p7", raw_payload: { parent_customer_name: "Thích Quảng Đức" } },
  ]);
  const row = { customer_id: "c2", customer_name: "ĐẠI LÝ THÍCH QUẢNG ĐỨC" };
  assert.deepEqual(resolveCustomerRollup(row, history), { key: "p7", name: "Thích Quảng Đức" });
});

test("dashboard row key and source-detail filter agree for every line", () => {
  const lines = [
    { customer_id: "c1", customer_name: "King Q7", raw_payload: { parent_customer_name: "Kingfoodmart" } },
    { customer_id: "c2", customer_name: "King Q1", raw_payload: { parent_customer_name: "Kingfoodmart" } },
    { customer_id: "c3", customer_name: "Satra", raw_payload: {} },
  ];
  const keys = new Set(lines.map((line) => resolveCustomerRollup(line, noHistory).key));
  assert.deepEqual([...keys].sort(), ["Kingfoodmart", "c3"]);
  const detail = lines.filter((line) => resolveCustomerRollup(line, noHistory).key === "Kingfoodmart");
  assert.equal(detail.length, 2);
});

test("previousRevenuePeriod crosses the year boundary", () => {
  assert.equal(previousRevenuePeriod("2026-11"), "2026-10");
  assert.equal(previousRevenuePeriod("2026-01"), "2025-12");
});

test("previousLinesUpToDay keeps only the first N days of last month while the month is in progress", async () => {
  const { previousLinesUpToDay } = await import("./revenue-customer-rollup.ts");
  const rows = [{ day: 1 }, { day: 12 }, { day: 13 }, { day: 14 }, { day: 30 }, { day: 0 }];
  assert.deepEqual(previousLinesUpToDay(rows, 13, (row) => row.day).map((row) => row.day), [1, 12, 13]);
  assert.equal(previousLinesUpToDay(rows, null, (row) => row.day).length, 6, "a finished month is compared in full");
});
