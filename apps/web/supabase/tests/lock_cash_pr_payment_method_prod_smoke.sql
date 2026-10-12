-- Rollback-only production smoke for migration
-- 20261029100000_lock_cash_pr_payment_method.sql.
--
-- Run as one file:
--   supabase db query --linked -f supabase/tests/lock_cash_pr_payment_method_prod_smoke.sql
-- The file opens one transaction, applies the migration SQL inline, then
-- exercises: (a) a direct 'cash' -> 'bank_transfer' update on a real new-flow
-- Chi tiền mặt phiếu (it has a public.cash_pr_idempotency row) must raise
-- cash_pr_method_locked with the real request number; (b) the canonical
-- approve_payment_request_with_material_controller RPC called with
-- 'bank_transfer' on the same phiếu must hit the same guard (any earlier error
-- is recorded in the PASS string, not failed); (c) re-writing
-- payment_method = 'cash' (unchanged) succeeds; (d) a legacy cash phiếu without
-- an idempotency row and with a null cash_settlement_status can still switch to
-- 'bank_transfer'; (e) a 'bank_transfer' phiếu can still switch to 'cash'. The
-- final RAISE ends the transaction, so every change is rolled back. No existing
-- business row is persisted.
begin;
-- Chặn đổi hình thức chi của phiếu Chi tiền mặt thuộc luồng mới.
--
-- Bối cảnh: phiếu chi đã đi qua luồng "Chi tiền mặt" mới (có dòng trong
-- public.cash_pr_idempotency hoặc đã có cash_settlement_status) là phiếu tiền
-- mặt đã khoá hình thức. Không được đổi payment_method từ 'cash' sang giá trị
-- khác (ví dụ 'bank_transfer') qua bất kỳ đường duyệt nào.
--
-- Điều kiện đã kiểm trên database thật trước khi viết migration (CHỈ SELECT):
--   * public.approve_payment_request_with_material_controller(uuid, text, uuid)
--     cập nhật public.payment_requests set status = 'approved', payment_method =
--     ... trong một câu UPDATE, nên trigger BEFORE UPDATE OF payment_method bắt
--     được mọi đường duyệt.
--   * public.approve_payment_requests_with_unc(uuid[], jsonb, text) gọi lại
--     public.approve_payment_request_with_material_controller(v_pr.id, v_method,
--     v_actor) cho từng phiếu 'pending' trước khi insert public.payments, nên
--     lỗi trong trigger huỷ cả lần duyệt (rollback toàn bộ RPC).
--   * Trigger BEFORE UPDATE chạy theo thứ tự tên:
--     trg_guard_cash_pr_payment_method đứng trước
--     trg_guard_payment_request_material_approval nên lỗi khoá hình thức nổi
--     lên trước.
--   * public.cash_pr_idempotency(payment_request_id uuid not null, ...) là dấu
--     hiệu phiếu thuộc luồng Chi tiền mặt mới; cột
--     public.payment_requests.cash_settlement_status (text, nullable) là dấu
--     hiệu bổ sung.
--   * Phiếu cash form cũ (không có dòng idempotency, cash_settlement_status
--     null) vẫn được đổi hình thức; chiều bank_transfer -> cash và giữ nguyên
--     cash không bị ảnh hưởng.
--
-- Migration này KHÔNG sửa public.approve_payment_request_with_material_controller,
-- public.approve_payment_requests_with_unc hay bất kỳ hàm duyệt nào; chỉ thêm một
-- trigger và một hàm trigger.

-- ---------------------------------------------------------------------------
-- 1. Hàm trigger: khoá hình thức chi tiền mặt của phiếu thuộc luồng mới.
-- ---------------------------------------------------------------------------
create or replace function public.guard_cash_pr_payment_method()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.payment_method::text = 'cash'
     and new.payment_method::text is distinct from 'cash'
     and (
       exists (
         select 1
           from public.cash_pr_idempotency cpi
          where cpi.payment_request_id = old.id
       )
       or old.cash_settlement_status is not null
     ) then
    raise exception 'cash_pr_method_locked: %', old.request_number
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

