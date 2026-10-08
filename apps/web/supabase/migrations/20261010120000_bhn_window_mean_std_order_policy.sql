-- BHN BMQ-001 windowed order policy from service date 2026-10-10:
--   ceil_to_batch(max(0, mean(sold of latest <=7 submitted reports up to cutoff)
--                        + 1.5 * stddev_pop(same)
--                        - saleable closing of the exact cutoff report))
-- The v1 exact-day policy row stays unchanged for earlier delivery dates.
-- Late corrections must replay the frozen snapshot; they never discover this row.

alter table public.kiosk_bread_dynamic_order_policies
  add column if not exists formula_method text not null default 'exact_day_multiplier'
    check (formula_method in ('exact_day_multiplier', 'window_mean_plus_k_std')),
  add column if not exists window_size integer not null default 7
    check (window_size > 0),
  add column if not exists std_multiplier numeric(8,4) not null default 0
    check (std_multiplier >= 0),
  add column if not exists min_reports integer not null default 3
    check (min_reports > 0);

insert into public.kiosk_bread_dynamic_order_policies (
  policy_code,
  location_id,
  location_code,
  sku_code,
  formula_method,
  window_size,
  std_multiplier,
  min_reports,
  demand_multiplier,
  batch_size,
  effective_from_cutoff_date,
  effective_from_service_date,
  active,
  policy_snapshot
) values (
  'dynamic-daily-order-bhn-bmq-001-v2',
  '8b353493-c3cb-436e-80f7-a9a1d1a57cd3',
  'HCM004-BHN',
  'BMQ-001',
  'window_mean_plus_k_std',
  7,
  1.5,
  3,
  1.2,
  20,
  date '2026-10-09',
  date '2026-10-10',
  true,
  jsonb_build_object(
    'policy_type', 'dynamic_window_mean_std',
    'formula', 'ceil_to_batch(max(0, mean(sold_latest_7_reports) + 1.5 * stddev_pop(sold_latest_7_reports) - saleable_closing_of_cutoff_report))',
    'formula_method', 'window_mean_plus_k_std',
    'window_size', 7,
    'std_multiplier', 1.5,
    'min_reports', 3,
    'demand_multiplier', 1.2,
    'batch_size', 20,
    'fallback_formula', 'ceil_to_batch(max(0, demand_multiplier * sold_quantity - saleable_closing_quantity))',
    'exact_cutoff_report_required', true,
    'bread_inventory_row_required', true,
    'missing_source_order_quantity', 0,
    'evidence', 'Bùi Hữu Nghĩa đặt bánh theo trung bình 7 ngày + 1,5 dao động; owner_approved_2026_10_10'
  )
) on conflict (location_id, sku_code, effective_from_service_date) do update
set policy_code = excluded.policy_code,
    location_code = excluded.location_code,
    formula_method = excluded.formula_method,
    window_size = excluded.window_size,
    std_multiplier = excluded.std_multiplier,
    min_reports = excluded.min_reports,
    demand_multiplier = excluded.demand_multiplier,
    batch_size = excluded.batch_size,
    effective_from_cutoff_date = excluded.effective_from_cutoff_date,
    active = excluded.active,
    policy_snapshot = excluded.policy_snapshot,
    updated_at = now();

-- The return tuple grows, so the function must be dropped and recreated.
-- Grants stay service_role only.
drop function if exists public.get_active_kiosk_bread_dynamic_order_policies(date);

