-- Налёты мародёров на участки и цеха (sql/mine_raids.sql, #106) — сняты с игры 24.10.2026.
-- Решение Артёма: по участкам и цехам уже бьют тайные операции (диверсии), налёты их дублируют.
-- Налётов не было ни одного (одна строка mine_raids со статусом none), поэтому снимаем без следов для игроков:
--   * выключатель mine_raid_enabled = 0 и такт mine-raid-tick снят с расписания;
--   * окно участка больше не получает налёты: правка mine_site_state из mine_raids.sql откатывается.
-- Таблица mine_raids, служебные функции mine_raid_* и типы событий mine_raid_* остаются в базе спящими:
-- их никто не вызывает, права у игроков закрыты. Вернуть налёты — снова прогнать sql/mine_raids.sql
-- (вернёт правку окна и такт) и поставить mine_raid_enabled = 1.
-- Мародёры планет (marauder_*, поселения) этим не затронуты.

update game_settings set value = '0' where key = 'mine_raid_enabled';

select cron.unschedule('mine-raid-tick') where exists (select 1 from cron.job where jobname = 'mine-raid-tick');

-- ---------------------------------------------------------------- окно участка: без налётов
do $$
declare d text;
begin
  d := pg_get_functiondef('public.mine_site_state(uuid)'::regprocedure);
  if position('mine_site_raids' in d) > 0 or position('mine_raid_' in d) > 0 then
    if position($a$'ops', spy_site_ops(p_building), 'raids', mine_site_raids(p_building),$a$ in d) = 0
       or position($a$'raid', jsonb_build_object('bounty', game_setting_int('mine_raid_bounty', 40), 'loot_pct', game_setting_int('mine_raid_loot_pct', 20),
        'loot_max', game_setting_int('mine_raid_loot_max', 60), 'wear', game_setting_int('mine_raid_wear', 10)),
      'hire_t', round($a$ in d) = 0 then
      raise exception 'mine_site_state: место правки (налёты) не найдено';
    end if;
    d := replace(d, $a$'ops', spy_site_ops(p_building), 'raids', mine_site_raids(p_building),$a$, $b$'ops', spy_site_ops(p_building),$b$);
    d := replace(d, $a$'raid', jsonb_build_object('bounty', game_setting_int('mine_raid_bounty', 40), 'loot_pct', game_setting_int('mine_raid_loot_pct', 20),
        'loot_max', game_setting_int('mine_raid_loot_max', 60), 'wear', game_setting_int('mine_raid_wear', 10)),
      'hire_t', round($a$, $b$'hire_t', round($b$);
    if position('mine_raid' in d) > 0 or position('mine_site_raids' in d) > 0 then
      raise exception 'mine_site_state: после отката остались налёты';
    end if;
    execute d;
  end if;
end $$;
