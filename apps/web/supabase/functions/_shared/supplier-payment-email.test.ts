import assert from "node:assert/strict";
import test from "node:test";

import { buildSupplierPaymentEmail } from "./supplier-payment-email.ts";

const baseInput = {
  supplierName: "TV Food",
  paymentNumber: "PAY-000123",
  amount: 1250000,
  paymentDate: "2026-10-28",
  poNumbers: ["PO-2026-001"],
  requestNumbers: ["PR-0001"],
  reference: "UNC-123456",
  test: false,
};

test("builds the production subject from the first PO", () => {
  const email = buildSupplierPaymentEmail(baseInput);
  assert.equal(
    email.subject,
    "BMQ thông báo thanh toán PO-2026-001 – TV Food",
  );
});

test("adds the [THỬ] prefix in test mode and falls back to the payment number", () => {
  const email = buildSupplierPaymentEmail({
    ...baseInput,
    poNumbers: [],
    test: true,
  });
  assert.equal(
    email.subject,
    "[THỬ] BMQ thông báo thanh toán PAY-000123 – TV Food",
  );
});

test("renders the Vietnamese payment details in text", () => {
  const email = buildSupplierPaymentEmail(baseInput);
  assert.ok(email.text.startsWith("Kính gửi TV Food,"));
  assert.ok(email.text.includes("Bánh Mì Que (BMQ) đã thanh toán cho Quý công ty:"));
  assert.ok(email.text.includes("Số tiền: 1.250.000 đ"));
  assert.ok(email.text.includes("Ngày chuyển: 28/10/2026"));
  assert.ok(email.text.includes("PO: PO-2026-001"));
  assert.ok(email.text.includes("Phiếu đề nghị: PR-0001"));
  assert.ok(email.text.includes("Mã giao dịch: UNC-123456"));
  assert.ok(email.text.includes("Ảnh UNC (ủy nhiệm chi) đính kèm email này."));
  assert.ok(email.text.includes("Mọi thắc mắc vui lòng trả lời email này."));
  assert.ok(email.text.includes("Trân trọng,"));
  assert.ok(email.text.includes("Bánh Mì Que"));
});

test("omits optional details that are missing", () => {
  const email = buildSupplierPaymentEmail({
    ...baseInput,
    paymentDate: null,
    poNumbers: [],
    requestNumbers: [],
    reference: null,
  });
  assert.ok(!email.text.includes("Ngày chuyển:"));
  assert.ok(!email.text.includes("PO:"));
  assert.ok(!email.text.includes("Phiếu đề nghị:"));
  assert.ok(!email.text.includes("Mã giao dịch:"));
  assert.ok(!email.html.includes("Ngày chuyển"));
  assert.ok(!email.html.includes("Mã giao dịch"));
});

test("escapes every interpolated HTML value", () => {
  const email = buildSupplierPaymentEmail({
    ...baseInput,
    supplierName: `<script>alert("x")</script>`,
    paymentNumber: `<b>PAY</b>`,
    poNumbers: [`<img src=x onerror=alert(1)>`],
    requestNumbers: [`<iframe>`],
    reference: `<b>REF</b>`,
  });

  assert.ok(!email.html.includes("<script>"));
  assert.ok(!email.html.includes("<iframe>"));
  assert.ok(!email.html.includes("<img src=x"));
  assert.ok(!email.html.includes("<b>REF</b>"));
  assert.ok(email.html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;"));
  assert.ok(email.html.includes("&lt;img src=x onerror=alert(1)&gt;"));
});
