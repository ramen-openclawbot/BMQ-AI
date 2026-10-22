import { test } from "node:test";
import assert from "node:assert/strict";

import { formatUsd, formatUsdRate, parseFxMonthly, rateByMonth, signedUsd, vndToUsd } from "./fx.ts";

test("vndToUsd converts VND at the monthly rate", () => {
  assert.equal(vndToUsd(25_650_000, 25_650), 1000);
  assert.equal(vndToUsd(0, 25_650), 0);
});

test("vndToUsd rounds USD to cents", () => {
  assert.equal(vndToUsd(1_000_000, 26_137), 38.26);
  assert.equal(vndToUsd(-1_000, 25_000), -0.04);
});

test("vndToUsd is null-safe without a usable rate", () => {
  assert.equal(vndToUsd(1_000_000, null), null);
  assert.equal(vndToUsd(1_000_000, undefined), null);
  assert.equal(vndToUsd(1_000_000, 0), null);
  assert.equal(vndToUsd(1_000_000, -25_650), null);
  assert.equal(vndToUsd(1_000_000, Number.NaN), null);
  assert.equal(vndToUsd(null, 25_650), null);
  assert.equal(vndToUsd(Number.NaN, 25_650), null);
});

test("formatUsd uses compact K/M thresholds", () => {
  assert.equal(formatUsd(812), "$812");
  assert.equal(formatUsd(812.6), "$813");
  assert.equal(formatUsd(31_200), "$31.2K");
  assert.equal(formatUsd(1_240_000), "$1.24M");
  assert.equal(formatUsd(1_000), "$1.0K");
  assert.equal(formatUsd(1_000_000), "$1.00M");
});

test("formatUsd keeps negatives compact and sign-first", () => {
  assert.equal(formatUsd(-812), "-$812");
  assert.equal(formatUsd(-31_200), "-$31.2K");
  assert.equal(formatUsd(-1_240_000), "-$1.24M");
  assert.equal(formatUsd(-0.4), "$0");
});

test("formatUsd renders zero and returns null without an amount", () => {
  assert.equal(formatUsd(0), "$0");
  assert.equal(formatUsd(null), null);
  assert.equal(formatUsd(undefined), null);
  assert.equal(formatUsd(Number.NaN), null);
  assert.equal(formatUsd(Number.POSITIVE_INFINITY), null);
});

test("signedUsd signs movements and leaves zero bare", () => {
  assert.equal(signedUsd(7_950), "+$8.0K");
  assert.equal(signedUsd(-1_900), "−$1.9K");
  assert.equal(signedUsd(0), "$0");
  assert.equal(signedUsd(null), "—");
});

test("rateByMonth fills a month without a rate from the nearest earlier month", () => {
  const rates = rateByMonth([
    { month: "2026-10", vndPerUsd: null, days: 0, source: null },
    { month: "2026-09", vndPerUsd: 26_300, days: 30, source: "vietcombank_transfer" },
    { month: "2026-08", vndPerUsd: null, days: 0, source: null },
    { month: "2026-07", vndPerUsd: 26_100, days: 31, source: "vietcombank_transfer" },
  ]);
  assert.deepEqual(rates, { "2026-07": 26_100, "2026-08": 26_100, "2026-09": 26_300, "2026-10": 26_300 });
  assert.deepEqual(rateByMonth([{ month: "2026-01", vndPerUsd: null, days: 0, source: null }, { month: "2026-02", vndPerUsd: 25_900, days: 1, source: null }]), { "2026-01": 25_900, "2026-02": 25_900 });
});

test("formatUsdRate renders a readable VND rate", () => {
  assert.equal(formatUsdRate(25_650), "1 USD = 25,650 VND");
  assert.equal(formatUsdRate(25_650.4), "1 USD = 25,650 VND");
  assert.equal(formatUsdRate(25_650.6), "1 USD = 25,651 VND");
  assert.equal(formatUsdRate(null), "1 USD = — VND");
  assert.equal(formatUsdRate(0), "1 USD = — VND");
});

test("parseFxMonthly converts snake_case RPC rows to camelCase", () => {
  const parsed = parseFxMonthly([
    {
      month: "2026-08",
      vnd_per_usd: 26_137.5,
      days: 21,
      first_date: "2026-08-01",
      last_date: "2026-08-31",
      source: "vietcombank_transfer",
    },
    {
      month: "2026-09",
      vnd_per_usd: null,
      days: 0,
      first_date: null,
      last_date: null,
      source: null,
    },
  ]);

  assert.deepEqual(parsed, [
    { month: "2026-08", vndPerUsd: 26_137.5, days: 21, source: "vietcombank_transfer" },
    { month: "2026-09", vndPerUsd: null, days: 0, source: null },
  ]);
});

test("parseFxMonthly tolerates numeric strings and skips invalid rows", () => {
  const parsed = parseFxMonthly([
    { month: "2026-08", vnd_per_usd: "26137.5", days: "10", source: "" },
    { month: "bad", vnd_per_usd: 26000, days: 1, source: "vietcombank_transfer" },
    null,
    "nope",
  ]);

  assert.deepEqual(parsed, [{ month: "2026-08", vndPerUsd: 26_137.5, days: 10, source: null }]);
});

test("parseFxMonthly rejects non-array payloads and non-positive rates", () => {
  assert.deepEqual(parseFxMonthly(null), []);
  assert.deepEqual(parseFxMonthly({}), []);
  assert.deepEqual(
    parseFxMonthly([{ month: "2026-08", vnd_per_usd: 0, days: 1, source: "vietcombank_transfer" }]),
    [{ month: "2026-08", vndPerUsd: null, days: 1, source: "vietcombank_transfer" }],
  );
});
