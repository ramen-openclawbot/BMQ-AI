-- Heo Đất Tết — dealer enrollment (join / decline) and the spin gate.
--
-- Additive and re-runnable. Nothing is applied to a production database from
-- this repository step; this file only defines the schema and service-role RPCs.

create table if not exists public.dealer_heo_enrollments (
  campaign_id uuid not null references public.dealer_heo_campaigns(id) on delete cascade,
  customer_id uuid not null references public.mini_crm_customers(id) on delete cascade,
  is_test boolean not null default false,
  status text not null check (status in ('joined', 'declined')),
  joined_on date,
  decided_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (campaign_id, customer_id, is_test)
);

alter table public.dealer_heo_enrollments enable row level security;

-- No anon/authenticated policies on purpose: Edge Functions use the service role.
revoke all on table public.dealer_heo_enrollments from public, anon, authenticated;
grant all on table public.dealer_heo_enrollments to service_role;

-- Record the dealer's decision for one campaign and test/real mode.
--
-- * joined: joined_on is stamped the first time (or after a decline); joining
--   again keeps the existing joined_on and changes nothing.
-- * declined: only allowed before joining. A dealer that already joined cannot
--   leave, so money already in the pig is never invalidated.
create or replace function public.dealer_heo_set_enrollment(
  p_campaign_id uuid,
  p_customer_id uuid,
  p_is_test boolean,
  p_status text,
  p_today date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row public.dealer_heo_enrollments%rowtype;
begin
  if p_status is null or p_status not in ('joined', 'declined') then
    raise exception 'heo_invalid_status';
  end if;

  -- Serialize decisions per dealer + test/real mode, regardless of campaign.
  perform pg_advisory_xact_lock(
    hashtextextended(p_customer_id::text || ':' || p_is_test::text, 0)
  );

  select * into v_row
  from public.dealer_heo_enrollments
  where campaign_id = p_campaign_id
    and customer_id = p_customer_id
    and is_test = p_is_test
  for update;

  if found then
    if v_row.status = 'joined' then
      -- Already joined: keep joined_on and the row untouched, even for a
      -- repeat join or a decline attempt.
      return to_jsonb(v_row);
    end if;

    if p_status = 'joined' then
      update public.dealer_heo_enrollments
      set status = 'joined',
          joined_on = p_today,
          decided_at = now(),
          updated_at = now()
      where campaign_id = p_campaign_id
        and customer_id = p_customer_id
        and is_test = p_is_test
      returning * into v_row;
    else
      update public.dealer_heo_enrollments
      set status = 'declined',
          joined_on = null,
          decided_at = now(),
          updated_at = now()
      where campaign_id = p_campaign_id
        and customer_id = p_customer_id
        and is_test = p_is_test
      returning * into v_row;
    end if;

    return to_jsonb(v_row);
  end if;

  insert into public.dealer_heo_enrollments (
    campaign_id,
    customer_id,
    is_test,
    status,
    joined_on
  ) values (
    p_campaign_id,
    p_customer_id,
    p_is_test,
    p_status,
    case when p_status = 'joined' then p_today else null end
  )
  on conflict (campaign_id, customer_id, is_test) do nothing
  returning * into v_row;

  if v_row.campaign_id is null then
    select * into v_row
    from public.dealer_heo_enrollments
    where campaign_id = p_campaign_id
      and customer_id = p_customer_id
      and is_test = p_is_test;
  end if;

  return to_jsonb(v_row);
end;
$$;

-- Same spin function as 20261121150000 with the enrollment gate added after
-- order validation and before the prize draw. Existing spins still replay by
-- order_id, so an old result is never lost.
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

  -- The dealer must explicitly join before spinning. The replay branch above
  -- runs first, so re-spinning the same order still returns the old result.
  if not exists (
    select 1
    from public.dealer_heo_enrollments e
    where e.campaign_id = p_campaign_id
      and e.customer_id = p_customer_id
      and e.is_test = p_is_test
      and e.status = 'joined'
  ) then
    raise exception 'heo_not_enrolled';
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

revoke all on function public.dealer_heo_set_enrollment(uuid, uuid, boolean, text, date)
  from public, anon, authenticated;
grant execute on function public.dealer_heo_set_enrollment(uuid, uuid, boolean, text, date)
  to service_role;

revoke all on function public.dealer_heo_spin(uuid, uuid, uuid, boolean, date, date)
  from public, anon, authenticated;
grant execute on function public.dealer_heo_spin(uuid, uuid, uuid, boolean, date, date)
  to service_role;

comment on table public.dealer_heo_enrollments is
  'Per-dealer Heo Đất Tết join/decline decision; test decisions are separate rows.';
comment on function public.dealer_heo_set_enrollment(uuid, uuid, boolean, text, date) is
  'Service-role enrollment upsert. Joining is one-way: joined_on is stamped once and decline is ignored afterwards.';
comment on function public.dealer_heo_spin(uuid, uuid, uuid, boolean, date, date) is
  'Draw one spin for an eligible order; requires a joined enrollment and replays by order_id.';
