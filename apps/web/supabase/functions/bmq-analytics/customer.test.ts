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
 assert.match(customerAnswer({...base,status:'choose_customer',rows:[],candidates:[base.customer]},'prices','en'),/exact customer code/);
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
