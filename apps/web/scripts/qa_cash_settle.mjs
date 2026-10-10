// QA for Chi tiền mặt — nộp chứng từ chi lẻ (/payment-requests/cash-settle/:id): upload
// several receipts (server read mocked), auto-match by amount incl. one khoản covered by two
// receipts, type the amount of an unreadable receipt and assign it by hand, discard a stray
// receipt, confirm, and see "Hoàn tất chi tiền mặt", at 1440 / 390 / 320. A user without
// payment_requests edit who did not create the phiếu sees it read-only.
//
// FIXTURE AUTH + FIXTURE DATA: AuthContext and the Supabase client are replaced by in-memory
// fixtures; payment-cash-settle and the settlement RPCs are simulated in the page; all
// non-local network is blocked. Not real-user acceptance; never touches real records.
//
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome node scripts/qa_cash_settle.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-cash-settle-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5209);
const { chromium } = createRequire(import.meta.url)(PW);
fs.mkdirSync(EVIDENCE, { recursive: true });
const PR_ID = "5e0c7a3e-1d2b-4c3d-9e8f-0a1b2c3d4e5f";

const SUPABASE_FIXTURE = `
const cfg = () => JSON.parse(localStorage.getItem("qa-shell") || "{}");
window.__qaWrites = window.__qaWrites || [];
window.__qaCalls = window.__qaCalls || [];
const WRITE = new Set(["insert", "update", "upsert", "delete"]);
const PR = { id: "${PR_ID}", request_number: "PR-QACASH01", title: "Chi phí hôm nay", description: null, status: "approved",
  payment_status: "paid", payment_method: "cash", total_amount: 1102000, supplier_id: null, supplier_name: null,
  created_by: "staff-mai", requester_name: "Xuan Mai", cash_settlement_status: "awaiting_receipts", cash_settled_at: null, cash_settled_by: null };
const ITEMS = [
  { id: "i-water", product_name: "Tiền nước uống Q7", amount: 252000, covered: 0 },
  { id: "i-glass", product_name: "Thay kính bụi viện", amount: 400000, covered: 0 },
  { id: "i-ship", product_name: "Ship hộp + bao giấy", amount: 130000, covered: 0 },
  { id: "i-fuel", product_name: "Xăng xe tháng 9", amount: 320000, covered: 0 },
];
const RECEIPTS = [];
// OCR result per upload, in pick order; null = unreadable.
const OCR = [252000, 400000, 81000, 49000, null, 55000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settlement = () => ({ payment_request: { ...PR }, items: ITEMS.map((i) => ({ ...i })), receipts: RECEIPTS.map((r) => ({ ...r })), evidence: [], attachments: [] });
function settle(st) {
  if (st.table === "rpc:get_cash_settlement") return { data: settlement(), error: null };
  if (st.table === "rpc:get_payment_request_unc_evidence") return { data: [], error: null };
  if (st.table === "rpc:discard_cash_receipt") {
    window.__qaCalls.push({ fn: "discard", ...st.args });
    const r = RECEIPTS.find((x) => x.id === st.args.p_receipt_id); if (r) r.status = "discarded";
    return { data: { id: st.args.p_receipt_id, status: "discarded" }, error: null };
  }
  if (st.table === "rpc:submit_cash_settlement") {
    window.__qaCalls.push({ fn: "submit", ...st.args });
    for (const a of st.args.p_allocations) {
      const r = RECEIPTS.find((x) => x.id === a.receipt_id); const it = ITEMS.find((x) => x.id === a.item_id);
      if (!r || r.status !== "uploaded" || !it || it.covered + a.amount > it.amount) return { data: null, error: { message: "invalid_allocation" } };
      r.status = "allocated"; r.payment_request_item_id = a.item_id; r.amount = a.amount; it.covered += a.amount;
    }
    const done = ITEMS.every((i) => i.covered >= i.amount);
    if (done) PR.cash_settlement_status = "completed";
    return { data: { status: PR.cash_settlement_status, covered_total: ITEMS.reduce((s, i) => s + i.covered, 0), remaining_total: 0, items: [] }, error: null };
  }
  if (st.table === "payment_request_attachments") return { data: [], error: null };
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
        if (prop === "single" || prop === "maybeSingle") st.single = true;
        return proxy;
      };
    },
  });
  return proxy;
}
async function invoke(name, options) {
  const body = options?.body || {};
  window.__qaCalls.push({ fn: "invoke:" + name, mode: body.mode, request_id: body.request_id, size: (body.image_base64 || "").length });
  if (name !== "payment-cash-settle") { window.__qaWrites.push("invoke:" + name); return { data: null, error: { message: "QA fixture: functions disabled" } }; }
  const n = (window.__qaN = (window.__qaN || 0) + 1) - 1;
  await sleep(200 + 80 * n);
  const amount = OCR[n];
  const receipt = { id: "rc-" + (n + 1), payment_request_item_id: null, storage_path: "payment-unc/cash-receipts/2026/10/" + (n + 1) + ".jpg",
    file_sha256: String(n + 1).repeat(64), ocr_amount: amount, ocr_payee: amount ? "Người nhận " + (n + 1) : null, ocr_date: null, ocr_reference: null,
    ocr_content: null, ocr_error: amount ? null : "ocr_failed", amount, status: "uploaded", uploaded_by: "staff-mai", created_at: new Date().toISOString(), allocated_at: null };
  RECEIPTS.push(receipt);
  return { data: { success: true, duplicate: false, receipt }, error: null };
}
const SVG = "data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='60' height='80'><rect width='60' height='80' fill='#cfe3c8'/></svg>");
const user = { id: cfg().userId || "qa-user", email: "qa@bmq.test", user_metadata: {} };
const channel = { on() { return channel; }, subscribe() { return channel; }, unsubscribe() {} };
export const supabase = {
  from: (table) => builder(table),
  rpc: (fn, args) => builder("rpc:" + fn, args),
  schema: () => ({ from: (table) => builder(table), rpc: (fn, args) => builder("rpc:" + fn, args) }),
  functions: { invoke },
  storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "" } }), createSignedUrl: async () => ({ data: { signedUrl: SVG }, error: null }), list: async () => ({ data: [], error: null }), upload: async () => ({ data: null, error: { message: "QA fixture: writes disabled" } }), download: async () => ({ data: null, error: null }) }) },
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
const MODULES = { owner: null, staff: ["dashboard"], accountant: ["dashboard", "payment_requests", "goods_receipts", "suppliers", "finance_cost"] }[role];
const user = { id: cfg.userId || "qa-user", email: "qa@bmq.test", user_metadata: { full_name: "Tâm Vũ" } };
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
  name: "qa-cash-settle-fixtures",
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
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-cash-settle-qa/vite-cache",
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

// Six small rendered "UNC" PNGs (different bytes each).
const SLIPS = [];
{
  const ctx = await browser.newContext({ viewport: { width: 420, height: 560 } });
  const p = await ctx.newPage();
  for (let i = 1; i <= 6; i += 1) {
    await p.setContent(`<body style="margin:0;font:24px sans-serif;background:#fff;padding:30px"><h3>CHỨNG TỪ #${i}</h3></body>`);
    SLIPS.push({ name: `r-${i}.png`, mimeType: "image/png", buffer: await p.screenshot() });
  }
  await ctx.close();
}
const ROUTE = `/payment-requests/cash-settle/${PR_ID}`;
const calls = (page) => page.evaluate(() => window.__qaCalls);
const panelOverflow = (page) => page.$eval("[data-bmq-cash-settle-page]", (el) => el.scrollWidth - el.clientWidth);
const controlsInside = (page) => page.$eval("[data-bmq-cash-settle-page]", (root) => {
  const box = root.getBoundingClientRect();
  return [...root.querySelectorAll("input:not(.sr-only), select, button")].filter((el) => el.offsetParent !== null)
    .filter((el) => { const r = el.getBoundingClientRect(); return r.left < box.left - 0.5 || r.right > box.right + 0.5; })
    .map((el) => el.outerHTML.slice(0, 80));
});
const states = (page, sel) => page.$$eval(`[${sel}]`, (els, s) => els.map((e) => e.getAttribute(s)), sel);

