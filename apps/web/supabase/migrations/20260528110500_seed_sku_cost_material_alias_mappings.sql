-- Seed the owner-reviewed SKU-cost material aliases into DB.
-- This moves the old frontend hardcoded SKU-cost alias table into canonical
-- cost_item_alias_mappings and backfills formula / PR / invoice material codes.

create or replace function public.normalize_ocr_cost_key(value text)
returns text
language sql
immutable
set search_path = public
as $$
  select trim(regexp_replace(regexp_replace(lower(translate(
    coalesce(value, ''),
    'ÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐàáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ',
    'AAAAAAAAAAAAAAAAAEEEEEEEEEEEIIIIIOOOOOOOOOOOOOOOOOUUUUUUUUUUUYYYYYDaaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd'
  )), '[^a-z0-9\s]', ' ', 'g'), '\s+', ' ', 'g'));
$$;

create temp table if not exists reviewed_sku_cost_material_mappings (
  source_name text not null,
  standard_cost_code text not null,
  canonical_cost_item_name text not null,
  unit_conversion_note text not null
) on commit drop;

truncate reviewed_sku_cost_material_mappings;

insert into reviewed_sku_cost_material_mappings (source_name, standard_cost_code, canonical_cost_item_name, unit_conversion_note)
values
  ('Bột mì 888 Cam (25kg)', 'NVL-BOT-MI-888-CAM-25KG', 'Bột mì 888', 'Quy đổi bao 25kg: giá mua / 25000 để ra giá/g'),
  ('Bột mì 888 cam', 'NVL-BOT-MI-888-CAM-25KG', 'Bột mì 888', 'Quy đổi bao 25kg: giá mua / 25000 để ra giá/g'),
  ('bot mi 888 cam', 'NVL-BOT-MI-888-CAM-25KG', 'Bột mì 888', 'Quy đổi bao 25kg: giá mua / 25000 để ra giá/g'),
  ('Bánh bico', 'NVL-CHAT-LAM-MEM-BANH-BICO-1KG', 'Chất làm mềm bánh Bico Soft', 'Quy đổi gói 1kg: giá mua / 1000 để ra giá/g'),
  ('Chất Làm Mềm Bánh Bico (1kg)', 'NVL-CHAT-LAM-MEM-BANH-BICO-1KG', 'Chất làm mềm bánh Bico Soft', 'Quy đổi gói 1kg: giá mua / 1000 để ra giá/g'),
  ('CHẤT LÀM MỀM BÁNH BICO-1KG', 'NVL-CHAT-LAM-MEM-BANH-BICO-1KG', 'Chất làm mềm bánh Bico Soft', 'Quy đổi gói 1kg: giá mua / 1000 để ra giá/g'),
  ('lam mem banh bico', 'NVL-CHAT-LAM-MEM-BANH-BICO-1KG', 'Chất làm mềm bánh Bico Soft', 'Quy đổi gói 1kg: giá mua / 1000 để ra giá/g'),
  ('Muối hồng Vipep xay nhuyễn 200g', 'NVL-MUOI-SAY-KHO', 'Muối sấy khô', 'Quy đổi kg: giá mua / 1000 để ra giá/g nếu chứng từ ghi theo kg'),
  ('Muối', 'NVL-MUOI-SAY-KHO', 'Muối sấy khô', 'Quy đổi kg: giá mua / 1000 để ra giá/g nếu chứng từ ghi theo kg'),
  ('Muối (nhân)', 'NVL-MUOI-SAY-KHO', 'Muối sấy khô', 'Quy đổi kg: giá mua / 1000 để ra giá/g nếu chứng từ ghi theo kg'),
  ('muối sấy khô', 'NVL-MUOI-SAY-KHO', 'Muối sấy khô', 'Quy đổi kg: giá mua / 1000 để ra giá/g nếu chứng từ ghi theo kg'),
  ('muoi say kho', 'NVL-MUOI-SAY-KHO', 'Muối sấy khô', 'Quy đổi kg: giá mua / 1000 để ra giá/g nếu chứng từ ghi theo kg'),
  ('muoi hong vipep', 'NVL-MUOI-SAY-KHO', 'Muối sấy khô', 'Quy đổi kg: giá mua / 1000 để ra giá/g nếu chứng từ ghi theo kg'),
  ('Đường RE An Khê', 'NVL-DUONG-RE-AN-KHUE', 'Đường tinh luyện', 'Quy đổi kg/bao: giá mua / 1000 để ra giá/g nếu chứng từ ghi theo kg'),
  ('Đường RE An Khuê', 'NVL-DUONG-RE-AN-KHUE', 'Đường tinh luyện', 'Quy đổi kg/bao: giá mua / 1000 để ra giá/g nếu chứng từ ghi theo kg'),
  ('Đường', 'NVL-DUONG-RE-AN-KHUE', 'Đường tinh luyện', 'Quy đổi kg/bao: giá mua / 1000 để ra giá/g nếu chứng từ ghi theo kg'),
  ('Đường (nhân)', 'NVL-DUONG-RE-AN-KHUE', 'Đường tinh luyện', 'Quy đổi kg/bao: giá mua / 1000 để ra giá/g nếu chứng từ ghi theo kg'),
  ('duong re an khe', 'NVL-DUONG-RE-AN-KHUE', 'Đường tinh luyện', 'Quy đổi kg/bao: giá mua / 1000 để ra giá/g nếu chứng từ ghi theo kg'),
  ('duong re an khue', 'NVL-DUONG-RE-AN-KHUE', 'Đường tinh luyện', 'Quy đổi kg/bao: giá mua / 1000 để ra giá/g nếu chứng từ ghi theo kg'),
  ('Phụ Gia Làm Bánh Mì Bico Gold (500g)', 'NVL-PHU-GIA-LAM-BANH-MI-BICO-GOLD-500G', 'Phụ gia làm bánh mì Bico Gold', 'Quy đổi gói 500g: giá mua / 500 để ra giá/g'),
  ('PHỤ GIA NGỌT BICO GOLD-500GR', 'NVL-PHU-GIA-LAM-BANH-MI-BICO-GOLD-500G', 'Phụ gia làm bánh mì Bico Gold', 'Quy đổi gói 500g: giá mua / 500 để ra giá/g'),
  ('bico gold', 'NVL-PHU-GIA-LAM-BANH-MI-BICO-GOLD-500G', 'Phụ gia làm bánh mì Bico Gold', 'Quy đổi gói 500g: giá mua / 500 để ra giá/g'),
  ('PHỤ GIA NGỌT MAURI-1KG', 'NVL-PHU-GIA-NGOT-MAURI-1KG', 'Phụ gia BM ngọt Mauri', 'Quy đổi gói 1kg: giá mua / 1000 để ra giá/g'),
  ('Phụ gia ngọt Mauri', 'NVL-PHU-GIA-NGOT-MAURI-1KG', 'Phụ gia BM ngọt Mauri', 'Quy đổi gói 1kg: giá mua / 1000 để ra giá/g'),
  ('phu gia ngot mauri', 'NVL-PHU-GIA-NGOT-MAURI-1KG', 'Phụ gia BM ngọt Mauri', 'Quy đổi gói 1kg: giá mua / 1000 để ra giá/g'),
  ('Men bánh mì tươi Five Star', 'NVL-MEN-KHO-MEIZAN-NHAN-VANG-0-5-10KG-THUN', 'Men khô', 'Quy đổi thùng 0.5kg x 10: giá mua / 10000 để ra giá/g'),
  ('Men Tươi 5 Sao', 'NVL-MEN-KHO-MEIZAN-NHAN-VANG-0-5-10KG-THUN', 'Men khô', 'Quy đổi thùng 0.5kg x 10: giá mua / 10000 để ra giá/g'),
  ('Men Khô Meizan - Nhãn Vàng', 'NVL-MEN-KHO-MEIZAN-NHAN-VANG-0-5-10KG-THUN', 'Men khô', 'Quy đổi thùng 0.5kg x 10: giá mua / 10000 để ra giá/g'),
  ('men kho ngot mauripan', 'NVL-MEN-KHO-MEIZAN-NHAN-VANG-0-5-10KG-THUN', 'Men khô', 'Quy đổi thùng 0.5kg x 10: giá mua / 10000 để ra giá/g'),
  ('men kho', 'NVL-MEN-KHO-MEIZAN-NHAN-VANG-0-5-10KG-THUN', 'Men khô', 'Quy đổi thùng 0.5kg x 10: giá mua / 10000 để ra giá/g'),
  ('Kem sữa Whiping cream tatua', 'NVL-KEM-SUA-WHIPING-CREAM-TATUA', 'Whipping cream', 'Quy đổi hộp 1L/kg: giá mua / 1000 để ra giá/g/ml'),
  ('Kem Sữa Whipping Cream Tatuta 36% 1L / Tatua Whipping Cream 36% 1L', 'NVL-KEM-SUA-WHIPING-CREAM-TATUA', 'Whipping cream', 'Quy đổi hộp 1L/kg: giá mua / 1000 để ra giá/g/ml'),
  ('kem sua whipping cream', 'NVL-KEM-SUA-WHIPING-CREAM-TATUA', 'Whipping cream', 'Quy đổi hộp 1L/kg: giá mua / 1000 để ra giá/g/ml'),
  ('Chicken egg 60gr/ Trứng gà 60gr', 'NVL-TRUNG-GA', 'Trứng gà', 'Quy đổi trứng 60g: giá mua / 60 để ra giá/g khi công thức dùng g'),
  ('Trứng gà', 'NVL-TRUNG-GA', 'Trứng gà', 'Quy đổi trứng 60g: giá mua / 60 để ra giá/g khi công thức dùng g'),
  ('Trứng gà (nhân)', 'NVL-TRUNG-GA', 'Trứng gà', 'Quy đổi trứng 60g: giá mua / 60 để ra giá/g khi công thức dùng g'),
  ('trung ga', 'NVL-TRUNG-GA', 'Trứng gà', 'Quy đổi trứng 60g: giá mua / 60 để ra giá/g khi công thức dùng g'),
  ('chicken egg', 'NVL-TRUNG-GA', 'Trứng gà', 'Quy đổi trứng 60g: giá mua / 60 để ra giá/g khi công thức dùng g'),
  ('Sữa Bột Béo New Zealand (25kg)', 'NVL-SUA-BOT-BEO-NEW-ZEALAND-25KG', 'Bột sữa nguyên chất', 'Quy đổi bao 25kg: giá mua / 25000 để ra giá/g'),
  ('sua bot beo new zealand', 'NVL-SUA-BOT-BEO-NEW-ZEALAND-25KG', 'Bột sữa nguyên chất', 'Quy đổi bao 25kg: giá mua / 25000 để ra giá/g'),
  ('Nước Vihawa 20L Bình Vòi', 'NVL-NUOC-VIHAWA', 'Nước uống Vĩnh Hảo', 'Quy đổi bình 20L: giá mua / 20000 để ra giá/ml'),
  ('Nước Vihawa', 'NVL-NUOC-VIHAWA', 'Nước uống Vĩnh Hảo', 'Quy đổi bình 20L: giá mua / 20000 để ra giá/ml'),
  ('Nước', 'NVL-NUOC-VIHAWA', 'Nước uống Vĩnh Hảo', 'Quy đổi bình 20L: giá mua / 20000 để ra giá/ml'),
  ('nuoc vihawa 20l', 'NVL-NUOC-VIHAWA', 'Nước uống Vĩnh Hảo', 'Quy đổi bình 20L: giá mua / 20000 để ra giá/ml'),
  ('BỘT NGỌT VEYU 25KG F30', 'NVL-BOT-NGOT-VEYU-25KG-F30', 'BỘT NGỌT VEYU 25KG F30', 'Quy đổi bao 25kg: giá mua / 25000 để ra giá/g'),
  ('Bột ngọt', 'NVL-BOT-NGOT-VEYU-25KG-F30', 'BỘT NGỌT VEYU 25KG F30', 'Quy đổi bao 25kg: giá mua / 25000 để ra giá/g'),
  ('bot ngot veyu', 'NVL-BOT-NGOT-VEYU-25KG-F30', 'BỘT NGỌT VEYU 25KG F30', 'Quy đổi bao 25kg: giá mua / 25000 để ra giá/g'),
  ('bot ngot', 'NVL-BOT-NGOT-VEYU-25KG-F30', 'BỘT NGỌT VEYU 25KG F30', 'Quy đổi bao 25kg: giá mua / 25000 để ra giá/g'),
  ('[Thùng] Dầu Hướng Dương Simply 2L x 6 Chai', 'NVL-DAU-HUONG-DUONG-SIMPLY-2L-X-6-CHAI', 'Dầu hướng dương', 'Quy đổi thùng 2L x 6: giá mua / 12000 để ra giá/ml'),
  ('Dầu Hướng Dương Simply 2L x 6 Chai', 'NVL-DAU-HUONG-DUONG-SIMPLY-2L-X-6-CHAI', 'Dầu hướng dương', 'Quy đổi thùng 2L x 6: giá mua / 12000 để ra giá/ml'),
  ('Dầu hướng dương Simply', 'NVL-DAU-HUONG-DUONG-SIMPLY-2L-X-6-CHAI', 'Dầu hướng dương', 'Quy đổi thùng 2L x 6: giá mua / 12000 để ra giá/ml'),
  ('dau huong duong', 'NVL-DAU-HUONG-DUONG-SIMPLY-2L-X-6-CHAI', 'Dầu hướng dương', 'Quy đổi thùng 2L x 6: giá mua / 12000 để ra giá/ml'),
  ('Giấm gạo Lisa AJINOMOLO - Loại 400ml', 'NVL-GIAM-GAO-AJINOMOTO-400ML', 'Giấm Gạo Ajinomoto 400ml', 'Quy đổi chai 400ml: giá mua / 400 để ra giá/ml'),
  ('Giấm gạo Lisa AJINOMOLO', 'NVL-GIAM-GAO-AJINOMOTO-400ML', 'Giấm Gạo Ajinomoto 400ml', 'Quy đổi chai 400ml: giá mua / 400 để ra giá/ml'),
  ('Giấm Gạo Ajinomoto 400ml', 'NVL-GIAM-GAO-AJINOMOTO-400ML', 'Giấm Gạo Ajinomoto 400ml', 'Quy đổi chai 400ml: giá mua / 400 để ra giá/ml'),
  ('giam gao ajinomoto', 'NVL-GIAM-GAO-AJINOMOTO-400ML', 'Giấm Gạo Ajinomoto 400ml', 'Quy đổi chai 400ml: giá mua / 400 để ra giá/ml'),
  ('Chà bông', 'NVL-CHA-BONG', 'Chà bông', 'Quy đổi kg: giá mua / 1000 để ra giá/g nếu chứng từ ghi theo kg'),
  ('Chà bông vàng', 'NVL-CHA-BONG', 'Chà bông', 'Quy đổi kg: giá mua / 1000 để ra giá/g nếu chứng từ ghi theo kg'),
  ('cha bong', 'NVL-CHA-BONG', 'Chà bông', 'Quy đổi kg: giá mua / 1000 để ra giá/g nếu chứng từ ghi theo kg'),
  ('Chà bông cay', 'NVL-CHA-BONG-CAY', 'Chà bông cay', 'Quy đổi kg: giá mua / 1000 để ra giá/g nếu chứng từ ghi theo kg'),
  ('BƠ BUTTERY SPREAD IMPERIAL', 'NVL-BO-BUTTERY-SPREAD-IMPERIAL', 'Bơ Imperial', 'Quy đổi thùng/gói theo quy cách mua; mặc định /970 nếu chứng từ là cây 970g'),
  ('Bơ Buttery Spread Imperial', 'NVL-BO-BUTTERY-SPREAD-IMPERIAL', 'Bơ Imperial', 'Quy đổi thùng/gói theo quy cách mua; mặc định /970 nếu chứng từ là cây 970g'),
  ('bo imperial', 'NVL-BO-BUTTERY-SPREAD-IMPERIAL', 'Bơ Imperial', 'Quy đổi thùng/gói theo quy cách mua; mặc định /970 nếu chứng từ là cây 970g'),
  ('buttery spread imperial', 'NVL-BO-BUTTERY-SPREAD-IMPERIAL', 'Bơ Imperial', 'Quy đổi thùng/gói theo quy cách mua; mặc định /970 nếu chứng từ là cây 970g');

