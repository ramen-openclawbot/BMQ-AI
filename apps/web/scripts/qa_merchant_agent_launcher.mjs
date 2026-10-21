// QA for the owner chat launcher (owner 22/10: "Icon chat box kích thước khác nhau ở màn bán hàng,
// tới hàng duyệt chi thì biến mất"). On every main page and at phone, tablet and desktop widths the
// launcher must be visible, the same size, inside the viewport, on top, and must not cover a
// control that stays put (fixed or sticky bars, the Tạo PO button, the docked phiếu panel).
//
// FIXTURE AUTH + FIXTURE DATA: same in-memory AuthContext/Supabase fixtures as
// qa_merchant_agent_chat.mjs; payment_requests returns sample phiếu so the docked detail panel
// opens. All other non-local network is blocked; nothing is written.
//
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome node scripts/qa_merchant_agent_launcher.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-merchant-launcher-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5217);
const AGENT = "https://bmq-agent.vnagent.ai";
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
  if (st.table === "rpc:set_dealer_order_lock") {
    window.__qaBodies.push({ name: "set_dealer_order_lock", ...(st.args || {}) });
    return { data: { customer_id: st.args?.p_customer_id, order_locked: !!st.args?.p_locked, revoked_sessions: st.args?.p_locked ? 2 : 0 }, error: null };
  }
  if (st.table.startsWith("rpc:")) return { data: null, error: null };
  if (st.write) { window.__qaWrites.push(st.table + ":" + st.write); return { data: null, error: { message: "QA fixture: writes disabled" }, count: null }; }
  if (st.head) return { data: null, error: null, count: 0 };
  if (st.single) return { data: st.table === "payment_requests" ? PRS.find((r) => r.id === st.filters.id) || null : null, error: null };
  if (st.table === "payment_requests") return { data: PRS, error: null, count: PRS.length };
  if (st.table === "mini_crm_customers") return { data: CUSTOMERS, error: null, count: CUSTOMERS.length };
  return { data: [], error: null, count: 0 };
}
const CUSTOMERS = [
  { id: "cus-open", customer_name: "Đại lý Hồng Phát", customer_code: "DL-001", customer_group: "dealer", product_group: "banh_mi", is_active: true, is_npp: false, order_locked: false, address: "12 Lê Lợi", debt_emails: [], npp_management_fee_vnd: 0, mini_crm_customer_emails: [], dealer_customer_contacts: [{ id: "ct1", customer_id: "cus-open", contact_name: "Chị Hồng", phone_normalized: "84901234567", is_active: true, is_primary: true, is_test: false }] },
  { id: "cus-locked", customer_name: "Đại lý Minh Châu", customer_code: "DL-002", customer_group: "dealer", product_group: "banh_mi", is_active: true, is_npp: false, order_locked: true, order_locked_at: new Date(Date.now() - 3600000).toISOString(), order_lock_reason: "Nợ quá hạn tháng 9", address: "5 Hai Bà Trưng", debt_emails: [], npp_management_fee_vnd: 0, mini_crm_customer_emails: [], dealer_customer_contacts: [] },
];
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
  window.__qaBodies.push({ name, ...body });
  const c = cfg();
  if (name === "dealer-auth-start") {
    if (c.dealer === "locked") return { data: { otp_required: false, reason: "dealer_order_locked", code: "dealer_order_locked", message: "Đặt Hàng đang tạm khoá. Quý khách hàng vui lòng thanh toán công nợ để mở lại. Trân trọng." }, error: null };
    return { data: { otp_required: true, message: "Mã OTP đã được gửi qua Zalo." }, error: null };
  }
  return { data: null, error: { message: "QA fixture: functions disabled" } };
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
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-merchant-launcher-qa/vite-cache",
  server: { port: PORT, strictPort: true, host: "127.0.0.1" },
  define: { "import.meta.env.VITE_SUPABASE_URL": JSON.stringify("https://qa.supabase.test"), "import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY": JSON.stringify("qa-anon"), __APP_VERSION__: JSON.stringify("qa"), __APP_SEMVER__: JSON.stringify("vqa") },
  resolve: { alias: { "@": path.join(ROOT, "src") } },
  plugins: [fixtures, react()],
});
await server.listen();
const BASE = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({ executablePath: CHROME });
const results = [];
const record = (name) => { results.push({ name }); console.log("PASS", name); };

