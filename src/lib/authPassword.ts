import bcrypt from 'bcryptjs';

/** Lower rounds = faster login/signup; 8 is a practical balance for mobile auth. */
const BCRYPT_ROUNDS = Math.min(
  12,
  Math.max(6, parseInt(process.env.AUTH_BCRYPT_ROUNDS || '8', 10) || 8)
);

export async function hashAuthPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

export async function verifyAuthPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}
