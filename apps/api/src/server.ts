import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl, config.databasePoolSize);
const app = await buildApp({ config, pool });

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await pool.end();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.port, host: config.host });
