'use strict';
const db = require('../db');

const LOT_SELECT = `
  SELECT l.id, l.lot_number, l.status, l.current_bid_cents, l.starting_bid_cents, l.reserve_cents, l.buy_now_cents, l.bid_count, l.ends_at, l.leader_user_id, l.event_id, l.version, l.sold_via, l.counter_offer_cents, l.closed_at, l.sequence, l.updated_at AS lot_updated_at,
         l.reserve_cents <= COALESCE(l.current_bid_cents, 0) AS reserve_met,
         e.name AS event_name, e.starts_at AS auction_date, e.status AS event_status,
         v.id AS vehicle_id, v.year, v.trim, v.vin, v.odometer_km, v.odometer_status, v.fuel, v.transmission, v.engine, v.color, v.has_keys, v.runs_drives,
         v.condition, v.document_type, v.highlights, v.description, v.estimated_value_cents, v.featured, v.seller_id,
         mk.name AS make, mk.slug AS make_slug, md.name AS model, md.id AS model_id, mk.id AS make_id,
         vt.code AS type_code, vt.name AS type_name,
         d1.code AS damage_code, d1.name AS primary_damage, d2.name AS secondary_damage,
         loc.id AS location_id, loc.code AS location_code, loc.name AS location_name, loc.city AS location_city, loc.country AS location_country,
         (SELECT path FROM vehicle_images vi WHERE vi.vehicle_id = v.id ORDER BY sort, id LIMIT 1) AS image
    FROM auction_lots l
    JOIN auction_events e ON e.id = l.event_id
    JOIN vehicles v ON v.id = l.vehicle_id
    JOIN makes mk ON mk.id = v.make_id
    JOIN models md ON md.id = v.model_id
    JOIN vehicle_types vt ON vt.id = v.vehicle_type_id
    LEFT JOIN damage_types d1 ON d1.id = v.primary_damage_id
    LEFT JOIN damage_types d2 ON d2.id = v.secondary_damage_id
    JOIN locations loc ON loc.id = v.location_id`;

const SORTS = {
  auction_date: 'e.starts_at ASC, l.sequence ASC',
  lot_number: 'l.lot_number ASC',
  year_desc: 'v.year DESC, l.lot_number',
  year_asc: 'v.year ASC, l.lot_number',
  odometer: 'v.odometer_km ASC',
  bid_asc: 'COALESCE(l.current_bid_cents, l.starting_bid_cents) ASC',
  bid_desc: 'COALESCE(l.current_bid_cents, l.starting_bid_cents) DESC',
  make: 'mk.name ASC, md.name ASC',
  newest: 'l.created_at DESC',
};

