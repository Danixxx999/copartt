'use strict';
/**
 * Motor de pujas.
 * - Cada pujador tiene un máximo privado (proxy_bids). Una puja en vivo de X equivale a fijar máximo = X.
 * - Precio visible = min(máximo del 1º, máximo del 2º + incremento), nunca por debajo de la salida.
 * - Empate de máximos: gana quien alcanzó ese máximo primero (updated_at más antiguo).
 * - Toda puja se procesa en una transacción con SELECT ... FOR UPDATE sobre el lote:
 *   las pujas concurrentes del mismo lote se serializan y nunca hay dos líderes.
 * - Idempotencia: (user_id, idempotency_key) único; un reintento devuelve el resultado original.
 * - El servidor decide hora, validez y líder. El navegador solo envía "mi máximo".
 */
const db = require('../db');
const settings = require('../lib/settings');
const { AppError, forbidden, conflict, notFound } = require('../lib/errors');
const { notify } = require('../lib/notify');
const { audit } = require('../lib/audit');
const { eur } = require('../lib/money');

const OPEN_FOR_PREBID = ['prebidding'];

function incrementFor(table, priceCents) {
  for (const step of table) if (step.up_to_cents === null || priceCents < step.up_to_cents) return step.increment_cents;
  return table[table.length - 1].increment_cents;
}
async function increment(priceCents) {
  return incrementFor(await settings.get('bid_increments', [{ up_to_cents: null, increment_cents: 2500 }]), priceCents);
}
const DEFAULT_TABLE = [{ up_to_cents: null, increment_cents: 2500 }];
function minNextFor(table, lot) {
  if (lot.current_bid_cents === null || lot.current_bid_cents === undefined) return lot.starting_bid_cents;
  return lot.current_bid_cents + incrementFor(table, lot.current_bid_cents);
}
async function minimumNextBid(lot) {
  return minNextFor(await settings.get('bid_increments', DEFAULT_TABLE), lot);
}

/** Reglas de elegibilidad (sin transacción). Devuelve {ok, reason}. */
function eligibility(user) {
  if (!user) return { ok: false, code: 'UNAUTHENTICATED', reason: 'Sign in to bid.' };
  if (!user.has('bids.place')) return { ok: false, code: 'NOT_BUYER', reason: 'Only buyer accounts can bid.' };
  if (!user.plan) return { ok: false, code: 'NO_MEMBERSHIP', reason: user.pendingPlan ? 'Your membership payment is pending.' : 'Choose a membership to start bidding.' };
  if (!user.plan.can_bid) return { ok: false, code: 'GUEST', reason: 'Guest members can watch auctions but cannot bid. Upgrade to Basic or Premium.' };
  if (user.plan.requires_documents && user.verification_status !== 'approved') {
    const msg = { unverified: 'Upload your identity documents to be allowed to bid.', pending: 'Your documents are being reviewed. You will be able to bid once approved.', rejected: 'Your documents were rejected. Please upload them again.' }[user.verification_status];
    return { ok: false, code: 'NOT_VERIFIED', reason: msg };
  }
  return { ok: true };
}

/** Comprueba límites del plan dentro de la transacción. */
async function checkPlanLimits(c, user, lot, maxCents) {
  const plan = user.plan;
  if (plan.max_bid_cents && maxCents > plan.max_bid_cents)
    throw new AppError(403, `Your ${plan.name} membership allows bids up to ${eur(plan.max_bid_cents)} per vehicle.`, { code: 'PLAN_LIMIT' });
  if (plan.max_lots_per_event || plan.max_total_cents) {
    const r = await c.one(`
      SELECT COUNT(*)::int AS lots, COALESCE(SUM(pb.max_cents),0)::bigint AS total
        FROM proxy_bids pb JOIN auction_lots l ON l.id = pb.lot_id
       WHERE pb.user_id = $1 AND l.event_id = $2 AND l.id <> $3 AND l.status IN ('prebidding','live')`, [user.id, lot.event_id, lot.id]);
    if (plan.max_lots_per_event && r.lots + 1 > plan.max_lots_per_event)
      throw new AppError(403, `Your ${plan.name} membership allows bidding on up to ${plan.max_lots_per_event} vehicles per auction.`, { code: 'PLAN_LOTS' });
    if (plan.max_total_cents && Number(r.total) + maxCents > plan.max_total_cents)
      throw new AppError(403, `Your ${plan.name} membership allows a combined limit of ${eur(plan.max_total_cents)} per auction.`, { code: 'PLAN_TOTAL' });
  }
}

