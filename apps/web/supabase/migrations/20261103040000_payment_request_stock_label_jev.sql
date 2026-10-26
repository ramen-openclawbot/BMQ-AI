-- Jev tự gắn nhãn Nhập kho / Không nhập kho cho cả phiếu chi.
--
-- Additive only. This migration:
--   (a) adds the Jev stock-label columns to public.payment_requests;
--   (b) adds the switch/threshold/daily-limit settings row and the per-run log,
--       both RLS-protected (owner reads, service_role writes);
--   (c) keeps public.set_payment_request_requires_receipt's signature and every
--       existing check, but every human change now sets stock_label_source =
--       'manual' and a human override of a Jev label is logged as feedback
--       (skipped_reason = 'human_override');
--   (d) adds list_payment_requests_for_stock_label(p_limit), service_role only,
--       returning unlabelled candidates plus up to five same-supplier manual
--       examples;
--   (e) adds apply_payment_request_stock_label_jev(...), service_role only,
--       which locks the row, re-checks every candidate condition and the
--       enabled switch, then applies non_stock / stock at or above the
--       threshold, stores a below-threshold suggestion, writes the run log and
--       one audit_logs row;
--   (f) schedules the pg_cron worker every 15 minutes, using the same
--       robot_worker_config secret pattern as cost-classify-sushi.
--
-- Nothing here changes amounts, payments, approval or rejection functions and
-- no existing business row is inserted, updated or deleted at migration top
-- level. The switch defaults to off.

-- ===========================================================================
-- 1. Additive columns on payment_requests
-- ===========================================================================

alter table public.payment_requests
  add column if not exists stock_label_source text,
  add column if not exists stock_label_jev_class text,
  add column if not exists stock_label_jev_confidence numeric,
  add column if not exists stock_label_jev_reason text,
  add column if not exists stock_label_jev_at timestamptz;

comment on column public.payment_requests.stock_label_source is
  'Who set the whole-request stock label: manual (human) or jev. Null means unlabelled / Jev suggestion only.';
comment on column public.payment_requests.stock_label_jev_class is
  'Jev classification for the whole request: stock (needs a goods receipt) or non_stock.';
comment on column public.payment_requests.stock_label_jev_confidence is
  'Jev confidence in the whole-request stock label, 0..1.';
comment on column public.payment_requests.stock_label_jev_reason is
  'Short Vietnamese reason returned by Jev (max 120 characters).';
comment on column public.payment_requests.stock_label_jev_at is
  'When Jev last classified the whole request.';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'payment_requests_stock_label_source_check'
      and conrelid = 'public.payment_requests'::regclass
  ) then
    alter table public.payment_requests
      add constraint payment_requests_stock_label_source_check
      check (stock_label_source is null or stock_label_source in ('manual', 'jev'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'payment_requests_stock_label_jev_class_check'
      and conrelid = 'public.payment_requests'::regclass
  ) then
    alter table public.payment_requests
      add constraint payment_requests_stock_label_jev_class_check
      check (stock_label_jev_class is null or stock_label_jev_class in ('stock', 'non_stock'));
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname = 'payment_requests_stock_label_jev_confidence_check'
      and conrelid = 'public.payment_requests'::regclass
  ) then
    alter table public.payment_requests
      add constraint payment_requests_stock_label_jev_confidence_check
      check (
        stock_label_jev_confidence is null
        or (stock_label_jev_confidence >= 0 and stock_label_jev_confidence <= 1)
      );
  end if;
end $$;

-- ===========================================================================
-- 2. Settings and run log
-- ===========================================================================

