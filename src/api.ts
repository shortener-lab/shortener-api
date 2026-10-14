import { createRemoteJWKSet } from 'jose';
import { loadApiConfig } from './config.js';
import { logger } from './logger.js';
import { createPool } from './db/pool.js';
import { createRedis } from './cache/redis.js';
import { createLinkCache } from './cache/linkCache.js';
import { createJsonCache } from './cache/jsonCache.js';
import { createLinkRepository } from './links/repository.js';
import { rateLimit } from './http/rateLimit.js';
import { createApp, type CachedStats } from './http/app.js';
import { createTokenVerifier } from './auth/jwt.js';
import { connectInBackground, createKafka } from './events/kafka.js';
import { createClickPublisher } from './events/clickPublisher.js';
import { onShutdown } from './shutdown.js';

const config = loadApiConfig();
const pool = createPool(config);
const redis = createRedis(config.REDIS_URL);
const kafka = createKafka(config, 'shortener-api');
// Sem await: a api abre a porta mesmo com o Kafka fora (o redirect não depende das estatísticas).
const producer = connectInBackground(() => kafka.producer({ kafkaJS: { idempotent: true } }));

// Baixa o JWKS na primeira verificação e guarda em memória; busca de novo se aparecer um kid desconhecido.
const verifyToken = createTokenVerifier({
  issuer: config.OIDC_ISSUER,
  audience: config.OIDC_AUDIENCE,
  jwks: createRemoteJWKSet(new URL(config.OIDC_JWKS_URL)),
});

const app = createApp({
  links: createLinkRepository(pool),
  linkCache: createLinkCache(redis, config.CACHE_TTL_SECONDS),
  statsCache: createJsonCache<CachedStats>(redis, 'stats', 60),
  publisher: createClickPublisher(producer.sender),
  rateLimiter: rateLimit(redis, { limit: config.RATE_LIMIT_PER_MINUTE, windowSeconds: 60 }),
  apiKey: config.API_KEY,
  verifyToken,
  corsOrigins: config.CORS_ALLOWED_ORIGINS,
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
  () => producer.close(),
  () => redis.quit(),
  () => pool.end(),
]);
