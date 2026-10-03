// Browser QA for Demo 3 stage 3: Duyệt chi master–detail, payment confirmations, reject errors, Kho pages.
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
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-demo3-stage3-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5197);
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
function fixtureRows(st) {
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
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-demo3-stage3-qa/vite-cache",
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

try {
  // 1. Wide desktop: detail opens as a pane beside the list and switches between rows.
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 800 }]) {
    const { context, page, errors } = await open({ role: "owner", data: "populated" }, "/payment-requests", viewport);
    await prRows(page).first().waitFor({ timeout: 15000 });
    await prRows(page).nth(0).click();
    const panel = page.locator("[data-bmq-payment-detail='panel']");
    await panel.waitFor();
    await page.waitForFunction(() => document.querySelector("[data-bmq-payment-detail='panel']")?.textContent?.includes("DC-QA-"));
    assert.equal(await page.locator("[data-bmq-payment-detail-pane='open']").count(), 1, "page reserves room for the pane");
    const pBox = await panel.boundingBox();
    const table = await page.locator("table").first().boundingBox();
    assert.ok(table.x + table.width <= pBox.x + 1, `list stays visible left of the pane @${viewport.width}: table ends ${table.x + table.width}, pane ${pBox.x}`);
    assert.ok(pBox.x + pBox.width <= viewport.width, "pane inside viewport");
    const firstNumber = await panel.textContent();
    await prRows(page).nth(1).click();
    await page.waitForTimeout(400);
    assert.equal(await panel.count(), 1, "clicking another row keeps the pane open");
    assert.notEqual(await panel.textContent(), firstNumber, "pane switches to the clicked request");
    assert.equal(await page.locator("tr[aria-current='true']").count(), 1, "active row marked");
    assert.equal(await page.locator("[role='dialog'][data-state='open']").count(), 1);
    assert.ok((await overflow(page)) <= 0, "no page overflow");
    await page.screenshot({ path: `${EVIDENCE}/payments-pane-${viewport.width}.png` });
    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "detached" });
    assert.equal(await page.locator("[data-bmq-payment-detail-pane='open']").count(), 0, "list widens again after close");
    assert.deepEqual(errors, []);
    record(`master-detail ${viewport.width}`);
    await context.close();
  }

  // 2. Mobile keeps the full-screen dialog.
  {
    const { context, page, errors } = await open({ role: "owner", data: "populated" }, "/payment-requests", { width: 390, height: 844 });
    // The card's first button is its checkbox; open the detail through the card body.
    await page.locator("[data-stitch-card='mobile-payment-request']").first().locator("button.block").click();
    await page.locator("[data-bmq-payment-detail='dialog']").waitFor();
    await page.waitForTimeout(400);
    assert.ok((await overflow(page)) <= 0);
    await page.screenshot({ path: `${EVIDENCE}/payments-mobile-detail-390.png` });
    assert.deepEqual(errors, []);
    record("mobile detail dialog");
    await context.close();
  }

  // 3. "Đã chi" needs confirmation; cancelling writes nothing.
  {
    const { context, page, errors } = await open({ role: "owner", data: "populated" }, "/payment-requests", { width: 1440, height: 900 });
    await prRows(page).first().waitFor();
    const approvedRow = page.locator("table tbody tr", { hasText: "DC-QA-003" });
    await approvedRow.locator("button[role='checkbox']").click();
    await page.getByRole("button", { name: /Đánh dấu đã TT|Mark as Paid/ }).first().click();
    const confirm = page.locator("[role='alertdialog']");
    await confirm.waitFor();
    const text = await confirm.textContent();
    assert.ok(text.includes("1 phiếu") && text.includes("4.600.000"), `confirm shows count and amount: ${text}`);
    await page.screenshot({ path: `${EVIDENCE}/payments-paid-confirm-1440.png` });
    await page.getByRole("button", { name: /Huỷ|Hủy|Cancel/ }).click();
    await confirm.waitFor({ state: "detached" });
    assert.deepEqual(await page.evaluate(() => window.__qaWrites), [], "cancel recorded nothing");
    assert.deepEqual(errors, []);
    record("bulk paid confirmation");
    await context.close();
  }

  // 4. Reject failure from the server is explained, the dialog stays open.
  {
    const { context, page, errors } = await open({ role: "owner", data: "populated", rejectError: "invalid_status" }, "/payment-requests", { width: 1440, height: 900 });
    await page.locator("table tbody tr", { hasText: "DC-QA-001" }).click();
    const panel = page.locator("[data-bmq-payment-detail='panel']");
    await panel.waitFor();
    await panel.getByRole("button", { name: "Từ chối" }).click();
    await page.getByPlaceholder("Lý do từ chối...").fill("Sai đơn giá");
    await page.locator("[role='alertdialog']").getByRole("button", { name: /Từ chối/ }).click();
    await page.getByText("không còn ở trạng thái chờ duyệt").waitFor({ timeout: 5000 });
    await page.screenshot({ path: `${EVIDENCE}/payments-reject-error-1440.png` });
    assert.deepEqual(errors, []);
    record("reject error explained");
    await context.close();
  }

  // 5. Payables row "đã trả" asks first.
  {
    const { context, page, errors } = await open({ role: "owner", data: "populated" }, "/finance-control/payables", { width: 1440, height: 900 });
    await page.waitForTimeout(1200);
    const btn = page.locator("table tbody tr", { hasText: "DC-QA-003" }).getByRole("button").last();
    await btn.click();
    const confirm = page.locator("[role='alertdialog']");
    if (await confirm.count()) {
      assert.ok((await confirm.textContent()).includes("DC-QA-003"), "payables confirm names the request");
      await page.getByRole("button", { name: "Huỷ" }).click();
      record("payables paid confirmation");
    } else {
      // Row's last button may open detail instead; use the explicit paid button text.
      await page.keyboard.press("Escape");
      const paid = page.locator("table tbody tr", { hasText: "DC-QA-003" }).locator("button", { hasText: /trả|thanh toán/i }).first();
      await paid.click();
      await confirm.waitFor();
      assert.ok((await confirm.textContent()).includes("DC-QA-003"));
      await page.getByRole("button", { name: "Huỷ" }).click();
      record("payables paid confirmation");
    }
    assert.deepEqual(await page.evaluate(() => window.__qaWrites), []);
    assert.deepEqual(errors, []);
    await context.close();
  }

  // 6. Kho pages render in the theme; low-stock buttons lead to purchase orders.
  for (const route of ["/inventory", "/warehouse/tan-tao", "/kitchen-inventory", "/goods-receipts", "/warehouse/dispatch", "/warehouse/stock-report", "/low-stock", "/purchase-orders"]) {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const { context, page, errors } = await open({ role: "owner", data: "populated" }, route, viewport);
      await page.waitForTimeout(1200);
      assert.equal(await activeTab(page), "Kho", `Kho zone active @${route}`);
      const ov = await overflow(page);
      assert.ok(ov <= 0, `no overflow @${route} ${viewport.width}: ${ov}`);
      if (route === "/low-stock" && viewport.width === 1440) {
        await page.getByRole("button", { name: "Đặt mua" }).first().click();
        await page.waitForURL(BASE + "/purchase-orders");
      }
      await page.screenshot({ path: `${EVIDENCE}/kho-${route.replace(/\//g, "_")}-${viewport.width}.png`, fullPage: true });
      assert.deepEqual(errors, [], `page errors @${route}`);
      record(`kho ${route} ${viewport.width}`);
      await context.close();
    }
  }
} finally {
  fs.writeFileSync(`${EVIDENCE}/qa-demo3-stage3.json`, JSON.stringify(results, null, 2));
  await browser.close();
  await server.close();
}
console.log(`ALL ${results.length} STAGE 3 QA CHECKS PASSED — evidence in ${EVIDENCE}`);
