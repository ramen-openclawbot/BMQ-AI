-- Automatically post a one-to-one stock issue when a supplier goods receipt becomes received.
-- This records the warehouse issue step without operator intervention while keeping the
-- receipt, issue document, batch, inventory balance, and unified stock ledger atomic.
-- Effective prospectively: existing received receipts are intentionally not backfilled.

create table if not exists public.goods_receipt_auto_issues (
  id uuid primary key default gen_random_uuid(),
  issue_number text not null unique,
  goods_receipt_id uuid not null references public.goods_receipts(id) on delete restrict,
  issue_date date not null,
  status text not null default 'posted' check (status = 'posted'),
  source text not null default 'system_auto' check (source = 'system_auto'),
  total_quantity numeric(15, 3) not null default 0,
  notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (goods_receipt_id)
);

create table if not exists public.goods_receipt_auto_issue_items (
  id uuid primary key default gen_random_uuid(),
  auto_issue_id uuid not null references public.goods_receipt_auto_issues(id) on delete restrict,
  goods_receipt_item_id uuid not null references public.goods_receipt_items(id) on delete restrict,
  inventory_item_id uuid not null references public.inventory_items(id) on delete restrict,
  sku_id uuid references public.product_skus(id) on delete set null,
  batch_id uuid not null references public.inventory_batches(id) on delete restrict,
  product_name text not null,
  quantity numeric(15, 3) not null check (quantity > 0),
  unit text not null,
  unit_cost numeric(15, 2) not null default 0,
  amount numeric(17, 2) not null default 0,
  notes text,
  created_at timestamptz not null default now(),
  unique (goods_receipt_item_id)
);

create index if not exists goods_receipt_auto_issue_items_issue_idx
  on public.goods_receipt_auto_issue_items(auto_issue_id);
create index if not exists goods_receipt_auto_issue_items_inventory_idx
  on public.goods_receipt_auto_issue_items(inventory_item_id);

-- One inbound and one outbound ledger row per auto-issued receipt line.
create unique index if not exists inventory_movements_auto_receipt_ref_uidx
  on public.inventory_movements(movement_type, reference_type, reference_id)
  where reference_type = 'goods_receipt_auto_issue' and reference_id is not null;

alter table public.goods_receipt_auto_issues enable row level security;
alter table public.goods_receipt_auto_issue_items enable row level security;

-- Read-only audit visibility for signed-in staff. Posting is trigger-only.
drop policy if exists goods_receipt_auto_issues_authenticated_read
  on public.goods_receipt_auto_issues;
create policy goods_receipt_auto_issues_authenticated_read
  on public.goods_receipt_auto_issues
  for select to authenticated
  using (true);

drop policy if exists goods_receipt_auto_issue_items_authenticated_read
  on public.goods_receipt_auto_issue_items;
create policy goods_receipt_auto_issue_items_authenticated_read
  on public.goods_receipt_auto_issue_items
  for select to authenticated
  using (true);

revoke insert, update, delete, truncate on public.goods_receipt_auto_issues
  from public, anon, authenticated;
revoke insert, update, delete, truncate on public.goods_receipt_auto_issue_items
  from public, anon, authenticated;
grant select on public.goods_receipt_auto_issues to authenticated;
grant select on public.goods_receipt_auto_issue_items to authenticated;

create or replace function public.auto_issue_goods_receipt()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_auto_issue_id uuid;
  v_auto_issue_item_id uuid;
  v_item public.goods_receipt_items%rowtype;
  v_quantity numeric(15, 3);
  v_batch_id uuid;
  v_batch_quantity numeric(15, 3);
  v_batch_count integer;
  v_inventory_quantity integer;
  v_expected_inventory_quantity integer;
  v_positive_line_count integer;
