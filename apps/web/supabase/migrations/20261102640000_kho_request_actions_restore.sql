-- 20261102620000 (two kho locations) re-created warehouse_game_requests_action_check
-- from an older list and dropped 'kho_add_unit' and 'kho_set_conversion' (added by
-- 20261102560000). "Lưu quy đổi" and "Thêm đơn vị" then failed with
-- "Có lỗi xảy ra" (owner, 22/10). Restore the full list.
alter table public.warehouse_game_requests
  drop constraint if exists warehouse_game_requests_action_check;
alter table public.warehouse_game_requests
  add constraint warehouse_game_requests_action_check
  check (action in (
    'rename', 'change_unit', 'set_item_pastry_q7', 'kho_save_item',
    'kho_add_unit', 'kho_set_conversion', 'set_item_kho_locations'
  ));
