-- 2026-10-24 — Kho: hồ sơ ATTP theo nhà cung cấp / mặt hàng.
--
-- Data layer only.  This migration:
--   * adds kitchen_inventory_items.attp_profile (null = derive from class/name)
--     and public.kho_attp_default_profile / kho_attp_required_kinds;
--   * extends food_safety_certificates with review_status (pending/confirmed),
--     reviewer fields and the OCR extract, plus the 'quarantine' cert type;
--   * adds food_cert_item_links so one certificate can cover several items;
--   * adds kho_attp_checklist (suppliers -> items -> requirements + totals);
--   * adds the pending/confirm/link RPCs and extends food_cert_payload/list;
--   * recreates the expiry reminder with the one extra pending filter.
--
-- Nothing here writes stock, stock ledgers, goods receipts, purchase orders or
-- payments.  Existing certificate rows stay 'confirmed'.

-- ===========================================================================
-- 1. Item ATTP profile (null = derived)
-- ===========================================================================

alter table public.kitchen_inventory_items
  add column if not exists attp_profile text;

alter table public.kitchen_inventory_items
  drop constraint if exists kitchen_inventory_items_attp_profile_check;
alter table public.kitchen_inventory_items
  add constraint kitchen_inventory_items_attp_profile_check
  check (
    attp_profile is null
    or attp_profile in (
      'packaged_food',
      'fresh_meat',
      'fresh_produce',
      'food_contact_packaging',
      'none'
    )
  );

-- Reuse the immutable accent/lower normalizer already shared with the TS
-- layers.  The regexes below are deliberately written without diacritics
-- because normalize_stock_item_name() strips them.
create or replace function public.kho_attp_default_profile(
  p_class text,
  p_type text,
  p_name text
)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case
    when p_class = 'non_stock' then 'none'
    when p_class = 'raw_material' then
      case
        -- Sauces and anything sold in a pack are packaged food even when the
        -- name mentions a vegetable (Tương ớt Cholimex gói 10g).
        when public.normalize_stock_item_name(p_name)
             ~ '\m(tuong|nuoc mam|goi|chai|hu|lo|thung|hop|bot|say)\M'
          then 'packaged_food'
        when public.normalize_stock_item_name(p_name)
             ~ '\m(nac|mo|gan|thit|xuong|da bao|suon|ba chi|dui)\M'
          then 'fresh_meat'
        when public.normalize_stock_item_name(p_name)
             ~ '\m(ca rot|dua leo|hanh|ngo|ot|toi|cu cai|rau|xa lach|ca chua|chanh|gung|sa)\M'
          then 'fresh_produce'
        else 'packaged_food'
      end
    when p_class = 'packaging_supply' then
      case
        -- Bin bags and cleaning supplies never touch food.
        when public.normalize_stock_item_name(p_name) ~ '\m(rac|ve sinh|lau|rua)\M'
          then 'none'
        when public.normalize_stock_item_name(p_name)
             ~ '\m(boc|mang|hop|tui|khay|giay nen|nhom|ly|nap|bao banh|giay goi|opp|pe)\M'
          then 'food_contact_packaging'
        else 'none'
      end
    else 'packaged_food'
  end;
$$;

revoke all on function public.kho_attp_default_profile(text, text, text) from public, anon;
grant execute on function public.kho_attp_default_profile(text, text, text) to authenticated, service_role;

-- ===========================================================================
-- 2. Certificate review state + quarantine type
-- ===========================================================================

alter table public.food_safety_certificates
  add column if not exists review_status text not null default 'confirmed',
  add column if not exists reviewed_by uuid references auth.users(id) on delete set null,
  add column if not exists reviewed_at timestamptz,
  add column if not exists extracted jsonb;

alter table public.food_safety_certificates
  drop constraint if exists food_safety_certificates_review_status_check;
alter table public.food_safety_certificates
  add constraint food_safety_certificates_review_status_check
  check (review_status in ('pending', 'confirmed'));

-- Existing rows were never reviewed in the UI: they are trusted/confirmed.
update public.food_safety_certificates
   set review_status = 'confirmed'
 where review_status is null;

