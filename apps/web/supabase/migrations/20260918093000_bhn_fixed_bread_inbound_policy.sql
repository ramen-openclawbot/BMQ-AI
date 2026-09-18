-- Fixed BMQ-001 inbound policy for the BHN kiosk and auditable sales-note proposals.
-- Service-role workers read policies and create proposals; operators confirm separately.

create table if not exists public.kiosk_bread_fixed_inbound_policies (
  id uuid primary key default gen_random_uuid(),
  policy_code text not null unique,
  location_id uuid not null references public.kiosk_report_locations(id) on delete restrict,
  location_code text not null,
  sku_code text not null,
  quantity numeric(12,3) not null check (quantity > 0),
  effective_from_cutoff_date date not null,
  effective_from_service_date date not null,
  active boolean not null default true,
  policy_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint kiosk_bread_fixed_policy_sku_check check (sku_code = 'BMQ-001'),
  constraint kiosk_bread_fixed_policy_dates_check check (effective_from_service_date >= effective_from_cutoff_date)
);

create index if not exists kiosk_bread_fixed_inbound_policies_active_idx
  on public.kiosk_bread_fixed_inbound_policies (active, sku_code, effective_from_service_date, location_id);

insert into public.kiosk_bread_fixed_inbound_policies (
  policy_code,
  location_id,
  location_code,
  sku_code,
  quantity,
  effective_from_cutoff_date,
  effective_from_service_date,
  active,
  policy_snapshot
) values (
  'fixed-daily-inbound-bhn-bmq-001-v1',
  '8b353493-c3cb-436e-80f7-a9a1d1a57cd3',
  'HCM004-BHN',
  'BMQ-001',
  160,
  date '2026-09-18',
  date '2026-09-19',
  true,
  jsonb_build_object(
    'policy_type', 'fixed_daily_inbound',
    'fixed_quantity', 160,
    'closing_stock_treatment', 'do_not_subtract_closing',
    'requires_operator_confirmation_for_sales_note_override', true,
    'source', 'operational_seed_2026_09_18'
  )
) on conflict (policy_code) do update
set location_id = excluded.location_id,
    location_code = excluded.location_code,
    sku_code = excluded.sku_code,
    quantity = excluded.quantity,
    effective_from_cutoff_date = excluded.effective_from_cutoff_date,
    effective_from_service_date = excluded.effective_from_service_date,
    active = excluded.active,
    policy_snapshot = excluded.policy_snapshot,
    updated_at = now();

create table if not exists public.kiosk_bread_order_note_proposals (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.kiosk_daily_reports(id) on delete cascade,
  location_id uuid not null references public.kiosk_report_locations(id) on delete restrict,
  report_date date not null,
  sku_code text not null default 'BMQ-001',
  proposed_quantity numeric(12,3) not null check (proposed_quantity > 0),
  parser_rule text not null,
  evidence jsonb not null default '{}'::jsonb,
  proposal_status text not null default 'pending_operator_confirmation'
    check (proposal_status in ('pending_operator_confirmation', 'confirmed', 'rejected', 'superseded')),
  requires_confirmation boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_by uuid,
  confirmed_at timestamptz,
  constraint kiosk_bread_order_note_proposals_sku_check check (sku_code = 'BMQ-001'),
  constraint kiosk_bread_order_note_proposals_confirm_check check (
    proposal_status <> 'confirmed'
    or (confirmed_by is not null and confirmed_at is not null)
  )
);

create unique index if not exists kiosk_bread_order_note_proposals_report_rule_unique
  on public.kiosk_bread_order_note_proposals (report_id, parser_rule)
  where proposal_status in ('pending_operator_confirmation', 'confirmed');

create index if not exists kiosk_bread_order_note_proposals_review_idx
  on public.kiosk_bread_order_note_proposals (proposal_status, report_date desc, location_id);

