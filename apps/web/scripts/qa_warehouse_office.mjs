// Browser QA for Kho văn phòng (/warehouse/office): fixed-view room, shelf click + walk, product → old PR/PO picks,
// drag into the machine, robot package per supplier, PR desk full detail, approve / reject, owner and limited roles.
//
// FIXTURE AUTH + FIXTURE DATA: AuthContext and the Supabase client are replaced by in-memory fixtures built from a
// read-only snapshot of live data (16/10). RPC writes are recorded (and answered with a fake result) so the flow can
// be followed; nothing leaves the machine. This proves the page works; it is not real-user acceptance.
//
// Usage: [QA_PORT=5251] node scripts/qa_warehouse_office.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-warehouse-office-qa";
const PW = process.env.PLAYWRIGHT_CORE || "/private/tmp/pwqa/node_modules/playwright-core";
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5251);
const { chromium } = createRequire(import.meta.url)(PW);
fs.mkdirSync(EVIDENCE, { recursive: true });
const FIXTURE = JSON.parse(fs.readFileSync(path.join(ROOT, "scripts/qa_warehouse_office.fixture.json"), "utf8"));
const USER_ID = "00000000-0000-4000-8000-0000000000aa";
// One Kamereo document sits before the learned cutover so the fold shows; a learned pick pattern + recent packages.
const KAMEREO = Object.values(FIXTURE.debts).find((d) => d.rows.some((r) => r.number === "PO-000386"));
KAMEREO.rows[KAMEREO.rows.length - 1].before_cutover = true;
FIXTURE.recent = [{ id: "pkg-old", supplier_id: KAMEREO.supplier_id, result: { po_numbers: ["PO-000901"], purchase_order_ids: ["x"], debt: null, debt_picks: [{ kind: "pr", id: "y", number: "PR-OLD1", doc_date: null, remaining: 1, rank: 1 }] }, created_at: "2026-10-15T09:00:00+07:00" }];
const BANH_MI = FIXTURE.snapshot.tan_tao.items.find((i) => i.name === "Bánh mì que");
// Document photos (owner 16/10 IMG_5762): two attachments (one PDF), the delivery-note photo and one product photo;
// another PR's photo path does not sign, so it shows as unopenable instead of breaking the detail.
const DOC = (n) => Object.values(FIXTURE.details).find((d) => d && d.number === n);
Object.assign(DOC("PR-336DB95D"), { attachments: [{ path: "payment-requests/qa-bill.jpg", name: "hoa-don.jpg", mime: "image/jpeg" }, { path: "payment-requests/qa-contract.pdf", name: "hop-dong.pdf", mime: "application/pdf" }] });
Object.assign(DOC("PR-336DB95D").gr, { image_path: "goods-receipts/delivery-note-qa.jpg", photos: ["goods-receipts/qa-photo-1.jpg"] });
Object.assign(DOC("PR-4BFB7283").gr, { image_path: "goods-receipts/missing-qa.jpg", photos: [] });

