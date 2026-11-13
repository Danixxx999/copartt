'use strict';
/** Compras, facturas, pagos demo, pase de retiro y transporte. Transiciones validadas en servidor. */
const crypto = require('node:crypto');
const db = require('../db');
const settings = require('../lib/settings');
const { AppError, conflict, notFound, forbidden, bad } = require('../lib/errors');
const { notify, email } = require('../lib/notify');
const { audit } = require('../lib/audit');
const { eur } = require('../lib/money');
const { sha256 } = require('../lib/auth');

const ORDER_TRANSITIONS = {
  pending_payment: ['payment_review', 'paid', 'cancelled'],
  payment_review: ['pending_payment', 'paid', 'cancelled'],
  paid: ['ready_for_pickup', 'in_transport', 'cancelled'],
  ready_for_pickup: ['in_transport', 'completed'],
  in_transport: ['completed'],
  completed: [],
  cancelled: [],
};

async function transition(c, orderId, to, { actorId = null, note = '' } = {}) {
  const o = await c.one('SELECT * FROM sale_orders WHERE id = $1 FOR UPDATE', [orderId]);
  if (!o) throw notFound('Order not found.');
  if (o.status === to) return o;
  if (!ORDER_TRANSITIONS[o.status].includes(to)) throw conflict(`Order cannot move from ${o.status} to ${to}.`, 'INVALID_TRANSITION');
  const u = await c.one('UPDATE sale_orders SET status = $2 WHERE id = $1 RETURNING *', [orderId, to]);
  await c.query('INSERT INTO order_status_history(order_id, from_status, to_status, actor_id, note) VALUES ($1,$2,$3,$4,$5)', [orderId, o.status, to, actorId, note]);
  return u;
}

async function nextInvoiceNumber(c) {
  const { nextval } = await c.one("SELECT nextval('invoice_number_seq')::int AS nextval");
  return `INV-${new Date().getFullYear()}-${String(nextval).padStart(6, '0')}`;
}

/** Calculadora de costes (misma lógica para la ficha pública y para la factura real). */
async function feeBreakdown(hammerCents) {
  const s = await settings.all();
  const fee = s.buyer_fee || { percent: 8, min_cents: 15000 };
  const buyerFee = Math.max(Math.round(hammerCents * fee.percent / 100), fee.min_cents);
  const adminFee = Number(s.admin_fee_cents ?? 7500);
  const feeTax = Number(s.fee_tax_rate ?? 21);
  const vehicleTax = Number(s.vehicle_tax_rate ?? 0);
  const items = [
    { category: 'vehicle', description: 'Vehicle (hammer price)', amount_cents: hammerCents, tax_rate: vehicleTax },
    { category: 'buyer_fee', description: `Buyer fee (${fee.percent}% · min ${eur(fee.min_cents)})`, amount_cents: buyerFee, tax_rate: feeTax },
    { category: 'admin_fee', description: 'Administration fee', amount_cents: adminFee, tax_rate: feeTax },
  ].map(i => ({ ...i, tax_cents: Math.round(i.amount_cents * i.tax_rate / 100) }));
  const subtotal = items.reduce((a, i) => a + i.amount_cents, 0);
  const tax = items.reduce((a, i) => a + i.tax_cents, 0);
  const vehicleTotal = items.filter(i => i.category === 'vehicle').reduce((a, i) => a + i.amount_cents + i.tax_cents, 0);
  return { items, subtotal, tax, total: subtotal + tax, vehicle_total: vehicleTotal, fees_total: subtotal + tax - vehicleTotal };
}

