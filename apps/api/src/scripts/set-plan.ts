/**
 * Manually move a user between plans until billing is wired up.
 *
 *   npm run plan:set -w @jobtracker/api -- <user-id> pro
 */
import { loadConfig } from '../config.js';
import { createPool } from '../db/pool.js';

const [userId, plan] = process.argv.slice(2);
if (!userId || (plan !== 'free' && plan !== 'pro')) {
  console.error('Usage: plan:set <user-id> <free|pro>');
  process.exit(1);
}

const pool = createPool(loadConfig().databaseUrl, 1);
try {
  const result = await pool.query('UPDATE users SET plan = $2 WHERE id = $1', [userId, plan]);
  if (result.rowCount === 0) {
    console.error(`No user with id ${userId}`);
    process.exitCode = 1;
  } else {
    console.log(`User ${userId} is now on ${plan}`);
  }
} finally {
  await pool.end();
}
