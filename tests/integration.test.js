'use strict';
/**
 * Integración API + PostgreSQL (BD copart_test, se reinicia al empezar).
 * Cubre los criterios de aceptación: RBAC, registro→membresía→documentos, vendedor→admin→publicación,
 * pujas concurrentes con un único ganador, adjudicación, factura, pago demo, revisión de Finanzas,
 * PIN de retiro, alertas, búsquedas guardadas y difusión por WebSocket.
 */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { io: ioc } = require('socket.io-client');
const { boot, shutdown, client, db, png, pdf } = require('./helpers');
const engine = require('../src/services/auctionEngine');

let base;
before(async () => { base = await boot(); });
after(shutdown);

const lotsOf = async (q) => (await client(base).get('/api/v1/lots?' + q)).body;

test('páginas públicas y health responden 200', async () => {
  const c = client(base);
  for (const p of ['/', '/vehicle-finder', '/vehicles', '/vehicle-alerts', '/auctions/calendar', '/auctions', '/locations', '/transport', '/login', '/register', '/how-it-works', '/membership', '/faq', '/api/docs']) {
    const r = await c.get(p); assert.equal(r.status, 200, p);
  }
  assert.equal((await c.get('/health')).body.ok, true);
  assert.equal((await c.get('/no-existe')).status, 404);
});

