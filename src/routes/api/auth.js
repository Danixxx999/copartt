'use strict';
const express = require('express');
const db = require('../../db');
const { z, parse, bool } = require('../../lib/validate');
const auth = require('../../lib/auth');
const { rateLimit } = require('../../lib/security');
const { bad, conflict, unauthorized, forbidden } = require('../../lib/errors');
const { audit } = require('../../lib/audit');
const { email: sendEmail, notify } = require('../../lib/notify');
const { createInvoice } = require('../../services/orders');
const uploads = require('../../lib/uploads');
const router = express.Router();

const password = z.string().min(10, 'Password must be at least 10 characters').max(128).regex(/[A-Za-z]/, 'Password needs a letter').regex(/\d/, 'Password needs a number');
const RegisterSchema = z.object({
  account_type: z.enum(['individual', 'business']).default('individual'),
  first_name: z.string().trim().min(2, 'Enter your first name').max(60),
  last_name: z.string().trim().min(2, 'Enter your last name').max(80),
  email: z.string().trim().toLowerCase().email('Enter a valid email').max(160),
  phone_type: z.enum(['mobile', 'landline', 'work']).default('mobile'),
  phone_prefix: z.string().trim().regex(/^\+\d{1,4}$/).default('+34'),
  // Móvil opcional (como el registro de la referencia); se admiten espacios y guiones.
  phone: z.preprocess(v => String(v ?? '').replace(/[\s-]/g, ''), z.string().regex(/^(\d{6,15})?$/, 'Please use numbers only (6–15 digits)')),
  company_name: z.string().trim().max(120).optional(),
  password,
  marketing: bool().optional(),
  terms: bool().refine(v => v === true, 'You must accept the terms and confirm you are at least 18 years old'),
});

router.post('/auth/register', rateLimit({ windowMs: 3600_000, max: 20, scope: 'register' }), async (req, res) => {
  const d = parse(RegisterSchema, req.body);
  if (d.account_type === 'business' && !d.company_name) throw bad('company_name: Enter the company name', { fields: { company_name: 'Enter the company name' } });
  if (await db.one('SELECT 1 FROM users WHERE lower(email)=lower($1)', [d.email])) throw conflict('An account with this email already exists. Sign in instead.', 'EMAIL_TAKEN');
  const hash = await auth.hashPassword(d.password);
  const user = await db.tx(async c => {
    const u = await c.one('INSERT INTO users(email, password_hash, account_type, registration_step) VALUES ($1,$2,$3,\'membership\') RETURNING id', [d.email, hash, d.account_type]);
    await c.query(`INSERT INTO profiles(user_id, first_name, last_name, phone_type, phone_prefix, phone, company_name, marketing_opt_in, terms_accepted_at, language) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,now(),$9)`,
      [u.id, d.first_name, d.last_name, d.phone_type, d.phone_prefix, d.phone, d.company_name || null, !!d.marketing, res.locals.lang]);
    await c.query("INSERT INTO user_roles(user_id, role_id) SELECT $1, id FROM roles WHERE code='buyer'", [u.id]);
    await audit(c, { actorId: u.id, action: 'user.register', entity: 'user', entityId: u.id, ip: req.ip });
    await sendEmail(c, d.email, 'Welcome – confirm your account (demo)', `Hi ${d.first_name}, your account was created in the copart academic demo. Next step: choose your membership.`);
    return u;
  });
  await auth.createSession(res, user.id, req);
  res.status(201).json({ ok: true, message: 'Account created.', redirect: '/register/membership' });
});

