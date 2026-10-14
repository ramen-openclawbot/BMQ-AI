-- Rollback-only production smoke for migration
-- 20261101140000_document_image_rotation.sql.
--
-- Run as the DB owner / service role, as one file:
--   supabase db query --linked -f apps/web/scripts/smoke_document_image_rotation.sql
-- (from apps/web: supabase db query --linked -f scripts/smoke_document_image_rotation.sql).
--
-- The file opens one transaction and asserts:
--   (a) set_document_image_rotation_ai('__smoke__/a.jpg', 90) stores 90 / 'ai';
--   (b) after the row becomes source 'manual' / rotation 180, a later AI call
--       with 270 leaves it at 180 / 'manual' (AI never overwrites a manual one);
--   (c) inserting rotation 45 raises check_violation;
--   (d) the file prints SMOKE PASS and rolls everything back.
-- The original image files are never touched; only this table is written.

begin;

do $$
declare
  v_rotation integer;
  v_source text;
begin
  -- (a) A fresh AI answer is stored as source 'ai'.
  perform public.set_document_image_rotation_ai('__smoke__/a.jpg', 90);

  select rotation, source
    into v_rotation, v_source
  from public.document_image_rotations
  where image_path = '__smoke__/a.jpg';

  if v_rotation is distinct from 90 or v_source is distinct from 'ai' then
    raise exception 'SMOKE FAIL: AI insert expected 90/ai, got %/%', v_rotation, v_source;
  end if;

  -- (b) A manual rotation survives a later AI answer.
  update public.document_image_rotations
     set source = 'manual', rotation = 180, updated_at = now()
   where image_path = '__smoke__/a.jpg';

  perform public.set_document_image_rotation_ai('__smoke__/a.jpg', 270);

  select rotation, source
    into v_rotation, v_source
  from public.document_image_rotations
  where image_path = '__smoke__/a.jpg';

  if v_rotation is distinct from 180 or v_source is distinct from 'manual' then
    raise exception 'SMOKE FAIL: AI overwrote manual, got %/%', v_rotation, v_source;
  end if;

  -- (c) The check constraint refuses an unsupported angle.
  begin
    insert into public.document_image_rotations (image_path, rotation, source)
    values ('__smoke__/bad.jpg', 45, 'manual');
    raise exception 'SMOKE FAIL: rotation 45 was accepted';
  exception
    when check_violation then
      null;
  end;

  raise notice 'SMOKE PASS';
end $$;

rollback;
