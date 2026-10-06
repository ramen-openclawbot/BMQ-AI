-- Giai đoạn 3 (backend, read-only) — Chứng từ UNC của một phiếu chi và các
-- phiếu cùng UNC.
--
-- Additive only. This migration adds ONE read-only, STABLE, SECURITY DEFINER RPC
-- that returns, for a given payment_request, every payment allocated to it with
-- its stored UNC evidence (or null) plus the other payment requests settled by
-- the same payment. It performs no write, redefines no existing function and
-- schedules no cron job. The Chứng từ thanh toán UI is built separately.

-- ---------------------------------------------------------------------------
-- 1. Read-only evidence RPC.
-- ---------------------------------------------------------------------------
create or replace function public.get_payment_request_unc_evidence(p_request_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
begin
  -- Access: owner, or an explicit payment_requests view permission. Anon and
  -- any other authenticated user get insufficient_privilege (42501). Trusted
  -- service-role automation is also allowed.
  if not (
    (
      v_uid is not null
      and (
        public.has_role(v_uid, 'owner')
        or public.has_module_permission(v_uid, 'payment_requests', 'view')
      )
    )
    or public.material_master_jwt_role() = 'service_role'
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  return (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'payment_id', p.id,
          'payment_number', p.payment_number,
          'payment_date', p.payment_date,
          'payment_total', p.amount,
          'allocated_to_request', pa.amount,
          'reference_number', p.reference_number,
          'evidence', case
            when e.id is null then null
            else jsonb_build_object(
              'storage_path', e.storage_path,
              'transfer_date', e.transfer_date,
              'ocr_amount', e.ocr_amount,
              'manual_override', e.manual_override,
              'override_reason', e.override_reason,
              'category', e.category
            )
          end,
          'siblings', coalesce(sb.siblings, '[]'::jsonb)
        )
        order by p.payment_date, p.created_at
      ),
      '[]'::jsonb
    )
    from public.payment_allocations pa
    join public.payments p on p.id = pa.payment_id
    -- payment_id is not guaranteed unique on payment_unc_evidence: keep the
    -- oldest evidence row per payment.
    left join lateral (
      select e2.id, e2.storage_path, e2.transfer_date, e2.ocr_amount,
             e2.manual_override, e2.override_reason, e2.category
      from public.payment_unc_evidence e2
      where e2.payment_id = p.id
      order by e2.created_at
      limit 1
    ) e on true
    -- Other payment requests settled by the same payment (same UNC).
    left join lateral (
      select jsonb_agg(
        jsonb_build_object(
          'request_id', pr2.id,
          'request_number', pr2.request_number,
          'amount', pa2.amount
        )
        order by pr2.request_number
      ) as siblings
      from public.payment_allocations pa2
      join public.payment_requests pr2 on pr2.id = pa2.payment_request_id
      where pa2.payment_id = p.id
        and pa2.payment_request_id <> p_request_id
    ) sb on true
    where pa.payment_request_id = p_request_id
  );
end;
$$;

revoke all on function public.get_payment_request_unc_evidence(uuid) from public, anon;
grant execute on function public.get_payment_request_unc_evidence(uuid) to authenticated, service_role;

comment on function public.get_payment_request_unc_evidence(uuid) is 'Read-only owner / payment_requests view evidence feed for one payment request: each allocated payment with its UNC evidence (or null) and the sibling requests settled by the same payment. Anon raises insufficient_privilege.';

-- ---------------------------------------------------------------------------
-- 2. Signed-URL access to the private payment-unc bucket.
--
-- The same owner-or-view users may read objects in bucket payment-unc so the UI
-- can create short-lived signed URLs. Uploads stay service-role only: no
-- insert/update/delete policy is added here.
-- ---------------------------------------------------------------------------
drop policy if exists payment_unc_evidence_select_by_module_permission on storage.objects;
create policy payment_unc_evidence_select_by_module_permission
  on storage.objects
  for select
  to authenticated
  using (
    bucket_id = 'payment-unc'
    and (
      public.has_role(auth.uid(), 'owner')
      or public.has_module_permission(auth.uid(), 'payment_requests', 'view')
    )
  );
