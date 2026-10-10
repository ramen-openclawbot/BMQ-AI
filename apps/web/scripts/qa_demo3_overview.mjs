// Browser QA for the Demo 3 Tổng quan (overview) page on top of the Demo 3 shell.
//
// FIXTURE AUTH + FIXTURE DATA: AuthContext and the Supabase client are replaced by in-memory
// fixtures; every write is refused and recorded, and all non-local network is blocked. This
// proves the real shell/page components render and navigate; it is not real-user acceptance.
//
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome node scripts/qa_demo3_shell.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-demo3-overview-qa";
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
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-demo3-overview-qa/vite-cache",
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
const tabLabels = (page) => page.$$eval(".d3-tabs .d3-tab", (els) => els.map((el) => el.textContent.trim()));
const activeTab = (page) => page.$eval(".d3-tabs", (nav) => nav.querySelector("[data-zone-active='true']")?.textContent.trim() ?? null).catch(() => null);
const activeChip = (page) => page.$eval(".d3-subnav", (nav) => nav.querySelector(".d3-chip.is-active")?.textContent.trim() ?? null).catch(() => null);

const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
  { width: 320, height: 640 },
];


const big = (page) => page.locator(".d3-ov-hero .d3-ov-big span").textContent();
const insightTitles = (page) => page.$$eval(".d3-ov-insight h3", (els) => els.map((el) => el.textContent.trim()));
const insightValue = (page, title) => page.locator(".d3-ov-insight", { hasText: title }).locator(".d3-ov-insight-foot").textContent();

