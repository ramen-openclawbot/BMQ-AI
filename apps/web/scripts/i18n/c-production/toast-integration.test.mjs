import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from '/home/ubuntu/projects/rental-vnagent/node_modules/jsdom/lib/api.js';

const harness = `/tmp/c-production-toast-harness-${process.pid}.tsx`;
const bundle = `/tmp/c-production-toast-harness-${process.pid}.mjs`;
fs.writeFileSync(harness, `
  import React, { act } from 'react';
  import { createRoot } from 'react-dom/client';
  import { toast as sonnerToast } from 'sonner';
  import { LanguageProvider, useLanguage } from '${process.cwd()}/src/contexts/LanguageContext.tsx';
  import { Toaster } from '${process.cwd()}/src/components/ui/sonner.tsx';
  import { productionErrorToast, localProductionErrorForToast } from '${process.cwd()}/src/i18n/ProductionErrorToast.tsx';
  let pending;
  function Controls() { const { language, setLanguage } = useLanguage(); return <>
    <button id="toggle" onClick={() => setLanguage(language === 'vi' ? 'en' : 'vi')}>toggle</button>
    <button id="prepare" onClick={() => { pending = localProductionErrorForToast('m122'); }}>prepare</button>
    <button id="pending" onClick={() => productionErrorToast('material-mutation', pending)}>pending</button>
    <button id="backend" onClick={() => productionErrorToast('material-mutation', new Error('Không thể lưu thay đổi'))}>backend</button>
    <button id="unknown" onClick={() => productionErrorToast('material-mutation', { opaque: true })}>unknown</button>
    <button id="nested" onClick={() => productionErrorToast('material-mutation', new Error('wrapper', { cause: localProductionErrorForToast('m122') }))}>nested</button>
  </>; }
  export async function mount(container) { const root = createRoot(container); await act(async () => { root.render(<LanguageProvider><Controls/><Toaster/></LanguageProvider>); }); return { click: async id => act(async () => { document.getElementById(id).click(); await new Promise(r => setTimeout(r, 300)); }), cleanup: async () => { sonnerToast.dismiss(); await new Promise(r => setTimeout(r, 500)); await act(async () => root.unmount()); } }; }
`);
await build({ entryPoints: [harness], outfile: bundle, bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', logLevel: 'silent', nodePaths: [`${process.cwd()}/node_modules`] });

function installDom(language = 'vi') {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost' });
  Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle, requestAnimationFrame: cb => setTimeout(cb, 0), cancelAnimationFrame: clearTimeout, IS_REACT_ACT_ENVIRONMENT: true });
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  document.hasFocus = () => true;
  window.matchMedia ||= () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  globalThis.ResizeObserver ||= class { observe() {} unobserve() {} disconnect() {} };
  localStorage.setItem('app-language', language);
  return dom;
}

const bodyText = () => document.body.textContent || '';
const waitForText = async (pattern) => {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if (pattern.test(bodyText())) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.match(bodyText(), pattern);
};

test('scoped direct dispatch reaches mounted Sonner and stays language-reactive', async () => {
  const dom = installDom('vi');
  const { mount } = await import(pathToFileURL(bundle).href);
  const app = await mount(document.getElementById('root'));

  await app.click('prepare');
  await app.click('toggle');
  await app.click('pending');
  await waitForText(/Unable to save changes/);
  await waitForText(/The system rejected an invalid operation/);

  await app.click('toggle');
  await waitForText(/Không thể lưu thay đổi/);
  await waitForText(/Hệ thống đã từ chối thao tác không hợp lệ/);

  await app.click('backend');
  await app.click('toggle');
  await waitForText(/Không thể lưu thay đổi/);

  await app.click('unknown');
  await waitForText(/The system rejected an invalid operation/);
  await app.click('nested');
  await waitForText(/The system rejected an invalid operation/);

  await app.cleanup();
  dom.window.close();
  assert.equal(document.querySelector('[data-production-error-toast]'), null, 'production toast DOM unmounted during cleanup');
});

test('AppInner mounts Sonner without a legacy toast bridge or legacy Toaster', () => {
  const source = fs.readFileSync('src/AppInner.tsx', 'utf8');
  assert.match(source, /components\/ui\/sonner/);
  assert.doesNotMatch(source, /ProductionToastAdapter/);
  assert.doesNotMatch(source, /components\/ui\/toaster/);
});
