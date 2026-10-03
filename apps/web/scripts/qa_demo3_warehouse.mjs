// QA for the rebuilt Kho Tân Tạo page (Demo 3): populated / empty / error / view-only, desktop and phone;
// stock-count and chat guards still hold. Fixture auth + fixture data; writes are refused.
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
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-demo3-warehouse-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5194);
const { chromium } = createRequire(import.meta.url)(PW);
fs.mkdirSync(EVIDENCE, { recursive: true });

const SUPABASE_FIXTURE = `
const cfg = () => JSON.parse(localStorage.getItem("qa-shell") || "{}");
window.__qaWrites = window.__qaWrites || [];
const WRITE = new Set(["insert", "update", "upsert", "delete"]);
function settle(st) {
  const mode = cfg().data || "populated";
  if (st.table.startsWith("rpc:") && st.table !== "rpc:get_tan_tao_warehouse_snapshot") { window.__qaWrites.push(st.table); return { data: null, error: { message: "QA fixture: writes disabled" } }; }
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
  if (st.table === "rpc:reject_payment_request" && cfg().rejectError) return { data: null, error: { message: cfg().rejectError } };
  if (st.single) {
    if (filled && st.table === "payment_requests") return { data: PRS.find((pr) => pr.id === st.filters.id) || null, error: null };
    return { data: null, error: null };
  }
  const rows = filled ? fixtureRows(st) : null;
  if (rows) return { data: rows, error: null, count: rows.length };
  return { data: [], error: null, count: 0 };
}
const vnDay = (offsetDays) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(Date.now() - offsetDays * 86400000));
const nowIso = new Date().toISOString();
const doc = (id, n, type, quantity, extra = {}) => ({
  id, document_number: n, document_type: type, status: "posted", quantity, ordered_quantity: 0, exchange_quantity: 0, makeup_quantity: 0,
  physical_quantity: 0, supplier_billable_quantity: 0, supplier_credit_quantity: 0, supplier_exchange_quantity: 0, supplier_makeup_quantity: 0,
  reference_label: null, note: null, created_at: nowIso, ...extra,
});
const DOCS = [
  doc("d1", "TT-XK-0042", "outbound_order", 320, { ordered_quantity: 300, exchange_quantity: 12, makeup_quantity: 8, reference_label: "NPP Bình Tân" }),
  doc("d2", "TT-NCC-0018", "supplier_order", 1200, { supplier_billable_quantity: 1150, supplier_credit_quantity: 50, supplier_exchange_quantity: 30, supplier_makeup_quantity: 20, reference_label: "Lò Tân Tạo" }),
  doc("d3", "TT-KK-0007", "stock_count", 0, { physical_quantity: 186, reference_label: "Kiểm kê cuối ca" }),
];
const witem = (sku_code, product_name, unit, on, res, inc, docs = []) => ({
  sku_id: "sku-" + sku_code, sku_code, product_name, unit, on_hand_quantity: on, reserved_quantity: res, atp_quantity: on - res,
  incoming_quantity: inc, projected_quantity: on - res + inc, needs_attention: on - res < 0, recent_documents: docs,
});
function snapshot(mode) {
  const items = mode === "empty"
    ? [witem("BMQ-001", "Bánh mì tươi", "que", 0, 0, 0), witem("BMQ-002", "Bánh mì đông lạnh", "que", 0, 0, 0), witem("PATE-500G", "Pate 500g", "hộp", 0, 0, 0), witem("PATE-200G", "Pate 200g", "hộp", 0, 0, 0)]
    : [witem("BMQ-001", "Bánh mì tươi", "que", 186, 320, 1200, DOCS), witem("BMQ-002", "Bánh mì đông lạnh", "que", 940, 260, 0), witem("PATE-500G", "Pate 500g", "hộp", 165, 20, 40), witem("PATE-200G", "Pate 200g", "hộp", 40, 0, 0)];
  const sum = (key) => items.filter((i) => i.unit === "que").reduce((s, i) => s + i[key], 0);
  return {
    location_code: "TAN_TAO", location_name: "Kho Tân Tạo", sku_code: "BMQ-001", unit: "que",
    on_hand_quantity: sum("on_hand_quantity"), reserved_quantity: sum("reserved_quantity"), atp_quantity: sum("atp_quantity"),
    incoming_quantity: sum("incoming_quantity"), projected_quantity: sum("projected_quantity"), needs_attention: sum("atp_quantity") < 0,
    recent_documents: mode === "empty" ? [] : DOCS, can_manage: !cfg().viewer, items,
  };
}
function fixtureRows(st) {
  if (st.table === "rpc:get_tan_tao_warehouse_snapshot") return snapshot(cfg().data || "populated");
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
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-demo3-production-qa/vite-cache",
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


const prRows = (page) => page.locator("table tbody tr[role='button']");



const ROUTE = "/warehouse/tan-tao";
const kpiValues = (page) => page.$$eval(".d3-wh-kpi strong", (els) => els.map((el) => el.firstChild.textContent.trim()));
try {
  for (const data of ["populated", "empty", "error"]) {
    for (const viewport of WIDTHS) {
      if (data !== "populated" && viewport.width !== 390 && viewport.width !== 1440) continue;
      const { context, page, errors } = await open({ role: "owner", data }, ROUTE, viewport);
      await page.waitForSelector("[data-bmq-warehouse-layout='demo3-v1']");
      await page.waitForTimeout(1200);
      assert.equal(await page.locator("[data-bmq-tan-tao-multi-item-card]").count(), 4, "four item cards");
      assert.equal(await page.locator(".d3-wh-kpi").count(), 4, "four KPI tiles");
      const kpis = await kpiValues(page);
      if (data === "populated") {
        assert.deepEqual(kpis, ["1.126", "580", "546", "1.200"], "KPI tiles show the snapshot totals");
        assert.equal(await page.locator(".d3-wh-alert.is-warn").count(), 0, "no page warning while total ATP is positive");
        assert.equal(await page.locator("[data-bmq-tan-tao-multi-item-card].is-alert").count(), 1, "the negative-ATP item is flagged");
        assert.equal(await page.locator(".d3-wh-tl li").count(), 3, "documents on the timeline");
        const tl = await page.locator(".d3-wh-tl").textContent();
        assert.ok(tl.includes("Lò tính tiền 1.150") && tl.includes("Khấu trừ công nợ lò 50"), "supplier credit split kept");
        assert.ok(tl.includes("Đặt 300 · Đổi 12 · Bù 8"), "outbound split kept");
        assert.equal(await page.locator("[data-bmq-tan-tao-multi-item-card] .d3-wh-mbars i").count(), 16, "mini bars per card");
        assert.ok((await page.locator(".d3-wh-head h1").textContent()).includes("ATP 546 que"), "headline shows real ATP");
      }
      if (data === "empty") {
        assert.deepEqual(kpis, ["0", "0", "0", "0"]);
        assert.ok((await page.locator(".d3-wh").textContent()).includes("Chưa có chứng từ"), "empty documents message");
      }
      if (data === "error") {
        assert.deepEqual(kpis, ["—", "—", "—", "—"], "errors never render as zero");
        assert.ok((await page.locator(".d3-wh").textContent()).includes("Không tải được sổ kho"));
        const onhand = await page.$$eval(".d3-wh-onhand strong", (els) => els.map((el) => el.textContent));
        assert.ok(onhand.every((v) => v === "—"), `item cards show — on error: ${onhand}`);
      }
      const ov = await overflow(page);
      assert.ok(ov <= 0, `no overflow ${data} ${viewport.width}: ${ov}`);
      await page.screenshot({ path: `${EVIDENCE}/warehouse-${data}-${viewport.width}.png`, fullPage: true });
      if (data === "populated" && (viewport.width === 1440 || viewport.width === 390)) {
        for (const [i, sel] of [".d3-wh-kpis", "[data-bmq-tan-tao-multi-item-card]", ".d3-wh-count", ".d3-wh-chat", ".d3-wh-grid > section:last-child"].entries()) {
          await page.locator(sel).first().screenshot({ path: `${EVIDENCE}/warehouse-part${i}-${viewport.width}.png` });
        }
      }
      assert.deepEqual(errors, [], `page errors ${data} ${viewport.width}`);
      record(`warehouse ${data} ${viewport.width} (tab ${await activeTab(page)})`);
      await context.close();
    }
  }
  // Interactions: card selects the count SKU, chips only prefill, a declined confirm writes nothing.
  {
    const { context, page, errors } = await open({ role: "owner", data: "populated" }, ROUTE, { width: 1440, height: 900 });
    await page.waitForSelector(".d3-wh-count");
    const submit = page.getByRole("button", { name: "Ghi nhận kiểm kê vật lý" });
    assert.ok(await submit.isDisabled(), "submit disabled until quantity and reason");
    await page.locator("[data-bmq-tan-tao-multi-item-card]").nth(2).click();
    assert.equal(await page.locator("#tan-tao-stock-count-sku").inputValue(), "PATE-500G", "card click selects the SKU");
    assert.equal(await page.locator("[data-bmq-tan-tao-multi-item-card].is-selected").count(), 1);
    await page.locator("#tan-tao-stock-count-quantity").fill("160");
    await page.locator("#tan-tao-stock-count-reason").fill("QA kiểm kê");
    assert.ok(await submit.isEnabled(), "submit enabled with quantity and reason");
    page.once("dialog", (d) => d.dismiss());
    await submit.click();
    await page.waitForTimeout(300);
    await page.locator(".d3-wh-chips button").first().click();
    assert.ok((await page.locator(".d3-wh-ask textarea").inputValue()).length > 0, "chip prefills the composer");
    assert.equal(await page.locator(".d3-wh-msg.is-user").count(), 0, "chip does not send");
    assert.deepEqual(await page.evaluate(() => window.__qaWrites), [], "nothing written");
    await page.screenshot({ path: `${EVIDENCE}/warehouse-interaction-1440.png` });
    assert.deepEqual(errors, []);
    record("card selects SKU, chip prefills only, declined confirm writes nothing");
    await context.close();
  }
  // View-only accounts keep the read view without any write form.
  {
    const { context, page, errors } = await open({ role: "owner", data: "populated", viewer: true }, ROUTE, { width: 390, height: 844 });
    await page.waitForSelector("[data-bmq-warehouse-layout='demo3-v1']");
    await page.waitForTimeout(800);
    assert.equal(await page.locator("#tan-tao-stock-count-quantity").count(), 0, "no count form");
    assert.equal(await page.locator(".d3-wh-ask").count(), 0, "no composer");
    assert.ok((await page.locator(".d3-wh").textContent()).includes("Bạn chỉ có quyền xem Kho Tân Tạo"));
    assert.ok((await overflow(page)) <= 0);
    await page.screenshot({ path: `${EVIDENCE}/warehouse-viewer-390.png`, fullPage: true });
    assert.deepEqual(errors, []);
    record("view-only 390");
    await context.close();
  }
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    await page.goto("file:///Users/c.o.t.e/.openclaw/workspace-sushi/generated/bmq-demo-cleanup-20261002/demo-source/c/index.html#kho");
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${EVIDENCE}/demo3-kho-${width}.png`, fullPage: true });
    await page.close();
  }
} finally {
  fs.writeFileSync(`${EVIDENCE}/qa-demo3-warehouse.json`, JSON.stringify(results, null, 2));
  await browser.close();
  await server.close();
}
console.log(`ALL ${results.length} WAREHOUSE QA CHECKS PASSED — evidence in ${EVIDENCE}`);
