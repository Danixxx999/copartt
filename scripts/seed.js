'use strict';
/**
 * Seed idempotente. Datos ficticios: VIN, documentos, personas, empresas, IBAN.
 *  - Catálogos (marcas, modelos, tipos, daños, sedes, planes, roles, permisos, ajustes): upsert siempre.
 *  - Datos de demostración (usuarios, vehículos, subastas, compras): solo si aún no existen (marca 'demo_seeded_at').
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('../src/db');
const config = require('../src/config');
const { migrate } = require('./migrate');
const { hashPassword, loadUserById } = require('../src/lib/auth');
const settings = require('../src/lib/settings');

// ───────── Utilidades deterministas ─────────
let seedState = 20261111;
const rnd = () => { seedState = (seedState * 1103515245 + 12345) % 2 ** 31; return seedState / 2 ** 31; };
const pick = arr => arr[Math.floor(rnd() * arr.length)];
const slug = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
function fakeVin(i) { const chars = 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789'; let s = 'DEMO'; for (let k = 0; k < 9; k++) s += chars[Math.floor(rnd() * chars.length)]; return s + String(i).padStart(4, '0'); }

/** Fecha a una hora local de Madrid (respeta horario de verano). */
function madrid(date, hour, minute = 0) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour, minute));
  const off = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Madrid', timeZoneName: 'shortOffset' }).formatToParts(d).find(p => p.type === 'timeZoneName').value; // "GMT+1"
  const h = Number(off.replace('GMT', '') || 0);
  return new Date(d.getTime() - h * 3600_000);
}
function nextWeekday(dow, hour, skip = 0) { // dow: 0=dom..6=sáb
  const now = new Date(); const d = new Date(now);
  // Hasta 28 días para cubrir siempre la 2ª/3ª ocurrencia aunque hoy sea ese mismo día.
  for (let i = 0; i < 28; i++) { d.setUTCDate(now.getUTCDate() + i); const t = madrid(d, hour); if (t.getUTCDay() === dow && t > now) { if (skip-- <= 0) return t; } }
  throw new Error('no date');
}

