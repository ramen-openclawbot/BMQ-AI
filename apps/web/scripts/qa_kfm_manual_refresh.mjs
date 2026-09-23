/**
 * Behavioral QA for the KFM Cổng KFM manual-refresh contract (owner 2026-09-17).
 *
 * Loads the real `KfmPortalDialog` source through Vite SSR and drives it in jsdom
 * with a fixture session and a mocked `kfm-portal-sync` endpoint. It proves the
 * owner-approved slice: the portal order list is read ONLY from the operator's
 * "Làm mới" click.
 *   - a mount never issues a list read and shows a truthful idle instruction
 *     (never the empty-orders card);
 *   - window focus, visibilitychange, reconnect and QueryClient invalidation
 *     (including the app-wide `invalidateQueries({ refetchType: 'active' })`)
 *     do not read the list;
 *   - the explicit refresh issues exactly one list read; empty is only shown
 *     after a successful read; a failed read shows an error with a refresh retry;
 *   - fast repeated refresh collapses to one in-flight read;
 *   - remounting with the same QueryClient reuses current-day cache with zero
 *     new reads, while a fresh client shows the idle instruction;
 *   - Vietnam midnight rollover does NOT read the list, expires the old day's
 *     view, and a stale in-flight old-day result never leaks into the new day;
 *   - an immediate refresh after midnight, before the 1s rollover timer fires,
 *     resolves Vietnam today synchronously and reads the new day, not yesterday;
 *   - printing/creating a note does not trigger a list read (post-print removal);
 *   - no browser storage writes ever happen.
 *
 * Every portal call is intercepted; no real portal record is read or created.
 * Run from apps/web:  node scripts/qa_kfm_manual_refresh.mjs
 *
 * Layout note: jsdom has no layout engine, so this run repeats the matrix at the
 * 320/390/1440 widths and pins the Tailwind contract (h-11 refresh target,
 * min-w-0 shell); it does not measure pixels. `qa_kfm_manual_refresh_page.mjs`
 * is the source-browser fixture when a headless browser is available.
 */
import { createServer } from "vite";
import path from "node:path";
import fs from "node:fs";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const { JSDOM } = await import(
  process.env.KFM_QA_JSDOM || "/Users/c.o.t.e/.openclaw/workspace-sushi/projects/deepseek-harness/node_modules/jsdom/lib/api.js"
);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = process.env.KFM_QA_OUT || "/tmp/kfm-manual-refresh";
fs.mkdirSync(out, { recursive: true });

// --- jsdom environment before React/react-dom are imported -------------------
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
  url: "http://127.0.0.1/",
  pretendToBeVisual: true,
});
const { window } = dom;

// The panel must never persist portal data. jsdom's Storage is a proxy that
// corrupts when its methods are patched, so swap in a plain recording storage.
const storageWrites = [];
const storageData = new Map();
const storageSpy = {
  get length() { return storageData.size; },
  key(index) { return [...storageData.keys()][index] ?? null; },
  getItem(key) { return storageData.has(String(key)) ? storageData.get(String(key)) : null; },
  setItem(key, value) { storageWrites.push([String(key), String(value)]); storageData.set(String(key), String(value)); },
  removeItem(key) { storageData.delete(String(key)); },
  clear() { storageData.clear(); },
};
Object.defineProperty(window, "localStorage", { value: storageSpy, configurable: true, writable: true });

