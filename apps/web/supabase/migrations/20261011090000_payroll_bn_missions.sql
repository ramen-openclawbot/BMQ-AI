-- ============================================================================
-- Migration: Bếp BN surprise-reward missions (2026-10-11, nền — chưa áp prod)
--
-- Adds the non-UI foundation for the "nhiệm vụ thưởng bất ngờ" programme:
--   * payroll_bn_mission_templates  — template theo kỳ (params/thưởng là cấu hình)
--   * payroll_bn_mission_settings   — N nhân viên tối đa + trần ngân sách theo kỳ
--   * payroll_bn_missions           — nhiệm vụ của từng nhân viên trong kỳ
--   * payroll_bn_mission_bonuses    — 1 khoản cho mỗi nhiệm vụ, cùng kỳ M
--   * payroll_bn_mission_audit      — nhật ký kiểm tra phía server
--   * payroll_bn_mission_draws      — mỗi lần bốc thăm (pool + kết quả) của kỳ
--   * RPC suggest / draw / publish / discard / update_suggestion / evaluate /
--     manager_confirm / create_bonuses
--
-- Rules: at most N employees per period (server-enforced on publish), one
-- mission per employee per period, mode=pay requires a reward, the budget cap
-- blocks (and reports the overage), publish only accepts a mission of the latest
-- draw, and a locked period rejects every mission or bonus write. No amount is
-- ever put in a NOTICE or a log message.
--
-- This migration has NOT been applied to production.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1) payroll_bn_mission_templates — per-period template configuration
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_bn_mission_templates (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references public.payroll_bn_periods(id) on delete cascade,
  code text not null,
  name text not null,
  description text,
  verification text not null default 'auto',
  applies_to jsonb not null default '{}'::jsonb,
  params jsonb not null default '{}'::jsonb,
  reward_vnd numeric(15,2),
  accept_deadline timestamptz,
  prorate_allowed boolean not null default false,
  mode text not null default 'pay',
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payroll_bn_mission_templates_code_check
    check (code in ('T-DUNGGIO', 'T-CHAMDU', 'T-CHUYENCAN', 'T-GIOPT', 'T-QL')),
  constraint payroll_bn_mission_templates_verification_check
    check (verification in ('auto', 'manager')),
  constraint payroll_bn_mission_templates_mode_check
    check (mode in ('pay', 'reconcile_only')),
  constraint payroll_bn_mission_templates_applies_object_check
    check (jsonb_typeof(applies_to) = 'object'),
  constraint payroll_bn_mission_templates_params_object_check
    check (jsonb_typeof(params) = 'object'),
  constraint payroll_bn_mission_templates_reward_check
    check (reward_vnd is null or reward_vnd >= 0),
  constraint payroll_bn_mission_templates_unique unique (period_id, code)
);

create index if not exists idx_payroll_bn_mission_templates_period
  on public.payroll_bn_mission_templates(period_id, enabled);

-- ---------------------------------------------------------------------------
-- 2) payroll_bn_mission_settings — N = max_employees (default 2) + budget
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_bn_mission_settings (
  period_id uuid primary key references public.payroll_bn_periods(id) on delete cascade,
  max_employees integer not null default 2,
  budget_vnd numeric(15,2),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payroll_bn_mission_settings_max_check check (max_employees >= 0),
  constraint payroll_bn_mission_settings_budget_check check (budget_vnd is null or budget_vnd >= 0)
);

-- ---------------------------------------------------------------------------
-- 3) payroll_bn_missions — one mission row per employee / period / template
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_bn_missions (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references public.payroll_bn_periods(id) on delete cascade,
  employee_code text not null,
  template_id uuid not null references public.payroll_bn_mission_templates(id) on delete cascade,
  status text not null default 'suggested',
  reason_text text,
  source_metrics jsonb not null default '{}'::jsonb,
  reward_vnd numeric(15,2),
  accepted_at timestamptz,
  result_evidence jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint payroll_bn_missions_status_check check (
    status in (
      'suggested', 'published', 'accepted', 'achieved', 'not_achieved',
      'needs_review', 'expired', 'cancelled', 'paid'
    )
  ),
  constraint payroll_bn_missions_source_object_check
    check (jsonb_typeof(source_metrics) = 'object'),
  constraint payroll_bn_missions_reward_check
    check (reward_vnd is null or reward_vnd >= 0),
  constraint payroll_bn_missions_unique unique (employee_code, period_id, template_id)
);

create index if not exists idx_payroll_bn_missions_period
  on public.payroll_bn_missions(period_id, status);
create index if not exists idx_payroll_bn_missions_employee
  on public.payroll_bn_missions(employee_code, period_id);

-- ---------------------------------------------------------------------------
-- 4) payroll_bn_mission_bonuses — one bonus per mission, same period M
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_bn_mission_bonuses (
  id uuid primary key default gen_random_uuid(),
  mission_id uuid not null unique references public.payroll_bn_missions(id) on delete cascade,
  period_id uuid not null references public.payroll_bn_periods(id) on delete cascade,
  employee_code text not null,
  amount_vnd numeric(15,2) not null,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint payroll_bn_mission_bonuses_amount_check check (amount_vnd >= 0)
);

