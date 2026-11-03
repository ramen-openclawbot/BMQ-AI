import assert from "node:assert/strict";
import test from "node:test";

import {
  handleDealerSignupSubmit,
  type DealerSignupEmail,
  type DealerSignupSubmitDeps,
} from "./handler.ts";
import type {
  DealerSignupApplication,
  DealerSignupStore,
  NewDealerSignupApplication,
} from "../_shared/dealer-signup-http.ts";
import type {
  DealerRecord,
  EligibilityDecision,
  EligibilityResult,
} from "../_shared/dealer-signup-distance.ts";

class MemoryStore implements DealerSignupStore {
  rows = new Map<string, DealerSignupApplication>();
  nextId = 1;
  updates: Array<{ id: string; patch: Partial<DealerSignupApplication> }> = [];
  rateLimitAllowed = true;
  approvalCalls: Array<Record<string, unknown>> = [];
  contractDraftCalls: Array<{ id: string; path: string }> = [];
  uploadedDrafts = new Map<string, Uint8Array>();

  async findByIdempotencyKey(key: string): Promise<DealerSignupApplication | null> {
    return this.rows.get(key) ?? null;
  }

  async insert(row: NewDealerSignupApplication): Promise<DealerSignupApplication> {
    if (this.rows.has(row.idempotency_key)) {
      throw Object.assign(new Error("duplicate key"), { code: "23505" });
    }
    const application: DealerSignupApplication = {
      ...row,
      id: `application-${this.nextId++}`,
      created_at: "2026-11-02T03:00:00.000Z",
      updated_at: "2026-11-02T03:00:00.000Z",
    };
    this.rows.set(row.idempotency_key, application);
    return application;
  }

  async update(id: string, patch: Partial<DealerSignupApplication>): Promise<void> {
    this.updates.push({ id, patch });
    for (const [key, application] of this.rows) {
      if (application.id !== id) continue;
      this.rows.set(key, { ...application, ...patch });
    }
  }

  async loadActiveDealers(): Promise<DealerRecord[]> {
    return [];
  }

  async checkRateLimit(): Promise<{ allowed: boolean; remaining: number; retry_after_seconds: number }> {
    return this.rateLimitAllowed
      ? { allowed: true, remaining: 4, retry_after_seconds: 0 }
      : { allowed: false, remaining: 0, retry_after_seconds: 120 };
  }
}

function decision(
  result: EligibilityResult,
  overrides: Partial<EligibilityDecision> = {},
): EligibilityDecision {
  return {
    result,
    nearest_dealer_customer_id: "dealer-1",
    nearest_dealer_name: "Phường Bến Thành, Quận 1",
    nearest_dealer_label: "Phường Bến Thành, Quận 1",
    nearest_distance_m: result === "too_close" ? 1500 : 2500,
    distance_provider: "osm_osrm_bike",
    reason_code: result === "manual_review" ? "dealer_location_missing" : null,
    unlocated_dealer_count: result === "manual_review" ? 1 : 0,
    ...overrides,
  };
}

const VALID_BODY = {
  applicant_name: "Nguyễn Thị Hồng",
  business_name: "Hộ kinh doanh Bánh mì Hồng",
  cccd: "079123456789",
  cccd_valid_until: "2035-06-30",
  phone: "0909 123 456",
  email: "hong@example.test",
  address_text: "12 Lê Lợi, Phường Bến Thành, Quận 1, TP.HCM",
  lat: 10.7769,
  lng: 106.7009,
  terms_accepted: true,
  idempotency_key: "idem-key-20261102",
};

function request(body: Record<string, unknown>, ip = "203.0.113.10"): Request {
  return new Request("https://example.test/dealer-signup-submit", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": ip,
    },
    body: JSON.stringify(body),
  });
}

function makeDeps(
  store: MemoryStore,
  eligibility: EligibilityResult,
  mails: DealerSignupEmail[],
  overrides: Partial<DealerSignupSubmitDeps> = {},
): DealerSignupSubmitDeps {
  return {
    store,
    evaluateRouteEligibility: async () => decision(eligibility),
    buildContractPdf: async () => new TextEncoder().encode("%PDF-1.4\nfake contract\n%%EOF"),
    loadContractAssets: async () => ({
      regular: new Uint8Array([1]),
      bold: new Uint8Array([2]),
    }),
    sendEmail: async (email) => {
      mails.push(email);
      return { id: `gmail-message-${mails.length}` };
    },
    approveSignup: async (input) => {
      store.approvalCalls.push(input as unknown as Record<string, unknown>);
      return {
        application_id: input.applicationId,
        application_code: "DLM-20261102-0001",
        status: "approved_waiting_slip",
        crm_customer_id: "crm-customer-1",
        already_approved: false,
      };
    },
    uploadContractDraft: async (applicationId, pdf) => {
      store.uploadedDrafts.set(applicationId, pdf);
      return `${applicationId}/contract-draft.pdf`;
    },
    setContractDraft: async (id, path) => {
      store.contractDraftCalls.push({ id, path });
    },
    now: () => new Date("2026-11-02T03:00:00.000Z"),
    env: (key) => key === "DEALER_SIGNUP_BMQ_EMAIL" ? "bmq@example.test" : undefined,
    logger: () => {},
    ...overrides,
  };
}

