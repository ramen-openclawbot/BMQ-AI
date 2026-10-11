-- Giai đoạn 5 (2026-10-20): sửa học bí danh NVL.
--
-- Additive migration on top of 20261016100000 + 20261017100000 + 20261018100000
-- + 20261019100000. It makes the deterministic candidate matcher understand the
-- bilingual "A / B" receipt names, a "[Thùng]" / "[Carton]" prefix, OCR noise and
-- pack tokens; adds the atomic per-call Jev usage counter; exposes the pending
-- backlog with the latest Jev suggestion; lets an admin confirm promote an alias
-- to auto immediately; and adds an idempotent "create a new stock item" RPC.
--
-- Nothing here updates or deletes purchase_orders, purchase_order_items,
-- payment_requests, payment_request_items, goods_receipts, goods_receipt_items
-- or q7_inventory_movements. The only stock effect of confirm_material_alias is
-- still the existing post_stock_goods_receipt_item helper. No new extension.

-- ---------------------------------------------------------------------------
-- 1. Deterministic matching helpers (bracket prefix, "/" split, OCR noise)
-- ---------------------------------------------------------------------------

-- Drop the "[Thùng]" / "[Carton]" style prefixes before matching.
create or replace function public.material_alias_clean_name(p_name text)
returns text
language sql
immutable
set search_path = pg_temp
as $$
  select nullif(btrim(regexp_replace(coalesce(p_name, ''), '\[[^\]]*\]', ' ', 'g')), '');
$$;

-- Meaningful tokens of one name: normalized words minus numbers, pack quantities
-- ("500g", "25kg", "1l", "x12"), the bare "x" and the counting units. Kept
-- byte-compatible with material_alias_match_tokens in the edge mirror.
create or replace function public.material_alias_match_tokens(p_name text)
returns text[]
language sql
immutable
set search_path = public, pg_temp
as $$
  with norm as (
    select public.normalize_stock_item_name(public.material_alias_clean_name(p_name)) as n
  )
  select coalesce(array_agg(distinct token order by token), '{}'::text[])
  from norm
  cross join lateral unnest(regexp_split_to_array(coalesce(norm.n, ''), '\s+')) as token
  where token <> ''
    and token !~ '^[0-9]+$'
    and token !~ '^[0-9]+([.,][0-9]+)?(kg|g|gr|gram|kilogram|l|lit|ml|cm)$'
    and token !~ '^x[0-9]+$'
    and token <> 'x'
    and token <> all (array[
      'chai', 'hop', 'thung', 'bao', 'goi', 'qua', 'cai', 'chiec', 'ky',
      'can', 'bich', 'vi', 'mieng'
    ]::text[]);
$$;

-- Two meaningful tokens are the same when they are exactly equal, or when both
-- are at least four characters and share a four-character run (so an OCR error
-- like "mekovita" / "mlekovita" still matches). A three-character token only ever
-- matches itself ("say" = "sấy" after the diacritics are removed).
create or replace function public.material_alias_tokens_match(p_left text, p_right text)
returns boolean
language sql
immutable
set search_path = pg_temp
as $$
  select case
    when p_left is null or p_right is null or p_left = '' or p_right = '' then false
    when p_left = p_right then true
    when length(p_left) < 4 or length(p_right) < 4 then false
    when left(p_left, 4) = left(p_right, 4) then true
    else exists (
      select 1
      from generate_series(1, greatest(length(p_left) - 3, 0)) as g
      where position(substr(p_left, g, 4) in p_right) > 0
    )
  end;
$$;

-- ---------------------------------------------------------------------------
-- 2. material_alias_candidates: bilingual / prefixed / noisy names
-- ---------------------------------------------------------------------------

