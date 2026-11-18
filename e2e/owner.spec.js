const { test, expect } = require('@playwright/test');
const { login } = require('./helpers');

test('propietario: entra como un comprador, ve su Member Dashboard y vuelve a su cuenta', async ({ page }) => {
  page.on('dialog', d => d.accept()); // confirm() de "Entrar como"
  await login(page, 'admin@copart.test');
  await page.goto('/admin/users?q=basic');
  await page.getByRole('button', { name: /Entrar como/ }).first().click();
  await page.waitForURL(u => u.pathname.startsWith('/dashboard'));
  await expect(page.locator('.imp-bar')).toContainText('Estás actuando como');
  await expect(page.getByRole('heading', { name: /Hola,/ })).toBeVisible();
  await expect(page.getByText('Poder adquisitivo disponible')).toBeVisible();
  await page.getByRole('button', { name: 'Volver a mi cuenta' }).click();
  await page.waitForURL(u => u.pathname.startsWith('/admin/users/'));
  await expect(page.locator('.imp-bar')).toHaveCount(0);
});
