'use strict';
const express = require('express');
const db = require('../../db');
const { z, parse, optStr, bool, euros } = require('../../lib/validate');
const { requireAuth, requirePerm } = require('../../lib/auth');
const { notFound, forbidden, conflict, bad } = require('../../lib/errors');
const uploads = require('../../lib/uploads');
const { audit } = require('../../lib/audit');
const { notify } = require('../../lib/notify');
const engine = require('../../services/auctionEngine');
const router = express.Router();

// Solicitud para convertirse en vendedor (desde /sell-a-vehicle)
router.post('/seller/apply', requireAuth, async (req, res) => {
  const d = parse(z.object({ company_name: z.string().trim().min(2, 'Enter the company name').max(120), seller_type: z.enum(['insurance', 'dealer', 'rental', 'fleet', 'leasing', 'individual']) }), req.body);
  await db.tx(async c => {
    const s = await c.one(`INSERT INTO sellers(user_id, company_name, seller_type, approved) VALUES ($1,$2,$3,false)
                           ON CONFLICT (user_id) DO UPDATE SET company_name=EXCLUDED.company_name, seller_type=EXCLUDED.seller_type RETURNING id, approved`, [req.user.id, d.company_name, d.seller_type]);
    await c.query("INSERT INTO user_roles(user_id, role_id) SELECT $1, id FROM roles WHERE code='seller' ON CONFLICT DO NOTHING", [req.user.id]);
    const admins = await c.many("SELECT ur.user_id FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE r.code='admin'");
    for (const a of admins) await notify(c, a.user_id, { title: 'New seller application', body: `${d.company_name} (${d.seller_type})`, link: '/admin/sellers' });
    await audit(c, { actorId: req.user.id, action: 'seller.apply', entity: 'seller', entityId: s.id, ip: req.ip });
  });
  res.status(201).json({ ok: true, message: 'Application sent. An administrator will approve your seller account.', redirect: '/seller' });
});

const seller = [requireAuth, requirePerm('vehicles.sell')];
async function ownVehicle(req, id, { lock = false } = {}) {
  const v = await db.one(`SELECT v.*, s.user_id AS seller_user_id, s.approved AS seller_approved FROM vehicles v JOIN sellers s ON s.id=v.seller_id WHERE v.id=$1${lock ? ' FOR UPDATE OF v' : ''}`, [Number(id)]);
  if (!v) throw notFound('Vehicle not found.');
  if (v.seller_user_id !== req.user.id) throw forbidden();
  return v;
}
const EDITABLE = ['draft', 'rejected'];
const VehicleSchema = z.object({
  make_id: z.coerce.number().int().positive('Select a make'), model_id: z.coerce.number().int().positive('Select a model'), vehicle_type: z.string().min(1, 'Select a type'),
  primary_damage: z.string().min(1, 'Select primary damage'), secondary_damage: optStr(40), location: z.string().min(1, 'Select a yard'),
  year: z.coerce.number().int().min(1920).max(new Date().getFullYear() + 1), trim: optStr(80), vin: z.string().trim().toUpperCase().regex(/^[A-HJ-NPR-Z0-9]{11,17}$/, 'VIN must have 11–17 letters/numbers (no I, O, Q)'),
  odometer_km: z.coerce.number().int().min(0).max(2_000_000), fuel: z.enum(['petrol', 'diesel', 'hybrid', 'electric', 'lpg', 'other']), transmission: z.enum(['manual', 'automatic']),
  engine: optStr(60), color: optStr(40), has_keys: bool(), runs_drives: bool(), condition: z.enum(['used', 'salvage']), document_type: z.string().trim().min(2).max(80),
  highlights: optStr(120), description: optStr(3000), estimated_value: euros().optional(),
});
async function resolveRefs(d) {
  const r = await db.one(`SELECT (SELECT id FROM vehicle_types WHERE code=$1) AS type_id, (SELECT id FROM damage_types WHERE code=$2) AS d1, (SELECT id FROM damage_types WHERE code=$3) AS d2,
                                 (SELECT id FROM locations WHERE code=$4 AND active) AS loc, (SELECT 1 FROM models WHERE id=$5 AND make_id=$6) AS model_ok`, [d.vehicle_type, d.primary_damage, d.secondary_damage || null, d.location, d.model_id, d.make_id]);
  if (!r.type_id || !r.d1 || !r.loc) throw bad('Invalid vehicle type, damage or yard.');
  if (!r.model_ok) throw bad('model_id: The model does not belong to the selected make', { fields: { model_id: 'The model does not belong to the selected make' } });
  return r;
}

