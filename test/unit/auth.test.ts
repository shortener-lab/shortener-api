import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { authenticate, principalOf, requireUser } from '../../src/http/auth.js';
import type { VerifyToken } from '../../src/auth/jwt.js';

const API_KEY = 'test-api-key-0123456789';

// Verificador falso: só o token "token-da-alice" é válido. O JWT de verdade é testado em jwt.test.ts.
const fakeVerify: VerifyToken = async (token) => {
  if (token === 'token-da-alice') return { sub: 'alice' };
  throw new Error('token inválido');
};

function buildApp() {
  const app = express();
  const auth = authenticate({ apiKey: API_KEY, verifyToken: fakeVerify });
  app.get('/quem-sou', auth, (_req, res) => {
    res.json(principalOf(res));
  });
  app.get('/so-usuario', auth, requireUser, (_req, res) => {
    res.json({ ok: true });
  });
  return app;
}

describe('authenticate', () => {
  it('Bearer válido vira usuário com o sub do token', async () => {
    const res = await request(buildApp()).get('/quem-sou').set('authorization', 'Bearer token-da-alice');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kind: 'user', sub: 'alice' });
  });

  it('aceita o esquema "bearer" em minúsculas', async () => {
    const res = await request(buildApp()).get('/quem-sou').set('authorization', 'bearer token-da-alice');
    expect(res.status).toBe(200);
  });

  it('API key válida vira serviço', async () => {
    const res = await request(buildApp()).get('/quem-sou').set('x-api-key', API_KEY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kind: 'service' });
  });

  it('sem credencial ou com API key errada: 401', async () => {
    const app = buildApp();
    for (const res of [await request(app).get('/quem-sou'), await request(app).get('/quem-sou').set('x-api-key', 'errada')]) {
      expect(res.status).toBe(401);
      expect(res.body).toEqual({ error: 'unauthorized' });
    }
  });

  it('Bearer inválido é 401 mesmo com API key válida (não cai para a chave)', async () => {
    const res = await request(buildApp())
      .get('/quem-sou')
      .set('authorization', 'Bearer token-falso')
      .set('x-api-key', API_KEY);
    expect(res.status).toBe(401);
  });

  it('Authorization que não é Bearer: 401', async () => {
    const res = await request(buildApp()).get('/quem-sou').set('authorization', 'Basic dXNlcjpwYXNz');
    expect(res.status).toBe(401);
  });
});

describe('requireUser', () => {
  it('deixa passar usuário', async () => {
    const res = await request(buildApp()).get('/so-usuario').set('authorization', 'Bearer token-da-alice');
    expect(res.status).toBe(200);
  });

  it('serviço recebe 403', async () => {
    const res = await request(buildApp()).get('/so-usuario').set('x-api-key', API_KEY);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'forbidden' });
  });
});
