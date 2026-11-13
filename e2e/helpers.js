const { expect } = require('@playwright/test');
const PASSWORD = process.env.DEMO_PASSWORD || 'Demo2026!';
async function login(page, email, type = 'buyer') {
  await page.goto(type === 'seller' ? '/login?type=seller' : '/login');
  const cookieBanner=page.locator('[data-cookie-banner]');if(await cookieBanner.isVisible())await cookieBanner.locator('[data-cookie-choice="reject"]').first().click();
  await page.fill('#email', email);
  await page.fill('#pw', PASSWORD);
  await Promise.all([page.waitForURL(u => !u.pathname.startsWith('/login')), page.click('main form[data-api] button[type=submit]')]);
}
async function toast(page, re) { await expect(page.locator('.toast').filter({ hasText: re }).first()).toBeVisible(); }
module.exports = { login, toast, PASSWORD };
