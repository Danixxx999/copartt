'use strict';
const crypto = require('node:crypto');
const config = require('../config');
const { AppError } = require('./errors');

// CSRF "double submit cookie": cookie legible ap_csrf + cabecera X-CSRF-Token (o campo _csrf).
const CSRF_COOKIE = 'ap_csrf';
function csrf(req, res, next) {
  let token = req.cookies?.[CSRF_COOKIE];
  if (!token || !/^[A-Za-z0-9_-]{20,}$/.test(token)) {
    token = crypto.randomBytes(24).toString('base64url');
    res.cookie(CSRF_COOKIE, token, { httpOnly: false, sameSite: 'lax', secure: config.isProd, path: '/' });
  }
  res.locals.csrfToken = token;
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sent = req.get('x-csrf-token') || req.body?._csrf;
  const ok = sent && sent.length === token.length && crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(token));
  if (!ok) return next(new AppError(403, 'Security token expired. Reload the page and try again.', { code: 'CSRF' }));
  next();
}

// Limitador de peticiones en memoria (ventana fija). Suficiente para un único proceso.
const buckets = new Map();
function rateLimit({ windowMs, max, key = req => req.ip, scope = 'global' }) {
  return (req, res, next) => {
    if (config.isTest && !req.get('x-test-ratelimit')) return next();
    const k = `${scope}:${key(req)}`; const now = Date.now();
    let b = buckets.get(k);
    if (!b || b.reset < now) { b = { count: 0, reset: now + windowMs }; buckets.set(k, b); }
    b.count++;
    res.setHeader('RateLimit-Remaining', Math.max(0, max - b.count));
    if (b.count > max) return next(new AppError(429, 'Too many requests. Please wait a moment and try again.', { code: 'RATE_LIMIT' }));
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (b.reset < now) buckets.delete(k); }, 60_000).unref();

module.exports = { csrf, rateLimit, CSRF_COOKIE };
