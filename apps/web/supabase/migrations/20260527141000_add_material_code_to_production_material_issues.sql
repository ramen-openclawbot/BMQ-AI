-- Propagate SKU formulation material_code into production material issue rows.
-- Keep this as a new migration because 20260523124000_production_material_issues.sql is already applied.

alter table public.production_material_issue_items
  add column if not exists material_code text;

update public.production_material_issue_items
set material_code = public.generate_sku_material_code(ingredient_name)
where material_code is null or btrim(material_code) = '';

create index if not exists idx_production_material_issue_items_material_code
  on public.production_material_issue_items(material_code);

create or replace function public.create_production_material_issue(
  p_production_order_id uuid,
  p_issue_date date default current_date
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  order_row public.production_orders%rowtype;
  order_item public.production_order_items%rowtype;
  formulation_row public.sku_formulations%rowtype;
  actor_id uuid;
  resolved_finished_sku_id uuid;
  resolved_finished_sku_name text;
  finished_sku_match_count integer;
  resolved_kitchen_item_id uuid;
  kitchen_item_match_count integer;
  resolved_kitchen_item public.kitchen_inventory_items%rowtype;
  issue_id uuid;
  issue_no text;
  missing_finished_skus jsonb := '[]'::jsonb;
  missing_formulations jsonb := '[]'::jsonb;
  missing_kitchen_items jsonb := '[]'::jsonb;
  calc_count integer := 0;
  issue_item_count integer := 0;
  movement_count integer := 0;
  total numeric(16, 2) := 0;
  calc_row record;
  issue_item_id uuid;
begin
  if coalesce(auth.role(), '') <> 'service_role'
    and not public.has_role(auth.uid(), 'owner')
    and not public.has_module_permission(auth.uid(), 'production', 'edit') then
    raise exception 'Not allowed to create production material issue' using errcode = '42501';
  end if;

  actor_id := auth.uid();

  select * into order_row
  from public.production_orders
  where id = p_production_order_id
  for update;

  if not found then
    raise exception 'Production order % not found', p_production_order_id using errcode = 'P0002';
  end if;

  perform pg_advisory_xact_lock(hashtext('production_material_issue'), hashtext(p_production_order_id::text));

  create temp table if not exists pg_temp._production_material_issue_calc (
    production_order_item_id uuid not null,
    finished_sku_id uuid not null,
    ingredient_sku_id uuid,
    kitchen_inventory_item_id uuid not null,
    ingredient_name text not null,
    material_code text,
    planned_finished_qty numeric(15, 3) not null,
    dosage_qty numeric(15, 6) not null,
    wastage_percent numeric(8, 4) not null,
    required_qty numeric(15, 3) not null,
    unit text not null,
    unit_cost numeric(14, 2) not null,
    amount numeric(16, 2) not null,
    source_ref_key text not null
  ) on commit drop;

  truncate table pg_temp._production_material_issue_calc;

  for order_item in
    select *
    from public.production_order_items
    where production_order_id = p_production_order_id
    order by created_at, id
  loop
    resolved_finished_sku_id := order_item.sku_id;

    if resolved_finished_sku_id is null then
      select count(*)
        into finished_sku_match_count
      from public.product_skus
      where lower(trim(product_name)) = lower(trim(order_item.product_name));

      if coalesce(finished_sku_match_count, 0) = 1 then
        select id, product_name
          into resolved_finished_sku_id, resolved_finished_sku_name
        from public.product_skus
        where lower(trim(product_name)) = lower(trim(order_item.product_name))
        order by id::text
        limit 1;
      end if;

      if coalesce(finished_sku_match_count, 0) <> 1 then
        missing_finished_skus := missing_finished_skus || jsonb_build_array(jsonb_build_object(
          'production_order_item_id', order_item.id,
          'product_name', order_item.product_name,
          'match_count', coalesce(finished_sku_match_count, 0)
        ));
        continue;
      end if;
    end if;

    if not exists (select 1 from public.sku_formulations f where f.sku_id = resolved_finished_sku_id) then
      select product_name into resolved_finished_sku_name
      from public.product_skus
      where id = resolved_finished_sku_id;

      missing_formulations := missing_formulations || jsonb_build_array(jsonb_build_object(
        'production_order_item_id', order_item.id,
        'finished_sku_id', resolved_finished_sku_id,
        'product_name', coalesce(resolved_finished_sku_name, order_item.product_name)
      ));
      continue;
    end if;

    for formulation_row in
      select *
      from public.sku_formulations
      where sku_id = resolved_finished_sku_id
      order by sort_order nulls last, created_at, id
    loop
      resolved_kitchen_item_id := null;
      kitchen_item_match_count := 0;

      if formulation_row.ingredient_sku_id is not null then
        select count(*)
          into kitchen_item_match_count
        from public.kitchen_inventory_items
        where product_sku_id = formulation_row.ingredient_sku_id
          and active = true;

        if coalesce(kitchen_item_match_count, 0) = 1 then
          select id
            into resolved_kitchen_item_id
          from public.kitchen_inventory_items
          where product_sku_id = formulation_row.ingredient_sku_id
            and active = true
          order by id::text
          limit 1;
        end if;
      end if;

      if coalesce(kitchen_item_match_count, 0) <> 1 then
        select count(*)
          into kitchen_item_match_count
        from public.kitchen_inventory_items
        where lower(trim(name)) = lower(trim(formulation_row.ingredient_name))
          and active = true;

        if coalesce(kitchen_item_match_count, 0) = 1 then
          select id
            into resolved_kitchen_item_id
          from public.kitchen_inventory_items
          where lower(trim(name)) = lower(trim(formulation_row.ingredient_name))
            and active = true
          order by id::text
          limit 1;
        end if;
      end if;

      if coalesce(kitchen_item_match_count, 0) <> 1 then
        missing_kitchen_items := missing_kitchen_items || jsonb_build_array(jsonb_build_object(
          'production_order_item_id', order_item.id,
          'finished_sku_id', resolved_finished_sku_id,
          'ingredient_sku_id', formulation_row.ingredient_sku_id,
          'ingredient_name', formulation_row.ingredient_name,
          'match_count', coalesce(kitchen_item_match_count, 0)
        ));
        continue;
      end if;

      select * into resolved_kitchen_item
      from public.kitchen_inventory_items
      where id = resolved_kitchen_item_id;

      insert into pg_temp._production_material_issue_calc (
        production_order_item_id,
        finished_sku_id,
        ingredient_sku_id,
        kitchen_inventory_item_id,
        ingredient_name,
        material_code,
        planned_finished_qty,
        dosage_qty,
        wastage_percent,
        required_qty,
        unit,
        unit_cost,
        amount,
        source_ref_key
      ) values (
        order_item.id,
        resolved_finished_sku_id,
        formulation_row.ingredient_sku_id,
        resolved_kitchen_item_id,
        formulation_row.ingredient_name,
        coalesce(nullif(formulation_row.material_code, ''), public.generate_sku_material_code(formulation_row.ingredient_name)),
        coalesce(nullif(order_item.planned_qty, 0), order_item.ordered_qty, 0),
        coalesce(formulation_row.dosage_qty, 0),
        coalesce(formulation_row.wastage_percent, 0),
        round((coalesce(nullif(order_item.planned_qty, 0), order_item.ordered_qty, 0) * coalesce(formulation_row.dosage_qty, 0) * (1 + coalesce(formulation_row.wastage_percent, 0) / 100.0))::numeric, 3),
        coalesce(nullif(formulation_row.unit, ''), resolved_kitchen_item.unit),
        coalesce(nullif(formulation_row.unit_price, 0), resolved_kitchen_item.standard_unit_cost, 0),
        round((coalesce(nullif(order_item.planned_qty, 0), order_item.ordered_qty, 0) * coalesce(formulation_row.dosage_qty, 0) * (1 + coalesce(formulation_row.wastage_percent, 0) / 100.0) * coalesce(nullif(formulation_row.unit_price, 0), resolved_kitchen_item.standard_unit_cost, 0))::numeric, 2),
        p_production_order_id::text || ':' || order_item.id::text || ':' || formulation_row.id::text
      );
    end loop;
  end loop;

  select count(*), coalesce(sum(amount), 0)
    into calc_count, total
  from pg_temp._production_material_issue_calc;

  if calc_count = 0
    or jsonb_array_length(missing_finished_skus) > 0
    or jsonb_array_length(missing_formulations) > 0
    or jsonb_array_length(missing_kitchen_items) > 0 then
    return jsonb_build_object(
      'status', 'blocked_missing_mappings',
      'production_order_id', p_production_order_id,
      'item_count', calc_count,
      'total_amount', total,
      'missing_finished_skus', missing_finished_skus,
      'missing_formulations', missing_formulations,
      'missing_kitchen_items', missing_kitchen_items
    );
  end if;

  insert into public.production_material_issues (
    issue_number,
    production_order_id,
    source_po_inbox_id,
    revenue_draft_id,
    sales_po_doc_id,
    issue_date,
    status,
    total_amount,
    created_by
  ) values (
    public.generate_production_material_issue_number(p_issue_date),
    order_row.id,
    order_row.source_po_inbox_id,
    order_row.revenue_draft_id,
    order_row.sales_po_doc_id,
    p_issue_date,
    'posted',
    total,
    actor_id
  )
  on conflict (production_order_id) do update
    set issue_date = excluded.issue_date,
        source_po_inbox_id = excluded.source_po_inbox_id,
        revenue_draft_id = excluded.revenue_draft_id,
        sales_po_doc_id = excluded.sales_po_doc_id,
        status = 'posted',
        total_amount = excluded.total_amount,
        updated_at = now()
  returning id, issue_number into issue_id, issue_no;

  for calc_row in select * from pg_temp._production_material_issue_calc order by source_ref_key loop
    insert into public.production_material_issue_items (
      material_issue_id,
      production_order_item_id,
      finished_sku_id,
      ingredient_sku_id,
      kitchen_inventory_item_id,
      ingredient_name,
      material_code,
      planned_finished_qty,
      dosage_qty,
      wastage_percent,
      required_qty,
      unit,
      unit_cost,
      amount,
      source_ref_key
    ) values (
      issue_id,
      calc_row.production_order_item_id,
      calc_row.finished_sku_id,
      calc_row.ingredient_sku_id,
      calc_row.kitchen_inventory_item_id,
      calc_row.ingredient_name,
      calc_row.material_code,
      calc_row.planned_finished_qty,
      calc_row.dosage_qty,
      calc_row.wastage_percent,
      calc_row.required_qty,
      calc_row.unit,
      calc_row.unit_cost,
      calc_row.amount,
      calc_row.source_ref_key
    )
    on conflict (material_issue_id, source_ref_key) do update
      set kitchen_inventory_item_id = excluded.kitchen_inventory_item_id,
          ingredient_name = excluded.ingredient_name,
          material_code = excluded.material_code,
          planned_finished_qty = excluded.planned_finished_qty,
          dosage_qty = excluded.dosage_qty,
          wastage_percent = excluded.wastage_percent,
          required_qty = excluded.required_qty,
          unit = excluded.unit,
          unit_cost = excluded.unit_cost,
          amount = excluded.amount,
          updated_at = now()
    returning id into issue_item_id;

    issue_item_count := issue_item_count + 1;

    insert into public.kitchen_inventory_movements (
      movement_date,
      period_month,
      item_id,
      movement_type,
      quantity,
      unit,
      unit_cost,
      amount,
      source,
      source_ref_id,
      source_ref_key,
      note,
      created_by
    ) values (
      p_issue_date,
      date_trunc('month', p_issue_date)::date,
      calc_row.kitchen_inventory_item_id,
      'usage',
      calc_row.required_qty,
      calc_row.unit,
      calc_row.unit_cost,
      calc_row.amount,
      'production_issue',
      issue_item_id,
      calc_row.source_ref_key,
      'Auto PXK NVL from production order ' || order_row.production_number,
      actor_id
    )
    on conflict (source, source_ref_key, movement_type)
      where source = 'production_issue' and source_ref_key is not null
    do update
      set movement_date = excluded.movement_date,
          period_month = excluded.period_month,
          item_id = excluded.item_id,
          quantity = excluded.quantity,
          unit = excluded.unit,
          unit_cost = excluded.unit_cost,
          amount = excluded.amount,
          source_ref_id = excluded.source_ref_id,
          note = excluded.note,
          updated_at = now();

    movement_count := movement_count + 1;
  end loop;

  update public.production_material_issues
     set total_amount = (select coalesce(sum(amount), 0) from public.production_material_issue_items where material_issue_id = issue_id),
         updated_at = now()
   where id = issue_id
   returning total_amount into total;

  return jsonb_build_object(
    'status', 'posted',
    'issue_id', issue_id,
    'issue_number', issue_no,
    'production_order_id', p_production_order_id,
    'item_count', issue_item_count,
    'movement_count', movement_count,
    'total_amount', total,
    'missing_finished_skus', missing_finished_skus,
    'missing_formulations', missing_formulations,
    'missing_kitchen_items', missing_kitchen_items
  );
end;
$$;
