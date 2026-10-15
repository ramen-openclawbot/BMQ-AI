-- Bé Mì tự dán cách ghi mới của món đã dán + worker chạy mỗi giờ.
--
-- Additive only. This migration adds:
--   (a) a trailing p_require_variant flag on public.robot_auto_confirm_alias —
--       the unattended hourly worker only writes a new name when the same
--       supplier already has a different-name alias to the same target item
--       (a "variant" of a known item);
--   (b) public.robot_worker_config — the shared secret the pg_cron worker sends
--       in x-worker-secret, readable by service_role only;
--   (c) the hourly pg_cron job be-mi-variant-labels-hourly that calls the
--       stock-alias-jev edge function twice, once per location.
--
-- The old 10-argument robot_auto_confirm_alias is dropped and replaced by the
-- 11-argument one; the body keeps every gate from 20261101260000 and only adds
-- the variant gate. Grants stay service_role-only.

-- ===========================================================================
-- 1. robot_auto_confirm_alias: new trailing p_require_variant boolean
-- ===========================================================================

drop function if exists public.robot_auto_confirm_alias(
  uuid, text, text, text, uuid, uuid, text, numeric, uuid, numeric
);

create or replace function public.robot_auto_confirm_alias(
  p_supplier_id uuid,
  p_location text,
  p_raw_name text,
  p_raw_unit text,
  p_kitchen_inventory_item_id uuid,
  p_tan_tao_sku_id uuid,
  p_entered_unit_label text,
  p_conversion_factor numeric,
  p_jev_item_id uuid,
  p_jev_probability numeric,
  p_require_variant boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_settings public.robot_settings%rowtype;
  v_norm text;
  v_subject text;
  v_choice uuid;
  v_target_name text;
  v_target_unit text;
  v_unit_status text;
  v_reason text;
  v_event_id uuid;
  v_result jsonb;
  v_action_id uuid;
begin
  select * into v_settings from public.robot_settings where id = true;
  if not found then
    v_settings.auto_apply_enabled := true;
    v_settings.alias_threshold := 0.95;
    v_settings.class_threshold := 0.90;
    v_settings.daily_cap := 50;
  end if;

  v_norm := public.normalize_stock_item_name(p_raw_name);
  if v_norm is null then
    return jsonb_build_object('applied', false, 'reason', 'invalid_request');
  end if;
  v_subject := coalesce(p_supplier_id::text, '') || '|' || v_norm;
  v_choice := coalesce(p_kitchen_inventory_item_id, p_tan_tao_sku_id);
  if v_choice is null or p_jev_item_id is null or v_choice is distinct from p_jev_item_id then
    return jsonb_build_object('applied', false, 'reason', 'not_robot_choice');
  end if;

  if p_kitchen_inventory_item_id is not null then
    select kii.name, kii.unit into v_target_name, v_target_unit
    from public.kitchen_inventory_items kii
    where kii.id = p_kitchen_inventory_item_id;
  else
    select ps.product_name, ps.unit into v_target_name, v_target_unit
    from public.product_skus ps
    where ps.id = p_tan_tao_sku_id;
  end if;

  v_reason := public.robot_auto_refusal('alias', v_subject, p_jev_probability, v_settings.alias_threshold);
  if v_reason is not null then
    return jsonb_build_object('applied', false, 'reason', v_reason);
  end if;

  -- Variant gate: an unattended worker only labels a new spelling of an item
  -- this supplier already has aliased to the same target, under another name.
  if p_require_variant then
    if p_supplier_id is null then
      return jsonb_build_object('applied', false, 'reason', 'not_variant');
    end if;
    if not exists (
      select 1
      from public.stock_material_aliases a
      where a.status in ('auto', 'learning')
        and a.location = p_location
        and a.supplier_id is not null
        and a.supplier_id = p_supplier_id
        and a.normalized_name <> v_norm
        and (
          (p_kitchen_inventory_item_id is not null
            and a.kitchen_inventory_item_id = p_kitchen_inventory_item_id)
          or (p_tan_tao_sku_id is not null
            and a.tan_tao_sku_id = p_tan_tao_sku_id)
        )
    ) then
      return jsonb_build_object('applied', false, 'reason', 'not_variant');
    end if;
  end if;

  -- Unit must be the same or auto-convertible, unless the names are an exact match.
  if v_target_name is null
     or public.normalize_stock_item_name(v_target_name) is distinct from v_norm then
    v_unit_status := public.q7_unit_status(v_target_unit, p_raw_unit);
    if v_unit_status is null or v_unit_status not in ('same', 'auto') then
      return jsonb_build_object('applied', false, 'reason', 'unit_mismatch');
    end if;
  end if;

  v_result := public.confirm_material_alias(
    p_supplier_id,
    p_location,
    p_raw_name,
    p_raw_unit,
    p_kitchen_inventory_item_id,
    p_tan_tao_sku_id,
    p_entered_unit_label,
    p_conversion_factor,
    p_jev_item_id,
    p_jev_probability,
    'robot_auto',
    null::uuid,
    'stock'
  );

  -- The event confirm_material_alias just wrote is the last robot_auto event for
  -- this alias; keep its id so undo can revert through the existing path.
  select e.id into v_event_id
  from public.material_alias_events e
  where e.alias_id = nullif(v_result -> 'alias' ->> 'id', '')::uuid
    and e.source_table = 'robot_auto'
    and e.action in ('confirm', 'correct')
    and not exists (
      select 1 from public.material_alias_events u
      where u.action = 'undo' and u.undo_of_event_id = e.id
    )
  order by e.created_at desc, e.id desc
  limit 1;

  insert into public.robot_auto_actions (
    kind, subject_key, target, robot_probability, payload, status
  ) values (
    'alias',
    v_subject,
    jsonb_build_object(
      'item_id', v_choice,
      'supplier_id', p_supplier_id,
      'location', p_location,
      'normalized_name', v_norm,
      'alias_id', v_result -> 'alias' ->> 'id'
    ),
    p_jev_probability,
    jsonb_build_object(
      'raw_name', p_raw_name,
      'raw_unit', p_raw_unit,
      'entered_unit_label', p_entered_unit_label,
      'conversion_factor', p_conversion_factor,
      'robot_item_id', p_jev_item_id,
      'event_id', v_event_id
    ),
    'applied'
  )
  returning id into v_action_id;

  return jsonb_build_object(
    'applied', true,
    'action_id', v_action_id,
    'event_id', v_event_id,
    'alias', v_result -> 'alias',
    'applied_lines', v_result -> 'applied_lines'
  );
end;
$$;

revoke all on function public.robot_auto_confirm_alias(uuid, text, text, text, uuid, uuid, text, numeric, uuid, numeric, boolean)
  from public, anon, authenticated;
grant execute on function public.robot_auto_confirm_alias(uuid, text, text, text, uuid, uuid, text, numeric, uuid, numeric, boolean)
  to service_role;

-- ===========================================================================
-- 2. robot_worker_config: the hourly worker's shared secret
-- ===========================================================================

create table if not exists public.robot_worker_config (
  id text primary key,
  worker_secret uuid not null default gen_random_uuid(),
  created_at timestamptz default now()
);

insert into public.robot_worker_config (id) values ('be-mi') on conflict (id) do nothing;

alter table public.robot_worker_config enable row level security;

revoke all on public.robot_worker_config from public, anon, authenticated;
grant all on public.robot_worker_config to service_role;

-- ===========================================================================
-- 3. Hourly pg_cron worker: two backlog batches, one per location
-- ===========================================================================

do $schedule$
declare
  existing_job_id bigint;
begin
  for existing_job_id in
    select jobid from cron.job where jobname = 'be-mi-variant-labels-hourly'
  loop
    perform cron.unschedule(existing_job_id);
  end loop;

  perform cron.schedule(
    'be-mi-variant-labels-hourly',
    '17 * * * *',
    $job$
      do $run$
      begin
        perform net.http_post(
          url := 'https://cxntbdvfsikwmitapony.supabase.co/functions/v1/stock-alias-jev',
          headers := jsonb_build_object(
            'content-type', 'application/json',
            'x-worker-secret', (
              select worker_secret::text
              from public.robot_worker_config
              where id = 'be-mi'
            )
          ),
          body := jsonb_build_object(
            'mode', 'backlog',
            'location', 'q7',
            'batch_size', 20,
            'unattended', true
          ),
          timeout_milliseconds := 120000
        );
        perform net.http_post(
          url := 'https://cxntbdvfsikwmitapony.supabase.co/functions/v1/stock-alias-jev',
          headers := jsonb_build_object(
            'content-type', 'application/json',
            'x-worker-secret', (
              select worker_secret::text
              from public.robot_worker_config
              where id = 'be-mi'
            )
          ),
          body := jsonb_build_object(
            'mode', 'backlog',
            'location', 'tan_tao',
            'batch_size', 20,
            'unattended', true
          ),
          timeout_milliseconds := 120000
        );
      end;
      $run$;
    $job$
  );
end;
$schedule$;
