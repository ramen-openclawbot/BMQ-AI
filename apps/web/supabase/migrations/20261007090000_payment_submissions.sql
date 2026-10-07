-- Giai đoạn "Trình chi gấp" (backend) — phiếu trình chi gấp + tin Zalo cho CEO.
--
-- Additive only. This migration:
--   (a) adds payment_submissions / payment_submission_items (a snapshot of the
--       unpaid remaining amount at submit time) with owner-or-view RLS and no
--       direct client writes,
--   (b) adds create_payment_submission (owner or payment_requests edit) and
--       get_payment_submission (owner or payment_requests view),
--   (c) enqueues one finance Zalo outbox row per submission
--       (event 'payment_submission_created') and extends the event check,
--   (d) re-declares public.approve_payment_requests_with_unc(uuid[], jsonb, text)
--       with the SAME signature/behaviour as 20261006140000 plus the optional
--       evidence payment_method ('bank_transfer' | 'cash').
--
-- It redefines no other function, schedules no cron job, and never edits an
-- earlier migration.

-- ---------------------------------------------------------------------------
-- 1. Trình chi gấp: submission header + snapshot items.
-- ---------------------------------------------------------------------------
create table if not exists public.payment_submissions (
  id uuid primary key default gen_random_uuid(),
  submission_number text not null,
  note text,
  total_amount numeric not null default 0,
  created_by uuid default auth.uid(),
  created_at timestamptz not null default now(),
  constraint payment_submissions_number_key unique (submission_number),
  constraint payment_submissions_number_format_check
    check (submission_number ~ '^TC-[0-9]{6}-[0-9]+$'),
  constraint payment_submissions_total_non_negative check (total_amount >= 0)
);

create index if not exists idx_payment_submissions_created_at
  on public.payment_submissions (created_at desc);

create table if not exists public.payment_submission_items (
  submission_id uuid not null references public.payment_submissions(id) on delete cascade,
  payment_request_id uuid not null references public.payment_requests(id),
  remaining_at_submit numeric not null,
  position integer not null,
  constraint payment_submission_items_submission_request_key
    unique (submission_id, payment_request_id),
  constraint payment_submission_items_position_key unique (submission_id, position),
  constraint payment_submission_items_remaining_positive check (remaining_at_submit > 0),
  constraint payment_submission_items_position_positive check (position > 0)
);

create index if not exists idx_payment_submission_items_request
  on public.payment_submission_items (payment_request_id);

alter table public.payment_submissions enable row level security;
alter table public.payment_submission_items enable row level security;

-- Written only through the SECURITY DEFINER RPCs; clients may read (owner or
-- payment_requests view) and can never insert/update/delete directly.
revoke all on public.payment_submissions from public, anon, authenticated;
revoke all on public.payment_submission_items from public, anon, authenticated;
grant select on public.payment_submissions to authenticated;
grant select on public.payment_submission_items to authenticated;

drop policy if exists payment_submissions_view_select on public.payment_submissions;
create policy payment_submissions_view_select
  on public.payment_submissions
  for select
  to authenticated
  using (
    public.has_role(auth.uid(), 'owner')
    or public.has_module_permission(auth.uid(), 'payment_requests', 'view')
  );

drop policy if exists payment_submission_items_view_select on public.payment_submission_items;
create policy payment_submission_items_view_select
  on public.payment_submission_items
  for select
  to authenticated
  using (
    public.has_role(auth.uid(), 'owner')
    or public.has_module_permission(auth.uid(), 'payment_requests', 'view')
  );

-- Server-side idempotency ledger for create_payment_submission (never exposed).
create table if not exists public.payment_submission_idempotency (
  idempotency_key text primary key,
  submission_id uuid not null references public.payment_submissions(id) on delete cascade,
  result jsonb not null,
  created_by uuid,
  created_at timestamptz not null default now()
);

