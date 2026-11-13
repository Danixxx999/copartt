'use strict';
/**
 * API del PROPIETARIO / administrador: control total de la plataforma.
 *  - Suplantación auditada ("Sign in as") y regreso a la cuenta propia
 *  - Edición completa de usuarios: perfil, email, contraseña, sesiones, borrado seguro
 *  - Roles personalizados y matriz de permisos (RBAC editable)
 *  - Alta/edición de vehículos en nombre de cualquier vendedor (fotos y documentos incluidos)
 *  - CMS: crear/borrar páginas y banners
 * Cada endpoint exige un permiso concreto y queda en el registro de auditoría.
 */
const express = require('express');
const db = require('../../db');
const auth = require('../../lib/auth');
const { z, parse, optStr, bool } = require('../../lib/validate');
const { notFound, conflict, bad, forbidden } = require('../../lib/errors');
const { audit } = require('../../lib/audit');
const { notify, email } = require('../../lib/notify');
const { resetBannerCache } = require('../../lib/viewHelpers');
const uploads = require('../../lib/uploads');
const { VehicleSchema, resolveRefs } = require('./seller');
const { requirePerm, requireAuth } = auth;
const router = express.Router();
const A = (req, action, entity, entityId, data) => audit(null, { actorId: req.impersonator ? req.impersonator.id : req.user.id, action, entity, entityId, data: { ...(data || {}), ...(req.impersonator ? { as_user: req.user.id } : {}) }, ip: req.ip });

// ───────── Suplantación ─────────
router.post('/admin/users/:id/impersonate', requirePerm('users.impersonate'), async (req, res) => {
  if (req.impersonator) throw conflict('You are already signed in as another user. Return to your account first.');
  const id = Number(req.params.id);
  if (id === req.user.id) throw bad('You are already signed in as yourself.');
  const target = await auth.loadUserById(id);
  if (!target) throw notFound('User not found.');
  if (target.status !== 'active') throw conflict('Suspended users cannot be accessed. Reactivate the account first.');
  if (target.is('admin')) throw forbidden('For security, other administrators cannot be impersonated.');
  await auth.startImpersonation(req, res, id);
  await audit(null, { actorId: req.user.id, action: 'user.impersonate.start', entity: 'user', entityId: id, data: { target: target.email }, ip: req.ip });
  res.json({ ok: true, message: `You are now signed in as ${target.name}.`, redirect: auth.homeFor(target) });
});
router.post('/auth/impersonation/stop', requireAuth, async (req, res) => {
  if (!req.impersonator) throw bad('You are not impersonating anyone.');
  const targetId = req.user.id;
  const back = await auth.stopImpersonation(req, res);
  await audit(null, { actorId: req.impersonator.id, action: 'user.impersonate.stop', entity: 'user', entityId: targetId, ip: req.ip });
  res.json({ ok: true, message: back ? 'Welcome back to your account.' : 'Session ended. Please sign in again.', redirect: back ? `/admin/users/${targetId}` : '/login' });
});

