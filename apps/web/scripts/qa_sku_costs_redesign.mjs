// Browser QA for the giá vốn redesign (Tổng quan / Xu hướng / Quản trị SKU), desktop and phone.
// Cost leads the overview, one tab row, rows open the SKU, no horizontal overflow, launcher clears
// the last content, populated / empty / error states; full-content screenshots of each page.
//
// FIXTURE AUTH + FIXTURE DATA: AuthContext and the Supabase client are replaced by in-memory
// fixtures; every write is refused and recorded, and all non-local network is blocked. This
// proves the real shell/page components render and navigate; it is not real-user acceptance.
//
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome node scripts/qa_sku_costs_redesign.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-sku-costs-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5203);
const { chromium } = createRequire(import.meta.url)(PW);
fs.mkdirSync(EVIDENCE, { recursive: true });

const SUPABASE_FIXTURE = `
const cfg = () => JSON.parse(localStorage.getItem("qa-shell") || "{}");
window.__qaWrites = window.__qaWrites || [];
const WRITE = new Set(["insert", "update", "upsert", "delete"]);
function settle(st) {
  const mode = cfg().data || "populated";
  if (st.write) { window.__qaWrites.push(st.table + ":" + st.write); return { data: null, error: { message: "QA fixture: writes disabled" }, count: null }; }
  if (mode === "error" && st.table === "product_skus") return { data: null, error: { message: "QA fixture: network error", code: "QA" }, count: null };
  if (st.head) return { data: null, error: null, count: 0 };
  if (st.single) return { data: null, error: null };
  const rows = mode === "populated" ? fixtureRows(st) : null;
  if (rows) return { data: rows, error: null, count: rows.length };
  return { data: [], error: null, count: 0 };
}
const month = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date()).slice(0, 7);
const SKUS = [
  ["BMQ-001", "Bánh mì que pate", 15000, 7800],
  ["BMQ-002", "Bánh mì que chà bông", 18000, 10400],
  ["BMQ-003", "Bánh mì que bò kho", 25000, 16900],
  ["BMQ-004", "Bánh mì que xíu mại", 20000, 21500],
  ["BMQ-005", "Bánh mì que phô mai", 16000, 0],
  ["BMQ-006", "Bánh mì que gà xé cay", 17000, 9100],
  ["BMQ-007", "Pate gan nhà làm hũ 500g dành cho đại lý và nhà phân phối khu vực miền Nam", 85000, 52000],
  ["BMQ-008", "Bánh mì que trứng muối", 0, 8200],
  ["BMQ-009", "Bánh mì que xá xíu", 18000, 11300],
  ["BMQ-010", "Bánh mì que cá ngừ", 0, 0],
  ["BMQ-011", "Bơ trứng nhà làm hũ 250g", 45000, 21000],
  ["BMQ-012", "Đồ chua túi 1kg", 30000, 12000],
  ["BMQ-013", "Bánh croissant bơ", 0, 0],
  ["BMQ-014", "Bánh su kem", 12000, 0],
  ["BMQ-015", "Bánh flan", 10000, 4100],
  ["BMQ-016", "Bánh mì que đặc biệt", 22000, 13800],
];
function fixtureRows(st) {
  if (st.table === "product_skus") return SKUS.map(([code, name, price, cost], i) => ({
    id: "sku-" + (i + 1), sku_code: code, product_name: name, category: "Thành phẩm", sku_type: "finished_good",
    unit: i === 6 || i === 10 ? "hũ" : "cái", unit_price: price, hide_from_dealer_portal: i % 5 === 4,
    updated_at: new Date(Date.now() - i * 3600e3).toISOString(), created_at: "2026-05-01T00:00:00Z",
    cost_values: { selling_price: price, material_cost: cost }, cost_widgets: {}, cost_template: null,
    finished_output_qty: 100, finished_output_unit: "cái",
    image_url: i % 3 === 2 ? null : "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#e9d9b8"/><rect x="12" y="30" width="56" height="20" rx="10" fill="#c98a3a"/></svg>'),
  }));
  if (st.table === "sku_formulations") return [
    ["NVL-BOT-MI", "Bột mì số 13", "g", 18, 2400],
    ["NVL-PATE", "Pate gan", "g", 120, 900],
    ["NVL-BO", "Bơ lạt", "g", 210, 300],
    ["NVL-DUONG", "Đường tinh luyện", "g", 22, 150],
    ["NVL-MUOI", "Muối sấy", "g", 9, 40],
  ].map(([material_code, ingredient_name, unit, unit_price, dosage_qty], i) => ({ id: "f" + i, sku_id: "sku-2", ingredient_sku_id: null, material_code, ingredient_name, unit, unit_price, dosage_qty, wastage_percent: 0, sort_order: i }));
  if (st.table === "payment_request_items") return [
    { sku_id: null, product_name: "Bột mì số 13", product_code: "NVL-BOT-MI", unit: "g", quantity: 25000, unit_price: 19, line_total: 475000, created_at: month + "-05T03:00:00Z", confirmed_standard_cost_code: "NVL-BOT-MI", payment_requests: { request_number: "PR-1", payment_status: "paid", status: "approved", paid_at: month + "-05T03:00:00Z" } },
    { sku_id: null, product_name: "Bột mì số 13", product_code: "NVL-BOT-MI", unit: "g", quantity: 25000, unit_price: 20, line_total: 500000, created_at: month + "-12T03:00:00Z", confirmed_standard_cost_code: "NVL-BOT-MI", payment_requests: { request_number: "PR-2", payment_status: "paid", status: "approved", paid_at: month + "-12T03:00:00Z" } },
    { sku_id: null, product_name: "Pate gan", product_code: "NVL-PATE", unit: "g", quantity: 5000, unit_price: 131, line_total: 655000, created_at: month + "-12T03:00:00Z", confirmed_standard_cost_code: "NVL-PATE", payment_requests: { request_number: "PR-3", payment_status: "paid", status: "approved", paid_at: month + "-12T03:00:00Z" } },
    { sku_id: null, product_name: "Bơ lạt", product_code: "NVL-BO", unit: "g", quantity: 1000, unit_price: 520, line_total: 520000, created_at: month + "-15T03:00:00Z", confirmed_standard_cost_code: "NVL-BO", payment_requests: { request_number: "PR-4", payment_status: "paid", status: "approved", paid_at: month + "-15T03:00:00Z" } },
  ];
  if (st.table === "sku_cogs_versions") return [{ id: "v1", version_no: 2, effective_from: "2026-10-01", effective_to: null, change_reason: "Cập nhật giá bột mì", created_at: "2026-10-01T02:00:00Z" }];
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
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-sku-costs-qa/vite-cache",
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
const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
  { width: 320, height: 640 },
];
const ROUTES = ["/sku-costs/dashboard", "/sku-costs/analysis", "/sku-costs/management"];

async function fullShot(page, file) {
  await page.addStyleTag({ content: ".d3-app{height:auto!important}.d3-main{overflow:visible!important}" });
  await page.waitForTimeout(150);
  await page.screenshot({ path: file, fullPage: true });
}

// Scroll the shell's own scroller to the end and check the floating launcher clears the last content.
async function launcherClearance(page) {
  return page.evaluate(async () => {
    const main = document.querySelector(".d3-main");
    if (main) main.scrollTop = main.scrollHeight;
    await new Promise((r) => setTimeout(r, 200));
    const launcher = document.querySelector("[data-vnagent-launcher]");
    const last = [...document.querySelectorAll(".gv > *")].pop();
    if (!launcher || !last) return { skipped: true };
    const l = launcher.getBoundingClientRect();
    const b = last.getBoundingClientRect().bottom;
    return { launcherTop: l.top, contentBottom: b, ok: b <= l.top + 1 || l.right < last.getBoundingClientRect().left };
  });
}

const tabRows = (page) => page.evaluate(() => document.querySelectorAll(".d3-screen nav[aria-label='Giá vốn']").length);
const spill = (page) => page.evaluate(() => {
  const panel = document.querySelector(".d3-screen").getBoundingClientRect();
  return [...document.querySelectorAll(".gv *")].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.right > panel.right + 1 && !el.closest(".gv-table-wrap,.gv-tabs,.recharts-wrapper"); }).map((el) => String(el.className).slice(0, 40) + " | " + (el.textContent || "").trim().slice(0, 30)).slice(0, 5);
});

try {
  for (const viewport of WIDTHS) {
    for (const route of ROUTES) {
      const { context, page, errors } = await open({ role: "owner", data: "populated" }, route, viewport);
      await page.waitForSelector(".gv h1", { timeout: 20000 });
      await page.waitForTimeout(900);
      if (route.endsWith("analysis")) {
        await page.getByRole("button", { name: "Chạy phân tích" }).click();
        await page.waitForSelector(".gv-kpis", { timeout: 10000 });
        await page.waitForTimeout(500);
      }
      assert.equal(await tabRows(page), 1, `one tab row @${route} ${viewport.width}`);
      assert.deepEqual(await spill(page), [], `nothing spills @${route} ${viewport.width}`);
      const ov = await overflow(page);
      assert.ok(ov <= 0, `no overflow @${route} ${viewport.width}: ${ov}`);
      if (route.endsWith("dashboard")) {
        const kpis = await page.$$eval(".gv-kpi-label", (els) => els.map((e) => e.textContent));
        assert.deepEqual(kpis.slice(0, 2), ["Giá vốn TB", "LC TB"], "cost leads the overview");
        const rows = await page.$$eval(".gv-row", (els) => els.map((e) => e.querySelector(".gv-name b").textContent));
        assert.equal(rows.length, 16);
        assert.equal(rows[0], "Bánh mì que xíu mại", "lowest LC first (cost above price)");
        // Phone rows: the three figures stay on one line under the name, inside the row.
        if (viewport.width <= 640) {
          const geo = await page.$$eval(".gv-row", (els) => els.map((row) => {
            const r = row.getBoundingClientRect();
            return [...row.querySelectorAll(".gv-fig,.gv-lc")].map((f) => { const b = f.getBoundingClientRect(); return { inside: b.left >= r.left - 1 && b.right <= r.right + 1, top: Math.round(b.top) }; });
          }));
          for (const figs of geo) {
            assert.ok(figs.every((f) => f.inside), `figures inside row @${viewport.width}`);
            assert.equal(new Set(figs.map((f) => f.top)).size, 1, `figures on one line @${viewport.width}`);
          }
        }
        const clear = await launcherClearance(page);
        assert.ok(clear.skipped || clear.ok, `launcher clears last content @${viewport.width}: ${JSON.stringify(clear)}`);
      }
      await fullShot(page, `${EVIDENCE}/${route.split("/").pop()}-${viewport.width}.png`);
      assert.deepEqual(errors, [], `page errors @${route}`);
      record(`${route} ${viewport.width}`);
      await context.close();
    }
  }

  // Interactions on the overview: filter, sort, search, row opens detail, thumb opens upload dialog.
  {
    const { context, page, errors } = await open({ role: "owner", data: "populated" }, "/sku-costs/dashboard", { width: 390, height: 844 });
    await page.waitForSelector(".gv-row");
    await page.getByRole("button", { name: /Thiếu dữ liệu/ }).click();
    assert.equal(await page.locator(".gv-row").count(), 5, "missing filter: 5 SKUs lack price or cost");
    await page.getByRole("button", { name: "Tất cả", exact: true }).click();
    await page.getByRole("button", { name: "Giá bán cao", exact: true }).click();
    assert.equal(await page.locator(".gv-row .gv-name b").first().textContent(), "Pate gan nhà làm hũ 500g dành cho đại lý và nhà phân phối khu vực miền Nam");
    await page.getByLabel("Tìm SKU").fill("zzz");
    await page.waitForSelector(".gv-empty");
    await fullShot(page, `${EVIDENCE}/dashboard-search-empty-390.png`);
    await page.getByLabel("Tìm SKU").fill("");
    await page.getByRole("button", { name: "Cập nhật ảnh Bánh mì que pate" }).click();
    await page.waitForSelector("[role='dialog']");
    assert.ok(await page.getByText("Cập nhật ảnh SKU").isVisible());
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "Xem chi tiết Bánh mì que chà bông" }).click();
    await page.waitForURL(/sku-costs\/management\?sku=sku-2/);
    assert.deepEqual(errors, []);
    assert.deepEqual(await page.evaluate(() => window.__qaWrites), [], "no writes from browsing");
    record("dashboard interactions 390");
    await context.close();
  }

  // Xu hướng for a SKU with no formula says so instead of an empty table.
  {
    const { context, page, errors } = await open({ role: "owner", data: "populated" }, "/sku-costs/analysis", { width: 1280, height: 800 });
    await page.waitForSelector(".gv h1");
    await page.waitForTimeout(800);
    await page.locator(".gv-controls [role='combobox']").click();
    await page.getByRole("option", { name: /Bánh flan/ }).click();
    await page.getByRole("button", { name: "Chạy phân tích" }).click();
    await page.waitForSelector("text=SKU này chưa có công thức NVL");
    await fullShot(page, `${EVIDENCE}/analysis-no-formula-1280.png`);
    assert.deepEqual(errors, []);
    record("analysis no-formula 1280");
    await context.close();
  }

  // Empty and error states.
  for (const data of ["empty", "error"]) {
    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 844 }]) {
      const { context, page, errors } = await open({ role: "owner", data }, "/sku-costs/dashboard", viewport);
      await page.waitForSelector(".gv-empty", { timeout: 15000 });
      if (data === "error") assert.ok(await page.locator(".gv-notice[role='alert']").isVisible(), "load error shown on the page");
      assert.ok((await overflow(page)) <= 0);
      await fullShot(page, `${EVIDENCE}/dashboard-${data}-${viewport.width}.png`);
      assert.deepEqual(errors, []);
      record(`dashboard ${data} ${viewport.width}`);
      await context.close();
    }
  }

  // Management: row opens the detail dialog; Sửa opens the edit dialog.
  {
    const { context, page, errors } = await open({ role: "owner", data: "populated" }, "/sku-costs/management", { width: 390, height: 844 });
    await page.waitForSelector(".gv-row");
    await page.getByRole("button", { name: "Xem chi tiết Bánh mì que pate" }).click();
    await page.waitForSelector("text=Chi tiết SKU");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await page.locator(".gv-row").first().getByRole("button", { name: "Sửa" }).click();
    await page.waitForSelector("text=Sửa SKU");
    assert.deepEqual(errors, []);
    record("management dialogs 390");
    await context.close();
  }
} finally {
  fs.writeFileSync(`${EVIDENCE}/qa-sku-costs.json`, JSON.stringify(results, null, 2));
  await browser.close();
  await server.close();
}
console.log(`ALL ${results.length} SKU COST QA CHECKS PASSED — evidence in ${EVIDENCE}`);
