// Browser QA for the CRM "Vị trí đại lý" pin screen (desktop and phone).
//
// FIXTURE AUTH + FIXTURE DATA: AuthContext and the Supabase client are replaced by in-memory
// fixtures. crm_list_dealer_locations answers fixture dealers; crm_set_dealer_location is
// recorded and answered in memory; every other write is refused. Map tiles/Leaflet and Photon
// are stubbed locally (no non-local network). Not real-user acceptance.
//
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core node scripts/qa_dealer_location_pin.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-dealer-pin-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5199);
const { chromium } = createRequire(import.meta.url)(PW);
fs.mkdirSync(EVIDENCE, { recursive: true });
const LEAFLET_DIR = process.env.LEAFLET_DIR || path.join(ROOT, "node_modules", "leaflet", "dist");

const SUPABASE_FIXTURE = `
const cfg = () => JSON.parse(localStorage.getItem("qa-shell") || "{}");
window.__qaWrites = window.__qaWrites || [];
window.__qaRpc = window.__qaRpc || [];
const WRITE = new Set(["insert", "update", "upsert", "delete"]);
const DEALERS = [
  { id: "d1", customer_name: "ĐẠI LÝ NGUYỄN TRÃI", customer_group: "banhmi_agency", address: "723 Nguyễn Trãi, P.11, Q.5", phone: null, location_lat: null, location_lng: null, location_source: null, location_verified_at: null },
  { id: "d2", customer_name: "XESG - BÙI VIỆN", customer_group: "banhmi_point", address: null, phone: null, location_lat: null, location_lng: null, location_source: null, location_verified_at: null },
  { id: "d3", customer_name: "ĐẠI LÝ THÍCH QUẢNG ĐỨC CÓ TÊN RẤT DÀI ĐỂ KIỂM TRA XUỐNG DÒNG", customer_group: "banhmi_agency", address: "120/29/5 Thích Quảng Đức, Phường 4, Phú Nhuận, Phường 04, Quận Phú Nhuận, Hồ Chí Minh", phone: null, location_lat: null, location_lng: null, location_source: null, location_verified_at: null },
  { id: "d4", customer_name: "ĐẠI LÝ VÕ VĂN NGÂN", customer_group: "banhmi_agency", address: "216 Võ Văn Ngân, Thủ Đức", phone: null, location_lat: 10.84987, location_lng: 106.76518, location_source: "manual_pin", location_verified_at: "2026-11-03T03:00:00Z" },
];
function settle(st) {
  if (st.table === "rpc:crm_list_dealer_locations") {
    if (cfg().data === "error") return { data: null, error: { message: "permission_denied" } };
    return { data: DEALERS, error: null };
  }
  if (st.table === "rpc:crm_set_dealer_location") {
    const a = st.args || {};
    window.__qaRpc.push(a);
    const d = DEALERS.find((x) => x.id === a.p_customer_id);
    if (d) { d.location_lat = a.p_clear ? null : a.p_lat; d.location_lng = a.p_clear ? null : a.p_lng; d.location_verified_at = new Date().toISOString(); }
    return { data: { success: true, customer_id: a.p_customer_id, location_lat: d && d.location_lat, location_lng: d && d.location_lng, location_verified_at: d && d.location_verified_at }, error: null };
  }
  if (st.write) { window.__qaWrites.push(st.table + ":" + st.write); return { data: null, error: { message: "QA fixture: writes disabled" }, count: null }; }
  if (st.head) return { data: null, error: null, count: 0 };
  if (st.single) return { data: null, error: null };
  return { data: [], error: null, count: 0 };
}
function builder(table, args) {
  const st = { table, args, filters: {}, head: false, single: false, write: null };
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
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-dealer-pin-qa/vite-cache",
  server: { port: PORT, strictPort: true, host: "127.0.0.1" },
  define: { __APP_VERSION__: JSON.stringify("qa"), __APP_SEMVER__: JSON.stringify("vqa") },
  resolve: { alias: { "@": path.join(ROOT, "src") } },
  plugins: [fixtures, react()],
});
await server.listen();
const BASE = `http://127.0.0.1:${PORT}`;


const PHOTON = { features: [{ properties: { name: "Nguyễn Trãi", street: "Nguyễn Trãi", district: "Chợ Lớn", city: "Thành phố Hồ Chí Minh" }, geometry: { coordinates: [106.6605, 10.7529] } }] };
const TILE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGN49uQ+AAVdAqptSDCZAAAAAElFTkSuQmCC", "base64");

const browser = await chromium.launch({ executablePath: CHROME });
const results = [];
const pass = (name) => { results.push(name); console.log("PASS", name); };

