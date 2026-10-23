/* Донесения: короткая запись каталога.
 *
 *   rep(side, id, cat, title, text, [opt(...), ...], { chain, def, w })
 *   opt(label, cost, [out(...), ...])      cost: { cr, res: { durasteel: 30 } } или null
 *   out(weight, text, fx)
 *
 * fx — что даёт исход:
 *   mood:    [±очки довольства, часов]   — строка «События» в довольстве поселения
 *   extract: [±%, часов]                 — добыча на планете
 *   income:  [±%, часов]                 — доход поселения
 *   cr: ±кредиты; res: { ресурс: ±кол-во } — на склад планеты / со склада
 *   raid: n — у поселения появляется банда мародёров из n бойцов
 *   gift: 'inf' | 'veh' — на планете появляется свой боец / техника
 *   next: id — через сутки придёт продолжение (донесение с chain: true)
 *
 * {planet} в тексте — название планеты донесения.
 * def — номер варианта (с 0), который сработает, если не ответить за 12 часов
 * (по умолчанию — последний). w — вес выпадения (по умолчанию 1). ES5, только для node.
 */
'use strict';
var LIST = [];
function rep(side, id, cat, title, text, opts, extra) {
  extra = extra || {};
  LIST.push({ id: id, side: side, cat: cat, title: title, text: text, opts: opts, chain: !!extra.chain,
              def: extra.def != null ? extra.def : opts.length - 1, w: extra.w || 1 });
}
function opt(label, cost, outs) { return { label: label, cost: cost || null, outs: outs }; }
function out(p, text, fx) { return { p: p, text: text, fx: fx || {} }; }
module.exports = { LIST: LIST, rep: rep, opt: opt, out: out };
