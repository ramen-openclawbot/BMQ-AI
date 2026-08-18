-- Task 5 Goods Receipt / delivery-note OCR canonical material controller integration.
-- Root remains public.sku_cogs_materials. This migration does not rewrite history/ledger rows.

create or replace function public.guard_goods_receipt_item_material_resolution_update()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_apply_owner name;
  v_guc text;
begin
  if new.canonical_material_id is not distinct from old.canonical_material_id
    and new.material_resolution_status is not distinct from old.material_resolution_status
    and new.material_resolution_request_id is not distinct from old.material_resolution_request_id
    and new.raw_product_name is not distinct from old.raw_product_name then
    return new;
  end if;

  select pg_get_userbyid(p.proowner) into v_apply_owner
  from pg_proc p
  where p.oid = 'public.apply_goods_receipt_item_material_resolution(uuid, uuid, text, text, text, uuid, text, text)'::regprocedure;

  -- Explicit exact-function marker: owner comparison must be tied to the controlled Task5 linker RPC.
  perform pg_get_functiondef('public.apply_goods_receipt_item_material_resolution(uuid, uuid, text, text, text, uuid, text, text)'::regprocedure);

  v_guc := nullif(current_setting('material_master.goods_receipt_item_resolution', true), '');
  if current_user <> v_apply_owner
    or v_guc is null
    or v_guc !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or v_guc::uuid is distinct from new.id then
    raise exception 'direct goods receipt material resolution DML is not allowed' using errcode = '42501';
  end if;

  if old.canonical_material_id is not null and old.canonical_material_id is distinct from new.canonical_material_id then
    raise exception 'goods receipt canonical material cannot change once linked' using errcode = '23514';
  end if;
  if new.canonical_material_id is not null
    and (new.material_resolution_status <> 'resolved_exact' or new.material_resolution_request_id is null) then
    raise exception 'exact goods receipt canonical link must have exact status and request' using errcode = '23514';
  end if;
  if new.raw_product_name is distinct from old.raw_product_name and old.raw_product_name is not null then
    raise exception 'raw OCR product name is append-only once captured' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke execute on function public.guard_goods_receipt_item_material_resolution_update() from public, anon, authenticated, service_role;

drop trigger if exists trg_guard_goods_receipt_item_material_resolution_update on public.goods_receipt_items;
create trigger trg_guard_goods_receipt_item_material_resolution_update
before update of canonical_material_id, material_resolution_status, material_resolution_request_id, raw_product_name
on public.goods_receipt_items
for each row execute function public.guard_goods_receipt_item_material_resolution_update();