test("invalid customer data returns 400 and writes nothing", async () => {
  const store = new MemoryStore();
  const mails: DealerSignupEmail[] = [];
  const response = await handleDealerSignupSubmit(
    request({ ...VALID_BODY, email: "not-an-email" }),
    makeDeps(store, "eligible", mails),
  );

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.code, "invalid_email");
  assert.equal(store.rows.size, 0);
  assert.equal(mails.length, 0);
});

test("a too-close application is stored but sends no email", async () => {
  const store = new MemoryStore();
  const mails: DealerSignupEmail[] = [];
  const response = await handleDealerSignupSubmit(
    request(VALID_BODY),
    makeDeps(store, "too_close", mails),
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result, "too_close");
  assert.equal(body.status, "rejected_too_close");
  assert.equal(mails.length, 0);
  assert.equal(store.rows.size, 1);
  assert.equal([...store.rows.values()][0].status, "rejected_too_close");
});

test("manual_review notifies BMQ and sends the customer a no-contract email", async () => {
  const store = new MemoryStore();
  const mails: DealerSignupEmail[] = [];
  const response = await handleDealerSignupSubmit(
    request(VALID_BODY),
    makeDeps(store, "manual_review", mails),
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result, "manual_review");
  assert.equal(body.status, "manual_review");
  assert.equal(mails.length, 2);

  const bmqMail = mails.find((mail) => mail.to === "bmq@example.test");
  const customerMail = mails.find((mail) => mail.to === VALID_BODY.email);
  assert.ok(bmqMail);
  assert.ok(customerMail);
  assert.ok(customerMail.text.includes("BMQ sẽ liên hệ"));
  assert.equal(customerMail.attachments, undefined);
  assert.equal([...store.rows.values()][0].status, "manual_review");
});

test("near-threshold manual_review tells BMQ the reason and sends no contract", async () => {
  const store = new MemoryStore();
  const mails: DealerSignupEmail[] = [];
  const deps = makeDeps(store, "manual_review", mails);
  deps.evaluateRouteEligibility = async () => decision("manual_review", {
    reason_code: "distance_near_threshold",
    nearest_distance_m: 2200,
    unlocated_dealer_count: 0,
  });

  const response = await handleDealerSignupSubmit(request(VALID_BODY), deps);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result, "manual_review");
  assert.equal(body.status, "manual_review");
  assert.equal(mails.length, 2);

  const bmqMail = mails.find((mail) => mail.to === "bmq@example.test");
  const customerMail = mails.find((mail) => mail.to === VALID_BODY.email);
  assert.ok(bmqMail);
  assert.ok(customerMail);
  assert.ok(bmqMail.text.includes("distance_near_threshold"));
  assert.equal(customerMail.attachments, undefined);
  assert.equal([...store.rows.values()][0].status, "manual_review");
});

test("eligible approves once, stores the PDF and sends one contract with a bank slip link", async () => {
  const store = new MemoryStore();
  const mails: DealerSignupEmail[] = [];
  const response = await handleDealerSignupSubmit(
    request(VALID_BODY),
    makeDeps(store, "eligible", mails),
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.result, "eligible");
  assert.equal(body.status, "approved_waiting_slip");
  assert.equal(body.dealer_onboarding_status, "waiting_slip");
  assert.equal(body.crm_customer_id, "crm-customer-1");
  assert.equal(mails.length, 1);

  const mail = mails[0];
  assert.equal(mail.to, VALID_BODY.email);
  assert.equal(mail.cc, "bmq@example.test");
  assert.equal(mail.attachments?.length, 1);
  assert.equal(
    mail.attachments?.[0].filename,
    `HopDong-BMQ-${body.application_code}.pdf`,
  );
  assert.equal(mail.attachments?.[0].mimeType, "application/pdf");
  assert.ok(mail.text.includes("dai-ly-moi/bank-slip?token="));
  assert.ok(mail.html.includes("dai-ly-moi/bank-slip?token="));
  assert.ok(mail.text.includes("số điện thoại đã đăng ký"));

  assert.equal(store.approvalCalls.length, 1);
  assert.equal(store.approvalCalls[0].mode, "auto");
  assert.equal(store.approvalCalls[0].reviewerId, null);
  assert.match(String(store.approvalCalls[0].slipTokenHash), /^[0-9a-f]{64}$/);
  assert.equal(store.uploadedDrafts.size, 1);
  assert.equal(store.contractDraftCalls.length, 1);
  assert.equal(store.contractDraftCalls[0].path, `${[...store.rows.values()][0].id}/contract-draft.pdf`);

  const stored = [...store.rows.values()][0];
  assert.equal(stored.status, "approved_waiting_slip");
  assert.equal(stored.email_message_id, "gmail-message-1");
  assert.ok(stored.contract_sent_at);
  assert.equal(stored.last_error_code, null);
});

