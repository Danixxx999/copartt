'use strict';
/** Acceso: login con correo o número de miembro, cambio a vendedor, registro con móvil opcional y portada por región. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, shutdown, client, db, config } = require('./helpers');

let base;
before(async () => { base = await boot(); });
after(shutdown);

test('login con número de miembro y páginas de acceso', async () => {
  const u = await db.one("SELECT id FROM users WHERE email='premium@copart.test'");
  const c = client(base);
  const r = await c.post('/api/v1/auth/login', { email: String(u.id).padStart(6, '0'), password: config.demoPassword });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await c.get('/api/v1/auth/me')).body.user.email, 'premium@copart.test');
  assert.equal((await client(base).post('/api/v1/auth/login', { email: 'no-es-correo', password: 'x' })).status, 400);
  assert.equal((await client(base).post('/api/v1/auth/login', { email: '999999', password: 'x' })).status, 401);
  const v = client(base);
  const login = await v.get('/login');
  assert.match(login.body, /Inicio de sesión de miembro/); assert.match(login.body, /Cambiar a vendedor/);
  assert.match((await v.get('/login?type=seller')).body, /name="account_type" value="seller"/);
  assert.match((await v.get('/register')).body, /Únase a la familia/);
  const home = await v.get('/');
  assert.match(home.body, /signin-pop/); assert.match(home.body, /Síganos/);
  assert.match(home.body, /home-memberships/, 'Spain shows membership options');
  assert.doesNotMatch((await v.get('/?region=US')).body, /home-memberships/, 'USA landing has no membership block');
});

test('registro sin móvil (opcional) y con espacios en el número', async () => {
  const a = await client(base).post('/api/v1/auth/register', { email: 'sinmovil@example.test', password: 'ClaveSegura2026', first_name: 'Sin', last_name: 'Movil', terms: true });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  const b = await client(base).post('/api/v1/auth/register', { email: 'conmovil@example.test', password: 'ClaveSegura2026', first_name: 'Con', last_name: 'Movil', phone_prefix: '+57', phone: '300 123 4567', terms: true });
  assert.equal(b.status, 201, JSON.stringify(b.body));
  assert.equal((await db.one("SELECT p.phone FROM profiles p JOIN users u ON u.id=p.user_id WHERE u.email='conmovil@example.test'")).phone, '3001234567');
  assert.equal((await client(base).post('/api/v1/auth/register', { email: 'x@example.test', password: 'ClaveSegura2026', first_name: 'X', last_name: 'Y', phone: 'abc', terms: true })).status, 400);
});
