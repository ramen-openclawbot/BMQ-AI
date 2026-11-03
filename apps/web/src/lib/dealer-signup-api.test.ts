import assert from "node:assert/strict";
import test from "node:test";

import {
  DEALER_SIGNUP_REVIEW_BAND_M,
  DealerSignupApiError,
  checkDealerSignupVerification,
  confirmDealerSignupPayment,
  createDealerSignupVerificationSessionId,
  geocodeAddressPhoton,
  getDealerSignupDocumentUrl,
  getDealerSignupPaymentSettings,
  getDealerSlipStatus,
  rejectDealerSignupSlip,
  reviewDealerSignup,
  sendDealerSignupVerification,
  setDealerSignupPaymentSettings,
  uploadDealerSignedContract,
  uploadDealerSlip,
  type DealerSignupFetcher,
  type DealerSignupPaymentSettings,
  type PhotonFetcher,
} from "./dealer-signup-api.ts";

const SUPABASE_URL = "https://project.test/";
const ACCESS_TOKEN = "test-access-token";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("review band default matches the server default", () => {
  assert.equal(DEALER_SIGNUP_REVIEW_BAND_M, 500);
});

test("Photon geocoder sends q, limit, lang=default and Vietnam bbox", async () => {
  let requestedUrl = "";
  let requestedHeaders: Record<string, string> = {};
  const fetcher: PhotonFetcher = async (input, init) => {
    requestedUrl = String(input);
    requestedHeaders = init?.headers as Record<string, string>;
    return new Response(JSON.stringify({
      features: [{
        properties: {
          name: "BMQ",
          housenumber: "12",
          street: "Lê Lợi",
          district: "Quận 1",
          city: "Hồ Chí Minh",
          osm_value: "amenity",
          type: "restaurant",
        },
        geometry: { coordinates: [106.7009, 10.7769] },
      }],
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };

  const results = await geocodeAddressPhoton("12 Lê Lợi, Quận 1", fetcher);
  const url = new URL(requestedUrl);

  assert.equal(url.origin + url.pathname, "https://photon.komoot.io/api/");
  assert.equal(url.searchParams.get("q"), "12 Lê Lợi, Quận 1");
  assert.equal(url.searchParams.get("limit"), "5");
  assert.equal(url.searchParams.get("lang"), "default");
  assert.equal(url.searchParams.get("bbox"), "102,8,110,24");
  assert.equal(requestedHeaders.Accept, "application/json");
  assert.deepEqual(results, [{
    label: "BMQ, 12 Lê Lợi, Quận 1, Hồ Chí Minh",
    lat: 10.7769,
    lng: 106.7009,
  }]);
});

test("Photon label omits a redundant name and keeps every useful field", async () => {
  const fetcher: PhotonFetcher = async () => new Response(JSON.stringify({
    features: [{
      properties: {
        name: "Lê Lợi",
        housenumber: "12",
        street: "Lê Lợi",
        district: "Quận 1",
        city: "Hồ Chí Minh",
      },
      geometry: { coordinates: [106.7009, 10.7769] },
    }],
  }), { status: 200 });

  const [result] = await geocodeAddressPhoton("12 Lê Lợi", fetcher);
  assert.equal(result.label, "12 Lê Lợi, Quận 1, Hồ Chí Minh");
});

test("empty query and provider failures return no suggestions", async () => {
  let calls = 0;
  const fetcher: PhotonFetcher = async () => {
    calls += 1;
    return new Response("down", { status: 503 });
  };

  assert.deepEqual(await geocodeAddressPhoton("   ", fetcher), []);
  assert.equal(calls, 0);
  assert.deepEqual(await geocodeAddressPhoton("Quận 1", fetcher), []);
  assert.equal(calls, 1);
});

test("reviewDealerSignup forwards the JWT and action to the review function", async () => {
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const fetcher: DealerSignupFetcher = async (input, init) => {
    requestedUrl = String(input);
    requestedInit = init;
    return jsonResponse({
      success: true,
      application_id: "11111111-1111-4111-8111-111111111111",
      status: "approved_waiting_slip",
      contract_ready: true,
      email_sent: true,
    });
  };

  const result = await reviewDealerSignup(
    {
      action: "approve",
      applicationId: "11111111-1111-4111-8111-111111111111",
    },
    { accessToken: ACCESS_TOKEN, fetcher, supabaseUrl: SUPABASE_URL },
  );

  assert.equal(
    requestedUrl,
    "https://project.test/functions/v1/dealer-signup-review?action=approve",
  );
  assert.equal(requestedInit?.method, "POST");
  assert.equal(
    (requestedInit?.headers as Record<string, string>).Authorization,
    `Bearer ${ACCESS_TOKEN}`,
  );
  assert.deepEqual(JSON.parse(String(requestedInit?.body)), {
    action: "approve",
    application_id: "11111111-1111-4111-8111-111111111111",
  });
  assert.equal(result.status, "approved_waiting_slip");
  assert.equal(result.email_sent, true);
});

test("review errors keep the server code and HTTP status", async () => {
  const fetcher: DealerSignupFetcher = async () =>
    jsonResponse({ success: false, error: "Forbidden", code: "forbidden" }, 403);

  await assert.rejects(
    () =>
      reviewDealerSignup(
        { action: "approve", applicationId: "id" },
        { accessToken: ACCESS_TOKEN, fetcher, supabaseUrl: SUPABASE_URL },
      ),
    (error: unknown) => {
      assert.ok(error instanceof DealerSignupApiError);
      assert.equal(error.code, "forbidden");
      assert.equal(error.status, 403);
      return true;
    },
  );
});

test("getDealerSignupDocumentUrl returns the five-minute signed URL payload", async () => {
  const fetcher: DealerSignupFetcher = async () =>
    jsonResponse({
      success: true,
      application_id: "app-1",
      application_code: "DLM-20261103-0001",
      kind: "contract_draft",
      url: "https://storage.test/signed",
      expires_in: 300,
    });

  const result = await getDealerSignupDocumentUrl(
    { applicationId: "app-1", kind: "contract_draft" },
    { accessToken: ACCESS_TOKEN, fetcher, supabaseUrl: SUPABASE_URL },
  );

  assert.equal(result.url, "https://storage.test/signed");
  assert.equal(result.expires_in, 300);
  assert.equal(result.kind, "contract_draft");
});

test("uploadDealerSignedContract sends multipart with the access token", async () => {
  let requestedInit: RequestInit | undefined;
  const fetcher: DealerSignupFetcher = async (_input, init) => {
    requestedInit = init;
    return jsonResponse({ success: true, kind: "contract_signed", path: "p.pdf" });
  };

  const result = await uploadDealerSignedContract(
    {
      applicationId: "app-1",
      file: new File(["%PDF-1.4"], "signed.pdf", { type: "application/pdf" }),
    },
    { accessToken: ACCESS_TOKEN, fetcher, supabaseUrl: SUPABASE_URL },
  );

  assert.ok(requestedInit?.body instanceof FormData);
  assert.equal((requestedInit?.headers as Record<string, string>).Authorization, `Bearer ${ACCESS_TOKEN}`);
  assert.equal((requestedInit?.headers as Record<string, string>)["Content-Type"], undefined);
  assert.equal((requestedInit?.body as FormData).get("application_id"), "app-1");
  assert.equal(result.path, "p.pdf");
});

test("getDealerSlipStatus is public and returns only the status payload", async () => {
  let requestedUrl = "";
  const fetcher: DealerSignupFetcher = async (input) => {
    requestedUrl = String(input);
    return jsonResponse({
      success: true,
      status: "valid",
      business_name: "Hộ kinh doanh Bánh mì Hồng",
      application_code: "DLM-20261103-0001",
      can_upload: true,
    });
  };

  const result = await getDealerSlipStatus("tok_123", { fetcher, supabaseUrl: SUPABASE_URL });
  assert.equal(
    requestedUrl,
    "https://project.test/functions/v1/dealer-signup-slip?token=tok_123",
  );
  assert.equal(result.status, "valid");
  assert.equal(result.business_name, "Hộ kinh doanh Bánh mì Hồng");
});

test("uploadDealerSlip supports the link token and the dealer session header", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher: DealerSignupFetcher = async (input, init) => {
    calls.push({ url: String(input), init });
    return jsonResponse({ success: true, status: "active", email_sent: true });
  };

  const file = new File(["%PDF-1.4"], "slip.pdf", { type: "application/pdf" });

  await uploadDealerSlip(
    { file, token: "tok_abc" },
    { fetcher, supabaseUrl: SUPABASE_URL },
  );
  await uploadDealerSlip(
    { file, dealerToken: "dop_session" },
    { fetcher, supabaseUrl: SUPABASE_URL },
  );

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "https://project.test/functions/v1/dealer-signup-slip?token=tok_abc");
  assert.equal((calls[0].init?.body as FormData).get("token"), "tok_abc");
  assert.equal(calls[1].url, "https://project.test/functions/v1/dealer-signup-slip");
  assert.equal(
    (calls[1].init?.headers as Record<string, string>)["x-dealer-session"],
    "dop_session",
  );
});

test("confirmDealerSignupPayment and rejectDealerSignupSlip use review actions", async () => {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetcher: DealerSignupFetcher = async (input, init) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body || "{}")) as Record<string, unknown>,
    });
    return jsonResponse({ success: true, status: "active", already_active: false });
  };

  await confirmDealerSignupPayment(
    { applicationId: "app-1" },
    { accessToken: ACCESS_TOKEN, fetcher, supabaseUrl: SUPABASE_URL },
  );
  await rejectDealerSignupSlip(
    { applicationId: "app-1", reason: "Số tiền chưa khớp" },
    { accessToken: ACCESS_TOKEN, fetcher, supabaseUrl: SUPABASE_URL },
  );

  assert.equal(calls[0].url, "https://project.test/functions/v1/dealer-signup-review?action=confirm_payment");
  assert.deepEqual(calls[0].body, { action: "confirm_payment", application_id: "app-1" });
  assert.equal(calls[1].url, "https://project.test/functions/v1/dealer-signup-review?action=reject_slip");
  assert.deepEqual(calls[1].body, {
    action: "reject_slip",
    application_id: "app-1",
    reason: "Số tiền chưa khớp",
  });
});

