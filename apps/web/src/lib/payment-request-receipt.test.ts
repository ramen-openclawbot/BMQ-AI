import assert from "node:assert/strict";
import test from "node:test";

import {
  isReceiptRequired,
  paymentRequestCompletion,
  paymentRequestReceiptErrorCode,
  type PaymentRequestReceiptInput,
} from "./payment-request-receipt.ts";

const request = (overrides: Partial<PaymentRequestReceiptInput> = {}): PaymentRequestReceiptInput => ({
  requires_receipt: true,
  delivery_status: "pending",
  invoice_created: false,
  payment_status: "unpaid",
  ...overrides,
});

test("legacy rows without requires_receipt keep the delivery + invoice flow", () => {
  const legacy = {
    delivery_status: "pending",
    invoice_created: false,
    payment_status: "unpaid",
  } as PaymentRequestReceiptInput;

  assert.equal(isReceiptRequired(legacy), true);
  assert.equal(isReceiptRequired({ requires_receipt: null }), true);
  assert.equal(isReceiptRequired(undefined), true);

  const completion = paymentRequestCompletion(legacy);
  assert.equal(completion.needsDelivery, true);
  assert.equal(completion.needsInvoice, true);
  assert.equal(completion.complete, false);
});

test("isReceiptRequired only turns off on an explicit false", () => {
  assert.equal(isReceiptRequired(request({ requires_receipt: true })), true);
  assert.equal(isReceiptRequired(request({ requires_receipt: false })), false);
});

test("goods requests paid without invoice are not complete", () => {
  const completion = paymentRequestCompletion(
    request({ requires_receipt: true, delivery_status: "delivered", invoice_created: false, payment_status: "paid" }),
  );

  assert.equal(completion.needsDelivery, false);
  assert.equal(completion.needsInvoice, true);
  assert.equal(completion.complete, false);
});

test("goods requests complete once paid, delivered and invoiced", () => {
  const completion = paymentRequestCompletion(
    request({ requires_receipt: true, delivery_status: "delivered", invoice_created: true, payment_status: "paid" }),
  );

  assert.deepEqual(completion, { needsDelivery: false, needsInvoice: false, complete: true });
});

test("no-receipt requests never need delivery or invoice and complete when paid", () => {
  const paid = paymentRequestCompletion(
    request({
      requires_receipt: false,
      delivery_status: "pending",
      invoice_created: false,
      payment_status: "paid",
    }),
  );
  assert.deepEqual(paid, { needsDelivery: false, needsInvoice: false, complete: true });

  const unpaid = paymentRequestCompletion(
    request({
      requires_receipt: false,
      delivery_status: "pending",
      invoice_created: false,
      payment_status: "unpaid",
    }),
  );
  assert.deepEqual(unpaid, { needsDelivery: false, needsInvoice: false, complete: false });
});

test("maps the toggle RPC errors to stable codes", () => {
  assert.equal(paymentRequestReceiptErrorCode({ message: "receipt_linked" }), "receipt_linked");
  assert.equal(paymentRequestReceiptErrorCode({ message: "reason_required" }), "reason_required");
  assert.equal(paymentRequestReceiptErrorCode({ message: "request_not_found" }), "request_not_found");
  assert.equal(paymentRequestReceiptErrorCode({ message: "invalid_status" }), "invalid_status");
  assert.equal(
    paymentRequestReceiptErrorCode({ message: "insufficient_privilege" }),
    "insufficient_privilege",
  );
  assert.equal(paymentRequestReceiptErrorCode(new Error("boom")), "unknown");
  assert.equal(paymentRequestReceiptErrorCode(null), "unknown");
});
