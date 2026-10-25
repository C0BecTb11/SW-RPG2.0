-- Удаление старого кода, шаг 0 (26.10.2026): инженер в бою 2.0 без очков действий (решение Артёма).
-- build_structure больше не вызывает spend_unit_action (раньше после каждой постройки — «Юнит ещё не готов»).
do $$
declare v_def text; a text := $x$  perform take_build_resources(u.system_id, st.cost_resources, 1);
  perform spend_unit_action(p_unit_id);
$x$; b text := $x$  perform take_build_resources(u.system_id, st.cost_resources, 1);
$x$;
begin
  v_def := pg_get_functiondef('public.build_structure'::regproc);
  if position(a in v_def) > 0 then
    if (length(v_def) - length(replace(v_def, a, ''))) / length(a) <> 1 then raise exception 'build_structure: якорь не один'; end if;
    execute replace(v_def, a, b);
  end if;
end $$;
