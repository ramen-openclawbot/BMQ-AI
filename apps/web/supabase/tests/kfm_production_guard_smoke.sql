-- Rollback-only smoke checks for 20261103560000_kfm_production_guard.sql.
--
-- The acceptance command wraps this file and the migration in BEGIN ... ROLLBACK,
-- so this file must not open or close the transaction itself.
--   (echo 'begin;'; cat migration test; echo 'rollback;') | psql
--
-- It creates throwaway auth users, a KFM inbox/attempt per scenario, calls the
-- RPCs as an owner/editor and ends with select 'SMOKE_OK'.

do $$
declare
  v_owner uuid := 'c0f00000-0000-4000-8000-000000000001';
  v_editor uuid := 'c0f00000-0000-4000-8000-000000000002';
  v_vendor bigint := 800000000 + floor(random() * 99999999)::bigint;
  v_customer uuid;
  v_sku uuid;
  v_sku_code text;
  v_sku_name text;
  v_sku_unit text;
  v_base text := 'PO100' || to_char(clock_timestamp(), 'YYMMDDHH24MISSUS');
  v_non_kfm_number text := 'SMOKE-NONKFM-' || to_char(clock_timestamp(), 'YYMMDDHH24MISSUS');
  v_po_a uuid := 'c0f00000-0000-4000-8000-0000000000a1';
  v_po_b uuid := 'c0f00000-0000-4000-8000-0000000000b1';
  v_po_c uuid := 'c0f00000-0000-4000-8000-0000000000c1';
  v_po_d uuid := 'c0f00000-0000-4000-8000-0000000000d1';
  v_po_d2 uuid := 'c0f00000-0000-4000-8000-0000000000d2';
  v_po_d3 uuid := 'c0f00000-0000-4000-8000-0000000000d3';
  v_po_e uuid := 'c0f00000-0000-4000-8000-0000000000e1';
  v_po_f uuid := 'c0f00000-0000-4000-8000-0000000000f1';
  v_po_g uuid := 'c0f00000-0000-4000-8000-0000000000a2';
  v_po_h uuid := 'c0f00000-0000-4000-8000-0000000000b2';
  v_num_a text := v_base || '1';
  v_num_b text := v_base || '2';
  v_num_c text := v_base || '3';
  v_num_d text := v_base || '4';
  v_num_d2 text := v_base || '5';
  v_num_d3 text := v_base || '6';
  v_num_e text := v_base || '7';
  v_num_f text := v_base || '8';
  v_num_g text := v_base || '9';
  v_result jsonb;
  v_pre jsonb;
  v_row jsonb;
  v_order_a uuid;
  v_order_b uuid;
  v_order_d uuid;
  v_order_d2 uuid;
  v_order_d3 uuid;
  v_order_g uuid;
  v_state text;
  v_msg text;
  v_status text;
  v_notes text;
  v_issue uuid;
  v_ok boolean;
