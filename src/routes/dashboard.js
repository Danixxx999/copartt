'use strict';
/**
 * Área del miembro comprador (/dashboard). PROPUESTA ACADÉMICA basada en la estructura pública del
 * "Member Dashboard" de la referencia: widgets (Buying Power, lotes en los que pujo, Watchlist, pagos),
 * Bid Status (Current / Won / Lost / Counter Bids), Payments (Due / History), cuenta y membresía.
 */
const express = require('express');
const db = require('../db');
const catalog = require('../services/catalog');
const settings = require('../lib/settings');
const { requireAuth } = require('../lib/auth');
const { notFound, forbidden } = require('../lib/errors');
const { eligibility, buyingPower, minimumNextBid, increment } = require('../services/bidding');
const { invoicePdf } = require('../services/pdf');
const router = express.Router();
router.use(requireAuth);

// Contadores del menú lateral (una sola consulta por página).
router.use(async (req, res, next) => {
  const c = await db.one(`SELECT
      (SELECT COUNT(*) FROM proxy_bids pb JOIN auction_lots l ON l.id=pb.lot_id WHERE pb.user_id=$1 AND l.status IN ('prebidding','live'))::int AS current,
      (SELECT COUNT(*) FROM sale_orders WHERE buyer_id=$1 AND status<>'cancelled')::int AS won,
      (SELECT COUNT(*) FROM auction_lots WHERE leader_user_id=$1 AND status='pending_seller_approval' AND counter_offer_cents IS NOT NULL)::int AS counter,
      (SELECT COUNT(*) FROM watchlist WHERE user_id=$1)::int AS watch,
      (SELECT COUNT(*) FROM invoices WHERE user_id=$1 AND status IN ('issued','partially_paid'))::int AS due`, [req.user.id]);
  res.locals.navCounts = c;
  res.locals.navGroups = [
    [null, [['/dashboard', 'Tablero', 'grid']]],
    ['Mis ofertas', [['/dashboard/bids', 'Ofertas actuales', 'gavel', 0, c.current], ['/dashboard/bids?tab=won', 'Lotes ganados', 'trophy', 0, c.won], ['/dashboard/bids?tab=lost', 'Lotes perdidos', 'x-circle'], ['/dashboard/bids?tab=counter', 'Mis Contraofertas', 'swap', 0, c.counter]]],
    ['Inventario', [['/dashboard/watchlist', 'Lista de favoritos', 'star', 0, c.watch], ['/dashboard/recently-viewed', 'Vistos recientemente', 'history'], ['/dashboard/saved-searches', 'Búsquedas guardadas', 'search'], ['/dashboard/alerts', 'Alertas de vehículos', 'bell']]],
    ['Pagos', [['/dashboard/payments', 'Pagos adeudados', 'wallet', 0, c.due], ['/dashboard/payments?tab=history', 'Historial de pago', 'clock'], ['/dashboard/invoices', 'Facturas', 'receipt'], ['/dashboard/purchases', 'Compras y recogida', 'car']]],
    ['Mi cuenta', [['/dashboard/profile', 'Información de cuenta', 'user'], ['/dashboard/membership', 'Membresía', 'id'], ['/dashboard/buying-power', 'Poder adquisitivo', 'wallet'], ['/dashboard/documents', 'Documentos', 'file'], ['/dashboard/notifications', 'Mensajes', 'inbox']]],
  ];
  next();
});
const NAV = [['/dashboard', 'Tablero', 'grid']];
const page = (res, view, data) => res.render(`panel/buyer/${view}`, { nav: NAV, area: 'Mi cuenta', memberLayout: true, ...data });

