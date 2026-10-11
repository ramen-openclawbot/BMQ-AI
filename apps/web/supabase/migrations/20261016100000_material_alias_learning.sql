-- Giai đoạn 2: học bí danh NVL khi nhân viên xác nhận (data layer only).
--
-- Additive migration for the stock-material alias learning flow. It records how
-- many times an alias was confirmed, by whom, whether it is still learning or
-- already auto/disabled, the pack label read from the receipt line, the latest
-- Jev ranking and whether Jev disagreed with the human choice. It adds an
-- append-only event log, a per-supplier Jev cache, candidate-scoring RPCs, the
-- confirm / undo / status / review RPCs and an optional backlog reader for the
-- edge function.
--
-- Nothing here updates or deletes purchase_orders, purchase_order_items,
-- payment_requests, payment_request_items, goods_receipts, goods_receipt_items
-- or q7_inventory_movements. The only stock effect is calling the existing
-- post_stock_goods_receipt_item exactly like resolve_stock_alias already does.

-- ---------------------------------------------------------------------------
-- 1. stock_material_aliases: learning bookkeeping
-- ---------------------------------------------------------------------------

alter table public.stock_material_aliases
  add column if not exists confirm_count integer not null default 0,
  add column if not exists confirmers uuid[] not null default '{}',
  add column if not exists status text not null default 'learning',
  add column if not exists pack_label text,
  add column if not exists last_confirmed_at timestamptz,
  add column if not exists jev_item_id uuid,
  add column if not exists jev_probability numeric,
  add column if not exists jev_disagreed boolean not null default false,
  add column if not exists prompt_version text;

alter table public.stock_material_aliases
  drop constraint if exists stock_material_aliases_status_check;
alter table public.stock_material_aliases
  add constraint stock_material_aliases_status_check
  check (status in ('learning', 'auto', 'disabled'));

alter table public.stock_material_aliases
  drop constraint if exists stock_material_aliases_confirm_count_check;
alter table public.stock_material_aliases
  add constraint stock_material_aliases_confirm_count_check
  check (confirm_count >= 0);

alter table public.stock_material_aliases
  drop constraint if exists stock_material_aliases_jev_probability_check;
alter table public.stock_material_aliases
  add constraint stock_material_aliases_jev_probability_check
  check (
    jev_probability is null
    or (jev_probability >= 0 and jev_probability <= 1)
  );

-- Aliases already assigned by hand in Sổ tồn NVL (everything that exists before
-- this learning column) count as three confirmations and are already trusted.
update public.stock_material_aliases
  set status = 'auto',
      confirm_count = 3
where confirm_count = 0
  and status = 'learning';

create index if not exists idx_stock_material_aliases_status
  on public.stock_material_aliases(location, status, normalized_name);

-- ---------------------------------------------------------------------------
-- 2. Append-only event log
-- ---------------------------------------------------------------------------

