/**
 * Pure Vietnamese text formatters for the finance Zalo OA outbox.
 *
 * Text only: no images, no bank account numbers, no provider secrets. The edge
 * worker reuses these formatters when it can rehydrate the source entity and
 * otherwise falls back to the locally stored outbox message_body.
 */

export type FinanceZaloEventType =
  | "payment_request_created"
  | "payment_request_paid"
  | "goods_receipt_received"
  | "goods_receipt_short"
  | "payment_submission_created"
  | "payment_cash_advanced"
  | "payment_cash_settled"
  | "salary_payout_created"
  | "salary_payout_advanced"
  | "salary_payout_completed";

export const FINANCE_ZALO_EVENT_TYPES: FinanceZaloEventType[] = [
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
];

export const PAYMENT_REQUESTS_DEEP_LINK = "https://ai.banhmique.vn/payment-requests";
export const PAYMENT_SUBMISSIONS_DEEP_LINK = "https://ai.banhmique.vn/payment-requests/submissions";
export const PAYMENT_CASH_SETTLE_DEEP_LINK = "https://ai.banhmique.vn/payment-requests/cash-settle";
export const GOODS_RECEIPTS_DEEP_LINK = "https://ai.banhmique.vn/goods-receipts";
export const SALARY_PAYOUTS_DEEP_LINK = "https://ai.banhmique.vn/salary-payouts";

export const paymentRequestDeepLink = (id: string) =>
  `${PAYMENT_REQUESTS_DEEP_LINK}?id=${encodeURIComponent(id)}`;

/** Detail link used by the completed-cash notice. */
export const paymentRequestDetailDeepLink = (id: string) =>
  `${PAYMENT_REQUESTS_DEEP_LINK}?id=${encodeURIComponent(id)}`;

export const paymentSubmissionDeepLink = (id: string) =>
  `${PAYMENT_SUBMISSIONS_DEEP_LINK}/${encodeURIComponent(id)}`;

export const paymentCashSettleDeepLink = (id: string) =>
  `${PAYMENT_CASH_SETTLE_DEEP_LINK}/${encodeURIComponent(id)}`;

export const goodsReceiptDeepLink = (id: string) =>
  `${GOODS_RECEIPTS_DEEP_LINK}?id=${encodeURIComponent(id)}`;

export const salaryPayoutDeepLink = (id: string) =>
  `${SALARY_PAYOUTS_DEEP_LINK}/${encodeURIComponent(id)}`;

/** Format a VND amount with Vietnamese thousands separators. */
export const formatVnd = (amount: number | null | undefined): string => {
  if (amount === null || amount === undefined) return "Chưa xác định";
  const value = Number(amount);
  if (!Number.isFinite(value)) return "Chưa xác định";
  return `${new Intl.NumberFormat("vi-VN").format(Math.round(value))} đ`;
};

const safeText = (value: string | null | undefined, fallback: string): string =>
  value && value.trim() ? value.trim() : fallback;

export type PaymentRequestNotificationInput = {
  id: string;
  requestNumber: string;
  supplierName?: string | null;
  amount?: number | null;
  purchaseOrderCode?: string | null;
  goodsReceiptCode?: string | null;
};

export type GoodsReceiptNotificationInput = {
  id: string;
  receiptNumber: string;
  supplierName?: string | null;
  purchaseOrderCode?: string | null;
  shortLineCount?: number | null;
};

export type PaymentSubmissionNotificationItem = {
  supplierName?: string | null;
  requestNumber: string;
  remainingAmount?: number | null;
};

export type PaymentSubmissionNotificationInput = {
  id: string;
  submissionNumber: string;
  note?: string | null;
  totalAmount?: number | null;
  items: PaymentSubmissionNotificationItem[];
};

export type PaymentCashNotificationInput = {
  id: string;
  requestNumber: string;
  requesterName?: string | null;
  amount?: number | null;
};

/**
 * Cash-salary payout notice. Deliberately carries no amount: only the payout
 * number, period name, employee count and the detail link.
 */
export type SalaryPayoutNotificationInput = {
  id: string;
  payoutNumber: string;
  periodName?: string | null;
  employeeCount?: number | null;
};

const PAYMENT_SUBMISSION_MAX_LINES = 5;

