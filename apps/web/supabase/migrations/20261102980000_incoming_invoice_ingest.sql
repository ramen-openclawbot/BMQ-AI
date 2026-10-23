-- Bộ học duyệt chi — bước 2: nạp hóa đơn từ hoadon@bmq.vn và link NCC.
--
-- Additive only. Migration này:
--   (a) thêm liên kết PO / phiếu chi đã có, tên file và ghi chú nạp vào
--       public.incoming_invoices;
--   (b) thêm index theo nguồn + thời gian cho hàng đợi nạp;
--   (c) đăng ký worker secret 'invoice-ingest' dùng cho pg_cron;
--   (d) thêm public.ingest_incoming_invoice(jsonb) — chỉ service_role;
--   (e) thêm public.get_incoming_invoice_jev_candidates(uuid) và
--       public.apply_incoming_invoice_template(uuid, uuid, numeric, text) —
--       chỉ service_role;
--   (f) lịch pg_cron 30 phút/lần gọi edge function invoice-inbox-ingest, chỉ
--       đọc hoadon@. File NCC tải lên qua link đã được supplier-order-upload
--       gắn làm chứng từ của PO/phiếu chi (20261102970000_supplier_order_loop),
--       nên cron không nạp lại chúng để tránh gắn trùng.
--
-- Không sửa, duyệt, chi hay xóa phiếu đã có. Phiếu tự lập vẫn Chờ duyệt.
-- Không áp dụng migration này lên DB thật trong quá trình phát triển; smoke
-- supabase/tests/invoice_ingest_smoke.sql chạy toàn bộ trong transaction và
-- rollback.

-- ===========================================================================
-- 1. Cột liên kết + index nguồn
-- ===========================================================================

alter table public.incoming_invoices
  add column if not exists purchase_order_id uuid
    references public.purchase_orders(id),
  add column if not exists linked_payment_request_id uuid
    references public.payment_requests(id),
  add column if not exists file_name text,
  add column if not exists ingest_note text;

create index if not exists idx_incoming_invoices_source_created
  on public.incoming_invoices (source, created_at desc);

-- ===========================================================================
-- 2. Worker secret cho cron
-- ===========================================================================

insert into public.robot_worker_config (id)
values ('invoice-ingest')
on conflict (id) do nothing;

-- ===========================================================================
-- 3. Nạp một hóa đơn đầu vào
-- ===========================================================================

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

-- ===========================================================================
-- 4. Ứng viên khuôn cho Jev
-- ===========================================================================

