'use strict';
// Formato europeo como en la referencia: 6.900,00€
function eur(cents, { decimals = true } = {}) {
  if (cents === null || cents === undefined) return '—';
  const n = Number(cents) / 100;
  const s = n.toLocaleString('es-ES', { minimumFractionDigits: decimals ? 2 : 0, maximumFractionDigits: decimals ? 2 : 0, useGrouping: 'always' });
  return s + '€';
}
const toCents = euros => Math.round(Number(euros) * 100);
module.exports = { eur, toCents };
