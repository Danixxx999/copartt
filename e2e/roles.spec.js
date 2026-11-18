const { test, expect } = require('@playwright/test');
const { login, toast } = require('./helpers');

test('guest: guarda favorito pero no puede pujar', async ({ page }) => {
  await login(page, 'guest@copart.test');
  await page.goto('/vehicles');
  const lotLink = page.locator('.lot-card a.lot-num').first();
  await lotLink.click();
  await expect(page.locator('.bid-box')).toContainText('Actualice su plan para ofertar');
  await page.locator('main .watch-btn').first().click();
  await toast(page, /Watchlist/);
});

test('premium: prepuja desde la ficha y la ve en Mis pujas', async ({ page }) => {
  await login(page, 'premium@copart.test');
  await page.goto('/vehicles?sort=bid_asc');
  await page.locator('.lot-card a.lot-num').nth(3).click();
  const min = Number(await page.locator('#amount').getAttribute('min'));
  await page.fill('#amount', String(min + 100));
  await page.click('#bid-form button[type=submit]');
  await toast(page, /high bidder|registered/);
  await page.goto('/dashboard/bids');
  await expect(page.locator('.tbl tbody tr').first()).toBeVisible();
});

test('vendedor crea borrador; admin y finanzas/logística acceden a sus paneles', async ({ page, browser }) => {
  await login(page, 'vendedor@copart.test', 'seller');
  await expect(page).toHaveURL(/\/seller/);
  await page.goto('/seller/vehicles/new');
  await page.selectOption('#v-make', { label: 'Seat' });
  await expect(page.locator('#v-model option').nth(1)).toBeAttached();
  await page.selectOption('#v-model', { index: 1 });
  await page.fill('#v-vin', 'E2ETEST' + String(Date.now()).slice(-9));
  await page.click('main form[data-api] button[type=submit]');
  await expect(page).toHaveURL(/\/seller\/vehicles\/\d+\/edit/);
  await expect(page.getByText('Photos (0/12)')).toBeVisible();

  for (const [email, url, heading] of [['admin@copart.test', '/admin', /Hola, Lucas|Hello, Lucas/], ['finanzas@copart.test', '/finance', 'Cola de pagos'], ['logistica@copart.test', '/ops', 'Resumen de logística']]) {
    const ctx = await browser.newContext(); const p = await ctx.newPage();
    await login(p, email); await p.goto(url);
    await expect(p.getByRole('heading', { name: heading })).toBeVisible();
    await ctx.close();
  }
});
