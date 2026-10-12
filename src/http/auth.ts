import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler, Response } from 'express';
import { logger } from '../logger.js';
import type { VerifyToken } from '../auth/jwt.js';

export type Principal = { kind: 'user'; sub: string } | { kind: 'service' };

const digest = (value: string) => createHash('sha256').update(value).digest();

// Compara hashes de tamanho fixo em tempo constante: não vaza, pelo tempo de resposta, quantos caracteres acertou.
export function apiKeyMatcher(expected: string): (provided: string | undefined) => boolean {
  const expectedDigest = digest(expected);
  return (provided) => provided !== undefined && timingSafeEqual(digest(provided), expectedDigest);
}

const BEARER = /^Bearer (\S+)$/i;

export function authenticate(opts: { apiKey: string; verifyToken: VerifyToken }): RequestHandler {
  const isValidApiKey = apiKeyMatcher(opts.apiKey);
  return async (req, res, next) => {
    const authorization = req.get('authorization');
    if (authorization !== undefined) {
      // Quem manda Authorization quer ser tratado como usuário: token ruim é 401, sem tentar a API key.
      const token = BEARER.exec(authorization)?.[1];
      if (!token) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      try {
        const { sub } = await opts.verifyToken(token);
        res.locals.principal = { kind: 'user', sub } satisfies Principal;
      } catch (err) {
        logger.debug({ err }, 'token rejeitado');
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      next();
      return;
    }
    if (isValidApiKey(req.get('x-api-key'))) {
      res.locals.principal = { kind: 'service' } satisfies Principal;
      next();
      return;
    }
    res.status(401).json({ error: 'unauthorized' });
  };
}

// Só para rotas que vêm depois de authenticate.
export function principalOf(res: Response): Principal {
  const principal = res.locals.principal as Principal | undefined;
  if (!principal) throw new Error('principalOf chamado numa rota sem authenticate');
  return principal;
}

export const requireUser: RequestHandler = (_req, res, next) => {
  if (principalOf(res).kind !== 'user') {
    res.status(403).json({ error: 'forbidden' });
    return;
  }
  next();
};
