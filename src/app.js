'use strict';
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const config = require('./config');
const db = require('./db');
const { sessionMiddleware } = require('./lib/auth');
const { csrf } = require('./lib/security');
const { i18n } = require('./lib/i18n');
const { AppError } = require('./lib/errors');
const view = require('./lib/viewHelpers');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  // Detrás del proxy HTTPS del hosting: confía en la primera cabecera X-Forwarded-* para que
  // req.secure, req.protocol (cookies seguras, URI de OAuth) y req.ip (rate limit) sean correctos.
  if (config.isProd) app.set('trust proxy', 1);
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));

  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'], imgSrc: ["'self'", 'data:', 'blob:'], connectSrc: ["'self'", 'ws:', 'wss:'],
        formAction: ["'self'"], frameAncestors: ["'none'"], objectSrc: ["'none'"], upgradeInsecureRequests: config.isProd ? [] : null,
      },
    },
    crossOriginEmbedderPolicy: false,
  }));
  app.use(cookieParser());
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));
  app.use(express.static(path.join(config.root, 'public'), { maxAge: config.isProd ? '1d' : 0 }));
  // Solo imágenes públicas de vehículos. Documentos privados se sirven por rutas con control de acceso.
  app.use('/uploads', express.static(config.uploadDir, { maxAge: '1d', index: false, dotfiles: 'deny', setHeaders: res => res.setHeader('X-Content-Type-Options', 'nosniff') }));
  app.use('/media', require('./routes/media'));
  app.get('/health', async (req, res) => { await db.query('SELECT 1'); res.json({ ok: true, db: 'postgresql', time: new Date().toISOString() }); });

  app.use(sessionMiddleware);
  app.use(i18n);
  app.use(csrf);
  app.use(view.locals);

  app.use('/api/v1', require('./routes/api'));
  app.use('/auth/oauth', require('./routes/oauth'));
  app.use('/', require('./routes/files'));
  app.use('/', require('./routes/portal-reference'));
  app.use('/', require('./routes/pages'));
  app.use('/dashboard', require('./routes/dashboard'));
  app.use('/account', require('./routes/account'));
  app.use('/seller', require('./routes/seller'));
  app.use('/', require('./routes/staff'));

  app.use((req, res, next) => next(new AppError(404, 'Page not found', { code: 'NOT_FOUND' })));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || (err.code === 'LIMIT_FILE_SIZE' ? 413 : 500);
    if (status >= 500) console.error('[error]', req.method, req.originalUrl, err);
    const msg = status >= 500 ? 'Unexpected server error. Please try again.' : (err.code === 'LIMIT_FILE_SIZE' ? 'File too large.' : err.message);
    const wantsJson = req.originalUrl.startsWith('/api/') || req.get('x-requested-with') === 'fetch' || (req.get('accept') || '').includes('application/json');
    if (wantsJson) return res.status(status).json({ error: msg, code: err.code, fields: err.fields });
    if (status === 401) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    res.status(status).render('errors/error', { status, message: msg, title: status === 404 ? 'Page not found' : 'Error' });
  });
  return app;
}
module.exports = { createApp };
