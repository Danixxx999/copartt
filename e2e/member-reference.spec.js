const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

test('portal: páginas de referencia, filtros, CSV y navegación', async ({ page }) => {
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await login(page,'basic@copart.test');
  for(const route of ['/dashboard','/dashboard/lots','/dashboard/bids','/dashboard/bids?tab=won','/dashboard/bids?tab=lost','/dashboard/payments','/dashboard/payments?tab=history','/dashboard/payments?tab=history&view=transactions','/vehicle-finder','/auctions']){
    const response=await page.goto(route);expect(response.status(),route).toBe(200);
    await expect(page.getByRole('heading',{level:1})).toBeVisible();
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),route+' sin desbordamiento global').toBe(true);
  }
  await page.goto('/dashboard/lots');
  await page.locator('[data-table-search]').first().fill('no-existe-12345');
  await expect(page.locator('[data-result-count]').first()).toHaveText('0');
  await page.locator('[data-table-search]').first().fill('');
  await page.locator('.column-picker summary').click();
  await page.locator('[data-column-index="8"]').uncheck();
  await expect(page.locator('thead th').nth(8)).toBeHidden();
  await page.locator('[data-column-index="8"]').check();
  await page.locator('.column-picker summary').click();
  await page.locator('th').nth(1).getByRole('button').click();
  await expect(page.locator('th').nth(1)).toHaveAttribute('aria-sort','ascending');
  await page.locator('[data-collapse-sidebar]').click();
  await expect(page.locator('.member-wrap')).toHaveClass(/sidebar-collapsed/);
  await page.locator('[data-collapse-sidebar]').click();
  const download=page.waitForEvent('download');await page.locator('[data-export-table]').click();
  expect((await download).suggestedFilename()).toMatch(/copart.*\.csv/);
  await page.locator('.hdr-nav').getByRole('button',{name:'Inventario'}).click();
  await page.locator('.hdr-nav').getByRole('link',{name:'Buscador de vehículos',exact:true}).click();
  await expect(page).toHaveURL(/vehicle-finder/);
  await page.locator('.cond-box').first().click();
  const lot=page.locator('a[href^="/lot/"]').first();await expect(lot).toBeVisible();await lot.click();
  await expect(page.locator('.gallery-main img')).toBeVisible();
  await page.locator('[data-lot-notes]').fill('Revisar estado del vehículo');await page.reload();
  await expect(page.locator('[data-lot-notes]')).toHaveValue('Revisar estado del vehículo');
  expect(errors).toEqual([]);
});

test('densidad de escritorio: cabecera y panel a la escala de las capturas',async({page})=>{
  await page.setViewportSize({width:1900,height:1000});await login(page,'guest@copart.test');
  expect((await page.goto('/dashboard/lots')).status()).toBe(200);
  const dimensions=await page.evaluate(()=>({header:document.querySelector('.hdr-main').getBoundingClientRect().height,nav:document.querySelector('.hdr-nav').getBoundingClientRect().height,sidebar:document.querySelector('.member-nav').getBoundingClientRect().width,radio:document.querySelector('.radio-dot').getBoundingClientRect().width,footer:document.querySelector('.site-footer').getBoundingClientRect().top-document.querySelector('.member-wrap').getBoundingClientRect().top}));
  expect(dimensions.header).toBeLessThanOrEqual(101);expect(dimensions.nav).toBeLessThanOrEqual(51);
  expect(dimensions.sidebar).toBeLessThanOrEqual(216);expect(dimensions.radio).toBeLessThanOrEqual(16);
  // El CMS puede insertar anuncios sobre el panel. Medimos su propia altura.
  expect(dimensions.footer).toBeGreaterThan(490);expect(dimensions.footer).toBeLessThan(520);
});

test('bienvenida: selección y guardado de preferencias locales',async({page})=>{
  await login(page,'basic@copart.test');await page.goto('/dashboard?welcome=1');
  await expect(page.locator('dialog')).toBeVisible();
  await page.getByLabel('Compro para uso personal.').check();await page.getByRole('button',{name:'Guardar',exact:true}).click();
  await expect(page.locator('dialog')).not.toBeVisible();await page.reload();await expect(page.locator('dialog')).not.toBeVisible();
});

test('móvil: portal y tablas dentro de la pantalla',async({page})=>{
  await page.setViewportSize({width:390,height:844});await login(page,'basic@copart.test');
  for(const route of ['/dashboard','/dashboard/lots','/dashboard/bids','/dashboard/payments','/dashboard/payments?tab=history','/vehicle-finder','/auctions']){
    expect((await page.goto(route)).status()).toBe(200);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),route).toBe(true);
  }
  await page.locator('.nav-toggle').click();await expect(page.locator('.hdr-nav').getByRole('link',{name:'Tablero',exact:true})).toBeVisible();
});
