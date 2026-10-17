-- Công thức pate Tân Tạo + phiếu sản xuất pate trừ NVL, cộng thành phẩm.
--
-- Additive, idempotent migration. It:
--   1. lets tan_tao_material_movements carry the production usage source;
--   2. adds the posted "production_receipt" Tân Tạo SKU document type;
--   3. stores the owner-entered recipe (batch output, ingredient grams,
--      per-pack hộp / nhãn / pate grams);
--   4. exposes owner answer / batch RPCs and one production RPC that writes
--      production_usage material movements and posts packed SKUs through the
--      Tân Tạo warehouse document/movement path;
--   5. extends mission_evaluate with tan_tao_recipe_done and seeds one owner
--      mission.
--
-- Nothing here updates or deletes an existing material / warehouse movement.
-- This migration is additive and idempotent. The Maestro applies it; it does
-- not apply itself. Nothing posts for a production date on/before the Tân Tạo
-- cutover.

-- ===========================================================================
-- 1. Movement source + warehouse document type
-- ===========================================================================

alter table public.tan_tao_material_movements
  drop constraint if exists tan_tao_material_movements_source_check;
alter table public.tan_tao_material_movements
  add constraint tan_tao_material_movements_source_check
  check (source in (
    'goods_receipt', 'manual_adjustment', 'item_merge', 'item_merge_revert',
    'stock_transfer', 'production'
  ));

alter table public.tan_tao_warehouse_documents
  drop constraint if exists tan_tao_warehouse_documents_type_check;
alter table public.tan_tao_warehouse_documents
  add constraint tan_tao_warehouse_documents_type_check
  check (document_type in (
    'opening', 'supplier_order', 'receipt', 'outbound_order', 'dispatch',
    'stock_count', 'adjustment', 'cancellation', 'production_receipt'
  ));

-- Re-affirm the current status set (the auto ledger added 'closed') so this
-- migration is safe whether it lands before or after that migration.
alter table public.tan_tao_warehouse_documents
  drop constraint if exists tan_tao_warehouse_documents_status_check;
alter table public.tan_tao_warehouse_documents
  add constraint tan_tao_warehouse_documents_status_check
  check (status in ('expected', 'reserved', 'posted', 'cancelled', 'closed'));

-- ===========================================================================
-- 2. Recipe tables
-- ===========================================================================

create table if not exists public.tan_tao_recipes (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  batch_output_kg numeric,
  status text not null default 'draft',
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint tan_tao_recipes_status_check check (status in ('draft', 'complete'))
);

create table if not exists public.tan_tao_recipe_lines (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.tan_tao_recipes(id) on delete cascade,
  line_kind text not null,
  sort_order integer not null default 0,
  label text not null,
  kitchen_inventory_item_id uuid references public.kitchen_inventory_items(id) on delete set null,
  sku_code text,
  grams_per_batch numeric,
  pate_grams_per_pack numeric,
  pack_item_id uuid references public.kitchen_inventory_items(id) on delete set null,
  label_item_id uuid references public.kitchen_inventory_items(id) on delete set null,
  status text not null default 'open',
  answered_by uuid references auth.users(id) on delete set null,
  answered_at timestamptz,
  constraint tan_tao_recipe_lines_kind_check check (line_kind in ('ingredient', 'pack')),
  constraint tan_tao_recipe_lines_status_check check (status in ('open', 'answered', 'not_used')),
  constraint tan_tao_recipe_lines_recipe_label_key unique (recipe_id, label)
);

create table if not exists public.tan_tao_production_slips (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.tan_tao_recipes(id) on delete restrict,
  production_date date not null,
  batches numeric not null,
  packs jsonb not null default '[]'::jsonb,
  note text,
  request_id uuid not null unique,
  result jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create index if not exists idx_tan_tao_recipe_lines_recipe
  on public.tan_tao_recipe_lines(recipe_id, line_kind, sort_order);
create index if not exists idx_tan_tao_production_slips_created
  on public.tan_tao_production_slips(created_at desc, id desc);

alter table public.tan_tao_recipes enable row level security;
alter table public.tan_tao_recipe_lines enable row level security;
alter table public.tan_tao_production_slips enable row level security;

revoke all on table public.tan_tao_recipes from public, anon, authenticated;
revoke all on table public.tan_tao_recipe_lines from public, anon, authenticated;
revoke all on table public.tan_tao_production_slips from public, anon, authenticated;
grant select on table public.tan_tao_recipes to authenticated;
grant select on table public.tan_tao_recipe_lines to authenticated;
grant select on table public.tan_tao_production_slips to authenticated;
grant all on table public.tan_tao_recipes to service_role;
grant all on table public.tan_tao_recipe_lines to service_role;
grant all on table public.tan_tao_production_slips to service_role;

drop policy if exists tan_tao_recipes_select on public.tan_tao_recipes;
create policy tan_tao_recipes_select on public.tan_tao_recipes
  for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner'::public.app_role)
    or public.can_view_tan_tao_warehouse()
  );

drop policy if exists tan_tao_recipe_lines_select on public.tan_tao_recipe_lines;
create policy tan_tao_recipe_lines_select on public.tan_tao_recipe_lines
  for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner'::public.app_role)
    or public.can_view_tan_tao_warehouse()
  );

drop policy if exists tan_tao_production_slips_select on public.tan_tao_production_slips;
create policy tan_tao_production_slips_select on public.tan_tao_production_slips
  for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner'::public.app_role)
    or public.can_view_tan_tao_warehouse()
  );

-- ===========================================================================
-- 3. Seed the Tân Tạo pate recipe
-- ===========================================================================

do $seed_tan_tao_pate_recipe$
declare
  v_recipe_id uuid;
  v_item uuid;
  v_pack_item uuid;
  v_label_item uuid;
