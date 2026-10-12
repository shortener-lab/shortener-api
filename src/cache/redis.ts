import { Redis } from 'ioredis';
import { logger } from '../logger.js';

export function createRedis(url: string): Redis {
  const redis = new Redis(url, {
    enableOfflineQueue: false, // desconectado? o comando falha na hora em vez de esperar
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    commandTimeout: 500,
  });
  redis.on('error', (err) => logger.warn({ err: err.message }, 'redis: erro de conexão'));
  return redis;
}
