-- 2026-11-28 — HACCP prefill: only the Q7 kitchen and pastry SKUs in production.
--
-- Replaces only public.haccp_prefill(text); signature, permissions, source_key,
-- positions, logging and ON CONFLICT DO NOTHING stay the same. It reads
-- production_orders / production_order_items / sku_formulations and never writes
-- a business table.
--
-- Suppliers:
--   * finished SKUs from Q7 production orders in the last 14 days, excluding
--     cancelled orders, expanded through sku_formulations recursively (max 4
--     levels with a cycle guard);
--   * leaf canonical_material_id -> kitchen_inventory_items -> live item through
--     merged_into_id;
--   * plus Q7 packaging_supply items that are still active, not merged, and not
--     office / cleaning / chemical supplies;
--   * receipts confirmed/received in the last 180 days whose line resolves with
--     kho_receipt_line_item into that item set. No receiving_location filter:
--     central Tân Tạo receipts feed the Q7 pastry kitchen.
--
-- Chemicals: the existing name filter, restricted to pastry_q7 live items.
-- Staff: unchanged.

create or replace function public.haccp_prefill(p_table_id text)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_added integer := 0;
  v_count integer := 0;
  v_payload jsonb := '[]'::jsonb;
begin
  if not public.haccp_can_manage(v_actor) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_table_id = 'suppliers' then
    with recursive produced_skus as (
      -- Prefer actual completion, then the plan. The upper bound excludes
      -- future/draft plans; the lower bound is the 14-day production window.
      select distinct poi.sku_id
      from public.production_orders po
      join public.production_order_items poi on poi.production_order_id = po.id
      where po.location_code = 'q7'
        and po.status not in ('draft', 'cancelled')
        and coalesce(
              (po.completed_at at time zone 'Asia/Ho_Chi_Minh')::date,
              po.planned_start_date
            ) between v_today - 14 and v_today
        and poi.sku_id is not null
    ), formulation_edges as (
      -- ingredient_sku_id is often empty; the same resolver used by COGS also
      -- follows canonical material and material code to a child recipe.
      select
        f.sku_id,
        f.canonical_material_id,
        public.cogs_resolve_child_sku(
          f.ingredient_sku_id,
          f.canonical_material_id,
          f.material_code
        ) as child_sku_id
      from public.sku_formulations f
    ), recipe as (
      select sku_id, 0 as depth, array[sku_id]::uuid[] as path
      from produced_skus

      union all

      select
        e.child_sku_id,
        r.depth + 1,
        r.path || e.child_sku_id
      from recipe r
      join formulation_edges e on e.sku_id = r.sku_id
      where r.depth < 4
        and e.child_sku_id is not null
        and not (e.child_sku_id = any (r.path))
        and exists (
          select 1
          from formulation_edges child
          where child.sku_id = e.child_sku_id
        )
    ), leaf_materials as (
      select distinct e.canonical_material_id
      from recipe r
      join formulation_edges e on e.sku_id = r.sku_id
      where e.canonical_material_id is not null
        and (
          e.child_sku_id is null
          or not exists (
            select 1
            from formulation_edges child
            where child.sku_id = e.child_sku_id
          )
        )
    ), ingredient_items as (
      select kii.id
      from public.kitchen_inventory_items kii
      join leaf_materials lm on lm.canonical_material_id = kii.canonical_material_id

      union

      -- Catalog cleanup can leave canonical_material_id null, but the approved
      -- COGS / Q7 issue mappings still point at the live stock item.
      select m.kitchen_inventory_item_id
      from public.cogs_ingredient_stock_map m
      join leaf_materials lm on lm.canonical_material_id = m.canonical_material_id
      where m.action = 'deduct'
        and m.status in ('auto', 'confirmed')
        and m.location = 'q7'
        and m.kitchen_inventory_item_id is not null

      union

      select m.kitchen_inventory_item_id
      from public.q7_material_issue_material_mappings m
      join leaf_materials lm on lm.canonical_material_id = m.canonical_material_id
      where m.approval_status = 'approved'
    ), base_items as (
      select id from ingredient_items

      union

      select kii.id
      from public.kitchen_inventory_items kii
      where kii.pastry_q7 = true
        and kii.item_class = 'packaging_supply'
        and kii.active = true
        and kii.merged_into_id is null
        -- Office / cleaning / chemical supplies only. Keep phrases specific so
        -- food packaging such as "Chai đựng nước ép" is not excluded.
        and kii.name !~* '(giấy\s*a[45]|mực\s*in|giấy\s*vệ\s*sinh|nước\s+(uống|tinh\s*khiết|suối|đóng\s*bình)|(^|\s)cồn(\s|$)|(đồ|nước|dung\s*dịch|chất|bột|xà\s*phòng)\s+rửa|nước\s+tẩy|(^|\s)mút(\s|$)|túi\s*rác|xịt\s*thơm|(khăn|giẻ|nước|dung\s*dịch|chất)\s+lau|(^|\s)lau\s+(nhà|sàn|kính|bàn|chùi|vệ\s*sinh)|javel|cloramin|khử\s*trùng|sát\s*khuẩn)'
    ), resolved_items as (
      with recursive chain(id) as (
        select id from base_items

        union

        select kii.merged_into_id
        from chain c
        join public.kitchen_inventory_items kii on kii.id = c.id
        where kii.merged_into_id is not null
      )
      select id from chain
    ), live_items as (
      select kii.id, kii.name
      from public.kitchen_inventory_items kii
      join resolved_items r on r.id = kii.id
      where kii.merged_into_id is null
    ), receipt_lines as materialized (
      -- Resolve each receipt line once; do not call kho_receipt_line_item in a
      -- join condition against the unindexed live_items CTE.
      select
        gr.supplier_id,
        public.kho_receipt_line_item(gri.id) as kitchen_item_id
      from public.goods_receipts gr
      join public.goods_receipt_items gri on gri.goods_receipt_id = gr.id
      where gr.status in ('confirmed', 'received')
        and gr.receipt_date >= v_today - 180
    ), lines as (
      select rl.supplier_id, li.name
      from receipt_lines rl
      join live_items li on li.id = rl.kitchen_item_id
    ), names as (
      -- Live catalog names are already canonical: deduplicate on the exact name.
      select distinct supplier_id, name
      from lines
      where name is not null and btrim(name) <> ''
    ), latest as (
      select
        s.id,
        s.name,
        s.phone,
        s.address,
        s.contact_name,
        string_agg(n.name, ', ' order by n.name) as items
      from public.suppliers s
      join names n on n.supplier_id = s.id
      group by s.id, s.name, s.phone, s.address, s.contact_name
    ), payload as (
      select
        l.id,
        l.name,
        l.phone,
        l.address,
        l.contact_name,
        l.items,
        'suppliers:' || l.id::text as source_key,
        jsonb_build_object(
          'name', left(coalesce(l.name, ''), 1000),
          'items', left(coalesce(l.items, ''), 1000),
          'phone', left(coalesce(l.phone, ''), 40),
          'address', left(coalesce(l.address, ''), 1000),
          'contact', left(coalesce(l.contact_name, ''), 1000)
        ) as entry_values
      from latest l
    ), numbered as (
      select payload.*, row_number() over (order by name, id) as rn
      from payload
    )
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'source_key', n.source_key,
          'entry_values', n.entry_values,
          'rn', n.rn
        ) order by n.rn
      ),
      '[]'::jsonb
    )
    into v_payload
    from numbered n;

    insert into public.haccp_entries (table_id, "values", "position", source_key, entered_by_name)
    select
      'suppliers',
      p.value -> 'entry_values',
      (
        select coalesce(max(e."position"), 0)
        from public.haccp_entries e
        where e.table_id = 'suppliers'
      ) + (p.value ->> 'rn')::integer,
      p.value ->> 'source_key',
      'app'
    from jsonb_array_elements(v_payload) p
    on conflict (source_key) do nothing;
    get diagnostics v_count = row_count;
    v_added := v_added + v_count;

  elsif p_table_id = 'staff' then
    with latest_period as (
      select p.id
      from public.payroll_bn_periods p
      order by p.date_to desc, p.period_code desc, p.id desc
      limit 1
    ), people as (
      select
        e.employee_code,
        e.employee_name,
        coalesce(nullif(btrim(e.group_name), ''), 'Bếp bánh') as department,
        row_number() over (order by e.employee_name, e.employee_code) as rn
      from public.payroll_bn_period_employees e
      join latest_period p on p.id = e.period_id
      where e.group_name = 'Bếp bánh'
    ), base as (
      select coalesce(max(x."position"), 0) as last_position
      from public.haccp_entries x
      where x.table_id = 'staff'
    )
    insert into public.haccp_entries (table_id, "values", "position", source_key, entered_by_name)
    select
      'staff',
      jsonb_build_object(
        'name', left(coalesce(p.employee_name, ''), 1000),
        'position', '',
        'department', left(coalesce(p.department, ''), 1000)
      ),
      b.last_position + p.rn,
      'staff:' || p.employee_code,
      'app'
    from people p
    cross join base b
    on conflict (source_key) do nothing;
    get diagnostics v_count = row_count;
    v_added := v_added + v_count;

  elsif p_table_id = 'chemicals' then
    with matched as (
      select
        kii.id,
        kii.name,
        row_number() over (order by kii.name, kii.id) as rn
      from public.kitchen_inventory_items kii
      where kii.active = true
        and kii.pastry_q7 = true
        and kii.merged_into_id is null
        and kii.name ~* '(^|\s)(cồn|nước rửa|nước tẩy|nước lau|tẩy rửa|javel|cloramin|khử trùng|sát khuẩn|diệt khuẩn|xà phòng)'
    ), base as (
      select coalesce(max(x."position"), 0) as last_position
      from public.haccp_entries x
      where x.table_id = 'chemicals'
    )
    insert into public.haccp_entries (table_id, "values", "position", source_key, entered_by_name)
    select
      'chemicals',
      jsonb_build_object(
        'name', left(coalesce(m.name, ''), 1000),
        'place', '',
        'purpose', '',
        'guide', ''
      ),
      b.last_position + m.rn,
      'chemicals:' || m.id::text,
      'app'
    from matched m
    cross join base b
    on conflict (source_key) do nothing;
    get diagnostics v_count = row_count;
    v_added := v_added + v_count;

  else
    raise exception 'invalid_table_id' using errcode = '22023';
  end if;

  if v_added > 0 then
    perform public.haccp_log(
      coalesce((select nullif(btrim(p.full_name), '') from public.profiles p where p.user_id = v_actor), 'Quản lý'),
      'lấy ' || v_added || ' dòng từ BMQ AI',
      p_table_id,
      null,
      'prefill',
      v_actor
    );
  end if;

  return v_added;
end;
$$;

revoke all on function public.haccp_prefill(text) from public, anon;
grant execute on function public.haccp_prefill(text) to authenticated, service_role;
