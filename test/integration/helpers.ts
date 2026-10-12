import type pg from 'pg';
import type { Redis } from 'ioredis';
import { createPool } from '../../src/db/pool.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createRedis } from '../../src/cache/redis.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://shortener:shortener@localhost:5432/shortener_test';
export const TEST_REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379/1';
export const DEAD_REDIS_URL = 'redis://localhost:6399'; // porta onde não há nada: simula Redis fora do ar

export function createTestPool(): pg.Pool {
  return createPool({ DATABASE_URL: TEST_DATABASE_URL, DATABASE_SSL: false });
}

export async function resetDatabase(pool: pg.Pool): Promise<void> {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
}

export async function migratedPool(): Promise<pg.Pool> {
  const pool = createTestPool();
  await resetDatabase(pool);
  await runMigrations(pool, 'migrations');
  return pool;
}

export async function connectedRedis(url = TEST_REDIS_URL): Promise<Redis> {
  const redis = createRedis(url);
  if (redis.status !== 'ready') {
    await new Promise<void>((resolve) => redis.once('ready', () => resolve()));
  }
  return redis;
}
