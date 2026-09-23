import assert from "node:assert/strict";

import {
  KfmCookieJar,
  KfmPortalError,
  loginWithPassword,
  openSessionWithLoginGuard,
  type KfmPasswordLoginGuard,
  type KfmPasswordLoginLease,
} from "./kfm-portal.ts";

function setCookieResponse(lines: string[], url = "https://sso.seedcom.vn/uaa/oauth2/authorize"): Response {
  const headers = new Headers();
  for (const line of lines) headers.append("set-cookie", line);
  const response = new Response(null, { headers });
  new KfmCookieJar().absorb(response, url);
  return response;
}

Deno.test("cookie jar scopes same-name cookies by domain, path, secure, and expiry", () => {
  const jar = new KfmCookieJar();
  const origin = "https://sso.seedcom.vn/uaa/oauth2/authorize";
  jar.absorb(setCookieResponse([
    "sid=root; Path=/; Domain=seedcom.vn",
    "sid=uaa; Path=/uaa; Secure",
    "hostOnly=only-sso; Path=/uaa",
    "parent=domain; Domain=.seedcom.vn; Path=/uaa",
    "expired=private; Path=/uaa; Max-Age=0",
    "old=private; Path=/uaa; Expires=Wed, 01 Jan 2020 00:00:00 GMT",
  ]), origin);

  assert.equal(
    jar.header("https://sso.seedcom.vn/uaa/login"),
    "sid=uaa; hostOnly=only-sso; parent=domain; sid=root",
  );
  assert.equal(
    jar.header("https://child.seedcom.vn/uaa/login"),
    "parent=domain; sid=root",
  );
  assert.equal(jar.header("http://sso.seedcom.vn/uaa/login"), "hostOnly=only-sso; parent=domain; sid=root");
  assert.equal(jar.header("https://sso.seedcom.vn/other"), "sid=root");

  jar.absorb(setCookieResponse(["sid=; Path=/uaa; Max-Age=0"]), "https://sso.seedcom.vn/uaa/login");
  assert.equal(
    jar.header("https://sso.seedcom.vn/uaa/login"),
    "hostOnly=only-sso; parent=domain; sid=root",
  );
});

Deno.test("cookie jar ignores invalid Max-Age so an expired Expires deletes the scoped cookie", () => {
  const jar = new KfmCookieJar();
  const origin = "https://sso.seedcom.vn/uaa/login";
  jar.absorb(setCookieResponse([
    "sid=keep-root; Path=/",
    "sid=replace-me; Path=/uaa",
  ]), origin);
  jar.absorb(setCookieResponse([
    "sid=ignored; Path=/uaa; Max-Age=invalid; Expires=Wed, 01 Jan 2020 00:00:00 GMT",
  ]), origin);
  assert.equal(jar.header(origin), "sid=keep-root");
});

Deno.test("cookie jar replaces the same domain and path when host-only changes", () => {
  const jar = new KfmCookieJar();
  const origin = "https://sso.seedcom.vn/uaa/login";
  jar.absorb(setCookieResponse(["sid=host-only; Path=/uaa"]), origin);
  jar.absorb(setCookieResponse(["sid=domain; Domain=sso.seedcom.vn; Path=/uaa"]), origin);
  assert.equal(jar.header(origin), "sid=domain");
});

type CallbackStateVariant = "missing" | "empty" | "wrong";

