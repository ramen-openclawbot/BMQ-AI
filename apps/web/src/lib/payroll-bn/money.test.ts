import assert from "node:assert/strict";
import test from "node:test";

import {
  addRational,
  compareRational,
  divRational,
  floorDiv,
  mulRational,
  rational,
  rationalFromNumber,
  roundHalfUpToStep,
  roundVndToThousand,
  subRational,
  sumRational,
} from "./money.ts";

test("rational reduces to the smallest denominator", () => {
  assert.deepEqual(rational(6, 8), { n: 3n, d: 4n });
  assert.deepEqual(rational(-6, 8), { n: -3n, d: 4n });
  assert.deepEqual(rational(6, -8), { n: -3n, d: 4n });
  assert.deepEqual(rational(0, 5), { n: 0n, d: 1n });
  assert.throws(() => rational(1, 0));
});

test("rationalFromNumber keeps decimal values exact", () => {
  assert.deepEqual(rationalFromNumber(1.5), { n: 3n, d: 2n });
  assert.deepEqual(rationalFromNumber(-0.25), { n: -1n, d: 4n });
  assert.deepEqual(rationalFromNumber(26), { n: 26n, d: 1n });
  assert.throws(() => rationalFromNumber(Number.NaN));
});

test("basic rational arithmetic is exact", () => {
  assert.deepEqual(addRational(rational(1, 3), rational(1, 6)), { n: 1n, d: 2n });
  assert.deepEqual(subRational(rational(3, 4), rational(1, 4)), { n: 1n, d: 2n });
  assert.deepEqual(mulRational(rational(2, 3), rational(3, 4)), { n: 1n, d: 2n });
  assert.deepEqual(divRational(rational(2, 3), rational(4, 9)), { n: 3n, d: 2n });
  assert.deepEqual(sumRational([rational(1, 2), rational(1, 3), rational(1, 6)]), { n: 1n, d: 1n });
  assert.equal(compareRational(rational(1, 3), rational(1, 2)), -1);
  assert.equal(compareRational(rational(4, 2), rational(2, 1)), 0);
  assert.throws(() => divRational(rational(1, 2), rational(0)));
});

test("floorDiv rounds toward negative infinity", () => {
  assert.equal(floorDiv(7n, 2n), 3n);
  assert.equal(floorDiv(-7n, 2n), -4n);
  assert.equal(floorDiv(7n, -2n), -4n);
  assert.equal(floorDiv(-8n, 2n), -4n);
});

test("roundHalfUpToStep rounds halves up", () => {
  assert.equal(roundHalfUpToStep(rational(1499), 1000n), 1000n);
  assert.equal(roundHalfUpToStep(rational(1500), 1000n), 2000n);
  assert.equal(roundHalfUpToStep(rational(2500), 1000n), 3000n);
  assert.equal(roundHalfUpToStep(rational(2499), 1000n), 2000n);
});

test("R5 rounds the final net pay to the nearest 1.000 đồng, half up", () => {
  assert.equal(roundVndToThousand(rational(0)), 0n);
  assert.equal(roundVndToThousand(rational(999)), 1000n);
  assert.equal(roundVndToThousand(rational(1499)), 1000n);
  assert.equal(roundVndToThousand(rational(1500)), 2000n);
  assert.equal(roundVndToThousand(rational(10_400_000)), 10_400_000n);
  assert.equal(roundVndToThousand(rational(33_333, 2)), 17_000n);
  assert.equal(roundVndToThousand(rationalFromNumber(1234.6)), 1000n);
});
