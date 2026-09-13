import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const { chromium } = await import(process.env.BMQ_PLAYWRIGHT || '/home/ubuntu/bmq-payment-preview/node_modules/playwright/index.mjs');
const origin = 'http://127.0.0.1:4197';
const out = '/tmp/bmq-i18n-bcd-qa';
await fs.mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.BMQ_CHROMIUM || '/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux/chrome', args: ['--no-sandbox'] });
const unexpected = [], errors = [], cases = [];
const visible = locator => locator.filter({ visible: true });
const button = (p, name) => visible(p.getByRole('button', { name, exact: true }));
async function setup(lang, width, mode = 'data', readonly = false) {
  const context = await browser.newContext({ viewport: { width, height: 1000 } });
  await context.addInitScript(lang => {
    if (!sessionStorage.getItem('fixture-initialized')) {
      localStorage.setItem('app-language', lang);
      sessionStorage.setItem('fixture-initialized', '1');
    }
  }, lang);
  await context.route('**/*', route => {
    const url = route.request().url();
    if (url.startsWith(`${origin}/`)) return route.continue();
    if (url.startsWith('https://fonts.googleapis.com/')) return route.fulfill({ body: '', contentType: 'text/css' });
    unexpected.push(url); return route.abort();
  });
  const p = await context.newPage(); p.setDefaultTimeout(6000); p.on('pageerror', e => errors.push(e.message));
  await p.goto(`${origin}/finance-control/revenue/daily-review?fixture=${mode}&readonly=${readonly ? 1 : 0}`);
  return { p, context };
}
const copy = {
  en: { title: 'Revenue Daily Review', save: 'Save', exception: 'Exception', saved: 'Changes saved', invalid: 'Invalid amount', next: 'Next page', source: 'Source', error: 'Unable to load revenue drafts.', empty: 'No drafts to review for these filters.' },
  vi: { title: 'Kiểm tra doanh thu hằng ngày', save: 'Lưu', exception: 'Ngoại lệ', saved: 'Đã lưu chỉnh sửa', invalid: 'Số tiền không hợp lệ', next: 'Trang sau', source: 'Nguồn', error: 'Không tải được revenue drafts.', empty: 'Không có draft cần kiểm tra cho bộ lọc này.' },
};
for (const lang of ['en', 'vi']) for (const width of [390, 1440]) {
  const id = `revenue-daily-${lang}-${width}`;
  test(`${id}: actual component filters, pagination, calculations, edit payload, reactive switch and reload`, async () => {
    const { p, context } = await setup(lang, width); const c = copy[lang];
    try {
      await p.getByRole('heading', { name: c.title, exact: true }).waitFor();
      await visible(p.getByText('Khách hàng giữ nguyên 0', { exact: true })).waitFor();
      assert.ok((await p.locator('body').innerText()).includes('315.210'), 'sum of 21 pending rows remains exact');
      await button(p, c.next).click(); await visible(p.getByText('Khách hàng giữ nguyên 20', { exact: true })).waitFor();
      await p.locator('#review-customer').fill('Khách hàng giữ nguyên 0');
      const amount = width === 390 ? visible(p.locator('input[inputmode="decimal"]')).first() : visible(p.locator('input.w-40')).first();
      await amount.fill('-1'); await button(p, c.save).click(); await p.getByText(c.invalid, { exact: true }).waitFor();
      assert.deepEqual(await p.evaluate(() => window.__fixtureCalls.filter(c => c.rpc)), []);
      await amount.fill('12,345');
      const note = width === 390 ? visible(p.locator('textarea')).first() : visible(p.locator('input.w-64')).first();
      await note.fill('Ghi chú $& {amount} giữ nguyên');
      const other = lang === 'en' ? 'vi' : 'en';
      await button(p, other.toUpperCase()).click();
      await p.getByRole('heading', { name: copy[other].title, exact: true }).waitFor();
      assert.equal(await amount.inputValue(), '12,345'); assert.equal(await note.inputValue(), 'Ghi chú $& {amount} giữ nguyên');
      await button(p, copy[other].save).click(); await p.getByText(copy[other].saved, { exact: true }).waitFor();
      await button(p, copy[other].exception).click();
      const calls = await p.evaluate(() => window.__fixtureCalls.filter(c => c.rpc));
      assert.deepEqual(calls, [false, true].map(flag => ({ rpc: 'edit_revenue_draft_daily_review', args: { _draft_id: 'draft-0', _amount: 12345, _note: 'Ghi chú $& {amount} giữ nguyên', _mark_exception: flag } })));
      await p.reload(); await p.getByRole('heading', { name: copy[other].title, exact: true }).waitFor();
      await button(p, lang.toUpperCase()).click();
      await p.locator('#review-status').selectOption('exception');
      await visible(p.getByText('Khách hàng giữ nguyên 21', { exact: true })).waitFor();
      assert.ok((await p.locator('body').innerText()).includes('15.021'));
      const query = await p.evaluate(() => window.__fixtureCalls.filter(c => c.table).at(-1));
      assert.deepEqual(query.operations.at(-1), { method: 'eq', args: ['status', 'exception'] });
      await p.screenshot({ path: `${out}/${id}.png`, fullPage: true });
      cases.push({ id, passed: true, files: ['src/pages/RevenueDailyReview.tsx'], states: ['data', 'pagination', 'filters', 'invalid amount', 'save', 'exception', 'switch during edit', 'reload'], kind: 'actual-component synthetic fixture' });
    } finally { await context.close(); }
  });
  test(`${id}: empty, error, loading, readonly and verbatim server error`, async () => {
    for (const mode of ['empty', 'error', 'loading', 'save-error', 'readonly']) {
      const { p, context } = await setup(lang, width, mode, mode === 'readonly');
      try {
        await p.getByRole('heading', { name: copy[lang].title, exact: true }).waitFor();
        if (mode === 'empty' || mode === 'error') {
          await p.getByText(copy[lang][mode], { exact: true }).waitFor();
          const other = lang === 'en' ? 'vi' : 'en'; await button(p, other.toUpperCase()).click(); await p.getByText(copy[other][mode], { exact: true }).waitFor();
        } else if (mode === 'loading') {
          await p.locator('.animate-spin').waitFor(); assert.equal(await button(p, copy[lang].save).count(), 0);
        } else if (mode === 'readonly') {
          await button(p, copy[lang].save).first().waitFor(); assert.equal(await button(p, copy[lang].save).first().isDisabled(), true);
        } else {
          await button(p, copy[lang].save).first().click(); await p.getByText('SERVER giữ nguyên $&', { exact: true }).waitFor();
        }
        cases.push({ id: `${id}-${mode}`, passed: true, files: ['src/pages/RevenueDailyReview.tsx'], kind: 'actual-component synthetic fixture' });
      } finally { await context.close(); }
    }
  });
}
test.after(async () => {
  await browser.close();
  await fs.writeFile(`${out}/revenue-daily-browser.json`, JSON.stringify({ cases, unexpected, errors }, null, 2));
  assert.deepEqual(unexpected, []); assert.deepEqual(errors, []);
});
