-- Q7 automatic raw-material purchasing: forecast, draft POs and safe auto-send.
--
-- One pg_cron run per day (23:00 UTC = 06:00 Asia/Ho_Chi_Minh) calls
-- public.run_q7_auto_purchase(). A weekly run calls
-- public.learn_q7_purchase_parameters().
--
-- Safety: the whole flow is OFF by default (q7_auto_purchase_settings.enabled
-- defaults false) and every item defaults to 'suggest'. The run only ever
-- creates internal draft POs and, for POs whose every line is auto_send and
-- which stay inside the per-PO / per-day limits, flips them to 'sent' through
-- the existing update_purchase_order_status_with_material_controller RPC.
-- Nothing is ever sent directly to a supplier; payment requests, payables and
-- goods receipts are not modified. The run is idempotent per calendar day.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

create table if not exists public.q7_auto_purchase_settings (
  id integer primary key default 1,
  enabled boolean not null default false,
  system_actor_id uuid references auth.users(id) on delete set null,
  max_po_amount numeric(16, 2) not null default 10000000,
  max_daily_amount numeric(16, 2) not null default 30000000,
  max_stock_count_age_days integer not null default 10,
  max_backtest_error numeric(8, 4) not null default 0.25,
  run_hour_vn integer not null default 6,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint q7_auto_purchase_settings_single_row_check check (id = 1),
  constraint q7_auto_purchase_settings_amounts_check check (
    max_po_amount >= 0 and max_daily_amount >= 0
    and max_po_amount::text not in ('NaN', 'Infinity', '-Infinity')
    and max_daily_amount::text not in ('NaN', 'Infinity', '-Infinity')
  ),
  constraint q7_auto_purchase_settings_age_check check (
    max_stock_count_age_days between 0 and 365
  ),
  constraint q7_auto_purchase_settings_backtest_check check (
    max_backtest_error >= 0 and max_backtest_error::text not in ('NaN', 'Infinity', '-Infinity')
  ),
  constraint q7_auto_purchase_settings_hour_check check (run_hour_vn between 0 and 23),
  constraint q7_auto_purchase_settings_enabled_actor_check check (
    not enabled or system_actor_id is not null
  )
);

insert into public.q7_auto_purchase_settings (id)
values (1)
on conflict (id) do nothing;