/** Lotes en los que el usuario ha participado (pujas, Buy It Now o contraofertas). */
async function myLots(userId) {
  return db.many(`SELECT l.*, pb.max_cents AS my_max, mk.name AS make, md.name AS model, v.year, v.trim, v.odometer_km, v.document_type, v.estimated_value_cents, e.starts_at AS auction_date, e.name AS event_name, loc.name AS location_name,
                         (l.leader_user_id = $1) AS leading, o.id AS order_id, o.status AS order_status,
                         (SELECT path FROM vehicle_images WHERE vehicle_id=v.id ORDER BY sort, id LIMIT 1) AS image,
                         (SELECT MAX(created_at) FROM bids b WHERE b.lot_id=l.id AND b.user_id=$1) AS my_last_bid_at
                    FROM auction_lots l JOIN auction_events e ON e.id=l.event_id JOIN vehicles v ON v.id=l.vehicle_id JOIN makes mk ON mk.id=v.make_id JOIN models md ON md.id=v.model_id JOIN locations loc ON loc.id=v.location_id
                    LEFT JOIN proxy_bids pb ON pb.lot_id=l.id AND pb.user_id=$1 LEFT JOIN sale_orders o ON o.lot_id=l.id
                   WHERE l.id IN (SELECT lot_id FROM bids WHERE user_id=$1)
                   ORDER BY my_last_bid_at DESC NULLS LAST`, [userId]);
}
function groupLots(rows) {
  return {
    current: rows.filter(r => ['prebidding', 'live', 'scheduled'].includes(r.status) || (r.status === 'pending_seller_approval' && !(r.leading && r.counter_offer_cents))),
    won: rows.filter(r => r.status === 'awarded' && r.leading),
    lost: rows.filter(r => (['awarded', 'no_sale', 'cancelled'].includes(r.status) && !r.leading) || (r.status === 'no_sale' && r.leading) || (r.status === 'pending_seller_approval' && !r.leading)),
    counter: rows.filter(r => r.status === 'pending_seller_approval' && r.leading && r.counter_offer_cents),
  };
}
async function recentlyViewed(userId, limit) {
  const views = await db.many('SELECT lot_id FROM lot_views WHERE user_id=$1 ORDER BY viewed_at DESC LIMIT $2', [userId, limit]);
  if (!views.length) return [];
  const r = await catalog.searchLots({ ids: views.map(v => v.lot_id), status: 'all' }, { perPage: limit });
  const byId = new Map(r.items.map(i => [i.id, i]));
  // Máximo privado del usuario en cada lote: si ya ofertó se muestra "Su oferta máxima"; si no, "Oferta inicial" + "Oferta máxima".
  const mine = new Map((await db.many('SELECT lot_id, max_cents FROM proxy_bids WHERE user_id=$1 AND lot_id = ANY($2)', [userId, views.map(v => v.lot_id)])).map(m => [m.lot_id, m.max_cents]));
  return Promise.all(views.map(v => byId.get(v.lot_id)).filter(Boolean).map(async l => ({ ...l, my_max: mine.get(l.id) || null, min_next_cents: await minimumNextBid(l), increment_cents: await increment(l.current_bid_cents || l.starting_bid_cents) })));
}

/** Semana laboral (lunes–viernes, hora de Madrid) para la tarjeta "Subastas" del tablero. */
function madridDate(d = new Date()) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(d); } // YYYY-MM-DD
function workWeek(today) {
  const base = new Date(`${today}T12:00:00Z`); const dow = base.getUTCDay();
  const monday = new Date(base); monday.setUTCDate(base.getUTCDate() - ((dow + 6) % 7) + (dow === 0 || dow === 6 ? 7 : 0));
  return Array.from({ length: 5 }, (_, i) => { const d = new Date(monday); d.setUTCDate(monday.getUTCDate() + i); return d.toISOString().slice(0, 10); });
}
async function auctionWeek(req) {
  const today = madridDate();
  const days = workWeek(today);
  const day = days.includes(req.query.day) ? req.query.day : (days.includes(today) ? today : days[0]);
  const scope = req.query.scope === 'yours' ? 'yours' : 'national';
  const rows = await db.many(`SELECT e.id, e.name, e.status, e.starts_at, (e.starts_at AT TIME ZONE 'Europe/Madrid')::date::text AS day,
                                     (SELECT COUNT(*)::int FROM auction_lots l WHERE l.event_id=e.id AND l.status IN ('prebidding','live')) AS lots,
                                     EXISTS (SELECT 1 FROM auction_lots l JOIN vehicles v ON v.id=l.vehicle_id JOIN locations loc ON loc.id=v.location_id WHERE l.event_id=e.id AND loc.country=$2) AS in_region
                                FROM auction_events e
                               WHERE e.status IN ('scheduled','live') AND ((e.starts_at AT TIME ZONE 'Europe/Madrid')::date BETWEEN $1::date AND $1::date + 4 OR e.status='live')
                               ORDER BY e.starts_at`, [days[0], req.region]);
  const forDay = r => r.day === day || (r.status === 'live' && day === today);
  const inScope = r => scope === 'national' || r.in_region;
  return {
    days, day, today, scope,
    counts: Object.fromEntries(days.map(d => [d, rows.filter(r => (r.day === d || (r.status === 'live' && d === today)) && inScope(r)).length])),
    events: rows.filter(r => forDay(r) && inScope(r)),
    yoursCount: rows.filter(r => r.in_region).length, nationalCount: rows.length,
  };
}

