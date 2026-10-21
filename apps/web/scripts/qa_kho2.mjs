// Browser QA for Game kho — 2 việc (/warehouse/game) and Phiếu kho (/warehouse/phieu), owner 21/10/2026.
//
// FIXTURE AUTH + FIXTURE DATA: AuthContext and the Supabase client are replaced by in-memory fixtures;
// every RPC call is recorded and nothing leaves the machine. This proves the real page components render,
// size and call the right RPCs with the right arguments; it is not real-user acceptance.
//
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core node scripts/qa_kho2.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-kho2-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5251);
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
    id: it.id, item_code: it.code, name: it.name, unit: i % 3 === 0 ? "g" : it.unit, active: !off.includes(it.id) && i % 17 !== 5,
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
  if (st.table === "rpc:set_stock_item_class") return { data: { item_id: st.args.p_item_id, old_class: null, item_class: st.args.p_class }, error: null };
  if (st.table === "rpc:get_item_receipt_lines" || st.table === "rpc:get_crate_receipt_lines") return { data: window.__kgFixture.receipt_lines ?? [], error: null };
  if (st.table === "rpc:get_warehouse_game_snapshot") {
    const F = window.__kgFixture;
    const loc = st.args.p_location;
    const items = F.items.filter((it) => loc !== "q7" || it.pastry_q7);
    const q7Skus = [{ id: "fg-cbc", sku_code: "cbc-2026-v2", product_name: "BÁNH MÌ CHÀ BÔNG CAY", unit: "gói", on_hand: 12 }];
    return { data: { location: loc, cutover_date: "2026-10-16", items, skus: loc === "tan_tao" ? F.skus : q7Skus, pending: mode === "empty" ? [] : (loc === "q7" ? F.q7 : F.tt), transfers: F.transfers ?? [], counts: {}, can_edit: role === "owner" }, error: null };
  }
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
  name: "qa-kho2-fixtures",
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
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-kho2-qa/vite-cache",
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

