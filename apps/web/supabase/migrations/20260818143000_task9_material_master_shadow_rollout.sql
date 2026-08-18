-- Task 9: additive material-master shadow rollout dashboard.
-- Read-only rollout status only: no historical backfill, merge, rewrite, or hard
-- enforcement. Canonical root remains public.sku_cogs_materials. Fuzzy/AI
-- candidates remain pending human approval.

insert into public.material_master_enforcement_config (source_type, mode)
values ('kitchen_inventory', 'shadow')
on conflict (source_type) do nothing;

create or replace view public.material_master_shadow_rollout_dashboard as
with configured_sources as (
  select cfg.source_type, cfg.mode, cfg.updated_at as mode_updated_at
  from public.material_master_enforcement_config cfg
), request_agg as (
  select
    lower(btrim(r.source_type)) as source_type,
    count(*)::bigint as queue_total_count,
    count(*) filter (where r.status = 'pending')::bigint as queue_pending_count,
    count(*) filter (where r.status in ('resolved_existing', 'created_new'))::bigint as queue_resolved_count,
    count(*) filter (where r.status = 'rejected')::bigint as queue_blocked_count,
    min(r.created_at) filter (where r.status = 'pending') as oldest_queue_created_at,
    max(r.created_at) as latest_queue_created_at,
    jsonb_build_object(
      'pending', count(*) filter (where r.status = 'pending'),
      'confirmation_needed', count(*) filter (where r.status = 'pending' and r.candidate_status = 'confirmation_needed'),
      'ambiguous', count(*) filter (where r.status = 'pending' and r.candidate_status = 'ambiguous'),
      'not_found', count(*) filter (where r.status = 'pending' and r.candidate_status = 'not_found'),
      'inactive', 0,
      'unit_unmapped', 0,
      'supplier_unmapped', 0,
      'controller_error', count(*) filter (where r.status = 'pending' and r.candidate_status is null),
      'resolved_exact', count(*) filter (where r.status in ('resolved_existing', 'created_new')),
      'rejected', count(*) filter (where r.status = 'rejected')
    ) as queue_buckets
  from public.material_resolution_requests r
  group by lower(btrim(r.source_type))
), kitchen_operational as (
  select
    'kitchen_inventory'::text as source_type,
    count(*)::bigint as evaluated_active_count,
    count(*) filter (where kii.canonical_material_id is null)::bigint as missing_canonical_material_id,
    count(*) filter (
      where kii.canonical_material_id is not null
        and (
          coalesce(kii.material_resolution_status, '') <> 'linked'
          or scm.active is not true
          or (select count(*)
              from public.q7_material_issue_material_mappings m
              where m.approval_status = 'approved'
                and m.kitchen_inventory_item_id = kii.id
                and m.canonical_material_id = kii.canonical_material_id
                and lower(btrim(m.kitchen_unit)) = lower(btrim(kii.unit))) <> 1
        )
    )::bigint as missing_exact_approved_link,
    count(*) filter (
      where kii.canonical_material_id is not null
        and kii.material_resolution_status = 'linked'
        and scm.active is true
        and (select count(*)
             from public.q7_material_issue_material_mappings m
             where m.approval_status = 'approved'
               and m.kitchen_inventory_item_id = kii.id
               and m.canonical_material_id = kii.canonical_material_id
               and lower(btrim(m.kitchen_unit)) = lower(btrim(kii.unit))) = 1
    )::bigint as resolved_exact_operational
  from public.kitchen_inventory_items kii
  left join public.sku_cogs_materials scm on scm.id = kii.canonical_material_id
  where kii.active = true
), sku_operational as (
  select
    'sku_cogs'::text as source_type,
    count(*)::bigint as evaluated_active_count,
    count(*) filter (where f.canonical_material_id is null)::bigint as missing_canonical_material_id,
    count(*) filter (
      where f.canonical_material_id is not null
        and (coalesce(f.material_resolution_status, '') <> 'resolved_exact' or scm.active is not true)
    )::bigint as missing_exact_approved_link,
    count(*) filter (
      where f.canonical_material_id is not null
        and f.material_resolution_status = 'resolved_exact'
        and scm.active is true
    )::bigint as resolved_exact_operational
  from public.sku_formulations f
  left join public.sku_cogs_materials scm on scm.id = f.canonical_material_id
), operational as (
  select * from kitchen_operational
  union all
  select * from sku_operational
), rollout as (
  select
    cfg.source_type,
    cfg.mode,
    coalesce(req.queue_total_count, 0)::bigint as queue_total_count,
    coalesce(req.queue_pending_count, 0)::bigint as queue_pending_count,
    coalesce(req.queue_resolved_count, 0)::bigint as queue_resolved_count,
    coalesce(req.queue_blocked_count, 0)::bigint as queue_blocked_count,
    req.oldest_queue_created_at,
    req.latest_queue_created_at,
    coalesce(req.queue_buckets, jsonb_build_object(
      'pending', 0, 'confirmation_needed', 0, 'ambiguous', 0,
      'not_found', 0, 'inactive', 0, 'unit_unmapped', 0,
      'supplier_unmapped', 0, 'controller_error', 0,
      'resolved_exact', 0, 'rejected', 0
    )) || jsonb_build_object(
      'resolved_exact_operational', coalesce(op.resolved_exact_operational, 0),
      'missing_canonical_material_id', coalesce(op.missing_canonical_material_id, 0),
      'missing_exact_approved_link', coalesce(op.missing_exact_approved_link, 0)
    ) as queue_buckets,
    coalesce(op.evaluated_active_count, 0) + coalesce(req.queue_total_count, 0) as evaluated_count,
    coalesce(op.missing_canonical_material_id, 0) as missing_canonical_material_id,
    coalesce(op.missing_exact_approved_link, 0) as missing_exact_approved_link,
    cfg.mode_updated_at
  from configured_sources cfg
  left join request_agg req on req.source_type = cfg.source_type
  left join operational op on op.source_type = cfg.source_type
)
select
  source_type,
  mode,
  queue_total_count,
  queue_pending_count,
  queue_resolved_count,
  queue_blocked_count,
  queue_buckets,
  oldest_queue_created_at,
  latest_queue_created_at,
  case
    when mode = 'disabled' then false
    when evaluated_count = 0 then false
    when queue_pending_count = 0
      and missing_canonical_material_id = 0
      and missing_exact_approved_link = 0 then true
    else false
  end as ready_for_enforcement,
  (case when mode = 'disabled' then jsonb_build_array('source_disabled') else '[]'::jsonb end
   || case when evaluated_count = 0 then jsonb_build_array('no_evaluation_evidence') else '[]'::jsonb end
   || case when queue_pending_count > 0 then jsonb_build_array('pending_resolution_queue') else '[]'::jsonb end
   || case when missing_canonical_material_id > 0 then jsonb_build_array('missing_canonical_material_id') else '[]'::jsonb end
   || case when missing_exact_approved_link > 0 then jsonb_build_array('missing_exact_approved_link') else '[]'::jsonb end) as blockers,
  mode_updated_at
