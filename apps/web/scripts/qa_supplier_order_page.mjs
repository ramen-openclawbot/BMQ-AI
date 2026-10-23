// Browser QA for Đặt hàng (/dat-hang, owner 23/10/2026): supplier tabs, order lines, preview of the real
// email, send with gối đầu, sent history, catalog add/remove and the forbidden state, inside the app shell.
//
// FIXTURE AUTH + FIXTURE DATA: AuthContext and the Supabase client are replaced by in-memory fixtures; every
// RPC and function call is recorded and nothing leaves the machine. The preview email is built by the real
// shared builder. This proves the page renders, sizes and calls the right RPCs; it is not real-user acceptance.
//
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core node scripts/qa_supplier_order_page.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-supplier-order-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5263);
const { chromium } = createRequire(import.meta.url)(PW);
fs.mkdirSync(EVIDENCE, { recursive: true });

const SUPABASE_FIXTURE = `
import { buildSupplierOrderEmailLines } from "/supabase/functions/_shared/supplier-order-email.ts";
const cfg = () => JSON.parse(localStorage.getItem("qa-shell") || "{}");
window.__qaCalls = window.__qaCalls || [];
const PT = "bc39ded3-755c-4b31-9e4c-d7729e009608";
const TV = "9546bd80-18d7-4ec7-b0e5-de50798ea718";
const delivery = { address: "24 Đường số 36, P. Tân Quy, Q7, TP.HCM", contact_name: "Huỳnh Kim Ngân", contact_phone: "0926 504 623", note: "" };
const line = (id, name, wording, onHand, daily, proposal, price, open) => ({
  catalog_id: "c-" + id, item: { id, name, code: "NVL-" + id.slice(0, 3), unit: "g" }, product_name: wording, po_unit: "kg",
  po_unit_factor: "1000", pack_size_po: "25",
  stock: { on_hand: String(onHand), daily_usage: String(daily), days_left: daily > 0 ? String(Math.round(onHand / daily * 10) / 10) : null, reorder_date: "2026-11-02", last_count_date: "2026-10-16" },
  proposal_qty: String(proposal), unit_price: String(price), open_order: open || null,
});
const removed = () => JSON.parse(localStorage.getItem("qa-removed") || "[]");
const added = () => JSON.parse(localStorage.getItem("qa-added") || "[]");
function catalog(id) {
  if (id === PT) {
    const items = [
      line("1039f461-8f9f-45a1-b05c-b96cb736812e", "Bột mì 999 Cam", "Bột mì 999 Cam (25kg)", 303751.946, 13561.438, 0, 19300),
      line("64952d75-2351-43f8-886f-de5282c96ed2", "Bột mì 888 Cam", "Bột mì 888 Cam (25kg)", 232339.76, 18581.266, 0, 18296),
      line("6ba549f7-d3b6-4971-a742-2fb4091800bb", "Sữa Bột Béo New Zealand", "Sữa Bột Béo New Zealand (25kg)", -5712.81, 1303.958, 25, 140740),
      ...(added().includes("c78c5281-0000-4000-8000-000000000001") ? [line("c78c5281-0000-4000-8000-000000000001", "Men khô Meizan nhãn vàng", "Men Khô Meizan - Nhãn Vàng (0.5*10kg/Thùng)", 4200, 350, 0, 92592)] : []),
    ].filter((it) => !removed().includes(it.item.id));
    return { supplier: { id: PT, name: "Phúc Thịnh", email: "botmiphucthinh@gmail.com" }, delivery, mailbox_connected: true, blockers: [], items, prepay: null };
  }
  return {
    supplier: { id: TV, name: "TV Food", email: "hongtinh2603@gmail.com" }, delivery, mailbox_connected: true,
    blockers: cfg().blocked ? ["mailbox_not_connected"] : [],
    items: [line("3c16ed3f-54c7-427f-a316-5aa4fcadda5a", "Bơ Peerless Úc 25kg", "BƠ PEERLESS", 105812.654, 8870.791, 0, 90000,
      { po_number: "PO-000862", quantity: "75", unit: "kg", sent_at: "2026-10-23T05:09:25Z" })],
    prepay: { id: "pr-1", request_number: "PR-D6E88DCB", created_at: "2026-06-17T03:53:09Z", total_amount: "9000000", remaining: "9000000", po_number: "PO-000582", recent_submission: null },
  };
}
function history(id) {
  const mine = JSON.parse(localStorage.getItem("qa-orders") || "[]").filter((row) => row.supplier_id === id);
  if (id === TV) mine.push({ id: "h-tv", request_id: "r-tv", po_number: "PO-000862", total: "6750000", status: "sent", sent_at: "2026-10-23T05:09:25Z", to_email: "order@bmq.vn", created_at: "2026-10-23T05:09:22Z",
    lines: [{ position: 1, item_id: "3c16ed3f-54c7-427f-a316-5aa4fcadda5a", product_name: "BƠ PEERLESS", quantity: 75, unit: "kg", unit_price: 90000, line_total: 6750000 }],
    uploads: [{ file_name: "phieu-giao-hang-TV-Food.jpg", mime_type: "image/jpeg", size_bytes: 120000, created_at: "2026-10-23T08:00:00Z", storage_path: "h-tv/a.jpg" }], prepay: null });
  return { items: mine };
}
function settle(st) {
  window.__qaCalls.push(st.table + ":" + JSON.stringify(st.args));
  if (cfg().data === "forbidden" && st.table.startsWith("rpc:supplier_order_")) return { data: null, error: { message: "insufficient_privilege", code: "42501" } };
  if (st.table === "rpc:supplier_order_suppliers") return { data: [
    { id: PT, name: "Phúc Thịnh", email: "botmiphucthinh@gmail.com", item_count: catalog(PT).items.length, last_order: null, unpaid_count: 0 },
    { id: TV, name: "TV Food", email: "hongtinh2603@gmail.com", item_count: 1, last_order: { po_number: "PO-000862", sent_at: "2026-10-23T05:09:25Z" }, unpaid_count: 2 },
  ], error: null };
  if (st.table === "rpc:supplier_order_catalog") return { data: catalog(st.args.p_supplier_id), error: null };
  if (st.table === "rpc:supplier_order_catalog_candidates") return { data: added().length ? [] : [
    { item_id: "c78c5281-0000-4000-8000-000000000001", name: "Men khô Meizan nhãn vàng", unit: "g", latest_product_name: "Men Khô Meizan - Nhãn Vàng (0.5*10kg/Thùng)", last_order_date: "2026-09-17", line_count: 11 },
  ], error: null };
  if (st.table === "rpc:supplier_order_catalog_set") {
    const a = st.args;
    if (a.p_active) localStorage.setItem("qa-added", JSON.stringify([...added(), a.p_item_id]));
    else localStorage.setItem("qa-removed", JSON.stringify([...removed(), a.p_item_id]));
    return { data: { supplier_id: a.p_supplier_id, kitchen_inventory_item_id: a.p_item_id, active: a.p_active }, error: null };
  }
  if (st.table === "rpc:supplier_order_history_by_supplier") return { data: history(st.args.p_supplier_id), error: null };
  if (/^rpc:/.test(st.table)) return { data: null, error: null };
  return { data: [], error: null, count: 0 };
}
function builder(table, args) {
  const st = { table, args: args || {} };
  const proxy = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return (ok, ko) => Promise.resolve().then(() => settle(st)).then(ok, ko);
      if (prop === "catch") return (ko) => Promise.resolve(settle(st)).catch(ko);
      if (prop === "finally") return (fn) => Promise.resolve(settle(st)).finally(fn);
      return () => proxy;
    },
  });
  return proxy;
}
function priced(body) {
  const items = catalog(body.supplier_id).items;
  const lines = body.lines.map((l, i) => {
    const it = items.find((row) => row.item.id === l.item_id);
    const price = Number(it.unit_price);
    return { position: i + 1, item_id: l.item_id, product_name: it.product_name, quantity: l.quantity, unit: "kg", unit_price: price, line_total: Math.round(l.quantity * price * 100) / 100 };
  });
  return { lines, total: lines.reduce((s, l) => s + l.line_total, 0) };
}
const user = { id: "qa-user", email: "qa@bmq.test", user_metadata: {} };
const channel = { on() { return channel; }, subscribe() { return channel; }, unsubscribe() {} };
export const supabase = {
  from: (table) => builder(table),
  rpc: (fn, args) => builder("rpc:" + fn, args),
  schema: () => ({ from: (table) => builder(table), rpc: (fn) => builder("rpc:" + fn) }),
  functions: { invoke: async (name, options) => {
    window.__qaCalls.push("invoke:" + name + ":" + JSON.stringify(options?.body ?? {}));
    const b = options?.body ?? {};
    if (name !== "supplier-order-send" || !Array.isArray(b.lines)) return { data: null, error: { message: "QA fixture: functions disabled" } };
    const c = catalog(b.supplier_id);
    const { lines, total } = priced(b);
    if (b.mode === "preview") {
      const mail = buildSupplierOrderEmailLines({ poNumber: "", supplierName: c.supplier.name, lines: lines.map((l) => ({ productName: l.product_name, quantity: l.quantity, unit: l.unit, unitPrice: l.unit_price, lineTotal: l.line_total })),
        total, deliveryAddress: delivery.address, contactName: delivery.contact_name, contactPhone: delivery.contact_phone, note: b.note || "", requestedDate: "2026-10-23", uploadUrl: "", subjectName: c.supplier.name });
      return { data: { subject: mail.subject, html: mail.html, text: mail.text, to_email: c.supplier.email, lines, total, prepay: c.prepay, prepay_reason: c.prepay ? null : "none" }, error: null };
    }
    if (cfg().sendFails) return { data: { code: "email_failed" }, error: null };
    const po = "PO-0009" + String(10 + JSON.parse(localStorage.getItem("qa-orders") || "[]").length);
    const row = { supplier_id: b.supplier_id, id: "o-" + po, request_id: b.request_id, po_number: po, total, status: "sent", sent_at: new Date().toISOString(), to_email: c.supplier.email, created_at: new Date().toISOString(), lines, uploads: [],
      prepay: b.prepay && c.prepay ? { status: "created", request_number: c.prepay.request_number, submission_number: "TC-261023-05" } : null };
    localStorage.setItem("qa-orders", JSON.stringify([...JSON.parse(localStorage.getItem("qa-orders") || "[]"), row]));
    return { data: { status: "sent", po_number: po, to_email: c.supplier.email, sent_at: row.sent_at, prepay: b.prepay ? (c.prepay ? row.prepay : { status: "skipped_none", request_number: null, submission_number: null }) : null }, error: null };
  } },
  storage: { from: () => ({ getPublicUrl: () => ({ data: { publicUrl: "" } }), createSignedUrl: async () => ({ data: { signedUrl: "data:text/plain,qa" }, error: null }), list: async () => ({ data: [], error: null }) }) },
  auth: {
    getSession: async () => ({ data: { session: { access_token: "qa", user } }, error: null }),
    getUser: async () => ({ data: { user }, error: null }),
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    refreshSession: async () => ({ data: { session: { access_token: "qa", user } }, error: null }),
    signOut: async () => ({ error: null }),
  },
  channel: () => channel,
  removeChannel: () => {},
};
export default supabase;
`;

