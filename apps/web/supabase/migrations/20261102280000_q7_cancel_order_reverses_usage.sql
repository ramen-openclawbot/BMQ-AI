-- 2026-10-19 — Hủy lệnh sản xuất Q7 tự hoàn trừ NVL đã xuất.
--
-- Additive migration on top of 20261102270000. It adds:
--   1. reverse_material_issue_usage(uuid, text) — body from 20261013100000,
--      now reason-aware ('superseded' keeps the old note, 'order_cancelled'
--      writes the cancellation note) and with the SIGN FIXED: the reversal is
--      a positive adjustment (on-hand = receipts - usage + adjustments); the
--      old body wrote a negative one. Live had 0 reversal rows before this
--      migration, so nothing needs correcting. The one-argument call still
--      works through the default reason.
--   2. public.cancel_production_order_material_issues(uuid) — cancel every
--      current issue of one order and reverse its posted usage. Idempotent.
--   3. production_orders_cancel_material_issues — AFTER UPDATE OF status on
--      public.production_orders when it becomes 'cancelled'.
--   4. post_material_issue_usage reports 'order_cancelled' and writes nothing
--      when the issue's production order is already cancelled.
--   5. Idempotent backfill for already-cancelled orders that still have
--      unreversed production usage.
--
-- Nothing changes for superseded issues: trg_stock_ledger_material_issue still
-- reverses them, now passing the explicit 'superseded' reason.
--
-- Rollback note
-- -------------
--   begin;
--     drop trigger if exists production_orders_cancel_material_issues
--       on public.production_orders;
--     drop function if exists public.trg_production_order_cancelled();
--     drop function if exists public.cancel_production_order_material_issues(uuid);
--     drop function if exists public.reverse_material_issue_usage(uuid, text);
--     -- Re-create public.reverse_material_issue_usage(p_issue_id uuid) exactly
--     -- as in 20261013100000_stock_ledger_flow.sql (the fixed-note body), then
--     -- revoke all from public, anon, authenticated and grant execute to
--     -- service_role.
--     -- Restore public.post_material_issue_usage(p_issue_id uuid) to the body
--     -- in 20261101410000_q7_bom_match_and_posting.sql, and restore
--     -- public.trg_stock_ledger_material_issue() to call
--     -- reverse_material_issue_usage(new.id).
--   commit;
--
-- The reversal rows already written by this migration are append-only ledger
-- entries: do NOT delete them when rolling the code back. A later cancellation
-- is a no-op for them because of the unique
-- 'pmi-item-reverse:<issue_item_id>' key (source, source_ref_key).

-- ===========================================================================
-- 1. Reason-aware reversal (old one-argument signature is replaced)
-- ===========================================================================

drop function if exists public.reverse_material_issue_usage(uuid);

