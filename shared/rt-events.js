/* Сценарии ивентов наземки 2.0 поверх движка shared/rt-ground.js (Ground с opts.noTown).
 * Охоты: на ситха и на джедаев (одна логика, роли зеркальные). Оборона от волн: аванпост
 * «Тессара» (Республика против дроидов) и завод «Векс» (КНС против клонов) — тоже одна логика.
 *
 *   var H = SWEvents.create(B, { event, tier, map, players: [{ user, role, nick, bot }], seed });
 *   H.setup()          — войска на карту (владелец бойца — игрок или «bot:роль:n»)
 *   H.step()           — каждый такт после B.step: задачи, импульсы, эвакуация, боты, исход
 *   H.view(team)       — что показать стороне (худ ивента): таймер, задачи, импульс, эвакуация
 *   H.result           — итог: { winner: роль, why, t, stats }, когда бой кончился (B.over ≥ 0)
 *
 * Охота. Добыча (ситх или 1–2 джедая) выполняет задачи (стоять у места задачи N секунд,
 * прогресс копится) и вызывает эвакуацию: шаттл подлетает N секунд, потом на площадке надо
 * простоять 15 с — или перебивает всех охотников. Точку эвакуации видят и охотники.
 * Охотники видят все возможные места задач, но не знают, какие выбраны; когда добыча начинает
 * задачу — тревога у места. Офицер-сенсорщик раз в M секунд даёт импульс: круг, где сейчас
 * добыча (на уровне III — реже и шире). Нет живых сенсорщиков — нет импульсов.
 * Время вышло, добыча не ушла — победа охотников. ES5, UMD → window.SWEvents.
 */
