'use strict';
const path = require('node:path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), quiet: true });

const ROOT = path.join(__dirname, '..');
const env = process.env.NODE_ENV || 'development';
const config = {
  root: ROOT,
  env,
  isProd: env === 'production',
  isTest: env === 'test',
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '127.0.0.1',
  databaseUrl: env === 'test' ? (process.env.TEST_DATABASE_URL || process.env.DATABASE_URL) : process.env.DATABASE_URL,
  appSecret: process.env.APP_SECRET || 'dev-only-secret',
  uploadDir: path.resolve(ROOT, process.env.UPLOAD_DIR || './storage/uploads'),
  privateDir: path.resolve(ROOT, './storage/private'),
  demoPassword: process.env.DEMO_PASSWORD || 'Demo2026!',
  sessionDays: 14,
  timezone: 'Europe/Madrid',
};
if (!config.databaseUrl) throw new Error('DATABASE_URL no está definido. Copia .env.example a .env');
if (config.isProd && config.appSecret.length < 32) throw new Error('APP_SECRET debe tener al menos 32 caracteres en producción');
module.exports = config;
