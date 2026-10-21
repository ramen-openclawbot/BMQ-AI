// Offline tests for the merchant draft guard.
//
// Every provider call is an injected fetcher and the service-role check uses a
// fake key, so no network, real Supabase or real provider request happens.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  GUARD_PROBABILITY_THRESHOLD,
  MAX_INPUT_BYTES,
  handleGuardRequest,
  isAuthorized,
  runGuard,
  type GuardDeps,
  type GuardInput,
  type GuardRequestDeps,
} from "./guard.ts";

const CATALOG = [
  {
    sku_code: "BMQ-001",
    product_name: "Bánh Mì Que Pate",
    selling_price: 12000,
  },
];

const BASE_INPUT: GuardInput = {
  kind: "listing",
  summary: "Cập nhật thông tin Bánh Mì Que Pate",
  payload: { title: "Bánh Mì Que Pate" },
  before: null,
  catalog: CATALOG,
};

function gatewayBody(probabilities: Record<string, number>): unknown {
  return {
    model: "typesafe-ai/jev",
    answers: Object.fromEntries(
      Object.entries(probabilities).map(([name, probability]) => [
        name,
        { type: "boolean", probability },
      ]),
    ),
    usage: { inputTokens: 12, outputTokens: 4 },
    providerMetadata: { gateway: { cost: "0.00001" } },
  };
}

function depsFor(
  delegate: (url: string, init?: RequestInit) => Promise<Response>,
  capture?: (url: string, init?: RequestInit) => void,
): GuardDeps {
  const fetcher = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    capture?.(url, init);
    return await delegate(url, init);
  }) as typeof fetch;
  return {
    fetcher,
    gatewayUrl: "https://gateway.test/v1/evaluate",
    gatewayKey: "server-gateway-key",
    env: (name: string) =>
      name === "DECISIONS_PROVIDER" ? "typesafe" : undefined,
    timeoutMs: 1000,
  };
}

function bodyFor(probabilities: Record<string, number>) {
  return depsFor(async () =>
    new Response(JSON.stringify(gatewayBody(probabilities)), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
}

test("notes map at the 0.6 probability threshold", async () => {
  const deps = bodyFor({
    unlisted_product: 0.6,
    unclear_terms: 0.59,
    wrong_audience_or_tone: 0.9,
  });

  const result = await runGuard({ ...BASE_INPUT, kind: "listing" }, deps);

  assert.equal(GUARD_PROBABILITY_THRESHOLD, 0.6);
  assert.deepEqual(result.notes, [
    "Có thể nhắc món không có trong danh mục.",
    "Nội dung có thể không phù hợp gửi đại lý.",
  ]);
  assert.equal(result.provider, "typesafe");
  assert.equal(result.probabilities?.unlisted_product, 0.6);
});

test("price_conflict is asked only for price, promotion and campaign kinds", async () => {
  const captured: Record<string, unknown>[] = [];
  const deps = depsFor(
    async () =>
      new Response(
        JSON.stringify(
          gatewayBody({
            unlisted_product: 0,
            price_conflict: 0,
            unclear_terms: 0,
            wrong_audience_or_tone: 0,
          }),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    (_url, init) => {
      captured.push(
        JSON.parse(String(init?.body)).questions as Record<string, unknown>,
      );
    },
  );

  await runGuard({ ...BASE_INPUT, kind: "listing" }, deps);
  await runGuard({ ...BASE_INPUT, kind: "price" }, deps);
  await runGuard({ ...BASE_INPUT, kind: "promotion" }, deps);
  await runGuard({ ...BASE_INPUT, kind: "campaign" }, deps);
  await runGuard({ ...BASE_INPUT, kind: "inventory" }, deps);

  assert.equal(Object.hasOwn(captured[0], "price_conflict"), false);
  assert.equal(Object.hasOwn(captured[1], "price_conflict"), true);
  assert.equal(Object.hasOwn(captured[2], "price_conflict"), true);
  assert.equal(Object.hasOwn(captured[3], "price_conflict"), true);
  assert.equal(Object.hasOwn(captured[4], "price_conflict"), false);
});

test("a provider failure returns empty notes and unavailable, never a throw", async () => {
  const deps = depsFor(async () => {
    throw new Error("provider down");
  });

  const result = await runGuard(BASE_INPUT, deps);

  assert.deepEqual(result.notes, []);
  assert.equal(result.provider, "unavailable");
  assert.equal(typeof result.error, "string");
  assert.ok((result.error ?? "").length > 0);
});

test("a provider HTTP failure is also a 200-shaped unavailable result", async () => {
  const deps = depsFor(async () =>
    new Response("upstream failed", { status: 500 })
  );

  const result = await runGuard(BASE_INPUT, deps);

  assert.deepEqual(result.notes, []);
  assert.equal(result.provider, "unavailable");
  assert.equal(result.error, "http_500");
});

test("a wrong bearer is rejected with 401 before any provider call", async () => {
  let called = false;
  const deps: GuardRequestDeps = {
    ...depsFor(async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }),
    serviceRoleKey: "service-role-secret",
  };

  const response = await handleGuardRequest(
    new Request("https://guard.test/merchant-draft-guard", {
      method: "POST",
      headers: {
        authorization: "Bearer wrong-secret",
        "content-type": "application/json",
      },
      body: JSON.stringify(BASE_INPUT),
    }),
    deps,
  );

  assert.equal(response.status, 401);
  assert.equal(called, false);
});

test("oversized input is truncated to the 40 KB state cap", async () => {
  let sentState: Record<string, unknown> | undefined;
  const deps = depsFor(
    async () =>
      new Response(
        JSON.stringify(
          gatewayBody({
            unlisted_product: 0,
            price_conflict: 0,
            unclear_terms: 0,
            wrong_audience_or_tone: 0,
          }),
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    (_url, init) => {
      sentState = JSON.parse(String(init?.body)).state as Record<
        string,
        unknown
      >;
    },
  );

  const result = await runGuard({
    ...BASE_INPUT,
    kind: "campaign",
    payload: { body: "x".repeat(200_000) },
  }, deps);

  assert.equal(result.provider, "typesafe");
  assert.ok(sentState);
  const payload = sentState.payload as Record<string, unknown>;
  assert.equal(typeof payload.body, "string");
  assert.ok(String(payload.body).length < 200_000);
  const bytes = new TextEncoder().encode(JSON.stringify(sentState)).length;
  assert.ok(bytes <= MAX_INPUT_BYTES, `state was ${bytes} bytes`);
});

test("a gateway-verified service_role JWT is accepted, anon is not", () => {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  const jwt = (role: string) => `${encode({ alg: "HS256" })}.${encode({ role })}.sig`;
  assert.equal(isAuthorized(`Bearer ${jwt("service_role")}`, "sb_secret_other"), true);
  assert.equal(isAuthorized(`Bearer ${jwt("anon")}`, "sb_secret_other"), false);
  assert.equal(isAuthorized("Bearer sb_secret_other", "sb_secret_other"), true);
  assert.equal(isAuthorized(null, "sb_secret_other"), false);
});