test("duplicate phone during auto approval falls back to manual review without a contract", async () => {
  const store = new MemoryStore();
  const mails: DealerSignupEmail[] = [];
  const deps = makeDeps(store, "eligible", mails, {
    approveSignup: async (input) => {
      store.approvalCalls.push(input as unknown as Record<string, unknown>);
      throw Object.assign(
        new Error("SĐT 0909123456 đang được dùng cho khách hàng Hộ kinh doanh Cũ."),
        { code: "23505" },
      );
    },
  });

  const response = await handleDealerSignupSubmit(request(VALID_BODY), deps);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.result, "manual_review");
  assert.equal(body.status, "manual_review");
  assert.equal(body.duplicate_phone, true);
  assert.equal(mails.length, 2);
  assert.ok(mails.every((mail) => mail.attachments === undefined));

  const bmqMail = mails.find((mail) => mail.to === "bmq@example.test");
  assert.ok(bmqMail);
  assert.ok(bmqMail.text.includes("Số điện thoại đã thuộc khách hàng khác"));
  assert.equal(store.approvalCalls.length, 1);
  assert.equal(store.uploadedDrafts.size, 0);
  assert.equal(store.contractDraftCalls.length, 0);

  const stored = [...store.rows.values()][0];
  assert.equal(stored.status, "manual_review");
  assert.equal(stored.last_error_code, "duplicate_phone");
});

test("the same idempotency key never sends a second email", async () => {
  const store = new MemoryStore();
  const mails: DealerSignupEmail[] = [];
  const deps = makeDeps(store, "eligible", mails);

  const first = await handleDealerSignupSubmit(request(VALID_BODY), deps);
  const firstBody = await first.json();
  const second = await handleDealerSignupSubmit(request(VALID_BODY), deps);
  const secondBody = await second.json();

  assert.equal(first.status, 200);
  assert.equal(second.status, 200);
  assert.equal(mails.length, 1);
  assert.equal(store.rows.size, 1);
  assert.equal(secondBody.application_code, firstBody.application_code);
  assert.equal(secondBody.email_message_id, firstBody.email_message_id);
  assert.equal(store.approvalCalls.length, 1);
  assert.equal(store.uploadedDrafts.size, 1);
  assert.equal(store.contractDraftCalls.length, 1);
});

test("an email failure is stored as email_failed and a retry does not resend", async () => {
  const store = new MemoryStore();
  const mails: DealerSignupEmail[] = [];
  const deps = makeDeps(store, "eligible", mails, {
    sendEmail: async () => {
      throw Object.assign(new Error("provider secret token"), { code: "gmail_rate_limited" });
    },
  });

  const first = await handleDealerSignupSubmit(request(VALID_BODY), deps);
  assert.equal(first.status, 502);
  const firstText = await first.text();
  assert.ok(!firstText.includes("provider secret token"));
  assert.ok(firstText.includes("gmail_rate_limited"));

  const stored = [...store.rows.values()][0];
  assert.equal(stored.status, "email_failed");
  assert.equal(stored.last_error_code, "gmail_rate_limited");

  const second = await handleDealerSignupSubmit(request(VALID_BODY), deps);
  assert.equal(second.status, 200);
  assert.equal((await second.json()).status, "email_failed");
  assert.equal(mails.length, 0);
});

test("the submit rate limit returns 429 without writing an application", async () => {
  const store = new MemoryStore();
  store.rateLimitAllowed = false;
  const mails: DealerSignupEmail[] = [];
  const response = await handleDealerSignupSubmit(
    request(VALID_BODY),
    makeDeps(store, "eligible", mails),
  );

  assert.equal(response.status, 429);
  assert.equal(store.rows.size, 0);
  assert.equal(mails.length, 0);
});