// ───────── Datos de referencia ─────────
const ROLES = [
  ['buyer', 'Buyer', 'Member who bids and buys vehicles.'], ['seller', 'Seller', 'Company or individual that lists vehicles.'],
  ['admin', 'Administrator', 'Owner / platform administrator with full control.'], ['finance', 'Finance', 'Reviews payments and invoices.'], ['ops', 'Operations & Logistics', 'Yards, pickups and transport.'],
];
const PERMISSIONS = {
  'bids.place': 'Place bids and pre-bids', 'vehicles.sell': 'Create and manage own vehicles',
  'users.manage': 'Manage users, roles and memberships', 'documents.review': 'Review identity documents',
  'catalog.manage': 'Manage makes, models, types, damages', 'vehicles.approve': 'Approve or reject seller vehicles',
  'auctions.manage': 'Manage auction events and lots', 'locations.manage': 'Manage yards/locations',
  'finance.review': 'Review payments and reconcile', 'invoices.manage': 'Manage invoices',
  'logistics.manage': 'Manage transport and pickups', 'pickup.validate': 'Validate pickup PIN',
  'reports.view': 'View and export reports', 'settings.manage': 'Edit system settings and limits',
  'content.manage': 'Edit content pages and banners', 'audit.view': 'View audit log', 'support.manage': 'Manage support tickets',
  'roles.manage': 'Create roles and edit role permissions', 'users.impersonate': 'Sign in as another user (audited)',
};
const ROLE_PERMS = {
  buyer: ['bids.place'], seller: ['vehicles.sell'], admin: Object.keys(PERMISSIONS).filter(p => p !== 'bids.place' && p !== 'vehicles.sell'),
  finance: ['finance.review', 'invoices.manage', 'reports.view'], ops: ['logistics.manage', 'pickup.validate', 'reports.view'],
};
const MAKES = {
  'Audi': ['A1 Sportback', 'A3 Sportback', 'A4 Avant', 'Q3', 'Q5'], 'BMW': ['118i', '218i Gran Coupé', '320d', 'X1 sDrive18d', 'X3 xDrive20d'],
  'Citroën': ['C3', 'C4', 'C5 Aircross', 'Berlingo'], 'Dacia': ['Sandero', 'Duster', 'Spring'], 'Fiat': ['500', 'Panda', 'Tipo', 'Ducato'],
  'Ford': ['Fiesta', 'Focus', 'Kuga', 'Transit Custom', 'Mustang Mach-E'], 'Honda': ['Civic', 'CR-V', 'PCX 125'], 'Hyundai': ['i20', 'i30', 'Tucson', 'Kona'],
  'Iveco': ['Daily', 'S-Way'], 'Kia': ['Picanto', 'Ceed', 'Sportage', 'Niro'], 'Mercedes-Benz': ['Clase A 180', 'Clase C 220d', 'GLC 300', 'Sprinter', 'Vito'],
  'MG': ['ZS', 'MG4'], 'Nissan': ['Micra', 'Qashqai', 'Juke'], 'Opel': ['Corsa', 'Astra', 'Grandland X'], 'Peugeot': ['208', '308', '2008', '3008', 'Partner'],
  'Renault': ['Clio', 'Captur', 'Mégane', 'Kangoo', 'Zoe'], 'Seat': ['Ibiza', 'León', 'Arona', 'Ateca'], 'Skoda': ['Fabia', 'Octavia'],
  'Tesla': ['Model 3', 'Model Y'], 'Toyota': ['Yaris', 'Corolla', 'C-HR', 'RAV4'], 'Volkswagen': ['Polo', 'Golf', 'T-Roc', 'Tiguan', 'Transporter'],
  'Volvo': ['XC40', 'XC60'], 'Yamaha': ['MT-07', 'X-Max 300'], 'Kawasaki': ['Z650'], 'Piaggio': ['Liberty 125'],
};
const TYPES = [['automobile', 'Automobile'], ['suv', 'SUV'], ['van', 'Vans'], ['commercial', 'Commercial Vehicles'], ['motorcycle', 'Motorcycles'], ['quad', 'Quads & ATV']];
const DAMAGES = [['front', 'Front damage'], ['rear', 'Rear damage'], ['side', 'Side damage'], ['mechanical', 'Mechanical damage'], ['minor', 'Minor dents/scratches'], ['all_over', 'All over'], ['flood', 'Water/flood'], ['hail', 'Hail'], ['theft', 'Recovered from theft'], ['burn', 'Burn'], ['normal_wear', 'Normal wear'], ['undercarriage', 'Undercarriage']];
const LOCATIONS = [
  ['MAD', 'Madrid – Getafe (demo)', 'Polígono Industrial Los Olivos, C/ Demo 12', 'Getafe', 'Madrid', '28906', 40.305, -3.732],
  ['BCN', 'Barcelona – Martorell (demo)', 'Carrer de la Demo 45, Pol. Ind. Can Sunyer', 'Martorell', 'Barcelona', '08760', 41.474, 1.930],
  ['SVQ', 'Sevilla – Dos Hermanas (demo)', 'Avda. del Ejemplo 7, Pol. Carretera de la Isla', 'Dos Hermanas', 'Sevilla', '41703', 37.286, -5.934],
  ['VLC', 'Valencia – Riba-roja (demo)', 'C/ Ficticia 3, Pol. Ind. El Oliveral', 'Riba-roja de Túria', 'Valencia', '46394', 39.512, -0.554],
  ['ZAZ', 'Zaragoza – Plaza (demo)', 'Avda. Ranillas Demo 101, PLAZA', 'Zaragoza', 'Zaragoza', '50197', 41.630, -0.990],
  ['AGP', 'Málaga – Campanillas (demo)', 'C/ Prueba 18, PTA', 'Málaga', 'Málaga', '29590', 36.735, -4.548],
];
// Sedes ficticias en las demás regiones del selector "Región del sitio web".
// [código, nombre, dirección, ciudad, provincia/estado, CP, lat, lng, país, teléfono]
const INTL_LOCATIONS = [
  ['DAL', 'Dallas, TX (demo)', '100 Demo Rd', 'Dallas', 'Texas', '75201', 32.78, -96.80, 'US', '+1 555 010 0100'],
  ['MIA', 'Miami, FL (demo)', '200 Example Ave', 'Miami', 'Florida', '33101', 25.76, -80.19, 'US', '+1 555 010 0200'],
  ['TOR', 'Toronto, ON (demo)', '10 Sample St', 'Toronto', 'Ontario', 'M5H 2N2', 43.65, -79.38, 'CA', '+1 555 010 0300'],
  ['LON', 'London – Dartford (demo)', '1 Fictional Way', 'Dartford', 'Kent', 'DA1 1AA', 51.44, 0.22, 'GB', '+44 20 0000 0000'],
  ['DUB', 'Dublin (demo)', 'Unit 3, Demo Park', 'Dublin', 'Leinster', 'D12', 53.33, -6.30, 'IE', '+353 1 000 0000'],
  ['DXB', 'Dubai (demo)', 'Plot 7, Example Area', 'Dubai', 'Dubai', '00000', 25.20, 55.27, 'AE', '+971 4 000 0000'],
  ['BAH', 'Manama (demo)', 'Block 9, Demo Road', 'Manama', 'Capital', '317', 26.22, 50.58, 'BH', '+973 1700 0000'],
  ['MCT', 'Muscat (demo)', 'Way 12, Example Ind. Area', 'Muscat', 'Muscat', '100', 23.59, 58.41, 'OM', '+968 2400 0000'],
  ['BER', 'Berlin (demo)', 'Musterstraße 1', 'Berlin', 'Berlin', '10115', 52.52, 13.40, 'DE', '+49 30 0000000'],
  ['HEL', 'Helsinki (demo)', 'Esimerkkitie 5', 'Vantaa', 'Uusimaa', '01510', 60.29, 24.96, 'FI', '+358 9 000 0000'],
  ['SAO', 'São Paulo (demo)', 'Rua Exemplo 100', 'São Paulo', 'SP', '01000-000', -23.55, -46.63, 'BR', '+55 11 0000 0000'],
];
const PLANS = [
  { code: 'guest', name: 'Guest', price: 0, can_bid: false, max_bid: null, max_total: null, max_lots: null, docs: false, sort: 1, description: "For those who want to look at auctions, but don't want to bid.", features: ['View an auction', 'Add vehicles to your Watchlist', 'Create vehicle alerts'] },
  { code: 'basic', name: 'Basic', price: 2642, can_bid: true, max_bid: 500000, max_total: null, max_lots: 3, docs: true, sort: 2, description: 'For those who plan to buy only a few vehicles per year.', features: ['Access and participate in our online auctions', 'Use the Calculator Fee', 'Bid on a vehicle up to 5.000€ in every auction', 'Save your favorite searches'] },
  { code: 'premium', name: 'Premium', price: 5284, can_bid: true, max_bid: null, max_total: 30000000, max_lots: 30, docs: true, sort: 3, description: 'For those who plan to buy multiple vehicles on a regular basis.', features: ['Everything included in Basic', 'Bid on up to 30 vehicles at each auction with a limit of 300.000€', 'Receive priority customer service', 'Receive phone support'] },
];
const SETTINGS = {
  bid_increments: [[{ up_to_cents: 50000, increment_cents: 2500 }, { up_to_cents: 200000, increment_cents: 5000 }, { up_to_cents: 1000000, increment_cents: 10000 }, { up_to_cents: null, increment_cents: 25000 }], 'Bid increment table (cents). Last row applies to any amount.'],
  live_lot_seconds: [20, 'Seconds each lot stays open in the live auction room before closing.'],
  bid_extension_seconds: [10, 'If a bid arrives with less than this time left, the lot clock is extended.'],
  buyer_fee: [{ percent: 8, min_cents: 15000 }, 'Buyer fee (academic demo values, not real tariffs).'],
  admin_fee_cents: [7500, 'Fixed administration fee per purchase (demo).'],
  fee_tax_rate: [21, 'VAT % applied to fees (demo).'],
  vehicle_tax_rate: [0, 'VAT % applied to the hammer price (demo; depends on the fiscal regime of each vehicle).'],
  payment_due_days: [5, 'Days to pay an invoice after winning.'],
  transport_rates: [{ base_cents: 9000, per_km_cents: 95, express_multiplier: 1.5, international_flat_cents: 45000 }, 'Demo transport quote parameters.'],
  bank_details: [{ beneficiary: 'copart Demo S.L. (FICTITIOUS)', iban: 'ES00 0000 0000 0000 0000 0000', bic: 'DEMOESMMXXX', bank: 'Banco de Pruebas (no real account)' }, 'Bank data shown for transfer payments (fictitious).'],
  social_links: [{ facebook: '', instagram: '', tiktok: '', linkedin: '', youtube: '' }, 'URLs of the social accounts shown in "Follow us" (empty = icon shown without link).'],
  auction_announcement: ['Subastas todos los martes y jueves a las 11:00 (hora de Madrid). Consulte el Listado de Ventas para ver los próximos lotes.', 'Announcement shown on the auction calendar.'],
};
const PAGES = {
  terms: ['General Terms and Conditions', '<p><strong>Academic project – not an official website.</strong> These terms are a fictitious example created for a university assignment. No real contracts, payments or vehicle transfers take place.</p><h2>1. Members</h2><p>Only registered members with an approved membership and verified documentation may place bids. Bids are binding within the demo environment.</p><h2>2. Bids</h2><p>Maximum (proxy) bids are executed automatically by the system up to the amount set by the member. The server clock decides the closing time.</p><h2>3. Payment</h2><p>Vehicle amounts must be paid by bank transfer within the period indicated on the invoice. Fees may be paid by card (sandbox).</p><h2>4. Collection</h2><p>A pickup PIN is issued once payment has been validated by Finance.</p>'],
  privacy: ['Privacy Policy', '<p><strong>Academic project.</strong> Personal data entered in this demo is stored only in the local database of the installation and is used solely to demonstrate functionality. Do not enter real personal data.</p><h2>Data we store</h2><ul><li>Account data (name, email, phone)</li><li>Uploaded documents (stored privately, only visible to the owner and reviewers)</li><li>Bidding and purchase history</li></ul><h2>Your rights</h2><p>You can request deletion of your demo account through the contact form.</p>'],
  'cookie-policy': ['Cookie Policy', '<p>This demo uses only technical cookies: <code>ap_sid</code> (session, HttpOnly), <code>ap_csrf</code> (security token) and <code>ap_lang</code> (language preference). No tracking or advertising cookies are used.</p>'],
  'company-details': ['Company Details', '<p>copart is a <strong>fictitious company</strong> created for an academic software project. It is not affiliated with, endorsed by or connected to Copart Inc. or any of its subsidiaries.</p><p>Address: Calle Ficticia 1, 28000 Madrid (demo) · Tax ID: B00000000 (demo)</p>'],
  'about-us': ['About Us', '<p>copart is an academic replica of an online vehicle auction platform, built as a university project to demonstrate a complete full-stack system: public website, buyer and seller portals, real-time auctions, invoicing, payments, logistics and administration.</p>'],
};

