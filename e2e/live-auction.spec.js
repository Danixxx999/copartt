const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

// Dos compradores en navegadores separados ven la puja del otro en tiempo real.
test('sala en vivo: 2 navegadores, puja en tiempo real, un único líder', async ({ browser }) => {
  const admin = await (await browser.newContext()).newPage();
  await login(admin, 'admin@copart.test');
  await admin.goto('/admin/auctions');
  const row = admin.locator('tr', { hasText: 'Sala demo' }).first();
  const roomHref = await row.locator('a', { hasText: 'Room' }).getAttribute('href');
  if (await row.getByRole('button', { name: 'Start now' }).count()) {
    admin.once('dialog', d => d.accept());
    await row.getByRole('button', { name: 'Start now' }).click();
    await admin.waitForURL(/\/live$/);
  }

  const ctxA = await browser.newContext(); const a = await ctxA.newPage();
  const ctxB = await browser.newContext(); const b = await ctxB.newPage();
  await login(a, 'premium@copart.test'); await login(b, 'premium2@copart.test');
  await Promise.all([a.goto(roomHref), b.goto(roomHref)]);
  await expect(a.locator('[data-conn]')).toHaveClass(/\bok\b/); // conectado (texto según idioma)
  await expect(b.locator('[data-conn]')).toHaveClass(/\bok\b/);
  await expect(a.locator('[data-quick-bid]')).toBeEnabled({ timeout: 15000 });

  const lotLabel = await a.locator('[data-lot-label]').textContent();
  await a.locator('[data-quick-bid]').click();
  await expect(a.locator('[data-my-status]')).toContainText('high bidder');
  const priceA = await a.locator('[data-price]').textContent();
  // B ve el nuevo precio sin recargar (si el lote no ha cerrado entre medias)
  if ((await b.locator('[data-lot-label]').textContent()) === lotLabel) await expect(b.locator('[data-price]')).toHaveText(priceA);
  await b.locator('[data-quick-bid]').click();
  await expect(b.locator('[data-my-status]')).toContainText(/high bidder|Outbid|closed/);
  await ctxA.close(); await ctxB.close();
});
