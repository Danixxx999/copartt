/* copart – JS del cliente. Sin frameworks. Todas las acciones llaman a la API real (/api/v1). */
(function () {
  'use strict';
  var csrf = (document.querySelector('meta[name="csrf-token"]') || {}).content || '';
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  function toast(msg, kind) {
    var region = $('#toast-region') || (function () { var d = document.createElement('div'); d.id = 'toast-region'; d.className = 'toasts'; d.setAttribute('role', 'status'); d.setAttribute('aria-live', 'polite'); document.body.appendChild(d); return d; })();
    var t = document.createElement('div'); t.className = 'toast ' + (kind || ''); t.textContent = msg; region.appendChild(t);
    setTimeout(function () { t.remove(); }, kind === 'err' ? 7000 : 4500);
  }
  window.apToast = toast;

  async function api(url, opts) {
    opts = opts || {};
    var headers = { 'X-CSRF-Token': csrf, 'X-Requested-With': 'fetch', Accept: 'application/json' };
    var body = opts.body;
    if (body && !(body instanceof FormData)) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
    var res;
    try { res = await fetch(url, { method: opts.method || 'GET', headers: headers, body: body, credentials: 'same-origin' }); }
    catch (e) { throw Object.assign(new Error('Network error: check your connection and try again.'), { network: true }); }
    var data = {}; try { data = await res.json(); } catch (e) { /* respuesta sin JSON */ }
    if (!res.ok) { var err = new Error(data.error || ('Error ' + res.status)); err.status = res.status; err.fields = data.fields; err.code = data.code; throw err; }
    return data;
  }
  window.apApi = api;

  function clearErrors(form) { $$('.field-error', form).forEach(function (e) { e.remove(); }); $$('[aria-invalid]', form).forEach(function (e) { e.removeAttribute('aria-invalid'); }); }
  function showErrors(form, fields) {
    if (!form || !fields) return;
    Object.keys(fields).forEach(function (k) {
      var el = form.querySelector('[name="' + k + '"]'); if (!el) return;
      el.setAttribute('aria-invalid', 'true');
      var m = document.createElement('div'); m.className = 'field-error'; m.id = 'err-' + k; m.textContent = fields[k];
      el.setAttribute('aria-describedby', m.id);
      (el.closest('.form-row, .f-row, label, .check') || el.parentNode).appendChild(m);
    });
    var first = form.querySelector('[aria-invalid="true"]'); if (first) first.focus();
  }
  function after(data, form) {
    if (data.message) toast(data.message, 'ok');
    if (data.redirect) { setTimeout(function () { location.href = data.redirect; }, 450); return; }
    if (data.reload) { setTimeout(function () { location.reload(); }, 600); return; }
    if (form && form.dataset.reset !== undefined) form.reset();
  }
  function handleError(err, form) {
    if (err.status === 401) { toast(err.message, 'err'); setTimeout(function () { location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search); }, 900); return; }
    toast(err.message, 'err'); showErrors(form, err.fields);
  }

  // Formularios con data-api → JSON o multipart (si tienen archivos)
  document.addEventListener('submit', async function (e) {
    var form = e.target;
    if (!form.matches('form[data-api]')) return;
    e.preventDefault();
    if (form.dataset.confirm && !confirm(form.dataset.confirm)) return;
    clearErrors(form);
    var btn = form.querySelector('[type=submit]'); var label = btn && btn.innerHTML;
    if (btn) { btn.disabled = true; btn.innerHTML = 'Please wait…'; }
    try {
      var hasFile = !!form.querySelector('input[type=file]');
      var body;
      if (hasFile) body = new FormData(form);
      else {
        body = {};
        new FormData(form).forEach(function (v, k) { if (k === '_csrf') return; if (body[k] !== undefined) { body[k] = [].concat(body[k], v); } else body[k] = v; });
        $$('input[type=checkbox][name]', form).forEach(function (c) { if (!c.dataset.multi) body[c.name] = c.checked; });
        if (form.dataset.idempotent !== undefined) body.idempotency_key = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
      }
      var data = await api(form.dataset.api, { method: form.dataset.method || 'POST', body: body });
      form.dispatchEvent(new CustomEvent('api:success', { detail: data }));
      after(data, form);
    } catch (err) { handleError(err, form); }
    finally { if (btn) { btn.disabled = false; btn.innerHTML = label; } }
  });

  // Botones con data-api (+ data-body JSON, data-confirm, data-prompt para motivo)
  document.addEventListener('click', async function (e) {
    var b = e.target.closest('button[data-api], a[data-api]'); if (!b) return;
    e.preventDefault();
    if (b.dataset.confirm && !confirm(b.dataset.confirm)) return;
    var body = {}; try { body = b.dataset.body ? JSON.parse(b.dataset.body) : {}; } catch (x) { body = {}; }
    if (b.dataset.prompt) { var v = prompt(b.dataset.prompt); if (v === null) return; body[b.dataset.promptField || 'reason'] = v; }
    b.disabled = true;
    try { after(await api(b.dataset.api, { method: b.dataset.method || 'POST', body: body })); }
    catch (err) { handleError(err); }
    finally { b.disabled = false; }
  });

  // Favoritos
  document.addEventListener('click', async function (e) {
    var b = e.target.closest('[data-watch]'); if (!b) return;
    e.preventDefault();
    try {
      var d = await api('/api/v1/watchlist/' + b.dataset.watch, { method: 'POST' });
      $$('[data-watch="' + b.dataset.watch + '"]').forEach(function (x) { x.classList.toggle('on', d.watching); x.setAttribute('aria-pressed', String(d.watching)); var t = x.querySelector('.watch-label'); if (t) t.textContent = d.watching ? 'Watching' : 'Add to Watchlist'; });
      toast(d.message, 'ok');
    } catch (err) { handleError(err); }
  });

  // Navegación móvil y menús
  var tog = $('.nav-toggle');
  if (tog) tog.addEventListener('click', function () { var n = $('#main-nav'); var open = n.classList.toggle('open'); tog.setAttribute('aria-expanded', String(open)); });
  $$('.hdr-nav .has-drop > button').forEach(function (b) {
    b.addEventListener('click', function () { var li = b.parentNode; var open = !li.classList.contains('open'); $$('.hdr-nav .has-drop.open').forEach(function (x) { x.classList.remove('open'); x.firstElementChild.setAttribute('aria-expanded', 'false'); }); li.classList.toggle('open', open); b.setAttribute('aria-expanded', String(open)); });
  });
  document.addEventListener('click', function (e) {
    if (!e.target.closest('.has-drop')) $$('.hdr-nav .has-drop.open').forEach(function (x) { x.classList.remove('open'); });
    $$('details.lang-switch[open], details.user-menu[open], details.signin-menu[open], details.auth-lang[open]').forEach(function (d) { if (!d.contains(e.target)) d.removeAttribute('open'); });
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { $$('.hdr-nav .has-drop.open').forEach(function (x) { x.classList.remove('open'); }); $$('details[open]').forEach(function (d) { d.removeAttribute('open'); }); } });

  // Pestañas
  $$('[data-tabs]').forEach(function (root) {
    var tabs = $$('[role=tab]', root);
    tabs.forEach(function (t) {
      t.addEventListener('click', function () {
        tabs.forEach(function (x) { x.setAttribute('aria-selected', String(x === t)); var p = document.getElementById(x.dataset.tab); if (p) p.hidden = x !== t; });
      });
    });
  });

  // Carrusel
  $$('[data-carousel]').forEach(function (c) {
    var track = $('[data-carousel-track]', c);
    var step = function (dir) { track.scrollBy({ left: dir * (track.clientWidth * 0.8), behavior: 'smooth' }); };
    var p = $('[data-carousel-prev]', c), n = $('[data-carousel-next]', c);
    if (p) p.addEventListener('click', function () { step(-1); }); if (n) n.addEventListener('click', function () { step(1); });
  });

  // Selects que envían el formulario al cambiar
  $$('select[data-autosubmit]').forEach(function (s) { s.addEventListener('change', function () { s.form.submit(); }); });

  // Marca → modelos (selects dependientes)
  $$('select[data-make-select]').forEach(function (makeSel) {
    var target = document.getElementById(makeSel.dataset.target); if (!target) return;
    var keep = target.dataset.selected || '';
    async function load() {
      var opt = makeSel.selectedOptions[0]; var id = opt && opt.dataset.id;
      target.innerHTML = '<option value="">' + (target.dataset.placeholder || 'All Models') + '</option>';
      target.disabled = !id; if (!id) return;
      try {
        var d = await api('/api/v1/makes/' + id + '/models');
        d.items.forEach(function (m) { var o = document.createElement('option'); o.value = m.id; o.textContent = m.name; if (String(m.id) === keep) o.selected = true; target.appendChild(o); });
      } catch (e) { toast('Could not load models', 'err'); }
    }
    makeSel.addEventListener('change', function () { keep = ''; load(); });
    load();
  });

  // Mostrar/ocultar contraseña
  $$('[data-toggle-pw]').forEach(function (b) { b.addEventListener('click', function () { var i = document.getElementById(b.dataset.togglePw); i.type = i.type === 'password' ? 'text' : 'password'; b.setAttribute('aria-pressed', String(i.type === 'text')); }); });

  // Galería con zoom
  var main = $('.gallery-main');
  if (main) {
    main.addEventListener('click', function (e) { if (!e.target.closest('button')) main.classList.toggle('zoom'); });
    main.addEventListener('mousemove', function (e) { if (!main.classList.contains('zoom')) return; var r = main.getBoundingClientRect(); main.querySelector('img').style.transformOrigin = ((e.clientX - r.left) / r.width * 100) + '% ' + ((e.clientY - r.top) / r.height * 100) + '%'; });
    $$('.thumbs button').forEach(function (b) { b.addEventListener('click', function () { main.querySelector('img').src = b.dataset.src; $$('.thumbs button').forEach(function (x) { x.classList.toggle('on', x === b); }); }); });
  }

  // Cuentas atrás (hora del servidor en data-server-time para corregir el reloj local)
  var offset = 0; var st = document.body.dataset.serverTime; if (st) offset = new Date(st).getTime() - Date.now();
  window.apServerOffset = function (o) { if (typeof o === 'number') offset = o; return offset; };
  function fmt(ms) { if (ms <= 0) return '0s'; var s = Math.floor(ms / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60), sec = s % 60; return d ? d + 'd ' + h + 'h ' + m + 'm' : h ? h + 'h ' + m + 'm ' + sec + 's' : m ? m + 'm ' + sec + 's' : sec + 's'; }
  window.apFmt = fmt;
  function countdowns() { $$('[data-countdown]').forEach(function (el) { var t = new Date(el.dataset.countdown).getTime() - (Date.now() + offset); el.textContent = t > 0 ? fmt(t) : (el.dataset.doneText || 'Starting…'); }); }
  countdowns(); setInterval(countdowns, 1000);

  // Diálogos
  $$('[data-open-dialog]').forEach(function (b) { b.addEventListener('click', function () { var d = document.getElementById(b.dataset.openDialog); if (d) d.showModal(); }); });
  $$('dialog [data-close]').forEach(function (b) { b.addEventListener('click', function () { b.closest('dialog').close(); }); });
  document.addEventListener('api:success', function (e) { var d = e.target.closest && e.target.closest('dialog'); if (d) d.close(); }, true);

  // Guardar búsqueda actual
  var ss = $('[data-save-search]');
  if (ss) ss.addEventListener('click', async function () {
    var name = prompt('Name this search'); if (!name) return;
    try { after(await api('/api/v1/saved-searches', { method: 'POST', body: { name: name, query: location.search.slice(1) } })); } catch (err) { handleError(err); }
  });

  // Menú del área del miembro: plegado por defecto en pantallas pequeñas
  var mn = $('details.mn-mobile'); if (mn && window.matchMedia('(max-width: 980px)').matches) mn.removeAttribute('open');

  // Buscador de vehículos: deslizador doble de kilometraje
  $$('[data-odo-range]').forEach(function (box) {
    var mn = $('[data-odo="min"]', box), mx = $('[data-odo="max"]', box), fill = $('[data-odo-fill]', box);
    var outMin = $('[data-odo-out="min"]', box), outMax = $('[data-odo-out="max"]', box);
    var fmtKm = function (v) { return Number(v).toLocaleString('es-ES'); };
    function sync(e) {
      if (Number(mn.value) > Number(mx.value)) { if (e && e.target === mn) mx.value = mn.value; else mn.value = mx.value; }
      var max = Number(mx.max);
      outMin.textContent = fmtKm(mn.value); outMax.textContent = Number(mx.value) >= max ? fmtKm(max) + '+' : fmtKm(mx.value);
      fill.style.left = (mn.value / max * 100) + '%'; fill.style.right = (100 - mx.value / max * 100) + '%';
    }
    mn.addEventListener('input', sync); mx.addEventListener('input', sync); sync();
    // Valores por defecto no se envían: la URL de resultados queda limpia
    box.closest('form').addEventListener('submit', function () { if (Number(mn.value) === 0) mn.disabled = true; if (Number(mx.value) >= Number(mx.max)) mx.disabled = true; });
  });
  // Buscador de vehículos: Locales / Estado-Provincia / Código postal
  $$('[data-where]').forEach(function (box) {
    function apply() {
      var mode = ($('input[name="where_mode"]:checked', box) || {}).value;
      $$('[data-where-field]', box).forEach(function (f) { var on = f.dataset.whereField === mode; f.hidden = !on; f.disabled = !on; });
    }
    $$('input[name="where_mode"]', box).forEach(function (r) { r.addEventListener('change', apply); r.form && r.form.addEventListener('submit', function () { r.disabled = true; }); });
    apply();
  });

  // Panel lateral "Mi cuenta": cerrar con ✕ o al pulsar fuera
  document.addEventListener('click', function (e) {
    if (e.target.closest('[data-close-drawer]')) { var d = e.target.closest('details'); if (d) d.removeAttribute('open'); }
  });
  // Interruptores que se guardan solos al cambiar
  $$('form[data-autosave]').forEach(function (f) {
    f.addEventListener('change', function () { f.requestSubmit ? f.requestSubmit() : f.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true })); });
  });
  // Asistente por pasos dentro de un formulario (data-steps)
  $$('form[data-steps]').forEach(function (f) {
    var steps = $$('[data-step]', f), cur = 0;
    var next = $('[data-step-next]', f), back = $('[data-step-back]', f), submit = $('[type=submit]', f);
    function show() {
      steps.forEach(function (s, i) { s.hidden = i !== cur; });
      $$('[data-step-dot]', f).forEach(function (d, i) { d.classList.toggle('on', i <= cur); });
      if (back) back.hidden = cur === 0; if (next) next.hidden = cur === steps.length - 1; if (submit) submit.hidden = cur !== steps.length - 1;
    }
    if (next) next.addEventListener('click', function () {
      var missing = $$('[required]', steps[cur]).filter(function (i) { return !i.value.trim(); });
      if (missing.length) { missing.forEach(function (i) { i.setAttribute('aria-invalid', 'true'); }); missing[0].focus(); toast(document.documentElement.lang.indexOf('es') === 0 ? 'Complete los campos obligatorios.' : 'Fill in the required fields.', 'err'); return; }
      cur = Math.min(steps.length - 1, cur + 1); show();
    });
    if (back) back.addEventListener('click', function () { cur = Math.max(0, cur - 1); show(); });
    show();
  });
  // "Igual que la dirección postal"
  $$('[data-copy-address]').forEach(function (cb) {
    cb.addEventListener('change', function () {
      if (!cb.checked) return;
      var a = {}; try { a = JSON.parse(cb.dataset.copyAddress); } catch (x) { return; }
      var f = cb.form; Object.keys(a).forEach(function (k) { var i = f.querySelector('[name="' + k + '"]'); if (i && a[k]) i.value = a[k]; });
    });
  });

  // Cerrar un banner de anuncio
  document.addEventListener('click', function (e) {
    var x = e.target.closest('[data-ann-dismiss]'); if (!x) return;
    var card = x.closest('[data-ann]'); if (card) card.remove();
    api('/api/v1/announcements/' + x.dataset.annDismiss + '/dismiss', { method: 'POST' }).catch(function () {});
  });

  // Copiar al portapapeles (número de miembro, VIN…)
  document.addEventListener('click', function (e) {
    var b = e.target.closest('[data-copy]'); if (!b) return;
    var v = b.dataset.copy;
    var done = function () { toast(v + ' ✓', 'ok'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v).then(done, done); else done();
  });

  $$('[data-print]').forEach(function (b) { b.addEventListener('click', function () { window.print(); }); });

  // Toasts entregados por el servidor (?msg=)
  var params = new URLSearchParams(location.search); if (params.get('msg')) toast(params.get('msg'), 'ok');
})();
