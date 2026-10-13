import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { createLinkRepository, DuplicateCodeError, InvalidCursorError } from '../../src/links/repository.js';
import { migratedPool } from './helpers.js';

let pool: pg.Pool;
beforeAll(async () => { pool = await migratedPool(); });
afterAll(() => pool.end());
beforeEach(() => pool.query('TRUNCATE links, click_stats_daily, click_stats_browser, processed_events'));

// Datas fixas deixam a ordem da paginação previsível (o now() de inserts seguidos pode empatar).
async function insertAt(code: string, ownerId: string | null, createdAt: string) {
  await pool.query('INSERT INTO links (code, url, owner_id, created_at) VALUES ($1, $2, $3, $4)', [
    code, `https://example.com/${code}`, ownerId, createdAt,
  ]);
}

describe('linkRepository', () => {
  it('insere e encontra pelo código', async () => {
    const repo = createLinkRepository(pool);
    await repo.insert('abcDEF1', 'https://example.com', null);
    expect(await repo.findUrl('abcDEF1')).toBe('https://example.com');
    expect(await repo.findUrl('zzzzzz9')).toBeNull();
  });

  it('insert devolve a data de criação em ISO 8601', async () => {
    const repo = createLinkRepository(pool);
    const { createdAt } = await repo.insert('abcDEF1', 'https://example.com', 'alice');
    expect(new Date(createdAt).toISOString()).toBe(createdAt);
  });

  it('lança DuplicateCodeError para código repetido', async () => {
    const repo = createLinkRepository(pool);
    await repo.insert('abcDEF1', 'https://a.com', null);
    await expect(repo.insert('abcDEF1', 'https://b.com', null)).rejects.toBeInstanceOf(DuplicateCodeError);
  });

  it('getOwner: undefined se não existe, null sem dono, o sub com dono', async () => {
    const repo = createLinkRepository(pool);
    await repo.insert('semDono', 'https://a.com', null);
    await repo.insert('comDono', 'https://b.com', 'alice');
    expect(await repo.getOwner('zzzzzz9')).toBeUndefined();
    expect(await repo.getOwner('semDono')).toBeNull();
    expect(await repo.getOwner('comDono')).toBe('alice');
  });

  it('listByOwner: pagina do mais novo para o mais antigo', async () => {
    const repo = createLinkRepository(pool);
    await insertAt('link001', 'alice', '2026-10-01T10:00:00Z');
    await insertAt('link002', 'alice', '2026-10-02T10:00:00Z');
    await insertAt('link003', 'alice', '2026-10-03T10:00:00Z');

    const first = await repo.listByOwner('alice', { limit: 2 });
    expect(first.items.map((i) => i.code)).toEqual(['link003', 'link002']);
    expect(first.items[0]).toEqual({
      code: 'link003', url: 'https://example.com/link003', createdAt: '2026-10-03T10:00:00.000Z', totalClicks: 0,
    });
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = await repo.listByOwner('alice', { limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.items.map((i) => i.code)).toEqual(['link001']);
    expect(second.nextCursor).toBeNull();
  });

  it('listByOwner: desempata pelo código quando a data é igual', async () => {
    const repo = createLinkRepository(pool);
    for (const code of ['sameAAA', 'sameBBB', 'sameCCC']) await insertAt(code, 'alice', '2026-10-01T10:00:00.123456Z');
    const first = await repo.listByOwner('alice', { limit: 2 });
    const second = await repo.listByOwner('alice', { limit: 2, cursor: first.nextCursor ?? undefined });
    expect([...first.items, ...second.items].map((i) => i.code)).toEqual(['sameCCC', 'sameBBB', 'sameAAA']);
  });

  it('listByOwner: só devolve os links do dono', async () => {
    const repo = createLinkRepository(pool);
    await insertAt('alice01', 'alice', '2026-10-01T10:00:00Z');
    await insertAt('bob0001', 'bob', '2026-10-01T11:00:00Z');
    await insertAt('semdono', null, '2026-10-01T12:00:00Z');
    expect((await repo.listByOwner('alice', { limit: 20 })).items.map((i) => i.code)).toEqual(['alice01']);
    expect((await repo.listByOwner('carol', { limit: 20 })).items).toEqual([]);
  });

  it('listByOwner: soma os cliques e converte bigint para number', async () => {
    const repo = createLinkRepository(pool);
    await insertAt('alice01', 'alice', '2026-10-01T10:00:00Z');
    await pool.query("INSERT INTO click_stats_browser VALUES ('alice01', 'Chrome', 3), ('alice01', 'curl', 2)");
    const page = await repo.listByOwner('alice', { limit: 20 });
    expect(page.items[0]?.totalClicks).toBe(5);
  });

  it('listByOwner: cursor inválido lança InvalidCursorError', async () => {
    const repo = createLinkRepository(pool);
    const cursorOf = (t: string) => Buffer.from(JSON.stringify({ t, c: 'abcDEF1' })).toString('base64url');
    // "1" e o ano 275760 passam no Date.parse do JS, mas o Postgres recusa como timestamptz.
    // 30 de fevereiro tem o formato certo, mas não existe.
    const bads = ['ontem', '1', '+275760-09-13T00:00:00.000Z', '2026-02-30T10:00:00.000000Z'].map(cursorOf);
    for (const cursor of ['nao-e-base64-json', ...bads]) {
      await expect(repo.listByOwner('alice', { limit: 20, cursor })).rejects.toBeInstanceOf(InvalidCursorError);
    }
  });

  it('getStats: null se não existe, zerado se não tem cliques', async () => {
    const repo = createLinkRepository(pool);
    expect(await repo.getStats('zzzzzz9')).toBeNull();
    await repo.insert('abcDEF1', 'https://example.com', null);
    expect(await repo.getStats('abcDEF1')).toEqual({
      code: 'abcDEF1', url: 'https://example.com', totalClicks: 0, daily: [], browsers: [],
    });
  });

  it('getStats: soma e converte bigint para number', async () => {
    const repo = createLinkRepository(pool);
    await repo.insert('abcDEF1', 'https://example.com', null);
    await pool.query("INSERT INTO click_stats_daily VALUES ('abcDEF1', current_date, 4)");
    await pool.query("INSERT INTO click_stats_browser VALUES ('abcDEF1', 'Chrome', 3), ('abcDEF1', 'curl', 1)");
    const stats = await repo.getStats('abcDEF1');
    expect(stats?.totalClicks).toBe(4);
    expect(stats?.browsers).toEqual([{ browser: 'Chrome', clicks: 3 }, { browser: 'curl', clicks: 1 }]);
    expect(stats?.daily).toHaveLength(1);
    expect(stats?.daily[0]?.clicks).toBe(4);
  });
});
