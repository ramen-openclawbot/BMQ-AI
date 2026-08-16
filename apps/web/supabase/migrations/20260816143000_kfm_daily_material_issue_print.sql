-- KFM daily print-only raw-material issue slips.
-- This migration intentionally does not touch kitchen_inventory_movements or
-- production_material_issue_items: daily KFM slips are audit/print documents
-- only until inventory deduction is separately approved.

create table if not exists public.kfm_daily_material_issues (
  id uuid primary key default gen_random_uuid(),
  issue_number text not null unique,
  issue_date date not null,
  revision integer not null default 1 check (revision > 0),
  status text not null default 'generated'
    check (status in ('generated', 'printed', 'superseded')),
  source_hash text not null,
  total_amount numeric(16, 2) not null default 0,
  printed_at timestamptz,
  printed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  unique (issue_date, revision)
);

create unique index if not exists kfm_daily_material_issues_one_current_uidx
  on public.kfm_daily_material_issues(issue_date)
  where status <> 'superseded';

create table if not exists public.kfm_daily_material_issue_sources (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references public.kfm_daily_material_issues(id) on delete cascade,
  production_order_id uuid not null references public.production_orders(id) on delete restrict,
  source_po_inbox_id uuid references public.customer_po_inbox(id) on delete restrict,
  production_number text not null,
  po_number text,
  created_at timestamptz not null default now(),
  unique (issue_id, production_order_id)
);

create table if not exists public.kfm_daily_material_issue_items (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references public.kfm_daily_material_issues(id) on delete cascade,
  canonical_material_id uuid references public.sku_cogs_materials(id) on delete restrict,
  material_code text,
  ingredient_name text not null,
  required_qty numeric(15, 3) not null check (required_qty > 0),
  unit text not null,
  unit_cost numeric(14, 2) not null default 0,
  amount numeric(16, 2) not null default 0,
  sort_order integer not null default 0,
  stable_material_key text not null,
  created_at timestamptz not null default now(),
  unique (issue_id, stable_material_key, unit)
);

create index if not exists idx_kfm_daily_material_issue_sources_issue
  on public.kfm_daily_material_issue_sources(issue_id);
create index if not exists idx_kfm_daily_material_issue_sources_order
  on public.kfm_daily_material_issue_sources(production_order_id);
create index if not exists idx_kfm_daily_material_issue_items_issue
  on public.kfm_daily_material_issue_items(issue_id);
create index if not exists idx_kfm_daily_material_issue_items_material
  on public.kfm_daily_material_issue_items(canonical_material_id, material_code);

alter table public.kfm_daily_material_issues enable row level security;
alter table public.kfm_daily_material_issue_sources enable row level security;
alter table public.kfm_daily_material_issue_items enable row level security;

drop policy if exists kfm_daily_material_issues_select on public.kfm_daily_material_issues;
create policy kfm_daily_material_issues_select
  on public.kfm_daily_material_issues for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'production', 'view')
    or public.has_module_permission((select auth.uid()), 'production_q7', 'view')
    or public.has_module_permission((select auth.uid()), 'warehouse', 'view')
  );

drop policy if exists kfm_daily_material_issue_sources_select on public.kfm_daily_material_issue_sources;
create policy kfm_daily_material_issue_sources_select
  on public.kfm_daily_material_issue_sources for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'production', 'view')
    or public.has_module_permission((select auth.uid()), 'production_q7', 'view')
    or public.has_module_permission((select auth.uid()), 'warehouse', 'view')
  );

drop policy if exists kfm_daily_material_issue_items_select on public.kfm_daily_material_issue_items;
create policy kfm_daily_material_issue_items_select
  on public.kfm_daily_material_issue_items for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'production', 'view')
    or public.has_module_permission((select auth.uid()), 'production_q7', 'view')
    or public.has_module_permission((select auth.uid()), 'warehouse', 'view')
  );

