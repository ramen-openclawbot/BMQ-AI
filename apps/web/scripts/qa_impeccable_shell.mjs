// Browser QA for the Impeccable pass on the app shell + Tổng quan (desktop and phone):
// launcher clearance, subnav edge fade + active chip in view, no decorative glows,
// date under the title, legible chart axis, no horizontal overflow; full-content screenshots.
//
// FIXTURE AUTH + FIXTURE DATA: AuthContext and the Supabase client are replaced by in-memory
// fixtures; every write is refused and recorded, and all non-local network is blocked. This
// proves the real shell/page components render and navigate; it is not real-user acceptance.
//
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome node scripts/qa_impeccable_shell.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-impeccable-shell-qa";
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
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-impeccable-shell-qa/vite-cache",
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

// Relative luminance contrast of two CSS rgb() colours.
const contrast = (a, b) => {
  const lum = (c) => {
    const [r, g, bl] = c.match(/[\d.]+/g).slice(0, 3).map(Number).map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};

// Scroll the shell's own scroller to the end and check the floating launcher clears the last content.
async function launcherClearance(page) {
  await page.evaluate(() => { const m = document.querySelector(".d3-main"); m.scrollTop = m.scrollHeight; });
  await page.waitForTimeout(150);
  return page.evaluate(() => {
    const launcher = document.querySelector("[data-vnagent-launcher]");
    const screen = document.querySelector(".d3-screen");
    if (!launcher || !screen) return { skipped: true };
    const l = launcher.getBoundingClientRect();
    // Last visible content box inside the panel.
    const kids = [...screen.querySelectorAll(":scope > *, :scope > * > *")].filter((el) => el.getBoundingClientRect().height > 0);
    const bottom = Math.max(...kids.map((el) => el.getBoundingClientRect().bottom));
    return { launcherTop: l.top, contentBottom: bottom, ok: bottom <= l.top + 1 };
  });
}

// Expand the internal scroller so one screenshot shows the whole page.
async function fullShot(page, file) {
  await page.addStyleTag({ content: ".d3-app{height:auto!important}.d3-main{overflow:visible!important}" });
  await page.waitForTimeout(150);
  await page.screenshot({ path: file, fullPage: true });
}

try {
  for (const viewport of WIDTHS) {
    const { context, page, errors } = await open({ role: "owner", data: "populated" }, "/", viewport);
    await page.waitForSelector(".d3-ov-hero .d3-ov-big", { timeout: 15000 });
    await page.waitForSelector(".d3-ov-status");
    await page.waitForTimeout(400);
    assert.equal(await page.locator(".d3-ov-glow").count(), 0, "no decorative glows");
    const order = await page.$eval(".d3-ov-head > div", (el) => [...el.children].map((c) => c.tagName));
    assert.deepEqual(order, ["H1", "P"], "date sits under the title, not above it");
    const axis = await page.$eval(".d3-ov-axis", (el) => getComputedStyle(el).fill);
    const card = await page.$eval(".d3-ov-hero", (el) => getComputedStyle(el).backgroundColor);
    const ratio = contrast(axis, card);
    assert.ok(ratio >= 4.5, `axis contrast ${ratio.toFixed(2)} @${viewport.width}`);
    const ov = await overflow(page);
    assert.ok(ov <= 0, `no overflow @${viewport.width}: ${ov}`);
    for (const el of await page.locator(".d3-ov-insight, .d3-ov-ghost, .d3-ov-ask, .d3-tab, .d3-icon-btn").all()) {
      const box = await el.boundingBox();
      if (!box) continue;
      assert.ok(box.height >= 34, `tap target height @${viewport.width}: ${box.height}`);
    }
    await page.screenshot({ path: `${EVIDENCE}/overview-${viewport.width}-top.png` });
    const clear = await launcherClearance(page);
    assert.ok(clear.skipped || clear.ok, `launcher clears last content @${viewport.width}: ${JSON.stringify(clear)}`);
    await page.screenshot({ path: `${EVIDENCE}/overview-${viewport.width}-end.png` });
    await fullShot(page, `${EVIDENCE}/overview-${viewport.width}-full.png`);
    assert.deepEqual(errors, []);
    record(`overview ${viewport.width}`, clear);
    await context.close();
  }

  // Zone subnav on phones: active chip fully visible, fade only on edges with more chips.
  for (const route of ["/payment-requests", "/finance-control/payables", "/warehouse/tan-tao", "/finance-control/revenue"]) {
    for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 640 }, { width: 1440, height: 900 }]) {
      const { context, page, errors } = await open({ role: "owner", data: "populated" }, route, viewport);
      const nav = page.locator(".d3-subnav");
      if (!(await nav.count())) { await context.close(); continue; }
      await page.waitForTimeout(400);
      const state = await page.evaluate(() => {
        const nav = document.querySelector(".d3-subnav");
        const active = nav.querySelector(".d3-chip.is-active");
        const n = nav.getBoundingClientRect();
        const a = active?.getBoundingClientRect();
        const start = nav.scrollLeft > 2;
        const end = nav.scrollLeft + nav.clientWidth < nav.scrollWidth - 2;
        return {
          more: nav.dataset.more ?? null,
          expected: start && end ? "both" : start ? "start" : end ? "end" : null,
          activeInView: a ? a.left >= n.left - 1 && a.right <= n.right + 1 : true,
        };
      });
      assert.equal(state.more, state.expected, `fade matches hidden chips @${route} ${viewport.width}`);
      assert.ok(state.activeInView, `active chip in view @${route} ${viewport.width}`);
      const ov = await overflow(page);
      assert.ok(ov <= 0, `no overflow @${route} ${viewport.width}: ${ov}`);
      if (viewport.width < 1000) {
        await nav.evaluate((el) => { el.scrollLeft = el.scrollWidth; el.dispatchEvent(new Event("scroll")); });
        await page.waitForTimeout(100);
        const after = await nav.getAttribute("data-more");
        assert.ok(after === null || after === "start", `scrolled to end shows start fade only: ${after}`);
        await nav.evaluate((el) => { el.scrollLeft = 0; el.dispatchEvent(new Event("scroll")); });
      }
      await page.screenshot({ path: `${EVIDENCE}/subnav${route.replace(/\//g, "_")}-${viewport.width}.png` });
      const clear = await launcherClearance(page);
      assert.ok(clear.skipped || clear.ok, `launcher clears content @${route} ${viewport.width}: ${JSON.stringify(clear)}`);
      assert.deepEqual(errors, [], `page errors @${route}`);
      record(`subnav ${route} ${viewport.width}`, state);
      await context.close();
    }
  }

  // Empty and error data keep their messages after the visual pass.
  for (const data of ["error", "empty"]) {
    const { context, page, errors } = await open({ role: "owner", data }, "/", { width: 390, height: 844 });
    await page.waitForTimeout(1500);
    const values = await page.$$eval(".d3-ov-insight-foot", (els) => els.map((el) => el.textContent.trim()));
    if (data === "error") assert.ok(values.length > 0 && values.every((v) => v === "Không tải được"), `errors never read as 0: ${values}`);
    else assert.ok(values.every((v) => v === "0"), `empty reads 0: ${values}`);
    await fullShot(page, `${EVIDENCE}/overview-${data}-390-full.png`);
    assert.deepEqual(errors, []);
    record(`data ${data}`);
    await context.close();
  }
} finally {
  fs.writeFileSync(`${EVIDENCE}/qa-impeccable-shell.json`, JSON.stringify(results, null, 2));
  await browser.close();
  await server.close();
}
console.log(`ALL ${results.length} IMPECCABLE SHELL QA CHECKS PASSED — evidence in ${EVIDENCE}`);