test("payment settings are read and written through the owner-only actions", async () => {
  const settings: DealerSignupPaymentSettings = {
    bank_name: "Ngân hàng TMCP Kỹ thương Việt Nam",
    bank_bin: "970407",
    account_number: "19001234567890",
    account_name: "HỘ KINH DOANH BÁNH MÌ BMQ",
    amount_vnd: 1_000_000,
    transfer_note_template: "BMQ {application_code}",
  };
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetcher: DealerSignupFetcher = async (input, init) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body || "{}")) as Record<string, unknown>,
    });
    return jsonResponse({ success: true, payment_settings: settings });
  };

  const read = await getDealerSignupPaymentSettings({
    accessToken: ACCESS_TOKEN,
    fetcher,
    supabaseUrl: SUPABASE_URL,
  });
  const written = await setDealerSignupPaymentSettings(
    { settings },
    { accessToken: ACCESS_TOKEN, fetcher, supabaseUrl: SUPABASE_URL },
  );

  assert.equal(calls[0].url, "https://project.test/functions/v1/dealer-signup-review?action=get_payment_settings");
  assert.deepEqual(calls[0].body, { action: "get_payment_settings" });
  assert.equal(calls[1].url, "https://project.test/functions/v1/dealer-signup-review?action=set_payment_settings");
  assert.deepEqual(calls[1].body, { action: "set_payment_settings", payment_settings: settings });
  assert.equal(read.payment_settings?.account_number, "19001234567890");
  assert.equal(written.payment_settings?.amount_vnd, 1_000_000);
});

