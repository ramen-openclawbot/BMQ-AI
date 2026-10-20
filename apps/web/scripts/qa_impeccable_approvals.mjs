// Browser QA for the Impeccable pass on Duyệt chi (desktop and phone): no kicker above titles,
// the phone title is not squeezed by its buttons, "Tạo duyệt chi" sits on the tab row, the
// views/pages fit without horizontal overflow; full-content screenshots of each page.
//
// FIXTURE AUTH + FIXTURE DATA: AuthContext and the Supabase client are replaced by in-memory
// fixtures; every write is refused and recorded, and all non-local network is blocked. This
// proves the real shell/page components render and navigate; it is not real-user acceptance.
//
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome node scripts/qa_impeccable_approvals.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-impeccable-approvals-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5198);
const { chromium } = createRequire(import.meta.url)(PW);
fs.mkdirSync(EVIDENCE, { recursive: true });

const SUPABASE_FIXTURE = `
const cfg = () => JSON.parse(localStorage.getItem("qa-shell") || "{}");
window.__qaWrites = window.__qaWrites || [];
const WRITE = new Set(["insert", "update", "upsert", "delete"]);
function settle(st) {
  const mode = cfg().data || "populated";
  if (st.write) { window.__qaWrites.push(st.table + ":" + st.write); return { data: null, error: { message: "QA fixture: writes disabled" }, count: null }; }
  if (mode === "error") return { data: null, error: { message: "QA fixture: network error", code: "QA" }, count: null };
  // "partial": only the revenue ledger fails; every other source answers.
  if (mode === "partial" && st.table === "revenue_ledger_lines") return { data: null, error: { message: "QA fixture: ledger down" }, count: null };
  const filled = mode === "populated" || mode === "partial";
  if (st.head) {
    let count = 0;
    if (filled && st.table === "payment_requests" && st.filters.status === "pending") count = 3;
    if (filled && st.table === "purchase_orders" && st.filters.status === "draft") count = 2;
    if (filled && st.table === "customer_po_inbox" && st.filters.match_status === "pending_approval") count = 4;
    return { data: null, error: null, count };
  }
  if (st.single) return { data: null, error: null };
  const rows = filled ? fixtureRows(st) : null;
  if (rows) return { data: rows, error: null, count: rows.length };
  return { data: [], error: null, count: 0 };
}
const vnDay = (offsetDays) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(Date.now() - offsetDays * 86400000));
function fixtureRows(st) {
  if (st.table === "revenue_ledger_lines") {
    const rows = [];
    // The ledger lags: no figures for today and yesterday.
    for (let back = 2; back < 20; back += 1) {
      const day = vnDay(back);
      if (day.slice(0, 7) !== st.filters.period) continue;
      const wave = Math.sin(back / 2);
      // Full ledger row shape, so the real revenue pages render with it too.
      const line = (channel, customer, amount, qty) => ({
        id: day + "-" + channel + "-" + customer, period: day.slice(0, 7), revenue_date: day, channel, source_tab: channel,
        customer_id: "c-" + customer, parent_customer_id: null, customer_name: customer, quantity: qty,
        gross_revenue: Math.round(amount), source_type: "dealer_portal", approval_status: "approved",
        raw_payload: {}, source_document: { status: "controlled" },
      });
      rows.push(line("ĐẠI LÝ", "NPP Bình Tân", (9 + 2 * wave) * 1e6, 1400));
      rows.push(line("ĐẠI LÝ", "Đại lý Quận 7", (6 + wave) * 1e6, 900));
      rows.push(line("BÁNH NGỌT", "Bánh ngọt Q7", (9 + 2 * Math.cos(back)) * 1e6, 600));
      rows.push(line("Retail Kiosk", "Kiosk Bình Thạnh", (3 + wave) * 1e6, 220));
      if (back % 3 === 0) rows.push(line("B2B BMQ", "Siêu thị Co.op", 4.5e6, 300));
    }
    return rows;
  }
  if (st.table === "rpc:get_kiosk_point_revenue_reviews") {
    const names = ["Kiosk Bình Thạnh", "Kiosk Phú Nhuận", "Kiosk Bình Dương", "Kiosk Quận 7", "Kiosk Thủ Đức", "Kiosk Gò Vấp", "Kiosk Tân Bình", "Kiosk Quận 10", "Kiosk Hotline"];
    const rows = names.map((name, i) => ({
      report_id: "r" + i, report_date: vnDay(0), location_id: "loc-" + i, location_name: name, staff_name: "NV " + (i + 1),
      submitted_at: new Date().toISOString(), review_status: "pending", reviewed_at: null, reviewed_by_name: null, review_note: null, report_notes: null,
      channels: [
        { channel_code: "retail", channel_name: "Khách lẻ", quantity: 40 + i * 7, source_amount_vnd: (40 + i * 7) * 14000, effective_amount_vnd: (40 + i * 7) * 14000, corrected: false },
        { channel_code: "grab", channel_name: "Grab", quantity: 12 + i * 2, source_amount_vnd: (12 + i * 2) * 14000, effective_amount_vnd: (12 + i * 2) * 14000, corrected: false },
      ],
    }));
    rows.push({ ...rows[1], report_id: "dup" });
    return rows;
  }
  if (st.table === "production_orders") return [{ status: "planned" }, { status: "planned" }, { status: "planned" }, { status: "draft" }, { status: "completed" }].map((r, i) => ({ id: "po" + i, ...r }));
  if (st.table === "inventory_items") return [
    { id: "i1", name: "Bơ lạt", quantity: 2, min_stock: 10 },
    { id: "i2", name: "Pate gan", quantity: 0, min_stock: 5 },
    { id: "i3", name: "Bột mì", quantity: 80, min_stock: 20 },
  ];
  return null;
}
function builder(table) {
  const st = { table, filters: {}, head: false, single: false, write: null };
  const proxy = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return (ok, ko) => Promise.resolve(settle(st)).then(ok, ko);
      if (prop === "catch") return (ko) => Promise.resolve(settle(st)).catch(ko);
      if (prop === "finally") return (fn) => Promise.resolve(settle(st)).finally(fn);
      return (...args) => {
        if (WRITE.has(prop)) st.write = prop;
        if (prop === "select" && args[1] && args[1].head) st.head = true;
        if (prop === "eq") st.filters[args[0]] = args[1];
        if (prop === "single" || prop === "maybeSingle") st.single = true;
        return proxy;
      };
    },
  });
  return proxy;
}
const user = { id: "qa-user", email: "qa@bmq.test", user_metadata: {} };
const channel = { on() { return channel; }, subscribe() { return channel; }, unsubscribe() {} };
export const supabase = {
  from: (table) => builder(table),
  rpc: (fn) => builder("rpc:" + fn),
  schema: () => ({ from: (table) => builder(table), rpc: (fn) => builder("rpc:" + fn) }),
  functions: { invoke: async (name) => { window.__qaWrites.push("invoke:" + name); return { data: null, error: { message: "QA fixture: functions disabled" } }; } },
  storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "" } }), createSignedUrl: async () => ({ data: null, error: null }), list: async () => ({ data: [], error: null }), upload: async () => ({ data: null, error: { message: "QA fixture: writes disabled" } }), download: async () => ({ data: null, error: null }) }) },
  auth: {
    getSession: async () => ({ data: { session: { access_token: "qa-fixture-token", user } }, error: null }),
    getUser: async () => ({ data: { user }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    refreshSession: async () => ({ data: { session: { access_token: "qa-fixture-token", user } }, error: null }),
    signOut: async () => ({ error: null }),
  },
  channel: () => channel,
  removeChannel: () => {},
};
export default supabase;
`;

