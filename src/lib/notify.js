'use strict';
const db = require('../db');
let emitter = null; // inyectado por realtime para avisos en vivo
function setEmitter(fn) { emitter = fn; }
async function notify(client, userId, { title, body = '', link = '/' }) {
  if (!userId) return;
  const q = client || db;
  await q.query('INSERT INTO notifications(user_id, title, body, link) VALUES ($1,$2,$3,$4)', [userId, title, body, link]);
  if (emitter) setImmediate(() => emitter(userId, { title, body, link }));
}
/** Correo de demostración: se guarda en email_outbox (visible en Admin › Demo mailbox). Nunca se envía. */
async function email(client, to, subject, body) {
  const q = client || db;
  await q.query('INSERT INTO email_outbox(to_email, subject, body) VALUES ($1,$2,$3)', [to, subject, body]);
}
module.exports = { notify, email, setEmitter };