create table if not exists public.kiosk_bread_order_note_proposal_audit_logs (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid references public.kiosk_bread_order_note_proposals(id) on delete set null,
  report_id uuid not null references public.kiosk_daily_reports(id) on delete cascade,
  action text not null,
  actor_role text not null default auth.role(),
  old_values jsonb not null default '{}'::jsonb,
  new_values jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.kiosk_bread_fixed_inbound_policies enable row level security;
alter table public.kiosk_bread_order_note_proposals enable row level security;
alter table public.kiosk_bread_order_note_proposal_audit_logs enable row level security;

revoke all on public.kiosk_bread_fixed_inbound_policies from public, anon, authenticated;
revoke all on public.kiosk_bread_order_note_proposals from public, anon, authenticated;
revoke all on public.kiosk_bread_order_note_proposal_audit_logs from public, anon, authenticated;
grant all on public.kiosk_bread_fixed_inbound_policies to service_role;
grant all on public.kiosk_bread_order_note_proposals to service_role;
grant all on public.kiosk_bread_order_note_proposal_audit_logs to service_role;

create or replace function public.get_active_kiosk_bread_fixed_inbound_policies(
  p_service_date date
)
returns table (
  policy_code text,
  location_id uuid,
  location_code text,
  sku_code text,
  quantity numeric,
  effective_from_service_date date,
  effective_from_cutoff_date date,
  policy_snapshot jsonb
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_service_date is null then
    raise exception 'service date is required' using errcode = '22023';
  end if;

  return query
  select
    policy.policy_code,
    policy.location_id,
    policy.location_code,
    policy.sku_code,
    policy.quantity,
    policy.effective_from_service_date,
    policy.effective_from_cutoff_date,
    policy.policy_snapshot
  from public.kiosk_bread_fixed_inbound_policies policy
  join public.kiosk_report_locations location
    on location.id = policy.location_id
   and location.active = true
   and upper(coalesce(location.location_code, '')) not like 'TEST%'
  where policy.active = true
    and policy.sku_code = 'BMQ-001'
    and policy.effective_from_service_date <= p_service_date
  order by policy.location_code, policy.effective_from_service_date desc, policy.created_at desc;
end;
$$;

revoke all on function public.get_active_kiosk_bread_fixed_inbound_policies(date) from public;
revoke all on function public.get_active_kiosk_bread_fixed_inbound_policies(date) from anon;
revoke all on function public.get_active_kiosk_bread_fixed_inbound_policies(date) from authenticated;
grant execute on function public.get_active_kiosk_bread_fixed_inbound_policies(date) to service_role;

create or replace function public.upsert_kiosk_bread_order_note_proposal(
  p_report_id uuid,
  p_location_id uuid,
  p_report_date date,
  p_quantity numeric,
  p_parser_rule text,
  p_evidence jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
  v_report_id uuid := p_report_id;
  v_existing public.kiosk_bread_order_note_proposals%rowtype;
  v_new public.kiosk_bread_order_note_proposals%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  if p_location_id is null
     or p_report_date is null
     or coalesce(p_quantity, 0) <= 0
     or nullif(btrim(coalesce(p_parser_rule, '')), '') is null
     or p_evidence is null then
    raise exception 'invalid_bread_order_note_proposal' using errcode = '22023';
  end if;

  if v_report_id is null then
    select report.id
      into v_report_id
    from public.kiosk_daily_reports report
    where report.location_id = p_location_id
      and report.report_date = p_report_date
    for update;
  end if;

  if v_report_id is null then
    raise exception 'kiosk_report_not_found' using errcode = 'P0002';
  end if;

  select *
    into v_existing
  from public.kiosk_bread_order_note_proposals
  where report_id = v_report_id
    and parser_rule = p_parser_rule
    and proposal_status in ('pending_operator_confirmation', 'confirmed')
  for update;

  if v_existing.id is not null and v_existing.proposal_status = 'confirmed' then
    return v_existing.id;
  end if;

  insert into public.kiosk_bread_order_note_proposals (
    report_id,
    location_id,
    report_date,
    sku_code,
    proposed_quantity,
    parser_rule,
    evidence,
    proposal_status,
    requires_confirmation
  ) values (
    v_report_id,
    p_location_id,
    p_report_date,
    'BMQ-001',
    p_quantity,
    p_parser_rule,
    p_evidence,
    'pending_operator_confirmation',
    true
  )
  on conflict (report_id, parser_rule)
    where proposal_status in ('pending_operator_confirmation', 'confirmed')
  do update set
    location_id = excluded.location_id,
    report_date = excluded.report_date,
    proposed_quantity = excluded.proposed_quantity,
    evidence = excluded.evidence,
    proposal_status = case
      when public.kiosk_bread_order_note_proposals.proposal_status = 'confirmed' then 'confirmed'
      else 'pending_operator_confirmation'
    end,
    requires_confirmation = true,
    updated_at = now()
  returning id into v_id;

  select *
    into v_new
  from public.kiosk_bread_order_note_proposals
  where id = v_id;

  insert into public.kiosk_bread_order_note_proposal_audit_logs (
    proposal_id,
    report_id,
    action,
    old_values,
    new_values
  ) values (
    v_id,
    v_report_id,
    case when v_existing.id is null then 'create_note_proposal' else 'update_note_proposal' end,
    coalesce(to_jsonb(v_existing), '{}'::jsonb),
    to_jsonb(v_new)
  );

  return v_id;
end;
$$;

revoke all on function public.upsert_kiosk_bread_order_note_proposal(uuid, uuid, date, numeric, text, jsonb) from public;
revoke all on function public.upsert_kiosk_bread_order_note_proposal(uuid, uuid, date, numeric, text, jsonb) from anon;
revoke all on function public.upsert_kiosk_bread_order_note_proposal(uuid, uuid, date, numeric, text, jsonb) from authenticated;
grant execute on function public.upsert_kiosk_bread_order_note_proposal(uuid, uuid, date, numeric, text, jsonb) to service_role;

-- Save the report and reconcile note evidence in one database transaction. This
-- wrapper deliberately mirrors the exact linked save RPC argument order/types.
create or replace function public.save_kiosk_daily_report_with_bread_proposal_atomic(
  p_location_id uuid,
  p_staff_id uuid,
  p_report_date date,
  p_status text,
  p_notes text,
  p_staff_name_snapshot text,
  p_staff_phone_normalized_snapshot text,
  p_location_code_snapshot text,
  p_location_name_snapshot text,
  p_location_address_snapshot text,
  p_inventory_rows jsonb,
  p_channel_rows jsonb,
  p_bread_note_proposal jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result jsonb;
  v_report_id uuid;
  v_quantity numeric;
  v_parser_rule text;
  v_evidence jsonb;
  v_pending public.kiosk_bread_order_note_proposals%rowtype;
  v_confirmed public.kiosk_bread_order_note_proposals%rowtype;
  v_new public.kiosk_bread_order_note_proposals%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  v_result := public.save_kiosk_daily_report_atomic(
    p_location_id,
    p_staff_id,
    p_report_date,
    p_status,
    p_notes,
    p_staff_name_snapshot,
    p_staff_phone_normalized_snapshot,
    p_location_code_snapshot,
    p_location_name_snapshot,
    p_location_address_snapshot,
    p_inventory_rows,
    p_channel_rows
  );

  select report.id into v_report_id
  from public.kiosk_daily_reports report
  where report.location_id = p_location_id and report.report_date = p_report_date
  for update;
  if v_report_id is null then
    raise exception 'kiosk_report_not_found_after_save' using errcode = 'P0002';
  end if;

  if p_bread_note_proposal is not null then
    begin
      v_quantity := (p_bread_note_proposal ->> 'quantity')::numeric;
    exception when others then
      raise exception 'invalid_bread_order_note_proposal' using errcode = '22023';
    end;
    v_parser_rule := nullif(btrim(p_bread_note_proposal ->> 'parser_rule'), '');
    v_evidence := p_bread_note_proposal -> 'evidence';
    if coalesce(v_quantity, 0) <= 0 or v_parser_rule is null or v_evidence is null then
      raise exception 'invalid_bread_order_note_proposal' using errcode = '22023';
    end if;
  end if;

  -- Removed/ambiguous notes and changed proposals supersede every stale pending
  -- row. Confirmed evidence is immutable and handled separately below.
  for v_pending in
    select * from public.kiosk_bread_order_note_proposals
    where report_id = v_report_id
      and proposal_status = 'pending_operator_confirmation'
    for update
  loop
    if p_bread_note_proposal is null
       or v_pending.parser_rule <> v_parser_rule
       or v_pending.proposed_quantity <> v_quantity
       or v_pending.evidence <> v_evidence then
      update public.kiosk_bread_order_note_proposals
      set proposal_status = 'superseded', updated_at = now()
      where id = v_pending.id
      returning * into v_new;
      insert into public.kiosk_bread_order_note_proposal_audit_logs
        (proposal_id, report_id, action, old_values, new_values)
      values
        (v_pending.id, v_report_id, 'supersede_note_proposal', to_jsonb(v_pending), to_jsonb(v_new));
    end if;
  end loop;

  if p_bread_note_proposal is null then
    return v_result;
  end if;

  select * into v_confirmed
  from public.kiosk_bread_order_note_proposals
  where report_id = v_report_id
    and parser_rule = v_parser_rule
    and proposal_status = 'confirmed'
  for update;

  if v_confirmed.id is not null then
    if v_confirmed.proposed_quantity = v_quantity and v_confirmed.evidence = v_evidence then
      if not exists (
        select 1 from public.kiosk_bread_order_note_proposal_audit_logs audit
        where audit.proposal_id = v_confirmed.id
          and audit.action = 'confirmed_proposal_replay'
          and audit.new_values = jsonb_build_object(
            'proposed_quantity', v_quantity,
            'parser_rule', v_parser_rule,
            'evidence', v_evidence
          )
      ) then
        insert into public.kiosk_bread_order_note_proposal_audit_logs
          (proposal_id, report_id, action, old_values, new_values)
        values (
          v_confirmed.id,
          v_report_id,
          'confirmed_proposal_replay',
          to_jsonb(v_confirmed),
          jsonb_build_object('proposed_quantity', v_quantity, 'parser_rule', v_parser_rule, 'evidence', v_evidence)
        );
      end if;
    else
      -- Record a semantic conflict once; never mutate confirmed evidence and
      -- never append duplicate conflict evidence on an exact retry.
      if not exists (
        select 1 from public.kiosk_bread_order_note_proposal_audit_logs audit
        where audit.proposal_id = v_confirmed.id
          and audit.action = 'confirmed_proposal_conflict'
          and audit.new_values = jsonb_build_object(
            'proposed_quantity', v_quantity,
            'parser_rule', v_parser_rule,
            'evidence', v_evidence
          )
      ) then
        insert into public.kiosk_bread_order_note_proposal_audit_logs
          (proposal_id, report_id, action, old_values, new_values)
        values (
          v_confirmed.id,
          v_report_id,
          'confirmed_proposal_conflict',
          to_jsonb(v_confirmed),
          jsonb_build_object('proposed_quantity', v_quantity, 'parser_rule', v_parser_rule, 'evidence', v_evidence)
        );
      end if;
    end if;
    return v_result;
  end if;

  -- An unchanged pending row is an exact idempotent replay: no update/audit.
  if exists (
    select 1 from public.kiosk_bread_order_note_proposals proposal
    where proposal.report_id = v_report_id
      and proposal.parser_rule = v_parser_rule
      and proposal.proposal_status = 'pending_operator_confirmation'
      and proposal.proposed_quantity = v_quantity
      and proposal.evidence = v_evidence
  ) then
    return v_result;
  end if;

  insert into public.kiosk_bread_order_note_proposals (
    report_id, location_id, report_date, sku_code, proposed_quantity,
    parser_rule, evidence, proposal_status, requires_confirmation
  ) values (
    v_report_id, p_location_id, p_report_date, 'BMQ-001', v_quantity,
    v_parser_rule, v_evidence, 'pending_operator_confirmation', true
  ) returning * into v_new;

  insert into public.kiosk_bread_order_note_proposal_audit_logs
    (proposal_id, report_id, action, old_values, new_values)
  values (v_new.id, v_report_id, 'create_note_proposal', '{}'::jsonb, to_jsonb(v_new));

  return v_result;
end;
$$;

revoke all on function public.save_kiosk_daily_report_with_bread_proposal_atomic(uuid, uuid, date, text, text, text, text, text, text, text, jsonb, jsonb, jsonb) from public;
revoke all on function public.save_kiosk_daily_report_with_bread_proposal_atomic(uuid, uuid, date, text, text, text, text, text, text, text, jsonb, jsonb, jsonb) from anon;
revoke all on function public.save_kiosk_daily_report_with_bread_proposal_atomic(uuid, uuid, date, text, text, text, text, text, text, text, jsonb, jsonb, jsonb) from authenticated;
grant execute on function public.save_kiosk_daily_report_with_bread_proposal_atomic(uuid, uuid, date, text, text, text, text, text, text, text, jsonb, jsonb, jsonb) to service_role;

-- Preserve the exact latest linked correction behavior while making fixed-policy
-- corrections replay the frozen supplier/warehouse cutoff snapshot.
-- Remove owner-marked explanatory copy from future supplier correction messages.
-- Quantity, delivery and payable calculations remain unchanged.

create or replace function public.queue_late_kiosk_bread_order_corrections(
  p_report_id uuid,
  p_correction_audit_id uuid
)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_report public.kiosk_daily_reports%rowtype;
  v_location public.kiosk_report_locations%rowtype;
  v_bread public.kiosk_daily_report_inventory_rows%rowtype;
  v_order_date date;
  v_supplier public.dealer_order_notifications%rowtype;
  v_warehouse public.dealer_order_notifications%rowtype;
  v_old_location jsonb;
  v_old_warehouse_location jsonb;
  v_frozen_fixed_policy jsonb;
  v_warehouse_fixed_policy jsonb;
  v_supplier_quantity_semantics text;
  v_warehouse_quantity_semantics text;
  v_frozen_fixed_quantity numeric;
  v_corrected_supplier_locations jsonb;
  v_corrected_locations jsonb;
  v_key_base text;
  v_supplier_key text;
  v_warehouse_key text;
  v_inserted integer := 0;
  v_row_count integer := 0;
  v_dealer numeric := 0;
  v_dealer_ordered numeric := 0;
  v_dealer_extra numeric := 0;
  v_dealer_exchange numeric := 0;
  v_dealer_makeup numeric := 0;
  v_supplier_exchange numeric := 0;
  v_supplier_makeup numeric := 0;
  v_total_credit numeric := 0;
  v_total_new_order numeric := 0;
  v_raw_total_bmq numeric := 0;
  v_rounding_adjustment numeric := 0;
  v_supplier_billable numeric := 0;
  v_vietjet numeric := 0;
  v_old_vehicle numeric := 0;
  v_old_location_quantity numeric := 0;
  v_peak_sold numeric := 0;
  v_latest_closing_quantity numeric := 0;
  v_new_location numeric := 0;
  v_new_vehicle numeric := 0;
  v_total_bmq numeric := 0;
  v_total_makeup numeric := 0;
  v_total_exchange numeric := 0;
  v_total_physical numeric := 0;
  v_warehouse_lines text := '';
begin
  if auth.role() is distinct from 'service_role'
     and current_setting('app.kiosk_authorized_correction_queue', true) is distinct from 'on' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select * into v_report
  from public.kiosk_daily_reports
  where id = p_report_id and status = 'submitted'
  for update;
  if not found then return 0; end if;

  select * into v_location from public.kiosk_report_locations where id = v_report.location_id;
  select * into v_bread from public.kiosk_daily_report_inventory_rows
  where report_id = p_report_id and product_code = 'banh_mi_que';
  if not found then return 0; end if;

  v_order_date := v_report.report_date + 1;
  select * into v_supplier
  from public.dealer_order_notifications
  where notification_type = 'production_bread_order'
    and digest_date = v_order_date
    and status = 'sent'
  order by updated_at desc, id desc
  limit 1;

  select * into v_warehouse
  from public.dealer_order_notifications
  where notification_type = 'warehouse_kiosk_bread_dispatch'
    and digest_date = v_order_date
    and status = 'sent'
  order by updated_at desc, id desc
  limit 1;

  if v_supplier.id is null or v_warehouse.id is null then return 0; end if;

  select loc.value into v_old_location
  from jsonb_array_elements(coalesce(v_supplier.source_snapshot #> '{vehicle,locations}', '[]'::jsonb)) loc(value)
  where loc.value->>'locationId' = v_report.location_id::text
  limit 1;
  if v_old_location is null then return 0; end if;

  select loc.value into v_old_warehouse_location
  from jsonb_array_elements(coalesce(v_warehouse.source_snapshot->'locations', '[]'::jsonb)) loc(value)
  where loc.value->>'locationId' = v_report.location_id::text
  limit 1;
  if v_old_warehouse_location is null then return 0; end if;

  -- Reuse the immutable cutoff snapshots. A late correction must never consult a
  -- newly active policy and silently rewrite the already-queued service date.
  v_frozen_fixed_policy := v_old_location->'fixedInboundPolicy';
  v_warehouse_fixed_policy := v_old_warehouse_location->'fixedInboundPolicy';
  v_supplier_quantity_semantics := nullif(v_old_location->>'quantitySemantics', '');
  v_warehouse_quantity_semantics := nullif(v_old_warehouse_location->>'quantitySemantics', '');

  if (v_frozen_fixed_policy is null) <> (v_warehouse_fixed_policy is null)
     or v_frozen_fixed_policy is distinct from v_warehouse_fixed_policy
     or v_supplier_quantity_semantics is distinct from v_warehouse_quantity_semantics then
    raise exception 'fixed_policy_snapshot_mismatch' using errcode = '22023';
  end if;

  if v_frozen_fixed_policy is not null then
    begin
      v_frozen_fixed_quantity := (v_frozen_fixed_policy->>'quantity')::numeric;
    exception when others then
      raise exception 'fixed_policy_quantity_invalid' using errcode = '22023';
    end;
    if coalesce(v_frozen_fixed_quantity, 0) <= 0
       or v_supplier_quantity_semantics is distinct from 'fixed_daily_inbound_not_stock_subtracted' then
      raise exception 'fixed_policy_quantity_invalid' using errcode = '22023';
    end if;
  end if;

  v_dealer_ordered := coalesce((v_supplier.source_snapshot #>> '{dealer,ordered_quantity}')::numeric, 0);
  v_dealer_exchange := coalesce((v_supplier.source_snapshot #>> '{dealer,exchange_quantity}')::numeric, 0);
  v_dealer_makeup := coalesce((v_supplier.source_snapshot #>> '{dealer,makeup_quantity}')::numeric, 0);
  v_dealer_extra := coalesce(
    (v_supplier.source_snapshot #>> '{dealer,extra_quantity}')::numeric,
    v_dealer_exchange + v_dealer_makeup
  );
  v_dealer := coalesce(
    (v_supplier.source_snapshot #>> '{dealer,physical_quantity}')::numeric,
    v_dealer_ordered + v_dealer_extra
  );
  v_vietjet := coalesce((v_supplier.source_snapshot #>> '{vietjet,quantity}')::numeric, 0);
  v_old_vehicle := coalesce((v_supplier.source_snapshot #>> '{vehicle,total_quantity}')::numeric, 0);
  v_old_location_quantity := coalesce((v_old_location->>'recommendedQuantity')::numeric, 0);

  with ranked as (
    select inventory.sold_quantity,
           inventory.closing_quantity,
           row_number() over (
             order by report.report_date desc, report.submitted_at desc nulls last, report.id desc
           ) as report_rank
    from public.kiosk_daily_reports report
    join public.kiosk_daily_report_inventory_rows inventory
      on inventory.report_id = report.id
     and inventory.product_code = 'banh_mi_que'
    where report.location_id = v_report.location_id
      and report.status = 'submitted'
      and report.report_date <= v_report.report_date
  )
  select coalesce(max(sold_quantity) filter (where report_rank <= 7), 0),
         coalesce(max(closing_quantity) filter (where report_rank = 1), 0)
    into v_peak_sold, v_latest_closing_quantity
  from ranked;

  v_new_location := case
    when nullif(v_old_location->>'closureReason', '') is not null then 0
    when v_frozen_fixed_policy is not null then v_frozen_fixed_quantity
    else greatest(0, ceiling(greatest(0, (v_peak_sold * 1.1) - v_latest_closing_quantity) / 10) * 10)
  end;
  v_new_vehicle := greatest(0, v_old_vehicle - v_old_location_quantity + v_new_location);

  select jsonb_agg(
    case when location.value->>'locationId' = v_report.location_id::text then
      location.value || jsonb_build_object(
        'recommendedQuantity', v_new_location,
        'peakSoldQuantity', v_peak_sold,
        'latestClosingQuantity', v_latest_closing_quantity,
        'latestReportDate', v_report.report_date,
        'latestReportSource', jsonb_build_object(
          'reportId', v_report.id,
          'reportUpdatedAt', v_report.updated_at
        )
      ) || case when v_frozen_fixed_policy is null then '{}'::jsonb else jsonb_build_object(
        'fixedInboundPolicy', v_frozen_fixed_policy,
        'quantitySemantics', v_supplier_quantity_semantics
      ) end
    else location.value end
    order by location.ordinality
  ) into v_corrected_supplier_locations
  from jsonb_array_elements(coalesce(v_supplier.source_snapshot #> '{vehicle,locations}', '[]'::jsonb))
       with ordinality as location(value, ordinality);

  if v_corrected_supplier_locations is null then return 0; end if;

  select jsonb_agg(
    case when location.value->>'locationId' = v_report.location_id::text then
      location.value || jsonb_build_object(
        'orderQuantity', v_new_location,
        'shortageQuantity', coalesce(v_bread.shortage_quantity, 0),
        'returnsQuantity', coalesce(v_bread.returns_quantity, 0),
        'wasteQuantity', coalesce(v_bread.waste_quantity, 0),
        'latestReportDate', v_report.report_date,
        'latestReportSource', jsonb_build_object(
          'reportId', v_report.id,
          'reportUpdatedAt', v_report.updated_at
        )
      ) || case when v_frozen_fixed_policy is null then '{}'::jsonb else jsonb_build_object(
        'fixedInboundPolicy', v_frozen_fixed_policy,
        'quantitySemantics', v_supplier_quantity_semantics
      ) end
    else location.value end
    order by location.ordinality
  ) into v_corrected_locations
  from jsonb_array_elements(coalesce(v_warehouse.source_snapshot->'locations', '[]'::jsonb))
       with ordinality as location(value, ordinality);

  if v_corrected_locations is null then return 0; end if;

  select coalesce(sum(coalesce((location.value->>'orderQuantity')::numeric, 0)), 0),
         coalesce(sum(coalesce((location.value->>'shortageQuantity')::numeric, 0)), 0),
         coalesce(sum(coalesce((location.value->>'returnsQuantity')::numeric, 0)
                    + coalesce((location.value->>'wasteQuantity')::numeric, 0)), 0)
    into v_new_vehicle, v_total_makeup, v_total_exchange
  from jsonb_array_elements(v_corrected_locations) location(value);
  v_total_physical := v_new_vehicle + v_total_makeup + v_total_exchange;
  v_supplier_exchange := v_dealer_exchange + v_total_exchange;
  v_supplier_makeup := v_dealer_makeup + v_total_makeup;
  v_total_credit := v_supplier_exchange + v_supplier_makeup;
  v_total_new_order := v_dealer_ordered + v_new_vehicle;
  v_raw_total_bmq := v_total_new_order + v_total_credit;
  v_total_bmq := ceiling(greatest(0, v_raw_total_bmq) / 20) * 20;
  v_rounding_adjustment := v_total_bmq - v_raw_total_bmq;
  v_supplier_billable := v_total_bmq - v_total_credit;
  v_vietjet := ceiling(greatest(0, v_vietjet) / 10) * 10;

  select string_agg(
    concat(
      regexp_replace(coalesce(location.value->>'locationName', location.value->>'locationCode', 'Điểm bán'), '^[[:space:]]*[0-9]+[[:space:]]+', ''),
      ': đặt ', to_char(coalesce((location.value->>'orderQuantity')::numeric, 0), 'FM999999999990.###'), ' que',
      case when coalesce((location.value->>'shortageQuantity')::numeric, 0) > 0
        then ' | bù ' || to_char((location.value->>'shortageQuantity')::numeric, 'FM999999999990.###') else '' end,
      case when coalesce((location.value->>'returnsQuantity')::numeric, 0)
                     + coalesce((location.value->>'wasteQuantity')::numeric, 0) > 0
        then ' | đổi ' || to_char(
          coalesce((location.value->>'returnsQuantity')::numeric, 0)
          + coalesce((location.value->>'wasteQuantity')::numeric, 0),
          'FM999999999990.###'
        ) else '' end
    ), E'\n' order by location.ordinality
  ) into v_warehouse_lines
  from jsonb_array_elements(v_corrected_locations) with ordinality as location(value, ordinality);

  v_key_base := concat_ws(':', v_supplier.id, v_warehouse.id, p_report_id, v_report.updated_at, p_correction_audit_id);
  v_supplier_key := 'late-kiosk-bread:supplier:' || v_key_base;
  v_warehouse_key := 'late-kiosk-bread:warehouse:' || v_key_base;

  insert into public.pending_kiosk_bread_recompute (
    report_id, report_updated_at, correction_audit_id,
    original_supplier_notification_id, original_warehouse_notification_id, idempotency_key
  ) values (
    p_report_id, v_report.updated_at, p_correction_audit_id,
    v_supplier.id, v_warehouse.id, v_key_base
  ) on conflict (idempotency_key) do nothing;

  insert into public.dealer_order_notifications (
    order_id, notification_type, digest_date, channel, group_name, message_body,
    source_snapshot, status, attempt_count, max_attempts, next_attempt_at
  ) values (
    null, 'production_bread_order_correction', v_order_date, 'zalo_gmf', 'BMQ - HKD Tuyết Anh',
    array_to_string(array[
      'ĐIỀU CHỈNH ĐẶT BÁNH - THAY THẾ TOÀN BỘ', E'\n',
      'Chênh lệch điểm bị sửa (', coalesce(v_location.location_name, v_location.location_code), '): ',
      to_char(abs(v_new_location - v_old_location_quantity), 'FM999999999990.###'), ' que ',
      case when v_new_location >= v_old_location_quantity then 'tăng' else 'giảm' end, E'\n',
      'Tổng đúng sau chỉnh sửa:', E'\n',
      '📦 ĐƠN ĐẶT HÀNG BMQ', E'\n',
      'Ngày giao: ', to_char(v_order_date, 'DD/MM/YYYY'), E'\n',
      'NCC: BMQ - HKD Tuyết Anh', E'\n\n',
      '━━━━━━━━━━━━━━', E'\n', '1️⃣ BÁNH MÌ QUE BMQ', E'\n', '━━━━━━━━━━━━━━', E'\n\n',
      'ĐẶT MỚI', E'\n',
      '• Đại lý: ', replace(to_char(v_dealer_ordered, 'FM999,999,999,990'), ',', '.'), ' que', E'\n',
      '• Điểm bán: ', replace(to_char(v_new_vehicle, 'FM999,999,999,990'), ',', '.'), ' que', E'\n',
      '• Cộng đặt mới: ', replace(to_char(v_total_new_order, 'FM999,999,999,990'), ',', '.'), ' que', E'\n\n',
      'ĐỔI / BÙ / TRẢ', E'\n',
      '• Đổi, trả: ', replace(to_char(v_supplier_exchange, 'FM999,999,999,990'), ',', '.'), ' que', E'\n',
      '  └ Đại lý ', replace(to_char(v_dealer_exchange, 'FM999,999,999,990'), ',', '.'), ' · Điểm bán ', replace(to_char(v_total_exchange, 'FM999,999,999,990'), ',', '.'), E'\n',
      '• Bù: ', replace(to_char(v_supplier_makeup, 'FM999,999,999,990'), ',', '.'), ' que', E'\n',
      '• Tổng khấu trừ: ', replace(to_char(v_total_credit, 'FM999,999,999,990'), ',', '.'), ' que', E'\n\n',
      'NCC CẦN GIAO', E'\n',
      '• Nhu cầu thực tế: ', replace(to_char(v_raw_total_bmq, 'FM999,999,999,990'), ',', '.'), ' que', E'\n',
      '• Điều chỉnh đủ mẻ: +', replace(to_char(v_rounding_adjustment, 'FM999,999,999,990'), ',', '.'), ' que', E'\n',
      '• Tổng giao: ', replace(to_char(v_total_bmq, 'FM999,999,999,990'), ',', '.'), ' que', E'\n\n',
      'GHI NHẬN CÔNG NỢ NCC', E'\n',
      '• Số lượng giao: ', replace(to_char(v_total_bmq, 'FM999,999,999,990'), ',', '.'), ' que', E'\n',
      '• Khấu trừ đổi/bù/trả: −', replace(to_char(v_total_credit, 'FM999,999,999,990'), ',', '.'), ' que', E'\n',
      '• Số lượng tính tiền: ', replace(to_char(v_supplier_billable, 'FM999,999,999,990'), ',', '.'), ' que', E'\n\n',
      '━━━━━━━━━━━━━━', E'\n', '2️⃣ BÁNH MÌ VIETJET', E'\n', '━━━━━━━━━━━━━━', E'\n\n',
      '• Số lượng đặt: ', replace(to_char(v_vietjet, 'FM999,999,999,990'), ',', '.'), E'\n',
      '• Số lượng NCC giao: ', replace(to_char(v_vietjet, 'FM999,999,999,990'), ',', '.'), E'\n',
      '• Ghi nhận công nợ: ', replace(to_char(v_vietjet, 'FM999,999,999,990'), ',', '.')
    ], ''),
    jsonb_build_object(
      'approved_by_owner', false,
      'approval_status', 'pending_owner_review',
      'full_replacement', true,
      'idempotency_key', v_supplier_key,
      'report_id', p_report_id,
      'report_updated_at', v_report.updated_at,
      'correction_audit_id', p_correction_audit_id,
      'original_supplier_notification_id', v_supplier.id,
      'original_warehouse_notification_id', v_warehouse.id,
      'vehicle', jsonb_build_object(
        'total_quantity', v_new_vehicle,
        'exchange_quantity', v_total_exchange,
        'makeup_quantity', v_total_makeup,
        'extra_quantity', v_total_makeup + v_total_exchange,
        'physical_quantity', v_total_physical,
        'locations', v_corrected_supplier_locations
      ),
      'supplier', jsonb_build_object(
        'name', 'BMQ - HKD Tuyết Anh',
        'physical_quantity', v_total_bmq,
        'billable_quantity', v_supplier_billable,
        'credit_quantity', v_total_credit,
        'exchange_quantity', v_supplier_exchange,
        'makeup_quantity', v_supplier_makeup,
        'credit_handling', 'ordered_from_supplier_and_credited_to_bakery_payable'
      ),
      'supplier_totals', jsonb_build_object(
        'dealer_ordered_quantity', v_dealer_ordered,
        'dealer_exchange_quantity', v_dealer_exchange,
        'dealer_makeup_quantity', v_dealer_makeup,
        'dealer_extra_quantity', v_dealer_extra,
        'dealer_physical_quantity', v_dealer,
        'supplier_billable_quantity', v_supplier_billable,
        'supplier_credit_quantity', v_total_credit,
        'supplier_exchange_quantity', v_supplier_exchange,
        'supplier_makeup_quantity', v_supplier_makeup,
        'vehicle_quantity', v_new_vehicle,
        'vehicle_exchange_quantity', v_total_exchange,
        'vehicle_makeup_quantity', v_total_makeup,
        'vehicle_extra_quantity', v_total_makeup + v_total_exchange,
        'raw_total_bmq', v_raw_total_bmq,
        'total_bmq', v_total_bmq,
        'vietjet', v_vietjet
      )
    ),
    'pending_owner_review', 0, 5, now()
  ) on conflict ((source_snapshot->>'idempotency_key'))
      where notification_type = 'production_bread_order_correction' and source_snapshot ? 'idempotency_key'
    do nothing;
  get diagnostics v_row_count = row_count;
  v_inserted := v_inserted + v_row_count;

  insert into public.dealer_order_notifications (
    order_id, notification_type, digest_date, channel, group_name, message_body,
    source_snapshot, status, attempt_count, max_attempts, next_attempt_at
  ) values (
    null, 'production_bread_order_correction', v_order_date, 'zalo_gmf', 'BMQ - Kho Tân Tạo',
    concat(
      'ĐIỀU CHỈNH GIAO BÁNH KHO - THAY THẾ TOÀN BỘ', E'\n',
      'Chênh lệch điểm bị sửa (', coalesce(v_location.location_name, v_location.location_code), '): ',
      to_char(abs(v_new_location - v_old_location_quantity), 'FM999999999990.###'), ' que ',
      case when v_new_location >= v_old_location_quantity then 'tăng' else 'giảm' end, E'\n',
      'Tổng đúng sau chỉnh sửa:', E'\n',
      'ĐẶT BÁNH ', extract(day from v_order_date)::int, '/', extract(month from v_order_date)::int, E'\n\n',
      v_warehouse_lines, E'\n\n',
      'Tổng đặt mới: ', to_char(v_new_vehicle, 'FM999999999990.###'), ' que', E'\n',
      'Tổng bù: ', to_char(v_total_makeup, 'FM999999999990.###'), ' que', E'\n',
      'Tổng đổi: ', to_char(v_total_exchange, 'FM999999999990.###'), ' que', E'\n',
      'KHO CẦN GIAO: ', to_char(v_total_physical, 'FM999999999990.###'), ' QUE'
    ),
    jsonb_build_object(
      'approved_by_owner', false,
      'approval_status', 'pending_owner_review',
      'full_replacement', true,
      'idempotency_key', v_warehouse_key,
      'report_id', p_report_id,
      'report_updated_at', v_report.updated_at,
      'correction_audit_id', p_correction_audit_id,
      'original_supplier_notification_id', v_supplier.id,
      'original_warehouse_notification_id', v_warehouse.id,
      'corrected_locations', v_corrected_locations,
      'warehouse_totals', jsonb_build_object(
        'total_ordered', v_new_vehicle,
        'total_makeup', v_total_makeup,
        'total_exchange', v_total_exchange,
        'total_physical', v_total_physical
      )
    ),
    'pending_owner_review', 0, 5, now()
  ) on conflict ((source_snapshot->>'idempotency_key'))
      where notification_type = 'production_bread_order_correction' and source_snapshot ? 'idempotency_key'
    do nothing;
  get diagnostics v_row_count = row_count;
  v_inserted := v_inserted + v_row_count;

  return v_inserted;
end;
$$;