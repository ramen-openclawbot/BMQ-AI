import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const { chromium } = await import(process.env.BMQ_PLAYWRIGHT || '/home/ubuntu/bmq-payment-preview/node_modules/playwright/index.mjs');
const origin = 'http://127.0.0.1:4197', out = '/tmp/bmq-i18n-bcd-qa';
const browser = await chromium.launch({ executablePath: process.env.BMQ_CHROMIUM || '/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux/chrome', args: ['--no-sandbox'] });
const unexpected = [], errors = [], cases = [];
const visible = locator => locator.filter({ visible: true });
const button = (p, name) => visible(p.getByRole('button', { name, exact: true }));
const labels = {
 en: { title: 'Accounts payable management', markPaid: 'Mark paid', recorded: 'Payable payment recorded', search: 'Search supplier, payable code, goods receipt, PO', empty: 'No payables match the current filters.', error: 'Unable to load accounts payable: SERVER giữ nguyên $&', partial: 'Partially paid', all: 'All payments' },
 vi: { title: 'Quản lý công nợ phải trả', markPaid: 'Đã trả', recorded: 'Đã ghi nhận thanh toán công nợ', search: 'Tìm nhà cung cấp, mã công nợ, phiếu nhập kho, PO', empty: 'Không có công nợ phải trả phù hợp bộ lọc hiện tại.', error: 'Không đọc được dữ liệu công nợ phải trả: SERVER giữ nguyên $&', partial: 'Thanh toán một phần', all: 'Tất cả thanh toán' },
};
async function setup(lang, width, mode = 'data') {
 const c = await browser.newContext({ viewport: { width, height: 1000 } });
 await c.addInitScript(lang => { if (!sessionStorage.getItem('initialized')) { localStorage.setItem('app-language', lang); sessionStorage.setItem('initialized', '1'); } }, lang);
 await c.route('**/*', r => { const u = r.request().url(); if (u.startsWith(`${origin}/`)) return r.continue(); if (u.startsWith('https://fonts.googleapis.com/')) return r.fulfill({ body: '', contentType: 'text/css' }); unexpected.push(u); return r.abort(); });
 const p = await c.newPage(); p.setDefaultTimeout(8000); p.on('pageerror', e => errors.push(e.message));
 await p.goto(`${origin}/finance-control/payables?fixture=${mode}&readonly=${mode === 'readonly' ? 1 : 0}`); return { c, p };
}
for (const lang of ['en', 'vi']) for (const width of [390, 1440]) test(`payables ${lang} ${width} actual hook, calculations, filters, switch/reload and exact allocation payload`, async () => {
 const { c, p } = await setup(lang, width), l = labels[lang], other = lang === 'en' ? 'vi' : 'en';
 try {
  await p.getByRole('heading', { name: l.title, exact: true }).waitFor(); await p.getByText('QA-PR-1', { exact: true }).waitFor();
  const text = await p.locator('body').innerText(); for (const amount of ['45.000 đ', '10.000 đ', '30.000 đ']) assert.ok(text.includes(amount), amount);
  await p.getByPlaceholder(l.search).fill('nha cung cap giu nguyen'); assert.equal(await p.getByText('QA-PR-2', { exact: true }).count(), 0);
  await button(p, other.toUpperCase()).click(); await p.getByRole('heading', { name: labels[other].title, exact: true }).waitFor();
  assert.equal(await p.getByPlaceholder(labels[other].search).inputValue(), 'nha cung cap giu nguyen');
  await button(p, labels[other].markPaid).click(); await p.getByText(labels[other].recorded, { exact: true }).waitFor();
  const calls = await p.evaluate(() => window.__fixtureCalls.filter(c => c.rpc)); const date = await p.evaluate(() => new Date().toISOString().slice(0, 10));
  assert.deepEqual(calls, [{ rpc: 'record_payment_allocations', args: { p_allocations: [{ payment_request_id: 'pr-1', amount: 10000 }], p_payment_method: 'cash', p_payment_date: date, p_reference_number: null, p_notes: null } }]);
  await p.reload(); await p.getByRole('heading', { name: labels[other].title, exact: true }).waitFor(); await button(p, lang.toUpperCase()).click();
  await p.getByRole('combobox').first().click(); await p.getByRole('option', { name: l.partial, exact: true }).click();
  await p.getByText('QA-PR-1', { exact: true }).waitFor(); assert.equal(await p.getByText('QA-PR-2', { exact: true }).count(), 0);
  await p.getByPlaceholder(l.search).fill('no matching supplier'); await p.getByText(l.empty, { exact: true }).waitFor();
  await p.screenshot({ path: `${out}/payables-${lang}-${width}.png`, fullPage: true });
  cases.push({ id: `payables-${lang}-${width}`, passed: true, files: ['src/pages/PayablesManagement.tsx', 'src/hooks/usePaymentRequests.ts'], states: ['data', 'calculations', 'normalized search', 'status filter', 'empty search', 'allocation payload', 'switch', 'reload'], limitation: 'Nested dialogs not exercised' });
 } finally { await c.close(); }
});
for (const width of [390, 1440]) for (const lang of ['en', 'vi']) test(`payables ${lang} ${width} loading/error/empty/readonly`, async () => {
 for (const mode of ['empty', 'error', 'loading', 'readonly', 'save-error']) {
  const { c, p } = await setup(lang, width, mode);
  try {
   if (mode === 'error' || mode === 'empty') { await p.getByText(labels[lang][mode], { exact: true }).waitFor(); const other = lang === 'en' ? 'vi' : 'en'; await button(p, other.toUpperCase()).click(); await p.getByText(labels[other][mode], { exact: true }).waitFor(); }
   else if (mode === 'loading') await p.locator('.animate-pulse').first().waitFor();
   else { await p.getByText('QA-PR-1', { exact: true }).waitFor(); if (mode === 'readonly') assert.equal(await button(p, labels[lang].markPaid).count(), 0); else { await button(p, labels[lang].markPaid).click(); await p.getByText('SERVER giữ nguyên $&', { exact: true }).waitFor(); } }
   cases.push({ id: `payables-${lang}-${width}-${mode}`, passed: true, files: ['src/pages/PayablesManagement.tsx'], kind: 'actual-component synthetic fixture' });
  } finally { await c.close(); }
 }
});
test.after(async () => { await browser.close(); await fs.writeFile(`${out}/payables-browser.json`, JSON.stringify({ cases, unexpected, errors }, null, 2)); assert.deepEqual(unexpected, []); assert.deepEqual(errors, []); });
