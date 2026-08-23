import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildKioskPointRevenuePreviewLines,
  kioskPointRevenueEvidenceFingerprint,
  kioskPointUnitPriceVnd,
  kioskReportedDates,
} from "./kiosk-point-revenue.ts";

assert.equal(kioskPointUnitPriceVnd("2026-08-14"), 12_000);
assert.equal(kioskPointUnitPriceVnd("2026-08-15"), 14_000);

const lines = buildKioskPointRevenuePreviewLines(
  "run-1",
  "2026-08",
  "2026-08-01",
  "2026-08-31",
  [
    {
      id: "report-before",
      report_date: "2026-08-14",
      location_id: "location-1",
      location_name_snapshot: "Bùi Viện",
      kiosk_daily_report_channel_rows: [
        { id: "retail", channel_code: "khach_le", quantity: 2, amount_vnd: 1 },
        { id: "shopee", channel_code: "shopeefood", quantity: 3, amount_vnd: 999_999 },
      ],
    },
    {
      id: "report-after",
      report_date: "2026-08-15",
      location_id: "location-2",
      location_name_snapshot: "Bến Vân Đồn",
      kiosk_daily_report_channel_rows: [
        { id: "grab", channel_code: "grabfood", quantity: 4, amount_vnd: 10 },
        { id: "be", channel_code: "befood", quantity: 5, amount_vnd: 20 },
        { id: "ignored", channel_code: "other", quantity: 99, amount_vnd: 99 },
      ],
    },
  ],
);

assert.deepEqual(
  lines.map((line) => [line.raw_payload.channel_code, line.unit_price, line.gross_revenue]),
  [
    ["khach_le", 12_000, 24_000],
    ["shopeefood", 12_000, 36_000],
    ["grabfood", 14_000, 56_000],
    ["befood", 14_000, 70_000],
  ],
);
assert.ok(lines.every((line) => line.po_received_date === null));
assert.deepEqual(
  Array.from(kioskReportedDates([
    { id: "r1", report_date: "2026-08-14", location_id: "l1", location_name_snapshot: "A" },
    { id: "r2", report_date: "2026-08-15", location_id: "l2", location_name_snapshot: "B" },
  ])).sort(),
  ["2026-08-14", "2026-08-15"],
);
assert.equal(
  kioskPointRevenueEvidenceFingerprint(lines),
  kioskPointRevenueEvidenceFingerprint([...lines].reverse()),
);
assert.notEqual(
  kioskPointRevenueEvidenceFingerprint(lines),
  kioskPointRevenueEvidenceFingerprint([
    ...lines.slice(0, -1),
    { ...lines.at(-1)!, quantity: 6, gross_revenue: 84_000 },
  ]),
);

const indexSource = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
assert.match(indexSource, /line\.channel === "Retail Kiosk" && replacedRetailKioskDates\.has\(line\.revenue_date\)/);
assert.match(indexSource, /\.eq\("status", "submitted"\)/);
assert.match(indexSource, /\.\.\.emailLinesAfterKioskReplacement, \.\.\.dealerPortalLines, \.\.\.kioskPointLines/);
assert.match(indexSource, /recoveryReason: "kiosk_point_evidence_changed"/);

console.log("PASS kiosk point revenue ledger integration");
