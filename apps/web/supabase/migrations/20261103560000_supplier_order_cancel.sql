-- Huỷ đơn đặt hàng đã gửi cho nhà cung cấp.
--
-- Additive only. Migration này:
--   (a) thêm trạng thái 'cancelled' + lý do / người huỷ / mốc email huỷ vào
--       supplier_order_requests;
--   (b) cho supplier_zalo_notifications mang nhiều loại tin (order/cancel/
--       payment) và đổi unique order_request_id thành unique (request, kind);
--   (c) hàm dựng tin Zalo huỷ đơn;
--   (d) public.cancel_supplier_order(...) — quyền owner / supplier_orders edit,
--       chạy guard huỷ PO cũ (đã nhập kho / đã trả tiền thì từ chối), ghi lý do
--       và xếp đúng 1 tin Zalo huỷ;
--   (e) public.mark_supplier_order_cancel_email(...) — chỉ service_role;
--   (f) supplier_order_history_by_supplier trả thêm mốc/lý do huỷ và vẫn trả
--       đơn 'cancelled';
--   (g) quyền execute.
--
-- Không gửi email/Zalo thật trong migration này.

-- ---------------------------------------------------------------------------
-- 1. Trạng thái huỷ + metadata trên request
-- ---------------------------------------------------------------------------

alter table public.supplier_order_requests
  drop constraint if exists supplier_order_requests_status_check;
alter table public.supplier_order_requests
  add constraint supplier_order_requests_status_check
  check (status in ('preparing', 'sent', 'failed', 'cancelled'));

alter table public.supplier_order_requests
  add column if not exists cancelled_at timestamptz,
  add column if not exists cancelled_by uuid,
  add column if not exists cancel_reason text,
  add column if not exists cancel_email_sent_at timestamptz,
  add column if not exists cancel_gmail_message_id text;

-- ---------------------------------------------------------------------------
-- 2. supplier_zalo_notifications: loại tin + unique theo (request, kind)
-- ---------------------------------------------------------------------------

alter table public.supplier_zalo_notifications
  add column if not exists kind text not null default 'order';

alter table public.supplier_zalo_notifications
  drop constraint if exists supplier_zalo_notifications_kind_check;
alter table public.supplier_zalo_notifications
  add constraint supplier_zalo_notifications_kind_check
  check (kind in ('order', 'cancel', 'payment'));

-- The original order_request_id unique constraint was created inline, so its
-- name depends on the database. Find it by its columns and drop it before
-- replacing it with the partial (order_request_id, kind) unique index.
do $$
declare
  v_constraint text;
begin
  select c.conname
    into v_constraint
  from pg_constraint c
  join pg_class t on t.oid = c.conrelid
  join pg_namespace n on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relname = 'supplier_zalo_notifications'
    and c.contype = 'u'
    and (
      select array_agg(a.attname::text order by a.attnum)
      from unnest(c.conkey) as k(attnum)
      join pg_attribute a
        on a.attrelid = c.conrelid
       and a.attnum = k.attnum
    ) = array['order_request_id']::text[]
  limit 1;

  if v_constraint is not null then
    execute format(
      'alter table public.supplier_zalo_notifications drop constraint %I',
      v_constraint
    );
  end if;
end;
$$;

create unique index if not exists supplier_zalo_notifications_order_request_kind_key
  on public.supplier_zalo_notifications(order_request_id, kind)
  where order_request_id is not null;

-- ---------------------------------------------------------------------------
-- 3. Tin Zalo huỷ đơn
-- ---------------------------------------------------------------------------

