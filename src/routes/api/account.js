'use strict';
/** API de "Mi cuenta": datos personales, métodos de pago, depósitos, títulos, preferencias y sesiones. */
const express = require('express');
const db = require('../../db');
const auth = require('../../lib/auth');
const { z, parse, optStr, bool, euros } = require('../../lib/validate');
const { notFound, conflict, bad, forbidden } = require('../../lib/errors');
const { audit } = require('../../lib/audit');
const { notify, email: sendEmail } = require('../../lib/notify');
const payments = require('../../services/payments');
const { LANGS } = require('../../lib/i18n');
const router = express.Router();
const { requireAuth } = auth;
const A = (req, action, entity, entityId, data) => audit(null, { actorId: req.impersonator ? req.impersonator.id : req.user.id, action, entity, entityId, data, ip: req.ip });

// ── Datos personales ──
router.patch('/account/phone', requireAuth, async (req, res) => {
  const d = parse(z.object({ phone_prefix: z.string().trim().regex(/^\+\d{1,4}$/, 'Prefijo como +34'), phone: z.string().trim().regex(/^\d{6,15}$/, 'Solo números (6–15)') }), req.body);
  await db.query('UPDATE profiles SET phone_prefix=$2, phone=$3 WHERE user_id=$1', [req.user.id, d.phone_prefix, d.phone]);
  await A(req, 'account.phone', 'user', req.user.id);
  res.json({ ok: true, message: 'Teléfono actualizado.', reload: true });
});
router.patch('/account/email', requireAuth, auth.forbidDuringImpersonation, async (req, res) => {
  const d = parse(z.object({ email: z.string().trim().toLowerCase().email('Correo no válido'), current_password: z.string().min(1, 'Introduzca su contraseña') }), req.body);
  const row = await db.one('SELECT password_hash, email FROM users WHERE id=$1', [req.user.id]);
  if (!await auth.verifyPassword(row.password_hash, d.current_password)) throw bad('current_password: Contraseña incorrecta', { fields: { current_password: 'Contraseña incorrecta' } });
  if (await db.one('SELECT 1 FROM users WHERE lower(email)=$1 AND id<>$2', [d.email, req.user.id])) throw bad('email: Ya existe una cuenta con ese correo', { fields: { email: 'Ya registrado' } });
  await db.query('UPDATE users SET email=$2 WHERE id=$1', [req.user.id, d.email]);
  await sendEmail(null, row.email, 'Su correo de copart ha cambiado (demo)', `El correo de acceso de su cuenta se cambió a ${d.email}. Si no fue usted, contacte con soporte.`);
  await A(req, 'account.email', 'user', req.user.id, { from: row.email, to: d.email });
  res.json({ ok: true, message: 'Correo electrónico actualizado.', reload: true });
});
router.post('/account/password', requireAuth, auth.forbidDuringImpersonation, async (req, res) => {
  const d = parse(z.object({ current_password: z.string().min(1), new_password: z.string().min(10, 'Mínimo 10 caracteres').regex(/[A-Za-z]/, 'Incluya letras').regex(/\d/, 'Incluya números') }), req.body);
  const row = await db.one('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
  if (!await auth.verifyPassword(row.password_hash, d.current_password)) throw bad('current_password: Contraseña incorrecta', { fields: { current_password: 'Contraseña incorrecta' } });
  await db.query('UPDATE users SET password_hash=$2, password_changed_at=now() WHERE id=$1', [req.user.id, await auth.hashPassword(d.new_password)]);
  await A(req, 'auth.password_change', 'user', req.user.id);
  res.json({ ok: true, message: 'Contraseña actualizada.', reload: true });
});
const Address = z.object({ address: z.string().trim().min(3, 'Dirección obligatoria').max(200), city: z.string().trim().min(2, 'Ciudad obligatoria').max(80), postal_code: z.string().trim().min(3).max(10), country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/).default('ES') });
router.patch('/account/address/:kind', requireAuth, async (req, res) => {
  const d = parse(Address, req.body);
  if (req.params.kind === 'physical') await db.query('UPDATE profiles SET address=$2, city=$3, postal_code=$4, country=$5 WHERE user_id=$1', [req.user.id, d.address, d.city, d.postal_code, d.country]);
  else if (req.params.kind === 'mailing') await db.query('UPDATE profiles SET mail_address=$2, mail_city=$3, mail_postal_code=$4, mail_country=$5 WHERE user_id=$1', [req.user.id, d.address, d.city, d.postal_code, d.country]);
  else throw notFound();
  await A(req, `account.address_${req.params.kind}`, 'user', req.user.id);
  res.json({ ok: true, message: 'Dirección guardada.', reload: true });
});
router.patch('/account/title-name', requireAuth, async (req, res) => {
  const d = parse(z.object({ title_name: z.string().trim().min(3, 'Nombre obligatorio').max(120) }), req.body);
  await db.query('UPDATE profiles SET title_name=$2 WHERE user_id=$1', [req.user.id, d.title_name]);
  res.json({ ok: true, message: 'Titular de los documentos actualizado.', reload: true });
});

