'use strict';
const crypto = require('node:crypto');
const express = require('express');
const db = require('../../db');
const { z, parse, optInt, bool } = require('../../lib/validate');
const { rateLimit } = require('../../lib/security');
const { notFound, bad } = require('../../lib/errors');
const catalog = require('../../services/catalog');
const orders = require('../../services/orders');
const { recentBids } = require('../../realtime/socket');
const { email } = require('../../lib/notify');
const { audit } = require('../../lib/audit');
const router = express.Router();

const lotJson = l => ({ ...l, lot_number: Number(l.lot_number), vin: catalog.maskVin(l.vin), leader_user_id: undefined, reserve_cents: undefined, counter_offer_cents: undefined });

router.get('/makes', async (req, res) => res.json({ items: await catalog.makesWithModels() }));
router.get('/makes/:id/models', async (req, res) => res.json({ items: await db.many('SELECT id, name FROM models WHERE make_id=$1 ORDER BY name', [Number(req.params.id)]) }));
router.get('/vehicle-types', async (req, res) => res.json({ items: await db.many('SELECT code, name FROM vehicle_types ORDER BY name') }));
router.get('/damage-types', async (req, res) => res.json({ items: await db.many('SELECT code, name FROM damage_types ORDER BY name') }));
router.get('/locations', async (req, res) => res.json({ items: await db.many('SELECT id, code, name, address, city, province, postal_code, phone, email, hours, pickup_hours, lat, lng FROM locations WHERE active ORDER BY name') }));
router.get('/auctions', async (req, res) => res.json({ items: await db.many(`SELECT e.*, (SELECT COUNT(*)::int FROM auction_lots l WHERE l.event_id=e.id AND l.status<>'cancelled') AS lots FROM auction_events e WHERE e.status<>'cancelled' AND e.starts_at > now() - interval '30 days' ORDER BY e.starts_at`) }));

router.get('/lots', async (req, res) => {
  const r = await catalog.searchLots(req.query, { perPage: Math.min(100, Number(req.query.per_page) || 20) });
  res.json({ ...r, items: r.items.map(lotJson) });
});
router.get('/lots/:lotNumber', async (req, res) => {
  const l = await catalog.lotByNumber(req.params.lotNumber);
  if (!l) throw notFound('Lot not found.');
  res.json({ lot: lotJson(l), bids: await recentBids(l.id) });
});
router.get('/lots/:id/bids', async (req, res) => res.json({ items: await recentBids(Number(req.params.id)) }));

router.get('/fees/estimate', async (req, res) => {
  const { amount } = parse(z.object({ amount: z.coerce.number().positive().max(10_000_000) }), req.query);
  res.json(await orders.feeBreakdown(Math.round(amount * 100)));
});

// ── Alertas de vehículos (visitantes o usuarios) ──
const AlertSchema = z.object({
  vehicle_type: z.string().optional(), year_from: z.coerce.number().int().min(1920).max(2100), year_to: z.coerce.number().int().min(1920).max(2100),
  make_id: z.coerce.number().int().positive('Select a make'), model_id: optInt(), frequency: z.enum(['instant', 'daily', 'weekly']).default('daily'),
  first_name: z.string().trim().min(1, 'Enter your first name').max(60), last_name: z.string().trim().min(1, 'Enter your last name').max(80),
  email: z.string().trim().toLowerCase().email('Enter a valid email'), consent: bool().refine(v => v, 'You must give consent to receive alert emails'),
}).refine(d => d.year_from <= d.year_to, { message: 'Year "from" must be before year "to"', path: ['year_to'] });
async function typeId(code) { return code ? (await db.one('SELECT id FROM vehicle_types WHERE code=$1', [code]))?.id ?? null : null; }