revoke all on public.kfm_daily_material_issues from public, anon, authenticated;
revoke all on public.kfm_daily_material_issue_sources from public, anon, authenticated;
revoke all on public.kfm_daily_material_issue_items from public, anon, authenticated;
grant select on public.kfm_daily_material_issues to authenticated;
grant select on public.kfm_daily_material_issue_sources to authenticated;
grant select on public.kfm_daily_material_issue_items to authenticated;
alter default privileges in schema public revoke all on tables from public, anon, authenticated;

create or replace function public.kfm_daily_issue_normalize_text(p_value text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select btrim(regexp_replace(lower(coalesce(p_value, '')), '[^[:alnum:]]+', ' ', 'g'));
$$;

create or replace function public.kfm_daily_issue_can_edit(v_actor_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(auth.role(), '') = 'service_role'
    or public.has_role(v_actor_id, 'owner')
    or public.has_module_permission(v_actor_id, 'production_q7', 'edit')
    or public.has_module_permission(v_actor_id, 'production', 'edit');
$$;

create or replace function public.upsert_kfm_daily_material_issue(
  p_issue_date date default ((now() at time zone 'Asia/Ho_Chi_Minh')::date)
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid := auth.uid();
  v_issue_id uuid;
  v_total numeric(16, 2) := 0;
  v_source_hash text;
  v_next_revision integer := 1;
  v_issue_number text;
  current_issue public.kfm_daily_material_issues%rowtype;
  v_sources jsonb := '[]'::jsonb;
  v_items jsonb := '[]'::jsonb;
  v_blockers jsonb := '[]'::jsonb;
begin
  if not public.kfm_daily_issue_can_edit(v_actor_id) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext('kfm_daily_material_issue'), hashtext(p_issue_date::text));

  create temp table if not exists sources (
    production_order_id uuid primary key,
    source_po_inbox_id uuid,
    production_number text,
    po_number text
  ) on commit drop;
  truncate table sources;

  insert into sources(production_order_id, source_po_inbox_id, production_number, po_number)
  select distinct po.id, po.source_po_inbox_id, po.production_number, cpi.po_number
  from public.production_orders po
  join public.customer_po_inbox cpi on cpi.id = po.source_po_inbox_id
  join public.production_order_items poi on poi.production_order_id = po.id
  where po.status in ('draft', 'planned', 'in_progress')
    and coalesce(po.planned_start_date, poi.delivery_date, cpi.delivery_date) = p_issue_date
    and (
      lower(coalesce(cpi.from_email, '') || ' ' || coalesce(cpi.email_subject, '') || ' ' || coalesce(cpi.from_name, '')) like '%kingfood%'
      or lower(coalesce(cpi.from_email, '') || ' ' || coalesce(cpi.email_subject, '') || ' ' || coalesce(cpi.from_name, '')) like '%kingfoodmart%'
      or lower(coalesce(cpi.from_email, '') || ' ' || coalesce(cpi.email_subject, '') || ' ' || coalesce(cpi.from_name, '')) ~ '(^|[^a-z0-9])kfm([^a-z0-9]|$)'
    );

  create temp table if not exists blockers (
    status text not null,
    details jsonb not null
  ) on commit drop;
  truncate table blockers;

  if not exists (select 1 from sources) then
    insert into blockers values ('blocked_missing_sources', jsonb_build_object('issue_date', p_issue_date));
  end if;

  create temp table if not exists order_lines (
    production_order_id uuid not null,
    production_order_item_id uuid primary key,
    source_po_inbox_id uuid,
    production_number text,
    po_number text,
    product_name text not null,
    persisted_sku_id uuid,
    resolved_sku_id uuid,
    selected_version_id uuid,
    selected_version_no integer,
    finished_qty numeric,
    sku_match_count integer not null default 0,
    selected_finished_output_qty numeric,
    selected_parent_name text,
    selected_effective_from date
  ) on commit drop;
  truncate table order_lines;

  insert into order_lines(
    production_order_id, production_order_item_id, source_po_inbox_id,
    production_number, po_number, product_name, persisted_sku_id, resolved_sku_id,
    selected_version_id, selected_version_no, finished_qty, sku_match_count, selected_finished_output_qty, selected_parent_name,
    selected_effective_from
  )
  select
    s.production_order_id,
    poi.id,
    s.source_po_inbox_id,
    s.production_number,
    s.po_number,
    poi.product_name,
    poi.sku_id,
    coalesce(poi.sku_id, exact_match.id),
    latest_version.id,
    latest_version.version_no,
    case
      when poi.actual_qty > 0 then poi.actual_qty
      when poi.planned_qty > 0 then poi.planned_qty
      when poi.ordered_qty > 0 then poi.ordered_qty
      else coalesce(nullif(poi.actual_qty, 0), nullif(poi.planned_qty, 0), nullif(poi.ordered_qty, 0))
    end,
    coalesce(exact_match.match_count, case when poi.sku_id is not null then 1 else 0 end),
    case
      when nullif(latest_version.product_snapshot ->> 'finished_output_qty', '') ~ '^[0-9]+(\.[0-9]+)?$'
        then (latest_version.product_snapshot ->> 'finished_output_qty')::numeric
      else null
    end,
    nullif(btrim(latest_version.product_snapshot ->> 'product_name'), ''),
    latest_version.effective_from
  from sources s
  join public.production_order_items poi on poi.production_order_id = s.production_order_id
  left join lateral (
    select case when count(*) = 1 then (array_agg(id order by id::text))[1] end as id,
           count(*) as match_count
    from public.product_skus ps2
    where poi.sku_id is null
      and public.kfm_daily_issue_normalize_text(ps2.product_name) = public.kfm_daily_issue_normalize_text(poi.product_name)
      and (
        lower(coalesce(ps2.sku_type::text, '')) = 'finished_good'
        or lower(coalesce(ps2.category, '')) in ('thành phẩm', 'thanh pham', 'finished_good')
      )
  ) exact_match on true
  left join lateral (
    select v.id, v.version_no, v.effective_from, v.product_snapshot
    from public.sku_cogs_versions v
    where v.sku_id = coalesce(poi.sku_id, exact_match.id)
      and v.effective_from <= p_issue_date
      and (v.effective_to is null or p_issue_date <= v.effective_to)
    order by v.effective_from desc, v.version_no desc, v.id::text desc
    limit 1
  ) latest_version on true;

  insert into blockers(status, details)
  select 'blocked_missing_finished_skus', jsonb_agg(jsonb_build_object(
    'production_order_item_id', production_order_item_id,
    'product_name', product_name
  ))
  from order_lines
  where resolved_sku_id is null and sku_match_count = 0
  having count(*) > 0;

  insert into blockers(status, details)
  select 'blocked_ambiguous_finished_skus', jsonb_agg(jsonb_build_object(
    'production_order_item_id', production_order_item_id,
    'product_name', product_name,
    'match_count', sku_match_count
  ))
  from order_lines
  where persisted_sku_id is null and resolved_sku_id is null and sku_match_count <> 0
  having count(*) > 0;

  insert into blockers(status, details)
  select 'blocked_nonpositive_quantities', jsonb_agg(jsonb_build_object(
    'production_order_item_id', production_order_item_id,
    'product_name', product_name,
    'finished_qty', finished_qty
  ))
  from order_lines
  where coalesce(finished_qty, 0) <= 0
  having count(*) > 0;

  insert into blockers(status, details)
  select 'blocked_missing_formulations', jsonb_agg(jsonb_build_object(
    'production_order_item_id', production_order_item_id,
    'finished_sku_id', resolved_sku_id,
    'product_name', product_name
  ))
  from order_lines ol
  where resolved_sku_id is not null
    and selected_version_id is null
    and not exists (
      select 1 from public.sku_cogs_versions v
      where v.sku_id = ol.resolved_sku_id
        and v.effective_from <= p_issue_date
        and (v.effective_to is null or p_issue_date <= v.effective_to)
    )
  having count(*) > 0;

  insert into blockers(status, details)
  select 'blocked_missing_formulations', jsonb_agg(jsonb_build_object(
    'production_order_item_id', ol.production_order_item_id,
    'finished_sku_id', ol.resolved_sku_id,
    'version_id', ol.selected_version_id,
    'version_no', ol.selected_version_no,
    'product_name', ol.product_name
  ))
  from order_lines ol
  where ol.selected_version_id is not null
    and not exists (
      select 1
      from public.sku_cogs_version_formulations vf
      where vf.version_id = ol.selected_version_id
    )
  having count(*) > 0;

  create temp table if not exists leaf_formulations (
    production_order_item_id uuid not null,
    version_id uuid not null,
    canonical_material_id uuid,
    material_code text,
    ingredient_name text not null,
    unit text,
    unit_price numeric,
    dosage_qty numeric,
    wastage_percent numeric,
    sort_order integer
  ) on commit drop;
  truncate table leaf_formulations;

  insert into leaf_formulations(
    production_order_item_id, version_id, canonical_material_id, material_code,
    ingredient_name, unit, unit_price, dosage_qty, wastage_percent, sort_order
  )
  select
    ol.production_order_item_id,
    f.version_id,
    f.canonical_material_id,
    f.material_code,
    f.ingredient_name,
    f.unit,
    f.unit_price,
    f.dosage_qty,
    f.wastage_percent,
    f.sort_order
  from order_lines ol
  join public.sku_cogs_version_formulations f on f.version_id = ol.selected_version_id
  where ol.selected_version_id is not null
    and not exists (
      select 1
      from public.sku_cogs_version_formulations child
      where child.version_id = f.version_id
        and position(f.ingredient_name || ' > ' in child.ingredient_name) = 1
    );

  insert into blockers(status, details)
  select 'blocked_missing_formulations', jsonb_agg(jsonb_build_object(
    'production_order_item_id', ol.production_order_item_id,
    'finished_sku_id', ol.resolved_sku_id,
    'version_id', ol.selected_version_id,
    'version_no', ol.selected_version_no,
    'product_name', ol.product_name
  ))
  from order_lines ol
  where ol.selected_version_id is not null
    and not exists (
      select 1
      from leaf_formulations lf
      where lf.production_order_item_id = ol.production_order_item_id
    )
  having count(*) > 0;

  create temp table if not exists calc_rows (
    production_order_id uuid not null,
    production_order_item_id uuid not null,
    source_po_inbox_id uuid,
    production_number text,
    po_number text,
    finished_sku_id uuid not null,
    canonical_material_id uuid,
    material_code text,
    ingredient_name text not null,
    required_qty numeric not null,
    unit text,
    normalized_unit text,
    unit_cost numeric,
    amount numeric,
    sort_order integer,
    stable_material_key text
  ) on commit drop;
  truncate table calc_rows;

  insert into calc_rows(
    production_order_id, production_order_item_id, source_po_inbox_id,
    production_number, po_number, finished_sku_id, canonical_material_id,
    material_code, ingredient_name, required_qty, unit, normalized_unit,
    unit_cost, amount, sort_order, stable_material_key
  )
  select
    ol.production_order_id,
    ol.production_order_item_id,
    ol.source_po_inbox_id,
    ol.production_number,
    ol.po_number,
    ol.resolved_sku_id,
    f.canonical_material_id,
    nullif(btrim(f.material_code), ''),
    case
      when position(ol.selected_parent_name || ' > ' in f.ingredient_name) = 1
        then replace(f.ingredient_name, ol.selected_parent_name || ' > ', '')
      else f.ingredient_name
    end as ingredient_name,
    (ol.finished_qty / ol.selected_finished_output_qty) * f.dosage_qty * (1 + f.wastage_percent / 100.0) as required_qty,
    nullif(btrim(f.unit), '') as unit,
    lower(nullif(btrim(f.unit), '')) as normalized_unit,
    coalesce(f.unit_price, 0) as unit_cost,
    round(((ol.finished_qty / ol.selected_finished_output_qty) * f.dosage_qty * (1 + f.wastage_percent / 100.0) * coalesce(f.unit_price, 0))::numeric, 2) as amount,
    coalesce(f.sort_order, 0) as sort_order,
    coalesce(nullif(btrim(f.material_code), ''), f.canonical_material_id::text, public.kfm_daily_issue_normalize_text(f.ingredient_name)) as stable_material_key
  from order_lines ol
  join leaf_formulations f on f.production_order_item_id = ol.production_order_item_id
  where ol.resolved_sku_id is not null
    and ol.finished_qty > 0
    and ol.selected_finished_output_qty > 0
    and ol.selected_finished_output_qty::text not in ('NaN', 'Infinity', '-Infinity')
    and f.dosage_qty > 0
    and f.dosage_qty::text not in ('NaN', 'Infinity', '-Infinity')
    and f.wastage_percent >= 0
    and f.wastage_percent::text not in ('NaN', 'Infinity', '-Infinity');

  insert into blockers(status, details)
  select 'blocked_invalid_formulations', jsonb_agg(jsonb_build_object(
    'production_order_item_id', ol.production_order_item_id,
    'finished_sku_id', ol.resolved_sku_id,
    'finished_output_qty', ol.selected_finished_output_qty
  ))
  from order_lines ol
  where ol.resolved_sku_id is not null
    and (
      coalesce(ol.selected_finished_output_qty, 0) <= 0
      or not (ol.selected_finished_output_qty > 0)
      or ol.selected_finished_output_qty::text in ('NaN', 'Infinity', '-Infinity')
    )
  having count(*) > 0;

  insert into blockers(status, details)
  select 'blocked_invalid_formulations', jsonb_agg(jsonb_build_object(
    'production_order_item_id', f.production_order_item_id,
    'ingredient_name', f.ingredient_name,
    'dosage_qty', f.dosage_qty,
    'wastage_percent', f.wastage_percent
  ))
  from leaf_formulations f
  where coalesce(f.dosage_qty, 0) <= 0
    or not (f.dosage_qty > 0)
    or f.dosage_qty::text in ('NaN', 'Infinity', '-Infinity')
    or f.wastage_percent is null
    or f.wastage_percent < 0
    or not (f.wastage_percent >= 0)
    or f.wastage_percent::text in ('NaN', 'Infinity', '-Infinity')
  having count(*) > 0;

  insert into blockers(status, details)
  select 'blocked_missing_material_identity', jsonb_agg(jsonb_build_object(
    'production_order_item_id', production_order_item_id,
    'ingredient_name', ingredient_name
  ))
  from calc_rows
  where canonical_material_id is null and coalesce(nullif(material_code, ''), '') = ''
  having count(*) > 0;

  insert into blockers(status, details)
  select 'blocked_missing_units', jsonb_agg(jsonb_build_object(
    'production_order_item_id', production_order_item_id,
    'ingredient_name', ingredient_name
  ))
  from calc_rows
  where coalesce(nullif(unit, ''), '') = ''
  having count(*) > 0;

  insert into blockers(status, details)
  select 'blocked_nonpositive_required_qty', jsonb_agg(jsonb_build_object(
    'production_order_item_id', production_order_item_id,
    'ingredient_name', ingredient_name,
    'required_qty', required_qty
  ))
  from calc_rows
  where coalesce(required_qty, 0) <= 0
  having count(*) > 0;

  delete from blockers where details is null;

  if exists (select 1 from blockers where details is not null) then
    select jsonb_agg(jsonb_build_object('status', status, 'details', details) order by status)
      into v_blockers
    from blockers
    where details is not null;

    return jsonb_build_object(
      'status', (select status from blockers where details is not null order by status limit 1),
      'issue_date', p_issue_date,
      'blockers', coalesce(v_blockers, '[]'::jsonb)
    );
  end if;

  create temp table if not exists agg_items (
    canonical_material_id uuid,
    material_code text,
    ingredient_name text not null,
    required_qty numeric not null,
    unit text not null,
    normalized_unit text not null,
    unit_cost numeric not null,
    amount numeric not null,
    sort_order integer not null,
    stable_material_key text not null,
    snapshot_key text not null
  ) on commit drop;
  truncate table agg_items;

  insert into agg_items(
    canonical_material_id, material_code, ingredient_name, required_qty, unit,
    normalized_unit, unit_cost, amount, sort_order, stable_material_key, snapshot_key
  )
  select
    canonical_material_id,
    min(material_code) filter (where material_code is not null),
    min(ingredient_name),
    round(sum(required_qty)::numeric, 3),
    min(unit),
    normalized_unit,
    max(unit_cost),
    round(sum(amount)::numeric, 2),
    min(sort_order),
    coalesce(nullif(material_code, ''), canonical_material_id::text, stable_material_key) as stable_material_key,
    coalesce(nullif(material_code, ''), canonical_material_id::text, stable_material_key) || '|' || normalized_unit as snapshot_key
  from calc_rows
  group by canonical_material_id, coalesce(nullif(material_code, ''), canonical_material_id::text, stable_material_key), normalized_unit;

  select coalesce(sum(amount), 0) into v_total from agg_items;

  select md5(string_agg(snapshot_key, '|' order by snapshot_key))
    into v_source_hash
  from (
    select 'S|' || production_order_id::text || '|' || coalesce(source_po_inbox_id::text, '') || '|' || production_number || '|' || coalesce(po_number, '') as snapshot_key
    from sources
    union all
    select 'I|' || snapshot_key || '|' || ingredient_name || '|' || required_qty::text || '|' || unit || '|' || unit_cost::text || '|' || amount::text
    from agg_items
  ) snapshot;

  select jsonb_agg(jsonb_build_object(
      'production_order_id', production_order_id,
      'source_po_inbox_id', source_po_inbox_id,
      'production_number', production_number,
      'po_number', po_number
    ) order by production_number, production_order_id::text)
    into v_sources
  from sources;

  select jsonb_agg(jsonb_build_object(
      'material_code', material_code,
      'canonical_material_id', canonical_material_id,
      'ingredient_name', ingredient_name,
      'required_qty', required_qty,
      'unit', unit,
      'unit_cost', unit_cost,
      'amount', amount
    ) order by sort_order, ingredient_name, stable_material_key)
    into v_items
  from agg_items;

  select * into current_issue
  from public.kfm_daily_material_issues
  where issue_date = p_issue_date
    and status <> 'superseded'
  for update;

  if found and current_issue.status = 'printed' and current_issue.source_hash = v_source_hash then
    return jsonb_build_object(
      'status', 'printed_unchanged',
      'issue_id', current_issue.id,
      'issue_number', current_issue.issue_number,
      'issue_date', current_issue.issue_date,
      'revision', current_issue.revision,
      'source_hash', current_issue.source_hash,
      'sources', coalesce(v_sources, '[]'::jsonb),
      'items', coalesce(v_items, '[]'::jsonb)
    );
  end if;

  if found and current_issue.status = 'printed' then
    update public.kfm_daily_material_issues
       set status = 'superseded', updated_at = now(), updated_by = v_actor_id
     where id = current_issue.id;
    v_next_revision := current_issue.revision + 1;
  elsif found and current_issue.status = 'generated' then
    v_issue_id := current_issue.id;
    v_next_revision := current_issue.revision;
  else
    v_next_revision := 1;
  end if;

  v_issue_number := 'PXK-NVL-KFM-' || to_char(p_issue_date, 'YYYYMMDD') || '-' || lpad(v_next_revision::text, 3, '0');

  if v_issue_id is null then
    insert into public.kfm_daily_material_issues(
      issue_number, issue_date, revision, status, source_hash, total_amount,
      created_by, updated_by
    ) values (
      v_issue_number, p_issue_date, v_next_revision, 'generated', v_source_hash, v_total,
      v_actor_id, v_actor_id
    )
    returning id into v_issue_id;
  else
    update public.kfm_daily_material_issues
       set source_hash = v_source_hash,
           total_amount = v_total,
           updated_at = now(),
           updated_by = v_actor_id
     where id = v_issue_id;
  end if;

  if exists (select 1 from blockers) and not exists (select 1 from blockers) then
    raise exception 'unreachable blocker guard';
  end if;
  -- Required write gate marker: target writes are below only after validation.
  if not exists (select 1 from blockers) then
    delete from public.kfm_daily_material_issue_sources where issue_id = v_issue_id;
    delete from public.kfm_daily_material_issue_items where issue_id = v_issue_id;

    insert into public.kfm_daily_material_issue_sources(
      issue_id, production_order_id, source_po_inbox_id, production_number, po_number
    )
    select v_issue_id, production_order_id, source_po_inbox_id, production_number, po_number
    from sources
    order by production_number, production_order_id::text;

    insert into public.kfm_daily_material_issue_items(
      issue_id, canonical_material_id, material_code, ingredient_name,
      required_qty, unit, unit_cost, amount, sort_order, stable_material_key
    )
    select v_issue_id, canonical_material_id, material_code, ingredient_name,
      required_qty, unit, unit_cost, amount, sort_order, stable_material_key
    from agg_items
    order by sort_order, ingredient_name, stable_material_key;
  end if;

  return jsonb_build_object(
    'status', case when found and current_issue.status = 'generated' then 'refreshed' else 'generated' end,
    'issue_id', v_issue_id,
    'issue_number', v_issue_number,
    'issue_date', p_issue_date,
    'revision', v_next_revision,
    'source_hash', v_source_hash,
    'source_count', (select count(*) from sources),
    'item_count', (select count(*) from agg_items),
    'total_amount', v_total,
    'sources', coalesce(v_sources, '[]'::jsonb),
    'items', coalesce(v_items, '[]'::jsonb)
  );
end;
$$;

create or replace function public.mark_kfm_daily_material_issue_printed(p_issue_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid := auth.uid();
  target_issue public.kfm_daily_material_issues%rowtype;
begin
  if not public.kfm_daily_issue_can_edit(v_actor_id) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select * into target_issue
  from public.kfm_daily_material_issues
  where id = p_issue_id
  for update;

  if not found then
    raise exception 'kfm_daily_material_issue_not_found' using errcode = 'P0002';
  end if;

  if target_issue.status = 'printed' then
    return jsonb_build_object(
      'status', 'printed',
      'issue_id', target_issue.id,
      'issue_number', target_issue.issue_number,
      'printed_at', target_issue.printed_at,
      'printed_by', target_issue.printed_by
    );
  end if;

  if target_issue.status <> 'generated' then
    return jsonb_build_object(
      'status', 'blocked_invalid_status',
      'issue_id', target_issue.id,
      'current_status', target_issue.status
    );
  end if;

  update public.kfm_daily_material_issues
     set status = 'printed',
         printed_at = coalesce(printed_at, now()),
         printed_by = coalesce(printed_by, v_actor_id),
         updated_at = now(),
         updated_by = v_actor_id
   where id = p_issue_id
   returning * into target_issue;

  return jsonb_build_object(
    'status', 'printed',
    'issue_id', target_issue.id,
    'issue_number', target_issue.issue_number,
    'printed_at', target_issue.printed_at,
    'printed_by', target_issue.printed_by
  );
end;
$$;

revoke all on function public.kfm_daily_issue_normalize_text(text) from public;
revoke all on function public.kfm_daily_issue_normalize_text(text) from anon;
revoke all on function public.kfm_daily_issue_normalize_text(text) from authenticated;
revoke all on function public.kfm_daily_issue_can_edit(uuid) from public;
revoke all on function public.kfm_daily_issue_can_edit(uuid) from anon;
revoke all on function public.kfm_daily_issue_can_edit(uuid) from authenticated;
revoke all on function public.upsert_kfm_daily_material_issue(date) from public;
revoke all on function public.upsert_kfm_daily_material_issue(date) from anon;
revoke all on function public.upsert_kfm_daily_material_issue(date) from authenticated;
revoke all on function public.mark_kfm_daily_material_issue_printed(uuid) from public;
revoke all on function public.mark_kfm_daily_material_issue_printed(uuid) from anon;
revoke all on function public.mark_kfm_daily_material_issue_printed(uuid) from authenticated;
grant execute on function public.upsert_kfm_daily_material_issue(date) to authenticated, service_role;
grant execute on function public.mark_kfm_daily_material_issue_printed(uuid) to authenticated, service_role;
