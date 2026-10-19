/**
 * Standalone worker process. Run it separately from the API in production
 * so background work scales independently: `npm run start:worker`.
 */
import pino from 'pino';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { defaultHandlers, defaultSchedules } from './jobs/handlers.js';
import { Worker } from './jobs/worker.js';

const config = loadConfig();
const log = pino({ level: config.logLevel, name: 'worker' });
const pool = createPool(config.databaseUrl, 4);
const worker = new Worker({ pool, handlers: defaultHandlers, schedules: defaultSchedules, log });

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'shutting down worker');
  await worker.stop();
  await pool.end();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

worker.start();