async function upsertReference() {
  // Los permisos por defecto solo se asignan a roles o permisos NUEVOS: así, repetir el seed
  // no deshace los cambios que el propietario haya hecho en /admin/roles.
  const newRoles = new Set(), newPerms = new Set();
  for (const [code, name, desc] of ROLES) {
    const r = await db.one('INSERT INTO roles(code,name,description,is_system) VALUES ($1,$2,$3,true) ON CONFLICT (code) DO UPDATE SET is_system=true RETURNING (xmax = 0) AS inserted', [code, name, desc]);
    if (r.inserted) newRoles.add(code);
  }
  for (const [code, desc] of Object.entries(PERMISSIONS)) {
    const r = await db.one('INSERT INTO permissions(code,description) VALUES ($1,$2) ON CONFLICT (code) DO UPDATE SET description=EXCLUDED.description RETURNING (xmax = 0) AS inserted', [code, desc]);
    if (r.inserted) newPerms.add(code);
  }
  for (const [role, perms] of Object.entries(ROLE_PERMS)) for (const p of perms) if (newRoles.has(role) || newPerms.has(p))
    await db.query('INSERT INTO role_permissions(role_id, permission_id) SELECT r.id, p.id FROM roles r, permissions p WHERE r.code=$1 AND p.code=$2 ON CONFLICT DO NOTHING', [role, p]);
  for (const [make, models] of Object.entries(MAKES)) {
    const m = await db.one('INSERT INTO makes(name, slug) VALUES ($1,$2) ON CONFLICT (name) DO UPDATE SET slug=EXCLUDED.slug RETURNING id', [make, slug(make)]);
    for (const model of models) await db.query('INSERT INTO models(make_id, name) VALUES ($1,$2) ON CONFLICT DO NOTHING', [m.id, model]);
  }
  for (const [code, name] of TYPES) await db.query('INSERT INTO vehicle_types(code,name) VALUES ($1,$2) ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name', [code, name]);
  for (const [code, name] of DAMAGES) await db.query('INSERT INTO damage_types(code,name) VALUES ($1,$2) ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name', [code, name]);
  for (const [code, name, address, city, province, cp, lat, lng] of LOCATIONS)
    await db.query(`INSERT INTO locations(code,name,address,city,province,postal_code,phone,email,hours,pickup_hours,lat,lng,description)
                    VALUES ($1,$2,$3,$4,$5,$6,'+34 900 000 000',$7,'Mon–Fri 8:00–15:00','Mon–Fri 9:00–14:00 (appointment required)',$8,$9,$10)
                    ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, address=EXCLUDED.address, lat=EXCLUDED.lat, lng=EXCLUDED.lng`,
      [code, name, address, city, province, cp, `${code.toLowerCase()}@copart.test`, lat, lng, `Demo yard in ${city}. Vehicles can be viewed by appointment before bidding. Pickup with PIN after payment.`]);
  for (const [code, name, address, city, province, cp, lat, lng, country, phone] of INTL_LOCATIONS)
    await db.query(`INSERT INTO locations(code,name,address,city,province,postal_code,phone,email,hours,pickup_hours,lat,lng,description,country)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Mon–Fri 8:00–16:00 (local time)','Mon–Fri 9:00–15:00 (appointment required)',$9,$10,$11,$12)
                    ON CONFLICT (code) DO UPDATE SET name=EXCLUDED.name, country=EXCLUDED.country`,
      [code, name, address, city, province, cp, phone, `${code.toLowerCase()}@copart.test`, lat, lng, `Fictitious demo yard in ${city}. Shown when this region is selected.`, country]);
  for (const p of PLANS)
    await db.query(`INSERT INTO membership_plans(code,name,description,price_cents,can_bid,max_bid_cents,max_total_cents,max_lots_per_event,requires_documents,features,sort)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (code) DO NOTHING`,
      [p.code, p.name, p.description, p.price, p.can_bid, p.max_bid, p.max_total, p.max_lots, p.docs, JSON.stringify(p.features), p.sort]);
  for (const [key, [value, description]] of Object.entries(SETTINGS))
    await db.query('INSERT INTO system_settings(key,value,description) VALUES ($1,$2,$3) ON CONFLICT (key) DO NOTHING', [key, JSON.stringify(value), description]);
  // El anuncio antiguo (en inglés) se traduce solo si nadie lo ha editado.
  await db.query("UPDATE system_settings SET value=$1 WHERE key='auction_announcement' AND value=$2", [JSON.stringify(SETTINGS.auction_announcement[0]), JSON.stringify('Auctions every Tuesday and Thursday at 11 AM. Please visit our upcoming Sales List soon.')]);
  for (const [s, [title, body]] of Object.entries(PAGES)) await db.query('INSERT INTO content_pages(slug,title,body_html) VALUES ($1,$2,$3) ON CONFLICT (slug) DO NOTHING', [s, title, body]);
  const banner = await db.one("SELECT id FROM banners WHERE placement='top'");
  if (!banner) await db.query("INSERT INTO banners(placement,text,link_text,link_url) VALUES ('top','View Upcoming Auction Schedule','click here','/auctions/calendar')");
  settings.invalidate();
}

