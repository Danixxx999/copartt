'use strict';
/**
 * Control del propietario y área del miembro:
 * alta de usuarios con varios roles, suplantación auditada, roles personalizados (RBAC editable),
 * vehículos creados por el admin con Buy It Now, compra inmediata concurrente, contraofertas,
 * CMS (páginas y banners) y todas las pantallas del área del miembro.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, shutdown, client, db, png } = require('./helpers');

let base;
before(async () => { base = await boot(); });
after(shutdown);
const admin = async () => { const c = client(base); await c.login('admin@copart.test'); return c; };

test('el admin crea un usuario con varios roles y plan; el área del miembro carga completa', async () => {
  const a = await admin();
  const r = await a.post('/api/v1/admin/users', { first_name: 'Olga', last_name: 'Owner', email: 'olga@example.test', password: 'Temporal2026!', roles: ['buyer', 'seller'], plan: 'premium', verification_status: 'approved', account_type: 'business', company_name: 'Olga Motors S.L.' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal((await a.post('/api/v1/admin/users', { first_name: 'Olga', last_name: 'Dup', email: 'OLGA@example.test', password: 'Temporal2026!', roles: ['buyer'] })).status, 409);
  assert.equal((await a.post('/api/v1/admin/users', { first_name: 'X', last_name: 'Y', email: 'x@example.test', password: 'Temporal2026!', roles: ['nope'] })).status, 400);
  const o = client(base); await o.login('olga@example.test', 'buyer', 'Temporal2026!');
  const me = (await o.get('/api/v1/auth/me')).body.user;
  assert.deepEqual([...me.roles].sort(), ['buyer', 'seller']);
  assert.equal(me.plan.code, 'premium');
  assert.ok(me.seller && me.seller.approved, 'seller account created and approved');
  for (const p of ['/dashboard', '/dashboard/bids', '/dashboard/bids?tab=won', '/dashboard/bids?tab=lost', '/dashboard/bids?tab=counter', '/dashboard/watchlist', '/dashboard/recently-viewed', '/dashboard/saved-searches', '/dashboard/alerts', '/dashboard/payments', '/dashboard/payments?tab=history', '/dashboard/invoices', '/dashboard/purchases', '/dashboard/profile', '/dashboard/membership', '/dashboard/buying-power', '/dashboard/documents', '/dashboard/notifications', '/seller', '/seller/sales', '/seller/vehicles/new']) {
    const res = await o.get(p); assert.equal(res.status, 200, p);
  }
  const dash = await o.get('/dashboard');
  assert.match(dash.body, /Poder adquisitivo disponible/); assert.match(dash.body, /Lista de tareas/);
});

test('suplantación: el admin entra como otro usuario, queda auditado y vuelve a su cuenta', async () => {
  const a = await admin();
  const basic = await db.one("SELECT id FROM users WHERE email='basic@copart.test'");
  const adminRow = await db.one("SELECT id FROM users WHERE email='admin@copart.test'");
  const start = await a.post(`/api/v1/admin/users/${basic.id}/impersonate`);
  assert.equal(start.status, 200, JSON.stringify(start.body));
  let me = (await a.get('/api/v1/auth/me')).body;
  assert.equal(me.user.email, 'basic@copart.test');
  assert.equal(me.impersonator.email, 'admin@copart.test');
  assert.match((await a.get('/dashboard')).body, /Estás actuando como/);
  assert.equal((await a.post('/api/v1/auth/change-password', { current_password: 'x', new_password: 'OtraClave2026' })).status, 403, 'password change blocked while impersonating');
  assert.equal((await a.post(`/api/v1/admin/users/${basic.id}/impersonate`)).status, 403, 'impersonated buyer has no admin permissions');
  const stop = await a.post('/api/v1/auth/impersonation/stop');
  assert.equal(stop.status, 200); assert.equal(stop.body.redirect, `/admin/users/${basic.id}`);
  me = (await a.get('/api/v1/auth/me')).body;
  assert.equal(me.user.email, 'admin@copart.test'); assert.equal(me.impersonator, null);
  const log = await db.many("SELECT action FROM audit_logs WHERE actor_id=$1 AND action LIKE 'user.impersonate%' ORDER BY id", [adminRow.id]);
  assert.deepEqual(log.map(l => l.action), ['user.impersonate.start', 'user.impersonate.stop']);
  // No se puede suplantar a otro administrador, ni hacerlo sin el permiso
  const a2 = await db.one("INSERT INTO users(email,password_hash,registration_step) VALUES ('admin2@example.test','x','complete') RETURNING id");
  await db.query("INSERT INTO profiles(user_id,first_name,last_name) VALUES ($1,'Ad','Two')", [a2.id]);
  await db.query("INSERT INTO user_roles(user_id, role_id) SELECT $1, id FROM roles WHERE code='admin'", [a2.id]);
  assert.equal((await a.post(`/api/v1/admin/users/${a2.id}/impersonate`)).status, 403);
  const fin = client(base); await fin.login('finanzas@copart.test');
  assert.equal((await fin.post(`/api/v1/admin/users/${basic.id}/impersonate`)).status, 403);
});

test('roles personalizados: permisos editables, protección anti-bloqueo y acceso por permiso', async () => {
  const a = await admin();
  const r = await a.post('/api/v1/admin/roles', { code: 'content_editor', name: 'Content editor', permissions: ['content.manage'] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const u = await a.post('/api/v1/admin/users', { first_name: 'Eva', last_name: 'Editora', email: 'eva@example.test', password: 'Temporal2026!', roles: ['content_editor'] });
  assert.equal(u.status, 201);
  const eva = client(base); const login = await eva.login('eva@example.test', 'buyer', 'Temporal2026!');
  assert.equal(login.body.redirect, '/admin');
  assert.equal((await eva.get('/admin')).status, 200);
  assert.equal((await eva.get('/admin/content')).status, 200);
  assert.equal((await eva.get('/admin/users')).status, 403);
  assert.equal((await eva.post('/api/v1/admin/pages', { slug: 'promo', title: 'Promo', body_html: '<p>Hola</p>', published: true })).status, 201);
  const adminRole = await db.one("SELECT id FROM roles WHERE code='admin'");
  assert.equal((await a.patch(`/api/v1/admin/roles/${adminRole.id}`, { name: 'Administrator', permissions: ['content.manage'] })).status, 409, 'admin keeps users.manage');
  const role = await db.one("SELECT id FROM roles WHERE code='content_editor'");
  assert.equal((await a.del(`/api/v1/admin/roles/${role.id}`)).status, 409, 'role in use');
  assert.equal((await a.del(`/api/v1/admin/roles/${adminRole.id}`)).status, 409, 'system role');
  assert.equal((await a.get('/admin/roles')).status, 200);
});

test('Buy It Now: compra inmediata, un único comprador aunque pulsen a la vez', async () => {
  const lot = await db.one("SELECT id, lot_number, buy_now_cents FROM auction_lots WHERE buy_now_cents IS NOT NULL AND status='prebidding' AND COALESCE(current_bid_cents,0) < buy_now_cents AND buy_now_cents <= 500000 ORDER BY buy_now_cents LIMIT 1");
  assert.ok(lot, 'seed has Buy It Now lots');
  const p1 = client(base); await p1.login('premium@copart.test');
  const p2 = client(base); await p2.login('premium2@copart.test');
  const page = await p1.get(`/lot/${lot.lot_number}`);
  assert.match(page.body, /Precio de compra inmediata/);
  const [r1, r2] = await Promise.all([p1.post(`/api/v1/lots/${lot.id}/buy-now`), p2.post(`/api/v1/lots/${lot.id}/buy-now`)]);
  const ok = [r1, r2].filter(r => r.status === 201), fail = [r1, r2].filter(r => r.status === 409);
  assert.equal(ok.length, 1, JSON.stringify([r1.body, r2.body])); assert.equal(fail.length, 1);
  const l = await db.one('SELECT status, sold_via, current_bid_cents FROM auction_lots WHERE id=$1', [lot.id]);
  assert.equal(l.status, 'awarded'); assert.equal(l.sold_via, 'buy_now'); assert.equal(l.current_bid_cents, lot.buy_now_cents);
  const orders = await db.many('SELECT hammer_cents FROM sale_orders WHERE lot_id=$1', [lot.id]);
  assert.equal(orders.length, 1); assert.equal(orders[0].hammer_cents, lot.buy_now_cents);
  const guest = client(base); await guest.login('guest@copart.test');
  const other = await db.one("SELECT id FROM auction_lots WHERE buy_now_cents IS NOT NULL AND status='prebidding' LIMIT 1");
  assert.equal((await guest.post(`/api/v1/lots/${other.id}/buy-now`)).status, 403, 'guest cannot buy');
  assert.match((await (ok[0] === r1 ? p1 : p2).get('/dashboard/bids?tab=won')).body, /Buy It Now/);
});

test('contraoferta: el vendedor propone precio, el comprador acepta y se factura a ese precio', async () => {
  const lot = await db.one(`SELECT l.id, l.current_bid_cents, l.reserve_cents, su.email AS seller_email, bu.email AS buyer_email FROM auction_lots l JOIN vehicles v ON v.id=l.vehicle_id JOIN sellers s ON s.id=v.seller_id
                             JOIN users su ON su.id=s.user_id JOIN users bu ON bu.id=l.leader_user_id WHERE l.status='pending_seller_approval' LIMIT 1`);
  assert.ok(lot);
  const seller = client(base); await seller.login(lot.seller_email, 'seller');
  const buyer = client(base); await buyer.login(lot.buyer_email);
  assert.equal((await seller.post(`/api/v1/seller/lots/${lot.id}/counter`, { amount: lot.current_bid_cents / 100 })).status, 400, 'must be above high bid');
  assert.equal((await seller.post(`/api/v1/seller/lots/${lot.id}/counter`, { amount: lot.reserve_cents / 100 + 100 })).status, 400, 'cannot exceed reserve');
  const amount = Math.round((lot.current_bid_cents + lot.reserve_cents) / 2 / 100);
  const c = await seller.post(`/api/v1/seller/lots/${lot.id}/counter`, { amount });
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal((await seller.post(`/api/v1/seller/lots/${lot.id}/counter`, { amount: amount + 10 })).status, 409, 'only one pending counter');
  const tab = await buyer.get('/dashboard/bids?tab=counter');
  assert.match(tab.body, /counter-response/);
  const stranger = client(base); await stranger.login('premium2@copart.test');
  if (lot.buyer_email !== 'premium2@copart.test') assert.equal((await stranger.post(`/api/v1/lots/${lot.id}/counter-response`, { accept: true })).status, 403);
  const acc = await buyer.post(`/api/v1/lots/${lot.id}/counter-response`, { accept: true });
  assert.equal(acc.status, 200, JSON.stringify(acc.body));
  const l = await db.one('SELECT status, sold_via, current_bid_cents FROM auction_lots WHERE id=$1', [lot.id]);
  assert.equal(l.status, 'awarded'); assert.equal(l.sold_via, 'counter_offer'); assert.equal(l.current_bid_cents, amount * 100);
  assert.equal((await db.one('SELECT hammer_cents FROM sale_orders WHERE lot_id=$1', [lot.id])).hammer_cents, amount * 100);
});

test('el admin publica un vehículo para un vendedor con fotos y Buy It Now; CMS y gestión de cuentas', async () => {
  const a = await admin();
  const seller = await db.one("SELECT s.id FROM sellers s JOIN users u ON u.id=s.user_id WHERE u.email='vendedor@copart.test'");
  const mk = await db.one("SELECT mk.id AS make_id, md.id AS model_id FROM makes mk JOIN models md ON md.make_id=mk.id WHERE mk.slug='seat' LIMIT 1");
  const v = await a.post('/api/v1/admin/vehicles', { seller_id: seller.id, make_id: mk.make_id, model_id: mk.model_id, vehicle_type: 'automobile', primary_damage: 'front', location: 'MAD', year: 2021, vin: 'ADMN1234567890123', odometer_km: 42000, fuel: 'petrol', transmission: 'manual', condition: 'used', document_type: 'Permiso de circulación', has_keys: true, runs_drives: true, estimated_value: 15000 });
  assert.equal(v.status, 201, JSON.stringify(v.body));
  assert.equal((await a.get(`/admin/vehicles/${v.body.id}/edit`)).status, 200);
  assert.equal((await a.get('/admin/vehicles/new')).status, 200);
  assert.equal((await a.upload(`/api/v1/admin/vehicles/${v.body.id}/images`, {}, [['images', { buffer: png(), type: 'image/png', name: 'foto.png' }]])).status, 201);
  const ev = await db.one("SELECT id FROM auction_events WHERE status='scheduled' ORDER BY starts_at LIMIT 1");
  assert.equal((await a.post(`/api/v1/admin/vehicles/${v.body.id}/review`, { approve: true, event_id: ev.id, starting_bid: 1000, reserve: 4000, buy_now: 3000 })).status, 400, 'BIN must exceed reserve');
  const ap = await a.post(`/api/v1/admin/vehicles/${v.body.id}/review`, { approve: true, event_id: ev.id, starting_bid: 1000, reserve: 4000, buy_now: 9000 });
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  const pub = await client(base).get(`/api/v1/lots/${ap.body.lot_number}`);
  assert.equal(pub.status, 200); assert.equal(pub.body.lot?.buy_now_cents ?? pub.body.buy_now_cents, 900000);

  // CMS
  assert.equal((await a.post('/api/v1/admin/pages', { slug: 'oferta-noviembre', title: 'Oferta de noviembre', body_html: '<h2>Hola</h2><script>alert(1)</script>', published: true })).status, 201);
  const pg = await client(base).get('/page/oferta-noviembre');
  assert.equal(pg.status, 200); assert.doesNotMatch(pg.body, /alert\(1\)/);
  assert.equal((await a.post('/api/v1/admin/banners', { placement: 'home', text: 'Subasta especial del propietario', link_text: 'Ver', link_url: '/vehicles', active: true })).status, 201);
  assert.match((await client(base).get('/')).body, /Subasta especial del propietario/);
  assert.equal((await a.del('/api/v1/admin/pages/terms')).status, 409);
  assert.equal((await a.del('/api/v1/admin/pages/oferta-noviembre')).status, 200);

  // Perfil, contraseña y borrado
  const nu = await a.post('/api/v1/admin/users', { first_name: 'Temp', last_name: 'User', email: 'temp@example.test', password: 'Temporal2026!', roles: ['buyer'], plan: 'guest' });
  assert.equal((await a.patch(`/api/v1/admin/users/${nu.body.id}/profile`, { email: 'temp2@example.test', first_name: 'Tempo', last_name: 'Usuario', phone: '600111222', account_type: 'individual' })).status, 200);
  assert.equal((await a.post(`/api/v1/admin/users/${nu.body.id}/password`, { password: 'NuevaClave2026!' })).status, 200);
  const t = client(base); await t.login('temp2@example.test', 'buyer', 'NuevaClave2026!');
  assert.equal((await t.get('/api/v1/auth/me')).body.user.first_name, 'Tempo');
  const basic = await db.one("SELECT id FROM users WHERE email='basic@copart.test'");
  assert.equal((await a.del(`/api/v1/admin/users/${basic.id}`)).status, 409, 'users with history cannot be deleted');
  assert.equal((await a.del(`/api/v1/admin/users/${nu.body.id}`)).status, 200);
  assert.equal(await db.one('SELECT 1 FROM users WHERE id=$1', [nu.body.id]), null);
  for (const p of ['/admin', '/admin/users', `/admin/users/${basic.id}`, '/admin/content', '/admin/roles']) assert.equal((await a.get(p)).status, 200, p);
});
