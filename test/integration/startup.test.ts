import { spawn, type ChildProcess } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migratedPool, TEST_DATABASE_URL, TEST_REDIS_URL } from './helpers.js';

// Sobe o src/api.ts de verdade, com o Kafka apontando para uma porta onde não há nada.
const PORT = 3998;
const BASE = `http://localhost:${PORT}`;
const API_KEY = 'test-api-key-0123456789';

let api: ChildProcess;

async function waitForHealth(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return true;
    } catch {
      // ainda não abriu a porta
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

beforeAll(async () => {
  const pool = await migratedPool();
  await pool.end();
  api = spawn(process.execPath, ['--import', 'tsx', 'src/api.ts'], {
    stdio: 'ignore',
    env: {
      ...process.env,
      LOG_LEVEL: 'silent',
      PORT: String(PORT),
      PUBLIC_BASE_URL: BASE,
      DATABASE_URL: TEST_DATABASE_URL,
      REDIS_URL: TEST_REDIS_URL,
      KAFKA_BROKERS: 'localhost:1',
      API_KEY,
      OIDC_ISSUER: 'http://localhost:8090/shortener',
      OIDC_AUDIENCE: 'shortener-web',
      OIDC_JWKS_URL: 'http://localhost:8090/shortener/jwks',
      CORS_ALLOWED_ORIGINS: 'http://localhost:5173',
    },
  });
});

afterAll(() => {
  api.kill('SIGKILL');
});

describe('api com o Kafka fora do ar', () => {
  it('sobe e redireciona: o redirect não depende das estatísticas', async () => {
    expect(await waitForHealth(10_000)).toBe(true);

    const created = await fetch(`${BASE}/links`, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/kafka-fora' }),
    });
    expect(created.status).toBe(201);
    const { code } = (await created.json()) as { code: string };

    const res = await fetch(`${BASE}/${code}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('https://example.com/kafka-fora');
  }, 20_000);
});
