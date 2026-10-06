import assert from "node:assert/strict";
import test from "node:test";

import {
  FINANCE_ZALO_EVENT_TYPES,
  formatFinanceZaloMessage,
  formatGoodsReceiptReceivedMessage,
  formatGoodsReceiptShortMessage,
  formatPaymentRequestCreatedMessage,
  formatPaymentRequestPaidMessage,
  formatVnd,
  goodsReceiptDeepLink,
  paymentRequestDeepLink,
} from "./finance-zalo-notification.ts";

const PAYMENT_REQUEST = {
  id: "11111111-1111-1111-1111-111111111111",
  requestNumber: "PC-20261006-0001",
  supplierName: "Công ty TNHH Bột Mì Sài Gòn",
  amount: 41_006_300,
  purchaseOrderCode: "PO-20261001-0007",
  goodsReceiptCode: "GRN-20261002-0003",
};

const GOODS_RECEIPT = {
  id: "22222222-2222-2222-2222-222222222222",
  receiptNumber: "GRN-20261002-0003",
  supplierName: "Công ty TNHH Bột Mì Sài Gòn",
  purchaseOrderCode: "PO-20261001-0007",
  shortLineCount: 2,
};

test("formats VND amounts with Vietnamese separators", () => {
  assert.equal(formatVnd(41_006_300), "41.006.300 đ");
  assert.equal(formatVnd(0), "0 đ");
  assert.equal(formatVnd(null), "Chưa xác định");
});

test("builds deep links for payment requests and goods receipts", () => {
  assert.equal(
    paymentRequestDeepLink(PAYMENT_REQUEST.id),
    "https://ai.banhmique.vn/payment-requests?id=11111111-1111-1111-1111-111111111111",
  );
  assert.equal(
    goodsReceiptDeepLink(GOODS_RECEIPT.id),
    "https://ai.banhmique.vn/goods-receipts?id=22222222-2222-2222-2222-222222222222",
  );
});

test("formats the new payment request notice", () => {
  const message = formatPaymentRequestCreatedMessage(PAYMENT_REQUEST);
  assert.match(message, /💳 DUYỆT CHI MỚI/);
  assert.match(message, /Mã duyệt chi: PC-20261006-0001/);
  assert.match(message, /Nhà cung cấp: Công ty TNHH Bột Mì Sài Gòn/);
  assert.match(message, /Số tiền: 41\.006\.300 đ/);
  assert.match(message, /PO: PO-20261001-0007/);
  assert.match(message, /Phiếu nhận: GRN-20261002-0003/);
  assert.match(message, /payment-requests\?id=11111111-1111-1111-1111-111111111111/);
  assert.match(message, /Trạng thái: chờ duyệt chi/);
});

test("formats the approved + paid UNC notice", () => {
  const message = formatPaymentRequestPaidMessage(PAYMENT_REQUEST);
  assert.match(message, /✅ ĐÃ CHI BẰNG UNC/);
  assert.match(message, /Trạng thái: đã duyệt và đã thanh toán/);
  assert.match(message, /Số tiền: 41\.006\.300 đ/);
  assert.doesNotMatch(message, /DUYỆT CHI MỚI/);
});

test("formats received and short goods receipt notices", () => {
  const received = formatGoodsReceiptReceivedMessage(GOODS_RECEIPT);
  assert.match(received, /📦 ĐÃ NHẬN HÀNG/);
  assert.match(received, /Phiếu nhận: GRN-20261002-0003/);
  assert.match(received, /PO: PO-20261001-0007/);
  assert.match(received, /goods-receipts\?id=22222222-2222-2222-2222-222222222222/);
  assert.doesNotMatch(received, /Số dòng thiếu/);

  const short = formatGoodsReceiptShortMessage(GOODS_RECEIPT);
  assert.match(short, /⚠️ NHẬN HÀNG THIẾU/);
  assert.match(short, /Số dòng thiếu: 2/);
});

test("never leaks a bank account number or image payload", () => {
  const withAccount = {
    ...PAYMENT_REQUEST,
    beneficiaryAccount: "1234567890123",
    bankAccountNumber: "9704229200000000",
  };
  const messages = [
    formatPaymentRequestCreatedMessage(withAccount),
    formatPaymentRequestPaidMessage(withAccount),
    formatGoodsReceiptReceivedMessage(GOODS_RECEIPT),
    formatGoodsReceiptShortMessage(GOODS_RECEIPT),
  ];
  for (const message of messages) {
    assert.doesNotMatch(message, /1234567890123/);
    assert.doesNotMatch(message, /9704229200000000/);
    assert.doesNotMatch(message, /data:image|base64|số tài khoản/i);
  }
});

test("dispatches all four event types from one entry point", () => {
  assert.deepEqual(FINANCE_ZALO_EVENT_TYPES, [
    "payment_request_created",
    "payment_request_paid",
    "goods_receipt_received",
    "goods_receipt_short",
  ]);
  assert.match(
    formatFinanceZaloMessage("payment_request_created", PAYMENT_REQUEST),
    /DUYỆT CHI MỚI/,
  );
  assert.match(
    formatFinanceZaloMessage("payment_request_paid", PAYMENT_REQUEST),
    /ĐÃ CHI BẰNG UNC/,
  );
  assert.match(
    formatFinanceZaloMessage("goods_receipt_received", GOODS_RECEIPT),
    /ĐÃ NHẬN HÀNG/,
  );
  assert.match(
    formatFinanceZaloMessage("goods_receipt_short", GOODS_RECEIPT),
    /NHẬN HÀNG THIẾU/,
  );
  assert.throws(
    () => formatFinanceZaloMessage("unknown" as never, PAYMENT_REQUEST),
    /Unknown finance Zalo event type/,
  );
});
