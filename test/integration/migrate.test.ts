import { afterAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { createTestPool, resetDatabase } from './helpers.js';

const pool = createTestPool();
afterAll(() => pool.end());

describe('runMigrations', () => {
  it('aplica cada migration uma única vez', async () => {
    await resetDatabase(pool);

    const first = await runMigrations(pool, 'migrations');
    expect(first).toContain('001_init.sql');

    const second = await runMigrations(pool, 'migrations');
    expect(second).toEqual([]);

    const { rows } = await pool.query("SELECT to_regclass('public.links')::text AS t");
    expect(rows[0].t).toBe('links');
  });
});
