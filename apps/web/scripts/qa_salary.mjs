// QA for Chi lương (cash salary payout): owner creates from Chi tiền mặt → Chi lương, records
// the CEO transfer, uploads 4 bank slips (two equal salaries resolved by name, one unreadable typed
// by hand, one stray discarded), confirms → completed; at 390 / 320 / 1440. A staff member without
// quyền Chi lương sees neither the tab nor the page. FIXTURE AUTH + DATA; nothing real is written.
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core node scripts/qa_salary.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-salary-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5212);
const { chromium } = createRequire(import.meta.url)(PW);
fs.mkdirSync(EVIDENCE, { recursive: true });
const PAYOUT_ID = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

const SUPABASE_FIXTURE = `
const cfg = () => JSON.parse(localStorage.getItem("qa-shell") || "{}");
window.__qaWrites = window.__qaWrites || [];
window.__qaCalls = window.__qaCalls || [];
const WRITE = new Set(["insert", "update", "upsert", "delete"]);
const PAYOUT_ID = "${PAYOUT_ID}";
const STATE = JSON.parse(sessionStorage.getItem("qa-salary") || "null") || {
  payout: { id: PAYOUT_ID, payout_number: "SAL-261012-01", payroll_period_id: "per-1", period_name: "Kỳ lương T09/2026", employee_count: 3, total_amount: 23000000,
    status: "pending", ceo_evidence_storage_path: null, ceo_evidence_sha256: null, ceo_paid_at: null, ceo_paid_by: null, completed_at: null, completed_by: null, created_by: "qa-user", created_at: new Date().toISOString(), note: null },
  lines: [
    { id: "l-mai", payout_id: PAYOUT_ID, employee_code: "NV01", employee_name: "Nguyễn Thị Xuân Mai", net_pay: 8000000, receipt_storage_path: null, receipt_sha256: null, receipt_amount: null, receipt_beneficiary: null, receipt_reference: null, matched_at: null, matched_by: null },
    { id: "l-binh", payout_id: PAYOUT_ID, employee_code: "NV02", employee_name: "Trần Văn Bình", net_pay: 8000000, receipt_storage_path: null, receipt_sha256: null, receipt_amount: null, receipt_beneficiary: null, receipt_reference: null, matched_at: null, matched_by: null },
    { id: "l-hau", payout_id: PAYOUT_ID, employee_code: "NV03", employee_name: "Lê Văn Hậu", net_pay: 7000000, receipt_storage_path: null, receipt_sha256: null, receipt_amount: null, receipt_beneficiary: null, receipt_reference: null, matched_at: null, matched_by: null },
  ],
  receipts: [],
  attachments: [],
};
const save = () => sessionStorage.setItem("qa-salary", JSON.stringify(STATE));
const OCR = [ { amount: 8000000, ben: "TRAN VAN BINH" }, { amount: 8000000, ben: "NGUYEN THI XUAN MAI" }, { amount: null, ben: null }, { amount: 5000000, ben: "KHACH LE" } ];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const denied = () => cfg().role !== "owner" && !cfg().salary;
function settle(st) {
  if (st.table === "payroll_bn_payslips") return { data: [{ period_id: "per-1", period_name: "Kỳ lương T09/2026", published_at: "2026-10-05T00:00:00Z" }, { period_id: "per-0", period_name: "Kỳ lương T08/2026", published_at: null }], error: null };
  if (st.table === "rpc:create_salary_payout") { window.__qaCalls.push({ fn: "create", ...st.args }); return { data: { payout_id: PAYOUT_ID, payout_number: STATE.payout.payout_number, period_name: STATE.payout.period_name, employee_count: 3, total_amount: 23000000, status: "pending" }, error: null }; }
  if (st.table === "rpc:create_manual_salary_payout") { window.__qaCalls.push({ fn: "createManual", ...st.args }); STATE.payout.source = "manual"; STATE.payout.period_name = st.args.p_payload.title; save(); return { data: { payout_id: PAYOUT_ID, payout_number: STATE.payout.payout_number, period_name: st.args.p_payload.title, employee_count: st.args.p_payload.lines.length, total_amount: 0, status: "pending", source: "manual" }, error: null }; }
  if (st.table === "rpc:get_salary_payout") { if (denied()) return { data: null, error: { message: "insufficient_privilege" } }; return { data: JSON.parse(JSON.stringify(STATE)), error: null }; }
  if (st.table === "rpc:record_salary_payout_ceo_payment") { window.__qaCalls.push({ fn: "ceo", ...st.args }); STATE.payout.status = "advanced"; STATE.payout.ceo_evidence_storage_path = st.args.p_evidence.storage_path; STATE.payout.ceo_evidence_sha256 = st.args.p_evidence.file_sha256; save(); return { data: { payout_id: PAYOUT_ID, status: "advanced" }, error: null }; }
  if (st.table === "rpc:discard_salary_payout_receipt") { window.__qaCalls.push({ fn: "discard", ...st.args }); const r = STATE.receipts.find((x) => x.id === st.args.p_receipt_id); if (r) r.status = "discarded"; save(); return { data: { id: st.args.p_receipt_id, status: "discarded" }, error: null }; }
  if (st.table === "rpc:submit_salary_payout_matches") {
    window.__qaCalls.push({ fn: "submit", ...st.args });
    for (const m of st.args.p_matches) {
      const r = STATE.receipts.find((x) => x.id === m.receipt_id); const l = STATE.lines.find((x) => x.id === m.line_id);
      const amt = r && (r.ocr_amount ?? m.amount);
      if (!r || !l || r.status !== "uploaded" || l.receipt_storage_path || Number(amt) !== Number(l.net_pay)) return { data: null, error: { message: "amount_mismatch" } };
      r.status = "matched"; l.receipt_storage_path = r.storage_path; l.receipt_amount = amt; l.receipt_beneficiary = r.ocr_beneficiary;
    }
    if (STATE.lines.every((l) => l.receipt_storage_path)) STATE.payout.status = "completed";
    save();
    return { data: { payout_id: PAYOUT_ID, status: STATE.payout.status, matched_count: st.args.p_matches.length, remaining_count: STATE.lines.filter((l) => !l.receipt_storage_path).length }, error: null };
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
      return (...a) => { if (WRITE.has(prop)) st.write = prop; if (prop === "select" && a[1] && a[1].head) st.head = true; if (prop === "single" || prop === "maybeSingle") st.single = true; return proxy; };
    },
  });
  return proxy;
}
async function invoke(name, options) {
  const body = options?.body || {};
  window.__qaCalls.push({ fn: "invoke:" + name, mode: body.mode, payout_id: body.payout_id, size: (body.image_base64 || "").length });
  if (name !== "salary-payout") { window.__qaWrites.push("invoke:" + name); return { data: null, error: { message: "QA fixture: functions disabled" } }; }
  await sleep(150);
  if (body.mode === "attach") {
    window.__qaCalls.push({ fn: "attach", name: body.file_name, mime: body.mime_type });
    const a = { id: "at-" + (STATE.attachments.length + 1) + "-" + Date.now(), payout_id: body.payout_id, storage_path: body.payout_id + "/x", file_name: body.file_name, mime_type: body.mime_type, size_bytes: 2048, file_sha256: "a".repeat(64), uploaded_by: cfg().userId || "qa-user", created_at: new Date().toISOString() };
    STATE.attachments.push(a); save();
    return { data: { success: true, duplicate: false, attachment: a }, error: null };
  }
  if (body.mode === "detach") { window.__qaCalls.push({ fn: "detach", id: body.attachment_id }); STATE.attachments = STATE.attachments.filter((a) => a.id !== body.attachment_id); save(); return { data: { success: true, id: body.attachment_id, removed: true }, error: null }; }
  if (body.mode === "attachment_url") { window.__qaCalls.push({ fn: "url", id: body.attachment_id }); return { data: { success: true, signed_url: SVG, expires_in: 300 }, error: null }; }
  if (body.mode === "ceo_extract") return { data: { storage_path: "payment-unc/salary/2026/10/ceo.jpg", file_sha256: "c".repeat(64), ocr_amount: 23000000, ocr_reference: "FT1" }, error: null };
  const n = (window.__qaN = (window.__qaN || 0) + 1) - 1;
  const o = OCR[n];
  const receipt = { id: "rc-" + (n + 1), payout_id: PAYOUT_ID, storage_path: "payment-unc/salary/2026/10/" + (n + 1) + ".jpg", file_sha256: String(n + 1).repeat(64), ocr_amount: o.amount, ocr_beneficiary: o.ben, ocr_reference: null, ocr_error: o.amount ? null : "ocr_failed", status: "uploaded", uploaded_by: "qa-user", created_at: new Date().toISOString() };
  STATE.receipts.push(receipt); save();
  return { data: { success: true, duplicate: false, receipt }, error: null };
}
const SVG = "data:image/svg+xml," + encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' width='60' height='80'><rect width='60' height='80' fill='#c8d8e3'/></svg>");
const user = { id: cfg().userId || "qa-user", email: "qa@bmq.test", user_metadata: {} };
const channel = { on() { return channel; }, subscribe() { return channel; }, unsubscribe() {} };
export const supabase = {
  from: (table) => builder(table), rpc: (fn, args) => builder("rpc:" + fn, args),
  schema: () => ({ from: (table) => builder(table), rpc: (fn, args) => builder("rpc:" + fn, args) }),
  functions: { invoke },
  storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "" } }), createSignedUrl: async () => ({ data: { signedUrl: SVG }, error: null }), list: async () => ({ data: [], error: null }), upload: async () => ({ data: null, error: { message: "QA fixture: writes disabled" } }), download: async () => ({ data: null, error: null }) }) },
  auth: { getSession: async () => ({ data: { session: { access_token: "qa", user } }, error: null }), getUser: async () => ({ data: { user }, error: null }), onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), refreshSession: async () => ({ data: { session: { access_token: "qa", user } }, error: null }), signOut: async () => ({ error: null }) },
  channel: () => channel, removeChannel: () => {},
};
export default supabase;
`;

