#!/usr/bin/env node
// Scoped behavioral QA for the owner-only admin route guard (AppRoutes +
// VNAgentDataAdmin). It mounts the REAL route tree on the real admin hostname
// (admin.vnagent.ai, proxied to the local Vite server) with a fixture-auth
// AuthContext and asserts the admin host no longer redirect-loops a non-owner:
//
//   1. non-owner  -> stays on "/", sees the English owner-only denial (no loop)
//   2. owner      -> sees the admin shell
//   3. authz loading (non-owner) -> "checking", NOT a premature denial
//   4. authz error               -> English retry panel, no denial; retry fires
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

const ADMIN_HOST = "admin.vnagent.ai";

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
const db = `export const supabase={functions:{invoke:async()=>({data:null,error:new Error('fixture-stub')})}};`;
const entry = `import React from 'react';import{createRoot}from'react-dom/client';import{BrowserRouter}from'react-router-dom';import{AppRoutes}from'/@fs${web}/src/components/AppRoutes.tsx';import'/@fs${web}/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(BrowserRouter,null,React.createElement(AppRoutes)));`;

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
      if (id === "@/contexts/AuthContext" || id.endsWith("/src/contexts/AuthContext")) return "\0auth";
      if (id === "@/contexts/LanguageContext" || id.endsWith("/src/contexts/LanguageContext")) return "\0lang";
      if (id === "@/integrations/supabase/client" || id.endsWith("/src/integrations/supabase/client")) return "\0db";
      return null;
    },
    load(id) { return { "\0entry": entry, "\0auth": auth, "\0lang": lang, "\0db": db }[id]; },
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
const scenarios = [
  scenario("non-owner", nonOwner),
  scenario("owner", { user: { id: "u-owner" }, loading: false, timedOut: false, authzLoaded: true, authzError: false, isOwner: true }),
  scenario("authz-loading", { ...nonOwner, authzLoaded: false, authzError: false }),
  scenario("authz-error", { ...nonOwner, authzLoaded: false, authzError: true }),
  // Same admin branch reached from a normal BMQ host; the non-owner must stay on
  // the admin surface (English denial) instead of escaping to the BMQ home page.
  scenario("data-admin-path-non-owner", nonOwner, "/data-admin", `http://127.0.0.1:${PORT}`),
];

try {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // Proxy the real admin host to the local Vite server so isVnagentAdminHost()
  // is true in the browser exactly as in production.
  await context.route(`http://${ADMIN_HOST}/**`, async (route) => {
    const request = route.request();
    const target = request.url().replace(`http://${ADMIN_HOST}`, `http://127.0.0.1:${PORT}`);
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
    await page.waitForTimeout(1200);

    const result = {
      name: item.name,
      expectUrl: item.url,
      url: page.url(),
      navigations: navigations.length,
      denied: await page.locator('[data-da-denied="owner-only"]').count(),
      deniedText: (await page.locator('[data-da-denied="owner-only"]').first().textContent().catch(() => "")) || "",
      shell: await page.locator("[data-vnagent-data-admin]").count(),
      authzChecking: await page.locator('[data-da-authz="checking"]').count(),
      authzErrorPanel: await page.locator('[data-da-authz="error"]').count(),
      authzErrorText: (await page.locator('[data-da-authz="error"]').first().textContent().catch(() => "")) || "",
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
  if (r.name === "non-owner" || r.name === "data-admin-path-non-owner") {
    if (r.denied !== 1) failures.push(`${r.name}: owner-only denial not shown (count ${r.denied})`);
    if (!/business owners only/i.test(r.deniedText)) failures.push(`${r.name}: denial is not the English copy (${JSON.stringify(r.deniedText)})`);
    if (r.shell !== 0) failures.push(`${r.name}: admin shell rendered for a non-owner`);
  }
  if (r.name === "owner") {
    if (r.shell < 1) failures.push(`${r.name}: admin shell missing`);
    if (!r.authzErrorPanel && r.denied) failures.push(`${r.name}: owner was denied`);
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
}

writeFileSync(join(out, "report.json"), JSON.stringify({ results, failures }, null, 2));
console.log(JSON.stringify({ results, failures }, null, 2));
if (failures.length) { console.error(`ADMIN GUARD QA FAILED: ${failures.length}`); process.exit(1); }
console.log("ADMIN GUARD QA PASSED");
