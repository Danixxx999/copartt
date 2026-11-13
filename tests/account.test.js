'use strict';
/** "Mi cuenta": datos personales, tarjetas (solo últimos 4), depósitos y reembolso, títulos, preferencias, sesiones, formularios y pasarelas de pago. */
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, shutdown, client, db } = require('./helpers');

let base;
before(async () => { base = await boot(); });
after(shutdown);

test('todas las páginas de Mi cuenta cargan y el panel lateral está en la cabecera', async () => {
  const c = client(base); await c.login('basic@copart.test');
  for (const p of ['/account/personal-information', '/account/payment-methods', '/account/payment-methods?tab=deposit', '/account/title-management', '/account/documents-forms', '/account/documents-forms?tab=forms', '/account/access-keys', '/account/preferences/location-language', '/account/preferences/buyer-interests', '/account/preferences/communication', '/account/notifications', '/account/member-fees', '/account/member-fees?loc=US']) {
    assert.equal((await c.get(p)).status, 200, p);
  }
  const page = await c.get('/dashboard');
  for (const s of ['acct-drawer', 'Información personal', 'Centro de preferencias', 'Cuota de Miembros']) assert.ok(page.body.includes(s), s);
  const en = await c.get('/account/personal-information?lang=fr');
  assert.match(en.body, /Renseignements personnels/);
  await c.get('/?lang=es');
  const pdf = await c.get('/account/forms/pickup-authorization.pdf');
  assert.equal(pdf.status, 200); assert.match(pdf.headers.get('content-type'), /pdf/);
  assert.equal((await client(base).get('/account/personal-information')).status, 401, 'requires login (JSON client; browsers are redirected to /login)');
});

test('datos personales: teléfono, direcciones, correo con contraseña y cambio de contraseña', async () => {
  const c = client(base); await c.login('basic@copart.test');
  assert.equal((await c.patch('/api/v1/account/phone', { phone_prefix: '+57', phone: '3001234567' })).status, 200);
  assert.equal((await c.patch('/api/v1/account/address/mailing', { address: 'Cra 6A #50-24', city: 'Ibagué', postal_code: '730001', country: 'CO' })).status, 200);
  assert.equal((await c.patch('/api/v1/account/title-name', { title_name: 'Beatriz Básica Motor' })).status, 200);
  const p = await db.one("SELECT p.* FROM profiles p JOIN users u ON u.id=p.user_id WHERE u.email='basic@copart.test'");
  assert.equal(p.phone, '3001234567'); assert.equal(p.mail_city, 'Ibagué'); assert.equal(p.mail_country, 'CO'); assert.equal(p.title_name, 'Beatriz Básica Motor');
  assert.equal((await c.patch('/api/v1/account/email', { email: 'basic2@copart.test', current_password: 'mala' })).status, 400);
  assert.equal((await c.patch('/api/v1/account/email', { email: 'premium@copart.test', current_password: 'Demo2026!' })).status, 400, 'email taken');
  assert.equal((await c.post('/api/v1/account/password', { current_password: 'Demo2026!', new_password: 'NuevaClave2026' })).status, 200);
  assert.ok((await db.one("SELECT password_changed_at FROM users WHERE email='basic@copart.test'")).password_changed_at);
  await c.post('/api/v1/account/password', { current_password: 'NuevaClave2026', new_password: 'Demo2026!x1' });
});

