-- Rollback-only production smoke for migration
-- 20261012160000_auto_receive_on_payment.sql.
--
-- Run as one file: `supabase db query --linked -f supabase/tests/auto_receive_on_payment_prod_smoke.sql`.
-- The file opens one transaction, applies the migration SQL inline, then exercises
-- the backfill RPC (dry run + up to 10 real receipts with source 'backfill'), the
-- switch, the payment trigger and the Zalo suppression. The final RAISE ends the
-- transaction, so every change is rolled back. No existing business row is persisted.
begin;
-- Tự động nhập kho khi phiếu chi chuyển sang 'paid' + công tắc + xử lý bù.
--
-- Bối cảnh: kho chưa vận hành, hàng thực tế đã về nhưng phiếu nhập kho (goods
-- receipts) đi kèm phiếu chi vẫn đang chờ nhập. Khi một phiếu chi được chi
-- (payment_requests.payment_status = 'paid') và công tắc
-- finance_settings.warehouse_auto_receive_on_payment bật, phiếu nhập chờ được
-- tự nhập bằng public.finalize_goods_receipt với actual_quantity =
-- ordered_quantity. Mọi lỗi bị bắt và ghi vào goods_receipt_auto_receive_log,
-- không bao giờ chặn giao dịch chi.
--
-- Điều kiện đã kiểm trên database thật trước khi viết migration (CHỈ SELECT):
--   * public.finalize_goods_receipt(uuid, uuid) hiện là wrapper Task5: gọi
--     public.assert_goods_receipt_materials_ready(...) (mode goods_receipt đang
--     là 'shadow' nên không chặn) rồi gọi
--     public.finalize_goods_receipt_stock_payable_unchecked_20260817(...).
--   * finalize (bản unchecked, bản mới nhất 20260730013000) chạy trong cùng
--     giao dịch: đặt goods_receipts.status = 'received', payable_status theo
--     payable hiện có, finalized_at = now(), finalized_by = actor, rồi ghi
--     inventory_items / inventory_batches. Vì vậy sau finalize trigger
--     auto_issue_goods_receipt_on_received (AFTER UPDATE OF status, WHEN
--     new.status::text = 'received') tự chạy tạo goods_receipt_auto_issues, và
--     trigger trg_finance_zalo_goods_receipt cũng chạy trong cùng statement.
--   * finalize từ chối nếu status đã 'received' hoặc payable_status <> 'not_generated';
--     điều này trùng với các điều kiện "skip" bên dưới nên xử lý bù không đụng
--     các phiếu đã nhập.
--   * public.assert_goods_receipt_materials_ready(uuid, uuid) chỉ raise khi mode
--     'enforced'; hiện tại mode = 'shadow' (đã kiểm material_master_enforcement_config).
--   * goods_receipt_items có ordered_quantity numeric null và actual_quantity
--     numeric null; không có dòng pending nào có actual_quantity > 0 khác
--     ordered_quantity, nên gán actual_quantity = ordered_quantity là an toàn.
--   * trg_sync_payment_allocation_parent_status nằm trên payment_allocations và
--     gọi public.sync_payment_request_payment_status(...), là nơi
--     payment_requests.payment_status đổi sang 'paid' khi ghi nhận tiền chi.
--   * public.enqueue_finance_zalo_goods_receipt() chèn
--     finance_zalo_notifications status 'pending' (status 'suppressed' đã có
--     trong check constraint).
--   * 80 phiếu chi 'paid' đang trỏ tới phiếu nhập chưa 'received' / chưa finalized.
--
-- Migration này KHÔNG sửa public.finalize_goods_receipt,
-- public.auto_issue_goods_receipt hay luồng chi tiền; chỉ định nghĩa lại
-- public.enqueue_finance_zalo_goods_receipt() y hệt bản cũ, thêm một nhánh.

