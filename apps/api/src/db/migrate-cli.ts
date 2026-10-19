import { loadConfig } from '../config.js';
import { migrate } from './migrate.js';
import { createPool } from './pool.js';

const config = loadConfig();
const pool = createPool(process.env.MIGRATE_DATABASE_URL ?? config.databaseUrl, 1);

try {
  const { applied, skipped } = await migrate(pool);
  for (const name of applied) console.log(`applied  ${name}`);
  console.log(`${applied.length} applied, ${skipped.length} already up to date`);
} catch (error) {
  console.error((error as Error).message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
