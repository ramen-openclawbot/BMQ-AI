-- Rollback-only smoke for migration 20261101440000_tan_tao_pate_recipe_production.sql.
--
-- Run after the migration is applied, as the database owner/Maestro:
--   supabase db query --linked -f scripts/smoke_tan_tao_pate.sql
-- (from apps/web).
--
-- The file opens one transaction, impersonates the real owner through
-- request.jwt.claims, then:
--   (a) answers every seeded recipe line (grams, or not_used when the seed has
--       no item), sets the batch to 10 kg and checks the recipe is complete
--       and the owner mission is done;
--   (b) records 2 batches + 10 hộp 500g + 5 hộp 200g on 2026-10-18 and checks
--       every ingredient balance falls by grams × 2, hộp / nhãn fall by 10 / 5
--       and PATE-500G / PATE-200G on-hand rises by 10 / 5;
--   (c) replays the same request id and checks no movement or slip is written;
--   (d) tries 2026-10-16 and checks it raises before_cutover.
--
-- It raises notice 'SMOKE_RESULT PASS' and rolls back; nothing is committed.

begin;

do $smoke$
declare
  v_owner uuid;
  v_recipe public.tan_tao_recipes%rowtype;
  v_line public.tan_tao_recipe_lines%rowtype;
  v_item public.kitchen_inventory_items%rowtype;
  v_suffix text := lower(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10));
  v_new_item uuid;
  v_pack uuid;
  v_label uuid;
  v_pate numeric;
  v_factor numeric;
  v_eval jsonb;
  v_result jsonb;
  v_replay jsonb;
  v_error text;
  v_expected numeric;
  v_before numeric;
  v_after numeric;
  v_before_count bigint;
  v_slip_count bigint;
  v_warehouse_count bigint;
  v_request uuid := gen_random_uuid();
  v_sku_before_500 numeric;
  v_sku_before_200 numeric;
  v_sku_after_500 numeric;
  v_sku_after_200 numeric;
  v_packs jsonb := '[{"sku_code":"PATE-500G","quantity":10},{"sku_code":"PATE-200G","quantity":5}]'::jsonb;
