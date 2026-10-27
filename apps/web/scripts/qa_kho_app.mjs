// Browser QA for the Kho pages in the app theme (owner 22/10/2026): Danh mục kho (/warehouse/danh-muc),
// Tên mới trên phiếu (?view=moi), Kiểm kê (/warehouse/kiem-ke) and Phiếu kho (/warehouse/phieu), inside the app shell.
//
// FIXTURE AUTH + FIXTURE DATA: AuthContext and the Supabase client are replaced by in-memory fixtures;
// every RPC call is recorded and nothing leaves the machine. This proves the real page components render,
// size and call the right RPCs with the right arguments; it is not real-user acceptance.
//
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core node scripts/qa_kho_app.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-kho-app-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5253);
const { chromium } = createRequire(import.meta.url)(PW);
fs.mkdirSync(EVIDENCE, { recursive: true });

const SUPABASE_FIXTURE = `
const cfg = () => JSON.parse(localStorage.getItem("qa-shell") || "{}");
window.__qaCalls = window.__qaCalls || [];
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
function khoItems() {
  const F = window.__kgFixture;
  const off = JSON.parse(localStorage.getItem("qa-off") || "[]");
  return F.items.map((it, i) => ({
    id: it.id, item_code: it.code, note: i === 0 ? "Chỉ mua của Ngọc Trân" : null, old_codes: i === 0 ? ["Q7-12103FFD875718D7A205"] : [], name: it.name, unit: i % 3 === 0 ? "g" : it.unit, active: !off.includes(it.id) && i % 17 !== 5,
    item_class: it.item_class, in_q7: Boolean(it.pastry_q7),
    qty: { tan_tao: it.pastry_q7 ? null : (i * 1371) % 50000, q7: it.pastry_q7 ? (i * 977) % 200000 - (i % 4 === 0 ? 3000 : 0) : null },
    last_count_date: { tan_tao: i % 7 === 0 ? today : i % 3 === 0 ? "2026-10-16" : null, q7: it.pastry_q7 && i % 5 === 0 ? today : null },
    pending_count: { tan_tao: i % 11 === 1 ? 21600 : null, q7: it.pastry_q7 && i % 6 === 1 ? 160000 : null },
    doc_lines: (i * 7) % 40,
  }));
}
function settle(st) {
  const mode = cfg().data || "populated";
  const role = cfg().role || "owner";
  window.__qaCalls.push(st.table + ":" + JSON.stringify(st.args));
  if (mode === "error" && st.table === "rpc:kho_get_items") return { data: null, error: { message: "canceling statement due to statement timeout", code: "57014" } };
  if (st.table === "rpc:kho_get_items") {
    const items = mode === "empty" ? [] : khoItems();
    return { data: { can_edit: role === "owner", can_count: { tan_tao: role === "owner", q7: role === "owner" }, items }, error: null };
  }
  if (st.table === "rpc:kho_save_item") {
    const a = st.args;
    const names = khoItems().filter((it) => it.id !== a.p_item_id);
    const twin = names.find((it) => it.name.toLowerCase() === String(a.p_name).trim().toLowerCase());
    if (twin && !a.p_merge) return { data: { status: "name_taken", other: { id: twin.id, name: twin.name, unit: twin.unit, active: twin.active } }, error: null };
    if (twin && a.p_merge) {
      if (twin.unit !== "g" && !a.p_unit_factor && twin.unit !== khoItems().find((it) => it.id === a.p_item_id).unit) return { data: { status: "unit_factor_needed", from: khoItems().find((it) => it.id === a.p_item_id).unit, to: twin.unit }, error: null };
      return { data: { status: "merged", into: { id: twin.id, name: twin.name, unit: twin.unit } }, error: null };
    }
    const me = khoItems().find((it) => it.id === a.p_item_id);
    if (a.p_unit !== me.unit && !a.p_unit_factor && !(me.unit === "g" && a.p_unit === "g")) return { data: { status: "unit_factor_needed", from: me.unit, to: a.p_unit }, error: null };
    if (a.p_active === false) { const off = JSON.parse(localStorage.getItem("qa-off") || "[]"); off.push(a.p_item_id); localStorage.setItem("qa-off", JSON.stringify(off)); }
    return { data: { status: "saved", item: { id: a.p_item_id, name: a.p_name, unit: a.p_unit, active: a.p_active } }, error: null };
  }
  if (st.table === "rpc:kho_count_item") {
    const me = khoItems().find((it) => it.id === st.args.p_item_id);
    const book = me.qty[st.args.p_location] ?? 0;
    return { data: { status: "counted", location: st.args.p_location, item_id: st.args.p_item_id, counted_qty: st.args.p_counted_qty, result: { status: "recorded", difference_qty: st.args.p_counted_qty - book } }, error: null };
  }
  if (st.table === "rpc:get_tan_tao_warehouse_snapshot") {
    return { data: { can_manage: role === "owner", items: [
      { sku_code: "BMQ-001", product_name: "Bánh mì tươi", unit: "que", on_hand_quantity: 38 },
      { sku_code: "BMQ-002", product_name: "Bánh mì đông lạnh", unit: "que", on_hand_quantity: 194 },
      { sku_code: "PATE-500G", product_name: "Pate 500g", unit: "hộp", on_hand_quantity: 23 },
      { sku_code: "PATE-200G", product_name: "Pate 200g", unit: "hộp", on_hand_quantity: 22 },
    ] }, error: null };
  }
  if (st.table === "rpc:set_item_pastry_q7") return { data: { item_id: st.args.p_item_id, pastry_q7: st.args.p_value }, error: null };
  if (st.table === "rpc:set_item_kho_locations") return { data: { item_id: st.args.p_item_id, in_tan_tao: st.args.p_tan_tao, in_q7: st.args.p_q7 }, error: null };
  if (st.table === "rpc:set_stock_item_class") return { data: { item_id: st.args.p_item_id, old_class: null, item_class: st.args.p_class }, error: null };
  if (st.table === "rpc:get_item_receipt_lines" || st.table === "rpc:get_crate_receipt_lines") return { data: window.__kgFixture.receipt_lines ?? [], error: null };
  if (st.table === "rpc:get_warehouse_game_snapshot") {
    const F = window.__kgFixture;
    const loc = st.args.p_location;
    const items = F.items.filter((it) => loc !== "q7" || it.pastry_q7);
    const q7Skus = [{ id: "fg-cbc", sku_code: "cbc-2026-v2", product_name: "BÁNH MÌ CHÀ BÔNG CAY", unit: "gói", on_hand: 12 }];
    return { data: { location: loc, cutover_date: "2026-10-16", items, skus: loc === "tan_tao" ? F.skus : q7Skus, pending: mode === "empty" ? [] : (loc === "q7" ? F.q7 : F.tt), transfers: F.transfers ?? [], counts: {}, can_edit: role === "owner" }, error: null };
  }
  if (st.table === "rpc:kho_get_units") return { data: ["g","ml"].map((c) => ({ code: c, label: c, kind: c === "g" ? "weight" : "volume", base_code: c, to_base: 1 })).concat(["bao","bịch","cái","cây","chai","cuộn","gói","hộp","thùng","tờ"].concat(JSON.parse(localStorage.getItem("qa-units") || "[]")).map((c) => ({ code: c, label: c, kind: "count", base_code: c, to_base: 1 }))), error: null };
  if (st.table === "rpc:kho_add_stock_unit") { const u = String(st.args.p_label).trim().toLowerCase(); const list = JSON.parse(localStorage.getItem("qa-units") || "[]"); list.push(u); localStorage.setItem("qa-units", JSON.stringify(list)); return { data: { status: "created", unit: u }, error: null }; }
  if (st.table === "rpc:kho_get_item_conversions") {
    const me = khoItems().find((it) => it.id === st.args.p_item_id);
    return { data: { item: { id: me.id, name: me.name, unit: me.unit, in_q7: me.in_q7 }, can_edit: role === "owner", cutover: { tan_tao: "2026-10-16", q7: "2026-10-16" },
      conversions: [
        { unit: "cây", factors: [1, 6], disagree: true, auto: false, alias_count: 3, supplier_names: ["Ngọc Trân- Cô Trang"], line_count: 4, posted_count: 1, last_receipt_date: "2026-09-20" },
        { unit: "thùng", factors: [24], disagree: false, auto: false, alias_count: 1, supplier_names: ["Mỹ Toàn"], line_count: 2, posted_count: 0, last_receipt_date: "2026-10-12" },
      ], saved: [] }, error: null };
  }
  if (st.table === "rpc:kho_set_item_conversion") {
    const f = Number(st.args.p_factor);
    const line = { receipt_number: "GRN-000543", receipt_date: "2026-09-20", location: "tan_tao", posted_qty: 10, new_qty: 10 * f, delta: 10 * f - 10 };
    if (st.args.p_dry_run) return { data: { status: "preview", aliases: 3, lines: [line], total_delta: { tan_tao: line.delta, q7: 0 } }, error: null };
    return { data: { status: "saved", aliases_updated: 3, lines: 1, total_delta: { tan_tao: line.delta, q7: 0 } }, error: null };
  }
  if (st.table === "rpc:kho_get_commitments") {
    const F = window.__kgFixture;
    const q7Item = F.items.find((it, i) => it.pastry_q7 && i % 17 !== 5 && ["raw_material", "unclassified"].includes(it.item_class));
    const ttItem = F.items.find((it, i) => !it.pastry_q7 && i % 3 !== 0 && i % 17 !== 5 && ["raw_material", "unclassified"].includes(it.item_class));
    const src = (ref, date, qty) => ({ kind: "pxk", ref, date, qty });
    return { data: { as_of: today,
      items: mode === "empty" ? [] : [
        { kitchen_inventory_item_id: q7Item.id, location: "q7", committed_qty: 1250, unit: q7Item.unit, next_date: today.replace(/\d\d$/, (d) => String(Math.min(28, Number(d) + 1)).padStart(2, "0")), sources: [src("PXK-NVL-Q7-QA-001", today, 1000), src("PXK-NVL-Q7-QA-002", today, 250)] },
        { kitchen_inventory_item_id: ttItem.id, location: "tan_tao", committed_qty: 3, unit: ttItem.unit, next_date: today, sources: [src("PXK-NVL-Q7-QA-003", today, 3)] },
      ],
      skus: mode === "empty" ? [] : [
        { location: "tan_tao", sku_id: "s-bmq2", sku_code: "BMQ-002", name: "Bánh mì que đông lạnh", unit: "que", on_hand: 194, incoming_qty: 0, committed_qty: 120, overdue_qty: 0, available: 74, orders: 3, next_date: today },
        { location: "q7", sku_id: "fg-cbc", sku_code: "cbc-2026-v2", name: "BÁNH MÌ CHÀ BÔNG CAY", unit: "gói", on_hand: 12, incoming_qty: 170, committed_qty: 170, overdue_qty: 0, available: 12, orders: 1, next_date: today },
      ],
      gaps: mode === "empty" ? { pxk_lines_unposted: 0, pxk_unposted_issues: [] } : { pxk_lines_unposted: 7, pxk_unposted_issues: ["PXK-NVL-Q7-QA-009", "PXK-NVL-Q7-QA-010"] } }, error: null };
  }
  if (st.table === "rpc:get_stock_transfers") return { data: (window.__kgFixture.transfers ?? []).map((t, i) => ({ ...t, source: i % 2 ? "manual" : "auto", slip_id: null, slip_number: i % 2 ? "PCK-QA-" + i : null, note: i === 1 ? "hàng cho ca sáng Q7" : null })), error: null };
  if (st.table === "rpc:get_q7_finished_goods_planned") return { data: [{ sku_id: "fg-cbc", product_name: "BÁNH MÌ CHÀ BÔNG CAY", unit: "gói", planned_qty: 40, already_received: 12, production_order_item_id: "poi-qa-1" }], error: null };
  if (st.table === "rpc:kho_set_item_note") return { data: { item_id: st.args.p_item_id, note: st.args.p_note }, error: null };
  // Order by email (owner 23/10): every item has TV Food as order supplier in this fixture.
  // The card's gate is a definer RPC (the settings table's RLS function is not executable by signed-in users).
  if (st.table === "q7_purchase_item_settings") return { data: null, error: { code: "42501", message: "permission denied for function q7_material_inventory_can_view" } };
  if (st.table === "rpc:supplier_order_setting") return { data: { supplier_id: "sup-tv", supplier_name: "TV Food", po_unit: "kg" }, error: null };
  if (st.table === "rpc:prepare_supplier_order") return { data: {
    item: { id: st.args.p_item_id, name: "Bơ Peerless Úc 25kg", unit: "g" },
    supplier: { id: "sup-tv", name: "TV Food", email: "dathang@tvfood.example" },
    stock: cfg().orderOut
      ? { on_hand: "-17660.24", daily_usage: "18581.266", days_left: "-1", last_count_date: "2026-10-16", reorder_date: "2026-10-22" }
      : { on_hand: "105812.654", daily_usage: "8870.791", days_left: "11.9", last_count_date: "2026-10-16", reorder_date: "2026-10-30" },
    proposal: { quantity: "75", unit: "kg", unit_price: "90000", line_total: "6750000", product_name: "BƠ PEERLESS", pack_size_po_units: "25", suggested_book_qty: "75000" },
    open_order: null,
    delivery: { address: "24 Đường số 36, P. Tân Quy, Q7, TP.HCM", contact_name: "Phương Nhi", contact_phone: "0903 051 971", note: "" },
    blockers: cfg().orderBlocked ? ["mailbox_not_connected"] : [],
  }, error: null };
  if (st.table === "rpc:supplier_order_history") return { data: { items: JSON.parse(localStorage.getItem("qa-orders") || "[]") }, error: null };
  if (st.table === "rpc:kho_create_item") {
    const a = st.args;
    return { data: { status: "created", item_id: "qa-created-" + a.p_request_id, item_code: "NVL-999", name: a.p_name, unit: a.p_unit, in_tan_tao: a.p_tan_tao, in_q7: a.p_q7, copied_from: a.p_copy_from }, error: null };
  }
  if (/^rpc:/.test(st.table)) return { data: null, error: null };
  return { data: [], error: null, count: 0 };
}
function builder(table, args) {
  const st = { table, args: args || {} };
  const proxy = new Proxy(function () {}, {
    get(_t, prop) {
      // data "loading": the catalog/count lists never arrive, so the loading state stays on screen.
      if (prop === "then" && cfg().data === "loading" && st.table === "rpc:kho_get_items") return () => new Promise(() => {});
      if (prop === "then") return (ok, ko) => Promise.resolve().then(() => settle(st)).then(ok, ko);
      if (prop === "catch") return (ko) => Promise.resolve(settle(st)).catch(ko);
      if (prop === "finally") return (fn) => Promise.resolve(settle(st)).finally(fn);
      return () => proxy;
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
  functions: { invoke: async (name, options) => {
    window.__qaCalls.push("invoke:" + name + ":" + JSON.stringify(options?.body ?? {}));
    if (name === "supplier-order-send") {
      const b = options.body;
      const row = { id: "o1", request_id: b.request_id, po_number: "PO-000861", quantity: b.quantity, unit: "kg", total: b.quantity * 90000, status: "sent", sent_at: new Date().toISOString(), to_email: "dathang@tvfood.example",
        uploads: [{ file_name: "phieu-giao-hang-TV-Food.jpg", mime_type: "image/jpeg", size_bytes: 120000, created_at: new Date().toISOString(), storage_path: "o1/a.jpg" }] };
      localStorage.setItem("qa-orders", JSON.stringify([row]));
      return { data: { status: "sent", po_number: "PO-000861", to_email: "dathang@tvfood.example", sent_at: row.sent_at }, error: null };
    }
    return { data: null, error: { message: "QA fixture: functions disabled" } };
  } },
  storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "" } }), createSignedUrl: async () => ({ data: { signedUrl: "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="840"><rect width="600" height="840" fill="#fff"/><text x="40" y="80" font-size="40">PHIẾU GIAO HÀNG</text></svg>') }, error: null }), list: async () => ({ data: [], error: null }) }) },
  auth: {
    getSession: async () => ({ data: { session: { access_token: "qa", user } }, error: null }),
    getUser: async () => ({ data: { user }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    refreshSession: async () => ({ data: { session: { access_token: "qa", user } }, error: null }),
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
const user = { id: "qa-user", email: "qa@bmq.test", user_metadata: { full_name: "Tâm Vũ" } };
const value = {
  user, session: { access_token: "qa", user }, profile: { id: "qa-profile", user_id: "qa-user", full_name: "Tâm Vũ", email: user.email },
  loading: false, timedOut: false, roles: role === "owner" ? ["owner"] : ["staff"], authzLoaded: true, authzError: false,
  isOwner: role === "owner", canAccessModule: () => true, canEditModule: () => role === "owner",
  signOut: async () => {}, refreshProfile: async () => {}, refreshRoles: async () => {},
};
const Ctx = createContext(value);
export function AuthProvider({ children }) { return React.createElement(Ctx.Provider, { value }, children); }
export function useAuth() { return useContext(Ctx); }
`;

