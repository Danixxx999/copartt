'use strict';
/**
 * Reinicio SEGURO del entorno demo: borra el esquema, re-ejecuta migraciones y seed.
 * Protecciones: nunca en producción y exige confirmación explícita.
 *   node scripts/reset-demo.js --yes
 */
const fs = require('node:fs');
const path = require('node:path');
const config = require('../src/config');
const db = require('../src/db');

async function reset({ quiet = false } = {}) {
  if (config.isProd) throw new Error('reset-demo está deshabilitado en producción.');
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  for (const dir of [config.uploadDir, config.privateDir]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (f !== '.gitkeep') fs.rmSync(path.join(dir, f), { force: true, recursive: true });
  }
  const { main } = require('./seed');
  const log = console.log; if (quiet) console.log = () => {};
  try { await main(); } finally { console.log = log; }
}
module.exports = { reset };

if (require.main === module) {
  if (!process.argv.includes('--yes') && process.env.CONFIRM_RESET_DEMO !== 'SI') {
    console.error('Esto BORRA todos los datos de la base de datos demo (' + config.databaseUrl.replace(/:[^:@/]+@/, ':****@') + ').\nEjecuta: npm run reset-demo -- --yes');
    process.exit(1);
  }
  reset().then(() => { console.log('✔ Entorno demo restablecido.'); return db.pool.end(); }).catch(e => { console.error(e.message); process.exit(1); });
}