alter table public.food_safety_certificates
  drop constraint if exists food_safety_certificates_cert_type_check;
alter table public.food_safety_certificates
  add constraint food_safety_certificates_cert_type_check
  check (cert_type in (
    'attp_facility',
    'coa',
    'product_declaration',
    'quarantine',
    'other'
  ));

-- ===========================================================================
-- 3. One certificate can cover several items
-- ===========================================================================

create table if not exists public.food_cert_item_links (
  cert_id uuid not null references public.food_safety_certificates(id) on delete cascade,
  item_id uuid not null references public.kitchen_inventory_items(id) on delete cascade,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (cert_id, item_id)
);

create index if not exists idx_food_cert_item_links_item
  on public.food_cert_item_links (item_id);

alter table public.food_cert_item_links enable row level security;

drop policy if exists food_cert_item_links_select on public.food_cert_item_links;
create policy food_cert_item_links_select
  on public.food_cert_item_links
  for select
  to authenticated
  using (
    public.q7_material_inventory_can_view((select auth.uid()))
    or public.stock_count_can_view('tan_tao')
    or public.stock_count_can_view('q7')
    or public.kho_item_can_edit((select auth.uid()))
  );

revoke all on table public.food_cert_item_links from public, anon, authenticated;
grant select on table public.food_cert_item_links to authenticated;
grant all on table public.food_cert_item_links to service_role;

-- Extend the existing idempotency ledger with the new actions.  No new table
-- is needed: (request_id -> cert_id, action) is exactly the same contract.
alter table public.food_cert_requests
  drop constraint if exists food_cert_requests_action_check;
alter table public.food_cert_requests
  add constraint food_cert_requests_action_check
  check (action in ('upsert', 'archive', 'pending', 'confirm'));

-- ===========================================================================
-- 4. Required certificate kinds per profile
-- ===========================================================================

create or replace function public.kho_attp_required_kinds(p_profile text)
returns text[]
language sql
immutable
set search_path = public, pg_temp
as $$
  select case p_profile
    when 'packaged_food' then array['attp_facility', 'product_declaration', 'coa']::text[]
    when 'fresh_meat' then array['attp_facility', 'quarantine']::text[]
    when 'fresh_produce' then array['attp_facility']::text[]
    when 'food_contact_packaging' then array['product_declaration', 'coa']::text[]
    when 'none' then array[]::text[]
    else array[]::text[]
  end;
$$;

revoke all on function public.kho_attp_required_kinds(text) from public, anon;
grant execute on function public.kho_attp_required_kinds(text) to authenticated, service_role;

-- ===========================================================================
-- 5. The checklist read model
-- ===========================================================================
-- Suppliers -> items -> requirements.  A receipt line is resolved exactly once
-- in scoped_lines/resolved_lines; every later CTE reuses that materialisation.
-- An item bought from two suppliers appears under both; items_by_item keeps one
-- entry per item for the "Theo món kho" view.

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

-- ===========================================================================
-- 6. Set / reset an item profile
-- ===========================================================================

