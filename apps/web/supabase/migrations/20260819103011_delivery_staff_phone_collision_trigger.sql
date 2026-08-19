drop trigger if exists block_delivery_staff_active_phone_collision on public.delivery_staff;
create trigger block_delivery_staff_active_phone_collision
before insert or update of phone_normalized, active
on public.delivery_staff
for each row execute function public.block_delivery_staff_active_phone_collision();
