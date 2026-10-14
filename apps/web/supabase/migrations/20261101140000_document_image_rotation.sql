-- 2026-11-01 — Hướng xoay ảnh chứng từ (nền tảng phi giao diện).
--
-- Delivery-note photos are often stored sideways. This migration adds the
-- storage and the write path for a clockwise rotation per stored image path so
-- the viewer (built later by the Maestro) can show the photo upright and offer a
-- manual rotate button. The original image files are never modified; only this
-- table records the rotation.
--
-- Rules:
--   * the rotation is the clockwise degrees the stored image must be rotated so
--     the printed text reads upright left-to-right: 0, 90, 180 or 270;
--   * the OCR edge function (match-delivery-note) asks the AI for the rotation
--     and saves it with source 'ai' through public.set_document_image_rotation_ai;
--   * a warehouse / receipt editor saves a rotation with source 'manual' through
--     public.set_document_image_rotation;
--   * an AI answer never overwrites a manual one.
--
-- No insert/update/delete RLS policy is created: every write goes through the
-- security-definer functions below. Authenticated users may only read the
-- rotation, so the viewer can render the saved value.
--
-- This file runs in one transaction. It does not apply itself and never runs a
-- CLI push; the Maestro applies it. Its rollback-only smoke is
-- scripts/smoke_document_image_rotation.sql.

-- ===========================================================================
-- 1. Table
-- ===========================================================================

create table if not exists public.document_image_rotations (
  image_path text primary key check (btrim(image_path) <> ''),
  rotation smallint not null check (rotation in (0, 90, 180, 270)),
  source text not null check (source in ('ai', 'manual')),
  updated_by uuid null,
  updated_at timestamptz not null default now()
);

alter table public.document_image_rotations enable row level security;

-- The viewer only reads. Every write goes through the functions below.
drop policy if exists document_image_rotations_select on public.document_image_rotations;
create policy document_image_rotations_select
  on public.document_image_rotations
  for select
  to authenticated
  using (true);

grant select on table public.document_image_rotations to authenticated;
grant all on table public.document_image_rotations to service_role;

-- ===========================================================================
-- 2. Manual rotation: set_document_image_rotation(text, integer) -> jsonb
-- ===========================================================================

create or replace function public.set_document_image_rotation(
  p_image_path text,
  p_rotation integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor uuid := auth.uid();
  r integer;
begin
  if v_actor is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  r := ((p_rotation % 360) + 360) % 360;
  if r is null or r not in (0, 90, 180, 270) then
    raise exception 'invalid_rotation' using errcode = '22023';
  end if;

  if p_image_path is null or btrim(p_image_path) = '' then
    raise exception 'invalid_path' using errcode = '22023';
  end if;

  -- Same callers that may update goods_receipts (owner/staff/warehouse per the
  -- ops_write_goods_receipts RLS policy) plus the warehouse manager helper.
  if not (
    public.has_role(v_actor, 'owner')
    or public.has_role(v_actor, 'staff')
    or public.has_role(v_actor, 'warehouse')
    or public.can_manage_tan_tao_warehouse()
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  insert into public.document_image_rotations (image_path, rotation, source, updated_by, updated_at)
  values (p_image_path, r, 'manual', v_actor, now())
  on conflict (image_path) do update
    set rotation = excluded.rotation,
        source = 'manual',
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at;

  return jsonb_build_object(
    'image_path', p_image_path,
    'rotation', r,
    'source', 'manual'
  );
end;
$$;

revoke all on function public.set_document_image_rotation(text, integer) from public, anon;
grant execute on function public.set_document_image_rotation(text, integer) to authenticated, service_role;

-- ===========================================================================
-- 3. AI rotation: set_document_image_rotation_ai(text, integer) -> void
-- ===========================================================================

create or replace function public.set_document_image_rotation_ai(
  p_image_path text,
  p_rotation integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r integer;
begin
  if p_image_path is null or btrim(p_image_path) = '' then
    return;
  end if;

  r := ((p_rotation % 360) + 360) % 360;
  if r is null or r not in (0, 90, 180, 270) then
    return;
  end if;

  -- Insert a fresh AI answer, but never touch a row a human set manually.
  insert into public.document_image_rotations (image_path, rotation, source, updated_by, updated_at)
  values (p_image_path, r, 'ai', null, now())
  on conflict (image_path) do update
    set rotation = excluded.rotation,
        source = 'ai',
        updated_by = null,
        updated_at = excluded.updated_at
  where document_image_rotations.source = 'ai';
end;
$$;

-- The OCR edge function calls this with the service-role key only.
revoke all on function public.set_document_image_rotation_ai(text, integer) from public, anon, authenticated;
grant execute on function public.set_document_image_rotation_ai(text, integer) to service_role;
