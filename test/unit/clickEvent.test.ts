import { describe, expect, it } from 'vitest';
import { buildClickEvent, parseClickEvent } from '../../src/events/clickEvent.js';

describe('clickEvent', () => {
  it('build preenche id, data ISO e versão', () => {
    const e = buildClickEvent('abcDEF1', 'curl/8.7.1', new Date('2026-10-12T15:00:00Z'));
    expect(e).toMatchObject({ v: 1, code: 'abcDEF1', userAgent: 'curl/8.7.1', occurredAt: '2026-10-12T15:00:00.000Z' });
    expect(e.eventId).toMatch(/^[0-9a-f-]{36}$/);
  });
  it('trunca user-agent gigante e aceita ausente', () => {
    expect(buildClickEvent('abcDEF1', 'x'.repeat(2000)).userAgent).toHaveLength(512);
    expect(buildClickEvent('abcDEF1', undefined).userAgent).toBe('');
  });
  it('parse faz ida e volta', () => {
    const e = buildClickEvent('abcDEF1', 'curl/8.7.1');
    expect(parseClickEvent(Buffer.from(JSON.stringify(e)))).toEqual(e);
  });
  it('parse rejeita lixo', () => {
    expect(() => parseClickEvent(Buffer.from('não é json'))).toThrow();
    expect(() => parseClickEvent(Buffer.from('{"v":1}'))).toThrow();
    expect(() => parseClickEvent(null)).toThrow();
  });
});
