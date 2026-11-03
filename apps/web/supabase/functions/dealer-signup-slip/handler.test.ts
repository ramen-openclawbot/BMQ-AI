import assert from "node:assert/strict";
import test from "node:test";

import {
  DEALER_SIGNUP_SLIP_LIMIT_PER_HOUR,
  handleDealerSignupSlip,
  resolveSlipStatus,
  type DealerSignupSlipApplication,
  type DealerSignupSlipDeps,
  type DealerSignupSlipEmail,
  type DealerSignupSlipStore,
} from "./handler.ts";
import {
  dealerSlipTokenExpiresAt,
  generateDealerSlipToken,
  hashDealerSlipToken,
} from "../_shared/dealer-signup-review.ts";
import type { DealerSignupPaymentSettings } from "../_shared/dealer-signup-payment.ts";

const PDF_BYTES = new TextEncoder().encode("%PDF-1.4\nbank slip\n%%EOF");
const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0x00, 0x01]);

function application(
  overrides: Partial<DealerSignupSlipApplication> = {},
): DealerSignupSlipApplication {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    application_code: "DLM-20261103-0001",
    business_name: "Hộ kinh doanh Bánh mì Hồng",
    applicant_name: "Nguyễn Thị Hồng",
    email: "hong@example.test",
    phone: "0909123456",
    status: "approved_waiting_slip",
    slip_token_expires_at: dealerSlipTokenExpiresAt(new Date("2026-11-03T03:00:00.000Z")),
    crm_customer_id: "crm-customer-1",
    ...overrides,
  };
}

class MemoryStore implements DealerSignupSlipStore {
  tokenRows = new Map<string, DealerSignupSlipApplication>();
  waitingByCustomer = new Map<string, DealerSignupSlipApplication>();
  rateAllowed = true;
  uploads: Array<{ path: string; bytes: Uint8Array; contentType: string }> = [];
  activations: Array<{ id: string; path: string }> = [];
  lastErrors: Array<{ id: string; code: string }> = [];
  paymentSettings: DealerSignupPaymentSettings | null = null;

  async findByTokenHash(hash: string) {
    return this.tokenRows.get(hash) ?? null;
  }

  async findWaitingByCustomerId(customerId: string) {
    return this.waitingByCustomer.get(customerId) ?? null;
  }

  async checkRateLimit() {
    return this.rateAllowed
      ? { allowed: true, remaining: 9, retry_after_seconds: 0 }
      : { allowed: false, remaining: 0, retry_after_seconds: 120 };
  }

  async upload(path: string, bytes: Uint8Array, contentType: string) {
    this.uploads.push({ path, bytes, contentType });
  }

  async activate(applicationId: string, path: string) {
    this.activations.push({ id: applicationId, path });
    return {
      already_active: false,
      already_submitted: false,
      status: "slip_submitted",
    };
  }

  async setLastError(applicationId: string, code: string) {
    this.lastErrors.push({ id: applicationId, code });
  }
}

function makeDeps(
  store: MemoryStore,
  overrides: Partial<DealerSignupSlipDeps> = {},
): DealerSignupSlipDeps & {
  mails: DealerSignupSlipEmail[];
  logs: string[];
} {
  const mails: DealerSignupSlipEmail[] = [];
  const logs: string[] = [];
  return {
    store,
    resolveDealerSession: async () => null,
    sendEmail: async (email) => {
      mails.push(email);
      return { id: `mail-${mails.length}` };
    },
    loadPaymentSettings: async () => store.paymentSettings,
    env: (key) =>
      key === "DEALER_SIGNUP_BMQ_EMAIL"
        ? "bmq@example.test"
        : key === "DEALER_SIGNUP_IP_SALT"
        ? "test-salt"
        : undefined,
    now: () => new Date("2026-11-03T03:00:00.000Z"),
    logger: (code) => logs.push(code),
    mails,
    logs,
    ...overrides,
  } as DealerSignupSlipDeps & { mails: DealerSignupSlipEmail[]; logs: string[] };
}

