'use strict';
// Recorre todas las páginas como visitante y como cada rol; informa de cualquier respuesta >= 400 inesperada.
// Uso: node scripts/crawl.js [baseUrl]
const base = process.argv[2] || 'http://127.0.0.1:3000';
const PASSWORD = process.env.DEMO_PASSWORD || 'Demo2026!';
const PUBLIC = ['/', '/how-it-works', '/vehicle-finder', '/vehicles', '/vehicles?view=list&sort=bid_desc', '/vehicles?make=toyota', '/vehicle-alerts', '/auctions/calendar', '/auctions/calendar?view=list', '/auctions', '/locations', '/locations?q=Madrid', '/locations/MAD', '/transport', '/membership', '/register', '/login', '/forgot-password', '/help', '/how-to-buy', '/faq', '/faq?q=pin', '/contact', '/sell-a-vehicle', '/videos', '/sitemap', '/api/docs', '/fee-calculator?amount=3000', '/page/terms', '/page/privacy', '/page/cookie-policy', '/page/company-details', '/page/about-us', '/media/car/suv.svg?view=front',
  // idiomas y regiones (la cookie se conserva entre páginas; al final se vuelve a español/España)
  '/sales-list', '/watchList', '/savedsearch', '/vehicles?buy_now=1', '/vehicles?province=Madrid', '/vehicles?zip=08', '/vehicles?seller_type=rental,fleet,leasing',
  '/?lang=fr','/vehicles?lang=ar&region=AE', '/locations?lang=ru&region=DE', '/vehicle-finder?lang=pl&region=BR', '/locations?country=all&lang=en&region=US', '/vehicles?country=all', '/?lang=es&region=ES'];
const ROLE_PAGES = {
  'guest@copart.test': ['/dashboard', '/dashboard/watchlist', '/dashboard/bids', '/dashboard/purchases', '/dashboard/invoices', '/dashboard/saved-searches', '/dashboard/alerts', '/dashboard/membership', '/dashboard/documents', '/dashboard/notifications', '/dashboard/profile', '/dashboard/buying-power', '/dashboard/recently-viewed', '/dashboard/payments'],
  'premium@copart.test': ['/dashboard', '/dashboard/bids?tab=won', '/dashboard/bids?tab=lost', '/dashboard/bids?tab=counter', '/dashboard/purchases', '/dashboard/invoices', '/dashboard/payments', '/dashboard/payments?tab=history', '/dashboard/buying-power', '/dashboard/recently-viewed'],
  'basic@copart.test': ['/account/personal-information', '/account/payment-methods', '/account/payment-methods?tab=deposit', '/account/title-management', '/account/documents-forms', '/account/documents-forms?tab=forms', '/account/access-keys', '/account/preferences/location-language', '/account/preferences/buyer-interests', '/account/preferences/communication', '/account/notifications', '/account/member-fees', '/account/forms/company-purchase.pdf', '/dashboard','/dashboard/bids', '/dashboard/bids?tab=counter', '/dashboard/payments', '/dashboard/buying-power'],
  'vendedor@copart.test': ['/seller', '/seller/vehicles', '/seller/vehicles?status=draft', '/seller/vehicles/new', '/seller/sales', '/seller/calendar', '/seller/statements'],
  'admin@copart.test': ['/admin', '/admin/users', '/admin/users?role=buyer&q=a', '/admin/documents', '/admin/documents?status=all', '/admin/sellers', '/admin/vehicles', '/admin/vehicles?status=all', '/admin/auctions', '/admin/bids', '/admin/memberships', '/admin/catalog', '/admin/locations', '/admin/locations?edit=1', '/admin/content', '/admin/content?page=terms', '/admin/roles', '/admin/payments','/admin/vehicles/new', '/admin/vehicles/1/edit', '/admin/support', '/admin/settings', '/admin/audit', '/admin/mailbox', '/admin/reports', '/finance', '/ops'],
  'finanzas@copart.test': ['/finance', '/finance?status=all', '/finance/invoices', '/finance/balances', '/admin/reports'],
  'logistica@copart.test': ['/ops', '/ops/pickups', '/ops/transport', '/ops/yards', '/admin/reports'],
};

function jar() {
  let cookie = {};
  return {
    async req(path, opts = {}) {
      const headers = { ...(opts.headers || {}), cookie: Object.entries(cookie).map(([k, v]) => `${k}=${v}`).join('; ') };
      const r = await fetch(base + path, { ...opts, headers, redirect: 'manual' });
      for (const c of r.headers.getSetCookie?.() || []) { const [kv] = c.split(';'); const i = kv.indexOf('='); cookie[kv.slice(0, i)] = kv.slice(i + 1); }
      return r;
    },
    get csrf() { return cookie.ap_csrf; },
  };
}

(async () => {
  let failures = 0, count = 0;
  const check = async (j, p, who) => {
    const r = await j.req(p); count++;
    if (r.status >= 400) { failures++; const t = await r.text(); console.log(`✖ ${r.status} ${who} ${p} ${t.slice(0, 300).replace(/\s+/g, ' ')}`); }
  };
  const anon = jar(); await anon.req('/');
  for (const p of PUBLIC) await check(anon, p, 'visitor');
  const lots = await (await anon.req('/api/v1/lots?per_page=3&status=all')).json();
  for (const l of lots.items) await check(anon, `/lot/${l.lot_number}`, 'visitor');
  await check(anon, `/auctions/${lots.items[0].event_id}/live`, 'visitor');
  for (const [email, pages] of Object.entries(ROLE_PAGES)) {
    const j = jar(); await j.req('/login');
    const r = await j.req('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': j.csrf }, body: JSON.stringify({ email, password: PASSWORD, account_type: email.startsWith('vendedor') ? 'seller' : 'buyer' }) });
    if (r.status !== 200) { failures++; console.log('✖ login', email, r.status, await r.text()); continue; }
    for (const p of pages) await check(j, p, email.split('@')[0]);
    if (email.startsWith('premium@')) {
      const orders = await j.req('/dashboard/purchases'); const html = await orders.text();
      const ids = [...html.matchAll(/\/dashboard\/purchases\/(\d+)/g)].map(m => m[1]);
      for (const id of [...new Set(ids)]) await check(j, `/dashboard/purchases/${id}`, 'premium');
      const inv = [...html.matchAll(/x/g)]; void inv;
    }
    if (email.startsWith('admin@')) {
      await check(j, '/admin/users/1', 'admin'); await check(j, '/admin/vehicles/1', 'admin'); await check(j, '/admin/auctions/1', 'admin');
      await check(j, '/dashboard/invoices/1.pdf', 'admin'); await check(j, '/api/v1/reports/sales.csv', 'admin');
    }
    if (email.startsWith('vendedor@')) await check(j, '/seller/vehicles/7/edit', 'seller');
  }
  console.log(`\n${count} pages checked, ${failures} failure(s).`);
  process.exit(failures ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
