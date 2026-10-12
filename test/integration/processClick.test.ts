import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { processClick } from '../../src/analytics/processClick.js';
import type { ClickEvent } from '../../src/events/clickEvent.js';
import { migratedPool } from './helpers.js';

let pool: pg.Pool;
beforeAll(async () => { pool = await migratedPool(); });
afterAll(() => pool.end());
beforeEach(async () => {
  await pool.query('TRUNCATE links, click_stats_daily, click_stats_browser, processed_events');
  await pool.query("INSERT INTO links (code, url) VALUES ('abcDEF1', 'https://example.com')");
});

const event = (o: Partial<ClickEvent> = {}): ClickEvent => ({
  v: 1, eventId: randomUUID(), code: 'abcDEF1', occurredAt: '2026-10-12T15:00:00.000Z', userAgent: 'curl/8.7.1', ...o,
});

const clicks = async () =>
  (await pool.query("SELECT to_char(day,'YYYY-MM-DD') AS day, clicks::int FROM click_stats_daily ORDER BY day")).rows;

describe('processClick', () => {
  it('agrega por dia (UTC) e por navegador', async () => {
    await processClick(pool, event());
    await processClick(pool, event({ userAgent: 'Mozilla/5.0 Gecko/20100101 Firefox/131.0' }));
    await processClick(pool, event({ occurredAt: '2026-10-13T02:30:00.000Z' }));
    expect(await clicks()).toEqual([{ day: '2026-10-12', clicks: 2 }, { day: '2026-10-13', clicks: 1 }]);
    // COLLATE "C": ordenação byte a byte, igual em qualquer máquina (maiúsculas antes de minúsculas)
    const { rows } = await pool.query('SELECT browser, clicks::int FROM click_stats_browser ORDER BY browser COLLATE "C"');
    expect(rows).toEqual([{ browser: 'Firefox', clicks: 1 }, { browser: 'curl', clicks: 2 }]);
  });

  it('evento repetido é contado uma vez só', async () => {
    const e = event();
    expect(await processClick(pool, e)).toBe('processed');
    expect(await processClick(pool, e)).toBe('duplicate');
    expect(await clicks()).toEqual([{ day: '2026-10-12', clicks: 1 }]);
  });

  it('se falhar, não deixa rastro (o evento pode ser reprocessado)', async () => {
    const e = event({ code: 'zzzzzz9' }); // link inexistente: viola a foreign key
    await expect(processClick(pool, e)).rejects.toThrow();
    const { rowCount } = await pool.query('SELECT 1 FROM processed_events WHERE event_id = $1', [e.eventId]);
    expect(rowCount).toBe(0);
  });
});
