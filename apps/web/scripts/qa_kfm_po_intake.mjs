/** Isolated authenticated UI QA. All network/DB calls are fixtures; never hits KFM. */
import { createServer } from "vite";
import react from "@vitejs/plugin-react-swc";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || "playwright");
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = process.env.KFM_QA_OUT || path.join(root, ".qa-kfm-intake");
fs.mkdirSync(out, { recursive: true });
const server = await createServer({ root, configFile: false, server: { host: "127.0.0.1", port: 5196 }, resolve: { alias: { "@/integrations/supabase/client": "\0fixture-auth", "@": root + "/src" } }, plugins: [{
  name: "kfm-intake-fixtures",
  resolveId(id) { if (id === "\0fixture-auth") return id; if (id === "/__intake.jsx") return root + id; },
  load(id) {
    if (id === "\0fixture-auth") return 'export const supabase={auth:{getSession:async()=>({data:{session:{access_token:"isolated-fixture"}}})}};';
    if (id === root + "/__intake.jsx") return `import React,{useState}from'react';import{createRoot}from'react-dom/client';import KfmPoIntake from'@/components/production/KfmPoIntake';import'@/index.css';
      function App(){const[paused,setPaused]=useState(new URLSearchParams(location.search).has('paused'));window.unpause=()=>setPaused(false);return <main className="p-4"><KfmPoIntake canDecide={!new URLSearchParams(location.search).has('readonly')} isVi={true} paused={paused} onImported={async id=>{window.imported=(window.imported||[]).concat(id);if(window.failImport)throw Error('SKU chưa khớp. PO đã xác nhận trên KFM.');setPaused(true);}}/>{paused&&<div data-production-setup><button onClick={()=>setPaused(false)}>Đóng thiết lập SX</button></div>}</main>};createRoot(document.getElementById('root')).render(<App/>);`;
  },
  configureServer(s) { s.middlewares.use(async (req, res, next) => { if (req.url.split("?")[0] !== "/__qa") return next(); res.setHeader("Content-Type", "text/html"); res.end(await s.transformIndexHtml("/__qa", '<html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/__intake.jsx"></script></body></html>')); }); },
}, react()] });
await server.listen();
const baseUrl = server.resolvedUrls.local[0];
const browser = await chromium.launch({ headless: true, channel: process.env.KFM_QA_BROWSER || "chrome" });
const results = [];
const sample = (id = 11) => ({ orderId: id, code: `PO${id}`, deliveryDate: "2026-09-19", locationName: "KHO QUÁ CẢNH BÁNH TƯƠI — ĐỊA CHỈ KHO RẤT DÀI CẦN XUỐNG HÀNG TRÊN ĐIỆN THOẠI", revision: "r1", subStatus: 3, state: "pending", items: [{ productCode: "1001001026356", productName: "BMQ - BÁNH CROISSANT 50G", unitName: "CÁI", qty: 110 }, { productCode: "1001001026798", productName: "BMQ - BÁNH MÌ CHÀ BÔNG 70G", unitName: "CÁI", qty: 150 }] });
try {
  for (const width of (process.env.KFM_QA_WIDTHS || "320,390,1366,1920").split(",").map(Number)) for (const scenario of ["confirm", "reject", "defer", "timeout", "changed", "import-error", "recover", "readonly", "paused", "empty", "confirmed", "denied", "poll", "checking", "scan-error", "close-scan", "slow-write", "many"]) {
    if (process.env.KFM_QA_CASES && !process.env.KFM_QA_CASES.split(",").includes(scenario)) continue;
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    await page.addInitScript(() => { const timeout = AbortSignal.timeout; AbortSignal.timeout = ms => timeout(ms === 45000 ? 1800 : ms); const original = window.setInterval.bind(window); window.setInterval = (fn, ms, ...args) => { if (ms === 60000) window.intakePoll = fn; return original(fn, ms, ...args); }; });
    const errors = [], actions = []; let decisions = 0, scans = 0;
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/functions/v1/**", async (route) => {
      assert(route.request().url().endsWith("/kfm-portal-sync"));
      const body = route.request().postDataJSON(); actions.push(body.action); let value;
      if (body.action === "intake-list") { scans++;
        if (["checking", "close-scan"].includes(scenario)) await new Promise(resolve=>setTimeout(resolve,1200));
        if (scenario === "scan-error" && scans === 1) { await route.fulfill({status:502,json:{success:false,message:"KFM tạm thời không phản hồi"}}); return; }
        value = { success: true, vendorId: 1865, orders: scenario === "empty" ? [] : scenario === "many" ? Array.from({length:12},(_,i)=>({...sample(i+11),items:Array.from({length:20},()=>sample().items[0])})) : [scenario === "recover" ? { ...sample(), state: "unknown", decision: "confirm" } : scenario === "confirmed" ? { ...sample(), subStatus: 6 } : sample(), sample(12)] }; }
      else if (body.action === "intake-decide") {
        decisions++; assert.equal(body.revision, "r1"); assert.equal(body.vendorId, 1865); assert.match(body.requestId, /^[a-f\d-]{36}$/i);
        await new Promise((resolve) => setTimeout(resolve, 120));
        if (scenario === "slow-write") await new Promise(resolve=>setTimeout(resolve,2400));
        if (scenario === "timeout") { await route.abort("failed"); return; }
        if (scenario === "denied") { await route.fulfill({ status: 403, json: { success: false, message: "Không có quyền duyệt PO." } }); return; }
        if (scenario === "reject") { assert.equal(body.decision, "reject"); assert.equal(body.reason, "Không đủ năng lực sản xuất"); value = { result: { state: "rejected" } }; }
        else if (scenario === "changed") value = { success: false, result: { state: "changed", message: "PO đã thay đổi. Kiểm tra số lượng mới." }, order: { ...sample(), revision: "r2", items: [{ ...sample().items[0], qty: 99 }] } };
        else { assert.equal(body.decision, "confirm"); value = { success: true, result: { state: "imported", inboxId: "inbox-11" } }; }
      } else if (body.action === "intake-result") value = scenario === "denied" ? { success: true, result: { state: "changed", message: "Chưa gửi quyết định." }, order: sample() } : { success: true, result: { state: "imported", inboxId: "inbox-11" } };
      else throw Error("Unexpected mutation " + body.action);
      await route.fulfill({ json: value });
    });
    if (scenario === "poll") await page.clock.install();
    await page.goto(`${baseUrl}__qa${["readonly", "paused"].includes(scenario) ? "?" + scenario : ""}`);
    await page.locator("[data-kfm-po-intake]").waitFor();
    await page.evaluate(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); window.intakePoll?.(); });
    await page.waitForTimeout(120);
    if(scenario==="poll") { await page.clock.fastForward(61000); assert.equal(await page.evaluate(()=>!!window.intakePoll),false); }
    assert.equal(scans,0,"No discovery on mount/focus/visibility/61s idle");
    assert.equal(await page.getByRole("dialog").count(),0);
    if (["readonly", "paused"].includes(scenario)) {
      assert(await page.getByRole("button",{name:"Kiểm tra PO"}).isDisabled());
      if(scenario==="paused") { await page.evaluate(()=>window.unpause()); await page.waitForTimeout(100); assert.equal(scans,0); }
    } else {
      await page.getByRole("button",{name:"Kiểm tra PO",exact:true}).evaluate(el=>{el.click();el.click();});
      const dialog = page.getByRole("dialog"); await dialog.waitFor();
      if (["checking","close-scan"].includes(scenario)) {
        await dialog.getByText("Đang kiểm tra PO…",{exact:true}).waitFor();
        assert.equal(await dialog.locator("[data-kfm-intake-order]").count(),0);
        await page.screenshot({path:path.join(out,`${width}-checking.png`)});
        if(scenario==="close-scan") {
          await dialog.getByRole("button",{name:"Đóng",exact:true}).click();
          await dialog.waitFor({state:"hidden"}); await page.waitForTimeout(1300);
          assert.equal(await dialog.count(),0,"Late scan must not reopen dialog");
          assert(await page.getByRole("button",{name:"Kiểm tra PO"}).evaluate(el=>el===document.activeElement));
        } else await dialog.locator('[data-kfm-intake-order="11"]').waitFor();
      } else if(scenario==="scan-error") {
        await dialog.getByText("Chưa có kết quả kiểm tra").waitFor();
        assert.equal(await dialog.getByText("Không có PO mới cần duyệt").count(),0);
        await page.screenshot({path:path.join(out,`${width}-error.png`)});
        await dialog.getByRole("button",{name:"Thử lại"}).click();
        await dialog.locator('[data-kfm-intake-order="11"]').waitFor(); assert.equal(scans,2);
      } else if(scenario==="empty") {
        await dialog.getByText("Không có PO mới cần duyệt").waitFor();
        assert.equal(await dialog.getByRole("button",{name:"Xác nhận",exact:true}).count(),0);
      } else {
      await dialog.locator('[data-kfm-intake-order="11"]').waitFor();
      assert.equal(await dialog.count(), 1); assert.equal(decisions, 0); assert.equal(scans,1);
      if(scenario==="many") {
        await page.waitForTimeout(250); // Measure settled geometry, not the dialog entry scale.
        const bounds=await dialog.getByRole("button",{name:"Xác nhận",exact:true}).boundingBox(); assert(bounds.y+bounds.height<=900 && bounds.height>=44, JSON.stringify(bounds));
        await page.emulateMedia({reducedMotion:"reduce"});
      }
      if (scenario === "poll" || scenario === "many") {
        await page.evaluate(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); window.intakePoll?.(); });
        await page.waitForTimeout(100); assert.equal(scans,1); assert.equal(decisions,0);
      } else if (scenario === "defer") {
        await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" }); assert.equal(await dialog.count(), 0);
        await page.evaluate(() => window.dispatchEvent(new Event("focus"))); await page.waitForTimeout(150);
        assert.equal(await dialog.count(), 0); assert.equal(decisions, 0);
        await page.getByRole("button", { name: "Kiểm tra PO", exact: false }).click(); await dialog.waitFor();
      } else if (scenario === "reject") {
        await dialog.getByRole("button", { name: "Từ chối", exact: true }).click();
        assert(await dialog.getByRole("button", { name: "Gửi từ chối đến KFM" }).isDisabled());
        await dialog.getByLabel("Lý do từ chối (gửi đến KFM)").fill("Không đủ năng lực sản xuất");
        await dialog.getByRole("button", { name: "Gửi từ chối đến KFM" }).evaluate((button) => { button.click(); button.click(); });
        await dialog.getByText(/KFM đã ghi nhận từ chối/).waitFor(); assert.equal(decisions, 1);
        await page.screenshot({path:path.join(out,`${width}-rejected.png`)});
        await dialog.getByRole("button",{name:"PO tiếp theo"}).click();
        await page.locator('[data-kfm-intake-order="12"]').waitFor();
      } else if (scenario === "recover") {
        assert.equal(await dialog.getByRole("button", { name: "Xác nhận", exact: true }).count(), 0);
        await dialog.getByRole("button", { name: "Tra cứu kết quả" }).click(); await page.locator("[data-production-setup]").waitFor(); assert.equal(decisions, 0);
      } else {
        if (scenario === "import-error") await page.evaluate(() => { window.failImport = true; });
        if (scenario === "confirmed") assert.equal(await dialog.getByRole("button", { name: "Từ chối", exact: true }).count(), 0);
        await dialog.getByRole("button", { name: scenario === "confirmed" ? "Tiếp tục nhập PO" : "Xác nhận", exact: true }).evaluate((button) => { button.click(); button.click(); });
        if(scenario==="slow-write") {
          await dialog.locator("[data-kfm-intake-progress]").waitFor();
          await page.keyboard.press("Escape"); assert.equal(await dialog.count(),1);
          await page.screenshot({path:path.join(out,`${width}-write-progress.png`)});
        }
        if (["timeout","slow-write"].includes(scenario)) { await dialog.getByRole("button", { name: "Tra cứu kết quả" }).waitFor(); await dialog.getByRole("button", { name: "Tra cứu kết quả" }).click(); }
        if (scenario === "denied") { await dialog.getByRole("button", { name: "Tra cứu kết quả" }).click(); await dialog.getByRole("button", { name: "Xác nhận", exact: true }).waitFor(); assert.equal((await page.evaluate(() => window.imported || [])).length, 0); }
        else if (scenario === "changed") { await dialog.getByRole("alert").waitFor(); assert((await dialog.innerText()).includes("99")); assert.equal((await page.evaluate(() => window.imported || [])).length, 0); }
        else if (scenario === "import-error") {
          await dialog.getByRole("button", { name: "Tiếp tục thiết lập SX" }).waitFor();
          await page.evaluate(() => { window.failImport = false; }); await dialog.getByRole("button", { name: "Tiếp tục thiết lập SX" }).click(); await page.locator("[data-production-setup]").waitFor();
        } else await page.locator("[data-production-setup]").waitFor();
        assert.equal(decisions, 1);
        if (!["changed", "denied"].includes(scenario)) { await dialog.waitFor({ state: "hidden" }); assert.equal(await dialog.count(), 0); await page.getByRole("button", { name: "Đóng thiết lập SX" }).click();
          await page.waitForTimeout(250); assert.equal(await dialog.count(),0,"Setup close must not reopen review");
          await page.getByRole("button",{name:"Kiểm tra PO"}).click(); await page.locator('[data-kfm-intake-order="12"]').waitFor(); }
      }
    }
    }
    assert.equal(await page.locator("[data-kfm-po-intake] > p").count(),0,"No inline status below button");
    await page.waitForTimeout(250); assert((await page.locator('[role="dialog"]:visible').count()) <= 1);
    const geometry = await page.evaluate(() => { const box = document.querySelector('[role="dialog"]'); const r = box?.getBoundingClientRect(); return { scroll: document.documentElement.scrollWidth, client: innerWidth, left: r?.left, right: r?.right, dialogScroll: box?.scrollWidth, dialogClient: box?.clientWidth }; });
    assert(geometry.scroll <= width + 1, JSON.stringify(geometry));
    if (geometry.left !== undefined) assert(geometry.left >= -1 && geometry.right <= width + 1 && geometry.dialogScroll <= geometry.dialogClient + 1, JSON.stringify(geometry));
    assert.deepEqual(errors, []); await page.screenshot({ path: path.join(out, `${width}-${scenario}.png`) });
    results.push({ width, scenario, actions, decisions, geometry }); await context.close();
  }
  fs.writeFileSync(path.join(out, "qa-results.json"), JSON.stringify(results, null, 2));
  console.log(JSON.stringify({ passed: results.length, out }));
} finally { await browser.close(); await server.close(); }
