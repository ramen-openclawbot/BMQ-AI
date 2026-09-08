import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { chromium } from '/home/ubuntu/bmq-payment-preview/node_modules/playwright/index.mjs';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const artifacts = '/tmp/header-language-qa';
const deps = '/home/ubuntu/projects/BMQ-AI/apps/web/node_modules';
const origin = 'http://127.0.0.1:4195';
await mkdir(artifacts, { recursive: true });
await writeFile(`${artifacts}/index.html`, '<html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head><body><div id="root"></div><script type="module" src="/fixture.tsx"></script></body></html>');
await writeFile(`${artifacts}/auth.ts`, `export const useAuth = () => ({user: {email: 'staff@example.invalid'}, profile: {full_name: 'Synthetic Staff'}, signOut: () => {window.__signOutCalls = (window.__signOutCalls || 0) + 1;}});`);
await writeFile(`${artifacts}/fixture.tsx`, `import React from 'react';
import {createRoot} from 'react-dom/client';
import {Header} from '${web}/src/components/layout/Header';
import {LanguageProvider, useLanguage} from '${web}/src/contexts/LanguageContext';
import '${web}/src/index.css';
function Labels() { const {t} = useLanguage(); return <main style={{padding: 16}}><p>Isolated Header QA · synthetic staff</p><h1 data-testid="section">{t.sectionMarketingSales}</h1><p data-testid="dashboard">{t.dashboard}</p><p data-testid="settings">{t.settings}</p></main>; }
createRoot(document.getElementById('root')!).render(<LanguageProvider><Header/><Labels/></LanguageProvider>);`);
await writeFile(`${artifacts}/vite.config.mjs`, `import {createRequire} from 'node:module';
const require = createRequire('${web}/package.json');
const react = require('@vitejs/plugin-react-swc');
const tailwind = require('tailwindcss');
const autoprefixer = require('autoprefixer');
import theme from '${web}/tailwind.config.ts';
export default {root: '${artifacts}', plugins:[react()], resolve:{alias:[{find:'@/contexts/AuthContext',replacement:'${artifacts}/auth.ts'},{find:'@',replacement:'${web}/src'},{find:'react-dom/client',replacement:'${deps}/react-dom/client.js'},{find:'react',replacement:'${deps}/react'}]}, css:{postcss:{plugins:[tailwind({...theme,content:['${web}/src/**/*.{ts,tsx}']}),autoprefixer()]}}, server:{host:'127.0.0.1',port:4195,strictPort:true,fs:{allow:['${web}','${artifacts}','${deps}']}}};`);
const server = spawn(process.execPath, [`${deps}/vite/bin/vite.js`, '--config', `${artifacts}/vite.config.mjs`], {cwd:web, stdio:['ignore','pipe','pipe']});
let serverLog = '';
server.stdout.on('data', d => serverLog += d);
server.stderr.on('data', d => serverLog += d);
let browser;
const results = [];
try {
  for (let i=0; i<100; i++) {
    if (server.exitCode !== null) throw new Error(serverLog);
    if (serverLog.includes('http://127.0.0.1:4195')) break;
    await new Promise(r => setTimeout(r,100));
  }
  assert.match(serverLog, /http:\/\/127.0.0.1:4195/);
  browser = await chromium.launch({executablePath:'/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux/chrome',headless:true,args:['--no-sandbox']});
  for (const width of [320,390,1440]) {
    const context = await browser.newContext({viewport:{width,height:900},hasTouch:width<500});
    const blocked = [];
    await context.route('**/*', route => {
      const url = route.request().url();
      if (!url.startsWith(origin + '/')) { blocked.push(url); return route.abort(); }
      return route.continue();
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin);
    await page.locator('header').waitFor();
    const en = page.getByRole('button',{name:'English',exact:true});
    const vn = page.getByRole('button',{name:'Tiếng Việt',exact:true});
    assert.deepEqual({section:await page.getByTestId('section').textContent(), en:await en.count(), vn:await vn.count()}, {section:'Bán Hàng và Tiếp Thị',en:1,vn:1});
    await en.waitFor({timeout:3000});
    assert.equal(await vn.getAttribute('aria-pressed'),'true');
    assert.equal(await page.locator('[data-header-language="en-vi-v1"]').count(),1);
    await en.focus();
    await page.keyboard.press('Tab');
    assert.ok(await vn.evaluate(el => el === document.activeElement));
    assert.notEqual(await vn.evaluate(el => getComputedStyle(el).boxShadow),'none');
    const requests = [];
    page.on('request', r => requests.push(r.url()));
    const initialURL = page.url();
    for (const [button, other, code, dashboard, settings] of [[en,vn,'en','Dashboard','Settings'],[vn,en,'vi','Tổng quan','Cài đặt']]) {
      await button.focus();
      await page.keyboard.press(code === 'en' ? 'Enter' : 'Space');
      await page.waitForFunction(c => localStorage.getItem('app-language') === c, code);
      assert.equal(await button.getAttribute('aria-pressed'),'true');
      assert.equal(await other.getAttribute('aria-pressed'),'false');
      assert.equal(await page.getByTestId('dashboard').textContent(),dashboard);
      assert.equal(await page.getByTestId('settings').textContent(),settings);
      assert.equal(await page.getByTestId('section').textContent(),code === 'vi' ? 'Bán Hàng và Tiếp Thị' : 'Sale & Marketing');
      assert.equal(page.url(),initialURL);
      assert.equal(await page.evaluate(() => window.__signOutCalls || 0),0);
      for (const target of [en,vn]) {
        const box = await target.boundingBox();
        assert.ok(box.width>=44 && box.height>=44, JSON.stringify(box));
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const boxes = await page.locator('header button').evaluateAll(elements => elements.map(el => el.getBoundingClientRect()).filter(r => r.width>0).map(r => ({left:r.left,right:r.right,top:r.top,bottom:r.bottom})));
      for (let i=0;i<boxes.length;i++) {
        assert.ok(boxes[i].left>=0 && boxes[i].right<=width);
        if(i>0) assert.ok(boxes[i-1].right<=boxes[i].left, 'Header controls must not overlap');
      }
      await page.locator('header button').filter({has:page.locator('span', {hasText:'S'})}).click();
      await page.getByRole('menuitem',{name:code==='en'?'Sign Out':'Đăng xuất',exact:true}).waitFor();
      await page.getByRole('menuitem').focus();
      await page.keyboard.press('Escape');
      await page.getByRole('menuitem').waitFor({state:'hidden'});
      await page.locator('header button[data-state="closed"]').waitFor();
      const colors = await Promise.all([button,other].map(b => b.evaluate(el => getComputedStyle(el).backgroundColor)));
      assert.notEqual(...colors);
    }
    assert.deepEqual(requests,[], 'Language changes must not send requests');
    for (const code of ['en','vi']) {
      const target = code === 'en' ? en : vn;
      if (width<500) await target.tap(); else await target.click();
      await page.waitForFunction(c => localStorage.getItem('app-language') === c,code);
      await page.reload();
      await page.locator('header').waitFor();
      assert.equal(await target.getAttribute('aria-pressed'),'true');
      assert.equal(await page.getByTestId('dashboard').textContent(),code==='en'?'Dashboard':'Tổng quan');
      await page.screenshot({path:`${artifacts}/header-${width}-${code}.png`,fullPage:true});
    }
    if (width<500) {
      await page.evaluate(() => {window.__menuCalls=0;window.addEventListener('bmq:open-sidebar',() => window.__menuCalls++);});
      await page.getByRole('button',{name:'Mở menu',exact:true}).click();
      assert.equal(await page.evaluate(() => window.__menuCalls),1);
    }
    await page.locator('header button').filter({has:page.locator('span', {hasText:'S'})}).click();
    await page.getByRole('menuitem',{name:'Đăng xuất'}).waitFor();
    await page.getByRole('menuitem',{name:'Đăng xuất'}).click();
    assert.equal(await page.evaluate(() => window.__signOutCalls),1);
    assert.deepEqual(errors,[]);
    results.push({width,status:'PASS',blockedExternal:[...new Set(blocked)]});
    await context.close();
  }
  console.log(JSON.stringify(results,null,2));
  await writeFile(`${artifacts}/results.json`,JSON.stringify(results,null,2));
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await new Promise(resolve => {if (server.exitCode !== null) resolve();else server.once('exit',resolve);});
  await writeFile(`${artifacts}/vite.log`,serverLog);
}