// ───────── Datos de demostración ─────────
async function createUser({ email, first, last, roles, plan, verification = 'approved', accountType = 'individual', company = null, city = 'Madrid' }) {
  const exists = await db.one('SELECT id FROM users WHERE lower(email)=lower($1)', [email]);
  if (exists) return exists.id;
  const hash = await hashPassword(config.demoPassword);
  const u = await db.one(`INSERT INTO users(email,password_hash,account_type,verification_status,registration_step) VALUES ($1,$2,$3,$4,'complete') RETURNING id`, [email, hash, accountType, verification]);
  await db.query(`INSERT INTO profiles(user_id,first_name,last_name,phone,company_name,city,address,postal_code,terms_accepted_at) VALUES ($1,$2,$3,$4,$5,$6,'Calle Demo 1','28001',now())`, [u.id, first, last, '600' + String(100000 + u.id).slice(-6), company, city]);
  for (const r of roles) await db.query('INSERT INTO user_roles(user_id, role_id) SELECT $1, id FROM roles WHERE code=$2', [u.id, r]);
  if (plan) await db.query(`INSERT INTO subscriptions(user_id, plan_id, status, starts_at, ends_at, payment_reference) SELECT $1, id, 'active', now() - interval '30 days', now() + interval '335 days', 'SEED' FROM membership_plans WHERE code=$2`, [u.id, plan]);
  if (verification !== 'unverified') {
    const file = writePrivateFile(`id-${u.id}.txt`, `FICTITIOUS ID DOCUMENT – demo user ${email}`);
    await db.query(`INSERT INTO verification_documents(user_id, doc_type, file_path, original_name, mime, size_bytes, status, reviewed_at) VALUES ($1,'id_card',$2,'dni-demo.pdf','application/pdf',64,$3,$4)`,
      [u.id, file, verification === 'pending' ? 'pending' : verification, verification === 'pending' ? null : new Date()]);
  }
  return u.id;
}
function writePrivateFile(name, content) {
  fs.mkdirSync(config.privateDir, { recursive: true });
  const rel = `seed-${name}`; fs.writeFileSync(path.join(config.privateDir, rel), content); return rel;
}

