/* Behavioral tests: every transport is intercepted. Never touches real KFM. */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { webcrypto } = require('node:crypto');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
function moduleAt(file, env = {}) {
  const source = fs.readFileSync(path.join(root, file), 'utf8');
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const exports = {};
  vm.runInNewContext(output, { exports, require: () => { throw Error('Unexpected import'); }, URL, URLSearchParams, Request, Response, Headers, AbortSignal, TextEncoder, Uint8Array, crypto: webcrypto, setTimeout, clearTimeout, btoa, atob, ...env }, { filename: file });
  return exports;
}
let requests = [], transport;
const client = moduleAt('supabase/functions/_shared/kfm-portal.ts', { fetch: (...args) => { requests.push(args); return transport(...args); } });
const date = client.vnDate(1);
const source = { po: { id: 239751, code: 'PO1002646817', vendorId: 1865, vendorCode: 'V000217', companyId: 10, locationId: 1445, status: 2 }, items: [110,150].map((qty,i) => ({ id: i+1, productCode: 'P'+i, productName: 'Bread '+i, qty, unitName: 'CÁI', variantId: i+1 })), shippedMap: {} };
const options = { deliveryType: null, vehicleTypes: [{ id: 1, name: 'Xe tải' }], vehicleTypeId: 1, slots: [], companyId: 10 };
const form = { vehicleTypeId: 1, expectedTimeFrom: '08:00', expectedTimeTo: '09:00', licensePlate: 'TEST', totalCartons: 2, totalPallets: 0 };
const body = client.buildTripSubmission(source, date, options, form);
const load = { id: 44, loadCode: 'IL-TEST', loadStatus: 'CONFIRMED', deliveryDate: date, licensePlate: 'TEST', driverName: '', driverPhone: '', asns: [{ id: 55, code: 'ASN-TEST', locationId: 1445, items: body.stops[0].items }] };
let passed = 0;
async function test(name, fn) { requests=[]; await fn(); passed++; console.log('ok', name); }
const json = data => new Response(JSON.stringify({ data }), { status: 200 });

function bridge({ permission = true, vendorIds = [1865], changed = false, outcome = 'success', inScope = true, childVendor = false } = {}) {
  const records = new Map(); let handler, postCount = 0, sourceReads=0;
  const admin = { auth: { getUser: async () => ({ data: { user: { id: 'fixture-user' } } }) }, from(table) {
    let operation='select', value, filters={};
    const query = { select(){return query;}, eq(k,v){filters[k]=v;return query;}, maybeSingle(){return query;}, insert(v){operation='insert';value=v;return query;}, update(v){operation='update';value=v;return query;}, then(resolve,reject) {
      return Promise.resolve().then(() => {
        if(table==='user_roles')return {data:permission?[{role:'owner'}]:[],error:null};
        if(table==='user_module_permissions')return {data:[],error:null};
        assert.equal(table,'kfm_trip_attempts');
        const key = `${value?.vendor_id??filters.vendor_id}:${value?.order_id??filters.order_id}`;
        if(operation==='insert') { if(records.has(key))return {error:{code:'23505'}};records.set(key,structuredClone(value));return {error:null}; }
        if(operation==='update') { const record=records.get(key);if(record)Object.assign(record,value);return {error:null}; }
        return {data:records.get(key)||null,error:null};
      }).then(resolve,reject);
    }}; return query;
  }};
  transport = async (url, init={}) => {
    if (init.method === 'POST' && url.includes('/inbound-loads?')) {
      postCount++; assert(url.endsWith('&submit=true')); assert.equal(JSON.parse(init.body).stops[0].items.length,2);
      if(outcome==='timeout')throw Error('simulated lost response after write');
      if(outcome==='missing')throw Error('simulated network failure');
      return json({loadId:44});
    }
    if(url.includes('/orders/239751/asn'))return json([]);
    if(url.includes('/inbound-loads/44'))return json(outcome==='mismatch'?{...load,asns:[]}:load);
    if(url.includes('/inbound-loads?'))return json({content:outcome==='missing'?[]:[{id:44}],totalElements:outcome==='missing'?0:1});
    throw Error('Unexpected transport '+url);
  };
  const shared = { ...client, openSession: async()=>({token:'fixture-only',mode:'test'}),getMe:async()=>({vendorIds,vendorCode:'FIXTURE'}),getTripOptions:async()=>options,tripOrderInScope:async()=>inScope,
    getTripSource:async()=>{sourceReads++;return changed?{...source,shippedMap:{P0:5}}:childVendor?{...source,po:{...source.po,vendorId:2797,vendorCode:'V000217.1'}}:source;},
  };
  moduleAt('supabase/functions/kfm-portal-sync/index.ts', {
    Deno:{env:{get:()=> 'fixture-only'}},
    require(spec) {
      if(spec.includes('/http/server'))return {serve:fn=>handler=fn};
      if(spec.includes('supabase-js'))return {createClient:()=>admin};
      if(spec.includes('cors'))return {getCorsHeaders:()=>({}),corsPreflightResponse:()=>new Response(null,{status:204})};
      if(spec.includes('kfm-portal'))return shared;
      throw Error('Unexpected import '+spec);
    },
  });
  return {records,get postCount(){return postCount;}, get sourceReads(){return sourceReads;},async call(payload){const res=await handler(new Request('https://fixture.invalid',{method:'POST',headers:{Authorization:'Bearer fixture-only','Content-Type':'application/json'},body:JSON.stringify(payload)}));return {status:res.status,...await res.json()};}};
}