test("verification helpers generate a session id and post send/check payloads", async () => {
  const sessionId = createDealerSignupVerificationSessionId();
  assert.equal(typeof sessionId, "string");
  assert.ok(sessionId.length > 10);

  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetcher: DealerSignupFetcher = async (input, init) => {
    calls.push({
      url: String(input),
      body: JSON.parse(String(init?.body || "{}")) as Record<string, unknown>,
    });
    return jsonResponse(calls.length === 1
      ? { success: true, channel: "phone", sent: true, resend_after_seconds: 60 }
      : {
        success: true,
        verified: { phone: true, email: true },
        verification_token: "verification-token-abc",
        verification_expires_at: "2026-11-03T03:30:00.000Z",
      });
  };

  const sent = await sendDealerSignupVerification(
    { sessionId, channel: "phone", phone: "0909 123 456" },
    { fetcher, supabaseUrl: SUPABASE_URL },
  );
  const checked = await checkDealerSignupVerification(
    { sessionId, phone: "0909 123 456", email: "hong@example.test", phoneCode: "123456" },
    { fetcher, supabaseUrl: SUPABASE_URL },
  );

  assert.equal(calls[0].url, "https://project.test/functions/v1/dealer-signup-verify");
  assert.equal(calls[0].body.action, "send");
  assert.equal(calls[0].body.session_id, sessionId);
  assert.equal(calls[0].body.channel, "phone");
  assert.equal(sent.sent, true);
  assert.equal(calls[1].body.action, "check");
  assert.equal(calls[1].body.phone_code, "123456");
  assert.equal(checked.verification_token, "verification-token-abc");
  assert.deepEqual(checked.verified, { phone: true, email: true });
});

test("slip status exposes payment_info and the slip_submitted state", async () => {
  const fetcher: DealerSignupFetcher = async () =>
    jsonResponse({
      success: true,
      status: "slip_submitted",
      application_code: "DLM-20261103-0001",
      can_upload: false,
      payment_info: {
        bank_name: "Ngân hàng TMCP Kỹ thương Việt Nam",
        bank_bin: "970407",
        account_number: "19001234567890",
        account_name: "HỘ KINH DOANH BÁNH MÌ BMQ",
        amount_vnd: 1_000_000,
        transfer_note: "BMQ DLM-20261103-0001",
        qr_url: "https://img.vietqr.io/image/970407-19001234567890-compact2.png?amount=1000000",
      },
    });

  const result = await getDealerSlipStatus("tok_123", { fetcher, supabaseUrl: SUPABASE_URL });
  assert.equal(result.status, "slip_submitted");
  assert.equal(result.can_upload, false);
  assert.equal(result.payment_info?.account_number, "19001234567890");
  assert.equal(result.payment_info?.amount_vnd, 1_000_000);
  assert.equal(result.payment_info?.transfer_note, "BMQ DLM-20261103-0001");
  assert.match(String(result.payment_info?.qr_url), /img\.vietqr\.io/);
});
