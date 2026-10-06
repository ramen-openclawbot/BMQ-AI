// Pure helpers for "Phiếu chi không nhập kho" (VAT, thuế, dịch vụ) — server side.
// No Supabase / React imports so the completion rules stay unit-testable and can
// be shared by the detail view and the list cue without extra coupling.
//
// A request that does not require a receipt never needs a delivery nor an
// invoice: it is complete as soon as it is paid. Legacy rows without the
// requires_receipt field keep the old delivery + invoice flow (default true).

export interface PaymentRequestReceiptInput {
  /** Missing/null on legacy rows is treated as true. */
  requires_receipt?: boolean | null;
  delivery_status?: string | null;
  invoice_created?: boolean | null;
  payment_status?: string | null;
}

export interface PaymentRequestCompletion {
  needsDelivery: boolean;
  needsInvoice: boolean;
  complete: boolean;
}

/**
 * Whether the request still has to go through the goods-receipt + invoice
 * flow. A request created as không nhập kho (requires_receipt = false) and any
 * legacy row without the field is handled safely: only an explicit false turns
 * the flow off.
 */
export function isReceiptRequired(
  request: PaymentRequestReceiptInput | null | undefined,
): boolean {
  return request?.requires_receipt !== false;
}

/**
 * Completion state of one payment request:
 *   * no-receipt requests need neither delivery nor invoice; complete when paid;
 *   * receipt-required requests need delivery until delivered and an invoice
 *     until invoice_created is true; complete only when paid and both are done.
 */
export function paymentRequestCompletion(
  request: PaymentRequestReceiptInput | null | undefined,
): PaymentRequestCompletion {
  if (!request) {
    return { needsDelivery: false, needsInvoice: false, complete: false };
  }

  const paid = request.payment_status === "paid";

  if (!isReceiptRequired(request)) {
    return { needsDelivery: false, needsInvoice: false, complete: paid };
  }

  const needsDelivery = request.delivery_status !== "delivered";
  const needsInvoice = request.invoice_created !== true;

  return {
    needsDelivery,
    needsInvoice,
    complete: paid && !needsDelivery && !needsInvoice,
  };
}

// ---------------------------------------------------------------------------
// Error codes raised by public.set_payment_request_requires_receipt.
// ---------------------------------------------------------------------------
export type PaymentRequestReceiptErrorCode =
  | "insufficient_privilege"
  | "request_not_found"
  | "invalid_status"
  | "receipt_linked"
  | "reason_required"
  | "unknown";

const PAYMENT_REQUEST_RECEIPT_ERROR_CODES: PaymentRequestReceiptErrorCode[] = [
  "insufficient_privilege",
  "request_not_found",
  "invalid_status",
  "receipt_linked",
  "reason_required",
];

/**
 * Map a PostgREST / plpgsql error raised by the toggle RPC to a stable code the
 * UI can translate. Unknown failures fall back to "unknown".
 */
export function paymentRequestReceiptErrorCode(error: unknown): PaymentRequestReceiptErrorCode {
  const message =
    typeof error === "string"
      ? error
      : error && typeof error === "object" && "message" in error
        ? String((error as { message?: unknown }).message ?? "")
        : "";
  const found = PAYMENT_REQUEST_RECEIPT_ERROR_CODES.find((code) => message.includes(code));
  return found ?? "unknown";
}
