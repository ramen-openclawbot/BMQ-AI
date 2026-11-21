// QA for the dathang AI order assistant: proposal card in the order chat, submit, follow-up, errors.
//
// FIXTURE AUTH + FIXTURE DATA: the Supabase client and AuthContext are replaced by in-memory
// fixtures; dealer-catalog, dealer-cart-assistant and dealer-order-submit answer from scripts,
// and all non-local network is blocked. This proves the real DealerPortal renders and wires the
// assistant correctly; it is not real-dealer acceptance and never touches real records.
//
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome node scripts/qa_dealer_cart_assistant.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-dealer-heo-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5213);
const { chromium } = createRequire(import.meta.url)(PW);
fs.mkdirSync(EVIDENCE, { recursive: true });

const SUPABASE_FIXTURE = `
window.__qaBodies = window.__qaBodies || [];
const builder = () => {
  const result = { data: [], error: null, count: 0 };
  const proxy = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return (ok, ko) => Promise.resolve(result).then(ok, ko);
      if (prop === "catch") return (ko) => Promise.resolve(result).catch(ko);
      if (prop === "finally") return (fn) => Promise.resolve(result).finally(fn);
      return () => proxy;
    },
  });
  return proxy;
};
async function invoke(name, options) {
  const body = options?.body || {};
  window.__qaBodies.push({ name, ...body });
  if (name === "dealer-order-submit") return { data: { success: true, order_number: "DH-QA-0001" }, error: null };
  return { data: null, error: { message: "QA fixture: functions disabled" } };
}
const user = { id: "qa-user", email: "qa@bmq.test", user_metadata: {} };
const channel = { on() { return channel; }, subscribe() { return channel; }, unsubscribe() {} };
export const supabase = {
  from: () => builder(), rpc: () => builder(), schema: () => ({ from: () => builder(), rpc: () => builder() }),
  functions: { invoke },
  storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "" } }), createSignedUrl: async () => ({ data: null, error: null }) }) },
  auth: {
    getSession: async () => ({ data: { session: null }, error: null }),
    getUser: async () => ({ data: { user: null }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    signOut: async () => ({ error: null }),
  },
  channel: () => channel, removeChannel: () => {},
};
export default supabase;
`;

const AUTH_FIXTURE = `
import React, { createContext, useContext } from "react";
const value = { user: null, session: null, profile: null, loading: false, timedOut: false, roles: [], authzLoaded: true, authzError: false,
  isOwner: false, canAccessModule: () => false, canEditModule: () => false, signOut: async () => {}, refreshProfile: async () => {}, refreshRoles: async () => {} };
const Ctx = createContext(value);
export function AuthProvider({ children }) { return React.createElement(Ctx.Provider, { value }, children); }
export function useAuth() { return useContext(Ctx); }
`;

