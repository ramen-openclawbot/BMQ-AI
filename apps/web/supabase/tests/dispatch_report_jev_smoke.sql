-- Rollback-only smoke for migration 20261103540000_dispatch_report_jev.sql.
--
-- The caller wraps this file in one transaction and rolls it back. This file
-- itself contains no BEGIN/COMMIT/ROLLBACK. It builds only synthetic 2026-11-01
-- photos, exercises save / cross-day rejection / Jev mark / daily report and
-- the 42501 permission gate, then prints SMOKE_OK.

do $$
declare
  v_photo_a uuid;
  v_photo_b uuid;
  v_saved uuid[];
  v_report jsonb;
  v_photo jsonb;
  v_user uuid := '00000000-0000-4000-8000-00000000dead';
  v_log text := '';
begin
  -- Service-role context (the Edge Function writes this way).
  perform set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  perform set_config('request.jwt.claim.role', 'service_role', true);
  perform set_config('role', 'service_role', true);

  v_photo_a := (
    public.dispatch_report_photo_add(
      date '2026-11-01',
      '2026-11-01/smoke-dispatch-jev-a-' || gen_random_uuid()::text || '.jpg',
      12345,
      800,
      600
    )->>'id'
  )::uuid;
  if v_photo_a is null then
    raise exception 'SMOKE FAIL: photo A was not created';
  end if;

  v_photo_b := (
    public.dispatch_report_photo_add(
      date '2026-11-02',
      '2026-11-02/smoke-dispatch-jev-b-' || gen_random_uuid()::text || '.jpg',
      100,
      10,
      10
    )->>'id'
  )::uuid;
  if v_photo_b is null then
    raise exception 'SMOKE FAIL: photo B was not created';
  end if;

  if (
    select saved_at is null and jev_status = 'pending'
    from public.dispatch_report_photos where id = v_photo_a
  ) is not true then
    raise exception 'SMOKE FAIL: new photo should start unsaved/pending';
  end if;

  v_saved := public.dispatch_report_save(date '2026-11-01', array[v_photo_a]);
  if v_saved <> array[v_photo_a] then
    raise exception 'SMOKE FAIL: save returned % instead of the photo id', v_saved;
  end if;

  if (
    select saved_at is not null and jev_status = 'pending'
    from public.dispatch_report_photos where id = v_photo_a
  ) is not true then
    raise exception 'SMOKE FAIL: saved photo must have saved_at and pending Jev';
  end if;

  -- A photo of another day must abort the whole save.
  begin
    perform public.dispatch_report_save(date '2026-11-01', array[v_photo_b]);
    raise exception 'SMOKE FAIL: cross-day save was accepted';
  exception
    when sqlstate '22023' then
      if sqlerrm <> 'invalid_photo' then
        raise exception 'SMOKE FAIL: cross-day save raised %', sqlerrm;
      end if;
  end;

  -- Service-role Jev result writer.
  perform public.dispatch_report_jev_mark(
    v_photo_a,
    'done',
    'phieu_xuat_kho',
    array['PO100SMOKE01', 'PO100SMOKE01'],
    jsonb_build_array(jsonb_build_object('po_number', 'PO100SMOKE01', 'qty', 12)),
    'Phiếu xuất kho · PO100SMOKE01 · SL 12',
    false,
    null,
    'smoke-dispatch-jev-1'
  );

  select photo
  into v_photo
  from jsonb_array_elements(
    public.kfm_daily_delivery_report(date '2026-11-01')->'photos'
  ) as t(photo)
  where (photo->>'id')::uuid = v_photo_a;

  if v_photo is null then
    raise exception 'SMOKE FAIL: saved photo missing from daily report';
  end if;
  if v_photo->>'saved_at' is null
     or v_photo->>'jev_status' is distinct from 'done'
     or v_photo->>'jev_kind' is distinct from 'phieu_xuat_kho'
     or (v_photo->'jev_po_numbers')::text is distinct from '["PO100SMOKE01"]'
     or (v_photo->'jev_quantities')->0->>'qty' is distinct from '12'
     or v_photo->>'jev_summary' is null
     or (v_photo->>'jev_mismatch')::boolean is not false then
    raise exception 'SMOKE FAIL: daily report Jev fields wrong: %', v_photo;
  end if;

  -- A user without the kho edit gate must be refused by the database.
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_user, 'role', 'authenticated')::text,
    true
  );
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('role', 'authenticated', true);

  begin
    perform public.dispatch_report_save(date '2026-11-01', array[v_photo_a]);
    raise exception 'SMOKE FAIL: non-kho user was allowed to save';
  exception
    when sqlstate '42501' then
      null;
  end;

  v_log := 'saved+cross-day+jev+gate ok';
  raise notice '%', v_log;
end $$;

select 'SMOKE_OK' as result;
