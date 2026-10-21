-- 2026-10-22 — Owner: "Check quy đổi sai và xoá (1kg = 1g)".
--
-- A supplier name whose delivery-note unit is a standard measure (kg, g, l, ml) of
-- the item's own kind converts by itself: post_stock_goods_receipt_item multiplies
-- by stock_unit_line_factor() first, so the stored alias factor was never used for
-- stock.  The warehouse game still saved factor 1 for those names, which shows as
-- "1 kg = 1 g" and feeds reports that read the alias factor.  51 aliases on 29
-- items carried a factor different from the standard one on 22/10.
--
-- This sets each of them to the standard factor (1 kg = 1000 g, 1 g = 1 g), with
-- one material_alias_events 'correct' row per alias for the audit trail.  No row
-- is deleted, no ledger row is written (stock never used these factors), and the
-- alias triggers run as for any factor correction.  Idempotent: a second run
-- finds nothing to correct.

do $$
declare
  v_row record;
  v_fixed integer := 0;
begin
  for v_row in
    select
      a.id,
      a.normalized_name,
      a.unit,
      a.conversion_factor as old_factor,
      public.stock_unit_line_factor(
        public.normalize_document_unit(coalesce(nullif(btrim(a.pack_label), ''), a.unit)),
        k.unit
      ) as std
    from public.stock_material_aliases a
    join public.kitchen_inventory_items k on k.id = a.kitchen_inventory_item_id
    where a.line_class = 'stock'
    for update of a
  loop
    continue when v_row.std is null or v_row.std <= 0;
    continue when abs(v_row.old_factor - v_row.std) <= 1e-9;

    update public.stock_material_aliases
      set conversion_factor = v_row.std,
          updated_at = now()
      where id = v_row.id;

    insert into public.material_alias_events (
      alias_id, action, actor_id, raw_name, raw_unit, previous_factor, new_factor
    ) values (
      v_row.id, 'correct', null, v_row.normalized_name, v_row.unit, v_row.old_factor, v_row.std
    );

    v_fixed := v_fixed + 1;
  end loop;

  raise notice 'standard-unit alias factors corrected: %', v_fixed;
end
$$;
