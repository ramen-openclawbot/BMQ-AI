// QA for Chặn chi vượt PO + Đối soát: the Đối soát tab in Duyệt chi (filters, groups, review and
// allowance dialogs), "Đã/Chưa nhập kho" + warning chips on the Trình chi gấp page, and the PO
// value / paid line + warnings in the payment request detail, at 1440 / 390 / 320.
//
// FIXTURE AUTH + FIXTURE DATA: AuthContext and the Supabase client are replaced by in-memory
// fixtures; the two new RPCs are recorded and answered by the fixture, every other write is
// refused and recorded, and all non-local network is blocked. Not real-user acceptance.
//
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome node scripts/qa_reconciliation.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-recon-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5209);
const { chromium } = createRequire(import.meta.url)(PW);
fs.mkdirSync(EVIDENCE, { recursive: true });

const SUPABASE_FIXTURE = `
const cfg = () => JSON.parse(localStorage.getItem("qa-shell") || "{}");
window.__qaWrites = window.__qaWrites || [];
window.__qaBodies = window.__qaBodies || [];
const WRITE = new Set(["insert", "update", "upsert", "delete"]);
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
const PO_CHOLIMEX = "po-340", PO_TA = "po-144";
const F = (key, label, priority, type, id, ref, sup, group, amount, evidence, review) => ({
  flag_key: label + ":" + id, label, priority, category: "finance", entity_type: type, entity_id: id, entity_ref: ref,
  supplier_id: "s-" + sup, supplier_name: sup, group_key: group, amount, evidence, detected_at: today + "T03:00:00Z",
  review_status: review ? review[0] : null, review_note: review ? review[1] : null,
});
const FLAGS_RAW = [
  F(1, "po_overpaid", "critical", "purchase_order", PO_CHOLIMEX, "PO-000340", "Cholimex", "po:" + PO_CHOLIMEX, 1272672,
    { po_number: "PO-000340", po_total: 1272672, allowance: 0, paid_total: 2545344, overpaid: 1272672,
      requests: [{ request_number: "PR-MMVOAL7H", status: "approved", total_amount: 1272672, paid: 1272672 }, { request_number: "PR-MN3UTS15", status: "approved", total_amount: 1272672, paid: 1272672 }] }),
  F(2, "po_over_requested", "high", "purchase_order", PO_CHOLIMEX, "PO-000340", "Cholimex", "po:" + PO_CHOLIMEX, 1272672,
    { po_number: "PO-000340", po_total: 1272672, allowance: 0, requested_total: 2545344, over_requested: 1272672 }),
  F(3, "pr_twin_created", "high", "payment_request", "pr-ta-2", "PR-MMEK7ZD8", "Tuyết Anh", "po:" + PO_TA, 2761350,
    { request_number: "PR-MMEK7ZD8", twin_request_number: "PR-MMEK7KLW", request_total: 2761350, twin_total: 2761350, gap_seconds: 19 }),
  F(4, "po_over_requested", "high", "purchase_order", PO_TA, "PO-000144", "Tuyết Anh", "po:" + PO_TA, 2761350,
    { po_number: "PO-000144", po_total: 2761350, allowance: 0, requested_total: 5522700, over_requested: 2761350 }, ["needs_action", "Chờ kế toán từ chối phiếu dư"]),
  F(5, "paid_without_bank_evidence", "medium", "payment_request", "pr-old-1", "PR-MMAAAA01", "Công ty TNHH Thực Phẩm Tươi Sống Miền Nam chi nhánh Bình Tân", "supplier:s-x", 980000, { request_number: "PR-MMAAAA01" }),
  F(6, "receipt_confirmed_delivery_pending", "low", "payment_request", "pr-bb", "PR-8CA755E0", "Bao bì Minh Tuấn", "po:po-820", 8800000, { request_number: "PR-8CA755E0", receipt_number: "GRN-000571", receipt_status: "confirmed", delivery_status: "pending" }),
  F(8, "jev_possible_duplicate", "medium", "payment_request", "pb", "PR-BB000002", "Bao bì Minh Tuấn", "supplier:s-bb", 1800000,
    { older_request: "PR-BB000001", newer_request: "PR-BB000002", p_same: 0.58, relation: "repeat_order", days_apart: 7, amount_older: 1800000, amount_newer: 1800000, status: "needs_review" }),
  F(7, "paid_without_receipt", "medium", "payment_request", "pr-old-2", "PR-MMAAAA02", "Hasu Food", "supplier:s-h", 5531000, { request_number: "PR-MMAAAA02", days_open: 40 }, ["checked", "Đã đối chiếu"]),
];
// Real view key for Jev pairs: jev_possible_duplicate:<pair_key>.
const FLAGS = FLAGS_RAW.map((f) => (f.label === "jev_possible_duplicate" ? { ...f, flag_key: "jev_possible_duplicate:pa:pb" } : f));
const SUB_ITEMS = [
  { payment_request_id: "pr-bb", position: 1, remaining_at_submit: 8800000, request_number: "PR-8CA755E0", title: "Duyệt chi PO PO-000820", supplier_id: "s-bb", supplier_name: "Bao bì Minh Tuấn", total_amount: 8800000, allocated_amount: 0, remaining_amount: 8800000, status: "pending", payment_status: "unpaid", requires_receipt: true, created_at: today + "T02:00:00Z" },
  { payment_request_id: "pr-ta-2", position: 2, remaining_at_submit: 2761350, request_number: "PR-MMEK7ZD8", title: "Đề nghị chi - PO-000144", supplier_id: "s-ta", supplier_name: "Tuyết Anh", total_amount: 2761350, allocated_amount: 0, remaining_amount: 2761350, status: "pending", payment_status: "unpaid", requires_receipt: true, created_at: today + "T02:10:00Z" },
];
const RECEIPTS = [
  { id: "pr-bb", purchase_order_id: "po-820", goods_receipt_id: "gr-571", goods_receipts: { receipt_number: "GRN-000571", receipt_date: today, status: "confirmed" } },
  { id: "pr-ta-2", purchase_order_id: PO_TA, goods_receipt_id: null, goods_receipts: null },
];
const PR_DETAIL = { id: "pr-ta-2", request_number: "PR-MMEK7ZD8", title: "Đề nghị chi - PO-000144", total_amount: 2761350, vat_amount: 0, status: "pending",
  payment_status: "unpaid", payment_method: "bank_transfer", payment_type: "old_order", delivery_status: "pending", requires_receipt: true, created_at: today + "T02:10:00Z",
  supplier_id: "s-ta", suppliers: { id: "s-ta", name: "Tuyết Anh" }, purchase_order_id: PO_TA, goods_receipt_id: null, invoice_id: null, image_url: null,
  payment_allocations: [], notes: null, description: "Thanh toán PO-000144", created_by: null, approved_by: null, approved_at: null, rejection_reason: null, invoice_created: false };
const PO_DETAIL = { id: PO_TA, po_number: "PO-000144", total_amount: 2761350, status: "sent", order_date: "2026-03-05", suppliers: { id: "s-ta", name: "Tuyết Anh" } };
const PO_PRS = [
  { id: "pr-ta-1", request_number: "PR-MMEK7KLW", status: "pending", payment_allocations: [] },
  { id: "pr-ta-2", request_number: "PR-MMEK7ZD8", status: "pending", payment_allocations: [] },
];
const PAIR_ROWS = [
  { id: "pa", request_number: "PR-BB000001", created_at: "2026-10-01T02:00:00Z", total_amount: 1800000, title: "Bao giấy 18", goods_receipts: { receipt_number: "GRN-000560", receipt_date: "2026-10-01" }, invoices: { invoice_number: "HD611" }, payment_request_items: [{ product_name: "Bao giấy bánh mì 18cm", quantity: 2000, unit: "cái", line_total: 1800000 }] },
  { id: "pb", request_number: "PR-BB000002", created_at: "2026-10-08T02:00:00Z", total_amount: 1800000, title: "Bao giấy 18", goods_receipts: { receipt_number: "GRN-000573", receipt_date: "2026-10-08" }, invoices: { invoice_number: "HD719" }, payment_request_items: [{ product_name: "Bao giấy bánh mì 18cm", quantity: 2000, unit: "cái", line_total: 1800000 }] },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function settle(st) {
  const c = cfg();
  if (st.table === "rpc:get_payment_submission") {
    return { data: { id: "sub-1", submission_number: "TC-261009-01", note: "Dạ kho hết bao giấy", total_amount: 11561350, created_by: "acc", created_at: today + "T02:42:00Z", items: SUB_ITEMS }, error: null };
  }
  if (st.table === "rpc:review_finance_reconciliation_flag" || st.table === "rpc:allow_purchase_order_overpay" || st.table === "rpc:review_jev_duplicate_check") {
    window.__qaBodies.push({ name: st.table, ...(st.args || {}) });
    return { data: { ok: true }, error: null };
  }
  if (st.table === "rpc:get_payment_request_unc_evidence") return { data: { evidence: [] }, error: null };
  if (st.table.startsWith("rpc:")) { window.__qaWrites.push(st.table); return { data: null, error: { message: "QA fixture: rpc disabled" } }; }
  if (st.write) { window.__qaWrites.push(st.table + ":" + st.write); return { data: null, error: { message: "QA fixture: writes disabled" }, count: null }; }
  if (st.table === "finance_reconciliation_flags") {
    if (c.flags === "error") return { data: null, error: { message: "boom" } };
    if (c.flags === "empty") return { data: [], error: null };
    window.__qaFlagQueries = (window.__qaFlagQueries || []).concat([{ in: st.ins, is: st.iss, or: st.or || null }]);
    let rows = FLAGS;
    if (st.ins.entity_id) rows = rows.filter((f) => st.ins.entity_id.includes(f.entity_id));
    if (st.ins.priority) rows = rows.filter((f) => st.ins.priority.includes(f.priority));
    if (st.or) {
      const listAfter = (key) => { const i = st.or.indexOf(key + ".in.("); if (i < 0) return []; const rest = st.or.slice(i + key.length + 5); return rest.slice(0, rest.indexOf(")")).split(","); };
      const pr = listAfter("priority"), lb = listAfter("label");
      rows = rows.filter((f) => pr.includes(f.priority) || lb.includes(f.label));
    }
    if ("review_status" in st.iss) rows = rows.filter((f) => f.review_status === null);
    return { data: rows, error: null };
  }
  if (st.table === "payment_requests" && st.ins.id && st.ins.id.includes("pa")) return { data: PAIR_ROWS, error: null };
  if (st.table === "payment_requests" && st.ins.id) return { data: RECEIPTS.filter((r) => st.ins.id.includes(r.id)), error: null };
  if (st.table === "payment_requests" && st.eqs.purchase_order_id) return { data: PO_PRS, error: null };
  if (st.single) {
    if (st.table === "payment_requests") return { data: PR_DETAIL, error: null };
    if (st.table === "purchase_orders") return { data: PO_DETAIL, error: null };
    return { data: null, error: null };
  }
  if (st.head) return { data: null, error: null, count: 0 };
  return { data: [], error: null, count: 0 };
}
function builder(table, args) {
  const st = { table, args, ins: {}, iss: {}, eqs: {}, head: false, single: false, write: null };
  const proxy = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return (ok, ko) => Promise.resolve(settle(st)).then(ok, ko);
      if (prop === "catch") return (ko) => Promise.resolve(settle(st)).catch(ko);
      if (prop === "finally") return (fn) => Promise.resolve(settle(st)).finally(fn);
      return (...a) => {
        if (WRITE.has(prop)) st.write = prop;
        if (prop === "select" && a[1] && a[1].head) st.head = true;
        if (prop === "eq") st.eqs[a[0]] = a[1];
        if (prop === "in") st.ins[a[0]] = a[1];
        if (prop === "is") st.iss[a[0]] = a[1];
        if (prop === "or") st.or = a[0];
        if (prop === "single" || prop === "maybeSingle") st.single = true;
        return proxy;
      };
    },
  });
  return proxy;
}
async function invoke(name, options) {
  const body = options?.body || {};
  if (name === "finance-jev-duplicate-scan") {
    window.__qaBodies.push({ name, ...body });
    await sleep(300);
    const base = { mode: body.mode, candidates: 12, checked: 3, auto_clear: 1, needs_review: 1, auto_flag: 1, failed: 0, skipped_unchanged: 2 };
    if (body.mode === "dry_run") base.items = [
      { pair_key: "pa:pb", pr_older: "pa", pr_newer: "pb", older_request: "PR-BB000001", newer_request: "PR-BB000002", status: "needs_review", p_same: 0.58, relation: "repeat_order", relation_probability: 0.5, relation_confidence: 0.4, error: null },
      { pair_key: "pc:pd", pr_older: "pc", pr_newer: "pd", older_request: "PR-CC000001", newer_request: "PR-CC000002", status: "auto_flag", p_same: 0.93, relation: "same_purchase", relation_probability: 0.8, relation_confidence: 0.7, error: null },
      { pair_key: "pe:pf", pr_older: "pe", pr_newer: "pf", older_request: "PR-EE000001", newer_request: "PR-EE000002", status: "auto_clear", p_same: 0.04, relation: "unrelated", relation_probability: 0.9, relation_confidence: 0.85, error: null },
      { pair_key: "pg:ph", pr_older: "pg", pr_newer: "ph", older_request: "PR-GG000001", newer_request: "PR-GG000002", status: null, p_same: null, relation: null, relation_probability: null, relation_confidence: null, error: 'jev_http_error (HTTP 403: {"error":{"message":"Free tier users do not have access to this model. Upgrade to paid credits","type":"no_providers_available"}})' },
    ];
    return { data: base, error: null };
  }
  window.__qaWrites.push("invoke:" + name); return { data: null, error: { message: "QA fixture: functions disabled" } };
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
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-recon-qa/vite-cache",
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
  const context = await browser.newContext({ viewport, reducedMotion: "reduce", locale: cfg.locale || "vi-VN", ...(cfg.tz ? { timezoneId: cfg.tz } : {}) });
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

const overflowOk = async (page) => (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 0;
const bodies = (page) => page.evaluate(() => window.__qaBodies);
const WIDTHS = [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }];
try {
  // 1. Đối soát tab.
  for (const viewport of WIDTHS) {
    const w = viewport.width;
    const { context, page, errors } = await open({ role: "owner" }, "/payment-requests", viewport);
    await page.locator("[data-bmq-pr-view-recon]").click();
    await page.waitForSelector("[data-bmq-rc-group]");
    // Default: critical+high, hide reviewed -> PO-000340 (2 flags) + Tuyết Anh twin; PO-000144 needs_action is hidden (reviewed).
    const q = (await page.evaluate(() => window.__qaFlagQueries)).pop();
    assert.equal(q.or, "priority.in.(critical,high),label.in.(jev_possible_duplicate)", q.or);
    assert.ok("review_status" in q.is, "hides reviewed by default");
    const groupOrder = await page.$$eval("[data-bmq-rc-group]", (els) => els.map((e) => e.getAttribute("data-bmq-rc-group")));
    assert.equal(groupOrder[0], "po:po-340", "critical group first: " + groupOrder.join());
    assert.equal(await page.locator("[data-bmq-rc-flag]").count(), 4, "critical+high plus the Jev review queue");
    assert.ok((await page.locator("[data-bmq-rc-flag='po_overpaid']").textContent()).includes("vượt 1.272.672"));
    assert.ok((await page.locator("[data-bmq-rc-flag='pr_twin_created']").textContent()).includes("19 giây"));
    assert.ok(await overflowOk(page), `overflow ${w}`);
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${EVIDENCE}/recon-${w}.png`, fullPage: true });
    // All + show reviewed.
    await page.locator("[data-bmq-rc-scope-all]").click();
    await page.locator("[data-bmq-rc-hide-reviewed]").uncheck();
    await page.waitForFunction(() => document.querySelectorAll("[data-bmq-rc-flag]").length === 8);
    assert.ok(await overflowOk(page), `overflow all ${w}`);
    await page.screenshot({ path: `${EVIDENCE}/recon-all-${w}.png`, fullPage: true });
    // Review dialog.
    await page.locator("[data-bmq-rc-flag='po_overpaid'] [data-bmq-rc-review]").click();
    await page.waitForSelector("[data-bmq-rc-review-dialog]");
    await page.locator("[data-bmq-rc-status='needs_action']").click();
    await page.locator("[data-bmq-rc-note]").fill("Đối chiếu sao kê 24/03");
    await page.waitForTimeout(200);
    await page.locator("[data-bmq-rc-review-dialog]").screenshot({ path: `${EVIDENCE}/review-dialog-${w}.png` });
    await page.locator("[data-bmq-rc-save]").click();
    await page.waitForSelector("[data-bmq-rc-review-dialog]", { state: "detached" });
    const rv = (await bodies(page)).filter((b) => b.name === "rpc:review_finance_reconciliation_flag").pop();
    assert.deepEqual(rv, { name: "rpc:review_finance_reconciliation_flag", p_flag_key: "po_overpaid:po-340", p_status: "needs_action", p_note: "Đối chiếu sao kê 24/03" });
    // Allowance dialog: reason too short keeps save disabled.
    await page.locator("[data-bmq-rc-flag='po_overpaid'] [data-bmq-rc-allow]").click();
    await page.waitForSelector("[data-bmq-rc-allow-dialog]");
    assert.equal(await page.locator("[data-bmq-rc-allow-amount]").inputValue(), "1.272.672");
    assert.equal(await page.locator("[data-bmq-rc-allow-save]").isDisabled(), true);
    await page.locator("[data-bmq-rc-allow-amount]").fill("50000");
    await page.locator("[data-bmq-rc-allow-reason]").fill("NCC giao thêm 2 thùng");
    await page.locator("[data-bmq-rc-allow-dialog]").screenshot({ path: `${EVIDENCE}/allow-dialog-${w}.png` });
    await page.locator("[data-bmq-rc-allow-save]").click();
    await page.waitForSelector("[data-bmq-rc-allow-dialog]", { state: "detached" });
    const al = (await bodies(page)).filter((b) => b.name === "rpc:allow_purchase_order_overpay").pop();
    assert.deepEqual(al, { name: "rpc:allow_purchase_order_overpay", p_purchase_order_id: "po-340", p_extra_amount: 50000, p_reason: "NCC giao thêm 2 thùng" });
    assert.deepEqual(errors, [], `page errors ${w}`);
    console.log("PASS", `recon tab ${w}`);
    await context.close();
  }
  // 1b. Accountant sees flags but no review/allowance buttons; empty and error states.
  for (const [cfgv, sel] of [[{ role: "accountant" }, "[data-bmq-rc-group]"], [{ role: "owner", flags: "empty" }, "[data-bmq-rc-empty]"], [{ role: "owner", flags: "error" }, "[data-bmq-rc-error]"]]) {
    const { context, page, errors } = await open(cfgv, "/payment-requests", { width: 390, height: 844 });
    await page.locator("[data-bmq-pr-view-recon]").click();
    await page.waitForSelector(sel);
    if (cfgv.role === "accountant") {
      assert.equal(await page.locator("[data-bmq-rc-review], [data-bmq-rc-allow], [data-bmq-jev-bar], [data-bmq-jev-same]").count(), 0);
    }
    await page.screenshot({ path: `${EVIDENCE}/recon-${cfgv.role}-${cfgv.flags || "data"}-390.png` });
    assert.deepEqual(errors, []);
    console.log("PASS", `recon state ${cfgv.role} ${cfgv.flags || "data"}`);
    await context.close();
  }
  // 1c. Jev duplicate scan: dry run dialog, save, compare, decision.
  for (const viewport of WIDTHS) {
    const w = viewport.width;
    const { context, page, errors } = await open({ role: "owner" }, "/payment-requests", viewport);
    await page.locator("[data-bmq-pr-view-recon]").click();
    await page.waitForSelector("[data-bmq-jev-bar]");
    await page.waitForSelector("[data-bmq-rc-flag='jev_possible_duplicate']");
    assert.ok((await page.locator("[data-bmq-rc-flag='jev_possible_duplicate']").textContent()).includes("trùng 58%"));
    await page.locator("[data-bmq-jev-dry]").click();
    await page.waitForSelector("[data-bmq-jev-result]");
    assert.equal(await page.locator("[data-bmq-jev-item]").count(), 4);
    assert.ok((await page.locator("[data-bmq-jev-hint]").textContent()).includes("gói miễn phí"), "free-tier hint shown once");
    assert.equal((await page.locator("[data-bmq-jev-item='error'] .d3-up-chip").textContent()).trim(), "Lỗi Jev · jev_http_error · HTTP 403");
    assert.equal(await page.locator("[data-bmq-jev-item]").first().getAttribute("data-bmq-jev-item"), "auto_flag", "highest probability first");
    const dry = (await bodies(page)).filter((b) => b.name === "finance-jev-duplicate-scan").pop();
    assert.deepEqual({ mode: dry.mode, limit: dry.limit, days: dry.days }, { mode: "dry_run", limit: 50, days: 90 });
    await page.waitForTimeout(200);
    await page.locator("[data-bmq-jev-result]").screenshot({ path: `${EVIDENCE}/jev-dry-${w}.png` });
    await page.locator("[data-bmq-jev-save]").click();
    await page.waitForSelector("[data-bmq-jev-result]", { state: "detached" });
    await page.waitForFunction(() => window.__qaBodies.filter((b) => b.name === "finance-jev-duplicate-scan" && b.mode === "run").length === 1);
    await page.locator("[data-bmq-jev-compare]").click();
    await page.waitForSelector("[data-bmq-jev-side='PR-BB000002']");
    assert.equal(await page.locator("[data-bmq-jev-side]").count(), 2);
    assert.ok(await overflowOk(page), `overflow jev ${w}`);
    await page.waitForTimeout(200);
    await page.locator("[data-bmq-rc-flag='jev_possible_duplicate']").screenshot({ path: `${EVIDENCE}/jev-compare-${w}.png` });
    await page.locator("[data-bmq-jev-diff]").click();
    await page.waitForFunction(() => window.__qaBodies.some((b) => b.name === "rpc:review_jev_duplicate_check"));
    const rv = (await bodies(page)).filter((b) => b.name === "rpc:review_jev_duplicate_check").pop();
    assert.deepEqual(rv, { name: "rpc:review_jev_duplicate_check", p_pair_key: "pa:pb", p_decision: "different_purchase", p_note: null });
    await page.screenshot({ path: `${EVIDENCE}/jev-bar-${w}.png` });
    assert.deepEqual(errors, [], `page errors ${w}`);
    console.log("PASS", `jev ${w}`);
    await context.close();
  }
  // 2. Submission chips + detail dialog.
  for (const viewport of WIDTHS) {
    const w = viewport.width;
    const { context, page, errors } = await open({ role: "owner" }, "/payment-requests/submissions/sub-1", viewport);
    await page.waitForSelector("[data-bmq-submission-receipt]");
    // GRN-000571 is "confirmed" (waiting), so it must read "Chờ nhập kho", never "Đã nhập kho".
    assert.ok((await page.locator("[data-bmq-submission-row='PR-8CA755E0'] [data-bmq-submission-receipt='waiting']").textContent()).includes("Chờ nhập kho GRN-000571"));
    assert.equal(await page.locator("[data-bmq-submission-receipt='in']").count(), 0);
    assert.equal(await page.locator("[data-bmq-submission-row='PR-MMEK7ZD8'] [data-bmq-submission-receipt='none']").count(), 1);
    await page.waitForSelector("[data-bmq-submission-row='PR-MMEK7ZD8'] [data-bmq-submission-flag='pr_twin_created']");
    // The PO-000144 over-request flag is needs_action, so it still shows on the row.
    assert.equal(await page.locator("[data-bmq-submission-row='PR-MMEK7ZD8'] [data-bmq-submission-flag='po_over_requested']").count(), 1);
    assert.ok(await overflowOk(page), `submission overflow ${w}`);
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${EVIDENCE}/submission-${w}.png`, fullPage: true });
    await page.locator(".d3-ps-rows").scrollIntoViewIfNeeded();
    await page.locator(".d3-ps-rows").screenshot({ path: `${EVIDENCE}/submission-rows-${w}.png` });
    await page.locator("[data-bmq-submission-row='PR-MMEK7ZD8'] .d3-ps-open").click();
    await page.waitForSelector("[data-bmq-pr-po-value]");
    const po = await page.locator("[data-bmq-pr-po-value]").textContent();
    assert.ok(po.includes("2.761.350") && po.includes("Còn được chi") && po.includes("PR-MMEK7KLW"), po);
    assert.equal(await page.locator("[data-bmq-pr-flag]").count(), 2);
    await page.waitForTimeout(250);
    await page.screenshot({ path: `${EVIDENCE}/detail-${w}.png` });
    await page.locator("[data-bmq-pr-po-value]").scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    await page.locator("[data-bmq-pr-po-value]").locator("xpath=ancestor::li[1]").screenshot({ path: `${EVIDENCE}/detail-po-${w}.png` });
    assert.deepEqual(errors, [], `page errors ${w}`);
    console.log("PASS", `submission + detail ${w}`);
    await context.close();
  }
  // 3. Zalo deep link /payment-requests?id=<uuid> opens that phiếu; closing drops ?id.
  for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const w = viewport.width;
    const { context, page, errors } = await open({ role: "owner" }, "/payment-requests?id=1f8e2fb1-3fdb-4537-8866-ec1a746fac7c", viewport);
    await page.waitForSelector("[data-bmq-payment-detail]");
    assert.ok((await page.locator("[data-bmq-payment-detail]").textContent()).includes("PR-MMEK7ZD8"), "detail opened from link");
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${EVIDENCE}/deeplink-${w}.png` });
    if (w < 1280) {
      await page.keyboard.press("Escape");
    } else {
      await page.locator("[data-bmq-payment-detail] button", { hasText: "Đóng" }).first().click();
    }
    await page.waitForFunction(() => !new URL(location.href).searchParams.has("id"));
    await page.waitForTimeout(300);
    assert.equal(await page.locator("[data-bmq-payment-detail]").count(), 0, "closed and not reopened");
    assert.deepEqual(errors, []);
    console.log("PASS", `deep link ${w}`);
    await context.close();
  }
  // A malformed id is ignored.
  {
    const { context, page, errors } = await open({ role: "owner" }, "/payment-requests?id=not-a-uuid", { width: 390, height: 844 });
    await page.waitForSelector("[data-bmq-pr-view-unpaid]");
    await page.waitForTimeout(400);
    assert.equal(await page.locator("[data-bmq-payment-detail]").count(), 0);
    assert.deepEqual(errors, []);
    console.log("PASS", "malformed id ignored");
    await context.close();
  }
  console.log("ALL PASS");
} finally {
  await browser.close();
  await server.close();
}
