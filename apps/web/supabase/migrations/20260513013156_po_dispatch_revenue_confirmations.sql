-- Actual dispatch revenue confirmation layer.
-- PO/email source evidence remains immutable; this table records operational actuals.

create table if not exists public.po_dispatch_revenue_confirmations (
  id uuid primary key default gen_random_uuid(),
  customer_po_inbox_id uuid not null references public.customer_po_inbox(id) on delete restrict,
  warehouse_dispatch_id uuid references public.warehouse_dispatches(id) on delete set null,
  production_order_id uuid references public.production_orders(id) on delete set null,
  customer_id uuid references public.mini_crm_customers(id) on delete set null,
  po_number text,
  revenue_date date not null,
  dispatch_date date,
  status text not null default 'draft',
  ordered_qty_total numeric(15,3) not null default 0,
  produced_qty_total numeric(15,3) not null default 0,
  defect_qty_total numeric(15,3) not null default 0,
  dispatched_qty_total numeric(15,3) not null default 0,
  billable_qty_total numeric(15,3) not null default 0,
  po_total_vat_included numeric(15,2),
  temporary_revenue_amount_vat_included numeric(15,2),
  confirmed_revenue_amount_vat_included numeric(15,2),
  amount_status text not null default 'temporary_po_amount',
  amount_basis text,
  confirmed_by uuid references auth.users(id) on delete set null,
  confirmed_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint po_dispatch_revenue_confirmations_status_check
    check (status in ('draft','confirmed','revised','cancelled')),
  constraint po_dispatch_revenue_confirmations_amount_status_check
    check (amount_status in ('temporary_po_amount','confirmed_dispatch_amount','needs_sku_allocation','month_end_audit_adjusted'))
);

create table if not exists public.po_dispatch_revenue_confirmation_lines (
  id uuid primary key default gen_random_uuid(),
  confirmation_id uuid not null references public.po_dispatch_revenue_confirmations(id) on delete cascade,
  source_line_key text,
  sku text,
  product_name text not null,
  ordered_qty numeric(15,3) not null default 0,
  produced_qty numeric(15,3) not null default 0,
  defect_qty numeric(15,3) not null default 0,
  dispatched_qty numeric(15,3) not null default 0,
  billable_qty numeric(15,3) not null default 0,
  unit_price_vat_included numeric(15,6),
  source_line_amount_vat_included numeric(15,2),
  temporary_revenue_amount_vat_included numeric(15,2),
  confirmed_revenue_amount_vat_included numeric(15,2),
  shortage_reason_code text,
  shortage_note text,
  created_at timestamptz not null default now()
);

create table if not exists public.po_dispatch_revenue_audit_logs (
  id uuid primary key default gen_random_uuid(),
  confirmation_id uuid references public.po_dispatch_revenue_confirmations(id) on delete set null,
  customer_po_inbox_id uuid references public.customer_po_inbox(id) on delete set null,
  warehouse_dispatch_id uuid references public.warehouse_dispatches(id) on delete set null,
  action text not null,
  actor_id uuid references auth.users(id) on delete set null,
  old_values jsonb,
  new_values jsonb,
  note text,
  created_at timestamptz not null default now()
);

create index if not exists idx_po_dispatch_revenue_confirmations_inbox
  on public.po_dispatch_revenue_confirmations(customer_po_inbox_id, status, updated_at desc);

create index if not exists idx_po_dispatch_revenue_confirmations_dispatch
  on public.po_dispatch_revenue_confirmations(warehouse_dispatch_id);

create index if not exists idx_po_dispatch_revenue_confirmations_period
  on public.po_dispatch_revenue_confirmations(revenue_date, amount_status);

create unique index if not exists uq_po_dispatch_revenue_confirmations_active_dispatch
  on public.po_dispatch_revenue_confirmations(warehouse_dispatch_id)
  where warehouse_dispatch_id is not null and status <> 'cancelled';

create index if not exists idx_po_dispatch_revenue_confirmation_lines_confirmation
  on public.po_dispatch_revenue_confirmation_lines(confirmation_id);

create index if not exists idx_po_dispatch_revenue_confirmation_lines_match
  on public.po_dispatch_revenue_confirmation_lines(confirmation_id, source_line_key, sku, product_name);

