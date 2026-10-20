import { test } from "node:test";
import assert from "node:assert/strict";

import {
  addMonths,
  formatPct,
  formatVndMillions,
  monthEnd,
  monthStart,
  monthsBetween,
  toMonthKey,
} from "./format.ts";
import { buildPnlStatement, marginPct } from "./statement.ts";
import type { FinancePnl } from "./types.ts";

const PNL: FinancePnl = {
  from: "2026-08-01",
  to: "2026-09-30",
  currency: "VND",
  months: ["2026-08", "2026-09"],
  lines: [
    {
      section: "revenue",
      line_code: "BÁNH MÌ",
      label: "Revenue — BÁNH MÌ",
      amounts: { "2026-08": 80_000_000, "2026-09": 60_000_000 },
    },
    {
      section: "revenue",
      line_code: "BÁNH NGỘT",
      label: "Revenue — BÁNH NGỘT",
      amounts: { "2026-08": 50_000_000, "2026-09": 40_000_000 },
    },
    {
      section: "cogs",
      line_code: "A1_BREAD_BOUGHT",
      label: "Bread purchased (finished)",
      amounts: { "2026-08": 30_000_000, "2026-09": 40_000_000 },
    },
    {
      section: "selling",
      line_code: "B1_DELIVERY",
      label: "Delivery",
      amounts: { "2026-08": 8_000_000, "2026-09": 10_000_000 },
    },
    {
      section: "operating",
      line_code: "C6_PAYROLL",
      label: "Payroll",
      amounts: { "2026-08": 15_000_000, "2026-09": 20_000_000 },
    },
    {
      section: "unclassified",
      line_code: "UNMAPPED_REVIEW",
      label: "Unclassified — review required",
      amounts: { "2026-08": 3_000_000, "2026-09": 5_000_000 },
    },
    {
      section: "capex",
      line_code: "D1_CONSTRUCTION",
      label: "Construction & fit-out",
      amounts: { "2026-08": null, "2026-09": 7_000_000 },
    },
  ],
  totals: {
    "2026-08": {
      revenue: 130_000_000,
      cogs: 30_000_000,
      gross_profit: 100_000_000,
      gross_margin: 0.7692,
      selling: 8_000_000,
      operating: 15_000_000,
      unclassified: 3_000_000,
      ebitda: 74_000_000,
      ebitda_margin: 0.5692,
      capex: null,
    },
    "2026-09": {
      revenue: 100_000_000,
      cogs: 40_000_000,
      gross_profit: 60_000_000,
      gross_margin: 0.6,
      selling: 10_000_000,
      operating: 20_000_000,
      unclassified: 5_000_000,
      ebitda: 25_000_000,
      ebitda_margin: 0.25,
      capex: 7_000_000,
    },
  },
  by_product_line: {
    "2026-08": {
      bmq_bread: { revenue: 80_000_000, direct_costs: 30_000_000, contribution: 50_000_000 },
      sweet_kitchen: { revenue: 50_000_000, direct_costs: null, contribution: null },
      shared_costs: 26_000_000,
    },
    "2026-09": {
      bmq_bread: { revenue: 60_000_000, direct_costs: 40_000_000, contribution: 20_000_000 },
      sweet_kitchen: { revenue: 40_000_000, direct_costs: null, contribution: null },
      shared_costs: 35_000_000,
    },
  },
  coverage: {
    "2026-08": {
      expense_total: 56_000_000,
      classified_amount: 53_000_000,
      classified_pct: 0.9464,
      suggested_amount: 10_000_000,
      approved_amount: 40_000_000,
    },
    "2026-09": {
      expense_total: 82_000_000,
      classified_amount: 77_000_000,
      classified_pct: 0.939,
      suggested_amount: 20_000_000,
      approved_amount: 40_000_000,
    },
  },
  flags: [],
};

