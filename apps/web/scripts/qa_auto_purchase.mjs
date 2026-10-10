// Browser QA for Đặt hàng tự động (/warehouse/auto-purchase): owner and staff, populated / empty / error.
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
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-auto-purchase-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5235);
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
  if (/^rpc:(resolve_stock_alias|record_q7_stock_count|record_tan_tao_stock_count|set_goods_receipt_receiving_location|create_q7_draft_purchase_orders|upsert_q7_purchase_item_setting|update_q7_auto_purchase_settings|run_q7_auto_purchase_now)$/.test(st.table)) { window.__qaWrites.push(st.table + ":" + JSON.stringify(st.args)); return { data: null, error: { message: "QA fixture: writes disabled" } }; }
  if (st.table === "rpc:get_q7_purchase_forecast" && mode === "empty") return { data: { as_of: vnDay(0), horizon_days: 14, items: [] }, error: null };
  if (st.table === "rpc:get_q7_auto_purchase_status" && mode === "empty") return { data: { settings: AP_SETTINGS(false), latest_run: null, decisions: [] }, error: null };
  if (st.table === "rpc:get_stock_ledger_overview" && mode === "empty") return { data: { location: st.args.p_location, location_name: "x", as_of: vnDay(0), cutover_date: null, items: [], pending_aliases: [] }, error: null };
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
function AP_SETTINGS(enabled) { return { id: 1, enabled, system_actor_id: enabled ? "qa-user" : null, max_po_amount: 10000000, max_daily_amount: 30000000, max_stock_count_age_days: 10, max_backtest_error: 0.25, run_hour_vn: 6, updated_by: null, updated_at: nowIso }; }
const NOFLAGS = { no_stock_count: false, stale_stock_count: false, short_history: false, no_supplier: false, no_pack_size: false, no_price: false, duplicate_material: false, high_backtest_error: false };
function apItem(id, name, unit, mode, usage, onHand, sup, pack, label, reorderBack, qty, price, flags) {
  return { item_id: id, item_code: "NVL-" + id, item_name: name, unit, mode, daily_usage: usage, avg_14d: usage, avg_28d: usage, stddev_28d: usage / 10, days_with_data: 52, weekday_factor: 1, scheduled_usage: 0, on_hand: onHand, last_count_date: onHand === null ? null : vnDay(2), open_po_qty: 0, supplier_id: sup, pack_size: pack, pack_label: label, lead_time_days: 2, safety_days: 2, order_cycle_days: 7, reorder_date: vnDay(reorderBack), suggested_qty: qty, last_unit_price: price, estimated_amount: price === null ? null : qty * price, flags: { ...NOFLAGS, ...flags } };
}
function fixtureRows(st) {
  if (st.table === "rpc:get_q7_purchase_forecast") return { as_of: vnDay(0), horizon_days: 14, items: [
    apItem("a1", "Bột mì 888 Cam", "g", "auto_send", 13388, 40000, "sup1", 25000, "bao 25kg", 0, 375000, 16, {}),
    apItem("a2", "Bột mì 999 Cam", "g", "auto_draft", 12047, 30000, "sup1", 25000, "bao 25kg", 1, 350000, 17, { stale_stock_count: true }),
    apItem("a3", "Dầu Hướng Dương Simply 2L x 6 Chai / Thùng loại đặc biệt nhập khẩu", "g", "suggest", 2191, null, null, null, null, 0, 15337, null, { no_stock_count: true, no_supplier: true, no_pack_size: true, no_price: true, duplicate_material: true }),
    apItem("a4", "Đường", "g", "suggest", 849, 90000, "sup2", 50000, "bao 50kg", -9, 0, 20, {}),
  ] };
  if (st.table === "rpc:get_q7_auto_purchase_status") return { settings: AP_SETTINGS(true), latest_run: { id: "r1", run_date: vnDay(0), status: "done", started_at: nowIso, finished_at: nowIso, summary: {} }, decisions: [
    { id: "d1", run_id: "r1", item_id: "a1", item_name: "Bột mì 888 Cam", decision: "auto_send", reason_codes: ["auto_send"], suggested_qty: 375000, estimated_amount: 6000000, purchase_order_id: "po1", purchase_order_number: "PO-20261011-0001", created_at: nowIso },
    { id: "d2", run_id: "r1", item_id: "a2", item_name: "Bột mì 999 Cam", decision: "draft", reason_codes: ["stale_stock_count"], suggested_qty: 350000, estimated_amount: 5950000, purchase_order_id: "po2", purchase_order_number: "PO-20261011-0002", created_at: nowIso },
  ] };
  if (st.table === "suppliers") return [{ id: "sup1", name: "Phúc Thịnh" }, { id: "sup2", name: "Đường Biên Hòa" }];
  if (st.table === "rpc:get_stock_ledger_overview") {
    const q7 = st.args.p_location === "q7";
    const item = (id, code, name, unit, cur, inq, outq, cnt, diff) => ({ item_id: id, item_code: code, item_name: name, unit, current_qty: cur, in_qty_7d: inq, out_qty_7d: outq, last_count_date: cnt, last_count_difference: diff, is_low_stock: outq > 0 && cur < (outq / 7) * 3 });
    const items = q7 ? [
      item("k1", "NVL-TOI", "Tỏi bóc vỏ", "kg", 2.5, 12, 14, vnDay(3), -0.4),
      item("k2", "NVL-GAN", "Gan heo", "kg", 18, 30, 21, vnDay(3), 0),
      item("k3", "NVL-CAROT", "Cà rốt", "kg", 40, 35, 28, null, null),
      item("k4", "NVL-CHALUA", "Chả lụa lá TVP XL loại đặc biệt đóng gói hút chân không", "kg", 6.25, 10, 7, vnDay(3), 1.25),
    ] : [
      item("t1", "BMQ-001", "Bánh mì tươi", "que", 350, 2480, 2300, vnDay(1), -12),
      item("t2", "PATE-500G", "Pate 500g", "hộp", 40, 60, 70, null, null),
    ];
    const pend = (id, rn, sup, name, norm, q, back) => ({ goods_receipt_item_id: id, receipt_number: rn, supplier: sup, product_name: name, normalized_name: norm, quantity: q, receipt_date: vnDay(back) });
    const pending = q7 ? [
      pend("g1", "PN-1010-01", "Tỏi", "tỏi ngày 10", "toi", 5, 2), pend("g2", "PN-1010-04", "Tỏi", "tỏi ngày 11", "toi", 4, 1),
      pend("g3", "PN-1010-02", "Mai Hoàng Bích Hà", "gan 10", "gan", 6, 2), pend("g4", "PN-1010-03", "Đại Tân Việt", "DAIRYMONT WHITE SLICES CHEESE 1.04KG", "dairymont white slices cheese 1.04kg", 2, 1),
    ] : [];
    return { location: st.args.p_location, location_name: q7 ? "Kho NVL Q7" : "Kho Tân Tạo", as_of: vnDay(0), cutover_date: vnDay(7), items, pending_aliases: pending };
  }
  if (st.table === "rpc:get_q7_inventory_picker") return [
    { kitchen_inventory_item_id: "k1", display_label: "NVL-TOI · Tỏi bóc vỏ · kg" }, { kitchen_inventory_item_id: "k2", display_label: "NVL-GAN · Gan heo · kg" },
    { kitchen_inventory_item_id: "k3", display_label: "NVL-CAROT · Cà rốt · kg" }, { kitchen_inventory_item_id: "k4", display_label: "NVL-CHALUA · Chả lụa lá TVP XL · kg" },
  ];
  if (st.table === "goods_receipts") return [
    { id: "gr1", receipt_number: "PN-1010-01", supplier_id: "s1", receipt_date: vnDay(1), status: "confirmed", total_quantity: 9, payable_status: "generated", receiving_location: "q7", created_at: nowIso, suppliers: { id: "s1", name: "Tỏi" }, purchase_orders: { id: "p1", po_number: "PO-1", status: "approved" }, payment_requests: null },
    { id: "gr2", receipt_number: "PN-1010-02", supplier_id: "s2", receipt_date: vnDay(1), status: "draft", total_quantity: 2480, payable_status: "not_generated", receiving_location: null, created_at: nowIso, suppliers: { id: "s2", name: "Lò bánh Tân Tạo" }, purchase_orders: null, payment_requests: null },
  ];
  if (st.table === "payment_requests") return PRS;
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
function builder(table, args) {
  const st = { table, args: args || {}, filters: {}, head: false, single: false, write: null };
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
  rpc: (fn, args) => builder("rpc:" + fn, args),
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
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-auto-purchase-qa/vite-cache",
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
  // Duyệt chi now opens on "Chưa thanh toán" (Trình chi gấp); these checks cover the full list.
  if (route === "/payment-requests") await page.locator("[data-bmq-pr-view-all]").click({ timeout: 15000 });
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




for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
  for (const [data, role] of [["populated", "owner"], ["populated", "limited"], ["empty", "owner"], ["error", "owner"]]) {
    const { context, page, errors } = await open({ data, role }, "/warehouse/auto-purchase", viewport);
    await page.waitForSelector("[data-bmq-auto-purchase]", { timeout: 20000 });
    await page.waitForTimeout(400);
    assert.equal(await overflow(page), 0, `no horizontal overflow ${data} ${role} ${viewport.width}`);
    if (data === "populated") {
      assert.equal(await page.locator("[data-bmq-auto-purchase-item]").count(), 3, "three items due (Đường is covered)");
      assert.ok((await page.locator("[data-bmq-auto-purchase-item]").first().textContent()).includes("15 × bao 25kg"));
      assert.ok((await page.locator(".d3-ap-flags span", { hasText: "Chưa có kiểm kê" }).count()) >= 1);
      const chips = await page.$$eval(".d3-subnav .d3-chip", (els) => els.map((el) => el.textContent.trim()));
      assert.ok(chips[1]?.includes("Đặt hàng tự động"), chips.join(","));
      const autoSendDisabled = await page.locator(".d3-ap-mode").first().locator("option[value=auto_send]").isDisabled();
      assert.equal(autoSendDisabled, role !== "owner", "only owners may pick Tự gửi");
      if (role === "owner") {
        assert.equal(await page.getByRole("button", { name: "Tắt đặt hàng tự động" }).count(), 1);
        await page.locator("[data-bmq-auto-purchase-item] input[type=checkbox]").nth(0).check();
        await page.locator("[data-bmq-auto-purchase-item] input[type=checkbox]").nth(2).check();
        await page.getByRole("button", { name: /Tạo PO nháp \(2\)/ }).click();
        await page.locator(".d3-ap-mode").nth(1).selectOption("off");
        await page.getByRole("button", { name: "Tắt đặt hàng tự động" }).click();
        await page.waitForTimeout(300);
        const writes = await page.evaluate(() => window.__qaWrites);
        const draft = writes.find((w) => w.startsWith("rpc:create_q7_draft_purchase_orders:"));
        assert.ok(draft && draft.includes('"quantity":15') && draft.includes('"unit":"bao 25kg"') && draft.includes('"unit_price":400000') && draft.includes('"supplier_id":"sup1"'), draft);
        assert.ok(draft.includes('"quantity":15337') && draft.includes('"supplier_id":null'), "line without pack stays in book units");
        assert.ok(writes.some((w) => w.startsWith("rpc:upsert_q7_purchase_item_setting:") && w.includes('"p_mode":"off"')), JSON.stringify(writes));
        assert.ok(writes.some((w) => w.startsWith("rpc:update_q7_auto_purchase_settings:") && w.includes('"p_enabled":false')), JSON.stringify(writes));
        for (const sel of [".d3-ap-actions button", ".d3-ap-mode", "#ap-max-po"]) {
          const box = await page.locator(sel).first().boundingBox();
          assert.ok(box && box.height >= 36 && box.x >= 0 && box.x + box.width <= viewport.width, `${sel} usable at ${viewport.width}`);
        }
      } else {
        assert.equal(await page.locator("#ap-max-po").count(), 0, "staff cannot edit limits");
      }
      assert.ok(!(await page.locator("text=[object Object]").isVisible().catch(() => false)));
      await page.screenshot({ path: `${EVIDENCE}/auto-purchase-${role}-${viewport.width}.png`, fullPage: true });
      await page.getByRole("button", { name: /Xem tất cả/ }).click();
      await page.waitForTimeout(200);
      assert.equal(await page.locator("[data-bmq-auto-purchase-item]").count(), 4);
    }
    if (data === "empty") {
      assert.ok((await page.locator(".d3-wh-empty", { hasText: "Chưa có mặt hàng nào tới hạn đặt" }).count()) === 1);
      assert.equal(await page.getByRole("button", { name: "Bật đặt hàng tự động" }).count(), 1);
      await page.screenshot({ path: `${EVIDENCE}/auto-purchase-empty-${viewport.width}.png`, fullPage: true });
    }
    if (data === "error") {
      await page.waitForSelector(".d3-wh-alert.is-error", { timeout: 20000 });
      await page.screenshot({ path: `${EVIDENCE}/auto-purchase-error-${viewport.width}.png`, fullPage: true });
    }
    assert.deepEqual(errors, [], "no page errors");
    record(`auto-purchase ${data} ${role} ${viewport.width}`);
    await context.close();
  }
}
await browser.close();
await server.close();
console.log(`ALL ${results.length} AUTO PURCHASE QA CHECKS PASSED — evidence in ${EVIDENCE}`);