create index if not exists idx_payroll_bn_mission_bonuses_period
  on public.payroll_bn_mission_bonuses(period_id, employee_code);

-- ---------------------------------------------------------------------------
-- 5) payroll_bn_mission_audit — server-side audit trail for every write RPC
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_bn_mission_audit (
  id uuid primary key default gen_random_uuid(),
  period_id uuid references public.payroll_bn_periods(id) on delete cascade,
  mission_id uuid,
  actor uuid default auth.uid() references auth.users(id) on delete set null,
  "at" timestamptz not null default now(),
  action text not null,
  old jsonb,
  new jsonb,
  reason text
);

create index if not exists idx_payroll_bn_mission_audit_period
  on public.payroll_bn_mission_audit(period_id, "at" desc);
create index if not exists idx_payroll_bn_mission_audit_mission
  on public.payroll_bn_mission_audit(mission_id, "at" desc);

-- ---------------------------------------------------------------------------
-- 5b) payroll_bn_mission_draws — one row per draw of a period
--     pool   = [{ employee_code, mission_ids: [uuid, …] }, …]  (snapshot)
--     picked = [{ employee_code, mission_id: uuid }, …]        (result)
-- ---------------------------------------------------------------------------
create table if not exists public.payroll_bn_mission_draws (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references public.payroll_bn_periods(id) on delete cascade,
  draw_no integer not null,
  pool jsonb not null default '[]'::jsonb,
  picked jsonb not null default '[]'::jsonb,
  reason text,
  drawn_by uuid default auth.uid() references auth.users(id) on delete set null,
  drawn_at timestamptz not null default now(),
  constraint payroll_bn_mission_draws_no_check check (draw_no >= 1),
  constraint payroll_bn_mission_draws_pool_array_check check (jsonb_typeof(pool) = 'array'),
  constraint payroll_bn_mission_draws_picked_array_check check (jsonb_typeof(picked) = 'array'),
  constraint payroll_bn_mission_draws_unique unique (period_id, draw_no)
);

create index if not exists idx_payroll_bn_mission_draws_period
  on public.payroll_bn_mission_draws(period_id, draw_no desc);

-- ---------------------------------------------------------------------------
-- 6) updated_at triggers
-- ---------------------------------------------------------------------------
drop trigger if exists set_updated_at_payroll_bn_mission_templates on public.payroll_bn_mission_templates;
create trigger set_updated_at_payroll_bn_mission_templates
  before update on public.payroll_bn_mission_templates
  for each row execute function public.handle_updated_at();

drop trigger if exists set_updated_at_payroll_bn_mission_settings on public.payroll_bn_mission_settings;
create trigger set_updated_at_payroll_bn_mission_settings
  before update on public.payroll_bn_mission_settings
  for each row execute function public.handle_updated_at();

drop trigger if exists set_updated_at_payroll_bn_missions on public.payroll_bn_missions;
create trigger set_updated_at_payroll_bn_missions
  before update on public.payroll_bn_missions
  for each row execute function public.handle_updated_at();

-- ---------------------------------------------------------------------------
-- 7) Lock guard — a locked period is read-only for missions and bonuses
--    (reuses the existing payroll_bn_guard_locked_period trigger function)
-- ---------------------------------------------------------------------------
drop trigger if exists payroll_bn_guard_locked_period_missions on public.payroll_bn_missions;
create trigger payroll_bn_guard_locked_period_missions
  before insert or update or delete on public.payroll_bn_missions
  for each row execute function public.payroll_bn_guard_locked_period();

drop trigger if exists payroll_bn_guard_locked_period_mission_bonuses on public.payroll_bn_mission_bonuses;
create trigger payroll_bn_guard_locked_period_mission_bonuses
  before insert or update or delete on public.payroll_bn_mission_bonuses
  for each row execute function public.payroll_bn_guard_locked_period();

drop trigger if exists payroll_bn_guard_locked_period_mission_draws on public.payroll_bn_mission_draws;
create trigger payroll_bn_guard_locked_period_mission_draws
  before insert or update or delete on public.payroll_bn_mission_draws
  for each row execute function public.payroll_bn_guard_locked_period();

-- ---------------------------------------------------------------------------
-- 8) RLS — read needs payroll view, config writes need payroll edit; the
--    mission/bonus/audit rows are written only through the security-definer RPCs
-- ---------------------------------------------------------------------------
alter table public.payroll_bn_mission_templates enable row level security;
alter table public.payroll_bn_mission_settings enable row level security;
alter table public.payroll_bn_missions enable row level security;
alter table public.payroll_bn_mission_bonuses enable row level security;
alter table public.payroll_bn_mission_audit enable row level security;
alter table public.payroll_bn_mission_draws enable row level security;

