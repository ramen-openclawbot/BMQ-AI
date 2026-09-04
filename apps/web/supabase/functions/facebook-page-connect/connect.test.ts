import {
  handleFacebookPageConnect,
  type FacebookPageConnectDeps,
  type FacebookPageConnectEnv,
} from "./index.ts";

function assert(condition: unknown, message = "assertion failed"): asserts condition {
  if (!condition) throw new Error(message);
}
function assertEqual<T>(actual: T, expected: T, message?: string): void {
  if (!Object.is(actual, expected)) throw new Error(message ?? `expected ${JSON.stringify(actual)} to equal ${JSON.stringify(expected)}`);
}
async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json();
}

const USER_ID = "11111111-1111-4111-8111-111111111111";
const NOW_ISO = "2026-09-04T03:00:00.000Z";

function env(overrides: Partial<FacebookPageConnectEnv> = {}): FacebookPageConnectEnv {
  return {
    META_APP_ID: "meta-app-id",
    META_APP_SECRET: "meta-app-secret",
    META_LOGIN_CONFIG_ID: "login-config-id",
    FACEBOOK_OAUTH_STATE_SECRET: "state-secret-at-least-32-bytes-long",
    SUPABASE_URL: "https://supabase.test",
    SUPABASE_SERVICE_ROLE_KEY: "service-role",
    ...overrides,
  };
}

function deps(overrides: Partial<FacebookPageConnectDeps> = {}) {
  const calls: Record<string, unknown[]> = {
    auth: [],
    permission: [],
    owner: [],
    stateCreate: [],
    stateConsume: [],
    exchangeCode: [],
    exchangeLong: [],
    pages: [],
    subscribe: [],
    storeAuth: [],
    markConnected: [],
    commitConnection: [],
    status: [],
    storeCandidates: [],
    listCandidates: [],
    consumeCandidate: [],
  };
  const active: FacebookPageConnectDeps = {
    now: () => new Date(NOW_ISO),
    randomNonce: () => "22222222-2222-4222-8222-222222222222",
    verifyJwt: async (token) => {
      calls.auth.push(token);
      return token === "fresh-token" ? { id: USER_ID } : null;
    },
    hasModulePermission: async (userId, moduleKey, mode) => {
      calls.permission.push({ userId, moduleKey, mode });
      return true;
    },
    isOwner: async (userId) => {
      calls.owner.push(userId);
      return true;
    },
    createOAuthState: async (input) => {
      calls.stateCreate.push(input);
    },
    consumeOAuthState: async (stateHash) => {
      calls.stateConsume.push(stateHash);
      return {
        actorId: USER_ID,
        redirectUrl: "https://ai.banhmique.vn/marketing-sales/facebook-page",
        expectedPageId: "1234567890",
      };
    },
    exchangeCode: async (input) => {
      calls.exchangeCode.push(input);
      return { accessToken: "short-user-token" };
    },
    exchangeLongLivedUserToken: async (input) => {
      calls.exchangeLong.push(input);
      return { accessToken: "long-user-token" };
    },
    fetchPages: async (input) => {
      calls.pages.push(input);
      return [
        { id: "9999999999", name: "Wrong Page", accessToken: "wrong-page-token", tasks: ["MESSAGING", "MANAGE"] },
        { id: "1234567890", name: "BMQ Main", accessToken: "page-token-secret", tasks: ["MESSAGING", "MANAGE"] },
      ];
    },
    subscribePageWebhooks: async (input) => {
      calls.subscribe.push(input);
    },
    commitPageConnection: async (input) => {
      calls.commitConnection.push(input);
    },
    getConnectionStatus: async () => {
      calls.status.push(true);
      return {
        connected: true,
        featureEnabled: false,
        pageName: "BMQ Main",
        pageIdSuffix: "7890",
        connectedAt: NOW_ISO,
      };
    },
    storePageSelectionCandidates: async (input) => {
      calls.storeCandidates.push(input);
      return input.candidates.map((candidate, index) => ({
        candidateId: `candidate-${index + 1}`,
        pageName: candidate.name,
        pageIdSuffix: candidate.id.slice(-4),
        permissions: [...(candidate.tasks || []), ...(candidate.perms || [])],
        expiresAt: input.expiresAt,
      }));
    },
    listPendingPageSelection: async (userId) => {
      calls.listCandidates.push(userId);
      return [];
    },
    consumePageSelectionCandidate: async (input) => {
      calls.consumeCandidate.push(input);
      return {
        pageId: "1234567890",
        pageName: "BMQ Main",
        pageAccessToken: "page-token-secret",
        permissions: ["MESSAGING", "MANAGE"],
      };
    },
    ...overrides,
  };
  return { deps: active, calls };
}