function publicLot(l) {
  return {
    id: l.id, lot_number: Number(l.lot_number), event_id: l.event_id, status: l.status,
    current_bid_cents: l.current_bid_cents, starting_bid_cents: l.starting_bid_cents, bid_count: l.bid_count,
    leader_user_id: l.leader_user_id, ends_at: l.ends_at, reserve_met: l.current_bid_cents !== null && l.current_bid_cents >= l.reserve_cents,
    buy_now_cents: l.status === 'prebidding' && l.buy_now_cents && (l.current_bid_cents || 0) < l.buy_now_cents ? l.buy_now_cents : null, sold_via: l.sold_via || null,
    version: l.version, server_time: new Date().toISOString(),
  };
}

/** Igual que publicLot pero con la puja mínima siguiente calculada por el servidor. */
async function publicLotFull(l) {
  const p = publicLot(l);
  p.min_next_cents = await minimumNextBid(l);
  return p;
}

/**
 * Registrar puja / máximo.
 * @returns {{lot, leading:boolean, your_max:number, message:string, replay?:boolean}}
 */
async function placeBid({ user, lotId, maxCents, kind, idempotencyKey, ip }) {
  const elig = eligibility(user);
  if (!elig.ok) throw new AppError(user ? 403 : 401, elig.reason, { code: elig.code });
  if (!Number.isSafeInteger(maxCents) || maxCents <= 0) throw new AppError(400, 'Enter a valid bid amount.', { code: 'VALIDATION' });

  // La configuración se lee ANTES de abrir la transacción: dentro del bloqueo del lote no se pide
  // ninguna otra conexión al pool (evita inanición del pool con muchas pujas simultáneas).
  const cfg = await settings.all();
  const table = cfg.bid_increments || DEFAULT_TABLE;
  const extensionSecs = Number(cfg.bid_extension_seconds ?? 10);

  const result = await db.tx(async c => {
    if (idempotencyKey) {
      const prev = await c.one('SELECT lot_id FROM bids WHERE user_id = $1 AND idempotency_key = $2', [user.id, idempotencyKey]);
      if (prev) {
        const lot = await c.one('SELECT * FROM auction_lots WHERE id = $1', [prev.lot_id]);
        const mine = await c.one('SELECT max_cents FROM proxy_bids WHERE lot_id=$1 AND user_id=$2', [prev.lot_id, user.id]);
        return { lot, leading: lot.leader_user_id === user.id, your_max: mine?.max_cents, replay: true, outbid: null };
      }
    }
    const lot = await c.one(`SELECT l.*, s.user_id AS seller_user_id
                               FROM auction_lots l JOIN vehicles v ON v.id = l.vehicle_id JOIN sellers s ON s.id = v.seller_id
                              WHERE l.id = $1 FOR UPDATE OF l`, [lotId]);
    if (!lot) throw notFound('Lot not found.');
    if (lot.seller_user_id === user.id) throw forbidden('You cannot bid on your own vehicle.');
    const isLive = lot.status === 'live' && lot.ends_at && new Date(lot.ends_at) > new Date();
    if (!isLive && !OPEN_FOR_PREBID.includes(lot.status)) throw conflict('Bidding is closed for this lot.', 'LOT_CLOSED');
    const effectiveKind = isLive ? (kind === 'prebid' ? 'live' : kind) : 'prebid';

    await checkPlanLimits(c, user, lot, maxCents);

    const mine = await c.one('SELECT max_cents FROM proxy_bids WHERE lot_id = $1 AND user_id = $2', [lot.id, user.id]);
    if (lot.leader_user_id === user.id) {
      if (mine && maxCents <= mine.max_cents) throw conflict(`You are already the high bidder. A new maximum must be above ${eur(mine.max_cents)}.`, 'BID_TOO_LOW');
    } else {
      const min = minNextFor(table, lot);
      if (maxCents < min) throw conflict(`The minimum bid is ${eur(min)}.`, 'BID_TOO_LOW');
    }

    await c.query(`INSERT INTO proxy_bids(lot_id, user_id, max_cents) VALUES ($1,$2,$3)
                   ON CONFLICT (lot_id, user_id) DO UPDATE SET max_cents = EXCLUDED.max_cents, updated_at = now()
                   WHERE proxy_bids.max_cents < EXCLUDED.max_cents`, [lot.id, user.id, maxCents]);

    const ranked = await c.many('SELECT user_id, max_cents FROM proxy_bids WHERE lot_id = $1 ORDER BY max_cents DESC, updated_at ASC, created_at ASC LIMIT 2', [lot.id]);
    const [top, second] = ranked;
    let price;
    if (!second) price = lot.current_bid_cents ?? lot.starting_bid_cents;
    else price = Math.min(top.max_cents, second.max_cents + incrementFor(table, second.max_cents));
    price = Math.max(price, lot.starting_bid_cents, lot.current_bid_cents ?? 0);

    // Historial: la puja del usuario y, si un máximo automático lo supera, la contrapuja automática.
    let inserted = 0;
    const userWins = top.user_id === user.id;
    await c.query('INSERT INTO bids(lot_id, user_id, kind, amount_cents, max_cents, idempotency_key) VALUES ($1,$2,$3,$4,$5,$6)',
      [lot.id, user.id, effectiveKind, userWins ? price : maxCents, maxCents, idempotencyKey || null]); inserted++;
    if (!userWins) { await c.query('INSERT INTO bids(lot_id, user_id, kind, amount_cents) VALUES ($1,$2,$3,$4)', [lot.id, top.user_id, 'auto', price]); inserted++; }

    let endsAt = lot.ends_at;
    if (isLive) {
      const minEnd = new Date(Date.now() + extensionSecs * 1000);
      if (new Date(lot.ends_at) < minEnd) endsAt = minEnd;
    }
    const updated = await c.one(`UPDATE auction_lots SET current_bid_cents=$2, leader_user_id=$3, bid_count=bid_count+$4, ends_at=$5, version=version+1
                                  WHERE id=$1 RETURNING *`, [lot.id, price, top.user_id, inserted, endsAt]);

    // Solo se avisa al líder anterior cuando el liderazgo cambia de manos.
    const outbid = lot.leader_user_id && lot.leader_user_id !== top.user_id ? lot.leader_user_id : null;
    if (outbid) await notify(c, outbid, { title: `You have been outbid on lot #${lot.lot_number}`, body: `Current bid: ${eur(price)}`, link: `/lot/${lot.lot_number}` });
    await audit(c, { actorId: user.id, action: 'bid.place', entity: 'auction_lot', entityId: lot.id, data: { kind: effectiveKind, price, leading: userWins }, ip });
    return { lot: updated, leading: userWins, your_max: Math.max(maxCents, mine?.max_cents || 0), outbid };
  });

  const message = result.replay ? 'Bid already registered.' : result.leading ? 'You are the high bidder!' : 'Your bid was registered, but another bidder has a higher maximum.';
  return { ...result, lot: await publicLotFull(result.lot), message };
}

