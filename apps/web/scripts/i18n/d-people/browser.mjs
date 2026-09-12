import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import ts from 'typescript';
const {chromium}=await import(process.env.BMQ_PLAYWRIGHT||'/home/ubuntu/bmq-payment-preview/node_modules/playwright/index.mjs');
const origin='http://127.0.0.1:4306',out='/tmp/bmq-i18n-lanes/d-people';
const exports={};new Function('exports',ts.transpile(await fs.readFile('src/i18n/people.ts','utf8'),{module:ts.ModuleKind.CommonJS}))(exports);
const dict=exports.people;
const label=(lang,en)=>{const key=Object.keys(dict.en).find(k=>dict.en[k]===en);if(!key)throw Error('Missing test label '+en);return dict[lang][key];};
const browser=await chromium.launch({executablePath:process.env.BMQ_CHROMIUM||'/home/ubuntu/.cache/ms-playwright/chromium-1234/chrome-linux/chrome',args:['--no-sandbox']});
const cases=[],errors=[],unexpected=[],downloads={};
const activate=async locator=>{await locator.focus();await locator.press('Enter');};
const btn=(p,name)=>p.getByRole('button',{name,exact:true}).filter({visible:true});
async function setup(page,lang,width,mode='data'){
 const c=await browser.newContext({viewport:{width,height:1000},timezoneId:'Asia/Ho_Chi_Minh',acceptDownloads:true});
 await c.addInitScript(lang=>{if(!sessionStorage.getItem('init')){localStorage.setItem('app-language',lang);sessionStorage.setItem('init','1');}window.__httpCalls=[];},lang);
 await c.route('**/*',async r=>{
  const u=r.request().url();
  if(u.startsWith(origin+'/mock/')){
   const name=new URL(u).pathname.split('/').at(-1);const allowed=['sync-drive-index','migration-storage-archive','google-drive-auth','test-drive-connection'];
   if(!allowed.includes(name)){unexpected.push(u);return r.abort();}
   await r.request().frame().evaluate(call=>window.__httpCalls.push(call),{name,body:r.request().postDataJSON()});
   if(name==='migration-storage-archive')return r.fulfill({body:'fixture-zip-bytes',contentType:'application/zip',headers:{'Content-Disposition':'attachment; filename="fixture.zip"'}});
   return r.fulfill({json:name==='sync-drive-index'?{filesSynced:2,foldersScanned:1}:{error:'SERVER giữ nguyên $&'}});
  }
  if(u.startsWith(origin+'/'))return r.continue();
  if(u.startsWith('https://fonts.googleapis.com/'))return r.fulfill({body:'',contentType:'text/css'});
  unexpected.push(u);return r.abort();
 });
 const p=await c.newPage();p.setDefaultTimeout(6000);p.on('pageerror',e=>errors.push({page,mode,message:e.message}));await p.goto(`${origin}/${page}?mode=${mode}${mode==='readonly'?'&readonly=1':''}`);return {c,p,L:en=>label(lang,en)};
}
async function calls(p){return p.evaluate(()=>window.__fixtureCalls);}
async function waitCall(p,filter){await p.waitForFunction(filter);return calls(p);}
async function download(p,button){const event=p.waitForEvent('download');await button.click();const d=await event;return {name:d.suggestedFilename(),bytes:await fs.readFile(await d.path())};}
const title={attendance:['Attendance','Chấm công'],payroll:['Payroll','Bảng lương'],settings:['Settings','Cài đặt'],users:['User Management','Quản lý người dùng'],system:['System Management','Quản lý hệ thống']};
for(const page of Object.keys(title))for(const lang of ['en','vi'])for(const width of [390,1440])test(`${page} ${lang} ${width}: actual page, nested UI and canonical actions`,async()=>{
 const {c,p,L}=await setup(page,lang,width);const states=[];
 try{
  await p.getByRole('heading',{name:title[page][lang==='en'?0:1],exact:true}).waitFor();states.push('data');
  if(page==='settings'){
   await p.locator('#name').fill('Tên mới giữ nguyên $&');await btn(p,lang==='en'?'Save Profile':'Lưu hồ sơ').click();
   await p.waitForFunction(()=>window.__fixtureCalls.some(x=>x.table==='profiles'&&x.op==='update'));
   const write=(await calls(p)).find(x=>x.table==='profiles'&&x.op==='update');assert.deepEqual(write,{table:'profiles',op:'update',payload:{full_name:'Tên mới giữ nguyên $&'},filters:{user_id:'owner-1'}});states.push('profile save payload');
   await p.getByText(L('Temporarily disabled while light mode and the shared theme are developed.'),{exact:true}).waitFor();
  }
  if(page==='users'){
   await btn(p,L('Delete account')).click();await p.getByRole('alertdialog').getByText(L('Delete user?'),{exact:true}).waitFor();
   const other=lang==='en'?'vi':'en';await p.evaluate(other=>window.__setLanguage(other),other); await p.getByRole('alertdialog').getByText(label(other,'Delete user?'),{exact:true}).waitFor(); await p.evaluate(lang=>window.__setLanguage(lang),lang);
   await p.getByRole('alertdialog').getByRole('button',{name:dict[lang].cancel2,exact:true}).click();await p.getByRole('alertdialog').waitFor({state:'hidden'});
   await btn(p,L('Delete account')).click();await p.getByRole('alertdialog').getByRole('button',{name:L('Delete'),exact:true}).click();
   await p.waitForFunction(()=>window.__fixtureCalls.some(x=>x.invoke==='user-delete-member'));
   assert.deepEqual((await calls(p)).find(x=>x.invoke==='user-delete-member').args.body,{userId:'staff-1'});states.push('delete dialog cancel/confirm payload');
   await p.getByRole('combobox').click();await p.getByRole('option',{name:L('Warehouse'),exact:true}).click();
   await p.waitForFunction(()=>window.__fixtureCalls.some(x=>x.table==='user_roles'&&x.op==='update'));
   assert.deepEqual((await calls(p)).find(x=>x.table==='user_roles'&&x.op==='update').payload,{role:'warehouse'});states.push('canonical role change');
   await p.getByRole('tab',{name:L('Permissions'),exact:true}).click();await p.getByRole('checkbox').nth(1).click();
   await p.waitForFunction(()=>window.__fixtureCalls.some(x=>x.table==='user_module_permissions'&&!Array.isArray(x.payload)&&x.op==='upsert'));
   assert.deepEqual((await calls(p)).find(x=>x.table==='user_module_permissions'&&!Array.isArray(x.payload)&&x.op==='upsert').payload,{user_id:'staff-1',module_key:'dashboard',can_view:true,can_edit:true});states.push('permission edit implies view');
   await btn(p,L('Defaults')).click();states.push('reset defaults');
  }
  if(page==='attendance'){
   await p.getByText('NV-01',{exact:true}).waitFor();await p.getByText(L('Missing check-out'),{exact:true}).waitFor();
   await p.getByPlaceholder(L('Employee code'),{exact:true}).fill('NV-01');await p.getByPlaceholder(L('Employee name'),{exact:true}).fill('Tên giữ nguyên $&');await btn(p,L('Capture event')).click();
   await p.waitForFunction(()=>window.__fixtureCalls.some(x=>x.table==='attendance_records'&&x.op==='upsert'));
   const all=await calls(p),capture=all.find(x=>x.table==='attendance_events'&&x.op==='insert').payload,record=all.find(x=>x.table==='attendance_records'&&x.op==='upsert').payload;
   assert.equal(capture.source,'qr');assert.equal(capture.event_type,'check_in');assert.equal(capture.employee_name,'Tên giữ nguyên $&');assert.deepEqual(capture.metadata,{captured_from:'attendance_management_shell'});assert.equal(record.status,'missing_check_out');assert.equal(record.minutes_late,0);assert.equal(record.missing_check_out,true);states.push('capture payload and recomputation');
   await p.getByPlaceholder(L('Adjustment reason')).fill('Lý do giữ nguyên');await btn(p,L('Adjust')).click();await p.waitForFunction(()=>window.__fixtureCalls.some(x=>x.table==='attendance_adjustments'&&x.op==='insert'));
   const adjustment=(await calls(p)).find(x=>x.table==='attendance_records'&&x.op==='update');assert.equal(adjustment.payload.status,'present');states.push('adjustment audit payload');
   await p.getByRole('tab',{name:L('Attendance events'),exact:true}).click();await p.getByRole('cell',{name:'Check-in',exact:true}).waitFor();states.push('events');
   await p.getByRole('tab',{name:L('GPS pilot'),exact:true}).click();await p.getByTestId('attendance-pilot-dashboard').waitFor();states.push('GPS empty dashboard');
   await activate(p.getByRole('tab',{name:L('Shift planner'),exact:true}));await p.getByText(L('Weekly shift planner'),{exact:true}).waitFor();await btn(p,L('Copy week')).click();
   await p.waitForFunction(()=>window.__fixtureCalls.some(x=>x.rpc==='attendance_copy_week_roster'));const args=(await calls(p)).find(x=>x.rpc==='attendance_copy_week_roster').args;assert.equal(args._employee_codes,null);assert.match(args._target_from,/^\d{4}-\d{2}-\d{2}$/);states.push('weekly planner and copy RPC');
  }
  if(page==='payroll'){
   await p.getByRole('button').filter({hasText:'PAY-01'}).click();await p.getByText('NV-01',{exact:true}).waitFor();
   assert.ok((await p.locator('body').innerText()).includes(lang==='en'?'9,800,000':'9.800.000'));await activate(btn(p,L('Recalculate')));await p.waitForFunction(()=>window.__fixtureCalls.some(x=>x.rpc==='payroll_calculate_run'));assert.deepEqual((await calls(p)).find(x=>x.rpc==='payroll_calculate_run').args,{_run_id:'run-1'});
   await activate(btn(p,L('Approve')));await p.waitForFunction(()=>window.__fixtureCalls.some(x=>x.table==='payroll_runs'&&x.op==='update'));assert.equal((await calls(p)).find(x=>x.table==='payroll_runs'&&x.op==='update').payload.status,'approved');states.push('financial display, calculation RPC and approval');
   await p.getByRole('tab',{name:L('Wage profiles'),exact:true}).click();await btn(p,L('Edit')).click();const dialog=p.getByRole('dialog');const otherLang=lang==='en'?'vi':'en';await p.evaluate(l=>window.__setLanguage(l),otherLang);await dialog.getByText(dict[otherLang].editProfile,{exact:true}).waitFor();assert.equal(await dialog.locator('input').first().inputValue(),'NV-01');await p.evaluate(l=>window.__setLanguage(l),lang);await dialog.getByRole('combobox').click();await p.getByRole('option',{name:L('Hourly'),exact:true}).click();await dialog.getByRole('button',{name:L('Save profile'),exact:true}).click();
   await p.waitForFunction(()=>window.__fixtureCalls.some(x=>x.table==='employee_wage_profiles'&&x.op==='update'));const profile=(await calls(p)).find(x=>x.table==='employee_wage_profiles'&&x.op==='update').payload;assert.equal(profile.wage_type,'hourly');assert.equal(profile.base_monthly_salary,10000000);assert.equal(profile.employee_name,'Tên giữ nguyên $&');assert.equal(profile.partial_shift_floor,0.5);states.push('wage dialog and canonical financial payload');
   await p.getByRole('tab',{name:L('Accounting export'),exact:true}).click();await p.getByRole('combobox').click();await p.getByRole('option').first().click();await p.getByText('Chi phí giữ nguyên',{exact:true}).waitFor();
   const buttons=btn(p,L('Download CSV'));assert.equal(await buttons.count(),3);
   for(let i=0;i<3;i++){const d=await download(p,buttons.nth(i));assert.ok(d.bytes.subarray(0,3).equals(Buffer.from([239,187,191])));const key=`${width}-${i}`;if(downloads[key])assert.deepEqual(d.bytes,downloads[key]);else downloads[key]=d.bytes;await fs.writeFile(`${out}/${lang}-${width}-${d.name}`,d.bytes);}states.push('summary/journal/SKU CSV bytes identical EN/VI');
  }
  if(page==='system'){
   await p.getByText(L('Dealer order landing banners'),{exact:true}).waitFor();await p.locator('#dealer-banner-label-0').fill('Nội dung giữ nguyên');
   await btn(p,L('Save order / status of all three banners')).click();await p.waitForFunction(()=>window.__fixtureCalls.some(x=>x.table==='app_settings'&&Array.isArray(x.payload)));
   const rows=(await calls(p)).find(x=>x.table==='app_settings'&&Array.isArray(x.payload)).payload;const banners=JSON.parse(rows.find(x=>x.key==='dealer_landing_banners').value);assert.equal(banners[0].eventLabel,'Nội dung giữ nguyên');assert.equal(banners[1].eventLabel,'Sự kiện 2');states.push('banner controls and preserved public payload');
   await btn(p,L('Save settings')).click();await p.waitForFunction(()=>window.__fixtureCalls.some(x=>x.payload?.key==='google_drive_receipts_unc_pattern'));assert.equal((await calls(p)).find(x=>x.payload?.key==='google_drive_receipts_unc_pattern').payload.value,'yyyy/MM/dd/UNC');states.push('Drive settings save payload');
   await btn(p,L('Sync now')).first().click();await p.waitForFunction(()=>window.__httpCalls.some(x=>x.name==='sync-drive-index'));assert.deepEqual((await p.evaluate(()=>window.__httpCalls)).find(x=>x.name==='sync-drive-index').body,{folderType:'po'});states.push('nested sync hook');
   const schema=await download(p,btn(p,L('Download schema')));const parsed=JSON.parse(schema.bytes.toString());assert.equal(parsed.source,'supabase-client');assert.match(parsed.note,/Schema chi tiết/);states.push('schema export preserved metadata');
   const manifest=await download(p,btn(p,L('Generate manifest')));assert.deepEqual(JSON.parse(manifest.bytes.toString()),{success:true,files:[]});
   const zip=await download(p,btn(p,L('Download files ZIP')));assert.equal(zip.bytes.toString(),'fixture-zip-bytes');states.push('manifest and ZIP mocked download');
  }
  const other=lang==='en'?'vi':'en';await btn(p,other.toUpperCase()).click();await p.getByRole('heading',{name:title[page][other==='en'?0:1],exact:true}).waitFor();
  if(page==='system')assert.equal(await p.locator('#dealer-banner-label-0').inputValue(),'Nội dung giữ nguyên');
  await p.reload();await p.getByRole('heading',{name:title[page][other==='en'?0:1],exact:true}).waitFor();states.push('reactive switch and persisted reload');
  await p.screenshot({path:`${out}/${page}-${lang}-${width}.png`,fullPage:true});cases.push({page,lang,width,states,passed:true});
 }finally{await c.close();}
});
for(const page of Object.keys(title))for(const lang of ['en','vi'])for(const width of [390,1440])test(`${page} ${lang} ${width}: empty/loading/error`,async()=>{
 for(const mode of ['empty','loading','error']){const {c,p,L}=await setup(page,lang,width,mode);try{
  await p.getByRole('heading',{name:title[page][lang==='en'?0:1],exact:true}).waitFor();
  if(page==='settings'){assert.equal(await p.locator('#name').inputValue(),'Tên giữ nguyên $&');}
  else if(mode==='loading')await p.locator('.animate-spin,.animate-pulse').first().waitFor();
  else if(page==='attendance'){if(mode==='error'){await p.getByRole('tab',{name:L('GPS pilot'),exact:true}).click();await p.getByRole('alert').waitFor();}else await p.getByText(L('No data yet'),{exact:true}).waitFor();}
  else if(page==='payroll')await p.getByText(L('No payroll runs yet'),{exact:true}).waitFor();
  else if(page==='users'){await p.getByRole('tab',{name:L('Permissions'),exact:true}).click();await p.getByText(L('No non-owner users to manage permissions for.'),{exact:true}).waitFor();}
  else if(page==='system'){if(mode==='error')await p.getByText(L('Unable to load dealer order banners'),{exact:true}).waitFor();else await p.getByText(L('No banner yet'),{exact:true}).first().waitFor();}
  cases.push({page,lang,width,mode,passed:true,note:mode==='error'&&['payroll','users'].includes(page)?'Existing query-error behavior is empty UI; no dedicated error panel.':page==='settings'?'Settings has no read/loading/error backend state; auth fixture remains stable.':undefined});
 }finally{await c.close();}}
});
for(const lang of ['en','vi'])for(const width of [390,1440])test(`write errors and permission gates ${lang} ${width}`,async()=>{
 for(const page of ['attendance','payroll','users','system','settings']){
  const {c,p,L}=await setup(page,lang,width,'save-error');try{
   if(page==='attendance'){await p.getByPlaceholder(L('Employee code'),{exact:true}).fill('NV-01');await btn(p,L('Capture event')).click();await p.getByText(L('Unable to capture event'),{exact:true}).waitFor();assert.equal((await calls(p)).filter(x=>x.table==='attendance_records'&&x.op==='upsert').length,0);}
   if(page==='payroll'){await p.getByRole('tab',{name:L('Wage profiles'),exact:true}).click();await btn(p,L('Edit')).click();await p.getByRole('dialog').getByRole('button',{name:L('Save profile'),exact:true}).click();await p.getByText(L('Save failed'),{exact:true}).waitFor();await p.getByRole('dialog').waitFor();}
   if(page==='users'){await p.getByRole('combobox').click();await p.getByRole('option',{name:L('Warehouse'),exact:true}).click();await p.getByText(L('Unable to update role'),{exact:true}).waitFor();}
   if(page==='system'){await btn(p,L('Save order / status of all three banners')).click();await p.getByText(L('Unable to save the banner list'),{exact:true}).waitFor();}
   if(page==='settings'){await p.locator('#name').fill('Tên lỗi giữ nguyên');await btn(p,lang==='en'?'Save Profile':'Lưu hồ sơ').click();await p.waitForFunction(()=>window.__fixtureCalls.some(x=>x.table==='profiles'&&x.op==='update'));assert.equal(await p.locator('#name').inputValue(),'Tên lỗi giữ nguyên');}
   if(page!=='settings')await p.getByText('SERVER giữ nguyên $&',{exact:true}).waitFor();
   cases.push({page,lang,width,mode:'save-error',passed:true,note:page==='settings'?'Existing profile-save error is console-only; no added error UI.':undefined});
  }finally{await c.close();}
 }
 for(const page of ['attendance','payroll','system']){
  const {c,p,L}=await setup(page,lang,width,'readonly');try{
   if(page==='attendance'){assert.equal(await btn(p,L('Capture event')).isDisabled(),true);assert.equal(await btn(p,L('Lock period')).count(),0);}
   if(page==='payroll'){assert.equal(await btn(p,L('Create run')).isDisabled(),true);await p.getByRole('tab',{name:L('Wage profiles'),exact:true}).click();assert.equal(await btn(p,L('Add profile')).isDisabled(),true);}
   if(page==='system')assert.equal(await btn(p,L('Download schema')).isDisabled(),true);
   assert.equal((await calls(p)).filter(x=>x.op&&x.op!=='read').length,0);cases.push({page,lang,width,mode:'readonly',passed:true});
  }finally{await c.close();}
 }
});

