-- Rollback-only smoke cho migration 20261103170000_invoice_auto_link_payment_request.sql.
--
-- Chạy: `supabase db query --linked -f scripts/smoke_invoice_auto_link.sql`.
-- File KHÔNG dán migration và KHÔNG áp dụng gì: migration do Maestro review và
-- apply trước, sau đó script này chạy toàn bộ trong transaction rồi rollback.
-- Không duyệt / chi / từ chối / đổi số tiền của bất kỳ phiếu nào.

begin;

-- service_role claim để gọi được các RPC chỉ dành cho service_role.
do $$
declare
  v_owner uuid;
begin
  select ur.user_id
    into v_owner
  from public.user_roles ur
  where ur.role = 'owner'::public.app_role
  order by ur.created_at
  limit 1;

  if v_owner is null then
    raise exception 'SMOKE FAIL: no owner user';
  end if;

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'service_role')::text,
    true
  );
  perform set_config('request.jwt.claim.role', 'service_role', true);
end $$;

-- (a) Hoá đơn Nam Nguyễn 00010771 ghép đúng phiếu PR-C1209293, gắn đúng một file.
do $$
declare
  v_invoice public.incoming_invoices%rowtype;
  v_result jsonb;
  v_again jsonb;
  v_attachment_count integer;
begin
  select *
    into v_invoice
  from public.incoming_invoices
  where invoice_number = '00010771'
    and seller_tax_code = '0317792499'
  order by created_at desc
  limit 1;

  if not found then
    raise exception 'SMOKE FAIL: incoming invoice 00010771 / 0317792499 not found';
  end if;

  if v_invoice.file_path is null then
    raise exception 'SMOKE FAIL: invoice % has no file_path', v_invoice.id;
  end if;

  v_result := public.link_incoming_invoice_to_payment_request(v_invoice.id);

  if v_result->>'status' <> 'matched' then
    raise exception 'SMOKE FAIL: expected matched, got %', v_result;
  end if;
  if v_result->>'request_number' <> 'PR-C1209293' then
    raise exception 'SMOKE FAIL: expected request PR-C1209293, got %',
      v_result->>'request_number';
  end if;

  select count(*)::integer
    into v_attachment_count
  from public.payment_request_attachments a
  where a.payment_request_id = (v_result->>'payment_request_id')::uuid
    and a.storage_path = v_invoice.file_path;

  if v_attachment_count <> 1 then
    raise exception 'SMOKE FAIL: expected exactly 1 attachment for %, got %',
      v_invoice.file_path, v_attachment_count;
  end if;

  -- Gọi lại phải idempotent, không gắn file lần hai.
  v_again := public.link_incoming_invoice_to_payment_request(v_invoice.id);
  if v_again->>'status' <> 'skipped' then
    raise exception 'SMOKE FAIL: second call expected skipped, got %', v_again;
  end if;

  raise notice 'SMOKE invoice auto link: %', v_result;
end $$;

-- (b) Backfill một lần trên dữ liệu hiện có; in ra số lượng.
select public.backfill_incoming_invoice_links() as backfill_counts;

rollback;