create or replace function public.supplier_order_cancel_zalo_message(
  p_order_request_id uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.supplier_order_requests%rowtype;
  v_supplier_name text;
  v_po_number text;
  v_message text;
begin
  select *
    into v_request
  from public.supplier_order_requests
  where id = p_order_request_id;

  if not found then
    return '';
  end if;

  select name
    into v_supplier_name
  from public.suppliers
  where id = v_request.supplier_id;

  if v_request.purchase_order_id is not null then
    select po_number
      into v_po_number
    from public.purchase_orders
    where id = v_request.purchase_order_id;
  end if;

  v_message := '❌ BMQ huỷ đơn đặt hàng — '
    || coalesce(nullif(btrim(v_supplier_name), ''), 'Nhà cung cấp');
  v_message := v_message || E'\nPO: '
    || coalesce(nullif(btrim(v_po_number), ''), '—')
    || ' (đặt ngày '
    || to_char(
         coalesce(v_request.sent_at, v_request.created_at, now())
           at time zone 'Asia/Ho_Chi_Minh',
         'DD/MM/YYYY'
       )
    || ')';

  -- Blank line before the reason / instruction block.
  v_message := v_message || E'\n\n';

  if nullif(btrim(coalesce(v_request.cancel_reason, '')), '') is not null then
    v_message := v_message || 'Lý do: '
      || btrim(v_request.cancel_reason) || E'\n';
  end if;

  v_message := v_message || 'Quý nhà cung cấp vui lòng KHÔNG giao đơn này.';
  v_message := v_message || E'\nBMQ xin cảm ơn!';

  return coalesce(v_message, '');
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Enqueue tin đơn: giữ nguyên logic, chỉ ghi kind 'order' + conflict mới
-- ---------------------------------------------------------------------------

create or replace function public.enqueue_supplier_zalo_notification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_group public.supplier_zalo_groups%rowtype;
begin
  if TG_OP = 'UPDATE' then
    if OLD.status is not distinct from 'sent' then
      return NEW;
    end if;
  end if;

  select *
    into v_group
  from public.supplier_zalo_groups
  where supplier_id = NEW.supplier_id
    and enabled
  limit 1;

  if not found then
    return NEW;
  end if;

  begin
    insert into public.supplier_zalo_notifications (
      order_request_id,
      supplier_id,
      zalo_group_id,
      message,
      kind
    ) values (
      NEW.id,
      NEW.supplier_id,
      v_group.zalo_group_id,
      public.supplier_order_zalo_message(NEW.id),
      'order'
    )
    on conflict (order_request_id, kind) where order_request_id is not null
    do nothing;
  exception when others then
    raise warning
      'supplier_zalo_notification_enqueue_failed request=% supplier=% error=%',
      NEW.id, NEW.supplier_id, sqlerrm;
  end;

  return NEW;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Tin Zalo thanh toán: giữ nguyên thân hàm mới nhất, chỉ thêm kind
-- ---------------------------------------------------------------------------

create or replace function public.mark_supplier_payment_notification(
  p_id uuid,
  p_ok boolean,
  p_to_email text,
  p_gmail_message_id text,
  p_error text
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_mode text;
  v_row public.supplier_payment_notifications%rowtype;
  v_test_group text;
  v_group text;
  v_po_numbers text[];
  v_request_numbers text[];
  v_po_text text;
  v_payment_number text;
  v_amount numeric;
  v_digits text;
  v_grouped text;
  v_index integer;
  v_message text;
begin
  if coalesce(auth.role(), '') <> 'service_role'
     and current_user not in ('postgres', 'supabase_admin') then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if p_id is null then
    return;
  end if;

  select coalesce(nullif(btrim(value), ''), 'test')
    into v_mode
  from public.app_settings
  where key = 'supplier_payment_notify_mode';
  v_mode := coalesce(v_mode, 'test');

  if p_ok then
    update public.supplier_payment_notifications
       set status = 'sent',
           sent_at = now(),
           to_email = nullif(btrim(coalesce(p_to_email, '')), ''),
           gmail_message_id = p_gmail_message_id,
           mode = v_mode,
           last_error = null
     where id = p_id
    returning * into v_row;

    if not found then
      return;
    end if;

    if v_mode = 'test' then
      select nullif(btrim(value), '')
        into v_test_group
      from public.app_settings
      where key = 'supplier_payment_notify_test_zalo_group';
      v_group := v_test_group;
    else
      select nullif(btrim(z.zalo_group_id), '')
        into v_group
      from public.supplier_zalo_groups z
      where z.supplier_id = v_row.supplier_id
        and z.enabled
      limit 1;
    end if;

    if v_group is not null then
      select l.po_numbers, l.request_numbers
        into v_po_numbers, v_request_numbers
      from public.supplier_payment_allocation_labels(v_row.payment_id) l;

      select p.payment_number, p.amount
        into v_payment_number, v_amount
      from public.payments p
      where p.id = v_row.payment_id;

      v_po_text := array_to_string(v_po_numbers, ', ');
      if nullif(btrim(coalesce(v_po_text, '')), '') is null then
        v_po_text := array_to_string(v_request_numbers, ', ');
      end if;
      if nullif(btrim(coalesce(v_po_text, '')), '') is null then
        v_po_text := coalesce(v_payment_number, v_row.payment_id::text);
      end if;

      v_digits := round(abs(coalesce(v_amount, 0)))::bigint::text;
      v_grouped := '';
      for v_index in 1..length(v_digits) loop
        if v_index > 1
           and ((length(v_digits) - v_index + 1) % 3) = 0 then
          v_grouped := v_grouped || '.';
        end if;
        v_grouped := v_grouped || substr(v_digits, v_index, 1);
      end loop;
      if coalesce(v_amount, 0) < 0 then
        v_grouped := '-' || v_grouped;
      end if;

      v_message := case when v_mode = 'test' then '[THỬ] ' else '' end
        || 'BMQ đã thanh toán ' || v_po_text
        || ', số tiền ' || v_grouped
        || ' đ. Anh/Chị vui lòng kiểm tra email để xem ảnh UNC. Trân trọng.';

      insert into public.supplier_zalo_notifications (
        payment_id,
        supplier_id,
        zalo_group_id,
        message,
        kind
      ) values (
        v_row.payment_id,
        v_row.supplier_id,
        v_group,
        v_message,
        'payment'
      )
      on conflict (payment_id) do nothing;
    end if;
  else
    update public.supplier_payment_notifications
       set status = 'failed',
           last_error = left(coalesce(p_error, ''), 500)
     where id = p_id;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Huỷ đơn đã gửi
-- ---------------------------------------------------------------------------

create or replace function public.cancel_supplier_order(
  p_request_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_request public.supplier_order_requests%rowtype;
  v_reason text;
  v_po_number text;
  v_supplier_name text;
  v_group public.supplier_zalo_groups%rowtype;
  v_zalo_queued boolean := false;
  v_already_cancelled boolean := false;
  v_lines jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if not (
      public.has_role(auth.uid(), 'owner')
      or public.has_module_permission(auth.uid(), 'supplier_orders', 'edit')
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  v_reason := btrim(coalesce(p_reason, ''));
  if length(v_reason) < 1 or length(v_reason) > 500 then
    raise exception 'cancel_reason_required' using errcode = '22023';
  end if;

  select *
    into v_request
  from public.supplier_order_requests
  where id = p_request_id
     or request_id = p_request_id
  for update;

  if not found then
    raise exception 'order_not_found' using errcode = 'P0002';
  end if;

  if v_request.status = 'cancelled' then
    v_already_cancelled := true;
  elsif v_request.status <> 'sent' then
    raise exception 'order_not_cancellable' using errcode = '22023';
  else
    -- The old PO cancel guard (paid payment requests / received goods) runs on
    -- this UPDATE and its po_cancel_has_* errors bubble up unchanged.
    if v_request.purchase_order_id is not null then
      update public.purchase_orders
         set status = 'cancelled'
       where id = v_request.purchase_order_id
         and status::text <> 'cancelled';
    end if;

    update public.supplier_order_requests
       set status = 'cancelled',
           cancelled_at = now(),
           cancelled_by = auth.uid(),
           cancel_reason = v_reason
     where id = v_request.id
    returning * into v_request;

    select *
      into v_group
    from public.supplier_zalo_groups
    where supplier_id = v_request.supplier_id
      and enabled
    limit 1;

    if found then
      insert into public.supplier_zalo_notifications (
        order_request_id,
        supplier_id,
        zalo_group_id,
        message,
        kind
      ) values (
        v_request.id,
        v_request.supplier_id,
        v_group.zalo_group_id,
        public.supplier_order_cancel_zalo_message(v_request.id),
        'cancel'
      )
      on conflict (order_request_id, kind) where order_request_id is not null
      do nothing;

      v_zalo_queued := found;
    end if;
  end if;

  select po_number
    into v_po_number
  from public.purchase_orders
  where id = v_request.purchase_order_id;

  select name
    into v_supplier_name
  from public.suppliers
  where id = v_request.supplier_id;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'product_name', source.product_name,
             'quantity', source.quantity,
             'unit', source.unit
           )
           order by source.position, source.product_name
         ), '[]'::jsonb)
    into v_lines
  from (
    select l.position, l.product_name, l.quantity, l.unit
    from public.supplier_order_request_lines l
    where l.request_id = v_request.id

    union all

    select 0 as position, poi.product_name, poi.quantity, poi.unit
    from public.purchase_order_items poi
    where v_request.purchase_order_id is not null
      and poi.purchase_order_id = v_request.purchase_order_id
      and not exists (
        select 1
        from public.supplier_order_request_lines l
        where l.request_id = v_request.id
      )
  ) source;

  return jsonb_build_object(
    'request_id', v_request.id,
    'po_number', v_po_number,
    'supplier_name', v_supplier_name,
    'to_email', v_request.to_email,
    'sent_at', v_request.sent_at,
    'cancel_reason', v_request.cancel_reason,
    'cancelled_at', v_request.cancelled_at,
    'cancel_email_sent_at', v_request.cancel_email_sent_at,
    'already_cancelled', v_already_cancelled,
    'zalo_queued', v_zalo_queued,
    'total', v_request.total_amount,
    'lines', v_lines
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Đánh dấu đã gửi email huỷ (chỉ service_role)
-- ---------------------------------------------------------------------------

create or replace function public.mark_supplier_order_cancel_email(
  p_request_id uuid,
  p_gmail_message_id text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  update public.supplier_order_requests
     set cancel_email_sent_at = now(),
         cancel_gmail_message_id = p_gmail_message_id
   where id = p_request_id
      or request_id = p_request_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. Lịch sử đơn theo NCC: thêm mốc/lý do huỷ, vẫn trả đơn 'cancelled'
-- ---------------------------------------------------------------------------

create or replace function public.supplier_order_history_by_supplier(p_supplier_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_items jsonb;
begin
  if p_supplier_id is null then
    raise exception 'supplier_required' using errcode = '22023';
  end if;

  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
    if not (
      public.has_role(v_actor, 'owner')
      or public.has_module_permission(v_actor, 'supplier_orders', 'view')
      or public.has_module_permission(v_actor, 'supplier_orders', 'edit')
    ) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', r.id,
    'request_id', r.request_id,
    'po_number', r.po_number,
    'po_status', r.po_status,
    'subtotal', r.subtotal_amount,
    'vat_amount', r.vat_amount,
    'total', coalesce(r.total_amount, r.line_total),
    'status', r.status,
    'sent_at', r.sent_at,
    'to_email', r.to_email,
    'created_at', r.created_at,
    'cancelled_at', r.cancelled_at,
    'cancel_reason', r.cancel_reason,
    'cancel_email_sent_at', r.cancel_email_sent_at,
    'receipt', case
      when gr.id is null then null
      else jsonb_build_object(
        'id', gr.id,
        'receipt_number', gr.receipt_number,
        'status', gr.status,
        'finalized_at', gr.finalized_at
      )
    end,
    'payment', case
      when pay.id is null then null
      else jsonb_build_object(
        'request_number', pay.request_number,
        'status', pay.status,
        'payment_status', pay.payment_status,
        'total_amount', pay.total_amount
      )
    end,
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object(
        'position', l.position,
        'item_id', l.kitchen_inventory_item_id,
        'product_name', l.product_name,
        'quantity', l.quantity,
        'unit', l.unit,
        'unit_price', l.unit_price,
        'line_total', l.line_total,
        'vat_rate', l.vat_rate,
        'gross_amount', l.gross_amount
      ) order by l.position)
      from public.supplier_order_request_lines l
      where l.request_id = r.id
    ), case
      -- A single-item order from the kho item card has no line rows.
      when r.kitchen_inventory_item_id is not null then jsonb_build_array(jsonb_build_object(
        'position', 1,
        'item_id', r.kitchen_inventory_item_id,
        'product_name', coalesce((
          select poi.product_name
          from public.purchase_order_items poi
          where poi.purchase_order_id = r.purchase_order_id
          order by poi.created_at
          limit 1
        ), (
          select k.name from public.kitchen_inventory_items k
          where k.id = r.kitchen_inventory_item_id
        )),
        'quantity', r.quantity,
        'unit', r.unit,
        'unit_price', r.unit_price,
        'line_total', r.line_total,
        'vat_rate', null
      ))
      else '[]'::jsonb
    end),
    'uploads', coalesce((
      select jsonb_agg(jsonb_build_object(
        'file_name', u.file_name,
        'mime_type', u.mime_type,
        'size_bytes', u.size_bytes,
        'created_at', u.created_at,
        'storage_path', u.storage_path
      ) order by u.created_at desc)
      from public.supplier_order_uploads u
      where u.order_request_id = r.id
    ), '[]'::jsonb),
    'prepay', case
      when r.prepay_status is null then null
      else jsonb_build_object(
        'status', r.prepay_status,
        'request_number', pr.request_number,
        'submission_number', ps.submission_number
      )
    end
  ) order by r.created_at desc), '[]'::jsonb)
  into v_items
  from (
    select req.*, po.po_number as po_number, po.status::text as po_status
    from public.supplier_order_requests req
    left join public.purchase_orders po on po.id = req.purchase_order_id
    where req.supplier_id = p_supplier_id
    order by req.created_at desc
    limit 20
  ) r
  left join public.payment_requests pr on pr.id = r.prepay_request_id
  left join public.payment_submissions ps on ps.id = r.prepay_submission_id
  left join public.goods_receipts gr on gr.id = coalesce(
    r.goods_receipt_id,
    (
      select g.id
      from public.goods_receipts g
      where g.purchase_order_id = r.purchase_order_id
      order by g.created_at asc, g.id asc
      limit 1
    )
  )
  left join public.payment_requests pay on pay.id = coalesce(
    r.payment_request_id,
    (
      select p.id
      from public.payment_requests p
      where p.purchase_order_id = r.purchase_order_id
      order by p.created_at asc, p.id asc
      limit 1
    )
  );

  return jsonb_build_object('items', v_items);
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Quyền
-- ---------------------------------------------------------------------------

revoke all on function public.cancel_supplier_order(uuid, text)
  from public, anon, authenticated;
grant execute on function public.cancel_supplier_order(uuid, text)
  to authenticated, service_role;

revoke all on function public.mark_supplier_order_cancel_email(uuid, text)
  from public, anon, authenticated;
grant execute on function public.mark_supplier_order_cancel_email(uuid, text)
  to service_role;

revoke all on function public.supplier_order_cancel_zalo_message(uuid)
  from public, anon, authenticated;
grant execute on function public.supplier_order_cancel_zalo_message(uuid)
  to service_role;

revoke all on function public.supplier_order_history_by_supplier(uuid)
  from public, anon;
grant execute on function public.supplier_order_history_by_supplier(uuid)
  to authenticated, service_role;

revoke all on function public.enqueue_supplier_zalo_notification()
  from public, anon, authenticated;
grant execute on function public.enqueue_supplier_zalo_notification()
  to service_role;

revoke all on function public.mark_supplier_payment_notification(
  uuid, boolean, text, text, text
) from public, anon, authenticated;
grant execute on function public.mark_supplier_payment_notification(
  uuid, boolean, text, text, text
) to service_role;