const COLORS = ['#1f2937', '#e5e7eb', '#b91c1c', '#1d4ed8', '#6b7280', '#f5f5f4', '#065f46', '#0f172a', '#9ca3af', '#7c2d12'];
const VIEWS = ['front', 'side', 'rear', 'interior'];
function typeFor(make, model) {
  if (['Yamaha', 'Kawasaki', 'Piaggio'].includes(make) || /PCX/.test(model)) return 'motorcycle';
  if (/Daily|S-Way/.test(model)) return 'commercial';
  if (/Transit|Sprinter|Vito|Transporter|Ducato|Kangoo|Berlingo|Partner/.test(model)) return 'van';
  if (/Q3|Q5|X1|X3|Aircross|Duster|Kuga|Mach-E|CR-V|Tucson|Kona|Sportage|Niro|GLC|ZS|Qashqai|Juke|Grandland|2008|3008|Captur|Arona|Ateca|Model Y|C-HR|RAV4|T-Roc|Tiguan|XC40|XC60/.test(model)) return 'suv';
  return 'automobile';
}
async function createVehicle(i, { sellerId, status = 'approved', featured = false, location = null }) {
  const make = pick(Object.keys(MAKES)); const model = pick(MAKES[make]);
  const ids = await db.one('SELECT mk.id AS make_id, md.id AS model_id FROM makes mk JOIN models md ON md.make_id=mk.id WHERE mk.name=$1 AND md.name=$2', [make, model]);
  const type = typeFor(make, model);
  const year = 2012 + Math.floor(rnd() * 14);
  const damage = pick(DAMAGES)[0];
  const salvage = !['normal_wear', 'minor'].includes(damage);
  const loc = location || pick(LOCATIONS)[0];
  const fuel = /Mach-E|Zoe|Spring|Model|MG4/.test(model) ? 'electric' : /Niro|C-HR|RAV4|Corolla/.test(model) ? 'hybrid' : pick(['petrol', 'diesel', 'petrol', 'diesel']);
  const km = type === 'motorcycle' ? Math.floor(rnd() * 40000) : Math.floor(rnd() * 220000);
  const value = type === 'commercial' ? 2500000 + Math.floor(rnd() * 4000000) : type === 'motorcycle' ? 150000 + Math.floor(rnd() * 500000) : 300000 + Math.floor(rnd() * 2500000);
  const color = pick(COLORS);
  const v = await db.one(`INSERT INTO vehicles(seller_id, make_id, model_id, vehicle_type_id, primary_damage_id, secondary_damage_id, location_id, year, trim, vin, odometer_km, fuel, transmission, engine, color, has_keys, runs_drives, condition, document_type, highlights, description, estimated_value_cents, featured, status, submitted_at, approved_at)
    VALUES ($1,$2,$3,(SELECT id FROM vehicle_types WHERE code=$4),(SELECT id FROM damage_types WHERE code=$5),(SELECT id FROM damage_types WHERE code=$6),(SELECT id FROM locations WHERE code=$7),$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24, now(), CASE WHEN $24 IN ('approved','sold') THEN now() END) RETURNING id`,
    [sellerId, ids.make_id, ids.model_id, type, damage, pick(['minor', 'normal_wear', 'side', 'rear']), loc, year, pick(['', 'Business Edition', 'Sport', 'Style', 'Adrenalin', 'Advance']), fakeVin(i), km, fuel,
      rnd() > 0.6 ? 'automatic' : 'manual', type === 'motorcycle' ? '689 cc' : pick(['1.0 TSI', '1.5 dCi', '2.0 TDI', '1.2 PureTech', '1.6 GDi', 'Electric motor']), color, rnd() > 0.15, rnd() > 0.25,
      salvage ? 'salvage' : 'used', salvage ? pick(['Baja temporal', 'Permiso de circulación', 'Certificado de destrucción no emitido']) : 'Permiso de circulación',
      pick(['Run and Drive', 'Engine starts', 'Keys available', 'Enhanced vehicle', '']), `Fictitious demo vehicle. Inspection recommended at the yard before bidding.`, value, featured, status]);
  const views = salvage ? VIEWS : VIEWS.slice(0, 3);
  for (const [k, view] of views.entries()) await db.query('INSERT INTO vehicle_images(vehicle_id, path, sort) VALUES ($1,$2,$3)', [v.id, `/media/car/${type}.svg?view=${view}&color=${encodeURIComponent(color)}&damage=${salvage ? damage : 'none'}&seed=${v.id}`, k]);
  return { id: v.id, value };
}

