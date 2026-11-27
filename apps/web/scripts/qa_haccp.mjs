// Browser QA for Hồ sơ HACCP: the manager page (/warehouse/ho-so-haccp) inside the app shell and the
// public staff link (/nop-ho-so?t=…), on the real routes of the real app.
//
// FIXTURE AUTH + FIXTURE DATA: AuthContext and the Supabase client are replaced by in-memory fixtures and the
// Edge function is answered by request interception. Nothing leaves the machine. The Excel/ZIP downloads are
// produced by the real exporter from the real template and read back here.
//
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core EVIDENCE_DIR=/path node scripts/qa_haccp.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";
import ExcelJS from "exceljs";
import JSZip from "jszip";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EVIDENCE = process.env.EVIDENCE_DIR || "/tmp/bmq-haccp-qa";
const PW = process.env.PLAYWRIGHT_CORE || `${process.env.HOME}/.openclaw/lib/node_modules/openclaw/node_modules/playwright-core`;
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = Number(process.env.QA_PORT || 5397);
const EDGE = "http://haccp.fixture";
const TOKEN = "a".repeat(64);
const { chromium } = createRequire(import.meta.url)(PW);
fs.mkdirSync(EVIDENCE, { recursive: true });

const SUPABASE_FIXTURE = `
window.__qaCalls = window.__qaCalls || [];
const uid = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
let seq = 100;
const file = (n, name, type) => ({ id: uid(n), name, size: 2048, type, path: "haccp/x/" + name });
const entry = (n, table_id, values, by = "app", files = []) => ({ id: uid(n), table_id, values, position: n, version: 1, by, files });
const db = {
  entries: [
    entry(1, "suppliers", { name: "NCC Bột mì (mẫu)", items: "Bột mì", phone: "0900000001", address: "Quận 7", contact: "Chị Lan" }, "app", [file(51, "attp.pdf", "application/pdf")]),
    entry(2, "suppliers", { name: "NCC Trứng (mẫu)", items: "Trứng gà", phone: "", address: "", contact: "" }),
    entry(3, "measure", { name: "Cân 30 kg", code: "CAN-01", range: "0-30 kg", origin: "VN", qty: "1", place: "Khu cân", calibrated: "Có" }, "Chị Bích"),
  ],
  files: [], link: null, activity: [],
};
const ok = (data) => ({ data, error: null });
const bad = (message) => ({ data: null, error: { message } });
function rpc(name, a = {}) {
  window.__qaCalls.push(name + ":" + JSON.stringify(a));
  const fail = localStorage.getItem("qa-fail");
  if (name === "haccp_manager_snapshot") return fail === "denied" ? bad("insufficient_privilege") : ok(JSON.parse(JSON.stringify(db)));
  if (name === "haccp_save_entry") {
    if (fail === "stale") return bad("stale_version");
    let e = db.entries.find((x) => x.id === a.p_id);
    if (e) { if (e.version !== a.p_version) return bad("stale_version"); e.values = a.p_values; e.by = a.p_entered_by_name; e.version++; }
    else { e = entry(++seq, a.p_table_id, a.p_values, a.p_entered_by_name); db.entries.push(e); }
    return ok({ id: e.id });
  }
  if (name === "haccp_delete_entry") { const e = db.entries.find((x) => x.id === a.p_id); if (!e || e.version !== a.p_version) return bad("stale_version"); db.entries = db.entries.filter((x) => x !== e); return ok({}); }
  if (name === "haccp_add_file") { const f = file(++seq, a.p_file_name, a.p_mime_type); if (a.p_layout) db.files.push(f); else { const e = db.entries.find((x) => x.id === a.p_entry_id); e.files.push(f); e.version++; } return ok({ id: f.id }); }
  if (name === "haccp_delete_file") { db.files = db.files.filter((f) => f.id !== a.p_file_id); db.entries.forEach((e) => { e.files = e.files.filter((f) => f.id !== a.p_file_id); }); return ok({}); }
  if (name === "haccp_prefill") { if (db.entries.some((e) => e.table_id === a.p_table_id && e.values.name === "NCC Bơ (mẫu)")) return ok(0); db.entries.push(entry(++seq, a.p_table_id, { name: "NCC Bơ (mẫu)", items: "Bơ", phone: "", address: "", contact: "" })); return ok(1); }
  if (name === "haccp_create_upload_link") { db.link = { id: uid(900), days: a.p_days, expires_at: new Date(Date.now() + a.p_days * 864e5).toISOString(), active: true }; return ok({ link_id: db.link.id, token: "${TOKEN}" }); }
  if (name === "haccp_revoke_upload_link") { db.link = { ...db.link, active: false, revoked_at: new Date().toISOString() }; return ok({ revoked: true }); }
  return ok(null);
}
function builder() {
  const proxy = new Proxy(function () {}, { get(_t, prop) {
    if (prop === "then") return (a, b) => Promise.resolve({ data: [], error: null, count: 0 }).then(a, b);
    return () => proxy;
  } });
  return proxy;
}
const user = { id: "qa-user", email: "qa@bmq.test", user_metadata: {} };
const channel = { on() { return channel; }, subscribe() { return channel; }, unsubscribe() {} };
export const supabase = {
  from: () => builder(),
  rpc: (fn, args) => { const result = String(fn).startsWith("haccp_") ? rpc(fn, args) : { data: null, error: null }; const p = Promise.resolve(result); p.maybeSingle = () => p; p.single = () => p; return p; },
  schema: () => ({ from: () => builder(), rpc: () => builder() }),
  functions: { invoke: async () => ({ data: null, error: { message: "disabled" } }) },
  storage: { from: () => ({ upload: async (p) => { window.__qaCalls.push("upload:" + p); return ok({ path: p }); }, remove: async () => ok([]), createSignedUrl: async () => ok({ signedUrl: "data:application/pdf;base64,JVBERi0xLjQK" }), getPublicUrl: () => ({ data: { publicUrl: "" } }) }) },
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
const user = { id: "qa-user", email: "qa@bmq.test", user_metadata: {} };
const value = {
  user, session: { access_token: "qa", user }, profile: { id: "p", user_id: "qa-user", full_name: "Quản lý QA", email: user.email },
  loading: false, timedOut: false, roles: ["owner"], authzLoaded: true, authzError: false,
  isOwner: true, canAccessModule: () => true, canEditModule: () => true,
  signOut: async () => {}, refreshProfile: async () => {}, refreshRoles: async () => {},
};
export function AuthProvider({ children }) { return children; }
export function useAuth() { return value; }
`;