router.get('/', async (req, res) => {
  const u = req.user.id;
  const [bp, lots, watchIds, dueInvoices, searches, viewed, events, notifications, stats, week] = await Promise.all([
    buyingPower(req.user),
    myLots(u),
    db.many('SELECT lot_id FROM watchlist WHERE user_id=$1', [u]),
    db.many(`SELECT i.*, o.order_number, o.id AS order_id FROM invoices i LEFT JOIN sale_orders o ON o.id=i.order_id WHERE i.user_id=$1 AND i.status IN ('issued','partially_paid') ORDER BY i.due_at NULLS LAST`, [u]),
    db.many('SELECT * FROM saved_searches WHERE user_id=$1 ORDER BY id DESC LIMIT 5', [u]),
    recentlyViewed(u, 6),
    db.many(`SELECT e.*, (SELECT COUNT(*)::int FROM auction_lots l WHERE l.event_id=e.id AND l.status IN ('prebidding','live')) AS lots FROM auction_events e WHERE e.status IN ('scheduled','live') ORDER BY e.status='live' DESC, e.starts_at LIMIT 4`),
    db.many('SELECT * FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 5', [u]),
    db.one(`SELECT (SELECT COUNT(*)::int FROM bids WHERE user_id=$1) AS bids, (SELECT COALESCE(SUM(hammer_cents),0)::bigint FROM sale_orders WHERE buyer_id=$1 AND status<>'cancelled') AS spent,
                   (SELECT COUNT(*)::int FROM sale_orders WHERE buyer_id=$1 AND status IN ('paid','ready_for_pickup','in_transport')) AS titles`, [u]),
    auctionWeek(req),
  ]);
  const g = groupLots(lots);
  const watch = watchIds.length ? (await catalog.searchLots({ ids: watchIds.map(r => r.lot_id), status: 'all' }, { perPage: 2000 })).items : [];
  const purchases = await orderRows(u);
  page(res, 'overview', { bp, bidding: g.current.slice(0, 6), won: g.won.slice(0, 3), counter: g.counter, groups: g, purchases, watch, dueInvoices, searches, viewed, events, notifications, stats, week, elig: eligibility(req.user), welcome: !!req.query.welcome, title: 'Tablero del miembro' });
});

router.get('/lots', async (req, res) => page(res, 'lots', { items: await myLots(req.user.id), title: 'Mis Lotes' }));

router.get('/bids', async (req, res) => {
  const tab = ['current', 'won', 'lost', 'counter'].includes(req.query.tab) ? req.query.tab : 'current';
  const groups = groupLots(await myLots(req.user.id));
  page(res, 'bids', { tab, groups, active: tab === 'current' ? '/dashboard/bids' : `/dashboard/bids?tab=${tab}`, title: { current: 'Ofertas actuales', won: 'Lotes ganados', lost: 'Lotes perdidos', counter: 'Mis Contraofertas' }[tab] });
});
router.get('/watchlist', async (req, res) => {
  const ids = (await db.many('SELECT lot_id FROM watchlist WHERE user_id=$1', [req.user.id])).map(r => r.lot_id);
  const r = await catalog.searchLots({ ids, status: 'all' }, { perPage: 100 });
  page(res, 'watchlist', { items: r.items, title: 'Lista de favoritos' });
});
router.get('/recently-viewed', async (req, res) => page(res, 'recently-viewed', { items: await recentlyViewed(req.user.id, 40), title: 'Vistos recientemente' }));

