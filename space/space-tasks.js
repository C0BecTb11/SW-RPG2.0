// Полигон: задачи этапа «космический бой и абордаж».
// Каждая задача ставит ситуацию (prep) и сама проверяет итог (check):
// 'ok' — выполнено, 'fail' — не вышло, null — ещё идёт; line — строка хода.
// Работает в браузере на своём (не сетевом) бою. ES5.

(function() {
  'use strict';

  // Наш и вражеский корабль под сторону игрока
  var PAIR = { 0: ['venator', 'providence'], 1: ['providence', 'venator'] };
  var SMALL = { 0: ['acclamator', 'munificent'], 1: ['munificent', 'acclamator'] };

  // ---- помощники
  function mine(B, side) { for (var i = 0; i < B.ships.length; i++) if (B.ships[i].side === side) return B.ships[i]; return null; }
  function enemy(B, side) { for (var i = 0; i < B.ships.length; i++) if (B.ships[i].side !== side) return B.ships[i]; return null; }
  // поставить врага на дистанцию d (м) по пеленгу ang от нашего корабля, носом к нам
  function place(B, me, foe, d, ang) {
    foe.x = me.x + Math.cos(ang) * d; foe.y = me.y + Math.sin(ang) * d;
    foe.hd = Math.atan2(me.y - foe.y, me.x - foe.x); foe.v = 0;
    B.place(foe); B.last[me.side][foe.n] = { x: foe.x, y: foe.y, hd: foe.hd, t: B.t };
    B.sense();
  }
  // мишень: стоит, по кораблям не стреляет, машин не выпускает
  function idle(sh) { sh.ai = false; sh.order = null; sh.hangar = []; sh.guns.forEach(function(g) { g.tgt = { k: 'fighters' }; }); }
  function shieldsDown(sh) { sh.sh = [0, 0, 0, 0]; }
  // часть команды абордажа сразу в отсек (захвачен), с инженером
  function pushInto(bd, roomN, count) {
    var c = bd.c, r = bd.ship.roomByN[roomN], moved = 0, eng = false;
    if (!r) return 0;
    for (var i = 0; i < c.agents.length && moved < count; i++) {
      var a = c.agents[i];
      if (!a.alive || a.team !== bd.att) continue;
      if (moved === count - 1 && !eng && !a.eng) continue;          // последний — инженер
      var p = c.spotIn(r); if (!p) break;
      a.x = p[0] + 0.5; a.y = p[1] + 0.5; a.vx = a.vy = 0; a.goalRoom = roomN; a.goal = p; a.at = false; a.breach = -1;
      if (a.eng) eng = true;
      moved++;
    }
    bd.squads.forEach(function(q) { bd.orderSquad(q, roomN, false); });
    var s = bd.rs[roomN]; s.held = true; s.hold = 6;
    return moved;
  }
  function pct(v) { return Math.round(Math.max(0, v) * 100) + '%'; }
  function boardOf(sh) { var b = sh && sh.crew.board; return b && b.started ? b : null; }

  var LIST = [
    {
      id: 'aim', title: 'Пушки по системе', goal: 'Выбей двигатели врага до 30%',
      how: '«Орудия» → отметь пушки → «Двигатели» в целях. Враг рядом и отвечает.',
      ships: SMALL, dist: 6000,
      check: function(B, x) {
        if (x.me.dead) return 'fail';
        x.line = 'двигатели врага: ' + pct(x.foe.eff.engine || 0);
        return x.foe.dead || (x.foe.eff.engine != null && x.foe.eff.engine < 0.3) ? 'ok' : null;
      }
    },
    {
      id: 'room', title: 'Отсек на схеме', goal: 'Разбей до нуля отсек, выбранный на схеме',
      how: '«Орудия» → отметь пушки → «Отсек на схеме…» → коснись отсека на корабле врага.',
      ships: SMALL, dist: 6000,
      check: function(B, x) {
        if (x.me.dead) return 'fail';
        var g = null; x.me.guns.forEach(function(q) { if (q.tgt.k === 'room' && q.tgt.ship === x.foe.n) g = q; });
        if (!g) { x.line = 'выбери пушки и «Отсек на схеме…»'; return null; }
        var st = x.foe.crew.rooms[g.tgt.room], r = x.foe.plan.roomByN[g.tgt.room];
        x.line = '«' + (r ? r.name : 'отсек') + '»: ' + Math.round(st ? st.integ : 0) + '%';
        return x.foe.dead || (st && st.integ <= 0) ? 'ok' : null;
      }
    },
    {
      id: 'shield', title: 'Щит под огнём', goal: 'Усиль сектор, что под огнём, и продержи его 45 с',
      how: '«Корабль» → щиты: коснись сектора, на который смотрит враг. Упадёт до нуля — отсчёт заново.',
      ships: PAIR, dist: 6500, prep: function(B, x) { idle(x.me); },
      check: function(B, x) {
        if (x.me.dead) return 'fail';
        var f = x.me.focus;
        if (x.me.focusAuto || f < 0) { x.held = 0; x.line = 'сектор не выбран — сейчас щиты ведёт экипаж'; return null; }
        if (x.me.sh[f] <= 0) x.held = 0;
        x.held = (x.held || 0) + x.dt;
        x.line = 'сектор держится ' + Math.floor(x.held) + ' / 45 с · щит ' + Math.round(x.me.sh[f] / x.me.shMax * 100) + '%';
        return x.held >= 45 ? 'ok' : null;
      }
    },
    {
      id: 'fog', title: 'Туман войны', goal: 'Найди врага: он вне датчиков',
      how: 'Враг виден бледной меткой последней засечки. Веди корабль туда: касание космоса — курс.',
      ships: PAIR, dist: 21000, prep: function(B, x) { idle(x.foe); x.me.ai = false; },
      check: function(B, x) {
        if (x.me.dead) return 'fail';
        var L = B.last[x.side][x.foe.n], dx = x.foe.x - x.me.x, dy = x.foe.y - x.me.y;
        x.line = 'до врага ' + (Math.sqrt(dx * dx + dy * dy) / 1000).toFixed(1) + ' км · датчики видят ' + (B.sensRange(x.me) / 1000).toFixed(1) + ' км' + (L ? ' · засечка ' + Math.round(B.t - L.t) + ' с назад' : '');
        return B.sees(x.side, x.foe) ? 'ok' : null;
      }
    },
    {
      id: 'fire', title: 'Пожар на борту', goal: 'Загляни внутрь и дождись, пока экипаж потушит все пожары',
      how: '«Внутри» → смотри, как экипаж бежит тушить и чинить. Задача — увидеть это изнутри.',
      ships: PAIR, dist: 30000,
      prep: function(B, x) {
        idle(x.foe); x.me.ai = false;
        var c = x.me.crew, rooms = c.roomList.filter(function(s) { return s.anchor && (s.t === 'quarters' || s.t === 'mess' || s.t === 'gun' || s.t === 'engine'); }).slice(0, 3);
        rooms.forEach(function(s) { for (var k = 0; k < 6; k++) c.ignite(s.r.x + 2 + k * 2 % Math.max(3, s.r.w - 4), s.r.y + 2 + k % Math.max(2, s.r.h - 4), 80); c.damageRoom(s.n, 35); });
        c.alert(true);
      },
      check: function(B, x) {
        if (x.inside) x.saw = true;
        var n = x.me.crew.burning.length;
        x.line = (x.saw ? '' : 'зайди «Внутри» · ') + 'горит клеток: ' + n;
        return x.saw && n === 0 ? 'ok' : null;
      }
    },
    {
      id: 'shuttles', title: 'Сбей шаттлы', goal: 'Сбей хотя бы один абордажный шаттл до стыковки',
      how: 'В полосе «Шаттлы абордажа» — «Огонь по шаттлам». Встань к ним бортом: стреляет больше ПВО.',
      ships: { 0: ['venator', 'providence'], 1: ['cis_recusant', 'venator'] }, dist: 3600,
      prep: function(B, x) {
        idle(x.foe); x.foe.ai = false;
        var s = B.sector(x.me, x.foe.x, x.foe.y); x.me.sh[s] = 0; x.me.focusAuto = false; x.me.focus = (s + 2) % 4;
        x.foe.boardCd = 0; B.board(x.foe.n, x.me.n, false, true);            // сразу в шаттлах — учение про ПВО
        // шаттлы отводятся на 7 км — есть полминуты, чтобы встретить их огнём
        x.ids = B.craft.filter(function(c) { return c.role === 'shuttle'; }).map(function(c) {
          var ang = Math.atan2(c.y - x.me.y, c.x - x.me.x); c.x = x.me.x + Math.cos(ang) * 7000; c.y = x.me.y + Math.sin(ang) * 7000; return c.id;
        });
      },
      check: function(B, x) {
        // каждый шаттл: летит / сбит / пристыковался (сбитые и пристыкованные держатся в списке 2 с)
        x.st = x.st || {};
        B.craft.forEach(function(c) { if (x.ids.indexOf(c.id) >= 0) x.st[c.id] = !c.dead ? 'fly' : c.docked ? 'dock' : 'shot'; });
        var shot = 0, fly = 0, dock = 0;
        x.ids.forEach(function(id) { var v = x.st[id] || 'fly'; if (v === 'shot') shot++; else if (v === 'dock') dock++; else fly++; });
        x.line = 'сбито ' + shot + ' из ' + x.ids.length + ' · в полёте ' + fly + ' · пристыковались ' + dock;
        if (shot >= 1) return 'ok';
        return fly === 0 ? 'fail' : null;
      }
    },
    {
      id: 'repel', title: 'Отбей абордаж', goal: 'Выбей весь десант врага с корабля',
      how: '«Оборона ›» → выбери бойцов (рамка или «свободные») → «в отряд». «Действия» — двери, тревога, продувка. Касание пола — встают там.',
      ships: PAIR, dist: 30000,
      prep: function(B, x) { idle(x.foe); x.me.ai = false; B.forceBoard(x.foe.n, x.me.n, 20); },
      look: true,
      check: function(B, x) {
        var b = boardOf(x.me); if (!b) return x.me.dead ? 'fail' : null;
        var s = b.summary(); x.line = 'враг ' + s.att + ' · наши бойцы ' + s.def + (b.rs[b.bridge] && b.rs[b.bridge].held ? ' · мостик у врага ' + Math.floor(b.bridgeT) + ' с' : '');
        return b.over === 0 ? 'ok' : b.over > 0 || x.me.dead ? 'fail' : null;
      }
    },
    {
      id: 'defuse', title: 'Сними заряд', goal: 'Враг в реакторном зале с зарядом — сними его до взрыва',
      how: '«Действия» → «Снять заряд» — все в реактор. Выбьют врага — боец снимет заряд за 8 с.',
      ships: PAIR, dist: 30000, look: true,
      prep: function(B, x) {
        idle(x.foe); x.me.ai = false; B.forceBoard(x.foe.n, x.me.n, 16);
        var b = boardOf(x.me); if (!b || !b.reactor) return;
        pushInto(b, b.reactor, 8); b.prep = 0;           // учение начинается посреди штурма
        // на учении фитиль длиннее: защитникам из казарм нужно добежать до реактора
        b.charge = { plant: 0, left: 180, defuse: 0, armed: true };
        b.msg('Заряд у реактора! 180 с до взрыва', b.att, 'bad');
      },
      check: function(B, x) {
        var b = boardOf(x.me); if (!b) return x.me.dead ? 'fail' : null;
        if (b.over === 2 || x.me.dead) return 'fail';
        x.line = b.charge ? (b.charge.armed ? 'взрыв через ' + Math.ceil(b.charge.left) + ' с' + (b.charge.defuse > 0 ? ' · снимаем ' + Math.floor(b.charge.defuse) + '/8' : '') : 'ставят заряд') : 'заряд снят';
        return !b.charge || b.over === 0 ? 'ok' : null;
      }
    },
    {
      id: 'bridge', title: 'Отбей мостик', goal: 'Мостик у врага — отбей, пока он не удержал его',
      how: '«Действия» → «На мостик» — все туда. Мостик снова наш, когда в нём 6 с только наши.',
      ships: PAIR, dist: 30000, look: true,
      prep: function(B, x) {
        idle(x.foe); x.me.ai = false; B.forceBoard(x.foe.n, x.me.n, 16);
        var b = boardOf(x.me); if (!b || !b.bridge) return;
        pushInto(b, b.bridge, 10); b.bridgeT = 30; b.prep = 0;
      },
      check: function(B, x) {
        var b = boardOf(x.me); if (!b) return null;
        if (b.over === 1 || x.me.dead) return 'fail';
        var br = b.rs[b.bridge];
        x.line = br.held ? 'мостик у врага: ' + Math.floor(b.bridgeT) + ' / ' + b.holdNeed + ' с' : 'мостик наш';
        return !br.held || b.over === 0 ? 'ok' : null;
      }
    },
    {
      id: 'doors', title: 'Двери и сварка', goal: 'Запри дверь и заставь ремонтника её заварить',
      how: '«Оборона ›» → «Действия» → «Двери» → коснись проёма; потом «Заварить» → та же дверь.',
      ships: PAIR, dist: 30000, look: true,
      prep: function(B, x) { idle(x.foe); x.me.ai = false; B.forceBoard(x.foe.n, x.me.n, 12); },
      check: function(B, x) {
        var b = boardOf(x.me); if (!b) return null;
        var w = 0, p = 0; b.doors.forEach(function(d) { if (d.weld) w++; if (d.weldP > 0) p = Math.max(p, d.weldP); });
        x.line = w ? 'заварено дверей: ' + w : p ? 'варят: ' + Math.round(p * 100) + '%' : 'запри дверь и выбери «Заварить»';
        return w ? 'ok' : null;
      }
    },
    {
      id: 'take', title: 'Возьми корабль', goal: 'Высади десант и удержи мостик врага',
      how: 'Щиты врага опущены. «Высадить» в полосе абордажа → «Внутрь ›» → отряды на мостик.',
      ships: PAIR, dist: 3500,
      prep: function(B, x) { shieldsDown(x.foe); x.me.boardCd = 0; },
      check: function(B, x) {
        if (x.me.dead) return 'fail';
        var b = boardOf(x.foe);
        if (x.foe.dead) return x.foe.why === 'captured' && x.foe.captured === x.side ? 'ok' : 'fail';
        if (!b) { x.line = x.foe.inbound ? 'шаттлы в пути: ' + x.foe.inbound : 'высади десант'; return null; }
        var br = b.rs[b.bridge];
        x.line = 'наших ' + b.summary().att + (br && br.held ? ' · мостик наш ' + Math.floor(b.bridgeT) + '/' + b.holdNeed + ' с' : ' · мостик не взят');
        return b.over === 0 && !x.foe.inbound && !B.troopsOf(x.me).length && !(B.musters || []).some(function(m) { return m.n === x.me.n; }) ? 'fail' : null;
      }
    },
    {
      id: 'blow', title: 'Подорви реактор', goal: 'Займи реакторный зал врага и поставь заряд',
      how: '«Цели» → «Реактор». Зал взят и в нём инженер — «Действия» → «Заряд в реактор». Держи зал 90 с.',
      ships: PAIR, dist: 30000,
      prep: function(B, x) { idle(x.foe); B.forceBoard(x.me.n, x.foe.n, 30); },
      look: 'foe',
      check: function(B, x) {
        if (x.foe.dead) return x.foe.why === 'reactor' ? 'ok' : 'fail';
        var b = boardOf(x.foe); if (!b) return null;
        if (b.over === 0) return 'fail';
        x.line = b.charge ? (b.charge.armed ? 'взрыв через ' + Math.ceil(b.charge.left) + ' с' : 'ставим заряд') : b.rs[b.reactor] && b.rs[b.reactor].held ? 'реактор наш — нужен инженер в зале' : 'возьми реакторный зал';
        return null;
      }
    },
    {
      id: 'counter', title: 'Контрабордаж', goal: 'Враг на борту — ответь абордажем его корабля',
      how: '«Оборона ›» → «Действия» → «Контра» (или «Контрабордаж» в полосе внизу). Щиты врага опущены.',
      ships: PAIR, dist: 3500, look: true,
      prep: function(B, x) { idle(x.foe); shieldsDown(x.foe); x.me.boardCd = 0; B.forceBoard(x.foe.n, x.me.n, 16); },
      check: function(B, x) {
        var b = boardOf(x.foe), m = boardOf(x.me);
        x.line = m ? 'враг на борту: ' + m.summary().att : '';
        if (x.me.dead) return 'fail';
        return (b && b.att === x.side) || x.foe.inbound > 0 ? 'ok' : null;
      }
    },
    {
      id: 'kill', title: 'Уничтожь корабль', goal: 'Победи врага в бою и посмотри, как он разваливается',
      how: 'Обычный бой: пушки, щиты, курс. Хорошо бьют тяжёлые по реактору.',
      ships: SMALL, dist: 7000,
      check: function(B, x) {
        if (x.me.dead) return 'fail';
        x.line = 'корпус врага ' + pct(x.foe.hull / x.foe.hullMax) + ' · наш ' + pct(x.me.hull / x.me.hullMax);
        return x.foe.dead ? 'ok' : null;
      }
    }
  ];

  window.SPTasks = { LIST: LIST, PAIR: PAIR, mine: mine, enemy: enemy, place: place, idle: idle };
})();
