import assert from "node:assert/strict";
import test from "node:test";

import {
  blockerLabel,
  formatQuantity,
  formatVnd,
  parsePreparedSupplierOrder,
  parseSendSupplierOrderLinesResult,
  parseSupplierOrderCatalog,
  parseSupplierOrderCatalogCandidates,
  parseSupplierOrderHistory,
  parseSupplierOrderHistoryBySupplier,
  parseSupplierOrderPreview,
  parseSupplierOrderSuppliers,
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

test("parses the supplier list with numeric strings and nulls", () => {
  const suppliers = parseSupplierOrderSuppliers({
    suppliers: [
      {
        id: "sup-1",
        name: "Phúc Thịnh",
        email: " pt@example.test ",
        item_count: "3",
        last_order: { po_number: "PO-1", sent_at: "2026-10-21T00:00:00Z" },
        unpaid_count: "2",
      },
      {
        id: "sup-2",
        name: "TV Food",
        email: null,
        item_count: 1,
        last_order: null,
        unpaid_count: 0,
      },
    ],
  });

  assert.equal(suppliers.length, 2);
  assert.equal(suppliers[0].email, "pt@example.test");
  assert.equal(suppliers[0].itemCount, 3);
  assert.equal(suppliers[0].lastOrder?.poNumber, "PO-1");
  assert.equal(suppliers[0].unpaidCount, 2);
  assert.equal(suppliers[1].lastOrder, null);
  assert.equal(suppliers[1].email, null);
  assert.deepEqual(parseSupplierOrderSuppliers(null), []);
  assert.deepEqual(parseSupplierOrderSuppliers("nope"), []);
});

test("parses the catalog with items, blockers, delivery and prepay", () => {
  const catalog = parseSupplierOrderCatalog({
    supplier: { id: "sup-1", name: "Phúc Thịnh", email: "pt@example.test" },
    delivery: {
      address: "123 A",
      contact_name: "Minh",
      contact_phone: "0909",
      note: "Giao giờ hành chính",
    },
    mailbox_connected: true,
    blockers: ["no_price", ""],
    items: [
      {
        catalog_id: "cat-1",
        item: { id: "item-1", name: "Bột mì 999 Cam", code: "MI999", unit: "g" },
        product_name: "Bột mì 999 Cam (25kg)",
        po_unit: "kg",
        po_unit_factor: "1000",
        pack_size_po: "25",
        vat_rate: "8",
        stock: {
          on_hand: "12500.5",
          daily_usage: "1000",
          days_left: "12.5",
          reorder_date: "2026-10-30",
          last_count_date: null,
        },
        proposal_qty: "25",
        unit_price: "19300.00",
        open_order: {
          po_number: "PO-1",
          quantity: "25",
          unit: "kg",
          sent_at: "2026-10-21T00:00:00Z",
        },
      },
    ],
    prepay: {
      id: "pr-1",
      request_number: "PR-1",
      created_at: "2026-10-20T00:00:00Z",
      total_amount: "5000000",
      remaining: "2500000",
      po_number: "PO-0",
      recent_submission: null,
    },
  });

  assert.ok(catalog);
  assert.equal(catalog.supplier?.name, "Phúc Thịnh");
  assert.equal(catalog.mailboxConnected, true);
  assert.deepEqual(catalog.blockers, ["no_price"]);
  assert.equal(catalog.items.length, 1);
  assert.equal(catalog.items[0].poUnitFactor, 1000);
  assert.equal(catalog.items[0].packSizePo, 25);
  assert.equal(catalog.items[0].vatRate, 8);
  assert.equal(catalog.items[0].proposalQty, 25);
  assert.equal(catalog.items[0].unitPrice, 19300);
  assert.equal(catalog.items[0].stock.onHand, 12500.5);
  assert.equal(catalog.items[0].openOrder?.poNumber, "PO-1");
  assert.equal(catalog.prepay?.requestNumber, "PR-1");
  assert.equal(catalog.prepay?.remaining, 2500000);
  assert.equal(catalog.prepay?.recentSubmission, null);
  assert.equal(parseSupplierOrderCatalog(null), null);
  assert.equal(parseSupplierOrderCatalog("nope"), null);
  assert.equal(parseSupplierOrderCatalog({ items: [] })?.items.length, 0);
});

test("parses catalog candidates", () => {
  const candidates = parseSupplierOrderCatalogCandidates([
    {
      item_id: "item-2",
      name: "Bột mì 888 Cam",
      unit: "g",
      latest_product_name: "Bột mì 888 Cam (25kg)",
      last_order_date: "2026-10-20",
      line_count: "4",
    },
  ]);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].itemId, "item-2");
  assert.equal(candidates[0].latestProductName, "Bột mì 888 Cam (25kg)");
  assert.equal(candidates[0].lineCount, 4);
  assert.deepEqual(parseSupplierOrderCatalogCandidates(null), []);
  assert.deepEqual(parseSupplierOrderCatalogCandidates("nope"), []);
});

