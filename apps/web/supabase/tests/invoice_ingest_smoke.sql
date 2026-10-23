-- Rollback-only smoke cho migration 20261102980000_incoming_invoice_ingest.sql.
--
-- Chạy: `supabase db query --linked -f supabase/tests/invoice_ingest_smoke.sql`.
-- File mở một transaction, dán nguyên migration mới, tạo fixture rollback-only,
-- rồi rollback ở cuối. Không sửa / duyệt / chi bất kỳ phiếu thật nào.

begin;

-- ---------------------------------------------------------------------------
-- Inline copy of 20261102980000_incoming_invoice_ingest.sql
-- ---------------------------------------------------------------------------
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
--   (f) lịch pg_cron 30 phút/lần gọi edge function invoice-inbox-ingest.
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

-- ---------------------------------------------------------------------------
-- Smoke assertions
-- ---------------------------------------------------------------------------
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

-- Cột mới + worker secret + cron.
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'incoming_invoices'
      and column_name = 'purchase_order_id'
  ) then
    raise exception 'SMOKE FAIL: missing purchase_order_id column';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'incoming_invoices'
      and column_name = 'linked_payment_request_id'
  ) then
    raise exception 'SMOKE FAIL: missing linked_payment_request_id column';
  end if;
  if not exists (
    select 1 from public.robot_worker_config where id = 'invoice-ingest'
  ) then
    raise exception 'SMOKE FAIL: missing invoice-ingest worker secret';
  end if;
  if not exists (
    select 1 from cron.job
    where jobname = 'invoice-inbox-ingest'
      and schedule = '*/30 * * * *'
  ) then
    raise exception 'SMOKE FAIL: missing invoice-inbox-ingest cron';
  end if;
end $$;

-- (a) GREEN SM: hóa đơn giả gần median tạo đúng một phiếu pending + attachment.
do $$
declare
  v_median numeric;
  v_total numeric;
  v_result jsonb;
  v_again jsonb;
  v_pr public.payment_requests%rowtype;
  v_count integer;
begin
  select t.amount_median
    into v_median
  from public.expense_templates t
  join public.suppliers s on s.id = t.supplier_id
  where s.name = 'GREEN SM'
    and t.active = true
    and t.goods_supplier = false
  order by t.updated_at desc
  limit 1;

  if v_median is null or v_median <= 0 then
    raise exception 'SMOKE FAIL: no active GREEN SM template with median';
  end if;

  v_total := round(v_median);
  v_result := public.ingest_incoming_invoice(jsonb_build_object(
    'source', 'email',
    'source_ref', 'smoke-ingest-green-sm',
    'file_path', 'smoke/green-sm-ingest.pdf',
    'file_mime', 'application/pdf',
    'file_name', 'green-sm-ingest.pdf',
    'seller_name', 'CÔNG TY TNHH GREEN SM',
    'invoice_number', 'SMOKE-INGEST-001',
    'invoice_date', current_date,
    'subtotal', v_total - 1000,
    'vat_amount', 1000,
    'total_amount', v_total,
    'raw', jsonb_build_object(
      'lines', jsonb_build_array(jsonb_build_object('name', 'Chi phí', 'line_total', v_total))
    )
  ));

  if v_result->>'status' <> 'pr_created' then
    raise exception 'SMOKE FAIL: GREEN SM ingest status %, result %', v_result->>'status', v_result;
  end if;
  if (v_result->>'payment_request_id') is null then
    raise exception 'SMOKE FAIL: GREEN SM ingest did not create a payment request: %', v_result;
  end if;

  select *
    into v_pr
  from public.payment_requests
  where id = (v_result->>'payment_request_id')::uuid;

  if v_pr.status <> 'pending'::public.payment_request_status then
    raise exception 'SMOKE FAIL: GREEN SM request not pending: %', v_pr.status;
  end if;
  if v_pr.total_amount <> v_total then
    raise exception 'SMOKE FAIL: GREEN SM total % expected %', v_pr.total_amount, v_total;
  end if;
  if not exists (
    select 1
    from public.payment_request_attachments a
    where a.payment_request_id = v_pr.id
      and a.storage_path = 'smoke/green-sm-ingest.pdf'
  ) then
    raise exception 'SMOKE FAIL: GREEN SM attachment missing';
  end if;

  v_again := public.ingest_incoming_invoice(jsonb_build_object(
    'source', 'email',
    'source_ref', 'smoke-ingest-green-sm',
    'file_path', 'smoke/green-sm-ingest.pdf',
    'file_mime', 'application/pdf',
    'seller_name', 'CÔNG TY TNHH GREEN SM',
    'total_amount', v_total + 999999
  ));

  if coalesce((v_again->>'duplicate')::boolean, false) is not true then
    raise exception 'SMOKE FAIL: duplicate ingest not reported: %', v_again;
  end if;
  if v_again->>'status' <> 'pr_created' then
    raise exception 'SMOKE FAIL: duplicate changed status: %', v_again;
  end if;

  select count(*)::integer
    into v_count
  from public.payment_requests pr
  join public.incoming_invoices i on i.payment_request_id = pr.id
  where i.source_ref = 'smoke-ingest-green-sm';

  if v_count <> 1 then
    raise exception 'SMOKE FAIL: duplicate ingest created % payment requests', v_count;
  end if;

  raise notice 'SMOKE GREEN SM: %', v_result;
