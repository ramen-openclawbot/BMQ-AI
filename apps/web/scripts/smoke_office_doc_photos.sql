-- Rollback-only production smoke for migration
-- 20261101370000_office_doc_photo_counts.sql.
--
-- Run as one file (the Maestro applies the migration first, as the DB owner):
--   supabase db query --linked -f apps/web/scripts/smoke_office_doc_photos.sql
-- (from apps/web: supabase db query --linked -f scripts/smoke_office_doc_photos.sql).
--
-- The file opens one transaction, impersonates a real owner through
-- request.jwt.claims and seeds one supplier with:
--   * one PO carrying a header photo, plus one confirmed goods receipt linked
--     to that PO with its own photo and two product_photos;
--   * one standalone pending unpaid PR carrying a header photo and one
--     attachment (no goods receipt linked to it).
-- It then calls get_supplier_debt_candidates and asserts, per row:
--   * the PR row has_image = true, image_path = its image_url and
--     photo_count = 1 (header) + 1 (attachment) + 0 (no linked GR) = 2;
--   * the PO row has_image = true, image_path = its image_url and
--     photo_count = 1 (header) + 1 (GR image) + 2 (GR product photos) = 4.
-- The final ROLLBACK removes every row this smoke wrote.

begin;

do $smoke$
declare
  v_owner uuid;
  v_supplier uuid;
  v_po uuid;
  v_gr uuid;
  v_pr uuid;
  v_suffix text := to_char(clock_timestamp(), 'YYYYMMDDHH24MISSMS');
  v_po_image text := 'smoke-office/po-' || v_suffix || '.jpg';
  v_gr_image text := 'smoke-office/gr-' || v_suffix || '.jpg';
  v_pr_image text := 'smoke-office/pr-' || v_suffix || '.jpg';
  v_res jsonb;
  v_pr_rows integer;
  v_po_rows integer;
  v_pr_row jsonb;
  v_po_row jsonb;
begin
  select ur.user_id into v_owner
  from public.user_roles ur
  where ur.role::text = 'owner'
  order by ur.created_at, ur.user_id
  limit 1;
  if v_owner is null then
    raise exception 'SMOKE FAIL no_owner';
  end if;

  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text,
    true
  );

  insert into public.suppliers (name)
  values ('SMOKE office photos ' || v_suffix)
  returning id into v_supplier;

  -- PO with a header photo and one confirmed goods receipt (photo + 2 extras).
  insert into public.purchase_orders (
    po_number, supplier_id, status, order_date, expected_date, total_amount,
    vat_amount, notes, created_by, image_url
  ) values (
    'SMOKE-OFFICE-PO-' || v_suffix, v_supplier, 'sent',
    current_date - 10, current_date - 10, 1000000, 0,
    'smoke office photos po', v_owner, v_po_image
  ) returning id into v_po;

  insert into public.goods_receipts (
    receipt_number, receipt_date, purchase_order_id, supplier_id, status,
    image_url, product_photos, payable_status
  ) values (
    'SMOKE-OFFICE-GR-' || v_suffix, current_date - 9, v_po, v_supplier,
    'confirmed', v_gr_image,
    array['smoke-office/g1-' || v_suffix || '.jpg', 'smoke-office/g2-' || v_suffix || '.jpg'],
    'not_generated'
  ) returning id into v_gr;

  -- Standalone pending PR: header photo + one attachment, no linked GR.
  insert into public.payment_requests (
    request_number, supplier_id, title, description, total_amount, vat_amount,
    status, payment_status, payment_type, payment_method, image_url, created_by
  ) values (
    'SMOKE-OFFICE-PR-' || v_suffix, v_supplier,
    'Đề nghị chi - smoke office photos', 'smoke office photos pr',
    500000, 0, 'pending', 'unpaid', 'new_order', 'bank_transfer',
    v_pr_image, v_owner
  ) returning id into v_pr;

  insert into public.payment_request_attachments (
    payment_request_id, storage_path, file_name, mime_type
  ) values (
    v_pr, 'smoke-office/att-' || v_suffix || '.pdf',
    'smoke-attachment.pdf', 'application/pdf'
  );

  v_res := public.get_supplier_debt_candidates(v_supplier);

  select count(*) into v_pr_rows
  from jsonb_array_elements(v_res -> 'rows') elem
  where elem ->> 'kind' = 'pr';
  select count(*) into v_po_rows
  from jsonb_array_elements(v_res -> 'rows') elem
  where elem ->> 'kind' = 'po';
  if v_pr_rows <> 1 or v_po_rows <> 1 then
    raise exception 'SMOKE FAIL row_counts pr=% po=%', v_pr_rows, v_po_rows;
  end if;

  select elem into v_pr_row
  from jsonb_array_elements(v_res -> 'rows') elem
  where elem ->> 'kind' = 'pr';
  select elem into v_po_row
  from jsonb_array_elements(v_res -> 'rows') elem
  where elem ->> 'kind' = 'po';

  ----------------------------------------------------------------
  -- PR row: header + 1 attachment = 2 photos
  ----------------------------------------------------------------
  if (v_pr_row ->> 'has_image')::boolean is not true then
    raise exception 'SMOKE FAIL pr_has_image %', v_pr_row ->> 'has_image';
  end if;
  if v_pr_row ->> 'image_path' is distinct from v_pr_image then
    raise exception 'SMOKE FAIL pr_image_path %', v_pr_row ->> 'image_path';
  end if;
  if (v_pr_row ->> 'photo_count')::int <> 2 then
    raise exception 'SMOKE FAIL pr_photo_count %', v_pr_row ->> 'photo_count';
  end if;

  ----------------------------------------------------------------
  -- PO row: header + GR image + 2 GR product photos = 4 photos
  ----------------------------------------------------------------
  if (v_po_row ->> 'has_image')::boolean is not true then
    raise exception 'SMOKE FAIL po_has_image %', v_po_row ->> 'has_image';
  end if;
  if v_po_row ->> 'image_path' is distinct from v_po_image then
    raise exception 'SMOKE FAIL po_image_path %', v_po_row ->> 'image_path';
  end if;
  if (v_po_row ->> 'photo_count')::int <> 4 then
    raise exception 'SMOKE FAIL po_photo_count %', v_po_row ->> 'photo_count';
  end if;

  raise notice 'SMOKE PASS';
end;
$smoke$;

rollback;