alter table public.payment_submission_idempotency enable row level security;
revoke all on public.payment_submission_idempotency from public, anon, authenticated;
grant all on public.payment_submission_idempotency to service_role;

-- ---------------------------------------------------------------------------
-- 2. create_payment_submission: snapshot unpaid remaining for 1..50 requests,
--    idempotent by key, and enqueue one finance Zalo notice.
-- ---------------------------------------------------------------------------
create or replace function public.create_payment_submission(
  p_request_ids uuid[],
  p_note text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_is_service boolean := coalesce(public.material_master_jwt_role(), '') = 'service_role';
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_ids uuid[];
  v_prior jsonb;
  v_day text;
  v_seq integer;
  v_number text;
  v_submission_id uuid;
  v_total numeric := 0;
  v_item_count integer := 0;
  v_pr record;
  v_remaining numeric;
  v_items jsonb := '[]'::jsonb;
  v_lines text[];
  v_shown text[];
  v_message_lines text[];
  v_message text;
  v_result jsonb;
begin
  -- Owner or explicit payment_requests edit permission (service_role for trusted
  -- automation). Anything else fails closed.
  if not v_is_service then
    if v_actor is null then
      raise exception 'not_owner' using errcode = '42501';
    end if;
  end if;
  if not (
    v_is_service
    or public.has_role(v_actor, 'owner')
    or public.has_module_permission(v_actor, 'payment_requests', 'edit')
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if v_key is null then
    raise exception 'idempotency_key_required' using errcode = '22023';
  end if;
  if p_request_ids is null or array_length(p_request_ids, 1) is null then
    raise exception 'request_ids_required' using errcode = '22023';
  end if;
  if array_length(p_request_ids, 1) > 50 then
    raise exception 'too_many_requests' using errcode = '22023';
  end if;

  -- Deduplicate while preserving the caller's selection order.
  select array_agg(id order by ord)
    into v_ids
  from (
    select distinct on (u.id) u.id, u.ord
    from unnest(p_request_ids) with ordinality as u(id, ord)
    order by u.id, u.ord
  ) dedup;

  if v_ids is null or coalesce(array_length(v_ids, 1), 0) = 0 then
    raise exception 'request_ids_required' using errcode = '22023';
  end if;

  -- Idempotent replay by key (checked before and after the advisory lock).
  select result into v_prior
  from public.payment_submission_idempotency
  where idempotency_key = v_key;
  if found then
    return v_prior || jsonb_build_object('idempotent', true);
  end if;

  perform pg_advisory_xact_lock(hashtext('payment_submission:' || v_key));

  select result into v_prior
  from public.payment_submission_idempotency
  where idempotency_key = v_key;
  if found then
    return v_prior || jsonb_build_object('idempotent', true);
  end if;

  -- Lock the requests in a stable order so two submissions cannot snapshot a
  -- half-written payment state.
  perform 1
  from public.payment_requests pr
  where pr.id = any(v_ids)
  order by pr.id
  for update of pr;

  if exists (
    select 1
    from unnest(v_ids) as rid(id)
    where not exists (select 1 from public.payment_requests pr where pr.id = rid.id)
  ) then
    raise exception 'request_not_found' using errcode = 'P0002';
  end if;

  -- Positions follow the order the accountant selected the requests.
  for v_pr in
    select * from public.payment_requests pr
    where pr.id = any(v_ids)
    order by array_position(v_ids, pr.id)
  loop
    if v_pr.status::text not in ('pending', 'approved') then
      raise exception 'not_payable' using errcode = 'P0001',
        detail = format('request_number=%s status=%s', v_pr.request_number, v_pr.status);
    end if;
    if v_pr.payment_status::text not in ('unpaid', 'partial') then
      raise exception 'not_payable' using errcode = 'P0001',
        detail = format('request_number=%s payment_status=%s', v_pr.request_number, v_pr.payment_status);
    end if;

    v_remaining := coalesce(v_pr.total_amount, 0) - coalesce((
      select sum(pa.amount)
      from public.payment_allocations pa
      where pa.payment_request_id = v_pr.id
    ), 0);
    if v_remaining <= 0 then
      raise exception 'not_payable' using errcode = 'P0001',
        detail = format('request_number=%s remaining=%s', v_pr.request_number, v_remaining);
    end if;

    v_item_count := v_item_count + 1;
    v_total := v_total + v_remaining;
    v_items := v_items || jsonb_build_array(jsonb_build_object(
      'payment_request_id', v_pr.id,
      'remaining_at_submit', v_remaining,
      'position', v_item_count
    ));
  end loop;

  if v_item_count = 0 then
    raise exception 'request_ids_required' using errcode = '22023';
  end if;

  -- Per-day sequence TC-YYMMDD-NN in Asia/Ho_Chi_Minh under an advisory lock.
  v_day := to_char((now() at time zone 'Asia/Ho_Chi_Minh'), 'YYMMDD');
  perform pg_advisory_xact_lock(hashtext('payment_submission_number:' || v_day));

  select count(*) + 1 into v_seq
  from public.payment_submissions
  where submission_number like 'TC-' || v_day || '-%';

  v_number := 'TC-' || v_day || '-' || lpad(v_seq::text, 2, '0');

  insert into public.payment_submissions (submission_number, note, total_amount, created_by)
  values (v_number, v_note, v_total, v_actor)
  returning id into v_submission_id;

  insert into public.payment_submission_items (
    submission_id, payment_request_id, remaining_at_submit, position
  )
  select v_submission_id,
         (item->>'payment_request_id')::uuid,
         (item->>'remaining_at_submit')::numeric,
         (item->>'position')::integer
  from jsonb_array_elements(v_items) item;

  -- Finance Zalo outbox: one notice per submission, idempotent by (event, entity).
  -- The body mirrors the shared TypeScript formatter.
  select array_agg(line order by position)
    into v_lines
  from (
    select i.position,
           format(
             '• %s – %s: %s',
             coalesce(s.name, 'Chưa xác định'),
             pr.request_number,
             public.finance_format_vnd(i.remaining_at_submit)
           ) as line
    from public.payment_submission_items i
    join public.payment_requests pr on pr.id = i.payment_request_id
    left join public.suppliers s on s.id = pr.supplier_id
    where i.submission_id = v_submission_id
  ) lines;

  v_shown := v_lines[1:5];
  v_message_lines := array[
    '📋 TRÌNH CHI GẤP ' || v_number,
    v_item_count::text || ' phiếu · Tổng ' || public.finance_format_vnd(v_total)
  ];
  if v_shown is not null then
    v_message_lines := v_message_lines || v_shown;
  end if;
  if v_item_count > 5 then
    v_message_lines := v_message_lines || ('… và ' || (v_item_count - 5)::text || ' phiếu khác');
  end if;
  if v_note is not null then
    v_message_lines := v_message_lines || v_note;
  end if;
  v_message_lines := v_message_lines || array[
    '',
    'https://ai.banhmique.vn/payment-requests/submissions/' || v_submission_id::text
  ];
  v_message := array_to_string(v_message_lines, E'\n');

  insert into public.finance_zalo_notifications (event_type, entity_id, group_key, message_body, status)
  values ('payment_submission_created', v_submission_id, 'finance', v_message, 'pending')
  on conflict (event_type, entity_id) do nothing;

  v_result := jsonb_build_object(
    'status', 'created',
    'submission_id', v_submission_id,
    'submission_number', v_number,
    'note', v_note,
    'total_amount', v_total,
    'item_count', v_item_count,
    'items', v_items,
    'idempotent', false
  );

  insert into public.payment_submission_idempotency (idempotency_key, submission_id, result, created_by)
  values (v_key, v_submission_id, v_result, v_actor)
  on conflict (idempotency_key) do nothing;

  return v_result;
end;
$$;

revoke all on function public.create_payment_submission(uuid[], text, text) from public, anon;
grant execute on function public.create_payment_submission(uuid[], text, text) to authenticated, service_role;

comment on function public.create_payment_submission(uuid[], text, text) is 'Owner / payment_requests edit: snapshot the unpaid remaining of 1..50 pending-or-approved unpaid/partial requests into a TC-YYMMDD-NN submission, idempotent by key, and enqueue one finance Zalo payment_submission_created notice.';

-- ---------------------------------------------------------------------------
-- 3. get_payment_submission: header + snapshot items enriched with live request
--    data for the submission detail page.
-- ---------------------------------------------------------------------------
create or replace function public.get_payment_submission(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_result jsonb;
begin
  -- Access: owner, or an explicit payment_requests view permission. Anon and any
  -- other authenticated user get insufficient_privilege (42501). Trusted
  -- service-role automation is also allowed.
  if not (
    (
      v_uid is not null
      and (
        public.has_role(v_uid, 'owner')
        or public.has_module_permission(v_uid, 'payment_requests', 'view')
      )
    )
    or public.material_master_jwt_role() = 'service_role'
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'id', s.id,
    'submission_number', s.submission_number,
    'note', s.note,
    'total_amount', s.total_amount,
    'created_by', s.created_by,
    'created_at', s.created_at,
    'items', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'payment_request_id', i.payment_request_id,
          'position', i.position,
          'remaining_at_submit', i.remaining_at_submit,
          'request_number', pr.request_number,
          'title', pr.title,
          'supplier_id', pr.supplier_id,
          'supplier_name', s2.name,
          'total_amount', pr.total_amount,
          'allocated_amount', coalesce((
            select sum(pa.amount)
            from public.payment_allocations pa
            where pa.payment_request_id = pr.id
          ), 0),
          'remaining_amount', coalesce(pr.total_amount, 0) - coalesce((
            select sum(pa.amount)
            from public.payment_allocations pa
            where pa.payment_request_id = pr.id
          ), 0),
          'status', pr.status,
          'payment_status', pr.payment_status,
          'requires_receipt', pr.requires_receipt,
          'created_at', pr.created_at
        )
        order by i.position
      )
      from public.payment_submission_items i
      join public.payment_requests pr on pr.id = i.payment_request_id
      left join public.suppliers s2 on s2.id = pr.supplier_id
      where i.submission_id = s.id
    ), '[]'::jsonb)
  )
  into v_result
  from public.payment_submissions s
  where s.id = p_id;

  return v_result;