begin
  insert into public.tan_tao_recipes (code, name, batch_output_kg, status)
  values ('pate-heo', 'Pate heo Tân Tạo', null, 'draft')
  on conflict (code) do nothing;

  select r.id into v_recipe_id
  from public.tan_tao_recipes r
  where r.code = 'pate-heo';

  -- Nạc heo: any active "Nạc đùi..." item.
  select kii.id into v_item
  from public.kitchen_inventory_items kii
  where kii.active = true
    and kii.merged_into_id is null
    and kii.name ilike 'Nạc đùi%'
  order by kii.name, kii.id
  limit 1;
  insert into public.tan_tao_recipe_lines
    (recipe_id, line_kind, sort_order, label, kitchen_inventory_item_id)
  values (v_recipe_id, 'ingredient', 1, 'Nạc heo', v_item)
  on conflict (recipe_id, label) do nothing;

  -- Mỡ: any active "Mỡ..." item.
  select kii.id into v_item
  from public.kitchen_inventory_items kii
  where kii.active = true
    and kii.merged_into_id is null
    and kii.name ilike 'Mỡ%'
  order by kii.name, kii.id
  limit 1;
  insert into public.tan_tao_recipe_lines
    (recipe_id, line_kind, sort_order, label, kitchen_inventory_item_id)
  values (v_recipe_id, 'ingredient', 2, 'Mỡ', v_item)
  on conflict (recipe_id, label) do nothing;

  select kii.id into v_item
  from public.kitchen_inventory_items kii
  where kii.item_code = 'NVL-116'
  order by (kii.merged_into_id is null) desc, kii.active desc, kii.id
  limit 1;
  insert into public.tan_tao_recipe_lines
    (recipe_id, line_kind, sort_order, label, kitchen_inventory_item_id)
  values (v_recipe_id, 'ingredient', 3, 'Chả lụa', v_item)
  on conflict (recipe_id, label) do nothing;

  select kii.id into v_item
  from public.kitchen_inventory_items kii
  where kii.item_code = 'NVL-117'
  order by (kii.merged_into_id is null) desc, kii.active desc, kii.id
  limit 1;
  insert into public.tan_tao_recipe_lines
    (recipe_id, line_kind, sort_order, label, kitchen_inventory_item_id)
  values (v_recipe_id, 'ingredient', 4, 'Da bao', v_item)
  on conflict (recipe_id, label) do nothing;

  select kii.id into v_item
  from public.kitchen_inventory_items kii
  where kii.item_code = 'NVL-101'
  order by (kii.merged_into_id is null) desc, kii.active desc, kii.id
  limit 1;
  insert into public.tan_tao_recipe_lines
    (recipe_id, line_kind, sort_order, label, kitchen_inventory_item_id)
  values (v_recipe_id, 'ingredient', 5, 'Muối diêm', v_item)
  on conflict (recipe_id, label) do nothing;

  select kii.id into v_item
  from public.kitchen_inventory_items kii
  where kii.item_code = 'NVL-100'
  order by (kii.merged_into_id is null) desc, kii.active desc, kii.id
  limit 1;
  insert into public.tan_tao_recipe_lines
    (recipe_id, line_kind, sort_order, label, kitchen_inventory_item_id)
  values (v_recipe_id, 'ingredient', 6, 'Tiêu', v_item)
  on conflict (recipe_id, label) do nothing;

  -- Muối has no kitchen item yet; the owner answers it later.
  insert into public.tan_tao_recipe_lines
    (recipe_id, line_kind, sort_order, label, kitchen_inventory_item_id)
  values (v_recipe_id, 'ingredient', 7, 'Muối', null)
  on conflict (recipe_id, label) do nothing;

  select kii.id into v_item
  from public.kitchen_inventory_items kii
  where kii.item_code = 'Q7-1D46C75D6698EB2E9861'
  order by (kii.merged_into_id is null) desc, kii.active desc, kii.id
  limit 1;
  insert into public.tan_tao_recipe_lines
    (recipe_id, line_kind, sort_order, label, kitchen_inventory_item_id)
  values (v_recipe_id, 'ingredient', 8, 'Đường', v_item)
  on conflict (recipe_id, label) do nothing;

  select kii.id into v_item
  from public.kitchen_inventory_items kii
  where kii.item_code = 'Q7-D13CB955CA74D3EAADAC'
  order by (kii.merged_into_id is null) desc, kii.active desc, kii.id
  limit 1;
  insert into public.tan_tao_recipe_lines
    (recipe_id, line_kind, sort_order, label, kitchen_inventory_item_id)
  values (v_recipe_id, 'ingredient', 9, 'Bột ngọt', v_item)
  on conflict (recipe_id, label) do nothing;

  select kii.id into v_item
  from public.kitchen_inventory_items kii
  where kii.active = true
    and kii.merged_into_id is null
    and kii.name ilike 'Bột năng%'
  order by kii.name, kii.id
  limit 1;
  insert into public.tan_tao_recipe_lines
    (recipe_id, line_kind, sort_order, label, kitchen_inventory_item_id)
  values (v_recipe_id, 'ingredient', 10, 'Bột năng', v_item)
  on conflict (recipe_id, label) do nothing;

  select kii.id into v_item
  from public.kitchen_inventory_items kii
  where kii.item_code = 'Q7-B917FD2CB8CAC14CBF22'
  order by (kii.merged_into_id is null) desc, kii.active desc, kii.id
  limit 1;
  insert into public.tan_tao_recipe_lines
    (recipe_id, line_kind, sort_order, label, kitchen_inventory_item_id)
  values (v_recipe_id, 'ingredient', 11, 'Bơ Peerless', v_item)
  on conflict (recipe_id, label) do nothing;

  -- Pack lines: pack item / label item resolved when present; grams prefilled.
  select kii.id into v_pack_item
  from public.kitchen_inventory_items kii
  where kii.item_code = 'NVL-099'
  order by (kii.merged_into_id is null) desc, kii.active desc, kii.id
  limit 1;
  select kii.id into v_label_item
  from public.kitchen_inventory_items kii
  where kii.item_code = 'NVL-096'
  order by (kii.merged_into_id is null) desc, kii.active desc, kii.id
  limit 1;
  insert into public.tan_tao_recipe_lines
    (recipe_id, line_kind, sort_order, label, sku_code, pate_grams_per_pack,
     pack_item_id, label_item_id)
  values (v_recipe_id, 'pack', 12, 'Hộp pate 500g', 'PATE-500G', 500,
          v_pack_item, v_label_item)
  on conflict (recipe_id, label) do nothing;

  select kii.id into v_pack_item
  from public.kitchen_inventory_items kii
  where kii.active = true
    and kii.merged_into_id is null
    and kii.name ilike 'Hộp pate 200gr%'
  order by kii.name, kii.id
  limit 1;
  select kii.id into v_label_item
  from public.kitchen_inventory_items kii
  where kii.item_code = 'NVL-095'
  order by (kii.merged_into_id is null) desc, kii.active desc, kii.id
  limit 1;
  insert into public.tan_tao_recipe_lines
    (recipe_id, line_kind, sort_order, label, sku_code, pate_grams_per_pack,
     pack_item_id, label_item_id)
  values (v_recipe_id, 'pack', 13, 'Hộp pate 200g', 'PATE-200G', 200,
          v_pack_item, v_label_item)
  on conflict (recipe_id, label) do nothing;
