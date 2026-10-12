-- Stock count sessions for Kho NVL Q7 and Kho Tân Tạo (data layer only).
--
-- One open count session per location. A session snapshots the current book
-- quantity of every tracked item / finished-goods SKU. Lines are saved while the
-- session is open and submitted once; submit replays every counted line through
-- the existing per-item stock-count RPC (record_q7_stock_count /
-- record_tan_tao_material_count / record_tan_tao_stock_count), which stay
-- unchanged and remain the only writers of the append-only ledgers.
--
-- No direct write to q7_inventory_movements / tan_tao_material_movements /
-- tan_tao_warehouse_movements / tan_tao_warehouse_documents happens here: the
-- existing guards and append-only triggers are left untouched.

-- ---------------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------------

create table if not exists public.stock_count_sessions (
  id uuid primary key default gen_random_uuid(),
  location text not null check (location in ('q7', 'tan_tao')),
  count_date date not null default ((now() at time zone 'Asia/Ho_Chi_Minh')::date),
  status text not null default 'open' check (status in ('open', 'submitted', 'cancelled')),
  opened_by uuid references auth.users(id) on delete set null,
  submitted_by uuid references auth.users(id) on delete set null,
  opened_at timestamptz not null default now(),
  submitted_at timestamptz,
  note text,
  summary jsonb,
  idempotency_key text unique
);

-- At most one open session per location.
create unique index if not exists stock_count_sessions_one_open_per_location_idx
  on public.stock_count_sessions(location)
  where status = 'open';

create index if not exists idx_stock_count_sessions_location_status_opened
  on public.stock_count_sessions(location, status, opened_at desc);

create table if not exists public.stock_count_lines (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.stock_count_sessions(id) on delete cascade,
  target_kind text not null check (target_kind in ('item', 'sku')),
  target_id uuid not null,
  target_code text not null,
  target_name text not null,
  unit text not null,
  book_qty numeric not null default 0,
  counted_qty numeric,
  note text,
  counted_by uuid references auth.users(id) on delete set null,
  counted_at timestamptz,
  result jsonb,
  constraint stock_count_lines_session_target_key unique (session_id, target_kind, target_id),
  constraint stock_count_lines_counted_qty_check check (
    counted_qty is null
    or (counted_qty >= 0 and counted_qty::text not in ('NaN', 'Infinity', '-Infinity'))
  )
);

create index if not exists idx_stock_count_lines_session on public.stock_count_lines(session_id);

-- ---------------------------------------------------------------------------
-- 2. RLS: authenticated may read a session for a warehouse it can view.
--    Every write stays behind the security-definer RPCs below.
-- ---------------------------------------------------------------------------

alter table public.stock_count_sessions enable row level security;
alter table public.stock_count_lines enable row level security;

revoke all on table public.stock_count_sessions from public, anon;
revoke all on table public.stock_count_lines from public, anon;
grant select on table public.stock_count_sessions to authenticated, service_role;
grant select on table public.stock_count_lines to authenticated, service_role;

drop policy if exists stock_count_sessions_select on public.stock_count_sessions;
create policy stock_count_sessions_select on public.stock_count_sessions
  for select to authenticated
  using (
    (location = 'q7' and public.q7_material_inventory_can_view((select auth.uid())))
    or (location = 'tan_tao' and public.can_view_tan_tao_warehouse())
  );

drop policy if exists stock_count_lines_select on public.stock_count_lines;
create policy stock_count_lines_select on public.stock_count_lines
  for select to authenticated
  using (
    exists (
      select 1
      from public.stock_count_sessions s
      where s.id = stock_count_lines.session_id
        and (
          (s.location = 'q7' and public.q7_material_inventory_can_view((select auth.uid())))
          or (s.location = 'tan_tao' and public.can_view_tan_tao_warehouse())
        )
    )
  );

-- ---------------------------------------------------------------------------
-- 3. Permission + serialization helpers
-- ---------------------------------------------------------------------------

