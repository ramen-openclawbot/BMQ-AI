-- 2026-10-22 — Rà soát nhập kho: Jev chấm gợi ý cho từng cặp
-- (target_key, dòng phiếu nhập).
--
-- * public.kho_review_jev_marks keeps one row per target_key + receipt item +
--   prompt_version.  Jev writes suggestions only; the human action is recorded
--   separately in human_action / human_action_at.
-- * public.kho_review_jev_feedback(...) records that human decision ('linked'
--   or 'dismissed'), idempotent through public.warehouse_game_requests.
-- * public.kho_review_list() keeps the exact body from
--   20261102730000_kho_review_90d.sql (90-day filter, materialized CTEs,
--   300/100 limits) and adds target_key + the latest jev_* mark per candidate.
-- * public.kho_review_link_line_internal(...) is copied from
--   20261102720000_kho_review.sql and records human_action = 'linked' for the
--   linked line on the matching item target.
--
-- 20261102720000_kho_review.sql and 20261102730000_kho_review_90d.sql are
-- applied live; this file only redefines their list/link helper.

-- ===========================================================================
-- 1. warehouse_game_requests action list (keeps every previous action)
-- ===========================================================================

alter table public.warehouse_game_requests
  drop constraint if exists warehouse_game_requests_action_check;
alter table public.warehouse_game_requests
  add constraint warehouse_game_requests_action_check
  check (action in (
    'rename', 'change_unit', 'set_item_pastry_q7', 'kho_save_item',
    'kho_add_unit', 'kho_set_conversion', 'set_item_kho_locations',
    'kho_review_link_line', 'kho_review_create_item',
    'kho_review_jev_feedback'
  ));

-- ===========================================================================
-- 2. Jev marks
-- ===========================================================================
-- target_key is exactly the key kho_review_list() already uses internally:
-- 'i:<item_id>:<location>' for an item/kho row and
-- 'm:<canonical_material_id>:<recipe_unit>' for a recipe material row.
-- The unique key is (target_key, receipt_item_id, prompt_version), so a new
-- prompt version can add a fresh opinion without losing the old one.

create table if not exists public.kho_review_jev_marks (
  id uuid primary key default gen_random_uuid(),
  target_key text not null,
  receipt_item_id uuid not null references public.goods_receipt_items(id) on delete cascade,
  verdict text not null check (verdict in ('same_item', 'different', 'unsure')),
  probability numeric check (probability between 0 and 1),
  suggested_class text check (suggested_class in ('raw_material', 'packaging_supply')),
  prompt_version text not null,
  model text,
  provider text,
  human_action text check (human_action in ('linked', 'dismissed')),
  human_action_at timestamptz,
  created_by uuid,
  created_at timestamptz default now(),
  constraint kho_review_jev_marks_target_receipt_prompt_key
    unique (target_key, receipt_item_id, prompt_version)
);

alter table public.kho_review_jev_marks enable row level security;

drop policy if exists kho_review_jev_marks_select on public.kho_review_jev_marks;
create policy kho_review_jev_marks_select on public.kho_review_jev_marks
  for select to authenticated
  using (
    public.q7_material_inventory_can_edit((select auth.uid()))
    or public.has_module_permission((select auth.uid()), 'inventory', 'edit')
  );

-- Only the service role may write suggestions / human actions.  No insert,
-- update or delete policy exists for a client.
revoke all on public.kho_review_jev_marks from public, anon, authenticated;
grant select on public.kho_review_jev_marks to authenticated;
grant all on public.kho_review_jev_marks to service_role;

-- ===========================================================================
-- 3. kho_review_list — 90-day body plus target_key and the latest jev_* mark
-- ===========================================================================

