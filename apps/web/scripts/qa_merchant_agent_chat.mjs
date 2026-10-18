// QA for the owner's merchant-agent chat (Anthropic merchant agent behind bmq-agent.vnagent.ai).
//
// FIXTURE AUTH + FIXTURE DATA: AuthContext and the Supabase client are in-memory fixtures and
// the merchant agent API is answered by scripted routes; all other non-local network is blocked.
// It proves the real widget renders and wires replies, cards, drafts and approvals; it is not
// a real Claude turn and never touches real records.
//
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome node scripts/qa_merchant_agent_chat.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-merchant-chat-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5213);
const AGENT = "https://bmq-agent.vnagent.ai";
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
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-merchant-chat-qa/vite-cache",
  server: { port: PORT, strictPort: true, host: "127.0.0.1" },
  define: { "import.meta.env.VITE_SUPABASE_URL": JSON.stringify("https://qa.supabase.test"), "import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY": JSON.stringify("qa-anon"), __APP_VERSION__: JSON.stringify("qa"), __APP_SEMVER__: JSON.stringify("vqa") },
  resolve: { alias: { "@": path.join(ROOT, "src") } },
  plugins: [fixtures, react()],
});
await server.listen();
const BASE = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({ executablePath: CHROME });
const results = [];
const record = (name) => { results.push({ name }); console.log("PASS", name); };

const CHANGE = { change_id: "chg-1", kind: "campaign", status: "staged", summary: "Thông báo: đặt từ 300 que tặng 1 hộp pate", items: [{ target: "Đặt 300 que tặng 1 hộp pate", field: "name", after: "Đặt 300 que tặng 1 hộp pate (20/10 – 26/10)" }] };
function reply(body) {
  const text = String(body.message || "");
  if (text.includes("lỗi máy chủ")) return { status: 503, json: { detail: "Trợ lý quản trị đang không phản hồi." } };
  if (text.includes("thông báo")) return { status: 200, json: { session_id: "s-1", text: "Em đã soạn bản nháp thông báo, anh xem và bấm Duyệt nếu đồng ý.", tool_calls: ["mcp__merchant__stage_campaign"], ui: [{ component: "change_preview", payload: { change_id: "chg-1", change: CHANGE, headline: "Thông báo khuyến mãi tuần 20/10", note: "Chưa có gì được gửi." } }, { component: "suggestions", payload: { suggestions: ["Rút gọn nội dung", "Đổi thời gian áp dụng"] } }], pending_changes: [CHANGE] } };
  if (text.includes("vấn đề")) return { status: 200, json: { session_id: "s-1", text: "Hôm nay có 3 việc cần chú ý.", tool_calls: [], ui: [{ component: "digest", payload: { title: "Đơn đại lý hôm nay", items: [{ kind: "order_issue", headline: "Đại lý Lê Văn Lương chưa có đơn giao hôm nay", why_it_matters: "Đã đặt 5/7 ngày gần đây." }, { kind: "order_issue", headline: "Đại lý Hồng Lạc đang bị khoá đặt hàng" }] } }], pending_changes: [] } };
  return { status: 200, json: { session_id: "s-1", text: "Doanh thu tháng 9 đạt 979,5 triệu, Đại lý chiếm 46%.", tool_calls: ["mcp__merchant__query_metrics"], ui: [{ component: "metrics", payload: { title: "Doanh thu tháng 9", period: "2026-09", metrics: [{ metric: "sales", value: 979545347, change_pct: 4.2, currency: "VND" }, { metric: "orders", value: 385, change_pct: -2.1 }, { metric: "revenue", series: { metric: "revenue", unit: "VND", segment: "channel:ĐẠI LÝ", points: Array.from({ length: 30 }, (_, i) => ({ date: `2026-09-${String(i + 1).padStart(2, "0")}`, value: 12000000 + (i % 7) * 900000 })) }, note: "Kênh lớn nhất" }] } }, { component: "suggestions", payload: { suggestions: ["So với tháng 8", "Chi tiết kênh Bánh ngọt"] } }], pending_changes: [] } };
}