// ── Métodos de pago (solo marca, últimos 4 y caducidad) ──
router.post('/account/payment-methods', requireAuth, auth.forbidDuringImpersonation, async (req, res) => {
  const d = parse(z.object({ holder: z.string().trim().min(3, 'Nombre del titular').max(80), number: z.string().transform(s => s.replace(/[\s-]/g, '')).pipe(z.string().regex(/^\d{13,19}$/, 'Número no válido')), exp_month: z.coerce.number().int().min(1).max(12), exp_year: z.coerce.number().int().min(2024).max(2100), cvc: z.string().regex(/^\d{3,4}$/, 'CVC no válido'), make_default: bool().optional() }), req.body);
  if (!payments.luhn(d.number)) throw bad('number: Número de tarjeta no válido', { fields: { number: 'Número no válido' } });
  const p = payments.provider();
  const tok = await p.tokenizeCard({ number: d.number, expMonth: d.exp_month, expYear: d.exp_year });
  // d.number y d.cvc se descartan aquí: nunca se guardan ni se registran.
  const id = await db.tx(async c => {
    const count = (await c.one('SELECT COUNT(*)::int n FROM payment_methods WHERE user_id=$1', [req.user.id])).n;
    if (count >= 5) throw conflict('Puede guardar hasta 5 métodos de pago.');
    const def = d.make_default || count === 0;
    if (def) await c.query('UPDATE payment_methods SET is_default=false WHERE user_id=$1', [req.user.id]);
    const r = await c.one('INSERT INTO payment_methods(user_id, provider, provider_ref, brand, last4, exp_month, exp_year, holder, is_default) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id',
      [req.user.id, payments.activeProviderCode(), tok.providerRef, tok.brand || payments.brandOf(d.number), tok.last4, d.exp_month, d.exp_year, d.holder, def]);
    return r.id;
  });
  await A(req, 'payment_method.add', 'payment_method', id, { last4: tok.last4 });
  res.status(201).json({ ok: true, message: `Tarjeta terminada en ${tok.last4} guardada.`, reload: true });
});
router.post('/account/payment-methods/:id/default', requireAuth, async (req, res) => {
  await db.tx(async c => {
    const m = await c.one('SELECT id FROM payment_methods WHERE id=$1 AND user_id=$2', [Number(req.params.id), req.user.id]);
    if (!m) throw notFound();
    await c.query('UPDATE payment_methods SET is_default=false WHERE user_id=$1', [req.user.id]);
    await c.query('UPDATE payment_methods SET is_default=true WHERE id=$1', [m.id]);
  });
  res.json({ ok: true, message: 'Método predeterminado actualizado.', reload: true });
});
router.delete('/account/payment-methods/:id', requireAuth, async (req, res) => {
  const m = await db.one('DELETE FROM payment_methods WHERE id=$1 AND user_id=$2 RETURNING id, is_default', [Number(req.params.id), req.user.id]);
  if (!m) throw notFound();
  if (m.is_default) await db.query('UPDATE payment_methods SET is_default=true WHERE id=(SELECT id FROM payment_methods WHERE user_id=$1 ORDER BY id LIMIT 1)', [req.user.id]);
  await A(req, 'payment_method.delete', 'payment_method', m.id);
  res.json({ ok: true, message: 'Método de pago eliminado.', reload: true });
});

