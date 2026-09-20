import assert from "node:assert/strict";
import test from "node:test";

import { normalizeMaterialName } from "./material-name.ts";

test("fold mirrors the server material_master_normalize for display grouping", () => {
  assert.equal(normalizeMaterialName("BỘ PEERLESS"), "bo peerless");
  assert.equal(normalizeMaterialName("Bơ"), "bo");
  assert.equal(normalizeMaterialName("Đậu phộng rang (500g)"), "dau phong rang 500g");
  assert.equal(normalizeMaterialName("  Bột   mì 888  "), "bot mi 888");
  assert.equal(normalizeMaterialName(null), "");
  assert.equal(normalizeMaterialName(undefined), "");
});

test("diacritic variants collapse but distinct tokens do not", () => {
  assert.equal(normalizeMaterialName("BƠ PEERLESS"), normalizeMaterialName("BỘ PEERLESS"));
  assert.notEqual(normalizeMaterialName("BỘ PEERLESS"), normalizeMaterialName("bơ"));
});
