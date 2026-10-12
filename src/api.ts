import { loadApiConfig } from './config.js';
import { logger } from './logger.js';
import { createPool } from './db/pool.js';
import { createRedis } from './cache/redis.js';
import { createLinkCache } from './cache/linkCache.js';
import { createJsonCache } from './cache/jsonCache.js';
import { createLinkRepository, type LinkStats } from './links/repository.js';
import { rateLimit } from './http/rateLimit.js';
import { createApp } from './http/app.js';
import { createKafka } from './events/kafka.js';
import { createClickPublisher } from './events/clickPublisher.js';
import { onShutdown } from './shutdown.js';

const config = loadApiConfig();
const pool = createPool(config);
const redis = createRedis(config.REDIS_URL);
const producer = createKafka(config, 'shortener-api').producer({ kafkaJS: { idempotent: true } });
await producer.connect();

const app = createApp({
  links: createLinkRepository(pool),
  linkCache: createLinkCache(redis, config.CACHE_TTL_SECONDS),
  statsCache: createJsonCache<LinkStats>(redis, 'stats', 60),
  publisher: createClickPublisher(producer),
  rateLimiter: rateLimit(redis, { limit: config.RATE_LIMIT_PER_MINUTE, windowSeconds: 60 }),
  apiKey: config.API_KEY,
  publicBaseUrl: config.PUBLIC_BASE_URL,
  version: config.APP_VERSION,
  isReady: async () => {
    try {
      await pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  },
});

const server = app.listen(config.PORT, () => logger.info({ port: config.PORT }, 'api ouvindo'));
// O ALB reaproveita conexões por até 60s. Se o Node fechar antes (o padrão é 5s), o ALB pode
// mandar uma requisição numa conexão já fechada e devolver 502. Por isso, keep-alive > 60s.
server.keepAliveTimeout = 65_000;
server.headersTimeout = 66_000;

onShutdown([
  () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  () => producer.disconnect(),
  () => redis.quit(),
  () => pool.end(),
]);
