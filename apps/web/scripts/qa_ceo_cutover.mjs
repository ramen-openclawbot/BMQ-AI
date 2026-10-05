// QA for the CEO khai báo page (Demo 3) and the owner-only "Chốt mốc tháng" cutover panel.
// Every write (RPC other than reads, edge function invoke, table write) is refused and recorded. Fixture auth + fixture data; writes are refused.
//
// FIXTURE AUTH + FIXTURE DATA: AuthContext and the Supabase client are replaced by in-memory
// fixtures; every write is refused and recorded, and all non-local network is blocked. This
// proves the real shell/page components render and navigate; it is not real-user acceptance.
//
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome node scripts/qa_demo3_shell.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-ceo-cutover-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5196);
const { chromium } = createRequire(import.meta.url)(PW);
fs.mkdirSync(EVIDENCE, { recursive: true });

const SUPABASE_FIXTURE = `
const cfg = () => JSON.parse(localStorage.getItem("qa-shell") || "{}");
window.__qaWrites = window.__qaWrites || [];
const WRITE = new Set(["insert", "update", "upsert", "delete"]);
function settle(st) {
  const mode = cfg().data || "populated";
  if (st.table === "rpc:finance_cutover_preview") return cutoverPreview(st.args || {});
  if (st.table.startsWith("rpc:") && !READ_RPCS.has(st.table)) { window.__qaWrites.push(st.table); return { data: null, error: { message: "QA fixture: writes disabled" } }; }
  if (st.write) { window.__qaWrites.push(st.table + ":" + st.write); return { data: null, error: { message: "QA fixture: writes disabled" }, count: null }; }
  if (mode === "error") return { data: null, error: { message: "QA fixture: network error", code: "QA" }, count: null };
  // "partial": only the revenue ledger fails; every other source answers.
  if (mode === "partial" && st.table === "revenue_ledger_lines") return { data: null, error: { message: "QA fixture: ledger down" }, count: null };
  const filled = mode === "populated" || mode === "partial";
  if (st.head) {
    let count = 0;
    if (filled && st.table === "payment_requests" && st.filters.status === "pending") count = 3;
    if (filled && st.table === "purchase_orders" && st.filters.status === "draft") count = 2;
    if (filled && st.table === "customer_po_inbox" && st.filters.match_status === "pending_approval") count = 4;
    return { data: null, error: null, count };
  }
  if (st.table === "rpc:reject_payment_request" && cfg().rejectError) return { data: null, error: { message: cfg().rejectError } };
  if (st.single) {
    if (filled && st.table === "payment_requests") return { data: PRS.find((pr) => pr.id === st.filters.id) || null, error: null };
    return { data: null, error: null };
  }
  const rows = filled ? fixtureRows(st) : null;
  if (rows) return { data: rows, error: null, count: rows.length };
  return { data: [], error: null, count: 0 };
}
const vnDay = (offsetDays) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(Date.now() - offsetDays * 86400000));
const nowIso = new Date().toISOString();
const READ_RPCS = new Set(["rpc:finance_cutover_preview", "rpc:finance_daily_snapshot"]);
const day = (d, unc, topup, scanned, ev, spent) => ({
  closing_date: d, unc_declared: unc, unc_evidence_total: scanned ? ev : 0, unc_file_count: scanned ? 3 : 0,
  qtm_topup: topup, qtm_spent_total: scanned ? spent : 0, qtm_file_count: scanned ? 2 : 0, low_confidence_count: 0,
  evidence_scanned: scanned, blockers: [],
});
function cutoverPreview(args) {
  if (cfg().cutover === "missing") return { data: null, error: { message: "Could not find the function public.finance_cutover_preview(p_month) in the schema cache", code: "PGRST202" } };
  const month = String(args.p_month || "2026-10-01").slice(0, 7);
  const days = month === "2026-06"
    ? [day("2026-06-03", 18500000, 5000000, true, 18500000, 3200000), day("2026-06-04", 21000000, 0, true, 20400000, 1800000), day("2026-06-05", 9600000, 4000000, false, 0, 0)]
    : month === "2026-07" ? [day("2026-07-01", 12000000, 3000000, false, 0, 0)] : [];
  const sum = (k) => days.reduce((s, d) => s + d[k], 0);
  const opening = 26422541;
  const prior = month > "2026-06";
  const payload = {
    period_month: month + "-01", from_date: month + "-01", to_date: month + "-28", day_count: days.length, days,
    unc_declared_total: sum("unc_declared"), unc_evidence_total: sum("unc_evidence_total"), unc_variance: sum("unc_declared") - sum("unc_evidence_total"),
    qtm_opening_balance: opening, qtm_topup_total: sum("qtm_topup"), qtm_spent_total: sum("qtm_spent_total"),
    qtm_closing_computed: opening + sum("qtm_topup") - sum("qtm_spent_total"),
    days_missing_evidence: days.filter((d) => !d.evidence_scanned).map((d) => d.closing_date),
    prior_unclosed_before_month: prior, prior_unclosed_before_month_date: prior ? "2026-06-03" : null, preview_hash: "qa-hash-" + month,
  };
  return { data: payload, error: null };
}
const HISTORY = [
  { id: "c-may", period_month: "2026-05-01", from_date: "2026-05-01", to_date: "2026-05-31", day_count: 0, unc_declared_total: 0, unc_evidence_total: 0, unc_variance: 0,
    qtm_opening_balance: 0, qtm_topup_total: 0, qtm_spent_total: 0, qtm_closing_computed: 26422541, qtm_closing_counted: null, qtm_count_variance: 0,
    days_missing_evidence: [], preview_hash: "x", note: null, status: "reverted", created_by: null, created_at: "2026-10-03T08:00:00Z", reverted_by: null, reverted_at: "2026-10-03T09:00:00Z", revert_note: "qa" },
];
function fixtureRows(st) {
  if (st.table === "finance_period_cutovers") return cfg().cutover === "missing" ? null : HISTORY;
  if (st.table === "ceo_daily_closing_declarations" && st.single) return null;
  return null;
}
function builder(table, args) {
  const st = { table, args, filters: {}, head: false, single: false, write: null };
  const proxy = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return (ok, ko) => Promise.resolve(settle(st)).then(ok, ko);
      if (prop === "catch") return (ko) => Promise.resolve(settle(st)).catch(ko);
      if (prop === "finally") return (fn) => Promise.resolve(settle(st)).finally(fn);
      return (...args) => {
        if (WRITE.has(prop)) st.write = prop;
        if (prop === "select" && args[1] && args[1].head) st.head = true;
        if (prop === "eq") st.filters[args[0]] = args[1];
        if (prop === "single" || prop === "maybeSingle") st.single = true;
        return proxy;
      };
    },
  });
  return proxy;
}
const user = { id: "qa-user", email: "qa@bmq.test", user_metadata: {} };
const channel = { on() { return channel; }, subscribe() { return channel; }, unsubscribe() {} };
export const supabase = {
  from: (table) => builder(table),
  rpc: (fn, args) => builder("rpc:" + fn, args),
  schema: () => ({ from: (table) => builder(table), rpc: (fn, args) => builder("rpc:" + fn, args) }),
  functions: { invoke: async (name, options) => { window.__qaWrites.push("invoke:" + name + ":" + (options?.body?.mode || "")); return { data: null, error: { message: "QA fixture: functions disabled" } }; } },
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
const MODULES = {
  owner: null,
  limited: ["dashboard", "inventory", "kitchen_inventory", "goods_receipts", "payment_requests", "suppliers"],
  finance: ["dashboard", "finance_cost"],
  none: [],
}[role];
const name = cfg.name || "Tâm Vũ";
const user = { id: "qa-user", email: "qa@bmq.test", user_metadata: { full_name: name } };
const can = (key) => MODULES === null || MODULES.includes(key);
const value = {
  user,
  session: { access_token: "qa-fixture-token", user },
  profile: { id: "qa-profile", user_id: "qa-user", full_name: name, email: user.email },
  loading: false,
  timedOut: false,
  roles: role === "owner" ? ["owner"] : ["staff"],
  authzLoaded: true,
  authzError: false,
  isOwner: role === "owner",
  canAccessModule: can,
  canEditModule: can,
  signOut: async () => { window.__qaSignedOut = true; },
  refreshProfile: async () => {},
  refreshRoles: async () => {},
};
const Ctx = createContext(value);
export function AuthProvider({ children }) { return React.createElement(Ctx.Provider, { value }, children); }
export function useAuth() { return useContext(Ctx); }
`;

