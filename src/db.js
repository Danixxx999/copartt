'use strict';
const { Pool, types } = require('pg');
const config = require('./config');

// BIGINT (importes en céntimos) → Number. Seguro hasta 9e15 céntimos.
types.setTypeParser(20, v => (v === null ? null : Number(v)));
// NUMERIC → Number
types.setTypeParser(1700, v => (v === null ? null : Number(v)));

const pool = new Pool({ connectionString: config.databaseUrl, max: 15 });
pool.on('error', err => console.error('[pg] error inesperado en cliente inactivo', err.message));

const query = (text, params) => pool.query(text, params);
const one = async (text, params) => (await pool.query(text, params)).rows[0] || null;
const many = async (text, params) => (await pool.query(text, params)).rows;

/** Ejecuta fn dentro de una transacción. fn recibe un cliente con query/one/many. */
async function tx(fn, { isolation } = {}) {
  const client = await pool.connect();
  const c = {
    query: (t, p) => client.query(t, p),
    one: async (t, p) => (await client.query(t, p)).rows[0] || null,
    many: async (t, p) => (await client.query(t, p)).rows,
  };
  try {
    await client.query(isolation ? `BEGIN ISOLATION LEVEL ${isolation}` : 'BEGIN');
    const result = await fn(c);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { pool, query, one, many, tx };