router.post('/auth/login', rateLimit({ windowMs: 15 * 60_000, max: 10, scope: 'login', key: r => `${r.ip}:${String(r.body?.email || '').toLowerCase()}` }), async (req, res) => {
  // Se puede entrar con el correo o con el número de miembro (p. ej. 000008).
  const d = parse(z.object({ email: z.string().trim().toLowerCase().refine(v => /^\d{1,9}$/.test(v) || z.string().email().safeParse(v).success, 'Enter a valid email or member number'), password: z.string().min(1, 'Enter your password'), account_type: z.enum(['buyer', 'seller']).default('buyer'), next: z.string().optional() }), req.body);
  const row = /^\d{1,9}$/.test(d.email)
    ? await db.one('SELECT id, password_hash, status FROM users WHERE id=$1', [Number(d.email)])
    : await db.one('SELECT id, password_hash, status FROM users WHERE lower(email)=lower($1)', [d.email]);
  const ok = row && await auth.verifyPassword(row.password_hash, d.password);
  if (!ok) { await audit(null, { action: 'auth.login_failed', entity: 'user', entityId: row?.id || null, data: { email: d.email }, ip: req.ip }); throw unauthorized('Invalid email or password.'); }
  if (row.status !== 'active') throw forbidden('This account is suspended. Contact support.');
  const u = await auth.loadUserById(row.id);
  if (d.account_type === 'seller' && !u.is('seller') && !u.isStaff) throw forbidden('This account is not registered as a seller. Choose "Buyer" or apply to sell a vehicle.');
  await auth.createSession(res, row.id, req);
  await audit(null, { actorId: row.id, action: 'auth.login', entity: 'user', entityId: row.id, ip: req.ip });
  const safeNext = d.next && /^\/(?!\/)[\w\-/?=&%.]*$/.test(d.next) ? d.next : null;
  let home = auth.homeFor(u);
  if (home === '/dashboard' && d.account_type === 'seller' && u.is('seller')) home = '/seller';
  if (home === '/dashboard' && u.registration_step === 'membership') home = '/register/membership';
  res.json({ ok: true, message: `Welcome back, ${u.first_name}!`, redirect: safeNext || home });
});

router.post('/auth/logout', async (req, res) => { await auth.destroySession(req, res); res.json({ ok: true, redirect: '/' }); });
router.get('/auth/me', (req, res) => {
  if (!req.user) return res.json({ user: null });
  const { has, is, ...u } = req.user; // eslint-disable-line no-unused-vars
  res.json({ user: u, impersonator: req.impersonator ? { id: req.impersonator.id, email: req.impersonator.email } : null });
});

router.post('/auth/forgot-password', rateLimit({ windowMs: 3600_000, max: 5, scope: 'forgot' }), async (req, res) => {
  const { email } = parse(z.object({ email: z.string().trim().toLowerCase().email('Enter a valid email') }), req.body);
  const u = await db.one('SELECT id FROM users WHERE lower(email)=lower($1)', [email]);
  if (u) {
    const token = auth.randomToken();
    await db.query("INSERT INTO password_resets(user_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '1 hour')", [u.id, auth.sha256(token)]);
    await sendEmail(null, email, 'Reset your password (demo)', `Use this link within 1 hour: /reset-password/${token}`);
  }
  res.json({ ok: true, message: 'If the email is registered, you will receive a reset link. (Demo: see Admin › Demo mailbox.)' });
});
router.post('/auth/reset-password', async (req, res) => {
  const d = parse(z.object({ token: z.string().min(10), password }), req.body);
  await db.tx(async c => {
    const r = await c.one('SELECT * FROM password_resets WHERE token_hash=$1 AND used_at IS NULL AND expires_at > now() FOR UPDATE', [auth.sha256(d.token)]);
    if (!r) throw bad('This reset link is invalid or has expired.');
    await c.query('UPDATE users SET password_hash=$2 WHERE id=$1', [r.user_id, await auth.hashPassword(d.password)]);
    await c.query('UPDATE password_resets SET used_at=now() WHERE id=$1', [r.id]);
    await c.query('DELETE FROM sessions WHERE user_id=$1', [r.user_id]);
    await audit(c, { actorId: r.user_id, action: 'auth.password_reset', entity: 'user', entityId: r.user_id, ip: req.ip });
  });
  res.json({ ok: true, message: 'Password updated. You can sign in now.', redirect: '/login' });
});
router.post('/auth/change-password', auth.requireAuth, auth.forbidDuringImpersonation, async (req, res) => {
  const d = parse(z.object({ current_password: z.string().min(1), new_password: password }), req.body);
  const row = await db.one('SELECT password_hash FROM users WHERE id=$1', [req.user.id]);
  if (!await auth.verifyPassword(row.password_hash, d.current_password)) throw bad('Current password is incorrect.');
  await db.query('UPDATE users SET password_hash=$2 WHERE id=$1', [req.user.id, await auth.hashPassword(d.new_password)]);
  await audit(null, { actorId: req.user.id, action: 'auth.password_change', entity: 'user', entityId: req.user.id, ip: req.ip });
  res.json({ ok: true, message: 'Password changed.' });
});