const SUPABASE_FIXTURE = `
const F = () => window.__officeFixture;
window.__qaWrites = window.__qaWrites || [];
const WRITE = new Set(["insert", "update", "upsert", "delete"]);
function settle(st) {
  if (st.write) { window.__qaWrites.push(st.table + ":" + st.write); return { data: null, error: { message: "QA fixture: writes disabled" } }; }
  const a = st.args || {};
  if (st.table === "rpc:get_office_order_snapshot") return { data: F().snapshot[a.p_location], error: null };
  if (st.table === "rpc:get_supplier_debt_candidates") return { data: F().debts[a.p_supplier_id] || { supplier_id: a.p_supplier_id, cutover: null, stats: {}, rows: [] }, error: null };
  if (st.table === "rpc:get_payment_doc_detail") return { data: F().details[a.p_id] || null, error: null };
  if (st.table === "rpc:get_item_purchase_facts") return { data: [], error: null };
  if (st.table === "rpc:create_robot_order_package") {
    window.__qaWrites.push(st.table + ":" + JSON.stringify(a));
    const debt = Array.isArray(a.p_debt) && a.p_debt.length ? { kind: a.p_debt[0].kind, id: a.p_debt[0].id, number: "PO-QA-OLD", submission_id: "sub-qa", submission_number: "TC-QA-01" } : null;
    return { data: { package_id: "pkg-qa", purchase_order_ids: ["po-qa-1"], po_numbers: ["PO-QA-1"], debt, cutover_start_date: null, marked_settled_outside_count: 0, idempotent: false }, error: null };
  }
  if (st.table === "rpc:approve_payment_request_with_material_controller") { window.__qaWrites.push(st.table + ":" + JSON.stringify(a)); return { data: { status: "approved", material_master: {} }, error: null }; }
  if (st.table === "rpc:reject_payment_request") { window.__qaWrites.push(st.table + ":" + JSON.stringify(a)); return { data: null, error: null }; }
  if (st.table === "rpc:get_supplier_debt_pick_pattern") return { data: { supplier_id: a.p_supplier_id, packages: 2, last_picked_count: 1, median_picked_count: 1.5 }, error: null };
  if (st.table.startsWith("rpc:")) return { data: null, error: null };
  if (st.table === "payment_requests") return { data: F().pending, error: null };
  if (st.table === "suppliers") return { data: F().suppliers, error: null };
  if (st.table === "robot_order_packages") return { data: F().recent, error: null };
  return { data: [], error: null };
}
function builder(table, args) {
  const st = { table, args: args || {}, filters: {}, write: null };
  const proxy = new Proxy(function () {}, {
    get(_t, prop) {
      if (prop === "then") return (ok, ko) => Promise.resolve().then(() => settle(st)).then(ok, ko);
      if (prop === "catch") return (ko) => Promise.resolve(settle(st)).catch(ko);
      if (prop === "finally") return (fn) => Promise.resolve(settle(st)).finally(fn);
      return (...args) => { if (WRITE.has(prop)) st.write = prop; if (prop === "eq") st.filters[args[0]] = args[1]; return proxy; };
    },
  });
  return proxy;
}
const user = { id: "${USER_ID}", email: "qa@bmq.test", user_metadata: {} };
const channel = { on() { return channel; }, subscribe() { return channel; }, unsubscribe() {} };
export const supabase = {
  from: (table) => builder(table),
  rpc: (fn, args) => builder("rpc:" + fn, args),
  schema: () => ({ from: (table) => builder(table), rpc: (fn, args) => builder("rpc:" + fn, args) }),
  functions: { invoke: async (name) => { window.__qaWrites.push("invoke:" + name); return { data: null, error: { message: "QA fixture: functions disabled" } }; } },
  storage: { from: (bucket) => ({ getPublicUrl: () => ({ data: { publicUrl: "" } }), createSignedUrl: async (p) => {
    window.__qaSigned = (window.__qaSigned || []).concat(bucket + ":" + p);
    if (/missing/.test(p)) return { data: null, error: { message: "Object not found" } };
    const svg = "<svg xmlns='http://www.w3.org/2000/svg' width='400' height='200'><rect width='400' height='200' fill='#f5c542'/><text x='20' y='120' font-size='48'>" + p.split("/").pop() + "</text></svg>";
    return { data: { signedUrl: "data:image/svg+xml," + encodeURIComponent(svg) }, error: null };
  } }) },
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
const cfg = JSON.parse(localStorage.getItem("qa-office") || "{}");
const role = cfg.role || "owner";
const MODULES = role === "owner" ? null : ["inventory", "goods_receipts", "suppliers"];
const user = { id: "${USER_ID}", email: "qa@bmq.test", user_metadata: { full_name: "QA" } };
const can = (key) => MODULES === null || MODULES.includes(key);
const value = { user, session: { access_token: "qa", user }, profile: { id: "qa-profile", user_id: user.id, full_name: "QA", email: user.email },
  loading: false, timedOut: false, roles: role === "owner" ? ["owner"] : ["staff"], authzLoaded: true, authzError: false, isOwner: role === "owner",
  canAccessModule: can, canEditModule: can, signOut: async () => {}, refreshProfile: async () => {}, refreshRoles: async () => {} };
const Ctx = createContext(value);
export function AuthProvider({ children }) { return React.createElement(Ctx.Provider, { value }, children); }
export function useAuth() { return useContext(Ctx); }
`;

