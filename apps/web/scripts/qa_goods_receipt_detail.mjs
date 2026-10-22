// Browser QA for the compact "Chi tiết phiếu nhập kho" dialog (owner 22/10: rút gọn mô tả).
// Opens a confirmed receipt (receive mode) and a finalized one with a payable at 390/1440 and checks:
// no duplicated info block, no raw "{}" variance, no OCR step cards, payable facts only when present,
// the receive actions still exist, no horizontal overflow. Screenshots of the whole dialog body.
//
// FIXTURE AUTH + FIXTURE DATA: AuthContext and the Supabase client are replaced by in-memory
// fixtures; every write is refused and recorded, and all non-local network is blocked. This
// proves the real shell/page components render and navigate; it is not real-user acceptance.
//
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome node scripts/qa_goods_receipt_detail.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-gr-detail-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5262);
const { chromium } = createRequire(import.meta.url)(PW);
fs.mkdirSync(EVIDENCE, { recursive: true });

const SUPABASE_FIXTURE = `
const cfg = () => JSON.parse(localStorage.getItem("qa-shell") || "{}");
window.__qaWrites = window.__qaWrites || [];
const WRITE = new Set(["insert", "update", "upsert", "delete"]);
function settle(st) {
  const mode = cfg().data || "populated";
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
  if (st.single && st.table === "goods_receipts") return { data: RECEIPTS.find((r) => r.id === st.filters.id) ?? null, error: null };
  if (st.single) return { data: null, error: null };
  const rows = filled ? fixtureRows(st) : null;
  if (rows) return { data: rows, error: null, count: rows.length };
  return { data: [], error: null, count: 0 };
}
const vnDay = (offsetDays) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(Date.now() - offsetDays * 86400000));
const supplier = { id: "s1", name: "Bao bì Minh Tuấn" };
const RECEIPTS = [
  { id: "gr-a", receipt_number: "GRN-000465", status: "confirmed", payable_status: null, receipt_date: vnDay(0), supplier_id: "s1", suppliers: supplier,
    purchase_orders: { id: "po-1", po_number: "PO-000812", status: "approved" }, payment_requests: null, finalized_at: null, variance_summary: {}, image_url: null, product_photos: [], notes: null, created_at: new Date().toISOString() },
  { id: "gr-b", receipt_number: "GRN-000466", status: "received", payable_status: "generated", receipt_date: vnDay(0), supplier_id: "s1", suppliers: supplier,
    purchase_orders: { id: "po-2", po_number: "PO-000813", status: "approved" }, payment_requests: { id: "pr-1", request_number: "PR-002031", status: "approved", total_amount: 1260000, payment_status: "unpaid" },
    finalized_at: "2026-08-11T09:30:00Z", variance_summary: { thieu: 1 }, image_url: null, product_photos: [], notes: null, created_at: new Date().toISOString() },
];
const ITEMS = {
  "gr-a": [{ id: "it-a1", goods_receipt_id: "gr-a", product_name: "Túi PE 50x70", quantity: 70000, ordered_quantity: 70000, actual_quantity: 70000, unit: "cái", unit_price: 18, line_status: "du", product_skus: null, inventory_items: null, purchase_order_items: { id: "poi-1", product_name: "Túi PE 50x70", quantity: 70000, unit_price: 18 }, canonical_materials: { id: "m1", material_code: "BB-001", canonical_name: "Túi PE 50x70", default_unit: "cái" }, canonical_material_id: "m1" }],
  "gr-b": [
    { id: "it-b1", goods_receipt_id: "gr-b", product_name: "Hộp giấy bánh mì", quantity: 5000, ordered_quantity: 5000, actual_quantity: 4800, unit: "cái", unit_price: 250, line_status: "thieu", product_skus: null, inventory_items: null, purchase_order_items: { id: "poi-2", product_name: "Hộp giấy bánh mì", quantity: 5000, unit_price: 250 }, canonical_materials: { id: "m2", material_code: "BB-002", canonical_name: "Hộp giấy bánh mì", default_unit: "cái" }, canonical_material_id: "m2" },
    { id: "it-b2", goods_receipt_id: "gr-b", product_name: "Tem dán logo", quantity: 2000, ordered_quantity: 2000, actual_quantity: 2000, unit: "cái", unit_price: 30, line_status: "du", product_skus: null, inventory_items: null, purchase_order_items: { id: "poi-3", product_name: "Tem dán logo", quantity: 2000, unit_price: 30 }, canonical_materials: { id: "m3", material_code: "BB-003", canonical_name: "Tem dán logo", default_unit: "cái" }, canonical_material_id: "m3" },
    // Not linked to a standard material yet (shows the plain amber note, no queue link).
    { id: "it-b3", goods_receipt_id: "gr-b", product_name: "Túi Bánh Mì (giao đợt 1717)", raw_product_name: "Túi Bánh Mì (giao đợt 1717)", quantity: 10000, ordered_quantity: 10000, actual_quantity: 10000, unit: "cái", unit_price: 180, line_status: "du", product_skus: null, inventory_items: null, purchase_order_items: null, canonical_materials: null, canonical_material_id: null, material_resolution_status: "unknown", material_resolution_request_id: "574fcdfb-a48d-4754-8cac-bb6b8f790813" },
  ],
};
function fixtureRows(st) {
  if (st.table === "goods_receipts") return RECEIPTS;
  if (st.table === "goods_receipt_items") return ITEMS[st.filters.goods_receipt_id] ?? [];
  return null;
}
function builder(table) {
  const st = { table, filters: {}, head: false, single: false, write: null };
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
  rpc: (fn) => builder("rpc:" + fn),
  schema: () => ({ from: (table) => builder(table), rpc: (fn) => builder("rpc:" + fn) }),
  functions: { invoke: async (name) => { window.__qaWrites.push("invoke:" + name); return { data: null, error: { message: "QA fixture: functions disabled" } }; } },
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
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-gr-detail-qa/vite-cache",
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

const VIEWPORTS = [{ width: 390, height: 844 }, { width: 1440, height: 900 }];

try {
  for (const viewport of VIEWPORTS) {
    for (const [id, label] of [["gr-a", "receive"], ["gr-b", "finalized"]]) {
      const { context, page, errors } = await open({ role: "owner", data: "populated" }, "/goods-receipts", viewport);
      await page.waitForTimeout(1200);
      const number = id === "gr-a" ? "GRN-000465" : "GRN-000466";
      await page.locator("[data-bmq-goods-receipt-row-click-detail]:visible", { hasText: number }).first().getByText(number, { exact: true }).first().click();
      await page.waitForTimeout(1500);
      await page.waitForSelector("[data-bmq-goods-receipt-detail-mobile-hero]", { timeout: 15000 });
      await page.waitForTimeout(600);
      const facts = await page.evaluate(() => {
        const dialog = document.querySelector("[data-bmq-goods-receipt-detail-mobile-v2]");
        const text = dialog.innerText;
        const body = dialog.querySelector(".overflow-y-auto");
        return {
          text,
          raw: /\{\}/.test(text),
          dupLabel: (text.match(/Mã phiếu/g) || []).length + Math.max(0, (text.match(/GRN-00046[56]/g) || []).length - 1),
          ocrCards: /OCR tự điền|Nhân viên xác nhận cuối/.test(text),
          dash: [...dialog.querySelectorAll("[data-bmq-goods-receipt-payable-audit] dd")].some((dd) => dd.textContent.trim() === "-"),
          receiveBlock: Boolean(dialog.querySelector("[data-bmq-goods-receipt-delivery-note-required]")),
          upload: Boolean(dialog.querySelector("[data-bmq-goods-receipt-delivery-note-required] input[type=file]")),
          bodyOverflow: body ? body.scrollWidth - body.clientWidth : 0,
          height: body ? body.scrollHeight : 0,
        };
      });
      assert.equal(facts.raw, false, `no raw {} @${label} ${viewport.width}`);
      assert.equal(facts.dupLabel, 0, `no duplicated Mã phiếu block @${label}`);
      assert.equal(facts.ocrCards, false, `no OCR step cards @${label}`);
      assert.equal(facts.dash, false, `no "-" payable rows @${label}`);
      assert.match(facts.text, /Đối soát công nợ/);
      assert.match(facts.text, new RegExp(number));
      if (label === "receive") {
        assert.ok(facts.receiveBlock && facts.upload, "receive mode keeps the delivery-note upload");
        assert.match(facts.text, /Chưa liên kết PO hay công nợ|PO-000812/);
        assert.match(facts.text, /Thực nhận mặc định = số đặt/);
      } else {
        assert.match(facts.text, /PR-002031/);
        assert.match(facts.text, /Ngày chốt/);
        assert.match(facts.text, /Lệch: 1 dòng thiếu/);
        assert.match(facts.text, /Đã duyệt/);
        assert.match(facts.text, /Chưa gắn mã nguyên liệu chuẩn/);
        assert.match(facts.text, /Tên trên phiếu: Túi Bánh Mì \(giao đợt 1717\)/);
        assert.doesNotMatch(facts.text, /material-master|unknown|yêu cầu 574fcdfb|Cần xử lý NVL/);
        assert.equal(await page.locator('[data-bmq-goods-receipt-detail-mobile-v2] a[href="/material-master"]').count(), 0, "no queue link");
        const note = page.locator("[data-bmq-goods-receipt-detail-mobile-v2] [data-material-resolution-status]:visible").first();
        await note.scrollIntoViewIfNeeded();
        await note.locator("xpath=../..").screenshot({ path: `${EVIDENCE}/gr-unlinked-line-${viewport.width}.png` });
      }
      assert.ok(facts.bodyOverflow <= 0, `no horizontal overflow in the dialog @${label} ${viewport.width}: ${facts.bodyOverflow}`);
      assert.ok((await overflow(page)) <= 0, `no page overflow @${label} ${viewport.width}`);
      // Whole dialog body, top to bottom.
      await page.evaluate(() => { const b = document.querySelector("[data-bmq-goods-receipt-detail-mobile-v2] .overflow-y-auto"); b.style.maxHeight = "none"; b.style.overflow = "visible"; const d = document.querySelector("[data-bmq-goods-receipt-detail-mobile-v2]"); d.style.maxHeight = "none"; d.style.height = "auto"; d.style.position = "absolute"; d.style.top = "0"; d.style.transform = "translateX(-50%)"; });
      await page.waitForTimeout(200);
      await page.locator("[data-bmq-goods-receipt-detail-mobile-v2]").screenshot({ path: `${EVIDENCE}/gr-${label}-${viewport.width}.png` });
      assert.deepEqual(errors, [], `page errors @${label} ${viewport.width}`);
      record(`${label} ${viewport.width} (body ${facts.height}px)`);
      await context.close();
    }
  }
} finally {
  await browser.close();
  await server.close();
}
console.log(`ALL ${results.length} GR DETAIL QA CHECKS PASSED — evidence in ${EVIDENCE}`);
