-- Task 6 canonical NVL procurement controller hardening.
-- Additive/wrapper-only: no historical data rewrite; no Task1-5 migration edits.

insert into public.material_master_enforcement_config (source_type, mode)
values
  ('purchase_order', 'shadow'),
  ('payment_request', 'shadow'),
  ('invoice', 'shadow'),
  ('create_invoice_from_pr', 'shadow')
on conflict (source_type) do nothing;

alter table public.payment_request_items
  add column if not exists purchase_order_item_id uuid references public.purchase_order_items(id) on delete set null;
create index if not exists idx_payment_request_items_purchase_order_item_id
  on public.payment_request_items(purchase_order_item_id) where purchase_order_item_id is not null;

create or replace function public.procurement_material_line_kind(
  p_source_table text,
  p_source_line_id uuid,
  p_standard_cost_code_type text default null,
  p_sku_id uuid default null,
  p_canonical_material_id uuid default null
)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_table text := lower(btrim(coalesce(p_source_table, '')));
  v_sku_id uuid := p_sku_id;
  v_cost_type text := upper(btrim(coalesce(p_standard_cost_code_type, '')));
  v_canonical_material_id uuid := p_canonical_material_id;
  v_sku_type text;
begin
  if p_source_line_id is not null then
    if v_table = 'purchase_order_items' then
      select poi.sku_id, poi.canonical_material_id
        into v_sku_id, v_canonical_material_id
      from public.purchase_order_items poi where poi.id = p_source_line_id;
    elsif v_table = 'payment_request_items' then
      select pri.sku_id, upper(btrim(coalesce(pri.standard_cost_code_type, ''))), pri.canonical_material_id
        into v_sku_id, v_cost_type, v_canonical_material_id
      from public.payment_request_items pri where pri.id = p_source_line_id;
    elsif v_table = 'invoice_items' then
      select null::uuid, upper(btrim(coalesce(ii.standard_cost_code_type, ''))), ii.canonical_material_id
        into v_sku_id, v_cost_type, v_canonical_material_id
      from public.invoice_items ii where ii.id = p_source_line_id;
    elsif v_table = 'goods_receipt_items' then
      select gri.sku_id, gri.canonical_material_id
        into v_sku_id, v_canonical_material_id
      from public.goods_receipt_items gri where gri.id = p_source_line_id;
    end if;
  end if;

  -- Authoritative explicit NVL/canonical/raw-SKU evidence only. No product-name keyword heuristics.
  if v_canonical_material_id is not null or v_cost_type = 'NVL' then
    return 'raw_material';
  end if;

  if v_sku_id is not null then
    select lower(btrim(ps.sku_type::text)) into v_sku_type
    from public.product_skus ps where ps.id = v_sku_id;
    if v_sku_type in ('raw_material','nvl') then
      return 'raw_material';
    elsif v_sku_type in ('finished_good','finished-goods','finished_goods','thanh_pham') then
      return 'finished_good';
    end if;
  end if;

  if v_cost_type in ('OPEX','OTHER','SERVICE','NON_MATERIAL','NON-MATERIAL') then
    return 'service_or_non_material';
  end if;

  return 'unknown';
end;
$$;