end $$;

-- (b) Link NCC có PO thật: gắn file vào phiếu mới nhất, không tạo phiếu mới.
do $$
declare
  v_po uuid;
  v_pr_id uuid;
  v_result jsonb;
  v_before integer;
  v_after integer;
begin
  select pr.purchase_order_id, pr.id
    into v_po, v_pr_id
  from public.payment_requests pr
  where pr.purchase_order_id is not null
    and pr.status <> 'rejected'::public.payment_request_status
  order by pr.created_at desc, pr.id desc
  limit 1;

  if v_po is null or v_pr_id is null then
    raise exception 'SMOKE FAIL: no purchase order with a non-rejected payment request';
  end if;

  select count(*)::integer
    into v_before
  from public.payment_requests
  where purchase_order_id = v_po;

  v_result := public.ingest_incoming_invoice(jsonb_build_object(
    'source', 'supplier_link',
    'source_ref', 'smoke-ingest-po',
    'purchase_order_id', v_po,
    'file_path', 'smoke/po-ingest.pdf',
    'file_mime', 'application/pdf',
    'file_name', 'po-ingest.pdf',
    'seller_name', 'NCC PO smoke',
    'total_amount', 500000
  ));

  if v_result->>'status' <> 'matched' then
    raise exception 'SMOKE FAIL: PO ingest status %', v_result->>'status';
  end if;
  if v_result->>'match_source' <> 'po_link' then
    raise exception 'SMOKE FAIL: PO ingest match_source %', v_result->>'match_source';
  end if;
  if (v_result->>'linked_payment_request_id')::uuid <> v_pr_id then
    raise exception 'SMOKE FAIL: PO ingest linked % expected %',
      v_result->>'linked_payment_request_id', v_pr_id;
  end if;
  if v_result->>'payment_request_id' is not null then
    raise exception 'SMOKE FAIL: PO ingest created a new payment request: %', v_result;
  end if;

  select count(*)::integer
    into v_after
  from public.payment_requests
  where purchase_order_id = v_po;

  if v_after <> v_before then
    raise exception 'SMOKE FAIL: PO ingest changed request count % -> %', v_before, v_after;
  end if;
  if not exists (
    select 1
    from public.payment_request_attachments a
    where a.payment_request_id = v_pr_id
      and a.storage_path = 'smoke/po-ingest.pdf'
  ) then
    raise exception 'SMOKE FAIL: PO attachment missing';
  end if;

  raise notice 'SMOKE PO link: %', v_result;
end $$;