-- One reviewed code per normalized source key. If duplicate aliases normalize to
-- the same key, keep the longest display label but never allow multiple codes.
create temp table if not exists reviewed_sku_cost_material_seed on commit drop as
select distinct on (public.normalize_ocr_cost_key(source_name))
  source_name,
  public.normalize_ocr_cost_key(source_name) as source_name_key,
  standard_cost_code,
  canonical_cost_item_name,
  unit_conversion_note
from reviewed_sku_cost_material_mappings
where public.normalize_ocr_cost_key(source_name) <> ''
order by public.normalize_ocr_cost_key(source_name), length(source_name) desc, source_name, standard_cost_code;

do $$
begin
  if exists (
    select 1
    from reviewed_sku_cost_material_mappings
    group by public.normalize_ocr_cost_key(source_name)
    having count(distinct standard_cost_code) > 1
  ) then
    raise exception 'Reviewed SKU-cost material seed has ambiguous normalized keys';
  end if;
end $$;

-- Owner-reviewed mappings are authoritative for these normalized keys. Deactivate
-- any conflicting active generic alias first so the classifier cannot become ambiguous.
update public.cost_item_alias_mappings existing
set active = false,
    mapping_status = 'inactive',
    source_review_note = concat_ws(' | ', existing.source_review_note, 'Inactive: superseded by owner-reviewed SKU-cost material seed 2026-05-28'),
    updated_at = now()