from rollout;

comment on view public.material_master_shadow_rollout_dashboard is
  'Task9 read-only fail-closed rollout dashboard. Exact approved links only; fuzzy/AI candidates remain pending human approval.';

revoke all on public.material_master_shadow_rollout_dashboard from public, anon, authenticated, service_role;

create or replace function public.get_material_master_rollout_dashboard()
returns table (
  source_type text,
  mode text,
  queue_total_count bigint,
  queue_pending_count bigint,
  queue_resolved_count bigint,
  queue_blocked_count bigint,
  queue_buckets jsonb,
  oldest_queue_created_at timestamptz,
  latest_queue_created_at timestamptz,
  ready_for_enforcement boolean,
  blockers jsonb,
  mode_updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.can_view_material_master() then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  return query
  select d.source_type, d.mode, d.queue_total_count, d.queue_pending_count,
         d.queue_resolved_count, d.queue_blocked_count, d.queue_buckets,
         d.oldest_queue_created_at, d.latest_queue_created_at,
         d.ready_for_enforcement, d.blockers, d.mode_updated_at
  from public.material_master_shadow_rollout_dashboard d
  order by d.source_type;
end;
$$;

revoke all on function public.get_material_master_rollout_dashboard() from public, anon, authenticated, service_role;
grant execute on function public.get_material_master_rollout_dashboard() to authenticated, service_role;
