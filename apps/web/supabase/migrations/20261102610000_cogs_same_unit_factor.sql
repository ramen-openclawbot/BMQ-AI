-- 2026-10-22 — cogs_refresh_mappings: a recipe line in the same count unit as
-- its only kho item (Bánh mì lớn cái → cái, Tương ớt Cholimex gói → gói) gets
-- factor 1; stock_unit_line_factor only knows weights and volumes, so these
-- were left 'suggested' with reason 'unit'. Body otherwise identical to
-- 20261102590000.

create or replace function public.cogs_refresh_mappings()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_rec record;
  v_item_id uuid;
  v_item_name text;
  v_item_unit text;
  v_item_pastry boolean;
  v_existing public.revenue_product_sku_map%rowtype;
  v_existing_ing public.cogs_ingredient_stock_map%rowtype;
  v_sku_id uuid;
  v_map_id uuid;
  v_status text;
  v_source text;
  v_confidence numeric;
  v_evidence jsonb;
  v_name_key text;
  v_norm text;
  v_tokens text[];
  v_sizes text[];
  v_best numeric;
  v_second numeric;
  v_best_sku uuid;
  v_best_code text;
  v_best_name text;
  v_candidates jsonb;
  v_material_name text;
  v_decision public.q7_bom_line_decisions%rowtype;
  v_q7map public.q7_material_issue_material_mappings%rowtype;
  v_count integer;
  v_location text;
  v_factor numeric;
  v_has_movement boolean;
  v_action text;
  v_reason text;
