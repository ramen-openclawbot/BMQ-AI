-- 2026-10-23 — Rà soát nhập kho: gợi ý sạch hơn, tìm phiếu toàn bộ, đánh dấu không có phiếu
--
-- * public.kho_review_meaningful_word(text) ignores words shorter than 2
--   characters and packaging/measure filler words.  kho_review_list() scores
--   target and receipt-line names on meaningful words only; a target whose
--   whole name is filler keeps all its words so it can still be matched.
-- * Candidates whose latest Jev verdict is 'different' are hidden from the
--   shown top 5.  Every item/material target still returns hidden_different =
--   the number of candidates hidden for that target.
-- * public.kho_review_dismissals marks an item target as intentionally having
--   no receipt (self made, gift, bought outside...).  An active row hides the
--   item target from kho_review_list().
-- * public.kho_review_search_lines() searches every confirmed/received receipt
--   line (no 90-day window) in both the corrected and the raw name.
-- * public.kho_review_dismiss() / kho_review_undismiss() record and soft-remove
--   a dismissal with who/when audit columns.  The dismiss RPC is idempotent on
--   request_id.
--
-- kho_review_list() keeps its live signature, security, search_path, evidence
-- precedence, corrected/raw-name logic, 90-day filter, limits and grants.

-- ===========================================================================
-- 1. Meaningful word helper
-- ===========================================================================
-- The same filler list the owner asked for.  Words come from
-- normalize_stock_item_name(), so they are already unaccented and lower-case;
-- btrim/lower here only make the helper safe for direct use.

create or replace function public.kho_review_meaningful_word(p_word text)
returns boolean
language sql
immutable
as $$
  select length(btrim(coalesce(p_word, ''))) >= 2
     and lower(btrim(coalesce(p_word, ''))) not in (
       'in', 'x', 'size', 'loai', 'cai', 'goi', 'hop', 'bich', 'chai',
       'thung', 'kg', 'g', 'ml', 'l', 'gr', 'lit', 'cuon'
     );
$$;

-- ===========================================================================
-- 2. Dismissals — "mặt hàng này không có phiếu"
-- ===========================================================================
-- One active dismissal per target; removed rows stay as history.  The target
-- key is the same 'i:<item_id>:<location>' key used by kho_review_list().

create table if not exists public.kho_review_dismissals (
  id uuid primary key default gen_random_uuid(),
  target_key text not null,
  reason text not null check (reason in ('self_made', 'gift', 'no_receipt', 'other')),
  note text,
  request_id uuid unique,
  created_by uuid,
  created_at timestamptz default now(),
  removed_at timestamptz,
  removed_by uuid
);

create unique index if not exists kho_review_dismissals_active_target_idx
  on public.kho_review_dismissals (target_key)
  where removed_at is null;

alter table public.kho_review_dismissals enable row level security;

revoke all on public.kho_review_dismissals from public, anon, authenticated;
grant all on public.kho_review_dismissals to service_role;

