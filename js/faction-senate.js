// Сенат (Республика) и Совет сепаратистов (КНС): законы фракции.
//
// Сервер (sql/laws.sql) решает всё сам: law_state — каталог, голосования, действующие законы, история;
// law_propose / law_vote / law_decree — действия, возвращают свежий law_state; law_badge — сколько ждут моего голоса.
// Правила: до 2 законов разом (действующие + на голосовании); голосование 48 ч, 1 игрок = 1 голос,
// принят — «за» больше «против» и набран кворум; действует 7 дней; указ лидера — сразу на 24 ч, раз в неделю.
//
// Здесь: раздел в окне фракции (fsRenderSenate — его зовёт fsRender в faction-panel.js),
// шторка «Законы» (режим 'laws' общей шторки штаба из faction-staff.js) и значок на кнопке «Фракция».
// Загрузка — вместе со сводкой фракции (snFetch в fsLoad). ES5.

var SN_KIND = {
  extract:    { up: 'добыча',     unit: '%' },
  income:     { up: 'доход',      unit: '%' },
  mood:       { up: 'довольство', unit: '' },
  hire_time:  { time: 'найм' },
  build_time: { time: 'стройка' }
};

var snState = {
  data: null,
  busy: {},        // id закона или голосования → ждём сервер
  focus: false,    // открыть окно фракции сразу на разделе законов
  skew: 0
};

function snEsc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function snNow() { return Date.now() + snState.skew; }
function snMs(iso) { var t = new Date(iso).getTime(); return isNaN(t) ? 0 : t; }
function snPlural(n, a, b, c) { return typeof fsPlural === 'function' ? fsPlural(n, a, b, c) : c; }

function snLeft(iso) {
  var sec = Math.max(0, Math.floor((snMs(iso) - snNow()) / 1000));
  var d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d > 0) return d + ' д' + (h ? ' ' + h + ' ч' : '');
  if (h > 0) return h + ' ч' + (m ? ' ' + m + ' мин' : '');
  if (m > 0) return m + ' мин';
  return 'меньше минуты';
}

function snHouse() {
  var f = snState.data && snState.data.faction;
  return f === 'cis' ? 'Совет' : 'Сенат';
}

// Эффект закона: текст и хорош ли он
function snEffect(e) {
  var k = SN_KIND[e.kind] || { up: e.kind, unit: '' }, v = e.value | 0;
  if (k.time) return { good: v < 0, text: k.time + (v < 0 ? ' быстрее' : ' дольше') + ' на ' + Math.abs(v) + '%' };
  return { good: v > 0, text: k.up + ' ' + (v > 0 ? '+' : '−') + Math.abs(v) + k.unit };
}

// Денежные законы (sql/laws.sql, funds): налог в казну, заём сразу и возврат в конце срока
function snFunds(f) {
  if (!f) return '';
  var num = typeof fsNum === 'function' ? fsNum : function(n) { return String(n); }, h = '';
  if (f.tax) h += '<i class="up">в казну ' + (f.tax | 0) + '% дохода поселений</i>';
  if (f.now) h += '<i class="up">казне +' + num(f.now) + ' кр. сразу</i>';
  if (f.end) h += '<i class="down">возврат ' + num(Math.abs(f.end)) + ' кр. в конце срока</i>';
  return h;
}

function snEffects(list, funds) {
  return '<span class="sn-fx">' + (list || []).map(function(e) {
    var x = snEffect(e);
    return '<i class="' + (x.good ? 'up' : 'down') + '">' + snEsc(x.text) + '</i>';
  }).join('') + snFunds(funds) + '</span>';
}

// ── Загрузка ───────────────────────────────────────────────────────

function snFetch() {
  if (typeof supabase === 'undefined') return Promise.resolve(null);
  return Promise.resolve(supabase.rpc('law_state')).then(function(r) {
    if (r && !r.error && r.data) snSet(r.data);
    return snState.data;
  }, function() { return snState.data; });
}

function snSet(d) {
  snState.data = d;
  if (d && d.now) snState.skew = snMs(d.now) - Date.now();
  snPaintBadge(snMine());
}

// Сколько голосований ждут моего голоса
function snMine() {
  var n = 0, d = snState.data;
  ((d && d.bills) || []).forEach(function(b) { if (b.status === 'voting' && b.mine == null && snMs(b.vote_ends) > snNow()) n++; });
  return n;
}

// ── Раздел в окне фракции ──────────────────────────────────────────

