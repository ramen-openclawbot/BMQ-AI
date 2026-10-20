-- Sushi tự phân loại khoản chi theo danh mục chi phí.
--
-- Additive only. This migration:
--   (a) allows classification_source 'sushi' on cost_line_classifications;
--   (b) allows kind 'cost_category' on robot_feedback and robot_auto_actions;
--   (c) adds the Sushi cost switch / threshold / daily cap to robot_settings;
--   (d) registers the 'sushi-cost' worker secret used by the pg_cron job;
--   (e) adds the audited service-role writer robot_apply_cost_classification;
--   (f) captures a human manual_override of a Sushi row in robot_feedback;
--   (g) adds the service-role candidate / feedback readers;
--   (h) schedules the pg_cron worker four times each morning, 05:00, 05:15,
--       05:30 and 05:45 Asia/Saigon (22:00-22:45 UTC), 50 lines per run, so the
--       200-line daily cap is reached while the backlog lasts.
--
-- Nothing here inserts, updates or deletes a payment, invoice, cost
-- classification or robot business row at migration top level. The only
-- top-level write is the robot_worker_config secret row (generated in SQL).
--
-- cost_categories has no allocation_rule in Phase 1; the additive nullable
-- column below lets a category carry its own default. Existing rows keep null
-- and robot_apply_cost_classification derives the same defaults the seeded
-- rules use (cogs -> direct, packaging -> manual, everything else -> none).

-- ===========================================================================
-- 1. Constraint replacements: keep every old value, add only the new one
-- ===========================================================================

alter table public.cost_line_classifications
  drop constraint if exists cost_line_classifications_classification_source_check;
alter table public.cost_line_classifications
  add constraint cost_line_classifications_classification_source_check
  check (classification_source in (
    'rule', 'supplier_mapping', 'item_mapping', 'sku_mapping', 'manual_override', 'fallback', 'sushi'
  ));

alter table public.robot_feedback
  drop constraint if exists robot_feedback_kind_check;
alter table public.robot_feedback
  add constraint robot_feedback_kind_check
  check (kind in (
    'alias', 'catalog_merge', 'catalog_class', 'finance_duplicate', 'routing', 'debt_mark', 'cost_category'
  ));

alter table public.robot_auto_actions
  drop constraint if exists robot_auto_actions_kind_check;
alter table public.robot_auto_actions
  add constraint robot_auto_actions_kind_check
  check (kind in ('alias', 'catalog_class', 'cost_category'));

alter table public.cost_classification_audit_logs
  drop constraint if exists cost_classification_audit_logs_action_check;
alter table public.cost_classification_audit_logs
  add constraint cost_classification_audit_logs_action_check
  check (action in (
    'created_by_backfill', 'updated_by_rule_refresh', 'manual_override', 'review_approved', 'review_rejected',
    'created_by_sushi', 'updated_by_sushi'
  ));

-- ===========================================================================
-- 2. Category allocation default + robot_settings cost columns
-- ===========================================================================

alter table public.cost_categories
  add column if not exists allocation_rule text
  check (allocation_rule is null or allocation_rule in ('direct', 'manual', 'none'));

alter table public.robot_settings
  add column if not exists cost_threshold numeric not null default 0.95
    check (cost_threshold >= 0 and cost_threshold <= 1),
  add column if not exists cost_daily_cap integer not null default 200
    check (cost_daily_cap >= 0),
  add column if not exists cost_auto_enabled boolean not null default true;

-- ===========================================================================
-- 3. The worker secret used by the pg_cron job
-- ===========================================================================

create table if not exists public.robot_worker_config (
  id text primary key,
  worker_secret uuid not null default gen_random_uuid(),
  created_at timestamptz default now()
);

insert into public.robot_worker_config (id) values ('sushi-cost') on conflict (id) do nothing;

alter table public.robot_worker_config enable row level security;

revoke all on public.robot_worker_config from public, anon, authenticated;
grant all on public.robot_worker_config to service_role;

-- ===========================================================================
-- 4. robot_apply_cost_classification: the only Sushi cost writer
-- ===========================================================================

