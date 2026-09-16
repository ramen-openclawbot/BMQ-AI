/**
 * Behavioral QA for the KFM delivery-print recovery UX.
 *
 * Loads the real `KfmPortalDialog` source through Vite SSR and drives it in
 * jsdom with a fixture auth session and a mocked `kfm-portal-sync` endpoint.
 * It proves the owner-approved slice:
 *   - the standalone "Kiểm tra kết quả" button is gone; no stale instruction
 *     naming it is rendered anywhere;
 *   - pressing "In phiếu giao hàng" performs a read-only `trip-result` readback
 *     and opens the sheet only when the readback state is `verified`;
 *   - an existing-but-unconfirmed PO keeps its explicit "Xác nhận PO và in
 *     phiếu" consent; print/readback never sends confirm-po or create-load;
 *   - unknown / confirmUncertain / missing-intakeRevision recover through the
 *     read-only readback, never by repeating a write;
 *   - a missing `intakeRevision` is re-read safely and the consent stays on
 *     screen when the revision still cannot be read;
 *   - repeated clicks collapse to one call and the click-opened tab is closed
 *     when there is nothing to print and kept when a verified sheet opens;
 *   - backend error reasons survive while the removed-button pointer does not;
 *   - the responsive class contract for the new action row is preserved.
 *
 * Every portal call is intercepted; no real portal record is created. Run from
 * apps/web:  node scripts/qa_kfm_print_readback.mjs
 *
 * Layout note: jsdom has no layout engine, so this run repeats the behavioral
 * matrix at the 320/390/1440 widths and pins the explicit Tailwind contract
 * (min-h-11 buttons, a stacking `flex-col sm:flex-row` action row); it does not
 * measure pixels. Pixel/responsive verification needs a real browser, which the
 * current sandbox blocks (Chromium requires the macOS per-user temp dir).
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
const out = process.env.KFM_QA_OUT || "/tmp/kfm-print-readback";
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
window.HTMLAnchorElement.prototype.click = () => {};
globalThis.URL.createObjectURL = () => "blob:qa";
globalThis.URL.revokeObjectURL = () => {};

// A click-opened tab has no application CSS; KfmPortalDialog paints a waiting
// state into it. Record every tab so lifecycle can be asserted.
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
      name: "kfm-print-readback-fixtures",
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

async function doubleClick(el) {
  await act(async () => {
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function mount(width) {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
  const container = document.createElement("div");
  document.body.appendChild(container);
  const app = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    app.render(
      React.createElement(QueryClientProvider, { client },
        React.createElement(MemoryRouter, null, React.createElement(Panel, { isVi: true }))),
    );
  });
  // The portal list is manual since 2026-09-17: mount renders the idle panel,
  // so each scenario loads today's queue with an explicit 'Làm mới' click.
  await click(await waitFor(() => container.querySelector('[data-kfm-action="refresh-list"]'), "refresh-list button"));
  await waitFor(() => container.querySelector("[data-kfm-order]"), "order card after explicit refresh");
  return { container, app };
}

async function unmount(container, app) {
  await act(async () => { app.unmount(); });
  container.remove();
  globalThis.fetch = undefined;
}

// --- fixtures ---------------------------------------------------------------
const ORDER = { portalId: 241362, code: "PO1002648379", locationName: "KHO QUÁ CẢNH BÁNH TƯƠI", totalQty: 626, itemCount: 6 };
const REV = "a".repeat(64);
const PDF = { success: true, base64: Buffer.from("%PDF-1.4\n%%EOF").toString("base64"), filename: "fixture.pdf" };
const FLEET = { vehicles: [{ id: 1, plateNumber: "TEST", defaultDriverId: 2 }], drivers: [{ id: 2, name: "Tài xế thử nghiệm", phone: "0123456789" }] };
const OPTIONS = { deliveryType: null, vehicleTypes: [{ id: 1, name: "Xe tải" }], vehicleTypeId: 1, slots: [] };
const ITEMS = [{ poId: 241362, poCode: ORDER.code, poItemId: 1, variantId: null, productCode: "FIXTURE", barcode: "SP", productName: "Bánh", unitName: "CÁI", shipQty: 626, cartons: 0 }];
const pending = (overrides = {}) => ({
  state: "unknown", loadId: 90, loadCode: "IL-FIXTURE", asns: [{ asnId: 91, asnCode: "ASN-FIXTURE" }],
  poConfirmation: { confirmed: false, subStatus: 3, label: "Chờ xác nhận" }, intakeRevision: REV,
  message: "Chuyến và ASN đã khớp nhưng chưa xác minh PO đã xác nhận. Không tạo lại; dùng ‘Kiểm tra kết quả’ hoặc kiểm tra cổng KFM.",
  ...overrides,
});
const verified = (overrides = {}) => ({
  ...pending(), state: "verified", poConfirmation: { confirmed: true, subStatus: 6, label: "Chờ giao" },
  message: "Đã đọc lại chuyến, ASN và trạng thái PO: kho và từng dòng số lượng khớp; PO đã được xác nhận.",
  ...overrides,
});
const formResponse = () => ({
  success: true, revision: REV, fleet: FLEET, options: OPTIONS, pendingChangeCategories: [],
  draft: { stops: [{ items: ITEMS }] },
});
const panelOf = (container) => container.querySelector("[data-kfm-create]");
const firstMessageOf = (panel) => panel.querySelector("[data-kfm-create-result]").children[0].textContent;
const openViewers = () => viewers.filter((viewer) => !viewer.closed);

// --- scenarios --------------------------------------------------------------
const scenarios = [
  {
    name: "verified-direct",
    handlers: { "trip-options": () => ({ success: true, result: verified() }), "load-pdf": () => PDF },
    async steps({ container, state }) {
      await doubleClick(await waitFor(() => container.querySelector('[data-kfm-action="print-asn"]:not([disabled])'), "print-asn"));
      await waitFor(() => container.textContent.includes("Đã mở phiếu giao hàng"), "verified feedback");
      assert.equal(state.tripOptions, 1, "repeated clicks collapse to one trip-options read");
      assert.equal(state.create, 0); assert.equal(state.confirm, 0); assert.equal(state.pdf, 1);
      assert.equal(openViewers().length, 1, "verified sheet keeps the click-opened tab");
      assert.equal(openViewers()[0].location.href, "blob:qa");
    },
  },
  {
    name: "unconfirmed-consent-readback-stays",
    handlers: { "trip-options": () => ({ success: true, result: pending() }), "trip-result": () => ({ success: true, result: pending() }) },
    async steps({ container, state }) {
      await doubleClick(await waitFor(() => container.querySelector('[data-kfm-action="print-asn"]:not([disabled])'), "print-asn"));
      const panel = await waitFor(() => panelOf(container), "result panel");
      const consent = await waitFor(() => panel.querySelector('[data-kfm-action="confirm-po"]'), "explicit consent");
      assert.equal(consent.disabled, false);
      assert(panel.querySelector('[data-kfm-action="print-readback"]'), "print action doubles as readback");
      const message = firstMessageOf(panel);
      assert(message.includes("In phiếu giao hàng") && !message.includes("Kiểm tra kết quả"), "stale pointer repointed, reason kept");
      assert(panel.textContent.includes("PO: Chờ xác nhận"));
      assert(panel.textContent.includes("chưa mở được file in"), "not-ready reason shown");
      assert.equal(state.create, 0); assert.equal(state.confirm, 0); assert.equal(state.pdf, 0);
      assert(viewers.length >= 1 && viewers.every((viewer) => viewer.closed), "not-ready panel closes the pending tab");
      await doubleClick(panel.querySelector('[data-kfm-action="print-readback"]'));
      await waitFor(() => state.tripResult === 1, "readback");
      assert.equal(state.tripResult, 1, "repeated readback clicks collapse to one trip-result");
      assert.equal(state.create, 0); assert.equal(state.confirm, 0); assert.equal(state.pdf, 0);
      await waitFor(() => panel.querySelector('[data-kfm-action="confirm-po"]'), "consent after readback");
    },
  },
  {
    name: "unconfirmed-readback-verifies",
    handlers: { "trip-options": () => ({ success: true, result: pending() }), "trip-result": () => ({ success: true, result: verified() }), "load-pdf": () => PDF },
    async steps({ container, state }) {
      await click(await waitFor(() => container.querySelector('[data-kfm-action="print-asn"]:not([disabled])'), "print-asn"));
      const panel = await waitFor(() => panelOf(container), "result panel");
      await doubleClick(await waitFor(() => panel.querySelector('[data-kfm-action="print-readback"]'), "readback"));
      await waitFor(() => state.pdf === 1, "verified sheet");
      assert.equal(state.tripResult, 1); assert.equal(state.create, 0); assert.equal(state.confirm, 0); assert.equal(state.pdf, 1);
      assert.equal(openViewers().length, 1, "verified readback keeps the click-opened tab");
    },
  },
  {
    name: "unknown-readback-sanitizes-and-prints",
    handlers: {
      "trip-options": () => ({ success: true, result: { state: "unknown", message: "Chưa xác minh được chuyến/ASN. Không bấm tạo lại; dùng ‘Kiểm tra kết quả’ hoặc kiểm tra cổng KFM." } }),
      "trip-result": () => ({ success: true, result: verified() }),
      "load-pdf": () => PDF,
    },
    async steps({ container, state }) {
      await click(await waitFor(() => container.querySelector('[data-kfm-action="print-asn"]:not([disabled])'), "print-asn"));
      const panel = await waitFor(() => panelOf(container), "result panel");
      await waitFor(() => panel.querySelector('[data-kfm-action="print-readback"]'), "readback");
      assert.equal(panel.querySelector('[data-kfm-action="confirm-po"]'), null, "no trip readback means no confirm consent");
      const message = firstMessageOf(panel);
      assert(message.includes("In phiếu giao hàng") && !message.includes("Kiểm tra kết quả"), "stale pointer repointed");
      assert(message.includes("kiểm tra cổng KFM"), "backend reason survives");
      await click(panel.querySelector('[data-kfm-action="print-readback"]'));
      await waitFor(() => state.pdf === 1, "verified sheet");
      assert.equal(state.create, 0); assert.equal(state.confirm, 0); assert.equal(state.pdf, 1);
      assert.equal(openViewers().length, 1);
    },
  },
  {
    name: "confirm-consent-verified",
    handlers: {
      "trip-options": () => ({ success: true, result: pending() }),
      "confirm-po": () => ({ success: true, result: { state: "imported", inboxId: "fixture" } }),
      "trip-result": () => ({ success: true, result: verified() }),
      "load-pdf": () => PDF,
    },
    async steps({ container, state }) {
      await click(await waitFor(() => container.querySelector('[data-kfm-action="print-asn"]:not([disabled])'), "print-asn"));
      const panel = await waitFor(() => panelOf(container), "result panel");
      await doubleClick(await waitFor(() => panel.querySelector('[data-kfm-action="confirm-po"]'), "consent"));
      await waitFor(() => state.pdf === 1, "verified sheet");
      assert.equal(state.confirm, 1, "repeated consent clicks collapse to one confirm-po");
      assert.equal(state.tripResult, 1, "confirm is followed by one read-only readback");
      assert.equal(state.create, 0); assert.equal(state.pdf, 1);
      assert.equal(openViewers().length, 1, "verified confirmation keeps the click-opened tab");
    },
  },
  {
    name: "missing-revision-readback-then-confirm",
    handlers: {
      "trip-options": () => ({ success: true, result: pending({ intakeRevision: undefined }) }),
      "trip-result": (_body, state) => ({ success: true, result: state.tripResult === 1 ? pending() : verified() }),
      "confirm-po": () => ({ success: true, result: { state: "imported", inboxId: "fixture" } }),
      "load-pdf": () => PDF,
    },
    async steps({ container, state }) {
      await click(await waitFor(() => container.querySelector('[data-kfm-action="print-asn"]:not([disabled])'), "print-asn"));
      const panel = await waitFor(() => panelOf(container), "result panel");
      const consent = await waitFor(() => panel.querySelector('[data-kfm-action="confirm-po"]'), "consent");
      assert.equal(consent.disabled, false, "explicit consent stays available without a revision");
      await click(consent);
      await waitFor(() => state.pdf === 1, "verified sheet");
      assert.equal(state.tripResult, 2, "one safe readback before confirm, one readback after");
      assert.equal(state.confirm, 1); assert.equal(state.create, 0); assert.equal(state.pdf, 1);
    },
  },
  {
    name: "missing-revision-still-missing",
    handlers: {
      "trip-options": () => ({ success: true, result: pending({ intakeRevision: undefined }) }),
      "trip-result": () => ({ success: true, result: pending({ intakeRevision: undefined }) }),
    },
    async steps({ container, state }) {
      await click(await waitFor(() => container.querySelector('[data-kfm-action="print-asn"]:not([disabled])'), "print-asn"));
      const panel = await waitFor(() => panelOf(container), "result panel");
      await click(await waitFor(() => panel.querySelector('[data-kfm-action="confirm-po"]'), "consent"));
      await waitFor(() => state.tripResult === 1, "safe readback");
      const alert = await waitFor(() => container.querySelector('[role="alert"]'), "explanation");
      assert(alert.textContent.includes("Chưa xác nhận"), "explains why the write did not run");
      assert.equal(state.confirm, 0, "no confirm-po without a fresh revision");
      assert.equal(state.create, 0); assert.equal(state.pdf, 0);
      assert(panel.querySelector('[data-kfm-action="confirm-po"]'), "explicit consent remains on screen");
      assert(viewers.every((viewer) => viewer.closed), "failed confirm closes the pending tab");
    },
  },
  {
    name: "confirm-uncertain-recovery",
    handlers: {
      "trip-options": () => ({ success: true, result: pending() }),
      "confirm-po": () => "abort",
      "trip-result": () => ({ success: true, result: pending() }),
    },
    async steps({ container, state }) {
      await click(await waitFor(() => container.querySelector('[data-kfm-action="print-asn"]:not([disabled])'), "print-asn"));
      let panel = await waitFor(() => panelOf(container), "result panel");
      await click(await waitFor(() => panel.querySelector('[data-kfm-action="confirm-po"]'), "consent"));
      await waitFor(() => container.querySelector('[role="alert"]'), "uncertain error");
      assert.equal(state.confirm, 1); assert.equal(state.create, 0); assert.equal(state.pdf, 0);
      assert.equal(panel.querySelector('[data-kfm-action="confirm-po"]'), null, "uncertain write locks consent until a fresh readback");
      assert(viewers.every((viewer) => viewer.closed), "uncertain confirm closes the pending tab");
      await click(await waitFor(() => panel.querySelector('[data-kfm-action="print-readback"]'), "readback"));
      await waitFor(() => state.tripResult === 1, "readback");
      panel = panelOf(container);
      assert(panel.querySelector('[data-kfm-action="confirm-po"]'), "read-only readback re-enables explicit consent");
      assert.equal(state.confirm, 1); assert.equal(state.create, 0); assert.equal(state.pdf, 0);
    },
  },
  {
    name: "trip-options-network-error",
    handlers: { "trip-options": () => "abort" },
    async steps({ container, state }) {
      await doubleClick(await waitFor(() => container.querySelector('[data-kfm-action="print-asn"]:not([disabled])'), "print-asn"));
      await waitFor(() => container.querySelector('[role="alert"]'), "network error");
      assert.equal(state.tripOptions, 1, "repeated clicks must not double the failed read");
      assert.equal(state.create, 0); assert.equal(state.confirm, 0); assert.equal(state.pdf, 0);
      assert(viewers.every((viewer) => viewer.closed), "network failure closes the pending tab");
      assert.equal(container.querySelector('[data-kfm-action="print-asn"]').disabled, false, "print action is released for retry");
    },
  },
  {
    name: "trip-result-network-error-retryable",
    handlers: { "trip-options": () => ({ success: true, result: pending() }), "trip-result": () => "abort" },
    async steps({ container, state }) {
      await click(await waitFor(() => container.querySelector('[data-kfm-action="print-asn"]:not([disabled])'), "print-asn"));
      const panel = await waitFor(() => panelOf(container), "result panel");
      await click(await waitFor(() => panel.querySelector('[data-kfm-action="print-readback"]'), "readback"));
      await waitFor(() => container.querySelector('[role="alert"]'), "network error");
      assert.equal(state.tripResult, 1); assert.equal(state.create, 0); assert.equal(state.confirm, 0); assert.equal(state.pdf, 0);
      assert(viewers.every((viewer) => viewer.closed), "network failure closes the pending tab");
      const retry = await waitFor(() => panel.querySelector('[data-kfm-action="print-readback"]:not([disabled])'), "retryable readback");
      await click(retry);
      await waitFor(() => state.tripResult === 2, "retry");
      assert.equal(state.create, 0); assert.equal(state.confirm, 0); assert.equal(state.pdf, 0);
    },
  },
  {
    name: "not-sent-reloads-form-without-write",
    handlers: {
      "trip-options": (_body, state) => state.tripOptions === 1
        ? { success: true, result: { state: "not_sent", message: "Chưa ghi nhận yêu cầu tạo trên máy chủ. Tải lại form để kiểm tra trước khi tạo." } }
        : formResponse(),
    },
    async steps({ container, state }) {
      await click(await waitFor(() => container.querySelector('[data-kfm-action="print-asn"]:not([disabled])'), "print-asn"));
      const panel = await waitFor(() => panelOf(container), "result panel");
      const reload = await waitFor(() => panel.querySelector('[data-kfm-action="reload-form"]'), "reload action");
      await click(reload);
      await waitFor(() => container.querySelector('[data-kfm-create] [data-kfm-action="submit-create"]'), "form after reload");
      assert.equal(state.create, 0, "reloading the form must not create anything");
      assert.equal(state.confirm, 0); assert.equal(state.pdf, 0); assert.equal(state.tripOptions, 2);
    },
  },
  {
    name: "backend-error-reason-preserved",
    handlers: { "trip-options": () => ({ success: false, message: "PO đã hủy, không được tạo phiếu." }) },
    async steps({ container, state }) {
      await click(await waitFor(() => container.querySelector('[data-kfm-action="print-asn"]:not([disabled])'), "print-asn"));
      const alert = await waitFor(() => container.querySelector('[role="alert"]'), "backend error");
      assert(alert.textContent.includes("PO đã hủy, không được tạo phiếu."), "backend reason must survive");
      assert.equal(state.create, 0); assert.equal(state.confirm, 0); assert.equal(state.pdf, 0);
    },
  },
  {
    name: "existing-note-reprint",
    handlers: { "trip-options": () => ({ success: true, existingNotes: [{ asnId: 91, asnCode: "ASN-FIXTURE" }] }), "asn-pdf": () => PDF },
    async steps({ container, state }) {
      await click(await waitFor(() => container.querySelector('[data-kfm-action="print-asn"]:not([disabled])'), "print-asn"));
      await waitFor(() => state.pdf === 1, "existing note sheet");
      assert(state.actions.includes("asn-pdf"), "existing note reprint uses the ASN sheet");
      assert.equal(state.create, 0); assert.equal(state.confirm, 0); assert.equal(state.pdf, 1);
    },
  },
  {
    name: "not-ready-layout-contract",
    handlers: { "trip-options": () => ({ success: true, result: pending() }) },
    async steps({ container }) {
      await click(await waitFor(() => container.querySelector('[data-kfm-action="print-asn"]:not([disabled])'), "print-asn"));
      const panel = await waitFor(() => panelOf(container), "result panel");
      assert(panel.className.includes("min-w-0"), "panel can shrink inside the app shell");
      assert.equal(panel.getAttribute("data-kfm-create"), "v2");
      const row = panel.querySelector('[data-kfm-create-result] div.flex');
      assert(row, "action row exists");
      assert(row.className.includes("flex-col") && row.className.includes("sm:flex-row") && row.className.includes("sm:flex-wrap"),
        "actions stack on a phone and wrap on wider screens: " + row.className);
      for (const action of ["confirm-po", "print-readback"]) {
        const button = panel.querySelector(`[data-kfm-action="${action}"]`);
        assert(button.className.includes("min-h-11"), `${action} must stay a 44px target`);
      }
      const unavailable = panel.querySelector('[data-kfm-unavailable="v1"]');
      assert(unavailable && unavailable.className.includes("text-xs"), "not-ready reason is a small inline note");
    },
  },
  {
    name: "busy-guard",
    handlers: {
      "trip-options": async () => {
        await new Promise((resolve) => { busyRelease = resolve; });
        return { success: true, result: pending() };
      },
    },
    async steps({ container, state }) {
      const asn = await waitFor(() => container.querySelector('[data-kfm-action="print-asn"]:not([disabled])'), "print-asn");
      await doubleClick(asn);
      assert.equal(state.tripOptions, 1, "repeated clicks must not double-fetch options");
      assert.equal(container.querySelector('[data-kfm-action="print-asn"]').disabled, true, "actions disabled while the read is in flight");
      await act(async () => { busyRelease(); await new Promise((r) => setTimeout(r, 0)); });
      await waitFor(() => panelOf(container), "panel after release");
      assert.equal(state.create, 0);
    },
  },
];

// --- runner -----------------------------------------------------------------
let busyRelease = null;
const results = [];
const failures = [];

try {
  for (const width of [320, 390, 1440]) {
    for (const scenario of scenarios) {
      viewers = [];
      busyRelease = null;
      const state = { actions: [], tripOptions: 0, tripResult: 0, create: 0, confirm: 0, pdf: 0 };
      globalThis.fetch = async (_url, options) => {
        const body = JSON.parse(options.body);
        state.actions.push(body.action);
        if (body.action === "list") return json({ success: true, orders: [ORDER] });
        const handler = scenario.handlers[body.action];
        if (!handler) throw new Error("Unexpected portal action: " + body.action);
        if (body.action === "trip-options") state.tripOptions += 1;
        if (body.action === "trip-result") state.tripResult += 1;
        if (body.action === "create-load") state.create += 1;
        if (body.action === "confirm-po") state.confirm += 1;
        if (body.action === "load-pdf" || body.action === "asn-pdf") state.pdf += 1;
        const response = await handler(body, state);
        if (response === "abort") throw new TypeError("Failed to fetch");
        return json(response);
      };
      const { container, app } = await mount(width);
      try {
        await scenario.steps({ container, state });
        assert.equal(container.querySelector('[data-kfm-action="check-create"]'), null, "removed status button must not render");
        assert(!container.textContent.includes("Kiểm tra kết quả"), "no stale removed-button instruction is rendered");
        results.push({ width, name: scenario.name, actions: state.actions, tripOptions: state.tripOptions, tripResult: state.tripResult, create: state.create, confirm: state.confirm, pdf: state.pdf, pass: true });
      } catch (error) {
        failures.push(`${width}-${scenario.name}: ${error.message}`);
        results.push({ width, name: scenario.name, actions: state.actions, pass: false, error: error.message });
      } finally {
        await unmount(container, app);
      }
    }
  }

  fs.writeFileSync(path.join(out, "qa-print-readback-results.json"), JSON.stringify({ results, failures }, null, 2));
  console.log(`${results.length - failures.length}/${results.length} KFM print-readback scenarios passed -> ${out}`);
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
