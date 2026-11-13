'use strict';
/**
 * Subida de archivos saneada:
 *  - nombre aleatorio (nunca el del usuario), extensión derivada del tipo REAL (firma mágica), no del MIME declarado
 *  - imágenes públicas → storage/uploads ; documentos → storage/private (solo por rutas con control de acceso)
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const config = require('../config');
const { bad } = require('./errors');

fs.mkdirSync(config.uploadDir, { recursive: true });
fs.mkdirSync(config.privateDir, { recursive: true });

const memory = (maxMb, maxFiles = 1) => multer({ storage: multer.memoryStorage(), limits: { fileSize: maxMb * 1024 * 1024, files: maxFiles } });

function sniff(buf) {
  if (buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { ext: 'png', mime: 'image/png' };
  if (buf.subarray(0, 4).toString() === 'RIFF' && buf.subarray(8, 12).toString() === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  if (buf.subarray(0, 5).toString() === '%PDF-') return { ext: 'pdf', mime: 'application/pdf' };
  return null;
}

/** Guarda un archivo validado. kind: 'image' (público) | 'document' (privado, imagen o PDF). */
function store(file, kind) {
  if (!file) throw bad('No file received.');
  const t = sniff(file.buffer);
  const allowed = kind === 'image' ? ['jpg', 'png', 'webp'] : ['jpg', 'png', 'webp', 'pdf'];
  if (!t || !allowed.includes(t.ext)) throw bad(kind === 'image' ? 'Only JPG, PNG or WEBP images are allowed.' : 'Only PDF, JPG, PNG or WEBP files are allowed.');
  const name = `${crypto.randomBytes(16).toString('hex')}.${t.ext}`;
  const dir = kind === 'image' ? config.uploadDir : config.privateDir;
  fs.writeFileSync(path.join(dir, name), file.buffer, { flag: 'wx' });
  return { path: kind === 'image' ? `/uploads/${name}` : name, mimetype: t.mime, size: file.size, originalname: String(file.originalname || 'file').replace(/[^\w.\- ]/g, '_').slice(0, 120) };
}
function remove(p) {
  try {
    if (p.startsWith('/uploads/')) fs.unlinkSync(path.join(config.uploadDir, path.basename(p)));
    else fs.unlinkSync(path.join(config.privateDir, path.basename(p)));
  } catch { /* ya no existe */ }
}
const privatePath = name => path.join(config.privateDir, path.basename(name));
module.exports = { memory, store, remove, privatePath, sniff };
