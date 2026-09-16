/**
 * Regression QA for the KFM delivery-window pickers.
 *
 * Loads the real `KfmPortalDialog` source through Vite SSR and drives it in jsdom
 * with a fixture session and a mocked `kfm-portal-sync` endpoint. It proves:
 *   - no native `input[type=time]` remains; each window uses two explicit 24h
 *     selects (hours 00..23, minutes 00..59) with unique accessible labels;
 *   - empty and partial windows stay partial and cannot be submitted;
 *   - reverse and equal windows are rejected; a valid window is accepted;
 *   - either half can be changed first and the value is stored as "HH:mm";
 *   - the outbound create-load payload carries exactly the expected "HH:mm";
 *   - repeated clicks cause one write (requestId) and actions are disabled busy;
 *   - the existing FIXED booking-slot path is untouched.
 *
 * Every portal call is intercepted; no real portal record is created.
 * Run from apps/web:  node scripts/qa_kfm_time_select.mjs
 *
 * Layout note: jsdom has no layout engine, so 44px touch targets and the 320px
 * fit are asserted here as the explicit Tailwind contract (min-h-11 / flex-1 /
 * min-w-0) that the browser QA (`qa_kfm_po_intake_page.mjs` style) measures.
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
const out = process.env.KFM_QA_OUT || "/tmp/kfm-time/qa";
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
window.open = () => null;
window.HTMLAnchorElement.prototype.click = () => {};
globalThis.URL.createObjectURL = () => "blob:qa";
globalThis.URL.revokeObjectURL = () => {};

const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const { act } = await import("react-dom/test-utils");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { MemoryRouter } = await import("react-router-dom");

// --- load the real source through Vite --------------------------------------
const ids = { "@/integrations/supabase/client": "\0qa-auth", sonner: "\0qa-sonner" };
const server = await createServer({
  root,
  configFile: false,
  cacheDir: process.env.KFM_QA_CACHE || "/tmp/kfm-time/vite-cache-ssr",
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "error",
  resolve: { alias: { "@/integrations/supabase/client": "\0qa-auth", sonner: "\0qa-sonner", "@": root + "/src" } },
  plugins: [
    {
      name: "kfm-time-qa-fixtures",
      resolveId(id) {
        if (Object.values(ids).includes(id)) return id;
        if (id === root + "/src/integrations/supabase/client") return "\0qa-auth";
      },
      load(id) {
        if (id === "\0qa-auth")
          return 'export const supabase={auth:{getSession:async()=>({data:{session:{access_token:"fixture-only"}}})}};';
        if (id === "\0qa-sonner")
          return "export const toast={loading:()=>{},dismiss:()=>{},success:()=>{},error:()=>{}};";
      },
    },
  ],
});
const { default: Panel } = await server.ssrLoadModule("/src/components/production/KfmPortalDialog.tsx");
const { splitKfmTime, joinKfmTime, isCompleteKfmTime, KFM_HOURS, KFM_MINUTES } =
  await server.ssrLoadModule("/src/components/production/KfmTimeSelect.tsx");

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

async function setSelect(el, value) {
  await act(async () => {
    el.value = value;
    el.dispatchEvent(new window.Event("change", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
  });
}

const ORDER = { portalId: 239751, code: "PO1002648379", locationName: "KHO QUÁ CẢNH BÁNH TƯƠI", totalQty: 110, itemCount: 1 };
const ITEMS = [{ poId: 239751, poCode: ORDER.code, poItemId: 1, variantId: null, productCode: "CODE", barcode: "SP", productName: "Bánh", unitName: "CÁI", shipQty: 110, cartons: 0 }];
const FLEET = { vehicles: [{ id: 1, plateNumber: "51C - 12345", defaultDriverId: 2 }], drivers: [{ id: 2, name: "Tài xế mẫu", phone: "0123456789" }] };

/** Fixture portal: record every action, intercept every call, never touch the real portal. */
function makePortal(scenario) {
  const state = { actions: [], creates: 0, tripOptions: 0, bodies: [], finished: false, releaseOptions: null };
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    state.actions.push(body.action);
    if (process.env.KFM_QA_DEBUG) console.error("[qa action]", body.action);
    if (body.action === "list") return json({ success: true, orders: [ORDER] });
    if (body.action === "trip-options") {
      state.tripOptions += 1;
      assert.equal(body.unifiedPrint, true);
      if (scenario === "busy") await new Promise((resolve) => { state.releaseOptions = resolve; });
      if (scenario === "fixed") {
        return json({
          success: true, revision: "review-1", fleet: FLEET, pendingChangeCategories: [],
          options: { deliveryType: "FIXED", vehicleTypes: [{ id: 1, name: "Xe tải" }], vehicleTypeId: 1, slots: [
            { value: "08:00-09:00", available: true },
            { value: "09:00-10:00", available: true },
            { value: "10:00-11:00", available: false },
          ] },
          draft: { stops: [{ items: ITEMS }] },
        });
      }
      return json({
        success: true, revision: "review-1", fleet: FLEET, pendingChangeCategories: [],
        options: { deliveryType: null, vehicleTypes: [{ id: 1, name: "Xe tải" }], vehicleTypeId: 1, slots: [] },
        draft: { stops: [{ items: ITEMS }] },
      });
    }
    if (body.action === "create-load") {
      state.creates += 1;
      state.bodies.push(body);
      assert.equal(body.unifiedPrint, true);
      assert.equal(body.confirmed, true);
      assert.equal(body.revision, "review-1");
      assert.ok(body.requestId, "each write must carry a requestId");
      await new Promise((r) => setTimeout(r, 20));
      return json({ success: true, existingNotes: [{ asnId: 55, asnCode: "ASN-QA" }] });
    }
    if (body.action === "asn-pdf" || body.action === "load-pdf") {
      assert.equal(body.layout, "NO_PRICE");
      state.finished = true;
      return json({ success: true, base64: Buffer.from("%PDF-1.4\n%%EOF").toString("base64"), filename: "PhieuGiaoHang_QA.pdf" });
    }
    throw new Error("Unexpected portal action in regression QA: " + body.action);
  };
  return state;
}