// ── Depósitos ──
router.post('/account/deposits', requireAuth, auth.forbidDuringImpersonation, async (req, res) => {
  const d = parse(z.object({ amount: euros().refine(v => v >= 10000 && v <= 5000000, 'Entre 100 € y 50.000 €'), payment_method_id: z.coerce.number().int().positive('Elija una tarjeta') }), req.body);
  const m = await db.one('SELECT * FROM payment_methods WHERE id=$1 AND user_id=$2', [d.payment_method_id, req.user.id]);
  if (!m) throw bad('payment_method_id: Elija una tarjeta guardada', { fields: { payment_method_id: 'Elija una tarjeta' } });
  const charge = await payments.provider(m.provider).charge({ amountCents: d.amount, method: m, userId: req.user.id });
  const dep = await db.one('INSERT INTO deposits(user_id, payment_method_id, provider, amount_cents, reference) VALUES ($1,$2,$3,$4,$5) RETURNING id, reference', [req.user.id, m.id, m.provider, d.amount, charge.reference]);
  await notify(null, req.user.id, { title: 'Depósito recibido', body: `Referencia ${dep.reference}.`, link: '/account/payment-methods?tab=deposit' });
  await A(req, 'deposit.create', 'deposit', dep.id, { amount: d.amount, reference: dep.reference });
  res.status(201).json({ ok: true, message: `Depósito registrado (${dep.reference}).`, reload: true });
});
router.post('/account/deposits/:id/refund', requireAuth, auth.forbidDuringImpersonation, async (req, res) => {
  const dep = await db.one("UPDATE deposits SET status='refund_requested' WHERE id=$1 AND user_id=$2 AND status='held' RETURNING id", [Number(req.params.id), req.user.id]);
  if (!dep) throw conflict('Este depósito no se puede reembolsar.');
  const fin = await db.many("SELECT DISTINCT ur.user_id FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id JOIN permissions p ON p.id=rp.permission_id WHERE p.code='finance.review'");
  for (const f of fin) await notify(null, f.user_id, { title: 'Solicitud de reembolso de depósito', body: `Depósito #${dep.id}`, link: '/finance/balances' });
  await A(req, 'deposit.refund_request', 'deposit', dep.id);
  res.json({ ok: true, message: 'Reembolso solicitado. Finanzas lo revisará.', reload: true });
});
router.post('/finance/deposits/:id/refund', auth.requirePerm('finance.review'), async (req, res) => {
  const dep = await db.one("SELECT * FROM deposits WHERE id=$1 AND status IN ('held','refund_requested')", [Number(req.params.id)]);
  if (!dep) throw conflict('Depósito no reembolsable.');
  const r = await payments.provider(dep.provider === 'bank_transfer' ? 'demo' : dep.provider).refund({ reference: dep.reference, amountCents: dep.amount_cents });
  await db.query("UPDATE deposits SET status='refunded', refunded_by=$2, refunded_at=now() WHERE id=$1", [dep.id, req.user.id]);
  await notify(null, dep.user_id, { title: 'Depósito reembolsado', body: `Referencia ${r.reference}.`, link: '/account/payment-methods?tab=deposit' });
  await A(req, 'deposit.refund', 'deposit', dep.id, { reference: r.reference });
  res.json({ ok: true, message: 'Depósito reembolsado.', reload: true });
});

// ── Gestión de títulos ──
router.post('/account/title-addresses', requireAuth, async (req, res) => {
  const d = parse(z.object({ line1: z.string().trim().min(3, 'Obligatorio').max(150), line2: optStr(150), country: z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/, 'Elija un país'), province: z.string().trim().min(2, 'Obligatorio').max(80), city: z.string().trim().min(2, 'Obligatorio').max(80), postal_code: z.string().trim().min(3, 'Obligatorio').max(10), is_default: bool().optional(), auto_mail: bool().optional() }), { ...req.body });
  const locs = [].concat(req.body.locations || []).map(String).filter(s => /^[A-Z]{3}$/.test(s));
  // Los títulos solo se envían dentro del país de la región del sitio (como la referencia con EE. UU.).
  if (d.country !== req.region) throw bad(`country: Las direcciones para títulos deben estar en ${res.locals.regionName}`, { fields: { country: `Debe estar en ${res.locals.regionName}` } });
  await db.tx(async c => {
    const def = d.is_default !== false;
    if (def) await c.query('UPDATE title_addresses SET is_default=false WHERE user_id=$1', [req.user.id]);
    await c.query('INSERT INTO title_addresses(user_id, line1, line2, country, province, city, postal_code, location_codes, is_default) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [req.user.id, d.line1, d.line2 || '', d.country, d.province, d.city, d.postal_code, locs, def]);
    if (d.auto_mail !== undefined) await c.query("UPDATE profiles SET preferences = preferences || jsonb_build_object('auto_mail_titles', $2::boolean) WHERE user_id=$1", [req.user.id, d.auto_mail]);
  });
  res.status(201).json({ ok: true, message: 'Dirección para títulos guardada.', reload: true });
});
router.delete('/account/title-addresses/:id', requireAuth, async (req, res) => {
  const r = await db.one('DELETE FROM title_addresses WHERE id=$1 AND user_id=$2 RETURNING id', [Number(req.params.id), req.user.id]);
  if (!r) throw notFound();
  res.json({ ok: true, message: 'Dirección eliminada.', reload: true });
});

