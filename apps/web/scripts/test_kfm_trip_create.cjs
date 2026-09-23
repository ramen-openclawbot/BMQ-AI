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
const fleet = {vehicles:[{id:1,plateNumber:'TEST',defaultDriverId:2}],drivers:[{id:2,name:'Driver',phone:'0123456789'}]};
const date = client.vnDate(1);
const source = { po: { id: 239751, code: 'PO1002646817', deliveryDate: date, vendorId: 1865, vendorCode: 'V000217', companyId: 10, locationId: 1445, status: 2, subStatus: 6 }, items: [110,150].map((qty,i) => ({ id: i+1, productCode: 'P'+i, productName: 'Bread '+i, qty, unitName: 'CÁI', variantId: i+1 })), shippedMap: {} };
const options = { deliveryType: null, vehicleTypes: [{ id: 1, name: 'Xe tải' }], vehicleTypeId: 1, slots: [], companyId: 10 };
const form = { vehicleTypeId: 1, expectedTimeFrom: '08:00', expectedTimeTo: '09:00', licensePlate: 'TEST', totalCartons: 2, totalPallets: 0 };
const body = client.buildTripSubmission(source, date, options, form);
const load = { id: 44, loadCode: 'IL-TEST', loadStatus: 'CONFIRMED', deliveryDate: date, licensePlate: 'TEST', driverName: '', driverPhone: '', asns: [{ id: 55, code: 'ASN-TEST', locationId: 1445, items: body.stops[0].items }] };
let passed = 0;
async function test(name, fn) { requests=[]; await fn(); passed++; console.log('ok', name); }
const json = data => new Response(JSON.stringify({ data }), { status: 200 });
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// The create-load revision is a fingerprint of the PO state the operator saw.
async function revisionFor(subStatus = 6, fleetArg) {
  const s = structuredClone(source); s.po.subStatus = subStatus;
  return client.tripRevision(s, date, fleetArg);
}
async function payloadFor(subStatus = 6, extra = {}) {
  return { action: 'create-load', orderId: 239751, deliveryDate: date, revision: await revisionFor(subStatus), form, confirmed: true, requestId: uuid(1), ...extra };
}

/**
 * Every partner transport AND the real `handleKfmIntake` helper run here. Only
 * raw KFM HTTP and the Postgres client are faked, so the durable intake claim
 * that gates the trip write is the production code, not a stub.
 */
