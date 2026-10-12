import { beforeAll, describe, expect, it } from 'vitest';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type CryptoKey, type JWTPayload } from 'jose';
import { createTokenVerifier, type VerifyToken } from '../../src/auth/jwt.js';

const ISSUER = 'http://localhost:8090/shortener';
const AUDIENCE = 'shortener-web';

let privateKey: CryptoKey;
let otherPrivateKey: CryptoKey;
let verify: VerifyToken;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  otherPrivateKey = (await generateKeyPair('RS256')).privateKey;
  const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  verify = createTokenVerifier({ issuer: ISSUER, audience: AUDIENCE, jwks: createLocalJWKSet({ keys: [jwk] }) });
});

interface SignOptions {
  claims?: JWTPayload;
  issuer?: string;
  expiresIn?: string | number;
  key?: CryptoKey;
}

function sign({ claims = { sub: 'alice', aud: AUDIENCE }, issuer = ISSUER, expiresIn = '5m', key = privateKey }: SignOptions = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
    .setIssuer(issuer)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(key);
}

describe('createTokenVerifier', () => {
  it('aceita token válido com aud', async () => {
    expect(await verify(await sign())).toEqual({ sub: 'alice' });
  });

  it('aceita aud em lista', async () => {
    expect(await verify(await sign({ claims: { sub: 'alice', aud: ['outra-api', AUDIENCE] } }))).toEqual({ sub: 'alice' });
  });

  it('aceita access token no estilo Cognito (sem aud, com client_id e token_use=access)', async () => {
    const token = await sign({ claims: { sub: 'bob', client_id: AUDIENCE, token_use: 'access' } });
    expect(await verify(token)).toEqual({ sub: 'bob' });
  });

  it('rejeita issuer errado', async () => {
    await expect(verify(await sign({ issuer: 'http://evil.test/shortener' }))).rejects.toThrow();
  });

  it('rejeita token expirado', async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    await expect(verify(await sign({ expiresIn: past }))).rejects.toThrow();
  });

  it('rejeita aud e client_id de outro cliente', async () => {
    await expect(verify(await sign({ claims: { sub: 'alice', aud: 'outro-app' } }))).rejects.toThrow(/outro cliente/);
    await expect(verify(await sign({ claims: { sub: 'alice', client_id: 'outro-app' } }))).rejects.toThrow(/outro cliente/);
  });

  it('rejeita ID token do Cognito (token_use=id)', async () => {
    const token = await sign({ claims: { sub: 'bob', aud: AUDIENCE, token_use: 'id' } });
    await expect(verify(token)).rejects.toThrow(/token_use/);
  });

  it('rejeita token sem sub', async () => {
    await expect(verify(await sign({ claims: { aud: AUDIENCE } }))).rejects.toThrow(/sub/);
  });

  it('rejeita token assinado por outra chave', async () => {
    await expect(verify(await sign({ key: otherPrivateKey }))).rejects.toThrow();
  });

  it('rejeita algo que nem é JWT', async () => {
    await expect(verify('nao-sou-um-jwt')).rejects.toThrow();
  });
});