const AUTH_FIXTURE = `
import React, { createContext, useContext } from "react";
const user = { id: "qa-user", email: "qa@bmq.test", user_metadata: { full_name: "Tâm Vũ" } };
const value = {
  user, session: { access_token: "qa", user }, profile: { id: "qa-profile", user_id: "qa-user", full_name: "Tâm Vũ", email: user.email },
  loading: false, timedOut: false, roles: ["owner"], authzLoaded: true, authzError: false,
  isOwner: true, canAccessModule: () => true, canEditModule: () => true,
  signOut: async () => {}, refreshProfile: async () => {}, refreshRoles: async () => {},
};
const Ctx = createContext(value);
export function AuthProvider({ children }) { return React.createElement(Ctx.Provider, { value }, children); }
export function useAuth() { return useContext(Ctx); }
`;

const fixtures = {
  name: "qa-supplier-order-fixtures",
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

process.env.VITE_SUPABASE_URL ||= "https://qa-supabase.invalid";
process.env.VITE_SUPABASE_PUBLISHABLE_KEY ||= "qa-anon";
const server = await createServer({
  root: ROOT, configFile: false, logLevel: "error",
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-supplier-order-qa/vite-cache",
  server: { port: PORT, strictPort: true, host: "127.0.0.1" },
  define: { __APP_VERSION__: JSON.stringify("qa"), __APP_SEMVER__: JSON.stringify("vqa") },
  resolve: { alias: { "@": path.join(ROOT, "src") } },
  plugins: [fixtures, react()],
});
await server.listen();
const BASE = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({ executablePath: CHROME });
const results = [];
const pass = (name) => { results.push(name); console.log("PASS", name); };

async function open(cfg, route, viewport, ready = "[data-bmq-supplier-orders]") {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce", locale: "vi-VN" });
  await context.addInitScript((value) => { if (!sessionStorage.getItem("qa-init")) { localStorage.clear(); sessionStorage.setItem("qa-init", "1"); } localStorage.setItem("qa-shell", JSON.stringify(value)); }, cfg);
  await context.route("**/*", (r) => {
    const url = r.request().url();
    if (url.startsWith(BASE) || url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("about:")) return r.continue();
    return r.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + route, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("[data-bmq-shell='demo3-v1']", { timeout: 30000 });
  await page.waitForSelector(ready, { timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(250);
  return { context, page, errors };
}
const calls = (page) => page.evaluate(() => window.__qaCalls);
async function noSpill(page, label, vp) {
  const o = await page.evaluate(() => {
    const bad = [];
    for (const el of document.querySelectorAll(".d3-so *")) {
      const r = el.getBoundingClientRect();
      if (!r.width || getComputedStyle(el).position === "fixed") continue;
      if (el.closest(".d3-kho-tabs")) continue;
      if (r.right > window.innerWidth + 1 || r.left < -1) bad.push(`${el.tagName}.${String(el.className).slice(0, 60)}`);
    }
    return { doc: document.documentElement.scrollWidth - window.innerWidth, bad: bad.slice(0, 5) };
  });
  assert.ok(o.doc <= 0 && o.bad.length === 0, `${label} ${vp.width}: overflow ${JSON.stringify(o)}`);
}
async function shot(page, file) {
  await page.addStyleTag({ content: ".d3-app{height:auto!important}.d3-main{overflow:visible!important}" });
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${EVIDENCE}/${file}`, fullPage: true });
}
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B50}\u{FE0F}]/u;
const PT = "bc39ded3-755c-4b31-9e4c-d7729e009608";
const TV = "9546bd80-18d7-4ec7-b0e5-de50798ea718";
const I999 = "1039f461-8f9f-45a1-b05c-b96cb736812e";
const IMILK = "6ba549f7-d3b6-4971-a742-2fb4091800bb";
const VIEWPORTS = [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }];

try {
  for (const vp of VIEWPORTS) {
    const { context, page, errors } = await open({}, "/dat-hang", vp);
    // Main menu: Đặt hàng is its own zone and is the active one.
    if (vp.width >= 1024) {
      const tab = page.locator(".d3-tabs a.d3-tab", { hasText: "Đặt hàng" });
      assert.equal(await tab.count(), 1, "Đặt hàng tab in the main menu");
      assert.equal(await tab.getAttribute("aria-current"), "page", "Đặt hàng tab active");
    }
    assert.equal((await page.locator(".d3-screen h1, [data-bmq-supplier-orders] h1").first().innerText()).trim(), "Đặt hàng");
    await page.waitForSelector("[data-bmq-so-lines] li");
    const tabs = await page.locator("[data-bmq-so-suppliers] button").allInnerTexts();
    assert.ok(tabs.length === 2 && /Phúc Thịnh/.test(tabs[0]) && /3 món/.test(tabs[0]) && /TV Food/.test(tabs[1]), `supplier tabs ${tabs}`);
    const card = await page.locator("[data-bmq-so-card]").innerText();
    for (const text of ["botmiphucthinh@gmail.com", "Bột mì 999 Cam (25kg)", "19.300 đ/kg", "18.296 đ/kg", "đã hết", "chưa cần đặt", "đề xuất 25 kg", "Huỳnh Kim Ngân", "không có phiếu chi nào đang chờ trả"]) {
      assert.ok(card.includes(text), `Phúc Thịnh card shows "${text}" @${vp.width}: ${card}`);
    }
    assert.ok(!EMOJI.test(card), "no emoji");
    // Proposal seeds Sữa bột 25 kg; the others start empty.
    assert.equal(await page.locator(`[data-bmq-so-qty='${IMILK}']`).inputValue(), "25");
    assert.equal(await page.locator(`[data-bmq-so-qty='${I999}']`).inputValue(), "");
    assert.match(await page.locator("[data-bmq-so-total]").innerText(), /3\.518\.500 đ/);
    // + adds one bag of 25 kg.
    await page.locator(`[data-bmq-so-line='${I999}'] .d3-so-stepper button`).last().click();
    assert.equal(await page.locator(`[data-bmq-so-qty='${I999}']`).inputValue(), "25");
    assert.match(await page.locator("[data-bmq-so-total]").innerText(), /4\.001\.000 đ/);
    // A wrong number blocks Lập phiếu and says so on the line.
    await page.locator(`[data-bmq-so-qty='${I999}']`).fill("abc");
    assert.match(await page.locator(`[data-bmq-so-line='${I999}'] [data-bmq-so-line-total]`).innerText(), /Số chưa đúng/);
    assert.ok(await page.locator("[data-bmq-so-make]").isDisabled(), "Lập phiếu disabled on a bad number");
    await page.locator(`[data-bmq-so-qty='${I999}']`).fill("50");
    assert.match(await page.locator("[data-bmq-so-total]").innerText(), /4\.483\.500 đ/);
    await page.locator("[data-bmq-so-note]").fill("Giao trước 10h");
    // Kho name shows only when it adds something to the supplier's wording.
    assert.ok(!(await page.locator(`[data-bmq-so-line='${I999}'] .d3-so-line-main > small`).innerText()).includes("Bột mì 999 Cam\n"), "no duplicate kho name");
    assert.equal(await page.locator(`[data-bmq-so-line='${I999}'] .d3-so-line-main > small span`).first().innerText(), "19.300 đ/kg");
    // The VNAgent launcher never covers Lập phiếu once the button is on screen.
    const clash = await page.evaluate(() => {
      document.querySelector("[data-bmq-so-make]")?.scrollIntoView({ block: "center" });
      const a = document.querySelector("[data-bmq-so-make]")?.getBoundingClientRect();
      const l = document.querySelector(".d3-agent-launcher")?.getBoundingClientRect();
      if (!a || !l || !l.width) return false;
      return !(a.right <= l.left || a.left >= l.right || a.bottom <= l.top || a.top >= l.bottom);
    });
    assert.equal(clash, false, `launcher covers Lập phiếu @${vp.width}`);
    await noSpill(page, "form", vp);
    // A line total never sits on top of its stepper (320px puts it on its own row).
    const overlaps = await page.evaluate(() => [...document.querySelectorAll("[data-bmq-so-line]")].filter((li) => {
      const s = li.querySelector(".d3-so-stepper")?.getBoundingClientRect();
      const t = li.querySelector("[data-bmq-so-line-total]")?.getBoundingClientRect();
      if (!s || !t || !t.width) return false;
      return !(t.right <= s.left || t.left >= s.right || t.bottom <= s.top || t.top >= s.bottom);
    }).map((li) => li.getAttribute("data-bmq-so-line")));
    assert.deepEqual(overlaps, [], `line total overlaps its stepper @${vp.width}`);
    await shot(page, `form-pt-${vp.width}.png`);

    // Preview shows the real email; nothing is created yet.
    await page.locator("[data-bmq-so-make]").click();
    await page.waitForSelector("[data-bmq-so-preview]");
    const prev = (await calls(page)).filter((c) => c.startsWith("invoke:supplier-order-send:"));
    assert.equal(prev.length, 1);
    assert.ok(prev[0].includes('"mode":"preview"') && prev[0].includes('"quantity":50') && prev[0].includes('"quantity":25') && prev[0].includes("Giao trước 10h") && prev[0].includes('"prepay":false'), `preview body ${prev[0]}`);
    const frame = page.frameLocator("[data-bmq-so-mail]");
    const mailText = await frame.locator("body").innerText();
    for (const text of ["Kính gửi Phúc Thịnh", "Bột mì 999 Cam (25kg)", "Sữa Bột Béo New Zealand (25kg)", "4.483.500 đ", "Huỳnh Kim Ngân", "PO mới (số cấp khi gửi)", "Giao trước 10h"]) {
      assert.ok(mailText.includes(text), `email preview shows "${text}"`);
    }
    const frameBox = await page.locator("[data-bmq-so-mail]").boundingBox();
    assert.ok(frameBox && frameBox.height > 400, `email frame grows to its content: ${JSON.stringify(frameBox)}`);
    const facts = await page.locator(".d3-so-facts").innerText();
    assert.ok(/botmiphucthinh@gmail\.com/.test(facts) && /Không trình chi/.test(facts), `preview facts ${facts}`);
    await noSpill(page, "preview", vp);
    await shot(page, `preview-pt-${vp.width}.png`);

    // Sửa lại keeps the numbers.
    await page.locator("[data-bmq-so-back]").click();
    await page.waitForSelector("[data-bmq-so-lines]");
    assert.equal(await page.locator(`[data-bmq-so-qty='${I999}']`).inputValue(), "50");
    await page.locator("[data-bmq-so-make]").click();
    await page.waitForSelector("[data-bmq-so-preview]");
    await page.locator("[data-bmq-so-send]").click();
    await page.waitForSelector("[data-bmq-so-done]");
    const sent = (await calls(page)).filter((c) => c.includes('"mode":"send"'));
    assert.equal(sent.length, 1, "one send call");
    assert.ok(/"request_id":"[0-9a-f-]{36}"/.test(sent[0]), "send carries a request id");
    const done = await page.locator("[data-bmq-so-done]").innerText();
    assert.ok(/Đã gửi PO-0009/.test(done) && /botmiphucthinh@gmail\.com/.test(done), `done ${done}`);
    await page.waitForSelector("[data-bmq-so-history] li");
    const hist = await page.locator("[data-bmq-so-history]").innerText();
    assert.ok(/PO-0009/.test(hist) && /Bột mì 999 Cam \(25kg\) 50 kg/.test(hist) && /Đã gửi/.test(hist), `history ${hist}`);
    await noSpill(page, "sent", vp);
    await shot(page, `sent-pt-${vp.width}.png`);
    assert.deepEqual(errors, [], `page errors @${vp.width}`);
    await context.close();
    pass(`Phúc Thịnh: lines, stepper, bad number, preview email, send, history @${vp.width}`);

    // TV Food: gối đầu ticked by default, open PO note, uploads in history.
    const tv = await open({}, `/dat-hang?ncc=${TV}`, vp);
    await tv.page.waitForSelector("[data-bmq-so-prepay='pr']");
    assert.ok(await tv.page.locator("[data-bmq-so-prepay-check]").isChecked(), "gối đầu ticked");
    const tvCard = await tv.page.locator("[data-bmq-so-card]").innerText();
    assert.ok(/PR-D6E88DCB/.test(tvCard) && /9\.000\.000 đ/.test(tvCard) && /PO-000862 \(75 kg\) đã gửi, chưa nhận hàng/.test(tvCard), `TV card ${tvCard}`);
    assert.ok(await tv.page.locator("[data-bmq-so-make]").isDisabled(), "nothing picked yet");
    await tv.page.locator(".d3-so-stepper button").last().click();
    await tv.page.locator("[data-bmq-so-make]").click();
    await tv.page.waitForSelector("[data-bmq-so-preview]");
    assert.match(await tv.page.locator(".d3-so-facts").innerText(), /Trình chi gấp PR-D6E88DCB/);
    await tv.page.locator("[data-bmq-so-send]").click();
    await tv.page.waitForSelector("[data-bmq-so-done-prepay]");
    assert.match(await tv.page.locator("[data-bmq-so-done-prepay]").innerText(), /đã trình chi gấp TC-261023-05 cho PR-D6E88DCB/);
    const tvSend = (await calls(tv.page)).find((c) => c.includes('"mode":"send"'));
    assert.ok(tvSend.includes('"prepay":true') && tvSend.includes(TV), `TV send ${tvSend}`);
    const tvHist = await tv.page.locator("[data-bmq-so-history]").innerText();
    assert.ok(/phieu-giao-hang-TV-Food\.jpg/.test(tvHist) && /Gối đầu: TC-261023-05/.test(tvHist), `TV history ${tvHist}`);
    await noSpill(tv.page, "tv", vp);
    await shot(tv.page, `sent-tv-${vp.width}.png`);
    assert.deepEqual(tv.errors, [], `TV errors @${vp.width}`);
    await tv.context.close();

    // Untick gối đầu: the send says prepay false.
    const tv2 = await open({}, `/dat-hang?ncc=${TV}`, vp);
    await tv2.page.waitForSelector("[data-bmq-so-prepay-check]");
    await tv2.page.locator("[data-bmq-so-prepay-check]").uncheck();
    await tv2.page.locator(".d3-so-stepper button").last().click();
    await tv2.page.locator("[data-bmq-so-make]").click();
    await tv2.page.waitForSelector("[data-bmq-so-preview]");
    assert.match(await tv2.page.locator(".d3-so-facts").innerText(), /Không trình chi/);
    await tv2.page.locator("[data-bmq-so-send]").click();
    await tv2.page.waitForSelector("[data-bmq-so-done]");
    assert.ok((await calls(tv2.page)).find((c) => c.includes('"mode":"send"')).includes('"prepay":false'), "unticked gối đầu sends prepay false");
    await tv2.context.close();
    pass(`TV Food: gối đầu on/off, open PO, uploads @${vp.width}`);
  }

  // Catalog: add a delivered item, remove one.
  {
    const vp = { width: 390, height: 844 };
    const { context, page, errors } = await open({}, "/dat-hang", vp);
    await page.waitForSelector("[data-bmq-so-lines] li");
    await page.locator("[data-bmq-so-edit]").click();
    await page.waitForSelector("[data-bmq-so-candidates]");
    await page.locator("[data-bmq-so-add]").first().click();
    await page.waitForSelector("[data-bmq-so-line='c78c5281-0000-4000-8000-000000000001']");
    await page.locator(`[data-bmq-so-remove='${IMILK}']`).click();
    await page.waitForSelector(`[data-bmq-so-line='${IMILK}']`, { state: "detached" });
    const sets = (await calls(page)).filter((c) => c.startsWith("rpc:supplier_order_catalog_set:"));
    assert.ok(sets.length === 2 && sets[0].includes('"p_active":true') && sets[0].includes('"p_po_unit":"kg"') && sets[1].includes('"p_active":false') && sets[1].includes(IMILK), `catalog set calls ${sets}`);
    await noSpill(page, "catalog edit", vp);
    await shot(page, "catalog-edit-390.png");
    assert.deepEqual(errors, []);
    await context.close();
    pass("Sửa danh mục: add from history, remove");
  }

  // Forbidden and blocked states.
  for (const vp of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
    const { context, page } = await open({ data: "forbidden" }, "/dat-hang", vp);
    await page.waitForSelector(".d3-kho-failed");
    assert.match(await page.locator(".d3-kho-failed").innerText(), /Chỉ chủ hoặc người được sửa PO mới đặt hàng được/);
    await context.close();
    const blocked = await open({ blocked: true }, `/dat-hang?ncc=${TV}`, vp);
    await blocked.page.waitForSelector("[data-bmq-so-blockers]");
    assert.match(await blocked.page.locator("[data-bmq-so-blockers]").innerText(), /Chưa kết nối hộp thư order@bmq\.vn/);
    await blocked.page.locator(".d3-so-stepper button").last().click();
    assert.ok(await blocked.page.locator("[data-bmq-so-make]").isDisabled(), "blocked: Lập phiếu disabled");
    await blocked.context.close();
    const failing = await open({ sendFails: true }, "/dat-hang", vp);
    await failing.page.waitForSelector("[data-bmq-so-lines] li");
    await failing.page.locator("[data-bmq-so-make]").click();
    await failing.page.waitForSelector("[data-bmq-so-preview]");
    await failing.page.locator("[data-bmq-so-send]").click();
    await failing.page.waitForSelector("[data-bmq-so-send-error]");
    assert.match(await failing.page.locator("[data-bmq-so-send-error]").innerText(), /Chưa gửi được email\. Bấm gửi lại\./);
    assert.ok(await failing.page.locator("[data-bmq-so-send]").isEnabled(), "retry stays possible");
    await failing.context.close();
    pass(`forbidden, mailbox blocked, send failure @${vp.width}`);
  }
} finally {
  await browser.close();
  await server.close();
}
console.log(`\n${results.length} checks passed · evidence ${EVIDENCE}`);
