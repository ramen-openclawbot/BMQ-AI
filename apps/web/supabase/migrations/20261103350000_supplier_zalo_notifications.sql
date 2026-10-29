-- Supplier order notifications for Zalo groups.
--
-- When a supplier order request is marked 'sent', one pending Zalo message is
-- queued for the supplier's enabled group. A local automation claims pending
-- rows, sends them through Zalo, then marks each row sent or failed.
--
-- Everything here is service-role only. There are no RLS policies on purpose:
-- authenticated clients must never read Zalo group ids or queued messages.

-- ---------------------------------------------------------------------------
-- 1. Supplier -> Zalo group mapping
-- ---------------------------------------------------------------------------

create table if not exists public.supplier_zalo_groups (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null unique references public.suppliers(id),
  zalo_group_id text not null,
  zalo_group_name text,
  enabled boolean not null default true,
  created_at timestamptz default now()
);

alter table public.supplier_zalo_groups enable row level security;

revoke all on table public.supplier_zalo_groups from public, anon, authenticated;
grant all on table public.supplier_zalo_groups to service_role;

insert into public.supplier_zalo_groups (supplier_id, zalo_group_id, zalo_group_name)
values (
  'ecd49e72-96fe-465d-b8a5-2c474aa7d6ae',
  '6235092197007068655',
  'Tương ớt(Cholimex) - Bánh Mì Que'
)
on conflict (supplier_id) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Outbox for pending Zalo messages
-- ---------------------------------------------------------------------------

