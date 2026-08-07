-- Accountant-controlled point revenue review layer.
-- Submitted kiosk reports remain immutable; corrections are stored separately and fully audited.

create table if not exists public.kiosk_point_revenue_reviews (
  report_id uuid primary key references public.kiosk_daily_reports(id) on delete restrict,
  review_status text not null default 'in_review',
  review_note text,
  reviewed_by uuid references auth.users(id) on delete set null,
  reviewed_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint kiosk_point_revenue_reviews_status_check
    check (review_status in ('in_review', 'reviewed')),
  constraint kiosk_point_revenue_reviews_note_length_check
    check (review_note is null or length(review_note) <= 2000),
  constraint kiosk_point_revenue_reviews_reviewed_check
    check (
      (review_status = 'reviewed' and reviewed_at is not null)
      or (review_status = 'in_review' and reviewed_by is null and reviewed_at is null)
    )
);

create table if not exists public.kiosk_point_revenue_adjustments (
  report_id uuid not null references public.kiosk_daily_reports(id) on delete restrict,
  channel_code text not null references public.kiosk_report_channels(code) on delete restrict,
  source_channel_row_id uuid not null references public.kiosk_daily_report_channel_rows(id) on delete restrict,
  source_amount_vnd_snapshot numeric(14,2) not null,
  corrected_amount_vnd numeric(14,2) not null,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (report_id, channel_code),
  constraint kiosk_point_revenue_adjustments_source_unique unique (source_channel_row_id),
  constraint kiosk_point_revenue_adjustments_nonnegative_check
    check (source_amount_vnd_snapshot >= 0 and corrected_amount_vnd >= 0),
  constraint kiosk_point_revenue_adjustments_integer_vnd_check
    check (corrected_amount_vnd = trunc(corrected_amount_vnd))
);

create table if not exists public.kiosk_point_revenue_audit_logs (
  id uuid primary key default gen_random_uuid(),
  report_id uuid not null references public.kiosk_daily_reports(id) on delete restrict,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null,
  before_payload jsonb not null default '{}'::jsonb,
  after_payload jsonb not null default '{}'::jsonb,
  note text,
  created_at timestamptz not null default now(),
  constraint kiosk_point_revenue_audit_logs_action_check
    check (action in ('save_review', 'mark_reviewed')),
  constraint kiosk_point_revenue_audit_logs_note_length_check
    check (note is null or length(note) <= 2000)
);

create index if not exists kiosk_point_revenue_reviews_status_idx
  on public.kiosk_point_revenue_reviews (review_status, updated_at desc);
create index if not exists kiosk_point_revenue_audit_report_idx
  on public.kiosk_point_revenue_audit_logs (report_id, created_at desc);
create index if not exists kiosk_point_revenue_audit_actor_idx
  on public.kiosk_point_revenue_audit_logs (actor_id, created_at desc);

alter table public.kiosk_point_revenue_reviews enable row level security;
alter table public.kiosk_point_revenue_adjustments enable row level security;
alter table public.kiosk_point_revenue_audit_logs enable row level security;

revoke all on table public.kiosk_point_revenue_reviews from anon, authenticated;
revoke all on table public.kiosk_point_revenue_adjustments from anon, authenticated;
revoke all on table public.kiosk_point_revenue_audit_logs from anon, authenticated;