async function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(
      React.createElement(QueryClientProvider, { client },
        React.createElement(MemoryRouter, null, React.createElement(Panel, { isVi: true }))),
    );
  });
  return { container, root };
}

async function unmount(container, root) {
  await act(async () => { root.unmount(); });
  container.remove();
  globalThis.fetch = undefined;
}

const groups = (c) => [...c.querySelectorAll("[data-kfm-time-select]")];
const part = (group, name) => group.querySelector(`[data-kfm-time-part="${name}"]`);
const submitOf = (c) => c.querySelector('[data-kfm-action="submit-create"]');

async function openTimeForm(container) {
  const asn = await waitFor(() => container.querySelector('[data-kfm-action="print-asn"]:not([disabled])'), "print-asn button");
  await click(asn);
  return waitFor(() => {
    const panel = container.querySelector("[data-kfm-create]");
    return panel && submitOf(panel) ? panel : null;
  }, "create form");
}

const results = [];

try {
  // --- helper contract: empty/partial never invents the missing half --------
  assert.deepEqual(KFM_HOURS, Array.from({ length: 24 }, (_, i) => String(i).padStart(2, "0")));
  assert.deepEqual(KFM_MINUTES, Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0")));
  assert.deepEqual(splitKfmTime("08:30"), { hour: "08", minute: "30" });
  assert.deepEqual(splitKfmTime("08:"), { hour: "08", minute: "" });
  assert.deepEqual(splitKfmTime(":30"), { hour: "", minute: "30" });
  assert.deepEqual(splitKfmTime(""), { hour: "", minute: "" });
  assert.equal(joinKfmTime("", ""), "");
  assert.equal(joinKfmTime("08", ""), "08:");
  assert.equal(joinKfmTime("", "30"), ":30");
  assert.equal(joinKfmTime("08", "30"), "08:30");
  for (const ok of ["00:00", "08:30", "23:59"]) assert.equal(isCompleteKfmTime(ok), true, ok);
  for (const bad of ["", "08:", ":30", "8:30", "24:00", "08:60", "aa:bb"]) assert.equal(isCompleteKfmTime(bad), false, bad);

  // --- A. validation, payload, duplicate guard ------------------------------
  {
    const state = makePortal("time");
    const { container, root: app } = await mount();
    try {
      const panel = await openTimeForm(container);

      // No native time control remains; two explicit hour+minute groups.
      assert.equal(panel.querySelectorAll('input[type="time"]').length, 0, "native time input must be gone");
      const ui = groups(panel);
      assert.equal(ui.length, 2, "from and to windows");
      assert.deepEqual(ui[0].querySelectorAll("select").length, 2);
      assert.deepEqual([...part(ui[0], "hour").options].map((o) => o.value), ["", ...KFM_HOURS]);
      assert.deepEqual([...part(ui[0], "minute").options].map((o) => o.value), ["", ...KFM_MINUTES]);

      // Unique accessible labels + 44px / shrinkable layout contract.
      const labels = ui.flatMap((g) => [...g.querySelectorAll("select")].map((s) => s.getAttribute("aria-label")));
      assert.equal(labels.length, 4);
      assert.ok(labels.every((l) => l && l.trim().length > 3), JSON.stringify(labels));
      assert.equal(new Set(labels).size, 4, "labels must be unique: " + JSON.stringify(labels));
      for (const g of ui) {
        for (const name of ["hour", "minute"]) {
          assert.ok(part(g, name).className.includes("min-h-11"), `${name} must be a 44px target`);
          assert.ok(part(g, name).className.includes("flex-1"), `${name} must shrink inside 320px`);
        }
        assert.ok(g.querySelector("div.flex").className.includes("min-w-0"), "time row must not overflow");
      }

      const submit = submitOf(panel);
      assert.equal(submit.disabled, true, "empty window blocks submit");
      assert.equal(state.creates, 0);

      // Partial, hour first.
      await setSelect(part(ui[0], "hour"), "08");
      assert.equal(part(ui[0], "hour").value, "08");
      assert.equal(part(ui[0], "minute").value, "");
      assert.equal(submitOf(panel).disabled, true, "hour-only stays incomplete");
      assert.equal(state.creates, 0, "no implicit write on select");

      // Partial, minute added; the "to" window is still empty.
      await setSelect(part(ui[0], "minute"), "30");
      assert.equal(submitOf(panel).disabled, true, "half-open window stays incomplete");
      assert.equal(state.creates, 0, "no implicit write on select");

      // "to" changed minute-first then hour; reverse window rejected.
      await setSelect(part(ui[1], "minute"), "45");
      await setSelect(part(ui[1], "hour"), "07");
      assert.equal(part(ui[1], "hour").value, "07");
      assert.equal(part(ui[1], "minute").value, "45");
      assert.equal(submitOf(panel).disabled, true, "08:30 -> 07:45 must be rejected");
      assert.equal(state.creates, 0);

      // Equal window rejected.
      await setSelect(part(ui[1], "hour"), "08");
      await setSelect(part(ui[1], "minute"), "30");
      assert.equal(submitOf(panel).disabled, true, "equal window must be rejected");
      assert.equal(state.creates, 0);

      // Valid window accepted; still nothing written until the operator submits.
      await setSelect(part(ui[1], "hour"), "09");
      assert.equal(part(ui[1], "minute").value, "30");
      assert.equal(submitOf(panel).disabled, false, "08:30 -> 09:30 must be valid");
      assert.equal(state.creates, 0, "validation itself must not write");

      // Double click: exactly one write.
      await act(async () => {
        const button = submitOf(container);
        button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
        button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 40));
      });
      await waitFor(() => state.finished, "print after one write");
      assert.equal(state.creates, 1, "duplicate clicks must not create twice");
      assert.deepEqual(state.actions, ["list", "trip-options", "create-load", "asn-pdf"]);

      const form = state.bodies[0].form;
      assert.equal(form.expectedTimeFrom, "08:30");
      assert.equal(form.expectedTimeTo, "09:30");
      assert.match(form.expectedTimeFrom, /^\d{2}:\d{2}$/);
      assert.match(form.expectedTimeTo, /^\d{2}:\d{2}$/);
      results.push({ scenario: "validation-payload-duplicate", actions: state.actions, payload: { from: form.expectedTimeFrom, to: form.expectedTimeTo } });
    } finally {
      await unmount(container, app);
    }
  }

  // --- B. minute chosen before hour on the "from" field ---------------------
  {
    const state = makePortal("time");
    const { container, root: app } = await mount();
    try {
      const panel = await openTimeForm(container);
      const ui = groups(panel);
      await setSelect(part(ui[0], "minute"), "45");
      await setSelect(part(ui[0], "hour"), "07");
      await setSelect(part(ui[1], "hour"), "09");
      await setSelect(part(ui[1], "minute"), "00");
      assert.equal(submitOf(panel).disabled, false, "07:45 -> 09:00 must be valid");
      await click(submitOf(panel));
      await waitFor(() => state.finished, "print after write");
      const form = state.bodies[0].form;
      assert.equal(form.expectedTimeFrom, "07:45");
      assert.equal(form.expectedTimeTo, "09:00");
      results.push({ scenario: "minute-first-order", payload: { from: form.expectedTimeFrom, to: form.expectedTimeTo } });
    } finally {
      await unmount(container, app);
    }
  }

  // --- C. FIXED booking-slot path preserved ---------------------------------
  {
    const state = makePortal("fixed");
    const { container, root: app } = await mount();
    try {
      const panel = await openTimeForm(container);
      assert.equal(groups(panel).length, 0, "FIXED delivery must not show a time window");
      const slot = panel.querySelector('[data-kfm-field="slot"]');
      assert.ok(slot, "booking slot select preserved");
      assert.equal(slot.options.length, 4, "placeholder + 3 slots");
      assert.equal(slot.options[3].disabled, true, "unavailable slot stays disabled");
      assert.equal(submitOf(panel).disabled, true, "slot still required");
      await setSelect(slot, "08:00-09:00");
      assert.equal(submitOf(panel).disabled, false);
      assert.equal(state.creates, 0, "choosing a slot must not write");
      await click(submitOf(panel));
      await waitFor(() => state.finished, "print after slot write");
      assert.equal(state.creates, 1);
      assert.equal(state.bodies[0].form.bookingTimeSlot, "08:00-09:00");
      assert.equal(state.bodies[0].form.expectedTimeFrom, "", "slot path must not invent a time window");
      assert.deepEqual(state.actions, ["list", "trip-options", "create-load", "asn-pdf"]);
      results.push({ scenario: "fixed-slot-preserved", actions: state.actions });
    } finally {
      await unmount(container, app);
    }
  }

  // --- D. slow options call: repeated clicks stay guarded, actions disabled --
  {
    const state = makePortal("busy");
    const { container, root: app } = await mount();
    try {
      const asn = await waitFor(() => container.querySelector('[data-kfm-action="print-asn"]:not([disabled])'), "print-asn button");
      await act(async () => {
        asn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
        asn.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
        await new Promise((r) => setTimeout(r, 0));
      });
      assert.equal(state.tripOptions, 1, "repeated clicks must not double-fetch options");
      assert.equal(container.querySelector('[data-kfm-action="print-asn"]').disabled, true, "actions disabled while options load");
      await act(async () => { state.releaseOptions(); await new Promise((r) => setTimeout(r, 0)); });
      await waitFor(() => submitOf(container), "form after release");
      assert.equal(state.creates, 0);
      results.push({ scenario: "busy-guard", tripOptions: state.tripOptions, actions: state.actions });
    } finally {
      await unmount(container, app);
    }
  }

  fs.writeFileSync(path.join(out, "qa-time-results.json"), JSON.stringify({ results }, null, 2));
  console.log(`PASS ${results.length} KFM time-select scenarios -> ${out}`);
} catch (error) {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
} finally {
  // Vite's esbuild service can keep the event loop alive after a successful run.
  await Promise.race([server.close().catch(() => {}), new Promise((resolve) => setTimeout(resolve, 3000))]);
  process.exit(process.exitCode || 0);
}
