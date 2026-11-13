'use strict';
const db = require('../db');

const REPORTS = {
  sales: { title: 'Sales by lot', query: () => db.many(`SELECT o.order_number, l.lot_number, mk.name AS make, md.name AS model, v.year, o.hammer_cents/100.0 AS hammer_eur, o.status, p.first_name || ' ' || p.last_name AS buyer, s.company_name AS seller, o.created_at
      FROM sale_orders o JOIN auction_lots l ON l.id=o.lot_id JOIN vehicles v ON v.id=l.vehicle_id JOIN makes mk ON mk.id=v.make_id JOIN models md ON md.id=v.model_id JOIN profiles p ON p.user_id=o.buyer_id JOIN sellers s ON s.id=o.seller_id ORDER BY o.id DESC`) },
  invoices: { title: 'Invoices & balances', query: () => db.many(`SELECT i.invoice_number, i.kind, i.status, i.total_cents/100.0 AS total_eur, i.paid_cents/100.0 AS paid_eur, (i.total_cents-i.paid_cents)/100.0 AS outstanding_eur, u.email, i.due_at, i.issued_at FROM invoices i JOIN users u ON u.id=i.user_id ORDER BY i.id DESC`) },
  payments: { title: 'Payments', perm: 'finance.review', query: () => db.many(`SELECT p.id, i.invoice_number, p.method, p.scope, p.amount_cents/100.0 AS amount_eur, p.status, p.reference, p.review_note, p.created_at, p.reviewed_at FROM payments p JOIN invoices i ON i.id=p.invoice_id ORDER BY p.id DESC`) },
  bids: { title: 'Bids', query: () => db.many(`SELECT b.id, l.lot_number, b.kind, b.amount_cents/100.0 AS amount_eur, b.created_at, u.email FROM bids b JOIN auction_lots l ON l.id=b.lot_id JOIN users u ON u.id=b.user_id ORDER BY b.id DESC LIMIT 5000`) },
  users: { title: 'Users', perm: 'users.manage', query: () => db.many(`SELECT u.id, u.email, u.account_type, u.status, u.verification_status, string_agg(DISTINCT r.code, ',') AS roles, (SELECT mp.code FROM subscriptions s JOIN membership_plans mp ON mp.id=s.plan_id WHERE s.user_id=u.id AND s.status='active' LIMIT 1) AS plan, u.created_at FROM users u LEFT JOIN user_roles ur ON ur.user_id=u.id LEFT JOIN roles r ON r.id=ur.role_id GROUP BY u.id ORDER BY u.id`) },
  inventory: { title: 'Inventory', query: () => db.many(`SELECT v.id, v.vin, mk.name AS make, md.name AS model, v.year, v.status, loc.code AS yard, l.lot_number, l.status AS lot_status FROM vehicles v JOIN makes mk ON mk.id=v.make_id JOIN models md ON md.id=v.model_id JOIN locations loc ON loc.id=v.location_id LEFT JOIN LATERAL (SELECT lot_number, status FROM auction_lots WHERE vehicle_id=v.id ORDER BY id DESC LIMIT 1) l ON true ORDER BY v.id`) },
  transport: { title: 'Transport', query: () => db.many(`SELECT t.tracking_code, t.status, t.carrier_name, t.eta, o.order_number, q.service, q.destination_city, q.distance_km, q.price_cents/100.0 AS price_eur, t.created_at FROM transport_orders t JOIN transport_quotes q ON q.id=t.quote_id JOIN sale_orders o ON o.id=t.order_id ORDER BY t.id DESC`) },
};

function toCsv(rows) {
  if (!rows.length) return 'no data\n';
  const cols = Object.keys(rows[0]);
  const cell = v => { if (v === null || v === undefined) return ''; const s = v instanceof Date ? v.toISOString() : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return [cols.join(','), ...rows.map(r => cols.map(c => cell(r[c])).join(','))].join('\n') + '\n';
}
module.exports = { REPORTS, toCsv };
