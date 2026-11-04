-- Tin Zalo báo đã thanh toán: đổi câu nhắc tải chứng từ (owner 04/11/2026).
--
-- Thêm một dòng trống sau câu UNC và đổi lời nhắc thành
-- "Upload phiếu giao hàng/hoá đơn tại link sau:" (nhiều PO: "tại các link sau:").
-- Phần còn lại giữ nguyên bản 20261104110000_supplier_payment_upload_link mục 5.

-- ---------------------------------------------------------------------------
-- 5. mark_supplier_payment_notification — bản mới nhất từ
--    20261103560000_supplier_order_cancel.sql mục 5, chỉ thêm link tải.
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
        for v_po in
          select distinct po.po_number, r.id as order_request_id
          from public.payment_allocations pa
          join public.payment_requests pr
            on pr.id = pa.payment_request_id
          join public.purchase_orders po
            on po.id = pr.purchase_order_id
          join lateral (
            select sor.id
            from public.supplier_order_requests sor
            where sor.purchase_order_id = po.id
              and sor.status <> 'cancelled'
            order by sor.created_at desc, sor.id desc
            limit 1
          ) r on true
          where pa.payment_id = v_row.payment_id
          order by po.po_number asc, r.id asc
        loop
          v_upload_token := translate(
            rtrim(encode(extensions.gen_random_bytes(32), 'base64'), '='),
            '+/', '-_'
          );
          -- Same bytes as sha256Hex() in the supplier-order-upload function.
          v_upload_token_hash := encode(
            extensions.digest(convert_to(v_upload_token, 'UTF8'), 'sha256'),
            'hex'
          );

          insert into public.supplier_order_upload_tokens (
            order_request_id,
            token_hash,
            purpose,
            payment_id,
            expires_at
          ) values (
            v_po.order_request_id,
            v_upload_token_hash,
            'payment',
            v_row.payment_id,
            now() + interval '30 days'
          );

          v_upload_tokens := array_append(v_upload_tokens, v_upload_token);
          v_upload_token_hashes := array_append(
            v_upload_token_hashes, v_upload_token_hash
          );
          v_upload_link_lines := array_append(
            v_upload_link_lines,
            '• ' || coalesce(v_po.po_number, '')
              || ': https://ai.banhmique.vn/ncc/hoa-don/' || v_upload_token
          );
        end loop;

        v_link_count := coalesce(array_length(v_upload_tokens, 1), 0);

        if v_link_count = 1 then
          v_message := v_message
            || E'\n\n' || 'Upload phiếu giao hàng/hoá đơn tại link sau:'
            || E'\n' || 'https://ai.banhmique.vn/ncc/hoa-don/' || v_upload_tokens[1]
            || E'\n' || 'Trân trọng.';
        elsif v_link_count >= 2 then
          v_message := v_message
            || E'\n\n' || 'Upload phiếu giao hàng/hoá đơn tại các link sau:';
          for v_index in 1..v_link_count loop
            v_message := v_message || E'\n' || v_upload_link_lines[v_index];
          end loop;
          v_message := v_message || E'\n' || 'Trân trọng.';
        else
          v_message := v_message || ' Trân trọng.';
        end if;

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
$$;

revoke all on function public.mark_supplier_payment_notification(
  uuid, boolean, text, text, text
) from public, anon, authenticated;
grant execute on function public.mark_supplier_payment_notification(
  uuid, boolean, text, text, text
) to service_role;
