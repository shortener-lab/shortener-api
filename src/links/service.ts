import { generateCode } from './code.js';
import { DuplicateCodeError, type LinkRepository } from './repository.js';

export interface CreatedLink {
  code: string;
  createdAt: string;
}

export async function createShortLink(
  repo: LinkRepository,
  url: string,
  ownerId: string | null,
  gen: () => string = generateCode,
  maxAttempts = 5,
): Promise<CreatedLink> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const code = gen();
    try {
      const { createdAt } = await repo.insert(code, url, ownerId);
      return { code, createdAt };
    } catch (err) {
      if (!(err instanceof DuplicateCodeError)) throw err;
    }
  }
  throw new Error('Não foi possível gerar um código único');
}