-- ===========================================================================
-- 3. kho_review_list — stop words, hidden Jev-different, dismissed items
-- ===========================================================================
-- Copied from the live 20261102770000_kho_review_evidence_links.sql body.  The
-- only changes are:
--   * target_words / line_words ignore filler words (target fallback keeps all
--     words when a target has no meaningful word);
--   * ranked drops candidates whose latest Jev verdict is 'different', and
--     hidden_different counts them per target;
--   * item_gaps drops items with an active dismissal.

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
    from expanded
    where in_tan_tao and (doc_lines = 0 or qty_tan_tao < 0)
      and not exists (
        select 1 from public.kho_review_dismissals d
        where d.target_key = 'i:' || item_id::text || ':tan_tao'
          and d.removed_at is null
      )
    union all
    select item_id, item_code, name, unit, item_class, 'q7', qty_q7,
           case when doc_lines = 0 and qty_q7 < 0 then 'no_docs_negative' when doc_lines = 0 then 'no_docs' else 'negative' end
    from expanded
    where in_q7 and (doc_lines = 0 or qty_q7 < 0)
      and not exists (
        select 1 from public.kho_review_dismissals d
        where d.target_key = 'i:' || item_id::text || ':q7'
          and d.removed_at is null
      )
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
  target_words_all as materialized (
    select distinct t.tkey, w
    from targets t,
         unnest(regexp_split_to_array(coalesce(public.normalize_stock_item_name(t.name), ''), '\s+')) w
    where w <> ''
  ),
  target_words as materialized (
    select aw.tkey, aw.w
    from target_words_all aw
    where public.kho_review_meaningful_word(aw.w)
       or not exists (
         select 1
         from target_words_all mw
         where mw.tkey = aw.tkey
           and public.kho_review_meaningful_word(mw.w)
       )
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
      and public.kho_review_meaningful_word(w)
    union
    select distinct l.receipt_item_id, w, 'r'::text as src
    from lines l, unnest(regexp_split_to_array(coalesce(l.norm_raw, ''), '\s+')) w
    where w <> ''
      and public.kho_review_meaningful_word(w)
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
    where (t.item_id is null or lk.linked_item_id is null or lk.linked_item_id = t.item_id)
      -- Jev already judged this pair different; do not show it again.
      and lm.verdict is distinct from 'different'
  ),
  hidden_different as materialized (
    select sc.tkey, count(*)::integer as n
    from scored sc
    join lines l on l.receipt_item_id = sc.receipt_item_id
    join targets t on t.tkey = sc.tkey
    left join linked lk on lk.receipt_item_id = l.receipt_item_id
    join latest_marks lm
      on lm.target_key = sc.tkey and lm.receipt_item_id = sc.receipt_item_id
    where (t.item_id is null or lk.linked_item_id is null or lk.linked_item_id = t.item_id)
      and lm.verdict = 'different'
    group by sc.tkey
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
           coalesce(h.n, 0) as hidden_different,
           case g.reason when 'no_docs_negative' then 0 when 'no_docs' then 1 else 2 end as ord
    from item_gaps g
    left join cand c on c.tkey = 'i:' || g.item_id::text || ':' || g.location
    left join hidden_different h on h.tkey = 'i:' || g.item_id::text || ':' || g.location
    order by ord, g.name, g.location
    limit 300
  ),
  material_out as (
    select g.*, coalesce(c.candidates, '[]'::jsonb) as candidates,
           coalesce(h.n, 0) as hidden_different
    from material_gaps g
    left join cand c on c.tkey = 'm:' || g.canonical_material_id::text || ':' || g.recipe_unit
    left join hidden_different h on h.tkey = 'm:' || g.canonical_material_id::text || ':' || g.recipe_unit
    order by g.name, g.recipe_unit
    limit 100
  )
  select
    coalesce((select jsonb_agg(jsonb_build_object(
      'item_id', x.item_id, 'item_code', x.item_code, 'name', x.name, 'unit', x.unit,
      'item_class', x.item_class, 'location', x.location, 'qty', x.qty, 'reason', x.reason,
      'target_key', 'i:' || x.item_id::text || ':' || x.location,
      'hidden_different', x.hidden_different,
      'candidates', x.candidates) order by x.ord, x.name, x.location) from item_out x), '[]'::jsonb),
    coalesce((select jsonb_agg(jsonb_build_object(
      'canonical_material_id', x.canonical_material_id, 'name', x.name, 'recipe_unit', x.recipe_unit,
      'sku_codes', x.sku_codes,
      'target_key', 'm:' || x.canonical_material_id::text || ':' || x.recipe_unit,
      'hidden_different', x.hidden_different,
      'candidates', x.candidates) order by x.name, x.recipe_unit) from material_out x), '[]'::jsonb)
  into v_items, v_materials;

  return jsonb_build_object('items', v_items, 'materials', v_materials);
end;
$$;

revoke all on function public.kho_review_list() from public, anon;
grant execute on function public.kho_review_list() to authenticated, service_role;

