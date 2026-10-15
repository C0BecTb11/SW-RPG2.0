/* Звук космического боя (Web Audio).
 *
 * Звуки — assets/sfx/*.mp3, собраны tools/sfx/build.py из записанных CC0-исходников
 * (Kenney «Sci-Fi Sounds», Warfork). Здесь только проигрывание:
 *   - звук включается первым касанием (так требуют браузеры телефонов);
 *   - громкость и панорама — от места события на экране и масштаба камеры;
 *   - один и тот же звук не чаще раза в GAP с, всего не больше MAXV голосов —
 *     сотня выстрелов ПВО не превращается в кашу;
 *   - вид «Внутри»: всё глухо, через корпус (фильтр низких), громче — своё.
 */
(function(root) {
  'use strict';

  var BASE = '../assets/sfx/';
  // громкость типа (0..1) и минимальный промежуток между одинаковыми звуками, с
  var VOL = { heavy: 0.8, medium: 0.5, long: 0.85, ion: 0.55, pd: 0.2, fighter: 0.14, shield: 0.32, hull: 0.6,
              ionhit: 0.42, craftboom: 0.38, shipboom: 1 };
  var GAP = { heavy: 0.07, medium: 0.06, long: 0.09, ion: 0.09, pd: 0.1, fighter: 0.08, shield: 0.07, hull: 0.08,
              ionhit: 0.12, craftboom: 0.12, shipboom: 0.25 };
  var MAXV = 20;

  // Временно выключено по умолчанию: звуки забракованы, ждут замены. Включить — кнопкой у часов.
  var A = { ctx: null, master: null, muff: null, buf: {}, list: null, last: {}, voices: 0, on: false, inside: false, ready: false };
  try { A.on = localStorage.getItem('sp-sound2') === 'on'; } catch (e) {}

  function unlock() {
    if (A.ctx) { if (A.ctx.state === 'suspended') A.ctx.resume(); return; }
    var AC = root.AudioContext || root.webkitAudioContext; if (!AC) return;
    A.ctx = new AC();
    A.muff = A.ctx.createBiquadFilter(); A.muff.type = 'lowpass'; A.muff.frequency.value = 20000; A.muff.Q.value = 0.5;
    A.master = A.ctx.createGain(); A.master.gain.value = A.on ? 0.9 : 0;
    // мягкий ограничитель: много взрывов разом не хрипят
    var comp = A.ctx.createDynamicsCompressor();
    comp.threshold.value = -14; comp.knee.value = 10; comp.ratio.value = 6; comp.attack.value = 0.003; comp.release.value = 0.25;
    A.muff.connect(A.master); A.master.connect(comp); comp.connect(A.ctx.destination);
    load();
  }
  function load() {
    fetch(BASE + 'index.json?v=1').then(function(r) { return r.json(); }).then(function(idx) {
      A.list = idx;
      Object.keys(idx).forEach(function(k) {
        idx[k].forEach(function(name) {
          fetch(BASE + name + '.mp3?v=1').then(function(r) { return r.arrayBuffer(); }).then(function(ab) {
            // старый Safari знает только вариант с колбэками
            return new Promise(function(res, rej) { var p = A.ctx.decodeAudioData(ab, res, rej); if (p && p.then) p.then(res, rej); });
          }).then(function(b) { A.buf[name] = b; A.ready = true; }, function() {});
        });
      });
    }, function() {});
  }
  ['pointerdown', 'touchend', 'keydown'].forEach(function(ev) {
    root.addEventListener(ev, unlock, { passive: true, capture: true });
  });

  // kind — тип звука; vol — 0..1 от места на экране; pan — −1..1
  function play(kind, vol, pan) {
    if (!A.ctx || !A.on || !A.list || A.ctx.state !== 'running') return;
    if (vol < 0.03) return;
    var t = A.ctx.currentTime;
    if (A.last[kind] && t - A.last[kind] < GAP[kind]) return;
    if (A.voices >= MAXV && kind !== 'shipboom') return;
    var names = A.list[kind]; if (!names) return;
    var b = A.buf[names[(Math.random() * names.length) | 0]]; if (!b) return;
    A.last[kind] = t;
    var src = A.ctx.createBufferSource(); src.buffer = b;
    src.playbackRate.value = 0.94 + Math.random() * 0.12;     // каждый выстрел чуть другой
    var g = A.ctx.createGain(); g.gain.value = VOL[kind] * vol;
    var out = g;
    if (A.ctx.createStereoPanner) {
      var p = A.ctx.createStereoPanner(); p.pan.value = Math.max(-1, Math.min(1, pan || 0)); g.connect(p); out = p;
    }
    src.connect(g); out.connect(A.muff);
    A.voices++;
    src.onended = function() { A.voices--; try { out.disconnect(); } catch (e) {} };
    src.start(t);
  }

  function setOn(on) {
    A.on = !!on;
    try { localStorage.setItem('sp-sound2', A.on ? 'on' : 'off'); } catch (e) {}
    if (A.master) A.master.gain.setTargetAtTime(A.on ? 0.9 : 0, A.ctx.currentTime, 0.05);
    if (A.on) unlock();
  }
  // Вид изнутри: бой слышен через корпус
  function setInside(v) {
    if (A.inside === !!v) return;
    A.inside = !!v;
    if (A.muff) A.muff.frequency.setTargetAtTime(A.inside ? 650 : 20000, A.ctx.currentTime, 0.12);
  }

  root.SPSfx = { play: play, setOn: setOn, isOn: function() { return A.on; }, setInside: setInside, unlock: unlock, _A: A };
})(typeof self !== 'undefined' ? self : this);
