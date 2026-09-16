/** Actual Q7 page with fixture auth/DB. Verifies portal review -> setup -> atomic RPC.
 *
 * Recovery coverage (2026-09-16): a confirmed KFM PO with no production order must be
 * reachable from the Check PO popup, with a direct production-setup handoff, refreshed
 * on manual scan, and honest empty/error states. All reads/writes are fixtures.
 */
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = process.env.KFM_QA_OUT || path.join(root, ".qa-kfm-intake"); fs.mkdirSync(out, { recursive: true });
const ids = { "@/integrations/supabase/client": "\0db", "@/contexts/AuthContext": "\0auth", "@/contexts/LanguageContext": "\0lang" };
const server = await createServer({ root, configFile: false, cacheDir: path.join(out, ".vite"), server: { host: "127.0.0.1", port: 5197 }, resolve: { alias: { ...ids, "@": root + "/src" } }, plugins: [{
  name: "q7-fixtures",
  resolveId(id) { if (Object.values(ids).includes(id)) return id; if (id === "/__q7.jsx") return root + id; },
  load(id) {
    if (id === "\0lang") return 'export const useLanguage=()=>({language:"vi"});';
    if (id === "\0auth") return 'export const useAuth=()=>({canEditModule:()=>!new URLSearchParams(location.search).has("readonly"),isOwner:false});';
    if (id === "\0db") return `export const supabase={auth:{getSession:async()=>({data:{session:{access_token:'fixture-only'}}})},rpc:async(name,args)=>window.qaRpc(name,args),from(table){const calls=[];const q=new Proxy({},{get(_,method){if(method==='then')return(resolve,reject)=>Promise.resolve(window.qaDb(table,calls)).then(resolve,reject);return(...args)=>{calls.push([method,args]);return q;};}});return q;}};`;
    if (id === root + "/__q7.jsx") return `import React from'react';import{createRoot}from'react-dom/client';import{QueryClient,QueryClientProvider}from'@tanstack/react-query';import{MemoryRouter}from'react-router-dom';import{Toaster}from'sonner';import Page from'@/pages/ProductionPlanning';import'@/index.css';const sidebar=innerWidth>=768?Number(new URLSearchParams(location.search).get('sidebar')||256):0;createRoot(document.getElementById('root')).render(<QueryClientProvider client={new QueryClient({defaultOptions:{queries:{retry:false}}})}><MemoryRouter>{sidebar>0&&<aside style={{position:'fixed',inset:'0 auto 0 0',width:sidebar}} className="border-r bg-card p-3">BMQ</aside>}<div style={{marginLeft:sidebar}}><header className="flex h-16 items-center border-b px-6">Xưởng Q7</header><main className="p-3 md:p-6"><Page/></main></div><Toaster/></MemoryRouter></QueryClientProvider>);`;
  },
  configureServer(s) { s.middlewares.use(async (req, res, next) => { if (req.url.split("?")[0] !== "/__qa") return next(); res.setHeader("Content-Type", "text/html"); res.end(await s.transformIndexHtml("/__qa", '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__q7.jsx"></script></body></html>')); }); },
}, react()] });
await server.listen(); const baseUrl = server.resolvedUrls.local[0]; const browser = await chromium.launch({ headless: true, channel: process.env.KFM_QA_BROWSER || "chrome" }); const results = [];

// Scenario -> viewports actually asserted (mobile phones, desktop with expanded/collapsed sidebar).
const caseViewports = {
  accept: [[390, 0], [1440, 256]],
  resume: [[320, 0], [390, 0], [1440, 256]],
  "missing-sku": [[390, 0]],
  readonly: [[390, 0]],
  recover: [[320, 0], [390, 0], [1440, 256], [1440, 80]],
  "external-import": [[390, 0], [1440, 256]],
  "already-linked": [[390, 0]],
  "load-failure": [[390, 0], [1440, 256]],
  "cancel-scan": [[390, 0]],
};

