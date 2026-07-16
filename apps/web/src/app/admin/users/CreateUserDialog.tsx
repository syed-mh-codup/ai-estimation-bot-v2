'use client';

import { useActionState, useEffect, useState } from 'react';
import { UserPlus } from 'lucide-react';
import { Dialog, DialogTrigger, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input, Select, FieldLabel } from '@/components/ui/input';

export type CreateUserState = { ok?: boolean; error?: string; emailed?: boolean };

const initialState: CreateUserState = {};

function generatePassword(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = new Uint32Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (n) => alphabet[n % alphabet.length]).join('');
}

/**
 * "Add user" as an explicit action: a button in the page header opens a modal
 * with the form, so the users table stays the primary content. Validation and
 * the created/emailed result render inline via useActionState.
 */
export function CreateUserDialog({
  action,
}: {
  action: (state: CreateUserState, formData: FormData) => Promise<CreateUserState>;
}) {
  const [state, formAction, pending] = useActionState(action, initialState);
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');

  // Close on success and reset the local field.
  useEffect(() => {
    if (state.ok) {
      setOpen(false);
      setPassword('');
    }
  }, [state.ok]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" data-testid="open-create-user">
          <UserPlus className="h-4 w-4" />
          Add user
        </Button>
      </DialogTrigger>
      <DialogContent data-testid="create-user-form">
        <DialogTitle>Add a user</DialogTitle>
        <DialogDescription>
          They can sign in right away with the temporary password. We&rsquo;ll email it to them.
        </DialogDescription>

        <form action={formAction} className="mt-4 space-y-3.5">
          <div>
            <FieldLabel htmlFor="new-user-email">Email</FieldLabel>
            <Input
              id="new-user-email"
              name="email"
              type="email"
              required
              autoComplete="off"
              data-testid="new-user-email"
            />
          </div>

          <div>
            <FieldLabel htmlFor="new-user-name">
              Name <span className="font-normal text-ink-4">(optional)</span>
            </FieldLabel>
            <Input
              id="new-user-name"
              name="name"
              type="text"
              autoComplete="off"
              data-testid="new-user-name"
            />
          </div>

          <div>
            <FieldLabel htmlFor="new-user-password">Temporary password</FieldLabel>
            <div className="flex gap-2">
              <Input
                id="new-user-password"
                name="password"
                type="text"
                required
                minLength={8}
                autoComplete="off"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="num"
                data-testid="new-user-password"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => setPassword(generatePassword())}
                className="shrink-0"
                data-testid="generate-password"
              >
                Generate
              </Button>
            </div>
            <p className="mt-1.5 text-[11.5px] text-ink-3">
              At least 8 characters. They can change it after signing in.
            </p>
          </div>

          <div>
            <FieldLabel htmlFor="new-user-role">Role</FieldLabel>
            <Select
              id="new-user-role"
              name="role"
              defaultValue="ESTIMATOR"
              className="w-full py-2"
              data-testid="new-user-role"
            >
              <option value="ESTIMATOR">Estimator</option>
              <option value="ADMIN">Admin</option>
            </Select>
          </div>

          {state.error && (
            <p
              className="rounded-md border border-brick-line bg-brick-tint px-3 py-2 text-[12.5px] font-medium text-brick"
              data-testid="create-user-error"
            >
              {state.error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending} data-testid="create-user-submit">
              {pending ? 'Creating…' : 'Create user'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
