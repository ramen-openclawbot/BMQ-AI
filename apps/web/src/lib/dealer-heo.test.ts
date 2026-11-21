import assert from "node:assert/strict";
import test from "node:test";

import {
  formatHeoVnd,
  previewOrderExtra,
} from "./dealer-heo.ts";

test("formatHeoVnd groups Vietnamese thousands and appends the dong sign", () => {
  assert.equal(formatHeoVnd(0), "0đ");
  assert.equal(formatHeoVnd(5000), "5.000đ");
  assert.equal(formatHeoVnd("1234567"), "1.234.567đ");
  assert.equal(formatHeoVnd(-5000), "-5.000đ");
  assert.equal(formatHeoVnd(Number.NaN), "0đ");
});

test("previewOrderExtra only prices the part crossing the baseline", () => {
  assert.deepEqual(
    previewOrderExtra({
      baselineAvgPerDay: 4,
      existingDayQuantity: 3,
      orderQuantity: 2,
      ratePerExtraQue: 500,
    }),
    { extra_que: 1, extra_vnd: 500, spin_eligible: false },
  );

  assert.deepEqual(
    previewOrderExtra({
      baselineAvgPerDay: 4,
      existingDayQuantity: 6,
      orderQuantity: 3,
      ratePerExtraQue: 500,
    }),
    { extra_que: 3, extra_vnd: 1500, spin_eligible: false },
  );
});

test("previewOrderExtra treats a missing or zero baseline as one required que", () => {
  assert.deepEqual(
    previewOrderExtra({
      baselineAvgPerDay: 0,
      existingDayQuantity: 5,
      orderQuantity: 1,
      ratePerExtraQue: 500,
    }),
    { extra_que: 1, extra_vnd: 500, spin_eligible: true },
  );

  assert.deepEqual(
    previewOrderExtra({
      baselineAvgPerDay: 0,
      existingDayQuantity: 0,
      orderQuantity: 0,
      ratePerExtraQue: 500,
    }),
    { extra_que: 0, extra_vnd: 0, spin_eligible: false },
  );

  assert.equal(
    previewOrderExtra({
      baselineAvgPerDay: 2,
      existingDayQuantity: 0,
      orderQuantity: 2,
      ratePerExtraQue: 500,
    }).spin_eligible,
    true,
  );
});

test("previewOrderExtra never returns a negative extra for a day below baseline", () => {
  assert.deepEqual(
    previewOrderExtra({
      baselineAvgPerDay: 10,
      existingDayQuantity: 2,
      orderQuantity: 3,
      ratePerExtraQue: 500,
    }),
    { extra_que: 0, extra_vnd: 0, spin_eligible: false },
  );
});
