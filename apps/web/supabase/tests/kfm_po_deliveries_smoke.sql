-- Rollback-only smoke checks for 20261103520000_kfm_po_deliveries.sql.
--
-- The acceptance command wraps this file and the migration in BEGIN ... ROLLBACK,
-- so this file must not open or close the transaction itself.
--   (echo 'begin;'; cat migration test; echo 'rollback;') | psql
--
-- It checks the accounting seed totals, the default-100% daily row, the KFM
-- write gate and bounds, the unprivileged denial and the photo path lifecycle.

select set_config('request.jwt.claims', '{"role":"service_role"}', true);
select set_config('request.jwt.claim.role', 'service_role', true);

do $$
declare
  v_vs jsonb;
  v_report jsonb;
  v_row jsonb;
  v_photo jsonb;
  v_po_qty numeric;
  v_po_total numeric;
  v_delivered_total numeric;
  v_shortfall_total numeric;
  v_count integer;
  v_ok boolean;
  v_state text;
  v_message text;
  v_bad_path text;
  v_good_path text;
  v_photo_id uuid;
begin
  -- (1) The nine accounting POs are present with exactly the closing totals.
  v_vs := public.kfm_delivery_vs_po('2026-10-01', '2026-10-31');

  select
    count(*),
    coalesce(sum((r ->> 'po_qty')::numeric), 0),
    coalesce(sum((r ->> 'delivered_qty')::numeric), 0),
    coalesce(sum((r ->> 'shortfall')::numeric), 0)
  into v_count, v_po_total, v_delivered_total, v_shortfall_total
  from jsonb_array_elements(coalesce(v_vs -> 'rows', '[]'::jsonb)) r
  where r ->> 'po_number' in (
    'PO1002684496', 'PO1002682291', 'PO1002674500', 'PO1002673250',
    'PO1002670572', 'PO1002669558', 'PO1002668629', 'PO1002666220',
    'PO1002662319'
  );

  if v_count <> 9 then
    raise exception 'SMOKE_RESULT FAIL seed_row_count expected 9 got %', v_count;
  end if;
  if v_po_total <> 7225
     or v_delivered_total <> 6633
     or v_shortfall_total <> -592 then
    raise exception 'SMOKE_RESULT FAIL seed_totals po=% delivered=% shortfall=%',
      v_po_total, v_delivered_total, v_shortfall_total;
  end if;
  -- (1b) confirmed_count counts recorded rows, not defaults.
  if coalesce((v_vs -> 'totals' ->> 'confirmed_count')::integer, -1) < 9
     or (v_vs -> 'totals' ->> 'confirmed_count')::integer >= (v_vs -> 'totals' ->> 'po_count')::integer then
    raise exception 'SMOKE_RESULT FAIL confirmed_count %', v_vs -> 'totals';
  end if;

  -- (2) An untouched PO on 31/10 defaults to 100% delivered.
  v_report := public.kfm_daily_delivery_report('2026-10-31');
  select value into v_row
  from jsonb_array_elements(coalesce(v_report -> 'pos', '[]'::jsonb)) value
  where value ->> 'po_number' = 'PO1002692065'
  limit 1;

  if v_row is null then
    raise exception 'SMOKE_RESULT FAIL daily_po_missing %', v_report;
  end if;
  if coalesce((v_row ->> 'is_default')::boolean, false) is not true then
    raise exception 'SMOKE_RESULT FAIL daily_default_flag %', v_row;
  end if;
  if (v_row ->> 'delivered_qty')::numeric <> (v_row ->> 'po_qty')::numeric then
    raise exception 'SMOKE_RESULT FAIL daily_default_qty %', v_row;
  end if;

  -- (3) The warehouse can change it, with a note, and both reports see it.
  v_row := public.kfm_set_po_delivered_qty('PO1002692065', 600, 'thiếu');
  if (v_row ->> 'delivered_qty')::numeric <> 600
     or v_row ->> 'source' <> 'kho'
     or v_row ->> 'note' <> 'thiếu' then
    raise exception 'SMOKE_RESULT FAIL set_row %', v_row;
  end if;
  v_po_qty := (v_row ->> 'po_qty')::numeric;

  v_report := public.kfm_daily_delivery_report('2026-10-31');
  select value into v_row
  from jsonb_array_elements(coalesce(v_report -> 'pos', '[]'::jsonb)) value
  where value ->> 'po_number' = 'PO1002692065'
  limit 1;

  if v_row is null
     or (v_row ->> 'delivered_qty')::numeric <> 600
     or coalesce((v_row ->> 'is_default')::boolean, true) is not false
     or v_row ->> 'source' <> 'kho' then
    raise exception 'SMOKE_RESULT FAIL set_readback %', v_row;
  end if;

  -- (4) Negative and more than 2x PO quantity are rejected.
  v_state := null;
  v_message := null;
  begin
    perform public.kfm_set_po_delivered_qty('PO1002692065', -1, null);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
  end;
  if v_state is distinct from '22023'
     or v_message is distinct from 'invalid_delivered_qty' then
    raise exception 'SMOKE_RESULT FAIL negative_qty state=% message=%',
      v_state, v_message;
  end if;

  v_state := null;
  v_message := null;
  begin
    perform public.kfm_set_po_delivered_qty('PO1002692065', v_po_qty * 2 + 1, null);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
  end;
  if v_state is distinct from '22023'
     or v_message is distinct from 'invalid_delivered_qty' then
    raise exception 'SMOKE_RESULT FAIL over_qty state=% message=%',
      v_state, v_message;
  end if;

  -- (5) An unknown PO is not found.
  v_state := null;
  v_message := null;
  begin
    perform public.kfm_set_po_delivered_qty('PO9999999999', 0, null);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
  end;
  if v_state is distinct from 'P0002'
     or v_message is distinct from 'po_not_found' then
    raise exception 'SMOKE_RESULT FAIL po_not_found state=% message=%',
      v_state, v_message;
  end if;

  -- (6) A non-owner authenticated user without inventory edit is denied.
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object(
      'role', 'authenticated',
      'sub', gen_random_uuid()::text
    )::text,
    true
  );
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  v_state := null;
  v_message := null;
  begin
    perform public.kfm_set_po_delivered_qty('PO1002692065', 600, null);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
  end;
  if v_state is distinct from '42501'
     or v_message is distinct from 'insufficient_privilege' then
    raise exception 'SMOKE_RESULT FAIL write_permission state=% message=%',
      v_state, v_message;
  end if;

  perform set_config('request.jwt.claims', '{"role":"service_role"}', true);
  perform set_config('request.jwt.claim.role', 'service_role', true);

  -- (7) Photo metadata accepts only the same-day folder and remove deletes it.
  v_bad_path := '2026-10-30/' || gen_random_uuid()::text || '.jpg';
  v_state := null;
  v_message := null;
  begin
    perform public.dispatch_report_photo_add('2026-10-31', v_bad_path);
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_message = message_text;
  end;
  if v_state is distinct from '22023'
     or v_message is distinct from 'invalid_storage_path' then
    raise exception 'SMOKE_RESULT FAIL photo_bad_path state=% message=%',
      v_state, v_message;
  end if;

  v_good_path := '2026-10-31/' || gen_random_uuid()::text || '.jpg';
  v_photo := public.dispatch_report_photo_add('2026-10-31', v_good_path);
  v_photo_id := (v_photo ->> 'id')::uuid;
  if v_photo_id is null
     or v_photo ->> 'storage_path' <> v_good_path then
    raise exception 'SMOKE_RESULT FAIL photo_add %', v_photo;
  end if;

  v_report := public.kfm_daily_delivery_report('2026-10-31');
  if not exists (
    select 1
    from jsonb_array_elements(coalesce(v_report -> 'photos', '[]'::jsonb)) p
    where (p ->> 'id')::uuid = v_photo_id
      and p ->> 'storage_path' = v_good_path
  ) then
    raise exception 'SMOKE_RESULT FAIL photo_report %', v_report -> 'photos';
  end if;

  v_photo := public.dispatch_report_photo_remove(v_photo_id);
  if (v_photo ->> 'id')::uuid <> v_photo_id then
    raise exception 'SMOKE_RESULT FAIL photo_remove %', v_photo;
  end if;

  select count(*) into v_count
  from public.dispatch_report_photos p
  where p.id = v_photo_id;
  if v_count <> 0 then
    raise exception 'SMOKE_RESULT FAIL photo_remove_leftover';
  end if;
end;
$$;

select 'SMOKE_OK';
