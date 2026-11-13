'use strict';
/**
 * Reloj de subastas — exclusivamente en servidor.
 * Un evento en vivo subasta sus lotes de uno en uno (como una sala virtual):
 *  - al abrirse un lote: status=live, ends_at = ahora + live_lot_seconds
 *  - cada puja que llega con menos de bid_extension_seconds restantes extiende el cierre
 *  - al vencer ends_at: se cierra el lote (adjudicado / pendiente de aprobación del vendedor / sin venta)
 * Todo el estado vive en PostgreSQL: si el servidor se reinicia, el reloj continúa donde estaba.
 */
const db = require('../db');
const settings = require('../lib/settings');
const { notify } = require('../lib/notify');
const { audit } = require('../lib/audit');
const { eur } = require('../lib/money');
const { createOrderForLot } = require('./orders');
const { publicLotFull } = require('./bidding');

let io = null;
const setIo = s => { io = s; };
const emit = (room, ev, payload) => { if (io) io.to(room).emit(ev, payload); };

async function openNextLot(c, eventId) {
  const next = await c.one(`SELECT * FROM auction_lots WHERE event_id=$1 AND status IN ('scheduled','prebidding') ORDER BY sequence LIMIT 1 FOR UPDATE`, [eventId]);
  if (!next) {
    await c.query("UPDATE auction_events SET status='ended', ended_at=now(), current_lot_id=NULL WHERE id=$1", [eventId]);
    return { ended: true };
  }
  const secs = Number(await settings.get('live_lot_seconds', 20));
  const lot = await c.one(`UPDATE auction_lots SET status='live', live_started_at=now(), ends_at=now() + ($2 || ' seconds')::interval, version=version+1 WHERE id=$1 RETURNING *`, [next.id, String(secs)]);
  await c.query('UPDATE auction_events SET current_lot_id=$2 WHERE id=$1', [eventId, lot.id]);
  return { lot };
}

async function closeLot(c, lot) {
  let status;
  if (!lot.leader_user_id) status = 'no_sale';
  else if (lot.current_bid_cents >= lot.reserve_cents) status = 'awarded';
  else status = 'pending_seller_approval';
  const closed = await c.one("UPDATE auction_lots SET status=$2, closed_at=now(), sold_via=CASE WHEN $2='awarded' THEN 'auction' END, version=version+1 WHERE id=$1 RETURNING *", [lot.id, status]);
  if (status === 'awarded') await createOrderForLot(c, closed);
  if (status === 'no_sale') await c.query("UPDATE vehicles SET status='approved' WHERE id=$1", [lot.vehicle_id]);
  if (status === 'pending_seller_approval') {
    const s = await c.one('SELECT s.user_id FROM vehicles v JOIN sellers s ON s.id=v.seller_id WHERE v.id=$1', [lot.vehicle_id]);
    await notify(c, s.user_id, { title: `Approval needed for lot #${lot.lot_number}`, body: `Highest bid ${eur(lot.current_bid_cents)} did not reach your reserve. Accept or reject it.`, link: '/seller/sales' });
    await notify(c, lot.leader_user_id, { title: `Lot #${lot.lot_number}: awaiting seller approval`, body: `Your bid of ${eur(lot.current_bid_cents)} is the highest but below reserve.`, link: '/dashboard/bids' });
  }
  await audit(c, { action: `lot.close.${status}`, entity: 'auction_lot', entityId: lot.id, data: { price: lot.current_bid_cents } });
  return closed;
}

async function startEvent(eventId, actorId = null) {
  const res = await db.tx(async c => {
    const ev = await c.one('SELECT * FROM auction_events WHERE id=$1 FOR UPDATE', [eventId]);
    if (!ev || ev.status !== 'scheduled') return null;
    await c.query("UPDATE auction_events SET status='live', started_at=now() WHERE id=$1", [eventId]);
    await audit(c, { actorId, action: 'event.start', entity: 'auction_event', entityId: eventId });
    return openNextLot(c, eventId);
  });
  if (res) { emit(`event:${eventId}`, 'event:update', { event_id: eventId, status: res.ended ? 'ended' : 'live' }); if (res.lot) broadcastLot(res.lot); }
  return res;
}