create or replace function public.reverse_material_issue_usage(
  p_issue_id uuid,
  p_reason text default 'superseded'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer := 0;
  v_note text;
begin
  v_note := case p_reason
    when 'order_cancelled' then 'Hoàn bút toán phiếu xuất NVL — lệnh sản xuất đã hủy'
    else 'Đảo bút toán phiếu xuất NVL bị thay thế'
  end;

  insert into public.q7_inventory_movements(
    kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
    source, source_ref_key, source_issue_id, source_issue_item_id,
    q7_mapping_id, canonical_material_id, note, created_by
  )
  -- Q7 on-hand = receipts - production_usage + adjustments (see
  -- q7_material_inventory_ledger / get_q7_bom_mismatch_review). A usage row
  -- holds a POSITIVE quantity, so restoring it needs a POSITIVE adjustment.
  -- The 20261013100000 body wrote -m.quantity, which would deduct a second
  -- time; no reversal row had been written before this migration.
  select m.kitchen_inventory_item_id,
         (now() at time zone 'Asia/Ho_Chi_Minh')::date,
         'adjustment',
         m.quantity,
         m.unit,
         'production_material_issue_reversal',
         'pmi-item-reverse:' || m.source_issue_item_id::text,
         m.source_issue_id,
         m.source_issue_item_id,
         m.q7_mapping_id,
         m.canonical_material_id,
         v_note,
         auth.uid()
  from public.q7_inventory_movements m
  where m.source = 'production_material_issue'
    and m.source_issue_id = p_issue_id
    and m.source_issue_item_id is not null
  on conflict (source, source_ref_key) where source_ref_key is not null do nothing;

  get diagnostics v_count = row_count;
  return jsonb_build_object('status', 'reversed', 'issue_id', p_issue_id, 'movement_count', v_count);
end;
$$;

revoke all on function public.reverse_material_issue_usage(uuid, text)
  from public, anon, authenticated;
grant execute on function public.reverse_material_issue_usage(uuid, text)
  to service_role;

create or replace function public.trg_stock_ledger_material_issue()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.status in ('pdf_ready', 'posted')
     and (tg_op = 'INSERT' or old.status is distinct from new.status) then
    perform public.post_material_issue_usage(new.id);
  end if;
  if new.superseded_by_issue_id is not null
     and (tg_op = 'INSERT' or old.superseded_by_issue_id is distinct from new.superseded_by_issue_id) then
    perform public.reverse_material_issue_usage(new.id, 'superseded');
  end if;
  return new;
end;
$$;

-- ===========================================================================
-- 2. Cancel one order's current issues and reverse their posted usage
-- ===========================================================================

create or replace function public.cancel_production_order_material_issues(p_order_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_issue public.production_material_issues%rowtype;
  v_result jsonb;
  v_issues integer := 0;
  v_rows integer := 0;
begin
  for v_issue in
    select *
    from public.production_material_issues
    where production_order_id = p_order_id
      and is_current = true
      and status <> 'cancelled'
    order by id
    for update
  loop
    -- Only these two columns change; the updated_at trigger handles the
    -- timestamp as usual.
    update public.production_material_issues
    set status = 'cancelled',
        is_current = false
    where id = v_issue.id;

    v_result := public.reverse_material_issue_usage(v_issue.id, 'order_cancelled');
    v_issues := v_issues + 1;
    v_rows := v_rows + coalesce((v_result ->> 'movement_count')::integer, 0);
  end loop;

  return jsonb_build_object(
    'order_id', p_order_id,
    'issues_cancelled', v_issues,
    'reversal_rows', v_rows
  );
end;
$$;

revoke all on function public.cancel_production_order_material_issues(uuid)
  from public, anon, authenticated;
grant execute on function public.cancel_production_order_material_issues(uuid)
  to service_role;

-- ===========================================================================
-- 3. Trigger on production_orders status change
-- ===========================================================================

create or replace function public.trg_production_order_cancelled()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.cancel_production_order_material_issues(new.id);
  return new;
end;
$$;

revoke all on function public.trg_production_order_cancelled()
  from public, anon, authenticated;

drop trigger if exists production_orders_cancel_material_issues on public.production_orders;
create trigger production_orders_cancel_material_issues
  after update of status on public.production_orders
  for each row
  when (new.status::text = 'cancelled' and old.status::text is distinct from 'cancelled')
  execute function public.trg_production_order_cancelled();

-- ===========================================================================
-- 4. post_material_issue_usage — do nothing for a cancelled order
--    (body copied verbatim from 20261101410000, plus the order guard)
-- ===========================================================================

create or replace function public.post_material_issue_usage(p_issue_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_issue public.production_material_issues%rowtype;
  v_cutover date;
  v_row record;
  v_inserted integer := 0;
  v_row_count integer := 0;
  v_skipped integer := 0;
  v_excluded boolean := false;
begin
  select * into v_issue from public.production_material_issues where id = p_issue_id;
  if not found then
    return jsonb_build_object('status', 'issue_not_found');
  end if;
  if v_issue.location_code is distinct from 'q7' then
    return jsonb_build_object('status', 'unsupported_location');
  end if;
  if v_issue.is_current is not true then
    return jsonb_build_object('status', 'not_current');
  end if;
  if v_issue.status not in ('pdf_ready', 'posted') then
    return jsonb_build_object('status', 'not_postable');
  end if;

  if exists (
    select 1
    from public.production_orders po
    where po.id = v_issue.production_order_id
      and po.status::text = 'cancelled'
  ) then
    return jsonb_build_object(
      'status', 'order_cancelled',
      'issue_id', p_issue_id,
      'movement_count', 0,
      'skipped_count', 0
    );
  end if;

  v_cutover := public.stock_ledger_cutover_date('q7');
  -- The count date itself is the truth: issue_date = cutover is NOT posted.
  if v_cutover is null or v_issue.issue_date <= v_cutover then
    return jsonb_build_object(
      'status', 'before_cutover',
      'issue_id', p_issue_id,
      'movement_count', 0,
      'skipped_count', 0
    );
  end if;

  for v_row in
    select i.id as item_id,
           i.kitchen_inventory_item_id,
           i.unit,
           i.required_qty,
           i.q7_mapping_id,
           i.canonical_material_id,
           i.source_unit,
           kii.item_class
    from public.production_material_issue_items i
    left join public.kitchen_inventory_items kii on kii.id = i.kitchen_inventory_item_id
    where i.material_issue_id = p_issue_id
      and i.kitchen_inventory_item_id is not null
      and coalesce(i.required_qty, 0) > 0
      and i.required_qty::text not in ('NaN', 'Infinity', '-Infinity')
      and exists (
        select 1
        from public.q7_material_issue_material_mappings m
        where m.approval_status = 'approved'
          and (
            m.id = i.q7_mapping_id
            or (
              i.q7_mapping_id is null
              and i.canonical_material_id is not null
              and m.canonical_material_id = i.canonical_material_id
            )
          )
      )
  loop
    select exists (
      select 1
      from public.q7_bom_line_decisions d
      where d.active = true
        and d.action in ('not_tracked', 'bom_error')
        and d.canonical_material_id = v_row.canonical_material_id
        and lower(btrim(d.source_unit)) = lower(btrim(coalesce(v_row.source_unit, '')))
    ) into v_excluded;

    if v_excluded or coalesce(v_row.item_class, '') = 'non_stock' then
      v_skipped := v_skipped + 1;
      continue;
    end if;

    -- Write the issue item's own canonical_material_id / q7_mapping_id instead
    -- of calling resolve_q7_canonical_inventory_item(). A resolved remap can
    -- leave the target kitchen item linked to another material or holding its
    -- own approved mapping; the resolver would then refuse the pair with
    -- q7_mapping_identity_mismatch. The approved mapping row for this BOM line
    -- is the authority for where this material's usage goes, so post it
    -- directly with the ids carried by the issue item.
    insert into public.q7_inventory_movements(
      kitchen_inventory_item_id, movement_date, movement_type, quantity, unit,
      source, source_ref_key, source_issue_id, source_issue_item_id,
      q7_mapping_id, canonical_material_id, note, created_by
    ) values (
      v_row.kitchen_inventory_item_id, v_issue.issue_date, 'production_usage', v_row.required_qty,
      v_row.unit, 'production_material_issue', 'pmi-item:' || v_row.item_id::text,
      v_issue.id, v_row.item_id, v_row.q7_mapping_id, v_row.canonical_material_id,
      'Xuất NVL cho sản xuất ' || v_issue.issue_number, auth.uid()
    )
    on conflict (source, source_ref_key) where source_ref_key is not null do nothing;
    get diagnostics v_row_count = row_count;
    v_inserted := v_inserted + v_row_count;
  end loop;

  return jsonb_build_object(
    'status', 'posted',
    'issue_id', p_issue_id,
    'movement_count', v_inserted,
    'skipped_count', v_skipped
  );
end;
$$;

-- ===========================================================================
-- 5. Backfill: reverse usage still open on already-cancelled orders
-- ===========================================================================

do $backfill$
declare
  v_order_id uuid;
  v_issue_id uuid;
  v_cancel jsonb;
  v_result jsonb;
  v_direct integer;
  v_orders integer := 0;
  v_issues integer := 0;
  v_rows integer := 0;
begin
  for v_order_id in
    select distinct po.id
    from public.production_orders po
    join public.production_material_issues pmi
      on pmi.production_order_id = po.id
    join public.q7_inventory_movements m
      on m.source = 'production_material_issue'
     and m.source_issue_id = pmi.id
     and m.source_issue_item_id is not null
    where po.status::text = 'cancelled'
      and not exists (
        select 1
        from public.q7_inventory_movements r
        where r.source = 'production_material_issue_reversal'
          and r.source_ref_key = 'pmi-item-reverse:' || m.source_issue_item_id::text
      )
    order by po.id
  loop
    -- Cancels the order's current issues and reverses their usage.
    v_cancel := public.cancel_production_order_material_issues(v_order_id);
    v_orders := v_orders + 1;
    v_issues := v_issues + coalesce((v_cancel ->> 'issues_cancelled')::integer, 0);
    v_rows := v_rows + coalesce((v_cancel ->> 'reversal_rows')::integer, 0);

    -- Issues that were already is_current = false (superseded / cancelled)
    -- but still hold an unreversed production_usage row. The reversal is
    -- idempotent, so issues handled above disappear from this query.
    for v_issue_id in
      select pmi.id
      from public.production_material_issues pmi
      where pmi.production_order_id = v_order_id
        and exists (
          select 1
          from public.q7_inventory_movements m
          where m.source = 'production_material_issue'
            and m.source_issue_id = pmi.id
            and m.source_issue_item_id is not null
            and not exists (
              select 1
              from public.q7_inventory_movements r
              where r.source = 'production_material_issue_reversal'
                and r.source_ref_key = 'pmi-item-reverse:' || m.source_issue_item_id::text
            )
        )
      order by pmi.id
    loop
      v_result := public.reverse_material_issue_usage(v_issue_id, 'order_cancelled');
      v_direct := coalesce((v_result ->> 'movement_count')::integer, 0);
      if v_direct > 0 then
        v_issues := v_issues + 1;
        v_rows := v_rows + v_direct;
      end if;
    end loop;
  end loop;

  raise notice 'q7 cancel-order reversal backfill: % order(s), % issue(s), % reversal row(s)',
    v_orders, v_issues, v_rows;
end;
$backfill$;
