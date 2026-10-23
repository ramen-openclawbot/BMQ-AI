-- 2026-10-23 — Hồ sơ ATTP: create a manufacturer by name from the certificate form.
--
-- food_manufacturers is RPC-write-only (20261102850000).  The certificate vault
-- needs to attach a certificate to a manufacturer that has not appeared on a
-- receipt yet, so this adds one idempotent upsert by normalized name, gated like
-- the certificate writes (kho editors).

create or replace function public.food_manufacturer_upsert(p_name text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_name text := nullif(btrim(coalesce(p_name, '')), '');
  v_row public.food_manufacturers%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null or not public.kho_item_can_edit(v_actor) then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;
  if v_name is null or char_length(v_name) > 160 then
    raise exception 'invalid_manufacturer_name' using errcode = '22023';
  end if;

  insert into public.food_manufacturers (name, created_by)
  values (v_name, v_actor)
  on conflict (normalized_name) do update set updated_at = public.food_manufacturers.updated_at
  returning * into v_row;

  return jsonb_build_object('id', v_row.id, 'name', v_row.name);
end;
$$;

revoke all on function public.food_manufacturer_upsert(text) from public, anon;
grant execute on function public.food_manufacturer_upsert(text) to authenticated, service_role;
