// Browser QA for Đặt hàng tự động (/warehouse/office), the warehouse you play in: the 3D room is the screen (shelf /
// desk / machine picked directly), the notebook board, "+ Thêm" crate drops, robot package per supplier, PR desk
// rows with photo badges, photo-first PR detail with viewer (rotate / zoom), approve / reject, owner and limited roles.
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
// Photo counts on the lists (migration 20261101370000 + usePendingPaymentRequests): PR-336DB95D carries a header
// photo and one attachment; the first Kamereo debt row carries 3 photos, the others none.
Object.assign(FIXTURE.pending.find((p) => p.request_number === "PR-336DB95D"), { image_url: "payment-requests/qa-pr-header.jpg", payment_request_attachments: [{ id: "att-1" }] });
KAMEREO.rows[0] = { ...KAMEREO.rows[0], has_image: true, image_path: "payment-requests/qa-old.jpg", photo_count: 3 };
// Stock ledger (shelf close-up, owner 17/10): Tân Tạo started 05/10; on-hand cycles full / half / low / empty against one
// usual delivery. Q7 has no ledger read here, so its jars fall back to the purchase-cycle forecast.
const LEDGER_FACTORS = [1.4, 0.45, 0.15, 0];
FIXTURE.ledger = { tan_tao: { location: "tan_tao", cutover_date: "2026-10-05", can_edit: true, skus: [], pending: [], transfers: [], counts: {},
  items: FIXTURE.snapshot.tan_tao.items.map((it, i) => ({ id: it.id, code: it.item_code ?? "", name: it.name, unit: it.unit ?? "", item_class: it.item_class ?? "raw_material",
    on_hand: Math.round((it.avg_qty ?? 5) * LEDGER_FACTORS[i % 4] * 100) / 100, last_count_date: null, aliases: [], pastry_q7: Boolean(it.pastry_q7) })) } };

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
  if (st.table === "rpc:get_warehouse_game_snapshot") return F().ledger && F().ledger[a.p_location] ? { data: F().ledger[a.p_location], error: null } : { data: null, error: { message: "QA fixture: no ledger for " + a.p_location } };
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
const basketCount = (page) => page.locator(".kvp .basket-info b").first().textContent().then((t) => (/^(\d+) món/.exec(t) ? Number(RegExp.$1) : 0));
const projection = (page) => page.evaluate(() => { const c = window.__room.camera; return [c.left, c.right, c.top, c.bottom, ...c.position.toArray()].map((v) => v.toFixed(4)).join(","); });
const tap = async (page, cdp, pt) => {
  if (!cdp) { await page.mouse.click(pt.x, pt.y); return; }
  await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: pt.x, y: pt.y, id: 1 }] });
  await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
};
const openMachine = async (page) => { await page.locator("[data-open-machine]").click(); await page.locator("[data-office-skip]").click({ timeout: 4000 }).catch(() => {}); await page.waitForSelector("[data-office-machine]", { timeout: 5000 }); };
const closeMachine = async (page) => { await page.getByRole("button", { name: "Đóng máy" }).click(); await page.waitForTimeout(150); };

async function open(viewport, cfg, touch, basket, kho = "tan_tao") {
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
  await page.goto(`${BASE}/warehouse/office${kho ? `?kho=${kho}&from=kho` : ""}`, { waitUntil: "networkidle" });
  await page.waitForSelector("[data-office-page].is-ready", { timeout: 20000 });
  await page.waitForTimeout(700);
  return { context, page, errors, cdp: touch ? await context.newCDPSession(page) : null };
}

