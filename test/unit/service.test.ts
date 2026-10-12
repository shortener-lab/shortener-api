import { describe, expect, it } from 'vitest';
import { createShortLink } from '../../src/links/service.js';
import { DuplicateCodeError, type LinkRepository } from '../../src/links/repository.js';

const CREATED_AT = '2026-10-12T12:00:00.000Z';

function fakeRepo(duplicatesBeforeSuccess: number, otherError?: Error) {
  let calls = 0;
  const owners: (string | null)[] = [];
  const repo: LinkRepository = {
    async insert(code, _url, ownerId) {
      calls++;
      owners.push(ownerId);
      if (otherError) throw otherError;
      if (calls <= duplicatesBeforeSuccess) throw new DuplicateCodeError(code);
      return { createdAt: CREATED_AT };
    },
    findUrl: async () => null,
    getOwner: async () => undefined,
    listByOwner: async () => ({ items: [], nextCursor: null }),
    getStats: async () => null,
  };
  return { repo, calls: () => calls, owners };
}

describe('createShortLink', () => {
  it('devolve código e data de criação quando insere de primeira', async () => {
    const { repo } = fakeRepo(0);
    expect(await createShortLink(repo, 'https://x.com', 'alice', () => 'AAAAAA1')).toEqual({
      code: 'AAAAAA1',
      createdAt: CREATED_AT,
    });
  });
  it('repassa o dono (ou null) para o repositório', async () => {
    const { repo, owners } = fakeRepo(0);
    await createShortLink(repo, 'https://x.com', 'alice');
    await createShortLink(repo, 'https://x.com', null);
    expect(owners).toEqual(['alice', null]);
  });
  it('tenta outro código em caso de colisão', async () => {
    const { repo, calls } = fakeRepo(2);
    await createShortLink(repo, 'https://x.com', null);
    expect(calls()).toBe(3);
  });
  it('desiste depois de N colisões', async () => {
    const { repo } = fakeRepo(99);
    await expect(createShortLink(repo, 'https://x.com', null, undefined, 3)).rejects.toThrow(/código único/);
  });
  it('não engole outros erros', async () => {
    const { repo } = fakeRepo(0, new Error('banco fora'));
    await expect(createShortLink(repo, 'https://x.com', null)).rejects.toThrow('banco fora');
  });
});
