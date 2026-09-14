/* Run with @electric-sql/pglite available via NODE_PATH. In-memory PostgreSQL only. */
const { PGlite } = require('@electric-sql/pglite');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
(async()=>{
  const db=new PGlite();
  await db.exec(`create schema auth;
    create function auth.role() returns text language sql as $$ select current_setting('request.jwt.claim.role',true) $$;
    create table mini_crm_customers(id text primary key,customer_code text,customer_name text);
    create table customer_po_inbox(id text primary key,from_email text,revenue_channel text,raw_payload jsonb,
      matched_customer_id text,gmail_message_id text,match_status text,production_items jsonb,po_number text,
      delivery_date date,subtotal_amount numeric,vat_amount numeric,total_amount numeric,review_note text,posted_to_revenue boolean);
    insert into mini_crm_customers values ('kfm','b2b-kfm','Kingfoodmart'),('other','other','Other');
    insert into customer_po_inbox(id,from_email,matched_customer_id,gmail_message_id,match_status,raw_payload)
      values ('old','dathang@kingfoodmart.com','kfm','email-old','pending_approval','{}'),
      ('approved','dathang@kingfoodmart.com','kfm','email-approved','approved','{}');`);
  await db.exec(fs.readFileSync(path.resolve(__dirname,'../supabase/migrations/20260914190000_kfm_email_intake_retired.sql'),'utf8'));
  let count=0;
  async function pass(name,sql){await db.exec(sql);count++;console.log('ok',name);}
  async function blocked(name,sql){await assert.rejects(db.exec(sql),/kfm_email_source_retired|requires the server|require the server|cannot be converted/);count++;console.log('ok',name);}
  await pass('non-KFM import unaffected',`insert into customer_po_inbox(id,from_email,matched_customer_id) values ('other','orders@other.test','other')`);
  await blocked('KFM sender new import blocked',`insert into customer_po_inbox(id,from_email) values ('new','dathang@kingfoodmart.com')`);
  await blocked('KFM CRM-matched forward blocked',`insert into customer_po_inbox(id,from_email,matched_customer_id) values ('new','forward@example.com','kfm')`);
  await blocked('historical promotion blocked',`update customer_po_inbox set match_status='approved' where id='old'`);
  await blocked('historical reparse blocked',`update customer_po_inbox set production_items='[{"qty":10}]' where id='old'`);
  await pass('historical review note retained',`update customer_po_inbox set review_note='Preserved audit' where id='old'`);
  await pass('historical approved finance posting retained',`update customer_po_inbox set posted_to_revenue=true,raw_payload='{"revenue_post":{"total":100}}' where id='approved'`);
  await db.exec(`set request.jwt.claim.role='authenticated'`);
  await blocked('browser cannot fabricate portal insertion',`insert into customer_po_inbox(id,from_email,gmail_message_id,raw_payload) values ('portal','portal@kingfoodmart.com','kfm-portal:1865:9','{"source":"kfm_portal"}')`);
  await db.exec(`set request.jwt.claim.role='service_role'`);
  await pass('server portal insert allowed',`insert into customer_po_inbox(id,from_email,gmail_message_id,raw_payload,match_status) values ('portal','portal@kingfoodmart.com','kfm-portal:1865:9','{"source":"kfm_portal"}','approved')`);
  await blocked('history cannot be relabeled portal',`update customer_po_inbox set from_email='portal@kingfoodmart.com',gmail_message_id='kfm-portal:1865:10',raw_payload='{"source":"kfm_portal"}' where id='old'`);
  await db.exec(`set request.jwt.claim.role='authenticated'`);
  for(const [key,value] of [['match_status',"'pending_approval'"],['po_number',"'changed'"],['delivery_date',"'2026-09-15'"],['total_amount','123'],['subtotal_amount','100'],['vat_amount','23'],['production_items',"'[]'"],['matched_customer_id',"'other'"],['revenue_channel',"'retail'"]]){
    await blocked('browser cannot alter portal '+key,`update customer_po_inbox set ${key}=${value} where id='portal'`);
  }
  await blocked('browser cannot strip portal source',`update customer_po_inbox set raw_payload='{}',from_email='other@example.com' where id='portal'`);
  const records=await db.query('select id from customer_po_inbox order by id');assert.deepEqual(records.rows.map(r=>r.id),['approved','old','other','portal']);
  console.log(`${count} PostgreSQL cutover checks passed; historical rows preserved`);
  await db.close();
})().catch(e=>{console.error(e);process.exit(1);});