test("parses a multi-line preview payload", () => {
  const preview = parseSupplierOrderPreview({
    subject: "BMQ đặt hàng PO mới (số cấp khi gửi) – Phúc Thịnh",
    html: "<div>x</div>",
    text: "x",
    to_email: "pt@example.test",
    lines: [
      {
        position: "1",
        item_id: "item-1",
        product_name: "Bột mì 999 Cam",
        quantity: "25",
        unit: "kg",
        unit_price: "19300",
        line_total: "482500",
        vat_rate: "8",
      },
    ],
    subtotal: "482500",
    vat_amount: "38600",
    total: "521100",
    prepay: null,
    prepay_reason: "none",
  });
  assert.ok(preview);
  assert.equal(preview.lines.length, 1);
  assert.equal(preview.lines[0].position, 1);
  assert.equal(preview.lines[0].quantity, 25);
  assert.equal(preview.lines[0].unitPrice, 19300);
  assert.equal(preview.lines[0].vatRate, 8);
  assert.equal(preview.subtotal, 482500);
  assert.equal(preview.vatAmount, 38600);
  assert.equal(preview.total, 521100);
  assert.equal(preview.prepay, null);
  assert.equal(preview.prepayReason, "none");
  assert.equal(parseSupplierOrderPreview(null), null);
  assert.equal(parseSupplierOrderPreview("nope"), null);
});

test("parses a multi send result and its prepay", () => {
  const result = parseSendSupplierOrderLinesResult({
    status: "sent",
    po_number: "PO-2",
    to_email: "pt@example.test",
    sent_at: "2026-10-23T00:00:00Z",
    prepay: {
      status: "created",
      request_number: "PR-2",
      submission_number: "TC-261023-01",
    },
  });
  assert.ok(result);
  assert.equal(result.status, "sent");
  assert.equal(result.poNumber, "PO-2");
  assert.equal(result.prepay?.status, "created");
  assert.equal(result.prepay?.submissionNumber, "TC-261023-01");
  assert.equal(parseSendSupplierOrderLinesResult(null), null);
  assert.equal(parseSendSupplierOrderLinesResult("nope"), null);
});

test("parses supplier history with lines, uploads and prepay", () => {
  const history = parseSupplierOrderHistoryBySupplier({
    items: [
      {
        id: "row-1",
        request_id: "req-1",
        po_number: "PO-3",
        subtotal: "955000",
        vat_amount: "76400",
        total: "1397300",
        status: "sent",
        sent_at: "2026-10-23T00:00:00Z",
        to_email: "pt@example.test",
        created_at: "2026-10-23T00:00:00Z",
        lines: [
          {
            position: "1",
            item_id: "item-1",
            product_name: "Bột mì 999 Cam",
            quantity: "25",
            unit: "kg",
            unit_price: "19300",
            line_total: "482500",
            vat_rate: "8",
          },
          {
            position: 2,
            item_id: "item-2",
            product_name: "Bột mì 888 Cam",
            quantity: 50,
            unit: "kg",
            unit_price: 18296,
            line_total: 914800,
            vat_rate: 8,
          },
        ],
        uploads: [
          {
            file_name: "hoa-don.pdf",
            mime_type: "application/pdf",
            size_bytes: "1200",
            created_at: "2026-10-22T00:00:00Z",
            storage_path: "request/20261022-abc.pdf",
          },
        ],
        prepay: {
          status: "created",
          request_number: "PR-2",
          submission_number: "TC-261023-01",
        },
      },
    ],
  });
  assert.equal(history.length, 1);
  assert.equal(history[0].lines.length, 2);
  assert.equal(history[0].subtotal, 955000);
  assert.equal(history[0].vatAmount, 76400);
  assert.equal(history[0].lines[0].quantity, 25);
  assert.equal(history[0].lines[0].vatRate, 8);
  assert.equal(history[0].lines[1].lineTotal, 914800);
  assert.equal(history[0].lines[1].vatRate, 8);
  assert.equal(history[0].uploads[0].fileName, "hoa-don.pdf");
  assert.equal(history[0].prepay?.submissionNumber, "TC-261023-01");
  assert.deepEqual(parseSupplierOrderHistoryBySupplier(null), []);
  assert.deepEqual(parseSupplierOrderHistoryBySupplier("nope"), []);
});

test("tolerates missing VAT fields", () => {
  const catalog = parseSupplierOrderCatalog({
    items: [{ catalog_id: "cat-1", item: { id: "item-1", name: "Bột mì" } }],
  });
  assert.ok(catalog);
  assert.equal(catalog.items[0].vatRate, 0);

  const preview = parseSupplierOrderPreview({
    lines: [{ item_id: "item-1", quantity: 1 }],
  });
  assert.ok(preview);
  assert.equal(preview.lines[0].vatRate, 0);
  assert.equal(preview.subtotal, null);
  assert.equal(preview.vatAmount, null);

  const history = parseSupplierOrderHistoryBySupplier({
    items: [{ id: "row-1", request_id: "req-1", lines: [{ item_id: "item-1" }] }],
  });
  assert.equal(history[0].subtotal, null);
  assert.equal(history[0].vatAmount, null);
  assert.equal(history[0].lines[0].vatRate, null);
});