-- ---------------------------------------------------------------------------
-- 1. Công tắc hệ thống (finance_settings) + log tự động nhập kho.
-- ---------------------------------------------------------------------------
create table if not exists public.finance_settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid
);

comment on table public.finance_settings is
  'Công tắc cấu hình tài chính. Client chỉ đọc (owner); mọi thay đổi qua RPC owner-only public.set_finance_setting.';

insert into public.finance_settings (key, value)
values ('warehouse_auto_receive_on_payment', 'true'::jsonb)
on conflict (key) do nothing;

alter table public.finance_settings enable row level security;

drop policy if exists finance_settings_owner_select on public.finance_settings;
create policy finance_settings_owner_select
  on public.finance_settings
  for select to authenticated
  using (public.has_role((select auth.uid()), 'owner'));

revoke all on public.finance_settings from public, anon, authenticated;
grant select on public.finance_settings to authenticated;
grant all on public.finance_settings to service_role;

create table if not exists public.goods_receipt_auto_receive_log (
  id uuid primary key default gen_random_uuid(),
  goods_receipt_id uuid,
  payment_request_id uuid,
  source text not null check (source in ('payment', 'backfill')),
  status text not null check (status in ('received', 'failed', 'skipped')),
  error text,
  created_at timestamptz not null default now()
);

comment on table public.goods_receipt_auto_receive_log is
  'Nhật ký tự động nhập kho khi phiếu chi paid (source payment) hoặc xử lý bù (source backfill). Mọi lỗi finalize được ghi ở đây, không throw ra giao dịch chi.';

alter table public.goods_receipt_auto_receive_log enable row level security;

drop policy if exists goods_receipt_auto_receive_log_read on public.goods_receipt_auto_receive_log;
create policy goods_receipt_auto_receive_log_read
  on public.goods_receipt_auto_receive_log
  for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.has_module_permission((select auth.uid()), 'payment_requests', 'view')
  );

revoke all on public.goods_receipt_auto_receive_log from public, anon, authenticated;
grant select on public.goods_receipt_auto_receive_log to authenticated;
grant all on public.goods_receipt_auto_receive_log to service_role;