const fixtures = {
  name: "qa-dealer-assistant-fixtures",
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

const PRODUCTS = [
  { id: "p-pate", sku_code: "BMQ-001", product_name: "Bánh mì que Pate", unit: "que", price_vnd: 3500, category: "Bánh mì" },
  { id: "p-croissant", sku_code: "BMQ-CRO", product_name: "Bánh Croissant bơ Pháp nướng mỗi sáng", unit: "cái", price_vnd: 15000, category: "Bánh ngọt" },
  { id: "p-chabong", sku_code: "BMQ-CB", product_name: "Chà bông heo", unit: "hộp", price_vnd: 42000, category: "Thành phẩm" },
];
const CUSTOMER = { id: "cus-qa", name: "Đại lý Hồng Phát", code: "DL-001", is_test: true };
const NPP_ROUTES = [
  { id: "r1", name: "Đại Lý CoopMart Rạch Giá" },
  { id: "r2", name: "Đại Lý Dĩ An" },
  { id: "r3", name: "Đại lý Phan Thiết" },
  { id: "r4", name: "Đại lý Đồng Văn Cống" },
];
const routeLine = (route_id, quantity, exchange_quantity = 0, makeup_quantity = 0, note = "") => ({
  route_id, product_id: "p-pate", sku_code: "BMQ-001", product_name: "Bánh mì que Pate", unit: "que", unit_price: 3500,
  quantity, exchange_quantity, makeup_quantity, note,
});

const server = await createServer({
  root: ROOT,
  configFile: false,
  logLevel: "error",
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-dealer-heo-qa/vite-cache",
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

const line = (id, quantity) => {
  const p = PRODUCTS.find((item) => item.id === id);
  return { product_id: id, sku_code: p.sku_code, product_name: p.product_name, unit: p.unit, unit_price: p.price_vnd, quantity };
};

// Scripted assistant: keyed by the dealer's message.
function assistantAnswer(body) {
  const text = String(body.message || "");
  if (body.cart_lines !== undefined) {
    if (text.includes("như hôm qua")) return { status: 200, json: { success: true, reply: "Em chép đơn hôm qua và sửa Dĩ An 150, Phan Thiết bù 13.", proposal: { mode: "replace", kind: "routes", lines: [routeLine("r1", 200, 15), routeLine("r2", 150, 0, 0, "xin thêm ớt"), routeLine("r3", 300, 0, 13, "và 2 hộp pate")] }, warnings: [] } };
    if (text.includes("ĐVC")) return { status: 200, json: { success: true, reply: "Em thêm Đồng Văn Cống 100 que.", proposal: { mode: "merge", kind: "routes", lines: [routeLine("r4", 100)] }, warnings: ["Số lượng Bánh mì que Pate tại Đại lý Đồng Văn Cống đã làm tròn lên bội số 10."] } };
    return { status: 200, json: { success: true, reply: "Quý Khách Hàng muốn đặt cho điểm bán nào ạ?", proposal: null, warnings: [] } };
  }
  if (text.includes("giới hạn")) return { status: 429, json: { success: false, error: "Hôm nay đại lý đã dùng hết 60 lượt hỏi trợ lý.", code: "assistant_daily_limit" } };
  if (text.includes("hết phiên")) return { status: 401, json: { success: false, error: "Phiên đại lý đã hết hạn.", code: "dealer_session_required" } };
  if (text.includes("bánh gì")) return { status: 200, json: { success: true, reply: "Dạ, hôm nay đại lý muốn đặt bánh mì que, croissant hay chà bông ạ?", proposal: null, warnings: [] } };
  if (text.includes("chà bông")) return { status: 200, json: { success: true, reply: "Em thêm 10 hộp chà bông vào đơn.", proposal: { mode: "merge", lines: [line("p-chabong", 10)] }, warnings: [] } };
  if (text.includes("croissant")) return { status: 200, json: { success: true, reply: "Em chuẩn bị đơn như hôm qua: 200 que pate, thêm 20 croissant.", proposal: { mode: "replace", lines: [line("p-pate", 200), line("p-croissant", 20)] }, warnings: ["Số lượng croissant đã làm tròn lên bội số 10 (18 → 20)."] } };
  return { status: 200, json: { success: true, reply: "Em chưa rõ, Quý Khách Hàng nói rõ món và số lượng giúp em.", proposal: null, warnings: [] } };
}


const HEO_SUMMARY = { extra_que: 257, from_extra_vnd: 128500, from_spins_vnd: 58000, bread_qty: 10, total_vnd: 186500, spin_count: 9, days_to_break: 31,
  recent_spins: [{ amount_vnd: 20000, bread_qty: 0, prize_kind: "coin", is_jackpot: false, created_at: "2026-12-14T03:00:00Z", order_id: "o1" },
    { amount_vnd: 0, bread_qty: 10, prize_kind: "bread", is_jackpot: false, created_at: "2026-12-13T03:00:00Z", order_id: "o2" }] };
const HEO_STATUS = { success: true, active: true, baseline_avg_per_day: 123,
  campaign: { title: "Heo Đất Tết", starts_on: "2026-12-01", ends_on: "2026-12-31", break_on: "2027-01-15", rate: 500, spin_enabled_for_me: true, prizes: [] },
  summary: HEO_SUMMARY };
const heoCalls = [];
function heoAnswer(body) {
  heoCalls.push(body);
  if (body.action === "spin") return { success: true, spin: { prize_kind: "coin", amount_vnd: 20000, bread_qty: 0, is_jackpot: false }, summary: { ...HEO_SUMMARY, total_vnd: 206500 } };
  return HEO_STATUS;
}

async function open(viewport, { npp = false } = {}) {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce", locale: "vi-VN", timezoneId: "Asia/Ho_Chi_Minh" });
  await context.addInitScript(() => localStorage.setItem("bmq_dealer_session_token", "dop_qa_token"));
  const assistantCalls = [];
  await context.route("**/*", async (r) => {
    const url = r.request().url();
    if (url.startsWith("https://qa.supabase.test/functions/v1/")) {
      const fn = url.split("/functions/v1/")[1].split("?")[0];
      if (fn === "dealer-cart-assistant") {
        const body = r.request().postDataJSON();
        assistantCalls.push(body);
        const answer = assistantAnswer(body);
        await new Promise((resolve) => setTimeout(resolve, 250));
        return r.fulfill({ status: answer.status, contentType: "application/json", body: JSON.stringify(answer.json) });
      }
      if (fn === "dealer-heo") return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(heoAnswer(r.request().postDataJSON())) });
      if (fn === "dealer-report") return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: false, error: "QA" }) });
      if (fn === "dealer-catalog") {
        return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, customer: CUSTOMER, products: PRODUCTS, announcements: [], dealer_routes: npp ? NPP_ROUTES : [] }) });
      }
      if (fn === "dealer-order-history") return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: false }) });
      return r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ success: true, ok: true }) });
    }
    if (url.startsWith(BASE) || url.startsWith("data:") || url.startsWith("blob:") || /fonts\.(googleapis|gstatic)\.com/.test(url)) return r.continue();
    return r.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + "/dealer", { waitUntil: "domcontentloaded" });
  await page.locator("[data-dealer-agent-row='order']").first().waitFor({ timeout: 30000 });
  await page.locator("[data-dealer-agent-row='order']").first().click();
  await page.locator("[data-dealer-agent-screen='chat']").waitFor();
  await page.evaluate(() => document.fonts.ready);
  return { context, page, errors, assistantCalls };
}

