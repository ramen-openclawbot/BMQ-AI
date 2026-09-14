/** Actual Q7 page with fixture auth/DB. Verifies portal review -> setup -> atomic RPC. */
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
const server = await createServer({ root, configFile: false, server: { host: "127.0.0.1", port: 5197 }, resolve: { alias: { ...ids, "@": root + "/src" } }, plugins: [{
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
try {
  for (const [width, sidebar] of [[390, 0], [1366, 256], [1366, 80]]) for (const scenario of ["accept", "resume", "missing-sku", "readonly"]) {
    if (process.env.KFM_QA_CASE && process.env.KFM_QA_CASE !== scenario) continue;
    const context = await browser.newContext({ viewport: { width, height: 950 } }); const page = await context.newPage(); page.setDefaultTimeout(12000);
    await page.clock.setFixedTime(new Date("2026-09-15T05:00:00Z"));
    const errors = [], actions = []; page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(({ scenario }) => {
      window.rpcCalls = []; window.dbCalls = []; window.confirmed = scenario !== "accept";
      const items = [{ product_name: "BMQ - BÁNH CROISSANT 50G", qty: 110, unit: "CÁI", unit_price: 10000, line_total: 1100000, date: "2026-09-19", sku_code: null, sku_id: "sku-1" }];
      window.fixtureInbox = [1, 2].map((id) => ({ id: `inbox-${id}`, po_number: `PO${id}`, from_name: "Kingfoodmart", from_email: "portal@kingfoodmart.com", delivery_date: "2026-09-19", production_items: items, total_amount: 1100000, match_status: "approved", raw_payload: { source: "kfm_portal", kfm_order_id: id, kfm_vendor_id: 1865 } }));
      window.fixtureOrders = [];
      window.qaDb = (table, calls) => {
        window.dbCalls.push({ table, calls }); let data = [];
        if (table === "customer_po_inbox") data = window.confirmed ? window.fixtureInbox : [];
        if (table === "product_skus") data = scenario === "missing-sku" ? [] : [{ id: "wrong-sku", sku_code: null, product_name: "BMQ - BÁNH CROISSANT 50G", unit: "HỘP", sku_type: "finished_good" }, { id: "sku-1", sku_code: null, product_name: "BMQ - BÁNH CROISSANT 50G", unit: "CÁI", sku_type: "finished_good" }];
        if (table === "production_location_sku_settings") data = [{ sku_id: "sku-1", is_enabled: true }];
        if (table === "production_orders") data = window.fixtureOrders;
        if (table === "production_order_items") data = window.fixtureOrders.flatMap((order) => order.items || []);
        for (const [method, args] of calls) { if (method === "eq" && ["id", "source_po_inbox_id"].includes(args[0])) data = data.filter((row) => row[args[0]] === args[1]); }
        if (calls.some(([method]) => ["single", "maybeSingle"].includes(method))) data = data[0] || null;
        return { data, error: null };
      };
      window.qaRpc = (name, args) => {
        window.rpcCalls.push({ name, args });
        const order = { id: "sx-1", production_number: "SX-20260919-001", source_po_inbox_id: args.p_po_id, status: "planned", planned_start_date: args.p_start_date, planned_end_date: args.p_end_date, created_at: "2026-09-15T05:00:00Z", items: args.p_items.map((item, index) => ({ id: `item-${index}`, production_order_id: "sx-1", product_name: item.product_name, ordered_qty: item.original_qty, planned_qty: item.planned_qty, unit: item.unit, delivery_date: item.date })) };
        window.fixtureOrders.push(order); return { data: { order, reused: false }, error: null };
      };
    }, { scenario });
    await page.route("**/functions/v1/**", async (route) => {
      const body = route.request().postDataJSON(); actions.push(body.action || "material-pdf"); let value;
      if (route.request().url().endsWith("production-material-issue-pdf")) value = { success: true };
      else if (body.action === "intake-list") value = { success: true, vendorId: 1865, orders: scenario === "accept" && !(await page.evaluate(() => window.confirmed)) ? [{ orderId: 1, code: "PO1", deliveryDate: "2026-09-19", locationName: "KHO QUÁ CẢNH", subStatus: 3, state: "pending", revision: "r1", items: [{ productCode: "1001001026356", barcode: "SP001952", productName: "BMQ - BÁNH CROISSANT 50G", unitName: "CÁI", qty: 110 }] }] : [] };
      else if (body.action === "intake-decide") { assert.equal(body.decision, "confirm"); await page.evaluate(() => { window.confirmed = true; }); value = { success: true, result: { state: "imported", inboxId: "inbox-1" } }; }
      else throw Error("Unexpected request: " + body.action);
      await route.fulfill({ json: value });
    });
    await page.goto(`${baseUrl}__qa?sidebar=${sidebar}${scenario === "readonly" ? "&readonly" : ""}`);
    await page.locator("[data-kfm-po-intake]").waitFor();
    await page.waitForTimeout(150); assert.equal(actions.length,0,"Q7 entry must not scan KFM");
    if (scenario === "accept") {
      await page.getByRole("button",{name:"Kiểm tra PO",exact:true}).click();
      await page.getByRole("dialog").getByRole("button",{name:"Xác nhận",exact:true}).waitFor();
      await page.waitForTimeout(250);
      assert.equal(await page.locator('[role="dialog"]:visible').count(), 1);
      assert.equal(await page.getByRole("dialog").evaluate((el) => getComputedStyle(el).opacity), "1");
      await page.screenshot({ path: path.join(out, `${width}-${sidebar}-review-settled.png`), animations: "disabled" });
      await page.getByRole("dialog").getByRole("button", { name: "Xác nhận", exact: true }).click();
      await page.getByRole("dialog").getByText("Xác nhận / điều chỉnh kế hoạch").waitFor();
    } else {
      const resume = page.locator("[data-kfm-production-resume]"); await resume.waitFor();
      assert.equal(await resume.getByRole("button", { name: "Tiếp tục thiết lập SX" }).count(), 2, "Distinct same-day POs must both remain visible");
      if (scenario === "readonly") { assert(await resume.getByRole("button").first().isDisabled()); assert.equal(actions.length, 0); }
      else {
        await resume.getByRole("button").first().click();
        if (scenario === "missing-sku") { await page.getByText(/Cần khớp \/ bật SKU/).waitFor(); assert.equal(await page.getByRole("dialog").count(), 0); }
        else await page.getByRole("dialog").getByText("Xác nhận / điều chỉnh kế hoạch").waitFor();
      }
    }
    if (["accept", "resume"].includes(scenario)) {
      const setup = page.getByRole("dialog"); assert.equal(await setup.locator("#start-date").inputValue(), "2026-09-19");
      assert((await setup.innerText()).includes("Đã xác nhận trên KFM"));
      await page.waitForTimeout(250); assert.equal(await page.locator('[role="dialog"]:visible').count(), 1);
      assert(await setup.evaluate(el=>el.contains(document.activeElement)), "Keyboard focus must stay in production setup");
      await page.screenshot({ path: path.join(out, `${width}-${sidebar}-page-${scenario}-setup.png`) });
      await setup.getByRole("button", { name: "Xác nhận tạo lệnh SX" }).click(); await setup.waitFor({ state: "hidden" });
      const calls = await page.evaluate(() => window.rpcCalls); assert.equal(calls.length, 1); assert.equal(calls[0].name, "create_q7_production_from_po"); assert.equal(calls[0].args.p_items[0].original_qty, 110); assert.equal(calls[0].args.p_start_date, "2026-09-19");
    } else assert.equal((await page.evaluate(() => window.rpcCalls)).length, 0);
    const layout = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: innerWidth })); assert(layout.scroll <= width + 1, JSON.stringify(layout));
    assert.deepEqual(errors, []); assert(!actions.includes("create-load")); assert(!actions.includes("po-gmail-sync"));
    await page.waitForTimeout(250); await page.screenshot({ path: path.join(out, `${width}-${sidebar}-page-${scenario}.png`) }); results.push({ width, sidebar, scenario, actions, layout }); await context.close();
  }
  fs.writeFileSync(path.join(out, "qa-page-results.json"), JSON.stringify(results, null, 2)); console.log(JSON.stringify({ passed: results.length, out }));
} finally { await browser.close(); await server.close(); }