function fsRenderSenate() {
  var d = snState.data;
  if (!d || !d.faction) return '';
  var bills = d.bills || [], wait = snMine();
  var meta = wait ? '<b class="hot">' + wait + ' ' + snPlural(wait, 'ждёт голоса', 'ждут голоса', 'ждут голоса') + '</b>'
                  : (d.used | 0) + ' из ' + (d.slots | 0) + ' · ' + (d.law_days | 0) + ' дней';
  var html = '<section class="fs-sec sn-sec" id="sn-sec">' + fsSecHead(snHouse(), meta);

  bills.forEach(function(b) { html += snBillCard(b); });

  if (!bills.length) {
    html += '<div class="fs-empty">Законов нет. ' + (d.can_propose
      ? 'Предложи закон — фракция проголосует за ' + (d.vote_hours | 0) + ' ч.'
      : 'Закон предлагает лидер, а голосует вся фракция.') + '</div>';
  }

  if (d.can_propose || d.is_leader) {
    var full = (d.used | 0) >= (d.slots | 0);
    html += '<button type="button" class="fs-more" data-act="sn-open">' +
      (full ? 'Законы · мест нет, ' + (d.used | 0) + ' из ' + (d.slots | 0) : '+ Предложить закон') + '</button>';
  } else if (bills.length || (d.history && d.history.length)) {
    html += '<button type="button" class="fs-more" data-act="sn-open">Все законы и история</button>';
  }

  if (snState.focus) {
    snState.focus = false;
    setTimeout(function() {
      var el = document.getElementById('sn-sec');
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }, 60);
  }
  return html + '</section>';
}

function snBillCard(b) {
  var voting = b.status === 'voting', d = snState.data || {};
  var yes = b.yes | 0, no = b.no | 0, need = d.quorum | 0, members = d.members | 0, busy = !!snState.busy[b.id];
  var tag = voting ? 'Голосование' : b.mode === 'decree' ? 'Указ лидера' : 'Действует';
  var left = voting ? 'итог через ' + snLeft(b.vote_ends) : 'ещё ' + snLeft(b.ends);
  var h = '<div class="sn-bill ' + (voting ? 'voting' : b.mode === 'decree' ? 'decree' : 'active') + '">' +
    '<div class="sn-top"><span class="sn-tag">' + tag + '</span><span class="sn-left" data-sn-end="' + snMs(voting ? b.vote_ends : b.ends) +
      '" data-sn-pre="' + (voting ? 'итог через ' : 'ещё ') + '">' + left + '</span></div>' +
    '<div class="sn-title">' + snEsc(b.title) + '</div>' +
    snEffects(b.effects, b.funds);
  if (voting) {
    var tot = Math.max(1, yes + no), py = Math.round(yes * 100 / tot);
    h += '<div class="sn-tally"><div class="sn-bar"><i class="y" style="width:' + (yes + no ? py : 0) + '%"></i><i class="n" style="width:' + (yes + no ? 100 - py : 0) + '%"></i></div>' +
      '<div class="sn-count"><span class="y">за ' + yes + '</span><span>' + (yes + no) + ' из ' + members + ' · нужно ' + need + '</span><span class="n">против ' + no + '</span></div></div>' +
      '<div class="sn-vote">' +
        '<button type="button" class="sn-btn y' + (b.mine === true ? ' on' : '') + '" data-act="sn-vote" data-id="' + snEsc(b.id) + '" data-v="1"' + (busy ? ' disabled' : '') + '>' + (b.mine === true ? '✓ За' : 'За') + '</button>' +
        '<button type="button" class="sn-btn n' + (b.mine === false ? ' on' : '') + '" data-act="sn-vote" data-id="' + snEsc(b.id) + '" data-v="0"' + (busy ? ' disabled' : '') + '>' + (b.mine === false ? '✓ Против' : 'Против') + '</button>' +
      '</div>' +
      '<div class="sn-by">' + (b.by ? 'предложил ' + snEsc(b.by) + ' · ' : '') + (b.mine == null ? 'твой голос ещё не отдан' : 'голос можно поменять до итога') + '</div>';
  } else {
    h += '<div class="sn-by">' + (b.mode === 'decree' ? 'указ ' + snEsc(b.by || 'лидера') : 'принят: за ' + (b.yes | 0) + ', против ' + (b.no | 0)) + '</div>';
  }
  return h + '</div>';
}

// Обратные отсчёты без перерисовки; срок вышел — переспросить сервер
function snTick() {
  var els = document.querySelectorAll('[data-sn-end]'), due = false;
  for (var i = 0; i < els.length; i++) {
    var end = parseInt(els[i].getAttribute('data-sn-end'), 10);
    if (end <= snNow()) { due = true; continue; }
    els[i].textContent = els[i].getAttribute('data-sn-pre') + snLeft(new Date(end).toISOString());
  }
  if (due && !snTick.wait) {
    snTick.wait = true;
    setTimeout(function() { snTick.wait = false; snReload(); }, 2000);
  }
}

