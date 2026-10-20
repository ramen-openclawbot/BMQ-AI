-- 2026-10-20: rollback-only smoke for 20261102400000_document_unit_factors.sql.
--
-- The migration body is copied verbatim below (no \i) because this file is run
-- with `npx supabase db query --linked -f` before the Maestro applies it.
-- Everything runs in one transaction and ends with ROLLBACK, so the live
-- database keeps no conversion, question, mission, trigger or document change.
begin;

-- 2026-10-20: document units get the factor the warehouse game already chose.
--
-- Document lines whose supplier spelling resolves to a canonical material but
-- whose unit differs from that material's default unit stay unlinked.  This
-- migration closes that gap without guessing:
--   A. normalize_document_unit() fixes only the obvious misreads (ky/kg, hop,
--      b bao, kilogram, the "(pack)" suffix);
--   B. document_unit_factor_candidates() derives every candidate from the
--      confirmed stock labels (pack_label + conversion_factor) and, when a
--      label does not name the document unit, from the existing standard
--      conversion chain (document unit -> stock item unit -> material unit);
--   C. document_unit_mismatch_pairs_internal() finds the unlinked document
--      lines whose unit differs from the resolved material unit;
--   D. seed_document_unit_conversions() writes a conversion only when every
--      matching label agrees on one factor, then links through the existing
--      link_documents_from_stock_aliases() controller;
--   E. document_unit_questions + get/answer RPCs keep every disagreement for
--      the owner, with candidate values and real document image paths;
--   F. a new AFTER trigger keeps the material conversion in sync whenever the
--      game writes or edits a stock label factor, and reopens a question when
--      an owner-approved conversion disagrees;
--   G. mission_evaluate() gains the document_unit_questions_done rule and one
--      owner mission is seeded for batch 2026-10-20.
--
-- No document product_name / quantity / unit_price / line_total is written, no
-- document line is deleted, and the old alias trigger is left untouched.
-- Additive and idempotent; the Maestro applies it.

-- ===========================================================================
-- A. Unit normalization + the item-unit -> material-unit step
-- ===========================================================================

-- Immutable mirror of src/lib/document-unit-questions.ts normalizeDocumentUnit.
-- Only the known misreads are corrected; nothing else is guessed.
create or replace function public.normalize_document_unit(p text)
returns text
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  v text;
begin
  v := lower(btrim(coalesce(p, '')));
  v := regexp_replace(v, '\s+', ' ', 'g');

  -- The whole spelling is "(kg)".
  v := regexp_replace(v, '^\s*\(\s*kg\s*\)\s*$', 'kg');
  -- A trailing package marker never belongs to the unit itself.
  v := regexp_replace(v, '\s*\(\s*pack\s*\)\s*$', '', 'i');
  -- Other parenthetical annotations are dropped as well.
  v := regexp_replace(v, '\([^()]*\)', '', 'g');
  v := regexp_replace(v, '[()]', '', 'g');
  v := btrim(regexp_replace(v, '\s+', ' ', 'g'));

  return nullif(
    case v
      when 'ky' then 'kg'
      when 'ký' then 'kg'
      when 'kilogram' then 'kg'
      when 'b bao' then 'bao'
      when 'hop' then 'hộp'
      when 'hôp' then 'hộp'
      when 'hộp' then 'hộp'
      else v
    end,
    ''
  );
end;
$$;

comment on function public.normalize_document_unit(text) is
  'Lowercase/trim/collapse a document unit, drop (pack)/parentheses and fix only the known misreads (ky, hop, b bao, kilogram, (kg)).';

revoke all on function public.normalize_document_unit(text) from public, anon;
grant execute on function public.normalize_document_unit(text) to service_role;

-- How many material default units one stock item unit is.  Same unit first,
-- then the approved standard conversion, then the shared weight/volume table.
create or replace function public.document_unit_to_material_factor(
  p_material_id uuid,
  p_from_unit text
)
returns numeric
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_material public.sku_cogs_materials%rowtype;
  v_from text := lower(btrim(coalesce(p_from_unit, '')));
  v_to text;
  v_factor numeric;
begin
  if v_from = '' then
    return null;
  end if;

  select * into v_material
  from public.sku_cogs_materials m
  where m.id = p_material_id
    and m.active = true;
  if not found then
    return null;
  end if;

  v_to := lower(btrim(coalesce(v_material.default_unit, '')));
  if v_to = '' then
    return null;
  end if;
  if v_from = v_to then
    return 1;
  end if;

  select c.factor into v_factor
  from public.material_unit_conversions c
  where c.material_id = p_material_id
    and c.active = true
    and c.approved = true
    and lower(btrim(c.from_unit)) = v_from
    and lower(btrim(c.to_unit)) = v_to
    and c.effective_from <= current_date
    and (c.effective_to is null or c.effective_to >= current_date)
  order by c.effective_from desc, c.created_at desc, c.id
  limit 1;

  if v_factor is not null and v_factor > 0 then
    return round(v_factor, 6);
  end if;

  v_factor := public.q7_unit_factor(p_from_unit, v_material.default_unit);
  if v_factor is not null and v_factor > 0 then
    return round(v_factor, 6);
  end if;

  return null;
end;
$$;

revoke all on function public.document_unit_to_material_factor(uuid, text) from public, anon;
grant execute on function public.document_unit_to_material_factor(uuid, text) to service_role;

-- ===========================================================================
-- B. Candidate factors for one (material, document unit, label)
-- ===========================================================================

create or replace function public.document_unit_factor_candidates(
  p_material_id uuid,
  p_doc_unit text,
  p_supplier_id uuid,
  p_normalized_name text
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_doc text := public.normalize_document_unit(p_doc_unit);
  v_raw text := lower(btrim(coalesce(p_doc_unit, '')));
  v_material public.sku_cogs_materials%rowtype;
  v_out jsonb := '[]'::jsonb;
  v_factor numeric;
  v_step numeric;
  v_source text;
  v_sources jsonb;
  v_seen numeric[] := '{}'::numeric[];
  v_approved numeric;
  r record;
begin
  if v_doc is null then
    return '[]'::jsonb;
  end if;

  select * into v_material
  from public.sku_cogs_materials m
  where m.id = p_material_id
    and m.active = true;
  if not found then
    return '[]'::jsonb;
  end if;

  for r in
    select
      a.id,
      a.conversion_factor,
      a.pack_label,
      kii.unit as item_unit,
      (a.pack_label is not null
       and public.normalize_document_unit(a.pack_label) = v_doc) as pack_match
    from public.stock_material_aliases a
    join public.kitchen_inventory_items kii on kii.id = a.kitchen_inventory_item_id
    where a.line_class = 'stock'
      and a.kitchen_inventory_item_id is not null
      and kii.canonical_material_id = p_material_id
      and (p_normalized_name is null or a.normalized_name = p_normalized_name)
    order by
      (a.pack_label is not null and public.normalize_document_unit(a.pack_label) = v_doc) desc,
      (a.supplier_id is not distinct from p_supplier_id) desc,
      a.id
  loop
    v_step := public.document_unit_to_material_factor(p_material_id, r.item_unit);
    if v_step is null then
      continue;
    end if;

    if r.pack_match then
      v_factor := round(r.conversion_factor * v_step, 6);
      v_source := 'game_alias_factor';
      v_sources := jsonb_build_array('game_alias_factor');
    else
      v_factor := public.q7_unit_factor(v_doc, r.item_unit);
      if v_factor is null then
        continue;
      end if;
      v_factor := round(v_factor * v_step, 6);
      if v_raw is distinct from v_doc then
        v_source := 'misread_standard';
      else
        v_source := 'standard_auto';
      end if;
      v_sources := jsonb_build_array(v_source);
    end if;

    if v_factor is null
       or v_factor <= 0
       or v_factor::text in ('NaN', 'Infinity', '-Infinity') then
      continue;
    end if;

    if not (v_factor = any (v_seen)) then
      v_seen := array_append(v_seen, v_factor);

      -- A pack factor that still needs the item -> material step is shown as
      -- "game + đổi chuẩn" to the owner.
      if v_step <> 1 and v_source = 'game_alias_factor' then
        v_sources := jsonb_build_array('game_alias_factor', 'standard_auto');
      end if;

      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'factor', v_factor,
        'source', v_source,
        'alias_id', r.id,
        'sources', v_sources
      ));
    end if;
  end loop;

  -- When no label and no standard chain yields a factor, an approved document
  -- conversion is the only defensible value; it is a link-only candidate.
  if jsonb_array_length(v_out) = 0 then
    select c.factor into v_approved
    from public.material_unit_conversions c
    where c.material_id = p_material_id
      and c.active = true
      and c.approved = true
      and lower(btrim(c.from_unit)) = v_doc
      and lower(btrim(c.to_unit)) = lower(btrim(v_material.default_unit))
      and c.effective_from <= current_date
      and (c.effective_to is null or c.effective_to >= current_date)
    order by c.effective_from desc, c.created_at desc, c.id
    limit 1;

    if v_approved is not null then
      v_out := jsonb_build_array(jsonb_build_object(
        'factor', round(v_approved, 6),
        'source', 'approved_conversion',
        'alias_id', null,
        'sources', jsonb_build_array('approved_conversion')
      ));
    end if;
  end if;

  return v_out;
end;
$$;

revoke all on function public.document_unit_factor_candidates(uuid, text, uuid, text) from public, anon;
grant execute on function public.document_unit_factor_candidates(uuid, text, uuid, text) to service_role;

-- ===========================================================================
-- C. Unlinked document lines whose unit differs from the material unit
-- ===========================================================================