async function createInvoice(c, { userId, orderId = null, subscriptionId = null, kind, items, dueDays }) {
  const subtotal = items.reduce((a, i) => a + i.amount_cents, 0);
  const tax = items.reduce((a, i) => a + (i.tax_cents || 0), 0);
  const number = await nextInvoiceNumber(c);
  const inv = await c.one(`INSERT INTO invoices(invoice_number, order_id, subscription_id, user_id, kind, subtotal_cents, tax_cents, total_cents, due_at)
                           VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now() + ($9 || ' days')::interval) RETURNING *`,
    [number, orderId, subscriptionId, userId, kind, subtotal, tax, subtotal + tax, String(dueDays)]);
  for (const i of items) await c.query('INSERT INTO invoice_items(invoice_id, category, description, amount_cents, tax_rate, tax_cents) VALUES ($1,$2,$3,$4,$5,$6)',
    [inv.id, i.category, i.description, i.amount_cents, i.tax_rate || 0, i.tax_cents || 0]);
  return inv;
}

/** Crea la orden y la factura al adjudicar un lote (dentro de la transacción de cierre). */
async function createOrderForLot(c, lot) {
  const v = await c.one(`SELECT v.*, mk.name AS make, md.name AS model FROM vehicles v JOIN makes mk ON mk.id=v.make_id JOIN models md ON md.id=v.model_id WHERE v.id = $1`, [lot.vehicle_id]);
  const existing = await c.one('SELECT * FROM sale_orders WHERE lot_id = $1', [lot.id]);
  if (existing) return existing; // idempotente: UNIQUE(lot_id) garantiza un único ganador
  const num = `SO-${new Date().getFullYear()}-${String(lot.lot_number).slice(-6)}`;
  const order = await c.one(`INSERT INTO sale_orders(order_number, lot_id, buyer_id, seller_id, hammer_cents) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [num, lot.id, lot.leader_user_id, v.seller_id, lot.current_bid_cents]);
  await c.query('INSERT INTO order_status_history(order_id, from_status, to_status, note) VALUES ($1,NULL,$2,$3)', [order.id, 'pending_payment', 'Lot awarded']);
  const fb = await feeBreakdown(lot.current_bid_cents);
  const dueDays = Number(await settings.get('payment_due_days', 5));
  const inv = await createInvoice(c, { userId: order.buyer_id, orderId: order.id, kind: 'purchase', items: fb.items.map(i => ({ ...i, description: i.category === 'vehicle' ? `${v.year} ${v.make} ${v.model} · Lot #${lot.lot_number}` : i.description })), dueDays });
  await c.query("UPDATE vehicles SET status = 'sold' WHERE id = $1", [v.id]);
  const buyer = await c.one('SELECT email FROM users WHERE id = $1', [order.buyer_id]);
  await notify(c, order.buyer_id, { title: `You won lot #${lot.lot_number}!`, body: `Invoice ${inv.invoice_number} · Total ${eur(inv.total_cents)}. Pay within ${dueDays} days.`, link: `/dashboard/purchases/${order.id}` });
  await email(c, buyer.email, `You won lot #${lot.lot_number} – invoice ${inv.invoice_number}`, `Congratulations! You won ${v.year} ${v.make} ${v.model} for ${eur(lot.current_bid_cents)}.\nInvoice total: ${eur(inv.total_cents)}.\nPlease pay within ${dueDays} days from your dashboard (demo environment, no real payment).`);
  const sellerUser = await c.one('SELECT user_id FROM sellers WHERE id = $1', [v.seller_id]);
  await notify(c, sellerUser.user_id, { title: `Lot #${lot.lot_number} sold`, body: `Hammer price ${eur(lot.current_bid_cents)}.`, link: '/seller/sales' });
  return order;
}

function proofRequired(method) { return method === 'bank_transfer'; }

/**
 * Pago demo. Representa la separación de la referencia: el VEHÍCULO se paga por transferencia bancaria
 * (con justificante, revisado por Finanzas); las TASAS pueden pagarse con tarjeta (sandbox, aprobación inmediata).
 */
async function submitPayment({ user, invoiceId, method, scope, reference, proof, ip }) {
  return db.tx(async c => {
    const inv = await c.one('SELECT * FROM invoices WHERE id = $1 FOR UPDATE', [invoiceId]);
    if (!inv) throw notFound('Invoice not found.');
    if (inv.user_id !== user.id) throw forbidden();
    if (['paid', 'void'].includes(inv.status)) throw conflict('This invoice is already settled.');
    const pending = await c.one("SELECT COALESCE(SUM(amount_cents),0)::bigint AS s FROM payments WHERE invoice_id=$1 AND status='pending_review'", [inv.id]);
    const outstanding = inv.total_cents - inv.paid_cents - Number(pending.s);
    if (outstanding <= 0) throw conflict('There is already a payment under review for the outstanding balance.');

    let amount;
    if (inv.kind === 'purchase') {
      const items = await c.many('SELECT category, amount_cents + tax_cents AS t FROM invoice_items WHERE invoice_id=$1', [inv.id]);
      const vehicleTotal = items.filter(i => i.category === 'vehicle').reduce((a, i) => a + Number(i.t), 0);
      const feesTotal = items.filter(i => i.category !== 'vehicle').reduce((a, i) => a + Number(i.t), 0);
      const paidByScope = await c.many("SELECT scope, COALESCE(SUM(amount_cents),0)::bigint AS s FROM payments WHERE invoice_id=$1 AND status IN ('approved','pending_review') GROUP BY scope", [inv.id]);
      const used = Object.fromEntries(paidByScope.map(r => [r.scope, Number(r.s)]));
      if (scope === 'vehicle') { if (method !== 'bank_transfer') throw bad('Vehicles must be paid by bank transfer.'); amount = vehicleTotal - (used.vehicle || 0); }
      else if (scope === 'fees') amount = feesTotal - (used.fees || 0);
      else throw bad('Choose what you are paying: vehicle or fees.');
      if (amount <= 0) throw conflict(`The ${scope} amount is already paid or under review.`);
    } else { amount = outstanding; scope = 'full'; }

    if (proofRequired(method) && !proof) throw bad('Attach the bank transfer receipt (PDF, JPG or PNG).');
    const ref = (reference || '').trim() || `DEMO-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const instant = method === 'card_demo';
    const pay = await c.one(`INSERT INTO payments(invoice_id, user_id, method, scope, amount_cents, status, reference, reviewed_at, review_note)
                             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [inv.id, user.id, method, scope, amount, instant ? 'approved' : 'pending_review', ref, instant ? new Date() : null, instant ? 'Sandbox card payment (no real charge)' : null]);
    if (proof) await c.query('INSERT INTO payment_proofs(payment_id, file_path, original_name, mime, size_bytes) VALUES ($1,$2,$3,$4,$5)', [pay.id, proof.path, proof.originalname, proof.mimetype, proof.size]);
    await audit(c, { actorId: user.id, action: 'payment.submit', entity: 'payment', entityId: pay.id, data: { method, scope, amount }, ip });
    if (instant) await applyApprovedPayment(c, pay, null);
    else if (inv.order_id) {
      const o = await c.one('SELECT status FROM sale_orders WHERE id=$1', [inv.order_id]);
      if (o.status === 'pending_payment') await transition(c, inv.order_id, 'payment_review', { actorId: user.id, note: `Bank transfer ${ref} submitted` });
    }
    return pay;
  });
}

