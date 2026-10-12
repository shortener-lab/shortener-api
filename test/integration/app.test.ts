import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import type { Express } from 'express';
import { createApp, type AppDeps } from '../../src/http/app.js';
import { createLinkRepository } from '../../src/links/repository.js';
import { createLinkCache } from '../../src/cache/linkCache.js';
import { createJsonCache } from '../../src/cache/jsonCache.js';
import { createRedis } from '../../src/cache/redis.js';
import { rateLimit } from '../../src/http/rateLimit.js';
import { createClickPublisher } from '../../src/events/clickPublisher.js';
import type { ClickEvent } from '../../src/events/clickEvent.js';
import { connectedRedis, DEAD_REDIS_URL, migratedPool } from './helpers.js';

const API_KEY = 'test-api-key-0123456789';
let pool: pg.Pool;
let redis: Redis;
let deadRedis: Redis;

beforeAll(async () => {
  pool = await migratedPool();
  redis = await connectedRedis();
  deadRedis = createRedis(DEAD_REDIS_URL);
});
afterAll(async () => {
  await pool.end();
  redis.disconnect();
  deadRedis.disconnect();
});
beforeEach(async () => {
  await pool.query('TRUNCATE links, click_stats_daily, click_stats_browser, processed_events');
  await redis.flushdb();
});

function buildApp(overrides: Partial<AppDeps> = {}, cacheRedis: Redis = redis) {
  const published: ClickEvent[] = [];
  const deps: AppDeps = {
    links: createLinkRepository(pool),
    linkCache: createLinkCache(cacheRedis, 60),
    statsCache: createJsonCache(cacheRedis, 'stats', 60),
    publisher: { publish: (e) => { published.push(e); } },
    rateLimiter: rateLimit(cacheRedis, { limit: 100, windowSeconds: 60 }),
    apiKey: API_KEY,
    publicBaseUrl: 'http://short.test',
    version: 'test',
    isReady: async () => true,
    ...overrides,
  };
  return { app: createApp(deps), deps, published };
}

async function createLink(app: Express, url = 'https://example.com/pagina'): Promise<string> {
  const res = await request(app).post('/links').set('x-api-key', API_KEY).send({ url });
  expect(res.status).toBe(201);
  return res.body.code;
}

describe('health', () => {
  it('/healthz responde e não é confundido com um código', async () => {
    const res = await request(buildApp().app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', version: 'test' });
  });
  it('/readyz devolve 503 quando o banco não responde', async () => {
    const res = await request(buildApp({ isReady: async () => false }).app).get('/readyz');
    expect(res.status).toBe(503);
  });
});

describe('POST /links', () => {
  it('exige API key', async () => {
    const res = await request(buildApp().app).post('/links').send({ url: 'https://example.com' });
    expect(res.status).toBe(401);
  });

  it('rejeita URLs perigosas ou inválidas', async () => {
    const { app } = buildApp();
    for (const url of ['javascript:alert(1)', 'data:text/html,oi', 'nao-e-url', `https://x.com/${'a'.repeat(3000)}`]) {
      const res = await request(app).post('/links').set('x-api-key', API_KEY).send({ url });
      expect(res.status, url).toBe(400);
    }
  });

  it('cria o link e devolve a URL curta', async () => {
    const res = await request(buildApp().app).post('/links').set('x-api-key', API_KEY).send({ url: 'https://example.com' });
    expect(res.status).toBe(201);
    expect(res.body.code).toMatch(/^[0-9A-Za-z]{7}$/);
    expect(res.body.shortUrl).toBe(`http://short.test/${res.body.code}`);
  });

  it('limita por IP real do cliente (X-Forwarded-For do ALB)', async () => {
    const { app } = buildApp({ rateLimiter: rateLimit(redis, { limit: 2, windowSeconds: 60 }) });
    const post = (ip: string) =>
      request(app).post('/links').set('x-api-key', API_KEY).set('x-forwarded-for', ip).send({ url: 'https://example.com' });
    expect((await post('203.0.113.1')).status).toBe(201);
    expect((await post('203.0.113.1')).status).toBe(201);
    expect((await post('203.0.113.1')).status).toBe(429);
    expect((await post('203.0.113.2')).status).toBe(201);
  });

  it('continua criando links com o Redis fora do ar', async () => {
    const { app } = buildApp({}, deadRedis);
    expect((await request(app).post('/links').set('x-api-key', API_KEY).send({ url: 'https://example.com' })).status).toBe(201);
  });
});

describe('GET /:code', () => {
  it('redireciona e publica o evento de clique', async () => {
    const { app, published } = buildApp();
    const code = await createLink(app);
    const res = await request(app).get(`/${code}`).set('user-agent', 'curl/8.7.1');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('https://example.com/pagina');
    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({ code, userAgent: 'curl/8.7.1' });
  });

  it('404 com cache negativo: a segunda consulta não vai ao banco', async () => {
    const { app, deps } = buildApp();
    const spy = vi.spyOn(deps.links, 'findUrl');
    expect((await request(app).get('/abcDEF1')).status).toBe(404);
    expect((await request(app).get('/abcDEF1')).status).toBe(404);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('formato inválido nem consulta o banco', async () => {
    const { app, deps } = buildApp();
    const spy = vi.spyOn(deps.links, 'findUrl');
    expect((await request(app).get('/favicon.ico')).status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });

  it('funciona com o Redis fora do ar', async () => {
    const code = await createLink(buildApp().app);
    const res = await request(buildApp({}, deadRedis).app).get(`/${code}`);
    expect(res.status).toBe(302);
  });

  it('não espera o Kafka: responde mesmo se o envio nunca terminar', async () => {
    const code = await createLink(buildApp().app);
    const hanging = createClickPublisher({ send: () => new Promise<never>(() => {}) });
    const res = await request(buildApp({ publisher: hanging }).app).get(`/${code}`);
    expect(res.status).toBe(302);
  });
});

describe('GET /links/:code/stats', () => {
  it('exige API key e devolve 404 para inexistente', async () => {
    const { app } = buildApp();
    expect((await request(app).get('/links/abcDEF1/stats')).status).toBe(401);
    expect((await request(app).get('/links/abcDEF1/stats').set('x-api-key', API_KEY)).status).toBe(404);
  });

  it('devolve os agregados', async () => {
    const { app } = buildApp();
    const code = await createLink(app);
    await pool.query('INSERT INTO click_stats_daily VALUES ($1, current_date, 5)', [code]);
    await pool.query("INSERT INTO click_stats_browser VALUES ($1, 'Chrome', 3), ($1, 'curl', 2)", [code]);
    const res = await request(app).get(`/links/${code}/stats`).set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.totalClicks).toBe(5);
    expect(res.body.browsers).toEqual([{ browser: 'Chrome', clicks: 3 }, { browser: 'curl', clicks: 2 }]);
  });
});
