'use strict';
// Generador de imágenes de reemplazo (SVG, proporción 4:3) para lotes demo.
// Registro central de assets: docs/ASSETS.md. Las fotos reales se suben desde el panel del vendedor.
const express = require('express');
const router = express.Router();

const SHAPES = {
  automobile: 'M70 250 L110 190 Q130 165 170 160 L290 155 Q330 155 360 180 L410 215 Q470 222 500 240 Q520 255 515 280 L515 300 L85 300 Q65 295 70 250 Z',
  suv: 'M70 245 L95 165 Q105 140 140 138 L350 135 Q385 135 405 160 L440 205 Q500 212 515 240 L518 300 L80 300 Q62 290 70 245 Z',
  van: 'M70 290 L70 130 Q72 105 100 102 L360 100 Q395 100 420 140 L470 200 Q512 210 518 250 L518 300 L80 300 Z',
  commercial: 'M60 300 L60 90 L330 90 L330 300 Z M340 300 L340 140 L440 140 Q470 145 490 190 L520 230 L520 300 Z',
  motorcycle: 'M160 250 L230 190 L300 185 L340 160 L380 165 L360 200 L420 240 L300 250 Z',
  quad: 'M120 250 L170 180 L380 180 L440 250 Z',
};
const GLASS = {
  automobile: 'M175 172 L290 166 Q325 166 350 188 L372 210 L150 214 Z',
  suv: 'M150 150 L345 147 Q372 148 388 170 L410 205 L130 208 Z',
  van: 'M360 115 Q385 118 405 150 L445 200 L360 200 Z',
  commercial: 'M355 155 L435 155 Q455 160 470 195 L355 195 Z',
};

router.get('/car/:type.svg', (req, res) => {
  const type = SHAPES[req.params.type] ? req.params.type : 'automobile';
  const color = /^#[0-9a-fA-F]{6}$/.test(req.query.color || '') ? req.query.color : '#1d4ed8';
  const view = ['front', 'side', 'rear', 'interior'].includes(req.query.view) ? req.query.view : 'side';
  const damaged = req.query.damage && req.query.damage !== 'none';
  const seed = Number(req.query.seed) || 1;
  const flip = view === 'rear' ? 'translate(600 0) scale(-1 1)' : '';
  const wy = type === 'motorcycle' ? 262 : 300;
  const wheels = type === 'motorcycle' ? [190, 400] : type === 'commercial' ? [130, 270, 440] : [160, 430];
  const r1 = type === 'motorcycle' ? 46 : 38, r2 = type === 'motorcycle' ? 26 : 18;
  const dx = 360 + (seed % 5) * 20;
  const dmg = damaged ? `<path d="M${dx} 200 l20 -18 l12 22 l18 -10 l-6 26 l22 8 l-26 10 l6 22 l-22 -10 l-14 18 l-6 -24 l-24 2 l16 -18 z" fill="#f97316" stroke="#7c2d12" stroke-width="2" opacity=".85"/>` : '';
  let body;
  if (view === 'interior') {
    body = `<rect x="80" y="70" width="440" height="230" rx="18" fill="#111827"/><circle cx="220" cy="190" r="70" fill="none" stroke="#374151" stroke-width="18"/><rect x="330" y="140" width="150" height="90" rx="10" fill="#1f2937"/><rect x="345" y="155" width="120" height="20" rx="4" fill="${color}"/>`;
  } else {
    body = `<g transform="${flip}"><ellipse cx="300" cy="${wy + 30}" rx="250" ry="14" fill="#000" opacity=".25"/>` +
      `<path d="${SHAPES[type]}" fill="${color}" stroke="#0b1220" stroke-width="4"/>` +
      (GLASS[type] ? `<path d="${GLASS[type]}" fill="#cbd5e1" opacity=".85"/>` : '') +
      wheels.map(x => `<circle cx="${x}" cy="${wy}" r="${r1}" fill="#0b0b0b"/><circle cx="${x}" cy="${wy}" r="${r2}" fill="#9ca3af"/>`).join('') +
      dmg + '</g>';
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 450" width="600" height="450" role="img" aria-label="Demo vehicle image (${type}, ${view})">` +
    '<defs><linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#dbe7f5"/><stop offset=".62" stop-color="#eef2f7"/><stop offset=".62" stop-color="#9aa3ad"/><stop offset="1" stop-color="#6b7480"/></linearGradient></defs>' +
    '<rect width="600" height="450" fill="url(#sky)"/>' +
    '<g opacity=".35"><rect x="20" y="215" width="120" height="50" rx="10" fill="#475569"/><rect x="470" y="210" width="110" height="55" rx="10" fill="#64748b"/></g>' +
    body +
    `<text x="584" y="438" text-anchor="end" font-family="Arial, sans-serif" font-size="13" fill="#fff" opacity=".85">DEMO IMAGE · ${view.toUpperCase()}</text></svg>`;
  res.set('Content-Type', 'image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(svg);
});

module.exports = router;
