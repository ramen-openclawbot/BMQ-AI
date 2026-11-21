-- Heo Đất Tết + Lắc Heo — server-side configuration, November baselines and spins.
--
-- Additive and re-runnable. Nothing is applied to the production database from
-- this repository step; this file only defines the schema and service-role RPCs.

create table if not exists public.dealer_heo_campaigns (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  title text not null,
  starts_on date not null,
  ends_on date not null,
  break_on date,
  test_starts_on date,
  rate_per_extra_que_vnd integer not null default 0,
  spin_enabled boolean not null default false,
  spin_ev_target_vnd integer,
  spin_budget_vnd bigint not null default 0,
  -- Bread prizes count against the spin budget at this cost per que.
  bread_unit_cost_vnd integer not null default 5400,
  weekly_jackpot_vnd integer not null default 0,
  prizes jsonb not null default '[]'::jsonb,
  excluded_customer_ids uuid[] not null default '{}'::uuid[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dealer_heo_campaigns_dates_check check (ends_on >= starts_on),
  constraint dealer_heo_campaigns_prizes_check check (jsonb_typeof(prizes) = 'array')
);

insert into public.dealer_heo_campaigns (
  code,
  title,
  starts_on,
  ends_on,
  break_on,
  test_starts_on,
  rate_per_extra_que_vnd,
  spin_enabled,
  spin_ev_target_vnd,
  spin_budget_vnd,
  weekly_jackpot_vnd,
  prizes,
  excluded_customer_ids
) values (
  'heo-tet-2026',
  'Heo Đất Tết',
  date '2026-12-01',
  date '2026-12-31',
  date '2027-01-15',
  date '2026-11-01',
  500,
  false,
  2400,
  3500000,
  500000,
  '[
    {"key":"coin_5000","label":"5.000đ","kind":"coin","amount_vnd":5000,"bread_qty":0,"weight":12},
    {"key":"coin_10000","label":"10.000đ","kind":"coin","amount_vnd":10000,"bread_qty":0,"weight":5},
    {"key":"coin_20000","label":"20.000đ","kind":"coin","amount_vnd":20000,"bread_qty":0,"weight":1},
    {"key":"coin_50000","label":"50.000đ","kind":"coin","amount_vnd":50000,"bread_qty":0,"weight":0.4},
    {"key":"bread_10","label":"10 que bánh mì","kind":"bread","amount_vnd":0,"bread_qty":10,"weight":1},
    {"key":"bread_20","label":"20 que bánh mì","kind":"bread","amount_vnd":0,"bread_qty":20,"weight":0.3},
    {"key":"none","label":"Chúc may mắn","kind":"none","amount_vnd":0,"bread_qty":0,"weight":80.3}
  ]'::jsonb,
  '{9902839c-58ab-4caf-a4d6-5e43ae313333}'::uuid[]
)
on conflict (code) do nothing;

alter table public.dealer_heo_campaigns
  add column if not exists bread_unit_cost_vnd integer not null default 5400;

create table if not exists public.dealer_heo_baselines (
  campaign_id uuid not null references public.dealer_heo_campaigns(id) on delete cascade,
  customer_id uuid not null references public.mini_crm_customers(id) on delete cascade,
  baseline_avg_per_day numeric not null default 0,
  baseline_source text not null default 'nov_2026_avg',
  computed_at timestamptz not null default now(),
  primary key (campaign_id, customer_id)
);

create table if not exists public.dealer_heo_spins (
  id uuid primary key default gen_random_uuid(),
  campaign_id uuid not null references public.dealer_heo_campaigns(id) on delete cascade,
  customer_id uuid not null references public.mini_crm_customers(id) on delete cascade,
  order_id uuid not null unique references public.dealer_orders(id) on delete restrict,
  is_test boolean not null default false,
  prize_key text not null,
  prize_kind text not null,
  amount_vnd integer not null default 0,
  bread_qty integer not null default 0,
  is_jackpot boolean not null default false,
  iso_week text not null,
  created_at timestamptz not null default now(),
  constraint dealer_heo_spins_prize_kind_check check (prize_kind in ('coin', 'bread', 'none')),
  constraint dealer_heo_spins_amount_check check (amount_vnd >= 0),
  constraint dealer_heo_spins_bread_check check (bread_qty >= 0)
);