-- Same reader gate as get_stock_ledger_overview / get_warehouse_game_snapshot.
create or replace function public.stock_count_can_view(p_location text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(auth.role(), '') = 'service_role'
    or (p_location = 'q7' and public.q7_material_inventory_can_view(auth.uid()))
    or (p_location = 'tan_tao' and public.can_view_tan_tao_warehouse());
$$;

-- Writers need the per-location edit permission of the existing stock RPCs.
create or replace function public.stock_count_can_edit(p_location text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(auth.role(), '') = 'service_role'
    or (p_location = 'q7' and public.q7_material_inventory_can_edit(auth.uid()))
    or (p_location = 'tan_tao' and public.can_manage_tan_tao_warehouse());
$$;

create or replace function public.stock_count_line_json(p_line public.stock_count_lines)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', p_line.id,
    'target_kind', p_line.target_kind,
    'target_id', p_line.target_id,
    'target_code', p_line.target_code,
    'target_name', p_line.target_name,
    'unit', p_line.unit,
    'item_class', case
      when p_line.target_kind = 'sku' then 'finished_goods'
      else coalesce(
        (select coalesce(kii.item_class, 'unclassified')
         from public.kitchen_inventory_items kii
         where kii.id = p_line.target_id),
        'unclassified')
    end,
    'book_qty', p_line.book_qty,
    'counted_qty', p_line.counted_qty,
    'note', p_line.note,
    'counted_by', p_line.counted_by,
    'counted_at', p_line.counted_at,
    'difference_qty',
      case when p_line.counted_qty is null then null
           else p_line.counted_qty - p_line.book_qty end,
    'result', p_line.result
  );
$$;

create or replace function public.stock_count_session_json(
  p_session public.stock_count_sessions,
  p_include_lines boolean default true
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', p_session.id,
    'location', p_session.location,
    'count_date', p_session.count_date,
    'status', p_session.status,
    'opened_by', p_session.opened_by,
    'submitted_by', p_session.submitted_by,
    'submitted_by_name', (
      select coalesce(nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''), u.email)
      from auth.users u
      where u.id = p_session.submitted_by
    ),
    'opened_at', p_session.opened_at,
    'submitted_at', p_session.submitted_at,
    'note', p_session.note,
    'summary', p_session.summary,
    'lines', case
      when p_include_lines then coalesce((
        select jsonb_agg(
                 public.stock_count_line_json(l)
                 order by l.target_name, l.target_kind, l.target_id
               )
        from public.stock_count_lines l
        where l.session_id = p_session.id
      ), '[]'::jsonb)
      else '[]'::jsonb
    end
  );
$$;

-- ---------------------------------------------------------------------------
-- 4. start_stock_count — open (or return) the single open session
-- ---------------------------------------------------------------------------

