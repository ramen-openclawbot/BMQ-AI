import assert from "node:assert/strict";
import test from "node:test";

import {
  FINANCE_ZALO_EVENT_TYPES,
  formatAutoPurchaseDailySummaryMessage,
  formatAutoPurchaseOrderSentMessage,
  formatFinanceZaloMessage,
  formatGoodsReceiptReceivedMessage,
  formatGoodsReceiptShortMessage,
  formatPaymentCashAdvancedMessage,
  formatPaymentCashSettledMessage,
  formatPaymentRequestCreatedMessage,
  formatPaymentRequestPaidMessage,
  formatPaymentSubmissionMessage,
  formatSalaryPayoutAdvancedMessage,
  formatSalaryPayoutCompletedMessage,
  formatSalaryPayoutCreatedMessage,
  formatVnd,
  goodsReceiptDeepLink,
  paymentCashSettleDeepLink,
  paymentRequestDeepLink,
  paymentRequestDetailDeepLink,
  paymentSubmissionDeepLink,
  salaryPayoutDeepLink,
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

const PAYMENT_SUBMISSION = {
  id: "33333333-3333-3333-3333-333333333333",
  submissionNumber: "TC-261007-01",
  note: "Gấp trước 3h chiều",
  totalAmount: 41_006_300,
  items: [
    {
      supplierName: "Công ty TNHH Bột Mì Sài Gòn",
      requestNumber: "PC-20261006-0001",
      remainingAmount: 41_006_300,
    },
  ],
};

const PAYMENT_CASH = {
  id: "44444444-4444-4444-4444-444444444444",
  requestNumber: "PC-20261012-0007",
  requesterName: "Nguyễn Văn A",
  amount: 1_502_000,
};

const SALARY_PAYOUT = {
  id: "55555555-5555-4555-8555-555555555555",
  payoutNumber: "SAL-261012-01",
  periodName: "Kỳ lương tháng 09/2099",
  employeeCount: 16,
};

const AUTO_PURCHASE_ORDER = {
  id: "66666666-6666-4666-8666-666666666666",
  poNumber: "PO-20261014-0001",
  supplierName: "Công ty TNHH Bột Mì Sài Gòn",
  lines: [
    { name: "Bột mì", quantity: 4, unit: "bao", amount: 2_000_000 },
    { name: "Dầu ăn", quantity: 2, unit: "thùng", amount: 1_500_000 },
  ],
  totalAmount: 3_500_000,
};

const AUTO_PURCHASE_SUMMARY = {
  id: "77777777-7777-4777-8777-777777777777",
  draftPoCount: 2,
  totalAmount: 4_200_000,
  downgraded: [
    { name: "Bột mì", reasons: ["stale_stock_count"] },
    { name: "Dầu ăn", reasons: ["no_price", "over_daily_limit"] },
  ],
};

/** A VND-shaped digit group: 1.502.000 / 1,502,000 / 1502000đ / 1.502.000 VND. */
const VND_DIGIT_GROUP = /\d{1,3}(?:[.,]\d{3})+(?:\s*(?:đ|₫|vnd|vnđ))?/i;

const assertNoVndAmount = (message: string) => {
  assert.doesNotMatch(message, VND_DIGIT_GROUP);
  // Also refuse a bare "đ"/"VND" suffix on any digit run without separators.
  assert.doesNotMatch(message, /\d+\s*(?:đ|₫|vnd|vnđ)/i);
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

test("formats the Trình chi gấp submission notice", () => {
  const message = formatPaymentSubmissionMessage(PAYMENT_SUBMISSION);
  assert.match(message, /📋 TRÌNH CHI GẤP TC-261007-01/);
  assert.match(message, /1 phiếu · Tổng 41\.006\.300 đ/);
  assert.match(message, /• Công ty TNHH Bột Mì Sài Gòn – PC-20261006-0001: 41\.006\.300 đ/);
  assert.match(message, /Gấp trước 3h chiều/);
  assert.match(
    message,
    /payment-requests\/submissions\/33333333-3333-3333-3333-333333333333/,
  );
  assert.equal(
    paymentSubmissionDeepLink(PAYMENT_SUBMISSION.id),
    "https://ai.banhmique.vn/payment-requests/submissions/33333333-3333-3333-3333-333333333333",
  );
});

test("caps the submission notice at five request lines", () => {
  const items = Array.from({ length: 8 }, (_, index) => ({
    supplierName: `NCC ${index + 1}`,
    requestNumber: `PC-20261006-000${index + 1}`,
    remainingAmount: 1_000_000 * (index + 1),
  }));
  const message = formatPaymentSubmissionMessage({
    ...PAYMENT_SUBMISSION,
    totalAmount: 36_000_000,
    note: null,
    items,
  });
  assert.match(message, /8 phiếu · Tổng 36\.000\.000 đ/);
  assert.match(message, /• NCC 5 – PC-20261006-0005/);
  assert.doesNotMatch(message, /• NCC 6 –/);
  assert.match(message, /… và 3 phiếu khác/);
  assert.doesNotMatch(message, /Gấp trước/);
});

test("formats the cash advance notice with the settle link", () => {
  const message = formatPaymentCashAdvancedMessage(PAYMENT_CASH);
  assert.match(message, /💵 TẠM ỨNG TIỀN MẶT/);
  assert.match(message, /Mã duyệt chi: PC-20261012-0007/);
  assert.match(message, /Người đề nghị: Nguyễn Văn A/);
  assert.match(message, /Số tiền: 1\.502\.000 đ/);
  assert.match(
    message,
    /payment-requests\/cash-settle\/44444444-4444-4444-4444-444444444444/,
  );
  assert.equal(
    paymentCashSettleDeepLink(PAYMENT_CASH.id),
    "https://ai.banhmique.vn/payment-requests/cash-settle/44444444-4444-4444-4444-444444444444",
  );
});

test("formats the cash settled notice with the detail link", () => {
  const message = formatPaymentCashSettledMessage(PAYMENT_CASH);
  assert.match(message, /✅ HOÀN TẤT CHI TIỀN MẶT/);
  assert.match(message, /Mã duyệt chi: PC-20261012-0007/);
  assert.match(message, /Người đề nghị: Nguyễn Văn A/);
  assert.match(message, /Số tiền: 1\.502\.000 đ/);
  assert.equal(
    paymentRequestDetailDeepLink(PAYMENT_CASH.id),
    "https://ai.banhmique.vn/payment-requests?id=44444444-4444-4444-4444-444444444444",
  );
  assert.match(message, /payment-requests\?id=44444444-4444-4444-4444-444444444444/);
  assert.doesNotMatch(message, /cash-settle/);
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
    formatPaymentSubmissionMessage(PAYMENT_SUBMISSION),
    formatPaymentCashAdvancedMessage({ ...PAYMENT_CASH, beneficiaryAccount: "1234567890123" } as never),
    formatPaymentCashSettledMessage(PAYMENT_CASH),
  ];
  for (const message of messages) {
    assert.doesNotMatch(message, /1234567890123/);
    assert.doesNotMatch(message, /9704229200000000/);
    assert.doesNotMatch(message, /data:image|base64|số tài khoản/i);
  }
});

test("formats the three salary payout notices without any amount", () => {
  const created = formatSalaryPayoutCreatedMessage(SALARY_PAYOUT);
  assert.match(created, /CHI LƯƠNG/);
  assert.match(created, /Mã phiếu: SAL-261012-01/);
  assert.match(created, /Kỳ lương: Kỳ lương tháng 09\/2099/);
  assert.match(created, /Số nhân viên: 16/);
  assert.match(
    created,
    /salary-payouts\/55555555-5555-4555-8555-555555555555/,
  );
  assert.equal(
    salaryPayoutDeepLink(SALARY_PAYOUT.id),
    "https://ai.banhmique.vn/salary-payouts/55555555-5555-4555-8555-555555555555",
  );
  assertNoVndAmount(created);

  const advanced = formatSalaryPayoutAdvancedMessage(SALARY_PAYOUT);
  assert.match(advanced, /CHI LƯƠNG — ĐÃ NHẬN TIỀN MẶT/);
  assert.match(advanced, /SAL-261012-01/);
  assertNoVndAmount(advanced);

  const completed = formatSalaryPayoutCompletedMessage(SALARY_PAYOUT);
  assert.match(completed, /CHI LƯƠNG — HOÀN TẤT/);
  assert.match(completed, /SAL-261012-01/);
  assertNoVndAmount(completed);
});

test("salary notices never print an amount even when the input carries one", () => {
  const tainted = {
    ...SALARY_PAYOUT,
    totalAmount: 41_006_300,
    netPay: 1_502_000,
    amount: 9_999_999,
  } as never;
  for (const message of [
    formatSalaryPayoutCreatedMessage(tainted),
    formatSalaryPayoutAdvancedMessage(tainted),
    formatSalaryPayoutCompletedMessage(tainted),
  ]) {
    assertNoVndAmount(message);
    assert.doesNotMatch(message, /41\.006\.300|1\.502\.000|9\.999\.999/);
    assert.doesNotMatch(message, /Tổng|Số tiền/);
  }
});

test("formats the auto purchase PO and daily summary notices", () => {
  const sent = formatAutoPurchaseOrderSentMessage(AUTO_PURCHASE_ORDER);
  assert.match(sent, /🧾 ĐƠN HÀNG TỰ ĐỘNG/);
  assert.match(sent, /Nhà cung cấp: Công ty TNHH Bột Mì Sài Gòn/);
  assert.match(sent, /Số PO: PO-20261014-0001/);
  assert.match(sent, /• Bột mì: 4 bao – 2\.000\.000 đ/);
  assert.match(sent, /• Dầu ăn: 2 thùng – 1\.500\.000 đ/);
  assert.match(sent, /Tổng tiền: 3\.500\.000 đ/);
  assert.match(sent, /Vui lòng chuyển cho nhà cung cấp/);

  const summary = formatAutoPurchaseDailySummaryMessage(AUTO_PURCHASE_SUMMARY);
  assert.match(summary, /📋 TỔNG HỢP ĐẶT HÀNG TỰ ĐỘNG/);
  assert.match(summary, /Số PO nháp chờ duyệt: 2/);
  assert.match(summary, /Tổng tiền: 4\.200\.000 đ/);
  assert.match(summary, /Mặt hàng bị hạ cấp:/);
  assert.match(summary, /• Bột mì: kiểm kê tồn kho đã cũ/);
  assert.match(summary, /• Dầu ăn: chưa có giá mua gần nhất, vượt hạn mức trong ngày/);
});

test("dispatches all finance event types from one entry point", () => {
  assert.deepEqual(FINANCE_ZALO_EVENT_TYPES, [
    "payment_request_created",
    "payment_request_paid",
    "goods_receipt_received",
    "goods_receipt_short",
    "payment_submission_created",
    "payment_cash_advanced",
    "payment_cash_settled",
    "salary_payout_created",
    "salary_payout_advanced",
    "salary_payout_completed",
    "auto_purchase_order_sent",
    "auto_purchase_daily_summary",
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
  assert.match(
    formatFinanceZaloMessage("payment_submission_created", PAYMENT_SUBMISSION),
    /TRÌNH CHI GẤP/,
  );
  assert.match(
    formatFinanceZaloMessage("payment_cash_advanced", PAYMENT_CASH),
    /TẠM ỨNG TIỀN MẶT/,
  );
  assert.match(
    formatFinanceZaloMessage("payment_cash_settled", PAYMENT_CASH),
    /HOÀN TẤT CHI TIỀN MẶT/,
  );
  assert.match(
    formatFinanceZaloMessage("salary_payout_created", SALARY_PAYOUT),
    /CHI LƯƠNG/,
  );
  assert.match(
    formatFinanceZaloMessage("salary_payout_advanced", SALARY_PAYOUT),
    /ĐÃ NHẬN TIỀN MẶT/,
  );
  assert.match(
    formatFinanceZaloMessage("salary_payout_completed", SALARY_PAYOUT),
    /HOÀN TẤT/,
  );
  assert.match(
    formatFinanceZaloMessage("auto_purchase_order_sent", AUTO_PURCHASE_ORDER),
    /ĐƠN HÀNG TỰ ĐỘNG/,
  );
  assert.match(
    formatFinanceZaloMessage("auto_purchase_daily_summary", AUTO_PURCHASE_SUMMARY),
    /TỔNG HỢP ĐẶT HÀNG TỰ ĐỘNG/,
  );
  assert.throws(
    () => formatFinanceZaloMessage("unknown" as never, PAYMENT_REQUEST),
    /Unknown finance Zalo event type/,
  );
});
