/* NODE_PATH points to a local @electric-sql/pglite; in-memory PostgreSQL, no remote DB. */
const {PGlite}=require('@electric-sql/pglite');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
(async()=>{
 const db=new PGlite();
 const actor='00000000-0000-4000-8000-000000000001',customer='00000000-0000-4000-8000-000000000002',legacy='00000000-0000-4000-8000-000000000003';
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);insert into auth.users values ('${actor}');
 create table customer_po_inbox(id uuid primary key default gen_random_uuid(),gmail_message_id text unique,from_email text not null,from_name text,email_subject text,matched_customer_id uuid,po_number text,delivery_date date,production_items jsonb,subtotal_amount numeric,vat_amount numeric,total_amount numeric,match_status text,reviewed_by uuid,reviewed_at timestamptz,raw_payload jsonb,has_attachments boolean,attachment_names text[],created_at timestamptz default now());
 insert into customer_po_inbox(id,from_email,matched_customer_id,po_number,production_items) values ('${legacy}','dathang@kingfoodmart.com','${customer}',' po-old ','[{"qty":77}]');`);
 await db.exec(fs.readFileSync(path.resolve(__dirname,'../supabase/migrations/20260914185000_kfm_portal_po_intake.sql'),'utf8'));
 let n=0;async function pass(name,fn){await fn();n++;console.log('ok',name);}
 async function claim(order,code='PO-'+order,decision='confirm'){return db.query(`insert into kfm_po_intake_attempts(vendor_id,order_id,po_number,actor_id,request_id,decision,reason,content_revision,snapshot) values(1865,$1,$2,$3,$4,$5,'reason','revision','{}')`,[order,code,actor,`00000000-0000-4000-8000-${String(order).padStart(12,'0')}`,decision]);}
 const payload=order=>({po_number:'PO-'+order,delivery_date:'2026-09-16',production_items:[{qty:10,product_name:'Bread',sku_id:'sku1'}],subtotal_amount:100,vat_amount:8,total_amount:108,raw_payload:{source:'kfm_portal',portal_sub_status:5,kfm_order_id:order,vendor_id:1865}});
 const importPo=(order,p=payload(order))=>db.query('select kfm_import_confirmed_po(1865,$1,$2::jsonb) id',[order,JSON.stringify(p)]);
 await claim(11);
 await pass('null readback source rejected',()=>assert.rejects(importPo(11,{...payload(11),raw_payload:{}}),/readback mismatch/));
 await pass('pending portal status rejected',()=>assert.rejects(importPo(11,{...payload(11),raw_payload:{...payload(11).raw_payload,portal_sub_status:3}}),/readback mismatch/));
 await pass('missing items rejected',()=>assert.rejects(importPo(11,{...payload(11),production_items:null}),/items required/));
 await pass('negative qty rejected',()=>assert.rejects(importPo(11,{...payload(11),production_items:[{qty:-1,product_name:'Bread',sku_id:'sku1'}]}),/Invalid PO items/));
 await pass('portal ID mismatch rejected',()=>assert.rejects(importPo(11,{...payload(11),raw_payload:{...payload(11).raw_payload,kfm_order_id:99}}),/readback mismatch/));
 let imported;
 await pass('valid confirmed PO imports with canonical marker and CRM',async()=>{imported=(await importPo(11)).rows[0].id;const row=(await db.query('select * from customer_po_inbox where id=$1',[imported])).rows[0];assert.equal(row.matched_customer_id,customer);assert.equal(row.gmail_message_id,'kfm-portal:1865:11');assert.equal(row.raw_payload.source,'kfm_portal');assert.equal(row.match_status,'approved');});
 await pass('retry resumes same inbox without duplication',async()=>{assert.equal((await importPo(11)).rows[0].id,imported);assert.equal(Number((await db.query('select count(*) n from customer_po_inbox')).rows[0].n),2);});
 await pass('duplicate decision claim blocked',()=>assert.rejects(claim(11),/duplicate key/));
 await claim(12,'PO-OLD');
 await pass('canonical historical PO is linked, never rewritten',async()=>{assert.equal((await importPo(12,{...payload(12),po_number:'PO-OLD'})).rows[0].id,legacy);const row=(await db.query('select from_email,production_items from customer_po_inbox where id=$1',[legacy])).rows[0];assert.equal(row.from_email,'dathang@kingfoodmart.com');assert.equal(row.production_items[0].qty,77);});
 await claim(13,'PO-13','reject');
 await pass('reject claim cannot import',()=>assert.rejects(importPo(13),/Confirmed intake claim required/));
 await pass('browser denied journal table and RPC',async()=>{await db.exec('set role authenticated');await assert.rejects(db.query('select * from kfm_po_intake_attempts'),/permission denied/);await assert.rejects(importPo(11),/permission denied/);await db.exec('reset role');});
 await pass('all prior PO numbers returned canonical',async()=>{const r=await db.query('select * from kfm_existing_po_numbers() order by po_number');assert.deepEqual(r.rows.map(x=>x.po_number),['PO-11','PO-OLD']);});
 console.log(`PASS ${n} intake PostgreSQL checks`);await db.close();
})().catch(e=>{console.error(e);process.exit(1);});