for (const vp of [{ width: 1440, height: 900, touch: false }, { width: 1280, height: 720, touch: false }, { width: 390, height: 844, touch: true }, { width: 320, height: 568, touch: true }]) {
  const w = vp.width;
  const { context, page, errors, cdp } = await open({ width: w, height: vp.height }, { role: "owner" }, vp.touch);
  const view0 = await projection(page);
  await check(`${w} room + notebook render on live-shaped data, no entry picker`, async () => {
    assert.equal(await page.locator(".kvp .pick-kho").count(), 0, "no blank warehouse picker");
    assert.ok((await page.locator(".kvp .cards .card").count()) >= 4, "today's low rows");
    assert.ok((await page.locator(".kvp .chips [data-group]").count()) >= 8, "shelf chips");
    assert.equal(await page.locator("[data-office-here='tan_tao']").count(), 1, "entered from Kho Tân Tạo: the room shows where it is");
    assert.equal(await page.locator("[data-kho]").count(), 0, "no warehouse switch inside a warehouse");
    assert.ok((await page.evaluate(() => document.documentElement.scrollWidth)) <= w + 1, "no sideways scroll");
    const canvas = await page.locator(".kvp canvas.bay").boundingBox();
    assert.ok(canvas.width > 200 && canvas.height > 200, "room visible");
  });
  await page.screenshot({ path: `${EVIDENCE}/ready-${w}.png` });

  // Touch a shelf in the room: the notebook opens it (no walking).
  const codes = await page.locator(".kvp .chips [data-group]").evaluateAll((els) => els.map((el) => el.dataset.group));
  const boardTop = vp.touch ? (await page.locator(".kvp .board").boundingBox()).y : vp.height;
  let code = null, pt = null;
  for (const c of codes) { const p = await room(page, "shelfScreen", [c]); if (p && p.x > 10 && p.x < (vp.touch ? w : w - 410) - 10 && p.y > 110 && p.y < boardTop - 10) { code = c; pt = p; break; } }
  await check(`${w} touching a shelf in the room opens it in the notebook`, async () => {
    assert.ok(pt, "a shelf is in view");
    await tap(page, cdp, { x: pt.x, y: pt.y + 10 });
    await page.waitForTimeout(300);
    assert.equal(await page.locator(`.kvp .chips [data-group='${code}']`).getAttribute("aria-pressed"), "true");
    assert.match(await page.locator(".kvp .board-head b").textContent(), /^Kệ /);
    assert.equal(await projection(page), view0, "the view never moves");
  });
  await check(`${w} the shelf zooms in: products stand on planks, jars full/half/low/empty from the stock ledger`, async () => {
    const zoom = page.locator(`.kvp [data-office-zoom='${code}']`);
    await zoom.waitFor({ timeout: 3000 });
    await page.waitForTimeout(400); // let the zoom-in settle before measuring / screenshots
    const zb = await zoom.boundingBox();
    assert.ok(zb.width >= (vp.touch ? w - 1 : w - 420) && zb.height >= vp.height - 2, `zoom fills the screen ${JSON.stringify(zb)}`);
    const n = Number(await page.locator(".kvp [data-office-zoom-items]").getAttribute("data-office-zoom-items"));
    assert.equal(await page.locator(".kvp .sz-item").count(), n);
    const levels = new Set(await page.locator(".kvp .sz-item").evaluateAll((els) => els.map((el) => el.dataset.officeJar)));
    assert.ok(levels.size >= Math.min(3, n), `several fill levels ${[...levels]}`);
    assert.match(await zoom.textContent(), /theo số tồn trong sổ kho/);
    const jar = await page.locator(".kvp .sz-item .jar").first().boundingBox();
    assert.ok(jar.width >= 50 && jar.height >= 60, `jar big enough ${JSON.stringify(jar)}`);
    const [sw, cw] = await page.locator(".kvp .sz-shelf").evaluate((el) => [el.scrollWidth, el.clientWidth]);
    assert.ok(sw <= cw + 1, `shelf overflows ${sw} > ${cw}`);
    // every product stands above its plank: the item box ends where the plank band starts
    const off = await page.locator(".kvp .sz-shelf").evaluate((el) => { const top = el.getBoundingClientRect().top + el.clientTop - el.scrollTop; return [...el.querySelectorAll(".sz-item")].map((it) => Math.round((it.getBoundingClientRect().bottom - top) % 204)); });
    assert.ok(off.every((o) => o === 182 || o === 0), `items sit on their planks ${off}`);
  });
  await page.screenshot({ path: `${EVIDENCE}/shelf-zoom-${w}.png` });
  await check(`${w} tapping a jar opens the product with its stock line and + Thêm adds it`, async () => {
    const before = await basketCount(page);
    await page.locator(".kvp .sz-item").first().click();
    await page.locator(".kvp [data-office-zoom-pick]").waitFor({ timeout: 3000 });
    await page.waitForTimeout(350);
    assert.match(await page.locator(".kvp [data-office-zoom-pick]").textContent(), /Tồn sổ/);
    await page.screenshot({ path: `${EVIDENCE}/shelf-pick-${w}.png` });
    await page.locator("[data-office-zoom-add]").click();
    await page.waitForTimeout(700);
    assert.equal(await basketCount(page), before + 1);
    assert.equal(await page.locator(".kvp .sz-item.in-basket").count(), 1, "the jar shows it is in the basket");
    await page.getByRole("button", { name: "Đóng món" }).click();
    await page.locator("[data-office-zoom-back]").click();
    await page.waitForTimeout(250);
    assert.equal(await page.locator(".kvp .shelf-zoom").count(), 0, "back to the room");
  });
  await page.screenshot({ path: `${EVIDENCE}/shelf-${w}.png` });
  if (!vp.touch) {
    await check(`${w} hovering the machine shows its tag`, async () => {
      const mp = await room(page, "machineScreen");
      await page.mouse.move(mp.x, mp.y + 10); await page.waitForTimeout(250);
      assert.match(await page.locator(".kvp .world-tag").textContent(), /Máy đặt hàng tự động/);
      await page.mouse.move(5, vp.height - 5);
    });
  }

  // Product → its supplier's old unpaid documents (Kamereo has 5), each with its photo badge.
  await page.getByRole("textbox", { name: "Tìm nguyên vật liệu" }).fill("dầu ăn tường an");
  await page.waitForTimeout(250);
  await page.locator(".kvp .cards .card .name").first().click();
  await page.waitForSelector(".kvp .card.is-open .debt .pick", { timeout: 5000 });
  await check(`${w} product shows the supplier's old PR/PO with photo badges and a pick sums`, async () => {
    assert.ok((await page.locator(".kvp .card.is-open .debt [data-office-photo-count='3']").count()) >= 1, "3-photo badge on the old row");
    assert.ok((await page.locator(".kvp .card.is-open .debt [data-office-photo-count='0']").count()) >= 1, "no-photo badge on another row");
    await page.locator(".kvp .card.is-open .debt .pick input").first().check();
    assert.match(await page.locator(".kvp .card.is-open .debt .sum").textContent(), /Chi kèm 1 phiếu/);
  });
  await page.screenshot({ path: `${EVIDENCE}/product-${w}.png` });
  await check(`${w} a good kept at Q7 says it is delivered to Tân Tạo then moved on`, async () => {
    await page.getByRole("textbox", { name: "Tìm nguyên vật liệu" }).fill("bột mì 888");
    await page.waitForTimeout(250);
    assert.match(await page.locator(".kvp .cards .card [data-office-to-q7]").first().textContent(), /Giao về Tân Tạo → tự chuyển Q7/);
    await page.getByRole("textbox", { name: "Tìm nguyên vật liệu" }).fill("dầu ăn tường an");
    await page.waitForTimeout(250);
    assert.equal(await page.locator(".kvp .cards .card [data-office-to-q7]").count(), 0, "Tân Tạo goods carry no note");
  });

  // "+ Thêm": a crate flies into the hopper and the basket counts it.
  const count0 = await basketCount(page);
  await page.locator(".kvp .cards .card [data-office-add]").first().click();
  await page.waitForTimeout(800);
  await check(`${w} + Thêm adds the product to the basket`, async () => {
    assert.equal(await basketCount(page), count0 + 1);
    assert.match(await page.locator(".kvp .cards .card [data-office-add]").first().textContent(), /✓/);
  });

  // Machine: wake scene (skippable), picks kept per supplier; an old document opens in full; one robot package.
  await page.getByRole("button", { name: "Xoá tìm kiếm" }).click();
  await page.locator("[data-open-machine]").click();
  await check(`${w} opening the machine shows the ordering panel at once (no wake scene)`, async () => {
    await page.waitForSelector("[data-office-machine]", { timeout: 3000 });
    assert.equal(await page.locator(".kvp .wake").count(), 0, "no wake / loading scene");
  });
  await page.waitForSelector(".kvp .sup-card .debt .pick", { timeout: 5000 });
  await check(`${w} machine keeps the pick; old doc opens photo-first in full`, async () => {
    assert.ok((await page.locator(".kvp .sup-card .pick input:checked").count()) >= 1);
    const num = await page.locator(".kvp .sup-card .debt .view").first().getAttribute("data-view");
    await page.locator(".kvp .sup-card .debt .view").first().click();
    await page.waitForSelector(".kvp .doc-modal [data-office-doc]", { timeout: 5000 });
    assert.equal(await page.locator(".kvp .doc-modal .doc-head > b").textContent(), num);
    assert.ok((await page.locator(".kvp .doc-modal .doc-lines li").count()) >= 1);
    assert.ok((await page.locator(".kvp .doc-modal [data-office-photo-block]").count()) === 1, "photo block present");
    const [sw, cw] = await page.locator(".kvp .doc-modal .sheet").evaluate((el) => [el.scrollWidth, el.clientWidth]);
    assert.ok(sw <= cw + 1, `${sw} > ${cw}`);
  });
  await page.screenshot({ path: `${EVIDENCE}/old-doc-${w}.png` });
  await page.getByRole("button", { name: "Đóng chi tiết" }).click();
  await page.locator(".kvp .machine-view .primary.big").click();
  await page.waitForTimeout(600);
  await check(`${w} send creates a robot package with lines + the picked old doc, then lands on the desk`, async () => {
    // One package per supplier: the jar picked on the shelf close-up is a second supplier; check the one with the old doc.
    const pk = (await writes(page)).filter((x) => x.startsWith("rpc:create_robot_order_package:"));
    assert.ok(pk.length >= 1, JSON.stringify(pk));
    const all = pk.map((x) => JSON.parse(x.slice("rpc:create_robot_order_package:".length)));
    const args = all.find((x) => Array.isArray(x.p_debt) && x.p_debt.length) ?? all[0];
    assert.equal(args.p_lines.length, 1);
    assert.ok(args.p_lines[0].supplier_id && args.p_lines[0].item_id, "line carries supplier + item");
    assert.equal(Array.isArray(args.p_debt) ? args.p_debt.length : 0, 1, "picked old doc sent");
    assert.ok(args.p_idempotency_key, "idempotency key");
    assert.match(await page.locator(".kvp .toast").textContent(), /Đã tạo 1 đơn nháp/);
    assert.equal(await page.locator("[data-office-machine]").count(), 0, "machine closed");
    assert.match(await page.locator(".kvp .board-head b").textContent(), /Bàn duyệt PR/);
  });
  await page.screenshot({ path: `${EVIDENCE}/sent-${w}.png` });
  await page.waitForTimeout(2200);

  // Desk: every PR row carries its photo badge; the real pending PR opens photo-first with all 13 lines.
  await check(`${w} PR rows show photo badges and thumbnails`, async () => {
    assert.equal(await page.locator(".kvp [data-pr='PR-336DB95D'] [data-office-photo-count='2']").count(), 1, "2 photos badge");
    assert.equal(await page.locator(".kvp [data-pr='PR-336DB95D'] [data-office-thumb='1'] img").count(), 1, "thumbnail signed and shown");
    assert.ok((await page.locator(".kvp .pr-row [data-office-photo-count='0']").count()) >= 1, "rows without photos say so");
  });
  await page.screenshot({ path: `${EVIDENCE}/desk-${w}.png` });
  await page.locator(".kvp [data-pr='PR-336DB95D']").click();
  await page.waitForSelector(".kvp .doc-modal [data-office-doc='PR-336DB95D']", { timeout: 5000 });
  await page.waitForTimeout(450);
  await page.screenshot({ path: `${EVIDENCE}/pr-${w}.png` });
  await check(`${w} PR opens photo-first (13 lines, PO link) with the approve bar`, async () => {
    assert.equal(await page.locator(".kvp .doc-modal .doc-lines li").count(), 13);
    assert.match(await page.locator(".kvp .doc-modal .doc-refs").textContent(), /PO-000832/);
    assert.ok(await page.getByRole("button", { name: /Duyệt chi/ }).isVisible());
    const photoY = (await page.locator(".kvp .doc-modal [data-office-photo-block]").boundingBox()).y;
    const linesY = (await page.locator(".kvp .doc-modal .doc-lines").boundingBox()).y;
    assert.ok(photoY <= linesY, "photos come before (or beside) the lines");
    assert.match(await page.locator(".kvp .doc-modal .chips-row").textContent(), /4 ảnh/);
  });
  await check(`${w} PR photos show as thumbnails and open in a viewer that rotates and zooms`, async () => {
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
    await page.locator("[data-office-zoom]").click();
    assert.match(await page.locator("[data-office-viewer-img]").getAttribute("style"), /scale\(2\)/);
    assert.ok(await page.locator(".kvp .pv-stage.is-zoom").count() === 1, "zoomed stage scrolls");
    await page.locator("[data-office-zoom]").click();
    await page.getByRole("button", { name: "Ảnh sau" }).click();
    assert.match(await viewer.textContent(), /4\/4/);
    assert.match(await page.locator("[data-office-viewer-img]").getAttribute("style"), /rotate\(0deg\) scale\(1\)/, "rotation and zoom reset per photo");
    const [sw, cw] = await page.locator(".kvp .pv-bar").evaluate((el) => [el.scrollWidth, el.clientWidth]);
    assert.ok(sw <= cw + 1, `viewer bar overflows ${sw} > ${cw}`);
  });
  await page.screenshot({ path: `${EVIDENCE}/photo-viewer-${w}.png` });
  await page.getByRole("button", { name: "Đóng ảnh" }).click();
  await check(`${w} closing the photo keeps the PR open`, async () => {
    assert.equal(await page.locator(".kvp [data-office-viewer]").count(), 0);
    assert.equal(await page.locator(".kvp .doc-modal [data-office-doc='PR-336DB95D']").count(), 1);
  });
  await page.getByRole("radio", { name: "Tiền mặt" }).click();
  await page.getByRole("button", { name: /Duyệt chi/ }).click();
  await page.waitForTimeout(500);
  await check(`${w} approve calls the finance controller with the chosen method and counts in the quest`, async () => {
    const ap = (await writes(page)).filter((x) => x.startsWith("rpc:approve_payment_request_with_material_controller:"));
    assert.equal(ap.length, 1);
    assert.match(ap[0], /"p_payment_method":"cash"/);
    assert.match(ap[0], /"p_payment_request_id":"/);
    assert.match(await page.locator("[data-quest-pr]").textContent(), /^1\//);
  });
  // Reject another PR with a reason; its unreadable photo is reported, not broken.
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
  if (vp.touch) {
    await check(`${w} the sheet collapses and re-frames the room above it`, async () => {
      await page.locator(".kvp .handle").click(); await page.waitForTimeout(400);
      assert.equal(await page.locator(".kvp .board.is-closed").count(), 1);
      const inset = await page.evaluate(() => window.__room.insetPx);
      assert.ok(inset > 40 && inset < 220, `inset ${inset}`);
      await page.screenshot({ path: `${EVIDENCE}/sheet-closed-${w}.png` });
      await page.locator(".kvp .handle").click(); await page.waitForTimeout(400);
      assert.equal(await page.locator(".kvp .board.is-closed").count(), 0);
    });
  }
  await check(`${w} the view never moved`, async () => assert.equal(await projection(page), view0));
  await check(`${w} tap targets >= 32px`, async () => {
    const small = await page.evaluate(() => [...document.querySelectorAll(".kvp .board button, .kvp .board input:not([type=checkbox]), .kvp .hud button")].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height < 31; }).map((el) => el.outerHTML.slice(0, 60)));
    assert.deepEqual(small, [], JSON.stringify(small));
  });
  await check(`${w} no page errors`, async () => assert.deepEqual(errors, []));
  await context.close();
}

