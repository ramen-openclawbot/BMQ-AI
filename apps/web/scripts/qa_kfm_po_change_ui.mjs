/** Fixture-only UI QA for the KFM quantity-change card and the Cổng KFM page.
 * Every network call is intercepted; nothing reaches KFM or Supabase.
 * Usage: node scripts/qa_kfm_po_change_ui.mjs   (KFM_QA_OUT, KFM_QA_WIDTHS optional)
 */
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = process.env.KFM_QA_OUT || path.join(root, ".qa-kfm-po-change");
fs.mkdirSync(out, { recursive: true });
const server = await createServer({ root, configFile: false, envDir: out, logLevel: "error",
  define: { "import.meta.env.VITE_SUPABASE_URL": JSON.stringify("http://fixture.invalid") },
  cacheDir: path.join(out, ".vite"), server: { host: "127.0.0.1", port: 5198 },
  resolve: { alias: { "@/integrations/supabase/client": "\0fixture-auth", "@": root + "/src" } },
  plugins: [{
    name: "kfm-change-fixtures",
    resolveId(id) { if (id === "\0fixture-auth") return id; if (id === "/__app.jsx") return root + id; },
    load(id) {
      if (id === "\0fixture-auth") return 'export const supabase={auth:{getSession:async()=>({data:{session:{access_token:"isolated-fixture"}}})}};';
      if (id === root + "/__app.jsx") return `import React from'react';import{createRoot}from'react-dom/client';import{QueryClient,QueryClientProvider}from'@tanstack/react-query';import{MemoryRouter}from'react-router-dom';import KfmPoIntake from'@/components/production/KfmPoIntake';import KfmPrintWorkspace from'@/components/production/KfmPortalDialog';import{Button}from'@/components/ui/button';import'@/index.css';import'@/styles/bmq-production.css';import'@/styles/bmq-kfm-delivery.css';document.documentElement.classList.add('bmq-d3');
        const view=new URLSearchParams(location.search).get('view');
        const awaiting=window.qaAwaiting||[];
        function App(){return <QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter><main className="p-3 md:p-6">{view==='portal'?<KfmPrintWorkspace isVi={true}/>:<div className="d3-pp min-w-0" data-bmq-production-layout="demo3-v2"><header className="d3-pp-head"><div className="d3-pp-titles"><h1>Xưởng <b>Q7</b></h1><p className="d3-pp-tag">Sản xuất · hôm nay 06/11 · chuẩn bị giao 07/11</p></div><div className="d3-pp-actions sm:flex sm:flex-wrap"><Button variant="outline">Thiết lập SX</Button><Button variant="outline">Màn hình TV</Button><KfmPoIntake canDecide={true} isVi={true} paused={false} awaitingSetup={awaiting} onRefreshAwaitingSetup={async()=>{window.refreshed=(window.refreshed||0)+1;}} onImported={async()=>{}}/><Button variant="outline">Cổng KFM</Button><Button>Tạo kế hoạch SX</Button></div></header></div>}</main></MemoryRouter></QueryClientProvider>}
        createRoot(document.getElementById('root')).render(<App/>);`;
    },
    configureServer(s) { s.middlewares.use(async (req, res, next) => { if (req.url.split("?")[0] !== "/__qa") return next(); res.setHeader("Content-Type", "text/html"); res.end(await s.transformIndexHtml("/__qa", '<html lang="vi"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__app.jsx"></script></body></html>')); }); },
  }, react()],
});
await server.listen();
const baseUrl = server.resolvedUrls.local[0];
const browser = await chromium.launch({ headless: true, channel: process.env.KFM_QA_BROWSER || "chrome" });
const revision = "a".repeat(64);
const change = (extra = {}) => ({ orderId: 8103, code: "PO1002698103", inboxId: "inbox-8103", deliveryDate: "2026-11-07", revision,
  lines: [
    { sku: "11728", productName: "BMQ - BÁNH CROISSANT 160G (40G X 4 CÁI)", unit: "HỘP", oldQty: 70, newQty: 70 },
    { sku: "SP001507", productName: "BMQ - BÁNH CUA PHÔ MAI 90G", unit: "HỘP", oldQty: 210, newQty: 210 },
    { sku: "SP001596", productName: "BMQ - BÁNH CROFFLE 160G (40G X 4 CÁI)", unit: "HỘP", oldQty: 50, newQty: 50 },
    { sku: "SP001986", productName: "BMQ - BÁNH MÌ CHÀ BÔNG 70G", unit: "CÁI", oldQty: 180, newQty: 220 },
    { sku: "SP001987", productName: "BMQ - BÁNH MÌ CHÀ BÔNG CAY 70G", unit: "CÁI", oldQty: 180, newQty: 260 },
  ], oldTotalQty: 690, newTotalQty: 810, productionOrders: [{ id: "o1", productionNumber: "SX-20261107-001", status: "planned" }], blocked: false, ...extra });