-- Same signature, columns and grant as the running function. Before matching it
-- strips a bracketed prefix; a name with "/" is scored part by part (max wins);
-- pack tokens are ignored; a candidate is kept only when it shares at least one
-- meaningful token (or when the normalized names are exactly equal). reason
-- stays 'name_exact' for an equal normalized name and keeps the '+shared_alias'
-- suffix.
create or replace function public.material_alias_candidates(
  p_name text,
  p_location text,
  p_limit integer default 5
)
returns table (
  item_id uuid,
  sku_id uuid,
  name text,
  unit text,
  score numeric,
  reason text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with base as (
    select coalesce(public.material_alias_clean_name(p_name), '') as clean_name
  ),
  parts as (
    select
      part,
      public.normalize_stock_item_name(part) as part_norm,
      public.material_alias_match_tokens(part) as part_tokens
    from base
    cross join lateral unnest(regexp_split_to_array(base.clean_name, '/')) as part
  ),
  item_raw as (
    select
      'q7'::text as src,
      kii.id as item_id,
      null::uuid as sku_id,
      kii.name::text as name,
      kii.unit::text as unit,
      p.part_norm,
      p.part_tokens,
      public.normalize_stock_item_name(kii.name) as cand_norm,
      public.material_alias_match_tokens(kii.name) as cand_tokens
    from public.kitchen_inventory_items kii
    cross join parts p
    where p_location = 'q7'
      and kii.active = true
      and kii.merged_into_id is null
    union all
    select
      'tan_tao'::text,
      null::uuid,
      ps.id,
      ps.product_name::text,
      ps.unit::text,
      p.part_norm,
      p.part_tokens,
      public.normalize_stock_item_name(ps.product_name),
      public.material_alias_match_tokens(ps.product_name)
    from public.product_skus ps
    cross join parts p
    where p_location = 'tan_tao'
      and upper(ps.sku_code) in ('BMQ-001', 'BMQ-002', 'PATE-500G', 'PATE-200G')
  ),
  scored as (
    select
      ir.*,
      (
        select count(*)
        from unnest(ir.part_tokens) rt
        where exists (
          select 1 from unnest(ir.cand_tokens) ct
          where public.material_alias_tokens_match(rt, ct)
        )
      ) as matched,
      cardinality(ir.part_tokens) as raw_count
    from item_raw ir
  ),
  part_scored as (
    select
      s.*,
      (s.part_norm is not null and s.part_norm = s.cand_norm) as is_exact,
      (s.raw_count > 0 and s.matched = s.raw_count) as contains_all
    from scored s
  ),
  part_final as (
    select
      p.src,
      p.item_id,
      p.sku_id,
      p.name,
      p.unit,
      coalesce(p.item_id, p.sku_id) as cand_key,
      case
        when p.is_exact then 1.000000::numeric
        when p.contains_all then 0.900000::numeric
        when p.matched > 0 then 0.500000::numeric + 0.400000::numeric * p.matched::numeric / greatest(p.raw_count, 1)
        else 0.000000::numeric
      end as score_part,
      case
        when p.is_exact then 0
        when p.contains_all then 1
        when p.matched > 0 then 2
        else 3
      end as priority,
      case
        when p.is_exact then 'name_exact'
        when p.contains_all then 'name_contains'
        else 'token'
      end as base_reason
    from part_scored p
    where p.matched > 0 or p.is_exact
  ),
  best as (
    select distinct on (src, cand_key)
      src, item_id, sku_id, name, unit, score_part, base_reason
    from part_final
    order by src, cand_key, score_part desc, priority asc, name asc
  ),
  final as (
    select
      b.src,
      b.item_id,
      b.sku_id,
      b.name,
      b.unit,
      b.score_part as score,
      b.base_reason || case when (
        n.n is not null and exists (
          select 1
          from public.stock_material_aliases a
          where a.location = b.src
            and a.supplier_id is null
            and a.normalized_name = n.n
            and case
              when b.src = 'q7' then a.kitchen_inventory_item_id = b.item_id
              else a.tan_tao_sku_id = b.sku_id
            end
        )
      ) then '+shared_alias' else '' end as reason
    from best b
    cross join lateral (
      select public.normalize_stock_item_name(public.material_alias_clean_name(p_name)) as n
    ) n
  )
  select f.item_id, f.sku_id, f.name, f.unit, f.score, f.reason
  from final f
  order by f.score desc, f.name asc, f.item_id asc nulls last, f.sku_id asc nulls last
  limit greatest(1, least(coalesce(p_limit, 5), 50));
$$;

-- ---------------------------------------------------------------------------
-- 3. Atomic Jev usage counter (one increment per call)
-- ---------------------------------------------------------------------------

create or replace function public.increment_stock_catalog_jev_usage(
  p_date date,
  p_calls integer,
  p_cost numeric
)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.stock_catalog_jev_usage (usage_date, calls, cost, call_limit, updated_at)
  values (
    p_date,
    greatest(coalesce(p_calls, 0), 0),
    greatest(coalesce(p_cost, 0), 0),
    600,
    now()
  )
  on conflict (usage_date) do update
    set calls = public.stock_catalog_jev_usage.calls + greatest(coalesce(p_calls, 0), 0),
        cost = public.stock_catalog_jev_usage.cost + greatest(coalesce(p_cost, 0), 0),
        updated_at = now();
$$;

-- ---------------------------------------------------------------------------
-- 4. Backlog review: pending names + top candidate + latest Jev suggestion
-- ---------------------------------------------------------------------------

create or replace function public.get_material_alias_backlog_review(
  p_location text,
  p_limit integer default 100
)
returns table (
  normalized_name text,
  raw_name text,
  line_count bigint,
  supplier_id uuid,
  supplier_name text,
  last_receipt_date date,
  top_candidate jsonb,
  jev_item_id uuid,
  jev_item_name text,
  jev_unit text,
  jev_probability numeric,
  jev_line_type text,
  jev_source text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  if p_location not in ('q7', 'tan_tao') then
    raise exception 'unsupported_location' using errcode = '22023';
  end if;
  -- Owner or Q7 stock admin only.
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not public.material_alias_can_admin(v_actor) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;

  return query
  with lines as (
    select
      gr.supplier_id as supplier_id,
      coalesce(gr.receiving_location, s.default_receiving_location, 'q7') as location,
      public.normalize_stock_item_name(
        coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
      ) as normalized_name,
      coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name) as raw_name,
      gri.unit as raw_unit,
      gr.receipt_date as receipt_date
    from public.goods_receipt_items gri
    join public.goods_receipts gr on gr.id = gri.goods_receipt_id
    left join public.suppliers s on s.id = gr.supplier_id
    where gr.status in ('confirmed', 'received')
      and coalesce(s.stock_exempt, false) = false
      and coalesce(gr.receiving_location, s.default_receiving_location, 'q7') = p_location
      and p_location in ('q7', 'tan_tao')
      and public.stock_line_auto_non_stock(
            coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
          ) is null
      and gr.receipt_date >= (now() at time zone 'Asia/Ho_Chi_Minh')::date - 90
  ),
  pending as (
    select
      l.normalized_name,
      l.supplier_id,
      l.location,
      count(*)::bigint as line_count,
      max(l.receipt_date) as last_receipt_date,
      (array_agg(l.raw_name order by l.receipt_date desc, l.raw_name))[1] as raw_name
    from lines l
    where l.normalized_name is not null
      and not exists (
        select 1 from public.stock_material_aliases a
        where a.location = l.location
          and a.normalized_name = l.normalized_name
          and a.supplier_id is not distinct from l.supplier_id
      )
    group by l.normalized_name, l.supplier_id, l.location
  ),
  ordered as (
    select *
    from pending
    order by line_count desc, normalized_name asc
    limit greatest(1, least(coalesce(p_limit, 100), 500))
  )
  select
    o.normalized_name,
    o.raw_name,
    o.line_count,
    o.supplier_id,
    sup.name as supplier_name,
    o.last_receipt_date,
    cand.top_candidate,
    nullif(cache.answer ->> 'item_id', '')::uuid as jev_item_id,
    kii.name as jev_item_name,
    kii.unit as jev_unit,
    nullif(cache.answer ->> 'probability', '')::numeric as jev_probability,
    cache.answer ->> 'line_type' as jev_line_type,
    cache.answer ->> 'source' as jev_source
  from ordered o
  left join public.suppliers sup on sup.id = o.supplier_id
  left join lateral (
    select jsonb_build_object(
      'item_id', c.item_id,
      'sku_id', c.sku_id,
      'name', c.name,
      'unit', c.unit,
      'score', c.score,
      'reason', c.reason
    ) as top_candidate
    from public.material_alias_candidates(o.raw_name, o.location, 1) c
    limit 1
  ) cand on true
  left join lateral (
    select z.answer
    from public.material_alias_jev_cache z
    where z.location = o.location
      and z.normalized_name = o.normalized_name
      and z.supplier_id is not distinct from o.supplier_id
    order by z.created_at desc, z.id desc
    limit 1
  ) cache on true
  left join public.kitchen_inventory_items kii
    on kii.id = nullif(cache.answer ->> 'item_id', '')::uuid;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. confirm_material_alias: an admin confirm promotes to auto immediately
-- ---------------------------------------------------------------------------

create or replace function public.confirm_material_alias(
  p_supplier_id uuid,
  p_location text,
  p_raw_name text,
  p_raw_unit text,
  p_kitchen_inventory_item_id uuid,
  p_tan_tao_sku_id uuid,
  p_entered_unit_label text,
  p_conversion_factor numeric,
  p_jev_item_id uuid,
  p_jev_probability numeric,
  p_source_table text,
  p_source_id uuid,
  p_line_class text default 'stock'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_actor_array uuid[];
  v_norm text;
  v_unit text;
  v_factor numeric;
  v_pack_label text;
  v_alias public.stock_material_aliases%rowtype;
  v_same boolean;
  v_action text;
  v_jev_disagreed boolean;
  v_new_item uuid;
  v_new_sku uuid;
  v_chosen uuid;
  v_confirmers uuid[];
  v_distinct integer;
  v_cutover date;
  v_target record;
  v_applied integer := 0;
begin
  if p_location not in ('q7', 'tan_tao') then
    raise exception 'unsupported_location' using errcode = '22023';
  end if;
  -- [Giai đoạn 3] line_class is stock or non_stock.
  if p_line_class not in ('stock', 'non_stock') then
    raise exception 'line_class_invalid' using errcode = '22023';
  end if;
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.material_alias_can_edit(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  -- [2026-10-19] Marking a line "not stock" by hand is an admin decision
  -- unless the fixed rule already classifies it as VAT / fee / service.
  if p_line_class = 'non_stock'
     and public.stock_line_auto_non_stock(p_raw_name) is null
     and coalesce(auth.role(), '') <> 'service_role'
     and not public.material_alias_can_admin(v_actor) then
    raise exception 'non_stock_requires_admin' using errcode = '42501';
  end if;

  v_actor_array := case when v_actor is null then '{}'::uuid[] else array[v_actor] end;
  v_norm := public.normalize_stock_item_name(p_raw_name);
  if v_norm is null then raise exception 'item_name_required' using errcode = '22023'; end if;

  if p_line_class = 'non_stock' then
    -- No item / SKU is required and the unit falls back to the raw label.
    v_new_item := null;
    v_new_sku := null;
    v_factor := 1;
    v_unit := coalesce(nullif(btrim(p_raw_unit), ''), '-');
  else
    if p_conversion_factor is null or p_conversion_factor <= 0
       or p_conversion_factor::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception 'invalid_conversion_factor' using errcode = '22023';
    end if;
    v_factor := p_conversion_factor;

    if p_location = 'q7' then
      if p_kitchen_inventory_item_id is null then
        raise exception 'kitchen_inventory_item_required' using errcode = '22023';
      end if;
      select kii.unit into v_unit
      from public.kitchen_inventory_items kii
      where kii.id = p_kitchen_inventory_item_id
        and kii.active = true
        and kii.merged_into_id is null;
      if v_unit is null then raise exception 'q7_item_not_found' using errcode = 'P0002'; end if;
      v_new_item := p_kitchen_inventory_item_id;
      v_new_sku := null;
    else
      if p_tan_tao_sku_id is null then
        raise exception 'tan_tao_sku_required' using errcode = '22023';
      end if;
      select ps.unit into v_unit
      from public.product_skus ps
      where ps.id = p_tan_tao_sku_id
        and upper(ps.sku_code) in ('BMQ-001', 'BMQ-002', 'PATE-500G', 'PATE-200G');
      if v_unit is null then raise exception 'tan_tao_sku_not_found' using errcode = 'P0002'; end if;
      v_new_item := null;
      v_new_sku := p_tan_tao_sku_id;
    end if;
  end if;

  v_pack_label := nullif(btrim(coalesce(p_entered_unit_label, '')), '');
  if v_pack_label is null then
    v_pack_label := public.q7_pack_from_name(p_raw_name, p_raw_unit) ->> 'pack_label';
  end if;

  v_chosen := coalesce(v_new_item, v_new_sku);
  v_jev_disagreed := p_jev_item_id is not null
    and p_jev_item_id is distinct from v_chosen
    and coalesce(p_jev_probability, 0) >= 0.9;

  select * into v_alias
  from public.stock_material_aliases a
  where a.location = p_location
    and a.normalized_name = v_norm
    and a.supplier_id is not distinct from p_supplier_id
  for update;

  if not found then
    insert into public.stock_material_aliases(
      supplier_id, normalized_name, location, kitchen_inventory_item_id,
      tan_tao_sku_id, conversion_factor, unit, created_by,
      confirm_count, confirmers, status, pack_label, last_confirmed_at,
      jev_item_id, jev_probability, jev_disagreed, line_class
    ) values (
      p_supplier_id, v_norm, p_location, v_new_item,
      v_new_sku, v_factor, v_unit, v_actor,
      1, v_actor_array, 'learning', v_pack_label, now(),
      p_jev_item_id, p_jev_probability, v_jev_disagreed, p_line_class
    )
    returning * into v_alias;
    v_action := 'confirm';
    insert into public.material_alias_events(
      alias_id, action, actor_id, source_table, source_id, raw_name, raw_unit,
      new_item_id, new_sku_id, new_factor, new_line_class, jev_item_id, jev_probability
    ) values (
      v_alias.id, 'confirm', v_actor, p_source_table, p_source_id, p_raw_name, p_raw_unit,
      v_new_item, v_new_sku, v_factor, p_line_class, p_jev_item_id, p_jev_probability
    );
  else
    -- [Giai đoạn 3] switching stock <-> non_stock counts as a correction.
    v_same := (v_alias.line_class is not distinct from p_line_class)
      and (v_alias.kitchen_inventory_item_id is not distinct from v_new_item)
      and (v_alias.tan_tao_sku_id is not distinct from v_new_sku)
      and (v_alias.conversion_factor = v_factor);

    if v_same then
      v_confirmers := coalesce(v_alias.confirmers, '{}'::uuid[]);
      if v_actor is not null and not (v_actor = any (v_confirmers)) then
        v_confirmers := v_confirmers || v_actor;
      end if;
      update public.stock_material_aliases
        set confirm_count = v_alias.confirm_count + 1,
            confirmers = v_confirmers,
            last_confirmed_at = now(),
            pack_label = coalesce(v_pack_label, pack_label),
            jev_item_id = p_jev_item_id,
            jev_probability = p_jev_probability,
            jev_disagreed = v_jev_disagreed,
            updated_at = now()
        where id = v_alias.id
        returning * into v_alias;
      v_action := 'confirm';
      insert into public.material_alias_events(
        alias_id, action, actor_id, source_table, source_id, raw_name, raw_unit,
        new_item_id, new_sku_id, new_factor, new_line_class, jev_item_id, jev_probability
      ) values (
        v_alias.id, 'confirm', v_actor, p_source_table, p_source_id, p_raw_name, p_raw_unit,
        v_new_item, v_new_sku, v_factor, p_line_class, p_jev_item_id, p_jev_probability
      );
    else
      v_action := 'correct';
      insert into public.material_alias_events(
        alias_id, action, actor_id, source_table, source_id, raw_name, raw_unit,
        previous_item_id, previous_sku_id, previous_factor, previous_line_class,
        new_item_id, new_sku_id, new_factor, new_line_class, jev_item_id, jev_probability
      ) values (
        v_alias.id, 'correct', v_actor, p_source_table, p_source_id, p_raw_name, p_raw_unit,
        v_alias.kitchen_inventory_item_id, v_alias.tan_tao_sku_id, v_alias.conversion_factor,
        v_alias.line_class,
        v_new_item, v_new_sku, v_factor, p_line_class, p_jev_item_id, p_jev_probability
      );
      update public.stock_material_aliases
        set kitchen_inventory_item_id = v_new_item,
            tan_tao_sku_id = v_new_sku,
            conversion_factor = v_factor,
            unit = v_unit,
            line_class = p_line_class,
            pack_label = v_pack_label,
            confirm_count = 1,
            confirmers = v_actor_array,
            status = 'learning',
            last_confirmed_at = now(),
            jev_item_id = p_jev_item_id,
            jev_probability = p_jev_probability,
            jev_disagreed = v_jev_disagreed,
            updated_at = now()
        where id = v_alias.id
        returning * into v_alias;
    end if;
  end if;

  -- Auto-promote only when the state actually changes.
  select count(distinct c) into v_distinct
  from unnest(coalesce(v_alias.confirmers, '{}'::uuid[])) c;
  if (v_alias.confirm_count >= 3 or v_distinct >= 2) and v_alias.status <> 'auto' then
    update public.stock_material_aliases
      set status = 'auto', updated_at = now()
      where id = v_alias.id
      returning * into v_alias;
    insert into public.material_alias_events(
      alias_id, action, actor_id, source_table, source_id, raw_name, raw_unit,
      new_item_id, new_sku_id, new_factor, new_line_class
    ) values (
      v_alias.id, 'auto_promoted', v_actor, p_source_table, p_source_id, p_raw_name, p_raw_unit,
      v_alias.kitchen_inventory_item_id, v_alias.tan_tao_sku_id, v_alias.conversion_factor,
      v_alias.line_class
    );
  end if;

  -- [2026-10-20] An admin (owner / Q7 stock editor) confirming is trusted
  -- immediately: the alias becomes auto on that single confirmation.
  if v_alias.status <> 'auto' and public.material_alias_can_admin(v_actor) then
    update public.stock_material_aliases
      set status = 'auto', updated_at = now()
      where id = v_alias.id
      returning * into v_alias;
    insert into public.material_alias_events(
      alias_id, action, actor_id, source_table, source_id, raw_name, raw_unit,
      new_item_id, new_sku_id, new_factor, new_line_class
    ) values (
      v_alias.id, 'auto_promoted', v_actor, p_source_table, p_source_id, p_raw_name, p_raw_unit,
      v_alias.kitchen_inventory_item_id, v_alias.tan_tao_sku_id, v_alias.conversion_factor,
      v_alias.line_class
    );
  end if;

  -- Apply the confirmed alias to the already-confirmed receipt lines of the same
  -- supplier, exactly like resolve_stock_alias does. [Giai đoạn 3] a non_stock
  -- alias never posts anything.
  if p_line_class = 'stock' then
    v_cutover := public.stock_ledger_cutover_date(p_location);
    for v_target in
      select gri.id
      from public.goods_receipt_items gri
      join public.goods_receipts gr on gr.id = gri.goods_receipt_id
      where gr.supplier_id is not distinct from p_supplier_id
        and gr.receiving_location = p_location
        and gr.status in ('confirmed', 'received')
        and (v_cutover is null or gr.receipt_date >= v_cutover)
        and public.normalize_stock_item_name(
              coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
            ) = v_norm
      order by gr.receipt_date asc, gri.created_at asc, gri.id asc
    loop
      if not public.stock_goods_receipt_item_is_posted(v_target.id) then
        if public.post_stock_goods_receipt_item(v_target.id, v_alias) then
          v_applied := v_applied + 1;
        end if;
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'status', v_action,
    'alias', to_jsonb(v_alias),
    'applied_lines', v_applied,
    'promoted', v_alias.status = 'auto'
  );
end;
$$;

-- The old 12-argument signature keeps working for the current hook.
create or replace function public.confirm_material_alias(
  p_supplier_id uuid,
  p_location text,
  p_raw_name text,
  p_raw_unit text,
  p_kitchen_inventory_item_id uuid,
  p_tan_tao_sku_id uuid,
  p_entered_unit_label text,
  p_conversion_factor numeric,
  p_jev_item_id uuid,
  p_jev_probability numeric,
  p_source_table text,
  p_source_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return public.confirm_material_alias(
    p_supplier_id,
    p_location,
    p_raw_name,
    p_raw_unit,
    p_kitchen_inventory_item_id,
    p_tan_tao_sku_id,
    p_entered_unit_label,
    p_conversion_factor,
    p_jev_item_id,
    p_jev_probability,
    p_source_table,
    p_source_id,
    'stock'
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. create_stock_material_item: Q7 editor creates a new kitchen item
-- ---------------------------------------------------------------------------

-- Idempotency ledger: request_id -> the item that was created / reused.
create table if not exists public.material_alias_item_requests (
  request_id uuid primary key,
  item_id uuid not null references public.kitchen_inventory_items(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

alter table public.material_alias_item_requests enable row level security;

revoke all on table public.material_alias_item_requests from public, anon, authenticated;
grant select, insert, update, delete on table public.material_alias_item_requests to service_role;

create or replace function public.create_stock_material_item(
  p_name text,
  p_unit text,
  p_location text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_name text := btrim(coalesce(p_name, ''));
  v_unit text := btrim(coalesce(p_unit, ''));
  v_norm text;
  v_item uuid;
  v_existing uuid;
  v_code text;
  v_counter integer;
  v_key text;
  v_created boolean := false;
begin
  if p_location not in ('q7', 'tan_tao') then
    raise exception 'unsupported_location' using errcode = '22023';
  end if;
  -- Owner or the existing Q7 / kitchen inventory edit permission.
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not public.q7_material_inventory_can_edit(v_actor) then
      raise exception 'create_item_forbidden' using errcode = '42501';
    end if;
  end if;

  if v_name = '' then raise exception 'item_name_required' using errcode = '22023'; end if;
  if v_unit = '' then raise exception 'item_unit_required' using errcode = '22023'; end if;

  v_norm := public.normalize_stock_item_name(v_name);
  if v_norm is null then v_norm := lower(v_name); end if;

  -- Idempotent by request id: serialise concurrent callers, then replay.
  if p_request_id is not null then
    perform pg_advisory_xact_lock(hashtext('material_alias_item:' || p_request_id::text));
    select r.item_id into v_existing
    from public.material_alias_item_requests r
    where r.request_id = p_request_id;
    if v_existing is not null then
      return jsonb_build_object('item_id', v_existing, 'created', false);
    end if;
  end if;

  -- Reuse an existing active, unmerged item with the same normalized name.
  select kii.id into v_existing
  from public.kitchen_inventory_items kii
  where kii.active = true
    and kii.merged_into_id is null
    and public.normalize_stock_item_name(kii.name) = v_norm
  order by kii.created_at asc, kii.id asc
  limit 1;
  if v_existing is not null then
    v_item := v_existing;
  else
    select count(*) filter (where kii.item_type = 'ingredient') into v_counter
    from public.kitchen_inventory_items kii;
    loop
      v_counter := v_counter + 1;
      v_code := 'NVL-' || lpad(v_counter::text, 3, '0');
      exit when not exists (
        select 1 from public.kitchen_inventory_items kii where kii.item_code = v_code
      );
    end loop;

    v_key := 'manual:' || v_norm;
    if exists (select 1 from public.kitchen_inventory_items kii where kii.normalized_key = v_key) then
      v_key := v_key || ':' || lower(v_code);
    end if;

    insert into public.kitchen_inventory_items (
      item_code, normalized_key, item_type, name, unit, standard_unit_cost, active
    ) values (
      v_code, v_key, 'ingredient', v_name, v_unit, 0, true
    )
    returning id into v_item;
    v_created := true;
  end if;

  if p_request_id is not null then
    insert into public.material_alias_item_requests (request_id, item_id, created_by)
    values (p_request_id, v_item, v_actor)
    on conflict (request_id) do update
      set item_id = public.material_alias_item_requests.item_id;
  end if;

  return jsonb_build_object('item_id', v_item, 'created', v_created);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Function grants
-- ---------------------------------------------------------------------------

revoke all on function public.material_alias_clean_name(text) from public, anon;
grant execute on function public.material_alias_clean_name(text) to authenticated, service_role;

revoke all on function public.material_alias_match_tokens(text) from public, anon;
grant execute on function public.material_alias_match_tokens(text) to authenticated, service_role;

revoke all on function public.material_alias_tokens_match(text, text) from public, anon;
grant execute on function public.material_alias_tokens_match(text, text) to authenticated, service_role;

revoke all on function public.material_alias_candidates(text, text, integer) from public, anon;
grant execute on function public.material_alias_candidates(text, text, integer) to authenticated, service_role;

revoke all on function public.increment_stock_catalog_jev_usage(date, integer, numeric) from public, anon, authenticated;
grant execute on function public.increment_stock_catalog_jev_usage(date, integer, numeric) to service_role;

revoke all on function public.get_material_alias_backlog_review(text, integer) from public, anon;
grant execute on function public.get_material_alias_backlog_review(text, integer) to authenticated, service_role;

revoke all on function public.confirm_material_alias(uuid, text, text, text, uuid, uuid, text, numeric, uuid, numeric, text, uuid, text) from public, anon;
grant execute on function public.confirm_material_alias(uuid, text, text, text, uuid, uuid, text, numeric, uuid, numeric, text, uuid, text) to authenticated, service_role;

revoke all on function public.confirm_material_alias(uuid, text, text, text, uuid, uuid, text, numeric, uuid, numeric, text, uuid) from public, anon;
grant execute on function public.confirm_material_alias(uuid, text, text, text, uuid, uuid, text, numeric, uuid, numeric, text, uuid) to authenticated, service_role;

revoke all on function public.create_stock_material_item(text, text, text, uuid) from public, anon;
grant execute on function public.create_stock_material_item(text, text, text, uuid) to authenticated, service_role;
