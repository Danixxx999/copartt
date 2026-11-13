'use strict';
/**
 * "Mi cuenta" del miembro (/account/*): configuración de la cuenta, centro de preferencias,
 * notificaciones y tarifas. Misma organización que el panel de cuenta de la referencia.
 */
const express = require('express');
const PDFDocument = require('pdfkit');
const db = require('../db');
const settings = require('../lib/settings');
const { requireAuth } = require('../lib/auth');
const { notFound } = require('../lib/errors');
const { buyingPower } = require('../services/bidding');
const payments = require('../services/payments');
const router = express.Router();
router.use(requireAuth);

// Menú lateral: [ruta, etiqueta (frase en español, se traduce con t())]
const MENU = [
  ['Configuración de la cuenta', [['/account/personal-information', 'Información personal'], ['/account/payment-methods', 'Método de pago y depósitos'], ['/account/title-management', 'Gestión de títulos'], ['/account/documents-forms', 'Documentos y formularios'], ['/account/access-keys', 'Claves de acceso']]],
  ['Centro de preferencias', [['/account/preferences/location-language', 'Ubicación e idioma'], ['/account/preferences/buyer-interests', 'Intereses del comprador'], ['/account/preferences/communication', 'Preferencias de comunicación']]],
  [null, [['/account/notifications', 'Notificaciones'], ['/account/member-fees', 'Tarifas de membresía'], ['/sell-a-vehicle', 'Vender con copart']]],
];
async function profileOf(userId) {
  return db.one(`SELECT p.*, u.email, u.created_at AS member_since, u.last_login_at, u.password_changed_at, u.verification_status FROM profiles p JOIN users u ON u.id=p.user_id WHERE p.user_id=$1`, [userId]);
}
const page = (req, res, view, data) => res.render(`account/${view}`, { menu: MENU, current: req.baseUrl + req.path, prefs: data.profile?.preferences || {}, ...data });

router.get('/', (req, res) => res.redirect('/account/personal-information'));
router.get('/personal-information', async (req, res) => {
  const [profile, card] = await Promise.all([profileOf(req.user.id), db.one('SELECT * FROM payment_methods WHERE user_id=$1 AND is_default', [req.user.id])]);
  page(req, res, 'personal', { profile, card, title: 'Información personal' });
});
router.get('/payment-methods', async (req, res) => {
  const tab = req.query.tab === 'deposit' ? 'deposit' : 'methods';
  const [profile, methods, deposits, bp] = await Promise.all([
    profileOf(req.user.id),
    db.many('SELECT * FROM payment_methods WHERE user_id=$1 ORDER BY is_default DESC, id', [req.user.id]),
    db.many('SELECT d.*, pm.brand, pm.last4 FROM deposits d LEFT JOIN payment_methods pm ON pm.id=d.payment_method_id WHERE d.user_id=$1 ORDER BY d.id DESC', [req.user.id]),
    buyingPower(req.user),
  ]);
  const held = deposits.filter(d => d.status === 'held').reduce((n, d) => n + Number(d.amount_cents), 0);
  const active = payments.provider();
  page(req, res, 'payment-methods', { tab, profile, methods, deposits, held, bp, provider: { code: payments.activeProviderCode(), name: active.name, notes: active.notes, live: active.live }, title: 'Método de pago y depósitos' });
});
router.get('/title-management', async (req, res) => {
  const [profile, addresses, locations] = await Promise.all([
    profileOf(req.user.id),
    db.many('SELECT * FROM title_addresses WHERE user_id=$1 ORDER BY is_default DESC, id', [req.user.id]),
    db.many('SELECT code, name, province FROM locations WHERE active AND country=$1 ORDER BY name', [req.region]),
  ]);
  page(req, res, 'titles', { profile, addresses, locations, step: req.query.new ? 1 : 0, title: 'Gestión de títulos' });
});
router.get('/documents-forms', async (req, res) => {
  const tab = req.query.tab === 'forms' ? 'forms' : 'documents';
  const sort = req.query.sort === 'oldest' ? 'ASC' : 'DESC';
  const [profile, docs] = await Promise.all([profileOf(req.user.id), db.many(`SELECT * FROM verification_documents WHERE user_id=$1 ORDER BY id ${sort}`, [req.user.id])]);
  page(req, res, 'documents', { tab, sort: sort === 'ASC' ? 'oldest' : 'default', profile, docs, forms: FORMS, title: 'Documentos y formularios' });
});
router.get('/access-keys', async (req, res) => {
  const [profile, sessions] = await Promise.all([profileOf(req.user.id), db.many('SELECT id, ip, user_agent, created_at, expires_at, token_hash FROM sessions WHERE user_id=$1 AND expires_at > now() AND impersonator_id IS NULL ORDER BY id DESC', [req.user.id])]);
  const currentHash = require('../lib/auth').sha256(req.cookies?.ap_sid || '');
  page(req, res, 'access', { profile, sessions: sessions.map(s => ({ ...s, current: s.token_hash === currentHash, token_hash: undefined })), title: 'Claves de acceso' });
});
router.get('/preferences/location-language', async (req, res) => {
  const [profile, locations] = await Promise.all([profileOf(req.user.id), db.many('SELECT code, name, city, country FROM locations WHERE active ORDER BY country, name')]);
  page(req, res, 'pref-location', { profile, locations, title: 'Ubicación e idioma' });
});
router.get('/preferences/buyer-interests', async (req, res) => {
  const [profile, types, makes] = await Promise.all([profileOf(req.user.id), db.many('SELECT code, name FROM vehicle_types ORDER BY name'), db.many('SELECT slug, name FROM makes ORDER BY name')]);
  page(req, res, 'pref-interests', { profile, types, makes, title: 'Intereses del comprador' });
});
router.get('/preferences/communication', async (req, res) => page(req, res, 'pref-communication', { profile: await profileOf(req.user.id), title: 'Preferencias de comunicación' }));
router.get('/notifications', async (req, res) => {
  const [profile, items] = await Promise.all([profileOf(req.user.id), db.many('SELECT * FROM notifications WHERE user_id=$1 ORDER BY id DESC LIMIT 100', [req.user.id])]);
  page(req, res, 'notifications', { profile, items, title: 'Notificaciones' });
});
router.get('/member-fees', async (req, res) => {
  const [profile, fee, adminFee, taxRate, plans, countries] = await Promise.all([
    profileOf(req.user.id), settings.get('buyer_fee', { percent: 8, min_cents: 15000 }), settings.get('admin_fee_cents', 7500), settings.get('fee_tax_rate', 21),
    db.many('SELECT * FROM membership_plans WHERE active ORDER BY sort'),
    db.many('SELECT DISTINCT country FROM locations WHERE active ORDER BY country'),
  ]);
  const loc = countries.some(c => c.country === req.query.loc) ? req.query.loc : req.region;
  // Ejemplos de tarifa para importes habituales (mismo cálculo que la factura).
  const examples = [50000, 150000, 300000, 800000, 1500000].map(p => { const b = Math.max(fee.min_cents, Math.round(p * fee.percent / 100)); return { price: p, buyer: b, admin: adminFee, tax: Math.round((b + adminFee) * taxRate / 100) }; });
  page(req, res, 'fees', { profile, fee, adminFee, taxRate, plans, countries: countries.map(c => c.country), loc, examples, title: 'Tarifas de membresía' });
});

