-- Rollback-only smoke for the learned-supplier / price-outlier guard.
--
-- Run against a database that already has 20261103340000 applied:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -f apps/web/scripts/smoke_supplier_order_learned_supplier_guard.sql
--
-- Everything happens inside BEGIN ... ROLLBACK. It never keeps a catalog
-- change, sends an email or creates an order.

begin;

select set_config('request.jwt.claim.role', 'service_role', true);
select set_config('request.jwt.claim.sub', '', true);
set local role service_role;

do $smoke$
declare
  v_banh_mi constant uuid := 'dad2d28e-4f0b-4e6f-b07c-4497b14968e6';
  v_cholimex constant uuid := 'ecd49e72-96fe-465d-b8a5-2c474aa7d6ae';
  v_catalog_row constant uuid := '1891a408-b223-41c9-aa3a-b192e8d2e6f8';
  v_tuong_ot constant uuid := '52c6aea1-ff28-449f-accb-e2482128c339';
  v_active boolean;
  v_catalog jsonb;
  v_item jsonb;
begin
  select c.active
  into v_active
  from public.supplier_order_catalog_items c
  where c.id = v_catalog_row;
  if v_active is null then
    raise exception 'smoke catalog row % is missing', v_catalog_row;
  end if;

  -- Tạm bật lại dòng catalog của Bánh Mì trong giao dịch; rollback trả nguyên
  -- trạng thái cũ.
  update public.supplier_order_catalog_items
     set active = true
   where id = v_catalog_row;

  ----------------------------------------------------------------
  -- Bánh Mì: NCC đang xem khác NCC đã học và giá lệch xa
  ----------------------------------------------------------------
  v_catalog := public.supplier_order_catalog(v_banh_mi);
  select e.value
  into v_item
  from jsonb_array_elements(coalesce(v_catalog -> 'items', '[]'::jsonb)) e
  where e.value -> 'item' ->> 'id' = v_tuong_ot::text;

  if v_item is null then
    raise exception 'Bánh Mì catalog has no tương ớt item %', v_tuong_ot;
  end if;
  if (v_item ->> 'proposal_qty')::numeric is distinct from 0 then
    raise exception 'Bánh Mì tương ớt proposal_qty must be 0, got %',
      v_item ->> 'proposal_qty';
  end if;
  if (v_item ->> 'learned_supplier_mismatch')::boolean is distinct from true then
    raise exception 'Bánh Mì tương ớt learned_supplier_mismatch must be true: %',
      v_item;
  end if;
  if (v_item ->> 'price_outlier')::boolean is distinct from true then
    raise exception 'Bánh Mì tương ớt price_outlier must be true: %', v_item;
  end if;
  if v_item -> 'learned_supplier' is null
     or v_item -> 'learned_supplier' = 'null'::jsonb
     or not ((v_item -> 'learned_supplier') ? 'id')
     or btrim(coalesce((v_item -> 'learned_supplier') ->> 'name', '')) = '' then
    raise exception 'Bánh Mì tương ớt learned_supplier must carry id and name: %',
      v_item -> 'learned_supplier';
  end if;
  if v_item -> 'reference_price' is null
     or v_item -> 'reference_price' = 'null'::jsonb
     or not ((v_item -> 'reference_price') ? 'supplier_id')
     or not ((v_item -> 'reference_price') ? 'supplier_name')
     or ((v_item -> 'reference_price') ->> 'unit_price') is null then
    raise exception 'Bánh Mì tương ớt reference_price must carry supplier and unit_price: %',
      v_item -> 'reference_price';
  end if;

  ----------------------------------------------------------------
  -- Cholimex: đúng NCC đã học, giá tham chiếu không lệch
  ----------------------------------------------------------------
  v_catalog := public.supplier_order_catalog(v_cholimex);
  select e.value
  into v_item
  from jsonb_array_elements(coalesce(v_catalog -> 'items', '[]'::jsonb)) e
  where e.value -> 'item' ->> 'id' = v_tuong_ot::text;

  if v_item is null then
    raise exception 'Cholimex catalog has no tương ớt item %', v_tuong_ot;
  end if;
  if (v_item ->> 'learned_supplier_mismatch')::boolean is distinct from false then
    raise exception 'Cholimex tương ớt learned_supplier_mismatch must be false: %',
      v_item;
  end if;
  if (v_item ->> 'price_outlier')::boolean is distinct from false then
    raise exception 'Cholimex tương ớt price_outlier must be false: %', v_item;
  end if;

  raise notice 'supplier order learned supplier guard smoke passed';
end;
$smoke$;

rollback;
