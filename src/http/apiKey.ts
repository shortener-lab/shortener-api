import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';

const digest = (value: string) => createHash('sha256').update(value).digest();

// Compara hashes de tamanho fixo em tempo constante: não vaza, pelo tempo de resposta, quantos caracteres acertou.
export function requireApiKey(expected: string): RequestHandler {
  const expectedDigest = digest(expected);
  return (req, res, next) => {
    if (!timingSafeEqual(digest(req.get('x-api-key') ?? ''), expectedDigest)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    next();
  };
}