-- templates
drop policy if exists payroll_bn_mission_templates_select on public.payroll_bn_mission_templates;
create policy payroll_bn_mission_templates_select on public.payroll_bn_mission_templates
  for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'view')
  );
drop policy if exists payroll_bn_mission_templates_write on public.payroll_bn_mission_templates;
create policy payroll_bn_mission_templates_write on public.payroll_bn_mission_templates
  for all to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  )
  with check (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  );

-- settings
drop policy if exists payroll_bn_mission_settings_select on public.payroll_bn_mission_settings;
create policy payroll_bn_mission_settings_select on public.payroll_bn_mission_settings
  for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'view')
  );
drop policy if exists payroll_bn_mission_settings_write on public.payroll_bn_mission_settings;
create policy payroll_bn_mission_settings_write on public.payroll_bn_mission_settings
  for all to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  )
  with check (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  );

-- missions (read only; every write goes through an RPC)
drop policy if exists payroll_bn_missions_select on public.payroll_bn_missions;
create policy payroll_bn_missions_select on public.payroll_bn_missions
  for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'view')
  );

-- bonuses (read only)
drop policy if exists payroll_bn_mission_bonuses_select on public.payroll_bn_mission_bonuses;
create policy payroll_bn_mission_bonuses_select on public.payroll_bn_mission_bonuses
  for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'view')
  );

-- audit (read only; payroll editors may read the trail of the programme)
drop policy if exists payroll_bn_mission_audit_select on public.payroll_bn_mission_audit;
create policy payroll_bn_mission_audit_select on public.payroll_bn_mission_audit
  for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'view')
  );

-- draws (read only; every write goes through payroll_bn_mission_draw)
drop policy if exists payroll_bn_mission_draws_select on public.payroll_bn_mission_draws;
create policy payroll_bn_mission_draws_select on public.payroll_bn_mission_draws
  for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'view')
  );

