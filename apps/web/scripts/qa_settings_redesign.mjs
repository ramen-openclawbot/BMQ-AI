// Browser QA for the grouped-list settings pages (owner 23/10/2026): /settings and /system-management.
// FIXTURE AUTH + FIXTURE DATA (app_settings rows); writes are refused and recorded. Checks: every
// connection is one row with its status and one action, rows open their panel, no sideways scroll
// at 320/390/1440, connected / not-connected states, no nested cards. Not real-user acceptance.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-settings-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5263);
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
  if (st.single && st.table === "app_settings") return { data: APP_SETTINGS().find((r) => r.key === st.filters.key) ?? null, error: null };
  if (st.single) return { data: null, error: null };
  const rows = filled ? fixtureRows(st) : null;
  if (rows) return { data: rows, error: null, count: rows.length };
  return { data: [], error: null, count: 0 };
}
const vnDay = (offsetDays) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(Date.now() - offsetDays * 86400000));
const APP_SETTINGS = () => (cfg().conn === "none" ? [
  { key: "google_drive_receipts_unc_pattern", value: "yyyy/MM/dd/UNC" },
] : [
  { key: "google_drive_po_folder", value: "https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz012345" },
  { key: "google_drive_receipts_folder", value: "https://drive.google.com/drive/folders/9ZyXwVuTsRqPoNmLkJiHgFeDcBa98765" },
  { key: "google_drive_receipts_unc_pattern", value: "yyyy/MM/dd/UNC" },
  { key: "google_drive_receipts_qtm_pattern", value: "yyyy/MM/dd/QTM" },
  { key: "google_drive_connected_email", value: "tam.vu.drive.longaccount@bmq.vn" },
  { key: "google_gmail_connected_email", value: "po@bmq.vn" },
  { key: "debt_gmail_connected_email", value: "no-reply@bmq.vn" },
  { key: "customer_debt_gmail_sender", value: "no-reply@bmq.vn" },
  { key: "customer_debt_default_cc", value: "ketoantruong@bmq.vn" },
  { key: "order_gmail_connected_email", value: cfg().conn === "wrong" ? "tam@bmq.vn" : "order@bmq.vn" },
  { key: "dealer_landing_banners", value: JSON.stringify([{ id: "b1", eventLabel: "Khai trương Quận 7 — ưu đãi đại lý tháng 11", url: "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100"><rect width="160" height="100" fill="#e9d9b8"/><rect x="20" y="40" width="120" height="24" rx="12" fill="#c98a3a"/></svg>'), path: "landing/b1.jpg", enabled: true, published: true, contentTitle: "Ưu đãi khai trương", contentIntro: "", contentHighlights: [], contentTerms: "", contentNote: "" }]) },
]);
function fixtureRows(st) {
  if (st.table === "app_settings") return APP_SETTINGS();
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
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-settings-qa/vite-cache",
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


const VIEWPORTS = [{ width: 320, height: 640 }, { width: 390, height: 844 }, { width: 1440, height: 900 }];
const facts = (page) => page.evaluate(() => {
  const root = document.querySelector("[data-bmq-settings]");
  const cards = [...root.querySelectorAll(".st-card")];
  return {
    overflow: document.documentElement.scrollWidth - window.innerWidth,
    nested: cards.filter((c) => c.parentElement.closest(".st-card")).length,
    rowsOverflow: [...root.querySelectorAll(".st-row")].filter((r) => r.scrollWidth > r.clientWidth + 1).length,
    text: root.innerText,
  };
});
async function fullShot(page, file) {
  await page.addStyleTag({ content: ".d3-app{height:auto!important}.d3-main{overflow:visible!important}" });
  await page.waitForTimeout(150);
  await page.screenshot({ path: file, fullPage: true });
}

try {
  for (const viewport of VIEWPORTS) {
    for (const conn of ["all", "none", "wrong"]) {
      const { context, page, errors } = await open({ role: "owner", data: "populated", conn }, "/system-management", viewport);
      await page.waitForSelector("[data-bmq-settings-drive]", { timeout: 20000 });
      await page.waitForTimeout(500);
      let f = await facts(page);
      assert.ok(f.overflow <= 0, `no sideways scroll ${conn} ${viewport.width}: ${f.overflow}`);
      assert.equal(f.nested, 0, "no card inside a card");
      assert.equal(f.rowsOverflow, 0, `rows fit ${conn} ${viewport.width}`);
      assert.doesNotMatch(f.text, /Hướng dẫn:/, "no instruction block");
      if (conn === "all") {
        assert.equal(await page.locator("[data-bmq-settings-drive] .st-status.is-ok").count(), 1, "Drive connected");
        assert.equal(await page.locator("[data-bmq-settings] .st-link.is-danger").count(), 4, "Ngắt on every connection");
        // Open the debt email panel and the PO folder panel.
        await page.locator("[data-bmq-settings-debt-email] .st-row-toggle").click();
        await page.waitForSelector("#debt-email-sender");
        assert.equal(await page.locator("#debt-email-sender").inputValue(), "no-reply@bmq.vn");
        await page.locator("[data-bmq-settings-po-folder] .st-row-toggle").click();
        await page.waitForSelector("#po-folder");
        await page.locator("[data-bmq-banner-row] .st-row-toggle").first().click();
        await page.waitForSelector("#dealer-banner-label-0");
        await page.waitForTimeout(400);
        f = await facts(page);
        assert.ok(f.overflow <= 0, `open panels fit ${viewport.width}: ${f.overflow}`);
        // Save writes app_settings (refused by the fixture) and is reported, not silent.
        await page.locator("[data-bmq-settings-save]").first().click();
        await page.waitForTimeout(400);
        assert.ok((await page.evaluate(() => window.__qaWrites)).some((w) => w.startsWith("app_settings:upsert")), "save tries app_settings upsert");
      }
      if (conn === "none") {
        assert.equal(await page.locator("[data-bmq-settings] .st-link.is-primary", { hasText: "Kết nối" }).count(), 4, "4 Kết nối buttons");
      }
      if (conn === "wrong") {
        assert.match(await page.locator("[data-bmq-order-email-settings]").innerText(), /Sai tài khoản/);
      }
      await fullShot(page, `${EVIDENCE}/system-${conn}-${viewport.width}.png`);
      assert.deepEqual(errors, [], `page errors ${conn} ${viewport.width}`);
      record(`system-management ${conn} ${viewport.width}`);
      await context.close();
    }
    const { context, page, errors } = await open({ role: "owner", data: "populated" }, "/settings", viewport);
    await page.waitForSelector("[data-bmq-settings-name]", { timeout: 20000 });
    await page.locator("[data-bmq-settings-name] .st-row-toggle").click();
    await page.waitForSelector("#name");
    await page.waitForTimeout(300);
    const f = await facts(page);
    assert.ok(f.overflow <= 0, `settings fit ${viewport.width}: ${f.overflow}`);
    assert.equal(f.rowsOverflow, 0, `settings rows fit ${viewport.width}`);
    assert.equal(await page.locator("[data-bmq-settings-signout]").count(), 1, "sign out present");
    await fullShot(page, `${EVIDENCE}/settings-${viewport.width}.png`);
    assert.deepEqual(errors, []);
    record(`settings ${viewport.width}`);
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}
console.log(`ALL ${results.length} SETTINGS QA CHECKS PASSED — evidence in ${EVIDENCE}`);
