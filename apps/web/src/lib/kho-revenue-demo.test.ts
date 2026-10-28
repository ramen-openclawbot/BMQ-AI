import assert from "node:assert/strict";
import test from "node:test";

import { buildRevenueDay, channelLabel, learnShrink, recentPosted, shrinkOf, WARN_MULTIPLE } from "./kho-revenue-demo.ts";
import { TRU_KHO_DEMO_20261028 } from "../data/tru-kho-demo-20261028.ts";

const raw = {
  day: "2026-10-28",
  generated_at: "2026-10-28T16:32:41Z",
  channels: [
    { channel: "BÁNH NGỌT", orders: 1, customers: 1, qty: 680, value: 10, skus: [{ code: "a", name: "Croissant", qty: 100, value: 1 }, { code: "b", name: "Bánh cua", qty: 180, value: 2 }] },
    { channel: "ĐẠI LÝ", orders: 12, customers: 20, qty: 2200, value: 20, skus: [{ code: "BMQ-001", name: "Bánh mì que Pate", qty: 2200, value: 20 }] },
  ],
  materials: [
    { channel: "ĐẠI LÝ", location: "q7", item_id: "bo", material: "Bơ", status: "ok", qty: 60000, skus: ["BMQ-001"] },
    { channel: "BÁNH NGỌT", location: "q7", item_id: "bo", material: "Bơ", status: "ok", qty: 2000, skus: ["X"] },
    { channel: "ĐẠI LÝ", location: "tan_tao", item_id: "gan", material: "Gan", status: "ok", qty: 26000, skus: ["BMQ-001"] },
    { channel: "ĐẠI LÝ", location: null, item_id: null, material: "Gas", status: "gap_ingredient", qty: null, recipe_qty: 55, recipe_unit: "kg", skus: ["BMQ-001"] },
  ],
  items: [
    { id: "bo", name: "Bơ Peerless", unit: "g", qty: { q7: 92000, tan_tao: null }, last_count: { q7: "2026-10-27", tan_tao: null } },
    { id: "gan", name: "Gan", unit: "g", qty: { q7: null, tan_tao: -5000 }, last_count: { q7: null, tan_tao: null } },
  ],
  posted: [{ loc: "q7", item_id: "bo", d: "2026-10-28", qty: 62000 }, { loc: "q7", item_id: "bo", d: "2026-10-24", qty: 9000 }],
  refs: [{ loc: "q7", item_id: "bo", ref: 10000, days: 7 }, { loc: "tan_tao", item_id: "gan", ref: null, days: 0 }],
};

test("one PO per channel, busiest first, label in plain Vietnamese", () => {
  const day = buildRevenueDay(raw);
  assert.deepEqual(day.channels.map((c) => c.label), ["Đại lý", "Bánh ngọt"]);
  assert.equal(day.totals.qty, 2880);
  assert.deepEqual(day.channels[1].skus.map((s) => s.name), ["Bánh cua", "Croissant"], "SKUs sorted by quantity");
  assert.equal(channelLabel("B2B BMQ"), "B2B BMQ");
});

test("warning compares the whole day at that kho, across channels, with the usual day", () => {
  const day = buildRevenueDay(raw);
  const bo = day.channels[0].materials.q7[0];
  assert.ok(bo.warning, `62 kg against 10 kg/day is over ${WARN_MULTIPLE}x`);
  assert.equal(bo.warning?.kind === "usual" && bo.warning.multiple, 6.2);
  const other = day.channels[1].materials.q7[0].warning;
  assert.equal(other?.kind === "usual" && other.multiple, 6.2, "the same day total flags both channels");
  assert.equal(day.totals.warnings, 2);
  const gan = day.channels[0].materials.tan_tao[0];
  assert.equal(gan.warning, null, "no history is never a warning");
  assert.equal(gan.noHistory, true);
});

test("unlinked recipe lines keep the recipe quantity and unit", () => {
  const day = buildRevenueDay(raw);
  assert.equal(day.channels[0].unlinked.length, 1);
  assert.equal(day.channels[0].unlinked[0].state, "not_linked");
  assert.equal(day.channels[0].unlinked[0].unit, "kg");
  assert.equal(day.channels[0].unlinked[0].qty, 55);
});