create table if not exists public.q7_purchase_item_settings (
  id uuid primary key default gen_random_uuid(),
  kitchen_inventory_item_id uuid not null unique
    references public.kitchen_inventory_items(id) on delete cascade,
  mode text not null default 'suggest'
    check (mode in ('off', 'suggest', 'auto_draft', 'auto_send')),
  supplier_id uuid references public.suppliers(id) on delete set null,
  pack_size numeric(18, 4)
    check (pack_size is null or (pack_size > 0 and pack_size::text not in ('NaN', 'Infinity', '-Infinity'))),
  pack_label text,
  lead_time_days integer
    check (lead_time_days is null or lead_time_days between 0 and 365),
  safety_days numeric(6, 2)
    check (safety_days is null or (safety_days >= 0 and safety_days::text not in ('NaN', 'Infinity', '-Infinity'))),
  order_cycle_days integer not null default 7
    check (order_cycle_days between 1 and 180),
  max_order_qty numeric(18, 4)
    check (max_order_qty is null or (max_order_qty > 0 and max_order_qty::text not in ('NaN', 'Infinity', '-Infinity'))),
  learned_supplier_id uuid references public.suppliers(id) on delete set null,
  learned_pack_size numeric(18, 4),
  learned_pack_label text,
  learned_lead_time_days integer,
  learned_safety_days numeric(6, 2),
  learned_backtest_error numeric(8, 4),
  learned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

create index if not exists idx_q7_purchase_item_settings_mode
  on public.q7_purchase_item_settings(mode);

create table if not exists public.q7_auto_purchase_runs (
  id uuid primary key default gen_random_uuid(),
  run_date date not null unique,
  status text not null default 'running'
    check (status in ('running', 'done', 'disabled', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  summary jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  constraint q7_auto_purchase_runs_summary_check check (jsonb_typeof(summary) = 'object')
);

create table if not exists public.q7_auto_purchase_decisions (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.q7_auto_purchase_runs(id) on delete cascade,
  item_id uuid not null references public.kitchen_inventory_items(id) on delete cascade,
  decision text not null check (decision in ('skip', 'suggest', 'draft', 'auto_send')),
  reason_codes text[] not null default '{}'::text[],
  forecast_avg_14d numeric,
  forecast_avg_28d numeric,
  forecast_stddev_28d numeric,
  on_hand numeric,
  open_po_qty numeric,
  suggested_qty numeric,
  reorder_date date,
  unit_price numeric,
  amount numeric,
  purchase_order_id uuid references public.purchase_orders(id) on delete set null,
  error_message text,
  created_at timestamptz not null default now(),
  unique (run_id, item_id)
);

create index if not exists idx_q7_auto_purchase_decisions_run
  on public.q7_auto_purchase_decisions(run_id, created_at desc);

create index if not exists idx_q7_auto_purchase_decisions_po
  on public.q7_auto_purchase_decisions(purchase_order_id);

create table if not exists public.q7_auto_purchase_idempotency (
  idempotency_key text primary key,
  result jsonb not null default '{}'::jsonb,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 2. RLS and grants
-- ---------------------------------------------------------------------------

alter table public.q7_auto_purchase_settings enable row level security;
alter table public.q7_purchase_item_settings enable row level security;
alter table public.q7_auto_purchase_runs enable row level security;
alter table public.q7_auto_purchase_decisions enable row level security;
alter table public.q7_auto_purchase_idempotency enable row level security;

drop policy if exists q7_auto_purchase_settings_select on public.q7_auto_purchase_settings;
create policy q7_auto_purchase_settings_select on public.q7_auto_purchase_settings
  for select to authenticated
  using (public.q7_material_inventory_can_view((select auth.uid())));

drop policy if exists q7_auto_purchase_settings_update on public.q7_auto_purchase_settings;
create policy q7_auto_purchase_settings_update on public.q7_auto_purchase_settings
  for update to authenticated
  using (public.has_role((select auth.uid()), 'owner'))
  with check (public.has_role((select auth.uid()), 'owner'));

drop policy if exists q7_purchase_item_settings_select on public.q7_purchase_item_settings;
create policy q7_purchase_item_settings_select on public.q7_purchase_item_settings
  for select to authenticated
  using (public.q7_material_inventory_can_view((select auth.uid())));

drop policy if exists q7_purchase_item_settings_insert on public.q7_purchase_item_settings;
create policy q7_purchase_item_settings_insert on public.q7_purchase_item_settings
  for insert to authenticated
  with check (public.q7_material_inventory_can_edit((select auth.uid())));

drop policy if exists q7_purchase_item_settings_update on public.q7_purchase_item_settings;
create policy q7_purchase_item_settings_update on public.q7_purchase_item_settings
  for update to authenticated
  using (public.q7_material_inventory_can_edit((select auth.uid())))
  with check (public.q7_material_inventory_can_edit((select auth.uid())));

drop policy if exists q7_purchase_item_settings_delete on public.q7_purchase_item_settings;
create policy q7_purchase_item_settings_delete on public.q7_purchase_item_settings
  for delete to authenticated
  using (public.q7_material_inventory_can_edit((select auth.uid())));

drop policy if exists q7_auto_purchase_runs_select on public.q7_auto_purchase_runs;
create policy q7_auto_purchase_runs_select on public.q7_auto_purchase_runs
  for select to authenticated
  using (public.q7_material_inventory_can_view((select auth.uid())));

drop policy if exists q7_auto_purchase_decisions_select on public.q7_auto_purchase_decisions;
create policy q7_auto_purchase_decisions_select on public.q7_auto_purchase_decisions
  for select to authenticated
  using (public.q7_material_inventory_can_view((select auth.uid())));

revoke all on table public.q7_auto_purchase_settings from public, anon, authenticated;
grant select, update on table public.q7_auto_purchase_settings to authenticated;

revoke all on table public.q7_purchase_item_settings from public, anon, authenticated;
grant select, insert, update, delete on table public.q7_purchase_item_settings to authenticated;

revoke all on table public.q7_auto_purchase_runs from public, anon, authenticated;
grant select on table public.q7_auto_purchase_runs to authenticated;

revoke all on table public.q7_auto_purchase_decisions from public, anon, authenticated;
grant select on table public.q7_auto_purchase_decisions to authenticated;

revoke all on table public.q7_auto_purchase_idempotency from public, anon, authenticated;
grant select, insert, update on table public.q7_auto_purchase_idempotency to service_role;

-- ---------------------------------------------------------------------------
-- 3. Shared label / pack helpers
-- ---------------------------------------------------------------------------

create or replace function public.q7_reason_label(p_code text)
returns text
language sql
immutable
security definer
set search_path = public, pg_temp
as $$
  select case p_code
    when 'mode_off' then 'đang tắt tự động đặt'
    when 'mode_suggest' then 'chế độ chỉ đề xuất'
    when 'mode_auto_draft' then 'tạo nháp chờ duyệt'
    when 'auto_send' then 'đủ điều kiện tự động gửi'
    when 'over_po_limit' then 'vượt hạn mức một phiếu'
    when 'over_daily_limit' then 'vượt hạn mức trong ngày'
    when 'no_stock_count' then 'chưa có kiểm kê tồn kho'
    when 'stale_stock_count' then 'kiểm kê tồn kho đã cũ'
    when 'short_history' then 'chưa đủ 4 tuần dữ liệu'
    when 'no_supplier' then 'chưa gán nhà cung cấp'
    when 'no_pack_size' then 'chưa có quy cách đóng gói'
    when 'no_price' then 'chưa có giá mua gần nhất'
    when 'duplicate_material' then 'trùng mặt hàng với vật tư khác'
    when 'high_backtest_error' then 'sai số dự báo vượt ngưỡng'
    when 'system_error' then 'lỗi khi gửi phiếu'
    else p_code
  end;
$$;

create or replace function public.q7_pack_from_name(p_name text, p_book_unit text)
returns jsonb
language plpgsql
immutable
security definer
set search_path = public, pg_temp
as $$
declare
  v_match text[];
  v_text text := lower(coalesce(p_name, ''));
  v_book text := lower(btrim(coalesce(p_book_unit, '')));
  v_base numeric;
  v_unit text;
  v_mult integer;
  v_factor numeric;
  v_size numeric;
begin
  v_match := regexp_match(
    v_text,
    '([0-9]+([.,][0-9]+)?)[[:space:]]*(kg|g|gr|gram|l|lit|ml|chai|thùng|thung|hộp|hop|gói|goi|bao|can|bịch|bich|cái|cai|vỉ|vi)?[[:space:]]*(x[[:space:]]*([0-9]+))?'
  );
  if v_match is null then
    return null;
  end if;

  v_base := nullif(replace(v_match[1], ',', '.'), '')::numeric;
  v_unit := v_match[3];
  v_mult := coalesce(nullif(v_match[5], '')::integer, 1);
  if v_base is null or v_base <= 0 then
    return null;
  end if;

  if v_unit is null or v_book = '' then
    v_factor := 1;
  elsif v_unit in ('kg', 'g', 'gr', 'gram') and v_book in ('kg', 'g', 'gr', 'gram') then
    v_factor := (case when v_unit = 'kg' then 1000 else 1 end)::numeric
      / (case when v_book = 'kg' then 1000 else 1 end)::numeric;
  elsif v_unit in ('l', 'lit', 'ml') and v_book in ('l', 'lit', 'ml') then
    v_factor := (case when v_unit in ('l', 'lit') then 1000 else 1 end)::numeric
      / (case when v_book in ('l', 'lit') then 1000 else 1 end)::numeric;
  elsif v_unit = v_book then
    v_factor := 1;
  else
    return null;
  end if;

  v_size := round(v_base * v_factor * v_mult, 6);
  if v_size <= 0 then
    return null;
  end if;

  return jsonb_build_object(
    'pack_size', v_size,
    'pack_label', v_match[1] || coalesce(v_unit, '')
      || case when v_match[5] is not null then ' x ' || v_match[5] else '' end,
    'base_qty', v_base,
    'base_unit', v_unit,
    'multiplier', v_mult
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Daily usage statistics
-- ---------------------------------------------------------------------------

create or replace function public.q7_purchase_daily_usage(p_item uuid, p_as_of date)
returns table (
  avg_14d numeric,
  avg_28d numeric,
  stddev_28d numeric,
  days_with_data integer,
  weekday_factor numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_as_of date := coalesce(p_as_of, (now() at time zone 'Asia/Ho_Chi_Minh')::date);
  v_first date;
  v_days integer;
  v_14_start date;
  v_28_start date;
  v_14_days integer;
  v_28_days integer;
  v_sum14 numeric := 0;
  v_sum28 numeric := 0;
  v_stddev numeric := 0;
  v_wf numeric := 1;
  v_dow_avg numeric := 0;
  v_overall numeric := 0;
begin
  -- The issue generator already applied conversion_factor when it wrote
  -- required_qty, so required_qty is in the item's book unit.
  select min(i.issue_date) into v_first
  from public.production_material_issues i
  join public.production_material_issue_items ii on ii.material_issue_id = i.id
  where ii.kitchen_inventory_item_id = p_item
    and i.location_code = 'q7'
    and i.is_current is true
    and i.issue_date <= v_as_of;

  if v_first is null then
    return query select 0::numeric, 0::numeric, 0::numeric, 0, 1::numeric;
    return;
  end if;

  v_days := (v_as_of - v_first) + 1;
  v_14_start := greatest(v_as_of - 13, v_first);
  v_28_start := greatest(v_as_of - 27, v_first);
  v_14_days := (v_as_of - v_14_start) + 1;
  v_28_days := (v_as_of - v_28_start) + 1;

  with daily as (
    select i.issue_date as d, sum(coalesce(ii.required_qty, 0)) as qty
    from public.production_material_issues i
    join public.production_material_issue_items ii on ii.material_issue_id = i.id
    where ii.kitchen_inventory_item_id = p_item
      and i.location_code = 'q7'
      and i.is_current is true
      and i.issue_date between v_28_start and v_as_of
    group by i.issue_date
  ), calendar as (
    select gs::date as d
    from generate_series(v_28_start::timestamp, v_as_of::timestamp, interval '1 day') gs
  )
  select
    coalesce(sum(coalesce(day.qty, 0)) filter (where cal.d >= v_14_start), 0),
    coalesce(sum(coalesce(day.qty, 0)), 0),
    coalesce(stddev_samp(coalesce(day.qty, 0)), 0)
  into v_sum14, v_sum28, v_stddev
  from calendar cal
  left join daily day on day.d = cal.d;

  -- Weekday factor is only meaningful with four full weeks of history.
  if v_days >= 28 and v_sum28 > 0 then
    v_overall := v_sum28 / v_28_days;
    with daily as (
      select i.issue_date as d, sum(coalesce(ii.required_qty, 0)) as qty
      from public.production_material_issues i
      join public.production_material_issue_items ii on ii.material_issue_id = i.id
      where ii.kitchen_inventory_item_id = p_item
        and i.location_code = 'q7'
        and i.is_current is true
        and i.issue_date between v_28_start and v_as_of
      group by i.issue_date
    ), calendar as (
      select gs::date as d
      from generate_series(v_28_start::timestamp, v_as_of::timestamp, interval '1 day') gs
    )
    select coalesce(avg(coalesce(day.qty, 0)), 0)
    into v_dow_avg
    from calendar cal
    left join daily day on day.d = cal.d
    where extract(dow from cal.d) = extract(dow from v_as_of);

    if v_overall > 0 and v_dow_avg > 0 then
      v_wf := round(v_dow_avg / v_overall, 4);
    end if;
  end if;

  return query select
    round(v_sum14 / greatest(v_14_days, 1), 3),
    round(v_sum28 / greatest(v_28_days, 1), 3),
    round(v_stddev, 3),
    v_days,
    v_wf;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Forecast
-- ---------------------------------------------------------------------------

create or replace function public.get_q7_purchase_forecast(
  p_as_of date default null,
  p_horizon_days integer default 14
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_as_of date := coalesce(p_as_of, (now() at time zone 'Asia/Ho_Chi_Minh')::date);
  v_horizon integer := greatest(1, least(coalesce(p_horizon_days, 14), 90));
  v_cutover date;
  v_settings public.q7_auto_purchase_settings%rowtype;
  v_item record;
  v_setting public.q7_purchase_item_settings%rowtype;
  v_usage record;
  v_items jsonb := '[]'::jsonb;
  v_daily numeric;
  v_scheduled_map jsonb := '{}'::jsonb;
  v_scheduled_total numeric := 0;
  v_on_hand numeric;
  v_last_count date;
  v_open_po numeric := 0;
  v_supplier uuid;
  v_pack_size numeric;
  v_pack_label text;
  v_lead integer;
  v_safety numeric;
  v_cycle integer;
  v_mode text;
  v_max_order numeric;
  v_reorder date;
  v_projected numeric;
  v_threshold numeric;
  v_use numeric;
  v_day date;
  v_offset integer;
  v_need numeric;
  v_raw numeric;
  v_suggested numeric;
  v_price numeric;
  v_amount numeric;
  v_no_stock boolean;
  v_stale boolean;
  v_short boolean;
  v_no_supplier boolean;
  v_no_pack boolean;
  v_no_price boolean;
  v_duplicate boolean;
  v_high_backtest boolean;
  v_flags jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.q7_material_inventory_can_view(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  v_cutover := public.stock_ledger_cutover_date('q7');
  select * into v_settings from public.q7_auto_purchase_settings where id = 1;

  for v_item in
    select kii.id, kii.item_code, kii.name, kii.unit, kii.normalized_key
    from public.kitchen_inventory_items kii
    where kii.active = true
      and (
        exists (
          select 1 from public.q7_material_issue_material_mappings m
          where m.kitchen_inventory_item_id = kii.id and m.approval_status = 'approved'
        )
        or exists (
          select 1 from public.q7_purchase_item_settings s
          where s.kitchen_inventory_item_id = kii.id
        )
        or exists (
          select 1 from public.q7_inventory_movements mv
          where mv.kitchen_inventory_item_id = kii.id
        )
      )
    order by kii.name, kii.id
  loop
    select * into v_setting
    from public.q7_purchase_item_settings s
    where s.kitchen_inventory_item_id = v_item.id;

    v_mode := coalesce(v_setting.mode, 'suggest');
    v_supplier := coalesce(v_setting.supplier_id, v_setting.learned_supplier_id);
    v_pack_size := coalesce(v_setting.pack_size, v_setting.learned_pack_size);
    v_pack_label := coalesce(v_setting.pack_label, v_setting.learned_pack_label);
    v_lead := coalesce(v_setting.lead_time_days, v_setting.learned_lead_time_days, 2);
    v_safety := coalesce(v_setting.safety_days, v_setting.learned_safety_days, 2);
    v_cycle := coalesce(v_setting.order_cycle_days, 7);
    v_max_order := v_setting.max_order_qty;

    select * into v_usage from public.q7_purchase_daily_usage(v_item.id, v_as_of);
    v_daily := round(0.6 * coalesce(v_usage.avg_14d, 0) + 0.4 * coalesce(v_usage.avg_28d, 0), 3);

    -- Scheduled issues after the run day replace the baseline average on those days.
    select
      coalesce(jsonb_object_agg(mv.day_key, mv.qty), '{}'::jsonb),
      coalesce(sum(mv.qty), 0)
    into v_scheduled_map, v_scheduled_total
    from (
      select i.issue_date as d, to_char(i.issue_date, 'YYYY-MM-DD') as day_key,
             sum(coalesce(ii.required_qty, 0)) as qty
      from public.production_material_issues i
      join public.production_material_issue_items ii on ii.material_issue_id = i.id
      where ii.kitchen_inventory_item_id = v_item.id
        and i.location_code = 'q7'
        and i.is_current is true
        and i.issue_date > v_as_of
        and i.issue_date <= v_as_of + v_horizon
      group by i.issue_date
    ) mv;

    v_on_hand := null;
    if v_cutover is not null then
      select s.balance_qty into v_on_hand
      from public.get_q7_inventory_snapshot(v_as_of) s
      where s.kitchen_inventory_item_id = v_item.id;
    end if;

    select max(m.movement_date) into v_last_count
    from public.q7_inventory_movements m
    where m.kitchen_inventory_item_id = v_item.id
      and m.source = 'manual_adjustment'
      and m.source_ref_key like 'q7-stock-count:%'
      and m.movement_date <= v_as_of;

    select coalesce(sum(x.qty), 0) into v_open_po
    from (
      select poi.quantity * a.conversion_factor as qty
      from public.purchase_order_items poi
      join public.purchase_orders po on po.id = poi.purchase_order_id
      cross join lateral (
        select a.*
        from public.stock_material_aliases a
        where a.location = 'q7'
          and a.kitchen_inventory_item_id = v_item.id
          and a.normalized_name = public.normalize_stock_item_name(poi.product_name)
          and (a.supplier_id = po.supplier_id or a.supplier_id is null)
        order by (a.supplier_id is not null) desc, a.created_at asc, a.id asc
        limit 1
      ) a
      where po.status in ('draft', 'sent', 'in_transit')
        and not exists (
          select 1 from public.goods_receipts gr
          where gr.purchase_order_id = po.id
            and gr.status in ('confirmed', 'received')
        )
    ) x;

    -- Reorder date: walk the horizon and shift back by the lead time on breach.
    v_reorder := null;
    if v_on_hand is null then
      v_reorder := v_as_of;
    elsif v_daily > 0 then
      v_projected := v_on_hand;
      v_threshold := v_daily * v_safety;
      v_offset := 1;
      while v_offset <= v_horizon loop
        v_day := v_as_of + v_offset;
        v_use := coalesce((v_scheduled_map ->> to_char(v_day, 'YYYY-MM-DD'))::numeric, v_daily);
        v_projected := v_projected - v_use;
        if v_projected < v_threshold then
          v_reorder := v_day - v_lead;
          exit;
        end if;
        v_offset := v_offset + 1;
      end loop;
    end if;

    v_need := v_daily * (v_lead + v_safety + v_cycle);
    v_raw := greatest(0, v_need - coalesce(v_on_hand, 0) - v_open_po);
    if v_pack_size is not null and v_pack_size > 0 then
      v_suggested := ceil(v_raw / v_pack_size) * v_pack_size;
    else
      v_suggested := ceil(v_raw);
    end if;
    if v_max_order is not null and v_max_order > 0 then
      v_suggested := least(v_suggested, v_max_order);
    end if;
    v_suggested := round(coalesce(v_suggested, 0), 3);

    -- Latest price per book unit, from a PO line or a payment-request line.
    select min(x.price) into v_price
    from (
      select round(poi.unit_price / greatest(a.conversion_factor, 0.00000001), 2) as price,
             po.order_date as sort_date
      from public.purchase_order_items poi
      join public.purchase_orders po on po.id = poi.purchase_order_id
      cross join lateral (
        select a.*
        from public.stock_material_aliases a
        where a.location = 'q7'
          and a.kitchen_inventory_item_id = v_item.id
          and a.normalized_name = public.normalize_stock_item_name(poi.product_name)
          and (a.supplier_id = po.supplier_id or a.supplier_id is null)
        order by (a.supplier_id is not null) desc, a.created_at asc, a.id asc
        limit 1
      ) a
      where poi.unit_price is not null and poi.unit_price > 0
      order by po.order_date desc, poi.created_at desc
      limit 1
    ) x;
    if v_price is null then
      select min(x.price) into v_price
      from (
        select round(pri.unit_price / greatest(a.conversion_factor, 0.00000001), 2) as price
        from public.payment_request_items pri
        join public.payment_requests pr on pr.id = pri.payment_request_id
        cross join lateral (
          select a.*
          from public.stock_material_aliases a
          where a.location = 'q7'
            and a.kitchen_inventory_item_id = v_item.id
            and a.normalized_name = public.normalize_stock_item_name(pri.product_name)
            and (a.supplier_id = pr.supplier_id or a.supplier_id is null)
          order by (a.supplier_id is not null) desc, a.created_at asc, a.id asc
          limit 1
        ) a
        where pri.unit_price is not null and pri.unit_price > 0
        order by pr.created_at desc
        limit 1
      ) x;
    end if;

    v_amount := case when v_price is not null then round(v_suggested * v_price, 2) else null end;

    v_no_stock := v_on_hand is null or v_last_count is null;
    v_stale := v_last_count is not null
      and (v_as_of - v_last_count) > coalesce(v_settings.max_stock_count_age_days, 10);
    v_short := coalesce(v_usage.days_with_data, 0) < 28;
    v_no_supplier := v_supplier is null;
    v_no_pack := v_pack_size is null or v_pack_size <= 0;
    v_no_price := v_price is null;
    v_duplicate := exists (
      select 1 from public.kitchen_inventory_items k2
      where k2.active = true
        and k2.id <> v_item.id
        and k2.normalized_key = v_item.normalized_key
    );
    v_high_backtest := v_setting.learned_backtest_error is not null
      and v_setting.learned_backtest_error > coalesce(v_settings.max_backtest_error, 0.25);

    v_flags := jsonb_build_object(
      'no_stock_count', v_no_stock,
      'stale_stock_count', v_stale,
      'short_history', v_short,
      'no_supplier', v_no_supplier,
      'no_pack_size', v_no_pack,
      'no_price', v_no_price,
      'duplicate_material', v_duplicate,
      'high_backtest_error', v_high_backtest
    );

    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'item_id', v_item.id,
      'item_code', v_item.item_code,
      'item_name', v_item.name,
      'unit', v_item.unit,
      'mode', v_mode,
      'daily_usage', v_daily,
      'avg_14d', coalesce(v_usage.avg_14d, 0),
      'avg_28d', coalesce(v_usage.avg_28d, 0),
      'stddev_28d', coalesce(v_usage.stddev_28d, 0),
      'days_with_data', coalesce(v_usage.days_with_data, 0),
      'weekday_factor', coalesce(v_usage.weekday_factor, 1),
      'scheduled_usage', v_scheduled_total,
      'on_hand', v_on_hand,
      'last_count_date', v_last_count,
      'open_po_qty', v_open_po,
      'supplier_id', v_supplier,
      'pack_size', v_pack_size,
      'pack_label', v_pack_label,
      'lead_time_days', v_lead,
      'safety_days', v_safety,
      'order_cycle_days', v_cycle,
      'reorder_date', v_reorder,
      'suggested_qty', v_suggested,
      'last_unit_price', v_price,
      'estimated_amount', v_amount,
      'flags', v_flags
    ));
  end loop;

  return jsonb_build_object(
    'as_of', v_as_of,
    'horizon_days', v_horizon,
    'items', coalesce((
      select jsonb_agg(e order by (e ->> 'reorder_date') nulls last, e ->> 'item_name')
      from jsonb_array_elements(v_items) e
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Weekly learning
-- ---------------------------------------------------------------------------

create or replace function public.q7_backtest_relative_error(p_item uuid, p_as_of date)
returns numeric
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_as_of date := coalesce(p_as_of, (now() at time zone 'Asia/Ho_Chi_Minh')::date);
  v_origin date;
  v_start date := v_as_of - 34;
  v_end date := v_as_of - 7;
  v_s14 numeric;
  v_s28 numeric;
  v_n14 integer;
  v_n28 integer;
  v_daily numeric;
  v_forecast numeric;
  v_actual numeric;
  v_errors numeric[] := '{}'::numeric[];
begin
  if v_start > v_end then
    return null;
  end if;
  for v_origin in
    select gs::date from generate_series(v_start::timestamp, v_end::timestamp, interval '1 day') gs
  loop
    select
      coalesce(sum(ii.required_qty) filter (where i.issue_date >= v_origin - 13), 0),
      coalesce(sum(ii.required_qty), 0),
      count(distinct i.issue_date) filter (where i.issue_date >= v_origin - 13),
      count(distinct i.issue_date)
    into v_s14, v_s28, v_n14, v_n28
    from public.production_material_issues i
    join public.production_material_issue_items ii on ii.material_issue_id = i.id
    where ii.kitchen_inventory_item_id = p_item
      and i.location_code = 'q7'
      and i.is_current is true
      and i.issue_date >= v_origin - 27
      and i.issue_date < v_origin;

    if coalesce(v_n28, 0) < 14 then
      continue;
    end if;

    v_daily := 0.6 * (v_s14 / greatest(v_n14, 1)) + 0.4 * (v_s28 / greatest(v_n28, 1));
    v_forecast := v_daily * 7;

    select coalesce(sum(ii.required_qty), 0) into v_actual
    from public.production_material_issues i
    join public.production_material_issue_items ii on ii.material_issue_id = i.id
    where ii.kitchen_inventory_item_id = p_item
      and i.location_code = 'q7'
      and i.is_current is true
      and i.issue_date >= v_origin
      and i.issue_date < v_origin + 7;

    v_errors := v_errors || (abs(v_forecast - v_actual) / greatest(v_actual, 1));
  end loop;

  if coalesce(array_length(v_errors, 1), 0) = 0 then
    return null;
  end if;
  return round((select avg(x) from unnest(v_errors) x), 4);
end;
$$;

create or replace function public.learn_q7_purchase_parameters()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_item record;
  v_usage record;
  v_supplier uuid;
  v_pack jsonb;
  v_pack_size numeric;
  v_pack_label text;
  v_lead numeric;
  v_safety numeric;
  v_backtest numeric;
  v_daily numeric;
  v_stddev numeric;
  v_updated integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.q7_material_inventory_can_edit(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  for v_item in
    select kii.id, kii.name, kii.unit
    from public.kitchen_inventory_items kii
    where kii.active = true
      and exists (
        select 1
        from public.production_material_issues i
        join public.production_material_issue_items ii on ii.material_issue_id = i.id
        where ii.kitchen_inventory_item_id = kii.id
          and i.location_code = 'q7'
          and i.is_current is true
      )
    order by kii.name, kii.id
  loop
    select * into v_usage from public.q7_purchase_daily_usage(v_item.id, (now() at time zone 'Asia/Ho_Chi_Minh')::date);
    v_daily := round(0.6 * coalesce(v_usage.avg_14d, 0) + 0.4 * coalesce(v_usage.avg_28d, 0), 3);
    v_stddev := coalesce(v_usage.stddev_28d, 0);

    -- Supplier with the largest purchased book quantity in the last 90 days,
    -- from PO lines or payment-request lines mapped through the aliases.
    select x.supplier_id into v_supplier
    from (
      select po.supplier_id, sum(poi.quantity * a.conversion_factor) as qty
      from public.purchase_order_items poi
      join public.purchase_orders po on po.id = poi.purchase_order_id
      cross join lateral (
        select a.* from public.stock_material_aliases a
        where a.location = 'q7'
          and a.kitchen_inventory_item_id = v_item.id
          and a.normalized_name = public.normalize_stock_item_name(poi.product_name)
          and (a.supplier_id = po.supplier_id or a.supplier_id is null)
        order by (a.supplier_id is not null) desc, a.created_at asc, a.id asc
        limit 1
      ) a
      where po.supplier_id is not null
        and po.order_date >= current_date - 90
      group by po.supplier_id
      union all
      select pr.supplier_id, sum(pri.quantity * a.conversion_factor) as qty
      from public.payment_request_items pri
      join public.payment_requests pr on pr.id = pri.payment_request_id
      cross join lateral (
        select a.* from public.stock_material_aliases a
        where a.location = 'q7'
          and a.kitchen_inventory_item_id = v_item.id
          and a.normalized_name = public.normalize_stock_item_name(pri.product_name)
          and (a.supplier_id = pr.supplier_id or a.supplier_id is null)
        order by (a.supplier_id is not null) desc, a.created_at asc, a.id asc
        limit 1
      ) a
      where pr.supplier_id is not null
        and pr.created_at >= now() - interval '90 days'
      group by pr.supplier_id
    ) x
    group by x.supplier_id
    order by sum(x.qty) desc
    limit 1;

    -- Package spec read from the item name; when it cannot be read, use the
    -- most frequently ordered quantity.
    v_pack := public.q7_pack_from_name(v_item.name, v_item.unit);
    if v_pack is not null then
      v_pack_size := (v_pack ->> 'pack_size')::numeric;
      v_pack_label := v_pack ->> 'pack_label';
    else
      select mode() within group (order by poi.quantity) into v_pack_size
      from public.purchase_order_items poi
      join public.purchase_orders po on po.id = poi.purchase_order_id
      cross join lateral (
        select a.* from public.stock_material_aliases a
        where a.location = 'q7'
          and a.kitchen_inventory_item_id = v_item.id
          and a.normalized_name = public.normalize_stock_item_name(poi.product_name)
          and (a.supplier_id = po.supplier_id or a.supplier_id is null)
        order by (a.supplier_id is not null) desc, a.created_at asc, a.id asc
        limit 1
      ) a
      where poi.quantity > 0;
      v_pack_label := case when v_pack_size is not null then v_pack_size::text || ' ' || v_item.unit else null end;
    end if;

    v_lead := null;
    if v_supplier is not null then
      select percentile_cont(0.5) within group (order by (gr.receipt_date - po.order_date))
      into v_lead
      from public.purchase_orders po
      join public.goods_receipts gr on gr.purchase_order_id = po.id
      where po.supplier_id = v_supplier
        and gr.receipt_date is not null
        and gr.receipt_date >= po.order_date
        and gr.receipt_date >= current_date - 120;
      v_lead := round(coalesce(v_lead, 2));
    end if;

    if v_daily > 0 then
      v_safety := least(round(greatest(1, 1.65 * v_stddev * sqrt(coalesce(v_lead, 2)) / v_daily), 1), 7);
    else
      v_safety := null;
    end if;

    v_backtest := public.q7_backtest_relative_error(v_item.id, (now() at time zone 'Asia/Ho_Chi_Minh')::date);

    insert into public.q7_purchase_item_settings as s (
      kitchen_inventory_item_id, mode, learned_supplier_id, learned_pack_size,
      learned_pack_label, learned_lead_time_days, learned_safety_days,
      learned_backtest_error, learned_at
    ) values (
      v_item.id, 'suggest', v_supplier, v_pack_size,
      v_pack_label, v_lead, v_safety,
      v_backtest, now()
    )
    on conflict (kitchen_inventory_item_id) do update set
      learned_supplier_id = excluded.learned_supplier_id,
      learned_pack_size = excluded.learned_pack_size,
      learned_pack_label = excluded.learned_pack_label,
      learned_lead_time_days = excluded.learned_lead_time_days,
      learned_safety_days = excluded.learned_safety_days,
      learned_backtest_error = excluded.learned_backtest_error,
      learned_at = excluded.learned_at,
      updated_at = now();

    v_updated := v_updated + 1;
  end loop;

  return jsonb_build_object('status', 'learned', 'items_updated', v_updated);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Zalo message builders (mirror the shared TypeScript formatters)
-- ---------------------------------------------------------------------------

create or replace function public.build_q7_auto_purchase_order_message(p_po_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_po public.purchase_orders%rowtype;
  v_supplier text;
  v_lines text := '';
  v_line record;
begin
  select * into v_po from public.purchase_orders where id = p_po_id;
  if not found then
    return null;
  end if;
  select s.name into v_supplier from public.suppliers s where s.id = v_po.supplier_id;

  for v_line in
    select product_name, quantity, unit, line_total
    from public.purchase_order_items
    where purchase_order_id = p_po_id
    order by created_at asc, id asc
  loop
    v_lines := v_lines || E'\n' || '• ' || v_line.product_name || ': '
      || coalesce(v_line.quantity::text, '0')
      || case when v_line.unit is not null then ' ' || v_line.unit else '' end
      || ' – ' || public.finance_format_vnd(v_line.line_total);
  end loop;

  return '🧾 ĐƠN HÀNG TỰ ĐỘNG' || E'\n\n'
    || 'Nhà cung cấp: ' || coalesce(v_supplier, 'Chưa xác định') || E'\n'
    || 'Số PO: ' || v_po.po_number
    || v_lines || E'\n'
    || 'Tổng tiền: ' || public.finance_format_vnd(v_po.total_amount) || E'\n\n'
    || 'Vui lòng chuyển cho nhà cung cấp';
end;
$$;

create or replace function public.build_q7_auto_purchase_summary_message(p_run_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_run public.q7_auto_purchase_runs%rowtype;
  v_draft_count integer := 0;
  v_total numeric := 0;
  v_downgraded text := '';
  v_item record;
begin
  select * into v_run from public.q7_auto_purchase_runs where id = p_run_id;
  if not found then
    return null;
  end if;

  select count(*), coalesce(sum(total_amount), 0)
  into v_draft_count, v_total
  from public.purchase_orders
  where status = 'draft'
    and notes = 'Tự động từ dự báo NVL Q7 ' || v_run.run_date;

  for v_item in
    select kii.name,
           (select string_agg(public.q7_reason_label(rc), ', ')
            from unnest(d.reason_codes) rc) as labels
    from public.q7_auto_purchase_decisions d
    join public.kitchen_inventory_items kii on kii.id = d.item_id
    where d.run_id = p_run_id
      and d.decision = 'draft'
    order by kii.name
  loop
    if v_item.labels is not null then
      v_downgraded := v_downgraded || E'\n' || '• ' || v_item.name || ': ' || v_item.labels;
    end if;
  end loop;

  return '📋 TỔNG HỢP ĐẶT HÀNG TỰ ĐỘNG' || E'\n\n'
    || 'Số PO nháp chờ duyệt: ' || v_draft_count::text || E'\n'
    || 'Tổng tiền: ' || public.finance_format_vnd(v_total)
    || case when v_downgraded <> '' then E'\n\n' || 'Mặt hàng bị hạ cấp:' || v_downgraded else '' end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. The daily run
-- ---------------------------------------------------------------------------

create or replace function public.run_q7_auto_purchase(p_run_date date default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_run_date date := coalesce(p_run_date, (now() at time zone 'Asia/Ho_Chi_Minh')::date);
  v_settings public.q7_auto_purchase_settings%rowtype;
  v_run public.q7_auto_purchase_runs%rowtype;
  v_run_id uuid;
  v_forecast jsonb;
  v_item jsonb;
  v_flags jsonb;
  v_mode text;
  v_decision text;
  v_reasons text[];
  v_decision_id uuid;
  v_suggested numeric;
  v_unit_price numeric;
  v_amount numeric;
  v_supplier uuid;
  v_pack_size numeric;
  v_po_id uuid;
  v_po_number text;
  v_po_note text;
  v_po_total numeric;
  v_qty_po numeric;
  v_unit_po text;
  v_price_po numeric;
  v_line_total numeric;
  v_work record;
  v_sup uuid;
  v_line record;
  v_all_auto boolean;
  v_day_auto_sent numeric := 0;
  v_sent_po_ids uuid[] := '{}'::uuid[];
  v_draft_po_ids uuid[] := '{}'::uuid[];
  v_sent_count integer := 0;
  v_suggest_count integer := 0;
  v_skip_count integer := 0;
  v_draft_count integer := 0;
  v_auto_send_count integer := 0;
  v_decision_count integer := 0;
begin
  -- The scheduler has no JWT; treat the run as the service role so the internal
  -- forecast permission check and the PO controller accept the system actor.
  perform set_config('request.jwt.claim.role', 'service_role', true);

  select * into v_settings from public.q7_auto_purchase_settings where id = 1;

  select * into v_run from public.q7_auto_purchase_runs where run_date = v_run_date;
  if found then
    return jsonb_build_object(
      'status', v_run.status,
      'run_id', v_run.id,
      'run_date', v_run.run_date,
      'idempotent', true,
      'summary', v_run.summary
    );
  end if;

  if v_settings.id is null or v_settings.enabled is not true then
    insert into public.q7_auto_purchase_runs (run_date, status, finished_at, summary)
    values (v_run_date, 'disabled', now(), jsonb_build_object('reason', 'disabled'))
    on conflict (run_date) do nothing
    returning id into v_run_id;
    if v_run_id is null then
      select * into v_run from public.q7_auto_purchase_runs where run_date = v_run_date;
      return jsonb_build_object('status', v_run.status, 'run_id', v_run.id, 'run_date', v_run_date, 'idempotent', true);
    end if;
    return jsonb_build_object(
      'status', 'disabled',
      'run_id', v_run_id,
      'run_date', v_run_date,
      'idempotent', false,
      'summary', jsonb_build_object('reason', 'disabled')
    );
  end if;

  insert into public.q7_auto_purchase_runs (run_date, status, started_at, summary, created_by)
  values (v_run_date, 'running', now(), '{}'::jsonb, v_settings.system_actor_id)
  on conflict (run_date) do nothing
  returning id into v_run_id;
  if v_run_id is null then
    select * into v_run from public.q7_auto_purchase_runs where run_date = v_run_date;
    return jsonb_build_object('status', v_run.status, 'run_id', v_run.id, 'run_date', v_run_date, 'idempotent', true, 'summary', v_run.summary);
  end if;

  v_po_note := 'Tự động từ dự báo NVL Q7 ' || v_run_date::text;

  create temp table if not exists q7_auto_purchase_work (
    decision_id uuid,
    item_id uuid,
    item_name text,
    unit text,
    supplier_id uuid,
    decision text,
    reason_codes text[],
    suggested_qty numeric,
    unit_price numeric,
    amount numeric,
    pack_size numeric,
    pack_label text
  ) on commit drop;
  truncate table q7_auto_purchase_work;

  v_forecast := public.get_q7_purchase_forecast(v_run_date, 14);

  for v_item in
    select value from jsonb_array_elements(coalesce(v_forecast -> 'items', '[]'::jsonb))
  loop
    if (v_item ->> 'reorder_date') is null
       or (v_item ->> 'reorder_date')::date > v_run_date + 1
       or coalesce((v_item ->> 'suggested_qty')::numeric, 0) <= 0 then
      continue;
    end if;

    v_mode := coalesce(v_item ->> 'mode', 'suggest');
    v_flags := coalesce(v_item -> 'flags', '{}'::jsonb);
    v_amount := coalesce((v_item ->> 'estimated_amount')::numeric, 0);
    v_reasons := '{}'::text[];

    if v_mode = 'off' then
      v_decision := 'skip';
      v_reasons := array['mode_off'];
    elsif v_mode = 'suggest' then
      v_decision := 'suggest';
      v_reasons := array['mode_suggest'];
    elsif v_mode = 'auto_draft' then
      v_decision := 'draft';
      v_reasons := array['mode_auto_draft'];
    else
      if coalesce((v_flags ->> 'no_stock_count')::boolean, false) then v_reasons := v_reasons || 'no_stock_count'::text; end if;
      if coalesce((v_flags ->> 'stale_stock_count')::boolean, false) then v_reasons := v_reasons || 'stale_stock_count'::text; end if;
      if coalesce((v_flags ->> 'high_backtest_error')::boolean, false) then v_reasons := v_reasons || 'high_backtest_error'::text; end if;
      if coalesce((v_flags ->> 'no_supplier')::boolean, false) then v_reasons := v_reasons || 'no_supplier'::text; end if;
      if coalesce((v_flags ->> 'no_pack_size')::boolean, false) then v_reasons := v_reasons || 'no_pack_size'::text; end if;
      if coalesce((v_flags ->> 'no_price')::boolean, false) then v_reasons := v_reasons || 'no_price'::text; end if;
      if coalesce((v_flags ->> 'duplicate_material')::boolean, false) then v_reasons := v_reasons || 'duplicate_material'::text; end if;
      if v_amount > v_settings.max_po_amount then v_reasons := v_reasons || 'over_po_limit'::text; end if;
      if v_day_auto_sent + v_amount > v_settings.max_daily_amount then v_reasons := v_reasons || 'over_daily_limit'::text; end if;

      if coalesce(array_length(v_reasons, 1), 0) = 0 then
        v_decision := 'auto_send';
        v_reasons := array['auto_send'];
      else
        v_decision := 'draft';
      end if;
    end if;

    v_decision_id := gen_random_uuid();
    insert into public.q7_auto_purchase_decisions (
      id, run_id, item_id, decision, reason_codes,
      forecast_avg_14d, forecast_avg_28d, forecast_stddev_28d,
      on_hand, open_po_qty, suggested_qty, reorder_date, unit_price, amount
    ) values (
      v_decision_id, v_run_id, (v_item ->> 'item_id')::uuid, v_decision, v_reasons,
      (v_item ->> 'avg_14d')::numeric, (v_item ->> 'avg_28d')::numeric, (v_item ->> 'stddev_28d')::numeric,
      (v_item ->> 'on_hand')::numeric, (v_item ->> 'open_po_qty')::numeric,
      (v_item ->> 'suggested_qty')::numeric, (v_item ->> 'reorder_date')::date,
      (v_item ->> 'last_unit_price')::numeric, (v_item ->> 'estimated_amount')::numeric
    );

    v_decision_count := v_decision_count + 1;
    if v_decision = 'suggest' then v_suggest_count := v_suggest_count + 1; end if;
    if v_decision = 'skip' then v_skip_count := v_skip_count + 1; end if;

    if v_decision in ('draft', 'auto_send') then
      insert into q7_auto_purchase_work (
        decision_id, item_id, item_name, unit, supplier_id, decision, reason_codes,
        suggested_qty, unit_price, amount, pack_size, pack_label
      ) values (
        v_decision_id,
        (v_item ->> 'item_id')::uuid,
        v_item ->> 'item_name',
        v_item ->> 'unit',
        nullif(v_item ->> 'supplier_id', '')::uuid,
        v_decision,
        v_reasons,
        (v_item ->> 'suggested_qty')::numeric,
        (v_item ->> 'last_unit_price')::numeric,
        (v_item ->> 'estimated_amount')::numeric,
        (v_item ->> 'pack_size')::numeric,
        v_item ->> 'pack_label'
      );
    end if;
  end loop;

  for v_sup in
    select supplier_id from q7_auto_purchase_work
    group by supplier_id
    order by supplier_id nulls last
  loop
    v_po_id := gen_random_uuid();
    v_po_number := public.generate_po_number();
    v_po_total := 0;
    v_all_auto := true;

    insert into public.purchase_orders (
      id, po_number, supplier_id, status, order_date, notes, created_by, total_amount
    ) values (
      v_po_id, v_po_number, v_sup, 'draft'::public.purchase_order_status,
      v_run_date, v_po_note, v_settings.system_actor_id, 0
    );

    for v_line in
      select * from q7_auto_purchase_work where supplier_id is not distinct from v_sup
      order by item_name, decision_id
    loop
      if v_line.decision <> 'auto_send' then
        v_all_auto := false;
      end if;

      v_qty_po := case
        when v_line.pack_size is not null and v_line.pack_size > 0
          then round(v_line.suggested_qty / v_line.pack_size, 3)
        else v_line.suggested_qty
      end;
      v_unit_po := coalesce(v_line.pack_label, v_line.unit);
      v_price_po := case
        when v_line.pack_size is not null and v_line.pack_size > 0
          then round(coalesce(v_line.unit_price, 0) * v_line.pack_size, 2)
        else v_line.unit_price
      end;
      v_line_total := round(v_line.suggested_qty * coalesce(v_line.unit_price, 0), 2);

      insert into public.purchase_order_items (
        purchase_order_id, product_name, quantity, unit, unit_price, line_total
      ) values (
        v_po_id, v_line.item_name, v_qty_po, v_unit_po, v_price_po, v_line_total
      );

      update public.q7_auto_purchase_decisions
      set purchase_order_id = v_po_id
      where id = v_line.decision_id;

      v_po_total := v_po_total + v_line_total;
    end loop;

    update public.purchase_orders set total_amount = v_po_total where id = v_po_id;

    if v_all_auto then
      if v_po_total <= v_settings.max_po_amount
         and v_day_auto_sent + v_po_total <= v_settings.max_daily_amount then
        begin
          perform set_config('request.jwt.claim.role', 'service_role', true);
          perform public.update_purchase_order_status_with_material_controller(
            v_po_id, 'sent', v_settings.system_actor_id
          );
          perform set_config('request.jwt.claim.role', '', true);
          v_day_auto_sent := v_day_auto_sent + v_po_total;
          v_sent_po_ids := array_append(v_sent_po_ids, v_po_id);
          v_sent_count := v_sent_count + 1;
          v_auto_send_count := v_auto_send_count + 1;
        exception when others then
          perform set_config('request.jwt.claim.role', 'service_role', true);
          update public.q7_auto_purchase_decisions
          set decision = 'draft',
              reason_codes = reason_codes || array['system_error'],
              error_message = sqlerrm
          where purchase_order_id = v_po_id;
          v_draft_po_ids := array_append(v_draft_po_ids, v_po_id);
          v_draft_count := v_draft_count + 1;
        end;
      else
        if v_po_total > v_settings.max_po_amount then
          update public.q7_auto_purchase_decisions
          set decision = 'draft', reason_codes = reason_codes || array['over_po_limit']
          where purchase_order_id = v_po_id;
        end if;
        if v_day_auto_sent + v_po_total > v_settings.max_daily_amount then
          update public.q7_auto_purchase_decisions
          set decision = 'draft', reason_codes = reason_codes || array['over_daily_limit']
          where purchase_order_id = v_po_id;
        end if;
        v_draft_po_ids := array_append(v_draft_po_ids, v_po_id);
        v_draft_count := v_draft_count + 1;
      end if;
    else
      v_draft_po_ids := array_append(v_draft_po_ids, v_po_id);
      v_draft_count := v_draft_count + 1;
    end if;
  end loop;

  -- Internal Zalo outbox: one notice per sent PO and one daily digest.
  for v_po_id in select unnest(v_sent_po_ids) loop
    insert into public.finance_zalo_notifications (
      event_type, entity_id, group_key, message_body, status
    ) values (
      'auto_purchase_order_sent', v_po_id, 'finance',
      coalesce(public.build_q7_auto_purchase_order_message(v_po_id), 'Đơn hàng tự động'),
      'pending'
    )
    on conflict (event_type, entity_id) do nothing;
  end loop;

  insert into public.finance_zalo_notifications (
    event_type, entity_id, group_key, message_body, status
  ) values (
    'auto_purchase_daily_summary', v_run_id, 'finance',
    coalesce(public.build_q7_auto_purchase_summary_message(v_run_id), 'Tổng hợp đặt hàng tự động'),
    'pending'
  )
  on conflict (event_type, entity_id) do nothing;

  update public.q7_auto_purchase_runs
  set status = 'done',
      finished_at = now(),
      summary = jsonb_build_object(
        'decisions', v_decision_count,
        'suggested', v_suggest_count,
        'skipped', v_skip_count,
        'draft_pos', v_draft_count,
        'auto_sent_pos', v_sent_count,
        'auto_sent_amount', v_day_auto_sent
      )
  where id = v_run_id;

  return jsonb_build_object(
    'status', 'done',
    'run_id', v_run_id,
    'run_date', v_run_date,
    'idempotent', false,
    'summary', jsonb_build_object(
      'decisions', v_decision_count,
      'suggested', v_suggest_count,
      'skipped', v_skip_count,
      'draft_pos', v_draft_count,
      'auto_sent_pos', v_sent_count,
      'auto_sent_amount', v_day_auto_sent
    )
  );
exception when others then
  if v_run_id is not null then
    update public.q7_auto_purchase_runs
    set status = 'failed', finished_at = now(),
        summary = jsonb_build_object('error', sqlerrm)
    where id = v_run_id;
  end if;
  raise;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. UI RPCs
-- ---------------------------------------------------------------------------

create or replace function public.get_q7_auto_purchase_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_settings jsonb;
  v_run jsonb;
  v_decisions jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.q7_material_inventory_can_view(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  select to_jsonb(s) into v_settings
  from public.q7_auto_purchase_settings s where s.id = 1;

  select to_jsonb(r) into v_run
  from public.q7_auto_purchase_runs r
  order by r.run_date desc
  limit 1;

  select coalesce(jsonb_agg(x order by x.created_at desc), '[]'::jsonb) into v_decisions
  from (
    select d.id, d.run_id, d.item_id, kii.name as item_name, d.decision,
           d.reason_codes, d.suggested_qty, d.estimated_amount,
           d.purchase_order_id, po.po_number as purchase_order_number,
           d.created_at
    from public.q7_auto_purchase_decisions d
    join public.kitchen_inventory_items kii on kii.id = d.item_id
    left join public.purchase_orders po on po.id = d.purchase_order_id
    order by d.created_at desc
    limit 30
  ) x;

  return jsonb_build_object(
    'settings', coalesce(v_settings, '{}'::jsonb),
    'latest_run', v_run,
    'decisions', v_decisions
  );
end;
$$;

create or replace function public.upsert_q7_purchase_item_setting(
  p_kitchen_inventory_item_id uuid,
  p_mode text,
  p_supplier_id uuid default null,
  p_pack_size numeric default null,
  p_pack_label text default null,
  p_lead_time_days integer default null,
  p_safety_days numeric default null,
  p_order_cycle_days integer default null,
  p_max_order_qty numeric default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_mode text := lower(btrim(coalesce(p_mode, '')));
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.q7_material_inventory_can_edit(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
    if v_mode = 'auto_send' and not public.has_role(v_actor, 'owner') then
      raise exception 'owner_required_for_auto_send' using errcode = '42501';
    end if;
  end if;

  if p_kitchen_inventory_item_id is null then
    raise exception 'kitchen_inventory_item_required' using errcode = '22023';
  end if;
  if v_mode not in ('off', 'suggest', 'auto_draft', 'auto_send') then
    raise exception 'invalid_mode' using errcode = '22023';
  end if;
  if p_pack_size is not null and (p_pack_size <= 0 or p_pack_size::text in ('NaN', 'Infinity', '-Infinity')) then
    raise exception 'invalid_pack_size' using errcode = '22023';
  end if;
  if p_lead_time_days is not null and (p_lead_time_days < 0 or p_lead_time_days > 365) then
    raise exception 'invalid_lead_time_days' using errcode = '22023';
  end if;
  if p_safety_days is not null and (p_safety_days < 0 or p_safety_days::text in ('NaN', 'Infinity', '-Infinity')) then
    raise exception 'invalid_safety_days' using errcode = '22023';
  end if;
  if p_order_cycle_days is not null and (p_order_cycle_days < 1 or p_order_cycle_days > 180) then
    raise exception 'invalid_order_cycle_days' using errcode = '22023';
  end if;
  if p_max_order_qty is not null and (p_max_order_qty <= 0 or p_max_order_qty::text in ('NaN', 'Infinity', '-Infinity')) then
    raise exception 'invalid_max_order_qty' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.kitchen_inventory_items
    where id = p_kitchen_inventory_item_id and active = true
  ) then
    raise exception 'q7_item_not_found' using errcode = 'P0002';
  end if;
  if p_supplier_id is not null and not exists (
    select 1 from public.suppliers where id = p_supplier_id
  ) then
    raise exception 'supplier_not_found' using errcode = 'P0002';
  end if;

  insert into public.q7_purchase_item_settings (
    kitchen_inventory_item_id, mode, supplier_id, pack_size, pack_label,
    lead_time_days, safety_days, order_cycle_days, max_order_qty, updated_by, updated_at
  ) values (
    p_kitchen_inventory_item_id, v_mode, p_supplier_id, p_pack_size, nullif(btrim(p_pack_label), ''),
    p_lead_time_days, p_safety_days, coalesce(p_order_cycle_days, 7), p_max_order_qty, v_actor, now()
  )
  on conflict (kitchen_inventory_item_id) do update set
    mode = excluded.mode,
    supplier_id = excluded.supplier_id,
    pack_size = excluded.pack_size,
    pack_label = excluded.pack_label,
    lead_time_days = excluded.lead_time_days,
    safety_days = excluded.safety_days,
    order_cycle_days = excluded.order_cycle_days,
    max_order_qty = excluded.max_order_qty,
    updated_by = excluded.updated_by,
    updated_at = now();

  return jsonb_build_object(
    'status', 'saved',
    'kitchen_inventory_item_id', p_kitchen_inventory_item_id,
    'mode', v_mode
  );
end;
$$;

create or replace function public.update_q7_auto_purchase_settings(
  p_enabled boolean default null,
  p_system_actor_id uuid default null,
  p_max_po_amount numeric default null,
  p_max_daily_amount numeric default null,
  p_max_stock_count_age_days integer default null,
  p_max_backtest_error numeric default null,
  p_run_hour_vn integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_settings public.q7_auto_purchase_settings%rowtype;
  v_actor_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.has_role(v_actor, 'owner') then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  select * into v_settings from public.q7_auto_purchase_settings where id = 1 for update;

  v_actor_id := coalesce(p_system_actor_id, v_settings.system_actor_id);
  if coalesce(p_enabled, v_settings.enabled) then
    if v_actor_id is null or not public.has_role(v_actor_id, 'owner') then
      raise exception 'system_actor_must_be_owner' using errcode = '22023';
    end if;
  end if;

  if p_max_po_amount is not null and (p_max_po_amount < 0 or p_max_po_amount::text in ('NaN', 'Infinity', '-Infinity')) then
    raise exception 'invalid_max_po_amount' using errcode = '22023';
  end if;
  if p_max_daily_amount is not null and (p_max_daily_amount < 0 or p_max_daily_amount::text in ('NaN', 'Infinity', '-Infinity')) then
    raise exception 'invalid_max_daily_amount' using errcode = '22023';
  end if;
  if p_max_stock_count_age_days is not null and (p_max_stock_count_age_days < 0 or p_max_stock_count_age_days > 365) then
    raise exception 'invalid_max_stock_count_age_days' using errcode = '22023';
  end if;
  if p_max_backtest_error is not null and (p_max_backtest_error < 0 or p_max_backtest_error::text in ('NaN', 'Infinity', '-Infinity')) then
    raise exception 'invalid_max_backtest_error' using errcode = '22023';
  end if;
  if p_run_hour_vn is not null and (p_run_hour_vn < 0 or p_run_hour_vn > 23) then
    raise exception 'invalid_run_hour_vn' using errcode = '22023';
  end if;

  update public.q7_auto_purchase_settings
  set enabled = coalesce(p_enabled, enabled),
      system_actor_id = coalesce(p_system_actor_id, system_actor_id),
      max_po_amount = coalesce(p_max_po_amount, max_po_amount),
      max_daily_amount = coalesce(p_max_daily_amount, max_daily_amount),
      max_stock_count_age_days = coalesce(p_max_stock_count_age_days, max_stock_count_age_days),
      max_backtest_error = coalesce(p_max_backtest_error, max_backtest_error),
      run_hour_vn = coalesce(p_run_hour_vn, run_hour_vn),
      updated_by = v_actor,
      updated_at = now()
  where id = 1;

  select * into v_settings from public.q7_auto_purchase_settings where id = 1;
  return jsonb_build_object('status', 'updated', 'settings', to_jsonb(v_settings));
end;
$$;

create or replace function public.run_q7_auto_purchase_now()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.has_role(v_actor, 'owner') then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;
  return public.run_q7_auto_purchase((now() at time zone 'Asia/Ho_Chi_Minh')::date);
end;
$$;

create or replace function public.create_q7_draft_purchase_orders(
  p_lines jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_existing jsonb;
  v_line jsonb;
  v_sup uuid;
  v_po_id uuid;
  v_po_number text;
  v_po_total numeric;
  v_po_ids uuid[] := '{}'::uuid[];
  v_result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.q7_material_inventory_can_edit(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;
  if v_key is null then
    raise exception 'idempotency_key_required' using errcode = '22023';
  end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'lines_required' using errcode = '22023';
  end if;

  select result into v_existing
  from public.q7_auto_purchase_idempotency
  where idempotency_key = v_key;
  if found then
    return v_existing || jsonb_build_object('idempotent', true);
  end if;

  for v_sup in
    select distinct nullif(value ->> 'supplier_id', '')::uuid
    from jsonb_array_elements(p_lines)
    order by 1 nulls last
  loop
    v_po_id := gen_random_uuid();
    v_po_number := public.generate_po_number();
    v_po_total := 0;
    insert into public.purchase_orders (
      id, po_number, supplier_id, status, order_date, notes, created_by, total_amount
    ) values (
      v_po_id, v_po_number, v_sup, 'draft'::public.purchase_order_status,
      (now() at time zone 'Asia/Ho_Chi_Minh')::date,
      'Đề xuất mua NVL Q7', v_actor, 0
    );

    for v_line in
      select value from jsonb_array_elements(p_lines)
      where nullif(value ->> 'supplier_id', '')::uuid is not distinct from v_sup
    loop
      v_po_total := v_po_total + round(
        coalesce((v_line ->> 'quantity')::numeric, 0) * coalesce((v_line ->> 'unit_price')::numeric, 0),
        2
      );
      insert into public.purchase_order_items (
        purchase_order_id, product_name, quantity, unit, unit_price, line_total
      ) values (
        v_po_id,
        coalesce(nullif(btrim(v_line ->> 'product_name'), ''), 'NVL Q7'),
        round(coalesce((v_line ->> 'quantity')::numeric, 0), 3),
        nullif(btrim(v_line ->> 'unit'), ''),
        (v_line ->> 'unit_price')::numeric,
        round(coalesce((v_line ->> 'quantity')::numeric, 0) * coalesce((v_line ->> 'unit_price')::numeric, 0), 2)
      );
    end loop;

    update public.purchase_orders set total_amount = v_po_total where id = v_po_id;
    v_po_ids := array_append(v_po_ids, v_po_id);
  end loop;

  v_result := jsonb_build_object('status', 'created', 'purchase_order_ids', to_jsonb(v_po_ids), 'count', coalesce(array_length(v_po_ids, 1), 0));
  insert into public.q7_auto_purchase_idempotency (idempotency_key, result, created_by)
  values (v_key, v_result, v_actor)
  on conflict (idempotency_key) do nothing;

  select result into v_existing
  from public.q7_auto_purchase_idempotency
  where idempotency_key = v_key;

  return coalesce(v_existing, v_result) || jsonb_build_object('idempotent', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- 10. Zalo event type constraint
-- ---------------------------------------------------------------------------

alter table public.finance_zalo_notifications
  drop constraint if exists finance_zalo_notifications_event_type_check;

alter table public.finance_zalo_notifications
  add constraint finance_zalo_notifications_event_type_check
  check (event_type in (
    'payment_request_created',
    'payment_request_paid',
    'goods_receipt_received',
    'goods_receipt_short',
    'payment_submission_created',
    'payment_cash_advanced',
    'payment_cash_settled',
    'salary_payout_created',
    'salary_payout_advanced',
    'salary_payout_completed',
    'auto_purchase_order_sent',
    'auto_purchase_daily_summary'
  ));

-- ---------------------------------------------------------------------------
-- 11. Function grants
-- ---------------------------------------------------------------------------

revoke all on function public.q7_reason_label(text) from public, anon, authenticated;
grant execute on function public.q7_reason_label(text) to service_role;

revoke all on function public.q7_pack_from_name(text, text) from public, anon;
grant execute on function public.q7_pack_from_name(text, text) to authenticated, service_role;

revoke all on function public.q7_purchase_daily_usage(uuid, date) from public, anon;
grant execute on function public.q7_purchase_daily_usage(uuid, date) to authenticated, service_role;

revoke all on function public.get_q7_purchase_forecast(date, integer) from public, anon;
grant execute on function public.get_q7_purchase_forecast(date, integer) to authenticated, service_role;

revoke all on function public.q7_backtest_relative_error(uuid, date) from public, anon, authenticated;
grant execute on function public.q7_backtest_relative_error(uuid, date) to service_role;

revoke all on function public.learn_q7_purchase_parameters() from public, anon;
grant execute on function public.learn_q7_purchase_parameters() to authenticated, service_role;

revoke all on function public.build_q7_auto_purchase_order_message(uuid) from public, anon, authenticated;
grant execute on function public.build_q7_auto_purchase_order_message(uuid) to service_role;

revoke all on function public.build_q7_auto_purchase_summary_message(uuid) from public, anon, authenticated;
grant execute on function public.build_q7_auto_purchase_summary_message(uuid) to service_role;

revoke all on function public.run_q7_auto_purchase(date) from public, anon, authenticated;
grant execute on function public.run_q7_auto_purchase(date) to service_role;

revoke all on function public.get_q7_auto_purchase_status() from public, anon;
grant execute on function public.get_q7_auto_purchase_status() to authenticated, service_role;

revoke all on function public.upsert_q7_purchase_item_setting(uuid, text, uuid, numeric, text, integer, numeric, integer, numeric) from public, anon;
grant execute on function public.upsert_q7_purchase_item_setting(uuid, text, uuid, numeric, text, integer, numeric, integer, numeric) to authenticated, service_role;

revoke all on function public.update_q7_auto_purchase_settings(boolean, uuid, numeric, numeric, integer, numeric, integer) from public, anon;
grant execute on function public.update_q7_auto_purchase_settings(boolean, uuid, numeric, numeric, integer, numeric, integer) to authenticated, service_role;

revoke all on function public.run_q7_auto_purchase_now() from public, anon;
grant execute on function public.run_q7_auto_purchase_now() to authenticated, service_role;

revoke all on function public.create_q7_draft_purchase_orders(jsonb, text) from public, anon;
grant execute on function public.create_q7_draft_purchase_orders(jsonb, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 12. Schedules
-- ---------------------------------------------------------------------------

do $$
declare
  existing_job_id bigint;
begin
  for existing_job_id in
    select jobid from cron.job where jobname = 'q7-auto-purchase-daily'
  loop
    perform cron.unschedule(existing_job_id);
  end loop;
  for existing_job_id in
    select jobid from cron.job where jobname = 'q7-auto-purchase-learn-weekly'
  loop
    perform cron.unschedule(existing_job_id);
  end loop;

  perform cron.schedule(
    'q7-auto-purchase-daily',
    '0 23 * * *',
    $job$ select public.run_q7_auto_purchase(); $job$
  );

  perform cron.schedule(
    'q7-auto-purchase-learn-weekly',
    '30 22 * * 0',
    $job$ select public.learn_q7_purchase_parameters(); $job$
  );
end;
$$;
