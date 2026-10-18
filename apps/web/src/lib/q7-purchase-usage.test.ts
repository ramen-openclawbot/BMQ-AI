// Offline tests for the Q7 purchase-vs-usage report helpers (node:test, no DB).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  factorSourceLabel,
  formatStockQty,
  monthLabel,
  parseQ7PurchaseUsageItemDetail,
  parseQ7PurchaseUsageReport,
  purchaseUsageGapText,
  purchaseUsageStatusLabel,
  Q7_PURCHASE_USAGE_STATUS_LABELS,
  type Q7PurchaseUsageItem,
} from "./q7-purchase-usage.ts";

const ZERO_CELL = {
  used_qty: 0,
  bought_qty: 0,
  unknown_lines: 0,
  purchase_lines: 0,
};

function item(
  overrides: Partial<Q7PurchaseUsageItem> = {},
): Q7PurchaseUsageItem {
  return {
    kitchen_inventory_item_id: "item-1",
    name: "Bột mì",
    unit: "g",
    status: "ok",
    ratio: 1,
    total: ZERO_CELL,
    months: {},
    ...overrides,
  };
}

const REPORT_FIXTURE = {
  from: "2026-08-01",
  to: "2026-10-19",
  months: ["2026-08", "2026-09", "2026-10"],
  generated_at: "2026-10-19T03:00:00+00:00",
  items: [
    {
      kitchen_inventory_item_id: "item-1",
      name: "Bột mì 888",
      unit: "g",
      status: "big_gap",
      ratio: "2.3",
      total: {
        used_qty: "1000.5",
        bought_qty: 2300,
        unknown_lines: 0,
        purchase_lines: 2,
      },
      months: {
        "2026-08": {
          used_qty: 400,
          bought_qty: 1000,
          unknown_lines: 0,
          purchase_lines: 1,
        },
        "2026-09": {
          used_qty: 600.5,
          bought_qty: 1300,
          unknown_lines: 0,
          purchase_lines: 1,
        },
        "2026-10": {
          used_qty: 0,
          bought_qty: 0,
          unknown_lines: 0,
          purchase_lines: 0,
        },
      },
    },
    {
      kitchen_inventory_item_id: "item-2",
      name: "Trứng gà",
      unit: "cái",
      status: "needs_conversion",
      ratio: null,
      total: {
        used_qty: 12,
        bought_qty: 0,
        unknown_lines: 1,
        purchase_lines: 1,
      },
      months: {},
    },
  ],
  q7_extra_purchases: [
    {
      kitchen_inventory_item_id: "item-3",
      name: "Peerless",
      unit: "kg",
      bought_qty: "25.5",
      unknown_lines: 0,
      purchase_lines: 1,
      status: "not_in_recipe",
    },
  ],
};

test("parses a full report fixture and coerces numbers", () => {
  const report = parseQ7PurchaseUsageReport(REPORT_FIXTURE);

  assert.equal(report.from, "2026-08-01");
  assert.equal(report.to, "2026-10-19");
  assert.deepEqual(report.months, ["2026-08", "2026-09", "2026-10"]);
  assert.equal(report.items.length, 2);

  const first = report.items[0];
  assert.equal(first.status, "big_gap");
  assert.equal(first.ratio, 2.3);
  assert.equal(first.total.used_qty, 1000.5);
  assert.equal(first.total.bought_qty, 2300);
  assert.deepEqual(Object.keys(first.months), ["2026-08", "2026-09", "2026-10"]);
  assert.equal(first.months["2026-09"].used_qty, 600.5);

  const second = report.items[1];
  assert.equal(second.status, "needs_conversion");
  assert.equal(second.ratio, null);
  assert.deepEqual(second.months, {});

  const extra = report.q7_extra_purchases[0];
  assert.equal(extra.status, "not_in_recipe");
  assert.equal(extra.bought_qty, 25.5);
});

