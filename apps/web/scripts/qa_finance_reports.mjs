// QA for the English Finance module (/finance): P&L, Variance, Payables, Accruals, Close at
// desktop and phone, populated / empty / error, plus access and tab motion.
//
// FIXTURE AUTH + FIXTURE DATA: AuthContext and the Supabase client are replaced by in-memory
// fixtures; finance RPCs answer from scripts/fixtures/finance-qa.json (live shape, names aliased,
// amounts scaled). Every write is refused and recorded. This proves the real page renders and
// navigates; it is not real-user acceptance.
//
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome node scripts/qa_finance_reports.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-finance-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5203);
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
  if (!filled && st.table.startsWith("rpc:finance_")) return { data: null, error: null };
  if (st.single) return { data: null, error: null };
  const rows = filled ? fixtureRows(st) : null;
  if (rows) return { data: rows, error: null, count: rows.length };
  return { data: [], error: null, count: 0 };
}
const vnDay = (offsetDays) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(Date.now() - offsetDays * 86400000));
const FINANCE = ${JSON.stringify(JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/fixtures/finance-qa.json"), "utf8"))).replace(/\\/g, "\\\\")};
function fixtureRows(st) {
  const fin = { "rpc:finance_pnl": "pnl", "rpc:finance_variance": "variance", "rpc:finance_ap_rollforward": "ap", "rpc:finance_accrual_schedule": "accruals", "rpc:finance_close_checklist": "close" }[st.table];
  if (fin === "accruals" && cfg().accrualsDraft) return FINANCE.accruals_draft;
  if (fin) return FINANCE[fin];
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
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-finance-qa/vite-cache",
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


const MONTH = "2026-09";
const route = (view) => `/finance?view=${view}&month=${MONTH}`;
const text = (page, sel) => page.locator(sel).first().innerText();

async function common(page, errors, label, viewport) {
  await page.waitForSelector("[data-bmq-finance] h1", { timeout: 20000 });
  assert.equal((await page.locator("[data-bmq-finance] h1").innerText()).trim(), "Finance");
  const ov = await overflow(page);
  assert.ok(ov <= 0, `no horizontal overflow ${label} ${viewport.width}: ${ov}`);
  assert.deepEqual(await page.evaluate(() => window.__qaWrites), [], `nothing written ${label}`);
  assert.deepEqual(errors, [], `page errors ${label} ${viewport.width}`);
  const vietnamese = await page.locator("[data-bmq-finance]").evaluate((el) => /Doanh thu|Chi phí|tháng|Kỳ lương/.test(el.innerText));
  assert.equal(vietnamese, false, `module copy stays English ${label}`);
}

const CHECKS = {
  async pnl(page) {
    await page.waitForSelector(".fin-kpi");
    assert.equal(await page.locator(".fin-kpi").count(), 4, "four KPIs");
    assert.match(await text(page, ".fin-kpi.is-lead"), /EBITDA[\s\S]*486\.3M/, "EBITDA lead figure");
    assert.equal(await page.locator(".fin-cols li").count(), 6, "six monthly columns");
    assert.equal(await page.locator(".fin-cols li.is-on").count(), 1, "selected month marked");
    assert.match(await text(page, ".fin-notice"), /18% of Sep spend is classified/);
    const table = await text(page, ".fin-table");
    assert.ok(table.includes("Dealers") && table.includes("EBITDA margin") && !table.includes("ĐẠI LÝ"), "statement uses English channel names");
    const tabsFit = await page.locator(".fin-tabs").evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
    if ((await page.viewportSize()).width >= 390) assert.ok(tabsFit, "all five tabs fit");
    if ((await page.viewportSize()).width < 760) {
      const view = await page.locator(".fin-table thead th.is-on").evaluate((th) => {
        const wrap = th.closest(".fin-table-wrap");
        const sticky = wrap.querySelector("thead th").getBoundingClientRect();
        const box = wrap.getBoundingClientRect();
        const on = th.getBoundingClientRect();
        const prior = th.previousElementSibling.getBoundingClientRect();
        // Nothing may show left of the sticky Line column (iOS report 21/10).
        const leak = Math.round(sticky.left - box.left);
        return { leak, onWhole: on.right <= box.right + 1, priorWhole: prior.left >= sticky.right - 1 };
      });
      assert.equal(view.leak, 0, "sticky Line column sits flush with the card edge");
      assert.ok(view.onWhole, `selected month fully visible ${JSON.stringify(view)}`);
      if ((await page.viewportSize()).width >= 375) assert.ok(view.priorWhole, `prior month fully visible ${JSON.stringify(view)}`);
    }
  },
  async variance(page) {
    await page.waitForSelector(".fin-var-row:not(.is-head)");
    assert.ok(await page.locator(".fin-var-row:not(.is-head)").count() >= 5, "flagged variance lines");
    const body = await text(page, ".fin-var");
    assert.ok(/New this month|Driver unclear/.test(body), "honest driver wording");
    assert.ok(!body.includes("Revenue — "), "channel labels mapped");
    const before = await page.locator(".fin-var-row:not(.is-head)").count();
    const toggle = page.getByRole("button", { name: /Show all/ });
    if (await toggle.count()) {
      await toggle.click();
      assert.ok((await page.locator(".fin-var-row:not(.is-head)").count()) > before, "show all adds lines");
      await page.waitForTimeout(700);
    }
  },
  async payables(page) {
    await page.waitForSelector(".fin-roll li");
    assert.equal(await page.locator(".fin-roll li").count(), 6, "six roll-forward lines");
    assert.match(await text(page, ".fin-chip"), /Ties out/);
    assert.ok(!(await text(page, ".fin-roll")).includes("payment_requests:"), "sources read as sentences");
    assert.equal(await page.locator(".fin-aging li").count(), 4, "four aging buckets");
    assert.ok(await page.locator(".fin-rank li").count() >= 5, "largest balances");
  },
  async accruals(page) {
    await page.waitForSelector(".fin-acc-row");
    assert.equal(await page.locator(".fin-acc-row").count(), 6, "six accrual policies");
    assert.match(await text(page, ".fin-panel-h .fin-chip"), /Draft — not posted/);
    // September has no classified history yet: no drafts, and each row says why.
    assert.equal(await page.getByRole("button", { name: "Show draft journal entry" }).count(), 0);
    assert.match(await text(page, ".fin-acc"), /No classified history yet/);
  },
  async close(page) {
    await page.waitForSelector(".fin-check");
    assert.equal(await page.locator(".fin-check").count(), 10, "ten close checks");
    assert.match(await text(page, ".fin-progress-top"), /5 of 8 checks pass/);
    assert.equal(await page.locator(".fin-tab-count").innerText(), "3", "Close tab shows items needing attention");
  },
};

try {
  for (const view of Object.keys(CHECKS)) {
    for (const viewport of WIDTHS) {
      if (view !== "pnl" && viewport.width !== 1440 && viewport.width !== 390) continue;
      const { context, page, errors } = await open({ role: "owner", data: "populated", language: "vi" }, route(view), viewport);
      await CHECKS[view](page);
      if (view === "pnl") assert.equal(await page.locator(".fin-tab-bar").evaluate((el) => getComputedStyle(el).transitionDuration), "0s", "reduced motion: indicator jumps");
      await common(page, errors, view, viewport);
      await fullShot(page, `${EVIDENCE}/${view}-${viewport.width}.png`);
      record(`${view} ${viewport.width}`);
      await context.close();
    }
  }

  // A month with drafts: the journal entry opens in place.
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const { context, page, errors } = await open({ role: "owner", data: "populated", accrualsDraft: true }, route("accruals"), viewport);
    await page.waitForSelector(".fin-acc-row");
    await page.getByRole("button", { name: "Show draft journal entry" }).first().click();
    await page.waitForTimeout(350);
    assert.match(await text(page, ".fin-je.is-open"), /Dr [\s\S]*Cr Accrued expenses/);
    assert.ok((await overflow(page)) <= 0);
    assert.deepEqual(errors, []);
    await fullShot(page, `${EVIDENCE}/accruals-draft-${viewport.width}.png`);
    record(`accrual draft ${viewport.width}`);
    await context.close();
  }

  // Tabs: clicking moves the indicator and the URL; the zone link is in the header.
  {
    const { context, page, errors } = await open({ role: "owner", data: "populated" }, route("pnl"), { width: 1440, height: 900 }, { reducedMotion: "no-preference" });
    await page.waitForSelector(".fin-tab-bar");
    assert.match(await page.locator(".fin-col").first().evaluate((el) => getComputedStyle(el).animationName), /fin-grow/, "columns grow in");
    assert.match(await page.locator(".fin-tab").first().evaluate((el) => getComputedStyle(el).transitionProperty), /transform/, "tabs have press feedback");
    const before = await page.locator(".fin-tab-bar").evaluate((el) => el.style.transform);
    assert.match(await page.locator(".fin-tab-bar").evaluate((el) => getComputedStyle(el).transitionProperty), /transform/);
    await page.getByRole("tab", { name: "Payables" }).click();
    await page.waitForURL((url) => url.search.includes("view=payables"));
    const after = await page.locator(".fin-tab-bar").evaluate((el) => el.style.transform);
    assert.notEqual(before, after, "indicator moved");
    assert.equal(await page.getByRole("tab", { name: "Payables" }).getAttribute("aria-selected"), "true");
    await page.getByRole("button", { name: /Previous month/ }).click();
    await page.waitForURL((url) => url.search.includes("month=2026-08"));
    assert.ok(await page.locator(".d3-tabs, header").getByText("Finance", { exact: true }).count() >= 1, "Finance zone in the header");
    assert.deepEqual(errors, []);
    record("tabs + month stepper");
    await context.close();
  }

  for (const [data, expect] of [["empty", /No data for this month yet/], ["error", /Couldn't load this report/]]) {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const { context, page, errors } = await open({ role: "owner", data }, route("pnl"), viewport);
      await page.waitForSelector("[data-bmq-finance] h1");
      await page.waitForTimeout(800);
      assert.match(await page.locator("[data-bmq-finance]").innerText(), expect);
      if (data === "error") assert.equal(await page.getByRole("button", { name: /Retry/ }).count(), 1);
      assert.ok((await overflow(page)) <= 0);
      assert.deepEqual(errors, []);
      await page.screenshot({ path: `${EVIDENCE}/${data}-${viewport.width}.png` });
      record(`${data} ${viewport.width}`);
      await context.close();
    }
  }

  // A user without finance access never sees the zone and cannot open the page.
  {
    const { context, page } = await open({ role: "limited", data: "populated" }, route("pnl"), { width: 1440, height: 900 });
    await page.waitForTimeout(800);
    assert.equal(await page.locator("[data-bmq-finance]").count(), 0, "page blocked without finance_cost");
    record("limited role blocked");
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}
console.log(`finance QA: ${results.length} passed`);