// ── Preferencias (un solo endpoint, cada clave validada) ──
const PREFS = {
  auto_mail_titles: bool(), customs_report: bool(),
  pickup_preference: z.enum(['self', 'transport', 'third_party']),
  preferred_locations: z.array(z.string().regex(/^[A-Z]{3}$/)).max(20),
  interest_types: z.array(z.string().max(30)).max(20), interest_makes: z.array(z.string().max(40)).max(40),
  buyer_profile: z.enum(['personal', 'parts', 'repair', 'dealer', 'export', 'other']),
  comm_outbid: bool(), comm_watchlist: bool(), comm_auction_reminders: bool(), comm_alerts: bool(), comm_newsletter: bool(), comm_sms: bool(),
};
const LIST_PREFS = ['preferred_locations', 'interest_types', 'interest_makes'];
router.patch('/account/preferences', requireAuth, async (req, res) => {
  const patch = {};
  // Las listas llegan como checkboxes: si no hay ninguno marcado, el formulario envía _lists=<clave> para vaciarla.
  for (const k of [].concat(req.body._lists || [])) if (LIST_PREFS.includes(k)) patch[k] = [];
  for (const [k, schema] of Object.entries(PREFS)) {
    if (!(k in req.body)) continue;
    const raw = LIST_PREFS.includes(k) ? [].concat(req.body[k]).filter(Boolean) : req.body[k];
    patch[k] = parse(z.object({ [k]: schema }), { [k]: raw })[k];
  }
  if (req.body.language !== undefined) {
    if (!LANGS[req.body.language]) throw bad('language: Idioma no válido');
    await db.query('UPDATE profiles SET language=$2 WHERE user_id=$1', [req.user.id, ['en', 'es'].includes(req.body.language) ? req.body.language : 'en']);
    res.cookie('ap_lang', req.body.language, { sameSite: 'lax', path: '/', maxAge: 365 * 86400_000 });
  }
  if (!Object.keys(patch).length && req.body.language === undefined) throw bad('Nada que guardar.');
  if (Object.keys(patch).length) await db.query('UPDATE profiles SET preferences = preferences || $2::jsonb WHERE user_id=$1', [req.user.id, JSON.stringify(patch)]);
  await A(req, 'account.preferences', 'user', req.user.id, { keys: Object.keys(patch) });
  res.json({ ok: true, message: 'Preferencias guardadas.', reload: true });
});

// ── Sesiones ("Claves de acceso") ──
router.post('/account/sessions/revoke-others', requireAuth, async (req, res) => {
  const current = auth.sha256(req.cookies?.[auth.SESSION_COOKIE] || '');
  const r = await db.query('DELETE FROM sessions WHERE user_id=$1 AND token_hash<>$2 AND impersonator_id IS NULL', [req.user.id, current]);
  await A(req, 'account.sessions_revoke', 'user', req.user.id, { n: r.rowCount });
  res.json({ ok: true, message: `${r.rowCount} sesión(es) cerrada(s) en otros dispositivos.`, reload: true });
});
router.delete('/account/sessions/:id', requireAuth, async (req, res) => {
  const r = await db.one('DELETE FROM sessions WHERE id=$1 AND user_id=$2 AND impersonator_id IS NULL RETURNING id', [Number(req.params.id), req.user.id]);
  if (!r) throw notFound();
  res.json({ ok: true, message: 'Sesión cerrada.', reload: true });
});

// Cerrar un banner de anuncio (no vuelve a mostrarse a este usuario)
router.post('/announcements/:id/dismiss', requireAuth, async (req, res) => {
  await db.query('INSERT INTO announcement_dismissals(announcement_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [Number(req.params.id), req.user.id]);
  res.json({ ok: true });
});

module.exports = router;
