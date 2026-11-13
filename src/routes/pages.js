'use strict';
const express = require('express');
const db = require('../db');
const catalog = require('../services/catalog');
const orders = require('../services/orders');
const { eligibility, minimumNextBid } = require('../services/bidding');
const settings = require('../lib/settings');
const { recentBids } = require('../realtime/socket');
const { notFound } = require('../lib/errors');
const { requireAuth } = require('../lib/auth');
const { buildCalendar } = require('./calendar');
const router = express.Router();
router.use(require('./portal-reference'));

const render = (res, view, data) => res.render(`pages/${view}`, data);

/** Datos de la portada filtrados por la región elegida (país de la sede del vehículo). */
async function homeData(country = 'ES') {
  const [featured, stats, f, plans, homeBanners, homeModels, events] = await Promise.all([
    catalog.searchLots({ featured: 1, sort: 'auction_date', country }, { perPage: 24 }),
    db.one(`SELECT COUNT(*)::int AS open, (SELECT COUNT(*)::int FROM auction_events WHERE status='live') AS live
              FROM auction_lots l JOIN vehicles v ON v.id=l.vehicle_id JOIN locations loc ON loc.id=v.location_id WHERE l.status IN ('prebidding','live') AND loc.country=$1`, [country]),
    catalog.facets(country),
    db.many('SELECT * FROM membership_plans WHERE active ORDER BY sort'),
    db.many("SELECT text, link_text, link_url FROM banners WHERE placement='home' AND active ORDER BY id"),
    db.many("SELECT DISTINCT md.id, md.name, mk.name AS make FROM models md JOIN makes mk ON mk.id=md.make_id JOIN vehicles v ON v.model_id=md.id JOIN locations loc ON loc.id=v.location_id JOIN auction_lots l ON l.vehicle_id=v.id WHERE l.status IN ('prebidding','live') AND loc.country=$1 ORDER BY mk.name, md.name LIMIT 48", [country]),
    db.many("SELECT id, name, starts_at, status FROM auction_events WHERE status IN ('live','scheduled') ORDER BY status='live' DESC, starts_at LIMIT 3"),
  ]);
  // Si la región no tiene destacados, se muestran sus lotes abiertos.
  const popular = featured.items.length >= 4 ? featured : await catalog.searchLots({ country, sort: 'auction_date' }, { perPage: 24 });
  const photographicTypes = popular.items.filter(l => ['automobile','suv'].includes(l.type_code));
  const socialLinks = await settings.get('social_links', {});
  return { popular: (photographicTypes.length >= 4 ? photographicTypes : popular.items).slice(0,8), stats, facets: f, plans, homeBanners, homeModels, nextEvents: events, socialLinks };
}

router.get('/', async (req, res) => render(res, 'home-reference', { ...(await homeData(req.region)), title: 'Subastas de Autos 100% En línea', description: 'copart: subastas de vehículos usados y reparables. Proyecto académico con inventario de demostración.' }));
router.get('/how-it-works', (req, res) => render(res, 'how-it-works', { title: 'How It Works' }));
router.get('/membership', async (req, res) => render(res, 'membership', { plans: await db.many('SELECT * FROM membership_plans WHERE active ORDER BY sort'), title: 'Membership Options' }));