-- ---------------------------------------------------------------------------
-- 9) RPC — idempotent candidate suggestion; only touches status='suggested'
-- ---------------------------------------------------------------------------
create or replace function public.payroll_bn_mission_suggest(
  _period_id uuid,
  _suggestions jsonb
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_period public.payroll_bn_periods%rowtype;
  v_count integer := 0;
  v_item jsonb;
  v_employee text;
  v_code text;
  v_reason text;
  v_metrics jsonb;
  v_template_id uuid;
  v_id uuid;
begin
  if not (
    public.has_role(v_uid, 'owner')
    or public.has_module_permission(v_uid, 'payroll', 'edit')
  ) then
    raise exception 'insufficient_privilege: payroll edit required' using errcode = '42501';
  end if;

  select * into v_period from public.payroll_bn_periods where id = _period_id;
  if v_period.id is null then
    raise exception 'payroll_bn_period_not_found' using errcode = 'P0002';
  end if;
  if v_period.status = 'locked' then
    raise exception 'payroll_bn_period_locked' using errcode = '55006';
  end if;
  if _suggestions is null or jsonb_typeof(_suggestions) <> 'array' then
    raise exception 'payroll_bn_mission_invalid_suggestions' using errcode = '22023';
  end if;

  for v_item in select * from jsonb_array_elements(_suggestions) loop
    v_employee := nullif(btrim(v_item->>'employee_code'), '');
    v_code := nullif(btrim(v_item->>'template_code'), '');
    if v_employee is null or v_code is null then
      raise exception 'payroll_bn_mission_invalid_suggestion' using errcode = '22023';
    end if;

    select id into v_template_id
    from public.payroll_bn_mission_templates
    where period_id = _period_id and code = v_code and enabled;
    if v_template_id is null then
      raise exception 'payroll_bn_mission_template_not_found' using errcode = 'P0002';
    end if;

    v_reason := nullif(btrim(coalesce(v_item->>'reason_text', '')), '');
    v_metrics := coalesce(v_item->'source_metrics', '{}'::jsonb);
    if jsonb_typeof(v_metrics) <> 'object' then
      raise exception 'payroll_bn_mission_invalid_metrics' using errcode = '22023';
    end if;

    v_id := null;
    insert into public.payroll_bn_missions(
      period_id, employee_code, template_id, status, reason_text, source_metrics
    )
    values (_period_id, v_employee, v_template_id, 'suggested', v_reason, v_metrics)
    on conflict (employee_code, period_id, template_id) do nothing
    returning id into v_id;

    if v_id is null then
      -- Existing row: never overwrite a mission that already left 'suggested'.
      update public.payroll_bn_missions
         set reason_text = v_reason,
             source_metrics = v_metrics
       where employee_code = v_employee
         and period_id = _period_id
         and template_id = v_template_id
         and status = 'suggested'
      returning id into v_id;

      -- If it was already published/later, keep it and read its id back.
      if v_id is null then
        select id into v_id
        from public.payroll_bn_missions
        where employee_code = v_employee and period_id = _period_id and template_id = v_template_id;
      end if;
    end if;

    insert into public.payroll_bn_mission_audit(period_id, mission_id, actor, action, new, reason)
    values (
      _period_id,
      v_id,
      v_uid,
      'suggest',
      jsonb_build_object('employee_code', v_employee, 'template_code', v_code),
      v_reason
    );
    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;

comment on function public.payroll_bn_mission_suggest(uuid, jsonb)
  is 'Idempotent mission suggestion. Only updates rows still in status suggested; writes an audit row per suggestion; no amount is logged.';

-- ---------------------------------------------------------------------------
-- 9b) RPC — draw (bốc thăm) up to N employees of the period
--     * locks the settings row (serialises concurrent draws on a period);
--     * only while no mission is published-or-later and the period is open;
--     * draw_no > 1 requires a non-blank reason;
--     * picks up to max_employees distinct employees with suggested missions,
--       then one random suggested mission per drawn employee;
--     * stores pool + result in payroll_bn_mission_draws and audits the write
--       (no amount is ever logged).
-- ---------------------------------------------------------------------------
create or replace function public.payroll_bn_mission_draw(
  _period_id uuid,
  _reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_period public.payroll_bn_periods%rowtype;
  v_settings public.payroll_bn_mission_settings%rowtype;
  v_reason text := nullif(btrim(coalesce(_reason, '')), '');
  v_draw_no integer;
  v_max integer;
  v_pool jsonb;
  v_picked jsonb;
  v_id uuid;
begin
  if not (
    public.has_role(v_uid, 'owner')
    or public.has_module_permission(v_uid, 'payroll', 'edit')
  ) then
    raise exception 'insufficient_privilege: payroll edit required' using errcode = '42501';
  end if;

  select * into v_period from public.payroll_bn_periods where id = _period_id;
  if v_period.id is null then
    raise exception 'payroll_bn_period_not_found' using errcode = 'P0002';
  end if;
  if v_period.status = 'locked' then
    raise exception 'payroll_bn_period_locked' using errcode = '55006';
  end if;

  -- A draw after a mission left 'suggested' would strand that mission.
  if exists (
    select 1
    from public.payroll_bn_missions m
    where m.period_id = _period_id
      and m.status in ('published', 'accepted', 'achieved', 'not_achieved', 'needs_review', 'paid')
  ) then
    raise exception 'payroll_bn_mission_draw_after_publish' using errcode = '55006';
  end if;

  -- Serialise concurrent draws on the period settings row.
  select * into v_settings
  from public.payroll_bn_mission_settings
  where period_id = _period_id
  for update;
  if v_settings.period_id is null then
    insert into public.payroll_bn_mission_settings(period_id, max_employees)
    values (_period_id, 2)
    on conflict (period_id) do nothing;
    select * into v_settings
    from public.payroll_bn_mission_settings
    where period_id = _period_id
    for update;
  end if;
  v_max := v_settings.max_employees;

  select coalesce(max(d.draw_no), 0) + 1 into v_draw_no
  from public.payroll_bn_mission_draws d
  where d.period_id = _period_id;

  if v_draw_no > 1 and v_reason is null then
    raise exception 'payroll_bn_mission_draw_reason_required' using errcode = '22023';
  end if;

  -- Snapshot of the suggested missions grouped per employee.
  select coalesce(
           jsonb_agg(
             jsonb_build_object('employee_code', p.employee_code, 'mission_ids', p.mission_ids)
           ),
           '[]'::jsonb
         )
    into v_pool
  from (
    select m.employee_code, jsonb_agg(m.id order by m.created_at, m.id) as mission_ids
    from public.payroll_bn_missions m
    join public.payroll_bn_mission_templates t on t.id = m.template_id
    where m.period_id = _period_id
      and m.status = 'suggested'
      -- Only missions that can pay: a reconcile-only mission must not use one of the slots.
      and t.enabled
      and t.mode = 'pay'
    group by m.employee_code
  ) p;

  if jsonb_array_length(v_pool) = 0 then
    raise exception 'payroll_bn_mission_draw_empty_pool' using errcode = '22023';
  end if;

  -- Up to max_employees distinct employees (order by random()), then one random
  -- suggested mission of each. `picked` is always within the pool snapshot.
  with chosen as (
    select value->>'employee_code' as employee_code,
           value->'mission_ids' as mission_ids
    from jsonb_array_elements(v_pool) as entry(value)
    order by random()
    limit v_max
  )
  select coalesce(
           jsonb_agg(
             jsonb_build_object('employee_code', c.employee_code, 'mission_id', picked.mission_id)
           ),
           '[]'::jsonb
         )
    into v_picked
  from chosen c
  cross join lateral (
    select c.mission_ids ->> floor(random() * jsonb_array_length(c.mission_ids))::int as mission_id
  ) picked;

  insert into public.payroll_bn_mission_draws(period_id, draw_no, pool, picked, reason, drawn_by)
  values (_period_id, v_draw_no, v_pool, v_picked, v_reason, v_uid)
  returning id into v_id;

  insert into public.payroll_bn_mission_audit(period_id, actor, action, new, reason)
  values (
    _period_id,
    v_uid,
    'draw',
    jsonb_build_object('draw_no', v_draw_no, 'picked', v_picked),
    v_reason
  );

  return jsonb_build_object(
    'id', v_id,
    'period_id', _period_id,
    'draw_no', v_draw_no,
    'pool', v_pool,
    'picked', v_picked
  );
end;
$$;

comment on function public.payroll_bn_mission_draw(uuid, text)
  is 'Draw up to max_employees distinct employees with suggested missions, then one random suggested mission each. Locks the settings row, rejects a locked period / a published mission / a second draw without reason / an empty pool, writes payroll_bn_mission_draws and an audit row, and never logs an amount.';

-- ---------------------------------------------------------------------------
-- 10) RPC — publish a mission (server-enforced N + one-per-employee + budget)
-- ---------------------------------------------------------------------------
create or replace function public.payroll_bn_mission_publish(_mission_id uuid)
returns public.payroll_bn_missions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_mission public.payroll_bn_missions%rowtype;
  v_period public.payroll_bn_periods%rowtype;
  v_template public.payroll_bn_mission_templates%rowtype;
  v_settings public.payroll_bn_mission_settings%rowtype;
  v_distinct integer;
  v_total numeric(15,2);
  v_reward numeric(15,2);
  v_over numeric(15,2);
