-- Дешёвые дополнения для B1 (26.10.2026, решение Артёма): B1 — дешёвая слабая единица, КНС берёт
-- количеством. Дополнение при найме стоило четверть цены изучения (броня I — 100 кр на дроида за 60 кр).
-- researches.unit_price — цена дополнения за бойца при найме; null — по-прежнему четверть цены изучения.
-- Цена изучения не меняется. Повторный запуск безопасен.
alter table public.researches add column if not exists unit_price integer;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'researches_unit_price_check') then
    alter table public.researches add constraint researches_unit_price_check check (unit_price is null or unit_price >= 0);
  end if;
end $$;
comment on column public.researches.unit_price is 'Цена дополнения за бойца при найме (кр); null — четверть цены изучения (cost / 4)';

update public.researches set unit_price = v.p
  from (values ('cis_b1_armor_1', 15), ('cis_b1_armor_2', 30), ('cis_b1_armor_3', 50),
               ('cis_b1_mobility', 25), ('cis_b1_grenade', 40), ('cis_b1_stun', 40)) v(id, p)
 where researches.id = v.id;

-- order_unit: цена дополнений — unit_price, если задана
do $$
declare v_def text; a text := 'sum(r.cost / 4)::integer from researches r'; b text := 'sum(coalesce(r.unit_price, r.cost / 4))::integer from researches r';
begin
  v_def := pg_get_functiondef('public.order_unit(uuid,text,integer,integer,integer,text[])'::regprocedure);
  if position(b in v_def) > 0 then return; end if;
  if (length(v_def) - length(replace(v_def, a, ''))) / length(a) <> 1 then raise exception 'order_unit: место цены дополнений не одно'; end if;
  execute replace(v_def, a, b);
end $$;
