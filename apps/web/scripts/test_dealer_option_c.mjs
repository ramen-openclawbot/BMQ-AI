/** Render the real dealer route with synthetic API fixtures; never contact production.
 * Start Vite with a local VITE_SUPABASE_URL, then:
 * PLAYWRIGHT_MODULE=/path/to/playwright/index.mjs node scripts/test_dealer_option_c.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.DEALER_QA_URL || 'http://127.0.0.1:4179';
assert.ok(['localhost', '127.0.0.1'].includes(new URL(base).hostname));
const output = process.env.DEALER_QA_OUTPUT || '/tmp/dealer-option-c-qa';
await mkdir(output, { recursive: true });
const customer = { id: 'fixture-dealer', name: 'Đại lý kiểm thử', code: 'QA', is_test: true };
const product = { id: 'fixture-sku', sku_code: 'BMQ-001', product_name: 'Bánh mì que Pate', unit: 'que', price_vnd: 7200 };
const item = { id: 'fixture-item', sku_code: 'BMQ-001', product_name: product.product_name, unit: 'que', ordered_quantity: 120, exchange_quantity: 10, makeup_quantity: 5, physical_quantity: 135, unit_price_vnd: 7200, line_total_vnd: 864000 };
const order = { id: 'fixture-order', order_number: 'QA-OPTION-C', status: 'submitted', currency: 'VND', total_amount_vnd: 864000, submitted_at: '2026-09-08T02:00:00Z', requested_delivery_date: '2026-09-09', physical_quantity: 135, items: [item] };
const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE });
const report = [];
async function fixture(width, authenticated = true, npp = false, duplicate = false, screenshotOrder = false) {
  const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width < 768, hasTouch: width < 768, serviceWorkers: 'block' });
  const calls = [], errors = [], blocked = [];
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.pathname.includes('/functions/v1/')) {
      const name = url.pathname.split('/').pop(), body = request.postDataJSON();
      calls.push({ name, body });
      let data;
      if (name === 'dealer-public-config') data = { success: true, banners: [] };
      else if (name === 'dealer-catalog') data = { success: true, customer, products: [screenshotOrder ? { ...product, price_vnd: 6500 } : product], dealer_routes: npp ? [{ id: 'fixture-route', name: 'Điểm kiểm thử', code: 'QA-NPP' }] : [] };
      else if (name === 'dealer-order-history') data = body.quick_reorder ? { success: true, suggestion: null } : { success: true, orders: [order], exact_order: order, summary: { order_count: 1, total_physical_quantity: 135, total_amount_vnd: 864000 }, pagination: { page: 1, total_pages: 1 } };
      else if (name === 'dealer-order-submit') data = duplicate && !body.duplicate_action ? { success: false, code: 'similar_order_exists', duplicate_order: { order_number: 'QA-PREVIOUS' } } : { success: true, order_number: 'QA-LOCAL-SUBMIT', is_test: true };
      else if (name === 'dealer-auth-start') data = { success: true };
      else if (name === 'dealer-auth-verify') data = { success: true, dealer_token: 'synthetic-session' };
      else throw new Error(`Unmocked API: ${name}`);
      return route.fulfill({ json: data });
    }
    if (url.origin !== new URL(base).origin) { blocked.push(url.origin); return route.abort(); }
    if (url.pathname.startsWith('/api/')) return route.abort();
    if (url.pathname.startsWith('/rest/') || url.pathname.startsWith('/auth/')) return route.fulfill({ json: [] });
    return route.continue();
  });
  if (authenticated) await context.addInitScript(customer => {
    localStorage.setItem('bmq_dealer_session_token', 'synthetic-session');
    localStorage.setItem('bmq_dealer_profile_cache', JSON.stringify({ customer, hasDealerRoutes: false }));
  }, customer);
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/dealer`);
  return { context, page, calls, errors, blocked };
}
async function color(locator, property, expected) {
  assert.equal(await locator.evaluate((node, property) => getComputedStyle(node)[property], property), expected);
}
async function layout(page, label, width) {
  await page.waitForTimeout(250); // Capture the settled Radix opening animation.
  if (label.startsWith('composer-')) await scrollChatToEnd(page);
  const result = await page.evaluate(() => {
    const selectors = ['html', 'body', '.dealer-option-c-workspace', '.dealer-option-c-workspace > main', '[role="dialog"]'];
    return selectors.flatMap(selector => Array.from(document.querySelectorAll(selector)).map(node => ({ selector, width: node.clientWidth, scroll: node.scrollWidth })));
  });
  for (const node of result) assert.ok(node.scroll <= node.width + 1, `${label}/${width}: ${JSON.stringify(node)}`);
  for (const selector of ['.dealer-option-c-workspace', '[data-dealer-agent-nav]', '[data-hallmark-chat-composer]', '[role="dialog"]']) {
    if (!await page.locator(selector).count()) continue;
    const box = await page.locator(selector).first().boundingBox();
    if (box) assert.ok(box.x >= -1 && box.x + box.width <= width + 1, `${label}: ${selector} outside viewport`);
  }
  await page.screenshot({ path: `${output}/${label}-${width}.png` });
}
// Exercise the reachable end of the chat after composer growth/viewport changes.
async function scrollChatToEnd(page) {
  await page.locator('[data-dealer-chat-scroll-content]').evaluateAll(nodes => {
    for (const node of nodes) node.scrollTop = node.scrollHeight;
  });
}
// Measure the actual textarea content box, not just its unclipped outer rectangle.
async function composerMetrics(page) {
  await scrollChatToEnd(page);
  return page.locator('[data-hallmark-chat-composer]').evaluate(parent => {
    const input = parent.querySelector('textarea'), send = parent.querySelector('button');
    const style = getComputedStyle(input), ps = getComputedStyle(parent);
    const rect = node => { const { x, y, width, height } = node.getBoundingClientRect(); return { x, y, width, height }; };
    const canvas = document.createElement('canvas').getContext('2d');
    canvas.font = style.font;
    const button = rect(send);
    const hit = document.elementFromPoint(button.x + button.width / 2, button.y + button.height / 2);
    return {
      parent: rect(parent), input: rect(input), send: button,
      actions: Array.from(document.querySelectorAll('[data-dealer-chat-choice="edit"], [data-dealer-chat-choice="new-order"]')).map(node => {
        const box = rect(node);
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height - 2);
        return { ...box, hit: hit === node || node.contains(hit) };
      }),
      nav: rect(document.querySelector('[data-dealer-agent-nav]')),
      usable: input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      placeholder: canvas.measureText(input.placeholder).width,
      padding: parseFloat(ps.paddingLeft) + parseFloat(ps.paddingRight), gap: parseFloat(ps.columnGap),
      font: parseFloat(style.fontSize), line: parseFloat(style.lineHeight), rows: input.rows,
      value: input.value, scrollHeight: input.scrollHeight, clientHeight: input.clientHeight,
      scrollWidth: input.scrollWidth, clientWidth: input.clientWidth, scrollTop: input.scrollTop,
      overflowY: style.overflowY, hit: hit === send || send.contains(hit),
    };
  });
}
async function composerRegression() {
  const failures = [], measurements = [];
  const check = (condition, label) => { if (!condition) failures.push(label); };
  for (const width of [320, 375, 390, 414, 768, 1440]) {
    const { context, page, calls, errors } = await fixture(width, true, false, false, true);
    await page.locator('[data-dealer-agent-row="order"]').click();
    const input = page.getByPlaceholder('Nhắn BMQ Agent…');
    const send = page.getByRole('button', { name: 'Gửi nội dung đơn', exact: true });
    await input.fill('200');
    await send.click();
    await page.locator('[data-dealer-order-preview-card]').waitFor();
    await input.fill('');
    await input.blur();
    await layout(page, 'composer-blank-order', width);
    const blank = await composerMetrics(page);
    check(blank.usable >= blank.placeholder + 2, `${width}: full placeholder fits usable width`);
    check(blank.input.width >= blank.parent.width - blank.padding - blank.gap - blank.send.width - 3, `${width}: textarea consumes available flex width`);
    check(blank.rows === 1 && blank.input.height <= 48 && blank.parent.height <= 66, `${width}: compact single-line initial composer`);
    check(blank.font === 16, `${width}: input font is 16px`);
    check(Math.abs(blank.input.y + blank.input.height / 2 - blank.send.y - blank.send.height / 2) <= 3, `${width}: blank input and send aligned`);
    const quantity = page.locator('[data-dealer-order-preview-total="quantity"] > div:last-child');
    const typography = await quantity.evaluate(node => ({ size: parseFloat(getComputedStyle(node).fontSize), weight: Number(getComputedStyle(node).fontWeight) }));
    check(typography.size >= 18 && typography.size <= 20 && typography.weight <= 600, `${width}: quantity typography restrained`);
    for (const choice of ['edit', 'new-order']) {
      const action = page.locator(`[data-dealer-chat-choice="${choice}"]`);
      check(await action.evaluate(node => Number(getComputedStyle(node).fontWeight) <= 500), `${width}: ${choice} secondary weight`);
      check((await action.boundingBox()).height >= 44, `${width}: ${choice} touch height`);
    }
    const text = 'Giao 200 que vào sáng mai, gọi trước khi giao. Giữ nguyên nội dung nhập dài này.';
    await input.pressSequentially(text);
    await layout(page, 'composer-long-input', width);
    const long = await composerMetrics(page);
    check(long.value === text && long.scrollWidth <= long.clientWidth + 1 && long.scrollHeight <= long.clientHeight + 1, `${width}: actual typed text retained and visible without clipping`);
    if (width < 768) check(long.input.height > blank.input.height, `${width}: wrapped text grows`);
    await input.fill('Dòng một\nDòng hai\nDòng ba');
    await layout(page, 'composer-multiline', width);
    const multiline = await composerMetrics(page);
    check(multiline.input.height > blank.input.height && multiline.scrollHeight <= multiline.clientHeight + 1, `${width}: explicit multiline grows`);
    await input.fill(Array.from({ length: 12 }, (_, i) => `Dòng ${i + 1}: nội dung được giữ lại`).join('\n'));
    await input.press('Control+End');
    const capped = await composerMetrics(page);
    check(capped.input.height <= 128 && capped.scrollHeight > capped.clientHeight && capped.overflowY === 'auto' && capped.scrollTop > 0, `${width}: max-height scroll exposes final lines`);
    check(capped.value.split('\n').length === 12, `${width}: all multiline content retained`);
    await page.setViewportSize({ width, height: 500 });
    await input.focus();
    await layout(page, 'composer-keyboard-multiline', width);
    const keyboard = await composerMetrics(page);
    const nav = await page.locator('[data-dealer-agent-nav]').boundingBox();
    for (const [state, metric] of Object.entries({ blank, long, multiline, capped, keyboard })) {
      for (const action of metric.actions) {
        check(metric.parent.y - 2 - (action.y + action.height) >= 12, `${width}/${state}: action-to-composer visible gap >=12px (including focus ring)`);
        check(action.hit, `${width}/${state}: final action bottom hitbox unobstructed`);
      }
      check(Math.abs(metric.nav.y - metric.parent.y - metric.parent.height - 16) <= 1, `${width}/${state}: composer retains bottom placement`);
      check(metric.send.width >= 44 && metric.send.height >= 44, `${width}/${state}: send touch target`);
      check(metric.parent.x >= 0 && metric.parent.x + metric.parent.width <= width && metric.parent.y >= 0, `${width}/${state}: parent rectangle in viewport`);
      check(metric.input.x >= metric.parent.x && metric.input.x + metric.input.width <= metric.send.x && metric.send.y >= metric.parent.y && metric.send.y + metric.send.height <= metric.parent.y + metric.parent.height, `${width}/${state}: children contained and non-overlapping`);
      if (state !== 'blank') check(metric.hit, `${width}/${state}: send hitbox unobstructed`);
    }
    check(keyboard.parent.y + keyboard.parent.height <= nav.y + 1, `${width}: multiline composer above nav in reduced viewport`);
    await input.fill('Ngắn');
    const shrunk = await composerMetrics(page);
    check(shrunk.input.height === blank.input.height, `${width}: shrinks after deletion`);
    await input.fill('');
    check((await composerMetrics(page)).input.height === blank.input.height, `${width}: clears to initial height`);
    check(calls.every(call => call.name !== 'dealer-order-submit' && !call.name.startsWith('dealer-auth')), `${width}: composer QA never submits or requests OTP`);
    assert.deepEqual(errors, []);
    measurements.push({ width, blank, long, multiline, capped, keyboard, shrunk, typography });
    await context.close();
  }
  {
    const { context, page, errors } = await fixture(1440);
    await page.locator('[data-dealer-agent-row="order"]').click();
    const input = page.getByPlaceholder('Nhắn BMQ Agent…');
    const value = 'Nội dung giữ nguyên khi đổi chiều rộng màn hình, kiểm tra tự ngắt dòng.';
    await input.fill(value);
    const wide = await composerMetrics(page);
    await page.setViewportSize({ width: 320, height: 844 });
    await layout(page, 'composer-width-change', 320);
    const narrow = await composerMetrics(page);
    check(narrow.value === value && narrow.input.height > wide.input.height && narrow.scrollHeight <= narrow.clientHeight + 1, 'Width change: wraps and grows without editing');
    await page.setViewportSize({ width: 1440, height: 844 });
    await layout(page, 'composer-width-change', 1440);
    const restored = await composerMetrics(page);
    check(restored.value === value && restored.input.height === wide.input.height, 'Width change: shrinks without editing');
    assert.deepEqual(errors, []);
    await context.close();
  }
  await writeFile(`${output}/composer-measurements.json`, JSON.stringify({ failures, measurements }, null, 2));
  assert.deepEqual(failures, [], 'Composer visual regressions');
  report.push({ composerWidths: [320, 375, 390, 414, 768, 1440], passed: true });
}
try {
  await composerRegression();
  for (const width of [320, 375, 390, 414, 768, 1440]) {
    const { context, page, calls, errors, blocked } = await fixture(width);
    await page.locator('[data-dealer-agent-screen="inbox"]').waitFor();
    await color(page.locator('.dealer-option-c'), 'backgroundColor', 'rgb(244, 193, 217)');
    await color(page.locator('.dealer-option-c-workspace'), 'backgroundColor', 'rgb(255, 255, 255)');
    await layout(page, 'inbox', width);
    await page.locator('[data-dealer-agent-row="order"]').click();
    await page.getByPlaceholder('Nhắn BMQ Agent…').fill('120 đổi 10 bù 5');
    await page.getByRole('button', { name: 'Gửi nội dung đơn', exact: true }).click();
    const attachment = page.locator('[data-dealer-order-preview-card]');
    await attachment.waitFor();
    assert.match(await attachment.innerText(), /135/);
    assert.match(await attachment.innerText(), /864\.000/);
    await color(page.locator('[data-dealer-chat-choice="quick-submit"]'), 'backgroundColor', 'rgb(244, 193, 217)');
    await color(page.locator('[data-dealer-chat-choice="quick-submit"]'), 'color', 'rgb(35, 31, 32)');
    await layout(page, 'chat', width);
    await attachment.click();
    const dialog = page.locator('[data-dealer-order-confirmation-mode="review"]');
    await dialog.waitFor();
    assert.equal(await dialog.locator('input').count(), 0);
    assert.equal(calls.filter(call => call.name === 'dealer-order-submit').length, 0);
    await color(dialog, 'backgroundColor', 'rgb(255, 255, 255)');
    await color(dialog.locator('.dealer-option-c-primary'), 'backgroundColor', 'rgb(244, 193, 217)');
    await layout(page, 'review', width);
    await dialog.getByRole('button', { name: 'Chỉnh sửa đơn', exact: true }).click();
    const edit = page.locator('[data-dealer-order-confirmation-mode="edit"]');
    await edit.waitFor();
    assert.ok(await edit.locator('input').count() >= 3);
    await layout(page, 'edit', width);
    await edit.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByPlaceholder('Nhắn BMQ Agent…').focus();
    await page.setViewportSize({ width, height: 500 });
    await page.waitForTimeout(100);
    const composer = await page.locator('[data-hallmark-chat-composer]').boundingBox();
    const nav = await page.locator('[data-dealer-agent-nav]').boundingBox();
    assert.ok(composer.y >= 0 && composer.y + composer.height <= nav.y + 1, 'Composer visible above navigation in reduced viewport');
    await layout(page, 'keyboard-resize', width);
    await page.setViewportSize({ width, height: 844 });
    await page.locator('[data-dealer-agent-nav]').getByRole('button', { name: 'Đơn hàng', exact: true }).click();
    await page.locator('.dealer-history-row').waitFor();
    await color(page.getByRole('tab', { selected: true }), 'backgroundColor', 'rgb(244, 193, 217)');
    await color(page.getByRole('tab', { selected: true }), 'color', 'rgb(35, 31, 32)');
    await layout(page, 'history', width);
    await page.locator('.dealer-history-row').click();
    await page.locator('[data-dealer-order-history-detail]').waitFor();
    await color(page.locator('[data-dealer-order-history-detail]'), 'backgroundColor', 'rgb(255, 255, 255)');
    await layout(page, 'history-detail', width);
    assert.deepEqual(errors, []);
    assert.equal(calls.filter(call => call.name === 'dealer-order-submit').length, 0);
    report.push({ width, passed: true, blockedExternalOrigins: [...new Set(blocked)] });
    await context.close();
  }
  // Exercise actual OTP transitions, final review/edit payload and deep links.
  for (const npp of [false, true]) {
    const { context, page, calls, errors } = await fixture(390, false, npp);
    const login = page.locator('[data-dealer-agent-screen="login"]');
    await login.waitFor();
    assert.equal(await page.locator('[data-dealer-ui="dealer-option-c"]').count(), 0);
    await color(login.getByRole('button', { name: 'Gửi mã OTP Zalo' }), 'backgroundColor', 'rgb(217, 79, 138)');
    await layout(page, 'login', 390);
    await page.getByLabel('Số điện thoại', { exact: true }).fill('0900000000');
    await page.getByRole('button', { name: 'Gửi mã OTP Zalo' }).click();
    await page.locator('input[data-input-otp]').fill('123456');
    await page.getByRole('button', { name: 'Xác thực OTP', exact: true }).click();
    await page.locator('[data-dealer-agent-row="order"]').click();
    await page.getByPlaceholder('Nhắn BMQ Agent…').fill(npp ? 'Điểm kiểm thử 120 đổi 10 bù 5' : '120 đổi 10 bù 5');
    await page.getByRole('button', { name: 'Gửi nội dung đơn', exact: true }).click();
    await page.locator('[data-dealer-order-preview-card]').click();
    const review = page.locator('[data-dealer-order-confirmation-mode="review"]');
    await review.waitFor();
    assert.equal(await review.locator('input').count(), 0);
    await review.getByRole('button', { name: 'Chỉnh sửa đơn', exact: true }).click();
    const edit = page.locator('[data-dealer-order-confirmation-mode="edit"]');
    await edit.locator('input[type="number"]').first().fill('130');
    await edit.getByRole('button', { name: 'Lưu thay đổi', exact: true }).click();
    await review.waitFor();
    assert.match(await review.innerText(), /936\.000/);
    assert.equal(calls.filter(call => call.name === 'dealer-order-submit').length, 0);
    await review.getByRole('button', { name: 'Xác nhận & gửi đơn', exact: true }).click();
    await page.locator('[data-dealer-chat-message="success"]').waitFor();
    const submissions = calls.filter(call => call.name === 'dealer-order-submit');
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0].body.items[0].quantity, 130);
    assert.equal(submissions[0].body.items[0].exchange_quantity, 10);
    assert.equal(submissions[0].body.items[0].makeup_quantity, 5);
    assert.ok(submissions[0].body.client_submission_id);
    await page.goto(`${base}/dealer?view=orders&order=QA-OPTION-C`);
    await page.locator('[data-dealer-order-history-detail]').waitFor();
    assert.match(await page.locator('[data-dealer-order-history-detail]').innerText(), /QA-OPTION-C/);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.locator('[data-dealer-agent-nav]').getByRole('button', { name: 'Tài khoản', exact: true }).click();
    await color(page.getByRole('dialog'), 'backgroundColor', 'rgb(255, 255, 255)');
    await layout(page, npp ? 'npp-account' : 'account', 390);
    await page.getByRole('button', { name: 'Đăng xuất', exact: true }).click();
    await login.waitFor();
    assert.equal(await page.locator('[data-dealer-ui="dealer-option-c"]').count(), 0);
    assert.deepEqual(errors, []);
    report.push({ flow: npp ? 'NPP' : 'retail', otpReviewEditSyntheticSubmitDeepLinkLogout: true });
    await context.close();
  }
  {
    const { context, page, calls } = await fixture(390, true, false, true);
    await page.locator('[data-dealer-agent-row="order"]').click();
    assert.ok(await page.getByText('Tài khoản thử nghiệm – không ghi nhận vận hành', { exact: true }).isVisible());
    await page.getByPlaceholder('Nhắn BMQ Agent…').fill('120 đổi 10 bù 5');
    await page.getByRole('button', { name: 'Gửi nội dung đơn', exact: true }).click();
    await page.locator('[data-dealer-chat-choice="quick-submit"]').click();
    const duplicate = page.locator('[data-dealer-chat-choices="duplicate-order"]');
    await duplicate.waitFor();
    await color(duplicate.locator('.dealer-option-c-primary'), 'backgroundColor', 'rgb(244, 193, 217)');
    await layout(page, 'duplicate', 390);
    assert.equal(calls.filter(call => call.name === 'dealer-order-submit').length, 1);
    await page.locator('[data-dealer-chat-choice="duplicate-continue"]').click();
    await page.locator('[data-dealer-chat-message="success"]').waitFor();
    const submissions = calls.filter(call => call.name === 'dealer-order-submit');
    assert.equal(submissions.length, 2);
    assert.equal(submissions[1].body.duplicate_action, 'continue');
    assert.equal(submissions[1].body.client_submission_id, submissions[0].body.client_submission_id);
    assert.deepEqual(submissions[1].body.items, submissions[0].body.items);
    report.push({ quickSubmitDuplicateExplicitContinue: true });
    await context.close();
  }
  console.log(JSON.stringify(report, null, 2));
  await writeFile(`${output}/report.json`, JSON.stringify(report, null, 2));
} finally { await browser.close(); }
