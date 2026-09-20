#!/usr/bin/env node
// Browser QA for the VNAgent data-assets admin. It boots the REAL page with the
// owner-only route shell, a complete fixture store and the real edge handler, then
// checks the approved hierarchy (title, prominent export, real daily chart with
// stock/new + 7/30/90), every sidebar panel and responsive overflow at
// 320/390/768/1440.
//
// The fixture deliberately keeps the BMQ app language Vietnamese (LanguageContext
// + the `app-language` localStorage key) to prove two things at once: the admin
// renders its own English chrome, and raw captured questions stay verbatim.
//
// Playwright-core is not a repo dependency; point PLAYWRIGHT_CORE at it:
//   PLAYWRIGHT_CORE=/path/to/playwright-core/index.mjs \
//     node apps/web/scripts/qa_vnagent_data_admin_ui.mjs
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(web, "..", "..", "generated", "data-admin", "owner-ui");
mkdirSync(out, { recursive: true });

const playwrightPath = process.env.PLAYWRIGHT_CORE;
if (!playwrightPath || !existsSync(playwrightPath)) {
  console.error("Set PLAYWRIGHT_CORE to playwright-core/index.mjs");
  process.exit(2);
}

const { createServer } = await import(join(web, "node_modules/vite/dist/node/index.js"));
const { webkit } = await import(playwrightPath);

const fixture = `
import { createDataAdminHandler } from '/@fs${web}/supabase/functions/vnagent-data-admin/handler.ts';
const metrics={asOf:'2026-09-20',timezone:'Asia/Ho_Chi_Minh',assets:{raw:12,curated:4,gold:3,total:19},createdToday:3,promotionsToday:{rawToCurated:1,curatedToGold:1,demotions:0},promotions7d:{rawToCurated:4,curatedToGold:3},collected:{today:2,last7d:10,total:12},reviewed:{verified:3,pending:4,rejected:0,notEvaluated:12,denominator:19},unknown:{abstainedToday:1,abstainedTotal:2,errorsToday:0,errorsTotal:1},sourceContributions:{operational_chat:10,contributor:7,synthetic:2,total:19},scopeNote:'Fixture only'};
const days=[];
for(let i=0;i<30;i++){const raw=Math.max(0,12-i%5);days.push({date:'2026-09-'+String(i+1).padStart(2,'0'),stock:{raw,curated:4,gold:3,total:raw+7},inflow:{raw:i%3,curated:i%2,gold:i%4}});}
const timeseries={from:'2026-08-22',to:'2026-09-20',timezone:'Asia/Ho_Chi_Minh',days,sourceContributions:metrics.sourceContributions};
const asset=(over)=>({id:'11111111-1111-1111-1111-111111111111',tenant:'bmq',dataset_stage:'raw',source_kind:'contributor',source_designation:'manual',interaction_id:null,question:'Doanh thu có kiểm soát hôm nay?',source_answer:'Doanh thu hôm nay là 1.000.000đ',expected_intent:{intent:'tra cứu doanh thu'},expected_filters:{range:'today'},provenance:{executedFilters:{metrics:['controlled_revenue']}},snapshot_at:'2026-09-20T01:00:00.000Z',effective_at:'2026-09-20T01:00:00.000Z',evaluation_status:'not_evaluated',verified_intent:null,verified_conditions:null,evidence:[],reviewer_id:null,version:1,dedupe_key:'k1',created_by:'fixture-owner',created_at:'2026-09-20T01:00:00.000Z',updated_at:'2026-09-20T01:00:00.000Z',...over});
const gold=asset({id:'22222222-2222-2222-2222-222222222222',dataset_stage:'curated',evaluation_status:'pending_review',dedupe_key:'k2',version:2});
const rows=[asset(),gold];
const jev=[{id:'j1',request_id:'req-1',model:'jev-1',prompt_version:'p3',registry_version:'r7',attempted:true,decided:true,screen:'pass',circuit:'closed',metric:'dealer_order_count',metric_probability:0.99,period:'this_week',period_probability:0.98,support:'supported_unqualified',support_probability:0.97,threshold:0.8,fallback:null,cost:null,token_counts:{input:500,output:20},stage_timings:{totalMs:200},counts:{warehouseReads:2},decision:'dealer_order_count',created_at:'2026-09-20T03:00:00.000Z'}];
const store={metrics:async()=>metrics,timeseries:async()=>timeseries,listAssets:async()=>({rows,total:rows.length}),listExportAssets:async(f)=>({rows:rows.filter(r=>!f.assetIds||f.assetIds.includes(r.id)),total:rows.length}),getAsset:async(id)=>rows.find(r=>r.id===id)??null,createAsset:async()=>({status:'duplicate',asset:rows[0]}),transitionAsset:async()=>({...gold,dataset_stage:'gold',evaluation_status:'verified',reviewer_id:'fixture-owner'}),listJev:async()=>jev};
const handle=createDataAdminHandler({enabled:()=>true,authenticate:async()=>({userId:'fixture-owner',role:'owner',store}),now:()=>new Date('2026-09-20T10:00:00Z'),captureEnabled:()=>true,audit:()=>{}});
export const supabase={functions:{invoke:async(name,{body})=>{window.calls.push(body);const r=await handle(new Request('https://fixture.test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}));const data=await r.json();return r.ok?{data,error:null}:{data:null,error:new Error(data.error)}}}};window.calls=[];
`;
const auth = `export const useAuth=()=>({isOwner:true,authzLoaded:true,user:{id:'fixture-owner'},session:{access_token:'fixture-only'}});`;
const lang = `export const useLanguage=()=>({language:'vi',t:x=>x});`;
const entry = `import React from 'react';import{createRoot}from'react-dom/client';import Page from '/@fs${web}/src/pages/VNAgentDataAdmin.tsx';import '/@fs${web}/src/index.css';createRoot(document.getElementById('root')).render(React.createElement(Page));`;