// ───────── Usuarios: perfil, contraseña, sesiones, borrado ─────────
router.patch('/admin/users/:id/profile', requirePerm('users.manage'), async (req, res) => {
  const d = parse(z.object({
    email: z.string().trim().toLowerCase().email('Enter a valid email'), first_name: z.string().trim().min(2).max(60), last_name: z.string().trim().min(2).max(80),
    phone_prefix: z.string().trim().regex(/^\+\d{1,4}$/, 'Prefix like +34').default('+34'), phone: z.preprocess(v => (v ?? ''), z.string().trim().regex(/^(\d{6,15})?$/, 'Numbers only (6–15)')),
    account_type: z.enum(['individual', 'business']), company_name: optStr(120), tax_id: optStr(30), address: optStr(200), city: optStr(80), postal_code: optStr(10), language: z.enum(['en', 'es']).default('en'),
  }), req.body);
  const id = Number(req.params.id);
  if (await db.one('SELECT 1 FROM users WHERE lower(email)=$1 AND id<>$2', [d.email, id])) throw bad('email: Another account already uses this email', { fields: { email: 'Another account already uses this email' } });
  await db.tx(async c => {
    const u = await c.one('UPDATE users SET email=$2, account_type=$3 WHERE id=$1 RETURNING id', [id, d.email, d.account_type]);
    if (!u) throw notFound();
    await c.query('UPDATE profiles SET first_name=$2, last_name=$3, phone_prefix=$4, phone=$5, company_name=$6, tax_id=$7, address=$8, city=$9, postal_code=$10, language=$11 WHERE user_id=$1',
      [id, d.first_name, d.last_name, d.phone_prefix, d.phone, d.company_name || null, d.tax_id || null, d.address || '', d.city || '', d.postal_code || '', d.language]);
    await audit(c, { actorId: req.user.id, action: 'user.profile_update', entity: 'user', entityId: id, data: { email: d.email }, ip: req.ip });
  });
  res.json({ ok: true, message: 'Profile saved.' });
});
router.post('/admin/users/:id/password', requirePerm('users.manage'), auth.forbidDuringImpersonation, async (req, res) => {
  const d = parse(z.object({ password: z.string().min(10, 'At least 10 characters').max(128), revoke_sessions: bool().optional() }), req.body);
  const id = Number(req.params.id);
  const u = await db.one('SELECT email FROM users WHERE id=$1', [id]);
  if (!u) throw notFound();
  await db.tx(async c => {
    await c.query('UPDATE users SET password_hash=$2 WHERE id=$1', [id, await auth.hashPassword(d.password)]);
    if (d.revoke_sessions !== false && id !== req.user.id) await c.query('DELETE FROM sessions WHERE user_id=$1', [id]);
    await notify(c, id, { title: 'Your password was reset by an administrator', body: 'If you did not request it, contact support.', link: '/dashboard/profile' });
    await email(c, u.email, 'Your password was changed (demo)', 'An administrator set a new password for your copart account. Change it after signing in.');
    await audit(c, { actorId: req.user.id, action: 'user.password_set', entity: 'user', entityId: id, ip: req.ip });
  });
  res.json({ ok: true, message: 'New password saved. Give it to the user securely.' });
});
router.post('/admin/users/:id/sessions/revoke', requirePerm('users.manage'), async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) throw bad('Use "Sign Out" to end your own session.');
  const r = await db.query('DELETE FROM sessions WHERE user_id=$1', [id]);
  await A(req, 'user.sessions_revoke', 'user', id, { sessions: r.rowCount });
  res.json({ ok: true, message: `${r.rowCount} session(s) closed.`, reload: true });
});
router.delete('/admin/users/:id', requirePerm('users.manage'), auth.forbidDuringImpersonation, async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) throw conflict('You cannot delete your own account.');
  const u = await db.one('SELECT email FROM users WHERE id=$1', [id]);
  if (!u) throw notFound();
  try {
    await db.tx(async c => {
      // Tablas sin borrado en cascada que no implican historial económico.
      await c.query('DELETE FROM sellers WHERE user_id=$1 AND NOT EXISTS (SELECT 1 FROM vehicles v WHERE v.seller_id=sellers.id)', [id]);
      await c.query('UPDATE verification_documents SET reviewed_by=NULL WHERE reviewed_by=$1', [id]);
      await c.query('DELETE FROM users WHERE id=$1', [id]);
      await audit(c, { actorId: req.user.id, action: 'user.delete', entity: 'user', entityId: id, data: { email: u.email }, ip: req.ip });
    });
  } catch (e) {
    if (e.code === '23503') throw conflict('This user has bids, purchases, invoices or vehicles and cannot be deleted. Suspend the account instead to keep the history.', 'HAS_HISTORY');
    throw e;
  }
  res.json({ ok: true, message: 'User deleted.', redirect: '/admin/users' });
});

