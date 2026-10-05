// Fixture-auth browser QA for the VNAgent chat widget reskin (chat.vnagent.ai design).
//
// Runs the REAL GlobalAgentChatWidget.tsx + CostBusinessCard.tsx against a mocked
// AuthContext and a scripted supabase.functions.invoke. No owner login, no
// production request, no business write. Covers mobile 320/390 and desktop 1440:
// closed launcher on light and dark pages, empty, responding, answered, error,
// cost card, and that no retired violet colour is rendered.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(web, '../..');
const out = `${repo}/generated/chat-reskin`;
mkdirSync(out, { recursive: true });
const tmpDir = `${out}/.browser-tmp`;
mkdirSync(tmpDir, { recursive: true });
process.env.TMPDIR = tmpDir; process.env.TMP = tmpDir; process.env.TEMP = tmpDir;
const { createServer } = await import(`${web}/node_modules/vite/dist/node/index.js`);
// Usage: PLAYWRIGHT_CORE=/path/to/playwright-core CHROME=/path/to/chrome node scripts/qa_chat_reskin.mjs
const PW = process.env.PLAYWRIGHT_CORE || '/Users/c.o.t.e/.openclaw/workspace-sushi/tmp/vnagent-ask-user-fix/node_modules/playwright-core';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const { chromium } = await import(`${PW}/index.mjs`);

const auth = `export function useAuth(){return {authzLoaded:true,isOwner:true,session:{access_token:'fixture-only'},user:{id:'fixture-owner'},profile:{user_id:'fixture-owner',full_name:'Tâm'}}}`;
const mock = `window.calls=[];window.pending=[];
export const supabase={functions:{invoke:(name,options)=>{window.calls.push({name,body:options.body});return new Promise((resolve)=>{window.pending.push(resolve)})}}};
window.reply=(payload={})=>{const data={answer:payload.answer||'Đã nhận',requestId:crypto.randomUUID(),provenance:{lane:payload.lane||'revenue',model:null,queries:[],elapsedMs:5,...(payload.details?{details:payload.details}:{}),...(payload.costBlock?{costBlock:payload.costBlock}:{})}};window.pending.shift()({data,error:null});};
window.fail=(message='Kho dữ liệu đang bận.')=>{window.pending.shift()({data:null,error:{context:Response.json({error:message})}});};`;
const entry = `import React from 'react';import ReactDOM from 'react-dom/client';import {BrowserRouter} from 'react-router-dom';import {LanguageProvider} from '/src/contexts/LanguageContext.tsx';import {GlobalAgentChatWidget} from '/src/components/agent/GlobalAgentChatWidget.tsx';import '/src/index.css';ReactDOM.createRoot(document.getElementById('root')).render(React.createElement(BrowserRouter,null,React.createElement(LanguageProvider,null,React.createElement(GlobalAgentChatWidget))));`;
const page = (bg) => `<html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="margin:0;background:${bg}"><main style="padding:24px;font:14px sans-serif;color:${bg === '#0c0c12' ? '#ecebe4' : '#171a21'}"><h1>Quản lý doanh thu</h1><p>Trang nền giả lập của BMQ AI.</p></main><div id="root"></div><script type="module" src="/qa-entry.jsx"></script></body></html>`;

const costBlock = {
  v: 1, kind: 'cost_line', mode: 'example', month: '2026-09',
  line: { classificationId: 'c2', sourceNumber: 'PR-2026-09-000002', sourceDate: '2026-09-14', supplierName: 'Thiên An Sinh', productName: 'Chà lụa lá TVP XL', amount: 5940000, categoryLabel: 'Chi phí bánh mì', categoryCode: 'COGS_BMQ_BREAD', reviewStatus: 'needs_review', confidence: '0', classificationSource: 'fallback' },
  evidence: { stored: true, rule: null, alias: null, aliasStatus: null },
  notes: ['Không có rule nào được gắn với phân loại này; lý do lịch sử không có sẵn và hệ thống không tự suy diễn.'],
  source: { name: 'Supabase.cost_classification_line_details', observedAt: '2026-09-16T21:37:45Z', snapshotId: 'snap-2026-09-16', semanticVersion: 'bmq-cost-classification-v2', selectionRule: 'largest_line_amount_then_source_date_then_classification_id', matchCount: 17, truncated: true, disclaimer: 'Không phải báo cáo đã kiểm toán.' },
  followUp: 'line_explanation',
};
const LONG = 'Doanh thu tạm kiểm soát ngày 05/10/2026: 48.250.000 ₫ từ 6 kênh. Kiosk Quận 7 dẫn đầu với 14.900.000 ₫, tiếp theo là GrabFood 9.120.000 ₫ và ShopeeFood 7.880.000 ₫. Mã tham chiếu dài để thử xuống dòng: BMQ-REVENUE-LEDGER-2026-10-05-KIOSK-Q7-000123456789.';
const RETIRED = ['rgb(109, 74, 255)', 'rgb(98, 70, 234)', 'rgb(139, 92, 246)', 'rgb(182, 108, 255)', 'rgb(94, 67, 199)', 'rgb(104, 71, 232)', 'rgb(235, 231, 255)', 'rgb(247, 245, 255)', 'rgb(170, 111, 255)', 'rgb(104, 69, 238)'];

