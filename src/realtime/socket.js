'use strict';
/**
 * Socket.IO: salas por lote (lot:<id>), por evento (event:<id>) y por usuario (user:<id>).
 * Las pujas por WebSocket pasan por el MISMO servicio que la API REST (validación y transacción en servidor).
 * Al reconectar, el cliente pide 'sync' y recibe el estado autoritativo desde la base de datos.
 */
const { Server } = require('socket.io');
const { userFromCookieHeader } = require('../lib/auth');
const { placeBid, publicLotFull } = require('../services/bidding');
const { setEmitter } = require('../lib/notify');
const db = require('../db');

function attach(server) {
  const io = new Server(server, { serveClient: true, cors: { origin: false } });
  setEmitter((userId, n) => io.to(`user:${userId}`).emit('notification', n));

  io.use(async (socket, next) => {
    try { socket.user = await userFromCookieHeader(socket.handshake.headers.cookie || ''); next(); } catch (e) { next(e); }
  });

  io.on('connection', socket => {
    if (socket.user) socket.join(`user:${socket.user.id}`);
    io.emit('presence', { connected: io.engine.clientsCount });

    socket.on('join', async ({ lotId, eventId } = {}, ack) => {
      try {
        if (lotId) socket.join(`lot:${Number(lotId)}`);
        if (eventId) socket.join(`event:${Number(eventId)}`);
        const state = await snapshot({ lotId, eventId });
        if (typeof ack === 'function') ack({ ok: true, ...state, server_time: new Date().toISOString() });
      } catch (e) { if (typeof ack === 'function') ack({ ok: false, error: e.message }); }
    });

    socket.on('sync', async ({ lotId, eventId } = {}, ack) => {
      if (typeof ack === 'function') ack({ ok: true, ...(await snapshot({ lotId, eventId }).catch(() => ({}))), server_time: new Date().toISOString() });
    });

    socket.on('bid', async ({ lotId, amountCents, idempotencyKey } = {}, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      try {
        if (!socket.user) return reply({ ok: false, error: 'Sign in to bid.', code: 'UNAUTHENTICATED' });
        // Recargar usuario: el plan/verificación pueden haber cambiado desde la conexión.
        const { loadUserById } = require('../lib/auth');
        const user = await loadUserById(socket.user.id);
        const r = await placeBid({ user, lotId: Number(lotId), maxCents: Number(amountCents), kind: 'live', idempotencyKey: String(idempotencyKey || '').slice(0, 80) || null, ip: socket.handshake.address });
        broadcast(io, r.lot);
        reply({ ok: true, leading: r.leading, your_max: r.your_max, message: r.message, lot: r.lot });
      } catch (e) { reply({ ok: false, error: e.status ? e.message : 'Unexpected error', code: e.code }); }
    });

    socket.on('disconnect', () => io.emit('presence', { connected: io.engine.clientsCount }));
  });
  return io;
}

function broadcast(io, lot) {
  io.to(`lot:${lot.id}`).emit('lot:update', lot);
  io.to(`event:${lot.event_id}`).emit('lot:update', lot);
}

async function snapshot({ lotId, eventId }) {
  const out = {};
  if (lotId) {
    const l = await db.one('SELECT * FROM auction_lots WHERE id=$1', [Number(lotId)]);
    if (l) { out.lot = await publicLotFull(l); out.history = await recentBids(l.id); }
  }
  if (eventId) {
    const ev = await db.one('SELECT id, status, current_lot_id FROM auction_events WHERE id=$1', [Number(eventId)]);
    out.event = ev;
    if (ev?.current_lot_id) { const l = await db.one('SELECT * FROM auction_lots WHERE id=$1', [ev.current_lot_id]); out.current = await publicLotFull(l); out.history = await recentBids(l.id); }
  }
  return out;
}
async function recentBids(lotId) {
  return db.many(`SELECT b.id, b.amount_cents, b.kind, b.created_at, 'Bidder ' || substr(md5(b.user_id::text || b.lot_id::text), 1, 4) AS bidder
                    FROM bids b WHERE b.lot_id=$1 ORDER BY b.id DESC LIMIT 15`, [lotId]);
}

module.exports = { attach, recentBids };