// ───────── Roles y permisos ─────────
const permList = v => [].concat(v || []).map(String);
async function setRolePerms(c, roleId, perms) {
  const valid = await c.many('SELECT id, code FROM permissions WHERE code = ANY($1)', [perms]);
  if (valid.length !== new Set(perms).size) throw bad('Unknown permission.');
  await c.query('DELETE FROM role_permissions WHERE role_id=$1', [roleId]);
  if (valid.length) await c.query('INSERT INTO role_permissions(role_id, permission_id) SELECT $1, unnest($2::int[])', [roleId, valid.map(p => p.id)]);
}
router.post('/admin/roles', requirePerm('roles.manage'), async (req, res) => {
  const d = parse(z.object({ code: z.string().trim().toLowerCase().regex(/^[a-z][a-z0-9_]{1,30}$/, 'Lowercase letters, numbers and _ (2–31)'), name: z.string().trim().min(2).max(60), description: optStr(200) }), req.body);
  const perms = permList(req.body.permissions);
  if (await db.one('SELECT 1 FROM roles WHERE code=$1', [d.code])) throw bad('code: A role with this code already exists', { fields: { code: 'Already exists' } });
  const id = await db.tx(async c => {
    const r = await c.one('INSERT INTO roles(code, name, description, is_system) VALUES ($1,$2,$3,false) RETURNING id', [d.code, d.name, d.description || '']);
    await setRolePerms(c, r.id, perms);
    await audit(c, { actorId: req.user.id, action: 'role.create', entity: 'role', entityId: r.id, data: { code: d.code, permissions: perms }, ip: req.ip });
    return r.id;
  });
  res.status(201).json({ ok: true, message: `Role "${d.name}" created.`, id, reload: true });
});
router.patch('/admin/roles/:id', requirePerm('roles.manage'), async (req, res) => {
  const d = parse(z.object({ name: z.string().trim().min(2).max(60), description: optStr(200) }), req.body);
  const perms = permList(req.body.permissions);
  await db.tx(async c => {
    const role = await c.one('SELECT * FROM roles WHERE id=$1 FOR UPDATE', [Number(req.params.id)]);
    if (!role) throw notFound();
    // Protección anti-bloqueo: el rol administrador conserva siempre la gestión de usuarios y roles.
    if (role.code === 'admin') for (const p of ['users.manage', 'roles.manage']) if (!perms.includes(p)) throw conflict(`The Administrator role must keep "${p}" so nobody gets locked out.`);
    await c.query('UPDATE roles SET name=$2, description=$3 WHERE id=$1', [role.id, d.name, d.description || '']);
    await setRolePerms(c, role.id, perms);
    await audit(c, { actorId: req.user.id, action: 'role.update', entity: 'role', entityId: role.id, data: { code: role.code, permissions: perms }, ip: req.ip });
  });
  res.json({ ok: true, message: 'Role saved. Changes apply on the next page load of each user.' });
});
router.delete('/admin/roles/:id', requirePerm('roles.manage'), async (req, res) => {
  await db.tx(async c => {
    const role = await c.one('SELECT * FROM roles WHERE id=$1 FOR UPDATE', [Number(req.params.id)]);
    if (!role) throw notFound();
    if (role.is_system) throw conflict('System roles cannot be deleted.');
    const n = await c.one('SELECT COUNT(*)::int n FROM user_roles WHERE role_id=$1', [role.id]);
    if (n.n) throw conflict(`${n.n} user(s) still have this role. Remove it from them first.`);
    await c.query('DELETE FROM role_permissions WHERE role_id=$1', [role.id]);
    await c.query('DELETE FROM roles WHERE id=$1', [role.id]);
    await audit(c, { actorId: req.user.id, action: 'role.delete', entity: 'role', entityId: role.id, data: { code: role.code }, ip: req.ip });
  });
  res.json({ ok: true, message: 'Role deleted.', reload: true });
});

