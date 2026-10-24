import assert from "node:assert/strict";
import test from "node:test";

import {
  EXPIRY_SOON_DAYS,
  FOOD_CERT_TYPE_LABELS,
  daysLeft,
  expiryTone,
  expiryToneForDate,
  foodCertTypeLabel,
  todayIso,
} from "./kho-lots.ts";

test("daysLeft counts calendar days from a date-only reference", () => {
  assert.equal(daysLeft("2026-11-01", "2026-10-23"), 9);
  assert.equal(daysLeft("2026-10-23", "2026-10-23"), 0);
  assert.equal(daysLeft("2026-10-22", "2026-10-23"), -1);
  assert.equal(daysLeft("2026-02-28", "2026-02-01"), 27);
});

test("daysLeft accepts a Date reference without a timezone shift", () => {
  const today = new Date(2026, 9, 23, 18, 30);
  assert.equal(daysLeft("2026-10-30", today), 7);
});

test("daysLeft returns null for missing or invalid dates", () => {
  assert.equal(daysLeft(null), null);
  assert.equal(daysLeft(""), null);
  assert.equal(daysLeft("31/02/2026", "2026-02-01"), null);
  assert.equal(daysLeft("not-a-date", "2026-10-23"), null);
});

test("expiryTone uses the 30-day threshold", () => {
  assert.equal(EXPIRY_SOON_DAYS, 30);
  assert.equal(expiryTone(-1), "expired");
  assert.equal(expiryTone(0), "soon");
  assert.equal(expiryTone(30), "soon");
  assert.equal(expiryTone(31), "ok");
  assert.equal(expiryTone(null), null);
  assert.equal(expiryTone("2026-10-22", "2026-10-23"), "expired");
  assert.equal(expiryTone("2026-11-20", "2026-10-23"), "soon");
  assert.equal(expiryTone("2026-12-01", "2026-10-23"), "ok");
});

test("expiryToneForDate combines both helpers", () => {
  assert.equal(expiryToneForDate("2026-10-22", "2026-10-23"), "expired");
  assert.equal(expiryToneForDate("2026-11-20", "2026-10-23"), "soon");
  assert.equal(expiryToneForDate("2026-12-01", "2026-10-23"), "ok");
  assert.equal(expiryToneForDate(null, "2026-10-23"), null);
});

test("certificate type labels are the owner-approved Vietnamese strings", () => {
  assert.deepEqual(FOOD_CERT_TYPE_LABELS, {
    attp_facility: "Giấy chứng nhận cơ sở đủ điều kiện ATTP",
    coa: "Phiếu kiểm nghiệm (COA)",
    product_declaration: "Bản công bố sản phẩm",
    quarantine: "Giấy kiểm dịch",
    other: "Giấy tờ khác",
  });
  assert.equal(foodCertTypeLabel("coa"), "Phiếu kiểm nghiệm (COA)");
  assert.equal(foodCertTypeLabel("quarantine"), "Giấy kiểm dịch");
  assert.equal(foodCertTypeLabel("unknown"), "Giấy tờ khác");
  assert.equal(foodCertTypeLabel(null), "Giấy tờ khác");
});

test("todayIso formats the local calendar day", () => {
  assert.equal(todayIso(new Date(2026, 0, 5, 23, 59)), "2026-01-05");
});