const swaps = [["integrations/supabase/client", "\0qa-supabase"], ["contexts/AuthContext", "\0qa-auth.js"]];
const fixtures = {
  name: "qa-haccp-fixtures", enforce: "pre",
  resolveId(id) { const hit = swaps.find(([m]) => id === `@/${m}` || id.endsWith(`/src/${m}`) || id.endsWith(`/src/${m}.ts`) || id.endsWith(`/src/${m}.tsx`)); return hit ? hit[1] : null; },
  load(id) { if (id === "\0qa-supabase") return SUPABASE_FIXTURE; if (id === "\0qa-auth.js") return AUTH_FIXTURE; return null; },
};

const server = await createServer({
  root: ROOT, configFile: false, logLevel: "error", envDir: EVIDENCE, // no .env: the build under test gets no project keys
  cacheDir: path.join(EVIDENCE, "vite-cache"),
  server: { port: PORT, strictPort: true, host: "127.0.0.1" },
  define: { __APP_VERSION__: JSON.stringify("qa"), __APP_SEMVER__: JSON.stringify("vqa"), "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(EDGE), "import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY": JSON.stringify("qa-key") },
  resolve: { alias: { "@": path.join(ROOT, "src") } },
  plugins: [fixtures, react()],
});
await server.listen();
const BASE = `http://127.0.0.1:${PORT}`;
const browser = await chromium.launch({ executablePath: CHROME });
const pass = (name) => console.log("PASS", name);

/** The Edge function, answered in memory. */
function edgeFixture() {
  const state = { revoked: false, calls: [], entries: [{ id: "00000000-0000-4000-8000-000000000001", table_id: "machines", values: { name: "Lò nướng (mẫu)", symbol: "LO-01" }, version: 3, by: "app", files: [] }], files: [] };
  const handle = async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET,POST,OPTIONS" };
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers });
    const reply = (status, body) => route.fulfill({ status, headers, contentType: "application/json", body: JSON.stringify(body) });
    if (state.revoked || url.searchParams.get("t") !== TOKEN) return reply(410, { ok: false, code: "link_revoked" });
    if (req.method() === "GET") return reply(200, { ok: true, entries: state.entries, files: state.files, link: { active: true, days: 30 }, activity: [] });
    if (url.searchParams.get("action") === "upload") { state.calls.push({ action: "upload", name: decodeURIComponent(req.headers()["x-file-name"]), who: url.searchParams.get("who") }); return reply(200, { ok: true }); }
    const body = JSON.parse(req.postData());
    state.calls.push(body);
    if (body.action === "save_row") { const e = { id: body.id ?? "00000000-0000-4000-8000-000000000077", table_id: body.table_id, values: body.values, version: 1, by: body.who, files: [] }; state.entries = [...state.entries.filter((x) => x.id !== e.id), e]; return reply(200, { ok: true, entry: { id: e.id } }); }
    if (body.action === "delete_row") { state.entries = state.entries.filter((x) => x.id !== body.id); return reply(200, { ok: true }); }
    return reply(200, { ok: true });
  };
  return { state, handle };
}

