#!/usr/bin/env node
// Scoped behavioral QA for the owner-only admin route guard (App + AppRoutes +
// VNAgentDataAdmin). It mounts the REAL app shell on the real admin hostnames
// (admin.banhmique.vn primary, admin.vnagent.ai alias, proxied to the local Vite
// server) with a fixture-auth AuthContext and asserts:
//
//   1. non-owner  -> stays on "/", sees the English owner-only denial (no loop)
//   2. owner      -> sees the admin shell
//   3. authz loading (non-owner) -> "checking", NOT a premature denial
//   4. authz error               -> English retry panel, no denial; retry fires
//   5. /auth on the new host     -> English Google sign-in
//   6. /recover on the new host  -> English session recovery
//   7. admin title + English lang on the new host, normal BMQ title elsewhere
//   8. admin.vnagent.ai alias    -> still reaches the admin shell
//   9. legacy /data-admin on a non-admin host -> plain NotFound (admin is
//      host-only; that path is no longer an alternate admin entry)
//
// Playwright-core is not a repo dependency; point PLAYWRIGHT_CORE at it:
//   PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs \
//     node apps/web/scripts/qa_vnagent_data_admin_guard.mjs
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(web, "..", "..", "generated", "data-admin", "guard");
mkdirSync(out, { recursive: true });

const playwrightPath = process.env.PLAYWRIGHT_CORE;
if (!playwrightPath || !existsSync(playwrightPath)) {
  console.error("Set PLAYWRIGHT_CORE to playwright-core/index.mjs");
  process.exit(2);
}

const { createServer } = await import(join(web, "node_modules/vite/dist/node/index.js"));
const { webkit } = await import(playwrightPath);

const ADMIN_HOST = "admin.banhmique.vn";
const ADMIN_ALIAS_HOST = "admin.vnagent.ai";
const ADMIN_TITLE = "VNAgent · Data Admin";
const BMQ_TITLE = "BMQ AI Quản Trị";

// Fixture auth: the scenario is injected on window before the page loads so each
// run can flip owner / authzLoaded / authzError without rebuilding.
const auth = `
const base = () => (typeof window !== 'undefined' && window.__QA_AUTH__) || {};
export const useAuth = () => ({
  ...base(),
  refreshRoles: () => { window.__QA_REFRESH__ = (window.__QA_REFRESH__ || 0) + 1; return Promise.resolve(); },
});
`;
const lang = `export const useLanguage=()=>({language:'vi',t:x=>x});`;
const db = `export const supabase={functions:{invoke:async()=>({data:null,error:new Error('fixture-stub')})},auth:{exchangeCodeForSession:async()=>({error:null}),setSession:async()=>({error:null}),signInWithOAuth:async()=>({error:null})}};`;
// Mount the REAL App so the host document title / language and the /recover
// branch are exercised; only AppInner (providers/router internals) is stubbed to
// the real AppRoutes so the guard scenarios stay isolated.
const entry = `import React from 'react';import{createRoot}from'react-dom/client';import{BrowserRouter}from'react-router-dom';import App from '/@fs${web}/src/App.tsx';import'/@fs${web}/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(BrowserRouter,null,React.createElement(App)));`;
const inner = `import React from 'react';import{AppRoutes}from'/@fs${web}/src/components/AppRoutes.tsx';export default function AppInner(){return React.createElement(AppRoutes);}`;

process.chdir(web);
const server = await createServer({
  root: web,
  configFile: false,
  esbuild: { jsx: "automatic" },
  cacheDir: join(out, ".vite"),
  resolve: { alias: { "@": join(web, "src") } },
  server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{
    name: "guard-qa",
    enforce: "pre",
    resolveId(id) {
      if (id === "/qa-entry.jsx") return "\0entry";
      if (id === "./AppInner" || id.endsWith("/AppInner") || id.endsWith("/AppInner.tsx")) return "\0inner";
      if (id === "@/contexts/AuthContext" || id.endsWith("/src/contexts/AuthContext")) return "\0auth";
      if (id === "@/contexts/LanguageContext" || id.endsWith("/src/contexts/LanguageContext")) return "\0lang";
      if (id === "@/integrations/supabase/client" || id.endsWith("/src/integrations/supabase/client")) return "\0db";
      return null;
    },
    load(id) { return { "\0entry": entry, "\0inner": inner, "\0auth": auth, "\0lang": lang, "\0db": db }[id]; },
    configureServer(s) {
      s.middlewares.use((req, res, next) => {
        const accept = String(req.headers.accept || "");
        const isModule = req.url.startsWith("/@") || req.url.startsWith("/src") || req.url.startsWith("/node_modules");
        if (!isModule && accept.includes("text/html")) {
          res.setHeader("Content-Type", "text/html");
          res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/qa-entry.jsx"></script>');
          return;
        }
        next();
      });
    },
  }],
});