create index if not exists idx_po_dispatch_revenue_audit_logs_confirmation
  on public.po_dispatch_revenue_audit_logs(confirmation_id, created_at desc);

create or replace function public.touch_po_dispatch_revenue_confirmation_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_touch_po_dispatch_revenue_confirmations on public.po_dispatch_revenue_confirmations;
create trigger trg_touch_po_dispatch_revenue_confirmations
  before update on public.po_dispatch_revenue_confirmations
  for each row execute function public.touch_po_dispatch_revenue_confirmation_updated_at();

alter table public.po_dispatch_revenue_confirmations enable row level security;
alter table public.po_dispatch_revenue_confirmation_lines enable row level security;
alter table public.po_dispatch_revenue_audit_logs enable row level security;

revoke all on table public.po_dispatch_revenue_confirmations from anon, authenticated;
revoke all on table public.po_dispatch_revenue_confirmation_lines from anon, authenticated;
revoke all on table public.po_dispatch_revenue_audit_logs from anon, authenticated;

grant select on table public.po_dispatch_revenue_confirmations to authenticated;
grant select on table public.po_dispatch_revenue_confirmation_lines to authenticated;
grant select on table public.po_dispatch_revenue_audit_logs to authenticated;

drop policy if exists "po_dispatch_revenue_confirmations_read" on public.po_dispatch_revenue_confirmations;
create policy "po_dispatch_revenue_confirmations_read"
  on public.po_dispatch_revenue_confirmations for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_role((select auth.uid()), 'warehouse')
    or public.has_role((select auth.uid()), 'staff')
    or public.has_module_permission((select auth.uid()), 'finance_revenue', 'view')
    or public.has_module_permission((select auth.uid()), 'production', 'view')
  );

drop policy if exists "po_dispatch_revenue_confirmation_lines_read" on public.po_dispatch_revenue_confirmation_lines;
create policy "po_dispatch_revenue_confirmation_lines_read"
  on public.po_dispatch_revenue_confirmation_lines for select to authenticated
  using (
    exists (
      select 1
      from public.po_dispatch_revenue_confirmations c
      where c.id = po_dispatch_revenue_confirmation_lines.confirmation_id
    )
  );

drop policy if exists "po_dispatch_revenue_audit_logs_read" on public.po_dispatch_revenue_audit_logs;
create policy "po_dispatch_revenue_audit_logs_read"
  on public.po_dispatch_revenue_audit_logs for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_role((select auth.uid()), 'warehouse')
    or public.has_role((select auth.uid()), 'staff')
    or public.has_module_permission((select auth.uid()), 'finance_revenue', 'view')
    or public.has_module_permission((select auth.uid()), 'production', 'view')
  );

create or replace function public.can_edit_po_dispatch_revenue_confirmation(_actor uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    public.has_role(_actor, 'owner')
    or public.has_role(_actor, 'warehouse')
    or public.has_role(_actor, 'staff')
    or public.has_module_permission(_actor, 'finance_revenue', 'edit')
    or public.has_module_permission(_actor, 'production', 'edit'),
    false
  );
$$;

create or replace function public.po_dispatch_revenue_payload_rollup(_payload jsonb, _note text default null)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_line jsonb;
  v_lines jsonb := coalesce(_payload->'lines', '[]'::jsonb);
  v_ordered numeric := 0;
  v_produced numeric := 0;
  v_defect numeric := 0;
  v_dispatched numeric := 0;
  v_billable numeric := 0;
  v_temp numeric := 0;
  v_confirmed numeric := 0;
  v_manual_amount numeric := nullif(_payload->>'confirmed_revenue_amount_vat_included', '')::numeric;
  v_has_shortage boolean := false;
  v_missing_allocation boolean := false;
  v_has_manual_note boolean := coalesce(nullif(btrim(_note), ''), nullif(btrim(_payload->>'manual_amount_note'), '')) is not null;
  v_amount_status text := 'temporary_po_amount';
  v_confirmed_final numeric := null;
  v_amount_basis text := 'temporary_po_ordered_amount';
  v_line_ordered numeric;
  v_line_produced numeric;
  v_line_defect numeric;
  v_line_billable numeric;
  v_line_sku text;
  v_line_reason text;