// ── Buscador y resultados ──
router.get('/vehicle-finder', async (req, res) => {
  const [makes, f, types, locations] = await Promise.all([catalog.makesWithModels(), catalog.facets(req.region), db.many('SELECT code, name FROM vehicle_types ORDER BY name'), db.many('SELECT code, name, city FROM locations WHERE active AND country=$1 ORDER BY name', [req.region])]);
  render(res, 'vehicle-finder', { makes, facets: f, types, locations, title: 'Vehicle Finder' });
});
router.get(['/vehicles', '/lotSearchResults'], async (req, res) => {
  const q = { ...req.query };
  if (req.query.query) q.q = req.query.query; // compatibilidad con /lotSearchResults?query=
  // Región del sitio: por defecto solo sedes del país elegido. ?country=all muestra todos; una sede, un número de lote o una subasta concreta no se filtran.
  const allCountries = q.country === 'all';
  if (allCountries || q.location || q.event || q.lot || q.vin || /^\d{5,}$/.test(String(q.q || '').trim()) || /^(?=.*\d)(?=.*[A-Z])[A-Z0-9]{11,17}$/i.test(String(q.q || '').trim())) delete q.country;
  else q.country = /^[A-Z]{2}$/.test(String(q.country || '')) ? q.country : req.region;
  const [result, makes, types, locations, damages] = await Promise.all([catalog.searchLots(q), catalog.makesWithModels(), db.many('SELECT code, name FROM vehicle_types ORDER BY name'), db.many('SELECT code, name FROM locations WHERE active AND ($1::text IS NULL OR country=$1) ORDER BY name', [q.country || null]), db.many('SELECT code, name FROM damage_types ORDER BY name')]);
  res.locals.regionScope = { country: q.country || null, all: allCountries };
  const watched = req.user ? new Set((await db.many('SELECT lot_id FROM watchlist WHERE user_id=$1', [req.user.id])).map(r => r.lot_id)) : new Set();
  render(res, 'vehicles', { result, makes, types, locations, damages, watched, f: q, title: 'Search Results' });
});
router.get('/lot/:lotNumber', async (req, res) => {
  if (!/^\d+$/.test(req.params.lotNumber)) throw notFound('Lot not found');
  const lot = await catalog.lotByNumber(req.params.lotNumber);
  if (!lot || lot.status === 'cancelled') throw notFound('Lot not found');
  const [images, history, fees, minBid, watching, mine, docs] = await Promise.all([
    db.many('SELECT path FROM vehicle_images WHERE vehicle_id=$1 ORDER BY sort, id', [lot.vehicle_id]),
    recentBids(lot.id),
    orders.feeBreakdown(lot.current_bid_cents || lot.starting_bid_cents),
    minimumNextBid(lot),
    req.user ? db.one('SELECT 1 FROM watchlist WHERE user_id=$1 AND lot_id=$2', [req.user.id, lot.id]) : null,
    req.user ? db.one('SELECT max_cents FROM proxy_bids WHERE user_id=$1 AND lot_id=$2', [req.user.id, lot.id]) : null,
    db.many('SELECT doc_type FROM vehicle_documents WHERE vehicle_id=$1', [lot.vehicle_id]),
  ]);
  const elig = eligibility(req.user);
  if (req.user && !req.impersonator) await db.query('INSERT INTO lot_views(user_id, lot_id) VALUES ($1,$2) ON CONFLICT (user_id, lot_id) DO UPDATE SET views=lot_views.views+1, viewed_at=now()', [req.user.id, lot.id]);
  const similar =(await catalog.searchLots({ make: lot.make_slug }, { perPage: 5 })).items.filter(x => x.id !== lot.id).slice(0, 4);
  render(res, 'lot', { lot, images, history, fees, minBid, watching: !!watching, myMax: mine?.max_cents, elig, docs, similar, maskVin: catalog.maskVin, title: `${lot.year} ${lot.make} ${lot.model} – Lot #${lot.lot_number}`, description: `Lot ${lot.lot_number}: ${lot.year} ${lot.make} ${lot.model}, ${lot.primary_damage}, ${lot.location_city}.` });
});

// ── Alertas ──
router.get('/vehicle-alerts', async (req, res) => render(res, 'alerts-reference', { makes: await catalog.makesWithModels(), types: await db.many('SELECT code, name FROM vehicle_types ORDER BY name'), alert: null, title: 'Alerta de Vehículos' }));
router.get('/vehicle-alerts/manage/:token', async (req, res) => {
  const alert = await db.one('SELECT a.*, vt.code AS type_code, mk.name AS make, md.name AS model, (SELECT COUNT(*)::int FROM vehicle_alert_matches m WHERE m.alert_id=a.id) AS matches FROM vehicle_alerts a LEFT JOIN vehicle_types vt ON vt.id=a.vehicle_type_id JOIN makes mk ON mk.id=a.make_id LEFT JOIN models md ON md.id=a.model_id WHERE a.manage_token=$1', [req.params.token]);
  if (!alert) throw notFound('Alert not found');
  const matches = await catalog.searchLots({ ids: (await db.many('SELECT lot_id FROM vehicle_alert_matches WHERE alert_id=$1', [alert.id])).map(r => r.lot_id), status: 'all' }, { perPage: 12 });
  render(res, 'alerts-reference', { makes: await catalog.makesWithModels(), types: await db.many('SELECT code, name FROM vehicle_types ORDER BY name'), alert, matches: matches.items, title: 'Gestionar alerta de vehículos' });
});