// A shelf item sent from Kho 2D/3D ("🤖 Đặt hàng món này") arrives in the room; qty / price edits reach the package.
{
  const seed = [{ key: "k1", item_id: BANH_MI.id, name: BANH_MI.name, unit: "cái", qty: "500", supplier_id: BANH_MI.supplier_id, price: "1200" }];
  // Opened from the yard kiosk (no ?kho): the warehouse is not known yet, so the switch stays.
  const { context, page, errors } = await open({ width: 1440, height: 900 }, { role: "owner" }, false, seed, null);
  await check("shared basket from Kho 2D/3D lands in the machine", async () => {
    assert.equal(await basketCount(page), 1);
    await openMachine(page);
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
  await page.screenshot({ path: `${EVIDENCE}/machine-1440.png` });
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
  await page.locator(".kvp .cards .card [data-office-add]").first().click();
  await page.waitForTimeout(700);
  await page.getByRole("button", { name: "Xoá tìm kiếm" }).click();
  await openMachine(page);
  await page.waitForSelector(".kvp .sup-card [data-office-fold]", { timeout: 5000 });
  await check("old documents before the learned cutover fold away", async () => {
    assert.match(await page.locator(".kvp .sup-card [data-office-fold]").textContent(), /1 phiếu trước mốc/);
    assert.match(await page.locator(".kvp .sup-card [data-office-learned]").textContent(), /Lần trước chọn 1 phiếu/);
  });
  await page.screenshot({ path: `${EVIDENCE}/machine-parity-1440.png` });
  await closeMachine(page);
  // Switching warehouse keeps the room in place and reloads the shelves for Q7.
  await page.locator("[data-kho='q7']").click();
  await page.waitForSelector("[data-office-page].is-ready", { timeout: 10000 });
  await page.waitForTimeout(500);
  await check("Q7 shelf jars fall back to the purchase-cycle forecast (no ledger yet)", async () => {
    await page.locator(".kvp .chips [data-group]").first().click();
    await page.locator(".kvp .shelf-zoom").waitFor({ timeout: 3000 });
    await page.waitForTimeout(400);
    assert.match(await page.locator(".kvp .shelf-zoom").textContent(), /dự đoán theo chu kỳ nhập/);
    await page.screenshot({ path: `${EVIDENCE}/q7-shelf-zoom-1440.png` });
    await page.locator("[data-office-zoom-back]").click();
  });
  await check("Q7 tab switches the warehouse in place", async () => {
    assert.equal(await page.locator("[data-kho='q7']").getAttribute("aria-pressed"), "true");
    assert.ok(page.url().includes("kho=q7"));
    assert.ok((await page.locator(".kvp .chips [data-group]").count()) >= 3, "Q7 shelves");
  });
  await page.screenshot({ path: `${EVIDENCE}/q7-1440.png` });
  await page.getByRole("button", { name: "Về Kho" }).click();
  await check("back returns to the Kho game", async () => { await page.waitForURL(/\/warehouse\/game$/, { timeout: 5000 }); });
  await check("no page errors (basket flow)", async () => assert.deepEqual(errors.filter((e) => !/warehouse_game|snapshot/i.test(e)), []));
  await context.close();
}

// Reduced motion: the room is still; opening the machine works the same.
{
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce", locale: "vi-VN" });
  await context.addInitScript((f) => { window.__officeFixture = f; }, FIXTURE);
  await context.addInitScript((v) => localStorage.setItem("qa-office", JSON.stringify(v)), { role: "owner" });
  await context.route("**/*", (r) => (r.request().url().startsWith(BASE) || /^(data|blob):/.test(r.request().url()) || /fonts\.(googleapis|gstatic)\.com/.test(r.request().url()) ? r.continue() : r.abort()));
  const page = await context.newPage();
  await page.goto(`${BASE}/warehouse/office`, { waitUntil: "networkidle" });
  await page.waitForSelector("[data-office-page].is-ready", { timeout: 20000 });
  await check("reduced motion: the machine opens at once", async () => {
    await page.locator("[data-open-machine]").click();
    await page.waitForSelector("[data-office-machine]", { timeout: 3000 });
    assert.equal(await page.locator(".kvp .wake").count(), 0);
  });
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
  await page.screenshot({ path: `${EVIDENCE}/limited-1440.png` });
  await context.close();
}

await browser.close();
await server.close();
console.log(failures ? `${failures} FAILED` : "ALL WAREHOUSE OFFICE QA CHECKS PASSED", "— evidence in", EVIDENCE);
process.exit(failures ? 1 : 0);
