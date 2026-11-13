'use strict';
/**
 * Inicio de sesión social: /auth/oauth/:provider/start y /auth/oauth/:provider/callback.
 * Van a nivel raíz (no bajo /api/v1) para que la URI de redirección registrada en el proveedor sea estable.
 */
const crypto = require('node:crypto');
const express = require('express');
const db = require('../db');
const auth = require('../lib/auth');
const social = require('../services/social-auth');
const { audit } = require('../lib/audit');
const { email: sendEmail } = require('../lib/notify');
const router = express.Router();

const STATE_COOKIE = 'ap_oauth';
const baseUrl = req => process.env.OAUTH_BASE_URL || `${req.protocol}://${req.get('host')}`;
const safeNext = n => (n && /^\/(?!\/)[\w\-/?=&%.]*$/.test(n) ? n : null);

router.get('/:provider/start', async (req, res, next) => {
  try {
    const provider = req.params.provider;
    if (!social.configured(provider)) return res.redirect('/login?social=unavailable');
    if (req.user) return res.redirect(auth.homeFor(req.user)); // ya tiene sesión
    const state = crypto.randomBytes(16).toString('base64url');
    const payload = `${state}.${req.query.next ? Buffer.from(String(req.query.next)).toString('base64url') : ''}`;
    res.cookie(STATE_COOKIE, `${provider}:${payload}`, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 10 * 60_000, path: '/auth/oauth' });
    res.redirect(social.authUrl(provider, { base: baseUrl(req), state }));
  } catch (e) { next(e); }
});

router.get('/:provider/callback', async (req, res, next) => {
  try {
    const provider = req.params.provider;
    const cookie = req.cookies?.[STATE_COOKIE] || '';
    res.clearCookie(STATE_COOKIE, { path: '/auth/oauth' });
    const [cProvider, rest = ''] = cookie.split(':');
    const [cState, nextB64] = rest.split('.');
    if (req.query.error || !req.query.code) return res.redirect('/login?social=cancelled');
    if (cProvider !== provider || !cState || cState !== req.query.state) return res.redirect('/login?social=state');

    const profile = await social.exchange(provider, { base: baseUrl(req), authCode: String(req.query.code) });

    // 1) ¿ya hay una identidad vinculada? 2) ¿hay una cuenta con ese correo? 3) si no, se crea.
    let userId, isNew = false;
    const existing = await db.one('SELECT user_id FROM oauth_identities WHERE provider=$1 AND provider_user_id=$2', [provider, profile.providerUserId]);
    if (existing) userId = existing.user_id;
    else {
      const byEmail = await db.one('SELECT id FROM users WHERE lower(email)=lower($1)', [profile.email]);
      if (byEmail) {
        userId = byEmail.id;
        await db.query('INSERT INTO oauth_identities(user_id, provider, provider_user_id, email) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING', [userId, provider, profile.providerUserId, profile.email]);
        if (profile.emailVerified) await db.query('UPDATE users SET email_verified=true WHERE id=$1', [userId]);
      } else {
        isNew = true;
        userId = await db.tx(async c => {
          // Contraseña aleatoria imposible de adivinar: para entrar con correo deberá usar "¿Olvidó su contraseña?".
          const hash = await auth.hashPassword(crypto.randomBytes(24).toString('base64'));
          const u = await c.one("INSERT INTO users(email, password_hash, registration_step, email_verified) VALUES ($1,$2,'membership',$3) RETURNING id", [profile.email, hash, profile.emailVerified]);
          await c.query('INSERT INTO profiles(user_id, first_name, last_name, terms_accepted_at, language) VALUES ($1,$2,$3,now(),$4)', [u.id, profile.firstName, profile.lastName || profile.firstName, res.locals.lang || 'es']);
          await c.query("INSERT INTO user_roles(user_id, role_id) SELECT $1, id FROM roles WHERE code='buyer'", [u.id]);
          await c.query('INSERT INTO oauth_identities(user_id, provider, provider_user_id, email) VALUES ($1,$2,$3,$4)', [u.id, provider, profile.providerUserId, profile.email]);
          await sendEmail(c, profile.email, 'Welcome (demo)', `Your account was created with ${provider}. Choose your membership to start bidding.`);
          await audit(c, { actorId: u.id, action: 'user.register_oauth', entity: 'user', entityId: u.id, data: { provider }, ip: req.ip });
          return u.id;
        });
      }
    }
    const user = await auth.loadUserById(userId);
    if (!user || user.status !== 'active') return res.redirect('/login?social=suspended');
    await auth.createSession(res, userId, req);
    await audit(null, { actorId: userId, action: isNew ? 'auth.login_oauth_new' : 'auth.login_oauth', entity: 'user', entityId: userId, data: { provider }, ip: req.ip });
    const next = safeNext(nextB64 ? Buffer.from(nextB64, 'base64url').toString() : null);
    let home = auth.homeFor(user);
    if (home === '/dashboard' && user.registration_step === 'membership') home = '/register/membership';
    res.redirect(next || home);
  } catch (e) {
    if (e.code && String(e.code).startsWith('OAUTH')) return res.redirect('/login?social=error');
    next(e);
  }
});

module.exports = router;