test("stock and recent deductions per kho", () => {
  const day = buildRevenueDay(raw);
  assert.equal(day.items.get("bo")?.qty.q7, 92000);
  assert.deepEqual(recentPosted(day, "q7", "bo").map((p) => p.day), ["2026-10-24", "2026-10-28"]);
  assert.deepEqual(recentPosted(day, "tan_tao", "bo"), []);
});

test("bad input never throws", () => {
  const day = buildRevenueDay(null);
  assert.equal(day.channels.length, 0);
  assert.equal(day.totals.qty, 0);
});

test("the shipped 28/10 snapshot has the three real channels", () => {
  const day = buildRevenueDay(TRU_KHO_DEMO_20261028);
  assert.equal(day.day, "2026-10-28");
  assert.deepEqual(day.channels.map((c) => [c.label, c.qty]), [["Đại lý", 2200], ["Bánh ngọt", 680], ["B2B BMQ", 158]]);
  for (const c of day.channels) {
    for (const kho of ["q7", "tan_tao"] as const) {
      for (const m of c.materials[kho]) assert.ok(day.items.has(m.itemId as string), `stock known for ${m.name}`);
    }
  }
});

test("a weighed material over 500 g per finished item is flagged even without history", () => {
  const day = buildRevenueDay({ ...raw, materials: [...raw.materials, { channel: "ĐẠI LÝ", location: "tan_tao", item_id: "foil", material: "Nhôm lá", status: "ok", qty: 2200 * 5000, skus: ["BMQ-001"] }],
    items: [...raw.items, { id: "foil", name: "Nhôm lá", unit: "g", qty: { q7: null, tan_tao: 10000 }, last_count: {} }] });
  const foil = day.channels[0].materials.tan_tao.find((m) => m.name === "Nhôm lá");
  assert.deepEqual(foil?.warning, { kind: "per_unit", perUnit: 5000 });
  const gan = day.channels[0].materials.tan_tao.find((m) => m.name === "Gan");
  assert.equal(gan?.warning, null, "11,8 g of gan per stick is normal");
});

test("in the real 28/10 snapshot only Nhôm lá (5 kg per bánh mì) is flagged", () => {
  const day = buildRevenueDay(TRU_KHO_DEMO_20261028);
  const flagged = day.channels.flatMap((c) => [...c.materials.q7, ...c.materials.tan_tao].filter((m) => m.warning).map((m) => m.name));
  assert.deepEqual(flagged, ["Nhôm lá GF004_5Kg M"]);
});

test("shrinkage from counts: applied within ±15%, ignored under 2%, blocked beyond", () => {
  const p = (from: string, to: string, adj: number, booked: number) => ({ from, to, adj, booked });
  assert.deepEqual(learnShrink([p("2026-10-01", "2026-10-08", -5000, 100000)], null), { state: "applied", rate: 0.05, periods: 1, lastCount: null });
  assert.equal(learnShrink([p("2026-10-01", "2026-10-08", -1000, 100000)], null).state, "even");
  assert.equal(learnShrink([p("2026-10-01", "2026-10-08", -40000, 100000)], null).state, "blocked");
  assert.equal(learnShrink([p("2026-10-01", "2026-10-03", -5000, 100000)], null).state, "none", "periods under 3 days are skipped");
  assert.equal(learnShrink([p("2026-10-01", "2026-10-08", -5000, 0)], null).state, "none", "nothing booked, nothing to learn");
  const weighted = learnShrink([p("2026-10-01", "2026-10-08", -10000, 100000), p("2026-10-08", "2026-10-15", 0, 300000)], null);
  assert.equal(weighted.rate, 0.025, "weighted by booked usage");
  assert.equal(weighted.periods, 2);
});

test("in the real snapshot Bơ Peerless at Q7 is blocked (count shortfall 165% of booked usage)", () => {
  const day = buildRevenueDay(TRU_KHO_DEMO_20261028);
  const peerless = shrinkOf(day, "q7", "3c16ed3f-54c7-427f-a316-5aa4fcadda5a");
  assert.equal(peerless.state, "blocked");
  assert.ok((peerless.rate ?? 0) > 1.5);
  assert.equal(peerless.lastCount?.day, "2026-10-27");
  const applied = [...day.shrink.values()].filter((v) => v.state === "applied");
  assert.equal(applied.length, 0, "no real period is clean enough to apply yet");
});