const WIDTHS = [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }];
try {
  for (const viewport of WIDTHS) {
    const w = viewport.width;
    const { context, page, errors } = await open({ role: "accountant" }, ROUTE, viewport);
    await page.waitForSelector("[data-bmq-cash-settle='awaiting_receipts']");
    assert.equal((await page.locator("[data-bmq-cash-settle-status]").textContent()).trim(), "Chờ chứng từ chi lẻ");
    assert.deepEqual(await states(page, "data-bmq-cash-settle-item"), ["open", "open", "open", "open"]);
    assert.equal(await page.locator("[data-bmq-cash-settle-file]").getAttribute("multiple"), "");
    assert.equal(await page.locator("[data-bmq-cash-settle-file]").getAttribute("capture"), null);
    assert.ok(await overflowOk(page), `page overflow ${w}`);
    await page.screenshot({ path: `${EVIDENCE}/start-${w}.png`, fullPage: true });

    await page.setInputFiles("[data-bmq-cash-settle-file]", SLIPS);
    await page.waitForFunction(() => document.querySelectorAll("[data-bmq-cash-settle-receipt]").length === 6, null, { timeout: 20000 });
    await page.waitForTimeout(300);
    const extracts = (await calls(page)).filter((c) => c.fn === "invoke:payment-cash-settle");
    assert.equal(extracts.length, 6);
    assert.ok(extracts.every((c) => c.mode === "extract" && c.request_id === PR_ID && c.size > 0));
    // 252k, 400k and 81k+49k (shipping) match by amount; the unreadable and the 55k one wait.
    assert.deepEqual(await states(page, "data-bmq-cash-settle-receipt"), ["auto", "auto", "auto", "auto", "open", "open"]);
    const confirmBtn = page.locator("[data-bmq-cash-settle-confirm]");
    assert.ok((await confirmBtn.textContent()).includes("(4)"), await confirmBtn.textContent());
    assert.ok(await panelOverflow(page) <= 0, `panel overflow ${w}`);
    assert.deepEqual(await controlsInside(page), [], `controls overflow ${w}`);
    await page.screenshot({ path: `${EVIDENCE}/matched-${w}.png`, fullPage: true });

    // Unreadable fuel receipt: type the amount and assign it to Xăng by hand.
    const fuel = page.locator("[data-bmq-cash-settle-receipt]").nth(4);
    await fuel.locator("[data-bmq-cash-settle-amount]").fill("320000");
    await fuel.locator("[data-bmq-cash-settle-assign]").selectOption("i-fuel");
    assert.deepEqual((await states(page, "data-bmq-cash-settle-receipt"))[4], "manual");
    assert.ok((await confirmBtn.textContent()).includes("(5)"));
    assert.ok((await page.locator(".d3-cs-foot").textContent()).includes("đủ, sẽ hoàn tất"));
    // The stray 55k receipt is discarded.
    await page.locator("[data-bmq-cash-settle-receipt]").nth(5).locator("[data-bmq-cash-settle-discard]").click();
    await page.waitForFunction(() => document.querySelectorAll("[data-bmq-cash-settle-receipt]").length === 5);
    assert.deepEqual((await calls(page)).filter((c) => c.fn === "discard").map((c) => c.p_receipt_id), ["rc-6"]);
    assert.deepEqual(await controlsInside(page), [], `controls overflow after edit ${w}`);
    await page.screenshot({ path: `${EVIDENCE}/ready-${w}.png`, fullPage: true });

    await confirmBtn.click();
    await page.waitForSelector("[data-bmq-cash-settle='completed']", { timeout: 20000 });
    const submits = (await calls(page)).filter((c) => c.fn === "submit");
    assert.equal(submits.length, 1);
    assert.equal(submits[0].p_request_id, PR_ID);
    const alloc = submits[0].p_allocations.map((a) => `${a.receipt_id}>${a.item_id}:${a.amount}`).sort();
    assert.deepEqual(alloc, ["rc-1>i-water:252000", "rc-2>i-glass:400000", "rc-3>i-ship:81000", "rc-4>i-ship:49000", "rc-5>i-fuel:320000"], alloc.join());
    assert.ok(submits[0].p_idempotency_key.startsWith(`cash-settle:${PR_ID}:`));
    assert.equal((await page.locator("[data-bmq-cash-settle-status]").textContent()).trim(), "Hoàn tất chi tiền mặt");
    assert.deepEqual(await states(page, "data-bmq-cash-settle-item"), ["done", "done", "done", "done"]);
    assert.equal(await page.locator("[data-bmq-cash-settle-pick]").count(), 0, "no upload after completion");
    assert.equal(await page.locator(".d3-cs-strip img").count(), 5, "every receipt shown under its khoản");
    assert.ok(await panelOverflow(page) <= 0, `done overflow ${w}`);
    await page.screenshot({ path: `${EVIDENCE}/completed-${w}.png`, fullPage: true });
    const writes = await page.evaluate(() => window.__qaWrites);
    assert.deepEqual(writes, [], "no other writes: " + writes.join());
    assert.deepEqual(errors, [], `page errors ${w}`);
    console.log("PASS", `cash settle ${w}`);
    await context.close();
  }

  // A user without payment_requests edit who did not create the phiếu sees it read-only.
  {
    const { context, page, errors } = await open({ role: "staff" }, ROUTE, { width: 390, height: 844 });
    await page.waitForSelector("[data-bmq-cash-settle='awaiting_receipts']");
    assert.equal(await page.locator("[data-bmq-cash-settle-pick]").count(), 0);
    assert.equal(await page.locator("[data-bmq-cash-settle-confirm]").count(), 0);
    assert.deepEqual(errors, []);
    console.log("PASS", "read-only without edit permission");
    await context.close();
  }
  // The creator can upload even without payment_requests edit.
  {
    const { context, page, errors } = await open({ role: "staff", userId: "staff-mai" }, ROUTE, { width: 390, height: 844 });
    await page.waitForSelector("[data-bmq-cash-settle='awaiting_receipts']");
    assert.equal(await page.locator("[data-bmq-cash-settle-pick]").count(), 1);
    assert.deepEqual(errors, []);
    console.log("PASS", "creator can upload");
    await context.close();
  }
  console.log("ALL PASS");
} finally {
  await browser.close();
  await server.close();
}