const AUTH_FIXTURE = `
import React, { createContext, useContext } from "react";
const cfg = JSON.parse(localStorage.getItem("qa-shell") || "{}");
const role = cfg.role || "owner";
const MODULES = {
  owner: null,
  limited: ["dashboard", "inventory", "kitchen_inventory", "goods_receipts", "payment_requests", "suppliers"],
  none: [],
}[role];
const name = cfg.name || "Tâm Vũ";
const user = { id: "qa-user", email: "qa@bmq.test", user_metadata: { full_name: name } };
const can = (key) => MODULES === null || MODULES.includes(key);
const value = {
  user,
  session: { access_token: "qa-fixture-token", user },
  profile: { id: "qa-profile", user_id: "qa-user", full_name: name, email: user.email },
  loading: false,
  timedOut: false,
  roles: role === "owner" ? ["owner"] : ["staff"],
  authzLoaded: true,
  authzError: false,
  isOwner: role === "owner",
  canAccessModule: can,
  canEditModule: can,
  signOut: async () => { window.__qaSignedOut = true; },
  refreshProfile: async () => {},
  refreshRoles: async () => {},
};
const Ctx = createContext(value);
export function AuthProvider({ children }) { return React.createElement(Ctx.Provider, { value }, children); }
export function useAuth() { return useContext(Ctx); }
`;

const fixtures = {
  name: "qa-demo3-fixtures",
  enforce: "pre",
  resolveId(id) {
    if (id === "@/integrations/supabase/client" || id.endsWith("/src/integrations/supabase/client") || id.endsWith("/src/integrations/supabase/client.ts")) return "\0qa-supabase";
    if (id === "@/contexts/AuthContext" || id.endsWith("/src/contexts/AuthContext") || id.endsWith("/src/contexts/AuthContext.tsx")) return "\0qa-auth.jsx";
    return null;
  },
  load(id) {
    if (id === "\0qa-supabase") return SUPABASE_FIXTURE;
    if (id === "\0qa-auth.jsx") return AUTH_FIXTURE;
    return null;
  },
};

const server = await createServer({
  root: ROOT,
  configFile: false,
  logLevel: "error",
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-impeccable-approvals-qa/vite-cache",
  server: { port: PORT, strictPort: true, host: "127.0.0.1" },
  define: { __APP_VERSION__: JSON.stringify("qa"), __APP_SEMVER__: JSON.stringify("vqa") },
  resolve: { alias: { "@": path.join(ROOT, "src") } },
  plugins: [fixtures, react()],
});
await server.listen();
const BASE = `http://127.0.0.1:${PORT}`;