let lotCounter = 50730100;
async function createEvent(name, startsAt, status = 'scheduled', locationCode = null) {
  return db.one(`INSERT INTO auction_events(name, starts_at, status, location_id, started_at, ended_at) VALUES ($1,$2,$3,(SELECT id FROM locations WHERE code=$4), CASE WHEN $3 IN ('live','ended') THEN $2::timestamptz END, CASE WHEN $3='ended' THEN $2::timestamptz + interval '2 hours' END) RETURNING *`, [name, startsAt, status, locationCode]);
}
async function addLot(eventId, seq, vehicle, status = 'prebidding') {
  const start = Math.max(10000, Math.round(vehicle.value * 0.15 / 2500) * 2500);
  const reserve = Math.round(vehicle.value * 0.35 / 2500) * 2500;
  lotCounter += 7 + Math.floor(rnd() * 90);
  // "Buy It Now" en uno de cada tres lotes con prepuja abierta (precio fijo por encima de la reserva).
  const buyNow = status === 'prebidding' && seq % 3 === 2 ? Math.round(vehicle.value * 0.62 / 2500) * 2500 : null;
  return db.one(`INSERT INTO auction_lots(lot_number, event_id, vehicle_id, sequence, status, starting_bid_cents, reserve_cents, buy_now_cents) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`, [lotCounter, eventId, vehicle.id, seq, status, start, reserve, buyNow]);
}

