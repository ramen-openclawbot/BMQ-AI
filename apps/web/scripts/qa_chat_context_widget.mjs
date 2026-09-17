// Browser fixture QA for the analytics cost conversation context.
//
// Runs the REAL GlobalAgentChatWidget.tsx against a mocked AuthContext and a
// scripted supabase.functions.invoke. Fixture-auth only: no owner login, no
// production request, no business write. Covers mobile 320/390 and desktop 1440,
// populated multi-turn state, empty, error, reset, long response, account change
// and the frontend rollback flag.
import { writeFileSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';

const base = '/Users/c.o.t.e/.openclaw/workspace-sushi';
const repo = `${base}/tmp/bmq-chat-context-20260917`;
const web = `${repo}/apps/web`;
const out = `${repo}/generated/chat-context`;
mkdirSync(out, { recursive: true });
// Keep every browser temp/profile path inside the writable workspace.
const tmpDir = `${out}/.browser-tmp`;
mkdirSync(tmpDir, { recursive: true });
process.env.TMPDIR = tmpDir; process.env.TMP = tmpDir; process.env.TEMP = tmpDir;
const { createServer } = await import(`${web}/node_modules/vite/dist/node/index.js`);
// playwright-core 1.62.1 matches the installed WebKit build (2336); the system
// Chrome cannot start under the workspace file sandbox.
const { webkit } = await import(`${base}/tmp/vnagent-ask-user-fix/node_modules/playwright-core/index.mjs`);
// Representative long evidence is rendered by the REAL cost formatter, not a
// short hardcoded string, so wrapping/overflow is exercised on actual output.
const { costAnswer } = await import(`${web}/supabase/functions/bmq-analytics/cost.ts`);

const auth = `import {useState} from 'react'; export function useAuth(){const [id,set]=useState('fixture-owner');window.changeOwner=set;return {authzLoaded:true,isOwner:!!id,session:id?{access_token:'fixture-only'}:null,user:id?{id}:null,profile:null}}`;
const mock = `window.calls=[];window.pending=[];
export const supabase={functions:{invoke:(name,options)=>{window.calls.push({name,body:options.body});return new Promise((resolve)=>{window.pending.push(resolve)})}}};
window.reply=(payload={})=>{const answer=typeof payload==='string'?payload:(payload.answer||'Đã nhận BMQ');const data={answer,requestId:payload.requestId||crypto.randomUUID(),provenance:{lane:payload.lane||'cost',model:null,queries:[],elapsedMs:5,...(payload.costContext?{costContext:payload.costContext}:{})}};window.pending.shift()({data,error:null});};
window.fail=(message='Kho dữ liệu đang bận.')=>{window.pending.shift()({data:null,error:{context:Response.json({error:message})}});};`;
const entry = `import React from 'react';import ReactDOM from 'react-dom/client';import {BrowserRouter,useNavigate} from 'react-router-dom';import {LanguageProvider} from '/src/contexts/LanguageContext.tsx';import {GlobalAgentChatWidget} from '/src/components/agent/GlobalAgentChatWidget.tsx';import '/src/index.css';function Harness(){window.navigate=useNavigate();return React.createElement(GlobalAgentChatWidget)}ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(BrowserRouter,null,React.createElement(LanguageProvider,null,React.createElement(Harness))));`;

const CTX_A = { v: 1, user: 'fixture-owner', conv: 'conv-a', iat: 1, exp: 9e12, snap: 'snap-1', scope: { kind: 'pending_summary', month: '2026-09', category_code: null, review_status: 'needs_review' }, sig: 'a'.repeat(64) };
const CTX_B = { ...CTX_A, scope: { kind: 'pending_summary', month: '2026-09', category_code: null, review_status: 'needs_review' }, selection: { line_ref: 'c2', classification_id: 'c2' } };
const PROVENANCE = { source: 'Supabase.cost_classification_line_details', source_observed_at: '2026-09-16T21:37:45Z', snapshot_id: 'snap-1', semantic_version: 'bmq-cost-classification-v2' };
const LONG_LINE = {
  classification_id: 'c2', month: '2026-09-01', category_code: 'COGS_BMQ_BREAD',
  category_label: 'Chi phí bánh mì và nguyên liệu nhập khẩu theo hợp đồng dài hạn',
  review_status: 'needs_review', supplier_name: 'Nhà cung cấp thực phẩm tươi sống và bao bì nhập khẩu tên rất dài để kiểm tra xuống dòng',
  source_number: 'PR-2026-09-000002-with-a-long-document-number', source_date: '2026-09-12',
  product_name: 'Pate gan cao cấp nhập khẩu đóng hộp loại lớn theo đơn vị thùng', line_amount: '8344200',
  classification_source: 'fallback', rule_id: null, confidence: '0',
};
const EXAMPLE_ANSWER = costAnswer({
  ...PROVENANCE, question: 'example_line', month: '2026-09', category_code: 'COGS_BMQ_BREAD', review_status: 'needs_review',
  match_count: 17, rows: [LONG_LINE], limit: 1, truncated: true,
  selection_rule: 'largest_line_amount_then_source_date_then_classification_id',
  line: LONG_LINE, evidence: { rule: null, alias_mapping: null, alias_status: null },
}, 'example_line', 'vi');
const LONG_PENDING = costAnswer({
  ...PROVENANCE, question: 'top_pending_lines', month: '2026-09', pending_line_count: 42, pending_amount: '123456789',
  rows: Array.from({ length: 40 }, (_, i) => ({
    source_date: `2026-09-${String((i % 28) + 1).padStart(2, '0')}`,
    source_number: `PR-2026-09-${String(i + 1).padStart(4, '0')}`,
    supplier_name: `Nhà cung cấp rất dài số ${i + 1} để kiểm tra xuống dòng trên màn hình hẹp`,
    product_name: `Hàng hóa nguyên liệu nhập khẩu tên dài số ${i + 1}`,
    line_amount: String(1000000 + i * 137), review_status: 'needs_review',
  })), truncated: true,
}, 'top_pending_lines', 'vi');

async function startServer(contextFlag) {
  return createServer({
    root: web, configFile: false, esbuild: { jsx: 'automatic' },
    define: { 'import.meta.env.VITE_BMQ_ANALYTICS_ENABLED': JSON.stringify('true'), 'import.meta.env.VITE_BMQ_CHAT_CONTEXT_ENABLED': JSON.stringify(String(contextFlag)) },
    cacheDir: `${repo}/generated/chat-context/.vite-cache-${contextFlag}`,
    server: { host: '127.0.0.1', port: contextFlag ? 5197 : 5198 },
    resolve: { alias: { '@': `${web}/src` } },
    plugins: [{
      name: 'fixture', enforce: 'pre',
      resolveId(id) { if (id === '/qa-entry.jsx') return '\0entry'; if (id.endsWith('/src/contexts/AuthContext') || id === '@/contexts/AuthContext') return '\0auth'; if (id.endsWith('/src/integrations/supabase/client') || id === '@/integrations/supabase/client') return '\0db'; },
      load(id) { if (id === '\0auth') return auth; if (id === '\0db') return mock; if (id === '\0entry') return entry; },
      configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== '/qa.html') return next(); res.setHeader('Content-Type', 'text/html'); res.end('<html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/qa-entry.jsx"></script></html>'); }); },
    }],
  });
}