const browser = await chromium.launch({ executablePath: CHROME });
const results = [];
const record = (name, detail = {}) => {
  results.push({ name, ...detail });
  console.log("PASS", name);
};

async function open(cfg, route, viewport, extra = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: extra.reducedMotion || "reduce", locale: "vi-VN" });
  await context.addInitScript((value) => {
    localStorage.setItem("qa-shell", JSON.stringify(value));
    if (value.language) localStorage.setItem("app-language", value.language);
  }, cfg);
  await context.route("**/*", (r) => {
    const url = r.request().url();
    if (url.startsWith(BASE) || url.startsWith("data:") || url.startsWith("blob:") || /fonts\.(googleapis|gstatic)\.com/.test(url)) return r.continue();
    return r.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + route, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-bmq-shell='demo3-v1']", { timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  return { context, page, errors };
}

const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
  { width: 320, height: 640 },
];

async function fullShot(page, file) {
  await page.addStyleTag({ content: ".d3-app{height:auto!important}.d3-main{overflow:visible!important}" });
  await page.waitForTimeout(150);
  await page.screenshot({ path: file, fullPage: true });
}

try {
  for (const viewport of WIDTHS) {
    for (const view of ["unpaid", "all", "recon"]) {
      const { context, page, errors } = await open({ role: "owner", data: "populated" }, "/payment-requests", viewport);
      await page.waitForSelector("[data-bmq-payables-layout='demo3-v1']", { timeout: 20000 });
      if (view !== "unpaid") await page.locator(`[data-bmq-pr-view-${view}]`).click();
      await page.waitForTimeout(700);
      assert.equal(await page.locator(".d3-pa-tag").count(), 0, "no kicker above the title");
      assert.equal(await page.locator(".d3-pa-glow").count(), 0, "no glow");
      assert.ok((await page.locator(".d3-pa-headmeta").textContent()).trim().length > 0, "meta line under the title");
      const head = await page.evaluate(() => {
        const h = document.querySelector(".d3-pa-head").getBoundingClientRect();
        const t = document.querySelector(".d3-pa-head h1").getBoundingClientRect();
        return { head: h.width, title: t.width, lines: Math.round(t.height / parseFloat(getComputedStyle(document.querySelector(".d3-pa-head h1")).lineHeight)) };
      });
      if (viewport.width <= 640) {
        assert.ok(head.title >= head.head * 0.9, `phone title uses the full width @${viewport.width}: ${JSON.stringify(head)}`);
        assert.ok(head.lines <= 3, `phone title lines @${viewport.width}: ${head.lines}`);
      }
      if (view === "unpaid") {
        const pos = await page.evaluate(() => {
          const tabs = document.querySelector(".d3-pa-view").getBoundingClientRect();
          const btn = document.querySelector("[data-bmq-pr-create-unpaid] button").getBoundingClientRect();
          return { tabsTop: tabs.top, tabsBottom: tabs.bottom, btnTop: btn.top, btnRight: btn.right, btnWidth: btn.width };
        });
        if (viewport.width >= 1024) assert.ok(Math.abs(pos.btnTop - pos.tabsTop) < 24, `create button on the tab row @${viewport.width}: ${JSON.stringify(pos)}`);
        else assert.ok(pos.btnTop >= pos.tabsBottom - 1, `create button under the tabs on phones @${viewport.width}`);
      }
      const ov = await overflow(page);
      assert.ok(ov <= 0, `no overflow @${view} ${viewport.width}: ${ov}`);
      await fullShot(page, `${EVIDENCE}/pr-${view}-${viewport.width}.png`);
      assert.deepEqual(errors, [], `page errors @${view}`);
      record(`payment-requests ${view} ${viewport.width}`, head);
      await context.close();
    }
    for (const route of ["/finance-control/payables", "/finance-control/classification"]) {
      const { context, page, errors } = await open({ role: "owner", data: "populated" }, route, viewport);
      await page.waitForTimeout(1500);
      const ov = await overflow(page);
      assert.ok(ov <= 0, `no overflow @${route} ${viewport.width}: ${ov}`);
      const h1 = page.locator(".d3-screen h1").first();
      assert.ok(await h1.count(), `title on ${route}`);
      await fullShot(page, `${EVIDENCE}/${route.split("/").pop()}-${viewport.width}.png`);
      assert.deepEqual(errors, [], `page errors @${route}`);
      record(`${route} ${viewport.width}`);
      await context.close();
    }
  }
} finally {
  fs.writeFileSync(`${EVIDENCE}/qa-impeccable-approvals.json`, JSON.stringify(results, null, 2));
  await browser.close();
  await server.close();
}
console.log(`ALL ${results.length} IMPECCABLE APPROVALS QA CHECKS PASSED — evidence in ${EVIDENCE}`);