export const formatPaymentRequestCreatedMessage = (
  input: PaymentRequestNotificationInput,
): string => {
  const lines = [
    "💳 DUYỆT CHI MỚI",
    "",
    `Mã duyệt chi: ${safeText(input.requestNumber, "Chưa có mã")}`,
    `Nhà cung cấp: ${safeText(input.supplierName, "Chưa xác định")}`,
    `Số tiền: ${formatVnd(input.amount)}`,
  ];
  if (input.purchaseOrderCode?.trim()) lines.push(`PO: ${input.purchaseOrderCode.trim()}`);
  if (input.goodsReceiptCode?.trim()) lines.push(`Phiếu nhận: ${input.goodsReceiptCode.trim()}`);
  lines.push("", "Trạng thái: chờ duyệt chi", "", `Xem chi tiết: ${paymentRequestDeepLink(input.id)}`);
  return lines.join("\n");
};

export const formatPaymentRequestPaidMessage = (
  input: PaymentRequestNotificationInput,
): string => {
  const lines = [
    "✅ ĐÃ CHI BẰNG UNC",
    "",
    `Mã duyệt chi: ${safeText(input.requestNumber, "Chưa có mã")}`,
    `Nhà cung cấp: ${safeText(input.supplierName, "Chưa xác định")}`,
    `Số tiền: ${formatVnd(input.amount)}`,
    "Trạng thái: đã duyệt và đã thanh toán",
  ];
  if (input.purchaseOrderCode?.trim()) lines.push(`PO: ${input.purchaseOrderCode.trim()}`);
  if (input.goodsReceiptCode?.trim()) lines.push(`Phiếu nhận: ${input.goodsReceiptCode.trim()}`);
  lines.push("", `Xem chi tiết: ${paymentRequestDeepLink(input.id)}`);
  return lines.join("\n");
};

export const formatGoodsReceiptReceivedMessage = (
  input: GoodsReceiptNotificationInput,
): string => {
  const lines = [
    "📦 ĐÃ NHẬN HÀNG",
    "",
    `Phiếu nhận: ${safeText(input.receiptNumber, "Chưa có mã")}`,
    `Nhà cung cấp: ${safeText(input.supplierName, "Chưa xác định")}`,
  ];
  if (input.purchaseOrderCode?.trim()) lines.push(`PO: ${input.purchaseOrderCode.trim()}`);
  lines.push("", `Xem chi tiết: ${goodsReceiptDeepLink(input.id)}`);
  return lines.join("\n");
};

export const formatGoodsReceiptShortMessage = (
  input: GoodsReceiptNotificationInput,
): string => {
  const shortCount = Number(input.shortLineCount);
  const lines = [
    "⚠️ NHẬN HÀNG THIẾU",
    "",
    `Phiếu nhận: ${safeText(input.receiptNumber, "Chưa có mã")}`,
    `Nhà cung cấp: ${safeText(input.supplierName, "Chưa xác định")}`,
  ];
  if (input.purchaseOrderCode?.trim()) lines.push(`PO: ${input.purchaseOrderCode.trim()}`);
  if (Number.isFinite(shortCount) && shortCount > 0) lines.push(`Số dòng thiếu: ${shortCount}`);
  lines.push("", `Xem chi tiết: ${goodsReceiptDeepLink(input.id)}`);
  return lines.join("\n");
};

/**
 * "Trình chi gấp" notice: header, one line per request (up to five) and the
 * submission deep link. Mirrors public.create_payment_submission's SQL body.
 */
export const formatPaymentSubmissionMessage = (
  input: PaymentSubmissionNotificationInput,
): string => {
  const items = Array.isArray(input.items) ? input.items : [];
  const count = items.length;
  const lines = [
    `📋 TRÌNH CHI GẤP ${safeText(input.submissionNumber, "Chưa có mã")}`,
    `${count} phiếu · Tổng ${formatVnd(input.totalAmount)}`,
  ];
  for (const item of items.slice(0, PAYMENT_SUBMISSION_MAX_LINES)) {
    lines.push(
      `• ${safeText(item.supplierName, "Chưa xác định")} – ${safeText(item.requestNumber, "Chưa có mã")}: ${formatVnd(item.remainingAmount)}`,
    );
  }
  if (count > PAYMENT_SUBMISSION_MAX_LINES) {
    lines.push(`… và ${count - PAYMENT_SUBMISSION_MAX_LINES} phiếu khác`);
  }
  if (input.note?.trim()) lines.push(input.note.trim());
  lines.push("", paymentSubmissionDeepLink(input.id));
  return lines.join("\n");
};

/**
 * "Tạm ứng tiền mặt" notice: the CEO paid cash to a staff member, who now has
 * to upload the receipts (cash-settle page).
 */