for (const key of [
  "window", "document", "navigator", "HTMLElement", "HTMLAnchorElement", "Element", "Node",
  "Event", "MouseEvent", "PointerEvent", "CustomEvent", "getComputedStyle",
  "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "location",
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
window.HTMLAnchorElement.prototype.click = () => {};
globalThis.URL.createObjectURL = () => "blob:qa";
globalThis.URL.revokeObjectURL = () => {};

// Controllable clock so the Vietnam midnight boundary is deterministic.
const realNow = Date.now.bind(Date);
let nowOffset = 0;
Date.now = () => realNow() + nowOffset;
const VN_OFFSET_MS = 7 * 60 * 60 * 1000;
const vnDay = (offsetMs = 0) => new Date(Date.now() + offsetMs + VN_OFFSET_MS).toISOString().slice(0, 10);

// A click-opened print tab has no application CSS; give it just enough surface.
let viewers = [];
function makeViewer() {
  const doc = {
    title: "",
    head: { appendChild() {} },
    documentElement: { appendChild() {} },
    body: { innerHTML: "" },
    querySelector: () => null,
    createElement: () => ({ setAttribute() {}, parentNode: null }),
  };
  return { document: doc, location: { href: "" }, closed: false, close() { this.closed = true; } };
}
window.open = () => { const viewer = makeViewer(); viewers.push(viewer); return viewer; };

const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const { act } = await import("react-dom/test-utils");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { MemoryRouter } = await import("react-router-dom");

// --- load the real source through Vite --------------------------------------
const server = await createServer({
  root,
  configFile: false,
  cacheDir: process.env.KFM_QA_CACHE || `${out}/vite-cache-ssr`,
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "error",
  resolve: { alias: { "@/integrations/supabase/client": "\0qa-auth", sonner: "\0qa-sonner", "@": root + "/src" } },
  plugins: [
    {
      name: "kfm-manual-refresh-fixtures",
      resolveId(id) {
        if (id === "\0qa-auth" || id === "\0qa-sonner") return id;
        if (id === root + "/src/integrations/supabase/client") return "\0qa-auth";
      },
      load(id) {
        if (id === "\0qa-auth") return 'export const supabase={auth:{getSession:async()=>({data:{session:{access_token:"fixture-only"}}})}};';
        if (id === "\0qa-sonner") return "export const toast={loading:()=>{},dismiss:()=>{},success:()=>{},error:()=>{}};";
      },
    },
  ],
});
const { default: Panel } = await server.ssrLoadModule("/src/components/production/KfmPortalDialog.tsx");

// --- helpers ----------------------------------------------------------------
const json = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const flush = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

async function waitFor(fn, label, timeout = 4000) {
  const start = Date.now();
  for (;;) {
    let value;
    try { value = fn(); } catch { /* keep polling */ }
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`Timed out waiting for ${label}`);
    await flush(10);
  }
}

async function click(el) {
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

const ORDER = { portalId: 241362, code: "PO1002648379", locationName: "KHO QUÁ CẢNH BÁNH TƯƠI", totalQty: 626, itemCount: 6 };
const REV = "a".repeat(64);
const FLEET = { vehicles: [{ id: 1, plateNumber: "51C-12345", defaultDriverId: 2 }], drivers: [{ id: 2, name: "Tài xế mẫu", phone: "0123456789" }] };
const FIXED_OPTIONS = { deliveryType: "FIXED", vehicleTypes: [{ id: 1, name: "Xe tải" }], vehicleTypeId: 1, slots: [{ value: "08:00-09:00", available: true }] };
const ITEMS = [{ poId: 241362, poCode: ORDER.code, poItemId: 1, variantId: null, productCode: "FIXTURE", barcode: "SP", productName: "Bánh", unitName: "CÁI", shipQty: 626, cartons: 0 }];
const TRIP_OPTIONS = { success: true, revision: REV, fleet: FLEET, options: FIXED_OPTIONS, pendingChangeCategories: [], draft: { stops: [{ items: ITEMS }] } };
const VERIFIED = { state: "verified", loadId: 90, loadCode: "IL-FIXTURE", asns: [{ asnId: 91, asnCode: "ASN-FIXTURE" }], poConfirmation: { confirmed: true, subStatus: 6, label: "Chờ giao" }, intakeRevision: REV, message: "Đã đọc lại chuyến, ASN và trạng thái PO." };
const PDF = { success: true, base64: Buffer.from("%PDF-1.4\n%%EOF").toString("base64"), filename: "fixture.pdf" };

/** Fixture portal: record every action, always answer, never touch the real portal. */
function makePortal() {
  const state = {
    actions: [], list: 0, listDates: [], tripOptions: 0, create: 0, confirm: 0, pdf: 0,
    orders: [ORDER], ordersByDate: {}, holdList: false, releaseList: [], listError: false,
  };
  globalThis.fetch = async (url, options) => {
    const invocationUrl = new URL(url);
    assert.equal(invocationUrl.pathname, "/functions/v1/kfm-portal-sync");
    assert.equal(invocationUrl.searchParams.get("forceFunctionRegion"), "ap-northeast-2");
    assert.equal(options.headers["x-region"], "ap-northeast-2");
    assert.equal(options.headers["Content-Type"], "application/json");
    assert.equal(options.headers.Authorization, "Bearer fixture-only");
    const body = JSON.parse(options.body);
    state.actions.push(body.action);
    if (body.action === "list") {
      state.list += 1;
      state.listDates.push(body.deliveryDate);
      if (state.holdList) await new Promise((resolve) => state.releaseList.push(resolve));
      if (state.listError) throw new TypeError("Failed to fetch");
      return json({ success: true, configured: true, orders: state.ordersByDate[body.deliveryDate] ?? state.orders });
    }
    if (body.action === "trip-options") { state.tripOptions += 1; return json(TRIP_OPTIONS); }
    if (body.action === "create-load") { state.create += 1; return json({ success: true, result: VERIFIED }); }
    if (body.action === "confirm-po") { state.confirm += 1; return json({ success: true, result: { state: "imported" } }); }
    if (body.action === "trip-result") return json({ success: true, result: VERIFIED });
    if (body.action === "load-pdf" || body.action === "asn-pdf") { state.pdf += 1; return json(PDF); }
    throw new Error("Unexpected portal action in manual-refresh QA: " + body.action);
  };
  return state;
}

async function mount(client) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createRoot(container);
  await act(async () => {
    app.render(
      React.createElement(QueryClientProvider, { client },
        React.createElement(MemoryRouter, null, React.createElement(Panel, { isVi: true }))),
    );
  });
  return { container, app };
}

async function unmount(container, app) {
  await act(async () => { app.unmount(); });
  container.remove();
}

const refreshButton = (container) => container.querySelector('[data-kfm-action="refresh-list"]');
const listState = (container) => container.querySelector("[data-kfm-today]").getAttribute("data-kfm-list-state");
const todayAttr = (container) => container.querySelector("[data-kfm-today-date]").getAttribute("data-kfm-today-date");

async function explicitRefresh(container) {
  await click(refreshButton(container));
}

// --- scenarios --------------------------------------------------------------
const results = [];
const failures = [];

async function scenario(name, width, fn) {
  nowOffset = 0;
  storageWrites.length = 0;
  viewers = [];
  const portal = makePortal();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let current = await mount(client);
  const ctx = {
    client,
    portal,
    get container() { return current.container; },
    get app() { return current.app; },
    async remount() { await unmount(current.container, current.app); current = await mount(client); return current; },
  };
  try {
    await fn(ctx);
    assert.equal(storageWrites.length, 0, "no browser storage write may happen: " + JSON.stringify(storageWrites));
    assert.equal(window.localStorage.length, 0, "no browser storage key may be created");
    results.push({ width, name, pass: true, actions: portal.actions, listDates: portal.listDates });
  } catch (error) {
    failures.push(`${width}-${name}: ${error.message}`);
    results.push({ width, name, pass: false, error: error.message, actions: portal.actions, listDates: portal.listDates });
  } finally {
    try { await unmount(current.container, current.app); } catch { /* teardown only */ }
    globalThis.fetch = undefined;
  }
}

// A. mount is idle and truthful; the behavior marker and phone contract hold.
async function scenarioMountIdle({ container, portal }) {
  await flush(60);
  assert.equal(portal.list, 0, "no list read on mount");
  const section = container.querySelector('[data-kfm-today][data-kfm-manual-refresh="v1"]');
  assert(section, "manual-refresh behavior marker must be present");
  assert.equal(listState(container), "idle", "mount must be idle, not empty/loading");
  assert(container.querySelector('[data-kfm-idle="v1"]'), "idle instruction must render");
  assert.equal(container.querySelector('[data-kfm-empty="v1"]'), null, "empty card must not render before a successful read");
  assert(container.textContent.includes("Bấm Làm mới"), "the idle instruction must name the refresh action");
  assert(!container.querySelector("[data-kfm-order]"), "no order card before a read");
  const refresh = refreshButton(container);
  assert(refresh.className.includes("h-11"), "refresh target must stay at least 44px high");
  assert(section.className.includes("min-w-0"), "shell must shrink inside the app");
  assert.equal(refresh.disabled, false, "refresh is available while idle");
}

// B. focus / visibility / reconnect / invalidation never read the list.
async function scenarioNoAutomaticTriggers({ container, client, portal }) {
  await flush(60);
  await act(async () => { window.dispatchEvent(new window.Event("focus")); await new Promise((r) => setTimeout(r, 0)); });
  await act(async () => { document.dispatchEvent(new window.Event("visibilitychange")); await new Promise((r) => setTimeout(r, 0)); });
  await act(async () => { window.dispatchEvent(new window.Event("online")); await new Promise((r) => setTimeout(r, 0)); });
  await act(async () => { await client.invalidateQueries({ refetchType: "active" }); });
  await act(async () => { await client.invalidateQueries({ queryKey: ["kfm-portal-orders"] }); });
  await flush(60);
  assert.equal(portal.list, 0, "focus/visibility/reconnect/invalidation must not read the list");
  assert.equal(listState(container), "idle", "still idle after automatic triggers");
}

// C. the explicit click is the only read; empty only after a successful read.
async function scenarioExplicitRefreshReady({ container, portal }) {
  await flush(30);
  await explicitRefresh(container);
  await waitFor(() => container.querySelector("[data-kfm-order]"), "order card after refresh");
  assert.equal(portal.list, 1, "one explicit click is exactly one list read");
  assert.equal(listState(container), "ready");
  assert.equal(container.querySelector('[data-kfm-idle="v1"]'), null, "idle instruction disappears after a read");
  assert.equal(container.querySelector('[data-kfm-empty="v1"]'), null, "orders are present");
}

async function scenarioExplicitRefreshEmpty({ container, portal }) {
  portal.orders = [];
  await flush(30);
  await explicitRefresh(container);
  await waitFor(() => container.querySelector('[data-kfm-empty="v1"]'), "empty card after an empty read");
  assert.equal(portal.list, 1);
  assert.equal(listState(container), "empty");
  assert.equal(container.querySelector('[data-kfm-idle="v1"]'), null, "empty replaces idle only after the read");
  assert(container.textContent.includes("chưa có đơn giao"), "empty copy is the fetched-empty claim");
}

// D. fast repeated refresh collapses to one in-flight read.
async function scenarioFastRepeatedRefresh({ container, portal }) {
  await flush(30);
  portal.holdList = true;
  await act(async () => {
    const refresh = refreshButton(container);
    refresh.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    refresh.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    refresh.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 10));
  });
  assert.equal(portal.list, 1, "repeated fast refresh must not stack list reads");
  assert.equal(refreshButton(container).disabled, true, "refresh is disabled while a read is in flight");
  await act(async () => { portal.releaseList.splice(0).forEach((release) => release()); await new Promise((r) => setTimeout(r, 10)); });
  await waitFor(() => container.querySelector("[data-kfm-order]"), "order card after release");
  portal.holdList = false;
  await explicitRefresh(container);
  await waitFor(() => portal.list === 2, "a later explicit refresh is allowed");
}

