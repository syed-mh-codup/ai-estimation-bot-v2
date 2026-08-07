import bcrypt from 'bcryptjs';

const SALT_ROUNDS = 12;

/**
 * The one place the length rule lives. Both the admin "add user" dialog and
 * the self-service change-password form enforce it; a user must not be able to
 * weaken a password below what an admin was required to set.
 */
export const MIN_PASSWORD_LENGTH = 8;

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}
