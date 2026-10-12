import { describe, expect, it } from 'vitest';
import { loadApiConfig, loadBaseConfig } from '../../src/config.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  KAFKA_BROKERS: 'localhost:9092, localhost:9093',
};
const api = {
  ...base,
  PUBLIC_BASE_URL: 'http://localhost:3000',
  API_KEY: 'a'.repeat(32),
  OIDC_ISSUER: 'http://localhost:8090/shortener',
  OIDC_AUDIENCE: 'shortener-web',
  OIDC_JWKS_URL: 'http://localhost:8090/shortener/jwks',
  CORS_ALLOWED_ORIGINS: 'http://localhost:5173, http://localhost:8081',
};

describe('config', () => {
  it('aplica defaults e converte tipos', () => {
    const c = loadApiConfig(api);
    expect(c.PORT).toBe(3000);
    expect(c.KAFKA_BROKERS).toEqual(['localhost:9092', 'localhost:9093']);
    expect(c.KAFKA_SSL).toBe(false);
    expect(c.KAFKA_REPLICATION_FACTOR).toBe(1);
    expect(c.RATE_LIMIT_PER_MINUTE).toBe(10);
  });

  it('converte "true" em boolean', () => {
    expect(loadApiConfig({ ...api, KAFKA_SSL: 'true' }).KAFKA_SSL).toBe(true);
  });

  it('falha dizendo qual variável falta', () => {
    const { API_KEY: _omit, ...semKey } = api;
    expect(() => loadApiConfig(semKey)).toThrow(/API_KEY/);
  });

  it('rejeita API_KEY curta', () => {
    expect(() => loadApiConfig({ ...api, API_KEY: 'curta' })).toThrow(/API_KEY/);
  });

  it('transforma CORS_ALLOWED_ORIGINS em lista', () => {
    expect(loadApiConfig(api).CORS_ALLOWED_ORIGINS).toEqual(['http://localhost:5173', 'http://localhost:8081']);
  });

  it('exige as variáveis de OIDC na api', () => {
    for (const name of ['OIDC_ISSUER', 'OIDC_AUDIENCE', 'OIDC_JWKS_URL', 'CORS_ALLOWED_ORIGINS'] as const) {
      const { [name]: _omit, ...sem } = api;
      expect(() => loadApiConfig(sem), name).toThrow(new RegExp(name));
    }
  });

  it('rejeita OIDC_ISSUER que não é URL', () => {
    expect(() => loadApiConfig({ ...api, OIDC_ISSUER: 'shortener' })).toThrow(/OIDC_ISSUER/);
  });

  it('a config base não exige variáveis exclusivas da api', () => {
    expect(() => loadBaseConfig(base)).not.toThrow();
  });
});
