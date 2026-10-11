-- Smoke test for 20261021100000_new_item_suggestions (2026-10-21).
-- Runs entirely inside BEGIN ... ROLLBACK so it never keeps fixtures.
-- Prerequisites (real data only, never created by this script):
--   * migrations 20261016100000 + 20261020100000 + this one applied
--   * at least one public.user_roles row with role 'owner'
--   * confirmed receipt lines in the last 60 days that still have no item
-- Run with:  psql "$DATABASE_URL" -f scripts/smoke_new_item_suggestions.sql
--
-- The grouping itself runs in the edge function; this smoke simulates its result
-- and then exercises the review RPCs on real purchase names (Dairymont / DANPMONT
-- when present).

begin;

select set_config('request.jwt.claim.role', 'service_role', true);

-- (1) how many real names the 60-day scan sees.
select count(*) as unmatched_purchase_names_60d
from public.list_unmatched_purchase_names('q7', 60);

do $smoke$
declare
  v_suffix text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  v_members jsonb;
  v_apply_members jsonb;
  v_cluster text;
  v_cluster_unknown text;
  v_cluster_nonstock text;
  v_suggestion uuid;
  v_suggestion_unknown uuid;
  v_suggestion_nonstock uuid;
  v_owner uuid;
  v_staff uuid;
  v_result jsonb;
  v_item uuid;
  v_before integer;
  v_after integer;
  v_name text := 'Smoke New Item ' || v_suffix;
  v_req uuid := gen_random_uuid();
  v_receipt_count integer;
  v_receipt_days integer;
  v_first date;
  v_last date;
  v_matched integer;
