import { readFileSync } from 'node:fs';
import pg from 'pg';

export interface DbConfig {
  DATABASE_URL: string;
  DATABASE_SSL: boolean;
  DATABASE_SSL_CA_FILE?: string | undefined;
}

// Atenção: não coloque "sslmode=" na DATABASE_URL. Se colocar, o pg ignora o objeto ssl abaixo.
export function createPool(cfg: DbConfig): pg.Pool {
  const ssl = cfg.DATABASE_SSL
    ? {
        rejectUnauthorized: true,
        ...(cfg.DATABASE_SSL_CA_FILE ? { ca: readFileSync(cfg.DATABASE_SSL_CA_FILE, 'utf8') } : {}),
      }
    : undefined;
  return new pg.Pool({
    connectionString: cfg.DATABASE_URL,
    ssl,
    max: 10,
    connectionTimeoutMillis: 3_000,
    idleTimeoutMillis: 30_000,
  });
}
