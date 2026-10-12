import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Redis } from 'ioredis';
import { createRedis } from '../../src/cache/redis.js';
import { createLinkCache } from '../../src/cache/linkCache.js';
import { createJsonCache } from '../../src/cache/jsonCache.js';
import { connectedRedis, DEAD_REDIS_URL } from './helpers.js';

let redis: Redis;
let dead: Redis;
beforeAll(async () => {
  redis = await connectedRedis();
  dead = createRedis(DEAD_REDIS_URL);
});
afterAll(() => {
  redis.disconnect();
  dead.disconnect();
});
beforeEach(() => redis.flushdb());

describe('linkCache', () => {
  it('miss → setUrl → hit, com TTL', async () => {
    const cache = createLinkCache(redis, 120);
    expect(await cache.get('abcDEF1')).toEqual({ hit: false });
    await cache.setUrl('abcDEF1', 'https://example.com');
    expect(await cache.get('abcDEF1')).toEqual({ hit: true, url: 'https://example.com' });
    expect(await redis.ttl('link:abcDEF1')).toBeGreaterThan(100);
  });

  it('guarda "não existe" com TTL curto', async () => {
    const cache = createLinkCache(redis, 120);
    await cache.setNotFound('abcDEF1');
    expect(await cache.get('abcDEF1')).toEqual({ hit: true, url: null });
    expect(await redis.ttl('link:abcDEF1')).toBeLessThanOrEqual(60);
  });

  it('com o Redis fora do ar vira miss rápido, sem lançar erro', async () => {
    const cache = createLinkCache(dead, 120);
    const start = Date.now();
    expect(await cache.get('abcDEF1')).toEqual({ hit: false });
    await cache.setUrl('abcDEF1', 'https://example.com');
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe('jsonCache', () => {
  it('serializa, expira e tolera Redis fora', async () => {
    const cache = createJsonCache<{ n: number }>(redis, 'stats', 60);
    expect(await cache.get('x')).toBeNull();
    await cache.set('x', { n: 1 });
    expect(await cache.get('x')).toEqual({ n: 1 });
    expect(await createJsonCache(dead, 'stats', 60).get('x')).toBeNull();
  });
});
