-- Đọc lại các hoá đơn PDF đã nạp nhưng chưa đọc được tự động.
--
-- Additive only. Migration này thêm:
--   (a) public.reextract_incoming_invoice(uuid, jsonb) — ghi đè số liệu đã
--       đọc lại từ PDF, rồi chạy đúng nhánh matching của
--       public.ingest_incoming_invoice: match_incoming_invoice, tạo phiếu chi
--       khi khớp (trừ goods_supplier_po) hoặc ghép phiếu chi đã có;
--   (b) public.set_incoming_invoice_note(uuid, text) — đánh dấu các dòng
--       "không phải hoá đơn" / "số tiền không khớp" trong lượt đọc lại.
--
-- Cả hai chỉ dành cho service_role, không duyệt, không chi và không sửa số
-- tiền của bất kỳ phiếu chi nào. Chưa apply.

-- ===========================================================================
-- 1. Ghi đè số liệu PDF rồi matching như ingest
-- ===========================================================================

create or replace function public.reextract_incoming_invoice(p_id uuid, p jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inv public.incoming_invoices%rowtype;
  v_invoice_date date;
  v_period text;
  v_match jsonb;
  v_error text;
begin
  if coalesce(public.material_master_jwt_role(), '') <> 'service_role' then
    raise exception 'not_authorized_invoice_reextract' using errcode = '42501';
  end if;

  if p is null or jsonb_typeof(p) <> 'object' then
    raise exception 'invalid_invoice_payload' using errcode = 'P0001';
  end if;

  select *
    into v_inv
  from public.incoming_invoices
  where id = p_id
  for update;

  if not found then
    raise exception 'incoming_invoice_not_found' using errcode = 'P0002';
  end if;

  -- Chỉ dòng chưa có số tiền và chưa gắn phiếu chi nào mới được đọc lại.
  if v_inv.total_amount is not null
     or v_inv.linked_payment_request_id is not null
     or v_inv.payment_request_id is not null then
    return jsonb_build_object(
      'id', v_inv.id,
      'status', v_inv.status,
      'match_source', v_inv.match_source,
      'linked_payment_request_id', v_inv.linked_payment_request_id,
      'payment_request_id', v_inv.payment_request_id
    );
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

  update public.incoming_invoices
     set seller_name = nullif(btrim(coalesce(p->>'seller_name', '')), ''),
         seller_tax_code = nullif(btrim(coalesce(p->>'seller_tax_code', '')), ''),
         invoice_number = nullif(btrim(coalesce(p->>'invoice_number', '')), ''),
         invoice_series = nullif(btrim(coalesce(p->>'invoice_series', '')), ''),
         invoice_date = v_invoice_date,
         period = v_period,
         subtotal = nullif(btrim(coalesce(p->>'subtotal', '')), '')::numeric,
         vat_amount = nullif(btrim(coalesce(p->>'vat_amount', '')), '')::numeric,
         total_amount = nullif(btrim(coalesce(p->>'total_amount', '')), '')::numeric,
         raw = coalesce(p->'raw', '{}'::jsonb),
         note = null
   where id = p_id;

  -- Đúng nhánh matching của public.ingest_incoming_invoice.
  v_match := public.match_incoming_invoice(p_id);
  select *
    into v_inv
  from public.incoming_invoices
  where id = p_id;

  if v_inv.total_amount is null then
    update public.incoming_invoices
       set status = 'needs_review'
     where id = p_id;
  elsif v_match->>'status' = 'matched'
     and coalesce(v_match->>'match_source', '') <> 'goods_supplier_po' then
    begin
      perform public.create_payment_request_from_invoice(p_id);
    exception
      when others then
        v_error := sqlerrm;
        update public.incoming_invoices
           set ingest_note = v_error,
               status = 'needs_review'
         where id = p_id;
    end;
  elsif coalesce(v_match->>'match_source', '') = 'goods_supplier_po' then
    begin
      perform public.link_incoming_invoice_to_payment_request(p_id);
    exception
      when others then
        v_error := sqlerrm;
        update public.incoming_invoices
           set ingest_note = v_error,
               status = 'needs_review'
         where id = p_id;
    end;
  end if;

  select *
    into v_inv
  from public.incoming_invoices
  where id = p_id;

  return jsonb_build_object(
    'id', v_inv.id,
    'status', v_inv.status,
    'match_source', v_inv.match_source,
    'linked_payment_request_id', v_inv.linked_payment_request_id,
    'payment_request_id', v_inv.payment_request_id
  );
end;
$$;

revoke all on function public.reextract_incoming_invoice(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.reextract_incoming_invoice(uuid, jsonb)
  to service_role;

-- ===========================================================================
-- 2. Đánh dấu dòng không phải hoá đơn / số tiền không khớp
-- ===========================================================================

create or replace function public.set_incoming_invoice_note(p_id uuid, p_note text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(public.material_master_jwt_role(), '') <> 'service_role' then
    raise exception 'not_authorized_invoice_note' using errcode = '42501';
  end if;

  update public.incoming_invoices
     set note = p_note
   where id = p_id;

  if not found then
    raise exception 'incoming_invoice_not_found' using errcode = 'P0002';
  end if;

  return jsonb_build_object('id', p_id, 'note', p_note);
end;
$$;

revoke all on function public.set_incoming_invoice_note(uuid, text)
  from public, anon, authenticated;
grant execute on function public.set_incoming_invoice_note(uuid, text)
  to service_role;