// E. a failed read shows an error and retries through the refresh button.
async function scenarioErrorRetry({ container, portal }) {
  await flush(30);
  portal.listError = true;
  await explicitRefresh(container);
  await waitFor(() => container.querySelector('[role="alert"]'), "list error alert");
  assert.equal(portal.list, 1);
  assert.equal(listState(container), "error");
  assert(container.textContent.includes("Bấm Làm mới"), "error must point at the refresh retry");
  assert.equal(container.querySelector('[data-kfm-order]'), null, "a failed read never shows orders");
  portal.listError = false;
  await explicitRefresh(container);
  await waitFor(() => container.querySelector("[data-kfm-order]"), "order card after retry");
  assert.equal(portal.list, 2, "retry is a second explicit read");
  assert.equal(listState(container), "ready");
}

// F. remount reuses current-day QueryClient cache with zero new reads.
async function scenarioCachedRevisit(ctx) {
  const { portal } = ctx;
  await flush(30);
  await explicitRefresh(ctx.container);
  await waitFor(() => ctx.container.querySelector("[data-kfm-order]"), "first-day order card");
  assert.equal(portal.list, 1);
  await ctx.remount();
  await flush(40);
  assert.equal(portal.list, 1, "a remount with cached data must not read the list again");
  assert(ctx.container.querySelector("[data-kfm-order]"), "cached orders are reused on navigation");
  assert.equal(listState(ctx.container), "ready", "cached data is not idle");
  assert.equal(ctx.container.querySelector('[data-kfm-idle="v1"]'), null);
  // A different client has no cache: it starts idle with zero reads.
  await unmount(ctx.container, ctx.app);
  const fresh = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const idle = await mount(fresh);
  await flush(40);
  assert.equal(portal.list, 1, "a fresh client mount is idle and reads nothing");
  assert.equal(listState(idle.container), "idle", "an empty cache starts idle");
  assert(idle.container.querySelector('[data-kfm-idle="v1"]'), "fresh client shows the idle instruction");
  await unmount(idle.container, idle.app);
  // Restore a mounted root for the runner's teardown.
  ctx.setCurrent(await mount(ctx.client));
}

