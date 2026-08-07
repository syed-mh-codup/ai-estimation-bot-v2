'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@repo/db';
import { requireUser } from '@/lib/rbac';
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from '@/lib/password';

/**
 * Self-service account actions. Both act on the *caller's* own row and never
 * take a user id from the client — the only account you can edit here is your
 * own, which is what keeps this out of admin territory.
 */

export type NameState = { ok?: boolean; error?: string };
export type PasswordState = { ok?: boolean; error?: string };

const MAX_NAME_LENGTH = 120;

export async function updateName(_state: NameState, formData: FormData): Promise<NameState> {
  const { id } = await requireUser();

  const raw = (formData.get('name') ?? '').toString().trim();
  if (raw.length > MAX_NAME_LENGTH) {
    return { error: `Name must be ${MAX_NAME_LENGTH} characters or fewer.` };
  }

  // Empty clears it — `User.name` is nullable, and storing '' would render as
  // a blank line in the nav instead of falling back to the email.
  await prisma.user.update({ where: { id }, data: { name: raw || null } });

  // The nav reads the name off the session, and the DB-backed jwt callback
  // re-reads the user each request, so refreshing the shell is enough.
  revalidatePath('/', 'layout');
  return { ok: true };
}

export async function changePassword(
  _state: PasswordState,
  formData: FormData,
): Promise<PasswordState> {
  const { id } = await requireUser();

  const current = (formData.get('currentPassword') ?? '').toString();
  const next = (formData.get('newPassword') ?? '').toString();
  const confirm = (formData.get('confirmPassword') ?? '').toString();

  if (next.length < MIN_PASSWORD_LENGTH) {
    return { error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (next !== confirm) return { error: 'The two new passwords don’t match.' };

  const user = await prisma.user.findUnique({ where: { id }, select: { hash: true } });
  if (!user) return { error: 'Account not found.' };

  // Re-authenticate before re-hashing. An admin-set temporary password is
  // precisely the case where this matters: without it, anyone at an unlocked
  // screen could lock the real owner out of their own account.
  if (!(await verifyPassword(current, user.hash))) {
    return { error: 'Your current password isn’t right.' };
  }
  if (current === next) {
    return { error: 'The new password must be different from the current one.' };
  }

  // `passwordChangedAt` is what signs the account's OTHER devices out: the
  // DB-backed jwt callback rejects any token issued before this moment. Without
  // it, changing your password would leave every other session working.
  await prisma.user.update({
    where: { id },
    data: { hash: await hashPassword(next), passwordChangedAt: new Date() },
  });

  return { ok: true };
}
