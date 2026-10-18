// QA for Mua so với Dùng NVL Q7 (/warehouse/purchase-usage): KPI filters, item rows with months,
// the item detail (usage by product, purchase lines + conversion), the receipt dialog opened from
// a purchase line, plus loading/empty/error/no-permission states, at 1440 / 390 / 320.
//
// FIXTURE AUTH + FIXTURE DATA: AuthContext and the Supabase client are replaced by in-memory
// fixtures shaped like the live report of 19/10 (Bột mì 888 GRN-000473 250 Bao, Peerless, Chà bông);
// every write is refused and recorded, and all non-local network is blocked. Not real-user acceptance.
//
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome node scripts/qa_purchase_usage.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-purchase-usage-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5231);
const { chromium } = createRequire(import.meta.url)(PW);
fs.mkdirSync(EVIDENCE, { recursive: true });

const SUPABASE_FIXTURE = `
const cfg = () => JSON.parse(localStorage.getItem("qa-shell") || "{}");
window.__qaWrites = window.__qaWrites || [];
window.__qaRpc = window.__qaRpc || [];
const WRITE = new Set(["insert", "update", "upsert", "delete"]);
const M = ["2026-08", "2026-09", "2026-10"];
const cell = (u, b, unk = 0, n = 0) => ({ used_qty: u, bought_qty: b, unknown_lines: unk, purchase_lines: n });
const ITEMS = [
  { kitchen_inventory_item_id: "k-bm888", name: "Bột mì 888 Cam", unit: "g", status: "big_gap", ratio: 9.74,
    total: cell(693201.98, 6750000, 0, 3), months: { "2026-08": cell(256200, 6250000, 0, 1), "2026-09": cell(475052.4, 250000, 0, 1), "2026-10": cell(0, 250000, 0, 1) } },
  { kitchen_inventory_item_id: "k-cbc", name: "Chà bông cay", unit: "g", status: "needs_conversion", ratio: 0.66,
    total: cell(83350, 55000, 2, 4), months: { "2026-08": cell(32000, 0), "2026-09": cell(57925, 30000, 2, 4), "2026-10": cell(0, 25000) } },
  { kitchen_inventory_item_id: "k-vihawa", name: "Nước Vihawa 20L Bình Vòi", unit: "g", status: "no_purchase_link", ratio: null,
    total: cell(287831.35, 0), months: { "2026-08": cell(110000, 0), "2026-09": cell(196229.8, 0), "2026-10": cell(0, 0) } },
  { kitchen_inventory_item_id: "k-dau", name: "Dầu Hướng Dương Simply 2L x 6 Chai / Thùng (thùng 12 lít, giao kèm hóa đơn đỏ)", unit: "g", status: "no_purchase_link", ratio: null,
    total: cell(86884.04, 0), months: { "2026-08": cell(33300, 0), "2026-09": cell(60381, 0), "2026-10": cell(0, 0) } },
  { kitchen_inventory_item_id: "k-peerless", name: "Peerless Úc 25kg", unit: "g", status: "ok", ratio: 2.25,
    total: cell(332852.594, 750000, 0, 6), months: { "2026-08": cell(114700, 250000, 0, 2), "2026-09": cell(209901.6, 250000, 0, 2), "2026-10": cell(8251, 250000, 0, 2) } },
  { kitchen_inventory_item_id: "k-trung", name: "Trứng gà 60gr", unit: "g", status: "ok", ratio: 2.52,
    total: cell(85880.13, 216000, 0, 4), months: { "2026-08": cell(32900, 108000, 0, 2), "2026-09": cell(59444.4, 54000, 0, 1), "2026-10": cell(0, 54000, 0, 1) } },
];
const EXTRA = [
  { kitchen_inventory_item_id: "k-bottega", name: "Bottega zelachi italian grated cheese", unit: "g", bought_qty: 15000, unknown_lines: 0, purchase_lines: 3, status: "not_in_recipe" },
  { kitchen_inventory_item_id: "k-tem", name: "Tem 17k", unit: "con", bought_qty: 0, unknown_lines: 2, purchase_lines: 2, status: "not_in_recipe" },
];
const REPORT = { from: "2026-08-01", to: "2026-10-19", months: M, generated_at: "2026-10-19T03:00:00Z", items: ITEMS, q7_extra_purchases: EXTRA };
const LINE = (o) => ({ source: "goods_receipt", document_id: "gr-473", document_number: "GRN-000473", doc_date: "2026-08-11", month: "2026-08", receiving_location: "q7",
  supplier_id: "s-pt", supplier_name: "Phúc Thịnh", product_name: "Bột mì 888 Cam (25kg)", quantity: 250, unit: "Bao", factor: 25000, factor_source: "alias", book_qty: 6250000,
  kitchen_inventory_item_id: "k-bm888", image_url: "gr-473/delivery.jpg", photo_count: 0, ...o });
const DETAILS = {
  "k-bm888": { kitchen_inventory_item_id: "k-bm888", name: "Bột mì 888 Cam", unit: "g", from: "2026-08-01", to: "2026-10-19", used_qty: 693201.98, bought_qty: 6750000, unknown_lines: 0,
    purchases: [
      LINE({ document_id: "gr-575", document_number: "GRN-000575", doc_date: "2026-10-10", month: "2026-10", receiving_location: "tan_tao", quantity: 250, unit: "kg", factor: 1000, factor_source: "line_unit", book_qty: 250000 }),
      LINE({ document_id: "gr-542", document_number: "GRN-000542", doc_date: "2026-09-20", month: "2026-09", quantity: 250, unit: "kg", factor: 1000, factor_source: "line_unit", book_qty: 250000, photo_count: 2 }),
      LINE({}),
    ],
    usage_by_product: [
      { finished_sku_id: "sku-cbc", sku_code: "cbc-2026-v2", product_name: "BÁNH MÌ CHÀ BÔNG CAY", used_qty: 532922.96, issue_count: 44 },
      { finished_sku_id: "sku-bmcb", sku_code: "bmcb-2026-v2", product_name: "Bánh Mì Chà Bông", used_qty: 160279.02, issue_count: 39 },
    ] },
  "k-cbc": { kitchen_inventory_item_id: "k-cbc", name: "Chà bông cay", unit: "g", from: "2026-08-01", to: "2026-10-19", used_qty: 83350, bought_qty: 55000, unknown_lines: 2,
    purchases: [
      LINE({ document_id: "pr-cb1", source: "payment_request", document_number: "PR-7C1D2E3F", doc_date: "2026-09-12", month: "2026-09", supplier_name: "Hasu Food", product_name: "Chà bông cay loại 1", quantity: 25, unit: "con", factor: null, factor_source: null, book_qty: null, image_url: null }),
      LINE({ document_id: "gr-530", document_number: "GRN-000530", doc_date: "2026-09-03", month: "2026-09", supplier_name: "Hasu Food", product_name: "Chà bông cay", quantity: 30, unit: "kg", factor: 1000, factor_source: "line_unit", book_qty: 30000, image_url: null }),
    ],
    usage_by_product: [{ finished_sku_id: "sku-cbc", sku_code: "cbc-2026-v2", product_name: "BÁNH MÌ CHÀ BÔNG CAY", used_qty: 83350, issue_count: 44 }] },
  "k-vihawa": { kitchen_inventory_item_id: "k-vihawa", name: "Nước Vihawa 20L Bình Vòi", unit: "g", from: "2026-08-01", to: "2026-10-19", used_qty: 287831.35, bought_qty: 0, unknown_lines: 0, purchases: [],
    usage_by_product: [{ finished_sku_id: null, sku_code: null, product_name: null, used_qty: 287831.35, issue_count: 71 }] },
};
const GR = { id: "gr-473", receipt_number: "GRN-000473", receipt_date: "2026-08-11", status: "received", image_url: null, purchase_order_id: "po-1", payable_status: "not_generated",
  supplier_id: "s-pt", suppliers: { id: "s-pt", name: "Phúc Thịnh" }, purchase_orders: { id: "po-1", po_number: "PO-000300", status: "received" }, payment_requests: [], goods_receipt_items: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function settle(st) {
  const c = cfg();
  if (st.table === "rpc:get_q7_purchase_usage_report") {
    window.__qaRpc.push({ name: st.table, ...(st.args || {}) });
    if (c.report === "slow") await sleep(1500);
    if (c.report === "error") return { data: null, error: { message: "boom" } };
    if (c.report === "denied") return { data: null, error: { message: "insufficient_privilege", code: "42501" } };
    if (c.report === "empty") return { data: { ...REPORT, items: [], q7_extra_purchases: [] }, error: null };
    return { data: REPORT, error: null };
  }
  if (st.table === "rpc:get_q7_purchase_usage_item_detail") {
    window.__qaRpc.push({ name: st.table, ...(st.args || {}) });
    await sleep(150);
    return { data: DETAILS[st.args?.p_item_id] ?? null, error: DETAILS[st.args?.p_item_id] ? null : { message: "item_not_found" } };
  }
  if (st.table.startsWith("rpc:")) { window.__qaWrites.push(st.table); return { data: null, error: { message: "QA fixture: rpc disabled" } }; }
  if (st.write) { window.__qaWrites.push(st.table + ":" + st.write); return { data: null, error: { message: "QA fixture: writes disabled" }, count: null }; }
  if (st.single) {
    if (st.table === "goods_receipts") return { data: GR, error: null };
    return { data: null, error: null };
  }
  if (st.head) return { data: null, error: null, count: 0 };
  return { data: [], error: null, count: 0 };
}
function builder(table, args) {
  const st = { table, args, ins: {}, iss: {}, eqs: {}, head: false, single: false, write: null };
  const proxy = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return (ok, ko) => Promise.resolve(settle(st)).then(ok, ko);
      if (prop === "catch") return (ko) => Promise.resolve(settle(st)).catch(ko);
      if (prop === "finally") return (fn) => Promise.resolve(settle(st)).finally(fn);
      return (...a) => {
        if (WRITE.has(prop)) st.write = prop;
        if (prop === "select" && a[1] && a[1].head) st.head = true;
        if (prop === "eq") st.eqs[a[0]] = a[1];
        if (prop === "in") st.ins[a[0]] = a[1];
        if (prop === "is") st.iss[a[0]] = a[1];
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
  rpc: (fn, args) => builder("rpc:" + fn, args),
  schema: () => ({ from: (table) => builder(table), rpc: (fn, args) => builder("rpc:" + fn, args) }),
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
const MODULES = { owner: null, kho: ["dashboard", "inventory", "goods_receipts"] }[role];
const user = { id: "qa-user", email: "qa@bmq.test", user_metadata: { full_name: "Tâm Vũ" } };
const can = (key) => MODULES === null || MODULES.includes(key);
const value = {
  user, session: { access_token: "qa-fixture-token", user },
  profile: { id: "qa-profile", user_id: "qa-user", full_name: "Tâm Vũ", email: user.email },
  loading: false, timedOut: false, roles: role === "owner" ? ["owner"] : ["staff"], authzLoaded: true, authzError: false,
  isOwner: role === "owner", canAccessModule: can, canEditModule: can,
  signOut: async () => {}, refreshProfile: async () => {}, refreshRoles: async () => {},
};
const Ctx = createContext(value);
export function AuthProvider({ children }) { return React.createElement(Ctx.Provider, { value }, children); }
export function useAuth() { return useContext(Ctx); }
`;

