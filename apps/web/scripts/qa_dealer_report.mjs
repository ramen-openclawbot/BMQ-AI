// QA for Báo cáo đặt hàng (dathang → Đơn hàng → Báo cáo): retail + NPP layouts, history tab intact,
// lock (423) on the report kicks the dealer out. Report payloads come from REPORT_FIXTURE_DIR
// (report-npp.json / report-retail.json, shaped like dealer-report responses); never committed.
//
// FIXTURE AUTH + FIXTURE DATA: AuthContext and the Supabase client are replaced by in-memory
// fixtures. The payment-unc-approve edge function is mocked (OCR results and errors are
// scripted); every other write is refused and recorded, and all non-local network is blocked.
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
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-dealer-report-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5211);
const { chromium } = createRequire(import.meta.url)(PW);
fs.mkdirSync(EVIDENCE, { recursive: true });

const SUPABASE_FIXTURE = `
const cfg = () => JSON.parse(localStorage.getItem("qa-shell") || "{}");
window.__qaWrites = window.__qaWrites || [];
window.__qaBodies = window.__qaBodies || [];
const WRITE = new Set(["insert", "update", "upsert", "delete"]);
const READ_RPCS = new Set(["rpc:finance_unc_total_from_evidence", "rpc:finance_daily_snapshot", "rpc:get_payment_submission"]);
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
const pr = (id, number, supplierId, supplierName, amount, status = "pending", unpaid = false, hour = "02") => ({
  id, request_number: number, title: "Thanh toán " + supplierName, total_amount: amount, vat_amount: 0,
  status, payment_status: status === "approved" && !unpaid ? "paid" : "unpaid", payment_method: "bank_transfer",
  delivery_status: "pending", created_at: today + "T" + hour + ":00:00.000Z", created_by: "acc-user",
  supplier_id: supplierId, suppliers: { id: supplierId, name: supplierName },
  payment_request_items: [{ id: id + "-i", product_name: "Bột mì số 13", raw_product_name: null }],
  payment_allocations: status === "approved" && !unpaid ? [{ id: id + "-a", amount, payment_id: "p1", created_at: today }] : [],
  goods_receipts: null, purchase_orders: { id: "po-" + id, po_number: "PO-" + number, status: "approved" },
  invoices: null, invoice_created: false, image_url: null, notes: null, approved_by: null, approved_at: null,
  rejection_reason: null, goods_receipt_id: null, purchase_order_id: "po-" + id, invoice_id: null,
});
const PRS = [
  pr("11111111-1111-4111-8111-111111111111", "DC-0101", "sup-a", "Bột Mì Sài Gòn", 13500000),
  pr("22222222-2222-4222-8222-222222222222", "DC-0102", "sup-a", "Bột Mì Sài Gòn", 6250000),
  pr("33333333-3333-4333-8333-333333333333", "DC-0103", "sup-b", "Công ty TNHH Thực Phẩm Tươi Sống Miền Nam chi nhánh Bình Tân", 31750000),
  pr("44444444-4444-4444-8444-444444444444", "DC-0099", "sup-a", "Bột Mì Sài Gòn", 8000000, "approved"),
  pr("55555555-5555-4555-8555-555555555551", "DC-0096", "sup-t", "Thiên An Sinh", 10732500, "approved", true, "00"),
  pr("55555555-5555-4555-8555-555555555552", "DC-0097", "sup-t", "Thiên An Sinh", 10732500, "approved", true, "01"),
  pr("55555555-5555-4555-8555-555555555553", "DC-0098", "sup-t", "Thiên An Sinh", 11131500, "approved", true, "02"),
  pr("55555555-5555-4555-8555-555555555554", "DC-0104", "sup-t", "Thiên An Sinh", 11131500, "pending", false, "03"),
  pr("55555555-5555-4555-8555-555555555555", "DC-0105", "sup-t", "Thiên An Sinh", 2607720, "pending", false, "04"),
];
const UNPAID = Array.from({ length: 23 }, (_, i) => {
  const r = pr("88888888-8888-4888-8888-" + String(100000000000 + i).slice(1), "PR-U" + String(i + 1).padStart(3, "0"), i % 3 === 0 ? "sup-t" : "sup-a", i % 3 === 0 ? "Thiên An Sinh" : "Bột Mì Sài Gòn", 1000000 * (i + 1), i % 4 === 0 ? "approved" : "pending", true, "02");
  r.created_at = new Date(Date.now() - i * 3 * 86400000).toISOString();
  return r;
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const edgeError = (status, code) => ({
  data: null,
  error: { message: "Edge Function returned a non-2xx status code", context: new Response(JSON.stringify({ success: false, code, error: code }), { status }) },
});
function settle(st) {
  if (st.table === "rpc:set_dealer_order_lock") {
    window.__qaBodies.push({ name: "set_dealer_order_lock", ...(st.args || {}) });
    return { data: { customer_id: st.args?.p_customer_id, order_locked: !!st.args?.p_locked, revoked_sessions: st.args?.p_locked ? 2 : 0 }, error: null };
  }
  if (st.table.startsWith("rpc:")) return { data: null, error: null };
  if (st.write) { window.__qaWrites.push(st.table + ":" + st.write); return { data: null, error: { message: "QA fixture: writes disabled" }, count: null }; }
  if (st.head) return { data: null, error: null, count: 0 };
  if (st.single) return { data: null, error: null };
  if (st.table === "mini_crm_customers") return { data: CUSTOMERS, error: null, count: CUSTOMERS.length };
  return { data: [], error: null, count: 0 };
}
const CUSTOMERS = [
  { id: "cus-open", customer_name: "Đại lý Hồng Phát", customer_code: "DL-001", customer_group: "dealer", product_group: "banh_mi", is_active: true, is_npp: false, order_locked: false, address: "12 Lê Lợi", debt_emails: [], npp_management_fee_vnd: 0, mini_crm_customer_emails: [], dealer_customer_contacts: [{ id: "ct1", customer_id: "cus-open", contact_name: "Chị Hồng", phone_normalized: "84901234567", is_active: true, is_primary: true, is_test: false }] },
  { id: "cus-locked", customer_name: "Đại lý Minh Châu", customer_code: "DL-002", customer_group: "dealer", product_group: "banh_mi", is_active: true, is_npp: false, order_locked: true, order_locked_at: new Date(Date.now() - 3600000).toISOString(), order_lock_reason: "Nợ quá hạn tháng 9", address: "5 Hai Bà Trưng", debt_emails: [], npp_management_fee_vnd: 0, mini_crm_customer_emails: [], dealer_customer_contacts: [] },
];
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
        if (prop === "range") st.range = [a[0], a[1]];
        if (prop === "in" && a[0] === "supplier_id") st.supplierIds = a[1];
        if (prop === "or") st.or = a[0];
        if (prop === "gte") st.gte = a[1];
        if (prop === "single" || prop === "maybeSingle") st.single = true;
        return proxy;
      };
    },
  });
  return proxy;
}
async function invoke(name, options) {
  const body = options?.body || {};
  window.__qaBodies.push({ name, ...body });
  const c = cfg();
  if (name === "dealer-auth-start") {
    if (c.dealer === "locked") return { data: { otp_required: false, reason: "dealer_order_locked", code: "dealer_order_locked", message: "Đặt Hàng đang tạm khoá. Quý khách hàng vui lòng thanh toán công nợ để mở lại. Trân trọng." }, error: null };
    return { data: { otp_required: true, message: "Mã OTP đã được gửi qua Zalo." }, error: null };
  }
  return { data: null, error: { message: "QA fixture: functions disabled" } };
}
const user = { id: "qa-user", email: "qa@bmq.test", user_metadata: {} };
const channel = { on() { return channel; }, subscribe() { return channel; }, unsubscribe() {} };
export const supabase = {
  from: (table) => builder(table),
  rpc: (fn, args) => builder("rpc:" + fn, args),
  schema: () => ({ from: (table) => builder(table), rpc: (fn, args) => builder("rpc:" + fn, args) }),
  functions: { invoke },
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


const FIX = process.env.REPORT_FIXTURE_DIR;
assert.ok(FIX, "REPORT_FIXTURE_DIR is required");
const REPORTS = { npp: fs.readFileSync(path.join(FIX, "report-npp.json"), "utf8"), retail: fs.readFileSync(path.join(FIX, "report-retail.json"), "utf8") };
const server = await createServer({
  root: ROOT, configFile: false, logLevel: "error",
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-dealer-report-qa/vite-cache",
  server: { port: PORT, strictPort: true, host: "127.0.0.1" },
  define: { "import.meta.env.VITE_SUPABASE_URL": JSON.stringify("https://qa.supabase.test"), "import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY": JSON.stringify("qa-anon"), __APP_VERSION__: JSON.stringify("qa"), __APP_SEMVER__: JSON.stringify("vqa") },
  resolve: { alias: { "@": path.join(ROOT, "src") } },
  plugins: [fixtures, react()],
});
await server.listen();
const BASE = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({ executablePath: CHROME });
const LOCK_MSG = "Đặt Hàng đang tạm khoá. Quý khách hàng vui lòng thanh toán công nợ để mở lại. Trân trọng.";
const results = [];
const record = (name) => { results.push(name); console.log("PASS", name); };

async function open(kind, viewport, reportMode = "ok") {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce", locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" });
  await context.addInitScript(() => { localStorage.setItem("bmq_dealer_session_token", "dop_qa"); localStorage.setItem("qa-shell", "{}"); });
  const calls = [];
  await context.route("**/*", (r) => {
    const url = r.request().url();
    if (url.startsWith("https://qa.supabase.test/functions/v1/")) {
      const fn = url.split("/functions/v1/")[1].split("?")[0];
      let body = {};
      try { body = JSON.parse(r.request().postData() || "{}"); } catch {}
      calls.push({ fn, body });
      if (fn === "dealer-report") {
        if (reportMode === "locked") return r.fulfill({ status: 423, contentType: "application/json", body: JSON.stringify({ error: LOCK_MSG, code: "dealer_order_locked" }) });
        return r.fulfill({ status: 200, contentType: "application/json", body: REPORTS[kind] });
      }
      if (fn === "dealer-catalog") return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, customer: { id: "cus-qa", customer_name: kind === "npp" ? "Đại lý cấp 1 - QA NPP" : "Đại lý QA Lẻ", is_npp: kind === "npp", is_active: true }, products: [], announcements: [], dealer_routes: [] }) });
      if (fn === "dealer-order-history") return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, orders: [], summary: { order_count: 0, total_physical_quantity: 0, total_amount_vnd: 0 }, pagination: { page: 1, total_pages: 1, total: 0 } }) });
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, ok: true }) });
    }
    if (url.startsWith(BASE) || url.startsWith("data:") || url.startsWith("blob:") || /fonts\.(googleapis|gstatic)\.com/.test(url)) return r.continue();
    return r.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + "/dealer", { waitUntil: "domcontentloaded" });
  await page.locator("[data-dealer-agent-nav] button", { hasText: "Đơn hàng" }).first().click({ timeout: 30000 });
  await page.waitForSelector("[data-dealer-agent-screen='orders']");
  return { context, page, errors, calls };
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);

try {
  for (const kind of ["npp", "retail"]) {
    const expected = JSON.parse(REPORTS[kind]).report;
    for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 700 }, { width: 1280, height: 860 }, { width: 391, height: 3400 }, { width: 1281, height: 2000 }]) {
      const { context, page, errors, calls } = await open(kind, viewport);
      assert.equal(await page.locator("[data-dealer-order-history-filter]").count(), 1, "history is the default tab");
      await page.locator("[data-dealer-report-tab]").click();
      await page.waitForSelector("[data-dealer-report] .dealer-report-kpi--hero");
      const hero = await page.locator(".dealer-report-kpi--hero strong").textContent();
      assert.equal(hero.replace(/\D/g, ""), String(expected.summary.quantity), "hero quantity");
      assert.equal(await page.locator(".dealer-report-chart-col").count(), expected.daily.length, "one bar per day");
      assert.equal(await page.locator("[data-dealer-report-points]").count(), kind === "npp" ? 1 : 0, "points only for NPP");
      if (kind === "npp") assert.equal(await page.locator(".dealer-report-points li").count(), expected.points.length);
      else assert.equal(await page.locator(".dealer-report-weekdays li").count(), 7);
      const call = calls.find((c) => c.fn === "dealer-report");
      assert.equal(call.body.dealer_token, "dop_qa");
      assert.match(call.body.month, /^\d{4}-\d{2}$/);
      assert.ok((await overflow(page)) <= 0, "no horizontal overflow");
      const small = await page.evaluate(() => [...document.querySelectorAll("[data-dealer-report] button, .dealer-orders-view-tabs button")].filter((b) => b.getBoundingClientRect().height < 44).length);
      assert.equal(small, 0, "tap targets >= 44px");
      await page.screenshot({ path: `${EVIDENCE}/report-${kind}-${viewport.width}.png`, fullPage: true });
      await page.locator(".dealer-report-periods button", { hasText: "Tháng trước" }).click();
      await page.waitForTimeout(300);
      assert.ok(calls.filter((c) => c.fn === "dealer-report").length >= 2, "month change refetches");
      await page.locator(".dealer-orders-view-tabs button", { hasText: "Lịch sử" }).click();
      assert.equal(await page.locator("[data-dealer-order-history-filter]").count(), 1, "history tab returns");
      assert.deepEqual(errors, []);
      record(`report ${kind} ${viewport.width}`);
      await context.close();
    }
  }
  {
    const { context, page, errors } = await open("retail", { width: 390, height: 844 }, "locked");
    await page.locator("[data-dealer-report-tab]").click();
    const notice = page.locator("[data-bmq-dealer-order-locked]").first();
    await notice.waitFor({ timeout: 20000 });
    assert.equal((await notice.textContent()).trim(), LOCK_MSG);
    assert.equal(await page.evaluate(() => localStorage.getItem("bmq_dealer_session_token")), null, "session cleared");
    assert.deepEqual(errors, []);
    record("report locked kicks dealer out");
    await context.close();
  }
  console.log(`${results.length}/${results.length} PASS · evidence ${EVIDENCE}`);
} finally {
  await browser.close();
  await server.close();
}
