// Called by pytest with captured real FastAPI responses, never hand-written query rows.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { runWarehouse } from './warehouse.ts';
import { createSourcesHandler } from '../bmq-data-sources/handler.ts';
const records=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));
const signal=new AbortController().signal;
const input={question:'Revenue for September 9, 2026',language:'en',page:{route:'/',label:'Home'},history:[]};
let queries=0;
const result=await runWarehouse(input,async(path,body)=>{
 if(path==='/v1/semantic')return records.semantic;
 assert.equal(path,'/v1/query');assert.deepEqual((body as any).time_range,{start:'2026-09-09',end:'2026-09-09'});queries++;return records.query;
},async()=>({value:{lane:'semantic',queries:[{metric:'revenue',time_range:'2026-09-09/2026-09-09',dimensions:[],limit:20}],search:'',clarification:''},usage:{input:1,output:1,cached:0}}),signal);
assert.equal(queries,1);assert.match(result.answer,/100000\.0+ VND/);
let round=0;
const knowledge=await runWarehouse({...input,question:'What does BMQ AI do?'},async(path)=>path==='/v1/semantic'?records.semantic:records.knowledge,
 async()=>({value:++round===1?{lane:'knowledge',queries:[],search:'BMQ inventory',clarification:''}:{answer:'BMQ AI manages inventory and purchase orders.',citations:[records.knowledge.chunks[0].id]},usage:{input:1,output:1,cached:0}}),signal);
assert.match(knowledge.answer,/BMQ AI manages inventory/);assert.doesNotMatch(knowledge.answer,/Sources:/);assert.equal(knowledge.provenance.citations.length,1);
const sourceHandler=createSourcesHandler({enabled:()=>true,url:()=> 'https://warehouse.test',authenticate:async()=> 'Bearer test-fixture',fetcher:async()=>new Response(JSON.stringify(records.sources))});
const sourceResponse=await sourceHandler(new Request('https://edge.test',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'sources',language:'en'})}));
assert.equal(sourceResponse.status,200);assert.equal((await sourceResponse.json()).sources.length,7);
console.log('Actual FastAPI -> Edge query, citations and source contract passed');