-- (c) NCC hàng hóa (có PO gần đây, không khuôn) không có PO → needs_review.
do $$
declare
  v_supplier_name text;
  v_result jsonb;
begin
  select s.name
    into v_supplier_name
  from public.suppliers s
  where exists (
    select 1
    from public.payment_requests pr
    where pr.supplier_id = s.id
      and pr.purchase_order_id is not null
      and pr.created_at >= now() - interval '120 days'
  )
  and not exists (
    select 1
    from public.expense_templates t
    where t.supplier_id = s.id
      and t.active = true
  )
  order by s.name
  limit 1;

  if v_supplier_name is null then
    raise exception 'SMOKE FAIL: no goods supplier without an active template';
  end if;

  v_result := public.ingest_incoming_invoice(jsonb_build_object(
    'source', 'email',
    'source_ref', 'smoke-ingest-goods',
    'seller_name', v_supplier_name,
    'invoice_number', 'SMOKE-GOODS-001',
    'invoice_date', current_date,
    'total_amount', 777000
  ));

  if v_result->>'status' <> 'needs_review' then
    raise exception 'SMOKE FAIL: goods ingest status %', v_result->>'status';
  end if;
  if v_result->>'match_source' <> 'goods_supplier_po' then
    raise exception 'SMOKE FAIL: goods ingest match_source %', v_result->>'match_source';
  end if;
  if v_result->>'payment_request_id' is not null
     or v_result->>'linked_payment_request_id' is not null then
    raise exception 'SMOKE FAIL: goods ingest linked a payment request: %', v_result;
  end if;

  raise notice 'SMOKE goods supplier: %', v_result;
end $$;

-- (d) Ứng viên Jev + áp khuôn: hóa đơn amount_ambiguous cùng NCC GREEN SM.
do $$
declare
  v_template_id uuid;
  v_supplier_id uuid;
  v_invoice_id uuid;
  v_candidates jsonb;
  v_apply jsonb;
  v_pr public.payment_requests%rowtype;
begin
  select t.id, t.supplier_id
    into v_template_id, v_supplier_id
  from public.expense_templates t
  join public.suppliers s on s.id = t.supplier_id
  where s.name = 'GREEN SM'
    and t.active = true
    and t.goods_supplier = false
  order by t.updated_at desc
  limit 1;

  if v_template_id is null then
    raise exception 'SMOKE FAIL: no GREEN SM template for Jev';
  end if;

  insert into public.incoming_invoices (
    source, source_ref, seller_name, supplier_id, status, match_source,
    total_amount, invoice_date, period, raw
  )
  values (
    'email', 'smoke-ingest-jev', 'CÔNG TY TNHH GREEN SM', v_supplier_id,
    'needs_review', 'amount_ambiguous', 1000000, current_date,
    to_char(current_date, 'YYYY-MM'),
    jsonb_build_object(
      'lines',
      (
        select jsonb_agg(jsonb_build_object('name', 'Dòng ' || g))
        from generate_series(1, 25) as g
      )
    )
  )
  returning id into v_invoice_id;

  v_candidates := public.get_incoming_invoice_jev_candidates(v_invoice_id);
  if jsonb_array_length(coalesce(v_candidates->'templates', '[]'::jsonb)) < 1 then
    raise exception 'SMOKE FAIL: Jev candidates missing templates: %', v_candidates;
  end if;
  if jsonb_array_length(coalesce(v_candidates->'invoice'->'lines', '[]'::jsonb)) <> 20 then
    raise exception 'SMOKE FAIL: Jev candidates lines should be capped at 20: %', v_candidates;
  end if;
  if v_candidates->'invoice'->>'seller_name' <> 'CÔNG TY TNHH GREEN SM' then
    raise exception 'SMOKE FAIL: Jev candidates missing seller: %', v_candidates;
  end if;

  v_apply := public.apply_incoming_invoice_template(
    v_invoice_id, v_template_id, 0.90, 'SMOKE JEV'
  );

  if v_apply->>'status' <> 'pr_created' then
    raise exception 'SMOKE FAIL: Jev apply status %', v_apply;
  end if;

  select *
    into v_pr
  from public.payment_requests
  where id = (v_apply->>'payment_request_id')::uuid;

  if v_pr.status <> 'pending'::public.payment_request_status then
    raise exception 'SMOKE FAIL: Jev apply request not pending: %', v_pr.status;
  end if;
  if (select i.ingest_note from public.incoming_invoices i where i.id = v_invoice_id)
     <> 'SMOKE JEV' then
    raise exception 'SMOKE FAIL: Jev apply did not keep ingest_note';
  end if;

  -- Hóa đơn không có số tiền (PDF chưa đọc được) không được Jev đoán tiền.
  declare
    v_pdf_invoice_id uuid;
    v_rejected boolean := false;
  begin
    insert into public.incoming_invoices (
      source, source_ref, seller_name, supplier_id, status, match_source,
      total_amount, invoice_date, period, raw
    )
    values (
      'email', 'smoke-ingest-pdf-no-total', 'CÔNG TY TNHH GREEN SM', v_supplier_id,
      'needs_review', 'amount_ambiguous', null, current_date,
      to_char(current_date, 'YYYY-MM'), jsonb_build_object('lines', '[]'::jsonb)
    )
    returning id into v_pdf_invoice_id;

    begin
      perform public.apply_incoming_invoice_template(
        v_pdf_invoice_id, v_template_id, 0.90, 'SMOKE PDF'
      );
    exception
      when sqlstate 'P0001' then
        if sqlerrm <> 'invoice_amount_missing' then
          raise;
        end if;
        v_rejected := true;
    end;

    if not v_rejected then
      raise exception 'SMOKE FAIL: Jev apply accepted an invoice without total_amount';
    end if;
  end;

  raise notice 'SMOKE Jev apply: %', v_apply;