begin
  if not (
    public.has_role(v_uid, 'owner')
    or public.has_module_permission(v_uid, 'payroll', 'edit')
  ) then
    raise exception 'insufficient_privilege: payroll edit required' using errcode = '42501';
  end if;

  select * into v_mission from public.payroll_bn_missions where id = _mission_id for update;
  if v_mission.id is null then
    raise exception 'payroll_bn_mission_not_found' using errcode = 'P0002';
  end if;

  select * into v_period from public.payroll_bn_periods where id = v_mission.period_id;
  if v_period.status = 'locked' then
    raise exception 'payroll_bn_period_locked' using errcode = '55006';
  end if;

  -- Idempotent: an already published mission is returned unchanged.
  if v_mission.status = 'published' then
    return v_mission;
  end if;
  if v_mission.status <> 'suggested' then
    raise exception 'payroll_bn_mission_invalid_status' using errcode = '22023';
  end if;

  select * into v_template from public.payroll_bn_mission_templates where id = v_mission.template_id;

  -- Serialise concurrent publishes on the period settings row.
  select * into v_settings
  from public.payroll_bn_mission_settings
  where period_id = v_mission.period_id
  for update;
  if v_settings.period_id is null then
    insert into public.payroll_bn_mission_settings(period_id, max_employees)
    values (v_mission.period_id, 2)
    on conflict (period_id) do nothing;
    select * into v_settings
    from public.payroll_bn_mission_settings
    where period_id = v_mission.period_id
    for update;
  end if;

  -- One mission per employee per period.
  if exists (
    select 1
    from public.payroll_bn_missions m
    where m.period_id = v_mission.period_id
      and m.employee_code = v_mission.employee_code
      and m.id <> v_mission.id
      and m.status not in ('cancelled', 'expired')
  ) then
    raise exception 'payroll_bn_mission_one_per_employee' using errcode = '23505';
  end if;

  -- N = max_employees distinct employees already published (or later).
  select count(distinct m.employee_code) into v_distinct
  from public.payroll_bn_missions m
  where m.period_id = v_mission.period_id
    and m.id <> v_mission.id
    and m.status in ('published', 'accepted', 'achieved', 'not_achieved', 'needs_review', 'paid');

  if v_distinct >= v_settings.max_employees then
    raise exception 'payroll_bn_mission_max_employees:%', v_settings.max_employees
      using errcode = '23514';
  end if;

  v_reward := coalesce(v_mission.reward_vnd, v_template.reward_vnd);
  if v_template.mode = 'pay' and v_reward is null then
    raise exception 'payroll_bn_mission_reward_required' using errcode = '22023';
  end if;

  if v_settings.budget_vnd is not null then
    select coalesce(sum(coalesce(m.reward_vnd, t.reward_vnd, 0)), 0) into v_total
    from public.payroll_bn_missions m
    join public.payroll_bn_mission_templates t on t.id = m.template_id
    where m.period_id = v_mission.period_id
      and m.id <> v_mission.id
      and t.mode = 'pay'
      and m.status in ('published', 'accepted', 'achieved', 'not_achieved', 'needs_review', 'paid');

    if v_total + coalesce(v_reward, 0) > v_settings.budget_vnd then
      v_over := v_total + coalesce(v_reward, 0) - v_settings.budget_vnd;
      raise exception 'payroll_bn_mission_budget_exceeded:%', trim(to_char(v_over, 'FM999999999999990'))
        using errcode = '23514';
    end if;
  end if;

  -- Vòng 2 — only a mission of the latest draw may be published.
  if not exists (
    select 1
    from public.payroll_bn_mission_draws d
    where d.period_id = v_mission.period_id
      and d.draw_no = (
        select max(d2.draw_no)
        from public.payroll_bn_mission_draws d2
        where d2.period_id = v_mission.period_id
      )
      and exists (
        select 1
        from jsonb_array_elements(d.picked) as p(value)
        where p.value->>'mission_id' = v_mission.id::text
      )
  ) then
    raise exception 'payroll_bn_mission_not_drawn' using errcode = '22023';
  end if;

  update public.payroll_bn_missions
     set status = 'published',
         reward_vnd = v_reward
   where id = v_mission.id
  returning * into v_mission;

  insert into public.payroll_bn_mission_audit(period_id, mission_id, actor, action, old, new)
  values (
    v_mission.period_id,
    v_mission.id,
    v_uid,
    'publish',
    jsonb_build_object('status', 'suggested'),
    jsonb_build_object('status', 'published')
  );

  return v_mission;