(function(root, factory) {
  var api = factory(
    typeof require === 'function' ? require('./rt-ground.js') : root.SWGround,
    typeof require === 'function' ? require('./rt-events-cat.js') : root.SWEventsCat,
    typeof require === 'function' ? require('./rt-units.js') : root.SWUnits
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.SWEvents = api;
})(typeof self !== 'undefined' ? self : this, function(GR, CAT, UN) {
  'use strict';
  var RK = GR.RANGE_K;

  // ---------------------------------------------------------------- настройки охот по уровням
  var HUNT = {
    tasks:   [2, 3, 4],             // сколько задач из пяти
    channel: [45, 50, 55],          // секунд у места задачи
    eta:     [60, 70, 80],          // через сколько секунд после вызова садится шаттл
    extract: 15,                    // секунд на площадке после посадки
    ping:    [45, 55, 65],          // раз в сколько секунд импульс
    pingR:   [12, 16, 20],          // радиус круга импульса, клетки боя
    pingShow: 10,                   // сколько секунд круг на карте
    sneak:   [0, 4, 3],             // скрытность добычи (клетки игры; 0 — видна как все)
    night:   [0, 0, 1],             // добавка к темноте карты
    reveal:  6,                     // после удара или силы добыча видна столько секунд
    site:    2.6,                   // насколько близко к месту задачи (клетки боя)
    exitR:   3.2
  };
  // Отряд одного охотника по числу охотников (общая сила растёт медленнее числа игроков)
  var SQUAD = { hunt_sith: { 1: 12, 2: 8, 3: 6, 4: 5 }, hunt_jedi: { 1: 10, 2: 6, 3: 5, 4: 4 } };
  // одному охотнику на II–III — подкрепление: скрытную добычу в одиночку не взять
  var SOLO = { hunt_sith: [0, 8, 4], hunt_jedi: [0, 0, 0] };
  var KIT = {
    // [сенсорщик, основной, тяжёлый, снайпер, элита уровня III]
    hunt_sith: { team: 0, prey: 'cis_sith', preyTeam: 1, scan: 'rep_officer', main: 'rep_dc15a', heavy: 'rep_heavy', sniper: 'rep_sniper', elite: 'rep_commando',
                 abil: [['dash_dark', 'push_dark', 'throw_dark', 'choke_dark'], ['dash_dark', 'push_dark', 'throw_dark', 'choke_dark', 'drain_dark', 'lightning_dark', 'fear_dark'],
                        ['dash_dark', 'push_dark', 'throw_dark', 'choke_dark', 'drain_dark', 'lightning_dark', 'fear_dark', 'mind_enslave']],
                 passive: { damage: 25, absorb: 30, evasion: 10, hp: 60, vision: 3 }, portraits: ['sith_01', 'sith_02', 'sith_03', 'sith_04', 'sith_05', 'sith_06'],
                 names: ['Дарт Ксерон', 'Дарт Морвек', 'Дарт Илланис', 'Дарт Саврен', 'Дарт Кейл', 'Дарт Ноктис'], word: 'ситх', words: 'ситх', scanName: 'офицер' },
    hunt_jedi: { team: 1, prey: 'rep_jedi', preyTeam: 0, scan: 'cis_bounty', main: 'cis_b1', heavy: 'cis_b2', sniper: 'cis_b1_sniper', elite: 'cis_bx',
                 abil: [['dash_light', 'push_light', 'throw_light', 'heal_light'], ['dash_light', 'push_light', 'throw_light', 'heal_light', 'barrier_light', 'pacify_light'],
                        ['dash_light', 'push_light', 'throw_light', 'heal_light', 'barrier_light', 'pacify_light', 'mind_suasion']],
                 passive: { deflect: 30, acc: 4, evasion: 10, hp: 60, vision: 3 }, portraits: ['jedi_01', 'jedi_02', 'jedi_03', 'jedi_04', 'jedi_05', 'jedi_06', 'jedi_07', 'jedi_08'],
                 names: ['Мастер Аэлин Тор', 'Рыцарь Каэд Вэлл', 'Мастер Сорин Дал', 'Рыцарь Иса Мерен', 'Мастер Тэлон Куор', 'Рыцарь Линн Аваро'], word: 'джедай', words: 'джедаи', scanName: 'охотник за головами' }
  };
  // Прочность добычи: множитель по уровню и числу охотников (1–4), подобран прогоном ботов
  // (tools/events/sim.js). На II–III добыча скрытна — против одного охотника ей нужно меньше прочности.
  var PREY_HP = {
    hunt_sith: [[0.61, 1.79, 3.06, 4.25], [0.31, 0.8, 1.53, 2.13], [0.38, 0.89, 1.53, 2.5]],
    hunt_jedi: [[1.42, 3.9, 3.78, 5.4], [1.05, 2.7, 2.8, 4.5], [0.89, 2.21, 2.38, 3.4]]
  };

  function rng(seed) { var s = (seed >>> 0) || 7; return function() { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
  function d2(a, x, y) { var dx = a.x - x, dy = a.y - y; return dx * dx + dy * dy; }
  function fmt(t) { t = Math.max(0, Math.ceil(t)); return Math.floor(t / 60) + ':' + ('0' + t % 60).slice(-2); }

  // ---------------------------------------------------------------- охота
  function Hunt(B, cfg) {
    this.B = B; this.cfg = cfg; this.E = CAT.BY[cfg.event]; this.K = KIT[cfg.event];
    this.tier = Math.max(1, Math.min(3, cfg.tier | 0)); this.ti = this.tier - 1;
    this.R = rng(cfg.seed || 1977);
    this.ev = cfg.map.ev; this.hunterTeam = this.K.team; this.preyTeam = this.K.preyTeam;
    this.preyRole = cfg.event === 'hunt_sith' ? 'sith' : 'jedi';
    this.players = (cfg.players || []).slice();
    this.limit = this.E.minutes[this.ti] * 60;
    this.tasks = []; this.exit = null; this.exitProg = 0; this.ping = null; this.nextPing = HUNT.ping[this.ti] * 0.6;
    this.alarm = null; this.seen = null; this.stats = {}; this.deathsT = -1; this.result = null; this.msgs = [];
    this.botT = 0; this.hunt = {};
  }
  Hunt.prototype.owners = function(role) { return this.players.filter(function(p) { return p.role === role; }); };
  Hunt.prototype.setup = function() {
    var B = this.B, K = this.K, ev = this.ev, self = this, R = this.R, ti = this.ti;
    B.weather = (B.weather || 0) + HUNT.night[ti];
    // задачи: tier из пяти мест, порядок — свободный
    var idx = ev.sites.map(function(s, i) { return i; });
    for (var i = idx.length - 1; i > 0; i--) { var j = Math.floor(R() * (i + 1)), t = idx[i]; idx[i] = idx[j]; idx[j] = t; }
    this.tasks = idx.slice(0, HUNT.tasks[ti]).map(function(i) { var s = ev.sites[i]; return { site: i, x: s[0], y: s[1], name: s[2], need: HUNT.channel[ti], prog: 0, done: false, active: false }; });
    // охотники: лагерь делится на полосы по игрокам
    var hunters = this.owners('hunter'), n = Math.max(1, hunters.length), per = (SQUAD[this.cfg.event][Math.min(4, n)] || 4) + (n === 1 ? SOLO[this.cfg.event][ti] : 0), base = ev.base, lane = base[2] / n;
    var aimH = Math.atan2(ev.prey[1][1] - (base[1] + base[3] / 2), ev.prey[1][0] - (base[0] + base[2] / 2));
    this.hunterUnits = 0;
    hunters.forEach(function(p, k) {
      var list = [K.scan, K.heavy, K.sniper], main = per - 3;
      if (per >= 8) { list.push(K.heavy); main--; }
      if (ti === 2) { list.push(K.elite); main--; }
      for (var q = 0; q < Math.max(1, main); q++) list.push(K.main);
      var box = [Math.floor(base[0] + lane * k) + 1, base[1] + 1, Math.max(3, Math.floor(lane) - 2), base[3] - 2];
      list.forEach(function(tid) { var a = self.put(tid, self.hunterTeam, box, { owner: p.user, aim: aimH }); if (a) { a.evRole = 'hunter'; a.evScan = tid === K.scan; self.hunterUnits++; } });
    });
    // добыча: в одном из трёх стартов (джедаи — рядом друг с другом)
    var prey = this.owners(this.preyRole), st = ev.prey[Math.floor(R() * ev.prey.length)];
    var hpK = PREY_HP[this.cfg.event][ti][Math.min(4, n) - 1] * (prey.length > 1 ? 0.8 : 1);
    var names = K.names.slice(), portr = K.portraits.slice();
    prey.forEach(function(p, k) {
      var nm = names.splice(Math.floor(R() * names.length), 1)[0], pt = portr.splice(Math.floor(R() * portr.length), 1)[0];
      var a = self.put(K.prey, self.preyTeam, [Math.floor(st[0]) - 2 + k * 2, Math.floor(st[1]) - 2, 3, 3], { owner: p.user, aim: Math.PI / 2, hero: true, name: nm, portrait: pt, abil: K.abil[ti].slice(), passive: K.passive, hpK: hpK });
      if (a) { a.evRole = self.preyRole; a.sneak = HUNT.sneak[ti]; a.revealFor = HUNT.reveal; }
    });
    this.msg(this.preyTeam, 'Задачи: ' + this.tasks.map(function(t) { return t.name; }).join(', ') + '. Потом — эвакуация', 'gold');
    this.msg(this.hunterTeam, (prey.length > 1 ? 'Джедаи где-то на карте' : 'Цель где-то на карте') + '. Сенсорщики дадут импульс через ' + Math.round(this.nextPing) + ' с', 'gold');
    B.onAI = function() {};
  };
  Hunt.prototype.put = function(tid, team, box, ex) {
    var B = this.B, U = GR.U || null, R = this.R;
    for (var t = 0; t < 400; t++) {
      var x = box[0] + Math.floor(R() * box[2]), y = box[1] + Math.floor(R() * box[3]);
      var spot = B.nearestOk('foot', 1, x, y); if (!spot) continue;
      var taken = false; for (var i = 0; i < B.agents.length; i++) { var o = B.agents[i]; if (o.alive && Math.abs(o.x - spot[0] - 0.5) < 0.9 && Math.abs(o.y - spot[1] - 0.5) < 0.9) { taken = true; break; } }
      if (taken && t < 300) continue;
      var a = B.add(tid, team, spot[0] + 0.5, spot[1] + 0.5, { owner: ex.owner, aim: ex.aim, name: ex.name, portrait: ex.portrait, abil: ex.abil, passive: ex.passive, hpK: ex.hpK });
      return a;
    }
    return null;
  };
  Hunt.prototype.msg = function(team, text, kind) { this.B.msg(text, team, kind || 'gold'); };
  Hunt.prototype.preys = function() { var self = this; return this.B.agents.filter(function(a) { return a.alive && a.evRole === self.preyRole; }); };
  Hunt.prototype.hunters = function() { var self = this; return this.B.agents.filter(function(a) { return a.alive && a.evRole === 'hunter'; }); };

  Hunt.prototype.step = function() {
    var B = this.B; if (this.result) return;
    var t = B.t, preys = this.preys(), hunters = this.hunters(), self = this;
    this.countDeaths();
    // видна ли добыча охотникам (для худа и ботов)
    for (var i = 0; i < preys.length; i++) if (B.canSee(this.hunterTeam, preys[i])) { this.seen = { x: preys[i].x, y: preys[i].y, t: t, id: preys[i].id }; break; }
    // задачи: прогресс у места (любой живой из добычи рядом, не оглушён и не в страхе)
    var R2 = HUNT.site * HUNT.site, allDone = true;
    this.tasks.forEach(function(k) {
      if (k.done) return;
      var on = preys.some(function(a) { return d2(a, k.x, k.y) <= R2 && !(a.stun > 0) && !(a.fear > 0) && !(a.choke >= 0); });
      if (on && !k.active) { k.active = true; self.alarm = { x: k.x, y: k.y, name: k.name, t: t, k: k }; self.msg(self.hunterTeam, 'Тревога: ' + (preys.length > 1 ? 'джедаи' : 'цель') + ' у «' + k.name + '»', 'bad'); }
      if (!on && k.active) k.active = false;
      // тревога держится, пока добыча у места, и ещё 30 с после
      if (on && self.alarm && self.alarm.k === k) self.alarm.t = t;
      if (on) { k.prog = Math.min(k.need, k.prog + 0.1); if (k.prog >= k.need) { k.done = true; k.active = false; self.msg(self.preyTeam, 'Задача выполнена: ' + k.name, 'gold'); self.msg(self.hunterTeam, 'Задача врага выполнена: ' + k.name, 'bad'); } }
      if (!k.done) allDone = false;
    });
    if (allDone && !this.exit) {
      var ex = this.ev.exits[Math.floor(this.R() * this.ev.exits.length)];
      var eta = HUNT.eta[this.ti];
      this.exit = { x: ex[0], y: ex[1], name: ex[2], t: t, land: t + eta, landed: false };
      this.msg(this.preyTeam, 'Все задачи выполнены. Шаттл вызван: «' + ex[2] + '», посадка через ' + eta + ' с', 'gold');
      this.msg(this.hunterTeam, 'Враг вызвал шаттл: «' + ex[2] + '», посадка через ' + eta + ' с. Перехватить!', 'bad');
    }
    if (this.exit) {
      if (!this.exit.landed && t >= this.exit.land) { this.exit.landed = true; this.msg(this.preyTeam, 'Шаттл сел: продержись на площадке ' + HUNT.extract + ' с', 'gold'); this.msg(this.hunterTeam, 'Шаттл врага сел на «' + this.exit.name + '»', 'bad'); }
      var E2 = HUNT.exitR * HUNT.exitR, onE = this.exit.landed && preys.some(function(a) { return d2(a, self.exit.x, self.exit.y) <= E2; });
      this.exitProg = onE ? this.exitProg + 0.1 : Math.max(0, this.exitProg - 0.2);
      if (this.exitProg >= HUNT.extract) return this.finish(this.preyRole, preys.length > 1 ? 'Джедаи ушли с эвакуацией' : (this.preyRole === 'sith' ? 'Ситх ушёл' : 'Джедай ушёл') + ' на эвакуации');
    }
    // импульс сенсорщиков
    if (t >= this.nextPing) {
      var scan = hunters.some(function(a) { return a.evScan; });
      this.nextPing = t + HUNT.ping[this.ti];
      if (scan && preys.length) {
        var p = preys[Math.floor(this.R() * preys.length)], r = HUNT.pingR[this.ti], ang = this.R() * Math.PI * 2, off = this.R() * r * 0.6;
        this.ping = { x: p.x + Math.cos(ang) * off, y: p.y + Math.sin(ang) * off, r: r, t: t };
        this.msg(this.hunterTeam, 'Сенсорный импульс: цель в круге', 'gold');
        this.msg(this.preyTeam, 'Тебя засекли сенсоры — охотники знают район', 'bad');
      }
    }
    // исход
    if (!preys.length) return this.finish('hunter', this.preyRole === 'sith' ? 'Ситх уничтожен' : (this.owners(this.preyRole).length > 1 ? 'Джедаи уничтожены' : 'Джедай уничтожен'));
    if (!hunters.length) return this.finish(this.preyRole, 'Охотники перебиты');
    if (t >= this.limit) return this.finish('hunter', 'Время вышло: ' + (this.preyRole === 'sith' ? 'ситх не успел уйти' : 'джедаи не успели уйти'));
    // боты
    if (t >= this.botT) { this.botT = t + 0.5; this.bots(preys, hunters); }
  };
  Hunt.prototype.countDeaths = function() {
    var B = this.B, ds = B.ev.deaths, self = this;
    for (var i = 0; i < ds.length; i++) {
      var d = ds[i]; if (d.t <= this.deathsT) continue;
      var dead = B.agents[d.id], by = d.by != null && d.by < 100000 ? B.agents[d.by] : null;
      if (by && by.owner) { var s = self.stats[by.owner] || (self.stats[by.owner] = { kills: 0, lost: 0 }); s.kills++; }
      if (dead && dead.owner) { var s2 = self.stats[dead.owner] || (self.stats[dead.owner] = { kills: 0, lost: 0 }); s2.lost++; }
    }
    if (ds.length) this.deathsT = ds[ds.length - 1].t;
  };
  Hunt.prototype.finish = function(winner, why) {
    var B = this.B, team = winner === 'hunter' ? this.hunterTeam : this.preyTeam;
    B.over = team; B.why = why;
    this.result = { winner: winner, why: why, t: Math.round(B.t), stats: this.stats, tasks: this.tasks.filter(function(k) { return k.done; }).length, need: this.tasks.length };
  };
  // Что показать стороне: добыча знает свои задачи, охотники — все места и тревоги
  Hunt.prototype.view = function(team) {
    var B = this.B, t = B.t, prey = team === this.preyTeam, self = this;
    var v = { k: 'hunt', ev: this.cfg.event, tier: this.tier, role: prey ? this.preyRole : 'hunter', left: Math.max(0, Math.round(this.limit - t)), T: Math.round(t),
              sites: this.ev.sites.map(function(s, i) { var k = self.taskAt(i); return prey ? (k ? [s[0], s[1], s[2], k.done ? 2 : k.active ? 1 : 0, Math.round(k.prog / k.need * 100)] : null) : [s[0], s[1], s[2], k && k.done ? 2 : -1, 0]; }).filter(Boolean),
              tasks: prey ? this.tasks.map(function(k) { return [k.name, Math.round(k.prog / k.need * 100), k.done ? 1 : 0]; }) : null,
              done: this.tasks.filter(function(k) { return k.done; }).length, need: this.tasks.length,
              exit: this.exit ? [this.exit.x, this.exit.y, this.exit.name, Math.min(100, Math.round(this.exitProg / HUNT.extract * 100)), Math.max(0, Math.ceil(this.exit.land - t)), HUNT.eta[this.ti]] : null,
              exits: this.ev.exits.map(function(e) { return [e[0], e[1], e[2]]; }),
              preyN: this.preys().length, huntN: this.hunters().length, over: this.result ? this.result : null };
    if (!prey) {
      if (this.ping && t - this.ping.t < HUNT.pingShow) v.ping = [Math.round(this.ping.x * 10) / 10, Math.round(this.ping.y * 10) / 10, this.ping.r, Math.round((HUNT.pingShow - (t - this.ping.t)) * 10) / 10];
      v.nextPing = this.hunters().some(function(a) { return a.evScan; }) ? Math.max(0, Math.round(this.nextPing - t)) : -1;
      if (this.alarm && t - this.alarm.t < 30) { var ak = this.alarm.k; v.alarm = [this.alarm.x, this.alarm.y, this.alarm.name, Math.round(30 - (t - this.alarm.t)), ak && ak.active ? 1 : 0, ak ? Math.round(ak.prog / ak.need * 100) : 0]; }
      if (this.seen && t - this.seen.t < 20) v.seen = [Math.round(this.seen.x), Math.round(this.seen.y), Math.round(t - this.seen.t)];
    } else {
      v.nextPing = Math.max(0, Math.round(this.nextPing - t));
      // откаты сил своих героев (экран не считает их сам)
      v.cds = this.preys().map(function(a) { var o = {}; Object.keys(a.hero.cds).forEach(function(k) { var left = a.hero.cds[k] - t; if (left > 0) o[k] = Math.round(left); }); return [a.id, o]; });
    }
    return v;
  };
  Hunt.prototype.taskAt = function(i) { for (var k = 0; k < this.tasks.length; k++) if (this.tasks[k].site === i) return this.tasks[k]; return null; };

  // ---------------------------------------------------------------- боты
  Hunt.prototype.bots = function(preys, hunters) {
    var self = this;
    this.players.forEach(function(p) {
      if (!p.bot) return;
      if (p.role === self.preyRole) preys.forEach(function(a) { if (a.owner === p.user) self.preyBot(a, hunters); });
      else self.hunterBot(p, hunters.filter(function(a) { return a.owner === p.user; }), preys);
    });
  };
  // Сила героя по порядку: что применить к цели, если готово (ошибку движка — игнорировать)
  var PREY_ABIL = ['lightning_dark', 'choke_dark', 'throw_dark', 'throw_light', 'dash_dark', 'dash_light', 'fear_dark', 'push_dark', 'push_light', 'pacify_light', 'mind_enslave', 'mind_suasion'];
  Hunt.prototype.preyBot = function(a, hunters) {
    var B = this.B, t = B.t, team = this.preyTeam, self = this, hpk = a.hp / a.hpMax;
    var foes = hunters.filter(function(h) { return B.canSee(team, h); }), near = null, nd = 1e9, close = 0;
    foes.forEach(function(h) { var d = Math.sqrt(d2(h, a.x, a.y)); if (d < nd) { nd = d; near = h; } if (d < 10) close++; });
    // самолечение и купол
    if (hpk < 0.55) { B.useAbility(team, a.id, 'heal_light', { tid: a.id }); B.useAbility(team, a.id, 'drain_dark', near && nd < 4 ? { tid: near.id } : null); }
    if (close >= 3) B.useAbility(team, a.id, 'barrier_light', null);
    // силы по ближнему врагу в их дальности
    if (near && a.hero.actT <= 0) for (var i = 0; i < PREY_ABIL.length; i++) {
      var ab = PREY_ABIL[i], A = GR.ABIL[ab]; if (a.hero.abil.indexOf(ab) < 0 || (a.hero.cds[ab] || 0) > t) continue;
      if (ab === 'fear_dark' && close < 3) continue;
      if ((ab === 'push_dark' || ab === 'push_light') && close < 2) continue;
      if ((ab === 'dash_dark' || ab === 'dash_light') && nd < 3) continue;
      var tg = ab === 'mind_enslave' || ab === 'mind_suasion' || ab === 'pacify_light' ? self.strongest(foes, a, A[2] * RK) : near;
      if (!tg) continue;
      if (Math.sqrt(d2(tg, a.x, a.y)) > A[2] * RK) continue;
      if (!B.useAbility(team, a.id, ab, A[1] === 'area' ? { x: tg.x, y: tg.y } : { tid: tg.id })) break;
    }
    // куда: драться, уходить или к задаче / эвакуации
    var goal = this.exit ? [this.exit.x, this.exit.y] : this.nextTask(a, foes), near2 = this.exit ? HUNT.exitR - 1 : HUNT.site - 0.8;
    // шаттл ещё далеко — не стоять на виду у площадки, выйти к посадке
    if (this.exit && !this.exit.landed && this.exit.land - t > Math.sqrt(d2(a, this.exit.x, this.exit.y)) / Math.max(0.5, a.speed) + 4) goal = null;
    var danger = foes.filter(function(h) { return d2(h, a.x, a.y) < 15 * 15; }).length;
    if (near && nd < 11 && (hpk > 0.4 || nd < 3) && danger <= (this.tier === 3 ? 5 : 4)) {
      if (a.focus !== near.id) { a.focus = near.id; a.goal = null; a.at = true; a.post = false; a.hold = false; }
      return;
    }
    if (a.focus >= 0) { a.focus = -1; }
    if (near && nd < 14 && hpk <= 0.4) {
      var c = B.away(a, near, 16); if (c) { this.go(a, c[0], c[1]); return; }
    }
    if (goal) { var gd = Math.sqrt(d2(a, goal[0], goal[1])); if (gd > near2) this.go(a, Math.floor(goal[0]), Math.floor(goal[1])); else if (!a.at) { a.goal = null; a.at = true; } }
  };
  Hunt.prototype.strongest = function(list, a, r) { var best = null, bh = -1; list.forEach(function(h) { if (d2(h, a.x, a.y) <= r * r && h.hpMax > bh && !h.hero) { bh = h.hpMax; best = h; } }); return best; };
  Hunt.prototype.nextTask = function(a, foes) {
    var best = null, bs = 1e18, self = this;
    this.tasks.forEach(function(k) {
      if (k.done) return;
      var s = d2(a, k.x, k.y) + foes.reduce(function(acc, h) { return acc + (d2(h, k.x, k.y) < 14 * 14 ? 2500 : 0); }, 0) - (k.prog > 0 ? 400 : 0);
      if (s < bs) { bs = s; best = [k.x, k.y]; }
    });
    return best;
  };
  Hunt.prototype.go = function(a, x, y) {
    if (a.goal && !a.at && Math.abs(a.goal[0] - x) + Math.abs(a.goal[1] - y) < 3) return;
    var c = this.B.nearestOk(a.move, a.size, x, y); if (!c) return;
    this.B.goCell(a, c[0], c[1]); a.post = true; a.hold = false; a.focus = -1;
  };
  // Отряд-бот охотника: видят цель — все на неё; иначе к свежему следу, тревоге, импульсу; иначе обход мест задач
  Hunt.prototype.hunterBot = function(p, own, preys) {
    if (!own.length) return;
    var B = this.B, t = B.t, team = this.hunterTeam, st = this.hunt[p.user] || (this.hunt[p.user] = { i: this.players.indexOf(p), site: -1, until: 0, goal: null });
    var vis = preys.filter(function(a) { return B.canSee(team, a); });
    if (vis.length) {
      // цель видна: стрелять с дистанции; кого герой достаёт клинком — отходит (меч бьёт в упор)
      var tg = vis[0];
      own.forEach(function(a) {
        var d = Math.sqrt(d2(a, tg.x, tg.y));
        if (d < 5 && !(a.T.vehicle)) { var c = B.away(a, tg, Math.min(a.range * 0.8, d + 6)); if (c) { B.goCell(a, c[0], c[1]); a.post = true; a.focus = -1; a.hold = false; return; } }
        if (a.focus !== tg.id && !(a.post && !a.at && a.goal && d < 7)) B.orderAttack(team, [a.id], tg.id);
      });
      st.goal = null; return;
    }
    var g = null;
    if (this.seen && t - this.seen.t < 25) g = [this.seen.x, this.seen.y];
    else if (this.exit) g = [this.exit.x, this.exit.y];
    else if (this.alarm && t - this.alarm.t < 40) g = [this.alarm.x, this.alarm.y];
    else if (this.ping && t - this.ping.t < 30) { var ang = (st.i * 2.1) % (Math.PI * 2); g = [this.ping.x + Math.cos(ang) * this.ping.r * 0.5, this.ping.y + Math.sin(ang) * this.ping.r * 0.5]; }
    else {
      // обход: своё место задачи по кругу, у каждого — подольше
      var S = this.ev.sites;
      if (st.site < 0 || t > st.until) { st.site = (st.site < 0 ? st.i : st.site + 1 + Math.floor(this.R() * 2)) % S.length; st.until = t + 35 + this.R() * 20; }
      g = [S[st.site][0], S[st.site][1] + 4];
    }
    var gx = Math.max(1, Math.min(142, Math.round(g[0]))), gy = Math.max(1, Math.min(142, Math.round(g[1])));
    if (st.goal && Math.abs(st.goal[0] - gx) + Math.abs(st.goal[1] - gy) < 5 && own.some(function(a) { return a.goal && !a.at; })) return;
    st.goal = [gx, gy];
    own.forEach(function(a) { a.focus = -1; });
    B.orderMove(team, own.map(function(a) { return a.id; }), gx, gy);
  };


  // ================================================================ оборона от волн
  // Гарнизон (1–4 игрока) держит базу: ядро в середине площадки, вокруг — окопы, бункеры и турели
  // из карты (ev.forts). Волны врага высаживаются у краёв и идут к ядру; враг в зоне ядра без помехи
  // гарнизона ломает базу (прочность 100 → 0 — поражение). Все волны отбиты или время вышло, а база
  // стоит — победа. Сила волн — в «B1»: √(здоровье × урон) / 32, так дроиды и клоны сравнимы.
  var DEF = {
    waves:  [5, 10, 15],
    first:  [40, 35, 30],          // первая волна, с
    gapMax: [80, 70, 62],          // следующая волна не позже, с
    brk: 12,                       // волна зачищена — следующая через столько секунд
    warn: 12,                      // за сколько секунд объявить волну
    drain:  [0.45, 0.55, 0.65],    // прочности в секунду на единицу силы врага в зоне
    base:   [7, 5.5, 5],           // сила волны: base + slope × номер волны (B1, на одного игрока)
    slope:  [1.9, 1.65, 1.5],
    pk:     [1, 1.55, 2.05, 2.5],  // сила волн по числу игроков (гарнизон на игрока с числом игроков меньше)
    squad:  { 1: 28, 2: 21, 3: 18, 4: 16 },     // сила гарнизона одного игрока (B1)
    reinf:  [[3], [3, 7], [4, 8, 12]], reinfV: 10,   // подкрепление после волн и его сила на игрока
    heal: 0.15, repair: 0.15,      // волна отбита: раненым +15 % здоровья, укреплениям +15 % прочности
    cap: 72,                       // живых врагов на карте не больше — остальные высаживаются следом
    bossEvery: 5
  };
  var KITD = {
    // waveK — поправка силы волн: дроиды хрупче и проще клонов, укрепления выкашивают их быстрее
    r_tessara: { team: 0, foe: 1, waveK: 1.15, lead: 'rep_officer', basic: 'rep_dc15a', spec: ['rep_heavy', 'rep_heavy', 'rep_sniper', 'rep_launcher'], elite: 'rep_commando', veh: 'rep_atrt',
      enemy: { basic: 'cis_b1', mix: [[0.15, 'cis_b1_launcher', 0.1], [0.2, 'cis_b1_sniper', 0.08], [0.3, 'cis_b2', 0.25], [0.45, 'cis_wheel', 0.12], [0.5, 'cis_stap', 0.1], [0.65, 'cis_bx', 0.12]],
               boss: ['cis_aat'], bossLite: ['cis_stap', 'cis_stap', 'cis_bx'] },
      base: 'аванпост', baseGen: 'аванпоста', foes: 'дроиды', foesGen: 'дроидов', lost: 'Аванпост пал', held: 'Аванпост устоял: флот на подходе', won: 'Все волны дроидов отбиты' },
    c_siege: { team: 1, foe: 0, lead: 'cis_bx', basic: 'cis_b1', spec: ['cis_b2', 'cis_b2', 'cis_b1_sniper', 'cis_b1_launcher', 'cis_wheel'], elite: 'cis_bounty', veh: 'cis_stap',
      enemy: { basic: 'rep_dc15a', mix: [[0.15, 'rep_launcher', 0.1], [0.2, 'rep_sniper', 0.08], [0.3, 'rep_heavy', 0.18], [0.45, 'rep_barc', 0.1], [0.5, 'rep_atrt', 0.1], [0.6, 'rep_arc', 0.1], [0.75, 'rep_commando', 0.08]],
               boss: ['rep_atte'], bossLite: ['rep_barc', 'rep_barc', 'rep_arc'] },
      base: 'завод', baseGen: 'завода', foes: 'клоны', foesGen: 'клонов', lost: 'Завод захвачен', held: 'Завод устоял: подходит эскадра', won: 'Все волны клонов отбиты' }
  };
  function power(tid) {
    var T = UN.type(tid); if (!T) return 1;
    return Math.sqrt(Math.max(1, T.hp) * Math.max(1, T.dmg)) / 32 * (T.wheel ? 1.4 : 1);
  }

  function Defense(B, cfg) {
    this.B = B; this.cfg = cfg; this.E = CAT.BY[cfg.event]; this.K = KITD[cfg.event];
    this.tier = Math.max(1, Math.min(3, cfg.tier | 0)); this.ti = this.tier - 1;
    this.R = rng(cfg.seed || 1977);
    this.ev = cfg.map.ev; this.team = this.K.team; this.foe = this.K.foe;
    this.players = (cfg.players || []).slice();
    this.limit = this.E.minutes[this.ti] * 60;
    this.W = DEF.waves[this.ti]; this.wave = 0; this.cleared = 0;
    this.next = DEF.first[this.ti]; this.lastSpawn = 0; this.warned = 0; this.plan = null;
    this.queue = []; this.hp = 100; this.hpMsg = 100;
    this.stats = {}; this.deathsT = -1; this.result = null; this.botT = 0; this.aiT = 0; this.zT = 0; this.reinfDone = {};
    this.n = Math.max(1, Math.min(4, this.owners().length));
    this.core = { x: this.ev.core[0], y: this.ev.core[1], name: this.ev.core[2] }; this.zone = this.ev.zone || 7;
    this.posts = []; this.press = 0;
  }
  Defense.prototype.owners = function() { return this.players.filter(function(p) { return p.role === 'defender'; }); };
  Defense.prototype.msg = Hunt.prototype.msg;
  Defense.prototype.countDeaths = Hunt.prototype.countDeaths;
  Defense.prototype.setup = function() {
    var B = this.B, self = this, K = this.K, ev = this.ev;
    // укрепления карты — гарнизону
    (ev.forts || []).forEach(function(f) { B.addStruct(f[0], self.team, f[1], f[2]); });
    // посты: места в окопах и бункерах, потом кольцо вокруг ядра — лицом к высадкам
    this.posts = this.makePosts();
    var list = this.owners();
    list.forEach(function(p, k) { self.squad(p, DEF.squad[self.n] + (self.n === 1 ? 4 : 0), true, k); });
    this.msg(this.team, 'Держи ' + K.base + ': ' + K.foes + ' пойдут ' + this.W + ' волнами. Первая — через ' + Math.round(this.next) + ' с', 'gold');
    B.onAI = function() {};
  };
  // Сила игрока: лидер, особые, элита на III, техника одиночке, остальное — основными
  Defense.prototype.squad = function(p, value, first, k) {
    var K = this.K, list = [], v = 0, self = this, B = this.B;
    if (first) { list.push(K.lead); K.spec.forEach(function(t) { list.push(t); }); if (this.ti === 2) list.push(K.elite); if (this.n <= 2) list.push(K.veh); }
    else { list.push(K.spec[Math.floor(this.R() * K.spec.length)]); }
    list.forEach(function(t) { v += power(t); });
    var pb = power(K.basic);
    while (v + pb * 0.5 < value) { list.push(K.basic); v += pb; }
    var n = 0;
    list.forEach(function(tid, i) {
      var slot = self.freePost(tid, k), a = slot ? self.put(tid, self.team, slot, { owner: p.user, aim: slot.aim }) : null;
      if (!a) { slot = null; a = self.put(tid, self.team, [Math.floor(self.core.x) - 4, Math.floor(self.core.y) + 3, 8, 3], { owner: p.user, aim: 0 }); }
      if (!a) return;
      a.evRole = 'defender'; a.post0 = slot ? slot.post : null; n++;
      if (slot) {
        slot.post.by = a.id;
        // в окопе или бункере — держит место (не выбегает за целью); игрок может увести приказом
        if (slot.post.fort) { var c = B.cellOf(a); a.goal = [c[0], c[1]]; a.at = true; a.hold = true; }
      }
    });
    return n;
  };
  Defense.prototype.makePosts = function() {
    var B = this.B, c = this.core, ev = this.ev, out = [], taken = {}, N = 144, self = this;
    var dirs = (ev.spawns || []).map(function(s) { var dx = s[0] - c.x, dy = s[1] - c.y, l = Math.sqrt(dx * dx + dy * dy) || 1; return [dx / l, dy / l]; });
    B.structs.forEach(function(st) {
      if (!st.enter) return;
      for (var y = st.y; y < st.y + st.h; y++) for (var x = st.x; x < st.x + st.w; x++) { out.push({ x: x, y: y, fort: true, aim: self.aimAt(x, y, dirs), by: -1 }); taken[y * N + x] = 1; }
    });
    // кольцо: на 6–11 клетках от ядра, ближе к направлениям высадок, в шахматном порядке
    var ring = [];
    for (var y = Math.floor(c.y) - 12; y <= Math.floor(c.y) + 12; y++) for (var x = Math.floor(c.x) - 12; x <= Math.floor(c.x) + 12; x++) {
      if (x < 1 || y < 1 || x > N - 2 || y > N - 2 || taken[y * N + x] || (x + y) & 1) continue;
      var dx = x + 0.5 - c.x, dy = y + 0.5 - c.y, d = Math.sqrt(dx * dx + dy * dy);
      if (d < 5 || d > 11 || !B.pass.foot1[y * N + x] || B.structAt[y * N + x] >= 0) continue;
      var dot = -1; dirs.forEach(function(u) { dot = Math.max(dot, (dx * u[0] + dy * u[1]) / d); });
      ring.push({ x: x, y: y, fort: false, aim: Math.atan2(dy, dx), by: -1, sc: dot * 2 - Math.abs(d - 8.5) * 0.3 + this.R() * 0.2 });
    }
    ring.sort(function(a, b) { return b.sc - a.sc; });
    return out.concat(ring);
  };
  Defense.prototype.aimAt = function(x, y, dirs) {
    var c = this.core, dx = x + 0.5 - c.x, dy = y + 0.5 - c.y, d = Math.sqrt(dx * dx + dy * dy) || 1, best = Math.atan2(dy, dx), bd = -2;
    dirs.forEach(function(u) { var k = (dx * u[0] + dy * u[1]) / d; if (k > bd) { bd = k; best = Math.atan2(u[1], u[0]); } });
    return best;
  };
  // Пост для бойца: пехоте — укрепления, потом кольцо; технике — кольцо (снаружи укреплений)
  Defense.prototype.freePost = function(tid, k) {
    var T = UN.type(tid), inf = T && T.cls === 'infantry' && !T.wheel, B = this.B;
    for (var i = 0; i < this.posts.length; i++) {
      var p = this.posts[i]; if (p.fort && !inf) continue;
      if (p.by >= 0) { var o = B.agents[p.by]; if (o && o.alive) continue; p.by = -1; }
      if (T && T.size === 2 && !B.pass[T.move + 2][p.y * 144 + p.x]) continue;
      return { x: p.x, y: p.y, aim: p.aim, post: p, box: [p.x, p.y, 1, 1] };
    }
    return null;
  };
  // Поставить бойца: box — [x, y, w, h] или пост; техника 2×2 — по своей проходимости
  Defense.prototype.put = function(tid, team, box, ex) {
    var B = this.B, R = this.R, T = UN.type(tid); if (!T) return null;
    if (box.box) { var pp = box; box = pp.box; }
    for (var t = 0; t < 200; t++) {
      var x = box[0] + Math.floor(R() * box[2]), y = box[1] + Math.floor(R() * box[3]);
      var spot = B.nearestOk(T.move, T.size, x, y); if (!spot) continue;
      var off = T.size === 2 ? 1 : 0.5, taken = false;
      if (!B.okAt({ move: T.move, size: T.size, team: team, T: T, air: T.air, fly: T.move === 'air' }, spot[0], spot[1]) && t < 150) continue;   // не внутри турели или чужого укрепления
      for (var i = 0; i < B.agents.length; i++) { var o = B.agents[i]; if (o.alive && Math.abs(o.x - spot[0] - off) < 0.9 && Math.abs(o.y - spot[1] - off) < 0.9) { taken = true; break; } }
      if (taken && t < 150) continue;
      return B.add(tid, team, spot[0] + off, spot[1] + off, { owner: ex.owner, aim: ex.aim });
    }
    return null;
  };

  Defense.prototype.foes = function() { var f = this.foe; return this.B.agents.filter(function(a) { return a.alive && a.team === f; }); };
  Defense.prototype.mine = function() { var tm = this.team; return this.B.agents.filter(function(a) { return a.alive && a.team === tm && a.evRole === 'defender'; }); };
  Defense.prototype.inZone = function(a) { var dx = a.x - this.core.x, dy = a.y - this.core.y; return dx * dx + dy * dy <= this.zone * this.zone; };
  Defense.prototype.weight = function(a) { return a.T.size === 2 ? 3 : a.T.vehicle ? 1.5 : 1; };

  // Состав волны: бюджет силы; босс раз в пять волн и в последней
  Defense.prototype.makeWave = function(w) {
    var K = this.K.enemy, f = w / this.W, list = [], self = this;
    // сила: уровень и номер волны × число игроков × поправки ивента и карты (тесная застройка — меньше)
    var budget = (DEF.base[this.ti] + DEF.slope[this.ti] * w) * DEF.pk[this.n - 1] * (this.K.waveK || 1) * (this.ev.waveK || 1);
    var boss = w % DEF.bossEvery === 0 || w === this.W;
    if (boss) { (this.ti === 0 ? K.bossLite : K.boss).forEach(function(t) { list.push(t); budget -= power(t); }); }
    K.mix.forEach(function(m) {
      if (f < m[0]) return;
      var share = budget * m[2], pv = power(m[1]), n = Math.floor(share / pv + self.R() * 0.6);
      for (var i = 0; i < n; i++) list.push(m[1]);
      budget -= n * pv;
    });
    var pb = power(K.basic), nb = Math.max(2, Math.round(budget / pb));
    for (var j = 0; j < nb; j++) list.push(K.basic);
    // высадки: 1 → 2 → 3 по кругу, на чётных — две, босс — со всех
    var S = this.ev.spawns, from;
    if (boss || S.length < 2) from = S.map(function(s, i) { return i; });
    else if (w % 2 === 0) { var a0 = (w / 2) % S.length; from = [a0, (a0 + 1) % S.length]; }
    else from = [(w - 1) % S.length];
    return { w: w, list: list, from: from, boss: boss };
  };
  Defense.prototype.dirName = function(from) { var S = this.ev.spawns; return from.length >= S.length ? 'со всех сторон' : 'высадка: ' + from.map(function(i) { return '«' + S[i][2] + '»'; }).join(' и '); };
  function plural(n, a, b, c) { var m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 12 || h > 14) ? b : c; }

  Defense.prototype.step = function() {
    var B = this.B; if (this.result) return;
    var t = B.t, self = this;
    this.countDeaths();
    // волны: объявить, высадить
    if (this.wave < this.W) {
      if (!this.plan) this.plan = this.makeWave(this.wave + 1);
      if (this.warned < this.plan.w && this.next - t <= DEF.warn) {
        this.warned = this.plan.w;
        var tx = (this.plan.w === this.W ? 'Последняя волна' : 'Волна ' + this.plan.w) + (this.plan.boss ? ' с тяжёлой техникой' : '') + ' через ' + Math.max(1, Math.round(this.next - t)) + ' с — ' + this.dirName(this.plan.from);
        this.msg(this.team, tx, this.plan.boss ? 'bad' : 'gold');
      }
      if (t >= this.next) {
        var pl = this.plan; this.plan = null; this.wave = pl.w; this.lastSpawn = t;
        var S = this.ev.spawns;
        pl.list.forEach(function(tid, i) { var s = S[pl.from[i % pl.from.length]]; self.queue.push({ tid: tid, s: s, w: pl.w }); });
        this.next = this.wave < this.W ? t + DEF.gapMax[this.ti] : 1e9;
        this.msg(this.team, (pl.w === this.W ? 'Последняя волна' : 'Волна ' + pl.w + ' из ' + this.W) + ': ' + pl.list.length + ' ' + plural(pl.list.length, 'враг', 'врага', 'врагов') + ' — ' + this.dirName(pl.from), 'bad');
      }
    }
    // высадка из очереди: не больше cap живых врагов
    if (this.queue.length && t >= (this.dropT || 0)) {
      this.dropT = t + 0.5;
      var alive = this.foes().length, k = 0;
      while (this.queue.length && alive < DEF.cap && k < 8) {
        var q = this.queue.shift(), a = this.put(q.tid, this.foe, [Math.floor(q.s[0]) - 3, Math.floor(q.s[1]) - 3, 6, 6], { owner: null, aim: Math.atan2(this.core.y - q.s[1], this.core.x - q.s[0]) });
        if (a) { a.wv = q.w; a.evRole = 'foe'; alive++; k++; }
      }
    }
    var foes = this.foes();
    // зачищена ли волна; вся зачищена — следующая скоро
    var live = {}; foes.forEach(function(a) { live[a.wv] = 1; }); this.queue.forEach(function(q) { live[q.w] = 1; });
    while (this.cleared < this.wave && !live[this.cleared + 1]) {
      this.cleared++;
      if (this.cleared < this.W) { this.msg(this.team, 'Волна ' + this.cleared + ' отбита · медики и техники подлатали гарнизон', 'gold'); this.mend(); }
      if (DEF.reinf[this.ti].indexOf(this.cleared) >= 0 && !this.reinfDone[this.cleared]) this.reinforce(this.cleared);
    }
    if (this.wave > 0 && this.wave < this.W && this.cleared === this.wave && t - this.lastSpawn > 15) this.next = Math.min(this.next, Math.max(t + DEF.brk, this.lastSpawn + 25));
    // ядро: враг в зоне без помехи ломает базу
    if (t >= this.zT) {
      var dt = t - (this.zLast || t); this.zLast = t; this.zT = t + 0.5;
      var e = 0, d = 0;
      foes.forEach(function(a) { if (self.inZone(a)) e += self.weight(a); });
      this.mine().forEach(function(a) { if (self.inZone(a)) d += self.weight(a); });
      this.press = Math.max(0, e - d * 0.5);
      this.contested = e > 0;
      if (this.press > 0) {
        this.hp = Math.max(0, this.hp - this.press * DEF.drain[this.ti] * dt);
        [75, 50, 25].forEach(function(th) { if (self.hp <= th && self.hpMsg > th) { self.hpMsg = th; self.msg(self.team, 'Враг у ядра! ' + self.core.name + ': ' + th + '%', 'bad'); } });
      }
    }
    // исход
    if (this.hp <= 0) return this.finish('enemy', this.K.lost);
    if (!this.mine().length && !this.pendingReinf()) return this.finish('enemy', 'Гарнизон уничтожен');
    if (this.wave >= this.W && !this.queue.length && !foes.length) return this.finish('defender', this.K.won);
    if (t >= this.limit) return this.finish('defender', this.K.held);
    // враги — к ядру; боты гарнизона
    if (t >= this.aiT) { this.aiT = t + 1; this.foeAI(foes); }
    if (t >= this.botT) { this.botT = t + 1; this.bots(foes); }
  };
  Defense.prototype.pendingReinf = function() { return false; };
  // Волна отбита: раненым — часть здоровья, укреплениям — часть прочности
  Defense.prototype.mend = function() {
    var tm = this.team;
    this.mine().forEach(function(a) { a.hp = Math.min(a.hpMax, a.hp + a.hpMax * DEF.heal); });
    this.B.structs.forEach(function(st) { if (!st.dead && st.team === tm) st.hp = Math.min(st.hpMax, st.hp + st.hpMax * DEF.repair); });
  };
  Defense.prototype.reinforce = function(w) {
    var self = this, n = 0;
    this.reinfDone[w] = true;
    this.owners().forEach(function(p, k) { n += self.squad(p, DEF.reinfV, false, k); });
    if (n) this.msg(this.team, 'Подкрепление: +' + n + ' бойцов у ядра', 'gold');
  };
  Defense.prototype.finish = function(winner, why) {
    var B = this.B; B.over = winner === 'defender' ? this.team : this.foe; B.why = why;
    this.result = { winner: winner, why: why, t: Math.round(B.t), stats: this.stats, tasks: this.cleared, need: this.W, hp: Math.round(this.hp) };
  };
  // Враг: свободные — к ядру (точка в зоне), с поправкой, если застряли; занятых боем не трогаем
  Defense.prototype.foeAI = function(foes) {
    var B = this.B, c = this.core, self = this, groups = {};
    foes.forEach(function(a) {
      if (a.tgt >= 0 || a.focus >= 0 || a.og) return;
      var dx = a.x - c.x, dy = a.y - c.y, d = Math.sqrt(dx * dx + dy * dy);
      if (d <= self.zone - 1.5) return;                                   // у ядра — стоит и ломает
      if (a.goal && !a.at && B.t - (a.ordT || 0) < 20) return;            // идёт
      a.ordT = B.t;
      var key = (a.wv || 0) + ':' + (a.T.size === 2 ? 'v' : 'i') + ':' + Math.round(Math.atan2(dy, dx) * 2);
      (groups[key] = groups[key] || []).push(a.id);
    });
    Object.keys(groups).forEach(function(k) {
      var ids = groups[k], a0 = B.agents[ids[0]], ang = Math.atan2(a0.y - c.y, a0.x - c.x), r = self.zone * 0.45;
      B.orderMove(self.foe, ids, Math.round(c.x + Math.cos(ang) * r), Math.round(c.y + Math.sin(ang) * r), { auto: true });
    });
  };
  // Гарнизон-бот: враг в зоне ядра — ближние бойцы на него; иначе — на свой пост
  Defense.prototype.bots = function(foes) {
    var B = this.B, self = this, team = this.team, intr = foes.filter(function(a) { return self.inZone(a) || (Math.abs(a.x - self.core.x) < self.zone + 4 && Math.abs(a.y - self.core.y) < self.zone + 4); });
    this.players.forEach(function(p) {
      if (!p.bot || p.role !== 'defender') return;
      var own = self.mine().filter(function(a) { return a.owner === p.user; });
      own.forEach(function(a, i) {
        if (intr.length && (i % 2 === 0 || intr.length > 3)) {
          var best = null, bd = 1e9; intr.forEach(function(b) { var dd = d2(b, a.x, a.y); if (dd < bd) { bd = dd; best = b; } });
          if (best && bd < 22 * 22 && a.focus !== best.id) { B.orderAttack(team, [a.id], best.id); return; }
          if (best && bd < 22 * 22) return;
        }
        if (a.focus >= 0 && !(B.agents[a.focus] && B.agents[a.focus].alive)) a.focus = -1;
        if (a.tgt >= 0 || a.focus >= 0) return;
        var po = a.post0; if (!po) return;
        var far = Math.abs(a.x - po.x - 0.5) + Math.abs(a.y - po.y - 0.5) > 2.5;
        if (far && (a.at || !a.goal)) { B.goCell(a, po.x, po.y); a.post = false; a.hold = false; }
        else if (!far && po.fort && a.at && !a.hold) a.hold = true;      // вернулся в укрепление — снова держит место
      });
    });
  };
  Defense.prototype.view = function(team) {
    var B = this.B, t = B.t, self = this, S = this.ev.spawns, hot = {};
    var nextIn = this.wave < this.W ? Math.max(0, Math.ceil(this.next - t)) : -1;
    if (this.plan && nextIn >= 0 && nextIn <= DEF.warn + 3) this.plan.from.forEach(function(i) { hot[i] = 1; });
    if (t - this.lastSpawn < 12 && this.wave) { var pw = this.wave; this.queue.forEach(function(q) { if (q.w === pw) S.forEach(function(s, i) { if (s === q.s) hot[i] = 2; }); }); }
    var foes = this.foes(), inz = 0; foes.forEach(function(a) { if (self.inZone(a)) inz++; });
    var reinf = DEF.reinf[this.ti].filter(function(w) { return !self.reinfDone[w]; })[0];
    return { k: 'defense', ev: this.cfg.event, tier: this.tier, role: 'defender', left: Math.max(0, Math.round(this.limit - t)), T: Math.round(t),
             wave: this.wave, waves: this.W, cleared: this.cleared, next: nextIn, boss: this.plan ? !!this.plan.boss : false,
             from: this.plan ? this.plan.from : null, hp: Math.round(this.hp * 10) / 10, press: Math.round(this.press * 10) / 10,
             core: [this.core.x, this.core.y, this.core.name], zone: this.zone,
             spawns: S.map(function(s, i) { return [s[0], s[1], s[2], hot[i] || 0]; }),
             foes: foes.length + this.queue.length, inZone: inz, mine: this.mine().length, reinf: reinf || 0,
             over: this.result ? this.result : null };
  };

  function create(B, cfg) {
    if (cfg.event === 'hunt_sith' || cfg.event === 'hunt_jedi') return new Hunt(B, cfg);
    if (KITD[cfg.event]) return new Defense(B, cfg);
    throw new Error('ивент ещё не готов: ' + cfg.event);
  }
  return { create: create, Hunt: Hunt, HUNT: HUNT, KIT: KIT, SQUAD: SQUAD, PREY_HP: PREY_HP, Defense: Defense, DEF: DEF, KITD: KITD, power: power, fmt: fmt };
});
