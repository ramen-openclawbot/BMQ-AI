import assert from "node:assert/strict";
import test from "node:test";

import {
  blockerLabel,
  formatQuantity,
  formatVnd,
  parsePreparedSupplierOrder,
  parseSupplierOrderHistory,
  parseSupplierOrderUploadSummary,
} from "./supplier-order.ts";

test("parses a prepare payload with numbers arriving as strings", () => {
  const parsed = parsePreparedSupplierOrder({
    item: { id: "item-1", name: "Bơ Peerless Úc 25kg", unit: "g" },
    supplier: { id: "sup-1", name: "TV Food", email: "supplier@example.test" },
    stock: {
      on_hand: "12500.5",
      daily_usage: "1000",
      days_left: "12.5",
      last_count_date: "2026-10-20",
      reorder_date: null,
    },
    proposal: {
      quantity: "25",
      unit: "kg",
      unit_price: "90000",
      line_total: "2250000",
      product_name: "Bơ Peerless",
      pack_size_po_units: "25",
      suggested_book_qty: "25000",
    },
    open_order: {
      po_number: "PO-1",
      quantity: "25",
      unit: "kg",
      status: "sent",
      created_at: "2026-10-21T00:00:00Z",
    },
    delivery: {
      address: "123 A",
      contact_name: "Minh",
      contact_phone: "0909",
      note: "",
    },
    blockers: ["no_price", "mailbox_not_connected", ""],
  });

  assert.ok(parsed);
  assert.equal(parsed.stock.onHand, 12500.5);
  assert.equal(parsed.stock.dailyUsage, 1000);
  assert.equal(parsed.stock.daysLeft, 12.5);
  assert.equal(parsed.proposal.quantity, 25);
  assert.equal(parsed.proposal.unit, "kg");
  assert.equal(parsed.proposal.unitPrice, 90000);
  assert.equal(parsed.proposal.lineTotal, 2250000);
  assert.equal(parsed.proposal.productName, "Bơ Peerless");
  assert.equal(parsed.openOrder?.poNumber, "PO-1");
  assert.deepEqual(parsed.blockers, ["no_price", "mailbox_not_connected"]);
});

test("tolerates missing supplier, open order and fields", () => {
  const parsed = parsePreparedSupplierOrder({
    item: { id: "item-1", name: "Bơ" },
    supplier: null,
    proposal: {},
    blockers: [],
  });
  assert.ok(parsed);
  assert.equal(parsed.supplier, null);
  assert.equal(parsed.openOrder, null);
  assert.equal(parsed.stock.onHand, null);
  assert.equal(parsed.stock.daysLeft, null);
  assert.equal(parsed.proposal.quantity, 0);
  assert.equal(parsed.delivery.address, "");
  assert.equal(parsePreparedSupplierOrder(null), null);
  assert.equal(parsePreparedSupplierOrder("nope"), null);
});

test("parses history uploads and totals", () => {
  const history = parseSupplierOrderHistory({
    items: [
      {
        id: "row-1",
        request_id: "req-1",
        po_number: "PO-1",
        quantity: "25",
        unit: "kg",
        total: "2250000",
        status: "sent",
        sent_at: "2026-10-21T00:00:00Z",
        to_email: "supplier@example.test",
        uploads: [
          {
            file_name: "hoa-don.pdf",
            mime_type: "application/pdf",
            size_bytes: "1200",
            created_at: "2026-10-22T00:00:00Z",
            storage_path: "request/20261022-abc.pdf",
          },
        ],
      },
    ],
  });

  assert.equal(history.length, 1);
  assert.equal(history[0].quantity, 25);
  assert.equal(history[0].total, 2250000);
  assert.equal(history[0].uploads[0].fileName, "hoa-don.pdf");
  assert.equal(history[0].uploads[0].sizeBytes, 1200);
  assert.deepEqual(parseSupplierOrderHistory(null), []);
});

test("parses the public upload summary", () => {
  const summary = parseSupplierOrderUploadSummary({
    po_number: "PO-1",
    supplier_name: "TV Food",
    product_name: "Bơ Peerless",
    quantity: "25",
    unit: "kg",
    sent_at: "2026-10-21T00:00:00Z",
    upload_count: "2",
  });
  assert.equal(summary.poNumber, "PO-1");
  assert.equal(summary.quantity, 25);
  assert.equal(summary.uploadCount, 2);
});

test("maps blocker codes to Vietnamese labels", () => {
  assert.equal(blockerLabel("no_supplier"), "Chưa chọn nhà cung cấp");
  assert.equal(
    blockerLabel("no_supplier_email"),
    "Nhà cung cấp chưa có email đặt hàng",
  );
  assert.equal(blockerLabel("no_price"), "Chưa có giá mua gần nhất");
  assert.equal(blockerLabel("no_po_unit"), "Chưa cài đơn vị đặt hàng");
  assert.equal(
    blockerLabel("mailbox_not_connected"),
    "Chưa kết nối hộp thư order@bmq.vn",
  );
  assert.equal(blockerLabel("unknown_code"), "unknown_code");
});

test("formats quantities and VND", () => {
  assert.equal(formatQuantity(25), "25");
  assert.equal(formatQuantity(1.5), "1,5");
  assert.equal(formatQuantity(1000), "1.000");
  assert.equal(formatVnd(1234567), "1.234.567 đ");
  assert.equal(formatVnd(null), "0 đ");
});
