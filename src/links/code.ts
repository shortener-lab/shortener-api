import { randomInt } from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
export const CODE_LENGTH = 7;
const CODE_REGEX = /^[0-9A-Za-z]{7}$/;

export function generateCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += ALPHABET[randomInt(ALPHABET.length)];
  return code;
}

export function isValidCode(value: string): boolean {
  return CODE_REGEX.test(value);
}
