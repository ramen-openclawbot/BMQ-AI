-- 2026-10-27 — Nhật ký kho: ghi mọi thay đổi món kho và hàm đọc để đối soát.
--
-- 1. public.kho_audit_log is append-only.  RLS is on, the only policy is SELECT
--    for a warehouse viewer, and an UPDATE / DELETE trigger refuses every
--    rewrite.  Clients get no write privilege or write policy at all.
-- 2. An AFTER INSERT OR UPDATE trigger on public.kitchen_inventory_items writes
--    one row per real change of name / unit / active / item_class / note /
--    in_tan_tao / pastry_q7 / merged_into_id / item_code.  An UPDATE that leaves
--    every tracked field untouched writes nothing.  The actor is auth.uid();
--    service_role and migrations have no user, so they store source = 'system'.
--    The log insert is wrapped in an exception block: a logging failure can
--    never abort the original item command.
-- 3. public.kho_get_audit_log() unions the item log with the Tân Tạo ledger, the
--    Q7 ledger, stock_transfers and stock_unit_events, normalises one row shape,
--    sorts newest first and pages by the (occurred_at, key) cursor.  The two ledger rows of one
--    stock transfer are skipped because stock_transfers is their single row.
--
-- The target list mentions "in_q7"; there is no such column on
-- kitchen_inventory_items.  The real column is pastry_q7 (in_q7 is only the
-- output alias used by kho_get_items), so pastry_q7 is the tracked field.
--
-- This migration is not applied to the live database by this change.

-- ===========================================================================
-- 1. append-only audit table
-- ===========================================================================

create table if not exists public.kho_audit_log (
  id uuid primary key default gen_random_uuid(),
  occurred_at timestamptz not null default clock_timestamp(),
  actor_id uuid,
  action text not null,
  item_id uuid,
  item_name text not null,
  changes jsonb not null default '{}'::jsonb,
  source text not null default 'app',
  constraint kho_audit_log_changes_object_check
    check (jsonb_typeof(changes) = 'object')
);

create index if not exists kho_audit_log_occurred_at_idx
  on public.kho_audit_log (occurred_at desc, id desc);
create index if not exists kho_audit_log_item_idx
  on public.kho_audit_log (item_id, occurred_at desc);
create index if not exists kho_audit_log_actor_idx
  on public.kho_audit_log (actor_id, occurred_at desc);
create index if not exists kho_audit_log_action_idx
  on public.kho_audit_log (action, occurred_at desc);

alter table public.kho_audit_log enable row level security;

drop policy if exists kho_audit_log_select on public.kho_audit_log;
create policy kho_audit_log_select on public.kho_audit_log
  for select to authenticated
  using (
    public.q7_material_inventory_can_view((select auth.uid()))
    or public.can_view_tan_tao_warehouse()
  );

-- Read-only for every client.  There is deliberately no INSERT / UPDATE /
-- DELETE policy and no grant: the SECURITY DEFINER trigger is the only writer.
revoke all on table public.kho_audit_log from public, anon, authenticated;
grant select on table public.kho_audit_log to authenticated, service_role;

create or replace function public.kho_audit_log_append_only()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception 'kho_audit_log_append_only' using errcode = '42501';
end;
$$;

revoke all on function public.kho_audit_log_append_only() from public, anon, authenticated;

drop trigger if exists kho_audit_log_no_update_delete on public.kho_audit_log;
create trigger kho_audit_log_no_update_delete
  before update or delete on public.kho_audit_log
  for each row execute function public.kho_audit_log_append_only();

-- ===========================================================================
-- 2. trigger on kitchen_inventory_items
-- ===========================================================================

create or replace function public.kho_audit_log_item_changes()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid;
  v_source text;
  v_action text;
  v_changes jsonb := '{}'::jsonb;
