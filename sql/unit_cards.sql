-- Карточки юнитов — из игровых моделек (23.10.2026). Картинки: assets/units/models/<id>.jpg,
-- рисует tools/unit-cards.html. Герои, истребители, зонды и мародёр — со своими картинками (отдельной модельки нет).
update public.unit_types set image = 'assets/units/models/' || id || '.jpg'
 where id in ('rep_dc15a','rep_heavy','rep_sniper','rep_launcher','rep_arc','rep_commando','rep_engineer','rep_medic','rep_officer','rep_militia',
              'rep_atrt','rep_barc','rep_atte','rep_laat','rep_turbo','rep_aa','rep_artillery',
              'cis_b1','cis_b1_launcher','cis_b1_sniper','cis_b2','cis_bx','cis_bounty','cis_hunter','cis_engineer','cis_medic','cis_militia',
              'cis_stap','cis_aat','cis_mtt','cis_hmp','cis_missile','cis_spider','cis_artillery');
