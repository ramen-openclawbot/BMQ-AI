import assert from "node:assert/strict";
import test from "node:test";

import {
  DEALER_AWAITING_PAYMENT_CONFIRM_CODE,
  DEALER_AWAITING_PAYMENT_CONFIRM_MESSAGE,
  DEALER_AWAITING_SLIP_CODE,
  DEALER_AWAITING_SLIP_MESSAGE,
  dealerOnboardingBlock,
  isDealerAwaitingPaymentConfirm,
  isDealerAwaitingSlip,
  normalizeDealerOnboardingStatus,
} from "./dealer-onboarding.ts";

test("waiting_slip is blocked with the stable server code and Vietnamese reminder", () => {
  const customer = { dealer_onboarding_status: "waiting_slip" };
  assert.equal(isDealerAwaitingSlip(customer), true);
  assert.deepEqual(dealerOnboardingBlock(customer), {
    success: false,
    code: DEALER_AWAITING_SLIP_CODE,
    error: DEALER_AWAITING_SLIP_MESSAGE,
  });
  assert.equal(DEALER_AWAITING_SLIP_CODE, "dealer_awaiting_bank_slip");
  assert.equal(
    DEALER_AWAITING_SLIP_MESSAGE,
    "Tài khoản đang chờ bank slip. Vui lòng upload bank slip để bắt đầu đặt bánh.",
  );
});

test("slip_submitted is blocked while accounting confirms the transfer", () => {
  const customer = { dealer_onboarding_status: "slip_submitted" };
  assert.equal(isDealerAwaitingPaymentConfirm(customer), true);
  assert.equal(isDealerAwaitingSlip(customer), false);
  assert.deepEqual(dealerOnboardingBlock(customer), {
    success: false,
    code: DEALER_AWAITING_PAYMENT_CONFIRM_CODE,
    error: DEALER_AWAITING_PAYMENT_CONFIRM_MESSAGE,
  });
  assert.equal(DEALER_AWAITING_PAYMENT_CONFIRM_CODE, "dealer_awaiting_payment_confirm");
  assert.ok(DEALER_AWAITING_PAYMENT_CONFIRM_MESSAGE.includes("xác nhận tiền chuyển khoản"));
});

test("legacy null and active customers keep ordering", () => {
  assert.equal(isDealerAwaitingSlip({ dealer_onboarding_status: null }), false);
  assert.equal(dealerOnboardingBlock({ dealer_onboarding_status: null }), null);
  assert.equal(isDealerAwaitingSlip({ dealer_onboarding_status: "active" }), false);
  assert.equal(isDealerAwaitingPaymentConfirm({ dealer_onboarding_status: "active" }), false);
  assert.equal(dealerOnboardingBlock({ dealer_onboarding_status: "active" }), null);
  assert.equal(isDealerAwaitingSlip(null), false);
  assert.equal(dealerOnboardingBlock(undefined), null);
});

test("unknown onboarding values are treated as a legacy customer", () => {
  assert.equal(normalizeDealerOnboardingStatus("waiting_slip"), "waiting_slip");
  assert.equal(normalizeDealerOnboardingStatus("slip_submitted"), "slip_submitted");
  assert.equal(normalizeDealerOnboardingStatus("active"), "active");
  assert.equal(normalizeDealerOnboardingStatus("something_else"), null);
  assert.equal(normalizeDealerOnboardingStatus(null), null);
});
