import assert from "node:assert/strict";
import test from "node:test";

import {
  detectPointRevenueIssues,
  parsePointRevenueRows,
  summarizePointRevenue,
  type PointRevenueChannel,
} from "./point-revenue";

const channels: PointRevenueChannel[] = [
  {
    channel_code: "khach_le",
    channel_name: "Khách lẻ",
    quantity: 54,
    source_amount_vnd: 24,
    effective_amount_vnd: 240000,
    corrected: true,
  },
  {
    channel_code: "grabfood",
    channel_name: "GrabFood",
    quantity: 3,
    source_amount_vnd: 75000,
    effective_amount_vnd: 75000,
    corrected: false,
  },
];

test("summarizePointRevenue keeps source and accountant-effective totals separate", () => {
  assert.deepEqual(summarizePointRevenue(channels), {
    total_quantity: 57,
    source_total_vnd: 75024,
    effective_total_vnd: 315000,
    correction_delta_vnd: 239976,
    corrected_channel_count: 1,
  });
});

test("detectPointRevenueIssues flags implausibly tiny positive VND values without auto-scaling", () => {
  assert.deepEqual(detectPointRevenueIssues(channels), [
    {
      code: "amount_unit_suspect",
      channel_code: "khach_le",
      message: "Số tiền nguồn dưới 1.000 ₫ — cần kiểm tra đơn vị nhập.",
    },
  ]);
});

test("parsePointRevenueRows normalizes numeric RPC strings and preserves audit metadata", () => {
  const parsed = parsePointRevenueRows([
    {
      report_id: "report-1",
      report_date: "2026-08-07",
      location_id: "location-1",
      location_name: "230 Thống Nhất",
      staff_name: "Nguyễn An",
      submitted_at: "2026-08-07T23:00:00Z",
      review_status: "reviewed",
      reviewed_at: "2026-08-08T02:00:00Z",
      reviewed_by_name: "Kế toán BMQ",
      review_note: "Đã kiểm tra tiền mặt.",
      channels: [{
        channel_code: "khach_le",
        channel_name: "Khách lẻ",
        quantity: "54.000",
        source_amount_vnd: "24.00",
        effective_amount_vnd: "240000.00",
        corrected: true,
      }],
    },
  ]);

  assert.equal(parsed[0].channels[0].quantity, 54);
  assert.equal(parsed[0].channels[0].source_amount_vnd, 24);
  assert.equal(parsed[0].channels[0].effective_amount_vnd, 240000);
  assert.equal(parsed[0].review_status, "reviewed");
  assert.equal(parsed[0].reviewed_by_name, "Kế toán BMQ");
});
