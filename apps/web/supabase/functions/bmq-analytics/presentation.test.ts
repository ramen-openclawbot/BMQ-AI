import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createFxLoader, FX_URL, FX_SOURCE, formatMoney} from './money.ts';
import {presentResponse, legacyPresentation, type Presentation} from './presentation.ts';
import {runWarehouse} from './warehouse.ts';
const signal = new AbortController().signal;
const now = Date.parse('2026-09-09T12:00:00Z');
const rate = {vndPerUsd:25000, updatedAt:new Date(now).toISOString(), source:FX_SOURCE};
const payload = {result:'success',provider:FX_SOURCE,base_code:'USD',time_last_update_unix:now/1000,rates:{VND:25000}};
const loader = async()=>rate;
const metric=(value:unknown, id='controlled_revenue', unit='VND'):Presentation=>({kind:'metric',query:{metric:id,time_range:'today',dimensions:[]},descriptor:{label:'Controlled revenue',label_vi:'Doanh thu kiểm soát',unit},result:{period:{start:'2026-09-08',end:'2026-09-08'},rows:[{[id]:value,currency:'VND'}]}});
const response=(blocks:Presentation[])=>({answer:'Source: revenue_ledger_lines\nExact value: 51225132.00000\n2026-09-09T12:00:00Z',presentation:blocks,provenance:{lane:'semantic',customerSelection:{x:1},evidence:[{source:'raw'}]}});
test('Vietnamese money groups dots and omits decimal zeros, English actually converts',()=>{
 assert.equal(formatMoney('51225132.00000','VND','vi',null),'51.225.132 ₫');
 assert.equal(formatMoney('51225132.00000','VND','en',rate),'$2,049.01');
 assert.equal(formatMoney('-25000','VND','en',rate),'-$1.00');
 assert.equal(formatMoney(0,'VND','en',rate),'$0.00');
 assert.equal(formatMoney(50,'USD','en',rate),'$50.00');
 for(const v of ['',null,'Infinity','bad',NaN,'9007199254740992'])assert.throws(()=>formatMoney(v,'VND','en',rate));
});
test('public FX request is fixed, credential-free, bounded, cached hourly, expires after 48h',async()=>{
 let clock=now,calls=0,fail=false;
 const load=createFxLoader(async(url,init)=>{calls++;assert.equal(url,FX_URL);assert.equal(init?.redirect,'error');assert.equal(init?.credentials,'omit');assert.equal(init?.body,undefined);assert.deepEqual(init?.headers,{Accept:'application/json'});if(fail)throw Error();return Response.json(payload);},()=>clock);
 assert.equal((await load(signal))?.vndPerUsd,25000);await load(signal);assert.equal(calls,1);
 clock+=3600001;fail=true;assert.equal((await load(signal))?.vndPerUsd,25000);
 clock+=48*3600000;assert.equal(await load(signal),null);
});
test('bad FX values, wrong base/provider, expired/future/oversize/non-JSON/HTTP errors rejected',async()=>{
 for(const data of [{...payload,base_code:'VND'},{...payload,provider:'https://bad.test'},{...payload,rates:{VND:-1}},{...payload,rates:{VND:'25000'}},{...payload,time_last_update_unix:(now-49*3600000)/1000},{...payload,time_last_update_unix:(now+3600000)/1000}]){
  assert.equal(await createFxLoader(async()=>Response.json(data),()=>now)(signal),null);
 }
 for(const res of [new Response('x'.repeat(65000)),new Response('oops'),new Response('',{status:503})])assert.equal(await createFxLoader(async()=>res,()=>now)(signal),null);
 const aborted=new AbortController();aborted.abort();await assert.rejects(()=>createFxLoader(async()=>{throw Error();},()=>now)(aborted.signal));
});
test('main answer concise, details retains evidence and original values; no FX on Vietnamese/count/missing',async()=>{
 const no=async()=>{throw Error('must not fetch');};
 const vi=await presentResponse(response([metric('51225132.00000')]),'vi',signal,no);
 assert.equal(vi.answer,'Doanh thu kiểm soát · 08/09/2026\n51.225.132 ₫');assert.doesNotMatch(vi.answer,/revenue_ledger|T12:|00000/);
 assert.match(vi.provenance.details,/revenue_ledger_lines/);assert.equal('presentation' in vi,false);assert.deepEqual(vi.provenance.customerSelection,{x:1});
 const count=await presentResponse(response([metric(1234,'order_count','count')]),'en',signal,no);assert.match(count.answer,/1,234/);assert.doesNotMatch(count.answer,/\$|₫/);
 const missing=await presentResponse(response([metric(null)]),'en',signal,no);assert.match(missing.answer,/Not available/);assert.doesNotMatch(missing.answer,/\$0/);
 const percentage=await presentResponse(response([metric('20.125','gross_margin','percent')]),'en',signal,no);assert.match(percentage.answer,/20.13%/);
});
test('USD uses one rate per response and shows source/date/original in details; unavailable falls back honestly',async()=>{
 let calls=0;const en=await presentResponse(response([metric(50000),metric(25000)]),'en',signal,async()=>{calls++;return rate;});
 assert.equal(calls,1);assert.match(en.answer,/\$2.00/);assert.match(en.answer,/USD estimate/);assert.match(en.provenance.details,/25000 VND/);assert.match(en.provenance.details,/50.000 ₫/);assert.match(en.provenance.details,/exchangerate-api/);
 const fallback=await presentResponse(response([metric(50000)]),'en',signal,async()=>null);assert.match(fallback.answer,/50.000 ₫/);assert.match(fallback.answer,/USD rate unavailable/);assert.doesNotMatch(fallback.answer,/\$/);
});
test('NPP keeps collections caveat, prices/orders show converted money with correct scope/period',async()=>{
 const base={status:'ok',customer:{customer_name:'Agency A'},period:{start:'2026-09-01',end:'2026-09-07'},totals:{period_payable:'50000'},rows:[]};
 const npp=await presentResponse(response([{kind:'customer',lookup:'npp_receivable',result:base}]),'en',signal,loader);
 assert.match(npp.answer,/01\/09\/2026 – 07\/09\/2026/);assert.match(npp.answer,/\$2.00/);assert.match(npp.answer,/collections not included/);assert.doesNotMatch(npp.answer,/revenue_ledger/);
 const prices=await presentResponse(response([{kind:'customer',lookup:'prices',result:{...base,rows:[{sku_code:'SKU1',product_name:'Bánh',price:'25000',currency:'VND',unit:'pack'}]}}]),'en',signal,loader);assert.match(prices.answer,/\$1.00 \/ pack/);assert.match(prices.answer,/not a final quotation/);
 const orders=await presentResponse(response([{kind:'customer',lookup:'orders',result:{...base,rows:[{order_number:'DH1',submitted_at:'2026-09-02T12:00:00Z',amount:'50000',currency:'VND'}]}}]),'vi',signal,loader);assert.match(orders.answer,/DH1 · 02\/09\/2026: 50.000 ₫/);
});
test('legacy fallback structured facts use same presentation, without converting counts',async()=>{
 const q={metric:'supplier_debt',start:'2026-09-09',end:'2026-09-09',dimension:null};
 const result={rows:[{value:50000,dimension:'Total'}]};
 const out=await presentResponse(response([legacyPresentation(q,result)]),'en',signal,loader);assert.match(out.answer,/\$2.00/);
});
test('warehouse execution retains structured values for final renderer without changing queries',async()=>{
 const input={question:'revenue today',language:'en',page:{route:'/',label:'Home',filters:{}},history:[]};
 const result=await runWarehouse(input,async(path)=>path==='/v1/semantic'?{metrics:{revenue:{label:'Revenue'}},dimensions:{}}:{rows:[{revenue:'50000',currency:'VND'}]},async()=>{throw Error('no model');},signal);
 const out=await presentResponse(result,'en',signal,loader);assert.match(out.answer,/\$2.00/);assert.equal('presentation' in out,false);
});

test('authenticated HTTP response exposes concise money and details but no internal structured rows',async()=>{
 const {createHandler}=await import('./handler.ts');
 const handler=createHandler({enabled:()=>true,authenticate:async()=>({scope:{tenant:'bmq',user:'fixture',permission:'owner'},query:async()=>({rows:[{value:51225132,dimension:'Total'}],source:'private_table',asOf:'2026-09-09T00:00:00Z',note:'definition'})}),model:async()=>{throw Error('no model');},audit:()=>{}});
 const res=await handler(new Request('https://test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({language:'vi',question:'doanh thu hôm nay',history:[],page:{route:'/',label:'Home',filters:{}}})}));
 assert.equal(res.status,200);const out=await res.json();assert.match(out.answer,/51.225.132 ₫/);assert.doesNotMatch(out.answer,/private_table/);assert.match(out.provenance.details,/private_table/);assert.equal('presentation' in out,false);
});
