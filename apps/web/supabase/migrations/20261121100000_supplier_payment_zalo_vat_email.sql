-- Tin Zalo báo đã thanh toán gửi nhà cung cấp: bỏ link tải phiếu giao hàng/hoá đơn,
-- thay bằng câu đề nghị gửi hoá đơn VAT về hoadon@bmq.vn (owner 21/11/2026).
-- Không tạo upload token mới nữa. Phần còn lại của hàm giữ nguyên bản đang chạy.

create or replace function public.mark_supplier_payment_notification(p_id uuid, p_ok boolean, p_to_email text, p_gmail_message_id text, p_error text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
  v_po record;
  v_upload_token text;
  v_upload_token_hash text;
  v_upload_tokens text[] := array[]::text[];
  v_upload_token_hashes text[] := array[]::text[];
  v_upload_link_lines text[] := array[]::text[];
  v_link_count integer;
  v_inserted integer := 0;
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
        || ' đ. Anh/Chị vui lòng kiểm tra email để xem ảnh UNC.';

      -- Retries must not mint orphan tokens: only create links when the Zalo
      -- row for this payment does not exist yet.
      if not exists (
        select 1
        from public.supplier_zalo_notifications z
        where z.payment_id = v_row.payment_id
      ) then
        -- Owner 21/11/2026: no upload link any more; ask for the VAT invoice by email.
        v_message := v_message
          || E'\n\n' || 'Kính đề nghị nhà cung cấp vui lòng gửi hoá đơn VAT về email theo địa chỉ sau: hoadon@bmq.vn'
          || E'\n' || 'Trân trọng.';

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

        get diagnostics v_inserted = row_count;
        if v_inserted = 0
           and coalesce(array_length(v_upload_token_hashes, 1), 0) > 0 then
          delete from public.supplier_order_upload_tokens
          where token_hash = any(v_upload_token_hashes);
        end if;
      end if;
    end if;
  else
    update public.supplier_payment_notifications
       set status = 'failed',
           last_error = left(coalesce(p_error, ''), 500)
     where id = p_id;
  end if;
end;
$function$;
