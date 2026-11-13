'use strict';
/** Idioma (6) y región (11 países) del sitio: cookies, traducción del portal y filtro del inventario por país. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, shutdown, client, db } = require('./helpers');

let base;
before(async () => { base = await boot(); });
after(shutdown);

test('idioma: los 6 idiomas cambian cabecera, menú del portal y tablero; texto árabe de derecha a izquierda', async () => {
  const c = client(base); await c.login('premium@copart.test');
  const expect = { es: ['Mis ofertas', 'Hola,'], en: ['My Bids', 'Hello,'], fr: ['Mes offres', 'Bonjour,'], ar: ['مزايداتي', 'مرحبًا,'], ru: ['Мои ставки', 'Здравствуйте,'], pl: ['Moje oferty', 'Witaj,'] };
  for (const [lang, [menu, hello]] of Object.entries(expect)) {
    const r = await c.get(`/dashboard?lang=${lang}`);
    assert.equal(r.status, 200, lang);
    assert.ok(r.body.includes(menu), `${lang}: menu "${menu}"`);
    assert.ok(r.body.includes(hello), `${lang}: greeting "${hello}"`);
  }
  const ar = await c.get('/dashboard');            // la cookie conserva el último idioma (pl)
  assert.match(ar.body, /<html lang="pl"/);
  const rtl = await c.get('/?lang=ar');
  assert.match(rtl.body, /<html lang="ar" dir="ltr" class="script-rtl">/);
  assert.match((await c.get('/?lang=xx')).body, /<html lang="ar"/, 'unknown language keeps the cookie');
});

test('región: el inventario, las sedes y la portada se filtran por país; ?country=all muestra todo', async () => {
  const v = client(base);
  const us = await v.get('/vehicles?region=US');
  assert.equal(us.status, 200);
  assert.match(us.body, /Dallas|Miami/);
  assert.doesNotMatch(us.body, /Madrid – Getafe/);
  const usCount = Number((await db.one("SELECT COUNT(*)::int n FROM auction_lots l JOIN vehicles ve ON ve.id=l.vehicle_id JOIN locations loc ON loc.id=ve.location_id WHERE loc.country='US' AND l.status IN ('prebidding','live','scheduled')")).n);
  assert.ok(usCount > 0);
  assert.match(us.body, new RegExp(`${usCount} vehicle`));
  const loc = await v.get('/locations');          // la cookie de región sigue en US
  assert.match(loc.body, /Dallas, TX/); assert.doesNotMatch(loc.body, /Barcelona – Martorell/);
  const all = await v.get('/locations?country=all');
  assert.match(all.body, /Dallas, TX/); assert.match(all.body, /Barcelona – Martorell/);
  const es = await v.get('/vehicles?region=ES');
  assert.doesNotMatch(es.body, /Dallas, TX \(demo\)/);
  assert.match(es.body, /SPAIN/);
  // La API pública no depende de la cookie de región
  const api = await v.get('/api/v1/lots?per_page=100&country=DE');
  assert.ok(api.body.items.length > 0 && api.body.items.every(l => l.location_country === 'DE'));
  // Un número de lote concreto se encuentra aunque sea de otra región
  const foreign = await db.one("SELECT l.lot_number FROM auction_lots l JOIN vehicles ve ON ve.id=l.vehicle_id JOIN locations loc ON loc.id=ve.location_id WHERE loc.country='BR' LIMIT 1");
  assert.match((await v.get(`/vehicles?q=${foreign.lot_number}`)).body, /São Paulo/);
});
