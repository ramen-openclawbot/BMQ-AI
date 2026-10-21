-- 2026-10-22 — Kho: đổi đơn vị (thêm đơn vị mới) và sửa quy đổi từng món,
-- có điều chỉnh sổ tồn.
--
-- Backend + data layer only; the per-row edit dialog is built by the Maestro.
-- Additive and idempotent. This migration:
--   A. adds source 'unit_factor_fix' to both stock ledgers (keeping every
--      existing source value) and adds the two replay actions to
--      warehouse_game_requests;
--   B. stores one saved conversion factor per (item, receipt unit);
--   C. keeps an append-only audit trail for unit / factor changes;
--   D. lists the item units (base weight, base volume, every count unit);
--   E. adds a brand-new count unit to public.stock_units, replay-safe;
--   F. reads every stock alias of one item grouped by receipt unit, with the
--      factor disagreements, the auto-converting units, the delivery-note line
--      counts and the already-posted counts;
--   G. previews / saves one factor for an item + receipt unit, updating the
--      matching aliases and appending a correction movement for every receipt
--      line already posted (replay-safe).
--
-- No DELETE anywhere. No write to goods_receipt_items, goods_receipts or any
-- document table. post_stock_goods_receipt_item, change_stock_item_unit and
-- kho_save_item keep their current bodies. The Maestro applies this migration;
-- Harness does not.

-- ===========================================================================
-- A. Ledger sources + replay actions
-- ===========================================================================

-- Latest definitions: 20261026100000_central_warehouse_flow.sql (Q7) and
-- 20261101440000_tan_tao_pate_recipe_production.sql (Tân Tạo). Every previous
-- value is kept exactly; only 'unit_factor_fix' is appended.
alter table public.q7_inventory_movements
  drop constraint if exists q7_inventory_movements_source_check;
alter table public.q7_inventory_movements
  add constraint q7_inventory_movements_source_check
  check (source in (
    'manual_receipt', 'signed_q7_issue', 'manual_adjustment',
    'goods_receipt', 'production_material_issue', 'production_material_issue_reversal',
    'item_merge', 'item_merge_revert', 'stock_transfer', 'unit_factor_fix'
  ));

alter table public.tan_tao_material_movements
  drop constraint if exists tan_tao_material_movements_source_check;
alter table public.tan_tao_material_movements
  add constraint tan_tao_material_movements_source_check
  check (source in (
    'goods_receipt', 'manual_adjustment', 'item_merge', 'item_merge_revert',
    'stock_transfer', 'production', 'unit_factor_fix'
  ));

-- Latest definition: 20261102500000_kho_two_jobs.sql. The two new actions are
-- the replay keys of kho_add_stock_unit / kho_set_item_conversion.
alter table public.warehouse_game_requests
  drop constraint if exists warehouse_game_requests_action_check;
alter table public.warehouse_game_requests
  add constraint warehouse_game_requests_action_check
  check (action in (
    'rename', 'change_unit', 'set_item_pastry_q7', 'kho_save_item',
    'kho_add_unit', 'kho_set_conversion'
  ));

-- ===========================================================================
-- B. One saved factor per item + receipt unit
-- ===========================================================================

create table if not exists public.stock_item_unit_factors (
  id uuid primary key default gen_random_uuid(),
  kitchen_inventory_item_id uuid not null references public.kitchen_inventory_items(id) on delete restrict,
  unit text not null,
  factor numeric not null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (kitchen_inventory_item_id, unit),
  constraint stock_item_unit_factors_unit_check check (btrim(unit) <> ''),
  constraint stock_item_unit_factors_factor_check check (
    factor > 0
    and factor::text not in ('NaN', 'Infinity', '-Infinity')
  )
);

-- `on conflict (kitchen_inventory_item_id, unit)` needs this index even when the
-- table was created by an earlier partial run.
create unique index if not exists stock_item_unit_factors_item_unit_uidx
  on public.stock_item_unit_factors(kitchen_inventory_item_id, unit);

alter table public.stock_item_unit_factors enable row level security;

drop policy if exists stock_item_unit_factors_select on public.stock_item_unit_factors;
create policy stock_item_unit_factors_select on public.stock_item_unit_factors
  for select to authenticated using (true);

revoke all on table public.stock_item_unit_factors from public, anon, authenticated;
grant select on table public.stock_item_unit_factors to authenticated, service_role;

