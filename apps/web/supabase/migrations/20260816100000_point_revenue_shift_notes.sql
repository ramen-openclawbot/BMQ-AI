begin;

drop function if exists public.get_kiosk_point_revenue_reviews(date, date, uuid, text);

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
  report_notes text,
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
    report.notes,
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

revoke all on function public.get_kiosk_point_revenue_reviews(date, date, uuid, text) from public;
revoke all on function public.get_kiosk_point_revenue_reviews(date, date, uuid, text) from anon;
revoke all on function public.get_kiosk_point_revenue_reviews(date, date, uuid, text) from authenticated;
grant execute on function public.get_kiosk_point_revenue_reviews(date, date, uuid, text)
  to authenticated;

commit;
