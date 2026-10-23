-- Rollback-only smoke for the supplier-order email backend.
--
-- Load the migration in the same transaction before this file when executing,
-- e.g. psql "$DATABASE_URL" -f migration.sql -f smoke_supplier_order_email.sql
-- Never run this against production without the surrounding transaction.
--
-- Prerequisites: at least one owner in public.user_roles and one non-owner user
-- without purchase_orders edit permission (the last assertion uses that user).

begin;

select set_config('request.jwt.claim.role', 'service_role', true);

do $smoke$
declare
  v_actor uuid;
  v_viewer uuid;
  v_suffix text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  v_supplier_id uuid;
  v_supplier_name text := 'TV Food';
  v_item_id uuid;
  v_item_name text;
  v_item_unit text;
  v_price_po uuid;
  v_po_id uuid;
  v_order_request_id uuid;
  v_request_id uuid;
  v_day integer;
  v_production_order_id uuid;
  v_production_order_item_id uuid;
  v_issue_id uuid;
  v_prepare jsonb;
  v_create jsonb;
  v_replay jsonb;
  v_mark jsonb;
  v_resolve jsonb;
  v_upload jsonb;
  v_upload_path text;
  v_qty numeric;
  v_over numeric;
  v_count integer;
  v_i integer;
begin
  select u.id into v_actor
  from auth.users u
  join public.user_roles r on r.user_id = u.id and r.role = 'owner'
  order by u.created_at
  limit 1;
  if v_actor is null then
    raise exception 'smoke requires at least one owner user';
  end if;
  perform set_config('request.jwt.claim.sub', v_actor::text, true);

  select u.id into v_viewer
  from auth.users u
  where not exists (
      select 1 from public.user_roles r
      where r.user_id = u.id and r.role = 'owner'
    )
    and not exists (
      select 1 from public.user_module_permissions p
      where p.user_id = u.id
        and p.module_key = 'purchase_orders'
        and p.can_edit = true
    )
  order by u.created_at
  limit 1;
  if v_viewer is null then
    raise exception 'smoke requires a non-owner user without purchase_orders edit';
  end if;

  -- Supplier: a rollback-only TV Food row so the name assertion is stable.
  insert into public.suppliers (name, email, default_receiving_location)
  values (v_supplier_name, 'smoke-supplier@example.test', 'q7')
  returning id into v_supplier_id;

  -- Prefer the real Bơ Peerless Úc 25kg item; create a rollback fixture only if
  -- this database does not have one yet.
  select kii.id, kii.name, kii.unit
  into v_item_id, v_item_name, v_item_unit
  from public.kitchen_inventory_items kii
  where kii.active = true
    and (
      public.normalize_stock_item_name(kii.name) = 'bo peerless'
      or kii.name ilike '%Peerless%'
    )
  order by
    (public.normalize_stock_item_name(kii.name) = 'bo peerless') desc,
    (kii.name ilike '%25kg%') desc,
    kii.created_at asc
  limit 1;

  if v_item_id is null then
    insert into public.kitchen_inventory_items (
      item_code, normalized_key, item_type, name, unit, active
    ) values (
      'SMOKE-BO-PEERLESS-' || v_suffix,
      'smoke-bo-peerless-' || v_suffix,
      'ingredient',
      'Bơ Peerless Úc 25kg',
      'g',
      true
    )
    returning id, name, unit into v_item_id, v_item_name, v_item_unit;
  end if;

  -- App settings: mailbox + delivery details.
  insert into public.app_settings (key, value, updated_at)
  values
    ('order_gmail_connected_email', 'order@bmq.vn', now()),
    ('order_email_delivery_address', '123 Nguyễn Văn A, Quận 1, TP.HCM', now()),
    ('order_email_contact_name', 'Anh Minh', now()),
    ('order_email_contact_phone', '0909 123 456', now()),
    ('order_email_note', 'Giao trong giờ hành chính', now()),
    ('order_email_max_amount', '1000000000', now())
  on conflict (key) do update
  set value = excluded.value, updated_at = now();

  update public.suppliers
  set email = 'smoke-supplier@example.test'
  where id = v_supplier_id;

  -- Bơ Peerless: pack 25 kg expressed in g, supplier unit kg.
  insert into public.q7_purchase_item_settings (
    kitchen_inventory_item_id, mode, supplier_id, pack_size, pack_label,
    lead_time_days, safety_days, order_cycle_days, po_unit, po_unit_factor
  ) values (
    v_item_id, 'suggest', v_supplier_id, 25000, '25kg', 2, 2, 7, 'kg', 1000
  )
  on conflict (kitchen_inventory_item_id) do update
  set supplier_id = excluded.supplier_id,
      pack_size = excluded.pack_size,
      pack_label = excluded.pack_label,
      lead_time_days = excluded.lead_time_days,
      safety_days = excluded.safety_days,
      order_cycle_days = excluded.order_cycle_days,
      max_order_qty = null,
      po_unit = excluded.po_unit,
      po_unit_factor = excluded.po_unit_factor,
      updated_at = now();

  -- Latest supplier line: 90 đ per book unit × 1000 = 90.000 đ/kg.
  insert into public.purchase_orders (
    po_number, supplier_id, status, order_date, notes, total_amount, created_by
  ) values (
    'SMOKE-SUPPLIER-PRICE-' || v_suffix, v_supplier_id,
    'completed'::public.purchase_order_status, current_date,
    'smoke supplier price', 90, v_actor
  )
  returning id into v_price_po;

  insert into public.purchase_order_items (
    purchase_order_id, product_name, quantity, unit, unit_price, line_total
  ) values (
    v_price_po, 'Bơ Peerless', 1, v_item_unit, 90, 90
  );

  insert into public.stock_material_aliases (
    supplier_id, normalized_name, location, kitchen_inventory_item_id,
    conversion_factor, unit, created_by
  ) values (
    v_supplier_id, public.normalize_stock_item_name('Bơ Peerless'), 'q7',
    v_item_id, 1, v_item_unit, v_actor
  ) on conflict (supplier_id, normalized_name, location) do update
  set kitchen_inventory_item_id = excluded.kitchen_inventory_item_id,
      conversion_factor = excluded.conversion_factor,
      unit = excluded.unit,
      updated_at = now();

  -- 14 days of usage so a positive suggestion is produced after the count.
  for v_day in 0..13 loop
    insert into public.production_orders (production_number)
    values ('SMOKE-SUPPLIER-SX-' || v_suffix || '-' || v_day)
    returning id into v_production_order_id;

    insert into public.production_order_items (production_order_id, product_name, unit)
    values (v_production_order_id, 'Smoke bánh mì', 'cái')
    returning id into v_production_order_item_id;

    insert into public.production_material_issues (
      issue_number, production_order_id, issue_date, status, location_code,
      revision, source_hash, is_current
    ) values (
      'SMOKE-SUPPLIER-PXK-' || v_suffix || '-' || v_day,
      v_production_order_id, current_date - v_day, 'pdf_ready', 'q7',
      1, repeat('e', 64), true
    )
    returning id into v_issue_id;

    insert into public.production_material_issue_items (
      material_issue_id, production_order_item_id, kitchen_inventory_item_id,
      ingredient_name, required_qty, unit, source_ref_key
    ) values (
      v_issue_id, v_production_order_item_id, v_item_id,
      'Bơ Peerless', 1000, v_item_unit, 'smoke-supplier-' || v_suffix || '-' || v_day
    );
  end loop;

  -- Lower the Q7 balance with a manual_adjustment (record_q7_stock_count writes
  -- a q7-stock-count manual_adjustment when the counted quantity differs).
  v_prepare := public.record_q7_stock_count(
    v_item_id, 0, current_date, 'Smoke supplier order balance',
    'smoke-supplier-' || v_suffix
  );
  if v_prepare ->> 'status' <> 'recorded' then
    raise exception 'stock count not recorded: %', v_prepare;
  end if;

  ------------------------------------------------------------------
  -- prepare_supplier_order
  ------------------------------------------------------------------
  v_prepare := public.prepare_supplier_order(v_item_id);

  if v_prepare -> 'supplier' ->> 'name' <> v_supplier_name then
    raise exception 'supplier mismatch: %', v_prepare -> 'supplier';
  end if;
  if v_prepare -> 'proposal' ->> 'unit' <> 'kg' then
    raise exception 'unit mismatch: %', v_prepare -> 'proposal';
  end if;

  v_qty := (v_prepare -> 'proposal' ->> 'quantity')::numeric;
  if v_qty is null or v_qty <= 0 or mod(v_qty, 25) <> 0 then
    raise exception 'quantity must be a positive multiple of 25 kg: %', v_qty;
  end if;
  if (v_prepare -> 'proposal' ->> 'unit_price')::numeric <> 90000 then
    raise exception 'unit price mismatch: %', v_prepare -> 'proposal' ->> 'unit_price';
  end if;
  if public.normalize_stock_item_name(v_prepare -> 'proposal' ->> 'product_name') <> 'bo peerless' then
    raise exception 'supplier product wording mismatch: %', v_prepare -> 'proposal' ->> 'product_name';
  end if;
  if jsonb_array_length(coalesce(v_prepare -> 'blockers', '[]'::jsonb)) <> 0 then
    raise exception 'prepare returned blockers: %', v_prepare -> 'blockers';
  end if;

  -- no_supplier_email
  update public.suppliers set email = '' where id = v_supplier_id;
  v_prepare := public.prepare_supplier_order(v_item_id);
  if not (v_prepare -> 'blockers' ? 'no_supplier_email') then
    raise exception 'missing no_supplier_email blocker: %', v_prepare -> 'blockers';
  end if;
  update public.suppliers
  set email = 'smoke-supplier@example.test'
  where id = v_supplier_id;

  -- mailbox_not_connected
  update public.app_settings
  set value = 'other@example.test', updated_at = now()
  where key = 'order_gmail_connected_email';
  v_prepare := public.prepare_supplier_order(v_item_id);
  if not (v_prepare -> 'blockers' ? 'mailbox_not_connected') then
    raise exception 'missing mailbox_not_connected blocker: %', v_prepare -> 'blockers';
  end if;
  update public.app_settings
  set value = 'order@bmq.vn', updated_at = now()
  where key = 'order_gmail_connected_email';

  v_prepare := public.prepare_supplier_order(v_item_id);
  v_qty := (v_prepare -> 'proposal' ->> 'quantity')::numeric;
  v_request_id := gen_random_uuid();

  ------------------------------------------------------------------
  -- create_supplier_order_po: exactly one draft PO, idempotent replay
  ------------------------------------------------------------------
  v_create := public.create_supplier_order_po(
    v_request_id, v_item_id, v_qty, 'Smoke đặt hàng qua email', v_actor
  );
  if v_create ->> 'status' <> 'preparing' then
    raise exception 'create status mismatch: %', v_create;
  end if;
  v_po_id := (v_create ->> 'purchase_order_id')::uuid;
  v_order_request_id := (v_create ->> 'order_request_id')::uuid;

  select count(*) into v_count from public.purchase_orders where id = v_po_id;
  if v_count <> 1 then
    raise exception 'expected exactly one PO, got %', v_count;
  end if;
  select count(*) into v_count from public.purchase_order_items where purchase_order_id = v_po_id;
  if v_count <> 1 then
    raise exception 'expected exactly one PO line, got %', v_count;
  end if;
  if not exists (
    select 1 from public.purchase_order_items
    where purchase_order_id = v_po_id
      and unit = 'kg'
      and quantity = v_qty
  ) then
    raise exception 'PO line is not the expected kg quantity';
  end if;
  if (select status::text from public.purchase_orders where id = v_po_id) <> 'draft' then
    raise exception 'new PO must stay draft before send';
  end if;

  v_replay := public.create_supplier_order_po(
    v_request_id, v_item_id, v_qty, 'Smoke đặt hàng qua email', v_actor
  );
  if (v_replay ->> 'purchase_order_id')::uuid <> v_po_id
     or (v_replay ->> 'order_request_id')::uuid <> v_order_request_id then
    raise exception 'idempotent replay created a different request/PO: %', v_replay;
  end if;
  select count(*) into v_count
  from public.supplier_order_requests
  where request_id = v_request_id;
  if v_count <> 1 then
    raise exception 'expected one request row after replay, got %', v_count;
  end if;

  -- quantity 0 rejected
  begin
    perform public.create_supplier_order_po(
      gen_random_uuid(), v_item_id, 0, 'smoke zero', v_actor
    );
    raise exception 'zero quantity was accepted';
  exception when others then
    if sqlerrm not like '%invalid_quantity%' then
      raise;
    end if;
  end;

  -- over-limit quantity rejected
  v_over := greatest(3 * v_qty, 10 * 25) + 1;
  begin
    perform public.create_supplier_order_po(
      gen_random_uuid(), v_item_id, v_over, 'smoke over limit', v_actor
    );
    raise exception 'over-limit quantity was accepted';
  exception when others then
    if sqlerrm not like '%over_quantity_limit%' then
      raise;
    end if;
  end;

  ------------------------------------------------------------------
  -- mark sent, upload token, uploads
  ------------------------------------------------------------------
  v_mark := public.mark_supplier_order_sent(
    v_request_id, 'smoke-gmail-message', repeat('a', 64),
    now() + interval '30 days'
  );
  if v_mark ->> 'status' <> 'sent' then
    raise exception 'mark sent failed: %', v_mark;
  end if;
  if (select status::text from public.purchase_orders where id = v_po_id) <> 'sent' then
    raise exception 'PO did not move to sent';
  end if;

  v_resolve := public.resolve_supplier_order_upload_token(repeat('a', 64));
  if v_resolve is null then
    raise exception 'resolve returned null for a valid token';
  end if;
  if v_resolve ->> 'po_number' <> v_create ->> 'po_number' then
    raise exception 'resolve PO mismatch: %', v_resolve;
  end if;
  if (v_resolve ->> 'order_request_id')::uuid <> v_order_request_id then
    raise exception 'resolve request mismatch: %', v_resolve;
  end if;

  update public.supplier_order_requests
  set upload_expires_at = now() - interval '1 minute'
  where request_id = v_request_id;
  if public.resolve_supplier_order_upload_token(repeat('a', 64)) is not null then
    raise exception 'expired token must not resolve';
  end if;
  update public.supplier_order_requests
  set upload_expires_at = now() + interval '30 days'
  where request_id = v_request_id;

  v_upload_path := v_order_request_id::text || '/20261023-' || repeat('b', 16) || '.pdf';
  v_upload := public.record_supplier_order_upload(
    repeat('a', 64), v_upload_path, 'phieu-giao-hang.pdf',
    'application/pdf', 1024, repeat('b', 64)
  );
  if (v_upload ->> 'count')::integer <> 1 then
    raise exception 'first upload count mismatch: %', v_upload;
  end if;

  -- Same sha256 is idempotent.
  v_upload := public.record_supplier_order_upload(
    repeat('a', 64), v_order_request_id::text || '/duplicate.pdf',
    'duplicate.pdf', 'application/pdf', 1024, repeat('b', 64)
  );
  if (v_upload ->> 'count')::integer <> 1 then
    raise exception 'duplicate sha256 changed the count: %', v_upload;
  end if;

  for v_i in 2..10 loop
    v_upload := public.record_supplier_order_upload(
      repeat('a', 64),
      v_order_request_id::text || '/file-' || v_i || '.pdf',
      'file-' || v_i || '.pdf',
      'application/pdf',
      1024,
      lpad(to_hex(v_i), 64, '0')
    );
    if (v_upload ->> 'count')::integer <> v_i then
      raise exception 'upload count mismatch at %: %', v_i, v_upload;
    end if;
  end loop;

  begin
    perform public.record_supplier_order_upload(
      repeat('a', 64),
      v_order_request_id::text || '/file-11.pdf',
      'file-11.pdf',
      'application/pdf',
      1024,
      lpad(to_hex(11), 64, '0')
    );
    raise exception '11th upload was accepted';
  exception when others then
    if sqlerrm not like '%upload_limit_reached%' then
      raise;
    end if;
  end;

  if (select image_url from public.purchase_orders where id = v_po_id) is not null then
    raise exception 'PO image_url must stay untouched by supplier uploads';
  end if;

  ------------------------------------------------------------------
  -- Permission gate
  ------------------------------------------------------------------
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_viewer::text, true);
  begin
    perform public.prepare_supplier_order(v_item_id);
    raise exception 'non-owner prepared a supplier order';
  exception when insufficient_privilege then
    null;
  end;
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('request.jwt.claim.sub', v_actor::text, true);

  raise notice 'supplier order email smoke passed';
end;
$smoke$;

rollback;
