-- 2026-10-23 — Rà soát nhập kho: nối phiếu kho khác làm chứng từ, không cộng tồn
--
-- * A receipt line may be linked to an active item that has no place at the
--   line's kho.  Instead of raising item_wrong_kho, the link helper records
--   one evidence link per receipt line.  It writes no stock_material_aliases
--   row and never posts a ledger movement: the line is a document only.
-- * public.kho_review_evidence_links is service-role only.
-- * public.kho_get_items() counts evidence-linked receipt lines in doc_lines,
--   unioned with alias-linked lines so a line counted by both counts once.
-- * public.kho_review_list() prefers an active evidence link over aliases when
--   deciding that a receipt line is already linked to an item.
-- * public.kho_review_unlink_evidence(...) soft-removes the active evidence
--   link for a receipt line.
--
-- The link helper and the item/list readers keep their live signatures,
-- security, search_path and grants.  public.kho_review_link_line() is not
-- redefined: it already stores and replays whatever the helper returns,
-- including the evidence result.

-- ===========================================================================
-- 1. Evidence links
-- ===========================================================================
-- One active row per receipt line; removed rows stay as history.  The line's
-- own kho is stored so the UI can show which phiếu was used as evidence.

create table if not exists public.kho_review_evidence_links (
  id uuid primary key default gen_random_uuid(),
  receipt_item_id uuid not null references public.goods_receipt_items(id) on delete cascade,
  item_id uuid not null references public.kitchen_inventory_items(id),
  factor numeric not null check (factor > 0),
  line_location text not null check (line_location in ('q7', 'tan_tao')),
  request_id uuid unique,
  created_by uuid,
  created_at timestamptz default now(),
  removed_at timestamptz,
  removed_by uuid
);

create unique index if not exists kho_review_evidence_links_active_receipt_idx
  on public.kho_review_evidence_links (receipt_item_id)
  where removed_at is null;

alter table public.kho_review_evidence_links enable row level security;

revoke all on public.kho_review_evidence_links from public, anon, authenticated;
grant all on public.kho_review_evidence_links to service_role;

-- ===========================================================================
-- 2. Link helper — evidence branch where item_wrong_kho used to be
-- ===========================================================================
-- Copied from the live definition.  The only behavioural changes are:
--   * an active item with no place at the line's kho writes one evidence row
--     and returns status 'evidence' without touching an alias or the ledger;
--   * a normal same-kho link soft-removes an older evidence row for the line.
-- Everything else is byte-for-byte the live body.

create or replace function public.kho_review_link_line_internal(p_receipt_item_id uuid, p_item_id uuid, p_factor numeric)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public', 'pg_temp'
as $function$
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
  v_evidence_id uuid;
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
    -- The item is active but has no place at the line's kho.  Record the line
    -- as evidence for the item instead: no alias, no ledger movement.
    insert into public.kho_review_evidence_links as e (
      receipt_item_id, item_id, factor, line_location, created_by
    ) values (
      p_receipt_item_id, p_item_id, p_factor, v_location, auth.uid()
    )
    on conflict (receipt_item_id) where removed_at is null
    do update set
      item_id = excluded.item_id,
      factor = excluded.factor
    returning e.id into v_evidence_id;

    -- The human picked this item for the line, so the item's own kho target
    -- records the linked decision even though the line's kho differs.
    update public.kho_review_jev_marks
      set human_action = 'linked',
          human_action_at = now()
    where receipt_item_id = p_receipt_item_id
      and target_key = 'i:' || p_item_id::text || ':' ||
          case when coalesce(v_item.pastry_q7, false) then 'q7' else 'tan_tao' end;

    return jsonb_build_object(
      'status', 'evidence',
      'posted', false,
      'location', v_location,
      'evidence_id', v_evidence_id
    );
  end if;

  -- A normal same-kho link replaces any older evidence-only link.
  update public.kho_review_evidence_links
    set removed_at = now(),
        removed_by = auth.uid()
  where receipt_item_id = p_receipt_item_id
    and removed_at is null;

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
$function$
;

revoke all on function public.kho_review_link_line_internal(uuid, uuid, numeric)
  from public, anon, authenticated;
grant execute on function public.kho_review_link_line_internal(uuid, uuid, numeric)
  to service_role;

-- ===========================================================================
-- 3. kho_get_items — doc_lines also counts active evidence links
-- ===========================================================================
-- Copied from the live definition.  The docs CTE unions the alias-based lines
-- with the evidence-based lines, then counts distinct receipt lines so a line
-- found by both paths is counted once.

create or replace function public.kho_get_items()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_actor uuid := auth.uid();
  v_tt jsonb;
  v_q7 jsonb;
  v_items jsonb;
