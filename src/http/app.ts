import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import { pinoHttp } from 'pino-http';
import { logger } from '../logger.js';
import type { LinkCache } from '../cache/linkCache.js';
import type { JsonCache } from '../cache/jsonCache.js';
import type { ClickPublisher } from '../events/clickPublisher.js';
import { buildClickEvent } from '../events/clickEvent.js';
import { isValidCode } from '../links/code.js';
import { normalizeTargetUrl } from '../links/url.js';
import { createShortLink } from '../links/service.js';
import type { LinkRepository, LinkStats } from '../links/repository.js';
import { requireApiKey } from './apiKey.js';

export interface AppDeps {
  links: LinkRepository;
  linkCache: LinkCache;
  statsCache: JsonCache<LinkStats>;
  publisher: ClickPublisher;
  rateLimiter: RequestHandler;
  apiKey: string;
  publicBaseUrl: string;
  version: string;
  isReady: () => Promise<boolean>;
}

export function createApp(deps: AppDeps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // exatamente 1 proxy na frente (o ALB): req.ip = IP real do cliente
  app.use(pinoHttp({ logger, autoLogging: { ignore: (req) => req.url === '/healthz' || req.url === '/readyz' } }));
  app.use(express.json({ limit: '10kb' }));
  const auth = requireApiKey(deps.apiKey);

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
    const { code, createdAt } = await createShortLink(deps.links, url, null);
    await deps.linkCache.setUrl(code, url); // aquece o cache e sobrescreve um eventual "não existe"
    res.status(201).json({ code, shortUrl: `${deps.publicBaseUrl}/${code}`, url, createdAt });
  });

  app.get('/links/:code/stats', auth, async (req, res) => {
    const { code } = req.params as { code: string }; // @types/express 5 tipa params como string | string[]
    if (!isValidCode(code)) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    const cached = await deps.statsCache.get(code);
    if (cached) {
      res.json(cached);
      return;
    }
    const stats = await deps.links.getStats(code);
    if (!stats) {
      res.status(404).json({ error: 'not_found' });
      return;
    }
    await deps.statsCache.set(code, stats);
    res.json(stats);
  });

  app.get('/:code', async (req, res) => {
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
