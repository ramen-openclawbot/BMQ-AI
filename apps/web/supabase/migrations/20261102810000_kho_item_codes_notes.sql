-- 2026-10-23 — Danh mục kho: mã NVL/CCDC theo nhóm, đánh lại toàn bộ, ghi chú món.
--
-- * kitchen_item_code_history keeps every old code (renumber / class_change /
--   auto_assign) so old printed labels and old imports still resolve.
-- * kitchen_inventory_items.note is the short editor note (<= 500 characters).
-- * Codes are one series per class: raw_material -> NVL-###, everything else
--   that is stock catalogued (packaging_supply, non_stock) -> CCDC-###.  The
--   number grows past 999 without truncation.
-- * A BEFORE trigger assigns a code on insert (null / blank / legacy Q7 hash)
--   and when item_class moves the row to the other series.  A separate AFTER
--   trigger writes the history row, because an inserted row has no id to
--   reference until the statement completes.
-- * The one-time renumber block recomputes the same deterministic mapping every
--   time it runs; it only writes history for an actual code change.
-- * apply_kitchen_inventory_import_batch() is the only function that matches
--   existing items by item_code.  Its one behavioural change is to resolve an
--   incoming legacy code through kitchen_item_code_history.old_code before it
--   decides to insert, so a re-import does not create a duplicate.  The other
--   readers (get_stock_item_names_for_lines, get_stock_ledger_overview,
--   get_tan_tao_recipe, stock_count_*, kho_review_*) only output item_code;
--   they are untouched.

-- ===========================================================================
-- 1. Code history and item note
-- ===========================================================================

create table if not exists public.kitchen_item_code_history (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.kitchen_inventory_items(id) on delete cascade,
  old_code text not null,
  new_code text not null,
  reason text not null check (reason in ('renumber', 'class_change', 'auto_assign')),
  changed_by uuid,
  changed_at timestamptz default now()
);

create index if not exists kitchen_item_code_history_old_code_idx
  on public.kitchen_item_code_history (lower(old_code));

create index if not exists kitchen_item_code_history_item_changed_idx
  on public.kitchen_item_code_history (item_id, changed_at desc);

alter table public.kitchen_item_code_history enable row level security;

revoke all on public.kitchen_item_code_history from public, anon, authenticated;
grant all on public.kitchen_item_code_history to service_role;

alter table public.kitchen_inventory_items
  add column if not exists note text check (note is null or length(note) <= 500);

-- ===========================================================================
-- 2. Series prefix and next code
-- ===========================================================================

create or replace function public.kho_item_code_prefix(p_class text)
returns text
language sql
immutable
as $$
  select case when p_class = 'raw_material' then 'NVL' else 'CCDC' end;
$$;

revoke all on function public.kho_item_code_prefix(text) from public, anon, authenticated;
grant execute on function public.kho_item_code_prefix(text) to service_role;