test("parses malformed report input without throwing", () => {
  assert.doesNotThrow(() => parseQ7PurchaseUsageReport(null));
  assert.doesNotThrow(() => parseQ7PurchaseUsageReport("not json"));
  assert.doesNotThrow(() => parseQ7PurchaseUsageReport([]));

  const parsed = parseQ7PurchaseUsageReport({
    from: 1,
    to: null,
    months: [1, "2026-09", null],
    generated_at: 5,
    items: "nope",
    q7_extra_purchases: null,
  });
  assert.equal(parsed.from, "");
  assert.equal(parsed.to, "");
  assert.deepEqual(parsed.months, ["2026-09"]);
  assert.deepEqual(parsed.items, []);
  assert.deepEqual(parsed.q7_extra_purchases, []);

  const wrongTypes = parseQ7PurchaseUsageReport({
    items: [
      {
        kitchen_inventory_item_id: 5,
        name: null,
        unit: 7,
        status: "something_else",
        ratio: "not a number",
        total: "not an object",
        months: 42,
      },
    ],
  });
  assert.equal(wrongTypes.items[0].kitchen_inventory_item_id, "");
  assert.equal(wrongTypes.items[0].name, "");
  assert.equal(wrongTypes.items[0].unit, "");
  assert.equal(wrongTypes.items[0].status, "ok");
  assert.equal(wrongTypes.items[0].ratio, null);
  assert.deepEqual(wrongTypes.items[0].total, ZERO_CELL);
  assert.deepEqual(wrongTypes.items[0].months, {});
});

const DETAIL_FIXTURE = {
  kitchen_inventory_item_id: "item-1",
  name: "Bột mì 888",
  unit: "g",
  from: "2026-08-01",
  to: "2026-10-19",
  purchases: [
    {
      source: "goods_receipt",
      document_id: "gr-1",
      document_number: "PN-001",
      doc_date: "2026-09-02",
      month: "2026-09",
      receiving_location: "q7",
      supplier_id: "sup-1",
      supplier_name: "NCC Bột",
      product_name: "Bột mì 888",
      quantity: 2,
      unit: "bao",
      factor: 25000,
      factor_source: "alias",
      book_qty: 50000,
      kitchen_inventory_item_id: "item-1",
      image_url: null,
      photo_count: 0,
    },
    {
      source: "payment_request",
      document_id: "pr-1",
      document_number: "DX-001",
      doc_date: "2026-10-01",
      month: "2026-10",
      receiving_location: "q7",
      supplier_id: null,
      supplier_name: null,
      product_name: "Bột mì 888",
      quantity: 1,
      unit: "bao",
      factor: null,
      factor_source: null,
      book_qty: null,
      kitchen_inventory_item_id: "item-1",
      image_url: "https://example.test/pr.jpg",
      photo_count: 0,
    },
  ],
  usage_by_product: [
    {
      finished_sku_id: "sku-1",
      sku_code: "SKU-1",
      product_name: "Bánh mì",
      used_qty: "1200",
      issue_count: 3,
    },
  ],
  used_qty: 1200,
  bought_qty: 50000,
  unknown_lines: 1,
};

test("parses a full item-detail fixture", () => {
  const detail = parseQ7PurchaseUsageItemDetail(DETAIL_FIXTURE);

  assert.equal(detail.kitchen_inventory_item_id, "item-1");
  assert.equal(detail.purchases.length, 2);
  assert.equal(detail.purchases[0].source, "goods_receipt");
  assert.equal(detail.purchases[0].factor, 25000);
  assert.equal(detail.purchases[0].factor_source, "alias");
  assert.equal(detail.purchases[1].source, "payment_request");
  assert.equal(detail.purchases[1].factor, null);
  assert.equal(detail.purchases[1].book_qty, null);
  assert.equal(detail.usage_by_product[0].used_qty, 1200);
  assert.equal(detail.usage_by_product[0].issue_count, 3);
  assert.equal(detail.used_qty, 1200);
  assert.equal(detail.bought_qty, 50000);
  assert.equal(detail.unknown_lines, 1);
});