async function assertCallbackStateRejectsBeforeExchange(variant: CallbackStateVariant): Promise<void> {
  const originalFetch = globalThis.fetch;
  let generatedState = "";
  let exchangeCalls = 0;
  try {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method || "GET";
      if (url.pathname.endsWith("/oauth2/authorize")) {
        generatedState = url.searchParams.get("state") || "";
        assert.notEqual(generatedState, "");
        return Promise.resolve(new Response(null, { status: 302, headers: { location: "/uaa/login" } }));
      }
      if (url.pathname.endsWith("/login") && method !== "POST") {
        return Promise.resolve(new Response('<form action="/uaa/login"><input name="_csrf" value="CSRF_PRIVATE_STATE"></form>', { status: 200 }));
      }
      if (url.pathname.endsWith("/login") && method === "POST") {
        const stateQuery = variant === "missing" ? "" : variant === "empty" ? "&state=" : `&state=${generatedState}_WRONG`;
        return Promise.resolve(new Response(null, { status: 302, headers: { location: `https://partners.seedcom.vn/sce/oauth?code=CODE_PRIVATE_STATE${stateQuery}` } }));
      }
      if (url.pathname.endsWith("/exchange")) {
        exchangeCalls += 1;
        throw new Error(`callback state ${variant} reached token exchange`);
      }
      throw new Error(`unexpected fetch ${method} ${url}`);
    }) as typeof fetch;

    await assert.rejects(
      () => loginWithPassword("USER_PRIVATE_STATE", "PASSWORD_PRIVATE_STATE"),
      (error) => {
        assert.ok(error instanceof KfmPortalError, error instanceof Error ? error.message : String(error));
        assert.equal(error.step, "login");
        assert.equal(error.message, "SSO trả về state không khớp");
        return true;
      },
    );
    assert.equal(exchangeCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

Deno.test("login rejects callback code with missing OAuth state before token exchange", () => assertCallbackStateRejectsBeforeExchange("missing"));

Deno.test("login rejects callback code with empty OAuth state before token exchange", () => assertCallbackStateRejectsBeforeExchange("empty"));

Deno.test("login rejects callback code with wrong OAuth state before token exchange", () => assertCallbackStateRejectsBeforeExchange("wrong"));

Deno.test("login follows POST-relative redirects against the previous URL and exchanges the resolved callback", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ method: string; url: URL; cookie: string; body: string }> = [];
  let state = "";
  try {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method || "GET";
      const cookie = new Headers(init?.headers).get("cookie") || "";
      const body = String(init?.body || "");
      calls.push({ method, url, cookie, body });
      if (calls.length === 1) {
        state = url.searchParams.get("state") || "";
        const headers = new Headers({ location: "/uaa/login" });
        headers.append("set-cookie", "same=root; Path=/; Domain=seedcom.vn");
        headers.append("set-cookie", "same=uaa; Path=/uaa; Secure");
        headers.append("set-cookie", "gone=private; Path=/uaa; Max-Age=0");
        return Promise.resolve(new Response(null, { status: 302, headers }));
      }
      if (calls.length === 2) {
        assert.equal(cookie, "same=uaa; same=root");
        return Promise.resolve(new Response('<form action="login"><input name="_csrf" value="CSRF_PRIVATE"></form>', { status: 200 }));
      }
      if (calls.length === 3) {
        assert.equal(url.toString(), "https://sso.seedcom.vn/uaa/login");
        assert.equal(cookie, "same=uaa; same=root");
        assert.equal(method, "POST");
        assert.ok(body.includes("username=USER_PRIVATE"));
        assert.ok(body.includes("password=PASSWORD_PRIVATE"));
        return Promise.resolve(new Response(null, { status: 302, headers: { location: "continue" } }));
      }
      if (calls.length === 4) {
        assert.equal(url.toString(), "https://sso.seedcom.vn/uaa/continue");
        assert.equal(cookie, "same=uaa; same=root");
        return Promise.resolve(new Response(null, { status: 302, headers: { location: `https://partners.seedcom.vn/sce/oauth?code=CODE_PRIVATE&state=${state}` } }));
      }
      if (calls.length === 5) {
        assert.equal(url.toString(), "https://logis.seedcom.vn/sce-api/auth/sso/sce/exchange");
        assert.equal(cookie, "");
        const parsed = JSON.parse(body);
        assert.equal(parsed.code, "CODE_PRIVATE");
        assert.equal(parsed.redirectUri, "https://partners.seedcom.vn/sce/oauth");
        return Promise.resolve(Response.json({ success: true, accessToken: "ACCESS_PRIVATE", refreshToken: "REFRESH_PRIVATE" }));
      }
      throw new Error(`unexpected fetch ${calls.length} ${method} ${url}`);
    }) as typeof fetch;

    const session = await loginWithPassword("USER_PRIVATE", "PASSWORD_PRIVATE");
    assert.equal(session.mode, "login");
    assert.equal(session.token, "ACCESS_PRIVATE");
    assert.notEqual(state, "");
    assert.equal(calls.map((call) => `${call.method} ${call.url.origin}${call.url.pathname}`).join("|"), [
      "GET https://sso.seedcom.vn/uaa/oauth2/authorize",
      "GET https://sso.seedcom.vn/uaa/login",
      "POST https://sso.seedcom.vn/uaa/login",
      "GET https://sso.seedcom.vn/uaa/continue",
      "POST https://logis.seedcom.vn/sce-api/auth/sso/sce/exchange",
    ].join("|"));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("login rejects hostile redirects before following them and never leaks the target", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      const url = new URL(String(input));
      if (calls === 1) return Promise.resolve(new Response(null, { status: 302, headers: { location: "/uaa/login" } }));
      if (calls === 2) return Promise.resolve(new Response('<form action="/uaa/login"><input name="_csrf" value="CSRF_PRIVATE"></form>', { status: 200 }));
      if (init?.method === "POST") {
        assert.equal(url.origin, "https://sso.seedcom.vn");
        return Promise.resolve(new Response(null, { status: 302, headers: { location: "https://evil.example/private?code=CODE_PRIVATE&state=STATE_PRIVATE" } }));
      }
      throw new Error(`hostile redirect was followed: ${url}`);
    }) as typeof fetch;

    await assert.rejects(
      () => loginWithPassword("USER_PRIVATE", "PASSWORD_PRIVATE"),
      (error) => {
        assert.ok(error instanceof KfmPortalError);
        assert.equal(error.step, "login");
        const detail = error.detail || "";
        assert.ok(detail.includes("postRedirect=external"));
        assert.ok(!detail.includes("evil.example"));
        assert.ok(!detail.includes("CODE_PRIVATE"));
        assert.ok(!detail.includes("STATE_PRIVATE"));
        return true;
      },
    );
    assert.equal(calls, 3);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("login rejects hostile replay authorize callbacks before parsing code", async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ method: string; url: URL; body: string }> = [];
  let state = "";
  const codeSentinel = "CODE_PRIVATE_REPLAY";
  const stateSentinelSuffix = "STATE_PRIVATE_REPLAY";
  try {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method || "GET";
      const body = String(init?.body || "");
      calls.push({ method, url, body });
      if (calls.length === 1) {
        state = `${url.searchParams.get("state") || ""}${stateSentinelSuffix}`;
        return Promise.resolve(new Response(null, { status: 302, headers: { location: "/uaa/login" } }));
      }
      if (calls.length === 2) {
        return Promise.resolve(new Response('<form action="/uaa/login"><input name="_csrf" value="CSRF_PRIVATE_REPLAY"></form>', { status: 200 }));
      }
      if (calls.length === 3) {
        assert.equal(method, "POST");
        return Promise.resolve(new Response(null, { status: 302, headers: { location: "/login?error=authorize" } }));
      }
      if (calls.length === 4) {
        assert.equal(url.pathname, "/uaa/oauth2/authorize");
        state = url.searchParams.get("state") || "";
        return Promise.resolve(new Response(null, { status: 302, headers: { location: `https://evil.example/private?code=${codeSentinel}&state=${state}` } }));
      }
      if (url.pathname.endsWith("/exchange")) {
        throw new Error("hostile replay callback must not be exchanged");
      }
      throw new Error(`unexpected fetch ${calls.length} ${method} ${url}`);
    }) as typeof fetch;

    await assert.rejects(
      () => loginWithPassword("USER_PRIVATE_REPLAY", "PASSWORD_PRIVATE_REPLAY"),
      (error) => {
        assert.ok(error instanceof KfmPortalError);
        assert.equal(error.step, "login");
        const detail = error.detail || "";
        assert.ok(detail.includes("postRedirect=/login?error"));
        assert.ok(detail.includes("replayRedirect=external?state,code") || detail.includes("replayRedirect=external?code,state"));
        assert.ok(!detail.includes("evil.example"));
        assert.ok(!detail.includes(codeSentinel));
        assert.ok(!detail.includes(state));
        assert.ok(!detail.includes(stateSentinelSuffix));
        return true;
      },
    );
    assert.equal(calls.length, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("login rejects direct callbacks with missing, empty, or wrong state before exchange", async () => {
  for (const callbackState of [null, "", "WRONG_STATE_PRIVATE"]) {
    const originalFetch = globalThis.fetch;
    let expectedState = "";
    let exchangeCalls = 0;
    try {
      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/oauth2/authorize")) {
          expectedState = url.searchParams.get("state") || "";
          return Promise.resolve(new Response(null, { status: 302, headers: { location: "/uaa/login" } }));
        }
        if (url.pathname.endsWith("/login") && init?.method !== "POST") {
          return Promise.resolve(new Response('<form action="/uaa/login"><input name="_csrf" value="CSRF_PRIVATE_STATE"></form>', { status: 200 }));
        }
        if (url.pathname.endsWith("/login") && init?.method === "POST") {
          const statePart = callbackState === null ? "" : `&state=${callbackState}`;
          return Promise.resolve(new Response(null, { status: 302, headers: { location: `https://partners.seedcom.vn/sce/oauth?code=CODE_PRIVATE_STATE${statePart}` } }));
        }
        if (url.pathname.endsWith("/exchange")) {
          exchangeCalls += 1;
          return Promise.resolve(Response.json({ success: true, accessToken: "ACCESS_PRIVATE_STATE", refreshToken: "REFRESH_PRIVATE_STATE" }));
        }
        throw new Error(`unexpected fetch ${url}`);
      }) as typeof fetch;

      await assert.rejects(
        () => loginWithPassword("USER_PRIVATE_STATE", "PASSWORD_PRIVATE_STATE"),
        (error) => {
          assert.ok(error instanceof KfmPortalError);
          assert.equal(error.step, "login");
          assert.equal(error.message, "SSO trả về state không khớp");
          return true;
        },
      );
      assert.notEqual(callbackState, expectedState);
      assert.equal(exchangeCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

Deno.test("login rejects replay callbacks with missing, empty, or wrong state before exchange", async () => {
  for (const callbackState of [null, "", "WRONG_STATE_PRIVATE_REPLAY"]) {
    const originalFetch = globalThis.fetch;
    let expectedState = "";
    let passwordPosts = 0;
    let exchangeCalls = 0;
    try {
      globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/oauth2/authorize")) {
          expectedState = url.searchParams.get("state") || "";
          if (passwordPosts > 0) {
            const statePart = callbackState === null ? "" : `&state=${callbackState}`;
            return Promise.resolve(new Response(null, { status: 302, headers: { location: `https://partners.seedcom.vn/sce/oauth?code=CODE_PRIVATE_REPLAY_STATE${statePart}` } }));
          }
          return Promise.resolve(new Response(null, { status: 302, headers: { location: "/uaa/login" } }));
        }
        if (url.pathname.endsWith("/login") && init?.method !== "POST") {
          return Promise.resolve(new Response('<form action="/uaa/login"><input name="_csrf" value="CSRF_PRIVATE_REPLAY_STATE"></form>', { status: 200 }));
        }
        if (url.pathname.endsWith("/login") && init?.method === "POST") {
          passwordPosts += 1;
          return Promise.resolve(new Response(null, { status: 302, headers: { location: "/login?error=authorize" } }));
        }
        if (url.pathname.endsWith("/exchange")) {
          exchangeCalls += 1;
          return Promise.resolve(Response.json({ success: true, accessToken: "ACCESS_PRIVATE_REPLAY_STATE", refreshToken: "REFRESH_PRIVATE_REPLAY_STATE" }));
        }
        throw new Error(`unexpected fetch ${url}`);
      }) as typeof fetch;

      await assert.rejects(
        () => loginWithPassword("USER_PRIVATE_REPLAY_STATE", "PASSWORD_PRIVATE_REPLAY_STATE"),
        (error) => {
          assert.ok(error instanceof KfmPortalError);
          assert.equal(error.step, "login");
          assert.equal(error.message, "SSO trả về state không khớp");
          return true;
        },
      );
      assert.notEqual(callbackState, expectedState);
      assert.equal(exchangeCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  }
});

Deno.test("login preserves replay fallback when authorize returns the registered callback", async () => {
  const originalFetch = globalThis.fetch;
  let state = "";
  let exchangeCalls = 0;
  try {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/oauth2/authorize")) {
        state = url.searchParams.get("state") || state;
        if (init?.method === "POST") throw new Error("authorize must not be posted");
        if (state && exchangeCalls === 0 && url.searchParams.has("code_challenge")) {
          const isReplay = state !== "" && callsAfterPost > 0;
          if (isReplay) {
            return Promise.resolve(new Response(null, { status: 302, headers: { location: `https://partners.seedcom.vn/sce/oauth?code=CODE_PRIVATE_REPLAY_OK&state=${state}` } }));
          }
        }
        return Promise.resolve(new Response(null, { status: 302, headers: { location: "/uaa/login" } }));
      }
      if (url.pathname.endsWith("/login") && init?.method !== "POST") {
        return Promise.resolve(new Response('<form action="/uaa/login"><input name="_csrf" value="CSRF_PRIVATE_REPLAY_OK"></form>', { status: 200 }));
      }
      if (url.pathname.endsWith("/login") && init?.method === "POST") {
        callsAfterPost += 1;
        return Promise.resolve(new Response(null, { status: 302, headers: { location: "/login?error=authorize" } }));
      }
      if (url.pathname.endsWith("/exchange")) {
        exchangeCalls += 1;
        const parsed = JSON.parse(String(init?.body || "{}"));
        assert.equal(parsed.code, "CODE_PRIVATE_REPLAY_OK");
        assert.equal(parsed.redirectUri, "https://partners.seedcom.vn/sce/oauth");
        return Promise.resolve(Response.json({ success: true, accessToken: "ACCESS_PRIVATE_REPLAY_OK", refreshToken: "REFRESH_PRIVATE_REPLAY_OK" }));
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;
    let callsAfterPost = 0;

    const session = await loginWithPassword("USER_PRIVATE_REPLAY_OK", "PASSWORD_PRIVATE_REPLAY_OK");
    assert.equal(session.token, "ACCESS_PRIVATE_REPLAY_OK");
    assert.equal(exchangeCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("guarded session allows exactly one password login during a shared cooldown", async () => {
  const originalFetch = globalThis.fetch;
  let passwordPosts = 0;
  let state = "";
  const guard = new FakePasswordGuard();
  try {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/refresh")) throw new Error("refresh must not be called without refresh token");
      if (url.pathname.endsWith("/oauth2/authorize")) {
        state = url.searchParams.get("state") || "";
        return Promise.resolve(new Response(null, { status: 302, headers: { location: "/uaa/login" } }));
      }
      if (url.pathname.endsWith("/login") && init?.method !== "POST") {
        return Promise.resolve(new Response('<form action="/uaa/login"><input name="_csrf" value="CSRF_PRIVATE"></form>', { status: 200 }));
      }
      if (url.pathname.endsWith("/login") && init?.method === "POST") {
        passwordPosts += 1;
        return Promise.resolve(new Response(null, { status: 302, headers: { location: `https://partners.seedcom.vn/sce/oauth?code=CODE_PRIVATE&state=${state}` } }));
      }
      if (url.pathname.endsWith("/exchange")) {
        return Promise.resolve(Response.json({ success: true, accessToken: "ACCESS_PRIVATE", refreshToken: "REFRESH_PRIVATE" }));
      }
      throw new Error(`unexpected fetch ${url}`);
    }) as typeof fetch;

    const results = await Promise.allSettled([
      openSessionWithLoginGuard({ username: "USER_PRIVATE", password: "PASSWORD_PRIVATE" }, guard),
      openSessionWithLoginGuard({ username: "USER_PRIVATE", password: "PASSWORD_PRIVATE" }, guard),
      openSessionWithLoginGuard({ username: "USER_PRIVATE", password: "PASSWORD_PRIVATE" }, guard),
    ]);
    assert.equal(passwordPosts, 1);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 2);
    assert.equal(guard.acquireCalls, 3);
    assert.equal(guard.released.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("guarded session reuses a shared access session across cold isolates during cooldown", async () => {
  const originalFetch = globalThis.fetch;
  let passwordPosts = 0;
  let meReads = 0;
  let state = "";
  const guard = new FakePasswordGuard();
  const store = new FakeSharedSessionStore();
  try {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/oauth2/authorize")) {
        state = url.searchParams.get("state") || "";
        return Promise.resolve(new Response(null, { status: 302, headers: { location: "/uaa/login" } }));
      }
      if (url.pathname.endsWith("/login") && init?.method !== "POST") {
        return Promise.resolve(new Response('<form action="/uaa/login"><input name="_csrf" value="CSRF_PRIVATE_SHARED"></form>', { status: 200 }));
      }
      if (url.pathname.endsWith("/login") && init?.method === "POST") {
        passwordPosts += 1;
        return Promise.resolve(new Response(null, { status: 302, headers: { location: `https://partners.seedcom.vn/sce/oauth?code=CODE_PRIVATE_SHARED&state=${state}` } }));
      }
      if (url.pathname.endsWith("/exchange")) {
        return Promise.resolve(Response.json({ success: true, accessToken: "ACCESS_PRIVATE_SHARED", refreshToken: "" }));
      }
      if (url.pathname.endsWith("/portal/me")) {
        meReads += 1;
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer ACCESS_PRIVATE_SHARED");
        return Promise.resolve(Response.json({ data: { vendorIds: [217], vendorCode: "V000217" } }));
      }
      throw new Error(`unexpected fetch ${init?.method || "GET"} ${url}`);
    }) as typeof fetch;

    const isolateA = await openSessionWithLoginGuard(
      { username: "USER_PRIVATE_SHARED", password: "PASSWORD_PRIVATE_SHARED" },
      guard,
      store,
    );
    const isolateB = await openSessionWithLoginGuard(
      { username: "USER_PRIVATE_SHARED", password: "PASSWORD_PRIVATE_SHARED" },
      guard,
      store,
    );

    assert.equal(isolateA.token, "ACCESS_PRIVATE_SHARED");
    assert.equal(isolateB.token, "ACCESS_PRIVATE_SHARED");
    assert.ok(isolateA.sharedGeneration, "fresh publisher must retain the exact generation for invalidation");
    assert.equal(isolateA.sharedGeneration, isolateB.sharedGeneration);
    assert.equal(passwordPosts, 1);
    assert.equal(meReads, 1);
    assert.equal(guard.acquireCalls, 1);
    assert.equal(store.reads, 2);
    assert.equal(store.publishes, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("guarded session invalidates expired shared sessions and keeps the password gate", async () => {
  const originalFetch = globalThis.fetch;
  let passwordPosts = 0;
  let state = "";
  const guard = new FakePasswordGuard();
  const store = new FakeSharedSessionStore({
    token: "ACCESS_PRIVATE_EXPIRED",
    expiresAt: new Date(Date.now() - 1_000).toISOString(),
    generation: "expired-generation",
  });
  try {
    globalThis.fetch = mockPasswordLoginFetch({
      accessToken: "ACCESS_PRIVATE_AFTER_EXPIRED",
      onAuthorize: (nextState) => state = nextState,
      onPasswordPost: () => passwordPosts += 1,
      state: () => state,
    });

    const session = await openSessionWithLoginGuard(
      { username: "USER_PRIVATE_EXPIRED", password: "PASSWORD_PRIVATE_EXPIRED" },
      guard,
      store,
    );

    assert.equal(session.token, "ACCESS_PRIVATE_AFTER_EXPIRED");
    assert.equal(passwordPosts, 1);
    assert.deepEqual(store.invalidatedGenerations, ["expired-generation"]);
    assert.equal(guard.acquireCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("guarded session invalidates exact bad shared generation and fails closed without password fallback", async () => {
  const originalFetch = globalThis.fetch;
  let passwordPosts = 0;
  let state = "";
  const guard = new FakePasswordGuard();
  const badGeneration = "bad-generation";
  const tokenSecret = "ACCESS_PRIVATE_BAD_SHARED";
  const store = new FakeSharedSessionStore({
    token: tokenSecret,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    generation: badGeneration,
  });
  try {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/portal/me")) {
        assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${tokenSecret}`);
        return Promise.resolve(Response.json({ error: "TOKEN_PRIVATE_PROVIDER" }, { status: 401 }));
      }
      return mockPasswordLoginFetch({
        accessToken: "ACCESS_PRIVATE_AFTER_BAD",
        onAuthorize: (nextState) => state = nextState,
        onPasswordPost: () => passwordPosts += 1,
        state: () => state,
      })(input, init);
    }) as typeof fetch;

    await assert.rejects(
      () => openSessionWithLoginGuard(
        { username: "USER_PRIVATE_BAD", password: "PASSWORD_PRIVATE_BAD" },
        guard,
        store,
      ),
      (error) => error instanceof KfmPortalError && error.step === "me" && error.status === 401,
    );

    assert.equal(passwordPosts, 0);
    assert.equal(guard.acquireCalls, 0);
    assert.deepEqual(store.invalidatedGenerations, [badGeneration]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("guarded session reuses provider-validated shared token at t+120 without repeating password", async () => {
  const originalFetch = globalThis.fetch;
  const originalDateNow = Date.now;
  let now = 1_000_000;
  let passwordPosts = 0;
  let meReads = 0;
  let state = "";
  const guard = new FakePasswordGuard(() => now);
  const store = new FakeSharedSessionStore(null, { now: () => now, publishTtlMs: 900_000 });
  try {
    Date.now = () => now;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/portal/me")) {
        meReads += 1;
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer ACCESS_PRIVATE_TTL_COVERAGE");
        return Promise.resolve(Response.json({ data: { vendorIds: [217], vendorCode: "V000217" } }));
      }
      return mockPasswordLoginFetch({
        accessToken: "ACCESS_PRIVATE_TTL_COVERAGE",
        onAuthorize: (nextState) => state = nextState,
        onPasswordPost: () => passwordPosts += 1,
        state: () => state,
      })(input, init);
    }) as typeof fetch;

    const first = await openSessionWithLoginGuard(
      { username: "USER_PRIVATE_TTL", password: "PASSWORD_PRIVATE_TTL" },
      guard,
      store,
    );
    now += 120_000;
    const second = await openSessionWithLoginGuard(
      { username: "USER_PRIVATE_TTL", password: "PASSWORD_PRIVATE_TTL" },
      guard,
      store,
    );

    assert.equal(first.token, "ACCESS_PRIVATE_TTL_COVERAGE");
    assert.equal(second.token, "ACCESS_PRIVATE_TTL_COVERAGE");
    assert.equal(passwordPosts, 1);
    assert.equal(meReads, 1);
    assert.equal(guard.acquireCalls, 1);
  } finally {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
  }
});

Deno.test("guarded session rechecks shared store after losing the lease", async () => {
  const originalFetch = globalThis.fetch;
  const guard: KfmPasswordLoginGuard = {
    acquirePasswordLoginLease: () => Promise.resolve({ acquired: false, retryAfterSeconds: 300, reason: "cooldown" }),
    releasePasswordLoginLease: () => Promise.reject(new Error("must not release without lease")),
  };
  const store = new FakeSharedSessionStore(null, {
    afterReads: {
      2: {
        token: "ACCESS_PRIVATE_AFTER_LOST_LEASE",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        generation: "winner-generation",
      },
    },
  });
  try {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/portal/me")) {
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer ACCESS_PRIVATE_AFTER_LOST_LEASE");
        return Promise.resolve(Response.json({ data: { vendorIds: [217] } }));
      }
      throw new Error(`password flow must not run after lost lease recheck: ${url}`);
    }) as typeof fetch;

    const session = await openSessionWithLoginGuard(
      { username: "USER_PRIVATE_LOST", password: "PASSWORD_PRIVATE_LOST" },
      guard,
      store,
    );

    assert.equal(session.token, "ACCESS_PRIVATE_AFTER_LOST_LEASE");
    assert.equal(store.reads, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("guarded session waits briefly for in-flight winner instead of repeating password", async () => {
  const originalFetch = globalThis.fetch;
  const guard: KfmPasswordLoginGuard = {
    acquirePasswordLoginLease: () => Promise.resolve({ acquired: false, retryAfterSeconds: 1, reason: "in_flight" }),
    releasePasswordLoginLease: () => Promise.reject(new Error("must not release without lease")),
  };
  const store = new FakeSharedSessionStore(null, {
    afterReads: {
      4: {
        token: "ACCESS_PRIVATE_AFTER_IN_FLIGHT",
        expiresAt: new Date(Date.now() + 900_000).toISOString(),
        generation: "winner-generation",
      },
    },
  });
  try {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/portal/me")) {
        assert.equal(new Headers(init?.headers).get("authorization"), "Bearer ACCESS_PRIVATE_AFTER_IN_FLIGHT");
        return Promise.resolve(Response.json({ data: { vendorIds: [217] } }));
      }
      throw new Error(`password flow must not run while waiting for winner: ${url}`);
    }) as typeof fetch;

    const session = await openSessionWithLoginGuard(
      { username: "USER_PRIVATE_IN_FLIGHT", password: "PASSWORD_PRIVATE_IN_FLIGHT" },
      guard,
      store,
    );

    assert.equal(session.token, "ACCESS_PRIVATE_AFTER_IN_FLIGHT");
    assert.equal(store.reads, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("guarded session fails closed on shared store read and publish errors without leaking secrets", async () => {
  const originalFetch = globalThis.fetch;
  const privateStorage = "DB_PRIVATE_SHARED_SESSION";
  try {
    const readFailure = new FakeSharedSessionStore(null, { readError: new Error(privateStorage) });
    await assert.rejects(
      () => openSessionWithLoginGuard(
        { username: "USER_PRIVATE_READ", password: "PASSWORD_PRIVATE_READ" },
        new FakePasswordGuard(),
        readFailure,
      ),
      (error) => {
        assert.ok(error instanceof KfmPortalError);
        assert.equal(error.step, "login_guard");
        assert.ok(!error.message.includes(privateStorage));
        return true;
      },
    );

    let state = "";
    let passwordPosts = 0;
    globalThis.fetch = mockPasswordLoginFetch({
      accessToken: "ACCESS_PRIVATE_PUBLISH",
      onAuthorize: (nextState) => state = nextState,
      onPasswordPost: () => passwordPosts += 1,
      state: () => state,
    });
    const publishFailure = new FakeSharedSessionStore(null, { publishError: new Error(privateStorage) });
    const guard = new FakePasswordGuard();
    await assert.rejects(
      () => openSessionWithLoginGuard(
        { username: "USER_PRIVATE_PUBLISH", password: "PASSWORD_PRIVATE_PUBLISH" },
        guard,
        publishFailure,
      ),
      (error) => {
        assert.ok(error instanceof KfmPortalError);
        assert.equal(error.step, "login_guard");
        assert.ok(!error.message.includes(privateStorage));
        assert.ok(!error.message.includes("ACCESS_PRIVATE_PUBLISH"));
        return true;
      },
    );
    assert.equal(passwordPosts, 1);
    assert.equal(guard.released[0]?.outcome, "error");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("guarded session blocks cooldown repeats, fails closed, bypasses lease on refresh, and releases by CAS token", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const cooldownGuard = new FakePasswordGuard();
    await cooldownGuard.acquirePasswordLoginLease();
    await assert.rejects(
      () => openSessionWithLoginGuard({ username: "USER_PRIVATE", password: "PASSWORD_PRIVATE" }, cooldownGuard),
      (error) => error instanceof KfmPortalError && error.step === "login_guard",
    );

    const failingGuard: KfmPasswordLoginGuard = {
      acquirePasswordLoginLease: () => Promise.reject(new Error("DB_PRIVATE")),
      releasePasswordLoginLease: () => Promise.reject(new Error("must not release without lease")),
    };
    await assert.rejects(
      () => openSessionWithLoginGuard({ username: "USER_PRIVATE", password: "PASSWORD_PRIVATE" }, failingGuard),
      (error) => error instanceof KfmPortalError && error.step === "login_guard" && !String(error.message).includes("DB_PRIVATE"),
    );

    let refreshCalls = 0;
    globalThis.fetch = ((input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/refresh")) {
        refreshCalls += 1;
        return Promise.resolve(Response.json({ success: true, token: "ACCESS_FROM_REFRESH", refreshToken: "REFRESH_NEXT" }));
      }
      throw new Error(`password flow should not run on refresh success: ${url}`);
    }) as typeof fetch;
    const bypassGuard = new FakePasswordGuard();
    const refreshed = await openSessionWithLoginGuard({ username: "USER_PRIVATE", password: "PASSWORD_PRIVATE", refreshToken: "REFRESH_PRIVATE" }, bypassGuard);
    assert.equal(refreshed.mode, "refresh");
    assert.equal(refreshCalls, 1);
    assert.equal(bypassGuard.acquireCalls, 0);

    const casGuard = new FakePasswordGuard();
    const lease = await casGuard.acquirePasswordLoginLease();
    assert.equal(lease.acquired, true);
    if (!lease.acquired) throw new Error("expected CAS lease");
    await casGuard.releasePasswordLoginLease("wrong-token", "success");
    assert.equal(casGuard.isLeased(), true);
    await casGuard.releasePasswordLoginLease(lease.leaseToken, "success");
    assert.equal(casGuard.isLeased(), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function mockPasswordLoginFetch(options: {
  accessToken: string;
  onAuthorize: (state: string) => void;
  onPasswordPost: () => void;
  state: () => string;
}): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/oauth2/authorize")) {
      options.onAuthorize(url.searchParams.get("state") || "");
      return Promise.resolve(new Response(null, { status: 302, headers: { location: "/uaa/login" } }));
    }
    if (url.pathname.endsWith("/login") && init?.method !== "POST") {
      return Promise.resolve(new Response('<form action="/uaa/login"><input name="_csrf" value="CSRF_PRIVATE_HELPER"></form>', { status: 200 }));
    }
    if (url.pathname.endsWith("/login") && init?.method === "POST") {
      options.onPasswordPost();
      return Promise.resolve(new Response(null, { status: 302, headers: { location: `https://partners.seedcom.vn/sce/oauth?code=CODE_PRIVATE_HELPER&state=${options.state()}` } }));
    }
    if (url.pathname.endsWith("/exchange")) {
      return Promise.resolve(Response.json({ success: true, accessToken: options.accessToken, refreshToken: "" }));
    }
    throw new Error(`unexpected fetch ${init?.method || "GET"} ${url}`);
  }) as typeof fetch;
}

class FakePasswordGuard implements KfmPasswordLoginGuard {
  acquireCalls = 0;
  released: Array<{ leaseToken: string; outcome: string }> = [];
  private cooldownUntil = 0;
  private leaseToken = "";

  constructor(private now = () => 1_000, private cooldownMs = 300_000) {}

  async acquirePasswordLoginLease(): Promise<KfmPasswordLoginLease> {
    this.acquireCalls += 1;
    if (this.leaseToken || this.now() < this.cooldownUntil) {
      return { acquired: false, retryAfterSeconds: Math.ceil((this.cooldownUntil - this.now()) / 1000), reason: "cooldown" };
    }
    this.leaseToken = crypto.randomUUID();
    this.cooldownUntil = this.now() + this.cooldownMs;
    return { acquired: true, leaseToken: this.leaseToken, retryAfterSeconds: 0, reason: "acquired" };
  }

  async releasePasswordLoginLease(leaseToken: string, outcome: string): Promise<void> {
    this.released.push({ leaseToken, outcome });
    if (this.leaseToken === leaseToken) this.leaseToken = "";
  }

  isLeased(): boolean {
    return Boolean(this.leaseToken);
  }
}

class FakeSharedSessionStore {
  reads = 0;
  publishes = 0;
  invalidatedGenerations: string[] = [];
  private session: { token: string; expiresAt: string; generation: string } | null = null;

  constructor(
    initial: { token: string; expiresAt: string; generation: string } | null = null,
    private options: {
      readError?: Error;
      publishError?: Error;
      afterReads?: Record<number, { token: string; expiresAt: string; generation: string } | null>;
      now?: () => number;
      publishTtlMs?: number;
    } = {},
  ) {
    this.session = initial;
  }

  async readSharedSession() {
    this.reads += 1;
    if (this.options.readError) throw this.options.readError;
    if (Object.prototype.hasOwnProperty.call(this.options.afterReads || {}, this.reads)) {
      this.session = this.options.afterReads?.[this.reads] ?? null;
    }
    return this.session;
  }

  async publishSharedSession(session: { token: string }) {
    this.publishes += 1;
    if (this.options.publishError) throw this.options.publishError;
    const now = this.options.now?.() ?? Date.now();
    this.session = {
      token: session.token,
      expiresAt: new Date(now + (this.options.publishTtlMs ?? 900_000)).toISOString(),
      generation: crypto.randomUUID(),
    };
    return this.session;
  }

  async invalidateSharedSession(generation: string) {
    this.invalidatedGenerations.push(generation);
    if (this.session?.generation === generation) {
      this.session = null;
      return true;
    }
    return false;
  }
}
