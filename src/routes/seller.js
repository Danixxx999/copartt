'use strict';
/** Portal del vendedor (/seller). PROPUESTA ACADÉMICA: interfaz diseñada sin capturas reales. */
const express = require('express');
const db = require('../db');
const catalog = require('../services/catalog');
const { requireAuth } = require('../lib/auth');
const { notFound, forbidden } = require('../lib/errors');
const router = express.Router();
router.use(requireAuth);
router.use((req, res, next) => (req.user.is('seller') ? next() : res.redirect('/sell-a-vehicle')));

const NAV = [['/seller', 'Overview', 'grid'], ['/seller/vehicles', 'My Vehicles', 'car'], ['/seller/vehicles/new', 'New Vehicle', 'plus'], ['/seller/sales', 'Sales & Approvals', 'gavel'], ['/seller/calendar', 'Auction Calendar', 'calendar'], ['/seller/statements', 'Statements', 'receipt'], ['/dashboard/notifications', 'Notifications', 'inbox']];
const sid = req => req.user.seller?.id || 0;
router.use(async (req, res, next) => {
  const c = await db.one(`SELECT (SELECT COUNT(*) FROM vehicles WHERE seller_id=$1)::int AS vehicles,
                                 (SELECT COUNT(*) FROM auction_lots l JOIN vehicles v ON v.id=l.vehicle_id WHERE v.seller_id=$1 AND l.status='pending_seller_approval' AND l.counter_offer_cents IS NULL)::int AS approvals`, [sid(req)]);
  res.locals.navGroups = [
    [null, [['/seller', 'Seller Dashboard', 'grid']]],
    ['Inventory', [['/seller/vehicles', 'My Vehicles', 'car', 0, c.vehicles], ['/seller/vehicles/new', 'Add a Vehicle', 'plus']]],
    ['Sales', [['/seller/sales', 'Sales & Approvals', 'gavel', 0, c.approvals], ['/seller/calendar', 'Auction Calendar', 'calendar'], ['/seller/statements', 'Statements', 'receipt']]],
    ['Account', [['/dashboard/notifications', 'Messages', 'inbox'], ['/dashboard/profile', 'Account Information', 'user']]],
  ];
  next();
});
const page = (res, view, data) => res.render(`panel/seller/${view}`, { nav: NAV, area: 'Seller portal', memberLayout: true, apiBase: '/api/v1/seller/vehicles', backHref: '/seller/vehicles', adminMode: false, ...data });

