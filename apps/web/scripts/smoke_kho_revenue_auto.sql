-- Smoke test for kho_revenue_day + the automatic backflush/learner.
-- The Maestro prepends 20261103240000_kho_revenue_auto.sql, then runs this whole
-- single transaction and rolls it back.  It must never run against live by itself.
begin;

select set_config('request.jwt.claim.sub', '27dbc34e-75ee-4973-8f9a-d1b125c90483', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', '27dbc34e-75ee-4973-8f9a-d1b125c90483',
    'role', 'authenticated'
  )::text,
  true
);

do $$
declare
  v_day jsonb;
  v_channel jsonb;
  v_item_id uuid;
  v_peerless uuid;
  v_count integer;
  v_hold record;
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_run jsonb;
  v_suffix text;
begin
  -- The nightly runs the learner first and then posts the backflush.  Everything
  -- below is rolled back with this transaction.
  v_run := public.run_cogs_backflush_nightly();
  -- Rows written by this run end with its run id; older rows (posted before a
  -- hold existed, or the 23/10 reversals) are not this run's doing.
  v_suffix := ':' || (v_run ->> 'run_id');

  -- The backflush changes the request role claim; read as the owner again.
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', '27dbc34e-75ee-4973-8f9a-d1b125c90483',
      'role', 'authenticated'
    )::text,
    true
  );

  v_day := public.kho_revenue_day('2026-10-28');

  if v_day is null then
    raise exception 'kho_revenue_day returned null';
  end if;

  select count(*) into v_count
  from jsonb_array_elements(v_day -> 'channels');
  -- Revenue keeps being approved after the day: 3 channels when the demo was cut, more later.
  if v_count < 3 then
    raise exception 'expected at least 3 channels on 2026-10-28, got %', v_count;
  end if;

  select c into v_channel
  from jsonb_array_elements(v_day -> 'channels') c
  where c ->> 'channel' = 'ĐẠI LÝ';
  if v_channel is null or (v_channel ->> 'qty')::numeric is distinct from 2200 then
    raise exception 'expected Đại lý qty 2200, got %', v_channel;
  end if;

  select (e ->> 'id')::uuid into v_item_id
  from jsonb_array_elements(v_day -> 'items') e
  where e ->> 'name' like 'Nhôm lá GF004%'
  limit 1;
  if v_item_id is null then
    raise exception 'Nhôm lá GF004 is missing from the day payload';
  end if;

  if not exists (
    select 1
    from public.cogs_backflush_warnings w
    where w.location = 'tan_tao'
      and w.kitchen_inventory_item_id = v_item_id
      and w.movement_date = '2026-10-28'
      and w.kind = 'unit'
  ) then
    raise exception 'Nhôm lá GF004 has no unit warning after the nightly run';
  end if;

  if not exists (
    select 1
    from jsonb_array_elements(v_day -> 'warnings') w
    where (w ->> 'item_id')::uuid = v_item_id
      and w ->> 'kind' = 'unit'
  ) then
    raise exception 'kho_revenue_day does not expose the Nhôm lá unit warning';
  end if;

  if exists (
    select 1
    from public.q7_inventory_movements m
    where m.kitchen_inventory_item_id = v_item_id
      and m.movement_date = '2026-10-28'
      and m.source = 'revenue_cogs'
          and right(m.source_ref_key, length(v_suffix)) = v_suffix
  ) then
    raise exception 'Nhôm lá GF004 was posted at Q7 despite the unit warning';
  end if;
  if exists (
    select 1
    from public.tan_tao_material_movements m
    where m.kitchen_inventory_item_id = v_item_id
      and m.movement_date = '2026-10-28'
      and m.source = 'revenue_cogs'
          and right(m.source_ref_key, length(v_suffix)) = v_suffix
  ) then
    raise exception 'Nhôm lá GF004 was posted at Tân Tạo despite the unit warning';
  end if;

  for v_hold in
    select h.location, h.kitchen_inventory_item_id, h.movement_date
    from public.cogs_backflush_holds h
    where h.status = 'rejected'
      and h.movement_date between v_today - 35 and v_today + 14
  loop
    if v_hold.location = 'q7' then
      if exists (
        select 1
        from public.q7_inventory_movements m
        where m.kitchen_inventory_item_id = v_hold.kitchen_inventory_item_id
          and m.movement_date = v_hold.movement_date
          and m.source = 'revenue_cogs'
          and right(m.source_ref_key, length(v_suffix)) = v_suffix
      ) then
        raise exception 'a rejected hold was posted at Q7: %', v_hold.location || '/' || v_hold.kitchen_inventory_item_id::text || '/' || v_hold.movement_date::text;
      end if;
    elsif v_hold.location = 'tan_tao' then
      if exists (
        select 1
        from public.tan_tao_material_movements m
        where m.kitchen_inventory_item_id = v_hold.kitchen_inventory_item_id
          and m.movement_date = v_hold.movement_date
          and m.source = 'revenue_cogs'
          and right(m.source_ref_key, length(v_suffix)) = v_suffix
      ) then
        raise exception 'a rejected hold was posted at Tân Tạo: %', v_hold.location || '/' || v_hold.kitchen_inventory_item_id::text || '/' || v_hold.movement_date::text;
      end if;
    end if;
  end loop;

  select (e ->> 'id')::uuid into v_peerless
  from jsonb_array_elements(v_day -> 'items') e
  where e ->> 'name' like 'Bơ Peerless%'
  limit 1;
  if v_peerless is null then
    raise exception 'Bơ Peerless is missing from the day payload';
  end if;

  perform public.cogs_learn_usage_factors();

  if exists (
    select 1
    from public.cogs_usage_factors f
    where f.location = 'q7'
      and f.kitchen_inventory_item_id = v_peerless
      and f.source = 'learned'
      and f.effective_from = '2026-10-28'
  ) then
    raise exception 'Bơ Peerless Q7 (165 percent shrink) received a learned usage factor';
  end if;

  if not exists (
    select 1
    from public.cogs_backflush_warnings w
    where w.location = 'q7'
      and w.kitchen_inventory_item_id = v_peerless
      and w.kind = 'shrink'
      and w.movement_date is null
      and w.shrink_rate > 1.5
  ) then
    raise exception 'Bơ Peerless Q7 has no shrink warning';
  end if;

  raise notice 'PASS: kho revenue auto smoke (3 channels, Đại lý 2200, unit block, learner shrink)';
end;
$$;

rollback;
