import {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash,
} from 'node:crypto';

export const opaqueToken = () => randomBytes(32).toString('base64url');
export const hashToken = (token: string) =>
  createHash('sha256').update(token).digest('hex');
export function hashPassword(password: string): string {
  if (password.length < 12) throw new Error('Use at least 12 characters');
  const salt = randomBytes(16).toString('hex');
  return `scrypt:${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password: string, encoded: string): boolean {
  const [algorithm, salt, expected] = encoded.split(':');
  if (
    algorithm !== 'scrypt' ||
    !/^[a-f0-9]{32}$/.test(salt ?? '') ||
    !/^[a-f0-9]{128}$/.test(expected ?? '')
  )
    return false;
  return timingSafeEqual(
    Buffer.from(expected, 'hex'),
    scryptSync(password, salt, 64),
  );
}
export function validPasswordHash(encoded: string): boolean {
  return /^scrypt:[a-f0-9]{32}:[a-f0-9]{128}$/.test(encoded);
}
