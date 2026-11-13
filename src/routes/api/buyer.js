'use strict';
const crypto = require('node:crypto');
const express = require('express');
const db = require('../../db');
const { z, parse, bool } = require('../../lib/validate');
const { requireAuth } = require('../../lib/auth');
const { rateLimit } = require('../../lib/security');
const { notFound, forbidden, conflict, bad } = require('../../lib/errors');
const { placeBid, buyNow } = require('../../services/bidding');
const engine = require('../../services/auctionEngine');
const orders = require('../../services/orders');
const uploads = require('../../lib/uploads');
const { audit } = require('../../lib/audit');
const router = express.Router();

// ── Pujas (también disponibles por WebSocket; ambas vías usan el mismo servicio) ──
router.post('/lots/:id/bids', requireAuth, rateLimit({ windowMs: 60_000, max: 40, scope: 'bid', key: r => String(r.user?.id) }), async (req, res) => {
  const d = parse(z.object({
    amount: z.coerce.number().positive('Enter a bid amount').max(10_000_000),
    // Oferta máxima opcional (formulario "Oferta inicial / Oferta máxima"): el proxy puja hasta este tope.
    max_amount: z.preprocess(v => (v === '' || v === null || v === undefined ? undefined : v), z.coerce.number().min(0).max(10_000_000).optional()),
    idempotency_key: z.string().max(80).optional(), kind: z.enum(['prebid', 'live']).default('prebid'),
  }), req.body);
  const r = await placeBid({ user: req.user, lotId: Number(req.params.id), maxCents: Math.round(Math.max(d.amount, d.max_amount || 0) * 100), kind: d.kind, idempotencyKey: d.idempotency_key || req.get('Idempotency-Key') || null, ip: req.ip });
  const full = await db.one('SELECT * FROM auction_lots WHERE id=$1', [r.lot.id]);
  engine.broadcastLot(full);
  res.status(r.replay ? 200 : 201).json({ ok: true, message: r.message, leading: r.leading, your_max_cents: r.your_max, lot: r.lot });
});
// Buy It Now (compra inmediata a precio fijo)
router.post('/lots/:id/buy-now', requireAuth, rateLimit({ windowMs: 60_000, max: 10, scope: 'buynow', key: r => String(r.user?.id) }), async (req, res) => {
  const r = await buyNow({ user: req.user, lotId: Number(req.params.id), ip: req.ip });
  engine.broadcastLot(r.lot);
  res.status(201).json({ ok: true, message: `Purchased! Order ${r.order.order_number} created. Pay the invoice from My Purchases.`, order_id: r.order.id, redirect: `/dashboard/purchases/${r.order.id}` });
});
// Respuesta del comprador a una contraoferta del vendedor
router.post('/lots/:id/counter-response', requireAuth, async (req, res) => {
  const { accept } = parse(z.object({ accept: bool() }), req.body);
  const lot = await engine.counterResponse({ user: req.user, lotId: Number(req.params.id), accept, ip: req.ip });
  engine.broadcastLot(lot);
  const order = accept ? await db.one('SELECT id FROM sale_orders WHERE lot_id=$1', [lot.id]) : null;
  res.json({ ok: true, message: accept ? 'Counter offer accepted. The vehicle is yours – an invoice has been issued.' : 'Counter offer declined.', redirect: order ? `/dashboard/purchases/${order.id}` : undefined, reload: !order });
});

// ── Favoritos ──
router.post('/watchlist/:lotId', requireAuth, async (req, res) => {
  const lotId = Number(req.params.lotId);
  if (!await db.one('SELECT 1 FROM auction_lots WHERE id=$1', [lotId])) throw notFound('Lot not found.');
  const del = await db.one('DELETE FROM watchlist WHERE user_id=$1 AND lot_id=$2 RETURNING lot_id', [req.user.id, lotId]);
  if (!del) await db.query('INSERT INTO watchlist(user_id, lot_id) VALUES ($1,$2)', [req.user.id, lotId]);
  res.json({ ok: true, watching: !del, reload: !!req.body?.reload, message: del ? 'Removed from your Watchlist.' : 'Added to your Watchlist.' });
});
router.get('/watchlist', requireAuth, async (req, res) => res.json({ items: await db.many('SELECT lot_id FROM watchlist WHERE user_id=$1', [req.user.id]) }));