const fixtures = {
  name: "qa-purchase-usage-fixtures",
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
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-purchase-usage-qa-vite",
  server: { port: PORT, strictPort: true, host: "127.0.0.1" },
  define: { __APP_VERSION__: JSON.stringify("qa"), __APP_SEMVER__: JSON.stringify("vqa") },
  resolve: { alias: { "@": path.join(ROOT, "src") } },
  plugins: [fixtures, react()],
});
await server.listen();
const BASE = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({ executablePath: CHROME });

async function open(cfg, route, viewport) {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce", locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" });
  await context.addInitScript((value) => localStorage.setItem("qa-shell", JSON.stringify(value)), cfg);
  await context.route("**/*", (r) => {
    const url = r.request().url();
    if (url.startsWith(BASE) || url.startsWith("data:") || url.startsWith("blob:") || /fonts\.(googleapis|gstatic)\.com/.test(url)) return r.continue();
    return r.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + route, { waitUntil: "domcontentloaded", timeout: 90000 });
  await page.waitForSelector("[data-bmq-shell='demo3-v1']", { timeout: 60000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  return { context, page, errors };
}

const overflowOk = async (page) => (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0;
const WIDTHS = [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }];
const ROUTE = "/warehouse/purchase-usage";

try {
  for (const viewport of WIDTHS) {
    const w = viewport.width;
    const { context, page, errors } = await open({ role: "owner" }, ROUTE, viewport);
    await page.waitForSelector("[data-bmq-pu-item]");
    // Default range = 3 tháng: from the 1st of the month two months back to today.
    const call = (await page.evaluate(() => window.__qaRpc)).find((c) => c.name === "rpc:get_q7_purchase_usage_report");
    assert.match(call.p_from, /^\d{4}-\d{2}-01$/, JSON.stringify(call));
    assert.equal(await page.locator("[data-bmq-pu-item]").count(), 6);
    assert.equal((await page.locator("[data-bmq-pu-filter='big_gap'] strong").textContent()).trim(), "1");
    assert.equal((await page.locator("[data-bmq-pu-filter='no_purchase_link'] strong").textContent()).trim(), "2");
    const first = await page.locator("[data-bmq-pu-item]").first().textContent();
    assert.ok(first.includes("Bột mì 888 Cam") && first.includes("693,2 kg") && first.includes("6.750 kg") && first.includes("Mua gấp 9,74 lần lượng dùng"), first);
    assert.ok(first.includes("T8/2026") && first.includes("6.250 kg"), first);
    assert.ok(await overflowOk(page), `overflow ${w}`);
    await page.screenshot({ path: `${EVIDENCE}/page-${w}.png`, fullPage: true });
    // KPI filter.
    await page.locator("[data-bmq-pu-filter='no_purchase_link']").click();
    assert.equal(await page.locator("[data-bmq-pu-item]").count(), 2);
    assert.ok(await page.locator("[data-bmq-pu-item='no_purchase_link']").first().isVisible());
    assert.ok(await overflowOk(page), `overflow filtered ${w}`);
    await page.locator("[data-bmq-pu-item]").nth(1).scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${EVIDENCE}/filter-nolink-${w}.png` });
    await page.locator("[data-bmq-pu-show-all]").click();
    assert.equal(await page.locator("[data-bmq-pu-item]").count(), 6);
    // Detail of Bột mì 888.
    await page.locator("[data-bmq-pu-item='big_gap'] .d3-pu-row").click();
    await page.waitForSelector("[data-bmq-pu-line]");
    const detail = await page.locator("[data-bmq-pu-detail]").textContent();
    assert.ok(detail.includes("BÁNH MÌ CHÀ BÔNG CAY") && detail.includes("532,9 kg") && detail.includes("44 phiếu xuất"), detail);
    assert.ok(detail.includes("GRN-000473") && detail.includes("250 Bao") && detail.includes("= 6.250 kg") && detail.includes("Theo quy đổi đã khai"), detail);
    assert.ok(detail.includes("Theo đơn vị trên phiếu") && detail.includes("có ảnh phiếu + 2 ảnh hàng"), detail);
    assert.ok(await page.evaluate(() => { const d = document.querySelector("[data-bmq-pu-detail]"); return d.scrollWidth <= d.clientWidth + 1; }), `detail fits ${w}`);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${EVIDENCE}/detail-${w}.png` });
    await page.locator("[data-bmq-pu-line]").last().scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    await page.screenshot({ path: `${EVIDENCE}/detail-lines-${w}.png` });
    // Opening the receipt from a purchase line shows the existing receipt dialog.
    await page.locator("[data-bmq-pu-line]").last().locator("[data-bmq-pu-open-doc]").click();
    await page.waitForFunction(() => document.querySelectorAll('[role="dialog"]').length >= 2);
    await page.waitForTimeout(500);
    assert.ok((await page.locator('[role="dialog"]').last().textContent()).includes("GRN-000473"));
    await page.screenshot({ path: `${EVIDENCE}/receipt-from-line-${w}.png` });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    // Chà bông: a payment-request line that cannot be converted.
    await page.locator("[data-bmq-pu-item='needs_conversion'] .d3-pu-row").click();
    await page.waitForSelector("[data-bmq-pu-line='payment_request']");
    const cb = await page.locator("[data-bmq-pu-detail]").textContent();
    assert.ok(cb.includes("chưa đổi được ra g") && cb.includes("Chi không có phiếu nhập") && cb.includes("Chưa quy đổi được"), cb);
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${EVIDENCE}/detail-unknown-${w}.png` });
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    // An item without purchases explains how to link it.
    await page.locator("[data-bmq-pu-item='no_purchase_link'] .d3-pu-row").first().click();
    await page.waitForSelector("[data-bmq-pu-detail] .d3-pu-none");
    assert.ok((await page.locator("[data-bmq-pu-detail]").textContent()).includes("Chưa thấy hàng mua nào nối với món này"));
    assert.ok((await page.locator("[data-bmq-pu-detail]").textContent()).includes("Chưa rõ sản phẩm"));
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    // Range switch re-queries with a new from date.
    await page.locator("[data-bmq-pu-range='month']").click();
    await page.waitForFunction(() => window.__qaRpc.filter((c) => c.name === "rpc:get_q7_purchase_usage_report").length >= 2);
    const calls = (await page.evaluate(() => window.__qaRpc)).filter((c) => c.name === "rpc:get_q7_purchase_usage_report");
    assert.notEqual(calls.at(-1).p_from, calls[0].p_from);
    // Extra purchases card.
    assert.ok((await page.locator("[data-bmq-pu-extra]").textContent()).includes("2 dòng chưa quy đổi"));
    assert.deepEqual(await page.evaluate(() => window.__qaWrites), [], "no writes");
    assert.deepEqual(errors, [], `page errors ${w}`);
    console.log("PASS", `page + detail ${w}`);
    await context.close();
  }
  // States at 390.
  for (const state of ["empty", "error", "denied", "slow"]) {
    const { context, page, errors } = await open({ role: "owner", report: state }, ROUTE, { width: 390, height: 844 });
    if (state === "slow") {
      await page.waitForSelector("text=Đang tính…");
      await page.screenshot({ path: `${EVIDENCE}/state-slow-390.png` });
    } else if (state === "empty") {
      await page.waitForSelector("text=Chưa có phiếu xuất theo đơn trong kỳ này.");
    } else {
      await page.waitForSelector("text=Không tải được bảng.");
      if (state === "denied") assert.ok((await page.locator(".d3-wh-alert.is-error").textContent()).includes("chưa có quyền xem Kho"));
      assert.equal(await page.locator(".d3-pu-list, .d3-wh-empty").count(), 0, "no empty list under an error");
    }
    assert.ok(await overflowOk(page));
    await page.screenshot({ path: `${EVIDENCE}/state-${state}-390.png` });
    assert.deepEqual(errors, []);
    console.log("PASS", `state ${state}`);
    await context.close();
  }
  // A kho user (inventory module only) sees the page and the menu entry.
  {
    const { context, page, errors } = await open({ role: "kho" }, ROUTE, { width: 1440, height: 900 });
    await page.waitForSelector("[data-bmq-pu-item]");
    assert.ok(await page.locator("a[href='/warehouse/purchase-usage']").count() >= 1, "menu entry visible");
    assert.deepEqual(errors, []);
    console.log("PASS", "kho role");
    await context.close();
  }
  console.log("ALL PASS");
} finally {
  await browser.close();
  await server.close();
}
