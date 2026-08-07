import { redirect } from 'next/navigation';
import { prisma } from '@repo/db';
import { auth } from '@/lib/auth';
import { MIN_PASSWORD_LENGTH } from '@/lib/password';
import { Card, CardBody, Eyebrow, Heading } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { updateName, changePassword } from './actions';
import { NameForm } from './NameForm';
import { PasswordForm } from './PasswordForm';

/**
 * The account page. Until this existed a user could neither see their own name
 * nor change their own password — every account was stuck forever on whatever
 * temporary password an admin typed into the create-user dialog, which itself
 * promised "they can change it after signing in".
 */
export default async function ProfilePage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: { email: true, name: true, role: true, createdAt: true },
  });
  if (!user) redirect('/login');

  return (
    <div data-testid="profile">
      <Heading level={1} className="text-[28px]">
        Your account
      </Heading>
      <p className="mt-1 text-[13px] text-ink-3">
        How you appear on estimates you own, and the password you sign in with.
      </p>

      <Card className="mt-5">
        <CardBody className="p-4 sm:p-5">
          <Eyebrow>Details</Eyebrow>
          <dl className="mt-2.5 grid gap-x-6 gap-y-2 sm:grid-cols-[110px_1fr]">
            <dt className="text-[12.5px] text-ink-4">Email</dt>
            <dd className="text-[13px] text-ink" data-testid="profile-email">
              {user.email}
            </dd>
            <dt className="text-[12.5px] text-ink-4">Role</dt>
            <dd>
              <Pill tone={user.role === 'ADMIN' ? 'green' : 'neutral'}>{user.role}</Pill>
            </dd>
            <dt className="text-[12.5px] text-ink-4">Member since</dt>
            <dd className="num text-[13px] text-ink-2">
              {new Date(user.createdAt).toLocaleDateString()}
            </dd>
          </dl>
          <p className="mt-3 border-t border-line-soft pt-2.5 text-[11.5px] text-ink-4">
            Your email address and role are set by an admin.
          </p>
        </CardBody>
      </Card>

      <Card className="mt-4">
        <CardBody className="p-4 sm:p-5">
          <Eyebrow>Name</Eyebrow>
          <p className="mt-1.5 text-[12.5px] text-ink-3">
            Shown in the sidebar and used when we email you. Leave it blank to go by your email
            address.
          </p>
          <NameForm action={updateName} initialName={user.name ?? ''} />
        </CardBody>
      </Card>

      <Card className="mt-4">
        <CardBody className="p-4 sm:p-5">
          <Eyebrow>Password</Eyebrow>
          <p className="mt-1.5 text-[12.5px] text-ink-3">
            At least {MIN_PASSWORD_LENGTH} characters. You&rsquo;ll need your current password to
            change it.
          </p>
          <PasswordForm action={changePassword} minLength={MIN_PASSWORD_LENGTH} />
        </CardBody>
      </Card>
    </div>
  );
}
