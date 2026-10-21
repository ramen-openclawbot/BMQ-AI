// Browser QA for the Impeccable pass on the shared dialogs (desktop and phone): the three
// "Tạo duyệt chi" dialogs fit the viewport, scroll inside, have a visible close key, no eyebrow
// above their title and no element wider than the dialog; screenshots of each.
//
// FIXTURE AUTH + FIXTURE DATA: AuthContext and the Supabase client are replaced by in-memory
// fixtures; every write is refused and recorded, and all non-local network is blocked. This
// proves the real shell/page components render and navigate; it is not real-user acceptance.
//
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome node scripts/qa_impeccable_dialogs.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-impeccable-dialogs-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5198);
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
  if (st.single) return { data: null, error: null };
  const rows = filled ? fixtureRows(st) : null;
  if (rows) return { data: rows, error: null, count: rows.length };
  return { data: [], error: null, count: 0 };
}
const vnDay = (offsetDays) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Ho_Chi_Minh" }).format(new Date(Date.now() - offsetDays * 86400000));
function fixtureRows(st) {
  if (st.table === "revenue_ledger_lines") {
    const rows = [];
    // The ledger lags: no figures for today and yesterday.
    for (let back = 2; back < 20; back += 1) {
      const day = vnDay(back);
      if (day.slice(0, 7) !== st.filters.period) continue;
      const wave = Math.sin(back / 2);
      // Full ledger row shape, so the real revenue pages render with it too.
      const line = (channel, customer, amount, qty) => ({
        id: day + "-" + channel + "-" + customer, period: day.slice(0, 7), revenue_date: day, channel, source_tab: channel,
        customer_id: "c-" + customer, parent_customer_id: null, customer_name: customer, quantity: qty,
        gross_revenue: Math.round(amount), source_type: "dealer_portal", approval_status: "approved",
        raw_payload: {}, source_document: { status: "controlled" },
      });
      rows.push(line("ĐẠI LÝ", "NPP Bình Tân", (9 + 2 * wave) * 1e6, 1400));
      rows.push(line("ĐẠI LÝ", "Đại lý Quận 7", (6 + wave) * 1e6, 900));
      rows.push(line("BÁNH NGỌT", "Bánh ngọt Q7", (9 + 2 * Math.cos(back)) * 1e6, 600));
      rows.push(line("Retail Kiosk", "Kiosk Bình Thạnh", (3 + wave) * 1e6, 220));
      if (back % 3 === 0) rows.push(line("B2B BMQ", "Siêu thị Co.op", 4.5e6, 300));
    }
    return rows;
  }
  if (st.table === "rpc:get_kiosk_point_revenue_reviews") {
    const names = ["Kiosk Bình Thạnh", "Kiosk Phú Nhuận", "Kiosk Bình Dương", "Kiosk Quận 7", "Kiosk Thủ Đức", "Kiosk Gò Vấp", "Kiosk Tân Bình", "Kiosk Quận 10", "Kiosk Hotline"];
    const rows = names.map((name, i) => ({
      report_id: "r" + i, report_date: vnDay(0), location_id: "loc-" + i, location_name: name, staff_name: "NV " + (i + 1),
      submitted_at: new Date().toISOString(), review_status: "pending", reviewed_at: null, reviewed_by_name: null, review_note: null, report_notes: null,
      channels: [
        { channel_code: "retail", channel_name: "Khách lẻ", quantity: 40 + i * 7, source_amount_vnd: (40 + i * 7) * 14000, effective_amount_vnd: (40 + i * 7) * 14000, corrected: false },
        { channel_code: "grab", channel_name: "Grab", quantity: 12 + i * 2, source_amount_vnd: (12 + i * 2) * 14000, effective_amount_vnd: (12 + i * 2) * 14000, corrected: false },
      ],
    }));
    rows.push({ ...rows[1], report_id: "dup" });
    return rows;
  }
  if (st.table === "production_orders") return [{ status: "planned" }, { status: "planned" }, { status: "planned" }, { status: "draft" }, { status: "completed" }].map((r, i) => ({ id: "po" + i, ...r }));
  if (st.table === "inventory_items") return [
    { id: "i1", name: "Bơ lạt", quantity: 2, min_stock: 10 },
    { id: "i2", name: "Pate gan", quantity: 0, min_stock: 5 },
    { id: "i3", name: "Bột mì", quantity: 80, min_stock: 20 },
  ];
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
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-impeccable-dialogs-qa/vite-cache",
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


// Dialog title must not run under the close key; date inputs must stay inside the dialog and shrink.
async function dialogLayout(dialog) {
  return dialog.evaluate((d) => {
    const r = d.getBoundingClientRect();
    const title = d.querySelector(":scope > div > h2") || d.querySelector("h2");
    const close = [...d.querySelectorAll(":scope > button")].find((b) => b.querySelector(".sr-only"));
    const t = title?.getBoundingClientRect();
    const c = close?.getBoundingClientRect();
    const textRight = (() => {
      if (!title) return null;
      const range = document.createRange();
      range.selectNodeContents(title);
      return Math.max(...[...range.getClientRects()].map((x) => x.right));
    })();
    const dates = [...d.querySelectorAll("input[type='date'], input[type='month']")].map((el) => {
      const b = el.getBoundingClientRect();
      return { right: Math.round(b.right), minWidth: getComputedStyle(el).minWidth, align: getComputedStyle(el).textAlign };
    });
    return {
      titleFont: title ? getComputedStyle(title).fontSize : null,
      titleWeight: title ? getComputedStyle(title).fontWeight : null,
      titleTextRight: textRight && Math.round(textRight),
      closeLeft: c && Math.round(c.left),
      titleTop: t && Math.round(t.top), closeBottom: c && Math.round(c.bottom),
      dialogRight: Math.round(r.right),
      dates,
    };
  });
}

const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
  { width: 320, height: 640 },
];
const CHOICES = [
  { key: "po", text: "Đề nghị chi theo PO / NCC" },
  { key: "cash", text: "Chi tiền mặt" },
  { key: "salary", text: "Chi lương" },
];

