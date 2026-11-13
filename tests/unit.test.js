'use strict';
// Pruebas unitarias de reglas puras (sin base de datos).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { incrementFor } = require('../src/services/bidding');
const { eur } = require('../src/lib/money');
const { toCsv } = require('../src/services/reports');

const TABLE = [{ up_to_cents: 50000, increment_cents: 2500 }, { up_to_cents: 200000, increment_cents: 5000 }, { up_to_cents: 1000000, increment_cents: 10000 }, { up_to_cents: null, increment_cents: 25000 }];

test('tabla de incrementos por tramos', () => {
  assert.equal(incrementFor(TABLE, 0), 2500);
  assert.equal(incrementFor(TABLE, 49999), 2500);
  assert.equal(incrementFor(TABLE, 50000), 5000);
  assert.equal(incrementFor(TABLE, 199999), 5000);
  assert.equal(incrementFor(TABLE, 999999), 10000);
  assert.equal(incrementFor(TABLE, 5_000_000), 25000);
});

test('formato de moneda europeo como la referencia (6.900,00€)', () => {
  assert.equal(eur(690000), '6.900,00€');
  assert.equal(eur(240000), '2.400,00€');
  assert.equal(eur(null), '—');
  assert.equal(eur(1234567, { decimals: false }), '12.346€');
});

test('CSV escapa comas, comillas y saltos de línea', () => {
  const csv = toCsv([{ a: 'x,y', b: 'di "hola"', c: 'l1\nl2', d: null }]);
  assert.equal(csv, 'a,b,c,d\n"x,y","di ""hola""","l1\nl2",\n');
});
