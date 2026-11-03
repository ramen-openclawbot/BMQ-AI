import assert from "node:assert/strict";
import test from "node:test";

import {
  handleDealerSignupReview,
  type DealerSignupReviewActor,
  type DealerSignupReviewDeps,
  type DealerSignupReviewEmail,
  type DealerSignupReviewStore,
} from "./handler.ts";
import type {
  DealerSignupApprovalResult,
  DealerSignupReviewApplication,
} from "../_shared/dealer-signup-review.ts";
import type { DealerContractInput } from "../_shared/dealer-signup-contract.ts";

const APP_ID = "11111111-1111-4111-8111-111111111111";
const PDF_BYTES = new TextEncoder().encode("%PDF-1.4\nsigned contract\n%%EOF");

function application(
  overrides: Partial<DealerSignupReviewApplication> = {},
): DealerSignupReviewApplication {
  return {
    id: APP_ID,
    application_code: "DLM-20261103-0001",
    status: "manual_review",
    applicant_name: "Nguyễn Thị Hồng",
    cccd: "079123456789",
    cccd_valid_until: "2035-06-30",
    phone: "0909123456",
    email: "hong@example.test",
    business_name: "Hộ kinh doanh Bánh mì Hồng",
    address_text: "12 Lê Lợi, Phường Bến Thành, Quận 1, TP.HCM",
    crm_customer_id: null,
    contract_draft_path: null,
    contract_signed_path: null,
    slip_storage_path: null,
    slip_token_expires_at: null,
    reviewed_at: null,
    ...overrides,
  };
}

class MemoryStore implements DealerSignupReviewStore {
  app: DealerSignupReviewApplication | null = application();
  approvalCalls: Parameters<DealerSignupReviewStore["approve"]>[0][] = [];
  approvalResult: DealerSignupApprovalResult | null = null;
  draftCalls: Array<{ id: string; path: string }> = [];
  signedCalls: Array<{ id: string; path: string; uploadedBy: string }> = [];
  rejectCalls: Array<{ id: string; reviewerId: string; reason: string }> = [];
  lastErrors: Array<{ id: string; code: string }> = [];
  rotated: Array<{ id: string; hash: string; expiresAt: string }> = [];

  async getApplication(id: string) {
    return this.app?.id === id ? this.app : null;
  }

  async approve(input: Parameters<DealerSignupReviewStore["approve"]>[0]) {
    this.approvalCalls.push(input);
    if (this.approvalResult) return this.approvalResult;
    return {
      application_id: input.applicationId,
      application_code: "DLM-20261103-0001",
      status: "approved_waiting_slip",
      crm_customer_id: "crm-customer-1",
      already_approved: false,
    };
  }

  async setContractDraft(id: string, path: string) {
    this.draftCalls.push({ id, path });
    if (this.app) this.app.contract_draft_path = path;
  }

  async setSignedContract(id: string, path: string, uploadedBy: string) {
    this.signedCalls.push({ id, path, uploadedBy });
  }

  async reject(id: string, reviewerId: string, reason: string) {
    this.rejectCalls.push({ id, reviewerId, reason });
  }

  async setLastError(id: string, code: string) {
    this.lastErrors.push({ id, code });
  }

  async rotateSlipToken(id: string, hash: string, expiresAt: string) {
    this.rotated.push({ id, hash, expiresAt });
  }
}

const OWNER: DealerSignupReviewActor = {
  userId: "user-owner",
  isOwner: true,
  crmView: true,
  crmEdit: true,
  accountingEdit: true,
};

const CRM_VIEW: DealerSignupReviewActor = {
  userId: "user-view",
  isOwner: false,
  crmView: true,
  crmEdit: false,
  accountingEdit: false,
};

const ACCOUNTING: DealerSignupReviewActor = {
  userId: "user-accounting",
  isOwner: false,
  crmView: false,
  crmEdit: false,
  accountingEdit: true,
};

function makeDeps(
  store: MemoryStore,
  overrides: Partial<DealerSignupReviewDeps> = {},
): DealerSignupReviewDeps & {
  mails: DealerSignupReviewEmail[];
  pdfInputs: DealerContractInput[];
  uploads: Array<{ path: string; bytes: Uint8Array; contentType: string }>;
} {
  const mails: DealerSignupReviewEmail[] = [];
  const pdfInputs: DealerContractInput[] = [];
  const uploads: Array<{ path: string; bytes: Uint8Array; contentType: string }> = [];

  return {
    authenticate: async () => OWNER,
    store,
    buildContractPdf: async (input) => {
      pdfInputs.push(input);
      return PDF_BYTES;
    },
    loadContractAssets: async () => ({ regular: new Uint8Array([1]), bold: new Uint8Array([2]) }),
    uploadDocument: async (path, bytes, contentType) => {
      uploads.push({ path, bytes, contentType });
    },
    createSignedUrl: async (path) => `https://storage.test/${path}?token=signed`,
    sendEmail: async (email) => {
      mails.push(email);
      return { id: `mail-${mails.length}` };
    },
    now: () => new Date("2026-11-03T03:00:00.000Z"),
    env: () => undefined,
    logger: () => {},
    mails,
    pdfInputs,
    uploads,
    ...overrides,
  } as DealerSignupReviewDeps & {
    mails: DealerSignupReviewEmail[];
    pdfInputs: DealerContractInput[];
    uploads: Array<{ path: string; bytes: Uint8Array; contentType: string }>;
  };
}

