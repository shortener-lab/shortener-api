import type pg from 'pg';

export interface LinkStats {
  code: string;
  url: string;
  totalClicks: number;
  daily: { day: string; clicks: number }[];
  browsers: { browser: string; clicks: number }[];
}

export class DuplicateCodeError extends Error {
  constructor(code: string) {
    super(`código já existe: ${code}`);
  }
}

export interface LinkRepository {
  insert(code: string, url: string): Promise<void>;
  findUrl(code: string): Promise<string | null>;
  getStats(code: string): Promise<LinkStats | null>;
}

export function createLinkRepository(pool: pg.Pool): LinkRepository {
  return {
    async insert(code, url) {
      try {
        await pool.query('INSERT INTO links (code, url) VALUES ($1, $2)', [code, url]);
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw new DuplicateCodeError(code); // unique_violation
        throw err;
      }
    },

    async findUrl(code) {
      const { rows } = await pool.query<{ url: string }>('SELECT url FROM links WHERE code = $1', [code]);
      return rows[0]?.url ?? null;
    },

    async getStats(code) {
      const link = await pool.query<{ url: string }>('SELECT url FROM links WHERE code = $1', [code]);
      const linkRow = link.rows[0];
      if (!linkRow) return null;
      // bigint chega como string no pg (pode passar de 2^53); aqui convertemos conscientemente.
      const daily = await pool.query<{ day: string; clicks: string }>(
        `SELECT to_char(day, 'YYYY-MM-DD') AS day, clicks FROM click_stats_daily
          WHERE code = $1 AND day >= current_date - 29 ORDER BY day`,
        [code],
      );
      const browsers = await pool.query<{ browser: string; clicks: string }>(
        'SELECT browser, clicks FROM click_stats_browser WHERE code = $1 ORDER BY clicks DESC, browser',
        [code],
      );
      const browserRows = browsers.rows.map((r) => ({ browser: r.browser, clicks: Number(r.clicks) }));
      return {
        code,
        url: linkRow.url,
        totalClicks: browserRows.reduce((sum, b) => sum + b.clicks, 0), // total de todos os tempos
        daily: daily.rows.map((r) => ({ day: r.day, clicks: Number(r.clicks) })), // últimos 30 dias
        browsers: browserRows,
      };
    },
  };
}
