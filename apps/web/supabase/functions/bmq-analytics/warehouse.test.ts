import { test } from 'node:test';
import assert from 'node:assert/strict';
import { warehouseClient } from '../_shared/warehouse.ts';
import { sourceOperation, createSourcesHandler } from '../bmq-data-sources/handler.ts';
import { runWarehouse } from './warehouse.ts';
const signal = new AbortController().signal;
const input = {question:'What is BMQ AI?',language:'en',page:{route:'/',label:'Home'},history:[]};
const catalog = {metrics:{revenue:{label:'Revenue'}},dimensions:{date:{},location:{}},version:'1.0'};
const usage={input:1,output:1,cached:0};
test('fixed HTTPS upstream rejects credentials/path/HTTP; redirects never followed; bearer forwarded',async()=>{
 for(const url of ['http://localhost:9000','https://host.test/a','https://name:pw@host.test','https://host.test/?q=1']) assert.throws(()=>warehouseClient(url,'Bearer fake',signal));
 const call=warehouseClient('https://warehouse.test','Bearer fake',signal,async(url,init)=>{assert.equal(String(url),'https://warehouse.test/v1/status');assert.equal(init?.redirect,'error');assert.equal((init?.headers as any).Authorization,'Bearer fake');return new Response('{}');});
 await call('/v1/status');await assert.rejects(()=>call('https://evil.test'));
});
test('source operations prevent tenant, URL, traversal and unwanted files',()=>{
 for(const raw of [{action:'sources',tenant:'other'},{action:'sources',url:'https://x'},{action:'document',source:'bmq',title:'T',filename:'../a.md',content:'x'},{action:'document',source:'bmq',title:'T',filename:'a.html',content:'x'}]) assert.throws(()=>sourceOperation(raw));
 assert.deepEqual(sourceOperation({action:'document',language:'en',source:'bmq',title:'T',filename:'guide.md',content:'hello'}),{path:'/v1/documents',body:{source:'bmq',title:'T',filename:'guide.md',content:'hello'}});
});
test('disabled sources authenticate first and do not call upstream',async()=>{
 let auth=0; const handler=createSourcesHandler({enabled:()=>false,url:()=>'',authenticate:async()=>{auth++;return 'Bearer fake';},fetcher:async()=>{throw Error('unexpected')}});
 const res=await handler(new Request('https://test',{method:'POST',headers:{'Content-Type':'application/json','Accept-Language':'en'},body:'{"action":"status"}'})); assert.equal(auth,1);assert.equal(res.status,503);assert.equal((await res.json()).code,'warehouse_disabled');
});
test('knowledge no source abstains, citations cannot invent source',async()=>{
 const planner=async()=>({value:{lane:'knowledge',queries:[],search:'BMQ',clarification:''},usage});
 const no=await runWarehouse(input,async(path)=>path==='/v1/semantic'?catalog:{chunks:[]},planner,signal);assert.match(no.answer,/No relevant source/);assert.equal(no.provenance.modelCalls,1);
 let round=0; await assert.rejects(()=>runWarehouse(input,async(path)=>path==='/v1/semantic'?catalog:{chunks:[{id:'c1',title:'Guide',text:'BMQ guidance',source:'manual',updated_at:'2026-09-09'}]},async()=>({value:++round===1?{lane:'knowledge',queries:[],search:'BMQ',clarification:''}:{answer:'Made up',citations:['fake']},usage}),signal),/invalid_citations/);
});
test('knowledge grounded response retains citations and uses Luna at most twice',async()=>{
 let round=0; const result=await runWarehouse(input,async(path)=>path==='/v1/semantic'?catalog:{chunks:[{id:'c1',title:'Guide',text:'BMQ guidance',source:'manual',updated_at:'2026-09-09'}]},async(instructions)=>{assert.match(instructions,/English/);return {value:++round===1?{lane:'knowledge',queries:[],search:'BMQ',clarification:''}:{answer:'BMQ guidance [c1]',citations:['c1']},usage}},signal);
 assert.equal(result.provenance.model,'gpt-5.6-luna');assert.equal(round,2);assert.equal(result.provenance.citations.length,1);
});
test('fast warehouse query bypasses LLM and qualifiers cannot silently become whole-business facts',async()=>{
 let queries=0;const result=await runWarehouse({...input,question:'revenue today'},async(path,body)=>{if(path==='/v1/semantic')return catalog;queries++;assert.equal((body as any).metric,'revenue');return {rows:[{revenue:'12',currency:'VND'}]};},async()=>{throw Error('no model');},signal);assert.equal(queries,1);assert.equal(result.provenance.lane,'fast');
 const scoped=await runWarehouse({...input,page:{...input.page,filters:{store:'one'}}},async()=>{throw Error('no query')},async()=>{throw Error('no model')},signal);assert.equal(scoped.provenance.lane,'abstain');
});
test('forged SQL model plan rejected before executing',async()=>{
 await assert.rejects(()=>runWarehouse(input,async(path)=>{assert.equal(path,'/v1/semantic');return catalog;},async()=>({value:{lane:'semantic',queries:[{metric:'revenue',time_range:'today',dimensions:[],limit:20,sql:'select 1'}],search:'',clarification:''},usage}),signal),/invalid_query/);
});
test('upstream error/oversize never become empty business result',async()=>{
 const down=warehouseClient('https://warehouse.test','Bearer fake',signal,async()=>new Response('internal detail',{status:500}));
 await assert.rejects(()=>down('/v1/query',{}),/warehouse_unavailable/);
 const large=warehouseClient('https://warehouse.test','Bearer fake',signal,async()=>new Response('x'.repeat(128001)));
 await assert.rejects(()=>large('/v1/status'),/warehouse_result_limit/);
 await assert.rejects(()=>runWarehouse({...input,question:'revenue today'},down,async()=>{throw Error('no model');},signal),/warehouse_unavailable/);
});
test('upload request body abort stops a stalled stream',async()=>{
 const {boundedJson}=await import('../_shared/warehouse.ts');
 const controller=new AbortController();
 const request=new Request('https://test',{method:'POST',headers:{'Content-Type':'application/json'},body:new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('{'));}}),duplex:'half'} as RequestInit);
 const pending=boundedJson(request,200,controller.signal); controller.abort();await assert.rejects(()=>pending);
});
test('empty query results explicitly differ from zero',async()=>{
 const result=await runWarehouse({...input,question:'revenue today'},async(path)=>path==='/v1/semantic'?catalog:{rows:[],period:{start:'2026-09-09',end:'2026-09-09'}},async()=>{throw Error('no model')},signal);
 assert.match(result.answer,/does not mean zero/);
});
test('dimensionless counts and percentages are not formatted as money',async()=>{
 for (const metric of ['gross_margin','order_count']) {
  const result=await runWarehouse(input,async(path)=>path==='/v1/semantic'?{...catalog,metrics:{[metric]:{label:metric}}}:{rows:[{[metric]:'30',currency:'VND'}]},async()=>({value:{lane:'semantic',queries:[{metric,time_range:'today',dimensions:[],limit:20}],search:'',clarification:''},usage}),signal);
  assert.doesNotMatch(result.answer,/30 VND/);
  assert.match(result.answer,metric==='gross_margin'?/30 % \(VND\)/:/30 \(VND\)/);
 }
});
test('canonical chunk IDs stay in provenance, readable citation numbers in answer',async()=>{
 const id='a'.repeat(64)+':3';let round=0;
 const result=await runWarehouse(input,async(path)=>path==='/v1/semantic'?catalog:{chunks:[{id,title:'BMQ manual',text:'Inventory guide',source:'manual',updated_at:'2026-09-09'}]},async()=>({value:++round===1?{lane:'knowledge',queries:[],search:'BMQ',clarification:''}:{answer:`BMQ manages inventory [${id}].`,citations:[id]},usage}),signal);
 assert.match(result.answer,/inventory \[1\]/);assert.doesNotMatch(result.answer,/Sources:/);assert.ok(!result.answer.includes(id));assert.equal((result.provenance.citations[0] as any).id,id);
});
test('unknown aggregate from missing cost is unavailable, never zero or invalid result',async()=>{
 for(const language of ['en','vi']) for(const value of [null,undefined]) {
  const result=await runWarehouse({...input,language},async(path)=>path==='/v1/semantic'?{...catalog,metrics:{gross_profit:{label:'Gross profit'}}}:{rows:[{gross_profit:value,currency:'VND'}]},async()=>({value:{lane:'semantic',queries:[{metric:'gross_profit',time_range:'today',dimensions:[],limit:20}],search:'',clarification:''},usage}),signal);
  assert.match(result.answer,language==='en'?/Not available/:/Chưa có dữ liệu/);assert.doesNotMatch(result.answer,/0 VND/);
 }
});

