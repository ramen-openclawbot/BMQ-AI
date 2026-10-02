// Browser QA for the Demo 3 internal-app shell (top navigation, app drawer, search, theme scope).
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
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-demo3-shell-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5199);
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
  if (st.head) {
    let count = 0;
    if (mode === "populated" && st.table === "payment_requests" && st.filters.status === "pending") count = 3;
    if (mode === "populated" && st.table === "purchase_orders" && st.filters.status === "draft") count = 2;
    return { data: null, error: null, count };
  }
  if (st.single) return { data: null, error: null };
  return { data: [], error: null, count: 0 };
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
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-demo3-shell-qa/vite-cache",
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

try {
  // 1. Owner: every zone, deep links, layout at four widths.
  const ownerRoutes = [
    ["/", "Tổng quan", null],
    ["/finance-control/revenue/sources", "Bán hàng", "Quản lý doanh thu"],
    ["/finance-control/revenue/points", "Bán hàng", "Doanh thu điểm bán"],
    ["/production/planning/q7/kfm", "Sản xuất", "Xưởng Q7"],
    ["/warehouse/tan-tao", "Kho", "Kho Tân Tạo"],
    ["/payment-requests", "Duyệt chi", "Duyệt chi"],
    ["/finance-control/classification", "Duyệt chi", "Phân loại chi phí"],
    ["/attendance", null, "Chấm công"],
    ["/material-master", null, "NVL chuẩn"],
  ];
  for (const viewport of WIDTHS) {
    for (const [route, zone, chip] of ownerRoutes) {
      const { context, page, errors } = await open({ role: "owner", data: "populated" }, route, viewport);
      assert.deepEqual(await tabLabels(page), ["Tổng quan", "Bán hàng", "Sản xuất", "Kho", "Duyệt chi", "Hỏi AI"], `owner tabs @${route}`);
      assert.equal(await activeTab(page), zone, `active zone @${route} ${viewport.width}`);
      if (chip) assert.ok((await activeChip(page))?.startsWith(chip), `active chip @${route} ${viewport.width}: ${await activeChip(page)}`);
      const ov = await overflow(page);
      assert.ok(ov <= 0, `no page overflow @${route} ${viewport.width}: ${ov}`);
      assert.ok(await page.evaluate(() => document.documentElement.classList.contains("bmq-d3")), "theme class set");
      if (zone) {
        const pill = await page.locator(".d3-tabs-ind").boundingBox();
        const tabNow = await page.locator(".d3-tab.is-active").boundingBox();
        assert.ok(Math.abs(pill.x - tabNow.x) <= 1 && Math.abs(pill.width - tabNow.width) <= 1, `indicator on active tab @${route} ${viewport.width}`);
      } else {
        assert.equal(await page.locator(".d3-tabs-ind").count(), 0, "no indicator on utility pages");
      }
      const headerBox = await page.locator(".d3-header").boundingBox();
      assert.ok(headerBox.width <= viewport.width, "header fits");
      const actions = await page.locator(".d3-actions").boundingBox();
      assert.ok(actions.x + actions.width <= viewport.width + 0.5, `actions visible @${viewport.width}`);
      if (route === "/" || route === "/payment-requests" || route === "/warehouse/tan-tao") {
        await page.screenshot({ path: `${EVIDENCE}/owner-${viewport.width}${route.replace(/\//g, "_") || "_root"}.png` });
      }
      assert.deepEqual(errors, [], `page errors @${route}`);
      record(`owner ${viewport.width} ${route}`, { zone, chip, overflow: ov });
      await context.close();
    }
  }

  // 2. Navigation: tabs, chips, back/forward, drawer, search, bell, language, AI tab.
  {
    const { context, page, errors } = await open({ role: "owner", data: "populated" }, "/", { width: 1440, height: 900 });
    await page.locator(".d3-tab", { hasText: "Kho" }).click();
    await page.waitForURL(BASE + "/inventory");
    assert.equal(await activeTab(page), "Kho");
    await page.locator(".d3-chip", { hasText: "Phiếu nhập kho" }).click();
    await page.waitForURL(BASE + "/goods-receipts");
    assert.ok((await activeChip(page)).startsWith("Phiếu nhập kho"));
    await page.goBack();
    await page.waitForURL(BASE + "/inventory");
    assert.equal(await activeTab(page), "Kho");
    record("tab + chip navigation, browser back");

    const subnavCounts = await page.$$eval(".d3-subnav .d3-count", (els) => els.map((el) => el.textContent));
    assert.deepEqual(subnavCounts, ["2"], "draft PO count on PO chip");

    // Drawer: grid button, keyboard Escape, focus return, permission-filtered links.
    const gridButton = page.getByRole("button", { name: "Tất cả chức năng" });
    await gridButton.click();
    await page.waitForSelector("[data-bmq-app-drawer='demo3-v1'][data-state='open']");
    assert.ok(await page.locator(".d3-drawer a[href='/user-management']").count(), "owner sees admin links");
    assert.ok(await page.locator(".d3-drawer", { hasText: "Tạo PO từ Google Drive" }).count(), "Drive PO shortcut kept");
    assert.equal(await page.locator(".d3-drawer .d3-count.is-alert").textContent(), "3", "pending approvals badge");
    await page.screenshot({ path: `${EVIDENCE}/owner-1440-drawer.png` });
    await page.keyboard.press("Escape");
    await page.waitForSelector("[data-bmq-app-drawer='demo3-v1']", { state: "detached" });
    // Radix restores focus on a timeout after unmount.
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Tất cả chức năng", null, { timeout: 2000 });
    record("drawer open/escape/focus");

    // bmq:open-sidebar (page-level menu buttons) still opens it; a link closes it and navigates.
    await page.evaluate(() => window.dispatchEvent(new Event("bmq:open-sidebar")));
    await page.waitForSelector("[data-bmq-app-drawer='demo3-v1'][data-state='open']");
    await page.locator(".d3-drawer a[href='/suppliers']").click();
    await page.waitForURL(BASE + "/suppliers");
    await page.waitForSelector("[data-bmq-app-drawer='demo3-v1']", { state: "detached" });
    assert.equal(await activeTab(page), null, "utility page has no zone");
    record("bmq:open-sidebar + drawer link navigation");

    // Search: unaccented query, keyboard selection.
    await page.keyboard.press("Control+k");
    await page.waitForSelector(".d3-search-dialog");
    await page.keyboard.type("phan loai");
    await page.waitForTimeout(150);
    const firstItem = await page.locator(".d3-search-dialog [cmdk-item][data-selected='true']").textContent();
    assert.equal(firstItem.trim(), "Phân loại chi phí");
    await page.screenshot({ path: `${EVIDENCE}/owner-1440-search.png` });
    await page.keyboard.press("Enter");
    await page.waitForURL(BASE + "/finance-control/classification");
    assert.equal(await activeTab(page), "Duyệt chi");
    record("search without diacritics + Enter navigates");

    // Bell: only real counts.
    await page.getByRole("button", { name: /Thông báo/ }).click();
    await page.locator(".d3-menu[data-state='open']").waitFor({ state: "visible" });
    await page.waitForTimeout(300);
    const notices = await page.$$eval(".d3-menu .d3-menu-item", (els) => els.map((el) => el.textContent.trim()));
    assert.deepEqual(notices, ["Phiếu đề nghị chi chờ duyệt3", "PO mua hàng đang nháp2"]);
    await page.screenshot({ path: `${EVIDENCE}/owner-1440-bell.png` });
    await page.locator(".d3-menu .d3-menu-item").first().click();
    await page.waitForURL(BASE + "/payment-requests");
    record("bell real counts + navigation");

    // Language switch lives in the account menu.
    await page.locator(".d3-avatar").focus();
    await page.keyboard.press("Enter");
    await page.locator(".d3-menu[data-state='open']").waitFor({ state: "visible" });
    assert.equal(await page.getByRole("menuitemradio", { name: "Tiếng Việt" }).getAttribute("aria-checked"), "true");
    for (let i = 0; i < 6; i += 1) {
      if ((await page.evaluate(() => document.activeElement?.textContent?.trim())) === "English") break;
      await page.keyboard.press("ArrowDown");
    }
    await page.keyboard.press("Enter"); // keyboard-only language switch
    assert.equal(await page.locator(".d3-menu[data-state='open']").count(), 1, "menu stays open after switching language");
    assert.equal(await page.getByRole("menuitemradio", { name: "English" }).getAttribute("aria-checked"), "true");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".d3-menu")); // exit animation finished
    assert.deepEqual(await tabLabels(page), ["Overview", "Sales", "Production", "Warehouse", "Approvals", "Ask AI"]);
    await page.locator(".d3-avatar").click();
    await page.locator(".d3-menu[data-state='open']").waitFor({ state: "visible" });
    await page.waitForTimeout(250);
    assert.equal(await page.locator(".d3-menu[data-state='open']").count(), 1, "account menu reopens and stays open");
    await page.getByRole("menuitemradio", { name: "Tiếng Việt" }).click();
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".d3-menu")); // exit animation finished
    assert.equal(await tabLabels(page).then((t) => t[0]), "Tổng quan");
    record("language toggle");

    // Hỏi AI dispatches the existing chat event instead of navigating.
    await page.evaluate(() => { window.__aiOpened = 0; window.addEventListener("bmq:open-agent-chat", () => { window.__aiOpened += 1; }); });
    const before = page.url();
    await page.locator(".d3-tab", { hasText: "Hỏi AI" }).click();
    assert.equal(await page.evaluate(() => window.__aiOpened), 1);
    assert.equal(page.url(), before);
    record("Hỏi AI opens chat");

    assert.deepEqual(await page.evaluate(() => window.__qaWrites.filter((w) => !w.startsWith("invoke:"))), [], "shell made no data writes");
    assert.deepEqual(errors, []);
    await context.close();
  }

  // 3. Mobile drawer + menus at 390/320.
  for (const width of [390, 320]) {
    const { context, page, errors } = await open({ role: "owner", data: "populated" }, "/payment-requests", { width, height: 780 });
    const tabsScroll = await page.$eval(".d3-tabs", (el) => ({ sw: el.scrollWidth, cw: el.clientWidth, sl: el.scrollLeft }));
    assert.ok(tabsScroll.sw >= tabsScroll.cw, "tabs scroll internally");
    const activeBox = await page.locator(".d3-tab.is-active").boundingBox();
    assert.ok(activeBox.x >= 0 && activeBox.x + activeBox.width <= width, `active tab scrolled into view @${width}`);
    await page.waitForTimeout(600);
    const pill = await page.locator(".d3-tabs-ind").boundingBox();
    const tabNow = await page.locator(".d3-tab.is-active").boundingBox();
    assert.ok(Math.abs(pill.x - tabNow.x) <= 1 && Math.abs(pill.width - tabNow.width) <= 1, `indicator sits on active tab @${width}: ${JSON.stringify({ pill, tabNow })}`);
    for (const el of await page.locator(".d3-icon-btn:visible, .d3-avatar, .d3-tab").all()) {
      const box = await el.boundingBox();
      if (box) assert.ok(box.height >= 36, `touch target height ${box.height} @${width}`);
    }
    await page.getByRole("button", { name: "Tất cả chức năng" }).click();
    await page.waitForSelector("[data-bmq-app-drawer='demo3-v1'][data-state='open']");
    const drawer = await page.locator(".d3-drawer").boundingBox();
    assert.ok(drawer.x >= 0 && drawer.x + drawer.width <= width, "drawer within viewport");
    await page.screenshot({ path: `${EVIDENCE}/owner-${width}-drawer.png` });
    await page.keyboard.press("Escape");
    await page.waitForSelector("[data-bmq-app-drawer='demo3-v1']", { state: "detached" });
    await page.waitForFunction(() => document.body.style.pointerEvents !== "none");
    await page.locator(".d3-avatar").click();
    await page.locator(".d3-menu[data-state='open']").waitFor({ state: "visible" });
    await page.waitForTimeout(300);
    const accountMenu = await page.locator(".d3-menu[data-state='open']").boundingBox();
    assert.ok(accountMenu.x >= 0 && accountMenu.x + accountMenu.width <= width, `account menu within viewport @${width}`);
    await page.screenshot({ path: `${EVIDENCE}/owner-${width}-account.png` });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".d3-menu"));
    await page.locator(".d3-search-mobile").click();
    await page.waitForSelector(".d3-search-dialog");
    await page.waitForTimeout(300);
    const searchBox = await page.locator(".d3-search-dialog").boundingBox();
    assert.ok(searchBox.x >= 8 && searchBox.x + searchBox.width <= width - 8, `search dialog inset @${width}`);
    const inputOutline = await page.$eval(".d3-search-dialog [cmdk-input]", (el) => getComputedStyle(el).outlineStyle + " " + getComputedStyle(el).outlineColor);
    assert.ok(!/solid rgb\(39, 39, 39\)/.test(inputOutline), `search input keeps its borderless focus: ${inputOutline}`);
    await page.screenshot({ path: `${EVIDENCE}/owner-${width}-search.png` });
    assert.deepEqual(errors, []);
    record(`mobile drawer/account/search ${width}`);
    await context.close();
  }

  // 4. Limited and no-permission users: only permitted zones/pages appear.
  for (const viewport of [WIDTHS[0], WIDTHS[2]]) {
    const { context, page, errors } = await open({ role: "limited", data: "populated" }, "/inventory", viewport);
    assert.deepEqual(await tabLabels(page), ["Tổng quan", "Kho", "Duyệt chi"], "limited tabs");
    const chips = await page.$$eval(".d3-subnav .d3-chip", (els) => els.map((el) => el.textContent.trim()));
    assert.deepEqual(chips, ["Tổng quan kho", "Kho Tân Tạo", "Kiểm soát kho bếp", "Phiếu nhập kho", "Xuất kho", "Báo cáo tồn kho"]);
    await page.locator(".d3-tab", { hasText: "Duyệt chi" }).click();
    await page.waitForURL(BASE + "/payment-requests");
    // payment_requests also grants the payables page; CEO declaration/classification need finance_cost.
    assert.deepEqual(
      await page.$$eval(".d3-subnav .d3-chip", (els) => els.map((el) => el.textContent.trim().replace(/\d+$/, ""))),
      ["Duyệt chi", "Quản lý công nợ phải trả"],
    );
    await page.locator(".d3-tab", { hasText: "Tổng quan" }).click();
    await page.waitForURL(BASE + "/");
    assert.equal(await page.locator(".d3-subnav").count(), 0, "single-page zone hides chips");
    await page.getByRole("button", { name: "Tất cả chức năng" }).click();
    await page.waitForSelector("[data-bmq-app-drawer='demo3-v1'][data-state='open']");
    assert.equal(await page.locator(".d3-drawer a[href='/user-management']").count(), 0, "no admin link");
    assert.equal(await page.locator(".d3-drawer a[href='/finance-control/revenue']").count(), 0, "no revenue link");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+k");
    await page.keyboard.type("doanh thu");
    await page.waitForTimeout(150);
    assert.equal(await page.locator(".d3-search-dialog [cmdk-item]").count(), 0, "search hides forbidden pages");
    await page.keyboard.press("Escape");
    await page.screenshot({ path: `${EVIDENCE}/limited-${viewport.width}.png` });
    assert.equal(await page.locator(".d3-tab.is-ai").count(), 0, "AI tab owner-only");
    assert.deepEqual(errors, []);
    record(`limited user ${viewport.width}`);
    await context.close();
  }
  {
    const { context, page, errors } = await open({ role: "none", data: "populated" }, "/settings", { width: 390, height: 780 });
    assert.equal(await page.locator(".d3-tabs").count(), 0, "no zones, no tab bar");
    assert.equal(await page.getByRole("button", { name: /Thông báo/ }).count(), 0, "no notification sources");
    assert.ok((await overflow(page)) <= 0);
    await page.screenshot({ path: `${EVIDENCE}/no-permission-390.png` });
    assert.deepEqual(errors, []);
    record("no-permission user");
    await context.close();
  }

  // 5. Empty and error data states keep the shell intact (no fake counts, no crash).
  for (const data of ["empty", "error"]) {
    const { context, page, errors } = await open({ role: "owner", data }, "/payment-requests", { width: 1440, height: 900 });
    assert.equal(await page.locator(".d3-dot").count(), 0, `no unread dot when ${data}`);
    assert.equal(await page.locator(".d3-subnav .d3-count").count(), 0, `no chip counts when ${data}`);
    await page.screenshot({ path: `${EVIDENCE}/owner-1440-${data}.png` });
    assert.deepEqual(errors, []);
    record(`data ${data}`);
    await context.close();
  }

  // 6. Long name, normal motion: the indicator animates and nothing overflows.
  {
    const { context, page, errors } = await open(
      { role: "owner", data: "populated", name: "Nguyễn Thị Phương Thảo Kế Toán Trưởng Chi Nhánh Tân Tạo" },
      "/",
      { width: 1280, height: 800 },
      { reducedMotion: "no-preference" },
    );
    await page.waitForTimeout(900);
    const transition = await page.$eval(".d3-tabs-ind", (el) => getComputedStyle(el).transitionDuration);
    assert.ok(transition.includes("0.5s"), "indicator transition active");
    await page.locator(".d3-avatar").click();
    const menu = await page.locator(".d3-menu").boundingBox();
    assert.ok(menu.x >= 0 && menu.x + menu.width <= 1280);
    await page.screenshot({ path: `${EVIDENCE}/owner-1280-longname-motion.png` });
    assert.deepEqual(errors, []);
    record("long name + motion");
    await context.close();
  }

  // 7. Theme scope: the public trace page (outside AppLayout) keeps the original look.
  {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    await context.route("**/*", (r) => (r.request().url().startsWith(BASE) || /fonts\./.test(r.request().url()) ? r.continue() : r.abort()));
    const page = await context.newPage();
    await page.goto(BASE + "/trace/qa-token", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
    assert.equal(await page.evaluate(() => document.documentElement.classList.contains("bmq-d3")), false, "no theme on public trace page");
    const bg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--background").trim());
    assert.equal(bg, "36 45% 97%", "original tokens on public trace page");
    record("theme scoped away from public trace page");
    await context.close();
  }
} finally {
  fs.writeFileSync(`${EVIDENCE}/qa-demo3-shell.json`, JSON.stringify(results, null, 2));
  await browser.close();
  await server.close();
}
console.log(`ALL ${results.length} QA CHECKS PASSED — evidence in ${EVIDENCE}`);