create or replace function public.apply_goods_receipt_item_material_resolution(
  p_goods_receipt_item_id uuid,
  p_expected_material_id uuid,
  p_raw_name text,
  p_raw_code text default null,
  p_raw_unit text default null,
  p_supplier_id uuid default null,
  p_source_type text default 'match_delivery_note',
  p_reason text default 'goods receipt material resolution exact link'
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_item public.goods_receipt_items%rowtype;
  v_receipt public.goods_receipts%rowtype;
  v_resolved jsonb;
  v_request jsonb;
  v_request_id uuid;
  v_request_status text;
  v_request_resolution_status text;
  v_request_resolved_material_id uuid;
  v_ready jsonb;
  v_status text := lower(btrim(coalesce(p_source_type, 'match_delivery_note')));
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_raw_name text := nullif(btrim(coalesce(p_raw_name, '')), '');
  v_raw_unit text := nullif(btrim(coalesce(p_raw_unit, '')), '');
  v_required_caps text[] := array['unit'];
begin
  v_required_caps := array['unit'];
  if not (
    coalesce(public.material_master_jwt_role(), '') = 'service_role'
    or public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'goods_receipts', 'edit')
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if p_goods_receipt_item_id is null or p_expected_material_id is null then
    raise exception 'goods receipt item and expected material required' using errcode = '22023';
  end if;
  if v_status not in ('match_delivery_note','goods_receipt') then
    raise exception 'unsupported goods receipt material source_type' using errcode = '22023';
  end if;
  if v_raw_name is null then
    raise exception 'raw_name required' using errcode = '22023';
  end if;
  if v_reason is null then
    raise exception 'reason required' using errcode = '22023';
  end if;

  select * into v_item from public.goods_receipt_items where id = p_goods_receipt_item_id for update;
  if not found then raise exception 'goods receipt item not found' using errcode = 'P0002'; end if;
  select * into v_receipt from public.goods_receipts where id = v_item.goods_receipt_id for update;
  if not found then raise exception 'goods receipt not found' using errcode = 'P0002'; end if;

  if v_receipt.supplier_id is distinct from p_supplier_id then
    raise exception 'goods receipt supplier identity mismatch' using errcode = '23514';
  end if;
  if v_item.raw_product_name is not null then
    if public.material_master_normalize(v_item.raw_product_name) <> public.material_master_normalize(v_raw_name) then
      raise exception 'goods receipt source raw identity drift' using errcode = '23514';
    end if;
  elsif public.material_master_normalize(v_item.product_name) <> public.material_master_normalize(v_raw_name) then
    raise exception 'goods receipt source raw identity drift' using errcode = '23514';
  end if;
  if lower(btrim(coalesce(v_item.unit, ''))) is distinct from lower(btrim(coalesce(v_raw_unit, v_item.unit, ''))) then
    raise exception 'goods receipt source raw identity drift' using errcode = '23514';
  end if;
  if v_item.canonical_material_id is not null and v_item.canonical_material_id <> p_expected_material_id then
    raise exception 'goods receipt item already linked to different canonical material' using errcode = '23514';
  end if;

  if p_supplier_id is not null then
    v_required_caps := array['unit','supplier_product'];
  end if;

  v_resolved := public.resolve_canonical_material(
    v_raw_name,
    p_raw_code,
    coalesce(v_raw_unit, v_item.unit),
    p_supplier_id,
    v_status,
    current_date,
    v_required_caps
  );
  if coalesce((v_resolved->>'resolved_exact')::boolean, false) is not true
    or (v_resolved->>'material_id')::uuid is distinct from p_expected_material_id then
    raise exception 'goods receipt material resolver did not return exact approved material' using errcode = '23514';
  end if;

  v_request := public.request_material_resolution(
    v_status,
    'goods_receipt_items',
    v_item.goods_receipt_id,
    p_goods_receipt_item_id,
    v_raw_name,
    p_raw_code,
    coalesce(v_raw_unit, v_item.unit),
    p_supplier_id,
    jsonb_build_object('candidate_source', coalesce(v_resolved->>'match_source', 'resolved_exact'), 'confidence', 'exact', 'field_name', 'goods_receipt_item_material')
  );
  v_request_id := (v_request->>'request_id')::uuid;
  v_request_status := v_request->>'status';
  v_request_resolution_status := v_request->>'resolution_status';
  v_request_resolved_material_id := nullif(v_request->>'resolved_material_id', '')::uuid;
  if v_request_id is null
    or v_request_status not in ('already_resolved','request_existing','request_created')
    or v_request_resolution_status not in ('resolved_existing','created_new')
    or v_request_resolved_material_id is distinct from p_expected_material_id then
    raise exception 'terminal exact request evidence required' using errcode = '23514';
  end if;

  v_ready := public.assert_material_ready(p_expected_material_id, v_required_caps, p_supplier_id, coalesce(v_raw_unit, v_item.unit), current_date);
  if coalesce((v_ready->>'ready')::boolean, false) is not true then
    raise exception 'goods receipt canonical material not ready: %', v_ready using errcode = '23514';
  end if;

  if v_item.canonical_material_id = p_expected_material_id
    and v_item.material_resolution_request_id = v_request_id
    and v_item.material_resolution_status = 'resolved_exact' then
    return jsonb_build_object('status','linked_unchanged','source_table','goods_receipt_items','source_id',p_goods_receipt_item_id,'material_id',p_expected_material_id,'request_id',v_request_id);
  end if;

  perform set_config('material_master.goods_receipt_item_resolution', p_goods_receipt_item_id::text, true);
  update public.goods_receipt_items
  set canonical_material_id = p_expected_material_id,
      material_resolution_status = 'resolved_exact',
      material_resolution_request_id = v_request_id,
      raw_product_name = coalesce(raw_product_name, v_raw_name)
  where id = p_goods_receipt_item_id;
  perform set_config('material_master.goods_receipt_item_resolution', '', true);

  perform public.material_master_audit_append(
    'apply_goods_receipt_item_material_resolution',
    p_expected_material_id,
    v_request_id,
    v_reason,
    jsonb_build_object('source_table','goods_receipt_items','source_id',p_goods_receipt_item_id,'canonical_material_id',v_item.canonical_material_id,'material_resolution_status',v_item.material_resolution_status,'material_resolution_request_id',v_item.material_resolution_request_id),
    jsonb_build_object('source_table','goods_receipt_items','source_id',p_goods_receipt_item_id,'canonical_material_id',p_expected_material_id,'material_resolution_status','resolved_exact','material_resolution_request_id',v_request_id,'raw_product_name',coalesce(v_item.raw_product_name, v_raw_name)),
    jsonb_build_object('source_type', v_status, 'source_table', 'goods_receipt_items', 'source_id', p_goods_receipt_item_id)
  );

  return jsonb_build_object('status','linked','source_table','goods_receipt_items','source_id',p_goods_receipt_item_id,'material_id',p_expected_material_id,'request_id',v_request_id);
end;
$$;

revoke execute on function public.apply_goods_receipt_item_material_resolution(uuid, uuid, text, text, text, uuid, text, text) from public, anon;
grant execute on function public.apply_goods_receipt_item_material_resolution(uuid, uuid, text, text, text, uuid, text, text) to authenticated, service_role;

create or replace function public.assert_goods_receipt_materials_ready(
  p_receipt_id uuid,
  p_user_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_mode text := 'shadow';
  v_receipt public.goods_receipts%rowtype;
  v_item record;
  v_ready jsonb;
  v_blockers jsonb := '[]'::jsonb;
  v_line_blockers jsonb;
  v_required_caps text[];
begin
  if p_receipt_id is null then
    raise exception 'receipt id required' using errcode = '22023';
  end if;
  select * into v_receipt from public.goods_receipts where id = p_receipt_id;
  if not found then
    raise exception 'goods receipt not found' using errcode = 'P0002';
  end if;

  select coalesce(mode, 'shadow') into v_mode
  from public.material_master_enforcement_config
  where source_type = 'goods_receipt';
  v_mode := coalesce(v_mode, 'shadow');

  for v_item in
    select gri.id, gri.product_name, gri.raw_product_name, gri.unit, gri.canonical_material_id, gri.material_resolution_status,
           v_receipt.supplier_id as supplier_id, greatest(0, coalesce(gri.actual_quantity, gri.quantity, 0)) as actual_quantity
    from public.goods_receipt_items gri
    where gri.goods_receipt_id = p_receipt_id
    order by gri.created_at asc, gri.id asc
  loop
    if v_item.actual_quantity <= 0 then
      continue;
    end if;
    v_line_blockers := '[]'::jsonb;
    if v_item.canonical_material_id is null then
      v_line_blockers := v_line_blockers || jsonb_build_array('missing_canonical_material');
    else
      v_required_caps := array['unit'];
      if v_item.supplier_id is not null then
        v_required_caps := array['unit','supplier_product'];
      end if;
      v_ready := public.assert_material_ready(v_item.canonical_material_id, v_required_caps, v_item.supplier_id, v_item.unit, current_date);
      if coalesce((v_ready->>'ready')::boolean, false) is not true then
        v_line_blockers := v_line_blockers || coalesce(v_ready->'blockers', '[]'::jsonb);
      end if;
    end if;

    if jsonb_array_length(v_line_blockers) > 0 then
      v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
        'goods_receipt_item_id', v_item.id,
        'raw_product_name', coalesce(v_item.raw_product_name, v_item.product_name),
        'canonical_material_id', v_item.canonical_material_id,
        'blockers', v_line_blockers
      ));
    end if;
  end loop;

  if jsonb_array_length(v_blockers) > 0 then
    perform public.material_master_audit_append(
      'goods_receipt_material_ready_check',
      null,
      null,
      'Task 5 goods_receipt material readiness check before stock/payable mutation',
      '{}'::jsonb,
      jsonb_build_object('receipt_id', p_receipt_id, 'actor_id', p_user_id, 'mode', v_mode, 'blockers', v_blockers),
      jsonb_build_object('source_type','goods_receipt','receipt_id',p_receipt_id)
    );
  end if;

  if v_mode = 'enforced' and jsonb_array_length(v_blockers) > 0 then
    raise exception 'goods_receipt_material_blocked_before_stock/payable mutation: %', v_blockers using errcode = '23514';
  end if;
  return jsonb_build_object('ready', jsonb_array_length(v_blockers) = 0, 'mode', v_mode, 'blockers', v_blockers);