test('tarjetas: solo tarjetas de prueba en modo demo, nunca se guarda el número; depósito y reembolso por Finanzas', async () => {
  const c = client(base); await c.login('premium@copart.test');
  const real = await c.post('/api/v1/account/payment-methods', { holder: 'Pablo', number: '4539 1488 0343 6467', exp_month: 12, exp_year: 2030, cvc: '123' });
  assert.equal(real.status, 400); assert.equal(real.body.code, 'DEMO_CARD_ONLY');
  assert.equal((await c.post('/api/v1/account/payment-methods', { holder: 'Pablo', number: '4242 4242 4242 4241', exp_month: 12, exp_year: 2030, cvc: '123' })).status, 400, 'Luhn');
  const ok = await c.post('/api/v1/account/payment-methods', { holder: 'Pablo Premium', number: '4242 4242 4242 4242', exp_month: 12, exp_year: 2030, cvc: '123' });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const declined = await c.post('/api/v1/account/payment-methods', { holder: 'Pablo Premium', number: '4000000000000002', exp_month: 1, exp_year: 2031, cvc: '999' });
  assert.equal(declined.status, 201);
  const rows = await db.many("SELECT pm.* FROM payment_methods pm JOIN users u ON u.id=pm.user_id WHERE u.email='premium@copart.test' ORDER BY pm.id");
  assert.equal(rows.length, 2); assert.equal(rows[0].last4, '4242'); assert.equal(rows[0].is_default, true); assert.equal(rows[1].is_default, false);
  assert.ok(!JSON.stringify(rows).includes('4242424242424242'), 'full card number never stored');
  // depósito rechazado con la tarjeta de rechazo, aprobado con la buena
  assert.equal((await c.post('/api/v1/account/deposits', { amount: 600, payment_method_id: rows[1].id })).status, 402);
  const dep = await c.post('/api/v1/account/deposits', { amount: 600, payment_method_id: rows[0].id });
  assert.equal(dep.status, 201, JSON.stringify(dep.body));
  assert.match((await c.get('/dashboard')).body, /600,00€/);
  const d = await db.one("SELECT d.* FROM deposits d JOIN users u ON u.id=d.user_id WHERE u.email='premium@copart.test'");
  assert.equal(d.status, 'held'); assert.equal(Number(d.amount_cents), 60000);
  assert.equal((await c.post(`/api/v1/account/deposits/${d.id}/refund`)).status, 200);
  assert.equal((await c.post(`/api/v1/finance/deposits/${d.id}/refund`)).status, 403, 'buyer cannot approve refunds');
  const fin = client(base); await fin.login('finanzas@copart.test');
  assert.match((await fin.get('/finance/balances')).body, new RegExp(d.reference));
  assert.equal((await fin.post(`/api/v1/finance/deposits/${d.id}/refund`)).status, 200);
  assert.equal((await db.one('SELECT status FROM deposits WHERE id=$1', [d.id])).status, 'refunded');
  assert.equal((await c.post(`/api/v1/account/payment-methods/${rows[1].id}/default`)).status, 200);
  assert.equal((await c.del(`/api/v1/account/payment-methods/${rows[1].id}`)).status, 200);
  assert.equal((await db.one('SELECT is_default FROM payment_methods WHERE id=$1', [rows[0].id])).is_default, true, 'default moves back');
});

test('títulos, preferencias y sesiones', async () => {
  const c = client(base); await c.login('premium2@copart.test');
  const foreign = await c.post('/api/v1/account/title-addresses', { line1: '1 Main St', country: 'US', province: 'TX', city: 'Dallas', postal_code: '75201', is_default: true, auto_mail: true });
  assert.equal(foreign.status, 400, 'region ES only allows Spanish addresses');
  assert.equal((await c.post('/api/v1/account/title-addresses', { line1: 'Calle Mayor 1', country: 'ES', province: 'Madrid', city: 'Madrid', postal_code: '28001', locations: ['MAD', 'BCN'], is_default: true, auto_mail: true })).status, 201);
  assert.equal((await c.patch('/api/v1/account/preferences', { pickup_preference: 'transport', comm_newsletter: true, preferred_locations: ['MAD', 'SVQ'], interest_types: 'suv', buyer_profile: 'dealer' })).status, 200);
  assert.equal((await c.patch('/api/v1/account/preferences', { pickup_preference: 'teleport' })).status, 400);
  assert.equal((await c.patch('/api/v1/account/preferences', { _lists: 'preferred_locations' })).status, 200, 'empty list');
  const p = await db.one("SELECT p.preferences FROM profiles p JOIN users u ON u.id=p.user_id WHERE u.email='premium2@copart.test'");
  assert.equal(p.preferences.pickup_preference, 'transport'); assert.equal(p.preferences.auto_mail_titles, true); assert.deepEqual(p.preferences.preferred_locations, []); assert.deepEqual(p.preferences.interest_types, ['suv']);
  const addr = await db.one("SELECT ta.location_codes FROM title_addresses ta JOIN users u ON u.id=ta.user_id WHERE u.email='premium2@copart.test'");
  assert.deepEqual(addr.location_codes, ['MAD', 'BCN']);
  assert.equal((await c.patch('/api/v1/account/preferences', { language: 'pl' })).status, 200);
  assert.match((await c.get('/account/notifications')).body, /<html lang="pl"/);
  const other = client(base); await other.login('premium2@copart.test');
  const r = await c.post('/api/v1/account/sessions/revoke-others');
  assert.equal(r.status, 200);
  assert.equal((await other.get('/api/v1/auth/me')).body.user, null, 'other device signed out');
  assert.ok((await c.get('/api/v1/auth/me')).body.user, 'current session kept');
});

test('admin: pasarelas de pago sin mostrar claves y menú traducible', async () => {
  const a = client(base); await a.login('admin@copart.test');
  process.env.STRIPE_SECRET_KEY = 'sk_test_secret_should_not_appear';
  const r = await a.get('/admin/payments');
  assert.equal(r.status, 200);
  assert.match(r.body, /Demo \(sandbox\)/); assert.match(r.body, /WOMPI_PRIVATE_KEY/);
  assert.doesNotMatch(r.body, /sk_test_secret_should_not_appear/);
  delete process.env.STRIPE_SECRET_KEY;
  assert.match((await a.get('/admin?lang=ru')).body, /Пользователи/);
  await a.get('/?lang=es');
  const b = client(base); await b.login('basic@copart.test', 'buyer', 'Demo2026!x1');
  assert.equal((await b.get('/admin/payments')).status, 403);
});
