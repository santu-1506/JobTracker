import type { InstallResponse, Plan, SightingInput } from '@jobtracker/core';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { createPool, type Pool } from '../src/db/pool.js';
import { TEST_DATABASE_URL } from './db-url.js';

export const testConfig: Config = {
  env: 'test',
  port: 0,
  host: '127.0.0.1',
  logLevel: 'silent',
  databaseUrl: TEST_DATABASE_URL,
  databasePoolSize: 20,
  defaultPlan: 'free',
  workerEnabled: false,
  sightingsPerMinute: 10_000,
  installsPerHour: 10_000,
  trustProxy: false,
};

export interface TestContext {
  app: FastifyInstance;
  pool: Pool;
  close(): Promise<void>;
}

export async function createTestApp(overrides: Partial<Config> = {}): Promise<TestContext> {
  const config = { ...testConfig, ...overrides };
  const pool = createPool(config.databaseUrl, config.databasePoolSize);
  const app = await buildApp({ config, pool });
  await app.ready();
  return {
    app,
    pool,
    async close() {
      await app.close();
      await pool.end();
    },
  };
}

export async function resetData(pool: Pool): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
  );
  if (rows.length === 0) return;
  await pool.query(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
}

export interface TestUser {
  id: string;
  token: string;
  headers: { authorization: string };
}

export async function createUser(ctx: TestContext, plan?: Plan): Promise<TestUser> {
  const response = await ctx.app.inject({ method: 'POST', url: '/v1/installs' });
  const body = response.json<InstallResponse>();
  if (plan) await ctx.pool.query('UPDATE users SET plan = $2 WHERE id = $1', [body.userId, plan]);
  return { id: body.userId, token: body.token, headers: { authorization: `Bearer ${body.token}` } };
}

let jobCounter = 0;

export function sightingInput(overrides: Partial<SightingInput> = {}): SightingInput {
  jobCounter += 1;
  return {
    source: 'linkedin',
    sourceJobId: `job-${jobCounter}`,
    url: `https://www.linkedin.com/jobs/view/${jobCounter}/`,
    title: 'Senior Backend Engineer',
    company: 'Acme, Inc.',
    location: 'Bengaluru, Karnataka, India',
    ...overrides,
  };
}

export const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000);
