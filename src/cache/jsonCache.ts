import type { Redis } from 'ioredis';
import { logger } from '../logger.js';

export interface JsonCache<T> {
  get(id: string): Promise<T | null>;
  set(id: string, value: T): Promise<void>;
}

export function createJsonCache<T>(redis: Redis, prefix: string, ttlSeconds: number): JsonCache<T> {
  const key = (id: string) => `${prefix}:${id}`;
  return {
    async get(id) {
      try {
        const raw = await redis.get(key(id));
        return raw ? (JSON.parse(raw) as T) : null;
      } catch (err) {
        logger.warn({ err }, 'cache indisponível (get)');
        return null;
      }
    },
    async set(id, value) {
      try {
        await redis.set(key(id), JSON.stringify(value), 'EX', ttlSeconds);
      } catch (err) {
        logger.warn({ err }, 'cache indisponível (set)');
      }
    },
  };
}