create or replace function public.start_stock_count(
  p_location text,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_session public.stock_count_sessions%rowtype;
  v_today date := (now() at time zone 'Asia/Ho_Chi_Minh')::date;
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
begin
  if p_location not in ('q7', 'tan_tao') then
    raise exception 'unsupported_location' using errcode = '22023';
  end if;
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.stock_count_can_edit(p_location) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  -- Retry of the exact same request returns its session, whatever its status.
  if v_key is not null then
    select * into v_session
    from public.stock_count_sessions
    where idempotency_key = v_key;
    if found then
      return public.stock_count_session_json(v_session, true);
    end if;
  end if;

  perform pg_advisory_xact_lock(hashtextextended('stock_count:' || p_location, 0));

  -- An open session already exists: reuse it instead of creating a second one.
  select * into v_session
  from public.stock_count_sessions
  where location = p_location and status = 'open'
  order by opened_at asc, id asc
  limit 1;
  if found then
    return public.stock_count_session_json(v_session, true);
  end if;

  insert into public.stock_count_sessions(
    location, count_date, status, opened_by, opened_at, idempotency_key
  ) values (
    p_location, v_today, 'open', v_actor, now(), v_key
  )
  returning * into v_session;

  if p_location = 'q7' then
    -- Same live-item source and on_hand formula as get_warehouse_game_snapshot('q7'):
    -- the Q7 ledger only ever receives pastry items, so the count mirrors that set.
    -- item_class = 'non_stock' is not a stock-tracked item and is left out.
    insert into public.stock_count_lines(
      session_id, target_kind, target_id, target_code, target_name, unit, book_qty
    )
    select v_session.id, 'item', x.id, x.item_code, x.name, x.unit, x.on_hand
    from (
      select kii.id,
             kii.item_code,
             kii.name,
             kii.unit,
             (
               coalesce(o.opening_qty, 0)
               + coalesce(mt.receipt_qty, 0)
               - coalesce(mt.usage_qty, 0)
               + coalesce(mt.adjustment_qty, 0)
             ) as on_hand
      from public.kitchen_inventory_items kii
      left join lateral (
        select o2.opening_qty, o2.effective_date
        from public.q7_inventory_openings o2
        where o2.kitchen_inventory_item_id = kii.id
          and o2.effective_date <= v_today
        order by o2.effective_date desc, o2.updated_at desc, o2.id desc
        limit 1
      ) o on true
      left join lateral (
        select coalesce(sum(m.quantity) filter (where m.movement_type in ('receipt', 'transfer_in')), 0) as receipt_qty,
               coalesce(sum(m.quantity) filter (where m.movement_type = 'production_usage'), 0) as usage_qty,
               coalesce(sum(m.quantity) filter (where m.movement_type = 'adjustment'), 0) as adjustment_qty
        from public.q7_inventory_movements m
        where m.kitchen_inventory_item_id = kii.id
          and m.movement_date <= v_today
          and m.movement_date >= coalesce(o.effective_date, '0001-01-01'::date)
      ) mt on true
      where kii.active = true
        and kii.merged_into_id is null
        and kii.pastry_q7 = true
        and coalesce(kii.item_class, 'unclassified') <> 'non_stock'
    ) x;
  else
    -- Tân Tạo shares the whole live NVL catalog; the on_hand formula matches
    -- get_warehouse_game_snapshot('tan_tao').
    insert into public.stock_count_lines(
      session_id, target_kind, target_id, target_code, target_name, unit, book_qty
    )
    select v_session.id, 'item', x.id, x.item_code, x.name, x.unit, x.on_hand
    from (
      select kii.id,
             kii.item_code,
             kii.name,
             kii.unit,
             coalesce((
               select sum(case m.movement_type
                            when 'receipt' then m.quantity
                            when 'opening' then m.quantity
                            when 'production_usage' then -m.quantity
                            when 'adjustment' then m.quantity
                            when 'transfer_out' then -m.quantity
                            else 0 end)
               from public.tan_tao_material_movements m
               where m.kitchen_inventory_item_id = kii.id
                 and m.movement_date <= v_today
             ), 0) as on_hand
      from public.kitchen_inventory_items kii
      where kii.active = true
        and kii.merged_into_id is null
        and coalesce(kii.item_class, 'unclassified') <> 'non_stock'
    ) x;

    -- Finished-goods SKUs from the get_tan_tao_warehouse_snapshot source: the four
    -- quantity-tracked SKUs of the Tân Tạo warehouse, with the same on_hand total.
    insert into public.stock_count_lines(
      session_id, target_kind, target_id, target_code, target_name, unit, book_qty
    )
    select v_session.id, 'sku', ps.id, ps.sku_code, ps.product_name, ps.unit,
           coalesce((
             select sum(m.quantity)
             from public.tan_tao_warehouse_movements m
             where m.sku_id = ps.id
               and m.location_code = 'warehouse_tan_tao'
           ), 0)
    from public.product_skus ps
    where upper(ps.sku_code) in ('BMQ-001', 'BMQ-002', 'PATE-500G', 'PATE-200G');
  end if;

  return public.stock_count_session_json(v_session, true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. save_stock_count_line — save / clear one counted line
-- ---------------------------------------------------------------------------

create or replace function public.save_stock_count_line(
  p_session_id uuid,
  p_line_id uuid,
  p_counted_qty numeric,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_session public.stock_count_sessions%rowtype;
  v_line public.stock_count_lines%rowtype;
begin
  select * into v_session
  from public.stock_count_sessions
  where id = p_session_id;
  if not found then raise exception 'stock_count_session_not_found' using errcode = 'P0002'; end if;

  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.stock_count_can_edit(v_session.location) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  if v_session.status <> 'open' then
    raise exception 'stock_count_not_open' using errcode = '22023';
  end if;
  if p_counted_qty is not null
     and (p_counted_qty < 0 or p_counted_qty::text in ('NaN', 'Infinity', '-Infinity')) then
    raise exception 'invalid_counted_qty' using errcode = '22023';
  end if;

  select * into v_line
  from public.stock_count_lines
  where id = p_line_id and session_id = p_session_id
  for update;
  if not found then raise exception 'stock_count_line_not_found' using errcode = 'P0002'; end if;

  update public.stock_count_lines
  set counted_qty = p_counted_qty,
      note = nullif(btrim(coalesce(p_note, '')), ''),
      counted_by = case when p_counted_qty is null then null else v_actor end,
      counted_at = case when p_counted_qty is null then null else now() end,
      result = null
  where id = v_line.id
  returning * into v_line;

  return public.stock_count_line_json(v_line);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. submit_stock_count — replay counted lines through the existing RPCs
-- ---------------------------------------------------------------------------

create or replace function public.submit_stock_count(
  p_session_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_session public.stock_count_sessions%rowtype;
  v_line record;
  v_key text;
  v_note text;
  v_result jsonb;
  v_counted integer := 0;
  v_skipped integer := 0;
  v_adjusted integer := 0;
  v_diff_count integer := 0;
  v_total_abs numeric := 0;
begin
  select * into v_session
  from public.stock_count_sessions
  where id = p_session_id
  for update;
  if not found then raise exception 'stock_count_session_not_found' using errcode = 'P0002'; end if;

  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.stock_count_can_edit(v_session.location) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  -- Already submitted: replay the stored summary, do not write again.
  if v_session.status = 'submitted' then
    return public.stock_count_session_json(v_session, true);
  end if;
  if v_session.status <> 'open' then
    raise exception 'stock_count_not_open' using errcode = '22023';
  end if;

  for v_line in
    select *
    from public.stock_count_lines
    where session_id = v_session.id
    order by target_name, target_kind, target_id
    for update
  loop
    if v_line.counted_qty is null then
      v_skipped := v_skipped + 1;
      update public.stock_count_lines
      set result = jsonb_build_object('status', 'skipped')
      where id = v_line.id;
      continue;
    end if;

    v_counted := v_counted + 1;
    v_key := 'stock-count:' || v_session.id::text || ':' || v_line.id::text;
    v_note := coalesce(
      nullif(btrim(coalesce(v_line.note, '')), ''),
      case when v_session.location = 'q7' then 'Kiểm kê NVL Q7' else 'Kiểm kê NVL Tân Tạo' end
    );

    if v_line.target_kind = 'sku' then
      v_result := public.record_tan_tao_stock_count(
        v_line.target_code, v_line.counted_qty, v_note, v_key
      );
    elsif v_session.location = 'q7' then
      v_result := public.record_q7_stock_count(
        v_line.target_id, v_line.counted_qty, v_session.count_date, v_note, v_key
      );
    else
      v_result := public.record_tan_tao_material_count(
        v_line.target_id, v_line.counted_qty, v_session.count_date, v_note, v_key
      );
    end if;

    update public.stock_count_lines
    set result = v_result
    where id = v_line.id;

    if v_line.counted_qty is distinct from v_line.book_qty then
      v_adjusted := v_adjusted + 1;
      v_diff_count := v_diff_count + 1;
      v_total_abs := v_total_abs + abs(v_line.counted_qty - v_line.book_qty);
    end if;
  end loop;

  update public.stock_count_sessions
  set status = 'submitted',
      submitted_by = v_actor,
      submitted_at = now(),
      summary = jsonb_build_object(
        'counted', v_counted,
        'skipped', v_skipped,
        'adjusted', v_adjusted,
        'total_abs_diff', v_total_abs,
        'lines_with_diff', v_diff_count
      )
  where id = v_session.id
  returning * into v_session;

  return public.stock_count_session_json(v_session, true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. cancel_stock_count — discard an open session
-- ---------------------------------------------------------------------------

create or replace function public.cancel_stock_count(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_session public.stock_count_sessions%rowtype;
begin
  select * into v_session
  from public.stock_count_sessions
  where id = p_session_id
  for update;
  if not found then raise exception 'stock_count_session_not_found' using errcode = 'P0002'; end if;

  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then raise exception 'actor_required' using errcode = '42501'; end if;
    if not public.stock_count_can_edit(v_session.location) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  if v_session.status <> 'open' then
    raise exception 'stock_count_not_open' using errcode = '22023';
  end if;

  update public.stock_count_sessions
  set status = 'cancelled'
  where id = v_session.id
  returning * into v_session;

  return public.stock_count_session_json(v_session, true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. get_stock_count_review — open session + recent history
-- ---------------------------------------------------------------------------

create or replace function public.get_stock_count_review(
  p_location text,
  p_limit integer default 20
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_open jsonb;
  v_history jsonb := '[]'::jsonb;
  v_limit integer := greatest(1, least(coalesce(p_limit, 20), 100));
begin
  if p_location not in ('q7', 'tan_tao') then
    raise exception 'unsupported_location' using errcode = '22023';
  end if;
  if not public.stock_count_can_view(p_location) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  select public.stock_count_session_json(s, true)
  into v_open
  from public.stock_count_sessions s
  where s.location = p_location and s.status = 'open'
  order by s.opened_at asc, s.id asc
  limit 1;

  select coalesce(jsonb_agg(
           public.stock_count_session_json(h, false)
           order by coalesce(h.submitted_at, h.opened_at) desc, h.id desc
         ), '[]'::jsonb)
  into v_history
  from (
    select *
    from public.stock_count_sessions s
    where s.location = p_location
      and s.status in ('submitted', 'cancelled')
    order by coalesce(s.submitted_at, s.opened_at) desc, s.id desc
    limit v_limit
  ) h;

  return jsonb_build_object(
    'open_session', v_open,
    'history', v_history,
    'cutover_date', public.stock_ledger_cutover_date(p_location),
    'can_edit', public.stock_count_can_edit(p_location)
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Grants
-- ---------------------------------------------------------------------------

revoke all on function public.stock_count_can_view(text) from public, anon;
revoke all on function public.stock_count_can_edit(text) from public, anon;
revoke all on function public.stock_count_line_json(public.stock_count_lines) from public, anon;
revoke all on function public.stock_count_session_json(public.stock_count_sessions, boolean) from public, anon;
revoke all on function public.start_stock_count(text, text) from public, anon;
revoke all on function public.save_stock_count_line(uuid, uuid, numeric, text) from public, anon;
revoke all on function public.submit_stock_count(uuid, text) from public, anon;
revoke all on function public.cancel_stock_count(uuid) from public, anon;
revoke all on function public.get_stock_count_review(text, integer) from public, anon;

grant execute on function public.stock_count_can_view(text) to authenticated, service_role;
grant execute on function public.stock_count_can_edit(text) to authenticated, service_role;
grant execute on function public.stock_count_line_json(public.stock_count_lines) to authenticated, service_role;
grant execute on function public.stock_count_session_json(public.stock_count_sessions, boolean) to authenticated, service_role;
grant execute on function public.start_stock_count(text, text) to authenticated, service_role;
grant execute on function public.save_stock_count_line(uuid, uuid, numeric, text) to authenticated, service_role;
grant execute on function public.submit_stock_count(uuid, text) to authenticated, service_role;
grant execute on function public.cancel_stock_count(uuid) to authenticated, service_role;
grant execute on function public.get_stock_count_review(text, integer) to authenticated, service_role;