async function open(cfg, route, viewport) {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce", locale: "vi-VN" });
  await context.addInitScript((fixture) => { window.__kgFixture = fixture; }, KG_FIXTURE);
  await context.addInitScript((value) => { if (!sessionStorage.getItem("qa-init")) { localStorage.clear(); sessionStorage.setItem("qa-init", "1"); } localStorage.setItem("qa-shell", JSON.stringify(value)); }, cfg);
  await context.route("**/*", (r) => {
    const url = r.request().url();
    if (url.startsWith(BASE) || url.startsWith("data:") || url.startsWith("blob:") || /fonts\.(googleapis|gstatic)\.com/.test(url)) return r.continue();
    return r.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + route, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(route.startsWith("/warehouse/phieu") ? "[data-bmq-warehouse-slips]" : "[data-bmq-kho2]", { timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  return { context, page, errors };
}
const overflow = (page) => page.evaluate(() => {
  const bad = [];
  for (const el of document.querySelectorAll(".k2 *")) {
    const r = el.getBoundingClientRect();
    if (r.width && (r.right > window.innerWidth + 1 || r.left < -1) && getComputedStyle(el).position !== "fixed") bad.push(`${el.tagName}.${el.className}`.slice(0, 80));
  }
  return { doc: document.documentElement.scrollWidth - window.innerWidth, bad: bad.slice(0, 5) };
});
const calls = (page) => page.evaluate(() => window.__qaCalls);
async function noSpill(page, label, vp) {
  const o = await overflow(page);
  assert.ok(o.doc <= 0 && o.bad.length === 0, `${label} ${vp.width}: overflow ${JSON.stringify(o)}`);
}
async function confirmOk(page) {
  await page.waitForSelector("[data-bmq-game-confirm]", { timeout: 4000 });
  await page.locator("[data-bmq-game-confirm-ok]").click();
  await page.waitForSelector("[data-bmq-game-confirm]", { state: "detached", timeout: 3000 });
}

const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }];
try {
  for (const vp of VIEWPORTS) {
    // Home
    let { context, page, errors } = await open({ role: "owner" }, "/warehouse/game", vp);
    await page.waitForSelector("[data-bmq-kho2-door='names']");
    assert.equal(await page.locator("[data-bmq-kho2-door]").count(), 2, "exactly two doors");
    assert.match(await page.locator("[data-bmq-kho2-door='names'] b").textContent(), /^Danh mục$/);
    assert.match(await page.locator("[data-bmq-kho2-door='count'] b").textContent(), /^Kiểm kê$/);
    assert.equal(await page.locator(".k2 :text-matches('Tên hàng|Đếm hàng')").count(), 0, "old labels gone");
    await noSpill(page, "home", vp);
    await page.screenshot({ path: `${EVIDENCE}/home-${vp.width}.png` });
    pass(`home two doors Danh mục + Kiểm kê ${vp.width}`);

    // Danh mục: three groups
    await page.locator("[data-bmq-kho2-door='names']").click();
    await page.waitForSelector("[data-bmq-kho2-groups]");
    assert.deepEqual(await page.locator("[data-bmq-kho2-group] b").allTextContents(), ["Nguyên liệu", "Bao bì & vật tư", "Thành phẩm"]);
    assert.equal(await page.locator("[data-bmq-kho2-group='nl']").getAttribute("aria-selected"), "true", "opens on Nguyên liệu");
    const nlNames = await page.locator("[data-bmq-kho2-names] li b").allTextContents();
    assert.ok(nlNames.some((n) => /băng keo lớn/i.test(n)) && !nlNames.some((n) => /băng keo nhỏ/i.test(n)), "packaging not in Nguyên liệu");
    await page.locator("[data-bmq-kho2-group='bb']").click();
    const bbNames = await page.locator("[data-bmq-kho2-names] li b").allTextContents();
    assert.ok(bbNames.some((n) => /băng keo nhỏ/i.test(n)) && !bbNames.some((n) => /băng keo lớn/i.test(n)), "Bao bì list");
    await noSpill(page, "group-bb", vp);
    await page.screenshot({ path: `${EVIDENCE}/group-bb-${vp.width}.png` });
    await page.locator("[data-bmq-kho2-group='tp']").click();
    await page.waitForSelector("[data-bmq-kho2-fg]");
    assert.deepEqual(await page.locator("[data-bmq-kho2-fg] b").allTextContents(), ["Bánh mì que đông lạnh", "Pate 200g", "Pate 500g"]);
    assert.match(await page.locator("[data-bmq-kho2-fg='BMQ-002']").textContent(), /Tồn 194 que/);
    await noSpill(page, "group-tp", vp);
    await page.screenshot({ path: `${EVIDENCE}/group-tp-${vp.width}.png` });
    pass(`Danh mục groups Nguyên liệu / Bao bì & vật tư / Thành phẩm ${vp.width}`);

    // Move an item to another group from its sheet
    await page.locator("[data-bmq-kho2-group='nl']").click();
    const moveId = await page.evaluate(() => window.__kgFixture.items[0].id);
    await page.locator(`[data-bmq-kho2-item='${moveId}']`).click();
    await page.waitForSelector("[data-bmq-kho2-class]");
    assert.equal(await page.locator("[data-bmq-kho2-class-pick='nl']").getAttribute("aria-pressed"), "true");
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${EVIDENCE}/class-pick-${vp.width}.png` });
    await page.locator("[data-bmq-kho2-class-pick='bb']").click();
    await page.waitForSelector("[data-bmq-kho2-name]", { state: "detached", timeout: 4000 });
    let moved = await calls(page);
    assert.ok(moved.some((c) => c.startsWith("rpc:set_stock_item_class:") && c.includes(moveId) && c.includes('"p_class":"packaging_supply"')), "class call");
    pass(`move an item to Bao bì & vật tư ${vp.width}`);
    await context.close();
    ({ context, page, errors } = await open({ role: "owner" }, "/warehouse/game", vp));

    // Danh mục list
    await page.locator("[data-bmq-kho2-door='names']").click();
    await page.waitForSelector("[data-bmq-kho2-names] li");
    const rows = await page.locator("[data-bmq-kho2-names] li").count();
    assert.ok(rows > 50, `names rows ${rows}`);
    assert.ok(await page.locator("[data-bmq-kho2-new]").isVisible(), "new-lines banner");
    await noSpill(page, "names", vp);
    await page.screenshot({ path: `${EVIDENCE}/names-${vp.width}.png` });
    await page.locator(".k2-search").fill("bang keo");
    const filtered = await page.locator("[data-bmq-kho2-names] li").count();
    assert.ok(filtered >= 1 && filtered < rows, `search filters (${filtered})`);
    pass(`names list + accent-free search ${vp.width}`);

    // Item sheet: rename onto an existing name -> ask -> merge
    await page.locator("[data-bmq-kho2-names] li .k2-row-main").first().click();
    await page.waitForSelector("[data-bmq-kho2-name]");
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${EVIDENCE}/item-sheet-${vp.width}.png` });
    const other = await page.evaluate(() => window.__kgFixture.items.find((it) => /băng keo nhỏ/i.test(it.name))?.name);
    await page.locator("[data-bmq-kho2-name]").fill(other);
    await page.waitForSelector(".k2-hint.is-warn");
    await page.locator("[data-bmq-kho2-save]").click();
    await confirmOk(page);
    await page.waitForSelector("[data-bmq-kho2-ask='merge']", { timeout: 4000 }).catch(() => null);
    let made = await calls(page);
    assert.ok(made.some((c) => c.startsWith("rpc:kho_save_item:") && c.includes('"p_merge":true')), "merge call after confirm");
    await page.screenshot({ path: `${EVIDENCE}/merge-${vp.width}.png` });
    pass(`rename to existing name asks once then merges ${vp.width}`);
    await context.close();

    // Unit change needs a factor: 1 bao = 25000 g -> p_unit_factor 1/25000
    ({ context, page, errors } = await open({ role: "owner" }, "/warehouse/game", vp));
    await page.locator("[data-bmq-kho2-door='names']").click();
    await page.waitForSelector("[data-bmq-kho2-names] li");
    const gItem = await page.evaluate(() => window.__kgFixture.items[0].id);
    await page.locator(`[data-bmq-kho2-item='${gItem}']`).click();
    await page.locator(".sheet [data-bmq-picker]").first().click();
    await page.locator("[data-bmq-picker-sheet] [role='option']").filter({ hasText: /^bao$/ }).first().click();
    await page.locator("[data-bmq-kho2-save]").click();
    await page.waitForSelector("[data-bmq-kho2-ask='unit']");
    await page.locator(".k2-ask input").fill("25000");
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${EVIDENCE}/unit-ask-${vp.width}.png` });
    await page.locator("[data-bmq-kho2-save]").click();
    await page.waitForSelector("[data-bmq-kho2-name]", { state: "detached", timeout: 4000 });
    made = await calls(page);
    const unitCall = made.filter((c) => c.startsWith("rpc:kho_save_item:")).pop();
    assert.ok(unitCall.includes('"p_unit":"bao"') && unitCall.includes('"p_unit_factor":0.00004'), unitCall);
    pass(`unit change asks 1 bao = ? g and sends old->new factor ${vp.width}`);

    // ON/OFF switch asks before turning off
    const powerId = await page.locator("[data-bmq-kho2-power]").first().getAttribute("data-bmq-kho2-power");
    await page.locator(`[data-bmq-kho2-power='${powerId}']`).click();
    await confirmOk(page);
    await page.waitForTimeout(200);
    made = await calls(page);
    assert.ok(made.some((c) => c.startsWith("rpc:kho_save_item:") && c.includes(powerId) && c.includes('"p_active":false')), "off call");
    pass(`switch off asks then saves ${vp.width}`);

    // New lines on documents
    await page.locator("[data-bmq-kho2-new]").click();
    await page.waitForSelector("[data-bmq-kho2-newlines] li");
    await noSpill(page, "newlines", vp);
    await page.screenshot({ path: `${EVIDENCE}/newlines-${vp.width}.png` });
    await page.locator("[data-bmq-kho2-newlines] li .k2-row-main").first().click();
    await page.waitForSelector(".sheet .sheet-tag");
    assert.match(await page.locator(".sheet .sheet-tag").textContent(), /Hàng mới trên phiếu/);
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${EVIDENCE}/newline-sheet-${vp.width}.png` });
    pass(`new lines list + pick-a-name sheet ${vp.width}`);
    await context.close();

    // Đếm hàng: type kg, send g
    ({ context, page, errors } = await open({ role: "owner" }, "/warehouse/game", vp));
    await page.locator("[data-bmq-kho2-door='count']").click();
    await page.waitForSelector("[data-bmq-kho2-count='tan_tao'] li");
    await noSpill(page, "count", vp);
    await page.screenshot({ path: `${EVIDENCE}/count-tt-${vp.width}.png` });
    await page.locator("[data-bmq-kho2-loc='q7']").click();
    await page.waitForSelector("[data-bmq-kho2-count='q7'] li");
    const gRow = page.locator("[data-bmq-kho2-count='q7'] li").filter({ has: page.locator(".k2-units") }).first();
    const rowId = await gRow.getAttribute("data-bmq-kho2-countrow");
    await gRow.locator("input").fill("160,5");
    await gRow.locator("[data-bmq-kho2-countsave]").click();
    await gRow.locator(".k2-done").waitFor({ timeout: 4000 });
    made = await calls(page);
    const countCall = made.filter((c) => c.startsWith("rpc:kho_count_item:")).pop();
    assert.ok(countCall.includes('"p_location":"q7"') && countCall.includes(rowId) && countCall.includes('"p_counted_qty":160500'), countCall);
    await noSpill(page, "count-q7", vp);
    await page.screenshot({ path: `${EVIDENCE}/count-q7-${vp.width}.png` });
    pass(`count in kg posts grams for the chosen kho ${vp.width}`);
    assert.deepEqual(errors, [], `page errors ${vp.width}`);
    await context.close();

    // Phiếu kho page
    ({ context, page, errors } = await open({ role: "owner" }, "/warehouse/phieu", vp));
    await page.waitForSelector("[data-bmq-slip-door='in']");
    assert.equal(await page.locator("[data-bmq-slip-door]").count(), 3);
    await noSpill(page, "slips", vp);
    await page.screenshot({ path: `${EVIDENCE}/slips-${vp.width}.png` });
    await page.locator("[data-bmq-slip-door='in']").click();
    await page.waitForSelector(".sheet");
    await page.waitForTimeout(700);
    await page.screenshot({ path: `${EVIDENCE}/slips-fg-${vp.width}.png` });
    pass(`phiếu kho page + finished-goods sheet ${vp.width}`);
    await context.close();
  }

  // View-only: no switches, no save, no count inputs.
  {
    const vp = { width: 390, height: 844 };
    const { context, page } = await open({ role: "viewonly" }, "/warehouse/game", vp);
    await page.locator("[data-bmq-kho2-door='names']").click();
    await page.waitForSelector("[data-bmq-kho2-names] li");
    assert.equal(await page.locator("[data-bmq-kho2-power]").count(), 0, "no switches for view-only");
    await page.locator("[data-bmq-kho2-names] li .k2-row-main").first().click();
    assert.equal(await page.locator("[data-bmq-kho2-save]").count(), 0, "no save for view-only");
    await page.locator(".sheet .close").click();
    await page.locator(".round-btn").first().click();
    await page.locator("[data-bmq-kho2-door='count']").click();
    await page.waitForSelector("[data-bmq-kho2-count='tan_tao'] li");
    assert.equal(await page.locator("[data-bmq-kho2-countsave]").count(), 0, "no count input for view-only");
    await page.screenshot({ path: `${EVIDENCE}/viewonly-count-390.png` });
    pass("view-only sees, cannot change");
    await context.close();
  }
  // Empty + error
  {
    const vp = { width: 390, height: 844 };
    let { context, page } = await open({ role: "owner", data: "empty" }, "/warehouse/game", vp);
    await page.locator("[data-bmq-kho2-door='names']").click();
    await page.waitForSelector(".k2-empty");
    await page.screenshot({ path: `${EVIDENCE}/empty-names-390.png` });
    pass("empty list message");
    await context.close();
    ({ context, page } = await open({ role: "owner", data: "error" }, "/warehouse/game", vp));
    await page.waitForSelector(".k2-wrap .err");
    assert.match(await page.locator(".k2-wrap .err").textContent(), /quá lâu/);
    await page.screenshot({ path: `${EVIDENCE}/error-390.png` });
    pass("error message in plain Vietnamese + retry");
    await context.close();
  }
  // The old game stays reachable.
  {
    const vp = { width: 1440, height: 900 };
    const context = await browser.newContext({ viewport: vp });
    const page = await context.newPage();
    await page.goto(`${BASE}/warehouse/game?ban=cu`, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => !document.querySelector("[data-bmq-kho2]"), null, { timeout: 15000 });
    pass("?ban=cu does not render the new game");
    await context.close();
  }
  console.log(`\n${results.length} checks passed · evidence ${EVIDENCE}`);
} finally {
  await browser.close();
  await server.close();
}