begin
  for v_line in select value from jsonb_array_elements(v_lines)
  loop
    v_line_ordered := coalesce(nullif(v_line->>'ordered_qty', '')::numeric, 0);
    v_line_produced := coalesce(nullif(v_line->>'produced_qty', '')::numeric, 0);
    v_line_defect := coalesce(nullif(v_line->>'defect_qty', '')::numeric, 0);
    v_line_billable := coalesce(nullif(v_line->>'billable_qty', '')::numeric, 0);
    v_line_sku := nullif(btrim(coalesce(v_line->>'sku', '')), '');
    v_line_reason := nullif(btrim(coalesce(v_line->>'shortage_reason_code', '')), '');

    v_ordered := v_ordered + v_line_ordered;
    v_produced := v_produced + v_line_produced;
    v_defect := v_defect + v_line_defect;
    v_dispatched := v_dispatched + coalesce(nullif(v_line->>'dispatched_qty', '')::numeric, 0);
    v_billable := v_billable + v_line_billable;
    v_temp := v_temp + coalesce(nullif(v_line->>'temporary_revenue_amount_vat_included', '')::numeric, nullif(v_line->>'source_line_amount_vat_included', '')::numeric, 0);
    v_confirmed := v_confirmed + coalesce(nullif(v_line->>'confirmed_revenue_amount_vat_included', '')::numeric, 0);

    if v_line_ordered > v_line_billable or v_line_ordered > v_line_produced or v_line_defect > 0 then
      v_has_shortage := true;
      if v_line_sku is null or v_line_reason is null then
        v_missing_allocation := true;
      end if;
    end if;
  end loop;

  v_temp := coalesce(nullif(_payload->>'temporary_revenue_amount_vat_included', '')::numeric, v_temp);

  if v_manual_amount is not null and v_manual_amount > 0 and v_has_manual_note then
    v_amount_status := coalesce(nullif(_payload->>'amount_status', ''), 'confirmed_dispatch_amount');
    if v_amount_status not in ('confirmed_dispatch_amount','month_end_audit_adjusted') then
      v_amount_status := 'confirmed_dispatch_amount';
    end if;
    v_confirmed_final := v_manual_amount;
    v_amount_basis := 'manual_actual_amount_with_audit_note';
  elsif v_has_shortage and v_missing_allocation then
    v_amount_status := 'needs_sku_allocation';
    v_confirmed_final := null;
    v_amount_basis := 'temporary_po_amount_until_missing_sku_allocated';
  elsif v_confirmed > 0 then
    v_amount_status := coalesce(nullif(_payload->>'amount_status', ''), 'confirmed_dispatch_amount');
    if v_amount_status not in ('confirmed_dispatch_amount','month_end_audit_adjusted') then
      v_amount_status := 'confirmed_dispatch_amount';
    end if;
    v_confirmed_final := v_confirmed;
    v_amount_basis := 'confirmed_dispatch_line_amounts';
  else
    v_amount_status := 'temporary_po_amount';
    v_confirmed_final := null;
    v_amount_basis := 'temporary_po_ordered_amount';
  end if;

  return jsonb_build_object(
    'ordered_qty_total', coalesce(nullif(_payload->>'ordered_qty_total', '')::numeric, v_ordered),
    'produced_qty_total', coalesce(nullif(_payload->>'produced_qty_total', '')::numeric, v_produced),
    'defect_qty_total', coalesce(nullif(_payload->>'defect_qty_total', '')::numeric, v_defect),
    'dispatched_qty_total', coalesce(nullif(_payload->>'dispatched_qty_total', '')::numeric, v_dispatched),
    'billable_qty_total', coalesce(nullif(_payload->>'billable_qty_total', '')::numeric, v_billable),
    'temporary_revenue_amount_vat_included', v_temp,
    'confirmed_revenue_amount_vat_included', v_confirmed_final,
    'amount_status', v_amount_status,
    'amount_basis', coalesce(nullif(_payload->>'amount_basis', ''), v_amount_basis),
    'has_shortage', v_has_shortage,
    'missing_allocation', v_missing_allocation
  );
end;
$$;

