-- Supplier delivery-note scan evidence is suggestion-only.
-- It records OCR/source facts append-only, extends material supplier suggestions,
-- and lets authorized users explicitly confirm package/base-unit semantics without
-- mutating finance, payable, invoice, or goods-receipt item rows.

create table public.material_supplier_unit_scan_evidence (
  id uuid primary key default gen_random_uuid(),
  goods_receipt_id uuid not null references public.goods_receipts(id) on delete restrict,
  goods_receipt_item_id uuid not null references public.goods_receipt_items(id) on delete restrict,
  supplier_id uuid not null references public.suppliers(id) on delete restrict,
  document_path text not null,
  document_checksum text not null,
  raw_product_name text not null,
  raw_purchase_unit text not null,
  raw_quantity numeric not null,
  package_quantity numeric,
  package_unit text,
  source_reference text not null,
  evidence_fingerprint text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_by uuid not null references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint material_supplier_unit_scan_evidence_document_path_nonempty check (nullif(btrim(document_path), '') is not null),
  constraint material_supplier_unit_scan_evidence_checksum_sha256 check (document_checksum ~ '^[0-9a-f]{64}$'),
  constraint material_supplier_unit_scan_evidence_raw_name_unit_nonempty check (nullif(btrim(raw_product_name), '') is not null and nullif(btrim(raw_purchase_unit), '') is not null),
  constraint material_supplier_unit_scan_evidence_quantities_finite_positive check (
    raw_quantity > 0 and raw_quantity::text not in ('NaN','Infinity','-Infinity')
    and (package_quantity is null or (package_quantity > 0 and package_quantity::text not in ('NaN','Infinity','-Infinity')))
  ),
  unique (evidence_fingerprint)
);

create index if not exists idx_material_supplier_unit_scan_evidence_item
  on public.material_supplier_unit_scan_evidence(goods_receipt_item_id, created_at desc);
create index if not exists idx_material_supplier_unit_scan_evidence_supplier_name_unit
  on public.material_supplier_unit_scan_evidence(
    supplier_id,
    public.material_master_normalize(raw_product_name),
    lower(btrim(raw_purchase_unit)),
    created_at desc
  );

alter table public.material_supplier_unit_scan_evidence enable row level security;
alter table public.material_supplier_unit_scan_evidence force row level security;
revoke all on public.material_supplier_unit_scan_evidence from public, anon, authenticated;
grant all on public.material_supplier_unit_scan_evidence to service_role;

create or replace function public.trg_material_supplier_unit_scan_evidence_append_only()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  raise exception 'direct scan evidence update/delete is not allowed' using errcode = '42501';
end;
$$;

drop trigger if exists trg_material_supplier_unit_scan_evidence_append_only on public.material_supplier_unit_scan_evidence;
create trigger trg_material_supplier_unit_scan_evidence_append_only
before update or delete on public.material_supplier_unit_scan_evidence
for each row execute function public.trg_material_supplier_unit_scan_evidence_append_only();