create index if not exists dealer_heo_spins_campaign_week_idx
  on public.dealer_heo_spins(campaign_id, iso_week);

create index if not exists dealer_heo_spins_customer_created_idx
  on public.dealer_heo_spins(customer_id, created_at desc);

-- A non-test Heo Vàng is a weekly prize: one per campaign + ISO week.
create unique index if not exists dealer_heo_spins_one_jackpot_per_week
  on public.dealer_heo_spins(campaign_id, iso_week)
  where is_jackpot = true and is_test = false;

alter table public.dealer_heo_campaigns enable row level security;
alter table public.dealer_heo_baselines enable row level security;
alter table public.dealer_heo_spins enable row level security;

-- No anon/authenticated policies on purpose: Edge Functions use the service role.
revoke all on table public.dealer_heo_campaigns from public, anon, authenticated;
revoke all on table public.dealer_heo_baselines from public, anon, authenticated;
revoke all on table public.dealer_heo_spins from public, anon, authenticated;
grant all on table public.dealer_heo_campaigns to service_role;
grant all on table public.dealer_heo_baselines to service_role;
grant all on table public.dealer_heo_spins to service_role;

-- Recompute the November 2026 baseline for every active banhmi agency.
-- Baseline = total BMQ-001 que in November / 30, delivery date falling back to
-- the Vietnam calendar date of submitted_at. Customers without November orders
-- are reset to 0. Returns the number of upserted baseline rows.
create or replace function public.dealer_heo_compute_baselines(p_campaign_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign public.dealer_heo_campaigns%rowtype;
  v_count integer := 0;
begin
  select * into v_campaign
  from public.dealer_heo_campaigns
  where id = p_campaign_id;

  if not found then
    raise exception 'heo_campaign_not_found';
  end if;

  insert into public.dealer_heo_baselines (
    campaign_id,
    customer_id,
    baseline_avg_per_day,
    baseline_source,
    computed_at
  )
  select
    p_campaign_id,
    c.id,
    coalesce(sum(i.quantity), 0)::numeric / 30.0,
    'nov_2026_avg',
    now()
  from public.mini_crm_customers c
  left join public.dealer_orders o
    on o.customer_id = c.id
   and o.status <> 'cancelled'
   and o.is_test = false
   and coalesce(
         o.requested_delivery_date,
         (o.submitted_at at time zone 'Asia/Ho_Chi_Minh')::date
       ) between date '2026-11-01' and date '2026-11-30'
  left join public.dealer_order_items i
    on i.order_id = o.id
   and i.sku_code = 'BMQ-001'
  where c.customer_group = 'banhmi_agency'
    and c.is_active = true
    and not (c.id = any(coalesce(v_campaign.excluded_customer_ids, '{}'::uuid[])))
  group by c.id
  on conflict (campaign_id, customer_id) do update
  set baseline_avg_per_day = excluded.baseline_avg_per_day,
      baseline_source = excluded.baseline_source,
      computed_at = excluded.computed_at;

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Draw one spin for an eligible order. Idempotent by order_id. Test spins never
-- consume the budget and never reserve the weekly non-test Heo Vàng.
create or replace function public.dealer_heo_spin(
  p_campaign_id uuid,
  p_customer_id uuid,
  p_order_id uuid,
  p_is_test boolean,
  p_window_start date,
  p_window_end date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_campaign public.dealer_heo_campaigns%rowtype;
  v_order public.dealer_orders%rowtype;
  v_existing public.dealer_heo_spins%rowtype;
  v_spin public.dealer_heo_spins%rowtype;
  v_baseline numeric := 0;
  v_quantity numeric := 0;
  v_delivery_date date;
  v_iso_week text;
  v_spent numeric := 0;
  v_existing_jackpot boolean := false;
  v_jackpot_available boolean := false;
  v_jackpot_won boolean := false;
  v_prizes jsonb;
  v_prize jsonb;
  v_prize_key text;
  v_prize_kind text;
  v_amount integer := 0;
  v_bread integer := 0;
  v_weight numeric;
  v_total_weight numeric := 0;
  v_roll numeric;
  v_running numeric := 0;
begin
  -- Serialize concurrent attempts for the same order.
  perform pg_advisory_xact_lock(hashtextextended(p_order_id::text, 0));

  select * into v_existing
  from public.dealer_heo_spins
  where order_id = p_order_id;

  if found then
    -- Replay only to the same dealer and the same test/real mode.
    if v_existing.customer_id <> p_customer_id then
      raise exception 'heo_order_not_found';
    end if;
    if v_existing.is_test is distinct from p_is_test then
      raise exception 'heo_order_not_eligible';
    end if;
    return to_jsonb(v_existing);
  end if;

  select * into v_campaign
  from public.dealer_heo_campaigns
  where id = p_campaign_id;

  if not found then
    raise exception 'heo_campaign_not_found';
  end if;

  select * into v_order
  from public.dealer_orders
  where id = p_order_id;

  if not found or v_order.customer_id <> p_customer_id then
    raise exception 'heo_order_not_found';
  end if;

  if v_order.status = 'cancelled' or v_order.is_test is distinct from p_is_test then
    raise exception 'heo_order_not_eligible';
  end if;

  if p_window_start is null or p_window_end is null then
    raise exception 'heo_outside_window';
  end if;

  v_delivery_date := coalesce(
    v_order.requested_delivery_date,
    (v_order.submitted_at at time zone 'Asia/Ho_Chi_Minh')::date
  );

  if v_delivery_date is null
     or v_delivery_date < p_window_start
     or v_delivery_date > p_window_end then
    raise exception 'heo_outside_window';
  end if;

  select coalesce(sum(i.quantity), 0)
  into v_quantity
  from public.dealer_order_items i
  where i.order_id = p_order_id
    and i.sku_code = 'BMQ-001';

  select b.baseline_avg_per_day
  into v_baseline
  from public.dealer_heo_baselines b
  where b.campaign_id = p_campaign_id
    and b.customer_id = p_customer_id;

  v_baseline := coalesce(v_baseline, 0);

  -- Test accounts spin on any order with at least 1 que so the flow can be tried.
  if v_baseline > 0 and p_is_test = false then
    if v_quantity < v_baseline then
      raise exception 'heo_order_not_eligible';
    end if;
  elsif v_quantity < 1 then
    raise exception 'heo_order_not_eligible';
  end if;

  if p_is_test = false and v_campaign.spin_enabled is not true then
    raise exception 'heo_spin_disabled';
  end if;

  v_iso_week := to_char(
    (now() at time zone 'Asia/Ho_Chi_Minh')::date,
    'IYYY-"W"IW'
  );

  if p_is_test = false then
    -- Serialize the weekly Heo Vàng decision across different orders too.
    perform pg_advisory_xact_lock(
      hashtextextended('heo-week:' || p_campaign_id::text || ':' || v_iso_week, 0)
    );

    select exists (
      select 1
      from public.dealer_heo_spins s
      where s.campaign_id = p_campaign_id
        and s.is_test = false
        and s.is_jackpot = true
        and s.iso_week = v_iso_week
    ) into v_existing_jackpot;

    -- Spend = coins + bread prizes valued at cost.
    select coalesce(sum(s.amount_vnd + s.bread_qty * v_campaign.bread_unit_cost_vnd), 0)
    into v_spent
    from public.dealer_heo_spins s
    where s.campaign_id = p_campaign_id
      and s.is_test = false;

    v_jackpot_available :=
      coalesce(v_campaign.weekly_jackpot_vnd, 0) > 0
      and not v_existing_jackpot
      and v_spent + v_campaign.weekly_jackpot_vnd <= v_campaign.spin_budget_vnd;
  else
    -- Test spins can show the weekly prize but never reserve its slot.
    v_jackpot_available := coalesce(v_campaign.weekly_jackpot_vnd, 0) > 0;
  end if;

  if v_jackpot_available and random() < 0.02 then
    v_jackpot_won := true;
    v_prize_key := 'heo_vang';
    v_prize_kind := 'coin';
    v_amount := v_campaign.weekly_jackpot_vnd;
    v_bread := 0;
  else
    v_prizes := case
      when jsonb_typeof(v_campaign.prizes) = 'array' then v_campaign.prizes
      else '[]'::jsonb
    end;

    select coalesce(sum(coalesce((p->>'weight')::numeric, 0)), 0)
    into v_total_weight
    from jsonb_array_elements(v_prizes) p;

    if v_total_weight > 0 then
      v_roll := random() * v_total_weight;

      for v_prize in select value from jsonb_array_elements(v_prizes) loop
        v_weight := coalesce((v_prize->>'weight')::numeric, 0);
        v_running := v_running + v_weight;

        if v_roll < v_running then
          v_prize_key := v_prize->>'key';
          v_prize_kind := coalesce(v_prize->>'kind', 'none');
          v_amount := coalesce((v_prize->>'amount_vnd')::integer, 0);
          v_bread := coalesce((v_prize->>'bread_qty')::integer, 0);
          exit;
        end if;
      end loop;
    end if;

    if v_prize_key is null then
      v_prize_key := 'none';
      v_prize_kind := 'none';
      v_amount := 0;
      v_bread := 0;
    end if;
  end if;

  if v_prize_kind = 'none' then
    v_amount := 0;
    v_bread := 0;
  elsif v_prize_kind = 'bread' then
    v_amount := 0;
  elsif v_prize_kind = 'coin' then
    v_bread := 0;
  else
    v_prize_key := 'none';
    v_prize_kind := 'none';
    v_amount := 0;
    v_bread := 0;
  end if;

  if p_is_test = false and (v_amount > 0 or v_bread > 0) then
    if v_spent + v_amount + v_bread * v_campaign.bread_unit_cost_vnd > v_campaign.spin_budget_vnd then
      v_prize_key := 'none';
      v_prize_kind := 'none';
      v_amount := 0;
      v_bread := 0;
      v_jackpot_won := false;
    end if;
  end if;

  insert into public.dealer_heo_spins (
    campaign_id,
    customer_id,
    order_id,
    is_test,
    prize_key,
    prize_kind,
    amount_vnd,
    bread_qty,
    is_jackpot,
    iso_week
  ) values (
    p_campaign_id,
    p_customer_id,
    p_order_id,
    p_is_test,
    coalesce(v_prize_key, 'none'),
    coalesce(v_prize_kind, 'none'),
    coalesce(v_amount, 0),
    coalesce(v_bread, 0),
    v_jackpot_won,
    v_iso_week
  )
  returning * into v_spin;

  return to_jsonb(v_spin);
end;
$$;

revoke all on function public.dealer_heo_compute_baselines(uuid)
  from public, anon, authenticated;
grant execute on function public.dealer_heo_compute_baselines(uuid)
  to service_role;

revoke all on function public.dealer_heo_spin(uuid, uuid, uuid, boolean, date, date)
  from public, anon, authenticated;
grant execute on function public.dealer_heo_spin(uuid, uuid, uuid, boolean, date, date)
  to service_role;

comment on table public.dealer_heo_campaigns is
  'Heo Đất Tết campaign configuration. Service-role access only.';
comment on table public.dealer_heo_baselines is
  'Per-customer November 2026 daily bread-que baseline used by Heo Đất Tết.';
comment on table public.dealer_heo_spins is
  'One row per dealer order spin; order_id unique makes the RPC idempotent.';