// ───────── Vehículos creados/editados por el administrador ─────────
const ADMIN_EDITABLE = ['draft', 'pending_approval', 'approved', 'rejected', 'withdrawn'];
async function anyVehicle(id) {
  const v = await db.one('SELECT * FROM vehicles WHERE id=$1', [Number(id)]);
  if (!v) throw notFound('Vehicle not found.');
  return v;
}
const vehicleValues = (d, r) => [d.make_id, d.model_id, r.type_id, r.d1, r.d2, r.loc, d.year, d.trim || '', d.vin, d.odometer_km, d.fuel, d.transmission, d.engine || '', d.color || '', d.has_keys, d.runs_drives, d.condition, d.document_type, d.highlights || '', d.description || '', d.estimated_value ?? null];
router.post('/admin/vehicles', requirePerm('vehicles.approve'), async (req, res) => {
  const { seller_id } = parse(z.object({ seller_id: z.coerce.number().int().positive('Select the seller') }), req.body);
  const seller = await db.one('SELECT * FROM sellers WHERE id=$1', [seller_id]);
  if (!seller) throw bad('seller_id: Select the seller', { fields: { seller_id: 'Select the seller' } });
  const d = parse(VehicleSchema, req.body); const r = await resolveRefs(d);
  if (await db.one('SELECT 1 FROM vehicles WHERE vin=$1', [d.vin])) throw conflict('A vehicle with this VIN already exists.');
  const v = await db.one(`INSERT INTO vehicles(seller_id, make_id, model_id, vehicle_type_id, primary_damage_id, secondary_damage_id, location_id, year, trim, vin, odometer_km, fuel, transmission, engine, color, has_keys, runs_drives, condition, document_type, highlights, description, estimated_value_cents, status, submitted_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,'pending_approval',now()) RETURNING id`, [seller.id, ...vehicleValues(d, r)]);
  await A(req, 'vehicle.create_admin', 'vehicle', v.id, { seller: seller.company_name });
  res.status(201).json({ ok: true, id: v.id, message: 'Vehicle created. Add photos, then publish it in an auction.', redirect: `/admin/vehicles/${v.id}/edit` });
});
router.patch('/admin/vehicles/:id', requirePerm('vehicles.approve'), async (req, res) => {
  const v = await anyVehicle(req.params.id);
  if (!ADMIN_EDITABLE.includes(v.status)) throw conflict('Sold vehicles cannot be edited.');
  const d = parse(VehicleSchema, req.body); const r = await resolveRefs(d);
  if (await db.one('SELECT 1 FROM vehicles WHERE vin=$1 AND id<>$2', [d.vin, v.id])) throw conflict('Another vehicle already uses this VIN.');
  await db.query(`UPDATE vehicles SET make_id=$2, model_id=$3, vehicle_type_id=$4, primary_damage_id=$5, secondary_damage_id=$6, location_id=$7, year=$8, trim=$9, vin=$10, odometer_km=$11, fuel=$12, transmission=$13, engine=$14, color=$15, has_keys=$16, runs_drives=$17, condition=$18, document_type=$19, highlights=$20, description=$21, estimated_value_cents=$22 WHERE id=$1`,
    [v.id, ...vehicleValues(d, r)]);
  await A(req, 'vehicle.update_admin', 'vehicle', v.id);
  res.json({ ok: true, message: 'Vehicle saved.' });
});
router.post('/admin/vehicles/:id/images', requirePerm('vehicles.approve'), uploads.memory(6, 10).array('images', 10), async (req, res) => {
  const v = await anyVehicle(req.params.id);
  if (!req.files?.length) throw bad('Choose at least one image.');
  const count = (await db.one('SELECT COUNT(*)::int n FROM vehicle_images WHERE vehicle_id=$1', [v.id])).n;
  if (count + req.files.length > 12) throw conflict('Maximum 12 photos per vehicle.');
  const stored = req.files.map(f => uploads.store(f, 'image'));
  for (const [i, s] of stored.entries()) await db.query('INSERT INTO vehicle_images(vehicle_id, path, sort) VALUES ($1,$2,$3)', [v.id, s.path, count + i]);
  await A(req, 'vehicle.images_add', 'vehicle', v.id, { n: stored.length });
  res.status(201).json({ ok: true, message: `${stored.length} photo(s) uploaded.`, reload: true });
});
router.delete('/admin/vehicles/:id/images/:imageId', requirePerm('vehicles.approve'), async (req, res) => {
  const v = await anyVehicle(req.params.id);
  const img = await db.one('DELETE FROM vehicle_images WHERE id=$1 AND vehicle_id=$2 RETURNING path', [Number(req.params.imageId), v.id]);
  if (!img) throw notFound();
  if (img.path.startsWith('/uploads/')) uploads.remove(img.path);
  await A(req, 'vehicle.image_delete', 'vehicle', v.id);
  res.json({ ok: true, message: 'Photo deleted.', reload: true });
});
router.post('/admin/vehicles/:id/documents', requirePerm('vehicles.approve'), uploads.memory(8).single('file'), async (req, res) => {
  const v = await anyVehicle(req.params.id);
  const { doc_type } = parse(z.object({ doc_type: z.enum(['registration', 'technical_sheet', 'insurance_report', 'ownership', 'other']) }), req.body);
  const f = uploads.store(req.file, 'document');
  await db.query('INSERT INTO vehicle_documents(vehicle_id, doc_type, file_path, original_name, mime, size_bytes) VALUES ($1,$2,$3,$4,$5,$6)', [v.id, doc_type, f.path, f.originalname, f.mimetype, f.size]);
  res.status(201).json({ ok: true, message: 'Document uploaded.', reload: true });
});
router.post('/admin/vehicles/:id/featured', requirePerm('vehicles.approve'), async (req, res) => {
  const { featured } = parse(z.object({ featured: bool() }), req.body);
  const v = await db.one('UPDATE vehicles SET featured=$2 WHERE id=$1 RETURNING id', [Number(req.params.id), featured]);
  if (!v) throw notFound();
  await A(req, 'vehicle.featured', 'vehicle', v.id, { featured });
  res.json({ ok: true, message: featured ? 'Shown on the home page (featured).' : 'Removed from featured.', reload: true });
});