from reviewed_sku_cost_material_seed seed
where existing.active
  and existing.source_name_key = seed.source_name_key
  and coalesce(existing.supplier_id, '00000000-0000-0000-0000-000000000000'::uuid) = '00000000-0000-0000-0000-000000000000'::uuid
  and existing.standard_cost_code_type = 'NVL'
  and existing.standard_cost_code <> seed.standard_cost_code;

insert into public.cost_item_alias_mappings (
  source_name, source_name_key, supplier_id, standard_cost_code_type,
  standard_cost_code, canonical_cost_item_name, category_code, product_line,
  allocation_rule, unit_conversion_note, mapping_status, active,
  source_review_note, effective_from
)
select
  source_name, source_name_key, null, 'NVL', standard_cost_code,
  canonical_cost_item_name, 'COGS_BMQ_BREAD', 'bmq_bread', 'direct',
  unit_conversion_note, 'approved', true,
  'Owner reviewed frontend SKU-cost hardcode; seeded to DB on 2026-05-28.',
  date '2026-05-28'
from reviewed_sku_cost_material_seed seed
where not exists (
  select 1
  from public.cost_item_alias_mappings existing
  where existing.active
    and existing.source_name_key = seed.source_name_key
    and coalesce(existing.supplier_id, '00000000-0000-0000-0000-000000000000'::uuid) = '00000000-0000-0000-0000-000000000000'::uuid
    and existing.standard_cost_code_type = 'NVL'
    and existing.standard_cost_code = seed.standard_cost_code
);

