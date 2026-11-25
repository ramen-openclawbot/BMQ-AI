-- ============================================================================
-- Migration: Chấm công giao hàng (delivery tasks) — máy chủ
--
-- Adds, additive only:
--   (a) delivery_driver_settings          — base units per completed day
--       delivery_driver_setting_history   — effective-dated base changes so a
--                                           later setting never rewrites a day
--   (b) delivery_destination_assignments  — driver/units/sort per destination
--   (c) delivery_tasks                    — one destination per delivery date,
--                                           including owner-reopen audit fields
--   (d) payroll_bn_period_employees.delivery_unit_base + delivery employment
--       type / Giao hàng group + payroll_bn_delivery_extras
--   (e) private 'delivery-proofs' bucket, payroll-view-only read, no browser
--       insert/update/delete; 90-day proof retention cron
--   (f) RPCs: generate_delivery_tasks, upsert_delivery_assignment,
--       upsert_delivery_driver_setting, list_delivery_tasks,
--       list_delivery_assignments, delivery_units_by_day,
--       reopen_delivery_task and the service-role complete_delivery_task
--   (g) daily pg_cron at 17:05 UTC (00:05 Vietnam) for the current VN date,
--       a 10-minute same-day refresh so late orders/cancellations arrive, and
--       the 90-day proof-retention cron
--
-- The dealer order tables are only read. No Zalo/notification is sent and the
-- existing payroll groups keep their calculations untouched. This migration has
-- NOT been applied to production.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- (a) Driver setting: base units credited per day with >= 1 completed task
-- ---------------------------------------------------------------------------
create table if not exists public.delivery_driver_settings (
  employee_code text primary key,
  base_units_per_day numeric not null default 0.5,
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint delivery_driver_settings_employee_code_check
    check (length(btrim(employee_code)) > 0),
  constraint delivery_driver_settings_base_units_check
    check (
      base_units_per_day >= 0
      and (base_units_per_day * 4) = trunc(base_units_per_day * 4)
    )
);

comment on table public.delivery_driver_settings is
  'Giao hàng — base units credited for each delivery day with at least one completed destination. 0,25 steps, default 0.5.';

-- Effective-dated history: a later base change must never rewrite a locked
-- month's delivery units. delivery_units_by_day reads this table by task date.
create table if not exists public.delivery_driver_setting_history (
  id uuid primary key default gen_random_uuid(),
  employee_code text not null,
  base_units_per_day numeric not null,
  effective_from date not null,
  created_at timestamptz not null default now(),
  created_by uuid,
  constraint delivery_driver_setting_history_employee_code_check
    check (length(btrim(employee_code)) > 0),
  constraint delivery_driver_setting_history_base_units_check
    check (
      base_units_per_day >= 0
      and (base_units_per_day * 4) = trunc(base_units_per_day * 4)
    ),
  constraint delivery_driver_setting_history_unique
    unique (employee_code, effective_from)
);

create index if not exists delivery_driver_setting_history_employee_date_idx
  on public.delivery_driver_setting_history(employee_code, effective_from desc);

comment on table public.delivery_driver_setting_history is
  'Giao hàng — effective-dated base units per driver. A base change is effective the next Vietnam day, so already completed/locked days keep their old base.';

-- ---------------------------------------------------------------------------
-- (b) Destination assignment: which driver serves a destination, at what units
-- ---------------------------------------------------------------------------
create table if not exists public.delivery_destination_assignments (
  id uuid primary key default gen_random_uuid(),
  destination_customer_id uuid not null unique
    references public.mini_crm_customers(id) on delete cascade,
  employee_code text,
  units numeric not null default 0,
  sort_order integer not null default 0,
  active boolean not null default true,
  note text,
  updated_at timestamptz not null default now(),
  updated_by uuid,
  constraint delivery_destination_assignments_units_check
    check (units >= 0 and (units * 4) = trunc(units * 4)),
  constraint delivery_destination_assignments_sort_order_check
    check (sort_order >= 0),
  constraint delivery_destination_assignments_employee_code_check
    check (employee_code is null or length(btrim(employee_code)) > 0)
);

create index if not exists delivery_destination_assignments_employee_idx
  on public.delivery_destination_assignments(employee_code);

comment on table public.delivery_destination_assignments is
  'Giao hàng — current driver/units/sort order of every delivery destination.';

-- ---------------------------------------------------------------------------
-- (c) One delivery point per date and destination
-- ---------------------------------------------------------------------------
create table if not exists public.delivery_tasks (
  id uuid primary key default gen_random_uuid(),
  delivery_date date not null,
  destination_customer_id uuid not null
    references public.mini_crm_customers(id) on delete restrict,
  destination_name text not null,
  address text,
  employee_code text,
  units numeric not null default 0,
  sort_order integer not null default 0,
  status text not null default 'pending',
  order_ids uuid[] not null default '{}'::uuid[],
  quantity numeric not null default 0,
  items jsonb not null default '[]'::jsonb,
  dealer_note text,
  generated_at timestamptz not null default now(),
  changed_after_completion boolean not null default false,
  completed_at timestamptz,
  completed_session_id uuid
    references public.payroll_bn_payslip_sessions(id) on delete set null,
  device_captured_at timestamptz,
  latitude numeric(9, 6),
  longitude numeric(9, 6),
  accuracy_m numeric,
  distance_m numeric,
  location_attached boolean not null default false,
  photo_path text,
  device_hash text,
  reopened_at timestamptz,
  reopened_by uuid,
  reopen_reason text,
  reopen_evidence jsonb,
  constraint delivery_tasks_status_check
    check (status in ('pending', 'completed', 'cancelled')),
  constraint delivery_tasks_units_check
    check (units >= 0 and (units * 4) = trunc(units * 4)),
  constraint delivery_tasks_quantity_check check (quantity >= 0),
  constraint delivery_tasks_sort_order_check check (sort_order >= 0),
  constraint delivery_tasks_items_array_check check (jsonb_typeof(items) = 'array'),
  constraint delivery_tasks_latitude_check
    check (latitude is null or (latitude >= -90 and latitude <= 90)),
  constraint delivery_tasks_longitude_check
    check (longitude is null or (longitude >= -180 and longitude <= 180)),
  constraint delivery_tasks_accuracy_check
    check (accuracy_m is null or accuracy_m >= 0),
  constraint delivery_tasks_distance_check
    check (distance_m is null or distance_m >= 0),
  constraint delivery_tasks_reopen_reason_check
    check (reopen_reason is null or length(btrim(reopen_reason)) > 0),
  constraint delivery_tasks_unique_destination
    unique (delivery_date, destination_customer_id)
);