// ── Membresía (paso 2 del registro o cambio de plan) ──
router.post('/memberships/choose', auth.requireAuth, async (req, res) => {
  const { plan: code } = parse(z.object({ plan: z.enum(['guest', 'basic', 'premium']) }), req.body);
  if (!req.user.is('buyer')) throw forbidden('Only buyer accounts can hold a membership.');
  const plan = await db.one('SELECT * FROM membership_plans WHERE code=$1 AND active', [code]);
  const out = await db.tx(async c => {
    await c.query("UPDATE subscriptions SET status='cancelled' WHERE user_id=$1 AND status='pending_payment'", [req.user.id]);
    if (plan.price_cents === 0) {
      await c.query("UPDATE subscriptions SET status='cancelled' WHERE user_id=$1 AND status='active'", [req.user.id]);
      await c.query("INSERT INTO subscriptions(user_id, plan_id, status, starts_at) VALUES ($1,$2,'active',now())", [req.user.id, plan.id]);
      await c.query("UPDATE users SET registration_step = CASE WHEN registration_step='membership' THEN 'complete' ELSE registration_step END WHERE id=$1", [req.user.id]);
      return { redirect: req.body.from === 'register' ? '/dashboard?welcome=1' : '/dashboard/membership', message: 'Guest membership activated.' };
    }
    const sub = await c.one("INSERT INTO subscriptions(user_id, plan_id, status) VALUES ($1,$2,'pending_payment') RETURNING id", [req.user.id, plan.id]);
    const tax = Math.round(plan.price_cents * 0.21);
    const inv = await createInvoice(c, { userId: req.user.id, subscriptionId: sub.id, kind: 'membership', dueDays: 7, items: [{ category: 'membership', description: `${plan.name} membership – 1 year`, amount_cents: plan.price_cents, tax_rate: 21, tax_cents: tax }] });
    await audit(c, { actorId: req.user.id, action: 'membership.choose', entity: 'subscription', entityId: sub.id, data: { plan: code }, ip: req.ip });
    return { invoice_id: inv.id, message: `${plan.name} selected. Complete the sandbox payment to activate it.`, redirect: req.body.from === 'register' ? `/register/membership?invoice=${inv.id}` : '/dashboard/membership' };
  });
  res.json({ ok: true, ...out });
});

// ── Documentos de verificación (paso 3) ──
router.post('/documents', auth.requireAuth, uploads.memory(8).single('file'), async (req, res) => {
  const { doc_type } = parse(z.object({ doc_type: z.enum(['id_card', 'passport', 'driving_license', 'business_license', 'proof_of_address']) }), req.body);
  const f = uploads.store(req.file, 'document');
  await db.tx(async c => {
    const d = await c.one('INSERT INTO verification_documents(user_id, doc_type, file_path, original_name, mime, size_bytes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id', [req.user.id, doc_type, f.path, f.originalname, f.mimetype, f.size]);
    await c.query("UPDATE users SET verification_status = CASE WHEN verification_status='approved' THEN 'approved' ELSE 'pending' END, registration_step='complete' WHERE id=$1", [req.user.id]);
    const reviewers = await c.many("SELECT DISTINCT ur.user_id FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE r.code='admin'");
    for (const r of reviewers) await notify(c, r.user_id, { title: 'New document to review', body: `${req.user.name} uploaded ${doc_type.replace('_', ' ')}.`, link: '/admin/documents' });
    await audit(c, { actorId: req.user.id, action: 'document.upload', entity: 'verification_document', entityId: d.id, ip: req.ip });
  });
  res.status(201).json({ ok: true, message: 'Document uploaded. Our team will review it shortly.', redirect: req.body.from === 'register' ? '/dashboard?welcome=1' : '/dashboard/documents' });
});
router.post('/registration/skip-documents', auth.requireAuth, async (req, res) => {
  await db.query("UPDATE users SET registration_step='complete' WHERE id=$1", [req.user.id]);
  res.json({ ok: true, redirect: '/dashboard?welcome=1' });
});

module.exports = router;