begin
  if v_actor is null then
    raise exception 'actor_required' using errcode = '42501';
  end if;
  if not (
    public.q7_material_inventory_can_view(v_actor)
    or public.stock_count_can_view('tan_tao')
    or public.stock_count_can_view('q7')
    or public.kho_item_can_edit(v_actor)
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- Exactly two ledger calls, once for the whole list.
  v_tt := public.get_stock_ledger_overview('tan_tao', current_date);
  v_q7 := public.get_stock_ledger_overview('q7', current_date);

  with tt as (
    select coalesce(jsonb_object_agg(e ->> 'item_id', e), '{}'::jsonb) as map
    from jsonb_array_elements(coalesce(v_tt -> 'materials', '[]'::jsonb)) e
    where nullif(e ->> 'item_id', '') is not null
  ),
  q7 as (
    select coalesce(jsonb_object_agg(e ->> 'item_id', e), '{}'::jsonb) as map
    from jsonb_array_elements(coalesce(v_q7 -> 'items', '[]'::jsonb)) e
    where nullif(e ->> 'item_id', '') is not null
  ),
  pending as (
    select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) as map
    from (
      select distinct on (s.location, l.target_id)
        s.location || ':' || l.target_id::text as k,
        l.counted_qty as v
      from public.stock_count_lines l
      join public.stock_count_sessions s on s.id = l.session_id
      where s.status = 'open'
        and l.target_kind = 'item'
        and s.location in ('tan_tao', 'q7')
      order by s.location, l.target_id, s.opened_at desc, l.id desc
    ) x
  ),
  docs as (
    select coalesce(jsonb_object_agg(item_id, n), '{}'::jsonb) as map
    from (
      select u.item_id,
             count(distinct u.receipt_item_id)::integer as n
      from (
        select a.kitchen_inventory_item_id as item_id,
               gri.id as receipt_item_id
        from public.stock_material_aliases a
        join public.goods_receipts gr
          on gr.supplier_id is not distinct from a.supplier_id
        left join public.suppliers s on s.id = gr.supplier_id
        join public.goods_receipt_items gri on gri.goods_receipt_id = gr.id
        where a.kitchen_inventory_item_id is not null
          and a.location in ('tan_tao', 'q7')
          and a.location = coalesce(gr.receiving_location, s.default_receiving_location, 'tan_tao')
          and gr.status in ('confirmed', 'received')
          and coalesce(s.stock_exempt, false) = false
          and public.stock_line_auto_non_stock(
                coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
              ) is null
          and a.normalized_name = public.normalize_stock_item_name(
                coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
              )
        union
        select e.item_id, gri.id as receipt_item_id
        from public.kho_review_evidence_links e
        join public.goods_receipt_items gri on gri.id = e.receipt_item_id
        join public.goods_receipts gr on gr.id = gri.goods_receipt_id
        where e.removed_at is null
          and gr.status in ('confirmed', 'received')
      ) u
      group by u.item_id
    ) x
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', kii.id,
           'item_code', kii.item_code,
           'name', kii.name,
           'unit', kii.unit,
           'active', coalesce(kii.active, false),
           'item_class', kii.item_class,
           'in_q7', coalesce(kii.pastry_q7, false),
           'in_tan_tao', coalesce(kii.in_tan_tao, not coalesce(kii.pastry_q7, false)),
           'qty', jsonb_build_object(
             'tan_tao', case
               when tt.map ? kii.id::text
                 then (tt.map -> kii.id::text ->> 'current_qty')::numeric
               else null
             end,
             'q7', case
               when q7.map ? kii.id::text
                 then (q7.map -> kii.id::text ->> 'current_qty')::numeric
               else null
             end
           ),
           'last_count_date', jsonb_build_object(
             'tan_tao', tt.map -> kii.id::text ->> 'last_count_date',
             'q7', q7.map -> kii.id::text ->> 'last_count_date'
           ),
           'pending_count', jsonb_build_object(
             'tan_tao', pending.map -> ('tan_tao:' || kii.id::text),
             'q7', pending.map -> ('q7:' || kii.id::text)
           ),
           'doc_lines', coalesce((docs.map ->> kii.id::text)::integer, 0)
         ) order by kii.name, kii.id), '[]'::jsonb)
  into v_items
  from public.kitchen_inventory_items kii
  cross join tt
  cross join q7
  cross join pending
  cross join docs
  where kii.active = true
     or exists (
       select 1
       from public.stock_item_discontinuations d
       where d.item_id = kii.id
     );

  return jsonb_build_object(
    'can_edit', public.kho_item_can_edit(v_actor),
    'can_count', jsonb_build_object(
      'tan_tao', public.stock_count_can_edit('tan_tao'),
      'q7', public.stock_count_can_edit('q7')
    ),
    'items', v_items
  );
