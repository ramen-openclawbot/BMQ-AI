import {test} from 'node:test';
import assert from 'node:assert/strict';
import {customerRequest,customerAnswer} from './customer.ts';
import {runWarehouse} from './warehouse.ts';
const q={kind:'prices',customer:'KH1',product:'',time_range:'today',limit:20};
const base={kind:'prices',status:'ok',rows:[{sku_code:'BMQ-001',product_name:'Bread',unit:'piece',price:'6500.25',currency:'VND'}],customer:{customer_name:'Mai',customer_code:'KH1'},source:'Supabase.mini_crm_customer_price_list',source_observed_at:'2026-09-09T00:00:00Z',snapshot_id:'r1',semantic_version:'bmq-customer-v1',truncated:false};
test('closed scope and no historical prices',()=>{
 for(const extra of [{customer:''},{tenant:'x'},{limit:21},{time_range:'yesterday'},{kind:'orders',product:'sku'},{customer:'a\nb'}])assert.throws(()=>customerRequest({...q,...extra}));
 assert.equal(customerRequest(q).customer,'KH1');
});
test('literal factual bilingual answers do not infer checkout or default prices',()=>{
 const vi=customerAnswer(base,'prices','vi');assert.match(vi,/6500.25/);assert.match(vi,/không phải báo giá/);
 const en=customerAnswer({...base,rows:[]},'prices','en');assert.match(en,/no default price substituted/);
 assert.match(customerAnswer({...base,status:'choose_customer',rows:[],candidates:[base.customer]},'prices','en'),/confirm a customer name or code/);
 assert.throws(()=>customerAnswer({...base,rows:[{...base.rows[0],price:'NaN'}]},'prices','en'));
});
test('router preserves customer and performs only typed customer call, no model explanation',async()=>{
 let calls=0;
 const r=await runWarehouse({question:'Price list KH1',language:'en',page:{route:'/',label:'Home'},history:[]},async(path,body)=>{
  if(path==='/v1/semantic')return {metrics:{revenue:{}},dimensions:{},customer_lookup:'prices orders'};
  assert.equal(path,'/v1/customer');assert.deepEqual(body,q);calls++;return base;
 },async()=>({value:{lane:'customer',queries:[],search:'',clarification:'',customer_lookup:q},usage:{input:1,output:1,cached:0}}),new AbortController().signal);
 assert.equal(calls,1);assert.equal(r.provenance.modelCalls,1);assert.match(r.answer,/6500.25/);assert.equal(r.provenance.lane,'customer');
});
test('bad customer plan never reaches source',async()=>{
 await assert.rejects(()=>runWarehouse({question:'Price list',language:'vi',page:{route:'/'},history:[]},async(path)=>{assert.equal(path,'/v1/semantic');return {metrics:{revenue:{}},dimensions:{},customer_lookup:'prices'};},async()=>({value:{lane:'customer',queries:[],search:'',clarification:'',customer_lookup:{...q,tenant:'fake'}},usage:{input:1,output:1,cached:0}}),new AbortController().signal));
});
test('NPP period amount is labelled separately from collected outstanding balance',()=>{
 const r={...base,kind:'npp_receivable',definition:'npp_debt_screen_period_v1',period:{start:'2026-08-01',end:'2026-08-31'},rows:[],totals:{gross:'1200.50',management_fee:'150.25',period_payable:'1050.25',currency:'VND'}};
 assert.equal(customerRequest({...q,kind:'npp_receivable',time_range:'previous_month'}).kind,'npp_receivable');
 assert.throws(()=>customerRequest({...q,kind:'npp_receivable',product:'SKU'}));
 assert.match(customerAnswer(r,'npp_receivable','en'),/1050.25/);
 assert.match(customerAnswer(r,'npp_receivable','en'),/NOT a settled outstanding balance/);
 assert.match(customerAnswer(r,'npp_receivable','vi'),/Chưa cộng số dư đầu kỳ/);
 assert.throws(()=>customerAnswer({...r,totals:{...r.totals,period_payable:'NaN'}},'npp_receivable','en'));
 assert.match(customerAnswer({...r,status:'not_npp'},'npp_receivable','en'),/not a distributor/);
});