// G. midnight rollover: no auto read, truthful notice, explicit read for the new day.
async function scenarioDayRollover({ container, portal }) {
  await flush(30);
  const day0 = vnDay();
  await explicitRefresh(container);
  await waitFor(() => container.querySelector("[data-kfm-order]"), "first-day order card");
  assert.deepEqual(portal.listDates, [day0], "the first read carries today's Vietnam date");
  nowOffset += 86_400_000;
  const day1 = vnDay();
  assert.notEqual(day1, day0, "fixture clock must cross a Vietnam day boundary");
  await act(async () => { window.dispatchEvent(new window.Event("focus")); await new Promise((r) => setTimeout(r, 20)); });
  await flush(40);
  assert.equal(todayAttr(container), day1, "the panel must advance to the new day");
  assert.equal(portal.list, 1, "rollover must not read the list on its own");
  assert.equal(listState(container), "idle", "the new day starts idle, not showing yesterday's list");
  assert.equal(container.querySelector("[data-kfm-order]"), null, "yesterday's orders must not carry over");
  assert(container.textContent.includes("Đã sang ngày mới"), "rollover notice must render");
  assert(container.textContent.includes("bấm Làm mới") || container.textContent.includes("Bấm Làm mới"), "rollover must tell the operator to refresh");
  await explicitRefresh(container);
  await waitFor(() => container.querySelector("[data-kfm-order]"), "new-day order card after explicit refresh");
  assert.equal(portal.list, 2, "the new day is read explicitly");
  assert.equal(portal.listDates[1], day1, "the second read carries the new day");
}

