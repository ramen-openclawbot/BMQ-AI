import assert from "node:assert/strict";
import test from "node:test";

import {
  DEALER_SIGNUP_MAX_DOCUMENT_BYTES,
  DEALER_VERIFICATION_CODE_TTL_MINUTES,
  DEALER_VERIFICATION_MAX_ATTEMPTS,
  DEALER_VERIFICATION_RESEND_SECONDS,
  DEALER_VERIFICATION_TOKEN_TTL_MINUTES,
  buildDealerBankSlipUrl,
  buildDealerContractEmailInsert,
  buildDealerSignupApprovedEmail,
  buildDealerSignupRejectedEmail,
  buildDealerSignupSlipBmqEmail,
  buildDealerSignupSlipRejectedEmail,
  dealerContractDraftPath,
  dealerSignedContractPath,
  dealerSignupPublicBaseUrl,
  dealerSlipPath,
  dealerSlipTokenExpiresAt,
  dealerVerificationCodeExpiresAt,
  dealerVerificationTokenExpiresAt,
  detectDealerSignupDocumentFormat,
  escapeHtml,
  generateDealerSlipToken,
  generateDealerVerificationCode,
  hashDealerSlipToken,
  hashDealerVerificationCode,
  normalizeDealerVerificationEmail,
  normalizeDealerVerificationPhone,
  timingSafeEqualText,
  validateDealerSignupDocument,
} from "./dealer-signup-review.ts";
import { buildDealerPaymentInfo, type DealerSignupPaymentSettings } from "./dealer-signup-payment.ts";

const PDF_BYTES = new TextEncoder().encode("%PDF-1.4\nfake\n%%EOF");
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x01]);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const WEBP_BYTES = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);

test("slip token is 32 random bytes, base64url, hashed with SHA-256, valid 14 days", async () => {
  const first = generateDealerSlipToken();
  const second = generateDealerSlipToken();

  assert.notEqual(first, second);
  assert.match(first, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Math.floor((first.length * 6) / 8), 32);

  const hash = await hashDealerSlipToken(first);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(hash, first);
  assert.equal(hash, await hashDealerSlipToken(first));

  const now = new Date("2026-11-03T00:00:00.000Z");
  assert.equal(dealerSlipTokenExpiresAt(now), "2026-11-17T00:00:00.000Z");
});

test("document formats are detected from magic bytes, not file names", () => {
  assert.equal(detectDealerSignupDocumentFormat(PDF_BYTES), "pdf");
  assert.equal(detectDealerSignupDocumentFormat(JPEG_BYTES), "jpg");
  assert.equal(detectDealerSignupDocumentFormat(PNG_BYTES), "png");
  assert.equal(detectDealerSignupDocumentFormat(WEBP_BYTES), "webp");
  assert.equal(detectDealerSignupDocumentFormat(new Uint8Array([0x4d, 0x5a, 0x90])), null);
});

test("bank slip accepts PDF/JPEG/PNG/WebP and rejects fake or oversized files", () => {
  for (const bytes of [PDF_BYTES, JPEG_BYTES, PNG_BYTES, WEBP_BYTES]) {
    const result = validateDealerSignupDocument({ kind: "bank_slip", bytes });
    assert.equal(result.ok, true);
  }

  const fake = validateDealerSignupDocument({
    kind: "bank_slip",
    bytes: new TextEncoder().encode("<?php echo 1; ?>"),
  });
  assert.equal(fake.ok, false);
  assert.equal(fake.ok === false ? fake.code : "", "invalid_file_type");

  const empty = validateDealerSignupDocument({ kind: "bank_slip", bytes: new Uint8Array() });
  assert.equal(empty.ok === false ? empty.code : "", "file_required");

  const huge = new Uint8Array(DEALER_SIGNUP_MAX_DOCUMENT_BYTES + 1);
  huge.set(PDF_BYTES);
  const tooLarge = validateDealerSignupDocument({ kind: "bank_slip", bytes: huge });
  assert.equal(tooLarge.ok === false ? tooLarge.code : "", "file_too_large");
});

test("signed contract accepts PDF/JPEG/PNG but not WebP", () => {
  for (const bytes of [PDF_BYTES, JPEG_BYTES, PNG_BYTES]) {
    assert.equal(validateDealerSignupDocument({ kind: "signed_contract", bytes }).ok, true);
  }
  const webp = validateDealerSignupDocument({ kind: "signed_contract", bytes: WEBP_BYTES });
  assert.equal(webp.ok === false ? webp.code : "", "invalid_file_type");
});

