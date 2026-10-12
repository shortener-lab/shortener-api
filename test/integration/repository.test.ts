import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createLinkRepository, DuplicateCodeError } from '../../src/links/repository.js';
import { migratedPool } from './helpers.js';

let pool: pg.Pool;
beforeAll(async () => { pool = await migratedPool(); });
afterAll(() => pool.end());
beforeEach(() => pool.query('TRUNCATE links, click_stats_daily, click_stats_browser, processed_events'));

describe('linkRepository', () => {
  it('insere e encontra pelo código', async () => {
    const repo = createLinkRepository(pool);
    await repo.insert('abcDEF1', 'https://example.com');
    expect(await repo.findUrl('abcDEF1')).toBe('https://example.com');
    expect(await repo.findUrl('zzzzzz9')).toBeNull();
  });

  it('lança DuplicateCodeError para código repetido', async () => {
    const repo = createLinkRepository(pool);
    await repo.insert('abcDEF1', 'https://a.com');
    await expect(repo.insert('abcDEF1', 'https://b.com')).rejects.toBeInstanceOf(DuplicateCodeError);
  });

  it('getStats: null se não existe, zerado se não tem cliques', async () => {
    const repo = createLinkRepository(pool);
    expect(await repo.getStats('zzzzzz9')).toBeNull();
    await repo.insert('abcDEF1', 'https://example.com');
    expect(await repo.getStats('abcDEF1')).toEqual({
      code: 'abcDEF1', url: 'https://example.com', totalClicks: 0, daily: [], browsers: [],
    });
  });

  it('getStats: soma e converte bigint para number', async () => {
    const repo = createLinkRepository(pool);
    await repo.insert('abcDEF1', 'https://example.com');
    await pool.query("INSERT INTO click_stats_daily VALUES ('abcDEF1', current_date, 4)");
    await pool.query("INSERT INTO click_stats_browser VALUES ('abcDEF1', 'Chrome', 3), ('abcDEF1', 'curl', 1)");
    const stats = await repo.getStats('abcDEF1');
    expect(stats?.totalClicks).toBe(4);
    expect(stats?.browsers).toEqual([{ browser: 'Chrome', clicks: 3 }, { browser: 'curl', clicks: 1 }]);
    expect(stats?.daily).toHaveLength(1);
    expect(stats?.daily[0]?.clicks).toBe(4);
  });
});
