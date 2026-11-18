'use strict';
/** Anuncios del dueño (banner + buzón, audiencia, cierre) e inicio de sesión social (estado y botones). */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, shutdown, client, db } = require('./helpers');

let base;
before(async () => { base = await boot(); });
after(shutdown);

test('el dueño crea un anuncio, llega al banner y al buzón, y el miembro puede cerrarlo', async () => {
  const a = client(base); await a.login('admin@copart.test');
  const r = await a.post('/api/v1/admin/announcements', { title: 'Oferta de prueba', body: 'Cuerpo', style: 'promo', audience: 'buyers', placement: 'both', cta_text: 'Ver', cta_url: '/vehicles', push_now: true });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const ann = await db.one("SELECT id FROM announcements WHERE title='Oferta de prueba'");
  const buyer = client(base); await buyer.login('premium@copart.test');
  const dash = await buyer.get('/dashboard');
  assert.match(dash.body, /Oferta de prueba/, 'banner visible para el comprador');
  // llegó al buzón de notificaciones
  assert.equal((await db.one("SELECT COUNT(*)::int n FROM notifications no JOIN users u ON u.id=no.user_id WHERE u.email='premium@copart.test' AND no.title='Oferta de prueba'")).n, 1);
  // audiencia: un vendedor puro no lo ve en el banner
  const sellerOnly = await db.one("SELECT u.id FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles ro ON ro.id=ur.role_id WHERE ro.code='seller' AND NOT EXISTS (SELECT 1 FROM user_roles u2 JOIN roles r2 ON r2.id=u2.role_id WHERE u2.user_id=u.id AND r2.code='buyer') LIMIT 1");
  if (sellerOnly) { const sv = client(base); await sv.login('vendedor@copart.test', 'seller'); assert.doesNotMatch((await sv.get('/seller')).body, /Oferta de prueba/); }
  // cerrar el banner
  assert.equal((await buyer.post(`/api/v1/announcements/${ann.id}/dismiss`)).status, 200);
  assert.doesNotMatch((await buyer.get('/dashboard')).body, /data-ann="' + ann.id + '"/);
  // editar y borrar
  assert.equal((await a.patch(`/api/v1/admin/announcements/${ann.id}`, { title: 'Oferta editada', style: 'info', audience: 'all', placement: 'banner' })).status, 200);
  assert.equal((await a.del(`/api/v1/admin/announcements/${ann.id}`)).status, 200);
  assert.equal(await db.one('SELECT 1 FROM announcements WHERE id=$1', [ann.id]), null);
});

test('login social: botones y redirecciones cuando no está configurado; panel sin filtrar claves', async () => {
  const v = client(base);
  const login = await v.get('/login');
  assert.match(login.body, /Continuar con/); assert.match(login.body, /i-soc-google/);
  // sin credenciales, el botón de Google está desactivado y /start redirige con aviso
  const start = await v.get('/auth/oauth/google/start');
  assert.equal(start.status, 302); assert.equal(start.headers.get('location'), '/login?social=unavailable');
  assert.equal((await v.get('/auth/oauth/google/callback?code=x&state=y')).headers.get('location'), '/login?social=state');
  const a = client(base); await a.login('admin@copart.test');
  process.env.GOOGLE_CLIENT_ID = 'test-id'; process.env.GOOGLE_CLIENT_SECRET = 'super-secret-value';
  const page = await a.get('/admin/social-login');
  assert.equal(page.status, 200);
  assert.match(page.body, /GOOGLE_CLIENT_ID/); assert.match(page.body, /\/auth\/oauth\/google\/callback/);
  assert.doesNotMatch(page.body, /super-secret-value/, 'nunca muestra el valor de la clave');
  delete process.env.GOOGLE_CLIENT_ID; delete process.env.GOOGLE_CLIENT_SECRET;
});
