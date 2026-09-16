/**
 * Source-browser fixture QA for the KFM Cổng KFM manual-refresh contract.
 *
 * Serves the real `KfmPortalDialog` component through Vite with fixture auth and
 * a mocked `kfm-portal-sync`, then drives the system Chrome headless at 320/390/
 * 1440 to prove the real rendered browser behavior:
 *   - auto=0  -> the panel is idle on load with ZERO list reads, the idle
 *     instruction is visible and no order card exists;
 *   - auto=1  -> an explicit refresh click performs exactly ONE list read and
 *     renders the order card;
 *   - no horizontal page overflow and a >=44px refresh target at every width;
 *   - screenshots are saved for manual visual review.
 *
 * Fixture auth only. No real credentials, portal reads or records; every portal
 * call is intercepted in the page. Unlike the jsdom suites this runs a real
 * layout engine, so it measures geometry as well as behavior.
 *
 * Run from apps/web:  node scripts/qa_kfm_manual_refresh_page.mjs
 * Override the browser with KFM_QA_BROWSER_BIN (defaults to macOS Chrome).
 */
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = process.env.KFM_QA_OUT || "/tmp/kfm-manual-page";
fs.mkdirSync(out, { recursive: true });

const CHROME = process.env.KFM_QA_BROWSER_BIN || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if (!fs.existsSync(CHROME)) {
  console.error(`Source-browser QA skipped: browser not found at ${CHROME}`);
  process.exit(0);
}

// A temporary fixture entry inside the Vite root; removed in finally.
const entryDir = path.join(root, "generated", "manual-refresh");
const entryFile = path.join(entryDir, "__kfmqa-entry.jsx");
fs.mkdirSync(entryDir, { recursive: true });
fs.writeFileSync(entryFile, `import React from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import Panel from "@/components/production/KfmPortalDialog";
import "@/index.css";

const ORDERS = [{ portalId: 241362, code: "PO1002648379", locationName: "KHO QUÁ CẢNH BÁNH TƯƠI", totalQty: 626, itemCount: 6 }];
window.__qa = { actions: [], list: 0 };
window.fetch = async (_url, options) => {
  const body = JSON.parse(options.body);
  window.__qa.actions.push(body.action);
  if (body.action === "list") {
    window.__qa.list += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, configured: true, orders: ORDERS }) };
  }
  throw new Error("unexpected fixture action: " + body.action);
};
const auto = new URLSearchParams(location.search).get("auto") === "1";
createRoot(document.getElementById("root")).render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <MemoryRouter><Panel isVi /></MemoryRouter>
  </QueryClientProvider>,
);
const measure = () => {
  const section = document.querySelector("[data-kfm-today]");
  const refresh = document.querySelector('[data-kfm-action="refresh-list"]');
  const node = document.createElement("pre");
  node.id = "qa-result";
  node.textContent = JSON.stringify({
    width: innerWidth,
    auto,
    list: window.__qa.list,
    actions: window.__qa.actions,
    state: section ? section.getAttribute("data-kfm-list-state") : null,
    idle: !!document.querySelector('[data-kfm-idle="v1"]'),
    order: !!document.querySelector("[data-kfm-order]"),
    pageOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    bodyOverflow: document.body.scrollWidth - document.documentElement.clientWidth,
    refreshHeight: refresh ? Math.round(refresh.getBoundingClientRect().height) : 0,
  });
  document.body.appendChild(node);
};
if (auto) setTimeout(() => { const button = document.querySelector('[data-kfm-action="refresh-list"]'); if (button) button.click(); }, 500);
setTimeout(measure, 3000);
`);

