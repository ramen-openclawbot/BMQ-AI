// Closed, in-memory backend: only explicitly listed tables/operations are allowed.
const w=window as unknown as {__dbCalls:unknown[];__unexpected:string[]};w.__dbCalls=[];w.__unexpected=[];
const mode=new URLSearchParams(location.search).get('mode')||'data';
const tables:Record<string,Record<string,unknown>[]>={
 inventory_items:[{id:'i1',name:'Nguyên liệu giữ nguyên',quantity:2,min_stock:5}],
 suppliers:[{id:'s1',name:'NCC giữ nguyên',default_payment_method:'cash'}],
 goods_receipts:[{id:'gr1',receipt_number:'GR-001',status:'received',supplier_id:'s1',suppliers:{id:'s1',name:'NCC giữ nguyên'}}],
 payment_requests:[{id:'pr1',status:'pending',created_by:null}],
 payment_request_items:[],product_skus:[],profiles:[],invoice_items:[],
};
function unexpected(message:string):never{w.__unexpected.push(message);throw new Error(message);}
function from(table:string){
 if(!(table in tables))return unexpected(`table ${table}`);
 const operations:{method:string,args:unknown[]}[]=[];
 const chain=new Proxy({}, {get(_target,method:string){
 if(method==='then')return (resolve:(v:unknown)=>void)=>{
 w.__dbCalls.push({table,operations});if(mode==='loading')return;
 const insert=operations.find(o=>o.method==='insert');
 let data=mode==='empty'?[]:tables[table];
 for(const op of operations){if(op.method==='eq')data=data.filter(row=>row[String(op.args[0])]===op.args[1]);if(op.method==='in')data=data.filter(row=>(op.args[1] as unknown[]).includes(row[String(op.args[0])]))}
 if(insert)data=[{id:'00000000-0000-4000-8000-000000000001',...(insert.args[0] as object)}];
 let result:{data:unknown;error:{message:string}|null};
 if(mode==='error'||((mode==='save-error'||mode==='supplier-error')&&insert))result={data:null,error:{message:mode==='supplier-error'?'  fixture $& {message}\n denied  ':'fixture denied'}};
 else if((mode==='request-denied'||mode==='request-failed')&&table==='payment_requests'&&insert)result={data:null,error:new Error(mode==='request-denied'?'row-level security permission denied':'  generic $& {message}\n failure  ')};
 else result={data:operations.some(o=>['single','maybeSingle'].includes(o.method))?(data[0]||null):data,error:null};
 const finish=()=>resolve(result);
 if(insert&&((mode==='supplier-create'&&table==='payment_requests')||(['request-denied','request-failed'].includes(mode)&&table==='payment_requests')))setTimeout(finish,700);else finish();
 };
 if(!['select','eq','in','order','limit','single','maybeSingle','insert','ilike','or'].includes(method))return unexpected(`operation ${method}`);
 if(method==='insert'&&!['payment_requests','payment_request_items','suppliers'].includes(table))return unexpected(`write ${table}`);
 return (...args:unknown[])=>{operations.push({method,args});return chain;};
 }});return chain;
}
export const supabase={from,auth:{getUser:async()=>({data:{user:{id:'00000000-0000-4000-8000-000000000002'}},error:null}),getSession:async()=>({data:{session:{access_token:'fixture-only'}}})},storage:{from:()=>unexpected('storage')},rpc:async(name:string,args:Record<string,unknown>)=>{if(name!=='create_procurement_line_with_material_resolution')return unexpected(`rpc ${name}`);w.__dbCalls.push({rpc:name,args});return {data:{line_id:'00000000-0000-4000-8000-000000000003',status:'created',line_kind:'raw_material',resolved_exact:true},error:null};}};
