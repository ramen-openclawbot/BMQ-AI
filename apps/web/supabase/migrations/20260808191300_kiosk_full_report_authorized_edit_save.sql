-- Atomic, audited correction of every editable submitted-report field.

create or replace function public.save_kiosk_point_report_correction(
  p_report_id uuid,
  p_report_notes text,
  p_inventory_rows jsonb,
  p_channel_rows jsonb,
  p_review_status text,
  p_review_note text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_report public.kiosk_daily_reports%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_review_note text := nullif(btrim(coalesce(p_review_note, '')), '');
  v_before jsonb;
  v_after jsonb;
  v_breadstick_sold numeric(12,3) := 0;
  v_later record;
  v_cascade_ids jsonb := '[]'::jsonb;
begin
  if v_actor is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not (
    public.has_role(v_actor, 'owner')
    or public.has_module_permission(v_actor, 'finance_revenue', 'edit')
  ) then raise exception 'insufficient_privilege' using errcode = '42501'; end if;
  if v_reason is null or length(v_reason) > 500 then
    raise exception 'invalid_kiosk_report_edit_reason' using errcode = '22023';
  end if;
  if length(coalesce(p_report_notes, '')) > 2000 then
    raise exception 'kiosk_report_note_too_long' using errcode = '22023';
  end if;
  if p_review_status not in ('in_review', 'reviewed') then
    raise exception 'invalid_point_revenue_review_status' using errcode = '22023';
  end if;
  if v_review_note is not null and length(v_review_note) > 2000 then
    raise exception 'point_revenue_note_too_long' using errcode = '22023';
  end if;
  if p_inventory_rows is null or jsonb_typeof(p_inventory_rows) <> 'array' then
    raise exception 'invalid_kiosk_report_inventory_rows' using errcode = '22023';
  end if;
  if p_channel_rows is null or jsonb_typeof(p_channel_rows) <> 'array' then
    raise exception 'invalid_kiosk_report_channel_rows' using errcode = '22023';
  end if;

  select report.* into v_report
  from public.kiosk_daily_reports report
  where report.id = p_report_id
  for update;
  if not found or v_report.status <> 'submitted' then
    raise exception 'kiosk_report_not_submitted' using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_report.location_id::text, 0));

  if (select count(*) from jsonb_array_elements(p_inventory_rows)) < 1
    or (select count(*) from jsonb_array_elements(p_inventory_rows)) <>
       (select count(*) from public.kiosk_daily_report_inventory_rows where report_id = p_report_id)
    or exists (
      select 1 from jsonb_array_elements(p_inventory_rows) input
      left join public.kiosk_daily_report_inventory_rows source
        on source.report_id = p_report_id and source.product_code = input->>'product_code'
      where source.id is null
        or coalesce(input->>'opening_quantity', '') !~ '^\d+(\.\d{1,3})?$'
        or coalesce(input->>'received_quantity', '') !~ '^\d+(\.\d{1,3})?$'
        or coalesce(input->>'shortage_quantity', '') !~ '^\d+(\.\d{1,3})?$'
        or coalesce(input->>'transfer_quantity', '') !~ '^-?\d+(\.\d{1,3})?$'
        or coalesce(input->>'waste_quantity', '') !~ '^\d+(\.\d{1,3})?$'
        or coalesce(input->>'returns_quantity', '') !~ '^\d+(\.\d{1,3})?$'
        or coalesce(input->>'sold_quantity', '') !~ '^\d+(\.\d{1,3})?$'
        or coalesce(input->>'consumed_quantity', '') !~ '^\d+(\.\d{1,3})?$'
        or (input->>'opening_quantity')::numeric > 1000000000
        or (input->>'received_quantity')::numeric > 1000000000
        or (input->>'shortage_quantity')::numeric > 1000000000
        or abs((input->>'transfer_quantity')::numeric) > 1000000000
        or (input->>'waste_quantity')::numeric > 1000000000
        or (input->>'returns_quantity')::numeric > 1000000000
        or (input->>'sold_quantity')::numeric > 1000000000
        or (input->>'consumed_quantity')::numeric > 1000000000
        or length(coalesce(input->>'notes', '')) > 1000
    )
    or exists (
      select 1 from jsonb_array_elements(p_inventory_rows) input
      group by input->>'product_code' having count(*) > 1
    ) then raise exception 'invalid_kiosk_report_inventory_rows' using errcode = '22023'; end if;

  if (select count(*) from jsonb_array_elements(p_channel_rows)) < 1
    or (select count(*) from jsonb_array_elements(p_channel_rows)) <>
       (select count(*) from public.kiosk_daily_report_channel_rows where report_id = p_report_id)
    or exists (
      select 1 from jsonb_array_elements(p_channel_rows) input
      left join public.kiosk_daily_report_channel_rows source
        on source.report_id = p_report_id and source.channel_code = lower(btrim(input->>'channel_code'))
      where source.id is null
        or coalesce(input->>'quantity', '') !~ '^\d+(\.\d{1,3})?$'
        or coalesce(input->>'amount_vnd', '') !~ '^\d+(\.0{1,2})?$'
        or (input->>'quantity')::numeric > 1000000000
        or (input->>'amount_vnd')::numeric > 999999999999
        or length(coalesce(input->>'notes', '')) > 1000
    )
    or exists (
      select 1 from jsonb_array_elements(p_channel_rows) input
      group by lower(btrim(input->>'channel_code')) having count(*) > 1
    ) then raise exception 'invalid_kiosk_report_channel_rows' using errcode = '22023'; end if;

  if exists (
    select 1 from jsonb_array_elements(p_inventory_rows) input
    join public.kiosk_report_products product on product.code = input->>'product_code'
    where not product.sale_allowed and (input->>'sold_quantity')::numeric > 0
  ) then raise exception 'ingredient_retail_sale_forbidden' using errcode = '22023'; end if;

  select coalesce((input->>'sold_quantity')::numeric, 0) into v_breadstick_sold
  from jsonb_array_elements(p_inventory_rows) input
  where input->>'product_code' = 'banh_mi_que';
  v_breadstick_sold := coalesce(v_breadstick_sold, 0);

  v_before := public.get_kiosk_point_report_detail(p_report_id);
  perform set_config('app.kiosk_report_authorized_edit', 'on', true);

  update public.kiosk_daily_reports
  set notes = nullif(btrim(coalesce(p_report_notes, '')), '')
  where id = p_report_id;

  update public.kiosk_daily_report_inventory_rows target
  set opening_quantity = (input.row_data->>'opening_quantity')::numeric,
      received_quantity = (input.row_data->>'received_quantity')::numeric,
      shortage_quantity = (input.row_data->>'shortage_quantity')::numeric,
      transfer_quantity = (input.row_data->>'transfer_quantity')::numeric,
      waste_quantity = (input.row_data->>'waste_quantity')::numeric,
      returns_quantity = (input.row_data->>'returns_quantity')::numeric,
      sold_quantity = case when product.sale_allowed then (input.row_data->>'sold_quantity')::numeric else 0 end,
      consumed_quantity = case
        when target.product_code = 'ot' then (input.row_data->>'consumed_quantity')::numeric
        else round(v_breadstick_sold * product.breadstick_consumption_ratio, 3)
      end,
      notes = nullif(btrim(coalesce(input.row_data->>'notes', '')), '')
  from jsonb_array_elements(p_inventory_rows) input(row_data)
  join public.kiosk_report_products product on product.code = input.row_data->>'product_code'
  where target.report_id = p_report_id and target.product_code = input.row_data->>'product_code';

  update public.kiosk_daily_report_channel_rows target
  set quantity = (input.row_data->>'quantity')::numeric,
      amount_vnd = case
        when target.channel_code = 'khach_le' then round((input.row_data->>'quantity')::numeric * 12000)
        else (input.row_data->>'amount_vnd')::numeric
      end,
      notes = nullif(btrim(coalesce(input.row_data->>'notes', '')), '')
  from jsonb_array_elements(p_channel_rows) input(row_data)
  where target.report_id = p_report_id
    and target.channel_code = lower(btrim(input.row_data->>'channel_code'));

  delete from public.kiosk_point_revenue_adjustments where report_id = p_report_id;

  for v_later in
    select later.id from public.kiosk_daily_reports later
    where later.location_id = v_report.location_id and later.report_date > v_report.report_date
    order by later.report_date, later.id
  loop
    update public.kiosk_daily_report_inventory_rows target
    set opening_quantity = greatest(0, source.closing_quantity),
        opening_reconciliation_required = source.closing_quantity < 0
    from public.kiosk_daily_reports later_report
    join public.kiosk_daily_report_inventory_rows source
      on source.report_id = later_report.opening_source_report_id
    where later_report.id = v_later.id
      and target.report_id = later_report.id
      and source.product_code = target.product_code;
    if found then v_cascade_ids := v_cascade_ids || to_jsonb(v_later.id); end if;
  end loop;

  insert into public.kiosk_point_revenue_reviews (
    report_id, review_status, review_note, reviewed_by, reviewed_at,
    created_by, updated_by, created_at, updated_at
  ) values (
    p_report_id, p_review_status, v_review_note,
    case when p_review_status = 'reviewed' then v_actor else null end,
    case when p_review_status = 'reviewed' then now() else null end,
    v_actor, v_actor, now(), now()
  ) on conflict (report_id) do update
  set review_status = excluded.review_status,
      review_note = excluded.review_note,
      reviewed_by = excluded.reviewed_by,
      reviewed_at = excluded.reviewed_at,
      updated_by = excluded.updated_by,
      updated_at = now();

  v_after := public.get_kiosk_point_report_detail(p_report_id)
    || jsonb_build_object('cascade_updated_reports', v_cascade_ids);
  insert into public.kiosk_point_revenue_audit_logs (
    report_id, actor_id, action, before_payload, after_payload, note
  ) values (p_report_id, v_actor, 'edit_report', v_before, v_after, v_reason);

  return jsonb_build_object(
    'report_id', p_report_id,
    'review_status', p_review_status,
    'cascade_updated_reports', v_cascade_ids,
    'updated_at', now()
  );
end;
$$;

revoke all on function public.save_kiosk_point_report_correction(uuid, text, jsonb, jsonb, text, text, text) from public, anon, authenticated;
grant execute on function public.save_kiosk_point_report_correction(uuid, text, jsonb, jsonb, text, text, text) to authenticated;