try {
  for (const viewport of WIDTHS) {
    for (const choice of CHOICES) {
      const { context, page, errors } = await open({ role: "owner", data: "populated" }, "/", viewport);
      await page.locator("[data-bmq-pr-create-menu]").first().click();
      await page.waitForTimeout(400);
      await page.locator("[role='menuitem'], [data-bmq-pr-create-sheet] button", { hasText: choice.text }).first().click();
      const dialog = page.locator("[role='dialog']").last();
      await dialog.waitFor({ timeout: 10000 });
      await page.waitForTimeout(600);
      const facts = await dialog.evaluate((d) => {
        const r = d.getBoundingClientRect();
        const wide = [...d.querySelectorAll("*")].filter((el) => {
          const b = el.getBoundingClientRect();
          return b.width > 0 && b.right > r.right + 1 && !el.closest("[class*='overflow-x-auto'],[class*='overflow-auto']");
        }).map((el) => (el.textContent || "").trim().slice(0, 30) + " | " + String(el.className).slice(0, 40)).slice(0, 4);
        const title = d.querySelector("h2, [id$='-title']");
        const eyebrow = [];
        if (title) {
          let sib = title.previousElementSibling;
          while (sib) {
            const cs = getComputedStyle(sib);
            if (sib.textContent.trim() && (cs.textTransform === "uppercase" || parseFloat(cs.letterSpacing) > 1.5)) eyebrow.push(sib.textContent.trim().slice(0, 30));
            sib = sib.previousElementSibling;
          }
        }
        const close = [...d.querySelectorAll(":scope > button")].find((b) => b.querySelector(".sr-only"));
        const c = close?.getBoundingClientRect();
        const hit = c ? document.elementFromPoint(c.left + c.width / 2, c.top + c.height / 2) : null;
        return {
          box: { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: innerWidth, h: innerHeight },
          wide, eyebrow,
          close: c ? { w: c.width, h: c.height, onTop: Boolean(hit && (hit === close || close.contains(hit))), opacity: getComputedStyle(close).opacity } : null,
          title: title?.textContent?.trim().slice(0, 60) ?? null,
        };
      });
      await page.screenshot({ path: `${EVIDENCE}/${choice.key}-${viewport.width}.png` });
      if (!process.env.SHOTS_ONLY) {
        assert.ok(facts.box.left >= -1 && facts.box.right <= facts.box.w + 1, `dialog inside viewport ${choice.key} ${viewport.width}: ${JSON.stringify(facts.box)}`);
        assert.deepEqual(facts.wide, [], `nothing wider than the dialog ${choice.key} ${viewport.width}`);
        assert.deepEqual(facts.eyebrow, [], `no eyebrow above the dialog title ${choice.key} ${viewport.width}`);
        assert.ok(facts.close && facts.close.onTop && facts.close.w >= 36 && facts.close.opacity === "1", `close key visible ${choice.key} ${viewport.width}: ${JSON.stringify(facts.close)}`);
      }
      assert.deepEqual(errors, [], `page errors ${choice.key}`);
      record(`${choice.key} ${viewport.width}`, facts);
      await context.close();
    }
  }
  // Owner IMG_5997: "Sửa lệnh sản xuất" on iPhone — heavy title under the close key, dates past the edge.
  for (const viewport of WIDTHS) {
    const { context, page, errors } = await open({ role: "owner", data: "populated" }, "/production/planning/q7", viewport);
    await page.waitForSelector(".d3-pp-order-row", { timeout: 20000 });
    await page.locator(".d3-pp-order-row").first().click();
    await page.locator(".d3-pp-order-actions button", { hasText: "Sửa" }).first().click();
    const dialog = page.locator("[role='dialog']").last();
    await dialog.waitFor({ timeout: 10000 });
    await page.waitForTimeout(500);
    const lay = await dialogLayout(dialog);
    await page.screenshot({ path: `${EVIDENCE}/production-edit-${viewport.width}.png` });
    if (!process.env.SHOTS_ONLY) {
      assert.ok(lay.titleTextRight <= lay.closeLeft - 4 || lay.titleTop >= lay.closeBottom, `title clear of close key @${viewport.width}: ${JSON.stringify(lay)}`);
      assert.ok(Number(lay.titleWeight) <= 500, `dialog title not heavy @${viewport.width}: ${lay.titleWeight}`);
      assert.ok(lay.dates.length >= 2 && lay.dates.every((x) => x.right <= lay.dialogRight && x.minWidth === "0px" && x.align === "left"), `dates shrink and stay inside @${viewport.width}: ${JSON.stringify(lay.dates)}`);
    }
    assert.deepEqual(errors, []);
    record(`production edit ${viewport.width}`, lay);
    await context.close();
  }
} finally {
  fs.writeFileSync(`${EVIDENCE}/qa-impeccable-dialogs.json`, JSON.stringify(results, null, 2));
  await browser.close();
  await server.close();
}
console.log(`ALL ${results.length} IMPECCABLE DIALOG QA CHECKS PASSED — evidence in ${EVIDENCE}`);
