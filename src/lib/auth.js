'use strict';
const crypto = require('node:crypto');
const argon2 = require('@node-rs/argon2');
const db = require('../db');
const config = require('../config');
const { unauthorized, forbidden } = require('./errors');

const SESSION_COOKIE = 'ap_sid';
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

const hashPassword = pw => argon2.hash(pw, { memoryCost: 19456, timeCost: 2, parallelism: 1 });
const verifyPassword = async (hash, pw) => { try { return await argon2.verify(hash, pw); } catch { return false; } };

const cookieOpts = () => ({ httpOnly: true, sameSite: 'lax', secure: config.isProd, path: '/', maxAge: config.sessionDays * 86400_000 });

async function createSession(res, userId, req, { impersonatorId = null } = {}) {
  const token = randomToken();
  // Una sesión de suplantación dura como máximo 2 horas.
  await db.query(`INSERT INTO sessions(token_hash, user_id, ip, user_agent, expires_at, impersonator_id)
                  VALUES ($1,$2,$3,$4, CASE WHEN $6::int IS NULL THEN now() + ($5 || ' days')::interval ELSE now() + interval '2 hours' END, $6)`,
    [sha256(token), userId, req.ip, String(req.get('user-agent') || '').slice(0, 250), String(config.sessionDays), impersonatorId]);
  if (!impersonatorId) await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
  res.cookie(SESSION_COOKIE, token, impersonatorId ? { ...cookieOpts(), maxAge: 2 * 3600_000 } : cookieOpts());
  return token;
}
async function destroySession(req, res) {
  const token = req.cookies?.[SESSION_COOKIE];
  if (token) await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  // Cerrar sesión durante una suplantación también cierra la sesión original del administrador.
  const orig = req.cookies?.[IMPERSONATE_COOKIE];
  if (orig) { await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(orig)]); res.clearCookie(IMPERSONATE_COOKIE, { path: '/' }); }
}

/**
 * Suplantación ("Sign in as"): el administrador entra en la cuenta de otro usuario para dar soporte.
 * La sesión original se guarda en otra cookie HttpOnly y se restaura con stopImpersonation.
 */
const IMPERSONATE_COOKIE = 'ap_imp';
async function startImpersonation(req, res, targetId) {
  const original = req.cookies?.[SESSION_COOKIE];
  await createSession(res, targetId, req, { impersonatorId: req.user.id });
  res.cookie(IMPERSONATE_COOKIE, original, { ...cookieOpts(), maxAge: 2 * 3600_000 });
}
async function stopImpersonation(req, res) {
  const current = req.cookies?.[SESSION_COOKIE];
  const original = req.cookies?.[IMPERSONATE_COOKIE];
  if (current) await db.query('DELETE FROM sessions WHERE token_hash = $1 AND impersonator_id IS NOT NULL', [sha256(current)]);
  res.clearCookie(IMPERSONATE_COOKIE, { path: '/' });
  const s = original ? await db.one('SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > now() AND impersonator_id IS NULL', [sha256(original)]) : null;
  if (s && req.impersonator && s.user_id === req.impersonator.id) { res.cookie(SESSION_COOKIE, original, cookieOpts()); return s.user_id; }
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  return null;
}

