'use strict';
/** API del personal: administración, finanzas y logística. Cada endpoint exige un permiso (RBAC en servidor). */
const express = require('express');
const db = require('../../db');
const { z, parse, optInt, optStr, bool, euros } = require('../../lib/validate');
const { requirePerm, hashPassword } = require('../../lib/auth');
const { notFound, conflict, bad, forbidden } = require('../../lib/errors');
const { audit } = require('../../lib/audit');
const { notify, email } = require('../../lib/notify');
const settings = require('../../lib/settings');
const { resetBannerCache } = require('../../lib/viewHelpers');
const engine = require('../../services/auctionEngine');
const orders = require('../../services/orders');
const alerts = require('../../services/alerts');
const reports = require('../../services/reports');
const router = express.Router();
const A = (req, action, entity, entityId, data) => audit(null, { actorId: req.user.id, action, entity, entityId, data, ip: req.ip });

// ── Usuarios, roles y membresías ──
router.patch('/admin/users/:id', requirePerm('users.manage'), async (req, res) => {
  const d = parse(z.object({ status: z.enum(['active', 'suspended']), verification_status: z.enum(['unverified', 'pending', 'approved', 'rejected']), roles: z.array(z.string().max(32)).min(1, 'Select at least one role'), plan: z.enum(['none', 'guest', 'basic', 'premium']) }),
    { ...req.body, roles: [].concat(req.body.roles || []) });
  await assertRoles(d.roles);
  const id = Number(req.params.id);
  if (id === req.user.id && (!d.roles.includes('admin') || d.status !== 'active')) throw conflict('You cannot remove your own admin role or suspend yourself.');
  if (d.roles.includes('admin') && !req.user.is('admin')) throw forbidden('Only administrators can grant the administrator role.');
  await db.tx(async c => {
    const u = await c.one('SELECT id FROM users WHERE id=$1 FOR UPDATE', [id]); if (!u) throw notFound();
    await c.query('UPDATE users SET status=$2, verification_status=$3 WHERE id=$1', [id, d.status, d.verification_status]);
    await c.query('DELETE FROM user_roles WHERE user_id=$1', [id]);
    await c.query('INSERT INTO user_roles(user_id, role_id) SELECT $1, id FROM roles WHERE code = ANY($2)', [id, d.roles]);
    if (d.status === 'suspended') await c.query('DELETE FROM sessions WHERE user_id=$1', [id]);
    const cur = await c.one("SELECT mp.code FROM subscriptions s JOIN membership_plans mp ON mp.id=s.plan_id WHERE s.user_id=$1 AND s.status='active'", [id]);
    if ((cur?.code || 'none') !== d.plan) {
      await c.query("UPDATE subscriptions SET status='cancelled' WHERE user_id=$1 AND status IN ('active','pending_payment')", [id]);
      if (d.plan !== 'none') await c.query("INSERT INTO subscriptions(user_id, plan_id, status, starts_at, ends_at, payment_reference) SELECT $1, id, 'active', now(), now() + interval '1 year', 'ADMIN' FROM membership_plans WHERE code=$2", [id, d.plan]);
    }
    if (d.roles.includes('seller')) await c.query("INSERT INTO sellers(user_id, company_name, seller_type, approved) SELECT $1, COALESCE(p.company_name, p.first_name || ' ' || p.last_name), 'individual', true FROM profiles p WHERE p.user_id=$1 ON CONFLICT (user_id) DO NOTHING", [id]);
    await notify(c, id, { title: 'Your account was updated', body: `Status: ${d.status} · Verification: ${d.verification_status} · Plan: ${d.plan}`, link: '/dashboard' });
    await audit(c, { actorId: req.user.id, action: 'user.update', entity: 'user', entityId: id, data: d, ip: req.ip });
  });
  res.json({ ok: true, message: 'User updated.' });
});
/** Valida que los códigos de rol existan en la base de datos (incluye roles personalizados). */
async function assertRoles(codes) {
  const found = await db.many('SELECT code FROM roles WHERE code = ANY($1)', [codes]);
  if (found.length !== new Set(codes).size) throw bad('roles: Unknown role', { fields: { roles: 'Unknown role' } });
}
// Alta de usuarios por el propietario: cualquier rol (también personalizado), plan, verificación y empresa.
router.post('/admin/users', requirePerm('users.manage'), async (req, res) => {
  const d = parse(z.object({
    email: z.string().trim().toLowerCase().email('Enter a valid email'), first_name: z.string().trim().min(2, 'At least 2 characters').max(60), last_name: z.string().trim().min(2, 'At least 2 characters').max(80),
    roles: z.array(z.string().max(32)).min(1, 'Select at least one role'), password: z.string().min(10, 'Temporary password: at least 10 characters').max(128),
    plan: z.enum(['none', 'guest', 'basic', 'premium']).default('none'), verification_status: z.enum(['unverified', 'pending', 'approved']).default('approved'),
    account_type: z.enum(['individual', 'business']).default('individual'), company_name: optStr(120), phone: z.preprocess(v => (v === '' ? undefined : v), z.string().trim().regex(/^\d{6,15}$/, 'Numbers only (6–15)').optional()),
    city: optStr(80), seller_company: optStr(120), notify_user: bool().optional(),
  }), { ...req.body, roles: [].concat(req.body.roles || req.body.role || []) });
  await assertRoles(d.roles);
  if (d.roles.includes('admin') && !req.user.is('admin')) throw forbidden('Only administrators can create administrators.');
  if (await db.one('SELECT 1 FROM users WHERE lower(email)=$1', [d.email])) throw conflict('Email already registered.', 'EMAIL_TAKEN');
  const hash = await hashPassword(d.password);
  const id = await db.tx(async c => {
    const u = await c.one("INSERT INTO users(email, password_hash, registration_step, account_type, verification_status) VALUES ($1,$2,'complete',$3,$4) RETURNING id", [d.email, hash, d.account_type, d.verification_status]);
    await c.query('INSERT INTO profiles(user_id, first_name, last_name, phone, company_name, city, terms_accepted_at) VALUES ($1,$2,$3,$4,$5,$6,now())', [u.id, d.first_name, d.last_name, d.phone || '', d.company_name || null, d.city || '']);
    await c.query('INSERT INTO user_roles(user_id, role_id) SELECT $1, id FROM roles WHERE code = ANY($2)', [u.id, d.roles]);
    if (d.plan !== 'none') await c.query("INSERT INTO subscriptions(user_id, plan_id, status, starts_at, ends_at, payment_reference) SELECT $1, id, 'active', now(), now() + interval '1 year', 'ADMIN' FROM membership_plans WHERE code=$2", [u.id, d.plan]);
    if (d.roles.includes('seller')) await c.query("INSERT INTO sellers(user_id, company_name, seller_type, approved) VALUES ($1,$2,$3,true)", [u.id, d.seller_company || d.company_name || `${d.first_name} ${d.last_name}`, d.account_type === 'business' ? 'dealer' : 'individual']);
    if (d.notify_user !== false) await email(c, d.email, 'Your copart account (demo)', `Hi ${d.first_name}, an administrator created your account.\nEmail: ${d.email}\nTemporary password: (given to you by the administrator)\nPlease change it after signing in (Profile & Security).`);
    await audit(c, { actorId: req.user.id, action: 'user.create', entity: 'user', entityId: u.id, data: { roles: d.roles, plan: d.plan }, ip: req.ip });
    return u.id;
  });
  res.status(201).json({ ok: true, message: 'User created.', id, redirect: `/admin/users/${id}` });
});
router.post('/admin/documents/:id/review', requirePerm('documents.review'), async (req, res) => {
  const d = parse(z.object({ approve: bool(), reason: optStr(300) }), req.body);
  if (!d.approve && !d.reason) throw bad('Give a reason when rejecting a document.');
  await db.tx(async c => {
    const doc = await c.one('SELECT * FROM verification_documents WHERE id=$1 FOR UPDATE', [Number(req.params.id)]);
    if (!doc) throw notFound();
    if (doc.status !== 'pending') throw conflict('Document already reviewed.');
    await c.query('UPDATE verification_documents SET status=$2, rejection_reason=$3, reviewed_by=$4, reviewed_at=now() WHERE id=$1', [doc.id, d.approve ? 'approved' : 'rejected', d.reason || null, req.user.id]);
    const pending = await c.one("SELECT COUNT(*)::int n FROM verification_documents WHERE user_id=$1 AND status='pending'", [doc.user_id]);
    const vstatus = d.approve ? 'approved' : (pending.n ? 'pending' : 'rejected');
    await c.query('UPDATE users SET verification_status=$2 WHERE id=$1', [doc.user_id, vstatus]);
    await notify(c, doc.user_id, { title: d.approve ? 'Documents approved' : 'Document rejected', body: d.approve ? 'Your account is verified. You can bid if your membership allows it.' : `Reason: ${d.reason}`, link: '/dashboard/documents' });
    await audit(c, { actorId: req.user.id, action: d.approve ? 'document.approve' : 'document.reject', entity: 'verification_document', entityId: doc.id, data: { reason: d.reason }, ip: req.ip });
  });
  res.json({ ok: true, message: d.approve ? 'Document approved.' : 'Document rejected.', reload: true });
});
router.post('/admin/sellers/:id/approve', requirePerm('users.manage'), async (req, res) => {
  const { approve } = parse(z.object({ approve: bool() }), req.body);
  const s = await db.one('UPDATE sellers SET approved=$2 WHERE id=$1 RETURNING user_id, company_name', [Number(req.params.id), approve]);
  if (!s) throw notFound();
  await notify(null, s.user_id, { title: approve ? 'Seller account approved' : 'Seller account disabled', body: s.company_name, link: '/seller' });
  await A(req, approve ? 'seller.approve' : 'seller.disable', 'seller', req.params.id);
  res.json({ ok: true, message: approve ? 'Seller approved.' : 'Seller disabled.', reload: true });
});
router.patch('/admin/plans/:id', requirePerm('settings.manage'), async (req, res) => {
  const d = parse(z.object({ name: z.string().trim().min(2).max(40), price: euros(), can_bid: bool(), requires_documents: bool(), max_bid: euros().optional().or(z.literal('').transform(() => undefined)), max_total: euros().optional().or(z.literal('').transform(() => undefined)), max_lots_per_event: optInt(), description: z.string().trim().max(300), active: bool() }), req.body);
  const p = await db.one('UPDATE membership_plans SET name=$2, price_cents=$3, can_bid=$4, requires_documents=$5, max_bid_cents=$6, max_total_cents=$7, max_lots_per_event=$8, description=$9, active=$10 WHERE id=$1 RETURNING id',
    [Number(req.params.id), d.name, d.price, d.can_bid, d.requires_documents, d.max_bid || null, d.max_total || null, d.max_lots_per_event || null, d.description, d.active]);
  if (!p) throw notFound();
  await A(req, 'plan.update', 'membership_plan', p.id, d);
  res.json({ ok: true, message: 'Membership rules updated.' });
});

