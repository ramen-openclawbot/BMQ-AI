import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DEALER_ORDER_LOCKED_CODE,
  DEALER_ORDER_LOCKED_MESSAGE,
  dealerOrderLockedResponseBody,
  isDealerOrderLocked,
} from "./dealer-order-lock.ts";

Deno.test("exports the owner-approved lock code and message", () => {
  assertEquals(DEALER_ORDER_LOCKED_CODE, "dealer_order_locked");
  assertEquals(
    DEALER_ORDER_LOCKED_MESSAGE,
    "Đặt Hàng đang tạm khoá. Quý khách hàng vui lòng thanh toán công nợ để mở lại. Trân trọng.",
  );
});

Deno.test("isDealerOrderLocked only accepts the explicit locked flag", () => {
  assertEquals(isDealerOrderLocked({ order_locked: true }), true);
  assertEquals(isDealerOrderLocked({ order_locked: false }), false);
  assertEquals(isDealerOrderLocked({ order_locked: null }), false);
  assertEquals(isDealerOrderLocked({}), false);
  assertEquals(isDealerOrderLocked(null), false);
  assertEquals(isDealerOrderLocked(undefined), false);
});

Deno.test("dealerOrderLockedResponseBody returns the exact 423 payload", () => {
  assertEquals(dealerOrderLockedResponseBody(), {
    error: DEALER_ORDER_LOCKED_MESSAGE,
    code: DEALER_ORDER_LOCKED_CODE,
  });
});