try {
  for (const [scenario, viewports] of Object.entries(caseViewports)) {
    if (process.env.KFM_QA_CASE && process.env.KFM_QA_CASE !== scenario) continue;
    for (const [width, sidebar] of viewports) {
      const context = await browser.newContext({ viewport: { width, height: 950 } }); const page = await context.newPage(); page.setDefaultTimeout(12000);
      await page.clock.setFixedTime(new Date("2026-09-15T05:00:00Z"));
      const errors = [], actions = []; page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript(({ scenario }) => {
        window.rpcCalls = []; window.dbCalls = [];
        const skuNames = ["BMQ - BÁNH CROISSANT 50G", "BMQ - BÁNH MÌ CHÀ BÔNG 70G", "BMQ - BÁNH FLAN 80G", "BMQ - BÁNH SU KEM 60G", "BMQ - BÁNH DONUT 55G", "BMQ - BÁNH MÌ NGỌT 65G"];
        const skus = skuNames.map((name, index) => ({ id: `sku-${index + 1}`, sku_code: null, product_name: name, unit: "CÁI", sku_type: "finished_good" }));
        const awaitingItems = skus.map((sku, index) => ({ product_name: sku.product_name, qty: 101 + index, unit: "CÁI", unit_price: 10000, line_total: (101 + index) * 10000, date: "2026-09-16", sku_code: null, sku_id: sku.id }));
        const awaitingPo = { id: "inbox-1002648379", po_number: "PO1002648379", from_name: "Kingfoodmart", from_email: "portal@kingfoodmart.com", delivery_date: "2026-09-16", production_items: awaitingItems, total_amount: 0, match_status: "approved", raw_payload: { source: "kfm_portal", kfm_order_id: 2648379, kfm_vendor_id: 1865 } };
        const secondPo = { id: "inbox-2", po_number: "PO2", from_name: "Kingfoodmart", from_email: "portal@kingfoodmart.com", delivery_date: "2026-09-16", production_items: [awaitingItems[0]], total_amount: 1010000, match_status: "approved", raw_payload: { source: "kfm_portal", kfm_order_id: 2, kfm_vendor_id: 1865 } };
        window.pendingPoInbox = { id: "inbox-1", po_number: "PO11", from_name: "Kingfoodmart", from_email: "portal@kingfoodmart.com", delivery_date: "2026-09-16", production_items: [{ product_name: skuNames[0], qty: 110, unit: "CÁI", unit_price: 10000, line_total: 1100000, date: "2026-09-16", sku_code: null, sku_id: "sku-1" }], total_amount: 1100000, match_status: "approved", raw_payload: { source: "kfm_portal", kfm_order_id: 11, kfm_vendor_id: 1865 } };
        window.pendingOrder = { orderId: 11, code: "PO11", deliveryDate: "2026-09-16", locationName: "KHO QUÁ CẢNH", subStatus: 3, state: "pending", revision: "r1", items: [{ productCode: "1001001026356", barcode: "SP001952", productName: skuNames[0], unitName: "CÁI", qty: 110 }] };
        window.fixtureSkus = scenario === "missing-sku" ? [] : skus;
        window.fixtureInbox = []; window.fixtureOrders = []; window.confirmed = false;
        window.linkPo = (inboxId) => { window.fixtureOrders.push({ id: "sx-1", production_number: "SX-20260916-001", source_po_inbox_id: inboxId, status: "planned", location_code: "q7", planned_start_date: "2026-09-16", planned_end_date: "2026-09-16", created_at: "2026-09-16T00:00:00Z", items: [] }); };
        window.externalImport = () => { window.confirmed = true; window.fixtureInbox = [awaitingPo]; };
        if (["resume", "missing-sku", "readonly", "recover", "already-linked"].includes(scenario)) { window.confirmed = true; window.fixtureInbox = scenario === "resume" ? [awaitingPo, secondPo] : [awaitingPo]; }
        window.failTable = scenario === "load-failure" ? "customer_po_inbox" : null;
        window.qaDb = (table, calls) => {
          window.dbCalls.push({ table, calls });
          if (window.failTable === table) return { data: null, error: { message: "fixture read failure" } };
          let data = [];
          if (table === "customer_po_inbox") data = window.fixtureInbox.slice();
          else if (table === "product_skus") data = window.fixtureSkus.slice();
          else if (table === "production_location_sku_settings") data = window.fixtureSkus.map((sku) => ({ sku_id: sku.id, is_enabled: true, location_code: "q7" }));
          else if (table === "production_orders") data = window.fixtureOrders.slice();
          else if (table === "production_order_items") data = window.fixtureOrders.flatMap((order) => order.items || []);
          const single = calls.some(([method]) => method === "single" || method === "maybeSingle");
          for (const [method, args] of calls) {
            if (method === "in") { const [column, values] = args; data = data.filter((row) => values.includes(row[column])); }
            else if (method === "eq") { const [column, value] = args; data = data.filter((row) => row[column] === value); }
          }
          if (single) data = data[0] || null;
          return { data, error: null };
        };
        window.qaRpc = (name, args) => {
          window.rpcCalls.push({ name, args });
          const order = { id: "sx-1", production_number: "SX-20260916-001", source_po_inbox_id: args.p_po_id, status: "planned", planned_start_date: args.p_start_date, planned_end_date: args.p_end_date, created_at: "2026-09-15T05:00:00Z", items: args.p_items.map((item, index) => ({ id: `item-${index}`, production_order_id: "sx-1", product_name: item.product_name, ordered_qty: item.original_qty, planned_qty: item.planned_qty, unit: item.unit, delivery_date: item.date })) };
          window.fixtureOrders.push(order); return { data: { order, reused: false }, error: null };
        };
      }, { scenario });
      await page.route("**/functions/v1/**", async (route) => {
        const body = route.request().postDataJSON(); actions.push(body.action || "material-pdf"); let value;
        if (route.request().url().endsWith("production-material-issue-pdf")) value = { success: true };
        else if (body.action === "intake-list") {
          if (scenario === "cancel-scan") await new Promise((resolve) => setTimeout(resolve, 900));
          const stillPending = scenario === "accept" && !(await page.evaluate(() => window.confirmed));
          value = { success: true, vendorId: 1865, orders: stillPending ? [await page.evaluate(() => window.pendingOrder)] : [] };
        }
        else if (body.action === "intake-decide") { assert.equal(body.decision, "confirm"); await page.evaluate(() => { window.confirmed = true; window.fixtureInbox = [window.pendingPoInbox]; }); value = { success: true, result: { state: "imported", inboxId: "inbox-1" } }; }
        else throw Error("Unexpected request: " + body.action);
        await route.fulfill({ json: value });
      });
      await page.goto(`${baseUrl}__qa?sidebar=${sidebar}${scenario === "readonly" ? "&readonly" : ""}`);
      await page.locator("[data-kfm-po-intake]").waitFor();
      await page.waitForTimeout(150); assert.equal(actions.length, 0, "Q7 entry must not scan KFM");
      const dialog = page.getByRole("dialog");
      const intakeButton = page.getByRole("button", { name: "Kiểm tra PO", exact: true });

      if (scenario === "accept") {
        await intakeButton.click();
        await dialog.getByRole("button", { name: "Xác nhận", exact: true }).waitFor();
        await page.waitForTimeout(250);
        assert.equal(await page.locator('[role="dialog"]:visible').count(), 1);
        assert.equal(await dialog.evaluate((el) => getComputedStyle(el).opacity), "1");
        await page.screenshot({ path: path.join(out, `${width}-${sidebar}-review-settled.png`), animations: "disabled" });
        await dialog.getByRole("button", { name: "Xác nhận", exact: true }).click();
        await dialog.getByText("Xác nhận / điều chỉnh kế hoạch").waitFor();
      } else if (scenario === "resume") {
        const resume = page.locator("[data-kfm-production-resume]"); await resume.waitFor();
        assert.equal(await resume.getByRole("button", { name: "Tiếp tục thiết lập SX" }).count(), 2, "Distinct same-day POs must both remain visible");
        await resume.getByRole("button").first().click();
        await dialog.getByText("Xác nhận / điều chỉnh kế hoạch").waitFor();
      } else if (scenario === "missing-sku") {
        const resume = page.locator("[data-kfm-production-resume]"); await resume.waitFor();
        await resume.getByRole("button").first().click();
        await page.getByText(/Cần khớp \/ bật SKU/).waitFor(); assert.equal(await page.getByRole("dialog").count(), 0);
      } else if (scenario === "readonly") {
        const resume = page.locator("[data-kfm-production-resume]"); await resume.waitFor();
        assert(await resume.getByRole("button").first().isDisabled()); assert.equal(actions.length, 0);
      } else if (scenario === "recover") {
        await intakeButton.click();
        const item = dialog.locator('[data-kfm-awaiting-setup-item="inbox-1002648379"]'); await item.waitFor();
        const itemText = await item.innerText();
        assert(itemText.includes("PO1002648379"), itemText); assert(itemText.includes("2026-09-16"), itemText); assert(itemText.includes("6 dòng sản phẩm"), itemText);
        await page.screenshot({ path: path.join(out, `${width}-${sidebar}-recover-popup.png`), animations: "disabled" });
        await item.getByRole("button", { name: "Tiếp tục thiết lập SX" }).click();
        await dialog.getByText("Xác nhận / điều chỉnh kế hoạch").waitFor();
        assert.equal((await page.evaluate(() => window.rpcCalls)).length, 0, "Opening setup must not write");
        const setup = dialog; assert.equal(await setup.locator("#start-date").inputValue(), "2026-09-16");
        assert.equal(await setup.locator('input[type="number"]').count(), 6, "All six PO lines must reach setup");
        for (const name of ["BÁNH CROISSANT 50G", "BÁNH MÌ CHÀ BÔNG 70G", "BÁNH FLAN 80G", "BÁNH SU KEM 60G", "BÁNH DONUT 55G", "BÁNH MÌ NGỌT 65G"]) assert((await setup.innerText()).includes(name), name);
        await page.screenshot({ path: path.join(out, `${width}-${sidebar}-recover-setup.png`), animations: "disabled" });
        await setup.getByRole("button", { name: "Xác nhận tạo lệnh SX" }).click(); await setup.waitFor({ state: "hidden" });
        const calls = await page.evaluate(() => window.rpcCalls); assert.equal(calls.length, 1); assert.equal(calls[0].name, "create_q7_production_from_po");
        assert.equal(calls[0].args.p_items.length, 6); assert.equal(calls[0].args.p_start_date, "2026-09-16");
        assert.deepEqual(calls[0].args.p_items.map((item) => item.sku_id).sort(), ["sku-1", "sku-2", "sku-3", "sku-4", "sku-5", "sku-6"]);
      } else if (scenario === "external-import") {
        assert.equal(await page.locator("[data-kfm-production-resume]").count(), 0, "Nothing pending before the external import");
        await page.evaluate(() => window.externalImport());
        await intakeButton.click();
        const item = dialog.locator('[data-kfm-awaiting-setup-item="inbox-1002648379"]'); await item.waitFor();
        await item.getByRole("button", { name: "Tiếp tục thiết lập SX" }).click();
        await dialog.getByText("Xác nhận / điều chỉnh kế hoạch").waitFor();
        const setup = dialog; assert.equal(await setup.locator("#start-date").inputValue(), "2026-09-16");
        assert.equal(await setup.locator('input[type="number"]').count(), 6);
        await setup.getByRole("button", { name: "Hủy" }).click(); await setup.waitFor({ state: "hidden" });
      } else if (scenario === "already-linked") {
        await intakeButton.click();
        const item = dialog.locator('[data-kfm-awaiting-setup-item="inbox-1002648379"]'); await item.waitFor();
        await page.evaluate(() => window.linkPo("inbox-1002648379"));
        await item.getByRole("button", { name: "Tiếp tục thiết lập SX" }).click();
        await dialog.getByText(/đã được lập lệnh sản xuất/).waitFor();
        assert.equal(await page.getByText("Xác nhận / điều chỉnh kế hoạch").count(), 0, "Already-linked must not open a setup dialog");
        assert.equal((await page.evaluate(() => window.rpcCalls)).length, 0, "Already-linked must not create anything");
        await page.waitForTimeout(200);
        assert.equal(await dialog.locator("[data-kfm-awaiting-setup-item]").count(), 0, "Already-linked PO must leave the pending list");
        await page.screenshot({ path: path.join(out, `${width}-${sidebar}-already-linked.png`), animations: "disabled" });
        await dialog.getByRole("button", { name: "Đóng" }).click(); await dialog.waitFor({ state: "hidden" });
      } else if (scenario === "load-failure") {
        await page.locator("[data-kfm-pending-error]").waitFor();
        await intakeButton.click();
        await dialog.locator("[data-kfm-awaiting-setup-error]").waitFor();
        assert.equal(await dialog.getByText("Không có PO mới cần duyệt").count(), 0, "A failed read must not read as an empty queue");
        await page.screenshot({ path: path.join(out, `${width}-${sidebar}-load-failure.png`), animations: "disabled" });
        await dialog.getByRole("button", { name: "Đóng" }).click(); await dialog.waitFor({ state: "hidden" });
      } else if (scenario === "cancel-scan") {
        await intakeButton.click();
        await dialog.locator("[data-kfm-intake-progress]").waitFor();
        await dialog.getByRole("button", { name: "Đóng" }).click(); await dialog.waitFor({ state: "hidden" });
        await page.waitForTimeout(1100);
        assert.equal(await dialog.count(), 0, "A late scan must not reopen the popup");
        assert.equal((await page.evaluate(() => window.rpcCalls)).length, 0);
      }

      if (["accept", "resume"].includes(scenario)) {
        const setup = page.getByRole("dialog"); assert.equal(await setup.locator("#start-date").inputValue(), "2026-09-16");
        assert((await setup.innerText()).includes("Đã xác nhận trên KFM"));
        await page.waitForTimeout(250); assert.equal(await page.locator('[role="dialog"]:visible').count(), 1);
        assert(await setup.evaluate((el) => el.contains(document.activeElement)), "Keyboard focus must stay in production setup");
        await page.screenshot({ path: path.join(out, `${width}-${sidebar}-page-${scenario}-setup.png`) });
        await setup.getByRole("button", { name: "Xác nhận tạo lệnh SX" }).click(); await setup.waitFor({ state: "hidden" });
        const calls = await page.evaluate(() => window.rpcCalls); assert.equal(calls.length, 1); assert.equal(calls[0].name, "create_q7_production_from_po");
        if (scenario === "accept") { assert.equal(calls[0].args.p_items[0].original_qty, 110); } else { assert.equal(calls[0].args.p_items.length, 6); }
        assert.equal(calls[0].args.p_start_date, "2026-09-16");
      } else if (scenario !== "recover") assert.equal((await page.evaluate(() => window.rpcCalls)).length, 0);
      const layout = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: innerWidth })); assert(layout.scroll <= width + 1, JSON.stringify(layout));
      const geometry = await page.evaluate(() => { const box = document.querySelector('[role="dialog"]'); const r = box?.getBoundingClientRect(); return r ? { left: r.left, right: r.right } : null; });
      if (geometry) assert(geometry.left >= -1 && geometry.right <= width + 1, JSON.stringify({ geometry, width }));
      assert.deepEqual(errors, []); assert(!actions.includes("create-load")); assert(!actions.includes("po-gmail-sync"));
      await page.waitForTimeout(200); await page.screenshot({ path: path.join(out, `${width}-${sidebar}-page-${scenario}.png`) }); results.push({ width, sidebar, scenario, actions, layout }); await context.close();
    }
  }
  fs.writeFileSync(path.join(out, "qa-page-results.json"), JSON.stringify(results, null, 2)); console.log(JSON.stringify({ passed: results.length, out }));
} finally { await browser.close(); await server.close(); }
