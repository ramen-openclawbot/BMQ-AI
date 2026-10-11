-- Smoke test for the 2026-10-20 alias-learning fix.
-- Runs entirely inside BEGIN ... ROLLBACK so it never keeps fixtures.
-- Prerequisites (real data only, never created by this script):
--   * migrations 20261016100000 + 20261017100000 + 20261019100000 + this one
--   * at least one public.user_roles row with role 'owner'
--   * the Q7 catalog really contains the target items named below
-- Run with:  psql "$DATABASE_URL" -f scripts/smoke_alias_learning_fix.sql
--
-- Ranking cases (each target must sit in the top 5 candidates):
--   'Chicken egg 60gr/Trứng gà 60g'                          -> 'Trứng gà 60gr'
--   'DAIRYMONT WHITE SLICES CHEESE 1KG'                      -> 'Phô mai 84 lát trắng Dairymont'
--   'MUỐI SÁY KHÔ 500G BAO 25KG'                             -> 'Muối sấy'
--   '[Thùng] Sữa Tiệt Trùng Mekovita 3.5% Bélo 1L x 12 Hộp'  -> 'Sữa Mlekovita'
--   'RE AN KHÈ'                                              -> 'RE AN KHÊ'

begin;

select set_config('request.jwt.claim.role', 'service_role', true);

do $smoke$
declare
  v_suffix text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 8);
  v_names text[] := array[
    'Chicken egg 60gr/Trứng gà 60g',
    'DAIRYMONT WHITE SLICES CHEESE 1KG',
    'MUỐI SÁY KHÔ 500G BAO 25KG',
    '[Thùng] Sữa Tiệt Trùng Mekovita 3.5% Bélo 1L x 12 Hộp',
    'RE AN KHÈ'
  ];
  v_targets text[] := array[
    'Trứng gà 60gr',
    'Phô mai 84 lát trắng Dairymont',
    'Muối sấy',
    'Sữa Mlekovita',
    'RE AN KHÊ'
  ];
  v_i integer;
  v_top jsonb;
  v_found boolean;
  v_backlog_count integer;
  v_owner uuid;
  v_staff uuid;
  v_result jsonb;
  v_created jsonb;
  v_item uuid;
  v_req uuid := gen_random_uuid();
  v_expected_name text;
begin
  ------------------------------------------------------------------
  -- (1) every required pair is in the top 5 deterministic candidates
  ------------------------------------------------------------------
  for v_i in 1..array_length(v_names, 1) loop
    select coalesce(jsonb_agg(jsonb_build_object('name', c.name, 'score', c.score, 'reason', c.reason)
                              order by c.score desc, c.name asc), '[]'::jsonb)
    into v_top
    from public.material_alias_candidates(v_names[v_i], 'q7', 5) c;

    select exists (
      select 1 from jsonb_array_elements(v_top) elem
      -- Catalog names may carry a pack suffix, e.g. "Dairymont (1kg/khối …)".
      where elem ->> 'name' = v_targets[v_i]
         or elem ->> 'name' like v_targets[v_i] || ' (%'
    ) into v_found;

    if not v_found then
      raise exception 'target % must be in the top 5 for %, got %', v_targets[v_i], v_names[v_i], v_top;
    end if;
  end loop;
  raise notice 'top-5 ranking check passed for % names', array_length(v_names, 1);

  ------------------------------------------------------------------
  -- (2) how many pending backlog names have at least one candidate
  ------------------------------------------------------------------
  select count(*) into v_backlog_count
  from public.get_material_alias_backlog('q7', 200) b
  where exists (
    select 1 from public.material_alias_candidates(b.raw_name, 'q7', 5) c
  );
  raise notice 'pending backlog names with at least one candidate: %', v_backlog_count;

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
  -- (3) create_stock_material_item: forbidden, idempotent, reuse
  ------------------------------------------------------------------
  perform set_config('request.jwt.claim.role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
  begin
    perform public.create_stock_material_item('Smoke Forbidden ' || v_suffix, 'kg', 'q7', gen_random_uuid());
    raise exception 'a non-editor must not create a stock item';
  exception
    when others then
      if sqlerrm <> 'create_item_forbidden' then
        raise;
      end if;
  end;

  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  v_created := public.create_stock_material_item('Smoke Item ' || v_suffix, 'kg', 'q7', v_req);
  if (v_created ->> 'created')::boolean is not true then
    raise exception 'first create must report created=true, got %', v_created;
  end if;
  v_item := (v_created ->> 'item_id')::uuid;

  -- Replaying the same request_id returns the same item, created=false.
  v_created := public.create_stock_material_item('Smoke Item ' || v_suffix, 'kg', 'q7', v_req);
  if (v_created ->> 'created')::boolean is not false then
    raise exception 'a replayed request_id must report created=false, got %', v_created;
  end if;
  if (v_created ->> 'item_id')::uuid is distinct from v_item then
    raise exception 'a replayed request_id must return the same item';
  end if;

  -- A new request with the same normalized name reuses the active item.
  v_created := public.create_stock_material_item('  smoke item ' || v_suffix || '  ', 'kg', 'q7', gen_random_uuid());
  if (v_created ->> 'created')::boolean is not false then
    raise exception 'an existing normalized name must be reused, got %', v_created;
  end if;
  if (v_created ->> 'item_id')::uuid is distinct from v_item then
    raise exception 'the reused item must be the same row';
  end if;
  raise notice 'create_stock_material_item permission + idempotency passed';

  ------------------------------------------------------------------
  -- (4) an admin confirm goes auto immediately; a normal staff stays learning
  ------------------------------------------------------------------
  perform set_config('request.jwt.claim.sub', v_owner::text, true);
  v_result := public.confirm_material_alias(
    null, 'q7', 'Smoke Alias Admin ' || v_suffix, 'kg', v_item, null::uuid, 'kg', 1::numeric, null::uuid, null::numeric, null::text, null::uuid, 'stock'
  );
  if (v_result -> 'alias' ->> 'status') <> 'auto' then
    raise exception 'an admin confirm must become auto, got %', v_result -> 'alias' ->> 'status';
  end if;
  if not exists (
    select 1 from public.material_alias_events e
    where e.alias_id = (v_result -> 'alias' ->> 'id')::uuid and e.action = 'auto_promoted'
  ) then
    raise exception 'the admin auto promotion must be logged';
  end if;

  if v_staff is not null then
    perform set_config('request.jwt.claim.sub', v_staff::text, true);
    v_result := public.confirm_material_alias(
      null, 'q7', 'Smoke Alias Staff ' || v_suffix, 'kg', v_item, null::uuid, 'kg', 1::numeric, null::uuid, null::numeric, null::text, null::uuid, 'stock'
    );
    if (v_result -> 'alias' ->> 'status') <> 'learning' then
      raise exception 'a normal staff confirm must stay learning, got %', v_result -> 'alias' ->> 'status';
    end if;
    if (v_result -> 'alias' ->> 'confirm_count')::int <> 1 then
      raise exception 'a normal staff first confirm must record confirm_count 1';
    end if;
  else
    raise notice 'no non-admin staff user: skip the staff learning check';
  end if;

  raise notice 'alias learning fix smoke passed';
end;
$smoke$;

rollback;
