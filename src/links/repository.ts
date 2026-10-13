import type pg from 'pg';
import { isValidCode } from './code.js';

export interface LinkStats {
  code: string;
  url: string;
  totalClicks: number;
  daily: { day: string; clicks: number }[];
  browsers: { browser: string; clicks: number }[];
}

export interface LinkSummary {
  code: string;
  url: string;
  createdAt: string; // ISO 8601
  totalClicks: number;
}

export interface LinkPage {
  items: LinkSummary[];
  nextCursor: string | null;
}

export class DuplicateCodeError extends Error {
  constructor(code: string) {
    super(`código já existe: ${code}`);
  }
}

export class InvalidCursorError extends Error {
  constructor() {
    super('cursor inválido');
  }
}

export interface LinkRepository {
  insert(code: string, url: string, ownerId: string | null): Promise<{ createdAt: string }>;
  findUrl(code: string): Promise<string | null>;
  getOwner(code: string): Promise<string | null | undefined>; // undefined = o link não existe
  listByOwner(ownerId: string, opts: { limit: number; cursor?: string | undefined }): Promise<LinkPage>;
  getStats(code: string): Promise<LinkStats | null>;
}

// O cursor guarda a posição do último item da página: (created_at exato, code).
// created_at vai como texto com microssegundos: um Date do JS só tem milissegundos, e
// perder precisão aqui faria a próxima página pular ou repetir links.
interface CursorData {
  t: string;
  c: string;
}

export function encodeCursor(data: CursorData): string {
  return Buffer.from(JSON.stringify(data)).toString('base64url');
}

// Exatamente o formato que o to_char da query emite (microssegundos, UTC).
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

// O Date.parse aceita "1" e anos que o Postgres recusa, e o Postgres recusaria com 500.
// Ida e volta pelo Date (em milissegundos) também pega datas que não existem, como 30 de fevereiro.
function isCursorTime(t: string): boolean {
  if (!CURSOR_TIME.test(t)) return false;
  const ms = `${t.slice(0, 23)}Z`;
  const d = new Date(ms);
  return !Number.isNaN(d.getTime()) && d.toISOString() === ms;
}

export function decodeCursor(cursor: string): CursorData {
  try {
    const data: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (typeof data === 'object' && data !== null && 't' in data && 'c' in data) {
      const { t, c } = data;
      if (typeof t === 'string' && typeof c === 'string' && isCursorTime(t) && isValidCode(c)) {
        return { t, c };
      }
    }
  } catch {
    // cai no throw abaixo
  }
  throw new InvalidCursorError();
}

export function createLinkRepository(pool: pg.Pool): LinkRepository {
  return {
    async insert(code, url, ownerId) {
      try {
        const { rows } = await pool.query<{ created_at: Date }>(
          'INSERT INTO links (code, url, owner_id) VALUES ($1, $2, $3) RETURNING created_at',
          [code, url, ownerId],
        );
        return { createdAt: rows[0]!.created_at.toISOString() }; // RETURNING de um INSERT devolve sempre 1 linha
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw new DuplicateCodeError(code); // unique_violation
        throw err;
      }
    },

    async findUrl(code) {
      const { rows } = await pool.query<{ url: string }>('SELECT url FROM links WHERE code = $1', [code]);
      return rows[0]?.url ?? null;
    },

    async getOwner(code) {
      const { rows } = await pool.query<{ owner_id: string | null }>('SELECT owner_id FROM links WHERE code = $1', [
        code,
      ]);
      return rows[0]?.owner_id;
    },

    async listByOwner(ownerId, { limit, cursor }) {
      const after = cursor === undefined ? null : decodeCursor(cursor);
      // Pede 1 a mais: se ele vier, existe próxima página.
      const { rows } = await pool.query<{
        code: string;
        url: string;
        created_at: Date;
        created_at_exact: string;
        total_clicks: string; // sum(bigint) chega como string
      }>(
        `SELECT l.code, l.url, l.created_at,
                to_char(l.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_exact,
                COALESCE((SELECT sum(b.clicks) FROM click_stats_browser b WHERE b.code = l.code), 0) AS total_clicks
           FROM links l
          WHERE l.owner_id = $1
            AND ($2::timestamptz IS NULL OR (l.created_at, l.code) < ($2::timestamptz, $3::text))
          ORDER BY l.created_at DESC, l.code DESC
          LIMIT $4`,
        [ownerId, after?.t ?? null, after?.c ?? null, limit + 1],
      );
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map((r) => ({
          code: r.code,
          url: r.url,
          createdAt: r.created_at.toISOString(),
          totalClicks: Number(r.total_clicks),
        })),
        nextCursor: rows.length > limit && last ? encodeCursor({ t: last.created_at_exact, c: last.code }) : null,
      };
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
