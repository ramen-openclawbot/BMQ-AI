-- Tự gắn hoá đơn chính thức từ hoadon@ vào phiếu chi mua hàng.
--
-- Additive only. Migration này:
--   (a) thêm public.link_incoming_invoice_to_payment_request(uuid) — ghép một
--       hoá đơn đầu vào với đúng một phiếu chi chưa trả cùng NCC / số tiền /
--       cửa sổ ngày, gắn file vào phiếu chi như nhánh PO-link;
--   (b) định nghĩa lại public.ingest_incoming_invoice(jsonb), giữ nguyên mọi
--       nhánh trừ nhánh goods_supplier_po: gọi hàm ghép mới, lỗi thì để
--       needs_review và ghi sqlerrm vào ingest_note;
--   (c) thêm public.backfill_incoming_invoice_links() — chạy một lần bởi
--       Maestro sau khi review, không tự chạy trong migration;
--   (d) định nghĩa lại public.supplier_order_catalog(uuid), giữ nguyên toàn bộ
--       ngoại trừ thêm prepay.official_invoice lấy từ hoá đơn đã ghép.
--
-- Không duyệt, chi, từ chối hay đổi số tiền của bất kỳ phiếu nào.

-- ===========================================================================
-- 1. Ghép hoá đơn đầu vào với một phiếu chi đã có
-- ===========================================================================

