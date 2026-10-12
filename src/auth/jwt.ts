import { jwtVerify, type JWTVerifyGetKey } from 'jose';

export type VerifyToken = (token: string) => Promise<{ sub: string }>;

export class InvalidTokenError extends Error {}

export interface TokenVerifierOptions {
  issuer: string;
  audience: string;
  jwks: JWTVerifyGetKey; // createRemoteJWKSet em produção, createLocalJWKSet nos testes
}

export function createTokenVerifier(opts: TokenVerifierOptions): VerifyToken {
  return async (token) => {
    // jwtVerify confere assinatura, alg, exp, nbf e iss. O aud fica conosco: o Cognito não manda aud no access token.
    const { payload } = await jwtVerify(token, opts.jwks, { issuer: opts.issuer, algorithms: ['RS256'] });

    const aud = payload.aud === undefined ? [] : Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(opts.audience) && payload.client_id !== opts.audience) {
      throw new InvalidTokenError('token emitido para outro cliente');
    }
    if (payload.token_use !== undefined && payload.token_use !== 'access') {
      throw new InvalidTokenError('token_use precisa ser "access"');
    }
    if (typeof payload.sub !== 'string' || payload.sub === '') {
      throw new InvalidTokenError('token sem sub');
    }
    return { sub: payload.sub };
  };
}
