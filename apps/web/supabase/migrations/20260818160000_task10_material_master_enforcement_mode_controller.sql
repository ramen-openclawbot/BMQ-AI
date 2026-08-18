-- Task 10: audited per-source material-master enforcement-mode controller.
-- Additive RPC only. No mode seed/update, no historical/master/ledger DML.

create or replace function public.set_material_master_enforcement_mode(
  p_source_type text,
  p_expected_mode text,
  p_new_mode text,
  p_reason text,
  p_readiness_snapshot jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_source_type text := nullif(lower(btrim(coalesce(p_source_type, ''))), '');
  v_new_mode text := nullif(lower(btrim(coalesce(p_new_mode, ''))), '');
  v_expected_mode text := nullif(lower(btrim(coalesce(p_expected_mode, ''))), '');
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_old_mode text;
  v_dashboard record;
  v_safe_caller_snapshot jsonb := '{}'::jsonb;
  v_server_snapshot jsonb := '{}'::jsonb;
  v_old_snapshot jsonb := '{}'::jsonb;
  v_new_snapshot jsonb := '{}'::jsonb;
  v_audit_id uuid;
begin
  if v_actor is null then
    raise exception 'authentication required' using errcode = '42501';
  end if;
  if public.material_master_jwt_role() = 'service_role' then
    raise exception 'service_role actor spoofing is not allowed' using errcode = '42501';
  end if;
  if not (public.has_role(v_actor, 'owner') or public.has_module_permission(v_actor, 'material_master', 'edit')) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if v_reason is null then
    raise exception 'reason required' using errcode = '22023';
  end if;
  if v_source_type is null or not (v_source_type = any(array[
    'sku_cogs',
    'scan_sku_cost_sheet',
    'purchase_order',
    'goods_receipt',
    'payment_request',
    'invoice',
    'create_invoice_from_pr',
    'match_delivery_note',
    'kitchen_inventory'
  ])) then
    raise exception 'source type is not allowed; use kitchen_inventory for Q7 material issue rollout' using errcode = '22023';
  end if;
  if v_new_mode not in ('disabled', 'shadow', 'enforced') then
    raise exception 'unsupported enforcement mode' using errcode = '22023';
  end if;
  if v_expected_mode not in ('disabled', 'shadow', 'enforced') then
    raise exception 'expected enforcement mode required' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('material_master_enforcement_mode:' || v_source_type, 0));

  select cfg.mode into v_old_mode
  from public.material_master_enforcement_config cfg
  where cfg.source_type = v_source_type
  for update;
  if not found then
    raise exception 'source enforcement config row not found' using errcode = 'P0002';
  end if;
  if v_old_mode is distinct from v_expected_mode then
    raise exception 'material master enforcement mode conflict' using errcode = '40001';
  end if;

  v_safe_caller_snapshot := public.material_master_safe_payload(
    coalesce(p_readiness_snapshot, '{}'::jsonb),
    array['source_type','mode','ready_for_enforcement','queue_pending_count','queue_blocked_count','blockers','mode_updated_at','reason_code','requested_by']
  );

  if v_old_mode = v_new_mode then
    return jsonb_build_object(
      'status', 'mode_unchanged',
      'source_type', v_source_type,
      'mode', v_old_mode,
      'audit_id', null,
      'safe_payload', jsonb_build_object('caller_snapshot', v_safe_caller_snapshot)
    );
  end if;

  -- These exact-approved controllers are intrinsically fail-closed rather than
  -- mode-switched wrappers. Never permit a cosmetic rollback/disable.
  if v_source_type in ('sku_cogs','scan_sku_cost_sheet','kitchen_inventory') then
    raise exception 'fixed exact-approved controller mode cannot be changed' using errcode = '23514';
  end if;

  if v_new_mode = 'disabled'
     and coalesce(v_safe_caller_snapshot->>'reason_code', '') <> 'emergency_disable' then
    raise exception 'emergency disable acknowledgement required' using errcode = '22023';
  end if;

  if not (
    (v_old_mode = 'shadow' and v_new_mode = 'enforced')
    or (v_old_mode = 'enforced' and v_new_mode = 'shadow')
    or (v_old_mode = 'disabled' and v_new_mode = 'shadow')
    or (v_old_mode in ('shadow','enforced') and v_new_mode = 'disabled')
  ) then
    raise exception 'unsupported enforcement mode transition' using errcode = '22023';
  end if;

  if v_old_mode = 'shadow' and v_new_mode = 'enforced' then
    select * into v_dashboard
    from public.get_material_master_rollout_dashboard()
    where source_type = v_source_type;

    if not found then
      raise exception 'rollout dashboard row required before enforcement' using errcode = '23514';
    end if;

    v_server_snapshot := jsonb_build_object(
      'source_type', v_dashboard.source_type,
      'mode', v_dashboard.mode,
      'ready_for_enforcement', v_dashboard.ready_for_enforcement,
      'queue_pending_count', v_dashboard.queue_pending_count,
      'queue_blocked_count', v_dashboard.queue_blocked_count,
      'blockers', coalesce(v_dashboard.blockers, '[]'::jsonb),
      'mode_updated_at', v_dashboard.mode_updated_at
    );

    if v_dashboard.ready_for_enforcement is not true then
      raise exception 'source is not ready_for_enforcement' using errcode = '23514';
    end if;
    if v_dashboard.queue_pending_count <> 0 then
      raise exception 'source has pending material resolution queue' using errcode = '23514';
    end if;
    if v_dashboard.queue_blocked_count <> 0 then
      raise exception 'source has rejected material resolution queue' using errcode = '23514';
    end if;
    if jsonb_array_length(coalesce(v_dashboard.blockers, '[]'::jsonb)) <> 0 then
      raise exception 'source has rollout blockers' using errcode = '23514';
    end if;
    if coalesce(v_safe_caller_snapshot->>'source_type', '') <> v_dashboard.source_type
       or coalesce(v_safe_caller_snapshot->>'mode', '') <> v_dashboard.mode
       or coalesce((v_safe_caller_snapshot->>'ready_for_enforcement')::boolean, false) is distinct from v_dashboard.ready_for_enforcement then
      raise exception 'caller rollout snapshot is stale' using errcode = '40001';
    end if;
  else
    v_server_snapshot := jsonb_build_object(
      'source_type', v_source_type,
      'mode', v_old_mode,
      'ready_for_enforcement', null,
      'queue_pending_count', null,
      'queue_blocked_count', null,
      'blockers', '[]'::jsonb
    );
  end if;

  v_old_snapshot := jsonb_build_object('source_type', v_source_type, 'mode', v_old_mode, 'metadata', (select metadata from public.material_master_enforcement_config where source_type = v_source_type));

  update public.material_master_enforcement_config
  set mode = v_new_mode,
      updated_by = v_actor,
      updated_at = now()
  where source_type = v_source_type;

  v_new_snapshot := jsonb_build_object('source_type', v_source_type, 'mode', v_new_mode, 'metadata', (select metadata from public.material_master_enforcement_config where source_type = v_source_type));

  v_audit_id := public.material_master_audit_append(
    'set_material_master_enforcement_mode',
    null,
    null,
    v_reason,
    v_old_snapshot,
    v_new_snapshot,
    jsonb_build_object(
      'source_type', v_source_type,
      'mode', v_new_mode,
      'ready_for_enforcement', v_server_snapshot->'ready_for_enforcement',
      'queue_pending_count', v_server_snapshot->'queue_pending_count',
      'queue_blocked_count', v_server_snapshot->'queue_blocked_count',
      'blockers', v_server_snapshot->'blockers',
      'reason_code', v_safe_caller_snapshot->'reason_code',
      'requested_by', v_actor,
      'caller_snapshot', v_safe_caller_snapshot,
      'server_snapshot', v_server_snapshot
    )
  );

  return jsonb_build_object(
    'status', 'mode_changed',
    'source_type', v_source_type,
    'old_mode', v_old_mode,
    'mode', v_new_mode,
    'audit_id', v_audit_id,
    'safe_payload', jsonb_build_object(
      'source_type', v_source_type,
      'mode', v_new_mode,
      'server_snapshot', v_server_snapshot
    )
  );
end;
$$;

revoke all on function public.set_material_master_enforcement_mode(text, text, text, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.set_material_master_enforcement_mode(text, text, text, text, jsonb) to authenticated;
