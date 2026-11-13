'use strict';
// Controla el PostgreSQL portable instalado en .tools/ (Windows). En otras máquinas usa Docker Compose.
const { execFileSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const root = path.join(__dirname, '..');
const bin = path.join(root, '.tools', 'pgsql', 'bin');
const data = path.join(root, '.tools', 'pgdata');
const exe = n => path.join(bin, process.platform === 'win32' ? n + '.exe' : n);
if (!fs.existsSync(exe('pg_ctl'))) {
  console.error('No se encontró PostgreSQL portable en .tools/pgsql. Ejecuta scripts/setup-windows.ps1 o usa: docker compose up -d db');
  process.exit(1);
}
const cmd = process.argv[2] || 'status';
const args = { start: ['-D', data, '-o', '-p 5433', '-l', path.join(root, '.tools', 'pg.log'), '-w', 'start'], stop: ['-D', data, '-m', 'fast', 'stop'], status: ['-D', data, 'status'] }[cmd];
if (!args) { console.error('Uso: node scripts/db.js start|stop|status'); process.exit(1); }
try { execFileSync(exe('pg_ctl'), args, { stdio: 'inherit' }); } catch (e) { process.exit(e.status || 1); }
