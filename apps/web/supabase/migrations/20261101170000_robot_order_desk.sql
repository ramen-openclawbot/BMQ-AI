-- Robot đặt hàng NVL — bàn làm việc đặt hàng tự động (phần dữ liệu, không dựng UI).
--
-- Additive only. This migration adds the supplier-debt cutover/mark tables and
-- the three read/write RPCs the robot desk needs, plus the manual / Jev mark
-- writers. Every write goes through a SECURITY DEFINER RPC; the new tables have
-- RLS enabled with a single SELECT policy each and no INSERT/UPDATE/DELETE
-- policy for authenticated.
--
-- Dependencies reused (never rewritten here):
--   * public.create_q7_draft_purchase_orders(jsonb, text)  — draft PO groups
--     per supplier, gated by public.q7_material_inventory_can_edit(uuid).
--   * public.create_payment_submission(uuid[], text, text)  — TC-YYMMDD-NN
--     submission + finance Zalo outbox, gated owner / payment_requests edit.
--   * public.material_master_jwt_role() and public.normalize_stock_item_name.
--   * trigger trg_finance_zalo_payment_request_created: inserting a pending
--     payment request enqueues the Zalo notice by itself.
--
-- This migration never updates or removes an existing payment request or
-- purchase order row; the robot only creates its own drafts and marks.

-- ===========================================================================
-- 1. Tables
-- ===========================================================================

create table if not exists public.supplier_debt_cutovers (
  supplier_id uuid primary key references public.suppliers(id),
  payment_request_id uuid null references public.payment_requests(id),
  purchase_order_id uuid null references public.purchase_orders(id),
  start_date date not null,
  learned_from_package_id uuid null,
  updated_by uuid null,
  updated_at timestamptz not null default now(),
  constraint supplier_debt_cutovers_doc_check
    check (num_nonnulls(payment_request_id, purchase_order_id) = 1)
);

create table if not exists public.supplier_debt_marks (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references public.suppliers(id),
  payment_request_id uuid null references public.payment_requests(id),
  purchase_order_id uuid null references public.purchase_orders(id),
  mark text not null check (mark in ('settled_outside', 'real_debt', 'unsure')),
  source text not null check (source in ('learned', 'jev', 'manual')),
  probability numeric null check (
    probability is null or (probability >= 0 and probability <= 1)
  ),
  note text null,
  created_by uuid null,
  created_at timestamptz not null default now(),
  constraint supplier_debt_marks_doc_check
    check (num_nonnulls(payment_request_id, purchase_order_id) = 1)
);

create unique index if not exists supplier_debt_marks_doc_key
  on public.supplier_debt_marks (coalesce(payment_request_id, purchase_order_id));

create index if not exists idx_supplier_debt_marks_supplier
  on public.supplier_debt_marks (supplier_id, created_at desc);

create table if not exists public.robot_order_packages (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  supplier_id uuid not null references public.suppliers(id),
  purchase_order_ids uuid[] not null default '{}',
  debt_kind text null check (debt_kind in ('pr', 'po')),
  debt_payment_request_id uuid null,
  debt_purchase_order_id uuid null,
  submission_id uuid null,
  note text null,
  result jsonb null,
  created_by uuid null,
  created_at timestamptz not null default now()
);

-- ===========================================================================
-- 2. RLS and grants (writes only through the RPCs)
-- ===========================================================================

alter table public.supplier_debt_cutovers enable row level security;
alter table public.supplier_debt_marks enable row level security;
alter table public.robot_order_packages enable row level security;

drop policy if exists supplier_debt_cutovers_select on public.supplier_debt_cutovers;
create policy supplier_debt_cutovers_select on public.supplier_debt_cutovers
  for select to authenticated using (true);

drop policy if exists supplier_debt_marks_select on public.supplier_debt_marks;
create policy supplier_debt_marks_select on public.supplier_debt_marks
  for select to authenticated using (true);

