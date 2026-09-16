import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mediaPeriod,runUnc} from './media.ts';
import {runWarehouse} from './warehouse.ts';
import {warehouseImage} from '../_shared/warehouse.ts';
import {createHandler} from './handler.ts';
const id='a'.repeat(64),signal=new AbortController().signal,usage={input:1,output:1,cached:0};
const input={question:'Gửi ảnh UNC đã thanh toán ngày 14/9/2026',language:'vi' as const,page:{route:'/',label:'Home',filters:{}},history:[]};
const planner=async()=>({value:{date:'2026-09-14',month:'',clarification:''},usage});
const img={id,declaration_id:'d1',date:'2026-09-14',kind:'UNC',mime_type:'image/png',payment_status:'submitted_unverified'};
test('real calendar and bounded period validation; never default absent dates',()=>{
 assert.equal(mediaPeriod({date:'',month:'',clarification:''}),null);
 for(const p of [{date:'2026-02-30',month:'',clarification:''},{date:'2026-09-14',month:'2026-09',clarification:''},{date:'',month:'2026-13',clarification:''},{date:'2026-09-14',month:'',clarification:'',tenant:'x'}])assert.throws(()=>mediaPeriod(p));
 assert.deepEqual(mediaPeriod({date:'',month:'2026-09',clarification:''}),{month:'2026-09'});
});
test('UNC request bypasses metrics catalog; photos never imply paid',async()=>{
 const r=await runWarehouse(input,async(path,body)=>{assert.equal(path,'/v1/finance-media/search');assert.deepEqual(body,{date:'2026-09-14',limit:8});return {images:[img],total:1,truncated:false}},planner,signal);
 assert.match(r.answer,/chưa xác nhận thanh toán/);assert.equal(r.provenance.images[0].id,id);assert.equal(r.provenance.modelCalls,1);assert.ok(!JSON.stringify(r).includes('path'));
});
test('month selects source day and missing images do not imply no payment',async()=>{
 const m=async()=>({value:{date:'',month:'2026-09',clarification:''},usage});
 const r=await runUnc({...input,language:'en'},async()=>({images:[img],total:12,truncated:true}),m,signal);
 assert.match(r.answer,/14\/09\/2026/);assert.match(r.answer,/1\/12/);
 const empty=await runUnc(input,async()=>({images:[],total:0,truncated:false}),planner,signal);assert.match(empty.answer,/Không đồng nghĩa/);
});
test('wrong source period, fabricated paid status and excessive results rejected',async()=>{
 for(const images of [[{...img,date:'2026-09-13'}],[{...img,payment_status:'paid'}],Array(9).fill(img)])await assert.rejects(()=>runUnc(input,async()=>({images,total:images.length,truncated:false}),planner,signal));
});
test('missing scope clarifies without touching images',async()=>{
 const r=await runUnc(input,async()=>{throw Error('must not fetch')},async()=>({value:{date:'',month:'',clarification:'which date?'},usage}),signal);assert.match(r.answer,/DD\/MM\/YYYY/);
});
test('binary relay fixed origin, owner bearer forwarding, no redirects, type/size limits',async()=>{
 let calls=0;
 const fetcher=async(url,init)=>{calls++;assert.equal(String(url),`https://warehouse.test/v1/finance-media/${id}`);assert.equal(init.headers.Authorization,'Bearer fixture');assert.equal(init.redirect,'error');return new Response(new Uint8Array([137,80,78,71]),{headers:{'content-type':'image/png'}})};
 const r=await warehouseImage('https://warehouse.test','Bearer fixture',id,signal,fetcher);assert.equal(r.headers.get('cache-control'),'private, no-store');assert.equal((await r.arrayBuffer()).byteLength,4);
 await assert.rejects(()=>warehouseImage('https://warehouse.test','Bearer fixture','../secret',signal,fetcher));assert.equal(calls,1);
 for(const type of ['text/html','image/svg+xml'])await assert.rejects(()=>warehouseImage('https://warehouse.test','Bearer fixture',id,signal,async()=>new Response('x',{headers:{'content-type':type}})));
 await assert.rejects(()=>warehouseImage('https://warehouse.test','Bearer fixture',id,signal,async()=>new Response(new Uint8Array(24*1024*1024+1),{headers:{'content-type':'image/png'}})));
});
test('image action authenticates, keeps CORS and does not invoke model',async()=>{
 const base={enabled:()=>true,warehouse:{enabled:()=>true,url:()=> 'https://warehouse.test'},model:async()=>{throw Error('no model')},audit:()=>{}};
 const request=()=>new Request('https://edge.test',{method:'POST',headers:{'content-type':'application/json',origin:'https://ai.banhmique.vn'},body:JSON.stringify({action:'unc_image',id})});
 const deny=createHandler({...base,authenticate:async()=>{throw Error('no owner')}});assert.equal((await deny(request())).status,503);
 const old=globalThis.fetch;try{
 globalThis.fetch=async()=>new Response(new Uint8Array([1,2]),{headers:{'Content-Type':'image/png'}});
 const handler=createHandler({...base,authenticate:async()=>({scope:{tenant:'t',user:'u',permission:'owner'},query:async()=>{throw Error('no query')}})});
 const r=await handler(request());assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'application/octet-stream');assert.equal(r.headers.get('access-control-allow-origin'),'https://ai.banhmique.vn');assert.equal((await r.arrayBuffer()).byteLength,2);
 }finally{globalThis.fetch=old}
});

