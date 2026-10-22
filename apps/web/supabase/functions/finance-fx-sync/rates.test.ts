import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SYNC_DAYS,
  MAX_SYNC_DAYS,
  addDays,
  buildDateRange,
  isDateKey,
  parseUsdTransferRate,
  resolveSyncWindow,
  vietnamDateKey,
} from "./rates.ts";

const PAYLOAD = {
  Data: [
    { currencyCode: "AUD", transfer: "17000.00" },
    { currencyCode: "USD", transfer: "26137.00" },
    { currencyCode: "EUR", transfer: "28000.00" },
  ],
};

test("parses the USD transfer rate from the Vietcombank payload", () => {
  assert.equal(parseUsdTransferRate(PAYLOAD), 26137);
});

test("parses transfer rates containing thousands separators", () => {
  assert.equal(parseUsdTransferRate({ Data: [{ currencyCode: "USD", transfer: "26,137.50" }] }), 26137.5);
});

test("returns null when the payload has no USD row", () => {
  assert.equal(parseUsdTransferRate({ Data: [{ currencyCode: "EUR", transfer: "28000.00" }] }), null);
  assert.equal(parseUsdTransferRate({ Data: [] }), null);
  assert.equal(parseUsdTransferRate(null), null);
  assert.equal(parseUsdTransferRate({}), null);
});

test("rejects non-finite and out-of-range USD rates", () => {
  assert.equal(parseUsdTransferRate({ Data: [{ currencyCode: "USD", transfer: "not-a-number" }] }), null);
  assert.equal(parseUsdTransferRate({ Data: [{ currencyCode: "USD", transfer: "14999.99" }] }), null);
  assert.equal(parseUsdTransferRate({ Data: [{ currencyCode: "USD", transfer: "40000.01" }] }), null);
  assert.equal(parseUsdTransferRate({ Data: [{ currencyCode: "USD", transfer: "Infinity" }] }), null);
  assert.equal(parseUsdTransferRate({ Data: [{ currencyCode: "USD", transfer: "15000" }] }), 15000);
  assert.equal(parseUsdTransferRate({ Data: [{ currencyCode: "USD", transfer: "40000" }] }), 40000);
});

test("uses the Vietnam calendar date at the UTC day boundary", () => {
  assert.equal(vietnamDateKey(new Date("2026-10-22T16:59:59.000Z")), "2026-10-22");
  assert.equal(vietnamDateKey(new Date("2026-10-22T17:00:00.000Z")), "2026-10-23");
});

test("default window is today plus the previous 7 Vietnam dates", () => {
  const window = resolveSyncWindow({}, new Date("2026-10-22T17:30:00.000Z"));
  assert.equal(window.ok, true);
  if (!window.ok) return;
  assert.equal(window.dates.length, DEFAULT_SYNC_DAYS);
  assert.equal(window.dates[0], "2026-10-16");
  assert.equal(window.dates[window.dates.length - 1], "2026-10-23");
});

test("explicit from/to backfill resolves an inclusive range", () => {
  const window = resolveSyncWindow(
    { from: "2026-08-01", to: "2026-08-03" },
    new Date("2026-10-22T00:00:00.000Z"),
  );
  assert.deepEqual(window, { ok: true, dates: ["2026-08-01", "2026-08-02", "2026-08-03"] });
});

test("backfill is capped at 400 days per call", () => {
  const window = resolveSyncWindow({ from: "2025-01-01", to: "2026-03-01" });
  assert.deepEqual(window, { ok: false, error: "range_too_large" });

  const exactlyMax = resolveSyncWindow({ from: "2025-01-01", to: addDays("2025-01-01", MAX_SYNC_DAYS - 1) });
  assert.equal(exactlyMax.ok, true);
  if (exactlyMax.ok) assert.equal(exactlyMax.dates.length, MAX_SYNC_DAYS);
});

test("invalid or reversed windows are rejected", () => {
  assert.deepEqual(resolveSyncWindow({ from: "2026-08-01" }), { ok: false, error: "from_and_to_required" });
  assert.deepEqual(resolveSyncWindow({ from: "2026-13-01", to: "2026-08-01" }), { ok: false, error: "invalid_date" });
  assert.deepEqual(resolveSyncWindow({ from: "2026-08-03", to: "2026-08-01" }), { ok: false, error: "invalid_range" });
});

test("date helpers reject malformed keys", () => {
  assert.equal(isDateKey("2026-02-29"), false);
  assert.equal(isDateKey("2026-2-09"), false);
  assert.equal(isDateKey("2026-02-28"), true);
  assert.equal(addDays("2026-02-28", 1), "2026-03-01");
  assert.deepEqual(buildDateRange("2026-08-03", "2026-08-01"), []);
});
