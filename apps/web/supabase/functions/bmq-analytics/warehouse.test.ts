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