begin
  begin
    -- An UPDATE that changed nothing in the tracked list is not news.
    if tg_op = 'UPDATE'
       and old.name is not distinct from new.name
       and old.unit is not distinct from new.unit
       and old.active is not distinct from new.active
       and old.item_class is not distinct from new.item_class
       and old.note is not distinct from new.note
       and old.in_tan_tao is not distinct from new.in_tan_tao
       and old.pastry_q7 is not distinct from new.pastry_q7
       and old.merged_into_id is not distinct from new.merged_into_id
       and old.item_code is not distinct from new.item_code then
      return null;
    end if;

    -- service_role (and a migration run) has no person behind the change.
    v_actor := case
      when coalesce(auth.role(), '') = 'service_role' then null
      else auth.uid()
    end;
    v_source := case when v_actor is null then 'system' else 'app' end;

    if tg_op = 'INSERT' then
      v_action := 'created';
      v_changes := jsonb_build_object(
        'name', jsonb_build_object('old', null, 'new', new.name),
        'unit', jsonb_build_object('old', null, 'new', new.unit),
        'active', jsonb_build_object('old', null, 'new', new.active),
        'item_class', jsonb_build_object('old', null, 'new', new.item_class),
        'note', jsonb_build_object('old', null, 'new', new.note),
        'in_tan_tao', jsonb_build_object('old', null, 'new', new.in_tan_tao),
        'pastry_q7', jsonb_build_object('old', null, 'new', new.pastry_q7),
        'merged_into_id', jsonb_build_object('old', null, 'new', new.merged_into_id),
        'item_code', jsonb_build_object('old', null, 'new', new.item_code)
      );
    else
      if old.name is distinct from new.name then
        v_changes := v_changes || jsonb_build_object(
          'name', jsonb_build_object('old', old.name, 'new', new.name)
        );
      end if;
      if old.unit is distinct from new.unit then
        v_changes := v_changes || jsonb_build_object(
          'unit', jsonb_build_object('old', old.unit, 'new', new.unit)
        );
      end if;
      if old.active is distinct from new.active then
        v_changes := v_changes || jsonb_build_object(
          'active', jsonb_build_object('old', old.active, 'new', new.active)
        );
      end if;
      if old.item_class is distinct from new.item_class then
        v_changes := v_changes || jsonb_build_object(
          'item_class', jsonb_build_object('old', old.item_class, 'new', new.item_class)
        );
      end if;
      if old.note is distinct from new.note then
        v_changes := v_changes || jsonb_build_object(
          'note', jsonb_build_object('old', old.note, 'new', new.note)
        );
      end if;
      if old.in_tan_tao is distinct from new.in_tan_tao then
        v_changes := v_changes || jsonb_build_object(
          'in_tan_tao', jsonb_build_object('old', old.in_tan_tao, 'new', new.in_tan_tao)
        );
      end if;
      if old.pastry_q7 is distinct from new.pastry_q7 then
        v_changes := v_changes || jsonb_build_object(
          'pastry_q7', jsonb_build_object('old', old.pastry_q7, 'new', new.pastry_q7)
        );
      end if;
      if old.merged_into_id is distinct from new.merged_into_id then
        v_changes := v_changes || jsonb_build_object(
          'merged_into_id', jsonb_build_object('old', old.merged_into_id, 'new', new.merged_into_id)
        );
      end if;
      if old.item_code is distinct from new.item_code then
        v_changes := v_changes || jsonb_build_object(
          'item_code', jsonb_build_object('old', old.item_code, 'new', new.item_code)
        );
      end if;

      if v_changes = '{}'::jsonb then
        return null;
      end if;

      -- One readable action per change.  A merged row wins, then a rename, then
      -- the single-field names; a mixed edit falls back to 'edited'.
      v_action := case
        when v_changes ? 'merged_into_id' then 'merged'
        when v_changes ? 'name' then 'renamed'
        when v_changes ? 'unit' then 'unit_changed'
        when v_changes ? 'item_class' then 'class_changed'
        when v_changes ? 'note' then 'note_changed'
        when v_changes ? 'active' then
          case when new.active then 'activated' else 'deactivated' end
        when v_changes ? 'in_tan_tao' or v_changes ? 'pastry_q7' then 'places_changed'
        when v_changes ? 'item_code' then 'code_changed'
        else 'edited'
      end;
    end if;

    -- Never let a log problem break the item write that produced it.  A missing
    -- actor is already handled as source = 'system'; this also covers any future
    -- constraint or permission surprise on the log table.
    insert into public.kho_audit_log (
      actor_id, action, item_id, item_name, changes, source
    ) values (
      v_actor, v_action, new.id, new.name, v_changes, v_source
    );
  exception when others then
    null;
  end;

  return null;
end;
$$;

revoke all on function public.kho_audit_log_item_changes() from public, anon, authenticated;

drop trigger if exists kho_audit_log_item_changes on public.kitchen_inventory_items;
create trigger kho_audit_log_item_changes
  after insert or update on public.kitchen_inventory_items
  for each row execute function public.kho_audit_log_item_changes();

-- ===========================================================================
-- 3. kho_get_audit_log — one normalised, paged feed
-- ===========================================================================

