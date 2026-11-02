-- KFM cancel sync: a received portal PO that KFM later marks as subStatus 11
-- (Đã hủy) is removed from the inbox and its not-yet-started production orders
-- are cancelled in the same transaction. Orders that already started stay
-- untouched and are returned as warnings.
--
-- Service-role only: the Edge intake scan calls this after re-reading the
-- portal list. Calling it again is a no-op once the inbox row is rejected.

alter table public.customer_po_inbox
  add column if not exists review_note text;

create or replace function public.kfm_mark_po_cancelled(p_po_number text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_code text := upper(btrim(coalesce(p_po_number, '')));
  v_inbox public.customer_po_inbox%rowtype;
  v_order public.production_orders%rowtype;
  v_cancelled jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
  v_cancelled_count integer := 0;
begin
  if v_code = '' then
    raise exception 'po_number_required' using errcode = '22023';
  end if;

  -- Only the portal source may be removed, and only while it is still approved.
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
      'po_number', v_code,
      'cancelled_count', 0,
      'cancelled_orders', '[]'::jsonb,
      'warning_count', 0,
      'warnings', '[]'::jsonb
    );
  end if;

  update public.customer_po_inbox
  set match_status = 'rejected',
      review_note = 'KFM đã hủy PO trên cổng',
      reviewed_at = now(),
      raw_payload = coalesce(raw_payload, '{}'::jsonb)
        || jsonb_build_object('portal_sub_status', 11)
  where id = v_inbox.id;

  -- Lock and classify every order sourced from this inbox. Only 'planned'
  -- orders are still safe to cancel; anything else is reported for staff.
  -- production_order_status (20260330120000_production_module.sql) includes
  -- the valid 'cancelled' value used below.
  for v_order in
    select *
    from public.production_orders
    where source_po_inbox_id = v_inbox.id
    order by id
    for update
  loop
    if v_order.status::text = 'planned' then
      update public.production_orders
      set status = 'cancelled',
          notes = concat_ws(E'\n', nullif(notes, ''), 'KFM đã hủy PO trên cổng'),
          updated_at = now()
      where id = v_order.id;

      v_cancelled_count := v_cancelled_count + 1;
      v_cancelled := v_cancelled || jsonb_build_object(
        'id', v_order.id,
        'production_number', v_order.production_number,
        'status', 'cancelled'
      );
    elsif v_order.status::text <> 'cancelled' then
      v_warnings := v_warnings || jsonb_build_object(
        'id', v_order.id,
        'production_number', v_order.production_number,
        'status', v_order.status::text,
        'message', 'Lệnh sản xuất đã bắt đầu hoặc không còn ở trạng thái kế hoạch; giữ nguyên.'
      );
    end if;
  end loop;

  return jsonb_build_object(
    'status', 'cancelled',
    'inbox_id', v_inbox.id,
    'po_number', v_inbox.po_number,
    'cancelled_count', v_cancelled_count,
    'cancelled_orders', v_cancelled,
    'warning_count', jsonb_array_length(v_warnings),
    'warnings', v_warnings
  );
end;
$$;

revoke all on function public.kfm_mark_po_cancelled(text) from public, anon, authenticated;
grant execute on function public.kfm_mark_po_cancelled(text) to service_role;