// G2. immediate refresh after midnight, before the 1s rollover timer fires,
// must resolve Vietnam today synchronously and never read the previous day.
async function scenarioMidnightImmediateRefresh({ container, portal }) {
  await flush(30);
  const day0 = vnDay();
  await explicitRefresh(container);
  await waitFor(() => container.querySelector("[data-kfm-order]"), "day0 order card");
  assert.deepEqual(portal.listDates, [day0], "the first read is day0");
  assert.equal(todayAttr(container), day0, "the panel is still on day0 before the clock crosses");
  let day1 = null;
  await act(async () => {
    nowOffset += 86_400_000; // midnight crosses with no focus/visibility event
    day1 = vnDay();
    const button = refreshButton(container);
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 40));
  });
  assert.notEqual(day1, day0);
  assert.equal(portal.list, 2, "exactly one explicit read after midnight");
  assert.equal(portal.listDates[1], day1, "the refresh must resolve Vietnam today synchronously, not yesterday");
  assert.equal(todayAttr(container), day1, "the panel advances to the new day on the refresh click");
  assert.equal(listState(container), "ready");
  assert(container.querySelector("[data-kfm-order]"), "the new day's orders render");
}

// H. a stale in-flight old-day result cannot leak into the new day.
async function scenarioMidnightStaleResult({ container, portal }) {
  await flush(30);
  const day0 = vnDay();
  portal.ordersByDate[day0] = [{ ...ORDER, code: "PO-OLD-DAY" }];
  portal.holdList = true;
  await explicitRefresh(container);
  assert.equal(portal.list, 1, "old-day read is in flight");
  nowOffset += 86_400_000;
  const day1 = vnDay();
  await act(async () => { window.dispatchEvent(new window.Event("focus")); await new Promise((r) => setTimeout(r, 20)); });
  await flush(20);
  portal.ordersByDate[day1] = [{ ...ORDER, code: "PO-NEW-DAY" }];
  portal.holdList = false;
  await act(async () => { portal.releaseList.splice(0).forEach((release) => release()); await new Promise((r) => setTimeout(r, 20)); });
  await flush(40);
  assert.equal(listState(container), "idle", "the late old-day result must not populate the new day");
  assert(!container.textContent.includes("PO-OLD-DAY"), "the stale old-day order must never render");
  assert.equal(portal.list, 1, "the late result must not trigger another read");
  await explicitRefresh(container);
  await waitFor(() => container.textContent.includes("PO-NEW-DAY"), "new-day order after explicit refresh");
  assert(!container.textContent.includes("PO-OLD-DAY"), "only the new day is shown");
  assert.equal(portal.list, 2);
}

