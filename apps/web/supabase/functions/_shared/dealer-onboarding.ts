/**
 * Dealer onboarding state shared by the dealer portal Edge Functions.
 *
 * `waiting_slip` means the application was approved but the dealer has not
 * uploaded a bank slip yet. `slip_submitted` means the slip is uploaded and
 * accounting is confirming the transfer. Both block ordering on the server
 * while still allowing OTP login (is_active = true, order_locked = false).
 */
export const DEALER_AWAITING_SLIP_CODE = "dealer_awaiting_bank_slip";
export const DEALER_AWAITING_SLIP_MESSAGE =
  "Tài khoản đang chờ bank slip. Vui lòng upload bank slip để bắt đầu đặt bánh.";

export const DEALER_AWAITING_PAYMENT_CONFIRM_CODE = "dealer_awaiting_payment_confirm";
export const DEALER_AWAITING_PAYMENT_CONFIRM_MESSAGE =
  "BMQ đang xác nhận tiền chuyển khoản của bạn. Vui lòng chờ kế toán xác nhận để bắt đầu đặt bánh.";

export type DealerOnboardingStatus = "waiting_slip" | "slip_submitted" | "active" | null;

export type DealerOnboardingCustomer = {
  dealer_onboarding_status?: string | null;
} | null | undefined;

export function isDealerAwaitingSlip(customer: DealerOnboardingCustomer): boolean {
  return customer?.dealer_onboarding_status === "waiting_slip";
}

export function isDealerAwaitingPaymentConfirm(customer: DealerOnboardingCustomer): boolean {
  return customer?.dealer_onboarding_status === "slip_submitted";
}

export function normalizeDealerOnboardingStatus(value: unknown): DealerOnboardingStatus {
  return value === "waiting_slip" || value === "slip_submitted" || value === "active"
    ? value
    : null;
}

/**
 * Returns the exact 403 body when ordering must be blocked, otherwise null.
 * Kept pure so the order-submit guard is testable without an HTTP server.
 */
export function dealerOnboardingBlock(
  customer: DealerOnboardingCustomer,
): { success: false; code: string; error: string } | null {
  if (isDealerAwaitingSlip(customer)) {
    return {
      success: false,
      code: DEALER_AWAITING_SLIP_CODE,
      error: DEALER_AWAITING_SLIP_MESSAGE,
    };
  }
  if (isDealerAwaitingPaymentConfirm(customer)) {
    return {
      success: false,
      code: DEALER_AWAITING_PAYMENT_CONFIRM_CODE,
      error: DEALER_AWAITING_PAYMENT_CONFIRM_MESSAGE,
    };
  }
  return null;
}
