-- KFM production guard: a KFM delivery day must reach 600 packs unless the
-- owner explicitly overrides, and re-planning can cancel the old KFM order in
-- the same transaction as the new one.

-- ---------------------------------------------------------------------------
-- Internal helpers (not callable by anon/authenticated).
-- ---------------------------------------------------------------------------

-- KFM identity: confirmed portal payload, Kingfood sender, or KFM PO numbering.
create or replace function public.kfm_is_kfm_po(p_inbox_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.customer_po_inbox i
    where i.id = p_inbox_id
      and (
        i.raw_payload->>'source' = 'kfm_portal'
        or position('kingfood' in lower(coalesce(i.from_name, ''))) > 0
        or position('kingfood' in lower(coalesce(i.from_email, ''))) > 0
        or coalesce(i.po_number, '') ~ '^PO100[0-9]+$'
      )
  );
$$;

-- Packs on one order. ordered_qty is the ordered amount; planned_qty is only a
-- fallback for legacy rows where the ordered amount was never filled in.
create or replace function public.kfm_order_packs(p_order_id uuid)
returns numeric
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(sum(coalesce(i.ordered_qty, i.planned_qty, 0)), 0)
  from public.production_order_items i
  where i.production_order_id = p_order_id;
$$;

-- An order may only be cancelled/replaced while nothing downstream exists.
create or replace function public.production_order_cancellable(p_order_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.production_orders o
    where o.id = p_order_id
      and o.status::text not in ('completed', 'cancelled')
      and not exists (
        select 1 from public.kfm_daily_material_issue_sources s
        where s.production_order_id = o.id
      )
      and not exists (
        select 1 from public.warehouse_dispatches d
        where d.production_order_id = o.id
      )
      and coalesce((
        select sum(i.actual_qty)
        from public.production_order_items i
        where i.production_order_id = o.id
      ), 0) = 0
  );
$$;

-- ---------------------------------------------------------------------------
-- Read-only preflight used by the create-order dialog.
-- ---------------------------------------------------------------------------