async function applyApprovedPayment(c, pay, actorId) {
  const inv = await c.one('UPDATE invoices SET paid_cents = paid_cents + $2 WHERE id = $1 RETURNING *', [pay.invoice_id, pay.amount_cents]);
  const status = inv.paid_cents >= inv.total_cents ? 'paid' : 'partially_paid';
  await c.query('UPDATE invoices SET status = $2 WHERE id = $1', [inv.id, status]);
  if (status !== 'paid') return;
  if (inv.kind === 'purchase') {
    await transition(c, inv.order_id, 'paid', { actorId, note: `Invoice ${inv.invoice_number} fully paid` });
    await issuePickupPass(c, inv.order_id);
    await transition(c, inv.order_id, 'ready_for_pickup', { actorId, note: 'Pickup PIN issued' });
  } else if (inv.kind === 'membership') {
    // Primero se cancela el plan activo anterior (índice único: una sola suscripción activa por usuario).
    await c.query("UPDATE subscriptions SET status='cancelled' WHERE user_id=$1 AND status='active' AND id<>$2", [inv.user_id, inv.subscription_id]);
    const sub = await c.one("UPDATE subscriptions SET status='active', starts_at=now(), ends_at=now() + interval '1 year' WHERE id=$1 RETURNING *", [inv.subscription_id]);
    await c.query("UPDATE users SET registration_step='documents' WHERE id=$1 AND registration_step='membership'", [sub.user_id]);
    await notify(c, inv.user_id, { title: 'Membership activated', body: 'Your membership is now active.', link: '/dashboard/membership' });
  } else if (inv.kind === 'transport') {
    const t = await c.one(`SELECT t.* FROM transport_orders t WHERE t.order_id = $1 AND t.status = 'requested' ORDER BY id DESC LIMIT 1`, [inv.order_id]);
    if (t) {
      await c.query("INSERT INTO transport_events(transport_order_id, status, note) VALUES ($1,'requested','Transport paid – awaiting carrier assignment')", [t.id]);
      const o = await c.one('SELECT status FROM sale_orders WHERE id=$1', [inv.order_id]);
      if (['paid', 'ready_for_pickup'].includes(o.status)) await transition(c, inv.order_id, 'in_transport', { actorId, note: `Transport ${t.tracking_code} paid` });
    }
  }
}