const PAGES = [
  "/",
  "/finance-control/revenue",
  "/finance-control/revenue/points",
  "/mini-crm",
  "/sales-po-inbox",
  "/payment-requests",
  "/payment-requests?id=11111111-1111-4111-8111-111111111111",
  "/finance-control/payables",
  "/finance-control/classification",
  "/finance",
  "/purchase-orders",
  "/goods-receipts",
  "/warehouse/danh-muc",
  "/warehouse/phieu",
  "/production/planning/q7",
  "/production/products",
  "/sku-costs/dashboard",
  "/sku-costs/analysis",
  "/material-master",
];
const VIEWPORTS = [{ width: 390, height: 844 }, { width: 820, height: 1180 }, { width: 1440, height: 900 }];
const SIZE = 56;

// Launcher geometry plus any control under it that does not scroll away (fixed/sticky).
function probe() {
  const launcher = document.querySelector("[data-merchant-agent-launcher]");
  if (!launcher) return { missing: true };
  const style = getComputedStyle(launcher);
  const rect = launcher.getBoundingClientRect();
  const box = { x: rect.x, y: rect.y, w: rect.width, h: rect.height };
  const visible = style.display !== "none" && style.visibility !== "hidden" && rect.width > 0;
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  const top = document.elementFromPoint(cx, cy);
  const onTop = Boolean(top && launcher.contains(top));
  const pinned = (el) => {
    for (let node = el; node && node !== document.body; node = node.parentElement) {
      const position = getComputedStyle(node).position;
      if (position === "fixed" || position === "sticky") return true;
    }
    return false;
  };
  const conflicts = [];
  launcher.style.visibility = "hidden";
  for (const el of document.querySelectorAll("button, a[href], input, select, textarea, [role='button'], [role='tab']")) {
    if (launcher.contains(el)) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const ix = Math.max(rect.left, r.left), iy = Math.max(rect.top, r.top);
    const ax = Math.min(rect.right, r.right), ay = Math.min(rect.bottom, r.bottom);
    if (ax - ix < 2 || ay - iy < 2) continue;
    const hit = document.elementFromPoint((ix + ax) / 2, (iy + ay) / 2);
    if (!hit || !(el === hit || el.contains(hit))) continue;
    if (!pinned(el)) continue;
    conflicts.push((el.getAttribute("aria-label") || el.textContent || el.tagName).trim().slice(0, 40));
  }
  launcher.style.visibility = "";
  // A modal phiếu dialog covers the whole page, launcher included; that is expected (the
  // back-to-chat pill handles it). The docked Duyệt chi panel is not modal.
  const modal = [...document.querySelectorAll("[role='dialog']")].some((d) => !d.matches("[data-merchant-agent-chat], .d3-pr-panel"));
  return { box, visible, onTop, conflicts, modal, vw: innerWidth, vh: innerHeight };
}

