-- Kitchen inventory trusted accounting ledger
-- The reviewed accounting workbook is the trusted source for canonical kitchen
-- item names, units, costs, and historical T3/T4 ledger summaries.

create table if not exists public.kitchen_inventory_import_batches (
  id uuid primary key default gen_random_uuid(),
  source_file_name text not null,
  source_sheet_name text not null default '01_IMPORT_REVIEW',
  source_period_start date,
  source_period_end date,
  status text not null default 'uploaded'
    check (status in ('uploaded', 'previewed', 'applied', 'partial', 'failed')),
  rows_total integer not null default 0,
  rows_approved integer not null default 0,
  rows_review integer not null default 0,
  rows_rejected integer not null default 0,
  created_by uuid references auth.users(id),
  applied_by uuid references auth.users(id),
  applied_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists public.kitchen_inventory_import_rows (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references public.kitchen_inventory_import_batches(id) on delete cascade,
  source_row_number integer not null,
  source_month date,
  source_item_name text not null,
  source_item_type text,
  source_unit text,
  source_standard_unit_cost numeric(14, 2),
  source_opening_qty numeric(14, 3),
  source_purchase_qty numeric(14, 3),
  source_usage_qty numeric(14, 3),
  source_ending_qty numeric(14, 3),
  source_amount numeric(16, 2),
  approval_decision text not null
    check (approval_decision in ('APPROVE', 'REVIEW', 'REJECT')),
  import_status text not null default 'staged'
    check (import_status in ('staged', 'applied', 'skipped', 'failed')),
  issue_flags jsonb not null default '[]'::jsonb,
  raw_payload jsonb not null,
  source_item_code text,
  source_normalized_key text,
  source_hash text,
  canonical_item_id uuid,
  created_at timestamptz not null default now(),
  unique (batch_id, source_row_number)
);

create table if not exists public.kitchen_inventory_items (
  id uuid primary key default gen_random_uuid(),
  item_code text not null unique,
  normalized_key text not null unique,
  item_type text not null check (item_type in ('ingredient', 'tool_supply')),
  name text not null,
  unit text not null,
  standard_unit_cost numeric(14, 2) not null default 0,
  active boolean not null default true,
  trusted_source_row_id uuid references public.kitchen_inventory_import_rows(id),
  trusted_source_batch_id uuid references public.kitchen_inventory_import_batches(id),
  source_hash text,
  inventory_item_id uuid,
  product_sku_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.kitchen_inventory_import_rows
  add constraint kitchen_inventory_import_rows_canonical_item_id_fkey
  foreign key (canonical_item_id) references public.kitchen_inventory_items(id);

create table if not exists public.kitchen_inventory_item_audit_logs (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.kitchen_inventory_items(id) on delete cascade,
  action text not null check (action in ('created', 'overwritten', 'manually_edited', 'deactivated')),
  old_values jsonb,
  new_values jsonb not null,
  source_batch_id uuid references public.kitchen_inventory_import_batches(id),
  changed_by uuid references auth.users(id),
  changed_at timestamptz not null default now()
);

create table if not exists public.kitchen_inventory_movements (
  id uuid primary key default gen_random_uuid(),
  movement_date date not null,
  period_month date not null,
  item_id uuid not null references public.kitchen_inventory_items(id),
  movement_type text not null
    check (movement_type in ('opening', 'purchase', 'usage', 'stock_count', 'adjustment')),
  quantity numeric(14, 3) not null default 0,
  unit text not null,
  unit_cost numeric(14, 2) not null default 0,
  amount numeric(16, 2) not null default 0,
  source text not null default 'manual_daily'
    check (source in ('import_t3_t4', 'manual_daily', 'adjustment', 'goods_receipt_bridge')),
  source_ref_id uuid,
  source_ref_key text,
  note text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists kitchen_inventory_movements_source_ref_uidx
  on public.kitchen_inventory_movements(source, source_ref_key, movement_type)
  where source = 'import_t3_t4' and source_ref_key is not null;

create table if not exists public.kitchen_inventory_movement_audit_logs (
  id uuid primary key default gen_random_uuid(),
  movement_id uuid not null references public.kitchen_inventory_movements(id) on delete cascade,
  action text not null check (action in ('overwritten', 'adjusted')),
  old_values jsonb,
  new_values jsonb not null,
  source_batch_id uuid references public.kitchen_inventory_import_batches(id),
  changed_by uuid references auth.users(id),
  changed_at timestamptz not null default now()
);

create table if not exists public.kitchen_inventory_monthly_closings (
  id uuid primary key default gen_random_uuid(),
  period_month date not null,
  item_id uuid not null references public.kitchen_inventory_items(id),
  opening_qty numeric(14, 3) not null default 0,
  purchase_qty numeric(14, 3) not null default 0,
  usage_qty numeric(14, 3) not null default 0,
  adjustment_qty numeric(14, 3) not null default 0,
  system_ending_qty numeric(14, 3) not null default 0,
  counted_ending_qty numeric(14, 3),
  variance_qty numeric(14, 3),
  unit_cost numeric(14, 2) not null default 0,
  usage_amount numeric(16, 2) not null default 0,
  status text not null default 'draft' check (status in ('draft', 'reviewed', 'closed')),
  closed_by uuid references auth.users(id),
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (period_month, item_id)
);

create table if not exists public.kitchen_other_costs (
  id uuid primary key default gen_random_uuid(),
  cost_date date not null,
  period_month date not null,
  cost_type text not null,
  description text not null,
  amount numeric(16, 2) not null default 0,
  source_batch_id uuid references public.kitchen_inventory_import_batches(id),
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);

create index if not exists kitchen_inventory_import_rows_batch_idx
  on public.kitchen_inventory_import_rows(batch_id);
create index if not exists kitchen_inventory_items_type_idx
  on public.kitchen_inventory_items(item_type, active);
create index if not exists kitchen_inventory_movements_period_idx
  on public.kitchen_inventory_movements(period_month, item_id, movement_type);
create index if not exists kitchen_inventory_monthly_closings_period_idx
  on public.kitchen_inventory_monthly_closings(period_month, status);
create index if not exists kitchen_other_costs_period_idx
  on public.kitchen_other_costs(period_month);

create or replace function public.set_kitchen_inventory_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_kitchen_inventory_items_updated_at on public.kitchen_inventory_items;
create trigger set_kitchen_inventory_items_updated_at
  before update on public.kitchen_inventory_items
  for each row execute function public.set_kitchen_inventory_updated_at();

drop trigger if exists set_kitchen_inventory_movements_updated_at on public.kitchen_inventory_movements;
create trigger set_kitchen_inventory_movements_updated_at
  before update on public.kitchen_inventory_movements
  for each row execute function public.set_kitchen_inventory_updated_at();

drop trigger if exists set_kitchen_inventory_monthly_closings_updated_at on public.kitchen_inventory_monthly_closings;
create trigger set_kitchen_inventory_monthly_closings_updated_at
  before update on public.kitchen_inventory_monthly_closings
  for each row execute function public.set_kitchen_inventory_updated_at();

create or replace function public.prevent_closed_kitchen_inventory_movement_changes()
returns trigger
language plpgsql
as $$
declare
  target_period date;
  target_item_id uuid;
begin
  target_period := case when tg_op = 'DELETE' then old.period_month else new.period_month end;
  target_item_id := case when tg_op = 'DELETE' then old.item_id else new.item_id end;

  if exists (
    select 1
    from public.kitchen_inventory_monthly_closings c
    where c.period_month = target_period
      and c.item_id = target_item_id
      and c.status = 'closed'
  ) then
    raise exception 'Kitchen inventory period % is closed. Create a later adjustment instead of editing the closed ledger.', target_period
      using errcode = 'P0001';
  end if;

  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists prevent_closed_kitchen_inventory_movement_changes on public.kitchen_inventory_movements;
create trigger prevent_closed_kitchen_inventory_movement_changes
  before insert or update or delete on public.kitchen_inventory_movements
  for each row execute function public.prevent_closed_kitchen_inventory_movement_changes();

create or replace function public.prevent_closed_kitchen_inventory_closing_changes()
returns trigger
language plpgsql
as $$
begin
  if tg_op in ('UPDATE', 'DELETE') and old.status = 'closed' then
    raise exception 'Kitchen inventory period % is closed and cannot be modified.', old.period_month
      using errcode = 'P0001';
  end if;

  return coalesce(new, old);
end;
$$;

drop trigger if exists prevent_closed_kitchen_inventory_closing_changes on public.kitchen_inventory_monthly_closings;
create trigger prevent_closed_kitchen_inventory_closing_changes
  before update or delete on public.kitchen_inventory_monthly_closings
  for each row execute function public.prevent_closed_kitchen_inventory_closing_changes();

create or replace function public.can_access_kitchen_inventory(required_edit boolean default false)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.user_roles ur
    where ur.user_id = auth.uid()
      and ur.role = 'owner'
  )
  or exists (
    select 1
    from public.user_module_permissions ump
    where ump.user_id = auth.uid()
      and ump.module_key = 'kitchen_inventory'
      and ump.can_view = true
      and (required_edit = false or ump.can_edit = true)
  );
$$;

create or replace function public.apply_kitchen_inventory_import_batch(p_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  source_row public.kitchen_inventory_import_rows%rowtype;
  existing_item public.kitchen_inventory_items%rowtype;
  applied_count integer := 0;
  skipped_count integer := 0;
  failed_count integer := 0;
  final_status text;
  batch_status text;
  batch_actor_id uuid;
  actor_id uuid;
  ingredient_counter integer;
  tool_counter integer;
  generated_code text;
  item_id uuid;
  old_values jsonb;
  new_values jsonb;
  qty numeric;
  movement_kind text;
  stable_movement_source_key text;
  effective_normalized_key text;
  existing_movement public.kitchen_inventory_movements%rowtype;
  movement_id uuid;
  old_movement_values jsonb;
  new_movement_values jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role'
    and not exists (
      select 1
      from public.user_roles ur
      where ur.user_id = auth.uid()
        and ur.role = 'owner'
    ) then
    raise exception 'Not allowed to apply kitchen inventory import batch' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext('kitchen_inventory_import_apply'));

  select status, created_by into batch_status, batch_actor_id
  from public.kitchen_inventory_import_batches
  where id = p_batch_id
  for update;

  if not found then
    raise exception 'Kitchen inventory import batch % not found', p_batch_id using errcode = 'P0002';
  end if;

  if batch_status = 'applied' then
    raise exception 'Kitchen inventory import batch % is already applied', p_batch_id using errcode = 'P0001';
  end if;

  actor_id := coalesce(auth.uid(), batch_actor_id);
  if actor_id is null then
    raise exception 'Kitchen inventory import batch % is missing created_by actor for audit attribution', p_batch_id
      using errcode = '23502';
  end if;

  select count(*) filter (where item_type = 'ingredient'),
         count(*) filter (where item_type = 'tool_supply')
    into ingredient_counter, tool_counter
  from public.kitchen_inventory_items;

  for source_row in
    select *
    from public.kitchen_inventory_import_rows
    where batch_id = p_batch_id
    order by source_row_number
  loop
    if source_row.import_status = 'applied' then
      skipped_count := skipped_count + 1;
      continue;
    end if;

    if source_row.approval_decision <> 'APPROVE' or jsonb_array_length(source_row.issue_flags) > 0 then
      update public.kitchen_inventory_import_rows
         set import_status = case when source_row.approval_decision = 'APPROVE' then 'failed' else 'skipped' end
       where id = source_row.id;
      if source_row.approval_decision = 'APPROVE' then
        failed_count := failed_count + 1;
      else
        skipped_count := skipped_count + 1;
      end if;
      continue;
    end if;

    select * into existing_item
    from public.kitchen_inventory_items
    where (source_row.source_item_code is not null and item_code = source_row.source_item_code)
       or normalized_key = source_row.source_normalized_key
    order by case when item_code = source_row.source_item_code then 0 else 1 end
    limit 1;

    if found and exists (
      select 1
      from public.kitchen_inventory_monthly_closings c
      where c.period_month = coalesce(source_row.source_month, date_trunc('month', current_date)::date)
        and c.item_id = existing_item.id
        and c.status = 'closed'
        and (
          source_row.source_opening_qty is not null or
          source_row.source_purchase_qty is not null or
          source_row.source_usage_qty is not null or
          source_row.source_ending_qty is not null
        )
    ) then
      update public.kitchen_inventory_import_rows
         set canonical_item_id = existing_item.id,
             import_status = 'failed'
       where id = source_row.id;
      failed_count := failed_count + 1;
      continue;
    end if;

    if found then
      generated_code := case
        when source_row.source_item_code is not null
          and length(trim(source_row.source_item_code)) > 0
          and not exists (
            select 1
            from public.kitchen_inventory_items dup
            where dup.item_code = trim(source_row.source_item_code)
              and dup.id <> existing_item.id
          ) then trim(source_row.source_item_code)
        else existing_item.item_code
      end;
      old_values := to_jsonb(existing_item);
      effective_normalized_key := case
        when exists (
          select 1
          from public.kitchen_inventory_items dup
          where dup.normalized_key = source_row.source_normalized_key
            and dup.id <> existing_item.id
        ) then existing_item.normalized_key
        else source_row.source_normalized_key
      end;
       update public.kitchen_inventory_items
         set item_code = generated_code,
             normalized_key = effective_normalized_key,
             item_type = source_row.source_item_type,
             name = source_row.source_item_name,
             unit = coalesce(nullif(source_row.source_unit, ''), existing_item.unit),
             standard_unit_cost = coalesce(source_row.source_standard_unit_cost, 0),
             active = true,
             trusted_source_row_id = source_row.id,
             trusted_source_batch_id = p_batch_id,
             source_hash = source_row.source_hash
       where id = existing_item.id
       returning id into item_id;
    else
      if source_row.source_item_code is not null and length(trim(source_row.source_item_code)) > 0 then
        generated_code := trim(source_row.source_item_code);
      elsif source_row.source_item_type = 'tool_supply' then
        loop
          tool_counter := tool_counter + 1;
          generated_code := 'CCDC-' || lpad(tool_counter::text, 3, '0');
          exit when not exists (
            select 1 from public.kitchen_inventory_items i where i.item_code = generated_code
          );
        end loop;
      else
        loop
          ingredient_counter := ingredient_counter + 1;
          generated_code := 'NVL-' || lpad(ingredient_counter::text, 3, '0');
          exit when not exists (
            select 1 from public.kitchen_inventory_items i where i.item_code = generated_code
          );
        end loop;
      end if;
      old_values := null;
      effective_normalized_key := case
        when exists (
          select 1
          from public.kitchen_inventory_items dup
          where dup.normalized_key = source_row.source_normalized_key
        ) then source_row.source_normalized_key || ':' || lower(generated_code)
        else source_row.source_normalized_key
      end;
      insert into public.kitchen_inventory_items (
        item_code,
        normalized_key,
        item_type,
        name,
        unit,
        standard_unit_cost,
        active,
        trusted_source_row_id,
        trusted_source_batch_id,
        source_hash
      ) values (
        generated_code,
        effective_normalized_key,
        source_row.source_item_type,
        source_row.source_item_name,
        coalesce(source_row.source_unit, ''),
        coalesce(source_row.source_standard_unit_cost, 0),
        true,
        source_row.id,
        p_batch_id,
        source_row.source_hash
      ) returning id into item_id;
    end if;

    select to_jsonb(i) into new_values from public.kitchen_inventory_items i where i.id = item_id;

    insert into public.kitchen_inventory_item_audit_logs (
      item_id,
      action,
      old_values,
      new_values,
      source_batch_id,
      changed_by
    ) values (
      item_id,
      case when old_values is null then 'created' else 'overwritten' end,
      old_values,
      new_values,
      p_batch_id,
      actor_id
    );

    stable_movement_source_key := coalesce(nullif(source_row.source_item_code, ''), source_row.source_normalized_key)
      || ':' || coalesce(source_row.source_month, date_trunc('month', current_date)::date)::text;

    foreach movement_kind in array array['opening', 'purchase', 'usage', 'stock_count'] loop
      qty := case movement_kind
        when 'opening' then source_row.source_opening_qty
        when 'purchase' then source_row.source_purchase_qty
        when 'usage' then source_row.source_usage_qty
        when 'stock_count' then source_row.source_ending_qty
      end;

      if qty is not null then
        if exists (
          select 1
          from public.kitchen_inventory_monthly_closings c
          where c.period_month = coalesce(source_row.source_month, date_trunc('month', current_date)::date)
            and c.item_id = item_id
            and c.status = 'closed'
        ) then
          continue;
        end if;

        select * into existing_movement
        from public.kitchen_inventory_movements
        where source = 'import_t3_t4'
          and source_ref_key = stable_movement_source_key
          and movement_type = movement_kind;
        old_movement_values := case when found then to_jsonb(existing_movement) else null end;

        insert into public.kitchen_inventory_movements (
          movement_date,
          period_month,
          item_id,
          movement_type,
          quantity,
          unit,
          unit_cost,
          amount,
          source,
          source_ref_id,
          source_ref_key,
          note
        ) values (
          coalesce(source_row.source_month, current_date),
          coalesce(source_row.source_month, date_trunc('month', current_date)::date),
          item_id,
          movement_kind,
          qty,
          coalesce(source_row.source_unit, ''),
          coalesce(source_row.source_standard_unit_cost, 0),
          qty * coalesce(source_row.source_standard_unit_cost, 0),
          'import_t3_t4',
          source_row.id,
          stable_movement_source_key,
          'Imported from reviewed accounting workbook'
        )
        on conflict (source, source_ref_key, movement_type)
        where source = 'import_t3_t4' and source_ref_key is not null
        do update
          set item_id = excluded.item_id,
              movement_date = excluded.movement_date,
              period_month = excluded.period_month,
              quantity = excluded.quantity,
              unit = excluded.unit,
              unit_cost = excluded.unit_cost,
              amount = excluded.amount,
              source_ref_id = excluded.source_ref_id,
              note = excluded.note
        returning id into movement_id;

        if old_movement_values is not null then
          select to_jsonb(m) into new_movement_values
          from public.kitchen_inventory_movements m
          where m.id = movement_id;

          if old_movement_values is distinct from new_movement_values then
            insert into public.kitchen_inventory_movement_audit_logs (
              movement_id,
              action,
              old_values,
              new_values,
              source_batch_id,
              changed_by
            ) values (
              movement_id,
              'overwritten',
              old_movement_values,
              new_movement_values,
              p_batch_id,
              actor_id
            );
          end if;
        end if;
      end if;
    end loop;

    update public.kitchen_inventory_import_rows
       set canonical_item_id = item_id,
           import_status = 'applied'
     where id = source_row.id;
    applied_count := applied_count + 1;
  end loop;

  final_status := case when failed_count > 0 then 'partial' else 'applied' end;

  update public.kitchen_inventory_import_batches
     set status = final_status,
         applied_by = actor_id,
         applied_at = now()
   where id = p_batch_id;

  return jsonb_build_object(
    'batch_id', p_batch_id,
    'status', final_status,
    'applied', applied_count,
    'skipped', skipped_count,
    'failed', failed_count
  );
end;
$$;

revoke all on function public.apply_kitchen_inventory_import_batch(uuid) from public;
grant execute on function public.apply_kitchen_inventory_import_batch(uuid) to service_role;

create or replace function public.close_kitchen_inventory_month(p_period_month date)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  target_month date := date_trunc('month', p_period_month)::date;
  closed_count integer := 0;
  already_closed_count integer := 0;
  missing_stock_count integer := 0;
begin
  if not public.can_access_kitchen_inventory(true) then
    raise exception 'Not allowed to close kitchen inventory month' using errcode = '42501';
  end if;

  if target_month is null then
    raise exception 'Period month is required' using errcode = '22004';
  end if;

  select count(*) into already_closed_count
  from public.kitchen_inventory_monthly_closings c
  where c.period_month = target_month
    and c.status = 'closed';

  select count(*) into missing_stock_count
  from public.kitchen_inventory_items i
  where i.active = true
    and not exists (
      select 1
      from public.kitchen_inventory_movements m
      where m.item_id = i.id
        and m.period_month = target_month
        and m.movement_type = 'stock_count'
    )
    and not exists (
      select 1
      from public.kitchen_inventory_monthly_closings c
      where c.item_id = i.id
        and c.period_month = target_month
        and c.status = 'closed'
    );

  if missing_stock_count > 0 then
    raise exception 'Cannot close kitchen inventory month %. % active item(s) are missing stock count rows.', target_month, missing_stock_count
      using errcode = 'P0001';
  end if;

  with item_rows as (
    select
      i.id as item_id,
      coalesce(sum(m.quantity) filter (where m.movement_type = 'opening'), 0) as opening_qty,
      coalesce(sum(m.quantity) filter (where m.movement_type = 'purchase'), 0) as purchase_qty,
      coalesce(sum(m.quantity) filter (where m.movement_type = 'usage'), 0) as usage_qty,
      coalesce(sum(m.quantity) filter (where m.movement_type = 'adjustment'), 0) as adjustment_qty,
      coalesce(i.standard_unit_cost, 0) as unit_cost,
      (
        select sm.quantity
        from public.kitchen_inventory_movements sm
        where sm.item_id = i.id
          and sm.period_month = target_month
          and sm.movement_type = 'stock_count'
        order by sm.movement_date desc, sm.created_at desc
        limit 1
      ) as counted_ending_qty
    from public.kitchen_inventory_items i
    left join public.kitchen_inventory_movements m
      on m.item_id = i.id
     and m.period_month = target_month
     and m.movement_type in ('opening', 'purchase', 'usage', 'adjustment')
    where i.active = true
    group by i.id, i.standard_unit_cost
  ), upserted as (
    insert into public.kitchen_inventory_monthly_closings (
      period_month,
      item_id,
      opening_qty,
      purchase_qty,
      usage_qty,
      adjustment_qty,
      system_ending_qty,
      counted_ending_qty,
      variance_qty,
      unit_cost,
      usage_amount,
      status,
      closed_by,
      closed_at
    )
    select
      target_month,
      item_id,
      opening_qty,
      purchase_qty,
      usage_qty,
      adjustment_qty,
      opening_qty + purchase_qty - usage_qty + adjustment_qty,
      counted_ending_qty,
      case
        when counted_ending_qty is null then null
        else counted_ending_qty - (opening_qty + purchase_qty - usage_qty + adjustment_qty)
      end,
      unit_cost,
      usage_qty * unit_cost,
      'closed',
      auth.uid(),
      now()
    from item_rows
    where not exists (
      select 1
      from public.kitchen_inventory_monthly_closings existing_closing
      where existing_closing.period_month = target_month
        and existing_closing.item_id = item_rows.item_id
        and existing_closing.status = 'closed'
    )
    on conflict (period_month, item_id) do update
      set opening_qty = excluded.opening_qty,
          purchase_qty = excluded.purchase_qty,
          usage_qty = excluded.usage_qty,
          adjustment_qty = excluded.adjustment_qty,
          system_ending_qty = excluded.system_ending_qty,
          counted_ending_qty = excluded.counted_ending_qty,
          variance_qty = excluded.variance_qty,
          unit_cost = excluded.unit_cost,
          usage_amount = excluded.usage_amount,
          status = 'closed',
          closed_by = auth.uid(),
          closed_at = now()
      where public.kitchen_inventory_monthly_closings.status <> 'closed'
    returning id
  )
  select count(*) into closed_count from upserted;

  return jsonb_build_object(
    'period_month', target_month,
    'status', 'closed',
    'closed', closed_count,
    'already_closed', already_closed_count
  );
end;
$$;

revoke all on function public.close_kitchen_inventory_month(date) from public;
grant execute on function public.close_kitchen_inventory_month(date) to authenticated;

alter table public.kitchen_inventory_import_batches enable row level security;
alter table public.kitchen_inventory_import_rows enable row level security;
alter table public.kitchen_inventory_items enable row level security;
alter table public.kitchen_inventory_item_audit_logs enable row level security;
alter table public.kitchen_inventory_movement_audit_logs enable row level security;
alter table public.kitchen_inventory_movements enable row level security;
alter table public.kitchen_inventory_monthly_closings enable row level security;
alter table public.kitchen_other_costs enable row level security;

create policy "Kitchen inventory view batches"
  on public.kitchen_inventory_import_batches for select
  using (public.can_access_kitchen_inventory(false));

create policy "Kitchen inventory view rows"
  on public.kitchen_inventory_import_rows for select
  using (public.can_access_kitchen_inventory(false));

create policy "Kitchen inventory view items"
  on public.kitchen_inventory_items for select
  using (public.can_access_kitchen_inventory(false));

create policy "Kitchen inventory view audit logs"
  on public.kitchen_inventory_item_audit_logs for select
  using (public.can_access_kitchen_inventory(false));
create policy "Kitchen inventory view movement audit logs"
  on public.kitchen_inventory_movement_audit_logs for select
  using (public.can_access_kitchen_inventory(false));

create policy "Kitchen inventory view movements"
  on public.kitchen_inventory_movements for select
  using (public.can_access_kitchen_inventory(false));
create policy "Kitchen inventory insert manual movements"
  on public.kitchen_inventory_movements for insert
  with check (
    public.can_access_kitchen_inventory(true)
    and source in ('manual_daily', 'adjustment')
    and created_by = auth.uid()
  );

create policy "Kitchen inventory view closings"
  on public.kitchen_inventory_monthly_closings for select
  using (public.can_access_kitchen_inventory(false));

create policy "Kitchen inventory view other costs"
  on public.kitchen_other_costs for select
  using (public.can_access_kitchen_inventory(false));

insert into public.user_module_permissions (user_id, module_key, can_view, can_edit)
select ur.user_id, 'kitchen_inventory', true, true
from public.user_roles ur
join auth.users au on au.id = ur.user_id
where ur.role = 'owner'
on conflict (user_id, module_key) do nothing;