async function orderRows(userId) {
  return db.many(`SELECT o.*, l.lot_number, l.sold_via, v.year, mk.name AS make, md.name AS model, loc.name AS location_name,
                         (SELECT path FROM vehicle_images WHERE vehicle_id=v.id ORDER BY sort LIMIT 1) AS image,
                         (SELECT COALESCE(SUM(total_cents-paid_cents),0)::bigint FROM invoices i WHERE i.order_id=o.id AND i.status IN ('issued','partially_paid')) AS balance,
                         (SELECT MIN(due_at) FROM invoices i WHERE i.order_id=o.id AND i.status IN ('issued','partially_paid')) AS due_at
                    FROM sale_orders o JOIN auction_lots l ON l.id=o.lot_id JOIN vehicles v ON v.id=l.vehicle_id JOIN makes mk ON mk.id=v.make_id JOIN models md ON md.id=v.model_id JOIN locations loc ON loc.id=v.location_id
                   WHERE o.buyer_id=$1 ORDER BY o.id DESC`, [userId]);
}
router.get('/purchases', async (req, res) => page(res, 'purchases', { orders: await orderRows(req.user.id), title: 'Compras y recogida' }));
router.get('/purchases/:id', async (req, res) => {
  const o = (await orderRows(req.user.id)).find(x => x.id === Number(req.params.id));
  if (!o) throw notFound('Purchase not found');
  const [invoices, history, pass, quotes, transport, bank, loc] = await Promise.all([
    db.many('SELECT * FROM invoices WHERE order_id=$1 ORDER BY id', [o.id]),
    db.many('SELECT * FROM order_status_history WHERE order_id=$1 ORDER BY id', [o.id]),
    db.one('SELECT pin_code, status, issued_at, used_at FROM pickup_passes WHERE order_id=$1', [o.id]),
    db.many("SELECT * FROM transport_quotes WHERE order_id=$1 AND status IN ('quoted','accepted') ORDER BY id DESC", [o.id]),
    db.one("SELECT * FROM transport_orders WHERE order_id=$1 AND status<>'cancelled' ORDER BY id DESC LIMIT 1", [o.id]),
    settings.get('bank_details'),
    db.one('SELECT loc.* FROM auction_lots l JOIN vehicles v ON v.id=l.vehicle_id JOIN locations loc ON loc.id=v.location_id WHERE l.id=$1', [o.lot_id]),
  ]);
  for (const i of invoices) {
    i.items = await db.many('SELECT * FROM invoice_items WHERE invoice_id=$1 ORDER BY id', [i.id]);
    i.payments = await db.many('SELECT p.*, (SELECT id FROM payment_proofs WHERE payment_id=p.id LIMIT 1) AS proof_id FROM payments p WHERE invoice_id=$1 ORDER BY id', [i.id]);
  }
  const tEvents = transport ? await db.many('SELECT * FROM transport_events WHERE transport_order_id=$1 ORDER BY id', [transport.id]) : [];
  page(res, 'purchase', { o, invoices, history, pass, quotes, transport, tEvents, bank, loc, active: '/dashboard/purchases', title: `Purchase ${o.order_number}` });
});
router.get('/payments', async (req, res) => {
  const tab = req.query.tab === 'history' ? 'history' : 'due';
  const [due, payments, totals] = await Promise.all([
    db.many(`SELECT i.*, o.order_number, o.id AS order_id, l.lot_number, (i.due_at < now()) AS overdue FROM invoices i LEFT JOIN sale_orders o ON o.id=i.order_id LEFT JOIN auction_lots l ON l.id=o.lot_id
              WHERE i.user_id=$1 AND i.status IN ('issued','partially_paid') ORDER BY i.due_at NULLS LAST`, [req.user.id]),
    db.many(`SELECT p.*, i.invoice_number, i.kind AS invoice_kind, o.id AS order_id FROM payments p JOIN invoices i ON i.id=p.invoice_id LEFT JOIN sale_orders o ON o.id=i.order_id WHERE p.user_id=$1 ORDER BY p.id DESC`, [req.user.id]),
    db.one(`SELECT COALESCE(SUM(total_cents-paid_cents) FILTER (WHERE status IN ('issued','partially_paid')),0)::bigint AS due,
                   COALESCE(SUM(total_cents-paid_cents) FILTER (WHERE status IN ('issued','partially_paid') AND due_at < now()),0)::bigint AS overdue,
                   (SELECT COALESCE(SUM(amount_cents),0)::bigint FROM payments WHERE user_id=$1 AND status='approved') AS paid,
                   (SELECT COALESCE(SUM(amount_cents),0)::bigint FROM payments WHERE user_id=$1 AND status='pending_review') AS in_review
              FROM invoices WHERE user_id=$1`, [req.user.id]),
  ]);
  const historyInvoices = tab === 'history' ? await db.many('SELECT * FROM invoices WHERE user_id=$1 ORDER BY id DESC', [req.user.id]) : [];
  page(res, 'payments', { tab, due, payments, totals, historyInvoices, historyView: req.query.view === 'transactions' ? 'transactions' : 'invoices', active: tab === 'due' ? '/dashboard/payments' : '/dashboard/payments?tab=history', title: tab === 'due' ? 'Pagos adeudados' : 'Historial de pago' });
});
router.get('/invoices', async (req, res) => {
  const invoices = await db.many('SELECT i.*, o.order_number FROM invoices i LEFT JOIN sale_orders o ON o.id=i.order_id WHERE i.user_id=$1 ORDER BY i.id DESC', [req.user.id]);
  const payments = await db.many('SELECT p.*, i.invoice_number FROM payments p JOIN invoices i ON i.id=p.invoice_id WHERE p.user_id=$1 ORDER BY p.id DESC', [req.user.id]);
  page(res, 'invoices', { invoices, payments, title: 'Facturas' });
});
router.get('/invoices/:id.pdf', async (req, res) => {
  const inv = await db.one('SELECT * FROM invoices WHERE id=$1', [Number(req.params.id)]);
  if (!inv) throw notFound();
  if (inv.user_id !== req.user.id && !req.user.has('invoices.manage')) throw forbidden();
  await invoicePdf(res, inv.id);
});
router.get('/buying-power', async (req, res) => {
  const [bp, plans, lots] = await Promise.all([buyingPower(req.user), db.many('SELECT * FROM membership_plans WHERE active ORDER BY sort'), myLots(req.user.id)]);
  page(res, 'buying-power', { bp, plans, active_lots: groupLots(lots).current, elig: eligibility(req.user), title: 'Poder adquisitivo' });
});
router.get('/saved-searches', async (req, res) => page(res, 'saved-searches', { items: await db.many('SELECT * FROM saved_searches WHERE user_id=$1 ORDER BY id DESC', [req.user.id]), title: 'Búsquedas guardadas' }));
router.get('/alerts', async (req, res) => {
  const items = await db.many(`SELECT a.*, mk.name AS make, md.name AS model, vt.name AS type_name, (SELECT COUNT(*)::int FROM vehicle_alert_matches m WHERE m.alert_id=a.id) AS matches
                                 FROM vehicle_alerts a JOIN makes mk ON mk.id=a.make_id LEFT JOIN models md ON md.id=a.model_id LEFT JOIN vehicle_types vt ON vt.id=a.vehicle_type_id
                                WHERE a.user_id=$1 OR lower(a.email)=lower($2) ORDER BY a.id DESC`, [req.user.id, req.user.email]);
  page(res, 'alerts', { items, title: 'Alertas de vehículos' });
});
router.get('/membership', async (req, res) => {
  const [plans, subs, pendingInvoice] = await Promise.all([
    db.many('SELECT * FROM membership_plans WHERE active ORDER BY sort'),
    db.many('SELECT s.*, mp.name FROM subscriptions s JOIN membership_plans mp ON mp.id=s.plan_id WHERE s.user_id=$1 ORDER BY s.id DESC', [req.user.id]),
    db.one("SELECT i.* FROM invoices i JOIN subscriptions s ON s.id=i.subscription_id WHERE i.user_id=$1 AND i.kind='membership' AND i.status='issued' AND s.status='pending_payment' ORDER BY i.id DESC LIMIT 1", [req.user.id]),
  ]);
  page(res, 'membership', { plans, subs, pendingInvoice, elig: eligibility(req.user), title: 'Membresía' });
});
router.get('/documents', async (req, res) => page(res, 'documents', { docs: await db.many('SELECT * FROM verification_documents WHERE user_id=$1 ORDER BY id DESC', [req.user.id]), title: 'Documentos' }));
router.get('/notifications', async (req, res) => page(res, 'notifications', { items: await db.many('SELECT * FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 100', [req.user.id]), title: 'Mensajes' }));
router.get('/profile', async (req, res) => {
  const [profile, sessions] = await Promise.all([
    db.one('SELECT p.*, u.created_at AS member_since, u.last_login_at FROM profiles p JOIN users u ON u.id=p.user_id WHERE p.user_id=$1', [req.user.id]),
    db.many('SELECT id, ip, user_agent, created_at, expires_at FROM sessions WHERE user_id=$1 AND expires_at > now() AND impersonator_id IS NULL ORDER BY id DESC LIMIT 10', [req.user.id]),
  ]);
  page(res, 'profile', { profile, sessions, title: 'Información de cuenta' });
});

module.exports = router;
module.exports.NAV = NAV;