// ── Vehículos: aprobación y asignación a subasta ──
router.post('/admin/vehicles/:id/review', requirePerm('vehicles.approve'), async (req, res) => {
  const d = parse(z.object({ approve: bool(), reason: optStr(300), event_id: optInt(), starting_bid: euros().optional(), reserve: euros().optional(), featured: bool().optional(), buy_now: z.preprocess(v => (v === '' || v === null || v === undefined || Number(v) === 0 ? undefined : v), euros().optional()) }), req.body);
  if (d.approve && d.buy_now && d.buy_now <= Math.max(d.starting_bid || 0, d.reserve || 0)) throw bad('buy_now: Buy It Now must be above the starting bid and the reserve', { fields: { buy_now: 'Must be above starting bid and reserve' } });
  const out = await db.tx(async c => {
    const v = await c.one('SELECT * FROM vehicles WHERE id=$1 FOR UPDATE', [Number(req.params.id)]);
    if (!v) throw notFound();
    if (!['pending_approval', 'approved'].includes(v.status)) throw conflict(`Vehicle is ${v.status}; it cannot be reviewed.`);
    const s = await c.one('SELECT user_id FROM sellers WHERE id=$1', [v.seller_id]);
    if (!d.approve) {
      if (!d.reason) throw bad('Give a reason when rejecting a vehicle.');
      await c.query("UPDATE vehicles SET status='rejected', rejection_reason=$2 WHERE id=$1", [v.id, d.reason]);
      await notify(c, s.user_id, { title: `Vehicle #${v.id} rejected`, body: d.reason, link: `/seller/vehicles/${v.id}/edit` });
      await audit(c, { actorId: req.user.id, action: 'vehicle.reject', entity: 'vehicle', entityId: v.id, data: { reason: d.reason }, ip: req.ip });
      return { message: 'Vehicle rejected.' };
    }
    if (!d.event_id || !d.starting_bid) throw bad('Select an auction and a starting bid to publish the vehicle.');
    const ev = await c.one("SELECT * FROM auction_events WHERE id=$1 AND status='scheduled' FOR UPDATE", [d.event_id]);
    if (!ev) throw bad('Choose a scheduled (not live or ended) auction.');
    const seq = (await c.one('SELECT COALESCE(MAX(sequence),0)+1 AS s FROM auction_lots WHERE event_id=$1', [ev.id])).s;
    const num = (await c.one('SELECT GREATEST(COALESCE(MAX(lot_number), 50730000) + 1 + floor(random()*40)::int, 50730000) AS n FROM auction_lots')).n;
    const lot = await c.one('INSERT INTO auction_lots(lot_number, event_id, vehicle_id, sequence, status, starting_bid_cents, reserve_cents, buy_now_cents) VALUES ($1,$2,$3,$4,\'prebidding\',$5,$6,$7) RETURNING *', [num, ev.id, v.id, seq, d.starting_bid, d.reserve || 0, d.buy_now || null]);
    await c.query("UPDATE vehicles SET status='approved', approved_at=now(), approved_by=$2, featured=COALESCE($3, featured) WHERE id=$1", [v.id, req.user.id, d.featured ?? null]);
    const matched = await alerts.matchLot(c, lot.id);
    await notify(c, s.user_id, { title: `Vehicle #${v.id} approved – lot #${lot.lot_number}`, body: `Listed in "${ev.name}"`, link: `/lot/${lot.lot_number}` });
    await audit(c, { actorId: req.user.id, action: 'vehicle.approve', entity: 'vehicle', entityId: v.id, data: { lot: Number(lot.lot_number), event: ev.id, alerts_matched: matched }, ip: req.ip });
    return { message: `Approved and published as lot #${lot.lot_number}. ${matched} alert(s) matched.`, lot_number: Number(lot.lot_number) };
  });
  res.json({ ok: true, reload: true, ...out });
});
router.post('/admin/vehicles/:id/withdraw', requirePerm('vehicles.approve'), async (req, res) => {
  await db.tx(async c => {
    const lot = await c.one("SELECT * FROM auction_lots WHERE vehicle_id=$1 AND status IN ('scheduled','prebidding') FOR UPDATE", [Number(req.params.id)]);
    if (lot) await c.query("UPDATE auction_lots SET status='cancelled' WHERE id=$1", [lot.id]);
    const v = await c.one("UPDATE vehicles SET status='withdrawn' WHERE id=$1 AND status IN ('approved','pending_approval') RETURNING id", [Number(req.params.id)]);
    if (!v) throw conflict('Only approved or pending vehicles can be withdrawn.');
    await audit(c, { actorId: req.user.id, action: 'vehicle.withdraw', entity: 'vehicle', entityId: v.id, ip: req.ip });
  });
  res.json({ ok: true, message: 'Vehicle withdrawn.', reload: true });
});

