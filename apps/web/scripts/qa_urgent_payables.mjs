// QA for Trình chi gấp: unpaid list (90 days, 10 per page, server range), ticking + submit, the CEO submission page with Chi UNC / Tiền mặt, and the removed CEO khai báo chip.
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
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-urgent-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5203);
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
  if (st.table === "rpc:create_payment_submission") {
    window.__qaBodies.push({ name: "create_payment_submission", ...(st.args || {}) });
    return { data: { status: "created", submission_id: "sub-1", submission_number: "TC-261007-01", note: st.args?.p_note ?? null, total_amount: 0, item_count: (st.args?.p_request_ids || []).length, items: [], idempotent: false }, error: null };
  }
  if (st.table === "rpc:get_payment_submission") {
    const mk = (r, i, paid) => ({ payment_request_id: r.id, position: i + 1, remaining_at_submit: r.total_amount, request_number: r.request_number, title: r.title, supplier_id: r.supplier_id, supplier_name: r.suppliers.name, total_amount: r.total_amount, allocated_amount: paid ? r.total_amount : 0, remaining_amount: paid ? 0 : r.total_amount, status: paid ? "approved" : r.status, payment_status: paid ? "paid" : "unpaid", requires_receipt: true, created_at: r.created_at });
    const items = [mk(UNPAID[0], 0, false), mk(UNPAID[1], 1, false), mk(UNPAID[2], 2, true)];
    return { data: { id: "sub-1", submission_number: "TC-261007-01", note: "Cần chi trước 15h để nhận hàng", total_amount: items.reduce((s, i) => s + i.remaining_at_submit, 0), created_by: "acc-user", created_at: today + "T03:00:00.000Z", items }, error: null };
  }
  if (st.table === "rpc:finance_unc_total_from_evidence") return { data: { transfer_date: st.args?.p_date, total_amount: 19750000, evidence_count: 2 }, error: null };
  if (st.table.startsWith("rpc:") && !READ_RPCS.has(st.table)) { window.__qaWrites.push(st.table); return { data: null, error: { message: "QA fixture: writes disabled" } }; }
  if (st.write) { window.__qaWrites.push(st.table + ":" + st.write); return { data: null, error: { message: "QA fixture: writes disabled" }, count: null }; }
  if (st.head) return { data: null, error: null, count: st.table === "payment_requests" ? 3 : 0 };
  if (st.single) {
    if (st.table === "payment_requests") return { data: PRS.find((r) => r.id === st.filters.id) || null, error: null };
    return { data: null, error: null };
  }
  if (st.table === "payment_requests" && st.range) {
    if (cfg().unpaid === "error") return { data: null, error: { message: "QA fixture: boom" }, count: null };
    const orTerm = st.or ? (st.or.match(/request_number\.ilike\.%([^%]*)%/) || [])[1] : null;
    const list = UNPAID.filter((r) => !st.gte || r.created_at >= st.gte.slice(0, 10))
      .filter((r) => !st.supplierIds || st.supplierIds.includes(r.supplier_id))
      .filter((r) => !orTerm || r.request_number.toLowerCase().includes(orTerm.toLowerCase()));
    window.__qaRanges = (window.__qaRanges || []).concat([[st.range[0], st.range[1], st.gte || null]]);
    window.__qaSearch = { supplierIds: st.supplierIds || null, or: st.or || null };
    return { data: list.slice(st.range[0], st.range[1] + 1), error: null, count: list.length };
  }
  if (st.table === "payment_requests") return { data: PRS, error: null, count: PRS.length };
  if (st.table === "suppliers") return { data: [{ id: "sup-t", name: "Thiên An Sinh" }, { id: "sup-a", name: "Bột Mì Sài Gòn" }, { id: "sup-x", name: "Bao bì Minh Tuấn" }], error: null, count: 3 };
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
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-urgent-qa/vite-cache",
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