test("approved email includes the login hint, application code and bank slip link", () => {
  const mail = buildDealerSignupApprovedEmail({
    applicantName: "Nguyễn Thị Hồng",
    applicationCode: "DLM-20261103-0001",
    businessName: "Hộ kinh doanh Bánh mì Hồng",
    slipToken: "abc_DEF-123",
    publicBaseUrl: "https://dathang.banhmique.vn",
  });

  assert.ok(mail.subject.includes("DLM-20261103-0001"));
  assert.ok(mail.text.includes("Nguyễn Thị Hồng"));
  assert.ok(mail.text.includes("dathang.banhmique.vn"));
  assert.ok(mail.text.includes("số điện thoại đã đăng ký"));
  assert.ok(mail.text.includes("14 ngày"));
  assert.ok(mail.text.includes("https://dathang.banhmique.vn/dai-ly-moi/bank-slip?token=abc_DEF-123"));
  assert.ok(mail.html.includes("dai-ly-moi/bank-slip?token=abc_DEF-123"));
});

test("customer input is HTML-escaped in every email", () => {
  const approved = buildDealerSignupApprovedEmail({
    applicantName: `<script>alert("x")</script>`,
    applicationCode: "DLM-20261103-0002",
    businessName: "Hộ <b>X</b>",
    slipToken: "token_abc",
    publicBaseUrl: "https://dathang.banhmique.vn",
  });
  assert.ok(!approved.html.includes("<script>"));
  assert.ok(approved.html.includes("&lt;script&gt;"));

  const rejected = buildDealerSignupRejectedEmail({
    applicantName: `A & B`,
    applicationCode: "DLM-20261103-0003",
    reason: `<img src=x onerror=alert(1)>`,
  });
  assert.ok(!rejected.html.includes("<img"));
  assert.ok(rejected.html.includes("&lt;img"));
  assert.ok(rejected.text.includes("Lý do: <img src=x onerror=alert(1)>"));
  assert.ok(rejected.subject.includes("DLM-20261103-0003"));
});

test("contract email insert carries a working slip link", () => {
  const insert = buildDealerContractEmailInsert({
    slipToken: "tok_123",
    publicBaseUrl: "https://dathang.banhmique.vn/",
  });
  assert.ok(insert.text.some((line) => line.includes("dai-ly-moi/bank-slip?token=tok_123")));
  assert.ok(insert.html.some((line) => line.includes("dai-ly-moi/bank-slip?token=tok_123")));
  assert.ok(insert.text.some((line) => line.includes("số điện thoại đã đăng ký")));
});

test("BMQ bank slip notification names the dealer and application", () => {
  const mail = buildDealerSignupSlipBmqEmail({
    applicantName: "Nguyễn Thị Hồng",
    businessName: "Hộ kinh doanh Bánh mì Hồng",
    applicationCode: "DLM-20261103-0004",
    phone: "0909123456",
  });
  assert.ok(mail.subject.includes("DLM-20261103-0004"));
  assert.ok(mail.text.includes("Hộ kinh doanh Bánh mì Hồng"));
  assert.ok(mail.text.includes("chờ kế toán xác nhận"));
});

test("public base URL and storage paths are stable and safe", () => {
  assert.equal(dealerSignupPublicBaseUrl(() => undefined), "https://dathang.banhmique.vn");
  assert.equal(
    dealerSignupPublicBaseUrl((key) =>
      key === "DEALER_SIGNUP_PUBLIC_BASE_URL" ? "https://staging.example.test/" : undefined
    ),
    "https://staging.example.test",
  );
  assert.equal(
    buildDealerBankSlipUrl("https://x.test", "a b"),
    "https://x.test/dai-ly-moi/bank-slip?token=a%20b",
  );
  assert.equal(dealerContractDraftPath("app-1"), "app-1/contract-draft.pdf");
  assert.equal(
    dealerSignedContractPath("app-1", "2026-11-03T00-00-00-000Z", "pdf"),
    "app-1/contract-signed-2026-11-03T00-00-00-000Z.pdf",
  );
  assert.equal(dealerSlipPath("app-1", "stamp", "jpg"), "app-1/slip-stamp.jpg");
  assert.equal(escapeHtml(`<&>"'`), "&lt;&amp;&gt;&quot;&#39;");
});

test("verification phone/email are normalized to 84... and lowercase", () => {
  assert.equal(normalizeDealerVerificationPhone("0909 123 456"), "84909123456");
  assert.equal(normalizeDealerVerificationPhone("+84 909 123 456"), "84909123456");
  assert.equal(normalizeDealerVerificationPhone("0084 909 123 456"), "84909123456");
  assert.equal(normalizeDealerVerificationPhone("123"), null);
  assert.equal(normalizeDealerVerificationEmail("  Hong@Example.Test "), "hong@example.test");
  assert.equal(normalizeDealerVerificationEmail("not-an-email"), null);
});