/** Construye WHERE parametrizado a partir de filtros de URL (nunca concatena valores). */
function buildWhere(f) {
  const where = [], args = [];
  const p = v => { args.push(v); return `$${args.length}`; };
  const statuses = f.status === 'closed' ? ['awarded', 'no_sale', 'pending_seller_approval', 'ended']
    : f.status === 'all' ? null : ['prebidding', 'live', 'scheduled'];
  if (statuses) where.push(`l.status = ANY(${p(statuses)})`);
  where.push(`l.status <> 'cancelled'`);
  if (f.q) {
    const q = f.q.trim();
    if (/^\d{5,}$/.test(q)) where.push(`l.lot_number = ${p(Number(q))}`);
    else where.push(`(mk.name ILIKE ${p('%' + q + '%')} OR md.name ILIKE $${args.length} OR v.trim ILIKE $${args.length} OR (mk.name || ' ' || md.name) ILIKE $${args.length} OR loc.city ILIKE $${args.length} OR v.year::text = ${p(q)}${/^[A-Z0-9]{6,17}$/i.test(q) ? ` OR v.vin ILIKE ${p(q.toUpperCase() + '%')}` : ''})`);
  }
  if (f.lot) where.push(`l.lot_number = ${p(Number(f.lot))}`);
  if (f.condition === 'used' || f.condition === 'salvage') where.push(`v.condition = ${p(f.condition)}`);
  if (f.type) where.push(`vt.code = ${p(f.type)}`);
  if (f.make) where.push(`mk.slug = ${p(f.make)}`);
  if (f.model) where.push(`md.id = ${p(Number(f.model))}`);
  if (f.location) where.push(`loc.code = ${p(f.location)}`);
  if (f.country && /^[A-Z]{2}$/.test(f.country)) where.push(`loc.country = ${p(f.country)}`);
  if (f.province) where.push(`loc.province = ${p(String(f.province))}`);
  if (f.zip && /^[\w -]{2,10}$/.test(String(f.zip))) where.push(`loc.postal_code ILIKE ${p(String(f.zip).trim() + '%')}`);
  if (f.vin && /^[A-Z0-9]{6,17}$/i.test(String(f.vin))) where.push(`v.vin ILIKE ${p(String(f.vin).toUpperCase() + '%')}`);
  if (f.doc) where.push(`v.document_type = ${p(String(f.doc))}`);
  if (f.buy_now) where.push("l.buy_now_cents IS NOT NULL AND COALESCE(l.current_bid_cents,0) < l.buy_now_cents AND l.status = 'prebidding'");
  if (f.runs) where.push('v.runs_drives = true');
  if (f.keys) where.push('v.has_keys = true');
  if (f.pure_sale) where.push('l.reserve_cents = 0');
  if (f.seller_type && /^[a-z]+(,[a-z]+)*$/.test(String(f.seller_type))) where.push(`EXISTS (SELECT 1 FROM sellers sx WHERE sx.id = v.seller_id AND sx.seller_type = ANY(${p(String(f.seller_type).split(','))}))`);
  if (f.damage) where.push(`d1.code = ${p(f.damage)}`);
  if (f.year_from) where.push(`v.year >= ${p(Number(f.year_from))}`);
  if (f.year_to) where.push(`v.year <= ${p(Number(f.year_to))}`);
  if (f.odo_min) where.push(`v.odometer_km >= ${p(Number(f.odo_min))}`);
  if (f.odo_max && Number(f.odo_max) < 250000) where.push(`v.odometer_km <= ${p(Number(f.odo_max))}`);
  if (f.featured) where.push('v.featured = true');
  if (f.fuel) where.push(`v.fuel = ${p(f.fuel)}`);
  if (f.transmission) where.push(`v.transmission = ${p(f.transmission)}`);
  if (f.event) where.push(`l.event_id = ${p(Number(f.event))}`);
  if (f.ids) where.push(`l.id = ANY(${p(f.ids)})`);
  return { sql: where.length ? ' WHERE ' + where.join(' AND ') : '', args };
}

async function searchLots(filters = {}, { perPage = 20 } = {}) {
  const page = Math.max(1, Math.min(500, Number(filters.page) || 1));
  const { sql, args } = buildWhere(filters);
  const order = SORTS[filters.sort] || SORTS.auction_date;
  const total = (await db.one(`SELECT COUNT(*)::int AS n FROM (${LOT_SELECT}${sql}) x`, args)).n;
  const items = await db.many(`${LOT_SELECT}${sql} ORDER BY ${order} LIMIT ${perPage} OFFSET ${(page - 1) * perPage}`, args);
  return { items, total, page, pages: Math.max(1, Math.ceil(total / perPage)), perPage };
}

async function lotByNumber(lotNumber) {
  return db.one(`${LOT_SELECT} WHERE l.lot_number = $1`, [Number(lotNumber)]);
}
async function lotById(id) { return db.one(`${LOT_SELECT} WHERE l.id = $1`, [Number(id)]); }