create table if not exists public.supplier_zalo_notifications (
  id uuid primary key default gen_random_uuid(),
  order_request_id uuid not null unique
    references public.supplier_order_requests(id) on delete cascade,
  supplier_id uuid not null,
  zalo_group_id text not null,
  message text not null,
  status text not null default 'pending'
    check (status in ('pending', 'sending', 'sent', 'failed')),
  attempts int not null default 0,
  last_error text,
  claimed_at timestamptz,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_supplier_zalo_notifications_status
  on public.supplier_zalo_notifications(status, created_at);

alter table public.supplier_zalo_notifications enable row level security;

revoke all on table public.supplier_zalo_notifications from public, anon, authenticated;
grant all on table public.supplier_zalo_notifications to service_role;

-- ---------------------------------------------------------------------------
-- 3. Vietnamese message builder
-- ---------------------------------------------------------------------------

create or replace function public.supplier_order_zalo_message(p_order_request_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.supplier_order_requests%rowtype;
  v_supplier_name text;
  v_po_number text;
  v_message text;
  v_line record;
  v_quantity_text text;
  v_digits text;
  v_grouped text;
  v_index integer;
begin
  select *
    into v_request
  from public.supplier_order_requests
  where id = p_order_request_id;

  if not found then
    return '';
  end if;

  select name
    into v_supplier_name
  from public.suppliers
  where id = v_request.supplier_id;

  if v_request.purchase_order_id is not null then
    select po_number
      into v_po_number
    from public.purchase_orders
    where id = v_request.purchase_order_id;
  end if;

  v_message := '🧾 BMQ đặt hàng — '
    || coalesce(nullif(btrim(v_supplier_name), ''), 'Nhà cung cấp');
  v_message := v_message || E'\nPO: '
    || coalesce(nullif(btrim(v_po_number), ''), '—')
    || ' · Ngày: '
    || to_char(
         coalesce(v_request.sent_at, v_request.created_at, now())
           at time zone 'Asia/Ho_Chi_Minh',
         'DD/MM/YYYY'
       );

  -- Blank line between the PO header and the item list.
  v_message := v_message || E'\n';

  -- Supplier request lines first, then the draft PO items, then the single
  -- kitchen item carried by older requests. The first non-empty source wins.
  for v_line in
    select source.product_name, source.quantity, source.unit
    from (
      select 1 as source_order, l.position as position,
             l.product_name, l.quantity, l.unit
      from public.supplier_order_request_lines l
      where l.request_id = v_request.id

      union all

      select 2 as source_order, 0 as position,
             poi.product_name, poi.quantity, coalesce(poi.unit, v_request.unit)
      from public.purchase_order_items poi
      where v_request.purchase_order_id is not null
        and poi.purchase_order_id = v_request.purchase_order_id
        and not exists (
          select 1
          from public.supplier_order_request_lines l
          where l.request_id = v_request.id
        )

      union all

      select 3 as source_order, 0 as position,
             ki.name, v_request.quantity, v_request.unit
      from public.kitchen_inventory_items ki
      where ki.id = v_request.kitchen_inventory_item_id
        and not exists (
          select 1
          from public.supplier_order_request_lines l
          where l.request_id = v_request.id
        )
        and not exists (
          select 1
          from public.purchase_order_items poi
          where v_request.purchase_order_id is not null
            and poi.purchase_order_id = v_request.purchase_order_id
        )
    ) source
    order by source.source_order, source.position, source.product_name
  loop
    v_quantity_text := round(coalesce(v_line.quantity, 0), 3)::text;
    v_quantity_text := regexp_replace(v_quantity_text, '(\.\d*?)0+$', '\1');
    v_quantity_text := trim(trailing '.' from v_quantity_text);
    -- Vietnamese decimal comma: 1.5 -> 1,5.
    v_quantity_text := replace(v_quantity_text, '.', ',');

    v_message := v_message || E'\n• '
      || coalesce(nullif(btrim(v_line.product_name), ''), 'Hàng đặt')
      || ': ' || v_quantity_text;
    if nullif(btrim(coalesce(v_line.unit, '')), '') is not null then
      v_message := v_message || ' ' || btrim(v_line.unit);
    end if;
  end loop;

  -- Blank line between the item list and the summary block.
  v_message := v_message || E'\n';

  if v_request.total_amount is not null then
    v_digits := round(abs(v_request.total_amount))::bigint::text;
    v_grouped := '';
    for v_index in 1..length(v_digits) loop
      if v_index > 1
         and ((length(v_digits) - v_index + 1) % 3) = 0 then
        v_grouped := v_grouped || '.';
      end if;
      v_grouped := v_grouped || substr(v_digits, v_index, 1);
    end loop;
    if v_request.total_amount < 0 then
      v_grouped := '-' || v_grouped;
    end if;

    v_message := v_message || E'\nTổng: ' || v_grouped || ' đ (đã gồm VAT)';
  end if;

  if nullif(btrim(coalesce(v_request.note, '')), '') is not null then
    v_message := v_message || E'\nGhi chú: ' || btrim(v_request.note);
  end if;

  v_message := v_message || E'\nEmail đơn đã gửi tới: '
    || coalesce(v_request.to_email, '');
  v_message := v_message || E'\nBánh Mì Que xin cảm ơn!';

  return coalesce(v_message, '');
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Enqueue one message when a request becomes 'sent'
-- ---------------------------------------------------------------------------

create or replace function public.enqueue_supplier_zalo_notification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group public.supplier_zalo_groups%rowtype;
begin
  if TG_OP = 'UPDATE' then
    if OLD.status is not distinct from 'sent' then
      return NEW;
    end if;
  end if;

  select *
    into v_group
  from public.supplier_zalo_groups
  where supplier_id = NEW.supplier_id
    and enabled
  limit 1;

  if not found then
    return NEW;
  end if;

  begin
    insert into public.supplier_zalo_notifications (
      order_request_id,
      supplier_id,
      zalo_group_id,
      message
    ) values (
      NEW.id,
      NEW.supplier_id,
      v_group.zalo_group_id,
      public.supplier_order_zalo_message(NEW.id)
    )
    on conflict (order_request_id) do nothing;
  exception when others then
    raise warning
      'supplier_zalo_notification_enqueue_failed request=% supplier=% error=%',
      NEW.id, NEW.supplier_id, sqlerrm;
  end;

  return NEW;
end;
$$;

drop trigger if exists trg_supplier_order_zalo_notification
  on public.supplier_order_requests;
create trigger trg_supplier_order_zalo_notification
  after insert or update of status on public.supplier_order_requests
  for each row
  when (NEW.status = 'sent')
  execute function public.enqueue_supplier_zalo_notification();

-- ---------------------------------------------------------------------------
-- 5. Claim / mark RPCs used by the local automation
-- ---------------------------------------------------------------------------

create or replace function public.claim_supplier_zalo_notifications(p_limit int default 5)
returns setof public.supplier_zalo_notifications
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and current_user not in ('postgres', 'supabase_admin') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  return query
  with picked as (
    select n.id
    from public.supplier_zalo_notifications n
    where n.status = 'pending'
       or (
         n.status = 'sending'
         and n.claimed_at < now() - interval '10 minutes'
       )
       or (
         n.status = 'failed'
         and n.attempts < 5
         and n.claimed_at < now() - interval '5 minutes'
       )
    order by n.created_at, n.id
    limit greatest(coalesce(p_limit, 0), 0)
    for update skip locked
  )
  update public.supplier_zalo_notifications n
     set status = 'sending',
         claimed_at = now(),
         attempts = n.attempts + 1
    from picked p
   where n.id = p.id
  returning n.*;
end;
$$;

create or replace function public.mark_supplier_zalo_notification(
  p_id uuid,
  p_ok boolean,
  p_error text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and current_user not in ('postgres', 'supabase_admin') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_id is null then
    return;
  end if;

  if p_ok then
    update public.supplier_zalo_notifications
       set status = 'sent',
           sent_at = now(),
           last_error = null
     where id = p_id;
  else
    update public.supplier_zalo_notifications
       set status = 'failed',
           last_error = left(coalesce(p_error, ''), 500)
     where id = p_id;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Privileges
-- ---------------------------------------------------------------------------

revoke all on function public.supplier_order_zalo_message(uuid)
  from public, anon, authenticated;
grant execute on function public.supplier_order_zalo_message(uuid)
  to service_role;

revoke all on function public.enqueue_supplier_zalo_notification()
  from public, anon, authenticated;
grant execute on function public.enqueue_supplier_zalo_notification()
  to service_role;

revoke all on function public.claim_supplier_zalo_notifications(int)
  from public, anon, authenticated;
grant execute on function public.claim_supplier_zalo_notifications(int)
  to service_role;

revoke all on function public.mark_supplier_zalo_notification(uuid, boolean, text)
  from public, anon, authenticated;
grant execute on function public.mark_supplier_zalo_notification(uuid, boolean, text)
  to service_role;