-- ===========================================================================
-- 4. kho_review_search_lines — search every confirmed receipt line
-- ===========================================================================
-- Same permission gate and candidate shape as kho_review_list().  The search
-- has no 90-day window and matches every query word against the normalized
-- corrected OR raw name.  Jev fields are null because this is a manual search,
-- not a Jev suggestion.

create or replace function public.kho_review_search_lines(
  p_target_key text,
  p_query text,
  p_limit integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_words text[];
  v_result jsonb := '[]'::jsonb;
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

  -- A blank or single-character query is not a search.
  if length(btrim(coalesce(p_query, ''))) < 2 then
    return '[]'::jsonb;
  end if;

  v_words := array_remove(
    regexp_split_to_array(
      btrim(coalesce(public.normalize_stock_item_name(p_query), '')),
      '\s+'
    ),
    ''
  );
  if coalesce(array_length(v_words, 1), 0) = 0 then
    return '[]'::jsonb;
  end if;

  with lines as materialized (
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
      nullif(btrim(gri.unit), '') as unit,
      coalesce(gri.actual_quantity, nullif(gri.ordered_quantity, 0), nullif(gri.quantity, 0)) as actual_quantity,
      gri.unit_price,
      nullif(btrim(gr.image_url), '') as image_url
    from public.goods_receipt_items gri
    join public.goods_receipts gr on gr.id = gri.goods_receipt_id
    left join public.suppliers s on s.id = gr.supplier_id
    where gr.status in ('confirmed', 'received')
      and coalesce(gr.receiving_location, 'tan_tao') in ('q7', 'tan_tao')
  ),
  matched as materialized (
    select l.*
    from lines l
    where not exists (
      select 1
      from unnest(v_words) q(w)
      where coalesce(l.norm_corrected, '') not ilike '%' || q.w || '%'
        and coalesce(l.norm_raw, '') not ilike '%' || q.w || '%'
    )
  ),
  linked as materialized (
    select
      l.receipt_item_id,
      coalesce(
        (select e.item_id
         from public.kho_review_evidence_links e
         where e.receipt_item_id = l.receipt_item_id
           and e.removed_at is null
         order by e.created_at desc, e.id desc
         limit 1),
        (select min(a.kitchen_inventory_item_id::text)::uuid
         from public.stock_material_aliases a
         where a.location = l.location
           and a.normalized_name = l.norm_corrected
           and a.supplier_id is not distinct from l.supplier_id
           and a.kitchen_inventory_item_id is not null),
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
    from matched l
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'target_key', p_target_key,
           'receipt_item_id', m.receipt_item_id, 'receipt_number', m.receipt_number,
           'receipt_date', m.receipt_date, 'location', m.location, 'supplier_name', m.supplier_name,
           'product_name', coalesce(m.corrected_name, m.raw_name),
           'raw_name', case
             when m.raw_name is not null
              and public.normalize_stock_item_name(m.raw_name)
                  is distinct from public.normalize_stock_item_name(coalesce(m.corrected_name, m.raw_name))
              then m.raw_name
           end,
           'unit', m.unit, 'actual_quantity', m.actual_quantity,
           'unit_price', m.unit_price, 'image_url', m.image_url, 'score', 1,
           'linked_item_id', m.linked_item_id,
           'jev_verdict', null,
           'jev_probability', null,
           'jev_model', null,
           'posted', exists (
             select 1 from public.q7_inventory_movements mv
             where mv.source = 'goods_receipt' and mv.source_ref_key = 'gr-item:' || m.receipt_item_id::text
             union all
             select 1 from public.tan_tao_material_movements mv
             where mv.source = 'goods_receipt' and mv.source_ref_key = 'gr-item:' || m.receipt_item_id::text
           )
         ) order by m.receipt_date desc, m.receipt_item_id desc), '[]'::jsonb)
  into v_result
  from (
    select l.*, lk.linked_item_id
    from matched l
    left join linked lk on lk.receipt_item_id = l.receipt_item_id
    order by l.receipt_date desc, l.receipt_item_id desc
    limit v_limit
  ) m;

  return v_result;
