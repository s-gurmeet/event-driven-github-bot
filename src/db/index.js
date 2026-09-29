const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

pool.on('error', (err) => {
  console.error('[DB] Unexpected pool error', err);
});

async function query(text, params) {
  const start = Date.now();
  try {
    const res = await pool.query(text, params);
    const duration = Date.now() - start;
    if (duration > 1000) {
      console.warn(`[DB] Slow query (${duration}ms): ${text.slice(0, 80)}`);
    }
    return res;
  } catch (err) {
    console.error('[DB] Query error:', { text: text.slice(0, 80), error: err.message });
    throw err;
  }
}

async function getClient() {
  const client = await pool.connect();
  const originalRelease = client.release.bind(client);
  client.release = () => {
    client.release = originalRelease;
    return originalRelease();
  };
  return client;
}

// Run schema migration
async function migrate() {
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await pool.query(schema);
  console.log('[DB] Migration complete');
}

module.exports = { query, getClient, migrate, pool };
