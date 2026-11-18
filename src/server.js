'use strict';
const http = require('node:http');
const config = require('./config');
const { createApp } = require('./app');
const { migrate } = require('../scripts/migrate');
const realtime = require('./realtime/socket');
const engine = require('./services/auctionEngine');
const db = require('./db');

async function start({ port = config.port, host = config.host, runEngine = true } = {}) {
  await migrate({ quiet: true });
  // Datos base imprescindibles (roles, permisos, planes, ajustes, páginas). Idempotente: no pisa
  // los cambios del propietario. Garantiza que una instancia recién desplegada funcione sin más pasos.
  try { await require('../scripts/seed').upsertReference(); }
  catch (e) { console.error('[seed] no se pudieron asegurar los datos base:', e.message); }
  const app = createApp();
  const server = http.createServer(app);
  const io = realtime.attach(server);
  engine.setIo(io);
  if (runEngine) engine.start();
  await new Promise(ok => server.listen(port, host, ok));
  const addr = server.address();
  if (!config.isTest) {
    console.log(`\n  copart · réplica académica  →  http://${host}:${addr.port}`);
    console.log(`  PostgreSQL: ${config.databaseUrl.replace(/:[^:@/]+@/, ':****@')}`);
    console.log(`  Cuentas demo (contraseña ${config.isProd ? '***' : config.demoPassword}): admin@ finanzas@ logistica@ vendedor@ guest@ basic@ premium@ premium2@ copart.test\n`);
  }
  const close = async () => { engine.stop(); io.close(); await new Promise(ok => server.close(ok)); };
  return { server, io, port: addr.port, close };
}

if (require.main === module) {
  start().catch(e => { console.error('No se pudo iniciar:', e.message); process.exit(1); });
  const shutdown = () => { engine.stop(); db.pool.end().finally(() => process.exit(0)); };
  process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
}
module.exports = { start };
