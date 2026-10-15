-- Owner 15/10: level titles read as translated English ("Thợ kho", "Thợ cả").
-- Natural warehouse ranks instead; ids and badge thresholds are unchanged.
update public.mission_levels set title = v.title
from (values (1, 'Nhân viên mới'), (2, 'Nhân viên kho'), (3, 'Thủ kho'), (4, 'Thủ kho trưởng'), (5, 'Quản lý kho')) as v(level, title)
where public.mission_levels.level = v.level;