function post(action: string, body: Record<string, unknown> = {}): Request {
  return new Request(`https://example.test/dealer-signup-review?action=${action}`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: "Bearer test-jwt" },
    body: JSON.stringify(body),
  });
}

function uploadRequest(form: FormData): Request {
  return new Request(
    "https://example.test/dealer-signup-review?action=upload_signed_contract",
    {
      method: "POST",
      headers: { Authorization: "Bearer test-jwt" },
      body: form,
    },
  );
}

test("manual approval creates one customer, one PDF and one congratulations email", async () => {
  const store = new MemoryStore();
  const deps = makeDeps(store);

  const response = await handleDealerSignupReview(post("approve", { application_id: APP_ID }), deps);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.success, true);
  assert.equal(body.status, "approved_waiting_slip");
  assert.equal(body.crm_customer_id, "crm-customer-1");
  assert.equal(body.dealer_onboarding_status, "waiting_slip");
  assert.equal(body.contract_ready, true);
  assert.equal(body.email_sent, true);

  assert.equal(store.approvalCalls.length, 1);
  assert.equal(store.approvalCalls[0].mode, "manual");
  assert.equal(store.approvalCalls[0].reviewerId, "user-owner");
  assert.match(store.approvalCalls[0].slipTokenHash, /^[0-9a-f]{64}$/);

  assert.equal(deps.pdfInputs.length, 1);
  assert.equal(deps.pdfInputs[0].applicant_name, "Nguyễn Thị Hồng");
  assert.equal(deps.pdfInputs[0].business_name, "Hộ kinh doanh Bánh mì Hồng");
  assert.equal(deps.pdfInputs[0].cccd, "079123456789");
  assert.equal(deps.pdfInputs[0].cccd_valid_until, "2035-06-30");
  assert.equal(deps.pdfInputs[0].phone, "0909123456");
  assert.equal(deps.pdfInputs[0].email, "hong@example.test");
  assert.equal(deps.pdfInputs[0].contract_date, "2026-11-03");

  assert.equal(deps.uploads.length, 1);
  assert.equal(deps.uploads[0].path, `${APP_ID}/contract-draft.pdf`);
  assert.equal(deps.uploads[0].contentType, "application/pdf");
  assert.equal(store.draftCalls.length, 1);

  assert.equal(deps.mails.length, 1);
  assert.equal(deps.mails[0].to, "hong@example.test");
  assert.ok(deps.mails[0].subject.includes("DLM-20261103-0001"));
  assert.ok(deps.mails[0].text.includes("dai-ly-moi/bank-slip?token="));
});

test("approving an already approved application creates no second customer, PDF or email", async () => {
  const store = new MemoryStore();
  store.app = application({
    status: "approved_waiting_slip",
    crm_customer_id: "crm-customer-1",
    contract_draft_path: `${APP_ID}/contract-draft.pdf`,
  });
  const deps = makeDeps(store);

  const response = await handleDealerSignupReview(post("approve", { application_id: APP_ID }), deps);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.already_approved, true);
  assert.equal(body.contract_ready, true);
  assert.equal(store.approvalCalls.length, 0);
  assert.equal(deps.pdfInputs.length, 0);
  assert.equal(deps.uploads.length, 0);
  assert.equal(deps.mails.length, 0);
});

test("a concurrent approval reported by the RPC does not build or send another contract", async () => {
  const store = new MemoryStore();
  store.approvalResult = {
    application_id: APP_ID,
    application_code: "DLM-20261103-0001",
    status: "approved_waiting_slip",
    crm_customer_id: "crm-customer-other-request",
    already_approved: true,
  };
  const deps = makeDeps(store);

  const response = await handleDealerSignupReview(post("approve", { application_id: APP_ID }), deps);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.already_approved, true);
  assert.equal(deps.pdfInputs.length, 0);
  assert.equal(deps.uploads.length, 0);
  assert.equal(deps.mails.length, 0);
});

test("CRM view permission cannot approve or reject", async () => {
  const store = new MemoryStore();
  const deps = makeDeps(store, { authenticate: async () => CRM_VIEW });

  for (const action of ["approve", "reject", "regenerate_contract", "resend_slip_link"]) {
    const response = await handleDealerSignupReview(
      post(action, { application_id: APP_ID, reason: "x" }),
      deps,
    );
    assert.equal(response.status, 403, action);
    const body = await response.json();
    assert.equal(body.code, "forbidden");
  }

  assert.equal(store.approvalCalls.length, 0);
  assert.equal(store.rejectCalls.length, 0);
});