const results = [];
const browser = await webkit.launch({ headless: true });
try {
  for (const contextFlag of [true, false]) {
    const server = await startServer(contextFlag);
    await server.listen();
    const port = contextFlag ? 5197 : 5198;
    try {
      for (const width of [320, 390, 1440]) {
        const page = await browser.newPage({ viewport: { width, height: 844 } });
        page.setDefaultTimeout(8000);
        const errors = [];
        page.on('pageerror', (error) => { errors.push(error.message); console.error('PAGEERROR', width, error.message); });
        page.on('console', (message) => { if (message.type() === 'error') console.error('CONSOLE', width, message.text().slice(0, 300)); });
        await page.route('https://fonts.googleapis.com/**', (route) => route.abort());
        const record = { contextFlag, width, checks: {} };
        await page.goto(`http://127.0.0.1:${port}/qa.html`);
        await page.getByRole('button', { name: 'Mở VNAgent' }).click();
        const input = page.locator('[data-vnagent-composer]');

        if (contextFlag) {
          // Populated multi-turn: state issued by the server is echoed back only on the assistant turn.
          await input.fill('Tháng 9/2026 còn bao nhiêu dòng cần review?');
          await page.getByRole('button', { name: 'Gửi tin nhắn', exact: true }).click();
          assert.equal(await page.evaluate(() => window.calls[0].body.history.length), 0);
          await page.evaluate((ctx) => window.reply({ answer: 'Tổng chi phí · 09/2026', costContext: ctx }), CTX_A);
          await page.getByText('Tổng chi phí · 09/2026', { exact: true }).waitFor();

          await input.fill('Lấy một dòng làm ví dụ');
          await page.getByRole('button', { name: 'Gửi tin nhắn', exact: true }).click();
          const second = await page.evaluate(() => window.calls[1].body.history);
          assert.equal(second.length, 2);
          assert.deepEqual(second[1].costContext, CTX_A);
          assert.equal(second[0].costContext, undefined);
          await page.evaluate((payload) => window.reply(payload), { answer: EXAMPLE_ANSWER, costContext: CTX_B });
          await page.getByText(/Dòng chi phí ví dụ/).waitFor();
          assert.match(await page.locator('body').innerText(), /Nhà cung cấp thực phẩm tươi sống và bao bì nhập khẩu tên rất dài/);
          await page.screenshot({ path: `${out}/widget-${width}-example-on.png` });
          record.checks.stateEcho = true;

          // Close/reopen preserves the conversation and its bounded state.
          await page.getByRole('button', { name: 'Đóng VNAgent' }).click();
          await page.getByRole('button', { name: 'Mở VNAgent' }).click();
          await page.getByText(/Dòng chi phí ví dụ/).waitFor();
          record.checks.closePreserves = true;

          // Long response must wrap, never overflow the page horizontally.
          await input.fill('In danh sách dài');
          await page.getByRole('button', { name: 'Gửi tin nhắn', exact: true }).click();
          await page.evaluate((answer) => window.reply({ answer }), LONG_PENDING);
          await page.getByText(/Dòng chờ review lớn nhất/).waitFor();
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          assert.ok(overflow <= 1, `page overflow at ${width}: ${overflow}`);
          record.checks.longResponse = true;
          await page.screenshot({ path: `${out}/widget-${width}-${contextFlag ? 'on' : 'off'}.png` });

          // Reset clears the timeline and the next request carries no history/state.
          await page.locator('[data-bmq-conversation-reset]').click();
          assert.equal(await page.getByText(/Dòng chờ review lớn nhất/).count(), 0);
          await page.screenshot({ path: `${out}/widget-${width}-reset-on.png` });
          await input.fill('Câu sau reset');
          await page.getByRole('button', { name: 'Gửi tin nhắn', exact: true }).click();
          assert.equal(await page.evaluate(() => window.calls.at(-1).body.history.length), 0);
          await page.evaluate(() => window.fail('Kho dữ liệu đang bận.'));
          await page.getByText('Kho dữ liệu đang bận.', { exact: true }).waitFor();
          assert.equal(await input.inputValue(), 'Câu sau reset');
          await page.screenshot({ path: `${out}/widget-${width}-error-on.png` });
          record.checks.resetAndError = true;

          // Empty result is shown honestly.
          await page.getByRole('button', { name: 'Gửi tin nhắn', exact: true }).click();
          await page.evaluate(() => window.reply({ answer: 'Không có dòng chi phí nào khớp phạm vi này; hệ thống không tạo dòng thay thế.' }));
          await page.getByText(/Không có dòng chi phí nào khớp phạm vi này/).waitFor();
          await page.screenshot({ path: `${out}/widget-${width}-empty-on.png` });
          record.checks.empty = true;

          // Account change discards the conversation and any late response.
          await input.fill('Câu của chủ cũ');
          await page.getByRole('button', { name: 'Gửi tin nhắn', exact: true }).click();
          await page.evaluate(() => window.changeOwner(null));
          await page.waitForTimeout(30);
          await page.evaluate((ctx) => window.reply({ answer: 'LATE PRIVATE', costContext: ctx }), CTX_A);
          await page.evaluate(() => window.changeOwner('other-owner'));
          await input.waitFor();
          assert.equal(await page.getByText('LATE PRIVATE', { exact: true }).count(), 0);
          record.checks.accountIsolation = true;
          await page.screenshot({ path: `${out}/widget-${width}-account-switch.png` });

          // Reset control must be a real >=44px touch target with a translated label.
          const resetButton = page.locator('[data-bmq-conversation-reset]');
          const resetBox = await resetButton.boundingBox();
          assert.ok(resetBox && resetBox.width >= 44 && resetBox.height >= 44, `reset touch target ${JSON.stringify(resetBox)}`);
          assert.equal(await resetButton.getAttribute('aria-label'), 'Tạo cuộc trò chuyện mới');
          record.checks.resetTouchTarget = Math.round(resetBox.width);
          if (width === 1440) {
            await page.addInitScript(() => localStorage.setItem('app-language', 'en'));
            await page.reload();
            await page.getByRole('button', { name: 'Open VNAgent' }).click();
            const enReset = page.locator('[data-bmq-conversation-reset]');
            await enReset.waitFor({ state: 'visible' });
            assert.equal(await enReset.getAttribute('aria-label'), 'Start a new conversation');
            const enBox = await enReset.boundingBox();
            assert.ok(enBox && enBox.width >= 44 && enBox.height >= 44, `EN reset touch target ${JSON.stringify(enBox)}`);
            record.checks.resetEnglishLabel = true;
            await page.waitForTimeout(700);
            await page.screenshot({ path: `${out}/widget-${width}-reset-en.png` });
          }
        } else {
          // Frontend rollback: the server may return state, but the widget must not echo it.
          await input.fill('Tháng 9/2026 còn bao nhiêu dòng cần review?');
          await page.getByRole('button', { name: 'Gửi tin nhắn', exact: true }).click();
          await page.evaluate((ctx) => window.reply({ answer: 'Tổng chi phí · 09/2026', costContext: ctx }), CTX_A);
          await page.getByText('Tổng chi phí · 09/2026', { exact: true }).waitFor();
          await input.fill('Lấy một dòng làm ví dụ');
          await page.getByRole('button', { name: 'Gửi tin nhắn', exact: true }).click();
          const second = await page.evaluate(() => window.calls[1].body.history);
          assert.equal(second[1].costContext, undefined);
          await page.evaluate(() => window.reply({ answer: 'Câu trả lời cũ' }));
          await page.getByText('Câu trả lời cũ', { exact: true }).waitFor();
          record.checks.rollbackNoState = true;
          await page.screenshot({ path: `${out}/widget-${width}-off.png` });
        }
        assert.deepEqual(errors, []);
        results.push(record);
        await page.close();
      }
    } finally { await server.close(); }
  }
} finally { await browser.close(); }
writeFileSync(`${out}/widget-qa-results.json`, JSON.stringify(results, null, 2));
console.log('PASS', JSON.stringify(results, null, 2));
