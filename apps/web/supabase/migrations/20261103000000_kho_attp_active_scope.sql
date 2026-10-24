-- 2026-10-24 — Checklist hồ sơ ATTP: only items the business still uses.
--
-- Owner 24/10: "Các món đã ẩn trong kho thì ẩn luôn nhà cung cấp … chỉ tập trung
-- các sản phẩm đang kinh doanh".  OFF items were already excluded; this also drops
-- items that need no paper (profile none, set or derived) and items that are in no
-- recipe of a SKU still on sale and were not used by production/sales in 60 days.
-- An item the owner put in a paper group by hand always stays.  A supplier whose
-- items all drop out disappears with them.  Same signature, gate and JSON keys.

create or replace function public.kho_attp_checklist(p_days integer default 180)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_days integer := coalesce(p_days, 180);
  v_result jsonb;
begin
  if v_days < 0 or v_days > 3650 then
    raise exception 'invalid_days' using errcode = '22023';
  end if;

  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not (
      public.q7_material_inventory_can_view(v_actor)
      or public.stock_count_can_view('tan_tao')
      or public.stock_count_can_view('q7')
      or public.kho_item_can_edit(v_actor)
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  with scoped_lines as materialized (
    select gri.id as gri_id,
           gr.supplier_id,
           gr.receipt_date,
           gri.created_at as line_created_at,
           gri.manufacturer_id,
           public.kho_receipt_line_item(gri.id) as item_id
      from public.goods_receipt_items gri
      join public.goods_receipts gr on gr.id = gri.goods_receipt_id
     where gr.status in ('confirmed', 'received')
       and gr.receipt_date >= current_date - v_days
  ),
  resolved_lines as materialized (
    select sl.gri_id,
           sl.supplier_id,
           sl.receipt_date,
           sl.line_created_at,
           sl.manufacturer_id,
           sl.item_id
      from scoped_lines sl
     where sl.item_id is not null
  ),
  scope as (
    select rl.supplier_id,
           rl.item_id,
           max(rl.receipt_date) as last_receipt_date
      from resolved_lines rl
      join public.kitchen_inventory_items kii on kii.id = rl.item_id
     where kii.active is true
       and kii.merged_into_id is null
       -- Only what the business still uses: an item the owner set to a paper
       -- group by hand, an item in the recipe of a SKU still on sale, or an
       -- item deducted by production/sales in the last 60 days.
       and coalesce(kii.attp_profile,
                    public.kho_attp_default_profile(kii.item_class, kii.item_type, kii.name)) <> 'none'
       and (
         kii.attp_profile is not null
         or exists (
           select 1
             from public.cogs_ingredient_stock_map m
             join public.sku_cogs_version_formulations f
               on f.canonical_material_id = m.canonical_material_id
             join public.sku_cogs_versions v on v.id = f.version_id
             join public.product_skus ps on ps.id = v.sku_id
            where m.kitchen_inventory_item_id = kii.id
              and ps.discontinued_at is null
              and (v.effective_to is null or v.effective_to >= current_date)
         )
         or exists (
           select 1
             from public.q7_inventory_movements qm
            where qm.kitchen_inventory_item_id = kii.id
              and qm.source in ('production_material_issue', 'signed_q7_issue', 'revenue_cogs')
              and qm.created_at >= now() - interval '60 days'
         )
         or exists (
           select 1
             from public.tan_tao_material_movements tm
            where tm.kitchen_inventory_item_id = kii.id
              and tm.source = 'revenue_cogs'
              and tm.created_at >= now() - interval '60 days'
         )
       )
     group by rl.supplier_id, rl.item_id
  ),
  line_manufacturer as (
    select distinct on (rl.supplier_id, rl.item_id)
           rl.supplier_id,
           rl.item_id,
           rl.manufacturer_id
      from resolved_lines rl
     where rl.manufacturer_id is not null
     order by rl.supplier_id,
              rl.item_id,
              rl.receipt_date desc,
              rl.line_created_at desc,
              rl.gri_id desc
  ),
  item_scope as (
    select s.supplier_id,
           s.item_id,
           kii.item_code,
           kii.name,
           coalesce(
             kii.attp_profile,
             public.kho_attp_default_profile(kii.item_class, kii.item_type, kii.name)
           ) as profile,
           case when kii.attp_profile is null then 'default' else 'set' end as profile_source,
           coalesce(kii.default_manufacturer_id, lm.manufacturer_id) as manufacturer_id
      from scope s
      join public.kitchen_inventory_items kii on kii.id = s.item_id
      left join line_manufacturer lm
        on lm.supplier_id = s.supplier_id
       and lm.item_id = s.item_id
  ),
  all_kinds (kind, order_index) as (
    values
      ('attp_facility'::text, 1),
      ('product_declaration'::text, 2),
      ('coa'::text, 3),
      ('quarantine'::text, 4)
  ),
  item_req as (
    select isc.supplier_id,
           isc.item_id,
           isc.item_code,
           isc.name,
           isc.profile,
           isc.profile_source,
           isc.manufacturer_id,
           k.kind,
           k.order_index,
           (k.kind = any (public.kho_attp_required_kinds(isc.profile))) as required
      from item_scope isc
      cross join all_kinds k
  ),
  scope_items as (
    select distinct s.item_id from scope s
  ),
  cert_item_coverage as (
    select l.cert_id, l.item_id
      from public.food_cert_item_links l
      join scope_items si on si.item_id = l.item_id
     union
    select c.id, c.item_id
      from public.food_safety_certificates c
      join scope_items si on si.item_id = c.item_id
     where c.archived_at is null
       and c.owner_kind = 'item'
       and c.item_id is not null
     union
    select c.id, isc.item_id
      from public.food_safety_certificates c
      join item_scope isc on isc.manufacturer_id = c.manufacturer_id
     where c.archived_at is null
       and c.owner_kind = 'manufacturer'
       and c.manufacturer_id is not null
     union
    select c.id, s.item_id
      from public.food_safety_certificates c
      join scope s on s.supplier_id = c.supplier_id
     where c.archived_at is null
       and c.owner_kind = 'supplier'
       and c.supplier_id is not null
  ),
  cert_shared as (
    select cic.cert_id, count(distinct cic.item_id)::integer as shared_count
      from cert_item_coverage cic
     group by cic.cert_id
  ),
  candidate as (
    select ir.supplier_id,
           ir.item_id,
           ir.kind,
           ir.order_index,
           c.id as cert_id,
           c.cert_no,
           c.expires_on,
           c.review_status,
           c.extracted,
           c.created_at,
           case
             when c.review_status = 'confirmed'
                  and (c.expires_on is null or c.expires_on > current_date + 30) then 0
             when c.review_status = 'confirmed'
                  and c.expires_on >= current_date then 1
             when c.review_status = 'pending' then 2
             else 3
           end as state_rank
      from item_req ir
      join public.food_safety_certificates c
        on c.archived_at is null
       and c.cert_type = ir.kind
       and (
         (
           ir.kind = 'attp_facility'
           and (
             (c.owner_kind = 'manufacturer'
               and ir.manufacturer_id is not null
               and c.manufacturer_id = ir.manufacturer_id)
             or (c.owner_kind = 'supplier'
               and c.supplier_id = ir.supplier_id)
             or (c.owner_kind = 'item'
               and c.item_id = ir.item_id)
             or exists (
               select 1
                 from public.food_cert_item_links l
                where l.cert_id = c.id
                  and l.item_id = ir.item_id
             )
           )
         )
         or (
           ir.kind <> 'attp_facility'
           and (
             (c.owner_kind = 'item'
               and c.item_id = ir.item_id)
             or exists (
               select 1
                 from public.food_cert_item_links l
                where l.cert_id = c.id
                  and l.item_id = ir.item_id
             )
           )
         )
       )
     where ir.required
  ),
  best as (
    select distinct on (cand.supplier_id, cand.item_id, cand.kind)
           cand.supplier_id,
           cand.item_id,
           cand.kind,
           cand.order_index,
           cand.cert_id,
           cand.cert_no,
           cand.expires_on,
           cand.review_status,
           cand.extracted,
           cand.created_at
      from candidate cand
     order by cand.supplier_id,
              cand.item_id,
              cand.kind,
              cand.state_rank,
              cand.expires_on desc nulls first,
              cand.created_at desc,
              cand.cert_id desc
  ),
  reqs as (
    select ir.supplier_id,
           ir.item_id,
           ir.item_code,
           ir.name,
           ir.profile,
           ir.profile_source,
           ir.manufacturer_id,
           fm.name as manufacturer_name,
           ir.kind,
           ir.order_index,
           case
             when not ir.required then 'na'
             when b.cert_id is null then 'miss'
             when b.review_status = 'pending' then 'wait'
             when b.expires_on is null or b.expires_on > current_date + 30 then 'ok'
             when b.expires_on >= current_date then 'warn'
             else 'miss'
           end as state,
           b.cert_id,
           b.cert_no,
           b.expires_on,
           case
             when b.expires_on is null then null
             else (b.expires_on - current_date)::integer
           end as days_left,
           case
             when ir.required and b.cert_id is not null and b.review_status = 'pending'
               then b.extracted
             else null
           end as extracted_summary,
           case
             when ir.required
                  and b.cert_id is not null
                  and b.review_status = 'confirmed'
                  and b.expires_on is not null
                  and b.expires_on < current_date
               then jsonb_build_object(
                 'cert_id', b.cert_id,
                 'cert_no', b.cert_no,
                 'expires_on', b.expires_on
               )
             else null
           end as expired_cert,
           coalesce(cs.shared_count, 0) as shared_count
      from item_req ir
      left join best b
        on b.supplier_id = ir.supplier_id
       and b.item_id = ir.item_id
       and b.kind = ir.kind
      left join cert_shared cs on cs.cert_id = b.cert_id
      left join public.food_manufacturers fm on fm.id = ir.manufacturer_id
  ),
  item_rows as (
    select r.supplier_id,
           r.item_id,
           r.item_code,
           r.name,
           r.profile,
           r.profile_source,
           r.manufacturer_id,
           r.manufacturer_name,
           jsonb_agg(jsonb_build_object(
             'kind', r.kind,
             'state', r.state,
             'cert_id', r.cert_id,
             'cert_no', r.cert_no,
             'expires_on', r.expires_on,
             'days_left', r.days_left,
             'shared_count', r.shared_count,
             'extracted', r.extracted_summary,
             'expired_cert', r.expired_cert
           ) order by r.order_index) as requirements,
           count(*) filter (where r.state = 'ok')::integer as ok_count,
           count(*) filter (where r.state = 'warn')::integer as warn_count,
           count(*) filter (where r.state = 'wait')::integer as wait_count,
           count(*) filter (where r.state = 'miss')::integer as miss_count,
           count(*) filter (where r.state <> 'na')::integer as total_count,
           count(*) filter (where r.state in ('ok', 'warn'))::integer as done_count
      from reqs r
     group by r.supplier_id,
              r.item_id,
              r.item_code,
              r.name,
              r.profile,
              r.profile_source,
              r.manufacturer_id,
              r.manufacturer_name
  ),
  supplier_rows as (
    select i.supplier_id,
           s.name as supplier_name,
           jsonb_agg(jsonb_build_object(
             'item_id', i.item_id,
             'item_code', i.item_code,
             'name', i.name,
             'profile', i.profile,
             'profile_source', i.profile_source,
             'manufacturer_id', i.manufacturer_id,
             'manufacturer_name', i.manufacturer_name,
             'supplier_id', i.supplier_id,
             'supplier_name', s.name,
             'requirements', i.requirements,
             'totals', jsonb_build_object(
               'ok', i.ok_count,
               'warn', i.warn_count,
               'wait', i.wait_count,
               'miss', i.miss_count,
               'total', i.total_count,
               'done', i.done_count,
               'pct', case
                 when i.total_count = 0 then 100
                 else round(i.done_count::numeric * 100 / i.total_count)::integer
               end
             )
           ) order by i.name, i.item_id) as items,
           sum(i.ok_count)::integer as ok_count,
           sum(i.warn_count)::integer as warn_count,
           sum(i.wait_count)::integer as wait_count,
           sum(i.miss_count)::integer as miss_count,
           sum(i.total_count)::integer as total_count,
           sum(i.done_count)::integer as done_count,
           case
             when sum(i.total_count) = 0 then 100
             else round(sum(i.done_count)::numeric * 100 / sum(i.total_count))::integer
           end as pct
      from item_rows i
      join public.suppliers s on s.id = i.supplier_id
     group by i.supplier_id, s.name
  ),
  overall as (
    select coalesce(sum(sr.ok_count), 0)::integer as ok_count,
           coalesce(sum(sr.warn_count), 0)::integer as warn_count,
           coalesce(sum(sr.wait_count), 0)::integer as wait_count,
           coalesce(sum(sr.miss_count), 0)::integer as miss_count,
           coalesce(sum(sr.total_count), 0)::integer as total_count,
           coalesce(sum(sr.done_count), 0)::integer as done_count,
           case
             when coalesce(sum(sr.total_count), 0) = 0 then 100
             else round(
               coalesce(sum(sr.done_count), 0)::numeric * 100
               / nullif(sum(sr.total_count), 0)
             )::integer
           end as pct
      from supplier_rows sr
  ),
  unique_items as (
    select distinct on (i.item_id)
           i.item_id,
           i.item_code,
           i.name,
           i.profile,
           i.profile_source,
           i.manufacturer_id,
           i.manufacturer_name,
           i.supplier_id,
           sr.supplier_name,
           i.requirements,
           jsonb_build_object(
             'ok', i.ok_count,
             'warn', i.warn_count,
             'wait', i.wait_count,
             'miss', i.miss_count,
             'total', i.total_count,
             'done', i.done_count,
             'pct', case
               when i.total_count = 0 then 100
               else round(i.done_count::numeric * 100 / i.total_count)::integer
             end
           ) as totals,
           sr.pct as supplier_pct
      from item_rows i
      join supplier_rows sr on sr.supplier_id = i.supplier_id
     order by i.item_id, sr.pct, i.supplier_id
  )
  select jsonb_build_object(
    'generated_at', now(),
    'days', v_days,
    'totals', jsonb_build_object(
      'ok', o.ok_count,
      'warn', o.warn_count,
      'wait', o.wait_count,
      'miss', o.miss_count,
      'total', o.total_count,
      'done', o.done_count,
      'pct', o.pct
    ),
    'suppliers', coalesce((
      select jsonb_agg(jsonb_build_object(
        'supplier_id', sr.supplier_id,
        'name', sr.supplier_name,
        'totals', jsonb_build_object(
          'ok', sr.ok_count,
          'warn', sr.warn_count,
          'wait', sr.wait_count,
          'miss', sr.miss_count,
          'total', sr.total_count,
          'done', sr.done_count,
          'pct', sr.pct
        ),
        'items', sr.items
      ) order by sr.pct, sr.supplier_name, sr.supplier_id)
      from supplier_rows sr
    ), '[]'::jsonb),
    'items_by_item', coalesce((
      select jsonb_agg(jsonb_build_object(
        'item_id', u.item_id,
        'item_code', u.item_code,
        'name', u.name,
        'profile', u.profile,
        'profile_source', u.profile_source,
        'manufacturer_id', u.manufacturer_id,
        'manufacturer_name', u.manufacturer_name,
        'supplier_id', u.supplier_id,
        'supplier_name', u.supplier_name,
        'requirements', u.requirements,
        'totals', u.totals
      ) order by u.name, u.item_id)
      from unique_items u
    ), '[]'::jsonb)
  )
  into v_result
  from overall o;

  return coalesce(v_result, jsonb_build_object(
    'generated_at', now(),
    'days', v_days,
    'totals', jsonb_build_object(
      'ok', 0, 'warn', 0, 'wait', 0, 'miss', 0,
      'total', 0, 'done', 0, 'pct', 100
    ),
    'suppliers', '[]'::jsonb,
    'items_by_item', '[]'::jsonb
  ));
end;
$$;

revoke all on function public.kho_attp_checklist(integer) from public, anon;
grant execute on function public.kho_attp_checklist(integer) to authenticated, service_role;