async function open(viewport) {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce", locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" });
  await context.addInitScript(() => localStorage.setItem("qa-shell", JSON.stringify({ role: "owner" })));
  const calls = [];
  await context.route("**/*", async (r) => {
    const url = r.request().url();
    if (url.startsWith(AGENT)) {
      const method = r.request().method();
      if (method === "OPTIONS") return r.fulfill({ status: 204, headers: { "access-control-allow-origin": BASE, "access-control-allow-headers": "authorization,content-type", "access-control-allow-methods": "POST,GET,OPTIONS" } });
      const headers = { "access-control-allow-origin": BASE, "content-type": "application/json" };
      const pathName = new URL(url).pathname;
      const body = r.request().postDataJSON?.() || {};
      calls.push({ path: pathName, body, auth: r.request().headers()["authorization"] });
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (pathName === "/v1/chat") { const answer = reply(body); return r.fulfill({ status: answer.status, headers, body: JSON.stringify(answer.json) }); }
      if (pathName.endsWith("/approve")) return r.fulfill({ status: 200, headers, body: JSON.stringify({ ...CHANGE, status: "applied" }) });
      if (pathName.endsWith("/discard")) return r.fulfill({ status: 200, headers, body: JSON.stringify({ ...CHANGE, status: "discarded" }) });
      return r.fulfill({ status: 404, headers, body: "{}" });
    }
    if (url.startsWith(BASE) || url.startsWith("data:") || url.startsWith("blob:") || /fonts\.(googleapis|gstatic)\.com/.test(url)) return r.continue();
    return r.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + "/mini-crm", { waitUntil: "domcontentloaded" });
  await page.locator("[data-merchant-agent-launcher]").waitFor({ timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  return { context, page, errors, calls };
}

const panel = (page) => page.locator("[data-merchant-agent-chat]");
const overflow = (page) => page.evaluate(() => { const el = document.querySelector("[data-merchant-agent-chat]"); return el ? el.scrollWidth - el.clientWidth : 0; });
async function ask(page, text) {
  await page.getByLabel("Tin nhắn cho trợ lý quản trị").fill(text);
  await page.locator("[data-merchant-send]").click();
}

try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 640 }, { width: 1440, height: 900 }]) {
    const tag = viewport.width;
    const { context, page, errors, calls } = await open(viewport);
    await page.locator("[data-merchant-agent-launcher]").click();
    await panel(page).waitFor();
    assert.equal(await page.locator("[data-merchant-starter]").count(), 4);
    assert.ok((await panel(page).textContent()).includes("bấm Duyệt mới áp"));
    await page.screenshot({ path: `${EVIDENCE}/empty-${tag}.png` });

    await page.locator("[data-merchant-starter]").nth(1).click();
    await page.locator("[data-merchant-ui='metrics']").waitFor({ timeout: 10000 });
    assert.equal(calls[0].path, "/v1/chat");
    assert.equal(calls[0].auth, "Bearer qa-fixture-token", "sends the Supabase session token");
    assert.equal(calls[0].body.page, "/mini-crm");
    assert.equal(calls[0].body.session_id, undefined, "first turn opens a new session");
    const metricsText = await page.locator("[data-merchant-ui='metrics']").textContent();
    assert.ok(metricsText.includes("979,5 triệu") && metricsText.includes("+4,2%") && metricsText.includes("ĐẠI LÝ"), metricsText);
    assert.equal(await page.locator("[data-merchant-suggestion]").count(), 2);
    assert.ok(await overflow(page) <= 0, `no overflow ${tag}`);
    await page.screenshot({ path: `${EVIDENCE}/metrics-${tag}.png` });
    record(`metrics reply ${tag}`);

    await page.locator("[data-merchant-suggestion]").first().click();
    await page.waitForFunction(() => document.querySelectorAll("[data-merchant-message='agent']").length >= 2);
    assert.equal(calls[1].body.session_id, "s-1", "follow-up keeps the session");
    record(`suggestion chip continues the session ${tag}`);

    await ask(page, "Hôm nay đơn đại lý có vấn đề gì?");
    await page.locator("[data-merchant-ui='digest']").waitFor();
    assert.ok((await page.locator("[data-merchant-ui='digest']").textContent()).includes("Lê Văn Lương"));
    record(`digest card ${tag}`);

    await ask(page, "Soạn thông báo khuyến mãi tuần này");
    const card = page.locator("[data-merchant-change='chg-1']");
    await card.waitFor();
    assert.equal(await card.getAttribute("data-merchant-change-status"), "staged");
    assert.ok((await card.textContent()).includes("Thông báo dathang"));
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${EVIDENCE}/draft-${tag}.png` });
    assert.equal(calls.filter((c) => c.path.includes("/approve")).length, 0, "nothing approved before the tap");
    await card.locator("[data-merchant-change-action='approve']").click();
    await page.locator("[data-merchant-change='chg-1'][data-merchant-change-status='applied']").waitFor();
    assert.equal(await card.locator("[data-merchant-change-action]").count(), 0, "buttons gone after apply");
    assert.ok(calls.some((c) => c.path === "/v1/changes/chg-1/approve"));
    await page.screenshot({ path: `${EVIDENCE}/applied-${tag}.png` });
    record(`draft approve applies ${tag}`);

    await ask(page, "lỗi máy chủ thử");
    await page.locator("[data-merchant-message='error']").waitFor();
    assert.ok((await page.locator("[data-merchant-message='error']").textContent()).includes("không phản hồi"));
    assert.ok(await page.getByLabel("Tin nhắn cho trợ lý quản trị").isEnabled(), "composer usable after an error");
    record(`server error shown ${tag}`);

    await page.locator("[data-merchant-agent-reset]").click();
    assert.equal(await page.locator("[data-merchant-message]").count(), 0);
    assert.equal(await page.locator("[data-merchant-starter]").count(), 4);
    record(`reset clears the conversation ${tag}`);
    assert.ok(await overflow(page) <= 0);
    assert.deepEqual(errors, []);
    await context.close();
  }
} finally {
  fs.writeFileSync(`${EVIDENCE}/qa-merchant-chat.json`, JSON.stringify({ results }, null, 2));
  await browser.close();
  await server.close();
}
console.log(`ALL ${results.length} MERCHANT CHAT QA CHECKS PASSED — evidence in ${EVIDENCE}`);