-- Backward-compatible boolean wrapper. Unknown is intentionally not false for enforcement code; callers must use line_kind.
create or replace function public.procurement_material_line_is_relevant(
  p_source_table text,
  p_source_line_id uuid,
  p_standard_cost_code_type text default null,
  p_sku_id uuid default null,
  p_product_name text default null
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.procurement_material_line_kind(p_source_table, p_source_line_id, p_standard_cost_code_type, p_sku_id, null) in ('raw_material','unknown');
$$;

create or replace function public.guard_procurement_line_material_resolution_update()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_apply_owner name;
  v_queue_owner name;
  v_invoice_owner name;
  v_create_line_owner name;
  v_manual_invoice_owner name;
  v_guc text;
begin
  if tg_op = 'INSERT' then
    if new.canonical_material_id is null
      and new.material_resolution_status is null
      and new.material_resolution_request_id is null
      and new.raw_product_name is null then
      return new;
    end if;
  else
    if new.canonical_material_id is not distinct from old.canonical_material_id
      and new.material_resolution_status is not distinct from old.material_resolution_status
      and new.material_resolution_request_id is not distinct from old.material_resolution_request_id
      and new.raw_product_name is not distinct from old.raw_product_name then
      return new;
    end if;
  end if;

  select pg_get_userbyid(p.proowner) into v_apply_owner
  from pg_proc p
  where p.oid = to_regprocedure('public.apply_procurement_line_material_resolution(text, uuid, text, text, text, uuid, text, text, uuid)');
  select pg_get_userbyid(p.proowner) into v_queue_owner
  from pg_proc p
  where p.oid = to_regprocedure('public.ensure_purchase_order_receipt_queue(uuid)');
  select pg_get_userbyid(p.proowner) into v_invoice_owner
  from pg_proc p
  where p.oid = to_regprocedure('public.create_invoice_from_payment_request(uuid, text, date, numeric, text, text, uuid)');
  select pg_get_userbyid(p.proowner) into v_create_line_owner
  from pg_proc p
  where p.oid = to_regprocedure('public.create_procurement_line_with_material_resolution(text, uuid, jsonb, text, uuid)');
  select pg_get_userbyid(p.proowner) into v_manual_invoice_owner
  from pg_proc p
  where p.oid = to_regprocedure('public.create_invoice_with_material_controller(jsonb, jsonb, uuid)');

  v_guc := nullif(current_setting('material_master.procurement_line_resolution', true), '');
  if current_user is distinct from v_apply_owner
     and current_user is distinct from v_queue_owner
     and current_user is distinct from v_invoice_owner
     and current_user is distinct from v_create_line_owner
     and current_user is distinct from v_manual_invoice_owner then
    raise exception 'direct procurement material resolution DML is not allowed' using errcode = '42501';
  end if;
  if v_guc is null
    or v_guc !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or v_guc::uuid is distinct from new.id then
    raise exception 'direct procurement material resolution DML is not allowed' using errcode = '42501';
  end if;

  if tg_op = 'UPDATE' and old.canonical_material_id is not null and old.canonical_material_id is distinct from new.canonical_material_id then
    raise exception 'procurement canonical material cannot change once linked' using errcode = '23514';
  end if;
  if new.material_resolution_status is not null
    and new.material_resolution_status not in ('resolved_exact','confirmation_needed','ambiguous','not_found','inactive','unit_unmapped','supplier_unmapped','controller_error','not_material','finished_good','service_or_non_material','unknown') then
    raise exception 'strict procurement material resolution status required' using errcode = '23514';
  end if;
  if new.canonical_material_id is not null
    and (new.material_resolution_status <> 'resolved_exact' or new.material_resolution_request_id is null) then
    raise exception 'exact procurement canonical link must have exact status and request' using errcode = '23514';
  end if;
  if tg_op = 'UPDATE' and new.raw_product_name is distinct from old.raw_product_name and old.raw_product_name is not null then
    raise exception 'raw procurement product name is append-only once captured' using errcode = '23514';
  end if;
  return new;
end;
$$;

revoke execute on function public.guard_procurement_line_material_resolution_update() from public, anon, authenticated, service_role;

drop trigger if exists trg_guard_purchase_order_items_material_resolution on public.purchase_order_items;
create trigger trg_guard_purchase_order_items_material_resolution
before insert or update of canonical_material_id, material_resolution_status, material_resolution_request_id, raw_product_name
on public.purchase_order_items
for each row execute function public.guard_procurement_line_material_resolution_update();

drop trigger if exists trg_guard_payment_request_items_material_resolution on public.payment_request_items;
create trigger trg_guard_payment_request_items_material_resolution
before insert or update of canonical_material_id, material_resolution_status, material_resolution_request_id, raw_product_name
on public.payment_request_items
for each row execute function public.guard_procurement_line_material_resolution_update();

drop trigger if exists trg_guard_invoice_items_material_resolution on public.invoice_items;
create trigger trg_guard_invoice_items_material_resolution
before insert or update of canonical_material_id, material_resolution_status, material_resolution_request_id, raw_product_name
on public.invoice_items
for each row execute function public.guard_procurement_line_material_resolution_update();

create or replace function public.apply_procurement_line_material_resolution(
  p_source_table text,
  p_source_line_id uuid,
  p_raw_name text,
  p_raw_code text default null,
  p_raw_unit text default null,
  p_supplier_id uuid default null,
  p_source_type text default null,
  p_reason text default 'procurement material resolution exact link',
  p_expected_material_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_table text := lower(btrim(coalesce(p_source_table, '')));
  v_source_type text := lower(btrim(coalesce(p_source_type, '')));
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_raw_name text := nullif(btrim(coalesce(p_raw_name, '')), '');
  v_raw_unit text := nullif(btrim(coalesce(p_raw_unit, '')), '');
  v_line record;
  v_parent_id uuid;
  v_supplier_id uuid;
  v_kind text;
  v_required_caps text[] := array['unit'];
  v_resolved jsonb;
  v_request jsonb;
  v_request_id uuid;
  v_request_status text;
  v_request_resolution_status text;
  v_request_resolved_material_id uuid;
  v_material_id uuid;
  v_status text;
  v_ready jsonb;
begin
  if not (
    coalesce(public.material_master_jwt_role(), '') = 'service_role'
    or public.has_role((select auth.uid()), 'owner')
    or (v_table = 'purchase_order_items' and public.has_module_permission((select auth.uid()), 'purchase_orders', 'edit'))
    or (v_table = 'payment_request_items' and public.has_module_permission((select auth.uid()), 'payment_requests', 'edit'))
    or (v_table = 'invoice_items' and public.has_module_permission((select auth.uid()), 'finance_cost', 'edit'))
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if v_table not in ('purchase_order_items','payment_request_items','invoice_items') then
    raise exception 'unsupported procurement source table' using errcode = '22023';
  end if;
  if v_source_type = '' then
    v_source_type := case v_table when 'purchase_order_items' then 'purchase_order' when 'payment_request_items' then 'payment_request' else 'invoice' end;
  end if;
  if v_source_type not in ('purchase_order','payment_request','invoice','create_invoice_from_pr') then
    raise exception 'unsupported procurement source_type' using errcode = '22023';
  end if;
  if p_source_line_id is null or v_raw_name is null or v_reason is null then
    raise exception 'source line, raw_name, and reason required' using errcode = '22023';
  end if;

  if v_table = 'purchase_order_items' then
    select poi.id, poi.purchase_order_id as parent_id, po.supplier_id, poi.product_name, poi.unit, poi.sku_id, null::text as standard_cost_code_type,
           poi.canonical_material_id, poi.material_resolution_status, poi.material_resolution_request_id, poi.raw_product_name
      into v_line
    from public.purchase_order_items poi join public.purchase_orders po on po.id = poi.purchase_order_id
    where poi.id = p_source_line_id for update;
  elsif v_table = 'payment_request_items' then
    select pri.id, pri.payment_request_id as parent_id, pr.supplier_id, pri.product_name, pri.unit, pri.sku_id, pri.standard_cost_code_type,
           pri.canonical_material_id, pri.material_resolution_status, pri.material_resolution_request_id, pri.raw_product_name
      into v_line
    from public.payment_request_items pri join public.payment_requests pr on pr.id = pri.payment_request_id
    where pri.id = p_source_line_id for update;
  else
    select ii.id, ii.invoice_id as parent_id, inv.supplier_id, ii.product_name, ii.unit, null::uuid as sku_id, ii.standard_cost_code_type,
           ii.canonical_material_id, ii.material_resolution_status, ii.material_resolution_request_id, ii.raw_product_name
      into v_line
    from public.invoice_items ii join public.invoices inv on inv.id = ii.invoice_id
    where ii.id = p_source_line_id for update;
  end if;
  if not found then raise exception 'procurement source line not found' using errcode = 'P0002'; end if;
  v_parent_id := v_line.parent_id;
  v_supplier_id := coalesce(p_supplier_id, v_line.supplier_id);
  if p_supplier_id is not null and v_line.supplier_id is distinct from p_supplier_id then
    raise exception 'procurement supplier identity mismatch' using errcode = '23514';
  end if;
  if v_line.raw_product_name is not null and public.material_master_normalize(v_line.raw_product_name) <> public.material_master_normalize(v_raw_name) then
    raise exception 'procurement source raw identity drift' using errcode = '23514';
  elsif v_line.raw_product_name is null and public.material_master_normalize(v_line.product_name) <> public.material_master_normalize(v_raw_name) then
    raise exception 'procurement source raw identity drift' using errcode = '23514';
  end if;
  if lower(btrim(coalesce(v_line.unit, ''))) is distinct from lower(btrim(coalesce(v_raw_unit, v_line.unit, ''))) then
    raise exception 'procurement source unit drift' using errcode = '23514';
  end if;

  v_kind := public.procurement_material_line_kind(v_table, p_source_line_id, v_line.standard_cost_code_type, v_line.sku_id, v_line.canonical_material_id);
  if v_kind in ('finished_good','service_or_non_material') then
    perform set_config('material_master.procurement_line_resolution', p_source_line_id::text, true);
    if v_table = 'purchase_order_items' then
      update public.purchase_order_items set raw_product_name = coalesce(raw_product_name, v_raw_name), material_resolution_status = coalesce(material_resolution_status, v_kind) where id = p_source_line_id;
    elsif v_table = 'payment_request_items' then
      update public.payment_request_items set raw_product_name = coalesce(raw_product_name, v_raw_name), material_resolution_status = coalesce(material_resolution_status, v_kind) where id = p_source_line_id;
    else
      update public.invoice_items set raw_product_name = coalesce(raw_product_name, v_raw_name), material_resolution_status = coalesce(material_resolution_status, v_kind) where id = p_source_line_id;
    end if;
    perform set_config('material_master.procurement_line_resolution', '', true);
    return jsonb_build_object('status',v_kind,'line_kind',v_kind,'source_table',v_table,'source_id',p_source_line_id,'material_id',null,'request_id',null,'resolved_exact',false);
  end if;

  if v_supplier_id is not null then v_required_caps := array['unit','supplier_product']; end if;
  v_resolved := public.resolve_canonical_material(v_raw_name, p_raw_code, coalesce(v_raw_unit, v_line.unit), v_supplier_id, v_source_type, current_date, v_required_caps);
  v_status := coalesce(v_resolved->>'status', 'controller_error');
  v_material_id := nullif(v_resolved->>'material_id', '')::uuid;
  if p_expected_material_id is not null and v_material_id is distinct from p_expected_material_id then
    raise exception 'procurement material resolver did not return expected material' using errcode = '23514';
  end if;

  v_request := public.request_material_resolution(
    v_source_type, v_table, v_parent_id, p_source_line_id, v_raw_name, p_raw_code, coalesce(v_raw_unit, v_line.unit), v_supplier_id,
    jsonb_build_object('candidate_source', coalesce(v_resolved->>'match_source', v_status), 'confidence', case when coalesce((v_resolved->>'resolved_exact')::boolean, false) then 'exact' else 'pending' end, 'field_name', v_table || '.canonical_material_id')
  );
  v_request_id := nullif(v_request->>'request_id', '')::uuid;
  v_request_status := v_request->>'status';
  v_request_resolution_status := v_request->>'resolution_status';
  v_request_resolved_material_id := nullif(v_request->>'resolved_material_id', '')::uuid;
  if v_request_id is null or v_request_status not in ('already_resolved','request_existing','request_created') then
    raise exception 'stable material resolution request required' using errcode = '23514';
  end if;

  if coalesce((v_resolved->>'resolved_exact')::boolean, false) is not true then
    perform set_config('material_master.procurement_line_resolution', p_source_line_id::text, true);
    if v_table = 'purchase_order_items' then
      update public.purchase_order_items set raw_product_name = coalesce(raw_product_name, v_raw_name), material_resolution_status = case when v_kind = 'unknown' then 'unknown' else v_status end, material_resolution_request_id = v_request_id where id = p_source_line_id;
    elsif v_table = 'payment_request_items' then
      update public.payment_request_items set raw_product_name = coalesce(raw_product_name, v_raw_name), material_resolution_status = case when v_kind = 'unknown' then 'unknown' else v_status end, material_resolution_request_id = v_request_id where id = p_source_line_id;
    else
      update public.invoice_items set raw_product_name = coalesce(raw_product_name, v_raw_name), material_resolution_status = case when v_kind = 'unknown' then 'unknown' else v_status end, material_resolution_request_id = v_request_id where id = p_source_line_id;
    end if;
    perform set_config('material_master.procurement_line_resolution', '', true);
    return jsonb_build_object('status',case when v_kind = 'unknown' then 'unknown' else v_status end,'line_kind',v_kind,'source_table',v_table,'source_id',p_source_line_id,'material_id',null,'request_id',v_request_id,'resolved_exact',false);
  end if;

  if v_request_resolution_status not in ('resolved_existing','created_new')
    or v_request_resolved_material_id is distinct from v_material_id then
    raise exception 'terminal exact request evidence required' using errcode = '23514';
  end if;

  v_ready := public.assert_material_ready(v_material_id, v_required_caps, v_supplier_id, coalesce(v_raw_unit, v_line.unit), current_date);
  if coalesce((v_ready->>'ready')::boolean, false) is not true then
    raise exception 'procurement canonical material not ready: %', v_ready using errcode = '23514';
  end if;

  if v_line.canonical_material_id is not null and v_line.canonical_material_id <> v_material_id then
    raise exception 'procurement line already linked to different canonical material' using errcode = '23514';
  end if;
  if v_line.canonical_material_id = v_material_id and v_line.material_resolution_request_id = v_request_id and v_line.material_resolution_status = 'resolved_exact' then
    return jsonb_build_object('status','linked_unchanged','line_kind',v_kind,'source_table',v_table,'source_id',p_source_line_id,'material_id',v_material_id,'request_id',v_request_id,'resolved_exact',true);
  end if;

  perform set_config('material_master.procurement_line_resolution', p_source_line_id::text, true);
  if v_table = 'purchase_order_items' then
    update public.purchase_order_items set canonical_material_id = v_material_id, material_resolution_status = 'resolved_exact', material_resolution_request_id = v_request_id, raw_product_name = coalesce(raw_product_name, v_raw_name) where id = p_source_line_id;
  elsif v_table = 'payment_request_items' then
    update public.payment_request_items set canonical_material_id = v_material_id, material_resolution_status = 'resolved_exact', material_resolution_request_id = v_request_id, raw_product_name = coalesce(raw_product_name, v_raw_name) where id = p_source_line_id;
  else
    update public.invoice_items set canonical_material_id = v_material_id, material_resolution_status = 'resolved_exact', material_resolution_request_id = v_request_id, raw_product_name = coalesce(raw_product_name, v_raw_name) where id = p_source_line_id;
  end if;
  perform set_config('material_master.procurement_line_resolution', '', true);

  perform public.material_master_audit_append(
    'apply_procurement_line_material_resolution', v_material_id, v_request_id, v_reason,
    jsonb_build_object('source_table',v_table,'source_id',p_source_line_id,'canonical_material_id',v_line.canonical_material_id,'material_resolution_status',v_line.material_resolution_status,'material_resolution_request_id',v_line.material_resolution_request_id),
    jsonb_build_object('source_table',v_table,'source_id',p_source_line_id,'canonical_material_id',v_material_id,'material_resolution_status','resolved_exact','material_resolution_request_id',v_request_id,'raw_product_name',coalesce(v_line.raw_product_name, v_raw_name)),
    jsonb_build_object('source_type',v_source_type,'source_table',v_table,'source_id',p_source_line_id)
  );
  return jsonb_build_object('status','linked','line_kind',v_kind,'source_table',v_table,'source_id',p_source_line_id,'material_id',v_material_id,'request_id',v_request_id,'resolved_exact',true);
end;
$$;

revoke execute on function public.apply_procurement_line_material_resolution(text, uuid, text, text, text, uuid, text, text, uuid) from public, anon;
grant execute on function public.apply_procurement_line_material_resolution(text, uuid, text, text, text, uuid, text, text, uuid) to authenticated, service_role;

create or replace function public.assert_procurement_materials_ready(
  p_source_id uuid,
  p_source_type text,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source_type text := lower(btrim(coalesce(p_source_type, '')));
  v_config_source text := case when lower(btrim(coalesce(p_source_type,''))) = 'create_invoice_from_pr' then 'create_invoice_from_pr' else lower(btrim(coalesce(p_source_type,''))) end;
  v_mode text := 'shadow';
  v_line record;
  v_kind text;
  v_blockers jsonb := '[]'::jsonb;
  v_line_blockers jsonb;
  v_ready jsonb;
  v_required_caps text[];
  v_request jsonb;
begin
  select coalesce(mode, 'shadow') into v_mode from public.material_master_enforcement_config where source_type = v_config_source;
  v_mode := coalesce(v_mode, 'shadow');

  for v_line in
    select * from (
      select 'purchase_order_items'::text as source_table, poi.id, poi.purchase_order_id as parent_id, po.supplier_id, poi.product_name, poi.raw_product_name, poi.unit, poi.sku_id, null::text as standard_cost_code_type, poi.canonical_material_id, poi.material_resolution_status, poi.material_resolution_request_id
      from public.purchase_order_items poi join public.purchase_orders po on po.id = poi.purchase_order_id
      where v_source_type = 'purchase_order' and poi.purchase_order_id = p_source_id
      union all
      select 'payment_request_items', pri.id, pri.payment_request_id, pr.supplier_id, pri.product_name, pri.raw_product_name, pri.unit, pri.sku_id, pri.standard_cost_code_type, pri.canonical_material_id, pri.material_resolution_status, pri.material_resolution_request_id
      from public.payment_request_items pri join public.payment_requests pr on pr.id = pri.payment_request_id
      where v_source_type in ('payment_request','create_invoice_from_pr') and pri.payment_request_id = p_source_id
      union all
      select 'invoice_items', ii.id, ii.invoice_id, inv.supplier_id, ii.product_name, ii.raw_product_name, ii.unit, null::uuid as sku_id, ii.standard_cost_code_type, ii.canonical_material_id, ii.material_resolution_status, ii.material_resolution_request_id
      from public.invoice_items ii join public.invoices inv on inv.id = ii.invoice_id
      where v_source_type = 'invoice' and ii.invoice_id = p_source_id
    ) q
    order by q.id
  loop
    v_kind := public.procurement_material_line_kind(v_line.source_table, v_line.id, v_line.standard_cost_code_type, v_line.sku_id, v_line.canonical_material_id);
    if v_kind in ('finished_good','service_or_non_material') then
      continue;
    end if;
    v_line_blockers := '[]'::jsonb;
    if v_kind = 'unknown' then
      if v_line.material_resolution_request_id is null then
        v_request := public.request_material_resolution(
          v_config_source, v_line.source_table, v_line.parent_id, v_line.id,
          coalesce(v_line.raw_product_name, v_line.product_name), null, v_line.unit, v_line.supplier_id,
          jsonb_build_object('candidate_source','procurement_unknown','confidence','pending','field_name',v_line.source_table || '.canonical_material_id')
        );
        perform set_config('material_master.procurement_line_resolution', v_line.id::text, true);
        if v_line.source_table = 'purchase_order_items' then
          update public.purchase_order_items set raw_product_name = coalesce(raw_product_name, v_line.product_name), material_resolution_status = 'unknown', material_resolution_request_id = nullif(v_request->>'request_id','')::uuid where id = v_line.id;
        elsif v_line.source_table = 'payment_request_items' then
          update public.payment_request_items set raw_product_name = coalesce(raw_product_name, v_line.product_name), material_resolution_status = 'unknown', material_resolution_request_id = nullif(v_request->>'request_id','')::uuid where id = v_line.id;
        else
          update public.invoice_items set raw_product_name = coalesce(raw_product_name, v_line.product_name), material_resolution_status = 'unknown', material_resolution_request_id = nullif(v_request->>'request_id','')::uuid where id = v_line.id;
        end if;
        perform set_config('material_master.procurement_line_resolution', '', true);
      end if;
      v_line_blockers := v_line_blockers || jsonb_build_array('unknown_material_relevance');
    elsif v_line.canonical_material_id is null or v_line.material_resolution_status is distinct from 'resolved_exact' then
      v_line_blockers := v_line_blockers || jsonb_build_array('missing_canonical_material');
    else
      v_required_caps := array['unit'];
      if v_line.supplier_id is not null then v_required_caps := array['unit','supplier_product']; end if;
      v_ready := public.assert_material_ready(v_line.canonical_material_id, v_required_caps, v_line.supplier_id, v_line.unit, current_date);
      if coalesce((v_ready->>'ready')::boolean, false) is not true then
        v_line_blockers := v_line_blockers || coalesce(v_ready->'blockers', '[]'::jsonb);
      end if;
    end if;
    if jsonb_array_length(v_line_blockers) > 0 then
      v_blockers := v_blockers || jsonb_build_array(jsonb_build_object('source_table',v_line.source_table,'source_line_id',v_line.id,'line_kind',case when v_kind='unknown' then 'unknown_material_relevance' else v_kind end,'raw_product_name',coalesce(v_line.raw_product_name, v_line.product_name),'canonical_material_id',v_line.canonical_material_id,'blockers',v_line_blockers));
    end if;
  end loop;

  if jsonb_array_length(v_blockers) > 0 then
    perform public.material_master_audit_append('procurement_material_ready_check', null, null, 'Task6 procurement material readiness check before posting/cost/invoice mutation', '{}'::jsonb, jsonb_build_object('source_type',v_source_type,'source_id',p_source_id,'actor_id',p_actor_id,'mode',v_mode,'blockers',v_blockers), jsonb_build_object('source_type',v_source_type,'source_id',p_source_id));
  end if;
  if v_mode = 'enforced' and jsonb_array_length(v_blockers) > 0 then
    raise exception 'procurement_material_blocked_before_mutation: %', v_blockers using errcode = '23514';
  end if;
  return jsonb_build_object('ready', jsonb_array_length(v_blockers) = 0, 'mode', v_mode, 'source_type', v_source_type, 'source_id', p_source_id, 'blockers', v_blockers);
end;
$$;

revoke execute on function public.assert_procurement_materials_ready(uuid, text, uuid) from public, anon;
grant execute on function public.assert_procurement_materials_ready(uuid, text, uuid) to authenticated, service_role;

-- Wrap PO -> GR/PR queue with readiness assertion and schema-authoritative carry.
do $$
begin
  if to_regprocedure('public.ensure_purchase_order_receipt_queue_unchecked_20260817_task6(uuid)') is null then
    if to_regprocedure('public.ensure_purchase_order_receipt_queue(uuid)') is null then
      raise exception 'ensure_purchase_order_receipt_queue(uuid) missing before Task6 wrapper' using errcode = '42883';
    end if;
    alter function public.ensure_purchase_order_receipt_queue(uuid) rename to ensure_purchase_order_receipt_queue_unchecked_20260817_task6;
  end if;
end $$;

create or replace function public.ensure_purchase_order_receipt_queue(p_purchase_order_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_purchase_order public.purchase_orders%rowtype;
  v_receipt_id uuid;
  v_receipt_number text;
  v_payable_id uuid;
  v_request_number text;
  v_gri_id uuid;
  v_pri_id uuid;
  poi record;
begin
  perform public.assert_procurement_materials_ready(p_purchase_order_id, 'purchase_order', auth.uid());

  select * into v_purchase_order from public.purchase_orders where id = p_purchase_order_id for update;
  if not found then raise exception 'Purchase order % not found', p_purchase_order_id; end if;

  select id into v_receipt_id from public.goods_receipts
  where purchase_order_id = p_purchase_order_id and status in ('draft', 'confirmed')
  order by created_at asc limit 1 for update;

  if v_receipt_id is null then
    v_receipt_number := public.generate_receipt_number();
    insert into public.goods_receipts(receipt_number, receipt_date, purchase_order_id, supplier_id, status, total_quantity, payable_status, variance_summary, notes)
    values (v_receipt_number, current_date, p_purchase_order_id, v_purchase_order.supplier_id, 'confirmed', 0, 'not_generated', '{}'::jsonb,
            'Tự động tạo phiếu chờ kế toán kho xác nhận từ PO; mặc định khớp PO, chỉ cập nhật thực tế khi có chênh lệch.')
    returning id into v_receipt_id;
  else
    update public.goods_receipts
    set status = case when status = 'draft' then 'confirmed'::public.goods_receipt_status else status end,
        notes = coalesce(nullif(notes, ''), 'Tự động tạo phiếu chờ kế toán kho xác nhận từ PO; mặc định khớp PO, chỉ cập nhật thực tế khi có chênh lệch.'),
        updated_at = now()
    where id = v_receipt_id;
  end if;

  if exists (select 1 from public.goods_receipts where id = v_receipt_id and status = 'confirmed') then
    delete from public.goods_receipt_items where goods_receipt_id = v_receipt_id;
    for poi in select * from public.purchase_order_items where purchase_order_id = p_purchase_order_id order by created_at asc loop
      v_gri_id := gen_random_uuid();
      perform set_config('material_master.goods_receipt_item_resolution', v_gri_id::text, true);
      insert into public.goods_receipt_items(
        id, goods_receipt_id, purchase_order_item_id, product_name, ordered_quantity, actual_quantity, quantity, unit, unit_price, sku_id, notes,
        canonical_material_id, material_resolution_status, material_resolution_request_id, raw_product_name
      ) values (
        v_gri_id, v_receipt_id, poi.id, poi.product_name, poi.quantity, null, 0, poi.unit, poi.unit_price, poi.sku_id,
        nullif(concat_ws('; ', 'Từ PO - mặc định thực nhận khớp số đặt nếu không có chênh lệch', poi.notes), ''),
        poi.canonical_material_id, poi.material_resolution_status, poi.material_resolution_request_id, coalesce(poi.raw_product_name, poi.product_name)
      );
      perform set_config('material_master.goods_receipt_item_resolution', '', true);
    end loop;
  end if;

  select id into v_payable_id from public.payment_requests
  where purchase_order_id = p_purchase_order_id and goods_receipt_id = v_receipt_id
  order by created_at asc limit 1 for update;

  if v_payable_id is null then
    select payment_request_id into v_payable_id from public.goods_receipts where id = v_receipt_id and payment_request_id is not null limit 1;
    if v_payable_id is not null then perform 1 from public.payment_requests where id = v_payable_id for update; end if;
  end if;

  if v_payable_id is null then
    v_request_number := 'PR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
    insert into public.payment_requests(request_number, supplier_id, purchase_order_id, goods_receipt_id, title, description, total_amount, vat_amount, status, delivery_status, payment_status, payment_type, payment_method, image_url, created_by, notes)
    values (v_request_number, v_purchase_order.supplier_id, p_purchase_order_id, v_receipt_id, 'Duyệt chi PO ' || v_purchase_order.po_number,
            'Tạm tính từ PO ' || v_purchase_order.po_number || '. Kế toán kho xác nhận phiếu nhập; nếu phiếu giao hàng lệch PO thì công nợ cập nhật theo số thực nhận.',
            coalesce(v_purchase_order.total_amount, 0), coalesce(v_purchase_order.vat_amount, 0), 'pending', 'pending', 'unpaid', 'new_order', 'bank_transfer', v_purchase_order.image_url, v_purchase_order.created_by,
            'Tự động tạo cùng PO; chờ kế toán kho xác nhận nhập kho/công nợ.')
    returning id into v_payable_id;
  else
    update public.payment_requests
    set supplier_id = v_purchase_order.supplier_id,
        purchase_order_id = p_purchase_order_id,
        goods_receipt_id = v_receipt_id,
        title = 'Duyệt chi PO ' || v_purchase_order.po_number,
        description = 'Tạm tính/cập nhật từ PO ' || v_purchase_order.po_number || '. Kế toán kho xác nhận phiếu nhập; nếu phiếu giao hàng lệch PO thì công nợ cập nhật theo số thực nhận.',
        total_amount = coalesce(v_purchase_order.total_amount, 0),
        vat_amount = coalesce(v_purchase_order.vat_amount, 0),
        status = case when status = 'rejected' then 'pending'::payment_request_status else status end,
        delivery_status = case when delivery_status = 'delivered' then delivery_status else 'pending'::delivery_status end,
        payment_status = coalesce(payment_status, 'unpaid'::payment_status),
        payment_type = coalesce(payment_type, 'new_order'::payment_type),
        payment_method = coalesce(payment_method, 'bank_transfer'::payment_method_type),
        image_url = coalesce(image_url, v_purchase_order.image_url),
        updated_at = now(),
        notes = 'Tự động tạo/cập nhật cùng PO; chờ kế toán kho xác nhận nhập kho/công nợ.'
    where id = v_payable_id;
    delete from public.payment_request_items where payment_request_id = v_payable_id;
  end if;

  for poi in select * from public.purchase_order_items where purchase_order_id = p_purchase_order_id order by created_at asc loop
    v_pri_id := gen_random_uuid();
    perform set_config('material_master.procurement_line_resolution', v_pri_id::text, true);
    insert into public.payment_request_items(
      id, payment_request_id, purchase_order_item_id, product_name, quantity, unit, unit_price, line_total, sku_id, notes,
      canonical_material_id, material_resolution_status, material_resolution_request_id, raw_product_name
    ) values (
      v_pri_id, v_payable_id, poi.id, poi.product_name, poi.quantity, poi.unit, poi.unit_price, coalesce(poi.line_total, poi.quantity * poi.unit_price), poi.sku_id,
      nullif(concat_ws('; ', 'PO item: ' || poi.id::text, poi.notes), ''),
      poi.canonical_material_id, poi.material_resolution_status, poi.material_resolution_request_id, coalesce(poi.raw_product_name, poi.product_name)
    );
    perform set_config('material_master.procurement_line_resolution', '', true);
  end loop;

  update public.goods_receipts set payment_request_id = v_payable_id, updated_at = now() where id = v_receipt_id;
  perform set_config('material_master.purchase_order_status_transition', p_purchase_order_id::text, true);
  update public.purchase_orders set status = case when status = 'draft' then 'sent'::purchase_order_status else status end, updated_at = now() where id = p_purchase_order_id;
  perform set_config('material_master.purchase_order_status_transition', '', true);
  return v_receipt_id;
exception
  when unique_violation then
    select id into v_receipt_id from public.goods_receipts where purchase_order_id = p_purchase_order_id and status in ('draft','confirmed') order by created_at asc limit 1;
    if v_receipt_id is not null then return public.ensure_purchase_order_receipt_queue(p_purchase_order_id); end if;
    raise;
end;
$$;

grant execute on function public.ensure_purchase_order_receipt_queue(uuid) to authenticated, service_role;
revoke execute on function public.ensure_purchase_order_receipt_queue_unchecked_20260817_task6(uuid) from public, anon, authenticated;
grant execute on function public.ensure_purchase_order_receipt_queue_unchecked_20260817_task6(uuid) to service_role;

create or replace function public.create_invoice_from_payment_request(
  p_payment_request_id uuid,
  p_invoice_number text,
  p_invoice_date date,
  p_vat_amount numeric default 0,
  p_notes text default null,
  p_payment_slip_url text default null,
  p_created_by uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_pr public.payment_requests%rowtype;
  v_actor uuid := auth.uid();
  v_invoice_id uuid;
  v_subtotal numeric := 0;
  v_total numeric := 0;
  v_item_count integer := 0;
  v_copied_material_count integer := 0;
  v_pending_count integer := 0;
  v_check jsonb;
  v_invoice_item_id uuid;
  pr_item record;
begin
  if coalesce(public.material_master_jwt_role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'authenticated actor required' using errcode = '42501'; end if;
    if p_created_by is not null and p_created_by is distinct from v_actor then
      raise exception 'created_by spoofing is not allowed' using errcode = '42501';
    end if;
  end if;
  if not (
    coalesce(public.material_master_jwt_role(), '') = 'service_role'
    or public.has_role(v_actor, 'owner')
    or public.has_module_permission(v_actor, 'finance_cost', 'edit')
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if p_payment_request_id is null or nullif(btrim(coalesce(p_invoice_number, '')), '') is null or p_invoice_date is null then
    raise exception 'payment request, invoice number, and invoice date required' using errcode = '22023';
  end if;

  select * into v_pr from public.payment_requests where id = p_payment_request_id for update;
  if not found then raise exception 'payment request not found' using errcode = 'P0002'; end if;
  if coalesce(v_pr.invoice_created, false) or v_pr.invoice_id is not null then raise exception 'invoice already created for this payment request' using errcode = '23505'; end if;
  if v_pr.status::text not in ('approved','paid','completed') then raise exception 'payment request must be approved before invoice creation' using errcode = '23514'; end if;

  v_check := public.assert_procurement_materials_ready(p_payment_request_id, 'create_invoice_from_pr', coalesce(p_created_by, v_actor));

  select coalesce(sum(coalesce(line_total, quantity * unit_price)), 0), count(*)
    into v_subtotal, v_item_count
  from public.payment_request_items where payment_request_id = p_payment_request_id;
  if v_item_count <= 0 then raise exception 'payment request has no items' using errcode = '23514'; end if;
  v_total := v_subtotal + coalesce(p_vat_amount, 0);

  insert into public.invoices(invoice_number, invoice_date, supplier_id, subtotal, vat_amount, total_amount, notes, image_url, payment_slip_url, payment_request_id, purchase_order_id, goods_receipt_id, created_by)
  values (btrim(p_invoice_number), p_invoice_date, v_pr.supplier_id, v_subtotal, coalesce(p_vat_amount, 0), v_total, coalesce(nullif(p_notes,''), 'Tạo từ đề nghị chi'), v_pr.image_url, p_payment_slip_url, p_payment_request_id, v_pr.purchase_order_id, v_pr.goods_receipt_id, coalesce(p_created_by, v_actor))
  returning id into v_invoice_id;

  for pr_item in select * from public.payment_request_items where payment_request_id = p_payment_request_id order by created_at asc, id asc loop
    v_invoice_item_id := gen_random_uuid();
    perform set_config('material_master.procurement_line_resolution', v_invoice_item_id::text, true);
    insert into public.invoice_items(
      id, invoice_id, product_code, product_name, unit, quantity, unit_price, inventory_item_id, notes, raw_product_name,
      suggested_standard_cost_code, confirmed_standard_cost_code, standard_cost_code_type, canonical_cost_item_name, canonical_cost_item_source,
      cost_category_code, cost_product_line, cost_allocation_rule, cost_review_routing, unit_conversion_note, matched_finished_skus, ocr_classification_json,
      canonical_material_id, material_resolution_status, material_resolution_request_id
    ) values (
      v_invoice_item_id, v_invoice_id, pr_item.product_code, pr_item.product_name, coalesce(pr_item.unit, 'kg'), pr_item.quantity, pr_item.unit_price, pr_item.inventory_item_id, pr_item.notes, coalesce(pr_item.raw_product_name, pr_item.product_name),
      pr_item.suggested_standard_cost_code, coalesce(pr_item.confirmed_standard_cost_code, pr_item.suggested_standard_cost_code), pr_item.standard_cost_code_type, pr_item.canonical_cost_item_name, pr_item.canonical_cost_item_source,
      pr_item.cost_category_code, pr_item.cost_product_line, pr_item.cost_allocation_rule, coalesce(pr_item.cost_review_routing, 'none'), pr_item.unit_conversion_note, pr_item.matched_finished_skus, pr_item.ocr_classification_json,
      pr_item.canonical_material_id, pr_item.material_resolution_status, pr_item.material_resolution_request_id
    );
    perform set_config('material_master.procurement_line_resolution', '', true);
    if pr_item.canonical_material_id is not null then v_copied_material_count := v_copied_material_count + 1; end if;
    if pr_item.material_resolution_status is not null and pr_item.material_resolution_status <> 'resolved_exact' then v_pending_count := v_pending_count + 1; end if;
  end loop;

  update public.payment_requests set invoice_id = v_invoice_id, invoice_created = true, updated_at = now() where id = p_payment_request_id;
  return jsonb_build_object('status','created', 'invoice_id', v_invoice_id, 'items_count', v_item_count,
    'copied_material_items_count', v_copied_material_count, 'pending_material_items_count', v_pending_count, 'material_master', v_check);
end;
$$;

revoke execute on function public.create_invoice_from_payment_request(uuid, text, date, numeric, text, text, uuid) from public, anon;
grant execute on function public.create_invoice_from_payment_request(uuid, text, date, numeric, text, text, uuid) to authenticated, service_role;



create or replace function public.create_procurement_line_with_material_resolution(
  p_source_table text,
  p_parent_id uuid,
  p_line jsonb,
  p_source_type text,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_table text := lower(btrim(coalesce(p_source_table, '')));
  v_source_type text := lower(btrim(coalesce(p_source_type, '')));
  v_actor uuid := auth.uid();
  v_parent_supplier uuid;
  v_line_id uuid := gen_random_uuid();
  v_product_name text := nullif(btrim(coalesce(p_line->>'product_name', p_line->>'raw_product_name', '')), '');
  v_unit text := nullif(btrim(coalesce(p_line->>'unit', '')), '');
  v_quantity numeric := coalesce(nullif(p_line->>'quantity','')::numeric, 1);
  v_unit_price numeric := coalesce(nullif(p_line->>'unit_price','')::numeric, 0);
  v_line_total numeric := coalesce(nullif(p_line->>'line_total','')::numeric, v_quantity * v_unit_price);
  v_sku_id uuid := nullif(p_line->>'sku_id','')::uuid;
  v_standard_cost_code_type text := nullif(btrim(coalesce(p_line->>'standard_cost_code_type', '')), '');
  v_notes text := nullif(p_line->>'notes', '');
  v_apply jsonb;
begin
  if coalesce(public.material_master_jwt_role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'authenticated actor required' using errcode = '42501'; end if;
    if p_actor_id is not null and p_actor_id is distinct from v_actor then
      raise exception 'actor spoofing is not allowed' using errcode = '42501';
    end if;
  else
    v_actor := coalesce(p_actor_id, v_actor);
  end if;
  if v_table not in ('purchase_order_items','payment_request_items','invoice_items') then
    raise exception 'unsupported procurement source table' using errcode = '22023';
  end if;
  if (v_table = 'purchase_order_items' and v_source_type <> 'purchase_order')
     or (v_table = 'payment_request_items' and v_source_type <> 'payment_request')
     or (v_table = 'invoice_items' and v_source_type <> 'invoice') then
    raise exception 'source_type must match source table exactly' using errcode = '22023';
  end if;
  if v_product_name is null or v_unit is null or p_parent_id is null then
    raise exception 'parent_id, product_name, and unit required' using errcode = '22023';
  end if;
  if not (
    coalesce(public.material_master_jwt_role(), '') = 'service_role'
    or public.has_role(v_actor, 'owner')
    or (v_table = 'purchase_order_items' and public.has_module_permission(v_actor, 'purchase_orders', 'edit'))
    or (v_table = 'payment_request_items' and public.has_module_permission(v_actor, 'payment_requests', 'edit'))
    or (v_table = 'invoice_items' and public.has_module_permission(v_actor, 'finance_cost', 'edit'))
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if v_table = 'purchase_order_items' then
    select supplier_id into v_parent_supplier from public.purchase_orders where id = p_parent_id for update;
    if not found then raise exception 'purchase order parent not found' using errcode = 'P0002'; end if;
    perform set_config('material_master.procurement_line_resolution', v_line_id::text, true);
    insert into public.purchase_order_items(id, purchase_order_id, product_name, quantity, unit, unit_price, line_total, sku_id, notes)
    values (v_line_id, p_parent_id, v_product_name, v_quantity, v_unit, v_unit_price, v_line_total, v_sku_id, v_notes);
    perform set_config('material_master.procurement_line_resolution', '', true);
  elsif v_table = 'payment_request_items' then
    select supplier_id into v_parent_supplier from public.payment_requests where id = p_parent_id for update;
    if not found then raise exception 'payment request parent not found' using errcode = 'P0002'; end if;
    perform set_config('material_master.procurement_line_resolution', v_line_id::text, true);
    insert into public.payment_request_items(id, payment_request_id, product_name, quantity, unit, unit_price, line_total, sku_id, standard_cost_code_type, notes)
    values (v_line_id, p_parent_id, v_product_name, v_quantity, v_unit, v_unit_price, v_line_total, v_sku_id, v_standard_cost_code_type, v_notes);
    perform set_config('material_master.procurement_line_resolution', '', true);
  else
    select supplier_id into v_parent_supplier from public.invoices where id = p_parent_id for update;
    if not found then raise exception 'invoice parent not found' using errcode = 'P0002'; end if;
    perform set_config('material_master.procurement_line_resolution', v_line_id::text, true);
    insert into public.invoice_items(id, invoice_id, product_name, quantity, unit, unit_price, standard_cost_code_type, notes)
    values (v_line_id, p_parent_id, v_product_name, v_quantity, v_unit, v_unit_price, v_standard_cost_code_type, v_notes);
    perform set_config('material_master.procurement_line_resolution', '', true);
  end if;

  v_apply := public.apply_procurement_line_material_resolution(v_table, v_line_id, v_product_name, nullif(p_line->>'product_code',''), v_unit, v_parent_supplier, v_source_type, 'Task6 server-authority create line material resolution', nullif(p_line->>'expected_material_id','')::uuid);
  if (v_apply->>'source_id')::uuid is distinct from v_line_id or v_apply->>'source_table' <> v_table then
    raise exception 'create line material controller response validation failed' using errcode = '23514';
  end if;
  return jsonb_build_object('status','created','source_table',v_table,'source_type',v_source_type,'parent_id',p_parent_id,'line_id',v_line_id,'request_id',nullif(v_apply->>'request_id','')::uuid,'material_id',nullif(v_apply->>'material_id','')::uuid,'line',v_apply);
end;
$$;

revoke execute on function public.create_procurement_line_with_material_resolution(text, uuid, jsonb, text, uuid) from public, anon;
grant execute on function public.create_procurement_line_with_material_resolution(text, uuid, jsonb, text, uuid) to authenticated, service_role;

create or replace function public.guard_purchase_order_material_status_transition()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_queue_owner name;
  v_status_owner name;
  v_guc text;
begin
  if new.status::text not in ('sent','in_transit','approved') or new.status is not distinct from old.status then
    return new;
  end if;
  select pg_get_userbyid(p.proowner) into v_queue_owner from pg_proc p where p.oid = to_regprocedure('public.ensure_purchase_order_receipt_queue(uuid)');
  select pg_get_userbyid(p.proowner) into v_status_owner from pg_proc p where p.oid = to_regprocedure('public.update_purchase_order_status_with_material_controller(uuid, text, uuid)');
  v_guc := nullif(current_setting('material_master.purchase_order_status_transition', true), '');
  if current_user is distinct from v_queue_owner and current_user is distinct from v_status_owner then
    raise exception 'direct purchase order send/in_transit/approved status update is not allowed' using errcode = '42501';
  end if;
  if v_guc is null or v_guc !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or v_guc::uuid is distinct from new.id then
    raise exception 'direct purchase order send/in_transit/approved status update is not allowed' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_purchase_order_material_status_transition on public.purchase_orders;
create trigger trg_guard_purchase_order_material_status_transition
before update of status on public.purchase_orders
for each row execute function public.guard_purchase_order_material_status_transition();

revoke execute on function public.guard_purchase_order_material_status_transition() from public, anon, authenticated, service_role;

create or replace function public.update_purchase_order_status_with_material_controller(
  p_purchase_order_id uuid,
  p_status text,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_status text := lower(btrim(coalesce(p_status,'')));
  v_check jsonb;
begin
  if coalesce(public.material_master_jwt_role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'authenticated actor required' using errcode = '42501'; end if;
    if p_actor_id is not null and p_actor_id is distinct from v_actor then raise exception 'actor spoofing is not allowed' using errcode = '42501'; end if;
  else
    v_actor := coalesce(p_actor_id, v_actor);
  end if;
  if not (coalesce(public.material_master_jwt_role(), '') = 'service_role' or public.has_role(v_actor, 'owner') or public.has_module_permission(v_actor, 'purchase_orders', 'edit')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  perform 1 from public.purchase_orders where id = p_purchase_order_id for update;
  if not found then raise exception 'purchase order not found' using errcode = 'P0002'; end if;
  if v_status in ('sent','in_transit','approved') then
    v_check := public.assert_procurement_materials_ready(p_purchase_order_id, 'purchase_order', v_actor);
  end if;
  perform set_config('material_master.purchase_order_status_transition', p_purchase_order_id::text, true);
  update public.purchase_orders set status = v_status::purchase_order_status, updated_at = now() where id = p_purchase_order_id;
  perform set_config('material_master.purchase_order_status_transition', '', true);
  return jsonb_build_object('status','updated','purchase_order_id',p_purchase_order_id,'purchase_order_status',v_status,'material_master',v_check);
end;
$$;

revoke execute on function public.update_purchase_order_status_with_material_controller(uuid, text, uuid) from public, anon;
grant execute on function public.update_purchase_order_status_with_material_controller(uuid, text, uuid) to authenticated, service_role;

create or replace function public.guard_payment_request_material_approval()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_owner name;
  v_guc text;
begin
  if new.status::text <> 'approved' or new.status is not distinct from old.status then
    return new;
  end if;
  select pg_get_userbyid(p.proowner) into v_owner from pg_proc p where p.oid = to_regprocedure('public.approve_payment_request_with_material_controller(uuid, text, uuid)');
  v_guc := nullif(current_setting('material_master.payment_request_approval', true), '');
  if current_user is distinct from v_owner or v_guc is null or v_guc !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' or v_guc::uuid is distinct from new.id then
    raise exception 'direct payment request approval is not allowed' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_guard_payment_request_material_approval on public.payment_requests;
create trigger trg_guard_payment_request_material_approval
before update of status, payment_method, approved_by, approved_at on public.payment_requests
for each row execute function public.guard_payment_request_material_approval();

revoke execute on function public.guard_payment_request_material_approval() from public, anon, authenticated, service_role;

create or replace function public.approve_payment_request_with_material_controller(
  p_payment_request_id uuid,
  p_payment_method text,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_pr public.payment_requests%rowtype;
  v_check jsonb;
begin
  if coalesce(public.material_master_jwt_role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'authenticated actor required' using errcode = '42501'; end if;
    if p_actor_id is not null and p_actor_id is distinct from v_actor then raise exception 'actor spoofing is not allowed' using errcode = '42501'; end if;
  else
    v_actor := coalesce(p_actor_id, v_actor);
  end if;
  if not (coalesce(public.material_master_jwt_role(), '') = 'service_role' or public.has_role(v_actor, 'owner') or public.has_module_permission(v_actor, 'payment_requests', 'edit')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  select * into v_pr from public.payment_requests where id = p_payment_request_id for update;
  if not found then raise exception 'payment request not found' using errcode = 'P0002'; end if;
  -- Assert readiness before approved status or any SKU/inventory/cost mutation. Unknown/raw unresolved never reaches legacy SKU creation in enforced mode.
  v_check := public.assert_procurement_materials_ready(p_payment_request_id, 'payment_request', v_actor);
  perform set_config('material_master.payment_request_approval', p_payment_request_id::text, true);
  update public.payment_requests
  set status = 'approved'::payment_request_status,
      payment_method = coalesce(nullif(p_payment_method,''), payment_method::text)::payment_method_type,
      approved_by = v_actor,
      approved_at = now(),
      updated_at = now()
  where id = p_payment_request_id;
  perform set_config('material_master.payment_request_approval', '', true);
  return jsonb_build_object('status','approved','payment_request_id',p_payment_request_id,'material_master',v_check);
end;
$$;

revoke execute on function public.approve_payment_request_with_material_controller(uuid, text, uuid) from public, anon;
grant execute on function public.approve_payment_request_with_material_controller(uuid, text, uuid) to authenticated, service_role;

create or replace function public.create_invoice_with_material_controller(
  p_parent jsonb,
  p_items jsonb,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_invoice_id uuid := gen_random_uuid();
  v_supplier_id uuid := nullif(p_parent->>'supplier_id','')::uuid;
  v_invoice_number text := nullif(btrim(coalesce(p_parent->>'invoice_number','')), '');
  v_invoice_date date := coalesce(nullif(p_parent->>'invoice_date','')::date, current_date);
  v_subtotal numeric := coalesce(nullif(p_parent->>'subtotal','')::numeric, 0);
  v_vat numeric := coalesce(nullif(p_parent->>'vat_amount','')::numeric, 0);
  v_total numeric := coalesce(nullif(p_parent->>'total_amount','')::numeric, v_subtotal + v_vat);
  v_item jsonb;
  v_line jsonb;
  v_check jsonb;
  v_count integer := 0;
begin
  if coalesce(public.material_master_jwt_role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'authenticated actor required' using errcode = '42501'; end if;
    if p_actor_id is not null and p_actor_id is distinct from v_actor then raise exception 'actor spoofing is not allowed' using errcode = '42501'; end if;
  else
    v_actor := coalesce(p_actor_id, v_actor);
  end if;
  if not (coalesce(public.material_master_jwt_role(), '') = 'service_role' or public.has_role(v_actor, 'owner') or public.has_module_permission(v_actor, 'finance_cost', 'edit')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if v_supplier_id is null or v_invoice_number is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'supplier_id, invoice_number, and items are required' using errcode = '22023';
  end if;
  perform 1 from public.suppliers where id = v_supplier_id for update;
  if not found then raise exception 'supplier not found' using errcode = 'P0002'; end if;
  insert into public.invoices(id, invoice_number, invoice_date, supplier_id, subtotal, vat_amount, total_amount, notes, image_url, payment_slip_url, payment_request_id, purchase_order_id, goods_receipt_id, created_by)
  values (v_invoice_id, v_invoice_number, v_invoice_date, v_supplier_id, v_subtotal, v_vat, v_total, nullif(p_parent->>'notes',''), nullif(p_parent->>'image_url',''), nullif(p_parent->>'payment_slip_url',''), nullif(p_parent->>'payment_request_id','')::uuid, nullif(p_parent->>'purchase_order_id','')::uuid, nullif(p_parent->>'goods_receipt_id','')::uuid, v_actor);

  for v_item in select value from jsonb_array_elements(p_items) loop
    v_line := public.create_procurement_line_with_material_resolution('invoice_items', v_invoice_id, v_item, 'invoice', v_actor);
    v_count := v_count + 1;
  end loop;
  v_check := public.assert_procurement_materials_ready(v_invoice_id, 'invoice', v_actor);
  return jsonb_build_object('status','created','invoice_id',v_invoice_id,'items_count',v_count,'material_master',v_check);
end;
$$;

revoke execute on function public.create_invoice_with_material_controller(jsonb, jsonb, uuid) from public, anon;
grant execute on function public.create_invoice_with_material_controller(jsonb, jsonb, uuid) to authenticated, service_role;



create or replace function public.procurement_line_has_material_evidence(p_line jsonb)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select nullif(p_line->>'canonical_material_id','') is not null
      or nullif(p_line->>'material_resolution_request_id','') is not null
      or nullif(p_line->>'material_resolution_status','') is not null
      or nullif(p_line->>'raw_product_name','') is not null;
$$;

revoke execute on function public.procurement_line_has_material_evidence(jsonb) from public, anon, authenticated, service_role;

-- Task6 source identity drift guards are created dynamically as: before update of product_name, product_code, unit, sku_id, inventory_item_id; before delete on public.purchase_order_items; before delete on public.payment_request_items; before delete on public.invoice_items
create or replace function public.guard_procurement_source_identity_history_mutation()
returns trigger
language plpgsql
security invoker
set search_path = public, pg_temp
as $$
declare
  v_old jsonb := to_jsonb(old);
  v_new jsonb := case when tg_op = 'UPDATE' then to_jsonb(new) else null end;
  v_has_evidence boolean := public.procurement_line_has_material_evidence(v_old);
  v_owner name;
  v_guc text;
  v_identity_cols text[] := array['product_name','product_code','unit','sku_id','inventory_item_id'];
  v_col text;
begin
  if not v_has_evidence then
    return case when tg_op = 'DELETE' then old else new end;
  end if;

  select pg_get_userbyid(p.proowner) into v_owner
  from pg_proc p
  where p.oid = to_regprocedure('public.update_procurement_document_with_material_controller(text, uuid, jsonb, jsonb, uuid)');
  v_guc := nullif(current_setting('material_master.procurement_document_edit_line', true), '');

  if tg_op = 'DELETE' then
    -- Evidence-bearing procurement and invoice history is append-only to browsers and wrappers.
    raise exception 'procurement source line with material evidence cannot be deleted' using errcode = '23514';
  end if;

  foreach v_col in array v_identity_cols loop
    if (v_old ? v_col or v_new ? v_col) and (v_old->>v_col) is distinct from (v_new->>v_col) then
      raise exception 'procurement source identity is immutable once material evidence exists' using errcode = '23514';
    end if;
  end loop;

  return new;
end;
$$;

revoke execute on function public.guard_procurement_source_identity_history_mutation() from public, anon, authenticated, service_role;

do $$
declare
  v_table text;
  v_cols text;
begin
  foreach v_table in array array['purchase_order_items','payment_request_items','invoice_items'] loop
    select string_agg(quote_ident(column_name), ', ' order by array_position(array['product_name','product_code','unit','sku_id','inventory_item_id'], column_name))
      into v_cols
    from information_schema.columns
    where table_schema = 'public'
      and table_name = v_table
      and column_name = any(array['product_name','product_code','unit','sku_id','inventory_item_id']);
    if v_cols is not null then
      execute format('drop trigger if exists trg_guard_%s_source_identity_history_update on public.%I', v_table, v_table);
      execute format('create trigger trg_guard_%s_source_identity_history_update before update of %s on public.%I for each row execute function public.guard_procurement_source_identity_history_mutation()', v_table, v_cols, v_table);
    end if;
    execute format('drop trigger if exists trg_guard_%s_source_identity_history_delete on public.%I', v_table, v_table);
    execute format('create trigger trg_guard_%s_source_identity_history_delete before delete on public.%I for each row execute function public.guard_procurement_source_identity_history_mutation()', v_table, v_table);
  end loop;
end $$;

create or replace function public.update_procurement_document_with_material_controller(
  p_source_type text,
  p_parent_id uuid,
  p_parent_patch jsonb,
  p_lines jsonb,
  p_actor_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source_type text := lower(btrim(coalesce(p_source_type, '')));
  v_actor uuid := auth.uid();
  v_parent jsonb;
  v_parent_supplier uuid;
  v_status text;
  v_line jsonb;
  v_line_id uuid;
  v_existing jsonb;
  v_seen_ids uuid[] := array[]::uuid[];
  v_table text;
  v_parent_fk text;
  v_item_count integer := 0;
  v_updated_count integer := 0;
  v_created_count integer := 0;
  v_deleted_count integer := 0;
  v_evidence_count integer := 0;
  v_result jsonb;
  v_qty numeric;
  v_unit_price numeric;
  v_line_total numeric;
  v_notes text;
  v_product_name text;
  v_product_code text;
  v_unit text;
  v_sku_id uuid;
  v_inventory_item_id uuid;
begin
  if coalesce(public.material_master_jwt_role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'authenticated actor required' using errcode = '42501'; end if;
    if p_actor_id is not null and p_actor_id is distinct from v_actor then raise exception 'actor spoofing is not allowed' using errcode = '42501'; end if;
  else
    v_actor := coalesce(p_actor_id, v_actor);
  end if;
  if p_parent_id is null or jsonb_typeof(coalesce(p_lines, 'null'::jsonb)) <> 'array' then
    raise exception 'parent_id and array lines are required' using errcode = '22023';
  end if;

  if v_source_type = 'purchase_order' then
    v_table := 'purchase_order_items'; v_parent_fk := 'purchase_order_id';
    if not (coalesce(public.material_master_jwt_role(), '') = 'service_role' or public.has_role(v_actor, 'owner') or public.has_module_permission(v_actor, 'purchase_orders', 'edit')) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
    select to_jsonb(po), po.supplier_id, po.status::text into v_parent, v_parent_supplier, v_status
    from public.purchase_orders po where po.id = p_parent_id for update;
    if not found then raise exception 'purchase order not found' using errcode = 'P0002'; end if;
    if v_status <> 'draft' then raise exception 'procurement document can only be edited while draft/pending' using errcode = '23514'; end if;
    perform 1 from public.purchase_order_items where purchase_order_id = p_parent_id order by id for update;
    if (p_parent_patch ? 'supplier_id') and nullif(p_parent_patch->>'supplier_id','')::uuid is distinct from v_parent_supplier and exists (
      select 1 from public.purchase_order_items where purchase_order_id = p_parent_id and public.procurement_line_has_material_evidence(to_jsonb(purchase_order_items))
    ) then
      raise exception 'procurement parent supplier cannot change once material evidence exists' using errcode = '23514';
    end if;
    update public.purchase_orders set
      supplier_id = case when p_parent_patch ? 'supplier_id' then nullif(p_parent_patch->>'supplier_id','')::uuid else supplier_id end,
      order_date = case when p_parent_patch ? 'order_date' then nullif(p_parent_patch->>'order_date','')::date else order_date end,
      expected_date = case when p_parent_patch ? 'expected_date' then nullif(p_parent_patch->>'expected_date','')::date else expected_date end,
      vat_amount = case when p_parent_patch ? 'vat_amount' then coalesce(nullif(p_parent_patch->>'vat_amount','')::numeric,0) else vat_amount end,
      total_amount = case when p_parent_patch ? 'total_amount' then coalesce(nullif(p_parent_patch->>'total_amount','')::numeric,0) else total_amount end,
      notes = case when p_parent_patch ? 'notes' then nullif(p_parent_patch->>'notes','') else notes end,
      updated_at = now()
    where id = p_parent_id;
  elsif v_source_type = 'payment_request' then
    v_table := 'payment_request_items'; v_parent_fk := 'payment_request_id';
    if not (coalesce(public.material_master_jwt_role(), '') = 'service_role' or public.has_role(v_actor, 'owner') or public.has_module_permission(v_actor, 'payment_requests', 'edit')) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
    select to_jsonb(pr), pr.supplier_id, pr.status::text into v_parent, v_parent_supplier, v_status
    from public.payment_requests pr where pr.id = p_parent_id for update;
    if not found then raise exception 'payment request not found' using errcode = 'P0002'; end if;
    if v_status <> 'pending' then raise exception 'procurement document can only be edited while draft/pending' using errcode = '23514'; end if;
    perform 1 from public.payment_request_items where payment_request_id = p_parent_id order by id for update;
    if (p_parent_patch ? 'supplier_id') and nullif(p_parent_patch->>'supplier_id','')::uuid is distinct from v_parent_supplier and exists (
      select 1 from public.payment_request_items where payment_request_id = p_parent_id and public.procurement_line_has_material_evidence(to_jsonb(payment_request_items))
    ) then
      raise exception 'procurement parent supplier cannot change once material evidence exists' using errcode = '23514';
    end if;
    update public.payment_requests set
      title = case when p_parent_patch ? 'title' then coalesce(nullif(p_parent_patch->>'title',''), title) else title end,
      description = case when p_parent_patch ? 'description' then nullif(p_parent_patch->>'description','') else description end,
      supplier_id = case when p_parent_patch ? 'supplier_id' then nullif(p_parent_patch->>'supplier_id','')::uuid else supplier_id end,
      goods_receipt_id = case when p_parent_patch ? 'goods_receipt_id' then nullif(p_parent_patch->>'goods_receipt_id','')::uuid else goods_receipt_id end,
      payment_type = case when p_parent_patch ? 'payment_type' then (p_parent_patch->>'payment_type')::payment_type else payment_type end,
      payment_method = case when p_parent_patch ? 'payment_method' then (p_parent_patch->>'payment_method')::payment_method_type else payment_method end,
      vat_amount = case when p_parent_patch ? 'vat_amount' then coalesce(nullif(p_parent_patch->>'vat_amount','')::numeric,0) else vat_amount end,
      total_amount = case when p_parent_patch ? 'total_amount' then coalesce(nullif(p_parent_patch->>'total_amount','')::numeric,0) else total_amount end,
      notes = case when p_parent_patch ? 'notes' then nullif(p_parent_patch->>'notes','') else notes end,
      updated_at = now()
    where id = p_parent_id;
  elsif v_source_type = 'invoice' then
    v_table := 'invoice_items'; v_parent_fk := 'invoice_id';
    if not (coalesce(public.material_master_jwt_role(), '') = 'service_role' or public.has_role(v_actor, 'owner') or public.has_module_permission(v_actor, 'finance_cost', 'edit')) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
    select to_jsonb(inv), inv.supplier_id, 'draft' into v_parent, v_parent_supplier, v_status
    from public.invoices inv where inv.id = p_parent_id for update;
    if not found then raise exception 'invoice not found' using errcode = 'P0002'; end if;
    perform 1 from public.invoice_items where invoice_id = p_parent_id order by id for update;
    if (p_parent_patch ? 'supplier_id') and nullif(p_parent_patch->>'supplier_id','')::uuid is distinct from v_parent_supplier and exists (
      select 1 from public.invoice_items where invoice_id = p_parent_id and public.procurement_line_has_material_evidence(to_jsonb(invoice_items))
    ) then
      raise exception 'procurement parent supplier cannot change once material evidence exists' using errcode = '23514';
    end if;
    update public.invoices set
      notes = case when p_parent_patch ? 'notes' then nullif(p_parent_patch->>'notes','') else notes end,
      vat_amount = case when p_parent_patch ? 'vat_amount' then coalesce(nullif(p_parent_patch->>'vat_amount','')::numeric,0) else vat_amount end,
      total_amount = case when p_parent_patch ? 'total_amount' then coalesce(nullif(p_parent_patch->>'total_amount','')::numeric,total_amount) else total_amount end,
      updated_at = now()
    where id = p_parent_id;
  else
    raise exception 'unsupported procurement source_type' using errcode = '22023';
  end if;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_item_count := v_item_count + 1;
    v_line_id := nullif(v_line->>'id','')::uuid;
    if v_line_id is null then
      v_result := public.create_procurement_line_with_material_resolution(v_table, p_parent_id, v_line, v_source_type, v_actor);
      v_line_id := nullif(v_result->>'line_id','')::uuid;
      if v_line_id is null then
        raise exception 'procurement line create response missing line_id' using errcode = 'P0001';
      end if;
      v_seen_ids := array_append(v_seen_ids, v_line_id);
      v_created_count := v_created_count + 1;
    else
      v_seen_ids := array_append(v_seen_ids, v_line_id);
      execute format('select to_jsonb(t) from public.%I t where t.id = $1 and t.%I = $2 for update', v_table, v_parent_fk)
      into v_existing using v_line_id, p_parent_id;
      if v_existing is null then raise exception 'procurement source line not found' using errcode = 'P0002'; end if;
      if public.procurement_line_has_material_evidence(v_existing) then
        v_evidence_count := v_evidence_count + 1;
        foreach v_product_name in array array['product_name','product_code','unit','sku_id','inventory_item_id'] loop
          if v_line ? v_product_name and (v_line->>v_product_name) is distinct from (v_existing->>v_product_name) then
            raise exception 'procurement source identity is immutable once material evidence exists' using errcode = '23514';
          end if;
        end loop;
      end if;
      v_qty := coalesce(nullif(v_line->>'quantity','')::numeric, nullif(v_existing->>'quantity','')::numeric, 0);
      v_unit_price := coalesce(nullif(v_line->>'unit_price','')::numeric, nullif(v_existing->>'unit_price','')::numeric, 0);
      v_line_total := coalesce(nullif(v_line->>'line_total','')::numeric, v_qty * v_unit_price);
      v_notes := case when v_line ? 'notes' then nullif(v_line->>'notes','') else v_existing->>'notes' end;
      v_product_name := coalesce(nullif(v_line->>'product_name',''), v_existing->>'product_name');
      v_product_code := case when v_line ? 'product_code' then nullif(v_line->>'product_code','') else v_existing->>'product_code' end;
      v_unit := coalesce(nullif(v_line->>'unit',''), v_existing->>'unit');
      v_sku_id := coalesce(nullif(v_line->>'sku_id','')::uuid, nullif(v_existing->>'sku_id','')::uuid);
      v_inventory_item_id := coalesce(nullif(v_line->>'inventory_item_id','')::uuid, nullif(v_existing->>'inventory_item_id','')::uuid);
      perform set_config('material_master.procurement_document_edit_line', v_line_id::text, true);
      if v_source_type = 'purchase_order' then
        update public.purchase_order_items set product_name = v_product_name, quantity = v_qty, unit = v_unit, unit_price = v_unit_price, line_total = v_line_total, sku_id = v_sku_id, notes = v_notes where id = v_line_id;
      elsif v_source_type = 'payment_request' then
        update public.payment_request_items set product_code = v_product_code, product_name = v_product_name, quantity = v_qty, unit = v_unit, unit_price = v_unit_price, line_total = v_line_total, sku_id = v_sku_id, inventory_item_id = v_inventory_item_id, notes = v_notes where id = v_line_id;
      else
        update public.invoice_items set product_code = v_product_code, product_name = v_product_name, quantity = v_qty, unit = v_unit, unit_price = v_unit_price, line_total = v_line_total, inventory_item_id = v_inventory_item_id, notes = v_notes where id = v_line_id;
      end if;
      perform set_config('material_master.procurement_document_edit_line', '', true);
      v_updated_count := v_updated_count + 1;
    end if;
  end loop;

  if v_source_type = 'purchase_order' then
    for v_existing in select to_jsonb(t) from public.purchase_order_items t where t.purchase_order_id = p_parent_id and not (t.id = any(v_seen_ids)) loop
      if public.procurement_line_has_material_evidence(v_existing) then
        raise exception 'procurement source line with material evidence cannot be deleted' using errcode = '23514';
      end if;
      perform set_config('material_master.procurement_document_edit_line', (v_existing->>'id'), true);
      delete from public.purchase_order_items where id = (v_existing->>'id')::uuid;
      perform set_config('material_master.procurement_document_edit_line', '', true);
      v_deleted_count := v_deleted_count + 1;
    end loop;
  elsif v_source_type = 'payment_request' then
    for v_existing in select to_jsonb(t) from public.payment_request_items t where t.payment_request_id = p_parent_id and not (t.id = any(v_seen_ids)) loop
      if public.procurement_line_has_material_evidence(v_existing) then
        raise exception 'procurement source line with material evidence cannot be deleted' using errcode = '23514';
      end if;
      perform set_config('material_master.procurement_document_edit_line', (v_existing->>'id'), true);
      delete from public.payment_request_items where id = (v_existing->>'id')::uuid;
      perform set_config('material_master.procurement_document_edit_line', '', true);
      v_deleted_count := v_deleted_count + 1;
    end loop;
  elsif v_source_type = 'invoice' then
    if exists (select 1 from public.invoice_items t where t.invoice_id = p_parent_id and not (t.id = any(v_seen_ids))) then
      raise exception 'invoice item history cannot be deleted through procurement edit' using errcode = '23514';
    end if;
  end if;

  return jsonb_build_object(
    'status','updated',
    'source_type',v_source_type,
    'parent_id',p_parent_id,
    'parent_status',v_status,
    'items_count',v_item_count,
    'updated_items_count',v_updated_count,
    'created_items_count',v_created_count,
    'deleted_items_count',v_deleted_count,
    'evidence_items_count',v_evidence_count
  );
end;
$$;

revoke execute on function public.update_procurement_document_with_material_controller(text, uuid, jsonb, jsonb, uuid) from public, anon;
grant execute on function public.update_procurement_document_with_material_controller(text, uuid, jsonb, jsonb, uuid) to authenticated, service_role;
comment on function public.update_procurement_document_with_material_controller(text, uuid, jsonb, jsonb, uuid) is 'Task6 atomic edit wrapper: parent patch + stable existing line IDs; blocks canonical/source identity drift and evidence-bearing deletion; new lines route through material controller.';

-- Readiness is callable only through owner/service-role server authority wrappers; browser users cannot inspect arbitrary module sources directly.
revoke execute on function public.assert_procurement_materials_ready(uuid, text, uuid) from authenticated;
grant execute on function public.assert_procurement_materials_ready(uuid, text, uuid) to service_role;
comment on function public.apply_procurement_line_material_resolution(text, uuid, text, text, text, uuid, text, text, uuid) is 'Task6 narrow RPC: only path allowed to write protected canonical_material_id/raw_product_name/material_resolution_status/material_resolution_request_id on PO/PR/invoice lines.';
comment on function public.create_invoice_from_payment_request(uuid, text, date, numeric, text, text, uuid) is 'Task6 atomic PR->invoice copy; carries canonical/raw/status/request and checks enforced blockers before side effects.';
comment on function public.create_procurement_line_with_material_resolution(text, uuid, jsonb, text, uuid) is 'Task6 server-authority line insertion wrapper: whitelisted JSON only, strips protected fields, then applies material controller in the same transaction.';
comment on function public.approve_payment_request_with_material_controller(uuid, text, uuid) is 'Task6 server-authority payment request approval wrapper: locks parent and checks material readiness before approved status or SKU/inventory side effects.';
comment on function public.update_purchase_order_status_with_material_controller(uuid, text, uuid) is 'Task6 server-authority PO status wrapper: send/in_transit/approved status changes require readiness and row-scoped GUC.';
comment on function public.create_invoice_with_material_controller(jsonb, jsonb, uuid) is 'Task6 server-authority manual invoice batch wrapper: whitelisted parent/items, material controller apply, no OCR inventory or standard-cost mutation.';