test('existing revenue fast path retains live contract even when warehouse offline',async()=>{
 let reads=0;
 const result=await runWarehouse({...input,question:'revenue today'},async()=>{throw Error('offline')},async()=>{throw Error('no model')},signal,async(q)=>{reads++;assert.equal(q.metric,'controlled_revenue');return {rows:[{dimension:'Total',value:123}],source:'live-controlled',asOf:'now',note:'controlled',noteEn:'not net revenue'};});
 assert.equal(reads,1);assert.match(result.answer,/not net revenue/);assert.equal(result.provenance.modelCalls,0);
});
test('operational count uses warehouse and visible watermark, not currency unit',async()=>{
 const c={version:'bmq-operational-v1',metrics:{dealer_order_count:{label:'Dealer orders',label_vi:'Số đơn đại lý',unit:'count'}},dimensions:{date:'date'}};
 const result=await runWarehouse({...input,question:'dealer order count today'},async(path)=>path==='/v1/semantic'?c:{rows:[{dealer_order_count:8,currency:'VND'}],source:'Supabase.dealer_orders',source_observed_at:'2026-09-09T05:42:00Z',snapshot_id:'s1',definition:'not revenue'},async()=>{throw Error('no model')},signal);
 assert.match(result.answer,/8 records/);assert.match(result.answer,/05:42/);assert.match(result.answer,/not revenue/);assert.equal(result.provenance.evidence.length,1);
});
test('legacy semantic query keeps validation including snapshot historical rejection',async()=>{
 const plan={lane:'semantic',queries:[{metric:'supplier_debt',time_range:'yesterday',dimensions:[],limit:20}],search:'',clarification:''};
 await assert.rejects(()=>runWarehouse(input,async()=>structuredClone(catalog),async()=>({value:plan,usage}),signal,async()=>{throw Error('should not read')}),/snapshot_only/);
});
test('mixed analysis preserves separate data sources within two model calls',async()=>{
 let round=0, live=0;
 const result=await runWarehouse(input,async(path)=>path==='/v1/semantic'?{metrics:{dealer_order_count:{label:'Dealer count',unit:'count'}},dimensions:{date:'date'}}:{rows:[{dealer_order_count:2,currency:'VND'}],source:'Supabase.dealer_orders',source_observed_at:'2026-09-09T05:42:00Z',snapshot_id:'s1',definition:'not revenue'},async()=>({value:++round===1?{lane:'agentic',queries:[{metric:'dealer_order_count',time_range:'today',dimensions:[],limit:20},{metric:'purchase_order_count',time_range:'today',dimensions:[],limit:20}],search:'',clarification:''}:{answer:'Two separate measures [1] [2].'},usage}),signal,async()=>{live++;return {rows:[{dimension:'Total',value:1}],source:'purchase_orders',asOf:'now',note:'PO',noteEn:'purchase orders, not sales'};});
 assert.equal(round,2);assert.equal(live,1);assert.equal(result.provenance.evidence.length,2);assert.match(result.answer,/purchase orders, not sales/);
});

