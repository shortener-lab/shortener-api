import { describe, expect, it } from 'vitest';
import { loadApiConfig, loadBaseConfig } from '../../src/config.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  REDIS_URL: 'redis://localhost:6379',
  KAFKA_BROKERS: 'localhost:9092, localhost:9093',
};
const api = { ...base, PUBLIC_BASE_URL: 'http://localhost:3000', API_KEY: 'a'.repeat(32) };

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

  it('a config base não exige variáveis exclusivas da api', () => {
    expect(() => loadBaseConfig(base)).not.toThrow();
  });
});