const fixtures = {
  name: "qa-office-fixtures",
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
  root: ROOT, configFile: false, logLevel: "error",
  cacheDir: process.env.QA_VITE_CACHE || "/tmp/bmq-warehouse-office-qa/vite-cache",
  server: { port: PORT, strictPort: true, host: "127.0.0.1" },
  define: { __APP_VERSION__: JSON.stringify("qa"), __APP_SEMVER__: JSON.stringify("vqa") },
  resolve: { alias: { "@": path.join(ROOT, "src") } },
  plugins: [fixtures, react()],
});
await server.listen();
const BASE = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({ executablePath: CHROME, args: ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"] });
let failures = 0;
const check = async (name, fn) => { try { await fn(); console.log("PASS", name); } catch (e) { failures++; console.log("FAIL", name, String(e.message).split("\n")[0]); } };
const room = (page, fn, arg) => page.evaluate(([f, a]) => window.__room[f](...(a ?? [])), [fn, arg]);
const writes = (page) => page.evaluate(() => window.__qaWrites.slice());
const basketCount = (page) => page.locator(".kvp .basket b").first().textContent().then(Number);
const projection = (page) => page.evaluate(() => { const c = window.__room.camera; return [c.left, c.right, c.top, c.bottom, ...c.position.toArray()].map((v) => v.toFixed(4)).join(","); });

async function open(viewport, cfg, touch, basket) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: touch ? 2 : 1, hasTouch: touch, isMobile: touch, locale: "vi-VN" });
  await context.addInitScript((f) => { window.__officeFixture = f; }, FIXTURE);
  await context.addInitScript((v) => localStorage.setItem("qa-office", JSON.stringify(v)), cfg);
  if (basket) await context.addInitScript((b) => { if (!sessionStorage.getItem("qa-seeded")) { sessionStorage.setItem("bmq-robot-basket-v1", JSON.stringify(b)); sessionStorage.setItem("qa-seeded", "1"); } }, basket);
  await context.route("**/*", (r) => {
    const url = r.request().url();
    if (url.startsWith(BASE) || url.startsWith("data:") || url.startsWith("blob:") || /fonts\.(googleapis|gstatic)\.com/.test(url)) return r.continue();
    return r.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource|net::ERR/.test(m.text())) errors.push(m.text()); });
  await page.goto(`${BASE}/warehouse/office?kho=tan_tao`, { waitUntil: "networkidle" });
  await page.waitForSelector("[data-office-page] .chip-btn.skip", { timeout: 20000 });
  await page.getByRole("button", { name: /Bỏ qua/ }).click();
  await page.waitForTimeout(900);
  return { context, page, errors, cdp: touch ? await context.newCDPSession(page) : null };
}

async function dragTo(page, cdp, from, to) {
  const steps = 14;
  if (!cdp) {
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    for (let i = 1; i <= steps; i++) await page.mouse.move(from.x + (to.x - from.x) * (i / steps), from.y + (to.y - from.y) * (i / steps));
    await page.waitForTimeout(200);
    const hot = await page.locator(".kvp .ghost.is-hot").count();
    await page.mouse.up();
    return hot;
  }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: from.x, y: from.y, id: 1 }] });
  for (let i = 1; i <= steps; i++) { await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: from.x + (to.x - from.x) * (i / steps), y: from.y + (to.y - from.y) * (i / steps), id: 1 }] }); await page.waitForTimeout(16); }
  await page.waitForTimeout(200);
  const hot = await page.locator(".kvp .ghost.is-hot").count();
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  return hot;
}