update public.cost_item_alias_mappings existing
set source_name = seed.source_name,
    canonical_cost_item_name = seed.canonical_cost_item_name,
    category_code = 'COGS_BMQ_BREAD',
    product_line = 'bmq_bread',
    allocation_rule = 'direct',
    unit_conversion_note = seed.unit_conversion_note,
    mapping_status = 'approved',
    active = true,
    source_review_note = 'Owner reviewed frontend SKU-cost hardcode; seeded to DB on 2026-05-28.',
    updated_at = now()
from reviewed_sku_cost_material_seed seed
where existing.source_name_key = seed.source_name_key
  and existing.active
  and coalesce(existing.supplier_id, '00000000-0000-0000-0000-000000000000'::uuid) = '00000000-0000-0000-0000-000000000000'::uuid
  and existing.standard_cost_code_type = 'NVL'
  and existing.standard_cost_code = seed.standard_cost_code
  and (
    existing.source_name,
    existing.canonical_cost_item_name,
    existing.category_code,
    existing.product_line,
    existing.allocation_rule,
    existing.unit_conversion_note,
    existing.mapping_status,
    existing.active,
    existing.source_review_note
  ) is distinct from (
    seed.source_name,
    seed.canonical_cost_item_name,
    'COGS_BMQ_BREAD',
    'bmq_bread',
    'direct',
    seed.unit_conversion_note,
    'approved',
    true,
    'Owner reviewed frontend SKU-cost hardcode; seeded to DB on 2026-05-28.'
  );