end;
$$;

comment on function public.payroll_bn_mission_publish(uuid)
  is 'Publish one suggested mission. Locks the period settings row, enforces max_employees, one mission per employee, mode=pay reward and the budget cap (error carries the overage). Owner/payroll edit only.';

-- ---------------------------------------------------------------------------
-- 11) RPC — discard a suggestion (reason required) and update a suggestion
-- ---------------------------------------------------------------------------
create or replace function public.payroll_bn_mission_discard(
  _mission_id uuid,
  _reason text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_mission public.payroll_bn_missions%rowtype;
  v_reason text := nullif(btrim(coalesce(_reason, '')), '');
begin
  if not (
    public.has_role(v_uid, 'owner')
    or public.has_module_permission(v_uid, 'payroll', 'edit')
  ) then
    raise exception 'insufficient_privilege: payroll edit required' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'payroll_bn_mission_reason_required' using errcode = '22023';
  end if;

  select * into v_mission from public.payroll_bn_missions where id = _mission_id for update;
  if v_mission.id is null then
    raise exception 'payroll_bn_mission_not_found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.payroll_bn_periods p where p.id = v_mission.period_id and p.status = 'locked') then
    raise exception 'payroll_bn_period_locked' using errcode = '55006';
  end if;
  if v_mission.status = 'cancelled' then
    return; -- idempotent
  end if;
  if v_mission.status <> 'suggested' then
    raise exception 'payroll_bn_mission_invalid_status' using errcode = '22023';
  end if;

  update public.payroll_bn_missions set status = 'cancelled' where id = v_mission.id;

  insert into public.payroll_bn_mission_audit(period_id, mission_id, actor, action, old, new, reason)
  values (
    v_mission.period_id, v_mission.id, v_uid, 'discard',
    jsonb_build_object('status', v_mission.status),
    jsonb_build_object('status', 'cancelled'),
    v_reason
  );
end;
$$;

comment on function public.payroll_bn_mission_discard(uuid, text)
  is 'Cancel a suggested mission with a mandatory reason. A locked period is rejected; a cancelled mission is idempotent.';

create or replace function public.payroll_bn_mission_update_suggestion(
  _mission_id uuid,
  _reason_text text,
  _source_metrics jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_mission public.payroll_bn_missions%rowtype;
  v_metrics jsonb := coalesce(_source_metrics, '{}'::jsonb);
begin
  if not (
    public.has_role(v_uid, 'owner')
    or public.has_module_permission(v_uid, 'payroll', 'edit')
  ) then
    raise exception 'insufficient_privilege: payroll edit required' using errcode = '42501';
  end if;
  if jsonb_typeof(v_metrics) <> 'object' then
    raise exception 'payroll_bn_mission_invalid_metrics' using errcode = '22023';
  end if;

  select * into v_mission from public.payroll_bn_missions where id = _mission_id for update;
  if v_mission.id is null then
    raise exception 'payroll_bn_mission_not_found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.payroll_bn_periods p where p.id = v_mission.period_id and p.status = 'locked') then
    raise exception 'payroll_bn_period_locked' using errcode = '55006';
  end if;
  if v_mission.status <> 'suggested' then
    raise exception 'payroll_bn_mission_invalid_status' using errcode = '22023';
  end if;

  update public.payroll_bn_missions
     set reason_text = nullif(btrim(coalesce(_reason_text, '')), ''),
         source_metrics = v_metrics
   where id = v_mission.id;

  insert into public.payroll_bn_mission_audit(period_id, mission_id, actor, action, old, new)
  values (
    v_mission.period_id, v_mission.id, v_uid, 'update_suggestion',
    jsonb_build_object('reason_text', v_mission.reason_text, 'source_metrics', v_mission.source_metrics),
    jsonb_build_object('reason_text', nullif(btrim(coalesce(_reason_text, '')), ''), 'source_metrics', v_metrics)
  );
end;
$$;

comment on function public.payroll_bn_mission_update_suggestion(uuid, text, jsonb)
  is 'Update a still-suggested mission. Published or later missions are refused.';

-- ---------------------------------------------------------------------------
-- 12) RPC — auto evaluation (attendance of M approved, M not locked)
-- ---------------------------------------------------------------------------
create or replace function public.payroll_bn_mission_evaluate(
  _mission_id uuid,
  _result_status text,
  _result_evidence jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_mission public.payroll_bn_missions%rowtype;
  v_period public.payroll_bn_periods%rowtype;
begin
  if not (
    public.has_role(v_uid, 'owner')
    or public.has_module_permission(v_uid, 'payroll', 'edit')
  ) then
    raise exception 'insufficient_privilege: payroll edit required' using errcode = '42501';
  end if;
  if _result_status not in ('achieved', 'not_achieved', 'needs_review') then
    raise exception 'payroll_bn_mission_invalid_result' using errcode = '22023';
  end if;

  select * into v_mission from public.payroll_bn_missions where id = _mission_id for update;
  if v_mission.id is null then
    raise exception 'payroll_bn_mission_not_found' using errcode = 'P0002';
  end if;

  select * into v_period from public.payroll_bn_periods where id = v_mission.period_id;
  if v_period.status = 'locked' then
    raise exception 'payroll_bn_period_locked' using errcode = '55006';
  end if;
  if v_period.attendance_approved_at is null then
    raise exception 'payroll_bn_mission_attendance_not_approved' using errcode = '55006';
  end if;
  if v_mission.status not in ('accepted', 'needs_review') then
    raise exception 'payroll_bn_mission_invalid_status' using errcode = '22023';
  end if;

  update public.payroll_bn_missions
     set status = _result_status,
         result_evidence = coalesce(_result_evidence, '{}'::jsonb)
   where id = v_mission.id;

  insert into public.payroll_bn_mission_audit(period_id, mission_id, actor, action, old, new)
  values (
    v_mission.period_id, v_mission.id, v_uid, 'evaluate',
    jsonb_build_object('status', v_mission.status),
    jsonb_build_object('status', _result_status, 'result_evidence', coalesce(_result_evidence, '{}'::jsonb))
  );
end;
$$;

comment on function public.payroll_bn_mission_evaluate(uuid, text, jsonb)
  is 'Record the deterministic evaluation of a mission. Requires the period attendance to be approved and the period not locked.';

-- ---------------------------------------------------------------------------
-- 13) RPC — manager confirmation (mandatory reason)
-- ---------------------------------------------------------------------------
create or replace function public.payroll_bn_mission_manager_confirm(
  _mission_id uuid,
  _result_status text,
  _reason text,
  _result_evidence jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_mission public.payroll_bn_missions%rowtype;
  v_reason text := nullif(btrim(coalesce(_reason, '')), '');
begin
  if not (
    public.has_role(v_uid, 'owner')
    or public.has_module_permission(v_uid, 'payroll', 'edit')
  ) then
    raise exception 'insufficient_privilege: payroll edit required' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'payroll_bn_mission_manager_reason_required' using errcode = '22023';
  end if;
  if _result_status not in ('achieved', 'not_achieved', 'needs_review') then
    raise exception 'payroll_bn_mission_invalid_result' using errcode = '22023';
  end if;

  select * into v_mission from public.payroll_bn_missions where id = _mission_id for update;
  if v_mission.id is null then
    raise exception 'payroll_bn_mission_not_found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.payroll_bn_periods p where p.id = v_mission.period_id and p.status = 'locked') then
    raise exception 'payroll_bn_period_locked' using errcode = '55006';
  end if;
  if v_mission.status not in ('accepted', 'needs_review') then
    raise exception 'payroll_bn_mission_invalid_status' using errcode = '22023';
  end if;

  update public.payroll_bn_missions
     set status = _result_status,
         result_evidence = coalesce(_result_evidence, '{}'::jsonb)
   where id = v_mission.id;

  insert into public.payroll_bn_mission_audit(period_id, mission_id, actor, action, old, new, reason)
  values (
    v_mission.period_id, v_mission.id, v_uid, 'manager_confirm',
    jsonb_build_object('status', v_mission.status),
    jsonb_build_object('status', _result_status, 'result_evidence', coalesce(_result_evidence, '{}'::jsonb)),
    v_reason
  );
end;
$$;

comment on function public.payroll_bn_mission_manager_confirm(uuid, text, text, jsonb)
  is 'Manager confirmation of a mission result. A non-blank reason is mandatory; a locked period is rejected.';

-- ---------------------------------------------------------------------------
-- 14) RPC — create the period bonuses (idempotent per mission)
-- ---------------------------------------------------------------------------
create or replace function public.payroll_bn_mission_create_bonuses(_period_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_period public.payroll_bn_periods%rowtype;
  v_budget numeric(15,2);
  v_count integer := 0;
begin
  if not (
    public.has_role(v_uid, 'owner')
    or public.has_module_permission(v_uid, 'payroll', 'edit')
  ) then
    raise exception 'insufficient_privilege: payroll edit required' using errcode = '42501';
  end if;

  select * into v_period from public.payroll_bn_periods where id = _period_id;
  if v_period.id is null then
    raise exception 'payroll_bn_period_not_found' using errcode = 'P0002';
  end if;
  if v_period.status = 'locked' then
    raise exception 'payroll_bn_period_locked' using errcode = '55006';
  end if;

  select budget_vnd into v_budget
  from public.payroll_bn_mission_settings
  where period_id = _period_id;

  -- Rule 8 — reward null or cap null: never add money.
  if v_budget is null then
    return 0;
  end if;

  with inserted as (
    insert into public.payroll_bn_mission_bonuses(mission_id, period_id, employee_code, amount_vnd)
    select
      m.id,
      m.period_id,
      m.employee_code,
      coalesce(m.reward_vnd, t.reward_vnd)
    from public.payroll_bn_missions m
    join public.payroll_bn_mission_templates t on t.id = m.template_id
    where m.period_id = _period_id
      and m.status = 'achieved'
      and t.mode = 'pay'
      and coalesce(m.reward_vnd, t.reward_vnd) is not null
      and coalesce(m.reward_vnd, t.reward_vnd) > 0
    on conflict (mission_id) do nothing
    returning mission_id, employee_code, amount_vnd
  )
  insert into public.payroll_bn_mission_audit(period_id, mission_id, actor, action, new)
  select _period_id, mission_id, v_uid, 'create_bonus',
         jsonb_build_object('employee_code', employee_code, 'amount_vnd', amount_vnd)
  from inserted;

  get diagnostics v_count = row_count;

  -- A mission whose bonus is on this period's payroll is "đã cộng lương"; from
  -- here a change needs an audited adjustment, never a silent re-evaluation.
  update public.payroll_bn_missions m
     set status = 'paid'
   where m.period_id = _period_id
     and m.status = 'achieved'
     and exists (select 1 from public.payroll_bn_mission_bonuses b where b.mission_id = m.id);

  return v_count;
end;
$$;

comment on function public.payroll_bn_mission_create_bonuses(uuid)
  is 'Insert the achieved pay-mission bonuses of a period (one row per mission, unique mission_id). A locked period is rejected; a null reward or null cap adds nothing.';

-- ---------------------------------------------------------------------------
-- 15) Grants — explicit, because this project has no default table grants.
--     The mission/bonus/audit rows are written only through the RPCs above.
-- ---------------------------------------------------------------------------
revoke all on public.payroll_bn_mission_templates from public, anon, authenticated;
revoke all on public.payroll_bn_mission_settings from public, anon, authenticated;
revoke all on public.payroll_bn_missions from public, anon, authenticated;
revoke all on public.payroll_bn_mission_bonuses from public, anon, authenticated;
revoke all on public.payroll_bn_mission_audit from public, anon, authenticated;
revoke all on public.payroll_bn_mission_draws from public, anon, authenticated;

grant select, insert, update, delete on public.payroll_bn_mission_templates to authenticated;
grant select, insert, update, delete on public.payroll_bn_mission_settings to authenticated;
grant select on public.payroll_bn_missions to authenticated;
grant select on public.payroll_bn_mission_bonuses to authenticated;
grant select on public.payroll_bn_mission_audit to authenticated;
grant select on public.payroll_bn_mission_draws to authenticated;

grant all on public.payroll_bn_mission_templates to service_role;
grant all on public.payroll_bn_mission_settings to service_role;
grant all on public.payroll_bn_missions to service_role;
grant all on public.payroll_bn_mission_bonuses to service_role;
grant all on public.payroll_bn_mission_audit to service_role;
grant all on public.payroll_bn_mission_draws to service_role;

revoke all on function public.payroll_bn_mission_suggest(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.payroll_bn_mission_suggest(uuid, jsonb) to authenticated;

revoke all on function public.payroll_bn_mission_draw(uuid, text) from public, anon, authenticated;
grant execute on function public.payroll_bn_mission_draw(uuid, text) to authenticated;

revoke all on function public.payroll_bn_mission_publish(uuid) from public, anon, authenticated;
grant execute on function public.payroll_bn_mission_publish(uuid) to authenticated;

revoke all on function public.payroll_bn_mission_discard(uuid, text) from public, anon, authenticated;
grant execute on function public.payroll_bn_mission_discard(uuid, text) to authenticated;

revoke all on function public.payroll_bn_mission_update_suggestion(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.payroll_bn_mission_update_suggestion(uuid, text, jsonb) to authenticated;

revoke all on function public.payroll_bn_mission_evaluate(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.payroll_bn_mission_evaluate(uuid, text, jsonb) to authenticated;

revoke all on function public.payroll_bn_mission_manager_confirm(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.payroll_bn_mission_manager_confirm(uuid, text, text, jsonb) to authenticated;

revoke all on function public.payroll_bn_mission_create_bonuses(uuid) from public, anon, authenticated;
grant execute on function public.payroll_bn_mission_create_bonuses(uuid) to authenticated;
