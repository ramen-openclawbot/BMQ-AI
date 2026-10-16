// Offline tests for the office-order client rules (node:test, no vitest, no DB).
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  buildShelves,
  daysLabel,
  docPhotos,
  docTotals,
  fold,
  groupForItem,
  GR_STATUS,
  PAY_METHOD,
  PAY_STATUS,
  PAY_TYPE,
  photoCount,
  PO_STATUS,
  predictItem,
  PR_STATUS,
  searchItems,
  suggestFromLast,
  startQty,
  type DocLine,
  type OfficeOrderSnapshotItem,
  type PaymentDocPoDetail,
  type PaymentDocPrDetail,
} from "./office-order.ts";

function item(
  overrides: Partial<OfficeOrderSnapshotItem> & { low?: boolean },
): OfficeOrderSnapshotItem {
  return {
    id: overrides.id ?? "item-1",
    item_code: "NVL-001",
    name: "Bột mì",
    unit: "kg",
    item_class: "raw_material",
    pastry_q7: false,
    category: null,
    receipts: 0,
    first_date: null,
    last_date: null,
    avg_qty: null,
    total_qty: null,
    median_gap_days: null,
    supplier_id: null,
    supplier_name: null,
    last_unit: null,
    last_unit_price: null,
    last_raw_qty: null,
    ...overrides,
  };
}

