'use strict';
/**
 * Pasarela de pagos enchufable.
 *
 * Hoy solo está IMPLEMENTADO el proveedor "demo" (sandbox, sin dinero real). Los demás proveedores
 * aparecen en /admin/payments con su estado: para activarlos hay que (1) poner sus claves en .env,
 * (2) escribir su adaptador en este archivo con las mismas funciones que "demo" y (3) cambiar
 * PAYMENT_PROVIDER en .env. Con un proveedor real, el número de tarjeta NUNCA debe llegar a este
 * servidor: se usa el formulario/campos alojados del proveedor y aquí solo se recibe su token.
 */
const crypto = require('node:crypto');
const { AppError } = require('../lib/errors');

// Tarjetas de prueba aceptadas por el proveedor demo (para no recibir nunca tarjetas reales).
const DEMO_CARDS = {
  '4242424242424242': { brand: 'visa', result: 'approved' },
  '5555555555554444': { brand: 'mastercard', result: 'approved' },
  '378282246310005': { brand: 'amex', result: 'approved' },
  '6011111111111117': { brand: 'discover', result: 'approved' },
  '4000000000000002': { brand: 'visa', result: 'declined' },
};
const ref = prefix => `${prefix}-${new Date().getFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

const PROVIDERS = {
  demo: {
    name: 'Demo (sandbox)', implemented: true, env: [], live: false,
    notes: 'Tarjetas de prueba: 4242 4242 4242 4242 (aprobada), 5555 5555 5555 4444, 3782 822463 10005, 6011 1111 1111 1117; 4000 0000 0000 0002 (rechazada).',
    async tokenizeCard({ number, expMonth, expYear }) {
      const card = DEMO_CARDS[number];
      if (!card) throw new AppError(400, 'Modo demostración: use una tarjeta de prueba (por ejemplo 4242 4242 4242 4242). No introduzca tarjetas reales.', { code: 'DEMO_CARD_ONLY', fields: { number: 'Use una tarjeta de prueba' } });
      const now = new Date();
      if (expYear < now.getFullYear() || (expYear === now.getFullYear() && expMonth < now.getMonth() + 1)) throw new AppError(400, 'La tarjeta está caducada.', { code: 'CARD_EXPIRED', fields: { exp_month: 'Caducada' } });
      return { providerRef: `demo_pm_${crypto.randomBytes(6).toString('hex')}`, brand: card.brand, last4: number.slice(-4), demoResult: card.result };
    },
    async charge({ amountCents, method }) {
      if (!Number.isSafeInteger(amountCents) || amountCents <= 0) throw new AppError(400, 'Importe no válido.');
      if (method.last4 === '0002') throw new AppError(402, 'Pago rechazado por el emisor (tarjeta de prueba de rechazo).', { code: 'CARD_DECLINED' });
      return { reference: ref('DEMO-DEP') };
    },
    async refund() { return { reference: ref('DEMO-REF') }; },
  },
  // Proveedores reales: listos para configurar, adaptador pendiente de escribir.
  stripe: { name: 'Stripe', implemented: false, env: ['STRIPE_SECRET_KEY', 'STRIPE_PUBLISHABLE_KEY'], live: true, notes: 'Tarjetas internacionales. Usar Stripe Elements/Checkout en el navegador y PaymentIntents en el servidor.' },
  mercadopago: { name: 'Mercado Pago', implemented: false, env: ['MERCADOPAGO_ACCESS_TOKEN', 'MERCADOPAGO_PUBLIC_KEY'], live: true, notes: 'Latinoamérica. Checkout Pro o Bricks.' },
  wompi: { name: 'Wompi', implemented: false, env: ['WOMPI_PUBLIC_KEY', 'WOMPI_PRIVATE_KEY', 'WOMPI_EVENTS_SECRET'], live: true, notes: 'Colombia: tarjetas, PSE, Nequi. Widget de Wompi + webhook de eventos.' },
  paypal: { name: 'PayPal', implemented: false, env: ['PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET'], live: true, notes: 'Botones de PayPal + Orders API.' },
  bank_transfer: { name: 'Transferencia bancaria', implemented: true, env: [], live: false, notes: 'Ya integrado: el comprador sube el justificante y Finanzas lo valida. Los datos bancarios se editan en Ajustes › bank_details.' },
};

/** Estado de cada proveedor para el panel de administración (sin mostrar nunca los valores de las claves). */
function status() {
  const active = activeProviderCode();
  return Object.entries(PROVIDERS).map(([code, p]) => {
    const missing = p.env.filter(k => !process.env[k]);
    return { code, name: p.name, implemented: p.implemented, live: p.live, notes: p.notes, env: p.env, missing, configured: missing.length === 0, active: code === active, requested: code === (process.env.PAYMENT_PROVIDER || 'demo') };
  });
}
/** Proveedor de tarjetas activo: el de PAYMENT_PROVIDER si está implementado y configurado; si no, demo. */
function activeProviderCode() {
  const want = process.env.PAYMENT_PROVIDER || 'demo';
  const p = PROVIDERS[want];
  if (p && p.implemented && p.env.every(k => process.env[k]) && want !== 'bank_transfer') return want;
  return 'demo';
}
const provider = code => PROVIDERS[code || activeProviderCode()];

/** Luhn y marca a partir del número (validación previa, también para tarjetas de prueba). */
function luhn(n) { let s = 0; for (let i = 0; i < n.length; i++) { let d = Number(n[n.length - 1 - i]); if (i % 2) { d *= 2; if (d > 9) d -= 9; } s += d; } return s % 10 === 0; }
function brandOf(n) { return /^4/.test(n) ? 'visa' : /^(5[1-5]|2[2-7])/.test(n) ? 'mastercard' : /^3[47]/.test(n) ? 'amex' : /^6(011|5)/.test(n) ? 'discover' : 'other'; }

module.exports = { PROVIDERS, status, activeProviderCode, provider, luhn, brandOf, DEMO_CARDS };