for (const vp of [{ width: 1440, height: 900, touch: false }, { width: 1280, height: 720, touch: false }, { width: 390, height: 844, touch: true }]) {
  const w = vp.width;
  const { context, page, errors, cdp } = await open({ width: w, height: vp.height }, { role: "owner" }, vp.touch);
  const view0 = await projection(page);
  await check(`${w} room + panel render on live-shaped data`, async () => {
    assert.ok((await page.locator(".kvp .rows .row").count()) >= 4, "predicted low rows");
    assert.ok((await page.locator(".kvp .chips [data-group]").count()) >= 8, "shelf chips");
    assert.ok((await page.evaluate(() => document.documentElement.scrollWidth)) <= w + 1, "no sideways scroll");
  });
  await page.screenshot({ path: `${EVIDENCE}/ready-${w}.png` });

  // Click a shelf in the room: the avatar walks there and the panel opens it.
  const codes = await page.locator(".kvp .chips [data-group]").evaluateAll((els) => els.map((el) => el.dataset.group));
  const panelTop = vp.touch ? (await page.locator(".kvp .panel").boundingBox()).y : vp.height;
  let code = null, pt = null;
  for (const c of codes) { const p = await room(page, "shelfScreen", [c]); if (p && p.x > 10 && p.x < (vp.touch ? w : w - 430) - 10 && p.y > 70 && p.y < panelTop - 10) { code = c; pt = p; break; } }
  await check(`${w} shelf click walks the avatar and opens the shelf`, async () => {
    assert.ok(pt, "a shelf is in view");
    if (!cdp) await page.mouse.click(pt.x, pt.y);
    else { await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: pt.x, y: pt.y, id: 1 }] }); await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); }
    await page.waitForTimeout(250);
    const me = await page.evaluate(() => window.__room.avatarAt(window.__room.now()));
    assert.ok(me.moving, "avatar walking");
    assert.match(await page.locator(`.kvp .chips [data-group='${code}']`).getAttribute("class"), /is-on/);
  });
  await page.waitForTimeout(2200);

  // Product → its supplier's old unpaid documents (Kamereo has 5).
  await page.getByRole("textbox", { name: "Tìm nguyên vật liệu" }).fill("dầu ăn tường an");
  await page.waitForTimeout(250);
  await page.locator(".kvp .rows .row .row-main .info").first().click();
  await page.waitForSelector(".kvp .row.is-open .debt .pick", { timeout: 5000 });
  await check(`${w} product shows the supplier's old PR/PO and a pick sums`, async () => {
    await page.locator(".kvp .row.is-open .debt .pick input").first().check();
    assert.match(await page.locator(".kvp .row.is-open .debt .sum").textContent(), /Chi kèm 1 phiếu/);
  });
  await page.screenshot({ path: `${EVIDENCE}/product-${w}.png` });
  await check(`${w} a good kept at Q7 says it is delivered to Tân Tạo then moved on`, async () => {
    await page.getByRole("textbox", { name: "Tìm nguyên vật liệu" }).fill("bột mì 888");
    await page.waitForTimeout(250);
    assert.match(await page.locator(".kvp .rows .row [data-office-to-q7]").first().textContent(), /Giao về Tân Tạo → tự chuyển Q7/);
    await page.getByRole("textbox", { name: "Tìm nguyên vật liệu" }).fill("dầu ăn tường an");
    await page.waitForTimeout(250);
    assert.equal(await page.locator(".kvp .rows .row [data-office-to-q7]").count(), 0, "Tân Tạo goods carry no note");
  });

  // Drag into the machine.
  const count0 = await basketCount(page);
  await page.locator(".kvp .rows .row .grip").first().scrollIntoViewIfNeeded();
  const g = await page.locator(".kvp .rows .row .grip").first().boundingBox();
  const hot = await dragTo(page, cdp, { x: g.x + g.width / 2, y: g.y + g.height / 2 }, await room(page, "hopperScreen"));
  await page.waitForTimeout(700);
  await check(`${w} drag into the hopper adds the product`, async () => {
    assert.equal(hot, 1, "ghost hot over the machine");
    assert.equal(await basketCount(page), count0 + 1);
  });

  // Machine: picks kept per supplier; an old document opens in full; one robot package per supplier.
  await page.getByRole("button", { name: "Xoá tìm kiếm" }).click();
  await page.getByRole("button", { name: /Chọn PR & đặt/ }).click();
  await page.waitForSelector(".kvp .sup-card .debt .pick", { timeout: 5000 });
  await check(`${w} machine keeps the pick; old doc opens in full`, async () => {
    assert.ok((await page.locator(".kvp .sup-card .pick input:checked").count()) >= 1);
    const num = await page.locator(".kvp .sup-card .debt .view").first().getAttribute("data-view");
    await page.locator(".kvp .sup-card .debt .view").first().click();
    await page.waitForSelector(".kvp .doc-modal [data-office-doc]", { timeout: 5000 });
    assert.equal(await page.locator(".kvp .doc-modal .doc-head > b").textContent(), num);
    assert.ok((await page.locator(".kvp .doc-modal .doc-lines li").count()) >= 1);
    const [sw, cw] = await page.locator(".kvp .panel-body").evaluate((el) => [el.scrollWidth, el.clientWidth]);
    assert.ok(sw <= cw + 1, `${sw} > ${cw}`);
  });
  await page.screenshot({ path: `${EVIDENCE}/old-doc-${w}.png` });
  await page.getByRole("button", { name: "Đóng chi tiết" }).click();
  await page.locator(".kvp .machine-view .primary.big").click();
  await page.waitForTimeout(600);
  await check(`${w} send creates a robot package with lines + the picked old doc`, async () => {
    const pk = (await writes(page)).filter((x) => x.startsWith("rpc:create_robot_order_package:"));
    assert.equal(pk.length, 1, JSON.stringify(pk));
    const args = JSON.parse(pk[0].slice("rpc:create_robot_order_package:".length));
    assert.equal(args.p_lines.length, 1);
    assert.ok(args.p_lines[0].supplier_id && args.p_lines[0].item_id, "line carries supplier + item");
    assert.equal(Array.isArray(args.p_debt) ? args.p_debt.length : 0, 1, "picked old doc sent");
    assert.ok(args.p_idempotency_key, "idempotency key");
    assert.match(await page.locator(".kvp .toast").textContent(), /Đã tạo 1 đơn nháp/);
  });
  await page.screenshot({ path: `${EVIDENCE}/sent-${w}.png` });
  await page.waitForTimeout(2200);

  // Desk: a real pending PR opens with all 13 lines; approve goes through the finance controller.
  await page.locator(".kvp .chips [data-station='desk']").click();
  await page.waitForTimeout(400);
  await page.locator(".kvp [data-pr='PR-336DB95D']").click();
  await page.waitForSelector(".kvp .doc-modal [data-office-doc='PR-336DB95D']", { timeout: 5000 });
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${EVIDENCE}/pr-${w}.png` });
  await check(`${w} PR opens in full (13 lines, PO link) with the approve bar`, async () => {
    assert.equal(await page.locator(".kvp .doc-modal .doc-lines li").count(), 13);
    assert.match(await page.locator(".kvp .doc-modal .doc-refs").textContent(), /PO-000832/);
    assert.ok(await page.getByRole("button", { name: /Duyệt chi/ }).isVisible());
  });
  await check(`${w} PR photos show as thumbnails and open in a viewer that rotates`, async () => {
    const box = page.locator(".kvp .doc-modal [data-office-photos]");
    assert.equal(await box.getAttribute("data-office-photos"), "4");
    await page.waitForFunction(() => document.querySelectorAll(".kvp .doc-modal .doc-photos img").length === 3, null, { timeout: 5000 });
    assert.equal(await page.locator(".kvp .doc-modal .doc-photos .ph-pdf").count(), 1, "PDF attachment shown as a file");
    const signed = await page.evaluate(() => window.__qaSigned);
    assert.ok(signed.includes("invoices:goods-receipts/delivery-note-qa.jpg"), JSON.stringify(signed));
    await page.locator(".kvp [data-office-photo='Phiếu nhập GRN-000583']").click();
    const viewer = page.locator(".kvp [data-office-viewer]");
    await viewer.waitFor({ timeout: 3000 });
    const vb = await viewer.boundingBox();
    assert.ok(vb.width >= w - 1 && vb.y <= 1, "viewer covers the screen");
    assert.match(await viewer.textContent(), /3\/4/);
    assert.ok(await page.locator("[data-office-viewer-img]").evaluate((img) => img.complete && img.naturalWidth > 0), "image decoded");
    await page.getByRole("button", { name: "Xoay ảnh" }).click();
    assert.match(await page.locator("[data-office-viewer-img]").getAttribute("style"), /rotate\(90deg\)/);
    await page.waitForTimeout(300);
    const fits = await page.evaluate(() => { const r = document.querySelector("[data-office-viewer-img]").getBoundingClientRect(); const s = document.querySelector(".kvp .pv-stage").getBoundingClientRect(); return r.left >= s.left - 1 && r.right <= s.right + 1 && r.top >= s.top - 1 && r.bottom <= s.bottom + 1; });
    assert.ok(fits, "rotated photo stays inside the screen");
    await page.getByRole("button", { name: "Ảnh sau" }).click();
    assert.match(await viewer.textContent(), /4\/4/);
    assert.match(await page.locator("[data-office-viewer-img]").getAttribute("style"), /rotate\(0deg\)/, "rotation resets per photo");
    const [sw, cw] = await page.locator(".kvp .pv-bar").evaluate((el) => [el.scrollWidth, el.clientWidth]);
    assert.ok(sw <= cw + 1, `viewer bar overflows ${sw} > ${cw}`);
  });
  await page.screenshot({ path: `${EVIDENCE}/photo-viewer-${w}.png` });
  await page.getByRole("button", { name: "Đóng ảnh" }).click();
  await check(`${w} closing the photo keeps the PR open`, async () => {
    assert.equal(await page.locator(".kvp [data-office-viewer]").count(), 0);
    assert.equal(await page.locator(".kvp .doc-modal [data-office-doc='PR-336DB95D']").count(), 1);
  });
  await page.locator(".kvp .doc-modal .doc-photos").scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${EVIDENCE}/pr-photos-${w}.png` });
  await page.getByRole("radio", { name: "Tiền mặt" }).click();
  await page.getByRole("button", { name: /Duyệt chi/ }).click();
  await page.waitForTimeout(500);
  await check(`${w} approve calls the finance controller with the chosen method`, async () => {
    const ap = (await writes(page)).filter((x) => x.startsWith("rpc:approve_payment_request_with_material_controller:"));
    assert.equal(ap.length, 1);
    assert.match(ap[0], /"p_payment_method":"cash"/);
    assert.match(ap[0], /"p_payment_request_id":"/);
  });
  // Reject another PR with a reason.
  await page.locator(".kvp [data-pr='PR-4BFB7283']").click();
  await page.waitForSelector(".kvp .doc-modal [data-office-doc='PR-4BFB7283']", { timeout: 5000 });
  await check(`${w} a photo that cannot be signed shows as unopenable`, async () => {
    await page.waitForSelector(".kvp .doc-modal .doc-photos .ph-miss", { timeout: 5000 });
    assert.ok(await page.locator(".kvp [data-office-photo='Phiếu nhập GRN-000590']").isDisabled());
  });
  await page.getByRole("button", { name: "Từ chối" }).click();
  await page.getByRole("textbox", { name: "Lý do từ chối" }).fill("Sai số lượng, NCC giao thiếu");
  await page.getByRole("button", { name: "Gửi từ chối" }).click();
  await page.waitForTimeout(400);
  await check(`${w} reject sends the reason`, async () => {
    const rj = (await writes(page)).filter((x) => x.startsWith("rpc:reject_payment_request:"));
    assert.equal(rj.length, 1);
    assert.match(rj[0], /Sai số lượng/);
  });
  await check(`${w} the view never moved`, async () => assert.equal(await projection(page), view0));
  await check(`${w} tap targets >= 32px`, async () => {
    const small = await page.evaluate(() => [...document.querySelectorAll(".kvp .panel button, .kvp .panel input:not([type=checkbox])")].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height < 31; }).map((el) => el.outerHTML.slice(0, 60)));
    assert.deepEqual(small, [], JSON.stringify(small));
  });
  await check(`${w} no page errors`, async () => assert.deepEqual(errors, []));
  await context.close();
}