// ── Subastas ──
router.get('/auctions/calendar', async (req, res) => {
  const events = await db.many(`SELECT e.*, loc.name AS location_name, (SELECT COUNT(*)::int FROM auction_lots l WHERE l.event_id=e.id AND l.status<>'cancelled') AS lots
                                  FROM auction_events e LEFT JOIN locations loc ON loc.id=e.location_id WHERE e.status<>'cancelled' AND e.starts_at >= date_trunc('week', now() AT TIME ZONE 'Europe/Madrid') - interval '7 days' ORDER BY e.starts_at`);
  render(res, 'calendar-reference', { weeks: buildCalendar(events, 6), events, view: req.query.view === 'list' ? 'list' : 'calendar', announcement: await settings.get('auction_announcement', ''), title: 'Calendario de subastas' });
});
router.get('/auctions', async (req, res) => {
  const events = await db.many(`SELECT e.*, loc.name AS location_name, (SELECT COUNT(*)::int FROM auction_lots l WHERE l.event_id=e.id AND l.status<>'cancelled') AS lots,
                                       (SELECT COUNT(*)::int FROM auction_lots l WHERE l.event_id=e.id AND l.status IN ('prebidding','scheduled')) AS remaining
                                  FROM auction_events e LEFT JOIN locations loc ON loc.id=e.location_id WHERE e.status IN ('live','scheduled') ORDER BY e.status='live' DESC, e.starts_at LIMIT 30`);
  render(res, 'auction-directory', { events, title: 'Subastas de hoy' });
});
router.get('/auctions/:id/live', async (req, res) => {
  const ev = await db.one('SELECT e.*, loc.name AS location_name FROM auction_events e LEFT JOIN locations loc ON loc.id=e.location_id WHERE e.id=$1', [Number(req.params.id)]);
  if (!ev) throw notFound('Auction not found');
  const lots = (await catalog.searchLots({ event: ev.id, status: 'all', sort: 'auction_date' }, { perPage: 100 })).items;
  const images = Object.fromEntries((await db.many('SELECT DISTINCT ON (vehicle_id) vehicle_id, path FROM vehicle_images WHERE vehicle_id = ANY($1) ORDER BY vehicle_id, sort', [lots.map(l => l.vehicle_id)])).map(r => [r.vehicle_id, r.path]));
  render(res, 'auction-live', { ev, lots, images, elig: eligibility(req.user), title: `Live auction – ${ev.name}` });
});

// ── Sedes ──
router.get('/locations', async (req, res) => {
  const q = String(req.query.q || '').trim();
  const country = req.query.country === 'all' ? null : req.region;
  const locations = await db.many(`SELECT loc.*, (SELECT COUNT(*)::int FROM vehicles v JOIN auction_lots l ON l.vehicle_id=v.id AND l.status IN ('prebidding','live') WHERE v.location_id=loc.id) AS vehicles
                                     FROM locations loc WHERE loc.active AND ($2::text IS NULL OR loc.country=$2) AND ($1 = '' OR loc.city ILIKE '%'||$1||'%' OR loc.province ILIKE '%'||$1||'%' OR loc.postal_code LIKE $1||'%' OR loc.name ILIKE '%'||$1||'%') ORDER BY loc.name`, [q, country]);
  res.locals.regionScope = { country, all: !country };
  render(res, 'locations', { locations, q, title: 'Our Locations' });
});
router.get('/locations/:code', async (req, res) => {
  const loc = await db.one('SELECT * FROM locations WHERE code=$1 AND active', [req.params.code.toUpperCase()]);
  if (!loc) throw notFound('Location not found');
  const lots = await catalog.searchLots({ location: loc.code }, { perPage: 8 });
  const events = await db.many(`SELECT DISTINCT e.* FROM auction_events e JOIN auction_lots l ON l.event_id=e.id JOIN vehicles v ON v.id=l.vehicle_id WHERE v.location_id=$1 AND e.status IN ('scheduled','live') ORDER BY e.starts_at LIMIT 5`, [loc.id]);
  render(res, 'location', { loc, lots, events, title: loc.name });
});

