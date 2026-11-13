/* Tiempo real: ficha de lote y sala de subasta. El servidor decide reloj, precio y ganador. */
(function () {
  'use strict';
  if (typeof io !== 'function') return;
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var main = $('main'); var lotId = main.dataset.lotId ? Number(main.dataset.lotId) : null; var eventId = Number(main.dataset.eventId);
  var room = main.hasAttribute('data-room');
  var euro = function (c) { return c === null || c === undefined ? '—' : (c / 100).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: 'always' }) + '€'; };
  var LABEL = { prebidding: 'Pre-bidding open', live: 'Live now', awarded: 'Sold', pending_seller_approval: 'On approval', no_sale: 'No sale', cancelled: 'Cancelled', scheduled: 'Scheduled' };
  var lots = room ? JSON.parse(($('#room-lots') || { textContent: '[]' }).textContent) : [];
  var current = null; var lastVersion = {}; var liveSecs = 20;
  var socket = io({ transports: ['websocket', 'polling'] });
  var conn = $('[data-conn]');
  // Estado de conexión en el idioma del sitio (atributo lang del documento: es, en, fr-CA, ar, ru, pl).
  var CONN = {
    es: { Connected: 'Conectado', 'Reconnecting…': 'Reconectando…', 'Connection lost – retrying': 'Reconectando…' },
    fr: { Connected: 'Connecté', 'Reconnecting…': 'Reconnexion…', 'Connection lost – retrying': 'Reconnexion…' },
    ar: { Connected: 'متصل', 'Reconnecting…': 'جارٍ إعادة الاتصال…', 'Connection lost – retrying': 'جارٍ إعادة الاتصال…' },
    ru: { Connected: 'Подключено', 'Reconnecting…': 'Переподключение…', 'Connection lost – retrying': 'Переподключение…' },
    pl: { Connected: 'Połączono', 'Reconnecting…': 'Ponowne łączenie…', 'Connection lost – retrying': 'Ponowne łączenie…' },
  };
  function setConn(state, text) { if (!conn) return; conn.className = 'conn ' + state; var d = CONN[(document.documentElement.lang || 'en').slice(0, 2)]; conn.textContent = (d && d[text]) || text; }

  function syncClock(serverTime) { if (serverTime && window.apServerOffset) window.apServerOffset(new Date(serverTime).getTime() - Date.now()); }
  function renderHistory(items) {
    var ul = $('[data-history]'); if (!ul || !items) return;
    ul.innerHTML = items.length ? '' : '<li class="muted">No bids yet.</li>';
    items.forEach(function (b) { var li = document.createElement('li'); var a = document.createElement('span'); a.textContent = b.bidder + ' · ' + b.kind; var c = document.createElement('span'); c.textContent = euro(b.amount_cents); li.appendChild(a); li.appendChild(c); ul.appendChild(li); });
  }
  function flash(el) { if (!el) return; el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }

  function applyLot(l) {
    if (!l) return;
    if (lastVersion[l.id] !== undefined && l.version < lastVersion[l.id]) return; // ignorar eventos atrasados
    lastVersion[l.id] = l.version; syncClock(l.server_time);
    if (room) {
      var q = $('[data-queue-lot="' + l.id + '"] [data-queue-status]'); if (q) q.innerHTML = '<span class="badge badge-' + (l.status === 'live' ? 'green' : l.status === 'awarded' ? 'brown' : 'gray') + '">' + (LABEL[l.status] || l.status) + '</span>';
      if (l.status === 'live') setCurrent(l);
      else if (current && current.id === l.id) { current = l; paint(l); }
      return;
    }
    if (l.id !== lotId) return;
    paint(l);
    socket.emit('sync', { lotId: lotId }, function (s) { if (s && s.history) renderHistory(s.history); });
  }
  function paint(l) {
    var price = $('[data-price]'); if (price) { price.textContent = euro(l.current_bid_cents || l.starting_bid_cents); flash(price); }
    var pl = $('[data-price-label]'); if (pl) pl.textContent = document.documentElement.lang === 'es' ? (l.current_bid_cents ? 'Oferta actual' : 'Precio inicial') : (l.current_bid_cents ? 'Current bid' : 'Starting bid');
    var dl = $('[data-dial-label]'); if (dl) dl.textContent = l.current_bid_cents ? 'Current bid' : 'Starting bid';
    var bc = $('[data-bid-count]'); if (bc) bc.textContent = l.bid_count;
    var rs = $('[data-reserve]'); if (rs) rs.textContent = l.reserve_met ? 'met' : 'not yet met';
    var bin = $('[data-bin-box]'); if (bin && !l.buy_now_cents) bin.remove(); // vendido o superado: Buy It Now deja de estar disponible
    var st = $('[data-lot-status]'); if (st) st.innerHTML = '<span class="badge badge-gray">' + (LABEL[l.status] || l.status) + '</span>';
    var clock = $('[data-lot-clock]'); if (clock && l.ends_at) clock.dataset.countdown = l.ends_at;
    var min = $('[data-min-bid]'); if (min && l.min_next_cents) { min.min = l.min_next_cents / 100; if (Number(min.value) < l.min_next_cents / 100) min.value = l.min_next_cents / 100; }
    var ml = $('[data-min-label]'); if (ml && l.min_next_cents) ml.textContent = euro(l.min_next_cents);
    var qb = $('[data-quick-bid]'); if (qb) { qb.disabled = l.status !== 'live'; qb.dataset.amount = l.min_next_cents; qb.textContent = l.status === 'live' ? 'Bid ' + euro(l.min_next_cents) : (LABEL[l.status] || l.status); }
    if (l.status !== 'live' && l.status !== 'prebidding') { var f = $('#bid-form'); if (f) f.querySelectorAll('input,button').forEach(function (x) { x.disabled = true; }); }
  }
  function setCurrent(l) {
    var changed = !current || current.id !== l.id; current = l;
    if (changed) {
      var info = lots.find(function (x) { return x.id === l.id; }) || {};
      $('[data-cur-title]').textContent = info.title || ('Lot ' + l.lot_number); $('[data-cur-meta]').textContent = info.meta || '';
      if (info.image) $('[data-cur-img]').src = info.image;
      $('[data-lot-label]').textContent = 'Lot # ' + l.lot_number;
      $$('[data-queue-lot]').forEach(function (li) { li.classList.toggle('cur', Number(li.dataset.queueLot) === l.id); });
      var cur = $('[data-queue-lot="' + l.id + '"]'); if (cur) cur.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      $('[data-my-status]').textContent = '';
    }
    paint(l);
    socket.emit('sync', { lotId: l.id }, function (s) { if (s && s.history) renderHistory(s.history); });
  }
  // Reloj de la sala: anillo proporcional al tiempo restante (según hora del servidor)
  if (room) setInterval(function () {
    if (!current || current.status !== 'live' || !current.ends_at) return;
    var off = window.apServerOffset ? window.apServerOffset() : 0;
    var left = new Date(current.ends_at).getTime() - (Date.now() + off);
    liveSecs = Math.max(liveSecs, Math.ceil(left / 1000));
    $('[data-clock]').textContent = left > 0 ? Math.ceil(left / 1000) + 's left' : 'Closing…';
    $('[data-dial]').style.setProperty('--p', Math.max(0, Math.min(100, left / (liveSecs * 1000) * 100)) + '%');
  }, 200);

  function join() {
    socket.emit('join', { lotId: lotId, eventId: room ? eventId : null }, function (s) {
      if (!s || !s.ok) return;
      syncClock(s.server_time);
      if (s.lot) applyLot(s.lot);
      if (room && s.current) setCurrent(s.current);
      if (room && s.event && s.event.status === 'ended') endedMsg();
      if (s.history) renderHistory(s.history);
    });
  }
  function endedMsg() { $('[data-cur-title]').textContent = 'This auction has ended. Thank you for participating!'; var qb = $('[data-quick-bid]'); if (qb) { qb.disabled = true; qb.textContent = 'Auction ended'; } var es = $('[data-event-status]'); if (es) es.innerHTML = '<span class="badge badge-gray">Ended</span>'; }

  socket.on('connect', function () { setConn('ok', 'Connected'); join(); });
  socket.on('disconnect', function () { setConn('bad', 'Reconnecting…'); });
  socket.io.on('reconnect_attempt', function () { setConn('bad', 'Reconnecting…'); });
  socket.on('connect_error', function () { setConn('bad', 'Connection lost – retrying'); });
  socket.on('lot:update', applyLot);
  socket.on('lot:closed', function (e) {
    if (!window.apToast) return;
    var txt = e.status === 'awarded' ? 'SOLD! Lot #' + e.lot_number + ' for ' + euro(e.price) : e.status === 'pending_seller_approval' ? 'Lot #' + e.lot_number + ' – on approval (' + euro(e.price) + ')' : 'Lot #' + e.lot_number + ' – no sale';
    window.apToast(txt, e.status === 'awarded' ? 'ok' : '');
  });
  socket.on('event:update', function (e) { if (room && e.status === 'ended') endedMsg(); if (room && e.status === 'live') { var es = $('[data-event-status]'); if (es) es.innerHTML = '<span class="badge badge-green">Live now</span>'; } });
  socket.on('notification', function (n) { if (window.apToast) window.apToast(n.title + (n.body ? ' – ' + n.body : ''), ''); });

  function sendBid(amountCents) {
    var key = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()) + Math.random();
    var target = room ? (current && current.id) : lotId; if (!target) return;
    var status = $('[data-my-status]');
    socket.timeout(8000).emit('bid', { lotId: target, amountCents: amountCents, idempotencyKey: key }, function (err, r) {
      if (err) { window.apToast('No confirmation from server – retrying once…', 'err'); socket.emit('bid', { lotId: target, amountCents: amountCents, idempotencyKey: key }, function (r2) { if (r2 && r2.ok) window.apToast(r2.message, 'ok'); }); return; }
      if (!r.ok) { window.apToast(r.error, 'err'); if (status) status.textContent = r.error; return; }
      window.apToast(r.message, r.leading ? 'ok' : ''); if (status) status.textContent = (r.leading ? '✔ You are the high bidder' : '✖ Outbid') + ' · your max ' + euro(r.your_max);
      applyLot(r.lot);
    });
  }
  var qb = $('[data-quick-bid]'); if (qb) qb.addEventListener('click', function () { if (qb.dataset.amount) sendBid(Number(qb.dataset.amount)); });
  var cb = $('[data-custom-bid]'); if (cb) cb.addEventListener('submit', function (e) { e.preventDefault(); var v = Number(cb.querySelector('input').value); if (v > 0) sendBid(Math.round(v * 100)); });
  // En la ficha, una puja enviada por la API REST también actualiza la vista inmediatamente
  document.addEventListener('api:success', function (e) { if (e.detail && e.detail.lot) applyLot(e.detail.lot); var my = $('[data-my-status]'); if (my && e.detail && e.detail.your_max_cents) my.innerHTML = 'Your maximum bid: <strong>' + euro(e.detail.your_max_cents) + '</strong> · ' + (e.detail.leading ? 'You are the high bidder' : 'You have been outbid'); });
})();
