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
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-dealer-assistant-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5211);
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
const NPP_ROUTES = [{ id: "r1", name: "Rạch Giá" }, { id: "r2", name: "ĐVC" }];

const server = await createServer({
  root: ROOT,
  configFile: false,
  logLevel: "error",
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-dealer-assistant-qa/vite-cache",
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
  if (text.includes("giới hạn")) return { status: 429, json: { success: false, error: "Hôm nay đại lý đã dùng hết 60 lượt hỏi trợ lý.", code: "assistant_daily_limit" } };
  if (text.includes("hết phiên")) return { status: 401, json: { success: false, error: "Phiên đại lý đã hết hạn.", code: "dealer_session_required" } };
  if (text.includes("bánh gì")) return { status: 200, json: { success: true, reply: "Dạ, hôm nay đại lý muốn đặt bánh mì que, croissant hay chà bông ạ?", proposal: null, warnings: [] } };
  if (text.includes("chà bông")) return { status: 200, json: { success: true, reply: "Em thêm 10 hộp chà bông vào đơn.", proposal: { mode: "merge", lines: [line("p-chabong", 10)] }, warnings: [] } };
  if (text.includes("croissant")) return { status: 200, json: { success: true, reply: "Em chuẩn bị đơn như hôm qua: 200 que pate, thêm 20 croissant.", proposal: { mode: "replace", lines: [line("p-pate", 200), line("p-croissant", 20)] }, warnings: ["Số lượng croissant đã làm tròn lên bội số 10 (18 → 20)."] } };
  return { status: 200, json: { success: true, reply: "Em chưa rõ, Quý Khách Hàng nói rõ món và số lượng giúp em.", proposal: null, warnings: [] } };
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
  for (const viewport of [{ width: 390, height: 844 }, { width: 320, height: 640 }, { width: 1440, height: 900 }]) {
    const tag = viewport.width;
    const { context, page, errors, assistantCalls } = await open(viewport);

    // 1. Welcome bubble tells the dealer they can write naturally.
    assert.ok(await page.locator("[data-dealer-assistant-hint]").isVisible(), "assistant hint shown");
    await page.screenshot({ path: `${EVIDENCE}/welcome-${tag}.png` });

    // 2. A free-form message goes to the assistant and shows the proposal card.
    await say(page, "đặt như hôm qua, thêm 18 croissant");
    const card = page.locator("[data-dealer-assistant-proposal]");
    await card.waitFor({ timeout: 15000 });
    assert.equal(assistantCalls.length, 1, "one assistant call");
    assert.equal(assistantCalls[0].dealer_token, "dop_qa_token");
    assert.deepEqual(assistantCalls[0].cart, {}, "fresh order sends an empty cart");
    assert.deepEqual(assistantCalls[0].history, []);
    assert.equal(assistantCalls[0].mode, undefined, "client does not force the mode");
    assert.equal(await card.locator("[data-dealer-assistant-line]").count(), 2);
    assert.ok((await card.textContent()).includes("Bánh mì que Pate"));
    assert.ok((await page.locator("[data-dealer-assistant-total]").textContent()).includes(vnd(200 * 3500 + 20 * 15000)), "total from catalog prices");
    assert.ok((await page.locator("[data-dealer-assistant-warnings]").textContent()).includes("18 → 20"));
    assert.ok(await page.getByText("Em chuẩn bị đơn như hôm qua").first().isVisible(), "assistant reply bubble");
    assert.equal(await page.locator("[data-dealer-chat-choices='parse-recovery']").count(), 0, "no recovery chips under a proposal");
    assert.ok(await overflow(page) <= 0, `no overflow ${tag}`);
    await card.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${EVIDENCE}/proposal-${tag}.png` });
    assert.equal((await bodies(page)).filter((b) => b.name === "dealer-order-submit").length, 0, "nothing submitted before the tap");
    record(`proposal card ${tag}`);

    // 3. Follow-up message merges into the current proposal with history.
    await say(page, "thêm 10 chà bông");
    await page.locator("[data-dealer-assistant-line]").nth(2).waitFor({ timeout: 15000 });
    assert.deepEqual(assistantCalls[1].cart, { "p-pate": 200, "p-croissant": 20 });
    assert.equal(assistantCalls[1].history.length, 2);
    assert.equal(await page.locator("[data-dealer-assistant-line]").count(), 3);
    assert.ok((await page.locator("[data-dealer-assistant-total]").textContent()).includes(vnd(200 * 3500 + 20 * 15000 + 10 * 42000)));
    await page.locator("[data-dealer-assistant-proposal]").scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${EVIDENCE}/proposal-merged-${tag}.png` });
    record(`follow-up merge ${tag}`);

    // 4. "ok" with a proposal asks for the button; the dealer's tap submits all lines.
    await say(page, "ok");
    await page.getByText("bấm Đặt đơn này").first().waitFor();
    assert.equal((await bodies(page)).filter((b) => b.name === "dealer-order-submit").length, 0, "typing ok does not submit");
    await page.locator("[data-dealer-assistant-action='submit']").click();
    await page.locator("[data-dealer-chat-message='success']").waitFor();
    const submit = (await bodies(page)).filter((b) => b.name === "dealer-order-submit").pop();
    assert.deepEqual(submit.items.map((i) => [i.sku_id, i.quantity, i.physical_quantity, i.route_customer_name]), [
      ["p-pate", 200, 200, "Đại Lý Hồng Phát"],
      ["p-croissant", 20, 20, "Đại Lý Hồng Phát"],
      ["p-chabong", 10, 10, "Đại Lý Hồng Phát"],
    ]);
    assert.ok(submit.client_submission_id, "idempotency id sent");
    assert.equal(await page.locator("[data-dealer-assistant-proposal]").count(), 0, "card cleared after success");
    await page.screenshot({ path: `${EVIDENCE}/submitted-${tag}.png` });
    record(`dealer tap submits ${tag}`);

    // 5. The existing quantity parser still handles plain quantities without the assistant.
    await page.getByRole("button", { name: "Đặt đơn khác" }).first().click();
    const callsBefore = assistantCalls.length;
    await say(page, "200 đổi 14 bù 5");
    await page.locator("[data-dealer-order-preview-card]").waitFor({ timeout: 10000 });
    assert.equal(assistantCalls.length, callsBefore, "plain quantity skips the assistant");
    record(`quantity parser unchanged ${tag}`);

    // 6. "20 croissant" names another product, so it goes to the assistant.
    await page.getByRole("button", { name: "Đặt đơn khác" }).first().click();
    await say(page, "20 croissant");
    await page.locator("[data-dealer-assistant-proposal]").waitFor({ timeout: 15000 });
    assert.equal(assistantCalls.length, callsBefore + 1);
    record(`other product goes to assistant ${tag}`);

    // 7. A clarifying answer keeps the cart the dealer already has.
    await page.getByRole("button", { name: "Nhắn sửa" }).click();
    await say(page, "hôm nay lấy bánh gì");
    await page.getByText("muốn đặt bánh mì que, croissant hay chà bông").first().waitFor({ timeout: 15000 });
    assert.equal(await page.locator("[data-dealer-assistant-line]").count(), 2, "previous proposal kept");
    record(`clarifying reply ${tag}`);

    // 8. Daily limit: message + fallback hint, nothing breaks.
    await say(page, "vượt giới hạn rồi");
    await page.getByText("dùng hết 60 lượt").first().waitFor({ timeout: 15000 });
    assert.ok(await page.getByText("200 đổi 14 bù 5").first().isVisible(), "fallback example shown");
    assert.ok(await overflow(page) <= 0);
    await page.screenshot({ path: `${EVIDENCE}/limit-${tag}.png` });
    record(`daily limit ${tag}`);

    assert.deepEqual(errors, []);
    await context.close();
  }

  // 9. Expired session sends the dealer back to login.
  {
    const { context, page, errors } = await open({ width: 390, height: 844 });
    await say(page, "hết phiên rồi");
    await page.getByRole("button", { name: /Gửi mã OTP Zalo/ }).first().waitFor({ timeout: 15000 });
    assert.equal(await page.evaluate(() => localStorage.getItem("bmq_dealer_session_token")), null);
    assert.deepEqual(errors, []);
    record("expired session logs out");
    await context.close();
  }

  // 10. NPP dealers keep the route parser; the assistant is never called.
  {
    const { context, page, errors, assistantCalls } = await open({ width: 390, height: 844 }, { npp: true });
    assert.equal(await page.locator("[data-dealer-assistant-hint]").count(), 0, "no hint for NPP");
    await say(page, "đặt như hôm qua, thêm 18 croissant");
    await page.locator("[data-dealer-chat-message='agent']").first().waitFor({ timeout: 10000 });
    assert.equal(assistantCalls.length, 0, "NPP never calls the assistant");
    assert.deepEqual(errors, []);
    record("NPP unchanged");
    await context.close();
  }
} finally {
  fs.writeFileSync(`${EVIDENCE}/qa-dealer-assistant.json`, JSON.stringify({ results }, null, 2));
  await browser.close();
  await server.close();
}
console.log(`ALL ${results.length} DEALER ASSISTANT QA CHECKS PASSED — evidence in ${EVIDENCE}`);
