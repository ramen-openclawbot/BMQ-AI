// Fixture-auth browser QA for the BMQ business cost block (round 2 layout).
//
// Runs the REAL GlobalAgentChatWidget.tsx + the REAL CostBusinessCard.tsx against
// a mocked AuthContext and a scripted supabase.functions.invoke. Fixture auth
// only: no owner login, no production request, no business write, no real
// warehouse call.
//
// Round 2 asserts the owner-approved split concept:
// - example turn  -> compact "PHIẾU CHI PHÍ" card (status, date+supplier,
//   item+prominent exact VND amount); document/category/confidence/classification
//   source/rule/alias/long notes stay under the collapsed "Chi tiết nguồn";
// - explanation turn -> a separate concise grounded block, never the monetary
//   card again, and no repeated follow-up control.
// Output is written only under generated/business-blocks/round2 so the original
// round-1 evidence is never overwritten.
import { writeFileSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';

const base = '/Users/c.o.t.e/.openclaw/workspace-sushi';
const repo = `${base}/tmp/bmq-business-blocks-20260917`;
const web = `${repo}/apps/web`;
const round = `${repo}/generated/business-blocks/round2`;
const out = `${round}/ui`;
mkdirSync(out, { recursive: true });
const tmpDir = `${out}/.browser-tmp`;
mkdirSync(tmpDir, { recursive: true });
process.env.TMPDIR = tmpDir; process.env.TMP = tmpDir; process.env.TEMP = tmpDir;
const { createServer } = await import(`${web}/node_modules/vite/dist/node/index.js`);
const { webkit } = await import(`${base}/tmp/vnagent-ask-user-fix/node_modules/playwright-core/index.mjs`);

const auth = `import {useState} from 'react'; export function useAuth(){const [id,set]=useState('fixture-owner');window.changeOwner=set;return {authzLoaded:true,isOwner:!!id,session:id?{access_token:'fixture-only'}:null,user:id?{id}:null,profile:null}}`;
const mock = `window.calls=[];window.pending=[];
export const supabase={functions:{invoke:(name,options)=>{window.calls.push({name,body:options.body});return new Promise((resolve)=>{window.pending.push(resolve)})}}};
window.reply=(payload={})=>{const answer=typeof payload==='string'?payload:(payload.answer||'Đã nhận BMQ');const data={answer,requestId:payload.requestId||crypto.randomUUID(),provenance:{lane:payload.lane||'cost',model:null,queries:[],elapsedMs:5,...(payload.costContext?{costContext:payload.costContext}:{}),...(payload.costBlock?{costBlock:payload.costBlock}:{})}};window.pending.shift()({data,error:null});};
window.fail=(message='Kho dữ liệu đang bận.')=>{window.pending.shift()({data:null,error:{context:Response.json({error:message})}});};`;
const entry = `import React from 'react';import ReactDOM from 'react-dom/client';import {BrowserRouter,useNavigate} from 'react-router-dom';import {LanguageProvider} from '/src/contexts/LanguageContext.tsx';import {GlobalAgentChatWidget} from '/src/components/agent/GlobalAgentChatWidget.tsx';import '/src/index.css';function Harness(){window.navigate=useNavigate();return React.createElement(GlobalAgentChatWidget)}ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(BrowserRouter,null,React.createElement(LanguageProvider,null,React.createElement(Harness))));`;

const LEGACY = 'LEGACY-ONLY-TEXT';
const VI = {
  title: 'PHIẾU CHI PHÍ',
  headingNeedsReview: 'CẦN KIỂM TRA',
  headingBasis: 'CĂN CỨ PHÂN LOẠI',
  noBasis: 'Chưa đủ căn cứ để kết luận nguyên nhân.',
  ruleLinked: 'Có liên kết quy tắc đã lưu; chưa đủ để kết luận nguyên nhân lịch sử.',
  missing: 'Chưa lấy được bằng chứng phân loại đã lưu cho dòng này; hệ thống không tự suy diễn lý do.',
  note: 'Không có rule nào được gắn với phân loại này (nguồn lưu không phải rule khớp); lý do lịch sử không có sẵn và hệ thống không tự suy diễn.',
};
const ruleEvidence = { name: 'BMQ bread keywords', scope: 'supplier_and_item', priority: '100', confidence: '0.90', effectiveFrom: '2026-01-01', effectiveTo: null };
const ruleNote = 'Rule đã lưu: BMQ bread keywords · supplier_and_item · ưu tiên 100 · độ tin cậy 0.90 · 2026-01-01 → không giới hạn';
const ruleCaveat = 'Đây là metadata hiện tại của liên kết rule đã lưu; không phải bằng chứng rule hiện tại đã tạo ra kết quả phân loại lịch sử.';

const block = (over = {}) => ({
  v: 1, kind: 'cost_line', mode: 'example', month: '2026-09',
  line: {
    classificationId: 'c2', sourceNumber: 'PR-2026-09-000002', sourceDate: '2026-09-14',
    supplierName: 'Thiên An Sinh', productName: 'Chà lụa lá TVP XL', amount: 5940000,
    categoryLabel: 'Chi phí bánh mì', categoryCode: 'COGS_BMQ_BREAD', reviewStatus: 'needs_review',
    confidence: '0', classificationSource: 'fallback',
  },
  evidence: { stored: true, rule: null, alias: null, aliasStatus: null },
  notes: [VI.note],
  source: {
    name: 'Supabase.cost_classification_line_details', observedAt: '2026-09-16T21:37:45Z', snapshotId: 'snap-2026-09-16',
    semanticVersion: 'bmq-cost-classification-v2', selectionRule: 'largest_line_amount_then_source_date_then_classification_id',
    matchCount: 17, truncated: true,
    disclaimer: 'Toàn bộ dòng chi phí theo view phân loại chuẩn (dòng đã phân loại + dòng OCR-only có metadata chi phí), không phải báo cáo đã kiểm toán.',
  },
  followUp: 'line_explanation', ...over,
});
const example = (over = {}) => block({ mode: 'example', ...over });
const explanation = (over = {}) => block({ mode: 'explanation', source: { ...block().source, selectionRule: null, matchCount: null, truncated: false }, ...over });
const scope = { kind: 'pending_summary', month: '2026-09', category_code: null, review_status: 'needs_review' };
const ctx = (conv, over = {}) => ({ v: 1, user: 'fixture-owner', conv, iat: Date.now(), exp: Date.now() + 600000, snap: 'snap-2026-09-16', scope: { ...scope, ...(over.scope || {}) }, ...(over.selection ? { selection: over.selection } : {}), sig: 'a'.repeat(64), ...(over.exp ? { exp: over.exp } : {}) });

async function startServer(contextFlag) {
  return createServer({
    root: web, configFile: false, esbuild: { jsx: 'automatic' },
    define: { 'import.meta.env.VITE_BMQ_ANALYTICS_ENABLED': JSON.stringify('true'), 'import.meta.env.VITE_BMQ_CHAT_CONTEXT_ENABLED': JSON.stringify(String(contextFlag)) },
    cacheDir: `${round}/.vite-cache-${contextFlag}`,
    server: { host: '127.0.0.1', port: contextFlag ? 5391 : 5392 },
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
  for (const analyticsFlag of [true, false]) {
    const server = await startServer(analyticsFlag);
    await server.listen();
    const port = analyticsFlag ? 5391 : 5392;
    try {
      for (const width of [320, 390, 1440]) {
        const page = await browser.newPage({ viewport: { width, height: 844 } });
        page.setDefaultTimeout(8000);
        const errors = [];
        page.on('pageerror', (error) => { errors.push(error.message); console.error('PAGEERROR', width, error.message); });
        page.on('console', (message) => { if (message.type() === 'error') console.error('CONSOLE', width, message.text().slice(0, 300)); });
        await page.route('https://fonts.googleapis.com/**', (route) => route.abort());
        const record = { analyticsFlag, width, checks: {} };
        const shot = (name) => page.screenshot({ path: `${out}/${width}-${name}.png` });
        const noOverflow = async (label) => {
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
          assert.ok(overflow <= 1, `page overflow (${label}) at ${width}: ${overflow}`);
        };
        const exampleCards = () => page.locator('[data-bmq-business-block-mode="example"]');
        const explanationBlocks = () => page.locator('[data-bmq-business-block-mode="explanation"]');
        await page.goto(`http://127.0.0.1:${port}/qa.html`);
        await page.getByRole('button', { name: 'Mở VNAgent' }).click();
        const input = page.locator('[data-vnagent-composer]');
        const send = async (question) => { await input.fill(question); await page.getByRole('button', { name: 'Gửi tin nhắn', exact: true }).click(); };
        const lastCall = () => page.evaluate(() => window.calls.at(-1).body);
        const convOf = async () => (await lastCall()).conversationId;
        const reply = (payload) => page.evaluate((value) => window.reply(value), payload);

        if (analyticsFlag) {
          // 1. Aggregate answer never becomes a line card.
          await send('Tổng chi phí tháng 9/2026');
          let conv = await convOf();
          await reply({ answer: 'Tổng chi phí theo view chuẩn · 09/2026', costContext: ctx(conv) });
          await page.getByText('Tổng chi phí theo view chuẩn · 09/2026', { exact: true }).waitFor();
          assert.equal(await page.locator('[data-bmq-business-block]').count(), 0, 'aggregate must not render a line card');
          record.checks.aggregateStaysText = true;

          // 2. Compact example card: title, status, date+supplier, item+prominent amount only.
          await send('Lấy một dòng làm ví dụ');
          conv = await convOf();
          await reply({ answer: `${LEGACY} dòng chi phí ví dụ c2`, costContext: ctx(conv, { selection: { line_ref: 'c2', classification_id: 'c2' } }), costBlock: example() });
          const card = exampleCards().first();
          await card.waitFor();
          const visible = await card.innerText();
          assert.ok(visible.includes(VI.title), 'card title');
          assert.match(visible, /Cần review/, 'status badge');
          assert.match(visible, /Thiên An Sinh/, 'supplier');
          assert.match(visible, /Chà lụa lá TVP XL/, 'item');
          assert.match(visible, /14\/09\/2026/, 'date');
          for (const hidden of ['PR-2026-09-000002', 'COGS_BMQ_BREAD', 'Chi phí bánh mì', 'fallback', 'Chứng từ', 'Độ tin cậy', 'Nguồn phân loại', VI.note]) {
            assert.ok(!visible.includes(hidden), `"${hidden}" must stay in the collapsed source details`);
          }
          const amount = await card.locator('[data-bmq-cost-amount]').innerText();
          assert.match(amount, /5\.940\.000/, `prominent exact amount, got ${amount}`);
          assert.equal(await card.locator('[data-bmq-cost-warning]').count(), 0, 'available evidence needs no warning');
          const labelSizes = await card.locator('[data-bmq-cost-label]').evaluateAll((nodes) => nodes.map((node) => parseFloat(getComputedStyle(node).fontSize)));
          assert.ok(labelSizes.length >= 4, 'expected several business labels');
          assert.ok(Math.min(...labelSizes) >= 12, `business labels must render at >=12px, got ${Math.min(...labelSizes)}`);
          assert.ok(!(await page.locator('body').innerText()).includes(LEGACY), 'card facts must not be duplicated as prose');
          record.checks.exampleCardCompact = true;
          record.checks.amount = amount.trim();
          record.checks.minBusinessLabelPx = Math.min(...labelSizes);
          await noOverflow('example card');
          await shot('example-card');

          // 3. Collapsed source details hold the moved metadata; pointer + keyboard toggle.
          const source = card.locator('[data-bmq-cost-source]');
          assert.equal(await source.evaluate((node) => node.open), false, 'source details starts collapsed');
          await source.locator('summary').click();
          await page.waitForFunction(() => document.querySelectorAll('[data-bmq-cost-source]')[0]?.open === true);
          const detailsText = await source.innerText();
          for (const shown of ['PR-2026-09-000002', 'COGS_BMQ_BREAD', 'Chi phí bánh mì', 'fallback', 'snap-2026-09-16', 'Quy tắc chọn (công khai)', VI.note]) {
            assert.ok(detailsText.includes(shown), `collapsed details must disclose "${shown}"`);
          }
          await noOverflow('source open');
          await shot('source-open');
          await source.locator('summary').press('Enter');
          await page.waitForFunction(() => document.querySelectorAll('[data-bmq-cost-source]')[0]?.open === false);
          record.checks.sourceToggleAndKeyboard = true;
          const summaryBox = await source.locator('summary').boundingBox();
          const followUpBox = await card.locator('[data-bmq-cost-followup]').boundingBox();
          assert.ok(summaryBox && summaryBox.height >= 44, `summary touch target ${JSON.stringify(summaryBox)}`);
          assert.ok(followUpBox && followUpBox.height >= 44, `follow-up touch target ${JSON.stringify(followUpBox)}`);
          record.checks.touchTargets = { summary: Math.round(summaryBox.height), followUp: Math.round(followUpBox.height) };

          // 4. Row-bound follow-up on the newest example card sends the exact question.
          await card.locator('[data-bmq-cost-followup]').click();
          assert.equal((await lastCall()).question, 'Vì sao dòng này?');
          const history = await page.evaluate(() => window.calls.at(-1).body.history);
          assert.equal(history.at(-1).costContext.selection.line_ref, 'c2', 'follow-up carries the shown row context');
          conv = await convOf();
          await reply({ answer: `${LEGACY} giải thích dòng c2`, costContext: ctx(conv, { selection: { line_ref: 'c2', classification_id: 'c2' } }), costBlock: explanation() });
          const explanationBlock = explanationBlocks().first();
          await explanationBlock.waitFor();
          record.checks.rowBoundFollowUp = true;

          // 5. Explanation turn is a distinct, grounded block, not the monetary card.
          assert.equal(await explanationBlock.locator('[data-bmq-cost-amount]').count(), 0, 'explanation must not repeat the monetary card');
          assert.equal(await explanationBlock.locator('[data-bmq-cost-followup]').count(), 0, 'explanation must not repeat the follow-up control');
          const expVisible = await explanationBlock.innerText();
          assert.ok(expVisible.includes(VI.headingNeedsReview), `descriptive heading, got ${expVisible}`);
          assert.ok(expVisible.includes(VI.noBasis), 'grounded no-rule summary');
          assert.ok(!expVisible.includes('5.940.000'), 'explanation must not repeat the amount');
          assert.match(await explanationBlock.locator('[data-bmq-cost-row-identity]').innerText(), /c2/, 'subtle row identity');
          assert.ok(!expVisible.includes(VI.note), 'full notes stay collapsed');
          const expSource = explanationBlock.locator('[data-bmq-cost-source]');
          assert.equal(await expSource.evaluate((node) => node.open), false);
          await expSource.locator('summary').click();
          await page.waitForTimeout(60);
          assert.equal(await expSource.evaluate((node) => node.open), true);
          assert.ok((await expSource.innerText()).includes(VI.note), 'full true notes stay available under the collapsed details');
          record.checks.explanationBlockDistinct = true;
          await noOverflow('explanation block');
          await shot('explanation-card');

          // 6. Rule-linked explanation: basis heading + grounded rule-link wording.
          await send('Vì sao dòng này có rule?');
          conv = await convOf();
          await reply({ answer: `${LEGACY} giải thích rule`, costContext: ctx(conv, { selection: { line_ref: 'c2', classification_id: 'c2' } }), costBlock: explanation({ line: { ...block().line, reviewStatus: 'suggested' }, evidence: { stored: true, rule: ruleEvidence, alias: null, aliasStatus: null }, notes: [ruleNote, ruleCaveat] }) });
          const ruleBlock = explanationBlocks().nth(1);
          await ruleBlock.waitFor();
          const ruleVisible = await ruleBlock.innerText();
          assert.ok(ruleVisible.includes(VI.headingBasis), `classification-basis heading, got ${ruleVisible}`);
          assert.ok(ruleVisible.includes(VI.ruleLinked), 'grounded stored-rule wording');
          assert.ok(!ruleVisible.includes(VI.noBasis), 'rule link and no-rule wording never mix');
          assert.equal(await ruleBlock.locator('[data-bmq-cost-followup]').count(), 0);
          record.checks.ruleLinkedExplanation = true;
          await noOverflow('rule explanation');
          await shot('explanation-rule');

          // 7. Missing stored evidence: the warning stays visible above the fold.
          await send('Dòng chi phí thiếu bằng chứng');
          conv = await convOf();
          await reply({ answer: `${LEGACY} thiếu bằng chứng`, costContext: ctx(conv, { selection: { line_ref: 'c8', classification_id: 'c8' } }), costBlock: example({ line: { ...block().line, classificationId: 'c8', productName: 'Bánh mì que' }, evidence: { stored: false, rule: null, alias: null, aliasStatus: null }, notes: [VI.missing] }) });
          const warningCard = exampleCards().nth(1);
          await warningCard.waitFor();
          const warningBox = warningCard.locator('[data-bmq-cost-warning]');
          assert.equal(await warningBox.count(), 1, 'missing evidence must render a warning');
          assert.equal(await warningBox.first().isVisible(), true, 'warning must not be hidden');
          assert.ok((await warningBox.first().innerText()).includes(VI.missing), 'visible warning wording');
          assert.ok(!(await warningCard.innerText()).includes('PR-2026-09-000002'), 'warning card still hides metadata');
          record.checks.missingEvidenceWarningVisible = true;
          await noOverflow('missing evidence warning');
          await shot('example-warning');

          // 8. Old-card safety: only the newest example card may follow up.
          await send('Lấy một dòng ví dụ mới');
          conv = await convOf();
          await reply({ answer: `${LEGACY} ví dụ mới`, costContext: ctx(conv, { selection: { line_ref: 'c5', classification_id: 'c5' } }), costBlock: example({ line: { ...block().line, classificationId: 'c5', productName: 'Bánh bao' } }) });
          await page.waitForFunction(() => document.querySelectorAll('[data-bmq-business-block-mode="example"]').length === 3);
          const oldButton = exampleCards().nth(0).locator('[data-bmq-cost-followup]');
          const newButton = exampleCards().nth(2).locator('[data-bmq-cost-followup]');
          assert.equal(await oldButton.isDisabled(), true, 'older example follow-up must be disabled');
          assert.equal(await newButton.isDisabled(), false, 'latest example follow-up stays enabled');
          assert.equal(await page.locator('[data-bmq-business-block-mode="explanation"] [data-bmq-cost-followup]').count(), 0);
          const callsBefore = await page.evaluate(() => window.calls.length);
          await oldButton.click({ force: true }).catch(() => undefined);
          await page.waitForTimeout(50);
          assert.equal(await page.evaluate(() => window.calls.length), callsBefore, 'disabled old-card follow-up must not send');
          record.checks.oldCardFollowUpDisabled = true;

          // 9. Long labels wrap with no horizontal overflow.
          await send('Dòng chi phí khác');
          conv = await convOf();
          await reply({
            answer: `${LEGACY} long labels`,
            costContext: ctx(conv, { selection: { line_ref: 'c9', classification_id: 'c9' } }),
            costBlock: example({ line: { ...block().line, classificationId: 'c9', supplierName: 'Nhà cung cấp thực phẩm tươi sống và bao bì nhập khẩu tên rất dài để kiểm tra xuống dòng', productName: 'Pate gan cao cấp nhập khẩu đóng hộp loại lớn theo đơn vị thùng', sourceNumber: 'PR-2026-09-000009-with-a-long-document-number', amount: 1234567890 } }),
          });
          await page.waitForFunction(() => document.querySelectorAll('[data-bmq-business-block-mode="example"]').length === 4);
          assert.match(await exampleCards().last().innerText(), /1\.234\.567\.890/);
          await noOverflow('long labels');
          record.checks.longLabels = true;
          await shot('long-labels');

          // 10. Stale signed context: card renders, follow-up disabled and explained.
          await send('Dòng chi phí mới');
          conv = await convOf();
          await reply({
            answer: `${LEGACY} stale`,
            costContext: ctx(conv, { selection: { line_ref: 'c7', classification_id: 'c7' }, exp: Date.now() + 1000 }),
            costBlock: example({ line: { ...block().line, classificationId: 'c7' } }),
          });
          await page.waitForFunction(() => document.querySelectorAll('[data-bmq-business-block-mode="example"]').length === 5);
          const staleCard = exampleCards().last();
          assert.equal(await staleCard.locator('[data-bmq-cost-followup]').isDisabled(), true, 'expired context disables follow-up');
          await noOverflow('stale context');
          record.checks.staleContextDisabled = true;
          await shot('stale-context');

          // 11. Invalid card schema degrades to the truthful text, never a partial card.
          await send('Dòng chi phí lỗi schema');
          conv = await convOf();
          await reply({
            answer: `${LEGACY} dòng chi phí ví dụ c2`,
            costContext: ctx(conv, { selection: { line_ref: 'c2', classification_id: 'c2' } }),
            costBlock: example({ line: { ...block().line, amount: '5940000' } }),
          });
          await page.getByText(new RegExp(LEGACY), { exact: false }).last().waitFor();
          assert.equal(await exampleCards().count(), 5, 'invalid block must not add a card');
          record.checks.invalidSchemaDegrades = true;
          await noOverflow('invalid schema');
          await shot('invalid-schema');

          // 12. Empty scope stays honest text.
          await send('Dòng chi phí rỗng');
          await page.evaluate(() => window.reply({ answer: 'Không có dòng chi phí nào khớp phạm vi này; hệ thống không tạo dòng thay thế.', costBlock: null }));
          await page.getByText(/Không có dòng chi phí nào khớp phạm vi này/).waitFor();
          record.checks.empty = true;

          // 13. Error keeps the draft and shows one inline message.
          await send('Câu lỗi');
          await page.evaluate(() => window.fail('Kho dữ liệu đang bận.'));
          await page.getByText('Kho dữ liệu đang bận.', { exact: true }).waitFor();
          assert.equal(await input.inputValue(), 'Câu lỗi');
          record.checks.error = true;
          await noOverflow('error');
          await shot('error');

          // 14. English labels for both modes at desktop width.
          if (width === 1440) {
            await page.addInitScript(() => localStorage.setItem('app-language', 'en'));
            await page.reload();
            await page.getByRole('button', { name: 'Open VNAgent' }).click();
            const enInput = page.locator('[data-vnagent-composer]');
            await enInput.fill('Example line please');
            await page.getByRole('button', { name: 'Send message', exact: true }).click();
            const enConv = await page.evaluate(() => window.calls.at(-1).body.conversationId);
            await reply({ answer: `${LEGACY} en`, costContext: ctx(enConv, { selection: { line_ref: 'c2', classification_id: 'c2' } }), costBlock: example() });
            const enCard = exampleCards().first();
            await enCard.waitFor();
            assert.match(await enCard.innerText(), /EXPENSE VOUCHER/);
            assert.match(await enCard.innerText(), /AMOUNT/i);
            await enCard.locator('[data-bmq-cost-followup]').click();
            assert.equal((await lastCall()).question, 'Why is this line classified this way?');
            const enConv2 = await page.evaluate(() => window.calls.at(-1).body.conversationId);
            await reply({ answer: `${LEGACY} en why`, costContext: ctx(enConv2, { selection: { line_ref: 'c2', classification_id: 'c2' } }), costBlock: explanation() });
            const enExp = explanationBlocks().first();
            await enExp.waitFor();
            const enExpText = await enExp.innerText();
            assert.ok(enExpText.includes('NEEDS REVIEW'));
            assert.ok(enExpText.includes('Not enough evidence to conclude the cause.'));
            assert.equal(await enExp.locator('[data-bmq-cost-amount]').count(), 0);
            record.checks.englishLabels = true;
            await noOverflow('english');
            await shot('english');
          }
        } else {
          // Rollback flag: the compact card still shows verified facts, but no
          // signed state is echoed, so the follow-up stays disabled.
          await send('Lấy một dòng làm ví dụ');
          await page.evaluate((payload) => window.reply(payload), { answer: `${LEGACY} off`, costBlock: example() });
          const card = exampleCards().first();
          await card.waitFor();
          assert.match(await card.locator('[data-bmq-cost-amount]').innerText(), /5\.940\.000/);
          assert.equal(await card.locator('[data-bmq-cost-followup]').isDisabled(), true, 'context off must disable the follow-up');
          const sent = await page.evaluate(() => window.calls.at(-1).body);
          assert.equal(sent.costContext, undefined);
          record.checks.contextOffFollowUpDisabled = true;
          await noOverflow('context off');
          await shot('context-off');
        }
        assert.deepEqual(errors, []);
        results.push(record);
        await page.close();
      }
    } finally { await server.close(); }
  }
} finally { await browser.close(); }
writeFileSync(`${out}/qa-results.json`, JSON.stringify(results, null, 2));
console.log('PASS', JSON.stringify(results, null, 2));