create or replace function public.kfm_production_preflight(
  p_po_id uuid,
  p_start_date date,
  p_items jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_is_kfm boolean;
  v_delivery date := coalesce(p_start_date, (now() at time zone 'Asia/Ho_Chi_Minh')::date);
  v_new_packs numeric := 0;
  v_other_packs numeric := 0;
  v_total_packs numeric := 0;
  v_existing jsonb := '[]'::jsonb;
begin
  if auth.uid() is null or not public.can_edit_production_q7() then
    raise exception 'Q7 edit permission required' using errcode = '42501';
  end if;

  v_is_kfm := public.kfm_is_kfm_po(p_po_id);

  if jsonb_typeof(p_items) = 'array' then
    select coalesce(sum(coalesce(
      nullif(x->>'original_qty', '')::numeric,
      nullif(x->>'quantity', '')::numeric,
      nullif(x->>'planned_qty', '')::numeric,
      0
    )), 0)
    into v_new_packs
    from jsonb_array_elements(p_items) x;
  end if;

  if v_is_kfm then
    select
      coalesce(jsonb_agg(
        jsonb_build_object(
          'id', o.id,
          'production_number', o.production_number,
          'po_number', po.po_number,
          'packs', public.kfm_order_packs(o.id),
          'cancellable', public.production_order_cancellable(o.id)
        )
        order by o.production_number
      ), '[]'::jsonb),
      coalesce(sum(public.kfm_order_packs(o.id)), 0)
    into v_existing, v_other_packs
    from public.production_orders o
    join public.customer_po_inbox po on po.id = o.source_po_inbox_id
    where o.planned_start_date = v_delivery
      and o.status::text <> 'cancelled'
      and o.source_po_inbox_id is distinct from p_po_id
      and public.kfm_is_kfm_po(po.id);
  end if;

  v_total_packs := v_other_packs + v_new_packs;

  return jsonb_build_object(
    'is_kfm', v_is_kfm,
    'delivery_date', v_delivery,
    'min_packs', 600,
    'new_packs', v_new_packs,
    'existing', v_existing,
    'other_packs', v_other_packs,
    'total_packs', v_total_packs,
    'below_min', v_is_kfm and v_total_packs < 600
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Create (or reuse) the Q7 production order for a PO. The replacement and the
-- new order run in the same function transaction: a failed MOQ check rolls the
-- cancellation back as well.
-- ---------------------------------------------------------------------------

drop function if exists public.create_q7_production_from_po(uuid, date, date, text, jsonb);

create or replace function public.create_q7_production_from_po(
  p_po_id uuid,
  p_start_date date,
  p_end_date date,
  p_notes text,
  p_items jsonb,
  p_replace_order_ids uuid[] default null,
  p_override_min boolean default false
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_po public.customer_po_inbox%rowtype;
  v_order public.production_orders%rowtype;
  v_item jsonb;
  v_sku public.product_skus%rowtype;
  v_date date := coalesce(p_start_date, (now() at time zone 'Asia/Ho_Chi_Minh')::date);
  v_prefix text;
  v_sequence integer;
  v_replace_id uuid;
  v_replace public.production_orders%rowtype;
  v_new_packs numeric := 0;
  v_other_packs numeric := 0;
  v_total_packs numeric := 0;
  v_vn_date text := to_char(now() at time zone 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY');
begin
  if auth.uid() is null or not public.can_edit_production_q7() then
    raise exception 'Q7 edit permission required' using errcode = '42501';
  end if;
  select * into v_po from public.customer_po_inbox where id = p_po_id for update;
  if not found then raise exception 'Source PO not found'; end if;
  select * into v_order from public.production_orders where source_po_inbox_id = p_po_id;
  if found then
    if not exists(select 1 from public.production_order_items where production_order_id = v_order.id) then
      raise exception 'Existing production order has no items; review it before continuing';
    end if;
    return jsonb_build_object('order', to_jsonb(v_order), 'reused', true);
  end if;
  if v_po.match_status not in ('approved', 'pending_approval') or v_po.match_status is null then
    raise exception 'Source PO is not approved for production';
  end if;
  if v_po.match_status <> 'approved' and (
    lower(coalesce(v_po.from_email,'')) ~ '@([a-z0-9-]+\.)?kingfoodmart\.com$'
    or v_po.revenue_channel in ('cake_kingfoodmart','wholesale_kfm')
    or v_po.raw_payload #>> '{po_automation,rule}' = 'kingfood_po_automation'
    or exists(select 1 from public.mini_crm_customers c where c.id=v_po.matched_customer_id
      and (lower(c.customer_code)='b2b-kfm' or lower(c.customer_name) ~ 'king[[:space:]]*food|\mkfm\M'))
  ) then
    raise exception 'KFM PO must be confirmed through portal intake first';
  end if;
  if v_po.raw_payload->>'source' = 'kfm_portal' and not exists(
    select 1 from public.kfm_po_intake_attempts a
    where a.inbox_id=p_po_id and a.state='imported' and a.decision='confirm'
  ) then
    raise exception 'KFM confirmation has not been verified';
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Production items are required';
  end if;
  if jsonb_array_length(p_items) > 500 or p_end_date < v_date then
    raise exception 'Invalid production plan';
  end if;
  if v_po.raw_payload->>'source' = 'kfm_portal'
    and jsonb_array_length(p_items) is distinct from jsonb_array_length(v_po.production_items) then
    raise exception 'The complete confirmed portal PO is required';
  end if;
  if exists(select 1 from jsonb_array_elements(p_items) x group by x->>'sku_id' having count(*)>1) then
    raise exception 'Duplicate production SKU';
  end if;
  -- Validate the entire plan before inserting a header. Quantities may be
  -- adjusted by staff, but must be finite/nonnegative and use enabled Q7 SKUs.
  for v_item in select value from jsonb_array_elements(p_items) loop
    select s.* into v_sku from public.product_skus s
      join public.production_location_sku_settings q on q.sku_id=s.id
      where s.id=(v_item->>'sku_id')::uuid and q.location_code='q7' and q.is_enabled;
    if not found then raise exception 'SKU is not enabled for Q7'; end if;
    if v_po.raw_payload->>'source' = 'kfm_portal' and not exists(
      select 1 from jsonb_array_elements(v_po.production_items) source_item
      where (source_item->>'sku_id'=v_sku.id::text or
        (source_item->>'sku_id' is null and upper(trim(coalesce(source_item->>'sku_code',source_item->>'sku'))) = upper(trim(v_sku.sku_code))))
        and (source_item->>'qty')::numeric = (v_item->>'original_qty')::numeric
        and (source_item->>'date')::date = (v_item->>'date')::date
    ) then
      raise exception 'Production item does not match the confirmed portal PO';
    end if;
    if coalesce(v_item->>'product_name','') = '' or coalesce(v_item->>'unit','') = ''
      or coalesce(v_item->>'planned_qty','') !~ '^([0-9]+([.][0-9]+)?|[.][0-9]+)$'
      or coalesce(v_item->>'original_qty','') !~ '^([0-9]+([.][0-9]+)?|[.][0-9]+)$'
      or (v_item->>'planned_qty')::numeric > 999999999999
      or (v_item->>'original_qty')::numeric > 999999999999 then
      raise exception 'Invalid production item';
    end if;
  end loop;

  -- KFM: validate and cancel the explicitly replaced orders first, then count
  -- every still-active KFM order on this delivery day plus the new packs.
  if public.kfm_is_kfm_po(p_po_id) then
    if p_replace_order_ids is not null then
      for v_replace_id in
        select distinct t.replace_id
        from unnest(p_replace_order_ids) as t(replace_id)
      loop
        if v_replace_id is null then
          raise exception 'production_replace_invalid' using errcode = '22023';
        end if;
        select * into v_replace from public.production_orders
        where id = v_replace_id
        for update;
        if not found
          or v_replace.source_po_inbox_id is null
          or v_replace.source_po_inbox_id = p_po_id
          or v_replace.planned_start_date is distinct from v_date
          or not public.kfm_is_kfm_po(v_replace.source_po_inbox_id)
          or not public.production_order_cancellable(v_replace.id) then
          raise exception 'production_replace_invalid' using errcode = '22023';
        end if;
        update public.production_orders
        set status = 'cancelled',
            notes = coalesce(notes, '') || ' [Thay bằng PO ' ||
              coalesce(v_po.po_number, '') || ' ' || v_vn_date || ']',
            updated_at = now()
        where id = v_replace_id;
      end loop;
    end if;

    select coalesce(sum(coalesce(
      nullif(x->>'original_qty', '')::numeric,
      nullif(x->>'quantity', '')::numeric,
      nullif(x->>'planned_qty', '')::numeric,
      0
    )), 0)
    into v_new_packs
    from jsonb_array_elements(p_items) x;

    select coalesce(sum(public.kfm_order_packs(o.id)), 0)
    into v_other_packs
    from public.production_orders o
    join public.customer_po_inbox po on po.id = o.source_po_inbox_id
    where o.planned_start_date = v_date
      and o.status::text <> 'cancelled'
      and o.source_po_inbox_id is distinct from p_po_id
      and public.kfm_is_kfm_po(po.id);

    v_total_packs := v_other_packs + v_new_packs;
    if v_total_packs < 600
      and not (coalesce(p_override_min, false) and public.has_role(auth.uid(), 'owner')) then
      raise exception 'kfm_below_min_packs: Thiếu % gói (tổng %/600). KFM không giao.',
        600 - v_total_packs, v_total_packs
        using errcode = 'P0001';
    end if;
  end if;

  v_prefix := 'SX-' || to_char(v_date,'YYYYMMDD') || '-';
  perform pg_advisory_xact_lock(hashtextextended('q7-production-number:'||v_prefix,0));
  select coalesce(max(substring(production_number from length(v_prefix)+1)::integer),0)+1
    into v_sequence from public.production_orders
    where production_number like v_prefix||'%' and substring(production_number from length(v_prefix)+1) ~ '^[0-9]+$';
  insert into public.production_orders(production_number, source_po_inbox_id, status, location_code,
    planned_start_date, planned_end_date, notes, created_by)
    values(v_prefix||lpad(v_sequence::text, greatest(3,length(v_sequence::text)), '0'), p_po_id, 'planned', 'q7',
      v_date, p_end_date, nullif(p_notes,''), auth.uid()) returning * into v_order;
  insert into public.production_order_items(production_order_id,sku_id,product_name,ordered_qty,planned_qty,unit,delivery_date,notes)
    select v_order.id,s.id,s.product_name,(x->>'original_qty')::numeric,
      (x->>'planned_qty')::numeric,coalesce(nullif(s.unit,''),
        case when v_po.raw_payload->>'source'='kfm_portal' then
          (select source_item->>'unit' from jsonb_array_elements(v_po.production_items) source_item
            where source_item->>'sku_id'=s.id::text or
              (source_item->>'sku_id' is null and upper(trim(coalesce(source_item->>'sku_code',source_item->>'sku'))) = upper(trim(s.sku_code))) limit 1)
          else x->>'unit' end),nullif(x->>'date','')::date,
      case when (x->>'planned_qty')::numeric != (x->>'original_qty')::numeric
        then 'Đã điều chỉnh số lượng trước khi xác nhận' else null end
    from jsonb_array_elements(p_items) x join public.product_skus s on s.id=(x->>'sku_id')::uuid;
  return jsonb_build_object('order',to_jsonb(v_order),'reused',false);
end;
$$;

-- ---------------------------------------------------------------------------
-- Safe manual cancellation used by the replacement dialog.
-- ---------------------------------------------------------------------------

create or replace function public.cancel_production_order(
  p_order_id uuid,
  p_reason text
) returns jsonb
language plpgsql security definer set search_path = public
as $$
declare
  v_order public.production_orders%rowtype;
  v_reason text := left(btrim(coalesce(p_reason, '')), 300);
begin
  if auth.uid() is null or not public.can_edit_production_q7() then
    raise exception 'Q7 edit permission required' using errcode = '42501';
  end if;

  select * into v_order
  from public.production_orders
  where id = p_order_id
  for update;

  if not found or not public.production_order_cancellable(p_order_id) then
    raise exception 'production_not_cancellable' using errcode = '22023';
  end if;

  update public.production_orders
  set status = 'cancelled',
      notes = case
        when v_reason = '' then notes
        else concat_ws(E'\n', nullif(notes, ''), v_reason)
      end,
      updated_at = now()
  where id = p_order_id
  returning * into v_order;

  return jsonb_build_object('order', to_jsonb(v_order));
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges: public RPCs for authenticated users only; helpers stay internal.
-- ---------------------------------------------------------------------------

revoke all on function public.kfm_is_kfm_po(uuid) from public, anon, authenticated;
revoke all on function public.kfm_order_packs(uuid) from public, anon, authenticated;
revoke all on function public.production_order_cancellable(uuid) from public, anon, authenticated;

revoke all on function public.kfm_production_preflight(uuid, date, jsonb) from public, anon;
grant execute on function public.kfm_production_preflight(uuid, date, jsonb) to authenticated;

revoke all on function public.create_q7_production_from_po(uuid, date, date, text, jsonb, uuid[], boolean) from public, anon;
grant execute on function public.create_q7_production_from_po(uuid, date, date, text, jsonb, uuid[], boolean) to authenticated;

revoke all on function public.cancel_production_order(uuid, text) from public, anon;
grant execute on function public.cancel_production_order(uuid, text) to authenticated;