async function broadcastLot(lot) {
  const p = await publicLotFull(lot);
  emit(`lot:${lot.id}`, 'lot:update', p);
  emit(`event:${lot.event_id}`, 'lot:update', p);
}

let running = false;
async function tick() {
  if (running) return; running = true;
  try {
    const due = await db.many("SELECT id FROM auction_events WHERE status='scheduled' AND starts_at <= now()");
    for (const e of due) await startEvent(e.id);
    const expired = await db.many("SELECT id FROM auction_lots WHERE status='live' AND ends_at <= now()");
    for (const { id } of expired) {
      const out = await db.tx(async c => {
        const lot = await c.one("SELECT * FROM auction_lots WHERE id=$1 FOR UPDATE", [id]);
        if (!lot || lot.status !== 'live' || new Date(lot.ends_at) > new Date()) return null; // una puja de último segundo lo extendió
        const closed = await closeLot(c, lot);
        const next = await openNextLot(c, lot.event_id);
        return { closed, next };
      });
      if (!out) continue;
      broadcastLot(out.closed);
      emit(`event:${out.closed.event_id}`, 'lot:closed', { lot_id: out.closed.id, lot_number: Number(out.closed.lot_number), status: out.closed.status, price: out.closed.current_bid_cents, winner_user_id: out.closed.status === 'awarded' ? out.closed.leader_user_id : null });
      if (out.next.lot) broadcastLot(out.next.lot);
      if (out.next.ended) emit(`event:${out.closed.event_id}`, 'event:update', { event_id: out.closed.event_id, status: 'ended' });
    }
  } catch (e) { console.error('[engine]', e.message); }
  finally { running = false; }
}

/** El vendedor acepta o rechaza la mejor oferta por debajo de la reserva. */
async function sellerDecision({ user, lotId, accept, ip }) {
  const { conflict, forbidden, notFound } = require('../lib/errors');
  return db.tx(async c => {
    const lot = await c.one(`SELECT l.*, s.user_id AS seller_user_id FROM auction_lots l JOIN vehicles v ON v.id=l.vehicle_id JOIN sellers s ON s.id=v.seller_id WHERE l.id=$1 FOR UPDATE OF l`, [lotId]);
    if (!lot) throw notFound('Lot not found.');
    if (lot.seller_user_id !== user.id && !user.has('auctions.manage')) throw forbidden();
    if (lot.status !== 'pending_seller_approval') throw conflict('This lot is not awaiting seller approval.');
    const upd = await c.one("UPDATE auction_lots SET status=$2, sold_via=CASE WHEN $2='awarded' THEN 'seller_approval' END, counter_offer_cents=NULL, counter_offer_at=NULL, version=version+1 WHERE id=$1 RETURNING *", [lot.id, accept ? 'awarded' : 'no_sale']);
    if (accept) await createOrderForLot(c, upd);
    else {
      await c.query("UPDATE vehicles SET status='approved' WHERE id=$1", [lot.vehicle_id]);
      await notify(c, lot.leader_user_id, { title: `Lot #${lot.lot_number} not sold`, body: 'The seller did not accept the highest bid.', link: '/dashboard/bids?tab=lost' });
    }
    await audit(c, { actorId: user.id, action: accept ? 'lot.seller_accept' : 'lot.seller_reject', entity: 'auction_lot', entityId: lot.id, ip });
    return upd;
  });
}

/**
 * Contraoferta ("Counter Bid"): cuando la puja más alta no llega a la reserva, el vendedor
 * puede proponer al mejor postor un precio intermedio. El comprador acepta o rechaza desde
 * su panel (Bid Status › Counter Bids).
 */