create index if not exists delivery_tasks_date_status_idx
  on public.delivery_tasks(delivery_date, status);
create index if not exists delivery_tasks_employee_date_idx
  on public.delivery_tasks(employee_code, delivery_date);
create index if not exists delivery_tasks_destination_idx
  on public.delivery_tasks(destination_customer_id);

comment on table public.delivery_tasks is
  'Giao hàng — one delivery point per date and destination, generated from real (non-test, non-cancelled) dealer orders. Completed rows are never rewritten by generation; a later order change only sets changed_after_completion.';

-- ---------------------------------------------------------------------------
-- (d) Payroll catalogue: delivery unit base, delivery employment type/group,
--     and period extras
-- ---------------------------------------------------------------------------
alter table public.payroll_bn_period_employees
  add column if not exists delivery_unit_base numeric(15,2);

alter table public.payroll_bn_period_employees
  drop constraint if exists payroll_bn_period_employees_type_check;
alter table public.payroll_bn_period_employees
  add constraint payroll_bn_period_employees_type_check
  check (employment_type in ('official', 'part_time', 'delivery'));

alter table public.payroll_bn_period_employees
  drop constraint if exists payroll_bn_period_employees_group_check;
alter table public.payroll_bn_period_employees
  add constraint payroll_bn_period_employees_group_check
  check (group_name in ('Văn phòng', 'Bếp bánh', 'Kho BN', 'Giao hàng'));

alter table public.payroll_bn_period_employees
  drop constraint if exists payroll_bn_period_employees_delivery_unit_base_check;
alter table public.payroll_bn_period_employees
  add constraint payroll_bn_period_employees_delivery_unit_base_check
  check (
    delivery_unit_base is null
    or (
      delivery_unit_base >= 0
      and (delivery_unit_base * 4) = trunc(delivery_unit_base * 4)
    )
  );

create table if not exists public.payroll_bn_delivery_extras (
  id uuid primary key default gen_random_uuid(),
  period_id uuid not null references public.payroll_bn_periods(id) on delete cascade,
  employee_code text not null,
  amount numeric(15,2) not null,
  note text not null,
  work_date date,
  created_by uuid default auth.uid() references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint payroll_bn_delivery_extras_employee_code_check
    check (length(btrim(employee_code)) > 0),
  constraint payroll_bn_delivery_extras_note_check
    check (length(btrim(note)) > 0),
  constraint payroll_bn_delivery_extras_amount_check
    check (amount <> 0)
);

create index if not exists payroll_bn_delivery_extras_period_idx
  on public.payroll_bn_delivery_extras(period_id, employee_code);

comment on table public.payroll_bn_delivery_extras is
  'Giao hàng — period extras (positive or negative) added to the delivery gross pay. The existing locked-period trigger rejects any write to a locked month.';

-- Only a delivery employee of the same period can carry a delivery extra.
create or replace function public.payroll_bn_guard_delivery_extra()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1
    from public.payroll_bn_period_employees e
    where e.period_id = new.period_id
      and e.employee_code = new.employee_code
      and (e.employment_type = 'delivery' or e.group_name = 'Giao hàng')
  ) then
    raise exception 'payroll_bn_delivery_extra_not_delivery' using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function public.payroll_bn_guard_delivery_extra()
  from public, anon, authenticated;

alter table public.payroll_bn_delivery_extras
  alter column created_by set default auth.uid();

-- Attribute every browser insert to the authenticated editor, even if the
-- client omitted or tried to spoof created_by.
create or replace function public.payroll_bn_set_delivery_extra_author()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null then
    new.created_by := auth.uid();
  end if;
  return new;
end;
$$;

revoke all on function public.payroll_bn_set_delivery_extra_author()
  from public, anon, authenticated;

drop trigger if exists payroll_bn_set_delivery_extra_author
  on public.payroll_bn_delivery_extras;
create trigger payroll_bn_set_delivery_extra_author
before insert on public.payroll_bn_delivery_extras
for each row execute function public.payroll_bn_set_delivery_extra_author();

drop trigger if exists payroll_bn_guard_delivery_extra on public.payroll_bn_delivery_extras;
create trigger payroll_bn_guard_delivery_extra
before insert or update on public.payroll_bn_delivery_extras
for each row execute function public.payroll_bn_guard_delivery_extra();

-- The existing generic guard reads period_id and rejects writes when locked.
drop trigger if exists payroll_bn_guard_locked_period_delivery_extras
  on public.payroll_bn_delivery_extras;
create trigger payroll_bn_guard_locked_period_delivery_extras
before insert or update or delete on public.payroll_bn_delivery_extras
for each row execute function public.payroll_bn_guard_locked_period();

