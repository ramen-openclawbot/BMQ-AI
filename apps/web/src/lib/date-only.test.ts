import assert from "node:assert/strict";
import test from "node:test";
import { parseDbDate } from "./date-only";

test("a date-only value stays on its calendar day in the local time zone", () => {
  const d = parseDbDate("2026-10-06");
  assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()], [2026, 9, 6, 0]);
});

test("timestamps parse as instants", () => {
  assert.equal(parseDbDate("2026-10-06T07:23:38Z").toISOString(), "2026-10-06T07:23:38.000Z");
});

test("junk gives an invalid date", () => {
  assert.ok(Number.isNaN(parseDbDate("abc").getTime()));
});
