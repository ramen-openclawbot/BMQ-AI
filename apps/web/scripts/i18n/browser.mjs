import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const { chromium } = await import(process.env.BMQ_PLAYWRIGHT || '/home/ubuntu/bmq-payment-preview/node_modules/playwright/index.mjs');
const artifacts = process.env.BMQ_I18N_ARTIFACTS || '/tmp/bmq-i18n-a-qa';
const origin = 'http://127.0.0.1:4196';
const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
await fs.mkdir(`${artifacts}/screenshots`, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.BMQ_CHROMIUM || '/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux/chrome', headless: true, args: ['--no-sandbox'] });
const result = { method: 'Actual AppRoutes + AppLayout + Header + Sidebar + SKU components; synthetic auth/data, mocked client and fetch/WebSocket, external network blocked. Excluded business pages are NOT runtime coverage.', cases: [], screenshots: [], completedFiles: [], externalRequests: [], pageErrors: [] };
const skuName = 'Bánh chà bông thử nghiệm';
const pageFiles = { dashboard: 'src/pages/SkuCostsDjango.tsx', analysis: 'src/pages/SkuCostsAnalysis.tsx', management: 'src/pages/SkuCostsManagement.tsx' };
const commonFiles = ['src/components/layout/Header.tsx','src/components/layout/Sidebar.tsx','src/components/layout/AppLayout.tsx','src/components/AppRoutes.tsx'];
const visible = locator => locator.filter({ visible: true });
const text = (page,value) => visible(page.getByText(value,{exact:true}));
const button = (page,name) => visible(page.getByRole('button',{name,exact:true}));
async function shot(page,name) { const p=`${artifacts}/screenshots/${name}.png`;await page.screenshot({path:p,fullPage:true,animations:"disabled"});result.screenshots.push(p); }
async function caseRun(id,files,run) {
  const entry={id,files,passed:false};result.cases.push(entry);
  try { await run();entry.passed=true;console.log(`PASS ${id}`); }
  catch(e) {entry.error=e.message;console.error(`FAIL ${id}: ${e.message}`);throw e;}
}
async function contextFor(width,lang='vi') {
  const context=await browser.newContext({viewport:{width,height:width<500?844:1000},timezoneId:'Asia/Ho_Chi_Minh',locale:'vi-VN',acceptDownloads:true});
  await context.addInitScript(lang=>{
    localStorage.setItem('app-language',localStorage.getItem('app-language')||lang);
    // All VNAgent fetches/WebSockets are local JS stubs, including session picker.
    const nativeFetch=window.fetch.bind(window);
    window.fetch=async(input,init)=>{
      const u=String(input);
      if(u.startsWith('https://api.vnagent.ai/')) {
        const data=u.includes('/auth/')?{token:'fixture-only'}:u.includes('/agents')?[{id:'legal',name:'BMQ'}]:[];
        return new Response(JSON.stringify(data),{status:200,headers:{'Content-Type':'application/json'}});
      }
      return nativeFetch(input,init);
    };
    class SyntheticSocket {
      static OPEN=1;readyState=1;
      constructor(){setTimeout(()=>this.onopen?.({}),10);}
      send(){setTimeout(()=>this.onmessage?.({data:JSON.stringify({type:'hello_ack'})}),10);}
      close(){this.readyState=3;}
    }
    window.WebSocket=SyntheticSocket;
  },lang);
  await context.route('**/*',r=>{
    const url=r.request().url();
    if(url.startsWith('https://fonts.googleapis.com/')) return r.fulfill({status:200,contentType:'text/css',body:'/* Synthetic fixture: system font fallback; no external font fetch. */'});
    if(!url.startsWith(`${origin}/`)&&!url.startsWith('blob:')) {result.externalRequests.push({url:new URL(url).origin,method:r.request().method()});return r.abort();}
    return r.continue();
  });
  const page=await context.newPage();page.on('pageerror',e=>{if(page.url().includes('crash=1')&&e.message==='Synthetic render failure')return;result.pageErrors.push(e.message);});
  return {context,page};
}
async function switchHeader(page,lang) {
  await button(page,lang==='en'?'English':'Tiếng Việt').click();
  await page.waitForFunction(lang=>localStorage.getItem('app-language')===lang,lang);
  assert.equal(await button(page,lang==='en'?'English':'Tiếng Việt').getAttribute('aria-pressed'),'true');
}
async function switchModal(page,lang) {
  await page.evaluate(lang=>window.__fixtureSetLanguage(lang),lang);
  await page.waitForFunction(lang=>localStorage.getItem('app-language')===lang,lang);
}
async function ready(page,route,query='') {
  await page.goto(`${origin}/sku-costs/${route}?role=staff${query}`);
  await page.locator('[data-i18n-batch="staff-sku-a-v1"]').waitFor();
  if(!query.includes('empty')&&!query.includes('error')&&!query.includes('loading')) await visible(page.getByText(skuName,{exact:route!=='analysis'})).first().waitFor();
}
async function closeModal(page,lang) {await button(page,lang==='en'?'Close':'Đóng').click();}
async function assertNoVietnameseUI(page) {
  const nodes=await page.locator('body').evaluate(body=>{
    const walker=document.createTreeWalker(body,NodeFilter.SHOW_TEXT);const out=[];let n;
    while(n=walker.nextNode())if(n.parentElement?.checkVisibility()&&!n.parentElement.closest('script,style'))out.push(n.textContent.trim());
    return out.filter(Boolean);
  });
  const exceptions=/^(Nhân viên thử nghiệm|Bánh chà bông thử nghiệm|Bánh không giá thử nghiệm|Bột mì thử nghiệm|Đường thử nghiệm|Muối thử nghiệm|Bơ thử nghiệm|Ghi chú lịch sử giữ nguyên|cái|gói)$/;
  const vietnamese=/[ăâđêôơưĂÂĐÊÔƠƯ\u1ea0-\u1ef9]/;
  const bad=nodes.filter(n=>vietnamese.test(n)&&!exceptions.test(n)&&!/^\d[\d.,]*đ$/.test(n)&&!n.includes('thử nghiệm')&&!n.includes('giữ nguyên'));
  assert.deepEqual(bad,[],'Untranslated visible UI');
}
try {
  for(const width of [390,1440]) {
    const {context,page}=await contextFor(width);
    await caseRun(`${width}-navigation-switch-reload`,commonFiles,async()=>{
      await ready(page,'dashboard');
      assert.equal(await page.locator('[data-header-language="en-vi-v1"]').count(),1);
      for(const lang of ['vi','en']) {
        await switchHeader(page,lang);
        if(width<500)await button(page,lang==='en'?'Open menu':'Mở menu').click();
        assert.ok(await text(page,lang==='en'?'Sale & Marketing':'Bán Hàng và Tiếp Thị').count());
        await shot(page,`${width}-${lang}-navigation`);
        if(width<500)await button(page,lang==='en'?'Close sidebar':'Đóng sidebar').click({position:{x:width-10,y:20}});
        await page.reload();await page.locator('[data-i18n-batch]').waitFor();
        assert.equal(await button(page,lang==='en'?'English':'Tiếng Việt').getAttribute('aria-pressed'),'true');
        const box=await button(page,lang==='en'?'English':'Tiếng Việt').boundingBox();assert.ok(box.width>=44&&box.height>=44);
      }
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'No page overflow');
    });
    await caseRun(`${width}-overview-image-validation-export`,[pageFiles.dashboard,'src/components/ui/dialog.tsx'],async()=>{
      await ready(page,'dashboard');const exports=[];let uploadCalls=0;
      for(const lang of ['vi','en']) {
        await ready(page,'dashboard');await switchHeader(page,lang);await shot(page,`${width}-${lang}-overview`);
        const download=page.waitForEvent('download');await button(page,lang==='en'?'Export SKU sheet':'Xuất sheet SKU').click();
        exports.push(await fs.readFile(await (await download).path(),'utf8'));
        const search=visible(page.locator('input[placeholder]'));await search.fill('not-a-fixture-sku');
        await text(page,lang==='en'?'No matching SKUs found.':'Không tìm thấy SKU phù hợp.').waitFor();await search.fill('');
        await button(page,`${lang==='en'?'Update image for':'Cập nhật ảnh'} ${skuName}`).click();
        const dialog=page.getByRole('dialog');await dialog.waitFor();await shot(page,`${width}-${lang}-image-dialog`);
        await dialog.locator('input[type=file]').setInputFiles({name:'invalid.txt',mimeType:'text/plain',buffer:Buffer.from('synthetic')});
        await text(page,lang==='en'?'Only JPG, JPEG, PNG or WEBP are supported.':'Chỉ hỗ trợ JPG, JPEG, PNG hoặc WEBP.').waitFor();
        const opposite=lang==='en'?'vi':'en';await switchModal(page,opposite);
        await text(page,opposite==='en'?'Only JPG, JPEG, PNG or WEBP are supported.':'Chỉ hỗ trợ JPG, JPEG, PNG hoặc WEBP.').waitFor();
        await switchModal(page,lang);
        await dialog.locator('input[type=file]').setInputFiles({name:'oversize.png',mimeType:'image/png',buffer:Buffer.alloc(5*1024*1024+1)});
        await text(page,lang==='en'?'Maximum image size is 5MB.':'Ảnh tối đa 5MB.').waitFor();
        await dialog.locator('input[type=file]').setInputFiles({name:'qa.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCXYAAAAASUVORK5CYII=','base64')});
        await button(page,lang==='en'?'Save image':'Lưu ảnh').click();await dialog.waitFor({state:'hidden'});
        if(lang==='en')await assertNoVietnameseUI(page);
        uploadCalls += (await page.evaluate(()=>window.__fixtureCalls)).filter(c=>c.bucket==='sku-images').length;
      }
      assert.equal(exports[0],exports[1],'CSV bytes must match across languages');
      assert.match(exports[0],/"Mã SKU","Tên SKU","Đơn vị","Giá bán","Giá vốn","LC %","Trạng thái giá","Cập nhật lúc"/);
      await fs.writeFile(`${artifacts}/${width}-overview-export.csv`,exports[0]);
      assert.equal(uploadCalls,2);
    });
    await caseRun(`${width}-analysis-chart-tooltip-export`,[pageFiles.analysis,'src/hooks/useSkuCostBridge.ts'],async()=>{
      await ready(page,'analysis');const exports=[];
      for(const lang of ['vi','en']) {
        await switchHeader(page,lang);await button(page,lang==='en'?'Run SKU analysis':'Chạy phân tích SKU').click();
        await text(page,lang==='en'?'Formula cost':'Cost công thức').waitFor();
        if(width<500)await button(page,lang==='en'?'Show more materials (1)':'Xem thêm nguyên liệu (1)').click();
        await shot(page,`${width}-${lang}-analysis`);
        const chart=visible(page.locator('.recharts-wrapper')).first();await chart.scrollIntoViewIfNeeded();const box=await chart.boundingBox();await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
        await visible(page.locator('.recharts-tooltip-wrapper')).first().waitFor();
        assert.ok((await visible(page.locator('.recharts-tooltip-wrapper')).first().innerText()).includes(lang==='en'?'Actual purchase price':'Giá mua thật'));
        await shot(page,`${width}-${lang}-chart-tooltip`);
        const download=page.waitForEvent('download');await button(page,lang==='en'?'Export review sheet':'Xuất sheet review').click();exports.push(await fs.readFile(await(await download).path(),'utf8'));
        if(lang==='en')await assertNoVietnameseUI(page);
      }
      assert.equal(exports[0],exports[1],'Analysis CSV bytes must match across languages');
      await fs.writeFile(`${artifacts}/${width}-analysis-export.csv`,exports[0]);
    });
    await caseRun(`${width}-management-detail-create-edit-validation`,[pageFiles.management,'src/components/sku-costs/SkuCostMenuBar.tsx','src/components/ui/dialog.tsx'],async()=>{
      await ready(page,'management');
      for(const lang of ['vi','en']) {
        await switchHeader(page,lang);await shot(page,`${width}-${lang}-management`);
        await text(page,skuName).click();await page.getByRole('dialog').waitFor();
        await text(page,lang==='en'?'COGS version history':'Lịch sử phiên bản COGS').waitFor();
        assert.ok(await text(page,'Ghi chú lịch sử giữ nguyên').count());await shot(page,`${width}-${lang}-sku-detail`);await closeModal(page,lang);
        await button(page,lang==='en'?'Edit':'Sửa').first().click();await page.getByRole('dialog').waitFor();
        assert.equal(await page.getByRole('dialog').locator('input').first().inputValue(),skuName);
        await shot(page,`${width}-${lang}-sku-edit`);
        await page.getByRole('dialog').evaluate(el=>{el.scrollTop=el.scrollHeight;});await shot(page,`${width}-${lang}-sku-edit-footer`);
        if(lang==='en')await assertNoVietnameseUI(page);
        await closeModal(page,lang);
        await button(page,lang==='en'?'Create SKU':'Tạo SKU').click();await button(page,lang==='en'?'Save SKU':'Lưu SKU').click();
        await visible(page.getByText(lang==='en'?'SKU code and product name are required to save.':'Cần có mã SKU và tên món để lưu.',{exact:false})).waitFor();
        const opposite=lang==='en'?'vi':'en';await switchModal(page,opposite);
        await visible(page.getByText(opposite==='en'?'SKU code and product name are required to save.':'Cần có mã SKU và tên món để lưu.',{exact:false})).waitFor();await switchModal(page,lang);
        await shot(page,`${width}-${lang}-create-validation`);
        await button(page,lang==='en'?'+ Add level 1 material':'+ Thêm NVL cấp 1').click();
        const material=visible(page.getByRole('dialog').getByRole('combobox')).first();await material.click();await page.getByRole('option').first().click();
        await button(page,lang==='en'?'+ Add level 2 material':'+ Thêm NVL cấp 2').click();
        await shot(page,`${width}-${lang}-material-dialog`);await closeModal(page,lang);
      }
      assert.equal((await page.evaluate(()=>window.__fixtureCalls)).filter(c=>c.table==='save_sku_cogs').length,0,'Invalid form never calls save RPC');
    });
    for(const route of ['dashboard','analysis','management']) {
      await caseRun(`${width}-${route}-empty-error`,[pageFiles[route]],async()=>{
        for(const mode of ['empty','error'])for(const lang of ['vi','en']) {
          await ready(page,route,`&fixture=${mode}`);await switchHeader(page,lang);
          if(mode==='error')await visible(page.getByRole('alert')).first().waitFor();
          else if(route==='analysis')assert.ok(await button(page,lang==='en'?'Run SKU analysis':'Chạy phân tích SKU').isDisabled());
          else await text(page,route==='dashboard'?(lang==='en'?'No matching SKUs found.':'Không tìm thấy SKU phù hợp.'):(lang==='en'?'No finished SKUs yet.':'Chưa có SKU thành phẩm.')).waitFor();
          await shot(page,`${width}-${lang}-${route}-${mode}`);
          if(lang==='en')await assertNoVietnameseUI(page);
        }
      });
    }
    await caseRun(`${width}-management-save-payload-and-guards`,[pageFiles.management],async()=>{
      const payloads=[];
      for(const lang of ['vi','en']) {
        await ready(page,'management');await switchHeader(page,lang);
        await button(page,lang==='en'?'Edit':'Sửa').first().click();await page.getByRole('dialog').waitFor();
        await button(page,lang==='en'?'Save SKU':'Lưu SKU').click();await page.getByRole('dialog').waitFor({state:'hidden'});
        const saved=await page.evaluate(()=>window.__fixtureCalls.filter(c=>c.table==='save_sku_cogs'));
        assert.equal(saved.length,1);payloads.push(saved[0].rpcArgs);
        assert.equal(saved[0].rpcArgs.p_sku_updates.product_name,skuName);
        assert.equal(saved[0].rpcArgs.p_sku_updates.sku_code,'QA-TP-001');
        assert.equal(saved[0].rpcArgs.p_sku_updates.category,'Thành phẩm');
        assert.equal(saved[0].rpcArgs.p_formulations[0].material_resolution_status,'resolved_exact');
        for(const [mode,vi,en]of [
          ['unresolved','NVL phải được chuẩn hóa bằng danh mục NVL chuẩn trước khi lưu. Vui lòng xử lý các yêu cầu phân giải NVL còn chờ duyệt.','Materials must match the canonical material catalog before saving. Resolve pending material requests first.'],
          ['zero-cost','Có NVL giá 0. Cần tick xác nhận chính sách zero-cost trước khi lưu.','Some materials have zero prices. Confirm the zero-cost policy before saving.'],
          ['save-error','Có lỗi khi lưu dữ liệu, anh thử lại giúp Ramen.','Unable to save data. Please try again.'],
        ]) {
          await ready(page,'management',`&fixture=${mode}`);await switchHeader(page,lang);
          await button(page,lang==='en'?'Edit':'Sửa').first().click();await button(page,lang==='en'?'Save SKU':'Lưu SKU').click();
          await visible(page.getByText(lang==='en'?en:vi,{exact:false})).waitFor();
          if(mode!=='save-error')assert.equal((await page.evaluate(()=>window.__fixtureCalls)).filter(c=>c.table==='save_sku_cogs').length,0);
          await shot(page,`${width}-${lang}-${mode}`);await closeModal(page,lang);
        }
      }
      assert.deepEqual(payloads[0],payloads[1],'EN/VI save RPC payloads must match');
      await fs.writeFile(`${artifacts}/${width}-save-payload.json`,JSON.stringify(payloads[0],null,2));
    });
    await caseRun(`${width}-shared-recovery-permissions-chat`,['src/components/SessionRecoveryOverlay.tsx','src/components/AppRoutes.tsx','src/components/OwnerRoute.tsx','src/components/agent/GlobalAgentChatWidget.tsx','src/components/ui/sheet.tsx','src/components/ui/pagination.tsx'],async()=>{
      for(const lang of ['vi','en']) {
        await ready(page,'dashboard');await switchHeader(page,lang);
        await page.goto(`${origin}/suppliers?role=staff&deny=suppliers`);
        await text(page,lang==='en'?'Access denied':'Không có quyền truy cập').waitFor();await shot(page,`${width}-${lang}-permission`);
        await page.goto(`${origin}/sku-costs/dashboard?role=staff&recovery=1`);
        await text(page,lang==='en'?'Session interrupted':'Phiên đăng nhập bị gián đoạn').waitFor();await shot(page,`${width}-${lang}-recovery`);
        await page.goto(`${origin}/sku-costs/dashboard?auth-timeout=1`);
        await text(page,lang==='en'?'Connection problem':'Đang gặp sự cố kết nối').waitFor();await shot(page,`${width}-${lang}-auth-timeout`);
        await page.goto(`${origin}/sku-costs/dashboard?pagination=1`);
        await page.locator('[data-i18n-batch]').waitFor();
        assert.ok(await page.getByRole('link',{name:lang==='en'?'Go to previous page':'Trang trước'}).count());
        await button(page,lang==='en'?'Open VNAgent':'Mở VNAgent').click();
        await text(page,lang==='en'?'Quick suggestions':'Gợi ý nhanh').waitFor();
        await text(page,lang==='en'?'Cost update checklist':'Checklist cập nhật cost').waitFor();
        await shot(page,`${width}-${lang}-chat`);
        if(lang==='en')await assertNoVietnameseUI(page);
        await button(page,lang==='en'?'Close VNAgent':'Đóng VNAgent').click();
      }
      await page.goto(`${origin}/user-management?role=staff`);await page.waitForURL(`${origin}/`);
    });
    await caseRun(`${width}-loading-and-image-failure`,Object.values(pageFiles),async()=>{
      for(const route of ['dashboard','analysis','management']) {
        await ready(page,route,'&fixture=loading');
        await switchHeader(page,'en');
        await text(page,'Loading SKUs...').first().waitFor();
        await shot(page,`${width}-en-${route}-loading`);
      }
      await ready(page,'dashboard');await switchHeader(page,'en');
      await button(page,`Update image for ${skuName}`).click();
      await page.getByRole('dialog').locator('input[type=file]').setInputFiles({name:'qa.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aCXYAAAAASUVORK5CYII=','base64')});
      await page.evaluate(()=>window.__fixtureMode='upload-error');await button(page,'Save image').click();
      await text(page,'Image upload failed.').waitFor();await shot(page,`${width}-en-upload-failure`);
      await switchModal(page,'vi');await text(page,'Upload ảnh thất bại.').waitFor();await closeModal(page,'vi');
    });
    await caseRun(`${width}-root-error-boundary`,['src/components/ErrorBoundary.tsx'],async()=>{
      for(const lang of ['vi','en']) {
        await ready(page,'dashboard');await switchHeader(page,lang);
        await page.goto(`${origin}/sku-costs/dashboard?role=staff&crash=1`);
        await text(page,lang==='en'?'Something went wrong':'Đã xảy ra lỗi').waitFor();
        await shot(page,`${width}-${lang}-root-error`);
      }
    });
    await context.close();
  }
  assert.deepEqual(result.pageErrors,[],'No browser runtime errors');
  assert.deepEqual(result.externalRequests,[],'No external network requests escaped mocks');
  result.completedFiles=[...new Set(result.cases.filter(c=>c.passed).flatMap(c=>c.files))];
} finally {
  await fs.writeFile(`${artifacts}/browser-results.json`,JSON.stringify(result,null,2));
  await browser.close();
}
console.log(`PASS ${result.cases.length} browser cases; ${result.screenshots.length} screenshots; zero external requests.`);