const OPEN = "l.status IN ('prebidding','live','scheduled')";
/** Contadores del buscador. Con `country`, solo cuenta lotes de sedes de ese país (región del sitio). */
async function facets(country = null) {
  const c = country && /^[A-Z]{2}$/.test(country) ? country : null;
  // $1 es NULL (todas las regiones) o el código de país.
  const IN = `${OPEN} AND ($1::text IS NULL OR EXISTS (SELECT 1 FROM locations lc WHERE lc.id = v.location_id AND lc.country = $1))`;
  const [makes, types, damages, locations, featured] = await Promise.all([
    db.many(`SELECT mk.name, mk.slug, COUNT(l.id)::int AS count FROM makes mk JOIN vehicles v ON v.make_id = mk.id JOIN auction_lots l ON l.vehicle_id = v.id AND ${IN} GROUP BY mk.id ORDER BY mk.name`, [c]),
    db.many(`SELECT vt.code, vt.name, COUNT(l.id)::int AS count FROM vehicle_types vt LEFT JOIN vehicles v ON v.vehicle_type_id = vt.id LEFT JOIN auction_lots l ON l.vehicle_id = v.id AND ${IN} GROUP BY vt.id ORDER BY vt.name`, [c]),
    db.many(`SELECT d.code, d.name, COUNT(l.id)::int AS count FROM damage_types d LEFT JOIN vehicles v ON v.primary_damage_id = d.id LEFT JOIN auction_lots l ON l.vehicle_id = v.id AND ${IN} GROUP BY d.id ORDER BY d.name`, [c]),
    db.many(`SELECT loc.code, loc.name, loc.city, loc.country, COUNT(l.id)::int AS count FROM locations loc LEFT JOIN vehicles v ON v.location_id = loc.id LEFT JOIN auction_lots l ON l.vehicle_id = v.id AND ${IN} WHERE loc.active AND ($1::text IS NULL OR loc.country = $1) GROUP BY loc.id ORDER BY loc.name`, [c]),
    db.one(`SELECT COUNT(*) FILTER (WHERE v.featured)::int AS featured, COUNT(*) FILTER (WHERE v.odometer_km < 50000)::int AS low_mileage, COUNT(*) FILTER (WHERE v.fuel IN ('electric','hybrid'))::int AS electrified, COUNT(*) FILTER (WHERE v.transmission='automatic')::int AS automatic, COUNT(*) FILTER (WHERE v.runs_drives)::int AS runs,
                   COUNT(*) FILTER (WHERE v.fuel='electric')::int AS electric, COUNT(*) FILTER (WHERE v.fuel='hybrid')::int AS hybrid, COUNT(*) FILTER (WHERE v.has_keys)::int AS keys,
                   COUNT(*) FILTER (WHERE l.buy_now_cents IS NOT NULL AND COALESCE(l.current_bid_cents,0) < l.buy_now_cents AND l.status='prebidding')::int AS buy_now,
                   COUNT(*) FILTER (WHERE l.reserve_cents = 0)::int AS pure_sale,
                   COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM sellers sx WHERE sx.id=v.seller_id AND sx.seller_type IN ('rental','fleet','leasing')))::int AS fleet,
                   COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM damage_types dx WHERE dx.id=v.primary_damage_id AND dx.code='theft'))::int AS theft,
                   COUNT(*) FILTER (WHERE l.created_at > now() - interval '7 days')::int AS recent
              FROM auction_lots l JOIN vehicles v ON v.id = l.vehicle_id WHERE ${IN}`, [c]),
  ]);
  const [docs, provinces] = await Promise.all([
    db.many(`SELECT v.document_type AS name, COUNT(l.id)::int AS count FROM vehicles v JOIN auction_lots l ON l.vehicle_id = v.id AND ${IN} GROUP BY v.document_type ORDER BY count DESC`, [c]),
    db.many(`SELECT loc.province AS name, COUNT(l.id)::int AS count FROM locations loc JOIN vehicles v ON v.location_id = loc.id JOIN auction_lots l ON l.vehicle_id = v.id AND ${IN} WHERE loc.active GROUP BY loc.province ORDER BY loc.province`, [c]),
  ]);
  featured.docs = docs; featured.provinces = provinces;
  return { makes, types, damages, locations, featured };
}

async function makesWithModels() {
  const rows = await db.many('SELECT mk.id, mk.name, mk.slug, md.id AS model_id, md.name AS model FROM makes mk LEFT JOIN models md ON md.make_id = mk.id ORDER BY mk.name, md.name');
  const map = new Map();
  for (const r of rows) {
    if (!map.has(r.id)) map.set(r.id, { id: r.id, name: r.name, slug: r.slug, models: [] });
    if (r.model_id) map.get(r.id).models.push({ id: r.model_id, name: r.model });
  }
  return [...map.values()];
}

const maskVin = vin => (vin ? vin.slice(0, 11) + '******' : '');

module.exports = { searchLots, lotByNumber, lotById, facets, makesWithModels, maskVin, LOT_SELECT, SORTS };