begin
  ------------------------------------------------------------------
  -- Build the simulated group from real unmatched names.
  ------------------------------------------------------------------
  select count(*),
         coalesce(jsonb_agg(jsonb_build_object(
           'supplier_id', b.supplier_id,
           'normalized_name', b.normalized_name,
           'raw_name', b.raw_name,
           'raw_unit', b.raw_unit,
           'receipt_count', b.receipt_count,
           'last_date', b.last_date
         ) order by b.receipt_count desc, b.normalized_name), '[]'::jsonb),
         coalesce(sum(b.receipt_count), 0)::integer,
         coalesce(sum(b.receipt_days), 0)::integer,
         min(b.first_date),
         max(b.last_date)
    into v_matched, v_members, v_receipt_count, v_receipt_days, v_first, v_last
  from (
    select * from public.list_unmatched_purchase_names('q7', 60)
    where normalized_name like '%dairymont%' or normalized_name like '%danpmont%'
    order by receipt_count desc, normalized_name
    limit 2
  ) b;

  if v_matched = 0 then
    -- The real database has no Dairymont / DANPMONT name right now: use the two
    -- most frequent real unmatched names so the RPC checks still run.
    raise notice 'no Dairymont/DANPMONT unmatched name: falling back to the top names';
    select count(*),
           coalesce(jsonb_agg(jsonb_build_object(
             'supplier_id', b.supplier_id,
             'normalized_name', b.normalized_name,
             'raw_name', b.raw_name,
             'raw_unit', b.raw_unit,
             'receipt_count', b.receipt_count,
             'last_date', b.last_date
           ) order by b.receipt_count desc, b.normalized_name), '[]'::jsonb),
           coalesce(sum(b.receipt_count), 0)::integer,
           coalesce(sum(b.receipt_days), 0)::integer,
           min(b.first_date),
           max(b.last_date)
      into v_matched, v_members, v_receipt_count, v_receipt_days, v_first, v_last
    from (
      select * from public.list_unmatched_purchase_names('q7', 60)
      order by receipt_count desc, normalized_name
      limit 2
    ) b;
  end if;

  if v_matched = 0 then
    raise notice 'no unmatched purchase name in the last 60 days: skipping the apply checks';
    return;
  end if;
  raise notice 'simulated group has % real member(s): %', v_matched, v_members;

  select md5(v_suffix || '|' || string_agg(n, '|' order by n)) into v_cluster
  from (
    select distinct e.value ->> 'normalized_name' as n
    from jsonb_array_elements(v_members) e
  ) s;

  -- (2) upsert the simulated group.
  if public.upsert_new_item_suggestions('q7', jsonb_build_array(jsonb_build_object(
    'cluster_key', v_cluster,
    'members', v_members,
    'suggested_name', v_name,
    'suggested_unit', 'kg',
    'suggested_class', 'raw_material',
    'class_probability', 0.9,
    'receipt_count', v_receipt_count,
    'receipt_days', v_receipt_days,
    'first_date', v_first,
    'last_date', v_last,
    'is_recurring', true,
    'prompt_version', 'jev-new-item-2026-10-21.1'
  ))) <> 1 then
    raise exception 'upsert_new_item_suggestions must write exactly one row';
  end if;

  select id into v_suggestion
  from public.stock_new_item_suggestions
  where location = 'q7' and cluster_key = v_cluster;
  if v_suggestion is null then
    raise exception 'the upserted suggestion is missing';
  end if;

  select jsonb_agg(jsonb_build_object(
    'supplier_id', e.value ->> 'supplier_id',
    'normalized_name', e.value ->> 'normalized_name',
    'raw_name', e.value ->> 'raw_name',
    'entered_unit_label', 'kg',
    'conversion_factor', 1
  )) into v_apply_members
  from jsonb_array_elements(v_members) e;

  ------------------------------------------------------------------
  -- Actor(s): a real owner (admin) and a normal non-admin user.
  ------------------------------------------------------------------
  select u.id into v_owner
  from auth.users u
  join public.user_roles r on r.user_id = u.id and r.role = 'owner'
  order by u.created_at
  limit 1;
  if v_owner is null then
    raise exception 'smoke requires at least one owner user';
  end if;

  select u.id into v_staff
  from auth.users u
  join public.user_roles r on r.user_id = u.id and r.role in ('staff', 'warehouse')
  where not exists (
      select 1 from public.user_roles r2
      where r2.user_id = u.id and r2.role = 'owner'
    )
    and not exists (
      select 1 from public.user_module_permissions p
      where p.user_id = u.id
        and p.module_key in ('q7_material_inventory', 'kitchen_inventory')
        and p.can_edit = true
    )
  order by u.created_at
  limit 1;

  ------------------------------------------------------------------
  -- (3) apply creates exactly one item, sets its class and auto aliases.
  ------------------------------------------------------------------
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_owner::text, true);

  select count(*) into v_before from public.kitchen_inventory_items where name = v_name;
  v_result := public.apply_new_item_suggestion(
    v_suggestion, v_name, 'kg', 'raw_material', v_apply_members, v_req
  );
  if v_result ->> 'status' <> 'applied' then
    raise exception 'apply must report applied, got %', v_result;
  end if;
  v_item := (v_result ->> 'item_id')::uuid;
  select count(*) into v_after from public.kitchen_inventory_items where name = v_name;
  if v_after - v_before <> 1 then
    raise exception 'apply must create exactly one item, got % -> %', v_before, v_after;
  end if;
  if not exists (
    select 1 from public.kitchen_inventory_items kii
    where kii.id = v_item and kii.item_class = 'raw_material' and kii.item_class_source = 'new_item_review'
  ) then
    raise exception 'the created item must carry item_class raw_material / source new_item_review';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(v_members) e
    where not exists (
      select 1 from public.stock_material_aliases a
      where a.location = 'q7'
        and a.normalized_name = e.value ->> 'normalized_name'
        and a.supplier_id is not distinct from nullif(e.value ->> 'supplier_id', '')::uuid
        and a.kitchen_inventory_item_id = v_item
        and a.line_class = 'stock'
        and a.status = 'auto'
    )
  ) then
    raise exception 'every member must have an auto stock alias to the new item';
  end if;
  raise notice 'apply created one item and confirmed every alias as auto';

  ------------------------------------------------------------------
  -- (4) replaying the same request_id must not create another item.
  ------------------------------------------------------------------
  select count(*) into v_before from public.kitchen_inventory_items where name = v_name;
  v_result := public.apply_new_item_suggestion(
    v_suggestion, v_name, 'kg', 'raw_material', v_apply_members, v_req
  );
  if v_result ->> 'status' <> 'already_applied' then
    raise exception 'a replay must report already_applied, got %', v_result;
  end if;
  select count(*) into v_after from public.kitchen_inventory_items where name = v_name;
  if v_after <> v_before then
    raise exception 'a replay must not create another item (% -> %)', v_before, v_after;
  end if;
  raise notice 'apply is idempotent by request_id';

  ------------------------------------------------------------------
  -- (5) a member that is not in the suggestion is refused.
  ------------------------------------------------------------------
  perform set_config('request.jwt.claim.role', 'service_role', true);
  v_cluster_unknown := md5(v_cluster || ':unknown');
  perform public.upsert_new_item_suggestions('q7', jsonb_build_array(jsonb_build_object(
    'cluster_key', v_cluster_unknown,
    'members', v_members,
    'suggested_name', 'Smoke Unknown ' || v_suffix,
    'suggested_unit', 'kg',
    'suggested_class', 'raw_material',
    'receipt_count', v_receipt_count,
    'receipt_days', v_receipt_days,
    'is_recurring', true,
    'prompt_version', 'jev-new-item-2026-10-21.1'
  )));
  select id into v_suggestion_unknown
  from public.stock_new_item_suggestions
  where location = 'q7' and cluster_key = v_cluster_unknown;

  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  begin
    perform public.apply_new_item_suggestion(
      v_suggestion_unknown, 'Smoke Unknown ' || v_suffix, 'kg', 'raw_material',
      jsonb_build_array(jsonb_build_object(
        'supplier_id', null,
        'normalized_name', 'khong-ton-tai-' || v_suffix,
        'raw_name', 'Không tồn tại',
        'entered_unit_label', 'kg',
        'conversion_factor', 1
      )),
      gen_random_uuid()
    );
    raise exception 'a member outside the suggestion must be refused';
  exception
    when others then
      if sqlerrm <> 'member_not_in_suggestion' then
        raise;
      end if;
  end;
  raise notice 'an unknown member is refused';

  ------------------------------------------------------------------
  -- (6) a non-admin caller is refused with create_item_forbidden.
  ------------------------------------------------------------------
  if v_staff is not null then
    perform set_config('request.jwt.claim.sub', v_staff::text, true);
    begin
      perform public.apply_new_item_suggestion(
        v_suggestion_unknown, 'Smoke Unknown ' || v_suffix, 'kg', 'raw_material', v_apply_members, gen_random_uuid()
      );
      raise exception 'a non-admin must not apply a suggestion';
    exception
      when others then
        if sqlerrm <> 'create_item_forbidden' then
          raise;
        end if;
    end;
    raise notice 'a non-admin is refused';
  else
    raise notice 'no non-admin staff user: skip the forbidden check';
  end if;

  ------------------------------------------------------------------
  -- (7) a non_stock group creates no item and confirms non_stock aliases.
  ------------------------------------------------------------------
  perform set_config('request.jwt.claim.role', 'service_role', true);
  v_cluster_nonstock := md5(v_cluster || ':nonstock');
  perform public.upsert_new_item_suggestions('q7', jsonb_build_array(jsonb_build_object(
    'cluster_key', v_cluster_nonstock,
    'members', v_members,
    'suggested_name', 'Smoke Nonstock ' || v_suffix,
    'suggested_unit', 'kg',
    'suggested_class', 'non_stock',
    'receipt_count', v_receipt_count,
    'receipt_days', v_receipt_days,
    'is_recurring', false,
    'prompt_version', 'jev-new-item-2026-10-21.1'
  )));
  select id into v_suggestion_nonstock
  from public.stock_new_item_suggestions
  where location = 'q7' and cluster_key = v_cluster_nonstock;

  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  select count(*) into v_before
  from public.kitchen_inventory_items
  where name like 'Smoke Nonstock %';
  v_result := public.apply_new_item_suggestion(
    v_suggestion_nonstock, 'Smoke Nonstock ' || v_suffix, 'kg', 'non_stock', v_apply_members, gen_random_uuid()
  );
  select count(*) into v_after
  from public.kitchen_inventory_items
  where name like 'Smoke Nonstock %';
  if v_result ->> 'item_id' is not null then
    raise exception 'a non_stock group must not create an item, got %', v_result;
  end if;
  if v_after <> v_before then
    raise exception 'a non_stock group must not create an item (% -> %)', v_before, v_after;
  end if;
  if exists (
    select 1
    from jsonb_array_elements(v_members) e
    where not exists (
      select 1 from public.stock_material_aliases a
      where a.location = 'q7'
        and a.normalized_name = e.value ->> 'normalized_name'
        and a.supplier_id is not distinct from nullif(e.value ->> 'supplier_id', '')::uuid
        and a.line_class = 'non_stock'
    )
  ) then
    raise exception 'a non_stock group must confirm every member as non_stock';
  end if;
  raise notice 'a non_stock group creates no item and confirms non_stock';

  raise notice 'new item suggestions smoke passed';
end;
$smoke$;

rollback;