const catalog={metrics:{revenue:{label:'Revenue'}},dimensions:{date:{}}};
const imageRoute={lane:'unc_images',queries:[],search:'',clarification:''};
const priorRequest=[{role:'user' as const,text:'Show me bank slip images'}, {role:'assistant' as const,text:'Sorry, images are not supported.'}];
for(const question of ['Show bank slip images for 11 September 2026','Cho ảnh chuyển khoản ngày 11/9/2026','11 September 2026','còn ngày 12?']) {
 test(`LLM image route supports wording/context: ${question}`,async()=>{
  const history=question.startsWith('Show')||question.startsWith('Cho')?[]:priorRequest;
  const date=question.includes('12')?'2026-09-12':'2026-09-11';
  let rounds=0;const paths:string[]=[];
  const result=await runWarehouse({...input,question,history},async(path,body)=>{
   paths.push(path);if(path==='/v1/semantic')return catalog;
   assert.equal(path,'/v1/finance-media/search');assert.deepEqual(body,{date,limit:8});
   return {images:[{...img,date}],total:1,truncated:false};
  },async(instructions,payload:any,schema:any)=>{
   rounds++;assert.equal(payload.question,question);assert.deepEqual(payload.history,history);
   if(rounds===1){assert.ok(schema.properties.lane.enum.includes('unc_images'));assert.match(instructions,/bank slip/);assert.match(instructions,/latest explicit topic wins/);return {value:imageRoute,usage};}
   assert.match(instructions,/Retain all still-active constraints/);return {value:{date,month:'',clarification:''},usage};
  },signal);
  assert.deepEqual(paths,['/v1/semantic','/v1/finance-media/search']);assert.equal(rounds,2);
  assert.equal(result.provenance.lane,'unc_images');assert.equal(result.provenance.modelCalls,2);
  assert.deepEqual(result.provenance.usage,{input:2,output:2,cached:0});assert.equal(result.provenance.images[0].date,date);
 });
}
test('UNC follow-up uses semantic router instead of keyword bypass',async()=>{
 let rounds=0;
 const result=await runWarehouse({...input,question:'UNC là gì?',history:priorRequest},async(path)=>{
  assert.equal(path,'/v1/semantic');return catalog;
 },async()=>{rounds++;return {value:{lane:'abstain',queries:[],search:'',clarification:'Please clarify the definition needed.'},usage}},signal);
 assert.equal(rounds,1);assert.equal(result.provenance.lane,'abstain');
});
test('topic switch to revenue does not inherit old UNC intent',async()=>{
 const result=await runWarehouse({...input,question:'Revenue for 11 September 2026',history:priorRequest},async(path)=>{
  if(path==='/v1/semantic')return catalog;
  assert.equal(path,'/v1/query');return {rows:[{revenue:12,currency:'VND'}]};
 },async()=>({value:{lane:'semantic',queries:[{metric:'revenue',time_range:'2026-09-11/2026-09-11',dimensions:[],limit:20}],search:'',clarification:''},usage}),signal);
 assert.equal(result.provenance.lane,'semantic');assert.match(result.answer,/12/);
});
test('bare date without established intent can clarify without media access',async()=>{
 const result=await runWarehouse({...input,question:'11 September 2026'},async(path)=>{
  assert.equal(path,'/v1/semantic');return catalog;
 },async()=>({value:{lane:'abstain',queries:[],search:'',clarification:'Which report or images do you need?'},usage}),signal);
 assert.equal(result.provenance.lane,'abstain');
});
test('inherited unsupported filters or missing date do not query media',async()=>{
 for(const history of [priorRequest,[{role:'user' as const,text:'Show bank slips for recipient Alice'}, {role:'assistant' as const,text:'Which date?'}]]){
  let rounds=0;
  const result=await runWarehouse({...input,question:'11 September',history},async(path)=>{
   assert.equal(path,'/v1/semantic');return catalog;
  },async(_instructions,payload:any)=>{assert.deepEqual(payload.history,history);return {value:++rounds===1?imageRoute:{date:'',month:'',clarification:'Please specify a supported date-only request.'},usage}},signal);
  assert.equal(result.provenance.images.length,0);assert.equal(rounds,2);
 }
});
test('malformed image route and invalid date fail closed before image fetch',async()=>{
 for(const plan of [{...imageRoute,queries:[{}]},{...imageRoute,search:'https://evil.test'},imageRoute]){
  let rounds=0;
  await assert.rejects(()=>runWarehouse({...input,question:'Show bank slips'},async(path)=>{
   assert.equal(path,'/v1/semantic');return catalog;
  },async()=>({value:++rounds===1?plan:{date:'2026-02-30',month:'',clarification:''},usage}),signal),/invalid_(plan|media_plan)/);
 }
});
test('second model failure is not rendered as no images or unsupported capability',async()=>{
 let rounds=0;
 await assert.rejects(()=>runWarehouse({...input,question:'Show bank slips'},async(path)=>{
  assert.equal(path,'/v1/semantic');return catalog;
 },async()=>{if(++rounds===2)throw Error('model_unavailable');return {value:imageRoute,usage}},signal),/model_unavailable/);
});