const server = await createServer({
  root: web, configFile: false, esbuild: { jsx: 'automatic' },
  define: { 'import.meta.env.VITE_BMQ_ANALYTICS_ENABLED': JSON.stringify('true') },
  cacheDir: `${out}/.vite-cache`,
  server: { host: '127.0.0.1', port: 5461 },
  resolve: { alias: { '@': `${web}/src` } },
  plugins: [{
    name: 'fixture', enforce: 'pre',
    resolveId(id) { if (id === '/qa-entry.jsx') return '\0entry'; if (id.endsWith('/src/contexts/AuthContext') || id === '@/contexts/AuthContext') return '\0auth'; if (id.endsWith('/src/integrations/supabase/client') || id === '@/integrations/supabase/client') return '\0db'; },
    load(id) { if (id === '\0auth') return auth; if (id === '\0db') return mock; if (id === '\0entry') return entry; },
    configureServer(s) { s.middlewares.use((req, res, next) => { const m = /^\/qa-(light|dark)\.html/.exec(req.url || ''); if (!m) return next(); res.setHeader('Content-Type', 'text/html'); res.end(page(m[1] === 'dark' ? '#0c0c12' : '#f5f6f8')); }); },
  }],
});
await server.listen();

const results = [];
const browser = await chromium.launch({ headless: true, executablePath: CHROME });
try {
  for (const width of [320, 390, 1440]) {
    const height = width >= 1024 ? 900 : 844;
    const p = await browser.newPage({ viewport: { width, height } });
    p.setDefaultTimeout(10000);
    const errors = [];
    p.on('pageerror', (error) => errors.push(error.message));
    const record = { width, checks: {} };
    const shot = (name) => p.screenshot({ path: `${out}/${width}-${name}.png` });
    const sheet = () => p.locator('[data-vnagent-theme="vn-2026-10"]');
    const geometry = async (label) => {
      // Let the sheet slide-in (finite animations) settle before measuring.
      await p.waitForFunction(() => document.getAnimations().every((a) => a.effect?.getTiming().iterations === Infinity || a.playState !== 'running'));
      const g = await p.evaluate(() => {
        const s = document.querySelector('[data-vnagent-theme="vn-2026-10"]');
        const send = document.querySelector('[data-vnagent-send]')?.getBoundingClientRect();
        const input = document.querySelector('[data-vnagent-composer]')?.getBoundingClientRect();
        const wide = s ? [...s.querySelectorAll('*')].filter((el) => { const r = el.getBoundingClientRect(); return r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1); }).map((el) => el.outerHTML.slice(0, 80)) : [];
        return { pageOverflow: document.documentElement.scrollWidth - window.innerWidth, wide, send: send && { right: send.right, bottom: send.bottom, w: send.width }, input: input && { w: input.width } };
      });
      assert.ok(g.pageOverflow <= 1, `${label}@${width}: page overflow ${g.pageOverflow}`);
      assert.deepEqual(g.wide, [], `${label}@${width}: elements outside viewport`);
      if (g.send) {
        assert.ok(g.send.right <= width && g.send.bottom <= height, `${label}@${width}: send button clipped`);
        assert.ok(g.send.w >= 44, `${label}@${width}: send touch target`);
      }
      return g;
    };
    const noViolet = async (label) => {
      const hits = await p.evaluate((retired) => [...document.querySelectorAll('[data-vnagent-theme] *, [data-vnagent-launcher], [data-vnagent-launcher] *')].flatMap((el) => {
        const cs = getComputedStyle(el); const svgFill = el instanceof SVGElement ? cs.fill : '';
        return [cs.color, cs.backgroundColor, cs.borderTopColor, svgFill].filter((v) => retired.some((r) => v.includes(r))).map((v) => `${el.tagName}:${v}`);
      }), RETIRED);
      assert.deepEqual(hits, [], `${label}@${width}: retired violet rendered`);
    };

    // Closed launcher on a light page and a dark page.
    for (const bg of ['dark', 'light']) {
      await p.goto(`http://127.0.0.1:5461/qa-${bg}.html`);
      await p.getByRole('button', { name: 'Mở VNAgent' }).waitFor();
      await p.evaluate(() => document.fonts.ready);
      await noViolet(`launcher-${bg}`);
      await shot(`launcher-${bg}`);
    }
    const launcher = await p.evaluate(() => { const b = document.querySelector('[data-vnagent-launcher]'); const cs = getComputedStyle(b); return { bg: cs.backgroundColor, mark: document.querySelector('[data-vnagent-mark] path') && getComputedStyle(document.querySelector('[data-vnagent-mark] path')).fill, bar: getComputedStyle(document.querySelector('[data-vnagent-mark] rect')).fill }; });
    assert.equal(launcher.bg, 'rgb(12, 12, 18)', 'launcher ink background');
    assert.equal(launcher.mark, 'rgb(214, 243, 60)', 'lime V');
    assert.equal(launcher.bar, 'rgb(255, 75, 31)', 'red bar');
    record.checks.launcher = launcher;

    // Empty state.
    await p.getByRole('button', { name: 'Mở VNAgent' }).click();
    await sheet().waitFor();
    await p.getByText('Gợi ý nhanh').waitFor();
    await p.waitForTimeout(400);
    await p.evaluate(() => document.fonts.ready);
    const look = await p.evaluate(() => {
      const s = document.querySelector('[data-vnagent-theme="vn-2026-10"]');
      const title = document.querySelector('[data-vnagent-wordmark]');
      const agent = title.querySelector('span');
      return { bg: getComputedStyle(s).backgroundColor, font: getComputedStyle(s).fontFamily, archivoLoaded: document.fonts.check('900 19px Archivo'), title: title.textContent, agentColor: getComputedStyle(agent).color, sendBg: getComputedStyle(document.querySelector('[data-vnagent-send]')).backgroundColor };
    });
    assert.equal(look.bg, 'rgb(12, 12, 18)', 'ink canvas');
    assert.match(look.font, /Archivo/, 'Archivo font stack');
    assert.equal(look.title, 'VNAGENT', 'wordmark');
    assert.equal(look.agentColor, 'rgb(255, 75, 31)', 'AGENT in red');
    const status = await p.evaluate(() => { const line = document.querySelector('[data-vnagent-status-line]'); const [dot, label] = line.children; const d = dot.getBoundingClientRect(); const buttons = [...document.querySelectorAll('[data-vnagent-theme] header button')].map((b) => b.getBoundingClientRect().left); return { dotW: d.width, dotH: d.height, labelRight: label.getBoundingClientRect().right, firstButton: Math.min(...buttons), ellipsis: getComputedStyle(label).textOverflow }; });
    assert.equal(status.dotW, status.dotH, 'status dot stays round');
    assert.ok(status.labelRight <= status.firstButton, `status label must not run under header buttons @${width}`);
    record.checks.status = status;
    record.checks.look = look;
    await geometry('empty'); await noViolet('empty');
    await shot('empty');

    // Responding.
    const input = p.locator('[data-vnagent-composer]');
    await p.getByRole('button', { name: 'Doanh thu hôm nay' }).click();
    await p.getByText('VNAgent đang xử lý…').waitFor();
    const userBubble = await p.evaluate(() => { const el = [...document.querySelectorAll('[data-vnagent-theme] div')].find((d) => d.textContent === 'Doanh thu hôm nay' && d.className.includes('bg-vn-cobalt')); return el && getComputedStyle(el).backgroundColor; });
    assert.equal(userBubble, 'rgb(42, 47, 240)', 'cobalt user bubble');
    await geometry('responding'); await shot('responding');

    // Answered (long answer + details).
    await p.evaluate((answer) => window.reply({ answer, details: 'Nguồn: sổ doanh thu tạm kiểm soát · 6 kênh · cập nhật 06:00.' }), LONG);
    await p.getByText(LONG.slice(0, 40), { exact: false }).waitFor();
    await input.fill('So với tuần trước thì sao?');
    await geometry('answered'); await noViolet('answered');
    await shot('answered');

    // Error.
    await p.getByRole('button', { name: 'Gửi tin nhắn', exact: true }).click();
    await p.evaluate(() => window.fail('Kho dữ liệu đang bận. Anh thử lại sau ít phút.'));
    await p.getByRole('alert').waitFor();
    await geometry('error'); await noViolet('error');
    await shot('error');

    // Cost card.
    await input.fill('Lấy một dòng chi phí làm ví dụ');
    await p.getByRole('button', { name: 'Gửi tin nhắn', exact: true }).click();
    await p.evaluate((block) => window.reply({ answer: 'Dòng chi phí ví dụ', lane: 'cost', costBlock: block }), costBlock);
    const card = p.locator('[data-bmq-business-block-mode="example"]');
    await card.waitFor();
    await card.locator('summary').click();
    await card.scrollIntoViewIfNeeded();
    const cardBg = await card.evaluate((el) => getComputedStyle(el).backgroundColor);
    assert.equal(cardBg, 'rgb(21, 22, 31)', 'cost card dark surface');
    await geometry('cost'); await noViolet('cost');
    await shot('cost');

    // Reset returns to the empty state.
    await p.getByRole('button', { name: 'Tạo cuộc trò chuyện mới' }).click();
    await p.getByText('Gợi ý nhanh').waitFor();
    record.checks.reset = true;

    assert.deepEqual(errors, [], `page errors @${width}`);
    record.pass = true;
    results.push(record);
    await p.close();
  }
} finally {
  await browser.close();
  await server.close();
  writeFileSync(`${out}/qa-results.json`, JSON.stringify(results, null, 2));
}
console.log(`qa_chat_reskin: ${results.length}/3 widths pass`);
console.log(JSON.stringify(results.map((r) => ({ width: r.width, archivo: r.checks.look.archivoLoaded, font: r.checks.look.font }))));
