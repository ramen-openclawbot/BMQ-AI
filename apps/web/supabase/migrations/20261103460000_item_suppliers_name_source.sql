-- 2026-10-30 — Món kho là gốc: gắn nhà cung cấp, đổi tên đồng bộ giá vốn.
--
-- A. kitchen_item_suppliers is the explicit many-to-many link between a kho
--    item and its suppliers.  kho_create_item now requires p_supplier_ids
--    (empty -> supplier_required, unknown id -> supplier_not_found), writes the
--    links and seeds the supplier/location name aliases without overwriting an
--    existing alias.  kho_set_item_suppliers adds/removes links idempotently and
--    refuses to remove every supplier from an active item.  Copying an item
--    still carries only the item definition, never the source's links.
--    The ATTP checklist scope is the union of matched receipt lines and these
--    explicit links.
--
-- B/C. The kho item name is the source of truth for the Material Master name.
--    Whenever kitchen_inventory_items.name changes (rename_stock_item or any
--    other UPDATE), the canonical material of a single active, unmerged kho item
--    is renamed through the guarded Material Master path (version + audit +
--    old-name alias), and the current formulation ingredient_name and the
--    existing supplier order catalog product_name follow.  A canonical shared by
--    several active items is not renamed; the conflict is recorded for the owner.
--    Money, quantities and historical canonical_material_snapshot are untouched.
--
-- D. apply_stock_item_merge keeps the target (catalog) name, stores the source
--    item name and its supplier invoice names as scan aliases, and the scan
--    candidate RPC returns the target catalog name.
--
-- No UI is changed here.

-- ===========================================================================
-- 1. Explicit item <-> supplier links
-- ===========================================================================