process.chdir(web);
const server = await createServer({
  root: web,
  configFile: false,
  esbuild: { jsx: "automatic" },
  cacheDir: join(out, ".vite"),
  resolve: { alias: { "@": join(web, "src") } },
  server: { host: "127.0.0.1", port: 5419 },
  plugins: [{
    name: "qa",
    enforce: "pre",
    resolveId(id) {
      if (id === "/qa-entry.jsx") return "\0entry";
      if (id === "@/contexts/AuthContext" || id.endsWith("/src/contexts/AuthContext")) return "\0auth";
      if (id === "@/contexts/LanguageContext" || id.endsWith("/src/contexts/LanguageContext")) return "\0lang";
      if (id === "@/integrations/supabase/client" || id.endsWith("/src/integrations/supabase/client")) return "\0db";
      return null;
    },
    load(id) { return { "\0entry": entry, "\0auth": auth, "\0lang": lang, "\0db": fixture }[id]; },
    configureServer(s) {
      s.middlewares.use((req, res, next) => {
        if (req.url === "/") { res.setHeader("Content-Type", "text/html"); res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/qa-entry.jsx"></script>'); } else next();
      });
    },
  }],
});

await server.listen();
const browser = await webkit.launch({ headless: true });
const results = [];
const failures = [];
try {
  for (const width of [320, 390, 768, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 1000 } });
    // The fixture app language is Vietnamese both through LanguageContext (see the
    // `lang` module below) and through the shared `app-language` localStorage key.
    // The owner admin must still render its own English chrome.
    await context.addInitScript(() => { try { window.localStorage.setItem("app-language", "vi"); } catch { /* ignore */ } });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("http://127.0.0.1:5419/");
    await page.locator("[data-vnagent-data-admin]").waitFor();
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(out, `${width}-overview.png`), fullPage: true });

    const shell = page.locator("[data-vnagent-data-admin]").first();
    const title = await page.locator(".da-title").first().textContent();
    const langAttr = await shell.getAttribute("data-da-language");
    const chrome = await shell.innerText();
    const exportCta = await page.locator("[data-da-export-cta]").first().isVisible();
    const chartVisible = await page.locator(".da-chart").first().isVisible();

    // Range selector + stock/new toggle really change the series label.
    await page.getByRole("button", { name: "90 days" }).click();
    await page.waitForTimeout(300);
    const daysAttr = await page.locator("[data-da-chart-days]").first().getAttribute("data-da-chart-days");
    await page.getByRole("button", { name: "New", exact: true }).click();
    await page.waitForTimeout(200);
    const modeAttr = await page.locator("[data-da-chart-mode]").first().getAttribute("data-da-chart-mode");
    const contributions = await page.locator("[data-da-contribution]").count();

    const sections = [];
    for (const label of ["Repository", "Review queue", "Contributions", "Jev logs", "Markdown export"]) {
      await page.getByRole("button", { name: label, exact: true }).click();
      await page.waitForTimeout(200);
      sections.push({ label, alerts: await page.getByRole("alert").allTextContents(), overflow: await page.evaluate(() => document.documentElement.scrollWidth > innerWidth) });
    }
    // The captured question is Vietnamese fixture data: the English chrome must
    // never translate or rewrite it.
    await page.getByRole("button", { name: "Repository", exact: true }).click();
    await page.locator(".da-question").first().waitFor();
    const rawQuestion = (await page.locator(".da-question").first().textContent()) ?? "";
    // Header export CTA navigates to the export panel.
    await page.locator("[data-da-export-cta]").first().click();
    await page.waitForTimeout(150);
    const exportPanel = await page.locator('[data-da-panel="export"]').isVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    await page.screenshot({ path: join(out, `${width}-data-admin.png`), fullPage: true });
    results.push({ width, title, langAttr, chromeVietnamese: chrome.includes("Tài sản dữ liệu"), rawQuestion, exportCta, chartVisible, daysAttr, modeAttr, contributions, exportPanel, overflow, errors, sections });
    await context.close();
  }
} finally {
  await browser.close();
  await server.close();
}