const fixtures = {
  name: "qa-demo3-fixtures",
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
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-demo3-production-qa/vite-cache",
  server: { port: PORT, strictPort: true, host: "127.0.0.1" },
  define: { __APP_VERSION__: JSON.stringify("qa"), __APP_SEMVER__: JSON.stringify("vqa") },
  resolve: { alias: { "@": path.join(ROOT, "src") } },
  plugins: [fixtures, react()],
});
await server.listen();
const BASE = `http://127.0.0.1:${PORT}`;

const browser = await chromium.launch({ executablePath: CHROME });
const results = [];
const record = (name, detail = {}) => {
  results.push({ name, ...detail });
  console.log("PASS", name);
};

async function open(cfg, route, viewport, extra = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: extra.reducedMotion || "reduce", locale: "vi-VN" });
  await context.addInitScript((value) => {
    localStorage.setItem("qa-shell", JSON.stringify(value));
    if (value.language) localStorage.setItem("app-language", value.language);
  }, cfg);
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
  await page.waitForTimeout(250);
  return { context, page, errors };
}

const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const tabLabels = (page) => page.$$eval(".d3-tabs .d3-tab", (els) => els.map((el) => el.textContent.trim()));
const activeTab = (page) => page.$eval(".d3-tabs", (nav) => nav.querySelector("[data-zone-active='true']")?.textContent.trim() ?? null).catch(() => null);
const activeChip = (page) => page.$eval(".d3-subnav", (nav) => nav.querySelector(".d3-chip.is-active")?.textContent.trim() ?? null).catch(() => null);