drop policy if exists robot_order_packages_select on public.robot_order_packages;
create policy robot_order_packages_select on public.robot_order_packages
  for select to authenticated using (true);

revoke all on table public.supplier_debt_cutovers from public, anon, authenticated;
grant select on table public.supplier_debt_cutovers to authenticated;
grant all on table public.supplier_debt_cutovers to service_role;

revoke all on table public.supplier_debt_marks from public, anon, authenticated;
grant select on table public.supplier_debt_marks to authenticated;
grant all on table public.supplier_debt_marks to service_role;

revoke all on table public.robot_order_packages from public, anon, authenticated;
grant select on table public.robot_order_packages to authenticated;
grant all on table public.robot_order_packages to service_role;

-- ===========================================================================
-- 3. get_item_purchase_facts: last supplier / price / unit / date per item and
--    a suggested reorder quantity (best-effort from the Q7 forecast).
-- ===========================================================================

create or replace function public.get_item_purchase_facts(p_item_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_forecast jsonb;
  v_item record;
  v_has_alias boolean;
  v_supplier uuid;
  v_supplier_name text;
  v_price numeric;
  v_unit text;
  v_doc_date date;
  v_result jsonb := '[]'::jsonb;
begin
  if coalesce(public.material_master_jwt_role(), '') <> 'service_role' then
    if v_actor is null then
      raise exception 'not_authenticated' using errcode = '42501';
    end if;
  end if;

  -- The forecast only supplies the suggested quantity. A denied / failed
  -- forecast call must never fail the whole read.
  begin
    v_forecast := public.get_q7_purchase_forecast(null, 14);
  exception when others then
    v_forecast := null;
  end;

  for v_item in
    select kii.id, kii.name, kii.unit
    from unnest(coalesce(p_item_ids, array[]::uuid[])) with ordinality as u(item_id, ord)
    join public.kitchen_inventory_items kii on kii.id = u.item_id
    order by u.ord
  loop
    v_supplier := null;
    v_supplier_name := null;
    v_price := null;
    v_unit := null;
    v_doc_date := null;

    v_has_alias := exists (
      select 1
      from public.stock_material_aliases a
      where a.kitchen_inventory_item_id = v_item.id
    );

    select x.supplier_id, x.unit_price, x.unit, x.doc_date
      into v_supplier, v_price, v_unit, v_doc_date
    from (
      -- (1) alias -> purchase order line
      select po.supplier_id, poi.unit_price, poi.unit,
             coalesce(po.order_date, po.created_at::date) as doc_date,
             po.created_at
      from public.stock_material_aliases a
      join public.purchase_order_items poi
        on public.normalize_stock_item_name(poi.product_name) = a.normalized_name
        or lower(unaccent(poi.product_name)) = a.normalized_name
      join public.purchase_orders po on po.id = poi.purchase_order_id
      where a.kitchen_inventory_item_id = v_item.id
        and po.status <> 'cancelled'
      union all
      -- (2) alias -> goods receipt line
      select gr.supplier_id, gi.unit_price, gi.unit,
             gr.receipt_date as doc_date,
             gr.created_at
      from public.stock_material_aliases a
      join public.goods_receipt_items gi
        on public.normalize_stock_item_name(coalesce(gi.raw_product_name, gi.product_name)) = a.normalized_name
        or lower(unaccent(coalesce(gi.raw_product_name, gi.product_name))) = a.normalized_name
      join public.goods_receipts gr on gr.id = gi.goods_receipt_id
      where a.kitchen_inventory_item_id = v_item.id
        and gr.status in ('confirmed', 'received')
      union all
      -- (3) direct name match, only when the item has no alias at all
      select po.supplier_id, poi.unit_price, poi.unit,
             coalesce(po.order_date, po.created_at::date) as doc_date,
             po.created_at
      from public.purchase_order_items poi
      join public.purchase_orders po on po.id = poi.purchase_order_id
      where not v_has_alias
        and lower(unaccent(poi.product_name)) = lower(unaccent(v_item.name))
        and po.status <> 'cancelled'
    ) x
    order by x.doc_date desc nulls last, x.created_at desc nulls last
    limit 1;

    if v_supplier is not null then
      select s.name into v_supplier_name
      from public.suppliers s
      where s.id = v_supplier;
    end if;

    v_result := v_result || jsonb_build_array(jsonb_build_object(
      'item_id', v_item.id,
      'item_name', v_item.name,
      'unit', v_item.unit,
      'last_supplier_id', v_supplier,
      'last_supplier_name', v_supplier_name,
      'last_unit_price', v_price,
      'last_unit', v_unit,
      'last_date', v_doc_date,
      'suggested_qty', case
        when v_forecast is null then null
        else (
          select (e ->> 'suggested_qty')::numeric
          from jsonb_array_elements(coalesce(v_forecast -> 'items', '[]'::jsonb)) e
          where e ->> 'item_id' = v_item.id::text
          limit 1
        )
      end
    ));
  end loop;

  return v_result;
end;
$$;

revoke all on function public.get_item_purchase_facts(uuid[]) from public, anon;
grant execute on function public.get_item_purchase_facts(uuid[]) to authenticated, service_role;

-- ===========================================================================
-- 4. get_supplier_debt_candidates: one supplier's unpaid payment requests plus
--    purchase orders that never had a non-rejected payment request, farthest
--    first, with marks and the before-cutover flag.
-- ===========================================================================

create or replace function public.get_supplier_debt_candidates(p_supplier_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_result jsonb;
begin
  if coalesce(public.material_master_jwt_role(), '') <> 'service_role' then
    if v_actor is null then
      raise exception 'not_authenticated' using errcode = '42501';
    end if;
  end if;

  if p_supplier_id is null then
    raise exception 'supplier_id_required' using errcode = '22023';
  end if;

  with cutover as (
    select
      c.start_date,
      case when c.payment_request_id is not null then 'pr' else 'po' end as kind,
      coalesce(c.payment_request_id, c.purchase_order_id) as doc_id,
      case
        when c.payment_request_id is not null then pr.created_at
        else po.created_at
      end as doc_created,
      case
        when c.payment_request_id is not null then pr.request_number
        else po.po_number
      end as number
    from public.supplier_debt_cutovers c
    left join public.payment_requests pr on pr.id = c.payment_request_id
    left join public.purchase_orders po on po.id = c.purchase_order_id
    where c.supplier_id = p_supplier_id
  ),
  pr_rows as (
    select
      'pr'::text as kind,
      pr.id,
      pr.request_number as number,
      pr.title,
      pr.created_at::date as doc_date,
      pr.created_at,
      coalesce(pr.total_amount, 0) as amount,
      coalesce(pr.total_amount, 0) - coalesce((
        select sum(pa.amount)
        from public.payment_allocations pa
        where pa.payment_request_id = pr.id
      ), 0) as remaining,
      pr.purchase_order_id,
      po.po_number,
      pr.goods_receipt_id,
      (
        select ps.submission_number
        from public.payment_submission_items psi
        join public.payment_submissions ps on ps.id = psi.submission_id
        where psi.payment_request_id = pr.id
        order by ps.created_at desc
        limit 1
      ) as last_submission_number,
      (
        pr.purchase_order_id is not null
        and exists (
          select 1
          from public.goods_receipts gr
          where gr.purchase_order_id = pr.purchase_order_id
            and gr.status in ('confirmed', 'received')
        )
      ) as has_receipt,
      m.mark,
      m.source as mark_source,
      m.probability
    from public.payment_requests pr
    left join public.purchase_orders po on po.id = pr.purchase_order_id
    left join public.supplier_debt_marks m on m.payment_request_id = pr.id
    where pr.supplier_id = p_supplier_id
      and pr.status in ('pending', 'approved')
      and pr.payment_status in ('unpaid', 'partial')
  ),
  po_rows as (
    select
      'po'::text as kind,
      po.id,
      po.po_number as number,
      null::text as title,
      coalesce(po.expected_date, po.order_date) as doc_date,
      po.created_at,
      coalesce(po.total_amount, 0) as amount,
      coalesce(po.total_amount, 0) as remaining,
      po.id as purchase_order_id,
      po.po_number,
      null::uuid as goods_receipt_id,
      null::text as last_submission_number,
      exists (
        select 1
        from public.goods_receipts gr
        where gr.purchase_order_id = po.id
          and gr.status in ('confirmed', 'received')
      ) as has_receipt,
      m.mark,
      m.source as mark_source,
      m.probability
    from public.purchase_orders po
    left join public.supplier_debt_marks m on m.purchase_order_id = po.id
    where po.supplier_id = p_supplier_id
      and po.status <> 'cancelled'
      and not exists (
        select 1
        from public.payment_requests pr2
        where pr2.purchase_order_id = po.id
          and pr2.status <> 'rejected'
      )
  ),
  all_rows as (
    select * from pr_rows
    union all
    select * from po_rows
  )
  select jsonb_build_object(
    'supplier_id', p_supplier_id,
    'cutover', (
      select jsonb_build_object(
        'kind', c.kind,
        'id', c.doc_id,
        'number', c.number,
        'start_date', c.start_date
      )
      from cutover c
      limit 1
    ),
    'stats', jsonb_build_object(
      'paid_90d', (
        select count(*)
        from public.payment_requests pr
        where pr.supplier_id = p_supplier_id
          and pr.payment_status = 'paid'
          and pr.created_at >= now() - interval '90 days'
      ),
      'median_lag_days', (
        select percentile_cont(0.5) within group (
          order by (pr.created_at::date - po.order_date)
        )
        from public.payment_requests pr
        join public.purchase_orders po on po.id = pr.purchase_order_id
        where pr.supplier_id = p_supplier_id
          and pr.payment_status = 'paid'
          and pr.created_at >= now() - interval '90 days'
      ),
      'last_paid_date', (
        select max(pr.created_at::date)
        from public.payment_requests pr
        where pr.supplier_id = p_supplier_id
          and pr.payment_status = 'paid'
      )
    ),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'kind', r.kind,
        'id', r.id,
        'number', r.number,
        'title', r.title,
        'doc_date', r.doc_date,
        'amount', r.amount,
        'remaining', r.remaining,
        'purchase_order_id', r.purchase_order_id,
        'po_number', r.po_number,
        'goods_receipt_id', r.goods_receipt_id,
        'last_submission_number', r.last_submission_number,
        'age_days', current_date - r.doc_date,
        'has_receipt', r.has_receipt,
        'mark', r.mark,
        'mark_source', r.mark_source,
        'probability', r.probability,
        'before_cutover', (
          c.start_date is not null
          and (
            r.doc_date < c.start_date
            or (r.doc_date = c.start_date and r.created_at < c.doc_created)
          )
        )
      ) order by r.doc_date asc, r.created_at asc)
      from all_rows r
      left join cutover c on true
    ), '[]'::jsonb)
  )
  into v_result;

  return v_result;