// I. printing/creating a note must not read the list (removed post-print refetch).
async function scenarioPostPrintNoListRead({ container, portal }) {
  await flush(30);
  await explicitRefresh(container);
  await waitFor(() => container.querySelector("[data-kfm-order]"), "order card before print");
  assert.equal(portal.list, 1);
  const asn = await waitFor(() => container.querySelector('[data-kfm-action="print-asn"]:not([disabled])'), "print-asn");
  await click(asn);
  await waitFor(() => portal.pdf === 1, "verified sheet printed");
  assert.equal(portal.create, 1, "the fixture create path ran once");
  assert.equal(portal.confirm, 0, "printing must not confirm separately");
  await flush(60);
  assert.equal(portal.list, 1, "post-print must not trigger another list read");
  assert.equal(listState(container), "ready", "the list stays as the operator loaded it");
}

// --- runner -----------------------------------------------------------------
// The cached-revisit scenario manages its own remount, so it runs with a small
// custom runner that exposes setCurrent() to the teardown.
async function runCachedRevisit(width) {
  nowOffset = 0;
  storageWrites.length = 0;
  viewers = [];
  const portal = makePortal();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let current = await mount(client);
  const ctx = {
    client,
    portal,
    get container() { return current.container; },
    get app() { return current.app; },
    setCurrent(next) { current = next; },
    async remount() { await unmount(current.container, current.app); current = await mount(client); return current; },
  };
  try {
    await scenarioCachedRevisit(ctx);
    assert.equal(storageWrites.length, 0, "no browser storage write may happen");
    results.push({ width, name: "cached-revisit", pass: true, actions: portal.actions, listDates: portal.listDates });
  } catch (error) {
    failures.push(`${width}-cached-revisit: ${error.message}`);
    results.push({ width, name: "cached-revisit", pass: false, error: error.message, actions: portal.actions, listDates: portal.listDates });
  } finally {
    try { await unmount(current.container, current.app); } catch { /* teardown only */ }
    globalThis.fetch = undefined;
  }
}

const widths = [320, 390, 1440];
const matrix = [
  ["mount-idle", scenarioMountIdle],
  ["no-automatic-triggers", scenarioNoAutomaticTriggers],
  ["explicit-refresh-ready", scenarioExplicitRefreshReady],
  ["explicit-refresh-empty", scenarioExplicitRefreshEmpty],
  ["fast-repeated-refresh", scenarioFastRepeatedRefresh],
  ["error-retry-via-refresh", scenarioErrorRetry],
  ["day-rollover", scenarioDayRollover],
  ["midnight-immediate-refresh", scenarioMidnightImmediateRefresh],
  ["midnight-stale-result", scenarioMidnightStaleResult],
  ["post-print-no-list-read", scenarioPostPrintNoListRead],
];

try {
  for (const width of widths) {
    Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
    for (const [name, fn] of matrix) {
      await scenario(name, width, fn);
    }
    await runCachedRevisit(width);
  }

  fs.writeFileSync(path.join(out, "qa-manual-refresh-results.json"), JSON.stringify({ results, failures }, null, 2));
  console.log(`${results.length - failures.length}/${results.length} KFM manual-refresh scenarios passed -> ${out}`);
  if (failures.length) {
    console.error("Failed scenarios:\n" + failures.join("\n"));
    process.exitCode = 1;
  }
} catch (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
} finally {
  await Promise.race([server.close().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 3000))]);
  process.exit(process.exitCode || 0);
}