test("parses malformed item-detail input without throwing", () => {
  assert.doesNotThrow(() => parseQ7PurchaseUsageItemDetail(null));
  assert.doesNotThrow(() => parseQ7PurchaseUsageItemDetail({ purchases: 1 }));

  const parsed = parseQ7PurchaseUsageItemDetail({
    purchases: [
      {
        source: "unknown",
        document_id: 3,
        quantity: "abc",
        factor_source: "something",
        book_qty: "xyz",
      },
    ],
    usage_by_product: "nope",
    used_qty: null,
    bought_qty: undefined,
    unknown_lines: "2",
  });
  assert.equal(parsed.kitchen_inventory_item_id, "");
  assert.equal(parsed.purchases[0].source, "goods_receipt");
  assert.equal(parsed.purchases[0].quantity, 0);
  assert.equal(parsed.purchases[0].factor_source, null);
  assert.equal(parsed.purchases[0].book_qty, null);
  assert.deepEqual(parsed.usage_by_product, []);
  assert.equal(parsed.used_qty, 0);
  assert.equal(parsed.bought_qty, 0);
  assert.equal(parsed.unknown_lines, 2);
});

test("has a label for every status", () => {
  assert.deepEqual(Q7_PURCHASE_USAGE_STATUS_LABELS, {
    big_gap: "Lệch lớn – xem lại phiếu",
    needs_conversion: "Cần quy đổi",
    no_purchase_link: "Chưa nối hàng mua",
    ok: "So được",
    not_in_recipe: "Không có trong công thức",
  });
  for (const [status, label] of Object.entries(Q7_PURCHASE_USAGE_STATUS_LABELS)) {
    assert.equal(
      purchaseUsageStatusLabel(status as keyof typeof Q7_PURCHASE_USAGE_STATUS_LABELS),
      label,
    );
  }
});

test("formats stock quantities in Vietnamese units", () => {
  assert.equal(formatStockQty(475052.4, "g"), "475,1 kg");
  assert.equal(formatStockQty(250, "g"), "250 g");
  assert.equal(formatStockQty(12, "cái"), "12 cái");
  assert.equal(formatStockQty(1500, "ml"), "1,5 l");
  assert.equal(formatStockQty(999, "ml"), "999 ml");
  assert.equal(formatStockQty(0, "g"), "0 g");
  assert.equal(formatStockQty(-1500, "g"), "-1,5 kg");
  assert.equal(formatStockQty(null, "g"), "—");
});

test("explains the gap for every status", () => {
  assert.equal(
    purchaseUsageGapText({ status: "big_gap", ratio: 2.3, total: ZERO_CELL }),
    "Mua gấp 2,3 lần lượng dùng",
  );
  assert.equal(
    purchaseUsageGapText({ status: "ok", ratio: 0.4, total: ZERO_CELL }),
    "Mua bằng 0,4 lần lượng dùng",
  );
  assert.equal(
    purchaseUsageGapText({
      status: "ok",
      ratio: null,
      total: ZERO_CELL,
    }),
    "",
  );
  assert.equal(
    purchaseUsageGapText({
      status: "needs_conversion",
      ratio: null,
      total: { ...ZERO_CELL, unknown_lines: 3 },
    }),
    "3 dòng mua chưa quy đổi được",
  );
  assert.equal(
    purchaseUsageGapText({
      status: "no_purchase_link",
      ratio: null,
      total: ZERO_CELL,
    }),
    "Chưa nối tên hàng mua với món này",
  );
  assert.equal(
    purchaseUsageGapText({
      status: "not_in_recipe",
      ratio: null,
      total: ZERO_CELL,
    }),
    "Không có trong công thức Q7",
  );
});

test("labels months and factor sources", () => {
  assert.equal(monthLabel("2026-09"), "T9/2026");
  assert.equal(monthLabel("2026-12"), "T12/2026");
  assert.equal(monthLabel("bad"), "bad");

  assert.equal(factorSourceLabel("line_unit"), "Theo đơn vị trên phiếu");
  assert.equal(factorSourceLabel("pack_name"), "Theo quy cách trong tên");
  assert.equal(factorSourceLabel("alias"), "Theo quy đổi đã khai");
  assert.equal(factorSourceLabel(null), "Chưa quy đổi được");
  assert.equal(factorSourceLabel(undefined), "Chưa quy đổi được");
});

test("builds gap text for an item created through the item helper", () => {
  const bigGap = item({ status: "big_gap", ratio: 2.5 });
  assert.equal(
    purchaseUsageGapText(bigGap),
    "Mua gấp 2,5 lần lượng dùng",
  );
});