const fixtures = {
  name: "qa-kho-app-fixtures",
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

// The supplier upload page calls the functions URL directly (no Supabase client); route it in the browser.
process.env.VITE_SUPABASE_URL ||= "https://qa-supabase.invalid";
process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||= "qa-anon";
const server = await createServer({
  root: ROOT, configFile: false, logLevel: "error",
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-kho-app-qa/vite-cache",
  server: { port: PORT, strictPort: true, host: "127.0.0.1" },
  define: { __APP_VERSION__: JSON.stringify("qa"), __APP_SEMVER__: JSON.stringify("vqa") },
  resolve: { alias: { "@": path.join(ROOT, "src") } },
  plugins: [fixtures, react()],
});
await server.listen();
const BASE = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({ executablePath: CHROME });
const KG_FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/qa_warehouse_game.fixture.json"), "utf8"));
const results = [];
const pass = (name) => { results.push(name); console.log("PASS", name); };

async function open(cfg, route, viewport, ready = "[data-bmq-kho-catalog], [data-bmq-kho-count-page], [data-bmq-warehouse-slips]") {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce", locale: "vi-VN" });
  await context.addInitScript((fixture) => { window.__kgFixture = fixture; }, KG_FIXTURE);
  await context.addInitScript((value) => { if (!sessionStorage.getItem("qa-init")) { localStorage.clear(); sessionStorage.setItem("qa-init", "1"); } localStorage.setItem("qa-shell", JSON.stringify(value)); }, cfg);
  await context.route("**/*", (r) => {
    const url = r.request().url();
    if (url.startsWith(BASE) || url.startsWith("data:") || url.startsWith("blob:")) return r.continue();
    return r.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + route, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-bmq-shell='demo3-v1']", { timeout: 30000 });
  await page.waitForSelector(ready, { timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  return { context, page, errors };
}
const calls = (page) => page.evaluate(() => window.__qaCalls);
async function noSpill(page, label, vp) {
  const o = await page.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll(".d3-kho *, [role='dialog'] *")) {
      const r = el.getBoundingClientRect();
      if (!r.width || getComputedStyle(el).position === "fixed") continue;
      if (el.closest(".d3-kho-tabs, .d3-kho-notes-row, .d3-kho-viewer-stage, .d3-kho-viewer-photos")) continue;
      if (r.right > window.innerWidth + 1 || r.left < -1) bad.push(`${el.tagName}.${String(el.className).slice(0, 60)}`);
    }
    return { doc: document.documentElement.scrollWidth - window.innerWidth, bad: bad.slice(0, 5) };
  });
  assert.ok(o.doc <= 0 && o.bad.length === 0, `${label} ${vp.width}: overflow ${JSON.stringify(o)}`);
}
async function shot(page, file, full = true) {
  if (full) await page.addStyleTag({ content: ".d3-app{height:auto!important}.d3-main{overflow:visible!important}" });
  await page.waitForTimeout(120);
  await page.screenshot({ path: `${EVIDENCE}/${file}`, fullPage: full });
}
async function dialogInView(page, selector, vp) {
  await page.waitForSelector(selector, { timeout: 5000 });
  await page.waitForTimeout(450);
  const box = await page.locator(selector).boundingBox();
  assert.ok(box && box.y >= -1 && box.x >= -1 && box.x + box.width <= vp.width + 1 && box.y + box.height <= vp.height + 1, `${selector} outside the viewport at ${vp.width}: ${JSON.stringify(box)}`);
}
async function confirmOk(page) {
  await page.waitForSelector("[data-bmq-kho-confirm]", { timeout: 4000 });
  await page.locator("[data-bmq-kho-confirm-ok]").click();
  await page.waitForSelector("[data-bmq-kho-confirm]", { state: "detached", timeout: 3000 });
}
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{FE0F}]/u;
async function themeFacts(page) {
  return page.evaluate(() => {
    const h1 = document.querySelector(".d3-screen h1");
    return {
      h1: h1?.textContent?.trim() ?? null,
      h1Font: h1 ? getComputedStyle(h1).fontFamily : "",
      gameFont: Boolean(document.getElementById("kg-fonts")),
      gameNodes: document.querySelectorAll(".kg, .k2, [data-bmq-warehouse-game], canvas").length,
      text: document.querySelector(".d3-screen")?.innerText ?? "",
    };
  });
}
async function assertTheme(page, title, vp) {
  const f = await themeFacts(page);
  assert.equal(f.h1, title, `h1 ${vp.width}`);
  assert.match(f.h1Font, /Be Vietnam Pro/, "app font on the title");
  assert.equal(f.gameFont, false, "no game font loaded");
  assert.equal(f.gameNodes, 0, "no game markup");
  assert.ok(!EMOJI.test(f.text), `no emoji on ${title}: ${(f.text.match(EMOJI) || [])[0]}`);
  assert.ok(!/Game kho|Sushi|⭐/.test(f.text), `no game words on ${title}`);
}