create or replace function public.kho_review_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_items jsonb := '[]'::jsonb;
  v_materials jsonb := '[]'::jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null
       or not (
         public.q7_material_inventory_can_edit(v_actor)
         or public.has_module_permission(v_actor, 'inventory', 'edit')
       ) then
      raise exception 'kho_review_forbidden' using errcode = '42501';
    end if;
  end if;

  with expanded as (
    select
      (e ->> 'id')::uuid as item_id,
      e ->> 'item_code' as item_code,
      e ->> 'name' as name,
      e ->> 'unit' as unit,
      e ->> 'item_class' as item_class,
      coalesce((e ->> 'doc_lines')::integer, 0) as doc_lines,
      coalesce((e #>> '{qty,tan_tao}')::numeric, 0) as qty_tan_tao,
      coalesce((e #>> '{qty,q7}')::numeric, 0) as qty_q7,
      coalesce((e ->> 'in_tan_tao')::boolean, false) as in_tan_tao,
      coalesce((e ->> 'in_q7')::boolean, false) as in_q7
    from jsonb_array_elements(coalesce(public.kho_get_items() -> 'items', '[]'::jsonb)) e
    where coalesce((e ->> 'active')::boolean, false)
  ),
  item_gaps as materialized (
    select item_id, item_code, name, unit, item_class, 'tan_tao'::text as location, qty_tan_tao as qty,
           case when doc_lines = 0 and qty_tan_tao < 0 then 'no_docs_negative' when doc_lines = 0 then 'no_docs' else 'negative' end as reason
    from expanded where in_tan_tao and (doc_lines = 0 or qty_tan_tao < 0)
    union all
    select item_id, item_code, name, unit, item_class, 'q7', qty_q7,
           case when doc_lines = 0 and qty_q7 < 0 then 'no_docs_negative' when doc_lines = 0 then 'no_docs' else 'negative' end
    from expanded where in_q7 and (doc_lines = 0 or qty_q7 < 0)
  ),
  latest_versions as (
    select distinct on (v.sku_id) v.id, v.sku_id
    from public.sku_cogs_versions v
    where v.effective_from <= current_date + 30
    order by v.sku_id, v.effective_from desc, v.version_no desc, v.id::text desc
  ),
  recipe_rows as (
    select ps.sku_code, f.canonical_material_id, public.normalize_document_unit(f.unit) as recipe_unit
    from latest_versions v
    join public.product_skus ps on ps.id = v.sku_id and ps.sku_type is distinct from 'raw_material'
    join public.sku_cogs_version_formulations f on f.version_id = v.id
    where f.canonical_material_id is not null
      and public.normalize_document_unit(f.unit) is not null
      and not exists (
        select 1 from public.sku_cogs_version_formulations child
        where child.version_id = f.version_id
          and position(f.ingredient_name || ' > ' in child.ingredient_name) = 1
      )
      and public.cogs_resolve_child_sku(f.ingredient_sku_id, f.canonical_material_id, f.material_code) is null
  ),
  material_gaps as materialized (
    select r.canonical_material_id, mat.canonical_name as name, r.recipe_unit,
           jsonb_agg(distinct r.sku_code order by r.sku_code) as sku_codes
    from recipe_rows r
    join public.sku_cogs_materials mat on mat.id = r.canonical_material_id
    left join public.cogs_ingredient_stock_map sm
      on sm.canonical_material_id = r.canonical_material_id and sm.recipe_unit = r.recipe_unit
    where sm.id is null or sm.status = 'suggested' or sm.action is null
    group by r.canonical_material_id, mat.canonical_name, r.recipe_unit
  ),
  -- One key per target: items by item+kho, materials by material+unit.
  targets as materialized (
    select 'i:' || item_id::text || ':' || location as tkey, name, location as target_location, item_id
    from item_gaps
    union all
    select 'm:' || canonical_material_id::text || ':' || recipe_unit, name, null::text, null::uuid
    from material_gaps
  ),
  target_words as materialized (
    select distinct t.tkey, w
    from targets t,
         unnest(regexp_split_to_array(coalesce(public.normalize_stock_item_name(t.name), ''), '\s+')) w
    where w <> ''
  ),
  target_sizes as materialized (
    select tkey, count(*) as n from target_words group by tkey
  ),
  lines as materialized (
    select
      gri.id as receipt_item_id, gr.receipt_number, gr.receipt_date,
      coalesce(gr.receiving_location, 'tan_tao') as location, gr.supplier_id, s.name as supplier_name,
      coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name) as product_name,
      public.normalize_stock_item_name(coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)) as normalized_name,
      nullif(btrim(gri.unit), '') as unit, coalesce(gri.actual_quantity, nullif(gri.ordered_quantity, 0), nullif(gri.quantity, 0)) as actual_quantity, gri.unit_price,
      nullif(btrim(gr.image_url), '') as image_url
    from public.goods_receipt_items gri
    join public.goods_receipts gr on gr.id = gri.goods_receipt_id
    left join public.suppliers s on s.id = gr.supplier_id
    where gr.status in ('confirmed', 'received')
      -- Owner 22/10: only purchases of the last 90 days are offered.
      and gr.receipt_date >= current_date - 90
      and coalesce(gr.receiving_location, 'tan_tao') in ('q7', 'tan_tao')
      and coalesce(s.stock_exempt, false) = false
      -- stock_line_auto_non_stock() per line cost ~2 s; a non-stock line only
      -- shows up as a candidate when its words match, and the owner skips it.
  ),
  line_words as materialized (
    select distinct l.receipt_item_id, w
    from lines l, unnest(regexp_split_to_array(coalesce(l.normalized_name, ''), '\s+')) w
    where w <> ''
  ),
  scored as materialized (
    select tw.tkey, lw.receipt_item_id, count(*)::numeric / ts.n as score
    from target_words tw
    join line_words lw on lw.w = tw.w
    join target_sizes ts on ts.tkey = tw.tkey
    group by tw.tkey, lw.receipt_item_id, ts.n
    having count(*)::numeric / ts.n >= 0.5
  ),
  linked as materialized (
    select l.receipt_item_id, min(a.kitchen_inventory_item_id::text)::uuid as linked_item_id
    from lines l
    join public.stock_material_aliases a
      on a.location = l.location and a.normalized_name = l.normalized_name
     and a.supplier_id is not distinct from l.supplier_id and a.kitchen_inventory_item_id is not null
    group by l.receipt_item_id
  ),
  latest_marks as materialized (
    select distinct on (m.target_key, m.receipt_item_id)
      m.target_key, m.receipt_item_id, m.verdict, m.probability, m.model
    from public.kho_review_jev_marks m
    order by m.target_key, m.receipt_item_id, m.created_at desc, m.id desc
  ),
  ranked as materialized (
    select sc.tkey, l.*, sc.score, lk.linked_item_id,
           lm.verdict as jev_verdict, lm.probability as jev_probability, lm.model as jev_model,
           row_number() over (
             partition by sc.tkey
             order by (lm.verdict = 'same_item') desc nulls last,
                      lm.probability desc nulls last,
                      sc.score desc, l.receipt_date desc, l.receipt_item_id desc
           ) as rn
    from scored sc
    join lines l on l.receipt_item_id = sc.receipt_item_id
    join targets t on t.tkey = sc.tkey
    left join linked lk on lk.receipt_item_id = l.receipt_item_id
    left join latest_marks lm
      on lm.target_key = sc.tkey and lm.receipt_item_id = sc.receipt_item_id
    -- A line already linked to another item is not offered to an item row.
    where t.item_id is null or lk.linked_item_id is null or lk.linked_item_id = t.item_id
  ),
  cand as materialized (
    select r.tkey, jsonb_agg(jsonb_build_object(
             'target_key', r.tkey,
             'receipt_item_id', r.receipt_item_id, 'receipt_number', r.receipt_number,
             'receipt_date', r.receipt_date, 'location', r.location, 'supplier_name', r.supplier_name,
             'product_name', r.product_name, 'unit', r.unit, 'actual_quantity', r.actual_quantity,
             'unit_price', r.unit_price, 'image_url', r.image_url, 'score', round(r.score, 4),
             'linked_item_id', r.linked_item_id,
             'jev_verdict', r.jev_verdict,
             'jev_probability', r.jev_probability,
             'jev_model', r.jev_model,
             'posted', exists (
               select 1 from public.q7_inventory_movements m
               where m.source = 'goods_receipt' and m.source_ref_key = 'gr-item:' || r.receipt_item_id::text
               union all
               select 1 from public.tan_tao_material_movements m
               where m.source = 'goods_receipt' and m.source_ref_key = 'gr-item:' || r.receipt_item_id::text
             )
           ) order by r.rn) as candidates
    from ranked r
    where r.rn <= 5
    group by r.tkey
  ),
  item_out as (
    select g.*, coalesce(c.candidates, '[]'::jsonb) as candidates,
           case g.reason when 'no_docs_negative' then 0 when 'no_docs' then 1 else 2 end as ord
    from item_gaps g
    left join cand c on c.tkey = 'i:' || g.item_id::text || ':' || g.location
    order by ord, g.name, g.location
    limit 300
  ),
  material_out as (
    select g.*, coalesce(c.candidates, '[]'::jsonb) as candidates
    from material_gaps g
    left join cand c on c.tkey = 'm:' || g.canonical_material_id::text || ':' || g.recipe_unit
    order by g.name, g.recipe_unit
    limit 100
  )
  select
    coalesce((select jsonb_agg(jsonb_build_object(
      'item_id', x.item_id, 'item_code', x.item_code, 'name', x.name, 'unit', x.unit,
      'item_class', x.item_class, 'location', x.location, 'qty', x.qty, 'reason', x.reason,
      'target_key', 'i:' || x.item_id::text || ':' || x.location,
      'candidates', x.candidates) order by x.ord, x.name, x.location) from item_out x), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object(
      'canonical_material_id', x.canonical_material_id, 'name', x.name, 'recipe_unit', x.recipe_unit,
      'sku_codes', x.sku_codes,
      'target_key', 'm:' || x.canonical_material_id::text || ':' || x.recipe_unit,
      'candidates', x.candidates) order by x.name, x.recipe_unit) from material_out x), '[]'::jsonb)
  into v_items, v_materials;

  return jsonb_build_object('items', v_items, 'materials', v_materials);
