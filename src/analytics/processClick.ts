import type pg from 'pg';
import type { ClickEvent } from '../events/clickEvent.js';
import { detectBrowser } from './browser.js';

export type ProcessResult = 'processed' | 'duplicate';

export async function processClick(pool: pg.Pool, event: ClickEvent): Promise<ProcessResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Se outro worker estiver processando o mesmo evento, este INSERT espera o COMMIT dele e então não insere nada.
    const marked = await client.query(
      'INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [event.eventId],
    );
    if (marked.rowCount === 0) {
      await client.query('ROLLBACK');
      return 'duplicate';
    }
    await client.query(
      `INSERT INTO click_stats_daily (code, day, clicks) VALUES ($1, $2, 1)
       ON CONFLICT (code, day) DO UPDATE SET clicks = click_stats_daily.clicks + 1`,
      [event.code, event.occurredAt.slice(0, 10)], // occurredAt sempre em UTC ("...Z")
    );
    await client.query(
      `INSERT INTO click_stats_browser (code, browser, clicks) VALUES ($1, $2, 1)
       ON CONFLICT (code, browser) DO UPDATE SET clicks = click_stats_browser.clicks + 1`,
      [event.code, detectBrowser(event.userAgent)],
    );
    await client.query('COMMIT');
    return 'processed';
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
