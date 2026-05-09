-- Daily revenue review: safe edit metadata + append-only audit for auto-parse drafts.

alter table public.revenue_drafts
  add column if not exists raw_payload jsonb not null default '{}'::jsonb;

create table if not exists public.revenue_draft_daily_review_audit_logs (
  id uuid primary key default gen_random_uuid(),
  revenue_draft_id uuid not null references public.revenue_drafts(id) on delete restrict,
  actor_id uuid not null references auth.users(id) on delete restrict,
  before_amount numeric,
  after_amount numeric not null,
  before_status text,
  after_status text not null,
  note text,
  marked_exception boolean not null default false,
  before_payload jsonb not null default '{}'::jsonb,
  after_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.revenue_draft_daily_review_audit_logs enable row level security;

create policy "finance_revenue_daily_review_audit_select"
  on public.revenue_draft_daily_review_audit_logs
  for select
  to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'finance_revenue', 'view')
  );

create or replace function public.edit_revenue_draft_daily_review(
  _draft_id uuid,
  _amount numeric,
  _note text default null,
  _mark_exception boolean default false
)
returns public.revenue_drafts
language plpgsql
security definer
set search_path = public
as $$
declare
  _actor uuid := auth.uid();
  _before public.revenue_drafts%rowtype;
  _after public.revenue_drafts%rowtype;
  _before_payload jsonb;
  _after_payload jsonb;
begin
  if _actor is null then
    raise exception 'Not authenticated' using errcode = '28000';
  end if;

  if not (
    public.has_role(_actor, 'owner')
    or public.has_module_permission(_actor, 'finance_revenue', 'edit')
  ) then
    raise exception 'Forbidden: finance revenue edit permission required' using errcode = '42501';
  end if;

  if _amount is null or _amount < 0 then
    raise exception 'Invalid amount' using errcode = '22023';
  end if;

  select * into _before
  from public.revenue_drafts
  where id = _draft_id
  for update;

  if not found then
    raise exception 'Revenue draft not found' using errcode = 'P0002';
  end if;

  _before_payload := coalesce(_before.raw_payload, '{}'::jsonb);
  _after_payload := jsonb_set(
    _before_payload,
    '{daily_review}',
    coalesce(_before_payload->'daily_review', '{}'::jsonb) || jsonb_build_object(
      'edited_by', _actor,
      'edited_at', now(),
      'edited_amount', _amount,
      'review_note', nullif(_note, ''),
      'marked_exception', coalesce(_mark_exception, false),
      'previous_amount', _before.total_amount,
      'previous_status', _before.status
    ),
    true
  );

  update public.revenue_drafts
  set
    total_amount = _amount,
    status = case when coalesce(_mark_exception, false) then 'exception' else coalesce(status, 'pending') end,
    raw_payload = _after_payload,
    updated_at = now()
  where id = _draft_id
  returning * into _after;

  insert into public.revenue_draft_daily_review_audit_logs (
    revenue_draft_id,
    actor_id,
    before_amount,
    after_amount,
    before_status,
    after_status,
    note,
    marked_exception,
    before_payload,
    after_payload
  ) values (
    _draft_id,
    _actor,
    _before.total_amount,
    _after.total_amount,
    _before.status,
    _after.status,
    nullif(_note, ''),
    coalesce(_mark_exception, false),
    _before_payload,
    coalesce(_after.raw_payload, '{}'::jsonb)
  );

  return _after;
end;
$$;

revoke all on function public.edit_revenue_draft_daily_review(uuid, numeric, text, boolean) from public;
grant execute on function public.edit_revenue_draft_daily_review(uuid, numeric, text, boolean) to authenticated;