end;
$$;

revoke all on function public.kho_review_list() from public, anon;
grant execute on function public.kho_review_list() to authenticated, service_role;

-- ===========================================================================
-- 4. kho_review_jev_feedback — the human decision on one (target, line) pair
-- ===========================================================================
-- Sets human_action / human_action_at on every prompt version of the pair.
-- It never writes an alias or a ledger movement.  Replay is keyed by
-- request_id + action in public.warehouse_game_requests.

create or replace function public.kho_review_jev_feedback(
  p_target_key text,
  p_receipt_item_id uuid,
  p_action text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_cached jsonb;
  v_updated integer := 0;
  v_result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null
       or not (
         public.q7_material_inventory_can_edit(v_actor)
         or public.has_module_permission(v_actor, 'inventory', 'edit')
       ) then
      raise exception 'kho_review_forbidden' using errcode = '42501';
    end if;
  end if;

  if p_target_key is null or btrim(p_target_key) = '' then
    raise exception 'invalid_target_key' using errcode = '22023';
  end if;
  if p_receipt_item_id is null then
    raise exception 'invalid_receipt_item' using errcode = '22023';
  end if;
  if p_action is null or p_action not in ('linked', 'dismissed') then
    raise exception 'invalid_action' using errcode = '22023';
  end if;

  if p_request_id is not null then
    perform pg_advisory_xact_lock(hashtext('warehouse_game:' || p_request_id::text));
    select r.result into v_cached
    from public.warehouse_game_requests r
    where r.request_id = p_request_id
      and r.action = 'kho_review_jev_feedback';
    if found then
      return v_cached;
    end if;
  end if;

  update public.kho_review_jev_marks
    set human_action = p_action,
        human_action_at = now()
  where target_key = p_target_key
    and receipt_item_id = p_receipt_item_id;
  get diagnostics v_updated = row_count;

  v_result := jsonb_build_object(
    'status', 'recorded',
    'updated', v_updated,
    'target_key', p_target_key,
    'receipt_item_id', p_receipt_item_id,
    'human_action', p_action
  );

  if p_request_id is not null then
    insert into public.warehouse_game_requests (
      request_id, action, item_id, result, created_by
    ) values (
      p_request_id, 'kho_review_jev_feedback', null, v_result, v_actor
    )
    on conflict (request_id) do nothing;
  end if;

  return v_result;
end;
$$;

revoke all on function public.kho_review_jev_feedback(text, uuid, text, uuid)
  from public, anon;
grant execute on function public.kho_review_jev_feedback(text, uuid, text, uuid)
  to authenticated, service_role;

-- ===========================================================================
-- 5. Shared link helper (upsert alias + conditional ledger post)
-- ===========================================================================

create or replace function public.kho_review_link_line_internal(
  p_receipt_item_id uuid,
  p_item_id uuid,
  p_factor numeric
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_line public.goods_receipt_items%rowtype;
  v_receipt public.goods_receipts%rowtype;
  v_item public.kitchen_inventory_items%rowtype;
  v_location text;
  v_norm text;
  v_alias public.stock_material_aliases%rowtype;
  v_cutover date;
  v_has_movement boolean := false;
  v_posted boolean := false;
begin
  if p_factor is null or p_factor <= 0 then
    raise exception 'invalid_factor' using errcode = '22023';
  end if;

  select * into v_line
  from public.goods_receipt_items gri
  where gri.id = p_receipt_item_id;
  if not found then
    raise exception 'goods_receipt_item_not_found' using errcode = 'P0002';
  end if;

  select * into v_receipt
  from public.goods_receipts gr
  where gr.id = v_line.goods_receipt_id;
  if not found then
    raise exception 'goods_receipt_item_not_found' using errcode = 'P0002';
  end if;

  -- Receipts created before the central receiving default may still be null;
  -- every rule in the ledger treats that as Tân Tạo.
  v_location := coalesce(v_receipt.receiving_location, 'tan_tao');
  if v_location not in ('q7', 'tan_tao') then
    raise exception 'goods_receipt_item_not_found' using errcode = 'P0002';
  end if;

  select * into v_item
  from public.kitchen_inventory_items k
  where k.id = p_item_id;
  if not found
     or v_item.merged_into_id is not null
     or coalesce(v_item.active, false) = false then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;

  if (v_location = 'tan_tao' and coalesce(v_item.in_tan_tao, false) = false)
     or (v_location = 'q7' and coalesce(v_item.pastry_q7, false) = false) then
    raise exception 'item_wrong_kho' using errcode = '22023';
  end if;

  v_norm := public.normalize_stock_item_name(
    coalesce(nullif(btrim(v_line.raw_product_name), ''), v_line.product_name)
  );
  if v_norm is null or v_norm = '' then
    v_norm := lower(btrim(coalesce(v_line.product_name, '')));
  end if;

  -- The table has both a named unique constraint and an expression unique
  -- index that treats a null supplier as a real key.  The expression is the
  -- conflict target so a null-supplier label cannot be inserted twice.
  insert into public.stock_material_aliases as a (
    supplier_id, normalized_name, location, kitchen_inventory_item_id,
    tan_tao_sku_id, conversion_factor, unit, created_by,
    confirm_count, confirmers, status, last_confirmed_at, line_class
  ) values (
    v_receipt.supplier_id, v_norm, v_location, p_item_id,
    null, p_factor, v_item.unit, auth.uid(),
    1,
    case when auth.uid() is null then '{}'::uuid[] else array[auth.uid()] end,
    'auto', now(), 'stock'
  )
  on conflict (
    coalesce(supplier_id, '00000000-0000-0000-0000-000000000000'::uuid),
    normalized_name,
    location
  ) do update set
    kitchen_inventory_item_id = excluded.kitchen_inventory_item_id,
    tan_tao_sku_id = null,
    conversion_factor = excluded.conversion_factor,
    unit = excluded.unit,
    line_class = 'stock',
    status = 'auto',
    confirm_count = greatest(a.confirm_count, 1) + 1,
    confirmers = coalesce((
      select array_agg(distinct c)
      from unnest(coalesce(a.confirmers, '{}'::uuid[]) || excluded.confirmers) c
    ), '{}'::uuid[]),
    last_confirmed_at = now(),
    updated_at = now()
  returning * into v_alias;

  select exists (
    select 1
    from public.q7_inventory_movements m
    where m.source = 'goods_receipt'
      and m.source_ref_key = 'gr-item:' || p_receipt_item_id::text
    union all
    select 1
    from public.tan_tao_material_movements m
    where m.source = 'goods_receipt'
      and m.source_ref_key = 'gr-item:' || p_receipt_item_id::text
  ) into v_has_movement;

  if v_has_movement then
    -- Already in the ledger: linking does not post a second movement.
    v_posted := true;
  else
    v_cutover := public.stock_ledger_cutover_date(v_location);
    if v_cutover is not null
       and v_receipt.receipt_date is not null
       and v_receipt.receipt_date > v_cutover then
      v_posted := public.post_stock_goods_receipt_item(p_receipt_item_id, v_alias);
    end if;
  end if;

  -- The human linked this receipt line to this item at this kho: every Jev
  -- mark for that exact target (all prompt versions) records the decision.
  update public.kho_review_jev_marks
    set human_action = 'linked',
        human_action_at = now()
  where receipt_item_id = p_receipt_item_id
    and target_key = 'i:' || p_item_id::text || ':' || v_location;

  return jsonb_build_object(
    'status', 'linked',
    'alias_id', v_alias.id,
    'posted', coalesce(v_posted, false),
    'location', v_location
  );
end;
$$;

revoke all on function public.kho_review_link_line_internal(uuid, uuid, numeric)
  from public, anon, authenticated;
grant execute on function public.kho_review_link_line_internal(uuid, uuid, numeric)
  to service_role;

-- ===========================================================================
-- 5. kho_review_link_line
-- ===========================================================================

create or replace function public.kho_review_link_line(
  p_receipt_item_id uuid,
  p_item_id uuid,
  p_factor numeric,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_cached jsonb;
  v_result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null
       or not (
         public.q7_material_inventory_can_edit(v_actor)
         or public.has_module_permission(v_actor, 'inventory', 'edit')
       ) then
      raise exception 'kho_review_forbidden' using errcode = '42501';
    end if;
  end if;

  if p_factor is null or p_factor <= 0 then
    raise exception 'invalid_factor' using errcode = '22023';
  end if;

  if p_request_id is not null then
    perform pg_advisory_xact_lock(hashtext('warehouse_game:' || p_request_id::text));
    select r.result into v_cached
    from public.warehouse_game_requests r
    where r.request_id = p_request_id
      and r.action = 'kho_review_link_line';
    if found then
      return v_cached;
    end if;
  end if;

  v_result := public.kho_review_link_line_internal(
    p_receipt_item_id, p_item_id, p_factor
  );

  if p_request_id is not null then
    insert into public.warehouse_game_requests (
      request_id, action, item_id, result, created_by
    ) values (
      p_request_id, 'kho_review_link_line', p_item_id, v_result, v_actor
    )
    on conflict (request_id) do nothing;
  end if;

  return v_result;
end;
$$;

revoke all on function public.kho_review_link_line(uuid, uuid, numeric, uuid)
  from public, anon;
grant execute on function public.kho_review_link_line(uuid, uuid, numeric, uuid)
  to authenticated, service_role;

-- ===========================================================================
-- 6. kho_review_create_item_from_line
-- ===========================================================================

create or replace function public.kho_review_create_item_from_line(
  p_receipt_item_id uuid,
  p_name text,
  p_unit text,
  p_class text,
  p_factor numeric,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_cached jsonb;
  v_line public.goods_receipt_items%rowtype;
  v_receipt public.goods_receipts%rowtype;
  v_location text;
  v_created jsonb;
  v_item_id uuid;
  v_result jsonb;
  v_create_request uuid;
  v_link_request uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null
       or not (
         public.q7_material_inventory_can_edit(v_actor)
         or public.has_module_permission(v_actor, 'inventory', 'edit')
       ) then
      raise exception 'kho_review_forbidden' using errcode = '42501';
    end if;
  end if;

  if p_class is null or p_class not in ('raw_material', 'packaging_supply') then
    raise exception 'invalid_class' using errcode = '22023';
  end if;
  if p_factor is null or p_factor <= 0 then
    raise exception 'invalid_factor' using errcode = '22023';
  end if;

  if p_request_id is not null then
    perform pg_advisory_xact_lock(hashtext('warehouse_game:' || p_request_id::text));
    select r.result into v_cached
    from public.warehouse_game_requests r
    where r.request_id = p_request_id
      and r.action = 'kho_review_create_item';
    if found then
      return v_cached;
    end if;
  end if;

  select * into v_line
  from public.goods_receipt_items gri
  where gri.id = p_receipt_item_id;
  if not found then
    raise exception 'goods_receipt_item_not_found' using errcode = 'P0002';
  end if;

  select * into v_receipt
  from public.goods_receipts gr
  where gr.id = v_line.goods_receipt_id;
  if not found then
    raise exception 'goods_receipt_item_not_found' using errcode = 'P0002';
  end if;

  v_location := coalesce(v_receipt.receiving_location, 'tan_tao');
  if v_location not in ('q7', 'tan_tao') then
    raise exception 'goods_receipt_item_not_found' using errcode = 'P0002';
  end if;

  if p_request_id is not null then
    v_create_request := md5(p_request_id::text || ':create')::uuid;
    v_link_request := md5(p_request_id::text || ':link')::uuid;
  end if;

  v_created := public.create_stock_material_item(
    p_name, p_unit, v_location, v_create_request
  );
  v_item_id := (v_created ->> 'item_id')::uuid;

  if v_item_id is null then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;

  -- "Create the item at the receipt's kho": create_stock_material_item keeps
  -- the single-kho default, so add the receipt kho as an extra place without
  -- removing a place the item already has.
  if v_location = 'q7' then
    update public.kitchen_inventory_items
      set pastry_q7 = true,
          pastry_q7_source = coalesce(pastry_q7_source, 'rule'),
          pastry_q7_set_at = now(),
          updated_at = now()
    where id = v_item_id
      and coalesce(pastry_q7, false) = false;
  else
    update public.kitchen_inventory_items
      set in_tan_tao = true,
          updated_at = now()
    where id = v_item_id
      and coalesce(in_tan_tao, false) = false;
  end if;

  perform public.set_stock_item_class(v_item_id, p_class);

  v_result := public.kho_review_link_line(
    p_receipt_item_id, v_item_id, p_factor, v_link_request
  );

  -- The line now belongs to the item this operator created, so every Jev
  -- suggestion that pointed at this receipt line is resolved as 'linked'.
  update public.kho_review_jev_marks
    set human_action = 'linked',
        human_action_at = now()
  where receipt_item_id = p_receipt_item_id
    and human_action is distinct from 'linked';

  v_result := jsonb_build_object(
    'status', 'created',
    'item_id', v_item_id,
    'alias_id', v_result -> 'alias_id',
    'posted', v_result -> 'posted',
    'location', v_result -> 'location'
  );

  if p_request_id is not null then
    insert into public.warehouse_game_requests (
      request_id, action, item_id, result, created_by
    ) values (
      p_request_id, 'kho_review_create_item', v_item_id, v_result, v_actor
    )
    on conflict (request_id) do nothing;
  end if;

  return v_result;
end;
$$;

revoke all on function public.kho_review_create_item_from_line(uuid, text, text, text, numeric, uuid)
  from public, anon;
grant execute on function public.kho_review_create_item_from_line(uuid, text, text, text, numeric, uuid)
  to authenticated, service_role;