// ── Formularios descargables (PDF rellenado con los datos del miembro) ──
const FORMS = [
  { code: 'pickup-authorization', name: 'Autorización de recogida por un tercero', desc: 'Autorice a otra persona o transportista a recoger su vehículo en la sede.' },
  { code: 'company-purchase', name: 'Declaración de compra para empresa', desc: 'Indique la empresa a cuyo nombre se emiten las facturas y documentos.' },
  { code: 'export-declaration', name: 'Declaración de exportación', desc: 'Para vehículos que saldrán del país tras la compra.' },
];
router.get('/forms/:code.pdf', async (req, res) => {
  const form = FORMS.find(f => f.code === req.params.code);
  if (!form) throw notFound();
  const p = await profileOf(req.user.id);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${form.code}.pdf"`);
  const doc = new PDFDocument({ size: 'A4', margin: 50, info: { Title: form.name, Author: 'copart (academic demo)' } });
  doc.pipe(res);
  doc.rect(0, 0, doc.page.width, 64).fill('#0b1a2e');
  doc.fillColor('#fff').font('Helvetica-Bold').fontSize(20).text('copart', 50, 22).fontSize(9).font('Helvetica').text('ACADEMIC DEMO · FORM WITHOUT LEGAL VALUE', 300, 28, { width: 245, align: 'right' });
  doc.fillColor('#111').font('Helvetica-Bold').fontSize(17).text(form.name, 50, 92);
  doc.font('Helvetica').fontSize(10).fillColor('#444').text(form.desc, 50, 116, { width: 495 });
  const field = (label, value, y) => { doc.fillColor('#555').fontSize(9).text(label, 50, y); doc.moveTo(50, y + 28).lineTo(545, y + 28).strokeColor('#bbb').stroke(); doc.fillColor('#111').fontSize(11).text(value || '', 50, y + 13); };
  let y = 150;
  for (const [l, v] of [['Miembro nº', String(p.user_id).padStart(6, '0')], ['Nombre del miembro', `${p.first_name} ${p.last_name}`], ['Empresa', p.company_name || ''], ['Correo electrónico', p.email], ['Teléfono', `${p.phone_prefix} ${p.phone}`], ['Dirección', `${p.address} ${p.postal_code} ${p.city}`]]) { field(l, v, y); y += 42; }
  y += 10;
  for (const l of form.code === 'pickup-authorization' ? ['Nombre de la persona autorizada', 'Documento de identidad de la persona autorizada', 'Número(s) de lote', 'Fecha prevista de recogida'] : form.code === 'company-purchase' ? ['Razón social', 'NIF / CIF', 'Dirección fiscal', 'Cargo del firmante'] : ['País de destino', 'Número(s) de lote', 'Agente de aduanas', 'Puerto / frontera de salida']) { field(l, '', y); y += 42; }
  doc.fillColor('#111').fontSize(10).text('Firma del miembro: ____________________________     Fecha: ______________', 50, y + 20);
  doc.fontSize(8).fillColor('#777').text('Documento generado por un proyecto académico. No tiene validez legal.', 50, 780, { width: 495, align: 'center' });
  doc.end();
});

module.exports = router;