create table if not exists public.payment_stock_label_jev_settings (
  id boolean primary key default true,
  enabled boolean not null default false,
  min_confidence numeric not null default 0.9
    check (min_confidence >= 0 and min_confidence <= 1),
  daily_limit integer not null default 200
    check (daily_limit >= 0),
  -- Jev only labels requests created on or after this instant; older requests
  -- (including paid ones) are never relabelled.
  start_from timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.payment_stock_label_jev_settings
  add column if not exists start_from timestamptz not null default now();

insert into public.payment_stock_label_jev_settings (id)
values (true)
on conflict (id) do nothing;

create table if not exists public.payment_stock_label_jev_runs (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references public.payment_requests(id) on delete cascade,
  class text check (class is null or class in ('stock', 'non_stock')),
  confidence numeric check (confidence is null or (confidence >= 0 and confidence <= 1)),
  reason text,
  applied boolean not null default false,
  skipped_reason text,
  model text,
  created_at timestamptz not null default now()
);

create index if not exists idx_payment_stock_label_jev_runs_request
  on public.payment_stock_label_jev_runs (request_id, created_at desc);
create index if not exists idx_payment_stock_label_jev_runs_created
  on public.payment_stock_label_jev_runs (created_at desc);

alter table public.payment_stock_label_jev_settings enable row level security;
alter table public.payment_stock_label_jev_runs enable row level security;

revoke all on table public.payment_stock_label_jev_settings from public, anon, authenticated;
revoke all on table public.payment_stock_label_jev_runs from public, anon, authenticated;

grant select on table public.payment_stock_label_jev_settings to authenticated;
grant select on table public.payment_stock_label_jev_runs to authenticated;
grant all on table public.payment_stock_label_jev_settings to service_role;
grant all on table public.payment_stock_label_jev_runs to service_role;

drop policy if exists payment_stock_label_jev_settings_select on public.payment_stock_label_jev_settings;
create policy payment_stock_label_jev_settings_select
  on public.payment_stock_label_jev_settings
  for select
  to authenticated
  using (public.has_role(auth.uid(), 'owner'::public.app_role));

drop policy if exists payment_stock_label_jev_runs_select on public.payment_stock_label_jev_runs;
create policy payment_stock_label_jev_runs_select
  on public.payment_stock_label_jev_runs
  for select
  to authenticated
  using (public.has_role(auth.uid(), 'owner'::public.app_role));

-- ===========================================================================
-- 3. Human toggle: preserve every existing check, add the manual source and
--    the human_override feedback row
-- ===========================================================================

create or replace function public.set_payment_request_requires_receipt(
  p_request_id uuid,
  p_requires_receipt boolean,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_requires boolean := coalesce(p_requires_receipt, true);
  v_reason text := btrim(coalesce(p_reason, ''));
  v_pr public.payment_requests%rowtype;
  v_prev_source text;
  v_prev_class text;
  v_prev_confidence numeric;
  v_human_class text;
begin
  if coalesce(public.material_master_jwt_role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'authenticated actor required' using errcode = '42501'; end if;
  end if;
  if not (
    coalesce(public.material_master_jwt_role(), '') = 'service_role'
    or public.has_role(v_actor, 'owner')
    or public.has_module_permission(v_actor, 'payment_requests', 'edit')
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select * into v_pr
  from public.payment_requests
  where id = p_request_id
  for update;
  if not found then
    raise exception 'request_not_found' using errcode = 'P0002';
  end if;

  if v_pr.status::text = 'rejected' then
    raise exception 'invalid_status' using errcode = 'P0001',
      detail = format('current_status=%s', v_pr.status);
  end if;

  v_prev_source := v_pr.stock_label_source;
  v_prev_class := v_pr.stock_label_jev_class;
  v_prev_confidence := v_pr.stock_label_jev_confidence;

  if not v_requires then
    -- A request already bound to a goods receipt or a purchase order stays on
    -- the delivery + invoice flow; it cannot become không nhập kho.
    if v_pr.goods_receipt_id is not null or v_pr.purchase_order_id is not null then
      raise exception 'receipt_linked' using errcode = 'P0001';
    end if;
    if length(v_reason) < 3 then
      raise exception 'reason_required' using errcode = '22023';
    end if;

    update public.payment_requests
    set requires_receipt = false,
        no_receipt_reason = v_reason,
        no_receipt_set_by = v_actor,
        no_receipt_set_at = now(),
        stock_label_source = 'manual',
        updated_at = now()
    where id = p_request_id;
  else
    update public.payment_requests
    set requires_receipt = true,
        no_receipt_reason = null,
        no_receipt_set_by = null,
        no_receipt_set_at = null,
        stock_label_source = 'manual',
        updated_at = now()
    where id = p_request_id;
  end if;

  -- A human who changes Jev's class is the learning signal. Store it in the
  -- same per-request log, tagged so the daily counter never counts it.
  if v_prev_source = 'jev' then
    v_human_class := case when v_requires then 'stock' else 'non_stock' end;
    if v_prev_class is distinct from v_human_class then
      insert into public.payment_stock_label_jev_runs (
        request_id,
        class,
        confidence,
        reason,
        applied,
        skipped_reason,
        model
      ) values (
        p_request_id,
        v_human_class,
        v_prev_confidence,
        left(
          'Người đổi nhãn Jev: ' || coalesce(v_prev_class, '?') || ' → ' || v_human_class
          || case when length(v_reason) > 0 then ' — ' || v_reason else '' end,
          200
        ),
        false,
        'human_override',
        null
      );
    end if;
  end if;

  -- Existing audit_logs shape is (actor_id, action, target_id, metadata): it is
  -- compatible, so append one actor/time row there too.
  insert into public.audit_logs (actor_id, action, target_id, metadata)
  values (
    v_actor,
    'payment_request_requires_receipt_changed',
    p_request_id,
    jsonb_build_object(
      'requires_receipt', v_requires,
      'no_receipt_reason', case when v_requires then null else v_reason end,
      'stock_label_source', 'manual',
      'changed_at', now()
    )
  );

  return jsonb_build_object(
    'id', p_request_id,
    'requires_receipt', v_requires,
    'no_receipt_reason', case when v_requires then null else v_reason end
  );
end;
$$;

revoke all on function public.set_payment_request_requires_receipt(uuid, boolean, text) from public, anon;
grant execute on function public.set_payment_request_requires_receipt(uuid, boolean, text) to authenticated, service_role;

comment on function public.set_payment_request_requires_receipt(uuid, boolean, text) is
  'Owner / payment_requests edit RPC: locks one payment request, switches it to không nhập kho with a reason >= 3 chars (or back to requiring a receipt), refuses rejected requests (invalid_status) and receipt/PO-linked requests (receipt_linked), always marks stock_label_source = manual, logs a human_override feedback row when a Jev label changes class, appends an audit_logs row, and returns {id, requires_receipt, no_receipt_reason}.';

-- ===========================================================================
-- 4. Candidate reader: unlabelled, unlinked, not rejected, never run
-- ===========================================================================

create or replace function public.list_payment_requests_for_stock_label(p_limit int)
returns table (
  request_id uuid,
  supplier_id uuid,
  supplier_name text,
  title text,
  description text,
  total_amount numeric,
  vat_amount numeric,
  item_names text[],
  manual_examples jsonb
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'list_payment_requests_for_stock_label requires service role' using errcode = '42501';
  end if;

  return query
  with candidates as (
    select
      pr.id,
      pr.supplier_id,
      pr.title,
      pr.description,
      pr.total_amount,
      pr.vat_amount,
      pr.created_at
    from public.payment_requests pr
    where pr.stock_label_source is null
      -- A request created as không nhập kho (checkbox, cash, auto template) is a
      -- human or system choice; Jev never flips it back.
      and pr.requires_receipt = true
      and pr.no_receipt_set_at is null
      and pr.created_at >= coalesce(
        (select s.start_from from public.payment_stock_label_jev_settings s where s.id = true),
        now()
      )
      and pr.status::text <> 'rejected'
      and pr.goods_receipt_id is null
      and pr.purchase_order_id is null
      and not exists (
        select 1
        from public.payment_stock_label_jev_runs r
        where r.request_id = pr.id
      )
    order by pr.created_at desc
    limit greatest(1, least(coalesce(p_limit, 50), 50))
  )
  select
    c.id,
    c.supplier_id,
    s.name,
    c.title,
    c.description,
    c.total_amount,
    c.vat_amount,
    coalesce(
      (
        select array_agg(pri.product_name order by pri.created_at, pri.id)
        from public.payment_request_items pri
        where pri.payment_request_id = c.id
      ),
      array[]::text[]
    ) as item_names,
    coalesce(
      (
        select jsonb_agg(
          jsonb_build_object(
            'request_id', ex.id,
            'title', ex.title,
            'description', ex.description,
            'requires_receipt', ex.requires_receipt,
            'no_receipt_reason', ex.no_receipt_reason,
            'created_at', ex.created_at,
            'item_names', ex.item_names
          )
          order by ex.created_at desc
        )
        from (
          select
            pr2.id,
            pr2.title,
            pr2.description,
            pr2.requires_receipt,
            pr2.no_receipt_reason,
            pr2.created_at,
            coalesce(
              (
                select array_agg(pri2.product_name order by pri2.created_at, pri2.id)
                from public.payment_request_items pri2
                where pri2.payment_request_id = pr2.id
              ),
              array[]::text[]
            ) as item_names
          from public.payment_requests pr2
          where c.supplier_id is not null
            and pr2.supplier_id = c.supplier_id
            and pr2.stock_label_source = 'manual'
            and pr2.id <> c.id
          order by pr2.created_at desc
          limit 5
        ) ex
      ),
      '[]'::jsonb
    ) as manual_examples
  from candidates c
  left join public.suppliers s on s.id = c.supplier_id
  order by c.created_at desc;
end;
$$;

revoke all on function public.list_payment_requests_for_stock_label(int) from public, anon, authenticated;
grant execute on function public.list_payment_requests_for_stock_label(int) to service_role;

comment on function public.list_payment_requests_for_stock_label(int) is
  'Service-role reader for Jev stock labelling: unlabelled, non-rejected payment requests with no goods receipt / purchase order and no previous run, newest first, up to 50, plus up to five same-supplier manual examples.';

-- ===========================================================================
-- 5. The only Jev stock-label writer
-- ===========================================================================

create or replace function public.apply_payment_request_stock_label_jev(
  p_request_id uuid,
  p_class text,
  p_confidence numeric,
  p_reason text,
  p_model text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings public.payment_stock_label_jev_settings%rowtype;
  v_pr public.payment_requests%rowtype;
  v_class text := p_class;
  v_confidence numeric := p_confidence;
  v_reason text := left(btrim(coalesce(p_reason, '')), 120);
  v_skip text;
  v_applied boolean := false;
  v_requires boolean;
  v_no_receipt_reason text;
  v_min_confidence numeric := 0.9;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'apply_payment_request_stock_label_jev requires service role' using errcode = '42501';
  end if;

  if p_request_id is null then
    return jsonb_build_object('status', 'skipped', 'reason', 'invalid_request');
  end if;

  select * into v_settings
  from public.payment_stock_label_jev_settings
  where id = true;
  if not found then
    v_settings.enabled := false;
    v_settings.min_confidence := 0.9;
    v_settings.daily_limit := 200;
  end if;
  v_min_confidence := coalesce(v_settings.min_confidence, 0.9);

  select * into v_pr
  from public.payment_requests
  where id = p_request_id
  for update;
  if not found then
    return jsonb_build_object('status', 'skipped', 'reason', 'request_not_found');
  end if;

  if v_class is null or v_class not in ('stock', 'non_stock') then
    insert into public.payment_stock_label_jev_runs (
      request_id, class, confidence, reason, applied, skipped_reason, model
    ) values (
      p_request_id, null, null, v_reason, false, 'invalid_class', p_model
    );
    return jsonb_build_object('status', 'skipped', 'reason', 'invalid_class');
  end if;

  if v_confidence is null or v_confidence < 0 or v_confidence > 1 then
    insert into public.payment_stock_label_jev_runs (
      request_id, class, confidence, reason, applied, skipped_reason, model
    ) values (
      p_request_id, v_class, null, v_reason, false, 'invalid_confidence', p_model
    );
    return jsonb_build_object('status', 'skipped', 'reason', 'invalid_confidence');
  end if;

  -- Re-check every candidate condition under the row lock. The switch is
  -- checked here too so a stale worker can never apply after it is turned off.
  if v_settings.enabled is not true then
    v_skip := 'disabled';
  elsif v_pr.stock_label_source is not null then
    v_skip := 'already_labeled';
  elsif v_pr.requires_receipt is not true or v_pr.no_receipt_set_at is not null then
    v_skip := 'already_labeled';
  elsif v_pr.created_at < coalesce(v_settings.start_from, now()) then
    v_skip := 'before_start';
  elsif v_pr.status::text = 'rejected' then
    v_skip := 'rejected';
  elsif v_pr.goods_receipt_id is not null or v_pr.purchase_order_id is not null then
    v_skip := 'receipt_linked';
  elsif exists (
    select 1
    from public.payment_stock_label_jev_runs r
    where r.request_id = p_request_id
  ) then
    v_skip := 'already_ran';
  end if;

  if v_skip is not null then
    insert into public.payment_stock_label_jev_runs (
      request_id, class, confidence, reason, applied, skipped_reason, model
    ) values (
      p_request_id, v_class, v_confidence, v_reason, false, v_skip, p_model
    );

    insert into public.audit_logs (actor_id, action, target_id, metadata)
    values (
      null,
      'payment_request_requires_receipt_changed',
      p_request_id,
      jsonb_build_object(
        'requires_receipt', v_pr.requires_receipt,
        'no_receipt_reason', v_pr.no_receipt_reason,
        'stock_label_source', v_pr.stock_label_source,
        'stock_label_jev_class', v_class,
        'stock_label_jev_confidence', v_confidence,
        'stock_label_jev_reason', v_reason,
        'applied', false,
        'skipped_reason', v_skip,
        'actor', 'jev',
        'model', p_model,
        'changed_at', now()
      )
    );

    return jsonb_build_object('status', 'skipped', 'reason', v_skip);
  end if;

  v_requires := v_pr.requires_receipt;

  if v_confidence >= v_min_confidence then
    v_applied := true;
    if v_class = 'non_stock' then
      v_no_receipt_reason := left(
        'Jev: ' || coalesce(nullif(v_reason, ''), 'Jev phân loại phiếu chi không nhập kho'),
        200
      );
      if length(btrim(coalesce(v_no_receipt_reason, ''))) < 3 then
        v_no_receipt_reason := 'Jev: Jev phân loại phiếu chi không nhập kho';
      end if;

      update public.payment_requests
      set requires_receipt = false,
          no_receipt_reason = v_no_receipt_reason,
          no_receipt_set_by = null,
          no_receipt_set_at = now(),
          stock_label_source = 'jev',
          stock_label_jev_class = v_class,
          stock_label_jev_confidence = v_confidence,
          stock_label_jev_reason = v_reason,
          stock_label_jev_at = now(),
          updated_at = now()
      where id = p_request_id
      returning requires_receipt, no_receipt_reason into v_requires, v_no_receipt_reason;
    else
      update public.payment_requests
      set requires_receipt = true,
          no_receipt_reason = null,
          no_receipt_set_by = null,
          no_receipt_set_at = null,
          stock_label_source = 'jev',
          stock_label_jev_class = v_class,
          stock_label_jev_confidence = v_confidence,
          stock_label_jev_reason = v_reason,
          stock_label_jev_at = now(),
          updated_at = now()
      where id = p_request_id
      returning requires_receipt, no_receipt_reason into v_requires, v_no_receipt_reason;
    end if;
  else
    -- Below the threshold only the suggestion is stored; source stays null so
    -- the next human action still wins and the request stays unlabelled.
    update public.payment_requests
    set stock_label_jev_class = v_class,
        stock_label_jev_confidence = v_confidence,
        stock_label_jev_reason = v_reason,
        stock_label_jev_at = now(),
        updated_at = now()
    where id = p_request_id
    returning requires_receipt, no_receipt_reason into v_requires, v_no_receipt_reason;
  end if;

  insert into public.payment_stock_label_jev_runs (
    request_id, class, confidence, reason, applied, skipped_reason, model
  ) values (
    p_request_id, v_class, v_confidence, v_reason, v_applied, null, p_model
  );

  insert into public.audit_logs (actor_id, action, target_id, metadata)
  values (
    null,
    'payment_request_requires_receipt_changed',
    p_request_id,
    jsonb_build_object(
      'requires_receipt', v_requires,
      'no_receipt_reason', v_no_receipt_reason,
      'stock_label_source', case when v_applied then 'jev' else null end,
      'stock_label_jev_class', v_class,
      'stock_label_jev_confidence', v_confidence,
      'stock_label_jev_reason', v_reason,
      'applied', v_applied,
      'actor', 'jev',
      'model', p_model,
      'changed_at', now()
    )
  );

  return jsonb_build_object(
    'status', case when v_applied then 'applied' else 'suggested' end,
    'applied', v_applied,
    'class', v_class,
    'confidence', v_confidence,
    'requires_receipt', v_requires,
    'no_receipt_reason', v_no_receipt_reason
  );
end;
$$;

revoke all on function public.apply_payment_request_stock_label_jev(uuid, text, numeric, text, text)
  from public, anon, authenticated;
grant execute on function public.apply_payment_request_stock_label_jev(uuid, text, numeric, text, text)
  to service_role;

comment on function public.apply_payment_request_stock_label_jev(uuid, text, numeric, text, text) is
  'Service-role writer for the Jev whole-request stock label: locks the payment request, re-checks enabled + unlabelled + not rejected + no goods receipt/PO + no previous run, applies non_stock (requires_receipt=false, no_receipt_reason=''Jev: '' || reason) or stock (requires_receipt=true) at/above min_confidence, stores a below-threshold suggestion with stock_label_source left null, logs one run row and one audit_logs row, and returns {status, reason?, applied, class, confidence, requires_receipt, no_receipt_reason}.';

-- ===========================================================================
-- 6. pg_cron worker every 15 minutes
-- ===========================================================================

create table if not exists public.robot_worker_config (
  id text primary key,
  worker_secret uuid not null default gen_random_uuid(),
  created_at timestamptz default now()
);

insert into public.robot_worker_config (id)
values ('payment-stock-label-jev')
on conflict (id) do nothing;

alter table public.robot_worker_config enable row level security;

revoke all on public.robot_worker_config from public, anon, authenticated;
grant all on public.robot_worker_config to service_role;

do $schedule$
declare
  existing_job_id bigint;
begin
  for existing_job_id in
    select jobid from cron.job where jobname = 'payment-stock-label-jev-15m'
  loop
    perform cron.unschedule(existing_job_id);
  end loop;

  perform cron.schedule(
    'payment-stock-label-jev-15m',
    '*/15 * * * *',
    $job$
      do $run$
      begin
        perform net.http_post(
          url := 'https://cxntbdvfsikwmitapony.supabase.co/functions/v1/payment-stock-label-jev',
          headers := jsonb_build_object(
            'content-type', 'application/json',
            'x-worker-secret', (
              select worker_secret::text
              from public.robot_worker_config
              where id = 'payment-stock-label-jev'
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