async function reviewPayment({ actor, paymentId, approve, note, ip }) {
  return db.tx(async c => {
    const pay = await c.one('SELECT * FROM payments WHERE id = $1 FOR UPDATE', [paymentId]);
    if (!pay) throw notFound('Payment not found.');
    if (pay.status !== 'pending_review') throw conflict('This payment has already been reviewed.');
    if (!approve && !(note || '').trim()) throw bad('A reason is required to reject a payment.');
    const upd = await c.one('UPDATE payments SET status=$2, review_note=$3, reviewed_by=$4, reviewed_at=now() WHERE id=$1 RETURNING *', [pay.id, approve ? 'approved' : 'rejected', note || null, actor.id]);
    const inv = await c.one('SELECT * FROM invoices WHERE id=$1', [pay.invoice_id]);
    if (approve) await applyApprovedPayment(c, upd, actor.id);
    else if (inv.order_id) {
      const others = await c.one("SELECT COUNT(*)::int n FROM payments WHERE invoice_id=$1 AND status='pending_review'", [inv.id]);
      const o = await c.one('SELECT status FROM sale_orders WHERE id=$1', [inv.order_id]);
      if (!others.n && o.status === 'payment_review') await transition(c, inv.order_id, 'pending_payment', { actorId: actor.id, note: `Payment rejected: ${note}` });
    }
    await notify(c, pay.user_id, { title: approve ? 'Payment approved' : 'Payment rejected', body: approve ? `${eur(pay.amount_cents)} for invoice ${inv.invoice_number}.` : `Reason: ${note}`, link: inv.order_id ? `/dashboard/purchases/${inv.order_id}` : '/dashboard/invoices' });
    await audit(c, { actorId: actor.id, action: approve ? 'payment.approve' : 'payment.reject', entity: 'payment', entityId: pay.id, data: { note }, ip });
    return upd;
  });
}

async function issuePickupPass(c, orderId) {
  const existing = await c.one('SELECT id FROM pickup_passes WHERE order_id=$1', [orderId]);
  if (existing) return;
  const pin = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  await c.query('INSERT INTO pickup_passes(order_id, pin_hash, pin_code) VALUES ($1,$2,$3)', [orderId, sha256(`${orderId}:${pin}`), pin]);
  const o = await c.one('SELECT buyer_id, order_number FROM sale_orders WHERE id=$1', [orderId]);
  await notify(c, o.buyer_id, { title: 'Pickup PIN available', body: `Order ${o.order_number} is paid. Your pickup PIN is in your dashboard.`, link: `/dashboard/purchases/${orderId}` });
}

