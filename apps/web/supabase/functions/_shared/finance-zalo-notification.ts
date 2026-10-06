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
  | "goods_receipt_short";

export const FINANCE_ZALO_EVENT_TYPES: FinanceZaloEventType[] = [
  "payment_request_created",
  "payment_request_paid",
  "goods_receipt_received",
  "goods_receipt_short",
];

export const PAYMENT_REQUESTS_DEEP_LINK = "https://ai.banhmique.vn/payment-requests";
export const GOODS_RECEIPTS_DEEP_LINK = "https://ai.banhmique.vn/goods-receipts";

export const paymentRequestDeepLink = (id: string) =>
  `${PAYMENT_REQUESTS_DEEP_LINK}?id=${encodeURIComponent(id)}`;

export const goodsReceiptDeepLink = (id: string) =>
  `${GOODS_RECEIPTS_DEEP_LINK}?id=${encodeURIComponent(id)}`;

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

export const formatFinanceZaloMessage = (
  eventType: FinanceZaloEventType,
  input: PaymentRequestNotificationInput | GoodsReceiptNotificationInput,
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
    default:
      throw new Error(`Unknown finance Zalo event type: ${String(eventType)}`);
  }
};