const portalOrders = [
  { portalId: 1, code: "PO1002698455", deliveryDate: "2026-11-06", locationName: "KHO QUÁ CẢNH BÁNH TƯƠI KINGFOODMART — 120 NGUYỄN HỮU THỌ, NHÀ BÈ", itemCount: 5, totalQty: 810 },
  { portalId: 2, code: "PO1002697929", deliveryDate: "2026-11-06", locationName: "KHO KINGFOODMART Q7", itemCount: 3, totalQty: 14 },
];
const results = [];
const widths = (process.env.KFM_QA_WIDTHS || "390,1366").split(",").map(Number);
const cases = ["toolbar", "intake-change", "intake-applied", "intake-blocked", "intake-stale", "portal-idle", "portal-ready"];
try {
  for (const width of widths) for (const name of cases) {
    if (process.env.KFM_QA_CASES && !process.env.KFM_QA_CASES.split(",").includes(name)) continue;
    const context = await browser.newContext({ viewport: { width, height: 900 }, deviceScaleFactor: width < 600 ? 2 : 1 });
    const page = await context.newPage(); page.setDefaultTimeout(10000);
    const errors = [], applied = [];
    page.on("pageerror", e => errors.push(e.message));
    await page.route("**/*", r => new URL(r.request().url()).hostname === "127.0.0.1" ? r.continue() : r.abort());
    await page.route("**/functions/v1/**", async route => {
      const body = JSON.parse(route.request().postData() || "{}");
      const reply = value => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(value) });
      if (body.action === "intake-list") return reply({ success: true, vendorId: 1865, count: 0, orders: [], removed: [], warnings: [], changed: [change(name === "intake-blocked" ? { blocked: true, productionOrders: [{ id: "o1", productionNumber: "SX-20261107-001", status: "in_progress" }] } : {})] });
      if (body.action === "intake-apply-change") {
        applied.push(body);
        if (name === "intake-blocked") return reply({ success: true, result: { state: "blocked", status: "blocked", warnings: [{ production_number: "SX-20261107-001", status: "in_progress", message: "Lệnh sản xuất đã bắt đầu; cần xử lý tay." }] } });
        if (name === "intake-stale") return reply({ success: true, result: { state: "changed", message: "PO trên KFM vừa đổi lại. Kiểm tra PO lại rồi xem số mới." } });
        return reply({ success: true, result: { state: "updated", status: "updated", cancelledCount: 1, cancelledOrders: [{ production_number: "SX-20261107-001", status: "cancelled" }], warnings: [] } });
      }
      if (body.action === "list") return reply({ success: true, configured: true, deliveryDate: body.deliveryDate, vendorId: 1865, count: portalOrders.length, orders: portalOrders });
      return reply({ success: false, message: "unexpected " + body.action });
    });
    await page.goto(`${baseUrl}__qa?view=${name.startsWith("portal") ? "portal" : "intake"}`);
    if (name === "toolbar") {
      const check = page.locator("[data-kfm-check-po]");
      await check.waitFor();
      const box = await check.boundingBox();
      const other = await page.getByRole("button", { name: "Cổng KFM" }).boundingBox();
      assert.ok(box.height >= 44 && box.height > other.height, `check button ${box.height}px must be the tallest toolbar control (other ${other.height}px)`);
    } else if (name.startsWith("intake")) {
      await page.getByRole("button", { name: "Kiểm tra PO" }).first().click();
      const card = page.locator("[data-kfm-po-change='v1']");
      await card.waitFor();
      assert.match(await card.innerText(), /690/); assert.match(await card.innerText(), /810/);
      if (name !== "intake-change") {
        const button = card.getByRole("button", { name: /Cập nhật theo KFM/ });
        if (name === "intake-blocked") assert.equal(await button.count(), 0, "blocked change must not offer the update button");
        else {
          await button.click();
          await page.locator(name === "intake-applied" ? "[data-kfm-po-change-result='updated']" : "[data-kfm-po-change-result='changed']").waitFor();
          assert.equal(applied.length, 1); assert.equal(applied[0].orderId, 8103); assert.equal(applied[0].revision, revision); assert.equal(applied[0].vendorId, 1865);
        }
      }
    } else if (name === "portal-ready") {
      await page.getByRole("button", { name: /Làm mới/ }).first().click();
      await page.locator("[data-kfm-order]").first().waitFor();
    } else await page.locator("[data-kfm-idle]").waitFor();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `horizontal overflow ${overflow}px`);
    assert.deepEqual(errors, []);
    await page.waitForTimeout(450);
    const shot = path.join(out, `${width}-${name}.png`);
    await page.screenshot({ path: shot, fullPage: name.startsWith("portal") });
    results.push({ width, name, pass: true });
    await context.close();
  }
} finally { await browser.close(); await server.close(); }
console.log(JSON.stringify({ passed: results.length, out }));
