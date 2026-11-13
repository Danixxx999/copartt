'use strict';
// Utilidades de prueba: servidor sobre la BD de test, cliente HTTP con cookies + CSRF.
process.env.NODE_ENV = 'test';
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
// Archivos subidos en carpeta temporal para no ensuciar storage/
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'copart-test-'));
process.env.UPLOAD_DIR = path.join(tmp, 'uploads');

const config = require('../src/config');
config.privateDir = path.join(tmp, 'private');
const db = require('../src/db');
const { reset } = require('../scripts/reset-demo');
const { start } = require('../src/server');

let srv;
async function boot() {
  await reset({ quiet: true });
  srv = await start({ port: 0, runEngine: false });
  return `http://127.0.0.1:${srv.port}`;
}
async function shutdown() { if (srv) await srv.close(); await db.pool.end(); fs.rmSync(tmp, { recursive: true, force: true }); }

function client(base) {
  const cookies = {};
  const header = () => Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  async function req(method, url, body, { form } = {}) {
    if (!cookies.ap_csrf) await raw('GET', '/login');
    const headers = { cookie: header(), 'x-csrf-token': cookies.ap_csrf, accept: 'application/json' };
    let payload;
    if (form) payload = form; else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
    return raw(method, url, payload, headers);
  }
  async function raw(method, url, payload, headers = { cookie: header() }) {
    const r = await fetch(base + url, { method, headers, body: payload, redirect: 'manual' });
    for (const c of r.headers.getSetCookie()) { const kv = c.split(';')[0]; const i = kv.indexOf('='); cookies[kv.slice(0, i)] = kv.slice(i + 1); }
    const type = r.headers.get('content-type') || '';
    const data = type.includes('json') ? await r.json() : await r.text();
    return { status: r.status, body: data, headers: r.headers };
  }
  return {
    cookies, get: u => req('GET', u), post: (u, b) => req('POST', u, b ?? {}), patch: (u, b) => req('PATCH', u, b), del: u => req('DELETE', u),
    upload: (u, fields, files) => { const fd = new FormData(); for (const [k, v] of Object.entries(fields)) fd.append(k, v); for (const [k, f] of files) fd.append(k, new Blob([f.buffer], { type: f.type }), f.name); return req('POST', u, undefined, { form: fd }); },
    async login(email, account_type = 'buyer', password = config.demoPassword) { const r = await req('POST', '/api/v1/auth/login', { email, password, account_type }); if (r.status !== 200) throw new Error(`login ${email}: ${r.status} ${JSON.stringify(r.body)}`); return r; },
    cookieHeader: header,
  };
}
// Imagen PNG mínima válida (1x1) generada en memoria
function png() {
  return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZsAAAAASUVORK5CYII=', 'base64');
}
const pdf = () => Buffer.from('%PDF-1.4\n% fictitious test document\n%%EOF\n');
module.exports = { boot, shutdown, client, db, png, pdf, config };