await server.listen();
const address = server.httpServer.address();
const PORT = typeof address === "object" && address ? address.port : 0;
if (!PORT) throw new Error("Vite server did not expose a port");
const targetBase = `http://127.0.0.1:${PORT}`;
console.log(`vite serving ${targetBase}`);

const browser = await webkit.launch({ headless: true });
const results = [];
const failures = [];

function scenario(name, authState, path = "/", origin = `http://${ADMIN_HOST}`) {
  return { name, authState, path, origin, url: `${origin}${path}` };
}

const nonOwner = { user: { id: "u-nonowner" }, loading: false, timedOut: false, authzLoaded: true, authzError: false, isOwner: false };
const owner = { user: { id: "u-owner" }, loading: false, timedOut: false, authzLoaded: true, authzError: false, isOwner: true };
const scenarios = [
  scenario("non-owner", nonOwner),
  scenario("owner", owner),
  scenario("authz-loading", { ...nonOwner, authzLoaded: false, authzError: false }),
  scenario("authz-error", { ...nonOwner, authzLoaded: false, authzError: true }),
  // The legacy /data-admin path on a non-admin host must be an ordinary 404 now
  // that admin is host-only, not an alternate English admin entry.
  scenario("legacy-data-admin-removed", nonOwner, "/data-admin", targetBase),
  // New primary host must expose English login and recovery, not the BMQ chrome.
  scenario("auth-english", { user: null, loading: false, timedOut: false, authzLoaded: false, authzError: false, isOwner: false }, "/auth"),
  scenario("recovery-english", nonOwner, "/recover"),
  // The pre-existing alias host must keep working.
  scenario("alias-owner", owner, "/", `http://${ADMIN_ALIAS_HOST}`),
];

// Playwright's textContent() has a 30s default timeout, so awaiting it for an
// absent node would stall a scenario for half a minute. Read text only once the
// node is actually present, with a short bound.
async function textIfPresent(locator) {
  if ((await locator.count()) === 0) return "";
  return (await locator.first().textContent({ timeout: 1500 }).catch(() => "")) || "";
}

function isAdminHost(origin) {
  return origin.includes(`//${ADMIN_HOST}`) || origin.includes(`//${ADMIN_ALIAS_HOST}`);
}

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // Proxy the real admin hosts to the local Vite server so the shared hostname
  // predicate is true in the browser exactly as in production.
  for (const host of [ADMIN_HOST, ADMIN_ALIAS_HOST]) {
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
      } catch (error) {
        await route.abort();
      }
    });
  }

  for (const item of scenarios) {
    const page = await context.newPage();
    const errors = [];
    const navigations = [];
    // The Vite dev server injects an HMR websocket client; WebKit reports its
    // (disabled) connection as a page error. That is harness noise, not app code.
    const devNoise = /WebSocket .*blocked/i;
    page.on("pageerror", (error) => { if (!devNoise.test(error.message)) errors.push(error.message); });
    page.on("framenavigated", (frame) => { if (frame === page.mainFrame()) navigations.push(frame.url()); });
    await page.addInitScript((state) => { window.__QA_AUTH__ = state; window.__QA_REFRESH__ = 0; }, item.authState);
    await page.goto(item.url, { waitUntil: "domcontentloaded" });
    // Wait for the scenario's real rendered state instead of a fixed sleep: the
    // first scenario pays the cold Vite compile of the lazy admin chunk. Bounded
    // so a genuine hang still fails, then a short settle for effects.
    await page.waitForFunction(() => {
      const root = document.getElementById("root");
      if (!root || root.childElementCount === 0) return false;
      if (root.querySelector('[data-da-denied="owner-only"],[data-vnagent-data-admin],[data-da-authz="checking"],[data-da-authz="error"]')) return true;
      const text = root.textContent || "";
      return /Sign in with Google/.test(text) || /Recover your session/.test(text) || /Oops! Page not found/.test(text);
    }, undefined, { timeout: 45_000 }).catch(() => {});
    await page.waitForTimeout(200);

    const result = {
      name: item.name,
      expectUrl: item.url,
      url: page.url(),
      title: await page.title(),
      lang: await page.evaluate(() => document.documentElement.lang),
      navigations: navigations.length,
      denied: await page.locator('[data-da-denied="owner-only"]').count(),
      deniedText: await textIfPresent(page.locator('[data-da-denied="owner-only"]')),
      shell: await page.locator("[data-vnagent-data-admin]").count(),
      authzChecking: await page.locator('[data-da-authz="checking"]').count(),
      authzErrorPanel: await page.locator('[data-da-authz="error"]').count(),
      authzErrorText: await textIfPresent(page.locator('[data-da-authz="error"]')),
      signInButton: await page.getByRole("button", { name: "Sign in with Google" }).count(),
      signInEmailNote: await textIfPresent(page.getByText("@bmq.vn email accounts only")),
      recoveryHeading: await page.getByRole("heading", { name: "Recover your session" }).count(),
      recoveryButton: await page.getByRole("button", { name: "Clear session & reload" }).count(),
      pageNotFound: await page.getByText("Oops! Page not found").count(),
      refreshCalls: 0,
      errors,
    };
    if (item.name === "authz-error") {
      const retry = page.getByRole("button", { name: "Try again" });
      if (await retry.count()) { await retry.first().click(); await page.waitForTimeout(200); }
      result.refreshCalls = await page.evaluate(() => window.__QA_REFRESH__ || 0);
    }
    await page.screenshot({ path: join(out, `${item.name}.png`), fullPage: true });
    results.push(result);
    await page.close();
  }
} finally {
  await browser.close();
  await server.close();
}