end;
$$;

revoke execute on function public.assert_goods_receipt_materials_ready(uuid, uuid) from public, anon, authenticated;
grant execute on function public.assert_goods_receipt_materials_ready(uuid, uuid) to service_role;

do $$
begin
  if to_regprocedure('public.finalize_goods_receipt_stock_payable_unchecked_20260817(uuid, uuid)') is null then
    if to_regprocedure('public.finalize_goods_receipt(uuid, uuid)') is null then
      raise exception 'finalize_goods_receipt(uuid, uuid) missing before Task5 wrapper' using errcode = '42883';
    end if;
    if pg_get_function_result('public.finalize_goods_receipt(uuid, uuid)'::regprocedure) <> 'jsonb' then
      raise exception 'finalize_goods_receipt(uuid, uuid) must return jsonb before Task5 wrapper' using errcode = '42804';
    end if;
    alter function public.finalize_goods_receipt(uuid, uuid) rename to finalize_goods_receipt_stock_payable_unchecked_20260817;
  end if;
end $$;

create or replace function public.finalize_goods_receipt(
  p_receipt_id uuid,
  p_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_material_check jsonb;
  v_result jsonb;
begin
  if pg_get_function_result('public.finalize_goods_receipt_stock_payable_unchecked_20260817(uuid, uuid)'::regprocedure) <> 'jsonb' then
    raise exception 'unchecked finalize_goods_receipt return type drift' using errcode = '42804';
  end if;
  -- Must run before any stock/payable mutation in enforced mode, in the same DB transaction as finalization.
  v_material_check := public.assert_goods_receipt_materials_ready(p_receipt_id, p_user_id);
  v_result := public.finalize_goods_receipt_stock_payable_unchecked_20260817(p_receipt_id, p_user_id);
  return v_result || jsonb_build_object('materialMaster', v_material_check);
end;
$$;

comment on function public.finalize_goods_receipt(uuid, uuid) is 'Task5 wrapper: assert goods receipt canonical material readiness before stock/payable mutation; unchecked legacy implementation is service_role-only.';

revoke execute on function public.finalize_goods_receipt_stock_payable_unchecked_20260817(uuid, uuid) from public, anon, authenticated;
grant execute on function public.finalize_goods_receipt_stock_payable_unchecked_20260817(uuid, uuid) to service_role;
revoke execute on function public.finalize_goods_receipt(uuid, uuid) from public, anon, authenticated;
grant execute on function public.finalize_goods_receipt(uuid, uuid) to service_role;