// ── Búsquedas guardadas ──
router.post('/saved-searches', requireAuth, async (req, res) => {
  const d = parse(z.object({ name: z.string().trim().min(2, 'Name your search').max(80), query: z.string().max(600) }), req.body);
  const n = await db.one('SELECT COUNT(*)::int n FROM saved_searches WHERE user_id=$1', [req.user.id]);
  if (n.n >= 25) throw conflict('You can save up to 25 searches.');
  const q = new URLSearchParams(d.query); q.delete('page');
  await db.query('INSERT INTO saved_searches(user_id, name, query) VALUES ($1,$2,$3)', [req.user.id, d.name, q.toString()]);
  res.status(201).json({ ok: true, message: 'Search saved. Find it in your dashboard.' });
});
router.delete('/saved-searches/:id', requireAuth, async (req, res) => {
  const r = await db.one('DELETE FROM saved_searches WHERE id=$1 AND user_id=$2 RETURNING id', [Number(req.params.id), req.user.id]);
  if (!r) throw notFound();
  res.json({ ok: true, message: 'Saved search deleted.', reload: true });
});

// ── Notificaciones ──
router.post('/notifications/read-all', requireAuth, async (req, res) => { await db.query('UPDATE notifications SET read_at=now() WHERE user_id=$1 AND read_at IS NULL', [req.user.id]); res.json({ ok: true, reload: true }); });
router.get('/notifications', requireAuth, async (req, res) => res.json({ items: await db.many('SELECT * FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 50', [req.user.id]) }));

// ── Perfil ──
router.patch('/profile', requireAuth, async (req, res) => {
  const d = parse(z.object({ first_name: z.string().trim().min(2).max(60), last_name: z.string().trim().min(2).max(80), phone: z.string().trim().regex(/^\d{6,15}$/, 'Numbers only'), company_name: z.string().trim().max(120).optional(), address: z.string().trim().max(200).optional(), city: z.string().trim().max(80).optional(), postal_code: z.string().trim().max(10).optional(), language: z.enum(['en', 'es']).default('en') }), req.body);
  await db.query('UPDATE profiles SET first_name=$2, last_name=$3, phone=$4, company_name=$5, address=$6, city=$7, postal_code=$8, language=$9 WHERE user_id=$1', [req.user.id, d.first_name, d.last_name, d.phone, d.company_name || null, d.address || '', d.city || '', d.postal_code || '', d.language]);
  res.cookie('ap_lang', d.language, { sameSite: 'lax', path: '/', maxAge: 365 * 86400_000 });
  res.json({ ok: true, message: 'Profile updated.' });
});

// ── Pagos demo ──
router.post('/invoices/:id/payments/demo', requireAuth, uploads.memory(8).single('proof'), async (req, res) => {
  const d = parse(z.object({ method: z.enum(['bank_transfer', 'card_demo']), scope: z.enum(['vehicle', 'fees', 'full']).default('full'), reference: z.string().trim().max(60).optional(), card_number: z.string().optional() }), req.body);
  if (d.method === 'card_demo') {
    const digits = String(d.card_number || '').replace(/\s/g, '');
    if (digits !== '4242424242424242') throw bad('Sandbox only: use the test card 4242 4242 4242 4242. Real cards are never accepted.');
  }
  const proof = req.file ? uploads.store(req.file, 'document') : null;
  const p = await orders.submitPayment({ user: req.user, invoiceId: Number(req.params.id), method: d.method, scope: d.scope, reference: d.reference, proof, ip: req.ip });
  res.status(201).json({ ok: true, payment_id: p.id, status: p.status, reload: true, message: p.status === 'approved' ? 'Sandbox payment approved (no real charge).' : 'Transfer receipt submitted. Finance will review it.' });
});