const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }];
try {
  for (const vp of VIEWPORTS) {
    // ---------- Danh mục kho ----------
    let { context, page, errors } = await open({ role: "owner" }, "/warehouse/danh-muc", vp);
    await page.waitForSelector("[data-bmq-kho-names] li");
    await assertTheme(page, "Danh mục kho", vp);
    assert.deepEqual((await page.locator("[data-bmq-kho-group]").allTextContents()).map((t) => t.replace(/\d+$/, "")), ["Nguyên liệu", "Bao bì & vật tư", "Thành phẩm"]);
    assert.equal(await page.locator("[data-bmq-kho-loc='tan_tao']").getAttribute("aria-selected"), "true", "opens on Kho Tân Tạo");
    assert.equal(await page.locator("[data-bmq-kho-group='nl']").getAttribute("aria-selected"), "true", "opens on Nguyên liệu");
    const expectNames = (kho, classes) => page.evaluate(({ kho, classes }) => window.__kgFixture.items
      .filter((it, i) => i % 17 !== 5 && Boolean(it.pastry_q7) === (kho === "q7") && classes.includes(it.item_class))
      .map((it) => it.name).sort(), { kho, classes });
    const shown = async () => (await page.locator("[data-bmq-kho-names] li .d3-kho-row-main b").allTextContents()).sort();
    assert.deepEqual(await shown(), await expectNames("tan_tao", ["raw_material", "unclassified"]), "Tân Tạo · Nguyên liệu");
    assert.ok(await page.locator("[data-bmq-kho-new]").isVisible(), "new-names notice");
    await noSpill(page, "catalog", vp);
    await shot(page, `catalog-${vp.width}.png`);
    await context.close();

    // ---------- Thêm món / Sao chép món (owner 27/10) ----------
    ({ context, page, errors } = await open({ role: "owner" }, "/warehouse/danh-muc", vp));
    await page.waitForSelector("[data-bmq-kho-names] li");
    await page.locator("[data-bmq-kho-create-open]").click();
    await dialogInView(page, "[data-bmq-kho-create-dialog='new']", vp);
    await page.locator("[data-bmq-kho-create-name]").fill("Bơ Peerless 2.5 kg");
    await noSpill(page, "create dialog", vp);
    await page.locator("[data-bmq-kho-create-dialog]").screenshot({ path: `${EVIDENCE}/create-new-${vp.width}.png` });
    await page.locator("[data-bmq-kho-create-save]").click();
    await page.waitForSelector("[data-bmq-kho-create-dialog]", { state: "detached", timeout: 4000 });
    let made = (await calls(page)).filter((c) => c.startsWith("rpc:kho_create_item:")).map((c) => JSON.parse(c.slice("rpc:kho_create_item:".length)));
    assert.equal(made.length, 1, "one create call");
    assert.equal(made[0].p_name, "Bơ Peerless 2.5 kg");
    assert.equal(made[0].p_copy_from, null, "new item is not a copy");
    assert.deepEqual([made[0].p_tan_tao, made[0].p_q7, made[0].p_class], [true, false, "raw_material"], "defaults follow the open kho and group");
    assert.match(made[0].p_request_id, /^[0-9a-f-]{36}$/, "request id");
    const srcId = await page.locator("[data-bmq-kho-names] li [data-bmq-kho-item]").first().getAttribute("data-bmq-kho-item");
    const srcName = (await page.locator("[data-bmq-kho-names] li .d3-kho-row-main b").first().textContent()).trim();
    await page.locator(`[data-bmq-kho-item='${srcId}']`).click();
    await dialogInView(page, "[data-bmq-kho-item-dialog]", vp);
    await page.locator("[data-bmq-kho-copy]").click();
    await dialogInView(page, "[data-bmq-kho-create-dialog='copy']", vp);
    assert.equal(await page.locator("[data-bmq-kho-create-name]").inputValue(), `${srcName} (bản sao)`, "copy prefills the name");
    assert.equal(await page.locator("[data-bmq-kho-create-unit]").isDisabled(), true, "copy keeps the unit");
    await page.locator("[data-bmq-kho-create-name]").fill(srcName.toUpperCase());
    assert.ok(await page.locator("[data-bmq-kho-create-twin]").isVisible(), "same name warns");
    assert.equal(await page.locator("[data-bmq-kho-create-save]").isDisabled(), true, "same name cannot be saved");
    await page.locator("[data-bmq-kho-create-name]").fill(`${srcName} khối nhỏ`);
    await noSpill(page, "copy dialog", vp);
    await page.locator("[data-bmq-kho-create-dialog]").screenshot({ path: `${EVIDENCE}/create-copy-${vp.width}.png` });
    await page.locator("[data-bmq-kho-create-save]").click();
    await page.waitForSelector("[data-bmq-kho-create-dialog]", { state: "detached", timeout: 4000 });
    made = (await calls(page)).filter((c) => c.startsWith("rpc:kho_create_item:")).map((c) => JSON.parse(c.slice("rpc:kho_create_item:".length)));
    assert.equal(made.length, 2, "copy creates once");
    assert.equal(made[1].p_copy_from, srcId, "copy sends its source");
    assert.notEqual(made[1].p_request_id, made[0].p_request_id, "each form has its own request id");
    assert.deepEqual(errors, [], `create/copy page errors @${vp.width}`);
    pass(`Thêm món + Sao chép món: form, twin guard, RPC args ${vp.width}`);
    await context.close();

    ({ context, page, errors } = await open({ role: "owner" }, "/warehouse/danh-muc", vp));
    await page.waitForSelector("[data-bmq-kho-names] li");
    await page.locator("[data-bmq-kho-group='bb']").click();
    assert.deepEqual(await shown(), await expectNames("tan_tao", ["packaging_supply", "non_stock"]), "Tân Tạo · Bao bì");
    await page.locator("[data-bmq-kho-group='tp']").click();
    await page.waitForSelector("[data-bmq-kho-fg]");
    assert.deepEqual(await page.locator("[data-bmq-kho-fg] .d3-kho-row-main b").allTextContents(), ["Bánh mì que đông lạnh", "Pate 200g", "Pate 500g"]);
    assert.match(await page.locator("[data-bmq-kho-fg='BMQ-002'] .d3-kho-row-qty").textContent(), /194 que/);
    await noSpill(page, "catalog-tp", vp);
    await page.locator("[data-bmq-kho-loc='q7']").click();
    await page.waitForSelector("[data-bmq-kho-fg='cbc-2026-v2']");
    assert.match(await page.locator("[data-bmq-kho-fg='cbc-2026-v2']").textContent(), /BÁNH MÌ CHÀ BÔNG CAY.*12 gói/);
    assert.equal(await page.locator("[data-bmq-kho-fg='BMQ-002']").count(), 0, "Tân Tạo finished goods not at Q7");
    await page.locator("[data-bmq-kho-group='nl']").click();
    assert.deepEqual(await shown(), await expectNames("q7", ["raw_material", "unclassified"]), "Q7 · Nguyên liệu");
    await page.locator("[data-bmq-kho-group='bb']").click();
    assert.deepEqual(await shown(), await expectNames("q7", ["packaging_supply", "non_stock"]), "Q7 · Bao bì");
    await shot(page, `catalog-q7-bb-${vp.width}.png`, false);
    pass(`Danh mục kho: Tân Tạo / Q7 × Nguyên liệu / Bao bì & vật tư / Thành phẩm ${vp.width}`);

    // "Có ở kho": tick Kho Tân Tạo on a Q7 item (owner 22/10: an item can be at both kho), then untick Q7
    const q7Id = await page.locator("[data-bmq-kho-names] li .d3-kho-row-main").first().getAttribute("data-bmq-kho-item");
    await page.locator(`[data-bmq-kho-item='${q7Id}']`).click();
    await dialogInView(page, "[data-bmq-kho-item-dialog]", vp);
    assert.ok((await page.locator("[data-bmq-kho-code-detail]").innerText()).trim().length > 0, "item code shown");
    await page.locator("[data-bmq-kho-note-input]").fill("Kiểm tra QA ghi chú");
    await page.locator("[data-bmq-kho-note-save]").click();
    await page.waitForFunction(() => window.__qaCalls.some((c) => c.startsWith("rpc:kho_set_item_note:")));
    assert.ok((await calls(page)).some((c) => c.startsWith("rpc:kho_set_item_note:") && c.includes(q7Id) && c.includes("Kiểm tra QA ghi chú")), "note saved");
    await noSpill(page, "item-note", vp);
    const tick = (loc) => page.locator(`[data-bmq-kho-place-pick='${loc}']`);
    assert.equal(await tick("q7").getAttribute("aria-checked"), "true");
    assert.equal(await tick("tan_tao").getAttribute("aria-checked"), "false");
    assert.equal(await tick("q7").isDisabled(), true, "the only kho cannot be unticked");
    await tick("tan_tao").click();
    await page.waitForFunction(() => document.querySelector("[data-bmq-kho-place-pick='tan_tao']")?.getAttribute("aria-checked") === "true");
    assert.ok((await calls(page)).some((c) => c.startsWith("rpc:set_item_kho_locations:") && c.includes(q7Id) && c.includes('"p_tan_tao":true') && c.includes('"p_q7":true')), "both-kho call");
    assert.equal(await tick("q7").isDisabled(), false, "with two kho either can be unticked");
    assert.match(await page.locator("[data-bmq-kho-item-dialog] .d3-kho-dialog-head").innerText(), /Kho Tân Tạo \+ Kho Q7/);
    await noSpill(page, "kho-ticks", vp);
    await shot(page, `item-kho-ticks-${vp.width}.png`, false);
    await tick("q7").click();
    const q7Qty = await page.evaluate((id) => { const F = window.__kgFixture; const i = F.items.findIndex((it) => it.id === id); return i % 17 === 5 ? 0 : (i * 977) % 200000 - (i % 4 === 0 ? 3000 : 0); }, q7Id);
    if (q7Qty !== 0) await confirmOk(page);
    await page.waitForFunction(() => document.querySelector("[data-bmq-kho-place-pick='q7']")?.getAttribute("aria-checked") === "false");
    assert.ok((await calls(page)).some((c) => c.startsWith("rpc:set_item_kho_locations:") && c.includes('"p_tan_tao":true') && c.includes('"p_q7":false')), "Tân Tạo-only call");
    assert.equal(await tick("tan_tao").isDisabled(), true, "last kho locked again");
    pass(`kho ticks: add Tân Tạo, then drop Q7 with a confirm ${vp.width}`);
    await context.close();

    // Item dialog: group move, after scrolling deep into the list
    ({ context, page, errors } = await open({ role: "owner" }, "/warehouse/danh-muc", vp));
    await page.waitForSelector("[data-bmq-kho-names] li");
    const moveId = await page.evaluate(() => window.__kgFixture.items[0].id);
    const lastRow = page.locator("[data-bmq-kho-names] li .d3-kho-row-main").last();
    await lastRow.scrollIntoViewIfNeeded();
    await lastRow.click();
    await dialogInView(page, "[data-bmq-kho-item-dialog]", vp);
    await shot(page, `item-dialog-scrolled-${vp.width}.png`, false);
    await page.keyboard.press("Escape");
    await page.waitForSelector("[data-bmq-kho-item-dialog]", { state: "detached" });
    await page.locator(`[data-bmq-kho-item='${moveId}']`).click();
    await dialogInView(page, "[data-bmq-kho-item-dialog]", vp);
    assert.equal(await page.locator("[data-bmq-kho-class-pick='nl']").getAttribute("aria-pressed"), "true");
    await noSpill(page, "item-dialog", vp);
    await shot(page, `item-dialog-${vp.width}.png`, false);
    await page.locator("[data-bmq-kho-class-pick='bb']").click();
    await page.waitForSelector("[data-bmq-kho-item-dialog]", { state: "detached", timeout: 4000 });
    assert.ok((await calls(page)).some((c) => c.startsWith("rpc:set_stock_item_class:") && c.includes(moveId) && c.includes('"p_class":"packaging_supply"')), "class call");
    pass(`item dialog in view after scrolling + move to Bao bì & vật tư ${vp.width}`);
    await context.close();

    // Rename onto an existing name -> confirm -> merge
    ({ context, page, errors } = await open({ role: "owner" }, "/warehouse/danh-muc", vp));
    await page.waitForSelector("[data-bmq-kho-names] li");
    await page.locator("[data-bmq-kho-search]").fill("bang keo");
    const filtered = await page.locator("[data-bmq-kho-names] li").count();
    assert.ok(filtered >= 1 && filtered < 30, `search filters (${filtered})`);
    await page.locator("[data-bmq-kho-search]").fill("");
    await page.locator("[data-bmq-kho-names] li .d3-kho-row-main").first().click();
    await page.waitForSelector("[data-bmq-kho-name]");
    const other = await page.evaluate(() => window.__kgFixture.items.find((it) => /băng keo nhỏ/i.test(it.name))?.name);
    await page.locator("[data-bmq-kho-name]").fill(other);
    await page.waitForSelector("[data-bmq-kho-twin]");
    await page.locator("[data-bmq-kho-save]").click();
    await page.waitForSelector("[data-bmq-kho-confirm]");
    await page.waitForTimeout(300);
    await shot(page, `merge-confirm-${vp.width}.png`, false);
    await confirmOk(page);
    await page.waitForTimeout(300);
    assert.ok((await calls(page)).some((c) => c.startsWith("rpc:kho_save_item:") && c.includes('"p_merge":true')), "merge call after confirm");
    pass(`search + rename to an existing name asks once then merges ${vp.width}`);
    await context.close();

    // Unit and on/off live in the item's detail (owner 22/10), not on the list.
    ({ context, page, errors } = await open({ role: "owner" }, "/warehouse/danh-muc", vp));
    await page.waitForSelector("[data-bmq-kho-names] li");
    assert.equal(await page.locator("[data-bmq-kho-names] [role='switch'], [data-bmq-kho-unit-edit]").count(), 0, "no switch or pencil on the list");
    const gItem = await page.evaluate(() => window.__kgFixture.items[0].id);
    await page.locator(`[data-bmq-kho-item='${gItem}']`).click();
    await dialogInView(page, "[data-bmq-kho-item-dialog]", vp);
    // 1 bao = 25000 g -> old->new factor 1/25000. The unit row opens the chip picker (owner 22/10 settings card).
    assert.equal(await page.locator("[data-bmq-unit-chip]").count(), 0, "unit chips stay folded until the row is tapped");
    await page.locator("[data-bmq-unit-open]").click();
    await page.locator("[data-bmq-unit-chip='bao']").click();
    assert.equal(await page.locator("[data-bmq-unit-open]").getAttribute("aria-expanded"), "false", "picker closes after a pick");
    await page.waitForSelector("[data-bmq-unit-change='bao']");
    await page.locator("[data-bmq-unit-change] [data-bmq-unit-factor]").fill("25000");
    await shot(page, `unit-ask-${vp.width}.png`, false);
    await page.locator("[data-bmq-unit-save]").click();
    await page.waitForTimeout(400);
    const unitCall = (await calls(page)).filter((c) => c.startsWith("rpc:kho_save_item:")).pop();
    assert.ok(unitCall.includes('"p_unit":"bao"') && unitCall.includes('"p_unit_factor":0.00004'), unitCall);
    pass(`unit change in the detail: 1 bao = 25000 g sends the old->new factor ${vp.width}`);
    // Turning off in the detail asks first, then saves
    await page.locator("[data-bmq-kho-item-dialog] [aria-label='Bật/tắt món']").click();
    await page.locator("[data-bmq-kho-save]").click();
    await confirmOk(page);
    await page.waitForTimeout(300);
    assert.ok((await calls(page)).some((c) => c.startsWith("rpc:kho_save_item:") && c.includes(gItem) && c.includes('"p_active":false')), "off call");
    pass(`switch off in the detail asks then saves ${vp.width}`);
    assert.deepEqual(errors, [], `page errors catalog ${vp.width}`);
    await context.close();

    // ---------- Đơn vị & quy đổi (owner 22/10) ----------
    ({ context, page, errors } = await open({ role: "owner" }, "/warehouse/danh-muc", vp));
    await page.waitForSelector("[data-bmq-kho-names] li");
    const unitTarget = await page.evaluate(() => {
      const F = window.__kgFixture;
      const i = F.items.findIndex((it, idx) => idx % 3 !== 0 && idx % 17 !== 5 && !it.pastry_q7 && ["raw_material", "unclassified"].includes(it.item_class));
      return { id: F.items[i].id, unit: F.items[i].unit };
    });
    await page.locator(`[data-bmq-kho-item='${unitTarget.id}']`).click();
    await dialogInView(page, "[data-bmq-kho-item-dialog]", vp);
    await page.waitForSelector("[data-bmq-conversion='cây']");
    await page.locator(".d3-kho-unitset").screenshot({ path: path.join(EVIDENCE, `unit-card-${vp.width}.png`) });
    await page.locator("[data-bmq-unit-open]").click();
    await page.waitForSelector("[data-bmq-unit-chips]");
    await page.waitForTimeout(350);
    await page.locator(".d3-kho-unitset").screenshot({ path: path.join(EVIDENCE, `unit-card-open-${vp.width}.png`) });
    assert.ok(await page.locator(`[data-bmq-unit-chip='${unitTarget.unit}']`).evaluate((el) => el.classList.contains("is-current")), "current unit outlined");
    assert.ok(await page.locator("[data-bmq-conversion-disagree]").isVisible(), "disagreeing factors flagged");
    await noSpill(page, "unit-dialog", vp);
    await shot(page, `unit-dialog-${vp.width}.png`, false);
    // + Đơn vị mới -> khay, then change the unit with a factor
    await page.locator("[data-bmq-unit-new]").click();
    await page.locator("[data-bmq-unit-new-field] input").fill("Khay");
    await page.locator("[data-bmq-unit-new-save]").click();
    await page.waitForSelector("[data-bmq-unit-change='khay']");
    assert.ok((await calls(page)).some((c) => c.startsWith("rpc:kho_add_stock_unit:") && c.includes('"p_label":"Khay"')), "add unit call");
    await page.locator("[data-bmq-unit-change] [data-bmq-unit-factor]").fill("12");
    await page.waitForSelector("[data-bmq-unit-after]");
    await page.waitForTimeout(350);
    await shot(page, `unit-change-${vp.width}.png`, false);
    await page.locator("[data-bmq-unit-save]").click();
    await page.waitForTimeout(400);
    const unitSave = (await calls(page)).filter((c) => c.startsWith("rpc:kho_save_item:")).pop();
    // g -> khay reads "1 khay = 12 g", so 1 g = 1/12 khay is sent as the old->new factor.
    assert.ok(unitSave && unitSave.includes('"p_unit":"khay"') && unitSave.includes('"p_unit_factor":0.08333'), unitSave);
    pass(`unit dialog: new unit + change with factor ${vp.width}`);
    // Fix the disagreeing conversion: 1 cây = 6 <unit>, preview then save
    await page.locator("[data-bmq-conversion='cây'] [data-bmq-conversion-edit]").click();
    await page.locator("[data-bmq-conversion='cây'] [data-bmq-unit-factor]").fill("6");
    await page.waitForSelector("[data-bmq-conversion='cây'] [data-bmq-unit-impact='change']", { timeout: 5000 });
    assert.match(await page.locator("[data-bmq-conversion='cây'] [data-bmq-unit-impact]").innerText(), /Tồn sẽ đổi: Kho Tân Tạo \+50/);
    await page.waitForSelector("[data-bmq-conversion='cây'] [data-bmq-receipt-notes]");
    await page.waitForTimeout(300);
    await noSpill(page, "conversion-edit", vp);
    await shot(page, `conversion-edit-${vp.width}.png`, false);
    await page.locator("[data-bmq-conversion-save]").click();
    await page.waitForTimeout(400);
    const convCalls = (await calls(page)).filter((c) => c.startsWith("rpc:kho_set_item_conversion:"));
    assert.ok(convCalls.some((c) => c.includes('"p_dry_run":true') && c.includes('"p_factor":6')), "preview call");
    assert.ok(convCalls.some((c) => c.includes('"p_dry_run":false') && c.includes('"p_factor":6') && c.includes('"p_unit":"cây"') && /"p_request_id":"[0-9a-f-]{36}"/.test(c)), "save call");
    pass(`conversion: preview stock impact, then save with a request id ${vp.width}`);
    // + Thêm quy đổi: 1 bao = 25 <unit>
    await page.locator("[data-bmq-conversion-add]").click();
    await page.locator("[data-bmq-conversion-new] [data-bmq-picker]").click();
    await page.locator("[data-bmq-picker-sheet] [data-bmq-picker-option='bao']").click();
    await page.waitForSelector("[data-bmq-picker-sheet]", { state: "detached" });
    await page.locator("[data-bmq-conversion-new] [data-bmq-unit-factor]").fill("25");
    await shot(page, `conversion-add-${vp.width}.png`, false);
    await page.locator("[data-bmq-conversion-add-save]").click();
    await page.waitForTimeout(400);
    assert.ok((await calls(page)).some((c) => c.startsWith("rpc:kho_set_item_conversion:") && c.includes('"p_unit":"bao"') && c.includes('"p_factor":25') && c.includes('"p_dry_run":false')), "add conversion call");
    pass(`add a conversion for a new delivery-note unit ${vp.width}`);
    assert.deepEqual(errors, [], `page errors unit dialog ${vp.width}`);
    await context.close();
    // Kiểm kê: the item name opens the same detail
    ({ context, page, errors } = await open({ role: "owner" }, "/warehouse/kiem-ke", vp));
    await page.waitForSelector("[data-bmq-kho-count='tan_tao'] li [data-bmq-kho-count-open]");
    assert.equal(await page.locator("[data-bmq-kho-unit-edit]").count(), 0, "no pencil on the count list");
    await page.locator("[data-bmq-kho-count='tan_tao'] li [data-bmq-kho-count-open]").first().click();
    await dialogInView(page, "[data-bmq-kho-item-dialog]", vp);
    await page.waitForSelector("[data-bmq-kho-item-dialog] [data-bmq-unit-open]");
    await shot(page, `count-item-dialog-${vp.width}.png`, false);
    pass(`Kiểm kê name opens the item detail with unit + conversions ${vp.width}`);
    await context.close();


    // ---------- Đã đặt / Giữ cho sản xuất (owner 22/10) ----------
    ({ context, page, errors } = await open({ role: "owner" }, "/warehouse/danh-muc", vp));
    await page.waitForSelector("[data-bmq-kho-names] li");
    await page.locator("[data-bmq-kho-group='tp']").click();
    await page.waitForSelector("[data-bmq-kho-fg='BMQ-002'] [data-bmq-kho-fg-held]");
    assert.match(await page.locator("[data-bmq-kho-fg='BMQ-002'] [data-bmq-kho-fg-held]").innerText(), /Đã đặt 120 que · 3 đơn · hôm nay/);
    if (vp.width > 420) assert.match(await page.locator("[data-bmq-kho-fg='BMQ-002'] [data-bmq-kho-fg-available]").innerText(), /còn bán 74 que/);
    await shot(page, `commit-fg-${vp.width}.png`, false);
    await page.locator("[data-bmq-kho-loc='q7']").click();
    await page.locator("[data-bmq-kho-group='nl']").click();
    await page.waitForSelector("[data-bmq-kho-held]");
    assert.ok(await page.locator("[data-bmq-kho-pxk-gap]").isVisible(), "unposted PXK lines are named");
    await noSpill(page, "commit-q7", vp);
    await shot(page, `commit-q7-${vp.width}.png`, false);
    await page.locator("[data-bmq-kho-names] li").filter({ has: page.locator("[data-bmq-kho-held]") }).first().locator(".d3-kho-row-main").click();
    await page.waitForSelector("[data-bmq-kho-hold-detail]");
    assert.match(await page.locator("[data-bmq-kho-hold-detail]").innerText(), /PXK-NVL-Q7-QA-001/);
    await shot(page, `commit-detail-${vp.width}.png`, false);
    pass(`Đã đặt / Giữ cho sản xuất on Danh mục kho + detail ${vp.width}`);
    assert.deepEqual(errors, [], `page errors commitments ${vp.width}`);
    await context.close();

    // ---------- Tên mới trên phiếu ----------
    ({ context, page, errors } = await open({ role: "owner" }, "/warehouse/danh-muc", vp));
    await page.locator("[data-bmq-kho-new-open]").click();
    await page.waitForSelector("[data-bmq-kho-newlines] li");
    assert.equal(new URL(page.url()).searchParams.get("view"), "moi");
    await assertTheme(page, "Tên mới trên phiếu", vp);
    await noSpill(page, "newnames", vp);
    await shot(page, `newnames-${vp.width}.png`);
    await page.locator("[data-bmq-kho-newlines] li .d3-kho-row-main").first().click();
    await dialogInView(page, "[data-bmq-crate-dialog]", vp);
    await page.waitForSelector("[data-bmq-receipt-notes] [data-bmq-note]");
    await noSpill(page, "crate-dialog", vp);
    await shot(page, `crate-dialog-${vp.width}.png`, false);
    await page.locator("[data-bmq-receipt-notes] [data-bmq-note]").first().click();
    await page.waitForSelector("[data-bmq-note-viewer]");
    await page.waitForTimeout(300);
    await shot(page, `note-viewer-${vp.width}.png`, false);
    await page.keyboard.press("Escape");
    await page.waitForSelector("[data-bmq-note-viewer]", { state: "detached" });
    assert.ok(await page.locator("[data-bmq-crate-dialog]").isVisible(), "crate dialog stays after closing the photo");
    await page.locator("[data-bmq-kho-back]").count();
    pass(`new names list + pick-a-name dialog + delivery-note viewer ${vp.width}`);
    // Sửa tên (owner 27/10): a name with no match offers "Sửa tên"; the form opens with the OCR name selected.
    await page.keyboard.press("Escape");
    await page.waitForSelector("[data-bmq-crate-dialog]", { state: "detached" });
    const crateRows = page.locator("[data-bmq-kho-newlines] li .d3-kho-row-main");
    let renameFound = false;
    for (let i = 0; i < Math.min(await crateRows.count(), 12) && !renameFound; i++) {
      await crateRows.nth(i).click();
      await page.waitForSelector("[data-bmq-crate-dialog]");
      if (await page.locator("[data-bmq-crate-rename]").count()) { renameFound = true; break; }
      await page.keyboard.press("Escape");
      await page.waitForSelector("[data-bmq-crate-dialog]", { state: "detached" });
    }
    assert.ok(renameFound, "a crate without a match shows Sửa tên");
    await noSpill(page, "crate-nohint", vp);
    await page.locator("[data-bmq-crate-nohint]").screenshot({ path: `${EVIDENCE}/crate-rename-${vp.width}.png` });
    await page.locator("[data-bmq-crate-rename]").click();
    await page.waitForSelector("[data-bmq-new-name]");
    await page.waitForTimeout(150);
    const sel = await page.evaluate(() => {
      const el = document.activeElement;
      return el?.hasAttribute("data-bmq-new-name") ? { all: el.selectionStart === 0 && el.selectionEnd === el.value.length, len: el.value.length } : null;
    });
    assert.ok(sel && sel.len > 0 && sel.all, `name input focused with the whole name selected: ${JSON.stringify(sel)}`);
    await page.keyboard.type("Cắt băng keo N.2002 sửa");
    assert.equal(await page.locator("[data-bmq-new-name]").inputValue(), "Cắt băng keo N.2002 sửa", "typing replaces the OCR name");
    pass(`Sửa tên gợi ý: focus + select + type over ${vp.width}`);
    assert.deepEqual(errors, [], `page errors newnames ${vp.width}`);
    await context.close();

    // ---------- Kiểm kê ----------
    ({ context, page, errors } = await open({ role: "owner" }, "/warehouse/kiem-ke", vp));
    await page.waitForSelector("[data-bmq-kho-count='tan_tao'] li");
    await assertTheme(page, "Kiểm kê", vp);
    assert.ok(await page.locator("[data-bmq-kho-progress] [role='progressbar']").isVisible(), "progress meter");
    await noSpill(page, "count", vp);
    await shot(page, `count-tt-${vp.width}.png`);
    await context.close();
    ({ context, page, errors } = await open({ role: "owner" }, "/warehouse/kiem-ke", vp));
    await page.waitForSelector("[data-bmq-kho-count='tan_tao'] li");
    await page.locator("[data-bmq-kho-loc='q7']").click();
    await page.waitForSelector("[data-bmq-kho-count='q7'] li");
    const gRow = page.locator("[data-bmq-kho-count='q7'] li").filter({ has: page.locator(".d3-kho-seg") }).first();
    const rowId = await gRow.getAttribute("data-bmq-kho-countrow");
    await gRow.locator("input").fill("160,5");
    await gRow.locator("[data-bmq-kho-countsave]").click();
    await gRow.locator("[data-bmq-kho-done]").waitFor({ timeout: 4000 });
    const countCall = (await calls(page)).filter((c) => c.startsWith("rpc:kho_count_item:")).pop();
    assert.ok(countCall.includes('"p_location":"q7"') && countCall.includes(rowId) && countCall.includes('"p_counted_qty":160500'), countCall);
    await page.locator("[data-bmq-kho-only-left]").click();
    await noSpill(page, "count-q7", vp);
    await shot(page, `count-q7-${vp.width}.png`, false);
    pass(`Kiểm kê: count in kg posts grams for the chosen kho ${vp.width}`);
    assert.deepEqual(errors, [], `page errors count ${vp.width}`);
    await context.close();

    // ---------- Phiếu kho ----------
    ({ context, page, errors } = await open({ role: "owner" }, "/warehouse/phieu", vp));
    await page.waitForSelector("[data-bmq-slip-sku='cbc-2026-v2']");
    await assertTheme(page, "Phiếu kho", vp);
    assert.equal(await page.locator("[data-bmq-slip-open]").count(), 3);
    await noSpill(page, "slips", vp);
    await shot(page, `slips-${vp.width}.png`);
    await context.close();
    ({ context, page, errors } = await open({ role: "owner" }, "/warehouse/phieu", vp));
    await page.locator("[data-bmq-slip-open='in']").click();
    await dialogInView(page, "[data-bmq-fg-slip='in']", vp);
    await shot(page, `slips-fg-in-${vp.width}.png`, false);
    await page.locator("[data-bmq-fg-mode='out']").click();
    await page.waitForSelector("[data-bmq-fg-slip='out']");
    await page.keyboard.press("Escape");
    await page.locator("[data-bmq-slip-open='transfer']").click();
    await dialogInView(page, "[data-bmq-transfer-slip]", vp);
    await page.locator("[data-bmq-slip-search]").fill("a");
    await page.waitForTimeout(150);
    await noSpill(page, "transfer", vp);
    await shot(page, `slips-transfer-${vp.width}.png`, false);
    pass(`Phiếu kho: finished goods + transfer dialogs ${vp.width}`);
    assert.deepEqual(errors, [], `page errors slips ${vp.width}`);
    await context.close();
  }

  // View-only: no switches, no save, no count inputs, no transfer.
  {
    const vp = { width: 390, height: 844 };
    let { context, page } = await open({ role: "viewonly" }, "/warehouse/danh-muc", vp);
    await page.waitForSelector("[data-bmq-kho-names] li");
    await page.locator("[data-bmq-kho-names] li .d3-kho-row-main").first().click();
    await page.waitForSelector("[data-bmq-kho-item-dialog]");
    assert.equal(await page.locator("[data-bmq-kho-save]").count(), 0, "no save for view-only");
    assert.equal(await page.locator("[data-bmq-unit-chips], [data-bmq-conversion-edit], [data-bmq-conversion-add]").count(), 0, "no unit or conversion controls for view-only");
    await context.close();
    ({ context, page } = await open({ role: "viewonly" }, "/warehouse/kiem-ke", vp));
    await page.waitForSelector("[data-bmq-kho-count='tan_tao'] li");
    assert.equal(await page.locator("[data-bmq-kho-countsave]").count(), 0, "no count input for view-only");
    await shot(page, "viewonly-count-390.png", false);
    await context.close();
    ({ context, page } = await open({ role: "viewonly" }, "/warehouse/phieu", vp));
    assert.equal(await page.locator("[data-bmq-slip-open='transfer']").isDisabled(), true, "no transfer for view-only");
    await context.close();
    pass("view-only sees, cannot change");
  }
  // Empty + error
  {
    const vp = { width: 390, height: 844 };
    let { context, page } = await open({ role: "owner", data: "empty" }, "/warehouse/danh-muc", vp);
    await page.waitForSelector("[data-bmq-kho-empty]");
    assert.equal(await page.locator("[data-bmq-kho-new]").count(), 0, "no notice without new names");
    await shot(page, "empty-catalog-390.png", false);
    await context.close();
    ({ context, page } = await open({ role: "owner", data: "error" }, "/warehouse/danh-muc", vp));
    await page.waitForSelector(".d3-kho-failed");
    assert.match(await page.locator(".d3-kho-failed").textContent(), /quá lâu/);
    assert.ok(await page.locator(".d3-kho-failed button").isVisible(), "retry");
    await shot(page, "error-catalog-390.png", false);
    await context.close();
    ({ context, page } = await open({ role: "owner", data: "error" }, "/warehouse/kiem-ke", vp));
    await page.waitForSelector(".d3-kho-failed");
    await context.close();
    pass("empty + error states inside the card, with retry");
    // Loading: the posting ledger shows while the list is read (owner screenshot 22/10).
    for (const route of ["/warehouse/danh-muc", "/warehouse/kiem-ke"]) {
      ({ context, page } = await open({ role: "owner", data: "loading" }, route, vp, "[role=status] .bmq-ld-ledger"));
      await page.waitForTimeout(700);
      const ledger = await page.locator("main [role=status] .bmq-ld-ledger").first().boundingBox();
      assert.ok(ledger && ledger.width >= 50, `${route}: ledger visible while loading`);
      // open() runs with reduced motion on, like an iPhone with "Reduce Motion": the ledger must be shown and still pulse.
      const facts = await page.evaluate(() => { const o = document.querySelector("main [role=status] .bmq-ld-oven"); const e = o.querySelector(".bmq-ld-entry"); return { opacity: Number(getComputedStyle(o).opacity), entry: getComputedStyle(e).animationName }; });
      assert.ok(facts.opacity > 0.95, `${route}: ledger invisible under reduced motion (${JSON.stringify(facts)})`);
      assert.equal(facts.entry, "bmq-ld-fade", `${route}: ledger frozen under reduced motion`);
      assert.equal(await page.locator(".d3-kho-row.is-ghost").count(), 0, `${route}: no static ghost rows`);
      await shot(page, `loading-${route.split("/").pop()}-390.png`, false);
      await context.close();
    }
    pass("loading shows the Sổ cái ledger on Danh mục kho + Kiểm kê");
  }
  // Order by email (owner 23/10): the item card opens the Đặt hàng page on its supplier (one ordering path,
  // with VAT) and keeps the item's order history; then the supplier's upload page.
  for (const vp of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const { context, page, errors } = await open({ role: "owner" }, "/warehouse/danh-muc", vp);
    await page.waitForSelector("[data-bmq-kho-names] li");
    const firstId = await page.locator("[data-bmq-kho-names] li .d3-kho-row-main").first().getAttribute("data-bmq-kho-item");
    await page.locator(`[data-bmq-kho-item='${firstId}']`).click();
    await dialogInView(page, "[data-bmq-kho-item-dialog]", vp);
    const section = page.locator("[data-bmq-kho-order]");
    await section.waitFor();
    assert.match(await section.innerText(), /Đặt hàng · TV Food\b/);
    assert.match(await section.innerText(), /xem trước email có VAT/);
    await noSpill(page, "order-card", vp);
    await section.scrollIntoViewIfNeeded();
    await page.locator("[data-bmq-kho-item-dialog]").screenshot({ path: `${EVIDENCE}/order-card-${vp.width}.png` });
    await page.locator("[data-bmq-kho-order-open]").click();
    await page.waitForURL(/\/dat-hang\?ncc=sup-tv$/, { timeout: 5000 });
    await page.waitForSelector("[data-bmq-supplier-orders]");
    assert.equal((await calls(page)).filter((c) => c.startsWith("invoke:supplier-order-send:")).length, 0, "the card itself sends nothing");
    assert.deepEqual(errors, [], `order card errors @${vp.width}`);
    await context.close();
    pass(`Đặt hàng card: opens /dat-hang on its supplier ${vp.width}`);
    // Supplier upload page (public link, no login, no app shell).
    const ctx = await browser.newContext({ viewport: vp, reducedMotion: "reduce", locale: "vi-VN" });
    let uploads = 0;
    await ctx.route("**/*", async (r) => {
      const url = r.request().url();
      if (url.includes("/functions/v1/supplier-order-upload")) {
        const token = new URL(url).searchParams.get("t");
        if (token !== "QAtoken_abcdefghijklmnopqrstuvwxyz0123456789") return r.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ code: "link_invalid" }) });
        if (r.request().method() === "POST") { uploads += 1; return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ uploaded: true, count: uploads }) }); }
        return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ po_number: "PO-000861", supplier_name: "TV Food", product_name: "BƠ PEERLESS", quantity: 100, unit: "kg", sent_at: new Date().toISOString(), upload_count: 0 }) });
      }
      if (url.startsWith(BASE) || url.startsWith("data:") || url.startsWith("blob:")) return r.continue();
      return r.abort();
    });
    const portal = await ctx.newPage();
    const portalErrors = [];
    portal.on("pageerror", (e) => portalErrors.push(e.message));
    await portal.goto(`${BASE}/ncc/hoa-don/QAtoken_abcdefghijklmnopqrstuvwxyz0123456789`, { waitUntil: "domcontentloaded" });
    await portal.waitForSelector("[data-bmq-supplier-upload-order]", { timeout: 30000 });
    assert.match(await portal.locator("[data-bmq-supplier-upload-order]").innerText(), /PO-000861[\s\S]*BƠ PEERLESS · 100 kg/);
    assert.equal(await portal.locator("[data-bmq-shell]").count(), 0, "no app shell on the supplier page");
    await portal.screenshot({ path: `${EVIDENCE}/supplier-upload-${vp.width}.png`, fullPage: true });
    await portal.setInputFiles("#supplier-upload-file", { name: "phieu-giao.jpg", mimeType: "image/jpeg", buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]) });
    await portal.waitForSelector("[data-bmq-supplier-upload-thanks]");
    assert.match(await portal.locator("[data-bmq-supplier-upload-count]").innerText(), /1 file/);
    const spill = await portal.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(spill <= 0, `supplier page overflow ${spill}`);
    await portal.screenshot({ path: `${EVIDENCE}/supplier-upload-done-${vp.width}.png`, fullPage: true });
    await portal.goto(`${BASE}/ncc/hoa-don/WRONGtoken_abcdefghijklmnopqrstuvwxyz0123`, { waitUntil: "domcontentloaded" });
    await portal.waitForSelector("[data-bmq-supplier-upload-invalid]");
    assert.deepEqual(portalErrors, [], `supplier page errors @${vp.width}`);
    await ctx.close();
    pass(`Trang NCC gửi hoá đơn: order summary, upload, invalid link ${vp.width}`);
  }

  // The game is gone: old links land on Danh mục kho; the Kho menu names the three pages.
  for (const route of ["/warehouse/game", "/warehouse/game?ban=cu", "/warehouse/office"]) {
    const vp = { width: 1440, height: 900 };
    const { context, page, errors } = await open({ role: "owner" }, route, vp);
    assert.equal(new URL(page.url()).pathname, "/warehouse/danh-muc", `${route} ends on /warehouse/danh-muc`);
    assert.equal((await themeFacts(page)).gameNodes, 0, `${route}: no game markup`);
    if (route === "/warehouse/game") {
      const chips = await page.locator(".d3-subnav").innerText().catch(() => "");
      for (const label of ["Danh mục kho", "Kiểm kê", "Phiếu kho"]) assert.ok(chips.includes(label), `Kho menu has ${label}: ${chips}`);
      assert.ok(!chips.includes("Game kho"), "Kho menu has no Game kho");
    }
    assert.deepEqual(errors, [], `${route}: page errors`);
    pass(`${route} lands on Danh mục kho`);
    await context.close();
  }
  console.log(`\n${results.length} checks passed · evidence ${EVIDENCE}`);
} finally {
  await browser.close();
  await server.close();
}
