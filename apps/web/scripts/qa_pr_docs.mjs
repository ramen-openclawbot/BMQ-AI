// QA: the "Hóa đơn mua hàng" picker in Tạo đề nghị chi accepts several invoices at once;
// "Scan N hóa đơn" scans each one and adds every khoản to the phiếu; the dialog never
// scrolls sideways at 390 (the item table scrolls inside itself). FIXTURE AUTH +
// FIXTURE DATA (same in-memory Supabase/Auth fixtures as qa_cash_settle.mjs); nothing is saved.
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core node scripts/qa_pr_docs.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-pr-docs-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5210);
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
  name: "qa-pr-docs-fixtures",
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
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-pr-docs-qa/vite-cache",
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
const SHOTS = [];
{
  const ctx = await browser.newContext({ viewport: { width: 420, height: 560 } });
  const p = await ctx.newPage();
  for (let i = 1; i <= 3; i += 1) {
    await p.setContent(`<body style="margin:0;font:24px sans-serif;background:#fff;padding:30px"><h3>ẢNH ${i}</h3></body>`);
    SHOTS.push({ name: `IMG_53${40 + i}.png`, mimeType: "image/png", buffer: await p.screenshot() });
  }
  await ctx.close();
}
try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 640 }, { width: 1440, height: 900 }]) {
    const { context, page, errors } = await open({ role: "owner" }, "/payment-requests", viewport);
    // Default tab (Chưa thanh toán) has its own create button.
    const trigger = page.locator("[data-bmq-pr-create-unpaid] button.d3-pa-primary");
    await trigger.waitFor({ timeout: 20000 });
    assert.ok(await overflowOk(page), `page overflow ${viewport.width}`);
    await page.screenshot({ path: `${EVIDENCE}/unpaid-tab-${viewport.width}.png` });
    await trigger.click();

    const overflowers = async () => page.evaluate(() => {
      const dlg = document.querySelector('[role="dialog"]');
      const box = dlg.getBoundingClientRect();
      return { sw: dlg.scrollWidth, cw: dlg.clientWidth, wide: [...dlg.querySelectorAll("*")].filter((el) => el.getBoundingClientRect().right > box.right + 1 && el.offsetParent !== null && ![...el.children].some((c) => c.getBoundingClientRect().right > box.right + 1)).filter((el) => !(el instanceof SVGElement) && !el.closest("[data-bmq-pr-invoices]") && !["H2","P"].includes(el.tagName)).slice(0, 10).map((el) => el.tagName + "." + String(el.className).slice(0, 60) + " " + Math.round(el.getBoundingClientRect().right)) };
    });
    { const o = await overflowers(); assert.ok(o.sw <= o.cw, `dialog overflow before ${viewport.width}: ${JSON.stringify(o)}`); }
    // scan-invoice is called with fetch: answer each of the 3 invoices with its own khoản.
    const SCANS = [
      { supplier_name: "Siêu Tốc", items: [{ product_name: "Ship hộp", quantity: 1, unit: "lần", unit_price: 49000 }] },
      { supplier_name: "Siêu Tốc", items: [{ product_name: "Ship bao giấy", quantity: 1, unit: "lần", unit_price: 81000 }] },
      { supplier_name: "Nước 2H", invoice_number: "159680", items: [{ product_name: "Nước Bidrico 19L", quantity: 6, unit: "bình", unit_price: 42000 }] },
    ];
    let scanN = 0;
    const scanBodies = [];
    await page.route("**/functions/v1/scan-invoice", async (route) => {
      scanBodies.push(JSON.parse(route.request().postData() || "{}"));
      const data = SCANS[scanN++];
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ data }) });
    });
    const input = page.locator("[data-bmq-pr-image-input]");
    await input.waitFor({ state: "attached" });
    await page.waitForTimeout(250);
    await page.locator("[data-bmq-pr-create-dialog]").screenshot({ path: `${EVIDENCE}/dlg-empty-${viewport.width}.png` });
    assert.equal(await input.getAttribute("multiple"), "", "main picker allows many photos");
    await input.setInputFiles(SHOTS);
    await page.waitForSelector('[data-bmq-pr-invoices="3"]');
    assert.equal(await page.locator("[data-bmq-pr-invoices] img").count(), 3, "three invoice thumbnails");
    assert.equal(await page.locator("[data-bmq-pr-docs-list]").count(), 0, "invoices are not dumped into Chứng từ kèm theo");
    const scanBtn = page.getByRole("button", { name: /Scan 3 hóa đơn/ });
    await scanBtn.click();
    await page.waitForFunction(() => document.querySelectorAll('input[name^="items."][name$=".product_name"]').length === 3, null, { timeout: 20000 });
    const names = await page.$$eval('input[name^="items."][name$=".product_name"]', (els) => els.map((e) => e.value));
    assert.deepEqual(names, ["Ship hộp", "Ship bao giấy", "Nước Bidrico 19L"], names.join());
    assert.equal(scanBodies.length, 3, "each invoice scanned");
    assert.ok(scanBodies.every((b) => b.imageBase64 && b.documentType === "payment_request"));
    await page.locator("[data-bmq-pr-item]").first().scrollIntoViewIfNeeded();
    await page.locator("[data-bmq-pr-create-dialog]").screenshot({ path: `${EVIDENCE}/dlg-items-${viewport.width}.png` });
    // Payment method chips switch the form value (UNC <-> Tiền mặt) and never submit the form.
    await page.locator("#payment_cash").click();
    assert.equal(await page.locator("#payment_cash").getAttribute("aria-checked"), "true");
    assert.ok((await page.locator("[data-bmq-pr-create-dialog]").textContent()).includes("CEO chuyển tiền cho người đề nghị"));
    await page.locator("#payment_unc").click();
    assert.equal(await page.locator("#payment_unc").getAttribute("aria-checked"), "true");
    assert.equal(await page.locator("[data-bmq-pr-create-dialog]").count(), 1, "dialog still open");
    await page.locator("[data-bmq-pr-submit]").scrollIntoViewIfNeeded();
    await page.locator("[data-bmq-pr-create-dialog]").screenshot({ path: `${EVIDENCE}/dlg-foot-${viewport.width}.png` });
    { const o = await overflowers(); assert.ok(o.sw <= o.cw, `dialog overflow after scan ${viewport.width}: ${JSON.stringify(o)}`); }
    await page.screenshot({ path: `${EVIDENCE}/pr-docs-${viewport.width}.png` });
    assert.deepEqual(errors, []);
    console.log("PASS", `pr docs ${viewport.width}`);
    await context.close();
  }
  console.log("ALL PASS");
} finally {
  await browser.close();
  await server.close();
}
