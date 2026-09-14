/* Offline behavior checks. Network calls and database writes are intercepted. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
function load(file, env = {}) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const js = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  const exports = {};
  vm.runInNewContext(js, {exports,Request,Response,URL,Headers,console,
    require:(spec)=>{throw Error('Unexpected import '+spec);},
    fetch:()=>{throw Error('Unexpected network call');}, ...env});
  return exports;
}
const source = load('supabase/functions/_shared/kfm-po-source.ts');
const cors = {getCorsHeaders:()=>({}),corsPreflightResponse:()=>new Response(null,{status:204})};
let passed = 0;
async function test(name, fn) {await fn();passed++;console.log('ok',name);}

(async()=>{
  await test('KFM identities include parent/child CRM and sender domains',()=>{
    for(const row of [{from_email:'DATHANG@KINGFOODMART.COM'},{from_email:'orders@child.kingfoodmart.com'},
      {customer_code:'b2b-kfm'},{customer_name:'Kingfoodmart Q7'},{customer_name:'KFM'},
      {revenue_channel:'cake_kingfoodmart'},{raw_payload:{po_automation:{rule:'kingfood_po_automation'}}}]) assert(source.isKfmPoIdentity(row));
  });
  await test('Other customers and deceptive domains remain distinct',()=>{
    for(const row of [{from_email:'damvovan33@gmail.com'},{from_email:'kingfoodmart.com@example.com'},
      {from_email:'order@notkingfoodmart.com'},{customer_name:'Coopmart'},{customer_name:'Vietjet'}]) assert(!source.isKfmPoIdentity(row));
  });
  await test('Outstanding KFM email cannot enter automation, approved history survives',()=>{
    assert(source.shouldSkipKfmEmailAutomation({from_email:'dathang@kingfoodmart.com',match_status:'pending_approval'}));
    assert(!source.shouldSkipKfmEmailAutomation({from_email:'dathang@kingfoodmart.com',match_status:'approved'}));
    assert(!source.shouldSkipKfmEmailAutomation({from_email:'orders@coopmart.vn',match_status:'pending_approval'}));
    assert(!source.shouldSkipKfmEmailAutomation({from_email:'portal@kingfoodmart.com',raw_payload:{source:'kfm_portal'}}));
  });
  for(const name of ['po-parse-latest-kingfood-now','po-use-latest-kingfood-today','po-promote-latest-kingfood']) {
    await test(name+' returns 410 before any database/network access',async()=>{
      let handler;
      load(`supabase/functions/${name}/index.ts`,{require(spec){
        if(spec.includes('/http/server'))return {serve:fn=>handler=fn};
        if(spec.includes('cors'))return cors;
        if(spec.includes('kfm-po-source'))return source;
        throw Error('Retired endpoint unexpectedly loaded '+spec);
      }});
      for(const method of ['GET','POST']) {
        const res=await handler(new Request('https://fixture.invalid',{method}));
        assert.equal(res.status,410);assert.equal((await res.json()).error,'kfm_email_source_retired');
      }
      assert.equal((await handler(new Request('https://fixture.invalid',{method:'OPTIONS'}))).status,204);
    });
  }
  await test('Mixed webhook skips KFM while ingesting other customer once',async()=>{
    let handler;const writes=[];
    const customers=[{email:'orders@other.test',customer_id:'other',mini_crm_customers:{customer_name:'Other',is_active:true}},
      {email:'forwarder@example.com',customer_id:'kfm',mini_crm_customers:{customer_code:'b2b-kfm',customer_name:'Vendor',is_active:true}}];
    const admin={from(table){
      if(table==='mini_crm_customer_emails')return {select(){return this;},order:async()=>({data:customers,error:null})};
      assert.equal(table,'customer_po_inbox');return {upsert:async row=>{writes.push(row);return {error:null};}};
    }};
    load('supabase/functions/po-gmail-ingest/index.ts',{
      Deno:{env:{get:()=> 'fixture'}},require(spec){
        if(spec.includes('/http/server'))return {serve:fn=>handler=fn};
        if(spec.includes('supabase-js'))return {createClient:()=>admin};
        if(spec.includes('cors'))return cors;
        if(spec.includes('kfm-po-source'))return source;
        if(spec.includes('auth'))return {requireCronSecret:()=>{}};
        throw Error('Unexpected import '+spec);
      },
    });
    const res=await handler(new Request('https://fixture.invalid',{method:'POST',body:JSON.stringify({emails:[
      {messageId:'kfm1',fromEmail:'dathang@kingfoodmart.com'},
      {messageId:'kfm2',fromEmail:'forwarder@example.com'},
      {messageId:'other1',fromEmail:'orders@other.test'},
    ]})}));
    const body=await res.json();assert.equal(body.ingested,1);assert.equal(body.skippedPortalOnly,2);
    assert.equal(writes[0].gmail_message_id,'other1');assert.equal(writes[0].match_status,'pending_approval');
  });
  await test('Reparse endpoint refuses historical KFM before Gmail/network',async()=>{
    let handler;
    const query={select(){return this;},eq(){return this;},single:async()=>({data:{id:'old',gmail_message_id:'mail',from_email:'dathang@kingfoodmart.com'},error:null})};
    const admin={auth:{getUser:async()=>({data:{user:{id:'fixture'}}})},from:()=>query};
    load('supabase/functions/po-parse-inbox-order/index.ts',{
      Deno:{env:{get:()=> 'fixture'}},require(spec){
        if(spec.includes('/http/server'))return {serve:fn=>handler=fn};
        if(spec.includes('supabase-js'))return {createClient:()=>admin};
        if(spec.includes('cors'))return cors;
        if(spec.includes('kfm-po-source'))return source;
        if(spec.includes('xlsx'))return {};
        throw Error('Unexpected import '+spec);
      },
    });
    const res=await handler(new Request('https://fixture.invalid',{method:'POST',headers:{Authorization:'Bearer fixture-only'},body:JSON.stringify({inboxId:'old'})}));
    assert.equal(res.status,410);assert.equal((await res.json()).error,'kfm_email_source_retired');
  });
  await test('Gmail skip precedes parser and upsert even for stale caller queries',()=>{
    const code=fs.readFileSync(path.join(root,'supabase/functions/po-gmail-sync/index.ts'),'utf8');
    assert(code.includes('(${query}) -from:(kingfoodmart.com)'));
    const skip=code.indexOf('if (isKfmPoIdentity(');
    assert(skip>0);assert(skip<code.indexOf('const isKingfoodSender ='));
    assert(skip<code.indexOf('.from("customer_po_inbox").upsert(payload'));
  });
  console.log(`${passed} KFM email cutover checks passed`);
})().catch(e=>{console.error(e);process.exit(1);});