test('RBAC y seguridad: visitante, guest, basic, CSRF, panel admin', async () => {
  const { items: [lot] } = await lotsOf('per_page=1&sort=bid_asc');
  const anon = client(base);
  assert.equal((await anon.post(`/api/v1/lots/${lot.id}/bids`, { amount: 99999 })).status, 401);
  // Sin token CSRF → 403
  const noCsrf = await fetch(`${base}/api/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noCsrf.status, 403);

  const guest = client(base); await guest.login('guest@copart.test');
  const g = await guest.post(`/api/v1/lots/${lot.id}/bids`, { amount: 99999 });
  assert.equal(g.status, 403); assert.equal(g.body.code, 'GUEST');
  assert.equal((await guest.post(`/api/v1/watchlist/${lot.id}`)).body.watching !== undefined, true); // Guest sí puede seguir lotes

  const pending = client(base); await pending.login('pendiente@copart.test');
  assert.equal((await pending.post(`/api/v1/lots/${lot.id}/bids`, { amount: 99999 })).body.code, 'NOT_VERIFIED');

  const basic = client(base); await basic.login('basic@copart.test');
  const over = await basic.post(`/api/v1/lots/${lot.id}/bids`, { amount: 5001 });
  assert.equal(over.status, 403); assert.equal(over.body.code, 'PLAN_LIMIT');
  assert.equal((await basic.get('/api/v1/reports/users.csv')).status, 403);
  assert.equal((await basic.patch('/api/v1/admin/users/1', { status: 'suspended' })).status, 403);
  assert.equal((await basic.get('/admin')).status, 403);

  const fin = client(base); await fin.login('finanzas@copart.test');
  assert.equal((await fin.post('/api/v1/admin/events', { name: 'x', starts_at: '2030-01-01T11:00' })).status, 403);
  assert.equal((await fin.get('/finance')).status, 200);
  assert.equal((await fin.get('/ops')).status, 403);
});

test('registro → membresía Basic (pago sandbox) → documentos → aprobación → puede pujar; datos persisten', async () => {
  const c = client(base);
  const reg = await c.post('/api/v1/auth/register', { account_type: 'individual', first_name: 'Nuevo', last_name: 'Comprador', email: 'nuevo@example.test', phone: '600123123', password: 'ClaveSegura2026', terms: true });
  assert.equal(reg.status, 201, JSON.stringify(reg.body));
  assert.equal((await c.post('/api/v1/auth/register', { account_type: 'individual', first_name: 'Otro', last_name: 'Mas', email: 'NUEVO@example.test', phone: '600123123', password: 'ClaveSegura2026', terms: true })).status, 409);
  const bad = await c.post('/api/v1/auth/register', { first_name: 'A', last_name: '', email: 'x', phone: 'abc', password: '1', terms: false });
  assert.equal(bad.status, 400); assert.ok(bad.body.fields);

  const choose = await c.post('/api/v1/memberships/choose', { plan: 'basic', from: 'register' });
  assert.ok(choose.body.invoice_id);
  assert.equal((await c.post(`/api/v1/invoices/${choose.body.invoice_id}/payments/demo`, { method: 'card_demo', scope: 'full', card_number: '4000 0000 0000 0002' })).status, 400); // solo tarjeta de prueba
  const pay = await c.post(`/api/v1/invoices/${choose.body.invoice_id}/payments/demo`, { method: 'card_demo', scope: 'full', card_number: '4242424242424242' });
  assert.equal(pay.body.status, 'approved');
  const me = (await c.get('/api/v1/auth/me')).body.user;
  assert.equal(me.plan.code, 'basic'); assert.equal(me.registration_step, 'documents');

  const up = await c.upload('/api/v1/documents', { doc_type: 'id_card' }, [['file', { buffer: pdf(), type: 'application/pdf', name: 'dni.pdf' }]]);
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const fake = await c.upload('/api/v1/documents', { doc_type: 'id_card' }, [['file', { buffer: Buffer.from('MZ not a pdf really'), type: 'application/pdf', name: 'virus.pdf' }]]);
  assert.equal(fake.status, 400); // tipo real verificado por firma

  const admin = client(base); await admin.login('admin@copart.test');
  const doc = await db.one("SELECT id FROM verification_documents WHERE user_id=$1 AND status='pending'", [me.id]);
  assert.equal((await admin.post(`/api/v1/admin/documents/${doc.id}/review`, { approve: true })).status, 200);

  const { items: [lot] } = await lotsOf('per_page=1&sort=bid_asc');
  const bid = await c.post(`/api/v1/lots/${lot.id}/bids`, { amount: Math.ceil((lot.current_bid_cents ? lot.current_bid_cents + 2500 : lot.starting_bid_cents) / 100) });
  assert.equal(bid.status, 201, JSON.stringify(bid.body));
  // Persistencia tras "refresh": nueva sesión ve el mismo estado
  const again = client(base); await again.login('nuevo@example.test', 'buyer', 'ClaveSegura2026');
  assert.equal((await again.get('/api/v1/auth/me')).body.user.verification_status, 'approved');
});

test('vendedor crea y edita lote, admin aprueba, aparece en el buscador público con filtros', async () => {
  const seller = client(base); await seller.login('vendedor@copart.test', 'seller');
  const ids = await db.one("SELECT mk.id AS make_id, md.id AS model_id FROM makes mk JOIN models md ON md.make_id=mk.id WHERE mk.slug='tesla' AND md.name='Model 3'");
  const data = { ...ids, vehicle_type: 'automobile', primary_damage: 'front', location: 'VLC', year: 2022, vin: 'DEMTEST1234567890', odometer_km: 15000, fuel: 'electric', transmission: 'automatic', has_keys: true, runs_drives: false, condition: 'salvage', document_type: 'Baja temporal', estimated_value: 18000 };
  const created = await seller.post('/api/v1/seller/vehicles', data);
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const id = created.body.id;
  assert.equal((await seller.patch(`/api/v1/seller/vehicles/${id}`, { ...data, odometer_km: 16000, trim: 'Long Range' })).status, 200);
  assert.equal((await seller.post(`/api/v1/seller/vehicles/${id}/submit`)).status, 400); // sin fotos
  const img = await seller.upload(`/api/v1/seller/vehicles/${id}/images`, {}, [['images', { buffer: png(), type: 'image/png', name: 'front.png' }]]);
  assert.equal(img.status, 201, JSON.stringify(img.body));
  assert.equal((await seller.post(`/api/v1/seller/vehicles/${id}/submit`)).status, 200);
  assert.equal((await seller.patch(`/api/v1/seller/vehicles/${id}`, data)).status, 409); // ya no editable

  // Alerta pública que debe coincidir al publicar
  const visitor = client(base);
  const alert = await visitor.post('/api/v1/alerts', { make_id: ids.make_id, model_id: ids.model_id, year_from: 2020, year_to: 2026, frequency: 'instant', first_name: 'Ana', last_name: 'Alerta', email: 'alerta@example.test', consent: true });
  assert.equal(alert.status, 201, JSON.stringify(alert.body));

  const admin = client(base); await admin.login('admin@copart.test');
  const ev = await db.one("SELECT id FROM auction_events WHERE status='scheduled' ORDER BY starts_at LIMIT 1");
  const ap = await admin.post(`/api/v1/admin/vehicles/${id}/review`, { approve: true, event_id: ev.id, starting_bid: 1500, reserve: 4000 });
  assert.equal(ap.status, 200, JSON.stringify(ap.body));
  const found = await lotsOf('make=tesla&condition=salvage&location=VLC&year_from=2022');
  assert.ok(found.items.some(l => l.lot_number === ap.body.lot_number));
  assert.ok(found.items.every(l => l.vin.endsWith('******'))); // VIN mascarado en público
  const mail = await db.one("SELECT COUNT(*)::int n FROM email_outbox WHERE to_email='alerta@example.test' AND subject LIKE 'Vehicle alert:%'");
  assert.equal(mail.n, 1);
  // Cancelar alerta
  const token = (await db.one("SELECT manage_token FROM vehicle_alerts WHERE email='alerta@example.test'")).manage_token;
  assert.equal((await visitor.post(`/api/v1/alerts/${token}/cancel`)).status, 200);
  assert.equal((await visitor.post(`/api/v1/alerts/${token}/cancel`)).status, 404);
});

test('concurrencia: 2 compradores pujan a la vez; un único líder coherente; idempotencia', async () => {
  const a = client(base); await a.login('premium@copart.test');
  const b = client(base); await b.login('premium2@copart.test');
  const lot = await db.one("SELECT l.* FROM auction_lots l WHERE l.status='prebidding' AND l.bid_count=0 ORDER BY id LIMIT 1");
  const start = lot.starting_bid_cents / 100;
  const amounts = Array.from({ length: 12 }, (_, i) => start + 50 * (i + 1));
  const results = await Promise.all(amounts.flatMap((amt, i) => [a.post(`/api/v1/lots/${lot.id}/bids`, { amount: amt + (i % 3) * 25 }), b.post(`/api/v1/lots/${lot.id}/bids`, { amount: amt + 10 })]));
  assert.ok(results.every(r => [201, 409].includes(r.status)), 'solo 201 o 409 (puja insuficiente), nunca 500');
  const final = await db.one('SELECT * FROM auction_lots WHERE id=$1', [lot.id]);
  const proxies = await db.many('SELECT user_id, max_cents FROM proxy_bids WHERE lot_id=$1 ORDER BY max_cents DESC, updated_at ASC', [lot.id]);
  assert.equal(final.leader_user_id, proxies[0].user_id, 'el líder es quien tiene el máximo más alto');
  assert.ok(final.current_bid_cents <= proxies[0].max_cents, 'el precio nunca supera el máximo del líder');
  assert.ok(final.current_bid_cents >= proxies[1].max_cents, 'el precio cubre al menos el máximo del segundo');
  const rows = await db.one('SELECT COUNT(*)::int n FROM bids WHERE lot_id=$1', [lot.id]);
  assert.equal(rows.n, final.bid_count);
  // Idempotencia: misma clave → mismo resultado, sin nueva fila
  const key = 'retry-key-123';
  const top = Math.ceil(final.current_bid_cents / 100) + 5000;
  const r1 = await a.post(`/api/v1/lots/${lot.id}/bids`, { amount: top, idempotency_key: key });
  const r2 = await a.post(`/api/v1/lots/${lot.id}/bids`, { amount: top, idempotency_key: key });
  assert.equal(r1.status, 201); assert.equal(r2.status, 200);
  assert.equal((await db.one('SELECT COUNT(*)::int n FROM bids WHERE idempotency_key=$1', [key])).n, 1);
});

test('subasta en vivo por WebSocket, cierre por el reloj del servidor, un solo ganador, factura, pago, Finanzas y PIN', async () => {
  const admin = client(base); await admin.login('admin@copart.test');
  const ev = await db.one("SELECT e.id FROM auction_events e WHERE e.status='scheduled' AND e.name LIKE 'Sala demo%'");
  assert.equal((await admin.post(`/api/v1/admin/events/${ev.id}/start`)).status, 200);
  const cur = await db.one('SELECT l.* FROM auction_events e JOIN auction_lots l ON l.id=e.current_lot_id WHERE e.id=$1', [ev.id]);
  assert.equal(cur.status, 'live');

  // Dos navegadores: A puja por WebSocket, B recibe la actualización en tiempo real
  const A = client(base); await A.login('premium@copart.test');
  const B = client(base); await B.login('premium2@copart.test');
  const sockA = ioc(base, { extraHeaders: { cookie: A.cookieHeader() }, transports: ['websocket'] });
  const sockB = ioc(base, { extraHeaders: { cookie: B.cookieHeader() }, transports: ['websocket'] });
  const joined = s => new Promise(ok => s.emit('join', { eventId: ev.id }, ok));
  await Promise.all([new Promise(ok => sockA.on('connect', ok)), new Promise(ok => sockB.on('connect', ok))]);
  const snapB = await joined(sockB); await joined(sockA);
  assert.equal(snapB.current.id, cur.id);
  const updateOnB = new Promise(ok => sockB.on('lot:update', ok));
  const ackA = await new Promise(ok => sockA.emit('bid', { lotId: cur.id, amountCents: snapB.current.min_next_cents, idempotencyKey: 'ws-1' }, ok));
  assert.equal(ackA.ok, true, JSON.stringify(ackA)); assert.equal(ackA.leading, true);
  const upd = await updateOnB;
  assert.equal(upd.current_bid_cents, snapB.current.min_next_cents);
  // B puja por encima (reserva alta: forzamos que se cumpla bajando la reserva antes del cierre)
  const ackB = await new Promise(ok => sockB.emit('bid', { lotId: cur.id, amountCents: upd.min_next_cents + 100000, idempotencyKey: 'ws-2' }, ok));
  assert.equal(ackB.leading, true);
  sockA.close(); sockB.close();
  await db.query('UPDATE auction_lots SET reserve_cents=0, ends_at=now() - interval \'1 second\' WHERE id=$1', [cur.id]);
  await engine.tick(); await engine.tick(); // dos ticks: no debe duplicar
  const closed = await db.one('SELECT * FROM auction_lots WHERE id=$1', [cur.id]);
  assert.equal(closed.status, 'awarded');
  const orders = await db.many('SELECT * FROM sale_orders WHERE lot_id=$1', [cur.id]);
  assert.equal(orders.length, 1, 'exactamente una adjudicación');
  const order = orders[0];
  const winner = await db.one("SELECT id FROM users WHERE email='premium2@copart.test'");
  assert.equal(order.buyer_id, winner.id);
  const next = await db.one('SELECT current_lot_id FROM auction_events WHERE id=$1', [ev.id]);
  assert.notEqual(next.current_lot_id, cur.id, 'la sala pasa al siguiente lote');

  // "Mis compras" + factura + pagos demo
  assert.equal((await B.get(`/dashboard/purchases/${order.id}`)).status, 200);
  assert.equal((await A.get(`/dashboard/purchases/${order.id}`)).status, 404, 'otro comprador no ve la compra');
  const inv = await db.one("SELECT * FROM invoices WHERE order_id=$1 AND kind='purchase'", [order.id]);
  assert.match(inv.invoice_number, /^INV-\d{4}-\d{6}$/);
  assert.equal((await B.post(`/api/v1/invoices/${inv.id}/payments/demo`, { method: 'card_demo', scope: 'vehicle', card_number: '4242424242424242' })).status, 400, 'el vehículo no se paga con tarjeta');
  assert.equal((await B.post(`/api/v1/invoices/${inv.id}/payments/demo`, { method: 'card_demo', scope: 'fees', card_number: '4242424242424242' })).status, 201);
  const tr = await B.upload(`/api/v1/invoices/${inv.id}/payments/demo`, { method: 'bank_transfer', scope: 'vehicle', reference: 'TRF-TEST' }, [['proof', { buffer: pdf(), type: 'application/pdf', name: 'transfer.pdf' }]]);
  assert.equal(tr.status, 201, JSON.stringify(tr.body));
  assert.equal((await db.one('SELECT status FROM sale_orders WHERE id=$1', [order.id])).status, 'payment_review');
  assert.equal((await B.get(`/dashboard/invoices/${inv.id}.pdf`)).headers.get('content-type'), 'application/pdf');

  // Finanzas rechaza sin motivo (400), aprueba con nota
  const fin = client(base); await fin.login('finanzas@copart.test');
  assert.equal((await fin.post(`/api/v1/payments/${tr.body.payment_id}/review`, { approve: false })).status, 400);
  assert.equal((await fin.post(`/api/v1/payments/${tr.body.payment_id}/review`, { approve: true, note: 'OK extracto' })).status, 200);
  const o2 = await db.one('SELECT status FROM sale_orders WHERE id=$1', [order.id]);
  assert.equal(o2.status, 'ready_for_pickup');
  const pass = await db.one('SELECT pin_code FROM pickup_passes WHERE order_id=$1', [order.id]);
  const purchasePage = (await B.get(`/dashboard/purchases/${order.id}`)).body;
  assert.ok(purchasePage.includes(pass.pin_code), 'el comprador ve su PIN');

  // Logística: PIN erróneo → 422; correcto → completado; el personal nunca recibe el PIN en las vistas
  const ops = client(base); await ops.login('logistica@copart.test');
  assert.ok(!(await ops.get('/ops/pickups')).body.includes(pass.pin_code));
  const wrong = pass.pin_code === '000000' ? '111111' : '000000';
  assert.equal((await ops.post('/api/v1/pickup-passes/validate', { order_number: order.order_number, pin: wrong })).status, 422);
  assert.equal((await ops.post('/api/v1/pickup-passes/validate', { order_number: order.order_number, pin: pass.pin_code })).status, 200);
  assert.equal((await db.one('SELECT status FROM sale_orders WHERE id=$1', [order.id])).status, 'completed');
  assert.equal((await ops.post('/api/v1/pickup-passes/validate', { order_number: order.order_number, pin: pass.pin_code })).status, 409, 'no se puede reutilizar');
  const hist = await db.many('SELECT to_status FROM order_status_history WHERE order_id=$1 ORDER BY id', [order.id]);
  assert.deepEqual(hist.map(h => h.to_status), ['pending_payment', 'payment_review', 'paid', 'ready_for_pickup', 'completed']);
});

test('transporte: presupuesto, aceptación, pago, asignación y entrega', async () => {
  const buyer = client(base); await buyer.login('premium@copart.test');
  const o = await db.one("SELECT o.* FROM sale_orders o JOIN users u ON u.id=o.buyer_id WHERE u.email='premium@copart.test' AND o.status='ready_for_pickup' LIMIT 1");
  const q = await buyer.post(`/api/v1/orders/${o.id}/transport-quotes`, { service: 'national', address: 'Calle Demo 2', city: 'Valencia', postal_code: '46001' });
  assert.equal(q.status, 201, JSON.stringify(q.body));
  assert.equal((await buyer.post(`/api/v1/transport/quotes/${q.body.quote_id}/accept`)).status, 200);
  const t = await db.one('SELECT * FROM transport_orders WHERE order_id=$1', [o.id]);
  const ops = client(base); await ops.login('logistica@copart.test');
  assert.equal((await ops.post(`/api/v1/transport-orders/${t.id}`, { status: 'assigned', carrier_name: 'Transportes Demo' })).status, 409, 'no se asigna sin pagar');
  const inv = await db.one("SELECT id FROM invoices WHERE order_id=$1 AND kind='transport'", [o.id]);
  assert.equal((await buyer.post(`/api/v1/invoices/${inv.id}/payments/demo`, { method: 'card_demo', scope: 'full', card_number: '4242424242424242' })).status, 201);
  for (const s of ['assigned', 'picked_up', 'in_transit', 'delivered']) assert.equal((await ops.post(`/api/v1/transport-orders/${t.id}`, { status: s, carrier_name: 'Transportes Demo' })).status, 200, s);
  assert.equal((await db.one('SELECT status FROM sale_orders WHERE id=$1', [o.id])).status, 'completed');
  assert.equal((await client(base).get(`/transport?tracking=${t.tracking_code}`)).status, 200);
});

test('vendedor decide sobre puja bajo reserva; búsquedas guardadas; informes CSV; auditoría', async () => {
  const seller = client(base); await seller.login('vendedor@copart.test', 'seller');
  const lot = await db.one("SELECT l.id FROM auction_lots l JOIN vehicles v ON v.id=l.vehicle_id JOIN sellers s ON s.id=v.seller_id JOIN users u ON u.id=s.user_id WHERE l.status='pending_seller_approval' AND u.email='vendedor@copart.test' LIMIT 1")
    || await db.one("SELECT l.id FROM auction_lots l WHERE l.status='pending_seller_approval' LIMIT 1");
  const other = client(base); await other.login('renting@copart.test', 'seller');
  const owner = await db.one('SELECT u.email FROM auction_lots l JOIN vehicles v ON v.id=l.vehicle_id JOIN sellers s ON s.id=v.seller_id JOIN users u ON u.id=s.user_id WHERE l.id=$1', [lot.id]);
  const [mine, notMine] = owner.email === 'vendedor@copart.test' ? [seller, other] : [other, seller];
  assert.equal((await notMine.post(`/api/v1/seller/lots/${lot.id}/decision`, { accept: true })).status, 403);
  assert.equal((await mine.post(`/api/v1/seller/lots/${lot.id}/decision`, { accept: true })).status, 200);
  assert.equal((await db.many('SELECT id FROM sale_orders WHERE lot_id=$1', [lot.id])).length, 1);

  const buyer = client(base); await buyer.login('basic@copart.test');
  assert.equal((await buyer.post('/api/v1/saved-searches', { name: 'Tesla', query: 'make=tesla&page=3' })).status, 201);
  const saved = await db.one("SELECT * FROM saved_searches WHERE name='Tesla'");
  assert.equal(saved.query, 'make=tesla');
  assert.equal((await buyer.del(`/api/v1/saved-searches/${saved.id}`)).status, 200);

  const admin = client(base); await admin.login('admin@copart.test');
  const csv = await admin.get('/api/v1/reports/sales.csv');
  assert.equal(csv.status, 200); assert.match(csv.body, /order_number/);
  const audits = await db.one("SELECT COUNT(*)::int n FROM audit_logs WHERE action IN ('bid.place','payment.approve','pickup.validated','vehicle.approve')");
  assert.ok(audits.n > 5);
});
