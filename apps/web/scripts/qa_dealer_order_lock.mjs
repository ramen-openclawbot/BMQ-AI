// QA for Khoá đặt hàng: CRM lock card + badges, and the dealer portal lock message / kick of an open session.
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
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-dealer-lock-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5207);
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

const server = await createServer({
  root: ROOT,
  configFile: false,
  logLevel: "error",
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-dealer-lock-qa/vite-cache",
  server: { port: PORT, strictPort: true, host: "127.0.0.1" },
  define: { "import.meta.env.VITE_SUPABASE_URL": JSON.stringify("https://qa.supabase.test"), "import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY": JSON.stringify("qa-anon"), __APP_VERSION__: JSON.stringify("qa"), __APP_SEMVER__: JSON.stringify("vqa") },
  resolve: { alias: { "@": path.join(ROOT, "src") } },
  plugins: [fixtures, react()],
});
await server.listen();
const BASE = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({ executablePath: CHROME });
const results = [];
const edgeCalls = [];
const LOCK_MSG = "Đặt Hàng đang tạm khoá. Quý khách hàng vui lòng thanh toán công nợ để mở lại. Trân trọng.";
const record = (name) => { results.push({ name }); console.log("PASS", name); };

async function open(cfg, route, viewport, waitFor = "[data-bmq-shell='demo3-v1']") {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce", locale: cfg.locale || "vi-VN", ...(cfg.tz ? { timezoneId: cfg.tz } : {}) });
  await context.addInitScript((value) => localStorage.setItem("qa-shell", JSON.stringify(value)), cfg);
  await context.route("**/*", (r) => {
    const url = r.request().url();
    if (url.startsWith("https://qa.supabase.test/functions/v1/")) {
      const fn = url.split("/functions/v1/")[1].split("?")[0];
      edgeCalls.push(fn);
      if (cfg.edge === "locked" && fn !== "dealer-public-config") return r.fulfill({ status: 423, contentType: "application/json", body: JSON.stringify({ error: LOCK_MSG, code: "dealer_order_locked" }) });
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(fn === "dealer-catalog" ? { success: true, customer: { id: "cus-open", customer_name: "Đại lý Hồng Phát" }, products: [], announcements: [], dealer_routes: [] } : { success: true, ok: true }) });
    }
    if (url.startsWith(BASE) || url.startsWith("data:") || url.startsWith("blob:") || /fonts\.(googleapis|gstatic)\.com/.test(url)) return r.continue();
    return r.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + route, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(waitFor, { timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  return { context, page, errors };
}

const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const bodies = (page) => page.evaluate(() => window.__qaBodies);

try {
  // 1. CRM: locked dealer carries a badge; edit dialog shows the lock card; locking calls the RPC.
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const { context, page, errors } = await open({ role: "owner" }, "/mini-crm", viewport);
    await page.locator("text=Đại lý Minh Châu >> visible=true").first().waitFor({ timeout: 20000 });
    assert.ok(await page.locator("[data-bmq-crm-order-locked] >> visible=true").count() >= 1, "locked badge in the list");
    await page.screenshot({ path: `${EVIDENCE}/crm-list-${viewport.width}.png` });
    await page.locator("text=Đại lý Hồng Phát >> visible=true").first().click();
    await page.getByRole("button", { name: /Sửa khách hàng/ }).click();
    const card = page.locator("[data-bmq-dealer-order-lock]");
    await card.waitFor();
    assert.equal(await card.getAttribute("data-bmq-dealer-order-lock"), "open");
    await card.scrollIntoViewIfNeeded();
    await page.locator("[data-bmq-dealer-order-lock-open]").click();
    await page.getByLabel("Lý do khoá đặt hàng").fill("Nợ quá hạn 30 ngày");
    await page.waitForTimeout(200);
    await card.screenshot({ path: `${EVIDENCE}/crm-lock-confirm-${viewport.width}.png` });
    await page.locator("[data-bmq-dealer-order-lock-submit]").click();
    await page.getByText("Đã khoá đặt hàng").first().waitFor();
    const call = (await bodies(page)).filter((b) => b.name === "set_dealer_order_lock").pop();
    assert.deepEqual([call.p_customer_id, call.p_locked, call.p_reason], ["cus-open", true, "Nợ quá hạn 30 ngày"]);
    assert.ok((await page.getByText("Đã đăng xuất 2 phiên").count()) >= 1, "toast reports revoked sessions");
    assert.ok(await overflow(page) <= 0, `no overflow ${viewport.width}`);
    assert.deepEqual(errors, []);
    record(`CRM lock card + RPC ${viewport.width}`);
    await context.close();
  }

  // 2. CRM: a locked dealer shows the reason and an unlock button.
  {
    const { context, page, errors } = await open({ role: "owner" }, "/mini-crm", { width: 1440, height: 900 });
    await page.locator("text=Đại lý Minh Châu >> visible=true").first().click();
    await page.getByRole("button", { name: /Sửa khách hàng/ }).click();
    const card = page.locator("[data-bmq-dealer-order-lock='locked']");
    await card.waitFor();
    assert.ok((await card.textContent()).includes("Nợ quá hạn tháng 9"));
    await card.scrollIntoViewIfNeeded();
    await card.screenshot({ path: `${EVIDENCE}/crm-locked-card.png` });
    await page.locator("[data-bmq-dealer-order-unlock]").click();
    await page.getByText("Đã mở khoá đặt hàng").first().waitFor();
    const call = (await bodies(page)).filter((b) => b.name === "set_dealer_order_lock").pop();
    assert.deepEqual([call.p_customer_id, call.p_locked, call.p_reason], ["cus-locked", false, null]);
    assert.deepEqual(errors, []);
    record("CRM unlock");
    await context.close();
  }

  // 3. Dealer portal: a locked phone gets the owner message and no OTP step.
  for (const viewport of [{ width: 390, height: 844 }, { width: 1280, height: 800 }]) {
    const { context, page, errors } = await open({ dealer: "locked" }, "/dealer", viewport, "text=Gửi mã OTP Zalo");
    await page.locator("input[type=tel], input[inputmode=tel]").first().fill("0901234567");
    await page.getByRole("button", { name: /Gửi mã OTP Zalo/ }).first().click();
    const notice = page.locator("[data-bmq-dealer-order-locked]").first();
    await notice.waitFor();
    assert.equal((await notice.textContent()).trim(), LOCK_MSG);
    assert.equal(await page.locator("input[autocomplete='one-time-code'], input[inputmode='numeric'][maxlength='6']").count(), 0, "no OTP input");
    await page.screenshot({ path: `${EVIDENCE}/dealer-locked-${viewport.width}.png` });
    await page.locator("input[type=tel], input[inputmode=tel]").first().fill("0901234568");
    assert.equal(await page.locator("[data-bmq-dealer-order-locked]").count(), 0, "message clears when the phone changes");
    assert.deepEqual(errors, []);
    record(`dealer locked login ${viewport.width}`);
    await context.close();
  }

  // 4. Dealer portal: an already logged-in dealer is kicked back to login with the message.
  {
    const { context, page, errors } = await open({ edge: "locked" }, "/dealer", { width: 390, height: 844 }, "body");
    await page.evaluate(() => { localStorage.setItem("bmq_dealer_session_token", "dop_qa"); });
    await page.reload({ waitUntil: "domcontentloaded" });
    const notice = page.locator("[data-bmq-dealer-order-locked]").first();
    await notice.waitFor({ timeout: 20000 });
    assert.equal((await notice.textContent()).trim(), LOCK_MSG);
    assert.equal(await page.evaluate(() => localStorage.getItem("bmq_dealer_session_token")), null, "session cleared");
    assert.ok(await page.getByRole("button", { name: /Gửi mã OTP Zalo/ }).first().isVisible(), "back on the phone step");
    await page.screenshot({ path: `${EVIDENCE}/dealer-kicked-390.png` });
    assert.deepEqual(errors, []);
    record("dealer open session kicked on lock");
    await context.close();
  }

  // 5. Dealer portal: an unlocked dealer still gets the OTP step.
  {
    const { context, page, errors } = await open({}, "/dealer", { width: 390, height: 844 }, "text=Gửi mã OTP Zalo");
    await page.locator("input[type=tel], input[inputmode=tel]").first().fill("0901234567");
    await page.getByRole("button", { name: /Gửi mã OTP Zalo/ }).first().click();
    await page.waitForTimeout(800);
    assert.equal(await page.locator("[data-bmq-dealer-order-locked]").count(), 0);
    assert.deepEqual(errors, []);
    record("unlocked dealer unaffected");
    await context.close();
  }
} finally {
  fs.writeFileSync(`${EVIDENCE}/qa-dealer-lock.json`, JSON.stringify({ results, edgeCalls }, null, 2));
  await browser.close();
  await server.close();
}
console.log(`ALL ${results.length} DEALER ORDER LOCK QA CHECKS PASSED — evidence in ${EVIDENCE}`);
