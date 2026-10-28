-- Hoá đơn trùng (cùng MST + ký hiệu + số, NCC gửi 2 email) — owner 29/10.
--   (a) ingest_incoming_invoice: bản nạp sau đánh dấu 'ignored' + ghi chú, không ghép;
--   (b) dọn một lần: mỗi nhóm trùng giữ bản đã gắn phiếu (hoặc bản đầu), còn lại ignored;
--   (c) trigger xoá ghi chú cũ "NCC hàng hóa có đơn mua hàng — ghép vào phiếu theo PO"
--       khi hoá đơn đã matched.
-- Không đụng phiếu chi, khoản chi hay file.

create or replace function public.ingest_incoming_invoice(p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source text;
  v_source_ref text;
  v_id uuid;
  v_inv public.incoming_invoices%rowtype;
  v_po uuid;
  v_supplier uuid;
  v_invoice_date date;
  v_period text;
  v_file_path text;
  v_file_name text;
  v_file_mime text;
  v_pr public.payment_requests%rowtype;
  v_match jsonb;
  v_create jsonb;
  v_error text;
  v_dup public.incoming_invoices%rowtype;
begin
  if coalesce(public.material_master_jwt_role(), '') <> 'service_role' then
    raise exception 'not_authorized_invoice_ingest' using errcode = '42501';
  end if;

  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'invalid_invoice_payload' using errcode = 'P0001';
  end if;

  v_source := nullif(btrim(coalesce(p->>'source', '')), '');
  v_source_ref := nullif(btrim(coalesce(p->>'source_ref', '')), '');
  if v_source is null or v_source not in ('email', 'supplier_link') then
    raise exception 'invalid_invoice_source' using errcode = 'P0001';
  end if;
  if v_source_ref is null then
    raise exception 'invoice_source_ref_required' using errcode = 'P0001';
  end if;

  v_invoice_date := nullif(btrim(coalesce(p->>'invoice_date', '')), '')::date;
  v_period := coalesce(
    nullif(btrim(coalesce(p->>'period', '')), ''),
    case
      when v_invoice_date is not null
        then to_char(date_trunc('month', v_invoice_date), 'YYYY-MM')
      else null
    end
  );
  v_po := nullif(btrim(coalesce(p->>'purchase_order_id', '')), '')::uuid;
  v_supplier := nullif(btrim(coalesce(p->>'supplier_id', '')), '')::uuid;
  v_file_path := nullif(btrim(coalesce(p->>'file_path', '')), '');
  v_file_name := nullif(btrim(coalesce(p->>'file_name', '')), '');
  v_file_mime := nullif(btrim(coalesce(p->>'file_mime', '')), '');

  insert into public.incoming_invoices (
    source,
    source_ref,
    file_path,
    file_mime,
    file_name,
    seller_name,
    seller_tax_code,
    invoice_number,
    invoice_series,
    invoice_date,
    period,
    subtotal,
    vat_amount,
    total_amount,
    raw,
    supplier_id,
    purchase_order_id,
    note
  )
  values (
    v_source,
    v_source_ref,
    v_file_path,
    v_file_mime,
    v_file_name,
    nullif(btrim(coalesce(p->>'seller_name', '')), ''),
    nullif(btrim(coalesce(p->>'seller_tax_code', '')), ''),
    nullif(btrim(coalesce(p->>'invoice_number', '')), ''),
    nullif(btrim(coalesce(p->>'invoice_series', '')), ''),
    v_invoice_date,
    v_period,
    nullif(btrim(coalesce(p->>'subtotal', '')), '')::numeric,
    nullif(btrim(coalesce(p->>'vat_amount', '')), '')::numeric,
    nullif(btrim(coalesce(p->>'total_amount', '')), '')::numeric,
    coalesce(p->'raw', '{}'::jsonb),
    v_supplier,
    v_po,
    nullif(btrim(coalesce(p->>'note', '')), '')
  )
  on conflict (source_ref) do nothing
  returning id into v_id;

  -- Đã nạp trước đó: không đụng vào hóa đơn, phiếu chi hay file.
  if v_id is null then
    select *
      into v_inv
    from public.incoming_invoices
    where source_ref = v_source_ref;

    return jsonb_build_object(
      'id', v_inv.id,
      'status', v_inv.status,
      'match_source', v_inv.match_source,
      'payment_request_id', v_inv.payment_request_id,
      'linked_payment_request_id', v_inv.linked_payment_request_id,
      'needs_jev', false,
      'duplicate', true
    );
  end if;

  -- Cùng một hoá đơn (MST + ký hiệu + số) đã nạp từ email khác: giữ bản đầu,
  -- bản sau đánh dấu ignored, không ghép, không lập phiếu.
  select i.*
    into v_dup
  from public.incoming_invoices i
  join public.incoming_invoices me on me.id = v_id
  where i.id <> v_id
    and i.status <> 'ignored'
    and me.invoice_number is not null
    and me.seller_tax_code is not null
    and i.seller_tax_code = me.seller_tax_code
    and coalesce(i.invoice_series, '') = coalesce(me.invoice_series, '')
    and ltrim(i.invoice_number, '0') = ltrim(me.invoice_number, '0')
  order by i.created_at, i.id
  limit 1;
  if found then
    update public.incoming_invoices
       set status = 'ignored',
           ingest_note = 'Bản trùng của hoá đơn đã nạp ngày '
             || to_char(v_dup.created_at at time zone 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY')
     where id = v_id;
    return jsonb_build_object(
      'id', v_id,
      'status', 'ignored',
      'match_source', null,
      'payment_request_id', v_dup.payment_request_id,
      'linked_payment_request_id', v_dup.linked_payment_request_id,
      'needs_jev', false,
      'duplicate', true
    );
  end if;

  if v_po is not null then
    -- Nạp từ link NCC đã có PO: chỉ gắn file vào phiếu chi mới nhất còn hiệu lực.
    select pr.*
      into v_pr
    from public.payment_requests pr
    where pr.purchase_order_id = v_po
      and pr.status <> 'rejected'::public.payment_request_status
    order by pr.created_at desc, pr.id desc
    limit 1;

    if found then
      if v_file_path is not null
         and not exists (
           select 1
           from public.payment_request_attachments a
           where a.payment_request_id = v_pr.id
             and a.storage_path = v_file_path
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
          v_file_path,
          coalesce(v_file_name, regexp_replace(v_file_path, '^.*/', '')),
          v_file_mime,
          v_pr.created_by
        );
      end if;

      update public.incoming_invoices
         set linked_payment_request_id = v_pr.id,
             status = 'matched',
             match_source = 'po_link',
             ingest_note = null
       where id = v_id;
    else
      update public.incoming_invoices
         set status = 'needs_review',
             note = 'Chưa có đề nghị chi cho đơn mua hàng'
       where id = v_id;
    end if;
  else
    v_match := public.match_incoming_invoice(v_id);
    select *
      into v_inv
    from public.incoming_invoices
    where id = v_id;

    -- PDF/ảnh chưa đọc được tự động: không có số tiền thì luôn để chủ review,
    -- tuyệt đối không lập phiếu 0 đồng.
    if v_inv.total_amount is null then
      update public.incoming_invoices
         set status = 'needs_review'
       where id = v_id;
    elsif v_match->>'status' = 'matched'
       and coalesce(v_match->>'match_source', '') <> 'goods_supplier_po' then
      begin
        v_create := public.create_payment_request_from_invoice(v_id);
      exception
        when others then
          v_error := sqlerrm;
          update public.incoming_invoices
             set ingest_note = v_error,
                 status = 'needs_review'
           where id = v_id;
      end;
    elsif coalesce(v_match->>'match_source', '') = 'goods_supplier_po' then
      begin
        perform public.link_incoming_invoice_to_payment_request(v_id);
      exception
        when others then
          v_error := sqlerrm;
          update public.incoming_invoices
             set ingest_note = v_error,
                 status = 'needs_review'
           where id = v_id;
      end;
    end if;
  end if;

  select *
    into v_inv
  from public.incoming_invoices
  where id = v_id;

  return jsonb_build_object(
    'id', v_inv.id,
    'status', v_inv.status,
    'match_source', v_inv.match_source,
    'payment_request_id', v_inv.payment_request_id,
    'linked_payment_request_id', v_inv.linked_payment_request_id,
    'needs_jev', (
      v_inv.status = 'needs_review'
      and v_inv.match_source = 'amount_ambiguous'
      and v_inv.total_amount is not null
    )
  );
end;
$$;

revoke all on function public.ingest_incoming_invoice(jsonb)
  from public, anon, authenticated;
grant execute on function public.ingest_incoming_invoice(jsonb) to service_role;

-- (b) dọn trùng hiện có
with keyed as (
  select i.id,
         row_number() over (
           partition by i.seller_tax_code, coalesce(i.invoice_series, ''), ltrim(i.invoice_number, '0')
           order by (i.linked_payment_request_id is not null or i.payment_request_id is not null) desc,
                    i.created_at, i.id
         ) as rn,
         first_value(i.created_at) over (
           partition by i.seller_tax_code, coalesce(i.invoice_series, ''), ltrim(i.invoice_number, '0')
           order by (i.linked_payment_request_id is not null or i.payment_request_id is not null) desc,
                    i.created_at, i.id
         ) as kept_at
  from public.incoming_invoices i
  where i.invoice_number is not null
    and i.seller_tax_code is not null
    and i.status <> 'ignored'
)
update public.incoming_invoices i
   set status = 'ignored',
       ingest_note = 'Bản trùng của hoá đơn đã nạp ngày '
         || to_char(k.kept_at at time zone 'Asia/Ho_Chi_Minh', 'DD/MM/YYYY')
  from keyed k
 where k.id = i.id
   and k.rn > 1
   and i.linked_payment_request_id is null
   and i.payment_request_id is null;

-- (c) ghi chú cũ trên dòng đã ghép
create or replace function public.clear_incoming_invoice_po_hint()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if new.status = 'matched'
     and new.note like 'NCC hàng hóa có đơn mua hàng%' then
    new.note := null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_clear_incoming_invoice_po_hint on public.incoming_invoices;
create trigger trg_clear_incoming_invoice_po_hint
  before insert or update of status, note on public.incoming_invoices
  for each row execute function public.clear_incoming_invoice_po_hint();

update public.incoming_invoices
   set note = null
 where status = 'matched'
   and note like 'NCC hàng hóa có đơn mua hàng%';
