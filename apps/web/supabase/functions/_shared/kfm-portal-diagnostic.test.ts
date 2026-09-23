import { KfmPortalError, loginWithPassword } from "./kfm-portal.ts";

Deno.test("failed SSO replay reports bounded stage evidence without secrets", async () => {
  const originalFetch = globalThis.fetch;
  const originalConsole = console.info;
  const calls: string[] = [];
  const cookieSentinel = "COOKIE_PRIVATE_75219";
  const codeSentinel = "CODE_PRIVATE_75219";
  const csrfSentinel = "CSRF_PRIVATE_75219";
  const passwordSentinel = "PASSWORD_PRIVATE_75219";
  try {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(`${init?.method || "GET"} ${url.pathname}`);
      if (calls.length === 1) {
        const headers = new Headers({ location: "/uaa/login" });
        headers.append("set-cookie", `JSESSIONID=${cookieSentinel}; Path=/uaa; HttpOnly`);
        headers.append("set-cookie", `sce_sso_authorize_request=${cookieSentinel}; Path=/uaa; HttpOnly`);
        return Promise.resolve(new Response(null, { status: 302, headers }));
      }
      if (calls.length === 2) {
        return Promise.resolve(new Response(`<form action="/uaa/login" method="post"><input type="hidden" name="_csrf" value="${csrfSentinel}"><input name="username"><input name="password"></form>`, { status: 200 }));
      }
      if (calls.length === 3) {
        if (!String(init?.body).includes(passwordSentinel)) throw new Error("fixture did not reach POST");
        const headers = new Headers({ location: `/login?error=authorize&state=${codeSentinel}` });
        headers.append("set-cookie", `JSESSIONID=${cookieSentinel}_ROTATED; Path=/uaa; HttpOnly`);
        return Promise.resolve(new Response(null, { status: 302, headers }));
      }
      return Promise.resolve(new Response(null, { status: 302, headers: { location: `/uaa/login?error=${codeSentinel}&unknown=${codeSentinel}` } }));
    }) as typeof fetch;
    console.info = () => { throw new Error("client must not log SSO details"); };
    let detail = "";
    try {
      await loginWithPassword("USER_PRIVATE_75219", passwordSentinel);
      throw new Error("expected login failure");
    } catch (error) {
      if (!(error instanceof KfmPortalError)) throw error;
      if (error.step !== "login") throw new Error(`unexpected step ${error.step}`);
      detail = error.detail || "";
    }
    for (const marker of ["postStatus=302", "replayStatus=302", "postRedirect=/login?error,state", "replayRedirect=/uaa/login?error", "postSessionCookieChanged=true", "postAuthorizeCookieChanged=false", "postSessionCookiePresent=true", "postAuthorizeCookiePresent=true", "sessionCookie=true", "authorizeCookie=true"]) {
      if (!detail.includes(marker)) throw new Error(`missing safe diagnostic marker ${marker}: ${detail}`);
    }
    for (const marker of [cookieSentinel, codeSentinel, csrfSentinel, passwordSentinel, "USER_PRIVATE_75219"]) {
      if (detail.includes(marker)) throw new Error("sensitive value leaked into diagnostic");
    }
    if (calls.join("|") !== "GET /uaa/oauth2/authorize|GET /uaa/login|POST /uaa/login|GET /uaa/oauth2/authorize") {
      throw new Error(`unexpected number or order of provider calls: ${calls.join("|")}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
    console.info = originalConsole;
  }
});

Deno.test("unknown same-origin redirect never discloses its path or query values", async () => {
  const originalFetch = globalThis.fetch;
  const pathSecret = "PATH_PRIVATE_75219";
  const querySecret = "QUERY_PRIVATE_75219";
  let passwordPosts = 0;
  let calls = 0;
  try {
    globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      if (calls === 1) {
        return Promise.resolve(new Response(null, { status: 302, headers: { location: "/uaa/login" } }));
      }
      if (calls === 2) {
        return Promise.resolve(new Response('<form action="/uaa/login"><input name="_csrf" value="FAKE_CSRF"></form>', { status: 200 }));
      }
      if (init?.method === "POST") {
        passwordPosts++;
        return Promise.resolve(new Response(null, { status: 302, headers: { location: `/uaa/${pathSecret}?error=${querySecret}` } }));
      }
      return Promise.resolve(new Response(null, { status: 302, headers: { location: "/uaa/login" } }));
    }) as typeof fetch;
    let detail = "";
    try {
      await loginWithPassword("FAKE_USER", "FAKE_PASSWORD");
      throw new Error("expected login failure");
    } catch (error) {
      if (!(error instanceof KfmPortalError)) throw error;
      detail = error.detail || "";
    }
    if (!detail.includes("postRedirect=sso_other?error")) throw new Error(`missing fixed same-origin label: ${detail}`);
    if (detail.includes(pathSecret) || detail.includes(querySecret)) throw new Error("redirect value leaked");
    if (passwordPosts !== 1) throw new Error(`password POST count ${passwordPosts}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