begin
  if new.finalized_at is null then
    raise exception 'Auto issue requires a finalized goods receipt %', new.id;
  end if;

  select count(*)
    into v_positive_line_count
    from public.goods_receipt_items
   where goods_receipt_id = new.id
     and greatest(0, coalesce(actual_quantity, quantity, 0)) > 0;

  if v_positive_line_count = 0 then
    raise exception 'Auto issue requires at least one positive goods receipt item for %', new.id;
  end if;

  insert into public.goods_receipt_auto_issues (
    issue_number,
    goods_receipt_id,
    issue_date,
    status,
    source,
    notes,
    created_by
  ) values (
    'PXK-AUTO-' || new.receipt_number,
    new.id,
    coalesce(new.receipt_date, current_date),
    'posted',
    'system_auto',
    'PXK tự động 1:1 khi hoàn tất ' || new.receipt_number,
    new.finalized_by
  )
  on conflict (goods_receipt_id) do nothing
  returning id into v_auto_issue_id;

  if v_auto_issue_id is null then
    select id
      into v_auto_issue_id
      from public.goods_receipt_auto_issues
     where goods_receipt_id = new.id
     for update;
  end if;

  if v_auto_issue_id is null then
    raise exception 'Auto issue header could not be created for goods receipt %', new.id;
  end if;

  for v_item in
    select *
      from public.goods_receipt_items
     where goods_receipt_id = new.id
       and greatest(0, coalesce(actual_quantity, quantity, 0)) > 0
     order by created_at, id
     for update
  loop
    v_quantity := greatest(0, coalesce(v_item.actual_quantity, v_item.quantity, 0));

    if v_item.inventory_item_id is null then
      raise exception 'Auto issue requires an inventory item for goods receipt item %', v_item.id;
    end if;

    -- Idempotent/partial-retry guard: a posted line has already reduced stock and batch.
    select id
      into v_auto_issue_item_id
      from public.goods_receipt_auto_issue_items
     where goods_receipt_item_id = v_item.id;

    if found then
      continue;
    end if;

    select count(*)
      into v_batch_count
      from public.inventory_batches
     where goods_receipt_item_id = v_item.id;

    if v_batch_count <> 1 then
      raise exception 'Auto issue requires exactly one receipt batch for goods receipt item %; found %',
        v_item.id, v_batch_count;
    end if;

    select id, quantity
      into v_batch_id, v_batch_quantity
      from public.inventory_batches
     where goods_receipt_item_id = v_item.id
     for update;

    if v_batch_quantity is distinct from v_quantity then
      raise exception 'Auto issue batch quantity mismatch for goods receipt item %: batch %, expected %',
        v_item.id, v_batch_quantity, v_quantity;
    end if;

    v_auto_issue_item_id := null;

    insert into public.goods_receipt_auto_issue_items (
      auto_issue_id,
      goods_receipt_item_id,
      inventory_item_id,
      sku_id,
      batch_id,
      product_name,
      quantity,
      unit,
      unit_cost,
      amount,
      notes
    ) values (
      v_auto_issue_id,
      v_item.id,
      v_item.inventory_item_id,
      v_item.sku_id,
      v_batch_id,
      v_item.product_name,
      v_quantity,
      coalesce(nullif(v_item.unit, ''), 'unit'),
      greatest(0, coalesce(v_item.unit_price, 0)),
      v_quantity * greatest(0, coalesce(v_item.unit_price, 0)),
      'Tự động xuất toàn bộ lô vừa nhập'
    )
    on conflict (goods_receipt_item_id) do nothing
    returning id into v_auto_issue_item_id;

    -- A pre-existing line means this receipt line was already posted. Do not deduct twice.
    if v_auto_issue_item_id is null then
      continue;
    end if;

    v_expected_inventory_quantity := round(v_quantity)::integer;

    update public.inventory_items
       set quantity = quantity - round(v_quantity)::integer,
           updated_at = now()
     where id = v_item.inventory_item_id
       and quantity >= v_expected_inventory_quantity
    returning quantity into v_inventory_quantity;

    if not found then
      raise exception 'Auto issue cannot deduct % from inventory item % without negative stock',
        v_expected_inventory_quantity, v_item.inventory_item_id;
    end if;

    update public.inventory_batches
       set quantity = quantity - v_quantity,
           updated_at = now()
     where id = v_batch_id;

    insert into public.inventory_movements (
      movement_type,
      sku_id,
      inventory_item_id,
      batch_id,
      quantity,
      unit,
      reference_type,
      reference_id,
      movement_date,
      notes,
      created_by
    ) values (
      'goods_receipt_in',
      v_item.sku_id,
      v_item.inventory_item_id,
      v_batch_id,
      v_quantity,
      coalesce(nullif(v_item.unit, ''), 'unit'),
      'goods_receipt_auto_issue',
      v_auto_issue_item_id,
      coalesce(new.receipt_date, current_date),
      'Nhập kho từ ' || new.receipt_number,
      new.finalized_by
    )
    on conflict (movement_type, reference_type, reference_id)
      where reference_type = 'goods_receipt_auto_issue' and reference_id is not null
    do nothing;

    insert into public.inventory_movements (
      movement_type,
      sku_id,
      inventory_item_id,
      batch_id,
      quantity,
      unit,
      reference_type,
      reference_id,
      movement_date,
      notes,
      created_by
    ) values (
      'production_consume',
      v_item.sku_id,
      v_item.inventory_item_id,
      v_batch_id,
      -v_quantity,
      coalesce(nullif(v_item.unit, ''), 'unit'),
      'goods_receipt_auto_issue',
      v_auto_issue_item_id,
      coalesce(new.receipt_date, current_date),
      'PXK tự động ngay sau nhập kho ' || new.receipt_number,
      new.finalized_by
    )
    on conflict (movement_type, reference_type, reference_id)
      where reference_type = 'goods_receipt_auto_issue' and reference_id is not null
    do nothing;
  end loop;

  update public.goods_receipt_auto_issues ai
     set total_quantity = coalesce((
       select sum(aii.quantity)
         from public.goods_receipt_auto_issue_items aii
        where aii.auto_issue_id = ai.id
     ), 0)
   where ai.id = v_auto_issue_id;

  return new;
end;
$$;

revoke execute on function public.auto_issue_goods_receipt() from public;
revoke execute on function public.auto_issue_goods_receipt() from anon;
revoke execute on function public.auto_issue_goods_receipt() from authenticated;
revoke execute on function public.auto_issue_goods_receipt() from service_role;

drop trigger if exists auto_issue_goods_receipt_on_received on public.goods_receipts;
create trigger auto_issue_goods_receipt_on_received
  after update of status on public.goods_receipts
  for each row
  when (old.status is distinct from new.status and new.status::text = 'received')
  execute function public.auto_issue_goods_receipt();
