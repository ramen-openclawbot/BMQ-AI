-- Phase 1: Auto-SKU Creation System

-- 1.1 Add short_code column to suppliers for SKU generation
ALTER TABLE public.suppliers 
ADD COLUMN IF NOT EXISTS short_code text;

-- Backfill existing suppliers with abbreviations
UPDATE public.suppliers SET short_code = 'BHX' WHERE name ILIKE '%Bách Hoá Xanh%' AND short_code IS NULL;
UPDATE public.suppliers SET short_code = 'GREENFARM' WHERE name ILIKE '%Green Farm%' AND short_code IS NULL;
UPDATE public.suppliers SET short_code = 'PURATOS' WHERE name ILIKE '%Puratos%' AND short_code IS NULL;
UPDATE public.suppliers SET short_code = 'RVC' WHERE name ILIKE '%RVC%' AND short_code IS NULL;
UPDATE public.suppliers SET short_code = 'STC' WHERE name ILIKE '%STC%' AND short_code IS NULL;
UPDATE public.suppliers SET short_code = 'NGUYENHA' WHERE name ILIKE '%Nguyên Hà%' AND short_code IS NULL;
UPDATE public.suppliers SET short_code = 'THEKYXANH' WHERE name ILIKE '%Thế Kỷ Xanh%' AND short_code IS NULL;
UPDATE public.suppliers SET short_code = 'TTFOODS' WHERE name ILIKE '%T&T Foods%' AND short_code IS NULL;

-- 1.2 Add sku_id column to payment_request_items to track SKU linkage
ALTER TABLE public.payment_request_items 
ADD COLUMN IF NOT EXISTS sku_id uuid REFERENCES public.product_skus(id);

-- 1.3 Create SKU code generation function
CREATE OR REPLACE FUNCTION public.generate_sku_code(
  p_category text,
  p_supplier_short_code text,
  p_product_name text,
  p_unit text
) RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  category_prefix text;
  normalized_name text;
  unit_suffix text;
  base_sku text;
  final_sku text;
  counter int := 0;
BEGIN
  -- Map category to 2-letter prefix
  category_prefix := CASE 
    WHEN p_category ILIKE '%Nguyên liệu%' OR p_category ILIKE '%nguyen lieu%' THEN 'NL'
    WHEN p_category ILIKE '%Bao bì%' OR p_category ILIKE '%bao bi%' THEN 'BB'
    WHEN p_category ILIKE '%Phụ gia%' OR p_category ILIKE '%phu gia%' THEN 'PG'
    WHEN p_category ILIKE '%Gia vị%' OR p_category ILIKE '%gia vi%' THEN 'GV'
    WHEN p_category ILIKE '%Thực phẩm%' OR p_category ILIKE '%thuc pham%' THEN 'TP'
    WHEN p_category ILIKE '%Đồ uống%' OR p_category ILIKE '%do uong%' THEN 'DU'
    ELSE 'KH'
  END;
  
  -- Normalize product name: remove Vietnamese diacritics, spaces, special chars
  normalized_name := UPPER(
    REGEXP_REPLACE(
      TRANSLATE(COALESCE(p_product_name, 'UNKNOWN'), 
        'àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđÀÁẠẢÃÂẦẤẬẨẪĂẰẮẶẲẴÈÉẸẺẼÊỀẾỆỂỄÌÍỊỈĨÒÓỌỎÕÔỒỐỘỔỖƠỜỚỢỞỠÙÚỤỦŨƯỪỨỰỬỮỲÝỴỶỸĐ',
        'aaaaaaaaaaaaaaaaaeeeeeeeeeeeiiiiiooooooooooooooooouuuuuuuuuuuyyyyydAAAAAAAAAAAAAAAAAEEEEEEEEEEEIIIIIOOOOOOOOOOOOOOOOOUUUUUUUUUUUYYYYYD'),
      '[^A-Za-z0-9]', '', 'g')
  );
  
  -- Limit product name length to 12 characters
  IF LENGTH(normalized_name) > 12 THEN
    normalized_name := LEFT(normalized_name, 12);
  END IF;
  
  -- Map unit to abbreviation
  unit_suffix := UPPER(CASE 
    WHEN p_unit ILIKE '%kg%' THEN 'KG'
    WHEN p_unit ILIKE '%g%' AND NOT p_unit ILIKE '%kg%' THEN 'G'
    WHEN p_unit ILIKE '%lít%' OR p_unit ILIKE '%lit%' OR p_unit ILIKE '%liter%' THEN 'LIT'
    WHEN p_unit ILIKE '%ml%' THEN 'ML'
    WHEN p_unit ILIKE '%cái%' OR p_unit ILIKE '%quả%' OR p_unit ILIKE '%qua%' THEN 'CAI'
    WHEN p_unit ILIKE '%con%' THEN 'CON'
    WHEN p_unit ILIKE '%hộp%' OR p_unit ILIKE '%hop%' THEN 'HOP'
    WHEN p_unit ILIKE '%thùng%' OR p_unit ILIKE '%thung%' THEN 'THUNG'
    WHEN p_unit ILIKE '%chai%' THEN 'CHAI'
    WHEN p_unit ILIKE '%lon%' THEN 'LON'
    WHEN p_unit ILIKE '%gói%' OR p_unit ILIKE '%goi%' THEN 'GOI'
    WHEN p_unit ILIKE '%bịch%' OR p_unit ILIKE '%bich%' THEN 'BICH'
    WHEN p_unit ILIKE '%túi%' OR p_unit ILIKE '%tui%' THEN 'TUI'
    ELSE UPPER(LEFT(COALESCE(p_unit, 'PC'), 3))
  END);
  
  -- Build base SKU code
  base_sku := category_prefix || '-' || 
              COALESCE(UPPER(p_supplier_short_code), 'GEN') || '-' || 
              normalized_name || '-' || 
              unit_suffix;
  
  -- Check for duplicates and add suffix if needed
  final_sku := base_sku;
  WHILE EXISTS (SELECT 1 FROM public.product_skus WHERE sku_code = final_sku) LOOP
    counter := counter + 1;
    final_sku := base_sku || '-' || counter;
  END LOOP;
  
  RETURN final_sku;
END;
$$;