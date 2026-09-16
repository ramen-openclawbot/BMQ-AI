/**
 * Behavioral regression for the KFM delivery-note workspace surviving Supabase
 * auth events.
 *
 * Bug: printing a delivery note opened the waiting tab, then the workspace
 * disappeared and the time form never appeared. AuthProvider called
 * fetchRolesAndPermissions on every auth event and that function immediately
 * did setAuthzLoaded(false); ModuleRoute then rendered the loading fallback,
 * unmounting the whole KFM module (and its in-flight create state) for a plain
 * same-user SIGNED_IN / TOKEN_REFRESHED.
 *
 * This script loads the real sources (AuthProvider, AppRoutes/ModuleRoute and
 * KfmPortalDialog) through Vite SSR into jsdom, with the Supabase client and the
 * kfm-portal-sync endpoint replaced by controllable fixtures. It drives real
 * auth events and asserts observable behavior:
 *   - initial bootstrap loading, then the workspace;
 *   - a same-user event while the waiting tab is open keeps the workspace
 *     mounted and the in-flight create lands in the time form;
 *   - typed time values and error feedback survive further same-user events
 *     (tab return);
 *   - concurrent same-user refresh coalesces;
 *   - revocation and authz network failure fail closed (no retained access);
 *   - signout/account switch clear access and late responses from the old
 *     identity/refresh never overwrite the new one, including a delayed
 *     bootstrap getSession read that resolves after SIGNED_OUT / a switch;
 *   - the @bmq.vn company-email policy is unchanged.
 *
 * All portal calls are intercepted; no real portal record is read or written.
 * Run from apps/web:  node scripts/qa_kfm_authz_state.mjs
 */
import { createServer } from "vite";
import path from "node:path";
import fs from "node:fs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const { JSDOM } = await import(
  process.env.KFM_QA_JSDOM || "/Users/c.o.t.e/.openclaw/workspace-sushi/projects/deepseek-harness/node_modules/jsdom/lib/api.js"
);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = process.env.KFM_QA_OUT || "/tmp/kfm-authz";
fs.mkdirSync(out, { recursive: true });

