import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import cors from 'cors';
import { pinoHttp } from 'pino-http';
import { z } from 'zod';
import { logger } from '../logger.js';
import type { LinkCache } from '../cache/linkCache.js';
import type { JsonCache } from '../cache/jsonCache.js';
import type { ClickPublisher } from '../events/clickPublisher.js';
import { buildClickEvent } from '../events/clickEvent.js';
import { isValidCode } from '../links/code.js';
import { normalizeTargetUrl } from '../links/url.js';
import { createShortLink } from '../links/service.js';
import { InvalidCursorError, type LinkRepository, type LinkStats } from '../links/repository.js';
import type { VerifyToken } from '../auth/jwt.js';
import { authenticate, principalOf, requireUser } from './auth.js';

// O que fica no cache: as stats mais o instante em que foram calculadas (relógio da api).
export type CachedStats = LinkStats & { computedAt: string };

// O que a rota devolve: o cliente mostra "atualizado às ..." e sabe quando buscar de novo.
export type StatsResponse = CachedStats & { refreshInSeconds: number };

export function withFreshness(cached: CachedStats, ttlSeconds: number, now = Date.now()): StatsResponse {
  const expiresAt = Date.parse(cached.computedAt) + ttlSeconds * 1000;
  const refreshInSeconds = Math.min(ttlSeconds, Math.max(0, Math.ceil((expiresAt - now) / 1000)));
  return { ...cached, refreshInSeconds };
}

export interface AppDeps {
  links: LinkRepository;
  linkCache: LinkCache;
  statsCache: JsonCache<CachedStats>;
  publisher: ClickPublisher;
  rateLimiter: RequestHandler;
  apiKey: string;
  verifyToken: VerifyToken;
  corsOrigins: string[];
  publicBaseUrl: string;
  version: string;
  isReady: () => Promise<boolean>;
}

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(512).optional(),
});

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.set('X-Shortener-Version', deps.version);
    next();
  });
  app.set('trust proxy', 1); // exatamente 1 proxy na frente (o ALB): req.ip = IP real do cliente
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/healthz' || req.url === '/readyz' } }));

  // CORS só nos prefixos da API REST. O redirect (GET /:code) é navegação, não fetch: não precisa de CORS.
  app.use(
    ['/links', '/me'],
    cors({
      origin: deps.corsOrigins,
      methods: ['GET', 'POST'],
      allowedHeaders: ['Authorization', 'Content-Type'],
      exposedHeaders: ['RateLimit-Limit', 'RateLimit-Remaining', 'Retry-After'],
      maxAge: 600,
    }),
  );

  app.use(express.json({ limit: '10kb' }));
  const auth = authenticate({ apiKey: deps.apiKey, verifyToken: deps.verifyToken });
  const shortUrl = (code: string) => `${deps.publicBaseUrl}/${code}`;

  // Rotas fixas ANTES de "/:code": "healthz" também tem formato de código válido.
  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', version: deps.version });
  });

  app.get('/readyz', async (_req, res) => {
    const ready = await deps.isReady();
    res.status(ready ? 200 : 503).json({ ready });
  });

  app.post('/links', deps.rateLimiter, auth, async (req, res) => {
    const url = normalizeTargetUrl(req.body?.url);
    if (!url) {
      res.status(400).json({ error: 'invalid_url' });
      return;
    }
    const principal = principalOf(res);
    const ownerId = principal.kind === 'user' ? principal.sub : null;
    const { code, createdAt } = await createShortLink(deps.links, url, ownerId);
    await deps.linkCache.setUrl(code, url); // aquece o cache e sobrescreve um eventual "não existe"
    res.status(201).json({ code, shortUrl: shortUrl(code), url, createdAt });
  });

  app.get('/me/links', auth, requireUser, async (req, res) => {
    const query = listQuery.safeParse(req.query);
    if (!query.success) {
      res.status(400).json({ error: 'invalid_query' });
      return;
    }
    const principal = principalOf(res);
    if (principal.kind !== 'user') return; // requireUser já garantiu; isto só estreita o tipo
    try {
      const page = await deps.links.listByOwner(principal.sub, query.data);
      res.json({
        items: page.items.map((item) => ({ ...item, shortUrl: shortUrl(item.code) })),
        nextCursor: page.nextCursor,
      });
    } catch (err) {
      if (err instanceof InvalidCursorError) {
        res.status(400).json({ error: 'invalid_cursor' });
        return;
      }
      throw err;
    }
  });

  app.get('/links/:code/stats', auth, async (req, res) => {
    const { code } = req.params as { code: string }; // @types/express 5 tipa params como string | string[]
    if (!isValidCode(code)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const principal = principalOf(res);
    if (principal.kind === 'user') {
      // Não-dono recebe o mesmo 404 de "não existe": não confirmamos que o código é de outra pessoa.
      const owner = await deps.links.getOwner(code);
      if (owner !== principal.sub) {
        res.status(404).json({ error: 'not_found' });
        return;
      }
    }
    const ttl = deps.statsCache.ttlSeconds;
    const cached = await deps.statsCache.get(code);
    // Entrada sem computedAt foi gravada por uma versão anterior da api (ex.: durante o canary): recalcula.
    if (cached && typeof cached.computedAt === 'string') {
      res.json(withFreshness(cached, ttl));
      return;
    }
    const stats = await deps.links.getStats(code);
    if (!stats) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const fresh: CachedStats = { ...stats, computedAt: new Date().toISOString() };
    await deps.statsCache.set(code, fresh);
    res.json(withFreshness(fresh, ttl));
  });

  app.get('/:code', async (req, res) => {
    // BUG PROPOSITAL (Tarefa 8.7 do plano): só ativa dentro de um pod (o kubelet injeta
    // KUBERNETES_SERVICE_HOST), por isso os testes e o CI não o pegam. Será revertido.
    if (process.env.KUBERNETES_SERVICE_HOST && Math.random() < 0.3) {
      res.status(500).json({ error: 'internal' });
      return;
    }
    const { code } = req.params as { code: string }; // @types/express 5 tipa params como string | string[]
    if (!isValidCode(code)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    let url: string | null;
    const cached = await deps.linkCache.get(code);
    if (cached.hit) {
      url = cached.url;
    } else {
      url = await deps.links.findUrl(code);
      if (url) await deps.linkCache.setUrl(code, url);
      else await deps.linkCache.setNotFound(code);
    }
    if (!url) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    deps.publisher.publish(buildClickEvent(code, req.get('user-agent'))); // sem await, de propósito
    res.set('Cache-Control', 'no-store'); // sem isso o navegador cacheia o redirect e os cliques seguintes não chegam até nós
    res.redirect(302, url);
  });

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    const status = typeof err?.status === 'number' && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) logger.error({ err }, 'erro não tratado');
    res.status(status).json({ error: status === 500 ? 'internal_error' : 'bad_request' });
  };
  app.use(onError);

  return app;
}