create or replace function public.kho_next_item_code(p_class text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_prefix text := public.kho_item_code_prefix(p_class);
  v_next integer;
begin
  -- Serialise allocation per series so two inserts cannot get the same number.
  perform pg_advisory_xact_lock(hashtext('kho_item_code:' || v_prefix));

  select coalesce(max((regexp_match(kii.item_code, '^' || v_prefix || '-([0-9]+)$'))[1]::integer), 0) + 1
    into v_next
  from public.kitchen_inventory_items kii
  where kii.item_code ~ ('^' || v_prefix || '-[0-9]+$');

  return v_prefix || '-' || lpad(v_next::text, 3, '0');
end;
$$;

revoke all on function public.kho_next_item_code(text) from public, anon, authenticated;
grant execute on function public.kho_next_item_code(text) to service_role;

-- The old helper always generated an NVL code from a live row count.  It now
-- delegates to the shared allocator; the signature and grants stay the same.
create or replace function public.stock_unit_next_item_code()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return public.kho_next_item_code('raw_material');
end;
$$;

revoke all on function public.stock_unit_next_item_code() from public, anon, authenticated;
grant execute on function public.stock_unit_next_item_code() to service_role;

-- ===========================================================================
-- 3. Assignment + history triggers
-- ===========================================================================

create or replace function public.kho_assign_item_code()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old_code text;
  v_new_code text;
  v_reason text;
begin
  -- The one-time renumber below writes its own history and must not be
  -- re-entered by this trigger.
  if coalesce(current_setting('kho.renumbering', true), '') = 'on' then
    return new;
  end if;

  v_old_code := nullif(btrim(coalesce(new.item_code, '')), '');

  if tg_op = 'INSERT' then
    if v_old_code is null or v_old_code ~* '^Q7-[0-9A-F]{20}$' then
      v_new_code := public.kho_next_item_code(new.item_class);
      new.item_code := v_new_code;
      v_reason := 'auto_assign';
    end if;
  elsif tg_op = 'UPDATE' then
    if new.item_class is distinct from old.item_class
       and upper(split_part(coalesce(new.item_code, ''), '-', 1))
           is distinct from public.kho_item_code_prefix(new.item_class) then
      v_new_code := public.kho_next_item_code(new.item_class);
      new.item_code := v_new_code;
      v_reason := 'class_change';
    end if;
  end if;

  if v_reason is not null then
    -- AFTER row triggers run at end of statement, so a per-row key keeps a
    -- multi-row insert from losing its old codes.
    perform set_config(
      'kho.assign_' || md5(new.id::text),
      coalesce(v_old_code, '') || '|' || v_reason,
      true
    );
  end if;

  return new;
end;
$$;

revoke all on function public.kho_assign_item_code() from public, anon, authenticated;
grant execute on function public.kho_assign_item_code() to service_role;

create or replace function public.kho_log_item_code_history()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_key text := 'kho.assign_' || md5(new.id::text);
  v_pending text;
  v_old_code text;
  v_reason text;
begin
  v_pending := current_setting(v_key, true);
  if v_pending is null or v_pending = '' then
    return null;
  end if;

  perform set_config(v_key, '', true);
  v_old_code := nullif(split_part(v_pending, '|', 1), '');
  v_reason := nullif(split_part(v_pending, '|', 2), '');

  if v_reason is not null and new.item_code is distinct from v_old_code then
    insert into public.kitchen_item_code_history (
      item_id, old_code, new_code, reason, changed_by
    ) values (
      new.id, coalesce(v_old_code, ''), new.item_code, v_reason, auth.uid()
    );
  end if;

  return null;
end;
$$;

revoke all on function public.kho_log_item_code_history() from public, anon, authenticated;
grant execute on function public.kho_log_item_code_history() to service_role;

drop trigger if exists kitchen_inventory_items_assign_code
  on public.kitchen_inventory_items;
create trigger kitchen_inventory_items_assign_code
  before insert or update of item_class on public.kitchen_inventory_items
  for each row execute function public.kho_assign_item_code();

drop trigger if exists kitchen_inventory_items_log_code
  on public.kitchen_inventory_items;
create trigger kitchen_inventory_items_log_code
  after insert or update of item_class on public.kitchen_inventory_items
  for each row execute function public.kho_log_item_code_history();

-- ===========================================================================
-- 4. One-time renumber
-- ===========================================================================
-- Ordering: non-merged first, active first, then unaccented lower(name), then
-- id.  Every row is first moved to a TMP- code so the unique index cannot fire
-- while final codes are written.

create temporary table if not exists kho_item_code_renumber (
  id uuid primary key,
  old_code text not null,
  new_code text not null
);

truncate pg_temp.kho_item_code_renumber;

with numbered as (
  select
    kii.id,
    kii.item_code,
    public.kho_item_code_prefix(kii.item_class) as prefix,
    row_number() over (
      partition by public.kho_item_code_prefix(kii.item_class)
      order by (kii.merged_into_id is null) desc,
               coalesce(kii.active, false) desc,
               extensions.unaccent(lower(coalesce(kii.name, ''))),
               kii.id
    ) as rn
  from public.kitchen_inventory_items kii
)
insert into pg_temp.kho_item_code_renumber (id, old_code, new_code)
select id, item_code, prefix || '-' || lpad(rn::text, 3, '0')
from numbered;

do $$
declare
  v_row record;
begin
  perform set_config('kho.renumbering', 'on', true);

  update public.kitchen_inventory_items kii
     set item_code = 'TMP-' || kii.id::text
    from pg_temp.kho_item_code_renumber r
   where r.id = kii.id;

  for v_row in
    select id, old_code, new_code
    from pg_temp.kho_item_code_renumber
    order by new_code, id
  loop
    update public.kitchen_inventory_items
       set item_code = v_row.new_code
     where id = v_row.id;

    if v_row.old_code is distinct from v_row.new_code then
      insert into public.kitchen_item_code_history (
        item_id, old_code, new_code, reason
      ) values (
        v_row.id, v_row.old_code, v_row.new_code, 'renumber'
      );
    end if;
  end loop;

  perform set_config('kho.renumbering', 'off', true);
end;
$$;

drop table pg_temp.kho_item_code_renumber;

-- ===========================================================================
-- 5. Note RPC
-- ===========================================================================

create or replace function public.kho_set_item_note(
  p_item_id uuid,
  p_note text,
  p_request_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
  v_item_id uuid;
  v_saved_note text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not public.kho_item_can_edit(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  if p_request_id is not null then
    perform pg_advisory_xact_lock(hashtext('kho_item_note:' || p_request_id::text));
  end if;

  if v_note is not null and length(v_note) > 500 then
    raise exception 'invalid_note' using errcode = '22023';
  end if;

  update public.kitchen_inventory_items
     set note = v_note
   where id = p_item_id
   returning id, note into v_item_id, v_saved_note;

  if v_item_id is null then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;

  return jsonb_build_object('item_id', v_item_id, 'note', v_saved_note);
end;
$$;

revoke all on function public.kho_set_item_note(uuid, text, uuid) from public, anon;
grant execute on function public.kho_set_item_note(uuid, text, uuid) to authenticated, service_role;

-- ===========================================================================
-- 6. Find an item by current or historical code
-- ===========================================================================

create or replace function public.kho_find_item_by_code(p_code text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_code text := lower(btrim(coalesce(p_code, '')));
  v_item_id uuid;
  v_item_code text;
  v_name text;
begin
  if v_actor is null then
    raise exception 'actor_required' using errcode = '42501';
  end if;
  if not (
    public.q7_material_inventory_can_view(v_actor)
    or public.stock_count_can_view('tan_tao')
    or public.stock_count_can_view('q7')
    or public.kho_item_can_edit(v_actor)
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  if v_code = '' then
    return null;
  end if;

  select kii.id, kii.item_code, kii.name
    into v_item_id, v_item_code, v_name
  from public.kitchen_inventory_items kii
  where lower(kii.item_code) = v_code
  limit 1;

  if v_item_id is null then
    select kii.id, kii.item_code, kii.name
      into v_item_id, v_item_code, v_name
    from public.kitchen_item_code_history h
    join public.kitchen_inventory_items kii on kii.id = h.item_id
    where lower(h.old_code) = v_code
    order by h.changed_at desc, h.id desc
    limit 1;
  end if;

  if v_item_id is null then
    return null;
  end if;

  return jsonb_build_object(
    'item_id', v_item_id,
    'item_code', v_item_code,
    'name', v_name
  );
end;
$$;

revoke all on function public.kho_find_item_by_code(text) from public, anon;
grant execute on function public.kho_find_item_by_code(text) to authenticated, service_role;

-- ===========================================================================
-- 7. Import batch resolves a historical code before inserting
-- ===========================================================================
-- Only apply_kitchen_inventory_import_batch() matches existing rows by
-- item_code.  Its latest body is copied below; the only behavioural change is
-- the history lookup in the existing-item SELECT (and the matching guard that
-- keeps the old code from being written back as the current code).  The code
-- series counters in the insert branch are left as they were.

create or replace function public.apply_kitchen_inventory_import_batch(p_batch_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  source_row public.kitchen_inventory_import_rows%rowtype;
  existing_item public.kitchen_inventory_items%rowtype;
  applied_count integer := 0;
  skipped_count integer := 0;
  failed_count integer := 0;
  final_status text;
  batch_status text;
  batch_actor_id uuid;
  actor_id uuid;
  ingredient_counter integer;
  tool_counter integer;
  generated_code text;
  item_id uuid;
  old_values jsonb;
  new_values jsonb;
  qty numeric;
  movement_kind text;
  stable_movement_source_key text;
  effective_normalized_key text;
  existing_movement public.kitchen_inventory_movements%rowtype;
  movement_id uuid;
  old_movement_values jsonb;
  new_movement_values jsonb;
begin
  if coalesce(auth.role(), '') <> 'service_role'
    and not exists (
      select 1
      from public.user_roles ur
      where ur.user_id = auth.uid()
        and ur.role = 'owner'
    ) then
    raise exception 'Not allowed to apply kitchen inventory import batch' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext('kitchen_inventory_import_apply'));

  select status, created_by into batch_status, batch_actor_id
  from public.kitchen_inventory_import_batches
  where id = p_batch_id
  for update;

  if not found then
    raise exception 'Kitchen inventory import batch % not found', p_batch_id using errcode = 'P0002';
  end if;

  if batch_status = 'applied' then
    raise exception 'Kitchen inventory import batch % is already applied', p_batch_id using errcode = 'P0001';
  end if;

  actor_id := coalesce(auth.uid(), batch_actor_id);
  if actor_id is null then
    raise exception 'Kitchen inventory import batch % is missing created_by actor for audit attribution', p_batch_id
      using errcode = '23502';
  end if;

  select count(*) filter (where item_type = 'ingredient'),
         count(*) filter (where item_type = 'tool_supply')
    into ingredient_counter, tool_counter
  from public.kitchen_inventory_items;

  for source_row in
    select *
    from public.kitchen_inventory_import_rows
    where batch_id = p_batch_id
    order by source_row_number
  loop
    if source_row.import_status = 'applied' then
      skipped_count := skipped_count + 1;
      continue;
    end if;

    if source_row.approval_decision <> 'APPROVE' or jsonb_array_length(source_row.issue_flags) > 0 then
      update public.kitchen_inventory_import_rows
         set import_status = case when source_row.approval_decision = 'APPROVE' then 'failed' else 'skipped' end
       where id = source_row.id;
      if source_row.approval_decision = 'APPROVE' then
        failed_count := failed_count + 1;
      else
        skipped_count := skipped_count + 1;
      end if;
      continue;
    end if;

    -- A re-import may still carry a code printed before the one-time renumber.
    -- Resolve that historical code first so the row is matched, not inserted a
    -- second time.
    select * into existing_item
    from public.kitchen_inventory_items
    where (source_row.source_item_code is not null and item_code = source_row.source_item_code)
       or normalized_key = source_row.source_normalized_key
       or id = (
            select h.item_id
            from public.kitchen_item_code_history h
            where source_row.source_item_code is not null
              and lower(h.old_code) = lower(btrim(source_row.source_item_code))
            order by h.changed_at desc, h.id desc
            limit 1
          )
    order by case
               when item_code = source_row.source_item_code then 0
               when id = (
                 select h.item_id
                 from public.kitchen_item_code_history h
                 where source_row.source_item_code is not null
                   and lower(h.old_code) = lower(btrim(source_row.source_item_code))
                 order by h.changed_at desc, h.id desc
                 limit 1
               ) then 1
               else 2
             end
    limit 1;

    if found and exists (
      select 1
      from public.kitchen_inventory_monthly_closings c
      where c.period_month = coalesce(source_row.source_month, date_trunc('month', current_date)::date)
        and c.item_id = existing_item.id
        and c.status = 'closed'
        and (
          source_row.source_opening_qty is not null or
          source_row.source_purchase_qty is not null or
          source_row.source_usage_qty is not null or
          source_row.source_ending_qty is not null
        )
    ) then
      update public.kitchen_inventory_import_rows
         set canonical_item_id = existing_item.id,
             import_status = 'failed'
       where id = source_row.id;
      failed_count := failed_count + 1;
      continue;
    end if;

    if found then
      generated_code := case
        when source_row.source_item_code is not null
          and length(trim(source_row.source_item_code)) > 0
          and not exists (
            select 1
            from public.kitchen_item_code_history h
            where lower(h.old_code) = lower(trim(source_row.source_item_code))
          )
          and not exists (
            select 1
            from public.kitchen_inventory_items dup
            where dup.item_code = trim(source_row.source_item_code)
              and dup.id <> existing_item.id
          ) then trim(source_row.source_item_code)
        else existing_item.item_code
      end;
      old_values := to_jsonb(existing_item);
      effective_normalized_key := case
        when exists (
          select 1
          from public.kitchen_inventory_items dup
          where dup.normalized_key = source_row.source_normalized_key
            and dup.id <> existing_item.id
        ) then existing_item.normalized_key
        else source_row.source_normalized_key
      end;
       update public.kitchen_inventory_items
         set item_code = generated_code,
             normalized_key = effective_normalized_key,
             item_type = source_row.source_item_type,
             name = source_row.source_item_name,
             unit = coalesce(nullif(source_row.source_unit, ''), existing_item.unit),
             standard_unit_cost = coalesce(source_row.source_standard_unit_cost, 0),
             active = true,
             trusted_source_row_id = source_row.id,
             trusted_source_batch_id = p_batch_id,
             source_hash = source_row.source_hash
       where id = existing_item.id
       returning id into item_id;
    else
      if source_row.source_item_code is not null and length(trim(source_row.source_item_code)) > 0 then
        generated_code := trim(source_row.source_item_code);
      elsif source_row.source_item_type = 'tool_supply' then
        loop
          tool_counter := tool_counter + 1;
          generated_code := 'CCDC-' || lpad(tool_counter::text, 3, '0');
          exit when not exists (
            select 1 from public.kitchen_inventory_items i where i.item_code = generated_code
          );
        end loop;
      else
        loop
          ingredient_counter := ingredient_counter + 1;
          generated_code := 'NVL-' || lpad(ingredient_counter::text, 3, '0');
          exit when not exists (
            select 1 from public.kitchen_inventory_items i where i.item_code = generated_code
          );
        end loop;
      end if;
      old_values := null;
      effective_normalized_key := case
        when exists (
          select 1
          from public.kitchen_inventory_items dup
          where dup.normalized_key = source_row.source_normalized_key
        ) then source_row.source_normalized_key || ':' || lower(generated_code)
        else source_row.source_normalized_key
      end;
      insert into public.kitchen_inventory_items (
        item_code,
        normalized_key,
        item_type,
        name,
        unit,
        standard_unit_cost,
        active,
        trusted_source_row_id,
        trusted_source_batch_id,
        source_hash
      ) values (
        generated_code,
        effective_normalized_key,
        source_row.source_item_type,
        source_row.source_item_name,
        coalesce(source_row.source_unit, ''),
        coalesce(source_row.source_standard_unit_cost, 0),
        true,
        source_row.id,
        p_batch_id,
        source_row.source_hash
      ) returning id into item_id;
    end if;

    select to_jsonb(i) into new_values from public.kitchen_inventory_items i where i.id = item_id;

    insert into public.kitchen_inventory_item_audit_logs (
      item_id,
      action,
      old_values,
      new_values,
      source_batch_id,
      changed_by
    ) values (
      item_id,
      case when old_values is null then 'created' else 'overwritten' end,
      old_values,
      new_values,
      p_batch_id,
      actor_id
    );

    stable_movement_source_key := coalesce(nullif(source_row.source_item_code, ''), source_row.source_normalized_key)
      || ':' || coalesce(source_row.source_month, date_trunc('month', current_date)::date)::text;

    foreach movement_kind in array array['opening', 'purchase', 'usage', 'stock_count'] loop
      qty := case movement_kind
        when 'opening' then source_row.source_opening_qty
        when 'purchase' then source_row.source_purchase_qty
        when 'usage' then source_row.source_usage_qty
        when 'stock_count' then source_row.source_ending_qty
      end;

      if qty is not null then
        if exists (
          select 1
          from public.kitchen_inventory_monthly_closings c
          where c.period_month = coalesce(source_row.source_month, date_trunc('month', current_date)::date)
            and c.item_id = item_id
            and c.status = 'closed'
        ) then
          continue;
        end if;

        select * into existing_movement
        from public.kitchen_inventory_movements
        where source = 'import_t3_t4'
          and source_ref_key = stable_movement_source_key
          and movement_type = movement_kind;
        old_movement_values := case when found then to_jsonb(existing_movement) else null end;

        insert into public.kitchen_inventory_movements (
          movement_date,
          period_month,
          item_id,
          movement_type,
          quantity,
          unit,
          unit_cost,
          amount,
          source,
          source_ref_id,
          source_ref_key,
          note
        ) values (
          coalesce(source_row.source_month, current_date),
          coalesce(source_row.source_month, date_trunc('month', current_date)::date),
          item_id,
          movement_kind,
          qty,
          coalesce(source_row.source_unit, ''),
          coalesce(source_row.source_standard_unit_cost, 0),
          qty * coalesce(source_row.source_standard_unit_cost, 0),
          'import_t3_t4',
          source_row.id,
          stable_movement_source_key,
          'Imported from reviewed accounting workbook'
        )
        on conflict (source, source_ref_key, movement_type)
        where source = 'import_t3_t4' and source_ref_key is not null
        do update
          set item_id = excluded.item_id,
              movement_date = excluded.movement_date,
              period_month = excluded.period_month,
              quantity = excluded.quantity,
              unit = excluded.unit,
              unit_cost = excluded.unit_cost,
              amount = excluded.amount,
              source_ref_id = excluded.source_ref_id,
              note = excluded.note
        returning id into movement_id;

        if old_movement_values is not null then
          select to_jsonb(m) into new_movement_values
          from public.kitchen_inventory_movements m
          where m.id = movement_id;

          if old_movement_values is distinct from new_movement_values then
            insert into public.kitchen_inventory_movement_audit_logs (
              movement_id,
              action,
              old_values,
              new_values,
              source_batch_id,
              changed_by
            ) values (
              movement_id,
              'overwritten',
              old_movement_values,
              new_movement_values,
              p_batch_id,
              actor_id
            );
          end if;
        end if;
      end if;
    end loop;

    update public.kitchen_inventory_import_rows
       set canonical_item_id = item_id,
           import_status = 'applied'
     where id = source_row.id;
    applied_count := applied_count + 1;
  end loop;

  final_status := case when failed_count > 0 then 'partial' else 'applied' end;

  update public.kitchen_inventory_import_batches
     set status = final_status,
         applied_by = actor_id,
         applied_at = now()
   where id = p_batch_id;

  return jsonb_build_object(
    'batch_id', p_batch_id,
    'status', final_status,
    'applied', applied_count,
    'skipped', skipped_count,
    'failed', failed_count
  );
end;
$$;

revoke all on function public.apply_kitchen_inventory_import_batch(uuid)
  from public, anon, authenticated;
grant execute on function public.apply_kitchen_inventory_import_batch(uuid)
  to service_role;

-- ===========================================================================
-- 8. kho_get_items adds note and old_codes
-- ===========================================================================
-- Body copied from 20261102770000_kho_review_evidence_links.sql.  doc_lines
-- still counts active evidence links plus aliases; the only additions are
-- note and the five newest distinct historical codes.

create or replace function public.kho_get_items()
 returns jsonb
 language plpgsql
 stable security definer
 set search_path to 'public', 'pg_temp'
as $function$
declare
  v_actor uuid := auth.uid();
  v_tt jsonb;
  v_q7 jsonb;
  v_items jsonb;
begin
  if v_actor is null then
    raise exception 'actor_required' using errcode = '42501';
  end if;
  if not (
    public.q7_material_inventory_can_view(v_actor)
    or public.stock_count_can_view('tan_tao')
    or public.stock_count_can_view('q7')
    or public.kho_item_can_edit(v_actor)
  ) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;

  -- Exactly two ledger calls, once for the whole list.
  v_tt := public.get_stock_ledger_overview('tan_tao', current_date);
  v_q7 := public.get_stock_ledger_overview('q7', current_date);

  with tt as (
    select coalesce(jsonb_object_agg(e ->> 'item_id', e), '{}'::jsonb) as map
    from jsonb_array_elements(coalesce(v_tt -> 'materials', '[]'::jsonb)) e
    where nullif(e ->> 'item_id', '') is not null
  ),
  q7 as (
    select coalesce(jsonb_object_agg(e ->> 'item_id', e), '{}'::jsonb) as map
    from jsonb_array_elements(coalesce(v_q7 -> 'items', '[]'::jsonb)) e
    where nullif(e ->> 'item_id', '') is not null
  ),
  pending as (
    select coalesce(jsonb_object_agg(k, v), '{}'::jsonb) as map
    from (
      select distinct on (s.location, l.target_id)
        s.location || ':' || l.target_id::text as k,
        l.counted_qty as v
      from public.stock_count_lines l
      join public.stock_count_sessions s on s.id = l.session_id
      where s.status = 'open'
        and l.target_kind = 'item'
        and s.location in ('tan_tao', 'q7')
      order by s.location, l.target_id, s.opened_at desc, l.id desc
    ) x
  ),
  docs as (
    select coalesce(jsonb_object_agg(item_id, n), '{}'::jsonb) as map
    from (
      select u.item_id,
             count(distinct u.receipt_item_id)::integer as n
      from (
        select a.kitchen_inventory_item_id as item_id,
               gri.id as receipt_item_id
        from public.stock_material_aliases a
        join public.goods_receipts gr
          on gr.supplier_id is not distinct from a.supplier_id
        left join public.suppliers s on s.id = gr.supplier_id
        join public.goods_receipt_items gri on gri.goods_receipt_id = gr.id
        where a.kitchen_inventory_item_id is not null
          and a.location in ('tan_tao', 'q7')
          and a.location = coalesce(gr.receiving_location, s.default_receiving_location, 'tan_tao')
          and gr.status in ('confirmed', 'received')
          and coalesce(s.stock_exempt, false) = false
          and public.stock_line_auto_non_stock(
                coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
              ) is null
          and a.normalized_name = public.normalize_stock_item_name(
                coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
              )
        union
        select e.item_id, gri.id as receipt_item_id
        from public.kho_review_evidence_links e
        join public.goods_receipt_items gri on gri.id = e.receipt_item_id
        join public.goods_receipts gr on gr.id = gri.goods_receipt_id
        where e.removed_at is null
          and gr.status in ('confirmed', 'received')
      ) u
      group by u.item_id
    ) x
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', kii.id,
           'item_code', kii.item_code,
           'name', kii.name,
           'unit', kii.unit,
           'active', coalesce(kii.active, false),
           'item_class', kii.item_class,
           'in_q7', coalesce(kii.pastry_q7, false),
           'in_tan_tao', coalesce(kii.in_tan_tao, not coalesce(kii.pastry_q7, false)),
           'note', kii.note,
           'old_codes', coalesce((
             select jsonb_agg(x.old_code order by x.last_changed_at desc, x.old_code)
             from (
               select h.old_code, max(h.changed_at) as last_changed_at
               from public.kitchen_item_code_history h
               where h.item_id = kii.id
                 and h.old_code <> ''
               group by h.old_code
               order by max(h.changed_at) desc, h.old_code
               limit 5
             ) x
           ), '[]'::jsonb),
           'qty', jsonb_build_object(
             'tan_tao', case
               when tt.map ? kii.id::text
                 then (tt.map -> kii.id::text ->> 'current_qty')::numeric
               else null
             end,
             'q7', case
               when q7.map ? kii.id::text
                 then (q7.map -> kii.id::text ->> 'current_qty')::numeric
               else null
             end
           ),
           'last_count_date', jsonb_build_object(
             'tan_tao', tt.map -> kii.id::text ->> 'last_count_date',
             'q7', q7.map -> kii.id::text ->> 'last_count_date'
           ),
           'pending_count', jsonb_build_object(
             'tan_tao', pending.map -> ('tan_tao:' || kii.id::text),
             'q7', pending.map -> ('q7:' || kii.id::text)
           ),
           'doc_lines', coalesce((docs.map ->> kii.id::text)::integer, 0)
         ) order by kii.name, kii.id), '[]'::jsonb)
  into v_items
  from public.kitchen_inventory_items kii
  cross join tt
  cross join q7
  cross join pending
  cross join docs
  where kii.active = true
     or exists (
       select 1
       from public.stock_item_discontinuations d
       where d.item_id = kii.id
     );

  return jsonb_build_object(
    'can_edit', public.kho_item_can_edit(v_actor),
    'can_count', jsonb_build_object(
      'tan_tao', public.stock_count_can_edit('tan_tao'),
      'q7', public.stock_count_can_edit('q7')
    ),
    'items', v_items
  );
end;
$function$
;

revoke all on function public.kho_get_items() from public, anon;
grant execute on function public.kho_get_items() to authenticated, service_role;