// --- jsdom environment before React/react-dom are imported -------------------
const dom = new JSDOM('<!doctype html><html><body><div id="app"></div></body></html>', {
  url: "http://127.0.0.1/",
  pretendToBeVisual: true,
});
const { window } = dom;
for (const key of [
  "window", "document", "navigator", "HTMLElement", "HTMLAnchorElement", "Element", "Node",
  "Event", "MouseEvent", "PointerEvent", "CustomEvent", "getComputedStyle",
  "requestAnimationFrame", "cancelAnimationFrame", "localStorage", "location",
]) {
  Object.defineProperty(globalThis, key, { value: window[key], configurable: true, writable: true });
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
globalThis.URL.createObjectURL = () => "blob:qa";
globalThis.URL.revokeObjectURL = () => {};

// ---------------------------------------------------------------------------
// Controllable Supabase fixture
// ---------------------------------------------------------------------------
function makeControl() {
  const listeners = [];
  const rows = { profiles: [], user_roles: [], user_module_permissions: [] };
  const errors = {};
  const throws = {};
  const gates = { profiles: [], user_roles: [], user_module_permissions: [] };
  const calls = { profiles: 0, user_roles: 0, user_module_permissions: 0, writes: 0, signOut: 0 };
  const state = { session: null };
  let sessionGate = null;

  class Builder {
    constructor(table) { this.table = table; this.single = false; this.op = null; }
    select() { return this; }
    eq() { return this; }
    maybeSingle() { this.single = true; return this; }
    insert() { this.op = "insert"; return this; }
    upsert() { this.op = "upsert"; return this; }
    then(resolve, reject) { return this.exec().then(resolve, reject); }
    async exec() {
      calls[this.table] = (calls[this.table] || 0) + 1;
      // Snapshot what the "server" answered for this request; a delayed request
      // must still return the data of its own identity, not a later one.
      const snapshot = { error: errors[this.table], thrown: throws[this.table], data: rows[this.table] };
      const gate = gates[this.table].shift();
      if (gate) await gate;
      if (this.op) {
        calls.writes += 1;
        if (snapshot.thrown) throw snapshot.thrown;
        return { data: null, error: snapshot.error || null };
      }
      if (snapshot.thrown) throw snapshot.thrown;
      if (snapshot.error) return { data: null, error: snapshot.error };
      return { data: this.single ? (snapshot.data[0] ?? null) : snapshot.data, error: null };
    }
  }

  const supabase = {
    auth: {
      onAuthStateChange(cb) {
        listeners.push(cb);
        return { data: { subscription: { unsubscribe() { const i = listeners.indexOf(cb); if (i >= 0) listeners.splice(i, 1); } } } };
      },
      async getSession() {
        // Snapshot the session when the read starts (as Supabase does); a
        // signout/switch while it is pending must not rewrite what it returns.
        const captured = state.session;
        if (sessionGate) await sessionGate;
        return { data: { session: captured } };
      },
      async signOut() { calls.signOut += 1; state.session = null; },
    },
    from(table) { return new Builder(table); },
  };

  return {
    supabase, rows, errors, throws, gates, calls,
    setSession(s) { state.session = s; },
    holdSession() {
      let release;
      sessionGate = new Promise((resolve) => { release = resolve; });
      return () => { sessionGate = null; release(); };
    },
    async emit(event, session) {
      state.session = session;
      for (const cb of [...listeners]) await cb(event, session);
    },
    gate(table) {
      let release;
      const promise = new Promise((resolve) => { release = resolve; });
      gates[table].push(promise);
      return release;
    },
    reset() {
      listeners.length = 0;
      rows.profiles = []; rows.user_roles = []; rows.user_module_permissions = [];
      for (const key of Object.keys(errors)) delete errors[key];
      for (const key of Object.keys(throws)) delete throws[key];
      for (const key of Object.keys(gates)) gates[key] = [];
      calls.profiles = 0; calls.user_roles = 0; calls.user_module_permissions = 0; calls.writes = 0; calls.signOut = 0;
      state.session = null;
      sessionGate = null;
    },
  };
}

const control = makeControl();
globalThis.__supabaseFixture = control.supabase;

// ---------------------------------------------------------------------------
// Controllable portal fixture
// ---------------------------------------------------------------------------
const portal = { actions: [], holdTripOptions: false, releaseTripOptions: null, tripOptionsResult: "ok" };
function resetPortal() { portal.actions = []; portal.holdTripOptions = false; portal.releaseTripOptions = null; portal.tripOptionsResult = "ok"; }

const ORDER = { portalId: 239751, code: "PO1002648379", locationName: "KHO QA", totalQty: 110, itemCount: 1 };
const ITEMS = [{ poId: 239751, poCode: ORDER.code, poItemId: 1, variantId: null, productCode: "CODE", barcode: "SP", productName: "Bánh", unitName: "CÁI", shipQty: 110, cartons: 0 }];
const FLEET = { vehicles: [{ id: 1, plateNumber: "51C - 12345", defaultDriverId: 2 }], drivers: [{ id: 2, name: "Tài xế mẫu", phone: "0123456789" }] };
const OPTIONS = { deliveryType: null, vehicleTypes: [{ id: 1, name: "Xe tải" }], vehicleTypeId: 1, slots: [] };
// vehicle + driver are saved, so only the delivery window is missing -> the KFM
// time form is what the operator is waiting for.
const TRIP_OPTIONS_OK = { success: true, revision: "rev-1", fleet: FLEET, options: OPTIONS, draft: { stops: [{ items: ITEMS }] }, pendingChangeCategories: [] };

const json = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
globalThis.fetch = async (_url, options) => {
  const body = JSON.parse(options.body);
  portal.actions.push(body.action);
  if (body.action === "list") return json({ success: true, configured: true, orders: [ORDER] });
  if (body.action === "trip-options") {
    if (portal.holdTripOptions) await new Promise((resolve) => { portal.releaseTripOptions = resolve; });
    if (portal.tripOptionsResult === "error") return json({ success: false, message: "Cổng KFM báo lỗi QA." });
    return json(TRIP_OPTIONS_OK);
  }
  throw new Error("Unexpected portal action in authz regression: " + body.action);
};

// A click-opened tab has no application CSS; KfmPortalDialog paints a waiting
// state into it. Give it just enough document surface to do that.
function fakeViewer() {
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
window.open = () => fakeViewer();

// ---------------------------------------------------------------------------
// Load the real sources through Vite (only unrelated pages/layout are stubbed).
// ---------------------------------------------------------------------------
const STUB_PREFIX = "virtual:qa-stub:";
// KFM_AUTHZ_BASELINE=1 serves the exact pre-fix source for the two runtime files so
// the same assertions can reproduce the pre-fix failure without touching the
// working tree.
const BASELINE = process.env.KFM_AUTHZ_BASELINE === "1";
const BASELINE_REF = process.env.KFM_AUTHZ_BASELINE_REF || "30dc9ad121cec4b4b2a34a8b8bff56fc496aeb58";
const BASELINE_FILES = {
  [root + "/src/contexts/AuthContext.tsx"]: "apps/web/src/contexts/AuthContext.tsx",
  [root + "/src/components/AppRoutes.tsx"]: "apps/web/src/components/AppRoutes.tsx",
};
const baselinePlugin = {
  name: "kfm-authz-baseline",
  enforce: "pre",
  load(id) {
    if (!BASELINE) return null;
    const rel = BASELINE_FILES[id.split("?")[0]];
    if (!rel) return null;
    return execFileSync("git", ["show", BASELINE_REF + ":" + rel], { cwd: root, encoding: "utf8" });
  },
};
const stubsPlugin = {
  name: "kfm-authz-stubs",
  enforce: "pre",
  resolveId(id) {
    if (id.includes("KfmPrintToday")) return null; // keep the real page under test
    const isPage = id.startsWith("@/pages/") || id.includes("/src/pages/");
    const isWarehouse = id.startsWith("@/warehouse/") || id.includes("/src/warehouse/");
    const isLayout = id === "@/components/layout/AppLayout" || id.includes("/src/components/layout/AppLayout");
    if (isPage || isWarehouse || isLayout) return STUB_PREFIX + id;
    return null;
  },
  load(id) {
    if (!id.startsWith(STUB_PREFIX)) return null;
    const key = id.slice(STUB_PREFIX.length);
    if (key.includes("AppLayout")) {
      return 'import { Outlet } from "react-router-dom";\nimport React from "react";\nexport function AppLayout(){ return React.createElement("div", { "data-qa-layout": "1" }, React.createElement(Outlet)); }\nexport default AppLayout;';
    }
    return 'import React from "react";\nexport default function Stub(){ return React.createElement("div", { "data-qa-stub": "1" }); }';
  },
};

const server = await createServer({
  root,
  configFile: false,
  cacheDir: process.env.KFM_QA_CACHE || "/tmp/kfm-authz/vite-cache-ssr",
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "error",
  resolve: { alias: { "@/integrations/supabase/client": "\0qa-auth", sonner: "\0qa-sonner", "@": root + "/src" } },
  plugins: [
    baselinePlugin,
    stubsPlugin,
    {
      name: "kfm-authz-fixtures",
      resolveId(id) {
        if (id === "\0qa-auth" || id === "\0qa-sonner") return id;
        if (id === root + "/src/integrations/supabase/client") return "\0qa-auth";
      },
      load(id) {
        if (id === "\0qa-auth") return "export const supabase = globalThis.__supabaseFixture;";
        if (id === "\0qa-sonner") return "export const toast={loading:()=>{},dismiss:()=>{},success:()=>{},error:()=>{}};";
      },
    },
  ],
});

const { AuthProvider, useAuth } = await server.ssrLoadModule("/src/contexts/AuthContext.tsx");
const { AppRoutes } = await server.ssrLoadModule("/src/components/AppRoutes.tsx");
const { LanguageProvider } = await server.ssrLoadModule("/src/contexts/LanguageContext.tsx");

const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const { act } = await import("react-dom/test-utils");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { MemoryRouter } = await import("react-router-dom");

const KFM_PATH = "/production/planning/q7/kfm";
const session = (id, email) => ({ access_token: "fixture-token", user: { id, email, user_metadata: {} } });

function Probe() {
  const auth = useAuth();
  globalThis.__probe = {
    loading: auth.loading,
    authzLoaded: auth.authzLoaded,
    authzError: auth.authzError === true,
    userId: auth.user?.id ?? null,
    roles: [...auth.roles],
    permissions: auth.permissions ?? [],
    isOwner: auth.isOwner,
    canKfm: auth.canAccessModule("production_q7"),
    refreshRoles: auth.refreshRoles,
  };
  return null;
}

let cleanups = [];
const onCleanup = (fn) => cleanups.push(fn);

async function mountApp() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const rootEl = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    rootEl.render(
      React.createElement(QueryClientProvider, { client },
        React.createElement(LanguageProvider, null,
          React.createElement(MemoryRouter, { initialEntries: [KFM_PATH] },
            React.createElement(AuthProvider, null,
              React.createElement(Probe),
              React.createElement(AppRoutes)))))
    );
  });
  onCleanup(async () => {
    await act(async () => { rootEl.unmount(); });
    container.remove();
  });
  return { container, rootEl, client };
}