comment on function public.guard_cash_pr_payment_method() is
  'BEFORE UPDATE OF payment_method: từ chối đổi payment_method từ ''cash'' sang giá trị khác khi phiếu chi thuộc luồng Chi tiền mặt mới (có dòng public.cash_pr_idempotency hoặc cash_settlement_status is not null). Lỗi cash_pr_method_locked: <request_number>, errcode P0001.';

-- ---------------------------------------------------------------------------
-- 2. Trigger BEFORE UPDATE OF payment_method.
-- ---------------------------------------------------------------------------
drop trigger if exists trg_guard_cash_pr_payment_method on public.payment_requests;
create trigger trg_guard_cash_pr_payment_method
before update of payment_method on public.payment_requests
for each row
execute function public.guard_cash_pr_payment_method();

-- ---------------------------------------------------------------------------
-- 3. Không cho client gọi trực tiếp hàm trigger.
-- ---------------------------------------------------------------------------
revoke all on function public.guard_cash_pr_payment_method() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Behavioural checks. Every step catches the expected exception / state; a
-- wrong result raises SMOKE_RESULT FAIL <step> and aborts the transaction.
-- ---------------------------------------------------------------------------
do $$
declare
  v_owner uuid;
  v_idem_id uuid;
  v_idem_number text;
  v_expected text;
  v_errored boolean;
  v_sqlstate text;
  v_message text;
  v_b_note text := 'rpc_blocked';
  v_legacy_id uuid;
  v_legacy_temp boolean := false;
  v_bank_id uuid;
  v_method text;
