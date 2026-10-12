import { describe, expect, it } from 'vitest';
import { MAX_URL_LENGTH, normalizeTargetUrl } from '../../src/links/url.js';

describe('normalizeTargetUrl', () => {
  it('aceita http e https', () => {
    expect(normalizeTargetUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    expect(normalizeTargetUrl('http://example.com')).toBe('http://example.com/');
  });
  it.each(['javascript:alert(1)', 'data:text/html,<h1>oi</h1>', 'ftp://example.com', 'file:///etc/passwd'])(
    'rejeita esquema perigoso: %s',
    (url) => expect(normalizeTargetUrl(url)).toBeNull(),
  );
  it('rejeita lixo, vazio e não-string', () => {
    expect(normalizeTargetUrl('nao e url')).toBeNull();
    expect(normalizeTargetUrl('')).toBeNull();
    expect(normalizeTargetUrl(42)).toBeNull();
    expect(normalizeTargetUrl(undefined)).toBeNull();
  });
  it('rejeita URL gigante', () => {
    expect(normalizeTargetUrl(`https://example.com/${'a'.repeat(MAX_URL_LENGTH)}`)).toBeNull();
  });
});
