'use strict';
/** Alertas de vehículos: coincidencias al publicar lotes + envío (demo) instantáneo o resumen diario/semanal. */
const db = require('../db');
const { email } = require('../lib/notify');

async function matchLot(c, lotId) {
  const lot = await c.one(`SELECT l.id, l.lot_number, v.year, v.make_id, v.model_id, v.vehicle_type_id, mk.name AS make, md.name AS model
                             FROM auction_lots l JOIN vehicles v ON v.id = l.vehicle_id JOIN makes mk ON mk.id=v.make_id JOIN models md ON md.id=v.model_id WHERE l.id=$1`, [lotId]);
  if (!lot) return 0;
  const alerts = await c.many(`SELECT * FROM vehicle_alerts WHERE status='active' AND make_id=$1 AND (model_id IS NULL OR model_id=$2)
                               AND (vehicle_type_id IS NULL OR vehicle_type_id=$3) AND $4 BETWEEN year_from AND year_to`, [lot.make_id, lot.model_id, lot.vehicle_type_id, lot.year]);
  for (const a of alerts) {
    const ins = await c.one('INSERT INTO vehicle_alert_matches(alert_id, lot_id) VALUES ($1,$2) ON CONFLICT DO NOTHING RETURNING alert_id', [a.id, lot.id]);
    if (ins && a.frequency === 'instant') {
      await email(c, a.email, `Vehicle alert: ${lot.year} ${lot.make} ${lot.model}`, `Hi ${a.first_name},\nA vehicle matching your alert is now available: lot #${lot.lot_number}.\nView: /lot/${lot.lot_number}\nManage alert: /vehicle-alerts/manage/${a.manage_token}`);
      await c.query('UPDATE vehicle_alert_matches SET notified_at=now() WHERE alert_id=$1 AND lot_id=$2', [a.id, lot.id]);
      await c.query('UPDATE vehicle_alerts SET last_sent_at=now() WHERE id=$1', [a.id]);
    }
  }
  return alerts.length;
}

/** Envía resúmenes pendientes. frequency: 'daily' | 'weekly'. Devuelve nº de correos generados. */
async function sendDigest(frequency) {
  return db.tx(async c => {
    const rows = await c.many(`SELECT a.id, a.email, a.first_name, a.manage_token, array_agg(l.lot_number ORDER BY l.lot_number) AS lots
                                 FROM vehicle_alerts a JOIN vehicle_alert_matches m ON m.alert_id=a.id JOIN auction_lots l ON l.id=m.lot_id
                                WHERE a.status='active' AND a.frequency=$1 AND m.notified_at IS NULL GROUP BY a.id`, [frequency]);
    for (const r of rows) {
      await email(c, r.email, `Your ${frequency} vehicle alert: ${r.lots.length} new vehicle(s)`, `Hi ${r.first_name},\nNew matching lots: ${r.lots.map(n => '#' + n).join(', ')}\nManage alert: /vehicle-alerts/manage/${r.manage_token}`);
      await c.query('UPDATE vehicle_alert_matches SET notified_at=now() WHERE alert_id=$1 AND notified_at IS NULL', [r.id]);
      await c.query('UPDATE vehicle_alerts SET last_sent_at=now() WHERE id=$1', [r.id]);
    }
    return rows.length;
  });
}
module.exports = { matchLot, sendDigest };