for(const lang of ['en','vi'])for(const width of [390,1440])test(`supplemental GPS and shared auth error ${lang} ${width}`,async()=>{
 for(const page of ['attendance','payroll']){const {c,p,L}=await setup(page,lang,width,'gps-data');try{
  if(page==='attendance'){await p.getByRole('tab',{name:L('GPS pilot'),exact:true}).click();await p.getByRole('cell',{name:dict[lang].withinGeofence,exact:true}).waitFor();await p.getByText('Điểm giữ nguyên',{exact:true}).waitFor();}
  else{await p.getByRole('button').filter({hasText:'PAY-01'}).click();await p.getByTestId('payroll-gps-preview').getByText(L('Calculated'),{exact:true}).waitFor();await p.getByRole('cell',{name:L('Monthly'),exact:true}).waitFor();assert.ok((await p.locator('body').innerText()).includes(lang==='vi'?'(+2p)':'(+2 partial)'));}
  await p.evaluate(l=>window.__setLanguage(l),lang==='en'?'vi':'en');assert.equal(await p.locator('[data-i18n-version="d-people-v1"]').count(),1);cases.push({page,lang,width,mode:'gps-data',passed:true});
 }finally{await c.close();}}
 for(const page of ['users','system']){const {c,p,L}=await setup(page,lang,width,'auth-error');try{
  if(page==='users'){await btn(p,L('Delete account')).click();assert.ok((await p.getByRole('alertdialog').innerText()).includes('Tên giữ nguyên $&'));await p.getByRole('alertdialog').getByRole('button',{name:L('Delete'),exact:true}).click();}
  else await btn(p,L('Generate manifest')).click();
  await p.getByText(dict[lang].sessionExpiredRelogin,{exact:true}).waitFor();assert.equal((await calls(p)).filter(x=>x.invoke).length,0);cases.push({page,lang,width,mode:'auth-error',passed:true});
 }finally{await c.close();}}
});

test.after(async()=>{await browser.close();await fs.writeFile(`${out}/browser-results.json`,JSON.stringify({cases,errors,unexpected},null,2));assert.deepEqual(errors,[]);assert.deepEqual(unexpected,[]);});