-- ---------------------------------------------------------------------------
-- 2. RPC owner-only đổi công tắc.
-- ---------------------------------------------------------------------------
create or replace function public.set_finance_setting(
  p_key text,
  p_value jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_row public.finance_settings%rowtype;
begin
  -- Owner-only, cùng khuôn quyền với public.cleanup_cancelled_po_placeholder_receipts.
  if not (coalesce(public.material_master_jwt_role(), '') = 'service_role' or public.has_role(v_actor, 'owner')) then
    raise exception 'not_owner' using errcode = '42501';
  end if;

  insert into public.finance_settings as fs (key, value, updated_at, updated_by)
  values (p_key, coalesce(p_value, 'null'::jsonb), now(), v_actor)
  on conflict (key) do update
    set value = excluded.value,
        updated_at = now(),
        updated_by = excluded.updated_by
  returning * into v_row;

  return jsonb_build_object('key', v_row.key, 'value', v_row.value, 'updated_at', v_row.updated_at);
end;
$$;

comment on function public.set_finance_setting(text, jsonb) is
  'Owner-only RPC: ghi công tắc finance_settings. Client không ghi trực tiếp bảng.';

revoke all on function public.set_finance_setting(text, jsonb) from public, anon;
grant execute on function public.set_finance_setting(text, jsonb) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Hàm tự động nhập một phiếu nhập (SECURITY DEFINER, không grant cho client).
-- ---------------------------------------------------------------------------
create or replace function public.auto_receive_goods_receipt(
  p_receipt_id uuid,
  p_payment_request_id uuid,
  p_actor uuid,
  p_source text
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_status text;
  v_finalized_at timestamptz;
  v_payable_status text;
  v_has_ordered boolean := false;
  v_result text := 'skipped';
begin
  select gr.status::text, gr.finalized_at, gr.payable_status::text
    into v_status, v_finalized_at, v_payable_status
    from public.goods_receipts gr
   where gr.id = p_receipt_id;

  select exists (
    select 1
      from public.goods_receipt_items gri
     where gri.goods_receipt_id = p_receipt_id
       and coalesce(gri.ordered_quantity, 0) > 0
  ) into v_has_ordered;

  if v_status is null
     or v_status = 'received'
     or v_finalized_at is not null
     or v_payable_status is distinct from 'not_generated'
     or not v_has_ordered then
    insert into public.goods_receipt_auto_receive_log
      (goods_receipt_id, payment_request_id, source, status, error)
    values (p_receipt_id, p_payment_request_id, p_source, 'skipped', null);
    v_result := 'skipped';
  else
    begin
      -- Bật cờ để enqueue Zalo ghi 'suppressed' cho lần nhập tự động này.
      perform set_config('bmq.auto_receive', 'on', true);

      -- Kho chưa vận hành: nhập đúng số lượng đặt (ordered) khi dòng chưa có số thực nhận.
      update public.goods_receipt_items
         set actual_quantity = ordered_quantity
       where goods_receipt_id = p_receipt_id
         and coalesce(ordered_quantity, 0) > 0
         and (actual_quantity is null or actual_quantity <= 0);

      perform public.finalize_goods_receipt(p_receipt_id, p_actor);

      insert into public.goods_receipt_auto_receive_log
        (goods_receipt_id, payment_request_id, source, status, error)
      values (p_receipt_id, p_payment_request_id, p_source, 'received', null);
      v_result := 'received';
    exception when others then
      -- Giao dịch con tự hủy: goods_receipt_items / tồn kho / phiếu nhập trở lại nguyên trạng.
      insert into public.goods_receipt_auto_receive_log
        (goods_receipt_id, payment_request_id, source, status, error)
      values (p_receipt_id, p_payment_request_id, p_source, 'failed', left(sqlerrm, 300));
      v_result := 'failed';
    end;
  end if;

  -- Luôn trả cờ về off, kể cả khi finalize lỗi.
  perform set_config('bmq.auto_receive', 'off', true);
  return v_result;
end;
$$;

comment on function public.auto_receive_goods_receipt(uuid, uuid, uuid, text) is
  'SECURITY DEFINER: tự nhập một phiếu nhập chờ bằng finalize_goods_receipt với actual_quantity = ordered_quantity; trả received/skipped/failed và ghi goods_receipt_auto_receive_log. Không grant cho authenticated.';

revoke all on function public.auto_receive_goods_receipt(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.auto_receive_goods_receipt(uuid, uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 4. Trigger trên payment_requests: tự nhập khi payment_status chuyển 'paid'.
-- ---------------------------------------------------------------------------
create or replace function public.auto_receive_on_payment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_enabled boolean;
  v_actor uuid;
  v_receipt record;
begin
  -- Toàn bộ thân trigger nằm trong BEGIN ... EXCEPTION để không bao giờ chặn việc chi.
  begin
    select (fs.value #>> '{}')::boolean
      into v_enabled
      from public.finance_settings fs
     where fs.key = 'warehouse_auto_receive_on_payment';

    if coalesce(v_enabled, false) is not true then
      return new;
    end if;

    v_actor := coalesce(auth.uid(), new.approved_by);

    if new.goods_receipt_id is not null then
      perform public.auto_receive_goods_receipt(new.goods_receipt_id, new.id, v_actor, 'payment');
    else
      for v_receipt in
        select gr.id
          from public.goods_receipts gr
         where gr.purchase_order_id = new.purchase_order_id
           and gr.status::text <> 'received'
         order by gr.created_at asc, gr.id asc
      loop
        perform public.auto_receive_goods_receipt(v_receipt.id, new.id, v_actor, 'payment');
      end loop;
    end if;
  exception when others then
    raise warning 'auto_receive_on_payment failed for payment request %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;

comment on function public.auto_receive_on_payment() is
  'AFTER UPDATE OF payment_status: khi payment_status chuyển sang paid và công tắc bật, tự nhập phiếu nhập đi kèm. Mọi lỗi chỉ raise warning.';

revoke all on function public.auto_receive_on_payment() from public, anon, authenticated;

drop trigger if exists trg_auto_receive_on_payment on public.payment_requests;
create trigger trg_auto_receive_on_payment
after update of payment_status on public.payment_requests
for each row
when (
  new.payment_status::text = 'paid'
  and old.payment_status::text is distinct from 'paid'
  and new.status::text <> 'rejected'
)
execute function public.auto_receive_on_payment();

-- ---------------------------------------------------------------------------
-- 5. Giữ nguyên logic enqueue Zalo phiếu nhập, thêm nhánh 'suppressed' khi tự động.
-- ---------------------------------------------------------------------------
create or replace function public.enqueue_finance_zalo_goods_receipt()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_short boolean;
  v_event text;
begin
  begin
    if new.status::text = 'received' and old.status::text is distinct from 'received' then
      select exists (
        select 1
        from public.goods_receipt_items gri
        where gri.goods_receipt_id = new.id and gri.line_status = 'thieu'
      ) into v_short;
      v_event := case when v_short then 'goods_receipt_short' else 'goods_receipt_received' end;

      insert into public.finance_zalo_notifications (
        event_type, entity_id, group_key, message_body, status
      ) values (
        v_event,
        new.id,
        'finance',
        coalesce(public.build_finance_zalo_goods_receipt_message(new.id, v_event), 'Phiếu nhận: ' || new.receipt_number),
        case when current_setting('bmq.auto_receive', true) = 'on' then 'suppressed' else 'pending' end
      )
      on conflict (event_type, entity_id) do nothing;
    end if;
  exception when others then
    raise warning 'finance_zalo enqueue goods receipt failed for %: %', new.id, sqlerrm;
  end;
  return new;
end;
$$;

revoke all on function public.enqueue_finance_zalo_goods_receipt() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 6. Xử lý bù các phiếu chi đã 'paid' còn phiếu nhập chờ (dry run / chạy thật).
-- ---------------------------------------------------------------------------
create or replace function public.backfill_auto_receive_paid(
  p_dry_run boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_candidates jsonb := '[]'::jsonb;
  v_received integer := 0;
  v_skipped integer := 0;
  v_failed jsonb := '[]'::jsonb;
  v_status text;
  v_error text;
  r record;
begin
  -- Owner-only, cùng khuôn quyền với public.cleanup_cancelled_po_placeholder_receipts.
  if not (coalesce(public.material_master_jwt_role(), '') = 'service_role' or public.has_role(v_actor, 'owner')) then
    raise exception 'not_owner' using errcode = '42501';
  end if;

  for r in
    select pr.id as payment_request_id,
           pr.request_number,
           gr.id as goods_receipt_id,
           gr.receipt_number
      from public.payment_requests pr
      join public.goods_receipts gr on gr.id = pr.goods_receipt_id
     where pr.payment_status::text = 'paid'
       and pr.status::text <> 'rejected'
       and gr.status::text <> 'received'
       and gr.finalized_at is null
     order by pr.request_number, gr.receipt_number
  loop
    if p_dry_run then
      v_candidates := v_candidates || jsonb_build_object(
        'request_number', r.request_number,
        'receipt_number', r.receipt_number
      );
    else
      v_status := public.auto_receive_goods_receipt(
        r.goods_receipt_id, r.payment_request_id, v_actor, 'backfill'
      );
      if v_status = 'received' then
        v_received := v_received + 1;
      elsif v_status = 'skipped' then
        v_skipped := v_skipped + 1;
      else
        select l.error
          into v_error
          from public.goods_receipt_auto_receive_log l
         where l.goods_receipt_id = r.goods_receipt_id
           and l.source = 'backfill'
           and l.status = 'failed'
         order by l.created_at desc, l.id desc
         limit 1;
        v_failed := v_failed || jsonb_build_object(
          'receipt_number', r.receipt_number,
          'error', coalesce(v_error, 'unknown')
        );
      end if;
    end if;
  end loop;

  if p_dry_run then
    return jsonb_build_object('candidates', v_candidates);
  end if;

  return jsonb_build_object('received', v_received, 'skipped', v_skipped, 'failed', v_failed);
end;
$$;

comment on function public.backfill_auto_receive_paid(boolean) is
  'Owner-only RPC: dry-run liệt kê / chạy thật tự nhập các phiếu chi paid còn phiếu nhập chờ. Trả {candidates} hoặc {received, skipped, failed}.';

revoke all on function public.backfill_auto_receive_paid(boolean) from public, anon;
grant execute on function public.backfill_auto_receive_paid(boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Behavioural checks. Every step catches the expected exception / state; a
-- wrong result raises SMOKE_RESULT FAIL <step> and aborts the transaction.
-- ---------------------------------------------------------------------------
do $$
declare
  v_owner uuid;
  v_switch jsonb;
  v_dry jsonb;
  v_cand_count integer;
  v_tried integer := 0;
  v_received_id uuid;
  v_received_no text;
  v_failed_count integer := 0;
  v_first_error text;
  v_status text;
  v_pr_id uuid;
  v_gr_id uuid;
  v_bad_lines integer;
  v_auto_issues integer;
  v_zalo_status text;
  v_empty_id uuid;
  v_empty_status text;
  v_trig_pr uuid;
  v_trig_gr_id uuid;
  v_trig_gr_no text;
  v_trig_ok boolean := false;
  v_off_pr uuid;
  v_off_gr_id uuid;
  v_off_gr_no text;
  v_norm_id uuid;
  v_norm_ok boolean := false;
  r record;
  c record;
begin
  select user_id into v_owner from public.user_roles where role = 'owner' limit 1;
  if v_owner is null then
    raise exception 'SMOKE_RESULT FAIL owner_missing';
  end if;
  perform set_config(
    'request.jwt.claims',
    json_build_object('sub', v_owner, 'role', 'authenticated')::text,
    true
  );

  select fs.value into v_switch
  from public.finance_settings fs
  where fs.key = 'warehouse_auto_receive_on_payment';
  if v_switch is distinct from 'true'::jsonb then
    raise exception 'SMOKE_RESULT FAIL switch_default: %', v_switch;
  end if;

  -- (a) Dry run of the backfill must list the real pool of paid requests whose
  -- receipt is still pending (currently around 80).
  v_dry := public.backfill_auto_receive_paid(true);
  v_cand_count := coalesce(jsonb_array_length(v_dry->'candidates'), -1);
  if v_cand_count <= 0 then
    raise exception 'SMOKE_RESULT FAIL a_dry_run: candidates=%', v_cand_count;
  end if;

  -- (b) Run the backfill for real on at most the first 10 candidates until one
  -- is received, then prove the receipt/stock/Zalo invariants.
  for r in
    select x->>'request_number' as request_number,
           x->>'receipt_number' as receipt_number
    from jsonb_array_elements(v_dry->'candidates') x
    limit 10
  loop
    v_tried := v_tried + 1;
    v_pr_id := null;
    v_gr_id := null;
    select pr.id, gr.id into v_pr_id, v_gr_id
    from public.payment_requests pr
    join public.goods_receipts gr on gr.id = pr.goods_receipt_id
    where pr.request_number = r.request_number
      and gr.receipt_number = r.receipt_number;
    if v_pr_id is null then
      continue;
    end if;

    v_status := public.auto_receive_goods_receipt(v_gr_id, v_pr_id, v_owner, 'backfill');
    if v_status = 'failed' then
      v_failed_count := v_failed_count + 1;
      if v_first_error is null then
        select l.error into v_first_error
        from public.goods_receipt_auto_receive_log l
        where l.goods_receipt_id = v_gr_id
          and l.source = 'backfill'
          and l.status = 'failed'
        order by l.created_at desc, l.id desc
        limit 1;
      end if;
    elsif v_status = 'received' then
      v_received_id := v_gr_id;
      v_received_no := r.receipt_number;
      exit;
    end if;
  end loop;

  if v_received_id is null then
    raise exception 'SMOKE_RESULT FAIL b_no_received: tried=% failed=% first_error=%',
      v_tried, v_failed_count, v_first_error;
  end if;

  if not exists (
    select 1
    from public.goods_receipts gr
    where gr.id = v_received_id
      and gr.status::text = 'received'
      and gr.finalized_at is not null
  ) then
    raise exception 'SMOKE_RESULT FAIL b_receipt_state: %', v_received_no;
  end if;

  select count(*) into v_bad_lines
  from public.goods_receipt_items gri
  where gri.goods_receipt_id = v_received_id
    and coalesce(gri.ordered_quantity, 0) > 0
    and gri.actual_quantity is distinct from gri.ordered_quantity;
  if v_bad_lines <> 0 then
    raise exception 'SMOKE_RESULT FAIL b_actual_quantity: receipt=% bad_lines=%',
      v_received_no, v_bad_lines;
  end if;

  select count(*) into v_auto_issues
  from public.goods_receipt_auto_issues ai
  where ai.goods_receipt_id = v_received_id;
  if v_auto_issues = 0 then
    raise exception 'SMOKE_RESULT FAIL b_auto_issue: %', v_received_no;
  end if;

  v_zalo_status := null;
  select n.status into v_zalo_status
  from public.finance_zalo_notifications n
  where n.entity_id = v_received_id
    and n.event_type in ('goods_receipt_received', 'goods_receipt_short')
  order by n.created_at desc
  limit 1;
  if v_zalo_status is not null and v_zalo_status <> 'suppressed' then
    raise exception 'SMOKE_RESULT FAIL b_zalo_suppressed: receipt=% status=%',
      v_received_no, v_zalo_status;
  end if;

  -- (c) A receipt with no ordered_quantity > 0 line must be skipped, not raised.
  select gr.id into v_empty_id
  from public.goods_receipts gr
  where gr.status::text <> 'received'
    and gr.finalized_at is null
    and not exists (
      select 1
      from public.goods_receipt_items gri
      where gri.goods_receipt_id = gr.id
        and coalesce(gri.ordered_quantity, 0) > 0
    )
  order by gr.receipt_number
  limit 1;
  if v_empty_id is null then
    raise exception 'SMOKE_RESULT FAIL c_no_empty_receipt';
  end if;
  v_empty_status := public.auto_receive_goods_receipt(v_empty_id, null, v_owner, 'backfill');
  if v_empty_status <> 'skipped' then
    raise exception 'SMOKE_RESULT FAIL c_skipped: got=%', v_empty_status;
  end if;

  -- (d) Switch ON: marking a pending phiếu chi 'paid' must auto receive its receipt.
  for c in
    select pr.id as payment_request_id, gr.id as goods_receipt_id, gr.receipt_number
    from public.payment_requests pr
    join public.goods_receipts gr on gr.id = pr.goods_receipt_id
    where pr.payment_status::text <> 'paid'
      and pr.status::text <> 'rejected'
      and gr.status::text <> 'received'
      and gr.finalized_at is null
    order by pr.request_number, gr.receipt_number
    limit 15
  loop
    update public.payment_requests
    set payment_status = 'paid'
    where id = c.payment_request_id;
    if exists (
      select 1
      from public.goods_receipts gr
      where gr.id = c.goods_receipt_id
        and gr.status::text = 'received'
        and gr.finalized_at is not null
    ) then
      v_trig_pr := c.payment_request_id;
      v_trig_gr_id := c.goods_receipt_id;
      v_trig_gr_no := c.receipt_number;
      v_trig_ok := true;
      exit;
    end if;
  end loop;
  if not v_trig_ok then
    raise exception 'SMOKE_RESULT FAIL d_trigger_on';
  end if;

  -- (d) Switch OFF: the same kind of transition must leave the receipt pending.
  update public.finance_settings
  set value = 'false'::jsonb, updated_at = now()
  where key = 'warehouse_auto_receive_on_payment';

  for c in
    select pr.id as payment_request_id, gr.id as goods_receipt_id, gr.receipt_number
    from public.payment_requests pr
    join public.goods_receipts gr on gr.id = pr.goods_receipt_id
    where pr.payment_status::text <> 'paid'
      and pr.status::text <> 'rejected'
      and gr.status::text <> 'received'
      and gr.finalized_at is null
    order by pr.request_number, gr.receipt_number
    limit 1
  loop
    v_off_pr := c.payment_request_id;
    v_off_gr_id := c.goods_receipt_id;
    v_off_gr_no := c.receipt_number;
  end loop;
  if v_off_pr is null then
    raise exception 'SMOKE_RESULT FAIL d_no_off_candidate';
  end if;
  update public.payment_requests set payment_status = 'paid' where id = v_off_pr;
  if exists (
    select 1
    from public.goods_receipts gr
    where gr.id = v_off_gr_id
      and gr.status::text = 'received'
  ) then
    raise exception 'SMOKE_RESULT FAIL d_trigger_off: %', v_off_gr_no;
  end if;

  update public.finance_settings
  set value = 'true'::jsonb, updated_at = now()
  where key = 'warehouse_auto_receive_on_payment';

  -- (e) A normal finalize with the auto flag off must still enqueue 'pending'.
  -- Simulate the warehouse entering the received quantity, then finalize.
  for c in
    select pr.id as payment_request_id, gr.id as goods_receipt_id, gr.receipt_number
    from public.payment_requests pr
    join public.goods_receipts gr on gr.id = pr.goods_receipt_id
    left join public.purchase_orders po on po.id = gr.purchase_order_id
    where pr.status::text <> 'rejected'
      and gr.status::text <> 'received'
      and gr.finalized_at is null
      and gr.payable_status::text = 'not_generated'
      and coalesce(nullif(gr.image_url, ''), nullif(po.image_url, '')) is not null
      and exists (
        select 1
        from public.goods_receipt_items gri
        where gri.goods_receipt_id = gr.id
          and coalesce(gri.ordered_quantity, 0) > 0
      )
    order by gr.receipt_number
    limit 15
  loop
    v_norm_ok := false;
    begin
      update public.goods_receipt_items
      set actual_quantity = ordered_quantity
      where goods_receipt_id = c.goods_receipt_id
        and coalesce(ordered_quantity, 0) > 0
        and (actual_quantity is null or actual_quantity <= 0);
      perform public.finalize_goods_receipt(c.goods_receipt_id, v_owner);
      v_norm_id := c.goods_receipt_id;
      v_norm_ok := true;
    exception when others then
      v_norm_ok := false;
    end;
    exit when v_norm_ok;
  end loop;
  if not v_norm_ok then
    raise exception 'SMOKE_RESULT FAIL e_no_normal_finalize';
  end if;

  v_zalo_status := null;
  select n.status into v_zalo_status
  from public.finance_zalo_notifications n
  where n.entity_id = v_norm_id
    and n.event_type in ('goods_receipt_received', 'goods_receipt_short')
  order by n.created_at desc
  limit 1;
  if v_zalo_status is distinct from 'pending' then
    raise exception 'SMOKE_RESULT FAIL e_zalo_pending: status=%', v_zalo_status;
  end if;

  raise exception 'SMOKE_RESULT PASS: auto receive on payment (backfill_candidates=%, tried=%, received=1, failed=%, first_error=%)',
    v_cand_count, v_tried, v_failed_count, coalesce(v_first_error, 'none');
end $$;
