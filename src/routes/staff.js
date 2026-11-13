'use strict';
/** Paneles del personal: /admin, /finance, /ops. PROPUESTA ACADÉMICA. Permisos verificados por ruta. */
const express = require('express');
const db = require('../db');
const catalog = require('../services/catalog');
const { requirePerm, requireAuth, requireAdminArea } = require('../lib/auth');
const { notFound, forbidden } = require('../lib/errors');
const { REPORTS } = require('../services/reports');
const router = express.Router();

// Menú del administrador agrupado; cada entrada exige un permiso (sirve para roles personalizados).
const ADMIN_GROUPS = [
  ['Overview', [['/admin', 'Dashboard', 'grid', '*']]],
  ['Members', [['/admin/users', 'Users', 'user', 'users.manage'], ['/admin/roles', 'Roles & Permissions', 'shield', 'roles.manage'], ['/admin/documents', 'Document Review', 'file', 'documents.review'], ['/admin/sellers', 'Sellers', 'briefcase', 'users.manage'], ['/admin/memberships', 'Memberships & Limits', 'id', 'settings.manage']]],
  ['Inventory & Auctions', [['/admin/vehicles', 'Vehicles & Approvals', 'car', 'vehicles.approve'], ['/admin/vehicles/new', 'Add Vehicle', 'plus', 'vehicles.approve'], ['/admin/auctions', 'Auctions & Lots', 'gavel', 'auctions.manage'], ['/admin/bids', 'Bid Monitor', 'pulse', 'auctions.manage'], ['/admin/catalog', 'Catalog', 'tag', 'catalog.manage'], ['/admin/locations', 'Yards', 'pin', 'locations.manage']]],
  ['Finance & Logistics', [['/finance', 'Finance', 'receipt', 'finance.review'], ['/admin/payments', 'Payment Gateways', 'wallet', 'settings.manage'], ['/ops', 'Logistics', 'truck', 'logistics.manage'], ['/admin/reports', 'Reports', 'chart', 'reports.view']]],
  ['Website', [['/admin/content', 'Content & Banners', 'edit', 'content.manage'], ['/admin/announcements', 'Announcements', 'bell', 'content.manage'], ['/admin/social-login', 'Social sign-in', 'user', 'settings.manage'], ['/admin/support', 'Support Tickets', 'inbox', 'support.manage'], ['/admin/settings', 'Settings', 'gear', 'settings.manage'], ['/admin/audit', 'Audit Log', 'shield', 'audit.view'], ['/admin/mailbox', 'Demo Mailbox', 'mail', 'settings.manage']]],
];
const ADMIN_NAV = ADMIN_GROUPS.flatMap(g => g[1]);
const hasFullAdmin = u => u.is('admin') || u.adminPerms.some(p => p !== 'reports.view');
const adminGroups = u => ADMIN_GROUPS.map(([t, items]) => [t, items.filter(i => i[3] === '*' ? hasFullAdmin(u) : u.has(i[3]))]).filter(g => g[1].length);
const FIN_NAV = [['/finance', 'Payments queue', 'receipt'], ['/finance/invoices', 'Invoices', 'file'], ['/finance/balances', 'Outstanding balances', 'chart'], ['/admin/reports', 'Reports', 'chart']];
const OPS_NAV = [['/ops', 'Overview', 'grid'], ['/ops/pickups', 'Pickup / PIN', 'key'], ['/ops/transport', 'Transport', 'truck'], ['/ops/yards', 'Yards', 'pin'], ['/admin/reports', 'Reports', 'chart']];
function setNav(res, user, base, area) {
  if (hasFullAdmin(user)) { res.locals.navGroups = adminGroups(user); res.locals.nav = ADMIN_NAV; res.locals.area = 'Administration'; }
  else { res.locals.nav = base; res.locals.navGroups = null; res.locals.area = area; }
}
const view = (res, v, data) => res.render(`panel/staff/${v}`, data);
const pageNum = req => Math.max(1, Number(req.query.page) || 1);

// ───────────── ADMIN ─────────────
const admin = express.Router();
admin.use(requireAdminArea);
admin.use((req, res, next) => {
  setNav(res, req.user, req.user.has('finance.review') ? FIN_NAV : OPS_NAV, req.user.has('finance.review') ? 'Finance' : 'Operations & Logistics');
  next();
});