create or replace function public.document_unit_mismatch_pairs_internal()
returns table (
  material_id uuid,
  doc_unit text,
  doc_unit_normalized text,
  supplier_id uuid,
  normalized_name text,
  line_count integer
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with lines as (
    select
      po.supplier_id,
      coalesce(nullif(btrim(poi.raw_product_name), ''), poi.product_name) as raw_name,
      btrim(poi.unit) as doc_unit
    from public.purchase_order_items poi
    join public.purchase_orders po on po.id = poi.purchase_order_id
    where poi.canonical_material_id is null
      and nullif(btrim(poi.unit), '') is not null
      and nullif(btrim(coalesce(nullif(btrim(poi.raw_product_name), ''), poi.product_name)), '') is not null

    union all

    select
      pr.supplier_id,
      coalesce(nullif(btrim(pri.raw_product_name), ''), pri.product_name),
      btrim(pri.unit)
    from public.payment_request_items pri
    join public.payment_requests pr on pr.id = pri.payment_request_id
    where pri.canonical_material_id is null
      and nullif(btrim(pri.unit), '') is not null
      and nullif(btrim(coalesce(nullif(btrim(pri.raw_product_name), ''), pri.product_name)), '') is not null

    union all

    select
      gr.supplier_id,
      coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name),
      btrim(gri.unit)
    from public.goods_receipt_items gri
    join public.goods_receipts gr on gr.id = gri.goods_receipt_id
    where gri.canonical_material_id is null
      and nullif(btrim(gri.unit), '') is not null
      and nullif(btrim(coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)), '') is not null

    union all

    select
      inv.supplier_id,
      coalesce(nullif(btrim(ii.raw_product_name), ''), ii.product_name),
      btrim(ii.unit)
    from public.invoice_items ii
    join public.invoices inv on inv.id = ii.invoice_id
    where ii.canonical_material_id is null
      and nullif(btrim(ii.unit), '') is not null
      and nullif(btrim(coalesce(nullif(btrim(ii.raw_product_name), ''), ii.product_name)), '') is not null
  ),
  grouped as (
    select
      l.supplier_id,
      l.raw_name,
      l.doc_unit,
      count(*)::integer as line_count
    from lines l
    group by l.supplier_id, l.raw_name, l.doc_unit
  ),
  resolved as (
    select
      g.supplier_id,
      g.raw_name,
      g.doc_unit,
      g.line_count,
      public.normalize_stock_item_name(g.raw_name) as normalized_name,
      public.stock_alias_canonical_material(g.supplier_id, g.raw_name) as material_id
    from grouped g
  )
  select
    r.material_id,
    r.doc_unit,
    public.normalize_document_unit(r.doc_unit),
    r.supplier_id,
    r.normalized_name,
    r.line_count
  from resolved r
  join public.sku_cogs_materials m on m.id = r.material_id
  where public.normalize_document_unit(r.doc_unit) is not null
    and lower(btrim(r.doc_unit)) <> lower(btrim(m.default_unit));
$$;

revoke all on function public.document_unit_mismatch_pairs_internal() from public, anon;
grant execute on function public.document_unit_mismatch_pairs_internal() to service_role;

-- ===========================================================================
-- D. Real sample lines for a question
-- ===========================================================================

create or replace function public.document_unit_sample_lines(
  p_material_id uuid,
  p_supplier_id uuid,
  p_normalized_name text,
  p_doc_unit_normalized text,
  p_limit integer default 5
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with candidates as (
    select
      'purchase_order_items'::text as source_table,
      poi.id as line_id,
      poi.created_at,
      po.po_number::text as document_number,
      po.order_date as document_date,
      coalesce(nullif(btrim(poi.raw_product_name), ''), poi.product_name) as product_name,
      poi.quantity as qty,
      poi.unit,
      poi.unit_price,
      po.supplier_id,
      po.image_url as image_path
    from public.purchase_order_items poi
    join public.purchase_orders po on po.id = poi.purchase_order_id
    where poi.canonical_material_id is null
      and po.supplier_id is not distinct from p_supplier_id
      and public.normalize_stock_item_name(
            coalesce(nullif(btrim(poi.raw_product_name), ''), poi.product_name)
          ) = p_normalized_name
      and public.normalize_document_unit(poi.unit) = p_doc_unit_normalized

    union all

    select
      'payment_request_items',
      pri.id,
      pri.created_at,
      pr.request_number::text,
      pr.created_at::date,
      coalesce(nullif(btrim(pri.raw_product_name), ''), pri.product_name),
      pri.quantity,
      pri.unit,
      pri.unit_price,
      pr.supplier_id,
      pr.image_url
    from public.payment_request_items pri
    join public.payment_requests pr on pr.id = pri.payment_request_id
    where pri.canonical_material_id is null
      and pr.supplier_id is not distinct from p_supplier_id
      and public.normalize_stock_item_name(
            coalesce(nullif(btrim(pri.raw_product_name), ''), pri.product_name)
          ) = p_normalized_name
      and public.normalize_document_unit(pri.unit) = p_doc_unit_normalized

    union all

    select
      'goods_receipt_items',
      gri.id,
      gri.created_at,
      gr.receipt_number::text,
      gr.receipt_date,
      coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name),
      gri.quantity,
      gri.unit,
      gri.unit_price,
      gr.supplier_id,
      gr.image_url
    from public.goods_receipt_items gri
    join public.goods_receipts gr on gr.id = gri.goods_receipt_id
    where gri.canonical_material_id is null
      and gr.supplier_id is not distinct from p_supplier_id
      and public.normalize_stock_item_name(
            coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
          ) = p_normalized_name
      and public.normalize_document_unit(gri.unit) = p_doc_unit_normalized

    union all

    select
      'invoice_items',
      ii.id,
      ii.created_at,
      inv.invoice_number::text,
      inv.invoice_date,
      coalesce(nullif(btrim(ii.raw_product_name), ''), ii.product_name),
      ii.quantity,
      ii.unit,
      ii.unit_price,
      inv.supplier_id,
      inv.image_url
    from public.invoice_items ii
    join public.invoices inv on inv.id = ii.invoice_id
    where ii.canonical_material_id is null
      and inv.supplier_id is not distinct from p_supplier_id
      and public.normalize_stock_item_name(
            coalesce(nullif(btrim(ii.raw_product_name), ''), ii.product_name)
          ) = p_normalized_name
      and public.normalize_document_unit(ii.unit) = p_doc_unit_normalized
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'table', c.source_table,
           'line_id', c.line_id,
           'document_number', c.document_number,
           'document_date', c.document_date,
           'product_name', c.product_name,
           'qty', c.qty,
           'unit', c.unit,
           'unit_price', c.unit_price,
           'supplier_name', s.name,
           'image_path', c.image_path,
           'created_at', c.created_at
         ) order by c.created_at desc nulls last, c.line_id desc), '[]'::jsonb)
  from (
    select *
    from candidates c
    order by c.created_at desc nulls last, c.line_id desc
    limit greatest(coalesce(p_limit, 5), 0)
  ) c
  left join public.suppliers s on s.id = c.supplier_id;
$$;

revoke all on function public.document_unit_sample_lines(uuid, uuid, text, text, integer) from public, anon;
grant execute on function public.document_unit_sample_lines(uuid, uuid, text, text, integer) to service_role;

-- ===========================================================================
-- E. Questions table
-- ===========================================================================

create table if not exists public.document_unit_questions (
  id uuid primary key default gen_random_uuid(),
  batch text not null,
  material_id uuid not null references public.sku_cogs_materials(id) on delete restrict,
  doc_unit text not null,
  doc_unit_normalized text not null,
  default_unit text not null,
  line_count integer not null default 0 check (line_count >= 0),
  candidates jsonb not null default '[]'::jsonb,
  sample_lines jsonb not null default '[]'::jsonb,
  status text not null default 'open' check (status in ('open', 'answered', 'skipped')),
  action text check (action is null or action in ('factor', 'misread', 'skip')),
  factor numeric check (factor is null or factor > 0),
  actual_unit text,
  reason text,
  answered_by uuid references auth.users(id) on delete set null,
  answered_at timestamptz,
  created_at timestamptz not null default now(),
  constraint document_unit_questions_batch_material_unit_key
    unique (batch, material_id, doc_unit_normalized)
);

alter table public.document_unit_questions enable row level security;

revoke all on table public.document_unit_questions from public, anon, authenticated;
grant select on table public.document_unit_questions to authenticated;
grant all on table public.document_unit_questions to service_role;

drop policy if exists document_unit_questions_select on public.document_unit_questions;
create policy document_unit_questions_select on public.document_unit_questions
  for select to authenticated
  using (
    public.has_role((select auth.uid()), 'owner')
    or public.material_alias_can_view((select auth.uid()))
  );

-- ===========================================================================
-- F. Question helpers (open/update/reopen + JSON)
-- ===========================================================================

create or replace function public.document_unit_question_upsert(
  p_batch text,
  p_material_id uuid,
  p_doc_unit text,
  p_doc_unit_normalized text,
  p_default_unit text,
  p_line_count integer,
  p_candidates jsonb,
  p_sample_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_question public.document_unit_questions%rowtype;
  v_action text;
begin
  select * into v_question
  from public.document_unit_questions q
  where q.batch = p_batch
    and q.material_id = p_material_id
    and q.doc_unit_normalized = p_doc_unit_normalized
  for update;

  if not found then
    insert into public.document_unit_questions (
      batch, material_id, doc_unit, doc_unit_normalized, default_unit,
      line_count, candidates, sample_lines, status
    ) values (
      p_batch, p_material_id, p_doc_unit, p_doc_unit_normalized, p_default_unit,
      greatest(coalesce(p_line_count, 0), 0),
      coalesce(p_candidates, '[]'::jsonb),
      coalesce(p_sample_lines, '[]'::jsonb),
      'open'
    )
    returning * into v_question;
    v_action := 'inserted';
  elsif v_question.status = 'open' then
    update public.document_unit_questions
    set doc_unit = coalesce(nullif(btrim(p_doc_unit), ''), doc_unit),
        default_unit = p_default_unit,
        line_count = greatest(coalesce(v_question.line_count, 0), coalesce(p_line_count, 0)),
        candidates = coalesce(p_candidates, '[]'::jsonb),
        sample_lines = coalesce(p_sample_lines, '[]'::jsonb)
    where id = v_question.id
    returning * into v_question;
    v_action := 'updated';
  else
    update public.document_unit_questions
    set doc_unit = coalesce(nullif(btrim(p_doc_unit), ''), doc_unit),
        default_unit = p_default_unit,
        line_count = greatest(coalesce(v_question.line_count, 0), coalesce(p_line_count, 0)),
        candidates = coalesce(p_candidates, '[]'::jsonb),
        sample_lines = coalesce(p_sample_lines, '[]'::jsonb),
        status = 'open',
        action = null,
        factor = null,
        actual_unit = null,
        reason = null,
        answered_by = null,
        answered_at = null
    where id = v_question.id
    returning * into v_question;
    v_action := 'reopened';
  end if;

  return jsonb_build_object('action', v_action, 'id', v_question.id);
end;
$$;

revoke all on function public.document_unit_question_upsert(text, uuid, text, text, text, integer, jsonb, jsonb) from public, anon;
grant execute on function public.document_unit_question_upsert(text, uuid, text, text, text, integer, jsonb, jsonb) to service_role;

create or replace function public.document_unit_question_json(
  p_question public.document_unit_questions
)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'id', q.id,
    'batch', q.batch,
    'material_id', q.material_id,
    'doc_unit', q.doc_unit,
    'doc_unit_normalized', q.doc_unit_normalized,
    'default_unit', q.default_unit,
    'line_count', q.line_count,
    'candidates', q.candidates,
    'sample_lines', q.sample_lines,
    'status', q.status,
    'action', q.action,
    'factor', q.factor,
    'actual_unit', q.actual_unit,
    'reason', q.reason,
    'answered_by', q.answered_by,
    'answered_at', q.answered_at,
    'created_at', q.created_at,
    'material', case
      when m.id is null then null
      else jsonb_build_object(
        'id', m.id,
        'material_code', m.material_code,
        'canonical_name', m.canonical_name,
        'default_unit', m.default_unit
      )
    end
  )
  from public.document_unit_questions q
  left join public.sku_cogs_materials m on m.id = q.material_id
  where q.id = p_question.id;