async function sellerCounter({ user, lotId, amountCents, ip }) {
  const { conflict, forbidden, notFound, bad } = require('../lib/errors');
  return db.tx(async c => {
    const lot = await c.one(`SELECT l.*, s.user_id AS seller_user_id FROM auction_lots l JOIN vehicles v ON v.id=l.vehicle_id JOIN sellers s ON s.id=v.seller_id WHERE l.id=$1 FOR UPDATE OF l`, [lotId]);
    if (!lot) throw notFound('Lot not found.');
    if (lot.seller_user_id !== user.id && !user.has('auctions.manage')) throw forbidden();
    if (lot.status !== 'pending_seller_approval') throw conflict('This lot is not awaiting seller approval.');
    if (lot.counter_offer_cents) throw conflict('A counter offer is already waiting for the buyer.');
    if (!Number.isSafeInteger(amountCents) || amountCents <= lot.current_bid_cents) throw bad(`The counter offer must be above the high bid (${eur(lot.current_bid_cents)}).`, { fields: { amount: 'Must be above the high bid' } });
    if (lot.reserve_cents && amountCents > lot.reserve_cents) throw bad(`The counter offer cannot exceed your reserve (${eur(lot.reserve_cents)}).`, { fields: { amount: 'Cannot exceed the reserve' } });
    const upd = await c.one('UPDATE auction_lots SET counter_offer_cents=$2, counter_offer_at=now(), version=version+1 WHERE id=$1 RETURNING *', [lot.id, amountCents]);
    await notify(c, lot.leader_user_id, { title: `Counter offer for lot #${lot.lot_number}`, body: `The seller offers the vehicle for ${eur(amountCents)} (your bid: ${eur(lot.current_bid_cents)}).`, link: '/dashboard/bids?tab=counter' });
    await audit(c, { actorId: user.id, action: 'lot.counter_offer', entity: 'auction_lot', entityId: lot.id, data: { amount: amountCents, high_bid: lot.current_bid_cents }, ip });
    return upd;
  });
}
async function counterResponse({ user, lotId, accept, ip }) {
  const { conflict, forbidden, notFound } = require('../lib/errors');
  return db.tx(async c => {
    const lot = await c.one(`SELECT l.*, s.user_id AS seller_user_id FROM auction_lots l JOIN vehicles v ON v.id=l.vehicle_id JOIN sellers s ON s.id=v.seller_id WHERE l.id=$1 FOR UPDATE OF l`, [lotId]);
    if (!lot) throw notFound('Lot not found.');
    if (lot.leader_user_id !== user.id) throw forbidden('Only the high bidder can answer this counter offer.');
    if (lot.status !== 'pending_seller_approval' || !lot.counter_offer_cents) throw conflict('There is no pending counter offer for this lot.');
    let upd;
    if (accept) {
      await c.query("INSERT INTO bids(lot_id, user_id, kind, amount_cents, max_cents) VALUES ($1,$2,'counter',$3,$3)", [lot.id, user.id, lot.counter_offer_cents]);
      upd = await c.one("UPDATE auction_lots SET status='awarded', current_bid_cents=counter_offer_cents, bid_count=bid_count+1, sold_via='counter_offer', version=version+1 WHERE id=$1 RETURNING *", [lot.id]);
      await createOrderForLot(c, upd);
    } else {
      upd = await c.one("UPDATE auction_lots SET status='no_sale', version=version+1 WHERE id=$1 RETURNING *", [lot.id]);
      await c.query("UPDATE vehicles SET status='approved' WHERE id=$1", [lot.vehicle_id]);
      await notify(c, lot.seller_user_id, { title: `Counter offer declined – lot #${lot.lot_number}`, body: `The buyer declined ${eur(lot.counter_offer_cents)}. The vehicle can be relisted.`, link: '/seller/sales' });
    }
    await audit(c, { actorId: user.id, action: accept ? 'lot.counter_accept' : 'lot.counter_decline', entity: 'auction_lot', entityId: lot.id, data: { amount: lot.counter_offer_cents }, ip });
    return upd;
  });
}

let timer = null;
function start(intervalMs = 1000) { if (!timer) { timer = setInterval(tick, intervalMs); timer.unref(); } }
function stop() { clearInterval(timer); timer = null; }

module.exports = { start, stop, tick, startEvent, sellerDecision, sellerCounter, counterResponse, setIo, broadcastLot, closeLot };
