const { test, expect } = require('@playwright/test');

test('visitante: home, menú, buscador con filtros, ficha de lote sin poder pujar', async ({ page, isMobile }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Subastas de Autos 100% En línea' })).toBeVisible();
  await expect(page.getByRole('heading',{name:'Síganos'})).toBeVisible();
  await expect(page.locator('.academic-note')).toContainText('Proyecto académico');
  if (isMobile) { await page.click('.nav-toggle'); await expect(page.locator('#main-nav')).toBeVisible(); }
  await page.goto('/vehicle-finder');
  await page.selectOption('#vf-make', { label: 'Toyota' });
  await expect(page.locator('#vf-model option').nth(1)).toBeAttached(); // modelos dependientes cargados por API
  await page.click('.finder-card button[type=submit]');
  await expect(page).toHaveURL(/make=toyota/);
  await expect(page.getByRole('heading', { name: 'Search Results' })).toBeVisible();
  const first = page.locator('.lot-card a.lot-num').first();
  if (await first.count()) {
    await first.click();
    await expect(page.getByText('Información de oferta')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Iniciar sesión para ofertar' })).toBeVisible();
    await expect(page.locator('.page-head')).toContainText('******'); // VIN mascarado
    await expect(page.locator('summary').filter({hasText:'Información de venta'})).toBeVisible();
  }
});

test('visitante: calendario, sedes, alertas y transporte funcionan', async ({ page }) => {
  await page.goto('/auctions/calendar');
  await expect(page.getByRole('heading', { name: 'Calendario de subastas' }).first()).toBeVisible();
  await page.goto('/locations');
  await page.fill('#lq', 'Madrid'); await page.click('.loc-search button');
  await expect(page.locator('.loc-item')).toHaveCount(1);
  await page.goto('/transport');
  await page.fill('#t-cp', '46001'); await page.click('#estimate-form button[type=submit]');
  await expect(page.locator('.toast').first()).toContainText('Estimated price');
});
