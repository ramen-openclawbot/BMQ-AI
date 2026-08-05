-- Allow point-of-sale staff to enter actual daily chili usage.
-- Pate and every other recipe-driven ingredient remain server-calculated.

create or replace function public.save_kiosk_daily_report_atomic(
  p_location_id uuid,
  p_staff_id uuid,
  p_report_date date,
  p_status text,
  p_notes text,
  p_staff_name_snapshot text,
  p_staff_phone_normalized_snapshot text,
  p_location_code_snapshot text,
  p_location_name_snapshot text,
  p_location_address_snapshot text,
  p_inventory_rows jsonb,
  p_channel_rows jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_report_id uuid;
  v_existing_status text;
  v_report public.kiosk_daily_reports%rowtype;
  v_breadstick_sold numeric(12,3) := 0;
  v_previous_report_id uuid;
  v_previous_report_date date;
  v_existing_opening_source_report_id uuid;
  v_existing_openings jsonb := '{}'::jsonb;
  v_is_new_report boolean := false;
  v_use_previous_closing boolean := false;
begin
  if p_status not in ('draft', 'submitted') then
    raise exception 'invalid_report_status';
  end if;

  if not exists (
    select 1
    from public.kiosk_report_staff staff
    join public.kiosk_report_locations location on location.id = staff.location_id
    where staff.id = p_staff_id
      and staff.location_id = p_location_id
      and staff.active = true
      and location.active = true
  ) then
    raise exception 'report_assignment_invalid';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_inventory_rows, '[]'::jsonb)) row_data
    where nullif(trim(coalesce(row_data->>'product_code', '')), '') is not null
    group by row_data->>'product_code'
    having count(*) > 1
  ) then
    raise exception 'duplicate_inventory_product';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_inventory_rows, '[]'::jsonb)) row_data
    join public.kiosk_report_products product
      on product.code = row_data->>'product_code'
    where product.sale_allowed = false
      and greatest(0, coalesce(nullif(row_data->>'sold_quantity', '')::numeric, 0)) > 0
  ) then
    raise exception 'ingredient_retail_sale_forbidden';
  end if;

  select greatest(
    0,
    coalesce(max(nullif(row_data->>'sold_quantity', '')::numeric), 0)
  )
  into v_breadstick_sold
  from jsonb_array_elements(coalesce(p_inventory_rows, '[]'::jsonb)) row_data
  where row_data->>'product_code' = 'banh_mi_que';

  perform pg_advisory_xact_lock(hashtextextended(p_location_id::text, 0));

  select id, status, opening_source_report_id
    into v_report_id, v_existing_status, v_existing_opening_source_report_id
  from public.kiosk_daily_reports
  where location_id = p_location_id
    and report_date = p_report_date
  for update;

  if v_existing_status = 'submitted' then
    raise exception 'submitted_report_immutable';
  end if;

  if p_status = 'submitted' and exists (
    select 1
    from public.kiosk_daily_reports prior_report
    where prior_report.location_id = p_location_id
      and prior_report.report_date < p_report_date
      and prior_report.status = 'draft'
  ) then
    raise exception 'prior_draft_report_pending';
  end if;

  if p_status = 'submitted' and exists (
    select 1
    from public.kiosk_daily_reports later_report
    where later_report.location_id = p_location_id
      and later_report.report_date > p_report_date
      and later_report.status = 'submitted'
  ) then
    raise exception 'later_submitted_report_exists';
  end if;

  select previous_report.id, previous_report.report_date
    into v_previous_report_id, v_previous_report_date
  from public.kiosk_daily_reports previous_report
  where previous_report.status = 'submitted'
    and previous_report.location_id = p_location_id
    and previous_report.report_date < p_report_date
  order by previous_report.report_date desc
  limit 1;

  if v_report_id is null then
    v_is_new_report := true;
  else
    select coalesce(jsonb_object_agg(inventory.product_code, inventory.opening_quantity), '{}'::jsonb)
      into v_existing_openings
    from public.kiosk_daily_report_inventory_rows inventory
    where inventory.report_id = v_report_id;
  end if;

  v_use_previous_closing := v_previous_report_id is not null
    and (v_is_new_report or v_existing_opening_source_report_id is distinct from v_previous_report_id);

  if v_report_id is null then
    insert into public.kiosk_daily_reports (
      location_id,
      staff_id,
      report_date,
      opening_source_report_id,
      opening_source_report_date,
      status,
      notes,
      staff_name_snapshot,
      staff_phone_normalized_snapshot,
      location_code_snapshot,
      location_name_snapshot,
      location_address_snapshot,
      created_by_staff_id,
      updated_by_staff_id
    )
    values (
      p_location_id,
      p_staff_id,
      p_report_date,
      v_previous_report_id,
      v_previous_report_date,
      'draft',
      nullif(trim(coalesce(p_notes, '')), ''),
      p_staff_name_snapshot,
      p_staff_phone_normalized_snapshot,
      p_location_code_snapshot,
      p_location_name_snapshot,
      p_location_address_snapshot,
      p_staff_id,
      p_staff_id
    )
    returning id into v_report_id;
  else
    update public.kiosk_daily_reports
    set staff_id = p_staff_id,
        opening_source_report_id = v_previous_report_id,
        opening_source_report_date = v_previous_report_date,
        notes = nullif(trim(coalesce(p_notes, '')), ''),
        staff_name_snapshot = p_staff_name_snapshot,
        staff_phone_normalized_snapshot = p_staff_phone_normalized_snapshot,
        location_code_snapshot = p_location_code_snapshot,
        location_name_snapshot = p_location_name_snapshot,
        location_address_snapshot = p_location_address_snapshot,
        updated_by_staff_id = p_staff_id,
        submitted_at = null
    where id = v_report_id;
  end if;

  delete from public.kiosk_daily_report_inventory_rows where report_id = v_report_id;
  delete from public.kiosk_daily_report_channel_rows where report_id = v_report_id;

  insert into public.kiosk_daily_report_inventory_rows (
    report_id,
    product_code,
    product_name_snapshot,
    opening_quantity,
    received_quantity,
    shortage_quantity,
    transfer_quantity,
    waste_quantity,
    returns_quantity,
    sold_quantity,
    consumed_quantity,
    notes
  )
  select
    v_report_id,
    product.code,
    product.product_name,
    case
      when v_use_previous_closing then greatest(0, coalesce(
        previous_inventory.closing_quantity,
        nullif(input.row_data->>'opening_quantity', '')::numeric,
        0
      ))
      when not v_is_new_report then greatest(0, coalesce(
        nullif(v_existing_openings ->> product.code, '')::numeric,
        nullif(input.row_data->>'opening_quantity', '')::numeric,
        0
      ))
      else greatest(0, coalesce(nullif(input.row_data->>'opening_quantity', '')::numeric, 0))
    end,
    greatest(0, coalesce(nullif(input.row_data->>'received_quantity', '')::numeric, 0)),
    greatest(0, coalesce(nullif(input.row_data->>'shortage_quantity', '')::numeric, 0)),
    coalesce(nullif(input.row_data->>'transfer_quantity', '')::numeric, 0),
    greatest(0, coalesce(nullif(input.row_data->>'waste_quantity', '')::numeric, 0)),
    greatest(0, coalesce(nullif(input.row_data->>'returns_quantity', '')::numeric, 0)),
    case
      when product.sale_allowed then greatest(0, coalesce(nullif(input.row_data->>'sold_quantity', '')::numeric, 0))
      else 0
    end,
    case
      when product.code = 'ot' then greatest(0, coalesce(nullif(input.row_data->>'consumed_quantity', '')::numeric, 0))
      else round(v_breadstick_sold * product.breadstick_consumption_ratio, 3)
    end,
    nullif(trim(coalesce(input.row_data->>'notes', '')), '')
  from public.kiosk_report_products product
  left join lateral (
    select row_data
    from jsonb_array_elements(coalesce(p_inventory_rows, '[]'::jsonb)) row_data
    where row_data->>'product_code' = product.code
    limit 1
  ) input on true
  left join public.kiosk_daily_report_inventory_rows previous_inventory
    on previous_inventory.report_id = v_previous_report_id
   and previous_inventory.product_code = product.code
  where product.active = true;

  insert into public.kiosk_daily_report_channel_rows (
    report_id,
    channel_code,
    channel_name_snapshot,
    quantity,
    amount_vnd,
    notes
  )
  select
    v_report_id,
    channel.code,
    channel.channel_name,
    greatest(0, coalesce(nullif(input.row_data->>'quantity', '')::numeric, 0)),
    greatest(0, coalesce(nullif(input.row_data->>'amount_vnd', '')::numeric, 0)),
    nullif(trim(coalesce(input.row_data->>'notes', '')), '')
  from public.kiosk_report_channels channel
  left join lateral (
    select row_data
    from jsonb_array_elements(coalesce(p_channel_rows, '[]'::jsonb)) row_data
    where row_data->>'channel_code' = channel.code
    limit 1
  ) input on true
  where channel.active = true;

  if p_status = 'submitted' then
    update public.kiosk_daily_reports
    set status = 'submitted',
        submitted_at = now(),
        updated_by_staff_id = p_staff_id
    where id = v_report_id
      and status = 'draft';
  end if;

  select * into v_report
  from public.kiosk_daily_reports
  where id = v_report_id;

  return jsonb_build_object(
    'report_date', v_report.report_date,
    'status', v_report.status,
    'notes', v_report.notes,
    'submitted_at', v_report.submitted_at,
    'updated_at', v_report.updated_at
  );
end;
$$;