try {
  // 1. Owner, populated: every card, real numbers, layout at four widths.
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
    const { context, page, errors } = await open({ role: "owner", data: "populated" }, "/", viewport, { reducedMotion: viewport.width === 1440 ? "no-preference" : "reduce" });
    await page.waitForSelector(".d3-ov-hero .d3-ov-big", { timeout: 15000 });
    await page.waitForSelector(".d3-ov-status");
    await page.waitForTimeout(viewport.width === 1440 ? 1800 : 300);
    assert.ok(Number((await big(page)).replace(/\./g, "").replace(",", ".")) > 0, "14-day revenue total shown");
    assert.ok((await page.locator(".d3-ov-hero .d3-ov-sub").textContent()).includes("ngày gần nhất có số"), "ledger lag disclosed");
    const shares = await page.$$eval(".d3-ov-share li span", (els) => els.map((el) => el.textContent));
    assert.deepEqual(shares, ["Đại lý & NPP", "Bánh ngọt", "B2B & siêu thị", "Kiosk & bán lẻ"]);
    assert.equal(await page.locator(".d3-ov-line").count(), 4, "one line per channel");
    assert.equal(await page.locator(".d3-ov-hit").count(), 12, "lines stop at the last ledger day");
    assert.ok((await page.locator(".d3-ov-pending").textContent()).includes("chưa có số"), "lagging days disclosed, not drawn as 0");
    const axisPx = await page.$eval(".d3-ov-axis", (el) => el.getBoundingClientRect().height);
    assert.ok(axisPx >= 9, `axis text legible @${viewport.width}: ${axisPx}px`);
    assert.deepEqual(await insightTitles(page), ["Phiếu chờ duyệt", "Hàng sắp hết", "PO bán mới chờ xác nhận", "Điểm bán đã báo cáo"]);
    assert.equal((await insightValue(page, "Phiếu chờ duyệt")).trim(), "3");
    assert.equal((await insightValue(page, "Hàng sắp hết")).trim(), "2");
    assert.equal((await insightValue(page, "PO bán mới")).trim(), "4");
    assert.equal((await insightValue(page, "Điểm bán đã báo cáo")).trim(), "9", "duplicate point counted once");
    assert.equal(await page.locator(".d3-ov-big.is-mid span").textContent(), "5");
    assert.equal(await page.locator(".d3-ov-ai").count(), 1, "owner sees AI card");
    const ov = await overflow(page);
    assert.ok(ov <= 0, `no overflow ${viewport.width}: ${ov}`);
    for (const el of await page.locator(".d3-ov-insight, .d3-ov-ghost, .d3-ov-ask").all()) {
      const box = await el.boundingBox();
      assert.ok(box.x >= 0 && box.x + box.width <= viewport.width, `card inside viewport @${viewport.width}`);
    }
    await page.screenshot({ path: `${EVIDENCE}/overview-owner-${viewport.width}.png`, fullPage: true });
    for (const btn of await page.locator(".d3-ov-legend button").all()) {
      const box = await btn.boundingBox();
      assert.ok(box.height >= 28 && box.x >= 0 && box.x + box.width <= viewport.width, `legend tap target @${viewport.width}: ${JSON.stringify(box)}`);
    }
    await page.locator(".d3-ov-legend button", { hasText: "B2B & siêu thị" }).click();
    assert.equal(await page.locator(".d3-ov-line").count(), 1, `solo channel @${viewport.width}`);
    assert.ok((await overflow(page)) <= 0, `no overflow with a channel picked @${viewport.width}`);
    await page.locator(".d3-ov-chart").screenshot({ path: `${EVIDENCE}/overview-chart-solo-${viewport.width}.png` });
    assert.deepEqual(errors, []);
    record(`owner populated ${viewport.width}`);
    await context.close();
  }

  // 2. Chart readout, card links, AI card.
  {
    const { context, page, errors } = await open({ role: "owner", data: "populated" }, "/", { width: 1440, height: 900 });
    await page.waitForSelector(".d3-ov-hit");
    const hits = page.locator(".d3-ov-hit");
    await hits.nth(8).hover();
    const tip = await page.locator(".d3-ov-tip").textContent();
    assert.ok(tip.includes("Tổng") && tip.includes("Đại lý & NPP"), "tooltip lists channels and total");
    await page.screenshot({ path: `${EVIDENCE}/overview-chart-tooltip.png` });
    // Legend filter: one channel alone, axis rescaled, tooltip without total; tap again restores all.
    const topTick = async () => Math.max(...(await page.$$eval(".d3-ov-axis[text-anchor='end']", (els) => els.map((el) => Number(el.textContent.replace(/\./g, "").replace(",", "."))))));
    const allTop = await topTick();
    const kiosk = page.locator(".d3-ov-legend button", { hasText: "Kiosk & bán lẻ" });
    await kiosk.click();
    assert.equal(await page.locator(".d3-ov-line").count(), 1, "only the picked channel is drawn");
    assert.equal(await kiosk.getAttribute("aria-pressed"), "true");
    assert.equal(await page.locator(".d3-ov-legend button.is-off").count(), 3, "other channels dimmed");
    assert.ok((await topTick()) < allTop, `axis rescales to the channel: ${await topTick()} < ${allTop}`);
    await hits.nth(8).hover();
    const soloTip = await page.locator(".d3-ov-tip").textContent();
    assert.ok(soloTip.includes("Kiosk & bán lẻ") && !soloTip.includes("Đại lý") && !soloTip.includes("Tổng"), `solo tooltip: ${soloTip}`);
    await page.screenshot({ path: `${EVIDENCE}/overview-chart-solo-1440.png` });
    await page.locator(".d3-ov-legend button", { hasText: "Bánh ngọt" }).click();
    assert.equal(await page.locator(".d3-ov-line").count(), 1, "switching channel keeps one line");
    assert.equal(await page.locator(".d3-ov-legend button[aria-pressed='true']").textContent(), "Bánh ngọt");
    await page.locator(".d3-ov-legend button", { hasText: "Bánh ngọt" }).click();
    assert.equal(await page.locator(".d3-ov-line").count(), 4, "tapping the picked channel again shows all");
    assert.equal(await page.locator(".d3-ov-legend button.is-off").count(), 0);
    await hits.nth(3).focus();
    assert.equal(await page.locator(".d3-ov-tip").count(), 1, "keyboard focus shows readout");
    await page.evaluate(() => { window.__aiOpened = 0; window.addEventListener("bmq:open-agent-chat", () => { window.__aiOpened += 1; }); });
    await page.locator(".d3-ov-ask").click();
    assert.equal(await page.evaluate(() => window.__aiOpened), 1);
    // The real VNAgent chat sheet opens over the page; close it like a user would.
    await page.waitForSelector("[data-vnagent-ui='chat-v2-clean']", { timeout: 5000 });
    await page.keyboard.press("Escape");
    await page.waitForSelector("[data-vnagent-ui='chat-v2-clean']", { state: "detached" });
    await page.locator(".d3-ov-insight", { hasText: "Hàng sắp hết" }).click();
    await page.waitForURL(BASE + "/low-stock");
    await page.goBack();
    await page.locator(".d3-ov-hero .d3-ov-ghost").click();
    await page.waitForURL(BASE + "/finance-control/revenue");
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => window.__qaWrites.filter((w) => !w.startsWith("invoke:"))), [], "no writes");
    record("chart readout, links, AI");
    await context.close();
  }

  // 3. Partial outage: revenue fails, other cards keep their numbers; nothing reads 0.
  {
    const { context, page, errors } = await open({ role: "owner", data: "partial" }, "/", { width: 1440, height: 900 });
    await page.waitForSelector(".d3-ov-hero .d3-ov-state.is-error", { timeout: 15000 });
    assert.equal(await page.locator(".d3-ov-hero .d3-ov-big").count(), 0, "no revenue number on error");
    assert.equal((await insightValue(page, "Phiếu chờ duyệt")).trim(), "3");
    await page.screenshot({ path: `${EVIDENCE}/overview-partial-1440.png`, fullPage: true });
    assert.deepEqual(errors, []);
    record("partial outage");
    await context.close();
  }

  // 4. Full outage and empty data.
  for (const data of ["error", "empty"]) {
    const { context, page, errors } = await open({ role: "owner", data }, "/", { width: 390, height: 844 });
    await page.waitForTimeout(1500);
    const values = await page.$$eval(".d3-ov-insight-foot", (els) => els.map((el) => el.textContent.trim()));
    if (data === "error") {
      assert.ok(values.length > 0 && values.every((v) => v === "Không tải được"), `errors never read as 0: ${values}`);
    } else {
      assert.ok(values.every((v) => v === "0"), `empty reads 0: ${values}`);
      assert.ok((await page.locator(".d3-ov-row.is-revenue").textContent()).includes("chưa có doanh thu"), "empty revenue message");
    }
    await page.screenshot({ path: `${EVIDENCE}/overview-${data}-390.png`, fullPage: true });
    assert.deepEqual(errors, []);
    record(`data ${data}`);
    await context.close();
  }

  // 5. Limited user: only permitted cards, no revenue, no AI; no-permission user gets guidance.
  {
    const { context, page, errors } = await open({ role: "limited", data: "populated" }, "/", { width: 1440, height: 900 });
    await page.waitForTimeout(800);
    assert.equal(await page.locator(".d3-ov-row.is-revenue").count(), 0, "no revenue without finance_revenue");
    assert.deepEqual(await insightTitles(page), ["Phiếu chờ duyệt"], "only payment approvals for limited role");
    assert.equal(await page.locator(".d3-ov-ai").count(), 0);
    assert.ok(!(await page.evaluate(() => performance.getEntriesByType("resource").some((e) => e.name.includes("revenue_ledger")))), "no ledger request");
    await page.screenshot({ path: `${EVIDENCE}/overview-limited-1440.png`, fullPage: true });
    assert.deepEqual(errors, []);
    record("limited user");
    await context.close();
  }
  {
    const { context, page, errors } = await open({ role: "none", data: "populated" }, "/", { width: 390, height: 844 });
    await page.waitForTimeout(500);
    assert.ok((await page.locator(".d3-ov").textContent()).includes("chưa có chỉ số tổng quan"));
    assert.deepEqual(errors, []);
    record("no-permission user");
    await context.close();
  }

  // 6. Bán hàng pages render in the Demo 3 theme without errors or overflow.
  for (const route of ["/finance-control/revenue", "/finance-control/revenue/points", "/finance-control/revenue/debt", "/mini-crm"]) {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const { context, page, errors } = await open({ role: "owner", data: "populated" }, route, viewport);
      await page.waitForTimeout(1500);
      assert.equal(await activeTab(page), "Bán hàng", `sales zone active @${route}`);
      // Light page title: 300 from the kit, 200 on pages rebuilt to the Demo 3 head (as in the demo).
      assert.ok(["200", "300"].includes(await page.$eval(".d3-screen h1", (el) => getComputedStyle(el).fontWeight)), "light page title");
      const ov = await overflow(page);
      assert.ok(ov <= 0, `no overflow @${route} ${viewport.width}: ${ov}`);
      if (route.endsWith("/points")) {
        assert.equal(await page.$eval(".pr-lead-number", (el) => getComputedStyle(el).fontFamily.includes("Urbanist")), true, "thin numerals on points page");
      }
      await page.screenshot({ path: `${EVIDENCE}/sales-${route.replace(/\//g, "_")}-${viewport.width}.png`, fullPage: true });
      assert.deepEqual(errors, [], `page errors @${route}`);
      record(`sales ${route} ${viewport.width}`);
      await context.close();
    }
  }
} finally {
  fs.writeFileSync(`${EVIDENCE}/qa-demo3-overview.json`, JSON.stringify(results, null, 2));
  await browser.close();
  await server.close();
}
console.log(`ALL ${results.length} OVERVIEW QA CHECKS PASSED — evidence in ${EVIDENCE}`);
