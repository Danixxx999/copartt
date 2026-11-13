const {test,expect}=require('@playwright/test');
const {login}=require('./helpers');

test('visitante → cliente → salir: cambian menú, portada y membresías',async({page})=>{
 await page.goto('/');
 await expect(page.locator('body')).toHaveClass(/visitor-portal.*theme-dark/);
 await expect(page.locator('.portal-caption')).toHaveCount(0);
 await expect(page.locator('.hdr-nav a[href="/dashboard"]')).toHaveCount(0);
 await expect(page.locator('.hdr-right>a[href="/register"]')).toBeVisible();
 await expect(page.locator('.home-memberships')).toBeVisible();
 await expect(page.locator('.home-hero-copy>.btn')).toHaveAttribute('href','/register');
 const position=await page.evaluate(()=>({vehicles:document.querySelector('.home-popular').offsetTop,memberships:document.querySelector('.home-memberships').offsetTop,browse:document.querySelector('.home-browse').offsetTop}));
 expect(position.memberships).toBeGreaterThan(position.vehicles);expect(position.memberships).toBeLessThan(position.browse);
 await page.goto('/?theme=light');await login(page,'basic@copart.test');await page.goto('/');
 await expect(page.locator('body')).toHaveClass(/member-portal.*theme-dark/);
 await expect(page.locator('.portal-caption')).toHaveText('Portal de Miembro');
 await expect(page.locator('.hdr-nav a[href="/dashboard"]')).toBeVisible();
 await expect(page.locator('.home-memberships')).toHaveCount(0);
 await expect(page.locator('.hdr-right>a[href="/register"]')).toHaveCount(0);
 await expect(page.locator('.home-hero-copy>.btn')).toHaveAttribute('href','/vehicles');
 await expect(page.locator('[data-cookie-banner]')).toHaveCount(0);
 await page.locator('.acct-menu summary').click();await page.locator('.acct-drawer form.acct-logout button[type=submit]').click();await page.waitForURL(u=>u.pathname==='/');
 await expect(page.locator('body')).toHaveClass(/visitor-portal.*theme-light/);
 await expect(page.locator('.home-memberships')).toBeVisible();
});

test('tema oscuro e idioma no conceden acceso de cliente',async({page})=>{
 await page.goto('/?theme=dark&lang=en');
 await expect(page.locator('body')).toHaveClass(/visitor-portal.*theme-dark/);
 await expect(page.locator('.signin-menu>summary')).toHaveText('Sign In');
 await expect(page.locator('.hdr-nav a[href="/dashboard"]')).toHaveCount(0);
 await expect(page.locator('.home-memberships')).toBeVisible();
 await expect(page.getByRole('heading',{name:'100% Online Auto Auctions',exact:true})).toBeVisible();
 await page.goto('/');await expect(page.locator('body')).toHaveClass(/visitor-portal.*theme-dark/);
});

test('preferencias de cookies: rechazo, selección y persistencia',async({page})=>{
 await page.goto('/');await expect(page.locator('[data-cookie-banner]')).toBeVisible();
 await page.locator('[data-cookie-banner] [data-cookie-settings]').click();await expect(page.locator('[data-cookie-dialog]')).toBeVisible();
 await page.locator('[data-cookie-dialog] input[name="analytics"]').check();await page.locator('[data-cookie-dialog] button[type=submit]').click();
 await expect(page.locator('[data-cookie-banner]')).toBeHidden();await page.reload();await expect(page.locator('[data-cookie-banner]')).toBeHidden();
 await page.locator('.footer-cookie-settings').click();await expect(page.locator('[data-cookie-dialog]')).toBeVisible();await expect(page.locator('[name=analytics]')).toBeChecked();await page.locator('[data-cookie-dialog]').press('Escape');
 const prefs=(await page.context().cookies()).find(c=>c.name==='ap_cookie_preferences');expect(JSON.parse(decodeURIComponent(prefs.value))).toMatchObject({essential:true,analytics:true,marketing:false});
});