begin
  select ur.user_id into v_owner
  from public.user_roles ur
  where ur.role::text = 'owner'
  order by ur.created_at, ur.user_id
  limit 1;
  if v_owner is null then
    raise exception 'SMOKE_RESULT FAIL: no owner role';
  end if;

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text,
    true
  );
  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  perform set_config('request.jwt.claim.role', 'authenticated', true);

  select * into v_recipe
  from public.tan_tao_recipes r
  where r.code = 'pate-heo';
  if not found then
    raise exception 'SMOKE_RESULT FAIL: pate-heo recipe was not seeded';
  end if;

  -- -------------------------------------------------------------------------
  -- (a) Answer every seeded line.
  -- -------------------------------------------------------------------------
  for v_line in
    select * from public.tan_tao_recipe_lines l
    where l.recipe_id = v_recipe.id and l.line_kind = 'ingredient'
    order by l.sort_order, l.id
  loop
    if v_line.kitchen_inventory_item_id is null then
      perform public.answer_tan_tao_recipe_line(
        p_line_id => v_line.id,
        p_not_used => true,
        p_request_id => gen_random_uuid()
      );
    else
      select * into v_item
      from public.kitchen_inventory_items kii
      where kii.id = v_line.kitchen_inventory_item_id
        and kii.active = true
        and kii.merged_into_id is null;

      if not found then
        v_new_item := null;
      else
        v_factor := public.stock_unit_line_factor('g', v_item.unit);
        v_new_item := case when v_factor is null then null else v_item.id end;
      end if;

      if v_new_item is null then
        insert into public.kitchen_inventory_items (
          item_code, normalized_key, item_type, name, unit, standard_unit_cost, active
        ) values (
          'SMOKE-PATE-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)),
          'smoke-pate:' || v_suffix || ':' || replace(gen_random_uuid()::text, '-', ''),
          'ingredient', 'Smoke pate ' || v_line.label, 'g', 0, true
        ) returning id into v_new_item;
      end if;

      perform public.answer_tan_tao_recipe_line(
        p_line_id => v_line.id,
        p_item_id => v_new_item,
        p_grams => 100,
        p_request_id => gen_random_uuid()
      );
    end if;
  end loop;

  for v_line in
    select * from public.tan_tao_recipe_lines l
    where l.recipe_id = v_recipe.id and l.line_kind = 'pack'
    order by l.sort_order, l.id
  loop
    v_pack := null;
    select kii.id into v_pack
    from public.kitchen_inventory_items kii
    where kii.id = v_line.pack_item_id
      and kii.active = true
      and kii.merged_into_id is null;
    if v_pack is null then
      insert into public.kitchen_inventory_items (
        item_code, normalized_key, item_type, name, unit, standard_unit_cost, active
      ) values (
        'SMOKE-PATE-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)),
        'smoke-pate:' || v_suffix || ':' || replace(gen_random_uuid()::text, '-', ''),
        'tool_supply', 'Smoke pate hộp ' || v_line.label, 'hộp', 0, true
      ) returning id into v_pack;
    end if;

    v_label := null;
    select kii.id into v_label
    from public.kitchen_inventory_items kii
    where kii.id = v_line.label_item_id
      and kii.active = true
      and kii.merged_into_id is null;
    if v_label is null then
      insert into public.kitchen_inventory_items (
        item_code, normalized_key, item_type, name, unit, standard_unit_cost, active
      ) values (
        'SMOKE-PATE-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12)),
        'smoke-pate:' || v_suffix || ':' || replace(gen_random_uuid()::text, '-', ''),
        'tool_supply', 'Smoke pate nhãn ' || v_line.label, 'tờ', 0, true
      ) returning id into v_label;
    end if;

    v_pate := coalesce(
      v_line.pate_grams_per_pack,
      case when upper(v_line.sku_code) = 'PATE-500G' then 500 else 200 end
    );

    perform public.answer_tan_tao_recipe_line(
      p_line_id => v_line.id,
      p_pack_item_id => v_pack,
      p_label_item_id => v_label,
      p_pate_grams => v_pate,
      p_request_id => gen_random_uuid()
    );
  end loop;

  perform public.set_tan_tao_recipe_batch(
    p_code => 'pate-heo',
    p_batch_output_kg => 10,
    p_request_id => gen_random_uuid()
  );

  select * into v_recipe from public.tan_tao_recipes r where r.code = 'pate-heo';
  if v_recipe.status <> 'complete' then
    raise exception 'SMOKE_RESULT FAIL: recipe status is %, expected complete', v_recipe.status;
  end if;

  select public.mission_evaluate(m.id) into v_eval
  from public.missions m
  where m.code = 'wh-tan-tao-pate-recipe';
  if v_eval is null or coalesce((v_eval ->> 'done')::boolean, false) is not true then
    raise exception 'SMOKE_RESULT FAIL: pate recipe mission is not done: %', v_eval;
  end if;

  -- -------------------------------------------------------------------------
  -- (b) Record 2 batches + 10 hộp 500g + 5 hộp 200g on 2026-10-18.
  -- -------------------------------------------------------------------------
  create temp table smoke_pate_before (
    item_id uuid primary key,
    qty numeric not null
  ) on commit drop;

  insert into smoke_pate_before (item_id, qty)
  select ids.id,
         coalesce(sum(case m.movement_type
                        when 'receipt' then m.quantity
                        when 'opening' then m.quantity
                        when 'production_usage' then -m.quantity
                        when 'adjustment' then m.quantity
                        when 'transfer_out' then -m.quantity
                        else 0 end), 0)
  from (
    select l.kitchen_inventory_item_id as id
    from public.tan_tao_recipe_lines l
    where l.recipe_id = v_recipe.id and l.kitchen_inventory_item_id is not null
    union
    select l.pack_item_id
    from public.tan_tao_recipe_lines l
    where l.recipe_id = v_recipe.id and l.pack_item_id is not null
    union
    select l.label_item_id
    from public.tan_tao_recipe_lines l
    where l.recipe_id = v_recipe.id and l.label_item_id is not null
  ) ids
  left join public.tan_tao_material_movements m
    on m.kitchen_inventory_item_id = ids.id
  group by ids.id;

  create temp table smoke_pate_expected (
    item_id uuid primary key,
    expected numeric not null
  ) on commit drop;

  insert into smoke_pate_expected (item_id, expected)
  select l.kitchen_inventory_item_id,
         sum(round(l.grams_per_batch * 2
                   * public.stock_unit_line_factor('g', kii.unit), 3))
  from public.tan_tao_recipe_lines l
  join public.kitchen_inventory_items kii on kii.id = l.kitchen_inventory_item_id
  where l.recipe_id = v_recipe.id
    and l.line_kind = 'ingredient'
    and l.status = 'answered'
  group by l.kitchen_inventory_item_id;

  insert into smoke_pate_expected (item_id, expected)
  select item_id, sum(expected)
  from (
    select l.pack_item_id as item_id,
           case when upper(l.sku_code) = 'PATE-500G' then 10 else 5 end as expected
    from public.tan_tao_recipe_lines l
    where l.recipe_id = v_recipe.id
      and l.line_kind = 'pack'
      and upper(l.sku_code) in ('PATE-500G', 'PATE-200G')
      and l.pack_item_id is not null
    union all
    select l.label_item_id,
           case when upper(l.sku_code) = 'PATE-500G' then 10 else 5 end
    from public.tan_tao_recipe_lines l
    where l.recipe_id = v_recipe.id
      and l.line_kind = 'pack'
      and upper(l.sku_code) in ('PATE-500G', 'PATE-200G')
      and l.label_item_id is not null
  ) x
  group by item_id
  on conflict (item_id) do update
    set expected = smoke_pate_expected.expected + excluded.expected;

  select coalesce(sum(m.quantity), 0) into v_sku_before_500
  from public.tan_tao_warehouse_movements m
  join public.product_skus ps on ps.id = m.sku_id
  where upper(ps.sku_code) = 'PATE-500G';

  select coalesce(sum(m.quantity), 0) into v_sku_before_200
  from public.tan_tao_warehouse_movements m
  join public.product_skus ps on ps.id = m.sku_id
  where upper(ps.sku_code) = 'PATE-200G';

  v_result := public.record_tan_tao_pate_production(
    p_date => '2026-10-18',
    p_batches => 2,
    p_packs => v_packs,
    p_note => 'Smoke pate Tân Tạo',
    p_request_id => v_request
  );

  if coalesce(v_result ->> 'status', '') <> 'recorded' then
    raise exception 'SMOKE_RESULT FAIL: production status is %', v_result ->> 'status';
  end if;
  if coalesce((v_result ->> 'movement_count')::integer, 0) <= 0 then
    raise exception 'SMOKE_RESULT FAIL: production wrote no material usage';
  end if;

  for v_item in
    select kii.*
    from public.kitchen_inventory_items kii
    join smoke_pate_expected e on e.item_id = kii.id
  loop
    select qty into v_before from smoke_pate_before where item_id = v_item.id;
    select coalesce(sum(case m.movement_type
                          when 'receipt' then m.quantity
                          when 'opening' then m.quantity
                          when 'production_usage' then -m.quantity
                          when 'adjustment' then m.quantity
                          when 'transfer_out' then -m.quantity
                          else 0 end), 0)
      into v_after
    from public.tan_tao_material_movements m
    where m.kitchen_inventory_item_id = v_item.id;

    select expected into v_expected from smoke_pate_expected where item_id = v_item.id;
    if round(coalesce(v_before, 0) - v_after, 3) <> v_expected then
      raise exception 'SMOKE_RESULT FAIL: % balance fell by %, expected %',
        v_item.name, round(coalesce(v_before, 0) - v_after, 3), v_expected;
    end if;
  end loop;

  select coalesce(sum(m.quantity), 0) into v_sku_after_500
  from public.tan_tao_warehouse_movements m
  join public.product_skus ps on ps.id = m.sku_id
  where upper(ps.sku_code) = 'PATE-500G';
  if v_sku_after_500 - v_sku_before_500 <> 10 then
    raise exception 'SMOKE_RESULT FAIL: PATE-500G on-hand rose by %, expected 10',
      v_sku_after_500 - v_sku_before_500;
  end if;

  select coalesce(sum(m.quantity), 0) into v_sku_after_200
  from public.tan_tao_warehouse_movements m
  join public.product_skus ps on ps.id = m.sku_id
  where upper(ps.sku_code) = 'PATE-200G';
  if v_sku_after_200 - v_sku_before_200 <> 5 then
    raise exception 'SMOKE_RESULT FAIL: PATE-200G on-hand rose by %, expected 5',
      v_sku_after_200 - v_sku_before_200;
  end if;

  -- -------------------------------------------------------------------------
  -- (c) Replay the same request id: no movement, no slip, stored result.
  -- -------------------------------------------------------------------------
  select count(*) into v_before_count from public.tan_tao_material_movements;
  select count(*) into v_slip_count from public.tan_tao_production_slips;
  select count(*) into v_warehouse_count from public.tan_tao_warehouse_movements;

  v_replay := public.record_tan_tao_pate_production(
    p_date => '2026-10-18',
    p_batches => 2,
    p_packs => v_packs,
    p_note => 'Smoke pate Tân Tạo',
    p_request_id => v_request
  );

  if coalesce((v_replay ->> 'replay')::boolean, false) is not true then
    raise exception 'SMOKE_RESULT FAIL: replay did not return the stored result';
  end if;
  if (select count(*) from public.tan_tao_material_movements) <> v_before_count then
    raise exception 'SMOKE_RESULT FAIL: replay wrote a material movement';
  end if;
  if (select count(*) from public.tan_tao_production_slips) <> v_slip_count then
    raise exception 'SMOKE_RESULT FAIL: replay wrote a production slip';
  end if;
  if (select count(*) from public.tan_tao_warehouse_movements) <> v_warehouse_count then
    raise exception 'SMOKE_RESULT FAIL: replay wrote a warehouse movement';
  end if;

  -- -------------------------------------------------------------------------
  -- (d) A production date on/before the Tân Tạo cutover is refused.
  -- -------------------------------------------------------------------------
  select count(*) into v_slip_count from public.tan_tao_production_slips;
  v_error := null;
  begin
    perform public.record_tan_tao_pate_production(
      p_date => '2026-10-16',
      p_batches => 1,
      p_packs => '[]'::jsonb,
      p_note => 'Smoke before cutover',
      p_request_id => gen_random_uuid()
    );
  exception when others then
    v_error := sqlerrm;
  end;

  if v_error is null then
    raise exception 'SMOKE_RESULT FAIL: 2026-10-16 was not refused';
  end if;
  if v_error not like '%before_cutover%' then
    raise exception 'SMOKE_RESULT FAIL: expected before_cutover, got %', v_error;
  end if;
  if (select count(*) from public.tan_tao_production_slips) <> v_slip_count then
    raise exception 'SMOKE_RESULT FAIL: before_cutover wrote a production slip';
  end if;

  raise notice 'SMOKE_RESULT PASS';
end;
$smoke$;

rollback;
