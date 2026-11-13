'use strict';
/**
 * Capturas comparativas desktop 1440x900 y móvil 390x844.
 * Uso: node scripts/screenshots.js [baseUrl] [outDir] [rutas separadas por coma] [--login email]
 */
const path = require('node:path');
const fs = require('node:fs');
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || path.join(__dirname, '..', '.tools', 'ms-playwright');
const { chromium } = require('@playwright/test');

const args = process.argv.slice(2);
const loginIdx = args.indexOf('--login'); const login = loginIdx >= 0 ? args.splice(loginIdx, 2)[1] : null;
const fullIdx = args.indexOf('--full'); const full = fullIdx >= 0 ? (args.splice(fullIdx, 1), true) : false;
const base = args[0] || 'http://127.0.0.1:3000';
const out = path.resolve(args[1] || path.join(__dirname, '..', 'docs', 'screenshots'));
const routes = (args[2] || '/,/how-it-works,/vehicle-finder,/vehicles,/vehicle-alerts,/auctions/calendar,/auctions,/locations,/transport,/login,/register,/membership').split(',');
const sizes = (process.env.SIZES || 'desktop,mobile').split(',');
const VIEWPORTS = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  for (const size of sizes) {
    const ctx = await browser.newContext({ viewport: VIEWPORTS[size], deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    if (login) {
      await page.goto(base + (/vendedor|renting/.test(login) ? '/login?type=seller' : '/login'));
      await page.fill('#email', login); await page.fill('#pw', process.env.DEMO_PASSWORD || 'Demo2026!');
      
      await Promise.all([page.waitForURL(u => !u.pathname.startsWith('/login')), page.click('main form[data-api] button[type=submit]')]);
    }
    for (const r of routes) {
      await page.goto(base + r, { waitUntil: 'networkidle' });
      const name = `${size}-${r.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '') || 'home'}.png`;
      await page.screenshot({ path: path.join(out, name), fullPage: full });
      console.log('✔', name);
    }
    await ctx.close();
  }
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
