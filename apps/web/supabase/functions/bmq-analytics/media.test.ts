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
