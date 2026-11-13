(function () {
  'use strict';
  var form = document.getElementById('ann-form');
  if (!form) return;
  var preview = form.querySelector('[data-ann-preview]');
  function sync() {
    var t = form.querySelector('[name=title]').value.trim();
    var b = form.querySelector('[name=body]').value.trim();
    var s = form.querySelector('[name=style]').value;
    preview.className = 'ann-banner ann-' + s;
    preview.querySelector('[data-ann-pv="title"]').textContent = t || 'Título del anuncio';
    preview.querySelector('[data-ann-pv="body"]').textContent = b;
  }
  form.querySelectorAll('[data-ann-live]').forEach(function (el) { el.addEventListener('input', sync); el.addEventListener('change', sync); });
  sync();
})();
