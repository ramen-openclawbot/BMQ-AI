-- Robot đặt hàng NVL — chọn nhiều phiếu cũ, một đề nghị chi, lưu lịch sử để tự học.
--
-- Additive only. This migration replaces public.create_robot_order_package so
-- p_debt accepts either the legacy single {kind,id} object or a JSON array of up
-- to 20 {kind,id} items, submits every pick through ONE
-- create_payment_submission call (one TC number, one Zalo notice), writes one
-- append-only learning row per package that picked debt, and adds a read RPC for
-- the supplier's historical pick pattern (phase-2 suggestions).
--
-- Dependencies reused (never rewritten here):
--   * public.create_q7_draft_purchase_orders(jsonb, text)   — draft PO groups.
--   * public.create_payment_submission — one TC submission (uuid[], text, text).
--   * public.get_supplier_debt_candidates(uuid)             — candidate order
--     and the per-document payability rules.
--   * public.supplier_debt_cutovers / public.supplier_debt_marks /
--     public.robot_order_packages from 20261101170000_robot_order_desk.sql.
--
-- This migration never updates or removes an existing payment request or
-- purchase order row; the robot only creates its own drafts, pending requests
-- and marks.

-- ===========================================================================
-- 1. Learning history table
-- ===========================================================================

create table if not exists public.supplier_debt_pick_history (
  id uuid primary key default gen_random_uuid(),
  package_id uuid not null unique references public.robot_order_packages(id) on delete cascade,
  supplier_id uuid not null,
  candidate_count int not null,
  picked_count int not null check (picked_count >= 1),
  picked jsonb not null,
  picked_total numeric not null,
  skipped_older_count int not null,
  created_by uuid,
  created_at timestamptz default now()
);

create index if not exists idx_supplier_debt_pick_history_supplier
  on public.supplier_debt_pick_history (supplier_id, created_at desc);

-- ===========================================================================
-- 2. RLS and grants (writes only through the RPC)
-- ===========================================================================

alter table public.supplier_debt_pick_history enable row level security;

drop policy if exists supplier_debt_pick_history_select on public.supplier_debt_pick_history;
create policy supplier_debt_pick_history_select on public.supplier_debt_pick_history
  for select to authenticated using (true);

revoke all on table public.supplier_debt_pick_history from public, anon, authenticated;
grant select on table public.supplier_debt_pick_history to authenticated;
grant all on table public.supplier_debt_pick_history to service_role;

