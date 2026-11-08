import assert from "node:assert/strict";
import test from "node:test";

import {
  computeTargetSize,
  SELFIE_MAX_SIDE,
  SELFIE_QUALITY_STEPS,
  SELFIE_TARGET_BYTES,
} from "./selfie-compress.ts";

test("landscape images are capped to a 1280 longest side", () => {
  assert.deepEqual(computeTargetSize(2560, 1440), { width: 1280, height: 720 });
  assert.deepEqual(computeTargetSize(1920, 1080), { width: 1280, height: 720 });
});

test("portrait images are capped to a 1280 longest side", () => {
  assert.deepEqual(computeTargetSize(1440, 2560), { width: 720, height: 1280 });
  assert.deepEqual(computeTargetSize(1080, 1920), { width: 720, height: 1280 });
});

test("small images keep their size and square images stay square", () => {
  assert.deepEqual(computeTargetSize(800, 600), { width: 800, height: 600 });
  assert.deepEqual(computeTargetSize(4000, 4000), { width: 1280, height: 1280 });
  assert.deepEqual(computeTargetSize(640, 640), { width: 640, height: 640 });
});

test("invalid dimensions fail closed to zero", () => {
  assert.deepEqual(computeTargetSize(0, 100), { width: 0, height: 0 });
  assert.deepEqual(computeTargetSize(Number.NaN, 100), { width: 0, height: 0 });
  assert.deepEqual(computeTargetSize(-10, 100), { width: 0, height: 0 });
});

test("compression contract uses 1280px, 300KB and 0.8→0.5 quality steps", () => {
  assert.equal(SELFIE_MAX_SIDE, 1280);
  assert.equal(SELFIE_TARGET_BYTES, 300 * 1024);
  assert.deepEqual([...SELFIE_QUALITY_STEPS], [0.8, 0.7, 0.6, 0.5]);
});
