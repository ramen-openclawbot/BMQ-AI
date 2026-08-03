-- Canonical SKU COGS materials, effective-dated history, and Imperial -> Peerless cutover.
-- Business cutover: first linked/actual Peerless receipt date 2026-06-12 (GRN-000303).

create table if not exists public.sku_cogs_materials (
  id uuid primary key default gen_random_uuid(),
  material_code text not null unique,
  canonical_name text not null,
  normalized_name text not null unique,
  default_unit text not null default 'g',
  ingredient_sku_id uuid references public.product_skus(id) on delete set null,
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.sku_cogs_material_aliases (
  id uuid primary key default gen_random_uuid(),
  material_id uuid not null references public.sku_cogs_materials(id) on delete cascade,
  alias_name text not null,
  normalized_alias text not null unique,
  source text not null default 'approved',
  active boolean not null default true,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.sku_cogs_versions (
  id uuid primary key default gen_random_uuid(),
  sku_id uuid not null references public.product_skus(id) on delete cascade,
  version_no integer not null,
  effective_from date not null,
  effective_to date,
  change_reason text not null,
  product_snapshot jsonb not null default '{}'::jsonb,
  changed_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint sku_cogs_versions_period_check check (effective_to is null or effective_to >= effective_from),
  constraint sku_cogs_versions_sku_version_key unique (sku_id, version_no)
);

create unique index if not exists uq_sku_cogs_versions_current
  on public.sku_cogs_versions(sku_id)
  where effective_to is null;

create table if not exists public.sku_cogs_version_formulations (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null references public.sku_cogs_versions(id) on delete cascade,
  source_formulation_id uuid,
  canonical_material_id uuid references public.sku_cogs_materials(id) on delete restrict,
  ingredient_sku_id uuid references public.product_skus(id) on delete set null,
  ingredient_name text not null,
  raw_ocr_name text,
  material_code text not null,
  unit text not null,
  unit_price numeric not null,
  dosage_qty numeric not null,
  wastage_percent numeric not null default 0,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

alter table public.sku_formulations
  add column if not exists canonical_material_id uuid references public.sku_cogs_materials(id) on delete restrict,
  add column if not exists raw_ocr_name text,
  add column if not exists effective_from date;

-- Seed the approved current Peerless identity first.
insert into public.sku_cogs_materials (
  material_code, canonical_name, normalized_name, default_unit, ingredient_sku_id, active
)
select
  'NVL-PEERLESS-UC-25KG',
  'Peerless Úc 25kg',
  public.normalize_ocr_cost_key('Peerless Úc 25kg'),
  'g',
  ps.id,
  true
from public.product_skus ps
where ps.sku_code = 'NL-G-PEERLESSUC25-KG'
limit 1
on conflict (material_code) do update set
  canonical_name = excluded.canonical_name,
  normalized_name = excluded.normalized_name,
  default_unit = excluded.default_unit,
  ingredient_sku_id = excluded.ingredient_sku_id,
  active = true,
  updated_at = now();

-- Preserve Imperial as an inactive historical material, never as a current picker option.
insert into public.sku_cogs_materials (
  material_code, canonical_name, normalized_name, default_unit, ingredient_sku_id, active
)
values (
  'NVL-BO-IMPERIAL',
  'Bơ Imperial',
  public.normalize_ocr_cost_key('Bơ Imperial'),
  'g',
  null,
  false
)
on conflict (material_code) do update set active = false, updated_at = now();

-- Owner-reviewed OCR/COGS mappings define the preferred canonical display name
-- whenever several historical aliases already share one material code.
insert into public.sku_cogs_materials (
  material_code, canonical_name, normalized_name, default_unit, ingredient_sku_id, active
)
select distinct on (mapping.standard_cost_code)
  mapping.standard_cost_code,
  mapping.canonical_cost_item_name,
  public.normalize_ocr_cost_key(mapping.canonical_cost_item_name),
  'g',
  null,
  true
from public.cost_item_alias_mappings mapping
where mapping.active = true
  and mapping.standard_cost_code_type = 'NVL'
  and nullif(btrim(mapping.standard_cost_code), '') is not null
  and nullif(btrim(mapping.canonical_cost_item_name), '') is not null
  and mapping.standard_cost_code <> 'NVL-BO-IMPERIAL'
order by mapping.standard_cost_code, mapping.updated_at desc nulls last, mapping.id
on conflict do nothing;

-- Seed all other material identities already declared in COGS. Known Imperial
-- variants are excluded because they belong to the inactive historical identity.
insert into public.sku_cogs_materials (
  material_code, canonical_name, normalized_name, default_unit, ingredient_sku_id, active
)
select distinct on (public.normalize_ocr_cost_key(f.ingredient_name))
  coalesce(nullif(btrim(f.material_code), ''), public.generate_sku_material_code(f.ingredient_name)),
  f.ingredient_name,
  public.normalize_ocr_cost_key(f.ingredient_name),
  coalesce(nullif(btrim(f.unit), ''), 'g'),
  f.ingredient_sku_id,
  true
from public.sku_formulations f
where public.normalize_ocr_cost_key(f.ingredient_name) <> ''
  and public.normalize_ocr_cost_key(f.ingredient_name) not like '%imperial%'
  and public.normalize_ocr_cost_key(f.ingredient_name) <> public.normalize_ocr_cost_key('Peerless Úc 25kg')
order by public.normalize_ocr_cost_key(f.ingredient_name), f.updated_at desc, f.id
on conflict do nothing;

-- Canonical names and approved aliases resolve by exact accent/case/punctuation-normalized key.
insert into public.sku_cogs_material_aliases (material_id, alias_name, normalized_alias, source, active)
select id, canonical_name, normalized_name, 'canonical_name', active
from public.sku_cogs_materials
on conflict (normalized_alias) do update set
  material_id = excluded.material_id,
  alias_name = excluded.alias_name,
  source = excluded.source,
  active = excluded.active;

insert into public.sku_cogs_material_aliases (material_id, alias_name, normalized_alias, source, active)
select distinct on (public.normalize_ocr_cost_key(f.ingredient_name))
  m.id,
  f.ingredient_name,
  public.normalize_ocr_cost_key(f.ingredient_name),
  'existing_cogs',
  m.active
from public.sku_formulations f
join public.sku_cogs_materials m
  on m.material_code = coalesce(nullif(btrim(f.material_code), ''), public.generate_sku_material_code(f.ingredient_name))
where public.normalize_ocr_cost_key(f.ingredient_name) <> ''
  and public.normalize_ocr_cost_key(f.ingredient_name) not like '%imperial%'
order by public.normalize_ocr_cost_key(f.ingredient_name), m.active desc, f.updated_at desc, f.id
on conflict (normalized_alias) do update set
  material_id = excluded.material_id,
  alias_name = excluded.alias_name,
  source = excluded.source,
  active = excluded.active;

insert into public.sku_cogs_material_aliases (material_id, alias_name, normalized_alias, source, active)
select distinct on (public.normalize_ocr_cost_key(alias_name))
  peerless.id, alias_name, public.normalize_ocr_cost_key(alias_name), 'approved_peerless_alias', true
from public.sku_cogs_materials peerless
cross join (values
  ('BƠ PEERLESS'),
  ('BO PEERLESS'),
  ('BỘ PEERLESS'),
  ('BÓ PEERLESS'),
  ('BÒ PEERLESS'),
  ('Peerless Australia Unsalted Butter'),
  ('Peerless Australia Unsalted Butter (ABS) 2.5kg - Bơ lạt 2,5kg')
) aliases(alias_name)
where peerless.material_code = 'NVL-PEERLESS-UC-25KG'
order by public.normalize_ocr_cost_key(alias_name),
  case when alias_name = 'BƠ PEERLESS' then 0 else 1 end,
  alias_name
on conflict (normalized_alias) do update set
  material_id = excluded.material_id,
  alias_name = excluded.alias_name,
  source = excluded.source,
  active = true;

-- Link current non-Imperial formulations to the canonical registry before history capture.
update public.sku_formulations f
set canonical_material_id = a.material_id,
    effective_from = case
      when public.normalize_ocr_cost_key(f.ingredient_name) like '%peerless%' then date '2026-06-12'
      else coalesce(f.effective_from, f.created_at::date)
    end
from public.sku_cogs_material_aliases a
where a.normalized_alias = public.normalize_ocr_cost_key(f.ingredient_name)
  and public.normalize_ocr_cost_key(f.ingredient_name) not like '%imperial%';

-- Level-2 rows can reuse an already-approved child material alias.
update public.sku_formulations f
set canonical_material_id = a.material_id,
    effective_from = coalesce(f.effective_from, f.created_at::date)
from public.sku_cogs_material_aliases a
where f.canonical_material_id is null
  and position(' > ' in f.ingredient_name) > 0
  and a.normalized_alias = public.normalize_ocr_cost_key(split_part(f.ingredient_name, ' > ', 2))
  and public.normalize_ocr_cost_key(f.ingredient_name) not like '%imperial%';

-- Archive every currently affected SKU before replacing Imperial. This is the
-- first durable old-formula snapshot; the legacy schema had only updated_at.
insert into public.sku_cogs_versions (
  sku_id, version_no, effective_from, effective_to, change_reason, product_snapshot
)
select
  affected.sku_id,
  1,
  least(coalesce(min(f.created_at)::date, date '2026-06-11'), date '2026-06-11'),
  date '2026-06-11',
  'Công thức trước khi chuyển Bơ Imperial sang Peerless',
  to_jsonb(ps)
from (
  -- Include rows already changed manually to Peerless before deployment so
  -- their pre-cutover Imperial formula is still represented in history.
  select distinct sku_id
  from public.sku_formulations
  where public.normalize_ocr_cost_key(ingredient_name) like '%imperial%'
     or public.normalize_ocr_cost_key(ingredient_name) like '%peerless%'
) affected
join public.product_skus ps on ps.id = affected.sku_id
join public.sku_formulations f on f.sku_id = affected.sku_id
group by affected.sku_id, ps.id
on conflict (sku_id, version_no) do nothing;

insert into public.sku_cogs_version_formulations (
  version_id, source_formulation_id, canonical_material_id, ingredient_sku_id,
  ingredient_name, raw_ocr_name, material_code, unit, unit_price,
  dosage_qty, wastage_percent, sort_order
)
select
  v.id,
  f.id,
  case
    when public.normalize_ocr_cost_key(f.ingredient_name) like '%imperial%'
      or public.normalize_ocr_cost_key(f.ingredient_name) like '%peerless%'
      then (select id from public.sku_cogs_materials where material_code = 'NVL-BO-IMPERIAL')
    else f.canonical_material_id
  end,
  case
    when public.normalize_ocr_cost_key(f.ingredient_name) like '%peerless%'
      then (select ingredient_sku_id from public.sku_cogs_materials where material_code = 'NVL-BO-IMPERIAL')
    else f.ingredient_sku_id
  end,
  case
    when public.normalize_ocr_cost_key(f.ingredient_name) like '%peerless%' then
      case
        when position(' > ' in f.ingredient_name) > 0
          then split_part(f.ingredient_name, ' > ', 1) || ' > ' || 'Bơ Imperial'
        else 'Bơ Imperial'
      end
    else f.ingredient_name
  end,
  f.raw_ocr_name,
  case
    when public.normalize_ocr_cost_key(f.ingredient_name) like '%peerless%'
      then 'NVL-BO-IMPERIAL'
    else coalesce(nullif(f.material_code, ''), public.generate_sku_material_code(f.ingredient_name))
  end,
  f.unit,
  case
    when public.normalize_ocr_cost_key(f.ingredient_name) like '%peerless%'
      then 97::numeric
    else f.unit_price
  end,
  f.dosage_qty,
  f.wastage_percent,
  f.sort_order
from public.sku_cogs_versions v
join public.sku_formulations f on f.sku_id = v.sku_id
where v.version_no = 1
  and v.change_reason = 'Công thức trước khi chuyển Bơ Imperial sang Peerless'
  and not exists (
    select 1 from public.sku_cogs_version_formulations vf
    where vf.version_id = v.id and vf.source_formulation_id = f.id
  );

-- Current COGS uses the already-declared Peerless COGS material and price.
update public.sku_formulations f
set canonical_material_id = peerless.id,
    ingredient_sku_id = peerless.ingredient_sku_id,
    raw_ocr_name = coalesce(f.raw_ocr_name, f.ingredient_name),
    ingredient_name = case
      when position(' > ' in f.ingredient_name) > 0
        then split_part(f.ingredient_name, ' > ', 1) || ' > ' || peerless.canonical_name
      else peerless.canonical_name
    end,
    material_code = peerless.material_code,
    unit = 'g',
    unit_price = 83.33,
    effective_from = date '2026-06-12',
    updated_at = now()
from public.sku_cogs_materials peerless
where peerless.material_code = 'NVL-PEERLESS-UC-25KG'
  and public.normalize_ocr_cost_key(f.ingredient_name) like '%imperial%';

-- Ensure already-current Peerless rows share the same canonical identity/cutover.
update public.sku_formulations f
set canonical_material_id = peerless.id,
    ingredient_sku_id = peerless.ingredient_sku_id,
    ingredient_name = case
      when position(' > ' in f.ingredient_name) > 0
        then split_part(f.ingredient_name, ' > ', 1) || ' > ' || peerless.canonical_name
      else peerless.canonical_name
    end,
    material_code = peerless.material_code,
    effective_from = date '2026-06-12',
    updated_at = now()
from public.sku_cogs_materials peerless
where peerless.material_code = 'NVL-PEERLESS-UC-25KG'
  and public.normalize_ocr_cost_key(f.ingredient_name) like '%peerless%';

-- Save the new active snapshot for SKUs migrated in this release.
insert into public.sku_cogs_versions (
  sku_id, version_no, effective_from, effective_to, change_reason, product_snapshot
)
select
  old.sku_id,
  2,
  date '2026-06-12',
  null,
  'Chuyển Bơ Imperial sang Peerless theo ngày nhập kho đầu tiên',
  to_jsonb(ps)
from public.sku_cogs_versions old
join public.product_skus ps on ps.id = old.sku_id
where old.version_no = 1
  and old.change_reason = 'Công thức trước khi chuyển Bơ Imperial sang Peerless'
on conflict (sku_id, version_no) do nothing;

insert into public.sku_cogs_version_formulations (
  version_id, source_formulation_id, canonical_material_id, ingredient_sku_id,
  ingredient_name, raw_ocr_name, material_code, unit, unit_price,
  dosage_qty, wastage_percent, sort_order
)
select
  v.id, f.id, f.canonical_material_id, f.ingredient_sku_id,
  f.ingredient_name, f.raw_ocr_name, f.material_code, f.unit, f.unit_price,
  f.dosage_qty, f.wastage_percent, f.sort_order
from public.sku_cogs_versions v
join public.sku_formulations f on f.sku_id = v.sku_id
where v.version_no = 2
  and v.change_reason = 'Chuyển Bơ Imperial sang Peerless theo ngày nhập kho đầu tiên'
  and not exists (
    select 1 from public.sku_cogs_version_formulations vf
    where vf.version_id = v.id and vf.source_formulation_id = f.id
  );

-- Establish a current baseline version for every other existing SKU COGS so
-- future edits always have a visible before/after chain.
insert into public.sku_cogs_versions (
  sku_id, version_no, effective_from, effective_to, change_reason, product_snapshot
)
select
  ps.id,
  coalesce(max(existing.version_no), 0) + 1,
  coalesce(min(f.effective_from), min(f.created_at)::date, current_date),
  null,
  'Baseline công thức COGS khi bật lịch sử phiên bản',
  to_jsonb(ps)
from public.product_skus ps
join public.sku_formulations f on f.sku_id = ps.id
left join public.sku_cogs_versions existing on existing.sku_id = ps.id
where not exists (
  select 1 from public.sku_cogs_versions current_version
  where current_version.sku_id = ps.id and current_version.effective_to is null
)
group by ps.id;

insert into public.sku_cogs_version_formulations (
  version_id, source_formulation_id, canonical_material_id, ingredient_sku_id,
  ingredient_name, raw_ocr_name, material_code, unit, unit_price,
  dosage_qty, wastage_percent, sort_order
)
select
  v.id, f.id, f.canonical_material_id, f.ingredient_sku_id,
  f.ingredient_name, f.raw_ocr_name, f.material_code, f.unit, f.unit_price,
  f.dosage_qty, f.wastage_percent, f.sort_order
from public.sku_cogs_versions v
join public.sku_formulations f on f.sku_id = v.sku_id
where v.effective_to is null
  and not exists (
    select 1 from public.sku_cogs_version_formulations vf
    where vf.version_id = v.id and vf.source_formulation_id = f.id
  );

create or replace function public.validate_sku_formulation_canonical_material()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  material_row public.sku_cogs_materials%rowtype;
  parent_name text;
begin
  select * into material_row
  from public.sku_cogs_materials
  where id = new.canonical_material_id and active = true;

  if not found then
    raise exception 'NVL phải được chọn từ danh mục Giá vốn. Vui lòng liên hệ bộ phận quản trị.'
      using errcode = '23514';
  end if;

  parent_name := case
    when position(' > ' in coalesce(new.ingredient_name, '')) > 0
      then split_part(new.ingredient_name, ' > ', 1)
    else null
  end;
  new.ingredient_name := case
    when nullif(btrim(parent_name), '') is not null
      then btrim(parent_name) || ' > ' || material_row.canonical_name
    else material_row.canonical_name
  end;
  new.material_code := material_row.material_code;
  new.ingredient_sku_id := material_row.ingredient_sku_id;
  new.unit := coalesce(nullif(btrim(new.unit), ''), material_row.default_unit);
  new.effective_from := coalesce(new.effective_from, current_date);
  return new;
end;
$$;

drop trigger if exists trg_validate_sku_formulation_canonical_material on public.sku_formulations;
create trigger trg_validate_sku_formulation_canonical_material
before insert or update of canonical_material_id, ingredient_name, material_code, ingredient_sku_id
on public.sku_formulations
for each row execute function public.validate_sku_formulation_canonical_material();

create or replace function public.save_sku_cogs(
  p_sku_id uuid,
  p_sku_updates jsonb,
  p_formulations jsonb,
  p_effective_from date default current_date,
  p_change_reason text default 'Cập nhật SKU COGS'
)
returns table(saved_sku_id uuid, version_id uuid, version_no integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_id uuid := auth.uid();
  target_sku_id uuid := p_sku_id;
  next_version integer;
  new_version_id uuid;
  current_version_id uuid;
  current_effective_from date;
  item jsonb;
begin
  if actor_id is null or not (
    public.has_role(actor_id, 'owner')
    or public.has_role(actor_id, 'staff')
    or public.has_role(actor_id, 'warehouse')
  ) then
    raise exception 'Không có quyền cập nhật SKU COGS' using errcode = '42501';
  end if;

  if p_effective_from is null then
    raise exception 'Ngày hiệu lực COGS là bắt buộc' using errcode = '22023';
  end if;

  if nullif(btrim(p_sku_updates->>'sku_code'), '') is null
     or nullif(btrim(p_sku_updates->>'product_name'), '') is null then
    raise exception 'Mã SKU và tên sản phẩm là bắt buộc' using errcode = '22023';
  end if;

  if target_sku_id is null then
    insert into public.product_skus (
      sku_code, product_name, unit, category, base_unit,
      finished_output_qty, finished_output_unit, cost_template,
      cost_values, cost_widgets, hide_from_dealer_portal,
      sku_type, created_by
    ) values (
      btrim(p_sku_updates->>'sku_code'),
      btrim(p_sku_updates->>'product_name'),
      nullif(p_sku_updates->>'unit', ''),
      coalesce(nullif(p_sku_updates->>'category', ''), 'Thành phẩm'),
      nullif(p_sku_updates->>'base_unit', ''),
      coalesce((p_sku_updates->>'finished_output_qty')::numeric, 1),
      nullif(p_sku_updates->>'finished_output_unit', ''),
      p_sku_updates->'cost_template',
      p_sku_updates->'cost_values',
      p_sku_updates->'cost_widgets',
      coalesce((p_sku_updates->>'hide_from_dealer_portal')::boolean, false),
      'finished_good',
      actor_id
    ) returning id into target_sku_id;
  else
    perform 1 from public.product_skus where id = target_sku_id for update;
    if not found then
      raise exception 'SKU không tồn tại' using errcode = 'P0002';
    end if;
  end if;

  if jsonb_typeof(coalesce(p_formulations, '[]'::jsonb)) <> 'array' then
    raise exception 'Danh sách NVL không hợp lệ' using errcode = '22023';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(coalesce(p_formulations, '[]'::jsonb)) x
    left join public.sku_cogs_materials m
      on m.id = nullif(x->>'canonical_material_id', '')::uuid and m.active = true
    where m.id is null
  ) then
    raise exception 'NVL phải được chọn từ danh mục Giá vốn. Vui lòng liên hệ bộ phận quản trị.'
      using errcode = '23514';
  end if;

  select id, effective_from into current_version_id, current_effective_from
  from public.sku_cogs_versions
  where sku_id = target_sku_id and effective_to is null
  for update;

  if current_version_id is not null then
    if p_effective_from <= current_effective_from then
      raise exception 'Ngày hiệu lực mới phải sau ngày bắt đầu phiên bản hiện tại (%)', current_effective_from
        using errcode = '22023', hint = 'SKU_COGS_EFFECTIVE_DATE_NOT_FORWARD';
    end if;

    update public.sku_cogs_versions
    set effective_to = p_effective_from - 1
    where id = current_version_id;
  elsif exists (select 1 from public.sku_formulations where sku_id = target_sku_id) then
    select coalesce(max(v.version_no), 0) + 1 into next_version
    from public.sku_cogs_versions v where v.sku_id = target_sku_id;

    insert into public.sku_cogs_versions (
      sku_id, version_no, effective_from, effective_to, change_reason,
      product_snapshot, changed_by
    )
    select target_sku_id, next_version,
      least(coalesce(min(f.effective_from), min(f.created_at)::date, p_effective_from - 1), p_effective_from - 1),
      p_effective_from - 1,
      'Tự động lưu công thức trước khi chỉnh sửa',
      to_jsonb(ps), actor_id
    from public.product_skus ps
    join public.sku_formulations f on f.sku_id = ps.id
    where ps.id = target_sku_id
    group by ps.id
    returning id into current_version_id;

    insert into public.sku_cogs_version_formulations (
      version_id, source_formulation_id, canonical_material_id, ingredient_sku_id,
      ingredient_name, raw_ocr_name, material_code, unit, unit_price,
      dosage_qty, wastage_percent, sort_order
    )
    select current_version_id, f.id, f.canonical_material_id, f.ingredient_sku_id,
      f.ingredient_name, f.raw_ocr_name, f.material_code, f.unit, f.unit_price,
      f.dosage_qty, f.wastage_percent, f.sort_order
    from public.sku_formulations f where f.sku_id = target_sku_id;
  end if;

  update public.product_skus
  set sku_code = coalesce(nullif(p_sku_updates->>'sku_code', ''), sku_code),
      product_name = coalesce(nullif(p_sku_updates->>'product_name', ''), product_name),
      unit = coalesce(nullif(p_sku_updates->>'unit', ''), unit),
      category = coalesce(nullif(p_sku_updates->>'category', ''), category),
      base_unit = coalesce(nullif(p_sku_updates->>'base_unit', ''), base_unit),
      finished_output_qty = coalesce((p_sku_updates->>'finished_output_qty')::numeric, finished_output_qty),
      finished_output_unit = coalesce(nullif(p_sku_updates->>'finished_output_unit', ''), finished_output_unit),
      cost_template = coalesce(p_sku_updates->'cost_template', cost_template),
      cost_values = coalesce(p_sku_updates->'cost_values', cost_values),
      cost_widgets = coalesce(p_sku_updates->'cost_widgets', cost_widgets),
      hide_from_dealer_portal = coalesce((p_sku_updates->>'hide_from_dealer_portal')::boolean, hide_from_dealer_portal),
      sku_type = 'finished_good',
      updated_at = now()
  where id = target_sku_id;

  delete from public.sku_formulations where sku_id = target_sku_id;

  for item in select value from jsonb_array_elements(coalesce(p_formulations, '[]'::jsonb))
  loop
    insert into public.sku_formulations (
      sku_id, canonical_material_id, ingredient_name, raw_ocr_name,
      material_code, unit, unit_price, dosage_qty, wastage_percent,
      sort_order, effective_from
    ) values (
      target_sku_id,
      (item->>'canonical_material_id')::uuid,
      coalesce(item->>'ingredient_name', ''),
      nullif(item->>'raw_ocr_name', ''),
      coalesce(item->>'material_code', ''),
      coalesce(nullif(item->>'unit', ''), 'g'),
      coalesce((item->>'unit_price')::numeric, 0),
      coalesce((item->>'dosage_qty')::numeric, 0),
      coalesce((item->>'wastage_percent')::numeric, 0),
      coalesce((item->>'sort_order')::integer, 0),
      p_effective_from
    );
  end loop;

  select coalesce(max(v.version_no), 0) + 1 into next_version
  from public.sku_cogs_versions v where v.sku_id = target_sku_id;

  insert into public.sku_cogs_versions (
    sku_id, version_no, effective_from, effective_to, change_reason,
    product_snapshot, changed_by
  )
  select target_sku_id, next_version, p_effective_from, null,
    coalesce(nullif(btrim(p_change_reason), ''), 'Cập nhật SKU COGS'),
    to_jsonb(ps), actor_id
  from public.product_skus ps where ps.id = target_sku_id
  returning id into new_version_id;

  insert into public.sku_cogs_version_formulations (
    version_id, source_formulation_id, canonical_material_id, ingredient_sku_id,
    ingredient_name, raw_ocr_name, material_code, unit, unit_price,
    dosage_qty, wastage_percent, sort_order
  )
  select new_version_id, f.id, f.canonical_material_id, f.ingredient_sku_id,
    f.ingredient_name, f.raw_ocr_name, f.material_code, f.unit, f.unit_price,
    f.dosage_qty, f.wastage_percent, f.sort_order
  from public.sku_formulations f where f.sku_id = target_sku_id;

  return query select target_sku_id, new_version_id, next_version;
end;
$$;

revoke all on function public.save_sku_cogs(uuid, jsonb, jsonb, date, text) from public, anon;
grant execute on function public.save_sku_cogs(uuid, jsonb, jsonb, date, text) to authenticated;

alter table public.sku_cogs_materials enable row level security;
alter table public.sku_cogs_material_aliases enable row level security;
alter table public.sku_cogs_versions enable row level security;
alter table public.sku_cogs_version_formulations enable row level security;

drop policy if exists "sku_cogs_materials_read" on public.sku_cogs_materials;
create policy "sku_cogs_materials_read" on public.sku_cogs_materials
for select to authenticated using (true);

drop policy if exists "sku_cogs_materials_owner_manage" on public.sku_cogs_materials;
create policy "sku_cogs_materials_owner_manage" on public.sku_cogs_materials
for all to authenticated
using (public.has_role((select auth.uid()), 'owner'))
with check (public.has_role((select auth.uid()), 'owner'));

drop policy if exists "sku_cogs_aliases_read" on public.sku_cogs_material_aliases;
create policy "sku_cogs_aliases_read" on public.sku_cogs_material_aliases
for select to authenticated using (true);

drop policy if exists "sku_cogs_aliases_owner_manage" on public.sku_cogs_material_aliases;
create policy "sku_cogs_aliases_owner_manage" on public.sku_cogs_material_aliases
for all to authenticated
using (public.has_role((select auth.uid()), 'owner'))
with check (public.has_role((select auth.uid()), 'owner'));

drop policy if exists "sku_cogs_versions_read" on public.sku_cogs_versions;
create policy "sku_cogs_versions_read" on public.sku_cogs_versions
for select to authenticated
using (
  public.has_role((select auth.uid()), 'owner')
  or public.has_role((select auth.uid()), 'staff')
  or public.has_role((select auth.uid()), 'warehouse')
);

drop policy if exists "sku_cogs_version_formulations_read" on public.sku_cogs_version_formulations;
create policy "sku_cogs_version_formulations_read" on public.sku_cogs_version_formulations
for select to authenticated
using (
  public.has_role((select auth.uid()), 'owner')
  or public.has_role((select auth.uid()), 'staff')
  or public.has_role((select auth.uid()), 'warehouse')
);

create index if not exists idx_sku_formulations_canonical_material
  on public.sku_formulations(canonical_material_id);
create index if not exists idx_sku_cogs_versions_sku_effective
  on public.sku_cogs_versions(sku_id, effective_from desc, version_no desc);
create index if not exists idx_sku_cogs_version_formulations_version
  on public.sku_cogs_version_formulations(version_id, sort_order);
