'use strict';
const { z } = require('zod');
const { AppError } = require('./errors');
function parse(schema, data) {
  const r = schema.safeParse(data ?? {});
  if (r.success) return r.data;
  const fields = {};
  for (const issue of r.error.issues) { const k = issue.path.join('.') || '_'; if (!fields[k]) fields[k] = issue.message; }
  const first = Object.entries(fields)[0];
  throw new AppError(400, first ? (first[0] === '_' ? first[1] : `${first[0]}: ${first[1]}`) : 'Invalid data', { code: 'VALIDATION', fields });
}
// Coerciones útiles para formularios HTML
const intish = () => z.coerce.number().int();
const optInt = () => z.preprocess(v => (v === '' || v === null || v === undefined ? undefined : v), z.coerce.number().int().optional());
const optStr = (max = 200) => z.preprocess(v => (v === '' ? undefined : v), z.string().trim().max(max).optional());
const bool = () => z.preprocess(v => v === true || v === 'true' || v === 'on' || v === '1' || v === 1, z.boolean());
const euros = () => z.coerce.number().nonnegative().max(10_000_000).transform(v => Math.round(v * 100));
module.exports = { z, parse, intish, optInt, optStr, bool, euros };