create or replace function public.upsert_po_dispatch_revenue_confirmation(
  _customer_po_inbox_id uuid,
  _warehouse_dispatch_id uuid default null,
  _payload jsonb default '{}'::jsonb,
  _note text default null
)
returns public.po_dispatch_revenue_confirmations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_po public.customer_po_inbox%rowtype;
  v_dispatch public.warehouse_dispatches%rowtype;
  v_existing public.po_dispatch_revenue_confirmations%rowtype;
  v_result public.po_dispatch_revenue_confirmations%rowtype;
  v_rollup jsonb;
  v_old jsonb;
  v_line jsonb;
begin
  if v_actor is null or not public.can_edit_po_dispatch_revenue_confirmation(v_actor) then
    raise exception 'Forbidden: dispatch revenue edit permission required';
  end if;

  select * into v_po from public.customer_po_inbox where id = _customer_po_inbox_id;
  if not found then
    raise exception 'customer_po_inbox row not found: %', _customer_po_inbox_id;
  end if;

  if _warehouse_dispatch_id is not null then
    select * into v_dispatch from public.warehouse_dispatches where id = _warehouse_dispatch_id;
    if not found then
      raise exception 'warehouse_dispatch row not found: %', _warehouse_dispatch_id;
    end if;
  end if;

  select * into v_existing
  from public.po_dispatch_revenue_confirmations
  where (
    (_warehouse_dispatch_id is not null and warehouse_dispatch_id = _warehouse_dispatch_id)
    or (_warehouse_dispatch_id is null and customer_po_inbox_id = _customer_po_inbox_id and status <> 'cancelled')
  )
  order by updated_at desc
  limit 1;

  if v_existing.id is not null
     and v_existing.status in ('confirmed', 'revised')
     and coalesce(nullif(_payload->>'status', ''), '') <> 'revised' then
    raise exception 'Existing confirmed dispatch revenue requires revise_po_dispatch_revenue with an audit note';
  end if;

  v_old := case when v_existing.id is null then null else to_jsonb(v_existing) end;
  v_rollup := public.po_dispatch_revenue_payload_rollup(_payload, _note);

  if v_existing.id is null then
    insert into public.po_dispatch_revenue_confirmations (
      customer_po_inbox_id,
      warehouse_dispatch_id,
      production_order_id,
      customer_id,
      po_number,
      revenue_date,
      dispatch_date,
      status,
      ordered_qty_total,
      produced_qty_total,
      defect_qty_total,
      dispatched_qty_total,
      billable_qty_total,
      po_total_vat_included,
      temporary_revenue_amount_vat_included,
      confirmed_revenue_amount_vat_included,
      amount_status,
      amount_basis,
      created_by
    )
    values (
      _customer_po_inbox_id,
      _warehouse_dispatch_id,
      coalesce(nullif(_payload->>'production_order_id', '')::uuid, v_dispatch.production_order_id),
      coalesce(v_po.matched_customer_id, v_dispatch.customer_id),
      coalesce(nullif(_payload->>'po_number', ''), v_po.po_number),
      coalesce(nullif(_payload->>'revenue_date', '')::date, v_po.delivery_date, v_dispatch.dispatch_date, current_date),
      coalesce(nullif(_payload->>'dispatch_date', '')::date, v_dispatch.dispatch_date),
      'draft',
      (v_rollup->>'ordered_qty_total')::numeric,
      (v_rollup->>'produced_qty_total')::numeric,
      (v_rollup->>'defect_qty_total')::numeric,
      (v_rollup->>'dispatched_qty_total')::numeric,
      (v_rollup->>'billable_qty_total')::numeric,
      coalesce(nullif(_payload->>'po_total_vat_included', '')::numeric, v_po.total_amount),
      nullif(v_rollup->>'temporary_revenue_amount_vat_included', '')::numeric,
      nullif(v_rollup->>'confirmed_revenue_amount_vat_included', '')::numeric,
      v_rollup->>'amount_status',
      v_rollup->>'amount_basis',
      v_actor
    )
    returning * into v_result;
  else
    update public.po_dispatch_revenue_confirmations
    set warehouse_dispatch_id = coalesce(_warehouse_dispatch_id, warehouse_dispatch_id),
        production_order_id = coalesce(nullif(_payload->>'production_order_id', '')::uuid, v_dispatch.production_order_id, production_order_id),
        customer_id = coalesce(v_po.matched_customer_id, v_dispatch.customer_id, customer_id),
        po_number = coalesce(nullif(_payload->>'po_number', ''), v_po.po_number, po_number),
        revenue_date = coalesce(nullif(_payload->>'revenue_date', '')::date, revenue_date),
        dispatch_date = coalesce(nullif(_payload->>'dispatch_date', '')::date, v_dispatch.dispatch_date, dispatch_date),
        status = case when status = 'cancelled' then status else coalesce(nullif(_payload->>'status', ''), status) end,
        ordered_qty_total = (v_rollup->>'ordered_qty_total')::numeric,
        produced_qty_total = (v_rollup->>'produced_qty_total')::numeric,
        defect_qty_total = (v_rollup->>'defect_qty_total')::numeric,
        dispatched_qty_total = (v_rollup->>'dispatched_qty_total')::numeric,
        billable_qty_total = (v_rollup->>'billable_qty_total')::numeric,
        po_total_vat_included = coalesce(nullif(_payload->>'po_total_vat_included', '')::numeric, po_total_vat_included),
        temporary_revenue_amount_vat_included = nullif(v_rollup->>'temporary_revenue_amount_vat_included', '')::numeric,
        confirmed_revenue_amount_vat_included = nullif(v_rollup->>'confirmed_revenue_amount_vat_included', '')::numeric,
        amount_status = v_rollup->>'amount_status',
        amount_basis = v_rollup->>'amount_basis'
    where id = v_existing.id
    returning * into v_result;

    delete from public.po_dispatch_revenue_confirmation_lines where confirmation_id = v_result.id;
  end if;

  for v_line in select value from jsonb_array_elements(coalesce(_payload->'lines', '[]'::jsonb))
  loop
    insert into public.po_dispatch_revenue_confirmation_lines (
      confirmation_id,
      source_line_key,
      sku,
      product_name,
      ordered_qty,
      produced_qty,
      defect_qty,
      dispatched_qty,
      billable_qty,
      unit_price_vat_included,
      source_line_amount_vat_included,
      temporary_revenue_amount_vat_included,
      confirmed_revenue_amount_vat_included,
      shortage_reason_code,
      shortage_note
    )
    values (
      v_result.id,
      nullif(v_line->>'source_line_key', ''),
      nullif(v_line->>'sku', ''),
      coalesce(nullif(v_line->>'product_name', ''), 'Dispatch line'),
      coalesce(nullif(v_line->>'ordered_qty', '')::numeric, 0),
      coalesce(nullif(v_line->>'produced_qty', '')::numeric, 0),
      coalesce(nullif(v_line->>'defect_qty', '')::numeric, 0),
      coalesce(nullif(v_line->>'dispatched_qty', '')::numeric, 0),
      coalesce(nullif(v_line->>'billable_qty', '')::numeric, 0),
      nullif(v_line->>'unit_price_vat_included', '')::numeric,
      nullif(v_line->>'source_line_amount_vat_included', '')::numeric,
      nullif(v_line->>'temporary_revenue_amount_vat_included', '')::numeric,
      case
        when v_result.amount_status = 'needs_sku_allocation' then null
        else nullif(v_line->>'confirmed_revenue_amount_vat_included', '')::numeric
      end,
      nullif(v_line->>'shortage_reason_code', ''),
      nullif(v_line->>'shortage_note', '')
    );
  end loop;

  insert into public.po_dispatch_revenue_audit_logs (
    confirmation_id,
    customer_po_inbox_id,
    warehouse_dispatch_id,
    action,
    actor_id,
    old_values,
    new_values,
    note
  )
  values (
    v_result.id,
    _customer_po_inbox_id,
    _warehouse_dispatch_id,
    case when v_old is null then 'created' else 'updated' end,
    v_actor,
    v_old,
    jsonb_build_object('header', to_jsonb(v_result), 'payload', _payload, 'rollup', v_rollup),
    _note
  );

  return v_result;