function line(overrides: Partial<DocLine>): DocLine {
  return {
    name: "Bột mì",
    qty: 1,
    unit: "kg",
    price: 1000,
    total: 1000,
    change: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// groupForItem
// ---------------------------------------------------------------------------

test("groupForItem maps the approved demo names to the ten shelves", () => {
  const cases: Array<[string, string]> = [
    ["Bao tay đen size M", "supplies"],
    ["Đá bao TVP J1 Trắng XL (kg)", "other"],
    ["Phô mai vàng hộp Bottega", "cheese"],
    ["Hộp pate 500gr", "packaging"],
    ["Nhãn pate 200g", "packaging"],
    ["Chả lụa lá TVP XL (kg)", "meat_filling"],
    ["Trứng gà 60gr", "eggs"],
    ["Bơ anchor", "dairy_fat"],
    ["Bột sữa nguyên chất", "dairy_fat"],
    ["Peerless Úc 25kg", "flour"],
    ["Bột Ngọt", "sugar_additives"],
    ["Men khô", "sugar_additives"],
    ["Tiêu sọ xay", "vegetables"],
    ["Tương ớt Cholimex gói 10g", "vegetables"],
    ["Socola chip", "sugar_additives"],
    ["Bánh mì lớn", "other"],
  ];
  for (const [name, code] of cases) {
    assert.equal(groupForItem(name, "raw_material", null).code, code, name);
  }
});

test("groupForItem falls back to the item class for an unmatched name", () => {
  assert.equal(groupForItem("Món lạ chưa gặp", "packaging_supply", null).code, "packaging");
  assert.equal(groupForItem("Món lạ chưa gặp", "raw_material", null).code, "other");
  assert.equal(groupForItem("Món lạ chưa gặp", null, null).code, "other");
});

test("groupForItem lets a master category override the name guess", () => {
  const master = groupForItem("Bao tay đen size M", "packaging_supply", "cheese");
  assert.deepEqual(master, { code: "cheese", source: "master" });
  // 'service' is a real stock category but not one of the ten shelves.
  const service = groupForItem("Bột mì", "raw_material", "service");
  assert.deepEqual(service, { code: "flour", source: "guess" });
});

test("fold strips Vietnamese diacritics and turns đ into d", () => {
  assert.equal(fold("Đường đỏ"), "duong do");
  assert.equal(fold("Bột Ngọt"), "bot ngot");
  assert.equal(fold(null), "");
});

// ---------------------------------------------------------------------------
// predictItem / daysLabel
// ---------------------------------------------------------------------------

test("predictItem uses the purchase cycle when there are three receipt days", () => {
  const prediction = predictItem(
    {
      receipts: 4,
      first_date: "2026-01-01",
      last_date: "2026-02-01",
      total_qty: 400,
      median_gap_days: 7,
      avg_qty: 100,
    },
    "2026-02-03",
  );
  assert.equal(prediction.basis, "cycle");
  assert.equal(prediction.daysLeft, 5);
  assert.equal(prediction.low, false);
  assert.equal(prediction.usagePerDay, 400 / 33);
});

test("predictItem falls back to cover with two receipt days", () => {
  const prediction = predictItem(
    {
      receipts: 2,
      first_date: "2026-01-01",
      last_date: "2026-02-01",
      total_qty: 330,
      median_gap_days: null,
      avg_qty: 20,
    },
    "2026-02-03",
  );
  assert.equal(prediction.basis, "cover");
  assert.equal(prediction.usagePerDay, 10);
  assert.equal(prediction.daysLeft, 0);
  assert.equal(prediction.low, true);
});

test("predictItem returns no prediction for a never-bought item", () => {
  const prediction = predictItem(
    {
      receipts: 0,
      first_date: null,
      last_date: null,
      total_qty: null,
      median_gap_days: null,
      avg_qty: null,
    },
    "2026-02-03",
  );
  assert.deepEqual(prediction, {
    daysLeft: null,
    basis: null,
    usagePerDay: null,
    low: false,
  });
});

test("predictItem keeps the low window edges", () => {
  const at = (median: number, sinceDays: number) => {
    const asOf = "2026-02-20";
    const last = new Date(Date.UTC(2026, 1, 20) - sinceDays * 86400000)
      .toISOString()
      .slice(0, 10);
    return predictItem(
      {
        receipts: 3,
        first_date: "2026-01-01",
        last_date: last,
        total_qty: 300,
        median_gap_days: median,
        avg_qty: 100,
      },
      asOf,
    );
  };
  assert.equal(at(5, 20).daysLeft, -15);
  assert.equal(at(5, 20).low, true);
  assert.equal(at(7, 5).daysLeft, 2);
  assert.equal(at(7, 5).low, true);
  assert.equal(at(7.5, 5).daysLeft, 2.5);
  assert.equal(at(7.5, 5).low, false);
  assert.equal(at(4, 20).daysLeft, -16);
  assert.equal(at(4, 20).low, false);
});

test("daysLabel renders the Vietnamese text", () => {
  assert.equal(daysLabel(-3), "Trễ 3 ngày");
  assert.equal(daysLabel(-16), "Trễ 16 ngày");
  assert.equal(daysLabel(0), "Hết hôm nay");
  assert.equal(daysLabel(2), "Còn ~2 ngày");
  assert.equal(daysLabel(2.5), "Còn ~3 ngày");
  assert.equal(daysLabel(null), "");
});

test("suggestFromLast and startQty use the last purchase", () => {
  assert.deepEqual(suggestFromLast({ last_raw_qty: 500, last_unit: "g" }), {
    qty: 500,
    unit: "g",
  });
  assert.equal(suggestFromLast({ last_raw_qty: null, last_unit: "g" }), null);
  assert.equal(startQty({ last_raw_qty: 500, unit: "kg" }), 500);
  assert.equal(startQty({ last_raw_qty: null, unit: "g" }), 1000);
  assert.equal(startQty({ last_raw_qty: null, unit: "ml" }), 1000);
  assert.equal(startQty({ last_raw_qty: null, unit: "kg" }), 1);
});

// ---------------------------------------------------------------------------
// searchItems
// ---------------------------------------------------------------------------

test("searchItems puts a name that starts with the query first", () => {
  const items = [
    item({ id: "a", name: "Đường bột" }),
    item({ id: "b", name: "Bột mì" }),
  ];
  assert.deepEqual(
    searchItems(items, "bot").map((entry) => entry.id),
    ["b", "a"],
  );
});

test("searchItems is diacritics-insensitive", () => {
  const items = [item({ id: "b", name: "Bột mì" })];
  assert.deepEqual(
    searchItems(items, "bot").map((entry) => entry.id),
    ["b"],
  );
  assert.deepEqual(
    searchItems(items, "bột").map((entry) => entry.id),
    ["b"],
  );
});

test("searchItems boosts low items and penalises never-bought items", () => {
  const items = [
    item({ id: "healthy", name: "Bột mì healthy", receipts: 5, low: false }),
    item({ id: "low", name: "Bột mì low", receipts: 5, low: true }),
    item({ id: "new", name: "Bột mì new", receipts: 0, low: false }),
  ];
  const ranked = searchItems(items, "bot mi").map((entry) => entry.id);
  assert.deepEqual(ranked, ["low", "healthy", "new"]);
});

test("searchItems requires every query word and caps at 30", () => {
  const items = [
    item({ id: "match", name: "Bột mì đặc biệt", item_code: "NVL-001" }),
    item({ id: "nope", name: "Đường cát" }),
  ];
  assert.deepEqual(
    searchItems(items, "bot dac").map((entry) => entry.id),
    ["match"],
  );

  const many = Array.from({ length: 40 }, (_, index) => item({ id: `m-${index}` }));
  assert.equal(searchItems(many, "").length, 30);
});

// ---------------------------------------------------------------------------
// buildShelves
// ---------------------------------------------------------------------------

test("buildShelves keeps the shelf order and drops empty shelves", () => {
  const shelves = buildShelves(
    [
      item({ id: "p", name: "Hộp giấy" }),
      item({ id: "f", name: "Bột mì" }),
    ],
    "2026-02-03",
  );
  assert.deepEqual(shelves.map((shelf) => shelf.code), ["flour", "packaging"]);
});

test("buildShelves puts low items first by daysLeft, then last date then name", () => {
  const base = {
    receipts: 3,
    first_date: "2026-01-01",
    last_date: "2026-02-01",
    total_qty: 300,
    avg_qty: 100,
  };
  const shelves = buildShelves(
    [
      item({ id: "healthy", name: "Bột mì đủ", ...base, median_gap_days: 20 }),
      item({ id: "late", name: "Bột mì mới", ...base, median_gap_days: 1 }),
      item({ id: "soon", name: "Bột mì sắp", ...base, median_gap_days: 3 }),
    ],
    "2026-02-03",
  );
  assert.equal(shelves.length, 1);
  assert.deepEqual(
    shelves[0].items.map((entry) => entry.id),
    ["late", "soon", "healthy"],
  );
  assert.equal(shelves[0].label, "Bột và ngũ cốc");
});

// ---------------------------------------------------------------------------
// docTotals / label maps
// ---------------------------------------------------------------------------

test("docTotals sums the lines and flags a mismatch with the doc amount", () => {
  const lines = [line({ total: 100 }), line({ total: 200 })];
  assert.deepEqual(docTotals(lines, 30, 300), {
    linesSum: 300,
    vat: 30,
    amount: 300,
    showLinesSum: false,
  });
  assert.equal(docTotals(lines, 30, 310).showLinesSum, true);
  // A missing line total falls back to qty * price.
  assert.equal(docTotals([line({ total: null, qty: 2, price: 500 })], null, 1000).linesSum, 1000);
  // Rounding only: 999.6 rounds to 1000 and matches the amount.
  assert.equal(docTotals([line({ total: 999.6 })], null, 1000).showLinesSum, false);
});

test("the label maps cover the statuses the page shows", () => {
  assert.equal(PR_STATUS.pending, "Chờ duyệt");
  assert.equal(PR_STATUS.approved, "Đã duyệt");
  assert.equal(PR_STATUS.rejected, "Từ chối");
  assert.equal(PAY_STATUS.unpaid, "Chưa chi");
  assert.equal(PAY_STATUS.paid, "Đã chi");
  assert.equal(PAY_TYPE.new_order, "Đơn mới");
  assert.equal(PAY_TYPE.old_order, "Công nợ cũ");
  assert.equal(PAY_METHOD.bank_transfer, "Chuyển khoản");
  assert.equal(PAY_METHOD.cash, "Tiền mặt");
  assert.equal(PO_STATUS.draft, "Nháp");
  assert.equal(PO_STATUS.sent, "Đã gửi NCC");
  assert.equal(PO_STATUS.completed, "Hoàn tất");
  assert.equal(PO_STATUS.cancelled, "Đã huỷ");
  assert.equal(GR_STATUS.confirmed, "Đã nhập");
  assert.equal(GR_STATUS.received, "Đã nhận");
});

// ---------------------------------------------------------------------------
// docPhotos / photoCount
// ---------------------------------------------------------------------------

function prDetail(overrides: Partial<PaymentDocPrDetail> = {}): PaymentDocPrDetail {
  return {
    kind: "pr",
    number: "PR-001",
    title: "Đề nghị chi",
    description: null,
    notes: null,
    status: "pending",
    payment_status: "unpaid",
    delivery_status: "pending",
    payment_type: "new_order",
    payment_method: "cash",
    amount: 1000,
    vat: 0,
    created_at: "2026-10-16",
    invoice_created: false,
    has_image: true,
    image_path: "pr/header.jpg",
    attachments: [{ path: "pr/att.pdf", name: "Hoá đơn.pdf", mime: "application/pdf" }],
    supplier: null,
    po: null,
    gr: {
      id: "gr-1",
      number: "GR-001",
      date: "2026-10-15",
      status: "confirmed",
      has_image: true,
      image_path: "gr/note.jpg",
      photos: ["gr/p1.jpg", "gr/p2.jpg"],
    },
    lines: [],
    ...overrides,
  };
}

function poDetail(overrides: Partial<PaymentDocPoDetail> = {}): PaymentDocPoDetail {
  return {
    kind: "po",
    number: "PO-001",
    date: "2026-10-10",
    expected: null,
    status: "sent",
    amount: 2000,
    vat: 0,
    notes: null,
    has_image: true,
    image_path: "po/header.jpg",
    supplier: null,
    gr: {
      id: "gr-2",
      number: "GR-002",
      date: "2026-10-12",
      status: "received",
      has_image: true,
      image_path: "gr/po-note.jpg",
      photos: ["gr/po-p1.jpg"],
    },
    prs: [],
    lines: [],
    ...overrides,
  };
}

test("docPhotos lists a PR header, attachments and the goods receipt in order", () => {
  assert.deepEqual(docPhotos(prDetail()), [
    { key: "pr-pr/header.jpg", label: "Ảnh đề nghị chi", path: "pr/header.jpg", bucket: "invoices" },
    {
      key: "att-pr/att.pdf",
      label: "Hoá đơn.pdf",
      path: "pr/att.pdf",
      bucket: "invoices",
      name: "Hoá đơn.pdf",
      mime: "application/pdf",
    },
    { key: "gr-gr/note.jpg", label: "Phiếu nhập GR-001", path: "gr/note.jpg", bucket: "invoices" },
    { key: "grp-gr/p1.jpg", label: "Ảnh hàng 1", path: "gr/p1.jpg", bucket: "invoices" },
    { key: "grp-gr/p2.jpg", label: "Ảnh hàng 2", path: "gr/p2.jpg", bucket: "invoices" },
  ]);
  assert.equal(photoCount(prDetail()), 5);
});

test("docPhotos falls back to a numbered label for an unnamed attachment", () => {
  const pr = prDetail({ attachments: [{ path: "pr/scan.jpg", name: null, mime: null }] });
  const photos = docPhotos(pr);
  assert.equal(photos[0].label, "Ảnh đề nghị chi");
  assert.deepEqual(photos[1], {
    key: "att-pr/scan.jpg",
    label: "Tệp đính kèm 1",
    path: "pr/scan.jpg",
    bucket: "invoices",
    name: null,
    mime: null,
  });
});

test("docPhotos returns nothing for a PR without photos", () => {
  const bare = prDetail({ image_path: null, has_image: false, attachments: [], gr: null });
  assert.deepEqual(docPhotos(bare), []);
  assert.equal(photoCount(bare), 0);
});

test("docPhotos uses purchase-orders for the PO header and invoices for its GR", () => {
  assert.deepEqual(docPhotos(poDetail()), [
    { key: "po-po/header.jpg", label: "Ảnh đơn mua", path: "po/header.jpg", bucket: "purchase-orders" },
    { key: "gr-gr/po-note.jpg", label: "Phiếu nhập GR-002", path: "gr/po-note.jpg", bucket: "invoices" },
    { key: "grp-gr/po-p1.jpg", label: "Ảnh hàng 1", path: "gr/po-p1.jpg", bucket: "invoices" },
  ]);
  assert.equal(photoCount(poDetail()), 3);
});
