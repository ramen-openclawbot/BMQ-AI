/* All partner transports and DB clients are mocked. No real PO decisions. */
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const ts=require('typescript'),{webcrypto}=require('node:crypto');
const root=path.resolve(__dirname,'..');
function load(file,env={}) { const exports={};vm.runInNewContext(ts.transpileModule(fs.readFileSync(path.join(root,file),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports,require(){throw Error('Unexpected import');},URL,URLSearchParams,Request,Response,Headers,AbortSignal,TextEncoder,Uint8Array,crypto:webcrypto,setTimeout,clearTimeout,btoa,atob,...env});return exports; }
const portal=load('supabase/functions/_shared/kfm-portal.ts',{fetch(){throw Error('Real network prohibited');}});
const base={po:{id:11,code:'PO-TEST',deliveryDate:portal.vnDate(1),locationId:4,locationName:'Warehouse',vendorId:2797,status:2,subStatus:3},items:[{productCode:'1001',barcode:'SP001',productName:'BMQ Bread',unitName:'CÁI',qty:10,unitPrice:100,taxRate:8}],shippedMap:{}};
const skus=[{id:'sku1',sku_code:'BREAD',product_name:'Bread',sku_type:'finished_good'}],settings=[{sku_id:'sku1',is_enabled:true}];
function fixture({outcome='success',scope=true,changed=false,importFail=false,old=[],disabled=false,customerMissing=false}={}) {
 let source=structuredClone(base),posts=0,imports=0;const rows=new Map();
 const shared={...portal,getTripSource:async()=>structuredClone(source),tripOrderInScope:async()=>scope,listOrders:async()=>({orders:[{portalId:11,code:source.po.code,subStatus:source.po.subStatus}],totalElements:1}),confirmOrder:async()=>{posts++;if(outcome!=='missing')source.po.subStatus=5;if(changed)source.items[0].qty=12;if(outcome==='timeout'||outcome==='missing')throw Error('lost');},rejectOrder:async()=>{posts++;if(outcome!=='missing')source.po.subStatus=11;if(outcome==='timeout')throw Error('lost');}};
 const intake=load('supabase/functions/_shared/kfm-intake.ts',{require:()=>shared});
 const admin={rpc:async(name,args)=>{
   if(name==='kfm_existing_po_numbers')return {data:old.map(po_number=>({po_number}))};
   if(name==='kfm_intake_customer_id')return customerMissing?{error:{message:'Missing mapping'}}:{data:'customer1'};
   assert.equal(name,'kfm_import_confirmed_po');if(importFail)return {error:{message:'database unavailable'}};
   const row=rows.get(args.p_order_id);if(row.state!=='imported')imports++;row.state='imported';row.inbox_id='inbox1';return {data:'inbox1'};
 },from(table){let op='select',value,filters={},single=false;const q={select(){return q;},eq(k,v){filters[k]=v;return q;},maybeSingle(){single=true;return q;},insert(v){op='insert';value=v;return q;},update(v){op='update';value=v;return q;},then(resolve,reject){return Promise.resolve().then(()=>{
  if(table==='product_skus')return {data:skus};if(table==='production_location_sku_settings')return {data:disabled?[]:settings};
  assert.equal(table,'kfm_po_intake_attempts');if(op==='insert'){if(rows.has(value.order_id))return {error:{code:'23505'}};rows.set(value.order_id,structuredClone(value));return {};}
  if(op==='update'){Object.assign(rows.get(filters.order_id),value);return {};}
  return {data:single?rows.get(filters.order_id)||null:[...rows.values()]};
 }).then(resolve,reject);}};return q;}};
 return {intake,rows,get posts(){return posts;},get imports(){return imports;},set importFail(v){importFail=v;},setSource(v){source=v;},async call(payload){return intake.handleKfmIntake(admin,'fixture',1865,'actor',payload);},async decide(extra={}){return this.call({action:'intake-decide',orderId:11,decision:'confirm',revision:await intake.intakeRevision(base),requestId:'00000000-0000-4000-8000-000000000001',...extra});}};
}
function bridge({permission=true,vendorIds=[1865]}={}) {
 let handler,intakeCalls=0,portalReads=0;
 const admin={auth:{getUser:async()=>({data:{user:{id:'actor'}}})},from(table){return {select(){return this;},eq(){return this;},then(resolve){return Promise.resolve(table==='user_roles'?{data:permission?[{role:'owner'}]:[]}:{data:[]}).then(resolve);}}}};
 load('supabase/functions/kfm-portal-sync/index.ts',{Deno:{env:{get:()=> 'fixture'}},require(spec){
  if(spec.includes('/http/server'))return {serve:fn=>handler=fn};
  if(spec.includes('supabase-js'))return {createClient:()=>admin};
  if(spec.includes('cors'))return {getCorsHeaders:()=>({}),corsPreflightResponse:()=>new Response(null,{status:204})};
  if(spec.includes('kfm-intake'))return {handleKfmIntake:async()=>{intakeCalls++;return {success:true,orders:[]};}};
  if(spec.includes('kfm-portal'))return {...portal,openSession:async()=>{portalReads++;return {token:'fixture',mode:'test'};},getMe:async()=>({vendorIds})};
  throw Error('Unexpected import');
 }});
 return {get intakeCalls(){return intakeCalls;},get portalReads(){return portalReads;},async call(payload){const response=await handler(new Request('https://test.invalid',{method:'POST',headers:{Authorization:'Bearer fixture','Content-Type':'application/json'},body:JSON.stringify(payload)}));return {status:response.status,...await response.json()};}};
}
let passed=0;async function test(name,fn){await fn();passed++;console.log('ok',name);}
(async()=>{
await test('poll finds future PO and never sends or imports',async()=>{const f=fixture();const r=await f.call({action:'intake-list'});assert.equal(r.orders.length,1);assert.equal(r.orders[0].items[0].qty,10);assert.equal(f.posts,0);assert.equal(f.imports,0);});
await test('legacy canonical PO is not prompted again',async()=>{const f=fixture({old:[' po-test ']});assert.equal((await f.call({action:'intake-list'})).count,0);});
await test('confirm then verified readback imports once',async()=>{const f=fixture();assert.equal((await f.decide()).result.state,'imported');assert.equal(f.posts,1);assert.equal(f.imports,1);await f.decide();assert.equal(f.posts,1);assert.equal(f.imports,1);});
await test('concurrent staff decisions send exactly once',async()=>{const f=fixture();await Promise.all([f.decide(),f.decide({decision:'reject',reason:'No capacity',requestId:'00000000-0000-4000-8000-000000000002'})]);assert.equal(f.posts,1);assert.equal(f.rows.size,1);});
await test('lost successful response reconciles without retry',async()=>{const f=fixture({outcome:'timeout'});assert.equal((await f.decide()).result.state,'imported');assert.equal(f.posts,1);});
await test('unconfirmed unknown outcome neither imports nor retries',async()=>{const f=fixture({outcome:'missing'});assert.equal((await f.decide()).result.state,'unknown');await f.call({action:'intake-result',orderId:11});await f.decide();assert.equal(f.posts,1);assert.equal(f.imports,0);});
await test('post-confirm import error resumes local import only',async()=>{const f=fixture({importFail:true});assert.equal((await f.decide()).result.state,'unknown');f.importFail=false;assert.equal((await f.call({action:'intake-result',orderId:11})).result.state,'imported');assert.equal(f.posts,1);});
await test('reject needs reason and never imports',async()=>{const f=fixture();await assert.rejects(()=>f.decide({decision:'reject'}));assert.equal(f.posts,0);assert.equal((await f.decide({decision:'reject',reason:'No capacity'})).result.state,'rejected');assert.equal(f.imports,0);});
await test('foreign scoped PO denied before any write',async()=>{const f=fixture({scope:false});await assert.rejects(()=>f.decide());assert.equal(f.posts,0);});
await test('changed review returns fresh PO, no write',async()=>{const f=fixture();const r=await f.decide({revision:'old'});assert.equal(r.result.state,'changed');assert.equal(r.order.orderId,11);assert.equal(f.posts,0);});
await test('changed contents after confirm block import',async()=>{const f=fixture({changed:true});assert.equal((await f.decide()).result.state,'blocked');assert.equal(f.imports,0);});
await test('cancelled PO cannot be confirmed',async()=>{const f=fixture();const s=structuredClone(base);s.po.subStatus=11;f.setSource(s);assert.equal((await f.decide({revision:await f.intake.intakeRevision(s)})).result.state,'blocked');assert.equal(f.posts,0);});
await test('already confirmed portal PO imports without second confirm',async()=>{const f=fixture();const s=structuredClone(base);s.po.subStatus=5;f.setSource(s);assert.equal((await f.decide({revision:await f.intake.intakeRevision(s)})).result.state,'imported');assert.equal(f.posts,0);});
await test('SKU disabled blocks before confirmation',async()=>{const f=fixture({disabled:true});await assert.rejects(()=>f.decide());assert.equal(f.posts,0);});
await test('SKU ambiguous is not guessed',async()=>{const f=fixture();const p=f.intake.productionPayload(base,1865,'actor');assert.throws(()=>f.intake.mapIntakeSkus(p,[...skus,{...skus[0],id:'sku2'}],settings));});
await test('approved final quantity and VAT preserved in production schema',async()=>{const f=fixture();const s=structuredClone(base);s.items[0].approvalStatus='APPROVED';s.items[0].finalQuantity=8;const p=f.intake.productionPayload(s,1865,'actor');assert.equal(p.production_items[0].qty,8);assert.equal(p.total_amount,864);assert.equal(p.raw_payload.source,'kfm_portal');});
await test('no durable claim readback returns safe fresh decision',async()=>{const f=fixture();const r=await f.call({action:'intake-result',orderId:11});assert.equal(r.result.state,'changed');assert.equal(f.posts,0);});
await test('intake routes require Q7 edit before portal access',async()=>{for(const action of ['intake-list','intake-decide','intake-result']){const b=bridge({permission:false});assert.equal((await b.call({action})).status,403);assert.equal(b.portalReads,0);assert.equal(b.intakeCalls,0);}});
await test('intake vendor membership enforced before helper',async()=>{const b=bridge();assert.equal((await b.call({action:'intake-list',vendorId:99})).status,403);assert.equal(b.intakeCalls,0);});
await test('legacy confirm cannot bypass durable intake',async()=>{const b=bridge();assert.equal((await b.call({action:'confirm',orderId:11})).error,'intake_required');assert.equal(b.intakeCalls,0);});
await test('six live-shape products preserve croissant pack distinctions and known croffle alias',async()=>{
 const f=fixture();const productNames=['BÁNH CROISSANT 50G','Bánh Mì Chà Bông','BÁNH MÌ CHÀ BÔNG CAY','BÁNH CUA PHÔ MAI','BÁNH CROISSANT 160G (40G x 4 CÁI)','BÁNH CROFFLE 160G (40G x 4 CÁI)'];
 const codes=['Croi-2026-v4','bmcb-2026-v2','cbc-2026-v2','cpm-2026-v3','KF-CROISSANT-40G-T0526','KF-CROFFLE-40G-T0526'];
 const catalog=productNames.map((product_name,i)=>({id:'sku'+i,product_name,sku_code:codes[i],sku_type:'finished_good'}));
 const source=structuredClone(base);source.items=productNames.map((name,i)=>({productCode:String(100+i),barcode:i===5?'SP001596':'SP'+i,productName:'BMQ - '+name+([1,2].includes(i)?' 70G':i===3?' 90G':''),unitName:i<3?'CÁI':'HỘP',qty:[110,150,165,159,65,27][i],unitPrice:100,taxRate:8}));
 const mapped=f.intake.mapIntakeSkus(f.intake.productionPayload(source,1865,'actor'),catalog,catalog.map(row=>({sku_id:row.id,is_enabled:true})));
 assert.deepEqual(Array.from(mapped.production_items,row=>row.sku_code),codes);
 assert.equal(mapped.production_items.reduce((sum,row)=>sum+row.qty,0),676);
});
await test('legacy imported after popup prevents stale decision POST',async()=>{const f=fixture({old:['PO-TEST']});assert.equal((await f.decide()).result.state,'blocked');assert.equal(f.posts,0);assert.equal(f.rows.size,0);});
await test('missing customer mapping blocks before irreversible confirm',async()=>{const f=fixture({customerMissing:true});await assert.rejects(()=>f.decide());assert.equal(f.posts,0);assert.equal(f.rows.size,0);});
console.log(`PASS ${passed} portal-intake behavioral tests`);
})().catch(error=>{console.error(error);process.exit(1);});