create or replace function public.robot_apply_cost_classification(
  p_source_type text,
  p_source_line_id uuid,
  p_category_code text,
  p_probability numeric,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_category public.cost_categories%rowtype;
  v_settings public.robot_settings%rowtype;
  v_existing public.cost_line_classifications%rowtype;
  v_written public.cost_line_classifications%rowtype;
  v_before jsonb;
  v_payment_request_id uuid;
  v_invoice_id uuid;
  v_supplier_id uuid;
  v_product_name text;
  v_subject_key text;
  v_review_status text;
  v_exists boolean;
  v_today_count integer;
  v_action_id uuid;
  v_allocation_rule text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'robot_apply_cost_classification requires service role' using errcode = '42501';
  end if;

  if p_source_type is null or p_source_type not in ('payment_request_item', 'invoice_item') then
    return jsonb_build_object('status', 'skipped', 'reason', 'invalid_source_type');
  end if;
  if p_probability is null or p_probability < 0 or p_probability > 1 then
    return jsonb_build_object('status', 'skipped', 'reason', 'invalid_probability');
  end if;

  if p_source_type = 'payment_request_item' then
    select pri.payment_request_id, pr.supplier_id, pri.product_name
      into v_payment_request_id, v_supplier_id, v_product_name
    from public.payment_request_items pri
    join public.payment_requests pr on pr.id = pri.payment_request_id
    where pri.id = p_source_line_id;
  else
    select ii.invoice_id,
           coalesce(inv.supplier_id, pr.supplier_id),
           ii.product_name
      into v_invoice_id, v_supplier_id, v_product_name
    from public.invoice_items ii
    join public.invoices inv on inv.id = ii.invoice_id
    left join public.payment_requests pr on pr.id = inv.payment_request_id
    where ii.id = p_source_line_id;
  end if;
  if not found or v_product_name is null then
    return jsonb_build_object('status', 'skipped', 'reason', 'line_not_found');
  end if;

  select * into v_category
  from public.cost_categories cc
  where cc.code = p_category_code
    and cc.is_active;
  if not found then
    return jsonb_build_object('status', 'skipped', 'reason', 'invalid_category');
  end if;

  -- Lock any existing row before the manual_override / approved gate.
  select * into v_existing
  from public.cost_line_classifications clc
  where clc.source_type = p_source_type
    and clc.source_line_id = p_source_line_id
  for update;
  v_exists := found;

  if v_exists and (
    v_existing.classification_source = 'manual_override'
    or v_existing.review_status = 'approved'
  ) then
    return jsonb_build_object('status', 'skipped', 'reason', 'manual_override_or_approved');
  end if;

  v_before := case when v_exists then to_jsonb(v_existing) else null end;

  select * into v_settings from public.robot_settings where id = true;
  if not found then
    v_settings.cost_daily_cap := 200;
    v_settings.cost_threshold := 0.95;
    v_settings.cost_auto_enabled := true;
  end if;

  select count(*) into v_today_count
  from public.robot_auto_actions a
  where a.kind = 'cost_category'
    and a.status = 'applied'
    and (a.applied_at at time zone 'Asia/Ho_Chi_Minh')::date
        = (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  if v_today_count >= v_settings.cost_daily_cap then
    return jsonb_build_object('status', 'cap_reached');
  end if;

  v_review_status := case
    when p_category_code <> 'UNMAPPED_REVIEW' then 'suggested'
    else 'needs_review'
  end;
  v_allocation_rule := coalesce(
    v_category.allocation_rule,
    case v_category.cost_group
      when 'cogs' then 'direct'
      when 'packaging' then 'manual'
      else 'none'
    end
  );
  v_subject_key := lower(
    coalesce(v_supplier_id::text, '') || '|' ||
    coalesce(public.normalize_stock_item_name(v_product_name), '')
  );

  if v_exists then
    update public.cost_line_classifications
    set
      payment_request_id = v_payment_request_id,
      invoice_id = v_invoice_id,
      supplier_id = coalesce(v_supplier_id, v_existing.supplier_id),
      category_code = p_category_code,
      product_line = v_category.product_line,
      allocation_rule = v_allocation_rule,
      confidence = p_probability,
      classification_source = 'sushi',
      rule_id = null,
      review_status = v_review_status,
      note = p_note,
      updated_at = now()
    where id = v_existing.id
    returning * into v_written;
  else
    insert into public.cost_line_classifications (
      source_type,
      source_line_id,
      payment_request_id,
      invoice_id,
      supplier_id,
      category_code,
      product_line,
      revenue_channel,
      allocation_rule,
      confidence,
      classification_source,
      rule_id,
      review_status,
      note
    ) values (
      p_source_type,
      p_source_line_id,
      v_payment_request_id,
      v_invoice_id,
      v_supplier_id,
      p_category_code,
      v_category.product_line,
      null,
      v_allocation_rule,
      p_probability,
      'sushi',
      null,
      v_review_status,
      p_note
    )
    returning * into v_written;
  end if;

  insert into public.cost_classification_audit_logs (
    classification_id,
    source_type,
    source_line_id,
    action,
    before,
    after,
    reason,
    actor_id
  ) values (
    v_written.id,
    p_source_type,
    p_source_line_id,
    case when v_before is null then 'created_by_sushi' else 'updated_by_sushi' end,
    v_before,
    to_jsonb(v_written),
    coalesce(p_note, 'sushi_cost_classification'),
    null
  );

  insert into public.robot_auto_actions (
    kind, subject_key, target, robot_probability, payload, status
  ) values (
    'cost_category',
    v_subject_key,
    jsonb_build_object(
      'source_type', p_source_type,
      'source_line_id', p_source_line_id,
      'category_code', p_category_code,
      'classification_id', v_written.id
    ),
    p_probability,
    jsonb_build_object(
      'before', v_before,
      'after', to_jsonb(v_written),
      'note', p_note
    ),
    'applied'
  )
  returning id into v_action_id;

  return jsonb_build_object(
    'status', 'applied',
    'classification_id', v_written.id,
    'action_id', v_action_id,
    'category_code', v_written.category_code,
    'review_status', v_written.review_status
  );
end;
$$;

revoke all on function public.robot_apply_cost_classification(text, uuid, text, numeric, text)
  from public, anon, authenticated;
grant execute on function public.robot_apply_cost_classification(text, uuid, text, numeric, text)
  to service_role;

-- ===========================================================================
-- 5. Human manual_override of a Sushi row becomes cost_category feedback
-- ===========================================================================

create or replace function public.robot_feedback_from_cost_classification()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_product_name text;
  v_subject_key text;
begin
  if old.classification_source <> 'sushi'
     or new.classification_source <> 'manual_override'
     or old.category_code is not distinct from new.category_code then
    return new;
  end if;

  if new.source_type = 'payment_request_item' then
    select pri.product_name into v_product_name
    from public.payment_request_items pri
    where pri.id = new.source_line_id;
  elsif new.source_type = 'invoice_item' then
    select ii.product_name into v_product_name
    from public.invoice_items ii
    where ii.id = new.source_line_id;
  end if;

  v_subject_key := lower(
    coalesce(new.supplier_id::text, '') || '|' ||
    coalesce(public.normalize_stock_item_name(v_product_name), '')
  );

  insert into public.robot_feedback (
    kind, subject_key, robot_choice, human_choice, robot_probability, note,
    source_table, source_id, created_by, created_at
  ) values (
    'cost_category',
    v_subject_key,
    old.category_code,
    new.category_code,
    old.confidence,
    v_product_name,
    'cost_line_classifications',
    new.id,
    auth.uid(),
    now()
  )
  on conflict do nothing;

  return new;
end;
$$;

drop trigger if exists robot_feedback_cost_classification on public.cost_line_classifications;
create trigger robot_feedback_cost_classification
  after update of classification_source, category_code on public.cost_line_classifications
  for each row execute function public.robot_feedback_from_cost_classification();

-- ===========================================================================
-- 6. Candidate reader: unclassified, or fallback/rule still UNMAPPED_REVIEW
-- ===========================================================================

create or replace function public.cost_classify_sushi_candidates(p_limit int)
returns table (
  source_type text,
  source_line_id uuid,
  supplier_id uuid,
  supplier_name text,
  product_name text,
  product_code text,
  unit text,
  quantity numeric,
  unit_price numeric,
  line_amount numeric,
  document_date date,
  note text,
  subject_key text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'cost_classify_sushi_candidates requires service role' using errcode = '42501';
  end if;

  return query
  with candidates as (
    select
      'payment_request_item'::text as source_type,
      pri.id as source_line_id,
      pr.supplier_id,
      s.name as supplier_name,
      pri.product_name,
      pri.product_code,
      pri.unit,
      pri.quantity,
      pri.unit_price,
      coalesce(pri.line_total, pri.quantity * pri.unit_price, 0)::numeric as line_amount,
      coalesce(pr.paid_at::date, pr.created_at::date) as document_date,
      nullif(concat_ws(' · ', nullif(pr.title, ''), nullif(pr.description, ''), nullif(pr.notes, '')), '') as note,
      pri.created_at as line_created_at
    from public.payment_request_items pri
    join public.payment_requests pr on pr.id = pri.payment_request_id
    left join public.suppliers s on s.id = pr.supplier_id
    left join public.cost_line_classifications clc
      on clc.source_type = 'payment_request_item'
      and clc.source_line_id = pri.id
    where clc.id is null
       or (
         clc.classification_source in ('fallback', 'rule')
         and clc.category_code = 'UNMAPPED_REVIEW'
         and clc.review_status <> 'approved'
         and clc.classification_source <> 'manual_override'
       )

    union all

    select
      'invoice_item'::text as source_type,
      ii.id as source_line_id,
      coalesce(inv.supplier_id, pr.supplier_id) as supplier_id,
      s.name as supplier_name,
      ii.product_name,
      ii.product_code,
      ii.unit,
      ii.quantity,
      ii.unit_price,
      coalesce(ii.line_total, ii.quantity * ii.unit_price, 0)::numeric as line_amount,
      coalesce(inv.invoice_date, inv.created_at::date) as document_date,
      nullif(
        concat_ws(
          ' · ',
          nullif(inv.notes, ''),
          nullif(pr.title, ''),
          nullif(pr.description, ''),
          nullif(pr.notes, '')
        ),
        ''
      ) as note,
      ii.created_at as line_created_at
    from public.invoice_items ii
    join public.invoices inv on inv.id = ii.invoice_id
    left join public.payment_requests pr on pr.id = inv.payment_request_id
    left join public.suppliers s on s.id = coalesce(inv.supplier_id, pr.supplier_id)
    left join public.cost_line_classifications clc
      on clc.source_type = 'invoice_item'
      and clc.source_line_id = ii.id
    where clc.id is null
       or (
         clc.classification_source in ('fallback', 'rule')
         and clc.category_code = 'UNMAPPED_REVIEW'
         and clc.review_status <> 'approved'
         and clc.classification_source <> 'manual_override'
       )
  )
  select
    c.source_type,
    c.source_line_id,
    c.supplier_id,
    c.supplier_name,
    c.product_name,
    c.product_code,
    c.unit,
    c.quantity,
    c.unit_price,
    c.line_amount,
    c.document_date,
    c.note,
    lower(
      coalesce(c.supplier_id::text, '') || '|' ||
      coalesce(public.normalize_stock_item_name(c.product_name), '')
    ) as subject_key
  from candidates c
  order by c.document_date desc nulls last, c.line_created_at desc
  limit greatest(1, least(coalesce(p_limit, 50), 50));
end;
$$;

revoke all on function public.cost_classify_sushi_candidates(int) from public, anon, authenticated;
grant execute on function public.cost_classify_sushi_candidates(int) to service_role;

-- ===========================================================================
-- 7. Feedback reader: up to 5 most recent corrections per subject
-- ===========================================================================

create or replace function public.cost_classify_sushi_feedback(p_subject_keys text[])
returns table (
  id uuid,
  kind text,
  subject_key text,
  robot_choice text,
  human_choice text,
  robot_probability numeric,
  note text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'cost_classify_sushi_feedback requires service role' using errcode = '42501';
  end if;

  return query
  select
    f.id,
    f.kind,
    f.subject_key,
    f.robot_choice,
    f.human_choice,
    f.robot_probability,
    f.note,
    f.created_at
  from unnest(coalesce(p_subject_keys, array[]::text[])) as k(subject_key)
  cross join lateral (
    select rf.*
    from public.robot_feedback rf
    where rf.kind = 'cost_category'
      and rf.subject_key = k.subject_key
    order by rf.created_at desc, rf.id desc
    limit 5
  ) f;
end;
$$;

revoke all on function public.cost_classify_sushi_feedback(text[]) from public, anon, authenticated;
grant execute on function public.cost_classify_sushi_feedback(text[]) to service_role;

-- ===========================================================================
-- 8. pg_cron worker: 05:00/05:15/05:30/05:45 Asia/Saigon == 22:00-22:45 UTC
-- ===========================================================================

do $schedule$
declare
  existing_job_id bigint;
begin
  for existing_job_id in
    select jobid from cron.job where jobname = 'sushi-cost-classify-daily'
  loop
    perform cron.unschedule(existing_job_id);
  end loop;

  perform cron.schedule(
    'sushi-cost-classify-daily',
    '0,15,30,45 22 * * *',
    $job$
      do $run$
      begin
        perform net.http_post(
          url := 'https://cxntbdvfsikwmitapony.supabase.co/functions/v1/cost-classify-sushi',
          headers := jsonb_build_object(
            'content-type', 'application/json',
            'x-worker-secret', (
              select worker_secret::text
              from public.robot_worker_config
              where id = 'sushi-cost'
            )
          ),
          body := jsonb_build_object(
            'limit', 50
          ),
          timeout_milliseconds := 120000
        );
      end;
      $run$;
    $job$
  );
end;
$schedule$;
