-- Đặt hàng tự động: every debt row now carries its document photos so the room
-- can rank / show them without opening each PR or PO (owner 16/10 IMG_5762).
--
-- Same function name, signature, SECURITY DEFINER, search_path and grants as
-- 20261101170000_robot_order_desk.sql. The whole body is kept byte-for-byte;
-- the only change is three extra keys per row:
--   * has_image   — the PR / PO header photo is present;
--   * image_path  — payment_requests.image_url / purchase_orders.image_url;
--   * photo_count — header photo + PR attachments + the linked goods receipt
--     (image_url + product_photos), using the same linked-GR rule as
--     get_payment_doc_detail in 20261101360000_payment_doc_detail_photos.sql
--     (PR: pr.goods_receipt_id, else the GR bound to the PR; PO: the newest GR
--     of that PO, by receipt_date then created_at).

create or replace function public.get_supplier_debt_candidates(p_supplier_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_result jsonb;
begin
  if coalesce(public.material_master_jwt_role(), '') <> 'service_role' then
    if v_actor is null then
      raise exception 'not_authenticated' using errcode = '42501';
    end if;
  end if;

  if p_supplier_id is null then
    raise exception 'supplier_id_required' using errcode = '22023';
  end if;

  with cutover as (
    select
      c.start_date,
      case when c.payment_request_id is not null then 'pr' else 'po' end as kind,
      coalesce(c.payment_request_id, c.purchase_order_id) as doc_id,
      case
        when c.payment_request_id is not null then pr.created_at
        else po.created_at
      end as doc_created,
      case
        when c.payment_request_id is not null then pr.request_number
        else po.po_number
      end as number
    from public.supplier_debt_cutovers c
    left join public.payment_requests pr on pr.id = c.payment_request_id
    left join public.purchase_orders po on po.id = c.purchase_order_id
    where c.supplier_id = p_supplier_id
  ),
  pr_rows as (
    select
      'pr'::text as kind,
      pr.id,
      pr.request_number as number,
      pr.title,
      pr.created_at::date as doc_date,
      pr.created_at,
      coalesce(pr.total_amount, 0) as amount,
      coalesce(pr.total_amount, 0) - coalesce((
        select sum(pa.amount)
        from public.payment_allocations pa
        where pa.payment_request_id = pr.id
      ), 0) as remaining,
      pr.purchase_order_id,
      po.po_number,
      pr.goods_receipt_id,
      (
        select ps.submission_number
        from public.payment_submission_items psi
        join public.payment_submissions ps on ps.id = psi.submission_id
        where psi.payment_request_id = pr.id
        order by ps.created_at desc
        limit 1
      ) as last_submission_number,
      (
        pr.purchase_order_id is not null
        and exists (
          select 1
          from public.goods_receipts gr
          where gr.purchase_order_id = pr.purchase_order_id
            and gr.status in ('confirmed', 'received')
        )
      ) as has_receipt,
      m.mark,
      m.source as mark_source,
      m.probability,
      pr.image_url is not null as has_image,
      pr.image_url as image_path,
      (pr.image_url is not null)::int
        + (
          select count(*)
          from public.payment_request_attachments att
          where att.payment_request_id = pr.id
        )
        + coalesce((
          select (gr.image_url is not null)::int + coalesce(array_length(gr.product_photos, 1), 0)
          from public.goods_receipts gr
          where (
              pr.goods_receipt_id is not null
              and gr.id = pr.goods_receipt_id
            )
            or (
              pr.goods_receipt_id is null
              and gr.payment_request_id = pr.id
            )
          order by gr.receipt_date desc nulls last, gr.created_at desc
          limit 1
        ), 0) as photo_count
    from public.payment_requests pr
    left join public.purchase_orders po on po.id = pr.purchase_order_id
    left join public.supplier_debt_marks m on m.payment_request_id = pr.id
    where pr.supplier_id = p_supplier_id
      and pr.status in ('pending', 'approved')
      and pr.payment_status in ('unpaid', 'partial')
  ),
  po_rows as (
    select
      'po'::text as kind,
      po.id,
      po.po_number as number,
      null::text as title,
      coalesce(po.expected_date, po.order_date) as doc_date,
      po.created_at,
      coalesce(po.total_amount, 0) as amount,
      coalesce(po.total_amount, 0) as remaining,
      po.id as purchase_order_id,
      po.po_number,
      null::uuid as goods_receipt_id,
      null::text as last_submission_number,
      exists (
        select 1
        from public.goods_receipts gr
        where gr.purchase_order_id = po.id
          and gr.status in ('confirmed', 'received')
      ) as has_receipt,
      m.mark,
      m.source as mark_source,
      m.probability,
      po.image_url is not null as has_image,
      po.image_url as image_path,
      (po.image_url is not null)::int
        + coalesce((
          select (gr.image_url is not null)::int + coalesce(array_length(gr.product_photos, 1), 0)
          from public.goods_receipts gr
          where gr.purchase_order_id = po.id
          order by gr.receipt_date desc nulls last, gr.created_at desc
          limit 1
        ), 0) as photo_count
    from public.purchase_orders po
    left join public.supplier_debt_marks m on m.purchase_order_id = po.id
    where po.supplier_id = p_supplier_id
      and po.status <> 'cancelled'
      and not exists (
        select 1
        from public.payment_requests pr2
        where pr2.purchase_order_id = po.id
          and pr2.status <> 'rejected'
      )
  ),
  all_rows as (
    select * from pr_rows
    union all
    select * from po_rows
  )
  select jsonb_build_object(
    'supplier_id', p_supplier_id,
    'cutover', (
      select jsonb_build_object(
        'kind', c.kind,
        'id', c.doc_id,
        'number', c.number,
        'start_date', c.start_date
      )
      from cutover c
      limit 1
    ),
    'stats', jsonb_build_object(
      'paid_90d', (
        select count(*)
        from public.payment_requests pr
        where pr.supplier_id = p_supplier_id
          and pr.payment_status = 'paid'
          and pr.created_at >= now() - interval '90 days'
      ),
      'median_lag_days', (
        select percentile_cont(0.5) within group (
          order by (pr.created_at::date - po.order_date)
        )
        from public.payment_requests pr
        join public.purchase_orders po on po.id = pr.purchase_order_id
        where pr.supplier_id = p_supplier_id
          and pr.payment_status = 'paid'
          and pr.created_at >= now() - interval '90 days'
      ),
      'last_paid_date', (
        select max(pr.created_at::date)
        from public.payment_requests pr
        where pr.supplier_id = p_supplier_id
          and pr.payment_status = 'paid'
      )
    ),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object(
        'kind', r.kind,
        'id', r.id,
        'number', r.number,
        'title', r.title,
        'doc_date', r.doc_date,
        'amount', r.amount,
        'remaining', r.remaining,
        'purchase_order_id', r.purchase_order_id,
        'po_number', r.po_number,
        'goods_receipt_id', r.goods_receipt_id,
        'last_submission_number', r.last_submission_number,
        'age_days', current_date - r.doc_date,
        'has_receipt', r.has_receipt,
        'mark', r.mark,
        'mark_source', r.mark_source,
        'probability', r.probability,
        'before_cutover', (
          c.start_date is not null
          and (
            r.doc_date < c.start_date
            or (r.doc_date = c.start_date and r.created_at < c.doc_created)
          )
        ),
        'has_image', r.has_image,
        'image_path', r.image_path,
        'photo_count', r.photo_count
      ) order by r.doc_date asc, r.created_at asc)
      from all_rows r
      left join cutover c on true
    ), '[]'::jsonb)
  )
  into v_result;

  return v_result;
end;
$$;

revoke all on function public.get_supplier_debt_candidates(uuid) from public, anon;
grant execute on function public.get_supplier_debt_candidates(uuid) to authenticated, service_role;
