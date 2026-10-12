import { describe, expect, it } from 'vitest';
import { createShortLink } from '../../src/links/service.js';
import { DuplicateCodeError, type LinkRepository } from '../../src/links/repository.js';

function fakeRepo(duplicatesBeforeSuccess: number, otherError?: Error) {
  let calls = 0;
  const repo: LinkRepository = {
    async insert(code) {
      calls++;
      if (otherError) throw otherError;
      if (calls <= duplicatesBeforeSuccess) throw new DuplicateCodeError(code);
    },
    findUrl: async () => null,
    getStats: async () => null,
  };
  return { repo, calls: () => calls };
}

describe('createShortLink', () => {
  it('devolve o código quando insere de primeira', async () => {
    const { repo } = fakeRepo(0);
    expect(await createShortLink(repo, 'https://x.com', () => 'AAAAAA1')).toBe('AAAAAA1');
  });
  it('tenta outro código em caso de colisão', async () => {
    const { repo, calls } = fakeRepo(2);
    await createShortLink(repo, 'https://x.com');
    expect(calls()).toBe(3);
  });
  it('desiste depois de N colisões', async () => {
    const { repo } = fakeRepo(99);
    await expect(createShortLink(repo, 'https://x.com', undefined, 3)).rejects.toThrow(/código único/);
  });
  it('não engole outros erros', async () => {
    const { repo } = fakeRepo(0, new Error('banco fora'));
    await expect(createShortLink(repo, 'https://x.com')).rejects.toThrow('banco fora');
  });
});