create or replace function public.kho_get_audit_log(
  p_from date default null,
  p_to date default null,
  p_actor uuid default null,
  p_item_id uuid default null,
  p_kinds text[] default null,
  p_limit integer default 50,
  p_before timestamptz default null,
  p_before_key text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_limit integer := greatest(1, least(coalesce(p_limit, 50), 200));
  v_items jsonb := '[]'::jsonb;
  v_has_more boolean := false;
begin
  -- Same reader gate as public.get_stock_transfers().
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then
      raise exception 'actor_required' using errcode = '42501';
    end if;
    if not (
      public.q7_material_inventory_can_view(v_actor)
      or public.can_view_tan_tao_warehouse()
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  with unified as (
    -- Item catalog audit rows.
    select
      'audit:' || a.id::text as row_key,
      a.occurred_at,
      a.actor_id,
      a.action as kind,
      null::text as location,
      a.item_id,
      coalesce(a.item_name, i.name) as item_name,
      case a.action
        when 'created' then 'Tạo món mới'
        when 'renamed' then 'Đổi tên: ' || coalesce(a.changes -> 'name' ->> 'old', '')
          || ' → ' || coalesce(a.changes -> 'name' ->> 'new', '')
        when 'unit_changed' then 'Đổi đơn vị: ' || coalesce(a.changes -> 'unit' ->> 'old', '')
          || ' → ' || coalesce(a.changes -> 'unit' ->> 'new', '')
        when 'class_changed' then 'Đổi loại món: ' || coalesce(a.changes -> 'item_class' ->> 'old', '—')
          || ' → ' || coalesce(a.changes -> 'item_class' ->> 'new', '—')
        when 'note_changed' then 'Đổi ghi chú'
        when 'activated' then 'Bật món'
        when 'deactivated' then 'Tắt món'
        when 'places_changed' then 'Đổi nơi lưu kho'
        when 'merged' then 'Gộp món'
        when 'code_changed' then 'Đổi mã món: ' || coalesce(a.changes -> 'item_code' ->> 'old', '')
          || ' → ' || coalesce(a.changes -> 'item_code' ->> 'new', '')
        else 'Cập nhật món'
      end as summary,
      coalesce(a.changes, '{}'::jsonb)
        || jsonb_build_object('action', a.action, 'source', a.source) as details
    from public.kho_audit_log a
    left join public.kitchen_inventory_items i on i.id = a.item_id

    union all

    -- Tân Tạo ledger.  The transfer_out row is represented once by
    -- stock_transfers below, so every stock-transfer ledger row is skipped.
    select
      'tan_tao:' || m.id::text as row_key,
      m.created_at as occurred_at,
      m.created_by as actor_id,
      case
        when m.movement_type = 'receipt' then 'receipt'
        when m.movement_type = 'production_usage' then 'production_use'
        when m.movement_type = 'opening' then 'opening'
        when m.movement_type = 'adjustment'
          and m.source_ref_key like 'tt-material-count:%' then 'stock_count'
        else 'adjustment'
      end as kind,
      'tan_tao'::text as location,
      m.kitchen_inventory_item_id as item_id,
      i.name as item_name,
      case
        when m.movement_type = 'receipt' then 'Nhập kho Tân Tạo '
        when m.movement_type = 'production_usage' then 'Dùng sản xuất tại Tân Tạo '
        when m.movement_type = 'opening' then 'Tồn đầu kỳ Tân Tạo '
        when m.movement_type = 'adjustment'
          and m.source_ref_key like 'tt-material-count:%' then 'Kiểm kê kho Tân Tạo '
        else 'Điều chỉnh kho Tân Tạo '
      end
        || trim(trailing '.' from to_char(m.quantity, 'FM999999990.###'))
        || ' ' || coalesce(m.unit, '') as summary,
      jsonb_build_object(
        'movement_id', m.id,
        'movement_type', m.movement_type,
        'movement_date', m.movement_date,
        'quantity', m.quantity,
        'unit', m.unit,
        'source', m.source,
        'source_ref_key', m.source_ref_key,
        'note', m.note
      ) as details
    from public.tan_tao_material_movements m
    join public.kitchen_inventory_items i on i.id = m.kitchen_inventory_item_id
    where not (
      m.movement_type = 'transfer_out'
      and m.source = 'stock_transfer'
    )

    union all

    -- Q7 ledger.  Same dedupe for transfer_in.
    select
      'q7:' || m.id::text as row_key,
      m.created_at as occurred_at,
      m.created_by as actor_id,
      case
        when m.movement_type = 'receipt' then 'receipt'
        when m.movement_type = 'production_usage' then 'production_use'
        when m.movement_type = 'adjustment'
          and m.source_ref_key like 'q7-stock-count:%' then 'stock_count'
        else 'adjustment'
      end as kind,
      'q7'::text as location,
      m.kitchen_inventory_item_id as item_id,
      i.name as item_name,
      case
        when m.movement_type = 'receipt' then 'Nhập kho Q7 '
        when m.movement_type = 'production_usage' then 'Dùng sản xuất tại Q7 '
        when m.movement_type = 'adjustment'
          and m.source_ref_key like 'q7-stock-count:%' then 'Kiểm kê kho Q7 '
        else 'Điều chỉnh kho Q7 '
      end
        || trim(trailing '.' from to_char(m.quantity, 'FM999999990.###'))
        || ' ' || coalesce(m.unit, '') as summary,
      jsonb_build_object(
        'movement_id', m.id,
        'movement_type', m.movement_type,
        'movement_date', m.movement_date,
        'quantity', m.quantity,
        'unit', m.unit,
        'source', m.source,
        'source_ref_key', m.source_ref_key,
        'note', m.note
      ) as details
    from public.q7_inventory_movements m
    join public.kitchen_inventory_items i on i.id = m.kitchen_inventory_item_id
    where not (
      m.movement_type = 'transfer_in'
      and m.source = 'stock_transfer'
    )

    union all

    -- One row per transfer, never the two ledger rows above.
    select
      'transfer:' || t.id::text as row_key,
      t.created_at as occurred_at,
      t.created_by as actor_id,
      'transfer'::text as kind,
      null::text as location,
      t.kitchen_inventory_item_id as item_id,
      i.name as item_name,
      'Chuyển kho Tân Tạo → Q7 '
        || trim(trailing '.' from to_char(t.quantity, 'FM999999990.###'))
        || ' ' || coalesce(t.unit, '')
        || ' (phiếu ' || t.transfer_number || ')' as summary,
      jsonb_build_object(
        'transfer_id', t.id,
        'transfer_number', t.transfer_number,
        'transfer_date', t.transfer_date,
        'from_location', t.from_location,
        'to_location', t.to_location,
        'quantity', t.quantity,
        'unit', t.unit,
        'source', t.source,
        'slip_number', t.slip_number,
        'note', t.note
      ) as details
    from public.stock_transfers t
    join public.kitchen_inventory_items i on i.id = t.kitchen_inventory_item_id

    union all

    -- Unit catalog events: a new count unit or a changed conversion.
    select
      'unit_event:' || e.id::text as row_key,
      e.created_at as occurred_at,
      e.actor as actor_id,
      case
        when e.action = 'add_unit' then 'unit_added'
        when e.action = 'set_conversion' then 'conversion_changed'
        else 'unit_' || e.action
      end as kind,
      null::text as location,
      e.item_id,
      i.name as item_name,
      case
        when e.action = 'add_unit' then 'Thêm đơn vị ' || coalesce(e.unit, '')
        when e.action = 'set_conversion' then 'Đổi quy đổi đơn vị ' || coalesce(e.unit, '')
        else 'Cập nhật đơn vị ' || coalesce(e.unit, '')
      end as summary,
      coalesce(e.details, '{}'::jsonb)
        || jsonb_build_object('action', e.action, 'unit', e.unit) as details
    from public.stock_unit_events e
    left join public.kitchen_inventory_items i on i.id = e.item_id
  ),
  filtered as (
    select *
    from unified u
    where (p_from is null
           or (u.occurred_at at time zone 'Asia/Ho_Chi_Minh')::date >= p_from)
      and (p_to is null
           or (u.occurred_at at time zone 'Asia/Ho_Chi_Minh')::date <= p_to)
      and (p_actor is null or u.actor_id = p_actor)
      and (p_item_id is null or u.item_id = p_item_id)
      and (p_kinds is null or cardinality(p_kinds) = 0 or u.kind = any(p_kinds))
      -- Cursor = (occurred_at, row_key): rows written in one transaction share a
      -- timestamp, so the key breaks the tie and no row is skipped between pages.
      and (p_before is null
           or u.occurred_at < p_before
           or (u.occurred_at = p_before and p_before_key is not null and u.row_key < p_before_key))
    order by u.occurred_at desc, u.row_key desc
    limit v_limit + 1
  ),
  page as (
    select *
    from filtered
    order by occurred_at desc, row_key desc
    limit v_limit
  )
  select
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'key', p.row_key,
            'occurred_at', p.occurred_at,
            'actor_id', p.actor_id,
            'actor_name', coalesce(
              nullif(btrim(pr.full_name), ''),
              nullif(btrim(pr.email), '')
            ),
            'kind', p.kind,
            'location', p.location,
            'item_id', p.item_id,
            'item_name', p.item_name,
            'summary', p.summary,
            'details', p.details
          )
          order by p.occurred_at desc, p.row_key desc
        )
        from page p
        left join public.profiles pr on pr.user_id = p.actor_id
      ),
      '[]'::jsonb
    ),
    (select count(*) from filtered) > v_limit
  into v_items, v_has_more;

  return jsonb_build_object(
    'items', v_items,
    'has_more', v_has_more
  );
end;
$$;

revoke all on function public.kho_get_audit_log(date, date, uuid, uuid, text[], integer, timestamptz, text)
  from public, anon;
grant execute on function public.kho_get_audit_log(date, date, uuid, uuid, text[], integer, timestamptz, text)
  to authenticated, service_role;