create or replace function public.kho_attp_set_profile(
  p_item_id uuid,
  p_profile text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_item public.kitchen_inventory_items%rowtype;
  v_profile text := nullif(btrim(coalesce(p_profile, '')), '');
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not public.kho_item_can_edit(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  if v_profile is not null
     and v_profile not in (
       'packaged_food',
       'fresh_meat',
       'fresh_produce',
       'food_contact_packaging',
       'none'
     ) then
    raise exception 'invalid_attp_profile' using errcode = '22023';
  end if;

  update public.kitchen_inventory_items kii
     set attp_profile = v_profile
   where kii.id = p_item_id
   returning * into v_item;

  if not found then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'item_id', v_item.id,
    'attp_profile', v_item.attp_profile,
    'profile_source', case when v_item.attp_profile is null then 'default' else 'set' end,
    'effective_profile', coalesce(
      v_item.attp_profile,
      public.kho_attp_default_profile(v_item.item_class, v_item.item_type, v_item.name)
    )
  );
end;
$$;

revoke all on function public.kho_attp_set_profile(uuid, text) from public, anon;
grant execute on function public.kho_attp_set_profile(uuid, text) to authenticated, service_role;

-- ===========================================================================
-- 7. Certificate payload/list: review state, extract and linked items
-- ===========================================================================

create or replace function public.food_cert_payload(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', c.id,
    'owner_kind', c.owner_kind,
    'owner_id', coalesce(c.manufacturer_id, c.item_id, c.supplier_id),
    'owner_name', case c.owner_kind
      when 'manufacturer' then fm.name
      when 'item' then kii.name
      when 'supplier' then s.name
      when 'company' then 'Công ty'
      else null
    end,
    'cert_type', c.cert_type,
    'cert_no', c.cert_no,
    'issuer', c.issuer,
    'issued_on', c.issued_on,
    'expires_on', c.expires_on,
    'days_left', case
      when c.expires_on is null then null
      else (c.expires_on - current_date)::integer
    end,
    'file_path', c.file_path,
    'file_name', c.file_name,
    'mime_type', c.mime_type,
    'note', c.note,
    'created_by', c.created_by,
    'created_at', c.created_at,
    'archived_at', c.archived_at,
    'archived_by', c.archived_by,
    'review_status', c.review_status,
    'reviewed_by', c.reviewed_by,
    'reviewed_at', c.reviewed_at,
    'extracted', c.extracted,
    'linked_item_ids', coalesce((
      select jsonb_agg(l.item_id order by l.item_id)
        from public.food_cert_item_links l
       where l.cert_id = c.id
    ), '[]'::jsonb),
    'linked_items', coalesce((
      select jsonb_agg(
               jsonb_build_object('id', li.id, 'name', li.name)
               order by li.name, li.id
             )
        from public.food_cert_item_links l
        join public.kitchen_inventory_items li on li.id = l.item_id
       where l.cert_id = c.id
    ), '[]'::jsonb),
    'linked_item_names', coalesce((
      select jsonb_agg(li.name order by li.name, li.id)
        from public.food_cert_item_links l
        join public.kitchen_inventory_items li on li.id = l.item_id
       where l.cert_id = c.id
    ), '[]'::jsonb)
  )
  from public.food_safety_certificates c
  left join public.food_manufacturers fm on fm.id = c.manufacturer_id
  left join public.kitchen_inventory_items kii on kii.id = c.item_id
  left join public.suppliers s on s.id = c.supplier_id
  where c.id = p_id;
$$;

revoke all on function public.food_cert_payload(uuid) from public, anon, authenticated;
grant execute on function public.food_cert_payload(uuid) to service_role;

create or replace function public.food_cert_list(
  p_owner_kind text default null,
  p_owner_id uuid default null,
  p_expiring_days integer default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_result jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not public.kho_lot_can_view(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  if p_owner_kind is not null
     and p_owner_kind not in ('manufacturer', 'item', 'supplier', 'company') then
    raise exception 'invalid_owner_kind' using errcode = '22023';
  end if;

  if p_expiring_days is not null and (p_expiring_days < 0 or p_expiring_days > 3650) then
    raise exception 'invalid_expiring_days' using errcode = '22023';
  end if;

  select coalesce(jsonb_agg(
           public.food_cert_payload(c.id)
           order by c.created_at desc, c.id desc
         ), '[]'::jsonb)
    into v_result
    from public.food_safety_certificates c
   where c.archived_at is null
     and (p_owner_kind is null or c.owner_kind = p_owner_kind)
     and (
       p_owner_id is null
       or (c.owner_kind = 'manufacturer' and c.manufacturer_id = p_owner_id)
       or (c.owner_kind = 'item' and c.item_id = p_owner_id)
       or (c.owner_kind = 'supplier' and c.supplier_id = p_owner_id)
     )
     and (
       p_expiring_days is null
       or (c.expires_on is not null and c.expires_on <= current_date + p_expiring_days)
     );

  return v_result;
end;
$$;

revoke all on function public.food_cert_list(text, uuid, integer) from public, anon;
grant execute on function public.food_cert_list(text, uuid, integer) to authenticated, service_role;

-- ===========================================================================
-- 8. Existing upsert: accept 'quarantine', still inserts 'confirmed'
-- ===========================================================================

create or replace function public.food_cert_upsert(
  p_id uuid,
  p_owner_kind text,
  p_owner_id uuid,
  p_cert_type text,
  p_cert_no text,
  p_issuer text,
  p_issued_on date,
  p_expires_on date,
  p_file_path text,
  p_file_name text,
  p_mime_type text,
  p_note text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_cert_id uuid := p_id;
  v_manufacturer_id uuid;
  v_item_id uuid;
  v_supplier_id uuid;
  v_file_path text := nullif(btrim(coalesce(p_file_path, '')), '');
  v_request_cert_id uuid;
  v_request_action text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not public.kho_item_can_edit(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  if p_owner_kind is null
     or p_owner_kind not in ('manufacturer', 'item', 'supplier', 'company') then
    raise exception 'invalid_owner_kind' using errcode = '22023';
  end if;

  if p_cert_type is null
     or p_cert_type not in (
       'attp_facility',
       'coa',
       'product_declaration',
       'quarantine',
       'other'
     ) then
    raise exception 'invalid_cert_type' using errcode = '22023';
  end if;

  if p_owner_kind = 'manufacturer' then
    if p_owner_id is null or not exists (
      select 1 from public.food_manufacturers fm where fm.id = p_owner_id
    ) then
      raise exception 'owner_not_found' using errcode = 'P0002';
    end if;
    v_manufacturer_id := p_owner_id;
  elsif p_owner_kind = 'item' then
    if p_owner_id is null or not exists (
      select 1 from public.kitchen_inventory_items kii where kii.id = p_owner_id
    ) then
      raise exception 'owner_not_found' using errcode = 'P0002';
    end if;
    v_item_id := p_owner_id;
  elsif p_owner_kind = 'supplier' then
    if p_owner_id is null or not exists (
      select 1 from public.suppliers s where s.id = p_owner_id
    ) then
      raise exception 'owner_not_found' using errcode = 'P0002';
    end if;
    v_supplier_id := p_owner_id;
  elsif p_owner_id is not null then
    raise exception 'invalid_owner' using errcode = '22023';
  end if;

  if v_file_path is null then
    raise exception 'file_required' using errcode = '22023';
  end if;

  if v_file_path not like 'certs/%' or position('..' in v_file_path) > 0 then
    raise exception 'invalid_file_path' using errcode = '22023';
  end if;

  if p_issued_on is not null and p_expires_on is not null and p_expires_on < p_issued_on then
    raise exception 'invalid_expiry_date' using errcode = '22023';
  end if;

  if p_request_id is not null then
    perform pg_advisory_xact_lock(hashtext('food_cert:' || p_request_id::text));

    select r.cert_id, r.action
      into v_request_cert_id, v_request_action
      from public.food_cert_requests r
     where r.request_id = p_request_id;

    if v_request_cert_id is not null then
      if v_request_action <> 'upsert' then
        raise exception 'request_id_conflict' using errcode = '22023';
      end if;
      return public.food_cert_payload(v_request_cert_id) || jsonb_build_object('replayed', true);
    end if;
  end if;

  if p_id is null then
    insert into public.food_safety_certificates (
      owner_kind, manufacturer_id, item_id, supplier_id,
      cert_type, cert_no, issuer, issued_on, expires_on,
      file_path, file_name, mime_type, note, created_by, review_status
    ) values (
      p_owner_kind, v_manufacturer_id, v_item_id, v_supplier_id,
      p_cert_type, nullif(btrim(coalesce(p_cert_no, '')), ''),
      nullif(btrim(coalesce(p_issuer, '')), ''),
      p_issued_on, p_expires_on,
      v_file_path, nullif(btrim(coalesce(p_file_name, '')), ''),
      nullif(btrim(coalesce(p_mime_type, '')), ''),
      nullif(btrim(coalesce(p_note, '')), ''), v_actor, 'confirmed'
    )
    returning id into v_cert_id;
  else
    update public.food_safety_certificates c
       set owner_kind = p_owner_kind,
           manufacturer_id = v_manufacturer_id,
           item_id = v_item_id,
           supplier_id = v_supplier_id,
           cert_type = p_cert_type,
           cert_no = nullif(btrim(coalesce(p_cert_no, '')), ''),
           issuer = nullif(btrim(coalesce(p_issuer, '')), ''),
           issued_on = p_issued_on,
           expires_on = p_expires_on,
           file_path = v_file_path,
           file_name = nullif(btrim(coalesce(p_file_name, '')), ''),
           mime_type = nullif(btrim(coalesce(p_mime_type, '')), ''),
           note = nullif(btrim(coalesce(p_note, '')), '')
     where c.id = p_id
       and c.archived_at is null;

    if not found then
      raise exception 'cert_not_found' using errcode = 'P0002';
    end if;
  end if;

  if p_request_id is not null then
    insert into public.food_cert_requests (request_id, cert_id, action, created_by)
    values (p_request_id, v_cert_id, 'upsert', v_actor)
    on conflict (request_id) do nothing;
  end if;

  return public.food_cert_payload(v_cert_id) || jsonb_build_object('replayed', false);
end;
$$;

revoke all on function public.food_cert_upsert(uuid, text, uuid, text, text, text, date, date, text, text, text, text, uuid) from public, anon;
grant execute on function public.food_cert_upsert(uuid, text, uuid, text, text, text, date, date, text, text, text, text, uuid) to authenticated, service_role;

-- ===========================================================================
-- 9. Upload as pending
-- ===========================================================================

create or replace function public.food_cert_upload_pending(
  p_cert_type text,
  p_owner_kind text,
  p_owner_id uuid,
  p_cert_no text,
  p_issuer text,
  p_issued_on date,
  p_expires_on date,
  p_file_path text,
  p_file_name text,
  p_mime_type text,
  p_extracted jsonb,
  p_item_ids uuid[],
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_cert_id uuid;
  v_manufacturer_id uuid;
  v_item_id uuid;
  v_supplier_id uuid;
  v_file_path text := nullif(btrim(coalesce(p_file_path, '')), '');
  v_request_cert_id uuid;
  v_request_action text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not public.kho_item_can_edit(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  if p_owner_kind is null
     or p_owner_kind not in ('manufacturer', 'item', 'supplier', 'company') then
    raise exception 'invalid_owner_kind' using errcode = '22023';
  end if;

  if p_cert_type is null
     or p_cert_type not in (
       'attp_facility',
       'coa',
       'product_declaration',
       'quarantine',
       'other'
     ) then
    raise exception 'invalid_cert_type' using errcode = '22023';
  end if;

  if p_owner_kind = 'manufacturer' then
    if p_owner_id is null or not exists (
      select 1 from public.food_manufacturers fm where fm.id = p_owner_id
    ) then
      raise exception 'owner_not_found' using errcode = 'P0002';
    end if;
    v_manufacturer_id := p_owner_id;
  elsif p_owner_kind = 'item' then
    if p_owner_id is null or not exists (
      select 1 from public.kitchen_inventory_items kii where kii.id = p_owner_id
    ) then
      raise exception 'owner_not_found' using errcode = 'P0002';
    end if;
    v_item_id := p_owner_id;
  elsif p_owner_kind = 'supplier' then
    if p_owner_id is null or not exists (
      select 1 from public.suppliers s where s.id = p_owner_id
    ) then
      raise exception 'owner_not_found' using errcode = 'P0002';
    end if;
    v_supplier_id := p_owner_id;
  elsif p_owner_id is not null then
    raise exception 'invalid_owner' using errcode = '22023';
  end if;

  if v_file_path is null then
    raise exception 'file_required' using errcode = '22023';
  end if;

  if v_file_path not like 'certs/%' or position('..' in v_file_path) > 0 then
    raise exception 'invalid_file_path' using errcode = '22023';
  end if;

  if p_issued_on is not null and p_expires_on is not null and p_expires_on < p_issued_on then
    raise exception 'invalid_expiry_date' using errcode = '22023';
  end if;

  if p_item_ids is not null and exists (
    select 1
      from unnest(p_item_ids) x(id)
     where x.id is null
        or not exists (
          select 1 from public.kitchen_inventory_items kii where kii.id = x.id
        )
  ) then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;

  if p_request_id is not null then
    perform pg_advisory_xact_lock(hashtext('food_cert:' || p_request_id::text));

    select r.cert_id, r.action
      into v_request_cert_id, v_request_action
      from public.food_cert_requests r
     where r.request_id = p_request_id;

    if v_request_cert_id is not null then
      if v_request_action <> 'pending' then
        raise exception 'request_id_conflict' using errcode = '22023';
      end if;
      return public.food_cert_payload(v_request_cert_id) || jsonb_build_object('replayed', true);
    end if;
  end if;

  insert into public.food_safety_certificates (
    owner_kind, manufacturer_id, item_id, supplier_id,
    cert_type, cert_no, issuer, issued_on, expires_on,
    file_path, file_name, mime_type,
    created_by, review_status, extracted
  ) values (
    p_owner_kind, v_manufacturer_id, v_item_id, v_supplier_id,
    p_cert_type, nullif(btrim(coalesce(p_cert_no, '')), ''),
    nullif(btrim(coalesce(p_issuer, '')), ''),
    p_issued_on, p_expires_on,
    v_file_path, nullif(btrim(coalesce(p_file_name, '')), ''),
    nullif(btrim(coalesce(p_mime_type, '')), ''),
    v_actor, 'pending', p_extracted
  )
  returning id into v_cert_id;

  if p_item_ids is not null then
    insert into public.food_cert_item_links (cert_id, item_id, created_by)
    select v_cert_id, items.id, v_actor
      from (select distinct id from unnest(p_item_ids) x(id)) items
    on conflict (cert_id, item_id) do nothing;
  end if;

  if p_request_id is not null then
    insert into public.food_cert_requests (request_id, cert_id, action, created_by)
    values (p_request_id, v_cert_id, 'pending', v_actor)
    on conflict (request_id) do nothing;
  end if;

  return public.food_cert_payload(v_cert_id) || jsonb_build_object('replayed', false);
end;
$$;

revoke all on function public.food_cert_upload_pending(text, text, uuid, text, text, date, date, text, text, text, jsonb, uuid[], uuid) from public, anon;
grant execute on function public.food_cert_upload_pending(text, text, uuid, text, text, date, date, text, text, text, jsonb, uuid[], uuid) to authenticated, service_role;

-- ===========================================================================
-- 10. Confirm with the user's corrected fields
-- ===========================================================================

create or replace function public.food_cert_confirm(
  p_cert_id uuid,
  p_cert_type text,
  p_owner_kind text,
  p_owner_id uuid,
  p_cert_no text,
  p_issuer text,
  p_issued_on date,
  p_expires_on date,
  p_item_ids uuid[],
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_manufacturer_id uuid;
  v_item_id uuid;
  v_supplier_id uuid;
  v_request_cert_id uuid;
  v_request_action text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not public.kho_item_can_edit(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  if p_owner_kind is null
     or p_owner_kind not in ('manufacturer', 'item', 'supplier', 'company') then
    raise exception 'invalid_owner_kind' using errcode = '22023';
  end if;

  if p_cert_type is null
     or p_cert_type not in (
       'attp_facility',
       'coa',
       'product_declaration',
       'quarantine',
       'other'
     ) then
    raise exception 'invalid_cert_type' using errcode = '22023';
  end if;

  if p_owner_kind = 'manufacturer' then
    if p_owner_id is null or not exists (
      select 1 from public.food_manufacturers fm where fm.id = p_owner_id
    ) then
      raise exception 'owner_not_found' using errcode = 'P0002';
    end if;
    v_manufacturer_id := p_owner_id;
  elsif p_owner_kind = 'item' then
    if p_owner_id is null or not exists (
      select 1 from public.kitchen_inventory_items kii where kii.id = p_owner_id
    ) then
      raise exception 'owner_not_found' using errcode = 'P0002';
    end if;
    v_item_id := p_owner_id;
  elsif p_owner_kind = 'supplier' then
    if p_owner_id is null or not exists (
      select 1 from public.suppliers s where s.id = p_owner_id
    ) then
      raise exception 'owner_not_found' using errcode = 'P0002';
    end if;
    v_supplier_id := p_owner_id;
  elsif p_owner_id is not null then
    raise exception 'invalid_owner' using errcode = '22023';
  end if;

  if p_issued_on is not null and p_expires_on is not null and p_expires_on < p_issued_on then
    raise exception 'invalid_expiry_date' using errcode = '22023';
  end if;

  if p_item_ids is not null and exists (
    select 1
      from unnest(p_item_ids) x(id)
     where x.id is null
        or not exists (
          select 1 from public.kitchen_inventory_items kii where kii.id = x.id
        )
  ) then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;

  if p_request_id is not null then
    perform pg_advisory_xact_lock(hashtext('food_cert:' || p_request_id::text));

    select r.cert_id, r.action
      into v_request_cert_id, v_request_action
      from public.food_cert_requests r
     where r.request_id = p_request_id;

    if v_request_cert_id is not null then
      if v_request_action <> 'confirm' then
        raise exception 'request_id_conflict' using errcode = '22023';
      end if;
      return public.food_cert_payload(v_request_cert_id) || jsonb_build_object('replayed', true);
    end if;
  end if;

  update public.food_safety_certificates c
     set cert_type = p_cert_type,
         owner_kind = p_owner_kind,
         manufacturer_id = v_manufacturer_id,
         item_id = v_item_id,
         supplier_id = v_supplier_id,
         cert_no = nullif(btrim(coalesce(p_cert_no, '')), ''),
         issuer = nullif(btrim(coalesce(p_issuer, '')), ''),
         issued_on = p_issued_on,
         expires_on = p_expires_on,
         review_status = 'confirmed',
         reviewed_by = v_actor,
         reviewed_at = now()
   where c.id = p_cert_id
     and c.archived_at is null;

  if not found then
    raise exception 'cert_not_found' using errcode = 'P0002';
  end if;

  delete from public.food_cert_item_links l where l.cert_id = p_cert_id;

  if p_item_ids is not null then
    insert into public.food_cert_item_links (cert_id, item_id, created_by)
    select p_cert_id, items.id, v_actor
      from (select distinct id from unnest(p_item_ids) x(id)) items
    on conflict (cert_id, item_id) do nothing;
  end if;

  if p_request_id is not null then
    insert into public.food_cert_requests (request_id, cert_id, action, created_by)
    values (p_request_id, p_cert_id, 'confirm', v_actor)
    on conflict (request_id) do nothing;
  end if;

  return public.food_cert_payload(p_cert_id) || jsonb_build_object('replayed', false);
end;
$$;

revoke all on function public.food_cert_confirm(uuid, text, text, uuid, text, text, date, date, uuid[], uuid) from public, anon;
grant execute on function public.food_cert_confirm(uuid, text, text, uuid, text, text, date, date, uuid[], uuid) to authenticated, service_role;

-- ===========================================================================
-- 11. Replace certificate -> item links
-- ===========================================================================

create or replace function public.food_cert_link_items(
  p_cert_id uuid,
  p_item_ids uuid[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not public.kho_item_can_edit(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  if p_cert_id is null or not exists (
    select 1
      from public.food_safety_certificates c
     where c.id = p_cert_id
       and c.archived_at is null
  ) then
    raise exception 'cert_not_found' using errcode = 'P0002';
  end if;

  if p_item_ids is not null and exists (
    select 1
      from unnest(p_item_ids) x(id)
     where x.id is null
        or not exists (
          select 1 from public.kitchen_inventory_items kii where kii.id = x.id
        )
  ) then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;

  delete from public.food_cert_item_links l where l.cert_id = p_cert_id;

  if p_item_ids is not null then
    insert into public.food_cert_item_links (cert_id, item_id, created_by)
    select p_cert_id, items.id, v_actor
      from (select distinct id from unnest(p_item_ids) x(id)) items
    on conflict (cert_id, item_id) do nothing;
  end if;

  return public.food_cert_payload(p_cert_id) || jsonb_build_object('replayed', false);
end;
$$;

revoke all on function public.food_cert_link_items(uuid, uuid[]) from public, anon;
grant execute on function public.food_cert_link_items(uuid, uuid[]) to authenticated, service_role;

-- ===========================================================================
-- 12. Reminder: pending certificates are never reminded
-- ===========================================================================
-- Body copied from 20261102950000 with exactly one extra filter
-- (c.review_status = 'confirmed').

create or replace function public.enqueue_food_cert_expiry_reminders(
  p_today date default (now() at time zone 'Asia/Ho_Chi_Minh')::date
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_cert record;
  v_threshold integer;
  v_days_left integer;
  v_type_label text;
  v_body text;
  v_rows integer := 0;
  v_count integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is not null and not public.has_role(v_actor, 'owner') then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  if p_today is null then
    raise exception 'invalid_today' using errcode = '22023';
  end if;

  for v_cert in
    select c.id,
           c.cert_type,
           c.cert_no,
           c.expires_on,
           (c.expires_on - p_today)::integer as days_left,
           case c.owner_kind
             when 'manufacturer' then fm.name
             when 'item' then kii.name
             when 'supplier' then s.name
             when 'company' then 'Công ty'
             else null
           end as owner_name
      from public.food_safety_certificates c
      left join public.food_manufacturers fm on fm.id = c.manufacturer_id
      left join public.kitchen_inventory_items kii on kii.id = c.item_id
      left join public.suppliers s on s.id = c.supplier_id
     where c.archived_at is null
       and c.expires_on is not null
       and c.review_status = 'confirmed'
     order by c.expires_on, c.created_at, c.id
  loop
    v_days_left := v_cert.days_left;

    -- Remind at 30, 7 and 0 days, plus one day of grace so an expired
    -- certificate still produces its single 0-day notice.
    if v_days_left > 30 or v_days_left < -1 then
      continue;
    end if;

    v_threshold := case
      when v_days_left <= 0 then 0
      when v_days_left <= 7 then 7
      else 30
    end;

    v_type_label := case v_cert.cert_type
      when 'attp_facility' then 'Giấy chứng nhận cơ sở đủ điều kiện ATTP'
      when 'coa' then 'Phiếu kiểm nghiệm (COA)'
      when 'product_declaration' then 'Bản công bố sản phẩm'
      else 'Giấy tờ khác'
    end;

    v_body := (case
        when v_days_left <= 0 then 'Giấy ATTP hết hạn hôm nay'
        else 'Giấy ATTP sắp hết hạn'
      end)
      || ': ' || v_type_label
      || E'\n' || 'Đơn vị: ' || left(coalesce(v_cert.owner_name, 'Công ty'), 200)
      || E'\n' || 'Số giấy: ' || left(coalesce(nullif(btrim(v_cert.cert_no), ''), 'chưa có'), 120)
      || E'\n' || 'Ngày hết hạn: ' || to_char(v_cert.expires_on, 'DD/MM/YYYY')
      || E'\n' || 'Xem: https://ai.banhmique.vn/warehouse/ho-so-attp';

    insert into public.mission_zalo_notifications (
      event_type,
      mission_id,
      batch_id,
      dedupe_key,
      message_body,
      status,
      next_attempt_at
    ) values (
      'food_cert_expiry',
      null,
      null,
      'food-cert:' || v_cert.id::text || ':' || v_threshold::text || ':' || v_cert.expires_on::text,
      left(v_body, 4000),
      'pending',
      now()
    )
    on conflict (dedupe_key) do nothing;

    get diagnostics v_rows = row_count;
    v_count := v_count + v_rows;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.enqueue_food_cert_expiry_reminders(date) from public, anon;
grant execute on function public.enqueue_food_cert_expiry_reminders(date) to authenticated, service_role;