-- Keep delivery_unit_base when the monthly opener copies the catalogue.
create or replace function public.payroll_bn_open_period_internal(_month date, _actor uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_month date;
  v_month_to date;
  v_period_code text;
  v_period_name text;
  v_period_id uuid;
  v_existing_code text;
  v_source public.payroll_bn_periods%rowtype;
  v_copied integer := 0;
begin
  v_month := date_trunc(
    'month',
    coalesce(_month, (now() at time zone 'Asia/Ho_Chi_Minh')::date)
  )::date;
  v_month_to := (v_month + interval '1 month' - interval '1 day')::date;
  v_period_code := 'T' || to_char(v_month, 'MM') || '.' || to_char(v_month, 'YYYY');
  v_period_name := 'Kỳ lương tháng '
    || to_char(v_month, 'MM') || '/' || to_char(v_month, 'YYYY')
    || ' — Bếp BN';

  select p.id, p.period_code
    into v_period_id, v_existing_code
  from public.payroll_bn_periods p
  where p.date_from = v_month
    and p.date_to = v_month_to
  limit 1;

  if v_period_id is not null then
    return jsonb_build_object(
      'period_id', v_period_id,
      'period_code', v_existing_code,
      'created', false,
      'copied_employees', 0
    );
  end if;

  perform pg_advisory_xact_lock(hashtext('payroll_bn_open_period')::bigint);

  select p.id, p.period_code
    into v_period_id, v_existing_code
  from public.payroll_bn_periods p
  where p.date_from = v_month
    and p.date_to = v_month_to
  limit 1;

  if v_period_id is not null then
    return jsonb_build_object(
      'period_id', v_period_id,
      'period_code', v_existing_code,
      'created', false,
      'copied_employees', 0
    );
  end if;

  select *
    into v_source
  from public.payroll_bn_periods p
  where p.date_from < v_month
  order by p.date_from desc, p.created_at desc
  limit 1;

  begin
    if v_source.id is null then
      insert into public.payroll_bn_periods (
        period_code, period_name, date_from, date_to, status, holidays
      ) values (
        v_period_code, v_period_name, v_month, v_month_to, 'draft', '[]'::jsonb
      )
      returning id into v_period_id;
    else
      insert into public.payroll_bn_periods (
        period_code, period_name, date_from, date_to, status,
        default_standard_days, standard_days_by_group, holidays, rules_config
      ) values (
        v_period_code, v_period_name, v_month, v_month_to, 'draft',
        v_source.default_standard_days,
        v_source.standard_days_by_group,
        '[]'::jsonb,
        v_source.rules_config
      )
      returning id into v_period_id;
    end if;
  exception when unique_violation then
    select p.id, p.period_code
      into v_period_id, v_existing_code
    from public.payroll_bn_periods p
    where p.period_code = v_period_code
    limit 1;

    return jsonb_build_object(
      'period_id', v_period_id,
      'period_code', coalesce(v_existing_code, v_period_code),
      'created', false,
      'copied_employees', 0
    );
  end;

  if v_source.id is not null then
    insert into public.payroll_bn_period_employees (
      period_id,
      employee_code,
      employee_name,
      group_name,
      employment_type,
      monthly_salary,
      daily_rate,
      hourly_rate,
      overtime_rate,
      allowance,
      delivery_unit_base,
      standard_days_override,
      start_date,
      end_date
    )
    select
      v_period_id,
      e.employee_code,
      e.employee_name,
      e.group_name,
      e.employment_type,
      e.monthly_salary,
      e.daily_rate,
      e.hourly_rate,
      e.overtime_rate,
      e.allowance,
      e.delivery_unit_base,
      null,
      e.start_date,
      e.end_date
    from public.payroll_bn_period_employees e
    where e.period_id = v_source.id
      and (e.end_date is null or e.end_date >= v_month)
    on conflict (period_id, employee_code) do nothing;

    get diagnostics v_copied = row_count;
  end if;

  return jsonb_build_object(
    'period_id', v_period_id,
    'period_code', v_period_code,
    'created', true,
    'copied_employees', v_copied,
    'source_period_code', v_source.period_code
  );
end;
$$;

comment on function public.payroll_bn_open_period_internal(date, uuid)
  is 'Internal idempotent opener for one Bếp BN payroll month: creates a draft period and copies the catalogue of the latest earlier period (including delivery_unit_base), skipping employees who left before the month. Advisory-locked; execute is limited to service_role.';

-- ---------------------------------------------------------------------------
-- (e) Private proof bucket + payroll-view read policy
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'delivery-proofs',
  'delivery-proofs',
  false,
  3145728,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- Managers with payroll view may read; no policy grants browser insert/update/
-- delete. The Edge Function uploads with the service role.
drop policy if exists delivery_proofs_select on storage.objects;
create policy delivery_proofs_select on storage.objects
  for select to authenticated
  using (
    bucket_id = 'delivery-proofs'
    and (
      public.has_role((select auth.uid()), 'owner')
      or public.has_module_permission((select auth.uid()), 'payroll', 'view')
    )
  );

-- ---------------------------------------------------------------------------
-- (f) Permissions helpers (internal)
-- ---------------------------------------------------------------------------
create or replace function public.delivery_can_view(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(auth.role(), '') in ('', 'service_role')
    or public.has_role(p_uid, 'owner')
    or public.has_module_permission(p_uid, 'payroll', 'view');
$$;

create or replace function public.delivery_can_edit(p_uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(auth.role(), '') in ('', 'service_role')
    or public.has_role(p_uid, 'owner')
    or public.has_module_permission(p_uid, 'payroll', 'edit');
$$;

revoke all on function public.delivery_can_view(uuid) from public, anon, authenticated;
revoke all on function public.delivery_can_edit(uuid) from public, anon, authenticated;

/**
 * True when the most recent catalogue row of this code is a delivery employee.
 * Both assignment/setting RPCs use it so a typo or a non-driver code cannot be
 * assigned work that will never be paid.
 */
create or replace function public.payroll_bn_is_delivery_employee(p_employee_code text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with latest as (
    select
      e.employee_code,
      e.employment_type,
      e.group_name,
      p.date_from
    from public.payroll_bn_period_employees e
    join public.payroll_bn_periods p on p.id = e.period_id
    where e.employee_code = btrim(coalesce(p_employee_code, ''))
    order by p.date_from desc, p.created_at desc, e.created_at desc
    limit 1
  )
  select exists (
    select 1
    from latest
    where latest.employment_type = 'delivery'
       or latest.group_name = 'Giao hàng'
  );
$$;

revoke all on function public.payroll_bn_is_delivery_employee(text)
  from public, anon, authenticated;
grant execute on function public.payroll_bn_is_delivery_employee(text) to service_role;

comment on function public.payroll_bn_is_delivery_employee(text) is
  'Giao hàng — true only when the latest catalogue row of the code is employment_type delivery or group Giao hàng.';

-- ---------------------------------------------------------------------------
-- (g) Generate tasks for one delivery date (idempotent)
-- ---------------------------------------------------------------------------
create or replace function public.generate_delivery_tasks(p_date date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_tasks integer := 0;
  v_pending integer := 0;
  v_completed integer := 0;
  v_cancelled integer := 0;
  v_quantity numeric := 0;
begin
  if not public.delivery_can_edit(v_uid) then
    raise exception 'insufficient_privilege: payroll edit required' using errcode = '42501';
  end if;

  if p_date is null then
    raise exception 'delivery_date_required' using errcode = '22023';
  end if;

  create temporary table if not exists _delivery_generated (
    destination_customer_id uuid primary key,
    destination_name text,
    address text,
    employee_code text,
    units numeric,
    sort_order integer,
    order_ids uuid[],
    quantity numeric,
    items jsonb,
    dealer_note text
  ) on commit drop;

  truncate table _delivery_generated;

  insert into _delivery_generated(
    destination_customer_id,
    destination_name,
    address,
    employee_code,
    units,
    sort_order,
    order_ids,
    quantity,
    items,
    dealer_note
  )
  with order_lines as (
    select
      o.id as order_id,
      coalesce(i.route_customer_id, o.customer_id) as destination_customer_id,
      i.sku_code,
      i.product_name,
      i.unit,
      i.quantity,
      o.delivery_note,
      o.customer_note
    from public.dealer_orders o
    join public.dealer_order_items i on i.order_id = o.id
    where o.requested_delivery_date = p_date
      and o.is_test = false
      and o.status <> 'cancelled'
  ),
  destinations as (
    select
      destination_customer_id,
      array_agg(distinct order_id order by order_id) as order_ids,
      sum(quantity) as quantity
    from order_lines
    group by destination_customer_id
  ),
  items as (
    select
      grouped.destination_customer_id,
      jsonb_agg(
        jsonb_build_object(
          'sku_code', grouped.sku_code,
          'product_name', grouped.product_name,
          'unit', grouped.unit,
          'quantity', grouped.quantity
        )
        order by grouped.sku_code
      ) as items
    from (
      select
        destination_customer_id,
        sku_code,
        max(product_name) as product_name,
        max(unit) as unit,
        sum(quantity) as quantity
      from order_lines
      group by destination_customer_id, sku_code
    ) grouped
    group by grouped.destination_customer_id
  ),
  notes as (
    select
      destination_customer_id,
      string_agg(distinct note, ' · ' order by note) as dealer_note
    from (
      select destination_customer_id, nullif(btrim(coalesce(delivery_note, '')), '') as note
      from order_lines
      union
      select destination_customer_id, nullif(btrim(coalesce(customer_note, '')), '') as note
      from order_lines
    ) raw_notes
    where note is not null
    group by destination_customer_id
  )
  select
    d.destination_customer_id,
    c.customer_name,
    c.address,
    a.employee_code,
    coalesce(a.units, 0),
    coalesce(a.sort_order, 0),
    d.order_ids,
    d.quantity,
    coalesce(i.items, '[]'::jsonb),
    n.dealer_note
  from destinations d
  join public.mini_crm_customers c on c.id = d.destination_customer_id
  left join public.delivery_destination_assignments a
    on a.destination_customer_id = d.destination_customer_id
   and a.active = true
  left join items i on i.destination_customer_id = d.destination_customer_id
  left join notes n on n.destination_customer_id = d.destination_customer_id;

  insert into public.delivery_tasks(
    delivery_date,
    destination_customer_id,
    destination_name,
    address,
    employee_code,
    units,
    sort_order,
    status,
    order_ids,
    quantity,
    items,
    dealer_note,
    generated_at
  )
  select
    p_date,
    g.destination_customer_id,
    g.destination_name,
    g.address,
    g.employee_code,
    g.units,
    g.sort_order,
    'pending',
    g.order_ids,
    g.quantity,
    g.items,
    g.dealer_note,
    now()
  from _delivery_generated g
  on conflict (delivery_date, destination_customer_id) do update
  set destination_name = excluded.destination_name,
      address = excluded.address,
      employee_code = excluded.employee_code,
      units = excluded.units,
      sort_order = excluded.sort_order,
      order_ids = excluded.order_ids,
      quantity = excluded.quantity,
      items = excluded.items,
      dealer_note = excluded.dealer_note,
      status = 'pending',
      changed_after_completion = false
  -- Pending rows are refreshed; a previously cancelled point is revived when a
  -- new/restored order appears again for the same destination and date.
  where delivery_tasks.status in ('pending', 'cancelled')
    -- An owner-reopened task keeps its driver, units and order until redone.
    and delivery_tasks.reopened_at is null;

  -- A completed destination is never rewritten. If the dealer order changed
  -- after completion, only the audit flag is raised.
  update public.delivery_tasks t
  set changed_after_completion = true
  from _delivery_generated g
  where t.delivery_date = p_date
    and t.destination_customer_id = g.destination_customer_id
    and t.status = 'completed'
    and (
      t.order_ids is distinct from g.order_ids
      or t.quantity is distinct from g.quantity
      or t.items is distinct from g.items
      or t.dealer_note is distinct from g.dealer_note
    );

  -- A completed point whose orders were all cancelled no longer has a source
  -- row; flag it for review instead of silently losing the order change.
  update public.delivery_tasks t
  set changed_after_completion = true
  where t.delivery_date = p_date
    and t.status = 'completed'
    and not exists (
      select 1
      from _delivery_generated g
      where g.destination_customer_id = t.destination_customer_id
    );

  -- A pending point whose orders were all cancelled disappears from the source
  -- set; it is cancelled rather than left with a zero total.
  update public.delivery_tasks t
  set status = 'cancelled'
  where t.delivery_date = p_date
    and t.status = 'pending'
    and t.reopened_at is null
    and not exists (
      select 1
      from _delivery_generated g
      where g.destination_customer_id = t.destination_customer_id
    );

  select
    count(*),
    count(*) filter (where status = 'pending'),
    count(*) filter (where status = 'completed'),
    count(*) filter (where status = 'cancelled'),
    coalesce(sum(quantity) filter (where status <> 'cancelled'), 0)
  into v_tasks, v_pending, v_completed, v_cancelled, v_quantity
  from public.delivery_tasks
  where delivery_date = p_date;

  return jsonb_build_object(
    'delivery_date', p_date,
    'tasks', v_tasks,
    'pending', v_pending,
    'completed', v_completed,
    'cancelled', v_cancelled,
    'quantity', v_quantity
  );
end;
$$;

revoke all on function public.generate_delivery_tasks(date) from public, anon, authenticated;
grant execute on function public.generate_delivery_tasks(date) to authenticated, service_role;

comment on function public.generate_delivery_tasks(date) is
  'Idempotent Giao hàng task generation for one date from real dealer orders (non-test, non-cancelled). Destination = item.route_customer_id when present, else order.customer_id. Pending rows are refreshed; completed rows are preserved with changed_after_completion.';

-- ---------------------------------------------------------------------------
-- (h) Management RPCs
-- ---------------------------------------------------------------------------
create or replace function public.upsert_delivery_assignment(
  p_customer_id uuid,
  p_employee_code text,
  p_units numeric,
  p_sort_order integer,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_employee_code text := nullif(btrim(coalesce(p_employee_code, '')), '');
  v_units numeric := coalesce(p_units, 0);
  v_sort_order integer := coalesce(p_sort_order, 0);
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_row public.delivery_destination_assignments%rowtype;
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_tasks integer := 0;
begin
  if not public.delivery_can_edit(v_uid) then
    raise exception 'insufficient_privilege: payroll edit required' using errcode = '42501';
  end if;

  if p_customer_id is null then
    raise exception 'delivery_destination_required' using errcode = '22023';
  end if;

  if v_employee_code is not null
     and not public.payroll_bn_is_delivery_employee(v_employee_code) then
    raise exception 'delivery_employee_not_in_catalogue' using errcode = '22023';
  end if;

  if v_units < 0 or (v_units * 4) <> trunc(v_units * 4) then
    raise exception 'delivery_units_invalid: units must be a non-negative multiple of 0.25'
      using errcode = '22023';
  end if;

  if v_sort_order < 0 then
    raise exception 'delivery_sort_order_invalid' using errcode = '22023';
  end if;

  insert into public.delivery_destination_assignments(
    destination_customer_id,
    employee_code,
    units,
    sort_order,
    active,
    note,
    updated_at,
    updated_by
  ) values (
    p_customer_id,
    v_employee_code,
    v_units,
    v_sort_order,
    true,
    v_note,
    now(),
    v_uid
  )
  on conflict (destination_customer_id) do update
  set employee_code = excluded.employee_code,
      units = excluded.units,
      sort_order = excluded.sort_order,
      active = true,
      note = excluded.note,
      updated_at = now(),
      updated_by = v_uid
  returning * into v_row;

  update public.delivery_tasks
  set employee_code = v_employee_code,
      units = v_units,
      sort_order = v_sort_order
  where destination_customer_id = p_customer_id
    and delivery_date >= v_today
    and status = 'pending';

  get diagnostics v_tasks = row_count;

  return jsonb_build_object(
    'assignment', to_jsonb(v_row),
    'updated_pending_tasks', v_tasks
  );
end;
$$;

revoke all on function public.upsert_delivery_assignment(uuid, text, numeric, integer, text)
  from public, anon, authenticated;
grant execute on function public.upsert_delivery_assignment(uuid, text, numeric, integer, text)
  to authenticated, service_role;

comment on function public.upsert_delivery_assignment(uuid, text, numeric, integer, text) is
  'Giao hàng — upsert one destination assignment (owner or payroll.edit) and push driver/units/sort to its pending tasks from today onward. 0,25 unit steps are enforced.';

create or replace function public.upsert_delivery_driver_setting(
  p_employee_code text,
  p_base_units numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_employee_code text := btrim(coalesce(p_employee_code, ''));
  v_base_units numeric := coalesce(p_base_units, 0.5);
  v_row public.delivery_driver_settings%rowtype;
  v_existing public.delivery_driver_settings%rowtype;
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_effective date;
begin
  if not public.delivery_can_edit(v_uid) then
    raise exception 'insufficient_privilege: payroll edit required' using errcode = '42501';
  end if;

  if v_employee_code = '' then
    raise exception 'delivery_employee_required' using errcode = '22023';
  end if;

  if not public.payroll_bn_is_delivery_employee(v_employee_code) then
    raise exception 'delivery_employee_not_in_catalogue' using errcode = '22023';
  end if;

  if v_base_units < 0 or (v_base_units * 4) <> trunc(v_base_units * 4) then
    raise exception 'delivery_units_invalid: base units must be a non-negative multiple of 0.25'
      using errcode = '22023';
  end if;

  select * into v_existing
  from public.delivery_driver_settings
  where employee_code = v_employee_code;

  -- Unchanged base: only refresh active/updated fields, never add a history row.
  if v_existing.employee_code is not null
     and v_existing.base_units_per_day = v_base_units then
    -- Repair a row that predates the history table; no-op in normal flow.
    -- Never add the 1970 backfill when history already exists, otherwise an
    -- idempotent save could rewrite days completed before the first setting.
    if not exists (
      select 1
      from public.delivery_driver_setting_history h
      where h.employee_code = v_employee_code
    ) then
      insert into public.delivery_driver_setting_history(
        employee_code, base_units_per_day, effective_from, created_by
      ) values (
        v_employee_code, v_base_units, '1970-01-01', v_uid
      )
      on conflict (employee_code, effective_from) do nothing;
    end if;

    update public.delivery_driver_settings
    set active = true,
        updated_at = now(),
        updated_by = v_uid
    where employee_code = v_employee_code
    returning * into v_row;

    return jsonb_build_object('setting', to_jsonb(v_row), 'effective_from', null);
  end if;

  if v_existing.employee_code is null then
    -- First configuration starts today; days before it fall back to 0.5.
    v_effective := v_today;
  else
    -- Keep the old base for every day before the change. A change is effective
    -- tomorrow so a locked/current month's already earned units do not move.
    if not exists (
      select 1
      from public.delivery_driver_setting_history h
      where h.employee_code = v_employee_code
        and h.effective_from <= v_today
    ) then
      insert into public.delivery_driver_setting_history(
        employee_code, base_units_per_day, effective_from, created_by
      ) values (
        v_employee_code, v_existing.base_units_per_day, '1970-01-01', v_uid
      )
      on conflict (employee_code, effective_from) do nothing;
    end if;
    v_effective := v_today + 1;
  end if;

  insert into public.delivery_driver_setting_history(
    employee_code,
    base_units_per_day,
    effective_from,
    created_by
  ) values (
    v_employee_code,
    v_base_units,
    v_effective,
    v_uid
  )
  on conflict (employee_code, effective_from) do update
  set base_units_per_day = excluded.base_units_per_day,
      created_by = excluded.created_by;

  insert into public.delivery_driver_settings(
    employee_code,
    base_units_per_day,
    active,
    updated_at,
    updated_by
  ) values (
    v_employee_code,
    v_base_units,
    true,
    now(),
    v_uid
  )
  on conflict (employee_code) do update
  set base_units_per_day = excluded.base_units_per_day,
      active = true,
      updated_at = now(),
      updated_by = v_uid
  returning * into v_row;

  return jsonb_build_object(
    'setting', to_jsonb(v_row),
    'effective_from', v_effective
  );
end;
$$;

revoke all on function public.upsert_delivery_driver_setting(text, numeric)
  from public, anon, authenticated;
grant execute on function public.upsert_delivery_driver_setting(text, numeric)
  to authenticated, service_role;

comment on function public.upsert_delivery_driver_setting(text, numeric) is
  'Giao hàng — upsert the base units per completed day of one driver (owner or payroll.edit), 0,25 steps.';

create or replace function public.list_delivery_tasks(p_date date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_date date := coalesce(p_date, (now() at time zone 'Asia/Ho_Chi_Minh')::date);
  v_tasks jsonb;
begin
  if not public.delivery_can_view(v_uid) then
    raise exception 'insufficient_privilege: payroll view required' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', t.id,
      'delivery_date', t.delivery_date,
      'destination_customer_id', t.destination_customer_id,
      'destination_name', t.destination_name,
      'address', t.address,
      'employee_code', t.employee_code,
      'driver_name', driver.employee_name,
      'units', t.units,
      'sort_order', t.sort_order,
      'status', t.status,
      'order_ids', t.order_ids,
      'quantity', t.quantity,
      'items', t.items,
      'dealer_note', t.dealer_note,
      'generated_at', t.generated_at,
      'changed_after_completion', t.changed_after_completion,
      'completed_at', t.completed_at,
      'device_captured_at', t.device_captured_at,
      'latitude', t.latitude,
      'longitude', t.longitude,
      'accuracy_m', t.accuracy_m,
      'distance_m', t.distance_m,
      'location_attached', t.location_attached,
      'photo_path', t.photo_path,
      'reopened_at', t.reopened_at,
      'reopen_reason', t.reopen_reason,
      'reopen_evidence', t.reopen_evidence
    )
    order by t.sort_order, t.destination_name, t.id
  ), '[]'::jsonb)
  into v_tasks
  from public.delivery_tasks t
  left join lateral (
    select pe.employee_name
    from public.payroll_bn_period_employees pe
    join public.payroll_bn_periods p on p.id = pe.period_id
    where pe.employee_code = t.employee_code
    order by p.date_from desc, pe.created_at desc
    limit 1
  ) driver on true
  where t.delivery_date = v_date;

  return v_tasks;
end;
$$;

revoke all on function public.list_delivery_tasks(date) from public, anon, authenticated;
grant execute on function public.list_delivery_tasks(date) to authenticated, service_role;

comment on function public.list_delivery_tasks(date) is
  'Giao hàng — tasks of one date with driver name, photo path and whether the destination already had coordinates. Owner or payroll.view.';

create or replace function public.list_delivery_assignments()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_rows jsonb;
begin
  if not public.delivery_can_view(v_uid) then
    raise exception 'insufficient_privilege: payroll view required' using errcode = '42501';
  end if;

  with recent_destinations as (
    select distinct coalesce(i.route_customer_id, o.customer_id) as destination_customer_id
    from public.dealer_orders o
    join public.dealer_order_items i on i.order_id = o.id
    where o.is_test = false
      and o.status <> 'cancelled'
      and coalesce(o.requested_delivery_date, o.created_at::date)
        >= (now() at time zone 'Asia/Ho_Chi_Minh')::date - 60
  )
  select coalesce(jsonb_agg(
    jsonb_build_object(
      'id', a.id,
      'destination_customer_id', c.id,
      'destination_name', c.customer_name,
      'area', c.customer_group,
      'address', c.address,
      'employee_code', a.employee_code,
      'units', coalesce(a.units, 0),
      'sort_order', coalesce(a.sort_order, 0),
      'note', a.note,
      'active', coalesce(a.active, false),
      'assigned', a.id is not null,
      'has_location', (c.location_lat is not null and c.location_lng is not null),
      'latitude', c.location_lat,
      'longitude', c.location_lng
    )
    order by coalesce(a.sort_order, 2147483647), c.customer_name, c.id
  ), '[]'::jsonb)
  into v_rows
  from recent_destinations r
  join public.mini_crm_customers c on c.id = r.destination_customer_id
  left join public.delivery_destination_assignments a
    on a.destination_customer_id = c.id;

  return v_rows;
end;
$$;

revoke all on function public.list_delivery_assignments() from public, anon, authenticated;
grant execute on function public.list_delivery_assignments() to authenticated, service_role;

comment on function public.list_delivery_assignments() is
  'Giao hàng — every destination in the last 60 days of real orders, assigned or not, with area/address and whether coordinates exist. Owner or payroll.view.';

create or replace function public.delivery_units_by_day(p_from date, p_to date)
returns table (
  employee_code text,
  delivery_date date,
  units numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if not public.delivery_can_view(v_uid) then
    raise exception 'insufficient_privilege: payroll view required' using errcode = '42501';
  end if;

  if p_from is null or p_to is null or p_to < p_from then
    raise exception 'delivery_date_range_invalid' using errcode = '22007';
  end if;

  return query
  select
    t.employee_code,
    t.delivery_date,
    coalesce(
      base.history_base,
      case when base.has_history then 0.5 else base.current_base end,
      0.5
    ) + sum(t.units)
  from public.delivery_tasks t
  left join lateral (
    select
      (
        select h.base_units_per_day
        from public.delivery_driver_setting_history h
        where h.employee_code = t.employee_code
          and h.effective_from <= t.delivery_date
        order by h.effective_from desc
        limit 1
      ) as history_base,
      exists (
        select 1
        from public.delivery_driver_setting_history h
        where h.employee_code = t.employee_code
      ) as has_history,
      (
        select s.base_units_per_day
        from public.delivery_driver_settings s
        where s.employee_code = t.employee_code
          and s.active = true
      ) as current_base
  ) base on true
  where t.delivery_date between p_from and p_to
    and t.status = 'completed'
    and t.employee_code is not null
    and btrim(t.employee_code) <> ''
  group by
    t.employee_code,
    t.delivery_date,
    base.history_base,
    base.has_history,
    base.current_base
  order by t.employee_code, t.delivery_date;
end;
$$;

revoke all on function public.delivery_units_by_day(date, date) from public, anon, authenticated;
grant execute on function public.delivery_units_by_day(date, date) to authenticated, service_role;

comment on function public.delivery_units_by_day(date, date) is
  'Giao hàng — per driver and day: the effective-dated base_units_per_day (default 0.5) when at least one task completed, plus the units of every completed destination. History wins over the current setting; a later base change never rewrites earlier days. Owner or payroll.view.';

create or replace function public.reopen_delivery_task(
  p_task_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_reason text := btrim(coalesce(p_reason, ''));
  v_row public.delivery_tasks%rowtype;
  v_existing public.delivery_tasks%rowtype;
  v_evidence jsonb;
begin
  if not public.has_role(v_uid, 'owner') then
    raise exception 'delivery_reopen_owner_only' using errcode = '42501';
  end if;

  if v_reason = '' then
    raise exception 'delivery_reopen_reason_required' using errcode = '22023';
  end if;

  select * into v_existing
  from public.delivery_tasks
  where id = p_task_id
    and status = 'completed'
  for update;

  if v_existing.id is null then
    raise exception 'delivery_task_not_completed' using errcode = 'P0002';
  end if;

  -- A locked month is immutable: reopening would change its delivery units.
  if exists (
    select 1
    from public.payroll_bn_periods p
    where p.status = 'locked'
      and v_existing.delivery_date between p.date_from and p.date_to
  ) then
    raise exception 'payroll_bn_period_locked' using errcode = '55006';
  end if;

  -- If this completion attached the destination pin, undo it when the pin is
  -- still exactly the evidence coordinates. A later CRM pin / different pin is
  -- kept untouched.
  if v_existing.location_attached
     and v_existing.latitude is not null
     and v_existing.longitude is not null then
    update public.mini_crm_customers
    set location_lat = null,
        location_lng = null,
        location_source = null
    where id = v_existing.destination_customer_id
      and location_source = 'delivery_gps'
      and location_lat = v_existing.latitude
      and location_lng = v_existing.longitude;
  end if;

  v_evidence := jsonb_build_object(
    'completed_at', v_existing.completed_at,
    'completed_session_id', v_existing.completed_session_id,
    'device_captured_at', v_existing.device_captured_at,
    'latitude', v_existing.latitude,
    'longitude', v_existing.longitude,
    'accuracy_m', v_existing.accuracy_m,
    'distance_m', v_existing.distance_m,
    'location_attached', v_existing.location_attached,
    'photo_path', v_existing.photo_path,
    'device_hash', v_existing.device_hash
  );

  update public.delivery_tasks
  set status = 'pending',
      completed_at = null,
      completed_session_id = null,
      device_captured_at = null,
      latitude = null,
      longitude = null,
      accuracy_m = null,
      distance_m = null,
      location_attached = false,
      photo_path = null,
      device_hash = null,
      changed_after_completion = false,
      reopened_at = now(),
      reopened_by = v_uid,
      reopen_reason = v_reason,
      reopen_evidence = v_evidence
  where id = p_task_id
    and status = 'completed'
  returning * into v_row;

  if v_row.id is null then
    raise exception 'delivery_task_not_completed' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'task', to_jsonb(v_row),
    'reason', v_reason,
    'reopened_by', v_uid,
    'previous_evidence', v_evidence
  );
end;
$$;

revoke all on function public.reopen_delivery_task(uuid, text)
  from public, anon, authenticated;
grant execute on function public.reopen_delivery_task(uuid, text) to authenticated, service_role;

comment on function public.reopen_delivery_task(uuid, text) is
  'Giao hàng — owner-only reopen of a completed task in an open month: back to pending, completion evidence kept in reopen_evidence, reason/actor stored, and the task may be completed again outside the normal date window.';

-- ---------------------------------------------------------------------------
-- (i) Completion RPC — called only by the Edge Function with service_role
-- ---------------------------------------------------------------------------
create or replace function public.complete_delivery_task(
  p_task_id uuid,
  p_employee_code text,
  p_session_id uuid,
  p_device_hash text,
  p_photo_path text,
  p_latitude numeric,
  p_longitude numeric,
  p_accuracy_m numeric,
  p_device_captured_at timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_employee_code text := btrim(coalesce(p_employee_code, ''));
  v_device_hash text := nullif(lower(btrim(coalesce(p_device_hash, ''))), '');
  v_photo_path text := nullif(btrim(coalesce(p_photo_path, '')), '');
  v_now timestamptz := statement_timestamp();
  v_today date;
  v_hour integer;
  v_task public.delivery_tasks%rowtype;
  v_destination public.mini_crm_customers%rowtype;
  v_location_attached boolean := false;
  v_distance numeric;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'delivery_complete_service_role_required' using errcode = '42501';
  end if;

  if p_task_id is null or v_employee_code = '' then
    raise exception 'delivery_task_and_employee_required' using errcode = '22023';
  end if;

  if v_photo_path is null then
    raise exception 'delivery_photo_required' using errcode = '22023';
  end if;

  if p_latitude is null or p_longitude is null
     or p_latitude < -90 or p_latitude > 90
     or p_longitude < -180 or p_longitude > 180 then
    raise exception 'delivery_location_invalid' using errcode = '22023';
  end if;

  if p_accuracy_m is null or p_accuracy_m < 0 then
    raise exception 'delivery_accuracy_invalid' using errcode = '22023';
  end if;

  select * into v_task
  from public.delivery_tasks
  where id = p_task_id
  for update;

  if v_task.id is null then
    raise exception 'delivery_task_not_found' using errcode = 'P0002';
  end if;

  if v_task.employee_code is null or btrim(v_task.employee_code) <> v_employee_code then
    raise exception 'delivery_task_not_assigned' using errcode = '42501';
  end if;

  -- A locked month is immutable, including a late completion of its task.
  if exists (
    select 1
    from public.payroll_bn_periods p
    where p.status = 'locked'
      and v_task.delivery_date between p.date_from and p.date_to
  ) then
    raise exception 'payroll_bn_period_locked' using errcode = '55006';
  end if;

  v_today := (v_now at time zone 'Asia/Ho_Chi_Minh')::date;
  v_hour := extract(hour from (v_now at time zone 'Asia/Ho_Chi_Minh'))::integer;

  -- A task explicitly reopened by the owner may be completed again even when
  -- its delivery date is older than the normal today / yesterday-before-06:00
  -- window. The reopen reason/actor/evidence stay on the task for audit.
  if v_task.reopened_at is null
     and v_task.delivery_date <> v_today
     and not (v_task.delivery_date = v_today - 1 and v_hour < 6) then
    raise exception 'delivery_task_date_closed' using errcode = '22023';
  end if;

  if v_task.status <> 'pending' then
    raise exception 'delivery_task_not_pending' using errcode = 'P0001';
  end if;

  select * into v_destination
  from public.mini_crm_customers
  where id = v_task.destination_customer_id;

  if v_destination.id is null then
    raise exception 'delivery_destination_not_found' using errcode = 'P0002';
  end if;

  if v_destination.location_lat is null or v_destination.location_lng is null then
    update public.mini_crm_customers
    set location_lat = p_latitude,
        location_lng = p_longitude,
        location_source = 'delivery_gps'
    where id = v_destination.id
      and (location_lat is null or location_lng is null);

    if found then
      v_location_attached := true;
      v_distance := null;
    else
      -- A concurrent first completion attached the coordinates between the
      -- read and this update: keep the existing point and only store distance.
      select * into v_destination
      from public.mini_crm_customers
      where id = v_task.destination_customer_id;
      v_location_attached := false;
      v_distance := round(
        public.payroll_bn_haversine_meters(
          p_latitude,
          p_longitude,
          v_destination.location_lat,
          v_destination.location_lng
        ),
        2
      );
    end if;
  else
    v_location_attached := false;
    v_distance := round(
      public.payroll_bn_haversine_meters(
        p_latitude,
        p_longitude,
        v_destination.location_lat,
        v_destination.location_lng
      ),
      2
    );
  end if;

  update public.delivery_tasks
  set status = 'completed',
      completed_at = v_now,
      completed_session_id = p_session_id,
      device_captured_at = p_device_captured_at,
      latitude = p_latitude,
      longitude = p_longitude,
      accuracy_m = p_accuracy_m,
      distance_m = v_distance,
      location_attached = v_location_attached,
      photo_path = v_photo_path,
      device_hash = v_device_hash
  where id = v_task.id
    and status = 'pending'
  returning * into v_task;

  if v_task.id is null then
    raise exception 'delivery_task_not_pending' using errcode = 'P0001';
  end if;

  return jsonb_build_object(
    'task_id', v_task.id,
    'status', v_task.status,
    'completed_at', v_task.completed_at,
    'device_captured_at', v_task.device_captured_at,
    'latitude', v_task.latitude,
    'longitude', v_task.longitude,
    'accuracy_m', v_task.accuracy_m,
    'distance_m', v_task.distance_m,
    'location_attached', v_task.location_attached,
    'photo_path', v_task.photo_path
  );
end;
$$;

revoke all on function public.complete_delivery_task(
  uuid, text, uuid, text, text, numeric, numeric, numeric, timestamptz
) from public, anon, authenticated;
grant execute on function public.complete_delivery_task(
  uuid, text, uuid, text, text, numeric, numeric, numeric, timestamptz
) to service_role;

comment on function public.complete_delivery_task(
  uuid, text, uuid, text, text, numeric, numeric, numeric, timestamptz
) is
  'Giao hàng — service-role completion: verifies driver/date/pending, stores server_completed_at + GPS + accuracy, attaches the destination coordinates on the first-ever completion and stores distance_m afterwards. No geofence or time flag.';

-- ---------------------------------------------------------------------------
-- (k) Row level security and grants
-- ---------------------------------------------------------------------------
alter table public.delivery_driver_settings enable row level security;
alter table public.delivery_driver_setting_history enable row level security;
alter table public.delivery_destination_assignments enable row level security;
alter table public.delivery_tasks enable row level security;
alter table public.payroll_bn_delivery_extras enable row level security;

drop policy if exists delivery_driver_settings_select on public.delivery_driver_settings;
create policy delivery_driver_settings_select on public.delivery_driver_settings
  for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'view')
  );

drop policy if exists delivery_driver_setting_history_select
  on public.delivery_driver_setting_history;
create policy delivery_driver_setting_history_select
  on public.delivery_driver_setting_history
  for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'view')
  );

drop policy if exists delivery_destination_assignments_select
  on public.delivery_destination_assignments;
create policy delivery_destination_assignments_select
  on public.delivery_destination_assignments
  for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'view')
  );

drop policy if exists delivery_tasks_select on public.delivery_tasks;
create policy delivery_tasks_select on public.delivery_tasks
  for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'view')
  );