-- ===========================================================================
-- 3. create_robot_order_package: draft PO(s) + every chosen old debt submitted
--    together + the supplier debt cutover + the learned settled_outside marks +
--    one learning-history row, all in one transaction and idempotent by key.
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
  v_candidates jsonb := '[]'::jsonb;
  v_candidate_count integer := 0;
  v_pick jsonb;
  v_pick_kind text;
  v_pick_id uuid;
  v_pick_number text;
  v_pick_doc_date date;
  v_pick_remaining numeric;
  v_pick_rank integer;
  v_max_rank integer;
  v_pr_id uuid;
  v_pr_ids uuid[] := '{}'::uuid[];
  v_picks jsonb := '[]'::jsonb;
  v_picked_total numeric := 0;
  v_skipped_count integer := 0;
  v_debt_count integer := 0;
  v_debt_note text;
  v_debt_po public.purchase_orders%rowtype;
  v_new_pr_id uuid;
  v_cutover_kind text;
  v_cutover_id uuid;
  v_cutover_number text;
  v_cutover_doc_date date;
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

  -- Normalise the debt: the legacy single {kind,id} object is wrapped as a
  -- one-element array, a JSON array is taken as-is, and an empty array means
  -- "no debt".
  if p_debt is not null then
    if jsonb_typeof(p_debt) = 'object' then
      p_debt := jsonb_build_array(p_debt);
    elsif jsonb_typeof(p_debt) is distinct from 'array' then
      raise exception 'debt_invalid' using errcode = '22023';
    end if;

    v_debt_count := jsonb_array_length(p_debt);
    if v_debt_count > 20 then
      raise exception 'debt_too_many' using errcode = '22023';
    end if;
    if v_debt_count = 0 then
      p_debt := null;
    end if;
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

  -- Validate the shape of every picked document. Payability and supplier
  -- ownership are checked below against get_supplier_debt_candidates.
  if p_debt is not null then
    for v_pick in select value from jsonb_array_elements(p_debt)
    loop
      if jsonb_typeof(v_pick) is distinct from 'object'
         or coalesce(v_pick ->> 'kind', '') not in ('pr', 'po')
         or nullif(btrim(coalesce(v_pick ->> 'id', '')), '') is null
      then
        raise exception 'debt_invalid' using errcode = '22023';
      end if;
    end loop;

    if exists (
      select 1
      from jsonb_array_elements(p_debt) e
      group by e.value ->> 'id'
      having count(*) > 1
    ) then
      raise exception 'debt_duplicate' using errcode = '22023';
    end if;

    -- Snapshot the candidate list BEFORE any draft PO / pending PR is written:
    -- this is exactly the farthest-first order the operator saw in the picker,
    -- and it is where rank / candidate_count / skipped_older_count come from.
    v_candidates := coalesce(public.get_supplier_debt_candidates(v_supplier) -> 'rows', '[]'::jsonb);
    v_candidate_count := jsonb_array_length(v_candidates);
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

  -- (b) submit every chosen old debt together, once.
  v_debt_note := coalesce(p_note, '')
    || ' · 🤖 Robot đặt hàng: trả đơn cũ để NCC giao '
    || coalesce(v_po_numbers_joined, '');

  if p_debt is not null then
    for v_pick in select value from jsonb_array_elements(p_debt)
    loop
      v_pick_kind := v_pick ->> 'kind';
      v_pick_id := (v_pick ->> 'id')::uuid;
      v_pick_number := null;
      v_pick_doc_date := null;
      v_pick_remaining := 0;
      v_pick_rank := null;

      select c.value ->> 'number',
             (c.value ->> 'doc_date')::date,
             coalesce((c.value ->> 'remaining')::numeric, 0),
             c.ordinality::integer
        into v_pick_number, v_pick_doc_date, v_pick_remaining, v_pick_rank
      from jsonb_array_elements(v_candidates) with ordinality as c(value, ordinality)
      where c.value ->> 'kind' = v_pick_kind
        and c.value ->> 'id' = v_pick_id::text
      limit 1;

      if v_pick_rank is null then
        raise exception 'debt_not_payable' using errcode = '22023';
      end if;
      if v_pick_kind = 'pr' and v_pick_remaining <= 0 then
        raise exception 'debt_not_payable' using errcode = '22023';
      end if;

      if v_pick_kind = 'po' then
        select * into v_debt_po
        from public.purchase_orders po
        where po.id = v_pick_id
          and po.supplier_id = v_supplier
          and po.status <> 'cancelled';
        if not found then
          raise exception 'debt_not_payable' using errcode = '22023';
        end if;

        -- No payment request exists for this old PO: create one (same shape the
        -- app uses) so the finance submission can snapshot it. The pending
        -- status makes trg_finance_zalo_payment_request_created enqueue the Zalo
        -- notice itself.
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
          v_pick_id,
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
        where poi.purchase_order_id = v_pick_id;

        v_pr_id := v_new_pr_id;
      else
        v_pr_id := v_pick_id;
      end if;

      v_pr_ids := v_pr_ids || v_pr_id;
      v_picked_total := v_picked_total + v_pick_remaining;
      v_picks := v_picks || jsonb_build_array(jsonb_build_object(
        'kind', v_pick_kind,
        'id', v_pick_id,
        'number', v_pick_number,
        'doc_date', v_pick_doc_date,
        'remaining', v_pick_remaining,
        'rank', v_pick_rank
      ));
      if v_max_rank is null or v_pick_rank > v_max_rank then
        v_max_rank := v_pick_rank;
      end if;
    end loop;

    -- The learned cutover is the OLDEST picked document (min doc_date, tie ->
    -- smallest id), exactly like the old single-pick cutover.
    select p.value ->> 'kind',
           (p.value ->> 'id')::uuid,
           p.value ->> 'number',
           (p.value ->> 'doc_date')::date
      into v_cutover_kind, v_cutover_id, v_cutover_number, v_cutover_doc_date
    from jsonb_array_elements(v_picks) p
    order by (p.value ->> 'doc_date')::date asc, (p.value ->> 'id')::uuid asc
    limit 1;

    v_start_date := v_cutover_doc_date;

    -- Candidates the operator skipped even though they sat farther than the
    -- newest pick in the farthest-first order.
    select count(*)
      into v_skipped_count
    from jsonb_array_elements(v_candidates) with ordinality as c(value, ordinality)
    where c.ordinality::integer < v_max_rank
      and not exists (
        select 1
        from jsonb_array_elements(v_picks) p
        where p.value ->> 'kind' = c.value ->> 'kind'
          and p.value ->> 'id' = c.value ->> 'id'
      );

    v_sub := public.create_payment_submission(v_pr_ids, v_debt_note, v_key || ':tc');
  end if;

  if v_sub is not null then
    v_submission_id := nullif(v_sub ->> 'submission_id', '')::uuid;
    v_submission_number := v_sub ->> 'submission_number';
  end if;

  -- (c) learn the cutover and mark the older still-unpaid documents as settled
  -- outside. An existing 'manual' mark is never overwritten; a 'jev' mark is
  -- upgraded to 'learned'. The picked documents are never older than the
  -- cutover, so they are never marked.
  if p_debt is not null then
    insert into public.supplier_debt_cutovers (
      supplier_id, payment_request_id, purchase_order_id, start_date,
      learned_from_package_id, updated_by, updated_at
    ) values (
      v_supplier,
      case when v_cutover_kind = 'pr' then v_cutover_id else null end,
      case when v_cutover_kind = 'po' then v_cutover_id else null end,
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
    'debt', case when p_debt is null then null else jsonb_build_object(
      'kind', v_cutover_kind,
      'id', v_cutover_id,
      'number', v_cutover_number,
      'submission_id', v_submission_id,
      'submission_number', v_submission_number
    ) end,
    'debt_picks', v_picks,
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
    v_cutover_kind,
    case when v_cutover_kind = 'pr' then v_cutover_id else null end,
    case when v_cutover_kind = 'po' then v_cutover_id else null end,
    v_submission_id,
    nullif(btrim(coalesce(p_note, '')), ''),
    v_result,
    v_actor
  );

  -- (e) one append-only learning row per package that picked debt. It is
  -- written after the submission succeeds and never on the idempotent replay
  -- path (that returns above).
  if p_debt is not null then
    insert into public.supplier_debt_pick_history (
      package_id, supplier_id, candidate_count, picked_count, picked,
      picked_total, skipped_older_count, created_by
    ) values (
      v_package_id,
      v_supplier,
      v_candidate_count,
      v_debt_count,
      v_picks,
      v_picked_total,
      v_skipped_count,
      v_actor
    )
    on conflict (package_id) do nothing;
  end if;

  return v_result;
