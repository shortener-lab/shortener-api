import type { RequestHandler } from 'express';
import type { Redis } from 'ioredis';
import { logger } from '../logger.js';

// Janela fixa: conta requisições por IP dentro de cada bloco de N segundos.
export function rateLimit(redis: Redis, opts: { limit: number; windowSeconds: number }): RequestHandler {
  return async (req, res, next) => {
    const window = Math.floor(Date.now() / 1000 / opts.windowSeconds);
    const key = `rl:${req.ip}:${window}`;
    let count: number;
    try {
      // MULTI/EXEC: INCR e EXPIRE vão juntos; nunca sobra uma chave sem expiração.
      const results = await redis.multi().incr(key).expire(key, opts.windowSeconds).exec();
      count = Number(results?.[0]?.[1] ?? 0);
    } catch (err) {
      // Fail-open: preferimos aceitar a requisição a derrubar o serviço porque o Redis caiu.
      logger.warn({ err }, 'rate limit indisponível; liberando requisição');
      next();
      return;
    }
    res.set('RateLimit-Limit', String(opts.limit));
    res.set('RateLimit-Remaining', String(Math.max(0, opts.limit - count)));
    if (count > opts.limit) {
      res.set('Retry-After', String(opts.windowSeconds));
      res.status(429).json({ error: 'rate_limited' });
      return;
    }
    next();
  };
}
