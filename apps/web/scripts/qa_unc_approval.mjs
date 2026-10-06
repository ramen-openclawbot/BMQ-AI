// QA for "Duyệt bằng UNC" (Duyệt chi detail + bulk bar) and the CEO khai báo UNC panel.
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
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-unc-approval-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5197);
const { chromium } = createRequire(import.meta.url)(PW);
fs.mkdirSync(EVIDENCE, { recursive: true });

const SUPABASE_FIXTURE = `
const cfg = () => JSON.parse(localStorage.getItem("qa-shell") || "{}");
window.__qaWrites = window.__qaWrites || [];
window.__qaBodies = window.__qaBodies || [];
const WRITE = new Set(["insert", "update", "upsert", "delete"]);
const READ_RPCS = new Set(["rpc:finance_unc_total_from_evidence", "rpc:finance_daily_snapshot"]);
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
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const edgeError = (status, code) => ({
  data: null,
  error: { message: "Edge Function returned a non-2xx status code", context: new Response(JSON.stringify({ success: false, code, error: code }), { status }) },
});
function settle(st) {
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

const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
  { width: 320, height: 640 },
];

try {
  // 1. Single request, OCR matches: detail button → dialog → upload → match → confirm.
  for (const viewport of WIDTHS) {
    const { context, page, errors } = await open({ role: "owner" }, "/payment-requests", viewport);
    await openDetail(page, "DC-0101");
    const btn = page.locator("[data-bmq-unc-open]");
    await btn.waitFor();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${EVIDENCE}/detail-unc-button-${viewport.width}.png` });
    await btn.click();
    await page.waitForSelector("[data-bmq-unc-dialog='approve']");
    assert.ok((await page.locator("[data-bmq-unc-need]").textContent()).includes("13.500.000"), "need total");
    assert.ok(await page.locator("[data-bmq-unc-submit]").isDisabled(), "submit disabled before an image");
    assert.ok((await dialogOverflow(page)) <= 0, `dialog no overflow empty ${viewport.width}`);
    await page.locator("[data-bmq-unc-dialog]").screenshot({ path: `${EVIDENCE}/unc-empty-${viewport.width}.png` });
    await upload(page);
    await page.waitForSelector("[data-bmq-unc-ocr]");
    assert.equal(await page.locator("[data-bmq-unc-verdict='match']").count(), 1, "match verdict");
    assert.ok(await page.locator("[data-bmq-unc-submit]").isEnabled(), "submit enabled on match");
    assert.ok((await dialogOverflow(page)) <= 0, `dialog no overflow review ${viewport.width}`);
    assert.ok((await overflow(page)) <= 0, `page no overflow ${viewport.width}`);
    await page.locator("[data-bmq-unc-dialog]").screenshot({ path: `${EVIDENCE}/unc-match-${viewport.width}.png` });
    await page.locator("[data-bmq-unc-submit]").click();
    await page.locator("[data-bmq-unc-dialog]").waitFor({ state: "detached" });
    await page.locator("[data-sonner-toast]", { hasText: "Đã duyệt và ghi chi bằng UNC" }).first().waitFor({ timeout: 4000 });
    const confirm = (await bodies(page)).find((b) => b.mode === "confirm");
    assert.deepEqual(confirm.request_ids, ["11111111-1111-4111-8111-111111111111"]);
    assert.equal(confirm.manual_override, false);
    assert.equal(confirm.idempotency_key, "unc:" + "a".repeat(64));
    assert.deepEqual(errors, []);
    record(`single UNC approval match ${viewport.width}`);
    await context.close();
  }

  // 2. Mismatch blocks; manual override needs amount + reason; low-confidence warning shows.
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const { context, page, errors } = await open({ role: "owner", ocrAmount: 13480000, confidence: 0.6 }, "/payment-requests", viewport);
    await openDetail(page, "DC-0101");
    await page.locator("[data-bmq-unc-open]").click();
    await upload(page);
    await page.waitForSelector("[data-bmq-unc-ocr]");
    assert.equal(await page.locator("[data-bmq-unc-verdict='mismatch']").count(), 1, "mismatch verdict");
    assert.ok((await page.locator("[data-bmq-unc-verdict='mismatch']").textContent()).includes("20.000"), "shows the difference");
    assert.equal(await page.locator(".d3-unc-verdict.is-warn").count(), 1, "low-confidence warning");
    assert.ok(await page.locator("[data-bmq-unc-submit]").isDisabled(), "mismatch blocks submit");
    await page.locator("[data-bmq-unc-dialog]").screenshot({ path: `${EVIDENCE}/unc-mismatch-${viewport.width}.png` });
    await page.locator("[data-bmq-unc-manual]").check();
    assert.ok(await page.locator("[data-bmq-unc-submit]").isDisabled(), "override without reason blocked");
    await page.getByLabel("Lý do duyệt tay").fill("Ngân hàng trừ phí 20.000 đ");
    assert.ok(await page.locator("[data-bmq-unc-submit]").isEnabled(), "override with reason allowed");
    assert.ok((await dialogOverflow(page)) <= 0, `dialog no overflow manual ${viewport.width}`);
    await page.locator("[data-bmq-unc-dialog]").screenshot({ path: `${EVIDENCE}/unc-manual-${viewport.width}.png` });
    await page.locator("[data-bmq-unc-submit]").click();
    await page.locator("[data-bmq-unc-dialog]").waitFor({ state: "detached" });
    const confirm = (await bodies(page)).find((b) => b.mode === "confirm");
    assert.equal(confirm.manual_override, true);
    assert.equal(confirm.override_reason, "Ngân hàng trừ phí 20.000 đ");
    assert.equal(confirm.amount, 13480000);
    assert.deepEqual(errors, []);
    record(`mismatch + manual override ${viewport.width}`);
    await context.close();
  }

  // 3. Server refusal stays in the dialog with a plain message; OCR failure too.
  {
    const { context, page, errors } = await open({ role: "owner", confirmError: "reference_reused" }, "/payment-requests", { width: 390, height: 844 });
    await openDetail(page, "DC-0101");
    await page.locator("[data-bmq-unc-open]").click();
    await upload(page);
    await page.waitForSelector("[data-bmq-unc-ocr]");
    await page.locator("[data-bmq-unc-submit]").click();
    await page.waitForSelector("[data-bmq-unc-error]");
    assert.ok((await page.locator("[data-bmq-unc-error]").textContent()).includes("Mã giao dịch này đã dùng"), "reused reference message");
    assert.equal(await page.locator("[data-bmq-unc-dialog]").count(), 1, "dialog stays open");
    await page.locator("[data-bmq-unc-dialog]").screenshot({ path: `${EVIDENCE}/unc-error-reused-390.png` });
    assert.deepEqual(errors, []);
    await context.close();

    const second = await open({ role: "owner", ocr: "fail" }, "/payment-requests", { width: 390, height: 844 });
    await openDetail(second.page, "DC-0101");
    await second.page.locator("[data-bmq-unc-open]").click();
    await upload(second.page);
    await second.page.waitForSelector("[data-bmq-unc-error]");
    assert.ok((await second.page.locator("[data-bmq-unc-error]").textContent()).includes("Chưa đọc được ảnh"));
    assert.ok(await second.page.locator("[data-bmq-unc-submit]").isDisabled());
    await second.page.locator("[data-bmq-unc-dialog]").screenshot({ path: `${EVIDENCE}/unc-error-ocr-390.png` });
    assert.deepEqual(second.errors, []);
    record("server refusal + OCR failure messages");
    await second.context.close();
  }

  // 4. Bulk: two requests of one supplier pay with one UNC; mixed suppliers are blocked.
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const { context, page, errors } = await open({ role: "owner", ocrAmount: 19750000 }, "/payment-requests", viewport);
    await page.waitForSelector("[data-bmq-pr-row]");
    await page.locator("[data-bmq-pr-row]", { hasText: "DC-0101" }).getByRole("checkbox").click();
    await page.locator("[data-bmq-pr-row]", { hasText: "DC-0102" }).getByRole("checkbox").click();
    const bulk = page.locator("[data-bmq-unc-bulk]");
    await bulk.waitFor();
    assert.ok((await overflow(page)) <= 0, `bulk bar no overflow ${viewport.width}`);
    await page.locator(".d3-pa-bulk").screenshot({ path: `${EVIDENCE}/bulk-bar-${viewport.width}.png` });
    await bulk.click();
    await page.waitForSelector("[data-bmq-unc-dialog='approve']");
    assert.equal(await page.locator("[data-bmq-unc-alloc-row]").count(), 2, "lists both requests");
    assert.ok((await page.locator("[data-bmq-unc-need]").textContent()).includes("19.750.000"));
    await upload(page);
    await page.waitForSelector("[data-bmq-unc-verdict='match']");
    await page.locator("[data-bmq-unc-dialog]").screenshot({ path: `${EVIDENCE}/bulk-unc-match-${viewport.width}.png` });
    await page.locator("[data-bmq-unc-submit]").click();
    await page.locator("[data-bmq-unc-dialog]").waitFor({ state: "detached" });
    const confirm = (await bodies(page)).find((b) => b.mode === "confirm");
    assert.equal(confirm.request_ids.length, 2);
    assert.equal(await page.locator("[data-bmq-unc-bulk]").count(), 0, "selection cleared after success");

    await page.locator("[data-bmq-pr-row]", { hasText: "DC-0101" }).getByRole("checkbox").click();
    await page.locator("[data-bmq-pr-row]", { hasText: "DC-0103" }).getByRole("checkbox").click();
    await page.locator("[data-bmq-unc-bulk]").click();
    await upload(page);
    await page.waitForSelector("[data-bmq-unc-ocr]");
    assert.ok(await page.locator("[data-bmq-unc-submit]").isDisabled(), "mixed suppliers blocked");
    assert.equal(await page.locator("[data-bmq-unc-verdict='supplier']").count(), 1, "supplier mismatch is the main warning");
    await page.locator("[data-bmq-unc-manual]").check();
    await page.getByLabel("Lý do duyệt tay").fill("thử duyệt tay");
    assert.ok(await page.locator("[data-bmq-unc-submit]").isDisabled(), "manual override never bypasses the supplier rule");
    assert.ok((await dialogOverflow(page)) <= 0, `long supplier name no overflow ${viewport.width}`);
    await page.locator("[data-bmq-unc-dialog]").screenshot({ path: `${EVIDENCE}/bulk-mixed-${viewport.width}.png` });
    assert.deepEqual(errors, []);
    record(`bulk UNC approval ${viewport.width}`);
    await context.close();
  }

  // 4b. One UNC pays several requests incl. approved-but-unpaid ones, with a partial last request.
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const { context, page, errors } = await open({ role: "owner", ocrAmount: 35204220 }, "/payment-requests", viewport);
    await page.waitForSelector("[data-bmq-pr-row]");
    for (const code of ["DC-0096", "DC-0097", "DC-0098", "DC-0104"]) {
      await page.locator("[data-bmq-pr-row]", { hasText: code }).getByRole("checkbox").click();
    }
    await page.locator("[data-bmq-unc-bulk]").click();
    await page.waitForSelector("[data-bmq-unc-alloc]");
    assert.equal(await page.locator("[data-bmq-unc-alloc-row]").count(), 4);
    assert.ok((await page.locator("[data-bmq-unc-need]").textContent()).includes("43.728.000"), "total owed");
    await upload(page);
    await page.waitForSelector("[data-bmq-unc-alloc-sum]");
    // Oldest first: 10.732.500 + 10.732.500 + 11.131.500 = 32.596.500, then 2.607.720 of the last one.
    const rowValue = (code) => page.locator(`[data-bmq-unc-alloc-row="${code}"] input`).inputValue();
    assert.equal(await rowValue("DC-0096"), "10.732.500");
    assert.equal(await rowValue("DC-0097"), "10.732.500");
    assert.equal(await rowValue("DC-0098"), "11.131.500");
    assert.equal(await rowValue("DC-0104"), "2.607.720");
    assert.equal(await page.locator("[data-bmq-unc-verdict='match']").count(), 1, "sum matches the UNC");
    assert.ok(await page.locator("[data-bmq-unc-submit]").isEnabled());
    assert.ok((await dialogOverflow(page)) <= 0, `alloc dialog no overflow ${viewport.width}`);
    await page.waitForTimeout(300);
    await page.locator("[data-bmq-unc-dialog]").screenshot({ path: `${EVIDENCE}/alloc-match-${viewport.width}.png` });

    // Over-remaining on one request is flagged and blocks the submit.
    const first = page.locator('[data-bmq-unc-alloc-row="DC-0096"] input');
    await first.fill("99999999");
    assert.equal(await page.locator("li.is-over").count(), 1, "row over its remaining is flagged");
    assert.ok(await page.locator("[data-bmq-unc-submit]").isDisabled());
    await page.locator("[data-bmq-unc-dialog]").screenshot({ path: `${EVIDENCE}/alloc-over-${viewport.width}.png` });

    // A sum that differs from the UNC blocks too.
    await first.fill("10732500");
    await page.locator('[data-bmq-unc-alloc-row="DC-0104"] input').fill("1000000");
    assert.equal(await page.locator("[data-bmq-unc-verdict='mismatch']").count(), 1);
    assert.ok(await page.locator("[data-bmq-unc-submit]").isDisabled());

    // Auto-allocate restores the oldest-first split, then submit sends the allocations.
    await page.locator("[data-bmq-unc-alloc-auto]").click();
    assert.equal(await rowValue("DC-0104"), "2.607.720");
    await page.locator("[data-bmq-unc-submit]").click();
    await page.locator("[data-bmq-unc-dialog]").waitFor({ state: "detached" });
    const confirm = (await bodies(page)).filter((b) => b.mode === "confirm").pop();
    assert.equal(confirm.request_ids.length, 4);
    assert.deepEqual(
      confirm.allocations.map((a) => a.amount),
      [10732500, 10732500, 11131500, 2607720],
    );
    assert.equal(confirm.allocations.reduce((sum, a) => sum + a.amount, 0), 35204220);
    assert.equal(confirm.manual_override, false);
    assert.deepEqual(errors, [], `page errors ${viewport.width}`);
    record(`UNC allocations across approved + pending ${viewport.width}`);
    await context.close();
  }

  // 4c. Rows left at 0 are not paid and not sent.
  {
    const { context, page, errors } = await open({ role: "owner", ocrAmount: 10732500 }, "/payment-requests", { width: 1440, height: 900 });
    await page.waitForSelector("[data-bmq-pr-row]");
    for (const code of ["DC-0096", "DC-0097"]) await page.locator("[data-bmq-pr-row]", { hasText: code }).getByRole("checkbox").click();
    await page.locator("[data-bmq-unc-bulk]").click();
    await upload(page);
    await page.waitForSelector("[data-bmq-unc-alloc-sum]");
    assert.equal(await page.locator('[data-bmq-unc-alloc-row="DC-0097"] input').inputValue(), "");
    assert.ok((await page.locator("[data-bmq-unc-alloc-sum]").textContent()).includes("không được trả lần này"));
    await page.locator("[data-bmq-unc-submit]").click();
    await page.locator("[data-bmq-unc-dialog]").waitFor({ state: "detached" });
    const confirm = (await bodies(page)).filter((b) => b.mode === "confirm").pop();
    assert.deepEqual(confirm.request_ids, ["55555555-5555-4555-8555-555555555551"]);
    assert.equal(confirm.allocations.length, 1);
    assert.deepEqual(errors, []);
    record("unallocated rows are skipped");
    await context.close();
  }

  // 5. Non-owner (accountant with module edit) never sees UNC approval.
  {
    const { context, page, errors } = await open({ role: "accountant" }, "/payment-requests", { width: 1440, height: 900 });
    await openDetail(page, "DC-0101");
    await page.waitForTimeout(400);
    assert.equal(await page.locator("[data-bmq-unc-open]").count(), 0, "no detail UNC button");
    await page.keyboard.press("Escape");
    await page.locator("[data-bmq-pr-row]", { hasText: "DC-0102" }).getByRole("checkbox").click();
    await page.waitForTimeout(200);
    assert.equal(await page.locator("[data-bmq-unc-bulk]").count(), 0, "no bulk UNC button");
    assert.deepEqual(errors, []);
    record("non-owner hidden");
    await context.close();
  }

  // 6. CEO khai báo: app UNC total, "Dùng số này", UNC with no request.
  for (const viewport of WIDTHS) {
    const { context, page, errors } = await open({ role: "owner" }, "/finance-control/ceo-declaration", viewport);
    await page.waitForSelector("[data-bmq-unc-app]");
    await page.waitForFunction(() => document.querySelector("[data-bmq-unc-app-total]")?.textContent?.includes("19.750.000"));
    assert.ok((await page.locator("[data-bmq-unc-app]").textContent()).includes("2 phiếu"));
    assert.ok((await overflow(page)) <= 0, `ceo no overflow ${viewport.width}`);
    await page.locator(".d3-ceo-slip[data-slip='unc']").screenshot({ path: `${EVIDENCE}/ceo-unc-panel-${viewport.width}.png` });
    await page.locator("[data-bmq-unc-app-use]").click();
    await page.waitForFunction(() => document.querySelector(".d3-ceo-slip[data-slip='unc'] .d3-ceo-slip-total")?.textContent?.includes("19.750.000"));
    assert.equal(await page.locator("[data-bmq-unc-app-use]").count(), 0, "button hides once totals agree");
    await page.locator("[data-bmq-unc-app-add]").click();
    await page.waitForSelector("[data-bmq-unc-dialog='standalone']");
    await upload(page);
    await page.waitForSelector("[data-bmq-unc-ocr]");
    assert.ok(await page.locator("[data-bmq-unc-submit]").isDisabled(), "category required");
    await page.getByRole("radio", { name: "Thuế" }).click();
    assert.ok(await page.locator("[data-bmq-unc-submit]").isEnabled());
    assert.ok((await dialogOverflow(page)) <= 0, `standalone dialog no overflow ${viewport.width}`);
    await page.locator("[data-bmq-unc-dialog]").screenshot({ path: `${EVIDENCE}/standalone-${viewport.width}.png` });
    await page.locator("[data-bmq-unc-submit]").click();
    await page.locator("[data-bmq-unc-dialog]").waitFor({ state: "detached" });
    const rec = (await bodies(page)).find((b) => b.mode === "record");
    assert.equal(rec.category, "thue");
    assert.equal(rec.manual_override, false);
    assert.equal(rec.amount, null, "no client amount without override");
    assert.deepEqual(errors, []);
    record(`ceo UNC panel + standalone ${viewport.width}`);
    await context.close();
  }

  // 7. No real writes anywhere: only the mocked edge function was called.
  record("only mocked payment-unc-approve invoked (checked per flow)");
} finally {
  fs.writeFileSync(`${EVIDENCE}/qa-unc-approval.json`, JSON.stringify(results, null, 2));
  await browser.close();
  await server.close();
}
console.log(`ALL ${results.length} UNC QA CHECKS PASSED — evidence in ${EVIDENCE}`);