async function open(route, viewport, edge) {
  const context = await browser.newContext({ viewport, reducedMotion: "reduce", locale: "vi-VN", acceptDownloads: true });
  await context.route("**/*", (r) => {
    const url = r.request().url();
    if (url.startsWith(BASE) || url.startsWith("data:") || url.startsWith("blob:")) return r.continue();
    if (edge && url.startsWith(`${EDGE}/functions/v1/haccp-upload`)) return edge.handle(r);
    return r.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(BASE + route, { waitUntil: "domcontentloaded" });
  return { context, page, errors };
}
const calls = (page) => page.evaluate(() => window.__qaCalls);
async function noSpill(page, label, vp) {
  const o = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll(".hc *, [role='dialog'] *")) {
      const r = el.getBoundingClientRect();
      if (!r.width || el.closest(".hc-tiles, .hc-table-wrap, .hc-xl-scroll, .hc-xl-tabs")) continue;
      if (r.right > innerWidth + 1 || r.left < -1) out.push(`${el.tagName}.${String(el.className).slice(0, 50)}`);
    }
    return { doc: document.documentElement.scrollWidth - innerWidth, out: out.slice(0, 5) };
  });
  assert.ok(o.doc <= 0 && !o.out.length, `${label} ${vp.width}: overflow ${JSON.stringify(o)}`);
}
async function shot(page, name, full = false) {
  if (full) await page.addStyleTag({ content: ".d3-app{height:auto!important}.d3-main{overflow:visible!important}" });
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(EVIDENCE, `${name}.png`), fullPage: full });
}
const closed = (page, sel) => page.waitForSelector(sel, { state: "detached", timeout: 6000 });
async function download(page, selector) {
  const [file] = await Promise.all([page.waitForEvent("download", { timeout: 30000 }), page.locator(selector).click()]);
  const to = path.join(EVIDENCE, file.suggestedFilename());
  await file.saveAs(to);
  return to;
}