begin
  -- -------------------------------------------------------------------------
  -- Fixtures: auth users/permissions, one enabled Q7 SKU, KFM inboxes.
  -- -------------------------------------------------------------------------
  insert into auth.users (id, instance_id, aud, role, email) values
    (v_owner, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'smoke-kfm-owner@bmq.invalid'),
    (v_editor, '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated', 'smoke-kfm-editor@bmq.invalid');
  insert into public.user_roles (user_id, role) values (v_owner, 'owner');
  insert into public.user_module_permissions (user_id, module_key, can_view, can_edit)
    values (v_editor, 'production_q7', true, true);

  select c.id into v_customer from public.mini_crm_customers c order by c.created_at limit 1;

  select s.id, s.sku_code, s.product_name, coalesce(nullif(s.unit, ''), 'cái')
  into v_sku, v_sku_code, v_sku_name, v_sku_unit
  from public.product_skus s
  join public.production_location_sku_settings q on q.sku_id = s.id
  where q.location_code = 'q7' and q.is_enabled
  order by s.sku_code
  limit 1;
  if v_sku is null then
    raise exception 'SMOKE_RESULT FAIL no enabled Q7 SKU';
  end if;

  -- KFM POs: portal payload + confirmed intake attempt.
  insert into public.customer_po_inbox (
    id, gmail_message_id, from_email, from_name, email_subject, matched_customer_id,
    po_number, delivery_date, production_items, subtotal_amount, vat_amount, total_amount,
    match_status, reviewed_by, reviewed_at, raw_payload, has_attachments, attachment_names
  ) values
    (v_po_a, 'kfm-portal:' || v_vendor || ':' || '901', 'portal@kingfoodmart.com', 'KINGFOOD MART', 'KFM smoke A', v_customer,
     v_num_a, '2030-01-05', jsonb_build_array(jsonb_build_object('sku_id', v_sku::text, 'sku_code', v_sku_code, 'product_name', v_sku_name, 'unit', v_sku_unit, 'qty', 570, 'date', '2030-01-05')),
     0, 0, 0, 'approved', v_owner, now(), '{"source":"kfm_portal"}'::jsonb, false, '{}'),
    (v_po_b, 'kfm-portal:' || v_vendor || ':' || '902', 'portal@kingfoodmart.com', 'KINGFOOD MART', 'KFM smoke B', v_customer,
     v_num_b, '2030-01-05', jsonb_build_array(jsonb_build_object('sku_id', v_sku::text, 'sku_code', v_sku_code, 'product_name', v_sku_name, 'unit', v_sku_unit, 'qty', 600, 'date', '2030-01-05')),
     0, 0, 0, 'approved', v_owner, now(), '{"source":"kfm_portal"}'::jsonb, false, '{}'),
    (v_po_c, 'kfm-portal:' || v_vendor || ':' || '903', 'portal@kingfoodmart.com', 'KINGFOOD MART', 'KFM smoke C', v_customer,
     v_num_c, '2030-01-05', jsonb_build_array(jsonb_build_object('sku_id', v_sku::text, 'sku_code', v_sku_code, 'product_name', v_sku_name, 'unit', v_sku_unit, 'qty', 100, 'date', '2030-01-05')),
     0, 0, 0, 'approved', v_owner, now(), '{"source":"kfm_portal"}'::jsonb, false, '{}'),
    (v_po_d, 'kfm-portal:' || v_vendor || ':' || '904', 'portal@kingfoodmart.com', 'KINGFOOD MART', 'KFM smoke D', v_customer,
     v_num_d, '2030-01-05', jsonb_build_array(jsonb_build_object('sku_id', v_sku::text, 'sku_code', v_sku_code, 'product_name', v_sku_name, 'unit', v_sku_unit, 'qty', 600, 'date', '2030-01-05')),
     0, 0, 0, 'approved', v_owner, now(), '{"source":"kfm_portal"}'::jsonb, false, '{}'),
    (v_po_d2, 'kfm-portal:' || v_vendor || ':' || '905', 'portal@kingfoodmart.com', 'KINGFOOD MART', 'KFM smoke D2', v_customer,
     v_num_d2, '2030-01-05', jsonb_build_array(jsonb_build_object('sku_id', v_sku::text, 'sku_code', v_sku_code, 'product_name', v_sku_name, 'unit', v_sku_unit, 'qty', 600, 'date', '2030-01-05')),
     0, 0, 0, 'approved', v_owner, now(), '{"source":"kfm_portal"}'::jsonb, false, '{}'),
    (v_po_d3, 'kfm-portal:' || v_vendor || ':' || '906', 'portal@kingfoodmart.com', 'KINGFOOD MART', 'KFM smoke D3', v_customer,
     v_num_d3, '2030-01-05', jsonb_build_array(jsonb_build_object('sku_id', v_sku::text, 'sku_code', v_sku_code, 'product_name', v_sku_name, 'unit', v_sku_unit, 'qty', 600, 'date', '2030-01-05')),
     0, 0, 0, 'approved', v_owner, now(), '{"source":"kfm_portal"}'::jsonb, false, '{}'),
    (v_po_e, 'kfm-portal:' || v_vendor || ':' || '907', 'portal@kingfoodmart.com', 'KINGFOOD MART', 'KFM smoke E', v_customer,
     v_num_e, '2030-01-05', jsonb_build_array(jsonb_build_object('sku_id', v_sku::text, 'sku_code', v_sku_code, 'product_name', v_sku_name, 'unit', v_sku_unit, 'qty', 600, 'date', '2030-01-05')),
     0, 0, 0, 'approved', v_owner, now(), '{"source":"kfm_portal"}'::jsonb, false, '{}'),
    (v_po_f, 'kfm-portal:' || v_vendor || ':' || '908', 'portal@kingfoodmart.com', 'KINGFOOD MART', 'KFM smoke F', v_customer,
     v_num_f, '2030-01-06', jsonb_build_array(jsonb_build_object('sku_id', v_sku::text, 'sku_code', v_sku_code, 'product_name', v_sku_name, 'unit', v_sku_unit, 'qty', 100, 'date', '2030-01-06')),
     0, 0, 0, 'approved', v_owner, now(), '{"source":"kfm_portal"}'::jsonb, false, '{}'),
    (v_po_g, 'kfm-portal:' || v_vendor || ':' || '909', 'portal@kingfoodmart.com', 'KINGFOOD MART', 'KFM smoke G', v_customer,
     v_num_g, '2030-01-07', jsonb_build_array(jsonb_build_object('sku_id', v_sku::text, 'sku_code', v_sku_code, 'product_name', v_sku_name, 'unit', v_sku_unit, 'qty', 600, 'date', '2030-01-07')),
     0, 0, 0, 'approved', v_owner, now(), '{"source":"kfm_portal"}'::jsonb, false, '{}');

  insert into public.kfm_po_intake_attempts (
    vendor_id, order_id, po_number, actor_id, request_id, decision, state,
    content_revision, snapshot, inbox_id
  ) values
    (v_vendor, 1, v_num_a, v_owner, gen_random_uuid(), 'confirm', 'imported', 'smoke', '{}', v_po_a),
    (v_vendor, 2, v_num_b, v_owner, gen_random_uuid(), 'confirm', 'imported', 'smoke', '{}', v_po_b),
    (v_vendor, 3, v_num_c, v_owner, gen_random_uuid(), 'confirm', 'imported', 'smoke', '{}', v_po_c),
    (v_vendor, 4, v_num_d, v_owner, gen_random_uuid(), 'confirm', 'imported', 'smoke', '{}', v_po_d),
    (v_vendor, 5, v_num_d2, v_owner, gen_random_uuid(), 'confirm', 'imported', 'smoke', '{}', v_po_d2),
    (v_vendor, 6, v_num_d3, v_owner, gen_random_uuid(), 'confirm', 'imported', 'smoke', '{}', v_po_d3),
    (v_vendor, 7, v_num_e, v_owner, gen_random_uuid(), 'confirm', 'imported', 'smoke', '{}', v_po_e),
    (v_vendor, 8, v_num_f, v_owner, gen_random_uuid(), 'confirm', 'imported', 'smoke', '{}', v_po_f),
    (v_vendor, 9, v_num_g, v_owner, gen_random_uuid(), 'confirm', 'imported', 'smoke', '{}', v_po_g);

  -- Non-KFM PO: no portal payload, no Kingfood marker, no KFM PO number.
  insert into public.customer_po_inbox (
    id, gmail_message_id, from_email, from_name, email_subject, matched_customer_id,
    po_number, delivery_date, production_items, subtotal_amount, vat_amount, total_amount,
    match_status, reviewed_by, reviewed_at, raw_payload, has_attachments, attachment_names
  ) values (
    v_po_h, 'kfm-smoke:' || v_non_kfm_number, 'smoke-nonkfm@example.test', 'Công ty Smoke', 'Non-KFM smoke', null,
    v_non_kfm_number, '2030-01-05', '[]'::jsonb,
    0, 0, 0, 'approved', v_owner, now(), '{"source":"manual"}'::jsonb, false, '{}'
  );

  -- Act as the owner for every call below. auth.uid() reads these claims.
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', v_owner::text)::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_owner::text, true);

  -- -------------------------------------------------------------------------
  -- (1) A 570-pack KFM order is refused with the missing-pack message.
  -- -------------------------------------------------------------------------
  v_state := null;
  v_msg := null;
  begin
    perform public.create_q7_production_from_po(
      v_po_a, '2030-01-05'::date, '2030-01-05'::date, null,
      jsonb_build_array(jsonb_build_object('sku_id', v_sku::text, 'product_name', v_sku_name, 'unit', v_sku_unit, 'original_qty', 570, 'planned_qty', 570, 'date', '2030-01-05')),
      null, false);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  if v_state is distinct from 'P0001'
     or v_msg not like 'kfm_below_min_packs:%'
     or v_msg not like '%Thiếu 30 gói (tổng 570/600)%' then
    raise exception 'SMOKE_RESULT FAIL below_min state=% message=%', v_state, v_msg;
  end if;

  -- Read-only preflight reports the same shortfall before anything is written.
  v_pre := public.kfm_production_preflight(
    v_po_a, '2030-01-05'::date,
    jsonb_build_array(jsonb_build_object('sku_id', v_sku::text, 'product_name', v_sku_name, 'unit', v_sku_unit, 'original_qty', 570, 'planned_qty', 570, 'date', '2030-01-05')));
  if (v_pre->>'is_kfm')::boolean is not true
     or (v_pre->>'min_packs')::numeric <> 600
     or (v_pre->>'new_packs')::numeric <> 570
     or (v_pre->>'other_packs')::numeric <> 0
     or (v_pre->>'total_packs')::numeric <> 570
     or (v_pre->>'below_min')::boolean is not true
     or jsonb_array_length(v_pre->'existing') <> 0 then
    raise exception 'SMOKE_RESULT FAIL preflight_before %', v_pre;
  end if;

  -- -------------------------------------------------------------------------
  -- (2) The owner can override the minimum; the order is created.
  -- -------------------------------------------------------------------------
  v_result := public.create_q7_production_from_po(
    v_po_a, '2030-01-05'::date, '2030-01-05'::date, null,
    jsonb_build_array(jsonb_build_object('sku_id', v_sku::text, 'product_name', v_sku_name, 'unit', v_sku_unit, 'original_qty', 570, 'planned_qty', 570, 'date', '2030-01-05')),
    null, true);
  v_order_a := (v_result->'order'->>'id')::uuid;
  if v_order_a is null or coalesce((v_result->>'reused')::boolean, true) then
    raise exception 'SMOKE_RESULT FAIL owner_override %', v_result;
  end if;

  -- -------------------------------------------------------------------------
  -- (3) A 600-pack KFM PO replaces the 570-pack order in one call.
  -- -------------------------------------------------------------------------
  v_result := public.create_q7_production_from_po(
    v_po_b, '2030-01-05'::date, '2030-01-05'::date, null,
    jsonb_build_array(jsonb_build_object('sku_id', v_sku::text, 'product_name', v_sku_name, 'unit', v_sku_unit, 'original_qty', 600, 'planned_qty', 600, 'date', '2030-01-05')),
    array[v_order_a], false);
  v_order_b := (v_result->'order'->>'id')::uuid;
  if v_order_b is null then
    raise exception 'SMOKE_RESULT FAIL replace_create %', v_result;
  end if;

  select o.status::text, o.notes into v_status, v_notes
  from public.production_orders o where o.id = v_order_a;
  if v_status is distinct from 'cancelled'
     or position('[Thay bằng PO ' || v_num_b in coalesce(v_notes, '')) = 0 then
    raise exception 'SMOKE_RESULT FAIL replaced_order status=% notes=%', v_status, v_notes;
  end if;

  select o.status::text into v_status
  from public.production_orders o where o.id = v_order_b;
  if v_status is distinct from 'planned' then
    raise exception 'SMOKE_RESULT FAIL new_order status=%', v_status;
  end if;

  -- -------------------------------------------------------------------------
  -- (4) Preflight sees the remaining KFM order and counts it.
  -- -------------------------------------------------------------------------
  v_pre := public.kfm_production_preflight(
    v_po_c, '2030-01-05'::date,
    jsonb_build_array(jsonb_build_object('sku_id', v_sku::text, 'product_name', v_sku_name, 'unit', v_sku_unit, 'original_qty', 100, 'planned_qty', 100, 'date', '2030-01-05')));
  select value into v_row from jsonb_array_elements(v_pre->'existing') value limit 1;
  if jsonb_array_length(v_pre->'existing') <> 1
     or (v_row->>'id')::uuid is distinct from v_order_b
     or (v_row->>'production_number')::text is null
     or (v_row->>'po_number') is distinct from v_num_b
     or (v_row->>'packs')::numeric <> 600
     or coalesce((v_row->>'cancellable')::boolean, false) is not true
     or (v_pre->>'other_packs')::numeric <> 600
     or (v_pre->>'new_packs')::numeric <> 100
     or (v_pre->>'total_packs')::numeric <> 700
     or (v_pre->>'below_min')::boolean is not false then
    raise exception 'SMOKE_RESULT FAIL preflight_after %', v_pre;
  end if;

  -- -------------------------------------------------------------------------
  -- (5) Downstream evidence blocks cancellation and replacement.
  -- -------------------------------------------------------------------------
  v_result := public.create_q7_production_from_po(
    v_po_d, '2030-01-05'::date, '2030-01-05'::date, null,
    jsonb_build_array(jsonb_build_object('sku_id', v_sku::text, 'product_name', v_sku_name, 'unit', v_sku_unit, 'original_qty', 600, 'planned_qty', 600, 'date', '2030-01-05')),
    null, false);
  v_order_d := (v_result->'order'->>'id')::uuid;

  insert into public.kfm_daily_material_issues (issue_number, issue_date, source_hash)
  values ('KFM-SMOKE-' || to_char(clock_timestamp(), 'YYMMDDHH24MISSUS'), '2030-01-05', 'smoke')
  returning id into v_issue;
  insert into public.kfm_daily_material_issue_sources (
    issue_id, production_order_id, source_po_inbox_id, production_number, po_number
  ) values (
    v_issue, v_order_d, v_po_d,
    (select production_number from public.production_orders where id = v_order_d), v_num_d
  );

  v_state := null;
  v_msg := null;
  begin
    perform public.cancel_production_order(v_order_d, 'smoke material issue');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  if v_state is distinct from '22023' or v_msg is distinct from 'production_not_cancellable' then
    raise exception 'SMOKE_RESULT FAIL cancel_material state=% message=%', v_state, v_msg;
  end if;

  v_state := null;
  v_msg := null;
  begin
    perform public.create_q7_production_from_po(
      v_po_e, '2030-01-05'::date, '2030-01-05'::date, null,
      jsonb_build_array(jsonb_build_object('sku_id', v_sku::text, 'product_name', v_sku_name, 'unit', v_sku_unit, 'original_qty', 600, 'planned_qty', 600, 'date', '2030-01-05')),
      array[v_order_d], false);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  if v_state is distinct from '22023' or v_msg is distinct from 'production_replace_invalid' then
    raise exception 'SMOKE_RESULT FAIL replace_material state=% message=%', v_state, v_msg;
  end if;

  select o.status::text into v_status from public.production_orders o where o.id = v_order_d;
  if v_status is distinct from 'planned' then
    raise exception 'SMOKE_RESULT FAIL material_order_changed status=%', v_status;
  end if;

  -- Dispatch evidence blocks cancellation too.
  v_result := public.create_q7_production_from_po(
    v_po_d2, '2030-01-05'::date, '2030-01-05'::date, null,
    jsonb_build_array(jsonb_build_object('sku_id', v_sku::text, 'product_name', v_sku_name, 'unit', v_sku_unit, 'original_qty', 600, 'planned_qty', 600, 'date', '2030-01-05')),
    null, false);
  v_order_d2 := (v_result->'order'->>'id')::uuid;
  insert into public.warehouse_dispatches (dispatch_number, production_order_id, status)
  values ('XK-SMOKE-' || to_char(clock_timestamp(), 'YYMMDDHH24MISSUS'), v_order_d2, 'pending');

  v_state := null;
  v_msg := null;
  begin
    perform public.cancel_production_order(v_order_d2, 'smoke dispatch');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  if v_state is distinct from '22023' or v_msg is distinct from 'production_not_cancellable' then
    raise exception 'SMOKE_RESULT FAIL cancel_dispatch state=% message=%', v_state, v_msg;
  end if;

  -- Any actual quantity blocks cancellation.
  v_result := public.create_q7_production_from_po(
    v_po_d3, '2030-01-05'::date, '2030-01-05'::date, null,
    jsonb_build_array(jsonb_build_object('sku_id', v_sku::text, 'product_name', v_sku_name, 'unit', v_sku_unit, 'original_qty', 600, 'planned_qty', 600, 'date', '2030-01-05')),
    null, false);
  v_order_d3 := (v_result->'order'->>'id')::uuid;
  update public.production_order_items
  set actual_qty = 1
  where production_order_id = v_order_d3;

  v_state := null;
  v_msg := null;
  begin
    perform public.cancel_production_order(v_order_d3, 'smoke actual');
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  if v_state is distinct from '22023' or v_msg is distinct from 'production_not_cancellable' then
    raise exception 'SMOKE_RESULT FAIL cancel_actual state=% message=%', v_state, v_msg;
  end if;

  -- -------------------------------------------------------------------------
  -- (6) A non-KFM 100-pack PO is not subject to the KFM minimum.
  -- -------------------------------------------------------------------------
  v_result := public.create_q7_production_from_po(
    v_po_h, '2030-01-05'::date, '2030-01-05'::date, null,
    jsonb_build_array(jsonb_build_object('sku_id', v_sku::text, 'product_name', v_sku_name, 'unit', v_sku_unit, 'original_qty', 100, 'planned_qty', 100, 'date', '2030-01-05')),
    null, false);
  if (v_result->'order'->>'id') is null then
    raise exception 'SMOKE_RESULT FAIL non_kfm_create %', v_result;
  end if;

  v_pre := public.kfm_production_preflight(
    v_po_h, '2030-01-05'::date,
    jsonb_build_array(jsonb_build_object('sku_id', v_sku::text, 'product_name', v_sku_name, 'unit', v_sku_unit, 'original_qty', 100, 'planned_qty', 100, 'date', '2030-01-05')));
  if (v_pre->>'is_kfm')::boolean is not false
     or jsonb_array_length(v_pre->'existing') <> 0
     or (v_pre->>'below_min')::boolean is not false then
    raise exception 'SMOKE_RESULT FAIL preflight_non_kfm %', v_pre;
  end if;

  -- -------------------------------------------------------------------------
  -- (7) A non-owner editor cannot use the owner override.
  -- -------------------------------------------------------------------------
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', v_editor::text)::text, true);
  perform set_config('request.jwt.claim.sub', v_editor::text, true);

  v_state := null;
  v_msg := null;
  begin
    perform public.create_q7_production_from_po(
      v_po_f, '2030-01-06'::date, '2030-01-06'::date, null,
      jsonb_build_array(jsonb_build_object('sku_id', v_sku::text, 'product_name', v_sku_name, 'unit', v_sku_unit, 'original_qty', 100, 'planned_qty', 100, 'date', '2030-01-06')),
      null, true);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
  end;
  if v_state is distinct from 'P0001' or v_msg not like 'kfm_below_min_packs:%' then
    raise exception 'SMOKE_RESULT FAIL editor_override state=% message=%', v_state, v_msg;
  end if;

  perform set_config('request.jwt.claims', jsonb_build_object('role', 'authenticated', 'sub', v_owner::text)::text, true);
  perform set_config('request.jwt.claim.sub', v_owner::text, true);

  -- -------------------------------------------------------------------------
  -- (8) cancel_production_order cancels a clean order and appends the reason.
  -- -------------------------------------------------------------------------
  v_result := public.create_q7_production_from_po(
    v_po_g, '2030-01-07'::date, '2030-01-07'::date, null,
    jsonb_build_array(jsonb_build_object('sku_id', v_sku::text, 'product_name', v_sku_name, 'unit', v_sku_unit, 'original_qty', 600, 'planned_qty', 600, 'date', '2030-01-07')),
    null, false);
  v_order_g := (v_result->'order'->>'id')::uuid;

  v_result := public.cancel_production_order(v_order_g, 'hết hàng smoke');
  if (v_result->'order'->>'status') is distinct from 'cancelled'
     or position('hết hàng smoke' in coalesce(v_result->'order'->>'notes', '')) = 0 then
    raise exception 'SMOKE_RESULT FAIL cancel_success %', v_result;
  end if;

  -- -------------------------------------------------------------------------
  -- (9) Grants: helpers stay internal, public RPCs are authenticated-only.
  -- -------------------------------------------------------------------------
  if has_function_privilege('anon', 'public.kfm_is_kfm_po(uuid)', 'EXECUTE')
     or has_function_privilege('anon', 'public.kfm_production_preflight(uuid,date,jsonb)', 'EXECUTE')
     or has_function_privilege('anon', 'public.cancel_production_order(uuid,text)', 'EXECUTE')
     or has_function_privilege('anon', 'public.create_q7_production_from_po(uuid,date,date,text,jsonb,uuid[],boolean)', 'EXECUTE') then
    raise exception 'SMOKE_RESULT FAIL anon_grant';
  end if;
  if not has_function_privilege('authenticated', 'public.kfm_production_preflight(uuid,date,jsonb)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.cancel_production_order(uuid,text)', 'EXECUTE')
     or not has_function_privilege('authenticated', 'public.create_q7_production_from_po(uuid,date,date,text,jsonb,uuid[],boolean)', 'EXECUTE') then
    raise exception 'SMOKE_RESULT FAIL authenticated_grant';
  end if;
end;
$$;

select 'SMOKE_OK';