test("statement rows follow the fixed P&L order and carry subtotals", () => {
  const rows = buildPnlStatement(PNL);
  const keys = rows.map((row) => row.key);

  assert.deepEqual(keys, [
    "section:revenue",
    "line:revenue:BÁNH MÌ",
    "line:revenue:BÁNH NGỘT",
    "section:cogs",
    "line:cogs:A1_BREAD_BOUGHT",
    "subtotal:gross_profit",
    "section:selling",
    "line:selling:B1_DELIVERY",
    "section:operating",
    "line:operating:C6_PAYROLL",
    "section:unclassified",
    "line:unclassified:UNMAPPED_REVIEW",
    "subtotal:ebitda",
    "section:capex",
    "line:capex:D1_CONSTRUCTION",
  ]);

  const grossProfit = rows.find((row) => row.key === "subtotal:gross_profit");
  const ebitda = rows.find((row) => row.key === "subtotal:ebitda");
  assert.equal(grossProfit?.amounts["2026-09"], 60_000_000);
  assert.equal(ebitda?.amounts["2026-09"], 25_000_000);

  const revenueHeader = rows.find((row) => row.key === "section:revenue");
  assert.equal(revenueHeader?.amounts["2026-09"], 100_000_000);
  const capexHeader = rows.find((row) => row.key === "section:capex");
  assert.equal(capexHeader?.amounts["2026-09"], 7_000_000);
  assert.equal(capexHeader?.amounts["2026-08"], null);
});

test("margins are null when revenue is missing or zero", () => {
  assert.equal(marginPct(10_000_000, 0), null);
  assert.equal(marginPct(0, 0), null);
  assert.equal(marginPct(10_000_000, null), null);
  assert.equal(marginPct(null, 100_000_000), null);
  assert.equal(marginPct(10_000_000, 100_000_000), 0.1);
});

test("VND millions formatting keeps one decimal and handles negatives", () => {
  assert.equal(formatVndMillions(120_500_000), "120.5M");
  assert.equal(formatVndMillions(-120_500_000), "-120.5M");
  assert.equal(formatVndMillions(0), "0.0M");
  assert.equal(formatVndMillions(1_003_446_822), "1,003.4M");
  assert.equal(formatVndMillions(40_000), "0.04M");
  assert.equal(formatVndMillions(-1), "0.0M");
  assert.equal(formatVndMillions(null), null);
  assert.equal(formatPct(0.1234), "12.3%");
  assert.equal(formatPct(-0.005), "-0.5%");
  assert.equal(formatPct(null), null);
});

test("month helpers stay on calendar boundaries", () => {
  assert.equal(toMonthKey("2026-09-14"), "2026-09");
  assert.equal(toMonthKey(new Date(Date.UTC(2026, 8, 14))), "2026-09");
  assert.equal(monthStart("2026-09"), "2026-09-01");
  assert.equal(monthEnd("2026-09"), "2026-09-30");
  assert.equal(monthEnd("2028-02"), "2028-02-29");
  assert.equal(addMonths("2026-01", -1), "2025-12");
  assert.equal(addMonths("2026-12", 1), "2027-01");
  assert.deepEqual(monthsBetween("2025-11", "2026-02"), ["2025-11", "2025-12", "2026-01", "2026-02"]);
  assert.deepEqual(monthsBetween("2026-02", "2026-01"), []);
  assert.throws(() => monthStart("2026-13"));
  assert.throws(() => monthEnd("2026-9"));
});

test("labels: channels in English, tone by good direction, honest drivers, round axis", async () => {
  const { channelLabel, deltaTone, driverText, niceScale, closeProgress } = await import("./labels.ts");
  assert.equal(channelLabel("ĐẠI LÝ"), "Dealers");
  assert.equal(deltaTone("revenue", "REVENUE_TOTAL", -5), "bad");
  assert.equal(deltaTone("operating", "C2_ELECTRICITY", -5), "good");
  assert.equal(deltaTone("summary", "EBITDA", 5), "good");
  assert.equal(deltaTone("cogs", "COGS_TOTAL", 0), "neutral");
  const base = { level: "leaf" as const, section: "operating" as const, line_code: "C6_PAYROLL_PAYOUTS", label: "Payroll", budget: null, budget_status: "not_set" as const, drivers: [], delta_pct: null };
  assert.match(driverText({ ...base, current: 1, prior: null, delta: null, flagged: true, flag_reason: "always", driver_text: "Driver unclear — flag for controller." }) ?? "", /New this month/);
  assert.equal(driverText({ ...base, current: 1, prior: 1, delta: 0, flagged: false, flag_reason: "below_materiality", driver_text: null }), null);
  assert.deepEqual(niceScale(890), { top: 1000, ticks: [0, 250, 500, 750, 1000] });
  assert.deepEqual(closeProgress([
    { code: "a", title_en: "", status: "pass", value: null, detail_en: "" },
    { code: "b", title_en: "", status: "warn", value: null, detail_en: "" },
    { code: "c", title_en: "", status: "info", value: null, detail_en: "" },
  ]), { pass: 1, total: 2, attention: 1 });
});
