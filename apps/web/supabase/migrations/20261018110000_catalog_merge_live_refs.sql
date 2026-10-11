-- Owner 2026-10-11: merging asks for a unit factor only when the item being
-- retired still has live ledger rows to convert. Adds source_live_refs.
CREATE OR REPLACE FUNCTION public.get_stock_catalog_review()
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor_id uuid := auth.uid();
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_pending jsonb := '[]'::jsonb;
  v_merges jsonb := '[]'::jsonb;
  v_classes jsonb := '{}'::jsonb;
  v_usage jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor_id is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.q7_material_inventory_can_view(v_actor_id) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id,
    'kind', s.kind,
    'item_id', s.item_id,
    'item_name', i.name,
    'item_unit', i.unit,
    'other_item_id', s.other_item_id,
    'other_item_name', oi.name,
    'other_item_unit', oi.unit,
    'proposed_target_id', s.proposed_target_id,
    'target_name', ti.name,
    'target_unit', ti.unit,
    'probability', s.probability,
    'proposed_factor', s.proposed_factor,
    'factor_source', s.factor_source,
    'proposed_class', s.proposed_class,
    'prompt_version', s.prompt_version,
    'cost', s.cost,
    'created_at', s.created_at,
    'item_issue_count_90d', (
      select count(*) from public.production_material_issue_items pmii
      join public.production_material_issues pmi on pmi.id = pmii.material_issue_id
      where pmii.kitchen_inventory_item_id = s.item_id
        and pmi.issue_date >= (now() at time zone 'Asia/Ho_Chi_Minh')::date - 90
    ),
    'other_issue_count_90d', case when s.other_item_id is null then null else (
      select count(*) from public.production_material_issue_items pmii
      join public.production_material_issues pmi on pmi.id = pmii.material_issue_id
      where pmii.kitchen_inventory_item_id = s.other_item_id
        and pmi.issue_date >= (now() at time zone 'Asia/Ho_Chi_Minh')::date - 90
    ) end,
    -- Live rows the merge would convert with the factor. Zero means the item
    -- being retired carries nothing in the running ledger, so no factor is needed.
    'source_live_refs', case when s.kind <> 'merge' or s.other_item_id is null then null else (
      select
        (select count(*) from public.production_material_issue_items x where x.kitchen_inventory_item_id = src.id)
      + (select count(*) from public.q7_inventory_movements x where x.kitchen_inventory_item_id = src.id)
      + (select count(*) from public.q7_inventory_openings x where x.kitchen_inventory_item_id = src.id)
      + (select count(*) from public.q7_material_issue_material_mappings x where x.kitchen_inventory_item_id = src.id)
      + (select count(*) from public.stock_material_aliases x where x.kitchen_inventory_item_id = src.id)
      from (select case when s.proposed_target_id = s.item_id then s.other_item_id else s.item_id end as id) src
    ) end
  ) order by s.created_at desc, s.id), '[]'::jsonb)
    into v_pending
  from public.stock_catalog_suggestions s
  join public.kitchen_inventory_items i on i.id = s.item_id
  left join public.kitchen_inventory_items oi on oi.id = s.other_item_id
  left join public.kitchen_inventory_items ti on ti.id = s.proposed_target_id
  where s.status = 'pending';

  select coalesce(jsonb_agg(jsonb_build_object(
    'merge_id', m.id,
    'source_id', m.source_id,
    'source_name', si.name,
    'target_id', m.target_id,
    'target_name', ti.name,
    'factor', m.factor,
    'status', m.status,
    'applied_at', m.applied_at,
    'reverted_at', m.reverted_at,
    'can_revert', (
      m.status = 'applied'
      and not exists (
        select 1 from public.stock_item_merges x
        where x.status = 'applied'
          and x.id <> m.id
          and (x.target_id = m.target_id or x.source_id = m.target_id)
          and (x.applied_at, x.id) > (m.applied_at, m.id)
      )
    )
  ) order by m.applied_at desc, m.id), '[]'::jsonb)
    into v_merges
  from (
    select * from public.stock_item_merges order by applied_at desc, id limit 20
  ) m
  join public.kitchen_inventory_items si on si.id = m.source_id
  join public.kitchen_inventory_items ti on ti.id = m.target_id;

  select coalesce(jsonb_object_agg(class_key, class_count), '{}'::jsonb)
    into v_classes
  from (
    select coalesce(item_class, 'unclassified') as class_key, count(*)::integer as class_count
    from public.kitchen_inventory_items
    where active = true
    group by coalesce(item_class, 'unclassified')
  ) c;

  select jsonb_build_object(
    'usage_date', v_today,
    'calls', coalesce(u.calls, 0),
    'cost', coalesce(u.cost, 0),
    'call_limit', coalesce(u.call_limit, 600)
  )
    into v_usage
  from (select 1) one
  left join public.stock_catalog_jev_usage u on u.usage_date = v_today;

  return jsonb_build_object(
    'pending_suggestions', v_pending,
    'recent_merges', v_merges,
    'item_class_counts', v_classes,
    'jev_usage', v_usage
  );
end;
$function$
;

revoke all on function public.get_stock_catalog_review() from public, anon;
grant execute on function public.get_stock_catalog_review() to authenticated, service_role;