function post(body: Record<string, unknown>, token = "fresh-token") {
  return new Request("https://example.test/functions/v1/facebook-page-connect", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

Deno.test("status requires fresh JWT and facebook_messenger view, returning safe metadata only", async () => {
  assertEqual((await handleFacebookPageConnect(post({ action: "status" }, "stale-token"), env(), deps().deps)).status, 401);

  const noView = deps({ hasModulePermission: async () => false });
  const forbidden = await handleFacebookPageConnect(post({ action: "status" }), env(), noView.deps);
  assertEqual(forbidden.status, 403);
  assertEqual((noView.calls.status as unknown[]).length, 0);

  const response = await handleFacebookPageConnect(post({ action: "status" }), env(), deps().deps);
  assertEqual(response.status, 200);
  const body = await json(response);
  assertEqual(body.connected, true);
  assertEqual(body.featureEnabled, false);
  assertEqual(body.pageName, "BMQ Main");
  assertEqual(body.pageIdSuffix, "7890");
  assert(Array.isArray(body.pendingPageCandidates), "status should expose safe pending candidates");
  assert(!JSON.stringify(body).includes("page-token-secret"));
  assert(!JSON.stringify(body).includes("1234567890"));
});

Deno.test("start requires fresh owner-or-edit access and returns a Meta Login for Business code URL", async () => {
  const stale = await handleFacebookPageConnect(post({ action: "start" }, "stale-token"), env(), deps().deps);
  assertEqual(stale.status, 401);

  const notOwnerCanEdit = deps({ isOwner: async () => false });
  const editAllowed = await handleFacebookPageConnect(post({ action: "start" }), env(), notOwnerCanEdit.deps);
  assertEqual(editAllowed.status, 200);

  const ownerNoEdit = deps({ hasModulePermission: async (_userId, _moduleKey, mode) => mode === "view" });
  const ownerAllowed = await handleFacebookPageConnect(post({ action: "start" }), env(), ownerNoEdit.deps);
  assertEqual(ownerAllowed.status, 200);

  const neitherOwnerNorEdit = deps({ isOwner: async () => false, hasModulePermission: async (_userId, _moduleKey, mode) => mode === "view" });
  const forbidden = await handleFacebookPageConnect(post({ action: "start" }), env(), neitherOwnerNorEdit.deps);
  assertEqual(forbidden.status, 403);
  assertEqual((neitherOwnerNorEdit.calls.stateCreate as unknown[]).length, 0);

  const missingConfig = await handleFacebookPageConnect(post({ action: "start" }), env({ META_LOGIN_CONFIG_ID: undefined }), deps().deps);
  assertEqual(missingConfig.status, 503);
  assertEqual((await json(missingConfig)).error, "service_not_configured");

  const weakStateSecret = await handleFacebookPageConnect(post({ action: "start" }), env({ FACEBOOK_OAUTH_STATE_SECRET: "too-short" }), deps().deps);
  assertEqual(weakStateSecret.status, 503);
  assertEqual((await json(weakStateSecret)).error, "service_not_configured");

  const active = deps();
  const response = await handleFacebookPageConnect(post({
    action: "start",
    redirect: "https://ai.banhmique.vn/marketing-sales/facebook-page?ignored=1",
  }), env(), active.deps);
  assertEqual(response.status, 200);
  const body = await json(response);
  const authUrl = new URL(String(body.authUrl));
  assertEqual(authUrl.origin, "https://www.facebook.com");
  assertEqual(authUrl.pathname, "/v26.0/dialog/oauth");
  assertEqual(authUrl.searchParams.get("client_id"), "meta-app-id");
  assertEqual(authUrl.searchParams.get("redirect_uri"), "https://supabase.test/functions/v1/facebook-page-connect");
  assertEqual(authUrl.searchParams.get("response_type"), "code");
  assertEqual(authUrl.searchParams.get("config_id"), "login-config-id");
  assertEqual(authUrl.searchParams.get("override_default_response_type"), "true");
  assertEqual(authUrl.searchParams.get("auth_type"), "rerequest");
  assertEqual(authUrl.searchParams.has("scope"), false, "config_id flow must not send scope");
  assert(authUrl.searchParams.get("state"), "state must be present");
  assert(!String(body.authUrl).includes("state-secret"));
  assert(!String(body.authUrl).includes("1234567890"));
  assertEqual((active.calls.stateCreate as unknown[]).length, 1);
  const stored = (active.calls.stateCreate as Record<string, unknown>[])[0];
  assertEqual(stored.actorId, USER_ID);
  assertEqual(stored.redirectUrl, "https://ai.banhmique.vn/marketing-sales/facebook-page");
  assert(String(stored.stateHash).match(/^[0-9a-f]{64}$/), "state hash must be sha256 hex");
});

Deno.test("callback consumes state before Graph, selects requested Page, stores auth material server-side, and redirects without secrets", async () => {
  const active = deps();
  const started = await json(await handleFacebookPageConnect(post({ action: "start", expected_page_id: "1234567890" }), env(), active.deps));
  const state = new URL(String(started.authUrl)).searchParams.get("state");
  assert(state, "state required");

  const response = await handleFacebookPageConnect(
    new Request(`https://example.test/functions/v1/facebook-page-connect?code=meta-code&state=${encodeURIComponent(state)}`),
    env(),
    active.deps,
  );
  assertEqual(response.status, 302);
  const location = response.headers.get("location") || "";
  assert(location.startsWith("https://ai.banhmique.vn/marketing-sales/facebook-page?facebook_connect=success"));
  assert(location.includes("facebook_page=BMQ+Main") || location.includes("facebook_page=BMQ%20Main"));
  assert(!location.includes("page-token-secret"));
  assert(!location.includes("1234567890"));
  assertEqual((active.calls.stateConsume as unknown[]).length, 1);
  assertEqual((active.calls.exchangeCode as unknown[]).length, 1);
  assertEqual((active.calls.exchangeLong as Record<string, unknown>[])[0].accessToken, "short-user-token");
  assertEqual((active.calls.pages as Record<string, unknown>[])[0].accessToken, "long-user-token");
  const subscribed = (active.calls.subscribe as Record<string, unknown>[])[0];
  assertEqual(subscribed.pageId, "1234567890");
  assertEqual(subscribed.pageAccessToken, "page-token-secret");
  assertEqual((active.calls.subscribe as unknown[]).length, 1);
  assertEqual((active.calls.storeAuth as unknown[]).length, 0, "final token storage must not be a separate RPC");
  assertEqual((active.calls.markConnected as unknown[]).length, 0, "page binding must not be marked by a separate RPC");
  const committed = (active.calls.commitConnection as Record<string, unknown>[])[0];
  assertEqual((active.calls.commitConnection as unknown[]).length, 1, "final token and page binding must commit via one atomic RPC");
  assertEqual(committed.pageId, "1234567890");
  assertEqual(committed.pageName, "BMQ Main");
  assertEqual(committed.pageAccessToken, "page-token-secret");
  assertEqual(committed.actorId, USER_ID);
});

Deno.test("callback fails closed unless Page tasks/perms explicitly prove MESSAGING and MANAGE", async () => {
  const absentProof = deps({
    fetchPages: async () => [{ id: "1234567890", name: "BMQ Main", accessToken: "page-token-secret" }],
  });
  const absentStarted = await json(await handleFacebookPageConnect(post({ action: "start", expected_page_id: "1234567890" }), env(), absentProof.deps));
  const absentState = new URL(String(absentStarted.authUrl)).searchParams.get("state");
  const absentResponse = await handleFacebookPageConnect(
    new Request(`https://example.test/functions/v1/facebook-page-connect?code=meta-code&state=${encodeURIComponent(absentState || "")}`),
    env(),
    absentProof.deps,
  );
  assert((absentResponse.headers.get("location") || "").includes("facebook_connect_error=page_not_authorized"));
  assertEqual((absentProof.calls.subscribe as unknown[]).length, 0);
  assertEqual((absentProof.calls.commitConnection as unknown[]).length, 0);

  const partialProof = deps({
    fetchPages: async () => [{ id: "1234567890", name: "BMQ Main", accessToken: "page-token-secret", perms: ["MESSAGING"] }],
  });
  const partialStarted = await json(await handleFacebookPageConnect(post({ action: "start", expected_page_id: "1234567890" }), env(), partialProof.deps));
  const partialState = new URL(String(partialStarted.authUrl)).searchParams.get("state");
  const partialResponse = await handleFacebookPageConnect(
    new Request(`https://example.test/functions/v1/facebook-page-connect?code=meta-code&state=${encodeURIComponent(partialState || "")}`),
    env(),
    partialProof.deps,
  );
  assert((partialResponse.headers.get("location") || "").includes("facebook_connect_error=page_not_authorized"));
  assertEqual((partialProof.calls.subscribe as unknown[]).length, 0);
  assertEqual((partialProof.calls.commitConnection as unknown[]).length, 0);
});

Deno.test("callback rechecks stored actor owner-or-edit before Graph", async () => {
  const noLongerApproved = deps({
    isOwner: async () => false,
    hasModulePermission: async (_userId, _moduleKey, mode) => mode === "view",
    consumeOAuthState: async () => ({ actorId: USER_ID, redirectUrl: "https://ai.banhmique.vn/marketing-sales/facebook-page", expectedPageId: null }),
  });
  const started = await json(await handleFacebookPageConnect(post({ action: "start" }), env(), deps().deps));
  const state = new URL(String(started.authUrl)).searchParams.get("state");
  const response = await handleFacebookPageConnect(
    new Request(`https://example.test/functions/v1/facebook-page-connect?code=meta-code&state=${encodeURIComponent(state || "")}`),
    env(),
    noLongerApproved.deps,
  );
  assertEqual(response.status, 302);
  assert((response.headers.get("location") || "").includes("facebook_connect_error=forbidden"));
  assertEqual((noLongerApproved.calls.exchangeCode as unknown[]).length, 0);
});

Deno.test("callback stores multiple Page candidates server-side and finalize chooses by candidate id", async () => {
  const multiple = deps({
    consumeOAuthState: async () => ({ actorId: USER_ID, redirectUrl: "https://ai.banhmique.vn/marketing-sales/facebook-page", expectedPageId: null }),
  });
  const started = await json(await handleFacebookPageConnect(post({ action: "start" }), env(), multiple.deps));
  const state = new URL(String(started.authUrl)).searchParams.get("state");
  const multiResponse = await handleFacebookPageConnect(
    new Request(`https://example.test/functions/v1/facebook-page-connect?code=meta-code&state=${encodeURIComponent(state || "")}`),
    env(),
    multiple.deps,
  );
  assertEqual(multiResponse.status, 302);
  assert((multiResponse.headers.get("location") || "").includes("facebook_connect=select_page"));
  assertEqual((multiple.calls.storeCandidates as unknown[]).length, 1);
  assertEqual((multiple.calls.subscribe as unknown[]).length, 0);
  assertEqual((multiple.calls.storeAuth as unknown[]).length, 0);
  const stored = (multiple.calls.storeCandidates as Record<string, unknown>[])[0];
  assertEqual(stored.actorId, USER_ID);
  assert(!JSON.stringify(multiResponse.headers.get("location") || "").includes("1234567890"));
  assert(!JSON.stringify(stored).includes("long-user-token"));

  const finalized = await handleFacebookPageConnect(post({ action: "finalize_candidate", candidate_id: "candidate-2" }), env(), multiple.deps);
  assertEqual(finalized.status, 200);
  assertEqual((multiple.calls.consumeCandidate as Record<string, unknown>[])[0].candidateId, "candidate-2");
  assertEqual((multiple.calls.subscribe as Record<string, unknown>[])[0].pageAccessToken, "page-token-secret");
  assertEqual((multiple.calls.storeAuth as unknown[]).length, 0, "candidate finalization must not split token/page binding RPCs");
  assertEqual((multiple.calls.markConnected as unknown[]).length, 0, "candidate finalization must not split token/page binding RPCs");
  assertEqual((multiple.calls.commitConnection as Record<string, unknown>[])[0].pageAccessToken, "page-token-secret");
});

Deno.test("callback returns distinct safe failures for token exchange and subscription", async () => {
  const tokenFailed = deps({ exchangeCode: async () => { throw new Error("graph_down"); } });
  const tokenStarted = await json(await handleFacebookPageConnect(post({ action: "start", expected_page_id: "1234567890" }), env(), tokenFailed.deps));
  const tokenState = new URL(String(tokenStarted.authUrl)).searchParams.get("state");
  const tokenResponse = await handleFacebookPageConnect(
    new Request(`https://example.test/functions/v1/facebook-page-connect?code=meta-code&state=${encodeURIComponent(tokenState || "")}`),
    env(),
    tokenFailed.deps,
  );
  assert((tokenResponse.headers.get("location") || "").includes("facebook_connect_error=token_exchange_failed"));

  const subscriptionFailed = deps({ subscribePageWebhooks: async () => { throw new Error("subscription_failed"); } });
  const subStarted = await json(await handleFacebookPageConnect(post({ action: "start", expected_page_id: "1234567890" }), env(), subscriptionFailed.deps));
  const subState = new URL(String(subStarted.authUrl)).searchParams.get("state");
  const subResponse = await handleFacebookPageConnect(
    new Request(`https://example.test/functions/v1/facebook-page-connect?code=meta-code&state=${encodeURIComponent(subState || "")}`),
    env(),
    subscriptionFailed.deps,
  );
  assert((subResponse.headers.get("location") || "").includes("facebook_connect_error=subscription_failed"));
  assertEqual((subscriptionFailed.calls.storeAuth as unknown[]).length, 0);
});

Deno.test("callback fails closed for invalid state and missing requested Page", async () => {
  const invalidState = deps();
  const invalid = await handleFacebookPageConnect(
    new Request("https://example.test/functions/v1/facebook-page-connect?code=meta-code&state=bad-state"),
    env(),
    invalidState.deps,
  );
  assertEqual(invalid.status, 302);
  assert((invalid.headers.get("location") || "").includes("facebook_connect_error=invalid_state"));
  assertEqual((invalidState.calls.exchangeCode as unknown[]).length, 0);

  const missing = deps({
    fetchPages: async () => [{ id: "9999999999", name: "Wrong Page", accessToken: "wrong-page-token", tasks: ["MESSAGING", "MANAGE"] }],
  });
  const missingStarted = await json(await handleFacebookPageConnect(post({ action: "start", expected_page_id: "1234567890" }), env(), missing.deps));
  const missingState = new URL(String(missingStarted.authUrl)).searchParams.get("state");
  const missingResponse = await handleFacebookPageConnect(
    new Request(`https://example.test/functions/v1/facebook-page-connect?code=meta-code&state=${encodeURIComponent(missingState || "")}`),
    env(),
    missing.deps,
  );
  assertEqual(missingResponse.status, 302);
  assert((missingResponse.headers.get("location") || "").includes("facebook_connect_error=page_not_authorized"));
  assertEqual((missing.calls.subscribe as unknown[]).length, 0);
  assertEqual((missing.calls.storeAuth as unknown[]).length, 0);
});
