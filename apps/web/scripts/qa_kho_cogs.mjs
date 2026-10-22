// Browser QA for Giá vốn → Kho (/warehouse/gia-von, owner 22/10/2026): kho state + switch, coverage
// per channel, "Cần chọn" decision cards (product / ingredient), the per-item comparison and its trace.
//
// FIXTURE AUTH + FIXTURE DATA: AuthContext and the Supabase client are replaced by in-memory fixtures shaped
// like the live RPC output of 22/10 (cogs_backflush_overview etc.); every RPC call is recorded and nothing
// leaves the machine. This proves the real page renders, sizes and calls the right RPCs with the right
// arguments; it is not real-user acceptance.
//
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core node scripts/qa_kho_cogs.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-kho-cogs-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5254);
const { chromium } = createRequire(import.meta.url)(PW);
fs.mkdirSync(EVIDENCE, { recursive: true });

const SUPABASE_FIXTURE = `
const cfg = () => JSON.parse(localStorage.getItem("qa-shell") || "{}");
window.__qaCalls = window.__qaCalls || [];
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
function khoItems() {
  const F = window.__kgFixture;
  return F.items.map((it, i) => ({
    id: it.id, item_code: it.code, name: it.name, unit: i % 3 === 0 ? "g" : it.unit, active: i % 17 !== 5,
    item_class: it.item_class, in_q7: Boolean(it.pastry_q7),
    qty: { tan_tao: 0, q7: 0 }, last_count_date: { tan_tao: null, q7: null }, pending_count: { tan_tao: null, q7: null }, doc_lines: 0,
  }));
}
// The bread item of the ingredient gap: an active Tân Tạo item counted in pieces.
function breadItem() { return khoItems().find((it) => it.active && !it.in_q7 && it.unit !== "g" && it.unit !== "ml"); }
function overview() {
  const mode = cfg().data || "populated";
  const role = cfg().role || "owner";
  const enabled = JSON.parse(localStorage.getItem("qa-enabled") || "{}");
  const decided = JSON.parse(localStorage.getItem("qa-decided") || "[]");
  const settings = [
    { location: "q7", enabled: Boolean(enabled.q7), start_date: enabled.q7 || null, cutover_date: "2026-10-16", updated_at: null },
    { location: "tan_tao", enabled: Boolean(enabled.tan_tao), start_date: enabled.tan_tao || null, cutover_date: "2026-10-16", updated_at: null },
  ];
  const base = { as_of: today, from: today, to: today, settings, can_decide: role === "owner", can_switch: role === "owner",
    last_run: { id: "run-qa", started_at: today + "T01:15:00+00:00", finished_at: today + "T01:15:01+00:00", window_from: today, window_to: today, dry_run: false, posted_rows: 0, summary: {}, error: null },
    sku_options: [
      { sku_id: "sku-bmq1", sku_code: "BMQ-001", name: "Bánh mì que Pate", unit: "gói" },
      { sku_id: "sku-cpm", sku_code: "cpm-2026-v3", name: "BÁNH CUA PHÔ MAI", unit: "gói" },
      { sku_id: "sku-croi", sku_code: "Croi-2026-v4", name: "BÁNH CROISSANT 50G", unit: "gói" },
      { sku_id: "sku-croffle", sku_code: "KF-CROFFLE-40G-T0526", name: "BÁNH CROFFLE 160G (40G x 4 CÁI)", unit: "Hộp" },
    ] };
  if (mode === "empty") return { ...base, coverage: [], items: [], gaps: { products: [], ingredients: [], recipes: [] } };
  const bread = breadItem();
  const ingredients = [
    { canonical_material_id: "mat-bread", material_name: "Bánh mì tươi", recipe_unit: "g", reason: "unit", sku_codes: ["BMQ-001"], candidates: [{ item_id: bread.id, name: bread.name, unit: bread.unit }] },
    { canonical_material_id: "mat-chili", material_name: "Ớt chế biến", recipe_unit: "g", reason: "no_item", sku_codes: ["BMQ-001"], candidates: [] },
    { canonical_material_id: "mat-lab", material_name: "Phân tích mẫu Pate với một tên rất dài để thử xuống dòng trên điện thoại nhỏ", recipe_unit: "g", reason: "no_item", sku_codes: ["BMQ-001"], candidates: [] },
  ].filter((g) => !decided.includes(g.canonical_material_id));
  const products = [
    { map_id: "map-vj", channel: "B2B BMQ", product_code: "40000294", name: "Bánh mì", lines: 36, qty: 6239, value: 155975000,
      candidates: [{ sku_id: "sku-bmq1", sku_code: "BMQ-001", name: "Bánh mì que Pate", score: 0.5 }, { sku_id: "sku-croi", sku_code: "Croi-2026-v4", name: "BÁNH CROISSANT 50G", score: 0.5 }, { sku_id: "sku-cpm", sku_code: "cpm-2026-v3", name: "BÁNH CUA PHÔ MAI", score: 0.25 }] },
    { map_id: "map-po", channel: "ĐẠI LÝ", product_code: "", name: "PO/email parsed item", lines: 4, qty: 1590, value: 10335000, candidates: [] },
  ].filter((g) => !decided.includes(g.map_id));
  return { ...base,
    coverage: [
      { channel: "B2B BMQ", lines: 36, qty: 6239, value: 155975000, mapped_lines: 0, mapped_qty: 0, mapped_value: 0, mapped_pct: 0, mapped_value_pct: 0 },
      { channel: "BÁNH NGỌT", lines: 250, qty: 29032, value: 470282779, mapped_lines: 250, mapped_qty: 29032, mapped_value: 470282779, mapped_pct: 100, mapped_value_pct: 100 },
      { channel: "ĐẠI LÝ", lines: 692, qty: 82632, value: 537108000, mapped_lines: 682, mapped_qty: 80440, mapped_value: 522860000, mapped_pct: 98.6, mapped_value_pct: 97.3 },
      { channel: "Retail Kiosk", lines: 301, qty: 8548, value: 119672000, mapped_lines: 301, mapped_qty: 8548, mapped_value: 119672000, mapped_pct: 100, mapped_value_pct: 100 },
    ],
    items: [
      { item_id: "it-flour", name: "Bột mì 888 Cam", unit: "g", location: "q7", recipe_qty: 73119.86, pxk_usage: 59391.46, posted_cogs: 0 },
      { item_id: "it-water", name: "Nước Vihawa 20L Bình Vòi", unit: "g", location: "q7", recipe_qty: 30087.16, pxk_usage: 24044.56, posted_cogs: 0 },
      { item_id: "it-cheese", name: "Phô mai 84 lát trắng Dairymont (1kg/khối 12 khối/thùng)", unit: "g", location: "q7", recipe_qty: 14493.6, pxk_usage: 14000, posted_cogs: 0 },
      { item_id: "it-ice", name: "NƯỚC ĐÁ", unit: "g", location: "q7", recipe_qty: 5400, pxk_usage: 0, posted_cogs: 0 },
      { item_id: "it-soap", name: "Nước rửa chén Gift 3.8l", unit: "g", location: "q7", recipe_qty: 0, pxk_usage: 4320, posted_cogs: 0 },
    ],
    gaps: { products, ingredients, recipes: [{ sku_code: "rbn-2026-v5", name: "BÁNH CROSS BUN NHO", reason: "no_recipe", lines: 2 }] } };
}
function settle(st) {
  const mode = cfg().data || "populated";
  window.__qaCalls.push(st.table + ":" + JSON.stringify(st.args));
  if (mode === "error" && st.table === "rpc:cogs_backflush_overview") return { data: null, error: { message: "canceling statement due to statement timeout", code: "57014" } };
  if (st.table === "rpc:cogs_backflush_overview") return { data: overview(), error: null };
  if (st.table === "rpc:kho_get_items") return { data: { can_edit: true, can_count: { tan_tao: true, q7: true }, items: khoItems() }, error: null };
  if (st.table === "rpc:cogs_item_usage_trace") {
    return { data: { location: st.args.p_location, item_id: st.args.p_item_id, from: st.args.p_from, to: st.args.p_to, rows: [
      { revenue_date: today, sku_id: "sku-cpm", sku_code: "cpm-2026-v3", sku_name: "BÁNH CUA PHÔ MAI", revenue_line_id: "l1", channel: "BÁNH NGỌT", ref: "PO1002662319", customer: "KINGFOOD MART", revenue_qty: 200, version_id: "v", version_no: 3, version_no_text: "3", recipe_unit: "g", recipe_qty: 9840, stock_qty: 9840, status: "ok" },
      { revenue_date: today, sku_id: "sku-croi", sku_code: "Croi-2026-v4", sku_name: "BÁNH CROISSANT 50G", revenue_line_id: "l2", channel: "BÁNH NGỌT", ref: "PO1002662320", customer: "KINGFOOD MART", revenue_qty: 120, version_id: "v", version_no: 4, version_no_text: "4", recipe_unit: "g", recipe_qty: 3675.6, stock_qty: 3675.6, status: "ok" },
      { revenue_date: "2026-10-20", sku_id: "sku-cpm", sku_code: "cpm-2026-v3", sku_name: "BÁNH CUA PHÔ MAI", revenue_line_id: "l3", channel: "BÁNH NGỌT", ref: "SP001507", customer: "", revenue_qty: 150, version_id: "v", version_no: 3, version_no_text: "3", recipe_unit: "g", recipe_qty: 7380, stock_qty: 7380, status: "ok" },
    ] }, error: null };
  }
  if (st.table === "rpc:cogs_set_backflush") {
    const enabled = JSON.parse(localStorage.getItem("qa-enabled") || "{}");
    if (st.args.p_enabled) enabled[st.args.p_location] = st.args.p_start_date; else delete enabled[st.args.p_location];
    localStorage.setItem("qa-enabled", JSON.stringify(enabled));
    return { data: { location: st.args.p_location, enabled: st.args.p_enabled, status: st.args.p_enabled ? "enabled" : "disabled" }, error: null };
  }
  if (st.table === "rpc:cogs_decide_ingredient" || st.table === "rpc:cogs_decide_revenue_product") {
    const decided = JSON.parse(localStorage.getItem("qa-decided") || "[]");
    decided.push(st.args.p_canonical_material_id || st.args.p_map_id);
    localStorage.setItem("qa-decided", JSON.stringify(decided));
    return { data: { status: "confirmed" }, error: null };
  }
  if (st.table === "rpc:cogs_refresh_now") return { data: { run_id: "run-qa-2", posted_rows: 0 }, error: null };
  if (st.table === "rpc:get_item_receipt_lines") return { data: window.__kgFixture.receipt_lines ?? [], error: null };
  if (/^rpc:/.test(st.table)) return { data: null, error: null };
  return { data: [], error: null, count: 0 };
}

function builder(table, args) {
  const st = { table, args: args || {} };
  const proxy = new Proxy(function () {}, {
    get(_t, prop) {
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
  functions: { invoke: async (name) => { window.__qaCalls.push("invoke:" + name); return { data: null, error: { message: "QA fixture: functions disabled" } }; } },
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
  name: "qa-kho-cogs-fixtures",
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
  root: ROOT, configFile: false, logLevel: "error",
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-kho-cogs-qa/vite-cache",
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

async function open(cfg, route, viewport, ready = "[data-bmq-kho-cogs]") {
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
    for (const el of document.querySelectorAll(".d3-cogs *, [role='dialog'] *")) {
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
const tomorrowVN = () => {
  const [y, m, d] = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date()).split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
};
const callsOf = async (page, fn) => (await calls(page)).filter((c) => c.startsWith(`rpc:${fn}:`)).map((c) => JSON.parse(c.slice(`rpc:${fn}:`.length)));
async function pickOption(page, pickerSelector, text) {
  await page.locator(pickerSelector).click();
  const search = page.locator(".d3-pick input, [data-bmq-picker-search]").first();
  if (await search.count()) await search.fill(text);
  await page.locator("[data-bmq-picker-option]", { hasText: text }).first().click();
}

const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }];
try {
  for (const vp of VIEWPORTS) {
    // ---------- populated page as the owner ----------
    let { context, page, errors } = await open({ role: "owner" }, "/warehouse/gia-von", vp);
    await page.waitForSelector("[data-bmq-cogs-cover]");
    const h1 = await page.locator(".d3-cogs h1").innerText();
    assert.equal(h1.replace(/\s+/g, " ").trim(), "Giá vốn → Kho", `title ${vp.width}`);
    assert.match(await page.locator(".d3-cogs h1").evaluate((el) => getComputedStyle(el).fontFamily), /Be Vietnam Pro/);
    assert.ok(!EMOJI.test(await page.locator(".d3-cogs").innerText()), "no emoji");
    // coverage: four channels, biggest value first, tone by %
    const tiles = await page.locator("[data-bmq-cogs-cover]").evaluateAll((els) => els.map((el) => [el.getAttribute("data-bmq-cogs-cover"), el.className.match(/is-(good|mid|low)/)?.[1], el.querySelector("strong").textContent]));
    assert.deepEqual(tiles, [["ĐẠI LÝ", "good", "97,3%"], ["BÁNH NGỌT", "good", "100%"], ["B2B BMQ", "low", "0%"], ["Retail Kiosk", "good", "100%"]], `tiles ${JSON.stringify(tiles)}`);
    // kho state cards
    assert.equal(await page.locator("[data-bmq-cogs-kho='q7']").getAttribute("data-on"), "0");
    assert.match(await page.locator("[data-bmq-cogs-kho='q7']").innerText(), /Chạy thử[\s\S]*Kiểm kê gần nhất: 16\/10\/2026/);
    assert.ok(await page.locator("[data-bmq-cogs-enable='q7']").isVisible(), "owner sees Bật trừ sổ");
    assert.ok(await page.locator("[data-bmq-cogs-rerun]").isVisible(), "owner sees Chạy lại");
    // gaps: 3 ingredients + 2 products + 1 recipe
    assert.equal(await page.locator("[data-bmq-cogs-gap='ingredient']").count(), 3);
    assert.equal(await page.locator("[data-bmq-cogs-gap='product']").count(), 2);
    assert.equal(await page.locator("[data-bmq-cogs-gap='recipe']").count(), 1);
    assert.match(await page.locator("[data-bmq-cogs-gap='ingredient']").first().innerText(), /Công thức tính bằng g, món kho tính bằng \S+: chưa có quy đổi/);
    // items: Q7 tab, sorted by recipe qty, diff chips
    const rows = await page.locator("[data-bmq-cogs-item] .d3-pu-name strong").allTextContents();
    assert.equal(rows[0], "Bột mì 888 Cam");
    assert.equal(await page.locator("[data-bmq-cogs-item]").first().locator("[data-bmq-cogs-diff]").getAttribute("data-bmq-cogs-diff"), "23");
    assert.match(await page.locator("[data-bmq-cogs-item]").first().innerText(), /73,12 kg[\s\S]*59,39 kg/);
    assert.match(await page.locator("[data-bmq-cogs-item]", { hasText: "NƯỚC ĐÁ" }).innerText(), /Chưa có phiếu xuất để so/);
    assert.match(await page.locator("[data-bmq-cogs-item]", { hasText: "Nước rửa chén" }).innerText(), /Không có trong công thức đã nối/);
    assert.match(await page.locator("[data-bmq-cogs-cover='ĐẠI LÝ']").innerText(), /537,1 tr/);
    await page.locator("[data-bmq-cogs-kho-tab='tan_tao']").click();
    assert.match(await page.locator("[data-bmq-cogs-items] .d3-wh-empty").innerText(), /Kho Tân Tạo/);
    await page.locator("[data-bmq-cogs-kho-tab='q7']").click();
    await noSpill(page, "page", vp);
    await shot(page, `page-${vp.width}.png`);
    assert.deepEqual(errors, [], `page errors ${vp.width}`);
    pass(`page: title, coverage tiles, kho states, gaps, items ${vp.width}`);
    await context.close();

    // ---------- item trace ----------
    ({ context, page, errors } = await open({ role: "owner" }, "/warehouse/gia-von", vp));
    await page.waitForSelector("[data-bmq-cogs-item]");
    await page.locator("[data-bmq-cogs-item] .d3-pu-row").first().click();
    await dialogInView(page, "[data-bmq-cogs-trace]", vp);
    await page.waitForSelector("[data-bmq-cogs-trace-row]");
    assert.equal(await page.locator("[data-bmq-cogs-trace-row]").count(), 3);
    assert.match(await page.locator("[data-bmq-cogs-trace-row]").first().innerText(), /BÁNH CUA PHÔ MAI[\s\S]*KINGFOOD MART · PO1002662319 · bán 200 · công thức v3[\s\S]*9,84 kg/);
    const traceCall = (await callsOf(page, "cogs_item_usage_trace"))[0];
    assert.equal(traceCall.p_item_id, "it-flour");
    assert.equal(traceCall.p_location, "q7");
    await noSpill(page, "trace", vp);
    await shot(page, `trace-${vp.width}.png`, false);
    pass(`item trace dialog ${vp.width}`);
    await context.close();

    // ---------- enable Q7 (owner) ----------
    ({ context, page, errors } = await open({ role: "owner" }, "/warehouse/gia-von", vp));
    await page.locator("[data-bmq-cogs-enable='q7']").click();
    await dialogInView(page, "[data-bmq-cogs-enable-dialog]", vp);
    assert.equal(await page.locator("[data-bmq-cogs-start]").inputValue(), tomorrowVN(), "start defaults to tomorrow");
    assert.match(await page.locator("[data-bmq-cogs-enable-dialog]").innerText(), /Phiếu xuất NVL Q7 từ ngày này không trừ nữa/);
    await shot(page, `enable-${vp.width}.png`, false);
    await page.locator("[data-bmq-cogs-enable-ok]").click();
    await page.waitForSelector("[data-bmq-cogs-enable-dialog]", { state: "detached", timeout: 4000 });
    const setCall = (await callsOf(page, "cogs_set_backflush"))[0];
    assert.equal(setCall.p_location, "q7");
    assert.equal(setCall.p_enabled, true);
    assert.equal(setCall.p_start_date, tomorrowVN());
    assert.ok(setCall.p_request_id, "request id");
    assert.equal((await callsOf(page, "cogs_refresh_now")).length, 1, "refresh after enabling");
    await page.waitForSelector("[data-bmq-cogs-kho='q7'][data-on='1']");
    assert.ok(await page.locator("[data-bmq-cogs-disable='q7']").isVisible(), "Tắt trừ sổ shown");
    // disable asks first
    await page.locator("[data-bmq-cogs-disable='q7']").click();
    await confirmOk(page);
    await page.waitForSelector("[data-bmq-cogs-kho='q7'][data-on='0']");
    assert.equal((await callsOf(page, "cogs_set_backflush"))[1].p_enabled, false);
    pass(`enable Q7 from tomorrow, then disable with a confirm ${vp.width}`);
    await context.close();

    // ---------- ingredient: finished-goods ledger, and deduct with a factor ----------
    ({ context, page, errors } = await open({ role: "owner" }, "/warehouse/gia-von", vp));
    await page.locator("[data-bmq-cogs-gap='ingredient']").first().click();
    await dialogInView(page, "[data-bmq-cogs-ingredient-dialog]", vp);
    await page.waitForSelector("[data-bmq-cogs-factor]");
    assert.ok(await page.locator("[data-bmq-cogs-ingredient-dialog] [data-bmq-receipt-notes]").isVisible(), "delivery notes next to the factor (owner rule 17/10)");
    assert.ok((await calls(page)).some((c) => c.startsWith("rpc:get_item_receipt_lines:")), "receipt lines asked for the chosen item");
    assert.equal(await page.locator("[data-bmq-cogs-ingredient-save]").isDisabled(), true, "deduct needs a factor");
    await shot(page, `ingredient-${vp.width}.png`, false);
    await page.locator("[data-bmq-cogs-factor]").fill("1");
    assert.equal(await page.locator("[data-bmq-cogs-ingredient-save]").isDisabled(), false);
    await page.locator("[data-bmq-cogs-action='finished_goods_ledger']").click();
    assert.equal(await page.locator("[data-bmq-cogs-factor]").count(), 0, "no item fields for the finished-goods ledger");
    await page.locator("[data-bmq-cogs-ingredient-save]").click();
    await page.waitForSelector("[data-bmq-cogs-ingredient-dialog]", { state: "detached", timeout: 4000 });
    const ing = (await callsOf(page, "cogs_decide_ingredient"))[0];
    assert.deepEqual([ing.p_canonical_material_id, ing.p_recipe_unit, ing.p_action, ing.p_item_id, ing.p_factor, ing.p_location], ["mat-bread", "g", "finished_goods_ledger", null, null, null]);
    assert.equal((await callsOf(page, "cogs_refresh_now")).length, 1);
    await page.waitForFunction(() => document.querySelectorAll("[data-bmq-cogs-gap='ingredient']").length === 2);
    // deduct into a Q7 g item: the standard factor fills itself
    await page.locator("[data-bmq-cogs-gap='ingredient']").first().click();
    await dialogInView(page, "[data-bmq-cogs-ingredient-dialog]", vp);
    const q7g = await page.evaluate(() => { const F = window.__kgFixture; const i = F.items.findIndex((it, k) => it.pastry_q7 && k % 3 === 0 && k % 17 !== 5); return F.items[i].name; });
    await pickOption(page, "[data-bmq-cogs-item-picker]", q7g);
    await page.waitForSelector("[data-bmq-cogs-standard]");
    assert.match(await page.locator("[data-bmq-cogs-standard]").innerText(), /1 g = 1 g · tự đổi theo đơn vị chuẩn · trừ ở Kho Q7/);
    await page.locator("[data-bmq-cogs-ingredient-save]").click();
    await page.waitForSelector("[data-bmq-cogs-ingredient-dialog]", { state: "detached", timeout: 4000 });
    const ing2 = (await callsOf(page, "cogs_decide_ingredient"))[1];
    assert.deepEqual([ing2.p_action, ing2.p_location, ing2.p_factor], ["deduct", "q7", 1]);
    assert.ok(ing2.p_item_id, "item id sent");
    await noSpill(page, "ingredient", vp);
    assert.deepEqual(errors, [], `ingredient errors ${vp.width}`);
    pass(`ingredient decisions: finished-goods ledger, deduct with the standard factor ${vp.width}`);
    await context.close();

    // ---------- product: pick a candidate, then skip another ----------
    ({ context, page, errors } = await open({ role: "owner" }, "/warehouse/gia-von", vp));
    await page.locator("[data-bmq-cogs-gap='product']").first().click();
    await dialogInView(page, "[data-bmq-cogs-product-dialog]", vp);
    assert.equal(await page.locator("[data-bmq-cogs-candidate]").count(), 3);
    assert.equal(await page.locator("[data-bmq-cogs-candidate='BMQ-001']").getAttribute("aria-checked"), "true", "first candidate preselected");
    await page.locator("[data-bmq-cogs-candidate='cpm-2026-v3']").click();
    await page.locator("[data-bmq-cogs-units]").fill("2");
    await shot(page, `product-${vp.width}.png`, false);
    await page.locator("[data-bmq-cogs-product-save]").click();
    await page.waitForSelector("[data-bmq-cogs-product-dialog]", { state: "detached", timeout: 4000 });
    const prod = (await callsOf(page, "cogs_decide_revenue_product"))[0];
    assert.deepEqual([prod.p_map_id, prod.p_sku_id, prod.p_units_per_revenue_unit, prod.p_reject], ["map-vj", "sku-cpm", 2, false]);
    await page.waitForFunction(() => document.querySelectorAll("[data-bmq-cogs-gap='product']").length === 1);
    await page.locator("[data-bmq-cogs-gap='product']").first().click();
    await dialogInView(page, "[data-bmq-cogs-product-dialog]", vp);
    assert.equal(await page.locator("[data-bmq-cogs-product-save]").isDisabled(), true, "no candidate: pick first");
    await page.locator("[data-bmq-cogs-skip]").click();
    await page.locator("[data-bmq-cogs-product-save]").click();
    await page.waitForSelector("[data-bmq-cogs-product-dialog]", { state: "detached", timeout: 4000 });
    const skip = (await callsOf(page, "cogs_decide_revenue_product"))[1];
    assert.deepEqual([skip.p_map_id, skip.p_sku_id, skip.p_reject], ["map-po", null, true]);
    assert.equal(await page.locator("[data-bmq-cogs-gap='product']").count(), 0);
    assert.deepEqual(errors, [], `product errors ${vp.width}`);
    pass(`product decisions: candidate with 2 units, then "không trừ kho" ${vp.width}`);
    await context.close();

    // ---------- staff: read only ----------
    ({ context, page, errors } = await open({ role: "staff" }, "/warehouse/gia-von", vp));
    await page.waitForSelector("[data-bmq-cogs-gap]");
    assert.equal(await page.locator("[data-bmq-cogs-enable]").count(), 0, "no switch for staff");
    assert.equal(await page.locator("[data-bmq-cogs-rerun]").count(), 0, "no rerun for staff");
    assert.equal(await page.locator("[data-bmq-cogs-gap='ingredient']").first().isDisabled(), true, "gap cards read only");
    assert.match(await page.locator("[data-bmq-cogs-gaps] .d3-wh-card-h p").innerText(), /Người có quyền sửa kho chọn/);
    await context.close();
    pass(`staff sees the page read only ${vp.width}`);

    // ---------- empty + error ----------
    ({ context, page } = await open({ role: "owner", data: "empty" }, "/warehouse/gia-von", vp));
    await page.waitForSelector(".d3-cogs-allset");
    assert.match(await page.locator("[data-bmq-cogs-items] .d3-wh-empty").innerText(), /Chưa có nguyên liệu nào/);
    await noSpill(page, "empty", vp);
    await shot(page, `empty-${vp.width}.png`, false);
    await context.close();
    ({ context, page } = await open({ role: "owner", data: "error" }, "/warehouse/gia-von", vp));
    await page.waitForSelector(".d3-wh-alert.is-error");
    assert.match(await page.locator(".d3-wh-alert.is-error").innerText(), /Không tải được\.[\s\S]*quá lâu/);
    await context.close();
    pass(`empty + error states ${vp.width}`);
  }
  // The Kho menu names the page.
  {
    const { context, page } = await open({ role: "owner" }, "/warehouse/gia-von", { width: 1440, height: 900 });
    const chips = await page.locator(".d3-subnav").innerText().catch(() => "");
    assert.ok(chips.includes("Giá vốn → Kho"), `Kho menu has Giá vốn → Kho: ${chips}`);
    pass("Kho menu lists Giá vốn → Kho");
    await context.close();
  }
  console.log(`\n${results.length} checks passed · evidence ${EVIDENCE}`);
} finally {
  await browser.close();
  await server.close();
}