end;
$$;

revoke all on function public.get_supplier_debt_candidates(uuid) from public, anon;
grant execute on function public.get_supplier_debt_candidates(uuid) to authenticated, service_role;

-- ===========================================================================
-- 5. create_robot_order_package: draft PO(s) + the chosen old debt submitted
--    for payment + the supplier debt cutover + the learned settled_outside
--    marks, all in one transaction and idempotent by key.
-- ===========================================================================

create or replace function public.create_robot_order_package(
  p_lines jsonb,
  p_debt jsonb,
  p_note text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_is_service boolean := coalesce(public.material_master_jwt_role(), '') = 'service_role';
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_existing jsonb;
  v_line jsonb;
  v_line_supplier uuid;
  v_supplier uuid;
  v_po jsonb;
  v_po_ids uuid[] := '{}'::uuid[];
  v_po_numbers text[] := '{}'::text[];
  v_po_numbers_joined text;
  v_debt_kind text;
  v_debt_id uuid;
  v_debt_number text;
  v_debt_doc_date date;
  v_debt_note text;
  v_debt_po public.purchase_orders%rowtype;
  v_new_pr_id uuid;
  v_remaining numeric;
  v_sub jsonb;
  v_submission_id uuid;
  v_submission_number text;
  v_start_date date;
  v_package_id uuid := gen_random_uuid();
  v_marked integer := 0;
  v_result jsonb;
begin
  -- A JSON `null` debt (no old debt to pay) is the same as no debt.
  if p_debt is not null and jsonb_typeof(p_debt) = 'null' then
    p_debt := null;
  end if;

  -- Gate 1: authenticated material-inventory editor (service role trusted).
  if not v_is_service then
    if v_actor is null or not public.q7_material_inventory_can_edit(v_actor) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
    -- Gate 2: the debt submission needs the same right as create_payment_submission.
    if p_debt is not null and not (
      public.has_role(v_actor, 'owner')
      or public.has_module_permission(v_actor, 'payment_requests', 'edit')
    ) then
      raise exception 'forbidden' using errcode = '42501';
    end if;
  end if;

  if v_key is null then
    raise exception 'idempotency_key_required' using errcode = '22023';
  end if;

  select result into v_existing
  from public.robot_order_packages
  where idempotency_key = v_key;
  if found then
    return v_existing || jsonb_build_object('idempotent', true);
  end if;

  perform pg_advisory_xact_lock(hashtext('robot_order_package:' || v_key));

  select result into v_existing
  from public.robot_order_packages
  where idempotency_key = v_key;
  if found then
    return v_existing || jsonb_build_object('idempotent', true);
  end if;

  -- Validate the lines: a non-empty array, every field present and sane, and
  -- exactly one supplier per package.
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'lines_required' using errcode = '22023';
  end if;

  for v_line in select value from jsonb_array_elements(p_lines)
  loop
    if jsonb_typeof(v_line) is distinct from 'object'
       or nullif(btrim(coalesce(v_line ->> 'supplier_id', '')), '') is null
       or nullif(btrim(coalesce(v_line ->> 'product_name', '')), '') is null
       or nullif(btrim(coalesce(v_line ->> 'unit', '')), '') is null
       or jsonb_typeof(v_line -> 'quantity') is distinct from 'number'
       or (v_line ->> 'quantity')::numeric <= 0
       or jsonb_typeof(v_line -> 'unit_price') is distinct from 'number'
       or (v_line ->> 'unit_price')::numeric < 0
    then
      raise exception 'lines_invalid' using errcode = '22023';
    end if;

    v_line_supplier := (v_line ->> 'supplier_id')::uuid;
    if v_supplier is null then
      v_supplier := v_line_supplier;
    elsif v_line_supplier is distinct from v_supplier then
      raise exception 'one_supplier_per_package' using errcode = '22023';
    end if;
  end loop;

  if v_supplier is null then
    raise exception 'lines_invalid' using errcode = '22023';
  end if;

  -- Validate the chosen debt, when any: it must belong to the same supplier and
  -- still be payable under the same rules as get_supplier_debt_candidates.
  if p_debt is not null then
    if jsonb_typeof(p_debt) is distinct from 'object'
       or coalesce(p_debt ->> 'kind', '') not in ('pr', 'po')
       or nullif(btrim(coalesce(p_debt ->> 'id', '')), '') is null
    then
      raise exception 'debt_not_payable' using errcode = '22023';
    end if;

    v_debt_kind := p_debt ->> 'kind';
    v_debt_id := (p_debt ->> 'id')::uuid;

    if v_debt_kind = 'pr' then
      select pr.request_number,
             pr.created_at::date,
             coalesce(pr.total_amount, 0) - coalesce((
               select sum(pa.amount)
               from public.payment_allocations pa
               where pa.payment_request_id = pr.id
             ), 0)
        into v_debt_number, v_debt_doc_date, v_remaining
      from public.payment_requests pr
      where pr.id = v_debt_id
        and pr.supplier_id = v_supplier
        and pr.status in ('pending', 'approved')
        and pr.payment_status in ('unpaid', 'partial');
      if not found or v_remaining <= 0 then
        raise exception 'debt_not_payable' using errcode = '22023';
      end if;
    else
      select * into v_debt_po
      from public.purchase_orders po
      where po.id = v_debt_id
        and po.supplier_id = v_supplier
        and po.status <> 'cancelled'
        and not exists (
          select 1
          from public.payment_requests pr2
          where pr2.purchase_order_id = po.id
            and pr2.status <> 'rejected'
        );
      if not found then
        raise exception 'debt_not_payable' using errcode = '22023';
      end if;
      v_debt_number := v_debt_po.po_number;
      v_debt_doc_date := coalesce(v_debt_po.expected_date, v_debt_po.order_date);
    end if;
  end if;

  -- (a) draft purchase order(s) through the existing Q7 RPC.
  v_po := public.create_q7_draft_purchase_orders(p_lines, v_key || ':po');
  v_po_ids := array(
    select value::uuid
    from jsonb_array_elements_text(coalesce(v_po -> 'purchase_order_ids', '[]'::jsonb))
  );
  v_po_numbers := array(
    select po.po_number
    from public.purchase_orders po
    where po.id = any (v_po_ids)
    order by po.created_at asc, po.po_number asc
  );
  v_po_numbers_joined := array_to_string(v_po_numbers, ', ');

  -- (b) submit the chosen old debt for payment.
  v_debt_note := coalesce(p_note, '')
    || ' · 🤖 Robot đặt hàng: trả đơn cũ để NCC giao '
    || coalesce(v_po_numbers_joined, '');

  if v_debt_kind = 'pr' then
    v_sub := public.create_payment_submission(array[v_debt_id], v_debt_note, v_key || ':tc');
  elsif v_debt_kind = 'po' then
    -- No payment request exists for this old PO: create one (same shape the app
    -- uses) so the finance submission can snapshot it. The pending status makes
    -- trg_finance_zalo_payment_request_created enqueue the Zalo notice itself.
    v_new_pr_id := gen_random_uuid();
    insert into public.payment_requests (
      id, request_number, title, description, supplier_id, purchase_order_id,
      total_amount, vat_amount, status, payment_status, payment_type,
      payment_method, created_by
    ) values (
      v_new_pr_id,
      'PR-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8)),
      'Đề nghị chi - ' || v_debt_po.po_number,
      'Thanh toán công nợ cũ cho đơn hàng ' || v_debt_po.po_number,
      v_supplier,
      v_debt_id,
      coalesce(v_debt_po.total_amount, 0),
      coalesce(v_debt_po.vat_amount, 0),
      'pending',
      'unpaid',
      'old_order',
      'bank_transfer',
      v_actor
    );

    insert into public.payment_request_items (
      payment_request_id, product_name, quantity, unit, unit_price, line_total
    )
    select
      v_new_pr_id,
      poi.product_name,
      coalesce(poi.quantity, 0),
      poi.unit,
      coalesce(poi.unit_price, 0),
      round(coalesce(poi.quantity, 0) * coalesce(poi.unit_price, 0), 2)
    from public.purchase_order_items poi
    where poi.purchase_order_id = v_debt_id;

    v_sub := public.create_payment_submission(array[v_new_pr_id], v_debt_note, v_key || ':tc');
  end if;

  if v_sub is not null then
    v_submission_id := nullif(v_sub ->> 'submission_id', '')::uuid;
    v_submission_number := v_sub ->> 'submission_number';
  end if;

  -- (c) learn the cutover and mark the older still-unpaid documents as settled
  -- outside. An existing 'manual' mark is never overwritten; a 'jev' mark is
  -- upgraded to 'learned'.
  if v_debt_kind is not null then
    v_start_date := v_debt_doc_date;

    insert into public.supplier_debt_cutovers (
      supplier_id, payment_request_id, purchase_order_id, start_date,
      learned_from_package_id, updated_by, updated_at
    ) values (
      v_supplier,
      case when v_debt_kind = 'pr' then v_debt_id else null end,
      case when v_debt_kind = 'po' then v_debt_id else null end,
      v_start_date,
      v_package_id,
      v_actor,
      now()
    )
    on conflict (supplier_id) do update set
      payment_request_id = excluded.payment_request_id,
      purchase_order_id = excluded.purchase_order_id,
      start_date = excluded.start_date,
      learned_from_package_id = excluded.learned_from_package_id,
      updated_by = excluded.updated_by,
      updated_at = now();

    with candidates as (
      select 'pr'::text as kind, pr.id, pr.created_at::date as doc_date, pr.created_at
      from public.payment_requests pr
      where pr.supplier_id = v_supplier
        and pr.status in ('pending', 'approved')
        and pr.payment_status in ('unpaid', 'partial')
      union all
      select 'po'::text as kind, po.id,
             coalesce(po.expected_date, po.order_date) as doc_date, po.created_at
      from public.purchase_orders po
      where po.supplier_id = v_supplier
        and po.status <> 'cancelled'
        and not exists (
          select 1
          from public.payment_requests pr2
          where pr2.purchase_order_id = po.id
            and pr2.status <> 'rejected'
        )
    )
    insert into public.supplier_debt_marks (
      supplier_id, payment_request_id, purchase_order_id, mark, source, note, created_by
    )
    select
      v_supplier,
      case when c.kind = 'pr' then c.id else null end,
      case when c.kind = 'po' then c.id else null end,
      'settled_outside',
      'learned',
      'Học từ lựa chọn robot ' || v_package_id::text,
      v_actor
    from candidates c
    where c.doc_date < v_start_date
    on conflict (coalesce(payment_request_id, purchase_order_id)) do update
      set mark = 'settled_outside',
          source = 'learned',
          probability = null,
          note = excluded.note,
          created_by = excluded.created_by,
          created_at = now()
      where supplier_debt_marks.source = 'jev';
    get diagnostics v_marked = row_count;
  end if;

  -- (d) record the package and return its stored result.
  v_result := jsonb_build_object(
    'package_id', v_package_id,
    'purchase_order_ids', to_jsonb(v_po_ids),
    'po_numbers', to_jsonb(v_po_numbers),
    'debt', case when v_debt_kind is null then null else jsonb_build_object(
      'kind', v_debt_kind,
      'id', v_debt_id,
      'number', v_debt_number,
      'submission_id', v_submission_id,
      'submission_number', v_submission_number
    ) end,
    'cutover_start_date', v_start_date,
    'marked_settled_outside_count', v_marked,
    'idempotent', false
  );

  insert into public.robot_order_packages (
    id, idempotency_key, supplier_id, purchase_order_ids, debt_kind,
    debt_payment_request_id, debt_purchase_order_id, submission_id,
    note, result, created_by
  ) values (
    v_package_id,
    v_key,
    v_supplier,
    v_po_ids,
    v_debt_kind,
    case when v_debt_kind = 'pr' then v_debt_id else null end,
    case when v_debt_kind = 'po' then v_debt_id else null end,
    v_submission_id,
    nullif(btrim(coalesce(p_note, '')), ''),
    v_result,
    v_actor
  );

  return v_result;
end;
$$;

revoke all on function public.create_robot_order_package(jsonb, jsonb, text, text) from public, anon;
grant execute on function public.create_robot_order_package(jsonb, jsonb, text, text) to authenticated, service_role;

-- ===========================================================================
-- 6. Manual and Jev mark writers
-- ===========================================================================

create or replace function public.set_supplier_debt_mark(
  p_kind text,
  p_id uuid,
  p_mark text,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_is_service boolean := coalesce(public.material_master_jwt_role(), '') = 'service_role';
  v_supplier uuid;
  v_row public.supplier_debt_marks%rowtype;
begin
  if not v_is_service and not (
    public.has_role(v_actor, 'owner')
    or public.has_module_permission(v_actor, 'payment_requests', 'edit')
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_kind not in ('pr', 'po') then
    raise exception 'invalid_kind' using errcode = '22023';
  end if;
  if p_mark not in ('settled_outside', 'real_debt', 'unsure') then
    raise exception 'invalid_mark' using errcode = '22023';
  end if;
  if p_id is null then
    raise exception 'invalid_id' using errcode = '22023';
  end if;

  if p_kind = 'pr' then
    select pr.supplier_id into v_supplier
    from public.payment_requests pr where pr.id = p_id;
    if not found then
      raise exception 'document_not_found' using errcode = 'P0002';
    end if;
  else
    select po.supplier_id into v_supplier
    from public.purchase_orders po where po.id = p_id;
    if not found then
      raise exception 'document_not_found' using errcode = 'P0002';
    end if;
  end if;

  insert into public.supplier_debt_marks as m (
    supplier_id, payment_request_id, purchase_order_id, mark, source,
    probability, note, created_by
  ) values (
    v_supplier,
    case when p_kind = 'pr' then p_id else null end,
    case when p_kind = 'po' then p_id else null end,
    p_mark,
    'manual',
    null,
    nullif(btrim(coalesce(p_note, '')), ''),
    v_actor
  )
  on conflict (coalesce(payment_request_id, purchase_order_id)) do update
    set mark = excluded.mark,
        source = 'manual',
        probability = null,
        note = excluded.note,
        created_by = excluded.created_by,
        created_at = now()
  returning m.* into v_row;

  return to_jsonb(v_row);
end;
$$;

create or replace function public.set_supplier_debt_mark_ai(
  p_supplier_id uuid,
  p_rows jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row jsonb;
  v_kind text;
  v_id uuid;
  v_mark text;
  v_probability numeric;
begin
  if coalesce(public.material_master_jwt_role(), '') <> 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_supplier_id is null then
    raise exception 'supplier_id_required' using errcode = '22023';
  end if;
  if jsonb_typeof(p_rows) is distinct from 'array' then
    raise exception 'rows_required' using errcode = '22023';
  end if;

  for v_row in select value from jsonb_array_elements(p_rows)
  loop
    v_kind := v_row ->> 'kind';
    v_mark := v_row ->> 'mark';
    v_id := nullif(v_row ->> 'id', '')::uuid;
    v_probability := case
      when jsonb_typeof(v_row -> 'probability') = 'number'
        then (v_row ->> 'probability')::numeric
      else null
    end;

    if v_kind not in ('pr', 'po')
       or v_mark not in ('settled_outside', 'real_debt', 'unsure')
       or v_id is null
    then
      raise exception 'invalid_row' using errcode = '22023';
    end if;
    if v_probability is not null and (v_probability < 0 or v_probability > 1) then
      raise exception 'invalid_probability' using errcode = '22023';
    end if;

    insert into public.supplier_debt_marks (
      supplier_id, payment_request_id, purchase_order_id, mark, source,
      probability, note, created_by
    ) values (
      p_supplier_id,
      case when v_kind = 'pr' then v_id else null end,
      case when v_kind = 'po' then v_id else null end,
      v_mark,
      'jev',
      v_probability,
      null,
      null
    )
    on conflict (coalesce(payment_request_id, purchase_order_id)) do update
      set mark = excluded.mark,
          probability = excluded.probability,
          note = excluded.note,
          created_at = now()
      where supplier_debt_marks.source = 'jev';
  end loop;
end;
$$;

revoke all on function public.set_supplier_debt_mark(text, uuid, text, text) from public, anon;
grant execute on function public.set_supplier_debt_mark(text, uuid, text, text) to authenticated, service_role;

revoke all on function public.set_supplier_debt_mark_ai(uuid, jsonb) from public, anon, authenticated;
grant execute on function public.set_supplier_debt_mark_ai(uuid, jsonb) to service_role;