try {
  for (const vp of [{ width: 1440, height: 900 }, { width: 390, height: 844 }, { width: 320, height: 640 }]) {
    const desktop = vp.width >= 900;
    const row = (n) => (desktop ? `tr[data-hc-row='00000000-0000-4000-8000-${String(n).padStart(12, "0")}'] .hc-first` : `[data-hc-card='00000000-0000-4000-8000-${String(n).padStart(12, "0")}']`);
    const { context, page, errors } = await open("/warehouse/ho-so-haccp", vp);
    await page.waitForSelector("[data-hc-page]", { timeout: 40000 });
    await page.evaluate(() => document.fonts.ready);
    await noSpill(page, "manager", vp);
    await shot(page, `manager-${vp.width}`, true);

    // edit a row: missing values saved with the manager's name and the row version
    await page.locator(row(2)).click();
    await page.waitForSelector("[data-hc-row-dialog]");
    await page.locator("[data-hc-row-dialog] input#hc-phone").fill("0900000002");
    await page.locator("[data-hc-row-dialog] input[type=file]").last().setInputFiles({ name: "anh..ncc.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n") });
    await page.locator("[data-hc-row-save]").click();
    await closed(page, "[data-hc-row-dialog]");
    let all = await calls(page);
    assert.ok(all.some((c) => c.startsWith("haccp_save_entry:") && c.includes('"p_version":1') && c.includes("Quản lý QA") && c.includes("0900000002")), "row saved with version and name");
    assert.ok(all.some((c) => c.startsWith("upload:haccp/") && !c.includes("..")), "file stored without double dots");

    // a failed save keeps the dialog and the typed text
    await page.evaluate(() => localStorage.setItem("qa-fail", "stale"));
    await page.locator(row(2)).click();
    await page.locator("[data-hc-row-dialog] input#hc-contact").fill("Anh Bình");
    await page.locator("[data-hc-row-save]").click();
    await page.getByText("Có người vừa sửa dòng này").first().waitFor();
    assert.equal(await page.locator("[data-hc-row-dialog] input#hc-contact").inputValue(), "Anh Bình", "draft kept after failure");
    await page.evaluate(() => localStorage.removeItem("qa-fail"));
    await page.keyboard.press("Escape");
    await closed(page, "[data-hc-row-dialog]");

    // pull from app, once
    await page.locator("[data-hc-pull='suppliers']").click();
    await page.getByText("Đã lấy thêm 1 dòng từ BMQ AI").first().waitFor();
    await page.locator("[data-hc-pull='suppliers']").click();
    await page.getByText("Không có gì mới").first().waitFor();

    // staff link
    await page.locator("[data-hc-share-open]").click();
    await page.locator("[data-hc-link-create]").click();
    await page.waitForSelector("[data-hc-share] code");
    assert.match(await page.locator("[data-hc-share] code").innerText(), new RegExp(`/nop-ho-so\\?t=${TOKEN}$`), "link shown");
    await noSpill(page, "share", vp);
    await shot(page, `share-${vp.width}`);
    await page.locator("[data-hc-link-revoke]").click();
    await page.locator("[data-hc-link-confirm]").click();
    await page.waitForSelector("[data-hc-link-create]");
    await page.keyboard.press("Escape");
    await closed(page, "[data-hc-share]");

    // export: real workbook and ZIP
    await page.locator("[data-hc-export-open]").click();
    await page.waitForSelector("[data-hc-export]");
    await noSpill(page, "export", vp);
    await shot(page, `export-${vp.width}`);
    const xlsx = await download(page, "[data-hc-download]");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(xlsx);
    assert.equal(wb.worksheets.length, 7, "seven sheets");
    const ncc = wb.getWorksheet("Thông tin NCC");
    assert.equal(ncc.getCell("B3").text, "NCC Bột mì (mẫu)");
    assert.equal(ncc.getCell("C4").text, "0900000002", "saved phone is in the file");
    assert.equal(ncc.getCell("F14").text, "", "template sample rows are gone");
    assert.equal(wb.getWorksheet("Danh sách thiết bị đo lường").getCell("B3").text, "Cân 30 kg");
    const zipPath = await download(page, "[data-hc-zip]");
    const names = Object.keys((await JSZip.loadAsync(fs.readFileSync(zipPath))).files);
    assert.ok(names.some((n) => n.endsWith(".xlsx")) && names.some((n) => n.startsWith("01-Nha-cung-cap/") && n.endsWith(".pdf")), `zip contents ${names}`);
    await page.keyboard.press("Escape");
    await closed(page, "[data-hc-export]");

    // delete sends the version of the opened row
    await page.locator("[data-hc-tile='measure']").click();
    await page.locator(row(3)).click();
    await page.locator("[data-hc-row-dialog] .hc-btn.is-quiet").click();
    await page.locator("[data-hc-row-dialog] .hc-btn.is-danger").click();
    await closed(page, "[data-hc-row-dialog]");
    all = await calls(page);
    assert.ok(all.some((c) => c.startsWith("haccp_delete_entry:") && c.includes('"p_version":1') && c.includes("Quản lý QA")), "delete with version and name");
    assert.deepEqual(errors, [], "no page errors (manager)");
    await context.close();
    pass(`manager: save, upload, failed save, pull, link, Excel, ZIP, delete ${vp.width}`);

    const edge = edgeFixture();
    const staff = await open(`/nop-ho-so?t=${TOKEN}`, vp, edge);
    const s = staff.page;
    await s.waitForSelector("[data-hc-staff-section='machines']", { timeout: 40000 });
    assert.equal(await s.locator("[data-hc-share-open], [data-hc-export-open], .d3-header").count(), 0, "no manager tools or app shell");
    await noSpill(s, "staff-home", vp);
    await shot(s, `staff-home-${vp.width}`, true);
    await s.locator(".hc-who input").fill("Chị Hoa QA");
    await s.locator("[data-hc-staff-section='machines']").click();
    assert.equal(await s.locator("[data-hc-pull]").count(), 0, "no pull from app for staff");
    await s.locator("[data-hc-add='machines']").click();
    await s.locator("[data-hc-row-dialog] input#hc-name").fill("Máy chia bột");
    await s.locator("[data-hc-row-dialog] input[type=file]").last().setInputFiles({ name: "may.jpg", mimeType: "image/jpeg", buffer: Buffer.from([0xff, 0xd8, 0xff, 0xd9]) });
    await noSpill(s, "staff-dialog", vp);
    await s.locator("[data-hc-row-save]").click();
    await closed(s, "[data-hc-row-dialog]");
    await s.locator("[data-hc-card]", { hasText: "Máy chia bột" }).waitFor();
    assert.ok(edge.state.calls.some((c) => c.action === "save_row" && c.who === "Chị Hoa QA" && c.values.name === "Máy chia bột"), "staff save carries the name");
    assert.ok(edge.state.calls.some((c) => c.action === "upload" && c.name === "may.jpg" && c.who === "Chị Hoa QA"), "staff upload");
    await shot(s, `staff-section-${vp.width}`, true);
    await s.locator("[data-hc-card='00000000-0000-4000-8000-000000000001']").click();
    await s.locator("[data-hc-row-dialog] .hc-btn.is-quiet").click();
    await s.locator("[data-hc-row-dialog] .hc-btn.is-danger").click();
    await closed(s, "[data-hc-row-dialog]");
    assert.ok(edge.state.calls.some((c) => c.action === "delete_row" && c.who === "Chị Hoa QA" && c.version === 3), "staff delete carries name and version");
    // revoked in the middle of a session: the next write fails and the data is hidden
    edge.state.revoked = true;
    await s.locator("[data-hc-add='machines']").click();
    await s.locator("[data-hc-row-dialog] input#hc-name").fill("Sau khi thu hồi");
    await s.locator("[data-hc-row-save]").click();
    await s.waitForSelector("[data-hc-staff-blocked]", { timeout: 8000 });
    assert.ok(await s.evaluate(() => document.documentElement.classList.contains("bmq-d3")), "blocked screen keeps the app theme");
    await shot(s, `staff-revoked-${vp.width}`);
    assert.deepEqual(staff.errors, [], "no page errors (staff)");
    await staff.context.close();
    const none = await open("/nop-ho-so", vp, edgeFixture());
    await none.page.getByText("Thiếu link").waitFor({ timeout: 20000 });
    await none.context.close();
    pass(`staff link: save, upload, delete, revoked, missing token ${vp.width}`);
  }
  const denied = await open("/warehouse/ho-so-haccp", { width: 390, height: 844 });
  await denied.page.waitForSelector("[data-hc-page]", { timeout: 40000 });
  await denied.page.evaluate(() => localStorage.setItem("qa-fail", "denied"));
  await denied.page.reload();
  await denied.page.getByText("chưa có quyền sửa Kho").waitFor({ timeout: 20000 });
  await denied.context.close();
  pass("manager without Kho edit sees a clear message");
} finally {
  await browser.close();
  await server.close();
}
