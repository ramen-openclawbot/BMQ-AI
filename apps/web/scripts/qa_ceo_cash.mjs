// QA for Chi tiền mặt (CEO) on Duyệt chi: pick several voucher photos, server read (mocked),
// review/edit (amount, date, category, content), tick/untick, discard, and record only the
// ticked vouchers, at 1440 / 390 / 320. Non-owner never sees the entry.
//
// FIXTURE AUTH + FIXTURE DATA: AuthContext and the Supabase client are replaced by in-memory
// fixtures. ceo-cash-expense-scan and the record/discard RPCs are mocked (scripted results and
// one record error); every other write is refused and recorded, and all non-local network is
// blocked. This proves the real page components render and wire correctly; it is not real-user
// acceptance and never touches real records.
//
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome node scripts/qa_ceo_cash.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-ceo-cash-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5208);
const { chromium } = createRequire(import.meta.url)(PW);
fs.mkdirSync(EVIDENCE, { recursive: true });

const SUPABASE_FIXTURE = `
const cfg = () => JSON.parse(localStorage.getItem("qa-shell") || "{}");
window.__qaWrites = window.__qaWrites || [];
window.__qaCalls = window.__qaCalls || [];
const WRITE = new Set(["insert", "update", "upsert", "delete"]);
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
const CATEGORIES = [
  { code: "OPEX_GENERAL", label: "Chi phí vận hành chung", sort_order: 1 },
  { code: "KITCHEN_SUPPLY_REPAIR", label: "Vật tư, sửa chữa bếp", sort_order: 2 },
  { code: "PACKAGING_SALES", label: "Bao bì bán hàng", sort_order: 3 },
  { code: "UNMAPPED_REVIEW", label: "Chưa phân loại (chờ duyệt)", sort_order: 99 },
];
const draft = (n, extra) => ({
  id: "draft-" + n, file_sha256: String(n).repeat(64), storage_path: "payment-unc/ceo-cash/2026/10/" + n + ".jpg",
  status: "draft", payee_name: null, matched_supplier_id: null, matched_supplier_name: null, expense_date: null,
  amount: null, description: null, cost_category_code: "UNMAPPED_REVIEW", items: [], ocr_error: null,
  payment_request_id: null, payment_id: null, evidence_id: null, ...extra,
});
// Per-image scan result, in pick order.
const SCANS = [
  { draft: draft(1, { payee_name: "Cửa hàng Điện máy Minh Phát", expense_date: today, amount: 1250000, description: "Mua quạt hút khói bếp", cost_category_code: "KITCHEN_SUPPLY_REPAIR" }) },
  { draft: draft(2, { ocr_error: "openai_http_500" }) },
  { duplicate: true, draft: draft(3, { status: "recorded", amount: 450000, payee_name: "Gas Thành Công", payment_request_id: "pr-old" }) },
  { error: "image_too_large" },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const edgeError = (status, code) => ({
  data: null,
  error: { message: "Edge Function returned a non-2xx status code", context: new Response(JSON.stringify({ success: false, code, error: code }), { status }) },
});
let recordN = 0;
function settle(st) {
  if (st.table === "cost_categories") return { data: CATEGORIES, error: null };
  if (st.table === "rpc:record_ceo_cash_expense") {
    window.__qaCalls.push({ fn: "record", ...st.args });
    if ((cfg().recordFail || []).includes(st.args.p_draft_id)) return { data: null, error: { message: "duplicate" } };
    recordN += 1;
    const id = st.args.p_draft_id;
    return { data: { payment_request_id: "pr-" + id, request_number: "PR-QA00" + recordN, payment_id: "pay-" + id, evidence_id: "ev-" + id, replayed: false }, error: null };
  }
  if (st.table === "rpc:discard_ceo_cash_expense_draft") {
    window.__qaCalls.push({ fn: "discard", ...st.args });
    return { data: { id: st.args.p_draft_id, status: "discarded" }, error: null };
  }
  if (st.table.startsWith("rpc:")) { window.__qaWrites.push(st.table); return { data: null, error: { message: "QA fixture: rpc disabled" } }; }
  if (st.write) { window.__qaWrites.push(st.table + ":" + st.write); return { data: null, error: { message: "QA fixture: writes disabled" }, count: null }; }
  if (st.head) return { data: null, error: null, count: 0 };
  if (st.single) return { data: null, error: null };
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
  window.__qaCalls.push({ fn: "invoke:" + name, size: body.image_base64 ? body.image_base64.length : 0, mime: body.mime_type });
  if (name !== "ceo-cash-expense-scan") { window.__qaWrites.push("invoke:" + name); return { data: null, error: { message: "QA fixture: functions disabled" } }; }
  const n = (window.__qaScanN = (window.__qaScanN || 0) + 1) - 1;
  await sleep(250 + 100 * n);
  const scan = (cfg().scans ? cfg().scans.map((i) => SCANS[i]) : SCANS)[n];
  if (!scan || scan.error) return edgeError(413, scan ? scan.error : "scan_failed");
  return { data: { success: true, duplicate: !!scan.duplicate, draft: scan.draft }, error: null };
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
  name: "qa-ceo-cash-fixtures",
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
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-ceo-cash-qa/vite-cache",
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
const dialogOverflow = (page) => page.$eval("[data-bmq-ceo-cash-dialog]", (el) => el.scrollWidth - el.clientWidth);
const bodies = (page) => page.evaluate(() => window.__qaBodies);

// Six small rendered "UNC" PNGs (different bytes each).
const SLIPS = [];
{
  const ctx = await browser.newContext({ viewport: { width: 420, height: 560 } });
  const p = await ctx.newPage();
  for (let i = 1; i <= 4; i += 1) {
    await p.setContent(`<body style="margin:0;font:24px sans-serif;background:#fff;padding:30px"><h3>HOÁ ĐƠN BÁN LẺ #${i}</h3><p>Tổng: ${i}00.000 đ</p></body>`);
    SLIPS.push({ name: `cash-${i}.png`, mimeType: "image/png", buffer: await p.screenshot() });
  }
  await ctx.close();
}

