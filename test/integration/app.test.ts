import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type pg from 'pg';
import type { Redis } from 'ioredis';
import type { Express } from 'express';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey } from 'jose';
import { createApp, type AppDeps } from '../../src/http/app.js';
import { createTokenVerifier, type VerifyToken } from '../../src/auth/jwt.js';
import { createLinkRepository } from '../../src/links/repository.js';
import { createLinkCache } from '../../src/cache/linkCache.js';
import { createJsonCache } from '../../src/cache/jsonCache.js';
import { createRedis } from '../../src/cache/redis.js';
import { rateLimit } from '../../src/http/rateLimit.js';
import { createClickPublisher } from '../../src/events/clickPublisher.js';
import type { ClickEvent } from '../../src/events/clickEvent.js';
import { connectedRedis, DEAD_REDIS_URL, migratedPool } from './helpers.js';

const API_KEY = 'test-api-key-0123456789';
const ISSUER = 'http://oidc.test/shortener';
const AUDIENCE = 'shortener-web';
const ALLOWED_ORIGIN = 'http://localhost:5173';

let pool: pg.Pool;
let redis: Redis;
let deadRedis: Redis;
let signingKey: CryptoKey;
let verifyToken: VerifyToken;

beforeAll(async () => {
  pool = await migratedPool();
  redis = await connectedRedis();
  deadRedis = createRedis(DEAD_REDIS_URL);
  // Um "IdP de mentira" dentro do teste: par de chaves RSA e um JWKS local com a chave pública.
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  signingKey = privateKey;
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  verifyToken = createTokenVerifier({ issuer: ISSUER, audience: AUDIENCE, jwks: createLocalJWKSet({ keys: [jwk] }) });
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

function userToken(sub: string): Promise<string> {
  return new SignJWT({ sub, aud: AUDIENCE })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signingKey);
}

function buildApp(overrides: Partial<AppDeps> = {}, cacheRedis: Redis = redis) {
  const published: ClickEvent[] = [];
  const deps: AppDeps = {
    links: createLinkRepository(pool),
    linkCache: createLinkCache(cacheRedis, 60),
    statsCache: createJsonCache(cacheRedis, 'stats', 60),
    publisher: { publish: (e) => { published.push(e); } },
    rateLimiter: rateLimit(cacheRedis, { limit: 100, windowSeconds: 60 }),
    apiKey: API_KEY,
    verifyToken,
    corsOrigins: [ALLOWED_ORIGIN],
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

async function createUserLink(app: Express, sub: string, url = 'https://example.com/pagina'): Promise<string> {
  const res = await request(app).post('/links').auth(await userToken(sub), { type: 'bearer' }).send({ url });
  expect(res.status).toBe(201);
  return res.body.code;
}

describe('health', () => {
  it('/healthz responde e não é confundido com um código', async () => {
    const res = await request(buildApp().app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', version: 'test' });
  });
  it('expõe a versão no header X-Shortener-Version', async () => {
    const res = await request(buildApp().app).get('/healthz');
    expect(res.headers['x-shortener-version']).toBe('test');
  });
  it('/readyz devolve 503 quando o banco não responde', async () => {
    const res = await request(buildApp({ isReady: async () => false }).app).get('/readyz');
    expect(res.status).toBe(503);
  });
});

describe('autenticação', () => {
  it('sem credencial: 401', async () => {
    const res = await request(buildApp().app).post('/links').send({ url: 'https://example.com' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'unauthorized' });
  });

  it('API key errada: 401', async () => {
    const res = await request(buildApp().app).post('/links').set('x-api-key', 'errada').send({ url: 'https://example.com' });
    expect(res.status).toBe(401);
  });

  it('Bearer inválido: 401, mesmo com API key válida junto', async () => {
    const res = await request(buildApp().app)
      .post('/links')
      .auth('nao-sou-um-jwt', { type: 'bearer' })
      .set('x-api-key', API_KEY)
      .send({ url: 'https://example.com' });
    expect(res.status).toBe(401);
  });

  it('Authorization que não é Bearer: 401', async () => {
    const res = await request(buildApp().app).post('/links').auth('user', 'pass').send({ url: 'https://example.com' });
    expect(res.status).toBe(401);
  });
});

describe('POST /links', () => {
  it('rejeita URLs perigosas ou inválidas', async () => {
    const { app } = buildApp();
    for (const url of ['javascript:alert(1)', 'data:text/html,oi', 'nao-e-url', `https://x.com/${'a'.repeat(3000)}`]) {
      const res = await request(app).post('/links').set('x-api-key', API_KEY).send({ url });
      expect(res.status, url).toBe(400);
    }
  });

  it('serviço (API key) cria link sem dono', async () => {
    const res = await request(buildApp().app).post('/links').set('x-api-key', API_KEY).send({ url: 'https://example.com' });
    expect(res.status).toBe(201);
    expect(res.body.code).toMatch(/^[0-9A-Za-z]{7}$/);
    expect(res.body.shortUrl).toBe(`http://short.test/${res.body.code}`);
    expect(res.body.url).toBe('https://example.com/');
    expect(new Date(res.body.createdAt).toISOString()).toBe(res.body.createdAt);
    const { rows } = await pool.query('SELECT owner_id FROM links WHERE code = $1', [res.body.code]);
    expect(rows).toEqual([{ owner_id: null }]);
  });

  it('usuário (Bearer) cria link com dono = sub', async () => {
    const code = await createUserLink(buildApp().app, 'alice');
    const { rows } = await pool.query('SELECT owner_id FROM links WHERE code = $1', [code]);
    expect(rows).toEqual([{ owner_id: 'alice' }]);
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

  it('o rate limit vem antes da autenticação', async () => {
    const { app } = buildApp({ rateLimiter: rateLimit(redis, { limit: 1, windowSeconds: 60 }) });
    const post = () => request(app).post('/links').set('x-api-key', 'errada').send({ url: 'https://example.com' });
    expect((await post()).status).toBe(401);
    expect((await post()).status).toBe(429);
  });

  it('continua criando links com o Redis fora do ar', async () => {
    const { app } = buildApp({}, deadRedis);
    expect((await request(app).post('/links').set('x-api-key', API_KEY).send({ url: 'https://example.com' })).status).toBe(201);
  });
});

describe('GET /me/links', () => {
  it('exige usuário: 401 sem credencial, 403 para serviço', async () => {
    const { app } = buildApp();
    expect((await request(app).get('/me/links')).status).toBe(401);
    const res = await request(app).get('/me/links').set('x-api-key', API_KEY);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'forbidden' });
  });

  it('lista só os links do usuário, com shortUrl e totalClicks', async () => {
    const { app } = buildApp();
    const mine = await createUserLink(app, 'alice', 'https://example.com/da-alice');
    await createUserLink(app, 'bob');
    await createLink(app); // sem dono
    await pool.query("INSERT INTO click_stats_browser VALUES ($1, 'Chrome', 2)", [mine]);

    const res = await request(app).get('/me/links').auth(await userToken('alice'), { type: 'bearer' });
    expect(res.status).toBe(200);
    expect(res.body.nextCursor).toBeNull();
    expect(res.body.items).toEqual([
      {
        code: mine,
        shortUrl: `http://short.test/${mine}`,
        url: 'https://example.com/da-alice',
        createdAt: expect.any(String),
        totalClicks: 2,
      },
    ]);
  });

  it('pagina com limit e cursor', async () => {
    const { app } = buildApp();
    const codes: string[] = [];
    for (let i = 0; i < 3; i++) codes.push(await createUserLink(app, 'alice', `https://example.com/${i}`));
    const token = await userToken('alice');

    const first = await request(app).get('/me/links?limit=2').auth(token, { type: 'bearer' });
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.nextCursor).toEqual(expect.any(String));

    const second = await request(app)
      .get('/me/links')
      .query({ limit: 2, cursor: first.body.nextCursor })
      .auth(token, { type: 'bearer' });
    expect(second.status).toBe(200);
    expect(second.body.items).toHaveLength(1);
    expect(second.body.nextCursor).toBeNull();

    const seen = [...first.body.items, ...second.body.items].map((i: { code: string }) => i.code);
    expect(seen.sort()).toEqual([...codes].sort());
  });

  it('400 para limit ou cursor inválidos', async () => {
    const { app } = buildApp();
    const token = await userToken('alice');
    for (const limit of ['0', '101', 'abc', '1.5']) {
      const res = await request(app).get('/me/links').query({ limit }).auth(token, { type: 'bearer' });
      expect(res.status, limit).toBe(400);
      expect(res.body).toEqual({ error: 'invalid_query' });
    }
    const res = await request(app).get('/me/links').query({ cursor: 'lixo' }).auth(token, { type: 'bearer' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'invalid_cursor' });
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

  it('o redirect não ganha headers de CORS', async () => {
    const { app } = buildApp();
    const code = await createLink(app);
    const res = await request(app).get(`/${code}`).set('origin', ALLOWED_ORIGIN);
    expect(res.status).toBe(302);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('GET /links/:code/stats', () => {
  it('exige credencial e devolve 404 para inexistente', async () => {
    const { app } = buildApp();
    expect((await request(app).get('/links/abcDEF1/stats')).status).toBe(401);
    expect((await request(app).get('/links/abcDEF1/stats').set('x-api-key', API_KEY)).status).toBe(404);
  });

  it('serviço vê os agregados de qualquer link', async () => {
    const { app } = buildApp();
    const code = await createLink(app);
    await pool.query('INSERT INTO click_stats_daily VALUES ($1, current_date, 5)', [code]);
    await pool.query("INSERT INTO click_stats_browser VALUES ($1, 'Chrome', 3), ($1, 'curl', 2)", [code]);
    const res = await request(app).get(`/links/${code}/stats`).set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body.totalClicks).toBe(5);
    expect(res.body.browsers).toEqual([{ browser: 'Chrome', clicks: 3 }, { browser: 'curl', clicks: 2 }]);
  });

  it('o dono vê as estatísticas do próprio link', async () => {
    const { app } = buildApp();
    const code = await createUserLink(app, 'alice');
    const res = await request(app).get(`/links/${code}/stats`).auth(await userToken('alice'), { type: 'bearer' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ code, totalClicks: 0 });
  });

  it('outro usuário recebe 404, igual a um link inexistente', async () => {
    const { app } = buildApp();
    const code = await createUserLink(app, 'alice');
    const asBob = await userToken('bob');
    const res = await request(app).get(`/links/${code}/stats`).auth(asBob, { type: 'bearer' });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'not_found' });
  });

  it('miss: carimba computedAt agora e manda atualizar em 60 s', async () => {
    const { app } = buildApp();
    const code = await createLink(app);
    const before = Date.now();
    const res = await request(app).get(`/links/${code}/stats`).set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(Date.parse(res.body.computedAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(Date.parse(res.body.computedAt)).toBeLessThanOrEqual(Date.now());
    expect(res.body.refreshInSeconds).toBe(60);
  });

  it('hit: mantém o computedAt original e devolve quanto falta', async () => {
    const { app } = buildApp();
    const code = await createLink(app);
    const computedAt = new Date(Date.now() - 45_000).toISOString(); // alguém montou o cache há 45 s
    const cached = { code, url: 'https://example.com/', totalClicks: 7, daily: [], browsers: [], computedAt };
    await redis.set(`stats:${code}`, JSON.stringify(cached), 'EX', 60);
    const res = await request(app).get(`/links/${code}/stats`).set('x-api-key', API_KEY);
    expect(res.body).toMatchObject({ totalClicks: 7, computedAt });
    expect(res.body.refreshInSeconds).toBeGreaterThanOrEqual(14);
    expect(res.body.refreshInSeconds).toBeLessThanOrEqual(15);
  });

  it('entrada antiga do cache, sem computedAt, é recalculada', async () => {
    const { app } = buildApp();
    const code = await createLink(app);
    const legacy = { code, url: 'https://example.com/', totalClicks: 999, daily: [], browsers: [] };
    await redis.set(`stats:${code}`, JSON.stringify(legacy), 'EX', 60);
    const res = await request(app).get(`/links/${code}/stats`).set('x-api-key', API_KEY);
    expect(res.body.totalClicks).toBe(0); // veio do banco, não do cache antigo
    expect(res.body.refreshInSeconds).toBe(60);
    expect(JSON.parse((await redis.get(`stats:${code}`)) ?? '{}').computedAt).toBe(res.body.computedAt);
  });

  it('usuário também recebe 404 para link de serviço (sem dono)', async () => {
    const { app } = buildApp();
    const code = await createLink(app);
    const res = await request(app).get(`/links/${code}/stats`).auth(await userToken('alice'), { type: 'bearer' });
    expect(res.status).toBe(404);
  });
});

describe('CORS', () => {
  const preflight = (app: Express, origin: string) =>
    request(app)
      .options('/links')
      .set('origin', origin)
      .set('access-control-request-method', 'POST')
      .set('access-control-request-headers', 'authorization,content-type');

  it('preflight de origem permitida libera método e headers', async () => {
    const res = await preflight(buildApp().app, ALLOWED_ORIGIN);
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(res.headers['access-control-allow-methods']).toBe('GET,POST');
    expect(res.headers['access-control-allow-headers']).toBe('Authorization,Content-Type');
    expect(res.headers['access-control-max-age']).toBe('600');
  });

  it('preflight de origem negada não devolve Access-Control-Allow-Origin', async () => {
    const res = await preflight(buildApp().app, 'https://evil.example');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('resposta normal expõe os headers de rate limit para o navegador', async () => {
    const res = await request(buildApp().app)
      .post('/links')
      .set('origin', ALLOWED_ORIGIN)
      .set('x-api-key', API_KEY)
      .send({ url: 'https://example.com' });
    expect(res.status).toBe(201);
    expect(res.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(res.headers['access-control-expose-headers']).toBe('RateLimit-Limit,RateLimit-Remaining,Retry-After');
  });
});