end;
$seed_tan_tao_pate_recipe$;

-- ===========================================================================
-- 4. Recipe read / answer / batch RPCs
-- ===========================================================================

create or replace function public.tan_tao_recipe_refresh_status(p_recipe_id uuid)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  update public.tan_tao_recipes r
  set status = case
        when coalesce(r.batch_output_kg, 0) > 0
          and not exists (
            select 1
            from public.tan_tao_recipe_lines l
            where l.recipe_id = r.id and l.status = 'open'
          )
        then 'complete'
        else 'draft'
      end,
      updated_at = now()
  where r.id = p_recipe_id;
$$;

revoke all on function public.tan_tao_recipe_refresh_status(uuid) from public, anon, authenticated;
grant execute on function public.tan_tao_recipe_refresh_status(uuid) to service_role;

create or replace function public.get_tan_tao_recipe(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_recipe public.tan_tao_recipes%rowtype;
  v_lines jsonb := '[]'::jsonb;
  v_open integer := 0;
  v_answered integer := 0;
  v_not_used integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then
      raise exception 'actor_required' using errcode = '42501';
    end if;
    if not (
      public.has_role(v_actor, 'owner'::public.app_role)
      or public.can_view_tan_tao_warehouse()
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  select * into v_recipe
  from public.tan_tao_recipes r
  where r.code = lower(btrim(coalesce(p_code, '')));
  if not found then
    raise exception 'recipe_not_found' using errcode = 'P0002';
  end if;

  select
    (count(*) filter (where l.status = 'open'))::integer,
    (count(*) filter (where l.status = 'answered'))::integer,
    (count(*) filter (where l.status = 'not_used'))::integer
  into v_open, v_answered, v_not_used
  from public.tan_tao_recipe_lines l
  where l.recipe_id = v_recipe.id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', l.id,
           'line_kind', l.line_kind,
           'sort_order', l.sort_order,
           'label', l.label,
           'kitchen_inventory_item_id', l.kitchen_inventory_item_id,
           'item_code', i.item_code,
           'item_name', i.name,
           'item_unit', i.unit,
           'sku_code', l.sku_code,
           'grams_per_batch', l.grams_per_batch,
           'pate_grams_per_pack', l.pate_grams_per_pack,
           'pack_item_id', l.pack_item_id,
           'pack_item_code', p.item_code,
           'pack_item_name', p.name,
           'pack_item_unit', p.unit,
           'label_item_id', l.label_item_id,
           'label_item_code', lb.item_code,
           'label_item_name', lb.name,
           'label_item_unit', lb.unit,
           'status', l.status,
           'answered_by', l.answered_by,
           'answered_at', l.answered_at
         ) order by l.line_kind desc, l.sort_order, l.id), '[]'::jsonb)
  into v_lines
  from public.tan_tao_recipe_lines l
  left join public.kitchen_inventory_items i on i.id = l.kitchen_inventory_item_id
  left join public.kitchen_inventory_items p on p.id = l.pack_item_id
  left join public.kitchen_inventory_items lb on lb.id = l.label_item_id
  where l.recipe_id = v_recipe.id;

  return jsonb_build_object(
    'id', v_recipe.id,
    'code', v_recipe.code,
    'name', v_recipe.name,
    'batch_output_kg', v_recipe.batch_output_kg,
    'batch_set', coalesce(v_recipe.batch_output_kg, 0) > 0,
    'status', v_recipe.status,
    'updated_by', v_recipe.updated_by,
    'updated_at', v_recipe.updated_at,
    'line_count', v_open + v_answered + v_not_used,
    'open_count', v_open,
    'answered_count', v_answered,
    'not_used_count', v_not_used,
    'lines', v_lines,
    'can_answer', (
      coalesce(auth.role(), '') = 'service_role'
      or public.has_role(v_actor, 'owner'::public.app_role)
    )
  );
end;
$$;

revoke all on function public.get_tan_tao_recipe(text) from public, anon;
grant execute on function public.get_tan_tao_recipe(text) to authenticated, service_role;

