#!/usr/bin/env node
// Real-source login/callback fixture for the admin host.
//
// Unlike qa_vnagent_data_admin_guard.mjs (which stubs AuthContext), this harness
// mounts the REAL app: real App.tsx -> AppInner -> AuthProvider -> AppRoutes ->
// real Auth.tsx, with the REAL @supabase/supabase-js client from
// src/integrations/supabase/client.ts (detectSessionInUrl:false, implicit flow).
// Only the Supabase HTTP endpoint is mocked (Playwright route), so the SDK's
// actual initialize/session/callback behavior is exercised.
//
// Run:
//   PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs \
//     node apps/web/scripts/qa_admin_login_fixture.mjs
//
// Fixture auth only: no real accounts, tokens or OAuth flows.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(web, "..", "..");
const out = join(repo, "generated", "admin-login", "fixture");
mkdirSync(out, { recursive: true });

const playwrightPath = process.env.PLAYWRIGHT_CORE;
if (!playwrightPath || !existsSync(playwrightPath)) {
  console.error("Set PLAYWRIGHT_CORE to playwright-core/index.mjs");
  process.exit(2);
}

const { createServer } = await import(join(web, "node_modules/vite/dist/node/index.js"));
const { webkit } = await import(playwrightPath);

const SUPABASE_URL = "http://supabase.test";
const ADMIN_HOST = "admin.banhmique.vn";
const ADMIN_ALIAS_HOST = "admin.vnagent.ai";
const BMQ_HOST = "ai.banhmique.vn";
const STORAGE_KEY = "sb-supabase-auth-token";

const b64url = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const nowSec = () => Math.floor(Date.now() / 1000);
const makeJwt = (payload) => `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url(payload)}.Zml4dHVyZQ`;

// Per-scenario mock backend state (set before each page).
const backend = {
  role: "owner",
  email: "owner@bmq.vn",
  id: "u-owner",
  hangUser: false,
  hangToken: false,
  authorizeUrls: [],
  calls: [],
};