admin.get('/', async (req, res, next) => {
  if (!hasFullAdmin(req.user)) return next(forbidden());
  const k = await db.one(`SELECT
    (SELECT COUNT(*)::int FROM users) AS users, (SELECT COUNT(*)::int FROM users WHERE created_at > now() - interval '7 days') AS new_users,
    (SELECT COUNT(*)::int FROM auction_lots WHERE status IN ('prebidding','live')) AS open_lots, (SELECT COUNT(*)::int FROM auction_lots WHERE status='live') AS live_lots,
    (SELECT COUNT(*)::int FROM vehicles WHERE status='pending_approval') AS pending_vehicles, (SELECT COUNT(*)::int FROM verification_documents WHERE status='pending') AS pending_docs,
    (SELECT COUNT(*)::int FROM payments WHERE status='pending_review') AS pending_payments, (SELECT COUNT(*)::int FROM bids WHERE created_at > now() - interval '24 hours') AS bids_24h,
    (SELECT COALESCE(SUM(hammer_cents),0)::bigint FROM sale_orders WHERE status<>'cancelled') AS gmv, (SELECT COALESCE(SUM(total_cents-paid_cents),0)::bigint FROM invoices WHERE status IN ('issued','partially_paid')) AS receivable,
    (SELECT COUNT(*)::int FROM support_tickets WHERE status<>'closed') AS tickets, (SELECT COUNT(*)::int FROM sellers WHERE NOT approved) AS pending_sellers`);
  const salesByDay = await db.many(`SELECT to_char(d, 'DD/MM') AS day, COALESCE(SUM(o.hammer_cents),0)::bigint AS total, COUNT(o.id)::int AS n
                                      FROM generate_series(current_date - 13, current_date, interval '1 day') d LEFT JOIN sale_orders o ON o.created_at::date = d::date AND o.status<>'cancelled' GROUP BY d ORDER BY d`);
  const ordersByStatus = await db.many('SELECT status, COUNT(*)::int AS n FROM sale_orders GROUP BY status ORDER BY n DESC');
  const events = await db.many("SELECT e.*, (SELECT COUNT(*)::int FROM auction_lots l WHERE l.event_id=e.id AND l.status<>'cancelled') AS lots FROM auction_events e WHERE e.status IN ('scheduled','live') ORDER BY e.starts_at LIMIT 5");
  const audit = await db.many('SELECT a.*, u.email FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.id DESC LIMIT 8');
  view(res, 'admin-overview', { k, salesByDay, ordersByStatus, events, audit, title: 'Admin overview' });
});

