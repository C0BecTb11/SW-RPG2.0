/* Донесения: проверка каталога и сборка sql/reports_catalog.sql.
 *   node tools/reports/build.js          — проверить и записать SQL
 *   node tools/reports/build.js --check  — только проверить
 * Источник — tools/reports/republic.js и cis.js (формат — dsl.js). */
'use strict';
var fs = require('fs'), path = require('path');
var D = require('./dsl');
require('./republic'); require('./cis');
var LIST = D.LIST;

var RES = ['ore', 'gas', 'food', 'crystals', 'durasteel', 'cells', 'electronics'];
var CATS = ['mine', 'spy', 'refugees', 'debris', 'senate', 'jedi', 'clone', 'smuggler', 'plague', 'festival', 'pirates', 'science', 'weather', 'bank',
            'politics', 'factory', 'trade', 'military', 'wildlife', 'droid', 'sith', 'food', 'hutt'];
var errs = [], BY = {};
function err(id, m) { errs.push(id + ': ' + m); }

LIST.forEach(function(r) { if (BY[r.id]) err(r.id, 'повтор id'); BY[r.id] = r; });
var referenced = {};
LIST.forEach(function(r) {
  if (['republic', 'cis'].indexOf(r.side) < 0) err(r.id, 'сторона');
  if (CATS.indexOf(r.cat) < 0) err(r.id, 'нет категории ' + r.cat);
  if (!r.title || r.title.length > 34) err(r.id, 'заголовок пуст или длиннее 34');
  if (!/\{planet\}/.test(r.text)) err(r.id, 'в тексте нет {planet}');
  if (r.text.length > 260) err(r.id, 'текст длиннее 260');
  if (r.opts.length < 2 || r.opts.length > 3) err(r.id, 'вариантов не 2–3');
  if (r.def < 0 || r.def >= r.opts.length) err(r.id, 'def вне вариантов');
  else if (r.opts[r.def].cost) err(r.id, 'вариант по умолчанию не может стоить ресурсов');
  r.opts.forEach(function(o, i) {
    var k = r.id + '#' + i;
    if (!o.label || o.label.length > 34) err(k, 'подпись пуста или длиннее 34');
    if (o.cost) {
      Object.keys(o.cost).forEach(function(c) { if (c !== 'cr' && c !== 'res') err(k, 'цена: ' + c); });
      if (o.cost.cr != null && !(o.cost.cr > 0)) err(k, 'цена cr');
      Object.keys(o.cost.res || {}).forEach(function(x) { if (RES.indexOf(x) < 0 || !(o.cost.res[x] > 0)) err(k, 'цена ресурс ' + x); });
    }
    if (!o.outs.length) err(k, 'нет исходов');
    o.outs.forEach(function(u, j) {
      var kk = k + '.' + j, fx = u.fx;
      if (!(u.p > 0)) err(kk, 'вес');
      if (!u.text || u.text.length > 140) err(kk, 'текст исхода пуст или длиннее 140');
      Object.keys(fx).forEach(function(f) {
        var v = fx[f];
        if (f === 'mood' || f === 'extract' || f === 'income') {
          if (!Array.isArray(v) || v.length !== 2) { err(kk, f + ' — [величина, часы]'); return; }
          var lim = f === 'mood' ? 20 : 30;
          if (!v[0] || Math.abs(v[0]) > lim) err(kk, f + ' вне ±' + lim);
          if (!(v[1] >= 6 && v[1] <= 96)) err(kk, f + ' часы 6–96');
        } else if (f === 'cr') { if (!v || Math.abs(v) > 1000) err(kk, 'cr'); }
        else if (f === 'res') { Object.keys(v).forEach(function(x) { if (RES.indexOf(x) < 0 || !v[x] || Math.abs(v[x]) > 120) err(kk, 'res ' + x); }); }
        else if (f === 'raid') { if (!(v >= 2 && v <= 5)) err(kk, 'raid 2–5'); }
        else if (f === 'gift') { if (v !== 'inf' && v !== 'veh') err(kk, 'gift'); }
        else if (f === 'next') { referenced[v] = 1; if (!BY[v]) err(kk, 'нет продолжения ' + v); else { if (!BY[v].chain) err(kk, v + ' не продолжение'); if (BY[v].side !== r.side) err(kk, v + ' другой стороны'); } }
        else err(kk, 'неизвестное ' + f);
      });
    });
  });
});
LIST.forEach(function(r) { if (r.chain && !referenced[r.id]) err(r.id, 'продолжение никто не вызывает'); });

// риск варианта: один исход — «надёжно»; плохие исходы — доля их веса
function bad(fx) {
  return (fx.mood && fx.mood[0] < 0) || (fx.extract && fx.extract[0] < 0) || (fx.income && fx.income[0] < 0) || fx.cr < 0 || !!fx.raid ||
         Object.keys(fx.res || {}).some(function(x) { return fx.res[x] < 0; });
}
LIST.forEach(function(r) {
  r.opts.forEach(function(o) {
    var tot = 0, neg = 0;
    o.outs.forEach(function(u) { tot += u.p; if (bad(u.fx)) neg += u.p; });
    o.risk = o.outs.length === 1 ? 'sure' : neg === 0 ? 'luck' : neg / tot <= 0.35 ? 'risky' : 'gamble';
    o.badPct = o.outs.length > 1 ? Math.round(neg / tot * 100) : 0;
  });
});

var by = { republic: 0, cis: 0 }, chains = { republic: 0, cis: 0 };
LIST.forEach(function(r) { if (r.chain) chains[r.side]++; else by[r.side]++; });
console.log('Республика: ' + by.republic + ' + продолжений ' + chains.republic + ' · КНС: ' + by.cis + ' + продолжений ' + chains.cis);
if (errs.length) { console.error(errs.join('\n')); process.exit(1); }
if (process.argv.indexOf('--check') >= 0) { console.log('✓ каталог в порядке'); process.exit(0); }

function q(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
var rows = LIST.map(function(r) {
  var data = { title: r.title, text: r.text, opts: r.opts.map(function(o) { return { label: o.label, cost: o.cost, risk: o.risk, bad: o.badPct, outs: o.outs }; }) };
  return '(' + [q(r.id), q(r.side), q(r.cat), r.chain, r.w, r.def, q(JSON.stringify(data)) + '::jsonb'].join(', ') + ')';
});
var sql = '-- Каталог донесений. Собрано tools/reports/build.js из tools/reports/*.js — руками не править.\n' +
  'insert into public.report_catalog (id, side, cat, chain, w, def, data) values\n' + rows.join(',\n') +
  '\non conflict (id) do update set side = excluded.side, cat = excluded.cat, chain = excluded.chain, w = excluded.w, def = excluded.def, data = excluded.data, active = true;\n' +
  '-- убранные из каталога больше не выпадают\n' +
  // донесения участков (cat = 'site', sql/mine_reports.sql) живут вне republic.js / cis.js — не выключать их
  'update public.report_catalog set active = false where cat <> \'site\' and id not in (' + LIST.map(function(r) { return q(r.id); }).join(', ') + ');\n';
fs.writeFileSync(path.join(__dirname, '..', '..', 'sql', 'reports_catalog.sql'), sql);
console.log('✓ sql/reports_catalog.sql — ' + LIST.length + ' донесений, ' + Math.round(sql.length / 1024) + ' КБ');
