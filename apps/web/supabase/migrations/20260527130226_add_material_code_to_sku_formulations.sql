-- Add stable NVL material codes to finished-SKU formulations.
-- Codes are generated from the formulation ingredient name so the same NVL name
-- gets the same owner-friendly code across existing and future SKU formulas.

create or replace function public.generate_sku_material_code(p_name text)
returns text
language sql
immutable
set search_path = public
as $$
  select 'NVL-' || coalesce(
    nullif(
      trim(both '-' from regexp_replace(
        upper(translate(
          coalesce(p_name, ''),
          'ÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐàáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ',
          'AAAAAAAAAAAAAAAAAEEEEEEEEEEEIIIIIOOOOOOOOOOOOOOOOOUUUUUUUUUUUYYYYYDaaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyyd'
        )),
        '[^A-Z0-9]+',
        '-',
        'g'
      )),
      ''
    ),
    'CHUA-DAT-TEN'
  );
$$;

alter table public.sku_formulations
  add column if not exists material_code text;

update public.sku_formulations
set material_code = public.generate_sku_material_code(ingredient_name)
where material_code is null or btrim(material_code) = '';

create index if not exists idx_sku_formulations_material_code
  on public.sku_formulations(material_code);
