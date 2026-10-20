-- 2026-11-02: current stock names for payment-request / purchase-order lines.
--
-- The warehouse game owns the name links in public.stock_material_aliases.
-- This read-only RPC resolves each document line through those aliases (supplier
-- first, then global, then an unambiguous any-supplier link), follows merged
-- kitchen items to the live target, and returns the current item name/code/unit.
-- It creates or changes no rows and is used only to render the documents.

create or replace function public.get_stock_item_names_for_lines(p_lines jsonb)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_line jsonb;
  v_key text;
  v_name text;
  v_location text;
  v_supplier_id uuid;
  v_norm text;
  v_distinct integer;
  v_item_id uuid;
  v_alias_location text;
  v_match text;
  v_item public.kitchen_inventory_items%rowtype;
  v_next_item public.kitchen_inventory_items%rowtype;
  v_merged_steps integer;
  v_result jsonb := '[]'::jsonb;
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'invalid_lines' using errcode = '22023';
  end if;
  if jsonb_array_length(p_lines) > 500 then
    raise exception 'invalid_lines' using errcode = '22023';
  end if;

  for v_line in
    select e.value
    from jsonb_array_elements(p_lines) with ordinality as e(value, ordinality)
    order by e.ordinality
  loop
    v_key := v_line ->> 'key';
    v_name := v_line ->> 'name';
    v_location := nullif(btrim(coalesce(v_line ->> 'location', '')), '');
    v_supplier_id := nullif(btrim(coalesce(v_line ->> 'supplier_id', '')), '')::uuid;
    v_norm := public.normalize_stock_item_name(v_name);

    if v_key is null or v_norm is null then
      continue;
    end if;

    v_match := null;
    v_item_id := null;
    v_alias_location := null;

    -- (1) same supplier and, when supplied, the same location.
    if v_supplier_id is not null then
      select
        count(distinct a.kitchen_inventory_item_id),
        min(a.kitchen_inventory_item_id::text)::uuid,
        min(a.location)
      into v_distinct, v_item_id, v_alias_location
      from public.stock_material_aliases a
      where a.normalized_name = v_norm
        and a.line_class = 'stock'
        and a.kitchen_inventory_item_id is not null
        and a.supplier_id = v_supplier_id
        and (v_location is null or a.location = v_location);

      if v_distinct = 1 then
        v_match := 'supplier';
      end if;
    end if;

    -- (2) same supplier, any location.
    if v_match is null and v_supplier_id is not null then
      select
        count(distinct a.kitchen_inventory_item_id),
        min(a.kitchen_inventory_item_id::text)::uuid,
        min(a.location)
      into v_distinct, v_item_id, v_alias_location
      from public.stock_material_aliases a
      where a.normalized_name = v_norm
        and a.line_class = 'stock'
        and a.kitchen_inventory_item_id is not null
        and a.supplier_id = v_supplier_id;

      if v_distinct = 1 then
        v_match := 'supplier';
      end if;
    end if;

    -- (3) the global, supplier-less alias.
    if v_match is null then
      select
        count(distinct a.kitchen_inventory_item_id),
        min(a.kitchen_inventory_item_id::text)::uuid,
        min(a.location)
      into v_distinct, v_item_id, v_alias_location
      from public.stock_material_aliases a
      where a.normalized_name = v_norm
        and a.line_class = 'stock'
        and a.kitchen_inventory_item_id is not null
        and a.supplier_id is null;

      if v_distinct = 1 then
        v_match := 'global';
      end if;
    end if;

    -- (4) any supplier, only when every alias points to the same item.
    if v_match is null then
      select
        count(distinct a.kitchen_inventory_item_id),
        min(a.kitchen_inventory_item_id::text)::uuid,
        min(a.location)
      into v_distinct, v_item_id, v_alias_location
      from public.stock_material_aliases a
      where a.normalized_name = v_norm
        and a.line_class = 'stock'
        and a.kitchen_inventory_item_id is not null;

      if v_distinct = 1 then
        v_match := 'any';
      end if;
    end if;

    if v_match is null then
      continue;
    end if;

    select *
    into v_item
    from public.kitchen_inventory_items k
    where k.id = v_item_id;

    -- A row variable keeps the previous line's value when no row is found.
    if not found then
      continue;
    end if;

    -- Follow at most five merge hops. A longer chain or a missing target is
    -- treated like an unusable item and omitted from the result.
    v_merged_steps := 0;
    while v_item.merged_into_id is not null and v_merged_steps < 5 loop
      select *
      into v_next_item
      from public.kitchen_inventory_items k
      where k.id = v_item.merged_into_id;

      if not found then
        v_item_id := null;
        exit;
      end if;

      v_merged_steps := v_merged_steps + 1;
      v_item := v_next_item;
    end loop;

    if v_item_id is null
       or v_item.merged_into_id is not null
       or v_item.active is not true then
      continue;
    end if;

    v_result := v_result || jsonb_build_array(
      jsonb_build_object(
        'key', v_key,
        'item_id', v_item.id,
        'item_name', v_item.name,
        'item_code', v_item.item_code,
        'unit', v_item.unit,
        'location', v_alias_location,
        'match', v_match
      )
    );
  end loop;

  return v_result;
end;
$$;

comment on function public.get_stock_item_names_for_lines(jsonb) is
  'Read-only: current stock item names for document lines, resolved through stock_material_aliases and merged_into_id chains. Writes no data.';

revoke all on function public.get_stock_item_names_for_lines(jsonb) from public, anon;
grant execute on function public.get_stock_item_names_for_lines(jsonb) to authenticated, service_role;
