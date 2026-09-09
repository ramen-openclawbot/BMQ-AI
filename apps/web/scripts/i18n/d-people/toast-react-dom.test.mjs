import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { JSDOM } from "/home/ubuntu/projects/rental-vnagent/node_modules/jsdom/lib/api.js";

const harness = `/tmp/d-people-toast-harness-${process.pid}.tsx`;
const bundle = `/tmp/d-people-toast-harness-${process.pid}.mjs`;
fs.writeFileSync(harness, `
  import React, { act } from "react";
  import { createRoot } from "react-dom/client";
  import { toast } from "sonner";
  import { LanguageProvider, useLanguage } from "${process.cwd()}/src/contexts/LanguageContext.tsx";
  import { Toaster } from "${process.cwd()}/src/components/ui/sonner.tsx";
  import { PeopleLocalError, peopleErrorDescription, peopleSupabaseErrorDescription, peopleToast, showPeopleToast } from "${process.cwd()}/src/hooks/usePeopleCopy.ts";
  import { SessionExpiredError } from "${process.cwd()}/src/lib/session-errors.ts";
  let pending;
  function Controls() { const { language, setLanguage } = useLanguage(); return <>
    <button id="toggle" onClick={() => setLanguage(language === "vi" ? "en" : "vi")}>toggle</button>
    <button id="prepare" onClick={() => { pending = new PeopleLocalError({ key: "pleaseTryAgain" }); }}>prepare</button>
    <button id="pending" onClick={() => showPeopleToast("error", peopleToast("unableToDeleteUser"), { description: peopleErrorDescription(pending, "pleaseTryAgain"), duration: Infinity })}>pending</button>
    <button id="visible" onClick={() => showPeopleToast("success", peopleToast("userDeleted"), { description: peopleToast("pleaseTryAgain"), duration: Infinity })}>visible</button>
    <button id="typed-session" onClick={() => showPeopleToast("error", peopleToast("unableToDeleteUser"), { description: peopleSupabaseErrorDescription(new SessionExpiredError(), "pleaseTryAgain"), duration: Infinity })}>typed session</button>
    <button id="backend" onClick={() => showPeopleToast("error", peopleToast("unableToDeleteUser"), { description: peopleSupabaseErrorDescription(new Error("Phiên đăng nhập đã hết hạn. Vui lòng đăng nhập lại."), "pleaseTryAgain"), duration: Infinity })}>backend</button>
    <button id="whitespace" onClick={() => showPeopleToast("error", peopleToast("unableToDeleteUser"), { description: peopleErrorDescription({ message: "   " }, "pleaseTryAgain"), duration: Infinity })}>whitespace</button>
  </>; }
  export async function mount(container) { const root = createRoot(container); await act(async () => { root.render(<LanguageProvider><Controls/><Toaster/></LanguageProvider>); }); return { click: async id => act(async () => { document.getElementById(id).click(); await new Promise(r => setTimeout(r, 300)); }), cleanup: async () => { toast.dismiss(); await new Promise(r => setTimeout(r, 500)); await act(async () => root.unmount()); } }; }
`);
await build({ entryPoints: [harness], outfile: bundle, bundle: true, platform: "node", format: "esm", jsx: "automatic", logLevel: "silent", nodePaths: [`${process.cwd()}/node_modules`] });

function installDom(language = "vi") {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: "http://localhost" });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle, requestAnimationFrame: cb => setTimeout(cb, 0), cancelAnimationFrame: clearTimeout, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, "navigator", { value: dom.window.navigator, configurable: true });
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  document.hasFocus = () => true;
  window.matchMedia ||= () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  globalThis.ResizeObserver ||= class { observe() {} unobserve() {} disconnect() {} };
  localStorage.setItem("app-language", language);
  return dom;
}
const bodyText = () => document.body.textContent || "";
const waitForText = async pattern => { const deadline = Date.now() + 2000; while (Date.now() < deadline) { if (pattern.test(bodyText())) return; await new Promise(r => setTimeout(r, 50)); } assert.match(bodyText(), pattern); };

test("actual LanguageProvider and mounted Sonner keep pending and visible toast content reactive", async () => {
  const dom = installDom("vi");
  const { mount } = await import(pathToFileURL(bundle).href);
  const app = await mount(document.getElementById("root"));
  await app.click("prepare");
  await app.click("toggle");
  await app.click("pending");
  await waitForText(/Unable to delete user/);
  await waitForText(/Please try again/);
  await app.click("toggle");
  await waitForText(/Lỗi xoá người dùng/);
  await waitForText(/Vui lòng thử lại/);
  await app.click("visible");
  await waitForText(/Đã xoá người dùng/);
  await app.click("toggle");
  await waitForText(/User deleted/);
  await app.click("backend");
  await app.click("toggle");
  await waitForText(/Phiên đăng nhập đã hết hạn\. Vui lòng đăng nhập lại\./);
  await app.click("typed-session");
  await app.click("toggle");
  await waitForText(/Your session has expired\. Please sign in again\./);
  await app.click("whitespace");
  await waitForText(/Please try again/);
  await app.click("toggle");
  await waitForText(/Vui lòng thử lại/);
  await waitForText(/Phiên đăng nhập đã hết hạn\. Vui lòng đăng nhập lại\./);
  await app.cleanup();
  assert.equal(document.querySelector("[data-sonner-toaster]"), null, "Sonner DOM unmounted during cleanup");
  dom.window.close();
});

test("six converted consumers dispatch through Sonner, not the legacy toast store", () => {
  const paths = ["pages/AttendanceManagement.tsx", "pages/PayrollManagement.tsx", "pages/UserManagement.tsx", "components/attendance/ShiftPlannerGrid.tsx", "components/settings/DataMigrationSettings.tsx", "hooks/useUserManagement.ts"];
  for (const path of paths) {
    const source = fs.readFileSync(`src/${path}`, "utf8");
    assert.match(source, /showPeopleToast/, path);
    assert.doesNotMatch(source, /@\/hooks\/use-toast/, path);
  }
});