create table if not exists public.material_alias_events (
  id uuid primary key default gen_random_uuid(),
  alias_id uuid references public.stock_material_aliases(id) on delete cascade,
  action text not null check (action in ('confirm', 'correct', 'undo', 'auto_promoted', 'disabled')),
  actor_id uuid references auth.users(id) on delete set null,
  source_table text,
  source_id uuid,
  raw_name text,
  raw_unit text,
  previous_item_id uuid,
  previous_sku_id uuid,
  previous_factor numeric(18, 8),
  new_item_id uuid,
  new_sku_id uuid,
  new_factor numeric(18, 8),
  jev_item_id uuid,
  jev_probability numeric(5, 4),
  undo_of_event_id uuid references public.material_alias_events(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint material_alias_events_previous_factor_check check (
    previous_factor is null
    or (previous_factor > 0 and previous_factor::text not in ('NaN', 'Infinity', '-Infinity'))
  ),
  constraint material_alias_events_new_factor_check check (
    new_factor is null
    or (new_factor > 0 and new_factor::text not in ('NaN', 'Infinity', '-Infinity'))
  ),
  constraint material_alias_events_jev_probability_check check (
    jev_probability is null
    or (jev_probability >= 0 and jev_probability <= 1)
  )
);

-- One event can only be undone once.
create unique index if not exists material_alias_events_undo_of_uidx
  on public.material_alias_events(undo_of_event_id)
  where action = 'undo' and undo_of_event_id is not null;

create index if not exists idx_material_alias_events_alias
  on public.material_alias_events(alias_id, created_at desc, id desc);

create index if not exists idx_material_alias_events_recent
  on public.material_alias_events(created_at desc, action);

-- ---------------------------------------------------------------------------
-- 3. Jev answer cache keyed by supplier + name + location + prompt + candidates
-- ---------------------------------------------------------------------------

create table if not exists public.material_alias_jev_cache (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid references public.suppliers(id) on delete cascade,
  normalized_name text not null,
  location text not null check (location in ('q7', 'tan_tao')),
  prompt_version text not null,
  candidates_hash text not null,
  answer jsonb not null,
  cost numeric(18, 8),
  created_at timestamptz not null default now(),
  constraint material_alias_jev_cache_name_check check (btrim(normalized_name) <> ''),
  constraint material_alias_jev_cache_cost_check check (
    cost is null
    or (cost >= 0 and cost::text not in ('NaN', 'Infinity', '-Infinity'))
  )
);

create unique index if not exists material_alias_jev_cache_key_uidx
  on public.material_alias_jev_cache (
    coalesce(supplier_id, '00000000-0000-0000-0000-000000000000'::uuid),
    normalized_name,
    location,
    prompt_version,
    candidates_hash
  );

create index if not exists idx_material_alias_jev_cache_lookup
  on public.material_alias_jev_cache(normalized_name, location, candidates_hash, created_at desc);

-- ---------------------------------------------------------------------------
-- 4. Permission helpers (owner / PO + payment editor / Q7 stock editor)
-- ---------------------------------------------------------------------------

-- View: Q7 stock viewer or a role that can read purchase orders / payment
-- requests (owner, staff, warehouse).
create or replace function public.material_alias_can_view(p_actor_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(auth.role(), '') = 'service_role'
    or public.q7_material_inventory_can_view(p_actor_id)
    or public.has_role(p_actor_id, 'owner')
    or public.has_role(p_actor_id, 'staff')
    or public.has_role(p_actor_id, 'warehouse');
$$;

-- Edit: Q7 stock editor or a role allowed to write purchase orders / payment
-- requests (owner, staff, warehouse).
create or replace function public.material_alias_can_edit(p_actor_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(auth.role(), '') = 'service_role'
    or public.q7_material_inventory_can_edit(p_actor_id)
    or public.has_role(p_actor_id, 'owner')
    or public.has_role(p_actor_id, 'staff')
    or public.has_role(p_actor_id, 'warehouse');
$$;

-- Admin: owner or Q7 stock editor only (undo / explicit status changes).
create or replace function public.material_alias_can_admin(p_actor_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(auth.role(), '') = 'service_role'
    or public.q7_material_inventory_can_edit(p_actor_id)
    or public.has_role(p_actor_id, 'owner');
$$;

-- ---------------------------------------------------------------------------
-- 5. Candidate scoring (deterministic, no Jev)
-- ---------------------------------------------------------------------------

-- Pure score shared by the Q7 and Tân Tạo candidate branches.
create or replace function public.material_alias_candidate_score(p_raw text, p_candidate text)
returns numeric
language sql
immutable
set search_path = public, pg_temp
as $$
  with n as (
    select public.normalize_stock_item_name(p_raw) as raw_norm,
           public.normalize_stock_item_name(p_candidate) as candidate_norm,
           public.stock_catalog_item_tokens(p_raw) as raw_tokens,
           public.stock_catalog_item_tokens(p_candidate) as candidate_tokens
  )
  select case
    when n.raw_norm is not null and n.raw_norm = n.candidate_norm then 1.000000::numeric
    when cardinality(n.raw_tokens) > 0 and n.raw_tokens <@ n.candidate_tokens then 0.900000::numeric
    else public.stock_catalog_token_jaccard(p_candidate, p_raw)
  end
  from n;
$$;

-- 1.0 when the normalized names are equal; 0.9 when the candidate contains every
-- word of the raw name (a more precise spelling of the same material); otherwise
-- the shared token Jaccard. A generic supplier-null alias that already points at
-- the candidate adds 0.05.
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
  with norm as (
    select public.normalize_stock_item_name(p_name) as n,
           public.stock_catalog_item_tokens(p_name) as raw_tokens
  ),
  q7 as (
    select
      kii.id as item_id,
      null::uuid as sku_id,
      kii.name::text as name,
      kii.unit::text as unit,
      least(1.000000, public.material_alias_candidate_score(p_name, kii.name)
        + case when (
            n.n is not null and exists (
              select 1 from public.stock_material_aliases a
              where a.location = 'q7'
                and a.supplier_id is null
                and a.kitchen_inventory_item_id = kii.id
                and a.normalized_name = n.n
            )
          ) then 0.050000 else 0 end
      ) as score,
      (
        case
          when n.n is not null and public.normalize_stock_item_name(kii.name) = n.n then 'name_exact'
          when cardinality(n.raw_tokens) > 0
            and n.raw_tokens <@ public.stock_catalog_item_tokens(kii.name) then 'name_contains'
          else 'token'
        end
      ) || case when (
            n.n is not null and exists (
              select 1 from public.stock_material_aliases a
              where a.location = 'q7'
                and a.supplier_id is null
                and a.kitchen_inventory_item_id = kii.id
                and a.normalized_name = n.n
            )
          ) then '+shared_alias' else '' end as reason
    from public.kitchen_inventory_items kii
    cross join norm n
    where p_location = 'q7'
      and kii.active = true
      and kii.merged_into_id is null
  ),
  tt as (
    select
      null::uuid as item_id,
      ps.id as sku_id,
      ps.product_name::text as name,
      ps.unit::text as unit,
      least(1.000000, public.material_alias_candidate_score(p_name, ps.product_name)
        + case when (
            n.n is not null and exists (
              select 1 from public.stock_material_aliases a
              where a.location = 'tan_tao'
                and a.supplier_id is null
                and a.tan_tao_sku_id = ps.id
                and a.normalized_name = n.n
            )
          ) then 0.050000 else 0 end
      ) as score,
      (
        case
          when n.n is not null and public.normalize_stock_item_name(ps.product_name) = n.n then 'name_exact'
          when cardinality(n.raw_tokens) > 0
            and n.raw_tokens <@ public.stock_catalog_item_tokens(ps.product_name) then 'name_contains'
          else 'token'
        end
      ) || case when (
            n.n is not null and exists (
              select 1 from public.stock_material_aliases a
              where a.location = 'tan_tao'
                and a.supplier_id is null
                and a.tan_tao_sku_id = ps.id
                and a.normalized_name = n.n
            )
          ) then '+shared_alias' else '' end as reason
    from public.product_skus ps
    cross join norm n
    where p_location = 'tan_tao'
      and upper(ps.sku_code) in ('BMQ-001', 'BMQ-002', 'PATE-500G', 'PATE-200G')
  ),
  combined as (
    select * from q7
    union all
    select * from tt
  )
  select c.item_id, c.sku_id, c.name, c.unit, c.score, c.reason
  from combined c
  where c.score >= 0.300000
  order by c.score desc, c.name asc, c.item_id asc nulls last, c.sku_id asc nulls last
  limit greatest(1, least(coalesce(p_limit, 5), 50));
$$;

-- Canonical cache key for one candidate set: sorted ids joined by '|'.
create or replace function public.material_alias_candidates_hash(p_candidate_ids text[])
returns text
language sql
immutable
set search_path = pg_temp
as $$
  select coalesce(string_agg(x, '|' order by x), '')
  from unnest(coalesce(p_candidate_ids, '{}'::text[])) as x
  where x is not null and btrim(x) <> '';
$$;

-- ---------------------------------------------------------------------------
-- 6. Suggest candidates for a batch of receipt lines (never calls Jev)
-- ---------------------------------------------------------------------------

create or replace function public.suggest_material_aliases(
  p_supplier_id uuid,
  p_location text,
  p_lines jsonb
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_line jsonb;
  v_line_key text;
  v_raw_name text;
  v_raw_unit text;
  v_norm text;
  v_alias public.stock_material_aliases%rowtype;
  v_item_name text;
  v_candidates jsonb;
  v_candidate_ids text[];
  v_candidates_hash text;
  v_cache public.material_alias_jev_cache%rowtype;
  v_alias_json jsonb;
  v_jev jsonb;
  v_pack jsonb;
  v_needs_prompt boolean;
  v_result jsonb := '[]'::jsonb;
begin
  if p_location not in ('q7', 'tan_tao') then
    raise exception 'unsupported_location' using errcode = '22023';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'lines_required' using errcode = '22023';
  end if;
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.material_alias_can_edit(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;
  if jsonb_array_length(p_lines) > 200 then
    raise exception 'too_many_lines' using errcode = '22023';
  end if;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_line_key := nullif(btrim(coalesce(v_line ->> 'line_key', '')), '');
    v_raw_name := coalesce(nullif(btrim(v_line ->> 'raw_name'), ''), '');
    v_raw_unit := nullif(btrim(v_line ->> 'raw_unit'), '');
    if v_line_key is null or v_raw_name = '' then
      continue;
    end if;

    v_norm := public.normalize_stock_item_name(v_raw_name);
    v_alias := null;

    -- Prefer the supplier-specific alias, otherwise show the generic suggestion.
    select * into v_alias
    from public.stock_material_aliases a
    where a.location = p_location
      and a.normalized_name = v_norm
      and a.supplier_id is not distinct from p_supplier_id
    order by a.created_at asc, a.id asc
    limit 1;
    if v_alias.id is null then
      select * into v_alias
      from public.stock_material_aliases a
      where a.location = p_location
        and a.normalized_name = v_norm
        and a.supplier_id is null
      order by a.created_at asc, a.id asc
      limit 1;
    end if;

    v_item_name := null;
    if v_alias.id is not null then
      if p_location = 'q7' then
        select kii.name into v_item_name
        from public.kitchen_inventory_items kii
        where kii.id = v_alias.kitchen_inventory_item_id;
      else
        select ps.product_name into v_item_name
        from public.product_skus ps
        where ps.id = v_alias.tan_tao_sku_id;
      end if;
    end if;

    select coalesce(jsonb_agg(jsonb_build_object(
             'id', coalesce(c.item_id, c.sku_id),
             'item_id', c.item_id,
             'sku_id', c.sku_id,
             'name', c.name,
             'unit', c.unit,
             'score', c.score,
             'reason', c.reason
           ) order by c.score desc, c.name asc, c.item_id asc nulls last, c.sku_id asc nulls last), '[]'::jsonb)
    into v_candidates
    from public.material_alias_candidates(v_raw_name, p_location, 5) c;

    select coalesce(array_agg(elem ->> 'id'), '{}'::text[])
    into v_candidate_ids
    from jsonb_array_elements(v_candidates) elem
    where elem ->> 'id' is not null;
    v_candidates_hash := public.material_alias_candidates_hash(v_candidate_ids);

    v_cache := null;
    select * into v_cache
    from public.material_alias_jev_cache z
    where z.location = p_location
      and z.normalized_name = v_norm
      and z.supplier_id is not distinct from p_supplier_id
      and z.candidates_hash = v_candidates_hash
    order by z.created_at desc, z.id desc
    limit 1;

    if v_alias.id is null then
      v_alias_json := null;
      v_needs_prompt := true;
    else
      v_alias_json := jsonb_build_object(
        'alias_id', v_alias.id,
        'status', v_alias.status,
        'item_id', v_alias.kitchen_inventory_item_id,
        'sku_id', v_alias.tan_tao_sku_id,
        'item_name', v_item_name,
        'unit', v_alias.unit,
        'conversion_factor', v_alias.conversion_factor,
        'pack_label', v_alias.pack_label,
        'confirm_count', v_alias.confirm_count,
        'confirmers_count', cardinality(coalesce(v_alias.confirmers, '{}'::uuid[])),
        'jev_disagreed', v_alias.jev_disagreed
      );
      v_needs_prompt := v_alias.status <> 'auto';
    end if;

    v_pack := public.q7_pack_from_name(v_raw_name, v_raw_unit);

    v_result := v_result || jsonb_build_object(
      'line_key', v_line_key,
      'normalized_name', v_norm,
      'alias', v_alias_json,
      'needs_prompt', v_needs_prompt,
      'candidates', v_candidates,
      'candidates_hash', v_candidates_hash,
      'jev', case when v_cache.id is null then null else v_cache.answer end,
      'pack_guess', v_pack
    );
  end loop;

  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Confirm an alias (human decision) and apply it to the receipt lines
-- ---------------------------------------------------------------------------

create or replace function public.confirm_material_alias(
  p_supplier_id uuid,
  p_location text,
  p_raw_name text,
  p_raw_unit text,
  p_kitchen_inventory_item_id uuid,
  p_tan_tao_sku_id uuid,
  p_entered_unit_label text,
  p_conversion_factor numeric,
  p_jev_item_id uuid,
  p_jev_probability numeric,
  p_source_table text,
  p_source_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_array uuid[];
  v_norm text;
  v_unit text;
  v_pack_label text;
  v_alias public.stock_material_aliases%rowtype;
  v_same boolean;
  v_action text;
  v_jev_disagreed boolean;
  v_new_item uuid;
  v_new_sku uuid;
  v_chosen uuid;
  v_confirmers uuid[];
  v_distinct integer;
  v_cutover date;
  v_target record;
  v_applied integer := 0;
begin
  if p_location not in ('q7', 'tan_tao') then
    raise exception 'unsupported_location' using errcode = '22023';
  end if;
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.material_alias_can_edit(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  v_actor_array := case when v_actor is null then '{}'::uuid[] else array[v_actor] end;
  v_norm := public.normalize_stock_item_name(p_raw_name);
  if v_norm is null then raise exception 'item_name_required' using errcode = '22023'; end if;
  if p_conversion_factor is null or p_conversion_factor <= 0
     or p_conversion_factor::text in ('NaN', 'Infinity', '-Infinity') then
    raise exception 'invalid_conversion_factor' using errcode = '22023';
  end if;

  if p_location = 'q7' then
    if p_kitchen_inventory_item_id is null then
      raise exception 'kitchen_inventory_item_required' using errcode = '22023';
    end if;
    select kii.unit into v_unit
    from public.kitchen_inventory_items kii
    where kii.id = p_kitchen_inventory_item_id
      and kii.active = true
      and kii.merged_into_id is null;
    if v_unit is null then raise exception 'q7_item_not_found' using errcode = 'P0002'; end if;
    v_new_item := p_kitchen_inventory_item_id;
    v_new_sku := null;
  else
    if p_tan_tao_sku_id is null then
      raise exception 'tan_tao_sku_required' using errcode = '22023';
    end if;
    select ps.unit into v_unit
    from public.product_skus ps
    where ps.id = p_tan_tao_sku_id
      and upper(ps.sku_code) in ('BMQ-001', 'BMQ-002', 'PATE-500G', 'PATE-200G');
    if v_unit is null then raise exception 'tan_tao_sku_not_found' using errcode = 'P0002'; end if;
    v_new_item := null;
    v_new_sku := p_tan_tao_sku_id;
  end if;

  v_pack_label := nullif(btrim(coalesce(p_entered_unit_label, '')), '');
  if v_pack_label is null then
    v_pack_label := public.q7_pack_from_name(p_raw_name, p_raw_unit) ->> 'pack_label';
  end if;

  v_chosen := coalesce(v_new_item, v_new_sku);
  v_jev_disagreed := p_jev_item_id is not null
    and p_jev_item_id is distinct from v_chosen
    and coalesce(p_jev_probability, 0) >= 0.9;

  select * into v_alias
  from public.stock_material_aliases a
  where a.location = p_location
    and a.normalized_name = v_norm
    and a.supplier_id is not distinct from p_supplier_id
  for update;

  if not found then
    insert into public.stock_material_aliases(
      supplier_id, normalized_name, location, kitchen_inventory_item_id,
      tan_tao_sku_id, conversion_factor, unit, created_by,
      confirm_count, confirmers, status, pack_label, last_confirmed_at,
      jev_item_id, jev_probability, jev_disagreed
    ) values (
      p_supplier_id, v_norm, p_location, v_new_item,
      v_new_sku, p_conversion_factor, v_unit, v_actor,
      1, v_actor_array, 'learning', v_pack_label, now(),
      p_jev_item_id, p_jev_probability, v_jev_disagreed
    )
    returning * into v_alias;
    v_action := 'confirm';
    insert into public.material_alias_events(
      alias_id, action, actor_id, source_table, source_id, raw_name, raw_unit,
      new_item_id, new_sku_id, new_factor, jev_item_id, jev_probability
    ) values (
      v_alias.id, 'confirm', v_actor, p_source_table, p_source_id, p_raw_name, p_raw_unit,
      v_new_item, v_new_sku, p_conversion_factor, p_jev_item_id, p_jev_probability
    );
  else
    v_same := (v_alias.kitchen_inventory_item_id is not distinct from v_new_item)
      and (v_alias.tan_tao_sku_id is not distinct from v_new_sku)
      and (v_alias.conversion_factor = p_conversion_factor);

    if v_same then
      v_confirmers := coalesce(v_alias.confirmers, '{}'::uuid[]);
      if v_actor is not null and not (v_actor = any (v_confirmers)) then
        v_confirmers := v_confirmers || v_actor;
      end if;
      update public.stock_material_aliases
        set confirm_count = v_alias.confirm_count + 1,
            confirmers = v_confirmers,
            last_confirmed_at = now(),
            pack_label = coalesce(v_pack_label, pack_label),
            jev_item_id = p_jev_item_id,
            jev_probability = p_jev_probability,
            jev_disagreed = v_jev_disagreed,
            updated_at = now()
        where id = v_alias.id
        returning * into v_alias;
      v_action := 'confirm';
      insert into public.material_alias_events(
        alias_id, action, actor_id, source_table, source_id, raw_name, raw_unit,
        new_item_id, new_sku_id, new_factor, jev_item_id, jev_probability
      ) values (
        v_alias.id, 'confirm', v_actor, p_source_table, p_source_id, p_raw_name, p_raw_unit,
        v_new_item, v_new_sku, p_conversion_factor, p_jev_item_id, p_jev_probability
      );
    else
      v_action := 'correct';
      insert into public.material_alias_events(
        alias_id, action, actor_id, source_table, source_id, raw_name, raw_unit,
        previous_item_id, previous_sku_id, previous_factor,
        new_item_id, new_sku_id, new_factor, jev_item_id, jev_probability
      ) values (
        v_alias.id, 'correct', v_actor, p_source_table, p_source_id, p_raw_name, p_raw_unit,
        v_alias.kitchen_inventory_item_id, v_alias.tan_tao_sku_id, v_alias.conversion_factor,
        v_new_item, v_new_sku, p_conversion_factor, p_jev_item_id, p_jev_probability
      );
      update public.stock_material_aliases
        set kitchen_inventory_item_id = v_new_item,
            tan_tao_sku_id = v_new_sku,
            conversion_factor = p_conversion_factor,
            unit = v_unit,
            pack_label = v_pack_label,
            confirm_count = 1,
            confirmers = v_actor_array,
            status = 'learning',
            last_confirmed_at = now(),
            jev_item_id = p_jev_item_id,
            jev_probability = p_jev_probability,
            jev_disagreed = v_jev_disagreed,
            updated_at = now()
        where id = v_alias.id
        returning * into v_alias;
    end if;
  end if;

  -- Auto-promote only when the state actually changes.
  select count(distinct c) into v_distinct
  from unnest(coalesce(v_alias.confirmers, '{}'::uuid[])) c;
  if (v_alias.confirm_count >= 3 or v_distinct >= 2) and v_alias.status <> 'auto' then
    update public.stock_material_aliases
      set status = 'auto', updated_at = now()
      where id = v_alias.id
      returning * into v_alias;
    insert into public.material_alias_events(
      alias_id, action, actor_id, source_table, source_id, raw_name, raw_unit,
      new_item_id, new_sku_id, new_factor
    ) values (
      v_alias.id, 'auto_promoted', v_actor, p_source_table, p_source_id, p_raw_name, p_raw_unit,
      v_alias.kitchen_inventory_item_id, v_alias.tan_tao_sku_id, v_alias.conversion_factor
    );
  end if;

  -- Apply the confirmed alias to the already-confirmed receipt lines of the same
  -- supplier, exactly like resolve_stock_alias does.
  v_cutover := public.stock_ledger_cutover_date(p_location);
  for v_target in
    select gri.id
    from public.goods_receipt_items gri
    join public.goods_receipts gr on gr.id = gri.goods_receipt_id
    where gr.supplier_id is not distinct from p_supplier_id
      and gr.receiving_location = p_location
      and gr.status in ('confirmed', 'received')
      and (v_cutover is null or gr.receipt_date >= v_cutover)
      and public.normalize_stock_item_name(
            coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
          ) = v_norm
    order by gr.receipt_date asc, gri.created_at asc, gri.id asc
  loop
    if not public.stock_goods_receipt_item_is_posted(v_target.id) then
      if public.post_stock_goods_receipt_item(v_target.id, v_alias) then
        v_applied := v_applied + 1;
      end if;
    end if;
  end loop;

  return jsonb_build_object(
    'status', v_action,
    'alias', to_jsonb(v_alias),
    'applied_lines', v_applied,
    'promoted', v_alias.status = 'auto'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Undo one event (owner or Q7 stock editor)
-- ---------------------------------------------------------------------------

create or replace function public.undo_material_alias_event(p_event_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_event public.material_alias_events%rowtype;
  v_alias public.stock_material_aliases%rowtype;
  v_restored_item uuid;
  v_restored_sku uuid;
  v_restored_factor numeric;
  v_restored_unit text;
  v_count integer;
  v_confirmers uuid[];
  v_distinct integer;
  v_applied integer := 0;
  v_warning text := null;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.material_alias_can_admin(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  select * into v_event
  from public.material_alias_events
  where id = p_event_id
  for update;
  if not found then raise exception 'event_not_found' using errcode = 'P0002'; end if;
  if v_event.action = 'undo' then
    raise exception 'cannot_undo_undo' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.material_alias_events u
    where u.action = 'undo' and u.undo_of_event_id = p_event_id
  ) then
    raise exception 'event_already_undone' using errcode = '23514';
  end if;
  if v_event.alias_id is null then
    raise exception 'event_without_alias' using errcode = '22023';
  end if;

  select * into v_alias
  from public.stock_material_aliases
  where id = v_event.alias_id
  for update;
  if not found then raise exception 'alias_not_found' using errcode = 'P0002'; end if;

  if v_event.action = 'correct' then
    v_restored_item := v_event.previous_item_id;
    v_restored_sku := v_event.previous_sku_id;
    v_restored_factor := coalesce(v_event.previous_factor, 1);
    v_restored_unit := v_alias.unit;
    if v_alias.location = 'q7' and v_restored_item is not null then
      select kii.unit into v_restored_unit
      from public.kitchen_inventory_items kii
      where kii.id = v_restored_item;
    elsif v_alias.location = 'tan_tao' and v_restored_sku is not null then
      select ps.unit into v_restored_unit
      from public.product_skus ps
      where ps.id = v_restored_sku;
    end if;

    select count(*), count(distinct e.actor_id)
      into v_count, v_distinct
    from public.material_alias_events e
    where e.alias_id = v_alias.id
      and e.action = 'confirm'
      and e.id <> p_event_id
      and not exists (
        select 1 from public.material_alias_events u
        where u.action = 'undo' and u.undo_of_event_id = e.id
      )
      and (e.new_item_id is not distinct from v_restored_item)
      and (e.new_sku_id is not distinct from v_restored_sku)
      and (e.new_factor = v_restored_factor);
    if v_count = 0 then v_count := 1; end if;

    select coalesce(array_agg(distinct e.actor_id) filter (where e.actor_id is not null), '{}'::uuid[])
      into v_confirmers
    from public.material_alias_events e
    where e.alias_id = v_alias.id
      and e.action = 'confirm'
      and e.id <> p_event_id
      and not exists (
        select 1 from public.material_alias_events u
        where u.action = 'undo' and u.undo_of_event_id = e.id
      )
      and (e.new_item_id is not distinct from v_restored_item)
      and (e.new_sku_id is not distinct from v_restored_sku)
      and (e.new_factor = v_restored_factor);

    update public.stock_material_aliases
      set kitchen_inventory_item_id = v_restored_item,
          tan_tao_sku_id = v_restored_sku,
          conversion_factor = v_restored_factor,
          unit = coalesce(v_restored_unit, unit),
          confirm_count = v_count,
          confirmers = v_confirmers,
          status = case when v_count >= 3 or v_distinct >= 2 then 'auto' else 'learning' end,
          updated_at = now()
      where id = v_alias.id
      returning * into v_alias;
  elsif v_event.action = 'confirm' then
    if exists (
      select 1 from public.material_alias_events e
      where e.alias_id = v_alias.id
        and e.action = 'confirm'
        and e.id <> p_event_id
        and not exists (
          select 1 from public.material_alias_events u
          where u.action = 'undo' and u.undo_of_event_id = e.id
        )
        and (e.created_at, e.id) > (v_event.created_at, v_event.id)
    ) then
      raise exception 'not_latest_confirm' using errcode = '23514';
    end if;

    v_count := greatest(0, v_alias.confirm_count - 1);
    v_confirmers := coalesce(v_alias.confirmers, '{}'::uuid[]);
    if v_event.actor_id is not null and not exists (
      select 1 from public.material_alias_events e
      where e.alias_id = v_alias.id
        and e.action = 'confirm'
        and e.id <> p_event_id
        and e.actor_id = v_event.actor_id
        and not exists (
          select 1 from public.material_alias_events u
          where u.action = 'undo' and u.undo_of_event_id = e.id
        )
    ) then
      v_confirmers := array_remove(v_confirmers, v_event.actor_id);
    end if;
    select count(distinct c) into v_distinct from unnest(v_confirmers) c;

    update public.stock_material_aliases
      set confirm_count = v_count,
          confirmers = v_confirmers,
          status = case when v_count >= 3 or v_distinct >= 2 then 'auto' else 'learning' end,
          updated_at = now()
      where id = v_alias.id
      returning * into v_alias;
  else
    -- auto_promoted / disabled: fall back to learning.
    update public.stock_material_aliases
      set status = 'learning', updated_at = now()
      where id = v_alias.id
      returning * into v_alias;
  end if;

  -- The ledger is append-only; warn instead of deleting posted movements.
  select count(*) into v_applied
  from public.goods_receipt_items gri
  join public.goods_receipts gr on gr.id = gri.goods_receipt_id
  where gr.supplier_id is not distinct from v_alias.supplier_id
    and gr.receiving_location = v_alias.location
    and gr.status in ('confirmed', 'received')
    and public.normalize_stock_item_name(
          coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
        ) = v_alias.normalized_name
    and public.stock_goods_receipt_item_is_posted(gri.id);
  if v_applied > 0 then
    v_warning := 'Bí danh đã áp lên ' || v_applied::text
      || ' dòng phiếu nhập kho. Không xoá bút toán sổ tồn đã ghi; kế toán xử lý ở Sổ tồn NVL.';
  end if;

  insert into public.material_alias_events(
    alias_id, action, actor_id, source_table, source_id, raw_name, raw_unit,
    undo_of_event_id, new_item_id, new_sku_id, new_factor
  ) values (
    v_alias.id, 'undo', v_actor, 'material_alias_events', p_event_id,
    v_event.raw_name, v_event.raw_unit,
    p_event_id, v_alias.kitchen_inventory_item_id, v_alias.tan_tao_sku_id, v_alias.conversion_factor
  );

  return jsonb_build_object(
    'status', 'undone',
    'alias', to_jsonb(v_alias),
    'warning', v_warning,
    'applied_lines', v_applied
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Explicit status change (owner or Q7 stock editor)
-- ---------------------------------------------------------------------------

create or replace function public.set_material_alias_status(
  p_alias_id uuid,
  p_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_alias public.stock_material_aliases%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.material_alias_can_admin(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;
  if p_status not in ('auto', 'disabled') then
    raise exception 'status_invalid' using errcode = '22023';
  end if;

  select * into v_alias from public.stock_material_aliases where id = p_alias_id for update;
  if not found then raise exception 'alias_not_found' using errcode = 'P0002'; end if;

  update public.stock_material_aliases
    set status = p_status, updated_at = now()
    where id = p_alias_id
    returning * into v_alias;

  insert into public.material_alias_events(
    alias_id, action, actor_id, source_table, source_id,
    new_item_id, new_sku_id, new_factor
  ) values (
    v_alias.id,
    case when p_status = 'auto' then 'auto_promoted' else 'disabled' end,
    v_actor, 'stock_material_aliases', v_alias.id,
    v_alias.kitchen_inventory_item_id, v_alias.tan_tao_sku_id, v_alias.conversion_factor
  );

  return jsonb_build_object('status', v_alias.status, 'alias', to_jsonb(v_alias));
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Weekly review list
-- ---------------------------------------------------------------------------

create or replace function public.get_material_alias_review(p_days integer default 7)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_days integer := greatest(1, coalesce(p_days, 7));
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_aliases jsonb := '[]'::jsonb;
  v_summary jsonb;
  v_pending integer := 0;
  v_loc text;
  v_cutover date;
  v_cnt integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.material_alias_can_view(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  select coalesce(jsonb_agg(x.row order by x.jev_disagreed desc, x.last_event_at desc nulls last, x.normalized_name asc), '[]'::jsonb)
  into v_aliases
  from (
    select
      a.jev_disagreed,
      a.normalized_name,
      le.created_at as last_event_at,
      jsonb_build_object(
        'alias_id', a.id,
        'normalized_name', a.normalized_name,
        'supplier_id', a.supplier_id,
        'supplier_name', sup.name,
        'location', a.location,
        'item_id', a.kitchen_inventory_item_id,
        'sku_id', a.tan_tao_sku_id,
        'item_name', coalesce(kii.name, ps.product_name),
        'unit', a.unit,
        'conversion_factor', a.conversion_factor,
        'pack_label', a.pack_label,
        'status', a.status,
        'confirm_count', a.confirm_count,
        'confirmers_count', cardinality(coalesce(a.confirmers, '{}'::uuid[])),
        'jev_disagreed', a.jev_disagreed,
        'last_confirmed_at', a.last_confirmed_at,
        'last_event', case when le.id is null then null else jsonb_build_object(
          'id', le.id,
          'action', le.action,
          'actor_id', le.actor_id,
          'created_at', le.created_at
        ) end,
        'applied_lines', (
          select count(*)
          from public.goods_receipt_items gri
          join public.goods_receipts gr on gr.id = gri.goods_receipt_id
          where gr.supplier_id is not distinct from a.supplier_id
            and gr.receiving_location = a.location
            and gr.status in ('confirmed', 'received')
            and public.normalize_stock_item_name(
                  coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
                ) = a.normalized_name
            and public.stock_goods_receipt_item_is_posted(gri.id)
        )
      ) as row
    from public.stock_material_aliases a
    left join public.suppliers sup on sup.id = a.supplier_id
    left join public.kitchen_inventory_items kii on kii.id = a.kitchen_inventory_item_id
    left join public.product_skus ps on ps.id = a.tan_tao_sku_id
    join lateral (
      select e.* from public.material_alias_events e
      where e.alias_id = a.id
      order by e.created_at desc, e.id desc
      limit 1
    ) le on true
    where exists (
      select 1 from public.material_alias_events e2
      where e2.alias_id = a.id
        and e2.created_at >= now() - make_interval(days => v_days)
    )
  ) x;

  -- Reuse the pending-alias count of get_stock_ledger_overview for both stores.
  foreach v_loc in array array['q7', 'tan_tao'] loop
    v_cutover := public.stock_ledger_cutover_date(v_loc);
    if v_cutover is not null then
      select count(*) into v_cnt
      from public.goods_receipt_items gri
      join public.goods_receipts gr on gr.id = gri.goods_receipt_id
      where gr.receiving_location = v_loc
        and gr.status in ('confirmed', 'received')
        and gr.receipt_date >= v_cutover
        and public.resolve_stock_material_alias(
              gr.supplier_id,
              public.normalize_stock_item_name(
                coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
              ),
              v_loc
            ) is null
        and not public.stock_goods_receipt_item_is_posted(gri.id);
      v_pending := v_pending + v_cnt;
    end if;
  end loop;

  select jsonb_build_object(
    'auto_count', count(*) filter (where status = 'auto'),
    'learning_count', count(*) filter (where status = 'learning'),
    'disabled_count', count(*) filter (where status = 'disabled'),
    'pending_lines', v_pending,
    'jev_usage', jsonb_build_object(
      'usage_date', v_today,
      'calls', coalesce(u.calls, 0),
      'cost', coalesce(u.cost, 0),
      'call_limit', coalesce(u.call_limit, 600)
    )
  )
  into v_summary
  from public.stock_material_aliases a
  left join public.stock_catalog_jev_usage u on u.usage_date = v_today
  group by u.calls, u.cost, u.call_limit;

  return jsonb_build_object(
    'days', v_days,
    'aliases', v_aliases,
    'summary', coalesce(v_summary, jsonb_build_object(
      'auto_count', 0, 'learning_count', 0, 'disabled_count', 0, 'pending_lines', v_pending,
      'jev_usage', jsonb_build_object('usage_date', v_today, 'calls', 0, 'cost', 0, 'call_limit', 600)
    ))
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 11. Backlog reader for the edge function (confirmed receipts, last 90 days)
-- ---------------------------------------------------------------------------

create or replace function public.get_material_alias_backlog(
  p_location text default 'q7',
  p_limit integer default 200
)
returns table (
  supplier_id uuid,
  normalized_name text,
  raw_name text,
  raw_unit text,
  location text,
  receipt_count bigint
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with lines as (
    select
      gr.supplier_id as supplier_id,
      gr.receiving_location as location,
      public.normalize_stock_item_name(
        coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
      ) as normalized_name,
      coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name) as raw_name,
      gri.unit as raw_unit
    from public.goods_receipt_items gri
    join public.goods_receipts gr on gr.id = gri.goods_receipt_id
    where gr.status in ('confirmed', 'received')
      and gr.receiving_location = p_location
      and p_location in ('q7', 'tan_tao')
      and gr.receipt_date >= (now() at time zone 'Asia/Ho_Chi_Minh')::date - 90
  )
  select
    l.supplier_id,
    l.normalized_name,
    min(l.raw_name) as raw_name,
    min(l.raw_unit) as raw_unit,
    l.location,
    count(*)::bigint as receipt_count
  from lines l
  where l.normalized_name is not null
    and not exists (
      select 1 from public.stock_material_aliases a
      where a.location = l.location
        and a.normalized_name = l.normalized_name
        and a.supplier_id is not distinct from l.supplier_id
    )
  group by l.supplier_id, l.normalized_name, l.location
  order by count(*) desc, l.normalized_name asc
  limit greatest(1, least(coalesce(p_limit, 200), 200));
$$;

-- ---------------------------------------------------------------------------
-- 12. RLS and explicit grants
-- ---------------------------------------------------------------------------

alter table public.material_alias_events enable row level security;
alter table public.material_alias_jev_cache enable row level security;

-- Aliases stay readable through the existing location policy, plus the PO /
-- payment viewer roles added here.
drop policy if exists stock_material_aliases_alias_learning_select on public.stock_material_aliases;
create policy stock_material_aliases_alias_learning_select on public.stock_material_aliases
  for select to authenticated
  using (public.material_alias_can_view((select auth.uid())));

drop policy if exists material_alias_events_select on public.material_alias_events;
create policy material_alias_events_select on public.material_alias_events
  for select to authenticated
  using (public.material_alias_can_view((select auth.uid())));

drop policy if exists material_alias_jev_cache_select on public.material_alias_jev_cache;
create policy material_alias_jev_cache_select on public.material_alias_jev_cache
  for select to authenticated
  using (public.material_alias_can_view((select auth.uid())));

-- Read-only for signed-in users; every write goes through a security definer RPC
-- (or the service role used by the edge function).
drop policy if exists stock_material_aliases_insert on public.stock_material_aliases;
drop policy if exists stock_material_aliases_update on public.stock_material_aliases;
drop policy if exists stock_material_aliases_delete on public.stock_material_aliases;
revoke insert, update, delete on table public.stock_material_aliases from public, anon, authenticated;
grant select, insert, update, delete on table public.stock_material_aliases to service_role;

revoke all on table public.material_alias_events from public, anon, authenticated;
grant select on table public.material_alias_events to authenticated, service_role;
grant insert, update, delete on table public.material_alias_events to service_role;

revoke all on table public.material_alias_jev_cache from public, anon, authenticated;
grant select on table public.material_alias_jev_cache to authenticated, service_role;
grant insert, update, delete on table public.material_alias_jev_cache to service_role;

-- ---------------------------------------------------------------------------
-- 13. Function grants
-- ---------------------------------------------------------------------------

revoke all on function public.material_alias_can_view(uuid) from public, anon;
grant execute on function public.material_alias_can_view(uuid) to authenticated, service_role;

revoke all on function public.material_alias_can_edit(uuid) from public, anon;
grant execute on function public.material_alias_can_edit(uuid) to authenticated, service_role;

revoke all on function public.material_alias_can_admin(uuid) from public, anon;
grant execute on function public.material_alias_can_admin(uuid) to authenticated, service_role;

revoke all on function public.material_alias_candidate_score(text, text) from public, anon;
grant execute on function public.material_alias_candidate_score(text, text) to authenticated, service_role;

revoke all on function public.material_alias_candidates(text, text, integer) from public, anon;
grant execute on function public.material_alias_candidates(text, text, integer) to authenticated, service_role;

revoke all on function public.material_alias_candidates_hash(text[]) from public, anon;
grant execute on function public.material_alias_candidates_hash(text[]) to authenticated, service_role;

revoke all on function public.suggest_material_aliases(uuid, text, jsonb) from public, anon;
grant execute on function public.suggest_material_aliases(uuid, text, jsonb) to authenticated, service_role;

revoke all on function public.confirm_material_alias(uuid, text, text, text, uuid, uuid, text, numeric, uuid, numeric, text, uuid) from public, anon;
grant execute on function public.confirm_material_alias(uuid, text, text, text, uuid, uuid, text, numeric, uuid, numeric, text, uuid) to authenticated, service_role;

revoke all on function public.undo_material_alias_event(uuid) from public, anon;
grant execute on function public.undo_material_alias_event(uuid) to authenticated, service_role;

revoke all on function public.set_material_alias_status(uuid, text) from public, anon;
grant execute on function public.set_material_alias_status(uuid, text) to authenticated, service_role;

revoke all on function public.get_material_alias_review(integer) from public, anon;
grant execute on function public.get_material_alias_review(integer) to authenticated, service_role;

revoke all on function public.get_material_alias_backlog(text, integer) from public, anon, authenticated;
grant execute on function public.get_material_alias_backlog(text, integer) to service_role;
