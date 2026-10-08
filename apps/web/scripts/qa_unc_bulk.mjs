// QA for Up nhiều UNC on the Trình chi gấp page: pick six UNC images at once, server read
// (mocked), matcher proposals (matched / ambiguous / unmatched / OCR error), CEO review, and
// sequential confirm of only the ticked UNCs, at 1440 / 390 / 320.
//
// FIXTURE AUTH + FIXTURE DATA: AuthContext and the Supabase client are replaced by in-memory
// fixtures. payment-unc-approve is mocked (OCR results and one confirm error are scripted);
// every other write is refused and recorded, and all non-local network is blocked. This proves
// the real page components render and wire correctly; it is not real-user acceptance and never
// touches real records.
//
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome node scripts/qa_unc_bulk.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-unc-bulk-qa";
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
const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date());
const item = (pos, id, number, supplierId, supplierName, amount, hour) => ({
  payment_request_id: id, position: pos, remaining_at_submit: amount, request_number: number,
  title: "Duyệt chi PO PO-000" + (700 + pos), supplier_id: supplierId, supplier_name: supplierName,
  total_amount: amount, allocated_amount: 0, remaining_amount: amount, status: "pending", payment_status: "unpaid",
  requires_receipt: true, created_at: today + "T0" + hour + ":00:00.000Z",
});
const ITEMS = [
  item(1, "a1", "PR-2D245F45", "sup-mt", "Mỹ Toàn", 6156000, 1),
  item(2, "b1", "PR-C9FC7EF1", "sup-tp", "Tiến Phát", 1080000, 2),
  item(3, "c1", "PR-A16B44F3", "sup-sg", "Sài Gòn EFP", 1042200, 3),
  item(4, "d1", "PR-97F65838", "sup-bb", "Bao bì Minh Tuấn", 12600000, 1),
  item(5, "d2", "PR-83E9FE2D", "sup-bb", "Bao bì Minh Tuấn", 10800000, 2),
  item(6, "e1", "PR-5E5E0001", "sup-ta", "Thiên An Sinh", 500000, 3),
  item(7, "f1", "PR-6F6F0002", "sup-hp", "Hòa Phát", 500000, 4),
];
// Per-image OCR, in pick order. null = OCR failure.
const OCR = [
  { amount: 6156000, beneficiary_name: "CONG TY TNHH MY TOAN", transfer_content: "BMQ thanh toan tien hang", reference: "FT26281000001" },
  { amount: 1080000, beneficiary_name: null, transfer_content: "BMQ TT PR-C9FC7EF1", reference: "FT26281000002" },
  { amount: 23400000, beneficiary_name: "BAO BI MINH TUAN", transfer_content: "TT 2 don bao banh mi", reference: "FT26281000003" },
  { amount: 500000, beneficiary_name: null, transfer_content: null, reference: "FT26281000004" },
  { amount: 999000, beneficiary_name: "NGUYEN VAN B", transfer_content: null, reference: "FT26281000005" },
  null,
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const edgeError = (status, code) => ({
  data: null,
  error: { message: "Edge Function returned a non-2xx status code", context: new Response(JSON.stringify({ success: false, code, error: code }), { status }) },
});
function settle(st) {
  if (st.table === "rpc:get_payment_submission") {
    return { data: { id: "sub-1", submission_number: "TC-261008-02", note: "Chi gấp trước 15h", total_amount: ITEMS.reduce((s, i) => s + i.remaining_at_submit, 0), created_by: "acc-user", created_at: today + "T03:00:00.000Z", items: ITEMS }, error: null };
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
  if (name !== "payment-unc-approve") return { data: null, error: { message: "QA fixture: functions disabled" } };
  if (body.mode === "extract") {
    const n = (window.__qaExtractN = (window.__qaExtractN || 0) + 1) - 1;
    await sleep(250 + 120 * n);
    const ocr = OCR[n];
    if (!ocr) return edgeError(502, "ocr_failed");
    const sha = String(n + 1).repeat(64);
    return { data: { success: true, mode: "extract", file_sha256: sha, storage_path: "payment-unc/2026/10/" + sha + ".jpg",
      suggested_idempotency_key: "unc:" + sha,
      ocr: { amount: ocr.amount, amount_raw: null, amount_in_words: null, reference: ocr.reference, transfer_date: today,
        confidence: 0.96, amount_corrected_from_words: false, beneficiary_name: ocr.beneficiary_name, transfer_content: ocr.transfer_content } }, error: null };
  }
  if (body.mode === "confirm") {
    await sleep(250);
    if ((cfg().confirmFail || []).includes(body.file_sha256)) return edgeError(409, "duplicate_reference");
    return { data: { success: true, mode: "confirm", result: { status: "approved", payment_id: "pay-" + body.file_sha256.slice(0, 4), payment_request_ids: body.request_ids, amount: body.amount, idempotent: false } }, error: null };
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
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-unc-bulk-qa/vite-cache",
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
const dialogOverflow = (page) => page.$eval("[data-bmq-unc-bulk-dialog]", (el) => el.scrollWidth - el.clientWidth);
const bodies = (page) => page.evaluate(() => window.__qaBodies);

// Six small rendered "UNC" PNGs (different bytes each).
const SLIPS = [];
{
  const ctx = await browser.newContext({ viewport: { width: 420, height: 560 } });
  const p = await ctx.newPage();
  for (let i = 1; i <= 6; i += 1) {
    await p.setContent(`<body style="margin:0;font:24px sans-serif;background:#fff;padding:30px"><h3>ỦY NHIỆM CHI #${i}</h3><p>Số tiền: ${i},000,000 VND</p></body>`);
    SLIPS.push({ name: `unc-${i}.png`, mimeType: "image/png", buffer: await p.screenshot() });
  }
  await ctx.close();
}

const WIDTHS = [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }];
try {
  for (const viewport of WIDTHS) {
    const w = viewport.width;
    const { context, page, errors } = await open({ role: "owner", confirmFail: ["2".repeat(64)] }, "/payment-requests/submissions/sub-1", viewport);
    await page.waitForSelector("[data-bmq-submission-row]");
    const entry = page.locator("[data-bmq-submission-bulk-unc]");
    await entry.waitFor();
    assert.ok(await overflowOk(page), `page overflow ${w}`);
    await page.screenshot({ path: `${EVIDENCE}/page-${w}.png` });

    await entry.click();
    await page.waitForSelector("[data-bmq-unc-bulk-dialog='pick']");
    await page.waitForTimeout(250);
    await page.locator("[data-bmq-unc-bulk-dialog]").screenshot({ path: `${EVIDENCE}/pick-${w}.png` });
    assert.equal(await page.locator("[data-bmq-unc-bulk-file]").getAttribute("multiple"), "", "file input allows many images");
    assert.equal(await page.locator("[data-bmq-unc-bulk-file]").getAttribute("capture"), null, "no capture attribute (iOS photo library)");

    await page.setInputFiles("[data-bmq-unc-bulk-file]", SLIPS);
    await page.waitForSelector("[data-bmq-unc-bulk-dialog='reading']");
    await page.waitForSelector("[data-bmq-unc-bulk-dialog='review']", { timeout: 20000 });
    await page.waitForTimeout(250);

    const statuses = await page.$$eval("[data-bmq-unc-bulk-row]", (els) => els.map((e) => e.getAttribute("data-bmq-unc-bulk-row")));
    assert.deepEqual(statuses, ["matched", "matched", "matched", "ambiguous", "unmatched", "error"], statuses.join());
    const extracts = (await bodies(page)).filter((b) => b.mode === "extract");
    assert.equal(extracts.length, 6, "six server reads");
    assert.ok((await bodies(page)).every((b) => b.mode !== "confirm"), "nothing is paid before review");

    // Sure matches are ticked by default; the ambiguous one waits for a choice.
    const confirmBtn = page.locator("[data-bmq-unc-bulk-confirm]");
    assert.ok((await confirmBtn.textContent()).includes("(3)"), await confirmBtn.textContent());
    assert.ok((await page.locator(".d3-ub-foot p").textContent()).includes("30.636.000"), await page.locator(".d3-ub-foot p").textContent());
    assert.ok(await dialogOverflow(page) <= 0, `dialog overflow ${w}`);
    await page.locator("[data-bmq-unc-bulk-dialog]").screenshot({ path: `${EVIDENCE}/review-${w}.png` });

    // CEO picks Thiên An for the 500.000 đ UNC.
    const amb = page.locator("[data-bmq-unc-bulk-row='ambiguous']");
    assert.equal(await amb.locator("[data-bmq-unc-bulk-option]").count(), 2);
    await amb.locator("[data-bmq-unc-bulk-option]", { hasText: "Thiên An" }).click();
    assert.ok((await confirmBtn.textContent()).includes("(4)"));
    // Untick then re-tick a sure match: the choice is respected.
    const firstOpt = page.locator("[data-bmq-unc-bulk-row]").first().locator("[data-bmq-unc-bulk-option]");
    await firstOpt.click();
    assert.ok((await confirmBtn.textContent()).includes("(3)"));
    await firstOpt.click();
    assert.ok((await confirmBtn.textContent()).includes("(4)"));
    await page.locator("[data-bmq-unc-bulk-dialog]").screenshot({ path: `${EVIDENCE}/review-picked-${w}.png`, fullPage: false });

    await confirmBtn.click();
    await page.waitForSelector("[data-bmq-unc-bulk-dialog='done']", { timeout: 20000 });
    await page.waitForTimeout(250);
    const confirms = (await bodies(page)).filter((b) => b.mode === "confirm");
    assert.deepEqual(confirms.map((c) => c.request_ids), [["a1"], ["b1"], ["d1", "d2"], ["e1"]], JSON.stringify(confirms.map((c) => c.request_ids)));
    assert.deepEqual(confirms.map((c) => c.idempotency_key), ["1", "2", "3", "4"].map((d) => "unc:" + d.repeat(64)));
    assert.deepEqual(confirms[2].allocations, [{ payment_request_id: "d1", amount: 12600000 }, { payment_request_id: "d2", amount: 10800000 }]);
    const after = await page.$$eval("[data-bmq-unc-bulk-row]", (els) => els.map((e) => e.getAttribute("data-bmq-unc-bulk-row")));
    assert.deepEqual(after, ["done", "error", "done", "done", "unmatched", "error"], after.join());
    assert.ok((await page.locator("[data-bmq-unc-bulk-dialog]").textContent()).includes("Mã giao dịch này đã được dùng trước đó"));
    assert.ok((await page.locator("[data-bmq-unc-bulk-row]").nth(3).textContent()).includes("Đã ghi chi PR-5E5E0001 (Thiên An Sinh)"), "manual pick shows the paid phiếu");
    assert.ok(await dialogOverflow(page) <= 0, `done dialog overflow ${w}`);
    await page.locator("[data-bmq-unc-bulk-dialog]").screenshot({ path: `${EVIDENCE}/done-${w}.png` });
    await page.locator("[data-bmq-unc-bulk-close]").click();
    await page.waitForSelector("[data-bmq-unc-bulk-dialog]", { state: "detached" });
    const writes = await page.evaluate(() => window.__qaWrites.filter((x) => !x.startsWith("invoke:payment-unc-approve")));
    assert.deepEqual(writes, [], "no other writes: " + writes.join());
    assert.deepEqual(errors, [], `page errors ${w}`);
    console.log("PASS", `bulk UNC ${w}`);
    await context.close();
  }

  // Non-owner never sees the bulk entry.
  {
    const { context, page, errors } = await open({ role: "accountant" }, "/payment-requests/submissions/sub-1", { width: 390, height: 844 });
    await page.waitForSelector("[data-bmq-submission-row]");
    assert.equal(await page.locator("[data-bmq-submission-bulk-unc]").count(), 0);
    assert.deepEqual(errors, []);
    console.log("PASS", "accountant has no bulk UNC entry");
    await context.close();
  }
  console.log("ALL PASS");
} finally {
  await browser.close();
  await server.close();
}
