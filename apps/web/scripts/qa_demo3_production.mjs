// QA for the rebuilt Sản xuất · Xưởng Q7 page (Demo 3): populated / empty / error, desktop and phone,
// all KFM actions still reachable. Fixture auth + fixture data; writes are refused.
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
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-demo3-production-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5193);
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
const pr = (id, n, title, status, payment_status, amount, supplier) => ({
  id, request_number: n, title, description: null, supplier_id: "s-" + id, total_amount: amount, status, payment_status,
  delivery_status: "pending", payment_method: "bank_transfer", payment_type: "supplier", image_url: null, notes: null,
  created_by: "qa-user", approved_by: status === "approved" ? "qa-user" : null, approved_at: status === "approved" ? nowIso : null,
  rejection_reason: null, created_at: nowIso, updated_at: nowIso, invoice_id: null, invoice_created: false, vat_amount: 0,
  goods_receipt_id: null, purchase_order_id: null, paid_at: null,
  suppliers: { id: "s-" + id, name: supplier }, payment_request_items: [{ id: "it-" + id, product_name: "Bơ lạt Anchor 25kg", raw_product_name: null }],
  payment_allocations: [], goods_receipts: null, purchase_orders: null, invoices: null,
});
const PRS = [
  pr("11111111-1111-4111-8111-000000000001", "DC-QA-001", "Thanh toán bơ lạt tháng 10", "pending", "unpaid", 13500000, "TV Food"),
  pr("11111111-1111-4111-8111-000000000002", "DC-QA-002", "Thanh toán bột mì", "pending", "unpaid", 8200000, "Bột mì Bình Đông"),
  pr("11111111-1111-4111-8111-000000000003", "DC-QA-003", "Thanh toán bao bì", "approved", "unpaid", 4600000, "Bao bì Minh Phát"),
  pr("11111111-1111-4111-8111-000000000004", "DC-QA-004", "Thanh toán pate gan", "approved", "paid", 3100000, "Pate Hạ Long"),
];
const SKUS = [
  { id: "sku-pate", sku_code: "BMQ-001", product_name: "Bánh mì que pate", category: "Thành phẩm", sku_type: "finished_good", unit: "que", image_url: null },
  { id: "sku-bo", sku_code: "BMQ-002", product_name: "Bánh mì que bơ sữa", category: "Thành phẩm", sku_type: "finished_good", unit: "que", image_url: null },
  { id: "sku-xx", sku_code: "BMQ-003", product_name: "Bánh mì que xá xíu", category: "Thành phẩm", sku_type: "finished_good", unit: "que", image_url: null },
];
const item = (sku_id, product_name, qty, date) => ({ sku_id, product_name, qty, unit: "que", unit_price: 6500, line_total: qty * 6500, date });
const INBOX = [0, 1].flatMap((offset) => {
  const day = vnDay(-offset);
  return [
    { id: "po-kfm-" + offset, po_number: "KFM-PO-" + (1201 + offset), from_name: "KingFoodMart", delivery_date: day, match_status: "approved", total_amount: 0, attachment_names: [], raw_payload: { source: "kfm_portal" },
      production_items: [item("sku-pate", "Bánh mì que pate", 2400, day), item("sku-bo", "Bánh mì que bơ sữa", 1260, day)] },
    { id: "po-npp-" + offset, po_number: "NPP-BT-" + (88 + offset), from_name: "NPP Bình Tân", from_email: "npp@example.invalid", delivery_date: day, match_status: "pending_approval", total_amount: 0, attachment_names: ["PO-NPP-Binh-Tan.pdf"], raw_payload: null,
      production_items: [item("sku-xx", "Bánh mì que xá xíu", 820, day), item("sku-pate", "Bánh mì que pate", 400, day)] },
  ];
});
const ORDERS = [
  { id: "ord-1", production_number: "SX-Q7-0301", status: "planned", po_number: "KFM-PO-1190", customer_name: "KingFoodMart", planned_start_date: vnDay(0), planned_end_date: vnDay(0), items_count: 2, revenue_draft_id: null, location_code: "Q7", created_at: nowIso,
    items: [{ id: "oi-1", product_name: "Bánh mì que pate", planned_qty: 1800, ordered_qty: 1800, unit: "que", delivery_date: vnDay(0) }, { id: "oi-2", product_name: "Bánh mì que bơ sữa", planned_qty: 900, ordered_qty: 900, unit: "que", delivery_date: vnDay(0) }] },
  { id: "ord-2", production_number: "SX-Q7-0300", status: "completed", po_number: "NPP-BT-80", customer_name: "NPP Bình Tân", planned_start_date: vnDay(1), planned_end_date: vnDay(1), items_count: 1, revenue_draft_id: null, location_code: "Q7", created_at: nowIso,
    items: [{ id: "oi-3", product_name: "Bánh mì que xá xíu", planned_qty: 600, ordered_qty: 600, unit: "que", delivery_date: vnDay(1) }] },
  { id: "ord-3", production_number: "SX-Q7-0302", status: "planned", po_number: "KFM-PO-1203", customer_name: "KingFoodMart", planned_start_date: vnDay(-1), planned_end_date: vnDay(-1), items_count: 1, revenue_draft_id: null, location_code: "Q7", created_at: nowIso,
    items: [{ id: "oi-4", product_name: "Bánh mì que pate", planned_qty: 2100, ordered_qty: 2100, unit: "que", delivery_date: vnDay(-1) }] },
];
function fixtureRows(st) {
  if (st.table === "payment_requests") return PRS;
  if (st.table === "product_skus") return SKUS;
  if (st.table === "production_location_sku_settings") return SKUS.map((sku) => ({ sku_id: sku.id, is_enabled: true }));
  if (st.table === "customer_po_inbox") return INBOX;
  if (st.table === "production_orders") return ORDERS.map(({ items, ...order }) => order);
  if (st.table === "production_order_items") return ORDERS.flatMap((order) => (order.items || []).map((item) => ({ ...item, production_order_id: order.id, created_at: nowIso })));
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



const ROUTE = "/production/planning/q7";
try {
  for (const data of ["populated", "empty", "error"]) {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
      if (data !== "populated" && viewport.width !== 390 && viewport.width !== 1440) continue;
      const { context, page, errors } = await open({ role: "owner", data }, ROUTE, viewport);
      await page.waitForSelector("[data-stitch-production-planning]");
      await page.waitForTimeout(1500);
      assert.equal(await activeTab(page), "Sản xuất");
      // Every KFM entry point is still on the page.
      assert.equal(await page.locator("[data-bmq-production-layout='demo3-v2']").count(), 1, "demo 3 layout");
      for (const label of ["Thiết lập SX", "Kiểm tra PO", "Cổng KFM", "Màn hình TV", "Tạo kế hoạch SX"]) {
        assert.ok((await page.getByRole("button", { name: label }).count()) + (await page.getByRole("link", { name: label }).count()) > 0, `${label} present (${data} ${viewport.width})`);
      }
      if (data === "populated") {
        const products = await page.$$eval(".d3-pp-prod h3", (els) => els.map((el) => el.textContent));
        assert.ok(products.length >= 2, `products listed: ${products}`);
        assert.equal(await page.locator(".d3-pp-bead").count(), 21, "bead gauge drawn");
        assert.ok(await page.locator(".d3-pp-bead.is-on").count() > 1, "gauge reflects ordered share");
        assert.ok(!(await page.locator(".d3-pp-big").textContent()).startsWith("0"), "ordered share above 0 with real order items");
        assert.equal(await page.locator(".d3-pp-step").count(), 4, "flow steps");
        assert.equal(await page.locator(".d3-pp-grp").count(), 3, "next 3 days");
        assert.ok(await page.locator(".d3-pp-row", { hasText: "NPP-BT" }).count() > 0, "other PO row listed");
        assert.equal(await page.locator(".d3-pp-order").count(), 3, "orders listed");
      }
      if (data === "error") assert.equal(await page.locator("[data-kfm-pending-error='v1']").count(), 1, "PO read error shown, not empty");
      if (data === "empty") assert.ok((await page.locator(".d3-pp").textContent()).includes("Chưa có PO chờ sản xuất"), "empty message");
      const ov = await overflow(page);
      assert.ok(ov <= 0, `no overflow ${data} ${viewport.width}: ${ov}`);
      await page.screenshot({ path: `${EVIDENCE}/production-${data}-${viewport.width}.png`, fullPage: true });
      assert.deepEqual(errors, [], `page errors ${data} ${viewport.width}`);
      record(`production ${data} ${viewport.width}`);
      await context.close();
    }
  }
  // Interactions: settings tab round-trip, order items expand, nothing written.
  {
    const { context, page, errors } = await open({ role: "owner", data: "populated" }, ROUTE, { width: 1440, height: 900 });
    await page.waitForSelector(".d3-pp-order");
    await page.locator(".d3-pp-order").first().getByRole("button", { name: /Xem hàng/ }).click();
    await page.waitForTimeout(400);
    await page.getByRole("button", { name: "Thiết lập SX", exact: true }).click();
    await page.waitForSelector("[data-stitch-production-settings]");
    await page.getByRole("button", { name: "Quay lại kế hoạch" }).click();
    await page.waitForSelector(".d3-pp-dash");
    assert.deepEqual(await page.evaluate(() => window.__qaWrites.filter((w) => !w.startsWith("invoke:"))), []);
    assert.deepEqual(errors, []);
    record("settings round-trip, order expand, no writes");
    await context.close();
  }
  // Demo 3 reference at the same widths for side-by-side review.
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
    await page.goto("file:///Users/c.o.t.e/.openclaw/workspace-sushi/generated/bmq-demo-cleanup-20261002/demo-source/c/index.html#san-xuat");
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${EVIDENCE}/demo3-san-xuat-${width}.png`, fullPage: true });
    await page.close();
  }
} finally {
  fs.writeFileSync(`${EVIDENCE}/qa-demo3-production.json`, JSON.stringify(results, null, 2));
  await browser.close();
  await server.close();
}
console.log(`ALL ${results.length} PRODUCTION QA CHECKS PASSED — evidence in ${EVIDENCE}`);