create or replace function public.link_incoming_invoice_to_payment_request(p_invoice_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inv public.incoming_invoices%rowtype;
  v_pr public.payment_requests%rowtype;
  v_invoice_date date;
  v_candidate_count integer := 0;
  v_candidate_id uuid;
  v_candidate_numbers text[] := array[]::text[];
  v_note text;
begin
  if coalesce(public.material_master_jwt_role(), '') <> 'service_role' then
    raise exception 'not_authorized_invoice_link' using errcode = '42501';
  end if;

  select *
    into v_inv
  from public.incoming_invoices
  where id = p_invoice_id
  for update;

  if not found then
    raise exception 'incoming_invoice_not_found' using errcode = 'P0002';
  end if;

  -- Idempotent: đã có phiếu (tự lập hoặc đã ghép) thì không làm gì thêm.
  if v_inv.linked_payment_request_id is not null
     or v_inv.payment_request_id is not null
     or v_inv.supplier_id is null
     or v_inv.total_amount is null then
    return jsonb_build_object('status', 'skipped');
  end if;

  -- Hoá đơn không có ngày thì dùng ngày nạp làm mốc cửa sổ.
  v_invoice_date := coalesce(v_inv.invoice_date, v_inv.created_at::date);

  select count(*)::integer,
         (array_agg(pr.id order by pr.created_at desc, pr.id desc))[1],
         (array_agg(pr.request_number order by pr.created_at desc, pr.id desc))[1:3]
    into v_candidate_count, v_candidate_id, v_candidate_numbers
  from public.payment_requests pr
  where pr.supplier_id = v_inv.supplier_id
    and pr.status::text in ('pending', 'approved')
    and pr.payment_status::text in ('unpaid', 'partial')
    and round(pr.total_amount) = round(v_inv.total_amount)
    and pr.created_at::date between v_invoice_date - 45 and v_invoice_date + 10
    and not exists (
      select 1
      from public.incoming_invoices i
      where i.linked_payment_request_id = pr.id
        and i.id <> v_inv.id
    );

  if v_candidate_count = 1 then
    select *
      into v_pr
    from public.payment_requests
    where id = v_candidate_id
    for update;

    -- Gắn file y như nhánh PO-link; uploaded_by là người lập phiếu chi.
    if v_inv.file_path is not null
       and not exists (
         select 1
         from public.payment_request_attachments a
         where a.payment_request_id = v_pr.id
           and a.storage_path = v_inv.file_path
       ) then
      insert into public.payment_request_attachments (
        payment_request_id,
        storage_path,
        file_name,
        mime_type,
        uploaded_by
      )
      values (
        v_pr.id,
        v_inv.file_path,
        coalesce(v_inv.file_name, regexp_replace(v_inv.file_path, '^.*/', '')),
        v_inv.file_mime,
        v_pr.created_by
      );
    end if;

    update public.incoming_invoices
       set linked_payment_request_id = v_pr.id,
           purchase_order_id = v_pr.purchase_order_id,
           status = 'matched',
           match_source = 'supplier_amount',
           match_confidence = 1,
           ingest_note = null
     where id = v_inv.id;

    return jsonb_build_object(
      'status', 'matched',
      'payment_request_id', v_pr.id,
      'request_number', v_pr.request_number
    );
  end if;

  if v_candidate_count = 0 then
    v_note := 'Chưa tìm thấy phiếu chi chưa trả cùng NCC và số tiền';
  else
    v_note := 'Nhiều phiếu chi khớp: '
      || array_to_string(coalesce(v_candidate_numbers, array[]::text[]), ', ');
  end if;

  update public.incoming_invoices
     set status = 'needs_review',
         ingest_note = v_note
   where id = v_inv.id;

  return jsonb_build_object(
    'status', 'needs_review',
    'candidates', to_jsonb(coalesce(v_candidate_numbers, array[]::text[]))
  );
end;
$$;

revoke all on function public.link_incoming_invoice_to_payment_request(uuid)
  from public, anon, authenticated;
grant execute on function public.link_incoming_invoice_to_payment_request(uuid)
  to service_role;

-- ===========================================================================
-- 2. Nạp một hoá đơn đầu vào — giữ nguyên, chỉ thêm nhánh goods_supplier_po
-- ===========================================================================

create or replace function public.ingest_incoming_invoice(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source text;
  v_source_ref text;
  v_id uuid;
  v_inv public.incoming_invoices%rowtype;
  v_po uuid;
  v_supplier uuid;
  v_invoice_date date;
  v_period text;
  v_file_path text;
  v_file_name text;
  v_file_mime text;
  v_pr public.payment_requests%rowtype;
  v_match jsonb;
  v_create jsonb;
  v_error text;
begin
  if coalesce(public.material_master_jwt_role(), '') <> 'service_role' then
    raise exception 'not_authorized_invoice_ingest' using errcode = '42501';
  end if;

  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'invalid_invoice_payload' using errcode = 'P0001';
  end if;

  v_source := nullif(btrim(coalesce(p->>'source', '')), '');
  v_source_ref := nullif(btrim(coalesce(p->>'source_ref', '')), '');
  if v_source is null or v_source not in ('email', 'supplier_link') then
    raise exception 'invalid_invoice_source' using errcode = 'P0001';
  end if;
  if v_source_ref is null then
    raise exception 'invoice_source_ref_required' using errcode = 'P0001';
  end if;

  v_invoice_date := nullif(btrim(coalesce(p->>'invoice_date', '')), '')::date;
  v_period := coalesce(
    nullif(btrim(coalesce(p->>'period', '')), ''),
    case
      when v_invoice_date is not null
        then to_char(date_trunc('month', v_invoice_date), 'YYYY-MM')
      else null
    end
  );
  v_po := nullif(btrim(coalesce(p->>'purchase_order_id', '')), '')::uuid;
  v_supplier := nullif(btrim(coalesce(p->>'supplier_id', '')), '')::uuid;
  v_file_path := nullif(btrim(coalesce(p->>'file_path', '')), '');
  v_file_name := nullif(btrim(coalesce(p->>'file_name', '')), '');
  v_file_mime := nullif(btrim(coalesce(p->>'file_mime', '')), '');

  insert into public.incoming_invoices (
    source,
    source_ref,
    file_path,
    file_mime,
    file_name,
    seller_name,
    seller_tax_code,
    invoice_number,
    invoice_series,
    invoice_date,
    period,
    subtotal,
    vat_amount,
    total_amount,
    raw,
    supplier_id,
    purchase_order_id,
    note
  )
  values (
    v_source,
    v_source_ref,
    v_file_path,
    v_file_mime,
    v_file_name,
    nullif(btrim(coalesce(p->>'seller_name', '')), ''),
    nullif(btrim(coalesce(p->>'seller_tax_code', '')), ''),
    nullif(btrim(coalesce(p->>'invoice_number', '')), ''),
    nullif(btrim(coalesce(p->>'invoice_series', '')), ''),
    v_invoice_date,
    v_period,
    nullif(btrim(coalesce(p->>'subtotal', '')), '')::numeric,
    nullif(btrim(coalesce(p->>'vat_amount', '')), '')::numeric,
    nullif(btrim(coalesce(p->>'total_amount', '')), '')::numeric,
    coalesce(p->'raw', '{}'::jsonb),
    v_supplier,
    v_po,
    nullif(btrim(coalesce(p->>'note', '')), '')
  )
  on conflict (source_ref) do nothing
  returning id into v_id;

  -- Đã nạp trước đó: không đụng vào hóa đơn, phiếu chi hay file.
  if v_id is null then
    select *
      into v_inv
    from public.incoming_invoices
    where source_ref = v_source_ref;

    return jsonb_build_object(
      'id', v_inv.id,
      'status', v_inv.status,
      'match_source', v_inv.match_source,
      'payment_request_id', v_inv.payment_request_id,
      'linked_payment_request_id', v_inv.linked_payment_request_id,
      'needs_jev', false,
      'duplicate', true
    );
  end if;

  if v_po is not null then
    -- Nạp từ link NCC đã có PO: chỉ gắn file vào phiếu chi mới nhất còn hiệu lực.
    select pr.*
      into v_pr
    from public.payment_requests pr
    where pr.purchase_order_id = v_po
      and pr.status <> 'rejected'::public.payment_request_status
    order by pr.created_at desc, pr.id desc
    limit 1;

    if found then
      if v_file_path is not null
         and not exists (
           select 1
           from public.payment_request_attachments a
           where a.payment_request_id = v_pr.id
             and a.storage_path = v_file_path
         ) then
        insert into public.payment_request_attachments (
          payment_request_id,
          storage_path,
          file_name,
          mime_type,
          uploaded_by
        )
        values (
          v_pr.id,
          v_file_path,
          coalesce(v_file_name, regexp_replace(v_file_path, '^.*/', '')),
          v_file_mime,
          v_pr.created_by
        );
      end if;

      update public.incoming_invoices
         set linked_payment_request_id = v_pr.id,
             status = 'matched',
             match_source = 'po_link',
             ingest_note = null
       where id = v_id;
    else
      update public.incoming_invoices
         set status = 'needs_review',
             note = 'Chưa có đề nghị chi cho đơn mua hàng'
       where id = v_id;
    end if;
  else
    v_match := public.match_incoming_invoice(v_id);
    select *
      into v_inv
    from public.incoming_invoices
    where id = v_id;

    -- PDF/ảnh chưa đọc được tự động: không có số tiền thì luôn để chủ review,
    -- tuyệt đối không lập phiếu 0 đồng.
    if v_inv.total_amount is null then
      update public.incoming_invoices
         set status = 'needs_review'
       where id = v_id;
    elsif v_match->>'status' = 'matched'
       and coalesce(v_match->>'match_source', '') <> 'goods_supplier_po' then
      begin
        v_create := public.create_payment_request_from_invoice(v_id);
      exception
        when others then
          v_error := sqlerrm;
          update public.incoming_invoices
             set ingest_note = v_error,
                 status = 'needs_review'
           where id = v_id;
      end;
    elsif coalesce(v_match->>'match_source', '') = 'goods_supplier_po' then
      begin
        perform public.link_incoming_invoice_to_payment_request(v_id);
      exception
        when others then
          v_error := sqlerrm;
          update public.incoming_invoices
             set ingest_note = v_error,
                 status = 'needs_review'
           where id = v_id;
      end;
    end if;
  end if;

  select *
    into v_inv
  from public.incoming_invoices
  where id = v_id;

  return jsonb_build_object(
    'id', v_inv.id,
    'status', v_inv.status,
    'match_source', v_inv.match_source,
    'payment_request_id', v_inv.payment_request_id,
    'linked_payment_request_id', v_inv.linked_payment_request_id,
    'needs_jev', (
      v_inv.status = 'needs_review'
      and v_inv.match_source = 'amount_ambiguous'
      and v_inv.total_amount is not null
    )
  );
end;
$$;

revoke all on function public.ingest_incoming_invoice(jsonb)
  from public, anon, authenticated;
grant execute on function public.ingest_incoming_invoice(jsonb) to service_role;

-- ===========================================================================
-- 3. Backfill một lần cho hoá đơn needs_review đã có NCC + số tiền
-- ===========================================================================

create or replace function public.backfill_incoming_invoice_links()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_invoice record;
  v_result jsonb;
  v_status text;
  v_matched integer := 0;
  v_needs_review integer := 0;
  v_skipped integer := 0;
begin
  if coalesce(public.material_master_jwt_role(), '') <> 'service_role' then
    raise exception 'not_authorized_invoice_link_backfill' using errcode = '42501';
  end if;

  for v_invoice in
    select i.id
    from public.incoming_invoices i
    where i.linked_payment_request_id is null
      and i.payment_request_id is null
      and i.status = 'needs_review'
      and i.supplier_id is not null
      and i.total_amount is not null
    order by i.invoice_date, i.created_at, i.id
  loop
    v_result := public.link_incoming_invoice_to_payment_request(v_invoice.id);
    v_status := v_result->>'status';

    if v_status = 'matched' then
      v_matched := v_matched + 1;
    elsif v_status = 'needs_review' then
      v_needs_review := v_needs_review + 1;
    else
      v_skipped := v_skipped + 1;
    end if;
  end loop;

  return jsonb_build_object(
    'matched', v_matched,
    'needs_review', v_needs_review,
    'skipped', v_skipped
  );
end;
$$;

revoke all on function public.backfill_incoming_invoice_links()
  from public, anon, authenticated;
grant execute on function public.backfill_incoming_invoice_links()
  to service_role;

-- ===========================================================================
-- 4. Catalog đặt hàng — giữ nguyên, thêm prepay.official_invoice
-- ===========================================================================

create or replace function public.supplier_order_catalog(p_supplier_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_role_before text;
  v_supplier public.suppliers%rowtype;
  v_forecast jsonb;
  v_mailbox text;
  v_delivery jsonb;
  v_blockers jsonb := '[]'::jsonb;
  v_items jsonb := '[]'::jsonb;
  v_prepay jsonb;
  v_item record;
  v_fc jsonb;
  v_location text;
  v_estimated boolean;
  v_on_hand numeric;
  v_daily numeric;
  v_days_left numeric;
  v_last_count_date date;
  v_reorder_date date;
  v_suggested numeric;
  v_proposal numeric;
  v_price numeric;
  v_history_price numeric;
  v_unit_price numeric;
  v_unit_price_gross numeric;
  v_vat_rate numeric;
  v_product_name text;
  v_open_order jsonb;
  v_tan_tao_daily numeric;
  v_tan_tao_order_qty numeric;
  v_tan_tao_cycle_days numeric;
  v_tan_tao_lead_time_days integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
    if not (
      public.has_role(v_actor, 'owner')
      or public.has_module_permission(v_actor, 'supplier_orders', 'view')
      or public.has_module_permission(v_actor, 'supplier_orders', 'edit')
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  if p_supplier_id is null then
    raise exception 'supplier_required' using errcode = '22023';
  end if;

  select * into v_supplier
  from public.suppliers
  where id = p_supplier_id;
  if not found then
    raise exception 'supplier_not_found' using errcode = 'P0002';
  end if;

  v_role_before := current_setting('request.jwt.claim.role', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  v_forecast := public.get_q7_purchase_forecast(v_today, 14);
  perform set_config('request.jwt.claim.role', coalesce(v_role_before, ''), true);

  select jsonb_build_object(
    'address', coalesce(max(value) filter (where key = 'order_email_delivery_address'), ''),
    'contact_name', coalesce(max(value) filter (where key = 'order_email_contact_name'), ''),
    'contact_phone', coalesce(max(value) filter (where key = 'order_email_contact_phone'), ''),
    'note', coalesce(max(value) filter (where key = 'order_email_note'), '')
  )
  into v_delivery
  from public.app_settings
  where key in (
    'order_email_delivery_address',
    'order_email_contact_name',
    'order_email_contact_phone',
    'order_email_note'
  );

  select value into v_mailbox
  from public.app_settings
  where key = 'order_gmail_connected_email';

  if nullif(btrim(coalesce(v_supplier.email, '')), '') is null then
    v_blockers := v_blockers || jsonb_build_array('no_supplier_email');
  end if;
  if lower(btrim(coalesce(v_mailbox, ''))) <> 'order@bmq.vn' then
    v_blockers := v_blockers || jsonb_build_array('mailbox_not_connected');
  end if;

  for v_item in
    select
      c.id as catalog_id,
      c.kitchen_inventory_item_id,
      c.product_name,
      c.po_unit,
      c.po_unit_factor,
      c.pack_size_po,
      c.vat_rate,
      c.list_price,
      c.list_price_includes_vat,
      c.list_price_source,
      c.list_price_updated_at,
      kii.name as item_name,
      kii.item_code,
      kii.unit as item_unit,
      case
        when coalesce(kii.pastry_q7, false) then 'q7'
        when wl.kitchen_inventory_item_id is not null then 'tan_tao'
        when coalesce(kii.in_tan_tao, false) then 'tan_tao'
        else 'q7'
      end as location,
      wl.learned_daily_usage,
      wl.learned_order_qty,
      wl.learned_cycle_days,
      wl.learned_lead_time_days
    from public.supplier_order_catalog_items c
    join public.kitchen_inventory_items kii
      on kii.id = c.kitchen_inventory_item_id
    left join public.warehouse_item_learning wl
      on wl.location = 'tan_tao'
     and wl.kitchen_inventory_item_id = c.kitchen_inventory_item_id
    where c.supplier_id = p_supplier_id
      and c.active
    order by c.sort_order, c.created_at, c.id
  loop
    v_location := v_item.location;
    v_estimated := v_location = 'tan_tao';

    if v_estimated then
      -- Tân Tạo stock source: the same movement sum used by the Tân Tạo
      -- warehouse snapshot / stock-count sheet (tan_tao_material_movements).
      -- No Tân Tạo movement at all means stock is unknown, not zero.
      select case when count(*) = 0 then null else sum(case m.movement_type
                            when 'receipt' then m.quantity
                            when 'opening' then m.quantity
                            when 'production_usage' then -m.quantity
                            when 'adjustment' then m.quantity
                            when 'transfer_out' then -m.quantity
                            else 0
                          end) end
      into v_on_hand
      from public.tan_tao_material_movements m
      where m.kitchen_inventory_item_id = v_item.kitchen_inventory_item_id
        and m.movement_date <= v_today;

      v_tan_tao_daily := coalesce(v_item.learned_daily_usage, 0);
      v_tan_tao_order_qty := v_item.learned_order_qty;
      v_tan_tao_cycle_days := v_item.learned_cycle_days;
      v_tan_tao_lead_time_days := v_item.learned_lead_time_days;
      v_daily := v_tan_tao_daily;

      if v_on_hand is not null and v_daily > 0 then
        v_days_left := round(v_on_hand / v_daily, 1);
      else
        v_days_left := null;
      end if;

      if v_on_hand is not null
         and (
           v_on_hand <= 0
           or (
             v_days_left is not null
             and v_days_left <= coalesce(v_tan_tao_lead_time_days, 7)
           )
         ) then
        v_suggested := coalesce(v_tan_tao_order_qty, 0);
      else
        v_suggested := 0;
      end if;

      v_last_count_date := null;
      v_reorder_date := case
        when v_days_left is not null and v_tan_tao_lead_time_days is not null
          then v_today + greatest(
            0,
            floor(v_days_left - v_tan_tao_lead_time_days)
          )::integer
        else null
      end;
    else
      -- Q7 branch: byte-for-byte the previous read path.
      select e.value into v_fc
      from jsonb_array_elements(coalesce(v_forecast -> 'items', '[]'::jsonb)) e
      where e.value ->> 'item_id' = v_item.kitchen_inventory_item_id::text
      limit 1;

      v_on_hand := nullif(v_fc ->> 'on_hand', '')::numeric;
      v_daily := coalesce(nullif(v_fc ->> 'daily_usage', '')::numeric, 0);
      v_suggested := coalesce(nullif(v_fc ->> 'suggested_qty', '')::numeric, 0);
      v_last_count_date := nullif(v_fc ->> 'last_count_date', '')::date;
      v_reorder_date := nullif(v_fc ->> 'reorder_date', '')::date;

      if v_on_hand is not null and v_daily > 0 then
        v_days_left := round(v_on_hand / v_daily, 1);
      else
        v_days_left := null;
      end if;

      v_tan_tao_daily := null;
      v_tan_tao_order_qty := null;
      v_tan_tao_cycle_days := null;
      v_tan_tao_lead_time_days := null;
    end if;

    if v_suggested > 0 and v_item.po_unit_factor > 0 then
      v_proposal := v_suggested / v_item.po_unit_factor;
      if v_item.pack_size_po is not null and v_item.pack_size_po > 0 then
        v_proposal := ceil(v_proposal / v_item.pack_size_po) * v_item.pack_size_po;
      else
        v_proposal := ceil(v_proposal);
      end if;
      v_proposal := round(v_proposal, 3);
    else
      v_proposal := 0;
    end if;

    v_price := public.supplier_order_line_price(
      p_supplier_id, v_item.kitchen_inventory_item_id
    );
    v_history_price := case
      when v_price is not null then round(v_price * v_item.po_unit_factor, 2)
      else null
    end;
    v_vat_rate := coalesce(v_item.vat_rate, 0);

    if v_item.list_price is not null then
      if coalesce(v_item.list_price_includes_vat, false) then
        v_unit_price := round(
          v_item.list_price / (1 + v_vat_rate / 100), 2
        );
        v_unit_price_gross := v_item.list_price;
      else
        v_unit_price := v_item.list_price;
        v_unit_price_gross := round(
          v_unit_price * (1 + v_vat_rate / 100), 2
        );
      end if;
    else
      v_unit_price := v_history_price;
      v_unit_price_gross := case
        when v_unit_price is not null then round(
          v_unit_price * (1 + v_vat_rate / 100), 2
        )
        else null
      end;
    end if;

    v_product_name := nullif(btrim(coalesce(v_item.product_name, '')), '');
    if v_product_name is null then
      select poi.product_name
      into v_product_name
      from public.purchase_order_items poi
      join public.purchase_orders po on po.id = poi.purchase_order_id
      join lateral (
        select a.*
        from public.stock_material_aliases a
        where a.kitchen_inventory_item_id = v_item.kitchen_inventory_item_id
          and a.normalized_name = public.normalize_stock_item_name(poi.product_name)
          and (a.supplier_id = p_supplier_id or a.supplier_id is null)
        order by (a.supplier_id is not null) desc, a.created_at asc, a.id asc
        limit 1
      ) a on true
      where po.supplier_id = p_supplier_id
      order by po.order_date desc, poi.created_at desc
      limit 1;
    end if;
    if nullif(btrim(coalesce(v_product_name, '')), '') is null then
      v_product_name := v_item.item_name;
    end if;

    select jsonb_build_object(
      'po_number', po.po_number,
      'quantity', coalesce(l.quantity, r.quantity),
      'unit', coalesce(l.unit, r.unit),
      'sent_at', r.sent_at
    )
    into v_open_order
    from public.supplier_order_requests r
    join public.purchase_orders po on po.id = r.purchase_order_id
    left join public.supplier_order_request_lines l
      on l.request_id = r.id
     and l.kitchen_inventory_item_id = v_item.kitchen_inventory_item_id
    where r.status = 'sent'
      and (
        r.kitchen_inventory_item_id = v_item.kitchen_inventory_item_id
        or l.id is not null
      )
      and not exists (
        select 1 from public.goods_receipts gr
        where gr.purchase_order_id = po.id
          and gr.status in ('confirmed', 'received')
      )
    order by r.sent_at desc nulls last, r.created_at desc, l.position nulls last
    limit 1;

    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'catalog_id', v_item.catalog_id,
      'item', jsonb_build_object(
        'id', v_item.kitchen_inventory_item_id,
        'name', v_item.item_name,
        'code', v_item.item_code,
        'unit', v_item.item_unit
      ),
      'product_name', v_product_name,
      'po_unit', v_item.po_unit,
      'po_unit_factor', v_item.po_unit_factor,
      'pack_size_po', v_item.pack_size_po,
      'vat_rate', v_item.vat_rate,
      'location', v_location,
      'estimated', v_estimated,
      'stock', jsonb_build_object(
        'on_hand', v_on_hand,
        'daily_usage', v_daily,
        'days_left', v_days_left,
        'reorder_date', v_reorder_date,
        'last_count_date', v_last_count_date,
        'lead_time_days', case when v_estimated then v_tan_tao_lead_time_days else null end,
        'order_cycle_days', case when v_estimated then v_tan_tao_cycle_days else null end,
        'order_size', case when v_estimated then v_tan_tao_order_qty else null end
      ),
      'proposal_qty', v_proposal,
      'history_price', v_history_price,
      'list_price', v_item.list_price,
      'list_price_includes_vat', coalesce(v_item.list_price_includes_vat, false),
      'list_price_source', v_item.list_price_source,
      'list_price_updated_at', v_item.list_price_updated_at,
      'unit_price', v_unit_price,
      'unit_price_gross', v_unit_price_gross,
      'open_order', v_open_order
    ));
  end loop;

  select jsonb_build_object(
    'id', pr.id,
    'request_number', pr.request_number,
    'created_at', pr.created_at,
    'total_amount', pr.total_amount,
    'remaining', round(
      coalesce(pr.total_amount, 0) - coalesce((
        select sum(pa.amount)
        from public.payment_allocations pa
        where pa.payment_request_id = pr.id
      ), 0), 2),
    'po_number', po.po_number,
    'recent_submission', case
      when ps.id is null then null
      else jsonb_build_object(
        'submission_number', ps.submission_number,
        'created_at', ps.created_at
      )
    end,
    'official_invoice', (
      select jsonb_build_object(
        'invoice_number', i.invoice_number,
        'invoice_series', i.invoice_series,
        'invoice_date', i.invoice_date
      )
      from public.incoming_invoices i
      where i.linked_payment_request_id = pr.id
      order by i.created_at desc, i.id desc
      limit 1
    )
  )
  into v_prepay
  from public.payment_requests pr
  left join public.purchase_orders po on po.id = pr.purchase_order_id
  left join lateral (
    select s.id, s.submission_number, s.created_at
    from public.payment_submission_items psi
    join public.payment_submissions s on s.id = psi.submission_id
    where psi.payment_request_id = pr.id
      and s.created_at >= now() - interval '3 days'
    order by s.created_at desc
    limit 1
  ) ps on true
  where pr.supplier_id = p_supplier_id
    and pr.status::text in ('pending', 'approved')
    and pr.payment_status::text in ('unpaid', 'partial')
  -- Gối đầu pays the latest delivered order (owner 28/10: a new Nam Nguyễn order pays the
  -- 20/10 delivery, not a July request): newest unpaid request whose PO has a goods
  -- receipt first, then the newest unpaid request.
  order by exists (
             select 1 from public.goods_receipts gr
             where gr.purchase_order_id = pr.purchase_order_id
               and gr.status in ('confirmed', 'received')
           ) desc,
           pr.created_at desc, pr.id desc
  limit 1;

  return jsonb_build_object(
    'supplier', jsonb_build_object(
      'id', v_supplier.id,
      'name', btrim(v_supplier.name),
      'email', nullif(btrim(v_supplier.email), '')
    ),
    'delivery', v_delivery,
    'mailbox_connected', lower(btrim(coalesce(v_mailbox, ''))) = 'order@bmq.vn',
    'blockers', v_blockers,
    'items', v_items,
    'prepay', v_prepay
  );
end;
$$;


revoke all on function public.supplier_order_catalog(uuid) from public, anon;
grant execute on function public.supplier_order_catalog(uuid)
  to authenticated, service_role;
