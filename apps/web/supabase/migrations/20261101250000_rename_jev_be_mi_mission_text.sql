-- Owner 15/10: the sorting robot "Jev" is now called "Bé Mì". Only mission text a
-- player reads changes; codes, rules and function names keep "jev".
update public.missions
   set description = replace(description, 'Jev', 'Bé Mì')
 where description like '%Jev%';
