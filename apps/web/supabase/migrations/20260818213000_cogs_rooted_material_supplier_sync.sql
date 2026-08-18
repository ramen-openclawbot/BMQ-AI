-- COGS-rooted material workflow: suggest and confirm a real supplier product,
-- then synchronize every exact existing Duyet chi line in one audited transaction.
-- sku_cogs_materials remains the only canonical NVL root.

create or replace function public.get_material_supplier_suggestions(p_material_id uuid)
returns table (
  supplier_id uuid,
  supplier_display_name text,
  product_sku_id uuid,
  supplier_product_id uuid,
  product_name text,
  product_code text,
  purchase_unit text,
  candidate_source text,
  evidence_count bigint,
  latest_request_at timestamptz,
  confirmed boolean,
  payment_candidate_count bigint
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.can_view_material_master()
    or not (
      coalesce(public.material_master_jwt_role(), '') = 'service_role'
      or public.has_role((select auth.uid()), 'owner')
      or public.has_module_permission((select auth.uid()), 'payment_requests', 'view')
    ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if p_material_id is null then raise exception 'material_id required' using errcode = '22023'; end if;
  if not exists (select 1 from public.sku_cogs_materials where id = p_material_id and active = true) then
    raise exception 'active COGS material not found' using errcode = 'P0002';
  end if;

  return query
  with material as (
    select m.*
    from public.sku_cogs_materials m
    where m.id = p_material_id and m.active = true
  ), evidence as (
    select
      msp.supplier_id,
      msp.product_sku_id,
      msp.id as supplier_product_id,
      msp.supplier_product_name as product_name,
      msp.supplier_product_code as product_code,
      msp.purchase_unit,
      'confirmed_supplier_product'::text as candidate_source,
      0::bigint as evidence_count,
      null::timestamptz as latest_request_at,
      true as confirmed
    from material m
    join public.material_supplier_products msp on msp.material_id = m.id
      and msp.active = true and msp.approved = true

    union all

    select
      ps.supplier_id,
      ps.id,
      null::uuid,
      ps.product_name,
      ps.sku_code,
      coalesce(nullif(btrim(ps.unit), ''), m.default_unit),
      'cogs_product_sku_exact',
      0::bigint,
      null::timestamptz,
      false
    from material m
    join public.product_skus ps on ps.sku_type::text = 'raw_material'
      and ps.supplier_id is not null
      and (
        ps.canonical_material_id = m.id
        or (
          ps.id = m.ingredient_sku_id
          and 1 = (
            select count(*) from public.sku_cogs_materials mu
            where mu.active = true and mu.ingredient_sku_id = ps.id
          )
        )
      )

    union all

    select
      pr.supplier_id,
      ps_history.id,
      null::uuid,
      pri.product_name,
      pri.product_code,
      coalesce(nullif(btrim(pri.unit), ''), m.default_unit),
      case
        when ps_history.id is not null
          then 'payment_history_sku_exact'
        else 'payment_history_name_unit'
      end,
      count(*)::bigint,
      max(pr.created_at),
      false
    from material m
    join public.payment_request_items pri on (
      pri.sku_id = m.ingredient_sku_id
      and m.ingredient_sku_id is not null
      and 1 = (
        select count(*) from public.sku_cogs_materials mu
        where mu.active = true and mu.ingredient_sku_id = m.ingredient_sku_id
      )
    ) or (
      public.material_master_normalize(pri.product_name) = public.material_master_normalize(m.canonical_name)
      and lower(btrim(coalesce(pri.unit, ''))) = lower(btrim(m.default_unit))
    )
    join public.payment_requests pr on pr.id = pri.payment_request_id and pr.supplier_id is not null
    left join public.product_skus ps_history on ps_history.id = pri.sku_id
      and ps_history.supplier_id = pr.supplier_id
      and ps_history.sku_type::text = 'raw_material'
      and (
        ps_history.canonical_material_id = m.id
        or (
          ps_history.id = m.ingredient_sku_id
          and 1 = (
            select count(*) from public.sku_cogs_materials mu
            where mu.active = true and mu.ingredient_sku_id = ps_history.id
          )
        )
      )
      and public.material_master_normalize(pri.product_name) = public.material_master_normalize(ps_history.product_name)
      and lower(btrim(coalesce(pri.unit, ''))) = lower(btrim(coalesce(ps_history.unit, m.default_unit)))
    where ps_history.id is not null
      or (
        public.material_master_normalize(pri.product_name) = public.material_master_normalize(m.canonical_name)
        and lower(btrim(coalesce(pri.unit, ''))) = lower(btrim(m.default_unit))
      )
    group by m.id, m.ingredient_sku_id, m.default_unit, pr.supplier_id, ps_history.id, pri.sku_id,
      pri.product_name, pri.product_code, pri.unit
  ), ranked as (
    select e.*,
      row_number() over (
        partition by e.supplier_id,
          public.material_master_normalize(e.product_name), lower(btrim(e.purchase_unit))
        order by e.confirmed desc,
          case e.candidate_source
            when 'confirmed_supplier_product' then 1
            when 'cogs_product_sku_exact' then 2
            when 'payment_history_sku_exact' then 3
            else 4
          end,
          e.evidence_count desc, e.latest_request_at desc nulls last
      ) as identity_rank
    from evidence e
  )
  select
    r.supplier_id,
    s.name,
    r.product_sku_id,
    r.supplier_product_id,
    r.product_name,
    r.product_code,
    r.purchase_unit,
    r.candidate_source,
    r.evidence_count,
    r.latest_request_at,
    r.confirmed,
    (
      select count(*)
      from public.payment_request_items pri
      join public.payment_requests pr on pr.id = pri.payment_request_id
      where pr.supplier_id = r.supplier_id
        and public.material_master_normalize(pri.product_name) = public.material_master_normalize(r.product_name)
        and lower(btrim(coalesce(pri.unit, ''))) = lower(btrim(r.purchase_unit))
        and (pri.canonical_material_id is null or pri.canonical_material_id = p_material_id)
    )::bigint
  from ranked r
  join public.suppliers s on s.id = r.supplier_id
  where r.identity_rank = 1
  order by r.confirmed desc, r.evidence_count desc, r.latest_request_at desc nulls last, s.name, r.product_name;
end;
$$;

revoke all on function public.get_material_supplier_suggestions(uuid) from public, anon;
grant execute on function public.get_material_supplier_suggestions(uuid) to authenticated, service_role;

create or replace function public.confirm_material_supplier_product(
  p_material_id uuid,
  p_expected_version integer,
  p_supplier_id uuid,
  p_product_sku_id uuid,
  p_supplier_product_name text,
  p_purchase_unit text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_material public.sku_cogs_materials%rowtype;
  v_new_material public.sku_cogs_materials%rowtype;
  v_product public.product_skus%rowtype;
  v_link public.material_supplier_products%rowtype;
  v_alias public.material_scoped_aliases%rowtype;
  v_link_existing boolean := false;
  v_alias_existing boolean := false;
  v_name text := nullif(btrim(coalesce(p_supplier_product_name, '')), '');
  v_unit text := nullif(btrim(coalesce(p_purchase_unit, '')), '');
  v_code text;
  v_evidence_count bigint := 0;
  v_conversion_pending boolean;
begin
  if not public.can_edit_material_master()
    or not (
      coalesce(public.material_master_jwt_role(), '') = 'service_role'
      or public.has_role((select auth.uid()), 'owner')
      or public.has_module_permission((select auth.uid()), 'payment_requests', 'edit')
    ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if v_reason is null then raise exception 'reason required' using errcode = '22023'; end if;
  if p_material_id is null or p_supplier_id is null or v_name is null or v_unit is null then
    raise exception 'material, supplier, product name and purchase unit required' using errcode = '22023';
  end if;

  select * into v_material from public.sku_cogs_materials
  where id = p_material_id and active = true for update;
  if not found then raise exception 'active COGS material not found' using errcode = 'P0002'; end if;
  perform 1 from public.suppliers where id = p_supplier_id for update;
  if not found then raise exception 'supplier not found' using errcode = 'P0002'; end if;

  if p_product_sku_id is not null then
    select * into v_product from public.product_skus
    where id = p_product_sku_id and sku_type::text = 'raw_material';
    if not found then raise exception 'raw supplier product not found' using errcode = 'P0002'; end if;
    if v_product.supplier_id is distinct from p_supplier_id then
      raise exception 'supplier product does not belong to selected supplier' using errcode = '23514';
    end if;
    if not coalesce(v_product.canonical_material_id = p_material_id, false)
      and not (
        v_material.ingredient_sku_id = v_product.id
        and 1 = (
          select count(*)
          from public.sku_cogs_materials identity_material
          where identity_material.active = true
            and identity_material.ingredient_sku_id = v_product.id
        )
      ) then
      raise exception 'supplier product is not linked to selected COGS material' using errcode = '23514';
    end if;
    if public.material_master_normalize(v_product.product_name) is distinct from public.material_master_normalize(v_name)
      or lower(btrim(coalesce(v_product.unit, ''))) is distinct from lower(btrim(v_unit)) then
      raise exception 'supplier product selection drifted' using errcode = '40001';
    end if;
    v_name := v_product.product_name;
    v_unit := coalesce(nullif(btrim(v_product.unit), ''), v_unit);
    v_code := v_product.sku_code;
  else
    select count(*) into v_evidence_count
    from public.payment_request_items pri
    join public.payment_requests pr on pr.id = pri.payment_request_id
    where pr.supplier_id = p_supplier_id
      and public.material_master_normalize(pri.product_name) = public.material_master_normalize(v_name)
      and lower(btrim(coalesce(pri.unit, ''))) = lower(btrim(v_unit));
    if v_evidence_count = 0 then
      raise exception 'payment request product evidence required' using errcode = '23514';
    end if;
    select pri.product_code into v_code
    from public.payment_request_items pri
    join public.payment_requests pr on pr.id = pri.payment_request_id
    where pr.supplier_id = p_supplier_id
      and public.material_master_normalize(pri.product_name) = public.material_master_normalize(v_name)
      and lower(btrim(coalesce(pri.unit, ''))) = lower(btrim(v_unit))
    order by pr.created_at desc, pri.created_at desc, pri.id desc limit 1;
  end if;

  select * into v_link
  from public.material_supplier_products
  where supplier_id = p_supplier_id and active = true and approved = true
    and normalized_supplier_product_name = public.material_master_normalize(v_name)
    and lower(btrim(purchase_unit)) = lower(btrim(v_unit))
  order by created_at asc, id asc limit 1 for update;

  if found then
    if v_link.material_id is distinct from p_material_id then
      raise exception 'supplier product identity belongs to another canonical material' using errcode = '23505';
    end if;
    v_link_existing := true;
  end if;

  select * into v_alias
  from public.material_scoped_aliases
  where supplier_id = p_supplier_id and active = true and approved = true
    and normalized_alias = public.material_master_normalize(v_name)
  order by created_at asc, id asc limit 1 for update;
  if found then
    if v_alias.material_id is distinct from p_material_id then
      raise exception 'supplier product alias belongs to another canonical material' using errcode = '23505';
    end if;
    v_alias_existing := true;
  end if;

  -- Terminal idempotency precedes optimistic version validation.
  if v_link_existing and v_alias_existing then
    return jsonb_build_object(
      'status', 'supplier_product_unchanged', 'material_id', p_material_id,
      'supplier_id', p_supplier_id, 'supplier_product_id', v_link.id,
      'version', v_material.version
    );
  end if;

  if v_material.version is distinct from p_expected_version then
    raise exception 'material version conflict' using errcode = '40001';
  end if;

  v_conversion_pending := lower(btrim(v_unit)) <> lower(btrim(v_material.default_unit));
  if not v_link_existing then
    begin
      insert into public.material_supplier_products (
        material_id, supplier_id, product_sku_id, supplier_product_code,
        supplier_product_name, normalized_supplier_product_name,
        purchase_unit, base_quantity, base_unit,
        approved, approved_by, approved_at, active, metadata, created_by
      ) values (
        p_material_id, p_supplier_id, p_product_sku_id, v_code,
        v_name, public.material_master_normalize(v_name),
        v_unit, 1, case when v_conversion_pending then v_unit else v_material.default_unit end,
        true, v_actor, now(), true,
        jsonb_build_object(
          'selected_in_material_controller', true,
          'conversion_pending', v_conversion_pending,
          'evidence_count', v_evidence_count,
          'selection_source', case when p_product_sku_id is null then 'payment_history' else 'product_skus' end
        ),
        v_actor
      ) returning * into v_link;
    exception when unique_violation then
      select * into v_link
      from public.material_supplier_products
      where supplier_id = p_supplier_id and active = true
        and normalized_supplier_product_name = public.material_master_normalize(v_name)
        and lower(btrim(purchase_unit)) = lower(btrim(v_unit))
      order by created_at asc, id asc limit 1;
      if not found or v_link.material_id is distinct from p_material_id then
        raise exception 'supplier product identity conflict after concurrent confirmation' using errcode = '23505';
      end if;
    end;
  end if;

  if not v_alias_existing then
    insert into public.material_scoped_aliases (
      material_id, supplier_id, source_type, alias_name, normalized_alias,
      approved, approved_by, approved_at, active, metadata, created_by
    ) values (
      p_material_id, p_supplier_id, 'payment_request', v_name,
      public.material_master_normalize(v_name), true, v_actor, now(), true,
      jsonb_build_object(
        'supplier_product_id', v_link.id,
        'selected_in_material_controller', true,
        'exact_future_resolution', true
      ),
      v_actor
    )
    on conflict (supplier_id, normalized_alias)
      where supplier_id is not null and active = true and approved = true
    do nothing
    returning * into v_alias;
    if v_alias.id is null then
      select * into v_alias
      from public.material_scoped_aliases
      where supplier_id = p_supplier_id and active = true and approved = true
        and normalized_alias = public.material_master_normalize(v_name)
      order by created_at asc, id asc limit 1;
      if not found or v_alias.material_id is distinct from p_material_id then
        raise exception 'supplier product alias conflict after concurrent confirmation' using errcode = '23505';
      end if;
    end if;
  end if;

  perform set_config('material_master.rpc_update', 'on', true);
  update public.sku_cogs_materials
  set version = version + 1, updated_by = v_actor, updated_at = now()
  where id = p_material_id returning * into v_new_material;
  perform set_config('material_master.rpc_update', '', true);

  perform public.material_master_audit_append(
    'confirm_material_supplier_product', p_material_id, null, v_reason,
    public.material_master_row_json(v_material), public.material_master_row_json(v_new_material),
    jsonb_build_object(
      'supplier_id', p_supplier_id, 'supplier_product_id', v_link.id,
      'scoped_alias_id', v_alias.id,
      'product_sku_id', p_product_sku_id, 'supplier_product_name', v_name,
      'purchase_unit', v_unit, 'conversion_pending', v_conversion_pending,
      'future_resolution', 'approved_supplier_alias_exact',
      'selection', 'explicit_user_confirmation'
    )
  );

  return jsonb_build_object(
    'status', 'supplier_product_confirmed', 'material_id', p_material_id,
    'supplier_id', p_supplier_id, 'supplier_product_id', v_link.id,
    'conversion_pending', v_conversion_pending, 'version', v_new_material.version
  );
end;
$$;

revoke all on function public.confirm_material_supplier_product(uuid, integer, uuid, uuid, text, text, text) from public, anon;
grant execute on function public.confirm_material_supplier_product(uuid, integer, uuid, uuid, text, text, text) to authenticated, service_role;

create or replace function public.sync_material_supplier_payment_requests(
  p_material_id uuid,
  p_expected_version integer,
  p_supplier_product_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_material public.sku_cogs_materials%rowtype;
  v_supplier_product public.material_supplier_products%rowtype;
  v_line record;
  v_result jsonb;
  v_current_version integer;
  v_candidate_count integer := 0;
  v_linked_count integer := 0;
  v_existing_count integer := 0;
  v_conflict_count integer := 0;
begin
  if not public.can_edit_material_master()
    or not (
      coalesce(public.material_master_jwt_role(), '') = 'service_role'
      or public.has_role((select auth.uid()), 'owner')
      or public.has_module_permission((select auth.uid()), 'payment_requests', 'edit')
    ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if v_reason is null then raise exception 'reason required' using errcode = '22023'; end if;

  select * into v_material from public.sku_cogs_materials
  where id = p_material_id and active = true for update;
  if not found then raise exception 'active COGS material not found' using errcode = 'P0002'; end if;

  select * into v_supplier_product from public.material_supplier_products
  where id = p_supplier_product_id and material_id = p_material_id
    and active = true and approved = true for update;
  if not found then raise exception 'approved supplier product not found for material' using errcode = 'P0002'; end if;

  select count(*) into v_conflict_count
  from public.payment_request_items pri
  join public.payment_requests pr on pr.id = pri.payment_request_id
  where pr.supplier_id = v_supplier_product.supplier_id
    and public.material_master_normalize(pri.product_name) = public.material_master_normalize(v_supplier_product.supplier_product_name)
    and lower(btrim(coalesce(pri.unit, ''))) = lower(btrim(v_supplier_product.purchase_unit))
    and pri.canonical_material_id is not null
    and pri.canonical_material_id <> p_material_id;
  if v_conflict_count > 0 then
    raise exception 'payment request item already linked to another material' using errcode = '23514';
  end if;

  select count(*) filter (where pri.canonical_material_id is null),
         count(*) filter (where pri.canonical_material_id = p_material_id)
    into v_candidate_count, v_existing_count
  from public.payment_request_items pri
  join public.payment_requests pr on pr.id = pri.payment_request_id
  where pr.supplier_id = v_supplier_product.supplier_id
    and public.material_master_normalize(pri.product_name) = public.material_master_normalize(v_supplier_product.supplier_product_name)
    and lower(btrim(coalesce(pri.unit, ''))) = lower(btrim(v_supplier_product.purchase_unit));

  if v_candidate_count = 0 then
    return jsonb_build_object(
      'status', 'payment_requests_sync_unchanged', 'material_id', p_material_id,
      'supplier_product_id', p_supplier_product_id, 'candidate_count', 0,
      'linked_count', 0, 'existing_linked_count', v_existing_count,
      'version', v_material.version
    );
  end if;

  if v_material.version is distinct from p_expected_version then
    raise exception 'material version conflict' using errcode = '40001';
  end if;

  for v_line in
    select pri.id
    from public.payment_request_items pri
    join public.payment_requests pr on pr.id = pri.payment_request_id
    where pr.supplier_id = v_supplier_product.supplier_id
      and public.material_master_normalize(pri.product_name) = public.material_master_normalize(v_supplier_product.supplier_product_name)
      and lower(btrim(coalesce(pri.unit, ''))) = lower(btrim(v_supplier_product.purchase_unit))
      and pri.canonical_material_id is null
    order by pri.id
    for update of pri
  loop
    select version into v_current_version from public.sku_cogs_materials where id = p_material_id;
    v_result := public.link_material_payment_request_item(
      p_material_id, v_current_version, v_line.id, v_reason
    );
    if coalesce(v_result->>'status', '') not in ('payment_request_linked', 'payment_request_link_unchanged')
      or nullif(v_result->>'material_id', '')::uuid is distinct from p_material_id then
      raise exception 'payment request bulk sync response validation failed' using errcode = '23514';
    end if;
    v_linked_count := v_linked_count + 1;
  end loop;

  select version into v_current_version from public.sku_cogs_materials where id = p_material_id;
  perform public.material_master_audit_append(
    'sync_material_supplier_payment_requests', p_material_id, null, v_reason,
    jsonb_build_object('candidate_count', v_candidate_count, 'existing_linked_count', v_existing_count),
    jsonb_build_object('linked_count', v_linked_count, 'total_linked_count', v_existing_count + v_linked_count),
    jsonb_build_object(
      'supplier_id', v_supplier_product.supplier_id,
      'supplier_product_id', p_supplier_product_id,
      'supplier_product_name', v_supplier_product.supplier_product_name,
      'purchase_unit', v_supplier_product.purchase_unit,
      'selection', 'confirmed_supplier_product_exact_sync'
    )
  );

  return jsonb_build_object(
    'status', 'payment_requests_synced', 'material_id', p_material_id,
    'supplier_product_id', p_supplier_product_id,
    'candidate_count', v_candidate_count, 'linked_count', v_linked_count,
    'existing_linked_count', v_existing_count, 'version', v_current_version
  );
end;
$$;

revoke all on function public.sync_material_supplier_payment_requests(uuid, integer, uuid, text) from public, anon;
grant execute on function public.sync_material_supplier_payment_requests(uuid, integer, uuid, text) to authenticated, service_role;

comment on function public.get_material_supplier_suggestions(uuid) is
  'COGS-rooted supplier product suggestions from exact raw SKU or exact payment history evidence.';
comment on function public.confirm_material_supplier_product(uuid, integer, uuid, uuid, text, text, text) is
  'Explicitly confirm one real supplier product for a canonical COGS material without inventing unit conversion.';
comment on function public.sync_material_supplier_payment_requests(uuid, integer, uuid, text) is
  'Atomically synchronize all exact existing payment request lines for one confirmed supplier product.';