test('owner readiness probe works with normal warehouse lane disabled and never calls model',async(t)=>{
 const {createHandler}=await import('./handler.ts');
 let reads=0;
 t.mock.method(globalThis,'fetch',async(url:any,options:any)=>{
  reads++;assert.equal(options.headers.Authorization,'Bearer fixture-owner');
  return new Response(JSON.stringify(String(url).endsWith('/v1/semantic')?{metrics:{dealer_order_count:{label:'Dealer count',unit:'count'}},dimensions:{date:'date'}}:{rows:[{dealer_order_count:1,currency:'VND'}],source:'Supabase.dealer_orders',source_observed_at:'2026-09-09T05:42:00Z',definition:'not revenue',snapshot_id:'test'}));
 });
 const h=createHandler({enabled:()=>true,warehouse:{enabled:()=>false,url:()=> 'https://warehouse.test'},authenticate:async()=>({scope:{tenant:'bmq',user:'u1',permission:'owner'},query:async()=>{throw Error('not live')}}),model:async()=>{throw Error('no model')},audit:()=>{}});
 const r=await h(new Request('https://test',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer fixture-owner'},body:JSON.stringify({...input,question:'Check warehouse connection'})}));
 assert.equal(r.status,200);assert.match((await r.json()).answer,/verified for your owner session/);assert.equal(reads,2);
});

test('reviewed warehouse finance contract wins over live and fast revenue uses no model',async()=>{
 let queries=0;
 const c={metrics:{controlled_revenue:{label:'Controlled revenue',label_vi:'Doanh thu đã kiểm soát',unit:'VND'}},dimensions:{channel:'channel',date:'date'}};
 const result=await runWarehouse({...input,question:'revenue today'},async(path,body)=>{
  if(path==='/v1/semantic')return c;
  queries++;assert.equal((body as any).metric,'controlled_revenue');
  return {rows:[{controlled_revenue:'80.05',currency:'VND'}],source:'Supabase.revenue_ledger_lines + revenue_source_documents',source_observed_at:'2026-09-09T06:00:00Z',snapshot_id:'new',definition:'Not net or audited revenue'};
 },async()=>{throw Error('no model')},signal,async()=>{throw Error('must not read live')});
 assert.equal(queries,1);assert.equal(result.provenance.modelCalls,0);
 assert.equal((result.provenance.evidence[0] as any).mode,'warehouse');
 assert.match(result.answer,/80.05 VND/);assert.match(result.answer,/Not net/);
});
test('new source dimensions remain visible and do not silently fall back on stale query',async()=>{
 const c={metrics:{supplier_debt:{label:'Payables',unit:'VND'}},dimensions:{payment_method:'Payment method'}};
 const plan={lane:'semantic',queries:[{metric:'supplier_debt',time_range:'today',dimensions:['payment_method'],limit:20}],search:'',clarification:''};
 const planner=async()=>({value:plan,usage});
 const result=await runWarehouse(input,async(path)=>path==='/v1/semantic'?c:{rows:[{payment_method:'bank',supplier_debt:15,currency:'VND'}],source:'payments',source_observed_at:'now',definition:'snapshot'},planner,signal,async()=>{throw Error('must not read live')});
 assert.match(result.answer,/bank: 15 VND/);
 await assert.rejects(runWarehouse(input,async(path)=>{if(path==='/v1/semantic')return c;throw Error('stale snapshot')},planner,signal,async()=>{throw Error('wrong fallback')}),/stale snapshot/);
});

test('legacy fast date ranges survive routing to warehouse without becoming today',async()=>{
 const {fastQuery}=await import('./core.ts');
 for(const question of ['revenue yesterday','revenue this month','doanh thu hôm qua','doanh thu tháng này']) {
  const expected=fastQuery(question)!;let queried=false;
  await runWarehouse({...input,question},async(path,body)=>{
   if(path==='/v1/semantic')return {metrics:{controlled_revenue:{label:'Revenue',unit:'VND'}},dimensions:{date:'date'}};
   queried=true;assert.deepEqual((body as any).time_range,{start:expected.start,end:expected.end});
   return {rows:[{controlled_revenue:1,currency:'VND'}]};
  },async()=>{throw Error('no model')},signal,async()=>{throw Error('no live')});
  assert.ok(queried);
 }
});