end $$;

-- (e) anon / authenticated không có quyền execute các RPC mới.
do $$
declare
  v_signature text;
begin
  foreach v_signature in array array[
    'public.ingest_incoming_invoice(jsonb)',
    'public.get_incoming_invoice_jev_candidates(uuid)',
    'public.apply_incoming_invoice_template(uuid, uuid, numeric, text)'
  ]
  loop
    if has_function_privilege('anon', v_signature, 'EXECUTE') then
      raise exception 'SMOKE FAIL: anon can execute %', v_signature;
    end if;
    if has_function_privilege('authenticated', v_signature, 'EXECUTE') then
      raise exception 'SMOKE FAIL: authenticated can execute %', v_signature;
    end if;
    if not has_function_privilege('service_role', v_signature, 'EXECUTE') then
      raise exception 'SMOKE FAIL: service_role cannot execute %', v_signature;
    end if;
  end loop;
end $$;

select jsonb_build_object(
  'status', 'SMOKE_RESULT PASS',
  'green_sm_invoice_status', (
    select i.status from public.incoming_invoices i where i.source_ref = 'smoke-ingest-green-sm'
  ),
  'green_sm_payment_request_status', (
    select pr.status
    from public.payment_requests pr
    join public.incoming_invoices i on i.payment_request_id = pr.id
    where i.source_ref = 'smoke-ingest-green-sm'
  ),
  'po_invoice_status', (
    select i.status from public.incoming_invoices i where i.source_ref = 'smoke-ingest-po'
  ),
  'po_linked_payment_request_id', (
    select i.linked_payment_request_id from public.incoming_invoices i where i.source_ref = 'smoke-ingest-po'
  ),
  'goods_invoice_status', (
    select i.status from public.incoming_invoices i where i.source_ref = 'smoke-ingest-goods'
  ),
  'worker_secret_registered', exists (
    select 1 from public.robot_worker_config where id = 'invoice-ingest'
  ),
  'cron_schedule', (
    select schedule from cron.job where jobname = 'invoice-inbox-ingest'
  )
) as result;

rollback;
