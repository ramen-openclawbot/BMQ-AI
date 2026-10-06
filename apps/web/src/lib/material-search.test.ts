import assert from "node:assert/strict";
import test from "node:test";

import { materialMatchesSearch } from "./material-search.ts";

test("matches code or name, ignoring case and diacritics", () => {
  assert.equal(materialMatchesSearch("NVL-BANH-MI-TUOI Bánh mì tươi", "banh mi"), true);
  assert.equal(materialMatchesSearch("NVL-BANH-MI-TUOI Bánh mì tươi", "BÁNH MÌ"), true);
  assert.equal(materialMatchesSearch("NVL-BANH-MI-TUOI Bánh mì tươi", "tuoi"), true);
  assert.equal(materialMatchesSearch("NVL-MUOI Muối", "muoi"), true);
  assert.equal(materialMatchesSearch("NVL-DUONG Đường cát", "duong cat"), true);
});

test("every typed word must match, in any order", () => {
  assert.equal(materialMatchesSearch("NVL-PHAN-TICH-MAU-PATE Phân tích mẫu pate", "pate mau"), true);
  assert.equal(materialMatchesSearch("NVL-MUOI Muối", "muoi duong"), false);
  assert.equal(materialMatchesSearch("NVL-MUOI Muối", "xyz"), false);
});

test("empty search shows everything", () => {
  assert.equal(materialMatchesSearch("NVL-MUOI Muối", ""), true);
  assert.equal(materialMatchesSearch("NVL-MUOI Muối", "   "), true);
});