router.post('/alerts', rateLimit({ windowMs: 3600_000, max: 30, scope: 'alerts' }), async (req, res) => {
  const d = parse(AlertSchema, req.body);
  if (!d.model_id) throw bad('model_id: Select a model', { fields: { model_id: 'Select a model' } });
  const token = crypto.randomBytes(16).toString('hex');
  const a = await db.tx(async c => {
    const row = await c.one(`INSERT INTO vehicle_alerts(user_id, vehicle_type_id, year_from, year_to, make_id, model_id, frequency, first_name, last_name, email, consent, manage_token)
                             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,true,$11) RETURNING *`, [req.user?.id || null, await typeId(d.vehicle_type), d.year_from, d.year_to, d.make_id, d.model_id || null, d.frequency, d.first_name, d.last_name, d.email, token]);
    // Coincidencias con el inventario actual
    const lots = await c.many(`SELECT l.id FROM auction_lots l JOIN vehicles v ON v.id=l.vehicle_id WHERE l.status IN ('prebidding','live') AND v.make_id=$1 AND ($2::int IS NULL OR v.model_id=$2) AND v.year BETWEEN $3 AND $4 AND ($5::int IS NULL OR v.vehicle_type_id=$5)`, [d.make_id, d.model_id || null, d.year_from, d.year_to, row.vehicle_type_id]);
    for (const l of lots) await c.query('INSERT INTO vehicle_alert_matches(alert_id, lot_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [row.id, l.id]);
    await email(c, d.email, 'Your vehicle alert is active', `Hi ${d.first_name}, your alert was created (${lots.length} current matches). Frequency: ${d.frequency}. Manage or cancel: /vehicle-alerts/manage/${token}`);
    return { ...row, matches: lots.length };
  });
  res.status(201).json({ ok: true, message: `Alert created. ${a.matches} vehicle(s) currently match. We'll email you ${d.frequency === 'instant' ? 'instantly' : d.frequency} when new ones arrive.`, redirect: `/vehicle-alerts/manage/${token}` });
});
router.patch('/alerts/:token', async (req, res) => {
  const d = parse(AlertSchema, { ...req.body, consent: true });
  const a = await db.one(`UPDATE vehicle_alerts SET vehicle_type_id=$2, year_from=$3, year_to=$4, make_id=$5, model_id=$6, frequency=$7, first_name=$8, last_name=$9, email=$10
                          WHERE manage_token=$1 AND status='active' RETURNING id`, [req.params.token, await typeId(d.vehicle_type), d.year_from, d.year_to, d.make_id, d.model_id || null, d.frequency, d.first_name, d.last_name, d.email]);
  if (!a) throw notFound('Alert not found or cancelled.');
  res.json({ ok: true, message: 'Alert updated.' });
});
router.post('/alerts/:token/cancel', async (req, res) => {
  const a = await db.one("UPDATE vehicle_alerts SET status='cancelled' WHERE manage_token=$1 AND status='active' RETURNING id, email", [req.params.token]);
  if (!a) throw notFound('Alert not found or already cancelled.');
  await email(null, a.email, 'Vehicle alert cancelled', 'Your vehicle alert has been cancelled. You will not receive more emails for it.');
  res.json({ ok: true, message: 'Alert cancelled.', reload: true });
});

// ── Contacto / soporte ──
router.post('/support/tickets', rateLimit({ windowMs: 3600_000, max: 10, scope: 'contact' }), async (req, res) => {
  const d = parse(z.object({ name: z.string().trim().min(2, 'Enter your name').max(100), email: z.string().trim().email('Enter a valid email'), topic: z.enum(['general', 'registration', 'bidding', 'payments', 'transport', 'selling']).default('general'), subject: z.string().trim().min(3, 'Enter a subject').max(160), message: z.string().trim().min(10, 'Message must be at least 10 characters').max(4000) }), req.body);
  const t = await db.one('INSERT INTO support_tickets(user_id, name, email, topic, subject, message) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [req.user?.id || null, d.name, d.email, d.topic, d.subject, d.message]);
  await audit(null, { actorId: req.user?.id || null, action: 'support.ticket', entity: 'support_ticket', entityId: t.id, ip: req.ip });
  res.status(201).json({ ok: true, message: `Thank you! Ticket #${t.id} has been created. Member Services will reply by email (demo).` });
});

// ── Calculadora pública de transporte ──
router.post('/transport/estimate', async (req, res) => {
  const d = parse(z.object({ location: z.string(), postal_code: z.string().trim().regex(/^\d{5}$/, 'Enter a 5-digit Spanish postal code'), service: z.enum(['national', 'international', 'express']).default('national') }), req.body);
  const loc = await db.one('SELECT * FROM locations WHERE code=$1', [d.location]);
  if (!loc) throw bad('Select a yard.');
  const q = await orders.quoteTransport({ originLocation: loc, postalCode: d.postal_code, service: d.service });
  res.json({ ok: true, ...q, message: `Estimated price: ${(q.price_cents / 100).toFixed(2)}€ for ~${q.distance_km} km (demo estimate, not a binding quote).` });
});

module.exports = router;