function getRequest(token: string): Request {
  return new Request(`https://example.test/dealer-signup-slip?token=${encodeURIComponent(token)}`, {
    method: "GET",
  });
}

function uploadRequest(input: {
  token?: string;
  dealerToken?: string;
  file?: File;
  ip?: string;
}): Request {
  const form = new FormData();
  if (input.token) form.set("token", input.token);
  if (input.file) form.set("file", input.file);
  if (!input.file) form.set("file", new File([PDF_BYTES], "slip.pdf", { type: "application/pdf" }));
  const query = input.token ? `?token=${encodeURIComponent(input.token)}` : "";
  return new Request(`https://example.test/dealer-signup-slip${query}`, {
    method: "POST",
    headers: {
      "x-forwarded-for": input.ip || "203.0.113.10",
      ...(input.dealerToken ? { "x-dealer-session": input.dealerToken } : {}),
    },
    body: form,
  });
}

test("GET returns the business name and code for a valid token, never CCCD or phone", async () => {
  const store = new MemoryStore();
  const token = generateDealerSlipToken();
  store.tokenRows.set(await hashDealerSlipToken(token), application());
  const deps = makeDeps(store);

  const response = await handleDealerSignupSlip(getRequest(token), deps);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, "valid");
  assert.equal(body.business_name, "Hộ kinh doanh Bánh mì Hồng");
  assert.equal(body.application_code, "DLM-20261103-0001");
  assert.equal(body.cccd, undefined);
  assert.equal(body.phone, undefined);
});

test("GET reports expired, used and invalid tokens without exposing customer data", async () => {
  const store = new MemoryStore();
  const deps = makeDeps(store);

  const expiredToken = generateDealerSlipToken();
  store.tokenRows.set(
    await hashDealerSlipToken(expiredToken),
    application({ slip_token_expires_at: "2026-11-01T00:00:00.000Z" }),
  );
  const expired = await (await handleDealerSignupSlip(getRequest(expiredToken), deps)).json();
  assert.equal(expired.status, "expired");
  assert.equal(expired.can_upload, false);

  const usedToken = generateDealerSlipToken();
  store.tokenRows.set(await hashDealerSlipToken(usedToken), application({ status: "active" }));
  const used = await (await handleDealerSignupSlip(getRequest(usedToken), deps)).json();
  assert.equal(used.status, "used");
  assert.equal(used.can_upload, false);

  const invalid = await (await handleDealerSignupSlip(getRequest("not-a-real-token"), deps)).json();
  assert.equal(invalid.status, "invalid");
  assert.equal(invalid.business_name, undefined);

  assert.equal(resolveSlipStatus(null, new Date()), "invalid");
});

test("a valid token upload activates the dealer and notifies BMQ once", async () => {
  const store = new MemoryStore();
  const token = generateDealerSlipToken();
  const hash = await hashDealerSlipToken(token);
  store.tokenRows.set(hash, application());
  const deps = makeDeps(store);

  const response = await handleDealerSignupSlip(
    uploadRequest({
      token,
      file: new File([JPEG_BYTES], "slip.jpg", { type: "image/jpeg" }),
    }),
    deps,
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.status, "slip_submitted");
  assert.equal(body.already_submitted, false);
  assert.equal(body.email_sent, true);
  assert.equal(store.uploads.length, 1);
  assert.match(store.uploads[0].path, /^22222222-2222-4222-8222-222222222222\/slip-.+\.jpg$/);
  assert.equal(store.uploads[0].contentType, "image/jpeg");
  assert.equal(store.activations.length, 1);
  assert.equal(store.activations[0].path, store.uploads[0].path);
  assert.equal(deps.mails.length, 1);
  assert.ok(deps.mails[0].subject.includes("DLM-20261103-0001"));
  assert.ok(deps.mails[0].text.includes("chờ kế toán xác nhận"));
});