drop policy if exists payroll_bn_delivery_extras_select
  on public.payroll_bn_delivery_extras;
create policy payroll_bn_delivery_extras_select
  on public.payroll_bn_delivery_extras
  for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'view')
  );

drop policy if exists payroll_bn_delivery_extras_insert
  on public.payroll_bn_delivery_extras;
create policy payroll_bn_delivery_extras_insert
  on public.payroll_bn_delivery_extras
  for insert to authenticated
  with check (
    (
      public.has_role((select auth.uid()), 'owner')
      or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
    )
    and created_by = (select auth.uid())
  );

drop policy if exists payroll_bn_delivery_extras_delete
  on public.payroll_bn_delivery_extras;
create policy payroll_bn_delivery_extras_delete
  on public.payroll_bn_delivery_extras
  for delete to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payroll', 'edit')
  );

revoke all on table public.delivery_driver_settings
  from public, anon, authenticated;
revoke all on table public.delivery_driver_setting_history
  from public, anon, authenticated;
revoke all on table public.delivery_destination_assignments
  from public, anon, authenticated;
revoke all on table public.delivery_tasks
  from public, anon, authenticated;
revoke all on table public.payroll_bn_delivery_extras
  from public, anon, authenticated;

grant select on table public.delivery_driver_settings to authenticated;
grant select on table public.delivery_driver_setting_history to authenticated;
grant select on table public.delivery_destination_assignments to authenticated;
grant select on table public.delivery_tasks to authenticated;
grant select, insert, delete on table public.payroll_bn_delivery_extras to authenticated;