// ── Servicios ──
router.get('/transport', async (req, res) => {
  const locations = await db.many('SELECT code, name FROM locations WHERE active ORDER BY name');
  const myOrders = req.user ? await db.many("SELECT o.id, o.order_number, o.status FROM sale_orders o WHERE o.buyer_id=$1 AND o.status NOT IN ('completed','cancelled') ORDER BY o.id DESC", [req.user.id]) : [];
  const tracking = req.query.tracking ? await db.one('SELECT t.*, q.destination_city, q.service FROM transport_orders t JOIN transport_quotes q ON q.id=t.quote_id WHERE t.tracking_code=$1', [String(req.query.tracking).trim().toUpperCase()]) : null;
  const events = tracking ? await db.many('SELECT * FROM transport_events WHERE transport_order_id=$1 ORDER BY id', [tracking.id]) : [];
  render(res, 'transport', { locations, myOrders, tracking, trackingQuery: req.query.tracking || '', events, title: 'National and International Transport' });
});
router.get('/sell-a-vehicle', (req, res) => render(res, 'sell-a-vehicle', { title: 'Sell a Vehicle' }));
router.get('/contact', (req, res) => render(res, 'contact', { title: 'Contact Us' }));
router.get(['/help', '/help-center'], (req, res) => render(res, 'help', { title: 'Help Center' }));
router.get('/how-to-buy', async (req, res) => render(res, 'how-to-buy', { fee: await settings.get('buyer_fee'), adminFee: await settings.get('admin_fee_cents'), title: 'How to Buy' }));
router.get(['/faq', '/common-questions'], (req, res) => render(res, 'faq', { title: 'Common Questions' }));
router.get('/videos', (req, res) => render(res, 'videos', { title: 'Videos' }));
router.get('/sitemap', (req, res) => render(res, 'sitemap', { title: 'Site Map' }));
router.get('/api/docs', (req, res) => render(res, 'api-docs', { title: 'API v1 documentation' }));
router.get('/fee-calculator', async (req, res) => {
  const amount = Number(req.query.amount) > 0 ? Math.min(Number(req.query.amount), 10_000_000) : null;
  render(res, 'fee-calculator', { amount, breakdown: amount ? await orders.feeBreakdown(Math.round(amount * 100)) : null, title: 'Fee Calculator' });
});
const PAGE_ALIASES = { '/terms': 'terms', '/privacy': 'privacy', '/cookie-policy': 'cookie-policy', '/company-details': 'company-details', '/about-us': 'about-us' };
for (const [p, slug] of Object.entries(PAGE_ALIASES)) router.get(p, (req, res) => res.redirect(301, `/page/${slug}`));
router.get('/page/:slug', async (req, res) => {
  const page = await db.one('SELECT * FROM content_pages WHERE slug=$1 AND published', [req.params.slug]);
  if (!page) throw notFound('Page not found');
  render(res, 'content', { page, title: page.title });
});

// ── Autenticación y registro ──
router.get('/login', (req, res) => req.user ? res.redirect(res.locals.homeFor(req.user)) : render(res, 'login', { next: req.query.next || '', title: 'Account Sign In' }));
router.get('/forgot-password', (req, res) => render(res, 'forgot-password', { token: null, title: 'Forgot Password' }));
router.get('/reset-password/:token', (req, res) => render(res, 'forgot-password', { token: req.params.token, title: 'Reset Password' }));
router.get('/register', (req, res) => {
  if (req.user && req.user.registration_step !== 'complete') return res.redirect(`/register/${req.user.registration_step}`);
  if (req.user) return res.redirect('/dashboard');
  res.render('pages/register', { step: 'account', title: 'Register' });
});
router.get('/register/membership', requireAuth, async (req, res) => {
  const plans = await db.many('SELECT * FROM membership_plans WHERE active ORDER BY sort');
  const invoice = req.query.invoice ? await db.one("SELECT * FROM invoices WHERE id=$1 AND user_id=$2 AND kind='membership'", [Number(req.query.invoice), req.user.id]) : null;
  if (invoice?.status === 'paid') return res.redirect('/register/documents');
  res.render('pages/register', { step: 'membership', plans, invoice, title: 'Choose Membership' });
});
router.get('/register/documents', requireAuth, async (req, res) => {
  const docs = await db.many('SELECT * FROM verification_documents WHERE user_id=$1 ORDER BY id DESC', [req.user.id]);
  res.render('pages/register', { step: 'documents', docs, title: 'Document Submission' });
});
router.get('/register/complete', requireAuth, (req, res) => res.redirect('/dashboard?welcome=1'));
router.post('/logout', async (req, res) => { await require('../lib/auth').destroySession(req, res); res.redirect('/'); });

module.exports = router;