-- Backfill formulation material codes only for reviewed names that still have
-- the generated legacy code/null. Do not overwrite a future manually curated code.
update public.sku_formulations formula
set material_code = seed.standard_cost_code,
    updated_at = now()
from reviewed_sku_cost_material_seed seed
where public.normalize_ocr_cost_key(formula.ingredient_name) = seed.source_name_key
  and (
    formula.material_code is null
    or btrim(formula.material_code) = ''
    or formula.material_code = public.generate_sku_material_code(formula.ingredient_name)
  )
  and coalesce(formula.material_code, '') is distinct from seed.standard_cost_code;

-- Backfill historical purchase/payment rows from this deterministic reviewed seed
-- (not from all active aliases), skipping rows already confirmed to another code.
-- Candidate rows must resolve to exactly one reviewed code across raw/name/code fields.
with payment_request_item_candidates as (
  select
    item.id,
    seed.standard_cost_code,
    seed.canonical_cost_item_name,
    seed.unit_conversion_note
  from public.payment_request_items item
  join reviewed_sku_cost_material_seed seed on (
    public.normalize_ocr_cost_key(item.raw_product_name) = seed.source_name_key
    or public.normalize_ocr_cost_key(item.product_name) = seed.source_name_key
    or public.normalize_ocr_cost_key(item.product_code) = seed.source_name_key
  )
  where item.confirmed_standard_cost_code is null or item.confirmed_standard_cost_code = seed.standard_cost_code
), unambiguous_payment_request_items as (
  select
    id,
    (array_agg(distinct standard_cost_code))[1] as standard_cost_code,
    max(canonical_cost_item_name) as canonical_cost_item_name,
    max(unit_conversion_note) as unit_conversion_note
  from payment_request_item_candidates
  group by id
  having count(distinct standard_cost_code) = 1
)
update public.payment_request_items item
set suggested_standard_cost_code = match.standard_cost_code,
    confirmed_standard_cost_code = match.standard_cost_code,
    standard_cost_code_type = 'NVL',
    canonical_cost_item_name = match.canonical_cost_item_name,
    canonical_cost_item_source = 'approved_alias',
    cost_category_code = 'COGS_BMQ_BREAD',
    cost_product_line = 'bmq_bread',
    cost_allocation_rule = 'direct',
    cost_review_routing = 'none',
    unit_conversion_note = match.unit_conversion_note,
    raw_product_name = coalesce(item.raw_product_name, item.product_name)
