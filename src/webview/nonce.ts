import { randomBytes } from 'node:crypto';

// 18 random bytes encode to 24 base64 characters without padding.
export function createNonce(): string {
  return randomBytes(18).toString('base64');
}
