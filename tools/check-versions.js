#!/usr/bin/env node
// Сверка версий скриптов и стилей (?v=N) перед публикацией.
//
// Браузер кэширует файл по адресу: если файл поменялся, а ?v= остался прежним, у игрока
// старый код смешивается с новым (так ломалось: rt-vehicles.js без V.check). Проверка:
//   1) один и тот же файл везде с одной версией (страницы, загрузчики в JS, воркеры);
//   2) содержимое файла не менялось при той же версии — сверка с tools/versions.json
//      (там отпечаток содержимого каждого файла на его текущей версии);
//   3) нет подключений без ?v= вовсе (их браузер держит в кэше сколько угодно).
//
//   node tools/check-versions.js            — проверить (код выхода 1 при ошибке)
//   node tools/check-versions.js --update   — после поднятия версий записать отпечатки
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const root = path.join(__dirname, '..');
const MANIFEST = path.join(__dirname, 'versions.json');
const SKIP = /^(node_modules|server|tools|sql|\.git)(\/|$)/;

function walk(dir, out) {
  for (const n of fs.readdirSync(path.join(root, dir))) {
    const rel = dir ? dir + '/' + n : n;
    if (SKIP.test(rel)) continue;
    const st = fs.statSync(path.join(root, rel));
    if (st.isDirectory()) walk(rel, out); else if (/\.(html|js|css)$/.test(n)) out.push(rel);
  }
  return out;
}
const files = walk('', []);
const refs = {};                         // цель → [{ from, v }]
const re = /["'(]([A-Za-z0-9_./-]+\.(?:js|css))\?v=(\d+)["')]/g;
for (const f of files) {
  const txt = fs.readFileSync(path.join(root, f), 'utf8');
  let m;
  while ((m = re.exec(txt))) {
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[1]));
    if (!fs.existsSync(path.join(root, target))) { (refs['?' + target] = refs['?' + target] || []).push({ from: f, v: m[2] }); continue; }
    (refs[target] = refs[target] || []).push({ from: f, v: m[2] });
  }
}
// 3) подключение без ?v= вообще: такой файл браузер держит в кэше сколько угодно — правка до игрока не доходит.
//    Страницы: src/href на свой .js/.css; скрипты: loadScript(…), new Worker(…), importScripts(…).
const bare = /\b(?:src|href)\s*=\s*"([^"?#:]+\.(?:js|css))"|(?:loadScript|new Worker|importScripts)\(\s*['"]([^'"?#:]+\.(?:js|css))['"]/g;
for (const f of files) {
  const txt = fs.readFileSync(path.join(root, f), 'utf8');
  let m;
  while ((m = bare.exec(txt))) {
    const url = m[1] || m[2];
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), url));
    if (fs.existsSync(path.join(root, target))) (refs['!' + target] = refs['!' + target] || []).push({ from: f, v: '' });
  }
}
const sha = f => crypto.createHash('sha1').update(fs.readFileSync(path.join(root, f))).digest('hex').slice(0, 12);
let man = {}; try { man = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch (e) {}
const update = process.argv.includes('--update');
let bad = 0;
const err = s => { bad++; console.log('✗ ' + s); };
const next = {};
Object.keys(refs).sort().forEach(t => {
  const list = refs[t], vs = Array.from(new Set(list.map(r => r.v)));
  if (t[0] === '?') return err('нет файла ' + t.slice(1) + ' (ссылка из ' + list.map(r => r.from).join(', ') + ')');
  if (t[0] === '!') return err(t.slice(1) + ': подключён без ?v= в ' + Array.from(new Set(list.map(r => r.from))).join(', ') + ' — поставь ту же версию, что в остальных местах (или v=1)');
  if (vs.length > 1) err(t + ': разные версии — ' + vs.map(v => 'v=' + v + ' в ' + list.filter(r => r.v === v).map(r => r.from).join(', ')).join('; '));
  const v = String(Math.max.apply(null, vs.map(Number))), h = sha(t), was = man[t];
  next[t] = { v: v, sha: h };
  if (!update && was && was.v === v && was.sha !== h) err(t + ': файл изменился, а версия та же (v=' + v + ') — подними ?v= во всех местах: ' + list.map(r => r.from).join(', '));
  if (!update && !was) console.log('· ' + t + ' v=' + v + ' — нет в tools/versions.json (запусти с --update)');
});
if (update) {
  if (bad) { console.log('Сначала исправь ошибки выше.'); process.exit(1); }
  fs.writeFileSync(MANIFEST, JSON.stringify(next, null, 1) + '\n');
  console.log('✓ записано: ' + Object.keys(next).length + ' файлов');
} else console.log((bad ? '✗ ошибок: ' + bad : '✓ версии в порядке') + ' (файлов с ?v=: ' + Object.keys(refs).length + ')');
process.exit(bad ? 1 : 0);
