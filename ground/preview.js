/* Просмотр карт планет для наземки 2.0.
 *
 * Показывает постоянные карты 20 планет (shared/planets/<id>.json) так, как они
 * будут выглядеть в бою: местность, укрытия, зоны развёртывания, участки построек,
 * полосу вторжения и место под город. Можно включить проходимость (что где можно
 * пройти и проехать), сетку и погоду. Касание клетки — что на ней.
 * Рисование кусками 16×16 клеток с уровнями чёткости; сначала — вся карта грубо.
 * ES5.
 */
(function() {
  'use strict';

  var P = window.SWPlanets, T = P.T, N = P.N;
  var cv = document.getElementById('gp-canvas'), ctx = cv.getContext('2d');
  var fx = document.getElementById('gp-fx'), fctx = fx.getContext('2d');
  var $ = function(id) { return document.getElementById(id); };
  var LODS = [2, 4, 8, 16, 32], CH = 16;
  var KEY = 'gp-planet';

  var G = {
    list: [], id: null, json: null, ter: null, base: null,
    cam: { x: N / 2, y: N / 2, s: 4 }, vw: 0, vh: 0, dpr: 1,
    layers: { zones: true, pass: false, grid: false, weather: true },
    sel: null, dirty: true, t0: Date.now()
  };

  // Что на клетке — по-русски
  var MAT = {
    scree: 'осыпь', meadow: 'луг', grove: 'роща', boulder: 'валун', tree: 'дерево', fence: 'изгородь', rock: 'скала',
    rubble: 'щебень', crater: 'воронка', trench: 'окоп', tankwreck: 'остов танка', ruin: 'развалины', wreck: 'остов шагохода', hedgehog: 'противотанковые ежи',
    moss: 'мох', balustrade: 'балюстрада', outcrop: 'скальный выступ', chasm: 'пропасть',
    shards: 'осколки', crystalbed: 'кристаллическая россыпь', crystal: 'гроздь кристаллов', crystalsmall: 'кристалл', crystalridge: 'кристаллическая гряда', crystalspire: 'кристаллический шпиль',
    gravel: 'гравий', chainfence: 'сетчатая ограда', rail: 'рельсы', weeds: 'бурьян', container: 'контейнер', crate: 'ящики', warehouse: 'склад',
    debris: 'обломки', planter: 'клумба', speeder: 'спидер на стоянке', barrier: 'бетонный барьер', planterbox: 'кадка', tower: 'небоскрёб',
    ore: 'рудная россыпь', conveyor: 'конвейер', oretruck: 'рудовоз', spoil: 'отвал',
    dunes: 'дюны', scrub: 'кустарник', rockfin: 'скальный гребень', mesa: 'столовая гора', hive: 'шпиль-улей',
    ash: 'пепел', hull: 'обломок корабля',
    grate: 'решётка', puddles: 'лужи', module: 'грузовой модуль', railing: 'ограждение', dome: 'купол',
    sand: 'песок', roots: 'корни', undergrowth: 'подлесок', fern: 'папоротник', log: 'поваленный ствол', stump: 'пень', wroshyr: 'врошир',
    flowers: 'клумбы', hedge: 'живая изгородь', fountain: 'фонтан', villa: 'вилла',
    snowdrift: 'снежный занос', frost: 'изморозь', icecrystal: 'ледяные кристаллы', icecrag: 'ледяная скала', icespire: 'ледяной шпиль', crevasse: 'разлом',
    cinder: 'шлак', obsidian: 'обсидиан', pipe: 'трубопровод', basaltspire: 'базальтовый столб', lava: 'лава',
    heath: 'вереск', stele: 'стела', pillar: 'каменный столб',
    mud: 'грязь', swamp: 'болото', column: 'колонна', ruinwall: 'стена руин',
    tallgrass: 'высокая трава', lilacwood: 'лиловая роща', statue: 'статуя', lilactree: 'лиловое дерево',
    dust: 'пыль', tunnel: 'проход в скале', glowflora: 'светящаяся флора', thorns: 'колючки', pod: 'светящийся кокон', shroom: 'гриб-дерево',
    sinkhole: 'провал'
  };
  var WEATHER_NAME = { fog: 'Туман: обзор −1', rain: 'Дождь: обзор −1', ash: 'Пепел: обзор −1', dark: 'Тьма: обзор −2' };
  // Цвета слоя проходимости и легенды
  var PASS = [
    [T.OPEN, 'Открыто', null], [T.ROAD, 'Дорога', null], [T.ROUGH, 'Трудная', 'rgba(230,190,70,0.32)'],
    [T.LIGHT, 'Заросли', 'rgba(120,200,90,0.38)'], [T.COVER, 'Укрытие', 'rgba(240,200,60,0.75)'], [T.BLOCK, 'Скалы', 'rgba(220,70,60,0.6)'],
    [T.WATER, 'Вода', 'rgba(70,150,240,0.5)'], [T.VOID, 'Пропасть', 'rgba(170,40,30,0.7)'], [T.RAMP, 'Склон', 'rgba(140,240,170,0.5)'],
    [T.BRIDGE, 'Мост', 'rgba(230,230,240,0.45)'], [T.FORD, 'Брод', 'rgba(120,200,240,0.4)'], [T.TRAP, 'Заграждение', 'rgba(255,120,40,0.7)']
  ];
  var PASSC = {}; PASS.forEach(function(p) { PASSC[p[0]] = p[2]; });

  // ---------------------------------------------------------------- загрузка
  function fetchJson(url) {
    return fetch(url, { cache: 'no-cache' }).then(function(r) { if (!r.ok) throw new Error(url + ': ' + r.status); return r.json(); });
  }
  function loading(on) { $('gp-load').classList.toggle('off', !on); }
  // Поселение для просмотра: уровень 0 — голая карта, 1..4 — город с типовыми кварталами
  var TOWN_DISTS = [{ slot: 1, id: 'market' }, { slot: 2, id: 'garrison' }, { slot: 3, id: 'hospital' }, { slot: 4, id: 'comms' }];
  G.lvl = 0;
  function withTown(j) { return G.lvl > 0 && window.SWTown ? SWTown.apply(j, { level: G.lvl, districts: TOWN_DISTS }).map : j; }
  function pick(id, force) {
    if (id === G.id && G.ter && !force) return;
    loading(true);
    fetchJson('../shared/planets/' + id + '.json').then(function(j0) {
      // дать индикатору показаться до тяжёлой работы
      setTimeout(function() {
        var j = withTown(j0);
        G.id = id; G.json = j; G.raw = j0; G.ter = GTerrain.create(j); G.sel = null;
        G.base = document.createElement('canvas');
        G.base.width = G.base.height = N * 4;
        G.ter.render(G.base.getContext('2d'), 0, 0, N, N, 4);
        try { localStorage.setItem(KEY, id); } catch (e) {}
        try { history.replaceState(null, '', '?p=' + id); } catch (e) {}
        header(); legend(); cellInfo(null);
        fit();
        loading(false);
      }, 30);
    }).catch(function(e) { loading(false); $('gp-cell').innerHTML = '<span class="no">Карта не загрузилась: ' + e.message + '</span>'; });
  }
  function header() {
    var j = G.json, w = P.WEATHER[G.id];
    $('gp-name').textContent = j.name || G.id;
    $('gp-about').textContent = j.about || '';
    $('gp-globe').style.backgroundImage = 'url(../assets/planets/' + G.id + '.png)';
    $('gp-weather').textContent = w ? WEATHER_NAME[w[0]] : '';
    var chips = $('gp-planets').children;
    for (var i = 0; i < chips.length; i++) {
      var on = chips[i].getAttribute('data-id') === G.id;
      chips[i].classList.toggle('on', on);
      if (on && chips[i].scrollIntoView) chips[i].scrollIntoView({ inline: 'center', block: 'nearest' });
    }
  }
  function legend() {
    var t = G.ter.map.t, cnt = {}, k;
    for (k = 0; k < t.length; k++) cnt[t[k]] = (cnt[t[k]] || 0) + 1;
    $('gp-legend').innerHTML = PASS.filter(function(p) { return cnt[p[0]]; }).map(function(p) {
      var pct = cnt[p[0]] / t.length * 100;
      return '<span><i style="background:' + (p[2] || 'rgba(140,150,160,0.35)') + '"></i>' + p[1] + '<em>' + (pct < 1 ? pct.toFixed(1) : Math.round(pct)) + '%</em></span>';
    }).join('');
  }

  // ---------------------------------------------------------------- камера
  function resize() {
    G.dpr = Math.min(window.devicePixelRatio || 1, 2);
    G.vw = window.innerWidth; G.vh = window.innerHeight;
    [cv, fx].forEach(function(c) {
      c.width = Math.round(G.vw * G.dpr); c.height = Math.round(G.vh * G.dpr);
      c.style.width = G.vw + 'px'; c.style.height = G.vh + 'px';
    });
    G.dirty = true;
  }
  function fit() {
    var top = $('gp-top').getBoundingClientRect(), bot = $('gp-bottom').getBoundingClientRect();
    var wide = G.vw >= 900;
    var x0 = wide ? top.right + 10 : 0, x1 = wide ? bot.left - 10 : G.vw;
    var y0 = wide ? 0 : top.bottom + 6, y1 = wide ? G.vh : bot.top - 6;
    var s = Math.max(1, Math.min((x1 - x0) / N, (y1 - y0) / N) * 0.98);
    G.cam.s = s;
    G.cam.x = N / 2 - ((x0 + x1) / 2 - G.vw / 2) / s;
    G.cam.y = N / 2 - ((y0 + y1) / 2 - G.vh / 2) / s;
    G.fitS = s;
    G.dirty = true;
  }
  function toScreen(x, y) { return [(x - G.cam.x) * G.cam.s + G.vw / 2, (y - G.cam.y) * G.cam.s + G.vh / 2]; }
  function toCell(px, py) { return [(px - G.vw / 2) / G.cam.s + G.cam.x, (py - G.vh / 2) / G.cam.s + G.cam.y]; }
  function zoomAt(px, py, k) {
    var c = toCell(px, py), s = Math.max(Math.min(G.fitS || 2, 2) * 0.8, Math.min(64, G.cam.s * k));
    G.cam.s = s;
    G.cam.x = c[0] - (px - G.vw / 2) / s; G.cam.y = c[1] - (py - G.vh / 2) / s;
    clamp(); G.dirty = true;
  }
  function clamp() {
    var m = 40 / G.cam.s;
    G.cam.x = Math.max(-m, Math.min(N + m, G.cam.x)); G.cam.y = Math.max(-m, Math.min(N + m, G.cam.y));
  }

  // ---------------------------------------------------------------- рисование
  var pending = null;
  function draw() {
    if (!G.ter) return;
    var c = ctx, s = G.cam.s, dpr = G.dpr;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = '#05060a'; c.fillRect(0, 0, G.vw, G.vh);
    var o = toScreen(0, 0);
    c.imageSmoothingEnabled = true; c.imageSmoothingQuality = 'high';
    c.save();
    c.shadowColor = 'rgba(0,0,0,0.6)'; c.shadowBlur = 24;
    c.drawImage(G.base, o[0], o[1], N * s, N * s);
    c.restore();
    // чёткие куски поверх
    var need = s * dpr, lod = LODS[LODS.length - 1];
    for (var i = 0; i < LODS.length; i++) if (LODS[i] >= need * 0.9) { lod = LODS[i]; break; }
    pending = null;
    if (lod > 4) {
      var a = toCell(0, 0), b = toCell(G.vw, G.vh);
      var cx0 = Math.max(0, Math.floor(a[0] / CH)), cy0 = Math.max(0, Math.floor(a[1] / CH));
      var cx1 = Math.min(N / CH - 1, Math.floor(b[0] / CH)), cy1 = Math.min(N / CH - 1, Math.floor(b[1] / CH));
      var mid = toCell(G.vw / 2, G.vh / 2), bestD = 1e9;
      for (var cy = cy0; cy <= cy1; cy++) for (var cx = cx0; cx <= cx1; cx++) {
        var ch = G.ter.cache[lod + ':' + cx + ':' + cy];
        // пока нет нужного — показать грубее, если есть
        if (!ch) for (var l = LODS.indexOf(lod) - 1; l >= 0 && !ch; l--) ch = LODS[l] > 4 ? G.ter.cache[LODS[l] + ':' + cx + ':' + cy] : null;
        if (!G.ter.cache[lod + ':' + cx + ':' + cy]) {
          var d = Math.hypot(cx * CH + CH / 2 - mid[0], cy * CH + CH / 2 - mid[1]);
          if (d < bestD) { bestD = d; pending = [cx, cy, lod]; }
        }
        if (ch) {
          var p = toScreen(cx * CH, cy * CH);
          c.drawImage(ch, p[0], p[1], CH * s + 0.5, CH * s + 0.5);
        }
      }
    }
    if (G.layers.pass) drawPass(c);
    if (G.layers.grid) drawGrid(c);
    if (G.layers.zones) drawZones(c);
    if (G.sel) {
      var q = toScreen(G.sel[0], G.sel[1]);
      c.strokeStyle = '#e8d9a8'; c.lineWidth = 2; c.strokeRect(q[0], q[1], s, s);
      c.strokeStyle = 'rgba(0,0,0,0.6)'; c.lineWidth = 1; c.strokeRect(q[0] - 2, q[1] - 2, s + 4, s + 4);
    }
  }
  function visCells() {
    var a = toCell(0, 0), b = toCell(G.vw, G.vh);
    return [Math.max(0, Math.floor(a[0])), Math.max(0, Math.floor(a[1])), Math.min(N, Math.ceil(b[0])), Math.min(N, Math.ceil(b[1]))];
  }
  function drawPass(c) {
    var v = visCells(), map = G.ter.map, s = G.cam.s;
    for (var y = v[1]; y < v[3]; y++) for (var x = v[0]; x < v[2]; x++) {
      var col = PASSC[map.t[y * N + x]];
      if (!col) continue;
      var p = toScreen(x, y);
      c.fillStyle = col; c.fillRect(p[0], p[1], s + 0.5, s + 0.5);
    }
    // уступы: переход между высотами без склона — непроходим
    c.strokeStyle = 'rgba(255,90,70,0.95)'; c.lineWidth = Math.max(1.5, s * 0.12);
    c.beginPath();
    for (y = v[1]; y < v[3]; y++) for (x = v[0]; x < v[2]; x++) {
      var k = y * N + x;
      if (x + 1 < N && map.e[k] !== map.e[k + 1] && !P.canStep(map, x, y, x + 1, y, 'foot') && !P.canStep(map, x + 1, y, x, y, 'foot') && P.canStand(map, x, y, 'foot') && P.canStand(map, x + 1, y, 'foot')) {
        var p1 = toScreen(x + 1, y); c.moveTo(p1[0], p1[1]); c.lineTo(p1[0], p1[1] + s);
      }
      if (y + 1 < N && map.e[k] !== map.e[k + N] && !P.canStep(map, x, y, x, y + 1, 'foot') && !P.canStep(map, x, y + 1, x, y, 'foot') && P.canStand(map, x, y, 'foot') && P.canStand(map, x, y + 1, 'foot')) {
        var p2 = toScreen(x, y + 1); c.moveTo(p2[0], p2[1]); c.lineTo(p2[0] + s, p2[1]);
      }
    }
    c.stroke();
  }
  function drawGrid(c) {
    var v = visCells(), s = G.cam.s;
    var step = s >= 10 ? 1 : s >= 4 ? 6 : 12;
    c.lineWidth = 1;
    for (var x = Math.ceil(v[0] / step) * step; x <= v[2]; x += step) {
      var p = toScreen(x, 0);
      c.strokeStyle = x % 12 === 0 ? 'rgba(232,217,168,0.32)' : 'rgba(255,255,255,0.1)';
      c.beginPath(); c.moveTo(Math.round(p[0]) + 0.5, toScreen(0, v[1])[1]); c.lineTo(Math.round(p[0]) + 0.5, toScreen(0, v[3])[1]); c.stroke();
    }
    for (var y = Math.ceil(v[1] / step) * step; y <= v[3]; y += step) {
      var q = toScreen(0, y);
      c.strokeStyle = y % 12 === 0 ? 'rgba(232,217,168,0.32)' : 'rgba(255,255,255,0.1)';
      c.beginPath(); c.moveTo(toScreen(v[0], 0)[0], Math.round(q[1]) + 0.5); c.lineTo(toScreen(v[2], 0)[0], Math.round(q[1]) + 0.5); c.stroke();
    }
  }
  function label(c, text, x, y, col, size) {
    c.font = 'bold ' + size + 'px "Courier New", monospace';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.lineWidth = 3; c.strokeStyle = 'rgba(5,6,10,0.85)'; c.strokeText(text, x, y);
    c.fillStyle = col; c.fillText(text, x, y);
  }
  function drawZones(c) {
    var z = G.json.zones || { deploy: [], slots: [] }, s = G.cam.s, tw = G.json.town || P.GEO.town;
    var fs = Math.max(9, Math.min(13, s * 1.1));
    // полоса вторжения
    var a = toScreen(0, N - P.GEO.strip);
    c.fillStyle = 'rgba(217,74,74,0.14)'; c.fillRect(a[0], a[1], N * s, P.GEO.strip * s);
    c.setLineDash([6, 5]); c.strokeStyle = 'rgba(217,74,74,0.75)'; c.lineWidth = 1.5;
    c.beginPath(); c.moveTo(a[0], a[1]); c.lineTo(a[0] + N * s, a[1]); c.stroke();
    c.setLineDash([]);
    if (s * P.GEO.strip > 12) label(c, 'ПОЛОСА ВТОРЖЕНИЯ', a[0] + N * s / 2, a[1] + P.GEO.strip * s / 2, '#e88a8a', fs);
    // участки построек
    z.slots.forEach(function(sl, i) {
      var p = toScreen(sl[0], sl[1]), w = P.GEO.plot * s;
      c.fillStyle = 'rgba(143,168,196,0.10)'; c.fillRect(p[0], p[1], w, w);
      c.strokeStyle = i < 7 ? 'rgba(170,196,224,0.75)' : 'rgba(143,168,196,0.4)'; c.lineWidth = 1;
      c.strokeRect(Math.round(p[0]) + 0.5, Math.round(p[1]) + 0.5, Math.round(w) - 1, Math.round(w) - 1);
      if (w > 18) label(c, String(i + 1), p[0] + w / 2, p[1] + w / 2, i < 7 ? '#aac4e0' : '#6f8296', Math.min(fs, w * 0.4));
    });
    // зоны развёртывания
    z.deploy.forEach(function(d, i) {
      var p = toScreen(d[0], d[1]), w = d[2] * s;
      c.fillStyle = 'rgba(217,169,64,0.16)'; c.fillRect(p[0], p[1], w, w);
      c.strokeStyle = 'rgba(217,169,64,0.9)'; c.lineWidth = 1.5; c.setLineDash([5, 4]);
      c.strokeRect(p[0], p[1], w, w); c.setLineDash([]);
      if (w > 22) label(c, 'ЗОНА ' + (i + 1), p[0] + w / 2, p[1] + w / 2, '#e8d9a8', Math.min(fs, w * 0.22));
    });
    // город
    var t = toScreen(tw[0], tw[1]);
    c.strokeStyle = 'rgba(217,169,64,0.85)'; c.lineWidth = 1.5; c.setLineDash([10, 6]);
    c.strokeRect(t[0], t[1], tw[2] * s, tw[3] * s); c.setLineDash([]);
    c.fillStyle = 'rgba(217,169,64,0.05)'; c.fillRect(t[0], t[1], tw[2] * s, tw[3] * s);
    var cx = t[0] + tw[2] * s / 2, cy = t[1] + tw[3] * s / 2;
    if (tw[2] * s > 60) {
      label(c, 'ГОРОД', cx, cy - fs * 0.7, '#e8d9a8', fs + 2);
      label(c, 'строится на этапе 3', cx, cy + fs * 0.7, '#a99a72', Math.max(9, fs - 2));
    }
    // площадь в центре — точка захвата
    var sq = toScreen(tw[0] + tw[2] / 2 - 4, tw[1] + tw[3] / 2 - 4);
    c.strokeStyle = 'rgba(232,217,168,0.45)'; c.lineWidth = 1; c.strokeRect(sq[0], sq[1], 8 * s, 8 * s);
  }

  // ---------------------------------------------------------------- погода (поверх, с движением)
  var drops = [];
  function weatherFx() {
    var c = fctx, w = P.WEATHER[G.id], dpr = G.dpr;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, G.vw, G.vh);
    if (!w || !G.layers.weather || !G.ter) return false;
    var t = (Date.now() - G.t0) / 1000, o = toScreen(0, 0), S = N * G.cam.s;
    c.save(); c.beginPath(); c.rect(o[0], o[1], S, S); c.clip();
    if (w[0] === 'dark') {
      var g = c.createRadialGradient(G.vw / 2, G.vh / 2, Math.min(G.vw, G.vh) * 0.15, G.vw / 2, G.vh / 2, Math.max(G.vw, G.vh) * 0.75);
      g.addColorStop(0, 'rgba(10,4,20,0.18)'); g.addColorStop(1, 'rgba(6,2,14,0.62)');
      c.fillStyle = g; c.fillRect(o[0], o[1], S, S);
    } else if (w[0] === 'fog' || w[0] === 'ash') {
      var col = w[0] === 'fog' ? '220,236,232' : '120,110,100';
      for (var i = 0; i < 9; i++) {
        var px = o[0] + ((i * 0.37 + t * 0.012 * (1 + i % 3)) % 1.2 - 0.1) * S, py = o[1] + ((i * 0.61) % 1) * S, r = S * (0.18 + (i % 4) * 0.05);
        var gg = c.createRadialGradient(px, py, 0, px, py, r);
        gg.addColorStop(0, 'rgba(' + col + ',' + (w[0] === 'fog' ? 0.22 : 0.18) + ')'); gg.addColorStop(1, 'rgba(' + col + ',0)');
        c.fillStyle = gg; c.fillRect(px - r, py - r, r * 2, r * 2);
      }
      if (w[0] === 'ash') {
        c.fillStyle = 'rgba(190,180,170,0.55)';
        for (var j = 0; j < 140; j++) {
          var ax = ((j * 97.3 + t * (6 + j % 5) * 3) % G.vw), ay = ((j * 53.1 + t * (10 + j % 7) * 3) % G.vh);
          c.fillRect(ax, ay, 1.6, 1.6);
        }
      }
    } else if (w[0] === 'rain') {
      c.fillStyle = 'rgba(20,30,40,0.12)'; c.fillRect(o[0], o[1], S, S);
      if (drops.length < 220) for (var k = drops.length; k < 220; k++) drops.push([Math.random(), Math.random(), 0.7 + Math.random() * 0.6]);
      c.strokeStyle = 'rgba(190,215,235,0.35)'; c.lineWidth = 1;
      c.beginPath();
      drops.forEach(function(d) {
        var x = ((d[0] + t * 0.05 * d[2]) % 1) * G.vw, y = ((d[1] + t * 0.9 * d[2]) % 1) * G.vh;
        c.moveTo(x, y); c.lineTo(x - 4, y + 14);
      });
      c.stroke();
    }
    c.restore();
    return true;
  }

  // ---------------------------------------------------------------- клетка
  function zoneOf(x, y) {
    var z = G.json.zones || { deploy: [], slots: [] }, tw = G.json.town || P.GEO.town, out = [];
    z.deploy.forEach(function(d, i) { if (x >= d[0] && x < d[0] + d[2] && y >= d[1] && y < d[1] + d[2]) out.push('зона развёртывания ' + (i + 1)); });
    z.slots.forEach(function(s, i) { if (x >= s[0] && x < s[0] + 6 && y >= s[1] && y < s[1] + 6) out.push('участок ' + (i + 1)); });
    if (y >= N - P.GEO.strip) out.push('полоса вторжения');
    if (x >= tw[0] && x < tw[0] + tw[2] && y >= tw[1] && y < tw[1] + tw[3]) out.push('город');
    return out;
  }
  function cellInfo(c) {
    G.sel = c;
    if (!c) { $('gp-cell').innerHTML = '<span class="gp-dim">Коснитесь клетки — покажу, что на ней.</span>'; return; }
    var map = G.ter.map, k = c[1] * N + c[0], code = map.t[k], m = map.m[k];
    var mat = G.ter.matName(code, m), nm = P.NAME[code] + (mat && MAT[mat] && code !== T.OPEN && code !== T.ROAD ? ' · ' + MAT[mat] : '');
    var I = P.INFO[code];
    var sp = function(v) { return v ? (v === 1 ? '<span class="ok">да</span>' : '<span class="ok">×' + v + '</span>') : '<span class="no">нет</span>'; };
    var zn = zoneOf(c[0], c[1]);
    $('gp-cell').innerHTML =
      '<b>' + nm + '</b> <span class="k">· клетка ' + c[0] + ',' + c[1] + ' · высота ' + map.e[k] + '</span>' + (zn.length ? ' <span class="k">· ' + zn.join(', ') + '</span>' : '') + '<br>' +
      '<span class="k">пешком</span> ' + sp(I[0]) + ' <span class="k">· техника</span> ' + sp(I[1]) + ' <span class="k">· репульсоры</span> ' + sp(I[2]) +
      (I[4] < 1 ? ' <span class="k">· укрытие</span> <b>' + Math.round((1 - I[4]) * 100) + '%</b>' : '') + (I[5] ? ' <span class="k">· закрывает обзор</span>' : '');
  }

  // ---------------------------------------------------------------- ввод
  var ptrs = {}, drag = null, pinch = null;
  cv.addEventListener('pointerdown', function(e) {
    cv.setPointerCapture(e.pointerId);
    ptrs[e.pointerId] = [e.clientX, e.clientY];
    var ids = Object.keys(ptrs);
    if (ids.length === 1) drag = { x: e.clientX, y: e.clientY, cx: G.cam.x, cy: G.cam.y, moved: false };
    else if (ids.length === 2) {
      var a = ptrs[ids[0]], b = ptrs[ids[1]];
      pinch = { d: Math.hypot(a[0] - b[0], a[1] - b[1]), s: G.cam.s, mx: (a[0] + b[0]) / 2, my: (a[1] + b[1]) / 2 };
      drag = null;
    }
  });
  cv.addEventListener('pointermove', function(e) {
    if (!ptrs[e.pointerId]) return;
    ptrs[e.pointerId] = [e.clientX, e.clientY];
    var ids = Object.keys(ptrs);
    if (pinch && ids.length === 2) {
      var a = ptrs[ids[0]], b = ptrs[ids[1]], d = Math.hypot(a[0] - b[0], a[1] - b[1]);
      zoomAt(pinch.mx, pinch.my, pinch.s * d / pinch.d / G.cam.s);
      return;
    }
    if (drag) {
      var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 5) { drag.moved = true; cv.classList.add('drag'); }
      if (drag.moved) { G.cam.x = drag.cx - dx / G.cam.s; G.cam.y = drag.cy - dy / G.cam.s; clamp(); G.dirty = true; }
    }
  });
  function up(e) {
    if (drag && !drag.moved && ptrs[e.pointerId] && Object.keys(ptrs).length === 1) {
      var c = toCell(e.clientX, e.clientY), x = Math.floor(c[0]), y = Math.floor(c[1]);
      cellInfo(x >= 0 && y >= 0 && x < N && y < N ? [x, y] : null);
      G.dirty = true;
    }
    delete ptrs[e.pointerId];
    if (Object.keys(ptrs).length < 2) pinch = null;
    if (!Object.keys(ptrs).length) { drag = null; cv.classList.remove('drag'); }
  }
  cv.addEventListener('pointerup', up);
  cv.addEventListener('pointercancel', up);
  cv.addEventListener('wheel', function(e) { e.preventDefault(); zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.0015)); }, { passive: false });
  cv.addEventListener('dblclick', function(e) { zoomAt(e.clientX, e.clientY, 2); });
  $('gp-zin').onclick = function() { zoomAt(G.vw / 2, G.vh / 2, 1.6); };
  $('gp-zout').onclick = function() { zoomAt(G.vw / 2, G.vh / 2, 1 / 1.6); };
  $('gp-fit').onclick = fit;
  $('gp-more').onclick = function() {
    var p = $('gp-about'); p.hidden = !p.hidden; this.classList.toggle('on', !p.hidden);
  };
  $('gp-layers').addEventListener('click', function(e) {
    var b = e.target.closest('[data-layer]'); if (!b) return;
    var k = b.getAttribute('data-layer'); G.layers[k] = !G.layers[k];
    b.classList.toggle('on', G.layers[k]); G.dirty = true;
  });
  $('gp-planets').addEventListener('click', function(e) {
    var b = e.target.closest('[data-id]'); if (b) pick(b.getAttribute('data-id'));
  });
  $('gp-town').addEventListener('click', function(e) {
    var b = e.target.closest('[data-lvl]'); if (!b) return;
    G.lvl = +b.getAttribute('data-lvl');
    Array.prototype.forEach.call($('gp-town').children, function(x) { x.classList.toggle('on', +x.getAttribute('data-lvl') === G.lvl); });
    if (G.id) pick(G.id, true);
  });
  window.addEventListener('resize', function() { resize(); fit(); });

  // ---------------------------------------------------------------- цикл
  function frame() {
    if (G.dirty) { G.dirty = false; draw(); }
    else if (pending) {
      // дорисовать один кусок за кадр — интерфейс не замирает
      G.ter.chunk(pending[0], pending[1], pending[2], CH);
      pending = null; draw();
    }
    weatherFx();
    requestAnimationFrame(frame);
  }

  resize();
  fetchJson('../shared/planets/index.json').then(function(list) {
    G.list = list;
    $('gp-planets').innerHTML = list.map(function(p) {
      return '<button class="gp-chip" type="button" data-id="' + p.id + '"><i style="background-image:url(../assets/planets/' + p.id + '.png)"></i>' + p.name + '</button>';
    }).join('');
    var q = /[?&]p=([a-z]+)/.exec(location.search), saved = null;
    try { saved = localStorage.getItem(KEY); } catch (e) {}
    var want = (q && q[1]) || saved;
    pick(list.some(function(p) { return p.id === want; }) ? want : list[0].id);
    requestAnimationFrame(frame);
  }).catch(function(e) { loading(false); $('gp-cell').innerHTML = '<span class="no">Список планет не загрузился: ' + e.message + '</span>'; });

  window.GP = G;     // для проверки снимками
})();
