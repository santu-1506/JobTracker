import { migrate } from '../src/db/migrate.js';
import { createPool } from '../src/db/pool.js';
import { TEST_DATABASE_URL, assertTestDatabase } from './db-url.js';

export async function setup(): Promise<void> {
  assertTestDatabase(TEST_DATABASE_URL);
  const pool = createPool(TEST_DATABASE_URL, 1);
  try {
    await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
    await pool.query('CREATE SCHEMA public');
    await migrate(pool);
  } finally {
    await pool.end();
  }
}
