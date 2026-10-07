// QA for the read-only "Chứng từ thanh toán" section in the Duyệt chi detail (UNC image, amount for this request, other requests paid by the same UNC).
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
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-unc-evidence-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5200);
const { chromium } = createRequire(import.meta.url)(PW);
fs.mkdirSync(EVIDENCE, { recursive: true });

const SUPABASE_FIXTURE = `
const cfg = () => JSON.parse(localStorage.getItem("qa-shell") || "{}");
window.__qaWrites = window.__qaWrites || [];
window.__qaBodies = window.__qaBodies || [];
const WRITE = new Set(["insert", "update", "upsert", "delete"]);
const READ_RPCS = new Set(["rpc:finance_unc_total_from_evidence", "rpc:finance_daily_snapshot", "rpc:get_payment_request_unc_evidence"]);
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
  pr("66666666-6666-4666-8666-666666666666", "DC-0095", "sup-t", "Thiên An Sinh", 2883280, "approved"),
  pr("55555555-5555-4555-8555-555555555551", "DC-0096", "sup-t", "Thiên An Sinh", 10732500, "approved", true, "00"),
  pr("55555555-5555-4555-8555-555555555552", "DC-0097", "sup-t", "Thiên An Sinh", 10732500, "approved", true, "01"),
  pr("55555555-5555-4555-8555-555555555553", "DC-0098", "sup-t", "Thiên An Sinh", 11131500, "approved", true, "02"),
  pr("55555555-5555-4555-8555-555555555554", "DC-0104", "sup-t", "Thiên An Sinh", 11131500, "pending", false, "03"),
  pr("55555555-5555-4555-8555-555555555555", "DC-0105", "sup-t", "Thiên An Sinh", 2607720, "pending", false, "04"),
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const edgeError = (status, code) => ({
  data: null,
  error: { message: "Edge Function returned a non-2xx status code", context: new Response(JSON.stringify({ success: false, code, error: code }), { status }) },
});
function settle(st) {
  if (st.table === "rpc:get_payment_request_unc_evidence") {
    const c = cfg();
    if (c.evidence === "error") return { data: null, error: { message: "QA fixture: boom" } };
    const id = st.args?.p_request_id;
    if (id === "44444444-4444-4444-8444-444444444444") return { data: c.evidence === "none" ? [] : [{
      payment_id: "pay-1", payment_number: "PAY-000150", payment_date: today, payment_total: 35204220, allocated_to_request: 8000000,
      reference_number: "6084337381", evidence: { storage_path: "payment-unc/2026/10/aaa.jpg", transfer_date: today, ocr_amount: 35204220, manual_override: true, override_reason: "UNC gồm 2.607.720 chưa có phiếu", category: "khac" },
      siblings: [{ request_id: "55555555-5555-4555-8555-555555555551", request_number: "DC-0096", amount: 10732500 }, { request_id: "55555555-5555-4555-8555-555555555552", request_number: "DC-0097", amount: 10732500 }, { request_id: "55555555-5555-4555-8555-555555555553", request_number: "DC-0098", amount: 5731220 }] }], error: null };
    if (id === "66666666-6666-4666-8666-666666666666") return { data: [{ payment_id: "pay-2", payment_number: "PAY-000148", payment_date: "2026-09-14", payment_total: 2883280, allocated_to_request: 2883280, reference_number: null, evidence: null, siblings: [] }], error: null };
    return { data: [], error: null };
  }
  if (st.table === "rpc:finance_unc_total_from_evidence") return { data: { transfer_date: st.args?.p_date, total_amount: 19750000, evidence_count: 2 }, error: null };
  if (st.table.startsWith("rpc:") && !READ_RPCS.has(st.table)) { window.__qaWrites.push(st.table); return { data: null, error: { message: "QA fixture: writes disabled" } }; }
  if (st.write) { window.__qaWrites.push(st.table + ":" + st.write); return { data: null, error: { message: "QA fixture: writes disabled" }, count: null }; }
  if (st.head) return { data: null, error: null, count: st.table === "payment_requests" ? 3 : 0 };
  if (st.single) {
    if (st.table === "payment_requests") return { data: PRS.find((r) => r.id === st.filters.id) || null, error: null };
    return { data: null, error: null };
  }
  if (st.table === "payment_requests") return { data: PRS, error: null, count: PRS.length };
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
        if (prop === "single" || prop === "maybeSingle") st.single = true;
        return proxy;
      };
    },
  });
  return proxy;
}
async function invoke(name, options) {
  const body = options?.body || {};
  window.__qaWrites.push("invoke:" + name + ":" + (body.mode || ""));
  window.__qaBodies.push({ name, ...body, image_base64: body.image_base64 ? "<" + body.image_base64.length + " chars>" : undefined });
  const c = cfg();
  if (name !== "payment-unc-approve") return { data: null, error: { message: "QA fixture: functions disabled" } };
  if (body.mode === "extract") {
    await sleep(400);
    if (c.ocr === "fail") return edgeError(502, "ocr_failed");
    return { data: { success: true, mode: "extract", file_sha256: "a".repeat(64), storage_path: "payment-unc/2026/10/a.jpg",
      suggested_idempotency_key: "unc:" + "a".repeat(64),
      ocr: { amount: c.ocrAmount ?? 13500000, amount_raw: null, amount_in_words: null, reference: "FT26279123456",
        transfer_date: today, confidence: c.confidence ?? 0.97, amount_corrected_from_words: false } }, error: null };
  }
  if (body.mode === "confirm") {
    await sleep(300);
    if (c.confirmError) return edgeError(409, c.confirmError);
    return { data: { success: true, mode: "confirm", result: { status: "approved", payment_id: "pay-1", payment_request_ids: body.request_ids, amount: 0, idempotent: false } }, error: null };
  }
  if (body.mode === "record") {
    await sleep(300);
    return { data: { success: true, mode: "record", result: { id: "ev-1", category: body.category, ocr_amount: 2500000, reference_number: "FT1" } }, error: null };
  }
  return edgeError(400, "invalid_mode");
}
const user = { id: "qa-user", email: "qa@bmq.test", user_metadata: {} };
const channel = { on() { return channel; }, subscribe() { return channel; }, unsubscribe() {} };
export const supabase = {
  from: (table) => builder(table),
  rpc: (fn, args) => builder("rpc:" + fn, args),
  schema: () => ({ from: (table) => builder(table), rpc: (fn, args) => builder("rpc:" + fn, args) }),
  functions: { invoke },
  storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "" } }), createSignedUrl: async () => ({ data: { signedUrl: "data:image/svg+xml;utf8,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2772%27 height=%2796%27%3E%3Crect width=%2772%27 height=%2796%27 fill=%27%23dfe8dd%27/%3E%3Ctext x=%278%27 y=%2750%27 font-size=%2712%27%3EUNC%3C/text%3E%3C/svg%3E" }, error: null }), list: async () => ({ data: [], error: null }), upload: async () => ({ data: null, error: { message: "QA fixture: writes disabled" } }), download: async () => ({ data: null, error: null }) }) },
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
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-unc-evidence-qa/vite-cache",
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

async function open(cfg, route, viewport) {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce", locale: "vi-VN" });
  await context.addInitScript((value) => localStorage.setItem("qa-shell", JSON.stringify(value)), cfg);
  await context.route("**/*", (r) => {
    const url = r.request().url();
    if (url.startsWith(BASE) || url.startsWith("data:") || url.startsWith("blob:") || /fonts\.(googleapis|gstatic)\.com/.test(url)) return r.continue();
    return r.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + route, { waitUntil: "domcontentloaded" });
  // Duyệt chi now opens on "Chưa thanh toán" (Trình chi gấp); these checks cover the full list.
  if (route === "/payment-requests") await page.locator("[data-bmq-pr-view-all]").click({ timeout: 15000 });
  await page.waitForSelector("[data-bmq-shell='demo3-v1']", { timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(300);
  return { context, page, errors };
}

const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const dialogOverflow = (page) => page.$eval("[data-bmq-unc-dialog]", (el) => el.scrollWidth - el.clientWidth);
const writes = (page) => page.evaluate(() => window.__qaWrites);
const bodies = (page) => page.evaluate(() => window.__qaBodies);

// A real image for the upload: a small rendered "UNC" PNG.
const SLIP_PNG = await (async () => {
  const ctx = await browser.newContext({ viewport: { width: 600, height: 800 } });
  const p = await ctx.newPage();
  await p.setContent(`<body style="margin:0;font:28px sans-serif;background:#fff;padding:40px"><h2>ỦY NHIỆM CHI</h2><p>Số tiền: 13.500.000 VND</p><p>Mã GD: FT26279123456</p></body>`);
  const buf = await p.screenshot();
  await ctx.close();
  return buf;
})();
const upload = (page) => page.setInputFiles("[data-bmq-unc-file]", { name: "unc.png", mimeType: "image/png", buffer: SLIP_PNG });

async function openDetail(page, requestNumber) {
  await page.waitForSelector("[data-bmq-pr-row]");
  await page.locator("[data-bmq-pr-row]", { hasText: requestNumber }).locator(".d3-pa-open").click();
  await page.waitForSelector("[data-bmq-payment-detail]");
}

const WIDTHS = [{ width: 1440, height: 900 }, { width: 390, height: 844 }];
try {
  // 1. A paid request shows the UNC image, its share of the transfer, and the sibling requests.
  for (const viewport of WIDTHS) {
    const { context, page, errors } = await open({ role: "owner" }, "/payment-requests", viewport);
    await openDetail(page, "DC-0099");
    await page.waitForSelector("[data-bmq-unc-evidence]");
    const row = page.locator("[data-bmq-unc-ev-row='PAY-000150']");
    await row.waitFor();
    const text = await row.textContent();
    assert.ok(text.includes("8.000.000") && text.includes("35.204.220"), `share of the total: ${text}`);
    assert.ok(text.includes("6084337381"), "reference");
    assert.ok(text.includes("Duyệt tay") && text.includes("2.607.720 chưa có phiếu"), "manual override reason");
    const sib = await page.locator("[data-bmq-unc-ev-siblings] li").allTextContents();
    assert.equal(sib.length, 3, "three sibling requests");
    assert.ok(sib[0].includes("DC-0096") && sib[0].includes("10.732.500"));
    await page.waitForSelector("[data-bmq-unc-ev-image] img");
    assert.ok((await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0, `no overflow ${viewport.width}`);
    await page.waitForTimeout(300);
    await page.locator("[data-bmq-unc-evidence]").screenshot({ path: `${EVIDENCE}/evidence-${viewport.width}.png` });
    await page.locator("[data-bmq-unc-ev-siblings]").scrollIntoViewIfNeeded();
    await page.evaluate(() => document.querySelector("[data-bmq-unc-ev-siblings]")?.scrollIntoView({ block: "center" }));
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${EVIDENCE}/evidence-view-${viewport.width}.png` });
    await page.locator("[data-bmq-unc-ev-image]").click();
    await page.getByRole("dialog", { name: "Ảnh UNC" }).waitFor();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `${EVIDENCE}/evidence-zoom-${viewport.width}.png` });
    await page.keyboard.press("Escape");
    assert.deepEqual(await page.evaluate(() => window.__qaWrites.filter((w) => !w.startsWith("rpc:snapshot"))), [], "read-only");
    assert.deepEqual(errors, [], `page errors ${viewport.width}`);
    record(`evidence section ${viewport.width}`);
    await context.close();
  }

  // 2. Clicking a sibling opens that request.
  {
    const { context, page, errors } = await open({ role: "owner" }, "/payment-requests", { width: 1440, height: 900 });
    await openDetail(page, "DC-0099");
    await page.waitForSelector("[data-bmq-unc-ev-siblings]");
    await page.locator("[data-bmq-unc-ev-siblings] button", { hasText: "DC-0096" }).click();
    await page.waitForFunction(() => document.querySelector("[data-bmq-payment-detail]")?.textContent?.includes("DC-0096"));
    assert.deepEqual(errors, []);
    record("sibling opens the other request");
    await context.close();
  }

  // 3. A payment without a stored UNC says so; an empty result and an RPC error are not shown as success.
  {
    const { context, page, errors } = await open({ role: "owner" }, "/payment-requests", { width: 390, height: 844 });
    await openDetail(page, "DC-0095");
    await page.waitForSelector("[data-bmq-unc-ev-row='PAY-000148']");
    const t = await page.locator("[data-bmq-unc-ev-row='PAY-000148']").textContent();
    assert.ok(t.includes("chưa có ảnh UNC"), t);
    assert.equal(await page.locator("[data-bmq-unc-ev-image]").count(), 0);
    await page.locator("[data-bmq-unc-evidence]").screenshot({ path: `${EVIDENCE}/evidence-none-390.png` });
    assert.deepEqual(errors, []);
    record("payment without UNC image");
    await context.close();

    const failing = await open({ role: "owner", evidence: "error" }, "/payment-requests", { width: 390, height: 844 });
    await openDetail(failing.page, "DC-0099");
    await failing.page.waitForSelector("[data-bmq-unc-ev-error]");
    assert.equal(await failing.page.locator("[data-bmq-unc-ev-row]").count(), 0);
    await failing.page.locator("[data-bmq-unc-evidence]").screenshot({ path: `${EVIDENCE}/evidence-error-390.png` });
    record("rpc error is shown, not hidden");
    await failing.context.close();
  }

  // 4. A request with no payment yet does not show the section at all.
  {
    const { context, page, errors } = await open({ role: "owner" }, "/payment-requests", { width: 1440, height: 900 });
    await openDetail(page, "DC-0101");
    await page.waitForTimeout(600);
    assert.equal(await page.locator("[data-bmq-unc-evidence]").count(), 0);
    assert.deepEqual(errors, []);
    record("unpaid request has no evidence section");
    await context.close();
  }
} finally {
  fs.writeFileSync(`${EVIDENCE}/qa-unc-evidence.json`, JSON.stringify(results, null, 2));
  await browser.close();
  await server.close();
}
console.log(`ALL ${results.length} UNC EVIDENCE QA CHECKS PASSED — evidence in ${EVIDENCE}`);
