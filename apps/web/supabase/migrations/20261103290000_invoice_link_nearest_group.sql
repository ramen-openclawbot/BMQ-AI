-- Ghép hoá đơn mở rộng (owner 29/10 "tại sao không search hết"):
--   pass 3: nhiều phiếu cùng số tiền → lấy phiếu lập gần ngày hoá đơn nhất khi rõ ràng
--           (gần hơn phiếu thứ hai ≥ 3 ngày, cách hoá đơn ≤ 10 ngày);
--   pass 4: một phiếu chi trả nhiều hoá đơn → tổng 2–4 hoá đơn chưa ghép của cùng NCC
--           bằng đúng tổng phiếu (vd Phúc Thịnh 8522 + 8557 = PR-7399CE38).
-- Không đổi số tiền, trạng thái hay khoản chi.

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
  v_near_id uuid;
  v_near_number text;
  v_group_ids uuid[];
  v_group_json jsonb;
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


  -- Pass 3 (owner 29/10): several requests with the same amount — take the one lập
  -- nearest the invoice date when it is clearly nearer (≥ 3 days) and within 10 days.
  if v_candidate_count > 1 then
    with c as (
      select pr.id, pr.request_number,
             abs(pr.created_at::date - v_invoice_date) as gap,
             row_number() over (order by abs(pr.created_at::date - v_invoice_date), pr.created_at) as rn
      from public.payment_requests pr
      where pr.supplier_id = v_inv.supplier_id
        and pr.status::text in ('pending', 'approved')
        and round(pr.total_amount) = round(v_inv.total_amount)
        and pr.created_at::date between v_invoice_date - 45 and v_invoice_date + 10
        and not exists (select 1 from public.incoming_invoices i
                        where i.linked_payment_request_id = pr.id and i.id <> v_inv.id)
    )
    select c1.id, c1.request_number
      into v_near_id, v_near_number
    from c c1
    left join c c2 on c2.rn = 2
    where c1.rn = 1
      and c1.gap <= 10
      and (c2.gap is null or c2.gap - c1.gap >= 3);
    if v_near_id is not null then
      v_candidate_count := 1;
      v_candidate_id := v_near_id;
      v_candidate_numbers := array[v_near_number];
      v_match_source := 'supplier_amount_nearest';
    end if;
  end if;

  -- Pass 4 (owner 29/10): one request pays several invoices of the supplier (e.g. Phúc
  -- Thịnh 8522 + 8557 = PR-7399CE38). Look for a request whose total equals this invoice
  -- plus 1-3 other unlinked invoices of the same supplier dated near the request.
  if v_candidate_count = 0 then
    with recursive pool as (
      select i.id, round(i.total_amount) as amt, coalesce(i.invoice_date, i.created_at::date) as d
      from public.incoming_invoices i
      where i.supplier_id = v_inv.supplier_id
        and i.id <> v_inv.id
        and i.status = 'needs_review'
        and i.linked_payment_request_id is null
        and i.payment_request_id is null
        and i.total_amount > 0
        and coalesce(i.invoice_date, i.created_at::date) between v_invoice_date - 31 and v_invoice_date + 31
      order by coalesce(i.invoice_date, i.created_at::date)
      limit 12
    ),
    combo(ids, total, last_id, n) as (
      select array[v_inv.id], round(v_inv.total_amount), '00000000-0000-0000-0000-000000000000'::uuid, 1
      union all
      select c.ids || p.id, c.total + p.amt, p.id, c.n + 1
      from combo c join pool p on p.id::text > c.last_id::text
      where c.n < 4
    ),
    hits as (
      select pr.id as pr_id, pr.request_number, cb.ids,
             abs(pr.created_at::date - v_invoice_date) as gap
      from combo cb
      join public.payment_requests pr
        on pr.supplier_id = v_inv.supplier_id
       and pr.status::text in ('pending', 'approved')
       and round(pr.total_amount) = cb.total
       and pr.created_at::date between v_invoice_date - 10 and v_invoice_date + 31
       and not exists (select 1 from public.incoming_invoices x where x.linked_payment_request_id = pr.id)
      where cb.n >= 2
        and (select max(coalesce(i.invoice_date, i.created_at::date)) from public.incoming_invoices i where i.id = any(cb.ids))
              <= pr.created_at::date + 10
    )
    select count(*)::integer, (array_agg(pr_id))[1], (array_agg(request_number))[1:3], (jsonb_agg(to_jsonb(ids)))->0
      into v_candidate_count, v_candidate_id, v_candidate_numbers, v_group_json
    from hits;

    if v_candidate_count = 1 then
      v_group_ids := array(select jsonb_array_elements_text(v_group_json)::uuid);
      v_match_source := 'supplier_group';
    elsif v_candidate_count > 1 then
      v_candidate_count := 2;
    end if;
  end if;

  if v_candidate_count = 1 then
    select *
      into v_pr
    from public.payment_requests
    where id = v_candidate_id
    for update;

    -- Gắn file y như nhánh PO-link; uploaded_by là người lập phiếu chi.
    -- Với ghép nhóm, gắn mọi hoá đơn của nhóm vào cùng phiếu.
    insert into public.payment_request_attachments (
      payment_request_id, storage_path, file_name, mime_type, uploaded_by
    )
    select v_pr.id, g.file_path,
           coalesce(g.file_name, regexp_replace(g.file_path, '^.*/', '')),
           g.file_mime, v_pr.created_by
    from public.incoming_invoices g
    where g.id = any(coalesce(v_group_ids, array[v_inv.id]))
      and g.file_path is not null
      and not exists (
        select 1 from public.payment_request_attachments a
        where a.payment_request_id = v_pr.id and a.storage_path = g.file_path
      );

    update public.incoming_invoices
       set linked_payment_request_id = v_pr.id,
           purchase_order_id = v_pr.purchase_order_id,
           status = 'matched',
           match_source = v_match_source,
           match_confidence = case when v_match_source in ('supplier_amount', 'supplier_amount_paid') then 1 else 0.9 end,
           ingest_note = case when v_group_ids is not null
             then 'Một phiếu chi cho ' || array_length(v_group_ids, 1) || ' hoá đơn' else null end
     where id = any(coalesce(v_group_ids, array[v_inv.id]));

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