begin
  -- (a) A real new-flow Cash phiếu (cash_pr_idempotency row + payment_method
  -- 'cash'): a direct switch to 'bank_transfer' must fail with the guard's
  -- P0001 message and the real request number.
  select pr.id, pr.request_number
    into v_idem_id, v_idem_number
    from public.payment_requests pr
    join public.cash_pr_idempotency cpi on cpi.payment_request_id = pr.id
   where pr.payment_method::text = 'cash'
   order by pr.request_number
   limit 1;

  if v_idem_id is null then
    raise exception 'SMOKE_RESULT FAIL a_no_cash_idempotency_candidate';
  end if;

  v_expected := 'cash_pr_method_locked: ' || v_idem_number;
  v_errored := false;
  v_sqlstate := null;
  v_message := null;
  begin
    update public.payment_requests
       set payment_method = 'bank_transfer'::public.payment_method_type
     where id = v_idem_id;
  exception when others then
    v_errored := true;
    get stacked diagnostics v_sqlstate = returned_sqlstate, v_message = message_text;
  end;

  if not v_errored then
    raise exception 'SMOKE_RESULT FAIL a_locked_cash_allowed: %', v_idem_number;
  end if;
  if v_sqlstate is distinct from 'P0001' then
    raise exception 'SMOKE_RESULT FAIL a_sqlstate: state=% message=%', v_sqlstate, v_message;
  end if;
  if v_message is distinct from v_expected then
    raise exception 'SMOKE_RESULT FAIL a_message: got=% expected=%', v_message, v_expected;
  end if;

  -- (b) The canonical approval RPC on the same phiếu with 'bank_transfer' must
  -- hit the same guard. Any other early error (e.g. material readiness) is
  -- recorded in the PASS string, not failed.
  select ur.user_id
    into v_owner
    from public.user_roles ur
   where ur.role = 'owner'
   order by ur.user_id
   limit 1;
  if v_owner is null then
    raise exception 'SMOKE_RESULT FAIL b_owner_missing';
  end if;
  perform set_config('request.jwt.claims', json_build_object('sub', v_owner, 'role', 'authenticated')::text, true);

  v_message := null;
  begin
    perform public.approve_payment_request_with_material_controller(v_idem_id, 'bank_transfer', v_owner);
  exception when others then
    get stacked diagnostics v_message = message_text;
  end;

  if v_message = v_expected then
    v_b_note := 'cash_lock_raised';
  elsif v_message is null then
    raise exception 'SMOKE_RESULT FAIL b_rpc_did_not_raise: %', v_idem_number;
  else
    v_b_note := 'b_other_error: ' || left(v_message, 200);
  end if;

  -- (c) Re-writing payment_method = 'cash' (unchanged) on that phiếu succeeds.
  begin
    update public.payment_requests
       set payment_method = 'cash'::public.payment_method_type
     where id = v_idem_id;
  exception when others then
    raise exception 'SMOKE_RESULT FAIL c_unchanged_cash_blocked: %', sqlerrm;
  end;
  select pr.payment_method::text into v_method from public.payment_requests pr where pr.id = v_idem_id;
  if v_method is distinct from 'cash' then
    raise exception 'SMOKE_RESULT FAIL c_unchanged_cash_wrong: %', v_method;
  end if;

  -- (d) A legacy cash phiếu (no cash_pr_idempotency row, cash_settlement_status
  -- null) can still switch to 'bank_transfer'. If no real one exists, temporarily
  -- switch an eligible bank_transfer phiếu to 'cash' inside this transaction.
  select pr.id
    into v_legacy_id
    from public.payment_requests pr
   where pr.payment_method::text = 'cash'
     and pr.cash_settlement_status is null
     and not exists (
       select 1 from public.cash_pr_idempotency cpi where cpi.payment_request_id = pr.id
     )
   order by pr.request_number
   limit 1;

  if v_legacy_id is null then
    select pr.id
      into v_legacy_id
      from public.payment_requests pr
     where pr.payment_method::text = 'bank_transfer'
       and pr.cash_settlement_status is null
       and not exists (
         select 1 from public.cash_pr_idempotency cpi where cpi.payment_request_id = pr.id
       )
     order by pr.request_number
     limit 1;
    if v_legacy_id is null then
      raise exception 'SMOKE_RESULT FAIL d_no_legacy_cash_candidate';
    end if;
    update public.payment_requests
       set payment_method = 'cash'::public.payment_method_type
     where id = v_legacy_id;
    v_legacy_temp := true;
  end if;

  begin
    update public.payment_requests
       set payment_method = 'bank_transfer'::public.payment_method_type
     where id = v_legacy_id;
  exception when others then
    raise exception 'SMOKE_RESULT FAIL d_legacy_cash_blocked: %', sqlerrm;
  end;
  select pr.payment_method::text into v_method from public.payment_requests pr where pr.id = v_legacy_id;
  if v_method is distinct from 'bank_transfer' then
    raise exception 'SMOKE_RESULT FAIL d_legacy_cash_wrong: %', v_method;
  end if;

  -- (e) A bank_transfer phiếu can still switch to 'cash'.
  select pr.id
    into v_bank_id
    from public.payment_requests pr
   where pr.payment_method::text = 'bank_transfer'
   order by pr.request_number
   limit 1;
  if v_bank_id is null then
    raise exception 'SMOKE_RESULT FAIL e_no_bank_candidate';
  end if;
  begin
    update public.payment_requests
       set payment_method = 'cash'::public.payment_method_type
     where id = v_bank_id;
  exception when others then
    raise exception 'SMOKE_RESULT FAIL e_bank_to_cash_blocked: %', sqlerrm;
  end;
  select pr.payment_method::text into v_method from public.payment_requests pr where pr.id = v_bank_id;
  if v_method is distinct from 'cash' then
    raise exception 'SMOKE_RESULT FAIL e_bank_to_cash_wrong: %', v_method;
  end if;

  raise exception 'SMOKE_RESULT PASS: cash_pr payment method locked (idem_pr=%, a_direct=blocked, b_rpc=%, c_unchanged_cash=ok, d_legacy_cash=bank_transfer, e_bank_to_cash=ok, legacy_temp=%)',
    v_idem_number, v_b_note, v_legacy_temp;
end;
$$;
