-- Renaming "Chà bông bánh ngọt" to "Chà bông (BN)" asked to merge it into
-- "Chà bông (bánh mì VJ)" (owner 22/10): the name check used
-- normalize_stock_item_name, which drops a trailing "(...)" so both became
-- "cha bong". That normalizer is meant for supplier/invoice names ("BAO XỐP (kg)").
-- An item name is the whole name: compare without accents/case/extra spaces only,
-- the same key the Kho screen uses (searchKey).

create or replace function public.kho_item_name_key(p_name text)
returns text
language sql
immutable
set search_path to 'pg_catalog'
as $$
  select nullif(
    btrim(regexp_replace(
      translate(
        lower(coalesce(p_name, '')),
        'aáàảãạăắằẳẵặâấầẩẫậeéèẻẽẹêếềểễệiíìỉĩịoóòỏõọôốồổỗộơớờởỡợuúùủũụưứừửữựyýỳỷỹỵdđ',
        'aaaaaaaaaaaaaaaaaaeeeeeeeeeeeeiiiiiioooooooooooooooooouuuuuuuuuuuuyyyyyydd'
      ),
      '\s+', ' ', 'g'
    )),
    ''
  );
$$;

CREATE OR REPLACE FUNCTION public.kho_save_item(p_item_id uuid, p_name text, p_unit text, p_active boolean, p_unit_factor numeric, p_merge boolean, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_item public.kitchen_inventory_items%rowtype;
  v_other public.kitchen_inventory_items%rowtype;
  v_name text := btrim(coalesce(p_name, ''));
  v_unit text := btrim(coalesce(p_unit, ''));
  v_norm text;
  v_factor numeric;
  v_unit_factor numeric;
  v_unit_request uuid;
  v_unit_result jsonb;
  v_item_id uuid;
  v_target_active boolean;
  v_is_merge boolean := false;
  v_unit_changed boolean := false;
  v_cached jsonb;
  v_result jsonb;
begin
  if not public.kho_item_can_edit(v_actor) then
    raise exception 'insufficient_privilege' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'request_id_required' using errcode = '22023';
  end if;

  -- Replay is checked before any write; all validation stays below it.
  select r.result into v_cached
  from public.warehouse_game_requests r
  where r.request_id = p_request_id
    and r.action = 'kho_save_item';
  if found then
    return v_cached;
  end if;

  if length(v_name) < 2 or length(v_name) > 120 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;
  -- The shared catalog keeps one unit per kind (kg -> g, lít -> ml), exactly as
  -- change_stock_item_unit stores it; typing "kg" on a g item is no change.
  if v_unit <> '' then
    v_unit := coalesce(public.normalize_stock_unit(v_unit), v_unit);
  end if;

  select * into v_item
  from public.kitchen_inventory_items k
  where k.id = p_item_id;
  if not found then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;

  v_norm := public.kho_item_name_key(v_name);
  if v_norm is null then v_norm := lower(v_name); end if;

  -- The same normalized name rename_stock_item protects against.  An inactive
  -- duplicate is found too: that is exactly when p_merge is useful.
  -- Same name test as rename_stock_item (kho_item_name_key of the whole name;
  -- normalized_key also carries the unit, so it is not the name key).  An item
  -- that is switched off still owns its name: one name, one item.
  select * into v_other
  from public.kitchen_inventory_items k
  where k.id <> p_item_id
    and k.merged_into_id is null
    and public.kho_item_name_key(k.name) = v_norm
  order by coalesce(k.active, false) desc, k.created_at, k.id
  limit 1;

  v_is_merge := found;

  -- Validate both save paths before the first write.  A name collision uses the
  -- merge factor; no collision uses the item's unit change factor.
  if v_is_merge then
    if not coalesce(p_merge, false) then
      return jsonb_build_object(
        'status', 'name_taken',
        'other', jsonb_build_object(
          'id', v_other.id,
          'name', v_other.name,
          'unit', v_other.unit,
          'active', coalesce(v_other.active, false)
        )
      );
    end if;

    v_factor := public.q7_unit_factor(v_item.unit, v_other.unit);
    if v_factor is null or v_factor <= 0 then
      if lower(regexp_replace(coalesce(v_item.unit, ''), '\s+', '', 'g'))
         = lower(regexp_replace(coalesce(v_other.unit, ''), '\s+', '', 'g')) then
        v_factor := 1;
      else
        v_factor := p_unit_factor;
      end if;
    end if;

    if v_factor is null
       or v_factor <= 0
       or v_factor::text in ('NaN', 'Infinity', '-Infinity') then
      return jsonb_build_object(
        'status', 'unit_factor_needed',
        'from', v_item.unit,
        'to', v_other.unit
      );
    end if;
  else
    v_unit_changed :=
      lower(regexp_replace(v_unit, '\s+', '', 'g'))
      is distinct from lower(regexp_replace(coalesce(v_item.unit, ''), '\s+', '', 'g'));

    if v_unit_changed then
      v_unit_factor := public.q7_unit_factor(v_item.unit, v_unit);
      if v_unit_factor is null or v_unit_factor <= 0 then
        v_unit_factor := p_unit_factor;
      end if;
      if v_unit_factor is null
         or v_unit_factor <= 0
         or v_unit_factor::text in ('NaN', 'Infinity', '-Infinity') then
        return jsonb_build_object(
          'status', 'unit_factor_needed',
          'from', v_item.unit,
          'to', v_unit
        );
      end if;
    end if;
  end if;

  -- Every validation passed; writes start here.
  if v_is_merge then
    if coalesce(v_other.active, false) = false and coalesce(p_active, false) = true then
      perform public.reactivate_stock_item(v_other.id);
    end if;

    perform public.apply_stock_item_merge(p_item_id, v_other.id, round(v_factor, 6), null);

    v_result := jsonb_build_object(
      'status', 'merged',
      'into', jsonb_build_object(
        'id', v_other.id,
        'name', v_other.name,
        'unit', v_other.unit
      )
    );

    insert into public.warehouse_game_requests (request_id, action, item_id, result, created_by)
    values (p_request_id, 'kho_save_item', v_other.id, v_result, v_actor)
    on conflict (request_id) do nothing;

    return v_result;
  end if;

  v_item_id := p_item_id;
  v_target_active := coalesce(p_active, v_item.active);

  -- warehouse_game_requests is keyed by request_id alone, so every inner call
  -- gets its own derived id; the outer id stays free for the kho_save_item row.
  if v_name <> v_item.name then
    perform public.rename_stock_item(p_item_id, v_name, md5(p_request_id::text || ':rename')::uuid);
  end if;

  if v_unit_changed then
    -- A derived request id keeps the inner idempotency key separate from the
    -- outer save request.
    v_unit_request := md5(p_request_id::text || ':unit')::uuid;
    v_unit_result := public.change_stock_item_unit(
      p_item_id, v_unit, v_unit_factor, v_unit_request
    );
    v_item_id := coalesce(
      nullif(v_unit_result ->> 'item_id', '')::uuid,
      p_item_id
    );
  end if;

  if v_target_active is distinct from coalesce(v_item.active, false) then
    if v_target_active then
      perform public.reactivate_stock_item(v_item_id);
    else
      perform public.discontinue_stock_item(v_item_id, 'Tắt trong game kho', md5(p_request_id::text || ':power')::uuid);
    end if;
  end if;

  select * into v_item
  from public.kitchen_inventory_items k
  where k.id = v_item_id;

  v_result := jsonb_build_object(
    'status', 'saved',
    'item', jsonb_build_object(
      'id', v_item.id,
      'name', v_item.name,
      'unit', v_item.unit,
      'active', coalesce(v_item.active, false)
    )
  );

  insert into public.warehouse_game_requests (request_id, action, item_id, result, created_by)
  values (p_request_id, 'kho_save_item', v_item_id, v_result, v_actor)
  on conflict (request_id) do nothing;

  return v_result;
end;
$function$

;
CREATE OR REPLACE FUNCTION public.rename_stock_item(p_item_id uuid, p_new_name text, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_actor uuid := auth.uid();
  v_item public.kitchen_inventory_items%rowtype;
  v_name text := btrim(coalesce(p_new_name, ''));
  v_old_name text;
  v_norm text;
  v_cached jsonb;
  v_result jsonb;
begin
  -- Owner or Q7 stock editor only.
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not public.kho_item_can_edit(v_actor) then
      raise exception 'rename_forbidden' using errcode = '42501';
    end if;
  end if;

  if length(v_name) < 2 or length(v_name) > 120 then
    raise exception 'invalid_name' using errcode = '22023';
  end if;

  if p_request_id is not null then
    perform pg_advisory_xact_lock(hashtext('warehouse_game:' || p_request_id::text));
    select r.result into v_cached
    from public.warehouse_game_requests r
    where r.request_id = p_request_id
      and r.action = 'rename';
    if found then
      return v_cached;
    end if;
  end if;

  select * into v_item
  from public.kitchen_inventory_items
  where id = p_item_id
    and active = true
    and merged_into_id is null
  for update;
  if not found then
    raise exception 'item_not_found' using errcode = 'P0002';
  end if;

  v_old_name := v_item.name;
  v_norm := public.kho_item_name_key(v_name);
  if v_norm is null then v_norm := lower(v_name); end if;

  if exists (
    select 1
    from public.kitchen_inventory_items k
    where k.id <> p_item_id
      and k.active = true
      and k.merged_into_id is null
      and public.kho_item_name_key(k.name) = v_norm
  ) then
    raise exception 'item_name_duplicate' using errcode = '23505';
  end if;

  -- The item unit/name trigger also refuses a duplicate; surface its clear code.
  begin
    update public.kitchen_inventory_items
      set name = v_name,
          updated_at = now()
      where id = p_item_id;
  exception when unique_violation then
    raise exception 'item_name_duplicate' using errcode = '23505';
  end;

  insert into public.kitchen_inventory_item_audit_logs (
    item_id, action, old_values, new_values, changed_by
  ) values (
    p_item_id,
    'manually_edited',
    jsonb_build_object('name', v_old_name, 'reason', 'warehouse_game_rename'),
    jsonb_build_object('name', v_name, 'reason', 'warehouse_game_rename'),
    v_actor
  );

  v_result := jsonb_build_object(
    'item_id', p_item_id,
    'old_name', v_old_name,
    'new_name', v_name
  );

  if p_request_id is not null then
    insert into public.warehouse_game_requests (request_id, action, item_id, result, created_by)
    values (p_request_id, 'rename', p_item_id, v_result, v_actor)
    on conflict (request_id) do nothing;
  end if;

  return v_result;
end;
$function$

;

CREATE OR REPLACE FUNCTION public.kitchen_inventory_items_unit_guard()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare
  v_norm text;
  v_name text;
  v_skip_duplicate boolean;
begin
  -- Normalize the unit and refuse anything outside the standard table. A merged
  -- row keeps its historical unit because it is no longer part of the live
  -- catalog and apply_stock_item_merge may set it in the same statement.
  if new.unit is not null then
    v_norm := public.normalize_stock_unit(new.unit);
    if v_norm is null then
      raise exception 'unit_not_allowed' using errcode = '23514';
    end if;
    new.unit := v_norm;
  end if;

  -- Only an active, unmerged row can collide with another live item name. A
  -- merge, an undo of a merge and a row that is already retired never trip the
  -- guard; the catalog migration bypasses it explicitly.
  v_skip_duplicate := coalesce(current_setting('stock_catalog.unit_migration', true), '') = 'on'
    or coalesce(new.active, true) = false
    or new.merged_into_id is not null;
  if tg_op = 'UPDATE' and old.merged_into_id is not null then
    v_skip_duplicate := true;
  end if;

  if not v_skip_duplicate then
    v_name := public.kho_item_name_key(new.name);
    if v_name is not null and exists (
      select 1
      from public.kitchen_inventory_items k
      where k.id <> new.id
        and k.active = true
        and k.merged_into_id is null
        and public.kho_item_name_key(k.name) = v_name
    ) then
      raise exception 'item_name_duplicate' using errcode = '23505';
    end if;
  end if;

  return new;
end;
$function$
;
