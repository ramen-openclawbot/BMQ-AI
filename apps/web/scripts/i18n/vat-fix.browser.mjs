import test from 'node:test';
import assert from 'node:assert/strict';

const { chromium } = await import(process.env.BMQ_PLAYWRIGHT || '/home/ubuntu/bmq-payment-preview/node_modules/playwright/index.mjs');
const browser = await chromium.launch({
  executablePath: process.env.BMQ_CHROMIUM || '/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux/chrome',
  args: ['--no-sandbox'],
});
const origin = 'http://127.0.0.1:4300';
const pageErrors = [];
const unexpectedRequests = [];

async function setup(mode = 'data') {
  const context = await browser.newContext({ viewport: { width: 390, height: 1000 } });
  await context.addInitScript(() => localStorage.setItem('app-language', 'en'));
  await context.route('**/*', route => {
    const request = route.request();
    const url = request.url();
    if (url.startsWith(origin + '/') && ['GET', 'HEAD'].includes(request.method()) && !['fetch', 'xhr'].includes(request.resourceType())) return route.continue();
    if (url.startsWith('https://fonts.googleapis.com/')) return route.fulfill({ body: '', contentType: 'text/css' });
    unexpectedRequests.push(url);
    return route.abort();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`${origin}/invoices?fixture=${mode}`);
  await page.getByRole('heading').first().waitFor();
  return { context, page };
}

async function fillRequiredInvoiceFields(page) {
  await page.getByPlaceholder('e.g., INV-001').fill('VAT-BOUNDARY');
  await page.getByPlaceholder('Product name', { exact: true }).fill('VAT test item');
  await page.getByLabel('Quantity', { exact: true }).fill('2');
  await page.getByLabel('Unit Price', { exact: true }).fill('10000');
}

test('typed decimal VAT previews and submits numeric direct-invoice totals', async () => {
  const { context, page } = await setup();
  try {
    await page.getByRole('button', { name: 'Add Invoice', exact: true }).click();
    await fillRequiredInvoiceFields(page);
    await page.getByLabel('VAT Amount (VND)', { exact: true }).fill('2000.5');
    await page.getByText('22.000,5 VND', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Create Invoice', exact: true }).click();
    await page.waitForFunction(() => window.__fixtureCalls.some(call => call.rpc === 'create_invoice_with_material_controller'));
    const call = await page.evaluate(() => window.__fixtureCalls.find(entry => entry.rpc === 'create_invoice_with_material_controller'));
    assert.equal(call.args.p_parent.subtotal, 20000);
    assert.equal(call.args.p_parent.vat_amount, 2000.5);
    assert.equal(call.args.p_parent.total_amount, 22000.5);
  } finally {
    await context.close();
  }
});

test('typed decimal VAT submits numeric linked-request RPC value', async () => {
  const { context, page } = await setup('uninvoiced');
  try {
    await page.getByRole('button', { name: 'Add Invoice', exact: true }).click();
    await page.getByRole('combobox').filter({ hasText: 'No link' }).click();
    await page.getByRole('option', { name: /QA-PR-1/ }).click();
    await page.getByLabel('VAT Amount (VND)', { exact: true }).fill('0.5');
    await page.getByText('20.000,5 VND', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Create Invoice', exact: true }).click();
    await page.waitForFunction(() => window.__fixtureCalls.some(call => call.rpc === 'create_invoice_from_payment_request'));
    const call = await page.evaluate(() => window.__fixtureCalls.find(entry => entry.rpc === 'create_invoice_from_payment_request'));
    assert.equal(call.args.p_vat_amount, 0.5);
  } finally {
    await context.close();
  }
});

test('typed zero VAT remains numeric and does not change direct-invoice total', async () => {
  const { context, page } = await setup();
  try {
    await page.getByRole('button', { name: 'Add Invoice', exact: true }).click();
    await fillRequiredInvoiceFields(page);
    await page.getByLabel('VAT Amount (VND)', { exact: true }).fill('0');
    await page.getByText('20.000 VND', { exact: true }).last().waitFor();
    await page.getByRole('button', { name: 'Create Invoice', exact: true }).click();
    await page.waitForFunction(() => window.__fixtureCalls.some(call => call.rpc === 'create_invoice_with_material_controller'));
    const call = await page.evaluate(() => window.__fixtureCalls.find(entry => entry.rpc === 'create_invoice_with_material_controller'));
    assert.equal(call.args.p_parent.vat_amount, 0);
    assert.equal(call.args.p_parent.total_amount, 20000);
  } finally {
    await context.close();
  }
});

test.after(async () => {
  await browser.close();
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(unexpectedRequests, []);
});