create table if not exists public.kitchen_item_suppliers (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null
    references public.kitchen_inventory_items(id) on delete cascade,
  supplier_id uuid not null
    references public.suppliers(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint kitchen_item_suppliers_item_supplier_key unique (item_id, supplier_id)
);

create index if not exists idx_kitchen_item_suppliers_supplier
  on public.kitchen_item_suppliers(supplier_id, item_id);

alter table public.kitchen_item_suppliers enable row level security;

drop policy if exists kitchen_item_suppliers_select on public.kitchen_item_suppliers;
create policy kitchen_item_suppliers_select on public.kitchen_item_suppliers
  for select to authenticated
  using (
    public.q7_material_inventory_can_view((select auth.uid()))
    or public.stock_count_can_view('q7')
    or public.stock_count_can_view('tan_tao')
    or public.kho_item_can_edit((select auth.uid()))
  );

-- Read for every kho viewer; every write goes through the SECURITY DEFINER RPCs
-- (or the service role used by migrations/jobs).
revoke all on table public.kitchen_item_suppliers from public, anon, authenticated;
grant select on table public.kitchen_item_suppliers to authenticated, service_role;
grant insert, update, delete on table public.kitchen_item_suppliers to service_role;

comment on table public.kitchen_item_suppliers is
  'Explicit many-to-many link between a kitchen inventory item and the suppliers that can supply it. One row per pair.';

-- ===========================================================================
-- 2. Idempotency action list
-- ===========================================================================

alter table public.warehouse_game_requests
  drop constraint if exists warehouse_game_requests_action_check;
alter table public.warehouse_game_requests
  add constraint warehouse_game_requests_action_check
  check (action in (
    'rename', 'change_unit', 'set_item_pastry_q7', 'kho_save_item',
    'kho_add_unit', 'kho_set_conversion', 'set_item_kho_locations',
    'kho_review_link_line', 'kho_review_create_item',
    'kho_review_jev_feedback', 'kho_create_item',
    'kho_set_item_suppliers'
  ));

-- ===========================================================================
-- 3. kho_create_item: required suppliers + seeded supplier aliases
-- ===========================================================================

-- The old 8-argument signature is replaced by the 9-argument one.  Copying an
-- item still never carries stock, lots, ledger movements, supplier links or
-- aliases: only the link rows for p_supplier_ids are written for the new item.
drop function if exists public.kho_create_item(
  text, text, text, boolean, boolean, text, uuid, uuid
);

create or replace function public.kho_create_item(
  p_name text,
  p_unit text,
  p_class text,
  p_tan_tao boolean,
  p_q7 boolean,
  p_note text,
  p_copy_from uuid,
  p_request_id uuid,
  p_supplier_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_name text := btrim(coalesce(p_name, ''));
  v_unit_input text;
  v_unit text;
  v_class text;
  v_note text;
  v_tan_tao boolean;
  v_q7 boolean;
  v_name_key text;
  v_normalized_key text;
  v_source public.kitchen_inventory_items%rowtype;
  v_has_source boolean := false;
  v_item_id uuid;
  v_item_code text;
  v_item_name text;
  v_item_unit text;
  v_cached jsonb;
  v_result jsonb;
  v_supplier_ids uuid[] := '{}'::uuid[];
  v_supplier_id uuid;
  v_norm_name text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not public.material_alias_can_admin(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;
  if p_request_id is null then
    raise exception 'request_id_required' using errcode = '22023';
  end if;

  -- Replay is checked before validation: the original call already passed it
  -- and its result must be returned unchanged on a repeated click/retry.
  perform pg_advisory_xact_lock(hashtext('warehouse_game:' || p_request_id::text));
  select r.result into v_cached
  from public.warehouse_game_requests r
  where r.request_id = p_request_id
    and r.action = 'kho_create_item';
  if found then
    return v_cached;
  end if;

  if length(v_name) < 2 or length(v_name) > 120 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;

  -- Suppliers are required and must all still exist.  Null array entries are
  -- ignored; duplicates collapse to one link.
  if p_supplier_ids is not null then
    foreach v_supplier_id in array p_supplier_ids loop
      if v_supplier_id is null or v_supplier_id = any(v_supplier_ids) then
        continue;
      end if;
      if not exists (select 1 from public.suppliers s where s.id = v_supplier_id) then
        raise exception 'supplier_not_found' using errcode = 'P0002';
      end if;
      v_supplier_ids := array_append(v_supplier_ids, v_supplier_id);
    end loop;
  end if;
  if cardinality(v_supplier_ids) = 0 then
    raise exception 'supplier_required' using errcode = '22023';
  end if;

  -- The source, when given, must still be part of the live catalog.  Its
  -- settings fill only the parameters the caller left null.
  if p_copy_from is not null then
    select * into v_source
    from public.kitchen_inventory_items k
    where k.id = p_copy_from
      and k.merged_into_id is null;
    if not found then
      raise exception 'item_not_found' using errcode = 'P0002';
    end if;
    v_has_source := true;
  end if;

  -- One normalized name, one live item: the same key kho_save_item and the
  -- item unit guard use.  Inactive / merged rows do not own the name.
  v_name_key := public.kho_item_name_key(v_name);
  if v_name_key is null then v_name_key := lower(v_name); end if;
  if exists (
    select 1
    from public.kitchen_inventory_items k
    where k.active = true
      and k.merged_into_id is null
      and public.kho_item_name_key(k.name) = v_name_key
  ) then
    raise exception 'item_name_duplicate' using errcode = '23505';
  end if;

  v_unit_input := nullif(btrim(coalesce(p_unit, '')), '');
  if v_unit_input is null and v_has_source then
    v_unit_input := v_source.unit;
  end if;
  v_unit := public.normalize_stock_unit(v_unit_input);
  if v_unit is null then
    raise exception 'unit_not_allowed' using errcode = '23514';
  end if;

  v_class := nullif(btrim(coalesce(p_class, '')), '');
  if v_class is null and v_has_source then
    v_class := v_source.item_class;
  end if;
  if v_class is null or v_class not in ('raw_material', 'packaging_supply') then
    raise exception 'invalid_class' using errcode = '22023';
  end if;

  v_tan_tao := p_tan_tao;
  v_q7 := p_q7;
  if v_has_source then
    if v_tan_tao is null then v_tan_tao := v_source.in_tan_tao; end if;
    if v_q7 is null then v_q7 := coalesce(v_source.pastry_q7, false); end if;
  end if;
  v_tan_tao := coalesce(v_tan_tao, false);
  v_q7 := coalesce(v_q7, false);
  if not v_tan_tao and not v_q7 then
    raise exception 'kho_location_required' using errcode = '22023';
  end if;

  v_note := nullif(btrim(coalesce(p_note, '')), '');
  if p_note is null and v_has_source then
    v_note := v_source.note;
  end if;
  if v_note is not null and length(v_note) > 500 then
    raise exception 'invalid_note' using errcode = '22023';
  end if;

  -- Every validation passed; writes start here.
  v_normalized_key := 'manual:' || v_name_key;
  if exists (
    select 1
    from public.kitchen_inventory_items k
    where k.normalized_key = v_normalized_key
  ) then
    -- A retired row may still hold the plain key; keep the new row distinct.
    v_normalized_key := v_normalized_key || ':' || substr(md5(p_request_id::text), 1, 12);
  end if;

  insert into public.kitchen_inventory_items (
    normalized_key,
    item_type,
    name,
    unit,
    standard_unit_cost,
    active,
    item_class,
    note,
    in_tan_tao,
    pastry_q7,
    pastry_q7_source,
    pastry_q7_set_at,
    pastry_q7_set_by
  ) values (
    v_normalized_key,
    'ingredient',
    v_name,
    v_unit,
    0,
    true,
    v_class,
    v_note,
    v_tan_tao,
    v_q7,
    'owner',
    now(),
    v_actor
  )
  returning id, item_code, name, unit
    into v_item_id, v_item_code, v_item_name, v_item_unit;

  -- Explicit supplier links.  The pair is unique, so a retry-copy of the same
  -- request cannot duplicate links.
  insert into public.kitchen_item_suppliers (item_id, supplier_id, created_by)
  select v_item_id, s.supplier_id, v_actor
  from unnest(v_supplier_ids) as s(supplier_id)
  on conflict (item_id, supplier_id) do nothing;

  -- Seed the item's own name as the supplier/location alias.  Existing aliases
  -- are never overwritten (a supplier spelling already in use stays put).
  v_norm_name := coalesce(
    public.normalize_stock_item_name(v_name),
    lower(btrim(v_name))
  );
  insert into public.stock_material_aliases (
    supplier_id, normalized_name, location, kitchen_inventory_item_id,
    conversion_factor, unit, created_by, line_class, status, confirm_count
  )
  select s.supplier_id, v_norm_name, loc.location, v_item_id,
         1, v_unit, v_actor, 'stock', 'auto', 3
  from unnest(v_supplier_ids) as s(supplier_id)
  cross join (values ('q7'::text), ('tan_tao'::text)) as loc(location)
  where (loc.location = 'q7' and v_q7)
     or (loc.location = 'tan_tao' and v_tan_tao)
  on conflict do nothing;

  -- A copy carries the item's count/pack conversions and ATTP profile only.
  if v_has_source then
    insert into public.stock_item_unit_factors (
      kitchen_inventory_item_id, unit, factor, updated_by, updated_at
    )
    select v_item_id, f.unit, f.factor, v_actor, now()
    from public.stock_item_unit_factors f
    where f.kitchen_inventory_item_id = p_copy_from
    on conflict (kitchen_inventory_item_id, unit) do nothing;

    update public.kitchen_inventory_items
       set attp_profile = v_source.attp_profile
     where id = v_item_id;
  end if;

  v_result := jsonb_build_object(
    'status', 'created',
    'item_id', v_item_id,
    'item_code', v_item_code,
    'name', v_item_name,
    'unit', v_item_unit,
    'in_tan_tao', v_tan_tao,
    'in_q7', v_q7,
    'copied_from', p_copy_from,
    'supplier_ids', to_jsonb(v_supplier_ids)
  );

  insert into public.warehouse_game_requests (request_id, action, item_id, result, created_by)
  values (p_request_id, 'kho_create_item', v_item_id, v_result, v_actor)
  on conflict (request_id) do nothing;

  return v_result;
end;
$$;

revoke all on function public.kho_create_item(
  text, text, text, boolean, boolean, text, uuid, uuid, uuid[]
) from public, anon;
grant execute on function public.kho_create_item(
  text, text, text, boolean, boolean, text, uuid, uuid, uuid[]
) to authenticated, service_role;

-- ===========================================================================
-- 4. kho_set_item_suppliers: add/remove explicit suppliers idempotently
-- ===========================================================================

create or replace function public.kho_set_item_suppliers(
  p_item_id uuid,
  p_supplier_ids uuid[],
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_item public.kitchen_inventory_items%rowtype;
  v_cached jsonb;
  v_result jsonb;
  v_supplier_ids uuid[] := '{}'::uuid[];
  v_old_ids uuid[] := '{}'::uuid[];
  v_added uuid[] := '{}'::uuid[];
  v_removed uuid[] := '{}'::uuid[];
  v_supplier_id uuid;
  v_norm_name text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not public.kho_item_can_edit(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;
  if p_item_id is null then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;
  if p_request_id is null then
    raise exception 'request_id_required' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('warehouse_game:' || p_request_id::text));
  select r.result into v_cached
  from public.warehouse_game_requests r
  where r.request_id = p_request_id
    and r.action = 'kho_set_item_suppliers';
  if found then
    return v_cached;
  end if;

  if p_supplier_ids is not null then
    foreach v_supplier_id in array p_supplier_ids loop
      if v_supplier_id is null or v_supplier_id = any(v_supplier_ids) then
        continue;
      end if;
      if not exists (select 1 from public.suppliers s where s.id = v_supplier_id) then
        raise exception 'supplier_not_found' using errcode = 'P0002';
      end if;
      v_supplier_ids := array_append(v_supplier_ids, v_supplier_id);
    end loop;
  end if;

  select * into v_item
  from public.kitchen_inventory_items k
  where k.id = p_item_id
  for update;
  if not found then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;

  if coalesce(v_item.active, false) and cardinality(v_supplier_ids) = 0 then
    raise exception 'supplier_required' using errcode = '22023';
  end if;

  select coalesce(array_agg(kis.supplier_id order by kis.supplier_id), '{}'::uuid[])
    into v_old_ids
  from public.kitchen_item_suppliers kis
  where kis.item_id = p_item_id;

  v_added := array(
    select x from unnest(v_supplier_ids) x
    where not x = any(v_old_ids)
  );
  v_removed := array(
    select x from unnest(v_old_ids) x
    where not x = any(v_supplier_ids)
  );

  delete from public.kitchen_item_suppliers kis
  where kis.item_id = p_item_id
    and not kis.supplier_id = any(v_supplier_ids);

  insert into public.kitchen_item_suppliers (item_id, supplier_id, created_by)
  select p_item_id, s.supplier_id, v_actor
  from unnest(v_supplier_ids) as s(supplier_id)
  on conflict (item_id, supplier_id) do nothing;

  -- Seeding is idempotent and never overwrites an existing supplier spelling.
  v_norm_name := coalesce(
    public.normalize_stock_item_name(v_item.name),
    lower(btrim(v_item.name))
  );
  insert into public.stock_material_aliases (
    supplier_id, normalized_name, location, kitchen_inventory_item_id,
    conversion_factor, unit, created_by, line_class, status, confirm_count
  )
  select s.supplier_id, v_norm_name, loc.location, p_item_id,
         1, v_item.unit, v_actor, 'stock', 'auto', 3
  from unnest(v_supplier_ids) as s(supplier_id)
  cross join (values ('q7'::text), ('tan_tao'::text)) as loc(location)
  where (loc.location = 'q7' and coalesce(v_item.pastry_q7, false))
     or (
       loc.location = 'tan_tao'
       and coalesce(v_item.in_tan_tao, not coalesce(v_item.pastry_q7, false))
     )
  on conflict do nothing;

  v_result := jsonb_build_object(
    'status', 'updated',
    'item_id', p_item_id,
    'supplier_ids', to_jsonb(v_supplier_ids),
    'added', to_jsonb(v_added),
    'removed', to_jsonb(v_removed)
  );

  insert into public.warehouse_game_requests (request_id, action, item_id, result, created_by)
  values (p_request_id, 'kho_set_item_suppliers', p_item_id, v_result, v_actor)
  on conflict (request_id) do nothing;

  return v_result;
end;
$$;

revoke all on function public.kho_set_item_suppliers(uuid, uuid[], uuid)
  from public, anon;
grant execute on function public.kho_set_item_suppliers(uuid, uuid[], uuid)
  to authenticated, service_role;

-- ===========================================================================
-- 5. Fill explicit links from matched receipts and existing aliases
-- ===========================================================================

insert into public.kitchen_item_suppliers (item_id, supplier_id)
select distinct x.item_id, gr.supplier_id
from public.goods_receipt_items gri
join public.goods_receipts gr on gr.id = gri.goods_receipt_id
cross join lateral (
  select public.kho_receipt_line_item(gri.id) as item_id
) x
join public.kitchen_inventory_items kii
  on kii.id = x.item_id
 and kii.active is true
 and kii.merged_into_id is null
where gr.status in ('confirmed', 'received')
  and gr.supplier_id is not null
  and x.item_id is not null
on conflict (item_id, supplier_id) do nothing;

insert into public.kitchen_item_suppliers (item_id, supplier_id, created_by)
select distinct a.kitchen_inventory_item_id, a.supplier_id, a.created_by
from public.stock_material_aliases a
join public.kitchen_inventory_items kii
  on kii.id = a.kitchen_inventory_item_id
 and kii.active is true
 and kii.merged_into_id is null
where a.line_class = 'stock'
  and a.kitchen_inventory_item_id is not null
  and a.supplier_id is not null
on conflict (item_id, supplier_id) do nothing;

-- ===========================================================================
-- 6. ATTP checklist: union of matched receipts and explicit links
-- ===========================================================================

create or replace function public.kho_attp_checklist(p_days integer default 180)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_days integer := coalesce(p_days, 180);
  v_result jsonb;
begin
  if v_days < 0 or v_days > 3650 then
    raise exception 'invalid_days' using errcode = '22023';
  end if;

  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not (
      public.q7_material_inventory_can_view(v_actor)
      or public.stock_count_can_view('tan_tao')
      or public.stock_count_can_view('q7')
      or public.kho_item_can_edit(v_actor)
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  with scoped_lines as materialized (
    select gri.id as gri_id,
           gr.supplier_id,
           gr.receipt_date,
           gri.created_at as line_created_at,
           gri.manufacturer_id,
           public.kho_receipt_line_item(gri.id) as item_id
      from public.goods_receipt_items gri
      join public.goods_receipts gr on gr.id = gri.goods_receipt_id
     where gr.status in ('confirmed', 'received')
       and gr.receipt_date >= current_date - v_days
  ),
  resolved_lines as materialized (
    select sl.gri_id,
           sl.supplier_id,
           sl.receipt_date,
           sl.line_created_at,
           sl.manufacturer_id,
           sl.item_id
      from scoped_lines sl
     where sl.item_id is not null
  ),
  -- The receipt-derived scope is unchanged.  Only items that still matter are
  -- kept here, exactly as before.
  receipt_scope as (
    select rl.supplier_id,
           rl.item_id,
           max(rl.receipt_date) as last_receipt_date
      from resolved_lines rl
      join public.kitchen_inventory_items kii on kii.id = rl.item_id
     where kii.active is true
       and kii.merged_into_id is null
       and coalesce(kii.attp_profile,
                    public.kho_attp_default_profile(kii.item_class, kii.item_type, kii.name)) <> 'none'
       and (
         kii.attp_profile is not null
         or exists (
           select 1
             from public.cogs_ingredient_stock_map m
             join public.sku_cogs_version_formulations f
               on f.canonical_material_id = m.canonical_material_id
             join public.sku_cogs_versions v on v.id = f.version_id
             join public.product_skus ps on ps.id = v.sku_id
            where m.kitchen_inventory_item_id = kii.id
              and ps.discontinued_at is null
              and (v.effective_to is null or v.effective_to >= current_date)
         )
         or exists (
           select 1
             from public.q7_inventory_movements qm
            where qm.kitchen_inventory_item_id = kii.id
              and qm.source in ('production_material_issue', 'signed_q7_issue', 'revenue_cogs')
              and qm.created_at >= now() - interval '60 days'
         )
         or exists (
           select 1
             from public.tan_tao_material_movements tm
            where tm.kitchen_inventory_item_id = kii.id
              and tm.source = 'revenue_cogs'
              and tm.created_at >= now() - interval '60 days'
         )
       )
      group by rl.supplier_id, rl.item_id
  ),
  -- An explicit supplier link is enough: the new item must appear in the
  -- checklist before its first receipt.  Inactive / merged items never do.
  explicit_scope as (
    select kis.supplier_id,
           kis.item_id,
           null::date as last_receipt_date
      from public.kitchen_item_suppliers kis
      join public.kitchen_inventory_items kii on kii.id = kis.item_id
     where kii.active is true
       and kii.merged_into_id is null
  ),
  scope as (
    select u.supplier_id,
           u.item_id,
           max(u.last_receipt_date) as last_receipt_date
      from (
        select rs.supplier_id, rs.item_id, rs.last_receipt_date
          from receipt_scope rs
        union all
        select es.supplier_id, es.item_id, es.last_receipt_date
          from explicit_scope es
      ) u
     group by u.supplier_id, u.item_id
  ),
  line_manufacturer as (
    select distinct on (rl.supplier_id, rl.item_id)
           rl.supplier_id,
           rl.item_id,
           rl.manufacturer_id
      from resolved_lines rl
     where rl.manufacturer_id is not null
     order by rl.supplier_id,
              rl.item_id,
              rl.receipt_date desc,
              rl.line_created_at desc,
              rl.gri_id desc
  ),
  item_scope as (
    select s.supplier_id,
           s.item_id,
           kii.item_code,
           kii.name,
           coalesce(
             kii.attp_profile,
             public.kho_attp_default_profile(kii.item_class, kii.item_type, kii.name)
           ) as profile,
           case when kii.attp_profile is null then 'default' else 'set' end as profile_source,
           coalesce(kii.default_manufacturer_id, lm.manufacturer_id) as manufacturer_id
      from scope s
      join public.kitchen_inventory_items kii on kii.id = s.item_id
      left join line_manufacturer lm
        on lm.supplier_id = s.supplier_id
       and lm.item_id = s.item_id
  ),
  all_kinds (kind, order_index) as (
    values
      ('attp_facility'::text, 1),
      ('product_declaration'::text, 2),
      ('coa'::text, 3),
      ('quarantine'::text, 4)
  ),
  item_req as (
    select isc.supplier_id,
           isc.item_id,
           isc.item_code,
           isc.name,
           isc.profile,
           isc.profile_source,
           isc.manufacturer_id,
           k.kind,
           k.order_index,
           (k.kind = any (public.kho_attp_required_kinds(isc.profile))) as required
      from item_scope isc
      cross join all_kinds k
  ),
  scope_items as (
    select distinct s.item_id from scope s
  ),
  cert_item_coverage as (
    select l.cert_id, l.item_id
      from public.food_cert_item_links l
      join scope_items si on si.item_id = l.item_id
     union
    select c.id, c.item_id
      from public.food_safety_certificates c
      join scope_items si on si.item_id = c.item_id
     where c.archived_at is null
       and c.owner_kind = 'item'
       and c.item_id is not null
     union
    select c.id, isc.item_id
      from public.food_safety_certificates c
      join item_scope isc on isc.manufacturer_id = c.manufacturer_id
     where c.archived_at is null
       and c.owner_kind = 'manufacturer'
       and c.manufacturer_id is not null
     union
    select c.id, s.item_id
      from public.food_safety_certificates c
      join scope s on s.supplier_id = c.supplier_id
     where c.archived_at is null
       and c.owner_kind = 'supplier'
       and c.supplier_id is not null
  ),
  cert_shared as (
    select cic.cert_id, count(distinct cic.item_id)::integer as shared_count
      from cert_item_coverage cic
     group by cic.cert_id
  ),
  candidate as (
    select ir.supplier_id,
           ir.item_id,
           ir.kind,
           ir.order_index,
           c.id as cert_id,
           c.cert_no,
           c.expires_on,
           c.review_status,
           c.extracted,
           c.created_at,
           case
             when c.review_status = 'confirmed'
                  and (c.expires_on is null or c.expires_on > current_date + 30) then 0
             when c.review_status = 'confirmed'
                  and c.expires_on >= current_date then 1
             when c.review_status = 'pending' then 2
             else 3
           end as state_rank
      from item_req ir
      join public.food_safety_certificates c
        on c.archived_at is null
       and c.cert_type = ir.kind
       and (
         (
           ir.kind = 'attp_facility'
           and (
             (c.owner_kind = 'manufacturer'
               and ir.manufacturer_id is not null
               and c.manufacturer_id = ir.manufacturer_id)
             or (c.owner_kind = 'supplier'
               and c.supplier_id = ir.supplier_id)
             or (c.owner_kind = 'item'
               and c.item_id = ir.item_id)
             or exists (
               select 1
                 from public.food_cert_item_links l
                where l.cert_id = c.id
                  and l.item_id = ir.item_id
             )
           )
         )
         or (
           ir.kind <> 'attp_facility'
           and (
             (c.owner_kind = 'item'
               and c.item_id = ir.item_id)
             or exists (
               select 1
                 from public.food_cert_item_links l
                where l.cert_id = c.id
                  and l.item_id = ir.item_id
             )
           )
         )
       )
     where ir.required
  ),
  best as (
    select distinct on (cand.supplier_id, cand.item_id, cand.kind)
           cand.supplier_id,
           cand.item_id,
           cand.kind,
           cand.order_index,
           cand.cert_id,
           cand.cert_no,
           cand.expires_on,
           cand.review_status,
           cand.extracted,
           cand.created_at
      from candidate cand
     order by cand.supplier_id,
              cand.item_id,
              cand.kind,
              cand.state_rank,
              cand.expires_on desc nulls first,
              cand.created_at desc,
              cand.cert_id desc
  ),
  reqs as (
    select ir.supplier_id,
           ir.item_id,
           ir.item_code,
           ir.name,
           ir.profile,
           ir.profile_source,
           ir.manufacturer_id,
           fm.name as manufacturer_name,
           ir.kind,
           ir.order_index,
           case
             when not ir.required then 'na'
             when b.cert_id is null then 'miss'
             when b.review_status = 'pending' then 'wait'
             when b.expires_on is null or b.expires_on > current_date + 30 then 'ok'
             when b.expires_on >= current_date then 'warn'
             else 'miss'
           end as state,
           b.cert_id,
           b.cert_no,
           b.expires_on,
           case
             when b.expires_on is null then null
             else (b.expires_on - current_date)::integer
           end as days_left,
           case
             when ir.required and b.cert_id is not null and b.review_status = 'pending'
               then b.extracted
             else null
           end as extracted_summary,
           case
             when ir.required
                  and b.cert_id is not null
                  and b.review_status = 'confirmed'
                  and b.expires_on is not null
                  and b.expires_on < current_date
               then jsonb_build_object(
                 'cert_id', b.cert_id,
                 'cert_no', b.cert_no,
                 'expires_on', b.expires_on
               )
             else null
           end as expired_cert,
           coalesce(cs.shared_count, 0) as shared_count
      from item_req ir
      left join best b
        on b.supplier_id = ir.supplier_id
       and b.item_id = ir.item_id
       and b.kind = ir.kind
      left join cert_shared cs on cs.cert_id = b.cert_id
      left join public.food_manufacturers fm on fm.id = ir.manufacturer_id
  ),
  item_rows as (
    select r.supplier_id,
           r.item_id,
           r.item_code,
           r.name,
           r.profile,
           r.profile_source,
           r.manufacturer_id,
           r.manufacturer_name,
           jsonb_agg(jsonb_build_object(
             'kind', r.kind,
             'state', r.state,
             'cert_id', r.cert_id,
             'cert_no', r.cert_no,
             'expires_on', r.expires_on,
             'days_left', r.days_left,
             'shared_count', r.shared_count,
             'extracted', r.extracted_summary,
             'expired_cert', r.expired_cert
           ) order by r.order_index) as requirements,
           count(*) filter (where r.state = 'ok')::integer as ok_count,
           count(*) filter (where r.state = 'warn')::integer as warn_count,
           count(*) filter (where r.state = 'wait')::integer as wait_count,
           count(*) filter (where r.state = 'miss')::integer as miss_count,
           count(*) filter (where r.state <> 'na')::integer as total_count,
           count(*) filter (where r.state in ('ok', 'warn'))::integer as done_count
      from reqs r
     group by r.supplier_id,
              r.item_id,
              r.item_code,
              r.name,
              r.profile,
              r.profile_source,
              r.manufacturer_id,
              r.manufacturer_name
  ),
  supplier_rows as (
    select i.supplier_id,
           s.name as supplier_name,
           jsonb_agg(jsonb_build_object(
             'item_id', i.item_id,
             'item_code', i.item_code,
             'name', i.name,
             'profile', i.profile,
             'profile_source', i.profile_source,
             'manufacturer_id', i.manufacturer_id,
             'manufacturer_name', i.manufacturer_name,
             'supplier_id', i.supplier_id,
             'supplier_name', s.name,
             'requirements', i.requirements,
             'totals', jsonb_build_object(
               'ok', i.ok_count,
               'warn', i.warn_count,
               'wait', i.wait_count,
               'miss', i.miss_count,
               'total', i.total_count,
               'done', i.done_count,
               'pct', case
                 when i.total_count = 0 then 100
                 else round(i.done_count::numeric * 100 / i.total_count)::integer
               end
             )
           ) order by i.name, i.item_id) as items,
           sum(i.ok_count)::integer as ok_count,
           sum(i.warn_count)::integer as warn_count,
           sum(i.wait_count)::integer as wait_count,
           sum(i.miss_count)::integer as miss_count,
           sum(i.total_count)::integer as total_count,
           sum(i.done_count)::integer as done_count,
           case
             when sum(i.total_count) = 0 then 100
             else round(sum(i.done_count)::numeric * 100 / sum(i.total_count))::integer
           end as pct
      from item_rows i
      join public.suppliers s on s.id = i.supplier_id
     group by i.supplier_id, s.name
  ),
  overall as (
    select coalesce(sum(sr.ok_count), 0)::integer as ok_count,
           coalesce(sum(sr.warn_count), 0)::integer as warn_count,
           coalesce(sum(sr.wait_count), 0)::integer as wait_count,
           coalesce(sum(sr.miss_count), 0)::integer as miss_count,
           coalesce(sum(sr.total_count), 0)::integer as total_count,
           coalesce(sum(sr.done_count), 0)::integer as done_count,
           case
             when coalesce(sum(sr.total_count), 0) = 0 then 100
             else round(
               coalesce(sum(sr.done_count), 0)::numeric * 100
               / nullif(sum(sr.total_count), 0)
             )::integer
           end as pct
      from supplier_rows sr
  ),
  unique_items as (
    select distinct on (i.item_id)
           i.item_id,
           i.item_code,
           i.name,
           i.profile,
           i.profile_source,
           i.manufacturer_id,
           i.manufacturer_name,
           i.supplier_id,
           sr.supplier_name,
           i.requirements,
           jsonb_build_object(
             'ok', i.ok_count,
             'warn', i.warn_count,
             'wait', i.wait_count,
             'miss', i.miss_count,
             'total', i.total_count,
             'done', i.done_count,
             'pct', case
               when i.total_count = 0 then 100
               else round(i.done_count::numeric * 100 / i.total_count)::integer
             end
           ) as totals,
           sr.pct as supplier_pct
      from item_rows i
      join supplier_rows sr on sr.supplier_id = i.supplier_id
     order by i.item_id, sr.pct, i.supplier_id
  )
  select jsonb_build_object(
    'generated_at', now(),
    'days', v_days,
    'totals', jsonb_build_object(
      'ok', o.ok_count,
      'warn', o.warn_count,
      'wait', o.wait_count,
      'miss', o.miss_count,
      'total', o.total_count,
      'done', o.done_count,
      'pct', o.pct
    ),
    'suppliers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'supplier_id', sr.supplier_id,
        'name', sr.supplier_name,
        'totals', jsonb_build_object(
          'ok', sr.ok_count,
          'warn', sr.warn_count,
          'wait', sr.wait_count,
          'miss', sr.miss_count,
          'total', sr.total_count,
          'done', sr.done_count,
          'pct', sr.pct
        ),
        'items', sr.items
      ) order by sr.pct, sr.supplier_name, sr.supplier_id)
      from supplier_rows sr
    ), '[]'::jsonb),
    'items_by_item', coalesce((
      select jsonb_agg(jsonb_build_object(
        'item_id', u.item_id,
        'item_code', u.item_code,
        'name', u.name,
        'profile', u.profile,
        'profile_source', u.profile_source,
        'manufacturer_id', u.manufacturer_id,
        'manufacturer_name', u.manufacturer_name,
        'supplier_id', u.supplier_id,
        'supplier_name', u.supplier_name,
        'requirements', u.requirements,
        'totals', u.totals
      ) order by u.name, u.item_id)
      from unique_items u
    ), '[]'::jsonb)
  )
  into v_result
  from overall o;

  return coalesce(v_result, jsonb_build_object(
    'generated_at', now(),
    'days', v_days,
    'totals', jsonb_build_object(
      'ok', 0, 'warn', 0, 'wait', 0, 'miss', 0,
      'total', 0, 'done', 0, 'pct', 100
    ),
    'suppliers', '[]'::jsonb,
    'items_by_item', '[]'::jsonb
  ));
end;
$$;

revoke all on function public.kho_attp_checklist(integer) from public, anon;
grant execute on function public.kho_attp_checklist(integer) to authenticated, service_role;

-- ===========================================================================
-- 7. Owner review of name-sync conflicts
-- ===========================================================================

create table if not exists public.kho_item_name_sync_skips (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null
    references public.kitchen_inventory_items(id) on delete cascade,
  material_id uuid
    references public.sku_cogs_materials(id) on delete set null,
  item_name text,
  material_name text,
  reason text not null,
  item_count integer,
  details jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'resolved', 'dismissed')),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  constraint kho_item_name_sync_skips_item_material_reason_key
    unique (item_id, material_id, reason)
);

