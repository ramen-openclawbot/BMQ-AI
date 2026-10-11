-- Giai đoạn 6 (2026-10-21): phân loại hàng mua 60 ngày chưa có mã kho.
--
-- Additive migration on top of 20261016100000 + 20261017100000 +
-- 20261018100000 + 20261019100000 + 20261020100000. It stores one review row per
-- group of receipt names that still have no stock-material alias and no kitchen
-- item, exposes the 60-day unmatched names to the edge function, records the Jev
-- suggestion (same-item grouping + one item class per group) and applies one
-- accepted group: create (or reuse) the kitchen item, record its class and confirm
-- the alias of every way of writing in the group.
--
-- Nothing here updates or deletes purchase_orders, purchase_order_items,
-- payment_requests, payment_request_items, goods_receipts, goods_receipt_items or
-- q7_inventory_movements. The only stock effect is still the existing
-- post_stock_goods_receipt_item helper reached through confirm_material_alias.

-- ---------------------------------------------------------------------------
-- 0. kitchen_inventory_items.item_class_source accepts the review decision
-- ---------------------------------------------------------------------------

-- 20261015100000 allowed only 'jev' and 'manual'. A new-item review decision is a
-- third, explicit source.
alter table public.kitchen_inventory_items
  drop constraint if exists kitchen_inventory_items_item_class_source_check;
alter table public.kitchen_inventory_items
  add constraint kitchen_inventory_items_item_class_source_check
  check (item_class_source is null or item_class_source in ('jev', 'manual', 'new_item_review'));

-- ---------------------------------------------------------------------------
-- 1. stock_new_item_suggestions: one row per (location, cluster_key)
-- ---------------------------------------------------------------------------