// ── Catálogo y sedes ──
router.post('/admin/catalog/:kind', requirePerm('catalog.manage'), async (req, res) => {
  const kind = req.params.kind;
  if (kind === 'makes') { const d = parse(z.object({ name: z.string().trim().min(1).max(40) }), req.body); await db.query('INSERT INTO makes(name, slug) VALUES ($1,$2)', [d.name, d.name.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-')]); }
  else if (kind === 'models') { const d = parse(z.object({ make_id: z.coerce.number().int(), name: z.string().trim().min(1).max(60) }), req.body); await db.query('INSERT INTO models(make_id, name) VALUES ($1,$2)', [d.make_id, d.name]); }
  else if (kind === 'vehicle-types' || kind === 'damage-types') { const d = parse(z.object({ code: z.string().trim().regex(/^[a-z_]{2,30}$/, 'lowercase code'), name: z.string().trim().min(2).max(60) }), req.body); await db.query(`INSERT INTO ${kind === 'vehicle-types' ? 'vehicle_types' : 'damage_types'}(code, name) VALUES ($1,$2)`, [d.code, d.name]); }
  else throw notFound();
  await A(req, 'catalog.create', kind, null, req.body);
  res.status(201).json({ ok: true, message: 'Created.', reload: true });
});
router.delete('/admin/catalog/:kind/:id', requirePerm('catalog.manage'), async (req, res) => {
  const table = { makes: 'makes', models: 'models', 'vehicle-types': 'vehicle_types', 'damage-types': 'damage_types' }[req.params.kind];
  if (!table) throw notFound();
  try { await db.query(`DELETE FROM ${table} WHERE id=$1`, [Number(req.params.id)]); } catch (e) { if (e.code === '23503') throw conflict('In use by vehicles; cannot delete.'); throw e; }
  await A(req, 'catalog.delete', table, req.params.id);
  res.json({ ok: true, message: 'Deleted.', reload: true });
});
const LocationSchema = z.object({ code: z.string().trim().toUpperCase().regex(/^[A-Z]{2,5}$/, '2–5 letters'), name: z.string().trim().min(3).max(80), address: z.string().trim().min(3).max(160), city: z.string().trim().min(2).max(60), province: z.string().trim().min(2).max(60), postal_code: z.string().trim().regex(/^\d{5}$/), phone: z.string().trim().max(30), email: z.string().trim().email(), hours: z.string().trim().max(120), pickup_hours: z.string().trim().max(120), lat: z.coerce.number().min(-90).max(90), lng: z.coerce.number().min(-180).max(180), description: z.string().trim().max(600).default(''), active: bool() });
router.post('/admin/locations', requirePerm('locations.manage'), async (req, res) => {
  const d = parse(LocationSchema, req.body);
  const r = await db.one('INSERT INTO locations(code,name,address,city,province,postal_code,phone,email,hours,pickup_hours,lat,lng,description,active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id', Object.values(d));
  await A(req, 'location.create', 'location', r.id);
  res.status(201).json({ ok: true, message: 'Yard created.', redirect: '/admin/locations' });
});
router.patch('/admin/locations/:id', requirePerm('locations.manage'), async (req, res) => {
  const d = parse(LocationSchema, req.body);
  const r = await db.one('UPDATE locations SET code=$2,name=$3,address=$4,city=$5,province=$6,postal_code=$7,phone=$8,email=$9,hours=$10,pickup_hours=$11,lat=$12,lng=$13,description=$14,active=$15 WHERE id=$1 RETURNING id', [Number(req.params.id), ...Object.values(d)]);
  if (!r) throw notFound();
  await A(req, 'location.update', 'location', r.id);
  res.json({ ok: true, message: 'Yard updated.' });
});

// ── Subastas ──
const EventSchema = z.object({ name: z.string().trim().min(3).max(80), starts_at: z.string().min(10, 'Choose date and time'), location_id: optInt() });
const madridLocal = s => { // "2026-11-17T11:00" (hora Madrid) → Date
  const d = new Date(`${s}:00Z`); if (isNaN(d)) throw bad('Invalid date');
  const off = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Madrid', timeZoneName: 'shortOffset' }).formatToParts(d).find(p => p.type === 'timeZoneName').value;
  return new Date(d.getTime() - Number(off.replace('GMT', '') || 0) * 3600_000);
};
router.post('/admin/events', requirePerm('auctions.manage'), async (req, res) => {
  const d = parse(EventSchema, req.body);
  const when = madridLocal(d.starts_at);
  if (when < new Date()) throw bad('The auction must start in the future.');
  const e = await db.one('INSERT INTO auction_events(name, starts_at, location_id) VALUES ($1,$2,$3) RETURNING id', [d.name, when, d.location_id || null]);
  await A(req, 'event.create', 'auction_event', e.id, d);
  res.status(201).json({ ok: true, message: 'Auction scheduled.', redirect: `/admin/auctions/${e.id}` });
});
router.patch('/admin/events/:id', requirePerm('auctions.manage'), async (req, res) => {
  const d = parse(EventSchema, req.body);
  const e = await db.one("UPDATE auction_events SET name=$2, starts_at=$3, location_id=$4 WHERE id=$1 AND status='scheduled' RETURNING id", [Number(req.params.id), d.name, madridLocal(d.starts_at), d.location_id || null]);
  if (!e) throw conflict('Only scheduled auctions can be edited.');
  await A(req, 'event.update', 'auction_event', e.id, d);
  res.json({ ok: true, message: 'Auction updated.' });
});
router.post('/admin/events/:id/start', requirePerm('auctions.manage'), async (req, res) => {
  const ev = await db.one('SELECT status FROM auction_events WHERE id=$1', [Number(req.params.id)]);
  if (!ev) throw notFound();
  if (ev.status !== 'scheduled') throw conflict('Only scheduled auctions can be started.');
  await engine.startEvent(Number(req.params.id), req.user.id);
  res.json({ ok: true, message: 'Auction is now LIVE.', redirect: `/auctions/${req.params.id}/live` });
});
router.post('/admin/events/:id/cancel', requirePerm('auctions.manage'), async (req, res) => {
  await db.tx(async c => {
    const e = await c.one("UPDATE auction_events SET status='cancelled' WHERE id=$1 AND status='scheduled' RETURNING id", [Number(req.params.id)]);
    if (!e) throw conflict('Only scheduled auctions can be cancelled.');
    const lots = await c.many("UPDATE auction_lots SET status='cancelled' WHERE event_id=$1 AND status IN ('scheduled','prebidding') RETURNING vehicle_id", [e.id]);
    for (const l of lots) await c.query("UPDATE vehicles SET status='approved' WHERE id=$1", [l.vehicle_id]);
    await audit(c, { actorId: req.user.id, action: 'event.cancel', entity: 'auction_event', entityId: e.id, ip: req.ip });
  });
  res.json({ ok: true, message: 'Auction cancelled; lots returned to inventory.', reload: true });
});
router.patch('/admin/lots/:id', requirePerm('auctions.manage'), async (req, res) => {
  const d = parse(z.object({ starting_bid: euros(), reserve: euros(), buy_now: z.preprocess(v => (v === '' || v === null || v === undefined || Number(v) === 0 ? undefined : v), euros().optional()) }), req.body);
  if (d.starting_bid <= 0) throw bad('starting_bid: The starting bid must be above 0', { fields: { starting_bid: 'Must be above 0' } });
  if (d.buy_now && d.buy_now <= Math.max(d.starting_bid, d.reserve)) throw bad('buy_now: Buy It Now must be above the starting bid and the reserve', { fields: { buy_now: 'Must be above starting bid and reserve' } });
  const l = await db.one("UPDATE auction_lots SET starting_bid_cents=$2, reserve_cents=$3, buy_now_cents=$4, version=version+1 WHERE id=$1 AND status IN ('scheduled','prebidding') AND bid_count=0 RETURNING id", [Number(req.params.id), d.starting_bid, d.reserve, d.buy_now || null]);
  if (!l) throw conflict('Prices can only be changed before the first bid.');
  await A(req, 'lot.update', 'auction_lot', l.id, d);
  res.json({ ok: true, message: 'Lot updated.' });
});
router.post('/admin/lots/:id/cancel', requirePerm('auctions.manage'), async (req, res) => {
  await db.tx(async c => {
    const l = await c.one("UPDATE auction_lots SET status='cancelled' WHERE id=$1 AND status IN ('scheduled','prebidding') RETURNING *", [Number(req.params.id)]);
    if (!l) throw conflict('Only lots that are not live or closed can be cancelled.');
    await c.query("UPDATE vehicles SET status='approved' WHERE id=$1", [l.vehicle_id]);
    const bidders = await c.many('SELECT user_id FROM proxy_bids WHERE lot_id=$1', [l.id]);
    for (const b of bidders) await notify(c, b.user_id, { title: `Lot #${l.lot_number} withdrawn`, body: 'Your pre-bid was cancelled.', link: '/dashboard/bids' });
    await audit(c, { actorId: req.user.id, action: 'lot.cancel', entity: 'auction_lot', entityId: l.id, ip: req.ip });
  });
  res.json({ ok: true, message: 'Lot cancelled.', reload: true });
});

// ── Ajustes, contenido, soporte, alertas ──
router.patch('/admin/settings/:key', requirePerm('settings.manage'), async (req, res) => {
  let value; try { value = JSON.parse(req.body.value); } catch { throw bad('Value must be valid JSON (numbers, text in quotes, objects or arrays).'); }
  const r = await db.one('UPDATE system_settings SET value=$2 WHERE key=$1 RETURNING key', [req.params.key, JSON.stringify(value)]);
  if (!r) throw notFound();
  settings.invalidate();
  await A(req, 'setting.update', 'system_setting', req.params.key, { value });
  res.json({ ok: true, message: `Setting "${req.params.key}" saved.` });
});
router.patch('/admin/pages/:slug', requirePerm('content.manage'), async (req, res) => {
  const d = parse(z.object({ title: z.string().trim().min(2).max(120), body_html: z.string().max(50000), published: bool() }), req.body);
  // Saneado básico: sin scripts ni manejadores de eventos (el contenido lo edita personal autorizado).
  const clean = d.body_html.replace(/<\s*(script|iframe|object|embed|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '').replace(/\son\w+\s*=\s*(["']).*?\1/gi, '').replace(/javascript:/gi, '');
  const r = await db.one('UPDATE content_pages SET title=$2, body_html=$3, published=$4 WHERE slug=$1 RETURNING id', [req.params.slug, d.title, clean, d.published]);
  if (!r) throw notFound();
  await A(req, 'page.update', 'content_page', req.params.slug);
  res.json({ ok: true, message: 'Page saved.' });
});
router.patch('/admin/banners/:id', requirePerm('content.manage'), async (req, res) => {
  const d = parse(z.object({ text: z.string().trim().min(2).max(160), link_text: optStr(40), link_url: z.string().trim().regex(/^\/[\w\-/?=&]*$/, 'Internal URL starting with /').optional().or(z.literal('')), active: bool() }), req.body);
  const r = await db.one('UPDATE banners SET text=$2, link_text=$3, link_url=$4, active=$5 WHERE id=$1 RETURNING id', [Number(req.params.id), d.text, d.link_text || null, d.link_url || null, d.active]);
  if (!r) throw notFound();
  resetBannerCache();
  await A(req, 'banner.update', 'banner', r.id);
  res.json({ ok: true, message: 'Banner saved.' });
});
router.patch('/admin/tickets/:id', requirePerm('support.manage'), async (req, res) => {
  const d = parse(z.object({ status: z.enum(['open', 'in_progress', 'closed']), response: optStr(4000) }), req.body);
  const t = await db.one('UPDATE support_tickets SET status=$2, response=COALESCE($3, response) WHERE id=$1 RETURNING *', [Number(req.params.id), d.status, d.response || null]);
  if (!t) throw notFound();
  if (d.response) { await email(null, t.email, `Re: ${t.subject} (ticket #${t.id})`, d.response); if (t.user_id) await notify(null, t.user_id, { title: `Reply to ticket #${t.id}`, body: d.response.slice(0, 140), link: '/dashboard' }); }
  await A(req, 'ticket.update', 'support_ticket', t.id, { status: d.status });
  res.json({ ok: true, message: 'Ticket updated.', reload: true });
});
router.post('/admin/alerts/digest', requirePerm('settings.manage'), async (req, res) => {
  const { frequency } = parse(z.object({ frequency: z.enum(['daily', 'weekly']) }), req.body);
  const n = await alerts.sendDigest(frequency);
  await A(req, 'alerts.digest', 'vehicle_alert', null, { frequency, emails: n });
  res.json({ ok: true, message: `${n} ${frequency} digest email(s) generated (see Demo mailbox).`, reload: true });
});

// ── Finanzas ──
router.post('/payments/:id/review', requirePerm('finance.review'), async (req, res) => {
  const d = parse(z.object({ approve: bool(), note: optStr(300) }), req.body);
  await orders.reviewPayment({ actor: req.user, paymentId: Number(req.params.id), approve: d.approve, note: d.note, ip: req.ip });
  res.json({ ok: true, message: d.approve ? 'Payment approved and reconciled.' : 'Payment rejected; the buyer has been notified.', reload: true });
});
router.post('/orders/:id/cancel', requirePerm('finance.review'), async (req, res) => {
  const { reason } = parse(z.object({ reason: z.string().trim().min(5, 'Give a reason (min 5 chars)').max(300) }), req.body);
  await db.tx(async c => {
    const o = await c.one('SELECT * FROM sale_orders WHERE id=$1', [Number(req.params.id)]);
    if (!o) throw notFound();
    if (!['pending_payment', 'payment_review'].includes(o.status)) throw conflict('Only unpaid orders can be cancelled.');
    await orders.transition(c, o.id, 'cancelled', { actorId: req.user.id, note: reason });
    await c.query("UPDATE invoices SET status='void' WHERE order_id=$1 AND status IN ('issued','partially_paid')", [o.id]);
    await notify(c, o.buyer_id, { title: `Order ${o.order_number} cancelled`, body: reason, link: `/dashboard/purchases/${o.id}` });
    await audit(c, { actorId: req.user.id, action: 'order.cancel', entity: 'sale_order', entityId: o.id, data: { reason }, ip: req.ip });
  });
  res.json({ ok: true, message: 'Order cancelled and invoice voided.', reload: true });
});

// ── Logística ──
router.post('/pickup-passes/validate', requirePerm('pickup.validate'), async (req, res) => {
  const d = parse(z.object({ order_number: z.string().trim().min(3, 'Enter the order number'), pin: z.string().trim().regex(/^\d{6}$/, 'PIN has 6 digits') }), req.body);
  const r = await orders.validatePickup({ actor: req.user, orderNumber: d.order_number, pin: d.pin, ip: req.ip });
  res.json({ ok: true, message: `PIN correct. Order ${r.order.order_number} released and completed.`, reload: true });
});
const NEXT_T = { requested: ['assigned', 'cancelled'], assigned: ['picked_up', 'cancelled'], picked_up: ['in_transit'], in_transit: ['delivered'], delivered: [], cancelled: [] };
router.post('/transport-orders/:id', requirePerm('logistics.manage'), async (req, res) => {
  const d = parse(z.object({ status: z.enum(['assigned', 'picked_up', 'in_transit', 'delivered', 'cancelled']), carrier_name: optStr(80), eta: optStr(10), note: optStr(300) }), req.body);
  await db.tx(async c => {
    const t = await c.one('SELECT * FROM transport_orders WHERE id=$1 FOR UPDATE', [Number(req.params.id)]);
    if (!t) throw notFound();
    if (!NEXT_T[t.status].includes(d.status)) throw conflict(`Transport cannot move from ${t.status} to ${d.status}.`);
    if (d.status === 'assigned' && !d.carrier_name) throw bad('Enter the carrier name.');
    const inv = await c.one("SELECT status FROM invoices WHERE order_id=$1 AND kind='transport' ORDER BY id DESC LIMIT 1", [t.order_id]);
    if (d.status === 'assigned' && inv?.status !== 'paid') throw conflict('The transport invoice must be paid before assigning a carrier.');
    await c.query('UPDATE transport_orders SET status=$2, carrier_name=COALESCE($3, carrier_name), eta=COALESCE($4::date, eta) WHERE id=$1', [t.id, d.status, d.carrier_name || null, d.eta || null]);
    await c.query('INSERT INTO transport_events(transport_order_id, status, note, actor_id) VALUES ($1,$2,$3,$4)', [t.id, d.status, d.note || '', req.user.id]);
    const o = await c.one('SELECT * FROM sale_orders WHERE id=$1', [t.order_id]);
    if (d.status === 'delivered' && ['in_transport', 'ready_for_pickup'].includes(o.status)) {
      if (o.status === 'ready_for_pickup') await orders.transition(c, o.id, 'in_transport', { actorId: req.user.id });
      await orders.transition(c, o.id, 'completed', { actorId: req.user.id, note: `Delivered by ${d.carrier_name || t.carrier_name}` });
      await c.query("UPDATE pickup_passes SET status='revoked' WHERE order_id=$1 AND status='active'", [o.id]);
    }
    await notify(c, o.buyer_id, { title: `Transport ${t.tracking_code}: ${d.status.replace('_', ' ')}`, body: d.note || '', link: `/dashboard/purchases/${o.id}` });
    await audit(c, { actorId: req.user.id, action: `transport.${d.status}`, entity: 'transport_order', entityId: t.id, data: d, ip: req.ip });
  });
  res.json({ ok: true, message: 'Transport updated.', reload: true });
});

// ── Reportes exportables ──
router.get('/reports/:name.csv', requirePerm('reports.view'), async (req, res) => {
  const r = reports.REPORTS[req.params.name];
  if (!r) throw notFound();
  if (r.perm && !req.user.has(r.perm)) throw forbidden();
  const rows = await r.query(req.query);
  await A(req, 'report.export', 'report', req.params.name, { rows: rows.length });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${req.params.name}-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send('﻿' + reports.toCsv(rows));
});

module.exports = router;