function bridge({ permission = true, vendorIds = [1865], changed = false, outcome = 'success', inScope = true, childVendor = false, poStatus = 6, pendingChanged = false, poReadFails = false, existingNotes = [], asnFailure = false, savedChanged = false, intakeOutcome = 'success', importFail = false, disabled = false, legacy = [], preTrip = false, preIntake = null, rawCatalog = false } = {}) {
  const records = new Map(); let handler, tripPosts = 0, sourceReads = 0, catalogReads = 0, poSubStatus = poStatus;
  const catalogRowsSeen = [];
  let portalConfirms = 0, portalRejects = 0, imports = 0, importFailNow = importFail;
  const intakeRows = new Map(), events = [];
  const tripKey = '1865:239751';
  const currentSource = () => {
    const s = structuredClone(source);
    s.po.subStatus = poSubStatus;
    if (changed) s.shippedMap = { P0: 5 };
    if (childVendor) s.po = { ...s.po, vendorId: 2797, vendorCode: 'V000217.1' };
    return s;
  };
  const skuRows = () => currentSource().items.map((item, i) => ({ id: 'sku' + i, sku_code: 'SKU' + i, product_name: item.productName, sku_type: rawCatalog ? 'raw_material' : 'finished_good' }));
  const settingRows = () => skuRows().map(row => ({ sku_id: row.id, is_enabled: true }));
  const admin = { auth: { getUser: async () => ({ data: { user: { id: 'fixture-user' } } }) }, rpc: async (name, args) => {
    if (name === 'kfm_existing_po_numbers') return { data: legacy.map(po_number => ({ po_number })), error: null };
    if (name === 'kfm_intake_customer_id') return { data: 'customer-1', error: null };
    assert.equal(name, 'kfm_import_confirmed_po');
    if (importFailNow) return { error: { message: 'database unavailable' } };
    const row = intakeRows.get(args.p_order_id);
    if (!row || row.decision !== 'confirm') return { error: { message: 'claim missing' } };
    if (row.state !== 'imported') { imports++; row.state = 'imported'; row.inbox_id = 'inbox-1'; }
    return { data: 'inbox-1', error: null };
  }, from(table) {
    let operation='select', value, filters={}, single=false, orFilter=null;
    const query = { select(){return query;}, eq(k,v){filters[k]=v;return query;}, or(expr){orFilter=expr;return query;}, order(){return query;}, range(){return query;}, maybeSingle(){single=true;return query;}, insert(v){operation='insert';value=v;return query;}, update(v){operation='update';value=v;return query;}, then(resolve,reject) {
      return Promise.resolve().then(() => {
        if(table==='user_roles')return {data:permission?[{role:'owner'}]:[],error:null};
        if(table==='user_module_permissions')return {data:[],error:null};
        if(table==='product_skus'){const matchOr=(row,expr)=>expr.split(',').some(clause=>{const [field,compare,expected]=clause.split('.');if(compare==='eq')return row[field]===expected;if(compare==='is')return expected==='null'?row[field]==null:row[field]===expected;throw Error('Unsupported mock filter '+clause);});const rows=orFilter?skuRows().filter(row=>matchOr(row,orFilter)):skuRows();catalogReads++;catalogRowsSeen.push(...rows);return {data:rows,error:null};}
        if(table==='production_location_sku_settings')return {data:disabled?[]:settingRows(),error:null};
        if(table==='kfm_po_intake_attempts') {
          const key = value?.order_id ?? filters.order_id;
          if(operation==='insert') { if(intakeRows.has(key))return {error:{code:'23505'}};intakeRows.set(key,structuredClone(value));return {error:null}; }
          if(operation==='update') { const row=intakeRows.get(key);if(row)Object.assign(row,value);return {error:null}; }
          return {data:single?intakeRows.get(key)||null:[...intakeRows.values()],error:null};
        }
        assert.equal(table,'kfm_trip_attempts');
        const key = `${value?.vendor_id??filters.vendor_id}:${value?.order_id??filters.order_id}`;
        if(operation==='insert') { if(records.has(key))return {error:{code:'23505'}};records.set(key,structuredClone(value));return {error:null}; }
        if(operation==='update') { const record=records.get(key);if(record)Object.assign(record,value);return {error:null}; }
        return {data:single?records.get(key)||null:[...records.values()],error:null};
      }).then(resolve,reject);
    }}; return query;
  }};
  transport = async (url, init={}) => {
    if (init.method === 'POST' && url.includes('/inbound-loads?')) {
      tripPosts++; events.push('trip'); assert(url.endsWith('&submit=true')); assert.equal(JSON.parse(init.body).stops[0].items.length,2);
      if(outcome==='timeout')throw Error('simulated lost response after write');
      if(outcome==='missing')throw Error('simulated network failure');
      return json({loadId:44});
    }
    if(url.includes('/export-pdf'))return new Response(new Uint8Array([37,80,68,70]),{status:200});
    if(url.includes('/orders/239751/asn'))return asnFailure ? new Response('{}',{status:503}) : json(existingNotes);
    if(url.includes('/inbound-loads/44'))return json(outcome==='mismatch'?{...load,asns:[]}:load);
    if(url.includes('/inbound-loads?'))return json({content:outcome==='missing'?[]:[{id:44}],totalElements:outcome==='missing'?0:1});
    if(url.includes('/purchase-orders/239751/request-items'))return json(pendingChanged?[{requestCategory:'QUALITY',itemStatus:'NEW'}]:[]);
    throw Error('Unexpected transport '+url);
  };
  const shared = { ...client, openSession: async()=>({token:'fixture-only',mode:'test'}),openSessionWithLoginGuard:async()=>({token:'fixture-only',mode:'test',obtainedAt:'fixture'}),getMe:async()=>({vendorIds,vendorCode:'FIXTURE'}),getTripOptions:async()=>options,getSavedTripFleet:async()=>savedChanged?{...fleet,drivers:[{...fleet.drivers[0],phone:'changed'}]}:fleet,tripOrderInScope:async()=>inScope,getTripPendingChanges:async()=>pendingChanged?[{requestCategory:'QUALITY',itemStatus:'NEW'}]:[],
    getTripSource:async()=>{sourceReads++;if(tripPosts && poReadFails)throw Error('PO read failed');return currentSource();},
    listOrders:async()=>({orders:[{portalId:239751,code:source.po.code,subStatus:poSubStatus}],totalElements:1}),
    confirmOrder:async()=>{portalConfirms++;events.push('confirm');if(intakeOutcome!=='missing')poSubStatus=5;if(intakeOutcome==='timeout'||intakeOutcome==='missing')throw Error('lost confirm response');},
    rejectOrder:async()=>{portalRejects++;events.push('reject');if(intakeOutcome!=='missing')poSubStatus=11;if(intakeOutcome==='timeout')throw Error('lost reject response');},
  };
  // The real durable-intake helper, wired to the same faked Postgres + transport.
  const intake = moduleAt('supabase/functions/_shared/kfm-intake.ts', { require: () => shared });
  if (preTrip) records.set(tripKey, { vendor_id: 1865, order_id: 239751, actor_id: 'fixture-user', request_id: uuid(9), body: structuredClone(body), baseline_asn_ids: [], load_id: 44, state: 'unknown' });
  if (preIntake) intakeRows.set(239751, { vendor_id: 1865, order_id: 239751, po_number: source.po.code, actor_id: 'fixture-user', request_id: uuid(8), decision: preIntake, reason: preIntake === 'reject' ? 'No capacity' : null, state: preIntake === 'confirm' ? 'imported' : 'sending', content_revision: 'fixture', snapshot: {}, inbox_id: preIntake === 'confirm' ? 'inbox-1' : null });
  moduleAt('supabase/functions/kfm-portal-sync/index.ts', {
    Deno:{env:{get:()=> 'fixture-only'}},
    require(spec) {
      if(spec.includes('/http/server'))return {serve:fn=>handler=fn};
      if(spec.includes('supabase-js'))return {createClient:()=>admin};
      if(spec.includes('cors'))return {getCorsHeaders:()=>({}),corsPreflightResponse:()=>new Response(null,{status:204})};
      if(spec.includes('kfm-intake'))return intake;
      if(spec.includes('kfm-login-guard'))return {createKfmPasswordLoginGuard:()=>({}),createKfmSharedSessionStore:()=>({})};
      if(spec.includes('kfm-portal'))return shared;
      throw Error('Unexpected import '+spec);
    },
  });
  return {records,intake,events,get postCount(){return tripPosts;},get tripPosts(){return tripPosts;},get sourceReads(){return sourceReads;},get catalogReads(){return catalogReads;},get catalogRowsSeen(){return catalogRowsSeen;},get portalConfirms(){return portalConfirms;},get portalRejects(){return portalRejects;},get imports(){return imports;},get intakeRows(){return intakeRows;},set poSubStatus(v){poSubStatus=v;},set importFail(v){importFailNow=v;},async call(payload){const res=await handler(new Request('https://fixture.invalid',{method:'POST',headers:{Authorization:'Bearer fixture-only','Content-Type':'application/json'},body:JSON.stringify(payload)}));return {status:res.status,...await res.json()};}};
}

