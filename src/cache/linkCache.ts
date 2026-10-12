import type { Redis } from 'ioredis';
import { logger } from '../logger.js';

export type CacheLookup = { hit: true; url: string | null } | { hit: false };

export interface LinkCache {
  get(code: string): Promise<CacheLookup>;
  setUrl(code: string, url: string): Promise<void>;
  setNotFound(code: string): Promise<void>;
}

const NOT_FOUND = '__not_found__';
const NOT_FOUND_TTL_SECONDS = 60;

export function createLinkCache(redis: Redis, ttlSeconds: number): LinkCache {
  const key = (code: string) => `link:${code}`;
  return {
    async get(code) {
      try {
        const value = await redis.get(key(code));
        if (value === null) return { hit: false };
        return { hit: true, url: value === NOT_FOUND ? null : value };
      } catch (err) {
        logger.warn({ err }, 'cache indisponível (get); seguindo sem cache');
        return { hit: false };
      }
    },
    async setUrl(code, url) {
      try {
        await redis.set(key(code), url, 'EX', ttlSeconds);
      } catch (err) {
        logger.warn({ err }, 'cache indisponível (set)');
      }
    },
    async setNotFound(code) {
      try {
        await redis.set(key(code), NOT_FOUND, 'EX', NOT_FOUND_TTL_SECONDS);
      } catch (err) {
        logger.warn({ err }, 'cache indisponível (set)');
      }
    },
  };
}
