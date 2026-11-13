(function () {
  'use strict';
  var row = document.getElementById('company-row');
  document.querySelectorAll('[data-business-toggle]').forEach(function (r) {
    r.addEventListener('change', function () { if (row) { row.hidden = r.value !== 'business' || !r.checked; var i = row.querySelector('input'); if (i) i.required = !row.hidden; } });
  });
  // Registro nuevo: casilla "Me registro como empresa"
  var biz = document.querySelector('[data-business-check]'), type = document.querySelector('[data-account-type]');
  if (biz && type) biz.addEventListener('change', function () { type.value = biz.checked ? 'business' : 'individual'; if (row) { row.hidden = !biz.checked; var i = row.querySelector('input'); if (i) i.required = biz.checked; } });
  // Tras el pago sandbox de la membresía, continuar al paso 3
  var after = document.getElementById('after-pay');
  if (after) {
    var target = JSON.parse(after.textContent).redirect;
    document.addEventListener('api:success', function () { setTimeout(function () { location.href = target; }, 700); });
  }
})();