begin
  if not (
    coalesce(auth.role(), '') = 'service_role'
    or (v_actor is not null and (
      public.has_role(v_actor, 'owner')
      or public.material_alias_can_admin(v_actor)
    ))
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- -----------------------------------------------------------------------
  -- Revenue products: last 120 days of approved, positive revenue lines.
  -- -----------------------------------------------------------------------
  -- Candidate SKUs for the name rule, built once per refresh: finished
  -- goods on production orders of the last 90 days, under their own name and
  -- under the order line's name.
  create temp table if not exists pg_temp.cogs_bf_cand (
    sku_id uuid,
    sku_code text,
    name text,
    toks text[],
    sizes text[]
  ) on commit drop;
  truncate table pg_temp.cogs_bf_cand;

  insert into pg_temp.cogs_bf_cand(sku_id, sku_code, name, toks, sizes)
  with candidate_names as (
    select ps.id as sku_id, ps.sku_code, ps.product_name as name
    from public.product_skus ps
    where ps.sku_type = 'finished_good'
      and exists (
        select 1
        from public.production_order_items poi
        join public.production_orders po on po.id = poi.production_order_id
        where poi.sku_id = ps.id
          and coalesce(poi.delivery_date, po.planned_start_date, po.created_at::date)
              >= v_today - 90
      )
    union
    select distinct ps.id, ps.sku_code, poi.product_name
    from public.production_order_items poi
    join public.production_orders po on po.id = poi.production_order_id
    join public.product_skus ps on ps.id = poi.sku_id
    where ps.sku_type = 'finished_good'
      and coalesce(poi.delivery_date, po.planned_start_date, po.created_at::date)
          >= v_today - 90
  ),
  normalized as (
    select sku_id, sku_code, name,
           regexp_replace(
             coalesce(public.normalize_stock_item_name(name), ''),
             '^bmq\s*-\s*', '', 'i'
           ) as norm_name
    from candidate_names
  )
  select sku_id, sku_code, name,
         array(
           select distinct t
           from unnest(regexp_split_to_array(norm_name, '\s+')) t
           where t <> ''
             and t !~ '^[0-9]+([.,][0-9]+)?(kg|g|gr|gram|ml|l)$'
           order by t
         ),
         array(
           select distinct m[1] || m[3]
           from regexp_matches(
             norm_name,
             '([0-9]+([.,][0-9]+)?)\s*(kg|g|gr|gram|ml|l)\y',
             'g'
           ) m
           order by m[1] || m[3]
         )
  from normalized;

  for v_rec in
    with lines as (
      select l.channel,
             l.product_code,
             regexp_replace(
               coalesce(public.normalize_stock_item_name(l.product_name), ''),
               '^bmq\s*-\s*', '', 'i'
             ) as name_key,
             l.revenue_date,
             l.id,
             nullif(btrim(l.raw_payload ->> 'sku_id'), '') as payload_sku_id,
             lower(nullif(btrim(l.raw_payload ->> 'sku_code'), '')) as payload_sku_code
      from public.revenue_ledger_lines l
      where l.approval_status = 'approved'
        and l.quantity > 0
        and l.revenue_date >= v_today - 120
        and l.revenue_date <= v_today
    )
    select channel, product_code, name_key,
           (array_agg(payload_sku_id order by revenue_date desc, id desc)
              filter (where payload_sku_id is not null))[1] as payload_sku_id,
           (array_agg(payload_sku_code order by revenue_date desc, id desc)
              filter (where payload_sku_code is not null))[1] as payload_sku_code
    from lines
    group by channel, product_code, name_key
    order by channel, product_code, name_key
  loop
    v_name_key := v_rec.name_key;
    v_sku_id := null;
    v_status := null;
    v_source := 'production_name';
    v_confidence := null;
    v_evidence := '{}'::jsonb;

    v_existing := null;
    select * into v_existing
    from public.revenue_product_sku_map m
    where coalesce(m.channel, '') = coalesce(v_rec.channel, '')
      and coalesce(m.product_code, '') = coalesce(v_rec.product_code, '')
      and coalesce(m.name_key, '') = coalesce(v_name_key, '')
    limit 1;

    if found and v_existing.status in ('confirmed', 'rejected') then
      continue;
    end if;

    -- 1. exact product code
    if v_rec.product_code is not null and btrim(v_rec.product_code) <> '' then
      select ps.id into v_sku_id
      from public.product_skus ps
      where lower(btrim(ps.sku_code)) = lower(btrim(v_rec.product_code))
      order by ps.id::text
      limit 1;
      if v_sku_id is not null then
        v_status := 'auto';
        v_source := 'exact_code';
        v_confidence := 1;
      end if;
    end if;

    -- 2. the payload carries a SKU id or code
    if v_sku_id is null
       and (v_rec.payload_sku_id is not null or v_rec.payload_sku_code is not null) then
      select ps.id into v_sku_id
      from public.product_skus ps
      where ps.id::text = v_rec.payload_sku_id
         or lower(btrim(ps.sku_code)) = v_rec.payload_sku_code
      order by (ps.id::text = coalesce(v_rec.payload_sku_id, '')) desc, ps.id::text
      limit 1;
      if v_sku_id is not null then
        v_status := 'auto';
        v_source := 'payload_sku';
        v_confidence := 1;
      end if;
    end if;

    -- 3. production-order name score. Size tokens must agree when both sides
    --    carry one, so a 50g name is never mapped to a 160g SKU.
    if v_sku_id is null then
      v_norm := coalesce(v_name_key, '');
      select coalesce(array_agg(distinct t order by t), '{}'::text[])
        into v_tokens
      from unnest(regexp_split_to_array(v_norm, '\s+')) t
      where t <> ''
        and t !~ '^[0-9]+([.,][0-9]+)?(kg|g|gr|gram|ml|l)$';

      select coalesce(array_agg(distinct m[1] || m[3] order by m[1] || m[3]), '{}'::text[])
        into v_sizes
      from regexp_matches(
        v_norm,
        '([0-9]+([.,][0-9]+)?)\s*(kg|g|gr|gram|ml|l)\y',
        'g'
      ) m;

      create temp table if not exists pg_temp.cogs_bf_score (
        sku_id uuid,
        sku_code text,
        name text,
        score numeric
      ) on commit drop;
      truncate table pg_temp.cogs_bf_score;

      insert into pg_temp.cogs_bf_score(sku_id, sku_code, name, score)
      select c.sku_id, c.sku_code, c.name,
             round(
               case
                 when cardinality(c.toks) = 0 then 0
                 when cardinality(c.sizes) > 0
                      and cardinality(v_sizes) > 0
                      and c.sizes <> v_sizes then 0
                 else (
                   select count(*)::numeric
                   from unnest(c.toks) tk
                   where tk = any(v_tokens)
                 ) / greatest(cardinality(c.toks), cardinality(v_tokens), 1)
               end,
               4
             )
      from pg_temp.cogs_bf_cand c
      where cardinality(c.toks) > 0;

      v_candidates := '[]'::jsonb;
      select coalesce(
               jsonb_agg(
                 jsonb_build_object(
                   'sku_id', sku_id,
                   'sku_code', sku_code,
                   'name', name,
                   'score', score
                 )
                 order by score desc, sku_code
               ),
               '[]'::jsonb
             )
        into v_candidates
      from (
        select distinct on (sku_id) sku_id, sku_code, name, score
        from pg_temp.cogs_bf_score
        order by sku_id, score desc, sku_code
      ) deduped;

      select sku_id, sku_code, name, score
        into v_best_sku, v_best_code, v_best_name, v_best
      from (
        select distinct on (sku_id) sku_id, sku_code, name, score
        from pg_temp.cogs_bf_score
        order by sku_id, score desc, sku_code
      ) deduped
      order by score desc, sku_code
      limit 1;

      select score into v_second
      from (
        select distinct on (sku_id) sku_id, sku_code, name, score
        from pg_temp.cogs_bf_score
        order by sku_id, score desc, sku_code
      ) deduped
      order by score desc, sku_code
      offset 1 limit 1;

      if v_best is not null and v_best >= 0.85
         and (v_second is null or v_best - v_second >= 0.15) then
        v_status := 'auto';
        v_source := 'production_name';
        v_confidence := round(v_best, 4);
        v_sku_id := v_best_sku;
        v_evidence := jsonb_build_object(
          'rule', 'production_name',
          'best', jsonb_build_object(
            'sku_id', v_best_sku,
            'sku_code', v_best_code,
            'name', v_best_name,
            'score', v_best
          ),
          'candidates', v_candidates
        );
      else
        v_status := 'suggested';
        v_source := 'production_name';
        v_confidence := case when v_best is null then null else round(v_best, 4) end;
        v_sku_id := null;
        v_evidence := jsonb_build_object(
          'rule', 'production_name',
          'candidates', v_candidates
        );
      end if;
    end if;

    if v_status is null then
      v_status := 'suggested';
      v_source := 'production_name';
      v_evidence := jsonb_build_object('rule', 'production_name', 'candidates', '[]'::jsonb);
    end if;

    if v_existing.id is null then
      insert into public.revenue_product_sku_map(
        channel, product_code, name_key, sku_id, units_per_revenue_unit,
        status, source, confidence, evidence
      ) values (
        v_rec.channel, v_rec.product_code, v_name_key, v_sku_id, 1,
        v_status, v_source, v_confidence, v_evidence
      );
    else
      update public.revenue_product_sku_map
      set sku_id = v_sku_id,
          status = v_status,
          source = v_source,
          confidence = v_confidence,
          evidence = v_evidence,
          updated_at = now()
      where id = v_existing.id
        and status not in ('confirmed', 'rejected');
    end if;
  end loop;

  -- -----------------------------------------------------------------------
  -- Ingredients used by mapped finished SKUs.
  -- -----------------------------------------------------------------------
  for v_rec in
    select distinct
           f.canonical_material_id,
           public.normalize_document_unit(f.unit) as recipe_unit
    from (
      select f.canonical_material_id, f.unit, v.sku_id
      from public.sku_cogs_version_formulations f
      join public.sku_cogs_versions v on v.id = f.version_id
      where f.canonical_material_id is not null
        and v.effective_from <= v_today
        and (v.effective_to is null or v.effective_to >= v_today - 120)
        and not exists (
          select 1
          from public.sku_cogs_version_formulations child
          where child.version_id = f.version_id
            and position(f.ingredient_name || ' > ' in child.ingredient_name) = 1
        )
      union all
      select f.canonical_material_id, f.unit, f.sku_id
      from public.sku_formulations f
      where f.canonical_material_id is not null
        and not exists (
          select 1
          from public.sku_formulations child
          where child.sku_id = f.sku_id
            and position(f.ingredient_name || ' > ' in child.ingredient_name) = 1
        )
    ) f
    where f.canonical_material_id is not null
      and public.normalize_document_unit(f.unit) is not null
      and exists (
        select 1
        from public.revenue_product_sku_map m
        where m.status in ('auto', 'confirmed')
          and m.sku_id = f.sku_id
      )
    order by 1, 2
  loop
    v_existing_ing := null;
    select * into v_existing_ing
    from public.cogs_ingredient_stock_map m
    where m.canonical_material_id = v_rec.canonical_material_id
      and m.recipe_unit = v_rec.recipe_unit
    limit 1;

    if found and v_existing_ing.status in ('confirmed', 'rejected') then
      continue;
    end if;

    v_item_id := null;
    v_item_name := null;
    v_item_unit := null;
    v_item_pastry := null;
    v_action := null;
    v_location := null;
    v_factor := null;
    v_status := 'suggested';
    v_source := 'kho_canonical';
    v_reason := null;
    v_evidence := '{}'::jsonb;

    -- 1. an active Q7 BOM decision that drops the line (not_tracked /
    --    bom_error) wins. A 'remap' decision rewrites the Q7 PXK mapping row,
    --    so step 2 already follows it.
    select * into v_decision
    from public.q7_bom_line_decisions d
    where d.active = true
      and d.action in ('not_tracked', 'bom_error')
      and d.canonical_material_id = v_rec.canonical_material_id
      and lower(btrim(d.source_unit)) = lower(btrim(v_rec.recipe_unit))
    order by d.created_at desc, d.id::text
    limit 1;

    if found then
      v_source := 'q7_bom_decision';
      v_action := 'not_tracked';
      v_status := 'auto';
      v_reason := v_decision.action;
      v_evidence := jsonb_build_object(
        'decision_id', v_decision.id,
        'decision_action', v_decision.action
      );
    else
      -- 2. the approved Q7 PXK mapping: the item and factor the material
      --    issue posts with today (generate_q7_production_material_issue
      --    multiplies the recipe qty by conversion_factor).
      v_q7map := null;
      select * into v_q7map
      from public.q7_material_issue_material_mappings m
      where m.approval_status = 'approved'
        and m.canonical_material_id = v_rec.canonical_material_id
        and lower(btrim(m.source_unit)) = lower(btrim(v_rec.recipe_unit))
      order by m.id::text
      limit 1;
    end if;

    if v_action is null and v_q7map.id is not null
       and v_q7map.kitchen_inventory_item_id is not null
       and coalesce(v_q7map.conversion_factor, 0) > 0 then
      v_source := 'q7_pxk_mapping';
      v_action := 'deduct';
      v_location := 'q7';
      v_item_id := v_q7map.kitchen_inventory_item_id;
      v_factor := v_q7map.conversion_factor;
      v_status := 'auto';
      v_evidence := jsonb_build_object(
        'q7_mapping_id', v_q7map.id,
        'kitchen_unit', v_q7map.kitchen_unit
      );
    elsif v_action is null then
      -- 3. the single active kho item linked to the material.
      select count(*) into v_count
      from public.kitchen_inventory_items kii
      where kii.canonical_material_id = v_rec.canonical_material_id
        and kii.active = true
        and kii.merged_into_id is null;

      if v_count = 1 then
        select kii.id, kii.name, kii.unit, kii.pastry_q7
          into v_item_id, v_item_name, v_item_unit, v_item_pastry
        from public.kitchen_inventory_items kii
        where kii.canonical_material_id = v_rec.canonical_material_id
          and kii.active = true
          and kii.merged_into_id is null
        order by kii.id::text
        limit 1;

        v_location := case when v_item_pastry then 'q7' else 'tan_tao' end;

        v_factor := public.stock_unit_line_factor(v_rec.recipe_unit, v_item_unit);
        -- Same count unit on both sides (cái → cái, gói → gói) is 1:1.
        if v_factor is null and lower(btrim(v_rec.recipe_unit)) = lower(btrim(v_item_unit)) then
          v_factor := 1;
        end if;
        if v_factor is null then
          select f.factor into v_factor
          from public.stock_item_unit_factors f
          where f.kitchen_inventory_item_id = v_item_id
            and lower(btrim(f.unit)) = lower(btrim(v_rec.recipe_unit))
          order by f.updated_at desc, f.id::text
          limit 1;
        end if;
        if v_factor is null then
          select c.factor into v_factor
          from public.material_unit_conversions c
          where c.material_id = v_rec.canonical_material_id
            and c.active = true
            and c.approved = true
            and c.effective_from <= v_today
            and (c.effective_to is null or v_today <= c.effective_to)
            and lower(btrim(c.from_unit)) = lower(btrim(v_rec.recipe_unit))
            and lower(btrim(c.to_unit)) = lower(btrim(v_item_unit))
          order by c.effective_from desc, c.id::text desc
          limit 1;
        end if;

        if v_location = 'q7' then
          select exists (
            select 1
            from public.q7_inventory_movements m
            where m.kitchen_inventory_item_id = v_item_id
          ) into v_has_movement;
        else
          select exists (
            select 1
            from public.tan_tao_material_movements m
            where m.kitchen_inventory_item_id = v_item_id
          ) into v_has_movement;
        end if;

        v_evidence := jsonb_build_object(
          'item_id', v_item_id,
          'item_name', v_item_name,
          'item_unit', v_item_unit,
          'has_movements', v_has_movement
        );

        if v_factor is not null and v_has_movement then
          v_action := 'deduct';
          v_status := 'auto';
          v_source := 'kho_canonical';
          v_reason := null;
        else
          v_action := case when v_factor is not null then 'deduct' else null end;
          v_status := 'suggested';
          v_source := 'kho_canonical';
          v_reason := case when v_factor is null then 'unit' else 'never_stocked' end;
        end if;
      elsif v_count = 0 then
        v_status := 'suggested';
        v_source := 'kho_canonical';
        v_reason := 'no_item';
        v_evidence := jsonb_build_object('items', '[]'::jsonb);
      else
        v_status := 'suggested';
        v_source := 'kho_canonical';
        v_reason := 'several_items';
        select coalesce(
                 jsonb_agg(jsonb_build_object(
                   'item_id', kii.id,
                   'name', kii.name,
                   'unit', kii.unit,
                   'pastry_q7', kii.pastry_q7
                 ) order by kii.name, kii.id::text),
                 '[]'::jsonb
               )
          into v_evidence
        from (
          select kii.*
          from public.kitchen_inventory_items kii
          where kii.canonical_material_id = v_rec.canonical_material_id
            and kii.active = true
            and kii.merged_into_id is null
          order by kii.name, kii.id::text
          limit 10
        ) kii;
        v_evidence := jsonb_build_object('items', v_evidence);
      end if;
    end if;

    if v_existing_ing.id is null then
      insert into public.cogs_ingredient_stock_map(
        canonical_material_id, recipe_unit, action, location,
        kitchen_inventory_item_id, factor, status, source, reason, evidence
      ) values (
        v_rec.canonical_material_id, v_rec.recipe_unit, v_action, v_location,
        v_item_id, v_factor, v_status, v_source, v_reason, v_evidence
      );
    else
      update public.cogs_ingredient_stock_map
      set action = v_action,
          location = v_location,
          kitchen_inventory_item_id = v_item_id,
          factor = v_factor,
          status = v_status,
          source = v_source,
          reason = v_reason,
          evidence = v_evidence,
          updated_at = now()
      where id = v_existing_ing.id
        and status not in ('confirmed', 'rejected');
    end if;
  end loop;

  return jsonb_build_object(
    'revenue_product',
    coalesce((
      select jsonb_object_agg(status, cnt)
      from (
        select status, count(*)::integer as cnt
        from public.revenue_product_sku_map
        group by status
      ) s
    ), '{}'::jsonb),
    'ingredient',
    coalesce((
      select jsonb_object_agg(status, cnt)
      from (
        select status, count(*)::integer as cnt
        from public.cogs_ingredient_stock_map
        group by status
      ) s
    ), '{}'::jsonb)
  );
end;
$$;

revoke all on function public.cogs_refresh_mappings() from public, anon;
grant execute on function public.cogs_refresh_mappings() to authenticated, service_role;
