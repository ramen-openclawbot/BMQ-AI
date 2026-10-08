// Manual per-dealer order lock shared contract.
//
// The exact message is owned by the owner and rendered unchanged on the dealer
// portal, so every dealer Edge Function returns the same code / message pair.

export const DEALER_ORDER_LOCKED_CODE = "dealer_order_locked";
export const DEALER_ORDER_LOCKED_MESSAGE =
  "Đặt Hàng đang tạm khoá. Quý khách hàng vui lòng thanh toán công nợ để mở lại. Trân trọng.";

export type DealerOrderLockCustomer = {
  order_locked?: boolean | null;
} | null | undefined;

export function isDealerOrderLocked(customer: DealerOrderLockCustomer): boolean {
  return customer?.order_locked === true;
}

export function dealerOrderLockedResponseBody(): { error: string; code: string } {
  return {
    error: DEALER_ORDER_LOCKED_MESSAGE,
    code: DEALER_ORDER_LOCKED_CODE,
  };
}