// ───────── CMS: páginas y banners ─────────
const CORE_PAGES = ['terms', 'privacy', 'cookie-policy', 'company-details', 'about-us'];
const sanitize = html => html.replace(/<\s*(script|iframe|object|embed|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '').replace(/\son\w+\s*=\s*(["']).*?\1/gi, '').replace(/javascript:/gi, '');
router.post('/admin/pages', requirePerm('content.manage'), async (req, res) => {
  const d = parse(z.object({ slug: z.string().trim().toLowerCase().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Lowercase words separated by -'), title: z.string().trim().min(2).max(120), body_html: z.string().max(50000).default('<p></p>'), published: bool() }), req.body);
  if (await db.one('SELECT 1 FROM content_pages WHERE slug=$1', [d.slug])) throw bad('slug: This address is already used', { fields: { slug: 'Already used' } });
  await db.query('INSERT INTO content_pages(slug, title, body_html, published) VALUES ($1,$2,$3,$4)', [d.slug, d.title, sanitize(d.body_html), d.published]);
  await A(req, 'page.create', 'content_page', d.slug);
  res.status(201).json({ ok: true, message: `Page created at /page/${d.slug}.`, redirect: `/admin/content?page=${d.slug}` });
});
router.delete('/admin/pages/:slug', requirePerm('content.manage'), async (req, res) => {
  if (CORE_PAGES.includes(req.params.slug)) throw conflict('Legal pages linked from the footer cannot be deleted; unpublish or edit them instead.');
  const r = await db.one('DELETE FROM content_pages WHERE slug=$1 RETURNING id', [req.params.slug]);
  if (!r) throw notFound();
  await A(req, 'page.delete', 'content_page', req.params.slug);
  res.json({ ok: true, message: 'Page deleted.', redirect: '/admin/content' });
});
const BannerSchema = z.object({ placement: z.enum(['top', 'home']).default('top'), text: z.string().trim().min(2).max(160), link_text: optStr(40), link_url: z.string().trim().regex(/^\/[\w\-/?=&]*$/, 'Internal URL starting with /').optional().or(z.literal('')), active: bool() });
router.post('/admin/banners', requirePerm('content.manage'), async (req, res) => {
  const d = parse(BannerSchema, req.body);
  const b = await db.one('INSERT INTO banners(placement, text, link_text, link_url, active) VALUES ($1,$2,$3,$4,$5) RETURNING id', [d.placement, d.text, d.link_text || null, d.link_url || null, d.active]);
  resetBannerCache();
  await A(req, 'banner.create', 'banner', b.id);
  res.status(201).json({ ok: true, message: 'Banner created.', reload: true });
});
router.delete('/admin/banners/:id', requirePerm('content.manage'), async (req, res) => {
  const r = await db.one('DELETE FROM banners WHERE id=$1 RETURNING id', [Number(req.params.id)]);
  if (!r) throw notFound();
  resetBannerCache();
  await A(req, 'banner.delete', 'banner', r.id);
  res.json({ ok: true, message: 'Banner deleted.', reload: true });
});

// ───────── Notificación manual a un usuario (soporte) ─────────
router.post('/admin/users/:id/message', requirePerm('users.manage'), async (req, res) => {
  const d = parse(z.object({ title: z.string().trim().min(2).max(120), body: z.string().trim().min(2).max(1000), send_email: bool().optional() }), req.body);
  const u = await db.one('SELECT id, email FROM users WHERE id=$1', [Number(req.params.id)]);
  if (!u) throw notFound();
  await notify(null, u.id, { title: d.title, body: d.body, link: '/dashboard/notifications' });
  if (d.send_email) await email(null, u.email, d.title, d.body);
  await A(req, 'user.message', 'user', u.id, { title: d.title });
  res.json({ ok: true, message: 'Message sent to the user.' });
});

// ───────── Anuncios (alertas / publicidad del dueño) ─────────
const announcements = require('../../services/announcements');
const AnnSchema = z.object({
  title: z.string().trim().min(2, 'Escriba un título').max(140),
  body: z.string().trim().max(600).optional().or(z.literal('')),
  style: z.enum(['info', 'promo', 'alert', 'success']).default('promo'),
  image_url: z.string().trim().regex(/^(\/[\w\-./?=&%]*)?$/, 'URL interna que empieza por /').optional().or(z.literal('')),
  cta_text: optStr(40), cta_url: z.string().trim().regex(/^(\/[\w\-./?=&%]*)?$/, 'URL interna que empieza por /').optional().or(z.literal('')),
  placement: z.enum(['banner', 'feed', 'both']).default('both'),
  audience: z.enum(['all', 'buyers', 'sellers', 'guest', 'basic', 'premium', 'staff']).default('all'),
  dismissible: bool().optional(), active: bool().optional(),
  starts_at: optStr(40), ends_at: optStr(40),
  push_now: bool().optional(),
});
const toTs = s => { if (!s) return null; const d = new Date(s.length <= 16 ? `${s}:00` : s); return isNaN(d) ? null : d; };
router.post('/admin/announcements', requirePerm('content.manage'), async (req, res) => {
  const d = parse(AnnSchema, req.body);
  const a = await db.one(`INSERT INTO announcements(title, body, style, image_url, cta_text, cta_url, placement, audience, dismissible, active, starts_at, ends_at, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE($11, now()),$12,$13) RETURNING *`,
    [d.title, d.body || '', d.style, d.image_url || null, d.cta_text || null, d.cta_url || null, d.placement, d.audience, d.dismissible !== false, d.active !== false, toTs(d.starts_at), toTs(d.ends_at), req.user.id]);
  let pushed = 0;
  if (d.push_now) pushed = await announcements.push(null, a);
  await A(req, 'announcement.create', 'announcement', a.id, { audience: d.audience, pushed });
  res.status(201).json({ ok: true, message: d.push_now ? `Anuncio publicado y enviado a ${pushed} miembro(s).` : 'Anuncio publicado.', reload: true });
});
router.patch('/admin/announcements/:id', requirePerm('content.manage'), async (req, res) => {
  const d = parse(AnnSchema, req.body);
  const a = await db.one(`UPDATE announcements SET title=$2, body=$3, style=$4, image_url=$5, cta_text=$6, cta_url=$7, placement=$8, audience=$9, dismissible=$10, active=$11, starts_at=COALESCE($12, starts_at), ends_at=$13 WHERE id=$1 RETURNING id`,
    [Number(req.params.id), d.title, d.body || '', d.style, d.image_url || null, d.cta_text || null, d.cta_url || null, d.placement, d.audience, d.dismissible !== false, d.active !== false, toTs(d.starts_at), toTs(d.ends_at)]);
  if (!a) throw notFound();
  await A(req, 'announcement.update', 'announcement', a.id);
  res.json({ ok: true, message: 'Anuncio actualizado.', reload: true });
});
router.post('/admin/announcements/:id/push', requirePerm('content.manage'), async (req, res) => {
  const a = await db.one('SELECT * FROM announcements WHERE id=$1', [Number(req.params.id)]);
  if (!a) throw notFound();
  const n = await announcements.push(null, a);
  await A(req, 'announcement.push', 'announcement', a.id, { recipients: n });
  res.json({ ok: true, message: `Enviado al buzón de ${n} miembro(s).`, reload: true });
});
router.delete('/admin/announcements/:id', requirePerm('content.manage'), async (req, res) => {
  const a = await db.one('DELETE FROM announcements WHERE id=$1 RETURNING id', [Number(req.params.id)]);
  if (!a) throw notFound();
  await A(req, 'announcement.delete', 'announcement', a.id);
  res.json({ ok: true, message: 'Anuncio eliminado.', reload: true });
});

module.exports = router;