end;
$function$
;

revoke all on function public.kho_get_items() from public, anon;
grant execute on function public.kho_get_items() to authenticated, service_role;

-- ===========================================================================
-- 4. kho_review_list — evidence link wins over aliases
-- ===========================================================================
-- Exact body from 20261102760000_kho_review_corrected_name.sql.  The only
-- change is the linked CTE: an active evidence row for the receipt line is its
-- linked_item_id, before the corrected-name and raw-name alias fallbacks.

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
      nullif(btrim(gri.product_name), '') as corrected_name,
      nullif(btrim(gri.raw_product_name), '') as raw_name,
      public.normalize_stock_item_name(
        coalesce(nullif(btrim(gri.product_name), ''), nullif(btrim(gri.raw_product_name), ''))
      ) as norm_corrected,
      public.normalize_stock_item_name(
        coalesce(nullif(btrim(gri.raw_product_name), ''), nullif(btrim(gri.product_name), ''))
      ) as norm_raw,
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
    select distinct l.receipt_item_id, w, 'c'::text as src
    from lines l, unnest(regexp_split_to_array(coalesce(l.norm_corrected, ''), '\s+')) w
    where w <> ''
    union
    select distinct l.receipt_item_id, w, 'r'::text as src
    from lines l, unnest(regexp_split_to_array(coalesce(l.norm_raw, ''), '\s+')) w
    where w <> ''
  ),
  scored as materialized (
    select tkey, receipt_item_id, max(score) as score
    from (
      select tw.tkey, lw.receipt_item_id, lw.src, count(*)::numeric / ts.n as score
      from target_words tw
      join line_words lw on lw.w = tw.w
      join target_sizes ts on ts.tkey = tw.tkey
      group by tw.tkey, lw.receipt_item_id, lw.src, ts.n
      having count(*)::numeric / ts.n >= 0.5
    ) per_name
    group by tkey, receipt_item_id
  ),
  linked as materialized (
    select
      l.receipt_item_id,
      coalesce(
        -- An evidence link is the human's explicit choice for this line; it
        -- takes precedence over every alias that might also match.
        (select e.item_id
         from public.kho_review_evidence_links e
         where e.receipt_item_id = l.receipt_item_id
           and e.removed_at is null
         order by e.created_at desc, e.id desc
         limit 1),
        -- The corrected name is what the operator sees and fixes: its alias is
        -- the only one that can consider the line already linked elsewhere.
        (select min(a.kitchen_inventory_item_id::text)::uuid
         from public.stock_material_aliases a
         where a.location = l.location
           and a.normalized_name = l.norm_corrected
           and a.supplier_id is not distinct from l.supplier_id
           and a.kitchen_inventory_item_id is not null),
        -- Raw-name aliases are only a fallback when no corrected-name alias
        -- exists at all, so a stale scan spelling cannot hide the line.
        (select min(a.kitchen_inventory_item_id::text)::uuid
         from public.stock_material_aliases a
         where a.location = l.location
           and a.normalized_name = l.norm_raw
           and a.supplier_id is not distinct from l.supplier_id
           and a.kitchen_inventory_item_id is not null
           and not exists (
             select 1 from public.stock_material_aliases c
             where c.location = l.location
               and c.normalized_name = l.norm_corrected
               and c.supplier_id is not distinct from l.supplier_id
           ))
      ) as linked_item_id
    from lines l
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
             'product_name', coalesce(r.corrected_name, r.raw_name),
             'raw_name', case
               when r.raw_name is not null
                and public.normalize_stock_item_name(r.raw_name)
                    is distinct from public.normalize_stock_item_name(coalesce(r.corrected_name, r.raw_name))
               then r.raw_name
             end,
             'unit', r.unit, 'actual_quantity', r.actual_quantity,
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
-- 5. kho_review_unlink_evidence — soft-remove the active evidence link
-- ===========================================================================
-- Same permission gate as kho_review_list.  The operation is naturally
-- idempotent: a second call finds no active row and returns 'none'.

create or replace function public.kho_review_unlink_evidence(
  p_receipt_item_id uuid,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_updated integer := 0;
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

  update public.kho_review_evidence_links
    set removed_at = now(),
        removed_by = v_actor
  where receipt_item_id = p_receipt_item_id
    and removed_at is null;
  get diagnostics v_updated = row_count;

  return jsonb_build_object(
    'status', case when v_updated > 0 then 'removed' else 'none' end
  );
end;
$$;

revoke all on function public.kho_review_unlink_evidence(uuid, uuid)
  from public, anon;
grant execute on function public.kho_review_unlink_evidence(uuid, uuid)
  to authenticated, service_role;