/**
 * Buy It Now: compra inmediata a precio fijo antes de la subasta en vivo.
 * Misma transacción con bloqueo del lote que las pujas: si dos compradores pulsan a la vez,
 * solo el primero obtiene el lote (el segundo ve "lote cerrado").
 */
async function buyNow({ user, lotId, ip }) {
  const elig = eligibility(user);
  if (!elig.ok) throw new AppError(user ? 403 : 401, elig.reason, { code: elig.code });
  const { createOrderForLot } = require('./orders');
  return db.tx(async c => {
    const lot = await c.one(`SELECT l.*, s.user_id AS seller_user_id FROM auction_lots l JOIN vehicles v ON v.id = l.vehicle_id JOIN sellers s ON s.id = v.seller_id
                              WHERE l.id = $1 FOR UPDATE OF l`, [lotId]);
    if (!lot) throw notFound('Lot not found.');
    if (lot.seller_user_id === user.id) throw forbidden('You cannot buy your own vehicle.');
    if (lot.status !== 'prebidding') throw conflict('Buy It Now is only available before the lot goes live.', 'LOT_CLOSED');
    if (!lot.buy_now_cents) throw conflict('This lot has no Buy It Now price.', 'NO_BUY_NOW');
    if ((lot.current_bid_cents || 0) >= lot.buy_now_cents) throw conflict('Bids have already reached the Buy It Now price. Place a bid instead.', 'BUY_NOW_EXCEEDED');
    await checkPlanLimits(c, user, lot, Number(lot.buy_now_cents));
    await c.query("INSERT INTO bids(lot_id, user_id, kind, amount_cents, max_cents) VALUES ($1,$2,'buy_now',$3,$3)", [lot.id, user.id, lot.buy_now_cents]);
    const upd = await c.one(`UPDATE auction_lots SET status='awarded', current_bid_cents=buy_now_cents, leader_user_id=$2, bid_count=bid_count+1, closed_at=now(), sold_via='buy_now', version=version+1
                              WHERE id=$1 RETURNING *`, [lot.id, user.id]);
    const order = await createOrderForLot(c, upd);
    const others = await c.many('SELECT user_id FROM proxy_bids WHERE lot_id=$1 AND user_id<>$2', [lot.id, user.id]);
    for (const o of others) await notify(c, o.user_id, { title: `Lot #${lot.lot_number} was sold with Buy It Now`, body: 'Your pre-bid on this lot is no longer active.', link: '/dashboard/bids?tab=lost' });
    await audit(c, { actorId: user.id, action: 'lot.buy_now', entity: 'auction_lot', entityId: lot.id, data: { price: Number(lot.buy_now_cents), order: order.order_number }, ip });
    return { lot: upd, order };
  });
}