async function seedDemo() {
  const marker = await db.one("SELECT value FROM system_settings WHERE key='demo_seeded_at'");
  if (marker) { console.log('Datos demo ya presentes (', marker.value, '). Nada que hacer.'); return; }
  const { placeBid } = require('../src/services/bidding');
  const orders = require('../src/services/orders');
  const { matchLot } = require('../src/services/alerts');

  const U = {};
  U.admin = await createUser({ email: 'admin@copart.test', first: 'Lucas', last: 'Botero', roles: ['admin'] });
  U.finance = await createUser({ email: 'finanzas@copart.test', first: 'Fernando', last: 'Finanzas', roles: ['finance'] });
  U.ops = await createUser({ email: 'logistica@copart.test', first: 'Lucía', last: 'Logística', roles: ['ops'] });
  U.seller = await createUser({ email: 'vendedor@copart.test', first: 'Sergio', last: 'Seguros', roles: ['seller'], accountType: 'business', company: 'Aseguradora Ficticia S.A.' });
  U.seller2 = await createUser({ email: 'renting@copart.test', first: 'Rosa', last: 'Renting', roles: ['seller'], accountType: 'business', company: 'Renting Demo Flotas S.L.' });
  U.guest = await createUser({ email: 'guest@copart.test', first: 'Gabriel', last: 'Invitado', roles: ['buyer'], plan: 'guest', verification: 'unverified' });
  U.basic = await createUser({ email: 'basic@copart.test', first: 'Beatriz', last: 'Básica', roles: ['buyer'], plan: 'basic', city: 'Valencia' });
  U.premium = await createUser({ email: 'premium@copart.test', first: 'Pablo', last: 'Premium', roles: ['buyer'], plan: 'premium', accountType: 'business', company: 'Talleres Pablo S.L.', city: 'Sevilla' });
  U.premium2 = await createUser({ email: 'premium2@copart.test', first: 'Marta', last: 'Desguaces', roles: ['buyer'], plan: 'premium', accountType: 'business', company: 'Desguaces Marta S.L.', city: 'Barcelona' });
  U.pending = await createUser({ email: 'pendiente@copart.test', first: 'Pedro', last: 'Pendiente', roles: ['buyer'], plan: 'basic', verification: 'pending' });

  const sellerRow = async (uid, company, type) => (await db.one('INSERT INTO sellers(user_id, company_name, seller_type, approved) VALUES ($1,$2,$3,true) ON CONFLICT (user_id) DO UPDATE SET approved=true RETURNING id', [uid, company, type])).id;
  const S1 = await sellerRow(U.seller, 'Aseguradora Ficticia S.A.', 'insurance');
  const S2 = await sellerRow(U.seller2, 'Renting Demo Flotas S.L.', 'rental');

  let vi = 1;
  // Evento pasado (cerrado) → compras en distintos estados
  const past = await createEvent('Jueves en toda España', madrid(new Date(Date.now() - 6 * 86400_000), 11), 'ended');
  const pastLots = [];
  for (let s = 1; s <= 6; s++) { const v = await createVehicle(vi++, { sellerId: s % 2 ? S1 : S2, status: 'sold' }); pastLots.push(await addLot(past.id, s, v, 'live')); }
  const winners = [U.premium, U.basic, U.premium, U.premium2, U.premium, U.basic];
  const awarded = [];
  for (const [k, lot] of pastLots.entries()) {
    const w = winners[k]; const other = w === U.premium ? U.premium2 : U.premium;
    const price = lot.starting_bid_cents + 25000 * (2 + k);
    await db.query("INSERT INTO bids(lot_id,user_id,kind,amount_cents,max_cents,created_at) VALUES ($1,$2,'prebid',$3,$3,$5), ($1,$4,'live',$6,$6,$5 + interval '1 minute')", [lot.id, other, price - 25000, w, past.starts_at, price]);
    if (k === 5) { // sin alcanzar reserva → pendiente aprobación vendedor
      const l = await db.one("UPDATE auction_lots SET status='pending_seller_approval', current_bid_cents=$2, leader_user_id=$3, bid_count=2, closed_at=$4 WHERE id=$1 RETURNING *", [lot.id, Math.min(price, lot.reserve_cents - 2500), w, past.starts_at]);
      await db.query("UPDATE vehicles SET status='approved' WHERE id=$1", [l.vehicle_id]);
      continue;
    }
    const l = await db.one("UPDATE auction_lots SET status='awarded', current_bid_cents=$2, leader_user_id=$3, bid_count=2, closed_at=$4 WHERE id=$1 RETURNING *", [lot.id, Math.max(price, lot.reserve_cents), w, past.starts_at]);
    awarded.push(await db.tx(c => orders.createOrderForLot(c, l)));
  }
  // Estados variados de compra
  const proof = { path: writePrivateFile('transfer-demo.txt', 'FICTITIOUS BANK TRANSFER RECEIPT'), originalname: 'transferencia-demo.pdf', mimetype: 'application/pdf', size: 32 };
  const inv = async o => db.one("SELECT id FROM invoices WHERE order_id=$1 AND kind='purchase'", [o.id]);
  const buyer = id => ({ id });
  // awarded[0] premium: pending_payment (se queda así)
  // awarded[1] basic: transferencia del vehículo enviada → revisión Finanzas
  await orders.submitPayment({ user: buyer(U.basic), invoiceId: (await inv(awarded[1])).id, method: 'card_demo', scope: 'fees' });
  await orders.submitPayment({ user: buyer(U.basic), invoiceId: (await inv(awarded[1])).id, method: 'bank_transfer', scope: 'vehicle', reference: 'TRF-2026-0001', proof });
  // awarded[2] premium: pagado y aprobado → listo para retiro (PIN)
  const finance = await loadUserById(U.finance);
  for (const scope of ['fees', 'vehicle']) {
    const p = await orders.submitPayment({ user: buyer(U.premium), invoiceId: (await inv(awarded[2])).id, method: scope === 'fees' ? 'card_demo' : 'bank_transfer', scope, reference: 'TRF-2026-0002', proof });
    if (p.status === 'pending_review') await orders.reviewPayment({ actor: finance, paymentId: p.id, approve: true, note: 'Matched with bank statement' });
  }
  // awarded[3] premium2: pagado y retirado (completado)
  for (const scope of ['fees', 'vehicle']) {
    const p = await orders.submitPayment({ user: buyer(U.premium2), invoiceId: (await inv(awarded[3])).id, method: scope === 'fees' ? 'card_demo' : 'bank_transfer', scope, reference: 'TRF-2026-0003', proof });
    if (p.status === 'pending_review') await orders.reviewPayment({ actor: finance, paymentId: p.id, approve: true, note: 'OK' });
  }
  const pass = await db.one('SELECT pin_code FROM pickup_passes WHERE order_id=$1', [awarded[3].id]);
  await orders.validatePickup({ actor: await loadUserById(U.ops), orderNumber: awarded[3].order_number, pin: pass.pin_code });
  // awarded[4] premium: pagado + transporte solicitado
  for (const scope of ['fees', 'vehicle']) {
    const p = await orders.submitPayment({ user: buyer(U.premium), invoiceId: (await inv(awarded[4])).id, method: scope === 'fees' ? 'card_demo' : 'bank_transfer', scope, reference: 'TRF-2026-0004', proof });
    if (p.status === 'pending_review') await orders.reviewPayment({ actor: finance, paymentId: p.id, approve: true, note: 'OK' });
  }

  // Próximas subastas (martes y jueves 11:00 Madrid) con prepujas
  const tue = await createEvent('Martes en toda España', nextWeekday(2, 11));
  const thu = await createEvent('Jueves en toda España', nextWeekday(4, 11));
  const tue2 = await createEvent('Martes en toda España', nextWeekday(2, 11, 1));
  // Sala demo: para presentar en clase (Admin › Auctions › "Start now")
  const demo = await createEvent('Sala demo – subasta en vivo', new Date(Date.now() + 7 * 86400_000), 'scheduled', 'MAD');
  const plan = [[tue, 12], [thu, 12], [tue2, 6], [demo, 6]];
  const openLots = [];
  for (const [ev, n] of plan) for (let s = 1; s <= n; s++) {
    const v = await createVehicle(vi++, { sellerId: s % 3 ? S1 : S2, featured: s % 4 === 1 });
    const lot = await addLot(ev.id, s, v);
    openLots.push(lot);
  }
  // Vehículos del vendedor en otros estados (borrador, pendiente, rechazado)
  await createVehicle(vi++, { sellerId: S1, status: 'draft' });
  await createVehicle(vi++, { sellerId: S1, status: 'pending_approval' });
  const rej = await createVehicle(vi++, { sellerId: S1, status: 'rejected' });
  await db.query("UPDATE vehicles SET rejection_reason='Photos do not show the damaged area.' WHERE id=$1", [rej.id]);
  await createVehicle(vi++, { sellerId: S2, status: 'pending_approval' });

  // Prepujas reales a través del motor (con sus validaciones)
  const premium = await loadUserById(U.premium), premium2 = await loadUserById(U.premium2), basicU = await loadUserById(U.basic);
  for (const [k, lot] of openLots.slice(0, 10).entries()) {
    try { await placeBid({ user: k % 2 ? premium : premium2, lotId: lot.id, maxCents: lot.starting_bid_cents + 10000 * (k + 1), kind: 'prebid' }); } catch (e) { console.warn('prepuja omitida:', e.message); }
  }
  try { await placeBid({ user: basicU, lotId: openLots[11].id, maxCents: Math.min(openLots[11].starting_bid_cents + 5000, 500000), kind: 'prebid' }); } catch (e) { console.warn('prepuja básica omitida:', e.message); }

  // Favoritos, búsquedas guardadas, alertas, tickets, notificaciones
  for (const lot of openLots.slice(0, 4)) await db.query('INSERT INTO watchlist(user_id, lot_id) VALUES ($1,$2),($3,$2) ON CONFLICT DO NOTHING', [U.guest, lot.id, U.basic]);
  await db.query("INSERT INTO saved_searches(user_id,name,query) VALUES ($1,'SUV salvage under 100k km','type=suv&condition=salvage&odo_max=100000'),($2,'Toyota hybrids','make=toyota')", [U.basic, U.guest]);
  const vw = await db.one("SELECT id FROM makes WHERE slug='volkswagen'");
  await db.query(`INSERT INTO vehicle_alerts(user_id, year_from, year_to, make_id, frequency, first_name, last_name, email, consent, manage_token) VALUES ($1,2016,2027,$2,'daily','Gabriel','Invitado','guest@copart.test',true,$3)`, [U.guest, vw.id, crypto.randomBytes(16).toString('hex')]);
  await db.tx(async c => { for (const l of openLots) await matchLot(c, l.id); });
  await db.query("INSERT INTO support_tickets(user_id,name,email,topic,subject,message) VALUES ($1,'Beatriz Básica','basic@copart.test','payments','Bank transfer question','Can I pay the vehicle from a company account? (demo ticket)'), (NULL,'Visitante','visitante@example.test','general','Opening hours','What are the opening hours of the Madrid yard? (demo ticket)')", [U.basic]);
  await db.query("INSERT INTO notifications(user_id,title,body,link) VALUES ($1,'Welcome to copart','Your Guest membership is active. Upgrade to bid.','/dashboard/membership')", [U.guest]);
  // Vistos recientemente (widget del dashboard)
  for (const [k, lot] of openLots.slice(4, 12).entries()) for (const uid of [U.premium, U.basic, U.guest])
    await db.query("INSERT INTO lot_views(user_id, lot_id, viewed_at) VALUES ($1,$2, now() - ($3 || ' minutes')::interval) ON CONFLICT DO NOTHING", [uid, lot.id, String(k * 37 + 5)]);
  await db.query("UPDATE auction_lots SET sold_via='auction' WHERE status='awarded' AND sold_via IS NULL");

  // Anuncios de ejemplo (el dueño los gestiona en /admin/announcements)
  await db.query(`INSERT INTO announcements(title, body, style, cta_text, cta_url, placement, audience, created_by) VALUES
    ($1,$2,'promo',$3,'/vehicles?featured=1','both','all',$7),
    ($4,$5,'info',$6,'/auctions/calendar','banner','buyers',$7)`,
    ['¡Subasta especial esta semana!', 'Vehículos destacados con salida reducida. No se pierda la selección de esta semana.', 'Ver selección',
     'Subastas en vivo cada martes y jueves', 'Consulte el calendario y prepare sus pujas.', 'Ver calendario', U.admin]);

  await db.query("INSERT INTO system_settings(key,value,description) VALUES ('demo_seeded_at',$1,'Seed marker') ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value", [JSON.stringify(new Date().toISOString())]);
  console.log(`✔ Datos demo creados: ${vi - 1} vehículos, ${openLots.length + pastLots.length} lotes, 5 eventos.`);
}

