-- Business-facing Material Master controller actions.
-- Keeps sku_cogs_materials as the only canonical root, uses exact UUID choices,
-- publishes COGS snapshots, and never merges or deletes historical identities.

select set_config('material_master.rpc_update', 'on', true);
update public.sku_cogs_materials set version = 1 where version is null;

alter table public.sku_cogs_materials
  alter column version set default 1,
  alter column version set not null;

create or replace function public.link_material_supplier(
  p_material_id uuid,
  p_expected_version integer,
  p_supplier_id uuid,
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
  v_old public.sku_cogs_materials%rowtype;
  v_new public.sku_cogs_materials%rowtype;
  v_supplier public.suppliers%rowtype;
  v_link public.material_supplier_products%rowtype;
begin
  if not public.can_edit_material_master() then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if v_reason is null then raise exception 'reason required' using errcode = '22023'; end if;

  select * into v_old from public.sku_cogs_materials where id = p_material_id for update;
  if not found or v_old.active is not true then raise exception 'material not found or inactive' using errcode = 'P0002'; end if;

  select * into v_supplier from public.suppliers where id = p_supplier_id;
  if not found then raise exception 'supplier not found' using errcode = 'P0002'; end if;

  select * into v_link
  from public.material_supplier_products
  where material_id = p_material_id
    and supplier_id = p_supplier_id
    and active = true
    and approved = true
    and normalized_supplier_product_name = public.material_master_normalize(v_old.canonical_name)
    and lower(btrim(purchase_unit)) = lower(btrim(v_old.default_unit))
    and lower(btrim(base_unit)) = lower(btrim(v_old.default_unit))
    and base_quantity = 1
  order by approved desc, created_at desc
  limit 1;
  if found then
    return jsonb_build_object(
      'status', 'supplier_link_unchanged',
      'material_id', p_material_id,
      'supplier_id', p_supplier_id,
      'supplier_product_id', v_link.id,
      'version', v_old.version
    );
  end if;

  if v_old.version <> p_expected_version then raise exception 'material version conflict' using errcode = '40001'; end if;

  if exists (
    select 1 from public.material_supplier_products sp
    where sp.material_id = p_material_id
      and sp.supplier_id = p_supplier_id
      and sp.active = true
  ) then
    raise exception 'existing supplier product requires reconciliation before canonical linking' using errcode = '23514';
  end if;

  if exists (
    select 1 from public.material_supplier_products sp
    where sp.supplier_id = p_supplier_id
      and sp.active = true
      and sp.material_id <> p_material_id
      and sp.normalized_supplier_product_name = public.material_master_normalize(v_old.canonical_name)
      and lower(btrim(sp.purchase_unit)) = lower(btrim(v_old.default_unit))
  ) then
    raise exception 'supplier product identity belongs to another canonical material' using errcode = '23505';
  end if;

  begin
    insert into public.material_supplier_products (
      material_id, supplier_id, supplier_product_code, supplier_product_name,
      normalized_supplier_product_name, purchase_unit, base_quantity, base_unit,
      approved, approved_by, approved_at, active, metadata, created_by
    ) values (
      p_material_id, p_supplier_id, null, v_old.canonical_name,
      public.material_master_normalize(v_old.canonical_name), v_old.default_unit, 1, v_old.default_unit,
      true, v_actor, now(), true,
      jsonb_build_object('selected_in_material_controller', true, 'supplier_name_snapshot', v_supplier.name),
      v_actor
    ) returning * into v_link;
  exception when unique_violation then
    select * into v_link
    from public.material_supplier_products
    where supplier_id = p_supplier_id
      and active = true
      and approved = true
      and normalized_supplier_product_name = public.material_master_normalize(v_old.canonical_name)
      and lower(btrim(purchase_unit)) = lower(btrim(v_old.default_unit))
      and lower(btrim(base_unit)) = lower(btrim(v_old.default_unit))
      and base_quantity = 1
    order by created_at desc
    limit 1;
    if found and v_link.material_id = p_material_id then
      return jsonb_build_object(
        'status', 'supplier_link_unchanged',
        'material_id', p_material_id,
        'supplier_id', p_supplier_id,
        'supplier_product_id', v_link.id,
        'version', v_old.version
      );
    end if;
    raise exception 'supplier product identity conflict after concurrent insert' using errcode = '23505';
  end;

  perform set_config('material_master.rpc_update', 'on', true);
  update public.sku_cogs_materials
  set version = version + 1, updated_by = v_actor, updated_at = now()
  where id = p_material_id
  returning * into v_new;

  perform public.material_master_audit_append(
    'link_material_supplier', p_material_id, null, v_reason,
    public.material_master_row_json(v_old), public.material_master_row_json(v_new),
    jsonb_build_object('supplier_id', p_supplier_id, 'supplier_product_id', v_link.id, 'selection', 'explicit')
  );

  return jsonb_build_object(
    'status', 'supplier_linked',
    'material_id', p_material_id,
    'supplier_id', p_supplier_id,
    'supplier_product_id', v_link.id,
    'version', v_new.version
  );
end;
$$;

create or replace function public.link_material_to_sku_cogs(
  p_material_id uuid,
  p_expected_version integer,
  p_sku_id uuid,
  p_dosage_qty numeric,
  p_wastage_percent numeric default 0,
  p_standard_unit_price numeric default null,
  p_effective_from date default current_date,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_old public.sku_cogs_materials%rowtype;
  v_new public.sku_cogs_materials%rowtype;
  v_sku public.product_skus%rowtype;
  v_existing public.sku_formulations%rowtype;
  v_price public.material_price_history%rowtype;
  v_current_version public.sku_cogs_versions%rowtype;
  v_formulation_id uuid;
  v_new_version_id uuid;
  v_next_version integer;
  v_sort_order integer;
  v_live_count integer;
  v_snapshot_count integer;
begin
  if not public.can_edit_material_master() then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if v_reason is null then raise exception 'reason required' using errcode = '22023'; end if;
  if p_effective_from is null then raise exception 'effective date required' using errcode = '22023'; end if;
  if p_dosage_qty is null or p_dosage_qty <= 0 or p_dosage_qty::text in ('NaN','Infinity','-Infinity') then
    raise exception 'COGS link dosage must be positive' using errcode = '22023';
  end if;
  if p_wastage_percent is null or p_wastage_percent < 0 or p_wastage_percent > 100 or p_wastage_percent::text in ('NaN','Infinity','-Infinity') then
    raise exception 'COGS wastage percent must be between 0 and 100' using errcode = '22023';
  end if;

  select * into v_old from public.sku_cogs_materials where id = p_material_id for update;
  if not found or v_old.active is not true then raise exception 'material not found or inactive' using errcode = 'P0002'; end if;

  select * into v_sku
  from public.product_skus
  where id = p_sku_id and sku_type::text = 'finished_good'
  for update;
  if not found then raise exception 'finished SKU not found' using errcode = 'P0002'; end if;

  select * into v_existing
  from public.sku_formulations
  where sku_id = p_sku_id and canonical_material_id = p_material_id
  order by created_at desc nulls last, id
  limit 1;

  select * into v_current_version
  from public.sku_cogs_versions
  where sku_id = p_sku_id and effective_to is null
  for update;

  if v_existing.id is not null and v_current_version.id is not null and v_existing.standard_price_id is not null and exists (
    select 1
    from public.sku_cogs_version_formulations vf
    where vf.version_id = v_current_version.id
      and vf.source_formulation_id = v_existing.id
      and vf.canonical_material_id = p_material_id
      and vf.canonical_material_snapshot->>'standard_price_id' = v_existing.standard_price_id::text
  ) then
    return jsonb_build_object(
      'status', 'cogs_link_unchanged',
      'material_id', p_material_id,
      'sku_id', p_sku_id,
      'formulation_id', v_existing.id,
      'cogs_version_id', v_current_version.id,
      'cogs_version_no', v_current_version.version_no,
      'version', v_old.version
    );
  end if;

  if v_old.version <> p_expected_version then raise exception 'material version conflict' using errcode = '40001'; end if;

  if exists (
    select 1
    from public.sku_formulations f
    left join public.sku_cogs_materials m on m.id = f.canonical_material_id
    where f.sku_id = p_sku_id
      and (m.id is null or m.active is not true)
  ) then
    raise exception 'existing COGS formulation contains unresolved or inactive canonical material' using errcode = '23514';
  end if;

  if v_current_version.id is not null and p_effective_from <= v_current_version.effective_from then
    raise exception 'Ngày hiệu lực mới phải sau ngày bắt đầu phiên bản Giá vốn hiện tại (%)', v_current_version.effective_from using errcode = '22023';
  end if;

  select * into v_price
  from public.material_price_history
  where material_id = p_material_id
    and supplier_product_id is null
    and price_type = 'standard_cost'
    and approved = true
    and effective_from <= p_effective_from
    and (effective_to is null or effective_to >= p_effective_from)
    and lower(btrim(price_unit)) = lower(btrim(v_old.default_unit))
  order by effective_from desc, created_at desc
  limit 1;

  if not found then
    if p_standard_unit_price is null or p_standard_unit_price < 0 or p_standard_unit_price::text in ('NaN','Infinity','-Infinity') then
      raise exception 'standard cost required for COGS link' using errcode = '23514';
    end if;
    insert into public.material_price_history (
      material_id, supplier_product_id, price_type, price, price_unit,
      normalized_base_unit_price, effective_from, effective_to,
      source_type, approved, approved_by, approved_at, metadata, created_by
    ) values (
      p_material_id, null, 'standard_cost', p_standard_unit_price, v_old.default_unit,
      p_standard_unit_price, p_effective_from, null,
      'material_master_controller', true, v_actor, now(),
      jsonb_build_object('selected_for_sku_id', p_sku_id), v_actor
    ) returning * into v_price;
  end if;

  perform set_config('material_master.sku_cogs_save', 'material-master-controller', true);
  if v_existing.id is null then
    select coalesce(max(sort_order), 0) + 10 into v_sort_order
    from public.sku_formulations where sku_id = p_sku_id;

    insert into public.sku_formulations (
      sku_id, canonical_material_id, ingredient_name, raw_ocr_name, material_code,
      unit, unit_price, dosage_qty, wastage_percent, sort_order, effective_from,
      material_resolution_status, canonical_default_unit, standard_unit_price, standard_price_id
    ) values (
      p_sku_id, p_material_id, v_old.canonical_name, v_old.canonical_name, v_old.material_code,
      v_old.default_unit, coalesce(v_price.normalized_base_unit_price, v_price.price),
      p_dosage_qty, p_wastage_percent, v_sort_order, p_effective_from,
      'resolved_exact', v_old.default_unit, coalesce(v_price.normalized_base_unit_price, v_price.price), v_price.id
    ) returning * into v_existing;
  else
    update public.sku_formulations
    set ingredient_name = v_old.canonical_name,
        raw_ocr_name = v_old.canonical_name,
        material_code = v_old.material_code,
        unit = v_old.default_unit,
        unit_price = coalesce(v_price.normalized_base_unit_price, v_price.price),
        effective_from = p_effective_from,
        material_resolution_status = 'resolved_exact',
        canonical_default_unit = v_old.default_unit,
        standard_unit_price = coalesce(v_price.normalized_base_unit_price, v_price.price),
        standard_price_id = v_price.id
    where id = v_existing.id
    returning * into v_existing;
  end if;
  v_formulation_id := v_existing.id;

  if v_current_version.id is not null then
    update public.sku_cogs_versions set effective_to = p_effective_from - 1 where id = v_current_version.id;
  end if;

  select coalesce(max(version_no), 0) + 1 into v_next_version
  from public.sku_cogs_versions where sku_id = p_sku_id;

  insert into public.sku_cogs_versions (
    sku_id, version_no, effective_from, effective_to, change_reason, product_snapshot, changed_by
  ) values (
    p_sku_id, v_next_version, p_effective_from, null, v_reason, to_jsonb(v_sku), v_actor
  ) returning id into v_new_version_id;

  insert into public.sku_cogs_version_formulations (
    version_id, source_formulation_id, canonical_material_id, ingredient_sku_id,
    ingredient_name, raw_ocr_name, material_code, unit, unit_price,
    dosage_qty, wastage_percent, sort_order, canonical_material_snapshot
  )
  select v_new_version_id, f.id, f.canonical_material_id, f.ingredient_sku_id,
    f.ingredient_name, f.raw_ocr_name, f.material_code, f.unit, f.unit_price,
    f.dosage_qty, f.wastage_percent, f.sort_order,
    jsonb_build_object(
      'canonical_material_id', m.id,
      'canonical_material_name', m.canonical_name,
      'canonical_material_code', m.material_code,
      'canonical_default_unit', m.default_unit,
      'standard_unit_price', f.standard_unit_price,
      'standard_price_id', f.standard_price_id,
      'published_at', now()
    )
  from public.sku_formulations f
  join public.sku_cogs_materials m on m.id = f.canonical_material_id
  where f.sku_id = p_sku_id;

  select count(*) into v_live_count from public.sku_formulations where sku_id = p_sku_id;
  select count(*) into v_snapshot_count from public.sku_cogs_version_formulations where version_id = v_new_version_id;
  if v_snapshot_count <> v_live_count then
    raise exception 'COGS version snapshot row count mismatch' using errcode = '23514';
  end if;

  perform set_config('material_master.rpc_update', 'on', true);
  update public.sku_cogs_materials
  set version = version + 1, updated_by = v_actor, updated_at = now()
  where id = p_material_id
  returning * into v_new;

  perform public.material_master_audit_append(
    'link_material_to_sku_cogs', p_material_id, null, v_reason,
    public.material_master_row_json(v_old), public.material_master_row_json(v_new),
    jsonb_build_object(
      'sku_id', p_sku_id,
      'formulation_id', v_formulation_id,
      'cogs_version_id', v_new_version_id,
      'cogs_version_no', v_next_version,
      'effective_from', p_effective_from,
      'dosage_qty', p_dosage_qty,
      'wastage_percent', p_wastage_percent,
      'standard_price_id', v_price.id,
      'selection', 'explicit'
    )
  );

  return jsonb_build_object(
    'status', 'cogs_linked',
    'material_id', p_material_id,
    'sku_id', p_sku_id,
    'formulation_id', v_formulation_id,
    'cogs_version_id', v_new_version_id,
    'cogs_version_no', v_next_version,
    'version', v_new.version
  );
end;
$$;

revoke all on function public.link_material_supplier(uuid, integer, uuid, text) from public, anon;
grant execute on function public.link_material_supplier(uuid, integer, uuid, text) to authenticated, service_role;

revoke all on function public.link_material_to_sku_cogs(uuid, integer, uuid, numeric, numeric, numeric, date, text) from public, anon;
grant execute on function public.link_material_to_sku_cogs(uuid, integer, uuid, numeric, numeric, numeric, date, text) to authenticated, service_role;

comment on function public.link_material_supplier(uuid, integer, uuid, text) is
  'Material Master business controller: explicit audited supplier selection using canonical name/unit snapshots.';
comment on function public.link_material_to_sku_cogs(uuid, integer, uuid, numeric, numeric, numeric, date, text) is
  'Material Master business controller: append an exact canonical material to a finished SKU and publish an immutable COGS version snapshot.';
