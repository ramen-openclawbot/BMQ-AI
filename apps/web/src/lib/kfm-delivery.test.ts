import assert from "node:assert/strict";
import test from "node:test";

import {
  deliveryRatioBand,
  jevKindLabel,
  monthRange,
  parseKfmDailyDeliveryReport,
  parseKfmDeliveryVsPo,
} from "./kfm-delivery.ts";

const ACCOUNTING_ROWS = [
  ["PO1002684496", "2026-10-24", 820, 776],
  ["PO1002682291", "2026-10-21", 830, 811],
  ["PO1002674500", "2026-10-14", 818, 646],
  ["PO1002673250", "2026-10-13", 809, 560],
  ["PO1002670572", "2026-10-10", 780, 765],
  ["PO1002669558", "2026-10-09", 956, 941],
  ["PO1002668629", "2026-10-08", 857, 851],
  ["PO1002666220", "2026-10-06", 727, 689],
  ["PO1002662319", "2026-10-01", 628, 594],
] as const;

test("parses the nine accounting POs and computes 7225 / 6633 / -592", () => {
  const parsed = parseKfmDeliveryVsPo({
    rows: ACCOUNTING_ROWS.map(([poNumber, deliveryDate, poQty, deliveredQty]) => ({
      po_number: poNumber,
      delivery_date: deliveryDate,
      po_qty: String(poQty),
      delivered_qty: String(deliveredQty),
      is_default: false,
      source: "ke_toan",
    })),
  });

  assert.equal(parsed.rows.length, 9);
  assert.equal(parsed.totals.poCount, 9);
  assert.equal(parsed.totals.poQty, 7225);
  assert.equal(parsed.totals.deliveredQty, 6633);
  assert.equal(parsed.totals.shortfall, -592);
  assert.ok(parsed.totals.ratio !== null);
  assert.equal(Number(parsed.totals.ratio.toFixed(3)), 0.918);
  assert.equal(parsed.totals.confirmedCount, 9);
  assert.equal(parsed.totals.under95Count, 5);

  const first = parsed.rows[0];
  assert.equal(first.poNumber, "PO1002684496");
  assert.equal(first.deliveryDate, "2026-10-24");
  assert.equal(first.poQty, 820);
  assert.equal(first.deliveredQty, 776);
  assert.equal(first.shortfall, -44);
  assert.equal(first.source, "ke_toan");
  assert.equal(first.isDefault, false);
  assert.equal(deliveryRatioBand(parsed.totals.ratio), "warn");
});

test("uses server totals when present and tolerates missing fields", () => {
  const parsed = parseKfmDeliveryVsPo({
    rows: [
      {
        po_number: "PO1002692065",
        po_qty: "640",
        delivered_qty: "640",
        is_default: true,
      },
    ],
    totals: {
      po_count: "1",
      po_qty: "640",
      delivered_qty: "640",
      shortfall: "0",
      ratio: "1",
      confirmed_count: "0",
      under_95_count: "0",
    },
  });

  assert.equal(parsed.rows[0].customerPoInboxId, null);
  assert.equal(parsed.rows[0].note, null);
  assert.equal(parsed.rows[0].shortfall, 0);
  assert.equal(parsed.rows[0].ratio, 1);
  assert.equal(parsed.totals.poCount, 1);
  assert.equal(parsed.totals.ratio, 1);
  assert.equal(parsed.totals.confirmedCount, 0);
});

test("parses the daily report with default rows and photos", () => {
  const report = parseKfmDailyDeliveryReport({
    date: "2026-10-31",
    pos: [
      {
        po_number: "PO1002692065",
        customer_po_inbox_id: "inbox-1",
        delivery_date: "2026-10-31",
        po_qty: "640.5",
        delivered_qty: "640.5",
        is_default: true,
        source: null,
        note: null,
        updated_at: null,
      },
    ],
    photos: [
      {
        id: "photo-1",
        storage_path: "2026-10-31/photo-1.jpg",
        created_at: "2026-10-31T08:00:00Z",
      },
    ],
  });

  assert.equal(report.date, "2026-10-31");
  assert.equal(report.pos.length, 1);
  assert.equal(report.pos[0].poQty, 640.5);
  assert.equal(report.pos[0].deliveredQty, 640.5);
  assert.equal(report.pos[0].isDefault, true);
  assert.equal(report.photos.length, 1);
  assert.equal(report.photos[0].storagePath, "2026-10-31/photo-1.jpg");
  assert.equal(report.photos[0].createdAt, "2026-10-31T08:00:00Z");
});

