-- VNAgent data-assets admin — SQL security + behaviour regression.
--
-- Run AFTER the bootstrap roles and the migrations:
--   psql "$VNAGENT_TEST_DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f apps/web/supabase/migrations/20260920120000_vnagent_data_assets.sql \
--     -f apps/web/supabase/migrations/20260920130000_vnagent_data_admin_corrections.sql \
--     -f apps/web/scripts/qa_vnagent_data_admin_sql.sql
--
-- The privilege assertions below are the mechanism that stops the direct
-- stage/version/evidence/audit bypass; qa_vnagent_data_admin_sql.sh additionally
-- attempts the raw authenticated writes and fails if any of them succeeds.

-- Owner identity for the functional RPC calls (RPCs check auth.uid() role).
set request.jwt.claim.sub = '00000000-0000-4000-8000-000000000001';

do $$
declare
  v_created jsonb;
  v_dup jsonb;
  v_distinct jsonb;
  v_asset_id uuid;
  v_evidence_asset jsonb;
  v_evidence_id uuid;
  v_timeseries jsonb;
  v_capture jsonb;
  v_question text := 'QA doanh thu hôm nay?';
begin
  -- 1. authenticated must hold SELECT only on every table (no direct writes).
  if has_table_privilege('authenticated', 'public.vnagent_data_assets', 'INSERT')
     or has_table_privilege('authenticated', 'public.vnagent_data_assets', 'UPDATE')
     or has_table_privilege('authenticated', 'public.vnagent_data_assets', 'DELETE') then
    raise exception 'authenticated can write vnagent_data_assets directly';
  end if;
  if has_table_privilege('authenticated', 'public.vnagent_data_asset_events', 'INSERT')
     or has_table_privilege('authenticated', 'public.vnagent_data_asset_events', 'UPDATE')
     or has_table_privilege('authenticated', 'public.vnagent_data_asset_events', 'DELETE') then
    raise exception 'authenticated can write the audit trail directly';
  end if;
  if has_table_privilege('authenticated', 'public.vnagent_interactions', 'INSERT')
     or has_table_privilege('authenticated', 'public.vnagent_interactions', 'UPDATE')
     or has_table_privilege('authenticated', 'public.vnagent_interactions', 'DELETE') then
    raise exception 'authenticated can write vnagent_interactions directly';
  end if;
  if has_table_privilege('authenticated', 'public.vnagent_jev_events', 'INSERT')
     or has_table_privilege('authenticated', 'public.vnagent_jev_events', 'UPDATE') then
    raise exception 'authenticated can write vnagent_jev_events directly';
  end if;

  -- 2. service_role also cannot bypass the reviewed routines for assets/events.
  if has_table_privilege('service_role', 'public.vnagent_data_assets', 'INSERT')
     or has_table_privilege('service_role', 'public.vnagent_data_assets', 'UPDATE')
     or has_table_privilege('service_role', 'public.vnagent_data_asset_events', 'INSERT') then
    raise exception 'service_role can bypass the reviewed asset/audit routines';
  end if;

  -- 3. capture is trusted-server only; authenticated cannot call it.
  if has_function_privilege('authenticated', 'public.vnagent_capture_chat(jsonb,jsonb)', 'EXECUTE') then
    raise exception 'authenticated can call vnagent_capture_chat';
  end if;
  if not has_function_privilege('service_role', 'public.vnagent_capture_chat(jsonb,jsonb)', 'EXECUTE') then
    raise exception 'service_role cannot call vnagent_capture_chat';
  end if;

  -- 4. the reviewed transition/create routines are SECURITY DEFINER.
  if not exists (
    select 1 from pg_proc
    where oid = 'public.vnagent_transition_data_asset(uuid,integer,text,text,jsonb)'::regprocedure
      and prosecdef
  ) then
    raise exception 'transition RPC is not SECURITY DEFINER';
  end if;
  if not exists (
    select 1 from pg_proc
    where oid = 'public.vnagent_create_data_asset(text,text,text,jsonb,jsonb,jsonb,timestamptz,text)'::regprocedure
      and prosecdef
  ) then
    raise exception 'create RPC is not SECURITY DEFINER';
  end if;

  -- 5. contribution RPC: created -> duplicate -> distinct scope.
  v_created := public.vnagent_create_data_asset(v_question, 'contributor', 'manual', '{"intent":"tra cứu"}'::jsonb, '{"range":"today"}'::jsonb, '{}'::jsonb, null, null);
  if v_created ->> 'status' <> 'created' then raise exception 'contribution was not created'; end if;
  if (v_created -> 'asset' ->> 'source_kind') <> 'contributor' then raise exception 'wrong source kind'; end if;
  if (v_created -> 'asset' ->> 'dataset_stage') <> 'raw' then raise exception 'contribution did not start raw'; end if;
  if (v_created -> 'asset' ->> 'created_by') <> '00000000-0000-4000-8000-000000000001' then raise exception 'created_by not server-derived'; end if;
  if (v_created -> 'asset' ->> 'reviewer_id') is not null then raise exception 'new asset has a fabricated reviewer'; end if;
  v_asset_id := (v_created -> 'asset' ->> 'id')::uuid;

  v_dup := public.vnagent_create_data_asset(v_question, 'contributor', 'manual', '{"intent":"tra cứu"}'::jsonb, '{"range":"today"}'::jsonb, '{}'::jsonb, null, null);
  if v_dup ->> 'status' <> 'duplicate' then raise exception 'same question+scope was not a duplicate'; end if;
  if (v_dup -> 'asset' ->> 'id')::uuid <> v_asset_id then raise exception 'duplicate returned a different asset'; end if;

  v_distinct := public.vnagent_create_data_asset(v_question, 'contributor', 'manual', '{"intent":"tra cứu"}'::jsonb, '{"range":"this_week"}'::jsonb, '{}'::jsonb, null, null);
  if v_distinct ->> 'status' <> 'created' then raise exception 'different expected scope collapsed'; end if;
  if (v_distinct -> 'asset' ->> 'id')::uuid = v_asset_id then raise exception 'different scope reused the same asset'; end if;

  -- 6. operational_chat cannot be fabricated through the manual form.
  begin
    perform public.vnagent_create_data_asset('QA', 'operational_chat', 'manual', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, null, null);
    raise exception 'manual form accepted operational_chat';
  exception when others then
    if position('manual form accepted operational_chat' in sqlerrm) > 0 then raise; end if;
  end;

  -- 7. Gold evidence must be meaningful on a VALID curated -> gold transition.
  -- A raw -> gold jump would be rejected as an invalid transition regardless of
  -- evidence, so use a dedicated asset that is first promoted to curated.
  v_evidence_asset := public.vnagent_create_data_asset('QA evidence placeholder?', 'contributor', 'manual', '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, null, null);
  v_evidence_id := (v_evidence_asset -> 'asset' ->> 'id')::uuid;
  perform public.vnagent_transition_data_asset(v_evidence_id, 1, 'curated', null, null);
  begin
    perform public.vnagent_transition_data_asset(v_evidence_id, 2, 'gold', null, '{"intent":"x","conditions":{"a":1},"evidence":[null]}'::jsonb);
    raise exception 'Gold accepted [null] evidence';
  exception when others then
    if position('Gold accepted [null] evidence' in sqlerrm) > 0 then raise; end if;
  end;
  begin
    perform public.vnagent_transition_data_asset(v_evidence_id, 2, 'gold', null, '{"intent":"x","conditions":{"a":1},"evidence":[""]}'::jsonb);
    raise exception 'Gold accepted [empty string] evidence';
  exception when others then
    if position('Gold accepted [empty string] evidence' in sqlerrm) > 0 then raise; end if;
  end;
  begin
    perform public.vnagent_transition_data_asset(v_evidence_id, 2, 'gold', null, '{"intent":"x","conditions":{"a":1},"evidence":[0]}'::jsonb);
    raise exception 'Gold accepted numeric evidence';
  exception when others then
    if position('Gold accepted numeric evidence' in sqlerrm) > 0 then raise; end if;
  end;
  begin
    perform public.vnagent_transition_data_asset(v_evidence_id, 2, 'gold', null, '{"intent":"x","conditions":{"a":1},"evidence":[false]}'::jsonb);
    raise exception 'Gold accepted boolean evidence';
  exception when others then
    if position('Gold accepted boolean evidence' in sqlerrm) > 0 then raise; end if;
  end;
  -- Real evidence still passes on the same asset/version.
  perform public.vnagent_transition_data_asset(v_evidence_id, 2, 'gold', null, '{"intent":"x","conditions":{"a":1},"evidence":[{"kind":"snapshot","ref":"e-1"}]}'::jsonb);

  -- 8. Real promotion + audited event + reviewer binding.
  perform public.vnagent_transition_data_asset(v_asset_id, 1, 'curated', null, null);
  perform public.vnagent_transition_data_asset(v_asset_id, 2, 'gold', null, '{"intent":"doanh thu có kiểm soát","conditions":{"period":"today"},"evidence":[{"kind":"snapshot","ref":"snap-1"}]}'::jsonb);
  if (select count(*) from public.vnagent_data_asset_events where asset_id = v_asset_id) <> 2 then
    raise exception 'audited transition events were not written';
  end if;
  if (select reviewer_id from public.vnagent_data_assets where id = v_asset_id) <> '00000000-0000-4000-8000-000000000001' then
    raise exception 'reviewer identity was not bound to the real owner';
  end if;

  -- 9. Trusted capture is atomic and idempotent: one interaction + one raw asset + one Jev row.
  v_capture := public.vnagent_capture_chat(
    jsonb_build_object(
      'request_id', 'qa-event-1', 'actor_id', '00000000-0000-4000-8000-000000000001',
      'question_text', 'QA question', 'answer_text', 'QA answer', 'response_status', 'success',
      'known_usage', jsonb_build_object('answered', true, 'tokens', null),
      'executed_filters', jsonb_build_object('metrics', jsonb_build_array('controlled_revenue')),
      'provenance', jsonb_build_object(
        'semanticVersion', 's-1', 'citations', jsonb_build_array('doc-1'),
        'snapshot', 'snap-0', 'apiKey', 'must-not-be-stored'
      )
    ),
    jsonb_build_object('metric', 'controlled_revenue', 'metric_probability', 0.99, 'attempted', true, 'decided', true, 'usage', jsonb_build_object('input', 500, 'output', 20), 'timings', jsonb_build_object('totalMs', 200), 'counts', jsonb_build_object('warehouseReads', 2), 'decision', 'controlled_revenue')
  );
  perform public.vnagent_capture_chat(
    jsonb_build_object('request_id', 'qa-event-1', 'question_text', 'QA question', 'response_status', 'success'),
    null
  );
  if (select count(*) from public.vnagent_interactions where request_id = 'qa-event-1') <> 1 then
    raise exception 'capture did not stay idempotent';
  end if;
  if (select count(*) from public.vnagent_data_assets where dedupe_key = 'operational_chat:' || md5('bmq|' || 'qa-event-1')) <> 1 then
    raise exception 'capture did not create exactly one raw asset';
  end if;
  if (select count(*) from public.vnagent_jev_events where request_id = 'qa-event-1') <> 1 then
    raise exception 'capture did not write exactly one Jev row';
  end if;
  if (select token_counts ->> 'input' from public.vnagent_jev_events where request_id = 'qa-event-1') <> '500' then
    raise exception 'real Jev usage was not retained';
  end if;
  if not exists (select 1 from public.vnagent_data_assets where dedupe_key = 'operational_chat:' || md5('bmq|' || 'qa-event-1') and source_answer = 'QA answer') then
    raise exception 'auto raw asset did not keep the original answer';
  end if;
  -- The asset keeps the original interaction provenance, nested and sanitized.
  if (select provenance #>> '{sourceProvenance,semanticVersion}' from public.vnagent_data_assets where dedupe_key = 'operational_chat:' || md5('bmq|' || 'qa-event-1')) <> 's-1' then
    raise exception 'auto raw asset dropped the source semanticVersion';
  end if;
  if not (select provenance #> '{sourceProvenance,citations}' @> jsonb_build_array('doc-1') from public.vnagent_data_assets where dedupe_key = 'operational_chat:' || md5('bmq|' || 'qa-event-1')) then
    raise exception 'auto raw asset dropped the source citations';
  end if;
  if (select provenance -> 'sourceProvenance' ? 'apiKey' from public.vnagent_data_assets where dedupe_key = 'operational_chat:' || md5('bmq|' || 'qa-event-1')) then
    raise exception 'source provenance kept a credential-looking key';
  end if;

  -- 10. Daily timeseries reconstructs stock from creation + transition events.
  -- Force same-transaction transitions to share created_at and give the older
  -- version the larger UUID. The tie-break must still select to_version, i.e.
  -- Gold, not the random UUID order.
  update public.vnagent_data_asset_events
     set id = case to_version
       when 2 then 'ffffffff-ffff-4fff-8fff-ffffffffffff'::uuid
       else '00000000-0000-4000-8000-000000000099'::uuid
     end
   where asset_id = v_asset_id;
  v_timeseries := public.vnagent_data_admin_timeseries(7);
  if jsonb_array_length(v_timeseries -> 'days') <> 7 then raise exception 'timeseries did not return 7 days'; end if;
  if (v_timeseries -> 'days' -> -1 -> 'stock' ->> 'gold')::int < 1 then raise exception 'timeseries lost the gold transition'; end if;
  if (v_timeseries -> 'days' -> -1 -> 'stock' ->> 'curated')::int <> 0 then raise exception 'timeseries kept a same-timestamp curated stage'; end if;
  if (v_timeseries -> 'sourceContributions' ->> 'total')::int < 3 then raise exception 'source contributions missing'; end if;

  raise notice 'VNAgent data-admin SQL regression: ALL CHECKS PASSED';
end;
$$;