end;
$$;

create or replace function public.confirm_po_dispatch_revenue(
  _confirmation_id uuid,
  _note text default null
)
returns public.po_dispatch_revenue_confirmations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_old public.po_dispatch_revenue_confirmations%rowtype;
  v_result public.po_dispatch_revenue_confirmations%rowtype;
begin
  if v_actor is null or not public.can_edit_po_dispatch_revenue_confirmation(v_actor) then
    raise exception 'Forbidden: dispatch revenue edit permission required';
  end if;

  select * into v_old from public.po_dispatch_revenue_confirmations where id = _confirmation_id for update;
  if not found then
    raise exception 'dispatch revenue confirmation not found: %', _confirmation_id;
  end if;

  if v_old.amount_status = 'needs_sku_allocation' or v_old.confirmed_revenue_amount_vat_included is null then
    raise exception 'Cannot confirm final revenue until missing SKU allocation or audited manual amount is provided';
  end if;

  update public.po_dispatch_revenue_confirmations
  set status = 'confirmed',
      confirmed_by = v_actor,
      confirmed_at = now()
  where id = _confirmation_id
  returning * into v_result;

  insert into public.po_dispatch_revenue_audit_logs (
    confirmation_id,
    customer_po_inbox_id,
    warehouse_dispatch_id,
    action,
    actor_id,
    old_values,
    new_values,
    note
  )
  values (
    v_result.id,
    v_result.customer_po_inbox_id,
    v_result.warehouse_dispatch_id,
    'confirmed',
    v_actor,
    to_jsonb(v_old),
    to_jsonb(v_result),
    _note
  );

  return v_result;
