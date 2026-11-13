'use strict';
// Descarga de documentos privados con control de acceso (propietario o personal autorizado).
const fs = require('node:fs');
const express = require('express');
const db = require('../db');
const { requireAuth } = require('../lib/auth');
const { forbidden, notFound } = require('../lib/errors');
const { privatePath } = require('../lib/uploads');
const router = express.Router();

function send(res, row) {
  const p = privatePath(row.file_path);
  if (!fs.existsSync(p)) throw notFound('File not found on disk.');
  res.setHeader('Content-Type', row.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${String(row.original_name).replace(/"/g, '')}"`);
  res.setHeader('Cache-Control', 'private, no-store');
  fs.createReadStream(p).pipe(res);
}

router.get('/files/verification/:id', requireAuth, async (req, res) => {
  const row = await db.one('SELECT * FROM verification_documents WHERE id=$1', [Number(req.params.id)]);
  if (!row) throw notFound();
  if (row.user_id !== req.user.id && !req.user.has('documents.review')) throw forbidden();
  send(res, row);
});
router.get('/files/payment-proof/:id', requireAuth, async (req, res) => {
  const row = await db.one('SELECT pp.*, p.user_id FROM payment_proofs pp JOIN payments p ON p.id=pp.payment_id WHERE pp.id=$1', [Number(req.params.id)]);
  if (!row) throw notFound();
  if (row.user_id !== req.user.id && !req.user.has('finance.review')) throw forbidden();
  send(res, { ...row, mime: row.mime });
});
router.get('/files/vehicle-doc/:id', requireAuth, async (req, res) => {
  const row = await db.one('SELECT d.*, s.user_id FROM vehicle_documents d JOIN vehicles v ON v.id=d.vehicle_id JOIN sellers s ON s.id=v.seller_id WHERE d.id=$1', [Number(req.params.id)]);
  if (!row) throw notFound();
  if (row.user_id !== req.user.id && !req.user.has('vehicles.approve')) throw forbidden();
  send(res, row);
});
module.exports = router;