export const formatPaymentCashAdvancedMessage = (
  input: PaymentCashNotificationInput,
): string => {
  const lines = [
    "💵 TẠM ỨNG TIỀN MẶT",
    "",
    `Mã duyệt chi: ${safeText(input.requestNumber, "Chưa có mã")}`,
    `Người đề nghị: ${safeText(input.requesterName, "Chưa xác định")}`,
    `Số tiền: ${formatVnd(input.amount)}`,
    "",
    `Nộp chứng từ: ${paymentCashSettleDeepLink(input.id)}`,
  ];
  return lines.join("\n");
};

/** "Hoàn tất chi tiền mặt" notice: every item is covered by receipts. */
export const formatPaymentCashSettledMessage = (
  input: PaymentCashNotificationInput,
): string => {
  const lines = [
    "✅ HOÀN TẤT CHI TIỀN MẶT",
    "",
    `Mã duyệt chi: ${safeText(input.requestNumber, "Chưa có mã")}`,
    `Người đề nghị: ${safeText(input.requesterName, "Chưa xác định")}`,
    `Số tiền: ${formatVnd(input.amount)}`,
    "",
    `Xem chi tiết: ${paymentRequestDetailDeepLink(input.id)}`,
  ];
  return lines.join("\n");
};

/**
 * Shared cash-salary payout body. NEVER prints an amount: only the payout
 * number, period name, employee count and the detail link.
 */
const formatSalaryPayoutMessage = (
  title: string,
  input: SalaryPayoutNotificationInput,
): string => {
  const employeeCount = Number(input.employeeCount);
  const lines = [
    title,
    "",
    `Mã phiếu: ${safeText(input.payoutNumber, "Chưa có mã")}`,
    `Kỳ lương: ${safeText(input.periodName, "Chưa xác định")}`,
    `Số nhân viên: ${Number.isFinite(employeeCount) && employeeCount > 0 ? Math.trunc(employeeCount) : "Chưa xác định"}`,
    "",
    `Xem chi tiết: ${salaryPayoutDeepLink(input.id)}`,
  ];
  return lines.join("\n");
};

export const formatSalaryPayoutCreatedMessage = (
  input: SalaryPayoutNotificationInput,
): string => formatSalaryPayoutMessage("💰 CHI LƯƠNG", input);

export const formatSalaryPayoutAdvancedMessage = (
  input: SalaryPayoutNotificationInput,
): string => formatSalaryPayoutMessage("💵 CHI LƯƠNG — ĐÃ NHẬN TIỀN MẶT", input);

export const formatSalaryPayoutCompletedMessage = (
  input: SalaryPayoutNotificationInput,
): string => formatSalaryPayoutMessage("✅ CHI LƯƠNG — HOÀN TẤT", input);

export const formatFinanceZaloMessage = (
  eventType: FinanceZaloEventType,
  input:
    | PaymentRequestNotificationInput
    | GoodsReceiptNotificationInput
    | PaymentSubmissionNotificationInput
    | PaymentCashNotificationInput
    | SalaryPayoutNotificationInput,
): string => {
  switch (eventType) {
    case "payment_request_created":
      return formatPaymentRequestCreatedMessage(input as PaymentRequestNotificationInput);
    case "payment_request_paid":
      return formatPaymentRequestPaidMessage(input as PaymentRequestNotificationInput);
    case "goods_receipt_received":
      return formatGoodsReceiptReceivedMessage(input as GoodsReceiptNotificationInput);
    case "goods_receipt_short":
      return formatGoodsReceiptShortMessage(input as GoodsReceiptNotificationInput);
    case "payment_submission_created":
      return formatPaymentSubmissionMessage(input as PaymentSubmissionNotificationInput);
    case "payment_cash_advanced":
      return formatPaymentCashAdvancedMessage(input as PaymentCashNotificationInput);
    case "payment_cash_settled":
      return formatPaymentCashSettledMessage(input as PaymentCashNotificationInput);
    case "salary_payout_created":
      return formatSalaryPayoutCreatedMessage(input as SalaryPayoutNotificationInput);
    case "salary_payout_advanced":
      return formatSalaryPayoutAdvancedMessage(input as SalaryPayoutNotificationInput);
    case "salary_payout_completed":
      return formatSalaryPayoutCompletedMessage(input as SalaryPayoutNotificationInput);
    default:
      throw new Error(`Unknown finance Zalo event type: ${String(eventType)}`);
  }
};