test('customers without a code use stable identity, not a null-code rendering failure',()=>{
 const r={...base,customer:{id:'npp-id',customer_name:'Distributor',customer_code:null}};
 assert.match(customerAnswer(r,'prices','en'),/npp-id/);
});

import {customerContinuation,customerSelection} from './customer.ts';
const nppRequest={kind:'npp_receivable',customer:'Anh Thanh',product:'',time_range:'2026-09-01/2026-09-07',limit:20};
const choice={...base,kind:'npp_receivable',status:'choose_customer',rows:[],period:{start:'2026-09-01',end:'2026-09-07'},candidates:[{id:'npp-thanh',customer_name:'Đại lý cấp 1 - Anh Thanh',customer_code:null}]};
test('two-turn NPP confirmation retains Sep 1-7 and re-queries selected identity without planner',async()=>{
 const input={question:'Công nợ Anh Thanh 1–7/9',language:'vi',page:{route:'/',label:'Home'},history:[]};
 const first=await runWarehouse(input,async path=>path==='/v1/semantic'?{metrics:{revenue:{}},customer_lookup:true}:choice,async()=>({value:{lane:'customer',queries:[],search:'',clarification:'',customer_lookup:nppRequest},usage:{input:1,output:1,cached:0}}),new AbortController().signal);
 assert.match(first.answer,/Đại lý cấp 1 - Anh Thanh/);
 const history=[{role:'user',text:input.question},{role:'assistant',text:first.answer,customerSelection:first.provenance.customerSelection}];
 const calls:any[]=[];
 const second=await runWarehouse({...input,question:'Đúng là Đại lý cấp 1 – Anh Thanh',history},async(path,body)=>{
  if(path==='/v1/semantic')return {metrics:{revenue:{}},customer_lookup:true};
  calls.push(body);return {...choice,status:'not_npp'};
 },async()=>{throw Error('Confirmation must not be reinterpreted by LLM');},new AbortController().signal);
 assert.deepEqual(calls,[{...nppRequest,customer:'npp-thanh',time_range:{start:'2026-09-01',end:'2026-09-07'}}]);
 assert.equal(second.provenance.modelCalls,0);
 assert.match(second.answer,/không phải NPP/); // live data is authoritative, not history
 assert.equal(second.provenance.customerSelection,undefined);
});
test('ambiguous, expired, altered scope and malformed hints do not auto-select',()=>{
 const state=customerSelection(choice,nppRequest);
 const history=[{role:'assistant',text:'choose',customerSelection:state}];
 assert.equal(customerContinuation('Anh Thanh',history),null);
 assert.equal(customerContinuation('Đại lý cấp 1 - Anh Thanh tháng 8',history),null);
 assert.equal(customerContinuation('yes',history),null);
 assert.equal(customerContinuation('Đại lý cấp 1 - Anh Thanh',[...history,{role:'assistant',text:'new topic'}]),null);
 assert.equal(customerContinuation('Đại lý cấp 1 - Anh Thanh',[{...history[0],customerSelection:{...state,candidates:[...state.candidates,...state.candidates]}}]),null);
 assert.equal(customerContinuation('Đại lý cấp 1 - Anh Thanh',[{...history[0],customerSelection:{...state,request:{...state.request,tenant:'other'}}}]),null);
 assert.equal(customerContinuation('Đại lý cấp 1 - Anh Thanh',[{...history[0],role:'user'}]),null);
});
test('relative request stores concrete source period, price context keeps product and limit',()=>{
 const state=customerSelection(choice,{...nppRequest,time_range:'this_week'});
 assert.equal(state.request.time_range,'2026-09-01/2026-09-07');
 const prices=customerSelection({...choice,kind:'prices'},{...q,product:'BMQ-001',limit:3});
 assert.deepEqual(customerContinuation('npp-thanh',[{role:'assistant',text:'choose',customerSelection:prices}]),{...q,customer:'npp-thanh',product:'BMQ-001',limit:3});
});