create or replace function public.get_incoming_invoice_jev_candidates(p_invoice_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_inv public.incoming_invoices%rowtype;
  v_lines jsonb;
  v_templates jsonb;
begin
  if coalesce(public.material_master_jwt_role(), '') <> 'service_role' then
    raise exception 'not_authorized_invoice_jev' using errcode = '42501';
  end if;

  select *
    into v_inv
  from public.incoming_invoices
  where id = p_invoice_id;

  if not found then
    raise exception 'incoming_invoice_not_found' using errcode = 'P0002';
  end if;

  select coalesce(jsonb_agg(line order by ordinality), '[]'::jsonb)
    into v_lines
  from (
    select value as line, ordinality
    from jsonb_array_elements(
      case
        when jsonb_typeof(coalesce(v_inv.raw->'lines', '[]'::jsonb)) = 'array'
          then coalesce(v_inv.raw->'lines', '[]'::jsonb)
        else '[]'::jsonb
      end
    ) with ordinality
    limit 20
  ) lines;

  select coalesce(jsonb_agg(template order by t.updated_at desc), '[]'::jsonb)
    into v_templates
  from (
    select jsonb_build_object(
      'id', t.id,
      'label', t.label,
      'cadence', t.cadence,
      'amount_median', t.amount_median,
      'amount_min', t.amount_min,
      'amount_max', t.amount_max,
      'last_period', t.last_period,
      'title_pattern', t.title_pattern
    ) as template,
    t.updated_at
    from public.expense_templates t
    where t.supplier_id = v_inv.supplier_id
      and t.active = true
      and t.goods_supplier = false
  ) t;

  return jsonb_build_object(
    'invoice', jsonb_build_object(
      'id', v_inv.id,
      'seller_name', v_inv.seller_name,
      'invoice_number', v_inv.invoice_number,
      'invoice_date', v_inv.invoice_date,
      'total_amount', v_inv.total_amount,
      'lines', v_lines
    ),
    'templates', v_templates
  );
end;
$$;

revoke all on function public.get_incoming_invoice_jev_candidates(uuid)
  from public, anon, authenticated;
grant execute on function public.get_incoming_invoice_jev_candidates(uuid) to service_role;

-- ===========================================================================
-- 5. Áp khuôn do Jev chọn
-- ===========================================================================

create or replace function public.apply_incoming_invoice_template(
  p_invoice_id uuid,
  p_template_id uuid,
  p_confidence numeric,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_inv public.incoming_invoices%rowtype;
  v_template public.expense_templates%rowtype;
  v_create jsonb;
  v_error text;
begin
  if coalesce(public.material_master_jwt_role(), '') <> 'service_role' then
    raise exception 'not_authorized_invoice_jev' using errcode = '42501';
  end if;

  select *
    into v_inv
  from public.incoming_invoices
  where id = p_invoice_id
  for update;

  if not found then
    raise exception 'incoming_invoice_not_found' using errcode = 'P0002';
  end if;

  if v_inv.status <> 'needs_review'
     or v_inv.match_source is distinct from 'amount_ambiguous' then
    raise exception 'invoice_not_ambiguous' using errcode = 'P0001';
  end if;

  -- PDF/ảnh chưa đọc được số tiền: không bao giờ để Jev đoán ra một khoản chi.
  if v_inv.total_amount is null then
    raise exception 'invoice_amount_missing' using errcode = 'P0001';
  end if;

  select *
    into v_template
  from public.expense_templates
  where id = p_template_id;

  if not found
     or v_template.active = false
     or v_template.goods_supplier = true
     or v_template.supplier_id is distinct from v_inv.supplier_id then
    raise exception 'template_not_candidate' using errcode = 'P0001';
  end if;

  update public.incoming_invoices
     set template_id = v_template.id,
         match_source = 'jev',
         match_confidence = p_confidence,
         status = 'matched',
         ingest_note = nullif(btrim(coalesce(p_reason, '')), '')
   where id = v_inv.id;

  begin
    v_create := public.create_payment_request_from_invoice(v_inv.id);
  exception
    when others then
      v_error := sqlerrm;
      update public.incoming_invoices
         set ingest_note = v_error,
             status = 'needs_review'
       where id = v_inv.id;
  end;

  select *
    into v_inv
  from public.incoming_invoices
  where id = v_inv.id;

  return jsonb_build_object(
    'id', v_inv.id,
    'status', v_inv.status,
    'match_source', v_inv.match_source,
    'payment_request_id', v_inv.payment_request_id,
    'linked_payment_request_id', v_inv.linked_payment_request_id,
    'needs_jev', false
  );
end;
$$;

revoke all on function public.apply_incoming_invoice_template(uuid, uuid, numeric, text)
  from public, anon, authenticated;
grant execute on function public.apply_incoming_invoice_template(uuid, uuid, numeric, text)
  to service_role;

-- ===========================================================================
-- 6. pg_cron 30 phút/lần: edge function tự đọc Gmail + link NCC
-- ===========================================================================

do $schedule$
declare
  existing_job_id bigint;
begin
  for existing_job_id in
    select jobid from cron.job where jobname = 'invoice-inbox-ingest'
  loop
    perform cron.unschedule(existing_job_id);
  end loop;

  perform cron.schedule(
    'invoice-inbox-ingest',
    '*/30 * * * *',
    $job$
      do $run$
      begin
        perform net.http_post(
          url := 'https://cxntbdvfsikwmitapony.supabase.co/functions/v1/invoice-inbox-ingest',
          headers := jsonb_build_object(
            'content-type', 'application/json',
            'x-worker-secret', (
              select worker_secret::text
              from public.robot_worker_config
              where id = 'invoice-ingest'
            )
          ),
          body := jsonb_build_object(
            'source', 'email'
          ),
          timeout_milliseconds := 120000
        );
      end;
      $run$;
    $job$
  );
end;
$schedule$;
