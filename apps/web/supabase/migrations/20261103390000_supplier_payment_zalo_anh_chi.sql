-- Tin Zalo báo thanh toán: xưng 'Anh/Chị' thay vì 'Anh' (anh Tâm duyệt 29/10).
-- Chỉ thay nội dung hàm mark_supplier_payment_notification; chữ ký và quyền giữ nguyên.

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
        message
      ) values (
        v_row.payment_id,
        v_row.supplier_id,
        v_group,
        v_message
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