const server = await createServer({
  root,
  configFile: false,
  cacheDir: path.join(out, ".vite"),
  server: { host: "127.0.0.1", port: Number(process.env.KFM_QA_PORT || 5199), strictPort: false },
  resolve: { alias: { "@/integrations/supabase/client": "\0qa-auth", sonner: "\0qa-sonner", "@": root + "/src" } },
  plugins: [
    {
      name: "kfm-manual-page-fixtures",
      resolveId(id) {
        if (id === "\0qa-auth" || id === "\0qa-sonner") return id;
        if (id === root + "/src/integrations/supabase/client") return "\0qa-auth";
      },
      load(id) {
        if (id === "\0qa-auth") return 'export const supabase={auth:{getSession:async()=>({data:{session:{access_token:"fixture-only"}}})}};';
        if (id === "\0qa-sonner") return "export const toast={loading:()=>{},dismiss:()=>{},success:()=>{},error:()=>{}};";
      },
      configureServer(s) {
        s.middlewares.use(async (req, res, next) => {
          if (req.url.split("?")[0] !== "/__kfmqa") return next();
          res.setHeader("Content-Type", "text/html");
          res.end(await s.transformIndexHtml("/__kfmqa", `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>KFM manual-refresh QA</title></head><body><div id="root"></div><script type="module" src="/generated/manual-refresh/__kfmqa-entry.jsx"></script></body></html>`));
        });
      },
    },
    react(),
  ],
});

const results = [];
const failures = [];

function chrome(args) {
  return execFileSync(CHROME, args, { encoding: "utf8", timeout: 90_000, maxBuffer: 40 * 1024 * 1024, env: { ...process.env } });
}

try {
  await server.listen();
  const base = server.resolvedUrls.local[0];

  for (const width of [320, 390, 1440]) {
    for (const auto of [false, true]) {
      const name = `${width}-${auto ? "loaded" : "idle"}`;
      const url = `${base}__kfmqa?auto=${auto ? 1 : 0}`;
      const profile = fs.mkdtempSync(path.join(os.tmpdir(), "kfmqa-"));
      const common = [
        "--headless=new", "--disable-gpu", "--no-sandbox", "--disable-crash-reporter", "--disable-breakpad",
        `--user-data-dir=${profile}`, `--window-size=${width},900`, "--hide-scrollbars",
        "--virtual-time-budget=9000", "--run-all-compositor-stages-before-draw",
      ];
      try {
        const dom = chrome([...common, "--dump-dom", url]);
        const match = dom.match(/<pre id="qa-result">([\s\S]*?)<\/pre>/);
        assert(match, "the fixture page must report its measurement");
        const measured = JSON.parse(match[1]);
        await new Promise((resolve) => setTimeout(resolve, 150));
        const shot = path.join(out, `kfm-${width}-${auto ? "loaded" : "idle"}.png`);
        chrome([...common, `--screenshot=${shot}`, url]);
        assert.equal(measured.list, auto ? 1 : 0, `list reads at ${name}`);
        assert.equal(measured.state, auto ? "ready" : "idle", `list state at ${name}`);
        assert.equal(measured.idle, !auto, `idle instruction at ${name}`);
        assert.equal(measured.order, auto, `order card at ${name}`);
        assert(measured.pageOverflow <= 1, `no page overflow at ${name}: ${measured.pageOverflow}px`);
        assert(measured.bodyOverflow <= 1, `no body overflow at ${name}: ${measured.bodyOverflow}px`);
        assert(measured.refreshHeight >= 44, `44px refresh target at ${name}: ${measured.refreshHeight}px`);
        results.push({ name, pass: true, measured, screenshot: shot });
      } catch (error) {
        failures.push(`${name}: ${error.message}`);
        results.push({ name, pass: false, error: error.message });
      } finally {
        fs.rmSync(profile, { recursive: true, force: true });
      }
    }
  }

  fs.writeFileSync(path.join(out, "qa-manual-page-results.json"), JSON.stringify({ results, failures }, null, 2));
  console.log(`${results.length - failures.length}/${results.length} KFM source-browser scenarios passed -> ${out}`);
  if (failures.length) {
    console.error("Failed scenarios:\n" + failures.join("\n"));
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
} finally {
  fs.rmSync(entryFile, { force: true });
  await Promise.race([server.close().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 3000))]);
  process.exit(process.exitCode || 0);
}