(async()=>{
  await test('source qty and zero cartons retained, stop time matches portal',()=>{assert.equal(body.stops[0].items[0].shipQty,110);assert.equal(body.stops[0].items[0].cartons,0);assert.equal(body.stops[0].bookingStartDatetime,date+'T08:00:00+07:00');});
  await test('fully allocated PO refuses creation',()=>assert.throws(()=>client.buildTripSubmission({...source,shippedMap:{P0:110,P1:150}},date,options,form)));
  await test('approved quantity wins, partial allocations follow portal rule',()=>{const s={...source,items:[{...source.items[0],approvalStatus:'APPROVED',finalQuantity:80}],shippedMap:{P0:10}};assert.equal(client.buildTripSubmission(s,date,options,form).stops[0].items[0].shipQty,80);});
  await test('unknown vehicle and invalid time/totals rejected',()=>{for(const change of [{vehicleTypeId:999},{expectedTimeFrom:'99:00'},{expectedTimeTo:'07:00'},{totalCartons:-1},{totalPallets:1.5}])assert.throws(()=>client.buildTripSubmission(source,date,options,{...form,...change}));});
  await test('full slot rejected',()=>assert.throws(()=>client.buildTripSubmission(source,date,{...options,deliveryType:'HUB',slots:[{value:'08:00-09:00',available:false}]},{...form,bookingTimeSlot:'08:00-09:00'})));
  await test('per-line ASN verification, not total-only',()=>{assert(client.verifyTripReadback(load,body));assert(!client.verifyTripReadback({...load,asns:[{...load.asns[0],items:[{...body.stops[0].items[0],shipQty:150},{...body.stops[0].items[1],shipQty:110}]}]},body));assert(!client.verifyTripReadback({...load,loadStatus:'DRAFT'},body));});
  await test('fingerprint changes with shippedMap even when eligible qty unchanged',async()=>assert.notEqual(await client.tripRevision(source,date),await client.tripRevision({...source,shippedMap:{P0:1}},date)));
  const revision = await client.tripRevision(source,date);
  const payload = {action:'create-load',orderId:239751,deliveryDate:date,revision,form,confirmed:true,requestId:'00000000-0000-4000-8000-000000000001'};
  await test('permission denied before portal access',async()=>{const b=bridge({permission:false});assert.equal((await b.call(payload)).status,403);assert.equal(b.postCount,0);assert.equal(b.sourceReads,0);});
  await test('vendor membership enforced',async()=>{const b=bridge();assert.equal((await b.call({...payload,vendorId:999})).status,403);assert.equal(b.postCount,0);});
  await test('PO outside scoped list cannot post',async()=>{const b=bridge({inScope:false});assert.equal((await b.call(payload)).success,false);assert.equal(b.postCount,0);});
  await test('authorized child vendor PO can create through parent session',async()=>{const b=bridge({childVendor:true});const child={...source,po:{...source.po,vendorId:2797,vendorCode:'V000217.1'}};assert.equal((await b.call({...payload,revision:await client.tripRevision(child,date)})).result.state,'verified');assert.equal(b.postCount,1);});
  await test('stale review cannot post',async()=>{const b=bridge({changed:true});assert.equal((await b.call(payload)).success,false);assert.equal(b.postCount,0);});
  await test('explicit confirmation required',async()=>{const b=bridge();assert.equal((await b.call({...payload,confirmed:false})).success,false);assert.equal(b.postCount,0);});
  await test('concurrent clicks produce exactly one POST and durable claim',async()=>{const b=bridge();const responses=await Promise.all([b.call(payload),b.call({...payload,requestId:'00000000-0000-4000-8000-000000000002'})]);assert.equal(b.postCount,1);assert.equal(b.records.size,1);assert(responses.some(r=>r.result?.state==='verified'));await b.call(payload);assert.equal(b.postCount,1);});
  await test('lost successful response recovered through GET only',async()=>{const b=bridge({outcome:'timeout'});assert.equal((await b.call(payload)).result.state,'verified');assert.equal(b.postCount,1);});
  await test('unknown outcome stays locked across reopen and result checks',async()=>{const b=bridge({outcome:'missing'});assert.equal((await b.call(payload)).result.state,'unknown');await b.call({...payload,action:'trip-options'});await b.call({...payload,action:'trip-result'});await b.call(payload);assert.equal(b.postCount,1);assert.equal(b.records.size,1);});
  await test('mismatched readback never returns verified',async()=>{const b=bridge({outcome:'mismatch'});assert.equal((await b.call(payload)).result.state,'unknown');assert.equal(b.postCount,1);});
  await test('result check without journal never creates',async()=>{const b=bridge();assert.equal((await b.call({...payload,action:'trip-result'})).result.state,'not_sent');assert.equal(b.postCount,0);});
  await test('BOOKING options use verified logistics query and time object mapping',async()=>{
    transport=async(url)=>{if(url.includes('warehouse-context'))return json({masterWarehouseId:9});if(url.includes('/delivery-config?'))return json({});if(url.includes('/delivery-vendors/lookup'))return json({warehouses:[{found:true,hasFixedSchedule:false,vehicles:[{vehicleTypeId:1,vehicleTypeName:'Truck'}]}]});if(url.includes('/available-slots?'))return json([{startTime:{hour:8,minute:0},endTime:{hour:9,minute:0},isAvailable:true,startDatetime:1,endDatetime:2}]);throw Error(url);};
    const o=await client.getTripOptions('fixture-only',1865,source,date,1);assert.equal(o.deliveryType,'BOOKING');assert.equal(o.slots[0].value,'08:00-09:00');assert(requests.every(([url,init])=>init.method==='GET'));
  });
  console.log(`PASS ${passed} behavioral tests; no real KFM request`);
})().catch(e=>{console.error(e);process.exitCode=1;});