create index if not exists idx_kho_item_name_sync_skips_pending
  on public.kho_item_name_sync_skips(status, created_at desc);

alter table public.kho_item_name_sync_skips enable row level security;

drop policy if exists kho_item_name_sync_skips_select on public.kho_item_name_sync_skips;
create policy kho_item_name_sync_skips_select on public.kho_item_name_sync_skips
  for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.can_edit_material_master()
  );

revoke all on table public.kho_item_name_sync_skips from public, anon, authenticated;
grant select on table public.kho_item_name_sync_skips to authenticated, service_role;
grant insert, update, delete on table public.kho_item_name_sync_skips to service_role;

comment on table public.kho_item_name_sync_skips is
  'Canonical-name sync conflicts (for example one canonical shared by several active kho items) waiting for the owner to decide.';

-- ===========================================================================
-- 8. Name sync: kho item -> Material Master -> formulations -> supplier catalog
-- ===========================================================================

create or replace function public.kho_sync_item_name_to_material(
  p_item_id uuid,
  p_new_name text default null,
  p_reason text default 'kho_item_rename',
  p_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_item public.kitchen_inventory_items%rowtype;
  v_material public.sku_cogs_materials%rowtype;
  v_new_material public.sku_cogs_materials%rowtype;
  v_new_name text;
  v_new_norm text;
  v_material_count integer;
  v_catalog_rows integer := 0;
  v_formula_rows integer := 0;
  v_legacy_rows integer := 0;
  v_version integer;
  v_skipped jsonb;
begin
  if p_item_id is null then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;

  select * into v_item
  from public.kitchen_inventory_items k
  where k.id = p_item_id
  for update;
  if not found then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;

  v_new_name := nullif(btrim(coalesce(p_new_name, v_item.name)), '');
  if v_new_name is null then
    return jsonb_build_object('status', 'unchanged', 'item_id', p_item_id);
  end if;

  -- The supplier order catalog always follows the kho catalog name of its item.
  update public.supplier_order_catalog_items soc
     set product_name = v_new_name,
         updated_at = now()
   where soc.kitchen_inventory_item_id = p_item_id
     and soc.product_name is distinct from v_new_name;
  get diagnostics v_catalog_rows = row_count;

  if v_item.canonical_material_id is null then
    return jsonb_build_object(
      'status', 'no_canonical',
      'item_id', p_item_id,
      'item_name', v_new_name,
      'catalog_rows_updated', v_catalog_rows
    );
  end if;

  -- Only an active, unmerged kho item is the source of truth.  A rename of an
  -- inactive/merged row must not rename the shared Material Master.
  if v_item.active is not true or v_item.merged_into_id is not null then
    return jsonb_build_object(
      'status', 'skipped',
      'reason', 'item_inactive',
      'item_id', p_item_id,
      'material_id', v_item.canonical_material_id,
      'item_name', v_new_name,
      'catalog_rows_updated', v_catalog_rows
    );
  end if;

  select * into v_material
  from public.sku_cogs_materials m
  where m.id = v_item.canonical_material_id
  for update;
  if not found then
    raise exception 'material_not_found' using errcode = 'P0002';
  end if;

  select count(*)::integer
    into v_material_count
  from public.kitchen_inventory_items k
  where k.canonical_material_id = v_material.id
    and k.active is true
    and k.merged_into_id is null;

  if v_material.active is not true or v_material_count <> 1 then
    v_skipped := jsonb_build_object(
      'status', 'skipped',
      'reason', case
        when v_material.active is not true then 'canonical_inactive'
        else 'canonical_shared'
      end,
      'item_id', p_item_id,
      'item_name', v_new_name,
      'material_id', v_material.id,
      'material_name', v_material.canonical_name,
      'item_count', v_material_count,
      'catalog_rows_updated', v_catalog_rows
    );

    insert into public.kho_item_name_sync_skips (
      item_id, material_id, item_name, material_name,
      reason, item_count, details, created_by
    ) values (
      p_item_id,
      v_material.id,
      v_new_name,
      v_material.canonical_name,
      case
        when v_material.active is not true then 'canonical_inactive'
        else 'canonical_shared'
      end,
      v_material_count,
      v_skipped,
      v_actor
    )
    on conflict (item_id, material_id, reason) do update
      set item_name = excluded.item_name,
          material_name = excluded.material_name,
          item_count = excluded.item_count,
          details = excluded.details,
          created_by = coalesce(public.kho_item_name_sync_skips.created_by, excluded.created_by),
          created_at = now();

    return v_skipped;
  end if;

  if v_material.canonical_name is not distinct from v_new_name then
    return jsonb_build_object(
      'status', 'unchanged',
      'item_id', p_item_id,
      'material_id', v_material.id,
      'canonical_name', v_material.canonical_name,
      'catalog_rows_updated', v_catalog_rows
    );
  end if;

  v_new_norm := public.material_master_normalize(v_new_name);
  if v_new_norm is null or btrim(v_new_norm) = '' then
    raise exception 'canonical_name_required' using errcode = '22023';
  end if;

  if exists (
    select 1
    from public.sku_cogs_materials m
    where m.normalized_name = v_new_norm
      and m.id <> v_material.id
  ) then
    raise exception 'canonical_name_conflict: % already belongs to another canonical material', v_new_name
      using errcode = '23505';
  end if;

  -- Keep the old canonical spelling as an alias.  Refuse to lose it when the
  -- alias already belongs to a different material instead of silently skipping.
  if exists (
    select 1
    from public.sku_cogs_material_aliases a
    where a.normalized_alias = v_material.normalized_name
      and a.material_id <> v_material.id
  ) then
    raise exception 'canonical_name_alias_conflict: old name % already belongs to another canonical material', v_material.canonical_name
      using errcode = '23505';
  end if;

  -- Controlled Material Master write: same guard bypass, version bump, audit and
  -- old-name alias as update_canonical_material(), without requiring the caller
  -- to hold an extra material-master permission for a kho rename.
  perform set_config('material_master.rpc_update', 'on', true);
  update public.sku_cogs_materials m
     set canonical_name = v_new_name,
         normalized_name = v_new_norm,
         updated_by = v_actor,
         updated_at = now(),
         version = coalesce(m.version, 0) + 1
   where m.id = v_material.id
   returning * into v_new_material;
  perform set_config('material_master.rpc_update', 'off', true);

  insert into public.sku_cogs_material_aliases (
    material_id, alias_name, normalized_alias, source, active, created_by
  ) values (
    v_material.id,
    v_material.canonical_name,
    v_material.normalized_name,
    'canonical_name',
    true,
    v_actor
  )
  on conflict (normalized_alias) do update
    set alias_name = excluded.alias_name,
        source = 'canonical_name',
        active = true
   where public.sku_cogs_material_aliases.material_id = excluded.material_id;

  -- Only the display name changes.  unit_price / dosage_qty / canonical_material_snapshot
  -- and every other amount stay exactly as they were.
  update public.sku_cogs_version_formulations f
     set ingredient_name = v_new_name
   where f.canonical_material_id = v_material.id;
  get diagnostics v_formula_rows = row_count;

  -- The legacy formulation table is guarded by material_master.sku_cogs_save.
  perform set_config('material_master.sku_cogs_save', 'on', true);
  update public.sku_formulations f
     set ingredient_name = v_new_name
   where f.canonical_material_id = v_material.id;
  get diagnostics v_legacy_rows = row_count;
  perform set_config('material_master.sku_cogs_save', '', true);
  v_formula_rows := v_formula_rows + v_legacy_rows;

  v_version := v_new_material.version;

  perform public.material_master_audit_append(
    'kho_item_rename_sync',
    v_material.id,
    p_request_id,
    coalesce(nullif(btrim(p_reason), ''), 'kho_item_rename'),
    public.material_master_row_json(v_material),
    public.material_master_row_json(v_new_material),
    jsonb_build_object(
      'item_id', p_item_id,
      'item_name', v_new_name,
      'catalog_rows_updated', v_catalog_rows,
      'formulation_rows_updated', v_formula_rows
    )
  );

  return jsonb_build_object(
    'status', 'synced',
    'item_id', p_item_id,
    'item_name', v_new_name,
    'material_id', v_material.id,
    'old_canonical_name', v_material.canonical_name,
    'new_canonical_name', v_new_name,
    'version', v_version,
    'catalog_rows_updated', v_catalog_rows,
    'formulation_rows_updated', v_formula_rows
  );
end;
$$;

revoke all on function public.kho_sync_item_name_to_material(uuid, text, text, uuid)
  from public, anon, authenticated;
grant execute on function public.kho_sync_item_name_to_material(uuid, text, text, uuid)
  to service_role;

-- Any UPDATE of the name follows the same path, whichever RPC or job wrote it.
create or replace function public.trg_kho_item_name_sync_material()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if nullif(btrim(NEW.name), '') is null or NEW.name is not distinct from OLD.name then
    return NEW;
  end if;
  perform public.kho_sync_item_name_to_material(NEW.id, NEW.name, 'kho_item_rename');
  return NEW;
end;
$$;

revoke all on function public.trg_kho_item_name_sync_material()
  from public, anon, authenticated, service_role;

drop trigger if exists trg_kho_item_name_sync_material
  on public.kitchen_inventory_items;
create trigger trg_kho_item_name_sync_material
  after update of name on public.kitchen_inventory_items
  for each row
  execute function public.trg_kho_item_name_sync_material();

-- ===========================================================================
-- 9. One-time backfill for rows whose canonical name drifted from the kho name
-- ===========================================================================

create or replace function public.kho_sync_item_names_to_materials(
  p_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_changed jsonb := '[]'::jsonb;
  v_skipped jsonb := '[]'::jsonb;
  v_result jsonb;
  r record;
begin
  for r in
    select k.id as item_id,
           k.name as item_name,
           m.id as material_id,
           m.canonical_name
      from public.kitchen_inventory_items k
      join public.sku_cogs_materials m on m.id = k.canonical_material_id
     where k.active is true
       and k.merged_into_id is null
       and nullif(btrim(k.name), '') is not null
       and k.name is distinct from m.canonical_name
     order by k.id
  loop
    v_result := public.kho_sync_item_name_to_material(
      r.item_id, r.item_name, 'kho_item_name_backfill', p_request_id
    );

    if v_result ->> 'status' = 'synced' then
      v_changed := v_changed || jsonb_build_array(v_result);
    elsif v_result ->> 'status' = 'skipped' then
      v_skipped := v_skipped || jsonb_build_array(v_result);
    end if;
  end loop;

  return jsonb_build_object(
    'status', 'synced',
    'changed', v_changed,
    'skipped', v_skipped,
    'changed_count', jsonb_array_length(v_changed),
    'skipped_count', jsonb_array_length(v_skipped)
  );
end;
$$;

revoke all on function public.kho_sync_item_names_to_materials(uuid)
  from public, anon, authenticated;
grant execute on function public.kho_sync_item_names_to_materials(uuid)
  to service_role;

-- Run once as part of this migration.  Shared canonicals are never renamed; each
-- affected item is recorded in kho_item_name_sync_skips for the owner.
do $$
declare
  v_result jsonb;
begin
  v_result := public.kho_sync_item_names_to_materials(null);
  raise notice 'kho_sync_item_names_to_materials: changed=%, skipped=%',
    v_result ->> 'changed_count', v_result ->> 'skipped_count';
end;
$$;

-- ===========================================================================
-- 10. Merge: keep the target catalog name and remember source/invoice names
-- ===========================================================================

create or replace function public.apply_stock_item_merge(
  p_source uuid,
  p_target uuid,
  p_factor numeric,
  p_suggestion uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid := auth.uid();
  v_source public.kitchen_inventory_items%rowtype;
  v_target public.kitchen_inventory_items%rowtype;
  v_target_unit text;
  v_merge_id uuid;
  v_rows integer := 0;
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_source_balance numeric;
  v_tt_balance numeric;
  v_old jsonb;
  v_new jsonb;
  v_existing_setting public.q7_purchase_item_settings%rowtype;
  v_child public.kitchen_inventory_items%rowtype;
  v_child_factor numeric;
  c record;
  r record;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor_id is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.q7_material_inventory_can_edit(v_actor_id) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  if p_source is null or p_target is null then
    raise exception 'merge_source_and_target_required' using errcode = '22023';
  end if;
  if p_source = p_target then
    raise exception 'merge_source_equals_target' using errcode = '22023';
  end if;
  if p_factor is null or p_factor <= 0 or p_factor::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'merge_factor_invalid' using errcode = '22023';
  end if;

  select * into v_source from public.kitchen_inventory_items where id = p_source for update;
  if not found then raise exception 'merge_source_not_found' using errcode = 'P0002'; end if;
  select * into v_target from public.kitchen_inventory_items where id = p_target for update;
  if not found then raise exception 'merge_target_not_found' using errcode = 'P0002'; end if;

  if v_source.active is not true then
    raise exception 'merge_source_inactive: item % is already inactive or merged', p_source using errcode = '23514';
  end if;
  if v_target.active is not true then
    raise exception 'merge_target_inactive: target item % is inactive', p_target using errcode = '23514';
  end if;
  -- Compare the catalog class (Nguyên liệu vs Bao bì & vật tư) that the app
  -- shows; the legacy item_type is mixed inside packaging_supply (31 ingredient
  -- vs 35 tool_supply on 23/10) and blocked same-class merges.  item_type is
  -- only the fallback when a class is missing.
  if coalesce(v_source.item_class, v_source.item_type) is distinct from coalesce(v_target.item_class, v_target.item_type) then
    raise exception 'merge_item_type_mismatch: % vs %', coalesce(v_source.item_class, v_source.item_type), coalesce(v_target.item_class, v_target.item_type) using errcode = '23514';
  end if;
  if v_target.merged_into_id is not null then
    raise exception 'merge_target_already_merged: target % is already merged into another item', p_target using errcode = '23514';
  end if;
  -- A source that was the target of applied merges is allowed (merge chains);
  -- its children are re-pointed after the source -> target merge below.

  v_target_unit := v_target.unit;

  insert into public.stock_item_merges(source_id, target_id, factor, status, applied_by, applied_at, suggestion_id)
  values (p_source, p_target, p_factor, 'applied', v_actor_id, now(), p_suggestion)
  returning id into v_merge_id;

  select s.balance_qty
    into v_source_balance
  from public.get_q7_inventory_snapshot(v_today) s
  where s.kitchen_inventory_item_id = p_source;
  v_source_balance := coalesce(v_source_balance, 0);

  if v_source_balance <> 0 then
    insert into public.q7_inventory_movements(
      kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
      source, source_ref_key, note, created_by
    ) values (
      p_source, v_today, 'adjustment', -v_source_balance, v_source.unit,
      'item_merge', 'item-merge:' || v_merge_id::text || ':out',
      'Bút toán chuyển tồn khi gộp mặt hàng ' || v_source.name || ' vào ' || v_target.name,
      v_actor_id
    )
    on conflict (source, source_ref_key) where source_ref_key is not null do nothing;

    insert into public.q7_inventory_movements(
      kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
      source, source_ref_key, note, created_by
    ) values (
      p_target, v_today, 'adjustment', v_source_balance * p_factor, v_target_unit,
      'item_merge', 'item-merge:' || v_merge_id::text || ':in',
      'Bút toán nhận tồn khi gộp mặt hàng ' || v_source.name || ' vào ' || v_target.name,
      v_actor_id
    )
    on conflict (source, source_ref_key) where source_ref_key is not null do nothing;
  end if;

  -- Tân Tạo NVL ledger: the same append-only transfer pair for shared raw items.
  select coalesce(sum(case m.movement_type
                        when 'receipt' then m.quantity
                        when 'opening' then m.quantity
                        when 'production_usage' then -m.quantity
                        when 'adjustment' then m.quantity
                        when 'transfer_out' then -m.quantity
                        else 0 end), 0)
    into v_tt_balance
  from public.tan_tao_material_movements m
  where m.kitchen_inventory_item_id = p_source;

  if v_tt_balance <> 0 then
    insert into public.tan_tao_material_movements(
      kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
      source, source_ref_key, note, created_by
    ) values (
      p_source, v_today, 'adjustment', -v_tt_balance, v_source.unit,
      'item_merge', 'item-merge:' || v_merge_id::text || ':tt:out',
      'Bút toán chuyển tồn sổ NVL Tân Tạo khi gộp ' || v_source.name || ' vào ' || v_target.name,
      v_actor_id
    )
    on conflict (source, source_ref_key) where source_ref_key is not null do nothing;

    insert into public.tan_tao_material_movements(
      kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
      source, source_ref_key, note, created_by
    ) values (
      p_target, v_today, 'adjustment', v_tt_balance * p_factor, v_target_unit,
      'item_merge', 'item-merge:' || v_merge_id::text || ':tt:in',
      'Bút toán nhận tồn sổ NVL Tân Tạo khi gộp ' || v_source.name || ' vào ' || v_target.name,
      v_actor_id
    )
    on conflict (source, source_ref_key) where source_ref_key is not null do nothing;
  end if;

  for r in select * from public.production_material_issue_items where kitchen_inventory_item_id = p_source for update loop
    v_old := to_jsonb(r);
    update public.production_material_issue_items as t
      set kitchen_inventory_item_id = p_target,
          required_qty = r.required_qty * p_factor,
          unit = v_target_unit,
          conversion_factor = case
            when r.conversion_factor is null then null
            else r.conversion_factor * p_factor
          end,
          updated_at = now()
      where t.id = r.id
      returning to_jsonb(t.*) into v_new;
    insert into public.stock_item_merge_rows(merge_id, table_name, row_id, old_values, new_values)
    values (v_merge_id, 'production_material_issue_items', r.id, v_old, v_new);
    v_rows := v_rows + 1;
  end loop;

  for r in select * from public.q7_material_issue_material_mappings where kitchen_inventory_item_id = p_source for update loop
    v_old := to_jsonb(r);
    update public.q7_material_issue_material_mappings as t
      set kitchen_inventory_item_id = p_target,
          conversion_factor = r.conversion_factor * p_factor,
          kitchen_unit = v_target_unit,
          updated_at = now()
      where t.id = r.id
      returning to_jsonb(t.*) into v_new;
    insert into public.stock_item_merge_rows(merge_id, table_name, row_id, old_values, new_values)
    values (v_merge_id, 'q7_material_issue_material_mappings', r.id, v_old, v_new);
    v_rows := v_rows + 1;
  end loop;

  -- Move the source's existing spellings.  When the target already has the same
  -- (supplier, alias, location) key, drop the duplicate source row and log it as
  -- a delete so revert can recreate it.
  for r in select * from public.stock_material_aliases where kitchen_inventory_item_id = p_source for update loop
    v_old := to_jsonb(r);
    if exists (
      select 1
      from public.stock_material_aliases a
      where a.id <> r.id
        and a.kitchen_inventory_item_id = p_target
        and coalesce(a.supplier_id, '00000000-0000-0000-0000-000000000000'::uuid)
          = coalesce(r.supplier_id, '00000000-0000-0000-0000-000000000000'::uuid)
        and a.normalized_name = r.normalized_name
        and a.location = r.location
    ) then
      delete from public.stock_material_aliases where id = r.id;
      insert into public.stock_item_merge_rows(merge_id, table_name, row_id, old_values, new_values)
      values (v_merge_id, 'stock_material_aliases', r.id, v_old, null);
    else
      update public.stock_material_aliases as t
        set kitchen_inventory_item_id = p_target,
            conversion_factor = r.conversion_factor * p_factor,
            unit = v_target_unit,
            updated_at = now()
        where t.id = r.id
        returning to_jsonb(t.*) into v_new;
      insert into public.stock_item_merge_rows(merge_id, table_name, row_id, old_values, new_values)
      values (v_merge_id, 'stock_material_aliases', r.id, v_old, v_new);
    end if;
    v_rows := v_rows + 1;
  end loop;

  -- The source item name remains a scan spelling of the target.  Global alias
  -- first (supplier-less); existing mappings are never overwritten.
  insert into public.stock_material_aliases (
    supplier_id, normalized_name, location, kitchen_inventory_item_id,
    conversion_factor, unit, created_by, line_class, status, confirm_count
  )
  select null,
         public.normalize_stock_item_name(v_source.name),
         loc.location,
         p_target,
         1,
         v_target_unit,
         v_actor_id,
         'stock',
         'auto',
         3
  from (values ('q7'::text), ('tan_tao'::text)) as loc(location)
  where public.normalize_stock_item_name(v_source.name) is not null
    and (
      (loc.location = 'q7' and coalesce(v_target.pastry_q7, false))
      or (
        loc.location = 'tan_tao'
        and coalesce(v_target.in_tan_tao, not coalesce(v_target.pastry_q7, false))
      )
    )
  on conflict do nothing;

  -- Every supplier that was explicitly linked to the source keeps its own
  -- spelling of the source name.
  insert into public.stock_material_aliases (
    supplier_id, normalized_name, location, kitchen_inventory_item_id,
    conversion_factor, unit, created_by, line_class, status, confirm_count
  )
  select kis.supplier_id,
         public.normalize_stock_item_name(v_source.name),
         loc.location,
         p_target,
         1,
         v_target_unit,
         v_actor_id,
         'stock',
         'auto',
         3
  from public.kitchen_item_suppliers kis
  cross join (values ('q7'::text), ('tan_tao'::text)) as loc(location)
  where kis.item_id = p_source
    and public.normalize_stock_item_name(v_source.name) is not null
    and (
      (loc.location = 'q7' and coalesce(v_target.pastry_q7, false))
      or (
        loc.location = 'tan_tao'
        and coalesce(v_target.in_tan_tao, not coalesce(v_target.pastry_q7, false))
      )
    )
  on conflict do nothing;

  -- The supplier order catalog stores the invoice/order name per supplier.
  -- Those names must still match the target when the next invoice is scanned.
  insert into public.stock_material_aliases (
    supplier_id, normalized_name, location, kitchen_inventory_item_id,
    conversion_factor, unit, created_by, line_class, status, confirm_count
  )
  select soc.supplier_id,
         public.normalize_stock_item_name(soc.product_name),
         loc.location,
         p_target,
         1,
         v_target_unit,
         v_actor_id,
         'stock',
         'auto',
         3
  from public.supplier_order_catalog_items soc
  cross join (values ('q7'::text), ('tan_tao'::text)) as loc(location)
  where soc.kitchen_inventory_item_id = p_source
    and nullif(btrim(soc.product_name), '') is not null
    and public.normalize_stock_item_name(soc.product_name) is not null
    and (
      (loc.location = 'q7' and coalesce(v_target.pastry_q7, false))
      or (
        loc.location = 'tan_tao'
        and coalesce(v_target.in_tan_tao, not coalesce(v_target.pastry_q7, false))
      )
    )
  on conflict do nothing;

  for r in select * from public.q7_purchase_item_settings where kitchen_inventory_item_id = p_source for update loop
    v_old := to_jsonb(r);
    select * into v_existing_setting
    from public.q7_purchase_item_settings
    where kitchen_inventory_item_id = p_target
    for update;
    if found then
      delete from public.q7_purchase_item_settings where id = r.id;
      insert into public.stock_item_merge_rows(merge_id, table_name, row_id, old_values, new_values)
      values (v_merge_id, 'q7_purchase_item_settings', r.id, v_old, null);
    else
      update public.q7_purchase_item_settings as t
        set kitchen_inventory_item_id = p_target,
            updated_at = now()
        where t.id = r.id
        returning to_jsonb(t.*) into v_new;
      insert into public.stock_item_merge_rows(merge_id, table_name, row_id, old_values, new_values)
      values (v_merge_id, 'q7_purchase_item_settings', r.id, v_old, v_new);
    end if;
    v_rows := v_rows + 1;
  end loop;

  update public.kitchen_inventory_items
    set active = false,
        merged_into_id = p_target,
        merged_factor = p_factor,
        merged_at = now()
    where id = p_source;

  -- Merge chains: this source may already be the target of applied merges.
  -- The body above forwarded the children's rows (aliases, mappings, settings)
  -- from the source to the target, so re-point the child items and their applied
  -- merge rows at the new target with the composed factor.  The old child values
  -- are logged in stock_item_merge_rows so revert_stock_item_merge can restore
  -- the chain in reverse order.
  for c in
    select sm.*
    from public.stock_item_merges sm
    where sm.target_id = p_source
      and sm.status = 'applied'
    order by sm.applied_at, sm.id
    for update
  loop
    v_child_factor := round(c.factor * p_factor, 8);
    if v_child_factor is null
       or v_child_factor <= 0
       or v_child_factor::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception 'merge_factor_invalid' using errcode = '22023';
    end if;

    select * into v_child
    from public.kitchen_inventory_items
    where id = c.source_id
    for update;
    if not found then
      raise exception 'merge_source_not_found' using errcode = 'P0002';
    end if;

    v_old := to_jsonb(v_child);
    update public.kitchen_inventory_items as t
      set merged_into_id = p_target,
          merged_factor = v_child_factor
      where t.id = c.source_id
      returning to_jsonb(t.*) into v_new;
    insert into public.stock_item_merge_rows(merge_id, table_name, row_id, old_values, new_values)
    values (v_merge_id, 'kitchen_inventory_items', c.source_id, v_old, v_new);
    v_rows := v_rows + 1;

    v_old := to_jsonb(c);
    update public.stock_item_merges as t
      set target_id = p_target,
          factor = v_child_factor
      where t.id = c.id
      returning to_jsonb(t.*) into v_new;
    insert into public.stock_item_merge_rows(merge_id, table_name, row_id, old_values, new_values)
    values (v_merge_id, 'stock_item_merges', c.id, v_old, v_new);
    v_rows := v_rows + 1;
  end loop;

  if p_suggestion is not null then
    update public.stock_catalog_suggestions
      set status = 'applied',
          decided_by = coalesce(decided_by, v_actor_id),
          decided_at = coalesce(decided_at, now())
      where id = p_suggestion and status in ('pending', 'approved');
  end if;

  return jsonb_build_object(
    'status', 'applied',
    'merge_id', v_merge_id,
    'source_id', p_source,
    'target_id', p_target,
    'factor', p_factor,
    'rows_logged', v_rows
  );
end;
$$;

revoke all on function public.apply_stock_item_merge(uuid, uuid, numeric, uuid)
  from public, anon;
grant execute on function public.apply_stock_item_merge(uuid, uuid, numeric, uuid)
  to authenticated, service_role;

-- ===========================================================================
-- 11. Scan candidates: exact alias match still returns the catalog name
-- ===========================================================================

create or replace function public.material_alias_candidates(
  p_name text,
  p_location text,
  p_limit integer default 5
)
returns table (
  item_id uuid,
  sku_id uuid,
  name text,
  unit text,
  score numeric,
  reason text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with base as (
    select coalesce(public.material_alias_clean_name(p_name), '') as clean_name
  ),
  parts as (
    select
      part,
      public.normalize_stock_item_name(part) as part_norm,
      public.material_alias_match_tokens(part) as part_tokens
    from base
    cross join lateral unnest(regexp_split_to_array(base.clean_name, '/')) as part
  ),
  item_raw as (
    select
      p_location::text as src,
      'item'::text as kind,
      kii.id as item_id,
      null::uuid as sku_id,
      kii.name::text as name,
      kii.unit::text as unit,
      p.part_norm,
      p.part_tokens,
      public.normalize_stock_item_name(kii.name) as cand_norm,
      public.material_alias_match_tokens(kii.name) as cand_tokens
    from public.kitchen_inventory_items kii
    cross join parts p
    where p_location in ('q7', 'tan_tao')
      and kii.active = true
      and kii.merged_into_id is null
    union all
    -- A source name saved as an alias when two items were merged must still
    -- resolve to the target, and the candidate always shows the target's kho
    -- catalog name (never the old/alias spelling).
    select
      p_location::text,
      'item'::text,
      kii.id,
      null::uuid,
      kii.name::text,
      kii.unit::text,
      public.normalize_stock_item_name(kii.name),
      public.material_alias_match_tokens(kii.name),
      public.normalize_stock_item_name(kii.name),
      public.material_alias_match_tokens(kii.name)
    from public.stock_material_aliases a
    join public.kitchen_inventory_items kii
      on kii.id = a.kitchen_inventory_item_id
    where p_location in ('q7', 'tan_tao')
      and a.location = p_location
      and a.line_class = 'stock'
      and a.kitchen_inventory_item_id is not null
      and a.normalized_name = public.normalize_stock_item_name(public.material_alias_clean_name(p_name))
      and kii.active = true
      and kii.merged_into_id is null
    union all
    select
      'tan_tao'::text,
      'sku'::text,
      null::uuid,
      ps.id,
      ps.product_name::text,
      ps.unit::text,
      p.part_norm,
      p.part_tokens,
      public.normalize_stock_item_name(ps.product_name),
      public.material_alias_match_tokens(ps.product_name)
    from public.product_skus ps
    cross join parts p
    where p_location = 'tan_tao'
      and upper(ps.sku_code) in ('BMQ-001', 'BMQ-002', 'PATE-500G', 'PATE-200G')
  ),
  scored as (
    select
      ir.*,
      (
        select count(*)
        from unnest(ir.part_tokens) rt
        where exists (
          select 1 from unnest(ir.cand_tokens) ct
          where public.material_alias_tokens_match(rt, ct)
        )
      ) as matched,
      cardinality(ir.part_tokens) as raw_count
    from item_raw ir
  ),
  part_scored as (
    select
      s.*,
      (s.part_norm is not null and s.part_norm = s.cand_norm) as is_exact,
      (s.raw_count > 0 and s.matched = s.raw_count) as contains_all
    from scored s
  ),
  part_final as (
    select
      p.src,
      p.kind,
      p.item_id,
      p.sku_id,
      p.name,
      p.unit,
      coalesce(p.item_id, p.sku_id) as cand_key,
      case
        when p.is_exact then 1.000000::numeric
        when p.contains_all then 0.900000::numeric
        when p.matched > 0 then 0.500000::numeric + 0.400000::numeric * p.matched::numeric / greatest(p.raw_count, 1)
        else 0.000000::numeric
      end as score_part,
      case
        when p.is_exact then 0
        when p.contains_all then 1
        when p.matched > 0 then 2
        else 3
      end as priority,
      case
        when p.is_exact then 'name_exact'
        when p.contains_all then 'name_contains'
        else 'token'
      end as base_reason
    from part_scored p
    where p.matched > 0 or p.is_exact
  ),
  best as (
    select distinct on (src, kind, cand_key)
      src, kind, item_id, sku_id, name, unit, score_part, base_reason
    from part_final
    order by src, kind, cand_key, score_part desc, priority asc, name asc
  ),
  final as (
    select
      b.src,
      b.kind,
      b.item_id,
      b.sku_id,
      b.name,
      b.unit,
      b.score_part as score,
      b.base_reason
        || case when (
          n.n is not null and exists (
            select 1
            from public.stock_material_aliases a
            where a.location = b.src
              and a.supplier_id is null
              and a.normalized_name = n.n
              and case
                when b.kind = 'item' then a.kitchen_inventory_item_id = b.item_id
                else a.tan_tao_sku_id = b.sku_id
              end
          )
        ) then '+shared_alias' else '' end
        || case when b.kind = 'sku' then '+sku' else '' end as reason
    from best b
    cross join lateral (
      select public.normalize_stock_item_name(public.material_alias_clean_name(p_name)) as n
    ) n
  )
  select f.item_id, f.sku_id, f.name, f.unit, f.score, f.reason
  from final f
  order by f.score desc, f.name asc, f.item_id asc nulls last, f.sku_id asc nulls last
  limit greatest(1, least(coalesce(p_limit, 5), 50));
$$;

revoke all on function public.material_alias_candidates(text, text, integer) from public, anon;
grant execute on function public.material_alias_candidates(text, text, integer) to authenticated, service_role;