-- ===========================================================================
-- C. Append-only audit trail (no client access; written by SECURITY DEFINER)
-- ===========================================================================

create table if not exists public.stock_unit_events (
  id uuid primary key default gen_random_uuid(),
  action text not null,
  unit text,
  item_id uuid,
  details jsonb,
  actor uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_stock_unit_events_item
  on public.stock_unit_events(item_id, created_at desc, id desc);

alter table public.stock_unit_events enable row level security;

revoke all on table public.stock_unit_events from public, anon, authenticated;

-- ===========================================================================
-- D. kho_get_units — the units an item may be counted in
-- ===========================================================================

create or replace function public.kho_get_units()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'code', u.code,
        'label', u.label,
        'kind', u.kind,
        'base_code', u.base_code,
        'to_base', u.to_base
      )
      order by case u.kind
                 when 'weight' then 0
                 when 'volume' then 1
                 else 2
               end,
               u.label
    ),
    '[]'::jsonb
  )
  from public.stock_units u
  where u.code = u.base_code;
$$;

revoke all on function public.kho_get_units() from public, anon;
grant execute on function public.kho_get_units() to authenticated, service_role;

-- ===========================================================================
-- E. kho_add_stock_unit — add a new count unit, replay-safe
-- ===========================================================================

create or replace function public.kho_add_stock_unit(
  p_label text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  -- btrim, lower and collapse every whitespace run to one space.
  v_clean text := lower(
    btrim(regexp_replace(coalesce(p_label, ''), '[[:space:]]+', ' ', 'g'))
  );
  v_base text;
  v_cached jsonb;
  v_result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not public.kho_item_can_edit(v_actor) then
      raise exception 'unit_forbidden' using errcode = '42501';
    end if;
  end if;

  -- 1-16 characters, unicode letters and single spaces only. Digits,
  -- punctuation and symbols are rejected instead of being silently stripped.
  if v_clean = ''
     or char_length(v_clean) > 16
     or v_clean !~ '^[[:alpha:] ]+$' then
    raise exception 'unit_label_invalid' using errcode = '22023';
  end if;

  -- Replay before the "already known" check: after the first call the unit
  -- exists, so a retry must still return the stored {status:'created'}.
  if p_request_id is not null then
    perform pg_advisory_xact_lock(hashtext('warehouse_game:' || p_request_id::text));
    select r.result into v_cached
    from public.warehouse_game_requests r
    where r.request_id = p_request_id
      and r.action = 'kho_add_unit';
    if found then
      return v_cached;
    end if;
  end if;

  -- A spelling the catalog already knows is not a new unit.
  v_base := public.normalize_stock_unit(v_clean);
  if v_base is not null then
    return jsonb_build_object('status', 'exists', 'unit', v_base);
  end if;

  -- Weight / volume spellings that the catalog does not know yet: adding them
  -- as a count unit would be wrong, so the owner must use g / ml / kg / l.
  if v_clean = any (array['kilo', 'gram', 'gam', 'lit', 'lít', 'mililit', 'cc']) then
    raise exception 'unit_is_measure' using errcode = '22023';
  end if;

  insert into public.stock_units (code, label, kind, base_code, to_base)
  values (v_clean, v_clean, 'count', v_clean, 1)
  on conflict (code) do nothing;

  if not found then
    -- A concurrent request created the same code first. No audit / replay row:
    -- this call did not create anything.
    return jsonb_build_object(
      'status', 'exists',
      'unit', coalesce(public.normalize_stock_unit(v_clean), v_clean)
    );
  end if;

  -- stock_unit_code() already resolves a new row through its code / label, so
  -- no alias row is needed. (Aliases map a different spelling to a code.)

  insert into public.stock_unit_events (action, unit, item_id, details, actor)
  values (
    'add_unit',
    v_clean,
    null,
    jsonb_build_object('label', v_clean, 'kind', 'count', 'base_code', v_clean),
    v_actor
  );

  v_result := jsonb_build_object('status', 'created', 'unit', v_clean);

  if p_request_id is not null then
    insert into public.warehouse_game_requests (request_id, action, item_id, result, created_by)
    values (p_request_id, 'kho_add_unit', null, v_result, v_actor)
    on conflict (request_id) do nothing;
  end if;

  return v_result;
end;
$$;

revoke all on function public.kho_add_stock_unit(text, uuid) from public, anon;
grant execute on function public.kho_add_stock_unit(text, uuid) to authenticated, service_role;

-- ===========================================================================
-- F. kho_get_item_conversions — every stock alias grouped by receipt unit
-- ===========================================================================

create or replace function public.kho_get_item_conversions(p_item_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_item public.kitchen_inventory_items%rowtype;
  v_conversions jsonb;
  v_saved jsonb;
begin
  -- Same reader rule as kho_get_items(); service_role skips the actor gate.
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then
      raise exception 'actor_required' using errcode = '42501';
    end if;
    if not (
      public.q7_material_inventory_can_view(v_actor)
      or public.stock_count_can_view('tan_tao')
      or public.stock_count_can_view('q7')
      or public.kho_item_can_edit(v_actor)
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  select * into v_item
  from public.kitchen_inventory_items k
  where k.id = p_item_id;
  if not found then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;

  with alias_rows as (
    select
      a.id,
      a.location,
      a.supplier_id,
      a.normalized_name,
      a.unit,
      a.conversion_factor,
      public.normalize_document_unit(
        coalesce(nullif(btrim(a.pack_label), ''), a.unit)
      ) as group_unit,
      coalesce(nullif(btrim(a.pack_label), ''), a.unit) as display_unit
    from public.stock_material_aliases a
    where a.kitchen_inventory_item_id = p_item_id
      and a.line_class = 'stock'
      and public.normalize_document_unit(
            coalesce(nullif(btrim(a.pack_label), ''), a.unit)
          ) is not null
  ),
  matched_lines as (
    select distinct
      ar.group_unit,
      gri.id as line_id,
      gr.receipt_date,
      exists (
        select 1 from public.q7_inventory_movements m
        where m.source = 'goods_receipt'
          and m.source_ref_key = 'gr-item:' || gri.id::text
          and m.kitchen_inventory_item_id = p_item_id
        union all
        select 1 from public.tan_tao_material_movements m
        where m.source = 'goods_receipt'
          and m.source_ref_key = 'gr-item:' || gri.id::text
          and m.kitchen_inventory_item_id = p_item_id
      ) as posted
    from alias_rows ar
    join public.goods_receipts gr
      on gr.supplier_id is not distinct from ar.supplier_id
    left join public.suppliers s on s.id = gr.supplier_id
    join public.goods_receipt_items gri on gri.goods_receipt_id = gr.id
    where ar.location = coalesce(gr.receiving_location, s.default_receiving_location, 'tan_tao')
      and gr.status in ('confirmed', 'received')
      and coalesce(s.stock_exempt, false) = false
      and public.stock_line_auto_non_stock(
            coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
          ) is null
      and ar.normalized_name = public.normalize_stock_item_name(
            coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
          )
  ),
  grouped as (
    select
      ar.group_unit,
      (
        select ar2.display_unit
        from alias_rows ar2
        where ar2.group_unit = ar.group_unit
        group by ar2.display_unit
        order by count(*) desc, ar2.display_unit
        limit 1
      ) as display_unit,
      array_agg(distinct ar.conversion_factor order by ar.conversion_factor) as factors,
      count(distinct ar.conversion_factor) as factor_count,
      count(*) as alias_count
    from alias_rows ar
    group by ar.group_unit
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'unit', g.display_unit,
        'factors', to_jsonb(g.factors),
        'disagree', g.factor_count > 1,
        'auto', public.stock_unit_line_factor(g.group_unit, v_item.unit) is not null,
        'alias_count', g.alias_count,
        'supplier_names', coalesce(
          (
            select jsonb_agg(names.name order by names.name)
            from (
              select distinct s.name
              from alias_rows ar
              left join public.suppliers s on s.id = ar.supplier_id
              where ar.group_unit = g.group_unit
                and s.name is not null
              order by s.name
              limit 5
            ) names
          ),
          '[]'::jsonb
        ),
        'line_count', coalesce(
          (
            select count(distinct ml.line_id)
            from matched_lines ml
            where ml.group_unit = g.group_unit
          ),
          0
        ),
        'posted_count', coalesce(
          (
            select count(distinct ml.line_id)
            from matched_lines ml
            where ml.group_unit = g.group_unit
              and ml.posted
          ),
          0
        ),
        'last_receipt_date', (
          select max(ml.receipt_date)
          from matched_lines ml
          where ml.group_unit = g.group_unit
        )
      )
      order by g.group_unit
    ),
    '[]'::jsonb
  )
  into v_conversions
  from grouped g;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'unit', f.unit,
        'factor', f.factor,
        'updated_at', f.updated_at
      )
      order by f.unit
    ),
    '[]'::jsonb
  )
  into v_saved
  from public.stock_item_unit_factors f
  where f.kitchen_inventory_item_id = p_item_id;

  return jsonb_build_object(
    'item', jsonb_build_object(
      'id', v_item.id,
      'name', v_item.name,
      'unit', v_item.unit,
      'in_q7', coalesce(v_item.pastry_q7, false)
    ),
    'can_edit', public.kho_item_can_edit(v_actor),
    'cutover', jsonb_build_object(
      'tan_tao', public.stock_ledger_cutover_date('tan_tao'),
      'q7', public.stock_ledger_cutover_date('q7')
    ),
    'conversions', v_conversions,
    'saved', v_saved
  );
