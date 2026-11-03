import assert from "node:assert/strict";
import test from "node:test";

import {
  DEALER_SIGNUP_REVIEW_BAND_M,
  DealerSignupApiError,
  geocodeAddressPhoton,
  getDealerSignupDocumentUrl,
  getDealerSlipStatus,
  reviewDealerSignup,
  uploadDealerSignedContract,
  uploadDealerSlip,
  type DealerSignupFetcher,
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