const AUTH_FIXTURE = `
import React, { createContext, useContext } from "react";
const cfg = JSON.parse(localStorage.getItem("qa-shell") || "{}");
const role = cfg.role || "owner";
const MODULES = { owner: null, staff: ["dashboard"], accountant: ["dashboard", "payment_requests", "goods_receipts", "suppliers", "finance_cost"] }[role];
const user = { id: cfg.userId || "qa-user", email: "qa@bmq.test", user_metadata: { full_name: "Tâm Vũ" } };
const can = (key) => MODULES === null || MODULES.includes(key) || (key === "salary_cash" && !!cfg.salary);
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
  name: "qa-salary-fixtures",
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
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-salary-qa/vite-cache",
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
  for (let i = 1; i <= 5; i += 1) {
    await p.setContent(`<body style="margin:0;font:24px sans-serif;background:#fff;padding:30px"><h3>SLIP ${i}</h3></body>`);
    SLIPS.push({ name: `s-${i}.png`, mimeType: "image/png", buffer: await p.screenshot() });
  }
  await ctx.close();
}
const PAGE = "[data-bmq-salary-page]";
const states = (page, sel) => page.$$eval(`[${sel}]`, (els, s) => els.map((e) => e.getAttribute(s)), sel);
const calls = (page) => page.evaluate(() => window.__qaCalls);
const pageOverflow = (page) => page.$eval(PAGE, (el) => el.scrollWidth - el.clientWidth);
try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 640 }, { width: 1440, height: 900 }]) {
    const w = viewport.width;
    const { context, page, errors } = await open({ role: "owner" }, "/payment-requests", viewport);
    await page.evaluate(() => sessionStorage.removeItem("qa-salary"));
    await page.locator("[data-bmq-salary-open]").first().click();
    await page.waitForSelector("[data-bmq-salary-period]");
    assert.equal(await page.locator("[data-bmq-salary-period]").count(), 1, "only the published period is offered");
    await page.locator("[data-bmq-salary-period]").click();
    assert.ok((await page.locator("[data-bmq-salary-dialog] .d3-unc-head").textContent()).includes("Tạo phiếu lương bếp Q7"), "Q7 header");
    assert.ok(await page.$eval("[data-bmq-salary-dialog]", (el) => el.scrollWidth - el.clientWidth) <= 0, `dialog overflow ${w}`);
    await page.locator("[data-bmq-salary-dialog]").screenshot({ path: `${EVIDENCE}/create-${w}.png` });
    await page.locator("[data-bmq-salary-create-save]").click();
    await page.waitForSelector(PAGE);
    await page.waitForSelector('[data-bmq-salary-status="pending"]');
    assert.equal((await calls(page)).filter((c) => c.fn === "create")[0].p_period_id, "per-1");
    assert.ok((await page.locator("[data-bmq-salary-total]").textContent()).includes("23.000.000"));
    assert.equal(await page.locator("[data-bmq-salary-docs] [data-bmq-salary-docs-pick]").count(), 1, "chứng từ can be added while pending");
    assert.ok(await pageOverflow(page) <= 0, `page overflow pending ${w}`);
    await page.screenshot({ path: `${EVIDENCE}/pending-${w}.png`, fullPage: true });

    await page.setInputFiles("[data-bmq-salary-ceo-file]", SLIPS.slice(0, 1));
    await page.locator("[data-bmq-salary-ceo-confirm]").waitFor();
    assert.ok((await page.locator(PAGE).textContent()).includes("Khớp tổng lương"));
    await page.locator("[data-bmq-salary-ceo-confirm]").click();
    await page.waitForSelector('[data-bmq-salary-status="advanced"]');
    const ceo = (await calls(page)).filter((c) => c.fn === "ceo");
    assert.equal(ceo.length, 1);
    assert.equal(ceo[0].p_evidence.ocr_amount, 23000000);

    await page.setInputFiles("[data-bmq-salary-slip-file]", SLIPS.slice(1, 5));
    await page.waitForFunction(() => document.querySelectorAll("[data-bmq-salary-receipt]").length === 4, null, { timeout: 20000 });
    await page.waitForTimeout(200);
    assert.deepEqual(await states(page, "data-bmq-salary-receipt"), ["auto", "auto", "open", "open"]);
    // Unreadable slip: type 7.000.000 and pick Lê Văn Hậu.
    const third = page.locator("[data-bmq-salary-receipt]").nth(2);
    await third.locator('input[aria-label="Số tiền trên bank slip"]').fill("7000000");
    await third.locator("[data-bmq-salary-assign]").selectOption("l-hau");
    assert.equal((await states(page, "data-bmq-salary-receipt"))[2], "manual");
    // Stray 5.000.000 slip discarded.
    await page.locator("[data-bmq-salary-receipt]").nth(3).locator('button[aria-label="Bỏ bank slip"]').click();
    await page.waitForFunction(() => document.querySelectorAll("[data-bmq-salary-receipt]").length === 3);
    assert.ok(await pageOverflow(page) <= 0, `page overflow advanced ${w}`);
    await page.screenshot({ path: `${EVIDENCE}/advanced-${w}.png`, fullPage: true });
    await page.locator("[data-bmq-salary-submit]").click();
    await page.waitForSelector('[data-bmq-salary-status="completed"]', { timeout: 20000 });
    const submit = (await calls(page)).filter((c) => c.fn === "submit")[0];
    const pairs = submit.p_matches.map((m) => `${m.receipt_id}>${m.line_id}${m.amount ? ":" + m.amount : ""}`).sort();
    assert.deepEqual(pairs, ["rc-1>l-binh", "rc-2>l-mai", "rc-3>l-hau:7000000"], pairs.join());
    assert.deepEqual(await states(page, "data-bmq-salary-line"), ["done", "done", "done"]);
    assert.equal(await page.locator("[data-bmq-salary-slip-pick]").count(), 0);
    assert.equal(await page.locator("[data-bmq-salary-docs-pick]").count(), 0, "no adding chứng từ after completed");
    await page.screenshot({ path: `${EVIDENCE}/completed-${w}.png`, fullPage: true });
    const writes = await page.evaluate(() => window.__qaWrites);
    assert.deepEqual(writes, [], "no other writes: " + writes.join());
    assert.deepEqual(errors, [], `page errors ${w}`);
    console.log("PASS", `salary ${w}`);
    await context.close();
  }
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 640 }]) {
    const w = viewport.width;
    const { context, page, errors } = await open({ role: "accountant", salary: true }, "/payment-requests", viewport);
    await page.evaluate(() => sessionStorage.removeItem("qa-salary"));
    await page.locator("[data-bmq-salary-open]").first().click();
    await page.locator('[data-bmq-salary-kind="manual"]').click();
    const head = await page.locator("[data-bmq-salary-dialog] .d3-unc-head").textContent();
    assert.ok(head.includes("Tạo phiếu lương lẻ") && head.includes("ngoài bếp Q7") && !head.includes("bảng lương Q7"), head);
    assert.match(await page.locator("[data-bmq-salary-manual-title]").inputValue(), /^Lương lẻ T\d\d\/\d{4}$/);
    await page.locator("[data-bmq-salary-manual-amount]").first().fill("4500000");
    await page.locator("[data-bmq-salary-manual-save]").click();
    assert.ok((await page.locator("[data-bmq-salary-create]").textContent()).includes("chưa nhập tên"), "blank name blocked");
    assert.equal((await page.evaluate(() => window.__qaCalls)).filter((c) => c.fn === "createManual").length, 0);
    await page.locator("[data-bmq-salary-manual-name]").first().fill("Phạm Thị Lan");
    await page.locator("[data-bmq-salary-manual-add]").click();
    await page.locator("[data-bmq-salary-manual-name]").nth(1).fill("Võ Minh Tú");
    await page.locator("[data-bmq-salary-manual-amount]").nth(1).fill("3200000");
    assert.ok((await page.locator("[data-bmq-salary-create] .d3-ub-foot").textContent()).includes("7.700.000"));
    await page.setInputFiles("[data-bmq-salary-docs-picker] [data-bmq-salary-docs-file]", [
      { name: "Bang luong le T10 voi ten file rat dai de kiem tra cat chu.xlsx", mimeType: "", buffer: Buffer.from("PK fake xlsx") },
      { name: "bang-luong.png", mimeType: "image/png", buffer: SLIPS[0].buffer },
      { name: "hop-dong.docx", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", buffer: Buffer.from("x") },
    ]);
    assert.equal(await page.locator("[data-bmq-salary-doc-pending]").count(), 2, "docx rejected, xlsx (no type) + png kept");
    assert.ok(await page.$eval("[data-bmq-salary-dialog]", (el) => el.scrollWidth - el.clientWidth) <= 0, `manual dialog overflow ${w}`);
    await page.locator("[data-bmq-salary-dialog]").screenshot({ path: `${EVIDENCE}/manual-${w}.png` });
    await page.locator("[data-bmq-salary-manual-save]").click();
    await page.waitForSelector(PAGE);
    const cm = (await page.evaluate(() => window.__qaCalls)).filter((c) => c.fn === "createManual");
    assert.equal(cm.length, 1);
    assert.deepEqual(cm[0].p_payload.lines.map((l) => [l.employee_name, l.amount]), [["Phạm Thị Lan", 4500000], ["Võ Minh Tú", 3200000]]);
    assert.ok(cm[0].p_idempotency_key.startsWith("salary-manual:"));
    await page.waitForFunction(() => document.querySelector(".d3-csp-head .d3-up-tag")?.textContent?.startsWith("Lương lẻ"));
    const att = (await page.evaluate(() => window.__qaCalls)).filter((c) => c.fn === "attach");
    assert.deepEqual(att.map((c) => c.mime), ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "image/png"]);
    await page.waitForFunction(() => document.querySelectorAll("[data-bmq-salary-doc]").length === 2);
    assert.deepEqual(await states(page, "data-bmq-salary-doc"), ["excel", "image"]);
    // Image opens in the viewer; Excel asks for a signed link (download).
    await page.locator('[data-bmq-salary-doc="image"] .d3-sal-doc-open').click();
    await page.waitForSelector(".d3-unc-ev-zoom img");
    await page.keyboard.press("Escape");
    const popup = page.context().waitForEvent("page", { timeout: 5000 }).catch(() => null);
    await page.locator('[data-bmq-salary-doc="excel"] .d3-sal-doc-open').click();
    await popup;
    await page.waitForFunction(() => window.__qaCalls.filter((c) => c.fn === "url").length === 2, null, { timeout: 5000 });
    assert.ok(await pageOverflow(page) <= 0, `page overflow docs ${w}`);
    await page.locator("[data-bmq-salary-docs]").screenshot({ path: `${EVIDENCE}/docs-${w}.png` });
    // Uploader removes one, then adds a PDF from the page.
    await page.locator('[data-bmq-salary-doc="image"] [data-bmq-salary-doc-remove]').click();
    await page.waitForFunction(() => document.querySelectorAll("[data-bmq-salary-doc]").length === 1);
    await page.setInputFiles("[data-bmq-salary-docs] [data-bmq-salary-docs-file]", [{ name: "bang-ky.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4") }]);
    await page.waitForFunction(() => document.querySelectorAll("[data-bmq-salary-doc]").length === 2);
    assert.deepEqual(await states(page, "data-bmq-salary-doc"), ["excel", "pdf"]);
    await page.screenshot({ path: `${EVIDENCE}/manual-page-${w}.png`, fullPage: true });
    assert.deepEqual(errors, []);
    console.log("PASS", `manual salary ${w}`);
    await context.close();
  }
  {
    const { context, page, errors } = await open({ role: "accountant" }, "/payment-requests", { width: 390, height: 844 });
    assert.equal(await page.locator("[data-bmq-salary-open]").count(), 0, "no Chi lương button without permission");
    await page.locator("[data-bmq-cash-pr-open]").first().click();
    await page.waitForSelector("[data-bmq-cash-pr-dialog]");
    assert.equal(await page.locator("[data-bmq-cash-pr-dialog] [role=tab]").count(), 0, "cash dialog has no salary tabs");
    await page.goto(page.url().replace(/\/payment-requests.*$/, `/salary-payouts/${PAYOUT_ID}`));
    await page.waitForSelector("[data-bmq-salary-denied]");
    assert.deepEqual(errors, []);
    console.log("PASS", "no salary access without permission");
    await context.close();
  }
  {
    const { context, page, errors } = await open({ role: "accountant", salary: true }, "/payment-requests", { width: 390, height: 844 });
    assert.equal(await page.locator("[data-bmq-salary-open]").count(), 1, "Chi lương button with permission");
    await page.screenshot({ path: `${EVIDENCE}/entry-390.png` });
    await page.locator("[data-bmq-cash-pr-open]").first().click();
    await page.waitForSelector("[data-bmq-cash-pr-dialog]");
    assert.equal(await page.locator("[data-bmq-cash-pr-dialog] [role=tab]").count(), 0, "cash dialog is khoản chi only");
    await page.locator("[data-bmq-cash-pr-dialog]").screenshot({ path: `${EVIDENCE}/cash-only-390.png` });
    assert.deepEqual(errors, []);
    console.log("PASS", "KTT with quyền Chi lương sees the Chi lương button; cash dialog has no tabs");
    await context.close();
  }
  console.log("ALL PASS");
} finally {
  await browser.close();
  await server.close();
}
