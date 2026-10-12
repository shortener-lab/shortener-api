import { generateCode } from './code.js';
import { DuplicateCodeError, type LinkRepository } from './repository.js';

export async function createShortLink(
  repo: LinkRepository,
  url: string,
  gen: () => string = generateCode,
  maxAttempts = 5,
): Promise<string> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const code = gen();
    try {
      await repo.insert(code, url);
      return code;
    } catch (err) {
      if (!(err instanceof DuplicateCodeError)) throw err;
    }
  }
  throw new Error('Não foi possível gerar um código único');
}