test("accounting can download and upload a signed contract; CRM view can only download", async () => {
  const store = new MemoryStore();
  store.app = application({
    status: "approved_waiting_slip",
    crm_customer_id: "crm-customer-1",
    contract_draft_path: `${APP_ID}/contract-draft.pdf`,
    contract_signed_path: `${APP_ID}/contract-signed-old.pdf`,
    slip_storage_path: `${APP_ID}/slip-old.pdf`,
  });

  const accountingDeps = makeDeps(store, { authenticate: async () => ACCOUNTING });
  const download = await handleDealerSignupReview(
    post("download", { application_id: APP_ID, kind: "contract_draft" }),
    accountingDeps,
  );
  assert.equal(download.status, 200);
  const downloadBody = await download.json();
  assert.equal(downloadBody.expires_in, 300);
  assert.ok(downloadBody.url.includes("contract-draft.pdf"));

  const form = new FormData();
  form.set("application_id", APP_ID);
  form.set("file", new File([PDF_BYTES], "signed.pdf", { type: "application/pdf" }));
  const upload = await handleDealerSignupReview(uploadRequest(form), accountingDeps);
  assert.equal(upload.status, 200);
  const uploadBody = await upload.json();
  assert.equal(uploadBody.kind, "contract_signed");
  assert.match(uploadBody.path, new RegExp(`^${APP_ID}/contract-signed-.+\\.pdf$`));
  assert.equal(store.signedCalls.length, 1);
  assert.equal(store.signedCalls[0].uploadedBy, "user-accounting");

  const viewDeps = makeDeps(store, { authenticate: async () => CRM_VIEW });
  const viewDownload = await handleDealerSignupReview(
    post("download", { application_id: APP_ID, kind: "slip" }),
    viewDeps,
  );
  assert.equal(viewDownload.status, 200);

  const viewForm = new FormData();
  viewForm.set("application_id", APP_ID);
  viewForm.set("file", new File([PDF_BYTES], "signed.pdf", { type: "application/pdf" }));
  const viewUpload = await handleDealerSignupReview(uploadRequest(viewForm), viewDeps);
  assert.equal(viewUpload.status, 403);
  assert.equal(store.signedCalls.length, 1);
});

test("a fake signed-contract file is rejected before any upload", async () => {
  const store = new MemoryStore();
  const deps = makeDeps(store);
  const form = new FormData();
  form.set("application_id", APP_ID);
  form.set("file", new File(["<?php echo 1; ?>"], "signed.pdf", { type: "application/pdf" }));

  const response = await handleDealerSignupReview(uploadRequest(form), deps);
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.code, "invalid_file_type");
  assert.equal(deps.uploads.length, 0);
  assert.equal(store.signedCalls.length, 0);
});

test("reject requires a reason and sends one email when valid", async () => {
  const store = new MemoryStore();
  const deps = makeDeps(store);

  const missing = await handleDealerSignupReview(post("reject", { application_id: APP_ID }), deps);
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).code, "reject_reason_required");
  assert.equal(store.rejectCalls.length, 0);
  assert.equal(deps.mails.length, 0);

  const tooLong = await handleDealerSignupReview(
    post("reject", { application_id: APP_ID, reason: "x".repeat(501) }),
    deps,
  );
  assert.equal(tooLong.status, 400);
  assert.equal((await tooLong.json()).code, "reject_reason_too_long");

  const ok = await handleDealerSignupReview(
    post("reject", { application_id: APP_ID, reason: "Ngoài bán kính cho phép" }),
    deps,
  );
  const body = await ok.json();
  assert.equal(ok.status, 200);
  assert.equal(body.status, "rejected_manual");
  assert.equal(body.email_sent, true);
  assert.equal(store.rejectCalls.length, 1);
  assert.equal(deps.mails.length, 1);
  assert.ok(deps.mails[0].text.includes("Ngoài bán kính cho phép"));
});

test("download returns 404 when the document is missing", async () => {
  const store = new MemoryStore();
  const deps = makeDeps(store);
  const response = await handleDealerSignupReview(
    post("download", { application_id: APP_ID, kind: "contract_signed" }),
    deps,
  );
  assert.equal(response.status, 404);
  assert.equal((await response.json()).code, "document_missing");
});

test("regenerate contract and resend slip link use one PDF/email without re-approving", async () => {
  const store = new MemoryStore();
  store.app = application({
    status: "approved_waiting_slip",
    crm_customer_id: "crm-customer-1",
    reviewed_at: "2026-11-02T03:00:00.000Z",
  });
  const deps = makeDeps(store);

  const regenerated = await handleDealerSignupReview(
    post("regenerate_contract", { application_id: APP_ID }),
    deps,
  );
  assert.equal(regenerated.status, 200);
  assert.equal(deps.pdfInputs.length, 1);
  assert.equal(deps.pdfInputs[0].contract_date, "2026-11-02");
  assert.equal(store.approvalCalls.length, 0);

  const resent = await handleDealerSignupReview(
    post("resend_slip_link", { application_id: APP_ID }),
    deps,
  );
  assert.equal(resent.status, 200);
  assert.equal((await resent.json()).email_sent, true);
  assert.equal(store.rotated.length, 1);
  assert.match(store.rotated[0].hash, /^[0-9a-f]{64}$/);
  assert.equal(deps.mails.length, 1);
  assert.equal(store.approvalCalls.length, 0);
});
