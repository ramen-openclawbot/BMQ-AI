import assert from "node:assert/strict";
import test from "node:test";

import type { KhoAuditRow } from "./kho-audit.ts";
import { KHO_AUDIT_GROUPS, auditLines, dayHeading, groupByDay, vnDay, vnTime } from "./kho-audit-view.ts";

const row = (over: Partial<KhoAuditRow>): KhoAuditRow => ({
  key: "k", occurred_at: "2026-10-27T08:15:00+00:00", actor_id: null, actor_name: null, kind: "edited", location: null,
  item_id: null, item_name: null, summary: "", details: {}, ...over,
});

test("Vietnam day and time cross midnight correctly", () => {
  // 17:30 UTC on 26/10 is 00:30 on 27/10 in Vietnam.
  assert.equal(vnDay("2026-10-26T17:30:00+00:00"), "2026-10-27");
  assert.equal(vnTime("2026-10-26T17:30:00+00:00"), "00:30");
  assert.equal(vnDay("2026-10-26T16:59:00+00:00"), "2026-10-26");
});

test("dayHeading names today and yesterday", () => {
  assert.equal(dayHeading("2026-10-27", "2026-10-27"), "Hôm nay · 27/10");
  assert.equal(dayHeading("2026-10-26", "2026-10-27"), "Hôm qua · 26/10");
  assert.equal(dayHeading("2026-10-20", "2026-10-27"), "20/10/2026");
});

test("groupByDay keeps order and splits on the Vietnam day", () => {
  const rows = [
    row({ key: "a", occurred_at: "2026-10-27T03:00:00+00:00" }),
    row({ key: "b", occurred_at: "2026-10-26T18:00:00+00:00" }), // 01:00 on 27/10 VN
    row({ key: "c", occurred_at: "2026-10-26T10:00:00+00:00" }),
  ];
  const days = groupByDay(rows);
  assert.deepEqual(days.map((d) => [d.day, d.rows.map((r) => r.key)]), [["2026-10-27", ["a", "b"]], ["2026-10-26", ["c"]]]);
});

test("auditLines shows before → after for an edit and the values for a created item", () => {
  const edit = auditLines(row({ kind: "renamed", details: { name: { old: "Bột mì 88", new: "Bột mì 888" }, active: { old: true, new: false }, item_class: { old: "raw_material", new: "packaging_supply" } } }));
  assert.deepEqual(edit, [
    { label: "Tên", text: "Bột mì 88 → Bột mì 888" },
    { label: "Trạng thái", text: "Bật → Tắt" },
    { label: "Loại hàng", text: "Nguyên liệu → Bao bì & vật tư" },
  ]);
  const made = auditLines(row({ kind: "created", details: { name: { old: null, new: "Món A" }, unit: { old: null, new: "g" }, note: { old: null, new: null } } }));
  assert.deepEqual(made, [{ label: "Tên", text: "Món A" }, { label: "Đơn vị", text: "g" }]);
});

test("auditLines reads ledger and transfer rows", () => {
  const stock = auditLines(row({ kind: "receipt", details: { quantity: 25.5, unit: "g", movement_date: "2026-10-27", note: "NCC giao" } }));
  assert.deepEqual(stock, [
    { label: "Số lượng", text: "25,5 g" },
    { label: "Ngày ghi sổ", text: "27/10/2026" },
    { label: "Ghi chú", text: "NCC giao" },
  ]);
  const move = auditLines(row({ kind: "transfer", details: { quantity: 3, unit: "kg", from_location: "tan_tao", to_location: "q7", slip_number: "CKP-20261027-AB12CD", transfer_date: "2026-10-27" } }));
  assert.ok(move.some((l) => l.label === "Chiều chuyển" && l.text === "Tân Tạo → Q7"));
  assert.ok(move.some((l) => l.label === "Phiếu" && l.text === "CKP-20261027-AB12CD"));
});

test("filter groups cover every kind exactly once", () => {
  const all = KHO_AUDIT_GROUPS.filter((g) => g.kinds).flatMap((g) => g.kinds!);
  assert.equal(new Set(all).size, all.length);
  assert.equal(KHO_AUDIT_GROUPS[0].kinds, null);
});