test("parses saved/Jev photo fields and degrades when they are missing", () => {
  const report = parseKfmDailyDeliveryReport({
    date: "2026-11-01",
    photos: [
      {
        id: "photo-1",
        storage_path: "2026-11-01/photo-1.jpg",
        created_at: "2026-11-01T08:00:00Z",
        saved_at: "2026-11-01T09:00:00Z",
        jev_status: "done",
        jev_kind: "phieu_xuat_kho",
        jev_po_numbers: ["PO1000000001", "PO1000000002", "PO1000000001"],
        jev_quantities: [
          { po_number: "PO1000000001", qty: "100.5" },
          { po_number: "PO1000000002", qty: 50 },
          { po_number: "bad", qty: "n/a" },
        ],
        jev_summary: "Phiếu xuất kho",
        jev_mismatch: false,
      },
      {
        id: "photo-2",
        storage_path: "2026-11-01/photo-2.jpg",
      },
    ],
  });

  assert.equal(report.photos.length, 2);
  assert.equal(report.photos[0].savedAt, "2026-11-01T09:00:00Z");
  assert.equal(report.photos[0].jevStatus, "done");
  assert.equal(report.photos[0].jevKind, "phieu_xuat_kho");
  assert.deepEqual(report.photos[0].jevPoNumbers, ["PO1000000001", "PO1000000002"]);
  assert.deepEqual(report.photos[0].jevQuantities, [
    { poNumber: "PO1000000001", qty: 100.5 },
    { poNumber: "PO1000000002", qty: 50 },
  ]);
  assert.equal(report.photos[0].jevSummary, "Phiếu xuất kho");
  assert.equal(report.photos[0].jevMismatch, false);

  assert.equal(report.photos[1].savedAt, null);
  assert.equal(report.photos[1].jevStatus, null);
  assert.equal(report.photos[1].jevKind, null);
  assert.deepEqual(report.photos[1].jevPoNumbers, []);
  assert.deepEqual(report.photos[1].jevQuantities, []);
  assert.equal(report.photos[1].jevSummary, null);
  assert.equal(report.photos[1].jevMismatch, null);
});

test("labels the four Jev document kinds in Vietnamese", () => {
  assert.equal(jevKindLabel("phieu_xuat_kho"), "Phiếu xuất kho");
  assert.equal(jevKindLabel("bien_ban_giao_hang"), "Biên bản giao hàng");
  assert.equal(jevKindLabel("hoa_don"), "Hoá đơn");
  assert.equal(jevKindLabel("khac"), "Khác");
  assert.equal(jevKindLabel(null), "");
  assert.equal(jevKindLabel(undefined), "");
  assert.equal(jevKindLabel("unknown"), "");
});

test("missing daily payload becomes an empty report", () => {
  assert.deepEqual(parseKfmDailyDeliveryReport(null), {
    date: null,
    pos: [],
    photos: [],
  });
  assert.deepEqual(parseKfmDailyDeliveryReport({}), {
    date: null,
    pos: [],
    photos: [],
  });
});

test("maps delivery ratios to the four UI bands", () => {
  assert.equal(deliveryRatioBand(null), "none");
  assert.equal(deliveryRatioBand(undefined), "none");
  assert.equal(deliveryRatioBand(Number.NaN), "none");
  assert.equal(deliveryRatioBand(1), "ok");
  assert.equal(deliveryRatioBand(0.95), "ok");
  assert.equal(deliveryRatioBand(0.9499), "warn");
  assert.equal(deliveryRatioBand(0.85), "warn");
  assert.equal(deliveryRatioBand(0.8499), "bad");
});

test("monthRange returns the first and last day of the containing month", () => {
  assert.deepEqual(monthRange("2026-10-31"), {
    from: "2026-10-01",
    to: "2026-10-31",
  });
  assert.deepEqual(monthRange("2028-02-12"), {
    from: "2028-02-01",
    to: "2028-02-29",
  });
  assert.deepEqual(monthRange("2026-12-01T10:30:00Z"), {
    from: "2026-12-01",
    to: "2026-12-31",
  });
  assert.throws(() => monthRange("31/10/2026"), /invalid_date/);
});