create function public.get_active_kiosk_bread_dynamic_order_policies(
  p_service_date date
)
returns table (
  policy_code text,
  location_id uuid,
  location_code text,
  sku_code text,
  formula_method text,
  window_size integer,
  std_multiplier numeric,
  min_reports integer,
  demand_multiplier numeric,
  batch_size integer,
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
  with ranked as (
    select
      policy.policy_code,
      policy.location_id,
      policy.location_code,
      policy.sku_code,
      policy.formula_method,
      policy.window_size,
      policy.std_multiplier,
      policy.min_reports,
      policy.demand_multiplier,
      policy.batch_size,
      policy.effective_from_service_date,
      policy.effective_from_cutoff_date,
      policy.policy_snapshot,
      row_number() over (
        partition by policy.location_id, policy.sku_code
        order by policy.effective_from_service_date desc, policy.created_at desc
      ) as policy_rank
    from public.kiosk_bread_dynamic_order_policies policy
    join public.kiosk_report_locations location
      on location.id = policy.location_id
     and location.active = true
     and upper(coalesce(location.location_code, '')) not like 'TEST%'
    where policy.active = true
      and policy.sku_code = 'BMQ-001'
      and policy.effective_from_service_date <= p_service_date
  )
  select ranked.policy_code, ranked.location_id, ranked.location_code, ranked.sku_code,
         ranked.formula_method, ranked.window_size, ranked.std_multiplier, ranked.min_reports,
         ranked.demand_multiplier, ranked.batch_size, ranked.effective_from_service_date,
         ranked.effective_from_cutoff_date, ranked.policy_snapshot
  from ranked
  where ranked.policy_rank = 1
  order by ranked.location_code, ranked.effective_from_service_date desc;
end;
$$;

revoke all on function public.get_active_kiosk_bread_dynamic_order_policies(date) from public;
revoke all on function public.get_active_kiosk_bread_dynamic_order_policies(date) from anon;
revoke all on function public.get_active_kiosk_bread_dynamic_order_policies(date) from authenticated;
grant execute on function public.get_active_kiosk_bread_dynamic_order_policies(date) to service_role;

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
  v_frozen_dynamic_policy jsonb;
  v_warehouse_dynamic_policy jsonb;
  v_supplier_quantity_semantics text;
  v_warehouse_quantity_semantics text;
  v_frozen_fixed_quantity numeric;
  v_dynamic_multiplier numeric;
  v_dynamic_batch_size numeric;
  v_dynamic_sold_quantity numeric;
  v_dynamic_saleable_closing_quantity numeric;
  v_dynamic_protected_demand numeric;
  v_dynamic_net_demand numeric;
  v_dynamic_lower_batch numeric;
  v_dynamic_formula_method text;
  v_dynamic_window_size numeric;
  v_dynamic_std_multiplier numeric;
  v_dynamic_min_reports integer;
  v_dynamic_window_count integer := 0;
  v_dynamic_window_mean numeric;
  v_dynamic_window_std numeric;
  v_corrected_supplier_locations jsonb;
  v_corrected_locations jsonb;
  v_key_base text;
  v_supplier_key text;
  v_warehouse_key text;
  v_inserted integer := 0;
  v_row_count integer := 0;
  v_dealer numeric := 0;
  v_dealer_ordered numeric := 0;
  v_mam_non_ordered numeric := 0;
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

  -- Corrections must replay the source policy frozen in both already-sent
  -- supplier and warehouse snapshots. They must not discover newer policy rows.
  v_frozen_fixed_policy := v_old_location->'fixedInboundPolicy';
  v_warehouse_fixed_policy := v_old_warehouse_location->'fixedInboundPolicy';
  v_frozen_dynamic_policy := v_old_location->'dynamicInboundPolicy';
  v_warehouse_dynamic_policy := v_old_warehouse_location->'dynamicInboundPolicy';
  v_supplier_quantity_semantics := nullif(v_old_location->>'quantitySemantics', '');
  v_warehouse_quantity_semantics := nullif(v_old_warehouse_location->>'quantitySemantics', '');

  if (v_frozen_fixed_policy is null) <> (v_warehouse_fixed_policy is null)
     or (v_frozen_dynamic_policy is null) <> (v_warehouse_dynamic_policy is null)
     or v_frozen_fixed_policy is distinct from v_warehouse_fixed_policy
     or v_frozen_dynamic_policy is distinct from v_warehouse_dynamic_policy
     or v_supplier_quantity_semantics is distinct from v_warehouse_quantity_semantics then
    raise exception 'policy_snapshot_mismatch' using errcode = '22023';
  end if;

  if v_frozen_fixed_policy is not null and v_frozen_dynamic_policy is not null then
    raise exception 'policy_snapshot_mismatch' using errcode = '22023';
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

  if v_frozen_dynamic_policy is not null then
    begin
      v_dynamic_multiplier := (v_frozen_dynamic_policy->>'demandMultiplier')::numeric;
      v_dynamic_batch_size := (v_frozen_dynamic_policy->>'batchSize')::numeric;
      v_dynamic_formula_method := coalesce(
        nullif(v_frozen_dynamic_policy->>'formulaMethod', ''),
        'exact_day_multiplier'
      );
      v_dynamic_window_size := coalesce((v_frozen_dynamic_policy->>'windowSize')::numeric, 7);
      v_dynamic_std_multiplier := coalesce((v_frozen_dynamic_policy->>'stdMultiplier')::numeric, 0);
      v_dynamic_min_reports := coalesce((v_frozen_dynamic_policy->>'minReports')::integer, 3);
    exception when others then
      raise exception 'dynamic_policy_snapshot_invalid' using errcode = '22023';
    end;
    if v_dynamic_formula_method not in ('exact_day_multiplier', 'window_mean_plus_k_std')
       or coalesce(v_dynamic_multiplier, 0) <= 0
       or coalesce(v_dynamic_batch_size, 0) <= 0
       or (
         v_dynamic_formula_method = 'exact_day_multiplier'
         and v_supplier_quantity_semantics is distinct from 'bhn_exact_date_120pct_sold_minus_saleable_closing_round20'
       )
       or (
         v_dynamic_formula_method = 'window_mean_plus_k_std'
         and v_supplier_quantity_semantics is distinct from 'bhn_window7_mean_plus_1p5_std_minus_saleable_closing_round20'
       ) then
      raise exception 'dynamic_policy_snapshot_invalid' using errcode = '22023';
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
  -- The original correction predates Mầm non May. Preserve its demand for
  -- dynamic BHN corrections without changing older/non-dynamic corrections.
  v_mam_non_ordered := case when v_frozen_dynamic_policy is not null
    then coalesce((v_supplier.source_snapshot #>> '{mam_non,ordered_quantity}')::numeric, 0)
    else 0 end;
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
         coalesce(max(closing_quantity) filter (where report_rank = 1), 0),
         coalesce(count(*) filter (where report_rank <= v_dynamic_window_size), 0),
         avg(sold_quantity) filter (where report_rank <= v_dynamic_window_size),
         stddev_pop(sold_quantity) filter (where report_rank <= v_dynamic_window_size)
    into v_peak_sold, v_latest_closing_quantity,
         v_dynamic_window_count, v_dynamic_window_mean, v_dynamic_window_std
  from ranked;

  if v_frozen_dynamic_policy is not null then
    v_dynamic_sold_quantity := coalesce(v_bread.sold_quantity, 0);
    v_dynamic_saleable_closing_quantity := coalesce(v_bread.closing_quantity, 0);
    if v_dynamic_formula_method = 'window_mean_plus_k_std'
       and v_dynamic_window_count >= v_dynamic_min_reports then
      v_dynamic_protected_demand := round(
        coalesce(v_dynamic_window_mean, 0)
        + v_dynamic_std_multiplier * coalesce(v_dynamic_window_std, 0),
        3
      );
    else
      v_dynamic_protected_demand := round(v_dynamic_sold_quantity * v_dynamic_multiplier, 3);
    end if;
    v_dynamic_net_demand := greatest(0, v_dynamic_protected_demand - v_dynamic_saleable_closing_quantity);
    v_dynamic_lower_batch := case
      when v_dynamic_net_demand > 0 then floor(v_dynamic_net_demand / v_dynamic_batch_size) * v_dynamic_batch_size
      else 0
    end;
    v_new_location := case
      when nullif(v_old_location->>'closureReason', '') is not null then 0
      else ceiling(v_dynamic_net_demand / v_dynamic_batch_size) * v_dynamic_batch_size
    end;
    v_peak_sold := v_dynamic_sold_quantity;
    v_latest_closing_quantity := v_dynamic_saleable_closing_quantity;
  else
    v_new_location := case
      when nullif(v_old_location->>'closureReason', '') is not null then 0
      when v_frozen_fixed_policy is not null then v_frozen_fixed_quantity
      else greatest(0, ceiling(greatest(0, (v_peak_sold * 1.1) - v_latest_closing_quantity) / 10) * 10)
    end;
  end if;

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
          'reportUpdatedAt', v_report.updated_at,
          'breadRowPresent', true
        )
      ) || case when v_frozen_fixed_policy is null then '{}'::jsonb else jsonb_build_object(
        'fixedInboundPolicy', v_frozen_fixed_policy,
        'quantitySemantics', v_supplier_quantity_semantics
      ) end || case when v_frozen_dynamic_policy is null then '{}'::jsonb else jsonb_build_object(
        'dynamicInboundPolicy', v_frozen_dynamic_policy,
        'quantitySemantics', v_supplier_quantity_semantics,
        'protectedDemandQuantity', v_dynamic_protected_demand,
        'netDemandQuantity', v_dynamic_net_demand,
        'lowerBatchQuantity', v_dynamic_lower_batch,
        'upperBatchQuantity', v_new_location,
        'roundingDecision', case
          when v_new_location > 0
               and v_dynamic_formula_method = 'window_mean_plus_k_std'
               and v_dynamic_window_count >= v_dynamic_min_reports
            then 'dynamic_window_mean_std_round_up_to_batch'
          when v_new_location > 0 then 'dynamic_exact_report_round_up_to_batch'
          else 'dynamic_exact_no_new_order_needed'
        end
      ) || case when v_dynamic_formula_method = 'window_mean_plus_k_std' then jsonb_build_object(
        'windowMean', round(coalesce(v_dynamic_window_mean, 0), 3),
        'windowStd', round(coalesce(v_dynamic_window_std, 0), 3),
        'windowReportCount', v_dynamic_window_count
      ) else '{}'::jsonb end end
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
        'peakSoldQuantity', v_peak_sold,
        'latestClosingQuantity', v_latest_closing_quantity,
        'latestReportDate', v_report.report_date,
        'latestReportSource', jsonb_build_object(
          'reportId', v_report.id,
          'reportUpdatedAt', v_report.updated_at,
          'breadRowPresent', true
        )
      ) || case when v_frozen_fixed_policy is null then '{}'::jsonb else jsonb_build_object(
        'fixedInboundPolicy', v_frozen_fixed_policy,
        'quantitySemantics', v_supplier_quantity_semantics
      ) end || case when v_frozen_dynamic_policy is null then '{}'::jsonb else jsonb_build_object(
        'dynamicInboundPolicy', v_frozen_dynamic_policy,
        'quantitySemantics', v_supplier_quantity_semantics,
        'protectedDemandQuantity', v_dynamic_protected_demand,
        'netDemandQuantity', v_dynamic_net_demand,
        'lowerBatchQuantity', v_dynamic_lower_batch,
        'upperBatchQuantity', v_new_location,
        'roundingDecision', case
          when v_new_location > 0
               and v_dynamic_formula_method = 'window_mean_plus_k_std'
               and v_dynamic_window_count >= v_dynamic_min_reports
            then 'dynamic_window_mean_std_round_up_to_batch'
          when v_new_location > 0 then 'dynamic_exact_report_round_up_to_batch'
          else 'dynamic_exact_no_new_order_needed'
        end
      ) || case when v_dynamic_formula_method = 'window_mean_plus_k_std' then jsonb_build_object(
        'windowMean', round(coalesce(v_dynamic_window_mean, 0), 3),
        'windowStd', round(coalesce(v_dynamic_window_std, 0), 3),
        'windowReportCount', v_dynamic_window_count
      ) else '{}'::jsonb end end
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
  v_total_new_order := v_dealer_ordered + v_new_vehicle + v_mam_non_ordered;
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
      case when v_mam_non_ordered > 0 then
        '• Mầm non May: ' || replace(to_char(v_mam_non_ordered, 'FM999,999,999,990'), ',', '.') || ' que' || E'\n'
        else '' end,
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
      ) || case when v_frozen_dynamic_policy is null then '{}'::jsonb
        else jsonb_build_object('mam_non_ordered_quantity', v_mam_non_ordered) end
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

revoke all on function public.queue_late_kiosk_bread_order_corrections(uuid, uuid) from public, anon, authenticated;
grant execute on function public.queue_late_kiosk_bread_order_corrections(uuid, uuid) to service_role;