const flush = (ms = 0) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });

async function waitFor(fn, label, timeout = 5000) {
  const start = Date.now();
  for (;;) {
    let value;
    try { value = fn(); } catch { /* keep polling */ }
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error("Timed out waiting for " + label);
    await flush(10);
  }
}

async function click(el) {
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function setSelect(el, value) {
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new window.Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

const kfmSection = (c) => c.querySelector("[data-kfm-today]");
const orderNode = (c) => c.querySelector("[data-kfm-order]");
const authzErrorNode = (c) => c.querySelector("[data-authz-error]");
const noAccessNode = (c) => c.querySelector("[data-authz-denied]");

async function waitWorkspace(container) {
  try {
    return await waitFor(() => container.querySelector('[data-kfm-action="print-asn"]:not([disabled])'), "enabled print-asn button");
  } catch (error) {
    throw new Error(error.message + " | probe=" + JSON.stringify(globalThis.__probe) + " | html=" + container.innerHTML.slice(0, 400));
  }
}

async function openTimeForm(container) {
  const asn = await waitWorkspace(container);
  await click(asn);
  await waitFor(() => container.querySelector("[data-kfm-create] [data-kfm-time-select]"), "KFM time form");
  return container.querySelector("[data-kfm-create]");
}

function baseRows({ roles = ["owner"], perms = [], profile = { id: "p1", user_id: "u1", full_name: "QA", email: "owner@bmq.vn" } } = {}) {
  control.rows.user_roles = roles.map((role) => ({ role }));
  control.rows.user_module_permissions = perms;
  control.rows.profiles = [profile];
}

const RESULTS = [];
async function scenario(name, fn) {
  try {
    await fn();
    RESULTS.push({ name, pass: true });
    console.log("PASS  " + name);
  } catch (error) {
    RESULTS.push({ name, pass: false, error: error?.message || String(error), stack: error?.stack });
    console.log("FAIL  " + name + "\n      " + (error?.message || error));
  } finally {
    for (const cleanup of cleanups.reverse()) { try { await cleanup(); } catch { /* teardown only */ } }
    cleanups = [];
    control.reset();
    resetPortal();
    globalThis.__probe = undefined;
  }
}

// ===========================================================================
// Scenarios
// ===========================================================================

await scenario("initial bootstrap gates the module until authz resolves", async () => {
  control.setSession(session("u1", "owner@bmq.vn"));
  baseRows();
  const releaseSession = control.holdSession();
  const releaseRoles = control.gate("user_roles");
  const { container, rootEl } = await mountApp();
  await flush(20);
  assert.ok(!kfmSection(container), "must not render the module before the session is known");
  assert.equal(globalThis.__probe.loading, true, "bootstrap must report loading");

  releaseSession(); // session now resolves
  await flush(20);
  assert.ok(!kfmSection(container), "must not grant the module before authz resolves");

  releaseRoles();
  await waitWorkspace(container);
  assert.equal(globalThis.__probe.authzLoaded, true, "authz must settle loaded");
  assert.equal(globalThis.__probe.isOwner, true);
});

await scenario("same-user TOKEN_REFRESHED while waiting tab is open keeps workspace mounted and lands the form", async () => {
  control.setSession(session("u1", "owner@bmq.vn"));
  baseRows();
  const { container, rootEl } = await mountApp();
  await waitWorkspace(container);
  const beforeNode = orderNode(container);
  const rolesBefore = control.calls.user_roles;

  portal.holdTripOptions = true;
  await click(container.querySelector('[data-kfm-action="print-asn"]'));
  await flush(20);

  // Auth event fires while the create request is still in flight.
  const releaseRoles = control.gate("user_roles");
  await act(async () => { void control.emit("TOKEN_REFRESHED", session("u1", "owner@bmq.vn")); });
  await flush(20);

  assert.ok(kfmSection(container), "same-user refresh must not unmount the KFM workspace");
  assert.equal(orderNode(container), beforeNode, "the mounted order node must survive the refresh");
  assert.ok(control.calls.user_roles > rolesBefore, "rights must still be re-checked on the event");

  releaseRoles();
  await flush(20);

  portal.holdTripOptions = false;
  if (portal.releaseTripOptions) portal.releaseTripOptions();
  const form = await waitFor(() => container.querySelector("[data-kfm-create] [data-kfm-time-select]"), "time form after the waiting tab resolves");
  assert.ok(form, "the waiting tab must land in the time form, not silently return");
});

await scenario("typed time values and tab-return focus survive a further same-user event", async () => {
  control.setSession(session("u1", "owner@bmq.vn"));
  baseRows();
  const { container, rootEl } = await mountApp();
  const form = await openTimeForm(container);
  const groups = form.querySelectorAll("[data-kfm-time-select]");
  assert.equal(groups.length, 2, "from/to windows");
  const fromHour = groups[0].querySelector('[data-kfm-time-part="hour"]');
  const fromMinute = groups[0].querySelector('[data-kfm-time-part="minute"]');
  const toHour = groups[1].querySelector('[data-kfm-time-part="hour"]');
  const toMinute = groups[1].querySelector('[data-kfm-time-part="minute"]');
  await setSelect(fromHour, "08"); await setSelect(fromMinute, "30");
  await setSelect(toHour, "09"); await setSelect(toMinute, "15");

  const panelBefore = container.querySelector("[data-kfm-create]");
  await act(async () => { window.dispatchEvent(new window.Event("focus")); });
  await act(async () => { void control.emit("SIGNED_IN", session("u1", "owner@bmq.vn")); });
  await flush(20);

  const panelAfter = container.querySelector("[data-kfm-create]");
  assert.equal(panelAfter, panelBefore, "the open form must be the same mounted node");
  const groupsAfter = panelAfter.querySelectorAll("[data-kfm-time-select]");
  assert.equal(groupsAfter[0].querySelector('[data-kfm-time-part="hour"]').value, "08");
  assert.equal(groupsAfter[0].querySelector('[data-kfm-time-part="minute"]').value, "30");
  assert.equal(groupsAfter[1].querySelector('[data-kfm-time-part="hour"]').value, "09");
  assert.equal(groupsAfter[1].querySelector('[data-kfm-time-part="minute"]').value, "15");
});

await scenario("KFM error feedback survives a same-user event", async () => {
  control.setSession(session("u1", "owner@bmq.vn"));
  baseRows();
  const { container, rootEl } = await mountApp();
  await waitWorkspace(container);
  portal.tripOptionsResult = "error";
  await click(container.querySelector('[data-kfm-action="print-asn"]'));
  const panel = await waitFor(() => container.querySelector("[data-kfm-create]"), "error panel");
  const alert = waitFor(() => panel.querySelector('[role="alert"]'), "error alert");
  await alert;

  await act(async () => { void control.emit("TOKEN_REFRESHED", session("u1", "owner@bmq.vn")); });
  await flush(20);
  const panelAfter = container.querySelector("[data-kfm-create]");
  assert.equal(panelAfter, panel, "the error panel must stay mounted");
  assert.ok(panelAfter.querySelector('[role="alert"]'), "the error message must survive");
});

await scenario("concurrent same-user refreshes coalesce and keep the workspace", async () => {
  control.setSession(session("u1", "owner@bmq.vn"));
  baseRows();
  const { container, rootEl } = await mountApp();
  await waitWorkspace(container);
  const rolesBefore = control.calls.user_roles;
  const releaseRoles = control.gate("user_roles");
  await act(async () => { void control.emit("TOKEN_REFRESHED", session("u1", "owner@bmq.vn")); });
  await flush(20);
  await act(async () => { void control.emit("TOKEN_REFRESHED", session("u1", "owner@bmq.vn")); });
  await flush(20);
  assert.ok(kfmSection(container), "workspace stays mounted during concurrent refresh");
  assert.equal(control.calls.user_roles - rolesBefore, 1, "one in-flight identity check is enough");
  releaseRoles();
  await flush(20);
  assert.equal(globalThis.__probe.authzLoaded, true);
});

await scenario("permission revocation fails closed and removes the module", async () => {
  control.setSession(session("u2", "staff@bmq.vn"));
  baseRows({
    roles: ["staff"],
    perms: [{ module_key: "production_q7", can_view: true, can_edit: false }],
    profile: { id: "p2", user_id: "u2", full_name: "Staff", email: "staff@bmq.vn" },
  });
  const { container, rootEl } = await mountApp();
  await waitWorkspace(container);
  assert.ok(kfmSection(container), "granted staff sees the workspace");

  control.rows.user_module_permissions = [];
  await act(async () => { void control.emit("TOKEN_REFRESHED", session("u2", "staff@bmq.vn")); });
  await waitFor(() => noAccessNode(container), "no-access panel after revocation");
  assert.ok(!kfmSection(container), "revoked module must not stay mounted");
});

await scenario("authz network failure fails closed (drops stale rights), then recovers on retry", async () => {
  control.setSession(session("u1", "owner@bmq.vn"));
  baseRows();
  const { container, rootEl } = await mountApp();
  await waitWorkspace(container);
  assert.equal(globalThis.__probe.isOwner, true, "owner before the failed check");

  control.errors.user_roles = { message: "QA network failure" };
  await act(async () => { void control.emit("TOKEN_REFRESHED", session("u1", "owner@bmq.vn")); });
  await waitFor(() => authzErrorNode(container), "fail-closed authz panel");
  assert.ok(!kfmSection(container), "a failed rights check must not retain module access");
  assert.equal(globalThis.__probe.authzLoaded, false, "failed authz must not report loaded");
  assert.equal(globalThis.__probe.isOwner, false, "stale owner rights must not be retained");
  assert.deepEqual(globalThis.__probe.roles, [], "stale roles must be dropped on failure");

  delete control.errors.user_roles;
  await act(async () => { await globalThis.__probe.refreshRoles(); });
  await waitWorkspace(container);
  assert.equal(globalThis.__probe.authzLoaded, true, "retry after a transient failure restores access");
  assert.equal(globalThis.__probe.isOwner, true, "retry restores the verified owner rights");
});

await scenario("signout clears access and a late old response cannot restore it", async () => {
  control.setSession(session("u1", "owner@bmq.vn"));
  baseRows();
  const { container, rootEl } = await mountApp();
  await waitWorkspace(container);

  const releaseRoles = control.gate("user_roles");
  await act(async () => { void control.emit("TOKEN_REFRESHED", session("u1", "owner@bmq.vn")); });
  await flush(20);

  await act(async () => { void control.emit("SIGNED_OUT", null); });
  await flush(20);
  assert.ok(!kfmSection(container), "signout must remove the module");
  assert.equal(globalThis.__probe.userId, null, "signout must clear the user");
  assert.deepEqual(globalThis.__probe.roles, [], "signout must clear roles");

  releaseRoles(); // the in-flight owner response lands after signout
  await flush(40);
  assert.ok(!kfmSection(container), "a late response from the signed-out identity must be ignored");
  assert.equal(globalThis.__probe.userId, null);
});

await scenario("account switch ignores the previous identity's delayed response", async () => {
  control.setSession(session("u1", "owner@bmq.vn"));
  baseRows();
  const { container, rootEl } = await mountApp();
  await waitWorkspace(container);

  // Owner re-check in flight, then the account switches before it answers.
  const releaseOwner = control.gate("user_roles");
  await act(async () => { void control.emit("TOKEN_REFRESHED", session("u1", "owner@bmq.vn")); });
  await flush(20);

  baseRows({
    roles: ["staff"],
    perms: [],
    profile: { id: "p2", user_id: "u2", full_name: "Staff", email: "staff@bmq.vn" },
  });
  await act(async () => { void control.emit("SIGNED_IN", session("u2", "staff@bmq.vn")); });
  await waitFor(() => noAccessNode(container), "staff identity has no production_q7 access");
  assert.equal(globalThis.__probe.userId, "u2");
  assert.deepEqual(globalThis.__probe.roles, ["staff"]);

  releaseOwner(); // old owner roles resolve last
  await flush(40);
  assert.deepEqual(globalThis.__probe.roles, ["staff"], "the old identity's roles must never come back");
  assert.ok(noAccessNode(container), "the old identity's rights must not be restored");
});

await scenario("delayed bootstrap session cannot revive a signed-out identity", async () => {
  control.setSession(session("u1", "owner@bmq.vn"));
  baseRows();
  // Bootstrap getSession is captured (u1) but does not resolve yet.
  const releaseSession = control.holdSession();
  const { container } = await mountApp();
  await flush(20);
  assert.equal(globalThis.__probe.loading, true, "bootstrap must still be in flight");
  assert.equal(globalThis.__probe.userId, null);

  // SIGNED_OUT fires while the bootstrap read is pending: currentUserIdRef
  // becomes null, so an identity-only guard would let the stale read revive u1.
  await act(async () => { void control.emit("SIGNED_OUT", null); });
  await flush(20);
  assert.equal(globalThis.__probe.userId, null, "SIGNED_OUT must clear the user");

  releaseSession(); // the captured pre-signout u1 session resolves last
  await flush(40);
  assert.equal(globalThis.__probe.userId, null, "a delayed bootstrap session must not revive the signed-out identity");
  assert.deepEqual(globalThis.__probe.roles, [], "no stale roles may be restored after signout");
  assert.ok(!kfmSection(container), "the module must stay gone after signout");
});

await scenario("delayed bootstrap session cannot override a newer account switch", async () => {
  control.setSession(session("u1", "owner@bmq.vn"));
  baseRows();
  const releaseSession = control.holdSession();
  const { container } = await mountApp();
  await flush(20);
  assert.equal(globalThis.__probe.loading, true, "bootstrap must still be in flight");

  baseRows({
    roles: ["staff"],
    perms: [],
    profile: { id: "p2", user_id: "u2", full_name: "Staff", email: "staff@bmq.vn" },
  });
  await act(async () => { void control.emit("SIGNED_IN", session("u2", "staff@bmq.vn")); });
  await waitFor(() => noAccessNode(container), "the switched account has no production_q7 access");
  assert.equal(globalThis.__probe.userId, "u2");
  assert.deepEqual(globalThis.__probe.roles, ["staff"]);

  releaseSession(); // the captured pre-switch u1 session resolves last
  await flush(40);
  assert.equal(globalThis.__probe.userId, "u2", "the stale bootstrap identity must not come back");
  assert.deepEqual(globalThis.__probe.roles, ["staff"], "the stale bootstrap rights must not come back");
});

await scenario("non-company email is still signed out", async () => {
  control.setSession(session("u9", "outsider@gmail.com"));
  baseRows({ profile: { id: "p9", user_id: "u9", full_name: "Out", email: "outsider@gmail.com" } });
  const { container, rootEl } = await mountApp();
  await flush(40);
  assert.equal(globalThis.__probe.userId, null, "non @bmq.vn identity must be rejected");
  assert.ok(control.calls.signOut >= 1, "the reject path must sign the session out");
  assert.ok(!kfmSection(container));
});

// ===========================================================================
// Summary
// ===========================================================================
const failed = RESULTS.filter((r) => !r.pass);
fs.writeFileSync(path.join(out, "authz-state-qa.json"), JSON.stringify({ results: RESULTS, failed: failed.length }, null, 2));
console.log("\n" + (RESULTS.length - failed.length) + "/" + RESULTS.length + " scenarios passed");
if (failed.length) {
  console.error("Failed scenarios: " + failed.map((r) => r.name).join(" | "));
  process.exitCode = 1;
}
// Vite SSR dependency optimizers may retain handles after all assertions.
await Promise.race([server.close(), new Promise(resolve => setTimeout(resolve, 1500))]);
process.exit(process.exitCode || 0);
