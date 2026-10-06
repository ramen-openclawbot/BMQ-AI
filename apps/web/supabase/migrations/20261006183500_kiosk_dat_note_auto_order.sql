-- DAT note auto-order: a submitted report note that carries exactly one explicit
-- bread-order quantity ("DAT 30", "Đặt bánh (mì) 40", "Order bánh 50 que") now
-- auto-applies to the next day's BMQ-001 vehicle order for that location.
--
-- Scope is intentionally narrow:
--   * only service_role can read/write these objects (grants and RLS unchanged);
--   * only the report's own submitted note is used, never Hotline/revenue lines;
--   * lunar day 30 closure still wins over any note quantity.
--
-- The proposal audit trail and the fixed/dynamic BHN policies keep working as
-- before for locations without an explicit DAT note.

-- Allow the new auto_applied proposal status. The confirm check keeps requiring
-- an actor for operator-confirmed rows and explicitly allows auto_applied rows
-- (which are written by the service-role save RPC without confirmed_by).
alter table public.kiosk_bread_order_note_proposals
  drop constraint if exists kiosk_bread_order_note_proposals_proposal_status_check;
alter table public.kiosk_bread_order_note_proposals
  add constraint kiosk_bread_order_note_proposals_proposal_status_check
  check (
    proposal_status in (
      'pending_operator_confirmation',
      'confirmed',
      'rejected',
      'superseded',
      'auto_applied'
    )
  );

alter table public.kiosk_bread_order_note_proposals
  drop constraint if exists kiosk_bread_order_note_proposals_confirm_check;
alter table public.kiosk_bread_order_note_proposals
  add constraint kiosk_bread_order_note_proposals_confirm_check
  check (
    (proposal_status <> 'confirmed' or (confirmed_by is not null and confirmed_at is not null))
    and (proposal_status <> 'auto_applied' or confirmed_by is null)
  );

drop index if exists public.kiosk_bread_order_note_proposals_report_rule_unique;
create unique index if not exists kiosk_bread_order_note_proposals_report_rule_unique
  on public.kiosk_bread_order_note_proposals (report_id, parser_rule)
  where proposal_status in ('pending_operator_confirmation', 'confirmed', 'auto_applied');

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
  v_requires_confirmation boolean;
  v_target_status text;
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

  v_requires_confirmation := coalesce((p_evidence ->> 'requires_confirmation')::boolean, true);
  v_target_status := case
    when not v_requires_confirmation
      or coalesce(p_evidence ->> 'proposal_status', p_evidence ->> 'status') = 'auto_applied'
    then 'auto_applied'
    else 'pending_operator_confirmation'
  end;

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
    and proposal_status in ('pending_operator_confirmation', 'confirmed', 'auto_applied')
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
    v_target_status,
    v_requires_confirmation
  )
  on conflict (report_id, parser_rule)
    where proposal_status in ('pending_operator_confirmation', 'confirmed', 'auto_applied')
  do update set
    location_id = excluded.location_id,
    report_date = excluded.report_date,
    proposed_quantity = excluded.proposed_quantity,
    evidence = excluded.evidence,
    proposal_status = case
      when public.kiosk_bread_order_note_proposals.proposal_status = 'confirmed' then 'confirmed'
      else excluded.proposal_status
    end,
    requires_confirmation = case
      when public.kiosk_bread_order_note_proposals.proposal_status = 'confirmed'
        then public.kiosk_bread_order_note_proposals.requires_confirmation
      else excluded.requires_confirmation
    end,
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
-- When the proposal evidence says auto_applied (submitted report with one clear
-- DAT quantity), the row is stored as auto_applied without confirmed_by.
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
  v_auto_applied boolean;
  v_target_status text;
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
    v_auto_applied := coalesce((v_evidence ->> 'requires_confirmation')::boolean, true) = false
      or coalesce(v_evidence ->> 'proposal_status', v_evidence ->> 'status') = 'auto_applied';
    v_target_status := case when v_auto_applied then 'auto_applied' else 'pending_operator_confirmation' end;
  end if;

  -- Removed/ambiguous notes and changed proposals supersede every stale active
  -- row. Confirmed evidence is immutable and handled separately below.
  for v_pending in
    select * from public.kiosk_bread_order_note_proposals
    where report_id = v_report_id
      and proposal_status in ('pending_operator_confirmation', 'auto_applied')
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

  -- An unchanged active row is an exact idempotent replay: no update/audit.
  if exists (
    select 1 from public.kiosk_bread_order_note_proposals proposal
    where proposal.report_id = v_report_id
      and proposal.parser_rule = v_parser_rule
      and proposal.proposal_status = v_target_status
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
    v_parser_rule, v_evidence, v_target_status, not v_auto_applied
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

-- Vehicle-bread history used by the notification worker. The new
-- note_order_quantity column is the auto_applied DAT quantity of that submitted
-- report (latest such proposal), or null when the note did not auto-apply.
drop function if exists public.get_daily_bread_vehicle_history(date);

create function public.get_daily_bread_vehicle_history(p_cutoff_date date)
returns table (
  report_id uuid,
  location_id uuid,
  location_code text,
  report_date date,
  report_updated_at timestamptz,
  sold_quantity numeric,
  closing_quantity numeric,
  bread_row_present boolean,
  note_order_quantity numeric
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  return query
  with active_locations as (
    select location.id, location.location_code
    from public.kiosk_report_locations location
    where location.active = true
      and coalesce(location.location_code, '') not ilike 'TEST%'
  ),
  ranked as (
    select
      report.id as report_id,
      location.id as location_id,
      location.location_code,
      report.report_date,
      report.updated_at as report_updated_at,
      inventory.sold_quantity,
      inventory.closing_quantity,
      (inventory.report_id is not null) as bread_row_present,
      auto_note.note_order_quantity,
      row_number() over (partition by report.location_id order by report.report_date desc, report.updated_at desc, report.id desc) as report_rank
    from active_locations location
    join public.kiosk_daily_reports report
      on report.location_id = location.id
     and report.status = 'submitted'
     and report.report_date <= p_cutoff_date
    left join public.kiosk_daily_report_inventory_rows inventory
      on inventory.report_id = report.id
     and inventory.product_code = 'banh_mi_que'
    left join lateral (
      select proposal.proposed_quantity as note_order_quantity
      from public.kiosk_bread_order_note_proposals proposal
      where proposal.report_id = report.id
        and proposal.proposal_status = 'auto_applied'
      order by proposal.updated_at desc, proposal.id desc
      limit 1
    ) auto_note on true
    where inventory.report_id is not null
       or location.location_code = 'HCM004-BHN'
  )
  select ranked.report_id, location.id, location.location_code, ranked.report_date,
         ranked.report_updated_at, ranked.sold_quantity, ranked.closing_quantity,
         coalesce(ranked.bread_row_present, false), ranked.note_order_quantity
  from active_locations location
  left join ranked
    on ranked.location_id = location.id
   and ranked.report_rank <= 7
  order by location.location_code, ranked.report_date desc nulls last;
end;
$$;

revoke all on function public.get_daily_bread_vehicle_history(date) from public, anon, authenticated;
grant execute on function public.get_daily_bread_vehicle_history(date) to service_role;
