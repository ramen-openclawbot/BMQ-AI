import assert from "node:assert/strict";
import test from "node:test";

import {
  blockerLabel,
  computeOrderAmounts,
  filterSupplierOrderSuppliers,
  formatQuantity,
  formatVnd,
  normalizeSupplierOrderSearch,
  parsePreparedSupplierOrder,
  parseSendSupplierOrderLinesResult,
  parseSupplierOrderCatalog,
  parseSupplierOrderCatalogCandidates,
  parseSupplierOrderHistory,
  parseSupplierOrderHistoryBySupplier,
  parseSupplierOrderPreview,
  parseSupplierOrderSuppliers,
  parseSupplierOrderUploadSummary,
  sortSupplierOrderSuppliersByUrgency,
  type SupplierOrderSupplierListEntry,
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

test("computes the ĐH19993 order with VAT-inclusive list prices", () => {
  const result = computeOrderAmounts([
    {
      quantity: 200,
      unitPrice: 19296.3,
      vatRate: 8,
      listPrice: 20840,
      listPriceIncludesVat: true,
    },
    {
      quantity: 250,
      unitPrice: 18925.93,
      vatRate: 8,
      listPrice: 20440,
      listPriceIncludesVat: true,
    },
    {
      quantity: 25,
      unitPrice: 140740.74,
      vatRate: 8,
      listPrice: 152000,
      listPriceIncludesVat: true,
    },
  ]);

  assert.equal(result.lines[0].lineTotal, 3859259);
  assert.equal(result.lines[0].vatAmount, 308741);
  assert.equal(result.lines[0].grossAmount, 4168000);
  assert.equal(result.lines[0].unitPrice, 19296.3);
  assert.equal(result.lines[1].lineTotal, 4731481);
  assert.equal(result.lines[1].vatAmount, 378519);
  assert.equal(result.lines[1].grossAmount, 5110000);
  assert.equal(result.lines[1].unitPrice, 18925.93);
  assert.equal(result.lines[2].lineTotal, 3518519);
  assert.equal(result.lines[2].vatAmount, 281481);
  assert.equal(result.lines[2].grossAmount, 3800000);
  assert.equal(result.lines[2].unitPrice, 140740.74);
  assert.equal(result.subtotal, 12109259);
  assert.equal(result.vatAmount, 968741);
  assert.equal(result.total, 13078000);
});

test("keeps the history-price behavior when there is no list price", () => {
  const result = computeOrderAmounts([
    {
      quantity: 25,
      unitPrice: 90000,
      vatRate: 0,
      listPrice: null,
      listPriceIncludesVat: false,
    },
  ]);
  assert.equal(result.lines[0].unitPrice, 90000);
  assert.equal(result.lines[0].lineTotal, 2250000);
  assert.equal(result.lines[0].vatAmount, 0);
  assert.equal(result.lines[0].grossAmount, 2250000);
  assert.equal(result.subtotal, 2250000);
  assert.equal(result.vatAmount, 0);
  assert.equal(result.total, 2250000);
});

test("a net list price at 8% matches the history-price path", () => {
  const listNet = computeOrderAmounts([
    {
      quantity: 25,
      unitPrice: 18900,
      vatRate: 8,
      listPrice: 19300,
      listPriceIncludesVat: false,
    },
  ]);
  const history = computeOrderAmounts([
    {
      quantity: 25,
      unitPrice: 19300,
      vatRate: 8,
      listPrice: null,
      listPriceIncludesVat: false,
    },
  ]);
  assert.equal(listNet.lines[0].lineTotal, history.lines[0].lineTotal);
  assert.equal(listNet.lines[0].unitPrice, history.lines[0].unitPrice);
  assert.equal(listNet.lines[0].vatAmount, history.lines[0].vatAmount);
  assert.equal(listNet.lines[0].grossAmount, history.lines[0].grossAmount);
  assert.equal(listNet.subtotal, history.subtotal);
  assert.equal(listNet.vatAmount, history.vatAmount);
  assert.equal(listNet.total, history.total);
  assert.equal(listNet.subtotal, 482500);
  assert.equal(listNet.vatAmount, 38600);
  assert.equal(listNet.total, 521100);
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

test("parses prepay official invoice when present", () => {
  const catalog = parseSupplierOrderCatalog({
    prepay: {
      id: "pr-1",
      request_number: "PR-C1209293",
      official_invoice: {
        invoice_number: "00010771",
        invoice_series: "1C26TNN",
        invoice_date: "2026-10-20",
      },
    },
  });

  assert.ok(catalog);
  assert.deepEqual(catalog.prepay?.officialInvoice, {
    invoiceNumber: "00010771",
    invoiceSeries: "1C26TNN",
    invoiceDate: "2026-10-20",
  });
});

test("parses prepay official invoice as null when absent", () => {
  const catalog = parseSupplierOrderCatalog({
    prepay: {
      id: "pr-1",
      request_number: "PR-C1209293",
    },
  });

  assert.ok(catalog);
  assert.equal(catalog.prepay?.officialInvoice, null);
});

test("parses malformed prepay official invoice defensively", () => {
  const asTextCatalog = parseSupplierOrderCatalog({
    prepay: {
      id: "pr-1",
      request_number: "PR-C1209293",
      official_invoice: "not-an-object",
    },
  });
  const asArrayCatalog = parseSupplierOrderCatalog({
    prepay: {
      id: "pr-1",
      request_number: "PR-C1209293",
      official_invoice: [{ invoice_number: "00010771" }],
    },
  });

  assert.ok(asTextCatalog);
  assert.ok(asArrayCatalog);
  assert.equal(asTextCatalog.prepay?.officialInvoice, null);
  assert.equal(asArrayCatalog.prepay?.officialInvoice, null);
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
        gross_amount: "521100",
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
  assert.equal(preview.lines[0].grossAmount, 521100);
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
        po_status: "sent",
        subtotal: "955000",
        vat_amount: "76400",
        total: "1397300",
        status: "sent",
        sent_at: "2026-10-23T00:00:00Z",
        to_email: "pt@example.test",
        created_at: "2026-10-23T00:00:00Z",
        receipt: {
          id: "gr-1",
          receipt_number: "PN-261023-01",
          status: "confirmed",
          finalized_at: null,
        },
        payment: {
          request_number: "PR-3",
          status: "pending",
          payment_status: "unpaid",
          total_amount: "13078000",
        },
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
            gross_amount: "521100",
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
  assert.equal(history[0].lines[0].grossAmount, 521100);
  assert.equal(history[0].lines[1].lineTotal, 914800);
  assert.equal(history[0].lines[1].vatRate, 8);
  assert.equal(history[0].uploads[0].fileName, "hoa-don.pdf");
  assert.equal(history[0].prepay?.submissionNumber, "TC-261023-01");
  assert.equal(history[0].poStatus, "sent");
  assert.equal(history[0].receipt?.receiptNumber, "PN-261023-01");
  assert.equal(history[0].receipt?.status, "confirmed");
  assert.equal(history[0].receipt?.finalizedAt, null);
  assert.equal(history[0].payment?.requestNumber, "PR-3");
  assert.equal(history[0].payment?.status, "pending");
  assert.equal(history[0].payment?.paymentStatus, "unpaid");
  assert.equal(history[0].payment?.totalAmount, 13078000);
  assert.deepEqual(parseSupplierOrderHistoryBySupplier(null), []);
  assert.deepEqual(parseSupplierOrderHistoryBySupplier("nope"), []);
});

test("parses list, history and gross catalog prices", () => {
  const catalog = parseSupplierOrderCatalog({
    items: [
      {
        catalog_id: "cat-1",
        item: { id: "item-1", name: "Bột mì 999 Cam" },
        product_name: "Bột mì 999 Cam (25kg)",
        po_unit: "kg",
        po_unit_factor: "1000",
        vat_rate: "8",
        list_price: "20840.00",
        list_price_includes_vat: true,
        list_price_source: "Phiếu xuất kho Phúc Thịnh ĐH19993 ngày 22/10/2026",
        list_price_updated_at: "2026-10-22T00:00:00Z",
        history_price: "19300.00",
        unit_price: "19296.30",
        unit_price_gross: "20840.00",
      },
    ],
  });
  assert.ok(catalog);
  assert.equal(catalog.items[0].listPrice, 20840);
  assert.equal(catalog.items[0].listPriceIncludesVat, true);
  assert.equal(catalog.items[0].listPriceSource?.includes("ĐH19993"), true);
  assert.equal(catalog.items[0].listPriceUpdatedAt, "2026-10-22T00:00:00Z");
  assert.equal(catalog.items[0].historyPrice, 19300);
  assert.equal(catalog.items[0].unitPrice, 19296.3);
  assert.equal(catalog.items[0].unitPriceGross, 20840);
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
  assert.equal(history[0].poStatus, null);
  assert.equal(history[0].receipt, null);
  assert.equal(history[0].payment, null);
});

test("parses the new supplier urgency fields from strings and missing values", () => {
  const suppliers = parseSupplierOrderSuppliers({
    suppliers: [
      {
        id: "sup-1",
        name: "Phúc Thịnh",
        email: "pt@example.test",
        has_email: true,
        item_count: "3",
        active_item_count: "3",
        need_order_count: "2",
        low_stock_count: "1",
        out_of_stock_count: "1",
        last_activity_at: "2026-11-01T00:00:00Z",
        locations: ["q7", "tan_tao"],
        urgency_rank: "1",
        last_order: { po_number: "PO-1", sent_at: "2026-10-21T00:00:00Z" },
        unpaid_count: "2",
      },
      {
        id: "sup-2",
        name: "TV Food",
        email: null,
        item_count: 1,
      },
    ],
  });

  assert.equal(suppliers[0].hasEmail, true);
  assert.equal(suppliers[0].activeItemCount, 3);
  assert.equal(suppliers[0].needOrderCount, 2);
  assert.equal(suppliers[0].lowStockCount, 1);
  assert.equal(suppliers[0].outOfStockCount, 1);
  assert.equal(suppliers[0].lastActivityAt, "2026-11-01T00:00:00Z");
  assert.deepEqual(suppliers[0].locations, ["q7", "tan_tao"]);
  assert.equal(suppliers[0].urgencyRank, 1);

  assert.equal(suppliers[1].hasEmail, false);
  assert.equal(suppliers[1].activeItemCount, 1);
  assert.equal(suppliers[1].needOrderCount, 0);
  assert.equal(suppliers[1].lowStockCount, 0);
  assert.equal(suppliers[1].outOfStockCount, 0);
  assert.equal(suppliers[1].lastActivityAt, null);
  assert.deepEqual(suppliers[1].locations, []);
  assert.equal(suppliers[1].urgencyRank, 4);
});

test("parses catalog location and estimated, defaulting to Q7", () => {
  const catalog = parseSupplierOrderCatalog({
    items: [
      {
        catalog_id: "cat-tt",
        item: { id: "item-tt", name: "Bột mì Tân Tạo" },
        location: "tan_tao",
        estimated: true,
        stock: {
          on_hand: "1000",
          daily_usage: "100",
          days_left: "10",
        },
      },
      {
        catalog_id: "cat-q7",
        item: { id: "item-q7", name: "Bột mì Q7" },
      },
    ],
  });

  assert.ok(catalog);
  assert.equal(catalog.items[0].location, "tan_tao");
  assert.equal(catalog.items[0].estimated, true);
  assert.equal(catalog.items[0].stock.daysLeft, 10);
  assert.equal(catalog.items[1].location, "q7");
  assert.equal(catalog.items[1].estimated, false);
});

function urgencyFixture(): SupplierOrderSupplierListEntry[] {
  return [
    {
      id: "sup-normal",
      name: "Zeta",
      email: "zeta@example.test",
      hasEmail: true,
      itemCount: 1,
      activeItemCount: 1,
      needOrderCount: 0,
      lowStockCount: 0,
      outOfStockCount: 0,
      lastActivityAt: null,
      locations: ["q7"],
      urgencyRank: 4,
      lastOrder: null,
      unpaidCount: 0,
    },
    {
      id: "sup-need",
      name: "Beta",
      email: null,
      hasEmail: false,
      itemCount: 2,
      activeItemCount: 2,
      needOrderCount: 1,
      lowStockCount: 0,
      outOfStockCount: 0,
      lastActivityAt: "2026-11-01T00:00:00Z",
      locations: ["tan_tao"],
      urgencyRank: 2,
      lastOrder: null,
      unpaidCount: 0,
    },
    {
      id: "sup-out",
      name: "Alpha",
      email: "alpha@example.test",
      hasEmail: true,
      itemCount: 1,
      activeItemCount: 1,
      needOrderCount: 1,
      lowStockCount: 1,
      outOfStockCount: 1,
      lastActivityAt: "2026-11-02T00:00:00Z",
      locations: ["q7", "tan_tao"],
      urgencyRank: 1,
      lastOrder: null,
      unpaidCount: 0,
    },
    {
      id: "sup-low",
      name: "Gamma",
      email: "gamma@example.test",
      hasEmail: true,
      itemCount: 1,
      activeItemCount: 1,
      needOrderCount: 0,
      lowStockCount: 1,
      outOfStockCount: 0,
      lastActivityAt: null,
      locations: ["q7"],
      urgencyRank: 3,
      lastOrder: null,
      unpaidCount: 0,
    },
  ];
}

test("filters suppliers by urgency bucket and filter", () => {
  const entries = urgencyFixture();
  assert.equal(filterSupplierOrderSuppliers(entries, { filter: "all" }).length, 4);
  assert.deepEqual(
    filterSupplierOrderSuppliers(entries, { filter: "need_order" }).map((e) => e.id),
    ["sup-need", "sup-out"],
  );
  assert.deepEqual(
    filterSupplierOrderSuppliers(entries, { filter: "low_stock" }).map((e) => e.id),
    ["sup-out", "sup-low"],
  );
  assert.deepEqual(
    filterSupplierOrderSuppliers(entries, { filter: "no_email" }).map((e) => e.id),
    ["sup-need"],
  );
});

test("filters supplier search with and without Vietnamese diacritics", () => {
  const entries = urgencyFixture();
  entries[0].name = "Phúc Thịnh";
  entries[1].name = "Tân Tạo Foods";
  entries[2].name = "Bột mì Sài Gòn";
  entries[3].name = "TV Food";

  assert.equal(normalizeSupplierOrderSearch("Phúc Thịnh"), "phuc thinh");
  assert.equal(normalizeSupplierOrderSearch("Đông Á"), "dong a");

  assert.deepEqual(
    filterSupplierOrderSuppliers(entries, { query: "phuc thinh" }).map((e) => e.id),
    ["sup-normal"],
  );
  assert.deepEqual(
    filterSupplierOrderSuppliers(entries, { query: "PHÚC THỊNH" }).map((e) => e.id),
    ["sup-normal"],
  );
  assert.deepEqual(
    filterSupplierOrderSuppliers(entries, { query: "tan tao" }).map((e) => e.id),
    ["sup-need"],
  );
  assert.deepEqual(
    filterSupplierOrderSuppliers(entries, { query: "bot mi" }).map((e) => e.id),
    ["sup-out"],
  );
  assert.deepEqual(
    filterSupplierOrderSuppliers(entries, { query: "alpha@example" }).map((e) => e.id),
    ["sup-out"],
  );
  assert.deepEqual(
    filterSupplierOrderSuppliers(entries, { query: "phuc", filter: "need_order" }),
    [],
  );
});

test("sorts suppliers by urgency rank then Vietnamese name", () => {
  const entries = urgencyFixture();
  assert.deepEqual(
    sortSupplierOrderSuppliersByUrgency(entries).map((e) => e.id),
    ["sup-out", "sup-need", "sup-low", "sup-normal"],
  );
  const copy = [...entries];
  sortSupplierOrderSuppliersByUrgency(entries);
  assert.deepEqual(entries.map((e) => e.id), copy.map((e) => e.id));
});

test("keeps the old Phúc Thịnh / TV Food supplier payload shape parsing", () => {
  const legacy = {
    suppliers: [
      {
        id: "bc39ded3-755c-4b31-9e4c-d7729e009608",
        name: "Phúc Thịnh",
        email: "pt@example.test",
        item_count: 3,
        last_order: { po_number: "PO-000865", sent_at: "2026-10-30T00:00:00Z" },
        unpaid_count: 1,
      },
      {
        id: "9546bd80-18d7-4ec7-b0e5-de50798ea718",
        name: "TV Food",
        email: null,
        item_count: 1,
        last_order: null,
        unpaid_count: 0,
      },
    ],
  };
  const suppliers = parseSupplierOrderSuppliers(legacy);

  assert.equal(suppliers[0].id, "bc39ded3-755c-4b31-9e4c-d7729e009608");
  assert.equal(suppliers[0].name, "Phúc Thịnh");
  assert.equal(suppliers[0].email, "pt@example.test");
  assert.equal(suppliers[0].itemCount, 3);
  assert.equal(suppliers[0].lastOrder?.poNumber, "PO-000865");
  assert.equal(suppliers[0].unpaidCount, 1);
  assert.equal(suppliers[0].activeItemCount, 3);
  assert.equal(suppliers[0].hasEmail, true);
  assert.equal(suppliers[0].urgencyRank, 4);
  assert.deepEqual(suppliers[0].locations, []);

  assert.equal(suppliers[1].id, "9546bd80-18d7-4ec7-b0e5-de50798ea718");
  assert.equal(suppliers[1].email, null);
  assert.equal(suppliers[1].itemCount, 1);
  assert.equal(suppliers[1].lastOrder, null);
  assert.equal(suppliers[1].hasEmail, false);
});
