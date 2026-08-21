import assert from "node:assert/strict";
import test from "node:test";

import {
  createPointReportEditDraft,
  detectPointRevenueIssues,
  getBreadClosingQuantity,
  parsePointReportDetail,
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
      report_notes: "Ca tối hết tương ớt lúc 21h.",
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
  assert.equal(parsed[0].report_notes, "Ca tối hết tương ớt lúc 21h.");
});

test("parsePointRevenueRows normalizes missing or whitespace-only shift notes to an empty string", () => {
  const [missing] = parsePointRevenueRows([{ report_id: "report-2", channels: [] }]);
  const [whitespace] = parsePointRevenueRows([{
    report_id: "report-3",
    report_notes: "   \n  ",
    channels: [],
  }]);

  assert.equal(missing.report_notes, "");
  assert.equal(whitespace.report_notes, "");
});

test("parsePointReportDetail normalizes full inventory and channel correction payloads", () => {
  const parsed = parsePointReportDetail({
    report_id: "report-1",
    report_date: "2026-08-08",
    report_notes: "Cuối ca",
    status: "submitted",
    inventory_rows: [{
      product_code: "banh_mi_que",
      product_name: "Bánh mì que",
      opening_quantity: "10.000",
      received_quantity: "5.000",
      sold_quantity: "3.000",
      closing_quantity: "12.000",
      consumption_is_manual: false,
      breadstick_consumption_ratio: "0.000",
    }],
    channel_rows: [{
      channel_code: "khach_le",
      channel_name: "Khách lẻ",
      quantity: "3.000",
      amount_vnd: "36000.00",
      source_amount_vnd: "96.00",
    }],
  });

  assert.equal(parsed.inventory_rows[0].opening_quantity, 10);
  assert.equal(parsed.inventory_rows[0].closing_quantity, 12);
  assert.equal(parsed.inventory_rows[0].consumption_is_manual, false);
  assert.equal(parsed.channel_rows[0].quantity, 3);
  assert.equal(parsed.channel_rows[0].amount_vnd, 36000);
  assert.equal(parsed.channel_rows[0].source_amount_vnd, 96);
  assert.equal(getBreadClosingQuantity(parsed), 12);
});

test("getBreadClosingQuantity returns null when a report has no bread inventory row", () => {
  const parsed = parsePointReportDetail({
    report_id: "report-no-bread",
    inventory_rows: [{ product_code: "pate", closing_quantity: "2.5" }],
    channel_rows: [],
  });

  assert.equal(getBreadClosingQuantity(parsed), null);
});

test("getBreadClosingQuantity rejects incomplete or invalid bread closing values", () => {
  for (const closingQuantity of [null, "", "không hợp lệ"]) {
    const parsed = parsePointReportDetail({
      report_id: "report-incomplete-bread",
      inventory_rows: [{ product_code: "banh_mi_que", closing_quantity: closingQuantity }],
      channel_rows: [],
    });

    assert.equal(getBreadClosingQuantity(parsed), null);
  }
});

test("createPointReportEditDraft restores persisted values and recalculates derived inventory", () => {
  const detail = parsePointReportDetail({
    report_id: "report-draft",
    report_notes: "Ghi chú nguồn",
    inventory_rows: [
      {
        product_code: "banh_mi_que",
        opening_quantity: 100,
        received_quantity: 50,
        sold_quantity: 1,
        closing_quantity: 149,
      },
      {
        product_code: "pate",
        opening_quantity: 10,
        received_quantity: 2,
        consumed_quantity: 0,
        closing_quantity: 12,
        breadstick_consumption_ratio: 0.05,
      },
    ],
    channel_rows: [
      { channel_code: "khach_le", quantity: 30, amount_vnd: 1, notes: "Tiền mặt" },
      { channel_code: "grabfood", quantity: 10, amount_vnd: 400000, notes: "Đối soát" },
    ],
  });

  const draft = createPointReportEditDraft(detail, 12000);

  assert.equal(draft.amounts.khach_le, 360000);
  assert.equal(draft.amounts.grabfood, 400000);
  assert.equal(draft.quantities.grabfood, 10);
  assert.equal(draft.channelNotes.khach_le, "Tiền mặt");
  assert.equal(draft.inventoryRows[0].sold_quantity, 40);
  assert.equal(draft.inventoryRows[0].closing_quantity, 110);
  assert.equal(draft.inventoryRows[1].consumed_quantity, 2);
  assert.equal(draft.inventoryRows[1].closing_quantity, 10);
  assert.equal(draft.reportNotes, "Ghi chú nguồn");
});