// A shelf item sent from Kho 2D/3D ("🤖 Đặt hàng món này") arrives in the room; qty / price edits reach the package.
{
  const seed = [{ key: "k1", item_id: BANH_MI.id, name: BANH_MI.name, unit: "cái", qty: "500", supplier_id: BANH_MI.supplier_id, price: "1200" }];
  const { context, page, errors } = await open({ width: 1440, height: 900 }, { role: "owner" }, false, seed);
  await check("shared basket from Kho 2D/3D lands in the machine", async () => {
    assert.equal(await basketCount(page), 1);
    await page.locator(".kvp .chips [data-station='machine']").click();
    await page.waitForSelector(".kvp [data-office-line='Bánh mì que']", { timeout: 5000 });
    assert.equal(await page.locator("[data-office-line='Bánh mì que'] [data-office-qty]").inputValue(), "500");
    assert.equal(await page.locator("[data-office-line='Bánh mì que'] [data-office-price]").inputValue(), "1200");
  });
  await page.locator("[data-office-line='Bánh mì que'] [data-office-qty]").fill("600");
  await page.locator("[data-office-line='Bánh mì que'] [data-office-price]").click();
  await page.locator("[data-office-line='Bánh mì que'] [data-office-price]").fill("1250");
  await page.locator(".kvp .machine-view h3").first().click();
  await page.waitForTimeout(200);
  await check("basket edits persist in the shared session basket", async () => {
    const stored = await page.evaluate(() => JSON.parse(sessionStorage.getItem("bmq-robot-basket-v1") || "[]"));
    assert.equal(stored.length, 1);
    assert.equal(stored[0].qty, "600");
    assert.equal(stored[0].price, "1250");
  });
  await check("learned pattern, recent packages and Bé Mì review are shown", async () => {
    assert.ok(await page.locator("[data-office-recent]").isVisible(), "recent packages");
    assert.match(await page.locator("[data-office-recent]").textContent(), /PO-000901/);
    assert.ok((await page.locator("[data-office-jev]").count()) >= 1, "Bé Mì review button");
  });
  await page.locator(".kvp .machine-view .primary.big").click();
  await page.waitForTimeout(600);
  await check("edited qty and price are sent", async () => {
    const pk = (await writes(page)).filter((x) => x.startsWith("rpc:create_robot_order_package:"));
    assert.equal(pk.length, 1);
    assert.match(pk[0], /"quantity":600/);
    assert.match(pk[0], /"unit_price":1250/);
    assert.match(pk[0], /"p_debt":null/);
  });
  await page.waitForTimeout(2300);
  await check("sent lines leave the shared basket", async () => {
    const stored = await page.evaluate(() => JSON.parse(sessionStorage.getItem("bmq-robot-basket-v1") || "[]"));
    assert.equal(stored.length, 0);
    assert.equal(await basketCount(page), 0);
  });
  // Kamereo: the before-cutover row folds away; the learned pattern shows.
  await page.getByRole("textbox", { name: "Tìm nguyên vật liệu" }).fill("dầu ăn tường an");
  await page.locator(".kvp .rows .row .tap").first().click();
  await page.waitForTimeout(700);
  await page.getByRole("button", { name: "Xoá tìm kiếm" }).click();
  await page.locator(".kvp .chips [data-station='machine']").click();
  await page.waitForSelector(".kvp .sup-card [data-office-fold]", { timeout: 5000 });
  await check("old documents before the learned cutover fold away", async () => {
    assert.match(await page.locator(".kvp .sup-card [data-office-fold]").textContent(), /1 phiếu trước mốc/);
    assert.match(await page.locator(".kvp .sup-card [data-office-learned]").textContent(), /Lần trước chọn 1 phiếu/);
  });
  await page.screenshot({ path: `${EVIDENCE}/machine-parity-1440.png` });
  await page.getByRole("button", { name: "Về Kho" }).click();
  await check("back returns to the Kho game", async () => { await page.waitForURL(/\/warehouse\/game$/, { timeout: 5000 }); });
  await check("no page errors (basket flow)", async () => assert.deepEqual(errors.filter((e) => !/warehouse_game|snapshot/i.test(e)), []));
  await context.close();
}

// A user without payment-request rights sees the PR but no approve buttons.
{
  const { context, page, errors } = await open({ width: 1440, height: 900 }, { role: "limited" }, false);
  await page.locator(".kvp .chips [data-station='desk']").click();
  await page.locator(".kvp [data-pr='PR-336DB95D']").click();
  await page.waitForSelector(".kvp .doc-modal [data-office-doc]", { timeout: 5000 });
  await check("limited role: PR visible, approve hidden", async () => {
    assert.equal(await page.getByRole("button", { name: /Duyệt chi/ }).count(), 0);
    assert.match(await page.locator(".kvp .doc-modal").textContent(), /Chỉ người có quyền Đề nghị chi/);
    assert.deepEqual(errors, []);
  });
  await page.screenshot({ path: `${EVIDENCE}/limited-${1440}.png` });
  await context.close();
}

await browser.close();
await server.close();
console.log(failures ? `${failures} FAILED` : "ALL WAREHOUSE OFFICE QA CHECKS PASSED", "— evidence in", EVIDENCE);
process.exit(failures ? 1 : 0);