end;
$$;

revoke all on function public.kho_get_item_conversions(uuid) from public, anon;
grant execute on function public.kho_get_item_conversions(uuid) to authenticated, service_role;

-- ===========================================================================
-- G. kho_set_item_conversion — preview / save one item + receipt-unit factor
-- ===========================================================================

create or replace function public.kho_set_item_conversion(
  p_item_id uuid,
  p_unit text,
  p_factor numeric,
  p_dry_run boolean,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_dry boolean := coalesce(p_dry_run, false);
  v_item public.kitchen_inventory_items%rowtype;
  v_unit text;
  v_unit_display text;
  v_cached jsonb;
  v_alias record;
  v_line record;
  v_alias_count integer := 0;
  v_aliases_updated integer := 0;
  v_lines integer := 0;
  v_posted numeric;
  v_new_qty numeric;
  v_delta numeric;
  v_target text;
  v_total_tt numeric := 0;
  v_total_q7 numeric := 0;
  v_preview_lines jsonb := '[]'::jsonb;
  v_note text;
  v_ref text;
  v_inserted integer;
  v_result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not public.kho_item_can_edit(v_actor) then
      raise exception 'unit_forbidden' using errcode = '42501';
    end if;
  end if;

  -- Replay before any validation that depends on current catalog state: the
  -- original save already passed it and its result must be returned as-is.
  if not v_dry and p_request_id is not null then
    perform pg_advisory_xact_lock(hashtext('warehouse_game:' || p_request_id::text));
    select r.result into v_cached
    from public.warehouse_game_requests r
    where r.request_id = p_request_id
      and r.action = 'kho_set_conversion';
    if found then
      return v_cached;
    end if;
  end if;

  if p_factor is null
     or p_factor <= 0
     or p_factor > 1000000
     or p_factor::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'invalid_factor' using errcode = '22023';
  end if;

  v_unit := public.normalize_document_unit(p_unit);
  if v_unit is null then
    raise exception 'unit_required' using errcode = '22023';
  end if;

  if not v_dry and p_request_id is null then
    raise exception 'request_id_required' using errcode = '22023';
  end if;

  select * into v_item
  from public.kitchen_inventory_items k
  where k.id = p_item_id
  for update;
  if not found then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;

  -- A kg / g / l / ml line converts by itself from the line unit; its alias
  -- factor is never used, so there is nothing to correct.
  if public.stock_unit_line_factor(v_unit, v_item.unit) is not null then
    raise exception 'unit_auto' using errcode = '22023';
  end if;

  select count(*) into v_alias_count
  from public.stock_material_aliases a
  where a.kitchen_inventory_item_id = p_item_id
    and a.line_class = 'stock'
    and public.normalize_document_unit(
          coalesce(nullif(btrim(a.pack_label), ''), a.unit)
        ) = v_unit;

  select x.display_unit into v_unit_display
  from (
    select coalesce(nullif(btrim(a.pack_label), ''), a.unit) as display_unit
    from public.stock_material_aliases a
    where a.kitchen_inventory_item_id = p_item_id
      and a.line_class = 'stock'
      and public.normalize_document_unit(
            coalesce(nullif(btrim(a.pack_label), ''), a.unit)
          ) = v_unit
  ) x
  group by x.display_unit
  order by count(*) desc, x.display_unit
  limit 1;
  v_unit_display := coalesce(v_unit_display, v_unit);

  -- Every posted receipt line behind a matching alias. A line whose unit (or
  -- pack bracket) converts by itself never used the alias factor: skip it.
  for v_line in
    with matched as (
      select
        gri.id as line_id,
        gri.unit as line_unit,
        gri.quantity,
        gri.actual_quantity,
        gri.ordered_quantity,
        gri.raw_product_name,
        gri.product_name,
        gr.receipt_number,
        gr.receipt_date,
        gr.status::text as receipt_status,
        ar.location as alias_location,
        ar.id as alias_id,
        exists (
          select 1 from public.stock_transfers st
          where st.goods_receipt_item_id = gri.id
        ) as has_transfer
      from public.stock_material_aliases ar
      join public.goods_receipts gr
        on gr.supplier_id is not distinct from ar.supplier_id
      left join public.suppliers s on s.id = gr.supplier_id
      join public.goods_receipt_items gri on gri.goods_receipt_id = gr.id
      where ar.kitchen_inventory_item_id = p_item_id
        and ar.line_class = 'stock'
        and public.normalize_document_unit(
              coalesce(nullif(btrim(ar.pack_label), ''), ar.unit)
            ) = v_unit
        and ar.location = coalesce(gr.receiving_location, s.default_receiving_location, 'tan_tao')
        and gr.status in ('confirmed', 'received')
        and coalesce(s.stock_exempt, false) = false
        and public.stock_line_auto_non_stock(
              coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
            ) is null
        and ar.normalized_name = public.normalize_stock_item_name(
              coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
            )
        and exists (
          select 1 from public.q7_inventory_movements m
          where m.source = 'goods_receipt'
            and m.source_ref_key = 'gr-item:' || gri.id::text
            and m.kitchen_inventory_item_id = p_item_id
          union all
          select 1 from public.tan_tao_material_movements m
          where m.source = 'goods_receipt'
            and m.source_ref_key = 'gr-item:' || gri.id::text
            and m.kitchen_inventory_item_id = p_item_id
        )
    )
    select distinct on (m.line_id) m.*
    from matched m
    order by m.line_id, m.alias_id
  loop
    if public.stock_unit_line_factor(v_line.line_unit, v_item.unit) is not null
       or public.stock_unit_pack_factor(
            coalesce(v_line.raw_product_name, v_line.product_name),
            v_line.line_unit,
            v_item.unit
          ) is not null then
      continue;
    end if;

    -- The original receipt movement plus every earlier correction of the line.
    select coalesce(sum(x.qty), 0) into v_posted
    from (
      select m.quantity as qty
      from public.q7_inventory_movements m
      where m.source = 'goods_receipt'
        and m.source_ref_key = 'gr-item:' || v_line.line_id::text
        and m.kitchen_inventory_item_id = p_item_id
      union all
      select m.quantity
      from public.tan_tao_material_movements m
      where m.source = 'goods_receipt'
        and m.source_ref_key = 'gr-item:' || v_line.line_id::text
        and m.kitchen_inventory_item_id = p_item_id
      union all
      select m.quantity
      from public.q7_inventory_movements m
      where m.source = 'unit_factor_fix'
        and m.source_ref_key like 'unit-fix:' || v_line.line_id::text || ':%'
        and m.kitchen_inventory_item_id = p_item_id
      union all
      select m.quantity
      from public.tan_tao_material_movements m
      where m.source = 'unit_factor_fix'
        and m.source_ref_key like 'unit-fix:' || v_line.line_id::text || ':%'
        and m.kitchen_inventory_item_id = p_item_id
    ) x;

    v_new_qty := round(
      public.goods_receipt_effective_quantity(
        v_line.actual_quantity,
        v_line.quantity,
        v_line.ordered_quantity,
        v_line.receipt_status
      ) * p_factor,
      3
    );
    if v_new_qty is null then
      continue;
    end if;

    v_delta := round(v_new_qty - v_posted, 3);
    if abs(v_delta) < 0.0005 then
      continue;
    end if;

    -- A pastry line was auto-moved to Q7 (stock_transfers row); correct Q7.
    v_target := case
      when v_line.alias_location = 'q7' or v_line.has_transfer then 'q7'
      else 'tan_tao'
    end;

    if v_target = 'q7' then
      v_total_q7 := v_total_q7 + v_delta;
    else
      v_total_tt := v_total_tt + v_delta;
    end if;

    if v_dry then
      v_preview_lines := v_preview_lines || jsonb_build_array(
        jsonb_build_object(
          'receipt_number', v_line.receipt_number,
          'receipt_date', v_line.receipt_date,
          'location', v_target,
          'posted_qty', v_posted,
          'new_qty', v_new_qty,
          'delta', v_delta
        )
      );
    else
      v_ref := 'unit-fix:' || v_line.line_id::text || ':' || p_request_id::text;
      v_note := 'Sửa quy đổi 1 ' || v_unit_display || ' = ' || p_factor::text
        || ' ' || v_item.unit || ' · ' || coalesce(v_line.receipt_number, '');

      if v_target = 'q7' then
        insert into public.q7_inventory_movements(
          kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
          source, source_ref_key, note, created_by
        ) values (
          p_item_id, v_line.receipt_date, 'adjustment', v_delta, v_item.unit,
          'unit_factor_fix', v_ref, v_note, v_actor
        )
        on conflict do nothing;
      else
        insert into public.tan_tao_material_movements(
          kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
          source, source_ref_key, note, created_by
        ) values (
          p_item_id, v_line.receipt_date, 'adjustment', v_delta, v_item.unit,
          'unit_factor_fix', v_ref, v_note, v_actor
        )
        on conflict do nothing;
      end if;

      get diagnostics v_inserted = row_count;
      v_lines := v_lines + v_inserted;
    end if;
  end loop;

  if v_dry then
    return jsonb_build_object(
      'status', 'preview',
      'aliases', v_alias_count,
      'lines', v_preview_lines,
      'total_delta', jsonb_build_object('tan_tao', v_total_tt, 'q7', v_total_q7)
    );
  end if;

  -- Save: one 'correct' event per alias, exactly like
  -- update_stock_material_alias_factor.
  if v_alias_count > 0 then
    for v_alias in
      select a.id, a.conversion_factor, a.normalized_name, a.unit
      from public.stock_material_aliases a
      where a.kitchen_inventory_item_id = p_item_id
        and a.line_class = 'stock'
        and public.normalize_document_unit(
              coalesce(nullif(btrim(a.pack_label), ''), a.unit)
            ) = v_unit
      order by a.id
    loop
      update public.stock_material_aliases
        set conversion_factor = p_factor,
            updated_at = now()
        where id = v_alias.id;

      insert into public.material_alias_events (
        alias_id, action, actor_id, raw_name, raw_unit, previous_factor, new_factor
      ) values (
        v_alias.id, 'correct', v_actor, v_alias.normalized_name, v_alias.unit,
        v_alias.conversion_factor, p_factor
      );

      v_aliases_updated := v_aliases_updated + 1;
    end loop;
  end if;

  -- The saved factor also covers a receipt unit that has no supplier alias yet.
  insert into public.stock_item_unit_factors (
    kitchen_inventory_item_id, unit, factor, updated_by, updated_at
  ) values (
    p_item_id, v_unit, p_factor, v_actor, now()
  )
  on conflict (kitchen_inventory_item_id, unit) do update
    set factor = excluded.factor,
        updated_by = excluded.updated_by,
        updated_at = now();

  v_result := jsonb_build_object(
    'status', case when v_alias_count > 0 then 'saved' else 'saved_only' end,
    'aliases_updated', v_aliases_updated,
    'lines', v_lines,
    'total_delta', jsonb_build_object('tan_tao', v_total_tt, 'q7', v_total_q7)
  );

  insert into public.stock_unit_events (action, unit, item_id, details, actor)
  values (
    'set_conversion',
    v_unit,
    p_item_id,
    jsonb_build_object(
      'factor', p_factor,
      'aliases_updated', v_aliases_updated,
      'lines', v_lines,
      'total_delta', jsonb_build_object('tan_tao', v_total_tt, 'q7', v_total_q7),
      'request_id', p_request_id
    ),
    v_actor
  );

  insert into public.warehouse_game_requests (request_id, action, item_id, result, created_by)
  values (p_request_id, 'kho_set_conversion', p_item_id, v_result, v_actor)
  on conflict (request_id) do nothing;

  return v_result;
end;
$$;

revoke all on function public.kho_set_item_conversion(uuid, text, numeric, boolean, uuid) from public, anon;
grant execute on function public.kho_set_item_conversion(uuid, text, numeric, boolean, uuid) to authenticated, service_role;
