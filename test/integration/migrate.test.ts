import { afterAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../../src/db/migrate.js';
import { createTestPool, resetDatabase } from './helpers.js';

const pool = createTestPool();
afterAll(() => pool.end());

describe('runMigrations', () => {
  it('aplica cada migration uma única vez', async () => {
    await resetDatabase(pool);

    const first = await runMigrations(pool, 'migrations');
    expect(first).toEqual(['001_init.sql', '002_link_owner.sql']);

    const second = await runMigrations(pool, 'migrations');
    expect(second).toEqual([]);

    const { rows } = await pool.query("SELECT to_regclass('public.links')::text AS t");
    expect(rows[0]?.t).toBe('links');
  });

  it('002 cria owner_id opcional e o índice da paginação', async () => {
    const col = await pool.query(
      "SELECT is_nullable FROM information_schema.columns WHERE table_name = 'links' AND column_name = 'owner_id'",
    );
    expect(col.rows).toEqual([{ is_nullable: 'YES' }]);
    const idx = await pool.query("SELECT indexdef FROM pg_indexes WHERE indexname = 'links_owner_created_idx'");
    expect(idx.rows[0]?.indexdef).toContain('(owner_id, created_at DESC, code DESC)');
  });
});