// ── Transporte de una compra ──
router.post('/orders/:id/transport-quotes', requireAuth, async (req, res) => {
  const d = parse(z.object({ service: z.enum(['national', 'international', 'express']), address: z.string().trim().min(5, 'Enter the delivery address').max(200), city: z.string().trim().min(2, 'Enter the city').max(80), postal_code: z.string().trim().regex(/^\d{5}$/, 'Enter a 5-digit postal code'), country: z.string().trim().max(2).default('ES') }), req.body);
  const o = await db.one('SELECT o.*, v.location_id FROM sale_orders o JOIN auction_lots l ON l.id=o.lot_id JOIN vehicles v ON v.id=l.vehicle_id WHERE o.id=$1', [Number(req.params.id)]);
  if (!o) throw notFound();
  if (o.buyer_id !== req.user.id) throw forbidden();
  if (['completed', 'cancelled', 'in_transport'].includes(o.status)) throw conflict('Transport cannot be requested for this order.');
  const loc = await db.one('SELECT * FROM locations WHERE id=$1', [o.location_id]);
  const q = await orders.quoteTransport({ originLocation: loc, postalCode: d.postal_code, service: d.service });
  const row = await db.one(`INSERT INTO transport_quotes(user_id, order_id, origin_location_id, service, destination_address, destination_city, destination_postal_code, destination_country, distance_km, price_cents, expires_at)
                            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now() + interval '5 days') RETURNING id`, [req.user.id, o.id, loc.id, d.service, d.address, d.city, d.postal_code, d.country, q.distance_km, q.price_cents]);
  res.status(201).json({ ok: true, quote_id: row.id, ...q, reload: true, message: 'Quote created. Review and accept it below.' });
});
router.post('/transport/quotes/:id/accept', requireAuth, async (req, res) => {
  const out = await db.tx(async c => {
    const q = await c.one('SELECT * FROM transport_quotes WHERE id=$1 FOR UPDATE', [Number(req.params.id)]);
    if (!q) throw notFound();
    if (q.user_id !== req.user.id) throw forbidden();
    if (q.status !== 'quoted' || new Date(q.expires_at) < new Date()) throw conflict('This quote is no longer valid.');
    const o = await c.one('SELECT * FROM sale_orders WHERE id=$1 FOR UPDATE', [q.order_id]);
    if (await c.one("SELECT 1 FROM transport_orders WHERE order_id=$1 AND status<>'cancelled'", [o.id])) throw conflict('Transport is already arranged for this order.');
    await c.query("UPDATE transport_quotes SET status='accepted' WHERE id=$1", [q.id]);
    await c.query("UPDATE transport_quotes SET status='cancelled' WHERE order_id=$1 AND id<>$2 AND status='quoted'", [o.id, q.id]);
    const tracking = `TR-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const t = await c.one('INSERT INTO transport_orders(quote_id, order_id, tracking_code) VALUES ($1,$2,$3) RETURNING id', [q.id, o.id, tracking]);
    await c.query("INSERT INTO transport_events(transport_order_id, status, note, actor_id) VALUES ($1,'requested','Quote accepted by buyer',$2)", [t.id, req.user.id]);
    const tax = Math.round(q.price_cents * 0.21);
    const inv = await orders.createInvoice(c, { userId: req.user.id, orderId: o.id, kind: 'transport', dueDays: 5, items: [{ category: 'transport', description: `Transport ${q.service} · ${q.distance_km} km · ${tracking}`, amount_cents: q.price_cents, tax_rate: 21, tax_cents: tax }] });
    await c.query("UPDATE sale_orders SET delivery_method='transport' WHERE id=$1", [o.id]);
    await audit(c, { actorId: req.user.id, action: 'transport.accept', entity: 'transport_order', entityId: t.id, ip: req.ip });
    return { tracking, invoice: inv };
  });
  res.json({ ok: true, reload: true, message: `Transport ${out.tracking} requested. Pay invoice ${out.invoice.invoice_number} to confirm it.` });
});

module.exports = router;