grant all on table public.delivery_driver_settings to service_role;
grant all on table public.delivery_driver_setting_history to service_role;
grant all on table public.delivery_destination_assignments to service_role;
grant all on table public.delivery_tasks to service_role;
grant all on table public.payroll_bn_delivery_extras to service_role;

-- ---------------------------------------------------------------------------
-- (l) Daily generation at 17:05 UTC + repeated same-day refresh + retention
-- ---------------------------------------------------------------------------
do $delivery_tasks_cron$
declare
  existing_job_id bigint;
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    for existing_job_id in
      select jobid from cron.job where jobname = 'delivery-tasks-generate-daily'
    loop
      perform cron.unschedule(existing_job_id);
    end loop;

    perform cron.schedule(
      'delivery-tasks-generate-daily',
      '5 17 * * *',
      $job$
        select public.generate_delivery_tasks(
          (now() at time zone 'Asia/Ho_Chi_Minh')::date
        );
      $job$
    );

    -- Same-day orders/cancellations arrive after 00:05. Refresh today's tasks
    -- every 10 minutes so drivers see them and cancelled points are withdrawn.
    for existing_job_id in
      select jobid from cron.job where jobname = 'delivery-tasks-refresh'
    loop
      perform cron.unschedule(existing_job_id);
    end loop;

    perform cron.schedule(
      'delivery-tasks-refresh',
      '5,15,25,35,45,55 * * * *',
      $job$
        select public.generate_delivery_tasks(
          (now() at time zone 'Asia/Ho_Chi_Minh')::date
        );
        -- Yesterday's stops stay completable until 06:00, so keep refreshing
        -- them (late cancellations) until then.
        select public.generate_delivery_tasks(
          (now() at time zone 'Asia/Ho_Chi_Minh')::date - 1
        )
        where extract(hour from now() at time zone 'Asia/Ho_Chi_Minh') < 6;
      $job$
    );

    for existing_job_id in
      select jobid from cron.job where jobname = 'delivery-proofs-retention-daily'
    loop
      perform cron.unschedule(existing_job_id);
    end loop;

    -- Same worker-secret pattern as the selfie retention cron: the Edge
    -- Function deletes through the Storage API, never directly from
    -- storage.objects (Supabase protects that table).
    perform cron.schedule(
      'delivery-proofs-retention-daily',
      '40 20 * * *',
      $job$
        select net.http_post(
          url := 'https://cxntbdvfsikwmitapony.supabase.co/functions/v1/payslip-delivery-complete',
          headers := jsonb_build_object(
            'content-type', 'application/json',
            'x-worker-secret', (
              select worker_secret::text
              from public.payroll_bn_attendance_consent_config
              where id is true
            )
          ),
          body := jsonb_build_object(
            'trigger', 'cron',
            'action', 'delivery-proof-retention'
          ),
          timeout_milliseconds := 120000
        );
      $job$
    );
  end if;
end;
$delivery_tasks_cron$;