router.get('/', async (req, res) => {
  const s = sid(req);
  const stats = await db.one(`SELECT COUNT(*) FILTER (WHERE status='draft')::int AS drafts, COUNT(*) FILTER (WHERE status='pending_approval')::int AS pending, COUNT(*) FILTER (WHERE status='approved')::int AS listed, COUNT(*) FILTER (WHERE status='rejected')::int AS rejected, COUNT(*) FILTER (WHERE status='sold')::int AS sold FROM vehicles WHERE seller_id=$1`, [s]);
  const revenue = await db.one('SELECT COALESCE(SUM(hammer_cents),0)::bigint AS total, COUNT(*)::int AS n FROM sale_orders WHERE seller_id=$1 AND status<>\'cancelled\'', [s]);
  const approvals = await db.many(`SELECT l.*, mk.name AS make, md.name AS model, v.year FROM auction_lots l JOIN vehicles v ON v.id=l.vehicle_id JOIN makes mk ON mk.id=v.make_id JOIN models md ON md.id=v.model_id WHERE v.seller_id=$1 AND l.status='pending_seller_approval'`, [s]);
  const upcoming = (await catalog.searchLots({}, { perPage: 200 })).items.filter(l => l.seller_id === s).slice(0, 6);
  page(res, 'overview', { stats, revenue, approvals, upcoming, title: 'Seller Dashboard' });
});
router.get('/vehicles', async (req, res) => {
  const status = req.query.status || '';
  const items = await db.many(`SELECT v.*, mk.name AS make, md.name AS model, loc.name AS location_name, (SELECT path FROM vehicle_images WHERE vehicle_id=v.id ORDER BY sort LIMIT 1) AS image,
                                      (SELECT COUNT(*)::int FROM vehicle_images WHERE vehicle_id=v.id) AS photos, l.lot_number, l.status AS lot_status, l.current_bid_cents
                                 FROM vehicles v JOIN makes mk ON mk.id=v.make_id JOIN models md ON md.id=v.model_id JOIN locations loc ON loc.id=v.location_id
                                 LEFT JOIN LATERAL (SELECT lot_number, status, current_bid_cents FROM auction_lots WHERE vehicle_id=v.id ORDER BY id DESC LIMIT 1) l ON true
                                WHERE v.seller_id=$1 AND ($2='' OR v.status=$2) ORDER BY v.updated_at DESC`, [sid(req), status]);
  page(res, 'vehicles', { items, status, title: 'My Vehicles' });
});
async function formRefs() {
  const [makes, types, damages, locations] = await Promise.all([catalog.makesWithModels(), db.many('SELECT code, name FROM vehicle_types ORDER BY name'), db.many('SELECT code, name FROM damage_types ORDER BY name'), db.many('SELECT code, name FROM locations WHERE active ORDER BY name')]);
  return { makes, types, damages, locations };
}
router.get('/vehicles/new', async (req, res) => page(res, 'vehicle-form', { v: null, images: [], docs: [], ...(await formRefs()), title: 'New Vehicle' }));
router.get('/vehicles/:id/edit', async (req, res) => {
  const v = await db.one(`SELECT v.*, vt.code AS type_code, d1.code AS damage1, d2.code AS damage2, loc.code AS location_code FROM vehicles v JOIN vehicle_types vt ON vt.id=v.vehicle_type_id LEFT JOIN damage_types d1 ON d1.id=v.primary_damage_id LEFT JOIN damage_types d2 ON d2.id=v.secondary_damage_id JOIN locations loc ON loc.id=v.location_id WHERE v.id=$1`, [Number(req.params.id)]);
  if (!v) throw notFound();
  if (v.seller_id !== sid(req)) throw forbidden();
  const [images, docs, lot] = await Promise.all([db.many('SELECT * FROM vehicle_images WHERE vehicle_id=$1 ORDER BY sort, id', [v.id]), db.many('SELECT * FROM vehicle_documents WHERE vehicle_id=$1 ORDER BY id', [v.id]), db.one('SELECT * FROM auction_lots WHERE vehicle_id=$1 ORDER BY id DESC LIMIT 1', [v.id])]);
  page(res, 'vehicle-form', { v, images, docs, lot, ...(await formRefs()), title: `Vehicle #${v.id}` });
});
router.get('/sales', async (req, res) => {
  const rows = await db.many(`SELECT l.*, mk.name AS make, md.name AS model, v.year, e.name AS event_name, e.starts_at, o.order_number, o.status AS order_status
                                FROM auction_lots l JOIN vehicles v ON v.id=l.vehicle_id JOIN makes mk ON mk.id=v.make_id JOIN models md ON md.id=v.model_id JOIN auction_events e ON e.id=l.event_id LEFT JOIN sale_orders o ON o.lot_id=l.id
                               WHERE v.seller_id=$1 ORDER BY (l.status='pending_seller_approval') DESC, e.starts_at DESC`, [sid(req)]);
  page(res, 'sales', { rows, title: 'Sales & Approvals' });
});
router.get('/calendar', async (req, res) => {
  const events = await db.many(`SELECT e.*, COUNT(l.id)::int AS my_lots FROM auction_events e JOIN auction_lots l ON l.event_id=e.id JOIN vehicles v ON v.id=l.vehicle_id WHERE v.seller_id=$1 AND e.status IN ('scheduled','live') GROUP BY e.id ORDER BY e.starts_at`, [sid(req)]);
  const all = await db.many("SELECT * FROM auction_events WHERE status IN ('scheduled','live') ORDER BY starts_at LIMIT 12");
  page(res, 'calendar', { events, all, title: 'Auction Calendar' });
});
router.get('/statements', async (req, res) => {
  const rows = await db.many(`SELECT o.*, l.lot_number, mk.name AS make, md.name AS model, v.year FROM sale_orders o JOIN auction_lots l ON l.id=o.lot_id JOIN vehicles v ON v.id=l.vehicle_id JOIN makes mk ON mk.id=v.make_id JOIN models md ON md.id=v.model_id WHERE o.seller_id=$1 ORDER BY o.id DESC`, [sid(req)]);
  const commission = 0.05; // comisión de venta demo para el liquidador del vendedor
  page(res, 'statements', { rows, commission, title: 'Statements' });
});
module.exports = router;