end;
$$;

revoke all on function public.get_payment_submission(uuid) from public, anon;
grant execute on function public.get_payment_submission(uuid) to authenticated, service_role;

comment on function public.get_payment_submission(uuid) is 'Owner / payment_requests view: one payment submission header plus its snapshot items enriched with live request number, title, supplier, total, allocated, remaining, status, payment_status, requires_receipt and created_at. Returns null when not found.';

-- ---------------------------------------------------------------------------
-- 4. Extend the finance Zalo event check with the submission event.
-- ---------------------------------------------------------------------------
alter table public.finance_zalo_notifications
  drop constraint if exists finance_zalo_notifications_event_type_check;

alter table public.finance_zalo_notifications
  add constraint finance_zalo_notifications_event_type_check
  check (event_type in (
    'payment_request_created',
    'payment_request_paid',
    'goods_receipt_received',
    'goods_receipt_short',
    'payment_submission_created'
  ));

-- ---------------------------------------------------------------------------
-- 5. UNC approval keeps its exact signature/behaviour and additionally accepts
--    evidence.payment_method in ('bank_transfer','cash') (default bank_transfer)
--    for the material-controller approval method and the payments row. Cash
--    evidence may have no reference. Copied verbatim from
--    20261006140000_payment_unc_allocations.sql except for v_method.
-- ---------------------------------------------------------------------------
create or replace function public.approve_payment_requests_with_unc(
  p_request_ids uuid[],
  p_evidence jsonb,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_is_service boolean := coalesce(public.material_master_jwt_role(), '') = 'service_role';
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_evidence jsonb := coalesce(p_evidence, '{}'::jsonb);
  v_ids uuid[];
  v_prior jsonb;
  v_file_sha text := nullif(btrim(coalesce(v_evidence->>'file_sha256', '')), '');
  v_storage_path text := nullif(btrim(coalesce(v_evidence->>'storage_path', '')), '');
  v_reference text := nullif(btrim(coalesce(v_evidence->>'ocr_reference', '')), '');
  v_reference_norm text;
  v_beneficiary text := nullif(btrim(coalesce(v_evidence->>'ocr_beneficiary_account', '')), '');
  v_confidence numeric := nullif(v_evidence->>'ocr_confidence', '')::numeric;
  v_transfer_date date := nullif(v_evidence->>'transfer_date', '')::date;
  v_amount numeric := coalesce(
    nullif(v_evidence->>'ocr_amount', '')::numeric,
    nullif(v_evidence->>'amount', '')::numeric
  );
  v_manual_override boolean := lower(coalesce(v_evidence->>'manual_override', 'false')) in ('true', 't', '1');
  v_override_reason text := nullif(btrim(coalesce(v_evidence->>'override_reason', '')), '');
  v_note text := nullif(btrim(coalesce(v_evidence->>'note', '')), '');
  v_category text := nullif(btrim(coalesce(v_evidence->>'category', '')), '');
  v_method text := coalesce(nullif(v_evidence->>'payment_method', ''), 'bank_transfer');
  v_alloc_input jsonb;
  v_has_alloc boolean := false;
  v_alloc_count integer := 0;
  v_alloc_distinct_count integer := 0;
  v_alloc_amount numeric;
  v_pr record;
  v_request_count integer := 0;
  v_remaining numeric;
  v_payment_total numeric := 0;
  v_supplier_id uuid;
  v_supplier_set boolean := false;
  v_allocations jsonb := '[]'::jsonb;
  v_payment_id uuid;
  v_owner_count integer;
  v_draft_amount numeric;
  v_result jsonb;
begin
  -- Owner-only: app_role owner (or service_role for trusted automation). Module
  -- edit permission is deliberately NOT accepted for UNC cash-out approval.
  if not v_is_service then
    if v_actor is null then
      raise exception 'not_owner' using errcode = '42501';
    end if;
  end if;
  if not (v_is_service or public.has_role(v_actor, 'owner')) then
    raise exception 'not_owner' using errcode = '42501';
  end if;

  if v_key is null then
    raise exception 'idempotency_key_required' using errcode = '22023';
  end if;
  if p_request_ids is null or array_length(p_request_ids, 1) is null then
    raise exception 'request_ids_required' using errcode = '22023';
  end if;

  -- Payment method is optional and defaults to bank_transfer. Cash slips may
  -- have no reference; everything else is unchanged.
  if v_method not in ('bank_transfer', 'cash') then
    raise exception 'invalid_payment_method' using errcode = '22023';
  end if;

  select array(select distinct unnest(p_request_ids)) into v_ids;

  select result into v_prior
  from public.payment_unc_idempotency
  where idempotency_key = v_key
  limit 1;
  if found then
    return v_prior || jsonb_build_object('idempotent', true);
  end if;

  perform pg_advisory_xact_lock(hashtext('payment_unc_approval:' || v_key));

  select result into v_prior
  from public.payment_unc_idempotency
  where idempotency_key = v_key
  limit 1;
  if found then
    return v_prior || jsonb_build_object('idempotent', true);
  end if;

  if exists (
    select 1
    from unnest(v_ids) as rid(id)
    where not exists (select 1 from public.payment_requests pr where pr.id = rid.id)
  ) then
    raise exception 'request_not_found' using errcode = 'P0002';
  end if;

  -- Optional per-request allocation branch. Absent/empty => legacy full-remaining
  -- behaviour (all requests pending, one allocation per request equal to its
  -- remaining amount).
  if jsonb_typeof(v_evidence->'allocations') = 'array' then
    v_alloc_input := v_evidence->'allocations';
  else
    v_alloc_input := '[]'::jsonb;
  end if;
  v_has_alloc := jsonb_array_length(v_alloc_input) > 0;

  if v_has_alloc then
    if jsonb_array_length(v_alloc_input) > 50 then
      raise exception 'invalid_allocation' using errcode = '22023', detail = 'too_many_allocations';
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_alloc_input) item
      where jsonb_typeof(item) <> 'object'
    ) then
      raise exception 'invalid_allocation' using errcode = '22023', detail = 'item_not_object';
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_alloc_input) item
      where coalesce(item->>'payment_request_id', '')
              !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    ) then
      raise exception 'invalid_allocation' using errcode = '22023', detail = 'payment_request_id_invalid';
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_alloc_input) item
      where not (item ? 'amount')
         or jsonb_typeof(item->'amount') <> 'number'
    ) then
      raise exception 'invalid_allocation' using errcode = '22023', detail = 'amount_required';
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_alloc_input) item
      where (item->>'amount')::numeric <= 0
    ) then
      raise exception 'invalid_allocation' using errcode = '22023', detail = 'amount_must_be_positive';
    end if;
    select count(*) into v_alloc_count from jsonb_array_elements(v_alloc_input) item;
    select count(distinct (item->>'payment_request_id'))
      into v_alloc_distinct_count
      from jsonb_array_elements(v_alloc_input) item;
    if v_alloc_count <> v_alloc_distinct_count then
      raise exception 'invalid_allocation' using errcode = '22023', detail = 'duplicate_payment_request_id';
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_alloc_input) item
      where (item->>'payment_request_id')::uuid <> all(v_ids)
    ) then
      raise exception 'invalid_allocation' using errcode = '22023', detail = 'allocation_not_in_request_ids';
    end if;
    if v_alloc_distinct_count <> array_length(v_ids, 1) then
      raise exception 'invalid_allocation' using errcode = '22023', detail = 'request_ids_mismatch';
    end if;
  end if;

  perform 1
  from public.payment_requests pr
  where pr.id = any(v_ids)
  order by pr.id
  for update of pr;

  -- Guard: a caller must not approve a request they created themselves when
  -- there is more than one owner (segregation of duties). When the caller is the
  -- only active owner, self-approval is allowed (documented, single-operator
  -- house) so the business is not blocked.
  select count(*) into v_owner_count from public.user_roles where role = 'owner';
  if v_owner_count > 1 and exists (
    select 1 from public.payment_requests pr
    where pr.id = any(v_ids) and pr.created_by = v_actor
  ) then
    raise exception 'self_approval_not_allowed' using errcode = '42501';
  end if;

  for v_pr in
    select * from public.payment_requests pr
    where pr.id = any(v_ids)
    order by pr.id
  loop
    if v_has_alloc then
      -- Allocations may settle already-approved requests (unpaid/partial) and
      -- may approve pending ones in the same call.
      if v_pr.status::text not in ('pending', 'approved') then
        raise exception 'not_pending' using errcode = 'P0001',
          detail = format('request_number=%s status=%s', v_pr.request_number, v_pr.status);
      end if;
      if v_pr.payment_status::text not in ('unpaid', 'partial') then
        raise exception 'not_pending' using errcode = 'P0001',
          detail = format('request_number=%s payment_status=%s', v_pr.request_number, v_pr.payment_status);
      end if;
    else
      if v_pr.status::text <> 'pending' then
        raise exception 'not_pending' using errcode = 'P0001',
          detail = format('request_number=%s status=%s', v_pr.request_number, v_pr.status);
      end if;
      if v_pr.payment_status::text <> 'unpaid' then
        raise exception 'not_pending' using errcode = 'P0001',
          detail = format('request_number=%s payment_status=%s', v_pr.request_number, v_pr.payment_status);
      end if;
    end if;

    v_remaining := coalesce(v_pr.total_amount, 0) - coalesce((
      select sum(pa.amount)
      from public.payment_allocations pa
      where pa.payment_request_id = v_pr.id
    ), 0);
    if v_remaining <= 0 then
      raise exception 'not_pending' using errcode = 'P0001',
        detail = format('request_number=%s remaining=%s', v_pr.request_number, v_remaining);
    end if;

    if not v_supplier_set then
      v_supplier_id := v_pr.supplier_id;
      v_supplier_set := true;
    elsif v_pr.supplier_id is distinct from v_supplier_id then
      raise exception 'supplier_mismatch' using errcode = 'P0001',
        detail = format('request_number=%s', v_pr.request_number);
    end if;

    v_request_count := v_request_count + 1;

    if v_has_alloc then
      select (item->>'amount')::numeric
        into v_alloc_amount
        from jsonb_array_elements(v_alloc_input) item
        where (item->>'payment_request_id')::uuid = v_pr.id;
      if v_alloc_amount is null or v_alloc_amount <= 0 then
        raise exception 'invalid_allocation' using errcode = '22023', detail = 'amount_must_be_positive';
      end if;
      if v_alloc_amount > v_remaining then
        raise exception 'allocation_exceeds_remaining' using errcode = 'P0001',
          detail = format('request_number=%s amount=%s remaining=%s', v_pr.request_number, v_alloc_amount, v_remaining);
      end if;
      v_payment_total := v_payment_total + v_alloc_amount;
      v_allocations := v_allocations || jsonb_build_array(jsonb_build_object(
        'payment_request_id', v_pr.id,
        'amount', v_alloc_amount
      ));
    else
      v_payment_total := v_payment_total + v_remaining;
      v_allocations := v_allocations || jsonb_build_array(jsonb_build_object(
        'payment_request_id', v_pr.id,
        'amount', v_remaining
      ));
    end if;
  end loop;

  if v_request_count = 0 then
    raise exception 'request_ids_required' using errcode = '22023';
  end if;

  if v_file_sha is null then
    raise exception 'evidence_required' using errcode = '22023';
  end if;

  -- The OCR fields come from the server-side draft written by
  -- payment-unc-approve (extract), never from the caller. Only a reasoned
  -- manual override may supply its own amount.
  select d.storage_path, d.ocr_amount, d.ocr_reference, d.ocr_beneficiary_account,
         d.ocr_confidence, d.transfer_date
    into v_storage_path, v_draft_amount, v_reference, v_beneficiary,
         v_confidence, v_transfer_date
  from public.payment_unc_ocr_drafts d
  where d.file_sha256 = v_file_sha;
  if not found then
    raise exception 'evidence_not_extracted' using errcode = '22023';
  end if;
  if not v_manual_override then
    v_amount := v_draft_amount;
  end if;

  if v_manual_override then
    if v_override_reason is null then
      raise exception 'override_reason_required' using errcode = '22023';
    end if;
  elsif v_amount is null or v_amount <> v_payment_total then
    raise exception 'amount_mismatch' using errcode = 'P0001',
      detail = format('evidence_amount=%s allocated_total=%s', v_amount, v_payment_total);
  end if;

  v_reference_norm := public.normalize_unc_reference(v_reference);

  if exists (select 1 from public.payment_unc_evidence e where e.file_sha256 = v_file_sha) then
    raise exception 'file_reused' using errcode = '23505';
  end if;
  if v_reference_norm is not null and exists (
    select 1 from public.payment_unc_evidence e
    where public.normalize_unc_reference(e.ocr_reference) = v_reference_norm
  ) then
    raise exception 'reference_reused' using errcode = '23505';
  end if;

  -- Reuse the canonical approval path (material controller + audit columns).
  -- Requests already approved by an earlier partial payment are not re-approved.
  for v_pr in
    select * from public.payment_requests pr
    where pr.id = any(v_ids)
    order by pr.id
  loop
    if v_pr.status::text = 'pending' then
      perform public.approve_payment_request_with_material_controller(
        v_pr.id,
        v_method,
        v_actor
      );
    end if;
  end loop;

  perform pg_advisory_xact_lock(hashtext('public.payments.payment_number'));

  insert into public.payments (
    payment_number,
    supplier_id,
    payment_date,
    amount,
    payment_method,
    reference_number,
    notes,
    created_by
  ) values (
    public.next_payment_number(),
    v_supplier_id,
    coalesce(v_transfer_date, (now() at time zone 'Asia/Ho_Chi_Minh')::date),
    v_payment_total,
    v_method::public.payment_method_type,
    v_reference,
    v_override_reason,
    v_actor
  )
  returning id into v_payment_id;

  insert into public.payment_allocations (payment_id, payment_request_id, amount, created_by)
  select v_payment_id, (item->>'payment_request_id')::uuid, (item->>'amount')::numeric, v_actor
  from jsonb_array_elements(v_allocations) item;

  begin
    insert into public.payment_unc_evidence (
      payment_id,
      storage_path,
      file_sha256,
      ocr_amount,
      ocr_reference,
      ocr_beneficiary_account,
      ocr_confidence,
      transfer_date,
      manual_override,
      override_reason,
      category,
      note,
      created_by
    ) values (
      v_payment_id,
      v_storage_path,
      v_file_sha,
      v_amount,
      v_reference,
      v_beneficiary,
      v_confidence,
      v_transfer_date,
      v_manual_override,
      v_override_reason,
      coalesce(v_category, 'khac'),
      v_note,
      v_actor
    );
  exception when unique_violation then
    if exists (select 1 from public.payment_unc_evidence e where e.file_sha256 = v_file_sha) then
      raise exception 'file_reused' using errcode = '23505';
    end if;
    raise exception 'reference_reused' using errcode = '23505';
  end;

  v_result := jsonb_build_object(
    'status', 'approved',
    'payment_id', v_payment_id,
    'payment_request_ids', to_jsonb(v_ids),
    'amount', v_payment_total,
    'evidence_amount', v_amount,
    'manual_override', v_manual_override,
    'reference_number', v_reference,
    'supplier_id', v_supplier_id,
    'transfer_date', coalesce(v_transfer_date, (now() at time zone 'Asia/Ho_Chi_Minh')::date),
    'allocations', v_allocations,
    'idempotent', false
  );

  insert into public.payment_unc_idempotency (idempotency_key, result, created_by)
  values (v_key, v_result, v_actor)
  on conflict (idempotency_key) do nothing;

  return v_result;
end;
$$;

revoke all on function public.approve_payment_requests_with_unc(uuid[], jsonb, text) from public, anon;
grant execute on function public.approve_payment_requests_with_unc(uuid[], jsonb, text) to authenticated, service_role;

comment on function public.approve_payment_requests_with_unc(uuid[], jsonb, text) is 'Owner-only atomic UNC approval: locks same-supplier requests (pending and/or already-approved unpaid/partial), enforces per-request allocations from p_evidence->allocations (each >0 and <= remaining, exact evidence amount unless a reasoned manual override), rejects reused file hash/reference, accepts an optional evidence.payment_method in (bank_transfer,cash), approves pending requests via approve_payment_request_with_material_controller, records one payment + allocations + evidence, and replays by idempotency_key. Without an allocations array it pays every pending request in full as before.';