for (const result of results) {
  if (result.title !== "Data assets") failures.push(`width ${result.width}: title was ${result.title}`);
  if (result.langAttr !== "en") failures.push(`width ${result.width}: admin language marker was ${result.langAttr}, expected en`);
  if (result.chromeVietnamese) failures.push(`width ${result.width}: Vietnamese chrome leaked into the English admin`);
  if (!(result.rawQuestion || "").includes("Doanh thu có kiểm soát hôm nay?")) failures.push(`width ${result.width}: raw Vietnamese question was altered (${JSON.stringify(result.rawQuestion)})`);
  if (!result.exportCta) failures.push(`width ${result.width}: header export CTA not visible`);
  if (!result.chartVisible) failures.push(`width ${result.width}: chart not visible`);
  if (result.daysAttr !== "90") failures.push(`width ${result.width}: 90-day selector did not apply (${result.daysAttr})`);
  if (result.modeAttr !== "new") failures.push(`width ${result.width}: stock/new toggle did not apply (${result.modeAttr})`);
  if (result.contributions < 4) failures.push(`width ${result.width}: source contribution chips missing`);
  if (!result.exportPanel) failures.push(`width ${result.width}: export CTA did not open the export panel`);
  if (result.overflow) failures.push(`width ${result.width}: horizontal page overflow`);
  if (result.errors.length) failures.push(`width ${result.width}: page errors ${JSON.stringify(result.errors)}`);
  for (const section of result.sections) {
    if (section.alerts.length) failures.push(`width ${result.width} "${section.label}": unexpected alerts ${JSON.stringify(section.alerts)}`);
    if (section.overflow) failures.push(`width ${result.width} "${section.label}": horizontal overflow`);
  }
}

writeFileSync(join(out, "report.json"), JSON.stringify({ results, failures }, null, 2));
console.log(JSON.stringify({ widths: results.map((r) => ({ width: r.width, title: r.title, langAttr: r.langAttr, rawQuestion: r.rawQuestion, daysAttr: r.daysAttr, modeAttr: r.modeAttr, contributions: r.contributions, exportPanel: r.exportPanel, overflow: r.overflow })), failures }, null, 2));
if (failures.length) { console.error(`UI QA FAILED: ${failures.length}`); process.exit(1); }
console.log("UI QA PASSED");
