import assert from "node:assert/strict";
import test from "node:test";

import {
  filterKhoHolds,
  groupKhoHoldsByDay,
  holdDecisionError,
  holdMultiple,
  parseKhoHold,
  parseKhoHolds,
} from "./kho-holds.ts";

const base = {
  id: "h1",
  location: "q7",
  kitchen_inventory_item_id: "item-peerless",
  item_name: "Bơ Peerless Úc 25kg",
  item_unit: "g",
  movement_date: "2026-10-28",
  desired_qty: "1024353.592",
  delta_qty: 1024353.592,
  reference_qty: "11529.633",
  reference_days: 7,
  reason: "outlier",
  status: "held",
  approved_desired_qty: null,
};

test("parses numeric strings from the RPC and keeps the fields the page needs", () => {
  const row = parseKhoHold(base);
  assert.ok(row);
  assert.equal(row.desired_qty, 1024353.592);
  assert.equal(row.reference_qty, 11529.633);
  assert.equal(row.item_id, "item-peerless");
  assert.equal(row.movement_date, "2026-10-28");
});

test("drops rows with an unknown location, reason, status or missing quantity", () => {
  assert.equal(parseKhoHold({ ...base, location: "hcm" }), null);
  assert.equal(parseKhoHold({ ...base, reason: "other" }), null);
  assert.equal(parseKhoHold({ ...base, status: "pending" }), null);
  assert.equal(parseKhoHold({ ...base, desired_qty: null }), null);
  assert.deepEqual(parseKhoHolds({ rows: [] }), []);
  assert.equal(parseKhoHolds([base, { ...base, id: "" }, null]).length, 1);
});

test("multiple is the day over the usual day, null without a usual figure", () => {
  assert.equal(holdMultiple(parseKhoHold(base)!), 88.8);
  assert.equal(holdMultiple(parseKhoHold({ ...base, reason: "no_reference", reference_qty: null })!), null);
  assert.equal(holdMultiple(parseKhoHold({ ...base, reference_qty: 0 })!), null);
});

test("filters by kho and reason and groups newest day first, most abnormal first", () => {
  const rows = parseKhoHolds([
    base,
    { ...base, id: "h2", movement_date: "2026-10-24", item_name: "Nước đá", reason: "no_reference", reference_qty: null },
    { ...base, id: "h3", location: "tan_tao", item_name: "Nạc đùi", reference_qty: "100", desired_qty: "200" },
    { ...base, id: "h4", item_name: "Kem", reason: "no_reference", reference_qty: null },
  ]);
  assert.deepEqual(filterKhoHolds(rows, { location: "q7", reason: "all" }).map((r) => r.id), ["h1", "h2", "h4"]);
  assert.deepEqual(filterKhoHolds(rows, { location: "all", reason: "no_reference" }).map((r) => r.id), ["h2", "h4"]);
  const days = groupKhoHoldsByDay(rows);
  assert.deepEqual(days.map((d) => d.day), ["2026-10-28", "2026-10-24"]);
  assert.deepEqual(days[0].rows.map((r) => r.id), ["h1", "h3", "h4"]);
});

test("decision errors read as plain Vietnamese", () => {
  assert.match(holdDecisionError({ code: "42501", message: "insufficient_privilege" }), /chủ/);
  assert.match(holdDecisionError({ message: "hold_already_decided" }), /người khác/);
  assert.match(holdDecisionError({ message: "boom" }), /Thử lại/);
});
