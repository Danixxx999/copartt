'use strict';
const db = require('../db');
async function audit(client, { actorId = null, action, entity, entityId = null, data = {}, ip = null }) {
  const q = client || db;
  await q.query('INSERT INTO audit_logs(actor_id, action, entity, entity_id, data, ip) VALUES ($1,$2,$3,$4,$5,$6)',
    [actorId, action, entity, entityId === null ? null : String(entityId), JSON.stringify(data), ip]);
}
module.exports = { audit };
