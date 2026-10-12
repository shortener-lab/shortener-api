import { describe, expect, it } from 'vitest';
import { generateCode, isValidCode } from '../../src/links/code.js';

describe('code', () => {
  it('gera 7 caracteres alfanuméricos', () => {
    expect(generateCode()).toMatch(/^[0-9A-Za-z]{7}$/);
  });
  it('praticamente não repete', () => {
    const codes = new Set(Array.from({ length: 1000 }, generateCode));
    expect(codes.size).toBe(1000);
  });
  it('valida formato', () => {
    expect(isValidCode('abcDEF1')).toBe(true);
    expect(isValidCode('abc')).toBe(false);
    expect(isValidCode('abc-EF1')).toBe(false);
    expect(isValidCode('favicon.ico')).toBe(false);
    expect(isValidCode('healthz')).toBe(true); // por isso a ordem das rotas importa (Tarefa 1.8)
  });
});