for (const r of results) {
  if (r.errors.length) failures.push(`${r.name}: page errors ${JSON.stringify(r.errors)}`);
  if (r.url !== r.expectUrl) failures.push(`${r.name}: navigated away to ${r.url}`);
  if (r.navigations > 2) failures.push(`${r.name}: ${r.navigations} main-frame navigations (redirect loop)`);
  // Both admin hosts must show the admin title and English lang; a non-admin BMQ
  // host keeps its normal BMQ title and Vietnamese lang.
  if (isAdminHost(r.expectUrl) && r.title !== ADMIN_TITLE) failures.push(`${r.name}: admin title missing (${JSON.stringify(r.title)})`);
  if (!isAdminHost(r.expectUrl) && r.title !== BMQ_TITLE) failures.push(`${r.name}: normal BMQ title lost (${JSON.stringify(r.title)})`);
  if (isAdminHost(r.expectUrl) && r.lang !== "en") failures.push(`${r.name}: admin surface lang is not en (${JSON.stringify(r.lang)})`);
  // The fixture HTML has no lang attribute, so a non-admin host must simply not
  // be forced to English by the admin surface predicate.
  if (!isAdminHost(r.expectUrl) && r.lang === "en") failures.push(`${r.name}: non-admin surface forced to English (${JSON.stringify(r.lang)})`);
  if (r.name === "non-owner") {
    if (r.denied !== 1) failures.push(`${r.name}: owner-only denial not shown (count ${r.denied})`);
    if (!/business owners only/i.test(r.deniedText)) failures.push(`${r.name}: denial is not the English copy (${JSON.stringify(r.deniedText)})`);
    if (r.shell !== 0) failures.push(`${r.name}: admin shell rendered for a non-owner`);
  }
  if (r.name === "legacy-data-admin-removed") {
    if (r.pageNotFound !== 1) failures.push(`${r.name}: legacy /data-admin is not a plain NotFound (count ${r.pageNotFound})`);
    if (r.shell !== 0) failures.push(`${r.name}: legacy /data-admin still rendered the admin shell`);
    if (r.denied !== 0) failures.push(`${r.name}: legacy /data-admin still selected the admin branch`);
    if (r.signInButton !== 0) failures.push(`${r.name}: legacy /data-admin redirected to login instead of NotFound`);
  }
  if (r.name === "owner" || r.name === "alias-owner") {
    if (r.shell < 1) failures.push(`${r.name}: admin shell missing`);
    if (r.denied !== 0) failures.push(`${r.name}: owner was denied`);
  }
  if (r.name === "authz-loading") {
    if (r.authzChecking < 1) failures.push(`${r.name}: no checking state while authz loads`);
    if (r.denied !== 0) failures.push(`${r.name}: premature denial before authzLoaded`);
  }
  if (r.name === "authz-error") {
    if (r.authzErrorPanel < 1) failures.push(`${r.name}: authz error panel missing`);
    if (r.denied !== 0) failures.push(`${r.name}: denial shown instead of the authz error/retry`);
    if (!/verify your access rights/i.test(r.authzErrorText)) failures.push(`${r.name}: error is not English (${JSON.stringify(r.authzErrorText)})`);
    if (r.refreshCalls < 1) failures.push(`${r.name}: retry did not call refreshRoles`);
  }
  if (r.name === "auth-english") {
    if (r.signInButton !== 1) failures.push(`${r.name}: English sign-in button missing (count ${r.signInButton})`);
    if (!/@bmq\.vn email accounts only/.test(r.signInEmailNote)) failures.push(`${r.name}: English email note missing (${JSON.stringify(r.signInEmailNote)})`);
  }
  if (r.name === "recovery-english") {
    if (r.recoveryHeading !== 1) failures.push(`${r.name}: English recovery heading missing (count ${r.recoveryHeading})`);
    if (r.recoveryButton !== 1) failures.push(`${r.name}: English recovery button missing (count ${r.recoveryButton})`);
  }
}

writeFileSync(join(out, "report.json"), JSON.stringify({ results, failures }, null, 2));
console.log(JSON.stringify({ results, failures }, null, 2));
if (failures.length) { console.error(`ADMIN GUARD QA FAILED: ${failures.length}`); process.exit(1); }
console.log("ADMIN GUARD QA PASSED");
