// Node tests for the pack count written in an invoice name's trailing bracket.
import assert from "node:assert/strict";
import test from "node:test";

import { packCountFactor, parsePackBracket } from "./pack-count-factor.ts";

test("a trailing '(Bao 100 Cái)' gives the line-unit → stock-unit factor", () => {
  assert.equal(
    packCountFactor("THỚI B BĂNG KEO VÀNG -VP (Bao 100 Cái)", "bao", "cái"),
    100,
  );
  assert.equal(
    packCountFactor("BAO TAY Y TẾ ĐEN SIZE L (HỘP 100 CÁI)", "hộp", "cái"),
    100,
  );
});

test("the bracket only counts when its count unit is the stock unit", () => {
  assert.equal(
    packCountFactor("BAO TAY Y TẾ ĐEN SIZE L (HỘP 100 CÁI)", "hộp", "hộp"),
    null,
  );
  assert.equal(packCountFactor("BAO PE 13X23 (BAO 10 KG)", "bao", "cái"), null);
  assert.equal(packCountFactor("Bột mì 888 Cam", "bao", "cái"), null);
});

test("a missing line unit is never guessed", () => {
  assert.equal(packCountFactor("THỚI B BĂNG KEO VÀNG -VP (Bao 100 Cái)", null, "cái"), null);
  assert.equal(packCountFactor("THỚI B BĂNG KEO VÀNG -VP (Bao 100 Cái)", undefined, "cái"), null);
});

test("pack word and count unit compare accent- and case-insensitively", () => {
  assert.equal(packCountFactor("(Bao 100 Cái)", "BAO", "CÁI"), 100);
  assert.equal(packCountFactor("(bAo 100 cÁi)", "bao", "cái"), 100);
  assert.equal(packCountFactor("(BĂNG KEO 100 CÁI)", "băng keo", "cái"), 100);
  assert.equal(packCountFactor("(HỘP 100 CÁI)", "hop", "cai"), 100);
});

test("a decimal pack size keeps its value", () => {
  assert.equal(packCountFactor("(Thùng 12,5 cái)", "thùng", "cái"), 12.5);
  assert.equal(packCountFactor("(Thùng 12.5 cái)", "thùng", "cái"), 12.5);
});

test("only the last bracket that closes the name is read", () => {
  assert.equal(packCountFactor("Tên (ghi chú) (Bao 100 Cái)", "bao", "cái"), 100);
  assert.equal(packCountFactor("Bao bì (Bao 100 Cái)", "bao", "cái"), 100);
});

test("a zero or non-positive pack is rejected", () => {
  assert.equal(packCountFactor("(Bao 0 Cái)", "bao", "cái"), null);
});

test("parsePackBracket exposes the raw bracket pieces", () => {
  assert.deepEqual(parsePackBracket("THỚI B BĂNG KEO VÀNG -VP (Bao 100 Cái)"), {
    pack: "Bao",
    count: 100,
    unit: "Cái",
  });
  assert.deepEqual(parsePackBracket("(Thùng 12,5 cái)"), {
    pack: "Thùng",
    count: 12.5,
    unit: "cái",
  });
  assert.equal(parsePackBracket("Bột mì 888 Cam"), null);
  assert.equal(parsePackBracket(null), null);
});
