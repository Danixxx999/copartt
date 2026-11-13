'use strict';
const db = require('../db');
// Configuración editable desde el panel admin (tabla system_settings). Caché corta.
let cache = null, cacheAt = 0;
async function all() {
  if (cache && Date.now() - cacheAt < 3000) return cache;
  const rows = await db.many('SELECT key, value FROM system_settings');
  cache = Object.fromEntries(rows.map(r => [r.key, r.value])); cacheAt = Date.now();
  return cache;
}
async function get(key, fallback) { const s = await all(); return s[key] ?? fallback; }
function invalidate() { cache = null; }
module.exports = { all, get, invalidate };
