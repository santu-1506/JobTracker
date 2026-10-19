import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { defaultHandlers, defaultSchedules } from './jobs/handlers.js';
import { Worker } from './jobs/worker.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl, config.databasePoolSize);
const app = await buildApp({ config, pool });

// In development the worker runs inside the API process; in production run
// `npm run start:worker` as its own process and leave WORKER_ENABLED off.
const worker = config.workerEnabled
  ? new Worker({ pool, handlers: defaultHandlers, schedules: defaultSchedules, log: app.log })
  : null;

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await worker?.stop();
  await pool.end();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ port: config.port, host: config.host });
worker?.start();
