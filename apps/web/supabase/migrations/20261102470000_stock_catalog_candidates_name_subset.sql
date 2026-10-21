-- ---------------------------------------------------------------------------
-- Stock catalog candidates: also pair a name whose tokens are a subset of the
-- other name's tokens (same item_type), e.g. "Đường" with "Đường tinh luyện".
--
-- The function body is the 2026-10-15 definition (20261015100000) with one
-- change: the items CTE computes stock_catalog_item_tokens(kii.name) and the
-- pairs WHERE adds the guarded <@ subset rule. Signature, output columns,
-- auth gate, ordering, grants and every other rule stay identical.
-- ---------------------------------------------------------------------------

create or replace function public.get_stock_catalog_candidates()
returns table (
  left_id uuid,
  right_id uuid,
  left_name text,
  right_name text,
  left_unit text,
  right_unit text,
  left_item_type text,
  right_item_type text,
  left_issue_count_90d bigint,
  right_issue_count_90d bigint,
  left_movement_count_90d bigint,
  right_movement_count_90d bigint,
  left_canonical_material_id uuid,
  right_canonical_material_id uuid,
  left_canonical_material_code text,
  right_canonical_material_code text,
  left_to_right_factor numeric,
  right_to_left_factor numeric
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_id uuid := auth.uid();
  v_since date;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor_id is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.q7_material_inventory_can_view(v_actor_id) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  v_since := (now() at time zone 'Asia/Ho_Chi_Minh')::date - 90;

  return query
  with items as (
    select
      kii.id,
      kii.name,
      kii.unit,
      kii.item_type,
      kii.canonical_material_id,
      scm.material_code,
      public.normalize_stock_item_name(kii.name) as norm,
      public.stock_catalog_item_tokens(kii.name) as tokens
    from public.kitchen_inventory_items kii
    left join public.sku_cogs_materials scm on scm.id = kii.canonical_material_id
    where kii.active = true
  ),
  pairs as (
    select
      a.id as left_id, b.id as right_id,
      a.name as left_name, b.name as right_name,
      a.unit as left_unit, b.unit as right_unit,
      a.item_type as left_item_type, b.item_type as right_item_type,
      a.canonical_material_id as left_canonical_material_id,
      b.canonical_material_id as right_canonical_material_id,
      a.material_code as left_canonical_material_code,
      b.material_code as right_canonical_material_code
    from items a
    join items b on a.id < b.id and a.item_type = b.item_type
    where (a.norm is not null and a.norm = b.norm)
       or public.stock_catalog_token_jaccard(a.name, b.name) >= 0.6
       or (
         cardinality(a.tokens) > 0
         and cardinality(b.tokens) > 0
         and (a.tokens <@ b.tokens or b.tokens <@ a.tokens)
       )
  )
  select
    p.left_id, p.right_id, p.left_name, p.right_name, p.left_unit, p.right_unit,
    p.left_item_type, p.right_item_type,
    (
      select count(*)
      from public.production_material_issue_items pmii
      join public.production_material_issues pmi on pmi.id = pmii.material_issue_id
      where pmii.kitchen_inventory_item_id = p.left_id and pmi.issue_date >= v_since
    ),
    (
      select count(*)
      from public.production_material_issue_items pmii
      join public.production_material_issues pmi on pmi.id = pmii.material_issue_id
      where pmii.kitchen_inventory_item_id = p.right_id and pmi.issue_date >= v_since
    ),
    (
      select count(*) from public.q7_inventory_movements m
      where m.kitchen_inventory_item_id = p.left_id and m.movement_date >= v_since
    ),
    (
      select count(*) from public.q7_inventory_movements m
      where m.kitchen_inventory_item_id = p.right_id and m.movement_date >= v_since
    ),
    p.left_canonical_material_id, p.right_canonical_material_id,
    p.left_canonical_material_code, p.right_canonical_material_code,
    public.stock_unit_factor(p.left_unit, p.right_unit),
    public.stock_unit_factor(p.right_unit, p.left_unit)
  from pairs p
  order by p.left_id, p.right_id;
end;
$$;

revoke all on function public.get_stock_catalog_candidates() from public, anon;
grant execute on function public.get_stock_catalog_candidates() to authenticated, service_role;