const DIALOG = "[data-bmq-ceo-cash-dialog]";
const rowStates = (page) => page.$$eval("[data-bmq-ceo-cash-row]", (els) => els.map((e) => e.getAttribute("data-bmq-ceo-cash-row")));
const calls = (page) => page.evaluate(() => window.__qaCalls);
// Every input/select inside the dialog stays within the dialog's content box.
const controlsInside = (page) => page.$eval(DIALOG, (dlg) => {
  const box = dlg.getBoundingClientRect();
  return [...dlg.querySelectorAll("input:not(.sr-only), select, button")]
    .filter((el) => el.offsetParent !== null)
    .filter((el) => { const r = el.getBoundingClientRect(); return r.left < box.left - 0.5 || r.right > box.right + 0.5; })
    .map((el) => el.outerHTML.slice(0, 80));
});

const WIDTHS = [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }];
try {
  for (const viewport of WIDTHS) {
    const w = viewport.width;
    const { context, page, errors } = await open({ role: "owner", recordFail: ["draft-2"] }, "/payment-requests", viewport);
    const entry = page.locator("[data-bmq-ceo-cash-entry]");
    await entry.waitFor();
    assert.ok(await overflowOk(page), `page overflow ${w}`);
    await page.screenshot({ path: `${EVIDENCE}/page-${w}.png` });

    await entry.click();
    await page.waitForSelector(`${DIALOG}[data-bmq-ceo-cash-dialog='pick']`);
    await page.waitForTimeout(250);
    await page.locator(DIALOG).screenshot({ path: `${EVIDENCE}/pick-${w}.png` });
    assert.equal(await page.locator("[data-bmq-ceo-cash-file]").getAttribute("multiple"), "", "file input allows many images");
    assert.equal(await page.locator("[data-bmq-ceo-cash-file]").getAttribute("capture"), null, "no capture attribute (iOS photo library)");

    await page.setInputFiles("[data-bmq-ceo-cash-file]", SLIPS);
    await page.waitForSelector(`${DIALOG}[data-bmq-ceo-cash-dialog='review']`, { timeout: 20000 });
    await page.waitForTimeout(300);
    assert.deepEqual(await rowStates(page), ["Sẽ ghi", "Cần sửa", "Đã ghi trước", "Lỗi"], (await rowStates(page)).join());
    const scans = (await calls(page)).filter((c) => c.fn === "invoke:ceo-cash-expense-scan");
    assert.equal(scans.length, 4, "four server reads");
    assert.ok(scans.every((s) => s.size > 0 && s.mime === "image/jpeg"), "images sent as JPEG base64");
    assert.equal((await calls(page)).filter((c) => c.fn === "record").length, 0, "nothing recorded before review");

    const rows = page.locator("[data-bmq-ceo-cash-row]");
    const text = await page.locator(DIALOG).textContent();
    assert.ok(text.includes("Ảnh này đã được ghi chi trước đó"), "duplicate image explained");
    assert.ok(text.includes("Ảnh quá lớn"), "scan error explained");
    assert.ok(text.includes("Chưa đọc được ảnh rõ"), "OCR failure asks for manual entry");
    assert.equal(await rows.nth(0).locator("[data-bmq-ceo-cash-category]").inputValue(), "KITCHEN_SUPPLY_REPAIR");
    assert.equal(await rows.nth(0).locator("[data-bmq-ceo-cash-amount]").inputValue(), "1.250.000");
    assert.equal(await rows.nth(2).locator("[data-bmq-ceo-cash-amount]").count(), 0, "recorded image is not editable");
    const confirmBtn = page.locator("[data-bmq-ceo-cash-confirm]");
    assert.ok((await confirmBtn.textContent()).includes("(1)"), await confirmBtn.textContent());
    assert.ok(await dialogOverflow(page) <= 0, `dialog overflow ${w}`);
    assert.deepEqual(await controlsInside(page), [], `controls overflow ${w}`);
    await page.locator(DIALOG).screenshot({ path: `${EVIDENCE}/review-${w}.png` });

    // CEO fills the unread voucher by hand.
    await rows.nth(1).locator("[data-bmq-ceo-cash-amount]").fill("85000");
    assert.equal(await rows.nth(1).locator("[data-bmq-ceo-cash-amount]").inputValue(), "85.000");
    await rows.nth(1).locator("[data-bmq-ceo-cash-description]").fill("Mua đá viên");
    await rows.nth(1).locator("[data-bmq-ceo-cash-category]").selectOption("OPEX_GENERAL");
    assert.deepEqual((await rowStates(page)).slice(0, 2), ["Sẽ ghi", "Sẽ ghi"]);
    assert.ok((await confirmBtn.textContent()).includes("(2)"));
    assert.ok((await page.locator(".d3-ub-foot p").textContent()).includes("1.335.000"), await page.locator(".d3-ub-foot p").textContent());

    // A future date is blocked until fixed.
    const date0 = rows.nth(0).locator("[data-bmq-ceo-cash-date]");
    const original = await date0.inputValue();
    await date0.fill("2099-01-01");
    assert.equal((await rowStates(page))[0], "Cần sửa");
    assert.ok((await rows.nth(0).textContent()).includes("tương lai"));
    assert.ok((await confirmBtn.textContent()).includes("(1)"));
    await date0.fill(original);
    // Untick then re-tick.
    await rows.nth(0).locator("[data-bmq-ceo-cash-tick]").click();
    assert.equal((await rowStates(page))[0], "Bỏ qua");
    assert.ok((await confirmBtn.textContent()).includes("(1)"));
    await rows.nth(0).locator("[data-bmq-ceo-cash-tick]").click();
    assert.ok((await confirmBtn.textContent()).includes("(2)"));
    assert.deepEqual(await controlsInside(page), [], `controls overflow after edit ${w}`);
    await page.locator(DIALOG).screenshot({ path: `${EVIDENCE}/review-edited-${w}.png` });

    await confirmBtn.click();
    await page.waitForSelector(`${DIALOG}[data-bmq-ceo-cash-dialog='done']`, { timeout: 20000 });
    await page.waitForTimeout(250);
    const records = (await calls(page)).filter((c) => c.fn === "record");
    assert.deepEqual(records.map((r) => r.p_draft_id), ["draft-1", "draft-2"]);
    assert.deepEqual(records.map((r) => r.p_idempotency_key), ["ceo-cash:draft-1", "ceo-cash:draft-2"]);
    assert.equal(records[0].p_fields.amount, 1250000);
    assert.equal(records[0].p_fields.cost_category_code, "KITCHEN_SUPPLY_REPAIR");
    assert.equal(records[1].p_fields.amount, 85000);
    assert.equal(records[1].p_fields.description, "Mua đá viên");
    assert.equal(records[1].p_fields.cost_category_code, "OPEX_GENERAL");
    assert.deepEqual(await rowStates(page), ["Đã ghi", "Lỗi", "Đã ghi trước", "Lỗi"], (await rowStates(page)).join());
    const doneText = await page.locator(DIALOG).textContent();
    assert.ok(doneText.includes("PR-QA001 · đã duyệt, đã chi tiền mặt, đã đính kèm chứng từ"), "saved row names the PR");
    assert.ok(doneText.includes("đã được ghi nhận trước đó"), "record error shown");
    assert.ok(doneText.includes("Đã ghi 1 khoản chi"));
    assert.ok(await dialogOverflow(page) <= 0, `done dialog overflow ${w}`);
    await page.locator(DIALOG).screenshot({ path: `${EVIDENCE}/done-${w}.png` });
    await page.locator("[data-bmq-ceo-cash-close]").click();
    await page.waitForSelector(DIALOG, { state: "detached" });
    const writes = await page.evaluate(() => window.__qaWrites);
    assert.deepEqual(writes, [], "no other writes: " + writes.join());
    assert.deepEqual(errors, [], `page errors ${w}`);
    console.log("PASS", `ceo cash ${w}`);
    await context.close();
  }

  // Discard one image: the draft is dropped and nothing can be recorded.
  {
    const { context, page, errors } = await open({ role: "owner", scans: [0] }, "/payment-requests", { width: 390, height: 844 });
    await page.locator("[data-bmq-ceo-cash-entry]").click();
    await page.setInputFiles("[data-bmq-ceo-cash-file]", SLIPS.slice(0, 1));
    await page.waitForSelector(`${DIALOG}[data-bmq-ceo-cash-dialog='review']`, { timeout: 20000 });
    await page.locator("[data-bmq-ceo-cash-discard]").click();
    await page.waitForFunction(() => document.querySelector("[data-bmq-ceo-cash-row]")?.getAttribute("data-bmq-ceo-cash-row") === "Đã bỏ");
    assert.deepEqual((await calls(page)).filter((c) => c.fn === "discard").map((c) => c.p_draft_id), ["draft-1"]);
    assert.ok(await page.locator("[data-bmq-ceo-cash-confirm]").isDisabled(), "nothing left to record");
    await page.locator(DIALOG).screenshot({ path: `${EVIDENCE}/discarded-390.png` });
    assert.deepEqual(errors, []);
    console.log("PASS", "discard one image");
    await context.close();
  }

  // Non-owner never sees the entry.
  {
    const { context, page, errors } = await open({ role: "accountant" }, "/payment-requests", { width: 390, height: 844 });
    await page.waitForSelector("[data-bmq-pr-view-unpaid]");
    await page.waitForTimeout(500);
    assert.equal(await page.locator("[data-bmq-ceo-cash-entry]").count(), 0);
    assert.deepEqual(errors, []);
    console.log("PASS", "accountant has no Chi tiền mặt entry");
    await context.close();
  }
  console.log("ALL PASS");
} finally {
  await browser.close();
  await server.close();
}