(async()=>{
  await test('historical imported claim cannot override currently pending PO',async()=>{
    const b=bridge({poStatus:3});b.intakeRows.set(239751,{vendor_id:1865,order_id:239751,decision:'confirm',state:'imported',inbox_id:'old'});
    const r=await b.call(await payloadFor(3));assert.equal(r.success,false);assert.equal(b.tripPosts,0);assert.equal(b.portalConfirms,0);
  });
  await test('pending edit request blocks pending PO before confirmation',async()=>{
    const b=bridge({poStatus:3,pendingChanged:true});const s=structuredClone(source);s.po.subStatus=3;s.pendingChanges=[{requestCategory:'QUALITY',itemStatus:'NEW'}];
    const r=await b.call(await payloadFor(3,{revision:await client.tripRevision(s,date)}));assert.equal(r.success,false);assert.equal(b.portalConfirms,0);assert.equal(b.tripPosts,0);
  });
  await test('source qty and zero cartons retained, stop time matches portal',()=>{assert.equal(body.stops[0].items[0].shipQty,110);assert.equal(body.stops[0].items[0].cartons,0);assert.equal(body.stops[0].bookingStartDatetime,date+'T08:00:00+07:00');});
  await test('fully allocated PO refuses creation',()=>assert.throws(()=>client.buildTripSubmission({...source,shippedMap:{P0:110,P1:150}},date,options,form)));
  await test('approved quantity wins, partial allocations follow portal rule',()=>{const s={...source,items:[{...source.items[0],approvalStatus:'APPROVED',finalQuantity:80}],shippedMap:{P0:10}};assert.equal(client.buildTripSubmission(s,date,options,form).stops[0].items[0].shipQty,80);});
  await test('unknown vehicle and invalid time/totals rejected',()=>{for(const change of [{vehicleTypeId:999},{expectedTimeFrom:'99:00'},{expectedTimeTo:'07:00'},{totalCartons:-1},{totalPallets:1.5}])assert.throws(()=>client.buildTripSubmission(source,date,options,{...form,...change}));});
  await test('full slot rejected',()=>assert.throws(()=>client.buildTripSubmission(source,date,{...options,deliveryType:'HUB',slots:[{value:'08:00-09:00',available:false}]},{...form,bookingTimeSlot:'08:00-09:00'})));
  await test('per-line ASN verification, not total-only',()=>{assert(client.verifyTripReadback(load,body));assert(!client.verifyTripReadback({...load,asns:[{...load.asns[0],items:[{...body.stops[0].items[0],shipQty:150},{...body.stops[0].items[1],shipQty:110}]}]},body));assert(!client.verifyTripReadback({...load,loadStatus:'DRAFT'},body));});
  await test('fingerprint changes with shippedMap even when eligible qty unchanged',async()=>assert.notEqual(await client.tripRevision(source,date),await client.tripRevision({...source,shippedMap:{P0:1}},date)));
  const revision = await revisionFor(6);
  const payload = {action:'create-load',orderId:239751,deliveryDate:date,revision,form,confirmed:true,requestId:uuid(1)};
  await test('permission denied before portal access',async()=>{const b=bridge({permission:false});assert.equal((await b.call(payload)).status,403);assert.equal(b.postCount,0);assert.equal(b.sourceReads,0);});
  await test('vendor membership enforced',async()=>{const b=bridge();assert.equal((await b.call({...payload,vendorId:999})).status,403);assert.equal(b.postCount,0);});
  await test('PO outside scoped list cannot post',async()=>{const b=bridge({inScope:false});assert.equal((await b.call(payload)).success,false);assert.equal(b.postCount,0);});
  await test('authorized child vendor PO can create through parent session',async()=>{const b=bridge({childVendor:true});const child={...source,po:{...source.po,vendorId:2797,vendorCode:'V000217.1'}};assert.equal((await b.call({...payload,revision:await client.tripRevision(child,date)})).result.state,'verified');assert.equal(b.postCount,1);});
  await test('stale review cannot post',async()=>{const b=bridge({changed:true});assert.equal((await b.call(payload)).success,false);assert.equal(b.postCount,0);});
  await test('explicit confirmation required',async()=>{const b=bridge();assert.equal((await b.call({...payload,confirmed:false})).success,false);assert.equal(b.postCount,0);});
  await test('concurrent clicks produce exactly one POST and durable claim',async()=>{const b=bridge();const responses=await Promise.all([b.call(payload),b.call({...payload,requestId:uuid(2)})]);assert.equal(b.postCount,1);assert.equal(b.records.size,1);assert(responses.some(r=>r.result?.state==='verified'));await b.call(payload);assert.equal(b.postCount,1);});
  await test('lost successful response recovered through GET only',async()=>{const b=bridge({outcome:'timeout'});assert.equal((await b.call(payload)).result.state,'verified');assert.equal(b.postCount,1);});
  await test('unknown outcome stays locked across reopen and result checks',async()=>{const b=bridge({outcome:'missing'});assert.equal((await b.call(payload)).result.state,'unknown');await b.call({...payload,action:'trip-options'});await b.call({...payload,action:'trip-result'});await b.call(payload);assert.equal(b.postCount,1);assert.equal(b.records.size,1);});
  await test('mismatched readback never returns verified',async()=>{const b=bridge({outcome:'mismatch'});assert.equal((await b.call(payload)).result.state,'unknown');assert.equal(b.postCount,1);});
  await test('result check without journal never creates',async()=>{const b=bridge();assert.equal((await b.call({...payload,action:'trip-result'})).result.state,'not_sent');assert.equal(b.postCount,0);});
  await test('BOOKING options use verified logistics query and time object mapping',async()=>{
    transport=async(url)=>{if(url.includes('warehouse-context'))return json({masterWarehouseId:9});if(url.includes('/delivery-config?'))return json({});if(url.includes('/delivery-vendors/lookup'))return json({warehouses:[{found:true,hasFixedSchedule:false,vehicles:[{vehicleTypeId:1,vehicleTypeName:'Truck'}]}]});if(url.includes('/available-slots?'))return json([{startTime:{hour:8,minute:0},endTime:{hour:9,minute:0},isAvailable:true,startDatetime:1,endDatetime:2}]);throw Error(url);};
    const o=await client.getTripOptions('fixture-only',1865,source,date,1);assert.equal(o.deliveryType,'BOOKING');assert.equal(o.slots[0].value,'08:00-09:00');assert(requests.every(([url,init])=>init.method==='GET'));
  });
  await test('pending non-price changes follow portal filter and use GET',async()=>{
    transport=async()=>json([{requestCategory:'QUANTITY',itemStatus:'NEW'},{requestCategory:'QUALITY',itemStatus:'PENDING'},{requestCategory:'PRICE',itemStatus:'NEW'},{requestCategory:'OTHER',itemStatus:'RESOLVED'}]);
    const rows=await client.getTripPendingChanges('fixture-only',239751);assert.equal(rows.length,2);assert(requests[0][0].endsWith('/purchase-orders/239751/request-items'));assert.equal(requests[0][1].method || 'GET','GET');
    transport=async()=>new Response('{}',{status:500});await assert.rejects(()=>client.getTripPendingChanges('fixture-only',239751));
  });
  await test('changed pending requests invalidate review before POST',async()=>{const b=bridge({pendingChanged:true});assert.equal((await b.call(payload)).success,false);assert.equal(b.postCount,0);});
  await test('missing PO readback stays locked',async()=>{const b=bridge({poReadFails:true});assert.equal((await b.call(payload)).result.state,'unknown');await b.call(payload);assert.equal(b.postCount,1);});
  await test('PO confirmation uses portal subStatus not load or PO status',()=>{for(const subStatus of [5,6,9])assert(client.tripPoConfirmation({subStatus}).confirmed);for(const subStatus of [null,3,11,999])assert(!client.tripPoConfirmation({status:3,subStatus}).confirmed);});
  await test('saved fleet GETs match portal and never write',async()=>{
    transport=async(url,init)=>{assert.equal(init.method,'GET');return json(url.endsWith('/vehicles')?fleet.vehicles:fleet.drivers);};
    const value=await client.getSavedTripFleet('fixture-only');assert.equal(value.vehicles[0].defaultDriverId,2);assert.equal(value.drivers[0].name,'Driver');assert.equal(requests.length,2);
  });
  await test('unknown fleet response fails closed',async()=>{
    transport=async()=>json({unexpected:[]});await assert.rejects(()=>client.getSavedTripFleet('fixture-only'));
  });
  const savedForm={...form,savedVehicleId:1,savedDriverId:2,driverName:'Driver',driverPhone:'0123456789'};
  const unified={...payload,unifiedPrint:true,revision:await client.tripRevision(source,date,fleet),form:savedForm};
  await test('saved selection must match current portal, missing phone can be supplied',()=>{
    client.validateSavedTripForm(fleet,savedForm);
    for(const delta of [{savedVehicleId:99},{savedDriverId:99},{driverPhone:'forged'},{licensePlate:'forged'}])assert.throws(()=>client.validateSavedTripForm(fleet,{...savedForm,...delta}));
    client.validateSavedTripForm({...fleet,drivers:[{...fleet.drivers[0],phone:''}]},savedForm);
  });
  await test('default driver changes invalidate the snapshot',async()=>assert.notEqual(await client.tripRevision(source,date,fleet),await client.tripRevision(source,date,{...fleet,vehicles:[{...fleet.vehicles[0],defaultDriverId:3}]})));
  await test('unified print existing note returns before fleet or creation',async()=>{
    const b=bridge({existingNotes:[{id:55,code:'ASN-TEST'}]});const r=await b.call({...unified,action:'trip-options'});assert.equal(r.existingNotes[0].asnId,55);assert.equal(b.postCount,0);assert.equal(b.sourceReads,0);
  });
  await test('read-only user can print existing but cannot create missing note',async()=>{
    const b=bridge({permission:false,existingNotes:[{id:55,code:'ASN-TEST'}]});assert.equal((await b.call({...unified,action:'trip-options'})).existingNotes.length,1);assert.equal(b.postCount,0);
    const c=bridge({permission:false});assert.equal((await c.call({...unified,action:'trip-options'})).status,403);assert.equal(c.postCount,0);
  });
  await test('ASN read failure cannot create duplicate',async()=>{
    const b=bridge({asnFailure:true});assert.equal((await b.call(unified)).success,false);assert.equal(b.postCount,0);assert.equal(b.records.size,0);
  });
  await test('fleet changed after review cannot POST',async()=>{
    const b=bridge({savedChanged:true});assert.equal((await b.call(unified)).success,false);assert.equal(b.postCount,0);
  });
  await test('concurrent unified printing creates once',async()=>{
    const b=bridge();const r=await Promise.all([b.call(unified),b.call(unified)]);assert.equal(b.postCount,1);assert(r.some(v=>v.result?.state==='verified'));await b.call({...unified,action:'trip-options'});assert.equal(b.postCount,1);
  });
  await test('new portal note discovered at submit is reprinted not recreated',async()=>{
    const b=bridge({existingNotes:[{id:55,code:'ASN-TEST'}]});const r=await b.call(unified);assert.equal(r.existingNotes.length,1);assert.equal(b.postCount,0);
  });

  // --- print intent auto-confirms the PO through the shared durable claim ---
  await test('fresh print confirms the PO before any trip write',async()=>{
    const b=bridge({poStatus:3});const r=await b.call(await payloadFor(3));
    assert.equal(r.result.state,'verified');
    assert.equal(b.portalConfirms,1);assert.equal(b.tripPosts,1);
    assert.deepEqual(b.events,['confirm','trip'],'the portal confirmation must precede the trip write');
    assert.equal(b.intakeRows.size,1);
    const claim=[...b.intakeRows.values()][0];assert.equal(claim.decision,'confirm');assert.equal(claim.state,'imported');assert.equal(b.imports,1);
  });
  await test('lost confirm response reconciles without a second confirmation',async()=>{
    const b=bridge({poStatus:3,intakeOutcome:'timeout'});const r=await b.call(await payloadFor(3));
    assert.equal(r.result.state,'verified');assert.equal(b.portalConfirms,1);assert.equal(b.tripPosts,1);
  });
  await test('already confirmed PO creates without another portal confirmation',async()=>{
    const b=bridge({poStatus:6});const r=await b.call(payload);
    assert.equal(r.result.state,'verified');assert.equal(b.portalConfirms,0);assert.equal(b.intakeRows.size,0);assert.equal(b.tripPosts,1);
    assert.equal(b.catalogReads,0,'an already-confirmed PO must not load the SKU catalog');
  });
  await test('an existing reject claim still blocks an already confirmed PO',async()=>{
    const b=bridge({poStatus:5,preIntake:'reject'});const r=await b.call(await payloadFor(5));
    assert.equal(r.success,false);assert.equal(b.tripPosts,0);assert.equal(b.portalConfirms,0);assert.equal(b.portalRejects,0);
  });
  await test('an already imported intake claim lets the trip continue without a new decision',async()=>{
    const b=bridge({poStatus:5,preIntake:'confirm'});const r=await b.call(await payloadFor(5));
    assert.equal(r.result.state,'verified');assert.equal(b.portalConfirms,0);assert.equal(b.imports,0);assert.equal(b.tripPosts,1);
  });
  await test('confirm timeout blocks the trip and never repeats the confirmation',async()=>{
    const b=bridge({poStatus:3,intakeOutcome:'missing'});const first=await b.call(await payloadFor(3));
    assert.equal(first.success,false);assert.equal(b.portalConfirms,1);assert.equal(b.tripPosts,0);assert.equal(b.records.size,0);assert.equal(b.intakeRows.size,1);
    await b.call(await payloadFor(3));
    assert.equal(b.portalConfirms,1,'a retry must only re-read the claimed decision');assert.equal(b.tripPosts,0);
    b.poSubStatus=5;
    const resumed=await b.call(await payloadFor(5));
    assert.equal(resumed.result.state,'verified');assert.equal(b.portalConfirms,1,'recovery must never re-confirm');assert.equal(b.tripPosts,1);assert.equal(b.imports,1);
  });
  await test('an unverified import keeps the trip locked until it resumes',async()=>{
    const b=bridge({poStatus:3,importFail:true});const first=await b.call(await payloadFor(3));
    assert.equal(first.success,false);assert.equal(b.tripPosts,0);assert.equal(b.portalConfirms,1);
    b.importFail=false;
    const resumed=await b.call(await payloadFor(5));
    assert.equal(resumed.result.state,'verified');assert.equal(b.portalConfirms,1,'must resume the import, never re-confirm');assert.equal(b.tripPosts,1);
  });
  await test('reject claim blocks the trip and is never bypassed',async()=>{
    const b=bridge({poStatus:3});
    const rejected=await b.call({action:'intake-decide',orderId:239751,vendorId:1865,decision:'reject',reason:'No capacity',revision:await b.intake.intakeRevision({...source,po:{...source.po,subStatus:3}}),requestId:uuid(3)});
    assert.equal(rejected.result.state,'rejected');assert.equal(b.portalRejects,1);
    const trip=await b.call(await payloadFor(11));
    assert.equal(trip.success,false);assert.equal(b.tripPosts,0);assert.equal(b.records.size,0);
  });
  await test('a refusal already recorded blocks the reject and the trip write',async()=>{
    const b=bridge({poStatus:3,preTrip:true});
    const rejected=await b.call({action:'intake-decide',orderId:239751,vendorId:1865,decision:'reject',reason:'No capacity',revision:await b.intake.intakeRevision({...source,po:{...source.po,subStatus:3}}),requestId:uuid(3)});
    assert.equal(rejected.result.state,'blocked');assert.equal(b.portalRejects,0);assert.equal(b.intakeRows.size,0);
  });
  await test('result check on an unconfirmed existing trip stays read-only',async()=>{
    const b=bridge({poStatus:3,preTrip:true});
    const r=await b.call({action:'trip-result',orderId:239751,deliveryDate:date});
    assert.equal(r.result.state,'unknown');assert.ok(r.result.intakeRevision);
    assert.equal(b.portalConfirms,0);assert.equal(b.portalRejects,0);assert.equal(b.intakeRows.size,0);assert.equal(b.tripPosts,0);assert.equal(b.records.size,1);
    assert.equal(b.catalogReads,0,'read-only recovery must not load the SKU catalog');
  });
  await test('confirm-po timeout does not repeat the portal confirmation',async()=>{
    const b=bridge({poStatus:3,preTrip:true,intakeOutcome:'missing'});
    const first=await b.call(await payloadFor(3));
    const confirm={action:'confirm-po',orderId:239751,deliveryDate:date,revision:first.result.intakeRevision,requestId:uuid(11)};
    assert.equal((await b.call(confirm)).result.state,'unknown');assert.equal(b.portalConfirms,1);
    await b.call({...confirm,requestId:uuid(12)});
    assert.equal(b.portalConfirms,1,'a retry must only re-read the claimed decision');assert.equal(b.tripPosts,0);
  });
  await test('existing trip continuation never recreates and only confirms after readback',async()=>{
    const b=bridge({poStatus:3,preTrip:true});
    const first=await b.call(await payloadFor(3));
    assert.equal(first.result.state,'unknown');assert.equal(first.result.poConfirmation.confirmed,false);
    assert.equal(first.result.loadId,44);assert.equal(first.result.loadCode,'IL-TEST');assert.ok(first.result.intakeRevision);
    assert.equal(b.tripPosts,0,'opening the form must not create a new trip');assert.equal(b.records.size,1);
    const confirmed=await b.call({action:'confirm-po',orderId:239751,deliveryDate:date,revision:first.result.intakeRevision,requestId:uuid(4)});
    assert.equal(confirmed.result.state,'imported');assert.equal(b.portalConfirms,1);assert.equal(b.tripPosts,0);assert.equal(b.records.size,1);
    const readback=await b.call({action:'trip-result',orderId:239751,deliveryDate:date});
    assert.equal(readback.result.state,'verified');assert.equal(b.tripPosts,0,'confirmation must never recreate the trip');assert.equal(b.records.size,1);
  });
  await test('confirm-po refuses without a matching trip or a fresh revision',async()=>{
    const missing=bridge({poStatus:3});
    assert.equal((await missing.call({action:'confirm-po',orderId:239751,deliveryDate:date,revision:'a'.repeat(64),requestId:uuid(5)})).error,'no_trip');
    assert.equal(missing.portalConfirms,0);
    const stale=bridge({poStatus:3,preTrip:true});
    assert.equal((await stale.call({action:'confirm-po',orderId:239751,deliveryDate:date,revision:'b'.repeat(64),requestId:uuid(5)})).result.state,'changed');
    assert.equal(stale.portalConfirms,0);assert.equal(stale.tripPosts,0);
  });
  await test('confirm-po requires the journal date and a valid revision',async()=>{
    const b=bridge({poStatus:3,preTrip:true});
    assert.equal((await b.call({action:'confirm-po',orderId:239751,deliveryDate:'1999-01-01',revision:'a'.repeat(64),requestId:uuid(5)})).error,'trip_changed');
    assert.equal((await b.call({action:'confirm-po',orderId:239751,revision:'a'.repeat(64),requestId:uuid(5)})).error,'bad_date');
    assert.equal((await b.call({action:'confirm-po',orderId:239751,deliveryDate:date,revision:'nope',requestId:uuid(5)})).error,'bad_revision');
    assert.equal(b.portalConfirms,0);
  });
  await test('confirm-po refuses a cancelled PO or pending edit requests',async()=>{
    const cancelled=bridge({poStatus:3,preTrip:true});
    const cancelRevision=(await cancelled.call(await payloadFor(3))).result.intakeRevision;
    cancelled.poSubStatus=11;
    const hidden=await cancelled.call({action:'confirm-po',orderId:239751,deliveryDate:date,revision:cancelRevision,requestId:uuid(5)});
    assert.equal(hidden.result.state,'blocked');assert.equal(cancelled.portalConfirms,0);assert.equal(cancelled.tripPosts,0);
    const pending=bridge({poStatus:3,preTrip:true,pendingChanged:true});
    const held=(await pending.call(await payloadFor(3))).result.intakeRevision;
    const blocked=await pending.call({action:'confirm-po',orderId:239751,deliveryDate:date,revision:held,requestId:uuid(6)});
    assert.equal(blocked.result.state,'blocked');assert.equal(pending.portalConfirms,0);assert.equal(pending.tripPosts,0);
  });
  await test('simultaneous reject and print cannot both win',async()=>{
    const b=bridge({poStatus:3});
    const rejectPayload={action:'intake-decide',orderId:239751,vendorId:1865,decision:'reject',reason:'No capacity',revision:await b.intake.intakeRevision({...source,po:{...source.po,subStatus:3}}),requestId:uuid(7)};
    const [,printResponse]=await Promise.all([b.call(rejectPayload),b.call(await payloadFor(3))]);
    assert.equal(b.intakeRows.size,1,'exactly one durable claim may exist');
    assert.equal(b.portalConfirms+b.portalRejects,1,'only one partner decision may be sent');
    assert.ok(!(b.portalRejects>0&&b.tripPosts>0),'a rejected PO must not get a trip');
    assert.ok(b.tripPosts<=1);
    if(b.portalRejects===1)assert.equal(printResponse.success,false);
  });
  await test('concurrent fresh prints on a pending PO confirm once and create once',async()=>{
    const b=bridge({poStatus:3});
    const responses=await Promise.all([b.call(await payloadFor(3)),b.call(await payloadFor(3))]);
    assert.equal(b.portalConfirms,1,'the shared claim must send one portal confirmation');
    assert.equal(b.tripPosts,1);assert.equal(b.records.size,1);
    assert(responses.some(r=>r.result?.state==='verified'));
  });
  await test('raw-material catalog is excluded at the query and blocks the trip',async()=>{
    const b=bridge({poStatus:3,rawCatalog:true});const r=await b.call(await payloadFor(3));
    assert.equal(r.success,false);assert.equal(b.portalConfirms,0);assert.equal(b.tripPosts,0);assert.equal(b.records.size,0);
    assert.equal(b.catalogRowsSeen.filter(row=>row.sku_type==='raw_material').length,0,'raw materials must never leave the database');
  });
  await test('PDF retrieval never reads the SKU catalog or creates a trip',async()=>{
    const b=bridge();
    const po=await b.call({action:'po-pdf',orderId:239751,poId:239751,code:'PO1002646817',layout:'NO_PRICE'});
    assert.equal(po.success,true);assert.equal(po.contentType,'application/pdf');assert.ok(po.base64);
    const asn=await b.call({action:'asn-pdf',orderId:239751,poId:239751,asnId:55,code:'ASN-TEST'});
    assert.equal(asn.success,true);assert.equal(asn.contentType,'application/pdf');assert.ok(asn.base64);
    const trip=await b.call({action:'load-pdf',loadId:44,code:'IL-TEST',layout:'NO_PRICE'});
    assert.equal(trip.success,true);assert.equal(trip.contentType,'application/pdf');assert.equal(trip.base64,btoa('%PDF'));
    assert.equal(b.portalConfirms,0);assert.equal(b.portalRejects,0);assert.equal(b.imports,0);
    assert.equal(b.catalogReads,0);assert.equal(b.tripPosts,0);assert.equal(b.records.size,0);
  });
  console.log(`PASS ${passed} behavioral tests; no real KFM request`);
})().catch(e=>{console.error(e);process.exitCode=1;});