/**
 * Inventario internacional de demostración: una subasta "International Online Sale" con lotes en
 * las sedes de cada región. Marca propia ('intl_seeded_at') para poder añadirlo a una BD ya sembrada.
 */
async function seedInternational() {
  if (await db.one("SELECT 1 FROM system_settings WHERE key='intl_seeded_at'")) return;
  const seller = await db.one("SELECT s.id FROM sellers s JOIN users u ON u.id=s.user_id WHERE u.email='renting@copart.test'");
  if (!seller) return;
  const ev = await createEvent('International Online Sale (demo)', nextWeekday(3, 15));
  lotCounter = Math.max(lotCounter, (await db.one('SELECT COALESCE(MAX(lot_number),0)::bigint AS n FROM auction_lots')).n) + 50;
  const yards = [...INTL_LOCATIONS.map(l => l[0]), 'DAL', 'MIA', 'LON', 'BER'];
  for (const [k, code] of yards.entries()) {
    const v = await createVehicle(9000 + k, { sellerId: seller.id, location: code, featured: k % 3 === 0 });
    await addLot(ev.id, k + 1, v);
  }
  await db.query("INSERT INTO system_settings(key,value,description) VALUES ('intl_seeded_at',$1,'Seed marker (international inventory)') ON CONFLICT (key) DO NOTHING", [JSON.stringify(new Date().toISOString())]);
  console.log(`✔ Inventario internacional: ${yards.length} lotes en ${INTL_LOCATIONS.length} sedes de otras regiones.`);
}

async function main() {
  await migrate({ quiet: true });
  await upsertReference();
  console.log('✔ Catálogos, roles, permisos, planes y ajustes actualizados.');
  if (!config.isProd) { await seedDemo(); await seedInternational(); }
}
module.exports = { main, upsertReference };
if (require.main === module) main().then(() => db.pool.end()).catch(e => { console.error(e); process.exit(1); });