/** Logística valida el PIN que presenta el comprador; nunca lo ve en claro. */
async function validatePickup({ actor, orderNumber, pin, ip }) {
  return db.tx(async c => {
    const o = await c.one('SELECT * FROM sale_orders WHERE order_number = $1 FOR UPDATE', [String(orderNumber).trim()]);
    if (!o) throw notFound('Order not found.');
    const pass = await c.one('SELECT * FROM pickup_passes WHERE order_id = $1 FOR UPDATE', [o.id]);
    if (!pass) throw conflict('No pickup pass: the order has not been fully paid.');
    if (pass.status !== 'active') throw conflict(`Pickup pass is ${pass.status}.`);
    if (o.status !== 'ready_for_pickup') throw conflict(`Order status is ${o.status}; it is not ready for pickup.`);
    if (sha256(`${o.id}:${String(pin).trim()}`) !== pass.pin_hash) {
      const attempts = pass.failed_attempts + 1;
      await c.query(`UPDATE pickup_passes SET failed_attempts=$2, status=CASE WHEN $2 >= 5 THEN 'revoked' ELSE status END WHERE id=$1`, [pass.id, attempts]);
      await audit(c, { actorId: actor.id, action: 'pickup.pin_failed', entity: 'sale_order', entityId: o.id, data: { attempts }, ip });
      return { ok: false, attempts };
    }
    await c.query("UPDATE pickup_passes SET status='used', used_at=now(), validated_by=$2 WHERE id=$1", [pass.id, actor.id]);
    await transition(c, o.id, 'completed', { actorId: actor.id, note: 'Vehicle collected – PIN validated' });
    await notify(c, o.buyer_id, { title: 'Vehicle collected', body: `Order ${o.order_number} is complete.`, link: `/dashboard/purchases/${o.id}` });
    await audit(c, { actorId: actor.id, action: 'pickup.validated', entity: 'sale_order', entityId: o.id, ip });
    return { ok: true, order: o };
  }).then(async r => { if (r.ok === false) throw new AppError(422, `Incorrect PIN (${r.attempts}/5 attempts).`, { code: 'BAD_PIN' }); return r; });
}

/** Presupuesto de transporte demo: distancia aproximada por código postal (tabla de provincias). */
const PROVINCE_COORDS = { '28': [40.42, -3.70], '08': [41.39, 2.17], '41': [37.39, -5.99], '46': [39.47, -0.38], '29': [36.72, -4.42], '48': [43.26, -2.93], '50': [41.65, -0.88], '15': [43.37, -8.40], '30': [37.99, -1.13], '03': [38.35, -0.48], '07': [39.57, 2.65], '35': [28.12, -15.43], '47': [41.65, -4.72], '33': [43.36, -5.85], '18': [37.18, -3.60], '12': [39.99, -0.05], '45': [39.86, -4.02], '37': [40.97, -5.66], '31': [42.81, -1.65], '39': [43.46, -3.80] };
function haversine([a, b], [c, d]) { const R = 6371, r = x => x * Math.PI / 180; const h = Math.sin(r(c - a) / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(r(d - b) / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); }
async function quoteTransport({ originLocation, postalCode, service }) {
  const rates = await settings.get('transport_rates', { base_cents: 9000, per_km_cents: 95, express_multiplier: 1.5, international_flat_cents: 45000 });
  const dest = PROVINCE_COORDS[String(postalCode).slice(0, 2)] || [40.42, -3.70];
  const origin = [Number(originLocation.lat), Number(originLocation.lng)];
  const km = Math.round(haversine(origin, dest) * 1.25); // factor de carretera
  let price = rates.base_cents + km * rates.per_km_cents;
  if (service === 'express') { if (km > 200) throw bad('Express service is only available up to 200 km from the yard.'); price = Math.round(price * rates.express_multiplier); }
  if (service === 'international') price += rates.international_flat_cents;
  return { distance_km: km, price_cents: price };
}

module.exports = { transition, feeBreakdown, createInvoice, createOrderForLot, submitPayment, reviewPayment, validatePickup, quoteTransport, issuePickupPass, ORDER_TRANSITIONS };