test("verification code is six digits, hashed and expires in 10 minutes", async () => {
  const code = generateDealerVerificationCode();
  assert.match(code, /^\d{6}$/);
  assert.equal(DEALER_VERIFICATION_CODE_TTL_MINUTES, 10);
  assert.equal(DEALER_VERIFICATION_TOKEN_TTL_MINUTES, 30);
  assert.equal(DEALER_VERIFICATION_MAX_ATTEMPTS, 5);
  assert.equal(DEALER_VERIFICATION_RESEND_SECONDS, 60);

  const now = new Date("2026-11-03T03:00:00.000Z");
  assert.equal(dealerVerificationCodeExpiresAt(now), "2026-11-03T03:10:00.000Z");
  assert.equal(dealerVerificationTokenExpiresAt(now), "2026-11-03T03:30:00.000Z");

  const hash = await hashDealerVerificationCode({
    sessionId: "11111111-1111-4111-8111-111111111111",
    channel: "phone",
    targetNormalized: "84909123456",
    code,
    secret: "test-secret",
  });
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.notEqual(hash, code);
  assert.equal(
    hash,
    await hashDealerVerificationCode({
      sessionId: "11111111-1111-4111-8111-111111111111",
      channel: "phone",
      targetNormalized: "84909123456",
      code,
      secret: "test-secret",
    }),
  );
  assert.notEqual(
    hash,
    await hashDealerVerificationCode({
      sessionId: "11111111-1111-4111-8111-111111111111",
      channel: "email",
      targetNormalized: "84909123456",
      code,
      secret: "test-secret",
    }),
  );
  assert.equal(timingSafeEqualText("abc", "abc"), true);
  assert.equal(timingSafeEqualText("abc", "abd"), false);
  assert.equal(timingSafeEqualText("abc", "abcd"), false);
});

test("approved email includes the transfer details and QR when configured", () => {
  const settings: DealerSignupPaymentSettings = {
    bank_name: "Ngân hàng TMCP Kỹ thương Việt Nam",
    bank_bin: "970407",
    account_number: "19001234567890",
    account_name: "HỘ KINH DOANH BÁNH MÌ BMQ",
    amount_vnd: 1_000_000,
    transfer_note_template: "BMQ {application_code}",
  };
  const mail = buildDealerSignupApprovedEmail({
    applicantName: "Nguyễn Thị Hồng",
    applicationCode: "DLM-20261103-0001",
    businessName: "Hộ kinh doanh Bánh mì Hồng",
    slipToken: "token_abc",
    publicBaseUrl: "https://dathang.banhmique.vn",
    paymentInfo: buildDealerPaymentInfo(settings, "DLM-20261103-0001"),
  });

  for (const value of [
    "19001234567890",
    "HỘ KINH DOANH BÁNH MÌ BMQ",
    "1.000.000 đ",
    "BMQ DLM-20261103-0001",
    "img.vietqr.io/image/970407-19001234567890-compact2.png",
  ]) {
    assert.ok(mail.text.includes(value), value);
    assert.ok(mail.html.includes(value), value);
  }
  assert.ok(mail.html.includes("<img"));
  assert.ok(mail.html.includes("accountName=H%E1%BB%98%20KINH%20DOANH"));

  const withoutPayment = buildDealerSignupApprovedEmail({
    applicantName: "Nguyễn Thị Hồng",
    applicationCode: "DLM-20261103-0002",
    businessName: "Hộ kinh doanh Bánh mì Hồng",
    slipToken: "token_abc",
    publicBaseUrl: "https://dathang.banhmique.vn",
    paymentInfo: null,
  });
  assert.ok(!withoutPayment.text.includes("Số tài khoản"));
  assert.ok(!withoutPayment.html.includes("<img"));
});

test("rejected slip email carries the reason, a fresh link and transfer details", () => {
  const mail = buildDealerSignupSlipRejectedEmail({
    applicantName: "Nguyễn Thị Hồng",
    applicationCode: "DLM-20261103-0001",
    businessName: "Hộ kinh doanh Bánh mì Hồng",
    reason: "Số tiền chuyển khoản chưa khớp",
    slipToken: "new_token_123",
    publicBaseUrl: "https://dathang.banhmique.vn",
    paymentInfo: null,
  });

  assert.ok(mail.subject.includes("DLM-20261103-0001"));
  assert.ok(mail.text.includes("Số tiền chuyển khoản chưa khớp"));
  assert.ok(mail.text.includes("new_token_123"));
  assert.ok(mail.text.includes("14 ngày"));
  assert.ok(mail.html.includes("new_token_123"));
});
