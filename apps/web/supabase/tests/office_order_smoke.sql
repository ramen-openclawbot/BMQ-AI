-- Rollback-only production smoke CHECKS for migration
-- 20261101350000_office_order_snapshot.sql.
--
-- Run as one file: `begin; <migration>; <this file>` (the caller wraps the
-- migration and these checks in one transaction). This file contains CHECKS
-- ONLY and never copies the migration. Apply the migration in the same
-- transaction right before these checks, e.g. via psql:
--
--   \i apps/web/supabase/migrations/20261101350000_office_order_snapshot.sql
--
-- The final RAISE ends the transaction, so nothing commits.
--
-- Rule under test: get_office_order_snapshot returns a non-empty item list for
-- both warehouses and get_payment_doc_detail returns a full, non-empty document
-- for a real PR and a real PO under the caller's own row-level security.

begin;

-- The migration is applied by the caller in the same transaction as this file.
-- Its CREATE statements are intentionally NOT repeated here.

select set_config(
  'request.jwt.claims',
  json_build_object('role', 'service_role')::text,
  true
);

do $$
declare
  v_pr uuid;
  v_po uuid;
  v_pr_doc jsonb;
  v_po_doc jsonb;
  v_snapshot jsonb;
  v_lines_pr integer;
  v_lines_po integer;
  v_missing_pr_null boolean;
  v_missing_po_null boolean;
  v_items_tan_tao integer;
  v_items_q7 integer;
begin
  -- One real PR with at least one line, one real PO with at least one line.
  select pr.id
    into v_pr
  from public.payment_requests pr
  where exists (
    select 1 from public.payment_request_items pri where pri.payment_request_id = pr.id
  )
  order by pr.created_at desc
  limit 1;

  select po.id
    into v_po
  from public.purchase_orders po
  where exists (
    select 1 from public.purchase_order_items poi where poi.purchase_order_id = po.id
  )
  order by po.created_at desc
  limit 1;

  if v_pr is null then
    raise exception 'SMOKE_RESULT FAIL pr_missing';
  end if;
  if v_po is null then
    raise exception 'SMOKE_RESULT FAIL po_missing';
  end if;

  v_pr_doc := public.get_payment_doc_detail('pr', v_pr);
  if v_pr_doc is null then
    raise exception 'SMOKE_RESULT FAIL pr_not_visible';
  end if;
  if v_pr_doc ->> 'kind' <> 'pr' then
    raise exception 'SMOKE_RESULT FAIL pr_kind: %', v_pr_doc ->> 'kind';
  end if;

  v_po_doc := public.get_payment_doc_detail('po', v_po);
  if v_po_doc is null then
    raise exception 'SMOKE_RESULT FAIL po_not_visible';
  end if;
  if v_po_doc ->> 'kind' <> 'po' then
    raise exception 'SMOKE_RESULT FAIL po_kind: %', v_po_doc ->> 'kind';
  end if;

  v_lines_pr := coalesce(jsonb_array_length(v_pr_doc -> 'lines'), 0);
  v_lines_po := coalesce(jsonb_array_length(v_po_doc -> 'lines'), 0);
  if v_lines_pr <= 0 then
    raise exception 'SMOKE_RESULT FAIL pr_lines_empty';
  end if;
  if v_lines_po <= 0 then
    raise exception 'SMOKE_RESULT FAIL po_lines_empty';
  end if;

  -- An invisible id returns null for both kinds.
  v_missing_pr_null := public.get_payment_doc_detail('pr', gen_random_uuid()) is null;
  v_missing_po_null := public.get_payment_doc_detail('po', gen_random_uuid()) is null;

  v_snapshot := public.get_office_order_snapshot('tan_tao');
  v_items_tan_tao := coalesce(jsonb_array_length(v_snapshot -> 'items'), 0);
  if v_items_tan_tao <= 0 then
    raise exception 'SMOKE_RESULT FAIL tan_tao_items_empty';
  end if;
  if v_snapshot ->> 'location' <> 'tan_tao' then
    raise exception 'SMOKE_RESULT FAIL tan_tao_location: %', v_snapshot ->> 'location';
  end if;

  v_snapshot := public.get_office_order_snapshot('q7');
  v_items_q7 := coalesce(jsonb_array_length(v_snapshot -> 'items'), 0);
  if v_items_q7 <= 0 then
    raise exception 'SMOKE_RESULT FAIL q7_items_empty';
  end if;
  if v_snapshot ->> 'location' <> 'q7' then
    raise exception 'SMOKE_RESULT FAIL q7_location: %', v_snapshot ->> 'location';
  end if;

  raise exception
    'SMOKE_RESULT PASS pr_lines=% po_lines=% missing_pr_null=% missing_po_null=% tan_tao_items=% q7_items=%',
    v_lines_pr,
    v_lines_po,
    v_missing_pr_null,
    v_missing_po_null,
    v_items_tan_tao,
    v_items_q7;
end $$;