test("invalid, expired and used tokens are blocked before any upload", async () => {
  const store = new MemoryStore();
  const deps = makeDeps(store);

  const invalid = await handleDealerSignupSlip(
    uploadRequest({ token: "not-a-real-token" }),
    deps,
  );
  assert.equal(invalid.status, 404);
  assert.equal((await invalid.json()).code, "slip_token_invalid");

  const expiredToken = generateDealerSlipToken();
  store.tokenRows.set(
    await hashDealerSlipToken(expiredToken),
    application({ slip_token_expires_at: "2026-11-01T00:00:00.000Z" }),
  );
  const expired = await handleDealerSignupSlip(uploadRequest({ token: expiredToken }), deps);
  assert.equal(expired.status, 410);
  assert.equal((await expired.json()).code, "slip_token_expired");

  const usedToken = generateDealerSlipToken();
  store.tokenRows.set(await hashDealerSlipToken(usedToken), application({ status: "active" }));
  const used = await handleDealerSignupSlip(uploadRequest({ token: usedToken }), deps);
  assert.equal(used.status, 409);
  assert.equal((await used.json()).code, "slip_token_used");

  assert.equal(store.uploads.length, 0);
  assert.equal(store.activations.length, 0);
});

test("dealer session uploads only for the waiting application of that customer", async () => {
  const store = new MemoryStore();
  const deps = makeDeps(store, {
    resolveDealerSession: async (token) =>
      token === "dop_valid" ? { customer: { id: "crm-customer-1" } } : null,
  });

  const denied = await handleDealerSignupSlip(
    uploadRequest({ dealerToken: "dop_other_customer" }),
    deps,
  );
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).code, "dealer_session_invalid");

  const noWaiting = await handleDealerSignupSlip(
    uploadRequest({ dealerToken: "dop_valid" }),
    deps,
  );
  assert.equal(noWaiting.status, 403);
  assert.equal((await noWaiting.json()).code, "dealer_not_waiting_slip");
  assert.equal(store.uploads.length, 0);

  store.waitingByCustomer.set("crm-customer-1", application());
  const success = await handleDealerSignupSlip(
    uploadRequest({ dealerToken: "dop_valid" }),
    deps,
  );
  assert.equal(success.status, 200);
  assert.equal((await success.json()).status, "slip_submitted");
  assert.equal(store.activations.length, 1);
});

test("fake and oversized bank slips are blocked", async () => {
  const store = new MemoryStore();
  const token = generateDealerSlipToken();
  store.tokenRows.set(await hashDealerSlipToken(token), application());
  const deps = makeDeps(store);

  const fake = await handleDealerSignupSlip(
    uploadRequest({
      token,
      file: new File(["<?php echo 1; ?>"], "slip.pdf", { type: "application/pdf" }),
    }),
    deps,
  );
  assert.equal(fake.status, 400);
  assert.equal((await fake.json()).code, "invalid_file_type");

  const huge = new Uint8Array(10 * 1024 * 1024 + 1);
  huge.set(PDF_BYTES);
  const oversized = await handleDealerSignupSlip(
    uploadRequest({ token, file: new File([huge], "slip.pdf", { type: "application/pdf" }) }),
    deps,
  );
  assert.equal(oversized.status, 400);
  assert.equal((await oversized.json()).code, "file_too_large");

  assert.equal(store.uploads.length, 0);
});

test("rate limit and missing authentication are rejected", async () => {
  const store = new MemoryStore();
  const token = generateDealerSlipToken();
  store.tokenRows.set(await hashDealerSlipToken(token), application());
  const deps = makeDeps(store);

  const noAuth = await handleDealerSignupSlip(
    new Request("https://example.test/dealer-signup-slip", {
      method: "POST",
      body: new FormData(),
    }),
    deps,
  );
  assert.equal(noAuth.status, 401);
  assert.equal((await noAuth.json()).code, "dealer_auth_required");

  store.rateAllowed = false;
  const limited = await handleDealerSignupSlip(uploadRequest({ token }), deps);
  assert.equal(limited.status, 429);
  assert.equal((await limited.json()).code, "rate_limited");
  assert.equal(Number(limited.headers.get("Retry-After")), 120);
  assert.equal(DEALER_SIGNUP_SLIP_LIMIT_PER_HOUR, 10);
});

