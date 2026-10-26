-- Тексты под бой 2.0 (26.10.2026): описания в базе, которые обещали механику старого пошагового боя
-- («действия», «клетки за ход», «3×3», «сжигает разведчиков»…). Числа — в клетках поля боя (×3 к клеткам
-- игры) и секундах, как их считает shared/rt-ground.js. Точные числа исследований и бойцов клиент
-- пишет сам (js/battle-stats.js), здесь — описания. Повторный запуск безопасен.

-- бойцы
update unit_types set description = 'Тяжёлое орудие Республики. Бьёт залпом по кругу в 3 клетки в любую точку карты, но само почти ничего не видит: стрелять можно только туда, где цель видят твои войска. Залп — раз в 12 секунд, снаряд летит пару секунд. Ползёт медленно, от пехоты прикрыта бронёй, против авиации беззащитна. Снаряд не разбирает своих и чужих.'
 where id = 'rep_artillery';
update unit_types set description = 'Тяжёлое орудие Конфедерации. Бьёт залпом по кругу в 3 клетки в любую точку карты, но само почти ничего не видит: стрелять можно только туда, где цель видят твои войска. Залп — раз в 12 секунд, снаряд летит пару секунд. Ползёт медленно, от пехоты прикрыта бронёй, против авиации беззащитна. Снаряд не разбирает своих и чужих.'
 where id = 'cis_artillery';
update unit_types set description = 'Элита разведки. Живучее строевых клонов и видит дальше.' where id = 'rep_arc';
update unit_types set description = 'Элита диверсий. Живучее строевых дроидов и видит дальше.' where id = 'cis_bx';
update unit_types set description = 'Канонерка-штурмовик. Летит над местностью и поливает огнём пехоту.' where id = 'rep_laat';
update unit_types set description = 'Дроид-канонерка. Летит над местностью, быстрая, но хрупкая.' where id = 'cis_hmp';
update unit_types set description = 'Тяжёлый транспорт клонов. Медленнее канонерки, зато крепче.' where id = 'rep_turbo';
update unit_types set description = 'Бронированный транспорт дроидов. Медленнее канонерки, зато крепче.' where id = 'cis_mtt';

-- исследования: постройки инженера
update researches set description = 'Инженер возводит бункер: по пехоте внутри попадают вдвое реже, а бьёт она вдвое сильнее.' where id = 'rep_eng_bunker';
update researches set description = 'Инженерный дроид возводит бункер: по пехоте внутри попадают вдвое реже, а бьёт она вдвое сильнее.' where id = 'cis_eng_bunker';
update researches set description = 'Инженер ставит сеть с голоэмиттером: боец под ней пропадает с вражеских экранов, пока не выстрелит или враг не подойдёт ближе 9 клеток.' where id = 'rep_eng_camo';
update researches set description = 'Инженерный дроид ставит голопроектор: боец под куполом пропадает с вражеских экранов, пока не выстрелит или враг не подойдёт ближе 9 клеток.' where id = 'cis_eng_camo';
update researches set description = 'Инженер ставит станцию помех: вражеские бойцы рядом с ней слепнут и видят всего на 6 клеток.' where id = 'rep_eng_jammer';
update researches set description = 'Инженерный дроид ставит станцию помех: вражеские бойцы рядом с ней слепнут и видят всего на 6 клеток.' where id = 'cis_eng_jammer';
update researches set description = 'Инженер ставит полевой радар: фракция видит всех врагов в 30 клетках вокруг, даже под маскировкой и скрытных разведчиков.' where id = 'rep_eng_radar';
update researches set description = 'Инженерный дроид ставит полевой радар: фракция видит всех врагов в 30 клетках вокруг, даже под маскировкой и скрытных разведчиков.' where id = 'cis_eng_radar';
update researches set description = 'Инженер ставит автоматическую бластерную турель: она сама бьёт врагов в 15 клетках.' where id = 'rep_eng_turret';
update researches set description = 'Инженерный дроид ставит автоматическую бластерную турель: она сама бьёт врагов в 15 клетках.' where id = 'cis_eng_turret';

-- исследования: способности бойцов
update researches set description = 'Шквальный огонь по скоплению врагов: задевает каждого, уцелевшие залегают и стреляют хуже.' where id = 'heavy_suppression';
update researches set description = 'Шквальный огонь из сдвоенных бластеров по скоплению врагов: уцелевшие залегают и стреляют хуже.' where id = 'cis_b2_suppression';
update researches set description = 'Стремительный прыжок к врагу и удар виброклинком. Огромный урон, укрытие не спасает.' where id = 'cis_bx_lunge';
update researches set description = 'Прецизионный выстрел по уязвимым зонам. Пехоту убивает наповал.' where id in ('sniper_headshot', 'cis_b1s_headshot');
update researches set description = 'Перевод бластера в режим шокового разряда: выстрел бьёт как обычно и может оглушить.' where id = 'dc15a_stun';
update researches set description = 'Перевод бластера E-5 в режим ионного разряда: выстрел бьёт как обычно и может оглушить.' where id = 'cis_b1_stun';

-- одарённые (древо героя)
update hero_abilities set description = 'Держит цель в невидимом кулаке: 2,5 секунды она не ходит и не стреляет, потом получает урон.' where id = 'choke_dark';
update hero_abilities set description = 'Волна ужаса от ситха: вражеская пехота рядом с ним 6 секунд бежит и не стреляет.' where id = 'fear_dark';
update hero_abilities set description = 'Лечит союзника рядом или себя, не отводя в лазарет.' where id = 'heal_light';
update hero_abilities set description = 'Молнии бьют всех врагов перед ситхом, технику слабее, и с шансом 50 процентов оглушают на 2 секунды.' where id = 'lightning_dark';
update hero_abilities set description = 'Чужой боец на 5 минут становится твоим. Воли ему не оставляют. Одарённых не берёт.' where id = 'mind_enslave';
update hero_abilities set description = 'Чужой боец на 5 минут переходит под твоё начало. Одарённых не берёт.' where id = 'mind_suasion';
update hero_abilities set description = 'Цель опускает оружие: 8 секунд не ходит и не стреляет. Без единой царапины. Одарённых не берёт.' where id = 'pacify_light';
update hero_abilities set description = 'Отбрасывает врагов перед собой на несколько клеток и сбивает с ног. Урона нет, но строй ломается.' where id = 'push_light';
update hero_abilities set description = 'Чует живое сквозь стены. Обзор растёт на 9 клеток.' where id = 'vision_dark';
update hero_abilities set description = 'Взгляд сквозь туман. Обзор растёт на 9 клеток.' where id = 'vision_light';