from unambiguous_payment_request_items match
where item.id = match.id;

with invoice_item_candidates as (
  select
    item.id,
    seed.standard_cost_code,
    seed.canonical_cost_item_name,
    seed.unit_conversion_note
  from public.invoice_items item
  join reviewed_sku_cost_material_seed seed on (
    public.normalize_ocr_cost_key(item.raw_product_name) = seed.source_name_key
    or public.normalize_ocr_cost_key(item.product_name) = seed.source_name_key
    or public.normalize_ocr_cost_key(item.product_code) = seed.source_name_key
  )
  where item.confirmed_standard_cost_code is null or item.confirmed_standard_cost_code = seed.standard_cost_code
), unambiguous_invoice_items as (
  select
    id,
    (array_agg(distinct standard_cost_code))[1] as standard_cost_code,
    max(canonical_cost_item_name) as canonical_cost_item_name,
    max(unit_conversion_note) as unit_conversion_note
  from invoice_item_candidates
  group by id
  having count(distinct standard_cost_code) = 1
)
update public.invoice_items item
set suggested_standard_cost_code = match.standard_cost_code,
    confirmed_standard_cost_code = match.standard_cost_code,
    standard_cost_code_type = 'NVL',
    canonical_cost_item_name = match.canonical_cost_item_name,
    canonical_cost_item_source = 'approved_alias',
    cost_category_code = 'COGS_BMQ_BREAD',
    cost_product_line = 'bmq_bread',
    cost_allocation_rule = 'direct',
    cost_review_routing = 'none',
    unit_conversion_note = match.unit_conversion_note,
    raw_product_name = coalesce(item.raw_product_name, item.product_name)
from unambiguous_invoice_items match
where item.id = match.id;