admin.get('/users', requirePerm('users.manage'), async (req, res) => {
  const q = String(req.query.q || '').trim(), role = req.query.role || '', p = pageNum(req);
  const where = `WHERE ($1='' OR u.email ILIKE '%'||$1||'%' OR pr.first_name ILIKE '%'||$1||'%' OR pr.last_name ILIKE '%'||$1||'%' OR pr.company_name ILIKE '%'||$1||'%') AND ($2='' OR EXISTS (SELECT 1 FROM user_roles ur2 JOIN roles r2 ON r2.id=ur2.role_id WHERE ur2.user_id=u.id AND r2.code=$2))`;
  const total = (await db.one(`SELECT COUNT(*)::int n FROM users u JOIN profiles pr ON pr.user_id=u.id ${where}`, [q, role])).n;
  const rows = await db.many(`SELECT u.*, pr.first_name, pr.last_name, pr.company_name, string_agg(DISTINCT r.code, ', ') AS roles,
                                     (SELECT mp.name FROM subscriptions s JOIN membership_plans mp ON mp.id=s.plan_id WHERE s.user_id=u.id AND s.status='active' LIMIT 1) AS plan
                                FROM users u JOIN profiles pr ON pr.user_id=u.id LEFT JOIN user_roles ur ON ur.user_id=u.id LEFT JOIN roles r ON r.id=ur.role_id ${where}
                               GROUP BY u.id, pr.user_id ORDER BY u.id DESC LIMIT 25 OFFSET ${(p - 1) * 25}`, [q, role]);
  const [roles, counts] = await Promise.all([
    db.many('SELECT code, name FROM roles ORDER BY is_system DESC, id'),
    db.one(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='suspended')::int AS suspended, COUNT(*) FILTER (WHERE verification_status='pending')::int AS pending_docs,
                   COUNT(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS new_7d, (SELECT COUNT(DISTINCT user_id)::int FROM sessions WHERE expires_at > now()) AS online FROM users`),
  ]);
  view(res, 'users', { rows, total, page: p, pages: Math.max(1, Math.ceil(total / 25)), q, role, roles, counts, title: 'Users' });
});
admin.get('/users/:id', requirePerm('users.manage'), async (req, res) => {
  const { loadUserById } = require('../lib/auth');
  const u = await loadUserById(Number(req.params.id) || 0);
  if (!u) throw notFound();
  const [docs, orders, bids, log, roles, sessions, recentBids, extra, invoices] = await Promise.all([
    db.many('SELECT * FROM verification_documents WHERE user_id=$1 ORDER BY id DESC', [u.id]),
    db.many('SELECT o.*, l.lot_number FROM sale_orders o JOIN auction_lots l ON l.id=o.lot_id WHERE o.buyer_id=$1 ORDER BY o.id DESC', [u.id]),
    db.one('SELECT COUNT(*)::int n FROM bids WHERE user_id=$1', [u.id]),
    db.many("SELECT a.*, au.email AS actor_email FROM audit_logs a LEFT JOIN users au ON au.id=a.actor_id WHERE (a.entity='user' AND a.entity_id=$1) OR a.actor_id=$2 ORDER BY a.id DESC LIMIT 25", [String(u.id), u.id]),
    db.many('SELECT code, name, description, is_system FROM roles ORDER BY is_system DESC, id'),
    db.many('SELECT id, ip, user_agent, created_at, expires_at, impersonator_id FROM sessions WHERE user_id=$1 AND expires_at > now() ORDER BY id DESC', [u.id]),
    db.many(`SELECT b.*, l.lot_number, l.status AS lot_status FROM bids b JOIN auction_lots l ON l.id=b.lot_id WHERE b.user_id=$1 ORDER BY b.id DESC LIMIT 10`, [u.id]),
    db.one(`SELECT u.last_login_at, p.phone_prefix, p.phone, p.tax_id, p.address, p.city, p.postal_code, p.language, (SELECT COUNT(*)::int FROM watchlist WHERE user_id=$1) AS watch,
                   (SELECT COUNT(*)::int FROM vehicles v JOIN sellers s ON s.id=v.seller_id WHERE s.user_id=$1) AS vehicles FROM users u JOIN profiles p ON p.user_id=u.id WHERE u.id=$1`, [u.id]),
    db.many('SELECT * FROM invoices WHERE user_id=$1 ORDER BY id DESC LIMIT 10', [u.id]),
  ]);
  view(res, 'user', { u, docs, orders, bids, log, roles, sessions, recentBids, extra, invoices, title: `User ${u.email}` });
});
admin.get('/documents', requirePerm('documents.review'), async (req, res) => {
  const status = req.query.status || 'pending';
  const rows = await db.many(`SELECT d.*, u.email, p.first_name, p.last_name, u.account_type FROM verification_documents d JOIN users u ON u.id=d.user_id JOIN profiles p ON p.user_id=u.id WHERE ($1='all' OR d.status=$1) ORDER BY d.id DESC LIMIT 200`, [status]);
  view(res, 'documents', { rows, status, title: 'Document review' });
});
admin.get('/sellers', requirePerm('users.manage'), async (req, res) => {
  const rows = await db.many(`SELECT s.*, u.email, (SELECT COUNT(*)::int FROM vehicles v WHERE v.seller_id=s.id) AS vehicles, (SELECT COALESCE(SUM(hammer_cents),0)::bigint FROM sale_orders o WHERE o.seller_id=s.id) AS sales FROM sellers s JOIN users u ON u.id=s.user_id ORDER BY s.approved, s.id DESC`);
  view(res, 'sellers', { rows, title: 'Sellers' });
});
admin.get('/vehicles', requirePerm('vehicles.approve'), async (req, res) => {
  const status = req.query.status || 'pending_approval';
  const rows = await db.many(`SELECT v.*, mk.name AS make, md.name AS model, s.company_name, loc.code AS yard, (SELECT path FROM vehicle_images WHERE vehicle_id=v.id ORDER BY sort LIMIT 1) AS image,
                                     (SELECT COUNT(*)::int FROM vehicle_images WHERE vehicle_id=v.id) AS photos, (SELECT COUNT(*)::int FROM vehicle_documents WHERE vehicle_id=v.id) AS docs,
                                     l.lot_number, l.status AS lot_status
                                FROM vehicles v JOIN makes mk ON mk.id=v.make_id JOIN models md ON md.id=v.model_id JOIN sellers s ON s.id=v.seller_id JOIN locations loc ON loc.id=v.location_id
                                LEFT JOIN LATERAL (SELECT lot_number, status FROM auction_lots WHERE vehicle_id=v.id ORDER BY id DESC LIMIT 1) l ON true
                               WHERE ($1='all' OR v.status=$1) ORDER BY v.submitted_at DESC NULLS LAST, v.id DESC LIMIT 200`, [status]);
  const events = await db.many("SELECT id, name, starts_at FROM auction_events WHERE status='scheduled' ORDER BY starts_at");
  view(res, 'vehicles', { rows, status, events, title: 'Vehicles & approvals' });
});
// Alta y edición de vehículos por el administrador (en nombre de cualquier vendedor)
async function vehicleFormRefs() {
  const [makes, types, damages, locations, sellers] = await Promise.all([catalog.makesWithModels(), db.many('SELECT code, name FROM vehicle_types ORDER BY name'), db.many('SELECT code, name FROM damage_types ORDER BY name'), db.many('SELECT code, name FROM locations WHERE active ORDER BY name'), db.many('SELECT s.id, s.company_name, s.seller_type, u.email FROM sellers s JOIN users u ON u.id=s.user_id ORDER BY s.company_name')]);
  return { makes, types, damages, locations, sellers };
}
const adminForm = { apiBase: '/api/v1/admin/vehicles', backHref: '/admin/vehicles?status=all', adminMode: true };
admin.get('/vehicles/new', requirePerm('vehicles.approve'), async (req, res) => res.render('panel/seller/vehicle-form', { ...adminForm, v: null, images: [], docs: [], lot: null, ...(await vehicleFormRefs()), title: 'Add vehicle' }));
admin.get('/vehicles/:id/edit', requirePerm('vehicles.approve'), async (req, res) => {
  const v = await db.one(`SELECT v.*, vt.code AS type_code, d1.code AS damage1, d2.code AS damage2, loc.code AS location_code FROM vehicles v JOIN vehicle_types vt ON vt.id=v.vehicle_type_id LEFT JOIN damage_types d1 ON d1.id=v.primary_damage_id LEFT JOIN damage_types d2 ON d2.id=v.secondary_damage_id JOIN locations loc ON loc.id=v.location_id WHERE v.id=$1`, [Number(req.params.id) || 0]);
  if (!v) throw notFound();
  const [images, docs, lot] = await Promise.all([db.many('SELECT * FROM vehicle_images WHERE vehicle_id=$1 ORDER BY sort, id', [v.id]), db.many('SELECT * FROM vehicle_documents WHERE vehicle_id=$1 ORDER BY id', [v.id]), db.one('SELECT * FROM auction_lots WHERE vehicle_id=$1 ORDER BY id DESC LIMIT 1', [v.id])]);
  res.render('panel/seller/vehicle-form', { ...adminForm, v, images, docs, lot, ...(await vehicleFormRefs()), title: `Edit vehicle #${v.id}` });
});
admin.get('/payments', requirePerm('settings.manage'), async (req, res) => {
  const payments = require('../services/payments');
  const stats = await db.one(`SELECT (SELECT COUNT(*)::int FROM payment_methods) AS cards, (SELECT COUNT(*)::int FROM deposits WHERE status='held') AS deposits,
                                     (SELECT COALESCE(SUM(amount_cents),0)::bigint FROM deposits WHERE status='held') AS deposits_total,
                                     (SELECT COUNT(*)::int FROM deposits WHERE status='refund_requested') AS refunds,
                                     (SELECT COUNT(*)::int FROM payments WHERE method='card_demo') AS card_payments, (SELECT COUNT(*)::int FROM payments WHERE method='bank_transfer') AS transfers,
                                     (SELECT COALESCE(SUM(amount_cents),0)::bigint FROM payments WHERE status='approved') AS collected`);
  const bank = await db.one("SELECT value FROM system_settings WHERE key='bank_details'");
  view(res, 'payments-config', { providers: payments.status(), active: payments.activeProviderCode(), stats, bank: bank && bank.value, title: 'Payment gateways' });
});
admin.get('/roles', requirePerm('roles.manage'), async (req, res) => {
  const [roles, perms, grants] = await Promise.all([
    db.many('SELECT r.*, (SELECT COUNT(*)::int FROM user_roles ur WHERE ur.role_id=r.id) AS users FROM roles r ORDER BY r.is_system DESC, r.id'),
    db.many('SELECT * FROM permissions ORDER BY code'),
    db.many('SELECT rp.role_id, p.code FROM role_permissions rp JOIN permissions p ON p.id=rp.permission_id'),
  ]);
  for (const r of roles) r.perms = grants.filter(g => g.role_id === r.id).map(g => g.code);
  view(res, 'roles', { roles, perms, title: 'Roles & permissions' });
});
admin.get('/vehicles/:id', requirePerm('vehicles.approve'), async (req, res) => {
  const v = await db.one(`SELECT v.*, mk.name AS make, md.name AS model, s.company_name, loc.name AS location_name, vt.name AS type_name, d1.name AS damage1, d2.name AS damage2 FROM vehicles v JOIN makes mk ON mk.id=v.make_id JOIN models md ON md.id=v.model_id JOIN sellers s ON s.id=v.seller_id JOIN locations loc ON loc.id=v.location_id JOIN vehicle_types vt ON vt.id=v.vehicle_type_id LEFT JOIN damage_types d1 ON d1.id=v.primary_damage_id LEFT JOIN damage_types d2 ON d2.id=v.secondary_damage_id WHERE v.id=$1`, [Number(req.params.id)]);
  if (!v) throw notFound();
  const [images, docs, lots, events] = await Promise.all([db.many('SELECT * FROM vehicle_images WHERE vehicle_id=$1 ORDER BY sort', [v.id]), db.many('SELECT * FROM vehicle_documents WHERE vehicle_id=$1', [v.id]), db.many('SELECT l.*, e.name AS event_name FROM auction_lots l JOIN auction_events e ON e.id=l.event_id WHERE vehicle_id=$1 ORDER BY l.id DESC', [v.id]), db.many("SELECT id, name, starts_at FROM auction_events WHERE status='scheduled' ORDER BY starts_at")]);
  view(res, 'vehicle', { v, images, docs, lots, events, title: `Vehicle #${v.id}` });
});
admin.get('/auctions', requirePerm('auctions.manage'), async (req, res) => {
  const rows = await db.many(`SELECT e.*, loc.name AS location_name, COUNT(l.id) FILTER (WHERE l.status<>'cancelled')::int AS lots, COUNT(l.id) FILTER (WHERE l.status='awarded')::int AS sold, COALESCE(SUM(l.current_bid_cents) FILTER (WHERE l.status='awarded'),0)::bigint AS total
                                FROM auction_events e LEFT JOIN locations loc ON loc.id=e.location_id LEFT JOIN auction_lots l ON l.event_id=e.id GROUP BY e.id, loc.name ORDER BY e.status='live' DESC, e.starts_at DESC`);
  view(res, 'auctions', { rows, locations: await db.many('SELECT id, name FROM locations WHERE active ORDER BY name'), title: 'Auctions & lots' });
});
admin.get('/auctions/:id', requirePerm('auctions.manage'), async (req, res) => {
  const ev = await db.one('SELECT * FROM auction_events WHERE id=$1', [Number(req.params.id)]);
  if (!ev) throw notFound();
  const lots = (await catalog.searchLots({ event: ev.id, status: 'all' }, { perPage: 200 })).items;
  view(res, 'auction', { ev, lots, locations: await db.many('SELECT id, name FROM locations WHERE active ORDER BY name'), title: ev.name });
});
admin.get('/bids', requirePerm('auctions.manage'), async (req, res) => {
  const rows = await db.many(`SELECT b.*, l.lot_number, u.email, l.status AS lot_status FROM bids b JOIN auction_lots l ON l.id=b.lot_id JOIN users u ON u.id=b.user_id ORDER BY b.id DESC LIMIT 150`);
  const live = await db.many(`SELECT l.*, e.name AS event_name, mk.name AS make, md.name AS model, v.year FROM auction_lots l JOIN auction_events e ON e.id=l.event_id JOIN vehicles v ON v.id=l.vehicle_id JOIN makes mk ON mk.id=v.make_id JOIN models md ON md.id=v.model_id WHERE l.status='live'`);
  view(res, 'bids', { rows, live, title: 'Bid monitor' });
});
admin.get('/memberships', requirePerm('settings.manage'), async (req, res) => {
  const plans = await db.many('SELECT mp.*, (SELECT COUNT(*)::int FROM subscriptions s WHERE s.plan_id=mp.id AND s.status=\'active\') AS members FROM membership_plans mp ORDER BY sort');
  const increments = await db.one("SELECT value FROM system_settings WHERE key='bid_increments'");
  view(res, 'memberships', { plans, increments: increments.value, title: 'Memberships & bidding limits' });
});
admin.get('/catalog', requirePerm('catalog.manage'), async (req, res) => {
  const [makes, types, damages] = await Promise.all([catalog.makesWithModels(), db.many('SELECT * FROM vehicle_types ORDER BY name'), db.many('SELECT * FROM damage_types ORDER BY name')]);
  view(res, 'catalog', { makes, types, damages, title: 'Catalog' });
});
admin.get('/locations', requirePerm('locations.manage'), async (req, res) => view(res, 'locations', { rows: await db.many('SELECT loc.*, (SELECT COUNT(*)::int FROM vehicles v WHERE v.location_id=loc.id) AS vehicles FROM locations loc ORDER BY name'), edit: req.query.edit ? await db.one('SELECT * FROM locations WHERE id=$1', [Number(req.query.edit)]) : null, title: 'Yards' }));
admin.get('/announcements', requirePerm('content.manage'), async (req, res) => {
  const rows = await db.many(`SELECT a.*, (SELECT COUNT(*)::int FROM announcement_dismissals d WHERE d.announcement_id=a.id) AS dismissed,
                                     (a.active AND a.starts_at<=now() AND (a.ends_at IS NULL OR a.ends_at>now())) AS live
                                FROM announcements a ORDER BY a.id DESC`);
  view(res, 'announcements', { rows, edit: req.query.edit ? await db.one('SELECT * FROM announcements WHERE id=$1', [Number(req.query.edit)]) : null, title: 'Announcements' });
});
admin.get('/social-login', requirePerm('settings.manage'), async (req, res) => {
  const social = require('../services/social-auth');
  const base = process.env.OAUTH_BASE_URL || `${req.protocol}://${req.get('host')}`;
  const providers = social.status().map(p => ({ ...p, redirectUri: social.redirectUri(base, p.code) }));
  const linked = await db.one('SELECT COUNT(*)::int AS n, COUNT(DISTINCT user_id)::int AS users FROM oauth_identities');
  view(res, 'social-login', { providers, base, linked, title: 'Social sign-in' });
});
admin.get('/content', requirePerm('content.manage'), async (req, res) => view(res, 'content', { pages: await db.many('SELECT * FROM content_pages ORDER BY slug'), banners: await db.many('SELECT * FROM banners ORDER BY id'), edit: req.query.page ? await db.one('SELECT * FROM content_pages WHERE slug=$1', [req.query.page]) : null, title: 'Content & banners' }));
admin.get('/support', requirePerm('support.manage'), async (req, res) => view(res, 'support', { rows: await db.many("SELECT * FROM support_tickets ORDER BY status='closed', id DESC LIMIT 200"), title: 'Support tickets' }));
admin.get('/settings', requirePerm('settings.manage'), async (req, res) => view(res, 'settings', { rows: await db.many("SELECT * FROM system_settings WHERE key <> 'demo_seeded_at' ORDER BY key"), title: 'Settings' }));
admin.get('/audit', requirePerm('audit.view'), async (req, res) => {
  const q = String(req.query.q || '').trim(), p = pageNum(req);
  const rows = await db.many(`SELECT a.*, u.email FROM audit_logs a LEFT JOIN users u ON u.id=a.actor_id WHERE ($1='' OR a.action ILIKE '%'||$1||'%' OR a.entity ILIKE '%'||$1||'%' OR u.email ILIKE '%'||$1||'%') ORDER BY a.id DESC LIMIT 50 OFFSET ${(p - 1) * 50}`, [q]);
  view(res, 'audit', { rows, q, page: p, title: 'Audit log' });
});
admin.get('/mailbox', requirePerm('settings.manage'), async (req, res) => view(res, 'mailbox', { rows: await db.many('SELECT * FROM email_outbox ORDER BY id DESC LIMIT 100'), title: 'Demo mailbox' }));
admin.get('/reports', requirePerm('reports.view'), async (req, res) => {
  const summary = await db.one(`SELECT (SELECT COUNT(*)::int FROM sale_orders) AS orders, (SELECT COALESCE(SUM(hammer_cents),0)::bigint FROM sale_orders WHERE status<>'cancelled') AS gmv,
     (SELECT COALESCE(SUM(amount_cents),0)::bigint FROM payments WHERE status='approved') AS collected, (SELECT COUNT(*)::int FROM bids) AS bids,
     (SELECT ROUND(100.0*COUNT(*) FILTER (WHERE status='awarded')/NULLIF(COUNT(*) FILTER (WHERE status IN ('awarded','no_sale','pending_seller_approval')),0),1) FROM auction_lots) AS sell_through`);
  const byMake = await db.many(`SELECT mk.name, COUNT(o.id)::int AS n, COALESCE(SUM(o.hammer_cents),0)::bigint AS total FROM sale_orders o JOIN auction_lots l ON l.id=o.lot_id JOIN vehicles v ON v.id=l.vehicle_id JOIN makes mk ON mk.id=v.make_id GROUP BY mk.name ORDER BY total DESC LIMIT 8`);
  view(res, 'reports', { reports: Object.entries(REPORTS).filter(([, r]) => !r.perm || req.user.has(r.perm)), summary, byMake, title: 'Reports' });
});

// ───────────── FINANZAS ─────────────
const finance = express.Router();
finance.use(requireAuth, requirePerm('finance.review'));
finance.use((req, res, next) => { setNav(res, req.user, FIN_NAV, 'Finance'); next(); });
finance.get('/', async (req, res) => {
  const status = req.query.status || 'pending_review';
  const rows = await db.many(`SELECT p.*, i.invoice_number, i.total_cents, i.paid_cents, i.kind, o.order_number, u.email, pr.first_name, pr.last_name, (SELECT id FROM payment_proofs WHERE payment_id=p.id LIMIT 1) AS proof_id
                                FROM payments p JOIN invoices i ON i.id=p.invoice_id LEFT JOIN sale_orders o ON o.id=i.order_id JOIN users u ON u.id=p.user_id JOIN profiles pr ON pr.user_id=u.id
                               WHERE ($1='all' OR p.status=$1) ORDER BY p.id DESC LIMIT 200`, [status]);
  const k = await db.one(`SELECT (SELECT COUNT(*)::int FROM payments WHERE status='pending_review') AS pending, (SELECT COALESCE(SUM(amount_cents),0)::bigint FROM payments WHERE status='pending_review') AS pending_amount,
                                 (SELECT COALESCE(SUM(amount_cents),0)::bigint FROM payments WHERE status='approved' AND reviewed_at > now() - interval '30 days') AS collected_30d,
                                 (SELECT COALESCE(SUM(total_cents-paid_cents),0)::bigint FROM invoices WHERE status IN ('issued','partially_paid')) AS receivable,
                                 (SELECT COUNT(*)::int FROM invoices WHERE status IN ('issued','partially_paid') AND due_at < now()) AS overdue`);
  view(res, 'finance-payments', { rows, status, k, title: 'Finance – payments queue' });
});
finance.get('/invoices', async (req, res) => {
  const status = req.query.status || 'all';
  const rows = await db.many(`SELECT i.*, u.email, o.order_number, o.status AS order_status FROM invoices i JOIN users u ON u.id=i.user_id LEFT JOIN sale_orders o ON o.id=i.order_id WHERE ($1='all' OR i.status=$1) ORDER BY i.id DESC LIMIT 300`, [status]);
  view(res, 'finance-invoices', { rows, status, title: 'Finance – invoices' });
});
finance.get('/balances', async (req, res) => {
  const rows = await db.many(`SELECT u.id, u.email, pr.first_name, pr.last_name, pr.company_name, COUNT(i.id)::int AS invoices, SUM(i.total_cents-i.paid_cents)::bigint AS outstanding, MIN(i.due_at) AS oldest_due
                                FROM invoices i JOIN users u ON u.id=i.user_id JOIN profiles pr ON pr.user_id=u.id WHERE i.status IN ('issued','partially_paid') GROUP BY u.id, pr.user_id ORDER BY outstanding DESC`);
  const orders = await db.many(`SELECT o.*, u.email FROM sale_orders o JOIN users u ON u.id=o.buyer_id WHERE o.status IN ('pending_payment','payment_review') ORDER BY o.created_at`);
  const deposits = await db.many(`SELECT d.*, u.email, pm.brand, pm.last4 FROM deposits d JOIN users u ON u.id=d.user_id LEFT JOIN payment_methods pm ON pm.id=d.payment_method_id ORDER BY d.status='refund_requested' DESC, d.id DESC LIMIT 100`);
  view(res, 'finance-balances', { rows, orders, deposits, title: 'Finance – outstanding balances' });
});

// ───────────── LOGÍSTICA ─────────────
const ops = express.Router();
ops.use(requireAuth, requirePerm('logistics.manage'));
ops.use((req, res, next) => { setNav(res, req.user, OPS_NAV, 'Operations & Logistics'); next(); });
const orderSql = `SELECT o.*, l.lot_number, v.year, mk.name AS make, md.name AS model, loc.name AS yard, loc.code AS yard_code, u.email, pr.first_name, pr.last_name,
                         pp.status AS pass_status, pp.failed_attempts
                    FROM sale_orders o JOIN auction_lots l ON l.id=o.lot_id JOIN vehicles v ON v.id=l.vehicle_id JOIN makes mk ON mk.id=v.make_id JOIN models md ON md.id=v.model_id
                    JOIN locations loc ON loc.id=v.location_id JOIN users u ON u.id=o.buyer_id JOIN profiles pr ON pr.user_id=u.id LEFT JOIN pickup_passes pp ON pp.order_id=o.id`;
ops.get('/', async (req, res) => {
  const k = await db.one(`SELECT (SELECT COUNT(*)::int FROM sale_orders WHERE status='ready_for_pickup') AS ready, (SELECT COUNT(*)::int FROM transport_orders WHERE status IN ('requested','assigned','picked_up','in_transit')) AS transport,
                                 (SELECT COUNT(*)::int FROM sale_orders WHERE status='completed' AND updated_at > now() - interval '7 days') AS done_7d, (SELECT COUNT(*)::int FROM sale_orders WHERE status IN ('pending_payment','payment_review')) AS awaiting_payment`);
  const rows = await db.many(`${orderSql} ORDER BY o.updated_at DESC LIMIT 30`);
  const byYard = await db.many(`SELECT loc.name, COUNT(v.id) FILTER (WHERE v.status IN ('approved','sold'))::int AS stock, COUNT(o.id) FILTER (WHERE o.status='ready_for_pickup')::int AS ready FROM locations loc LEFT JOIN vehicles v ON v.location_id=loc.id LEFT JOIN auction_lots l ON l.vehicle_id=v.id LEFT JOIN sale_orders o ON o.lot_id=l.id GROUP BY loc.id ORDER BY loc.name`);
  view(res, 'ops-overview', { k, rows, byYard, title: 'Logistics overview' });
});
ops.get('/pickups', requirePerm('pickup.validate'), async (req, res) => view(res, 'ops-pickups', { rows: await db.many(`${orderSql} WHERE o.status IN ('ready_for_pickup','completed') ORDER BY o.status='completed', o.updated_at DESC LIMIT 100`), title: 'Pickup validation' }));
ops.get('/transport', async (req, res) => {
  const rows = await db.many(`SELECT t.*, q.service, q.destination_address, q.destination_city, q.destination_postal_code, q.distance_km, q.price_cents, o.order_number, o.status AS order_status, loc.name AS origin,
                                     (SELECT status FROM invoices WHERE order_id=o.id AND kind='transport' ORDER BY id DESC LIMIT 1) AS invoice_status
                                FROM transport_orders t JOIN transport_quotes q ON q.id=t.quote_id JOIN sale_orders o ON o.id=t.order_id JOIN locations loc ON loc.id=q.origin_location_id ORDER BY t.status='delivered', t.id DESC`);
  view(res, 'ops-transport', { rows, title: 'Transport orders' });
});
ops.get('/yards', async (req, res) => view(res, 'ops-yards', { rows: await db.many(`SELECT loc.*, COUNT(v.id) FILTER (WHERE v.status='approved')::int AS listed, COUNT(v.id) FILTER (WHERE v.status='sold')::int AS sold FROM locations loc LEFT JOIN vehicles v ON v.location_id=loc.id GROUP BY loc.id ORDER BY loc.name`), title: 'Yards' }));

router.use('/admin', admin);
router.use('/finance', finance);
router.use('/ops', ops);
module.exports = router;