end;
$$;

create or replace function public.revise_po_dispatch_revenue(
  _confirmation_id uuid,
  _payload jsonb default '{}'::jsonb,
  _note text default null
)
returns public.po_dispatch_revenue_confirmations
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_current public.po_dispatch_revenue_confirmations%rowtype;
  v_payload jsonb := coalesce(_payload, '{}'::jsonb);
  v_result public.po_dispatch_revenue_confirmations%rowtype;
begin
  if v_actor is null or not public.can_edit_po_dispatch_revenue_confirmation(v_actor) then
    raise exception 'Forbidden: dispatch revenue edit permission required';
  end if;

  select * into v_current from public.po_dispatch_revenue_confirmations where id = _confirmation_id;
  if not found then
    raise exception 'dispatch revenue confirmation not found: %', _confirmation_id;
  end if;

  if nullif(btrim(coalesce(_note, v_payload->>'manual_amount_note', '')), '') is null then
    raise exception 'Revision requires an audit note';
  end if;

  v_payload := v_payload || jsonb_build_object('status', 'revised');

  if v_payload ? 'confirmed_revenue_amount_vat_included' then
    v_payload := v_payload || jsonb_build_object('amount_status', 'month_end_audit_adjusted');
  end if;

  v_result := public.upsert_po_dispatch_revenue_confirmation(
    v_current.customer_po_inbox_id,
    v_current.warehouse_dispatch_id,
    v_payload,
    _note
  );

  update public.po_dispatch_revenue_confirmations
  set status = 'revised'
  where id = v_result.id
  returning * into v_result;

  insert into public.po_dispatch_revenue_audit_logs (
    confirmation_id,
    customer_po_inbox_id,
    warehouse_dispatch_id,
    action,
    actor_id,
    old_values,
    new_values,
    note
  )
  values (
    v_result.id,
    v_result.customer_po_inbox_id,
    v_result.warehouse_dispatch_id,
    'revised',
    v_actor,
    to_jsonb(v_current),
    jsonb_build_object('header', to_jsonb(v_result), 'payload', v_payload),
    _note
  );

  return v_result;
end;
$$;

revoke all on function public.can_edit_po_dispatch_revenue_confirmation(uuid) from public;
revoke all on function public.po_dispatch_revenue_payload_rollup(jsonb, text) from public;
revoke all on function public.upsert_po_dispatch_revenue_confirmation(uuid, uuid, jsonb, text) from public;
revoke all on function public.confirm_po_dispatch_revenue(uuid, text) from public;
revoke all on function public.revise_po_dispatch_revenue(uuid, jsonb, text) from public;

grant execute on function public.can_edit_po_dispatch_revenue_confirmation(uuid) to authenticated;
grant execute on function public.po_dispatch_revenue_payload_rollup(jsonb, text) to authenticated;
grant execute on function public.upsert_po_dispatch_revenue_confirmation(uuid, uuid, jsonb, text) to authenticated;
grant execute on function public.confirm_po_dispatch_revenue(uuid, text) to authenticated;
grant execute on function public.revise_po_dispatch_revenue(uuid, jsonb, text) to authenticated;