create or replace function public.answer_tan_tao_recipe_line(
  p_line_id uuid,
  p_item_id uuid default null,
  p_grams numeric default null,
  p_not_used boolean default false,
  p_pack_item_id uuid default null,
  p_label_item_id uuid default null,
  p_pate_grams numeric default null,
  p_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_line public.tan_tao_recipe_lines%rowtype;
  v_recipe public.tan_tao_recipes%rowtype;
  v_item public.kitchen_inventory_items%rowtype;
  v_answered_by uuid;
  v_answered_at timestamptz;
  v_result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then
      raise exception 'actor_required' using errcode = '42501';
    end if;
    if not public.has_role(v_actor, 'owner'::public.app_role) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  select * into v_line
  from public.tan_tao_recipe_lines l
  where l.id = p_line_id
  for update;
  if not found then
    raise exception 'recipe_line_not_found' using errcode = 'P0002';
  end if;

  select * into v_recipe
  from public.tan_tao_recipes r
  where r.id = v_line.recipe_id
  for update;

  v_answered_by := coalesce(v_line.answered_by, v_actor);
  v_answered_at := coalesce(v_line.answered_at, now());

  if v_line.line_kind = 'ingredient' then
    if coalesce(p_not_used, false) then
      update public.tan_tao_recipe_lines l
      set status = 'not_used',
          kitchen_inventory_item_id = null,
          grams_per_batch = null,
          answered_by = v_answered_by,
          answered_at = v_answered_at
      where l.id = v_line.id;
    else
      if p_item_id is null then
        raise exception 'ingredient_item_required' using errcode = '22023';
      end if;
      select * into v_item
      from public.kitchen_inventory_items kii
      where kii.id = p_item_id
        and kii.active = true
        and kii.merged_into_id is null;
      if not found then
        raise exception 'ingredient_item_not_found' using errcode = 'P0002';
      end if;
      if p_grams is null or p_grams <= 0
         or p_grams::text in ('NaN', 'Infinity', '-Infinity') then
        raise exception 'invalid_grams_per_batch' using errcode = '22023';
      end if;

      update public.tan_tao_recipe_lines l
      set status = 'answered',
          kitchen_inventory_item_id = p_item_id,
          grams_per_batch = p_grams,
          answered_by = v_answered_by,
          answered_at = v_answered_at
      where l.id = v_line.id;
    end if;

  elsif v_line.line_kind = 'pack' then
    if coalesce(p_not_used, false) then
      raise exception 'not_used_not_allowed_for_pack' using errcode = '22023';
    end if;
    if p_pack_item_id is null then
      raise exception 'pack_item_required' using errcode = '22023';
    end if;
    select * into v_item
    from public.kitchen_inventory_items kii
    where kii.id = p_pack_item_id
      and kii.active = true
      and kii.merged_into_id is null;
    if not found then
      raise exception 'pack_item_not_found' using errcode = 'P0002';
    end if;
    if p_label_item_id is not null then
      select * into v_item
      from public.kitchen_inventory_items kii
      where kii.id = p_label_item_id
        and kii.active = true
        and kii.merged_into_id is null;
      if not found then
        raise exception 'label_item_not_found' using errcode = 'P0002';
      end if;
    end if;
    if p_pate_grams is null or p_pate_grams <= 0
       or p_pate_grams::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception 'invalid_pate_grams_per_pack' using errcode = '22023';
    end if;

    update public.tan_tao_recipe_lines l
    set status = 'answered',
        pack_item_id = p_pack_item_id,
        label_item_id = p_label_item_id,
        pate_grams_per_pack = p_pate_grams,
        answered_by = v_answered_by,
        answered_at = v_answered_at
    where l.id = v_line.id;

  else
    raise exception 'unsupported_recipe_line_kind' using errcode = '22023';
  end if;

  perform public.tan_tao_recipe_refresh_status(v_line.recipe_id);
  v_result := public.get_tan_tao_recipe(v_recipe.code)
    || jsonb_build_object('answered_line_id', v_line.id);
  return v_result;
end;
$$;

revoke all on function public.answer_tan_tao_recipe_line(uuid, uuid, numeric, boolean, uuid, uuid, numeric, uuid)
  from public, anon;
grant execute on function public.answer_tan_tao_recipe_line(uuid, uuid, numeric, boolean, uuid, uuid, numeric, uuid)
  to authenticated, service_role;

create or replace function public.set_tan_tao_recipe_batch(
  p_code text,
  p_batch_output_kg numeric,
  p_request_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_recipe public.tan_tao_recipes%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then
      raise exception 'actor_required' using errcode = '42501';
    end if;
    if not public.has_role(v_actor, 'owner'::public.app_role) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  if p_batch_output_kg is null or p_batch_output_kg < 0
     or p_batch_output_kg::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'invalid_batch_output_kg' using errcode = '22023';
  end if;

  select * into v_recipe
  from public.tan_tao_recipes r
  where r.code = lower(btrim(coalesce(p_code, '')))
  for update;
  if not found then
    raise exception 'recipe_not_found' using errcode = 'P0002';
  end if;

  update public.tan_tao_recipes r
  set batch_output_kg = p_batch_output_kg,
      updated_by = v_actor,
      updated_at = now()
  where r.id = v_recipe.id;

  perform public.tan_tao_recipe_refresh_status(v_recipe.id);
  return public.get_tan_tao_recipe(v_recipe.code);
end;
$$;

revoke all on function public.set_tan_tao_recipe_batch(text, numeric, uuid) from public, anon;
grant execute on function public.set_tan_tao_recipe_batch(text, numeric, uuid)
  to authenticated, service_role;

-- ===========================================================================
-- 5. Production receipt document path + production RPC
-- ===========================================================================

create or replace function public.record_tan_tao_production_receipt(
  p_sku_code text,
  p_quantity numeric,
  p_idempotency_key text,
  p_slip_id uuid,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_sku_code text := upper(btrim(coalesce(p_sku_code, '')));
  v_sku_id uuid;
  v_document public.tan_tao_warehouse_documents%rowtype;
  v_document_number text;
begin
  if p_quantity is null or p_quantity <= 0
     or p_quantity::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'positive_quantity_required' using errcode = '22023';
  end if;
  if nullif(btrim(coalesce(p_idempotency_key, '')), '') is null then
    raise exception 'idempotency_key_required' using errcode = '22023';
  end if;
  if v_sku_code = '' then
    raise exception 'sku_code_required' using errcode = '22023';
  end if;

  select * into v_document
  from public.tan_tao_warehouse_documents d
  where d.idempotency_key = btrim(p_idempotency_key);
  if found then
    return jsonb_build_object('status', 'existing', 'document', to_jsonb(v_document));
  end if;

  select ps.id into v_sku_id
  from public.product_skus ps
  where upper(ps.sku_code) = v_sku_code
  order by ps.created_at asc
  limit 1;
  if v_sku_id is null then
    raise exception 'tan_tao_sku_not_configured' using errcode = 'P0002';
  end if;

  v_document_number := 'TT-PRD-'
    || to_char((now() at time zone 'Asia/Ho_Chi_Minh')::date, 'YYYYMMDD')
    || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));

  insert into public.tan_tao_warehouse_documents (
    document_number, location_code, sku_id, sku_code_snapshot, document_type,
    status, quantity, physical_quantity, source_authority, reference_type,
    reference_id, reference_label, idempotency_key, note, metadata, created_by
  ) values (
    v_document_number, 'warehouse_tan_tao', v_sku_id, v_sku_code,
    'production_receipt', 'posted', p_quantity, p_quantity,
    'production_receipt', 'production_slip', p_slip_id, 'Pate Tân Tạo',
    btrim(p_idempotency_key), p_note,
    jsonb_build_object('stock_effect', 'increment', 'sku_code', v_sku_code),
    v_actor
  )
  on conflict (idempotency_key) do nothing
  returning * into v_document;

  if v_document.id is null then
    select * into v_document
    from public.tan_tao_warehouse_documents d
    where d.idempotency_key = btrim(p_idempotency_key);
    return jsonb_build_object('status', 'existing', 'document', to_jsonb(v_document));
  end if;

  insert into public.tan_tao_warehouse_movements (
    document_id, location_code, sku_id, sku_code_snapshot, movement_type,
    quantity, note, created_by
  ) values (
    v_document.id, 'warehouse_tan_tao', v_sku_id, v_sku_code, 'receipt',
    p_quantity, p_note, v_actor
  );

  return jsonb_build_object('status', 'created', 'document', to_jsonb(v_document));
end;
$$;

revoke all on function public.record_tan_tao_production_receipt(text, numeric, text, uuid, text)
  from public, anon, authenticated;
grant execute on function public.record_tan_tao_production_receipt(text, numeric, text, uuid, text)
  to service_role;

create or replace function public.record_tan_tao_pate_production(
  p_date date,
  p_batches numeric,
  p_packs jsonb,
  p_note text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_packs jsonb := coalesce(p_packs, '[]'::jsonb);
  v_recipe public.tan_tao_recipes%rowtype;
  v_existing public.tan_tao_production_slips%rowtype;
  v_slip public.tan_tao_production_slips%rowtype;
  v_cutover date;
  v_line public.tan_tao_recipe_lines%rowtype;
  v_item public.kitchen_inventory_items%rowtype;
  v_entry jsonb;
  v_pack record;
  v_sku text;
  v_qty numeric;
  v_total_pack_qty numeric := 0;
  v_factor numeric;
  v_item_kind text;
  v_inserted integer := 0;
  v_movement_count integer := 0;
  v_ingredients jsonb := '[]'::jsonb;
  v_packaging jsonb := '[]'::jsonb;
  v_documents jsonb := '[]'::jsonb;
  v_doc_result jsonb;
  v_result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then
      raise exception 'actor_required' using errcode = '42501';
    end if;
    if not (
      public.can_manage_tan_tao_warehouse()
      or public.has_role(v_actor, 'owner'::public.app_role)
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  if p_request_id is null then
    raise exception 'request_id_required' using errcode = '22023';
  end if;

  -- Replay first: a recorded request always returns its stored result, even if
  -- the recipe / cutover / inputs later changed.
  select * into v_existing
  from public.tan_tao_production_slips s
  where s.request_id = p_request_id;
  if found then
    return coalesce(v_existing.result, '{}'::jsonb)
      || jsonb_build_object('replay', true);
  end if;

  if p_date is null then
    raise exception 'production_date_required' using errcode = '22023';
  end if;
  if p_batches is null then
    raise exception 'invalid_batches' using errcode = '22023';
  end if;
  if p_batches < 0 or p_batches::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'invalid_batches' using errcode = '22023';
  end if;
  if jsonb_typeof(v_packs) <> 'array' then
    raise exception 'invalid_packs' using errcode = '22023';
  end if;

  for v_entry in select value from jsonb_array_elements(v_packs)
  loop
    if jsonb_typeof(v_entry) <> 'object'
       or not (v_entry ? 'sku_code')
       or jsonb_typeof(v_entry -> 'sku_code') <> 'string'
       or not (v_entry ? 'quantity')
       or jsonb_typeof(v_entry -> 'quantity') <> 'number' then
      raise exception 'invalid_packs' using errcode = '22023';
    end if;
    v_sku := upper(btrim(v_entry ->> 'sku_code'));
    if v_sku = '' then
      raise exception 'invalid_packs' using errcode = '22023';
    end if;
    v_qty := (v_entry ->> 'quantity')::numeric;
    if v_qty < 0 or v_qty::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception 'invalid_packs' using errcode = '22023';
    end if;
    v_total_pack_qty := v_total_pack_qty + v_qty;
  end loop;

  if p_batches = 0 and v_total_pack_qty = 0 then
    raise exception 'empty_production' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('tan_tao_pate_production:' || p_request_id::text, 0)
  );

  select * into v_existing
  from public.tan_tao_production_slips s
  where s.request_id = p_request_id;
  if found then
    return coalesce(v_existing.result, '{}'::jsonb)
      || jsonb_build_object('replay', true);
  end if;

  select * into v_recipe
  from public.tan_tao_recipes r
  where r.code = 'pate-heo'
  for update;
  if not found or v_recipe.status <> 'complete' then
    raise exception 'recipe_incomplete' using errcode = '22023';
  end if;

  v_cutover := public.stock_ledger_cutover_date('tan_tao');
  if v_cutover is null or p_date <= v_cutover then
    raise exception 'before_cutover' using errcode = '22023';
  end if;

  insert into public.tan_tao_production_slips (
    recipe_id, production_date, batches, packs, note, request_id, created_by
  ) values (
    v_recipe.id, p_date, p_batches, v_packs, v_note, p_request_id, v_actor
  )
  returning * into v_slip;

  -- Ingredient usage: grams per batch × batches, converted to the item unit.
  for v_line in
    select * from public.tan_tao_recipe_lines l
    where l.recipe_id = v_recipe.id
      and l.line_kind = 'ingredient'
    order by l.sort_order, l.id
  loop
    if v_line.status = 'answered' then
      if v_line.grams_per_batch is null or v_line.grams_per_batch <= 0
         or v_line.grams_per_batch::text in ('NaN', 'Infinity', '-Infinity') then
        raise exception 'invalid_grams_per_batch' using errcode = '22023';
      end if;

      select * into v_item
      from public.kitchen_inventory_items kii
      where kii.id = v_line.kitchen_inventory_item_id;
      if not found then
        raise exception 'ingredient_item_not_found' using errcode = 'P0002';
      end if;

      v_factor := public.stock_unit_line_factor('g', v_item.unit);
      if v_factor is null then
        raise exception 'unit_conversion_missing: % (%)',
          v_line.label, v_item.unit using errcode = '22023';
      end if;

      v_qty := round(v_line.grams_per_batch * p_batches * v_factor, 3);
      if v_qty > 0 then
        insert into public.tan_tao_material_movements (
          kitchen_inventory_item_id, movement_date, movement_type, quantity,
          unit, source, source_ref_key, note, created_by
        ) values (
          v_item.id, p_date, 'production_usage', v_qty, v_item.unit,
          'production', 'pate-slip:' || v_slip.id::text || ':' || v_line.id::text,
          coalesce(v_note, 'Sản xuất pate Tân Tạo'), v_actor
        )
        on conflict (source, source_ref_key) where source_ref_key is not null do nothing;
        get diagnostics v_inserted = row_count;
        v_movement_count := v_movement_count + v_inserted;
      end if;

      v_ingredients := v_ingredients || jsonb_build_array(jsonb_build_object(
        'line_id', v_line.id,
        'item_id', v_item.id,
        'item_name', v_item.name,
        'unit', v_item.unit,
        'grams', v_line.grams_per_batch * p_batches,
        'quantity', v_qty
      ));
    end if;
  end loop;

  -- Pack usage + packed SKU receipt: one pack item, one optional label and one
  -- PATE SKU per pack line.
  for v_pack in
    select upper(btrim(e.value ->> 'sku_code')) as sku_code,
           sum((e.value ->> 'quantity')::numeric) as quantity
    from jsonb_array_elements(v_packs) e
    group by 1
    order by 1
  loop
    if v_pack.quantity <= 0 then
      continue;
    end if;

    select * into v_line
    from public.tan_tao_recipe_lines l
    where l.recipe_id = v_recipe.id
      and l.line_kind = 'pack'
      and upper(l.sku_code) = v_pack.sku_code;
    if not found then
      raise exception 'unknown_pack_sku: %', v_pack.sku_code using errcode = '22023';
    end if;
    if v_line.status <> 'answered' then
      raise exception 'pack_line_not_answered: %', v_line.sku_code using errcode = '22023';
    end if;

    if v_line.pack_item_id is not null then
      select * into v_item
      from public.kitchen_inventory_items kii
      where kii.id = v_line.pack_item_id;
      if not found then
        raise exception 'pack_item_not_found' using errcode = 'P0002';
      end if;

      select u.kind into v_item_kind
      from public.stock_units u
      where u.code = public.stock_unit_code(v_item.unit);
      v_factor := case when v_item_kind = 'count' then 1::numeric else null::numeric end;
      if v_factor is null then
        raise exception 'unit_conversion_missing: % (%)',
          v_line.label, v_item.unit using errcode = '22023';
      end if;

      v_qty := round(v_pack.quantity * v_factor, 3);
      if v_qty > 0 then
        insert into public.tan_tao_material_movements (
          kitchen_inventory_item_id, movement_date, movement_type, quantity,
          unit, source, source_ref_key, note, created_by
        ) values (
          v_item.id, p_date, 'production_usage', v_qty, v_item.unit,
          'production',
          'pate-slip:' || v_slip.id::text || ':pack:' || v_line.id::text,
          coalesce(v_note, 'Đóng gói pate Tân Tạo'), v_actor
        )
        on conflict (source, source_ref_key) where source_ref_key is not null do nothing;
        get diagnostics v_inserted = row_count;
        v_movement_count := v_movement_count + v_inserted;
      end if;

      v_packaging := v_packaging || jsonb_build_array(jsonb_build_object(
        'line_id', v_line.id,
        'kind', 'pack',
        'item_id', v_item.id,
        'item_name', v_item.name,
        'unit', v_item.unit,
        'packs', v_pack.quantity,
        'quantity', v_qty
      ));
    end if;

    if v_line.label_item_id is not null then
      select * into v_item
      from public.kitchen_inventory_items kii
      where kii.id = v_line.label_item_id;
      if not found then
        raise exception 'label_item_not_found' using errcode = 'P0002';
      end if;

      select u.kind into v_item_kind
      from public.stock_units u
      where u.code = public.stock_unit_code(v_item.unit);
      v_factor := case when v_item_kind = 'count' then 1::numeric else null::numeric end;
      if v_factor is null then
        raise exception 'unit_conversion_missing: % (%)',
          v_line.label, v_item.unit using errcode = '22023';
      end if;

      v_qty := round(v_pack.quantity * v_factor, 3);
      if v_qty > 0 then
        insert into public.tan_tao_material_movements (
          kitchen_inventory_item_id, movement_date, movement_type, quantity,
          unit, source, source_ref_key, note, created_by
        ) values (
          v_item.id, p_date, 'production_usage', v_qty, v_item.unit,
          'production',
          'pate-slip:' || v_slip.id::text || ':label:' || v_line.id::text,
          coalesce(v_note, 'Tem nhãn pate Tân Tạo'), v_actor
        )
        on conflict (source, source_ref_key) where source_ref_key is not null do nothing;
        get diagnostics v_inserted = row_count;
        v_movement_count := v_movement_count + v_inserted;
      end if;

      v_packaging := v_packaging || jsonb_build_array(jsonb_build_object(
        'line_id', v_line.id,
        'kind', 'label',
        'item_id', v_item.id,
        'item_name', v_item.name,
        'unit', v_item.unit,
        'packs', v_pack.quantity,
        'quantity', v_qty
      ));
    end if;

    v_doc_result := public.record_tan_tao_production_receipt(
      v_pack.sku_code,
      v_pack.quantity,
      'pate-slip:' || v_slip.id::text || ':' || v_pack.sku_code,
      v_slip.id,
      coalesce(v_note, 'Nhập thành phẩm pate Tân Tạo')
    );
    v_documents := v_documents || jsonb_build_array(jsonb_build_object(
      'sku_code', v_pack.sku_code,
      'quantity', v_pack.quantity,
      'result', v_doc_result
    ));
  end loop;

  v_result := jsonb_build_object(
    'status', 'recorded',
    'slip_id', v_slip.id,
    'recipe_code', v_recipe.code,
    'production_date', p_date,
    'batches', p_batches,
    'packs', v_packs,
    'ingredients', v_ingredients,
    'packaging', v_packaging,
    'documents', v_documents,
    'movement_count', v_movement_count,
    'replay', false
  );

  update public.tan_tao_production_slips s
  set result = v_result
  where s.id = v_slip.id;

  return v_result;
end;
$$;

revoke all on function public.record_tan_tao_pate_production(date, numeric, jsonb, text, uuid)
  from public, anon;
grant execute on function public.record_tan_tao_pate_production(date, numeric, jsonb, text, uuid)
  to authenticated, service_role;

-- ===========================================================================
-- 6. Mission rule tan_tao_recipe_done
-- ===========================================================================

alter table public.missions drop constraint if exists missions_check_rule_check;
alter table public.missions add constraint missions_check_rule_check check (
  check_rule in (
    'stock_alias_factor_fixed',
    'stock_duplicate_resolved',
    'stock_unknown_units_cleared',
    'material_links_done',
    'stock_count_questions_done',
    'q7_bom_mismatch_resolved',
    'tan_tao_recipe_done'
  )
);

do $seed_tan_tao_pate_mission$
declare
  v_owner uuid;
begin
  select ur.user_id into v_owner
  from public.user_roles ur
  where ur.role::text = 'owner'
  order by ur.created_at, ur.user_id
  limit 1;

  if v_owner is null then
    raise notice 'tan tao pate recipe mission seed skipped: no owner role';
    return;
  end if;

  insert into public.missions (
    code, area, title, description, assignee_user_id,
    check_rule, check_params, badge_code, sort_order, status, created_by
  ) values (
    'wh-tan-tao-pate-recipe',
    'warehouse',
    'Công thức pate Tân Tạo',
    'Nhập gram từng nguyên liệu cho 1 mẻ pate và hộp/tem cho mỗi hộp 500g, 200g',
    v_owner,
    'tan_tao_recipe_done',
    jsonb_build_object('code', 'pate-heo'),
    'cham_chi',
    8,
    'open',
    v_owner
  )
  on conflict (code) do nothing;
end;
$seed_tan_tao_pate_mission$;

-- The full mission_evaluate body (newest definition) is appended below so the
-- existing rule branches stay byte-identical.

create or replace function public.mission_evaluate(p_mission_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_mission public.missions%rowtype;
  v_done boolean := false;
  v_total integer := 0;
  v_left integer := 0;
  v_detail jsonb := '[]'::jsonb;
  v_alias_id uuid;
  v_bad_factor numeric;
  v_bad_item uuid;
  v_alias public.stock_material_aliases%rowtype;
  v_alias_found boolean;
  v_item_name text;
  v_item_unit text;
  v_fixed boolean;
  v_rows jsonb;
  v_index integer;
  v_active integer;
  v_name_changed boolean;
  v_pair boolean;
  v_a uuid;
  v_b uuid;
  v_row public.kitchen_inventory_items%rowtype;
  v_days integer;
  v_initial integer;
  v_groups integer;
  v_ignored integer;
  v_location text;
  v_review jsonb;
  v_counts jsonb;
  v_linked integer;
  v_batch text;
  v_question_total integer := 0;
  v_question_open integer := 0;
  v_question_answered integer := 0;
  v_question_skipped integer := 0;
  v_bom_open integer := 0;
  v_bom_excluded integer := 0;
  v_bom_resolved integer := 0;
  v_bom_total integer := 0;
  v_recipe public.tan_tao_recipes%rowtype;
  v_recipe_total integer := 0;
  v_recipe_open integer := 0;
  v_recipe_answered integer := 0;
  v_recipe_not_used integer := 0;
  v_recipe_code text;
begin
  select * into v_mission from public.missions where id = p_mission_id;
  if not found then
    raise exception 'mission_not_found' using errcode = 'P0002';
  end if;

  if v_mission.check_rule = 'stock_alias_factor_fixed' then
    v_rows := coalesce(v_mission.check_params -> 'aliases', '[]'::jsonb);
    v_total := jsonb_array_length(v_rows);
    for v_index in 0 .. greatest(v_total - 1, -1) loop
      v_alias_id := (v_rows -> v_index ->> 'id')::uuid;
      v_bad_factor := (v_rows -> v_index ->> 'bad_factor')::numeric;
      v_bad_item := (v_rows -> v_index ->> 'bad_item_id')::uuid;

      select * into v_alias from public.stock_material_aliases a where a.id = v_alias_id;
      v_alias_found := found;

      if not v_alias_found then
        v_fixed := true;
        v_item_name := null;
        v_item_unit := null;
      else
        select k.name, k.unit into v_item_name, v_item_unit
        from public.kitchen_inventory_items k
        where k.id = v_alias.kitchen_inventory_item_id;

        v_fixed := (v_alias.conversion_factor is distinct from v_bad_factor)
          or (v_alias.kitchen_inventory_item_id is distinct from v_bad_item);
      end if;

      if not v_fixed then
        v_left := v_left + 1;
      end if;

      v_detail := v_detail || jsonb_build_array(jsonb_build_object(
        'id', v_alias_id,
        'name', case when v_alias_found then v_alias.normalized_name else null end,
        'unit', case when v_alias_found then v_alias.unit else null end,
        'factor', case when v_alias_found then v_alias.conversion_factor else null end,
        'item_name', v_item_name,
        'item_unit', v_item_unit,
        'fixed', v_fixed
      ));
    end loop;
    v_done := (v_left = 0);

  elsif v_mission.check_rule = 'stock_duplicate_resolved' then
    v_rows := coalesce(v_mission.check_params -> 'items', '[]'::jsonb);
    v_total := jsonb_array_length(v_rows);
    v_active := 0;
    v_name_changed := false;
    v_pair := false;

    for v_index in 0 .. greatest(v_total - 1, -1) loop
      v_a := (v_rows -> v_index ->> 'id')::uuid;
      select * into v_row from public.kitchen_inventory_items k where k.id = v_a;
      if not found then
        v_name_changed := true;
        v_detail := v_detail || jsonb_build_array(jsonb_build_object(
          'id', v_a,
          'code', null,
          'name', null,
          'unit', null,
          'active', false,
          'on_hand', 0,
          'alias_count', 0
        ));
      else
        if coalesce(v_row.active, false) then
          v_active := v_active + 1;
        end if;
        if v_row.name is distinct from (v_rows -> v_index ->> 'name') then
          v_name_changed := true;
        end if;
        v_detail := v_detail || jsonb_build_array(jsonb_build_object(
          'id', v_row.id,
          'code', v_row.item_code,
          'name', v_row.name,
          'unit', v_row.unit,
          'active', coalesce(v_row.active, false),
          'on_hand', coalesce((
            select sum(case m.movement_type
                         when 'receipt' then m.quantity
                         when 'production_usage' then -m.quantity
                         when 'adjustment' then m.quantity
                         else 0 end)
            from public.q7_inventory_movements m
            where m.kitchen_inventory_item_id = v_row.id
          ), 0),
          'alias_count', (
            select count(*)
            from public.stock_material_aliases a
            where a.kitchen_inventory_item_id = v_row.id
          )
        ));
      end if;
    end loop;

    if v_total = 2 then
      v_a := (v_rows -> 0 ->> 'id')::uuid;
      v_b := (v_rows -> 1 ->> 'id')::uuid;
      select exists (
        select 1 from public.stock_item_distinct_pairs p
        where p.item_a = least(v_a, v_b)
          and p.item_b = greatest(v_a, v_b)
      ) into v_pair;
    end if;

    v_done := (v_active < 2) or v_name_changed or v_pair;
    v_left := case when v_done then 0 else 1 end;

  elsif v_mission.check_rule = 'stock_unknown_units_cleared' then
    v_days := coalesce((v_mission.check_params ->> 'days')::integer, 60);
    v_initial := coalesce((v_mission.check_params ->> 'initial')::integer, 0);
    v_total := v_initial;

    select count(distinct lower(btrim(r.unit)))::integer into v_groups
    from public.stock_unknown_purchase_unit_rows(v_days) r;

    select count(*)::integer into v_ignored
    from public.stock_unit_ignored_variants g
    where exists (
      select 1
      from public.stock_unknown_purchase_unit_rows(v_days) r
      where g.variant = lower(btrim(r.unit))
    );

    v_left := greatest(coalesce(v_groups, 0) - coalesce(v_ignored, 0), 0);
    v_done := (v_left = 0);

    select coalesce(jsonb_agg(jsonb_build_object(
             'unit', r.unit,
             'line_count', r.line_count,
             'example_name', r.example_name,
             'source_table', r.source_table
           ) order by r.line_count desc, r.unit asc, r.source_table asc), '[]'::jsonb)
    into v_detail
    from public.stock_unknown_purchase_unit_rows(v_days) r;

  elsif v_mission.check_rule = 'material_links_done' then
    v_location := v_mission.check_params ->> 'location';
    v_counts := public.material_link_counts_internal(v_location);
    v_left := coalesce((v_counts ->> 'total')::int, 0);
    v_linked := coalesce((v_counts ->> 'linked_total')::int, 0);
    v_total := v_left + v_linked;
    v_done := (v_left = 0 and v_total > 0);
    v_detail := jsonb_build_array(jsonb_build_object(
      'location', v_location,
      'remaining', v_left,
      'linked', v_linked,
      'exact', coalesce((v_counts ->> 'exact')::int, 0),
      'skipped', coalesce((v_counts ->> 'skipped')::int, 0)
    ));

  elsif v_mission.check_rule = 'stock_count_questions_done' then
    v_batch := v_mission.check_params ->> 'batch';

    select
      count(*)::integer,
      (count(*) filter (where q.status = 'open'))::integer,
      (count(*) filter (where q.status = 'answered'))::integer,
      (count(*) filter (where q.status = 'skipped'))::integer
    into v_question_total, v_question_open, v_question_answered, v_question_skipped
    from public.stock_count_unit_questions q
    where q.batch = v_batch;

    v_total := coalesce(v_question_total, 0);
    v_left := coalesce(v_question_open, 0);
    v_done := (v_total > 0 and v_left = 0);
    v_detail := jsonb_build_array(jsonb_build_object(
      'kind', 'count_questions',
      'batch', v_batch,
      'total', v_total,
      'open', v_left,
      'answered', coalesce(v_question_answered, 0),
      'skipped', coalesce(v_question_skipped, 0)
    ));

  elsif v_mission.check_rule = 'q7_bom_mismatch_resolved' then
    v_review := public.get_q7_bom_mismatch_review();
    v_bom_total := coalesce(jsonb_array_length(v_review), 0);
    select
      count(*) filter (where (r ->> 'open')::boolean = true)::integer,
      count(*) filter (where (r ->> 'excluded')::boolean = true)::integer,
      count(*) filter (where (r ->> 'resolved')::boolean = true)::integer
    into v_bom_open, v_bom_excluded, v_bom_resolved
    from jsonb_array_elements(v_review) r;

    v_total := v_bom_total;
    v_left := coalesce(v_bom_open, 0);
    v_done := (
      v_left = 0
      and exists (
        select 1
        from public.production_material_issues pmi
        where pmi.location_code = 'q7'
          and pmi.is_current = true
          and pmi.issue_date > public.stock_ledger_cutover_date('q7')
      )
    );
    v_detail := jsonb_build_array(jsonb_build_object(
      'kind', 'bom_mismatch',
      'open', v_left,
      'resolved', coalesce(v_bom_resolved, 0),
      'excluded', coalesce(v_bom_excluded, 0),
      'total', v_total
    ));

  elsif v_mission.check_rule = 'tan_tao_recipe_done' then
    v_recipe_code := v_mission.check_params ->> 'code';

    select * into v_recipe
    from public.tan_tao_recipes r
    where r.code = v_recipe_code;

    if not found then
      v_total := 0;
      v_left := 0;
      v_done := false;
      v_detail := jsonb_build_array(jsonb_build_object(
        'kind', 'recipe',
        'code', v_recipe_code,
        'open', 0,
        'answered', 0,
        'not_used', 0,
        'batch_set', false
      ));
    else
      select
        count(*)::integer,
        (count(*) filter (where l.status = 'open'))::integer,
        (count(*) filter (where l.status = 'answered'))::integer,
        (count(*) filter (where l.status = 'not_used'))::integer
      into v_recipe_total, v_recipe_open, v_recipe_answered, v_recipe_not_used
      from public.tan_tao_recipe_lines l
      where l.recipe_id = v_recipe.id;

      v_done := (v_recipe.status = 'complete');
      v_total := coalesce(v_recipe_total, 0) + 1;
      v_left := case
        when v_done then 0
        else coalesce(v_recipe_open, 0)
          + case when coalesce(v_recipe.batch_output_kg, 0) > 0 then 0 else 1 end
      end;
      v_detail := jsonb_build_array(jsonb_build_object(
        'kind', 'recipe',
        'code', v_recipe.code,
        'open', coalesce(v_recipe_open, 0),
        'answered', coalesce(v_recipe_answered, 0),
        'not_used', coalesce(v_recipe_not_used, 0),
        'batch_set', coalesce(v_recipe.batch_output_kg, 0) > 0
      ));
    end if;

  else
    raise exception 'unknown_check_rule' using errcode = '22023';
  end if;

  return jsonb_build_object(
    'done', v_done,
    'total', v_total,
    'left', v_left,
    'detail', v_detail
  );
end;
$$;

revoke all on function public.mission_evaluate(uuid) from public, anon, authenticated;
grant execute on function public.mission_evaluate(uuid) to service_role;
