-- Rollback-only smoke for migration 20261101200000_material_link_review_speed.sql.
--
-- Run as one file (from apps/web), by the database owner/Maestro:
--   DO_NOT_TRACK=1 supabase db query --linked -f scripts/smoke_material_link_review_speed.sql
--
-- The file opens one transaction, defines the CURRENT (pre-migration) function
-- body as pg_temp.old_review, applies the new definition, then impersonates the
-- real owner from public.user_roles and proves that old and new return the same
-- jsonb for 'q7' and 'tan_tao' while the new call is under its time budget.
-- It raises 'SMOKE PASS q7=<ms> tan_tao=<ms>' and rolls back. Nothing is
-- committed and no live function definition survives the rollback.

begin;

-- Current (pre-migration) body, copied verbatim from
-- 20261101190000_material_link_defer_factor.sql with only the function name
-- changed, so it can be compared against the new definition.
create or replace function pg_temp.old_review(p_location text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_location text := lower(btrim(coalesce(p_location, '')));
  v_item record;
  v_norm text;
  v_exact_count integer;
  v_exact_id uuid;
  v_material_unit text;
  v_unit_status text;
  v_auto_factor numeric;
  v_factor_suggestion numeric;
  v_exact_material jsonb;
  v_candidates jsonb;
  v_items jsonb := '[]'::jsonb;
  v_total integer := 0;
  v_exact integer := 0;
  v_auto integer := 0;
  v_needs_factor integer := 0;
  v_none integer := 0;
  v_linked_total integer := 0;
  v_skipped integer := 0;
  v_pending_factor integer := 0;
begin
  if v_location not in ('q7', 'tan_tao') then
    raise exception 'invalid_location' using errcode = '22023';
  end if;

  for v_item in
    select kii.id, kii.item_code, kii.name, kii.unit
    from public.kitchen_inventory_items kii
    where kii.active = true
      and kii.merged_into_id is null
      and kii.canonical_material_id is null
      and (
        (v_location = 'q7' and (
          kii.pastry_q7 = true
          or exists (
            select 1 from public.q7_inventory_movements m
            where m.kitchen_inventory_item_id = kii.id
          )
        ))
        or
        (v_location = 'tan_tao' and not (
          kii.pastry_q7 = true
          or exists (
            select 1 from public.q7_inventory_movements m
            where m.kitchen_inventory_item_id = kii.id
          )
        ))
      )
      and not exists (
        select 1 from public.material_link_skips s where s.item_id = kii.id
      )
    order by kii.name, kii.id
  loop
    v_norm := public.normalize_stock_item_name(v_item.name);
    v_exact_material := null;
    v_exact_id := null;
    v_material_unit := null;
    v_unit_status := null;
    v_auto_factor := null;
    v_factor_suggestion := null;

    select count(*) into v_exact_count
    from public.sku_cogs_materials m
    where m.active = true
      and v_norm is not null
      and m.normalized_name = v_norm;

    if v_exact_count = 1 then
      select jsonb_build_object(
               'id', m.id,
               'material_code', m.material_code,
               'canonical_name', m.canonical_name,
               'default_unit', m.default_unit,
               'skus', public.material_link_material_skus(m.material_code)
             ), m.id, m.default_unit
      into v_exact_material, v_exact_id, v_material_unit
      from public.sku_cogs_materials m
      where m.active = true and m.normalized_name = v_norm
      order by m.canonical_name, m.id
      limit 1;

      v_unit_status := public.q7_unit_status(v_item.unit, v_material_unit);
      if v_unit_status = 'auto' then
        v_auto_factor := public.q7_unit_factor(v_item.unit, v_material_unit);
      elsif v_unit_status = 'needs_factor' then
        v_factor_suggestion := public.q7_unit_factor_suggestion(
          v_item.name, v_item.unit, v_material_unit
        );
      end if;

      v_exact := v_exact + 1;
      if v_unit_status = 'auto' then
        v_auto := v_auto + 1;
      elsif v_unit_status = 'needs_factor' then
        v_needs_factor := v_needs_factor + 1;
      end if;
    end if;

    -- Ứng viên: exact name (1), gần giống, và material cùng đơn vị có chung từ
    -- khoá. Xếp theo unit_status (same > auto > needs_factor) rồi score; bỏ
    -- score < 0.3 trừ khi cùng đơn vị; tối đa 3.
    select coalesce(jsonb_agg(
             jsonb_build_object(
               'id', c.id,
               'material_code', c.material_code,
               'canonical_name', c.canonical_name,
               'default_unit', c.default_unit,
               'unit_status', c.unit_status,
               'score', c.score,
               'skus', public.material_link_material_skus(c.material_code)
             ) order by c.unit_rank, c.score desc, c.canonical_name, c.id
           ), '[]'::jsonb)
    into v_candidates
    from (
      select g.id, g.material_code, g.canonical_name, g.default_unit, g.unit_status,
             case g.unit_status when 'same' then 0 when 'auto' then 1 else 2 end as unit_rank,
             g.score
      from (
        select u.id, u.material_code, u.canonical_name, u.default_unit,
               u.unit_status, max(u.score) as score
        from (
          select m.id, m.material_code, m.canonical_name, m.default_unit,
                 public.q7_unit_status(v_item.unit, m.default_unit) as unit_status,
                 1::numeric as score
          from public.sku_cogs_materials m
          where m.active = true
            and v_norm is not null
            and m.normalized_name = v_norm
          union all
          select m.id, m.material_code, m.canonical_name, m.default_unit,
                 public.q7_unit_status(v_item.unit, m.default_unit) as unit_status,
                 public.q7_material_name_similarity(v_item.name, m.canonical_name) as score
          from public.sku_cogs_materials m
          where m.active = true
          union all
          select m.id, m.material_code, m.canonical_name, m.default_unit,
                 'same'::text as unit_status,
                 public.q7_material_name_similarity(v_item.name, m.canonical_name) as score
          from public.sku_cogs_materials m
          where m.active = true
            and public.q7_unit_status(v_item.unit, m.default_unit) = 'same'
            and exists (
              select 1
              from unnest(public.material_link_name_words(v_item.name)) w
              where w = any (public.material_link_name_words(m.canonical_name))
            )
        ) u
        group by u.id, u.material_code, u.canonical_name, u.default_unit, u.unit_status
      ) g
      where g.unit_status = 'same' or g.score >= 0.3
      order by case g.unit_status when 'same' then 0 when 'auto' then 1 else 2 end,
               g.score desc, g.canonical_name, g.id
      limit 3
    ) c;

    if v_exact_material is null and jsonb_array_length(coalesce(v_candidates, '[]'::jsonb)) = 0 then
      v_none := v_none + 1;
    end if;

    v_items := v_items || jsonb_build_array(
      jsonb_build_object(
        'item_id', v_item.id,
        'item_code', v_item.item_code,
        'name', v_item.name,
        'unit', v_item.unit,
        'exact_material', v_exact_material,
        'material_unit', v_material_unit,
        'unit_status', v_unit_status,
        'auto_factor', v_auto_factor,
        'factor_suggestion', v_factor_suggestion,
        'candidates', coalesce(v_candidates, '[]'::jsonb),
        'last_buy', public.material_link_last_buy(v_item.id),
        'last_purchase_line', public.material_link_last_purchase_line(v_item.id),
        'receipt_photo_count', public.material_link_receipt_photo_count(v_item.id)
      )
    );
    v_total := v_total + 1;
  end loop;

  -- Thứ tự: exact trước, rồi có ứng viên, rồi không; trong nhóm xếp theo tên.
  select coalesce(jsonb_agg(e order by grp, name, item_id), '[]'::jsonb)
  into v_items
  from (
    select e,
           case
             when e -> 'exact_material' is not null
              and e -> 'exact_material' <> 'null'::jsonb then 0
             when jsonb_array_length(coalesce(e -> 'candidates', '[]'::jsonb)) > 0 then 1
             else 2
           end as grp,
           e ->> 'name' as name,
           e ->> 'item_id' as item_id
    from jsonb_array_elements(v_items) e
  ) t;

  select count(*) into v_linked_total
  from public.kitchen_inventory_items kii
  where kii.active = true
    and kii.merged_into_id is null
    and kii.canonical_material_id is not null
    and (
      (v_location = 'q7' and (
        kii.pastry_q7 = true
        or exists (
          select 1 from public.q7_inventory_movements m
          where m.kitchen_inventory_item_id = kii.id
        )
      ))
      or
      (v_location = 'tan_tao' and not (
        kii.pastry_q7 = true
        or exists (
          select 1 from public.q7_inventory_movements m
          where m.kitchen_inventory_item_id = kii.id
        )
      ))
    );

  select count(*) into v_skipped
  from public.material_link_skips s
  join public.kitchen_inventory_items kii on kii.id = s.item_id
  where kii.active = true
    and kii.merged_into_id is null
    and (
      (v_location = 'q7' and (
        kii.pastry_q7 = true
        or exists (
          select 1 from public.q7_inventory_movements m
          where m.kitchen_inventory_item_id = kii.id
        )
      ))
      or
      (v_location = 'tan_tao' and not (
        kii.pastry_q7 = true
        or exists (
          select 1 from public.q7_inventory_movements m
          where m.kitchen_inventory_item_id = kii.id
        )
      ))
    );

  -- Pending là các item ĐÃ nối (nằm ngoài `items`) nhưng còn thiếu hệ số.
  select count(*) into v_pending_factor
  from public.material_link_pending_factors pf
  join public.kitchen_inventory_items kii on kii.id = pf.item_id
  where kii.active = true
    and kii.merged_into_id is null
    and (
      (v_location = 'q7' and (
        kii.pastry_q7 = true
        or exists (
          select 1 from public.q7_inventory_movements m
          where m.kitchen_inventory_item_id = kii.id
        )
      ))
      or
      (v_location = 'tan_tao' and not (
        kii.pastry_q7 = true
        or exists (
          select 1 from public.q7_inventory_movements m
          where m.kitchen_inventory_item_id = kii.id
        )
      ))
    );

  return jsonb_build_object(
    'items', v_items,
    'counts', jsonb_build_object(
      'total', v_total,
      'exact', v_exact,
      'auto', v_auto,
      'needs_factor', v_needs_factor,
      'none', v_none,
      'linked_total', v_linked_total,
      'skipped', v_skipped,
      'pending_factor', v_pending_factor
    )
  );
end;
$$;

-- New definition, copied from 20261101200000_material_link_review_speed.sql.
create or replace function public.material_link_review_items_internal(p_location text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_location text := lower(btrim(coalesce(p_location, '')));
  v_item_ids uuid[];
  v_item_codes text[];
  v_item_names text[];
  v_item_units text[];
  v_item_count integer;
  v_i integer;
  v_item_id uuid;
  v_item_code text;
  v_item_name text;
  v_item_unit text;
  v_item_words text[];
  v_uid text;
  v_norm text;
  v_mat_ids uuid[];
  v_mat_codes text[];
  v_mat_names text[];
  v_mat_units text[];
  v_mat_norms text[];
  v_mat_words jsonb[];
  v_mat_skus jsonb[];
  v_unit_map jsonb := '{}'::jsonb;
  v_exact_count integer;
  v_material_unit text;
  v_unit_status text;
  v_auto_factor numeric;
  v_factor_suggestion numeric;
  v_exact_material jsonb;
  v_candidates jsonb;
  v_items jsonb := '[]'::jsonb;
  v_total integer := 0;
  v_exact integer := 0;
  v_auto integer := 0;
  v_needs_factor integer := 0;
  v_none integer := 0;
  v_linked_total integer := 0;
  v_skipped integer := 0;
  v_pending_factor integer := 0;
begin
  if v_location not in ('q7', 'tan_tao') then
    raise exception 'invalid_location' using errcode = '22023';
  end if;

  -- (1) Material set, computed once per call: canonical name, stored accent-free
  --     normalized name, name words and fed SKUs are materialized here so the
  --     item loop never recomputes them.
  select
    array_agg(m.id order by m.id),
    array_agg(m.material_code order by m.id),
    array_agg(m.canonical_name order by m.id),
    array_agg(m.default_unit order by m.id),
    array_agg(m.normalized_name order by m.id),
    array_agg(to_jsonb(public.material_link_name_words(m.canonical_name)) order by m.id),
    array_agg(public.material_link_material_skus(m.material_code) order by m.id)
  into v_mat_ids, v_mat_codes, v_mat_names, v_mat_units, v_mat_norms, v_mat_words, v_mat_skus
  from public.sku_cogs_materials m
  where m.active = true;

  v_mat_ids := coalesce(v_mat_ids, '{}'::uuid[]);
  v_mat_codes := coalesce(v_mat_codes, '{}'::text[]);
  v_mat_names := coalesce(v_mat_names, '{}'::text[]);
  v_mat_units := coalesce(v_mat_units, '{}'::text[]);
  v_mat_norms := coalesce(v_mat_norms, '{}'::text[]);
  v_mat_words := coalesce(v_mat_words, '{}'::jsonb[]);
  v_mat_skus := coalesce(v_mat_skus, '{}'::jsonb[]);

  -- (2) Item set for the location, computed once per call.
  select
    array_agg(kii.id order by kii.name, kii.id),
    array_agg(kii.item_code order by kii.name, kii.id),
    array_agg(kii.name order by kii.name, kii.id),
    array_agg(kii.unit order by kii.name, kii.id)
  into v_item_ids, v_item_codes, v_item_names, v_item_units
  from public.kitchen_inventory_items kii
  where kii.active = true
    and kii.merged_into_id is null
    and kii.canonical_material_id is null
    and (
      (v_location = 'q7' and (
        kii.pastry_q7 = true
        or exists (
          select 1 from public.q7_inventory_movements m
          where m.kitchen_inventory_item_id = kii.id
        )
      ))
      or
      (v_location = 'tan_tao' and not (
        kii.pastry_q7 = true
        or exists (
          select 1 from public.q7_inventory_movements m
          where m.kitchen_inventory_item_id = kii.id
        )
      ))
    )
    and not exists (
      select 1 from public.material_link_skips s where s.item_id = kii.id
    );

  v_item_ids := coalesce(v_item_ids, '{}'::uuid[]);
  v_item_codes := coalesce(v_item_codes, '{}'::text[]);
  v_item_names := coalesce(v_item_names, '{}'::text[]);
  v_item_units := coalesce(v_item_units, '{}'::text[]);
  v_item_count := coalesce(array_length(v_item_ids, 1), 0);

  -- (3) Unit-status map: one call per (distinct item unit × distinct material
  --     default_unit) pair, keyed by the normalized units used everywhere below.
  select coalesce(jsonb_object_agg(p.pair_key, p.unit_status), '{}'::jsonb)
  into v_unit_map
  from (
    select iu.unit_norm || '|' || mu.unit_norm as pair_key,
           public.q7_unit_status(iu.unit_norm, mu.unit_norm) as unit_status
    from (
      select distinct lower(btrim(coalesce(u, ''))) as unit_norm
      from unnest(v_item_units) u
    ) iu
    cross join (
      select distinct lower(btrim(coalesce(m.default_unit, ''))) as unit_norm
      from public.sku_cogs_materials m
      where m.active = true
    ) mu
  ) p;

  for v_i in 1 .. v_item_count loop
    v_item_id := v_item_ids[v_i];
    v_item_code := v_item_codes[v_i];
    v_item_name := v_item_names[v_i];
    v_item_unit := v_item_units[v_i];
    v_uid := lower(btrim(coalesce(v_item_unit, '')));
    v_item_words := public.material_link_name_words(v_item_name);
    v_norm := public.normalize_stock_item_name(v_item_name);

    v_exact_material := null;
    v_material_unit := null;
    v_unit_status := null;
    v_auto_factor := null;
    v_factor_suggestion := null;

    -- (4) One pass over the material set: the name similarity is evaluated once
    --     per material here, then the exact pair, the score-ranked candidates and
    --     the same-unit word-sharing candidates are all derived from these rows
    --     (dedupe by material with max(score)).
    select s.exact_count, s.exact_material, s.candidates
    into v_exact_count, v_exact_material, v_candidates
    from (
      with base as materialized (
        select
          mm.id,
          mm.material_code,
          mm.canonical_name,
          mm.default_unit,
          mm.skus,
          st.unit_status,
          (v_norm is not null and mm.norm = v_norm) as is_exact,
          (st.unit_status = 'same' and (mm.words ?| v_item_words)) as word_share,
          case
            when v_norm is not null and mm.norm = v_norm then 1::numeric
            else public.q7_material_name_similarity(v_item_name, mm.canonical_name)
          end as score
        from unnest(
          v_mat_ids, v_mat_codes, v_mat_names, v_mat_units, v_mat_norms, v_mat_words, v_mat_skus
        ) as mm(id, material_code, canonical_name, default_unit, norm, words, skus)
        cross join lateral (
          select v_unit_map ->> (v_uid || '|' || lower(btrim(coalesce(mm.default_unit, '')))) as unit_status
        ) st
      ),
      candidates as (
        select
          g.id, g.material_code, g.canonical_name, g.default_unit, g.unit_status, g.score
        from (
          select
            u.id, u.material_code, u.canonical_name, u.default_unit, u.unit_status,
            max(u.score) as score
          from (
            select id, material_code, canonical_name, default_unit, unit_status, score
            from base
            where is_exact
            union all
            select id, material_code, canonical_name, default_unit, unit_status, score
            from base
            union all
            select id, material_code, canonical_name, default_unit, 'same'::text as unit_status, score
            from base
            where unit_status = 'same' and word_share
          ) u
          group by u.id, u.material_code, u.canonical_name, u.default_unit, u.unit_status
        ) g
        where g.unit_status = 'same' or g.score >= 0.3
      )
      select
        (select count(*) from base where is_exact) as exact_count,
        (select jsonb_build_object(
                  'id', b.id,
                  'material_code', b.material_code,
                  'canonical_name', b.canonical_name,
                  'default_unit', b.default_unit,
                  'skus', b.skus
                )
           from base b
          where b.is_exact
          order by b.canonical_name, b.id
          limit 1) as exact_material,
        (select coalesce(jsonb_agg(
                  jsonb_build_object(
                    'id', c.id,
                    'material_code', c.material_code,
                    'canonical_name', c.canonical_name,
                    'default_unit', c.default_unit,
                    'unit_status', c.unit_status,
                    'score', c.score,
                    'skus', b.skus
                  ) order by case c.unit_status when 'same' then 0 when 'auto' then 1 else 2 end,
                             c.score desc, c.canonical_name, c.id
                ), '[]'::jsonb)
           from (
             select *
             from candidates
             order by case unit_status when 'same' then 0 when 'auto' then 1 else 2 end,
                      score desc, canonical_name, id
             limit 3
           ) c
           join base b on b.id = c.id) as candidates
    ) s;

    if v_exact_count = 1 then
      v_material_unit := v_exact_material ->> 'default_unit';
      v_unit_status := v_unit_map ->> (v_uid || '|' || lower(btrim(coalesce(v_material_unit, ''))));
      if v_unit_status = 'auto' then
        v_auto_factor := public.q7_unit_factor(v_item_unit, v_material_unit);
      elsif v_unit_status = 'needs_factor' then
        v_factor_suggestion := public.q7_unit_factor_suggestion(
          v_item_name, v_item_unit, v_material_unit
        );
      end if;

      v_exact := v_exact + 1;
      if v_unit_status = 'auto' then
        v_auto := v_auto + 1;
      elsif v_unit_status = 'needs_factor' then
        v_needs_factor := v_needs_factor + 1;
      end if;
    else
      v_exact_material := null;
    end if;

    if v_exact_material is null and jsonb_array_length(coalesce(v_candidates, '[]'::jsonb)) = 0 then
      v_none := v_none + 1;
    end if;

    v_items := v_items || jsonb_build_array(
      jsonb_build_object(
        'item_id', v_item_id,
        'item_code', v_item_code,
        'name', v_item_name,
        'unit', v_item_unit,
        'exact_material', v_exact_material,
        'material_unit', v_material_unit,
        'unit_status', v_unit_status,
        'auto_factor', v_auto_factor,
        'factor_suggestion', v_factor_suggestion,
        'candidates', coalesce(v_candidates, '[]'::jsonb),
        'last_buy', public.material_link_last_buy(v_item_id),
        'last_purchase_line', public.material_link_last_purchase_line(v_item_id),
        'receipt_photo_count', public.material_link_receipt_photo_count(v_item_id)
      )
    );
    v_total := v_total + 1;
  end loop;

  -- Thứ tự: exact trước, rồi có ứng viên, rồi không; trong nhóm xếp theo tên.
  select coalesce(jsonb_agg(e order by grp, name, item_id), '[]'::jsonb)
  into v_items
  from (
    select e,
           case
             when e -> 'exact_material' is not null
              and e -> 'exact_material' <> 'null'::jsonb then 0
             when jsonb_array_length(coalesce(e -> 'candidates', '[]'::jsonb)) > 0 then 1
             else 2
           end as grp,
           e ->> 'name' as name,
           e ->> 'item_id' as item_id
    from jsonb_array_elements(v_items) e
  ) t;

  select count(*) into v_linked_total
  from public.kitchen_inventory_items kii
  where kii.active = true
    and kii.merged_into_id is null
    and kii.canonical_material_id is not null
    and (
      (v_location = 'q7' and (
        kii.pastry_q7 = true
        or exists (
          select 1 from public.q7_inventory_movements m
          where m.kitchen_inventory_item_id = kii.id
        )
      ))
      or
      (v_location = 'tan_tao' and not (
        kii.pastry_q7 = true
        or exists (
          select 1 from public.q7_inventory_movements m
          where m.kitchen_inventory_item_id = kii.id
        )
      ))
    );

  select count(*) into v_skipped
  from public.material_link_skips s
  join public.kitchen_inventory_items kii on kii.id = s.item_id
  where kii.active = true
    and kii.merged_into_id is null
    and (
      (v_location = 'q7' and (
        kii.pastry_q7 = true
        or exists (
          select 1 from public.q7_inventory_movements m
          where m.kitchen_inventory_item_id = kii.id
        )
      ))
      or
      (v_location = 'tan_tao' and not (
        kii.pastry_q7 = true
        or exists (
          select 1 from public.q7_inventory_movements m
          where m.kitchen_inventory_item_id = kii.id
        )
      ))
    );

  -- Pending là các item ĐÃ nối (nằm ngoài `items`) nhưng còn thiếu hệ số.
  select count(*) into v_pending_factor
  from public.material_link_pending_factors pf
  join public.kitchen_inventory_items kii on kii.id = pf.item_id
  where kii.active = true
    and kii.merged_into_id is null
    and (
      (v_location = 'q7' and (
        kii.pastry_q7 = true
        or exists (
          select 1 from public.q7_inventory_movements m
          where m.kitchen_inventory_item_id = kii.id
        )
      ))
      or
      (v_location = 'tan_tao' and not (
        kii.pastry_q7 = true
        or exists (
          select 1 from public.q7_inventory_movements m
          where m.kitchen_inventory_item_id = kii.id
        )
      ))
    );

  return jsonb_build_object(
    'items', v_items,
    'counts', jsonb_build_object(
      'total', v_total,
      'exact', v_exact,
      'auto', v_auto,
      'needs_factor', v_needs_factor,
      'none', v_none,
      'linked_total', v_linked_total,
      'skipped', v_skipped,
      'pending_factor', v_pending_factor
    )
  );
end;
$$;

do $smoke$
declare
  v_owner uuid;
  v_loc text;
  v_old jsonb;
  v_new jsonb;
  v_t0 timestamptz;
  v_ms numeric;
  v_q7 numeric;
  v_tan_tao numeric;
  v_i integer;
  v_len integer;
  v_old_item jsonb;
  v_new_item jsonb;
  v_old_id text;
  v_new_id text;
begin
  select ur.user_id into v_owner
  from public.user_roles ur
  where ur.role = 'owner'
  order by ur.created_at, ur.user_id
  limit 1;
  if v_owner is null then
    raise exception 'SMOKE FAIL: no owner role';
  end if;

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text,
    true
  );

  foreach v_loc in array array['q7', 'tan_tao'] loop
    v_old := pg_temp.old_review(v_loc);
    v_new := public.material_link_review_items_internal(v_loc);

    if v_old is distinct from v_new then
      v_len := greatest(
        jsonb_array_length(coalesce(v_old -> 'items', '[]'::jsonb)),
        jsonb_array_length(coalesce(v_new -> 'items', '[]'::jsonb))
      );
      if v_len > 0 then
        for v_i in 0 .. v_len - 1 loop
          v_old_item := v_old -> 'items' -> v_i;
          v_new_item := v_new -> 'items' -> v_i;
          if v_old_item is distinct from v_new_item then
            v_old_id := coalesce(v_old_item ->> 'item_id', '<missing>');
            v_new_id := coalesce(v_new_item ->> 'item_id', '<missing>');
            raise exception 'SMOKE FAIL diff % index % old=% new=%',
              v_loc, v_i, v_old_id, v_new_id;
          end if;
        end loop;
      end if;
      raise exception 'SMOKE FAIL diff % (non-item difference: counts/length)',
        v_loc;
    end if;

    -- Time a warm call (the comparison call above already compiled the plan).
    v_t0 := clock_timestamp();
    perform public.material_link_review_items_internal(v_loc);
    v_ms := extract(epoch from clock_timestamp() - v_t0) * 1000;

    if v_loc = 'q7' then
      v_q7 := v_ms;
      if v_ms > 1500 then
        raise exception 'SMOKE FAIL slow % %', v_loc, round(v_ms);
      end if;
    else
      v_tan_tao := v_ms;
      if v_ms > 2500 then
        raise exception 'SMOKE FAIL slow % %', v_loc, round(v_ms);
      end if;
    end if;
  end loop;

  raise notice 'SMOKE PASS q7=% tan_tao=%', round(v_q7), round(v_tan_tao);
end;
$smoke$;

select 'ALL SMOKE PASS';

rollback;