function snReload() {
  return snFetch().then(snRepaint);
}

function snRepaint() {
  if (typeof fsState !== 'undefined' && fsState.open && fsState.data && typeof fsRender === 'function') fsRender(false);
  if (typeof hqState !== 'undefined' && hqState.mode === 'laws') snRenderSheet();
}

// ── Действия ───────────────────────────────────────────────────────

function snCall(name, args, key, okText) {
  if (snState.busy[key]) return;
  snState.busy[key] = true;
  snRepaint();
  Promise.resolve(supabase.rpc(name, args)).then(function(r) {
    delete snState.busy[key];
    if (r.error) {
      if (typeof hqToast === 'function') hqToast(gameErr(r.error), true);
      snRepaint();
      return;
    }
    snSet(r.data);
    snRepaint();
    if (okText && typeof hqToast === 'function') hqToast(okText);
  }, function() {
    delete snState.busy[key];
    if (typeof hqToast === 'function') hqToast('Нет связи с сервером', true);
    snRepaint();
  });
}

// Кнопки раздела в окне фракции (faction-panel.js передаёт сюда всё с data-act="sn-…")
function snOnBody(act, t) {
  if (act === 'sn-open') { if (typeof hqOpen === 'function') hqOpen('laws'); return; }
  if (act === 'sn-vote') {
    var id = t.getAttribute('data-id'), yes = t.getAttribute('data-v') === '1';
    var b = snBill(id);
    if (b && b.mine === yes) return;
    snCall('law_vote', { p_bill: id, p_yes: yes }, id, yes ? 'Голос «за» отдан' : 'Голос «против» отдан');
  }
}

function snBill(id) {
  var a = (snState.data && snState.data.bills) || [];
  for (var i = 0; i < a.length; i++) if (a[i].id === id) return a[i];
  return null;
}

// ── Шторка «Законы» ────────────────────────────────────────────────

function snRenderSheet() {
  var d = snState.data;
  if (typeof hqSetHead === 'function') {
    hqSetHead(snHouse() + ' · законы', d ? (d.used | 0) + ' из ' + (d.slots | 0) + ' мест · голосование ' + (d.vote_hours | 0) + ' ч · закон действует ' + (d.law_days | 0) + ' дн.' : '');
  }
  var body = document.getElementById('hq-body'), foot = document.getElementById('hq-foot');
  if (!body) return;
  if (foot) foot.innerHTML = '';
  if (!d || !d.faction) { body.innerHTML = '<div class="hq-empty">Законы появятся, когда у тебя будет фракция.</div>'; return; }

  var full = (d.used | 0) >= (d.slots | 0);
  var decreeLeft = d.decree_at && snMs(d.decree_at) > snNow();
  var h = '';
  if (!d.can_propose && !d.is_leader) h += '<div class="hq-note">Законы предлагает лидер и должности с полномочием «Законы». Голосует вся фракция — в окне фракции.</div>';
  else if (full) h += '<div class="hq-note">Сейчас ' + (d.used | 0) + ' из ' + (d.slots | 0) + ' — новый закон можно предложить, когда один из них закончится.</div>';

  (d.laws || []).forEach(function(l) {
    var state = l.busy === 'active' ? 'действует' : l.busy === 'voting' ? 'на голосовании' : '';
    var retry = !l.busy && l.retry_at && snMs(l.retry_at) > snNow();
    var free = !l.busy && !retry && !full;
    var busy = !!snState.busy[l.id];
    h += '<div class="sn-law' + (l.busy ? ' on' : '') + '">' +
      '<div class="sn-law-head"><b>' + snEsc(l.title) + '</b>' + (state ? '<em>' + state + '</em>' : retry ? '<em class="wait">снова через ' + snLeft(l.retry_at) + '</em>' : '') + '</div>' +
      '<div class="sn-law-text">' + snEsc(l.text) + '</div>' + snEffects(l.effects, l.funds);
    if (free && (d.can_propose || d.is_leader)) {
      h += '<div class="sn-law-acts">' +
        (d.can_propose ? '<button type="button" class="hq-small" data-hq="sn-propose" data-id="' + snEsc(l.id) + '"' + (busy ? ' disabled' : '') + '>На голосование</button>' : '') +
        (d.is_leader && !l.funds ? '<button type="button" class="hq-small sn-decree" data-hq="sn-decree" data-id="' + snEsc(l.id) + '"' + (busy || decreeLeft ? ' disabled' : '') + '>' +
          (decreeLeft ? 'Указ — через ' + snLeft(d.decree_at) : 'Указ на ' + (d.decree_hours | 0) + ' ч') + '</button>' : '') +
      '</div>';
    }
    h += '</div>';
  });

  var hist = d.history || [];
  if (hist.length) {
    h += '<div class="hq-block">История</div>';
    hist.forEach(function(x) {
      var failed = x.status === 'failed';
      h += '<div class="sn-hist' + (failed ? ' bad' : '') + '"><b>' + snEsc(x.title) + '</b><span>' +
        (failed ? 'отклонён · за ' + (x.yes | 0) + ', против ' + (x.no | 0) + ((x.yes | 0) + (x.no | 0) < (x.need | 0) ? ', не хватило голосов' : '')
                : (x.mode === 'decree' ? 'указ' : 'закон') + ' истёк') +
        (x.at && typeof fsAgo === 'function' ? ' · ' + snEsc(fsAgo(x.at)) : '') + '</span></div>';
    });
  }

  h += '<div class="sn-rules">Одновременно — не больше ' + (d.slots | 0) + ' законов. Голосование идёт ' + (d.vote_hours | 0) + ' ч: закон принят, если «за» больше, чем «против», и проголосовали хотя бы ' +
    (d.quorum | 0) + ' из ' + (d.members | 0) + ' активных. Проголосовали все — итог сразу. Отклонённый закон можно предложить снова через ' + (d.retry_hours | 0) + ' ч. ' +
    'Указ лидера вводит закон без голосования на ' + (d.decree_hours | 0) + ' ч, раз в неделю; денежные законы — только голосованием. Время найма и стройки в карточках показано без учёта законов.</div>';
  body.innerHTML = h;
}