create or replace function public.get_kiosk_point_revenue_reviews(
  p_start_date date default current_date - 30,
  p_end_date date default current_date,
  p_location_id uuid default null,
  p_review_status text default null
)
returns table (
  report_id uuid,
  report_date date,
  location_id uuid,
  location_name text,
  staff_name text,
  submitted_at timestamptz,
  review_status text,
  reviewed_at timestamptz,
  reviewed_by_name text,
  review_note text,
  channels jsonb
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if not (
    public.has_role(v_actor, 'owner')
    or public.has_module_permission(v_actor, 'finance_revenue', 'view')
    or public.has_module_permission(v_actor, 'finance_revenue', 'edit')
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_start_date is null
    or p_end_date is null
    or p_start_date > p_end_date
    or p_end_date - p_start_date > 366 then
    raise exception 'invalid_point_revenue_date_range' using errcode = '22023';
  end if;

  if p_review_status is not null
    and p_review_status not in ('unreviewed', 'in_review', 'reviewed') then
    raise exception 'invalid_point_revenue_review_status' using errcode = '22023';
  end if;

  return query
  select
    report.id,
    report.report_date,
    report.location_id,
    report.location_name_snapshot,
    report.staff_name_snapshot,
    report.submitted_at,
    coalesce(review.review_status, 'unreviewed'),
    review.reviewed_at,
    coalesce(nullif(profile.full_name, ''), profile.email),
    review.review_note,
    coalesce(channel_data.channels, '[]'::jsonb)
  from public.kiosk_daily_reports report
  left join public.kiosk_point_revenue_reviews review
    on review.report_id = report.id
  left join public.profiles profile
    on profile.user_id = review.reviewed_by
  left join lateral (
    select jsonb_agg(
      jsonb_build_object(
        'channel_code', source.channel_code,
        'channel_name', source.channel_name_snapshot,
        'quantity', source.quantity,
        'source_amount_vnd', source.amount_vnd,
        'effective_amount_vnd', coalesce(adjustment.corrected_amount_vnd, source.amount_vnd),
        'corrected', adjustment.report_id is not null
      )
      order by source.channel_code
    ) as channels
    from public.kiosk_daily_report_channel_rows source
    left join public.kiosk_point_revenue_adjustments adjustment
      on adjustment.report_id = source.report_id
     and adjustment.channel_code = source.channel_code
    where source.report_id = report.id
  ) channel_data on true
  where report.status = 'submitted'
    and report.report_date between p_start_date and p_end_date
    and (p_location_id is null or report.location_id = p_location_id)
    and (
      p_review_status is null
      or coalesce(review.review_status, 'unreviewed') = p_review_status
    )
  order by report.report_date desc, report.location_name_snapshot asc;
end;
$$;

create or replace function public.get_kiosk_point_revenue_audit(
  p_report_id uuid
)
returns table (
  id uuid,
  action text,
  before_payload jsonb,
  after_payload jsonb,
  note text,
  created_at timestamptz,
  actor_name text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
begin
  if v_actor is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if not (
    public.has_role(v_actor, 'owner')
    or public.has_module_permission(v_actor, 'finance_revenue', 'view')
    or public.has_module_permission(v_actor, 'finance_revenue', 'edit')
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if not exists (
    select 1
    from public.kiosk_daily_reports report
    where report.id = p_report_id
      and report.status = 'submitted'
  ) then
    raise exception 'point_revenue_report_not_found' using errcode = 'P0002';
  end if;

  return query
  select
    audit.id,
    audit.action,
    audit.before_payload,
    audit.after_payload,
    audit.note,
    audit.created_at,
    coalesce(nullif(profile.full_name, ''), profile.email, 'Người dùng đã ngưng hoạt động')
  from public.kiosk_point_revenue_audit_logs audit
  left join public.profiles profile
    on profile.user_id = audit.actor_id
  where audit.report_id = p_report_id
  order by audit.created_at desc, audit.id desc;
end;
$$;

create or replace function public.save_kiosk_point_revenue_review(
  p_report_id uuid,
  p_channel_amounts jsonb,
  p_review_status text default 'in_review',
  p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  v_report public.kiosk_daily_reports;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_expected_count integer;
  v_input_count integer;
  v_before jsonb;
  v_after jsonb;
  v_action text;
begin
  if v_actor is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;

  if not (
    public.has_role(v_actor, 'owner')
    or public.has_module_permission(v_actor, 'finance_revenue', 'edit')
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_review_status not in ('in_review', 'reviewed') then
    raise exception 'invalid_point_revenue_review_status' using errcode = '22023';
  end if;

  if v_note is not null and length(v_note) > 2000 then
    raise exception 'point_revenue_note_too_long' using errcode = '22023';
  end if;

  if p_channel_amounts is null or jsonb_typeof(p_channel_amounts) <> 'object' then
    raise exception 'invalid_point_revenue_channel_amounts' using errcode = '22023';
  end if;

  select report.*
    into v_report
  from public.kiosk_daily_reports report
  where report.id = p_report_id
  for update;

  if not found or v_report.status <> 'submitted' then
    raise exception 'point_revenue_report_not_submitted' using errcode = 'P0002';
  end if;

  select count(*)
    into v_expected_count
  from public.kiosk_daily_report_channel_rows source
  where source.report_id = p_report_id;

  select count(*)
    into v_input_count
  from jsonb_each_text(p_channel_amounts) input
  join public.kiosk_daily_report_channel_rows source
    on source.report_id = p_report_id
   and source.channel_code = input.key
  where input.value ~ '^\d+(\.0{1,2})?$'
    and input.value::numeric >= 0
    and input.value::numeric <= 999999999999
    and input.value::numeric = trunc(input.value::numeric);

  if v_expected_count = 0 or v_input_count <> v_expected_count
    or (select count(*) from jsonb_object_keys(p_channel_amounts)) <> v_expected_count then
    raise exception 'invalid_point_revenue_channel_amounts' using errcode = '22023';
  end if;

  select jsonb_build_object(
    'review_status', coalesce(review.review_status, 'unreviewed'),
    'review_note', review.review_note,
    'reviewed_by', review.reviewed_by,
    'reviewed_at', review.reviewed_at,
    'channels', coalesce(jsonb_object_agg(
      source.channel_code,
      coalesce(adjustment.corrected_amount_vnd, source.amount_vnd)
      order by source.channel_code
    ), '{}'::jsonb)
  )
    into v_before
  from public.kiosk_daily_report_channel_rows source
  left join public.kiosk_point_revenue_adjustments adjustment
    on adjustment.report_id = source.report_id
   and adjustment.channel_code = source.channel_code
  left join public.kiosk_point_revenue_reviews review
    on review.report_id = source.report_id
  where source.report_id = p_report_id
  group by review.review_status, review.review_note, review.reviewed_by, review.reviewed_at;

  insert into public.kiosk_point_revenue_reviews (
    report_id,
    review_status,
    review_note,
    reviewed_by,
    reviewed_at,
    created_by,
    updated_by,
    created_at,
    updated_at
  ) values (
    p_report_id,
    p_review_status,
    v_note,
    case when p_review_status = 'reviewed' then v_actor else null end,
    case when p_review_status = 'reviewed' then now() else null end,
    v_actor,
    v_actor,
    now(),
    now()
  )
  on conflict (report_id) do update
  set review_status = excluded.review_status,
      review_note = excluded.review_note,
      reviewed_by = excluded.reviewed_by,
      reviewed_at = excluded.reviewed_at,
      updated_by = excluded.updated_by,
      updated_at = now();

  insert into public.kiosk_point_revenue_adjustments (
    report_id,
    channel_code,
    source_channel_row_id,
    source_amount_vnd_snapshot,
    corrected_amount_vnd,
    updated_by,
    created_at,
    updated_at
  )
  select
    source.report_id,
    source.channel_code,
    source.id,
    source.amount_vnd,
    input.value::numeric,
    v_actor,
    now(),
    now()
  from jsonb_each_text(p_channel_amounts) input
  join public.kiosk_daily_report_channel_rows source
    on source.report_id = p_report_id
   and source.channel_code = input.key
  where input.value::numeric <> source.amount_vnd
  on conflict (report_id, channel_code) do update
  set source_channel_row_id = excluded.source_channel_row_id,
      source_amount_vnd_snapshot = excluded.source_amount_vnd_snapshot,
      corrected_amount_vnd = excluded.corrected_amount_vnd,
      updated_by = excluded.updated_by,
      updated_at = now();

  delete from public.kiosk_point_revenue_adjustments adjustment
  using public.kiosk_daily_report_channel_rows source
  where adjustment.report_id = p_report_id
    and source.report_id = adjustment.report_id
    and source.channel_code = adjustment.channel_code
    and (p_channel_amounts ->> adjustment.channel_code)::numeric = source.amount_vnd;

  select jsonb_build_object(
    'review_status', review.review_status,
    'review_note', review.review_note,
    'reviewed_by', review.reviewed_by,
    'reviewed_at', review.reviewed_at,
    'channels', coalesce(jsonb_object_agg(
      source.channel_code,
      coalesce(adjustment.corrected_amount_vnd, source.amount_vnd)
      order by source.channel_code
    ), '{}'::jsonb)
  )
    into v_after
  from public.kiosk_daily_report_channel_rows source
  join public.kiosk_point_revenue_reviews review
    on review.report_id = source.report_id
  left join public.kiosk_point_revenue_adjustments adjustment
    on adjustment.report_id = source.report_id
   and adjustment.channel_code = source.channel_code
  where source.report_id = p_report_id
  group by review.review_status, review.review_note, review.reviewed_by, review.reviewed_at;

  if v_before is distinct from v_after then
    v_action := case when p_review_status = 'reviewed' then 'mark_reviewed' else 'save_review' end;

    insert into public.kiosk_point_revenue_audit_logs (
      report_id,
      actor_id,
      action,
      before_payload,
      after_payload,
      note
    ) values (
      p_report_id,
      v_actor,
      v_action,
      coalesce(v_before, '{}'::jsonb),
      coalesce(v_after, '{}'::jsonb),
      v_note
    );
  end if;

  return jsonb_build_object(
    'report_id', p_report_id,
    'review_status', p_review_status,
    'updated_at', now()
  );
end;
$$;

revoke all on function public.get_kiosk_point_revenue_reviews(date, date, uuid, text) from public, anon, authenticated;
revoke all on function public.get_kiosk_point_revenue_audit(uuid) from public, anon, authenticated;
revoke all on function public.save_kiosk_point_revenue_review(uuid, jsonb, text, text) from public, anon, authenticated;

grant execute on function public.get_kiosk_point_revenue_reviews(date, date, uuid, text) to authenticated;
grant execute on function public.get_kiosk_point_revenue_audit(uuid) to authenticated;
grant execute on function public.save_kiosk_point_revenue_review(uuid, jsonb, text, text) to authenticated;