$$;

revoke all on function public.document_unit_question_json(public.document_unit_questions) from public, anon;
grant execute on function public.document_unit_question_json(public.document_unit_questions) to service_role;

-- ===========================================================================
-- G. Seed conversions (dry run by default) + questions for disagreements
-- ===========================================================================

create or replace function public.seed_document_unit_conversions(
  p_dry_run boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_batch constant text := '2026-10-20';
  c_reason constant text := 'Lấy từ hệ số đã chốt trong game kho';
  v_actor uuid := auth.uid();
  v_approved_by uuid;
  v_dry boolean := coalesce(p_dry_run, true);
  v_group record;
  v_pair record;
  v_raw_candidates jsonb;
  v_candidates jsonb;
  v_samples jsonb;
  v_candidate jsonb;
  v_factor numeric;
  v_source text;
  v_sources jsonb;
  v_alias_ids jsonb;
  v_froms text[];
  v_from text;
  v_existing public.material_unit_conversions%rowtype;
  v_conflict boolean;
  v_written jsonb := '{}'::jsonb;
  v_would_write jsonb := '{}'::jsonb;
  v_written_total integer := 0;
  v_pair_count integer := 0;
  v_group_count integer := 0;
  v_skipped integer := 0;
  v_conflicts integer := 0;
  v_questions_created integer := 0;
  v_questions_reopened integer := 0;
  v_lines_linked integer := 0;
  v_link jsonb;
  v_upsert jsonb;
  v_question_action text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then
      raise exception 'actor_required' using errcode = '42501';
    end if;
    if not public.has_role(v_actor, 'owner') then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  v_approved_by := coalesce(
    v_actor,
    (
      select ur.user_id
      from public.user_roles ur
      where ur.role::text = 'owner'
      order by ur.created_at, ur.user_id
      limit 1
    )
  );
  if v_approved_by is null then
    raise exception 'owner_required' using errcode = '42501';
  end if;

  for v_group in
    select
      p.material_id,
      p.doc_unit_normalized,
      m.default_unit,
      sum(p.line_count)::integer as line_count,
      (array_agg(p.doc_unit order by p.line_count desc, p.doc_unit))[1] as doc_unit,
      jsonb_agg(jsonb_build_object(
        'doc_unit', p.doc_unit,
        'supplier_id', p.supplier_id,
        'normalized_name', p.normalized_name,
        'line_count', p.line_count
      ) order by p.line_count desc, p.doc_unit, p.normalized_name) as pairs
    from public.document_unit_mismatch_pairs_internal() p
    join public.sku_cogs_materials m on m.id = p.material_id
    group by p.material_id, p.doc_unit_normalized, m.default_unit
    order by p.material_id, p.doc_unit_normalized
  loop
    v_group_count := v_group_count + 1;
    v_raw_candidates := '[]'::jsonb;
    v_conflict := false;

    for v_pair in
      select value
      from jsonb_array_elements(v_group.pairs)
    loop
      v_pair_count := v_pair_count + 1;

      v_raw_candidates := v_raw_candidates || public.document_unit_factor_candidates(
        v_group.material_id,
        v_pair.value ->> 'doc_unit',
        nullif(v_pair.value ->> 'supplier_id', '')::uuid,
        v_pair.value ->> 'normalized_name'
      );
    end loop;

    -- One value per factor; the best source wins the display label.
    select coalesce(jsonb_agg(c order by (c ->> 'factor')::numeric), '[]'::jsonb)
    into v_candidates
    from (
      select distinct on ((c ->> 'factor')::numeric) c
      from jsonb_array_elements(v_raw_candidates) c
      order by (c ->> 'factor')::numeric,
        case c ->> 'source'
          when 'game_alias_factor' then 0
          when 'misread_standard' then 1
          when 'standard_auto' then 2
          when 'approved_conversion' then 3
          else 4
        end
    ) s;

    if jsonb_array_length(v_candidates) = 1 then
      v_candidate := v_candidates -> 0;
      v_factor := (v_candidate ->> 'factor')::numeric;
      v_source := v_candidate ->> 'source';
      v_sources := coalesce(v_candidate -> 'sources', jsonb_build_array(v_source));

      select coalesce(jsonb_agg(distinct (c ->> 'alias_id')::uuid), '[]'::jsonb)
      into v_alias_ids
      from jsonb_array_elements(v_raw_candidates) c
      where (c ->> 'factor')::numeric = v_factor
        and nullif(c ->> 'alias_id', '') is not null;

      if v_source <> 'approved_conversion' then
        -- Every spelling of the unit that has to work with assert_material_ready.
        v_froms := array[]::text[];
        for v_pair in select value from jsonb_array_elements(v_group.pairs) loop
          v_froms := array_append(v_froms, btrim(v_pair.value ->> 'doc_unit'));
        end loop;
        v_froms := array_append(v_froms, v_group.doc_unit_normalized);

        select array_agg(x) into v_froms
        from (
          select distinct on (lower(btrim(u))) btrim(u) as x
          from unnest(v_froms) u
          where nullif(btrim(u), '') is not null
          order by lower(btrim(u)), btrim(u)
        ) d;

        -- An approved value that disagrees is a real conflict: never overwrite.
        foreach v_from in array coalesce(v_froms, array[]::text[]) loop
          select * into v_existing
          from public.material_unit_conversions c
          where c.material_id = v_group.material_id
            and c.active = true
            and c.approved = true
            and lower(btrim(c.from_unit)) = lower(v_from)
            and lower(btrim(c.to_unit)) = lower(btrim(v_group.default_unit))
            and c.effective_from <= current_date
            and (c.effective_to is null or c.effective_to >= current_date)
          order by c.effective_from desc, c.created_at desc, c.id
          limit 1;

          if found and v_existing.factor is distinct from v_factor then
            v_conflict := true;
            v_raw_candidates := v_raw_candidates || jsonb_build_array(jsonb_build_object(
              'factor', round(v_existing.factor, 6),
              'source', 'approved_conversion',
              'alias_id', null,
              'sources', jsonb_build_array('approved_conversion')
            ));
          end if;
        end loop;
      end if;

      if not v_conflict and v_source <> 'approved_conversion' then
        foreach v_from in array coalesce(v_froms, array[]::text[]) loop
          select * into v_existing
          from public.material_unit_conversions c
          where c.material_id = v_group.material_id
            and c.active = true
            and c.approved = true
            and lower(btrim(c.from_unit)) = lower(v_from)
            and lower(btrim(c.to_unit)) = lower(btrim(v_group.default_unit))
            and c.effective_from <= current_date
            and (c.effective_to is null or c.effective_to >= current_date)
          order by c.effective_from desc, c.created_at desc, c.id
          limit 1;

          if found and v_existing.factor = v_factor then
            v_skipped := v_skipped + 1;
            continue;
          end if;

          if v_dry then
            v_would_write := jsonb_set(
              v_would_write,
              array[v_source],
              to_jsonb(coalesce((v_would_write ->> v_source)::integer, 0) + 1),
              true
            );
            continue;
          end if;

          begin
            insert into public.material_unit_conversions (
              material_id, from_unit, to_unit, factor, effective_from, effective_to,
              source_type, source_id, approved, approved_by, approved_at, active,
              metadata, created_by
            ) values (
              v_group.material_id, v_from, v_group.default_unit, v_factor,
              current_date, null,
              'document_unit_auto', null, true, v_approved_by, now(), true,
              jsonb_build_object(
                'factor_source', v_source,
                'alias_ids', v_alias_ids,
                'sources', v_sources,
                'reason', c_reason
              ),
              v_actor
            );
            v_written := jsonb_set(
              v_written,
              array[v_source],
              to_jsonb(coalesce((v_written ->> v_source)::integer, 0) + 1),
              true
            );
            v_written_total := v_written_total + 1;
          exception when unique_violation then
            select * into v_existing
            from public.material_unit_conversions c
            where c.material_id = v_group.material_id
              and c.active = true
              and c.approved = true
              and lower(btrim(c.from_unit)) = lower(v_from)
              and lower(btrim(c.to_unit)) = lower(btrim(v_group.default_unit))
              and c.effective_from <= current_date
              and (c.effective_to is null or c.effective_to >= current_date)
            order by c.effective_from desc, c.created_at desc, c.id
            limit 1;

            if found and v_existing.factor = v_factor then
              v_skipped := v_skipped + 1;
            else
              v_conflict := true;
            end if;
          end;
        end loop;
      end if;
    else
      v_conflict := true;
    end if;

    -- Anything unresolved (no candidate, several candidates, approved conflict)
    -- becomes an owner question with its candidate values and sample images.
    if v_conflict or jsonb_array_length(v_candidates) <> 1 then
      v_conflicts := v_conflicts + 1;

      select coalesce(jsonb_agg(c order by (c ->> 'factor')::numeric), '[]'::jsonb)
      into v_candidates
      from (
        select distinct on ((c ->> 'factor')::numeric) c
        from jsonb_array_elements(v_raw_candidates) c
        order by (c ->> 'factor')::numeric,
          case c ->> 'source'
            when 'game_alias_factor' then 0
            when 'misread_standard' then 1
            when 'standard_auto' then 2
            when 'approved_conversion' then 3
            else 4
          end
      ) s;

      if v_dry then
        -- Reported for information only; no row is written in a dry run.
        null;
      else
        v_samples := '[]'::jsonb;
        for v_pair in select value from jsonb_array_elements(v_group.pairs) loop
          v_samples := v_samples || public.document_unit_sample_lines(
            v_group.material_id,
            nullif(v_pair.value ->> 'supplier_id', '')::uuid,
            v_pair.value ->> 'normalized_name',
            v_group.doc_unit_normalized,
            5
          );
        end loop;

        select coalesce(jsonb_agg(e order by (e ->> 'created_at')::timestamptz desc nulls last, e ->> 'line_id'), '[]'::jsonb)
        into v_samples
        from (
          select e
          from jsonb_array_elements(v_samples) e
          order by (e ->> 'created_at')::timestamptz desc nulls last, e ->> 'line_id'
          limit 5
        ) s;

        v_upsert := public.document_unit_question_upsert(
          c_batch,
          v_group.material_id,
          v_group.doc_unit,
          v_group.doc_unit_normalized,
          v_group.default_unit,
          v_group.line_count,
          v_candidates,
          v_samples
        );
        v_question_action := v_upsert ->> 'action';
        if v_question_action = 'inserted' then
          v_questions_created := v_questions_created + 1;
        elsif v_question_action = 'reopened' then
          v_questions_reopened := v_questions_reopened + 1;
        end if;
      end if;
    end if;

    -- Relink the affected spellings through the existing controller only.
    if not v_dry then
      for v_pair in select value from jsonb_array_elements(v_group.pairs) loop
        v_link := public.link_documents_from_stock_aliases(
          nullif(v_pair.value ->> 'supplier_id', '')::uuid,
          v_pair.value ->> 'normalized_name',
          false
        );
        v_lines_linked := v_lines_linked
          + coalesce((v_link -> 'purchase_order_items' ->> 'linked')::integer, 0)
          + coalesce((v_link -> 'payment_request_items' ->> 'linked')::integer, 0)
          + coalesce((v_link -> 'invoice_items' ->> 'linked')::integer, 0)
          + coalesce((v_link -> 'goods_receipt_items' ->> 'linked')::integer, 0);
      end loop;
    end if;
  end loop;

  return jsonb_build_object(
    'dry_run', v_dry,
    'batch', c_batch,
    'groups', v_group_count,
    'pairs', v_pair_count,
    'written', v_written,
    'written_total', v_written_total,
    'would_write', v_would_write,
    'skipped_existing', v_skipped,
    'conflicts', v_conflicts,
    'questions_created', v_questions_created,
    'questions_reopened', v_questions_reopened,
    'lines_linked', v_lines_linked,
    'questions_open', (
      select count(*)::integer
      from public.document_unit_questions q
      where q.batch = c_batch
        and q.status = 'open'
    )
  );
end;
$$;

revoke all on function public.seed_document_unit_conversions(boolean) from public, anon;
grant execute on function public.seed_document_unit_conversions(boolean) to authenticated, service_role;

-- ===========================================================================
-- H. Read / answer RPCs (owner only)
-- ===========================================================================

create or replace function public.get_document_unit_questions(p_batch text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then
      raise exception 'actor_required' using errcode = '42501';
    end if;
    if not public.has_role(v_actor, 'owner') then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  return coalesce((
    select jsonb_agg(
             public.document_unit_question_json(q)
             order by q.created_at, q.id
           )
    from public.document_unit_questions q
    where q.batch = p_batch
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.get_document_unit_questions(text) from public, anon;
grant execute on function public.get_document_unit_questions(text) to authenticated, service_role;

create or replace function public.answer_document_unit_question(
  p_id uuid,
  p_action text,
  p_factor numeric,
  p_actual_unit text,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := auth.uid();
  v_approved_by uuid;
  v_question public.document_unit_questions%rowtype;
  v_action text;
  v_factor numeric;
  v_actual text;
  v_froms text[] := array[]::text[];
  v_from text;
  v_pair record;
  v_reason text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if v_actor is null then
      raise exception 'actor_required' using errcode = '42501';
    end if;
    if not public.has_role(v_actor, 'owner') then
      raise exception 'insufficient_privilege' using errcode = '42501';
    end if;
  end if;

  select * into v_question
  from public.document_unit_questions q
  where q.id = p_id
  for update;
  if not found then
    raise exception 'question_not_found' using errcode = 'P0002';
  end if;

  if v_question.status <> 'open' then
    return public.document_unit_question_json(v_question)
      || jsonb_build_object('replay', true);
  end if;

  v_action := lower(btrim(coalesce(p_action, '')));
  v_reason := nullif(btrim(coalesce(p_reason, '')), '');

  if v_action = 'skip' then
    update public.document_unit_questions
    set status = 'skipped',
        action = 'skip',
        factor = null,
        actual_unit = null,
        reason = v_reason,
        answered_by = v_actor,
        answered_at = now()
    where id = v_question.id
    returning * into v_question;

    return public.document_unit_question_json(v_question)
      || jsonb_build_object('replay', false);
  end if;

  v_approved_by := coalesce(
    v_actor,
    (
      select ur.user_id
      from public.user_roles ur
      where ur.role::text = 'owner'
      order by ur.created_at, ur.user_id
      limit 1
    )
  );
  if v_approved_by is null then
    raise exception 'owner_required' using errcode = '42501';
  end if;

  if v_action = 'factor' then
    if p_factor is null
       or p_factor <= 0
       or p_factor::text in ('NaN', 'Infinity', '-Infinity') then
      raise exception 'factor_required' using errcode = '22023';
    end if;
    v_factor := round(p_factor, 6);
    v_actual := null;
    v_froms := array[v_question.doc_unit, v_question.doc_unit_normalized];
  elsif v_action = 'misread' then
    v_actual := public.normalize_document_unit(p_actual_unit);
    if v_actual is null then
      raise exception 'actual_unit_required' using errcode = '22023';
    end if;

    v_factor := public.q7_unit_factor(v_actual, v_question.default_unit);
    if v_factor is null then
      if p_factor is null
         or p_factor <= 0
         or p_factor::text in ('NaN', 'Infinity', '-Infinity') then
        raise exception 'factor_required' using errcode = '22023';
      end if;
      v_factor := round(p_factor, 6);
    else
      v_factor := round(v_factor, 6);
    end if;

    v_froms := array[v_question.doc_unit, v_question.doc_unit_normalized, v_actual];
  else
    raise exception 'action_invalid' using errcode = '22023';
  end if;

  select array_agg(x) into v_froms
  from (
    select distinct on (lower(btrim(u))) btrim(u) as x
    from unnest(v_froms) u
    where nullif(btrim(u), '') is not null
    order by lower(btrim(u)), btrim(u)
  ) d;

  foreach v_from in array coalesce(v_froms, array[]::text[]) loop
    -- The old pair is retired first so the unique approved index stays valid.
    update public.material_unit_conversions c
    set active = false,
        effective_to = coalesce(c.effective_to, greatest(c.effective_from, current_date)),
        updated_at = now()
    where c.material_id = v_question.material_id
      and c.active = true
      and c.approved = true
      and lower(btrim(c.from_unit)) = lower(v_from)
      and lower(btrim(c.to_unit)) = lower(btrim(v_question.default_unit));

    insert into public.material_unit_conversions (
      material_id, from_unit, to_unit, factor, effective_from, effective_to,
      source_type, source_id, approved, approved_by, approved_at, active,
      metadata, created_by
    ) values (
      v_question.material_id, v_from, v_question.default_unit, v_factor,
      current_date, null,
      'document_unit_question', v_question.id, true, v_approved_by, now(), true,
      jsonb_build_object(
        'factor_source', 'owner_factor_doc',
        'question_id', v_question.id,
        'action', v_action,
        'reason', coalesce(v_reason, 'Trả lời câu hỏi đơn vị chứng từ')
      ),
      v_actor
    );
  end loop;

  for v_pair in
    select distinct p.supplier_id, p.normalized_name
    from public.document_unit_mismatch_pairs_internal() p
    where p.material_id = v_question.material_id
      and p.doc_unit_normalized = v_question.doc_unit_normalized
  loop
    perform public.link_documents_from_stock_aliases(
      v_pair.supplier_id,
      v_pair.normalized_name,
      false
    );
  end loop;

  update public.document_unit_questions
  set status = 'answered',
      action = v_action,
      factor = v_factor,
      actual_unit = v_actual,
      reason = v_reason,
      answered_by = v_actor,
      answered_at = now()
  where id = v_question.id
  returning * into v_question;

  return public.document_unit_question_json(v_question)
    || jsonb_build_object('replay', false);
end;
$$;

revoke all on function public.answer_document_unit_question(uuid, text, numeric, text, text) from public, anon;
grant execute on function public.answer_document_unit_question(uuid, text, numeric, text, text) to authenticated, service_role;

-- ===========================================================================
-- I. Game label writes/edits keep the material conversion in sync
-- ===========================================================================

create or replace function public.trg_stock_material_alias_document_unit_factor()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c_batch constant text := '2026-10-20';
  v_item public.kitchen_inventory_items%rowtype;
  v_material public.sku_cogs_materials%rowtype;
  v_doc_norm text;
  v_step numeric;
  v_factor numeric;
  v_source text;
  v_sources jsonb;
  v_candidate jsonb;
  v_existing public.material_unit_conversions%rowtype;
  v_candidates jsonb;
  v_samples jsonb;
  v_conflict boolean := false;
  v_approved_by uuid;
  v_claims text := current_setting('request.jwt.claims', true);
  v_claim_role text := current_setting('request.jwt.claim.role', true);
  v_claims_json jsonb;
  v_actor text;
begin
  if new.line_class is distinct from 'stock'
     or new.conversion_factor is null
     or new.kitchen_inventory_item_id is null then
    return new;
  end if;

  select * into v_item
  from public.kitchen_inventory_items k
  where k.id = new.kitchen_inventory_item_id;
  if not found or v_item.canonical_material_id is null then
    return new;
  end if;

  select * into v_material
  from public.sku_cogs_materials m
  where m.id = v_item.canonical_material_id
    and m.active = true;
  if not found then
    return new;
  end if;

  v_doc_norm := public.normalize_document_unit(new.pack_label);
  if v_doc_norm is null then
    return new;
  end if;

  v_approved_by := coalesce(
    auth.uid(),
    new.created_by,
    (
      select ur.user_id
      from public.user_roles ur
      where ur.role::text = 'owner'
      order by ur.created_at, ur.user_id
      limit 1
    )
  );

  begin
    v_step := public.document_unit_to_material_factor(v_material.id, v_item.unit);
    v_candidates := public.document_unit_factor_candidates(
      v_material.id,
      new.pack_label,
      new.supplier_id,
      new.normalized_name
    );

    -- One value per factor.  A game edit can still carry the same factor from
    -- several aliases, and only one agreed value may be written.
    select coalesce(jsonb_agg(c order by (c ->> 'factor')::numeric), '[]'::jsonb)
    into v_candidates
    from (
      select distinct on ((c ->> 'factor')::numeric) c
      from jsonb_array_elements(v_candidates) c
      order by (c ->> 'factor')::numeric,
        case c ->> 'source'
          when 'game_alias_factor' then 0
          when 'misread_standard' then 1
          when 'standard_auto' then 2
          when 'approved_conversion' then 3
          else 4
        end
    ) s;

    if v_step is null then
      -- The edited label itself cannot be converted: never guess.
      v_factor := null;
      v_conflict := true;
    elsif jsonb_array_length(v_candidates) = 1 then
      v_candidate := v_candidates -> 0;
      v_factor := (v_candidate ->> 'factor')::numeric;
      v_source := v_candidate ->> 'source';
      v_sources := coalesce(v_candidate -> 'sources', jsonb_build_array(v_source));

      if v_source = 'approved_conversion' then
        -- An approved document conversion already carries this value.
        v_conflict := false;
      else
        select * into v_existing
        from public.material_unit_conversions c
        where c.material_id = v_material.id
          and c.active = true
          and c.approved = true
          and lower(btrim(c.from_unit)) = v_doc_norm
          and lower(btrim(c.to_unit)) = lower(btrim(v_material.default_unit))
          and c.effective_from <= current_date
          and (c.effective_to is null or c.effective_to >= current_date)
        order by c.effective_from desc, c.created_at desc, c.id
        limit 1;

        if found then
          if v_existing.factor = v_factor then
            if v_existing.source_type in (
              'game_alias_factor', 'document_unit_auto', 'standard_auto', 'misread_standard'
            ) then
              update public.material_unit_conversions
              set source_type = 'game_alias_factor',
                  metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
                    'factor_source', 'game_alias_factor',
                    'alias_ids', jsonb_build_array(new.id),
                    'sources', v_sources,
                    'reason', 'Lấy từ hệ số đã chốt trong game kho'
                  ),
                  updated_at = now()
              where id = v_existing.id;
            end if;
          elsif v_existing.source_type in (
            'game_alias_factor', 'document_unit_auto', 'standard_auto', 'misread_standard'
          ) then
            update public.material_unit_conversions
            set factor = v_factor,
                source_type = 'game_alias_factor',
                metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
                  'factor_source', 'game_alias_factor',
                  'alias_ids', jsonb_build_array(new.id),
                  'sources', v_sources,
                  'reason', 'Lấy từ hệ số đã chốt trong game kho'
                ),
                updated_at = now()
            where id = v_existing.id;
          else
            v_conflict := true;
          end if;
        else
          if v_approved_by is null then
            raise exception 'owner_required' using errcode = '42501';
          end if;

          insert into public.material_unit_conversions (
            material_id, from_unit, to_unit, factor, effective_from, effective_to,
            source_type, source_id, approved, approved_by, approved_at, active,
            metadata, created_by
          ) values (
            v_material.id, v_doc_norm, v_material.default_unit, v_factor,
            current_date, null,
            'game_alias_factor', null, true, v_approved_by, now(), true,
            jsonb_build_object(
              'factor_source', 'game_alias_factor',
              'alias_ids', jsonb_build_array(new.id),
              'sources', v_sources,
              'reason', 'Lấy từ hệ số đã chốt trong game kho'
            ),
            v_approved_by
          );
        end if;
      end if;
    else
      -- Zero or several candidate values: the owner decides.
      v_conflict := true;
    end if;

    if v_conflict then
      -- An owner-approved value that disagrees stays visible in the question.
      if v_existing.factor is not null
         and not exists (
           select 1
           from jsonb_array_elements(v_candidates) c
           where (c ->> 'factor')::numeric = v_existing.factor
         ) then
        v_candidates := v_candidates || jsonb_build_array(jsonb_build_object(
          'factor', round(v_existing.factor, 6),
          'source', 'approved_conversion',
          'alias_id', null,
          'sources', jsonb_build_array('approved_conversion')
        ));
      end if;

      v_samples := public.document_unit_sample_lines(
        v_material.id,
        new.supplier_id,
        new.normalized_name,
        v_doc_norm,
        5
      );

      perform public.document_unit_question_upsert(
        c_batch,
        v_material.id,
        coalesce(nullif(btrim(new.pack_label), ''), v_doc_norm),
        v_doc_norm,
        v_material.default_unit,
        jsonb_array_length(v_samples),
        v_candidates,
        v_samples
      );
    end if;

    -- Reuse the existing linking controller with a service context, exactly
    -- like the old alias trigger does, so an editor write still links.
    v_claims_json := '{}'::jsonb;
    if nullif(btrim(coalesce(v_claims, '')), '') is not null then
      begin
        v_claims_json := v_claims::jsonb;
      exception when others then
        v_claims_json := '{}'::jsonb;
      end;
    end if;
    if nullif(v_claims_json ->> 'sub', '') is null then
      select coalesce(new.created_by::text, v_approved_by::text)
      into v_actor;
      if v_actor is not null then
        v_claims_json := v_claims_json || jsonb_build_object('sub', v_actor);
      end if;
    end if;

    begin
      perform set_config(
        'request.jwt.claims',
        (v_claims_json || jsonb_build_object('role', 'service_role'))::text,
        true
      );
      perform set_config('request.jwt.claim.role', 'service_role', true);
      perform public.link_documents_from_stock_aliases(
        new.supplier_id,
        new.normalized_name,
        false
      );
    exception when others then
      perform set_config('request.jwt.claims', coalesce(nullif(v_claims, ''), '{}'), true);
      perform set_config('request.jwt.claim.role', coalesce(v_claim_role, ''), true);
      raise warning 'document unit link failed for alias %: %', new.id, sqlerrm;
    end;

    perform set_config('request.jwt.claims', coalesce(nullif(v_claims, ''), '{}'), true);
    perform set_config('request.jwt.claim.role', coalesce(v_claim_role, ''), true);
  exception when others then
    raise warning 'document unit factor failed for alias %: %', new.id, sqlerrm;
  end;

  return new;
end;
$$;

revoke all on function public.trg_stock_material_alias_document_unit_factor() from public, anon, authenticated, service_role;

drop trigger if exists trg_stock_material_alias_document_unit_factor on public.stock_material_aliases;
create trigger trg_stock_material_alias_document_unit_factor
after insert or update of conversion_factor, pack_label, unit, kitchen_inventory_item_id
on public.stock_material_aliases
for each row
when (new.line_class = 'stock' and new.conversion_factor is not null)
execute function public.trg_stock_material_alias_document_unit_factor();

-- ===========================================================================
-- J. mission_evaluate: keep every branch and add document_unit_questions_done
-- ===========================================================================

-- Extend the check_rule constraint without losing any existing rule: the
-- known list (including manual_review) is merged with whatever missions
-- already use, then document_unit_questions_done is added.
do $mission_check_rule$
declare
  v_values text[] := array[
    'manual_review',
    'stock_alias_factor_fixed',
    'stock_duplicate_resolved',
    'stock_unknown_units_cleared',
    'material_links_done',
    'stock_count_questions_done',
    'q7_bom_mismatch_resolved',
    'tan_tao_recipe_done',
    'sku_counted',
    'document_unit_questions_done'
  ];
  v_extra text[];
begin
  select array_agg(distinct m.check_rule)
  into v_extra
  from public.missions m
  where m.check_rule is not null
    and not (m.check_rule = any (v_values));

  v_values := v_values || coalesce(v_extra, '{}'::text[]);

  execute 'alter table public.missions drop constraint if exists missions_check_rule_check';
  execute format(
    'alter table public.missions add constraint missions_check_rule_check check (check_rule = any (%L::text[]))',
    v_values
  );
end;
$mission_check_rule$;

create or replace function public.mission_evaluate(p_mission_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_mission public.missions%rowtype;
  v_done boolean := false;
  v_total integer := 0;
  v_left integer := 0;
  v_detail jsonb := '[]'::jsonb;
  v_alias_id uuid;
  v_bad_factor numeric;
  v_bad_item uuid;
  v_alias public.stock_material_aliases%rowtype;
  v_alias_found boolean;
  v_item_name text;
  v_item_unit text;
  v_fixed boolean;
  v_rows jsonb;
  v_index integer;
  v_active integer;
  v_name_changed boolean;
  v_pair boolean;
  v_a uuid;
  v_b uuid;
  v_row public.kitchen_inventory_items%rowtype;
  v_days integer;
  v_initial integer;
  v_groups integer;
  v_ignored integer;
  v_location text;
  v_review jsonb;
  v_counts jsonb;
  v_linked integer;
  v_batch text;
  v_question_total integer := 0;
  v_question_open integer := 0;
  v_question_answered integer := 0;
  v_question_skipped integer := 0;
  v_bom_open integer := 0;
  v_bom_excluded integer := 0;
  v_bom_resolved integer := 0;
  v_bom_total integer := 0;
  v_recipe public.tan_tao_recipes%rowtype;
  v_recipe_total integer := 0;
  v_recipe_open integer := 0;
  v_recipe_answered integer := 0;
  v_recipe_not_used integer := 0;
  v_recipe_code text;
  v_sku_code text;
  v_since date;
  v_sku_counted_at timestamptz;
  v_sku_counted_qty numeric;
begin
  select * into v_mission from public.missions where id = p_mission_id;
  if not found then
    raise exception 'mission_not_found' using errcode = 'P0002';
  end if;

  -- Keep the manual_review branch when redefining mission_evaluate (manual missions).
  if v_mission.check_rule = 'manual_review' then
    select exists (
      select 1
      from public.mission_submissions s
      where s.mission_id = p_mission_id
        and s.review_status = 'approved'
    ) into v_done;

    v_total := 1;
    v_left := case when v_done then 0 else 1 end;
    v_detail := '[]'::jsonb;

  elsif v_mission.check_rule = 'stock_alias_factor_fixed' then
    v_rows := coalesce(v_mission.check_params -> 'aliases', '[]'::jsonb);
    v_total := jsonb_array_length(v_rows);
    for v_index in 0 .. greatest(v_total - 1, -1) loop
      v_alias_id := (v_rows -> v_index ->> 'id')::uuid;
      v_bad_factor := (v_rows -> v_index ->> 'bad_factor')::numeric;
      v_bad_item := (v_rows -> v_index ->> 'bad_item_id')::uuid;

      select * into v_alias from public.stock_material_aliases a where a.id = v_alias_id;
      v_alias_found := found;

      if not v_alias_found then
        v_fixed := true;
        v_item_name := null;
        v_item_unit := null;
      else
        select k.name, k.unit into v_item_name, v_item_unit
        from public.kitchen_inventory_items k
        where k.id = v_alias.kitchen_inventory_item_id;

        v_fixed := (v_alias.conversion_factor is distinct from v_bad_factor)
          or (v_alias.kitchen_inventory_item_id is distinct from v_bad_item);
      end if;

      if not v_fixed then
        v_left := v_left + 1;
      end if;

      v_detail := v_detail || jsonb_build_array(jsonb_build_object(
        'id', v_alias_id,
        'name', case when v_alias_found then v_alias.normalized_name else null end,
        'unit', case when v_alias_found then v_alias.unit else null end,
        'factor', case when v_alias_found then v_alias.conversion_factor else null end,
        'item_name', v_item_name,
        'item_unit', v_item_unit,
        'fixed', v_fixed
      ));
    end loop;
    v_done := (v_left = 0);

  elsif v_mission.check_rule = 'stock_duplicate_resolved' then
    v_rows := coalesce(v_mission.check_params -> 'items', '[]'::jsonb);
    v_total := jsonb_array_length(v_rows);
    v_active := 0;
    v_name_changed := false;
    v_pair := false;

    for v_index in 0 .. greatest(v_total - 1, -1) loop
      v_a := (v_rows -> v_index ->> 'id')::uuid;
      select * into v_row from public.kitchen_inventory_items k where k.id = v_a;
      if not found then
        v_name_changed := true;
        v_detail := v_detail || jsonb_build_array(jsonb_build_object(
          'id', v_a,
          'code', null,
          'name', null,
          'unit', null,
          'active', false,
          'on_hand', 0,
          'alias_count', 0
        ));
      else
        if coalesce(v_row.active, false) then
          v_active := v_active + 1;
        end if;
        if v_row.name is distinct from (v_rows -> v_index ->> 'name') then
          v_name_changed := true;
        end if;
        v_detail := v_detail || jsonb_build_array(jsonb_build_object(
          'id', v_row.id,
          'code', v_row.item_code,
          'name', v_row.name,
          'unit', v_row.unit,
          'active', coalesce(v_row.active, false),
          'on_hand', coalesce((
            select sum(case m.movement_type
                         when 'receipt' then m.quantity
                         when 'production_usage' then -m.quantity
                         when 'adjustment' then m.quantity
                         else 0 end)
            from public.q7_inventory_movements m
            where m.kitchen_inventory_item_id = v_row.id
          ), 0),
          'alias_count', (
            select count(*)
            from public.stock_material_aliases a
            where a.kitchen_inventory_item_id = v_row.id
          )
        ));
      end if;
    end loop;

    if v_total = 2 then
      v_a := (v_rows -> 0 ->> 'id')::uuid;
      v_b := (v_rows -> 1 ->> 'id')::uuid;
      select exists (
        select 1 from public.stock_item_distinct_pairs p
        where p.item_a = least(v_a, v_b)
          and p.item_b = greatest(v_a, v_b)
      ) into v_pair;
    end if;

    v_done := (v_active < 2) or v_name_changed or v_pair;
    v_left := case when v_done then 0 else 1 end;

  elsif v_mission.check_rule = 'stock_unknown_units_cleared' then
    v_days := coalesce((v_mission.check_params ->> 'days')::integer, 60);
    v_initial := coalesce((v_mission.check_params ->> 'initial')::integer, 0);
    v_total := v_initial;

    select count(distinct lower(btrim(r.unit)))::integer into v_groups
    from public.stock_unknown_purchase_unit_rows(v_days) r;

    select count(*)::integer into v_ignored
    from public.stock_unit_ignored_variants g
    where exists (
      select 1
      from public.stock_unknown_purchase_unit_rows(v_days) r
      where g.variant = lower(btrim(r.unit))
    );

    v_left := greatest(coalesce(v_groups, 0) - coalesce(v_ignored, 0), 0);
    v_done := (v_left = 0);

    select coalesce(jsonb_agg(jsonb_build_object(
             'unit', r.unit,
             'line_count', r.line_count,
             'example_name', r.example_name,
             'source_table', r.source_table
           ) order by r.line_count desc, r.unit asc, r.source_table asc), '[]'::jsonb)
    into v_detail
    from public.stock_unknown_purchase_unit_rows(v_days) r;

  elsif v_mission.check_rule = 'material_links_done' then
    v_location := v_mission.check_params ->> 'location';
    v_counts := public.material_link_counts_internal(v_location);
    v_left := coalesce((v_counts ->> 'total')::int, 0);
    v_linked := coalesce((v_counts ->> 'linked_total')::int, 0);
    v_total := v_left + v_linked;
    v_done := (v_left = 0 and v_total > 0);
    v_detail := jsonb_build_array(jsonb_build_object(
      'location', v_location,
      'remaining', v_left,
      'linked', v_linked,
      'exact', coalesce((v_counts ->> 'exact')::int, 0),
      'skipped', coalesce((v_counts ->> 'skipped')::int, 0)
    ));

  elsif v_mission.check_rule = 'stock_count_questions_done' then
    v_batch := v_mission.check_params ->> 'batch';

    select
      count(*)::integer,
      (count(*) filter (where q.status = 'open'))::integer,
      (count(*) filter (where q.status = 'answered'))::integer,
      (count(*) filter (where q.status = 'skipped'))::integer
    into v_question_total, v_question_open, v_question_answered, v_question_skipped
    from public.stock_count_unit_questions q
    where q.batch = v_batch;

    v_total := coalesce(v_question_total, 0);
    v_left := coalesce(v_question_open, 0);
    v_done := (v_total > 0 and v_left = 0);
    v_detail := jsonb_build_array(jsonb_build_object(
      'kind', 'count_questions',
      'batch', v_batch,
      'total', v_total,
      'open', v_left,
      'answered', coalesce(v_question_answered, 0),
      'skipped', coalesce(v_question_skipped, 0)
    ));

  elsif v_mission.check_rule = 'document_unit_questions_done' then
    v_batch := v_mission.check_params ->> 'batch';

    select
      count(*)::integer,
      (count(*) filter (where q.status = 'open'))::integer,
      (count(*) filter (where q.status = 'answered'))::integer,
      (count(*) filter (where q.status = 'skipped'))::integer
    into v_question_total, v_question_open, v_question_answered, v_question_skipped
    from public.document_unit_questions q
    where q.batch = v_batch;

    v_total := coalesce(v_question_total, 0);
    v_left := coalesce(v_question_open, 0);
    v_done := (v_total > 0 and v_left = 0);
    v_detail := jsonb_build_array(jsonb_build_object(
      'kind', 'document_unit_questions',
      'batch', v_batch,
      'total', v_total,
      'open', v_left,
      'answered', coalesce(v_question_answered, 0),
      'skipped', coalesce(v_question_skipped, 0)
    ));

  elsif v_mission.check_rule = 'q7_bom_mismatch_resolved' then
    v_review := public.get_q7_bom_mismatch_review();
    v_bom_total := coalesce(jsonb_array_length(v_review), 0);
    select
      count(*) filter (where (r ->> 'open')::boolean = true)::integer,
      count(*) filter (where (r ->> 'excluded')::boolean = true)::integer,
      count(*) filter (where (r ->> 'resolved')::boolean = true)::integer
    into v_bom_open, v_bom_excluded, v_bom_resolved
    from jsonb_array_elements(v_review) r;

    v_total := v_bom_total;
    v_left := coalesce(v_bom_open, 0);
    v_done := (
      v_left = 0
      and exists (
        select 1
        from public.production_material_issues pmi
        where pmi.location_code = 'q7'
          and pmi.is_current = true
          and pmi.issue_date > public.stock_ledger_cutover_date('q7')
      )
    );
    v_detail := jsonb_build_array(jsonb_build_object(
      'kind', 'bom_mismatch',
      'open', v_left,
      'resolved', coalesce(v_bom_resolved, 0),
      'excluded', coalesce(v_bom_excluded, 0),
      'total', v_total
    ));

  elsif v_mission.check_rule = 'tan_tao_recipe_done' then
    v_recipe_code := v_mission.check_params ->> 'code';

    select * into v_recipe
    from public.tan_tao_recipes r
    where r.code = v_recipe_code;

    if not found then
      v_total := 0;
      v_left := 0;
      v_done := false;
      v_detail := jsonb_build_array(jsonb_build_object(
        'kind', 'recipe',
        'code', v_recipe_code,
        'open', 0,
        'answered', 0,
        'not_used', 0,
        'batch_set', false
      ));
    else
      select
        count(*)::integer,
        (count(*) filter (where l.status = 'open'))::integer,
        (count(*) filter (where l.status = 'answered'))::integer,
        (count(*) filter (where l.status = 'not_used'))::integer
      into v_recipe_total, v_recipe_open, v_recipe_answered, v_recipe_not_used
      from public.tan_tao_recipe_lines l
      where l.recipe_id = v_recipe.id;

      v_done := (v_recipe.status = 'complete');
      v_total := coalesce(v_recipe_total, 0) + 1;
      v_left := case
        when v_done then 0
        else coalesce(v_recipe_open, 0)
          + case when coalesce(v_recipe.batch_output_kg, 0) > 0 then 0 else 1 end
      end;
      v_detail := jsonb_build_array(jsonb_build_object(
        'kind', 'recipe',
        'code', v_recipe.code,
        'open', coalesce(v_recipe_open, 0),
        'answered', coalesce(v_recipe_answered, 0),
        'not_used', coalesce(v_recipe_not_used, 0),
        'batch_set', coalesce(v_recipe.batch_output_kg, 0) > 0
      ));
    end if;

  elsif v_mission.check_rule = 'sku_counted' then
    v_sku_code := v_mission.check_params ->> 'sku_code';
    v_since := (v_mission.check_params ->> 'since')::date;

    select d.created_at, d.quantity
    into v_sku_counted_at, v_sku_counted_qty
    from public.tan_tao_warehouse_documents d
    where d.document_type = 'stock_count'
      and d.status = 'posted'
      and lower(btrim(d.sku_code_snapshot)) = lower(btrim(v_sku_code))
      and (d.created_at at time zone 'Asia/Ho_Chi_Minh')::date >= v_since
    order by d.created_at desc, d.id desc
    limit 1;

    v_done := found;
    v_total := 1;
    v_left := case when v_done then 0 else 1 end;
    v_detail := jsonb_build_array(jsonb_build_object(
      'kind', 'sku_count',
      'sku_code', v_sku_code,
      'since', v_since,
      'counted_at', v_sku_counted_at,
      'counted_qty', v_sku_counted_qty
    ));

  else
    raise exception 'unknown_check_rule' using errcode = '22023';
  end if;

  return jsonb_build_object(
    'done', v_done,
    'total', v_total,
    'left', v_left,
    'detail', v_detail
  );
end;
$$;

revoke all on function public.mission_evaluate(uuid) from public, anon, authenticated;
grant execute on function public.mission_evaluate(uuid) to service_role;

-- ===========================================================================
-- K. One owner mission for the batch
-- ===========================================================================

do $seed_document_unit_mission$
declare
  v_owner uuid;
begin
  select ur.user_id into v_owner
  from public.user_roles ur
  where ur.role::text = 'owner'
  order by ur.created_at, ur.user_id
  limit 1;

  if v_owner is null then
    raise notice 'document unit mission seed skipped: no owner role';
    return;
  end if;

  insert into public.missions (
    code, area, title, description, assignee_user_id,
    check_rule, check_params, badge_code, sort_order, status, created_by
  ) values (
    'wh-doc-units-20261020',
    'warehouse',
    'Quy đổi đơn vị chứng từ',
    'Trả lời các câu hỏi quy đổi đơn vị chứng từ còn thiếu (lô 2026-10-20)',
    v_owner,
    'document_unit_questions_done',
    jsonb_build_object('batch', '2026-10-20'),
    'cham_chi',
    7,
    'open',
    v_owner
  )
  on conflict (code) do nothing;
end;
$seed_document_unit_mission$;

-- ===========================================================================
-- Baseline fingerprints: no protected document value may change.
-- ===========================================================================

select set_config('smoke.before_po', (
  select md5(coalesce(string_agg(concat_ws('|', id, product_name, quantity, unit_price, line_total), E'\n' order by id), ''))
  from public.purchase_order_items
), true);
select set_config('smoke.before_pr', (
  select md5(coalesce(string_agg(concat_ws('|', id, product_name, quantity, unit_price, line_total), E'\n' order by id), ''))
  from public.payment_request_items
), true);
select set_config('smoke.before_gr', (
  select md5(coalesce(string_agg(concat_ws('|', id, product_name, quantity, actual_quantity, unit_price), E'\n' order by id), ''))
  from public.goods_receipt_items
), true);
select set_config('smoke.before_inv', (
  select md5(coalesce(string_agg(concat_ws('|', id, product_name, quantity, unit_price, line_total), E'\n' order by id), ''))
  from public.invoice_items
), true);
select set_config('smoke.before_canonical', (
  select count(*)::text
  from (
    select canonical_material_id from public.purchase_order_items
    union all
    select canonical_material_id from public.payment_request_items
    union all
    select canonical_material_id from public.goods_receipt_items
    union all
    select canonical_material_id from public.invoice_items
  ) x
  where x.canonical_material_id is not null
), true);

-- ===========================================================================
-- Run the seed as the real owner: dry run first, then the real pass.
-- ===========================================================================

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"27dbc34e-75ee-4973-8f9a-d1b125c90483","role":"authenticated"}',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '27dbc34e-75ee-4973-8f9a-d1b125c90483', true);

select set_config('smoke.dry', public.seed_document_unit_conversions(true)::text, true);
select set_config('smoke.first', public.seed_document_unit_conversions(false)::text, true);

reset role;

-- ===========================================================================
-- Assert the agreed game factors became approved material conversions.
-- ===========================================================================

do $smoke$
declare
  v_material uuid;
  v_default text;
  v_question_total integer;
  v_canonical_before integer := current_setting('smoke.before_canonical')::integer;
  v_canonical_after integer;
  v_alias uuid;
  v_item_id uuid;
  v_item_unit text;
  v_pack_norm text;
  v_step numeric;
  v_expected numeric;
  v_cholimex_names jsonb;
  v_cholimex_question uuid;
begin
  if not exists (
    select 1
    from public.material_unit_conversions c
    join public.sku_cogs_materials m on m.id = c.material_id
    where m.canonical_name ilike '%Găng tay%'
      and lower(btrim(c.from_unit)) = 'hộp'
      and lower(btrim(c.to_unit)) = lower(btrim(m.default_unit))
      and c.factor = 100
      and c.active = true
      and c.approved = true
  ) then
    raise exception 'SMOKE_RESULT FAIL: Găng tay hộp -> cái = 100 was not written';
  end if;

  if not exists (
    select 1
    from public.material_unit_conversions c
    join public.sku_cogs_materials m on m.id = c.material_id
    where m.canonical_name ilike '%Bột mì 888%'
      and lower(btrim(c.from_unit)) = 'kg'
      and lower(btrim(c.to_unit)) = 'bao'
      and c.factor = 0.04
      and c.active = true
      and c.approved = true
  ) then
    raise exception 'SMOKE_RESULT FAIL: Bột mì 888 Cam kg -> bao = 0,04 was not written';
  end if;

  if not exists (
    select 1
    from public.material_unit_conversions c
    join public.sku_cogs_materials m on m.id = c.material_id
    where m.canonical_name ilike '%Hành lá%'
      and lower(btrim(c.from_unit)) = 'gói'
      and lower(btrim(c.to_unit)) = 'kg'
      and c.factor = 0.2
      and c.active = true
      and c.approved = true
  ) then
    raise exception 'SMOKE_RESULT FAIL: Hành lá gói -> Kg = 0,2 was not written';
  end if;

  select m.id into v_material
  from public.sku_cogs_materials m
  where m.canonical_name ilike '%Băng keo lớn%'
  order by m.active desc, m.id
  limit 1;

  if v_material is null then
    raise exception 'SMOKE_RESULT FAIL: Băng keo lớn material not found';
  end if;

  if exists (
    select 1
    from public.material_unit_conversions c
    where c.material_id = v_material
      and lower(btrim(c.from_unit)) = 'cây'
      and lower(btrim(c.to_unit)) = 'cuộn'
      and c.active = true
      and c.approved = true
      and c.source_type = 'document_unit_auto'
  ) then
    raise exception 'SMOKE_RESULT FAIL: Băng keo lớn cây -> cuộn was auto-written';
  end if;

  if not exists (
    select 1
    from public.document_unit_questions q
    where q.material_id = v_material
      and q.doc_unit_normalized = 'cây'
      and q.status = 'open'
      and jsonb_array_length(q.candidates) = 2
  ) then
    raise exception 'SMOKE_RESULT FAIL: Băng keo lớn has no open question with two candidates';
  end if;

  select count(*) into v_question_total
  from public.document_unit_questions q
  where q.batch = '2026-10-20';

  if v_question_total < 15 or v_question_total > 45 then
    raise exception 'SMOKE_RESULT FAIL: batch 2026-10-20 has % questions (expected 15..45)', v_question_total;
  end if;

  select count(*) into v_canonical_after
  from (
    select canonical_material_id from public.purchase_order_items
    union all
    select canonical_material_id from public.payment_request_items
    union all
    select canonical_material_id from public.goods_receipt_items
    union all
    select canonical_material_id from public.invoice_items
  ) x
  where x.canonical_material_id is not null;

  if v_canonical_after <= v_canonical_before then
    raise exception 'SMOKE_RESULT FAIL: canonical_material_id count did not increase (% -> %)',
      v_canonical_before, v_canonical_after;
  end if;

  -- A game label edit must write/update the material conversion by the same chain.
  select a.id, a.kitchen_inventory_item_id
  into v_alias, v_item_id
  from public.stock_material_aliases a
  join public.kitchen_inventory_items k on k.id = a.kitchen_inventory_item_id
  where a.line_class = 'stock'
    and k.canonical_material_id is not null
    and public.normalize_document_unit(a.pack_label) is not null
    -- The chosen label must still agree with every other label for this
    -- material/name, otherwise the trigger correctly opens a question.
    and jsonb_array_length(public.document_unit_factor_candidates(
      k.canonical_material_id, a.pack_label, a.supplier_id, a.normalized_name
    )) = 1
    and public.document_unit_factor_candidates(
      k.canonical_material_id, a.pack_label, a.supplier_id, a.normalized_name
    ) -> 0 ->> 'source' = 'game_alias_factor'
    -- Prefer the Găng tay label from the assertion above, but any stock label
    -- whose pair is not owner-approved can exercise the trigger rule.
    and not exists (
      select 1
      from public.material_unit_conversions c
      join public.sku_cogs_materials m on m.id = k.canonical_material_id
      where c.material_id = k.canonical_material_id
        and lower(btrim(c.from_unit)) = public.normalize_document_unit(a.pack_label)
        and lower(btrim(c.to_unit)) = lower(btrim(m.default_unit))
        and c.active = true
        and c.approved = true
        and (c.source_type is null or c.source_type not in (
          'game_alias_factor', 'document_unit_auto', 'standard_auto', 'misread_standard'
        ))
    )
  order by (a.normalized_name = public.normalize_stock_item_name('Găng tay')) desc, a.id
  limit 1;

  if v_alias is null then
    raise exception 'SMOKE_RESULT FAIL: no editable stock label with a canonical material';
  end if;

  select k.canonical_material_id, k.unit
  into v_material, v_item_unit
  from public.kitchen_inventory_items k
  where k.id = v_item_id;

  select m.default_unit into v_default
  from public.sku_cogs_materials m
  where m.id = v_material;

  select public.normalize_document_unit(a.pack_label)
  into v_pack_norm
  from public.stock_material_aliases a
  where a.id = v_alias;

  -- Capture the item -> material step before the edit: if the item unit is the
  -- same as the pack unit, the trigger updates that very conversion.
  v_step := public.document_unit_to_material_factor(v_material, v_item_unit);
  if v_step is null then
    raise exception 'SMOKE_RESULT FAIL: item -> material step is null for the edited label';
  end if;
  v_expected := round(101 * v_step, 6);

  -- Edit every label of this item/name/pack in one statement (AFTER ROW
  -- triggers run once all rows changed), so the labels still agree. Editing
  -- just one of two agreeing labels is a disagreement and opens a question.
  update public.stock_material_aliases a
  set conversion_factor = 101, updated_at = now()
  from public.stock_material_aliases s
  where s.id = v_alias
    and a.kitchen_inventory_item_id = s.kitchen_inventory_item_id
    and a.normalized_name = s.normalized_name
    and a.line_class = 'stock'
    and public.normalize_document_unit(a.pack_label) = v_pack_norm;

  if not exists (
    select 1
    from public.material_unit_conversions c
    where c.material_id = v_material
      and lower(btrim(c.from_unit)) = v_pack_norm
      and lower(btrim(c.to_unit)) = lower(btrim(v_default))
      and c.factor = v_expected
      and c.active = true
      and c.approved = true
      and c.source_type = 'game_alias_factor'
      and c.metadata ->> 'factor_source' = 'game_alias_factor'
  ) then
    raise exception 'SMOKE_RESULT FAIL: game label edit did not write game_alias_factor % for unit % (step %)',
      v_expected, v_pack_norm, v_step;
  end if;

  -- The Cholimex case (Tương ớt Cholimex gói 10g) is deliberately left for the owner.
  if not exists (
    select 1
    from public.sku_cogs_materials m
    where m.id = '808361da-6b7e-4bae-a803-329b789aac5d'
      and m.canonical_name ilike '%Cholimex%'
  ) then
    raise exception 'SMOKE_RESULT FAIL: Cholimex material 808361da not found';
  end if;

  select coalesce(jsonb_agg(distinct p.normalized_name), '[]'::jsonb)
  into v_cholimex_names
  from public.document_unit_mismatch_pairs_internal() p
  where p.material_id = '808361da-6b7e-4bae-a803-329b789aac5d'
    and p.doc_unit_normalized = 'thùng';

  if jsonb_array_length(v_cholimex_names) = 0 then
    raise exception 'SMOKE_RESULT FAIL: no unlinked Cholimex thùng lines found';
  end if;
  perform set_config('smoke.cholimex_names', v_cholimex_names::text, true);

  select q.id into v_cholimex_question
  from public.document_unit_questions q
  where q.material_id = '808361da-6b7e-4bae-a803-329b789aac5d'
    and q.doc_unit_normalized = 'thùng'
    and q.status = 'open'
  order by q.created_at, q.id
  limit 1;

  if v_cholimex_question is null then
    raise exception 'SMOKE_RESULT FAIL: no open Cholimex thùng question';
  end if;
  perform set_config('smoke.cholimex_q', v_cholimex_question::text, true);
end;
$smoke$;

-- ===========================================================================
-- Answer the Cholimex "thùng" question with the owner factor 180.
-- ===========================================================================

set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"27dbc34e-75ee-4973-8f9a-d1b125c90483","role":"authenticated"}',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '27dbc34e-75ee-4973-8f9a-d1b125c90483', true);

select set_config(
  'smoke.answer',
  public.answer_document_unit_question(
    current_setting('smoke.cholimex_q')::uuid,
    'factor',
    180,
    null,
    'smoke: Cholimex thùng = 180 gói'
  )::text,
  true
);

reset role;

-- ===========================================================================
-- The answered lines are linked and a second seed writes nothing.
-- ===========================================================================

do $smoke_after$
declare
  v_linked integer;
  v_total integer;
begin
  if not exists (
    select 1
    from public.document_unit_questions q
    where q.id = current_setting('smoke.cholimex_q')::uuid
      and q.status = 'answered'
      and q.action = 'factor'
      and q.factor = 180
  ) then
    raise exception 'SMOKE_RESULT FAIL: Cholimex question was not answered with 180';
  end if;

  if not exists (
    select 1
    from public.material_unit_conversions c
    where c.material_id = '808361da-6b7e-4bae-a803-329b789aac5d'
      and lower(btrim(c.from_unit)) = 'thùng'
      and c.factor = 180
      and c.active = true
      and c.approved = true
      and c.source_type = 'document_unit_question'
      and c.metadata ->> 'factor_source' = 'owner_factor_doc'
  ) then
    raise exception 'SMOKE_RESULT FAIL: owner conversion thùng -> 180 was not written';
  end if;

  select
    count(*) filter (where x.canonical_material_id = '808361da-6b7e-4bae-a803-329b789aac5d'),
    count(*)
  into v_linked, v_total
  from (
    select poi.canonical_material_id
    from public.purchase_order_items poi
    join public.purchase_orders po on po.id = poi.purchase_order_id
    where public.normalize_stock_item_name(
            coalesce(nullif(btrim(poi.raw_product_name), ''), poi.product_name)
          ) in (select jsonb_array_elements_text(current_setting('smoke.cholimex_names')::jsonb))
      and lower(btrim(poi.unit)) = 'thùng'
    union all
    select pri.canonical_material_id
    from public.payment_request_items pri
    join public.payment_requests pr on pr.id = pri.payment_request_id
    where public.normalize_stock_item_name(
            coalesce(nullif(btrim(pri.raw_product_name), ''), pri.product_name)
          ) in (select jsonb_array_elements_text(current_setting('smoke.cholimex_names')::jsonb))
      and lower(btrim(pri.unit)) = 'thùng'
    union all
    select gri.canonical_material_id
    from public.goods_receipt_items gri
    join public.goods_receipts gr on gr.id = gri.goods_receipt_id
    where public.normalize_stock_item_name(
            coalesce(nullif(btrim(gri.raw_product_name), ''), gri.product_name)
          ) in (select jsonb_array_elements_text(current_setting('smoke.cholimex_names')::jsonb))
      and lower(btrim(gri.unit)) = 'thùng'
    union all
    select ii.canonical_material_id
    from public.invoice_items ii
    join public.invoices inv on inv.id = ii.invoice_id
    where public.normalize_stock_item_name(
            coalesce(nullif(btrim(ii.raw_product_name), ''), ii.product_name)
          ) in (select jsonb_array_elements_text(current_setting('smoke.cholimex_names')::jsonb))
      and lower(btrim(ii.unit)) = 'thùng'
  ) x;

  if v_total = 0 then
    raise exception 'SMOKE_RESULT FAIL: no Cholimex thùng line to verify';
  end if;
  if v_linked <> v_total then
    raise exception 'SMOKE_RESULT FAIL: only %/% Cholimex thùng lines linked to 808361da',
      v_linked, v_total;
  end if;
end;
$smoke_after$;

-- The second seed runs after the answer (some questions stay open, but every
-- agreed conversion already exists, so it must write nothing).
set local role authenticated;
select set_config(
  'request.jwt.claims',
  '{"sub":"27dbc34e-75ee-4973-8f9a-d1b125c90483","role":"authenticated"}',
  true
);
select set_config('request.jwt.claim.role', 'authenticated', true);
select set_config('request.jwt.claim.sub', '27dbc34e-75ee-4973-8f9a-d1b125c90483', true);
select set_config('smoke.second', public.seed_document_unit_conversions(false)::text, true);
reset role;

do $smoke_second$
declare
  v_second jsonb := current_setting('smoke.second', true)::jsonb;
begin
  if v_second is null then
    raise exception 'SMOKE_RESULT FAIL: second seed result missing';
  end if;
  if coalesce((v_second ->> 'written_total')::integer, -1) <> 0 then
    raise exception 'SMOKE_RESULT FAIL: second seed wrote % conversions', v_second ->> 'written_total';
  end if;
  if coalesce(v_second -> 'written', '{}'::jsonb) <> '{}'::jsonb then
    raise exception 'SMOKE_RESULT FAIL: second seed wrote by source: %', v_second -> 'written';
  end if;
end;
$smoke_second$;

-- ===========================================================================
-- Product names / quantities / prices / totals are byte-for-byte unchanged.
-- ===========================================================================

select set_config('smoke.after_po', (
  select md5(coalesce(string_agg(concat_ws('|', id, product_name, quantity, unit_price, line_total), E'\n' order by id), ''))
  from public.purchase_order_items
), true);
select set_config('smoke.after_pr', (
  select md5(coalesce(string_agg(concat_ws('|', id, product_name, quantity, unit_price, line_total), E'\n' order by id), ''))
  from public.payment_request_items
), true);
select set_config('smoke.after_gr', (
  select md5(coalesce(string_agg(concat_ws('|', id, product_name, quantity, actual_quantity, unit_price), E'\n' order by id), ''))
  from public.goods_receipt_items
), true);
select set_config('smoke.after_inv', (
  select md5(coalesce(string_agg(concat_ws('|', id, product_name, quantity, unit_price, line_total), E'\n' order by id), ''))
  from public.invoice_items
), true);

do $smoke_digest$
begin
  if current_setting('smoke.before_po') is distinct from current_setting('smoke.after_po') then
    raise exception 'SMOKE_RESULT FAIL: purchase_order_items protected values changed';
  end if;
  if current_setting('smoke.before_pr') is distinct from current_setting('smoke.after_pr') then
    raise exception 'SMOKE_RESULT FAIL: payment_request_items protected values changed';
  end if;
  if current_setting('smoke.before_gr') is distinct from current_setting('smoke.after_gr') then
    raise exception 'SMOKE_RESULT FAIL: goods_receipt_items protected values changed';
  end if;
  if current_setting('smoke.before_inv') is distinct from current_setting('smoke.after_inv') then
    raise exception 'SMOKE_RESULT FAIL: invoice_items protected values changed';
  end if;
end;
$smoke_digest$;

select json_build_object(
  'smoke', 'SMOKE_RESULT PASS',
  'dry_run', current_setting('smoke.dry')::jsonb,
  'first_run', current_setting('smoke.first')::jsonb,
  'second_run', current_setting('smoke.second')::jsonb,
  'questions_total', (
    select count(*)::integer from public.document_unit_questions where batch = '2026-10-20'
  ),
  'questions_open', (
    select count(*)::integer from public.document_unit_questions
    where batch = '2026-10-20' and status = 'open'
  ),
  'canonical_before', current_setting('smoke.before_canonical')::integer,
  'canonical_after', (
    select count(*)::integer
    from (
      select canonical_material_id from public.purchase_order_items
      union all
      select canonical_material_id from public.payment_request_items
      union all
      select canonical_material_id from public.goods_receipt_items
      union all
      select canonical_material_id from public.invoice_items
    ) x
    where x.canonical_material_id is not null
  ),
  'cholimex_answer', current_setting('smoke.answer')::jsonb
) as result;

rollback;
