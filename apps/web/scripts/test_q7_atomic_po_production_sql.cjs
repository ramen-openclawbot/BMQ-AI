/* In-memory PostgreSQL behavior tests; @electric-sql/pglite via NODE_PATH. */
const {PGlite}=require('@electric-sql/pglite');
const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
(async()=>{
  const db=new PGlite();
  const sku1='10000000-0000-4000-8000-000000000001',sku2='10000000-0000-4000-8000-000000000002',sku3='10000000-0000-4000-8000-000000000003';
  await db.exec(`create role anon;create role authenticated;create schema auth;
    create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
    create function can_edit_production_q7() returns boolean language sql as $$select coalesce(current_setting('test.q7',true),'false')='true'$$;
    create table mini_crm_customers(id uuid primary key,customer_code text,customer_name text);
    create table customer_po_inbox(id uuid primary key,from_email text,revenue_channel text,matched_customer_id uuid,match_status text,raw_payload jsonb,production_items jsonb,delivery_date date);
    create table production_orders(id uuid primary key default gen_random_uuid(),production_number text unique,source_po_inbox_id uuid,status text,location_code text,planned_start_date date,planned_end_date date,notes text,created_by uuid);
    create table product_skus(id uuid primary key,sku_code text,product_name text,unit text);
    create table production_location_sku_settings(sku_id uuid,location_code text,is_enabled boolean);
    create table production_order_items(id uuid primary key default gen_random_uuid(),production_order_id uuid references production_orders(id),sku_id uuid,product_name text,ordered_qty numeric,planned_qty numeric,unit text,delivery_date date,notes text);
    create table kfm_po_intake_attempts(inbox_id uuid,state text,decision text);
    insert into product_skus values('${sku1}','BREAD1','Bread 1','CÁI'),('${sku2}','BREAD2','Bread 2','HỘP'),('${sku3}','OFF','Off','CÁI');
    insert into production_location_sku_settings values('${sku1}','q7',true),('${sku2}','q7',true),('${sku3}','q7',false);
    insert into mini_crm_customers values('20000000-0000-4000-8000-000000000001','b2b-kfm','Kingfoodmart');
    set test.uid='30000000-0000-4000-8000-000000000001';set test.q7='true';`);
  await db.exec(fs.readFileSync(path.resolve(__dirname,'../supabase/migrations/20260914191000_q7_atomic_po_production.sql'),'utf8'));
  let seq=0,passed=0;
  const items=[{sku_id:sku1,product_name:'Bread 1',unit:'CÁI',original_qty:10,planned_qty:10,date:'2026-09-16'},
    {sku_id:sku2,product_name:'Bread 2',unit:'HỘP',original_qty:20,planned_qty:20,date:'2026-09-16'}];
  async function seed({portal=true,ledger=true,decision='confirm',state='imported',match='approved',from,customer=null}={}){
    const id='40000000-0000-4000-8000-'+String(++seq).padStart(12,'0');
    const source=items.map((i,n)=>({sku_code:'BREAD'+(n+1),product_name:i.product_name,unit:i.unit,qty:i.original_qty,date:i.date}));
    await db.query('insert into customer_po_inbox values($1,$2,$3,$4,$5,$6,$7,$8)',[id,from||(portal?'portal@kingfoodmart.com':'other@example.com'),null,customer,match,portal?{source:'kfm_portal'}:{},source,'2026-09-16']);
    if(ledger)await db.query('insert into kfm_po_intake_attempts values($1,$2,$3)',[id,state,decision]);
    return id;
  }
  async function call(id,data=items,start='2026-09-15',end='2026-09-16'){
    const res=await db.query('select create_q7_production_from_po($1,$2,$3,$4,$5) result',[id,start,end,'fixture',data]);return res.rows[0].result;
  }
  async function counts(){return (await db.query('select (select count(*) from production_orders)::int headers,(select count(*) from production_order_items)::int items')).rows[0];}
  async function test(name,fn){await fn();passed++;console.log('ok',name);}
  async function refuses(fn){const before=await counts();await assert.rejects(fn);assert.deepEqual(await counts(),before,'failed operation must leave no partial header/items');}
  await test('verified portal PO inserts one header and all items',async()=>{
    const id=await seed();const result=await call(id);assert.equal(result.reused,false);
    const rows=await db.query('select * from production_order_items where production_order_id=$1',[result.order.id]);assert.equal(rows.rows.length,2);assert.equal(rows.rows[0].ordered_qty,'10');
  });
  await test('duplicate source requests reuse same order including lost-response replay',async()=>{
    const id=await seed();const before=await counts();const [a,b]=await Promise.all([call(id),call(id)]);assert.equal(a.order.id,b.order.id);assert.equal(b.reused,true);
    const after=await counts();assert.equal(after.headers,before.headers+1);assert.equal(after.items,before.items+2);
  });
  await test('no authenticated actor cannot create',async()=>{
    const id=await seed();await db.exec("set test.uid=''");await refuses(()=>call(id));await db.exec("set test.uid='30000000-0000-4000-8000-000000000001'");
  });
  await test('no Q7 edit permission cannot create',async()=>{
    const id=await seed();await db.exec("set test.q7='false'");await refuses(()=>call(id));await db.exec("set test.q7='true'");
  });
  for(const opts of [{ledger:false},{state:'unknown'},{decision:'reject'},{match:'rejected'},{match:'pending_approval'}]){
    await test('unverified/rejected portal state refuses '+JSON.stringify(opts),async()=>await refuses(()=>seed(opts).then(id=>call(id))));
  }
  for(const [name,data] of [['empty',[]],['missing quantity',[{...items[0],planned_qty:null},items[1]]],['negative quantity',[{...items[0],planned_qty:-1},items[1]]],['NaN quantity',[{...items[0],planned_qty:'NaN'},items[1]]],['huge quantity',[{...items[0],planned_qty:1e15},items[1]]],['disabled SKU',[{...items[0],sku_id:sku3},items[1]]],['missing SKU',[{...items[0],sku_id:null},items[1]]],['duplicate SKU',[items[0],items[0]]],['missing delivery date',[{...items[0],date:null},items[1]]],['changed source quantity',[{...items[0],original_qty:11},items[1]]],['changed source date',[{...items[0],date:'2026-09-17'},items[1]]]]){
    await test('invalid plan refuses '+name,async()=>{const id=await seed();await refuses(()=>call(id,data));});
  }
  await test('end before start rejected',async()=>{const id=await seed();await refuses(()=>call(id,items,'2026-09-17','2026-09-16'));});
  await test('staff may adjust planned quantity without changing original source',async()=>{
    const id=await seed();const result=await call(id,[{...items[0],planned_qty:15},items[1]]);const r=await db.query('select ordered_qty,planned_qty,notes from production_order_items where production_order_id=$1 and sku_id=$2',[result.order.id,sku1]);
    assert.equal(r.rows[0].ordered_qty,'10');assert.equal(r.rows[0].planned_qty,'15');assert(r.rows[0].notes);
  });
  await test('item persistence failure rolls header back atomically',async()=>{
    await db.exec(`create function reject_test_item() returns trigger language plpgsql as $$begin if new.planned_qty=13 then raise exception 'fixture item insert failure';end if;return new;end;$$;create trigger fail_fixture before insert on production_order_items for each row execute function reject_test_item();`);
    const id=await seed();await refuses(()=>call(id,[{...items[0],planned_qty:13},items[1]]));await db.exec('drop trigger fail_fixture on production_order_items');
    const good=await call(id);assert.equal(good.reused,false);
  });
  await test('legacy non-KFM workflow remains available',async()=>{const id=await seed({portal:false,ledger:false,match:'pending_approval'});assert.equal((await call(id)).reused,false);});
  await test('historical KFM forwarded email cannot bypass portal confirmation',async()=>{
    const id=await seed({portal:false,ledger:false,match:'pending_approval',customer:'20000000-0000-4000-8000-000000000001'});await refuses(()=>call(id));
  });
  await test('portal source cannot silently omit a product',async()=>{const id=await seed();await refuses(()=>call(id,[items[0]]));});
  await test('canonical SKU overrides client product label/unit',async()=>{
    const id=await seed();const result=await call(id,[{...items[0],product_name:'Different product',unit:'KG'},items[1]]);
    const row=(await db.query('select product_name,unit from production_order_items where production_order_id=$1 and sku_id=$2',[result.order.id,sku1])).rows[0];
    assert.equal(row.product_name,'Bread 1');assert.equal(row.unit,'CÁI');
  });
  console.log(`${passed} Q7 PostgreSQL checks passed`);await db.close();
})().catch(e=>{console.error(e);process.exit(1);});