create or replace function public.record_material_supplier_unit_scan_evidence(
  p_receipt_id uuid,
  p_document_path text,
  p_document_checksum text,
  p_actor_id uuid,
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_receipt public.goods_receipts%rowtype;
  v_item public.goods_receipt_items%rowtype;
  v_item_id uuid;
  v_document_path text := nullif(btrim(coalesce(p_document_path, '')), '');
  v_document_checksum text := lower(nullif(btrim(coalesce(p_document_checksum, '')), ''));
  v_actor uuid := p_actor_id;
  v_line jsonb;
  v_raw_name text;
  v_raw_unit text;
  v_raw_quantity numeric;
  v_package_quantity numeric;
  v_package_unit text;
  v_source_reference text;
  v_fingerprint text;
  v_inserted public.material_supplier_unit_scan_evidence%rowtype;
  v_ids uuid[] := array[]::uuid[];
begin
  if coalesce(public.material_master_jwt_role(), '') <> 'service_role' then
    raise exception 'service_role required' using errcode = '42501';
  end if;
  if p_receipt_id is null or v_document_path is null or v_document_checksum is null or v_actor is null then
    raise exception 'receipt, document path, checksum and actor are required' using errcode = '22023';
  end if;
  if v_document_checksum !~ '^[0-9a-f]{64}$' then
    raise exception 'document checksum must be lowercase sha256 hex' using errcode = '22023';
  end if;
  if not exists (select 1 from auth.users u where u.id = v_actor) then
    raise exception 'actor not found' using errcode = 'P0002';
  end if;

  select * into v_receipt
  from public.goods_receipts
  where id = p_receipt_id;
  if not found then raise exception 'goods receipt not found' using errcode = 'P0002'; end if;
  if v_receipt.supplier_id is null then
    raise exception 'goods receipt supplier is required for supplier scan evidence' using errcode = '23514';
  end if;
  if nullif(btrim(coalesce(v_receipt.image_url, '')), '') is distinct from v_document_path then
    raise exception 'document path does not match goods receipt' using errcode = '23514';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'scan evidence lines are required' using errcode = '22023';
  end if;

  for v_line in select value from jsonb_array_elements(p_lines) as line(value)
  loop
    begin
      v_item_id := nullif(v_line->>'goods_receipt_item_id', '')::uuid;
    exception when invalid_text_representation then
      raise exception 'goods receipt item id must be a uuid' using errcode = '22023';
    end;
    if v_item_id is null then
      raise exception 'goods receipt item id is required for each scan line' using errcode = '22023';
    end if;
    select * into v_item
    from public.goods_receipt_items
    where id = v_item_id;
    if not found then raise exception 'goods receipt item not found' using errcode = 'P0002'; end if;
    if v_item.goods_receipt_id is distinct from p_receipt_id then
      raise exception 'goods receipt item does not belong to receipt' using errcode = '23514';
    end if;

    v_raw_name := nullif(btrim(coalesce(v_line->>'raw_product_name', v_line->>'product_name', v_item.product_name, '')), '');
    v_raw_unit := nullif(btrim(coalesce(v_line->>'raw_purchase_unit', v_line->>'purchase_unit', v_line->>'unit', v_item.unit, '')), '');
    begin
      v_raw_quantity := nullif(v_line->>'raw_quantity', '')::numeric;
    exception when invalid_text_representation then
      raise exception 'raw quantity must be numeric' using errcode = '22023';
    end;
    if v_raw_quantity is null then
      begin
        v_raw_quantity := nullif(v_line->>'quantity', '')::numeric;
      exception when invalid_text_representation then
        raise exception 'raw quantity must be numeric' using errcode = '22023';
      end;
    end if;
    begin
      v_package_quantity := nullif(v_line->>'package_quantity', '')::numeric;
    exception when invalid_text_representation then
      raise exception 'package quantity must be numeric' using errcode = '22023';
    end;
    v_package_unit := nullif(btrim(coalesce(v_line->>'package_unit', '')), '');
    v_source_reference := coalesce(v_receipt.receipt_number, 'Phiếu nhập')
      || case when v_receipt.receipt_date is not null then ' · ' || to_char(v_receipt.receipt_date, 'DD/MM/YYYY') else '' end;

    if v_raw_name is null or v_raw_unit is null or v_raw_quantity is null or v_raw_quantity <= 0 or v_raw_quantity::text in ('NaN','Infinity','-Infinity') then
      raise exception 'raw scan product name, unit and positive quantity are required' using errcode = '22023';
    end if;
    if v_package_quantity is not null and (v_package_quantity <= 0 or v_package_quantity::text in ('NaN','Infinity','-Infinity')) then
      raise exception 'package quantity must be positive' using errcode = '22023';
    end if;

    v_fingerprint := md5(concat_ws('|',
      p_receipt_id::text,
      v_item_id::text,
      v_receipt.supplier_id::text,
      v_document_checksum,
      public.material_master_normalize(v_raw_name),
      lower(btrim(v_raw_unit)),
      v_raw_quantity::text,
      coalesce(v_package_quantity::text, ''),
      lower(btrim(coalesce(v_package_unit, ''))),
      v_source_reference
    ));

    v_inserted := null;
    insert into public.material_supplier_unit_scan_evidence (
      goods_receipt_id, goods_receipt_item_id, supplier_id, document_path, document_checksum,
      raw_product_name, raw_purchase_unit, raw_quantity,
      package_quantity, package_unit, source_reference, evidence_fingerprint,
      metadata, created_by
    ) values (
      p_receipt_id, v_item_id, v_receipt.supplier_id, v_document_path, v_document_checksum,
      v_raw_name, v_raw_unit, v_raw_quantity,
      v_package_quantity, v_package_unit, v_source_reference, v_fingerprint,
      jsonb_build_object('source', 'supplier_delivery_note_scan', 'line', v_line), v_actor
    )
    on conflict (evidence_fingerprint) do nothing
    returning * into v_inserted;

    if v_inserted.id is null then
      select * into v_inserted
      from public.material_supplier_unit_scan_evidence
      where evidence_fingerprint = v_fingerprint;
    end if;

    v_ids := array_append(v_ids, v_inserted.id);
  end loop;

  return jsonb_build_object('status', 'scan_evidence_recorded', 'evidence_ids', to_jsonb(v_ids));
end;
$$;

revoke all on function public.record_material_supplier_unit_scan_evidence(uuid, text, text, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.record_material_supplier_unit_scan_evidence(uuid, text, text, uuid, jsonb) to service_role;

drop function public.get_material_supplier_suggestions(uuid);

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
  payment_candidate_count bigint,
  scan_evidence_id uuid,
  source_reference text,
  package_quantity numeric,
  package_unit text,
  suggested_base_quantity numeric,
  suggested_base_unit text
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
      true as confirmed,
      null::uuid as scan_evidence_id,
      null::text as source_reference,
      msp.package_quantity,
      msp.package_unit,
      case when coalesce((msp.metadata->>'conversion_pending')::boolean, false) then null::numeric else msp.base_quantity end as suggested_base_quantity,
      m.default_unit as suggested_base_unit
    from material m
    join public.material_supplier_products msp on msp.material_id = m.id
      and msp.active = true and msp.approved = true

    union all

    select
      se.supplier_id,
      null::uuid as product_sku_id,
      null::uuid as supplier_product_id,
      se.raw_product_name,
      null::text as product_code,
      se.raw_purchase_unit,
      'supplier_delivery_note_scan'::text,
      count(*) over (partition by se.supplier_id, public.material_master_normalize(se.raw_product_name), lower(btrim(se.raw_purchase_unit)))::bigint,
      se.created_at,
      false,
      se.id,
      se.source_reference,
      se.package_quantity,
      se.package_unit,
      case
        when lower(btrim(se.raw_purchase_unit)) = lower(btrim(m.default_unit)) then 1::numeric
        when lower(btrim(se.raw_purchase_unit)) = 'kg' and lower(btrim(m.default_unit)) = 'g' then 1000::numeric
        when lower(btrim(se.raw_purchase_unit)) = 'g' and lower(btrim(m.default_unit)) = 'kg' then 0.001::numeric
        when lower(btrim(se.raw_purchase_unit)) in ('l', 'lit', 'lít') and lower(btrim(m.default_unit)) = 'ml' then 1000::numeric
        when lower(btrim(se.raw_purchase_unit)) = 'ml' and lower(btrim(m.default_unit)) in ('l', 'lit', 'lít') then 0.001::numeric
        when lower(btrim(coalesce(se.package_unit, ''))) = lower(btrim(m.default_unit)) then se.package_quantity
        when lower(btrim(coalesce(se.package_unit, ''))) = 'kg' and lower(btrim(m.default_unit)) = 'g' then se.package_quantity * 1000
        when lower(btrim(coalesce(se.package_unit, ''))) = 'g' and lower(btrim(m.default_unit)) = 'kg' then se.package_quantity / 1000
        when lower(btrim(coalesce(se.package_unit, ''))) in ('l', 'lit', 'lít') and lower(btrim(m.default_unit)) = 'ml' then se.package_quantity * 1000
        when lower(btrim(coalesce(se.package_unit, ''))) = 'ml' and lower(btrim(m.default_unit)) in ('l', 'lit', 'lít') then se.package_quantity / 1000
        else null::numeric
      end,
      m.default_unit
    from material m
    join public.goods_receipt_items gri on gri.canonical_material_id = m.id
    join public.material_supplier_unit_scan_evidence se on se.goods_receipt_item_id = gri.id
    join public.goods_receipts gr on gr.id = se.goods_receipt_id
      and gr.id = gri.goods_receipt_id
      and gr.supplier_id = se.supplier_id
    join public.sku_cogs_materials cogs_scan on cogs_scan.id = gri.canonical_material_id and cogs_scan.id = m.id and cogs_scan.active = true

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
      false,
      null::uuid,
      null::text,
      null::numeric,
      null::text,
      case when lower(btrim(coalesce(ps.unit, m.default_unit))) = lower(btrim(m.default_unit)) then 1::numeric else null::numeric end,
      m.default_unit
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
      false,
      null::uuid,
      null::text,
      null::numeric,
      null::text,
      case when lower(btrim(coalesce(pri.unit, m.default_unit))) = lower(btrim(m.default_unit)) then 1::numeric else null::numeric end,
      m.default_unit
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

    union all

    -- Suggestion-only fallback: deterministic normalized-name containment.
    -- It deliberately returns no product_sku_id, so nothing is linked until
    -- an authorized user explicitly confirms the supplier/name/unit identity.
    select
      pr.supplier_id,
      null::uuid as product_sku_id,
      null::uuid as supplier_product_id,
      pri.product_name,
      pri.product_code,
      coalesce(nullif(btrim(pri.unit), ''), m.default_unit),
      'payment_history_name_contains'::text,
      count(*)::bigint,
      max(pr.created_at),
      false,
      null::uuid,
      null::text,
      null::numeric,
      null::text,
      case when lower(btrim(coalesce(pri.unit, m.default_unit))) = lower(btrim(m.default_unit)) then 1::numeric else null::numeric end,
      m.default_unit
    from material m
    join public.payment_request_items pri on (
      public.material_master_normalize(pri.product_name) = m.normalized_name
      or public.material_master_normalize(pri.product_name) like m.normalized_name || ' %'
      or m.normalized_name like public.material_master_normalize(pri.product_name) || ' %'
    )
    join public.payment_requests pr on pr.id = pri.payment_request_id
      and pr.supplier_id is not null
    where nullif(m.normalized_name, '') is not null
      and nullif(public.material_master_normalize(pri.product_name), '') is not null
    group by m.id, m.default_unit, pr.supplier_id,
      pri.product_name, pri.product_code, pri.unit

  ), ranked as (
    select e.*,
      row_number() over (
        partition by e.supplier_id,
          public.material_master_normalize(e.product_name), lower(btrim(e.purchase_unit))
        order by e.confirmed desc,
          case e.candidate_source
            when 'confirmed_supplier_product' then 1
            when 'supplier_delivery_note_scan' then 2
            when 'cogs_product_sku_exact' then 3
            when 'payment_history_sku_exact' then 4
            when 'payment_history_name_unit' then 5
            when 'payment_history_name_contains' then 6
            else 7
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
    )::bigint,
    r.scan_evidence_id,
    r.source_reference,
    r.package_quantity,
    r.package_unit,
    r.suggested_base_quantity,
    r.suggested_base_unit
  from ranked r
  join public.suppliers s on s.id = r.supplier_id
  where r.identity_rank = 1
  order by r.confirmed desc,
    case r.candidate_source when 'supplier_delivery_note_scan' then 0 else 1 end,
    r.evidence_count desc, r.latest_request_at desc nulls last, s.name, r.product_name;
end;
$$;

revoke all on function public.get_material_supplier_suggestions(uuid) from public, anon;
grant execute on function public.get_material_supplier_suggestions(uuid) to authenticated, service_role;

revoke all on function public.confirm_material_supplier_product(uuid, integer, uuid, uuid, text, text, text) from public, anon, authenticated, service_role;
drop function public.confirm_material_supplier_product(uuid, integer, uuid, uuid, text, text, text);

create or replace function public.confirm_material_supplier_product(
  p_material_id uuid,
  p_expected_version integer,
  p_supplier_id uuid,
  p_product_sku_id uuid,
  p_supplier_product_name text,
  p_purchase_unit text,
  p_reason text,
  p_scan_evidence_id uuid default null,
  p_confirmed_base_quantity numeric default null,
  p_confirmed_base_unit text default null
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
  v_scan public.material_supplier_unit_scan_evidence%rowtype;
  v_link_existing boolean := false;
  v_alias_existing boolean := false;
  v_name text := nullif(btrim(coalesce(p_supplier_product_name, '')), '');
  v_unit text := nullif(btrim(coalesce(p_purchase_unit, '')), '');
  v_confirmed_base_unit text := nullif(btrim(coalesce(p_confirmed_base_unit, '')), '');
  v_code text;
  v_evidence_count bigint := 0;
  v_conversion_pending boolean;
  v_base_quantity numeric := 1;
  v_base_unit text;
  v_conversion public.material_unit_conversions%rowtype;
  v_selection_source text := 'manual_supplier_selection';
  v_metadata jsonb;
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

  v_base_unit := v_material.default_unit;

  if p_scan_evidence_id is not null then
    select se.* into v_scan
    from public.material_supplier_unit_scan_evidence se
    join public.goods_receipt_items gri on gri.id = se.goods_receipt_item_id
    where se.id = p_scan_evidence_id
      and se.supplier_id = p_supplier_id
      and gri.canonical_material_id = p_material_id
    for update of se;
    if not found
      or public.material_master_normalize(v_scan.raw_product_name) is distinct from public.material_master_normalize(v_name)
      or lower(btrim(v_scan.raw_purchase_unit)) is distinct from lower(btrim(v_unit)) then
      raise exception 'scan evidence does not belong to selected material/supplier/name/unit' using errcode = '23514';
    end if;
    v_name := v_scan.raw_product_name;
    v_unit := v_scan.raw_purchase_unit;
    v_evidence_count := 1;
    v_selection_source := 'supplier_delivery_note_scan';
  end if;

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
    if v_selection_source <> 'supplier_delivery_note_scan' then
      v_selection_source := 'product_skus';
    end if;
  else
    select count(*) into v_evidence_count
    from public.payment_request_items pri
    join public.payment_requests pr on pr.id = pri.payment_request_id
    where pr.supplier_id = p_supplier_id
      and public.material_master_normalize(pri.product_name) = public.material_master_normalize(v_name)
      and lower(btrim(coalesce(pri.unit, ''))) = lower(btrim(v_unit));
    select pri.product_code into v_code
    from public.payment_request_items pri
    join public.payment_requests pr on pr.id = pri.payment_request_id
    where pr.supplier_id = p_supplier_id
      and public.material_master_normalize(pri.product_name) = public.material_master_normalize(v_name)
      and lower(btrim(coalesce(pri.unit, ''))) = lower(btrim(v_unit))
    order by pr.created_at desc, pri.created_at desc, pri.id desc limit 1;
    if v_selection_source <> 'supplier_delivery_note_scan' and v_evidence_count > 0 then
      v_selection_source := 'payment_history';
    end if;
  end if;

  if p_confirmed_base_quantity is not null or v_confirmed_base_unit is not null then
    if p_confirmed_base_quantity is null or v_confirmed_base_unit is null then
      raise exception 'confirmed base quantity and unit must be provided together' using errcode = '22023';
    end if;
    if p_confirmed_base_quantity <= 0 or p_confirmed_base_quantity::text in ('NaN','Infinity','-Infinity') then
      raise exception 'confirmed base quantity must be positive' using errcode = '22023';
    end if;
    if lower(btrim(v_confirmed_base_unit)) <> lower(btrim(v_material.default_unit)) then
      raise exception 'confirmed base unit must equal COGS unit' using errcode = '23514';
    end if;
    if lower(btrim(v_unit)) = lower(btrim(v_material.default_unit)) and p_confirmed_base_quantity <> 1 then
      raise exception 'same purchase and COGS unit must use factor 1' using errcode = '23514';
    end if;
    v_base_quantity := p_confirmed_base_quantity;
    v_base_unit := v_material.default_unit;
  elsif lower(btrim(v_unit)) = lower(btrim(v_material.default_unit)) then
    v_base_quantity := 1;
    v_base_unit := v_material.default_unit;
  else
    v_base_quantity := 1;
    v_base_unit := v_material.default_unit;
  end if;

  v_conversion_pending := lower(btrim(v_unit)) <> lower(btrim(v_material.default_unit))
    and p_confirmed_base_quantity is null;

  if p_confirmed_base_quantity is not null and lower(btrim(v_unit)) <> lower(btrim(v_material.default_unit)) then
    select * into v_conversion
    from public.material_unit_conversions
    where material_id = p_material_id
      and active = true and approved = true and effective_to is null
      and lower(btrim(from_unit)) = lower(btrim(v_unit))
      and lower(btrim(to_unit)) = lower(btrim(v_material.default_unit))
    order by effective_from desc, created_at asc, id asc limit 1 for update;
    if found then
      if v_conversion.factor is distinct from p_confirmed_base_quantity then
        raise exception 'approved material unit conversion conflict' using errcode = '23505';
      end if;
    else
      insert into public.material_unit_conversions (
        material_id, from_unit, to_unit, factor, effective_from, source_type, source_id,
        approved, approved_by, approved_at, active, metadata, created_by
      ) values (
        p_material_id, v_unit, v_material.default_unit, p_confirmed_base_quantity, current_date,
        'supplier_delivery_note_scan', p_scan_evidence_id,
        true, v_actor, now(), true,
        jsonb_build_object(
          'supplier_id', p_supplier_id,
          'supplier_product_name', v_name,
          'explicit_user_confirmation', true,
          'selection_source', v_selection_source
        ),
        v_actor
      ) returning * into v_conversion;
    end if;
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
  if v_link_existing and v_alias_existing
    and v_link.base_quantity is not distinct from v_base_quantity
    and lower(btrim(v_link.base_unit)) = lower(btrim(v_base_unit))
    and v_link.package_quantity is not distinct from (case when p_scan_evidence_id is not null then v_scan.package_quantity else v_link.package_quantity end)
    and lower(btrim(coalesce(v_link.package_unit, ''))) is not distinct from lower(btrim(coalesce((case when p_scan_evidence_id is not null then v_scan.package_unit else v_link.package_unit end), ''))) then
    return jsonb_build_object(
      'status', 'supplier_product_unchanged', 'material_id', p_material_id,
      'supplier_id', p_supplier_id, 'supplier_product_id', v_link.id,
      'conversion_pending', v_conversion_pending, 'version', v_material.version
    );
  end if;

  if v_material.version is distinct from p_expected_version then
    raise exception 'material version conflict' using errcode = '40001';
  end if;

  v_metadata := jsonb_build_object(
    'selected_in_material_controller', true,
    'conversion_pending', v_conversion_pending,
    'evidence_count', v_evidence_count,
    'selection_source', v_selection_source,
    'explicit_user_confirmation', true,
    'scan_evidence_id', p_scan_evidence_id,
    'source_reference', case when p_scan_evidence_id is not null then v_scan.source_reference else null end,
    'suggested_base_quantity', p_confirmed_base_quantity,
    'suggested_base_unit', case when p_confirmed_base_quantity is not null then v_material.default_unit else null end
  );

  if not v_link_existing then
    begin
      insert into public.material_supplier_products (
        material_id, supplier_id, product_sku_id, supplier_product_code,
        supplier_product_name, normalized_supplier_product_name,
        purchase_unit, package_quantity, package_unit, base_quantity, base_unit,
        approved, approved_by, approved_at, active, metadata, created_by
      ) values (
        p_material_id, p_supplier_id, p_product_sku_id, v_code,
        v_name, public.material_master_normalize(v_name),
        v_unit,
        case when p_scan_evidence_id is not null then v_scan.package_quantity else null end,
        case when p_scan_evidence_id is not null then v_scan.package_unit else null end,
        v_base_quantity, v_base_unit,
        true, v_actor, now(), true, v_metadata, v_actor
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
      v_link_existing := true;
    end;
  end if;

  if v_link_existing then
    update public.material_supplier_products
    set package_quantity = case when p_scan_evidence_id is not null then v_scan.package_quantity else package_quantity end,
        package_unit = case when p_scan_evidence_id is not null then v_scan.package_unit else package_unit end,
        base_quantity = v_base_quantity,
        base_unit = v_base_unit,
        product_sku_id = coalesce(p_product_sku_id, product_sku_id),
        supplier_product_code = coalesce(v_code, supplier_product_code),
        metadata = coalesce(metadata, '{}'::jsonb) || v_metadata,
        updated_at = now()
    where id = v_link.id
    returning * into v_link;
  end if;

  if not v_alias_existing then
    insert into public.material_scoped_aliases (
      material_id, supplier_id, source_type, alias_name, normalized_alias,
      approved, approved_by, approved_at, active, metadata, created_by
    ) values (
      p_material_id, p_supplier_id, case when v_selection_source = 'supplier_delivery_note_scan' then 'goods_receipt' else 'payment_request' end, v_name,
      public.material_master_normalize(v_name), true, v_actor, now(), true,
      jsonb_build_object(
        'supplier_product_id', v_link.id,
        'selected_in_material_controller', true,
        'exact_future_resolution', true,
        'selection_source', v_selection_source,
        'scan_evidence_id', p_scan_evidence_id
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
      'base_quantity', v_base_quantity, 'base_unit', v_base_unit,
      'package_quantity', v_link.package_quantity, 'package_unit', v_link.package_unit,
      'future_resolution', 'approved_supplier_alias_exact',
      'selection', 'explicit_user_confirmation',
      'selection_source', v_selection_source,
      'scan_evidence_id', p_scan_evidence_id,
      'material_unit_conversion_id', case when v_conversion.id is not null then v_conversion.id else null end
    )
  );

  return jsonb_build_object(
    'status', 'supplier_product_confirmed', 'material_id', p_material_id,
    'supplier_id', p_supplier_id, 'supplier_product_id', v_link.id,
    'conversion_pending', v_conversion_pending, 'version', v_new_material.version,
    'scan_evidence_id', p_scan_evidence_id,
    'base_quantity', v_base_quantity, 'base_unit', v_base_unit
  );
end;
$$;

revoke all on function public.confirm_material_supplier_product(uuid, integer, uuid, uuid, text, text, text, uuid, numeric, text) from public, anon;
grant execute on function public.confirm_material_supplier_product(uuid, integer, uuid, uuid, text, text, text, uuid, numeric, text) to authenticated, service_role;

comment on table public.material_supplier_unit_scan_evidence is
  'Append-only private OCR/source evidence for supplier delivery note purchase-unit suggestions; service-role RPC only.';
comment on function public.record_material_supplier_unit_scan_evidence(uuid, text, text, uuid, jsonb) is
  'Service-role-only idempotent recorder for supplier delivery note scan evidence. Does not write finance or goods receipt item rows.';
comment on function public.get_material_supplier_suggestions(uuid) is
  'COGS-rooted supplier product suggestions including confirmed rows, supplier_delivery_note_scan OCR evidence, and historical read-only fallbacks.';
comment on function public.confirm_material_supplier_product(uuid, integer, uuid, uuid, text, text, text, uuid, numeric, text) is
  'Explicitly confirm one supplier/name/unit identity for a canonical COGS material, optionally approving a user-provided purchase-unit to COGS-unit factor.';
