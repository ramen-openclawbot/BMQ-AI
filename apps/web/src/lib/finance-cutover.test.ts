import assert from "node:assert/strict";
import test from "node:test";
import {
  batchDatesByLimit,
  computeRunningQtmBalance,
  CUTOVER_ERROR_MESSAGES,
  listBacklogMonths,
  mapCutoverError,
} from "./finance-cutover.ts";

test("backlog months cover each calendar month touched by the range", () => {
  assert.deepEqual(
    listBacklogMonths("2026-06-03", "2026-09-30"),
    ["2026-06-01", "2026-07-01", "2026-08-01", "2026-09-01"],
  );
});

test("backlog months include partial first and last months", () => {
  assert.deepEqual(
    listBacklogMonths("2026-06-30", "2026-08-01"),
    ["2026-06-01", "2026-07-01", "2026-08-01"],
  );
});

test("backlog months handle a single month and reversed ranges", () => {
  assert.deepEqual(listBacklogMonths("2026-07-01", "2026-07-31"), [
    "2026-07-01",
  ]);
  assert.deepEqual(listBacklogMonths("2026-09-01", "2026-06-01"), []);
});

test("backlog months reject malformed dates", () => {
  assert.throws(() => listBacklogMonths("2026/06/03", "2026-09-30"));
});

test("dates are batched by ten preserving order", () => {
  const dates = Array.from(
    { length: 23 },
    (_, index) => `2026-06-${String(index + 1).padStart(2, "0")}`,
  );
  const batches = batchDatesByLimit(dates);
  assert.deepEqual(batches.map((batch) => batch.length), [10, 10, 3]);
  assert.equal(batches[0][0], "2026-06-01");
  assert.equal(batches[2][2], "2026-06-23");
  assert.deepEqual(batchDatesByLimit([]), []);
});

test("batching accepts an explicit smaller limit and rejects invalid limits", () => {
  assert.deepEqual(batchDatesByLimit(["a", "b", "c"], 2), [["a", "b"], ["c"]]);
  assert.throws(() => batchDatesByLimit(["a"], 0));
  assert.throws(() => batchDatesByLimit(["a"], 1.5));
});

test("running QTM balance chains opening to the previous closing", () => {
  const balances = computeRunningQtmBalance(0, [
    { closingDate: "2026-06-01", qtmTopup: 100, qtmSpent: 20 },
    { closingDate: "2026-06-02", qtmTopup: 0, qtmSpent: 30 },
  ]);
  assert.deepEqual(balances, [
    {
      closingDate: "2026-06-01",
      opening: 0,
      qtmTopup: 100,
      qtmSpent: 20,
      closing: 80,
      counted: false,
    },
    {
      closingDate: "2026-06-02",
      opening: 80,
      qtmTopup: 0,
      qtmSpent: 30,
      closing: 50,
      counted: false,
    },
  ]);
});

test("counted closing overrides only the last day", () => {
  const balances = computeRunningQtmBalance(
    10,
    [
      { closingDate: "2026-06-01", qtmTopup: 5, qtmSpent: 0 },
      { closingDate: "2026-06-02", qtmTopup: 5, qtmSpent: 0 },
    ],
    25,
  );
  assert.equal(balances[0].closing, 15);
  assert.equal(balances[0].counted, false);
  assert.equal(balances[1].closing, 25);
  assert.equal(balances[1].counted, true);
});

test("unscanned days spend zero and a counted zero is honoured", () => {
  const balances = computeRunningQtmBalance(0, [
    { closingDate: "2026-06-01", qtmTopup: 40, qtmSpent: 0 },
    { closingDate: "2026-06-02", qtmTopup: 0, qtmSpent: 0 },
  ], 0);
  assert.equal(balances[0].closing, 40);
  assert.equal(balances[1].closing, 0);
  assert.equal(balances[1].counted, true);
});

test("empty day lists produce no balances", () => {
  assert.deepEqual(computeRunningQtmBalance(50, [], 10), []);
});

test("every cutover RPC error code maps to a Vietnamese message", () => {
  for (const code of Object.keys(CUTOVER_ERROR_MESSAGES)) {
    const message = mapCutoverError(new Error(`RPC failed: ${code}`));
    assert.equal(message, CUTOVER_ERROR_MESSAGES[code]);
    assert.notEqual(message, mapCutoverError(new Error("unknown")));
  }
});

test("unknown errors fall back to a generic message", () => {
  assert.equal(
    mapCutoverError("some network problem"),
    "Không xử lý được chốt mốc tháng. Vui lòng thử lại.",
  );
});