test("logs never contain the bank slip token or dealer session token", async () => {
  const store = new MemoryStore();
  const token = generateDealerSlipToken();
  store.tokenRows.set(await hashDealerSlipToken(token), application());
  const deps = makeDeps(store);

  await handleDealerSignupSlip(uploadRequest({ token }), deps);
  await handleDealerSignupSlip(getRequest(token), deps);

  assert.ok(deps.logs.every((line) => !line.includes(token)));
  assert.ok(deps.logs.every((line) => !line.includes("dop_")));
});

test("GET returns payment_info when configured and null when it is not", async () => {
  const store = new MemoryStore();
  const token = generateDealerSlipToken();
  store.tokenRows.set(await hashDealerSlipToken(token), application());
  const deps = makeDeps(store);

  const unconfigured = await (await handleDealerSignupSlip(getRequest(token), deps)).json();
  assert.equal(unconfigured.status, "valid");
  assert.equal(unconfigured.payment_info, null);

  store.paymentSettings = {
    bank_name: "Ngân hàng TMCP Kỹ thương Việt Nam",
    bank_bin: "970407",
    account_number: "19001234567890",
    account_name: "HỘ KINH DOANH BÁNH MÌ BMQ",
    amount_vnd: 1_000_000,
    transfer_note_template: "BMQ {application_code}",
  };

  const configured = await (await handleDealerSignupSlip(getRequest(token), deps)).json();
  assert.equal(configured.status, "valid");
  assert.equal(configured.payment_info.bank_name, "Ngân hàng TMCP Kỹ thương Việt Nam");
  assert.equal(configured.payment_info.bank_bin, "970407");
  assert.equal(configured.payment_info.account_number, "19001234567890");
  assert.equal(configured.payment_info.account_name, "HỘ KINH DOANH BÁNH MÌ BMQ");
  assert.equal(configured.payment_info.amount_vnd, 1_000_000);
  assert.equal(configured.payment_info.transfer_note, "BMQ DLM-20261103-0001");
  assert.match(configured.payment_info.qr_url, /^https:\/\/img\.vietqr\.io\/image\/970407-19001234567890-compact2\.png\?/);
});

test("GET reports slip_submitted and the upload is blocked while waiting for accounting", async () => {
  const store = new MemoryStore();
  const token = generateDealerSlipToken();
  store.tokenRows.set(
    await hashDealerSlipToken(token),
    application({ status: "slip_submitted" }),
  );
  const deps = makeDeps(store);

  const status = await (await handleDealerSignupSlip(getRequest(token), deps)).json();
  assert.equal(status.status, "slip_submitted");
  assert.equal(status.can_upload, false);
  assert.equal(status.success, true);

  const upload = await handleDealerSignupSlip(uploadRequest({ token }), deps);
  assert.equal(upload.status, 409);
  assert.equal((await upload.json()).code, "slip_already_submitted");
  assert.equal(store.uploads.length, 0);
});

test("POST is idempotent after a slip has already been submitted", async () => {
  const store = new MemoryStore();
  const token = generateDealerSlipToken();
  const hash = await hashDealerSlipToken(token);
  store.tokenRows.set(hash, application());
  store.activate = async (applicationId: string, path: string) => {
    store.activations.push({ id: applicationId, path });
    return {
      already_active: false,
      already_submitted: true,
      status: "slip_submitted",
    };
  };
  const deps = makeDeps(store);

  const response = await handleDealerSignupSlip(uploadRequest({ token }), deps);
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.equal(body.status, "slip_submitted");
  assert.equal(body.already_submitted, true);
  assert.equal(body.email_sent, false);
  assert.equal(deps.mails.length, 0);
});