const WIDTHS = [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }];
const overflowOk = async (page) => (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0;
try {
  // 1. Duyệt chi opens on the unpaid view, 10 rows, server range, pages, older-than-90 toggle.
  for (const viewport of WIDTHS) {
    const { context, page, errors } = await open({ role: "owner" }, "/payment-requests", viewport);
    await page.waitForSelector("[data-bmq-urgent-payables]");
    await page.waitForSelector("[data-bmq-urgent-row]");
    assert.equal(await page.locator("[data-bmq-urgent-row]").count(), 10, "10 rows per page");
    assert.ok((await page.locator("[data-bmq-urgent-payables] h2").textContent()).includes("23"), "exact total");
    const ranges = await page.evaluate(() => window.__qaRanges);
    assert.deepEqual(ranges[ranges.length - 1].slice(0, 2), [0, 9], "server range 0..9");
    assert.ok(ranges[ranges.length - 1][2], "90-day cutoff sent");
    assert.ok(await overflowOk(page), `no overflow ${viewport.width}`);
    await page.screenshot({ path: `${EVIDENCE}/unpaid-${viewport.width}.png` });
    await page.getByRole("button", { name: "Trang sau" }).click();
    await page.waitForFunction(() => document.querySelector("[data-bmq-urgent-row]")?.getAttribute("data-bmq-urgent-row") === "PR-U011");
    assert.deepEqual((await page.evaluate(() => window.__qaRanges)).pop().slice(0, 2), [10, 19]);
    await page.locator("[data-bmq-urgent-all-time]").check();
    await page.waitForTimeout(300);
    assert.equal((await page.evaluate(() => window.__qaRanges)).pop()[2], null, "no cutoff when viewing all");
    assert.deepEqual(errors, [], `page errors ${viewport.width}`);
    record(`unpaid list ${viewport.width}`);
    await context.close();
  }

  // 1b. Search: supplier name first, with or without accents; otherwise request code.
  {
    const { context, page, errors } = await open({ role: "owner" }, "/payment-requests", { width: 390, height: 844 });
    await page.waitForSelector("[data-bmq-urgent-row]");
    const search = page.getByLabel("Tìm theo nhà cung cấp hoặc mã phiếu");
    const suppliersShown = async () => [...new Set(await page.$$eval("[data-bmq-urgent-row] .d3-up-who b", (els) => els.map((e) => e.textContent.trim())))];
    for (const [term, expected] of [["thien an", ["Thiên An Sinh"]], ["Thiên An", ["Thiên An Sinh"]], ["BOT MI", ["Bột Mì Sài Gòn"]]]) {
      await search.fill(term);
      await page.waitForFunction((want) => [...document.querySelectorAll("[data-bmq-urgent-row] .d3-up-who b")].every((e) => e.textContent.trim() === want) && document.querySelector("[data-bmq-urgent-row]"), expected[0]);
      assert.deepEqual(await suppliersShown(), expected, `search "${term}"`);
      assert.deepEqual((await page.evaluate(() => window.__qaSearch)).supplierIds, [expected[0] === "Thiên An Sinh" ? "sup-t" : "sup-a"], `supplier filter for "${term}"`);
    }
    await search.fill("PR-U005");
    await page.waitForFunction(() => document.querySelectorAll("[data-bmq-urgent-row]").length === 1);
    const s5 = await page.evaluate(() => window.__qaSearch);
    assert.equal(s5.supplierIds, null, "code search does not filter by supplier");
    assert.ok(s5.or.includes("request_number.ilike.%PR-U005%"), s5.or);
    await search.fill("minh tuan");
    await page.waitForSelector("[data-bmq-urgent-empty]");
    await page.screenshot({ path: `${EVIDENCE}/search-390.png` });
    assert.deepEqual(errors, []);
    record("supplier-first accent-insensitive search");
    await context.close();
  }

  // 2. Tick across pages, submit with a note, success state + link.
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const { context, page, errors } = await open({ role: "owner" }, "/payment-requests", viewport);
    await page.waitForSelector("[data-bmq-urgent-row]");
    await page.getByRole("checkbox", { name: "Trình chi gấp PR-U001" }).click();
    await page.getByRole("checkbox", { name: "Trình chi gấp PR-U002" }).click();
    await page.getByRole("button", { name: "Trang sau" }).click();
    await page.waitForFunction(() => document.querySelector("[data-bmq-urgent-row]")?.getAttribute("data-bmq-urgent-row") === "PR-U011");
    await page.getByRole("checkbox", { name: "Trình chi gấp PR-U011" }).click();
    const bar = page.locator("[data-bmq-urgent-bar]");
    await bar.waitFor();
    assert.ok((await bar.textContent()).includes("3") && (await bar.textContent()).includes("14.000.000"), await bar.textContent());
    await page.waitForTimeout(200);
    // The VNAgent chat launcher must never cover the selection bar.
    const overlap = await page.evaluate(() => {
      const bar = document.querySelector("[data-bmq-urgent-bar]")?.getBoundingClientRect();
      const fab = document.querySelector("[data-vnagent-launcher]");
      if (!bar || !fab || getComputedStyle(fab).display === "none") return false;
      const f = fab.getBoundingClientRect();
      return !(f.right <= bar.left || f.left >= bar.right || f.bottom <= bar.top || f.top >= bar.bottom);
    });
    assert.equal(overlap, false, `chat launcher overlaps the Trình chi gấp bar at ${viewport.width}`);
    await page.screenshot({ path: `${EVIDENCE}/selected-${viewport.width}.png` });
    await page.locator("[data-bmq-urgent-submit-open]").click();
    const dialog = page.locator("[data-bmq-urgent-dialog]");
    await dialog.waitFor();
    assert.equal(await page.locator("[data-bmq-urgent-preview] li").count(), 3);
    await dialog.getByLabel("Ghi chú trình chi").fill("Cần chi trước 15h để nhận hàng");
    await page.waitForTimeout(250);
    await dialog.screenshot({ path: `${EVIDENCE}/submit-dialog-${viewport.width}.png` });
    await page.locator("[data-bmq-urgent-submit]").click();
    await dialog.getByText("Đã gửi TC-261007-01").waitFor();
    const call = (await page.evaluate(() => window.__qaBodies)).filter((b) => b.name === "create_payment_submission").pop();
    assert.equal(call.p_request_ids.length, 3);
    assert.equal(call.p_note, "Cần chi trước 15h để nhận hàng");
    assert.ok(String(call.p_idempotency_key).startsWith("payment_submission:"));
    assert.equal(await page.locator("[data-bmq-urgent-bar]").count(), 0, "selection cleared");
    await dialog.screenshot({ path: `${EVIDENCE}/submit-done-${viewport.width}.png` });
    assert.deepEqual(errors, []);
    record(`submit ${viewport.width}`);
    await context.close();
  }

  // 3. CEO submission page: rows, paid row, per-row UNC / cash, multi-select.
  for (const viewport of WIDTHS) {
    const { context, page, errors } = await open({ role: "owner", ocrAmount: 1000000 }, "/payment-requests/submissions/sub-1", viewport);
    await page.waitForSelector("[data-bmq-submission-row]");
    assert.equal(await page.locator("[data-bmq-submission-row]").count(), 3);
    assert.ok((await page.locator("[data-bmq-submission-remaining]").textContent()).includes("3.000.000"), "remaining = 1tr + 2tr");
    assert.equal(await page.locator("[data-bmq-submission-pay-unc]").count(), 2, "paid row has no pay buttons");
    assert.ok(await overflowOk(page), `no overflow ${viewport.width}`);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${EVIDENCE}/submission-${viewport.width}.png`, fullPage: true });
    await page.locator("[data-bmq-submission-row='PR-U001'] [data-bmq-submission-pay-cash]").click();
    const d = page.locator("[data-bmq-unc-dialog='approve']");
    await d.waitFor();
    assert.equal(await d.getAttribute("data-bmq-unc-method"), "cash");
    // iOS: opening must not focus an amount input (number pad), and the picker must offer the photo library.
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), "DIV", "dialog opens without focusing an input");
    assert.equal(await page.locator("[data-bmq-unc-file]").getAttribute("capture"), null, "file input has no capture attribute");
    assert.ok((await d.textContent()).includes("Chi tiền mặt"));
    await upload(page);
    await page.waitForSelector("[data-bmq-unc-verdict='match']");
    await page.waitForTimeout(250);
    await d.screenshot({ path: `${EVIDENCE}/cash-dialog-${viewport.width}.png` });
    await page.locator("[data-bmq-unc-submit]").click();
    await d.waitFor({ state: "detached" });
    const ex = (await page.evaluate(() => window.__qaBodies)).filter((b) => b.mode === "extract").pop();
    assert.equal(ex.slip_type, "cash");
    const confirm = (await page.evaluate(() => window.__qaBodies)).filter((b) => b.mode === "confirm").pop();
    assert.equal(confirm.payment_method, "cash");
    assert.deepEqual(errors, []);
    record(`submission page + cash ${viewport.width}`);
    await context.close();
  }

  // 4. Multi-select UNC on the submission page.
  {
    const { context, page, errors } = await open({ role: "owner", ocrAmount: 3000000 }, "/payment-requests/submissions/sub-1", { width: 390, height: 844 });
    await page.waitForSelector("[data-bmq-submission-row]");
    await page.getByRole("checkbox", { name: "Chọn PR-U001" }).click();
    await page.getByRole("checkbox", { name: "Chọn PR-U002" }).click();
    await page.locator("[data-bmq-submission-multi-unc]").click();
    const d = page.locator("[data-bmq-unc-dialog='approve']");
    await d.waitFor();
    assert.equal(await d.getAttribute("data-bmq-unc-method"), "bank_transfer");
    assert.equal(await page.locator("[data-bmq-unc-alloc-row]").count(), 2);
    assert.deepEqual(errors, []);
    record("multi-select UNC");
    await context.close();
  }

  // 5. Accountant (no owner): sees the page read-only; CEO khai báo chip removed from the Duyệt chi zone.
  {
    const { context, page, errors } = await open({ role: "accountant" }, "/payment-requests/submissions/sub-1", { width: 1440, height: 900 });
    await page.waitForSelector("[data-bmq-submission-row]");
    assert.equal(await page.locator("[data-bmq-submission-pay-unc]").count(), 0);
    assert.ok((await page.locator("[data-bmq-payment-submission]").textContent()).includes("Chỉ CEO"));
    await page.goto(BASE + "/payment-requests", { waitUntil: "domcontentloaded" });
    await page.waitForSelector("[data-bmq-urgent-payables]");
    await page.waitForTimeout(400);
    assert.equal(await page.getByText("CEO khai báo", { exact: true }).count(), 0, "CEO khai báo chip removed");
    assert.ok(await page.getByRole("checkbox", { name: /Trình chi gấp/ }).first().isVisible(), "accountant with edit can submit");
    assert.deepEqual(errors, []);
    record("accountant view + CEO khai báo chip gone");
    await context.close();
  }

  // 6. Errors are shown, not hidden.
  {
    const { context, page } = await open({ role: "owner", unpaid: "error" }, "/payment-requests", { width: 390, height: 844 });
    await page.waitForSelector("[data-bmq-urgent-error]");
    record("unpaid list error state");
    await context.close();
  }
} finally {
  fs.writeFileSync(`${EVIDENCE}/qa-urgent.json`, JSON.stringify(results, null, 2));
  await browser.close();
  await server.close();
}
console.log(`ALL ${results.length} URGENT PAYABLES QA CHECKS PASSED — evidence in ${EVIDENCE}`);