router.post('/seller/vehicles', ...seller, async (req, res) => {
  if (!req.user.seller?.approved) throw forbidden('Your seller account is pending approval.');
  const d = parse(VehicleSchema, req.body); const r = await resolveRefs(d);
  if (await db.one('SELECT 1 FROM vehicles WHERE vin=$1', [d.vin])) throw conflict('A vehicle with this VIN already exists.');
  const v = await db.one(`INSERT INTO vehicles(seller_id, make_id, model_id, vehicle_type_id, primary_damage_id, secondary_damage_id, location_id, year, trim, vin, odometer_km, fuel, transmission, engine, color, has_keys, runs_drives, condition, document_type, highlights, description, estimated_value_cents)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING id`,
  [req.user.seller.id, d.make_id, d.model_id, r.type_id, r.d1, r.d2, r.loc, d.year, d.trim || '', d.vin, d.odometer_km, d.fuel, d.transmission, d.engine || '', d.color || '', d.has_keys, d.runs_drives, d.condition, d.document_type, d.highlights || '', d.description || '', d.estimated_value ?? null]);
  await audit(null, { actorId: req.user.id, action: 'vehicle.create', entity: 'vehicle', entityId: v.id, ip: req.ip });
  res.status(201).json({ ok: true, id: v.id, message: 'Draft saved. Add photos and documents, then submit it for approval.', redirect: `/seller/vehicles/${v.id}/edit` });
});
router.patch('/seller/vehicles/:id', ...seller, async (req, res) => {
  const v = await ownVehicle(req, req.params.id);
  if (!EDITABLE.includes(v.status)) throw conflict('Only drafts or rejected vehicles can be edited.');
  const d = parse(VehicleSchema, req.body); const r = await resolveRefs(d);
  if (await db.one('SELECT 1 FROM vehicles WHERE vin=$1 AND id<>$2', [d.vin, v.id])) throw conflict('Another vehicle already uses this VIN.');
  await db.query(`UPDATE vehicles SET make_id=$2, model_id=$3, vehicle_type_id=$4, primary_damage_id=$5, secondary_damage_id=$6, location_id=$7, year=$8, trim=$9, vin=$10, odometer_km=$11, fuel=$12, transmission=$13, engine=$14, color=$15, has_keys=$16, runs_drives=$17, condition=$18, document_type=$19, highlights=$20, description=$21, estimated_value_cents=$22, status='draft' WHERE id=$1`,
    [v.id, d.make_id, d.model_id, r.type_id, r.d1, r.d2, r.loc, d.year, d.trim || '', d.vin, d.odometer_km, d.fuel, d.transmission, d.engine || '', d.color || '', d.has_keys, d.runs_drives, d.condition, d.document_type, d.highlights || '', d.description || '', d.estimated_value ?? null]);
  await audit(null, { actorId: req.user.id, action: 'vehicle.update', entity: 'vehicle', entityId: v.id, ip: req.ip });
  res.json({ ok: true, message: 'Changes saved.' });
});
router.delete('/seller/vehicles/:id', ...seller, async (req, res) => {
  const v = await ownVehicle(req, req.params.id);
  if (!EDITABLE.includes(v.status)) throw conflict('Only drafts can be deleted. Ask an admin to withdraw a listed vehicle.');
  const imgs = await db.many('SELECT path FROM vehicle_images WHERE vehicle_id=$1', [v.id]);
  await db.query('DELETE FROM vehicles WHERE id=$1', [v.id]);
  imgs.forEach(i => uploads.remove(i.path));
  await audit(null, { actorId: req.user.id, action: 'vehicle.delete', entity: 'vehicle', entityId: v.id, ip: req.ip });
  res.json({ ok: true, message: 'Draft deleted.', redirect: '/seller/vehicles' });
});
router.post('/seller/vehicles/:id/submit', ...seller, async (req, res) => {
  const v = await ownVehicle(req, req.params.id);
  if (!EDITABLE.includes(v.status)) throw conflict('This vehicle has already been submitted.');
  const imgs = await db.one('SELECT COUNT(*)::int n FROM vehicle_images WHERE vehicle_id=$1', [v.id]);
  if (imgs.n < 1) throw bad('Add at least one photo before submitting.');
  await db.tx(async c => {
    await c.query("UPDATE vehicles SET status='pending_approval', submitted_at=now(), rejection_reason=NULL WHERE id=$1", [v.id]);
    const admins = await c.many("SELECT ur.user_id FROM user_roles ur JOIN roles r ON r.id=ur.role_id WHERE r.code='admin'");
    for (const a of admins) await notify(c, a.user_id, { title: 'Vehicle pending approval', body: `Vehicle #${v.id} submitted by ${req.user.seller.company_name}`, link: `/admin/vehicles?status=pending_approval` });
    await audit(c, { actorId: req.user.id, action: 'vehicle.submit', entity: 'vehicle', entityId: v.id, ip: req.ip });
  });
  res.json({ ok: true, message: 'Submitted for approval.', reload: true });
});
router.post('/seller/vehicles/:id/images', ...seller, uploads.memory(6, 10).array('images', 10), async (req, res) => {
  const v = await ownVehicle(req, req.params.id);
  if (!EDITABLE.includes(v.status)) throw conflict('Photos can only be changed while the vehicle is a draft.');
  const count = (await db.one('SELECT COUNT(*)::int n FROM vehicle_images WHERE vehicle_id=$1', [v.id])).n;
  if (!req.files?.length) throw bad('Choose at least one image.');
  if (count + req.files.length > 12) throw conflict('Maximum 12 photos per vehicle.');
  const stored = req.files.map(f => uploads.store(f, 'image'));
  for (const [i, s] of stored.entries()) await db.query('INSERT INTO vehicle_images(vehicle_id, path, sort) VALUES ($1,$2,$3)', [v.id, s.path, count + i]);
  res.status(201).json({ ok: true, message: `${stored.length} photo(s) uploaded.`, reload: true });
});
router.delete('/seller/vehicles/:id/images/:imageId', ...seller, async (req, res) => {
  const v = await ownVehicle(req, req.params.id);
  if (!EDITABLE.includes(v.status)) throw conflict('Photos can only be changed while the vehicle is a draft.');
  const img = await db.one('DELETE FROM vehicle_images WHERE id=$1 AND vehicle_id=$2 RETURNING path', [Number(req.params.imageId), v.id]);
  if (!img) throw notFound();
  if (img.path.startsWith('/uploads/')) uploads.remove(img.path);
  res.json({ ok: true, message: 'Photo deleted.', reload: true });
});
router.post('/seller/vehicles/:id/documents', ...seller, uploads.memory(8).single('file'), async (req, res) => {
  const v = await ownVehicle(req, req.params.id);
  const { doc_type } = parse(z.object({ doc_type: z.enum(['registration', 'technical_sheet', 'insurance_report', 'ownership', 'other']) }), req.body);
  const f = uploads.store(req.file, 'document');
  await db.query('INSERT INTO vehicle_documents(vehicle_id, doc_type, file_path, original_name, mime, size_bytes) VALUES ($1,$2,$3,$4,$5,$6)', [v.id, doc_type, f.path, f.originalname, f.mimetype, f.size]);
  res.status(201).json({ ok: true, message: 'Document uploaded.', reload: true });
});
router.post('/seller/lots/:id/decision', requireAuth, async (req, res) => {
  const { accept } = parse(z.object({ accept: bool() }), req.body);
  const lot = await engine.sellerDecision({ user: req.user, lotId: Number(req.params.id), accept, ip: req.ip });
  engine.broadcastLot(lot);
  res.json({ ok: true, message: accept ? 'Bid accepted. The buyer has been invoiced.' : 'Bid rejected. The vehicle can be relisted.', reload: true });
});
router.post('/seller/lots/:id/counter', requireAuth, async (req, res) => {
  const { amount } = parse(z.object({ amount: euros() }), req.body);
  const lot = await engine.sellerCounter({ user: req.user, lotId: Number(req.params.id), amountCents: amount, ip: req.ip });
  engine.broadcastLot(lot);
  res.json({ ok: true, message: 'Counter offer sent to the high bidder.', reload: true });
});
module.exports = router;
module.exports.VehicleSchema = VehicleSchema;
module.exports.resolveRefs = resolveRefs;