const composer = (page) => page.getByPlaceholder("Nhắn BMQ Agent…");
async function say(page, text) {
  await composer(page).fill(text);
  await page.getByRole("button", { name: "Gửi nội dung đơn" }).click();
}
const overflow = (page) => page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
const bodies = (page) => page.evaluate(() => window.__qaBodies);
const vnd = (n) => new Intl.NumberFormat("vi-VN").format(n);


try {
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 640 }, { width: 1280, height: 860 }]) {
    const tag = viewport.width;
    const { context, page, errors } = await open(viewport);
    const banner = page.locator("[data-dealer-heo-banner]");
    await banner.waitFor({ timeout: 15000 });
    assert.match(await banner.textContent(), /186\.500đ/);
    assert.match(await banner.textContent(), /123 que\/ngày/);
    await page.screenshot({ path: `${EVIDENCE}/heo-banner-${tag}.png` });
    await banner.getByRole("button", { name: "Xem cách nhận" }).click();
    await page.getByText("Heo của anh/chị lớn thế nào?").waitFor();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${EVIDENCE}/heo-howto-${tag}.png` });
    await page.getByRole("button", { name: "Đã hiểu" }).click();

    await say(page, "đặt như hôm qua, thêm 18 croissant");
    const strip = page.locator("[data-dealer-assistant-proposal] [data-dealer-heo-strip]");
    await strip.waitFor({ timeout: 15000 });
    await strip.scrollIntoViewIfNeeded();
    assert.match(await strip.textContent(), /Vượt 77 que → \+38\.500đ/);
    await page.screenshot({ path: `${EVIDENCE}/heo-strip-${tag}.png` });
    await page.locator("[data-dealer-assistant-action='submit']").click();
    const spinBtn = page.locator("[data-dealer-heo-spin]");
    await spinBtn.waitFor({ timeout: 15000 });
    await page.screenshot({ path: `${EVIDENCE}/heo-success-${tag}.png` });
    await spinBtn.click();
    await page.getByText("+20.000đ").first().waitFor({ timeout: 8000 });
    assert.ok(heoCalls.some((c) => c.action === "spin" && c.order_number === "DH-QA-0001"), "spin sent with order number");
    await page.screenshot({ path: `${EVIDENCE}/heo-spin-${tag}.png` });
    await page.getByRole("button", { name: "Tuyệt! Quay về" }).click();
    assert.ok((await overflow(page)) <= 0, "no horizontal overflow");
    const small = await page.evaluate(() => [...document.querySelectorAll(".dealer-heo-btn")].filter((b) => b.offsetParent && b.getBoundingClientRect().height < 44).length);
    assert.equal(small, 0, "heo buttons >= 44px");
    assert.deepEqual(errors, []);
    record(`heo chat flow ${tag}`);
    await context.close();
  }
  console.log(`${results.length}/${results.length} PASS · evidence ${EVIDENCE}`);
} finally {
  await browser.close();
  await server.close();
}