create table if not exists public.stock_new_item_suggestions (
  id uuid primary key default gen_random_uuid(),
  location text not null check (location in ('q7', 'tan_tao')),
  cluster_key text not null,
  members jsonb not null default '[]'::jsonb,
  suggested_name text not null,
  suggested_unit text,
  suggested_class text,
  class_probability numeric(5, 4),
  receipt_count integer not null default 0,
  receipt_days integer not null default 0,
  first_date date,
  last_date date,
  is_recurring boolean not null default false,
  status text not null default 'pending',
  item_id uuid references public.kitchen_inventory_items(id) on delete set null,
  prompt_version text,
  decided_by uuid references auth.users(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint stock_new_item_suggestions_cluster_key_check check (btrim(cluster_key) <> ''),
  constraint stock_new_item_suggestions_members_check check (jsonb_typeof(members) = 'array'),
  constraint stock_new_item_suggestions_receipt_count_check check (receipt_count >= 0),
  constraint stock_new_item_suggestions_receipt_days_check check (receipt_days >= 0),
  constraint stock_new_item_suggestions_status_check check (status in ('pending', 'applied', 'dismissed')),
  constraint stock_new_item_suggestions_class_check check (
    suggested_class is null
    or suggested_class in ('raw_material', 'packaging_supply', 'non_stock')
  ),
  constraint stock_new_item_suggestions_probability_check check (
    class_probability is null
    or (class_probability >= 0 and class_probability <= 1)
  )
);

create unique index if not exists stock_new_item_suggestions_key_uidx
  on public.stock_new_item_suggestions(location, cluster_key);

create index if not exists idx_stock_new_item_suggestions_pending
  on public.stock_new_item_suggestions(location, status, is_recurring desc, receipt_count desc);

-- ---------------------------------------------------------------------------
-- 2. Unmatched 60-day purchase names (service role only)
-- ---------------------------------------------------------------------------

-- Same conditions as get_material_alias_backlog: a confirmed / received receipt,
-- the receiving location (falling back to the supplier default and then q7), a
-- supplier that is not stock_exempt, a line the fixed rule does not already call
-- non-stock / fee / service, and no stock_material_aliases row yet. It also
-- returns has_exact_candidate and the latest current-prompt match answer so the
-- caller can leave the names that belong to the "chờ gán mã" list alone.
create or replace function public.list_unmatched_purchase_names(
  p_location text,
  p_days integer default 60
)
returns table (
  supplier_id uuid,
  normalized_name text,
  raw_name text,
  raw_unit text,
  receipt_count bigint,
  receipt_days bigint,
  first_date date,
  last_date date,
  has_exact_candidate boolean,
  cached_match_item_id uuid,
  cached_match_line_type text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_days integer := greatest(1, least(coalesce(p_days, 60), 365));
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_prompt text := 'jev-material-alias-2026-10-20.1';
begin
  if p_location not in ('q7', 'tan_tao') then
    raise exception 'unsupported_location' using errcode = '22023';
  end if;
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  with lines as (
    select
      gr.supplier_id as supplier_id,
      coalesce(gr.receiving_location, s.default_receiving_location, 'q7') as location,
      public.normalize_stock_item_name(
        coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
      ) as normalized_name,
      coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name) as raw_name,
      gri.unit as raw_unit,
      gr.receipt_date as receipt_date
    from public.goods_receipt_items gri
    join public.goods_receipts gr on gr.id = gri.goods_receipt_id
    left join public.suppliers s on s.id = gr.supplier_id
    where gr.status in ('confirmed', 'received')
      and coalesce(s.stock_exempt, false) = false
      and coalesce(gr.receiving_location, s.default_receiving_location, 'q7') = p_location
      and p_location in ('q7', 'tan_tao')
      and public.stock_line_auto_non_stock(
            coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
          ) is null
      and gr.receipt_date >= v_today - v_days
  ),
  pending as (
    select
      l.supplier_id,
      l.location,
      l.normalized_name,
      count(*)::bigint as receipt_count,
      count(distinct l.receipt_date)::bigint as receipt_days,
      min(l.receipt_date) as first_date,
      max(l.receipt_date) as last_date,
      (array_agg(l.raw_name order by l.receipt_date desc, l.raw_name))[1] as raw_name,
      (array_agg(l.raw_unit order by l.receipt_date desc, l.raw_name))[1] as raw_unit
    from lines l
    where l.normalized_name is not null
      and not exists (
        select 1 from public.stock_material_aliases a
        where a.location = l.location
          and a.normalized_name = l.normalized_name
          and a.supplier_id is not distinct from l.supplier_id
      )
    group by l.supplier_id, l.location, l.normalized_name
  )
  select
    p.supplier_id,
    p.normalized_name,
    p.raw_name,
    p.raw_unit,
    p.receipt_count,
    p.receipt_days,
    p.first_date,
    p.last_date,
    exists (
      select 1
      from public.material_alias_candidates(p.raw_name, p.location, 5) c
      where c.reason like 'name_exact%'
    ) as has_exact_candidate,
    nullif(cache.answer ->> 'item_id', '')::uuid as cached_match_item_id,
    cache.answer ->> 'line_type' as cached_match_line_type
  from pending p
  left join lateral (
    select z.answer
    from public.material_alias_jev_cache z
    where z.location = p.location
      and z.normalized_name = p.normalized_name
      and z.supplier_id is not distinct from p.supplier_id
      and z.prompt_version = v_prompt
    order by z.created_at desc, z.id desc
    limit 1
  ) cache on true
  order by p.receipt_count desc, p.normalized_name asc;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Upsert one batch of grouped suggestions (service role only)
-- ---------------------------------------------------------------------------

-- Never overwrites a group the reviewer already applied or dismissed.
create or replace function public.upsert_new_item_suggestions(
  p_location text,
  p_rows jsonb
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row jsonb;
  v_written integer;
  v_count integer := 0;
begin
  if p_location not in ('q7', 'tan_tao') then
    raise exception 'unsupported_location' using errcode = '22023';
  end if;
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'rows_required' using errcode = '22023';
  end if;
  if jsonb_array_length(p_rows) > 500 then
    raise exception 'too_many_rows' using errcode = '22023';
  end if;

  for v_row in select value from jsonb_array_elements(p_rows) loop
    -- A regrouped name must not stay in an older pending group: drop pending
    -- groups (other keys) that share any member with the incoming group.
    delete from public.stock_new_item_suggestions s
    where s.location = p_location
      and s.status = 'pending'
      and s.cluster_key <> btrim(v_row ->> 'cluster_key')
      and exists (
        select 1
        from jsonb_array_elements(s.members) m
        join jsonb_array_elements(coalesce(v_row -> 'members', '[]'::jsonb)) n
          on m ->> 'normalized_name' = n ->> 'normalized_name'
      );

    insert into public.stock_new_item_suggestions (
      location, cluster_key, members, suggested_name, suggested_unit,
      suggested_class, class_probability, receipt_count, receipt_days,
      first_date, last_date, is_recurring, prompt_version, updated_at
    ) values (
      p_location,
      btrim(v_row ->> 'cluster_key'),
      coalesce(v_row -> 'members', '[]'::jsonb),
      coalesce(nullif(btrim(v_row ->> 'suggested_name'), ''), 'Chưa rõ'),
      nullif(btrim(v_row ->> 'suggested_unit'), ''),
      nullif(btrim(v_row ->> 'suggested_class'), ''),
      nullif(v_row ->> 'class_probability', '')::numeric,
      greatest(coalesce((v_row ->> 'receipt_count')::integer, 0), 0),
      greatest(coalesce((v_row ->> 'receipt_days')::integer, 0), 0),
      nullif(v_row ->> 'first_date', '')::date,
      nullif(v_row ->> 'last_date', '')::date,
      coalesce((v_row ->> 'is_recurring')::boolean, false),
      coalesce(nullif(btrim(v_row ->> 'prompt_version'), ''), 'jev-new-item-2026-10-21.1'),
      now()
    )
    on conflict (location, cluster_key) do update
      set members = excluded.members,
          suggested_name = excluded.suggested_name,
          suggested_unit = excluded.suggested_unit,
          suggested_class = excluded.suggested_class,
          class_probability = excluded.class_probability,
          receipt_count = excluded.receipt_count,
          receipt_days = excluded.receipt_days,
          first_date = excluded.first_date,
          last_date = excluded.last_date,
          is_recurring = excluded.is_recurring,
          prompt_version = excluded.prompt_version,
          updated_at = now()
      where public.stock_new_item_suggestions.status = 'pending';

    get diagnostics v_written = row_count;
    v_count := v_count + v_written;
  end loop;

  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Apply one group (owner / Q7 stock editor only)
-- ---------------------------------------------------------------------------

-- Idempotent by p_request_id: create_stock_material_item reuses / replays the
-- item, an already applied group returns its previous result, and a repeated
-- confirm_material_alias on the same alias simply counts one more confirmation.
create or replace function public.apply_new_item_suggestion(
  p_suggestion_id uuid,
  p_name text,
  p_unit text,
  p_item_class text,
  p_members jsonb,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_suggestion public.stock_new_item_suggestions%rowtype;
  v_member jsonb;
  v_source_member jsonb;
  v_supplier uuid;
  v_norm text;
  v_factor numeric;
  v_raw_name text;
  v_raw_unit text;
  v_item_id uuid;
  v_created jsonb;
  v_applied integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not public.material_alias_can_admin(v_actor) then
      raise exception 'create_item_forbidden' using errcode = '42501';
    end if;
  end if;
  if p_item_class is null or p_item_class not in ('raw_material', 'packaging_supply', 'non_stock') then
    raise exception 'item_class_invalid' using errcode = '22023';
  end if;
  if p_members is null or jsonb_typeof(p_members) <> 'array' or jsonb_array_length(p_members) = 0 then
    raise exception 'members_required' using errcode = '22023';
  end if;

  select * into v_suggestion
  from public.stock_new_item_suggestions
  where id = p_suggestion_id
  for update;
  if not found then
    raise exception 'suggestion_not_found' using errcode = 'P0002';
  end if;
  if v_suggestion.status = 'applied' then
    return jsonb_build_object(
      'status', 'already_applied',
      'suggestion_id', p_suggestion_id,
      'item_id', v_suggestion.item_id,
      'item_class', v_suggestion.suggested_class,
      'members_applied', 0
    );
  end if;
  if v_suggestion.status = 'dismissed' then
    raise exception 'suggestion_dismissed' using errcode = '23514';
  end if;

  -- Every input member must belong to the stored suggestion.
  for v_member in select value from jsonb_array_elements(p_members) loop
    v_supplier := nullif(btrim(v_member ->> 'supplier_id'), '')::uuid;
    v_norm := btrim(coalesce(v_member ->> 'normalized_name', ''));
    if v_norm = '' then
      raise exception 'member_not_in_suggestion' using errcode = '22023';
    end if;
    if not exists (
      select 1
      from jsonb_array_elements(v_suggestion.members) as m(value)
      where nullif(btrim(m.value ->> 'supplier_id'), '')::uuid is not distinct from v_supplier
        and btrim(coalesce(m.value ->> 'normalized_name', '')) = v_norm
    ) then
      raise exception 'member_not_in_suggestion' using errcode = '22023';
    end if;
    if nullif(btrim(v_member ->> 'conversion_factor'), '') is null
       or (v_member ->> 'conversion_factor')::numeric <= 0
       or (v_member ->> 'conversion_factor')::numeric::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception 'invalid_conversion_factor' using errcode = '22023';
    end if;
  end loop;

  if p_item_class <> 'non_stock' then
    if coalesce(btrim(p_name), '') = '' then
      raise exception 'item_name_required' using errcode = '22023';
    end if;
    if coalesce(btrim(p_unit), '') = '' then
      raise exception 'item_unit_required' using errcode = '22023';
    end if;
    v_created := public.create_stock_material_item(p_name, p_unit, v_suggestion.location, p_request_id);
    v_item_id := nullif(v_created ->> 'item_id', '')::uuid;
    if v_item_id is null then
      raise exception 'item_creation_failed' using errcode = 'P0002';
    end if;
    update public.kitchen_inventory_items
      set item_class = p_item_class,
          item_class_source = 'new_item_review',
          updated_at = now()
      where id = v_item_id;
  else
    v_item_id := null;
  end if;

  for v_member in select value from jsonb_array_elements(p_members) loop
    v_supplier := nullif(btrim(v_member ->> 'supplier_id'), '')::uuid;
    v_norm := btrim(coalesce(v_member ->> 'normalized_name', ''));
    v_factor := (v_member ->> 'conversion_factor')::numeric;
    select m.value into v_source_member
    from jsonb_array_elements(v_suggestion.members) as m(value)
    where nullif(btrim(m.value ->> 'supplier_id'), '')::uuid is not distinct from v_supplier
      and btrim(coalesce(m.value ->> 'normalized_name', '')) = v_norm
    limit 1;
    v_raw_name := coalesce(nullif(btrim(v_source_member ->> 'raw_name'), ''), v_norm);
    v_raw_unit := nullif(btrim(v_source_member ->> 'raw_unit'), '');

    perform public.confirm_material_alias(
      p_supplier_id => v_supplier,
      p_location => v_suggestion.location,
      p_raw_name => v_raw_name,
      p_raw_unit => v_raw_unit,
      p_kitchen_inventory_item_id => v_item_id,
      p_tan_tao_sku_id => null,
      p_entered_unit_label => nullif(btrim(v_member ->> 'entered_unit_label'), ''),
      p_conversion_factor => case when p_item_class = 'non_stock' then 1 else v_factor end,
      p_jev_item_id => null,
      p_jev_probability => null,
      p_source_table => 'stock_new_item_suggestions',
      p_source_id => p_suggestion_id,
      p_line_class => case when p_item_class = 'non_stock' then 'non_stock' else 'stock' end
    );
    v_applied := v_applied + 1;
  end loop;

  update public.stock_new_item_suggestions
    set status = 'applied',
        item_id = v_item_id,
        suggested_class = p_item_class,
        decided_by = v_actor,
        decided_at = now(),
        updated_at = now()
    where id = p_suggestion_id;

  return jsonb_build_object(
    'status', 'applied',
    'suggestion_id', p_suggestion_id,
    'item_id', v_item_id,
    'item_class', p_item_class,
    'members_applied', v_applied
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Dismiss one group (owner / Q7 stock editor only)
-- ---------------------------------------------------------------------------

create or replace function public.dismiss_new_item_suggestion(p_suggestion_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_suggestion public.stock_new_item_suggestions%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not public.material_alias_can_admin(v_actor) then
      raise exception 'create_item_forbidden' using errcode = '42501';
    end if;
  end if;

  select * into v_suggestion
  from public.stock_new_item_suggestions
  where id = p_suggestion_id
  for update;
  if not found then
    raise exception 'suggestion_not_found' using errcode = 'P0002';
  end if;
  if v_suggestion.status = 'dismissed' then
    return jsonb_build_object('status', 'already_dismissed', 'suggestion_id', p_suggestion_id);
  end if;
  if v_suggestion.status = 'applied' then
    raise exception 'suggestion_already_applied' using errcode = '23514';
  end if;

  update public.stock_new_item_suggestions
    set status = 'dismissed',
        decided_by = v_actor,
        decided_at = now(),
        updated_at = now()
    where id = p_suggestion_id;

  return jsonb_build_object('status', 'dismissed', 'suggestion_id', p_suggestion_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Pending groups for the review screen (owner / Q7 stock editor)
-- ---------------------------------------------------------------------------

create or replace function public.get_new_item_suggestions(p_location text)
returns table (
  id uuid,
  location text,
  cluster_key text,
  members jsonb,
  suggested_name text,
  suggested_unit text,
  suggested_class text,
  class_probability numeric,
  receipt_count integer,
  receipt_days integer,
  first_date date,
  last_date date,
  is_recurring boolean,
  status text,
  item_id uuid,
  prompt_version text,
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  if p_location not in ('q7', 'tan_tao') then
    raise exception 'unsupported_location' using errcode = '22023';
  end if;
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not public.material_alias_can_admin(v_actor) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;

  return query
  select
    s.id,
    s.location,
    s.cluster_key,
    s.members,
    s.suggested_name,
    s.suggested_unit,
    s.suggested_class,
    s.class_probability,
    s.receipt_count,
    s.receipt_days,
    s.first_date,
    s.last_date,
    s.is_recurring,
    s.status,
    s.item_id,
    s.prompt_version,
    s.decided_by,
    s.decided_at,
    s.created_at,
    s.updated_at
  from public.stock_new_item_suggestions s
  where s.location = p_location
    and s.status = 'pending'
  order by s.is_recurring desc, s.receipt_count desc, s.suggested_name asc, s.id asc;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. RLS and explicit grants
-- ---------------------------------------------------------------------------

alter table public.stock_new_item_suggestions enable row level security;

drop policy if exists stock_new_item_suggestions_select on public.stock_new_item_suggestions;
create policy stock_new_item_suggestions_select on public.stock_new_item_suggestions
  for select to authenticated
  using (public.material_alias_can_admin((select auth.uid())));

-- Read-only for signed-in users; every write goes through a security definer RPC
-- (or the service role used by the edge function).
revoke all on table public.stock_new_item_suggestions from public, anon, authenticated;
grant select on table public.stock_new_item_suggestions to authenticated, service_role;
grant insert, update, delete on table public.stock_new_item_suggestions to service_role;

-- ---------------------------------------------------------------------------
-- 8. Function grants
-- ---------------------------------------------------------------------------

revoke all on function public.list_unmatched_purchase_names(text, integer) from public, anon, authenticated;
grant execute on function public.list_unmatched_purchase_names(text, integer) to service_role;

revoke all on function public.upsert_new_item_suggestions(text, jsonb) from public, anon, authenticated;
grant execute on function public.upsert_new_item_suggestions(text, jsonb) to service_role;

revoke all on function public.apply_new_item_suggestion(uuid, text, text, text, jsonb, uuid) from public, anon;
grant execute on function public.apply_new_item_suggestion(uuid, text, text, text, jsonb, uuid) to authenticated, service_role;

revoke all on function public.dismiss_new_item_suggestion(uuid) from public, anon;
grant execute on function public.dismiss_new_item_suggestion(uuid) to authenticated, service_role;

revoke all on function public.get_new_item_suggestions(text) from public, anon;
grant execute on function public.get_new_item_suggestions(text) to authenticated, service_role;