end;
$$;

revoke all on function public.create_robot_order_package(jsonb, jsonb, text, text) from public, anon;
grant execute on function public.create_robot_order_package(jsonb, jsonb, text, text) to authenticated, service_role;

-- ===========================================================================
-- 4. get_supplier_debt_pick_pattern: how one supplier's debt picks look, for
--    phase-2 suggestions.
-- ===========================================================================

create or replace function public.get_supplier_debt_pick_pattern(p_supplier_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_packages integer;
begin
  if coalesce(public.material_master_jwt_role(), '') <> 'service_role' then
    if v_actor is null then
      raise exception 'not_authenticated' using errcode = '42501';
    end if;
  end if;

  if p_supplier_id is null then
    raise exception 'supplier_id_required' using errcode = '22023';
  end if;

  select count(*)
    into v_packages
  from public.supplier_debt_pick_history h
  where h.supplier_id = p_supplier_id;

  if v_packages = 0 then
    return jsonb_build_object(
      'supplier_id', p_supplier_id,
      'packages', 0,
      'last_picked_count', null,
      'median_picked_count', null,
      'avg_picked_total', null,
      'oldest_first_share', null,
      'last_picked_at', null
    );
  end if;

  return jsonb_build_object(
    'supplier_id', p_supplier_id,
    'packages', v_packages,
    'last_picked_count', (
      select h.picked_count
      from public.supplier_debt_pick_history h
      where h.supplier_id = p_supplier_id
      order by h.created_at desc nulls last, h.id desc
      limit 1
    ),
    'median_picked_count', (
      select percentile_cont(0.5) within group (order by h.picked_count)
      from public.supplier_debt_pick_history h
      where h.supplier_id = p_supplier_id
    ),
    'avg_picked_total', (
      select avg(h.picked_total)
      from public.supplier_debt_pick_history h
      where h.supplier_id = p_supplier_id
    ),
    -- Share of packages whose picked ranks were exactly 1..picked_count
    -- (i.e. the operator took the farthest documents in order).
    'oldest_first_share', (
      select avg(case
        when (
          select max((e ->> 'rank')::integer)
          from jsonb_array_elements(h.picked) e
        ) = h.picked_count
        and (
          select count(distinct (e ->> 'rank')::integer)
          from jsonb_array_elements(h.picked) e
        ) = h.picked_count
        then 1.0 else 0.0
      end)
      from public.supplier_debt_pick_history h
      where h.supplier_id = p_supplier_id
    ),
    'last_picked_at', (
      select max(h.created_at)
      from public.supplier_debt_pick_history h
      where h.supplier_id = p_supplier_id
    )
  );
end;
$$;

revoke all on function public.get_supplier_debt_pick_pattern(uuid) from public, anon;
grant execute on function public.get_supplier_debt_pick_pattern(uuid) to authenticated, service_role;
