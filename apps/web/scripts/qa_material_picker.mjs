// QA for the searchable NVL picker (Tạo SKU) and the "Tạo NVL mới" button in Quản trị NVL chuẩn.
//
// FIXTURE AUTH + FIXTURE DATA: AuthContext and the Supabase client are replaced by in-memory
// fixtures. Every write is refused and recorded, and all non-local network is blocked.
// This proves the real page components and flows render and wire correctly; it is not
// real-user acceptance and never touches real records.
//
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome node scripts/qa_unc_approval.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-material-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5199);
const { chromium } = createRequire(import.meta.url)(PW);
fs.mkdirSync(EVIDENCE, { recursive: true });

const SUPABASE_FIXTURE = `
window.__qaWrites = window.__qaWrites || [];
const WRITE = new Set(["insert", "update", "upsert", "delete"]);
const SKU = { id: "sku-1", sku_code: "BM-01", product_name: "Bánh mì que", category: "Thành phẩm", sku_type: "finished", unit: "cái", unit_price: 0, finished_output_qty: 100, finished_output_unit: "cái", cost_values: {}, cost_widgets: {}, cost_template: null };
const mk = (id, code, name) => ({ id, material_code: code, canonical_name: name, default_unit: "g", ingredient_sku_id: null, active: true, version: 1, category: null, brand: null, specification: null, approved: true });
const MATERIALS = [
  mk("m1", "NVL-BANH-MI-TUOI", "Bánh mì tươi"),
  mk("m2", "NVL-PHAN-TICH-MAU-PATE", "Phân tích mẫu pate"),
  mk("m3", "NVL-MUOI", "Muối"),
  mk("m4", "NVL-DUONG-CAT", "Đường cát trắng"),
];
function settle(st) {
  if (st.write || st.table.startsWith("rpc:")) { window.__qaWrites.push(st.table + ":" + (st.write || "rpc")); window.__qaRpc = window.__qaRpc || []; window.__qaRpc.push({ name: st.table, args: st.args }); return { data: null, error: { message: "QA fixture: writes disabled" } }; }
  if (st.head) return { data: null, error: null, count: 0 };
  if (st.single) return { data: null, error: null };
  if (st.table === "product_skus") return { data: [SKU], error: null, count: 1 };
  if (st.offset > 0) return { data: [], error: null, count: 0 };
  if (st.table === "sku_cogs_materials") return { data: MATERIALS, error: null, count: 4 };
  return { data: [], error: null, count: 0 };
}
function builder(table, args) {
  const st = { table, args, filters: {}, head: false, single: false, write: null };
  const proxy = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return (ok, ko) => Promise.resolve(settle(st)).then(ok, ko);
      if (prop === "catch") return (ko) => Promise.resolve(settle(st)).catch(ko);
      if (prop === "finally") return (fn) => Promise.resolve(settle(st)).finally(fn);
      return (...a) => {
        if (WRITE.has(prop)) st.write = prop;
        if (prop === "select" && a[1] && a[1].head) st.head = true;
        if (prop === "eq") st.filters[a[0]] = a[1];
        if (prop === "range") st.offset = a[0];
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
  functions: { invoke: async () => ({ data: null, error: { message: "QA fixture: functions disabled" } }) },
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
const MODULES = { owner: null, accountant: ["dashboard", "payment_requests", "goods_receipts", "suppliers", "finance_cost"] }[role];
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
  name: "qa-unc-fixtures",
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
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-unc-approval-qa/vite-cache",
  server: { port: PORT, strictPort: true, host: "127.0.0.1" },
  define: { __APP_VERSION__: JSON.stringify("qa"), __APP_SEMVER__: JSON.stringify("vqa") },
  resolve: { alias: { "@": path.join(ROOT, "src") } },
  plugins: [fixtures, react()],
});
await server.listen();
const BASE = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({ executablePath: CHROME });
const results = [];
const record = (name) => { results.push({ name }); console.log("PASS", name); };

async function open(viewport) {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce", locale: "vi-VN" });
  await context.addInitScript((value) => localStorage.setItem("qa-shell", JSON.stringify(value)), { role: "owner" });
  await context.route("**/*", (r) => {
    const url = r.request().url();
    if (url.startsWith(BASE) || url.startsWith("data:") || url.startsWith("blob:") || /fonts\.(googleapis|gstatic)\.com/.test(url)) return r.continue();
    return r.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + "/sku-costs/management", { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-bmq-shell='demo3-v1']", { timeout: 30000 });
  await page.waitForTimeout(500);
  return { context, page, errors };
}

const WIDTHS = [{ width: 1440, height: 900 }, { width: 390, height: 844 }];
try {
  // 1. Searchable picker in Tạo SKU (desktop table + mobile card).
  for (const viewport of WIDTHS) {
    const { context, page, errors } = await open(viewport);
    await page.getByRole("button", { name: "Tạo SKU" }).first().click();
    await page.getByRole("button", { name: "+ Thêm NVL cấp 1" }).click();
    const trigger = page.locator("[data-bmq-material-picker]:visible").first();
    assert.ok((await trigger.textContent()).includes("Chọn NVL đã khai báo"));
    await trigger.click();
    const search = page.locator("[data-bmq-material-picker-search]");
    await search.waitFor();
    assert.equal(await page.getByRole("option").count(), 4, "all declared NVL listed");
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${EVIDENCE}/picker-open-${viewport.width}.png` });

    await search.fill("pate mau");
    assert.equal(await page.getByRole("option").count(), 1, "multi-word search");
    await search.fill("duong cat");
    assert.equal(await page.getByRole("option").count(), 1, "no diacritics needed");
    assert.ok((await page.getByRole("option").first().textContent()).includes("NVL-DUONG-CAT"));
    await search.fill("khong co nvl nay");
    assert.equal(await page.getByRole("option").count(), 0);
    assert.equal(await page.locator("[data-bmq-material-picker-create]").count(), 1, "empty state links to NVL admin");
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${EVIDENCE}/picker-empty-${viewport.width}.png` });

    await search.fill("banh mi");
    await page.getByRole("option", { name: /NVL-BANH-MI-TUOI/ }).click();
    assert.ok((await trigger.textContent()).includes("NVL-BANH-MI-TUOI - Bánh mì tươi"), "selection shows on the trigger");
    await page.screenshot({ path: `${EVIDENCE}/picker-selected-${viewport.width}.png` });
    // Re-opening shows the checked item and all NVL again.
    await trigger.click();
    await page.locator("[data-bmq-material-picker-search]").waitFor();
    assert.equal(await page.getByRole("option").count(), 4);
    await page.keyboard.press("Escape");
    assert.deepEqual(errors, [], `page errors ${viewport.width}`);
    record(`searchable NVL picker ${viewport.width}`);
    await context.close();
  }

  // 2. Quản trị NVL chuẩn: owner sees "Tạo NVL mới", the form submits create_canonical_material.
  for (const viewport of WIDTHS) {
    const context = await browser.newContext({ viewport, reducedMotion: "reduce", locale: "vi-VN" });
    await context.addInitScript((value) => localStorage.setItem("qa-shell", JSON.stringify(value)), { role: "owner" });
    await context.route("**/*", (r) => {
      const url = r.request().url();
      if (url.startsWith(BASE) || url.startsWith("data:") || url.startsWith("blob:") || /fonts\.(googleapis|gstatic)\.com/.test(url)) return r.continue();
      return r.abort();
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(BASE + "/material-master", { waitUntil: "domcontentloaded" });
    try {
      await page.waitForSelector("[data-bmq-material-create-open]", { timeout: 15000 });
    } catch (e) {
      console.log("URL", page.url());
      console.log((await page.locator("body").innerText()).slice(0, 600));
      await page.screenshot({ path: `${EVIDENCE}/mm-failure-${viewport.width}.png` });
      throw e;
    }
    await page.screenshot({ path: `${EVIDENCE}/mm-create-button-${viewport.width}.png` });
    await page.locator("[data-bmq-material-create-open]").click();
    const dialog = page.locator("[data-bmq-material-create-dialog]");
    await dialog.waitFor();
    const submit = dialog.getByRole("button", { name: "Tạo NVL" });
    assert.ok(await submit.isDisabled(), "needs a reason");
    await dialog.getByPlaceholder(/Mã NVL|mã/i).first().fill("NVL-QA-MOI").catch(() => {});
    const inputs = dialog.locator("input");
    await inputs.nth(1).fill("Bột QA mới");
    await inputs.nth(2).fill("g");
    await dialog.locator("textarea").fill("QA: thêm NVL mới cho công thức");
    assert.ok(await submit.isEnabled(), "enabled with reason");
    assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, "no page overflow");
    await dialog.screenshot({ path: `${EVIDENCE}/mm-create-dialog-${viewport.width}.png` });
    await submit.click();
    await page.waitForTimeout(600);
    const calls = await page.evaluate(() => window.__qaRpc || []);
    const call = calls.find((c) => c.name === "rpc:create_canonical_material");
    assert.ok(call, "calls create_canonical_material");
    assert.equal(call.args.p_canonical_name, "Bột QA mới");
    assert.equal(call.args.p_default_unit, "g");
    assert.equal(call.args.p_reason, "QA: thêm NVL mới cho công thức");
    assert.deepEqual(errors, [], `page errors ${viewport.width}`);
    record(`material master create NVL ${viewport.width}`);
    await context.close();
  }
} finally {
  fs.writeFileSync(`${EVIDENCE}/qa-material.json`, JSON.stringify(results, null, 2));
  await browser.close();
  await server.close();
}
console.log(`ALL ${results.length} MATERIAL QA CHECKS PASSED — evidence in ${EVIDENCE}`);