end;
$$;

revoke all on function public.kho_review_search_lines(text, text, integer)
  from public, anon;
grant execute on function public.kho_review_search_lines(text, text, integer)
  to authenticated, service_role;

-- ===========================================================================
-- 5. kho_review_dismiss — mark a target as having no receipt
-- ===========================================================================
-- Same permission gate as kho_review_list().  Idempotent on request_id; a
-- replayed request returns the original dismissal.  Dismissing an already
-- active target returns the active row instead of raising the partial unique
-- index.  The audit columns record who/when and who/when removed it.

create or replace function public.kho_review_dismiss(
  p_target_key text,
  p_reason text,
  p_note text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_row public.kho_review_dismissals%rowtype;
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

  if p_target_key is null
     or p_target_key !~* '^i:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(q7|tan_tao)$' then
    raise exception 'invalid_target' using errcode = '22023';
  end if;
  if p_request_id is null then
    raise exception 'invalid_request' using errcode = '22023';
  end if;
  if p_reason is null
     or p_reason not in ('self_made', 'gift', 'no_receipt', 'other') then
    raise exception 'invalid_reason' using errcode = '22023';
  end if;

  -- Serialize both a request replay and a second dismiss of the same target.
  perform pg_advisory_xact_lock(hashtext('kho_review_dismiss:' || p_request_id::text));
  perform pg_advisory_xact_lock(hashtext('kho_review_dismiss:' || p_target_key));

  select * into v_row
  from public.kho_review_dismissals d
  where d.request_id = p_request_id;
  if found then
    return jsonb_build_object(
      'status', 'dismissed',
      'id', v_row.id,
      'target_key', v_row.target_key,
      'reason', v_row.reason,
      'replayed', true
    );
  end if;

  select * into v_row
  from public.kho_review_dismissals d
  where d.target_key = p_target_key
    and d.removed_at is null
  order by d.created_at desc, d.id desc
  limit 1;
  if found then
    return jsonb_build_object(
      'status', 'dismissed',
      'id', v_row.id,
      'target_key', v_row.target_key,
      'reason', v_row.reason,
      'replayed', true
    );
  end if;

  insert into public.kho_review_dismissals (
    target_key, reason, note, request_id, created_by
  ) values (
    p_target_key, p_reason, nullif(btrim(p_note), ''), p_request_id, v_actor
  )
  returning * into v_row;

  return jsonb_build_object(
    'status', 'dismissed',
    'id', v_row.id,
    'target_key', v_row.target_key,
    'reason', v_row.reason,
    'replayed', false
  );
end;
$$;

revoke all on function public.kho_review_dismiss(text, text, text, uuid)
  from public, anon;
grant execute on function public.kho_review_dismiss(text, text, text, uuid)
  to authenticated, service_role;

-- ===========================================================================
-- 6. kho_review_undismiss — soft-remove an active dismissal
-- ===========================================================================
-- Same gate; naturally idempotent: a second call finds no active row and
-- returns 'none'.  request_id keeps concurrent/replayed calls serialized.

create or replace function public.kho_review_undismiss(
  p_target_key text,
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

  if p_target_key is null
     or p_target_key !~* '^i:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}:(q7|tan_tao)$' then
    raise exception 'invalid_target' using errcode = '22023';
  end if;
  if p_request_id is null then
    raise exception 'invalid_request' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('kho_review_undismiss:' || p_target_key));

  update public.kho_review_dismissals
    set removed_at = now(),
        removed_by = v_actor
  where target_key = p_target_key
    and removed_at is null;
  get diagnostics v_updated = row_count;

  return jsonb_build_object(
    'status', case when v_updated > 0 then 'removed' else 'none' end
  );
end;
$$;

revoke all on function public.kho_review_undismiss(text, uuid)
  from public, anon;
grant execute on function public.kho_review_undismiss(text, uuid)
  to authenticated, service_role;