const report = [];
const failures = [];
try {
  for (const viewport of VIEWPORTS) {
    const context = await browser.newContext({ viewport, reducedMotion: "reduce", locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" });
    await context.addInitScript(() => localStorage.setItem("qa-shell", JSON.stringify({ role: "owner" })));
    await context.route("**/*", (r) => {
      const url = r.request().url();
      if (url.startsWith(BASE) || url.startsWith("data:") || url.startsWith("blob:") || /fonts\.(googleapis|gstatic)\.com/.test(url)) return r.continue();
      return r.abort();
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    for (const route of PAGES) {
      const tag = `${route} @${viewport.width}`;
      await page.goto(BASE + route, { waitUntil: "domcontentloaded" });
      await page.locator("[data-merchant-agent-launcher]").waitFor({ state: "attached", timeout: 30000 });
      await page.waitForTimeout(900);
      const result = await page.evaluate(probe);
      report.push({ route, width: viewport.width, ...result });
      const problems = [];
      if (result.missing || !result.visible) problems.push("hidden");
      else {
        if (Math.round(result.box.w) !== SIZE || Math.round(result.box.h) !== SIZE) problems.push(`size ${Math.round(result.box.w)}x${Math.round(result.box.h)}`);
        if (result.box.x < 0 || result.box.y < 0 || result.box.x + result.box.w > result.vw || result.box.y + result.box.h > result.vh) problems.push("outside viewport");
        if (!result.modal && !result.onTop) problems.push("covered");
        if (!result.modal && result.conflicts.length) problems.push(`covers ${result.conflicts.join(" | ")}`);
      }
      const shot = `${EVIDENCE}/${viewport.width}${route.replace(/[/?=]+/g, "_")}.png`;
      await page.screenshot({ path: shot });
      if (problems.length) { failures.push(`${tag}: ${problems.join("; ")}`); console.log("FAIL", tag, problems.join("; ")); }
      else record(`launcher ${tag}`);
    }
    // The cost-classification save bar only shows while editing, which the fixture cannot reach:
    // mount the same markup and check the launcher moves clear of Cancel/Save.
    await page.goto(BASE + "/finance-control/classification", { waitUntil: "domcontentloaded" });
    await page.locator("[data-merchant-agent-launcher]").waitFor({ state: "attached", timeout: 30000 });
    await page.evaluate(() => {
      const bar = document.createElement("div");
      bar.setAttribute("data-bmq-bottom-bar", "save");
      bar.className = "fixed inset-x-0 bottom-0 z-50 border-t bg-background/95 px-4 py-3 shadow-lg backdrop-blur";
      bar.innerHTML = '<div class="mx-auto flex max-w-5xl flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div class="text-sm"><div class="font-medium">Đã thay đổi 12 dòng phân loại</div><div class="text-xs text-muted-foreground">Save để lưu nhóm, mã chuẩn và alias tự áp dụng cho PR/invoice sau này.</div></div><div class="flex gap-2 sm:justify-end"><button class="h-10 rounded-md border px-4">Cancel</button><button class="h-10 rounded-md bg-primary px-4 text-primary-foreground">Save</button></div></div>';
      document.body.appendChild(bar);
    });
    await page.waitForTimeout(300);
    const saveBar = await page.evaluate(probe);
    const barTop = await page.evaluate(() => document.querySelector("[data-bmq-bottom-bar='save']").getBoundingClientRect().top);
    const saveTag = `classification save bar @${viewport.width}`;
    if (!saveBar.visible || !saveBar.onTop || saveBar.conflicts.length || saveBar.box.y + saveBar.box.h > barTop) failures.push(`${saveTag}: ${JSON.stringify({ ...saveBar, barTop })}`);
    else record(`launcher clears the ${saveTag}`);
    await page.screenshot({ path: `${EVIDENCE}/${viewport.width}_classification_save_bar.png` });

    if (errors.length) failures.push(`page errors @${viewport.width}: ${errors.slice(0, 3).join(" / ")}`);
    await context.close();
  }
} finally {
  fs.writeFileSync(`${EVIDENCE}/qa-merchant-launcher.json`, JSON.stringify({ results, failures, report }, null, 2));
  await browser.close();
  await server.close();
}
assert.deepEqual(failures, [], failures.join("\n"));
console.log(`ALL ${results.length} MERCHANT LAUNCHER QA CHECKS PASSED — evidence in ${EVIDENCE}`);