/** Carga el usuario completo: roles, permisos, plan activo y estado de verificación. */
async function loadUserById(id) {
  const u = await db.one(`
    SELECT u.id, u.email, u.status, u.account_type, u.verification_status, u.registration_step, u.created_at,
           p.first_name, p.last_name, p.phone, p.phone_prefix, p.phone_type, p.company_name, p.city, p.address, p.postal_code, p.language,
           COALESCE(array_agg(DISTINCT r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS roles,
           COALESCE(array_agg(DISTINCT pm.code) FILTER (WHERE pm.code IS NOT NULL), '{}') AS permissions
      FROM users u
      JOIN profiles p ON p.user_id = u.id
      LEFT JOIN user_roles ur ON ur.user_id = u.id
      LEFT JOIN roles r ON r.id = ur.role_id
      LEFT JOIN role_permissions rp ON rp.role_id = r.id
      LEFT JOIN permissions pm ON pm.id = rp.permission_id
     WHERE u.id = $1
     GROUP BY u.id, p.user_id`, [id]);
  if (!u) return null;
  u.plan = await db.one(`
    SELECT mp.*, s.id AS subscription_id, s.ends_at AS subscription_ends_at
      FROM subscriptions s JOIN membership_plans mp ON mp.id = s.plan_id
     WHERE s.user_id = $1 AND s.status = 'active' AND (s.ends_at IS NULL OR s.ends_at > now())`, [id]);
  u.pendingPlan = u.plan ? null : await db.one(`SELECT mp.code, mp.name FROM subscriptions s JOIN membership_plans mp ON mp.id = s.plan_id WHERE s.user_id=$1 AND s.status='pending_payment' ORDER BY s.id DESC LIMIT 1`, [id]);
  u.seller = u.roles.includes('seller') ? await db.one('SELECT * FROM sellers WHERE user_id = $1', [id]) : null;
  u.name = `${u.first_name} ${u.last_name}`.trim();
  u.has = perm => u.permissions.includes(perm);
  u.is = role => u.roles.includes(role);
  u.adminPerms = u.permissions.filter(p => ADMIN_PERMS.includes(p));
  u.isAdminArea = u.is('admin') || u.adminPerms.length > 0;
  u.isStaff = u.isAdminArea || ['admin', 'finance', 'ops'].some(r => u.roles.includes(r)) || u.has('finance.review') || u.has('logistics.manage') || u.has('pickup.validate');
  return u;
}
/** Permisos que dan acceso al área /admin (también para roles personalizados). */
const ADMIN_PERMS = ['users.manage', 'documents.review', 'catalog.manage', 'vehicles.approve', 'auctions.manage', 'locations.manage', 'settings.manage', 'content.manage', 'audit.view', 'support.manage', 'roles.manage', 'reports.view'];
/** Página de inicio según roles/permisos. */
function homeFor(u) {
  if (!u) return '/';
  if (u.is('admin') || u.adminPerms.some(p => p !== 'reports.view')) return '/admin';
  if (u.has('finance.review')) return '/finance';
  if (u.has('logistics.manage') || u.has('pickup.validate')) return '/ops';
  if (u.is('seller') && !u.is('buyer')) return '/seller';
  return '/dashboard';
}

async function sessionMiddleware(req, res, next) {
  try {
    const token = req.cookies?.[SESSION_COOKIE];
    req.user = null; req.impersonator = null;
    if (token) {
      const s = await db.one('SELECT user_id, impersonator_id FROM sessions WHERE token_hash = $1 AND expires_at > now()', [sha256(token)]);
      if (s) {
        const u = await loadUserById(s.user_id);
        if (u && u.status === 'active') req.user = u;
        if (req.user && s.impersonator_id) req.impersonator = await db.one('SELECT u.id, u.email, p.first_name, p.last_name FROM users u JOIN profiles p ON p.user_id=u.id WHERE u.id=$1', [s.impersonator_id]);
      }
    }
    res.locals.user = req.user;
    res.locals.impersonator = req.impersonator;
    next();
  } catch (e) { next(e); }
}

/** Socket.IO: obtener usuario desde la cabecera cookie. */
async function userFromCookieHeader(cookieHeader = '') {
  const m = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (!m) return null;
  const s = await db.one('SELECT user_id FROM sessions WHERE token_hash = $1 AND expires_at > now()', [sha256(decodeURIComponent(m[1]))]);
  return s ? loadUserById(s.user_id) : null;
}

const requireAuth = (req, res, next) => (req.user ? next() : next(unauthorized()));
const requirePerm = (...perms) => (req, res, next) => {
  if (!req.user) return next(unauthorized());
  if (!perms.some(p => req.user.has(p))) return next(forbidden());
  next();
};
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return next(unauthorized());
  if (!roles.some(r => req.user.is(r))) return next(forbidden());
  next();
};

const requireAdminArea = (req, res, next) => {
  if (!req.user) return next(unauthorized());
  if (!req.user.isAdminArea) return next(forbidden());
  next();
};
/** Acciones que no se permiten mientras se suplanta a otro usuario (seguridad de la cuenta suplantada). */
const forbidDuringImpersonation = (req, res, next) => (req.impersonator ? next(forbidden('Not allowed while signed in as another user. Return to your account first.')) : next());

module.exports = { sha256, randomToken, hashPassword, verifyPassword, createSession, destroySession, loadUserById, sessionMiddleware, userFromCookieHeader, requireAuth, requirePerm, requireRole, requireAdminArea, forbidDuringImpersonation, startImpersonation, stopImpersonation, homeFor, ADMIN_PERMS, SESSION_COOKIE, IMPERSONATE_COOKIE };
