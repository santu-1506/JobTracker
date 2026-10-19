import { existsSync } from 'node:fs';
import { z } from 'zod';

const boolFromString = z
  .enum(['true', 'false', '1', '0'])
  .transform((value) => value === 'true' || value === '1');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(0).max(65535).default(8787),
  HOST: z.string().min(1).default('127.0.0.1'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().url(),
  DATABASE_POOL_SIZE: z.coerce.number().int().positive().default(10),
  DEFAULT_PLAN: z.enum(['free', 'pro']).default('free'),
  WORKER_ENABLED: boolFromString.default('false'),
  SIGHTINGS_PER_MINUTE: z.coerce.number().int().positive().default(120),
  INSTALLS_PER_HOUR: z.coerce.number().int().positive().default(20),
  TRUST_PROXY: boolFromString.default('false'),
});

export interface Config {
  env: 'development' | 'test' | 'production';
  port: number;
  host: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  databaseUrl: string;
  databasePoolSize: number;
  defaultPlan: 'free' | 'pro';
  workerEnabled: boolean;
  sightingsPerMinute: number;
  installsPerHour: number;
  trustProxy: boolean;
}

/** Loads `.env` when present (Node >= 21.7) and validates the environment. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env === process.env && existsSync('.env')) process.loadEnvFile('.env');

  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
    throw new Error(`Invalid environment:\n${problems.join('\n')}`);
  }

  const e = parsed.data;
  return {
    env: e.NODE_ENV,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    databaseUrl: e.DATABASE_URL,
    databasePoolSize: e.DATABASE_POOL_SIZE,
    defaultPlan: e.DEFAULT_PLAN,
    workerEnabled: e.WORKER_ENABLED,
    sightingsPerMinute: e.SIGHTINGS_PER_MINUTE,
    installsPerHour: e.INSTALLS_PER_HOUR,
    trustProxy: e.TRUST_PROXY,
  };
}