async function open(cfg, viewport) {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce", locale: "vi-VN" });
  await context.addInitScript((value) => localStorage.setItem("qa-shell", JSON.stringify(value)), cfg);
  await context.route("**/*", (r) => {
    const url = r.request().url();
    if (url.startsWith(BASE) || url.startsWith("data:") || url.startsWith("blob:")) return r.continue();
    if (url.includes("unpkg.com/leaflet@1.9.4/dist/leaflet.js")) return r.fulfill({ contentType: "application/javascript", body: fs.readFileSync(path.join(LEAFLET_DIR, "leaflet.js")) });
    if (url.includes("unpkg.com/leaflet@1.9.4/dist/leaflet.css")) return r.fulfill({ contentType: "text/css", body: fs.readFileSync(path.join(LEAFLET_DIR, "leaflet.css")) });
    if (url.includes("tile.openstreetmap.org")) return r.fulfill({ contentType: "image/png", body: TILE });
    if (url.includes("photon.komoot.io")) return r.fulfill({ contentType: "application/json", body: JSON.stringify(PHOTON) });
    return r.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + "/mini-crm", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-bmq-shell='demo3-v1']", { timeout: 30000 });
  await page.getByRole("tab", { name: "Vị trí đại lý" }).click();
  await page.waitForSelector("[data-dealer-location-panel]", { timeout: 15000 });
  await page.waitForTimeout(300);
  return { context, page, errors };
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const WIDTHS = [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }];

try {
  for (const viewport of WIDTHS) {
    const { context, page, errors } = await open({ role: "owner" }, viewport);
    assert.equal(await page.locator("[data-dealer-location-row]").count(), 3, "missing filter lists 3 unpinned dealers first");
    assert.ok((await page.locator("[data-dealer-location-panel]").innerText()).includes("Còn 3/4 đại lý chưa ghim"));
    assert.ok(await overflow(page) <= 0, `no horizontal overflow ${viewport.width}`);
    await page.screenshot({ path: path.join(EVIDENCE, `list-${viewport.width}.png`), fullPage: false });
    pass(`list ${viewport.width}`);

    await page.locator("[data-dealer-location-open='d1']").click();
    await page.waitForSelector("[data-dealer-location-dialog] .leaflet-container", { timeout: 15000 });
    await page.waitForTimeout(600);
    assert.equal(await page.locator("[data-dealer-location-save]").isDisabled(), true, "save disabled before a pin is chosen");
    await page.fill("#dealer-pin-paste", "https://www.google.com/maps/place/BMQ/@10.752870,106.660490,17z");
    await page.getByRole("button", { name: "Dùng" }).click();
    assert.ok((await page.locator("[data-dealer-location-point]").innerText()).includes("10.752870, 106.660490"));
    const box = await page.locator("[data-dealer-location-dialog]").boundingBox();
    assert.ok(box.width <= viewport.width && box.x >= 0, `dialog fits ${viewport.width}`);
    assert.ok(await overflow(page) <= 0, `no overflow with dialog ${viewport.width}`);
    await page.screenshot({ path: path.join(EVIDENCE, `dialog-${viewport.width}.png`), fullPage: false });
    await page.locator("[data-dealer-location-save]").click();
    await page.waitForSelector("[data-dealer-location-dialog]", { state: "detached", timeout: 10000 });
    const sent = await page.evaluate(() => window.__qaRpc[window.__qaRpc.length - 1]);
    assert.equal(sent.p_customer_id, "d1");
    assert.equal(sent.p_source, "maps_link");
    assert.equal(sent.p_clear, false);
    assert.ok(typeof sent.p_request_id === "string" && sent.p_request_id.length > 8, "retry key sent");
    await page.waitForTimeout(300);
    assert.equal(await page.locator("[data-dealer-location-row]").count(), 2, "pinned dealer leaves the missing list");
    pass(`pin via maps link ${viewport.width}`);

    await page.locator("[data-dealer-location-filter='pinned']").click();
    await page.locator("[data-dealer-location-open='d4']").click();
    await page.waitForSelector("[data-dealer-location-dialog] .leaflet-container", { timeout: 15000 });
    assert.equal(await page.locator("[data-dealer-location-save]").isDisabled(), true, "unchanged saved pin cannot be re-saved");
    await page.getByRole("button", { name: "Xóa vị trí" }).click();
    await page.getByRole("button", { name: "Xóa vị trí" }).last().click();
    await page.waitForSelector("[data-dealer-location-dialog]", { state: "detached", timeout: 10000 });
    assert.equal((await page.evaluate(() => window.__qaRpc[window.__qaRpc.length - 1])).p_clear, true);
    pass(`clear needs confirmation ${viewport.width}`);

    assert.deepEqual(await page.evaluate(() => window.__qaWrites), [], "no table writes");
    assert.deepEqual(errors, [], `page errors ${viewport.width}`);
    await context.close();
  }
  {
    const { context, page, errors } = await open({ role: "owner", data: "error" }, { width: 390, height: 844 });
    assert.ok((await page.locator("[data-dealer-location-panel], body").first().innerText()).length > 0);
    assert.ok((await page.locator("body").innerText()).includes("Anh/chị không có quyền ghim vị trí đại lý."));
    assert.deepEqual(errors, []);
    pass("permission error state");
    await context.close();
  }
  console.log(JSON.stringify({ ok: true, passed: results.length }));
} finally {
  await browser.close();
  await server.close();
}