/**
 * "My Buying Power" (widget del panel del miembro): límite del plan, importe comprometido
 * en pujas activas y saldo pendiente de pago. Solo informativo: los límites reales se
 * aplican en checkPlanLimits dentro de la transacción de cada puja.
 */
async function buyingPower(user) {
  const plan = user.plan;
  const out = { canBid: !!(plan && plan.can_bid), plan: plan ? plan.name : null, perVehicle: plan?.max_bid_cents ? Number(plan.max_bid_cents) : null, maxLots: plan?.max_lots_per_event || null, limit: null, committed: 0, activeLots: 0, winning: 0, unpaid: 0, available: null };
  if (!out.canBid) { out.limit = 0; out.available = 0; }
  const r = await db.one(`SELECT COALESCE(SUM(pb.max_cents),0)::bigint AS committed, COUNT(*)::int AS lots, COUNT(*) FILTER (WHERE l.leader_user_id=$1)::int AS winning
                            FROM proxy_bids pb JOIN auction_lots l ON l.id=pb.lot_id WHERE pb.user_id=$1 AND l.status IN ('prebidding','live')`, [user.id]);
  const u = await db.one("SELECT COALESCE(SUM(total_cents-paid_cents),0)::bigint AS n FROM invoices WHERE user_id=$1 AND kind='purchase' AND status IN ('issued','partially_paid')", [user.id]);
  const dep = await db.one("SELECT COALESCE(SUM(amount_cents),0)::bigint AS n FROM deposits WHERE user_id=$1 AND status='held'", [user.id]);
  Object.assign(out, { committed: Number(r.committed), activeLots: r.lots, winning: r.winning, unpaid: Number(u.n), deposits: Number(dep.n) });
  if (out.canBid) {
    out.limit = plan.max_total_cents ? Number(plan.max_total_cents) : (plan.max_bid_cents && plan.max_lots_per_event ? Number(plan.max_bid_cents) * plan.max_lots_per_event : null);
    out.available = out.limit === null ? null : Math.max(0, out.limit - out.committed);
  }
  out.usedPct = out.limit ? Math.min(100, Math.round(out.committed * 100 / out.limit)) : 0;
  return out;
}

module.exports = { placeBid, buyNow, buyingPower, eligibility, increment, incrementFor, minimumNextBid, publicLot, publicLotFull };