function makeUser() {
  return {
    id: backend.id,
    aud: "authenticated",
    role: "authenticated",
    email: backend.email,
    email_confirmed_at: new Date().toISOString(),
    phone: "",
    confirmed_at: new Date().toISOString(),
    last_sign_in_at: new Date().toISOString(),
    app_metadata: { provider: "google", providers: ["google"] },
    user_metadata: {},
    identities: [],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function makeSession({ expired = false } = {}) {
  const exp = expired ? nowSec() - 120 : nowSec() + 3600;
  return {
    access_token: makeJwt({ sub: backend.id, email: backend.email, role: "authenticated", exp }),
    token_type: "bearer",
    expires_in: expired ? -120 : 3600,
    expires_at: exp,
    refresh_token: `refresh-${backend.id}`,
    user: makeUser(),
  };
}

const entry = `import React from 'react';
import {createRoot} from 'react-dom/client';
import App from '/@fs${web}/src/App.tsx';
import '/@fs${web}/src/index.css';
createRoot(document.getElementById('root')).render(React.createElement(App));`;

process.chdir(web);
const server = await createServer({
  root: web,
  configFile: false,
  esbuild: { jsx: "automatic" },
  cacheDir: join(out, ".vite"),
  resolve: { alias: { "@": join(web, "src") } },
  define: {
    "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(SUPABASE_URL),
    "import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY": JSON.stringify("fixture-anon-key"),
  },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [
    {
      name: "admin-login-fixture",
      enforce: "pre",
      resolveId(id) {
        if (id === "/qa-entry.jsx") return "\0entry";
        return null;
      },
      load(id) {
        if (id === "\0entry") return entry;
        return null;
      },
      configureServer(s) {
        s.middlewares.use((req, res, next) => {
          const accept = String(req.headers.accept || "");
          const isModule =
            req.url.startsWith("/@") ||
            req.url.startsWith("/src") ||
            req.url.startsWith("/node_modules") ||
            req.url.startsWith("/qa-entry");
          if (!isModule && accept.includes("text/html")) {
            res.setHeader("Content-Type", "text/html");
            res.end(
              '<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/qa-entry.jsx"></script>',
            );
            return;
          }
          next();
        });
      },
    },
  ],
});

await server.listen();
const address = server.httpServer.address();
const PORT = typeof address === "object" && address ? address.port : 0;
if (!PORT) throw new Error("Vite server did not expose a port");
const targetBase = `http://127.0.0.1:${PORT}`;
console.log(`vite serving ${targetBase}`);

async function proxyHost(context, host) {
  await context.route(`http://${host}/**`, async (route) => {
    const request = route.request();
    const target = request.url().replace(`http://${host}`, targetBase);
    try {
      const upstream = await fetch(target, {
        method: request.method(),
        headers: { ...request.headers(), host: `127.0.0.1:${PORT}` },
        body: request.postData() ?? undefined,
        redirect: "manual",
      });
      const body = Buffer.from(await upstream.arrayBuffer());
      await route.fulfill({ status: upstream.status, headers: Object.fromEntries(upstream.headers), body });
    } catch {
      await route.abort();
    }
  });
}

async function mockSupabase(context) {
  await context.route(`${SUPABASE_URL}/**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const origin = request.headers()["origin"] || "*";
    const cors = {
      "access-control-allow-origin": origin,
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": request.headers()["access-control-request-headers"] || "*",
      "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "access-control-expose-headers": "*",
      vary: "origin",
    };
    const json = (status, body) =>
      route.fulfill({ status, headers: { "content-type": "application/json", ...cors }, body: JSON.stringify(body) });

    // The OAuth authorize endpoint is a document navigation to Google (via
    // Supabase). Record it and stop there instead of leaving the fixture.
    if (url.pathname.endsWith("/auth/v1/authorize")) {
      backend.authorizeUrls.push(request.url());
      return route.fulfill({
        status: 200,
        headers: { "content-type": "text/html" },
        body: "<!doctype html><title>fixture-google</title>",
      });
    }

    backend.calls.push(`${request.method()} ${url.pathname}${url.search}`);

    if (request.method() === "OPTIONS") return route.fulfill({ status: 204, headers: cors, body: "" });

    if (url.pathname.endsWith("/auth/v1/user")) {
      if (backend.hangUser) return; // never settle: simulates a stuck SDK request
      return json(200, makeUser());
    }

    if (url.pathname.endsWith("/auth/v1/token")) {
      if (backend.hangToken) return; // never settle: simulates a stuck refresh
      const grant = url.searchParams.get("grant_type");
      let body = {};
      try {
        body = JSON.parse(request.postData() || "{}");
      } catch {
        body = {};
      }
      if (grant === "pkce" && !body.code_verifier) {
        return json(400, {
          error: "invalid_request",
          error_code: "invalid_request",
          error_description: "both auth code and code verifier should be non-empty",
        });
      }
      return json(200, makeSession());
    }

    if (url.pathname.endsWith("/auth/v1/logout")) return route.fulfill({ status: 204, headers: cors, body: "" });

    if (url.pathname.includes("/rest/v1/user_roles")) {
      if (request.method() === "GET") return json(200, backend.role ? [{ role: backend.role }] : []);
      return json(201, []);
    }
    if (url.pathname.includes("/rest/v1/user_module_permissions")) return json(200, []);
    if (url.pathname.includes("/rest/v1/profiles")) return json(200, []);
    if (url.pathname.includes("/functions/v1/")) return json(200, { data: null, error: null });
    return json(200, []);
  });
}

const browser = await webkit.launch({ headless: true });
const results = [];
const failures = [];

async function textIfPresent(locator) {
  if ((await locator.count()) === 0) return "";
  return (await locator.first().textContent({ timeout: 1500 }).catch(() => "")) || "";
}

const devNoise = /WebSocket .*blocked/i;

async function runScenario(scenario) {
  Object.assign(backend, {
    role: scenario.role ?? "owner",
    email: scenario.email ?? (scenario.role === "owner" ? "owner@bmq.vn" : "staff@bmq.vn"),
    id: scenario.role === "owner" ? "u-owner" : scenario.userId || "u-user",
    hangUser: !!scenario.hangUser,
    hangToken: !!scenario.hangToken,
    authorizeUrls: [],
    calls: [],
  });

  const context = await browser.newContext({ viewport: scenario.viewport || { width: 1440, height: 900 } });
  await proxyHost(context, ADMIN_HOST);
  await proxyHost(context, ADMIN_ALIAS_HOST);
  await proxyHost(context, BMQ_HOST);
  await mockSupabase(context);

  const page = await context.newPage();
  const consoleMessages = [];
  const pageErrors = [];
  const navigations = [];
  page.on("console", (msg) => consoleMessages.push(`${msg.type()}: ${msg.text()}`));
  page.on("pageerror", (error) => {
    if (!devNoise.test(error.message)) pageErrors.push(error.message);
  });
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations.push(frame.url());
  });

  if (scenario.seedSession) {
    const session = makeSession({ expired: scenario.seedSession === "expired" });
    await page.addInitScript(
      ({ key, value }) => {
        window.localStorage.setItem(key, value);
      },
      { key: STORAGE_KEY, value: JSON.stringify(session) },
    );
  }

  let path = scenario.path;
  if (path.includes("access_token=FIXTURE")) {
    const jwt = makeJwt({ sub: backend.id, email: backend.email, role: "authenticated", exp: nowSec() + 3600 });
    path = path.replace("access_token=FIXTURE", `access_token=${jwt}`);
  }
  const url = `http://${scenario.host}${path}`;
  await page.goto(url, { waitUntil: "domcontentloaded" });

  let headingBeforeClick = "";
  let signInButtonBeforeClick = null;
  if (scenario.clickSignIn) {
    const button = page.getByRole("button", { name: /Sign in with Google/ });
    await button.waitFor({ state: "visible", timeout: 45_000 }).catch(() => {});
    headingBeforeClick = await textIfPresent(page.getByRole("heading"));
    signInButtonBeforeClick = await button.count();
    if (await button.count()) await button.first().click().catch(() => {});
    await page.waitForTimeout(600);
  } else {
    // Wait for a real rendered state or the configured settle time.
    await page
      .waitForFunction(
        () => {
          const root = document.getElementById("root");
          if (!root || root.childElementCount === 0) return false;
          const text = root.textContent || "";
          return (
            !!root.querySelector("[data-vnagent-data-admin]") ||
            !!root.querySelector('[data-da-denied="owner-only"]') ||
            /Sign in with Google|Sign-in failed|This Google account|Your Google sign-in|BMQ Procurement|BMQ Administration|Connection problem|Đang gặp sự cố kết nối|Page not found|404/.test(text)
          );
        },
        undefined,
        { timeout: scenario.settleMs || 20_000 },
      )
      .catch(() => {});
    await page.waitForTimeout(scenario.settleAfter ?? 400);
  }

  const result = {
    name: scenario.name,
    host: scenario.host,
    path: scenario.path,
    viewport: scenario.viewport || { width: 1440, height: 900 },
    finalUrl: page.url(),
    navigations: navigations.length,
    authorizeUrls: backend.authorizeUrls.slice(),
    backendCalls: backend.calls.slice(),
    heading: headingBeforeClick || (await textIfPresent(page.getByRole("heading"))),
    errors: pageErrors,
    consoleMessages: consoleMessages.filter((m) => m.startsWith("warning") || m.startsWith("error") || m.includes("[Auth")),
    signInButton: signInButtonBeforeClick ?? (await page.getByRole("button", { name: /Sign in with Google/ }).count()),
    vietnameseSignInButton: await page.getByRole("button", { name: /Đăng nhập bằng Google/ }).count(),
    alertText: await textIfPresent(page.locator('[role="alert"]')),
    deniedOwnerOnly: await page.locator('[data-da-denied="owner-only"]').count(),
    adminShell: await page.locator("[data-vnagent-data-admin]").count(),
    spinner: await page.locator(".animate-spin").count(),
    timeoutRecovery: await page.getByRole("button", { name: /Refresh session|Làm mới phiên/ }).count(),
    pageNotFound: await page.getByText("Oops! Page not found").count(),
    bodyOverflow: await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    ),
  };

  await page.screenshot({ path: join(out, `${scenario.name}.png`), fullPage: true });
  results.push(result);
  await context.close();
  return result;
}

const OWNER_CALLBACK = "/auth#access_token=FIXTURE&refresh_token=refresh-owner&token_type=bearer&expires_in=3600";

const scenarios = JSON.parse(process.env.QA_SCENARIOS || "null") || [
  // Anonymous admin login at the required widths, then the exact Google start URL.
  { name: "admin-anon-1440", host: ADMIN_HOST, path: "/auth", clickSignIn: true, viewport: { width: 1440, height: 900 }, expect: "admin-login" },
  { name: "admin-anon-390", host: ADMIN_HOST, path: "/auth", clickSignIn: true, viewport: { width: 390, height: 844 }, expect: "admin-login" },
  { name: "admin-anon-320", host: ADMIN_HOST, path: "/auth", clickSignIn: true, viewport: { width: 320, height: 568 }, expect: "admin-login" },
  // Owner / non-owner callback outcomes.
  { name: "admin-callback-owner", host: ADMIN_HOST, path: OWNER_CALLBACK, expect: "owner-shell" },
  { name: "admin-alias-callback-owner", host: ADMIN_ALIAS_HOST, path: OWNER_CALLBACK, expect: "owner-shell" },
  { name: "admin-callback-nonowner", host: ADMIN_HOST, path: "/auth#access_token=FIXTURE&refresh_token=refresh-staff&token_type=bearer&expires_in=3600", role: "viewer", expect: "owner-denied" },
  // Callback error surfaces must land back on the login page with an error.
  { name: "admin-callback-error-query", host: ADMIN_HOST, path: "/auth?error=access_denied&error_description=User+denied+access", expect: "callback-error" },
  { name: "admin-callback-hash-error", host: ADMIN_HOST, path: "/auth#error=server_error&error_description=Something+went+wrong", expect: "callback-error" },
  // A PKCE-style ?code= callback must not hang the spinner either.
  { name: "admin-callback-pkce-code", host: ADMIN_HOST, path: "/auth?code=fixture-auth-code", expect: "callback-error" },
  // Proven hangs: a stuck /user or stuck token refresh must reach a usable page.
  { name: "admin-callback-timeout", host: ADMIN_HOST, path: OWNER_CALLBACK, hangUser: true, settleMs: 13_000, settleAfter: 500, expect: "callback-timeout-recovered" },
  { name: "admin-init-timeout", host: ADMIN_HOST, path: "/", seedSession: "expired", hangToken: true, settleMs: 16_000, settleAfter: 500, expect: "init-timeout-recovered" },
  // The legacy /data-admin entry is gone on non-admin hosts, for anonymous AND owner.
  { name: "old-route-anon", host: BMQ_HOST, path: "/data-admin", expect: "legacy-not-found" },
  { name: "old-route-owner", host: BMQ_HOST, path: "/data-admin", seedSession: true, expect: "legacy-not-found" },
  // Existing BMQ login is untouched.
  { name: "bmq-login-preserved", host: BMQ_HOST, path: "/auth", expect: "bmq-login" },
];

function assertScenario(result, expect) {
  const fail = (message) => failures.push(`${result.name}: ${message}`);
  const ok = (condition, message) => {
    if (!condition) fail(message);
  };

  if (expect === "admin-login") {
    ok(result.heading === "BMQ Administration", `admin heading is ${JSON.stringify(result.heading)}, expected "BMQ Administration"`);
    ok(result.signInButton === 1, `admin English sign-in button count=${result.signInButton}`);
    ok(result.authorizeUrls.length === 1, `expected 1 Google authorize URL, got ${result.authorizeUrls.length}`);
    const url = result.authorizeUrls[0] || "";
    ok(url.includes("provider=google"), `authorize URL missing provider=google (${url})`);
    ok(url.includes(`redirect_to=${encodeURIComponent(`http://${result.host}/auth`)}`), `authorize URL redirect_to is not ${result.host}/auth (${url})`);
    ok(url.includes("hd=bmq.vn"), `authorize URL missing hd=bmq.vn (${url})`);
    ok(url.includes("prompt=select_account"), `authorize URL missing prompt=select_account (${url})`);
    ok(!url.includes("code_challenge"), `implicit-flow client must not send code_challenge (${url})`);
    ok(result.bodyOverflow === false, "admin login page overflows horizontally");
  }
  if (expect === "owner-shell") {
    ok(result.adminShell >= 1, "owner callback did not render the admin shell");
    ok(result.deniedOwnerOnly === 0, "owner callback was denied");
    ok(result.spinner === 0, "owner callback left a spinner");
    ok(result.signInButton === 0, "owner callback fell back to the login page");
  }
  if (expect === "owner-denied") {
    ok(result.deniedOwnerOnly === 1, `non-owner denial count=${result.deniedOwnerOnly}`);
    ok(result.adminShell === 0, "non-owner reached the admin shell");
    ok(result.signInButton === 0, "non-owner was sent back to login instead of the denial");
  }
  if (expect === "callback-error") {
    ok(result.signInButton === 1, `callback error did not return to login (signIn=${result.signInButton}, spinner=${result.spinner})`);
    ok(result.alertText.length > 0, "callback error did not surface an alert");
    ok(result.bodyOverflow === false, "callback error page overflows horizontally");
  }
  if (expect === "callback-timeout-recovered") {
    ok(result.spinner === 0, "a stuck callback left a permanent spinner");
    ok(result.signInButton === 1, "a stuck callback did not return to the usable login page");
    ok(result.alertText.length > 0, "a stuck callback did not surface an error");
    ok(result.deniedOwnerOnly === 0 && result.adminShell === 0, "stuck callback rendered a protected page");
  }
  if (expect === "init-timeout-recovered") {
    ok(result.spinner === 0, "a stuck auth init left a permanent spinner");
    ok(result.timeoutRecovery >= 1, "a stuck auth init did not reach the session-recovery fallback");
    ok(result.adminShell === 0, "stuck auth init rendered the admin shell");
  }
  if (expect === "legacy-not-found") {
    ok(result.pageNotFound === 1, `legacy /data-admin did not render NotFound (count=${result.pageNotFound})`);
    ok(result.adminShell === 0, "legacy /data-admin still reached the admin shell");
    ok(result.deniedOwnerOnly === 0, "legacy /data-admin still selected the admin branch");
    ok(result.signInButton === 0, "legacy /data-admin redirected to login instead of NotFound");
  }
  if (expect === "bmq-login") {
    ok(result.heading === "BMQ Procurement", `BMQ heading is ${JSON.stringify(result.heading)}, expected "BMQ Procurement"`);
    ok(result.vietnameseSignInButton === 1, `BMQ Vietnamese sign-in button count=${result.vietnameseSignInButton}`);
    ok(result.signInButton === 0, "BMQ login leaked the admin English button");
  }
}

const observeOnly = process.env.QA_OBSERVE === "1";
try {
  for (const scenario of scenarios) {
    const result = await runScenario(scenario);
    if (!observeOnly && scenario.expect) assertScenario(result, scenario.expect);
  }
} finally {
  await browser.close();
  await server.close();
}

// Assertions per scenario; QA_OBSERVE=1 records the raw observations only
// (used to capture the pre-fix baseline).
writeFileSync(join(out, "report.json"), JSON.stringify({ results, failures }, null, 2));
console.log(JSON.stringify({ results, failures }, null, 2));
if (failures.length) {
  console.error(`ADMIN LOGIN FIXTURE FAILED: ${failures.length}`);
  process.exit(1);
}
console.log("ADMIN LOGIN FIXTURE PASSED");
