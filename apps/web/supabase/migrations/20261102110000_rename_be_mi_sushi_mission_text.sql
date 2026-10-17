-- Owner 17/10: "Chỗ Bé mì vẫn chưa chuyển qua sushi" — the robot "Bé Mì" is now called "Sushi" in the app.
-- Only mission text a player reads changes; codes, rules and function names keep "jev".
update public.missions
   set description = replace(description, 'Bé Mì', 'Sushi')
 where description like '%Bé Mì%';
update public.missions
   set title = replace(title, 'Bé Mì', 'Sushi')
 where title like '%Bé Mì%';
