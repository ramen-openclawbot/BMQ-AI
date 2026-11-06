-- KFM quantity change sync: a received portal PO whose lines KFM edited after
-- BMQ imported it is re-applied to the approved inbox in one transaction.
-- Orders that have not started yet are cancelled; any started order blocks the
-- whole update and is returned as a warning for manual handling.
--
-- Service-role only: the Edge intake scan calls this after an explicit operator
-- action. The scan itself only reads the portal and the inbox.

create or replace function public.kfm_apply_po_change(p_po_number text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code text := upper(btrim(coalesce(p_po_number, '')));
  v_inbox public.customer_po_inbox%rowtype;
  v_order public.production_orders%rowtype;
  v_old_items jsonb;
  v_new_items jsonb := coalesce(p_payload->'production_items', '[]'::jsonb);
  v_old_total numeric;
  v_raw jsonb;
  v_revisions jsonb;
  v_cancelled jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
  v_cancelled_count integer := 0;
  v_differs boolean := false;
begin
  if v_code = '' then
    raise exception 'po_number_required' using errcode = '22023';
  end if;
  if jsonb_typeof(p_payload) is distinct from 'object'
    or jsonb_typeof(v_new_items) is distinct from 'array' then
    raise exception 'invalid_payload' using errcode = '22023';
  end if;

  -- Only the portal source may be changed, and only while it is still approved.
  select * into v_inbox
  from public.customer_po_inbox
  where upper(btrim(po_number)) = v_code
    and raw_payload->>'source' = 'kfm_portal'
    and match_status = 'approved'
  order by created_at asc nulls first, id
  limit 1
  for update;

  if not found then
    return jsonb_build_object(
      'status', 'noop',
      'inbox_id', null,
      'po_number', v_code,
      'cancelled_count', 0,
      'cancelled_orders', '[]'::jsonb,
      'warning_count', 0,
      'warnings', '[]'::jsonb,
      'old_items', '[]'::jsonb,
      'new_items', '[]'::jsonb
    );
  end if;

  v_old_items := coalesce(v_inbox.production_items, '[]'::jsonb);
  v_old_total := v_inbox.total_amount;

  -- Compare as multisets of (sku, qty), independent of line order and of the
  -- price/date fields KFM does not change here.
  select exists (
    select 1
    from (
      select coalesce(nullif(btrim(item->>'sku'), ''), nullif(btrim(item->>'sku_code'), '')) as sku,
             coalesce((item->>'qty')::numeric, 0) as qty
      from jsonb_array_elements(v_old_items) item
    ) old_row
    full join (
      select coalesce(nullif(btrim(item->>'sku'), ''), nullif(btrim(item->>'sku_code'), '')) as sku,
             coalesce((item->>'qty')::numeric, 0) as qty
      from jsonb_array_elements(v_new_items) item
    ) new_row
      on new_row.sku = old_row.sku and new_row.qty = old_row.qty
    where old_row.sku is null or new_row.sku is null
  ) into v_differs;

  if not v_differs then
    return jsonb_build_object(
      'status', 'noop',
      'inbox_id', v_inbox.id,
      'po_number', v_inbox.po_number,
      'cancelled_count', 0,
      'cancelled_orders', '[]'::jsonb,
      'warning_count', 0,
      'warnings', '[]'::jsonb,
      'old_items', v_old_items,
      'new_items', v_new_items
    );
  end if;

  -- Lock and classify every order sourced from this inbox. Any order that is
  -- neither still planned nor already cancelled means production has started:
  -- change nothing and let staff resolve it manually.
  for v_order in
    select *
    from public.production_orders
    where source_po_inbox_id = v_inbox.id
    order by id
    for update
  loop
    -- A planned order with produced quantity or a warehouse dispatch has
    -- effectively started too.
    if v_order.status::text not in ('planned', 'cancelled')
      or (v_order.status::text = 'planned' and (
        exists (select 1 from public.warehouse_dispatches d where d.production_order_id = v_order.id)
        or coalesce((select sum(i.actual_qty) from public.production_order_items i
                     where i.production_order_id = v_order.id), 0) <> 0)) then
      v_warnings := v_warnings || jsonb_build_object(
        'id', v_order.id,
        'production_number', v_order.production_number,
        'status', v_order.status::text,
        'message', 'Lệnh sản xuất đã bắt đầu; cần xử lý tay.'
      );
    end if;
  end loop;

  if jsonb_array_length(v_warnings) > 0 then
    return jsonb_build_object(
      'status', 'blocked',
      'inbox_id', v_inbox.id,
      'po_number', v_inbox.po_number,
      'cancelled_count', 0,
      'cancelled_orders', '[]'::jsonb,
      'warning_count', jsonb_array_length(v_warnings),
      'warnings', v_warnings,
      'old_items', v_old_items,
      'new_items', v_new_items
    );
  end if;

  -- Preserve every key the inbox already had, merge the fresh portal keys, then
  -- append this change to the history (never replace earlier revisions).
  v_revisions := case
    when jsonb_typeof(v_inbox.raw_payload->'kfm_revisions') = 'array'
      then v_inbox.raw_payload->'kfm_revisions'
    else '[]'::jsonb
  end;
  v_raw := coalesce(v_inbox.raw_payload, '{}'::jsonb) || coalesce(p_payload->'raw_payload', '{}'::jsonb);
  v_raw := jsonb_set(
    v_raw,
    '{kfm_revisions}',
    v_revisions || jsonb_build_object(
      'changed_at', now(),
      'old_items', v_old_items,
      'old_total', v_old_total
    ),
    true
  );

  update public.customer_po_inbox
  set production_items = v_new_items,
      subtotal_amount = (p_payload->>'subtotal_amount')::numeric,
      vat_amount = (p_payload->>'vat_amount')::numeric,
      total_amount = (p_payload->>'total_amount')::numeric,
      delivery_date = (p_payload->>'delivery_date')::date,
      raw_payload = v_raw,
      review_note = 'KFM đổi số lượng PO trên cổng'
  where id = v_inbox.id;

  -- create_q7_production_from_po reuses any order still linked to the inbox
  -- (one order per inbox, uq_production_orders_source_po_inbox), even a
  -- cancelled one. Detach every cancelled order so a new one can be created
  -- with the new quantities; the note keeps the trace to this PO.
  update public.production_orders
  set source_po_inbox_id = null,
      notes = concat_ws(E'\n', nullif(notes, ''), 'Tách khỏi PO ' || v_inbox.po_number || ' (inbox ' || v_inbox.id || ') do KFM đổi số lượng'),
      updated_at = now()
  where source_po_inbox_id = v_inbox.id
    and status::text = 'cancelled';

  -- Planned orders are cancelled and detached in the same statement; earlier
  -- cancelled rows were detached above and are not counted again.
  for v_order in
    update public.production_orders
    set status = 'cancelled',
        source_po_inbox_id = null,
        notes = concat_ws(E'\n', nullif(notes, ''), 'KFM đổi số lượng PO ' || v_inbox.po_number || ' (inbox ' || v_inbox.id || ') trên cổng'),
        updated_at = now()
    where source_po_inbox_id = v_inbox.id
      and status::text = 'planned'
    returning *
  loop
    v_cancelled_count := v_cancelled_count + 1;
    v_cancelled := v_cancelled || jsonb_build_object(
      'id', v_order.id,
      'production_number', v_order.production_number,
      'status', 'cancelled'
    );
  end loop;

  return jsonb_build_object(
    'status', 'updated',
    'inbox_id', v_inbox.id,
    'po_number', v_inbox.po_number,
    'cancelled_count', v_cancelled_count,
    'cancelled_orders', v_cancelled,
    'warning_count', 0,
    'warnings', '[]'::jsonb,
    'old_items', v_old_items,
    'new_items', v_new_items
  );
end;
$$;

revoke all on function public.kfm_apply_po_change(text, jsonb) from public, anon, authenticated;
grant execute on function public.kfm_apply_po_change(text, jsonb) to service_role;
