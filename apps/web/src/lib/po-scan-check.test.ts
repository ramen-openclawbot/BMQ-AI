// Node tests for the PO scan price/unit rules.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  checkAgainstHistory,
  checkScannedLine,
  normalizePoUnit,
  type PoScanLastLine,
  type PoScanLine,
} from "./po-scan-check.ts";

const lastGiay: PoScanLastLine = {
  quantity: 5000,
  unit: "tờ",
  unit_price: 185,
  po_number: "PO-000744",
};

test("the real scan is flagged as a swap with the previous line's unit", () => {
  // 185 gói × 5.000đ was really 5.000 tờ × 185đ (PO-000744).
  const result = checkScannedLine(
    { quantity: 185, unit: "gói", unit_price: 5000 },
    lastGiay,
  );
  assert.equal(result.kind, "swap");
  assert.deepEqual(result.suggestion, { quantity: 5000, unit: "tờ", unit_price: 185 });
  assert.equal(
    result.message,
    "Nghi đảo số lượng/đơn giá — lần trước 185đ/tờ (PO-000744)",
  );
});

test("a normal line is ok", () => {
  const result = checkScannedLine(
    { quantity: 10, unit: "tờ", unit_price: 185 },
    lastGiay,
  );
  assert.equal(result.kind, "ok");
  assert.equal(result.message, null);
  assert.equal(result.suggestion, null);
});

test("a price outlier without a matching swap is a price warning", () => {
  const result = checkScannedLine(
    { quantity: 10, unit: "tờ", unit_price: 5000 },
    { quantity: 10, unit: "tờ", unit_price: 185 },
  );
  assert.equal(result.kind, "price");
  assert.equal(result.suggestion, null);
  assert.equal(result.message, "Đơn giá lệch nhiều — lần trước 185đ/tờ");
});

test("'từ' and 'tờ' are the same unit", () => {
  assert.equal(normalizePoUnit("từ"), "tờ");
  assert.equal(normalizePoUnit("tờ"), "tờ");
  const result = checkScannedLine(
    { quantity: 10, unit: "từ", unit_price: 185 },
    lastGiay,
  );
  assert.equal(result.kind, "ok");
});

test("a different unit at a normal price is a unit warning", () => {
  const result = checkScannedLine(
    { quantity: 10, unit: "gói", unit_price: 185 },
    { quantity: 10, unit: "tờ", unit_price: 185 },
  );
  assert.equal(result.kind, "unit");
  assert.equal(result.message, "Đơn vị khác lần trước (tờ)");
  assert.deepEqual(result.suggestion, { quantity: 10, unit: "tờ", unit_price: 185 });
});

test("no previous line is ok", () => {
  const result = checkScannedLine({ quantity: 10, unit: "tờ", unit_price: 185 }, null);
  assert.equal(result.kind, "ok");
  assert.equal(result.suggestion, null);
});

test("zero or negative numbers are ok", () => {
  const badLines: PoScanLine[] = [
    { quantity: 0, unit: "tờ", unit_price: 185 },
    { quantity: -1, unit: "tờ", unit_price: 185 },
    { quantity: 10, unit: "tờ", unit_price: 0 },
    { quantity: 10, unit: "tờ", unit_price: -185 },
  ];
  for (const line of badLines) {
    assert.equal(checkScannedLine(line, lastGiay).kind, "ok");
  }
  assert.equal(
    checkScannedLine({ quantity: 10, unit: "tờ", unit_price: 185 }, {
      quantity: 0,
      unit: "tờ",
      unit_price: 185,
    }).kind,
    "ok",
  );
});

test("common unit misreads collapse to the canonical Vietnamese spelling", () => {
  assert.equal(normalizePoUnit("  KG "), "kg");
  assert.equal(normalizePoUnit("kí"), "kg");
  assert.equal(normalizePoUnit("ký"), "kg");
  assert.equal(normalizePoUnit("cai"), "cái");
  assert.equal(normalizePoUnit("goi"), "gói");
  assert.equal(normalizePoUnit("hop"), "hộp");
  assert.equal(normalizePoUnit("cuon"), "cuộn");
  assert.equal(normalizePoUnit(""), "");
});

test("history: one misread PO does not hide a swap", () => {
  const swapped = checkAgainstHistory({ quantity: 185, unit: "gói", unit_price: 5000 }, [lastGiay, { quantity: 4000, unit: "tờ", unit_price: 190 }]);
  assert.equal(swapped.kind, "swap");
  assert.deepEqual(swapped.suggestion, { quantity: 5000, unit: "tờ", unit_price: 185 });
  assert.equal(checkAgainstHistory({ quantity: 5000, unit: "tờ", unit_price: 185 }, [lastGiay]).kind, "ok");
  assert.equal(checkAgainstHistory({ quantity: 5000, unit: "tờ", unit_price: 185 }, []).kind, "ok");
  assert.equal(checkAgainstHistory({ quantity: 10, unit: "tờ", unit_price: 5000 }, [{ quantity: 10, unit: "tờ", unit_price: 185 }]).kind, "price");
});

test("history: contradicting previous lines give a review warning without a fix", () => {
  const bad: PoScanLastLine = { quantity: 185, unit: "gói", unit_price: 5000, po_number: "PO-000775" };
  for (const line of [{ quantity: 185, unit: "gói", unit_price: 5000 }, { quantity: 5000, unit: "tờ", unit_price: 185 }]) {
    const result = checkAgainstHistory(line, [bad, lastGiay]);
    assert.equal(result.kind, "price");
    assert.equal(result.suggestion, null);
    assert.match(result.message ?? "", /PO-000744/);
    assert.match(result.message ?? "", /PO-000775/);
  }
});
