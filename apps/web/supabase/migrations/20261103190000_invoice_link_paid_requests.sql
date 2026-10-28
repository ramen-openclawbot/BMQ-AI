-- Hoá đơn chính thức cũng gắn vào phiếu chi ĐÃ TRẢ (owner 28/10) để phiếu đã chi có
-- đủ chứng từ. Phiếu chưa trả vẫn ưu tiên; chỉ khi không có mới xét phiếu đã trả
-- (approved, paid/overpaid), cùng NCC, số tiền và cửa sổ ngày. Nhiều phiếu đã trả
-- cùng số tiền thì chọn phiếu có nội dung UNC ghi số hoá đơn; vẫn nhiều thì để
-- needs_review. Không đổi số tiền, trạng thái hay khoản chi nào.

create or replace function public.link_incoming_invoice_to_payment_request(p_invoice_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inv public.incoming_invoices%rowtype;
  v_pr public.payment_requests%rowtype;
  v_invoice_date date;
  v_candidate_count integer := 0;
  v_candidate_id uuid;
  v_candidate_numbers text[] := array[]::text[];
  v_note text;
  v_invoice_no text;
  v_match_source text := 'supplier_amount';
begin
  if coalesce(public.material_master_jwt_role(), '') <> 'service_role' then
    raise exception 'not_authorized_invoice_link' using errcode = '42501';
  end if;

  select *
    into v_inv
  from public.incoming_invoices
  where id = p_invoice_id
  for update;

  if not found then
    raise exception 'incoming_invoice_not_found' using errcode = 'P0002';
  end if;

  -- Idempotent: đã có phiếu (tự lập hoặc đã ghép) thì không làm gì thêm.
  if v_inv.linked_payment_request_id is not null
     or v_inv.payment_request_id is not null
     or v_inv.supplier_id is null
     or v_inv.total_amount is null then
    return jsonb_build_object('status', 'skipped');
  end if;

  -- Hoá đơn không có ngày thì dùng ngày nạp làm mốc cửa sổ.
  v_invoice_date := coalesce(v_inv.invoice_date, v_inv.created_at::date);

  -- Pass 1: unpaid requests (the invoice the next payment will settle).
  select count(*)::integer,
         (array_agg(pr.id order by pr.created_at desc, pr.id desc))[1],
         (array_agg(pr.request_number order by pr.created_at desc, pr.id desc))[1:3]
    into v_candidate_count, v_candidate_id, v_candidate_numbers
  from public.payment_requests pr
  where pr.supplier_id = v_inv.supplier_id
    and pr.status::text in ('pending', 'approved')
    and pr.payment_status::text in ('unpaid', 'partial')
    and round(pr.total_amount) = round(v_inv.total_amount)
    and pr.created_at::date between v_invoice_date - 45 and v_invoice_date + 10
    and not exists (
      select 1
      from public.incoming_invoices i
      where i.linked_payment_request_id = pr.id
        and i.id <> v_inv.id
    );

  -- Pass 2 (owner 28/10): no unpaid request — attach the invoice to the already
  -- paid request so the paid one has its document. Same supplier, amount and window.
  -- Several paid requests of the same amount (weekly orders) are told apart by the
  -- UNC transfer content naming the invoice number ("... theo Hd 3476, 3477").
  if v_candidate_count = 0 then
    v_invoice_no := nullif(ltrim(coalesce(v_inv.invoice_number, ''), '0'), '');

    with paid as (
      select pr.id, pr.request_number, pr.created_at,
             (v_invoice_no is not null and exists (
               select 1
               from public.payment_allocations pa
               join public.payment_unc_evidence e on e.payment_id = pa.payment_id
               join public.payment_unc_ocr_drafts d on d.file_sha256 = e.file_sha256
               where pa.payment_request_id = pr.id
                 and d.ocr_transfer_content ~* ('(^|[^0-9])0*' || v_invoice_no || '([^0-9]|$)')
             )) as named
      from public.payment_requests pr
      where pr.supplier_id = v_inv.supplier_id
        and pr.status::text = 'approved'
        and pr.payment_status::text in ('paid', 'overpaid')
        and round(pr.total_amount) = round(v_inv.total_amount)
        and pr.created_at::date between v_invoice_date - 45 and v_invoice_date + 10
        and not exists (
          select 1
          from public.incoming_invoices i
          where i.linked_payment_request_id = pr.id
            and i.id <> v_inv.id
        )
    ),
    picked as (
      select * from paid
      where named or not exists (select 1 from paid where named)
    )
    select count(*)::integer,
           (array_agg(id order by created_at desc, id desc))[1],
           (array_agg(request_number order by created_at desc, id desc))[1:3]
      into v_candidate_count, v_candidate_id, v_candidate_numbers
    from picked;

    if v_candidate_count > 0 then
      v_match_source := 'supplier_amount_paid';
    end if;
  end if;

  if v_candidate_count = 1 then
    select *
      into v_pr
    from public.payment_requests
    where id = v_candidate_id
    for update;

    -- Gắn file y như nhánh PO-link; uploaded_by là người lập phiếu chi.
    if v_inv.file_path is not null
       and not exists (
         select 1
         from public.payment_request_attachments a
         where a.payment_request_id = v_pr.id
           and a.storage_path = v_inv.file_path
       ) then
      insert into public.payment_request_attachments (
        payment_request_id,
        storage_path,
        file_name,
        mime_type,
        uploaded_by
      )
      values (
        v_pr.id,
        v_inv.file_path,
        coalesce(v_inv.file_name, regexp_replace(v_inv.file_path, '^.*/', '')),
        v_inv.file_mime,
        v_pr.created_by
      );
    end if;

    update public.incoming_invoices
       set linked_payment_request_id = v_pr.id,
           purchase_order_id = v_pr.purchase_order_id,
           status = 'matched',
           match_source = v_match_source,
           match_confidence = 1,
           ingest_note = null
     where id = v_inv.id;

    return jsonb_build_object(
      'status', 'matched',
      'payment_request_id', v_pr.id,
      'request_number', v_pr.request_number,
      'match_source', v_match_source
    );
  end if;

  if v_candidate_count = 0 then
    v_note := 'Chưa tìm thấy phiếu chi cùng NCC và số tiền (chưa trả hoặc đã trả)';
  else
    v_note := 'Nhiều phiếu chi khớp: '
      || array_to_string(coalesce(v_candidate_numbers, array[]::text[]), ', ');
  end if;

  update public.incoming_invoices
     set status = 'needs_review',
         ingest_note = v_note
   where id = v_inv.id;

  return jsonb_build_object(
    'status', 'needs_review',
    'candidates', to_jsonb(coalesce(v_candidate_numbers, array[]::text[]))
  );
end;
$$;

revoke all on function public.link_incoming_invoice_to_payment_request(uuid)
  from public, anon, authenticated;
grant execute on function public.link_incoming_invoice_to_payment_request(uuid)
  to service_role;