// Кнопки шторки (faction-staff.js передаёт сюда всё с data-hq="sn-…")
function snOnSheet(act, id) {
  var l = null, laws = (snState.data && snState.data.laws) || [];
  for (var i = 0; i < laws.length; i++) if (laws[i].id === id) l = laws[i];
  if (!l) return;
  if (act === 'sn-propose') {
    snCall('law_propose', { p_law: id }, id, '«' + l.title + '» — на голосовании');
  } else if (act === 'sn-decree') {
    var go = function() { snCall('law_decree', { p_law: id }, id, 'Указ: «' + l.title + '» действует ' + ((snState.data && snState.data.decree_hours) | 0) + ' ч'); };
    if (typeof gameConfirm === 'function') {
      gameConfirm({ tone: 'build', kicker: 'Указ лидера', title: l.title, sub: 'Закон вступит в силу сразу, без голосования, на ' + ((snState.data && snState.data.decree_hours) | 0) + ' ч. Следующий указ — через неделю.', ok: 'Издать', cancel: 'Отмена' }, go);
    } else go();
  }
}

// ── Значок на кнопке «Фракция» ─────────────────────────────────────
// Его же ставит planet-request.js (заявки на планеты) — складываем части.

var snBadgeParts = { req: 0, vote: 0 };

function setFactionBadgePart(key, n) {
  snBadgeParts[key] = n | 0;
  var badge = document.getElementById('faction-badge');
  if (!badge) return;
  var total = snBadgeParts.req + snBadgeParts.vote;
  badge.textContent = total > 9 ? '9+' : String(total);
  badge.style.display = total > 0 ? 'block' : 'none';
}

function snPaintBadge(n) { setFactionBadgePart('vote', n); }

function snRefreshBadge() {
  if (document.hidden || typeof supabase === 'undefined' || !supabase.rpc) return;
  Promise.resolve(supabase.rpc('law_badge')).then(function(r) { if (r && !r.error) snPaintBadge(r.data | 0); }, function() {});
}

// Из ленты событий: окно фракции сразу на законах
function openSenate() {
  snState.focus = true;
  if (typeof openFactionScreen === 'function') openFactionScreen();
}

document.addEventListener('DOMContentLoaded', function() {
  if (!document.getElementById('faction-badge')) return;
  setTimeout(snRefreshBadge, 3500);
  setInterval(snRefreshBadge, 60000);
  setInterval(function() { if (typeof fsState !== 'undefined' && fsState.open) snTick(); else if (typeof hqState !== 'undefined' && hqState.mode === 'laws') snTick(); }, 1000);
  document.addEventListener('visibilitychange', function() { if (!document.hidden) snRefreshBadge(); });
});