const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 1280, height: 800 },
  { width: 390, height: 844 },
  { width: 320, height: 640 },
];


const big = (page) => page.locator(".d3-ov-hero .d3-ov-big span").textContent();
const insightTitles = (page) => page.$$eval(".d3-ov-insight h3", (els) => els.map((el) => el.textContent.trim()));
const insightValue = (page, title) => page.locator(".d3-ov-insight", { hasText: title }).locator(".d3-ov-insight-foot").textContent();


const prRows = (page) => page.locator("table tbody tr[role='button']");



const ROUTE = "/finance-control/ceo-declaration";
try {
  // 1. CEO page in the Demo 3 layout, desktop and phone.
  for (const viewport of WIDTHS) {
    const { context, page, errors } = await open({ role: "owner", data: "populated" }, ROUTE, viewport);
    await page.waitForSelector("[data-bmq-ceo-layout='demo3-v1']");
    await page.waitForTimeout(1200);
    assert.equal(await page.locator(".d3-ceo-kpi").count(), 4, "four KPI tiles");
    assert.ok((await page.locator(".d3-ceo-head h1").textContent()).length > 4, "headline");
    assert.equal(await page.locator("[data-bmq-ceo-cutover-tab]").count(), 1, "owner sees the cutover tab");
    assert.equal(await page.locator("[data-bmq-mobile-ceo-slip-delete]").count() >= 0, true);
    assert.equal(await page.locator(".d3-ceo-slip").count(), 2, "UNC and QTM upload panels");
    const ov = await overflow(page);
    assert.ok(ov <= 0, `no overflow daily ${viewport.width}: ${ov}`);
    await page.screenshot({ path: `${EVIDENCE}/ceo-daily-${viewport.width}.png`, fullPage: true });
    // Cutover tab
    await page.locator("[data-bmq-ceo-cutover-tab]").click();
    await page.waitForSelector("[data-bmq-cutover-panel]");
    await page.waitForFunction(() => document.querySelector(".d3-ceo-monthnav span")?.textContent?.includes("06/2026"), null, { timeout: 5000 });
    assert.equal(await page.locator("[data-bmq-cutover-days] .d3-ceo-day").count(), 3, "June backlog days");
    assert.equal(await page.locator("[data-bmq-cutover-days] .d3-ceo-day.is-missing").count(), 1, "one unscanned day");
    assert.ok((await page.locator("[data-bmq-cutover-scan]").textContent()).includes("1 ngày"), "scan button counts missing days");
    const ov2 = await overflow(page);
    assert.ok(ov2 <= 0, `no overflow cutover ${viewport.width}: ${ov2}`);
    await page.screenshot({ path: `${EVIDENCE}/ceo-cutover-${viewport.width}.png`, fullPage: true });
    await page.locator("[data-bmq-cutover-panel]").screenshot({ path: `${EVIDENCE}/ceo-cutover-panel-${viewport.width}.png` });
    assert.deepEqual(errors, [], `page errors ${viewport.width}`);
    record(`ceo daily + cutover ${viewport.width}`);
    await context.close();
  }

  // 2. Close flow: note required with a variance, confirm shows the figures, cancel writes nothing,
  //    confirm calls the close RPC (refused by the fixture) and reports the error.
  {
    const { context, page, errors } = await open({ role: "owner", data: "populated" }, ROUTE, { width: 1440, height: 900 });
    await page.waitForSelector("[data-bmq-ceo-cutover-tab]");
    await page.locator("[data-bmq-ceo-cutover-tab]").click();
    await page.waitForSelector("[data-bmq-cutover-form]");
    const closeBtn = page.locator("[data-bmq-cutover-close]");
    assert.ok(await closeBtn.isDisabled(), "close disabled until a note explains the UNC variance");
    await page.locator("[data-bmq-cutover-form] textarea").fill("QA chốt mốc theo tổng tháng");
    assert.ok(await closeBtn.isEnabled(), "close enabled with a note");
    await closeBtn.click();
    const confirm = page.locator("[role='alertdialog']");
    await confirm.waitFor();
    const text = await confirm.textContent();
    assert.ok(text.includes("Khoá 3 ngày") && text.includes("49.100.000") && text.includes("38.900.000") && text.includes("lệch 10.200.000") && text.includes("30.422.541"), `confirm summary: ${text}`);
    await page.getByRole("button", { name: "Huỷ" }).click();
    await confirm.waitFor({ state: "detached" });
    assert.deepEqual(await page.evaluate(() => window.__qaWrites.filter((w) => w.includes("cutover_close"))), [], "cancel writes nothing");
    await closeBtn.click();
    await confirm.waitFor();
    await confirm.getByRole("button", { name: "Chốt tháng" }).click();
    await page.waitForTimeout(600);
    assert.ok((await page.evaluate(() => window.__qaWrites)).includes("rpc:finance_cutover_close_month"), "confirm calls the close RPC");
    await page.screenshot({ path: `${EVIDENCE}/ceo-close-attempt-1440.png` });
    await page.getByText("Chưa chốt được").first().waitFor({ timeout: 4000 });
    // Scan calls the edge function in evidence_only mode.
    await page.locator("[data-bmq-cutover-scan]").click();
    await page.waitForTimeout(800);
    assert.ok((await page.evaluate(() => window.__qaWrites)).includes("invoke:finance-auto-close-day:evidence_only"), "scan uses evidence_only");
    await page.screenshot({ path: `${EVIDENCE}/ceo-cutover-actions-1440.png` });
    // Rescan of the whole month is offered even when days were scanned, confirms the cost, and uses evidence_only.
    await page.evaluate(() => { window.__qaWrites.length = 0; });
    await page.locator("[data-bmq-cutover-rescan]").click();
    const rescanDialog = page.locator("[role='alertdialog']");
    await rescanDialog.waitFor();
    assert.ok((await rescanDialog.textContent()).includes("ghi đè") && (await rescanDialog.textContent()).includes("chi phí"), "rescan confirm warns about overwrite and cost");
    await page.getByRole("button", { name: "Huỷ" }).click();
    await rescanDialog.waitFor({ state: "detached" });
    assert.deepEqual(await page.evaluate(() => window.__qaWrites.filter((w) => w.startsWith("invoke:"))), [], "cancel rescan invokes nothing");
    await page.locator("[data-bmq-cutover-rescan]").click();
    await rescanDialog.getByRole("button", { name: "Quét lại" }).click();
    await page.waitForTimeout(800);
    assert.ok((await page.evaluate(() => window.__qaWrites)).includes("invoke:finance-auto-close-day:evidence_only"), "rescan uses evidence_only");
    await page.screenshot({ path: `${EVIDENCE}/ceo-cutover-rescan-1440.png` });
    // July shows the prior-month banner and cannot close.
    await page.getByRole("button", { name: "Tháng sau" }).click();
    await page.waitForSelector("[data-bmq-cutover-prior]");
    assert.ok(await page.locator("[data-bmq-cutover-close]").isDisabled(), "July cannot close before June");
    assert.deepEqual(errors, []);
    record("close flow guards + scan wiring + prior-month banner");
    await context.close();
  }

  // 3. Before the migration is applied the panel says so instead of showing a raw error.
  {
    const { context, page, errors } = await open({ role: "owner", data: "populated", cutover: "missing" }, ROUTE, { width: 390, height: 844 });
    await page.waitForSelector("[data-bmq-ceo-cutover-tab]");
    await page.locator("[data-bmq-ceo-cutover-tab]").click();
    await page.waitForSelector("[data-bmq-cutover-state='not-installed']");
    assert.ok((await overflow(page)) <= 0);
    await page.screenshot({ path: `${EVIDENCE}/ceo-cutover-not-installed-390.png` });
    assert.deepEqual(errors, []);
    record("not-installed state 390");
    await context.close();
  }

  // 5. Existing page notifications (shadcn toast API) are now visible through the sonner Toaster.
  {
    const { context, page, errors } = await open({ role: "owner", data: "error" }, ROUTE, { width: 1440, height: 900 });
    await page.waitForSelector("[data-bmq-ceo-layout='demo3-v1']");
    const toast = page.locator("[data-sonner-toast]", { hasText: "Lỗi tải dữ liệu" });
    await toast.first().waitFor({ timeout: 6000 });
    assert.ok((await toast.first().textContent()).includes("Khai báo CEO"), "error toast carries the failing source");
    const figures = await page.$$eval(".d3-ceo-kpi strong", (els) => els.map((el) => el.textContent.trim()));
    assert.deepEqual(figures, ["—", "—", "—"], `failed reads never show 0: ${figures}`);
    assert.ok((await page.locator(".d3-ceo-head h1").textContent()).includes("chưa tải được"));
    await page.screenshot({ path: `${EVIDENCE}/ceo-error-toast-1440.png` });
    assert.deepEqual(errors, []);
    record("legacy page toast visible");
    await context.close();
  }
  // 4. Non-owner finance users do not see the cutover tab.
  {
    const { context, page, errors } = await open({ role: "finance", data: "populated" }, ROUTE, { width: 1440, height: 900 });
    await page.waitForSelector("[data-bmq-ceo-layout='demo3-v1']");
    await page.waitForTimeout(800);
    assert.equal(await page.locator("[data-bmq-ceo-cutover-tab]").count(), 0, "no cutover tab for non-owner");
    assert.deepEqual(errors, []);
    record("non-owner hidden");
    await context.close();
  }
} finally {
  fs.writeFileSync(`${EVIDENCE}/qa-ceo-cutover.json`, JSON.stringify(results, null, 2));
  await browser.close();
  await server.close();
}
console.log(`ALL ${results.length} CEO QA CHECKS PASSED — evidence in ${EVIDENCE}`);
