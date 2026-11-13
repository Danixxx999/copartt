/* Controles del portal sobre los datos visibles de la cuenta. */
(function () {
  'use strict';
  document.querySelectorAll('[data-table]').forEach(function (box) {
    var rows = Array.from(box.querySelectorAll('tbody tr')).filter(function (r) { return !r.querySelector('[colspan]'); });
    var page = 0, size = 20, query = '', saleStatus = '';
    var saleFilter = box.parentElement.querySelector('[data-sale-filter]');
    function matches(row) {
      return row.textContent.toLocaleLowerCase().includes(query) &&
        (!saleStatus || row.dataset.saleStatus === saleStatus);
    }
    if (saleFilter) saleFilter.addEventListener('change', function () {
      saleStatus = saleFilter.value;
      page = 0;
      render();
    });
    function render() {
      var found = rows.filter(matches);
      var last = Math.max(0, Math.ceil(found.length / size) - 1); page = Math.min(page, last);
      rows.forEach(function (r) { r.hidden = true; });
      found.slice(page * size, (page + 1) * size).forEach(function (r) { r.hidden = false; });
      box.querySelectorAll('[data-result-count]').forEach(function (n) { n.textContent = found.length; });
      box.querySelectorAll('[data-page]').forEach(function (b) { b.disabled = (b.dataset.page === 'first' || b.dataset.page === 'prev') ? page === 0 : page === last; });
      var empty = box.querySelector('.filter-empty');
      if (!empty && rows.length) { empty = document.createElement('tr'); empty.className = 'filter-empty'; var cell = document.createElement('td'); cell.colSpan = box.querySelectorAll('thead th').length; cell.className = 'empty-cell'; cell.textContent = 'No se encontraron resultados'; empty.appendChild(cell); box.querySelector('tbody').appendChild(empty); }
      if (empty) empty.hidden = found.length > 0;
    }
    box.addEventListener('input', function (e) { if (!e.target.matches('[data-table-search]')) return; query = e.target.value.trim().toLocaleLowerCase(); page = 0; box.querySelectorAll('[data-table-search]').forEach(function (i) { i.value = e.target.value; }); render(); });
    box.addEventListener('change', function (e) { if (!e.target.matches('[data-page-size]')) return; size = Number(e.target.value); page = 0; box.querySelectorAll('[data-page-size]').forEach(function (i) { i.value = String(size); }); render(); });
    box.addEventListener('click', function (e) { var b = e.target.closest('[data-page]'); if (!b) return; var n = rows.filter(matches).length; page = b.dataset.page === 'first' ? 0 : b.dataset.page === 'last' ? Math.max(0, Math.ceil(n / size) - 1) : page + (b.dataset.page === 'next' ? 1 : -1); render(); });
    box.querySelectorAll('thead th').forEach(function(th,index){
      if(!th.textContent.trim())return;
      var button=document.createElement('button');button.type='button';button.className='sort-column';button.textContent=th.textContent;th.textContent='';th.appendChild(button);th.setAttribute('aria-sort','none');
      button.addEventListener('click',function(){var asc=th.getAttribute('aria-sort')!=='ascending';box.querySelectorAll('th').forEach(function(h){h.setAttribute('aria-sort','none');});th.setAttribute('aria-sort',asc?'ascending':'descending');rows.sort(function(a,b){return (a.cells[index]?.textContent||'').localeCompare(b.cells[index]?.textContent||'','es',{numeric:true})*(asc?1:-1);});rows.forEach(function(r){r.parentNode.appendChild(r);});page=0;render();});
    });
    render();
  });
  document.querySelectorAll('[data-column-index]').forEach(function(input){input.addEventListener('change',function(){var index=Number(input.dataset.columnIndex);document.querySelectorAll('.member-main table tr').forEach(function(row){if(row.cells[index]&&row.cells[index].colSpan===1)row.cells[index].hidden=!input.checked;});});});
  document.addEventListener('click', function (e) {
    var collapse=e.target.closest('[data-collapse-sidebar]');
    if(collapse){var wrap=collapse.closest('.member-wrap');var collapsed=wrap.classList.toggle('sidebar-collapsed');collapse.textContent=collapsed?'❯':'❮';collapse.setAttribute('aria-label',collapsed?'Expandir lista de acción':'Contraer lista de acción');}
    if(e.target.closest('[data-clear-filters]')){document.querySelectorAll('[data-table-search]').forEach(function(i){i.value='';i.dispatchEvent(new Event('input',{bubbles:true}));});}
    var step=e.target.closest('[data-bid-step]');
    if(step){var amount=(step.closest('.bid-stepper')||document).querySelector('[data-min-bid]');if(amount){var val=Number(amount.value)||Number(amount.min);amount.value=String(Math.max(Number(amount.min),val+Number(step.dataset.bidStep)*Number(amount.step||25)));amount.dispatchEvent(new Event('input',{bubbles:true}));}}
    var photo=e.target.closest('[data-photo-prev],[data-photo-next]');
    if(photo){var thumbs=Array.from(document.querySelectorAll('.thumbs button'));if(thumbs.length){var current=thumbs.findIndex(function(b){return b.classList.contains('on');});var next=(current+(photo.hasAttribute('data-photo-next')?1:-1)+thumbs.length)%thumbs.length;thumbs[next].click();}}
    var thumb=e.target.closest('.thumbs button');if(thumb){var all=Array.from(document.querySelectorAll('.thumbs button'));var count=document.querySelector('[data-photo-count]');if(count)count.textContent=(all.indexOf(thumb)+1)+' / '+all.length;}
    var calendarTimes = e.target.closest('[data-calendar-times]');
    if (calendarTimes) {
      var calendar = document.querySelector('.portal-calendar');
      if (calendar) {
        var hiddenTimes = calendar.classList.toggle('hide-times');
        calendarTimes.setAttribute('aria-pressed', String(hiddenTimes));
        calendarTimes.textContent = hiddenTimes ? 'Mostrar tiempos' : 'Ocultar tiempos';
      }
    }
    var imagesButton=e.target.closest('[data-toggle-images]');
    if (imagesButton) { var imgs = document.querySelectorAll('.member-main .mini-img'); var hide = imgs.length && !imgs[0].hidden; imgs.forEach(function(i){i.hidden=hide;}); imagesButton.textContent = hide ? 'Mostrar imágenes' : 'Ocultar imágenes'; }
    if (e.target.closest('[data-text-size]')) document.querySelector('.member-main').classList.toggle('large-table-text');
    if (e.target.closest('[data-export-table]')) {
      var table = document.querySelector('main table');
      if (!table) { if(window.apToast) window.apToast('No hay filas para exportar.'); return; }
      var lines = Array.from(table.rows).filter(function(r){return !r.hidden;}).map(function(r){return Array.from(r.cells).filter(function(c){return !c.hidden;}).map(function(c){var value=c.textContent.trim().replace(/\s+/g,' '); if (/^[=+@\-]/.test(value)) value="'"+value; return '"'+value.replace(/"/g,'""')+'"';}).join(',');});
      var url=URL.createObjectURL(new Blob(['\ufeff'+lines.join('\r\n')],{type:'text/csv;charset=utf-8'}));var a=document.createElement('a');a.href=url;a.download='copart-'+new Date().toISOString().slice(0,10)+'.csv';a.click();setTimeout(function(){URL.revokeObjectURL(url);},1000);
    }
  });
  var notes = document.querySelector('[data-lot-notes]');
  document.querySelectorAll('[data-refresh-bid]').forEach(function(form){form.addEventListener('api:success',function(){setTimeout(function(){location.reload();},900);});});
  if (notes) { try { notes.value=localStorage.getItem(notes.dataset.lotNotes)||''; }catch(e){} notes.addEventListener('input',function(){try{localStorage.setItem(notes.dataset.lotNotes,notes.value);}catch(e){}}); }
  var dialog = document.querySelector('[data-profile-dialog]');
  if (dialog) { var key = dialog.dataset.profileDialog; try{if(!localStorage.getItem(key)) dialog.showModal();}catch(e){dialog.showModal();} dialog.querySelector('[data-close-dialog]').addEventListener('click',function(){dialog.close();}); dialog.querySelector('form').addEventListener('submit',function(e){e.preventDefault();var data=new FormData(e.target);try{localStorage.setItem(key,JSON.stringify({purpose:data.get('purpose'),exporter:data.has('exporter')}));dialog.close();}catch(err){window.apToast('No fue posible guardar las preferencias en este navegador.','err');}}); }
})();
