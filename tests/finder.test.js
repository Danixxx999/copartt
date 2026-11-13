'use strict';
/** Buscador de vehículos del portal: filtros de "Artículos destacados", provincia/código postal, VIN, y oferta inicial + máxima. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, shutdown, client, db } = require('./helpers');

let base;
before(async () => { base = await boot(); });
after(shutdown);
const lots = async (c, q) => (await c.get('/api/v1/lots?per_page=100&' + q)).body.items;

test('filtros del buscador: Buy It Now, arranca, llaves, flota, provincia, código postal, VIN y tipo de documento', async () => {
  const c = client(base);
  const bin = await lots(c, 'buy_now=1');
  assert.ok(bin.length > 0 && bin.every(l => l.buy_now_cents && l.status === 'prebidding'));
  const runs = await lots(c, 'runs=1');
  assert.ok(runs.length > 0 && runs.every(l => l.runs_drives));
  assert.ok((await lots(c, 'keys=1')).every(l => l.has_keys));
  const fleet = await lots(c, 'seller_type=rental,fleet,leasing');
  assert.ok(fleet.length > 0);
  const prov = await lots(c, 'province=Madrid');
  assert.ok(prov.length > 0 && prov.every(l => l.location_code === 'MAD'));
  assert.ok((await lots(c, 'zip=28')).every(l => l.location_code === 'MAD'));
  const v = await db.one("SELECT v.vin, l.lot_number, v.document_type FROM vehicles v JOIN auction_lots l ON l.vehicle_id=v.id WHERE l.status='prebidding' LIMIT 1");
  const byVin = await lots(c, `vin=${v.vin.slice(0, 10)}`);
  assert.ok(byVin.some(l => l.lot_number === Number(v.lot_number)), 'VIN prefix search');
  assert.ok((await lots(c, `q=${v.vin}`)).some(l => l.lot_number === Number(v.lot_number)), 'full VIN in free text');
  assert.ok((await lots(c, `doc=${encodeURIComponent(v.document_type)}`)).every(l => l.document_type === v.document_type));
  const page = await c.get('/vehicle-finder');
  assert.equal(page.status, 200);
  for (const s of ['Artículos destacados', 'Tipo de título', 'Provincias', 'Ciudades populares', 'VIN/Lote #', 'Consejos de búsqueda']) assert.ok(page.body.includes(s), s);
  assert.equal((await c.get(`/vehicles?q=${v.vin}`)).status, 200);
});

test('oferta inicial + oferta máxima: el sistema guarda el máximo como proxy', async () => {
  const p = client(base); await p.login('premium@copart.test');
  const lot = await db.one("SELECT l.id, l.starting_bid_cents FROM auction_lots l JOIN vehicles v ON v.id=l.vehicle_id JOIN locations loc ON loc.id=v.location_id WHERE l.status='prebidding' AND l.bid_count=0 AND loc.country='ES' ORDER BY l.starting_bid_cents LIMIT 1");
  const start = lot.starting_bid_cents / 100;
  const r = await p.post(`/api/v1/lots/${lot.id}/bids`, { amount: start, max_amount: start + 500, kind: 'prebid' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const mine = await db.one("SELECT pb.max_cents FROM proxy_bids pb JOIN users u ON u.id=pb.user_id WHERE pb.lot_id=$1 AND u.email='premium@copart.test'", [lot.id]);
  assert.equal(Number(mine.max_cents), (start + 500) * 100);
  const after = await db.one('SELECT current_bid_cents FROM auction_lots WHERE id=$1', [lot.id]);
  assert.equal(Number(after.current_bid_cents), lot.starting_bid_cents, 'visible price stays at the starting bid (proxy)');
  // Oferta máxima vacía o 0 → se usa la oferta inicial
  const lot2 = await db.one("SELECT l.id, l.starting_bid_cents FROM auction_lots l JOIN vehicles v ON v.id=l.vehicle_id JOIN locations loc ON loc.id=v.location_id WHERE l.status='prebidding' AND l.bid_count=0 AND loc.country='ES' AND l.id<>$1 ORDER BY l.starting_bid_cents LIMIT 1", [lot.id]);
  assert.equal((await p.post(`/api/v1/lots/${lot2.id}/bids`, { amount: lot2.starting_bid_cents / 100, max_amount: '0', kind: 'prebid' })).status, 201);
});

test('páginas de referencia del portal responden y los alias antiguos redirigen', async () => {
  const c = client(base); await c.login('basic@copart.test');
  for (const p of ['/sales-list', '/salesListResult', '/watchList', '/savedsearch', '/vehicle-alerts', '/auctions', '/auctions/calendar', '/dashboard']) assert.equal((await c.get(p)).status, 200, p);
  for (const [from, to] of [['/vehicleFinder', '/vehicle-finder'], ['/todaysAuction', '/auctions'], ['/auctionCalendar', '/auctions/calendar']]) {
    const r = await c.get(from); assert.equal(r.status, 302, from); assert.equal(r.headers.get('location'), to);
  }
  const cal = await c.get('/auctions/calendar');
  assert.match(cal.body, /Subastas todos los martes y jueves/);
});
